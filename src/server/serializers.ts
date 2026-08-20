import type { Db } from './db.js';
import type {
  AutomationRule,
  ConnectionSummary,
  PreparedAction,
  Recommendation
} from '../shared/types.js';

export async function listRecommendations(db: Db, workspaceId: string): Promise<Recommendation[]> {
  const rows = await db
    .prepare(
      `
    SELECT r.*, c.name AS client_name
    FROM recommendations r JOIN clients c ON c.id=r.client_id
    WHERE r.workspace_id=?
      AND r.status NOT IN ('dismissed','completed')
      AND (r.snoozed_until IS NULL OR r.snoozed_until <= CURRENT_TIMESTAMP)
    ORDER BY r.priority_score DESC, r.created_at DESC
  `
    )
    .all<Record<string, unknown>>(workspaceId);

  return Promise.all(
    rows.map(async (row) => {
      const evidenceRows = await db
        .prepare(
          `
      SELECT id,source_type,source_id,label,category,external_url,excerpt
      FROM recommendation_evidence WHERE recommendation_id=? ORDER BY created_at,id
    `
        )
        .all<Record<string, unknown>>(String(row.id));
      const proof = await db
        .prepare('SELECT id,summary,status FROM proof_packs WHERE recommendation_id=?')
        .get<Record<string, unknown>>(String(row.id));
      const action = await db
        .prepare(
          `
      SELECT * FROM actions WHERE recommendation_id=? AND status IN ('draft','approved','scheduled','failed')
      ORDER BY created_at DESC LIMIT 1
    `
        )
        .get<Record<string, unknown>>(String(row.id));
      const proofItems = proof
        ? await db
            .prepare(
              `
          SELECT id,source_type,source_id,label,category,external_url,excerpt
          FROM proof_pack_items WHERE proof_pack_id=? ORDER BY sequence
        `
            )
            .all<Record<string, unknown>>(String(proof.id))
        : [];

      return {
        id: String(row.id),
        type: row.type as Recommendation['type'],
        title: String(row.title),
        summary: String(row.summary),
        clientId: String(row.client_id),
        clientName: String(row.client_name),
        confidence: Number(row.confidence),
        urgency: Number(row.urgency),
        priorityScore: Number(row.priority_score),
        status: row.status as Recommendation['status'],
        recommendedAction: String(row.recommended_action),
        createdAt: String(row.created_at),
        snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null,
        evidence: serializeEvidence(evidenceRows),
        proofPack: proof
          ? {
              id: String(proof.id),
              summary: String(proof.summary),
              status: String(proof.status),
              items: serializeEvidence(proofItems)
            }
          : null,
        preparedAction: action ? serializeAction(action) : null
      };
    })
  );
}

export async function listConnections(db: Db, workspaceId: string): Promise<ConnectionSummary[]> {
  const rows = await db
    .prepare(
      `
    SELECT * FROM connections WHERE workspace_id=? AND status != 'disconnected'
    ORDER BY is_demo ASC, provider ASC
  `
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider),
    providerConfigKey: String(row.provider_config_key),
    displayName: row.display_name ? String(row.display_name) : null,
    status: String(row.status) as ConnectionSummary['status'],
    isDemo: Boolean(row.is_demo),
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    lastError: row.last_error ? String(row.last_error) : null
  }));
}

export async function listAutomationRules(db: Db, workspaceId: string): Promise<AutomationRule[]> {
  const rows = await db
    .prepare('SELECT * FROM automation_rules WHERE workspace_id=? ORDER BY recommendation_type')
    .all<Record<string, unknown>>(workspaceId);
  return rows.map((row) => ({
    id: String(row.id),
    recommendationType: String(row.recommendation_type) as AutomationRule['recommendationType'],
    mode: String(row.mode) as AutomationRule['mode'],
    minConfidence: Number(row.min_confidence),
    delayMinutes: Number(row.delay_minutes),
    enabled: Boolean(row.enabled)
  }));
}

export function serializeAction(row: Record<string, unknown>): PreparedAction {
  return {
    id: String(row.id),
    recommendationId: String(row.recommendation_id),
    type: String(row.type) as PreparedAction['type'],
    recipient: String(row.recipient),
    subject: String(row.subject),
    body: String(row.body),
    status: String(row.status) as PreparedAction['status'],
    executionProvider: String(row.execution_provider ?? 'unconfigured'),
    scheduledFor: row.scheduled_for ? String(row.scheduled_for) : null,
    externalRef: row.external_ref ? String(row.external_ref) : null,
    lastError: row.last_error ? String(row.last_error) : null
  };
}

function serializeEvidence(rows: Array<Record<string, unknown>>) {
  return rows.map((ev) => ({
    id: String(ev.id),
    sourceType: String(ev.source_type),
    sourceId: String(ev.source_id),
    label: String(ev.label ?? 'Evidence'),
    category: String(ev.category ?? 'supporting'),
    externalUrl: ev.external_url ? String(ev.external_url) : null,
    excerpt: String(ev.excerpt)
  }));
}
