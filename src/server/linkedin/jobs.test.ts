import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type SeatRef } from './actions.js';
import { runLinkedInWithdrawals } from './jobs.js';
import { upsertSeat } from './seats.js';
import { DEFAULT_STALE_AFTER_DAYS } from './withdraw.js';

/**
 * THE UNATTENDED SWEEP, AND WHOSE NUMBER IT USES.
 *
 * Nothing here opens a browser: `runLinkedInWithdrawals` runs the SWEEP first
 * and the browser pass second, and the sweep is pure database work. Calling it
 * with automation switched off exercises exactly the half that decides which
 * invites get queued for withdrawal -- which is the half that was wrong -- and
 * stops at the session it cannot open.
 *
 * The defect: `DEFAULT_STALE_AFTER_DAYS` is 21, the unattended pass named no
 * `olderThanDays` at all, and so every pending invite in the workspace was
 * withdrawn at 21 days -- including the ones belonging to a campaign whose
 * workflow says, in a field the operator typed a number into, to wait 30. The
 * workflow's `withdraw_pending` step was honoured on the runner's own path and
 * overruled behind its back here.
 */

let db: Db;

/** Tuesday 09:00 UTC. */
const NOW = new Date('2026-08-04T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_jobs_test';
const SEAT: SeatRef = { workspaceId: WORKSPACE_ID, seatKey: 'owner' };
/** Automation off: the sweep still runs, the browser half stops with a sentence. */
const OFF = { enabled: false } as const;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(WORKSPACE_ID, 'LinkedIn jobs test', NOW.toISOString());
  await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, new Date('2026-01-01T09:00:00.000Z'));
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
});

/** An invite this seat sent `daysAgo` and nobody has answered. */
async function pendingInvite(handle: string, daysAgo: number): Promise<string> {
  const { id } = await recordAction(
    db,
    { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: `https://www.linkedin.com/in/${handle}/`, status: 'sent', source: 'export' },
    new Date(NOW.getTime() - daysAgo * 86_400_000)
  );
  return id;
}

/**
 * A managed campaign whose workflow withdraws after `afterDays`, with one
 * member, and that member's pending invite.
 *
 * Written as raw rows rather than through the manager's own API because the
 * only thing under test is the JOIN the sweep makes: action -> member ->
 * campaign -> workflow -> the step's configured number.
 */
async function managedInvite(handle: string, daysAgo: number, afterDays: number | null): Promise<string> {
  const suffix = handle;
  const steps = [
    { id: 'step-1', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: null } },
    ...(afterDays === null
      ? []
      : [{ id: 'step-2', action: 'withdraw_pending', delayBefore: { amount: 0, unit: 'hours' }, config: { afterDays } }])
  ];
  const iso = NOW.toISOString();
  await db.prepare('INSERT INTO linkedin_lead_lists (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(`lilist_${suffix}`, WORKSPACE_ID, `List ${suffix}`, iso, iso);
  await db.prepare(`
    INSERT INTO linkedin_lead_contacts (id,workspace_id,list_id,first_name,last_name,company,profile_url,dedupe_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(`lilc_${suffix}`, WORKSPACE_ID, `lilist_${suffix}`, 'Lead', suffix, 'Acme', `https://www.linkedin.com/in/${handle}/`, suffix, iso, iso);
  await db.prepare('INSERT INTO linkedin_workflows (id,workspace_id,name,steps_json,version,created_at,updated_at) VALUES (?,?,?,?::jsonb,1,?,?)')
    .run(`liwf_${suffix}`, WORKSPACE_ID, `Workflow ${suffix}`, JSON.stringify(steps), iso, iso);
  await db.prepare(`
    INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,lead_list_id,workflow_id,started_at,created_at,updated_at)
    VALUES (?,?,?,'running',?::jsonb,'owner',?,?,?,?,?)
  `).run(
    `licmp_${suffix}`, WORKSPACE_ID, `Campaign ${suffix}`, JSON.stringify({ manager: true, steps }),
    `lilist_${suffix}`, `liwf_${suffix}`, iso, iso, iso
  );
  await db.prepare(`
    INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,created_at,updated_at)
    VALUES (?,?,?,?,'active',1,?,?)
  `).run(`limem_${suffix}`, WORKSPACE_ID, `licmp_${suffix}`, `lilc_${suffix}`, iso, iso);

  const actionId = await pendingInvite(handle, daysAgo);
  await db.prepare('UPDATE linkedin_actions SET campaign_id=?, campaign_member_id=?, workflow_step_id=? WHERE id=?')
    .run(`licmp_${suffix}`, `limem_${suffix}`, 'step-1', actionId);
  return actionId;
}

async function queuedWithdrawals(): Promise<string[]> {
  const rows = await db.prepare('SELECT action_id FROM linkedin_withdrawals WHERE workspace_id=? ORDER BY action_id')
    .all<{ action_id: string }>(WORKSPACE_ID);
  return rows.map((row) => row.action_id);
}

describe('the unattended withdrawal sweep', () => {
  it('WAITS THE WORKFLOW\'S 30 DAYS instead of the account default 21', async () => {
    const managed = await managedInvite('managed', 25, 30);
    const loose = await pendingInvite('loose', 25);

    const result = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    // The browser half never ran; the sweep half did, and its numbers are real.
    expect(result.blockedReason).toBeTruthy();
    expect(await queuedWithdrawals()).toEqual([loose]);
    expect(await queuedWithdrawals()).not.toContain(managed);
    expect(result.queued).toBe(1);
  });

  it('withdraws the managed invite once its own deadline has passed', async () => {
    const managed = await managedInvite('managed', 31, 30);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('honours a SHORTER workflow deadline than the account default too', async () => {
    // The rule is "the workflow's number", not "the more lenient number".
    const managed = await managedInvite('managed', 10, 7);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('falls back to the default for a campaign whose workflow has no withdraw step', async () => {
    // Nothing was declared, so nothing is being overruled: the account default
    // applies exactly as it did before.
    const managed = await managedInvite('nowithdraw', 25, null);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('leaves the account default doing exactly what it did for unmanaged invites', async () => {
    const fresh = await pendingInvite('fresh', DEFAULT_STALE_AFTER_DAYS - 1);
    const stale = await pendingInvite('stale', DEFAULT_STALE_AFTER_DAYS + 1);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    const queued = await queuedWithdrawals();
    expect(queued).toContain(stale);
    expect(queued).not.toContain(fresh);
  });

  it('keeps `limit` a budget across the whole sweep, not one per partition', async () => {
    await managedInvite('managed', 40, 7);
    await pendingInvite('loose', 40);

    const result = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW, limit: 1 });

    expect(result.candidates).toBe(1);
    expect(await queuedWithdrawals()).toHaveLength(1);
  });

  it('is a no-op on a seat with nothing pending', async () => {
    const result = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    expect(result.candidates).toBe(0);
    expect(await queuedWithdrawals()).toEqual([]);
    expect(SEAT.seatKey).toBe('owner');
  });
});
