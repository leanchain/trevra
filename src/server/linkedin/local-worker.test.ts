import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import { SELECTORS, type LinkedInDriver, type LinkedInDriverResult, type LinkedInPage, type LinkedInSeatRead } from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyCheck, type LinkedInSafetyVerdict } from './guard.js';
import { ACTION_GAP_SECONDS } from './limits.js';
import { getSeat, upsertSeat, type SeatPosture } from './seats.js';
import {
  actionGapSeconds,
  detectLinkedInSeat,
  humanCadencePage,
  latestSeatDetectRequest,
  linkedInBrowserReadiness,
  linkedInOffReason,
  postgresLocalWorkerStore,
  requestSeatDetect,
  resolveProfileDir,
  resolveSeatProxy,
  runDueLinkedInActions,
  runLinkedInLocalBatch,
  runPendingSeatDetectRequests,
  seatContextFingerprint,
  seatsWithDueActions,
  stopLinkedInBatches,
  type BranchGateDecision,
  type DueLinkedInAction,
  type LocalWorkerStore
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
  const equipped = { PLAYWRIGHT_BROWSERS_PATH: registry, DISPLAY: ':0' } as NodeJS.ProcessEnv;

  it('refuses before anything else when the deployment says no', () => {
    const hosted = linkedInBrowserReadiness({ enabled: false, hosted: true }, { env: equipped, platform: 'linux' });
    expect(hosted.canLaunchHeaded).toBe(false);
    expect(hosted.reasons).toEqual(['This deployment is hosted, so LinkedIn automation is off and cannot be enabled.']);

    const off = linkedInBrowserReadiness({ enabled: false }, { env: equipped, platform: 'linux' });
    expect(off.reasons).toEqual(['LinkedIn automation is switched off on this server.']);
  });

  it.skipIf(!playwrightInstalled)('says yes on a host with a display and an installed browser', () => {
    const ready = linkedInBrowserReadiness({ enabled: true }, { env: equipped, platform: 'linux' });
    expect(ready).toEqual({ canLaunchHeaded: true, reasons: [] });

    // Wayland counts too; the question is whether anything can be drawn.
    expect(
      linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: registry, WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })
        .canLaunchHeaded
    ).toBe(true);
  });

  it.skipIf(!playwrightInstalled)('treats a missing display on linux as decisive', () => {
    const blind = linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: registry }, platform: 'linux' });
    expect(blind.canLaunchHeaded).toBe(false);
    expect(blind.reasons.some((reason) => reason.includes('No display'))).toBe(true);
  });

  it('names the install command when the browser registry is not there', () => {
    const bare = linkedInBrowserReadiness({ enabled: true }, { env: { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent/ms-playwright', DISPLAY: ':0' }, platform: 'linux' });
    expect(bare.canLaunchHeaded).toBe(false);
    expect(bare.reasons.join(' ')).toContain('npx playwright install chromium');
  });

  it('FAILS CLOSED, and every reason is one sentence an operator can act on', () => {
    const blocked = linkedInBrowserReadiness({ enabled: true }, { env: {}, platform: 'linux' });
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
          { excludeActionId: candidate.id }
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
      TREVRA_LINKEDIN_PROXY_WS_A_SALES: 'http://exact.example:3128'
    } as NodeJS.ProcessEnv;

    expect(resolveSeatProxy(env, 'ws_a', 'sales')?.server).toBe('http://exact.example:3128');
    expect(resolveSeatProxy(env, 'ws_b', 'sales')?.server).toBe('http://seat.example:3128');
    expect(resolveSeatProxy(env, 'ws_b', 'owner')).toEqual({
      server: 'http://shared.example:8080',
      username: 'everyone',
      password: 'pw'
    });
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
      INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,source,replay_scope,override_warmup_ceiling,body,thread_urn,created_at)
      VALUES (?,?,'owner','reply',?,?,'planned',?,'manual',?,true,?,?,?)
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
