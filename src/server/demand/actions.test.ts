import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_USER_ID,
  DEMO_WORKSPACE_ID,
  id,
  openDatabase,
  resetDemoData,
  type Db
} from '../db.js';
import { decidePlaybookApproval } from '../playbooks/engine.js';
import { prepareDemandAction } from './actions.js';

let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});
afterEach(async () => {
  await db?.close();
});

async function seedQualifiedDemand(label: string): Promise<{
  recommendationId: string;
  personId: string;
  accountId: string;
}> {
  const now = '2026-09-12T08:00:00.000Z';
  const personId = id('con');
  const accountId = id('acc');
  const recommendationId = id('rec');
  await db
    .prepare(
      `INSERT INTO contacts
       (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      personId,
      DEMO_WORKSPACE_ID,
      `${label} Person`,
      `${personId}@example.test`,
      `${personId}@example.test`,
      'VP Engineering',
      now,
      now
    );
  await db
    .prepare(
      `INSERT INTO accounts
       (id,workspace_id,name,domain,source,status,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,?)`
    )
    .run(
      accountId,
      DEMO_WORKSPACE_ID,
      `${label} Account`,
      `${accountId}.example.test`,
      'manual',
      now,
      now
    );
  await db
    .prepare(
      `INSERT INTO recommendations
       (id,workspace_id,person_id,account_id,source_key,type,title,summary,confidence,urgency,
        priority_score,status,recommended_action,created_at,updated_at)
       VALUES (?,?,?,?,?,'qualified_demand',?,?,?,?,?,'ready',?,?,?)`
    )
    .run(
      recommendationId,
      DEMO_WORKSPACE_ID,
      personId,
      accountId,
      `demand:${personId}:${accountId}`,
      `Talk to ${label} Person`,
      'Several independent commercial signals line up.',
      0.94,
      1.2,
      1128,
      'Prepare contextual outreach.',
      now,
      now
    );
  await db
    .prepare(
      `INSERT INTO recommendation_evidence
       (id,workspace_id,recommendation_id,source_type,source_id,label,category,external_url,excerpt,observed_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id('ev'),
      DEMO_WORKSPACE_ID,
      recommendationId,
      'account_signal',
      id('sig'),
      'hiring up',
      'supporting',
      `https://${accountId}.example.test/careers`,
      `${label} Account added six platform engineering roles.`,
      '2026-09-12T07:00:00.000Z',
      now
    );
  return { recommendationId, personId, accountId };
}

describe('qualified demand action preparation', () => {
  it('prepares one exact outreach approval, replays it, and attributes the sent message', async () => {
    const seeded = await seedQualifiedDemand('Outbound');
    const first = await prepareDemandAction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      actorUserId: DEMO_USER_ID,
      recommendationId: seeded.recommendationId
    });

    expect(first.mode).toBe('outreach');
    expect(first.run.playbookId).toBe('gtm.qualified-demand-email');
    expect(first.run.status).toBe('waiting_approval');
    const approval = first.run.steps.find((step) => step.stepId === 'approve-outreach');
    expect(approval?.input).toMatchObject({
      recipient: `${seeded.personId}@example.test`,
      metadata: {
        recommendationId: seeded.recommendationId,
        personId: seeded.personId,
        accountId: seeded.accountId,
        deliverySourceType: 'qualified_demand',
        deliverySourceId: seeded.recommendationId,
        conversationSourceType: 'qualified_demand_outreach',
        conversationSourceId: seeded.recommendationId
      }
    });
    expect(String((approval?.input as Record<string, unknown>)?.body ?? '')).toContain(
      'added six platform engineering roles'
    );

    const replay = await prepareDemandAction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      actorUserId: DEMO_USER_ID,
      recommendationId: seeded.recommendationId
    });
    expect(replay.run.id).toBe(first.run.id);

    const completed = await decidePlaybookApproval(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: first.run.id,
      stepId: 'approve-outreach',
      userId: DEMO_USER_ID,
      decision: 'approve'
    });
    expect(completed.status).toBe('completed');

    const recommendation = await db
      .prepare('SELECT status FROM recommendations WHERE workspace_id=? AND id=?')
      .get<{ status: string }>(DEMO_WORKSPACE_ID, seeded.recommendationId);
    expect(recommendation?.status).toBe('completed');

    const delivery = await db
      .prepare(
        'SELECT source_type,source_id,status FROM gtm_deliveries WHERE workspace_id=? AND source_type=? AND source_id=?'
      )
      .get<{ source_type: string; source_id: string; status: string }>(
        DEMO_WORKSPACE_ID,
        'qualified_demand',
        seeded.recommendationId
      );
    expect(delivery).toMatchObject({
      source_type: 'qualified_demand',
      source_id: seeded.recommendationId,
      status: 'sent'
    });

    const message = await db
      .prepare(
        `SELECT source_type,source_id,direction FROM conversation_messages
         WHERE workspace_id=? AND source_type='qualified_demand_outreach' AND source_id=?`
      )
      .get<{ source_type: string; source_id: string; direction: string }>(
        DEMO_WORKSPACE_ID,
        seeded.recommendationId
      );
    expect(message).toMatchObject({
      source_type: 'qualified_demand_outreach',
      source_id: seeded.recommendationId,
      direction: 'outbound'
    });
  });

  it('replies in the existing provider-backed email thread instead of starting a fresh email', async () => {
    const seeded = await seedQualifiedDemand('Reply');
    const conversationId = id('conv');
    const now = '2026-09-12T07:30:00.000Z';
    await db
      .prepare(
        `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(conversationId, DEMO_WORKSPACE_ID, seeded.personId, now, now, now);
    await db
      .prepare(
        `INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
          source_type,source_id,occurred_at,created_at
        ) VALUES (?,?,?,'email','gmail','inbound','Demo next week','Tuesday works for me.',
          'gmail:demand-inbound-1','campaign_email_reply','demand-inbound-1',?,?)`
      )
      .run(id('cmsg'), DEMO_WORKSPACE_ID, conversationId, now, now);

    const prepared = await prepareDemandAction(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      actorUserId: DEMO_USER_ID,
      recommendationId: seeded.recommendationId
    });

    expect(prepared.mode).toBe('reply');
    expect(prepared.run.playbookId).toBe('gtm.conversation-email-reply');
    const approval = prepared.run.steps.find((step) => step.stepId === 'approve-reply');
    expect(approval?.input).toMatchObject({
      subject: 'Re: Demo next week',
      metadata: {
        threaded: true,
        recommendationId: seeded.recommendationId,
        accountId: seeded.accountId,
        conversationId,
        personId: seeded.personId
      }
    });

    const completed = await decidePlaybookApproval(db, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: prepared.run.id,
      stepId: 'approve-reply',
      userId: DEMO_USER_ID,
      decision: 'approve'
    });
    expect(completed.status).toBe('completed');

    const projected = await db
      .prepare(
        `SELECT direction,source_type,source_id FROM conversation_messages
         WHERE workspace_id=? AND conversation_id=?
         ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`
      )
      .get<{ direction: string; source_type: string; source_id: string }>(
        DEMO_WORKSPACE_ID,
        conversationId
      );
    expect(projected).toMatchObject({
      direction: 'outbound',
      source_type: 'qualified_demand_reply',
      source_id: seeded.recommendationId
    });
  });

  it('refuses a new email when the latest verified conversation message is inbound on LinkedIn', async () => {
    const seeded = await seedQualifiedDemand('LinkedIn');
    const conversationId = id('conv');
    const now = '2026-09-12T07:30:00.000Z';
    await db
      .prepare(
        `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(conversationId, DEMO_WORKSPACE_ID, seeded.personId, now, now, now);
    await db
      .prepare(
        `INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel,provider,direction,body,external_ref,
          source_type,source_id,occurred_at,created_at
        ) VALUES (?,?,?,'linkedin','linkedin','inbound','Interested — send details.','li-msg-1',
          'linkedin_message','li-msg-1',?,?)`
      )
      .run(id('cmsg'), DEMO_WORKSPACE_ID, conversationId, now, now);

    await expect(
      prepareDemandAction(db, {
        workspaceId: DEMO_WORKSPACE_ID,
        actorUserId: DEMO_USER_ID,
        recommendationId: seeded.recommendationId
      })
    ).rejects.toMatchObject({ status: 409 });
  });
});
