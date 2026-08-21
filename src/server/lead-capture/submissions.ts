import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { resolveContact, resolveExplicitAccount } from './people.js';
import type {
  CaptureSourceRecord,
  InboundSubmissionInput,
  InboundSubmissionRecord
} from './types.js';
import { LeadCaptureError } from './types.js';

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toSubmission(row: Record<string, unknown>): InboundSubmissionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    captureSourceId: String(row.capture_source_id),
    contactId: String(row.contact_id),
    accountId: row.account_id ? String(row.account_id) : null,
    idempotencyKey: String(row.idempotency_key),
    sourceEventId: row.source_event_id ? String(row.source_event_id) : null,
    kind: String(row.kind),
    person: {
      name: row.person_name ? String(row.person_name) : null,
      email: row.person_email ? String(row.person_email) : null,
      phone: row.person_phone ? String(row.person_phone) : null,
      role: row.person_role ? String(row.person_role) : null,
      externalId: row.person_external_id ? String(row.person_external_id) : null
    },
    company: row.company_domain
      ? {
          domain: String(row.company_domain),
          name: row.company_name ? String(row.company_name) : null
        }
      : null,
    message: row.message ? String(row.message) : null,
    pageUrl: row.page_url ? String(row.page_url) : null,
    referrer: row.referrer ? String(row.referrer) : null,
    attribution: parseObject(row.attribution_json),
    consent: parseObject(row.consent_json),
    properties: parseObject(row.properties_json),
    occurredAt: row.occurred_at ? new Date(String(row.occurred_at)).toISOString() : null,
    receivedAt: new Date(String(row.received_at)).toISOString()
  };
}

export function payloadHash(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export interface AcceptSubmissionResult {
  submission: InboundSubmissionRecord;
  contactId: string;
  accountId: string | null;
  duplicate: boolean;
}

export async function acceptInboundSubmission(
  db: Db,
  input: {
    source: CaptureSourceRecord;
    idempotencyKey: string;
    body: InboundSubmissionInput;
    payloadHash: string;
    receivedAt?: Date;
  }
): Promise<AcceptSubmissionResult> {
  const receivedAt = input.receivedAt ?? new Date();
  return db.transaction(async (tx) => {
    // Serialize only equal source/key pairs. This is the transactional claim:
    // concurrent retries cannot both pass the existence check and create work.
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${input.source.id}\u001f${input.idempotencyKey}`);

    const existing = await tx
      .prepare(
        'SELECT * FROM inbound_submissions WHERE capture_source_id=? AND idempotency_key=? LIMIT 1'
      )
      .get<Record<string, unknown>>(input.source.id, input.idempotencyKey);
    if (existing) {
      if (String(existing.payload_hash) !== input.payloadHash)
        throw new LeadCaptureError(
          'Idempotency key was already used with a different payload',
          409
        );
      const submission = toSubmission(existing);
      return {
        submission,
        contactId: submission.contactId,
        accountId: submission.accountId,
        duplicate: true
      };
    }

    const resolved = await resolveContact(
      tx,
      input.source.workspaceId,
      {
        ...input.body.person,
        captureSourceId: input.source.id
      },
      receivedAt
    );

    const account = input.body.company
      ? await resolveExplicitAccount(
          tx,
          input.source.workspaceId,
          resolved.contact.id,
          {
            domain: input.body.company.domain,
            name: input.body.company.name,
            role: input.body.person.role,
            sourceDetail: `capture:${input.source.id}`
          },
          receivedAt
        )
      : null;

    const submissionId = id('sub');
    const row = await tx
      .prepare(
        `
        INSERT INTO inbound_submissions (
          id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,source_event_id,kind,
          person_name,person_email,person_phone,person_role,person_external_id,company_domain,company_name,
          message,page_url,referrer,attribution_json,consent_json,properties_json,payload_hash,occurred_at,received_at,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *
      `
      )
      .get<Record<string, unknown>>(
        submissionId,
        input.source.workspaceId,
        input.source.id,
        resolved.contact.id,
        account?.accountId ?? null,
        input.idempotencyKey,
        input.body.sourceEventId ?? null,
        input.body.kind,
        input.body.person.name ?? null,
        input.body.person.email ?? null,
        input.body.person.phone ?? null,
        input.body.person.role ?? null,
        input.body.person.externalId ?? null,
        input.body.company?.domain ?? null,
        input.body.company?.name ?? null,
        input.body.message ?? null,
        input.body.page?.url ?? null,
        input.body.page?.referrer ?? null,
        JSON.stringify(input.body.attribution ?? {}),
        JSON.stringify(input.body.consent ?? {}),
        JSON.stringify(input.body.properties ?? {}),
        input.payloadHash,
        input.body.occurredAt ?? null,
        receivedAt.toISOString(),
        receivedAt.toISOString()
      );
    if (!row) throw new Error('Inbound submission could not be created');

    await appendDomainEvent(tx, {
      workspaceId: input.source.workspaceId,
      streamType: 'capture_source',
      streamId: input.source.id,
      eventType: 'capture.source.received',
      actorType: 'system',
      actorId: input.source.id,
      correlationId: submissionId,
      payload: { kind: input.body.kind }
    });
    await appendDomainEvent(tx, {
      workspaceId: input.source.workspaceId,
      streamType: 'contact',
      streamId: resolved.contact.id,
      eventType: resolved.created ? 'contact.created' : 'contact.matched',
      actorType: 'system',
      actorId: input.source.id,
      correlationId: submissionId,
      payload: resolved.conflicts.length ? { conflicts: resolved.conflicts } : {}
    });
    if (account) {
      await appendDomainEvent(tx, {
        workspaceId: input.source.workspaceId,
        streamType: 'account',
        streamId: account.accountId,
        eventType: account.created ? 'account.created' : 'account.matched',
        actorType: 'system',
        actorId: input.source.id,
        correlationId: submissionId
      });
      if (account.linked)
        await appendDomainEvent(tx, {
          workspaceId: input.source.workspaceId,
          streamType: 'contact',
          streamId: resolved.contact.id,
          eventType: 'account_contact.linked',
          actorType: 'system',
          actorId: input.source.id,
          correlationId: submissionId,
          payload: { accountId: account.accountId }
        });
    }
    await appendDomainEvent(tx, {
      workspaceId: input.source.workspaceId,
      streamType: 'inbound_submission',
      streamId: submissionId,
      eventType: 'inbound_submission.created',
      actorType: 'system',
      actorId: input.source.id,
      correlationId: submissionId,
      payload: {
        contactId: resolved.contact.id,
        accountId: account?.accountId ?? null,
        kind: input.body.kind
      }
    });

    return {
      submission: toSubmission(row),
      contactId: resolved.contact.id,
      accountId: account?.accountId ?? null,
      duplicate: false
    };
  });
}

export async function listInboundSubmissions(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<InboundSubmissionRecord[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM inbound_submissions WHERE workspace_id=? ORDER BY received_at DESC LIMIT ?'
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(limit, 500)));
  return rows.map(toSubmission);
}
