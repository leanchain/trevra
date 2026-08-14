import type { Db } from './db.js';
import { id } from './db.js';

interface CandidateEvidence {
  sourceType: string;
  sourceId: string;
  label: string;
  category: 'agreement' | 'request' | 'delivery' | 'billing' | 'history' | 'supporting';
  excerpt: string;
  externalUrl?: string | null;
}

interface Candidate {
  sourceKey: string;
  type: 'stale_proposal' | 'scope_creep' | 'unbilled_milestone' | 'overdue_invoice';
  clientId: string;
  title: string;
  summary: string;
  proofSummary: string;
  estimatedAmount: number;
  currency: string;
  confidence: number;
  urgency: number;
  recommendedAction: string;
  evidence: CandidateEvidence[];
}

const DAY = 86_400_000;

export async function runRecommendationEngine(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const candidates = [
    ...await detectStaleProposals(db, workspaceId, now),
    ...await detectScopeCreep(db, workspaceId),
    ...await detectUnbilledMilestones(db, workspaceId),
    ...await detectOverdueInvoices(db, workspaceId, now)
  ];

  await db.transaction(async (tx) => {
    for (const candidate of candidates) {
      const existing = await tx.prepare('SELECT id,status FROM recommendations WHERE workspace_id=? AND source_key=? FOR UPDATE')
        .get<{ id: string; status: string }>(workspaceId, candidate.sourceKey);
      if (existing && ['completed', 'dismissed'].includes(existing.status)) continue;

      const recommendationId = existing?.id ?? id('rec');
      const score = Math.round(candidate.estimatedAmount * candidate.confidence * candidate.urgency);
      const timestamp = now.toISOString();
      await tx.prepare(`
        INSERT INTO recommendations (
          id, workspace_id, client_id, source_key, type, title, summary,
          estimated_amount, currency, confidence, urgency, priority_score,
          status, recommended_action, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, source_key) DO UPDATE SET
          title=excluded.title,
          summary=excluded.summary,
          estimated_amount=excluded.estimated_amount,
          confidence=excluded.confidence,
          urgency=excluded.urgency,
          priority_score=excluded.priority_score,
          recommended_action=excluded.recommended_action,
          updated_at=excluded.updated_at
        WHERE recommendations.status NOT IN ('completed','dismissed')
      `).run(
        recommendationId, workspaceId, candidate.clientId, candidate.sourceKey, candidate.type,
        candidate.title, candidate.summary, candidate.estimatedAmount, candidate.currency,
        candidate.confidence, candidate.urgency, score, 'ready', candidate.recommendedAction,
        timestamp, timestamp
      );

      // 058 gave `recommendation_evidence`, `proof_packs` and `proof_pack_items`
      // a `workspace_id`, so this rewrite no longer trusts the parent id on its
      // own. `recommendation_id` alone is a cross-tenant predicate: if a row's
      // parent id ever points at another workspace's recommendation -- an import
      // bug, a restored backup, a hand-written UPDATE -- this DELETE would
      // silently destroy that tenant's evidence, and the INSERT that follows
      // would graft this tenant's evidence onto their recommendation.
      //
      // WHY `workspace_id IS NULL` IS STILL ACCEPTED. 058 deliberately stopped
      // short of `SET NOT NULL`, so rows written between that migration and
      // this change carry no attribution at all. Excluding them would leave the
      // old evidence undeleted and the engine would accumulate a duplicate set
      // on every run. The predicate collapses to a plain `AND workspace_id=?`
      // the day the NOT NULL migration lands; nothing else here has to change.
      await tx.prepare('DELETE FROM recommendation_evidence WHERE recommendation_id=? AND (workspace_id IS NULL OR workspace_id=?)')
        .run(recommendationId, workspaceId);
      for (const evidence of candidate.evidence) {
        // The workspace written here is the RECOMMENDATION's, not an ambient
        // default: `workspaceId` is the same value the upsert above stored on
        // `recommendations.workspace_id`, and the `SELECT ... WHERE
        // workspace_id=? AND source_key=?` that found `existing` proved an
        // existing recommendation carries it too.
        await tx.prepare(`
          INSERT INTO recommendation_evidence
            (id,workspace_id,recommendation_id,source_type,source_id,label,category,external_url,excerpt,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          id('ev'), workspaceId, recommendationId, evidence.sourceType, evidence.sourceId, evidence.label,
          evidence.category, evidence.externalUrl ?? null, evidence.excerpt, timestamp
        );
      }
      await upsertProofPack(tx, workspaceId, recommendationId, candidate.proofSummary, candidate.evidence, timestamp);
    }
  });
  return candidates.length;
}

/**
 * `workspaceId` is the recommendation's own tenant, threaded down rather than
 * re-derived: the caller located (or created) the recommendation under
 * `workspace_id=?`, so passing it here is the same fact, not a second guess.
 * Re-reading it from `recommendations` would be one more round trip inside the
 * transaction for a value the caller already holds.
 */
async function upsertProofPack(db: Db, workspaceId: string, recommendationId: string, summary: string, evidence: CandidateEvidence[], timestamp: string): Promise<void> {
  // Scoped for the same reason as the evidence rewrite: an existing pack whose
  // `recommendation_id` disagrees with its `workspace_id` must not hand this
  // run another tenant's pack id, because every `proof_pack_items` row below
  // would then be written under it.
  const existing = await db.prepare('SELECT id FROM proof_packs WHERE recommendation_id=? AND (workspace_id IS NULL OR workspace_id=?)')
    .get<{ id: string }>(recommendationId, workspaceId);
  const proofPackId = existing?.id ?? id('proof');
  // `workspace_id=excluded.workspace_id` in the DO UPDATE is not a no-op: it
  // repairs the NULL left on any pack written between 058 and this change,
  // using the only defensible value -- the workspace of the recommendation this
  // pack is unique on.
  await db.prepare(`
    INSERT INTO proof_packs (id,workspace_id,recommendation_id,summary,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(recommendation_id) DO UPDATE SET workspace_id=excluded.workspace_id,summary=excluded.summary,status='ready',updated_at=excluded.updated_at
  `).run(proofPackId, workspaceId, recommendationId, summary, 'ready', timestamp, timestamp);
  await db.prepare('DELETE FROM proof_pack_items WHERE proof_pack_id=? AND (workspace_id IS NULL OR workspace_id=?)')
    .run(proofPackId, workspaceId);
  for (const [index, item] of evidence.entries()) {
    await db.prepare(`
      INSERT INTO proof_pack_items
        (id,workspace_id,proof_pack_id,category,label,excerpt,source_type,source_id,external_url,sequence,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id('proofitem'), workspaceId, proofPackId, item.category, item.label, item.excerpt,
      item.sourceType, item.sourceId, item.externalUrl ?? null, index, timestamp
    );
  }
}

async function detectStaleProposals(db: Db, workspaceId: string, now: Date): Promise<Candidate[]> {
  const rows = await db.prepare(`
    SELECT o.*, c.name AS client_name,
      (SELECT m.id FROM messages m WHERE m.client_id=o.client_id AND m.direction='outbound' ORDER BY m.occurred_at DESC LIMIT 1) AS message_id,
      (SELECT m.body FROM messages m WHERE m.client_id=o.client_id AND m.direction='outbound' ORDER BY m.occurred_at DESC LIMIT 1) AS message_body
    FROM opportunities o JOIN clients c ON c.id=o.client_id
    WHERE o.workspace_id=? AND o.status='proposal_sent' AND o.proposal_sent_at IS NOT NULL
  `).all<Record<string, unknown>>(workspaceId);

  return rows.flatMap((row) => {
    const sentAt = new Date(String(row.proposal_sent_at));
    const ageDays = Math.floor((now.getTime() - sentAt.getTime()) / DAY);
    if (ageDays < 5) return [];
    const amount = Number(row.value);
    const evidence: CandidateEvidence[] = [{
      sourceType: 'opportunity', sourceId: String(row.id), label: 'Proposal status', category: 'history',
      excerpt: `Proposal worth ${row.currency} ${amount.toLocaleString()} was sent ${ageDays} days ago and remains marked proposal_sent.`
    }];
    if (row.message_id && row.message_body) evidence.push({
      sourceType: 'message', sourceId: String(row.message_id), label: 'Last proposal message', category: 'request',
      excerpt: String(row.message_body).slice(0, 320)
    });
    return [{
      sourceKey: `opportunity:${row.id}:stale`, type: 'stale_proposal', clientId: String(row.client_id),
      title: `Follow up on ${row.client_name} proposal`,
      summary: `The ${row.currency} ${amount.toLocaleString()} proposal has had no recorded response for ${ageDays} days.`,
      proofSummary: `Trevra found the proposal, its value, the last sent message, and the absence of a response after ${ageDays} days.`,
      estimatedAmount: amount, currency: String(row.currency), confidence: 0.9,
      urgency: ageDays >= 10 ? 1.25 : 1.1,
      recommendedAction: 'Send a concise availability-led follow-up now.', evidence
    } satisfies Candidate];
  });
}

async function detectScopeCreep(db: Db, workspaceId: string): Promise<Candidate[]> {
  // Every correlated subquery below used to reach `scope_items` and
  // `contract_clauses` through a PROJECT ID ALONE. `m` is workspace-scoped by
  // the outer WHERE, so the join looked safe -- but the tenant of a scope item
  // was never checked, only the tenant of the message that pointed at the same
  // project. A scope item or clause whose own workspace disagrees with its
  // project's would be read here and then quoted back to this tenant as
  // "agreed deliverables" and "your change-order clause" -- another customer's
  // contract text, pasted into an outgoing email.
  //
  // The guards compare against `m.workspace_id` rather than a new `?` on
  // purpose: it adds no parameter, so the single positional placeholder at the
  // bottom of this statement keeps its meaning (`normalizeSql` numbers `?` by
  // TEXT ORDER, and a placeholder added above the WHERE would renumber it).
  // `IS NULL` is the same transition allowance as the writers above: 058 left
  // the column nullable, and hiding un-backfilled rows would make the demo and
  // any mid-upgrade deployment stop detecting scope creep entirely.
  const rows = await db.prepare(`
    SELECT m.id, m.client_id, m.project_id, m.body, m.subject, c.name AS client_name, p.currency,
      (SELECT s.id FROM scope_items s WHERE s.project_id=m.project_id AND (s.workspace_id IS NULL OR s.workspace_id=m.workspace_id) AND s.included=1 ORDER BY s.created_at LIMIT 1) AS included_scope_id,
      (SELECT s.description FROM scope_items s WHERE s.project_id=m.project_id AND (s.workspace_id IS NULL OR s.workspace_id=m.workspace_id) AND s.included=1 ORDER BY s.created_at LIMIT 1) AS included_scope,
      (SELECT s.id FROM scope_items s WHERE s.project_id=m.project_id AND (s.workspace_id IS NULL OR s.workspace_id=m.workspace_id) AND s.included=0 ORDER BY s.unit_price DESC LIMIT 1) AS excluded_scope_id,
      (SELECT s.description FROM scope_items s WHERE s.project_id=m.project_id AND (s.workspace_id IS NULL OR s.workspace_id=m.workspace_id) AND s.included=0 ORDER BY s.unit_price DESC LIMIT 1) AS excluded_scope,
      COALESCE((SELECT MAX(unit_price) FROM scope_items s WHERE s.project_id=m.project_id AND (s.workspace_id IS NULL OR s.workspace_id=m.workspace_id) AND s.included=0), 500) AS unit_price,
      (SELECT cc.id FROM contract_clauses cc JOIN contracts ct ON ct.id=cc.contract_id AND ct.workspace_id=m.workspace_id WHERE ct.project_id=m.project_id AND (cc.workspace_id IS NULL OR cc.workspace_id=m.workspace_id) AND cc.clause_type='change_order' LIMIT 1) AS clause_id,
      (SELECT cc.content FROM contract_clauses cc JOIN contracts ct ON ct.id=cc.contract_id AND ct.workspace_id=m.workspace_id WHERE ct.project_id=m.project_id AND (cc.workspace_id IS NULL OR cc.workspace_id=m.workspace_id) AND cc.clause_type='change_order' LIMIT 1) AS clause_content
    FROM messages m
    JOIN clients c ON c.id=m.client_id
    JOIN projects p ON p.id=m.project_id
    WHERE m.workspace_id=? AND m.direction='inbound' AND m.project_id IS NOT NULL
  `).all<Record<string, unknown>>(workspaceId);

  const extraPattern = /\b(additional|extra|also create|one more|two more|outside scope|include those|could you also|add another)\b/i;
  return rows.flatMap((row) => {
    const body = String(row.body);
    if (!extraPattern.test(body)) return [];
    const quantityMatch = body.match(/\b(two|2|three|3|four|4|five|5)\b/i);
    const quantityWords: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
    const quantity = quantityMatch ? (quantityWords[quantityMatch[1].toLowerCase()] ?? Number(quantityMatch[1])) : 1;
    const amount = Number(row.unit_price) * (Number.isFinite(quantity) ? Number(quantity) : 1);
    const evidence: CandidateEvidence[] = [{ sourceType: 'message', sourceId: String(row.id), label: 'New client request', category: 'request', excerpt: body.slice(0, 360) }];
    if (row.included_scope_id && row.included_scope) evidence.push({ sourceType: 'scope_item', sourceId: String(row.included_scope_id), label: 'Agreed deliverables', category: 'agreement', excerpt: String(row.included_scope) });
    if (row.excluded_scope_id && row.excluded_scope) evidence.push({
      sourceType: 'scope_item', sourceId: String(row.excluded_scope_id), label: 'Pricing rule', category: 'agreement',
      excerpt: `${String(row.excluded_scope)} — ${row.currency} ${Number(row.unit_price).toLocaleString()} per item.`
    });
    if (row.clause_id && row.clause_content) evidence.push({ sourceType: 'contract_clause', sourceId: String(row.clause_id), label: 'Change-order clause', category: 'agreement', excerpt: String(row.clause_content) });
    return [{
      sourceKey: `message:${row.id}:scope-creep`, type: 'scope_creep', clientId: String(row.client_id),
      title: `Protect scope on ${row.client_name}`, summary: 'The client requested additional deliverables that are not included in the recorded scope.',
      proofSummary: `Trevra matched the new request against the signed scope and the recorded ${row.currency} ${Number(row.unit_price).toLocaleString()} unit price.`,
      estimatedAmount: amount, currency: String(row.currency), confidence: evidence.length >= 3 ? 0.96 : 0.88, urgency: 1.2,
      recommendedAction: `Send a friendly change order for ${row.currency} ${amount.toLocaleString()} before starting the extra work.`, evidence
    } satisfies Candidate];
  });
}

async function detectUnbilledMilestones(db: Db, workspaceId: string): Promise<Candidate[]> {
  // The tenant filter here was `p.workspace_id=?` -- the PROJECT's workspace,
  // never the milestone's, because until 058 the milestone had none. A
  // milestone that disagrees with its project would be turned into an
  // "invoice this now" recommendation for the wrong customer, carrying the
  // wrong amount. `m.workspace_id=p.workspace_id` states the invariant the
  // composite `(workspace_id, id)` FK will enforce once the column is NOT
  // NULL; the `IS NULL` arm is the transition allowance, and disappears with it.
  const rows = await db.prepare(`
    SELECT m.*, p.client_id, c.name AS client_name,
      (SELECT msg.id FROM messages msg WHERE msg.project_id=p.id AND msg.direction='outbound' AND msg.occurred_at >= m.delivered_at ORDER BY msg.occurred_at LIMIT 1) AS delivery_message_id,
      (SELECT msg.body FROM messages msg WHERE msg.project_id=p.id AND msg.direction='outbound' AND msg.occurred_at >= m.delivered_at ORDER BY msg.occurred_at LIMIT 1) AS delivery_message
    FROM milestones m
    JOIN projects p ON p.id=m.project_id
    JOIN clients c ON c.id=p.client_id
    WHERE p.workspace_id=? AND (m.workspace_id IS NULL OR m.workspace_id=p.workspace_id)
      AND m.status='delivered' AND m.invoiced_at IS NULL
  `).all<Record<string, unknown>>(workspaceId);
  return rows.map((row) => {
    const evidence: CandidateEvidence[] = [{
      sourceType: 'milestone', sourceId: String(row.id), label: 'Billable milestone', category: 'agreement',
      excerpt: `${String(row.name)} is worth ${row.currency} ${Number(row.amount).toLocaleString()} and is marked delivered.`
    }];
    if (row.delivery_message_id && row.delivery_message) evidence.push({ sourceType: 'message', sourceId: String(row.delivery_message_id), label: 'Delivery proof', category: 'delivery', excerpt: String(row.delivery_message).slice(0, 360) });
    evidence.push({ sourceType: 'invoice_check', sourceId: String(row.id), label: 'Missing invoice', category: 'billing', excerpt: `Delivered at ${row.delivered_at}; no invoice timestamp or linked invoice is recorded.` });
    return {
      sourceKey: `milestone:${row.id}:unbilled`, type: 'unbilled_milestone' as const, clientId: String(row.client_id),
      title: `Invoice the ${row.name} milestone`, summary: `${row.client_name}'s milestone is delivered and supported by delivery evidence, but no invoice is recorded.`,
      proofSummary: 'Trevra connected the agreed milestone amount to the delivery message and verified that no invoice exists.',
      estimatedAmount: Number(row.amount), currency: String(row.currency), confidence: row.delivery_message ? 0.99 : 0.97, urgency: 1.15,
      recommendedAction: 'Create the invoice and send it with the delivery reference.', evidence
    } satisfies Candidate;
  });
}

async function detectOverdueInvoices(db: Db, workspaceId: string, now: Date): Promise<Candidate[]> {
  const rows = await db.prepare(`
    SELECT i.*, c.name AS client_name,
      (SELECT COUNT(*) FROM payments p WHERE p.invoice_id=i.id) AS payment_count
    FROM invoices i JOIN clients c ON c.id=i.client_id
    WHERE i.workspace_id=? AND i.status IN ('sent','due','overdue','partially_paid') AND i.paid_at IS NULL
  `).all<Record<string, unknown>>(workspaceId);
  return rows.flatMap((row) => {
    const dueAt = new Date(String(row.due_at));
    const overdueDays = Math.floor((now.getTime() - dueAt.getTime()) / DAY);
    if (overdueDays <= 0) return [];
    const evidence: CandidateEvidence[] = [{
      sourceType: 'invoice', sourceId: String(row.id), label: 'Invoice obligation', category: 'billing',
      excerpt: `${row.external_ref ?? 'Invoice'} for ${row.currency} ${Number(row.amount).toLocaleString()} was due ${String(row.due_at).slice(0, 10)}.`
    }, {
      sourceType: 'payment_check', sourceId: String(row.id), label: 'No payment found', category: 'history',
      excerpt: `No completed payment is linked to this invoice; it is ${overdueDays} days overdue.`
    }];
    return [{
      sourceKey: `invoice:${row.id}:overdue`, type: 'overdue_invoice', clientId: String(row.client_id),
      title: `${row.external_ref ?? 'Invoice'} is ${overdueDays} days overdue`,
      summary: `${row.client_name} has an unpaid invoice for ${row.currency} ${Number(row.amount).toLocaleString()}.`,
      proofSummary: 'Trevra verified the invoice amount and due date and found no matching payment.',
      estimatedAmount: Number(row.amount), currency: String(row.currency), confidence: 1,
      urgency: overdueDays >= 14 ? 1.35 : 1.2,
      recommendedAction: 'Send a professional payment reminder with the invoice reference, due date, and request for a payment date.', evidence
    } satisfies Candidate];
  });
}
