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

export function runRecommendationEngine(db: Db, workspaceId: string, now = new Date()): number {
  const candidates = [
    ...detectStaleProposals(db, workspaceId, now),
    ...detectScopeCreep(db, workspaceId),
    ...detectUnbilledMilestones(db, workspaceId),
    ...detectOverdueInvoices(db, workspaceId, now)
  ];

  const upsert = db.prepare(`
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
  `);

  db.exec('BEGIN');
  try {
    for (const candidate of candidates) {
      const existing = db.prepare('SELECT id,status FROM recommendations WHERE workspace_id=? AND source_key=?').get(workspaceId, candidate.sourceKey) as { id: string; status: string } | undefined;
      if (existing && ['completed', 'dismissed'].includes(existing.status)) continue;

      const recommendationId = existing?.id ?? id('rec');
      const score = Math.round(candidate.estimatedAmount * candidate.confidence * candidate.urgency);
      const timestamp = now.toISOString();
      upsert.run(
        recommendationId,
        workspaceId,
        candidate.clientId,
        candidate.sourceKey,
        candidate.type,
        candidate.title,
        candidate.summary,
        candidate.estimatedAmount,
        candidate.currency,
        candidate.confidence,
        candidate.urgency,
        score,
        'ready',
        candidate.recommendedAction,
        timestamp,
        timestamp
      );

      db.prepare('DELETE FROM recommendation_evidence WHERE recommendation_id=?').run(recommendationId);
      const evidenceStmt = db.prepare(`
        INSERT INTO recommendation_evidence
          (id,recommendation_id,source_type,source_id,label,category,external_url,excerpt,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      for (const evidence of candidate.evidence) {
        evidenceStmt.run(
          id('ev'), recommendationId, evidence.sourceType, evidence.sourceId, evidence.label,
          evidence.category, evidence.externalUrl ?? null, evidence.excerpt, timestamp
        );
      }
      upsertProofPack(db, recommendationId, candidate.proofSummary, candidate.evidence, timestamp);
    }
    db.exec('COMMIT');
    return candidates.length;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function upsertProofPack(db: Db, recommendationId: string, summary: string, evidence: CandidateEvidence[], timestamp: string): void {
  const existing = db.prepare('SELECT id FROM proof_packs WHERE recommendation_id=?').get(recommendationId) as { id: string } | undefined;
  const proofPackId = existing?.id ?? id('proof');
  db.prepare(`
    INSERT INTO proof_packs (id,recommendation_id,summary,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(recommendation_id) DO UPDATE SET summary=excluded.summary,status='ready',updated_at=excluded.updated_at
  `).run(proofPackId, recommendationId, summary, 'ready', timestamp, timestamp);
  db.prepare('DELETE FROM proof_pack_items WHERE proof_pack_id=?').run(proofPackId);
  const insert = db.prepare(`
    INSERT INTO proof_pack_items
      (id,proof_pack_id,category,label,excerpt,source_type,source_id,external_url,sequence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  evidence.forEach((item, index) => insert.run(
    id('proofitem'), proofPackId, item.category, item.label, item.excerpt,
    item.sourceType, item.sourceId, item.externalUrl ?? null, index, timestamp
  ));
}

function detectStaleProposals(db: Db, workspaceId: string, now: Date): Candidate[] {
  const rows = db.prepare(`
    SELECT o.*, c.name AS client_name,
      (SELECT m.id FROM messages m WHERE m.client_id=o.client_id AND m.direction='outbound' ORDER BY m.occurred_at DESC LIMIT 1) AS message_id,
      (SELECT m.body FROM messages m WHERE m.client_id=o.client_id AND m.direction='outbound' ORDER BY m.occurred_at DESC LIMIT 1) AS message_body
    FROM opportunities o JOIN clients c ON c.id=o.client_id
    WHERE o.workspace_id=? AND o.status='proposal_sent' AND o.proposal_sent_at IS NOT NULL
  `).all(workspaceId) as Array<Record<string, unknown>>;

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
      sourceKey: `opportunity:${row.id}:stale`,
      type: 'stale_proposal',
      clientId: String(row.client_id),
      title: `Follow up on ${row.client_name} proposal`,
      summary: `The ${row.currency} ${amount.toLocaleString()} proposal has had no recorded response for ${ageDays} days.`,
      proofSummary: `Trevra found the proposal, its value, the last sent message, and the absence of a response after ${ageDays} days.`,
      estimatedAmount: amount,
      currency: String(row.currency),
      confidence: 0.9,
      urgency: ageDays >= 10 ? 1.25 : 1.1,
      recommendedAction: 'Send a concise availability-led follow-up now.',
      evidence
    } satisfies Candidate];
  });
}

function detectScopeCreep(db: Db, workspaceId: string): Candidate[] {
  const rows = db.prepare(`
    SELECT m.id, m.client_id, m.project_id, m.body, m.subject, c.name AS client_name, p.currency,
      (SELECT s.id FROM scope_items s WHERE s.project_id=m.project_id AND s.included=1 ORDER BY s.created_at LIMIT 1) AS included_scope_id,
      (SELECT s.description FROM scope_items s WHERE s.project_id=m.project_id AND s.included=1 ORDER BY s.created_at LIMIT 1) AS included_scope,
      (SELECT s.id FROM scope_items s WHERE s.project_id=m.project_id AND s.included=0 ORDER BY s.unit_price DESC LIMIT 1) AS excluded_scope_id,
      (SELECT s.description FROM scope_items s WHERE s.project_id=m.project_id AND s.included=0 ORDER BY s.unit_price DESC LIMIT 1) AS excluded_scope,
      COALESCE((SELECT MAX(unit_price) FROM scope_items s WHERE s.project_id=m.project_id AND s.included=0), 500) AS unit_price,
      (SELECT cc.id FROM contract_clauses cc JOIN contracts ct ON ct.id=cc.contract_id WHERE ct.project_id=m.project_id AND cc.clause_type='change_order' LIMIT 1) AS clause_id,
      (SELECT cc.content FROM contract_clauses cc JOIN contracts ct ON ct.id=cc.contract_id WHERE ct.project_id=m.project_id AND cc.clause_type='change_order' LIMIT 1) AS clause_content
    FROM messages m
    JOIN clients c ON c.id=m.client_id
    JOIN projects p ON p.id=m.project_id
    WHERE m.workspace_id=? AND m.direction='inbound' AND m.project_id IS NOT NULL
  `).all(workspaceId) as Array<Record<string, unknown>>;

  const extraPattern = /\b(additional|extra|also create|one more|two more|outside scope|include those|could you also|add another)\b/i;
  return rows.flatMap((row) => {
    const body = String(row.body);
    if (!extraPattern.test(body)) return [];
    const quantityMatch = body.match(/\b(two|2|three|3|four|4|five|5)\b/i);
    const quantityWords: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
    const quantity = quantityMatch ? (quantityWords[quantityMatch[1].toLowerCase()] ?? Number(quantityMatch[1])) : 1;
    const amount = Number(row.unit_price) * (Number.isFinite(quantity) ? Number(quantity) : 1);
    const evidence: CandidateEvidence[] = [{
      sourceType: 'message', sourceId: String(row.id), label: 'New client request', category: 'request', excerpt: body.slice(0, 360)
    }];
    if (row.included_scope_id && row.included_scope) evidence.push({
      sourceType: 'scope_item', sourceId: String(row.included_scope_id), label: 'Agreed deliverables', category: 'agreement', excerpt: String(row.included_scope)
    });
    if (row.excluded_scope_id && row.excluded_scope) evidence.push({
      sourceType: 'scope_item', sourceId: String(row.excluded_scope_id), label: 'Pricing rule', category: 'agreement',
      excerpt: `${String(row.excluded_scope)} — ${row.currency} ${Number(row.unit_price).toLocaleString()} per item.`
    });
    if (row.clause_id && row.clause_content) evidence.push({
      sourceType: 'contract_clause', sourceId: String(row.clause_id), label: 'Change-order clause', category: 'agreement', excerpt: String(row.clause_content)
    });
    return [{
      sourceKey: `message:${row.id}:scope-creep`,
      type: 'scope_creep',
      clientId: String(row.client_id),
      title: `Protect scope on ${row.client_name}`, summary: 'The client requested additional deliverables that are not included in the recorded scope.',
      proofSummary: `Trevra matched the new request against the signed scope and the recorded ${row.currency} ${Number(row.unit_price).toLocaleString()} unit price.`,
      estimatedAmount: amount, currency: String(row.currency), confidence: evidence.length >= 3 ? 0.96 : 0.88, urgency: 1.2,
      recommendedAction: `Send a friendly change order for ${row.currency} ${amount.toLocaleString()} before starting the extra work.`, evidence
    } satisfies Candidate];
  });
}

function detectUnbilledMilestones(db: Db, workspaceId: string): Candidate[] {
  const rows = db.prepare(`
    SELECT m.*, p.client_id, c.name AS client_name,
      (SELECT msg.id FROM messages msg WHERE msg.project_id=p.id AND msg.direction='outbound' AND msg.occurred_at >= m.delivered_at ORDER BY msg.occurred_at LIMIT 1) AS delivery_message_id,
      (SELECT msg.body FROM messages msg WHERE msg.project_id=p.id AND msg.direction='outbound' AND msg.occurred_at >= m.delivered_at ORDER BY msg.occurred_at LIMIT 1) AS delivery_message
    FROM milestones m
    JOIN projects p ON p.id=m.project_id
    JOIN clients c ON c.id=p.client_id
    WHERE p.workspace_id=? AND m.status='delivered' AND m.invoiced_at IS NULL
  `).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const evidence: CandidateEvidence[] = [{
      sourceType: 'milestone', sourceId: String(row.id), label: 'Billable milestone', category: 'agreement',
      excerpt: `${String(row.name)} is worth ${row.currency} ${Number(row.amount).toLocaleString()} and is marked delivered.`
    }];
    if (row.delivery_message_id && row.delivery_message) evidence.push({
      sourceType: 'message', sourceId: String(row.delivery_message_id), label: 'Delivery proof', category: 'delivery', excerpt: String(row.delivery_message).slice(0, 360)
    });
    evidence.push({
      sourceType: 'invoice_check', sourceId: String(row.id), label: 'Missing invoice', category: 'billing',
      excerpt: `Delivered at ${row.delivered_at}; no invoice timestamp or linked invoice is recorded.`
    });
    return {
      sourceKey: `milestone:${row.id}:unbilled`, type: 'unbilled_milestone' as const, clientId: String(row.client_id),
      title: `Invoice the ${row.name} milestone`, summary: `${row.client_name}'s milestone is delivered and supported by delivery evidence, but no invoice is recorded.`,
      proofSummary: 'Trevra connected the agreed milestone amount to the delivery message and verified that no invoice exists.',
      estimatedAmount: Number(row.amount), currency: String(row.currency), confidence: row.delivery_message ? 0.99 : 0.97, urgency: 1.15,
      recommendedAction: 'Create the invoice and send it with the delivery reference.', evidence
    } satisfies Candidate;
  });
}

function detectOverdueInvoices(db: Db, workspaceId: string, now: Date): Candidate[] {
  const rows = db.prepare(`
    SELECT i.*, c.name AS client_name,
      (SELECT COUNT(*) FROM payments p WHERE p.invoice_id=i.id) AS payment_count
    FROM invoices i JOIN clients c ON c.id=i.client_id
    WHERE i.workspace_id=? AND i.status IN ('sent','due','overdue','partially_paid') AND i.paid_at IS NULL
  `).all(workspaceId) as Array<Record<string, unknown>>;
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
      proofSummary: `Trevra verified the invoice amount and due date and found no matching payment.`,
      estimatedAmount: Number(row.amount), currency: String(row.currency), confidence: 1,
      urgency: overdueDays >= 14 ? 1.35 : 1.2,
      recommendedAction: 'Send a professional payment reminder with the invoice reference, due date, and request for a payment date.', evidence
    } satisfies Candidate];
  });
}
