import { appendDomainEvent } from '../control-plane/events.js';
import { id, type Db } from '../db.js';

/**
 * First-party events strong enough to enter Opportunity-lite immediately.
 *
 * Keep this list deliberately small. A scan, trial start, content engagement,
 * outbound email, or account score may justify attention, but none of those is
 * the buyer explicitly asking to evaluate/buy. They need a verified reply or
 * meeting before Trevra promotes them into pipeline.
 */
export const HIGH_INTENT_INBOUND_KINDS = new Set([
  'demo_request',
  'pilot_request',
  'enterprise_pilot_request',
  'pricing_request',
  'pricing_inquiry',
  'pricing_enquiry'
]);

export function isHighIntentInboundKind(kind: string): boolean {
  return HIGH_INTENT_INBOUND_KINDS.has(kind.trim().toLowerCase());
}

export interface QualifiedOpportunityAttribution {
  opportunityId: string;
  recommendationId: string;
  inboundSubmissionId: string;
  inboundKind: string;
  created: boolean;
}

export interface VerifiedReplyOpportunityAttribution {
  opportunityId: string;
  recommendationId: string;
  inboundMessageId: string;
  created: boolean;
}

/**
 * Materialize one qualified Opportunity-lite row when the recommendation's own
 * proof contains an explicit high-intent inbound request.
 *
 * The recommendation evidence is authoritative here; callers cannot pass a
 * free-form event kind and convince this function a weak signal was a demo
 * request. `origin_recommendation_id` is a durable uniqueness boundary, so a
 * recomputation/race resolves to the same commercial row.
 */
export async function ensureQualifiedOpportunityFromRecommendation(
  db: Db,
  workspaceId: string,
  recommendationId: string,
  now: Date = new Date()
): Promise<QualifiedOpportunityAttribution | null> {
  const requestRows = await db
    .prepare(
      `
      SELECT s.id,s.kind,s.received_at
      FROM recommendation_evidence e
      JOIN inbound_submissions s
        ON s.workspace_id=e.workspace_id AND s.id=e.source_id
      WHERE e.workspace_id=? AND e.recommendation_id=?
        AND e.source_type='inbound_submission'
      ORDER BY s.received_at DESC,s.id DESC
    `
    )
    .all<{ id: string; kind: string; received_at: string }>(workspaceId, recommendationId);
  const request = requestRows.find((row) => isHighIntentInboundKind(row.kind));
  if (!request) return null;

  const recommendation = await db
    .prepare(
      `
      SELECT r.person_id,r.account_id,r.title,p.name AS person_name,a.name AS account_name
      FROM recommendations r
      LEFT JOIN contacts p ON p.workspace_id=r.workspace_id AND p.id=r.person_id
      LEFT JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.account_id
      WHERE r.workspace_id=? AND r.id=? AND r.type='qualified_demand'
    `
    )
    .get<Record<string, unknown>>(workspaceId, recommendationId);
  if (!recommendation) return null;
  const personId = recommendation.person_id ? String(recommendation.person_id) : null;
  const accountId = recommendation.account_id ? String(recommendation.account_id) : null;
  if (!personId && !accountId) return null;

  const existing = await db
    .prepare(
      `SELECT id FROM opportunities
       WHERE workspace_id=? AND origin_recommendation_id=? LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, recommendationId);
  if (existing) {
    return {
      opportunityId: existing.id,
      recommendationId,
      inboundSubmissionId: request.id,
      inboundKind: request.kind,
      created: false
    };
  }

  const opportunityId = id('opp');
  const timestamp = now.toISOString();
  const accountName = String(recommendation.account_name ?? '').trim();
  const personName = String(recommendation.person_name ?? '').trim();
  const requestLabel = request.kind.replaceAll('_', ' ');
  const subject = accountName || personName || 'Qualified demand';
  const title = `${subject}: ${requestLabel}`;
  const inserted = await db
    .prepare(
      `
      INSERT INTO opportunities (
        id,workspace_id,person_id,account_id,title,stage,owner_type,owner_id,
        next_action,next_action_at,created_at,updated_at,closed_at,origin_recommendation_id
      ) VALUES (?,?,?,?,?,'qualified','system',NULL,?,NULL,?,?,NULL,?)
      ON CONFLICT (workspace_id,origin_recommendation_id) WHERE origin_recommendation_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `
    )
    .get<{ id: string }>(
      opportunityId,
      workspaceId,
      personId,
      accountId,
      title,
      'Respond to the explicit first-party request and agree the next commercial step.',
      timestamp,
      timestamp,
      recommendationId
    );

  const resolvedId =
    inserted?.id ??
    (
      await db
        .prepare(
          `SELECT id FROM opportunities
           WHERE workspace_id=? AND origin_recommendation_id=? LIMIT 1`
        )
        .get<{ id: string }>(workspaceId, recommendationId)
    )?.id;
  if (!resolvedId) throw new Error('Qualified opportunity could not be created or resolved.');

  if (inserted) {
    await appendDomainEvent(db, {
      workspaceId,
      streamType: 'opportunity',
      streamId: resolvedId,
      eventType: 'opportunity.created_from_qualified_demand',
      actorType: 'system',
      correlationId: recommendationId,
      payload: {
        recommendationId,
        inboundSubmissionId: request.id,
        inboundKind: request.kind,
        stage: 'qualified'
      }
    });
  }

  return {
    opportunityId: resolvedId,
    recommendationId,
    inboundSubmissionId: request.id,
    inboundKind: request.kind,
    created: Boolean(inserted)
  };
}

/**
 * Promote recommendation-attributed outreach only after a later provider-verified
 * human reply exists in the same canonical Person conversation.
 *
 * This is deliberately a weaker pipeline state than an explicit demo/pricing
 * request: a reply proves a commercial conversation exists, but it does not
 * prove qualification. The Opportunity therefore starts at `new`; a human or
 * later deterministic qualification step advances it.
 */
export async function promoteVerifiedDemandRepliesToOpportunities(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<VerifiedReplyOpportunityAttribution[]> {
  const rows = await db
    .prepare(
      `
      SELECT DISTINCT ON (r.id)
        r.id AS recommendation_id,r.person_id,r.account_id,r.title,
        p.name AS person_name,a.name AS account_name,
        inbound.id AS inbound_message_id,inbound.occurred_at AS inbound_at
      FROM recommendations r
      JOIN contacts p
        ON p.workspace_id=r.workspace_id AND p.id=r.person_id
      JOIN accounts a
        ON a.workspace_id=r.workspace_id AND a.id=r.account_id
      JOIN conversations c
        ON c.workspace_id=r.workspace_id AND c.person_id=r.person_id
      JOIN LATERAL (
        SELECT cm.occurred_at
        FROM conversation_messages cm
        WHERE cm.workspace_id=r.workspace_id
          AND cm.conversation_id=c.id
          AND cm.direction='outbound'
          AND cm.source_type IN ('qualified_demand_outreach','qualified_demand_reply')
          AND cm.source_id=r.id
        ORDER BY cm.occurred_at DESC,cm.created_at DESC,cm.id DESC
        LIMIT 1
      ) outbound ON TRUE
      JOIN LATERAL (
        SELECT cm.id,cm.occurred_at
        FROM conversation_messages cm
        WHERE cm.workspace_id=r.workspace_id
          AND cm.conversation_id=c.id
          AND cm.direction='inbound'
          AND cm.verification_status='verified'
          AND cm.outcome_kind='reply'
          AND cm.occurred_at>outbound.occurred_at
        ORDER BY cm.occurred_at ASC,cm.created_at ASC,cm.id ASC
        LIMIT 1
      ) inbound ON TRUE
      WHERE r.workspace_id=?
        AND r.type='qualified_demand'
        AND r.person_id IS NOT NULL
        AND r.account_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM opportunities o
          WHERE o.workspace_id=r.workspace_id
            AND o.origin_recommendation_id=r.id
        )
      ORDER BY r.id,inbound.occurred_at ASC,inbound.id ASC
      LIMIT 100
    `
    )
    .all<Record<string, unknown>>(workspaceId);

  const created: VerifiedReplyOpportunityAttribution[] = [];
  for (const row of rows) {
    const recommendationId = String(row.recommendation_id);
    const inboundMessageId = String(row.inbound_message_id);
    const opportunityId = id('opp');
    const timestamp = now.toISOString();
    const accountName = String(row.account_name ?? '').trim();
    const personName = String(row.person_name ?? '').trim();
    const title = `${accountName || personName || 'Demand'}: verified reply`;
    const inserted = await db
      .prepare(
        `
        INSERT INTO opportunities (
          id,workspace_id,person_id,account_id,title,stage,owner_type,owner_id,
          next_action,next_action_at,created_at,updated_at,closed_at,origin_recommendation_id
        ) VALUES (?,?,?,?,?,'new','system',NULL,?,NULL,?,?,NULL,?)
        ON CONFLICT (workspace_id,origin_recommendation_id) WHERE origin_recommendation_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `
      )
      .get<{ id: string }>(
        opportunityId,
        workspaceId,
        String(row.person_id),
        String(row.account_id),
        title,
        'Review the verified reply and qualify or disqualify the commercial opportunity.',
        timestamp,
        timestamp,
        recommendationId
      );
    if (!inserted) continue;

    await appendDomainEvent(db, {
      workspaceId,
      streamType: 'opportunity',
      streamId: inserted.id,
      eventType: 'opportunity.created_from_verified_demand_reply',
      actorType: 'system',
      correlationId: recommendationId,
      payload: {
        recommendationId,
        inboundMessageId,
        stage: 'new'
      }
    });
    created.push({
      opportunityId: inserted.id,
      recommendationId,
      inboundMessageId,
      created: true
    });
  }
  return created;
}
