import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import type { LinkedInDriver, LinkedInDriverResult, LinkedInPage, LinkedInSeatRead } from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyCheck, type LinkedInSafetyVerdict } from './guard.js';
import { ACTION_GAP_SECONDS } from './limits.js';
import { getSeat, upsertSeat, type SeatPosture } from './seats.js';
import {
  actionGapSeconds,
  detectLinkedInSeat,
  latestSeatDetectRequest,
  linkedInBrowserReadiness,
  linkedInOffReason,
  requestSeatDetect,
  resolveProfileDir,
  runDueLinkedInActions,
  runLinkedInLocalBatch,
  runPendingSeatDetectRequests,
  type BranchGateDecision,
  type DueLinkedInAction,
  type LocalWorkerStore
} from './local-worker.js';

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
  } = {}
): StoreHarness {
  const queue = [...actions];
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
      },
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
    // Nothing was sent, so the claim is released -- but the two untouched
    // actions were never even claimed.
    expect(harness.released).toEqual([{ id: 'lact_1', failureKind: 'limit_wall' }]);
    expect(harness.remaining()).toBe(2);
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

  it('defaults the profile directory under the operator home, not the repo', () => {
    expect(resolveProfileDir()).toMatch(/\.trevra\/linkedin-profile$/);
    expect(resolveProfileDir('  ')).toMatch(/\.trevra\/linkedin-profile$/);
    expect(resolveProfileDir('/opt/profiles/linkedin')).toBe('/opt/profiles/linkedin');
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
      // claimed row excluded. Not the `gtm.linkedin-guard` skill, which does
      // not expose the exclusion at all.
      evaluate: async (candidate, at) => {
        const verdict = await evaluateLinkedInSafety(
          db,
          { ...input, targetRef: candidate.targetRef, plannedFor: candidate.plannedFor },
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
