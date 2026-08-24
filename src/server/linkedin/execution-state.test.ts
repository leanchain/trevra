import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { campaignExecutionState } from './execution-state.js';
import { setSeatRestingUntil } from './seat-events.js';
import { upsertSeat } from './seats.js';

/**
 * THE THREE FACTS THE CAMPAIGN SCREEN COULD NOT SEE.
 *
 * Every case here is drawn from a live workspace whose banner read "Waiting for
 * browser worker: 20 planned action(s) have reached their scheduled time" while
 * the paired computer was online and the browser was opening fine. The real
 * answers were a seat inside its autonomous cooldown, a safety gate refusing on
 * `day-over-day-delta`, and five invites parked on an outcome nobody could read
 * back -- none of which the browser can find out for itself, and two of which
 * were being counted as work waiting for a browser.
 */

let db: Db;

const WORKSPACE = 'ws_linkedin_execution_state_test';
const SEAT = 'owner';
const CAMPAIGN = 'lcmp_execution_state';
// A Monday, 13:00 in Europe/Zurich: inside the seat's working days and hours,
// so neither the weekend nor the business-hours check can be what refuses.
const NOW = new Date('2026-08-24T11:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Execution State Test', NOW.toISOString());
  for (const table of ['linkedin_actions', 'linkedin_campaigns', 'linkedin_seats'])
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE);
  // Activated in January and read in August: an established seat, so the
  // account warm-up ramp is finished and cannot be what binds below.
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Pankaj', timezone: 'Europe/Zurich' },
    new Date('2026-01-01T09:00:00.000Z')
  );
});

afterEach(async () => {
  await db?.close();
});

async function insertAction(input: {
  id: string;
  kind: string;
  handle: string;
  status?: string;
  plannedFor?: Date | null;
  recordedAt?: Date | null;
  claimedAt?: Date | null;
  settlementHoldAt?: Date | null;
  campaignId?: string | null;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,recorded_at,
          claimed_at,settlement_hold_at,failure_kind,source,replay_scope,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      WORKSPACE,
      SEAT,
      input.kind,
      `https://www.linkedin.com/in/${input.handle}/`,
      input.campaignId === undefined ? CAMPAIGN : input.campaignId,
      input.status ?? 'planned',
      input.plannedFor === undefined
        ? NOW.toISOString()
        : (input.plannedFor?.toISOString() ?? null),
      input.recordedAt?.toISOString() ?? null,
      input.claimedAt?.toISOString() ?? null,
      input.settlementHoldAt?.toISOString() ?? null,
      input.settlementHoldAt ? 'unknown' : null,
      'campaign',
      `${input.id}:${input.kind}`,
      NOW.toISOString()
    );
}

describe('campaign execution state', () => {
  it('counts only the rows a browser could actually claim', async () => {
    for (const handle of ['a', 'b', 'c'])
      await insertAction({ id: `lact_due_${handle}`, kind: 'profile_view', handle });
    // Parked on an unknown outcome: claimed, unreadable, and never claimable
    // again -- the reaper's predicate is `settlement_hold_at IS NULL`.
    for (const handle of ['d', 'e'])
      await insertAction({
        id: `lact_parked_${handle}`,
        kind: 'invite',
        handle,
        settlementHoldAt: new Date(NOW.getTime() - 3_600_000)
      });
    await insertAction({
      id: 'lact_future',
      kind: 'profile_view',
      handle: 'f',
      plannedFor: new Date(NOW.getTime() + 3_600_000)
    });

    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.dueNow).toBe(3);
    expect(state.awaitingResolution).toBe(2);
    expect(state.awaitingResolutionKind).toBe('invite');
  });

  it('names the seat the next due action belongs to, and its timezone', async () => {
    await insertAction({ id: 'lact_due_a', kind: 'profile_view', handle: 'a' });
    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.seatKey).toBe(SEAT);
    expect(state.seatLabel).toBe('Pankaj');
    expect(state.timezone).toBe('Europe/Zurich');
  });

  it('reports the autonomous cooldown only while it is still running', async () => {
    await insertAction({ id: 'lact_due_a', kind: 'profile_view', handle: 'a' });

    await setSeatRestingUntil(db, WORKSPACE, SEAT, new Date('2026-08-24T11:52:09.000Z'));
    expect((await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW)).restingUntil).toBe(
      '2026-08-24T11:52:09.000Z'
    );

    // The column keeps its last value after the seat wakes up, so a break that
    // has already ended must not be reported as one.
    const after = new Date('2026-08-24T12:30:00.000Z');
    expect((await campaignExecutionState(db, WORKSPACE, CAMPAIGN, after)).restingUntil).toBeNull();
  });

  it('asks the safety gate about the next claimable action and names the binding check', async () => {
    // One profile view already recorded today against a previous business day
    // that carried none: the day-over-day clamp permits exactly one more than
    // nothing, so the next one is refused.
    await insertAction({
      id: 'lact_sent',
      kind: 'profile_view',
      handle: 'sent',
      status: 'sent',
      plannedFor: null,
      recordedAt: new Date(NOW.getTime() - 3_600_000)
    });
    await insertAction({ id: 'lact_due_a', kind: 'profile_view', handle: 'a' });

    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.gate?.kind).toBe('profile_view');
    expect(state.gate?.allowed).toBe(false);
    expect(state.gate?.check).toBe('day-over-day-delta');
    expect(state.gate?.detail).toContain("so today's ceiling is 1");
  });

  it('does not let the row under evaluation refuse itself as a duplicate', async () => {
    // The action being previewed is in the ledger. Without the primary-key
    // exclusion the worker uses, `duplicate-target` finds it and every queue
    // reads as blocked by its own contents.
    await insertAction({ id: 'lact_due_a', kind: 'invite', handle: 'a' });
    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.gate?.allowed).toBe(true);
    expect(state.gate?.check).toBeNull();
  });

  it('never asks the gate about a row parked on an unresolved outcome', async () => {
    await insertAction({
      id: 'lact_parked',
      kind: 'invite',
      handle: 'd',
      settlementHoldAt: new Date(NOW.getTime() - 3_600_000)
    });
    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.dueNow).toBe(0);
    expect(state.awaitingResolution).toBe(1);
    // Nothing is claimable, so there is no next action to have a verdict about.
    expect(state.gate).toBeNull();
  });

  it('never asks the gate about a message with no approved body', async () => {
    // The worker will not claim it either -- "executes approved bytes only" --
    // so reporting the gate's opinion of it would explain the wrong row.
    await insertAction({ id: 'lact_dm', kind: 'dm', handle: 'a' });
    const state = await campaignExecutionState(db, WORKSPACE, CAMPAIGN, NOW);
    expect(state.dueNow).toBe(1);
    expect(state.gate).toBeNull();
  });
});
