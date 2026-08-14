import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { acceptanceRate, countActionsInWindow, hasTarget, recordAction, type SeatRef } from './actions.js';
import type { LinkedInDriverResult } from './driver.js';
import type { LinkedInListPage, LinkedInWithdrawDriver, PendingInviteList } from './driver-withdraw.js';
import { LINKEDIN_LIMITS } from './limits.js';
import { OWNER_SEAT_KEY, getSeat, upsertSeat } from './seats.js';
import {
  DEFAULT_STALE_AFTER_DAYS,
  WITHDRAWN_STATUS,
  claimNextWithdrawal,
  countPendingInvites,
  enqueueWithdrawals,
  evaluateWithdrawalSafety,
  executeWithdrawal,
  markActionWithdrawn,
  runWithdrawalBatch,
  selectWithdrawalCandidates,
  sweepStaleInvites,
  syncPendingInvites,
  targetMatchKeys,
  withdrawalCeilingFor,
  withdrawalsInWindow,
  type ClaimedWithdrawal,
  type WithdrawalVerdict
} from './withdraw.js';

/**
 * THE DRIVER IS ALWAYS FAKE HERE. THE DATABASE IS ALWAYS REAL.
 *
 * No browser is launched and no LinkedIn request is made by this file, ever --
 * a suite that touched a real account would withdraw real invites, and that
 * cannot be undone. But the database is a real Postgres, because everything
 * interesting in `withdraw.ts` IS a SQL predicate: which row the age sweep
 * picks, which one the claim hands out, what the partial unique index refuses,
 * and -- the load-bearing one -- what the three predicates in `actions.ts`
 * make of the eighth status once a row carries it.
 */

let db: Db;

/** Tuesday 09:00 UTC: a business day, inside business hours, not a weekend. */
const NOW = new Date('2026-08-04T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_withdraw_test';
const SEAT: SeatRef = { workspaceId: WORKSPACE_ID, seatKey: OWNER_SEAT_KEY };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Withdraw Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_withdrawals WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

/** A steady seat, activated long enough ago to be past the warm-up ramp. */
function steadySeat() {
  return upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, new Date('2026-01-01T09:00:00.000Z'));
}

/** An invite sent `daysAgo`, in the ledger, awaiting an answer. */
async function pendingInvite(handle: string, daysAgo: number, status: 'sent' | 'exported' = 'sent'): Promise<string> {
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000);
  const { id } = await recordAction(
    db,
    { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: `https://www.linkedin.com/in/${handle}/`, status, source: 'export' },
    at
  );
  return id;
}

async function statusOf(actionId: string): Promise<string | undefined> {
  const row = await db.prepare('SELECT status FROM linkedin_actions WHERE id=?').get<{ status: string }>(actionId);
  return row?.status;
}

async function withdrawalRow(withdrawalId: string) {
  return db
    .prepare('SELECT status, claimed_at, failure_kind, detail FROM linkedin_withdrawals WHERE id=?')
    .get<{ status: string; claimed_at: string | null; failure_kind: string | null; detail: string | null }>(withdrawalId);
}

const okResult: LinkedInDriverResult = { ok: true, externalRef: 'https://www.linkedin.com/in/x/', failureKind: null };

/** Records what the caller asked the driver to do, and answers however the test says. */
function fakeDriver(answer: (target: string, index: number) => LinkedInDriverResult = () => okResult) {
  const targets: string[] = [];
  const driver: LinkedInWithdrawDriver = {
    listPendingInvites: async () => ({ ok: true, invites: [], truncated: false, degraded: [] }),
    withdrawInvite: async (_page, target) => {
      targets.push(target);
      return answer(target, targets.length - 1);
    }
  };
  return { driver, targets };
}

const page = {} as LinkedInListPage;

function list(invites: PendingInviteList['invites'], truncated = false): PendingInviteList {
  return { ok: true, invites, truncated, degraded: [] };
}

function allowed(): WithdrawalVerdict {
  return {
    allowed: true,
    reason: null,
    gate: {
      allowed: true,
      reason: null,
      checks: [],
      automationMode: 'prepare-only',
      automationReason: 'LinkedIn forbids unattended automation of its site.'
    },
    usedToday: 0,
    dailyCeiling: 18
  };
}

function refused(reason: string): WithdrawalVerdict {
  return { ...allowed(), allowed: false, reason, gate: { ...allowed().gate, allowed: false, reason } };
}

describe('targetMatchKeys', () => {
  it('covers every shape an opaque target_ref is stored in', () => {
    const keys = targetMatchKeys('https://www.linkedin.com/in/maya/');
    expect(keys).toContain('https://www.linkedin.com/in/maya/');
    expect(keys).toContain('https://linkedin.com/in/maya');
    expect(keys).toContain('in/maya');
    expect(keys).toContain('maya');
    expect(keys.every((key) => key === key.toLowerCase())).toBe(true);
  });

  it('matches nothing rather than everything for a non-profile', () => {
    expect(targetMatchKeys('https://evil.example/steal')).toEqual([]);
    expect(targetMatchKeys('')).toEqual([]);
  });
});

describe('syncPendingInvites', () => {
  it('stamps evidence on the matching ledger rows and never changes a status', async () => {
    const actionId = await pendingInvite('maya', 30);
    const result = await syncPendingInvites(
      db,
      SEAT,
      list([{ profileUrl: 'https://www.linkedin.com/in/maya/', name: 'Maya', sentAt: '2026-07-01T09:00:00.000Z' }]),
      NOW
    );

    expect(result).toMatchObject({ listed: 1, matched: 1, unmatched: 0 });
    expect(await statusOf(actionId)).toBe('sent');
    const row = await db
      .prepare('SELECT pending_seen_at, pending_since FROM linkedin_actions WHERE id=?')
      .get<{ pending_seen_at: string; pending_since: string }>(actionId);
    expect(row?.pending_seen_at).toBeTruthy();
    expect(new Date(row!.pending_since).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  it('matches a bare-handle target_ref against a canonical URL from the list', async () => {
    await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'in/Maya', status: 'sent', source: 'manual' },
      new Date(NOW.getTime() - 86_400_000)
    );
    const result = await syncPendingInvites(
      db,
      SEAT,
      list([{ profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: null }]),
      NOW
    );
    expect(result.matched).toBe(1);
  });

  it('never walks pending_since forward on a re-sync', async () => {
    // LinkedIn's label is relative and coarse ("3w"), so overwriting would make
    // a three-week-old invite look permanently three weeks old and it would
    // never age into a candidate.
    const actionId = await pendingInvite('maya', 30);
    const invite = { profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: '2026-07-01T09:00:00.000Z' };
    await syncPendingInvites(db, SEAT, list([invite]), NOW);
    await syncPendingInvites(db, SEAT, list([{ ...invite, sentAt: '2026-08-01T09:00:00.000Z' }]), NOW);

    const row = await db.prepare('SELECT pending_since FROM linkedin_actions WHERE id=?').get<{ pending_since: string }>(actionId);
    expect(new Date(row!.pending_since).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  it('reports an invite the operator sent by hand instead of inventing a ledger row', async () => {
    const result = await syncPendingInvites(
      db,
      SEAT,
      list([{ profileUrl: 'https://www.linkedin.com/in/stranger/', name: null, sentAt: null }]),
      NOW
    );
    expect(result).toMatchObject({ matched: 0, unmatched: 1 });
    const total = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(total?.total).toBe(0);
  });

  it('counts a disappearance without guessing what it was', async () => {
    // Accepted, declined, expired and withdrawn are indistinguishable from a
    // list, and the acceptance-rate throttle reads exactly those statuses.
    const actionId = await pendingInvite('maya', 30);
    await syncPendingInvites(db, SEAT, list([{ profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: null }]), NOW);

    const later = new Date(NOW.getTime() + 86_400_000);
    const result = await syncPendingInvites(db, SEAT, list([]), later);

    expect(result.disappeared).toBe(1);
    expect(await statusOf(actionId)).toBe('sent');
  });

  it('does not count a row nobody ever saw on the list as a disappearance', async () => {
    await pendingInvite('maya', 30);
    expect((await syncPendingInvites(db, SEAT, list([]), NOW)).disappeared).toBe(0);
  });

  it('passes the driver\'s truncation through', async () => {
    expect((await syncPendingInvites(db, SEAT, list([], true), NOW)).truncated).toBe(true);
  });
});

describe('countPendingInvites', () => {
  it('counts outstanding invites with no window at all', async () => {
    await pendingInvite('old', 300);
    await pendingInvite('recent', 1);
    await pendingInvite('exported-too', 40, 'exported');
    const decided = await pendingInvite('accepted', 40);
    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run(decided);

    expect(await countPendingInvites(db, SEAT)).toBe(3);
  });
});

describe('selectWithdrawalCandidates', () => {
  it('picks only invites older than the threshold, oldest first', async () => {
    const oldest = await pendingInvite('oldest', 60);
    const stale = await pendingInvite('stale', 30);
    await pendingInvite('fresh', 5);

    const candidates = await selectWithdrawalCandidates(db, SEAT, NOW);
    expect(candidates.map((candidate) => candidate.actionId)).toEqual([oldest, stale]);
    expect(candidates[0].pendingDays).toBe(60);
  });

  it('defaults to 21 days and honours an override', async () => {
    await pendingInvite('day22', DEFAULT_STALE_AFTER_DAYS + 1);
    await pendingInvite('day10', 10);

    expect(await selectWithdrawalCandidates(db, SEAT, NOW)).toHaveLength(1);
    expect(await selectWithdrawalCandidates(db, SEAT, NOW, { olderThanDays: 5 })).toHaveLength(2);
    expect(await selectWithdrawalCandidates(db, SEAT, NOW, { olderThanDays: 90 })).toHaveLength(0);
  });

  it('measures age by LinkedIn\'s clock when it has one', async () => {
    // The ledger says we recorded it yesterday; LinkedIn says the recipient got
    // it two months ago. The recipient's experience is what "stale" means.
    const actionId = await pendingInvite('imported', 1);
    await db
      .prepare('UPDATE linkedin_actions SET pending_since=?::timestamptz WHERE id=?')
      .run(new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), actionId);

    const candidates = await selectWithdrawalCandidates(db, SEAT, NOW);
    expect(candidates.map((candidate) => candidate.actionId)).toEqual([actionId]);
  });

  it('ignores invites that are no longer awaiting an answer', async () => {
    for (const status of ['accepted', 'replied', 'declined', 'skipped', WITHDRAWN_STATUS]) {
      const actionId = await pendingInvite(`x-${status}`, 40);
      await db.prepare('UPDATE linkedin_actions SET status=? WHERE id=?').run(status, actionId);
    }
    await db.prepare("UPDATE linkedin_actions SET status='planned', recorded_at=NULL WHERE target_ref LIKE '%planned%'").run();

    expect(await selectWithdrawalCandidates(db, SEAT, NOW)).toEqual([]);
  });

  it('ignores a kind that is not an invite', async () => {
    await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'dm', targetRef: 'https://www.linkedin.com/in/dm/', status: 'sent', source: 'export' },
      new Date(NOW.getTime() - 40 * 86_400_000)
    );
    expect(await selectWithdrawalCandidates(db, SEAT, NOW)).toEqual([]);
  });

  it('does not re-propose an invite that already has a live withdrawal', async () => {
    await pendingInvite('maya', 40);
    const first = await selectWithdrawalCandidates(db, SEAT, NOW);
    await enqueueWithdrawals(db, SEAT, first, NOW);

    expect(await selectWithdrawalCandidates(db, SEAT, NOW)).toEqual([]);
  });

  it('re-proposes one whose withdrawal definitely failed', async () => {
    await pendingInvite('maya', 40);
    const { ids } = await enqueueWithdrawals(db, SEAT, await selectWithdrawalCandidates(db, SEAT, NOW), NOW);
    await db.prepare("UPDATE linkedin_withdrawals SET status='failed' WHERE id=?").run(ids[0]);

    expect(await selectWithdrawalCandidates(db, SEAT, NOW)).toHaveLength(1);
  });
});

describe('enqueueWithdrawals', () => {
  it('queues one row per invite and reports a re-run as duplicates', async () => {
    await pendingInvite('a', 40);
    await pendingInvite('b', 40);
    const candidates = await selectWithdrawalCandidates(db, SEAT, NOW);

    const first = await enqueueWithdrawals(db, SEAT, candidates, NOW);
    expect(first).toMatchObject({ queued: 2, duplicates: 0 });

    // The database is what enforces this, not the sweep remembering.
    const second = await enqueueWithdrawals(db, SEAT, candidates, NOW);
    expect(second).toMatchObject({ queued: 0, duplicates: 2 });

    const total = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_withdrawals WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(total?.total).toBe(2);
  });

  it('freezes the age at enqueue time', async () => {
    await pendingInvite('maya', 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const row = await db
      .prepare('SELECT pending_days FROM linkedin_withdrawals WHERE workspace_id=? LIMIT 1')
      .get<{ pending_days: number }>(WORKSPACE_ID);
    expect(row?.pending_days).toBe(40);
  });
});

describe('sweepStaleInvites', () => {
  it('finds and queues in one call, and touches no browser', async () => {
    await pendingInvite('a', 40);
    await pendingInvite('b', 2);

    const result = await sweepStaleInvites(db, SEAT, NOW);
    expect(result.candidates).toHaveLength(1);
    expect(result.queued).toBe(1);
    expect(await statusOf(result.candidates[0].actionId)).toBe('sent');
  });
});

describe('claimNextWithdrawal', () => {
  it('hands out the oldest queued row and marks it claimed', async () => {
    await pendingInvite('older', 60);
    await pendingInvite('newer', 30);
    await sweepStaleInvites(db, SEAT, NOW);

    const first = await claimNextWithdrawal(db, SEAT, 'lbatch_1', NOW);
    expect(first?.targetRef).toBe('https://www.linkedin.com/in/older/');
    expect((await withdrawalRow(first!.id))?.claimed_at).toBeTruthy();

    const second = await claimNextWithdrawal(db, SEAT, 'lbatch_1', NOW);
    expect(second?.targetRef).toBe('https://www.linkedin.com/in/newer/');
    expect(await claimNextWithdrawal(db, SEAT, 'lbatch_1', NOW)).toBeNull();
  });

  it('never hands out a row that is already claimed', async () => {
    await pendingInvite('maya', 40);
    await sweepStaleInvites(db, SEAT, NOW);
    await claimNextWithdrawal(db, SEAT, 'lbatch_1', NOW);

    expect(await claimNextWithdrawal(db, SEAT, 'lbatch_2', NOW)).toBeNull();
  });
});

describe('markActionWithdrawn, and what the eighth status means to everything else', () => {
  it('marks the invite and refuses to overwrite one that moved on', async () => {
    const actionId = await pendingInvite('maya', 40);
    expect(await markActionWithdrawn(db, SEAT, actionId)).toBe(true);
    expect(await statusOf(actionId)).toBe(WITHDRAWN_STATUS);

    // Idempotent, and non-destructive: a second call finds nothing to change.
    expect(await markActionWithdrawn(db, SEAT, actionId)).toBe(false);

    const accepted = await pendingInvite('sam', 40);
    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run(accepted);
    expect(await markActionWithdrawn(db, SEAT, accepted)).toBe(false);
    expect(await statusOf(accepted)).toBe('accepted');
  });

  it('STILL consumes the rolling window -- withdrawing does not un-send', async () => {
    const actionId = await pendingInvite('maya', 1);
    expect(await countActionsInWindow(db, SEAT, 'invite', 24 * 7, NOW)).toBe(1);

    await markActionWithdrawn(db, SEAT, actionId);
    expect(await countActionsInWindow(db, SEAT, 'invite', 24 * 7, NOW)).toBe(1);
  });

  it('is NOT counted as a refusal by the acceptance rate', async () => {
    // Reusing 'declined' would drive the rate toward zero and trip the very
    // throttle this feature exists to clear. Nobody refused; nobody answered.
    const withdrawn = await pendingInvite('ignored', 1);
    const accepted = await pendingInvite('keen', 1);
    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run(accepted);
    await markActionWithdrawn(db, SEAT, withdrawn);

    const rate = await acceptanceRate(db, SEAT, 7, NOW);
    expect(rate).toMatchObject({ decided: 1, accepted: 1, rate: 1 });
  });

  it('keeps its claim on the target, so no campaign re-invites them', async () => {
    const actionId = await pendingInvite('maya', 40);
    await markActionWithdrawn(db, SEAT, actionId);

    expect(await hasTarget(db, SEAT, 'invite', 'https://www.linkedin.com/in/maya/')).toBe(true);
  });

  it('takes the invite out of the pending count, which is the whole point', async () => {
    const actionId = await pendingInvite('maya', 40);
    expect(await countPendingInvites(db, SEAT)).toBe(1);
    await markActionWithdrawn(db, SEAT, actionId);
    expect(await countPendingInvites(db, SEAT)).toBe(0);
  });
});

describe('evaluateWithdrawalSafety', () => {
  it('derives the daily ceiling from the seat\'s own invite band', () => {
    expect(withdrawalCeilingFor('steady')).toBe(LINKEDIN_LIMITS.invite.steady.perDay);
    expect(withdrawalCeilingFor('warmup')).toBe(LINKEDIN_LIMITS.invite.warmup.perDay);
    expect(withdrawalCeilingFor('cooldown')).toBe(LINKEDIN_LIMITS.invite.warmup.perDay);
    expect(withdrawalCeilingFor(null)).toBe(LINKEDIN_LIMITS.invite.warmup.perDay);
  });

  it('allows a withdrawal on a healthy seat', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);

    const verdict = await evaluateWithdrawalSafety(db, SEAT, { actionId, targetRef: 'https://www.linkedin.com/in/maya/' }, NOW);
    expect(verdict.allowed).toBe(true);
    expect(verdict.gate.allowed).toBe(true);
  });

  it('does not fail duplicate-target on the very invite it is withdrawing', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);

    const verdict = await evaluateWithdrawalSafety(db, SEAT, { actionId, targetRef: 'https://www.linkedin.com/in/maya/' }, NOW);
    expect(verdict.gate.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(true);
  });

  it('refuses when the seat is paused, and says which check said so', async () => {
    await steadySeat();
    await upsertSeat(db, WORKSPACE_ID, { posture: 'paused' }, NOW);
    const actionId = await pendingInvite('maya', 40);

    const verdict = await evaluateWithdrawalSafety(db, SEAT, { actionId, targetRef: 'https://www.linkedin.com/in/maya/' }, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('seat-paused');
  });

  it('refuses outside business hours, because a withdrawal is still activity', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const midnight = new Date('2026-08-04T02:00:00.000Z');

    const verdict = await evaluateWithdrawalSafety(db, SEAT, { actionId, targetRef: 'https://www.linkedin.com/in/maya/' }, midnight);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('business-hours');
  });

  it('refuses once the withdrawal ceiling is used up, which the gate cannot see', async () => {
    // A withdrawal is not logged as an invite, so `rolling-24h` never counts
    // it: four hundred of them would each pass the gate individually while
    // collectively being the surge. This second number is what stops that.
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const ceiling = LINKEDIN_LIMITS.invite.steady.perDay;
    for (let index = 0; index < ceiling; index += 1) {
      await db
        .prepare(
          `INSERT INTO linkedin_withdrawals (id, workspace_id, seat_key, action_id, target_ref, status, finished_at)
           VALUES (?,?,?,?,?, 'withdrawn', ?)`
        )
        .run(`lwd_seed_${index}`, WORKSPACE_ID, OWNER_SEAT_KEY, `seed_${index}`, `seed-${index}`, NOW.toISOString());
    }

    expect(await withdrawalsInWindow(db, SEAT, 24, NOW)).toBe(ceiling);
    const verdict = await evaluateWithdrawalSafety(db, SEAT, { actionId, targetRef: 'https://www.linkedin.com/in/maya/' }, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('withdrawal-daily-ceiling');
    expect(verdict.gate.allowed).toBe(true);
  });
});

describe('executeWithdrawal', () => {
  async function claimOne(): Promise<ClaimedWithdrawal> {
    await sweepStaleInvites(db, SEAT, NOW);
    const claimed = await claimNextWithdrawal(db, SEAT, 'lbatch_1', NOW);
    if (!claimed) throw new Error('nothing was queued');
    return claimed;
  }

  it('withdraws, marks the ledger, and settles the queue row', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver, targets } = fakeDriver();

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome).toMatchObject({ status: 'withdrawn', withdrawn: true, halt: false });
    expect(targets).toEqual(['https://www.linkedin.com/in/maya/']);
    expect(await statusOf(actionId)).toBe(WITHDRAWN_STATUS);
    expect((await withdrawalRow(claimed.id))?.status).toBe('withdrawn');
  });

  it('NEVER TOUCHES AN INVITE THE LEDGER SAYS WAS ACCEPTED', async () => {
    // Rule 3, first layer. The queue row was written before the acceptance was
    // known, and a stale queue must not produce a destructive action.
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    await db.prepare("UPDATE linkedin_actions SET status='accepted' WHERE id=?").run(actionId);
    const { driver, targets } = fakeDriver();

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome.status).toBe('stale');
    expect(targets).toEqual([]);
    expect(await statusOf(actionId)).toBe('accepted');
  });

  it('treats "no longer on the live list" as stale and leaves the ledger alone', async () => {
    // Rule 3, second layer: the driver looked, the entry was gone, and
    // accepted / declined / expired are indistinguishable from there.
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'already_connected', detail: 'no entry' }));

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome).toMatchObject({ status: 'stale', halt: false, withdrawn: false });
    expect(await statusOf(actionId)).toBe('sent');
    expect((await withdrawalRow(claimed.id))?.status).toBe('stale');
  });

  it('runs the gate before the driver, and clicks nothing when it refuses', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver, targets } = fakeDriver();

    const outcome = await executeWithdrawal(
      db,
      SEAT,
      { driver, page, evaluate: async () => refused('seat-paused: Seat is paused.') },
      claimed,
      NOW
    );

    expect(outcome).toMatchObject({ status: 'queued', blocked: true, halt: false });
    expect(targets).toEqual([]);
    expect(await statusOf(actionId)).toBe('sent');
    // Released, so a later pass can pick it up once the seat is resumed.
    const row = await withdrawalRow(claimed.id);
    expect(row?.status).toBe('queued');
    expect(row?.claimed_at).toBeNull();
  });

  it('treats a gate that could not be evaluated as a refusal, not a pass', async () => {
    await steadySeat();
    await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver, targets } = fakeDriver();

    const outcome = await executeWithdrawal(
      db,
      SEAT,
      {
        driver,
        page,
        evaluate: async () => {
          throw new Error('database went away');
        }
      },
      claimed,
      NOW
    );

    expect(outcome).toMatchObject({ blocked: true, halt: true });
    expect(targets).toEqual([]);
  });

  it('releases and halts on a limit wall, and asks for cooldown', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'limit_wall', detail: 'a wall' }));

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome).toMatchObject({ status: 'failed', halt: true, cooldown: true });
    expect(await statusOf(actionId)).toBe('sent');
    expect((await withdrawalRow(claimed.id))?.claimed_at).toBeNull();
  });

  it('halts on selector drift without touching the ledger', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'selector_drift', detail: 'no button' }));

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome).toMatchObject({ status: 'failed', halt: true, cooldown: false });
    expect(await statusOf(actionId)).toBe('sent');
  });

  it('HOLDS its claim on an unknown outcome rather than deciding either way', async () => {
    await steadySeat();
    const actionId = await pendingInvite('maya', 40);
    const claimed = await claimOne();
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'unknown', detail: 'dialog still open' }));

    const outcome = await executeWithdrawal(db, SEAT, { driver, page, evaluate: async () => allowed() }, claimed, NOW);

    expect(outcome).toMatchObject({ status: 'held', halt: true });
    expect(await statusOf(actionId)).toBe('sent');
    const row = await withdrawalRow(claimed.id);
    expect(row?.status).toBe('held');
    // The claim is the hold: nothing hands this row out again.
    expect(row?.claimed_at).toBeTruthy();
    expect(await claimNextWithdrawal(db, SEAT, 'lbatch_2', NOW)).toBeNull();
  });
});

describe('runWithdrawalBatch', () => {
  function batchDeps(overrides: Record<string, unknown> = {}) {
    const slept: number[] = [];
    const { driver, targets } = fakeDriver();
    return {
      slept,
      targets,
      deps: {
        driver,
        page,
        batchId: 'lbatch_fixed',
        evaluate: async () => allowed(),
        now: () => NOW,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        ...overrides
      }
    };
  }

  it('PACES THE QUEUE -- a gap between every withdrawal but the first', async () => {
    // Clearing 400 invites in ten minutes is the "+120% surge" half of the
    // Slide-and-Spike signature. The gap is the whole reason this loop exists.
    await steadySeat();
    for (const handle of ['a', 'b', 'c']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const { deps, slept, targets } = batchDeps();

    const result = await runWithdrawalBatch(db, SEAT, deps);

    expect(result.withdrawn).toBe(3);
    expect(targets).toHaveLength(3);
    expect(slept).toHaveLength(2);
    for (const ms of slept) {
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(120_000);
    }
  });

  it('draws the same gaps for the same batch and rows on any machine', async () => {
    // The seed is (batch id, withdrawal row id), exactly as the invite worker
    // seeds on (batch id, action id). Replaying the same pass over the same
    // rows must produce the same rhythm -- which is what makes the pacing
    // assertable rather than merely hoped for.
    await steadySeat();
    for (const handle of ['a', 'b']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const first = batchDeps();
    await runWithdrawalBatch(db, SEAT, first.deps);

    await db
      .prepare("UPDATE linkedin_withdrawals SET status='queued', claimed_at=NULL, finished_at=NULL WHERE workspace_id=?")
      .run(WORKSPACE_ID);
    await db.prepare("UPDATE linkedin_actions SET status='sent' WHERE workspace_id=?").run(WORKSPACE_ID);
    const second = batchDeps();
    await runWithdrawalBatch(db, SEAT, second.deps);

    expect(first.slept).toHaveLength(1);
    expect(first.slept).toEqual(second.slept);
  });

  it('honours its own bound on one pass', async () => {
    await steadySeat();
    for (const handle of ['a', 'b', 'c', 'd']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const { deps, targets } = batchDeps({ maxActions: 2 });

    expect((await runWithdrawalBatch(db, SEAT, deps)).withdrawn).toBe(2);
    expect(targets).toHaveLength(2);
  });

  it('refuses to open on a paused seat, and on a cooling one', async () => {
    await steadySeat();
    await pendingInvite('maya', 40);
    await sweepStaleInvites(db, SEAT, NOW);

    await upsertSeat(db, WORKSPACE_ID, { posture: 'paused' }, NOW);
    const paused = batchDeps();
    expect(await runWithdrawalBatch(db, SEAT, paused.deps)).toMatchObject({ halted: true, withdrawn: 0 });
    expect(paused.targets).toEqual([]);

    await upsertSeat(db, WORKSPACE_ID, { posture: 'cooldown' }, NOW);
    const cooling = batchDeps();
    const result = await runWithdrawalBatch(db, SEAT, cooling.deps);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toContain('cooldown');
    expect(cooling.targets).toEqual([]);
  });

  it('refuses when no seat is configured at all', async () => {
    const { deps } = batchDeps();
    expect(await runWithdrawalBatch(db, SEAT, deps)).toMatchObject({ halted: true, haltReason: expect.stringContaining('No LinkedIn seat') });
  });

  it('stops between actions when a stop is requested', async () => {
    await steadySeat();
    for (const handle of ['a', 'b']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const { deps, targets } = batchDeps({ stopRequested: async () => true });

    const result = await runWithdrawalBatch(db, SEAT, deps);
    expect(result).toMatchObject({ halted: true, withdrawn: 0 });
    expect(targets).toEqual([]);
  });

  it('puts the seat into cooldown when LinkedIn says stop, and ends the pass', async () => {
    await steadySeat();
    for (const handle of ['a', 'b']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'limit_wall', detail: 'a wall' }));
    const { deps } = batchDeps({ driver });

    const result = await runWithdrawalBatch(db, SEAT, deps);

    expect(result).toMatchObject({ halted: true, failed: 1, withdrawn: 0 });
    expect((await getSeat(db, WORKSPACE_ID))?.posture).toBe('cooldown');
  });

  it('keeps going past a stale row -- nothing was clicked, nothing is wrong', async () => {
    await steadySeat();
    for (const handle of ['a', 'b']) await pendingInvite(handle, 40);
    await sweepStaleInvites(db, SEAT, NOW);
    const { driver } = fakeDriver((_target, index) =>
      index === 0 ? { ok: false, failureKind: 'already_connected', detail: 'gone' } : okResult
    );
    const { deps } = batchDeps({ driver });

    expect(await runWithdrawalBatch(db, SEAT, deps)).toMatchObject({ stale: 1, withdrawn: 1, halted: false });
  });

  it('does nothing at all when the queue is empty', async () => {
    await steadySeat();
    const { deps, targets } = batchDeps();
    expect(await runWithdrawalBatch(db, SEAT, deps)).toMatchObject({ withdrawn: 0, halted: false });
    expect(targets).toEqual([]);
  });
});

/**
 * EVERY POSTURE READ AND EVERY COOLDOWN WRITE IS PER SEAT.
 *
 * `getSeatPosture` and `upsertSeat` both default their last argument to the
 * OWNER seat, and this module omitted it in four places. A workspace with one
 * account never noticed; a workspace with two got the two worst possible
 * behaviours at once -- a paused or cooling secondary that kept withdrawing on
 * the owner's say-so, and a limit wall on the secondary that put the OWNER into
 * cooldown, stopping the account that was behaving and leaving the restricted
 * one running.
 */
describe('a withdrawal pass is bound to its own account', () => {
  const SALES: SeatRef = { workspaceId: WORKSPACE_ID, seatKey: 'sales' };

  function batchDeps(overrides: Record<string, unknown> = {}) {
    const { driver, targets } = fakeDriver();
    return {
      targets,
      deps: {
        driver,
        page,
        batchId: 'lbatch_seat',
        evaluate: async () => allowed(),
        now: () => NOW,
        sleep: async () => {},
        ...overrides
      }
    };
  }

  async function salesInvite(handle: string, daysAgo: number): Promise<string> {
    const at = new Date(NOW.getTime() - daysAgo * 86_400_000);
    const { id } = await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, seatKey: 'sales', kind: 'invite', targetRef: `https://www.linkedin.com/in/${handle}/`, status: 'sent', source: 'export' },
      at
    );
    return id;
  }

  beforeEach(async () => {
    await steadySeat();
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales seat', timezone: 'UTC' }, new Date('2026-01-01T09:00:00.000Z'), 'sales');
  });

  it('STOPS A PAUSED SECONDARY even while the owner seat is perfectly healthy', async () => {
    await salesInvite('lead', 40);
    await sweepStaleInvites(db, SALES, NOW);
    await upsertSeat(db, WORKSPACE_ID, { posture: 'paused' }, NOW, 'sales');

    const { deps, targets } = batchDeps();
    const result = await runWithdrawalBatch(db, SALES, deps);

    expect(result).toMatchObject({ halted: true, withdrawn: 0 });
    expect(result.haltReason).toContain('paused');
    expect(targets).toEqual([]);
  });

  it('is not stopped by the OWNER seat being paused', async () => {
    await salesInvite('lead', 40);
    await sweepStaleInvites(db, SALES, NOW);
    await upsertSeat(db, WORKSPACE_ID, { posture: 'paused' }, NOW);

    // A restriction on one LinkedIn account says nothing about another, which
    // is the entire reason an operator runs more than one.
    const { deps, targets } = batchDeps();
    expect(await runWithdrawalBatch(db, SALES, deps)).toMatchObject({ halted: false, withdrawn: 1 });
    expect(targets).toHaveLength(1);
  });

  it('COOLS THE SEAT THAT HIT THE WALL, and leaves the owner alone', async () => {
    await salesInvite('lead', 40);
    await sweepStaleInvites(db, SALES, NOW);
    const { driver } = fakeDriver(() => ({ ok: false, failureKind: 'limit_wall', detail: 'a wall' }));

    const result = await runWithdrawalBatch(db, SALES, batchDeps({ driver }).deps);

    expect(result).toMatchObject({ halted: true, failed: 1, withdrawn: 0 });
    expect((await getSeat(db, WORKSPACE_ID, 'sales'))?.posture).toBe('cooldown');
    expect((await getSeat(db, WORKSPACE_ID))?.posture).not.toBe('cooldown');
  });

  it('reads its own posture for the withdrawal ceiling, not the owner\'s', async () => {
    const actionId = await salesInvite('lead', 40);
    // The owner is in cooldown; the sales seat is steady. The ceiling this
    // verdict reports must be the sales seat's.
    await upsertSeat(db, WORKSPACE_ID, { posture: 'cooldown' }, NOW);

    const verdict = await evaluateWithdrawalSafety(db, SALES, { actionId, targetRef: 'https://www.linkedin.com/in/lead/' }, NOW);
    expect(verdict.dailyCeiling).toBe(withdrawalCeilingFor('steady'));
  });
});

/**
 * THE BATCHED SYNC AND THE BATCHED ENQUEUE, ASSERTED AGAINST THE LOOPS THEY
 * REPLACED.
 *
 * `syncPendingInvites` ran one UPDATE per listed invite -- up to 500 per seat
 * per sync -- and `enqueueWithdrawals` ran one INSERT per candidate. Both are
 * now single statements. These pin the counting rules, because a count is
 * exactly what a set-based rewrite is most likely to change: the old loop
 * counted PER LIST ENTRY (`updated.changes > 0`), and a naive
 * `UPDATE ... FROM unnest` would count per ROW instead.
 */
describe('the batched pending-invite sync', () => {
  it('counts one match per list entry when two entries name the same person', async () => {
    // LinkedIn occasionally lists a profile twice. The loop matched on both
    // entries -- the second UPDATE hit the same row and still reported a
    // change -- and the batched form has to agree, which is why the match set
    // is computed per ENTRY and the rows are updated once each.
    const actionId = await pendingInvite('maya', 30);
    const entry = { profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: '2026-07-01T09:00:00.000Z' };
    const result = await syncPendingInvites(db, SEAT, list([entry, entry]), NOW);

    expect(result).toMatchObject({ listed: 2, matched: 2, unmatched: 0 });
    const row = await db
      .prepare('SELECT pending_since FROM linkedin_actions WHERE id=?')
      .get<{ pending_since: string }>(actionId);
    expect(new Date(row!.pending_since).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  it('takes the earliest entry\'s sentAt when two entries reach the same row', async () => {
    // The loop's COALESCE meant the FIRST entry set `pending_since` and every
    // later one was a no-op. DISTINCT ON ... ORDER BY entry reproduces that.
    const actionId = await pendingInvite('maya', 30);
    const result = await syncPendingInvites(
      db,
      SEAT,
      list([
        { profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: '2026-07-01T09:00:00.000Z' },
        { profileUrl: 'https://www.linkedin.com/in/maya', name: null, sentAt: '2026-07-20T09:00:00.000Z' }
      ]),
      NOW
    );
    expect(result.matched).toBe(2);
    const row = await db
      .prepare('SELECT pending_since FROM linkedin_actions WHERE id=?')
      .get<{ pending_since: string }>(actionId);
    expect(new Date(row!.pending_since).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  it('separates matched from unmatched across a mixed page, and stamps every match', async () => {
    const maya = await pendingInvite('maya', 30);
    const jonas = await pendingInvite('jonas', 25);
    const result = await syncPendingInvites(
      db,
      SEAT,
      list([
        { profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: null },
        { profileUrl: 'https://www.linkedin.com/in/stranger/', name: null, sentAt: null },
        { profileUrl: 'https://www.linkedin.com/in/jonas/', name: null, sentAt: null },
        // Not a LinkedIn profile at all: `targetMatchKeys` returns nothing, so
        // it can match nothing and is unmatched before any SQL runs.
        { profileUrl: 'https://evil.example/steal', name: null, sentAt: null }
      ]),
      NOW
    );

    expect(result).toMatchObject({ listed: 4, matched: 2, unmatched: 2 });
    const stamped = await db
      .prepare('SELECT id FROM linkedin_actions WHERE workspace_id=? AND pending_seen_at IS NOT NULL ORDER BY id')
      .all<{ id: string }>(WORKSPACE_ID);
    expect(stamped.map((row) => row.id).sort()).toEqual([maya, jonas].sort());
  });

  it('still reports a disappearance only for rows it did not see THIS sync', async () => {
    // The `disappeared` count reads `pending_seen_at < now`, so folding it into
    // the same statement as the UPDATE would make it see the pre-update
    // snapshot and report every invite LinkedIn had just shown us as gone.
    const seen = await pendingInvite('maya', 30);
    const unseen = await pendingInvite('jonas', 30);
    await syncPendingInvites(
      db,
      SEAT,
      list([
        { profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: null },
        { profileUrl: 'https://www.linkedin.com/in/jonas/', name: null, sentAt: null }
      ]),
      NOW
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const result = await syncPendingInvites(db, SEAT, list([{ profileUrl: 'https://www.linkedin.com/in/maya/', name: null, sentAt: null }]), later);
    expect(result).toMatchObject({ matched: 1, disappeared: 1 });
    expect(await statusOf(seen)).toBe('sent');
    expect(await statusOf(unseen)).toBe('sent');
  });

  it('touches nothing and reports nothing for an empty list', async () => {
    await pendingInvite('maya', 30);
    const result = await syncPendingInvites(db, SEAT, list([]), NOW);
    expect(result).toMatchObject({ listed: 0, matched: 0, unmatched: 0, disappeared: 0 });
  });
});

describe('the batched withdrawal enqueue', () => {
  it('queues every candidate in one statement and reports the ids in candidate order', async () => {
    const ids = [
      await pendingInvite('one', 30),
      await pendingInvite('two', 30),
      await pendingInvite('three', 30)
    ];
    const candidates = await selectWithdrawalCandidates(db, SEAT, NOW);
    expect(candidates).toHaveLength(3);

    const result = await enqueueWithdrawals(db, SEAT, candidates, NOW);
    expect(result).toMatchObject({ queued: 3, duplicates: 0 });
    expect(result.ids).toHaveLength(3);

    const rows = await db
      .prepare('SELECT action_id FROM linkedin_withdrawals WHERE workspace_id=? ORDER BY action_id')
      .all<{ action_id: string }>(WORKSPACE_ID);
    expect(rows.map((row) => row.action_id).sort()).toEqual([...ids].sort());
  });

  it('reports a re-run as duplicates rather than throwing, exactly as the loop did', async () => {
    await pendingInvite('one', 30);
    await pendingInvite('two', 30);
    const candidates = await selectWithdrawalCandidates(db, SEAT, NOW);

    expect(await enqueueWithdrawals(db, SEAT, candidates, NOW)).toMatchObject({ queued: 2, duplicates: 0 });
    // The partial unique index does the enforcing; a losing insert is a no-op.
    expect(await enqueueWithdrawals(db, SEAT, candidates, NOW)).toMatchObject({ queued: 0, duplicates: 2 });
  });

  it('handles one invite named twice inside a SINGLE batch', async () => {
    // ON CONFLICT DO NOTHING tolerates an intra-statement collision where a DO
    // UPDATE would raise; this is the case a multi-row insert introduces and
    // the loop could not have.
    await pendingInvite('one', 30);
    const [candidate] = await selectWithdrawalCandidates(db, SEAT, NOW);
    const result = await enqueueWithdrawals(db, SEAT, [candidate, candidate], NOW);
    expect(result).toMatchObject({ queued: 1, duplicates: 1 });
  });

  it('is a no-op for an empty candidate list', async () => {
    expect(await enqueueWithdrawals(db, SEAT, [], NOW)).toEqual({ queued: 0, duplicates: 0, ids: [] });
  });
});
