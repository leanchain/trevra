import type { Db } from './db.js';
import { id } from './db.js';
import { prepareAction } from './action-service.js';
import { runRecommendationEngine } from './recommendation-engine.js';
import { listAutomationRules, listConnections, listRecommendations, serializeAction } from './serializers.js';

export async function getAgentRevenueBrief(db: Db, workspaceId: string) {
  await runRecommendationEngine(db, workspaceId);
  const [workspace, recommendations, connections, automationRules, pendingActions] = await Promise.all([
    db.prepare('SELECT id,name FROM workspaces WHERE id=?').get<{ id: string; name: string }>(workspaceId),
    listRecommendations(db, workspaceId),
    listConnections(db, workspaceId),
    listAutomationRules(db, workspaceId),
    listAgentPendingActions(db, workspaceId)
  ]);
  if (!workspace) throw new Error('Workspace not found');

  return {
    workspace,
    generatedAt: new Date().toISOString(),
    recommendations,
    pendingActions,
    connections,
    automationRules,
    instruction: 'Claude may inspect and prepare work. Approval and execution remain in the Trevra workspace.'
  };
}

export async function prepareRecommendationForAgent(
  db: Db,
  workspaceId: string,
  actorId: string,
  recommendationId: string
) {
  const action = await prepareAction(db, workspaceId, recommendationId);
  await db.prepare(`
    INSERT INTO audit_events (
      id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id('audit'), workspaceId, 'agent', actorId, 'agent.action_prepared',
    'action', action.id, JSON.stringify({ recommendationId }), new Date().toISOString()
  );
  return {
    action,
    instruction: 'The action is prepared only. A founder must review and approve the exact payload in Trevra before execution.'
  };
}

export async function listAgentPendingActions(db: Db, workspaceId: string) {
  const rows = await db.prepare(`
    SELECT * FROM actions
    WHERE workspace_id=? AND status IN ('draft','approved','scheduled','failed')
    ORDER BY updated_at DESC LIMIT 100
  `).all<Record<string, unknown>>(workspaceId);
  return rows.map(serializeAction);
}
