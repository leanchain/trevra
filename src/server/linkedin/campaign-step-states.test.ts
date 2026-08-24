import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import { campaignQueueSummary, createManagedCampaign } from './managed-campaigns.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * "17 PENDING", AND NOT ONE OF THEM PENDING IN THE SAME SENSE.
 *
 * Reproduced from the live campaign an operator queried. Their card read:
 *
 *     1. View their profile        13 done   11 pending
 *     2. Send a connection request  0 done   17 pending
 *
 * The 17 were two populations the step card had merged. Five had a claimed
 * invite whose outcome could not be read back (`settlement_hold_at`), which the
 * reaper's `settlement_hold_at IS NULL` predicate puts permanently out of reach
 * of any browser -- they are waiting for a PERSON. Twelve had a healthy profile
 * view behind them and an invite that is simply not due until the next day,
 * because step 2 of their own workflow declares `delayBefore: 1 day`. The 11 on
 * step 1 were the third case and the only one the word ever fit: due now, and
 * genuinely queued for the browser.
 *
 * These tests pin the split at the only place it can be made honestly -- the
 * columns -- so no reader of `backlogByStep` has to guess again.
 */
let db: Db;

const WORKSPACE = 'ws_linkedin_campaign_step_states_test';
/** The instant the operator was looking at the card: 16:23 Europe/Zurich. */
const NOW = new Date('2026-08-24T14:23:39.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Campaign Step States Test', NOW.toISOString());
  for (const table of [
    'linkedin_actions',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_seats'
  ])
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE);
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

/** The live workflow: a profile view, then an invite a day later. */
async function campaignOf(handles: readonly string[]): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Step states' }, NOW);
  await importLeadCsv(
    db,
    {
      workspaceId: WORKSPACE,
      listId: list.id,
      csv: ['First Name,Last Name,Company,LinkedIn URL']
        .concat(
          handles.map((handle) => `${handle},Person,Acme,https://www.linkedin.com/in/${handle}/`)
        )
        .join('\n')
    },
    NOW
  );
  const workflow = await saveWorkflow(
    db,
    {
      workspaceId: WORKSPACE,
      name: 'View then invite',
      steps: [
        {
          id: 'step-1',
          action: 'profile_view',
          delayBefore: { amount: 0, unit: 'hours' },
          config: {}
        },
        {
          id: 'step-2',
          action: 'connection_request',
          delayBefore: { amount: 1, unit: 'days' },
          config: { message: 'Hi {{first_name}}' }
        }
      ]
    },
    NOW
  );
  const created = await createManagedCampaign(
    db,
    {
      workspaceId: WORKSPACE,
      name: 'View then invite',
      leadListId: list.id,
      workflowId: workflow.id
    },
    NOW
  );
  return created.campaign.id;
}

async function memberIds(campaignId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      'SELECT id FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? ORDER BY id'
    )
    .all<{ id: string }>(WORKSPACE, campaignId);
  return rows.map((row) => row.id);
}

/** Put a member on a step, waiting until a given instant. */
async function place(
  memberId: string,
  stepIndex: number,
  nextEligibleAt: Date | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET status='waiting',step_index=?,current_step_id=?,next_eligible_at=?::timestamptz,
           admitted_at=?::timestamptz
       WHERE workspace_id=? AND id=?`
    )
    .run(
      stepIndex,
      `step-${stepIndex + 1}`,
      nextEligibleAt?.toISOString() ?? null,
      NOW.toISOString(),
      WORKSPACE,
      memberId
    );
}

/**
 * One planned row against a member's current step.
 *
 * `settlementHoldAt` is the difference between a lead waiting for a browser and
 * a lead waiting for a human, and it is the only thing that distinguishes them
 * in the table -- both rows are 'planned' with a `claimed_at`.
 */
async function planAction(input: {
  id: string;
  campaignId: string;
  memberId: string;
  stepId: string;
  kind: string;
  handle: string;
  claimedAt?: Date;
  settlementHoldAt?: Date;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,campaign_id,campaign_member_id,workflow_step_id,
          status,planned_for,claimed_at,settlement_hold_at,failure_kind,source,created_at)
       VALUES (?,?,?,?,?,?,?,?,'planned',?,?,?,?,'campaign',?)`
    )
    .run(
      input.id,
      WORKSPACE,
      'owner',
      input.kind,
      `https://www.linkedin.com/in/${input.handle}/`,
      input.campaignId,
      input.memberId,
      input.stepId,
      NOW.toISOString(),
      input.claimedAt?.toISOString() ?? null,
      input.settlementHoldAt?.toISOString() ?? null,
      input.settlementHoldAt ? 'unknown' : null,
      NOW.toISOString()
    );
}

async function stepStates(campaignId: string) {
  const summary = await campaignQueueSummary(db, WORKSPACE, campaignId, NOW);
  return new Map(summary.backlogByStep.map((entry) => [entry.stepId, entry]));
}

describe('workflow step backlog states', () => {
  it('splits the live "17 pending" into 12 scheduled and 5 awaiting a person', async () => {
    const handles = Array.from({ length: 28 }, (_, index) => `lead${index + 1}`);
    const campaignId = await campaignOf(handles);
    const members = await memberIds(campaignId);

    // Step 1: eleven leads whose profile view is due now. The only population
    // "pending" was ever honest about.
    for (const memberId of members.slice(0, 11)) await place(memberId, 0, NOW);

    // Step 2, first population: five invites claimed, outcome unreadable,
    // parked. Their slot passed a day ago; no browser will ever return for them.
    for (const [offset, memberId] of members.slice(11, 16).entries()) {
      await place(memberId, 1, NOW);
      await planAction({
        id: `liact_held_${offset}`,
        campaignId,
        memberId,
        stepId: 'step-2',
        kind: 'invite',
        handle: `lead${12 + offset}`,
        claimedAt: NOW,
        settlementHoldAt: NOW
      });
    }

    // Step 2, second population: twelve leads whose profile view landed today,
    // so the step's own one-day gap puts their invite on tomorrow. No action row
    // exists for them at all yet -- there is nothing to plan until the slot.
    for (const [offset, memberId] of members.slice(16, 28).entries())
      await place(memberId, 1, new Date(Date.parse('2026-08-25T09:47:45.000Z') + offset * 60_000));

    const states = await stepStates(campaignId);
    expect(states.get('step-1')).toMatchObject({
      count: 11,
      due: 11,
      dueNow: 11,
      running: 0,
      scheduled: 0,
      scheduledFrom: null,
      awaitingDecision: 0
    });
    expect(states.get('step-2')).toMatchObject({
      count: 17,
      // `due` keeps its old, wider meaning: the five parked leads are still
      // sequence-eligible, which is what the capacity blocker asks about.
      due: 5,
      dueNow: 0,
      running: 0,
      scheduled: 12,
      scheduledFrom: '2026-08-25T09:47:45.000Z',
      awaitingDecision: 5
    });

    // Nothing is invented and nothing is lost: the four states account for the
    // whole step, which is what lets the card print a plain remainder instead of
    // guessing when they ever stop adding up.
    const step2 = states.get('step-2')!;
    expect(step2.dueNow + step2.running + step2.scheduled + step2.awaitingDecision).toBe(
      step2.count
    );
  });

  it('reports a leased row as in flight, not as work waiting for a browser', async () => {
    const campaignId = await campaignOf(['ada', 'grace']);
    const [running, queued] = await memberIds(campaignId);
    await place(running!, 0, NOW);
    await place(queued!, 0, NOW);
    await planAction({
      id: 'liact_running',
      campaignId,
      memberId: running!,
      stepId: 'step-1',
      kind: 'profile_view',
      handle: 'ada',
      claimedAt: NOW
    });
    await planAction({
      id: 'liact_queued',
      campaignId,
      memberId: queued!,
      stepId: 'step-1',
      kind: 'profile_view',
      handle: 'grace'
    });

    expect((await stepStates(campaignId)).get('step-1')).toMatchObject({
      count: 2,
      due: 2,
      dueNow: 1,
      running: 1,
      scheduled: 0,
      awaitingDecision: 0
    });
  });

  it('counts a lead the planner has not written a row for yet as due, not as missing', async () => {
    // BOOL_OR over no rows is NULL, and `NOT NULL` is NULL. Without the COALESCE
    // inside the lateral, every lead awaiting its first planned action would
    // vanish from all three buckets and reappear only in `count`.
    const campaignId = await campaignOf(['ada']);
    const [member] = await memberIds(campaignId);
    await place(member!, 0, null);

    expect((await stepStates(campaignId)).get('step-1')).toMatchObject({
      count: 1,
      due: 1,
      dueNow: 1,
      running: 0,
      scheduled: 0,
      awaitingDecision: 0
    });
  });

  it('takes the earliest slot on a step, not whichever row the group returned last', async () => {
    const campaignId = await campaignOf(['ada', 'grace', 'katherine']);
    const members = await memberIds(campaignId);
    await place(members[0]!, 1, new Date('2026-08-27T06:00:00.000Z'));
    await place(members[1]!, 1, new Date('2026-08-25T09:47:45.000Z'));
    await place(members[2]!, 1, new Date('2026-08-26T08:00:00.000Z'));

    expect((await stepStates(campaignId)).get('step-2')).toMatchObject({
      count: 3,
      due: 0,
      dueNow: 0,
      scheduled: 3,
      scheduledFrom: '2026-08-25T09:47:45.000Z'
    });
  });

  it('keeps a settled row from making a lead look parked', async () => {
    // Only a row that is still going to happen says anything about what a lead
    // is waiting for. A held row from a step the lead already passed is history.
    const campaignId = await campaignOf(['ada']);
    const [member] = await memberIds(campaignId);
    await place(member!, 1, new Date('2026-08-25T09:47:45.000Z'));
    await planAction({
      id: 'liact_settled',
      campaignId,
      memberId: member!,
      stepId: 'step-1',
      kind: 'profile_view',
      handle: 'ada',
      claimedAt: NOW,
      settlementHoldAt: NOW
    });
    await db
      .prepare("UPDATE linkedin_actions SET status='sent' WHERE workspace_id=? AND id=?")
      .run(WORKSPACE, 'liact_settled');

    expect((await stepStates(campaignId)).get('step-2')).toMatchObject({
      count: 1,
      scheduled: 1,
      awaitingDecision: 0
    });
  });
});
