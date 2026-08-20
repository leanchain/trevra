import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv, listLeadContacts } from './lead-lists.js';
import {
  applyLatestWorkflowToPendingMembers,
  completeManualTask,
  createManagedCampaign,
  listCampaignMembers,
  listManualTasks,
  managedAnalytics,
  pauseManagedCampaign,
  setCampaignMemberPaused,
  startManagedCampaign
} from './managed-campaigns.js';
import {
  allocateCampaignCapacity,
  runManagedCampaigns,
  runManagedCampaignsForAllWorkspaces
} from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

let db: Db;
const WORKSPACE = 'ws_linkedin_runner_test';
/** A Monday, 09:00, inside the seat's 08:00-18:00 UTC working window. */
const NOW = new Date('2026-08-03T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Runner Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_withdrawals WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_manual_tasks WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_campaign_members WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_workflows WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_lead_contacts WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_lead_lists WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE);
  await upsertSeat(
    db,
    WORKSPACE,
    {
      label: 'Owner',
      // UTC so every assertion below reads the seat's own wall clock.
      timezone: 'UTC',
      workingDays: [1, 2, 3, 4, 5],
      workStartMinute: 480,
      workEndMinute: 1080
    },
    new Date('2026-01-01T09:00:00.000Z')
  );
});

afterEach(async () => db?.close());

interface ActionRow {
  id: string;
  kind: string;
  status: string;
  body: string | null;
  target_ref: string | null;
  workflow_step_id: string | null;
  variant_id: string | null;
  campaign_member_id: string | null;
  replay_scope: string;
  source: string;
  planned_for: string | null;
  sla_deadline_at: string | null;
}

interface MemberRow {
  id: string;
  contact_id: string;
  status: string;
  step_index: number;
  assigned_variants: Record<string, string>;
  next_eligible_at: string | null;
}

async function actions(): Promise<ActionRow[]> {
  return db
    .prepare(
      `
    SELECT id,kind,status,body,target_ref,workflow_step_id,variant_id,campaign_member_id,replay_scope,source,
           TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO}) AS planned_for,
           TO_CHAR(sla_deadline_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS sla_deadline_at
    FROM linkedin_actions WHERE workspace_id=? ORDER BY planned_for ASC NULLS LAST, id ASC
  `
    )
    .all<ActionRow>(WORKSPACE);
}

async function members(campaignId: string): Promise<MemberRow[]> {
  return db
    .prepare(
      `
    SELECT id,contact_id,status,step_index,assigned_variants,
           TO_CHAR(next_eligible_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS next_eligible_at
    FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? ORDER BY id ASC
  `
    )
    .all<MemberRow>(WORKSPACE, campaignId);
}

async function campaignStatus(campaignId: string): Promise<string> {
  const row = await db
    .prepare('SELECT status FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
    .get<{ status: string }>(WORKSPACE, campaignId);
  return row?.status ?? 'missing';
}

async function seededList(
  name: string,
  people: Array<{ first: string; last: string; company: string; slug: string }>
): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name }, NOW);
  const csv = [
    'First Name,Last Name,Company,Email,LinkedIn URL',
    ...people.map(
      (person) =>
        `${person.first},${person.last},${person.company},${person.slug}@test.test,https://www.linkedin.com/in/${person.slug}`
    )
  ].join('\n');
  const result = await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  expect(result.inserted).toBe(people.length);
  return list.id;
}

async function runningCampaign(listId: string, workflowId: string, name: string): Promise<string> {
  const made = await createManagedCampaign(
    db,
    { workspaceId: WORKSPACE, name, leadListId: listId, workflowId },
    NOW
  );
  await startManagedCampaign(db, WORKSPACE, made.campaign.id, NOW);
  return made.campaign.id;
}

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function plus(iso: string | null, ms: number): string {
  return new Date(new Date(iso as string).getTime() + ms).toISOString();
}

describe('managed campaign runner', () => {
  it('allocates scarce shared-seat capacity with a starvation floor and weighted remainder', () => {
    const campaigns = [
      { id: 'low', priority: -1, last_planned_at: null, created_at: '2026-08-01T00:00:00.000Z' },
      { id: 'normal', priority: 0, last_planned_at: null, created_at: '2026-08-01T00:00:01.000Z' },
      { id: 'high', priority: 1, last_planned_at: null, created_at: '2026-08-01T00:00:02.000Z' }
    ];
    expect(Object.fromEntries(allocateCampaignCapacity(14, campaigns))).toEqual({
      low: 3,
      normal: 4,
      high: 7
    });
    // Fewer slots than campaigns: service age wins before priority.
    expect(
      Object.fromEntries(
        allocateCampaignCapacity(1, [
          { ...campaigns[2], last_planned_at: '2026-08-03T08:00:00.000Z' },
          { ...campaigns[0], last_planned_at: '2026-08-03T07:00:00.000Z' },
          { ...campaigns[1], last_planned_at: '2026-08-03T06:00:00.000Z' }
        ])
      )
    ).toEqual({ high: 0, low: 0, normal: 1 });
  });

  it('shares one sender ceiling across competing campaigns instead of recreating it per campaign', async () => {
    await upsertSeat(db, WORKSPACE, { dailyProfileViewLimit: 10, safetyBandOverride: true }, NOW);
    await db
      .prepare(
        `
      INSERT INTO linkedin_actions
        (id,workspace_id,seat_key,kind,target_ref,status,planned_for,recorded_at,source,replay_scope,created_at)
      SELECT 'lact_fair_used_' || g, ?, 'owner', 'profile_view',
             'https://www.linkedin.com/in/fair-used-' || g || '/', 'sent', ?::timestamptz, ?::timestamptz,
             'export', 'legacy', ?::timestamptz
      FROM generate_series(1,8) AS g
    `
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const workflow = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Fair shared seat',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      },
      NOW
    );
    const campaignIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const listId = await seededList(`Fair ${index}`, [
        { first: `Lead${index}`, last: 'Fair', company: 'Acme', slug: `fair-${index}` }
      ]);
      campaignIds.push(await runningCampaign(listId, workflow.id, `Fair ${index}`));
    }

    const tick = await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(tick.actionsPlanned).toBe(2);
    const planned = await db
      .prepare(
        `SELECT campaign_id,COUNT(*)::int AS total FROM linkedin_actions
         WHERE workspace_id=? AND kind='profile_view' AND status='planned'
         GROUP BY campaign_id ORDER BY campaign_id`
      )
      .all<{ campaign_id: string; total: number }>(WORKSPACE);
    expect(planned).toHaveLength(2);
    expect(planned.every((row) => row.total === 1)).toBe(true);
    const rotation = await db
      .prepare(
        `SELECT id,last_planned_at IS NOT NULL AS served FROM linkedin_campaigns
         WHERE workspace_id=? AND id = ANY(?::text[]) ORDER BY id`
      )
      .all<{ id: string; served: boolean }>(WORKSPACE, campaignIds);
    expect(rotation.filter((row) => row.served)).toHaveLength(2);
    expect(rotation.filter((row) => !row.served)).toHaveLength(1);
  });
  it('plans every company, event and group workflow action with a distinct ledger kind and destination metadata', async () => {
    const listId = await seededList('Community actions', [
      { first: 'Maya', last: 'Smith', company: 'Acme', slug: 'maya-community' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Community surface actions',
          steps: [
            {
              id: 'company-follow',
              action: 'follow_company',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { companyUrl: 'https://www.linkedin.com/company/acme/' }
            },
            {
              id: 'company-like',
              action: 'like_company_post',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { companyUrl: 'https://www.linkedin.com/company/acme/' }
            },
            {
              id: 'company-invite',
              action: 'invite_to_follow_company',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { companyUrl: 'https://www.linkedin.com/company/acme/' }
            },
            {
              id: 'event-invite',
              action: 'invite_to_event',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { eventUrl: 'https://www.linkedin.com/events/acme-123/' }
            },
            {
              id: 'group-invite',
              action: 'invite_to_group',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { groupUrl: 'https://www.linkedin.com/groups/123/' }
            },
            {
              id: 'group-message',
              action: 'group_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                groupUrl: 'https://www.linkedin.com/groups/123/',
                variants: [{ id: 'a', body: 'Group hello {{first_name}}', weight: 100 }]
              }
            },
            {
              id: 'event-message',
              action: 'event_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                eventUrl: 'https://www.linkedin.com/events/acme-123/',
                variants: [{ id: 'a', body: 'Event hello {{first_name}}', weight: 100 }]
              }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Community');

    for (let index = 0; index < 7; index += 1) {
      await runManagedCampaigns(db, WORKSPACE, at(index * 2 * HOUR));
    }
    // The sender window closes at 18:00; a later community step can therefore
    // land on the next working day even with a zero workflow delay.
    await runManagedCampaigns(db, WORKSPACE, at(2 * DAY));

    const rows = await db
      .prepare(
        `
      SELECT kind,workflow_step_id,body,channel_metadata_json
      FROM linkedin_actions
      WHERE workspace_id=? AND campaign_id=?
      ORDER BY created_at ASC,id ASC
    `
      )
      .all<{
        kind: string;
        workflow_step_id: string;
        body: string | null;
        channel_metadata_json: Record<string, unknown>;
      }>(WORKSPACE, campaignId);
    expect(rows.map((row) => row.kind)).toEqual([
      'company_follow',
      'company_like',
      'company_invite_follow',
      'event_invite',
      'group_invite',
      'group_message',
      'event_message'
    ]);
    expect(rows[0].channel_metadata_json).toMatchObject({
      companyUrl: 'https://www.linkedin.com/company/acme/'
    });
    expect(rows[3].channel_metadata_json).toMatchObject({
      eventUrl: 'https://www.linkedin.com/events/acme-123/'
    });
    expect(rows[4].channel_metadata_json).toMatchObject({
      groupUrl: 'https://www.linkedin.com/groups/123/'
    });
    expect(rows[5].body).toBe('Group hello Maya');
    expect(rows[6].body).toBe('Event hello Maya');
  });

  it('walks a six-action workflow one step at a time, honouring hour and day delays', async () => {
    const listId = await seededList('Six actions', [
      { first: 'Maya', last: 'Smith', company: 'Acme', slug: 'maya-smith' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Everything',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 1, unit: 'hours' },
              config: { message: 'Hi {{first_name}}' }
            },
            {
              id: 'msg',
              action: 'message',
              delayBefore: { amount: 2, unit: 'hours' },
              config: {
                variants: [
                  { id: 'a', body: 'A {{first_name}}', weight: 50 },
                  { id: 'b', body: 'B {{company}}', weight: 50 }
                ]
              }
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'days' },
              config: {}
            },
            {
              id: 'manual',
              action: 'manual_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { suggestedTemplate: 'Ping {{first_name}} at {{company}}' }
            },
            {
              id: 'withdraw',
              action: 'withdraw_pending',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { afterDays: 1 }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Six');

    // Step 1: the profile view, planned for the next open instant.
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);
    let ledger = await actions();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe('profile_view');
    expect(ledger[0].status).toBe('planned');
    expect(ledger[0].workflow_step_id).toBe('view');
    expect(ledger[0].target_ref).toBe('https://www.linkedin.com/in/maya-smith/');
    expect(new Date(ledger[0].planned_for as string).getTime()).toBeGreaterThanOrEqual(
      NOW.getTime()
    );
    const view = ledger[0];
    let member = (await members(campaignId))[0];
    expect(member.step_index).toBe(1);
    expect(member.status).toBe('waiting');
    expect(ledger[0].replay_scope).toBe(`${member.id}:view`);
    expect(ledger[0].campaign_member_id).toBe(member.id);
    // THE HOUR DELAY, measured from the slot rather than from the tick.
    expect(member.next_eligible_at).toBe(plus(view.planned_for, HOUR));

    // A tick before the delay elapses does nothing at all.
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(0);
    expect(await actions()).toHaveLength(1);

    // Step 2: the invitation, with the rendered note.
    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR))).actionsPlanned).toBe(1);
    ledger = await actions();
    const invite = ledger.find((row) => row.kind === 'invite');
    expect(invite?.body).toBe('Hi Maya');
    expect(invite?.workflow_step_id).toBe('invite');
    member = (await members(campaignId))[0];
    expect(member.step_index).toBe(2);
    expect(member.next_eligible_at).toBe(plus(invite?.planned_for ?? null, 2 * HOUR));

    // Step 3: the A/B message.
    expect((await runManagedCampaigns(db, WORKSPACE, at(5 * HOUR))).actionsPlanned).toBe(1);
    ledger = await actions();
    const message = ledger.find((row) => row.kind === 'dm');
    expect(message?.variant_id === 'a' || message?.variant_id === 'b').toBe(true);
    expect(message?.body).toBe(message?.variant_id === 'a' ? 'A Maya' : 'B Acme');
    member = (await members(campaignId))[0];
    expect(member.step_index).toBe(3);
    expect(member.assigned_variants.msg).toBe(message?.variant_id);
    // THE DAY DELAY.
    expect(member.next_eligible_at).toBe(plus(message?.planned_for ?? null, DAY));

    // Step 4: the follow.
    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * DAY))).actionsPlanned).toBe(1);
    ledger = await actions();
    expect(ledger.filter((row) => row.kind === 'follow')).toHaveLength(1);
    member = (await members(campaignId))[0];
    expect(member.step_index).toBe(4);

    // Step 5: the human checkpoint. Nothing outbound is planned for it.
    const manualTick = await runManagedCampaigns(db, WORKSPACE, at(2 * DAY + HOUR));
    expect(manualTick.manualTasksCreated).toBe(1);
    expect(manualTick.actionsPlanned).toBe(0);
    member = (await members(campaignId))[0];
    expect(member.status).toBe('manual');
    expect(member.step_index).toBe(4);
    expect(member.next_eligible_at).toBeNull();
    const tasks = await listManualTasks(db, WORKSPACE, { status: 'pending' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].suggestedBody).toBe('Ping Maya at Acme');

    // A tick while the human still owes an answer neither advances nor duplicates.
    const heldTick = await runManagedCampaigns(db, WORKSPACE, at(2 * DAY + 2 * HOUR));
    expect(heldTick.manualTasksCreated).toBe(0);
    expect(await listManualTasks(db, WORKSPACE, { status: 'pending' })).toHaveLength(1);

    expect(await completeManualTask(db, WORKSPACE, tasks[0].id, at(2 * DAY + 2 * HOUR))).toBe(true);
    member = (await members(campaignId))[0];
    expect(member.step_index).toBe(5);
    expect(member.status).toBe('active');

    // Step 6: withdraw-pending. The invite is still sitting in the queue --
    // nothing has sent it -- so there is nothing to withdraw YET and the member
    // is HELD on the step rather than advanced past it.
    const heldOnWithdraw = await runManagedCampaigns(db, WORKSPACE, at(3 * DAY));
    expect(heldOnWithdraw.membersCompleted).toBe(0);
    member = (await members(campaignId))[0];
    expect(member.status).toBe('waiting');
    expect(member.step_index).toBe(5);
    expect(member.next_eligible_at).not.toBeNull();
    expect(await campaignStatus(campaignId)).toBe('running');

    // Once the worker actually sends it, the withdrawal clock starts from THAT
    // instant -- and the step resolves a day later, not a day after the slot.
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='sent', recorded_at=? WHERE workspace_id=? AND kind='invite'`
      )
      .run(at(3 * DAY).toISOString(), WORKSPACE);
    const last = await runManagedCampaigns(db, WORKSPACE, at(5 * DAY));
    expect(last.membersCompleted).toBe(1);
    member = (await members(campaignId))[0];
    expect(member.status).toBe('completed');
    expect(member.next_eligible_at).toBeNull();
    expect(await campaignStatus(campaignId)).toBe('completed');

    /*
     * FIVE ROWS FOR FIVE THINGS THAT REACHED LINKEDIN, and the fifth is the
     * manual message.
     *
     * It used to be four: `manual_message` wrote no ledger row at all, on the
     * grounds that Trevra does not send it. But the operator does -- from the
     * same account, on the same day, against the same message ceiling -- so
     * "Trevra did not send it" was being recorded as "nothing was sent", and a
     * workflow made of human checkpoints reported zero messages forever while
     * its seat's 24h message count ran short by exactly the messages the
     * product had asked a human to send.
     *
     * Filed as a 'dm' with `source='manual'` at COMPLETION, never at creation:
     * a pending task is a request, and only completion is the operator saying
     * it went out. `withdraw_pending` still writes nothing here, because
     * nothing was withdrawn on this path -- the row is filed by
     * `executeWithdrawal` when LinkedIn confirms the click.
     */
    const finalLedger = await actions();
    expect(finalLedger).toHaveLength(5);
    const manual = finalLedger.filter((row) => row.source === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0].kind).toBe('dm');
    expect(manual[0].status).toBe('sent');
    expect(manual[0].workflow_step_id).toBe('manual');
    expect(manual[0].body).toBe('Ping Maya at Acme');
  });

  it('caps day-one planning at the campaign ramp and releases the rest on day two', async () => {
    await upsertSeat(db, WORKSPACE, { dailyInviteLimit: 10 }, NOW);
    const listId = await seededList(
      'Ramp',
      [1, 2, 3, 4, 5].map((n) => ({
        first: `Lead${n}`,
        last: 'Test',
        company: 'Acme',
        slug: `ramp-${n}`
      }))
    );
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite only',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Ramp');

    // Day 1 is 20% of 10.
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(2);
    expect((await actions()).filter((row) => row.kind === 'invite')).toHaveLength(2);
    const waiting = (await members(campaignId)).filter((row) => row.step_index === 0);
    expect(waiting).toHaveLength(3);
    expect(waiting.every((row) => row.status === 'pending')).toBe(true);

    // Re-ticking the same day plans nothing more: the ramp is counted against
    // what this campaign already has in the next 24 hours.
    expect((await runManagedCampaigns(db, WORKSPACE, at(HOUR))).actionsPlanned).toBe(0);
    expect(await actions()).toHaveLength(2);

    // Day 2 is 40% -- minus the two day-one invites still inside the window.
    expect((await runManagedCampaigns(db, WORKSPACE, at(DAY))).actionsPlanned).toBe(2);
    expect(await actions()).toHaveLength(4);
    expect(await campaignStatus(campaignId)).toBe('running');

    // Day 3 is 60%, and the last lead goes out.
    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * DAY))).actionsPlanned).toBe(1);
    expect(await actions()).toHaveLength(5);
    expect(await campaignStatus(campaignId)).toBe('completed');
  });

  it('withdraw-pending waits for afterDays, then hands the invite to the withdrawal queue', async () => {
    const listId = await seededList('Withdraw', [
      { first: 'Stale', last: 'Lead', company: 'Acme', slug: 'stale-lead' },
      { first: 'Warm', last: 'Lead', company: 'Widgets', slug: 'warm-lead' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite then withdraw',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            },
            {
              id: 'withdraw',
              action: 'withdraw_pending',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { afterDays: 3 }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Withdraw');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(2);
    // The worker's half: one invite went out and is unanswered, the other was
    // accepted.
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='sent', recorded_at=? WHERE workspace_id=? AND target_ref LIKE '%stale-lead%'`
      )
      .run(NOW.toISOString(), WORKSPACE);
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='accepted', recorded_at=? WHERE workspace_id=? AND target_ref LIKE '%warm-lead%'`
      )
      .run(NOW.toISOString(), WORKSPACE);

    const early = await runManagedCampaigns(db, WORKSPACE, at(HOUR));
    expect(early.membersCompleted).toBe(1);
    const afterEarly = await members(campaignId);
    const stale = afterEarly.find((row) => row.status === 'waiting');
    expect(stale?.step_index).toBe(1);
    // Not withdrawn yet, and woken at the exact instant it becomes stale.
    expect(stale?.next_eligible_at).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(
      await db
        .prepare('SELECT COUNT(*)::int AS total FROM linkedin_withdrawals WHERE workspace_id=?')
        .get<{ total: number }>(WORKSPACE)
    ).toEqual({ total: 0 });
    // The accepted invite advanced past the withdraw step immediately.
    expect(afterEarly.find((row) => row.status === 'completed')).toBeDefined();

    await runManagedCampaigns(db, WORKSPACE, at(4 * DAY));
    const queued = await db
      .prepare(
        `
      SELECT w.status, a.target_ref FROM linkedin_withdrawals w
      JOIN linkedin_actions a ON a.id=w.action_id
      WHERE w.workspace_id=?
    `
      )
      .all<{ status: string; target_ref: string }>(WORKSPACE);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('queued');
    expect(queued[0].target_ref).toBe('https://www.linkedin.com/in/stale-lead/');
    expect((await members(campaignId)).every((row) => row.status === 'completed')).toBe(true);
    expect(await campaignStatus(campaignId)).toBe('completed');
  });

  it('keeps an A/B assignment stable across re-runs and records it on the ledger row', async () => {
    // The steady dm band is 12/day, so the campaign's day-one 20% ramp would
    // otherwise be 2 and this test would be measuring the ramp rather than the
    // A/B split. The override is the operator's informed opt-in to their own
    // 25/day figure, which is what the four members below need.
    await upsertSeat(db, WORKSPACE, { dailyMessageLimit: 25, safetyBandOverride: true }, NOW);
    const listId = await seededList(
      'Variants',
      [1, 2, 3, 4].map((n) => ({ first: `Ab${n}`, last: 'Test', company: 'Acme', slug: `ab-${n}` }))
    );
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Message only',
          steps: [
            {
              id: 'msg',
              action: 'message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                variants: [
                  { id: 'a', body: 'A {{first_name}}', weight: 50 },
                  { id: 'b', body: 'B {{first_name}}', weight: 50 }
                ]
              }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Variants');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(4);
    const first = await actions();
    expect(first).toHaveLength(4);
    const assigned = new Map(
      (await members(campaignId)).map((row) => [row.id, row.assigned_variants.msg])
    );
    for (const row of first) {
      expect(row.variant_id).toBeTruthy();
      expect(row.variant_id).toBe(assigned.get(row.campaign_member_id as string));
      // The body is the CHOSEN variant's, rendered -- not the other arm's.
      expect(row.body).toMatch(row.variant_id === 'a' ? /^A Ab\d$/ : /^B Ab\d$/);
    }

    // Replay the step: the stored choice is reused, and the replay scope makes
    // the second attempt a no-op rather than a second message.
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='active', step_index=0, next_eligible_at=? WHERE workspace_id=? AND campaign_id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, campaignId);
    expect((await runManagedCampaigns(db, WORKSPACE, at(HOUR))).actionsPlanned).toBe(0);
    const second = await actions();
    expect(second).toHaveLength(4);
    expect(second.map((row) => `${row.id}:${row.variant_id}`)).toEqual(
      first.map((row) => `${row.id}:${row.variant_id}`)
    );
    const reassigned = new Map(
      (await members(campaignId)).map((row) => [row.id, row.assigned_variants.msg])
    );
    expect([...reassigned.entries()]).toEqual([...assigned.entries()]);
  });

  it('excludes a member with no profile URL before admission, and stays idempotent', async () => {
    const listId = await seededList('Targets', [
      { first: 'Has', last: 'Url', company: 'Acme', slug: 'has-url' },
      { first: 'No', last: 'Url', company: 'Widgets', slug: 'no-url' }
    ]);
    await db
      .prepare(
        `UPDATE linkedin_lead_contacts SET profile_url=NULL WHERE workspace_id=? AND list_id=? AND first_name='No'`
      )
      .run(WORKSPACE, listId);
    const contacts = await listLeadContacts(db, WORKSPACE, listId);
    expect(contacts.filter((contact) => contact.profileUrl === null)).toHaveLength(1);

    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'View only',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Targets');

    const tick = await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(tick.actionsPlanned).toBe(1);
    expect(tick.membersBlocked).toBe(0);
    expect(tick.membersCompleted).toBe(1);
    const after = await members(campaignId);
    expect(after.filter((row) => row.status === 'excluded')).toHaveLength(1);
    expect(after.filter((row) => row.status === 'completed')).toHaveLength(1);
    expect(await campaignStatus(campaignId)).toBe('completed');

    // Re-running the tick writes nothing: the campaign is finished, and even a
    // member forced back onto the step hits the replay scope.
    expect((await runManagedCampaignsForAllWorkspaces(db, at(HOUR))).actionsPlanned).toBe(0);
    await db
      .prepare(`UPDATE linkedin_campaigns SET status='running' WHERE workspace_id=? AND id=?`)
      .run(WORKSPACE, campaignId);
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='active', step_index=0, next_eligible_at=? WHERE workspace_id=? AND campaign_id=? AND status='completed'`
      )
      .run(NOW.toISOString(), WORKSPACE, campaignId);
    const replay = await runManagedCampaignsForAllWorkspaces(db, at(2 * HOUR));
    expect(replay.campaignsTicked).toBe(1);
    expect(replay.actionsPlanned).toBe(0);
    expect(await actions()).toHaveLength(1);
  });

  /**
   * THE RAMP IS A PERCENTAGE OF THE CEILING THE GATE ENFORCES.
   *
   * The runner budgeted off `seat.dailyInviteLimit` raw while `guard.ts` ramps
   * off `min(band, operator)`. With the shipped default of 30 against an 18/day
   * researched band, day one planned 6 invites and the gate passed 3 -- the
   * other three sat refused with nothing saying why.
   */
  it('budgets the campaign ramp off the effective ceiling, not the raw operator limit', async () => {
    // The shipped default. The steady invite band is 18/day.
    await upsertSeat(db, WORKSPACE, { dailyInviteLimit: 30 }, NOW);
    const listId = await seededList(
      'Ceiling',
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        first: `Cap${n}`,
        last: 'Test',
        company: 'Acme',
        slug: `cap-${n}`
      }))
    );
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite only',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            }
          ]
        },
        NOW
      )
    ).id;
    await runningCampaign(listId, workflowId, 'Ceiling');

    // 20% of 18, not 20% of 30.
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(3);
  });

  it("lets the operator's own ceiling drive the ramp once the band override is on", async () => {
    await upsertSeat(db, WORKSPACE, { dailyInviteLimit: 30, safetyBandOverride: true }, NOW);
    const listId = await seededList(
      'Override',
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        first: `Ov${n}`,
        last: 'Test',
        company: 'Acme',
        slug: `ov-${n}`
      }))
    );
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite only',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            }
          ]
        },
        NOW
      )
    ).id;
    await runningCampaign(listId, workflowId, 'Override');

    // 20% of the operator's 30 now that they have opted out of the band.
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(6);
  });

  /**
   * PAUSE HAS TO STOP THE SENDING, NOT JUST THE PLANNING.
   *
   * It wrote one word into `linkedin_campaigns` and stopped. The local worker
   * claims out of `linkedin_actions`, so every invite and DM already scheduled
   * for the coming days went out anyway -- for as long as the queue reached.
   */
  it('holds queued work on pause and hands the same rows back on resume', async () => {
    const listId = await seededList(
      'Pausing',
      [1, 2, 3].map((n) => ({ first: `Pz${n}`, last: 'Test', company: 'Acme', slug: `pz-${n}` }))
    );
    // Two steps, so the members are still live when the pause lands: a
    // finished campaign completes itself and cannot be paused at all.
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite then follow',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            },
            { id: 'follow', action: 'follow', delayBefore: { amount: 5, unit: 'days' }, config: {} }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Pausing');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(3);
    const queued = await actions();
    expect(queued.every((row) => row.status === 'planned')).toBe(true);

    expect((await pauseManagedCampaign(db, WORKSPACE, campaignId, at(HOUR))).status).toBe('paused');
    // Not claimable any more: the worker's query wants 'planned'.
    const paused = await actions();
    expect(paused.map((row) => row.status)).toEqual(['held', 'held', 'held']);
    // Nothing was destroyed -- same rows, same ids, same slots.
    expect(paused.map((row) => row.id)).toEqual(queued.map((row) => row.id));
    expect(paused.map((row) => row.planned_for)).toEqual(queued.map((row) => row.planned_for));
    // And members are left exactly as they were: collapsing them would be
    // indistinguishable from the per-lead pause an operator sets by hand.
    expect(
      (await listCampaignMembers(db, WORKSPACE, campaignId)).every(
        (m) => m.status === 'waiting' || m.status === 'active'
      )
    ).toBe(true);

    await startManagedCampaign(db, WORKSPACE, campaignId, at(2 * HOUR));
    const resumed = await actions();
    expect(resumed.map((row) => row.status)).toEqual(['planned', 'planned', 'planned']);
    expect(resumed.map((row) => row.id)).toEqual(queued.map((row) => row.id));
    // Resumed, not re-planned: no duplicate invite to any of the three.
    expect(resumed).toHaveLength(3);
  });

  /**
   * THE OTHER DOOR INTO THE STATE MACHINE.
   *
   * `completeManualTask` set `next_eligible_at = now`, so "manual message ->
   * wait 3 days -> follow-up" fired the follow-up on the very next tick, on top
   * of the message the operator had just sent by hand.
   */
  it('preserves manual comment task type and post destination', async () => {
    const listId = await seededList('Comment task', [
      { first: 'Maya', last: 'Comment', company: 'Acme', slug: 'maya-comment' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Manual comment metadata',
          steps: [
            {
              id: 'comment',
              action: 'manual_comment',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                suggestedTemplate: 'Thoughtful note for {{first_name}}',
                postUrl: 'https://www.linkedin.com/posts/maya-comment-example/'
              }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Manual comment');
    const tick = await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(tick.manualTasksCreated).toBe(1);
    const task = (await listManualTasks(db, WORKSPACE)).find(
      (row) => row.campaignId === campaignId
    );
    expect(task).toMatchObject({
      taskKind: 'comment',
      postUrl: 'https://www.linkedin.com/posts/maya-comment-example/',
      suggestedBody: 'Thoughtful note for Maya'
    });
  });

  it("applies the next step's delay when a manual task is completed", async () => {
    const listId = await seededList('Manual delay', [
      { first: 'Hand', last: 'Sent', company: 'Acme', slug: 'hand-sent' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Manual then follow-up',
          steps: [
            {
              id: 'manual',
              action: 'manual_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { suggestedTemplate: 'Hi {{first_name}}' }
            },
            {
              id: 'followup',
              action: 'message',
              delayBefore: { amount: 3, unit: 'days' },
              config: { variants: [{ id: 'a', body: 'Following up, {{first_name}}', weight: 50 }] }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Manual delay');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).manualTasksCreated).toBe(1);
    const task = (await listManualTasks(db, WORKSPACE, { status: 'pending' }))[0];
    const completedAt = at(HOUR);
    expect(await completeManualTask(db, WORKSPACE, task.id, completedAt)).toBe(true);

    const member = (await members(campaignId))[0];
    expect(member.step_index).toBe(1);
    expect(member.status).toBe('active');
    expect(member.next_eligible_at).toBe(new Date(completedAt.getTime() + 3 * DAY).toISOString());

    // The very next tick sends nothing: the three days have not passed.
    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR))).actionsPlanned).toBe(0);
    expect((await runManagedCampaigns(db, WORKSPACE, at(4 * DAY))).actionsPlanned).toBe(1);
  });

  it('refuses to complete a manual task whose member is no longer waiting on it', async () => {
    const listId = await seededList('Manual paused', [
      { first: 'Stuck', last: 'Lead', company: 'Acme', slug: 'stuck-lead' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Manual only',
          steps: [
            {
              id: 'manual',
              action: 'manual_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { suggestedTemplate: null }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Manual paused');

    await runManagedCampaigns(db, WORKSPACE, NOW);
    const task = (await listManualTasks(db, WORKSPACE, { status: 'pending' }))[0];
    const member = (await members(campaignId))[0];
    expect(await setCampaignMemberPaused(db, WORKSPACE, member.id, true, at(HOUR))).toBe(true);

    // The member cannot leave the manual state, so the task is NOT reported as
    // completed -- it used to vanish from the queue with the lead left behind.
    expect(await completeManualTask(db, WORKSPACE, task.id, at(2 * HOUR))).toBe(false);
    expect(await listManualTasks(db, WORKSPACE, { status: 'pending' })).toHaveLength(1);
    expect((await members(campaignId))[0].step_index).toBe(0);
    expect((await members(campaignId))[0].status).toBe('paused');
  });

  /**
   * A LEAD LIST IS NOT A PHOTOGRAPH TAKEN AT CREATION.
   *
   * The only member INSERT lived in `createManagedCampaign`, so every contact
   * imported into a running campaign's list afterwards was invisible to it
   * forever -- the list grew, the screen showed the new leads, and not one of
   * them was ever contacted.
   */
  it("enrols contacts imported into a running campaign's lead list", async () => {
    const listId = await seededList('Growing', [
      { first: 'First', last: 'In', company: 'Acme', slug: 'first-in' }
    ]);
    // A second, far-off step keeps the campaign running long enough for the
    // import to land -- a finished campaign completes itself.
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'View then follow',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 30, unit: 'days' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Growing');
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);

    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        listId,
        csv: [
          'First Name,Last Name,Company,Email,LinkedIn URL',
          'Late,Arrival,Widgets,late@test.test,https://www.linkedin.com/in/late-arrival'
        ].join('\n')
      },
      at(HOUR)
    );

    const tick = await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR));
    expect(tick.actionsPlanned).toBe(1);
    expect(await listCampaignMembers(db, WORKSPACE, campaignId)).toHaveLength(2);
    expect((await actions()).map((row) => row.target_ref)).toContain(
      'https://www.linkedin.com/in/late-arrival/'
    );

    // Idempotent: a second tick does not enrol anybody twice.
    await runManagedCampaigns(db, WORKSPACE, at(3 * HOUR));
    expect(await listCampaignMembers(db, WORKSPACE, campaignId)).toHaveLength(2);
  });

  /**
   * "EDITING ONE DOES NOT CHANGE CAMPAIGNS ALREADY RUNNING ON IT" -- which the
   * campaign screen says out loud, and which the runner made false by loading
   * the workflow live on every tick.
   */
  it('runs the snapshot the campaign was started with, not a later edit', async () => {
    const listId = await seededList('Snapshot', [
      { first: 'Snap', last: 'Shot', company: 'Acme', slug: 'snap-shot' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'View then follow',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Snapshot');
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);

    // The operator rewrites step 2 while the campaign is mid-flight.
    await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        id: workflowId,
        name: 'View then follow',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          },
          {
            id: 'msg',
            action: 'message',
            delayBefore: { amount: 1, unit: 'hours' },
            config: { variants: [{ id: 'a', body: 'Edited', weight: 50 }] }
          }
        ]
      },
      at(HOUR)
    );

    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR))).actionsPlanned).toBe(1);
    const kinds = (await actions()).map((row) => row.kind);
    // The follow the campaign was STARTED with, not the message it was edited to.
    expect(kinds).toEqual(['profile_view', 'follow']);
  });

  it('applies a newer workflow only to future waves while existing members keep their admitted version', async () => {
    const listId = await seededList('Versioned waves', [
      { first: 'Ada', last: 'One', company: 'Acme', slug: 'version-one' },
      { first: 'Grace', last: 'Two', company: 'Beta', slug: 'version-two' }
    ]);
    const workflow = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Versioned',
        steps: [
          {
            id: 'touch',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      },
      NOW
    );
    const made = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Versioned waves',
        leadListId: listId,
        workflowId: workflow.id,
        admissionPolicy: { maxWaveSize: 1 }
      },
      NOW
    );
    await startManagedCampaign(db, WORKSPACE, made.campaign.id, NOW);
    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);

    const edited = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        id: workflow.id,
        name: 'Versioned',
        steps: [
          {
            id: 'touch',
            action: 'follow',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      },
      at(HOUR)
    );
    expect(edited.version).toBe(2);
    const applied = await applyLatestWorkflowToPendingMembers(
      db,
      WORKSPACE,
      made.campaign.id,
      at(HOUR)
    );
    expect(applied.previousVersion).toBe(1);
    expect(applied.latestVersion).toBe(2);
    expect(applied.pendingAffected).toBe(1);

    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR))).actionsPlanned).toBe(1);
    expect((await actions()).map((row) => row.kind).sort()).toEqual(['follow', 'profile_view']);
    const versions = await db
      .prepare(
        `SELECT workflow_version FROM linkedin_campaign_members
         WHERE workspace_id=? AND campaign_id=? ORDER BY admitted_at,id`
      )
      .all<{ workflow_version: number | null }>(WORKSPACE, made.campaign.id);
    expect(versions.map((row) => Number(row.workflow_version))).toEqual([1, 2]);
  });

  it('resumes by stable step id without replaying an already-run step after edits or reordering', async () => {
    const listId = await seededList('Stable cursor', [
      { first: 'Stable', last: 'Cursor', company: 'Acme', slug: 'stable-cursor' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Message then follow',
          steps: [
            {
              id: 'intro',
              action: 'message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { variants: [{ id: 'a', body: 'Original message', weight: 50 }] }
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Stable cursor');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);
    const cursor = await db
      .prepare(
        'SELECT current_step_id, completed_step_ids FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?'
      )
      .get<{ current_step_id: string | null; completed_step_ids: string[] }>(WORKSPACE, campaignId);
    expect(cursor?.current_step_id).toBe('follow');
    expect(cursor?.completed_step_ids).toContain('intro');

    await pauseManagedCampaign(db, WORKSPACE, campaignId, at(30 * 60_000));
    await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        id: workflowId,
        name: 'Message then follow',
        steps: [
          {
            id: 'new-earlier-step',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          },
          {
            id: 'follow',
            action: 'follow',
            delayBefore: { amount: 1, unit: 'hours' },
            config: {}
          },
          {
            id: 'intro',
            action: 'message',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { variants: [{ id: 'a', body: 'Edited message', weight: 50 }] }
          }
        ]
      },
      at(HOUR)
    );
    await startManagedCampaign(db, WORKSPACE, campaignId, at(HOUR));

    expect((await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR))).actionsPlanned).toBe(1);
    const rows = await actions();
    expect(rows.map((row) => row.kind)).toEqual(['dm', 'follow']);
    expect(rows.filter((row) => row.workflow_step_id === 'intro')).toHaveLength(1);
    expect(rows.find((row) => row.workflow_step_id === 'intro')?.body).toBe('Original message');
    expect(rows.some((row) => row.workflow_step_id === 'new-earlier-step')).toBe(false);
  });

  /**
   * Two of the six workflow actions produced no measurable output at all: a
   * follow-only workflow reported zeros forever, and `withdraw_pending` had
   * nothing to show for itself.
   */
  it('reports follows and withdrawals in the analytics panel', async () => {
    const listId = await seededList('Counting', [
      { first: 'Count', last: 'One', company: 'Acme', slug: 'count-one' },
      { first: 'Count', last: 'Two', company: 'Widgets', slug: 'count-two' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Invite then follow',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: null }
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Counting');

    await runManagedCampaigns(db, WORKSPACE, NOW);
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='sent', recorded_at=? WHERE workspace_id=? AND kind='invite'`
      )
      .run(NOW.toISOString(), WORKSPACE);
    await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR));
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='sent', recorded_at=? WHERE workspace_id=? AND kind='follow'`
      )
      .run(at(2 * HOUR).toISOString(), WORKSPACE);
    // One invite went unanswered long enough to be taken back.
    await db
      .prepare(
        `UPDATE linkedin_actions SET status='withdrawn' WHERE workspace_id=? AND kind='invite' AND target_ref LIKE '%count-one%'`
      )
      .run(WORKSPACE);

    const analytics = await managedAnalytics(db, WORKSPACE, { campaignId });
    expect(analytics.followsSent).toBe(2);
    expect(analytics.invitesWithdrawn).toBe(1);
    expect(analytics.invitesSent).toBe(1);
    // No 'withdraw' ledger row was filed here, because nothing clicked
    // anything: the status was set by hand above. The two numbers are counted
    // off different rows on purpose -- see `withdrawalsPerformed`.
    expect(analytics.withdrawalsPerformed).toBe(0);
  });

  it('stops the workflow when the lead has already replied', async () => {
    const listId = await seededList('Replies', [
      { first: 'Answered', last: 'Lead', company: 'Acme', slug: 'answered-lead' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'View then follow',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Replies');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(1);
    await db
      .prepare(`UPDATE linkedin_actions SET status='replied', recorded_at=? WHERE workspace_id=?`)
      .run(NOW.toISOString(), WORKSPACE);

    await runManagedCampaigns(db, WORKSPACE, at(2 * HOUR));
    const member = (await members(campaignId))[0];
    expect(member.status).toBe('replied');
    expect(member.next_eligible_at).toBeNull();
    // The follow was never planned.
    expect((await actions()).filter((row) => row.kind === 'follow')).toHaveLength(0);
  });
});

/**
 * THE TICK AFTER THE PER-MEMBER TRANSACTIONS WERE HOISTED OUT OF THE LOOP.
 *
 * The loop opened a `db.transaction` per member and then spent six or seven
 * more round trips inside it on single-row UPDATEs; it now runs one
 * transaction per CAMPAIGN and flushes every member's resulting row state in
 * one `UPDATE ... FROM unnest`, plus one batched insert for manual tasks.
 *
 * The risk a batched write carries is that several members in one tick take
 * DIFFERENT branches and the flush writes one of them over another, so these
 * put several branches in a single tick and assert each member's own outcome.
 */
describe('one tick, several members, several branches', () => {
  it("writes each member's own outcome when one tick takes four different branches", async () => {
    const listId = await seededList('Mixed', [
      { first: 'Plans', last: 'Fine', company: 'Acme', slug: 'plans-fine' },
      { first: 'Already', last: 'Replied', company: 'Acme', slug: 'already-replied' },
      { first: 'Also', last: 'Plans', company: 'Acme', slug: 'also-plans' },
      { first: 'No', last: 'Url', company: 'Acme', slug: 'no-url' }
    ]);
    // The fourth contact loses its profile URL, which is the `failed` branch:
    // an action with no target is unclaimable, so the member is released
    // rather than left due forever.
    await db
      .prepare(
        'UPDATE linkedin_lead_contacts SET profile_url=NULL WHERE workspace_id=? AND profile_url LIKE ?'
      )
      .run(WORKSPACE, '%no-url%');

    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Mixed',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Mixed');

    // A ledger row that already replied, for the second contact only. The
    // target is read back from the list rather than retyped, so the assertion
    // is about the flush and not about URL spelling.
    const contacts = await listLeadContacts(db, WORKSPACE, listId);
    const alreadyReplied = contacts.find((contact) =>
      contact.profileUrl?.includes('already-replied')
    )?.profileUrl as string;
    await db
      .prepare(
        `
      INSERT INTO linkedin_actions (id, workspace_id, seat_key, kind, target_ref, status, recorded_at, source, replay_scope, created_at)
      VALUES ('lact_pre_reply', ?, 'owner', 'dm', ?, 'replied', ?, 'manual', 'legacy', ?)
    `
      )
      .run(WORKSPACE, alreadyReplied, NOW.toISOString(), NOW.toISOString());

    const result = await runManagedCampaigns(db, WORKSPACE, NOW);
    // Two profile views planned (the healthy members), one member
    // short-circuited on a reply, one excluded before admission -- and none of them
    // wrote over another in the single flush at the end of the tick.
    expect(result.actionsPlanned).toBe(2);
    expect(result.membersBlocked).toBe(0);

    const byContact = new Map(
      (
        await db
          .prepare(
            `
        SELECT l.profile_url, m.status, m.step_index
        FROM linkedin_campaign_members m
        JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
        WHERE m.workspace_id=? AND m.campaign_id=?
      `
          )
          .all<{ profile_url: string | null; status: string; step_index: number }>(
            WORKSPACE,
            campaignId
          )
      ).map((row) => [row.profile_url ?? 'none', row])
    );

    const forSlug = (slug: string) =>
      byContact.get(
        contacts.find((contact) => contact.profileUrl?.includes(slug))?.profileUrl ?? ''
      );
    expect(forSlug('plans-fine')).toMatchObject({ status: 'waiting', step_index: 1 });
    expect(forSlug('also-plans')).toMatchObject({ status: 'waiting', step_index: 1 });
    expect(forSlug('already-replied')).toMatchObject({ status: 'replied', step_index: 0 });
    expect(byContact.get('none')).toMatchObject({ status: 'excluded', step_index: 0 });
  });

  it('creates one manual task per member in a single tick, and parks each of them', async () => {
    const listId = await seededList('Humans', [
      { first: 'One', last: 'Person', company: 'Acme', slug: 'one-person' },
      { first: 'Two', last: 'Person', company: 'Acme', slug: 'two-person' },
      { first: 'Three', last: 'Person', company: 'Acme', slug: 'three-person' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Manual only',
          steps: [
            {
              id: 'ask',
              action: 'manual_message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { suggestedTemplate: 'Hi {{firstName}}' }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Manual only');

    const result = await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(result.manualTasksCreated).toBe(3);
    const tasks = (await listManualTasks(db, WORKSPACE)).filter(
      (task) => task.campaignId === campaignId
    );
    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.suggestedBody).sort()).toEqual([
      'Hi One',
      'Hi Three',
      'Hi Two'
    ]);
    expect(
      (await members(campaignId)).every(
        (member) => member.status === 'manual' && member.step_index === 0
      )
    ).toBe(true);

    // Re-ticking must not queue a second task for a member already waiting on
    // a human: the partial unique index refuses it and the count stays honest.
    const second = await runManagedCampaigns(db, WORKSPACE, at(HOUR));
    expect(second.manualTasksCreated).toBe(0);
    expect(
      (await listManualTasks(db, WORKSPACE)).filter((task) => task.campaignId === campaignId)
    ).toHaveLength(3);
  });

  it('records the A/B variant for each member without clobbering the others', async () => {
    // Two, not more: day 1 of a managed campaign is 20% of the seat's daily
    // message ceiling, so a third member would simply not be planned this tick
    // and the assertion would be about the ramp rather than about the flush.
    const listId = await seededList('Variants', [
      { first: 'Ay', last: 'One', company: 'Acme', slug: 'ay-one' },
      { first: 'Bee', last: 'Two', company: 'Acme', slug: 'bee-two' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Split',
          steps: [
            {
              id: 'msg',
              action: 'message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                variants: [
                  { id: 'a', body: 'Hello {{firstName}} (a)' },
                  { id: 'b', body: 'Hello {{firstName}} (b)' }
                ]
              }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Split');

    await runManagedCampaigns(db, WORKSPACE, NOW);
    const rows = await db
      .prepare(
        `
      SELECT m.assigned_variants, a.variant_id
      FROM linkedin_campaign_members m
      JOIN linkedin_actions a ON a.campaign_member_id = m.id AND a.workspace_id = m.workspace_id
      WHERE m.workspace_id=? AND m.campaign_id=?
    `
      )
      .all<{ assigned_variants: unknown; variant_id: string | null }>(WORKSPACE, campaignId);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const assigned =
        typeof row.assigned_variants === 'string'
          ? (JSON.parse(row.assigned_variants) as Record<string, string>)
          : (row.assigned_variants as Record<string, string>);
      // The member's stored choice and the row the worker will send must be
      // the same arm, for every member, in one batched flush.
      expect(assigned.msg).toBe(row.variant_id);
    }
  });

  it('stops the workflow for a reply logged against a target_ref carrying a tracking query', async () => {
    // `target_ref` is opaque: a harvested LinkedIn href carries
    // `?miniProfileUrn=...` every single time, so the ledger genuinely holds
    // `.../in/x?trk=y` for the person the contact list calls `.../in/x`. The
    // raw lower-cased comparison this used to do saw two different people and
    // sent the next scripted follow-up on top of a human answer.
    const listId = await seededList('Tracked', [
      { first: 'Tracked', last: 'Lead', company: 'Acme', slug: 'tracked-lead' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'View then follow',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            },
            {
              id: 'follow',
              action: 'follow',
              delayBefore: { amount: 1, unit: 'hours' },
              config: {}
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Tracked');

    // The exact spelling the contact list stores, plus a tracking query: the
    // point is that the two are one person and the comparison must say so.
    const contactUrl = (await listLeadContacts(db, WORKSPACE, listId))[0].profileUrl as string;
    // The tracked URL is a PARAMETER rather than a SQL literal, because
    // Db.prepare rewrites every question mark in a statement into a positional
    // placeholder -- including one inside a query string.
    await db
      .prepare(
        `
      INSERT INTO linkedin_actions (id, workspace_id, seat_key, kind, target_ref, status, recorded_at, source, replay_scope, created_at)
      VALUES ('lact_tracked', ?, 'owner', 'dm', ?, 'replied', ?, 'manual', 'legacy', ?)
    `
      )
      .run(WORKSPACE, `${contactUrl}?trk=nav`, NOW.toISOString(), NOW.toISOString());

    await runManagedCampaigns(db, WORKSPACE, NOW);
    expect((await members(campaignId))[0].status).toBe('replied');
    expect(await actions()).toHaveLength(1);
  });

  it('gates a message on acceptance and withdraws a request still pending after 30 days', async () => {
    const listId = await seededList('Conditional', [
      { first: 'Accepted', last: 'Lead', company: 'Acme', slug: 'accepted-lead' },
      { first: 'Pending', last: 'Lead', company: 'Acme', slug: 'pending-lead' }
    ]);
    const workflowId = (
      await saveWorkflow(
        db,
        {
          workspaceId: WORKSPACE,
          name: 'Accepted or withdraw',
          steps: [
            {
              id: 'invite',
              action: 'connection_request',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { message: '' }
            },
            {
              id: 'message',
              action: 'message',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                variants: [{ id: 'a', body: 'Thanks for connecting, {{first_name}}.' }],
                requiresAcceptedConnection: true
              }
            },
            {
              id: 'withdraw',
              action: 'withdraw_pending',
              delayBefore: { amount: 0, unit: 'hours' },
              config: { afterDays: 30 }
            }
          ]
        },
        NOW
      )
    ).id;
    const campaignId = await runningCampaign(listId, workflowId, 'Conditional');

    expect((await runManagedCampaigns(db, WORKSPACE, NOW)).actionsPlanned).toBe(2);
    const invites = (await actions()).filter((row) => row.kind === 'invite');
    const acceptedInvite = invites.find((row) => row.target_ref?.includes('accepted-lead'));
    const pendingInvite = invites.find((row) => row.target_ref?.includes('pending-lead'));
    expect(acceptedInvite).toBeDefined();
    expect(pendingInvite).toBeDefined();

    await db
      .prepare("UPDATE linkedin_actions SET status='accepted', recorded_at=? WHERE id=?")
      .run(at(HOUR).toISOString(), acceptedInvite!.id);
    await db
      .prepare("UPDATE linkedin_actions SET status='sent', recorded_at=? WHERE id=?")
      .run(NOW.toISOString(), pendingInvite!.id);

    // One day later, only the accepted connection gets the message.
    expect((await runManagedCampaigns(db, WORKSPACE, at(DAY))).actionsPlanned).toBe(1);
    let ledger = await actions();
    const messages = ledger.filter((row) => row.kind === 'dm');
    expect(messages).toHaveLength(1);
    expect(messages[0].target_ref).toContain('accepted-lead');

    // The accepted branch can finish its no-op withdrawal while the other lead
    // remains parked on the conditional message.
    await runManagedCampaigns(db, WORKSPACE, at(DAY + HOUR));
    let state = await members(campaignId);
    expect(
      state.find(
        (member) =>
          member.id ===
          ledger.find((row) => row.target_ref?.includes('accepted-lead') && row.kind === 'invite')
            ?.campaign_member_id
      )?.status
    ).toBe('completed');
    expect(
      state.find((member) => member.id === pendingInvite!.campaign_member_id)?.step_index
    ).toBe(1);

    // At 30 days the unaccepted branch skips the message, reaches cleanup, and
    // queues a withdrawal instead of ever sending a DM to that person.
    await runManagedCampaigns(db, WORKSPACE, at(31 * DAY));
    state = await members(campaignId);
    expect(
      state.find((member) => member.id === pendingInvite!.campaign_member_id)?.step_index
    ).toBe(2);
    await runManagedCampaigns(db, WORKSPACE, at(31 * DAY + HOUR));
    ledger = await actions();
    expect(
      ledger.filter((row) => row.kind === 'dm' && row.target_ref?.includes('pending-lead'))
    ).toHaveLength(0);
    const withdrawals = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_withdrawals WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(withdrawals?.total ?? 0).toBe(1);
    expect(
      (await members(campaignId)).find((member) => member.id === pendingInvite!.campaign_member_id)
        ?.status
    ).toBe('completed');
  });

  it('persists a workflow SLA as a ledger deadline without changing the planned slot', async () => {
    const listId = await seededList('SLA leads', [
      { first: 'Maya', last: 'SLA', company: 'Acme', slug: 'maya-sla' }
    ]);
    const wf = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'SLA workflow',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            sla: { amount: 2, unit: 'hours' },
            config: {}
          }
        ]
      },
      NOW
    );
    await runningCampaign(listId, wf.id, 'SLA campaign');
    const tick = await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(tick.actionsPlanned).toBe(1);
    const row = (await actions()).find((action) => action.workflow_step_id === 'view');
    expect(row?.planned_for).toBeTruthy();
    expect(row?.sla_deadline_at).toBeTruthy();
    expect(new Date(row!.sla_deadline_at!).getTime() - new Date(row!.planned_for!).getTime()).toBe(
      2 * HOUR
    );
  });
});
