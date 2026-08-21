import { afterEach, describe, expect, it, vi } from 'vitest';

const notificationMock = vi.hoisted(() => ({ notifyActionFailure: vi.fn(async () => undefined) }));
vi.mock('./notifications.js', () => notificationMock);
import { id, openDatabase, type Db } from './db.js';
import { approveAction, executeAction } from './action-service.js';

let db: Db | undefined;
const createdWorkspaces: string[] = [];

afterEach(async () => {
  notificationMock.notifyActionFailure.mockClear();
  if (db) {
    for (const workspaceId of createdWorkspaces.splice(0)) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
    await db.close();
    db = undefined;
  }
});

async function openTestDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  return db;
}

/** A tenant with one GTM identity, one ready follow-up recommendation, and one draft action. */
async function seedTenant(
  database: Db,
  label: string
): Promise<{
  workspaceId: string;
  userId: string;
  recommendationId: string;
  actionId: string;
}> {
  const now = new Date().toISOString();
  const workspaceId = id('ws');
  const userId = id('usr');
  const personId = id('con');
  const recommendationId = id('rec');
  const actionId = id('act');
  createdWorkspaces.push(workspaceId);

  await database
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, label, now);
  await database
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, workspaceId, `${userId}@example.test`, label, now);
  await database
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      personId,
      workspaceId,
      'Contact Person',
      `${personId}@example.test`,
      `${personId}@example.test`,
      now,
      now
    );
  await database
    .prepare(
      `
      INSERT INTO recommendations (
        id,workspace_id,person_id,source_key,type,title,summary,
        confidence,urgency,priority_score,status,recommended_action,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      recommendationId,
      workspaceId,
      personId,
      `opportunity:${recommendationId}:stale`,
      'stale_proposal',
      'Follow up on the proposal',
      'The opportunity is waiting for a response.',
      1,
      1.2,
      1200,
      'ready',
      'Send a follow-up.',
      now,
      now
    );
  await database
    .prepare(
      `
      INSERT INTO actions
        (id,workspace_id,recommendation_id,type,recipient,subject,body,structured_payload_json,payload_hash,status,execution_provider,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      actionId,
      workspaceId,
      recommendationId,
      'email_draft',
      `${personId}@example.test`,
      'Proposal follow-up',
      'Checking whether there are any questions.',
      '{}',
      null,
      'draft',
      'unconfigured',
      now,
      now
    );
  return { workspaceId, userId, recommendationId, actionId };
}

describe('workspace attribution on approvals', () => {
  it('stamps the approved action workspace on the approval row', async () => {
    const database = await openTestDb();
    const tenant = await seedTenant(database, 'Approving tenant');

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, {
      recipient: 'lead@example.test',
      subject: 'Proposal follow-up',
      body: 'Checking whether there are any questions.'
    });

    const approval = await database
      .prepare('SELECT workspace_id,approved_payload_hash FROM approvals WHERE action_id=?')
      .get<{ workspace_id: string | null; approved_payload_hash: string }>(tenant.actionId);
    expect(approval?.workspace_id).toBe(tenant.workspaceId);

    const action = await database
      .prepare('SELECT payload_hash,status FROM actions WHERE id=?')
      .get<{ payload_hash: string; status: string }>(tenant.actionId);
    expect(action?.status).toBe('approved');
    expect(approval?.approved_payload_hash).toBe(action?.payload_hash);
  });

  it('refuses to execute on an approval that belongs to another workspace', async () => {
    const database = await openTestDb();
    const owner = await seedTenant(database, 'Owning tenant');
    const stranger = await seedTenant(database, 'Stranger tenant');
    const now = new Date().toISOString();
    const payloadHash = 'a'.repeat(64);

    await database
      .prepare("UPDATE actions SET status='approved',payload_hash=? WHERE id=?")
      .run(payloadHash, owner.actionId);
    await database
      .prepare(
        'INSERT INTO approvals (id,workspace_id,action_id,user_id,approval_type,approved_payload_hash,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        id('apr'),
        stranger.workspaceId,
        owner.actionId,
        stranger.userId,
        'manual',
        payloadHash,
        now
      );

    await expect(executeAction(database, owner.workspaceId, owner.actionId)).rejects.toThrow(
      'Approved payload no longer matches action payload'
    );
  });
});

describe('action failure notification', () => {
  it('alerts once on the first failed execution and does not spam on a retry of the same action', async () => {
    const database = await openTestDb();
    const tenant = await seedTenant(database, 'Failure notification tenant');
    const payload = {
      recipient: 'lead@example.test',
      subject: 'Proposal follow-up',
      body: 'Checking whether there are any questions.'
    };

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, payload);
    await expect(executeAction(database, tenant.workspaceId, tenant.actionId)).rejects.toThrow(
      'Connect Gmail or Microsoft 365 before executing this action'
    );

    expect(notificationMock.notifyActionFailure).toHaveBeenCalledTimes(1);
    expect(notificationMock.notifyActionFailure).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        workspaceId: tenant.workspaceId,
        actionType: 'email_draft',
        recipient: 'lead@example.test'
      })
    );

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, payload);
    await expect(executeAction(database, tenant.workspaceId, tenant.actionId)).rejects.toThrow(
      'Connect Gmail or Microsoft 365 before executing this action'
    );

    expect(notificationMock.notifyActionFailure).toHaveBeenCalledTimes(1);
  });
});
