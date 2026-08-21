import type { Db } from './db.js';
import { getPlaybookRun, startPlaybookRun } from './playbooks/engine.js';
import type { PlaybookRun } from './playbooks/types.js';

const PLAYBOOK_ID = 'gtm.conversation-email-reply';

export class ConversationReplyError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export interface PrepareConversationEmailReplyInput {
  workspaceId: string;
  actorUserId: string;
  conversationId: string;
  idempotencyKey: string;
  subject: string;
  body: string;
}

interface StoredReplyInput {
  idempotencyKey?: unknown;
  conversationId?: unknown;
  personId?: unknown;
  recipient?: unknown;
  subject?: unknown;
  body?: unknown;
  threadExternalRef?: unknown;
  threadIdempotencyKey?: unknown;
}

function jsonObject(value: unknown): StoredReplyInput {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as StoredReplyInput;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StoredReplyInput)
      : {};
  } catch {
    return {};
  }
}

function providerMessageRef(provider: string, externalRef: string): string {
  const trimmed = externalRef.trim();
  const prefix = `${provider.trim().toLowerCase()}:`;
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function normalizedSubject(value: string): string {
  const subject = value.trim();
  if (!subject) throw new ConversationReplyError('Email reply subject is required.');
  if (subject.length > 200) throw new ConversationReplyError('Email reply subject is too long.');
  return subject;
}

function normalizedBody(value: string): string {
  const body = value.trim();
  if (!body) throw new ConversationReplyError('Email reply body is required.');
  if (body.length > 20_000) throw new ConversationReplyError('Email reply body is too long.');
  return body;
}

async function existingPreparation(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<{ runId: string; input: StoredReplyInput } | null> {
  const row = await db
    .prepare(
      `
      SELECT id,input_json FROM playbook_runs
      WHERE workspace_id=? AND playbook_key=? AND input_json->>'idempotencyKey'=?
      ORDER BY created_at DESC LIMIT 1
    `
    )
    .get<{ id: string; input_json: unknown }>(workspaceId, PLAYBOOK_ID, idempotencyKey);
  return row ? { runId: row.id, input: jsonObject(row.input_json) } : null;
}

function sameRequestedReply(
  stored: StoredReplyInput,
  input: { conversationId: string; subject: string; body: string }
): boolean {
  return (
    String(stored.conversationId ?? '') === input.conversationId &&
    String(stored.subject ?? '') === input.subject &&
    String(stored.body ?? '') === input.body
  );
}

async function replayExisting(
  db: Db,
  input: PrepareConversationEmailReplyInput,
  subject: string,
  body: string
): Promise<PlaybookRun | null> {
  const existing = await existingPreparation(db, input.workspaceId, input.idempotencyKey);
  if (!existing) return null;
  if (
    !sameRequestedReply(existing.input, { conversationId: input.conversationId, subject, body })
  ) {
    throw new ConversationReplyError(
      'This idempotency key already belongs to a different conversation reply.',
      409
    );
  }
  const run = await getPlaybookRun(db, input.workspaceId, existing.runId);
  if (!run)
    throw new ConversationReplyError('Prepared conversation reply could not be reloaded.', 500);
  return run;
}

export async function prepareConversationEmailReply(
  db: Db,
  input: PrepareConversationEmailReplyInput
): Promise<PlaybookRun> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
    throw new ConversationReplyError('Idempotency key must be 8-200 characters.');
  const subject = normalizedSubject(input.subject);
  const body = normalizedBody(input.body);

  const replay = await replayExisting(db, input, subject, body);
  if (replay) return replay;

  const conversation = await db
    .prepare(
      `
      SELECT c.id,c.person_id,p.email
      FROM conversations c
      JOIN contacts p ON p.workspace_id=c.workspace_id AND p.id=c.person_id
      WHERE c.workspace_id=? AND c.id=?
    `
    )
    .get<{ id: string; person_id: string; email: string | null }>(
      input.workspaceId,
      input.conversationId
    );
  if (!conversation) throw new ConversationReplyError('Conversation not found.', 404);
  const recipient = conversation.email?.trim().toLowerCase() ?? '';
  if (!recipient)
    throw new ConversationReplyError('This Person has no canonical email address.', 409);

  const thread = await db
    .prepare(
      `
      SELECT provider,external_ref
      FROM conversation_messages
      WHERE workspace_id=? AND conversation_id=? AND channel='email'
        AND external_ref IS NOT NULL AND BTRIM(external_ref)<>''
      ORDER BY occurred_at DESC,created_at DESC,id DESC
      LIMIT 1
    `
    )
    .get<{ provider: string; external_ref: string }>(input.workspaceId, input.conversationId);
  if (!thread) {
    throw new ConversationReplyError(
      'No provider-backed email thread is stored for this conversation, so Trevra will not pretend a new email is a reply.',
      409
    );
  }
  const threadExternalRef = providerMessageRef(thread.provider, thread.external_ref);
  if (!threadExternalRef)
    throw new ConversationReplyError('The stored email thread reference is unusable.', 409);

  const prior = await db
    .prepare(
      `
      SELECT a.idempotency_key
      FROM conversation_messages cm
      JOIN linkedin_campaign_channel_actions a
        ON cm.source_type='campaign_email_action'
       AND a.workspace_id=cm.workspace_id
       AND a.id=cm.source_id
      WHERE cm.workspace_id=? AND cm.conversation_id=? AND cm.channel='email'
      ORDER BY cm.occurred_at DESC,cm.created_at DESC,cm.id DESC
      LIMIT 1
    `
    )
    .get<{ idempotency_key: string }>(input.workspaceId, input.conversationId);

  const payload = {
    idempotencyKey,
    conversationId: conversation.id,
    personId: conversation.person_id,
    recipient,
    subject,
    body,
    threadExternalRef,
    threadIdempotencyKey: prior?.idempotency_key ?? null
  };

  try {
    return await startPlaybookRun(db, {
      workspaceId: input.workspaceId,
      playbookId: PLAYBOOK_ID,
      payload,
      actorType: 'user',
      actorId: input.actorUserId
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === '23505') {
      const raced = await replayExisting(db, input, subject, body);
      if (raced) return raced;
    }
    throw error;
  }
}
