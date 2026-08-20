import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { id } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import { executeConnectedAction } from './integration-service.js';
import { serializeAction } from './serializers.js';
import { notifyActionFailure } from './notifications.js';

function hashPayload(
  recipient: string,
  subject: string,
  body: string,
  structuredPayloadJson = '{}'
): string {
  return createHash('sha256')
    .update(JSON.stringify({ recipient, subject, body, structuredPayloadJson }))
    .digest('hex');
}

export async function prepareAction(db: Db, workspaceId: string, recommendationId: string) {
  return db.transaction(async (tx) => {
    const recommendation = await tx
      .prepare(
        `
        SELECT r.*,c.contact_name,c.email,c.name AS client_name,
          COALESCE(ws.sender_name,u.name,'Your team') AS sender_name
        FROM recommendations r
        JOIN clients c ON c.id=r.client_id AND c.workspace_id=r.workspace_id
        LEFT JOIN workspace_settings ws ON ws.workspace_id=r.workspace_id
        LEFT JOIN users u ON u.workspace_id=r.workspace_id
        WHERE r.id=? AND r.workspace_id=?
        FOR UPDATE OF r
      `
      )
      .get<Record<string, unknown>>(recommendationId, workspaceId);
    if (!recommendation) throw new Error('Recommendation not found');
    if (String(recommendation.type) !== 'stale_proposal') {
      throw new Error('Unsupported recommendation type');
    }

    const existing = await tx
      .prepare(
        `
        SELECT * FROM actions
        WHERE recommendation_id=? AND status IN ('draft','approved','scheduled','failed','executing')
        ORDER BY created_at DESC LIMIT 1
      `
      )
      .get<Record<string, unknown>>(recommendationId);
    if (existing) return serializeAction(existing);

    const firstName = String(recommendation.contact_name).split(' ')[0];
    const senderName = String(recommendation.sender_name || 'Your team');
    const type = 'email_draft' as const;
    const subject = 'Following up on our proposal'; // GTM follow-up only; no billing action types exist.
    const body = `Hi ${firstName},\n\nI wanted to follow up on the proposal I sent over. I’m happy to answer any questions or adjust the next steps.\n\nWould a quick 15-minute call this week be useful?\n\nBest,\n${senderName}`;

    let connection = await tx
      .prepare(
        `
        SELECT id,provider FROM connections
        WHERE workspace_id=? AND status='connected'
          AND provider IN ('gmail','google-mail','microsoft','outlook')
        ORDER BY is_demo ASC,updated_at DESC LIMIT 1
      `
      )
      .get<{ id: string; provider: string }>(workspaceId);
    const settings = await tx
      .prepare('SELECT demo_mode FROM workspace_settings WHERE workspace_id=?')
      .get<{ demo_mode?: number }>(workspaceId);
    if (!connection && Boolean(settings?.demo_mode)) {
      connection = await tx
        .prepare(
          "SELECT id,provider FROM connections WHERE workspace_id=? AND is_demo=1 AND status='connected' LIMIT 1"
        )
        .get<{ id: string; provider: string }>(workspaceId);
    }

    const actionId = id('act');
    const recipient = String(recommendation.email);
    const now = new Date().toISOString();
    const structuredPayloadJson = JSON.stringify({
      recommendationId,
      recommendationType: String(recommendation.type),
      clientId: String(recommendation.client_id),
      clientName: String(recommendation.client_name)
    });
    const payloadHash = hashPayload(recipient, subject, body, structuredPayloadJson);
    await tx
      .prepare(
        `
        INSERT INTO actions
          (id,workspace_id,recommendation_id,connection_id,type,recipient,subject,body,structured_payload_json,payload_hash,status,execution_provider,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `
      )
      .run(
        actionId,
        workspaceId,
        recommendationId,
        connection?.id ?? null,
        type,
        recipient,
        subject,
        body,
        structuredPayloadJson,
        payloadHash,
        'draft',
        connection?.provider ?? 'unconfigured',
        now,
        now
      );
    await audit(tx, workspaceId, 'system', null, 'action.prepared', 'action', actionId, {
      recommendationId,
      provider: connection?.provider ?? null
    });
    await appendDomainEvent(tx, {
      workspaceId,
      streamType: 'action',
      streamId: actionId,
      eventType: 'action.prepared',
      actorType: 'system',
      correlationId: recommendationId,
      payload: {
        recommendationId,
        type,
        recipient,
        subject,
        payloadHash,
        provider: connection?.provider ?? null
      }
    });
    const row = await tx
      .prepare('SELECT * FROM actions WHERE id=?')
      .get<Record<string, unknown>>(actionId);
    if (!row) throw new Error('Prepared action could not be loaded');
    return serializeAction(row);
  });
}

export async function approveAction(
  db: Db,
  workspaceId: string,
  userId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null }
) {
  return approve(db, workspaceId, actionId, input, {
    type: 'manual',
    userId,
    automationRuleId: null
  });
}

export async function approveActionByRule(
  db: Db,
  workspaceId: string,
  automationRuleId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null }
) {
  return approve(db, workspaceId, actionId, input, {
    type: 'delegated',
    userId: null,
    automationRuleId
  });
}

async function approve(
  db: Db,
  workspaceId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null },
  actor: { type: 'manual' | 'delegated'; userId: string | null; automationRuleId: string | null }
) {
  return db.transaction(async (tx) => {
    const action = await tx
      .prepare('SELECT * FROM actions WHERE id=? AND workspace_id=? FOR UPDATE')
      .get<Record<string, unknown>>(actionId, workspaceId);
    if (!action) throw new Error('Action not found');
    if (!['draft', 'failed'].includes(String(action.status)))
      throw new Error('Only draft or failed actions can be approved');
    const payloadHash = hashPayload(
      input.recipient,
      input.subject,
      input.body,
      String(action.structured_payload_json ?? '{}')
    );
    const now = new Date().toISOString();
    const scheduledFor = input.scheduledFor ?? null;
    const status =
      scheduledFor && new Date(scheduledFor).getTime() > Date.now() ? 'scheduled' : 'approved';

    await tx
      .prepare(
        'UPDATE actions SET recipient=?,subject=?,body=?,payload_hash=?,status=?,scheduled_for=?,last_error=NULL,updated_at=? WHERE id=?'
      )
      .run(
        input.recipient,
        input.subject,
        input.body,
        payloadHash,
        status,
        scheduledFor,
        now,
        actionId
      );
    // The approval's workspace is the ACTION's, read off the row this
    // transaction locked with `WHERE id=? AND workspace_id=?` a few lines up --
    // not `workspaceId` re-passed from the caller, and emphatically not
    // anything the approve request body carries. An approval is the record that
    // a specific tenant authorised a specific payload hash; deriving its tenant
    // from anywhere but the action it approves would let the record and the
    // thing it vouches for belong to different customers.
    await tx
      .prepare(
        'INSERT INTO approvals (id,workspace_id,action_id,user_id,automation_rule_id,approval_type,approved_payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        id('apr'),
        String(action.workspace_id),
        actionId,
        actor.userId,
        actor.automationRuleId,
        actor.type,
        payloadHash,
        now
      );
    await tx
      .prepare("UPDATE recommendations SET status='approved',updated_at=? WHERE id=?")
      .run(now, String(action.recommendation_id));
    await audit(
      tx,
      workspaceId,
      actor.type === 'manual' ? 'user' : 'automation',
      actor.userId ?? actor.automationRuleId,
      'action.approved',
      'action',
      actionId,
      { hash: payloadHash, scheduledFor }
    );
    await appendDomainEvent(tx, {
      workspaceId,
      streamType: 'action',
      streamId: actionId,
      eventType: scheduledFor ? 'action.scheduled' : 'action.approved',
      actorType: actor.type === 'manual' ? 'user' : 'automation',
      actorId: actor.userId ?? actor.automationRuleId,
      correlationId: String(action.recommendation_id),
      payload: { payloadHash, scheduledFor, recipient: input.recipient, subject: input.subject }
    });
    const updated = await tx
      .prepare('SELECT * FROM actions WHERE id=?')
      .get<Record<string, unknown>>(actionId);
    if (!updated) throw new Error('Approved action could not be loaded');
    return serializeAction(updated);
  });
}

export async function executeAction(db: Db, workspaceId: string, actionId: string) {
  const action = await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `
      SELECT a.*,r.type AS recommendation_type,r.source_key,r.client_id
      FROM actions a JOIN recommendations r ON r.id=a.recommendation_id
      WHERE a.id=? AND a.workspace_id=?
      FOR UPDATE OF a
    `
      )
      .get<Record<string, unknown>>(actionId, workspaceId);
    if (!row) throw new Error('Action not found');
    if (!['approved', 'scheduled'].includes(String(row.status)))
      throw new Error('Action requires approval');
    if (row.scheduled_for && new Date(String(row.scheduled_for)).getTime() > Date.now())
      throw new Error('Action is scheduled for later');
    // This lookup decides whether an external send is allowed to proceed, and
    // it used to select on `action_id` alone. An approval row mis-parented onto
    // this action -- one row, from any tenant, whose `approved_payload_hash`
    // happens to match -- was therefore enough to satisfy the check below. The
    // tenant guard makes the approval prove it belongs to the same workspace as
    // the action it releases. (`workspace_id IS NULL` covers approvals written
    // between 058 and this change; it goes away with the NOT NULL migration.)
    const approval = await tx
      .prepare(
        'SELECT * FROM approvals WHERE action_id=? AND (workspace_id IS NULL OR workspace_id=?) ORDER BY created_at DESC LIMIT 1'
      )
      .get<Record<string, unknown>>(actionId, workspaceId);
    if (!approval || approval.approved_payload_hash !== row.payload_hash)
      throw new Error('Approved payload no longer matches action payload');
    await tx
      .prepare("UPDATE actions SET status='executing',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), actionId);
    await appendDomainEvent(tx, {
      workspaceId,
      streamType: 'action',
      streamId: actionId,
      eventType: 'action.execution_started',
      actorType: 'system',
      correlationId: String(row.recommendation_id),
      payload: { provider: row.execution_provider, payloadHash: row.payload_hash }
    });
    return row;
  });

  try {
    const delivery = await executeConnectedAction(db, workspaceId, action);
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          "UPDATE actions SET status='executed',execution_provider=?,external_ref=?,executed_at=?,last_error=NULL,updated_at=? WHERE id=?"
        )
        .run(delivery.provider, delivery.externalRef, now, now, actionId);
      await tx
        .prepare("UPDATE recommendations SET status='completed',updated_at=? WHERE id=?")
        .run(now, String(action.recommendation_id));
      await audit(tx, workspaceId, 'system', null, 'action.executed', 'action', actionId, {
        provider: delivery.provider,
        externalRef: delivery.externalRef,
        recipient: String(action.recipient)
      });
      await appendDomainEvent(tx, {
        workspaceId,
        streamType: 'action',
        streamId: actionId,
        eventType: 'action.executed',
        actorType: 'system',
        correlationId: String(action.recommendation_id),
        payload: {
          provider: delivery.provider,
          externalRef: delivery.externalRef,
          recipient: String(action.recipient)
        }
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const firstFailure = await db.transaction(async (tx) => {
      const previous = await tx
        .prepare(
          "SELECT id FROM audit_events WHERE workspace_id=? AND event_type='action.failed' AND entity_type='action' AND entity_id=? LIMIT 1"
        )
        .get<{ id: string }>(workspaceId, actionId);
      await tx
        .prepare("UPDATE actions SET status='failed',last_error=?,updated_at=? WHERE id=?")
        .run(message, new Date().toISOString(), actionId);
      await audit(tx, workspaceId, 'system', null, 'action.failed', 'action', actionId, {
        error: message
      });
      await appendDomainEvent(tx, {
        workspaceId,
        streamType: 'action',
        streamId: actionId,
        eventType: 'action.failed',
        actorType: 'system',
        correlationId: String(action.recommendation_id),
        payload: { error: message }
      });
      return !previous;
    });
    if (firstFailure) {
      try {
        await notifyActionFailure(db, {
          workspaceId,
          actionType: String(action.type),
          recipient: String(action.recipient),
          messageSubject: String(action.subject),
          provider: String(action.execution_provider),
          error
        });
      } catch (notificationError) {
        console.error('Failed to deliver Trevra action-failure notification', notificationError);
      }
    }
    throw error;
  }

  const row = await db
    .prepare('SELECT * FROM actions WHERE id=?')
    .get<Record<string, unknown>>(actionId);
  if (!row) throw new Error('Executed action could not be loaded');
  return serializeAction(row);
}

async function audit(
  db: Db,
  workspaceId: string,
  actorType: string,
  actorId: string | null,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id('audit'),
      workspaceId,
      actorType,
      actorId,
      eventType,
      entityType,
      entityId,
      JSON.stringify(metadata),
      new Date().toISOString()
    );
}
