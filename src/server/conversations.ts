import { id, type Db } from './db.js';
import { resolveContact } from './lead-capture/people.js';

export type ConversationChannel = 'linkedin' | 'email';
export type ConversationDirection = 'inbound' | 'outbound';

export interface ConversationSummary {
  id: string;
  personId: string;
  personName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  channels: ConversationChannel[];
  lastActivityAt: string | null;
  latestMessage: {
    channel: ConversationChannel;
    direction: ConversationDirection;
    body: string;
    occurredAt: string;
  } | null;
  needsReply: boolean;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  channel: ConversationChannel;
  provider: string;
  direction: ConversationDirection;
  subject: string | null;
  body: string;
  externalRef: string | null;
  actorType: string | null;
  actorId: string | null;
  occurredAt: string;
}
interface ConversationRow {
  id: string;
  workspace_id: string;
  person_id: string;
  last_activity_at: string | null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function objectOf(value: unknown): Record<string, unknown> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
async function ensureConversation(
  db: Db,
  workspaceId: string,
  personId: string,
  lastActivityAt: string,
  now: Date
): Promise<ConversationRow> {
  const row = await db
    .prepare(
      `
      INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (workspace_id,person_id) DO UPDATE SET
        last_activity_at=CASE
          WHEN conversations.last_activity_at IS NULL THEN EXCLUDED.last_activity_at
          ELSE GREATEST(conversations.last_activity_at,EXCLUDED.last_activity_at)
        END,
        updated_at=GREATEST(conversations.updated_at,EXCLUDED.updated_at)
      RETURNING *
    `
    )
    .get<ConversationRow>(
      id('conv'),
      workspaceId,
      personId,
      lastActivityAt,
      now.toISOString(),
      lastActivityAt
    );
  if (!row) throw new Error('Conversation could not be created or resolved.');
  return row;
}
/**
 * Project one LinkedIn thread into the canonical Person-led conversation view.
 * The LinkedIn tables remain authoritative for safety, pacing and provider state.
 */
export async function projectLinkedInThread(
  db: Db,
  workspaceId: string,
  threadId: string,
  now: Date = new Date()
): Promise<string | null> {
  const thread = await db
    .prepare(
      `
      SELECT id,thread_urn,profile_url,name,last_message_at,synced_at,created_at,seat_key
      FROM linkedin_threads WHERE workspace_id=? AND id=?
    `
    )
    .get<Record<string, unknown>>(workspaceId, threadId);
  if (!thread?.profile_url) return null;

  const person = await resolveContact(
    db,
    workspaceId,
    {
      name: thread.name ? String(thread.name) : null,
      linkedinUrl: String(thread.profile_url)
    },
    now
  );
  const lastActivity =
    iso(thread.last_message_at) ??
    iso(thread.synced_at) ??
    iso(thread.created_at) ??
    now.toISOString();
  const conversation = await ensureConversation(
    db,
    workspaceId,
    person.contact.id,
    lastActivity,
    now
  );
  const channelId = id('cch');
  const channel = await db
    .prepare(
      `
      INSERT INTO conversation_channels (
        id,workspace_id,conversation_id,channel,provider,external_thread_ref,source_type,source_id,created_at,updated_at
      ) VALUES (?,?,?,'linkedin','linkedin',?,'linkedin_thread',?,?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        conversation_id=EXCLUDED.conversation_id,
        external_thread_ref=EXCLUDED.external_thread_ref,
        updated_at=EXCLUDED.updated_at
      RETURNING id
    `
    )
    .get<{ id: string }>(
      channelId,
      workspaceId,
      conversation.id,
      String(thread.thread_urn),
      threadId,
      String(thread.created_at ?? now.toISOString()),
      String(thread.synced_at ?? now.toISOString())
    );
  if (!channel) throw new Error('LinkedIn conversation channel could not be projected.');

  const messages = await db
    .prepare(
      `
      SELECT id,direction,body,sent_at,external_ref,action_id,created_at
      FROM linkedin_messages
      WHERE workspace_id=? AND thread_id=?
      ORDER BY position,id
    `
    )
    .all<Record<string, unknown>>(workspaceId, threadId);
  for (const message of messages) {
    const occurredAt = iso(message.sent_at) ?? iso(message.created_at) ?? now.toISOString();
    let actorType: string | null = null;
    let actorId: string | null = null;
    if (message.direction !== 'in' && message.action_id) {
      const action = await db
        .prepare('SELECT queued_by_user_id FROM linkedin_actions WHERE workspace_id=? AND id=?')
        .get<{ queued_by_user_id: string | null }>(workspaceId, String(message.action_id));
      if (action?.queued_by_user_id) {
        actorType = 'human';
        actorId = action.queued_by_user_id;
      }
    }
    await db
      .prepare(
        `
        INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel_id,channel,provider,direction,body,external_ref,
          source_type,source_id,actor_type,actor_id,occurred_at,created_at
        ) VALUES (?,?,?,?,'linkedin','linkedin',?,?,?,?,?,?,?,?,?)
        ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
          conversation_id=EXCLUDED.conversation_id,
          channel_id=EXCLUDED.channel_id,
          actor_type=COALESCE(conversation_messages.actor_type,EXCLUDED.actor_type),
          actor_id=COALESCE(conversation_messages.actor_id,EXCLUDED.actor_id)
      `
      )
      .run(
        id('cmsg'),
        workspaceId,
        conversation.id,
        channel.id,
        message.direction === 'in' ? 'inbound' : 'outbound',
        String(message.body),
        message.external_ref ? String(message.external_ref) : null,
        'linkedin_message',
        String(message.id),
        actorType,
        actorId,
        occurredAt,
        String(message.created_at ?? now.toISOString())
      );
  }
  return conversation.id;
}

/** Project an existing canonical connected-email message into the shared view. */
export async function projectCanonicalMessage(
  db: Db,
  workspaceId: string,
  messageId: string,
  now: Date = new Date()
): Promise<string | null> {
  const message = await db
    .prepare(
      `
      SELECT m.id,m.person_id,m.direction,m.subject,m.body,m.occurred_at,m.created_at,
             s.provider,s.external_id
      FROM messages m
      LEFT JOIN source_records s ON s.id=m.source_record_id AND s.workspace_id=m.workspace_id
      WHERE m.workspace_id=? AND m.id=?
    `
    )
    .get<Record<string, unknown>>(workspaceId, messageId);
  if (!message?.person_id) return null;
  const provider = String(message.provider ?? '').toLowerCase();
  if (!['gmail', 'google-mail', 'microsoft', 'outlook'].includes(provider)) return null;
  const occurredAt = iso(message.occurred_at) ?? now.toISOString();
  const conversation = await ensureConversation(
    db,
    workspaceId,
    String(message.person_id),
    occurredAt,
    now
  );
  await db
    .prepare(
      `
      INSERT INTO conversation_messages (
        id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
        source_type,source_id,occurred_at,created_at
      ) VALUES (?,?,?,'email',?,?,?,?,?,'legacy_message',?,?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        conversation_id=EXCLUDED.conversation_id,
        subject=EXCLUDED.subject,
        body=EXCLUDED.body,
        occurred_at=EXCLUDED.occurred_at
    `
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversation.id,
      provider,
      message.direction === 'inbound' ? 'inbound' : 'outbound',
      message.subject ? String(message.subject) : null,
      String(message.body ?? ''),
      message.external_id ? String(message.external_id) : null,
      String(message.id),
      occurredAt,
      String(message.created_at ?? now.toISOString())
    );
  return conversation.id;
}

/**
 * Project a provider-confirmed sent campaign email into the Person transcript.
 * Delivery state remains authoritative in linkedin_campaign_channel_actions.
 */
export async function projectCampaignEmailDelivery(
  db: Db,
  workspaceId: string,
  channelActionId: string,
  now: Date = new Date()
): Promise<string | null> {
  const row = await db
    .prepare(
      `
      SELECT a.id,a.payload_json,a.provider,a.external_ref,a.completed_at,a.created_at,c.person_id
      FROM linkedin_campaign_channel_actions a
      JOIN linkedin_lead_contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id
      WHERE a.workspace_id=? AND a.id=? AND a.kind='email' AND a.status='sent'
    `
    )
    .get<Record<string, unknown>>(workspaceId, channelActionId);
  if (!row?.person_id) return null;
  const payload = objectOf(row.payload_json);
  const body = String(payload.body ?? '').trim();
  if (!body) return null;
  const occurredAt = iso(row.completed_at) ?? iso(row.created_at) ?? now.toISOString();
  const conversation = await ensureConversation(
    db,
    workspaceId,
    String(row.person_id),
    occurredAt,
    now
  );
  await db
    .prepare(
      `
      INSERT INTO conversation_messages (
        id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
        source_type,source_id,occurred_at,created_at
      ) VALUES (?,?,?,'email',?,'outbound',?,?,?,'campaign_email_action',?,?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        conversation_id=EXCLUDED.conversation_id,
        provider=EXCLUDED.provider,
        subject=EXCLUDED.subject,
        body=EXCLUDED.body,
        external_ref=EXCLUDED.external_ref,
        occurred_at=EXCLUDED.occurred_at
    `
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversation.id,
      String(row.provider ?? 'email'),
      payload.subject ? String(payload.subject) : null,
      body,
      row.external_ref ? String(row.external_ref) : null,
      String(row.id),
      occurredAt,
      occurredAt
    );
  return conversation.id;
}

/**
 * Project a provider-verified inbound campaign reply. The caller must supply
 * content read from the provider thread; sender-only detection is not enough to
 * fabricate a transcript entry.
 */
export async function projectCampaignEmailReply(
  db: Db,
  workspaceId: string,
  input: {
    channelActionId: string;
    providerEventId: string;
    body: string;
    outcomeKind:
      | 'reply'
      | 'unsubscribe'
      | 'bounce'
      | 'delivery_failure'
      | 'out_of_office'
      | 'auto_reply'
      | 'unknown';
    subject?: string | null;
    occurredAt?: string | null;
  },
  now: Date = new Date()
): Promise<string | null> {
  const body = input.body.trim();
  if (!body) return null;
  const row = await db
    .prepare(
      `
      SELECT a.provider,c.person_id
      FROM linkedin_campaign_channel_actions a
      JOIN linkedin_lead_contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id
      WHERE a.workspace_id=? AND a.id=? AND a.kind='email'
    `
    )
    .get<{ provider: string | null; person_id: string | null }>(workspaceId, input.channelActionId);
  if (!row?.person_id) return null;
  const occurredAt = iso(input.occurredAt) ?? now.toISOString();
  const conversation = await ensureConversation(db, workspaceId, row.person_id, occurredAt, now);
  await db
    .prepare(
      `
      INSERT INTO conversation_messages (
        id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
        source_type,source_id,outcome_kind,verification_status,occurred_at,created_at
      ) VALUES (?,?,?,'email',?,'inbound',?,?,?,'campaign_email_reply',?,?,'verified',?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        conversation_id=EXCLUDED.conversation_id,
        provider=EXCLUDED.provider,
        subject=EXCLUDED.subject,
        body=EXCLUDED.body,
        occurred_at=EXCLUDED.occurred_at
    `
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversation.id,
      row.provider ?? 'email',
      input.subject?.trim() || null,
      body,
      input.providerEventId,
      input.providerEventId,
      input.outcomeKind,
      occurredAt,
      occurredAt
    );
  return conversation.id;
}

/**
 * Project an approved control-plane email action after the provider confirms it.
 * The external side effect is already authoritative at this point; projection
 * is idempotent derived state and may safely be retried independently.
 */
export async function projectPreparedConversationEmail(
  db: Db,
  input: {
    workspaceId: string;
    conversationId: string;
    personId: string;
    provider: string;
    externalRef: string;
    recipient: string;
    subject: string;
    body: string;
    payloadHash: string;
    actorType?: string | null;
    actorId?: string | null;
  },
  now: Date = new Date()
): Promise<boolean> {
  const conversation = await db
    .prepare(
      `
      SELECT c.id,c.person_id,p.email
      FROM conversations c
      JOIN contacts p ON p.workspace_id=c.workspace_id AND p.id=c.person_id
      WHERE c.workspace_id=? AND c.id=? AND c.person_id=?
    `
    )
    .get<{ id: string; person_id: string; email: string | null }>(
      input.workspaceId,
      input.conversationId,
      input.personId
    );
  if (!conversation) return false;
  if ((conversation.email ?? '').trim().toLowerCase() !== input.recipient.trim().toLowerCase())
    return false;
  const occurredAt = now.toISOString();
  await ensureConversation(db, input.workspaceId, input.personId, occurredAt, now);
  await db
    .prepare(
      `
      INSERT INTO conversation_messages (
        id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
        source_type,source_id,actor_type,actor_id,occurred_at,created_at
      ) VALUES (?,?,?,'email',?,'outbound',?,?,?,'playbook_email_action',?,?,?,?,?)
      ON CONFLICT (workspace_id,source_type,source_id) DO UPDATE SET
        provider=EXCLUDED.provider,
        subject=EXCLUDED.subject,
        body=EXCLUDED.body,
        external_ref=EXCLUDED.external_ref,
        actor_type=EXCLUDED.actor_type,
        actor_id=EXCLUDED.actor_id,
        occurred_at=EXCLUDED.occurred_at
    `
    )
    .run(
      id('cmsg'),
      input.workspaceId,
      input.conversationId,
      input.provider,
      input.subject,
      input.body,
      input.externalRef,
      input.payloadHash,
      input.actorType ?? 'system',
      input.actorId ?? null,
      occurredAt,
      occurredAt
    );
  return true;
}

export async function listConversations(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<ConversationSummary[]> {
  const rows = await db
    .prepare(
      `
      SELECT c.id,c.person_id,p.name,p.email,p.linkedin_url,c.last_activity_at,
             COALESCE((
               SELECT ARRAY_AGG(DISTINCT channel ORDER BY channel)
               FROM (
                 SELECT ch.channel FROM conversation_channels ch
                 WHERE ch.workspace_id=c.workspace_id AND ch.conversation_id=c.id
                 UNION
                 SELECT cm.channel FROM conversation_messages cm
                 WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id
               ) channel_rows
             ),ARRAY[]::text[]) AS channels,
             latest.channel AS latest_channel,
             latest.direction AS latest_direction,
             latest.body AS latest_body,
             latest.occurred_at AS latest_occurred_at
      FROM conversations c
      JOIN contacts p ON p.workspace_id=c.workspace_id AND p.id=c.person_id
      LEFT JOIN LATERAL (
        SELECT channel,direction,body,occurred_at
        FROM conversation_messages cm
        WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id
        ORDER BY occurred_at DESC,created_at DESC,id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE c.workspace_id=?
      ORDER BY c.last_activity_at DESC NULLS LAST,c.updated_at DESC,c.id
      LIMIT ?
    `
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(limit, 500)));
  return rows.map((row) => {
    const latestAt = iso(row.latest_occurred_at);
    const latest = row.latest_channel
      ? {
          channel: String(row.latest_channel) as ConversationChannel,
          direction: String(row.latest_direction) as ConversationDirection,
          body: String(row.latest_body ?? ''),
          occurredAt: latestAt ?? iso(row.last_activity_at) ?? new Date(0).toISOString()
        }
      : null;
    return {
      id: String(row.id),
      personId: String(row.person_id),
      personName: row.name ? String(row.name) : null,
      email: row.email ? String(row.email) : null,
      linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
      channels: Array.isArray(row.channels)
        ? row.channels.map((channel) => String(channel) as ConversationChannel)
        : [],
      lastActivityAt: iso(row.last_activity_at),
      latestMessage: latest,
      needsReply: latest?.direction === 'inbound'
    };
  });
}

export async function listConversationMessages(
  db: Db,
  workspaceId: string,
  conversationId: string,
  limit = 200
): Promise<ConversationMessage[]> {
  const rows = await db
    .prepare(
      `
      SELECT id,conversation_id,channel,provider,direction,subject,body,external_ref,actor_type,actor_id,occurred_at
      FROM conversation_messages
      WHERE workspace_id=? AND conversation_id=?
      ORDER BY occurred_at ASC,created_at ASC,id ASC
      LIMIT ?
    `
    )
    .all<Record<string, unknown>>(workspaceId, conversationId, Math.max(1, Math.min(limit, 1000)));
  return rows.map((row) => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    channel: String(row.channel) as ConversationChannel,
    provider: String(row.provider),
    direction: String(row.direction) as ConversationDirection,
    subject: row.subject ? String(row.subject) : null,
    body: String(row.body),
    externalRef: row.external_ref ? String(row.external_ref) : null,
    actorType: row.actor_type ? String(row.actor_type) : null,
    actorId: row.actor_id ? String(row.actor_id) : null,
    occurredAt: iso(row.occurred_at) ?? new Date(0).toISOString()
  }));
}

/** Remove LinkedIn-derived projection rows before the LinkedIn cache is cleared. */
export async function clearLinkedInConversationProjection(
  db: Db,
  workspaceId: string,
  seatKey?: string
): Promise<void> {
  const threadRows = await db
    .prepare(
      `SELECT id FROM linkedin_threads WHERE workspace_id=? ${seatKey ? 'AND seat_key=?' : ''}`
    )
    .all<{ id: string }>(...(seatKey ? [workspaceId, seatKey] : [workspaceId]));
  const threadIds = threadRows.map((row) => row.id);
  if (threadIds.length === 0) return;
  const messageRows = await db
    .prepare('SELECT id FROM linkedin_messages WHERE workspace_id=? AND thread_id = ANY(?::text[])')
    .all<{ id: string }>(workspaceId, threadIds);
  if (messageRows.length > 0) {
    await db
      .prepare(
        "DELETE FROM conversation_messages WHERE workspace_id=? AND source_type='linkedin_message' AND source_id = ANY(?::text[])"
      )
      .run(
        workspaceId,
        messageRows.map((row) => row.id)
      );
  }
  await db
    .prepare(
      "DELETE FROM conversation_channels WHERE workspace_id=? AND source_type='linkedin_thread' AND source_id = ANY(?::text[])"
    )
    .run(workspaceId, threadIds);
  await db
    .prepare(
      `
    DELETE FROM conversations c
    WHERE c.workspace_id=?
      AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM conversation_channels ch WHERE ch.workspace_id=c.workspace_id AND ch.conversation_id=c.id)
  `
    )
    .run(workspaceId);
}
