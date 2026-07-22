import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { id } from './db.js';
import { executeConnectedAction, recordOutcome } from './integration-service.js';
import { serializeAction } from './serializers.js';

function hashPayload(recipient: string, subject: string, body: string, structuredPayloadJson = '{}'): string {
  return createHash('sha256').update(JSON.stringify({ recipient, subject, body, structuredPayloadJson })).digest('hex');
}

export function prepareAction(db: Db, workspaceId: string, recommendationId: string) {
  const recommendation = db.prepare(`
    SELECT r.*, c.contact_name, c.email, c.name AS client_name,
      COALESCE(ws.sender_name, u.name, 'Your freelancer') AS sender_name
    FROM recommendations r
    JOIN clients c ON c.id=r.client_id
    LEFT JOIN workspace_settings ws ON ws.workspace_id=r.workspace_id
    LEFT JOIN users u ON u.workspace_id=r.workspace_id
    WHERE r.id=? AND r.workspace_id=?
  `).get(recommendationId, workspaceId) as Record<string, unknown> | undefined;
  if (!recommendation) throw new Error('Recommendation not found');

  const existing = db.prepare("SELECT * FROM actions WHERE recommendation_id=? AND status IN ('draft','approved','scheduled','failed') ORDER BY created_at DESC LIMIT 1")
    .get(recommendationId) as Record<string, unknown> | undefined;
  if (existing) return serializeAction(existing);

  const firstName = String(recommendation.contact_name).split(' ')[0];
  const senderName = String(recommendation.sender_name || 'Your freelancer');
  let type: 'email_draft' | 'invoice_draft' | 'change_order_draft' = 'email_draft';
  let subject = '';
  let body = '';
  const amount = `${String(recommendation.currency)} ${Number(recommendation.estimated_amount).toLocaleString()}`;

  switch (recommendation.type) {
    case 'stale_proposal':
      subject = 'Following up on our proposal';
      body = `Hi ${firstName},\n\nI wanted to follow up on the proposal I sent over. I still have room to reserve the proposed start window, and I’m happy to answer any questions or adjust the next steps.\n\nWould a quick 15-minute call this week be useful?\n\nBest,\n${senderName}`;
      break;
    case 'scope_creep':
      type = 'change_order_draft';
      subject = 'Additional scope for the current project';
      body = `Hi ${firstName},\n\nHappy to add the requested work. Because it sits outside the agreed deliverables, I’ve scoped it as an additional ${amount}. This includes the added production and one review round.\n\nPlease confirm and I’ll add it to the project schedule.\n\nBest,\n${senderName}`;
      break;
    case 'unbilled_milestone':
      type = 'invoice_draft';
      subject = 'Invoice for completed milestone';
      body = `Hi ${firstName},\n\nThe final milestone is now complete. I’ve prepared the corresponding invoice for ${amount}.\n\nThank you again for the collaboration.\n\nBest,\n${senderName}`;
      break;
    case 'overdue_invoice':
      subject = 'Friendly reminder: invoice payment';
      body = `Hi ${firstName},\n\nA quick reminder that the ${amount} invoice is now overdue. Could you confirm that it reached the right person and let me know the expected payment date?\n\nI’m happy to resend any details you need.\n\nBest,\n${senderName}`;
      break;
    default:
      throw new Error('Unsupported recommendation type');
  }

  const providerFilter = type === 'invoice_draft'
    ? "provider IN ('quickbooks','xero','stripe')"
    : type === 'change_order_draft'
      ? "provider IN ('honeybook','bonsai','gmail','google-mail','microsoft','outlook')"
      : "provider IN ('gmail','google-mail','microsoft','outlook')";
  let connection = db.prepare(`
    SELECT id,provider FROM connections
    WHERE workspace_id=? AND status='connected' AND ${providerFilter}
    ORDER BY is_demo ASC, updated_at DESC LIMIT 1
  `).get(workspaceId) as { id: string; provider: string } | undefined;
  const demoMode = Boolean((db.prepare('SELECT demo_mode FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { demo_mode?: number } | undefined)?.demo_mode);
  if (!connection && demoMode) connection = db.prepare("SELECT id,provider FROM connections WHERE workspace_id=? AND is_demo=1 AND status='connected' LIMIT 1").get(workspaceId) as { id: string; provider: string } | undefined;

  const actionId = id('act');
  const recipient = String(recommendation.email);
  const now = new Date().toISOString();
  const structuredPayloadJson = JSON.stringify({
    recommendationId,
    recommendationType: String(recommendation.type),
    clientId: String(recommendation.client_id),
    clientName: String(recommendation.client_name),
    recipient,
    amount: Number(recommendation.estimated_amount),
    currency: String(recommendation.currency),
    description: String(recommendation.title),
    dueDays: 14
  });
  const payloadHash = hashPayload(recipient, subject, body, structuredPayloadJson);
  db.prepare(`
    INSERT INTO actions
      (id,workspace_id,recommendation_id,connection_id,type,recipient,subject,body,structured_payload_json,payload_hash,status,execution_provider,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(actionId, workspaceId, recommendationId, connection?.id ?? null, type, recipient, subject, body, structuredPayloadJson, payloadHash, 'draft', connection?.provider ?? (type === 'invoice_draft' ? 'accounting-required' : 'unconfigured'), now, now);
  audit(db, workspaceId, 'system', null, 'action.prepared', 'action', actionId, { recommendationId, provider: connection?.provider ?? null });
  return serializeAction(db.prepare('SELECT * FROM actions WHERE id=?').get(actionId) as Record<string, unknown>);
}

export function approveAction(
  db: Db,
  workspaceId: string,
  userId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null }
) {
  return approve(db, workspaceId, actionId, input, { type: 'manual', userId, automationRuleId: null });
}

export function approveActionByRule(
  db: Db,
  workspaceId: string,
  automationRuleId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null }
) {
  return approve(db, workspaceId, actionId, input, { type: 'delegated', userId: null, automationRuleId });
}

function approve(
  db: Db,
  workspaceId: string,
  actionId: string,
  input: { recipient: string; subject: string; body: string; scheduledFor?: string | null },
  actor: { type: 'manual' | 'delegated'; userId: string | null; automationRuleId: string | null }
) {
  const action = db.prepare('SELECT * FROM actions WHERE id=? AND workspace_id=?').get(actionId, workspaceId) as Record<string, unknown> | undefined;
  if (!action) throw new Error('Action not found');
  if (!['draft', 'failed'].includes(String(action.status))) throw new Error('Only draft or failed actions can be approved');
  const payloadHash = hashPayload(input.recipient, input.subject, input.body, String(action.structured_payload_json ?? '{}'));
  const now = new Date().toISOString();
  const scheduledFor = input.scheduledFor ?? null;
  const status = scheduledFor && new Date(scheduledFor).getTime() > Date.now() ? 'scheduled' : 'approved';

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE actions SET recipient=?,subject=?,body=?,payload_hash=?,status=?,scheduled_for=?,last_error=NULL,updated_at=? WHERE id=?')
      .run(input.recipient, input.subject, input.body, payloadHash, status, scheduledFor, now, actionId);
    db.prepare('INSERT INTO approvals (id,action_id,user_id,automation_rule_id,approval_type,approved_payload_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id('apr'), actionId, actor.userId, actor.automationRuleId, actor.type, payloadHash, now);
    db.prepare("UPDATE recommendations SET status='approved',updated_at=? WHERE id=?")
      .run(now, String(action.recommendation_id));
    audit(db, workspaceId, actor.type === 'manual' ? 'user' : 'automation', actor.userId ?? actor.automationRuleId, 'action.approved', 'action', actionId, { hash: payloadHash, scheduledFor });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return serializeAction(db.prepare('SELECT * FROM actions WHERE id=?').get(actionId) as Record<string, unknown>);
}

export async function executeAction(db: Db, workspaceId: string, actionId: string) {
  const action = db.prepare(`
    SELECT a.*, r.type AS recommendation_type, r.estimated_amount, r.currency, r.source_key, r.client_id
    FROM actions a JOIN recommendations r ON r.id=a.recommendation_id
    WHERE a.id=? AND a.workspace_id=?
  `).get(actionId, workspaceId) as Record<string, unknown> | undefined;
  if (!action) throw new Error('Action not found');
  if (!['approved', 'scheduled'].includes(String(action.status))) throw new Error('Action requires approval');
  if (action.scheduled_for && new Date(String(action.scheduled_for)).getTime() > Date.now()) throw new Error('Action is scheduled for later');
  const approval = db.prepare('SELECT * FROM approvals WHERE action_id=? ORDER BY created_at DESC LIMIT 1').get(actionId) as Record<string, unknown> | undefined;
  if (!approval || approval.approved_payload_hash !== action.payload_hash) throw new Error('Approved payload no longer matches action payload');

  const now = new Date().toISOString();
  try {
    db.prepare("UPDATE actions SET status='executing',updated_at=? WHERE id=?").run(now, actionId);
    const delivery = await executeConnectedAction(db, workspaceId, action);
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE actions SET status='executed',execution_provider=?,external_ref=?,executed_at=?,last_error=NULL,updated_at=? WHERE id=?")
        .run(delivery.provider, delivery.externalRef, now, now, actionId);
      db.prepare("UPDATE recommendations SET status='completed',updated_at=? WHERE id=?")
        .run(now, String(action.recommendation_id));
      audit(db, workspaceId, 'system', null, 'action.executed', 'action', actionId, { provider: delivery.provider, externalRef: delivery.externalRef, recipient: String(action.recipient) });
      const recommendationType = String(action.recommendation_type);
      if (recommendationType === 'unbilled_milestone') {
        const milestoneId = String(action.source_key).split(':')[1];
        const milestone = db.prepare(`
          SELECT m.*,p.id AS project_id,p.client_id FROM milestones m JOIN projects p ON p.id=m.project_id
          WHERE m.id=? AND p.workspace_id=?
        `).get(milestoneId, workspaceId) as Record<string, unknown> | undefined;
        if (milestone) {
          db.prepare('UPDATE milestones SET invoiced_at=?,status=? WHERE id=?').run(now, 'invoiced', milestoneId);
          const dueAt = new Date(new Date(now).getTime() + 14 * 86400000).toISOString();
          const invoiceExists = db.prepare('SELECT id FROM invoices WHERE workspace_id=? AND external_ref=?').get(workspaceId, delivery.externalRef);
          if (!invoiceExists) {
            db.prepare(`
              INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(id('inv'), workspaceId, String(milestone.client_id), String(milestone.project_id), delivery.externalRef,
              Number(action.estimated_amount), String(action.currency), 'sent', now, dueAt, null, now);
          }
        }
        recordOutcome(db, String(action.recommendation_id), 'revenue_invoiced', Number(action.estimated_amount), String(action.currency), { actionId, externalRef: delivery.externalRef });
      } else if (recommendationType === 'scope_creep') {
        recordOutcome(db, String(action.recommendation_id), 'change_order_issued', 0, String(action.currency), { actionId, externalRef: delivery.externalRef });
      } else {
        recordOutcome(db, String(action.recommendation_id), 'action_executed', 0, String(action.currency), { actionId, recommendationType, externalRef: delivery.externalRef });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE actions SET status='failed',last_error=?,updated_at=? WHERE id=?").run(message, new Date().toISOString(), actionId);
    audit(db, workspaceId, 'system', null, 'action.failed', 'action', actionId, { error: message });
    throw error;
  }

  return serializeAction(db.prepare('SELECT * FROM actions WHERE id=?').get(actionId) as Record<string, unknown>);
}

function audit(
  db: Db, workspaceId: string, actorType: string, actorId: string | null, eventType: string,
  entityType: string, entityId: string, metadata: Record<string, unknown>
): void {
  db.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id('audit'), workspaceId, actorType, actorId, eventType, entityType, entityId, JSON.stringify(metadata), new Date().toISOString());
}
