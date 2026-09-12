import type { Db } from '../db.js';
import { ensureConversationForPerson } from '../conversations.js';
import { prepareConversationEmailReply } from '../conversation-replies.js';
import { getPlaybookRun, startPlaybookRun } from '../playbooks/engine.js';
import type { PlaybookRun } from '../playbooks/types.js';

const OUTREACH_PLAYBOOK = 'gtm.qualified-demand-email';
const REPLY_PLAYBOOK = 'gtm.conversation-email-reply';

export class DemandActionError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export interface PreparedDemandAction {
  mode: 'reply' | 'outreach';
  run: PlaybookRun;
}

interface RecommendationRow {
  id: string;
  type: string;
  status: string;
  person_id: string | null;
  account_id: string | null;
  person_name: string | null;
  person_email: string | null;
  account_name: string | null;
  account_domain: string | null;
  sender_name: string | null;
}

interface EvidenceRow {
  source_type: string;
  source_id: string;
  label: string;
  excerpt: string;
  external_url: string | null;
  observed_at: string | null;
}

function firstName(row: RecommendationRow): string {
  return (row.person_name ?? row.person_email ?? 'there').trim().split(/\s+/)[0] || 'there';
}

function senderName(row: RecommendationRow): string {
  return row.sender_name?.trim() || 'Your team';
}

function compact(value: string, max = 320): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function reSubject(subject: string | null, accountName: string): string {
  const clean = subject?.trim() || accountName;
  return /^re\s*:/i.test(clean) ? clean.slice(0, 200) : `Re: ${clean}`.slice(0, 200);
}

function outboundDraft(
  row: RecommendationRow,
  evidence: EvidenceRow[]
): { subject: string; body: string } {
  const account = row.account_name?.trim() || row.account_domain?.trim() || 'your team';
  const signal = evidence.find((item) => item.source_type === 'account_signal');
  if (!signal) {
    throw new DemandActionError(
      'This recommendation has no source-backed account observation to write from.',
      409
    );
  }
  const subject = `${account}: ${signal.label}`.replace(/\s+/g, ' ').slice(0, 200);
  const body = [
    `Hi ${firstName(row)},`,
    compact(signal.excerpt),
    'It looked worth comparing notes while this is current. Would a quick 15-minute call this week be useful?',
    `Best,\n${senderName(row)}`
  ].join('\n\n');
  return { subject, body };
}

function inboundReplyDraft(
  row: RecommendationRow,
  latest: { subject: string | null; body: string }
): { subject: string; body: string } {
  const account = row.account_name?.trim() || row.account_domain?.trim() || 'this';
  const body = [
    `Hi ${firstName(row)},`,
    'Thanks for your note. I’m happy to pick this up.',
    `Would a quick 15-minute call this week be useful to discuss ${account}?`,
    `Best,\n${senderName(row)}`
  ].join('\n\n');
  return { subject: reSubject(latest.subject, account), body };
}

async function existingRun(
  db: Db,
  workspaceId: string,
  recommendationId: string
): Promise<PreparedDemandAction | null> {
  const row = await db
    .prepare(
      `
      SELECT id,playbook_key FROM playbook_runs
      WHERE workspace_id=?
        AND playbook_key IN (?,?)
        AND input_json->>'recommendationId'=?
        AND status NOT IN ('failed','cancelled')
      ORDER BY created_at DESC,id DESC LIMIT 1
    `
    )
    .get<{ id: string; playbook_key: string }>(
      workspaceId,
      OUTREACH_PLAYBOOK,
      REPLY_PLAYBOOK,
      recommendationId
    );
  if (!row) return null;
  const run = await getPlaybookRun(db, workspaceId, row.id);
  if (!run) return null;
  return { mode: row.playbook_key === REPLY_PLAYBOOK ? 'reply' : 'outreach', run };
}

async function loadRecommendation(
  db: Db,
  workspaceId: string,
  recommendationId: string
): Promise<RecommendationRow> {
  const row = await db
    .prepare(
      `
      SELECT r.id,r.type,r.status,r.person_id,r.account_id,
             p.name AS person_name,p.email AS person_email,
             a.name AS account_name,a.domain AS account_domain,
             ws.sender_name
      FROM recommendations r
      LEFT JOIN contacts p ON p.workspace_id=r.workspace_id AND p.id=r.person_id
      LEFT JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.account_id
      LEFT JOIN workspace_settings ws ON ws.workspace_id=r.workspace_id
      WHERE r.workspace_id=? AND r.id=?
    `
    )
    .get<RecommendationRow>(workspaceId, recommendationId);
  if (!row) throw new DemandActionError('Recommendation not found.', 404);
  if (row.type !== 'qualified_demand')
    throw new DemandActionError('Only qualified demand can prepare a commercial action.', 409);
  if (['dismissed', 'completed'].includes(row.status))
    throw new DemandActionError('This recommendation is already closed.', 409);
  if (!row.person_id)
    throw new DemandActionError('Find the right Person before preparing outreach.', 409);
  if (!row.person_email?.trim())
    throw new DemandActionError(
      'This Person has no canonical email address for an exact email action.',
      409
    );
  if (!row.account_id) throw new DemandActionError('Qualified demand requires an Account.', 409);
  return row;
}

async function loadEvidence(
  db: Db,
  workspaceId: string,
  recommendationId: string
): Promise<EvidenceRow[]> {
  return db
    .prepare(
      `
      SELECT re.source_type,re.source_id,re.label,re.excerpt,re.external_url,re.observed_at
      FROM recommendation_evidence re
      JOIN recommendations r ON r.id=re.recommendation_id
      WHERE r.workspace_id=? AND r.id=?
      ORDER BY CASE re.category WHEN 'request' THEN 1 WHEN 'history' THEN 2 ELSE 3 END,
               re.observed_at DESC NULLS LAST,re.created_at,re.id
    `
    )
    .all<EvidenceRow>(workspaceId, recommendationId);
}

async function latestConversation(
  db: Db,
  workspaceId: string,
  personId: string
): Promise<{
  id: string;
  channel: string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  externalRef: string | null;
} | null> {
  const row = await db
    .prepare(
      `
      SELECT c.id,latest.channel,latest.direction,latest.subject,latest.body,latest.external_ref
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT channel,direction,subject,body,external_ref
        FROM conversation_messages cm
        WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id
        ORDER BY occurred_at DESC,created_at DESC,id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE c.workspace_id=? AND c.person_id=?
    `
    )
    .get<Record<string, unknown>>(workspaceId, personId);
  if (!row) return null;
  return {
    id: String(row.id),
    channel: row.channel ? String(row.channel) : null,
    direction: row.direction ? String(row.direction) : null,
    subject: row.subject ? String(row.subject) : null,
    body: row.body ? String(row.body) : null,
    externalRef: row.external_ref ? String(row.external_ref) : null
  };
}

export async function prepareDemandAction(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    recommendationId: string;
  },
  now: Date = new Date()
): Promise<PreparedDemandAction> {
  const replay = await existingRun(db, input.workspaceId, input.recommendationId);
  if (replay) return replay;

  const recommendation = await loadRecommendation(db, input.workspaceId, input.recommendationId);
  const evidence = await loadEvidence(db, input.workspaceId, input.recommendationId);
  const conversation = await latestConversation(db, input.workspaceId, recommendation.person_id!);

  if (conversation?.direction === 'inbound' && conversation.channel === 'linkedin') {
    throw new DemandActionError(
      'The latest message from this Person is on LinkedIn. Reply in the LinkedIn inbox instead of starting a new email.',
      409
    );
  }

  if (
    conversation?.direction === 'inbound' &&
    conversation.channel === 'email' &&
    conversation.externalRef
  ) {
    const draft = inboundReplyDraft(recommendation, {
      subject: conversation.subject,
      body: conversation.body ?? ''
    });
    const run = await prepareConversationEmailReply(db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      conversationId: conversation.id,
      idempotencyKey: `demand-reply-${input.recommendationId}`,
      subject: draft.subject,
      body: draft.body,
      recommendationId: input.recommendationId,
      accountId: recommendation.account_id
    });
    return { mode: 'reply', run };
  }

  const conversationId =
    conversation?.id ??
    (await ensureConversationForPerson(db, input.workspaceId, recommendation.person_id!, now));
  const draft = outboundDraft(recommendation, evidence);
  const payload = {
    recommendationId: input.recommendationId,
    conversationId,
    personId: recommendation.person_id!,
    accountId: recommendation.account_id!,
    recipient: recommendation.person_email!.trim().toLowerCase(),
    subject: draft.subject,
    body: draft.body,
    evidence: evidence.slice(0, 12).map((item) => ({
      sourceType: item.source_type,
      sourceId: item.source_id,
      label: item.label,
      excerpt: compact(item.excerpt, 1200),
      externalUrl: item.external_url || null,
      observedAt: item.observed_at ? new Date(item.observed_at).toISOString() : null
    }))
  };

  try {
    const run = await startPlaybookRun(db, {
      workspaceId: input.workspaceId,
      playbookId: OUTREACH_PLAYBOOK,
      payload,
      actorType: 'user',
      actorId: input.actorUserId
    });
    return { mode: 'outreach', run };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === '23505') {
      const raced = await existingRun(db, input.workspaceId, input.recommendationId);
      if (raced) return raced;
    }
    throw error;
  }
}
