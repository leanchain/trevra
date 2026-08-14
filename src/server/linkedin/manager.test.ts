import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from './seats.js';
import { recordAction } from './actions.js';
import { seatsWithDueActions } from './local-worker.js';
import { createLeadList, importLeadCsv, listLeadContacts, updateLeadContact } from './lead-lists.js';
import { saveWorkflow } from './workflows.js';
import {
  campaignActionLimit,
  campaignWarmupFraction,
  createManagedCampaign,
  listCampaignMembers,
  pauseManagedCampaign,
  removeCampaignMember,
  setCampaignMemberPaused,
  startManagedCampaign,
  stopManagedCampaign
} from './managed-campaigns.js';

let db: Db;
const WORKSPACE = 'ws_linkedin_manager_test';
const NOW = new Date('2026-08-06T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING').run(WORKSPACE, 'Manager Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_manual_tasks WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_campaign_members WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_workflows WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_lead_contacts WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_lead_lists WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE);
  await upsertSeat(db, WORKSPACE, { label: 'Owner', timezone: 'Europe/Zurich' }, new Date('2026-01-01T09:00:00Z'));
});

afterEach(async () => db?.close());

async function listWithTwo(): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Founders' }, NOW);
  const result = await importLeadCsv(db, {
    workspaceId: WORKSPACE,
    listId: list.id,
    csv: ['First Name,Last Name,Company,Email,LinkedIn URL','Dr. Maya,Smith,Acme,maya@acme.test,https://linkedin.com/in/maya-smith','Jon,Jones,Widgets,jon@widgets.test,https://linkedin.com/in/jon-jones'].join('\n')
  }, NOW);
  expect(result.inserted).toBe(2);
  return list.id;
}

async function workflow(): Promise<string> {
  return (await saveWorkflow(db, {
    workspaceId: WORKSPACE,
    name: 'Connect then message',
    steps: [
      { id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{first_name}}' } },
      { id: 'message', action: 'message', delayBefore: { amount: 2, unit: 'days' }, config: { variants: [{ id: 'a', body: 'Hi {{first_name}}', weight: 50 }, { id: 'b', body: 'Hey {{first_name}} at {{company}}', weight: 50 }] } }
    ]
  }, NOW)).id;
}

describe('LinkedIn outreach manager persistence', () => {
  it('imports canonical contacts and applies the same scrubber on edits', async () => {
    const listId = await listWithTwo();
    const contacts = await listLeadContacts(db, WORKSPACE, listId);
    expect(contacts).toHaveLength(2);
    const maya = contacts.find((contact) => contact.firstName === 'Maya');
    expect(maya).toBeDefined();
    const updated = await updateLeadContact(db, { workspaceId: WORKSPACE, contactId: maya!.id, firstName: 'Prof. Maya 🙂', lastName: 'Smith, PhD', company: 'Acme' }, NOW);
    expect(updated.firstName).toBe('Maya');
    expect(updated.lastName).toBe('Smith');
  });

  it('enforces one active campaign per contact even when the member is paused', async () => {
    const listId = await listWithTwo();
    const workflowId = await workflow();
    const first = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'One', leadListId: listId, workflowId }, NOW);
    expect(first.enrolled).toBe(2);
    const members = await listCampaignMembers(db, WORKSPACE, first.campaign.id);
    expect(await setCampaignMemberPaused(db, WORKSPACE, members[0].id, true, NOW)).toBe(true);
    const second = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Two', leadListId: listId, workflowId }, NOW);
    expect(second.enrolled).toBe(0);
    expect(second.skippedAlreadyActive).toBe(2);
    expect(await removeCampaignMember(db, WORKSPACE, members[0].id, NOW)).toBe(true);
    const third = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Three', leadListId: listId, workflowId }, NOW);
    expect(third.enrolled).toBe(1);
  });

  it('starts, pauses and stops a managed campaign without sending anything', async () => {
    const listId = await listWithTwo();
    const workflowId = await workflow();
    const made = await createManagedCampaign(db, { workspaceId: WORKSPACE, name: 'Lifecycle', leadListId: listId, workflowId }, NOW);
    const running = await startManagedCampaign(db, WORKSPACE, made.campaign.id, NOW);
    expect(running.status).toBe('running');
    expect((await listCampaignMembers(db, WORKSPACE, made.campaign.id)).every((member) => member.status === 'active')).toBe(true);
    expect((await pauseManagedCampaign(db, WORKSPACE, made.campaign.id, NOW)).status).toBe('paused');
    expect((await stopManagedCampaign(db, WORKSPACE, made.campaign.id, NOW)).status).toBe('stopped');
    const actions = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?').get<{ total: number }>(WORKSPACE, made.campaign.id);
    expect(actions?.total ?? 0).toBe(0);
  });

  // WAS: 'fails closed for non-owner execution: a secondary-seat action cannot
  // wake the owner worker'. That assertion described the `AND seat_key='owner'`
  // filter in the worker's discovery query, which made every non-owner queue
  // fill up and never drain. Multi-seat execution removes the filter, so the
  // property worth holding down is the opposite one: each seat is discovered
  // as itself, and the owner seat's discovery is unchanged.
  // WAS: 'fails closed for non-owner execution: a secondary-seat action cannot
  // wake the owner worker'. That assertion described the `AND seat_key='owner'`
  // filter in the worker's discovery query, which made every non-owner queue
  // fill up and never drain. Multi-seat execution removes the filter, so the
  // property worth holding down is the opposite one: each seat is discovered
  // as itself, and the owner seat's discovery is unchanged.
  //
  // FILTERED TO THIS WORKSPACE, because discovery is deliberately global: it
  // sweeps every tenant with due work, so any sibling suite that leaves a seat
  // and a planned action behind lands in this result set. Asserting on the raw
  // list made this test a report on the rest of the suite rather than on
  // discovery -- the filter keeps the property (each seat appears as itself,
  // owner included) while making the assertion about this workspace's rows.
  it('discovers every seat with due work, each as its own seat', async () => {
    const mine = async () => (await seatsWithDueActions(db, NOW)).filter((seat) => seat.workspaceId === WORKSPACE);
    await upsertSeat(db, WORKSPACE, { label: 'Secondary', timezone: 'Europe/Zurich' }, NOW, 'secondary');
    await recordAction(db, { workspaceId: WORKSPACE, seatKey: 'secondary', kind: 'profile_view', targetRef: 'https://www.linkedin.com/in/secondary-test/', status: 'planned', source: 'export', plannedFor: NOW.toISOString() }, NOW);
    expect((await mine()).map((seat) => seat.seatKey)).toEqual(['secondary']);
    await recordAction(db, { workspaceId: WORKSPACE, seatKey: 'owner', kind: 'profile_view', targetRef: 'https://www.linkedin.com/in/owner-test/', status: 'planned', source: 'export', plannedFor: NOW.toISOString() }, NOW);
    expect(await mine()).toEqual([
      { workspaceId: WORKSPACE, seatKey: 'owner', timezone: 'Europe/Zurich' },
      { workspaceId: WORKSPACE, seatKey: 'secondary', timezone: 'Europe/Zurich' }
    ]);
  });

  it('uses the exact five-day 20/40/60/80/100 campaign ramp', () => {
    const start = '2026-08-01T09:00:00.000Z';
    const fractions = [0,1,2,3,4,9].map((days) => campaignWarmupFraction(start, new Date(Date.parse(start) + days * 86_400_000)));
    expect(fractions[0]).toBeCloseTo(0.2);
    expect(fractions[1]).toBeCloseTo(0.4);
    expect(fractions[2]).toBeCloseTo(0.6);
    expect(fractions[3]).toBeCloseTo(0.8);
    expect(fractions[4]).toBe(1);
    expect(fractions[5]).toBe(1);
    expect(campaignActionLimit(30, start, new Date('2026-08-01T12:00:00Z'))).toBe(6);
    expect(campaignActionLimit(25, start, new Date('2026-08-04T12:00:00Z'))).toBe(20);
  });
});
