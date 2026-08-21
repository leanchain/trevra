import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from './db.js';
import { decidePlaybookApproval } from './playbooks/engine.js';
import { resolveContact } from './lead-capture/people.js';
import { listConversationMessages } from './conversations.js';
import { ConversationReplyError, prepareConversationEmailReply } from './conversation-replies.js';

let db: Db | undefined;

async function openTestDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  return db;
}

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe('conversation email reply preparation', () => {
  it('prepares one exact-payload approval, replays by idempotency key, and projects execution back into the transcript', async () => {
    const database = await openTestDb();
    const now = new Date('2026-08-21T09:00:00.000Z');
    const person = await resolveContact(
      database,
      DEMO_WORKSPACE_ID,
      { name: 'Reply Person', email: 'reply-person@example.com' },
      now
    );
    const conversationId = id('conv');
    await database
      .prepare(
        `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        conversationId,
        DEMO_WORKSPACE_ID,
        person.contact.id,
        '2026-08-20T08:55:00.000Z',
        '2026-08-20T08:00:00.000Z',
        '2026-08-20T08:55:00.000Z'
      );
    await database
      .prepare(
        `INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
          source_type,source_id,occurred_at,created_at
        ) VALUES (?,?,?,'email','gmail','inbound','Re: Demo','Friday works.','gmail:gmail-inbound-1',
          'campaign_email_reply','gmail:gmail-inbound-1',?,?)`
      )
      .run(
        id('cmsg'),
        DEMO_WORKSPACE_ID,
        conversationId,
        '2026-08-20T08:55:00.000Z',
        '2026-08-20T08:55:00.000Z'
      );

    const input = {
      workspaceId: DEMO_WORKSPACE_ID,
      actorUserId: DEMO_USER_ID,
      conversationId,
      idempotencyKey: 'reply-idempotency-001',
      subject: 'Re: Demo',
      body: 'Great — Friday at 10 works for me.'
    };
    const waiting = await prepareConversationEmailReply(database, input);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.playbookId).toBe('gtm.conversation-email-reply');
    expect(waiting.currentStepId).toBe('approve-reply');
    const approval = waiting.steps.find((step) => step.stepId === 'approve-reply');
    expect(approval?.input).toEqual({
      recipient: 'reply-person@example.com',
      subject: 'Re: Demo',
      body: 'Great — Friday at 10 works for me.',
      metadata: {
        threaded: true,
        threadExternalRef: 'gmail-inbound-1',
        threadIdempotencyKey: null,
        conversationId,
        personId: person.contact.id,
        deliveryPurpose: 'reply',
        deliverySourceType: 'conversation_reply',
        deliverySourceId: 'reply-idempotency-001',
        intent: 'conversation-email-reply'
      }
    });
    expect(approval?.approvalPayloadHash).toHaveLength(64);

    const replay = await prepareConversationEmailReply(database, input);
    expect(replay.id).toBe(waiting.id);

    await expect(
      prepareConversationEmailReply(database, { ...input, body: 'Different bytes' })
    ).rejects.toMatchObject({ status: 409 });

    const completed = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: waiting.id,
      stepId: 'approve-reply',
      userId: DEMO_USER_ID,
      decision: 'approve'
    });
    expect(completed.status).toBe('completed');
    expect(completed.steps.find((step) => step.stepId === 'send-reply')?.output).toMatchObject({
      provider: 'simulation',
      actionType: 'email.send'
    });

    const transcript = await listConversationMessages(database, DEMO_WORKSPACE_ID, conversationId);
    expect(transcript.map((message) => [message.direction, message.body])).toEqual([
      ['inbound', 'Friday works.'],
      ['outbound', 'Great — Friday at 10 works for me.']
    ]);
  });

  it('refuses to pretend a fresh email is a reply when no provider thread reference exists', async () => {
    const database = await openTestDb();
    const person = await resolveContact(database, DEMO_WORKSPACE_ID, {
      name: 'No Thread',
      email: 'no-thread@example.com'
    });
    const conversationId = id('conv');
    const now = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(conversationId, DEMO_WORKSPACE_ID, person.contact.id, now, now, now);

    await expect(
      prepareConversationEmailReply(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        actorUserId: DEMO_USER_ID,
        conversationId,
        idempotencyKey: 'reply-idempotency-002',
        subject: 'Re: Missing thread',
        body: 'This should not become a new email.'
      })
    ).rejects.toMatchObject({ status: 409 });
  });
});
