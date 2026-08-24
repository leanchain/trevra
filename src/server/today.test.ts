import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createAccount } from './accounts/store.js';
import { pauseSeat, upsertSeat } from './linkedin/seats.js';
import { getToday } from './today.js';

const WORKSPACE = 'ws_today_projection_test';
const NOW = new Date('2026-08-21T08:00:00.000Z');
let db: Db;

async function clearWorkspace(workspaceId: string): Promise<void> {
  // inbound_submissions deliberately RESTRICTS deleting its canonical Person;
  // remove the evidence row first in test teardown, then let workspace cascades
  // clean the rest of the fixture graph.
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Today Projection', NOW.toISOString());
});

afterEach(async () => {
  if (db) await clearWorkspace(WORKSPACE);
  await db?.close();
});

describe('getToday', () => {
  it('projects durable GTM state into deterministic human-attention order', async () => {
    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Founder LinkedIn', timezone: 'Europe/Zurich' },
      new Date('2026-08-20T08:00:00.000Z')
    );
    await pauseSeat(
      db,
      WORKSPACE,
      'Challenge detected; inspect the account before resuming.',
      new Date('2026-08-21T07:00:00.000Z')
    );

    await db
      .prepare(
        `INSERT INTO linkedin_threads
         (id,workspace_id,seat_key,thread_urn,profile_url,name,last_message_at,unread,snippet,synced_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'lith_today_reply',
        WORKSPACE,
        'owner',
        'thread-today-reply',
        'https://www.linkedin.com/in/sarah-chen/',
        'Sarah Chen',
        '2026-08-21T07:10:00.000Z',
        true,
        'Interested — can you send details?',
        '2026-08-21T07:11:00.000Z',
        '2026-08-21T07:11:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_messages
         (id,workspace_id,thread_id,direction,body,sent_at,position,external_ref,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'limsg_today_reply',
        WORKSPACE,
        'lith_today_reply',
        'in',
        'Interested — can you send details?',
        '2026-08-21T07:10:00.000Z',
        1,
        'msg-today-reply',
        '2026-08-21T07:11:00.000Z'
      );

    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'con_today_inbound',
        WORKSPACE,
        'Maya Patel',
        'maya@example.com',
        'maya@example.com',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO capture_sources
         (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',0,0,?,?)`
      )
      .run(
        'cap_today',
        WORKSPACE,
        'Website',
        'website',
        'website',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,idempotency_key,kind,person_name,person_email,message,payload_hash,received_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sub_today',
        WORKSPACE,
        'cap_today',
        'con_today_inbound',
        'today-inbound-0001',
        'demo_request',
        'Maya Patel',
        'maya@example.com',
        'Would like a demo next week.',
        'hash-today',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );

    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'acme.example', name: 'Acme', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        92,
        'hot',
        2,
        '2026-08-21T07:30:00.000Z',
        '{}',
        '2026-08-21T07:31:00.000Z'
      );

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.working).toEqual([]);
    expect(today.recentResults).toEqual([]);
    expect(today.needsAttention.map((item) => item.kind)).toEqual([
      'safety_block',
      'verified_reply',
      'inbound_submission',
      'high_priority_account'
    ]);
    expect(today.needsAttention[0]).toMatchObject({
      href: '/setup/workspace',
      detail: 'Challenge detected; inspect the account before resuming.'
    });
    expect(today.needsAttention[1]).toMatchObject({
      href: '/outreach/inbox',
      title: 'Reply from Sarah Chen'
    });
    expect(today.needsAttention[2]).toMatchObject({
      href: '/outreach/inbound',
      reference: { type: 'inbound_submission', id: 'sub_today' }
    });
    expect(today.needsAttention[3]).toMatchObject({
      href: '/research',
      metadata: { score: 92 }
    });
  });

  it('never leaks another workspace into the projection', async () => {
    const other = 'ws_today_projection_other';
    await clearWorkspace(other);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(other, 'Other', NOW.toISOString());
    await upsertSeat(db, other, { label: 'Other LinkedIn', timezone: 'UTC' }, NOW);
    await pauseSeat(db, other, 'Other workspace pause', NOW);

    const today = await getToday(db, WORKSPACE, NOW);
    expect(today.needsAttention).toEqual([]);

    await clearWorkspace(other);
  });
});
