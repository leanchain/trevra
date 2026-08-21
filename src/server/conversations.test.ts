import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { ingestCanonicalRecord } from './integration-service.js';
import { resolveContact } from './lead-capture/people.js';
import {
  listConversationMessages,
  listConversations,
  projectLinkedInThread
} from './conversations.js';

const WORKSPACE = 'ws_shared_conversations_test';
const NOW = new Date('2026-08-21T08:00:00.000Z');
let db: Db;

async function clearWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Shared Conversations', NOW.toISOString());
});

afterEach(async () => {
  if (db) await clearWorkspace(WORKSPACE);
  await db?.close();
});

describe('shared GTM conversations', () => {
  it('converges Gmail and LinkedIn messages for the same Person into one ordered transcript', async () => {
    await ingestCanonicalRecord(db, WORKSPACE, 'gmail', null, {
      kind: 'message',
      id: 'gmail-message-1',
      accountName: 'Acme',
      personName: 'Maya Chen',
      personEmail: 'maya@example.com',
      direction: 'outbound',
      subject: 'Hello',
      body: 'Email hello',
      occurredAt: '2026-08-21T07:00:00.000Z'
    });

    const person = await resolveContact(
      db,
      WORKSPACE,
      {
        name: 'Maya Chen',
        email: 'maya@example.com',
        linkedinUrl: 'https://www.linkedin.com/in/maya-shared/'
      },
      NOW
    );

    await db
      .prepare(
        `
        INSERT INTO linkedin_threads (
          id,workspace_id,seat_key,thread_urn,profile_url,name,last_message_at,unread,snippet,campaign_id,synced_at,created_at
        ) VALUES (?,?,?,?,?,?,?::timestamptz,TRUE,?,NULL,?::timestamptz,?::timestamptz)
      `
      )
      .run(
        'lthr_shared',
        WORKSPACE,
        'owner',
        'thread-shared',
        'https://www.linkedin.com/in/maya-shared/',
        'Maya Chen',
        '2026-08-21T07:30:00.000Z',
        'Interested — Friday works.',
        '2026-08-21T07:31:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `
        INSERT INTO linkedin_messages (
          id,workspace_id,thread_id,direction,body,sent_at,position,external_ref,action_id,created_at
        ) VALUES (?,?,?,'in',?,?::timestamptz,0,?,NULL,?::timestamptz)
      `
      )
      .run(
        'lmsg_shared',
        WORKSPACE,
        'lthr_shared',
        'Interested — Friday works.',
        '2026-08-21T07:30:00.000Z',
        'sha256:shared',
        '2026-08-21T07:31:00.000Z'
      );

    const conversationId = await projectLinkedInThread(db, WORKSPACE, 'lthr_shared', NOW);
    expect(conversationId).toBeTruthy();

    const conversations = await listConversations(db, WORKSPACE);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: conversationId,
      personId: person.contact.id,
      personName: 'Maya Chen',
      email: 'maya@example.com',
      linkedinUrl: 'https://www.linkedin.com/in/maya-shared/',
      channels: ['email', 'linkedin'],
      needsReply: true,
      latestMessage: {
        channel: 'linkedin',
        direction: 'inbound',
        body: 'Interested — Friday works.'
      }
    });

    const messages = await listConversationMessages(db, WORKSPACE, conversationId!);
    expect(messages.map((message) => [message.channel, message.direction, message.body])).toEqual([
      ['email', 'outbound', 'Email hello'],
      ['linkedin', 'inbound', 'Interested — Friday works.']
    ]);
  });

  it('keeps conversation reads workspace-scoped', async () => {
    const other = 'ws_shared_conversations_other';
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(other);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(other);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(other, 'Other', NOW.toISOString());
    try {
      await ingestCanonicalRecord(db, other, 'gmail', null, {
        kind: 'message',
        id: 'other-message',
        accountName: 'Other Co',
        personName: 'Other Person',
        personEmail: 'other@example.com',
        direction: 'inbound',
        subject: 'Other',
        body: 'Other workspace message',
        occurredAt: '2026-08-21T07:00:00.000Z'
      });
      expect(await listConversations(db, WORKSPACE)).toEqual([]);
    } finally {
      await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(other);
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(other);
    }
  });
});
