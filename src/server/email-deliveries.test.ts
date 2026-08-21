import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import {
  EmailDeliveryBlockedError,
  assertEmailDeliveryCapacity,
  claimEmailDelivery,
  markEmailDeliveryFailure,
  markEmailDeliverySent
} from './email-deliveries.js';

const WORKSPACE = 'ws_email_delivery_test';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Delivery test', new Date().toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

const input = (key = 'hash-1') => ({
  workspaceId: WORKSPACE,
  connectionId: null,
  purpose: 'outreach' as const,
  recipient: 'lead@example.test',
  sourceType: 'test_action',
  sourceId: 'action-1',
  idempotencyKey: key
});

describe('shared email delivery claim', () => {
  it('blocks a competing in-flight claim and replays a confirmed send', async () => {
    const first = await claimEmailDelivery(db, input());
    await expect(claimEmailDelivery(db, input())).rejects.toBeInstanceOf(EmailDeliveryBlockedError);

    await markEmailDeliverySent(db, first.delivery.id, {
      provider: 'gmail',
      externalRef: 'gmail-1',
      internetMessageId: '<hash-1@trevra.app>'
    });
    const replay = await claimEmailDelivery(db, input());
    expect(replay.replayed).toBe(true);
    expect(replay.delivery).toMatchObject({
      status: 'sent',
      provider: 'gmail',
      externalRef: 'gmail-1',
      internetMessageId: '<hash-1@trevra.app>',
      attemptCount: 1
    });
  });

  it('makes ambiguous provider outcomes terminal for automatic resend', async () => {
    const first = await claimEmailDelivery(db, input());
    const uncertain = await markEmailDeliveryFailure(
      db,
      first.delivery.id,
      new Error('socket closed')
    );
    expect(uncertain.status).toBe('uncertain');
    await expect(claimEmailDelivery(db, input())).rejects.toThrow(/requires reconciliation/i);
  });

  it('allows an explicit retry after a definite rejection and records the attempt', async () => {
    const first = await claimEmailDelivery(db, input());
    const rejected = await markEmailDeliveryFailure(
      db,
      first.delivery.id,
      new Error('HTTP 400 bad recipient')
    );
    expect(rejected.status).toBe('failed');
    const retry = await claimEmailDelivery(db, input());
    expect(retry).toMatchObject({
      replayed: false,
      delivery: { status: 'sending', attemptCount: 2 }
    });
  });

  it('refuses to mutate one source action onto a different approved payload', async () => {
    const first = await claimEmailDelivery(db, input());
    await markEmailDeliveryFailure(db, first.delivery.id, new Error('HTTP 400 rejected'));
    await expect(claimEmailDelivery(db, input('different-hash'))).rejects.toThrow(
      /different approved payload/i
    );
  });

  it('enforces the configured outreach cap while never consuming it for replies', async () => {
    const now = new Date();
    await db
      .prepare(
        `
      INSERT INTO connections (
        id,workspace_id,provider,provider_config_key,external_connection_id,status,is_demo,created_at,updated_at
      ) VALUES ('conn_cap',?,'gmail','trevra-gmail','cap-mailbox','connected',0,?,?)
    `
      )
      .run(WORKSPACE, now.toISOString(), now.toISOString());
    await db
      .prepare(
        `
      INSERT INTO linkedin_campaign_mailbox_settings (
        workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at
      ) VALUES (?, 'conn_cap',1,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)
    `
      )
      .run(WORKSPACE, now.toISOString(), now.toISOString());
    const first = await claimEmailDelivery(db, {
      ...input('cap-1'),
      connectionId: 'conn_cap',
      sourceId: 'cap-action-1'
    });
    await markEmailDeliverySent(
      db,
      first.delivery.id,
      { provider: 'gmail', externalRef: 'g-cap-1' },
      now
    );

    await expect(
      assertEmailDeliveryCapacity(
        db,
        {
          workspaceId: WORKSPACE,
          connectionId: 'conn_cap',
          purpose: 'outreach'
        },
        now
      )
    ).rejects.toThrow(/daily cap reached/i);
    await expect(
      assertEmailDeliveryCapacity(
        db,
        {
          workspaceId: WORKSPACE,
          connectionId: 'conn_cap',
          purpose: 'reply'
        },
        now
      )
    ).resolves.toBeUndefined();
  });
});
