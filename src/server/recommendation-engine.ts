import type { Db } from './db.js';
import { id } from './db.js';
import { buildDemandCandidates } from './demand/candidates.js';
import { ensureQualifiedOpportunityFromRecommendation } from './demand/opportunities.js';

interface CandidateEvidence {
  sourceType: string;
  sourceId: string;
  label: string;
  category: 'request' | 'history' | 'supporting';
  excerpt: string;
  externalUrl?: string | null;
  observedAt?: string | null;
}

interface Candidate {
  sourceKey: string;
  type: 'stale_proposal' | 'qualified_demand' | 'person_discovery';
  personId: string | null;
  accountId: string | null;
  title: string;
  summary: string;
  proofSummary: string;
  confidence: number;
  urgency: number;
  priorityScore: number;
  recommendedAction: string;
  evidence: CandidateEvidence[];
}

const DAY = 86_400_000;

/**
 * GTM-only recommendation engine.
 *
 * The previous engine mixed GTM follow-up with project scope, milestones,
 * invoices and collections. Trevra no longer owns that post-sale graph. This
 * engine keeps the useful GTM behavior: surface opportunities that are waiting
 * too long for a response, backed by the message/evidence ledger. No project,
 * invoice, payment, contract, milestone, or revenue state participates here.
 */
export async function runRecommendationEngine(
  db: Db,
  workspaceId: string,
  now = new Date(),
  options: { includeStaleProposals?: boolean } = {}
): Promise<number> {
  const candidates = [
    ...(await detectQualifiedDemand(db, workspaceId, now)),
    ...(options.includeStaleProposals === false
      ? []
      : await detectStaleProposals(db, workspaceId, now))
  ];

  await db.transaction(async (tx) => {
    for (const candidate of candidates) {
      const existing = await tx
        .prepare(
          'SELECT id,status FROM recommendations WHERE workspace_id=? AND source_key=? FOR UPDATE'
        )
        .get<{ id: string; status: string }>(workspaceId, candidate.sourceKey);
      if (existing && ['completed', 'dismissed'].includes(existing.status)) continue;

      const recommendationId = existing?.id ?? id('rec');
      const timestamp = now.toISOString();
      await tx
        .prepare(
          `
          INSERT INTO recommendations (
            id,workspace_id,person_id,account_id,source_key,type,title,summary,
            confidence,urgency,priority_score,status,recommended_action,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,source_key) DO UPDATE SET
            title=excluded.title,
            summary=excluded.summary,
            confidence=excluded.confidence,
            urgency=excluded.urgency,
            priority_score=excluded.priority_score,
            recommended_action=excluded.recommended_action,
            updated_at=excluded.updated_at
          WHERE recommendations.status NOT IN ('completed','dismissed')
        `
        )
        .run(
          recommendationId,
          workspaceId,
          candidate.personId,
          candidate.accountId,
          candidate.sourceKey,
          candidate.type,
          candidate.title,
          candidate.summary,
          candidate.confidence,
          candidate.urgency,
          candidate.priorityScore,
          'ready',
          candidate.recommendedAction,
          timestamp,
          timestamp
        );

      await tx
        .prepare(
          'DELETE FROM recommendation_evidence WHERE recommendation_id=? AND (workspace_id IS NULL OR workspace_id=?)'
        )
        .run(recommendationId, workspaceId);
      for (const evidence of candidate.evidence) {
        await tx
          .prepare(
            `
            INSERT INTO recommendation_evidence
              (id,workspace_id,recommendation_id,source_type,source_id,label,category,external_url,excerpt,observed_at,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `
          )
          .run(
            id('ev'),
            workspaceId,
            recommendationId,
            evidence.sourceType,
            evidence.sourceId,
            evidence.label,
            evidence.category,
            evidence.externalUrl ?? null,
            evidence.excerpt,
            evidence.observedAt ?? null,
            timestamp
          );
      }
      await upsertProofPack(
        tx,
        workspaceId,
        recommendationId,
        candidate.proofSummary,
        candidate.evidence,
        timestamp
      );
      if (candidate.type === 'qualified_demand') {
        await ensureQualifiedOpportunityFromRecommendation(tx, workspaceId, recommendationId, now);
      }
    }
  });
  return candidates.length;
}

async function upsertProofPack(
  db: Db,
  workspaceId: string,
  recommendationId: string,
  summary: string,
  evidence: CandidateEvidence[],
  timestamp: string
): Promise<void> {
  const existing = await db
    .prepare(
      'SELECT id FROM proof_packs WHERE recommendation_id=? AND (workspace_id IS NULL OR workspace_id=?)'
    )
    .get<{ id: string }>(recommendationId, workspaceId);
  const proofPackId = existing?.id ?? id('proof');
  await db
    .prepare(
      `
      INSERT INTO proof_packs (id,workspace_id,recommendation_id,summary,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,summary=excluded.summary,status='ready',updated_at=excluded.updated_at
    `
    )
    .run(proofPackId, workspaceId, recommendationId, summary, 'ready', timestamp, timestamp);
  await db
    .prepare(
      'DELETE FROM proof_pack_items WHERE proof_pack_id=? AND (workspace_id IS NULL OR workspace_id=?)'
    )
    .run(proofPackId, workspaceId);
  for (const [index, item] of evidence.entries()) {
    await db
      .prepare(
        `
        INSERT INTO proof_pack_items
          (id,workspace_id,proof_pack_id,category,label,excerpt,source_type,source_id,external_url,observed_at,sequence,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `
      )
      .run(
        id('proofitem'),
        workspaceId,
        proofPackId,
        item.category,
        item.label,
        item.excerpt,
        item.sourceType,
        item.sourceId,
        item.externalUrl ?? null,
        item.observedAt ?? null,
        index,
        timestamp
      );
  }
}

async function detectQualifiedDemand(db: Db, workspaceId: string, now: Date): Promise<Candidate[]> {
  const demand = await buildDemandCandidates(db, workspaceId, now);
  return demand.map((candidate) => {
    const confidence = Math.min(
      0.98,
      0.75 +
        candidate.dimensions.firstPartyIntent * 0.1 +
        candidate.dimensions.accountIntent * 0.1 +
        candidate.dimensions.relationship * 0.05
    );
    const urgency = 1 + candidate.dimensions.recency * 0.4;
    return {
      sourceKey: candidate.sourceKey,
      type: candidate.recommendedAction === 'find_person' ? 'person_discovery' : 'qualified_demand',
      personId: candidate.personId,
      accountId: candidate.accountId,
      title: candidate.title,
      summary: candidate.summary,
      proofSummary: candidate.rationale.join('; '),
      confidence,
      urgency,
      priorityScore: Math.round(confidence * urgency * 1000),
      recommendedAction:
        candidate.recommendedAction === 'prepare_outreach'
          ? 'Prepare a contextual reply or outreach using the current person and account evidence.'
          : candidate.recommendedAction === 'find_person'
            ? 'Review and run the prepared person discovery; do not enroll anyone into outreach automatically.'
            : candidate.recommendedAction,
      evidence: candidate.evidence.map((item) => ({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        label: item.label,
        category: item.category,
        excerpt: item.excerpt,
        externalUrl: item.externalUrl ?? null,
        observedAt: item.observedAt
      }))
    } satisfies Candidate;
  });
}

async function detectStaleProposals(db: Db, workspaceId: string, now: Date): Promise<Candidate[]> {
  const rows = await db
    .prepare(
      `
      SELECT o.*,p.name AS person_name,p.email AS person_email,a.name AS account_name,
        (SELECT m.id FROM messages m
          WHERE m.workspace_id=o.workspace_id AND m.person_id=o.person_id AND m.direction='outbound'
          ORDER BY m.occurred_at DESC LIMIT 1) AS message_id,
        (SELECT m.body FROM messages m
          WHERE m.workspace_id=o.workspace_id AND m.person_id=o.person_id AND m.direction='outbound'
          ORDER BY m.occurred_at DESC LIMIT 1) AS message_body,
        (SELECT m.occurred_at FROM messages m
          WHERE m.workspace_id=o.workspace_id AND m.person_id=o.person_id AND m.direction='outbound'
          ORDER BY m.occurred_at DESC LIMIT 1) AS message_at
      FROM opportunities o
      JOIN contacts p ON p.id=o.person_id AND p.workspace_id=o.workspace_id
      LEFT JOIN accounts a ON a.id=o.account_id AND a.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND o.stage='proposal' AND o.proposal_sent_at IS NOT NULL
        AND p.email_normalized IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages inbound
          WHERE inbound.workspace_id=o.workspace_id
            AND inbound.person_id=o.person_id
            AND inbound.direction='inbound'
            AND inbound.occurred_at>o.proposal_sent_at
        )
    `
    )
    .all<Record<string, unknown>>(workspaceId);

  return rows.flatMap((row) => {
    const sentAt = new Date(String(row.proposal_sent_at));
    const ageDays = Math.floor((now.getTime() - sentAt.getTime()) / DAY);
    if (ageDays < 5) return [];

    const confidence = 0.9;
    const urgency = ageDays >= 10 ? 1.25 : 1.1;
    const evidence: CandidateEvidence[] = [
      {
        sourceType: 'opportunity',
        sourceId: String(row.id),
        label: 'Opportunity status',
        category: 'history',
        excerpt: `Proposal was sent ${ageDays} days ago and remains marked proposal_sent.`,
        observedAt: new Date(String(row.proposal_sent_at)).toISOString()
      }
    ];
    if (row.message_id && row.message_body) {
      evidence.push({
        sourceType: 'message',
        sourceId: String(row.message_id),
        label: 'Last outbound message',
        category: 'request',
        excerpt: String(row.message_body).slice(0, 320),
        observedAt: row.message_at ? new Date(String(row.message_at)).toISOString() : null
      });
    }

    return [
      {
        sourceKey: `opportunity:${row.id}:stale`,
        type: 'stale_proposal',
        personId: String(row.person_id),
        accountId: row.account_id ? String(row.account_id) : null,
        title: `Follow up with ${row.person_name ?? row.person_email}`,
        summary: `${row.account_name ? `${row.account_name}: ` : ''}this opportunity has had no verified inbound response for ${ageDays} days.`,
        proofSummary: `Trevra found the open proposal state, the latest outbound message, and no recorded response after ${ageDays} days.`,
        confidence,
        urgency,
        priorityScore: Math.round(confidence * urgency * 1000),
        recommendedAction: 'Send a concise follow-up and ask for the next decision.',
        evidence
      } satisfies Candidate
    ];
  });
}
