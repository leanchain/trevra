import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  campaignWorkflowSteps,
  createManagedCampaign,
  enrolNewContacts,
  listCampaignMembers,
  managedAnalytics,
  releaseSeatWork,
  startManagedCampaign
} from './managed-campaigns.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * TWO PROPERTIES A SHARED TABLE MAKES LOAD-BEARING.
 *
 * Both of the things pinned here are invisible on a single-tenant, single-seat
 * deployment and expensive on a hosted one: a member id that is not scoped to
 * a workspace, and a seat that can be disconnected while its queue is still
 * full. Neither raises an error when it goes wrong, which is the whole reason
 * they are tests.
 */
let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE = 'ws_linkedin_managed_campaigns_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE, 'Managed Campaigns Test', NOW.toISOString());
  for (const table of ['linkedin_actions', 'linkedin_campaigns', 'linkedin_workflows', 'linkedin_lead_contacts', 'linkedin_lead_lists', 'linkedin_seats']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE);
  }
  await upsertSeat(db, WORKSPACE, { label: 'Owner', timezone: 'Europe/Zurich' }, new Date('2026-01-01T09:00:00.000Z'));
});

afterEach(async () => {
  await db?.close();
});

async function leadList(name: string, people: readonly string[]): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name }, NOW);
  const csv = ['First Name,Last Name,Company,LinkedIn URL']
    .concat(people.map((handle) => `${handle},Person,Acme,https://www.linkedin.com/in/${handle}/`))
    .join('\n');
  const result = await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  expect(result.inserted).toBe(people.length);
  return list.id;
}

async function workflow(name = 'Connect'): Promise<string> {
  return (await saveWorkflow(db, {
    workspaceId: WORKSPACE,
    name,
    steps: [{ id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{first_name}}' } }]
  }, NOW)).id;
}

async function statusOf(actionId: string): Promise<string> {
  const row = await db.prepare('SELECT status FROM linkedin_actions WHERE workspace_id=? AND id=?')
    .get<{ status: string }>(WORKSPACE, actionId);
  if (!row) throw new Error(`no action ${actionId}`);
  return row.status;
}

async function queue(seatKey: string, handle: string, status: 'planned' | 'held', claimed = false): Promise<string> {
  const written = await recordAction(db, {
    workspaceId: WORKSPACE,
    seatKey,
    kind: 'invite',
    targetRef: `https://www.linkedin.com/in/${handle}/`,
    status: 'planned',
    source: 'campaign',
    plannedFor: NOW.toISOString()
  }, NOW);
  await db.prepare('UPDATE linkedin_actions SET status=?, claimed_at=? WHERE workspace_id=? AND id=?')
    .run(status, claimed ? NOW.toISOString() : null, WORKSPACE, written.id);
  return written.id;
}

/** One ledger row, at the status it ended up in. */
async function ledger(kind: 'invite' | 'dm', handle: string, status: 'sent' | 'accepted' | 'replied' | 'declined' | 'withdrawn'): Promise<void> {
  await recordAction(db, {
    workspaceId: WORKSPACE,
    kind,
    targetRef: `https://www.linkedin.com/in/${handle}/`,
    status,
    source: 'campaign',
    plannedFor: NOW.toISOString()
  }, NOW);
}

/**
 * THE TWO RATES THIS PANEL SHOWS, AND THE POPULATIONS THEY DIVIDE.
 *
 * Both were wrong in the same way -- a numerator counted over one set of rows
 * and a denominator over another -- and the reply rate could therefore print a
 * number above 100%, which is the kind of figure that makes an operator stop
 * believing the whole screen rather than the one tile.
 */
describe('the rates on the results panel', () => {
  it('divides replies by the same population it counted: leads that were messaged', async () => {
    // Two leads were messaged. One of them replied.
    await ledger('dm', 'messaged-a', 'replied');
    await ledger('dm', 'messaged-b', 'sent');
    // A third replied to an INVITE and was never messaged at all. Under the old
    // query this grew the numerator and left the denominator alone.
    await ledger('invite', 'never-messaged', 'replied');

    const analytics = await managedAnalytics(db, WORKSPACE);

    expect(analytics.contactedLeads).toBe(2);
    // Still the honest headline: everybody who replied to anything.
    expect(analytics.repliedLeads).toBe(2);
    // The rate's numerator, which is a strict subset of `contactedLeads`.
    expect(analytics.repliedMessagedLeads).toBe(1);
    expect(analytics.replyRate).toBeCloseTo(0.5);
  });

  it('cannot exceed 100% even when every reply came from something other than a message', async () => {
    await ledger('dm', 'one', 'sent');
    await ledger('invite', 'two', 'replied');
    await ledger('invite', 'three', 'replied');

    const analytics = await managedAnalytics(db, WORKSPACE);

    // The old arithmetic here was 2 replied leads over 1 messaged lead: 200%.
    expect(analytics.repliedLeads).toBe(2);
    expect(analytics.repliedMessagedLeads).toBe(0);
    expect(analytics.replyRate).toBe(0);
    expect(analytics.replyRate ?? 0).toBeLessThanOrEqual(1);
    // A denominator of 1 is not a measurement, and the screen says so rather
    // than printing this 0% -- see `ratePercent` and RATE_MIN_SAMPLE.
    expect(analytics.contactedLeads).toBeLessThan(10);
  });

  /**
   * The same three status lists `inviteSelect` in campaigns.ts uses, so the
   * funnel and this panel answer "acceptance" with one number.
   */
  it('counts a declined invite as one that was sent, and a withdrawn one as neither', async () => {
    await ledger('invite', 'accepted-one', 'accepted');
    await ledger('invite', 'declined-one', 'declined');
    await ledger('invite', 'pending-one', 'sent');
    await ledger('invite', 'withdrawn-one', 'withdrawn');

    const analytics = await managedAnalytics(db, WORKSPACE);

    expect(analytics.invitesSent).toBe(3);
    expect(analytics.invitesAccepted).toBe(1);
    expect(analytics.invitesWithdrawn).toBe(1);
    // Was 1/2 = 50% while the refusal sat outside the denominator.
    expect(analytics.acceptanceRate).toBeCloseTo(1 / 3);
  });

  it('reports null rather than 0% when nothing has been sent or messaged', async () => {
    const analytics = await managedAnalytics(db, WORKSPACE);
    expect(analytics.acceptanceRate).toBeNull();
    expect(analytics.replyRate).toBeNull();
  });
});

describe('the derived campaign-member id', () => {
  /**
   * `linkedin_campaign_members` is ONE table shared by every tenant. A digest
   * of (campaign, contact) alone put two workspaces in the same key space, and
   * because the enrolling insert is `ON CONFLICT DO NOTHING`, a collision does
   * not raise -- the loser is simply never enrolled, and their campaign quietly
   * skips a lead with nothing anywhere to explain the missing person.
   */
  it('is scoped to the workspace, not only to the campaign and the contact', async () => {
    const listId = await leadList('Digest', ['maya']);
    const campaign = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Digest', leadListId: listId, workflowId: await workflow() }, NOW);
    const [member] = await listCampaignMembers(db, WORKSPACE, campaign.campaign.id);

    const digest = createHash('md5').update(`${WORKSPACE}:${campaign.campaign.id}:${member.contactId}`).digest('hex');
    expect(member.id).toBe(`limem_${digest}`);
  });

  /**
   * The derivation exists so enrolment can run on every runner tick without
   * producing a second membership, and so a REMOVED member stays removed.
   * Changing what goes into the digest must not cost either property.
   */
  it('keeps enrolment idempotent for the same tenant', async () => {
    const listId = await leadList('Idempotent', ['maya', 'jonas']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Idempotent', leadListId: listId, workflowId: await workflow() }, NOW);
    await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
    const steps = await campaignWorkflowSteps(db, WORKSPACE, created.campaign.id);

    expect(await enrolNewContacts(db, WORKSPACE, { id: created.campaign.id, leadListId: listId, steps }, NOW)).toBe(0);
    expect(await listCampaignMembers(db, WORKSPACE, created.campaign.id)).toHaveLength(2);
  });
});

describe('releaseSeatWork', () => {
  /**
   * `deleteSeat` deletes one row and leaves the queue. What is left cannot be
   * sent (no worker runs for a seat that does not exist), cannot be reached
   * (nothing lists it), and still holds the replay guard on every prospect it
   * names -- and if the seat key is reused, which 'owner' always is, the NEXT
   * account inherits the previous operator's parked outreach and sends it.
   */
  it('skips a seat\'s planned and held work, cancels its tasks, and reports what was in flight', async () => {
    const listId = await leadList('Seat work', ['maya']);
    const created = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Seat work', leadListId: listId, workflowId: await workflow() }, NOW);
    const [member] = await listCampaignMembers(db, WORKSPACE, created.campaign.id);

    const planned = await queue('owner', 'planned-one', 'planned');
    const held = await queue('owner', 'held-one', 'held');
    const inFlight = await queue('owner', 'claimed-one', 'planned', true);

    await upsertSeat(db, WORKSPACE, { label: 'Secondary', timezone: 'Europe/Zurich' }, NOW, 'secondary');
    const otherSeat = await queue('secondary', 'other-seat', 'planned');

    await db.prepare(`
      INSERT INTO linkedin_manual_tasks (id,workspace_id,campaign_id,member_id,contact_id,seat_key,workflow_step_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id('litask'), WORKSPACE, created.campaign.id, member.id, member.contactId, 'owner', 'invite', 'pending', NOW.toISOString());

    const report = await releaseSeatWork(db, WORKSPACE, 'owner', NOW);

    expect(report).toEqual({ seatKey: 'owner', actionsSkipped: 2, tasksCancelled: 1, actionsInFlight: 1 });
    expect(await statusOf(planned)).toBe('skipped');
    expect(await statusOf(held)).toBe('skipped');
    // The two boundaries every other release path in this file also draws.
    expect(await statusOf(inFlight)).toBe('planned');
    expect(await statusOf(otherSeat)).toBe('planned');
  });

  it('is idempotent, so a disconnect that retries releases nothing twice', async () => {
    await queue('owner', 'retry-one', 'planned');
    expect((await releaseSeatWork(db, WORKSPACE, 'owner', NOW)).actionsSkipped).toBe(1);
    expect(await releaseSeatWork(db, WORKSPACE, 'owner', NOW)).toMatchObject({ actionsSkipped: 0, tasksCancelled: 0, actionsInFlight: 0 });
  });
});
