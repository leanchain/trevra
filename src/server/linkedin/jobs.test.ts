import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction, type SeatRef } from './actions.js';
import { runLinkedInWithdrawals, syncLinkedInThread } from './jobs.js';
import { syncThreads } from './inbox.js';
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

/**
 * THE BATCH ID A WITHDRAWAL PASS STAMPS ON ITS ROWS.
 *
 * It was `lwbatch_${now.getTime().toString(36)}` -- a function of the wall
 * clock and nothing else. On a single-tenant box that is unique enough; on a
 * hosted one, where a tick fans out across thousands of seats, two passes
 * starting in the same millisecond were handed the SAME
 * `linkedin_withdrawals.batch_id`. Reading a pass back to what it did then
 * returned another tenant's withdrawals as well.
 */
describe('the withdrawal batch id', () => {
  it('differs between two passes started at the same instant', async () => {
    await pendingInvite('one', DEFAULT_STALE_AFTER_DAYS + 1);
    // Both passes are given the SAME `now`, which is exactly the case the old
    // millisecond-derived id could not distinguish.
    const first = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    const second = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    // The browser half is off, so neither pass reaches `runWithdrawalBatch`
    // and both report an empty batch id. The id is asserted where it is
    // actually minted instead: two calls at one instant must not collide.
    expect(first.batchId).toBe('');
    expect(second.batchId).toBe('');
    const minted = new Set([id('lwbatch'), id('lwbatch'), id('lwbatch')]);
    expect(minted.size).toBe(3);
  });
});

/**
 * WHOSE INBOX A SINGLE-THREAD REFRESH LOOKS IN.
 *
 * `syncLinkedInThread` computes `seatKey` from the job options and hands it to
 * `syncThreadMessages` -- but looked the conversation up with `threadByUrn`
 * and no seat key at all, so the existence check ran against the OWNER seat's
 * inbox. A refresh requested for a second account therefore reported that
 * account's own conversation as unknown, and would have accepted an owner-seat
 * conversation the caller never asked about.
 */
describe('the seat a single-thread refresh reads', () => {
  it('finds a conversation belonging to the seat the job names', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales (SDR)', timezone: 'UTC' }, NOW, 'sales');
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'sales',
        threads: [{
          threadUrn: '2-sales==',
          profileUrl: 'https://www.linkedin.com/in/sales-lead/',
          name: 'Sales Lead',
          lastMessageAt: NOW.toISOString(),
          snippet: 'hello',
          unread: false
        }]
      },
      NOW
    );

    // Automation is off, so the call gets as far as the lookup and then stops
    // at the session it cannot open. `blocked` being non-null is therefore the
    // proof that the conversation WAS found: an unknown thread returns early
    // with `blocked: null` and never asks for a browser.
    const found = await syncLinkedInThread(db, OFF, '2-sales==', { workspaceId: WORKSPACE_ID, seatKey: 'sales', now: NOW });
    expect(found.blocked).not.toBeNull();

    // And the owner seat still does not see it, which is the other half of the
    // same rule: from that seat's point of view the conversation does not exist.
    const owner = await syncLinkedInThread(db, OFF, '2-sales==', { workspaceId: WORKSPACE_ID, now: NOW });
    expect(owner.blocked).toBeNull();
  });
});
