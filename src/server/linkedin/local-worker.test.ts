import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import { SELECTORS, type LinkedInDriver, type LinkedInDriverResult, type LinkedInPage, type LinkedInSeatRead } from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyCheck, type LinkedInSafetyVerdict } from './guard.js';
import { ACTION_GAP_SECONDS } from './limits.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { getSeat, upsertSeat, type SeatPosture } from './seats.js';
import {
  actionGapSeconds,
  claimSeatLease,
  closeIdleBrowsers,
  closeLinkedInBrowser,
  detectLinkedInSeat,
  dueSeatsForWorker,
  heartbeatSeatLease,
  humanCadencePage,
  latestSeatDetectRequest,
  linkedInBrowserReadiness,
  seatLaunchArgs,
  describeBrowserOpenFailure,
  linkedInHeadlessReadiness,
  linkedInOffReason,
  linkedInWorkerHealth,
  linkedinWorkspaceIdsForShard,
  openBrowser,
  postgresLocalWorkerStore,
  reapExpiredActionLeases,
  reapStaleLinkedInBatches,
  releaseSeatLease,
  requestSeatDetect,
  resolveProfileDir,
  resolveSeatProxy,
  runBounded,
  dueManualWork,
  runDueLinkedInActions,
  runLinkedInLocalBatch,
  runPendingSeatDetectRequests,
  resetLinkedInSessionRhythm,
  seatContextFingerprint,
  seatProfilePresent,
  sessionActionBudget,
  sessionBreakMs,
  seatRefsForShard,
  seatsWithDueActions,
  shouldLogOnce,
  stopLinkedInBatches,
  workerShard,
  type BranchGateDecision,
  type DueLinkedInAction,
  type LocalWorkerStore,
  type PlaywrightLike
} from './local-worker.js';
import type { LinkedInLocator } from './driver.js';
import {
  deleteLinkedInCredentials,
  describeLinkedInCredentials,
  putLinkedInCredentials,
  readLinkedInCredentials
} from '../secrets/linkedin.js';
import { randomBytes } from 'node:crypto';

/**
 * THE DRIVER IS ALWAYS FAKE HERE, AND SO IS THE STORE.
 *
 * No browser is launched and no LinkedIn request is made by this file, ever.
 * That is not a convenience: a test suite that touched a real account would
 * spend that account's daily invite budget on CI, and the ceilings this
 * subsystem exists to respect are per human, not per test run.
 *
 * What is asserted is the four invariants in local-worker.ts, because each one
 * is load-bearing for an account staying alive.
 */

const page = {} as LinkedInPage;

const ok: LinkedInDriverResult = { ok: true, externalRef: 'https://www.linkedin.com/in/x/', failureKind: null };

function verdict(overrides: Partial<LinkedInSafetyVerdict> = {}): LinkedInSafetyVerdict {
  return {
    allowed: true,
    reason: null,
    checks: [],
    automationMode: 'prepare-only',
    automationReason: 'LinkedIn forbids unattended automation of its site.',
    ...overrides
  };
}

/** A refusal whose ONLY failing check is `duplicate-target`. It still blocks. */
function soleDuplicateRefusal(): LinkedInSafetyVerdict {
  return verdict({
    allowed: false,
    reason: 'duplicate-target: already logged',
    checks: [
      { check: 'seat-paused', passed: true, detail: 'ok' },
      { check: 'duplicate-target', passed: false, detail: 'This seat already has an invite logged against it.' }
    ]
  });
}

function action(overrides: Partial<DueLinkedInAction> = {}): DueLinkedInAction {
  return {
    id: 'lact_1',
    workspaceId: 'ws_test',
    seatKey: 'owner',
    kind: 'invite',
    targetRef: 'https://www.linkedin.com/in/maya/',
    plannedFor: '2026-08-04T09:00:00.000Z',
    body: 'A note a human approved.',
    ...overrides
  };
}

interface StoreHarness {
  store: LocalWorkerStore;
  claimed: string[];
  released: Array<{ id: string; failureKind: string | null }>;
  sent: string[];
  skipped: Array<{ id: string; failureKind: string }>;
  branchSkipped: Array<{ id: string; reason: string }>;
  held: Array<{ id: string; failureKind: string }>;
  heartbeats: Array<{ batchId: string; id: string | null }>;
  cooldowns: number;
  closed: Array<{ status: string; haltReason: string | null; executed: number }>;
  remaining(): number;
  setPosture(next: SeatPosture | null): void;
  requestStop(): void;
}

function fakeStore(
  actions: DueLinkedInAction[],
  options: {
    posture?: SeatPosture | null;
    branch?: (action: DueLinkedInAction, now: Date) => Promise<BranchGateDecision | null>;
    seatKey?: string;
    /** What the ledger says about a pending invite to the action's target. */
    unacceptedInvite?: boolean;
  } = {}
): StoreHarness {
  const queue = [...actions];
  // A RELEASED ROW IS IMMEDIATELY CLAIMABLE AGAIN, and the fake has to say so.
  //
  // `releaseClaim` in the real store only nulls `claimed_at`: the row stays
  // 'planned', and the very next claim -- ordered by `planned_for ASC` -- hands
  // back the OLDEST due row, which is the one just released. A fake that
  // quietly dropped a released row modelled a queue that cannot livelock, and
  // the loop's real bug was a livelock: a gate refusal that released without
  // deferring burned every iteration of the pass, at a 30-120s sleep each, on
  // one row the gate had already refused.
  const byId = new Map(actions.map((entry) => [entry.id, entry]));
  let posture: SeatPosture | null = options.posture === undefined ? 'steady' : options.posture;
  let stopped = false;
  const harness: StoreHarness = {
    claimed: [],
    released: [],
    sent: [],
    skipped: [],
    branchSkipped: [],
    held: [],
    heartbeats: [],
    cooldowns: 0,
    closed: [],
    remaining: () => queue.length,
    setPosture: (next) => {
      posture = next;
    },
    requestStop: () => {
      stopped = true;
    },
    store: {
      workspaceId: 'ws_test',
      seatKey: options.seatKey ?? 'owner',
      seatPosture: async () => posture,
      // Fixed, so "the same batch produces the same gaps" is assertable.
      openBatch: async () => 'lbatch_fixed',
      closeBatch: async (_batchId, outcome) => {
        harness.closed.push(outcome);
      },
      stopRequested: async () => stopped,
      claimNextDueAction: async (_batchId, _now, exclude = []) => {
        // The real store excludes deferred rows in SQL. The fake does it here,
        // because a branch that answers `pending` releases the row and the loop
        // must not be handed it again on the next iteration.
        const index = queue.findIndex((entry) => !exclude.includes(entry.id));
        if (index === -1) return null;
        const [next] = queue.splice(index, 1);
        harness.claimed.push(next.id);
        return next;
      },
      releaseClaim: async (id, failureKind) => {
        harness.released.push({ id, failureKind });
        // Back to the front: it is the oldest row again, which is exactly what
        // `ORDER BY planned_for ASC` hands out next.
        const row = byId.get(id);
        if (row) queue.unshift(row);
      },
      hasUnacceptedInvite: async () => options.unacceptedInvite === true,
      settleSent: async (id) => {
        harness.sent.push(id);
      },
      settleSkipped: async (id, failureKind) => {
        harness.skipped.push({ id, failureKind });
      },
      settleBranchSkipped: async (id, reason) => {
        harness.branchSkipped.push({ id, reason });
      },
      // No campaign, so nothing branches. The branch-aware tests hand in their
      // own answer through `options.branch`.
      branchDecision: async (action, now) => (options.branch ? options.branch(action, now) : null),
      holdClaim: async (id, failureKind) => {
        harness.held.push({ id, failureKind });
      },
      // THE LEASE, RECORDED RATHER THAN IGNORED. What the loop owes a
      // multi-worker deployment is that the row it is mid-way through has a
      // deadline pushed forward before the driver acts -- otherwise a reaper
      // cannot tell a dead worker from a slow one, and the whole recovery path
      // becomes a duplicate-invite risk instead of a fix.
      heartbeat: async (batchId, id) => {
        harness.heartbeats.push({ batchId, id });
      },
      enterCooldown: async () => {
        harness.cooldowns += 1;
      }
    }
  };
  return harness;
}

/** What a complete, undegraded `readSeat` looks like. */
const seatRead: LinkedInSeatRead = {
  ok: true,
  profileUrl: 'https://www.linkedin.com/in/pankaj/',
  name: 'Pankaj Sharma',
  connectionsCount: 1234,
  degraded: []
};

/** Records what the loop asked the driver to do, and answers however the test says. */
function fakeDriver(
  answer: (target: string, index: number) => LinkedInDriverResult = () => ok,
  seatAnswer: () => LinkedInSeatRead | LinkedInDriverResult = () => seatRead
) {
  const calls: Array<{ method: string; target: string; body?: string }> = [];
  const driver: LinkedInDriver = {
    readSeat: async () => {
      calls.push({ method: 'readSeat', target: 'me' });
      return seatAnswer();
    },
    sendInvite: async (_page, target, note) => {
      calls.push({ method: 'sendInvite', target, body: note });
      return answer(target, calls.length - 1);
    },
    sendDm: async (_page, target, body) => {
      calls.push({ method: 'sendDm', target, body });
      return answer(target, calls.length - 1);
    },
    sendReply: async (_page, threadUrn, body) => {
      calls.push({ method: 'sendReply', target: threadUrn, body });
      return answer(threadUrn, calls.length - 1);
    },
    viewProfile: async (_page, target) => {
      calls.push({ method: 'viewProfile', target });
      return answer(target, calls.length - 1);
    },
    followProfile: async (_page, target) => {
      calls.push({ method: 'followProfile', target });
      return answer(target, calls.length - 1);
    },
    // `seed` is recorded as the body, because the thing worth asserting about
    // these two is that the BATCH-SCOPED seed reaches them: it is what makes
    // the in-action click jitter reproducible, and a driver handed no seed
    // silently falls back to one derived from the target.
    likeRecentPost: async (_page, target, options) => {
      calls.push({ method: 'likeRecentPost', target, body: options?.seed });
      return answer(target, calls.length - 1);
    },
    endorseSkills: async (_page, target, options) => {
      calls.push({ method: 'endorseSkills', target, body: options?.seed });
      return answer(target, calls.length - 1);
    },
    // Signed in already, which is what every test in this file assumes: no
    // fixture here stores a credential, so the session-reuse path is always
    // taken and `loginWithCredentials` is a trap.
    isLoggedIn: async () => {
      calls.push({ method: 'isLoggedIn', target: 'me' });
      return true;
    },
    loginWithCredentials: async () => {
      throw new Error('no test in this file stores a credential, so nothing may attempt a sign-in');
    }
  };
  return { driver, calls };
}

const threeActions = [
  action({ id: 'lact_1', targetRef: 'https://www.linkedin.com/in/a/' }),
  action({ id: 'lact_2', targetRef: 'https://www.linkedin.com/in/b/' }),
  action({ id: 'lact_3', targetRef: 'https://www.linkedin.com/in/c/' })
];

const noSleep = async () => {};

/**
 * A SITTING IS PROCESS STATE, AND THESE TESTS SHARE A PROCESS.
 *
 * `runDueLinkedInActions` remembers that a seat is on a break between sittings
 * in a module-level Map, so without this one test's break silently refuses the
 * next test's seat and the failure reads as "nothing was executed" three
 * describes away from the cause.
 */
beforeEach(() => {
  resetLinkedInSessionRhythm();
});

describe('dispatch is exhaustive', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS TO HOLD DOWN.
   *
   * `execute()` used to end in an unguarded `return deps.driver.viewProfile()`,
   * which read as a default and behaved as a trapdoor: every kind that was not
   * 'invite' or 'dm' silently loaded a profile instead. That was harmless with
   * three executable kinds and a wrong ledger row with seven -- a `follow`
   * settled 'sent' while the account performed a profile view, in the one table
   * the entire pacing engine reasons from.
   */
  it('sends each kind to its own routine, and never to viewProfile by fallthrough', async () => {
    const harness = fakeStore([
      action({ id: 'lact_invite', kind: 'invite', targetRef: 'in/a' }),
      action({ id: 'lact_dm', kind: 'dm', targetRef: 'in/b', body: 'approved' }),
      action({ id: 'lact_reply', kind: 'reply', targetRef: 'in/c', body: 'answered', threadUrn: '2-thread==' }),
      action({ id: 'lact_view', kind: 'profile_view', targetRef: 'in/d', body: null }),
      action({ id: 'lact_follow', kind: 'follow', targetRef: 'in/e', body: null }),
      action({ id: 'lact_like', kind: 'like', targetRef: 'in/f', body: null }),
      action({ id: 'lact_endorse', kind: 'endorse', targetRef: 'in/g', body: null })
    ]);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(result.executed).toBe(7);
    expect(calls.map((entry) => entry.method)).toEqual([
      'sendInvite',
      'sendDm',
      'sendReply',
      'viewProfile',
      'followProfile',
      'likeRecentPost',
      'endorseSkills'
    ]);
    // A reply is addressed by CONVERSATION, not by profile. Handing the target
    // to `sendDm` would open a second conversation with somebody already in one.
    expect(calls.find((entry) => entry.method === 'sendReply')?.target).toBe('2-thread==');
  });

  it('threads the batch-scoped seed into the routines that pause between clicks', async () => {
    const harness = fakeStore([action({ id: 'lact_like', kind: 'like', targetRef: 'in/f', body: null })]);
    const { driver, calls } = fakeDriver();

    await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    // The SAME seed the inter-action gap is drawn from, so a batch's whole
    // timing -- between actions and within one -- is reproducible from two ids
    // that are already in the ledger. A routine handed no seed falls back to one
    // derived from the target, which is stable across batches and therefore
    // exactly the pattern a rate-limiter could key on.
    expect(calls[0]?.body).toBe('lbatch_fixed:lact_like');
  });

  it('holds the claim and halts on a reply that lost its conversation', async () => {
    // Unreachable through the real claim, which requires a thread_urn. Asserted
    // because the alternative implementation -- falling back to `sendDm` -- is
    // exactly the silent substitution the exhaustive switch exists to stop.
    const harness = fakeStore([action({ id: 'lact_orphan', kind: 'reply', body: 'answered', threadUrn: null })]);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(calls).toHaveLength(0);
    expect(result.executed).toBe(0);
    expect(harness.skipped).toEqual([{ id: 'lact_orphan', failureKind: 'not_found' }]);
  });
});

describe('the branch gate runs in the loop', () => {
  it('retires a step whose branch can never be satisfied, without touching the driver', async () => {
    const harness = fakeStore(threeActions, {
      branch: async (candidate) =>
        candidate.id === 'lact_2'
          ? { outcome: 'skipped', reason: "Step 'message-1' is skipped: step 'invite' was not accepted." }
          : null
    });
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(calls.map((entry) => entry.target)).toEqual(['https://www.linkedin.com/in/a/', 'https://www.linkedin.com/in/c/']);
    expect(result.branchSkipped).toBe(1);
    expect(result.executed).toBe(2);
    expect(harness.branchSkipped.map((entry) => entry.id)).toEqual(['lact_2']);
    // Settled 'skipped', never 'failed': a branch that resolved to "they never
    // accepted" is the sequence working, not a driver problem.
    expect(harness.skipped).toEqual([]);
  });

  it('releases an undecided step and does not claim it again on this pass', async () => {
    // "Not yet" is not "no". The row stays planned for a later pass -- and the
    // loop must move on, because a released row is immediately claimable again
    // and the claim is ordered by planned_for.
    const harness = fakeStore(threeActions, {
      branch: async (candidate) =>
        candidate.id === 'lact_1'
          ? { outcome: 'pending', reason: "Step 'message-1' is waiting: nobody has accepted step 'invite' yet." }
          : null
    });
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(result.branchPending).toBe(1);
    expect(result.executed).toBe(2);
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: null }]);
    expect(harness.claimed).toEqual(['lact_1', 'lact_2', 'lact_3']);
    expect(calls.map((entry) => entry.target)).toEqual(['https://www.linkedin.com/in/b/', 'https://www.linkedin.com/in/c/']);
  });

  it('fails closed and halts when the branch cannot be evaluated at all', async () => {
    // Same rule as a gate that throws: "I could not find out whether this should
    // run" is not "run it".
    const harness = fakeStore(threeActions, {
      branch: async () => {
        throw new Error('sequence_json is unreadable');
      }
    });
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(calls).toHaveLength(0);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toContain('sequence_json is unreadable');
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: null }]);
  });
});

describe('the safety gate runs per action', () => {
  it('re-evaluates before every single action, never once for the batch', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver();
    const evaluated: string[] = [];

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async (candidate) => {
        evaluated.push(candidate.id);
        return verdict();
      }
    });

    // Three actions, three verdicts. A batch-level check would show one.
    expect(evaluated).toEqual(['lact_1', 'lact_2', 'lact_3']);
    expect(calls).toHaveLength(3);
    expect(result.executed).toBe(3);
    expect(harness.sent).toEqual(['lact_1', 'lact_2', 'lact_3']);
  });

  it('releases a refused action without letting it reach the driver', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async (candidate) =>
        candidate.id === 'lact_2'
          ? verdict({ allowed: false, reason: 'rolling-24h: 18 of 18 invites used', checks: [{ check: 'rolling-24h', passed: false, detail: 'full' }] })
          : verdict()
    });

    expect(calls.map((entry) => entry.target)).toEqual(['https://www.linkedin.com/in/a/', 'https://www.linkedin.com/in/c/']);
    expect(result.blocked).toBe(1);
    expect(result.executed).toBe(2);
    // Nothing was sent, so the claim goes back with no failure kind against it.
    expect(harness.released).toEqual([{ id: 'lact_2', failureKind: null }]);
  });

  it('DEFERS a refused row instead of re-claiming it until the pass is exhausted', async () => {
    // THE LIVELOCK. A refused row was released and left claimable, and the claim
    // is ordered by `planned_for ASC` -- so the same row came back on the very
    // next iteration, was refused by the same unchanged ledger, and the pass
    // spent all 25 of its iterations (each behind a 30-120s gap) on one action
    // while the rest of the queue was never reached.
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async (candidate) =>
        candidate.id === 'lact_1'
          ? verdict({ allowed: false, reason: 'rolling-24h: 18 of 18 invites used', checks: [{ check: 'rolling-24h', passed: false, detail: 'full' }] })
          : verdict()
    });

    // Claimed ONCE each, in order, and the two behind the refusal still ran.
    expect(harness.claimed).toEqual(['lact_1', 'lact_2', 'lact_3']);
    expect(result.blocked).toBe(1);
    expect(result.executed).toBe(2);
    expect(calls.map((entry) => entry.target)).toEqual(['https://www.linkedin.com/in/b/', 'https://www.linkedin.com/in/c/']);
    // Released with no failure kind: nothing was attempted, let alone failed.
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: null }]);
  });

  it('blocks on a duplicate-target refusal instead of second-guessing the gate', async () => {
    // The worker used to discount this one check under conditions of its own.
    // It does not any more: `excludeActionId` makes the gate authoritative
    // about which row is the subject, so a refusal that still comes back is a
    // refusal, and there is no branch here that could decide otherwise.
    const harness = fakeStore([action()]);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => soleDuplicateRefusal()
    });

    expect(calls).toHaveLength(0);
    expect(result.executed).toBe(0);
    expect(result.blocked).toBe(1);
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: null }]);
  });

  it('stops rather than guesses when the gate itself cannot be evaluated', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => {
        throw new Error('database is down');
      }
    });

    expect(calls).toHaveLength(0);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/database is down/);
  });
});

describe('what LinkedIn says stops the batch', () => {
  it('puts the seat in cooldown and halts on a limit wall', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver(() => ({
      ok: false,
      failureKind: 'limit_wall',
      detail: 'You have reached the weekly invitation limit.'
    }));

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    // One attempt, then stop. Pushing past a limit wall is what turns a
    // temporary restriction into a permanent one.
    expect(calls).toHaveLength(1);
    expect(harness.cooldowns).toBe(1);
    expect(result.halted).toBe(true);
    expect(result.executed).toBe(0);
    expect(result.haltReason).toMatch(/limit wall/);
    // Nothing was sent, so the claim is released -- and it goes back in the
    // queue with the two untouched actions, which were never even claimed.
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: 'limit_wall' }]);
    expect(harness.claimed).toEqual(['lact_1']);
    expect(harness.remaining()).toBe(3);
    expect(harness.closed).toEqual([{ status: 'halted', haltReason: result.haltReason, executed: 0 }]);
  });

  it('puts the seat in cooldown and halts on a challenge', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver(() => ({ ok: false, failureKind: 'challenge' }));

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(1);
    expect(harness.cooldowns).toBe(1);
    expect(result.halted).toBe(true);
  });

  it('refuses to open a batch at all while the seat is cooling down', async () => {
    const harness = fakeStore(threeActions, { posture: 'cooldown' });
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(0);
    expect(result.batchId).toBeNull();
    expect(result.haltReason).toMatch(/cooldown/);
  });

  it('refuses to act for a workspace with no seat', async () => {
    const harness = fakeStore(threeActions, { posture: null });
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(0);
    expect(result.haltReason).toMatch(/no LinkedIn seat/i);
  });

  it('settles a definite failure and carries on', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver((_target, index) =>
      index === 0 ? { ok: false, failureKind: 'not_found' } : ok
    );

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(3);
    expect(harness.skipped).toEqual([{ id: 'lact_1', failureKind: 'not_found' }]);
    expect(result.executed).toBe(2);
    expect(result.halted).toBe(false);
  });

  it('holds the claim and stops when an outcome is unknown', async () => {
    const harness = fakeStore(threeActions);
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'unknown' }));

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    // HELD, not released: a retry could put a second invite in front of the
    // same person, and that cannot be undone.
    expect(harness.held).toEqual([{ id: 'lact_1', failureKind: 'unknown' }]);
    expect(harness.released).toHaveLength(0);
    expect(result.halted).toBe(true);
  });

  it('puts a drifted selector back in the queue and stops reloading profiles', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver(() => ({ ok: false, failureKind: 'selector_drift' }));

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(1);
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: 'selector_drift' }]);
    expect(result.haltReason).toMatch(/SELECTORS in driver\.ts/);
  });

  it('defers a message to somebody who never accepted, instead of halting the batch as drift', async () => {
    // No Message control on a profile is not always drift: LinkedIn shows it to
    // 1st-degree connections only, so the commonest managed-workflow shape --
    // invite, then a message behind it -- reaches the message while the invite
    // is still pending. Halting the whole seat's batch for one unanswered
    // invite is what this classification stops.
    const messages = [
      action({ id: 'lact_1', kind: 'dm', targetRef: 'https://www.linkedin.com/in/a/', body: 'hello' }),
      action({ id: 'lact_2', kind: 'dm', targetRef: 'https://www.linkedin.com/in/b/', body: 'hello' })
    ];
    const harness = fakeStore(messages, { unacceptedInvite: true });
    const { driver, calls } = fakeDriver((target) =>
      target === 'https://www.linkedin.com/in/a/'
        ? { ok: false, failureKind: 'selector_drift', detail: `${SELECTORS.messageButton} did not match on https://www.linkedin.com/in/a/. Nothing was clicked.` }
        : ok
    );

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(result.halted).toBe(false);
    expect(result.failed).toBe(0);
    expect(result.branchPending).toBe(1);
    expect(result.executed).toBe(1);
    // Released untouched, and not re-handed on this pass.
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: null }]);
    expect(calls.map((entry) => entry.target)).toEqual(['https://www.linkedin.com/in/a/', 'https://www.linkedin.com/in/b/']);
  });

  it('still halts on a missing Message control when no unaccepted invite explains it', async () => {
    // The narrowing is evidence-based on BOTH sides. A profile this seat never
    // invited has no innocent explanation for a missing Message control, so it
    // is drift and the batch stops exactly as before.
    const harness = fakeStore([action({ kind: 'dm', body: 'hello' })], { unacceptedInvite: false });
    const { driver } = fakeDriver(() => ({
      ok: false,
      failureKind: 'selector_drift',
      detail: `${SELECTORS.messageButton} did not match on https://www.linkedin.com/in/maya/. Nothing was clicked.`
    }));

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(result.halted).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.haltReason).toMatch(/SELECTORS in driver\.ts/);
  });

  it('still halts on drift in any other control, even with an unaccepted invite on file', async () => {
    const harness = fakeStore([action({ kind: 'dm', body: 'hello' })], { unacceptedInvite: true });
    const { driver } = fakeDriver(() => ({
      ok: false,
      failureKind: 'selector_drift',
      detail: 'button.artdeco-button--connect did not match on https://www.linkedin.com/in/maya/. Nothing was clicked.'
    }));

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/SELECTORS in driver\.ts/);
  });
});

describe('the kill switch', () => {
  it('stops within one tick when the seat is paused mid-batch', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver(() => {
      // The operator pauses the seat while the first action is in flight.
      harness.setPosture('paused');
      return ok;
    });

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(1);
    expect(result.executed).toBe(1);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/paused/);
    // The second and third actions were never claimed, so nothing has to be
    // released for them.
    expect(harness.remaining()).toBe(2);
  });

  it('stops when a stop is requested for the batch', async () => {
    const harness = fakeStore(threeActions);
    const { driver, calls } = fakeDriver(() => {
      harness.requestStop();
      return ok;
    });

    const result = await runLinkedInLocalBatch(harness.store, { driver, page, sleep: noSleep, log: () => {}, evaluate: async () => verdict() });

    expect(calls).toHaveLength(1);
    expect(result.haltReason).toMatch(/stop was requested/i);
  });
});

describe('inter-action pacing', () => {
  it('draws the same gap for the same seed, every time and on every machine', () => {
    const first = actionGapSeconds('lbatch_fixed:lact_1');
    expect(actionGapSeconds('lbatch_fixed:lact_1')).toBe(first);
    expect(actionGapSeconds('lbatch_fixed:lact_2')).not.toBe(first);
  });

  it('keeps every gap inside the reported 30-120s band', () => {
    for (let index = 0; index < 200; index += 1) {
      const seconds = actionGapSeconds(`lbatch_fixed:lact_${index}`);
      expect(seconds).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min);
      expect(seconds).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max);
    }
  });

  it('paces an identical batch identically, with no Math.random anywhere in it', async () => {
    async function run(): Promise<number[]> {
      const harness = fakeStore(threeActions);
      const slept: number[] = [];
      const { driver } = fakeDriver();
      await runLinkedInLocalBatch(harness.store, {
        driver,
        page,
        log: () => {},
        sleep: async (ms) => {
          slept.push(ms);
        },
        evaluate: async () => verdict()
      });
      return slept;
    }

    const first = await run();
    const second = await run();
    // Two gaps for three actions: the first action does not wait.
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    for (const ms of first) {
      expect(ms).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min * 1000);
      expect(ms).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max * 1000);
    }
  });
});

/**
 * Playwright is an OPTIONAL dependency, so "it is not installed" is the normal
 * state of every deployment that did not opt in -- including this one, usually.
 * The test is skipped rather than inverted when it IS installed, because
 * asserting "stays disabled without playwright" against a machine that has
 * playwright would launch a real browser.
 */
const playwrightSpecifier: string = 'playwright';
const playwrightInstalled = await import(playwrightSpecifier).then(() => true).catch(() => false);

describe('the optional dependency', () => {
  it('stays off, and never touches the database, when the gate is closed', async () => {
    const forbidden = new Proxy({} as Db, {
      get() {
        throw new Error('a disabled LinkedIn worker must not touch the database');
      }
    });
    await expect(runDueLinkedInActions(forbidden, { enabled: false })).resolves.toEqual([]);
  });

  it('stays off, and never touches the database, when no browser can be opened here', async () => {
    const forbidden = new Proxy({} as Db, {
      get() {
        throw new Error('a worker with no browser must not touch the database');
      }
    });

    // The suite's setup file points Playwright's registry at a directory that
    // does not exist, so this is the container case for every developer.
    const readiness = linkedInBrowserReadiness({ enabled: true });
    expect(readiness.canLaunchHeaded).toBe(false);
    expect(readiness.reasons.join(' ')).toContain('npx playwright install chromium');

    // Enabled, and still must not throw: a browser this machine cannot open
    // must not take down the worker process and everything else it runs. The
    // work is not lost either -- it stays due for a worker that can.
    await expect(runDueLinkedInActions(forbidden, { enabled: true }, { log: () => {} })).resolves.toEqual([]);
  });

  it('defaults the profile directory under the operator home, not the repo, suffixed per workspace', () => {
    expect(resolveProfileDir(undefined, 'ws_a')).toMatch(/\.trevra\/linkedin-ws_a-profile$/);
    expect(resolveProfileDir('  ', 'ws_a')).toMatch(/\.trevra\/linkedin-ws_a-profile$/);
    expect(resolveProfileDir('/opt/profiles/linkedin', 'ws_a')).toBe('/opt/profiles/linkedin-ws_a-profile');
  });

  it('gives two different workspaces two different profile directories -- the whole point', () => {
    const a = resolveProfileDir(undefined, 'ws_a');
    const b = resolveProfileDir(undefined, 'ws_b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/linkedin-ws_a-profile$/);
    expect(b).toMatch(/linkedin-ws_b-profile$/);
  });

  it('keeps a workspace id to safe path characters', () => {
    const traversal = resolveProfileDir(undefined, '../../etc/passwd');
    expect(traversal).not.toContain('/../');
    expect(traversal).not.toContain('etc/passwd');
    expect(traversal).toMatch(/linkedin-_+etc_passwd-profile$/);
    expect(resolveProfileDir(undefined, '')).toMatch(/linkedin-default-profile$/);
  });
});

/**
 * The capability probe (plan 4.9).
 *
 * WHAT IT MUST NEVER DO IS LAUNCH ANYTHING. It feeds a status endpoint and the
 * detect route, and a status poll that opens Chrome is a status poll that
 * hangs. Everything below is environment and filesystem, and every case is
 * driven by an explicit `env` and `platform` so the answer does not depend on
 * whose laptop the suite is running on.
 */
describe('linkedInBrowserReadiness', () => {
  const registry = mkdtempSync(join(tmpdir(), 'trevra-browsers-'));
  mkdirSync(join(registry, 'chromium-1148'), { recursive: true });
  // A display is only real if something serves it, so the fixture serves one:
  // `X0` in a socket directory this test owns. `xSocketDir` exists for exactly
  // this -- the real path is /tmp/.X11-unix and a test has no business writing
  // a stray display into it.
  const sockets = mkdtempSync(join(tmpdir(), 'trevra-x11-'));
  writeFileSync(join(sockets, 'X0'), '');
  const served = { platform: 'linux', xSocketDir: sockets } as const;
  const equipped = { PLAYWRIGHT_BROWSERS_PATH: registry, DISPLAY: ':0' } as NodeJS.ProcessEnv;

  it('refuses before anything else when the deployment says no', () => {
    const hosted = linkedInBrowserReadiness({ enabled: false, hosted: true }, { env: equipped, ...served });
    expect(hosted.canLaunchHeaded).toBe(false);
    expect(hosted.reasons).toEqual(['This deployment is hosted, so LinkedIn automation is off and cannot be enabled.']);

    const off = linkedInBrowserReadiness({ enabled: false }, { env: equipped, ...served });
    expect(off.reasons).toEqual(['LinkedIn automation is switched off on this server.']);
  });

  /**
   * THE CONTAINER THAT COULD, AND THEREFORE DID.
   *
   * `runDueLinkedInActions` and `runLinkedInSideTasks` both rest on "a worker
   * in a container has no display and no browser, so it returns immediately
   * and claims no work away from the operator's own `npm run linkedin:worker`".
   * Installing Chromium in the image for other features made that false: the
   * container could launch headless, so it took the seat and drove the account
   * from a GPU-less container whose WebGL reports SwiftShader while the headed
   * worker sat idle.
   */
  it.skipIf(!playwrightInstalled)('lets a machine with no display decline the work instead of racing for it', () => {
    const blindButEquipped = { PLAYWRIGHT_BROWSERS_PATH: registry } as NodeJS.ProcessEnv;

    // Left alone, a container with a browser and no display still says yes to
    // headless -- which is correct where it is the only worker there is.
    expect(
      linkedInHeadlessReadiness({ enabled: true }, { env: blindButEquipped, platform: 'linux' }).canLaunchHeadless
    ).toBe(true);

    const declined = linkedInHeadlessReadiness({ enabled: true, headless: false }, { env: blindButEquipped, platform: 'linux' });
    expect(declined.canLaunchHeadless).toBe(false);
    expect(declined.reasons[0]).toContain('TREVRA_LINKEDIN_HEADLESS=false');

    // AND IT IS NOT AN OFF SWITCH. `enabled` stays true, so the feature, the
    // queue and the API's "run the worker on your machine" 202 are untouched --
    // which is the whole difference between this and TREVRA_LINKEDIN_LOCAL.
    expect(linkedInOffReason({ hosted: false })).not.toContain('HEADLESS');
    expect(
      linkedInHeadlessReadiness({ enabled: false, headless: false }, { env: blindButEquipped, platform: 'linux' }).reasons
    ).toEqual(['LinkedIn automation is switched off on this server.']);
  });

  it.skipIf(!playwrightInstalled)('says yes on a host with a display and an installed browser', () => {
    const ready = linkedInBrowserReadiness({ enabled: true }, { env: equipped, ...served });
    expect(ready).toEqual({ canLaunchHeaded: true, reasons: [] });

    // Wayland counts too; the question is whether anything can be drawn.
    expect(
      linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: registry, WAYLAND_DISPLAY: 'wayland-0' }, ...served })
        .canLaunchHeaded
    ).toBe(true);
  });

  it.skipIf(!playwrightInstalled)('treats a missing display on linux as decisive', () => {
    const blind = linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: registry }, ...served });
    expect(blind.canLaunchHeaded).toBe(false);
    expect(blind.reasons.some((reason) => reason.includes('No display'))).toBe(true);
  });

  /**
   * THE DEFECT THIS CAUGHT, kept as a test because the wrong answer was so
   * expensive: `docker restart` left `/tmp/.X99-lock` behind, the new Xvfb
   * exited with "Server is already active for display 99", and DISPLAY stayed
   * set by the image. Reading the variable alone, this probe reported a
   * machine that could open a window; the operator got "check that Chromium is
   * installed" out of the first launch that tried.
   */
  it.skipIf(!playwrightInstalled)('will not call a display real when nothing is serving it', () => {
    const dead = { PLAYWRIGHT_BROWSERS_PATH: registry, DISPLAY: ':99' } as NodeJS.ProcessEnv;
    const verdict = linkedInBrowserReadiness({ enabled: true }, { env: dead, ...served });
    expect(verdict.canLaunchHeaded).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('DISPLAY is :99 but no X server is serving it');

    // Served, and the same probe says yes -- so the blocker is about the X
    // server, not about the number in the variable.
    writeFileSync(join(sockets, 'X99'), '');
    expect(linkedInBrowserReadiness({ enabled: true }, { env: dead, ...served }).canLaunchHeaded).toBe(true);

    // A remote X server over TCP has no socket on this machine to look for,
    // and must not be blocked for the lack of one.
    const forwarded = { PLAYWRIGHT_BROWSERS_PATH: registry, DISPLAY: 'host.docker.internal:0' } as NodeJS.ProcessEnv;
    expect(linkedInBrowserReadiness({ enabled: true }, { env: forwarded, ...served }).canLaunchHeaded).toBe(true);
  });

  it('names the install command when the browser registry is not there', () => {
    const bare = linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent/ms-playwright', DISPLAY: ':0' }, platform: 'linux' });
    expect(bare.canLaunchHeaded).toBe(false);
    expect(bare.reasons.join(' ')).toContain('npx playwright install chromium');
  });

  /**
   * THE SENTENCE THAT SENT AN OPERATOR AFTER THE WRONG THING. Chromium was
   * installed; the container's Xvfb had died on a stale lock and Chrome had
   * nowhere to draw. A message may name a cause only when the failure named it.
   */
  it('tells the operator what the browser actually said, or admits it does not know', () => {
    const xserver = describeBrowserOpenFailure(
      new Error('browserType.launchPersistentContext: Target closed\nBrowser logs:\n Looks like you launched a headed browser without having a XServer running.')
    );
    expect(xserver).toContain('no X server is serving it');
    expect(xserver).not.toContain('Chromium build is missing');

    expect(describeBrowserOpenFailure(new Error("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1228/chrome")))
      .toContain('npx playwright install chromium');

    // Unknown stays unknown: it points at the log rather than inventing a
    // next action, which is exactly what the old constant did.
    const vague = describeBrowserOpenFailure(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'));
    expect(vague).toContain("log for this attempt");
    expect(vague).not.toMatch(/Chromium|X server/);
  });

  /**
   * THE FLAGS, AS ONE ARRAY. They were two keys in one object literal -- a
   * conditional `args` spread and a literal `args` eleven lines below it -- so
   * the second silently won and the ANGLE pair never reached a browser. The
   * measured fix for "WebGL returns null in this container" was dead code from
   * the day it was written, and nothing warned.
   */
  it('passes every container flag in one array, ANGLE included', () => {
    const inside = seatLaunchArgs(true);
    expect(inside).toContain('--use-gl=angle');
    expect(inside).toContain('--use-angle=gl-egl');
    // Root in a container, headed or headless alike: making this depend on the
    // mode is how "works headless, dies headed" happens.
    expect(inside).toContain('--no-sandbox');
    expect(inside).toContain('--disable-blink-features=AutomationControlled');

    // NOT ON A REAL DESKTOP. Forcing EGL there moves the GL string away from
    // what every other Chrome on that machine reports, and dropping the sandbox
    // costs something real for nothing.
    expect(seatLaunchArgs(false)).toEqual(['--disable-blink-features=AutomationControlled']);
  });

  it('FAILS CLOSED, and every reason is one sentence an operator can act on', () => {
    const blocked = linkedInBrowserReadiness({ enabled: true }, { env: {}, ...served });
    expect(blocked.canLaunchHeaded).toBe(false);
    expect(blocked.reasons.length).toBeGreaterThan(0);
    for (const reason of blocked.reasons) {
      expect(reason.length).toBeLessThanOrEqual(120);
      expect(reason).not.toMatch(/TREVRA_LINKEDIN_LOCAL/);
    }
  });
});

function duplicateCheck(verdict: LinkedInSafetyVerdict): LinkedInSafetyCheck {
  const found = verdict.checks.find((entry) => entry.check === 'duplicate-target');
  if (!found) throw new Error('the verdict carries no duplicate-target check');
  return found;
}

/**
 * The one thing a fake gate cannot prove: that `excludeActionId` drops ONE ROW
 * and not the check.
 *
 * Postgres-backed, and skipped rather than failed without a database, because
 * everything above this line is deliberately DB-free. Run it the way the rest
 * of the suite runs: `npx tsx scripts/test-with-postgres.ts src/server/linkedin`.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('the gate stays authoritative about duplicates', () => {
  const WORKSPACE_ID = 'ws_linkedin_local_worker_test';
  const TARGET = 'https://www.linkedin.com/in/maya-duplicate/';
  // A Tuesday, 10:00 UTC: inside business hours, so nothing else in the gate
  // fails for reasons that would muddy what is being asserted.
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LEDGER_ROW_ID = 'lact_already_in_the_ledger';
  let db: Db;

  const input = {
    workspaceId: WORKSPACE_ID,
    seatKey: 'owner',
    kind: 'invite' as const,
    targetRef: TARGET,
    plannedFor: NOW.toISOString()
  };

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE_ID, 'LinkedIn local worker test', NOW.toISOString());
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, new Date('2025-01-01T10:00:00.000Z'));
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
      VALUES (?,?,'owner','invite',?,'planned',?,'export',?)
    `).run(LEDGER_ROW_ID, WORKSPACE_ID, TARGET, NOW.toISOString(), NOW.toISOString());
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('clears duplicate-target for the very row being evaluated', async () => {
    const verdict = await evaluateLinkedInSafety(db, input, NOW, { excludeActionId: LEDGER_ROW_ID });
    expect(duplicateCheck(verdict).passed).toBe(true);
  });

  it('keeps failing duplicate-target for any OTHER row against the same target', async () => {
    // The exclusion is by primary key. A different claimed row still sees the
    // ledger's existing action against this person and is refused -- which is
    // the whole point of the check surviving the exclusion.
    const verdict = await evaluateLinkedInSafety(db, input, NOW, { excludeActionId: 'lact_a_different_pending_row' });
    expect(duplicateCheck(verdict).passed).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it('reproduces export semantics byte for byte when no exclusion is named', async () => {
    expect(duplicateCheck(await evaluateLinkedInSafety(db, input, NOW)).passed).toBe(false);
    expect(duplicateCheck(await evaluateLinkedInSafety(db, input, NOW, { excludeActionId: null })).passed).toBe(false);
  });

  it('stops the worker on a real duplicate, with the real gate in the loop', async () => {
    const harness = fakeStore([action({ id: 'lact_a_second_pending_row', targetRef: TARGET, plannedFor: NOW.toISOString() })]);
    const { driver, calls } = fakeDriver();
    const verdicts: LinkedInSafetyVerdict[] = [];

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      now: () => NOW,
      // Wired exactly as runDueLinkedInActions wires it: the function, with the
      // claimed row excluded, and `plannedFor` set to `at` -- the instant this
      // re-check happens, not the row's possibly-stale original slot. Not the
      // `gtm.linkedin-guard` skill, which does not expose the exclusion at all.
      evaluate: async (candidate, at) => {
        const verdict = await evaluateLinkedInSafety(
          db,
          { ...input, targetRef: candidate.targetRef, plannedFor: at.toISOString() },
          at,
          { excludeActionId: candidate.id }
        );
        verdicts.push(verdict);
        return verdict;
      }
    });

    expect(duplicateCheck(verdicts[0]!).passed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.executed).toBe(0);
    expect(result.blocked).toBe(1);
  });
});

/**
 * THE REGRESSION `local-worker.ts`'s `runDueLinkedInActions` wiring exists to
 * hold down: the business-hours (and weekend) check has to judge the instant
 * the action is ACTUALLY about to happen, not the ledger row's original
 * `plannedFor`. A row can go stale -- a paused or cooling seat, or worker
 * downtime, leaves `planned` rows with an old-but-valid-looking slot -- and
 * once claimable again they are all judged against `now` for every OTHER
 * check (the rolling windows, warm-up, acceptance rate). Business-hours and
 * weekend must not be the one check still reading the stale timestamp, or a
 * backlog drained on resume can send for real at night or on a weekend while
 * every check reports business hours as satisfied.
 */
describe.skipIf(!databaseUrl)('the gate judges the real send instant, not a stale plan', () => {
  const WORKSPACE_ID = 'ws_linkedin_stale_planned_for_test';
  const TARGET = 'https://www.linkedin.com/in/stale-slot/';
  // The slot this action was ORIGINALLY paced for: a Tuesday, 10:00 UTC --
  // squarely inside business hours (08:00-18:00).
  const STALE_PLANNED_FOR = new Date('2026-08-04T10:00:00.000Z');
  // When the batch actually reaches it -- days later, at 23:00 UTC. Outside
  // business hours, on a different weekday than the stale slot claims.
  const EXECUTION_INSTANT = new Date('2026-08-07T23:00:00.000Z');
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE_ID, 'LinkedIn stale plannedFor test', STALE_PLANNED_FOR.toISOString());
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, new Date('2025-01-01T10:00:00.000Z'));
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('blocks a claimed action whose stale plannedFor reads as business hours when it is actually being sent at night', async () => {
    const harness = fakeStore([
      action({ id: 'lact_stale_slot', workspaceId: WORKSPACE_ID, targetRef: TARGET, plannedFor: STALE_PLANNED_FOR.toISOString() })
    ]);
    const { driver, calls } = fakeDriver();
    const verdicts: LinkedInSafetyVerdict[] = [];

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      now: () => EXECUTION_INSTANT,
      // Wired exactly as runDueLinkedInActions wires it (post-fix): `plannedFor`
      // is `at`, the instant of this very re-check, not `candidate.plannedFor`.
      evaluate: async (candidate, at) => {
        const verdict = await evaluateLinkedInSafety(
          db,
          {
            workspaceId: WORKSPACE_ID,
            seatKey: 'owner',
            kind: 'invite',
            targetRef: candidate.targetRef,
            plannedFor: at.toISOString()
          },
          at,
          { excludeActionId: candidate.id }
        );
        verdicts.push(verdict);
        return verdict;
      }
    });

    const businessHoursCheck = verdicts[0]!.checks.find((entry) => entry.check === 'business-hours');
    expect(businessHoursCheck?.passed).toBe(false);
    expect(verdicts[0]!.allowed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.executed).toBe(0);
    expect(result.blocked).toBe(1);
  });

  it('the pre-fix wiring (plannedFor from the stale row) is exactly what let this through', async () => {
    // Same scenario, but reproducing the OLD call shape: `plannedFor` taken
    // from the claimed row instead of `at`. This documents the bug the test
    // above guards against -- if this assertion ever starts failing, the two
    // tests together have stopped proving anything.
    const harness = fakeStore([
      action({ id: 'lact_stale_slot_prefix', workspaceId: WORKSPACE_ID, targetRef: TARGET, plannedFor: STALE_PLANNED_FOR.toISOString() })
    ]);
    const { driver, calls } = fakeDriver();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      now: () => EXECUTION_INSTANT,
      evaluate: async (candidate, at) =>
        evaluateLinkedInSafety(
          db,
          {
            workspaceId: WORKSPACE_ID,
            seatKey: 'owner',
            kind: 'invite',
            targetRef: candidate.targetRef,
            plannedFor: candidate.plannedFor // the bug: the stale slot, not `at`
          },
          at,
          // FLAT, so this test isolates the one thing it is about. The gate now
          // also shapes the day (rest days, drawn ceilings, moved edges), and a
          // historical-bug reproduction that failed because a Tuesday happened
          // to be a rest day would prove nothing about `plannedFor` vs `at`.
          { excludeActionId: candidate.id, dayShape: FLAT_DAY_SHAPE }
        )
    });

    // Sent for real (in this fake), at 23:00, because the gate was told the
    // slot was 10:00 the previous Tuesday.
    expect(calls).toHaveLength(1);
    expect(result.executed).toBe(1);
  });
});

/**
 * Detection: the seat read out of the session instead of typed into a form.
 *
 * Postgres-backed, because what is being asserted is what gets STORED -- the
 * write-once ramp clock above all -- and a fake store would assert nothing that
 * ships. The driver is still fake and no browser is launched: `page` is
 * injected, which is the same seam `runLinkedInLocalBatch` already takes.
 */
describe.skipIf(!databaseUrl)('detectLinkedInSeat', () => {
  const WORKSPACE_ID = 'ws_linkedin_detect_test';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const PROFILE_DIR = '/tmp/trevra-detect-test';
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE_ID, 'LinkedIn detect test', NOW.toISOString());
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  function detect(
    driver: LinkedInDriver,
    options: { enabled?: boolean; hosted?: boolean; timezone?: string; now?: Date } = {}
  ) {
    return detectLinkedInSeat(
      db,
      { enabled: options.enabled ?? true, hosted: options.hosted ?? false, profileDir: PROFILE_DIR },
      {
        workspaceId: WORKSPACE_ID,
        timezone: options.timezone ?? 'Europe/Zurich',
        now: options.now ?? NOW,
        driver,
        page,
        log: () => {}
      }
    );
  }

  it('reads the seat out of the session, and never resets the ramp clock', async () => {
    // THE FORM IS GONE. Nothing here declares a profile URL, a name or a
    // connection count: all three come back from the session, and only the
    // timezone -- which the server genuinely cannot derive -- is passed in.
    const { driver, calls } = fakeDriver();

    const first = await detect(driver);

    // Session reuse is tried first, every time, before anything is read.
    expect(calls.map((call) => call.method)).toEqual(['isLoggedIn', 'readSeat']);
    expect(first.blocked).toBeNull();
    expect(first.degraded).toEqual([]);
    expect(first.detected).toEqual({ profileUrl: 'https://www.linkedin.com/in/pankaj/', name: 'Pankaj Sharma', connectionsCount: 1234 });
    expect(first.seat?.profileUrl).toBe('https://www.linkedin.com/in/pankaj/');
    expect(first.seat?.connectionsCount).toBe(1234);
    expect(first.seat?.timezone).toBe('Europe/Zurich');
    // Label defaults to the detected name for a seat that has none.
    expect(first.seat?.label).toBe('Pankaj Sharma');
    expect(first.seat?.activatedAt).toBe(NOW.toISOString());
    expect(first.seat?.detectedAt).toBe(NOW.toISOString());

    // A second detect a week later must NOT restart the ramp, and must not
    // rewrite a label the operator has since chosen for themselves.
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)' }, NOW);
    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const second = await detect(driver, { now: later });
    expect(second.seat?.label).toBe('Pankaj (founder)');
    expect(second.seat?.activatedAt).toBe(NOW.toISOString());
    expect(second.seat?.detectedAt).toBe(later.toISOString());
  });

  it('reports a partial read as a success and never writes a fabricated zero', async () => {
    const complete = fakeDriver();
    await detect(complete.driver);

    const partial = fakeDriver(undefined, () => ({
      ok: true,
      profileUrl: 'https://www.linkedin.com/in/pankaj/',
      name: null,
      connectionsCount: null,
      degraded: ['The connections page shows no "N connections" header, so the connection count is unknown.']
    }));
    const result = await detect(partial.driver);

    expect(result.blocked).toBeNull();
    expect(result.degraded).toHaveLength(1);
    expect(result.detected?.connectionsCount).toBeNull();
    // A count we could not read leaves the stored one ALONE. Not null, and
    // above all not zero: a fabricated zero would be paced against.
    expect(result.seat?.connectionsCount).toBe(1234);
    expect(result.seat?.label).toBe('Pankaj Sharma');
  });

  it('refuses on a hosted deployment, before the driver is ever reached', async () => {
    const { driver, calls } = fakeDriver();

    const off = await detect(driver, { enabled: false, hosted: true });

    expect(calls).toHaveLength(0);
    expect(off.detected).toBeNull();
    expect(off.seat).toBeNull();
    // ONE SENTENCE, AND IT ENDS THE CONVERSATION. There is no switch to go and
    // find, so naming one would send the operator looking for it -- and the
    // profile directory this process would have used is inside a container the
    // operator cannot reach, which is worse than saying nothing.
    expect(off.blocked).toBe('This deployment is hosted, so LinkedIn automation is off and cannot be enabled.');
    expect(off.blocked).not.toContain('TREVRA_LINKEDIN_LOCAL');
    expect(off.blocked).not.toContain('TREVRA_DEPLOYMENT_MODE');
    expect(off.blocked).not.toContain(PROFILE_DIR);
    expect(await getSeat(db, WORKSPACE_ID)).toBeUndefined();

    // Switched off by a self-hoster is a DIFFERENT sentence, because that one
    // has a fix and hosted does not.
    const switchedOff = await detect(driver, { enabled: false });
    expect(switchedOff.blocked).toBe('LinkedIn automation is switched off on this server.');
  });

  it('refuses a challenge without storing a seat read through a half-open session', async () => {
    const { driver } = fakeDriver(undefined, () => ({
      ok: false,
      failureKind: 'challenge' as const,
      detail: 'LinkedIn is showing a challenge or a login page instead of your profile.'
    }));

    const result = await detect(driver);

    expect(result.detected).toBeNull();
    expect(result.seat).toBeNull();
    expect(result.failureKind).toBe('challenge');
    // The ONE next action, and above all not a container path the operator
    // cannot reach.
    expect(result.blocked).toBe('LinkedIn did not return a readable profile page; run `npm run linkedin:worker` on a machine with a display to see why.');
    expect(result.blocked).not.toContain(PROFILE_DIR);
    expect(result.blocked?.split('. ')).toHaveLength(1);
    expect(await getSeat(db, WORKSPACE_ID)).toBeUndefined();
  });

  it('refuses a timezone this runtime does not know, and stores nothing', async () => {
    const { driver } = fakeDriver();
    await expect(detect(driver, { timezone: 'Mars/Olympus' })).rejects.toThrow(/IANA/);
    expect(await getSeat(db, WORKSPACE_ID)).toBeUndefined();
  });
});

/**
 * The queue that carries a detect across the container/host split (plan 4.9).
 *
 * WHAT IS BEING ASSERTED IS THE HANDOFF, not the read itself: the API cannot
 * open a browser, the operator's own worker can, and the two only ever meet
 * through Postgres. Two properties are load-bearing:
 *
 *   1. ONE OUTSTANDING REQUEST PER SEAT, enforced by the partial unique index
 *      in 027 rather than by a caller remembering to check first.
 *   2. A PROCESS THAT CANNOT FULFIL A REQUEST NEVER CLAIMS ONE. Get that wrong
 *      and the API container quietly takes the work away from the one machine
 *      that could have done it, and the setup screen spins forever.
 */
describe.skipIf(!databaseUrl)('the seat detect queue', () => {
  const WORKSPACE_ID = 'ws_linkedin_detect_queue';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE_ID, 'LinkedIn detect queue test', NOW.toISOString());
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('keeps one outstanding request however many times Connect is pressed', async () => {
    const first = await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    expect(first.status).toBe('pending');

    const again = await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, new Date(NOW.getTime() + 1_000));
    expect(again.id).toBe(first.id);
    expect(again.requestedAt).toBe(first.requestedAt);

    const rows = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_seat_detect_requests WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(rows?.total).toBe(1);
  });

  it('refuses a timezone the runtime does not know, here rather than on another machine', async () => {
    await expect(requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Mars/Olympus' }, NOW)).rejects.toThrow(/IANA/);
    expect(await latestSeatDetectRequest(db, WORKSPACE_ID)).toBeNull();
  });

  it('NEVER CLAIMS what it cannot fulfil, so the host worker still gets it', async () => {
    await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    const { driver, calls } = fakeDriver();

    // No page handed in, so the readiness probe decides -- and the suite's
    // setup file guarantees it says no, exactly as it does in a container.
    const settled = await runPendingSeatDetectRequests(db, { enabled: true }, { driver, now: NOW, log: () => {} });

    expect(settled).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await latestSeatDetectRequest(db, WORKSPACE_ID))?.status).toBe('pending');
  });

  it('fulfils a pending request and upserts the seat, on the machine that can', async () => {
    await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    const { driver, calls } = fakeDriver();

    const settled = await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {} });

    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe('completed');
    expect(settled[0].failureReason).toBeNull();
    // Session reuse is tried first, every time, before anything is read.
    expect(calls.map((call) => call.method)).toEqual(['isLoggedIn', 'readSeat']);

    const seat = await getSeat(db, WORKSPACE_ID);
    expect(seat?.profileUrl).toBe('https://www.linkedin.com/in/pankaj/');
    expect(seat?.timezone).toBe('Europe/Zurich');
    expect((await latestSeatDetectRequest(db, WORKSPACE_ID))?.status).toBe('completed');

    // Nothing is left to claim, so a second pass is a no-op rather than a
    // second read of the same session.
    expect(await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {} })).toEqual([]);
  });

  it('records a refusal as failed with the one thing to do, instead of retrying forever', async () => {
    await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    const { driver } = fakeDriver(undefined, () => ({
      ok: false,
      failureKind: 'challenge' as const,
      detail: 'LinkedIn is showing a challenge or a login page instead of your profile.'
    }));

    const settled = await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {} });

    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe('failed');
    expect(settled[0].failureReason).toBe('LinkedIn did not return a readable profile page; run `npm run linkedin:worker` on a machine with a display to see why.');
    expect(await getSeat(db, WORKSPACE_ID)).toBeUndefined();

    // A failed request is terminal, and the operator can ask again: the
    // uniqueness predicate covers pending rows only.
    expect(await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {} })).toEqual([]);
    const retry = await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, new Date(NOW.getTime() + 60_000));
    expect(retry.status).toBe('pending');
  });

  it('stays off entirely when the deployment says no', async () => {
    await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    const { driver, calls } = fakeDriver();

    expect(
      await runPendingSeatDetectRequests(db, { enabled: false, hosted: true }, { driver, page, now: NOW, log: () => {} })
    ).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(linkedInOffReason({ hosted: true })).toBe('This deployment is hosted, so LinkedIn automation is off and cannot be enabled.');
  });

  it('lets a second worker reclaim a request the first one died holding', async () => {
    const queued = await requestSeatDetect(db, { workspaceId: WORKSPACE_ID, timezone: 'Europe/Zurich' }, NOW);
    // A worker claimed it and never came back. A detect SENDS NOTHING, so
    // re-running it duplicates nothing -- the only thing a permanent claim
    // would achieve here is a setup screen wedged forever.
    await db.prepare('UPDATE linkedin_seat_detect_requests SET claimed_at=? WHERE id=?')
      .run(new Date(NOW.getTime() - 30 * 60_000).toISOString(), queued.id);

    const { driver } = fakeDriver();
    const settled = await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {} });

    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe(queued.id);
    expect(settled[0].status).toBe('completed');
  });
});

/* ===========================================================================
 * MULTI-SEAT EXECUTION
 *
 * The audit finding this section exists to hold down: a workspace could plan,
 * pace and file actions for a second LinkedIn account all the way down the
 * queue, and then the worker only ever drained the owner seat -- so the second
 * account's queue filled up and never moved, silently, with nothing in any log
 * to notice. Everything below asserts one of the four things that had to
 * become per-(workspace, seat) for that to stop being true: DISCOVERY, the
 * PROFILE DIRECTORY and BROWSER IDENTITY, the COOLDOWN, and the CREDENTIAL.
 *
 * The owner seat's behaviour is asserted alongside every one of them, because
 * the change is only safe if an existing single-seat install notices nothing.
 * ======================================================================== */

describe('per-seat profile directories and browser identity', () => {
  it('leaves the owner seat on the exact path it already has', () => {
    // An existing install must not wake up on an empty profile directory and
    // need a fresh sign-in on the account it was already signed into.
    expect(resolveProfileDir(undefined, 'ws_a', 'owner')).toBe(resolveProfileDir(undefined, 'ws_a'));
    expect(resolveProfileDir(undefined, 'ws_a', 'owner')).toMatch(/\.trevra\/linkedin-ws_a-profile$/);
    expect(resolveProfileDir('/opt/profiles/linkedin', 'ws_a', 'owner')).toBe('/opt/profiles/linkedin-ws_a-profile');
  });

  it('gives every other seat a directory of its own', () => {
    const owner = resolveProfileDir(undefined, 'ws_a');
    const sales = resolveProfileDir(undefined, 'ws_a', 'sales');
    const support = resolveProfileDir(undefined, 'ws_a', 'support');

    expect(new Set([owner, sales, support]).size).toBe(3);
    expect(sales).toMatch(/linkedin-ws_a-sales-profile$/);
    // Two accounts sharing one user-data-dir do not merely see each other's
    // cookies: the second sign-in replaces the first one's session, so the two
    // seats would spend every tick logging each other out.
    expect(sales).not.toBe(owner);
    // And the same seat key under a different workspace is a different account.
    expect(resolveProfileDir(undefined, 'ws_b', 'sales')).not.toBe(sales);
  });

  it('keeps a seat key to safe path characters, like the workspace id', () => {
    const traversal = resolveProfileDir(undefined, 'ws_a', '../../etc/passwd');
    expect(traversal).not.toContain('/../');
    expect(traversal).not.toContain('etc/passwd');
  });

  it('derives a stable, non-default identity per seat, with no Math.random anywhere', () => {
    const first = seatContextFingerprint('ws_a', 'owner');
    const again = seatContextFingerprint('ws_a', 'owner');
    const other = seatContextFingerprint('ws_a', 'sales');

    // STABLE. A browser whose user agent, locale and timezone change between
    // sessions is a far stronger signal than any one wrong value.
    expect(again).toEqual(first);
    // DISTINCT. Two accounts from one machine must not be one fingerprint.
    expect(`${other.userAgent}|${other.locale}|${other.timezoneId}`)
      .not.toBe(`${first.userAgent}|${first.locale}|${first.timezoneId}`);
    // NON-DEFAULT. Playwright's own default announces the automation outright.
    for (const seat of [first, other]) {
      expect(seat.userAgent).not.toContain('HeadlessChrome');
      expect(seat.userAgent).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
      expect(seat.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: seat.timezoneId })).not.toThrow();
    }
  });

  it("uses the seat's own timezone when there is one, so the browser agrees with the plan", () => {
    const zurich = seatContextFingerprint('ws_a', 'sales', 'Europe/Zurich');
    expect(zurich.timezoneId).toBe('Europe/Zurich');
    expect(zurich.locale).toBe('de-CH');
    // The user agent is a fact about the seat, not about where it is.
    expect(zurich.userAgent).toBe(seatContextFingerprint('ws_a', 'sales').userAgent);
    // A timezone with no paired locale still wins for the timezone itself.
    expect(seatContextFingerprint('ws_a', 'sales', 'Asia/Tokyo').timezoneId).toBe('Asia/Tokyo');
  });
});

/**
 * The proxy.
 *
 * THE ONE PROPERTY THAT MATTERS IS THE REFUSAL. An operator configures a proxy
 * for a seat because that account must not be seen coming from this machine's
 * IP. "Configured but unusable" therefore has exactly one correct answer --
 * do not open a browser -- and never "connect directly this once", because a
 * direct connection cannot be taken back once LinkedIn has logged it.
 */
describe('per-seat outbound proxy', () => {
  it('is absent by default, which is the whole custody argument', () => {
    expect(resolveSeatProxy({}, 'ws_a', 'owner')).toBeNull();
    // Nothing about a seat key or a workspace id conjures one into existence.
    expect(resolveSeatProxy({ TREVRA_LINKEDIN_PROXY: '   ' }, 'ws_a', 'sales')).toBeNull();
  });

  it('resolves the most specific key that is set', () => {
    const env = {
      TREVRA_LINKEDIN_PROXY: 'http://everyone:pw@shared.example:8080',
      TREVRA_LINKEDIN_PROXY_SALES: 'http://seat.example:3128',
      TREVRA_LINKEDIN_PROXIES: JSON.stringify({ 'ws_a/sales': 'http://exact.example:3128' })
    } as NodeJS.ProcessEnv;

    expect(resolveSeatProxy(env, 'ws_a', 'sales')?.server).toBe('http://exact.example:3128');
    expect(resolveSeatProxy(env, 'ws_b', 'sales')?.server).toBe('http://seat.example:3128');
    expect(resolveSeatProxy(env, 'ws_b', 'owner')).toEqual({
      server: 'http://shared.example:8080',
      username: 'everyone',
      password: 'pw'
    });
  });

  /**
   * THE COLLISION THAT PUT TWO TENANTS ON ONE EXIT IP.
   *
   * `TREVRA_LINKEDIN_PROXY_<WS>_<SEAT>` joined two flattened ids with `_`, a
   * character both ids may contain -- so workspace `ws` + seat `a_sales` and
   * workspace `ws_a` + seat `sales` produced the SAME variable name. Nothing
   * anywhere could tell which tenant it belonged to, and both silently used it.
   */
  it('keys a per-seat proxy on the exact pair, so two tenants cannot collide', () => {
    const env = {
      TREVRA_LINKEDIN_PROXIES: JSON.stringify({
        'ws_a/sales': 'http://tenant-a.example:3128',
        'ws/a_sales': 'http://tenant-b.example:3128',
        'ws_a/*': 'http://tenant-a-default.example:3128',
        '*/support': 'http://support-anywhere.example:3128'
      })
    } as NodeJS.ProcessEnv;

    // The two names that used to be one.
    expect(resolveSeatProxy(env, 'ws_a', 'sales')?.server).toBe('http://tenant-a.example:3128');
    expect(resolveSeatProxy(env, 'ws', 'a_sales')?.server).toBe('http://tenant-b.example:3128');
    // Most specific wins, and the wildcards are compared whole too.
    expect(resolveSeatProxy(env, 'ws_a', 'owner')?.server).toBe('http://tenant-a-default.example:3128');
    expect(resolveSeatProxy(env, 'ws_z', 'support')?.server).toBe('http://support-anywhere.example:3128');
    expect(resolveSeatProxy(env, 'ws_z', 'owner')).toBeNull();
  });

  it('prefers the ACCOUNT\'S OWN stored proxy over every environment variable', () => {
    // Migration 062: the proxy is a fact about the account, and the column is
    // what a second operator can actually reach. The environment stays as the
    // fallback for seats without one, so an existing deployment is untouched.
    const env = {
      TREVRA_LINKEDIN_PROXIES: '{"ws_a/sales": "http://map.example:3128"}',
      TREVRA_LINKEDIN_PROXY: 'http://everything.example:3128'
    };
    expect(resolveSeatProxy(env, 'ws_a', 'sales', 'http://seat.example:3128')?.server).toBe('http://seat.example:3128');
    expect(resolveSeatProxy(env, 'ws_a', 'sales', '   ')?.server).toBe('http://map.example:3128');
    expect(resolveSeatProxy(env, 'ws_a', 'sales', null)?.server).toBe('http://map.example:3128');
    expect(resolveSeatProxy({}, 'ws_a', 'sales', null)).toBeNull();
  });

  it('carries a stored proxy\'s credentials through, without putting them in the server field', () => {
    expect(resolveSeatProxy({}, 'ws_a', 'owner', 'http://relay:hunter2@proxy.example:3128')).toEqual({
      server: 'http://proxy.example:3128',
      username: 'relay',
      password: 'hunter2'
    });
  });

  it('REFUSES a stored proxy it cannot use rather than connecting directly', () => {
    // The safety property, and the whole reason this throws instead of
    // returning null: null means "connect directly", from the very machine this
    // account was configured not to be seen from.
    expect(() => resolveSeatProxy({}, 'ws_a', 'owner', 'not a url')).toThrow(/is not a URL/);
    expect(() => resolveSeatProxy({}, 'ws_a', 'owner', 'ftp://proxy.example:21')).toThrow(/unsupported proxy scheme/);
    expect(() => resolveSeatProxy({}, 'ws_a', 'owner', 'socks5://relay:hunter2@proxy.example:1080')).toThrow(/SOCKS/);
    // Nor does it fall through to an environment proxy that WOULD have worked:
    // "we could not honour what you configured" is never "use something else".
    expect(() => resolveSeatProxy(
      { TREVRA_LINKEDIN_PROXY: 'http://everything.example:3128' },
      'ws_a',
      'owner',
      'not a url'
    )).toThrow(/is not a URL/);
  });

  it('never quotes a stored proxy value back, because it carries a password', () => {
    try {
      resolveSeatProxy({}, 'ws_a', 'owner', 'http://relay:hunter2@');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('REFUSES an ambiguous legacy variable instead of guessing whose it is', () => {
    // Set, and unmatchable to one pair. Ignoring it would fall through to null,
    // and null means "connect directly" -- from the machine this seat was
    // configured never to be seen from.
    expect(() => resolveSeatProxy({ TREVRA_LINKEDIN_PROXY_WS_A_SALES: 'http://exact.example:3128' }, 'ws_a', 'sales'))
      .toThrow(/TREVRA_LINKEDIN_PROXIES/);
    // A seat key that flattens losslessly is still served the old way.
    expect(resolveSeatProxy({ TREVRA_LINKEDIN_PROXY_SALES: 'http://seat.example:3128' }, 'ws_a', 'sales')?.server)
      .toBe('http://seat.example:3128');
    // A map that will not parse is a refusal too, and never quotes the value.
    try {
      resolveSeatProxy({ TREVRA_LINKEDIN_PROXIES: '{"ws_a/sales": "http://user:hunter2@proxy.example:3128"' }, 'ws_a', 'sales');
      throw new Error('a malformed proxy map must not resolve');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('REFUSES rather than falling back to a direct connection', () => {
    // Every one of these is a configured proxy that cannot be honoured. None
    // of them may resolve to null, because null means "connect directly".
    for (const value of ['not-a-url', 'ftp://proxy.example:21', 'socks5://user:pw@proxy.example:1080']) {
      expect(() => resolveSeatProxy({ TREVRA_LINKEDIN_PROXY: value }, 'ws_a', 'owner')).toThrow();
    }
    // And the refusal never quotes the value back: a proxy URL routinely
    // carries a password.
    try {
      resolveSeatProxy({ TREVRA_LINKEDIN_PROXY: 'http://user:hunter2@' }, 'ws_a', 'owner');
      throw new Error('a malformed proxy must not resolve');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});

/**
 * Human-cadence credential typing.
 *
 * `locator.fill()` sets an input's value in one operation: twenty characters
 * in the same millisecond, no keydown/keyup pairs, no inter-key timing at all.
 * On the one form where LinkedIn is looking hardest, that is the cheapest
 * possible tell.
 */
describe('human-cadence typing on the sign-in form', () => {
  function fakeField(options: { canPress?: boolean } = {}) {
    const filled: string[] = [];
    const pressed: string[] = [];
    const locator: LinkedInLocator = {
      count: async () => 1,
      first: () => locator,
      click: async () => {},
      textContent: async () => null,
      fill: async (text) => {
        filled.push(text);
      },
      ...(options.canPress === false ? {} : { press: async (key: string) => { pressed.push(key); } })
    };
    return { locator, filled, pressed };
  }

  function fakePage(field: LinkedInLocator) {
    const waits: number[] = [];
    const wrapped: LinkedInPage = {
      goto: async () => undefined,
      url: () => 'https://www.linkedin.com/login',
      locator: () => field,
      waitForTimeout: async (ms) => {
        waits.push(ms);
      }
    };
    return { page: wrapped, waits };
  }

  it('types character by character with a pause between each, instead of one fill', async () => {
    const field = fakeField();
    const { page: fake, waits } = fakePage(field.locator);

    await humanCadencePage(fake, 'seed').locator('input').first().fill('a@b.co');

    // The field is cleared once, and then every character is a real keypress.
    expect(field.filled).toEqual(['']);
    expect(field.pressed).toEqual(['a', '@', 'b', '.', 'c', 'o']);
    expect(waits).toHaveLength(6);
    for (const ms of waits) {
      expect(ms).toBeGreaterThanOrEqual(45);
      expect(ms).toBeLessThanOrEqual(165);
    }
  });

  it('paces the same seat identically every time, and two seats differently', async () => {
    async function type(seed: string): Promise<number[]> {
      const field = fakeField();
      const { page: fake, waits } = fakePage(field.locator);
      await humanCadencePage(fake, seed).locator('input').fill('correct horse');
      return waits;
    }

    const first = await type('linkedin-login:ws_a:owner');
    expect(await type('linkedin-login:ws_a:owner')).toEqual(first);
    // Not merely different values -- a different SEQUENCE, so two accounts on
    // one machine do not share a typing rhythm either.
    expect(await type('linkedin-login:ws_a:sales')).not.toEqual(first);
  });

  it('stays transparent for a page that cannot press keys, and never invents the method', async () => {
    const field = fakeField({ canPress: false });
    const { page: fake, waits } = fakePage(field.locator);
    const wrapped = humanCadencePage(fake, 'seed').locator('input');

    await wrapped.fill('typed-in-one-go');

    // `driver.ts` reads `typeof field.press` to decide whether the form can be
    // submitted with Enter. Inventing it here would have it press Enter on a
    // page that cannot.
    expect(wrapped.press).toBeUndefined();
    expect(field.filled).toEqual(['typed-in-one-go']);
    expect(waits).toEqual([]);
  });

  it('leaves an empty fill alone -- that is a clear, not typing', async () => {
    const field = fakeField();
    const { page: fake, waits } = fakePage(field.locator);
    await humanCadencePage(fake, 'seed').locator('input').fill('');
    expect(field.filled).toEqual(['']);
    expect(field.pressed).toEqual([]);
    expect(waits).toEqual([]);
  });
});

/**
 * The database half: discovery, claiming and cooldown, all per seat.
 *
 * Postgres-backed because every one of these was a SQL bug -- an
 * `AND seat_key='owner'` in one query and a missing seat argument in three
 * others -- and a fake store would assert none of it.
 */
describe.skipIf(!databaseUrl)('multi-seat draining', () => {
  const WORKSPACE_ID = 'ws_linkedin_multi_seat_test';
  const OTHER_WORKSPACE_ID = 'ws_linkedin_multi_seat_other';
  // A Tuesday, 10:00 UTC: inside business hours everywhere the gate looks.
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
  let db: Db;

  async function plan(seatKey: string, actionId: string, target: string): Promise<void> {
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
      VALUES (?,?,?,'profile_view',?,'planned',?,'export',?)
    `).run(actionId, WORKSPACE_ID, seatKey, target, NOW.toISOString(), NOW.toISOString());
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, 'LinkedIn multi-seat test', NOW.toISOString());
    }
    // Two accounts in one workspace, both long past their warm-up ramp.
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, LONG_AGO);
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales seat', timezone: 'Europe/Zurich' }, LONG_AGO, 'sales');
  });

  afterEach(async () => {
    for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
      await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
    await db?.close();
  });

  it("DISCOVERS A SECOND SEAT'S DUE ACTIONS -- the bug this whole change is about", async () => {
    await plan('sales', 'lact_sales_only', 'https://www.linkedin.com/in/sales-target/');

    // Before: the discovery query carried `AND seat_key='owner'`, so this list
    // came back EMPTY and the sales queue never drained.
    expect(await seatsWithDueActions(db, NOW)).toEqual([
      { workspaceId: WORKSPACE_ID, seatKey: 'sales', timezone: 'Europe/Zurich' }
    ]);
  });

  it('leaves the owner seat discovered exactly as before, alongside the others', async () => {
    await plan('owner', 'lact_owner_1', 'https://www.linkedin.com/in/owner-target/');
    await plan('sales', 'lact_sales_1', 'https://www.linkedin.com/in/sales-target/');

    expect(await seatsWithDueActions(db, NOW)).toEqual([
      { workspaceId: WORKSPACE_ID, seatKey: 'owner', timezone: 'UTC' },
      { workspaceId: WORKSPACE_ID, seatKey: 'sales', timezone: 'Europe/Zurich' }
    ]);

    // And nothing that is not due yet is swept in with it.
    expect(await seatsWithDueActions(db, new Date(NOW.getTime() - 60_000))).toEqual([]);
  });

  it('surfaces a due action whose seat row is missing, rather than dropping it silently', async () => {
    await plan('ghost', 'lact_ghost', 'https://www.linkedin.com/in/ghost/');
    // A queue that quietly never moves is the exact failure this function just
    // stopped having; the batch refuses it with a sentence instead.
    expect(await seatsWithDueActions(db, NOW)).toEqual([
      { workspaceId: WORKSPACE_ID, seatKey: 'ghost', timezone: null }
    ]);

    const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'ghost');
    const { driver, calls } = fakeDriver();
    const result = await runLinkedInLocalBatch(store, { driver, page, sleep: noSleep, log: () => {}, now: () => NOW, evaluate: async () => verdict() });
    expect(result.haltReason).toMatch(/No LinkedIn seat is configured/);
    expect(calls).toHaveLength(0);
  });

  it("claims only its own seat's rows, never the neighbouring account's", async () => {
    await plan('owner', 'lact_owner_1', 'https://www.linkedin.com/in/owner-target/');
    await plan('sales', 'lact_sales_1', 'https://www.linkedin.com/in/sales-target/');

    const salesStore = postgresLocalWorkerStore(db, WORKSPACE_ID, 'sales');
    const batchId = await salesStore.openBatch(NOW);
    const claimed = await salesStore.claimNextDueAction(batchId, NOW);

    expect(claimed?.id).toBe('lact_sales_1');
    expect(claimed?.seatKey).toBe('sales');
    // The owner's row is untouched and still claimable by the owner's store.
    expect(await salesStore.claimNextDueAction(batchId, NOW)).toBeNull();

    const ownerStore = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner');
    const ownerBatch = await ownerStore.openBatch(NOW);
    expect((await ownerStore.claimNextDueAction(ownerBatch, NOW))?.id).toBe('lact_owner_1');
  });

  it('A COOLDOWN ON ONE SEAT LEAVES THE OTHER DRAINING', async () => {
    await plan('owner', 'lact_owner_1', 'https://www.linkedin.com/in/owner-target/');
    await plan('sales', 'lact_sales_1', 'https://www.linkedin.com/in/sales-target/');

    // LinkedIn pushed back on the sales account. It restricts an ACCOUNT, not
    // a workspace, so cooling every seat would stop accounts that are fine and
    // leave a human to resume each of them.
    const salesStore = postgresLocalWorkerStore(db, WORKSPACE_ID, 'sales');
    await salesStore.enterCooldown(NOW);

    expect((await getSeat(db, WORKSPACE_ID, 'sales'))?.posture).toBe('cooldown');
    expect((await getSeat(db, WORKSPACE_ID))?.posture).not.toBe('cooldown');

    const { driver, calls } = fakeDriver();
    const halted = await runLinkedInLocalBatch(salesStore, { driver, page, sleep: noSleep, log: () => {}, now: () => NOW, evaluate: async () => verdict() });
    expect(halted.seatKey).toBe('sales');
    expect(halted.halted).toBe(true);
    expect(halted.haltReason).toMatch(/cooldown/);
    expect(halted.executed).toBe(0);

    const owner = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WORKSPACE_ID), {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      now: () => NOW,
      evaluate: async () => verdict()
    });
    expect(owner.seatKey).toBe('owner');
    expect(owner.executed).toBe(1);
    expect(owner.halted).toBe(false);
    // Exactly one action reached the driver, and it was the owner's.
    expect(calls.map((call) => call.target)).toEqual(['https://www.linkedin.com/in/owner-target/']);
  });

  it('stops one seat\'s batches by name, and every seat\'s when none is named', async () => {
    const ownerBatch = await postgresLocalWorkerStore(db, WORKSPACE_ID).openBatch(NOW);
    const salesBatch = await postgresLocalWorkerStore(db, WORKSPACE_ID, 'sales').openBatch(NOW);

    // Naming a seat stops that account and leaves the other running.
    expect(await stopLinkedInBatches(db, WORKSPACE_ID, 'sales')).toBe(1);
    const stopped = await db
      .prepare('SELECT id, seat_key, stop_requested_at FROM linkedin_batches WHERE workspace_id=? ORDER BY seat_key')
      .all<{ id: string; seat_key: string; stop_requested_at: string | null }>(WORKSPACE_ID);
    expect(stopped.find((row) => row.id === ownerBatch)?.stop_requested_at).toBeNull();
    expect(stopped.find((row) => row.id === salesBatch)?.stop_requested_at).not.toBeNull();

    // No seat named is the workspace kill switch: everything still running.
    expect(await stopLinkedInBatches(db, WORKSPACE_ID)).toBe(1);
    // Asking twice keeps the original timestamp rather than counting again.
    expect(await stopLinkedInBatches(db, WORKSPACE_ID)).toBe(0);
  });

  it('a limit wall on one seat cools that seat and no other', async () => {
    await plan('sales', 'lact_sales_1', 'https://www.linkedin.com/in/sales-target/');
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'limit_wall', detail: 'weekly invitation limit' }));

    const result = await runLinkedInLocalBatch(postgresLocalWorkerStore(db, WORKSPACE_ID, 'sales'), {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      now: () => NOW,
      evaluate: async () => verdict()
    });

    expect(result.halted).toBe(true);
    expect((await getSeat(db, WORKSPACE_ID, 'sales'))?.posture).toBe('cooldown');
    // The owner seat never saw a wall and is not paying for one.
    expect((await getSeat(db, WORKSPACE_ID))?.posture).not.toBe('cooldown');
  });

  /**
   * The credential, per seat, with the owner's rows deliberately not moved.
   *
   * The backward-compatibility claim is MIGRATION-FREE: nothing moved, because
   * the owner seat still reads and writes `workspace_secrets` through the same
   * reviewed path it always did. These assertions are what make that claim
   * checkable rather than a comment.
   */
  describe('per-seat credentials', () => {
    const OWNER_EMAIL = 'owner@example.com';
    const OWNER_PASSWORD = 'owner-canary-Ei9ohGh4';
    const SALES_EMAIL = 'sales@example.com';
    const SALES_PASSWORD = 'sales-canary-Ahz1Kae8';
    let previousKey: string | undefined;

    beforeEach(() => {
      previousKey = process.env.TREVRA_SECRETS_KEY;
      process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    });

    afterEach(() => {
      if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
      else process.env.TREVRA_SECRETS_KEY = previousKey;
      delete process.env.TREVRA_DEPLOYMENT_MODE;
    });

    it('keeps owner credentials written before this change resolving, out of the same table', async () => {
      // Written exactly as every pre-multi-seat caller wrote them: no seat key.
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: OWNER_EMAIL, password: OWNER_PASSWORD });

      const rows = await db
        .prepare('SELECT kind FROM workspace_secrets WHERE workspace_id=? ORDER BY kind')
        .all<{ kind: string }>(WORKSPACE_ID);
      expect(rows.map((row) => row.kind)).toEqual(['linkedin.email', 'linkedin.password']);
      // Nothing was copied into the seat table, so there is no migration that
      // could have half-run and no second copy of the owner's password.
      const copied = await db
        .prepare('SELECT COUNT(*)::int AS total FROM linkedin_seat_credentials WHERE workspace_id=?')
        .get<{ total: number }>(WORKSPACE_ID);
      expect(copied?.total).toBe(0);

      expect(await readLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      // And the seat-aware call resolves the same pair for the same seat.
      expect(await readLinkedInCredentials(db, WORKSPACE_ID, process.env, 'owner'))
        .toEqual({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    });

    it('gives a second seat its own sign-in, sealed the same way', async () => {
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: OWNER_EMAIL, password: OWNER_PASSWORD });
      const stored = await putLinkedInCredentials(db, {
        workspaceId: WORKSPACE_ID,
        email: SALES_EMAIL,
        password: SALES_PASSWORD,
        seatKey: 'sales'
      });
      expect(stored).toEqual({ hasCredentials: true, maskedEmail: 's•••@example.com' });

      // Each seat opens its OWN pair. Before this change there was one pair per
      // workspace, so a second account could not sign in at all.
      expect(await readLinkedInCredentials(db, WORKSPACE_ID, process.env, 'sales'))
        .toEqual({ email: SALES_EMAIL, password: SALES_PASSWORD });
      expect(await readLinkedInCredentials(db, WORKSPACE_ID))
        .toEqual({ email: OWNER_EMAIL, password: OWNER_PASSWORD });

      expect(await describeLinkedInCredentials(db, WORKSPACE_ID, 'sales'))
        .toEqual({ hasCredentials: true, maskedEmail: 's•••@example.com' });
      expect(await describeLinkedInCredentials(db, WORKSPACE_ID, 'support'))
        .toEqual({ hasCredentials: false, maskedEmail: null });

      // Same envelope, same key, and nothing plaintext-derived in the clear.
      const rows = await db
        .prepare('SELECT kind, label, ciphertext FROM linkedin_seat_credentials WHERE workspace_id=? AND seat_key=? ORDER BY kind')
        .all<{ kind: string; label: string | null; ciphertext: Buffer }>(WORKSPACE_ID, 'sales');
      expect(rows.map((row) => row.kind)).toEqual(['linkedin.email', 'linkedin.password']);
      expect(rows[0].label).toBe('s•••@example.com');
      expect(rows[1].label).toBeNull();
      for (const row of rows) {
        expect(row.ciphertext.toString('utf8')).not.toContain(SALES_PASSWORD);
        expect(row.ciphertext.toString('utf8')).not.toContain(SALES_EMAIL);
      }
      // The owner's rows did not move, and there is no owner row in the seat
      // table for a delete to miss.
      const ownerInSeatTable = await db
        .prepare("SELECT COUNT(*)::int AS total FROM linkedin_seat_credentials WHERE workspace_id=? AND seat_key='owner'")
        .get<{ total: number }>(WORKSPACE_ID);
      expect(ownerInSeatTable?.total).toBe(0);
    });

    it('wipes one seat without touching the other', async () => {
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: OWNER_EMAIL, password: OWNER_PASSWORD });
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: SALES_EMAIL, password: SALES_PASSWORD, seatKey: 'sales' });

      expect(await deleteLinkedInCredentials(db, WORKSPACE_ID, null, 'sales')).toBe(true);
      expect(await readLinkedInCredentials(db, WORKSPACE_ID, process.env, 'sales')).toBeNull();
      expect(await readLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
      expect(await deleteLinkedInCredentials(db, WORKSPACE_ID, null, 'sales')).toBe(false);
    });

    it('refuses hosted custody for EVERY seat, not just the owner', async () => {
      const hosted = { ...process.env, TREVRA_DEPLOYMENT_MODE: 'hosted' } as NodeJS.ProcessEnv;

      await expect(
        putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: SALES_EMAIL, password: SALES_PASSWORD, seatKey: 'sales', env: hosted })
      ).rejects.toThrow('This deployment is hosted, so it will not take custody of a LinkedIn password.');

      // And a hosted instance that inherited rows from a self-hosted dump still
      // does not open them, for any seat.
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: SALES_EMAIL, password: SALES_PASSWORD, seatKey: 'sales' });
      expect(await readLinkedInCredentials(db, WORKSPACE_ID, hosted, 'sales')).toBeNull();
    });

    it('scopes a seat key to its workspace', async () => {
      await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: SALES_EMAIL, password: SALES_PASSWORD, seatKey: 'sales' });
      expect(await readLinkedInCredentials(db, OTHER_WORKSPACE_ID, process.env, 'sales')).toBeNull();
    });
  });
});

/**
 * WHAT THE CLAIM CARRIES OFF THE ROW, and why each field is load-bearing.
 *
 * The pre-send re-evaluation of the safety gate is the last thing that happens
 * before the driver touches LinkedIn, and it can only judge what it is told.
 * Three facts live on the ledger row and nowhere else, and the claim did not
 * select any of them -- so the gate ran, every time, missing all three.
 */
describe.skipIf(!databaseUrl)('the claim carries the row facts the gate needs', () => {
  const WORKSPACE_ID = 'ws_linkedin_claim_facts_test';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(WORKSPACE_ID, 'claim facts', NOW.toISOString());
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, LONG_AGO);
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('returns the campaign, the replay scope and the warm-up override off the row', async () => {
    await db.prepare(`
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,started_at,created_at,updated_at)
      VALUES (?,?,?,'running',?::jsonb,'owner',?,?,?)
    `).run('licmp_claim', WORKSPACE_ID, 'Claim facts', JSON.stringify({ steps: [] }), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,source,replay_scope,override_warmup_ceiling,reply_to_inbound,body,thread_urn,created_at)
      VALUES (?,?,'owner','reply',?,?,'planned',?,'manual',?,true,true,?,?,?)
    `).run(
      'lact_claimfacts', WORKSPACE_ID, 'https://www.linkedin.com/in/maya/', 'licmp_claim',
      NOW.toISOString(), 'thread:2-maya==:sha256:abc', 'Happy to.', '2-maya==', NOW.toISOString()
    );

    const store = postgresLocalWorkerStore(db, WORKSPACE_ID);
    const batchId = await store.openBatch(NOW);
    const claimed = await store.claimNextDueAction(batchId, NOW);

    // Before: the RETURNING clause named none of these three, so the gate was
    // told there was no campaign (its ramp never bound on a real send), asked
    // an unscoped replay question, and could not see an override the operator
    // had already recorded.
    expect(claimed?.campaignId).toBe('licmp_claim');
    expect(claimed?.replayScope).toBe('thread:2-maya==:sha256:abc');
    expect(claimed?.overrideWarmupCeiling).toBe(true);
    // And the other reason the ceiling may not apply (migration 074). A reply
    // accepted at queue time because the other person wrote first must not be
    expect(claimed?.replyToInbound).toBe(true);
    // And the LEDGER's own fact about who put the row here. `source='manual'`
    // is what let this reply be queued outside the working window, so the
    // pre-send re-evaluation has to see it or the same gate refuses at 02:00
    // what it accepted at 02:00.
    expect(claimed?.manual).toBe(true);
    expect(claimed?.replyToInbound).toBe(true);
  });

  /**
   * THE ONE THING THAT MAY OPEN A BROWSER DURING A BREAK.
   *
   * A sitting break paces what the account does BY ITSELF. Work a person just
   * asked for is not that, and holding it for the two hours until the next
   * sitting is the same refusal the working window used to make, wearing a
   * different name -- and it would make relaxing the gate for hand-driven work
   * a change of error message and nothing else.
   *
   * Everything else stays asleep, which is what the negative cases pin down:
   * this must not become a general "urgent" flag an automated action can set.
   */
  it('sees work a person asked for, and nothing else', async () => {
    const due = async (): Promise<boolean> => dueManualWork(db, WORKSPACE_ID, 'owner', NOW);
    const insert = async (id: string, source: string, columns: string, values: string, ...binds: unknown[]): Promise<void> => {
      await db.prepare(`
        INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at${columns})
        VALUES (?,?,'owner','reply',?,'planned',?,?,?${values})
      `).run(id, WORKSPACE_ID, `https://www.linkedin.com/in/${id}/`, NOW.toISOString(), source, NOW.toISOString(), ...binds);
    };

    expect(await due()).toBe(false);

    // The planner's own work. It waits for the next sitting, which is what a
    // sitting break is for.
    await insert('lact_planned', 'campaign', '', '');
    expect(await due()).toBe(false);

    // A campaign row answering somebody who wrote first still wakes the seat:
    // that is the conversation's fact, not the planner's claim.
    await insert('lact_inbound', 'campaign', ',reply_to_inbound', ',true');
    expect(await due()).toBe(true);
    await db.prepare("UPDATE linkedin_actions SET status='sent' WHERE id=?").run('lact_inbound');
    expect(await due()).toBe(false);

    // A row the operator queued by hand. This one wakes the seat.
    await insert('lact_manual', 'manual', '', '');
    expect(await due()).toBe(true);

    // Already sent, so there is nothing waiting.
    await db.prepare("UPDATE linkedin_actions SET status='sent' WHERE id=?").run('lact_manual');
    expect(await due()).toBe(false);

    // Queued for later, which is a plan rather than work waiting now.
    await db.prepare("UPDATE linkedin_actions SET status='planned', planned_for=? WHERE id=?")
      .run(new Date(NOW.getTime() + 3_600_000).toISOString(), 'lact_manual');
    expect(await due()).toBe(false);

    // Another seat's queue is another account's business.
    await db.prepare("UPDATE linkedin_actions SET planned_for=?, seat_key='sales' WHERE id=?")
      .run(NOW.toISOString(), 'lact_manual');
    expect(await due()).toBe(false);
  });
  it('reports an ordinary row as unscoped, uncampaigned and un-overridden', async () => {
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
      VALUES (?,?,'owner','profile_view',?,'planned',?,'export',?)
    `).run('lact_plain', WORKSPACE_ID, 'https://www.linkedin.com/in/plain/', NOW.toISOString(), NOW.toISOString());

    const store = postgresLocalWorkerStore(db, WORKSPACE_ID);
    const claimed = await store.claimNextDueAction(await store.openBatch(NOW), NOW);

    expect(claimed?.campaignId).toBeNull();
    expect(claimed?.replayScope).toBe('legacy');
    expect(claimed?.overrideWarmupCeiling).toBe(false);
    expect(claimed?.replyToInbound).toBe(false);
  });

  it('sees an unaccepted invite to the same person, and does not see an accepted one', async () => {
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID);
    const dm = {
      id: 'lact_dm',
      workspaceId: WORKSPACE_ID,
      seatKey: 'owner',
      kind: 'dm' as const,
      targetRef: 'https://www.linkedin.com/in/Maya/',
      plannedFor: NOW.toISOString(),
      body: 'hello'
    };

    // Nothing on file at all: no evidence either way, so no excuse for a
    // missing Message control.
    expect(await store.hasUnacceptedInvite(dm)).toBe(false);

    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,recorded_at,source,created_at)
      VALUES (?,?,'owner','invite',?,'sent',?,'campaign',?)
    `).run('lact_inv', WORKSPACE_ID, 'https://www.linkedin.com/in/maya/', NOW.toISOString(), NOW.toISOString());
    // Case-folded, like every other target lookup in this subsystem.
    expect(await store.hasUnacceptedInvite(dm)).toBe(true);

    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run('lact_inv');
    expect(await store.hasUnacceptedInvite(dm)).toBe(false);
  });

  it('BRANCHES A MANAGER WORKFLOW, whose steps are keyed `action` and not `kind`', async () => {
    // The parser only understood the 025-era `kind` key, so every manager
    // campaign parsed to zero steps, `hasBranching` answered false, and the
    // message step ran against a lead who had never accepted the invite.
    const steps = [
      { id: 'step-1', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: null } },
      { id: 'step-2', action: 'message', delayBefore: { amount: 2, unit: 'days' }, config: { variants: [{ id: 'a', body: 'hi', weight: 100 }] } }
    ];
    await db.prepare(`
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,started_at,created_at,updated_at)
      VALUES (?,?,?,'running',?::jsonb,'owner',?,?,?)
    `).run(
      'licmp_mgr', WORKSPACE_ID, 'Manager campaign',
      JSON.stringify({ manager: true, workflowId: 'liwf_1', workflowVersion: 1, steps }),
      LONG_AGO.toISOString(), LONG_AGO.toISOString(), NOW.toISOString()
    );
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,recorded_at,source,replay_scope,created_at)
      VALUES (?,?,'owner','invite',?,?,'sent',?,'campaign',?,?)
    `).run('lact_mgr_inv', WORKSPACE_ID, 'https://www.linkedin.com/in/lead/', 'licmp_mgr', NOW.toISOString(), 'limem_1:step-1', NOW.toISOString());
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,source,replay_scope,body,created_at)
      VALUES (?,?,'owner','dm',?,?,'planned',?,'campaign',?,?,?)
    `).run('lact_mgr_dm', WORKSPACE_ID, 'https://www.linkedin.com/in/lead/', 'licmp_mgr', NOW.toISOString(), 'limem_1:step-2', 'hi', NOW.toISOString());

    const store = postgresLocalWorkerStore(db, WORKSPACE_ID);
    const claimed = await store.claimNextDueAction(await store.openBatch(NOW), NOW);
    expect(claimed?.id).toBe('lact_mgr_dm');

    // The invite is 'sent' and unanswered: "not yet" is not "no", so the
    // message waits rather than being sent to a stranger.
    const pending = await store.branchDecision(claimed as DueLinkedInAction, NOW);
    expect(pending?.outcome).toBe('pending');

    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run('lact_mgr_inv');
    const due = await store.branchDecision(claimed as DueLinkedInAction, NOW);
    expect(due?.outcome).toBe('due');

    await db.prepare("UPDATE linkedin_actions SET status='declined' WHERE id=?").run('lact_mgr_inv');
    const dead = await store.branchDecision(claimed as DueLinkedInAction, NOW);
    expect(dead?.outcome).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// What a fleet needs and one laptop never did
// ---------------------------------------------------------------------------

/**
 * THE LEASE.
 *
 * Every assertion below fails against the code as it was, and each one is a
 * row that could not come back:
 *
 *   * a claim carried no owner and no deadline, so a worker killed between
 *     claiming and settling stranded the row PERMANENTLY -- invisible to
 *     discovery (`claimed_at IS NULL`), invisible to the claim, and reported
 *     nowhere;
 *   * and the deliberate hold on an UNKNOWN outcome looked identical to that
 *     strand, so anything able to recover the second would have re-queued the
 *     first -- an action that may already have reached somebody's
 *     notifications, which is the one thing this subsystem must never do.
 */
describe.skipIf(!databaseUrl)('a claim has an owner and a deadline', () => {
  const WORKSPACE_ID = 'ws_linkedin_lease_test';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
  let db: Db;

  const planned = async (id: string, target: string, plannedFor: Date = NOW) => {
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
      VALUES (?,?,'owner','profile_view',?,'planned',?,'export',?)
    `).run(id, WORKSPACE_ID, target, plannedFor.toISOString(), LONG_AGO.toISOString());
  };

  const row = async (id: string) =>
    db.prepare(`
      SELECT status, claimed_by, batch_id,
             claimed_at IS NULL AS unclaimed,
             lease_expires_at IS NULL AS unleased,
             settlement_hold_at IS NULL AS unheld
      FROM linkedin_actions WHERE id=?
    `).get<{ status: string; claimed_by: string | null; batch_id: string | null; unclaimed: boolean; unleased: boolean; unheld: boolean }>(id);

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(WORKSPACE_ID, 'lease test', LONG_AGO.toISOString());
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, LONG_AGO);
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('writes the worker and the deadline onto the row it claims', async () => {
    await planned('lact_lease_1', 'https://www.linkedin.com/in/one/');
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner', { workerId: 'worker-a', leaseMs: 60_000 });
    const batchId = await store.openBatch(NOW);

    expect((await store.claimNextDueAction(batchId, NOW))?.id).toBe('lact_lease_1');

    const claimed = await row('lact_lease_1');
    expect(claimed?.claimed_by).toBe('worker-a');
    expect(claimed?.unclaimed).toBe(false);
    expect(claimed?.unleased).toBe(false);
  });

  it('leaves a live lease alone and releases an expired one', async () => {
    await planned('lact_lease_2', 'https://www.linkedin.com/in/two/');
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner', { workerId: 'worker-a', leaseMs: 60_000 });
    await store.claimNextDueAction(await store.openBatch(NOW), NOW);

    // Still inside the term: the worker is alive, and stealing the row here is
    // exactly how a second invite reaches somebody.
    expect(await reapExpiredActionLeases(db, { now: new Date(NOW.getTime() + 30_000) })).toBe(0);
    expect((await row('lact_lease_2'))?.unclaimed).toBe(false);

    // Past it: the worker stopped heartbeating, so it stopped existing.
    expect(await reapExpiredActionLeases(db, { now: new Date(NOW.getTime() + 120_000) })).toBe(1);
    const released = await row('lact_lease_2');
    expect(released?.unclaimed).toBe(true);
    expect(released?.claimed_by).toBeNull();
    expect(released?.batch_id).toBeNull();

    // And it is due again, which is the entire point of releasing it.
    // Filtered to this workspace: every test file in this suite shares one
    // database, and what is being asserted is about this seat.
    const due = (await seatsWithDueActions(db, NOW)).filter((seat) => seat.workspaceId === WORKSPACE_ID);
    expect(due.map((seat) => seat.seatKey)).toEqual(['owner']);
  });

  it('a heartbeat pushes the deadline out, and only the holder may send one', async () => {
    await planned('lact_lease_3', 'https://www.linkedin.com/in/three/');
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner', { workerId: 'worker-a', leaseMs: 60_000 });
    const batchId = await store.openBatch(NOW);
    await store.claimNextDueAction(batchId, NOW);

    // A worker that is alive at +60s: the lease it renewed there must hold at +90s.
    await store.heartbeat(batchId, 'lact_lease_3', new Date(NOW.getTime() + 60_000));
    expect(await reapExpiredActionLeases(db, { now: new Date(NOW.getTime() + 90_000) })).toBe(0);

    // An impostor cannot renew what it does not hold: `claimed_by` is in the
    // predicate, so a worker whose claim was already reaped cannot extend it
    // back into existence.
    const impostor = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner', { workerId: 'worker-b', leaseMs: 3_600_000 });
    await impostor.heartbeat(batchId, 'lact_lease_3', new Date(NOW.getTime() + 90_000));
    expect(await reapExpiredActionLeases(db, { now: new Date(NOW.getTime() + 200_000) })).toBe(1);
  });

  it('NEVER touches the deliberate hold, however long it has been held', async () => {
    await planned('lact_lease_4', 'https://www.linkedin.com/in/four/');
    const store = postgresLocalWorkerStore(db, WORKSPACE_ID, 'owner', { workerId: 'worker-a', leaseMs: 60_000 });
    await store.claimNextDueAction(await store.openBatch(NOW), NOW);
    // We clicked and lost the thread. A retry could put a second invite in
    // somebody's notifications and that cannot be withdrawn.
    await store.holdClaim('lact_lease_4', 'unknown');

    const held = await row('lact_lease_4');
    expect(held?.unheld).toBe(false);
    expect(held?.unleased).toBe(true);

    expect(await reapExpiredActionLeases(db, { now: new Date(NOW.getTime() + 30 * 86_400_000) })).toBe(0);
    expect((await row('lact_lease_4'))?.unclaimed).toBe(false);
    // And it is not offered to a worker either.
    expect((await seatsWithDueActions(db, NOW)).filter((seat) => seat.workspaceId === WORKSPACE_ID)).toEqual([]);
  });

  it('recovers a pre-lease strand but not a pre-lease hold', async () => {
    // Both rows are what this table looked like before migration 054: claimed,
    // no owner, no deadline. The ONLY thing that tells them apart is that the
    // hold path always recorded a `failure_kind` and the claim path never did.
    await planned('lact_legacy_strand', 'https://www.linkedin.com/in/strand/');
    await planned('lact_legacy_hold', 'https://www.linkedin.com/in/legacyhold/');
    await db.prepare('UPDATE linkedin_actions SET claimed_at=? WHERE id=?').run(LONG_AGO.toISOString(), 'lact_legacy_strand');
    await db.prepare("UPDATE linkedin_actions SET claimed_at=?, failure_kind='unknown' WHERE id=?").run(LONG_AGO.toISOString(), 'lact_legacy_hold');

    expect(await reapExpiredActionLeases(db, { now: NOW })).toBe(1);
    expect((await row('lact_legacy_strand'))?.unclaimed).toBe(true);
    expect((await row('lact_legacy_hold'))?.unclaimed).toBe(false);
  });

  it('closes a batch whose worker is gone, and leaves a running one alone', async () => {
    await db.prepare(`
      INSERT INTO linkedin_batches (id, workspace_id, seat_key, status, started_at)
      VALUES (?,?,'owner','running',?), (?,?,'owner','running',?)
    `).run(
      'lbatch_abandoned', WORKSPACE_ID, new Date(NOW.getTime() - 4 * 3_600_000).toISOString(),
      'lbatch_live', WORKSPACE_ID, NOW.toISOString()
    );

    expect(await reapStaleLinkedInBatches(db, { now: NOW })).toBe(1);
    const abandoned = await db.prepare('SELECT status, halt_reason FROM linkedin_batches WHERE id=?')
      .get<{ status: string; halt_reason: string | null }>('lbatch_abandoned');
    expect(abandoned?.status).toBe('halted');
    // The batch was ABANDONED, not failed. Saying otherwise would invent a
    // cause, the same rule `reapStaleAgentRuns` follows.
    expect(abandoned?.halt_reason).toContain('stopped without closing it');
    expect((await db.prepare('SELECT status FROM linkedin_batches WHERE id=?').get<{ status: string }>('lbatch_live'))?.status).toBe('running');
  });
});

/**
 * DISCOVERY: sharded, fair, bounded, and aware of a posture before a browser
 * is opened for it.
 */
describe.skipIf(!databaseUrl)('who this worker serves, and in what order', () => {
  const BUSY = 'ws_linkedin_shard_busy';
  const QUIET = 'ws_linkedin_shard_quiet';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
  let db: Db;

  const plan = async (workspaceId: string, seatKey: string, id: string, plannedFor: Date) => {
    await db.prepare(`
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,created_at)
      VALUES (?,?,?,'profile_view',?,'planned',?,'export',?)
    `).run(id, workspaceId, seatKey, `https://www.linkedin.com/in/${id}/`, plannedFor.toISOString(), LONG_AGO.toISOString());
  };

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    for (const workspaceId of [BUSY, QUIET]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, workspaceId, LONG_AGO.toISOString());
    }
    // The noisy tenant: four seats, all with work, none of it old.
    for (const seatKey of ['owner', 'sales', 'support', 'growth']) {
      await upsertSeat(db, BUSY, { label: seatKey, timezone: 'UTC' }, LONG_AGO, seatKey);
      await plan(BUSY, seatKey, `lact_busy_${seatKey}`, NOW);
    }
    // The tenant that has been waiting a week, with one seat.
    await upsertSeat(db, QUIET, { label: 'owner', timezone: 'UTC' }, LONG_AGO);
    await plan(QUIET, 'owner', 'lact_quiet', new Date(NOW.getTime() - 7 * 86_400_000));
  });

  afterEach(async () => {
    for (const workspaceId of [BUSY, QUIET]) await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  it('serves the tenant that has been waiting longest first', async () => {
    // Before: `ORDER BY workspace_id, seat_key` with no limit, so the busy
    // tenant was served first, to completion, on every tick -- and a tenant
    // whose id sorted last was never reached at all.
    const seats = (await dueSeatsForWorker(db, NOW)).filter((seat) => seat.workspaceId === BUSY || seat.workspaceId === QUIET);
    expect(seats[0]).toMatchObject({ workspaceId: QUIET, seatKey: 'owner' });
  });

  it('caps what one tenant takes out of a single pass', async () => {
    const seats = await dueSeatsForWorker(db, NOW, { maxSeatsPerWorkspace: 2 });
    expect(seats.filter((seat) => seat.workspaceId === BUSY)).toHaveLength(2);
    // And the small tenant is still served, which is the whole point of the cap.
    expect(seats.some((seat) => seat.workspaceId === QUIET)).toBe(true);
  });

  it('partitions the fleet between workers: every seat once, no seat twice', async () => {
    const all = await dueSeatsForWorker(db, NOW);
    const first = await dueSeatsForWorker(db, NOW, { shard: { index: 0, total: 2 } });
    const second = await dueSeatsForWorker(db, NOW, { shard: { index: 1, total: 2 } });
    const key = (seat: { workspaceId: string; seatKey: string }) => `${seat.workspaceId}/${seat.seatKey}`;

    // Before: every worker ran the identical query in the identical order, so
    // they all reached for the same seat and Chromium's profile lock decided
    // the winner. Adding a worker added contention and no throughput.
    expect([...first, ...second].map(key).sort()).toEqual(all.map(key).sort());
    expect(first.map(key).filter((entry) => second.map(key).includes(entry))).toEqual([]);
    expect(first.length + second.length).toBe(all.length);
  });

  it('never offers a paused or cooling seat, so neither pays for a browser', async () => {
    await upsertSeat(db, BUSY, { posture: 'paused' }, NOW, 'sales');
    await upsertSeat(db, BUSY, { posture: 'cooldown' }, NOW, 'support');

    const seats = (await dueSeatsForWorker(db, NOW)).filter((seat) => seat.workspaceId === BUSY);
    expect(seats.map((seat) => seat.seatKey)).not.toContain('sales');
    expect(seats.map((seat) => seat.seatKey)).not.toContain('support');
    // The seats that may work still carry their posture, so the pass can refuse
    // before it launches anything rather than after it has signed in.
    expect(seats.every((seat) => seat.posture !== null)).toBe(true);
  });

  it('still surfaces a queue whose seat row is missing, rather than losing it', async () => {
    await plan(QUIET, 'never_connected', 'lact_orphan', new Date(NOW.getTime() - 8 * 86_400_000));
    const seats = await dueSeatsForWorker(db, NOW);
    const orphan = seats.find((seat) => seat.seatKey === 'never_connected');
    // Posture null is what the batch turns into 'No LinkedIn seat is
    // configured...' -- a sentence an operator can act on. Dropping it here
    // would be a queue that quietly never moves.
    expect(orphan).toMatchObject({ workspaceId: QUIET, posture: null });
  });

  it('keeps the deployment-wide listing shape its callers already read', async () => {
    const listed = await seatsWithDueActions(db, NOW);
    expect(listed).toContainEqual({ workspaceId: QUIET, seatKey: 'owner', timezone: 'UTC' });
    expect(listed.map((seat) => `${seat.workspaceId}/${seat.seatKey}`)).toEqual(
      [...listed].map((seat) => `${seat.workspaceId}/${seat.seatKey}`).sort()
    );
  });

  it('shards the periodic per-seat and per-workspace work the same way', async () => {
    const key = (seat: { workspaceId: string; seatKey: string }) => `${seat.workspaceId}/${seat.seatKey}`;
    const shardedSeats = [
      ...(await seatRefsForShard(db, { shard: { index: 0, total: 2 }, limit: 500 })),
      ...(await seatRefsForShard(db, { shard: { index: 1, total: 2 }, limit: 500 }))
    ].map(key);
    const everySeat = (await seatRefsForShard(db, { limit: 500 })).map(key);
    expect(shardedSeats.sort()).toEqual(everySeat.sort());

    // The cursor is what stops a bounded tick from meaning "the first N
    // forever": page two starts where page one stopped.
    const firstPage = await seatRefsForShard(db, { limit: 2 });
    const secondPage = await seatRefsForShard(db, { limit: 2, after: firstPage[firstPage.length - 1] });
    // COMPARED AS THE PAIR, because the pair is the unit and the seat key alone
    // is not unique: 'owner' is the key every single-seat workspace has, and
    // other test files share this database. Projecting the workspace away made
    // two entirely different pages of seats look identical.
    expect(secondPage.map(key)).not.toEqual(firstPage.map(key));
    for (const seat of secondPage) expect(firstPage.map(key)).not.toContain(key(seat));

    const workspaces = [
      ...(await linkedinWorkspaceIdsForShard(db, { shard: { index: 0, total: 2 } })),
      ...(await linkedinWorkspaceIdsForShard(db, { shard: { index: 1, total: 2 } }))
    ];
    // A partition again: both of these tenants appear exactly once between the
    // two shards. (Other test files share this database, so the assertion is
    // about coverage and non-duplication, not about the whole list.)
    expect(workspaces.filter((workspaceId) => workspaceId === BUSY)).toEqual([BUSY]);
    expect(workspaces.filter((workspaceId) => workspaceId === QUIET)).toEqual([QUIET]);
    expect(new Set(workspaces).size).toBe(workspaces.length);
  });

  it('does not answer an unreadable queue with an empty one', async () => {
    // THE FAILURE THAT LOOKED LIKE SUCCESS. A discovery read that times out --
    // which is what the unindexed version did against a 30s statement_timeout
    // -- used to be swallowed into `[]`, byte-for-byte identical to "nothing is
    // due", so an entire deployment's LinkedIn queue could stop with nothing to
    // alert on. It has to reach the caller.
    const broken = { prepare: () => ({ all: async () => { throw new Error('canceling statement due to statement timeout'); } }) } as unknown as Db;
    await expect(dueSeatsForWorker(broken, NOW)).rejects.toThrow('statement timeout');
    // And the worker can be asked, from outside, whether the queue is moving.
    expect(linkedInWorkerHealth()).toMatchObject({ discoveryHealthy: expect.any(Boolean) });
  });
});

/**
 * THE SEAT LEASE, WHICH IS ALSO THE SESSION PIN.
 *
 * The Chrome profile directory IS the LinkedIn session -- its cookies, its
 * "remember this browser" device trust -- and it lives on ONE host's local
 * disk. A second host picking up the same seat finds an empty directory and
 * signs in from scratch: a new device, on an account LinkedIn already trusts a
 * specific browser for, which is the loudest challenge signal available to us.
 */
describe.skipIf(!databaseUrl)('a seat is driven by one worker, on the host that has its session', () => {
  const WORKSPACE_ID = 'ws_linkedin_seat_lease_test';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
  let db: Db;
  let profileDir: string;

  const lease = (over: { workerId: string; host: string; profileDir?: string; leaseMs?: number }, at: Date) =>
    claimSeatLease(
      db,
      { workspaceId: WORKSPACE_ID, seatKey: 'owner', profileDir: over.profileDir ?? profileDir, leaseMs: 60_000, ...over },
      at
    );

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(WORKSPACE_ID, 'seat lease', LONG_AGO.toISOString());
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'UTC' }, LONG_AGO);
    profileDir = mkdtempSync(join(tmpdir(), 'trevra-seat-lease-'));
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
    await db?.close();
  });

  it('refuses a second worker while the first is driving, and hands over once the term lapses', async () => {
    expect((await lease({ workerId: 'worker-a', host: 'host-1' }, NOW)).ok).toBe(true);

    const contested = await lease({ workerId: 'worker-b', host: 'host-1' }, new Date(NOW.getTime() + 30_000));
    expect(contested.ok).toBe(false);
    expect(contested.ok === false && contested.reason).toContain('already being driven');

    // Same host, expired term: a restarted worker is a new pid on the same
    // disk, and that disk still has the seat's session.
    expect((await lease({ workerId: 'worker-b', host: 'host-1' }, new Date(NOW.getTime() + 120_000))).ok).toBe(true);
  });

  it('will not let another host take a seat whose profile it does not have', async () => {
    await lease({ workerId: 'worker-a', host: 'host-1' }, NOW);

    const elsewhere = await lease(
      { workerId: 'worker-c', host: 'host-2', profileDir: join(tmpdir(), 'trevra-not-here-at-all') },
      new Date(NOW.getTime() + 86_400_000)
    );
    expect(elsewhere.ok).toBe(false);
    // Refusing is the point: running it here means a brand-new device sign-in
    // on that account, which is worse than the seat waiting.
    expect(elsewhere.ok === false && elsewhere.reason).toContain('pinned to host');
  });

  it('lets another host take it once the profile is actually there', async () => {
    await lease({ workerId: 'worker-a', host: 'host-1' }, NOW);
    const moved = mkdtempSync(join(tmpdir(), 'trevra-moved-profile-'));
    mkdirSync(join(moved, 'Default'), { recursive: true });

    expect(seatProfilePresent(moved)).toBe(true);
    // An operator who copied the profile here has said, by doing so, that this
    // host is a home for this seat.
    const taken = await lease({ workerId: 'worker-c', host: 'host-2', profileDir: moved }, new Date(NOW.getTime() + 86_400_000));
    expect(taken.ok).toBe(true);
  });

  it('only the holder may heartbeat, and releasing keeps the affinity', async () => {
    await lease({ workerId: 'worker-a', host: 'host-1' }, NOW);

    expect(await heartbeatSeatLease(db, { workspaceId: WORKSPACE_ID, seatKey: 'owner', workerId: 'worker-b' }, NOW)).toBe(false);
    expect(await heartbeatSeatLease(db, { workspaceId: WORKSPACE_ID, seatKey: 'owner', workerId: 'worker-a' }, NOW)).toBe(true);

    await releaseSeatLease(db, { workspaceId: WORKSPACE_ID, seatKey: 'owner', workerId: 'worker-a' }, NOW);
    // The row STAYS: it is also the record of which host holds this seat's
    // session, and that outlives the pass that took it.
    const kept = await db.prepare('SELECT host, released_at IS NOT NULL AS released FROM linkedin_seat_leases WHERE workspace_id=? AND seat_key=?')
      .get<{ host: string; released: boolean }>(WORKSPACE_ID, 'owner');
    expect(kept).toMatchObject({ host: 'host-1', released: true });

    // And a released seat is immediately available on that host again.
    expect((await lease({ workerId: 'worker-d', host: 'host-1' }, new Date(NOW.getTime() + 1_000))).ok).toBe(true);
  });
});

/**
 * The detect queue was a single GLOBAL FIFO with no tenant bound, so one
 * workspace onboarding thousands of seats sat in front of every other
 * workspace's Connect button.
 */
describe.skipIf(!databaseUrl)('the Connect queue is fair across tenants', () => {
  const FIRST = 'ws_linkedin_detect_fair_a';
  const SECOND = 'ws_linkedin_detect_fair_b';
  const NOW = new Date('2026-08-04T10:00:00.000Z');
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    for (const workspaceId of [FIRST, SECOND]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, workspaceId, NOW.toISOString());
    }
    // The tenant onboarding in bulk asked first, twice.
    await requestSeatDetect(db, { workspaceId: FIRST, timezone: 'UTC', seatKey: 'owner' }, new Date(NOW.getTime() - 60_000));
    await requestSeatDetect(db, { workspaceId: FIRST, timezone: 'UTC', seatKey: 'sales' }, new Date(NOW.getTime() - 59_000));
    // Somebody else pressed Connect once, later.
    await requestSeatDetect(db, { workspaceId: SECOND, timezone: 'UTC', seatKey: 'owner' }, new Date(NOW.getTime() - 10_000));
  });

  afterEach(async () => {
    for (const workspaceId of [FIRST, SECOND]) await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  it('serves two tenants before it serves one tenant twice', async () => {
    const { driver } = fakeDriver();
    const settled = await runPendingSeatDetectRequests(db, { enabled: true }, { driver, page, now: NOW, log: () => {}, maxRequests: 2 });

    expect(settled).toHaveLength(2);
    // THE PROPERTY IS THE NON-DUPLICATION. Before, the queue was a global FIFO
    // with no tenant bound, so the two oldest requests were both this bulk
    // onboarding's and the other tenant waited behind all of them.
    expect(new Set(settled.map((request) => request.workspaceId)).size).toBe(2);
    // Specifically: the bulk onboarding got ONE of its two, not both, however
    // far in front of everybody else it queued.
    expect(settled.filter((request) => request.workspaceId === FIRST).length).toBeLessThanOrEqual(1);
  });
});

/**
 * BROWSERS ARE THE MEMORY, AND THE MAP WAS APPEND-ONLY.
 *
 * One live Chromium per seat this process had ever served, at ~350-500MB each.
 * The leak below is worse still: a failure anywhere after the launch returned
 * null WITHOUT closing the context, so a leaked browser went on holding the
 * profile directory's exclusive lock and permanently stranded that seat for
 * every worker on the host.
 */
describe('open browsers are bounded, and a failed open leaks nothing', () => {
  function fakePlaywright(options: { failAfterLaunch?: boolean } = {}) {
    const opened: string[] = [];
    const closed: string[] = [];
    const playwright = {
      chromium: {
        launchPersistentContext: async (userDataDir: string) => {
          opened.push(userDataDir);
          return {
            pages: () => [],
            newPage: async () => {
              if (options.failAfterLaunch) throw new Error('the tab could not be created');
              return {};
            },
            cookies: async () => [],
            on: () => {},
            close: async () => {
              closed.push(userDataDir);
            }
          };
        }
      }
    } as unknown as PlaywrightLike;
    return { playwright, opened, closed };
  }

  const config = { enabled: true, hosted: false, profileDir: '/tmp/trevra-browser-cap-test' };
  const open = (playwright: PlaywrightLike, seatKey: string) =>
    openBrowser(config, () => {}, { db: null, workspaceId: 'ws_cap', seatKey, headless: true, env: {}, playwright });

  afterEach(async () => {
    await closeLinkedInBrowser();
    delete process.env.TREVRA_LINKEDIN_MAX_BROWSERS;
  });

  it('closes the least recently used context rather than growing forever', async () => {
    process.env.TREVRA_LINKEDIN_MAX_BROWSERS = '2';
    const { playwright, closed } = fakePlaywright();

    await open(playwright, 'first');
    await open(playwright, 'second');
    // Touching the first one again makes the SECOND the least recently used.
    await open(playwright, 'first');
    await open(playwright, 'third');

    expect(closed).toEqual([resolveProfileDir(config.profileDir, 'ws_cap', 'second')]);
  });

  it('closes the context it just opened when anything after the launch fails', async () => {
    const { playwright, opened, closed } = fakePlaywright({ failAfterLaunch: true });

    expect(await open(playwright, 'doomed')).toBeNull();

    // Before: null was returned and the context stayed open -- a leaked
    // Chromium holding a profile lock that stranded this seat for everybody.
    expect(opened).toEqual(closed);
    expect(closed).toHaveLength(1);
  });

  it('retires a context nobody has used for a while', async () => {
    const { playwright, closed } = fakePlaywright();
    await open(playwright, 'idle');

    expect(await closeIdleBrowsers(new Date(Date.now() + 30 * 60_000))).toBe(1);
    expect(closed).toHaveLength(1);
    // And there is nothing left to retire afterwards.
    expect(await closeIdleBrowsers(new Date(Date.now() + 90 * 60_000))).toBe(0);
  });
});

/**
 * One tenant's failure must not silence every other tenant's identical one.
 */
describe('log suppression is per key and time-boxed, not per process and forever', () => {
  const NOW = new Date('2026-08-04T10:00:00.000Z');

  it('says a thing once per key, and says it again for a different key', () => {
    const first = `unready:ws_a/owner:${Math.random()}`;
    const second = `unready:ws_b/owner:${Math.random()}`;

    expect(shouldLogOnce(first, NOW)).toBe(true);
    expect(shouldLogOnce(first, NOW)).toBe(false);
    // Before: a module-level boolean, so the FIRST tenant to hit a condition
    // printed the only line anybody would ever see about it.
    expect(shouldLogOnce(second, NOW)).toBe(true);
    // And a condition still present tomorrow says so again.
    expect(shouldLogOnce(first, new Date(NOW.getTime() + 2 * 3_600_000))).toBe(true);
  });
});

/**
 * Serial was not slow, it was unfinishable: a batch is ~31 minutes, so a
 * hundred due seats is two days of work per tick. Unbounded parallelism is not
 * the fix either -- each in-flight seat is a whole Chromium.
 */
describe('bounded concurrency', () => {
  it('keeps at most `limit` in flight and still runs everything', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const done: number[] = [];
    let inFlight = 0;
    let peak = 0;

    await runBounded(items, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(item);
      inFlight -= 1;
    });

    expect(done.sort((left, right) => left - right)).toEqual(items);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('stays strictly serial at a limit of one, which is what a headed laptop needs', async () => {
    let peak = 0;
    let inFlight = 0;
    await runBounded([1, 2, 3], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });
});

/**
 * The shard is a partition or it is nothing.
 */
describe('workerShard', () => {
  it('is everything when nothing is configured', () => {
    expect(workerShard({})).toEqual({ index: 0, total: 1 });
  });

  it('refuses a value that is not a partition, rather than serving the wrong slice', () => {
    expect(() => workerShard({ TREVRA_LINKEDIN_WORKER_COUNT: '3', TREVRA_LINKEDIN_WORKER_INDEX: '3' })).toThrow(/between 0 and 2/);
    expect(() => workerShard({ TREVRA_LINKEDIN_WORKER_COUNT: '0' })).toThrow(/1 or more/);
    expect(() => workerShard({ TREVRA_LINKEDIN_WORKER_INDEX: '-1', TREVRA_LINKEDIN_WORKER_COUNT: '2' })).toThrow();
    expect(workerShard({ TREVRA_LINKEDIN_WORKER_COUNT: '4', TREVRA_LINKEDIN_WORKER_INDEX: '2' })).toEqual({ index: 2, total: 4 });
  });
});

/**
 * SITTINGS. A seat that is available to act from the minute its window opens
 * until the minute it closes has no shape to its day, and nobody uses LinkedIn
 * like that. The budget and the break are what give it one.
 */
describe('the session rhythm', () => {
  it('draws a sitting of 3-8 actions, deterministically', () => {
    for (let index = 0; index < 24; index += 1) {
      const budget = sessionActionBudget(`ws:owner:session:${index}`);
      expect(budget).toBeGreaterThanOrEqual(3);
      expect(budget).toBeLessThanOrEqual(8);
      expect(Number.isInteger(budget)).toBe(true);
    }
    expect(sessionActionBudget('same')).toBe(sessionActionBudget('same'));
    const drawn = new Set(Array.from({ length: 24 }, (_, index) => sessionActionBudget(`s${index}`)));
    expect(drawn.size).toBeGreaterThan(1);
  });

  it('draws a break of 25-90 minutes, deterministically', () => {
    for (let index = 0; index < 24; index += 1) {
      const away = sessionBreakMs(`ws:owner:session:${index}`);
      expect(away).toBeGreaterThanOrEqual(25 * 60_000);
      expect(away).toBeLessThanOrEqual(90 * 60_000);
    }
    expect(sessionBreakMs('same')).toBe(sessionBreakMs('same'));
    const drawn = new Set(Array.from({ length: 24 }, (_, index) => sessionBreakMs(`s${index}`)));
    expect(drawn.size).toBeGreaterThan(1);
  });

  it('gives consecutive sittings different lengths', () => {
    const lengths = Array.from({ length: 6 }, (_, index) => sessionActionBudget(`ws_x:owner:session:${index + 1}`));
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });
});

/**
 * ARRIVING FROM THE PAGE THE LEAD WAS FOUND ON.
 *
 * The last cold `page.goto` on the action path. A campaign works from a stored
 * list, so the browser sat on the feed and typed profile URLs -- one cold
 * document load of a stranger's profile per action, with no referer and
 * nothing in front of it. Now the sitting opens the source page once and
 * clicks each card from there.
 */
describe('reaching a target from its source page', () => {
  const SOURCE = 'https://www.linkedin.com/search/results/people/?keywords=founder';

  function navigatingPage(): { page: LinkedInPage; navigations: string[] } {
    const navigations: string[] = [];
    let current = 'https://www.linkedin.com/feed/';
    return {
      navigations,
      page: {
        goto: async (url: string) => {
          navigations.push(url);
          current = url;
          return null;
        },
        url: () => current,
        locator: () => ({
          count: async () => 0,
          first() {
            return this;
          },
          click: async () => {},
          fill: async () => {},
          textContent: async () => null
        }),
        waitForTimeout: async () => {}
      } as unknown as LinkedInPage
    };
  }

  it('opens the source page before the action, and only once for the sitting', async () => {
    const harness = fakeStore([
      action({ id: 'lact_src_1', targetRef: 'https://www.linkedin.com/in/one/' }),
      action({ id: 'lact_src_2', targetRef: 'https://www.linkedin.com/in/two/' })
    ]);
    harness.store.sourcePageFor = async () => SOURCE;
    const { driver, calls } = fakeDriver();
    const { page, navigations } = navigatingPage();

    const result = await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(result.executed).toBe(2);
    expect(calls).toHaveLength(2);
    // Loaded for the first action; the second is already there, so the whole
    // sitting costs ONE list load instead of two cold profile loads.
    expect(navigations).toEqual([SOURCE]);
  });

  it('says nothing and changes nothing when the lead has no known source', async () => {
    const harness = fakeStore([action({ id: 'lact_src_3', targetRef: 'https://www.linkedin.com/in/unsourced/' })]);
    harness.store.sourcePageFor = async () => null;
    const { driver, calls } = fakeDriver();
    const { page, navigations } = navigatingPage();

    await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(calls).toHaveLength(1);
    expect(navigations).toEqual([]);
  });

  it('never navigates off LinkedIn, whatever the source row says', async () => {
    const harness = fakeStore([action({ id: 'lact_src_4', targetRef: 'https://www.linkedin.com/in/offsite/' })]);
    harness.store.sourcePageFor = async () => 'https://example.test/leads.csv';
    const { driver, calls } = fakeDriver();
    const { page, navigations } = navigatingPage();

    await runLinkedInLocalBatch(harness.store, {
      driver,
      page,
      sleep: noSleep,
      log: () => {},
      evaluate: async () => verdict()
    });

    expect(calls).toHaveLength(1);
    expect(navigations).toEqual([]);
  });
});
