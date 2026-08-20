import type { Db } from './db.js';
import { id } from './db.js';

interface CandidateEvidence {
  sourceType: string;
  sourceId: string;
  label: string;
  category: 'request' | 'history' | 'supporting';
  excerpt: string;
  externalUrl?: string | null;
}

interface Candidate {
  sourceKey: string;
  type: 'stale_proposal';
  clientId: string;
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
  now = new Date()
): Promise<number> {
  const candidates = await detectStaleProposals(db, workspaceId, now);

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
            id,workspace_id,client_id,source_key,type,title,summary,
            confidence,urgency,priority_score,status,recommended_action,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
          candidate.clientId,
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
              (id,workspace_id,recommendation_id,source_type,source_id,label,category,external_url,excerpt,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
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
          (id,workspace_id,proof_pack_id,category,label,excerpt,source_type,source_id,external_url,sequence,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
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
        index,
        timestamp
      );
  }
}

async function detectStaleProposals(db: Db, workspaceId: string, now: Date): Promise<Candidate[]> {
  const rows = await db
    .prepare(
      `
      SELECT o.*,c.name AS client_name,
        (SELECT m.id FROM messages m
          WHERE m.workspace_id=o.workspace_id AND m.client_id=o.client_id AND m.direction='outbound'
          ORDER BY m.occurred_at DESC LIMIT 1) AS message_id,
        (SELECT m.body FROM messages m
          WHERE m.workspace_id=o.workspace_id AND m.client_id=o.client_id AND m.direction='outbound'
          ORDER BY m.occurred_at DESC LIMIT 1) AS message_body
      FROM opportunities o
      JOIN clients c ON c.id=o.client_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=? AND o.status='proposal_sent' AND o.proposal_sent_at IS NOT NULL
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
        excerpt: `Proposal was sent ${ageDays} days ago and remains marked proposal_sent.`
      }
    ];
    if (row.message_id && row.message_body) {
      evidence.push({
        sourceType: 'message',
        sourceId: String(row.message_id),
        label: 'Last outbound message',
        category: 'request',
        excerpt: String(row.message_body).slice(0, 320)
      });
    }

    return [
      {
        sourceKey: `opportunity:${row.id}:stale`,
        type: 'stale_proposal',
        clientId: String(row.client_id),
        title: `Follow up on ${row.client_name}`,
        summary: `This opportunity has had no recorded response for ${ageDays} days.`,
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
