import type { Db } from './db.js';
import { id } from './db.js';
import { approveActionByRule, executeAction, prepareAction } from './action-service.js';

export interface AutomationResult {
  prepared: number;
  executed: number;
  failed: number;
}

export async function runAutomationCycle(db: Db, workspaceId: string): Promise<AutomationResult> {
  const result: AutomationResult = { prepared: 0, executed: 0, failed: 0 };
  const scheduled = await db.prepare(`
    SELECT id FROM actions
    WHERE workspace_id=? AND status='scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?
    ORDER BY scheduled_for LIMIT 50
  `).all<{ id: string }>(workspaceId, new Date().toISOString());
  for (const action of scheduled) {
    try {
      await executeAction(db, workspaceId, action.id);
      result.executed += 1;
    } catch {
      result.failed += 1;
    }
  }

  const rules = await db.prepare(`
    SELECT * FROM automation_rules WHERE workspace_id=? AND enabled=1 AND mode IN ('prepare','execute')
  `).all<Record<string, unknown>>(workspaceId);

  for (const rule of rules) {
    const recommendations = await db.prepare(`
      SELECT * FROM recommendations
      WHERE workspace_id=? AND type=? AND status IN ('ready','approved')
        AND confidence >= ? AND estimated_amount <= ?
        AND created_at + (? * INTERVAL '1 minute') <= CURRENT_TIMESTAMP
      ORDER BY priority_score DESC
    `).all<Record<string, unknown>>(
      workspaceId,
      String(rule.recommendation_type),
      Number(rule.min_confidence),
      Number(rule.max_amount),
      Number(rule.delay_minutes)
    );

    for (const recommendation of recommendations) {
      try {
        const action = await prepareAction(db, workspaceId, String(recommendation.id));
        if (action.status === 'draft' || action.status === 'failed') result.prepared += 1;
        if (rule.mode !== 'execute') continue;
        if (String(rule.recommendation_type) === 'scope_creep') continue;

        let approved = action;
        if (action.status === 'draft' || action.status === 'failed') {
          approved = await approveActionByRule(db, workspaceId, String(rule.id), action.id, {
            recipient: action.recipient,
            subject: action.subject,
            body: action.body
          });
        }
        if (approved.status === 'approved') {
          await executeAction(db, workspaceId, approved.id);
          result.executed += 1;
        }
      } catch (error) {
        result.failed += 1;
        await db.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id('audit'), workspaceId, 'automation', String(rule.id), 'automation.failed', 'recommendation', String(recommendation.id),
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), new Date().toISOString());
      }
    }
  }
  return result;
}

export async function runAllAutomationCycles(db: Db): Promise<void> {
  const workspaces = await db.prepare('SELECT id FROM workspaces').all<{ id: string }>();
  for (const workspace of workspaces) await runAutomationCycle(db, workspace.id);
}
