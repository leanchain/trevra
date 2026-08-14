import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ACTION_STATUS_VALUES, recordAction, type LinkedInActionStatus } from './actions.js';
import {
  createCampaign,
  getCampaign,
  linkedinAnalytics,
  newCampaignId,
  skipAction,
  stopCampaign,
  type CampaignStatus
} from './campaigns.js';
import type { ManagedCampaignStatus } from './managed-campaigns.js';
import { upsertSeat } from './seats.js';

/**
 * WHAT A PAUSE LEAVES BEHIND, AND WHETHER ANYONE CAN SEE IT.
 *
 * Migration 051 gave the ledger a ninth status, 'held', and everything in this
 * file is about the three places that never learned the word: the legacy stop
 * path, the skip gate, and the analytics funnel. Each of them was silent --
 * no error, no log, nothing on a screen -- which is why they are pinned with
 * tests rather than trusted to a comment.
 *
 * Real ephemeral Postgres, per the repo's harness: every assertion below IS a
 * query, and a stub would prove nothing about the SQL that ships.
 */
let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE = 'ws_linkedin_campaigns_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE, 'LinkedIn Campaigns Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(WORKSPACE);
  // No seat by default: the series then falls back to UTC, which is what the
  // window and funnel tests above assume.
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE);
});

afterEach(async () => {
  await db?.close();
});

async function campaign(name: string, status: 'draft' | 'running' = 'running'): Promise<string> {
  const campaignId = newCampaignId();
  await createCampaign(db, { id: campaignId, workspaceId: WORKSPACE, name, status }, NOW);
  return campaignId;
}

let actionSeq = 0;
async function action(campaignId: string | null, status: LinkedInActionStatus, at: Date = NOW): Promise<string> {
  actionSeq += 1;
  const written = await recordAction(
    db,
    {
      workspaceId: WORKSPACE,
      kind: 'invite',
      targetRef: `https://www.linkedin.com/in/target-${actionSeq}/`,
      campaignId,
      status,
      source: 'campaign',
      plannedFor: at.toISOString()
    },
    at
  );
  return written.id;
}

/** Exactly what `pauseManagedCampaign` does to a scheduled, unclaimed row. */
async function park(actionId: string): Promise<void> {
  await db.prepare("UPDATE linkedin_actions SET status='held' WHERE workspace_id=? AND id=?").run(WORKSPACE, actionId);
}

async function statusOf(actionId: string): Promise<string> {
  const row = await db.prepare('SELECT status FROM linkedin_actions WHERE workspace_id=? AND id=?')
    .get<{ status: string }>(WORKSPACE, actionId);
  if (!row) throw new Error(`no action ${actionId}`);
  return row.status;
}

describe('stopping a campaign that was paused', () => {
  /**
   * The failure this pins is not "a row has the wrong status". A held row that
   * survives a stop is unclaimable (the worker claims 'planned'), unrestorable
   * (a stopped campaign refuses to start) and unskippable, while still holding
   * the target inside `idx_linkedin_actions_target` -- so the person it names
   * can never be approached by that seat again, by any campaign, forever.
   */
  it('releases the rows a pause parked, not only the planned ones', async () => {
    const campaignId = await campaign('Paused then stopped');
    const planned = await action(campaignId, 'planned');
    const parked = await action(campaignId, 'planned');
    await park(parked);

    const result = await stopCampaign(db, WORKSPACE, campaignId, NOW);

    expect(result?.released).toBe(2);
    expect(await statusOf(planned)).toBe('skipped');
    expect(await statusOf(parked)).toBe('skipped');
  });

  it('still leaves a claimed row to the worker holding it', async () => {
    const campaignId = await campaign('Mid-send');
    const claimed = await action(campaignId, 'planned');
    await park(claimed);
    await db.prepare('UPDATE linkedin_actions SET claimed_at=? WHERE workspace_id=? AND id=?')
      .run(NOW.toISOString(), WORKSPACE, claimed);

    expect((await stopCampaign(db, WORKSPACE, campaignId, NOW))?.released).toBe(0);
    expect(await statusOf(claimed)).toBe('held');
  });
});

describe('skipping a held action', () => {
  /**
   * The 409 this removes said "this action has already gone out". Of a held
   * row that was never claimed and never sent, that sentence was false, and it
   * left an operator unable to drop one person out of a paused campaign.
   */
  it('is allowed, because a held row has not left the building', async () => {
    const campaignId = await campaign('Pausable');
    const parked = await action(campaignId, 'planned');
    await park(parked);

    const view = await skipAction(db, WORKSPACE, parked, NOW);

    expect(view.status).toBe('skipped');
    expect(view.recordedAt).toBeNull();
  });

  it('is still refused for anything that did leave', async () => {
    const campaignId = await campaign('Already sent');
    const sent = await action(campaignId, 'sent');
    await expect(skipAction(db, WORKSPACE, sent, NOW)).rejects.toThrow(/cannot be skipped/);
  });
});

describe('the analytics funnel', () => {
  /**
   * Before this column existed, pausing a campaign did not move its numbers,
   * it DELETED them: forty scheduled invites reported as zero of everything
   * while the rows sat untouched in the ledger, and "0 planned" reads as
   * "finished".
   *
   * DRIVEN OFF `ACTION_STATUS_VALUES` RATHER THAN A LIST TYPED OUT HERE, which
   * is the point of publishing the vocabulary as values: this test is
   * automatically exhaustive over whatever the ledger can hold, so a tenth
   * status added to actions.ts without a funnel column fails here instead of
   * waiting to be noticed on a screen.
   */
  it('counts held, and its columns still partition every status the ledger publishes', async () => {
    const campaignId = await campaign('Every status');
    for (const status of ACTION_STATUS_VALUES) await action(campaignId, status);

    const analytics = await linkedinAnalytics(db, WORKSPACE, 30, NOW);

    expect(analytics.total.held).toBe(1);
    expect(analytics.total.planned).toBe(1);
    expect(analytics.byCampaign).toHaveLength(1);
    expect(analytics.byCampaign[0].held).toBe(1);

    // The identity funnelSelect() documents: `replied` is deliberately not a
    // term, because a reply is already counted inside `accepted`.
    const { planned, held, exported, sent, accepted, declined, skipped, withdrawn } = analytics.total;
    const rows = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(rows?.total).toBe(ACTION_STATUS_VALUES.length);
    expect(planned + held + exported + sent + accepted + declined + skipped + withdrawn).toBe(rows?.total);
  });

  /**
   * `windowDays` was taken and then ignored by two of the three queries, so a
   * screen headed "Last 7 days" printed a lifetime total over a 7-day chart --
   * and read the whole ledger to do it, on every load, forever.
   */
  it('honours windowDays in the totals and the per-campaign breakdown, not only in the series', async () => {
    const campaignId = await campaign('Long lived');
    await action(campaignId, 'sent', new Date(NOW.getTime() - 100 * 86_400_000));
    await action(campaignId, 'sent', new Date(NOW.getTime() - 86_400_000));

    const week = await linkedinAnalytics(db, WORKSPACE, 7, NOW);
    expect(week.total.sent).toBe(1);
    expect(week.byCampaign[0].sent).toBe(1);

    const year = await linkedinAnalytics(db, WORKSPACE, 365, NOW);
    expect(year.total.sent).toBe(2);
    expect(year.byCampaign[0].sent).toBe(2);
  });
});

describe('which day the series means', () => {
  /**
   * The daily ceiling is enforced in the seat's zone. A chart cut on UTC days
   * therefore reported a Sydney seat's Tuesday as ten hours of somebody's
   * Monday -- a column whose number was never any day's total, sitting above a
   * limit that had been applied to a different day entirely. The client cannot
   * repair it by re-labelling: renaming a column does not move the rows summed
   * into it.
   */
  it('cuts the buckets in the seat\'s own timezone, not the server\'s', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Sydney', timezone: 'Australia/Sydney' }, NOW);
    const campaignId = await campaign('Across the dateline');
    // 09:00 on the 6th in Sydney (UTC+10), which is still the 5th in UTC.
    await action(campaignId, 'sent', new Date('2026-08-05T23:00:00.000Z'));

    const analytics = await linkedinAnalytics(db, WORKSPACE, 7, NOW);

    expect(analytics.timezone).toBe('Australia/Sydney');
    expect(analytics.timezoneSpansSeats).toBe(false);

    const last = analytics.series[analytics.series.length - 1];
    expect(last.date).toBe('2026-08-06');
    expect(last.sent).toBe(1);
    // And the label is checkable: the bucket says which instants it spans, so a
    // screen can state the day rather than imply it.
    expect(last.startsAt).toBe('2026-08-05T14:00:00.000Z');
    expect(last.endsAt).toBe('2026-08-06T14:00:00.000Z');
    expect(analytics.series.map((day) => day.date)).toEqual([
      '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'
    ]);
  });

  /**
   * An agency running Berlin and Los Angeles has no single correct day
   * boundary, because there genuinely is not one. The series picks the zone
   * most of the seats are in and SAYS that it did.
   */
  it('says so when the workspace spans zones, rather than picking one in silence', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Berlin one', timezone: 'Europe/Berlin' }, NOW, 'berlin-1');
    await upsertSeat(db, WORKSPACE, { label: 'Berlin two', timezone: 'Europe/Berlin' }, NOW, 'berlin-2');
    await upsertSeat(db, WORKSPACE, { label: 'LA', timezone: 'America/Los_Angeles' }, NOW, 'la-1');

    const analytics = await linkedinAnalytics(db, WORKSPACE, 7, NOW);

    expect(analytics.timezone).toBe('Europe/Berlin');
    expect(analytics.timezoneSpansSeats).toBe(true);

    // And a caller that needs one seat's true days can ask for them.
    const la = await linkedinAnalytics(db, WORKSPACE, 7, NOW, { timezone: 'America/Los_Angeles' });
    expect(la.timezone).toBe('America/Los_Angeles');
    expect(la.series[la.series.length - 1].date).toBe('2026-08-06');
  });

  it('falls back to UTC for a workspace with no seat, and for an unusable zone', async () => {
    expect((await linkedinAnalytics(db, WORKSPACE, 7, NOW)).timezone).toBe('UTC');
    expect((await linkedinAnalytics(db, WORKSPACE, 7, NOW, { timezone: 'Mars/Olympus_Mons' })).timezone).toBe('UTC');
  });
});

describe('one status vocabulary per column', () => {
  /**
   * PART OF THIS TEST IS CHECKED BY `npx tsc --noEmit`, NOT BY VITEST, and
   * that is deliberate: the bug was a type that disagreed with its own column,
   * and vitest strips types before it runs anything. The two assignments below
   * are the assertion -- they do not compile against the old unions -- and the
   * queries after them prove the same values are what the database actually
   * hands back.
   */
  it('lets a paused campaign be a paused campaign, in the type and in both readers', async () => {
    // Refuses to compile if `CampaignStatus` omits 'paused', which is what
    // forced the pause guards in app.ts to widen to `string` first.
    const paused: CampaignStatus = 'paused';
    // And the manager's name for it is the SAME type, not a second copy.
    const alias: ManagedCampaignStatus = paused;
    expect(alias).toBe('paused');

    const campaignId = await campaign('Pause me', 'running');
    // Exactly what `pauseManagedCampaign` writes.
    await db.prepare("UPDATE linkedin_campaigns SET status='paused' WHERE workspace_id=? AND id=?").run(WORKSPACE, campaignId);
    await action(campaignId, 'held');

    // The legacy reader, which used to cast this very row onto a union that
    // said the value it was holding could not exist.
    const read = await getCampaign(db, WORKSPACE, campaignId);
    expect(read?.status).toBe(paused);

    // And the funnel's own copy of the column, which carried the second cast.
    const analytics = await linkedinAnalytics(db, WORKSPACE, 30, NOW);
    expect(analytics.byCampaign[0].status).toBe(paused);
  });

  /**
   * The ledger's vocabulary is published as VALUES so the HTTP layer and the
   * client can import it instead of retyping it. `held` reached production
   * through a hand-copied list that had missed it.
   */
  it('publishes the action statuses as an importable list that matches the type', () => {
    const held: LinkedInActionStatus = 'held';
    expect(ACTION_STATUS_VALUES).toContain(held);
    // A value form of the type, so `z.enum(ACTION_STATUS_VALUES)` and the
    // client's filter list are the same nine words as this union.
    const everyStatus: readonly LinkedInActionStatus[] = ACTION_STATUS_VALUES;
    expect(new Set(everyStatus).size).toBe(ACTION_STATUS_VALUES.length);
  });
});
