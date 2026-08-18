import { afterEach, describe, expect, it, vi } from 'vitest';

const notificationMock = vi.hoisted(() => ({ notifyActionFailure: vi.fn(async () => undefined) }));
vi.mock('./notifications.js', () => notificationMock);
import { id, openDatabase, type Db } from './db.js';
import { approveAction, executeAction } from './action-service.js';

/**
 * `approvals` is the table that says a human released a specific payload for
 * sending, and until 058 it had no `workspace_id`. Its tenant was whatever
 * `actions` said, reachable only by joining -- so the row that authorises an
 * external send, and the row it authorises, could disagree about who they
 * belong to and nothing in the schema or the queries would notice.
 *
 * Both tests below are about that one gap: what `approveAction` writes carries
 * the action's tenant, and `executeAction` will not accept an approval from a
 * different one. The column is nullable at this stage, so the first test
 * asserts the value written rather than NOT NULL.
 */
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

/** A tenant with one client, one ready recommendation, and one draft action on it. */
async function seedTenant(database: Db, label: string): Promise<{
  workspaceId: string; userId: string; recommendationId: string; actionId: string;
}> {
  const now = new Date().toISOString();
  const workspaceId = id('ws');
  const userId = id('usr');
  const clientId = id('cl');
  const recommendationId = id('rec');
  const actionId = id('act');
  createdWorkspaces.push(workspaceId);
  await database.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, label, now);
  await database.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, workspaceId, `${userId}@example.test`, label, now);
  await database.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(clientId, workspaceId, `${label} client`, 'Contact Person', `${clientId}@example.test`, 'active', 5000, 'EUR', now, now);
  await database.prepare(`
    INSERT INTO recommendations (
      id,workspace_id,client_id,source_key,type,title,summary,estimated_amount,currency,
      confidence,urgency,priority_score,status,recommended_action,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(recommendationId, workspaceId, clientId, `invoice:${recommendationId}:overdue`, 'overdue_invoice',
    'Chase the invoice', 'One invoice is overdue.', 1850, 'EUR', 1, 1.2, 2220, 'ready',
    'Send a reminder.', now, now);
  await database.prepare(`
    INSERT INTO actions
      (id,workspace_id,recommendation_id,type,recipient,subject,body,structured_payload_json,payload_hash,status,execution_provider,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(actionId, workspaceId, recommendationId, 'email_draft', `${clientId}@example.test`,
    'Friendly reminder', 'The invoice is overdue.', '{}', null, 'draft', 'unconfigured', now, now);
  return { workspaceId, userId, recommendationId, actionId };
}

describe('workspace attribution on approvals', () => {
  it('stamps the approved action\'s workspace on the approval row', async () => {
    const database = await openTestDb();
    const tenant = await seedTenant(database, 'Approving tenant');

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, {
      recipient: 'billing@example.test', subject: 'Friendly reminder', body: 'The invoice is overdue.'
    });

    const approval = await database.prepare('SELECT workspace_id,approved_payload_hash FROM approvals WHERE action_id=?')
      .get<{ workspace_id: string | null; approved_payload_hash: string }>(tenant.actionId);
    expect(approval?.workspace_id).toBe(tenant.workspaceId);
    // The action's own hash was recomputed by the approval, so the two agree --
    // which is what `executeAction` checks, and what the next test denies to an
    // approval from somewhere else.
    const action = await database.prepare('SELECT payload_hash,status FROM actions WHERE id=?')
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

    // The owner's action is approved and ready to send, but the ONLY approval
    // row against it belongs to the stranger. Selecting on `action_id` alone
    // found it, its hash matched, and the send went out on another tenant's
    // authorisation -- the exact shape this change closes.
    await database.prepare("UPDATE actions SET status='approved',payload_hash=? WHERE id=?")
      .run(payloadHash, owner.actionId);
    await database.prepare('INSERT INTO approvals (id,workspace_id,action_id,user_id,approval_type,approved_payload_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id('apr'), stranger.workspaceId, owner.actionId, stranger.userId, 'manual', payloadHash, now);

    await expect(executeAction(database, owner.workspaceId, owner.actionId))
      .rejects.toThrow('Approved payload no longer matches action payload');
  });
});


describe('action failure notification', () => {
  it('alerts once on the first failed execution and does not spam on a retry of the same action', async () => {
    const database = await openTestDb();
    const tenant = await seedTenant(database, 'Failure notification tenant');

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, {
      recipient: 'billing@example.test', subject: 'Friendly reminder', body: 'The invoice is overdue.'
    });
    await expect(executeAction(database, tenant.workspaceId, tenant.actionId))
      .rejects.toThrow('Connect Gmail or Microsoft 365 before executing this action');

    expect(notificationMock.notifyActionFailure).toHaveBeenCalledTimes(1);
    expect(notificationMock.notifyActionFailure).toHaveBeenCalledWith(database, expect.objectContaining({
      workspaceId: tenant.workspaceId,
      actionType: 'email_draft',
      recipient: 'billing@example.test'
    }));

    await approveAction(database, tenant.workspaceId, tenant.userId, tenant.actionId, {
      recipient: 'billing@example.test', subject: 'Friendly reminder', body: 'The invoice is overdue.'
    });
    await expect(executeAction(database, tenant.workspaceId, tenant.actionId))
      .rejects.toThrow('Connect Gmail or Microsoft 365 before executing this action');

    expect(notificationMock.notifyActionFailure).toHaveBeenCalledTimes(1);
  });
});
