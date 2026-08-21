import { id, type Db } from './db.js';
import { normalizeContactEmail, normalizeLinkedInProfileUrl } from './lead-capture/people.js';

export const SUPPRESSION_CHANNELS = ['all', 'email', 'linkedin', 'community'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

export interface SuppressionRecord {
  id: string;
  workspaceId: string;
  personId: string | null;
  email: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  channel: SuppressionChannel;
  reason: string;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  liftedAt: string | null;
}

export class SuppressionError extends Error {
  constructor(public readonly suppression: SuppressionRecord) {
    super(`GTM action suppressed: ${suppression.reason}`);
  }
}

function normalizeDomain(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase().replace(/^@/, '') ?? '';
  if (!raw || raw.includes('/') || raw.includes(' ') || !raw.includes('.')) return null;
  return raw;
}

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? normalizeDomain(email.slice(at + 1)) : null;
}

function toSuppression(row: Record<string, unknown>): SuppressionRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    personId: row.person_id ? String(row.person_id) : null,
    email: row.email_normalized ? String(row.email_normalized) : null,
    domain: row.domain_normalized ? String(row.domain_normalized) : null,
    linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
    channel: String(row.channel) as SuppressionChannel,
    reason: String(row.reason),
    source: String(row.source),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    liftedAt: row.lifted_at ? new Date(String(row.lifted_at)).toISOString() : null
  };
}

async function personIdsForIdentity(
  db: Db,
  workspaceId: string,
  email: string | null,
  linkedinUrl: string | null,
  explicitPersonId?: string | null
): Promise<string[]> {
  const ids = new Set<string>();
  if (explicitPersonId?.trim()) ids.add(explicitPersonId.trim());
  if (email) {
    const row = await db
      .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=? LIMIT 1')
      .get<{ id: string }>(workspaceId, email);
    if (row?.id) ids.add(row.id);
  }
  if (linkedinUrl) {
    const row = await db
      .prepare(
        'SELECT id FROM contacts WHERE workspace_id=? AND LOWER(linkedin_url)=LOWER(?) LIMIT 1'
      )
      .get<{ id: string }>(workspaceId, linkedinUrl);
    if (row?.id) ids.add(row.id);
  }
  return [...ids];
}

export async function findSuppression(
  db: Db,
  workspaceId: string,
  input: {
    channel: Exclude<SuppressionChannel, 'all'>;
    personId?: string | null;
    email?: string | null;
    domain?: string | null;
    linkedinUrl?: string | null;
  }
): Promise<SuppressionRecord | null> {
  const email = normalizeContactEmail(input.email);
  const linkedinUrl = normalizeLinkedInProfileUrl(input.linkedinUrl);
  const domain = normalizeDomain(input.domain) ?? emailDomain(email);
  const personIds = await personIdsForIdentity(db, workspaceId, email, linkedinUrl, input.personId);
  if (personIds.length === 0 && !email && !domain && !linkedinUrl) return null;

  const row = await db
    .prepare(
      `
      SELECT * FROM suppressions
      WHERE workspace_id=? AND lifted_at IS NULL AND channel IN ('all',?)
        AND (
          (COALESCE(array_length(?::text[],1),0) > 0 AND person_id = ANY(?::text[]))
          OR (?::text IS NOT NULL AND email_normalized=?)
          OR (?::text IS NOT NULL AND domain_normalized=?)
          OR (?::text IS NOT NULL AND linkedin_url IS NOT NULL AND LOWER(linkedin_url)=LOWER(?))
        )
      ORDER BY CASE WHEN channel=? THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(
      workspaceId,
      input.channel,
      personIds,
      personIds,
      email,
      email,
      domain,
      domain,
      linkedinUrl,
      linkedinUrl,
      input.channel
    );
  return row ? toSuppression(row) : null;
}

export async function assertNotSuppressed(
  db: Db,
  workspaceId: string,
  input: Parameters<typeof findSuppression>[2]
): Promise<void> {
  const suppression = await findSuppression(db, workspaceId, input);
  if (suppression) throw new SuppressionError(suppression);
}

export async function createSuppression(
  db: Db,
  input: {
    workspaceId: string;
    channel: SuppressionChannel;
    personId?: string | null;
    email?: string | null;
    domain?: string | null;
    linkedinUrl?: string | null;
    reason: string;
    source: string;
    sourceRef?: string | null;
    actorType?: 'human' | 'agent' | 'system';
    actorId?: string | null;
  },
  now: Date = new Date()
): Promise<SuppressionRecord> {
  const email = normalizeContactEmail(input.email);
  const domain = normalizeDomain(input.domain);
  const linkedinUrl = normalizeLinkedInProfileUrl(input.linkedinUrl);
  const personIds = await personIdsForIdentity(
    db,
    input.workspaceId,
    email,
    linkedinUrl,
    input.personId
  );
  if (personIds.length > 1) {
    throw new Error(
      'Suppression identities resolve to different People; review before suppressing.'
    );
  }
  const personId = personIds[0] ?? input.personId?.trim() ?? null;
  if (!personId && !email && !domain && !linkedinUrl)
    throw new Error('Suppression requires a Person, email, domain, or LinkedIn profile.');
  const timestamp = now.toISOString();
  const suppressionId = id('sup');
  const inserted = await db
    .prepare(
      `
      INSERT INTO suppressions (
        id,workspace_id,person_id,email_normalized,domain_normalized,linkedin_url,channel,
        reason,source,source_ref,created_by_type,created_by_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT DO NOTHING RETURNING *
    `
    )
    .get<Record<string, unknown>>(
      suppressionId,
      input.workspaceId,
      personId,
      email,
      domain,
      linkedinUrl,
      input.channel,
      input.reason.trim(),
      input.source.trim(),
      input.sourceRef?.trim() || null,
      input.actorType ?? 'system',
      input.actorId?.trim() || null,
      timestamp
    );
  if (inserted) return toSuppression(inserted);
  const existing = await db
    .prepare(
      `
      SELECT * FROM suppressions
      WHERE workspace_id=? AND channel=? AND lifted_at IS NULL
        AND COALESCE(person_id,'')=COALESCE(?,'')
        AND COALESCE(email_normalized,'')=COALESCE(?,'')
        AND COALESCE(domain_normalized,'')=COALESCE(?,'')
        AND COALESCE(LOWER(linkedin_url),'')=COALESCE(LOWER(?),'')
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(
      input.workspaceId,
      input.channel,
      personId,
      email,
      domain,
      linkedinUrl
    );
  if (!existing) throw new Error('Suppression could not be stored.');
  return toSuppression(existing);
}

export async function liftSuppressionsBySource(
  db: Db,
  input: {
    workspaceId: string;
    source: string;
    sourceRef: string;
    channel?: SuppressionChannel;
    actorType?: 'human' | 'agent' | 'system';
    actorId?: string | null;
  },
  now: Date = new Date()
): Promise<number> {
  const result = await db
    .prepare(
      `
      UPDATE suppressions
      SET lifted_at=?,lifted_by_type=?,lifted_by_id=?
      WHERE workspace_id=? AND source=? AND source_ref=? AND lifted_at IS NULL
        AND (?::text IS NULL OR channel=?)
    `
    )
    .run(
      now.toISOString(),
      input.actorType ?? 'system',
      input.actorId?.trim() || null,
      input.workspaceId,
      input.source,
      input.sourceRef,
      input.channel ?? null,
      input.channel ?? null
    );
  return result.changes;
}

export async function liftSuppression(
  db: Db,
  input: {
    workspaceId: string;
    suppressionId: string;
    actorType: 'human' | 'agent' | 'system';
    actorId?: string | null;
  },
  now: Date = new Date()
): Promise<SuppressionRecord | null> {
  const row = await db
    .prepare(
      `
      UPDATE suppressions
      SET lifted_at=?,lifted_by_type=?,lifted_by_id=?
      WHERE workspace_id=? AND id=? AND lifted_at IS NULL
      RETURNING *
    `
    )
    .get<Record<string, unknown>>(
      now.toISOString(),
      input.actorType,
      input.actorId?.trim() || null,
      input.workspaceId,
      input.suppressionId
    );
  return row ? toSuppression(row) : null;
}

export async function listSuppressions(
  db: Db,
  workspaceId: string,
  activeOnly = true
): Promise<SuppressionRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM suppressions WHERE workspace_id=? ${activeOnly ? 'AND lifted_at IS NULL' : ''} ORDER BY created_at DESC`
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(toSuppression);
}
