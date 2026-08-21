import { id, type Db } from './db.js';

export type EmailDeliveryStatus = 'sending' | 'sent' | 'failed' | 'uncertain';
export type EmailDeliveryPurpose = 'outreach' | 'reply' | 'other';

export interface EmailDelivery {
  id: string;
  workspaceId: string;
  connectionId: string | null;
  purpose: EmailDeliveryPurpose;
  recipient: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  status: EmailDeliveryStatus;
  provider: string | null;
  externalRef: string | null;
  internetMessageId: string | null;
  lastError: string | null;
  attemptCount: number;
  startedAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class EmailDeliveryBlockedError extends Error {
  constructor(
    message: string,
    public readonly delivery: EmailDelivery
  ) {
    super(message);
  }
}

function serialize(row: Record<string, unknown>): EmailDelivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    connectionId: row.connection_id ? String(row.connection_id) : null,
    purpose: String(row.purpose ?? 'outreach') as EmailDeliveryPurpose,
    recipient: String(row.recipient),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as EmailDeliveryStatus,
    provider: row.provider ? String(row.provider) : null,
    externalRef: row.external_ref ? String(row.external_ref) : null,
    internetMessageId: row.internet_message_id ? String(row.internet_message_id) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    attemptCount: Number(row.attempt_count ?? 1),
    startedAt: new Date(String(row.started_at)).toISOString(),
    sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

/**
 * Atomically claim one exact email payload.
 *
 * `sent` replays the stored provider result without touching the provider.
 * `sending` and `uncertain` refuse execution because another worker may still
 * own the effect, or the provider may already have accepted it. A definite
 * `failed` row may be retried only because the caller has explicitly put its
 * action back into an executable state; the attempt count records that fact.
 */
export async function claimEmailDelivery(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string | null;
    purpose: EmailDeliveryPurpose;
    recipient: string;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
  },
  now = new Date()
): Promise<{ delivery: EmailDelivery; replayed: boolean }> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const findExisting = () =>
      tx
        .prepare(
          `SELECT * FROM gtm_deliveries
           WHERE workspace_id=?
             AND (idempotency_key=? OR (source_type=? AND source_id=?))
           ORDER BY CASE WHEN idempotency_key=? THEN 0 ELSE 1 END
           LIMIT 1 FOR UPDATE`
        )
        .get<Record<string, unknown>>(
          input.workspaceId,
          input.idempotencyKey,
          input.sourceType,
          input.sourceId,
          input.idempotencyKey
        );

    const handleExisting = async (row: Record<string, unknown>) => {
      const delivery = serialize(row);
      if (delivery.idempotencyKey !== input.idempotencyKey) {
        throw new EmailDeliveryBlockedError(
          'This GTM action already owns a delivery with a different approved payload; create a new action instead of mutating the send.',
          delivery
        );
      }
      if (
        delivery.purpose !== input.purpose ||
        (delivery.connectionId ?? null) !== (input.connectionId ?? null)
      ) {
        throw new EmailDeliveryBlockedError(
          'The delivery idempotency key is already bound to a different GTM delivery context.',
          delivery
        );
      }
      if (delivery.recipient.trim().toLowerCase() !== input.recipient.trim().toLowerCase()) {
        throw new EmailDeliveryBlockedError(
          'The delivery idempotency key is already bound to a different recipient.',
          delivery
        );
      }
      if (delivery.status === 'sent') return { delivery, replayed: true };
      if (delivery.status === 'sending') {
        throw new EmailDeliveryBlockedError(
          'This exact email delivery is already in flight; Trevra will not send it twice.',
          delivery
        );
      }
      if (delivery.status === 'uncertain') {
        throw new EmailDeliveryBlockedError(
          'This exact email has an uncertain provider outcome and requires reconciliation before any resend.',
          delivery
        );
      }
      const retried = await tx
        .prepare(
          `UPDATE gtm_deliveries
           SET status='sending',last_error=NULL,attempt_count=attempt_count+1,
               started_at=?,updated_at=?
           WHERE id=? AND status='failed' RETURNING *`
        )
        .get<Record<string, unknown>>(timestamp, timestamp, delivery.id);
      if (!retried) throw new Error('Email delivery retry could not be claimed.');
      return { delivery: serialize(retried), replayed: false };
    };

    const existing = await findExisting();
    if (existing) return handleExisting(existing);

    const inserted = await tx
      .prepare(
        `INSERT INTO gtm_deliveries (
          id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,
          started_at,created_at,updated_at
        ) VALUES (?,?,'email',?,?,?,?,?,?,'sending',?,?,?)
        ON CONFLICT DO NOTHING RETURNING *`
      )
      .get<Record<string, unknown>>(
        id('del'),
        input.workspaceId,
        input.connectionId,
        input.purpose,
        input.recipient,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
        timestamp,
        timestamp,
        timestamp
      );
    if (inserted) return { delivery: serialize(inserted), replayed: false };

    // Another worker won the unique-key race between our SELECT and INSERT.
    // ON CONFLICT kept this transaction usable, so lock and interpret the row
    // instead of leaking a constraint error or, worse, proceeding to send.
    const raced = await findExisting();
    if (!raced)
      throw new Error('Email delivery claim conflicted but no owning row could be found.');
    return handleExisting(raced);
  });
}

export class EmailDeliveryCapacityError extends Error {
  readonly status = 429;
}

export async function assertEmailDeliveryCapacity(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string | null;
    purpose: EmailDeliveryPurpose;
  },
  now = new Date()
): Promise<void> {
  if (input.purpose !== 'outreach') return;
  const setting = input.connectionId
    ? await db
        .prepare(
          `SELECT daily_limit FROM linkedin_campaign_mailbox_settings
           WHERE workspace_id=? AND connection_id=?`
        )
        .get<{ daily_limit: number }>(input.workspaceId, input.connectionId)
    : undefined;
  // Cold outreach has a safety ceiling even before the operator customizes a
  // mailbox. Conversation replies declare purpose='reply' and never consume it.
  const cap = Math.max(1, Math.min(500, Number(setting?.daily_limit ?? 50)));
  const used = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM gtm_deliveries
       WHERE workspace_id=? AND purpose='outreach' AND status='sent'
         AND connection_id IS NOT DISTINCT FROM ?
         AND sent_at>=?::timestamptz`
    )
    .get<{ total: number }>(
      input.workspaceId,
      input.connectionId,
      new Date(now.getTime() - 86_400_000).toISOString()
    );
  if (Number(used?.total ?? 0) >= cap) {
    throw new EmailDeliveryCapacityError(
      `Outbound email daily cap reached for this mailbox (${cap}); no provider call was attempted.`
    );
  }
}

export async function markEmailDeliverySent(
  db: Db,
  deliveryId: string,
  input: { provider: string; externalRef: string; internetMessageId?: string | null },
  now = new Date()
): Promise<EmailDelivery> {
  const row = await db
    .prepare(
      `UPDATE gtm_deliveries
       SET status='sent',provider=?,external_ref=?,internet_message_id=?,last_error=NULL,
           sent_at=?,updated_at=?
       WHERE id=? AND status='sending' RETURNING *`
    )
    .get<Record<string, unknown>>(
      input.provider,
      input.externalRef,
      input.internetMessageId ?? null,
      now.toISOString(),
      now.toISOString(),
      deliveryId
    );
  if (!row) throw new Error('Email delivery could not be marked sent.');
  return serialize(row);
}

export async function markEmailDeliveryFailure(
  db: Db,
  deliveryId: string,
  error: unknown,
  now = new Date()
): Promise<EmailDelivery> {
  const status: EmailDeliveryStatus = definiteEmailFailure(error) ? 'failed' : 'uncertain';
  const message = error instanceof Error ? error.message : String(error);
  const row = await db
    .prepare(
      `UPDATE gtm_deliveries SET status=?,last_error=?,updated_at=?
       WHERE id=? AND status='sending' RETURNING *`
    )
    .get<Record<string, unknown>>(status, message.slice(0, 1000), now.toISOString(), deliveryId);
  if (!row) throw new Error('Email delivery failure state could not be stored.');
  return serialize(row);
}

export function definiteEmailFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : NaN;
  if (Number.isFinite(status) && status >= 400 && status < 500) return true;
  return /(?:HTTP 4\d\d|requires recipient|requires recipient, subject, and body|Connect Gmail|Connect Microsoft|live provider connection is required|suppressed|daily cap reached)/i.test(
    message
  );
}

export async function listEmailDeliveries(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<EmailDelivery[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM gtm_deliveries WHERE workspace_id=?
       ORDER BY updated_at DESC,id DESC LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(500, limit)));
  return rows.map(serialize);
}
