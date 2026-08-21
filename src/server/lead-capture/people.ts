import { id, type Db } from '../db.js';
import { createAccount, normalizeAccountDomain } from '../accounts/store.js';
import { LeadCaptureError, type ContactRecord } from './types.js';

const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeLinkedInProfileUrl(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)\/?/i);
    if (!match?.[1]) return null;
    return `https://www.linkedin.com/in/${match[1].toLowerCase()}/`;
  } catch {
    return null;
  }
}

export function normalizeContactEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized || null;
}

export function normalizeExplicitPhone(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return E164.test(normalized) ? normalized : null;
}

function toContact(row: Record<string, unknown>): ContactRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: row.name ? String(row.name) : null,
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
    role: row.role ? String(row.role) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export interface ResolveContactInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  role?: string | null;
  externalId?: string | null;
  captureSourceId?: string | null;
}

export interface ResolvedContact {
  contact: ContactRecord;
  created: boolean;
  conflicts: Array<{
    field: 'name' | 'email' | 'phone' | 'linkedinUrl' | 'role';
    canonical: string;
    submitted: string;
  }>;
}

export async function resolveContact(
  db: Db,
  workspaceId: string,
  input: ResolveContactInput,
  now: Date = new Date()
): Promise<ResolvedContact> {
  const email = normalizeContactEmail(input.email);
  const phone = normalizeExplicitPhone(input.phone);
  const linkedinUrl = normalizeLinkedInProfileUrl(input.linkedinUrl);
  const externalId = input.externalId?.trim() || null;
  const sourceId = input.captureSourceId?.trim() || null;
  if (!email && !phone && !linkedinUrl && !(externalId && sourceId)) {
    throw new LeadCaptureError(
      'Person requires email, LinkedIn profile, E.164 phone, or a source-scoped external ID',
      400
    );
  }

  // Deterministic identities may enrich one another, but they may never silently
  // merge two existing People. If supplied identities point at different rows,
  // stop for review rather than letting lookup order decide who the person is.
  const candidates: Record<string, unknown>[] = [];
  if (externalId && sourceId) {
    const external = await db
      .prepare(
        `
        SELECT c.* FROM contact_external_identities x
        JOIN contacts c ON c.workspace_id=x.workspace_id AND c.id=x.contact_id
        WHERE x.workspace_id=? AND x.capture_source_id=? AND x.external_id=?
        LIMIT 1
      `
      )
      .get<Record<string, unknown>>(workspaceId, sourceId, externalId);
    if (external) candidates.push(external);
  }
  if (email) {
    const byEmail = await db
      .prepare('SELECT * FROM contacts WHERE workspace_id=? AND email_normalized=? LIMIT 1')
      .get<Record<string, unknown>>(workspaceId, email);
    if (byEmail) candidates.push(byEmail);
  }
  if (linkedinUrl) {
    const byLinkedIn = await db
      .prepare('SELECT * FROM contacts WHERE workspace_id=? AND linkedin_url_normalized=? LIMIT 1')
      .get<Record<string, unknown>>(workspaceId, linkedinUrl.toLowerCase());
    if (byLinkedIn) candidates.push(byLinkedIn);
  }
  if (phone) {
    const byPhone = await db
      .prepare('SELECT * FROM contacts WHERE workspace_id=? AND phone_normalized=? LIMIT 1')
      .get<Record<string, unknown>>(workspaceId, phone);
    if (byPhone) candidates.push(byPhone);
  }
  const distinct = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));
  if (distinct.size > 1) {
    throw new LeadCaptureError(
      'Person identities resolve to different existing People; review the conflicting identities before merging',
      409
    );
  }
  let row = distinct.values().next().value as Record<string, unknown> | undefined;

  const at = now.toISOString();
  let created = false;
  if (!row) {
    const contactId = id('con');
    row = await db
      .prepare(
        `
        INSERT INTO contacts (
          id,workspace_id,name,email,email_normalized,phone,phone_normalized,
          linkedin_url,linkedin_url_normalized,role,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *
      `
      )
      .get<Record<string, unknown>>(
        contactId,
        workspaceId,
        input.name?.trim() || null,
        input.email?.trim() || null,
        email,
        input.phone?.trim() || null,
        phone,
        linkedinUrl,
        linkedinUrl?.toLowerCase() ?? null,
        input.role?.trim() || null,
        at,
        at
      );
    if (row) created = true;
    else if (email)
      row = await db
        .prepare('SELECT * FROM contacts WHERE workspace_id=? AND email_normalized=? LIMIT 1')
        .get<Record<string, unknown>>(workspaceId, email);
    if (!row && linkedinUrl)
      row = await db
        .prepare(
          'SELECT * FROM contacts WHERE workspace_id=? AND linkedin_url_normalized=? LIMIT 1'
        )
        .get<Record<string, unknown>>(workspaceId, linkedinUrl.toLowerCase());
    if (!row && phone)
      row = await db
        .prepare('SELECT * FROM contacts WHERE workspace_id=? AND phone_normalized=? LIMIT 1')
        .get<Record<string, unknown>>(workspaceId, phone);
    if (!row) throw new Error('Contact could not be resolved after a concurrent insert');
  }

  const conflicts: ResolvedContact['conflicts'] = [];
  const fill: Record<string, string> = {};
  const compare = (
    field: 'name' | 'email' | 'phone' | 'linkedinUrl' | 'role',
    submitted: string | null | undefined,
    canonical: unknown,
    dbField: string = field
  ) => {
    const value = submitted?.trim();
    if (!value) return;
    const existing = canonical ? String(canonical) : '';
    if (!existing) fill[dbField] = value;
    else if (
      field === 'email' || field === 'linkedinUrl'
        ? existing.toLowerCase() !== value.toLowerCase()
        : existing !== value
    )
      conflicts.push({ field, canonical: existing, submitted: value });
  };
  compare('name', input.name, row.name);
  compare('email', input.email, row.email);
  compare('phone', input.phone, row.phone);
  compare('linkedinUrl', linkedinUrl, row.linkedin_url, 'linkedin_url');
  compare('role', input.role, row.role);

  if (Object.keys(fill).length > 0) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(fill)) {
      sets.push(`${field}=?`);
      values.push(value);
      if (field === 'email') {
        sets.push('email_normalized=?');
        values.push(normalizeContactEmail(value));
      }
      if (field === 'phone') {
        sets.push('phone_normalized=?');
        values.push(normalizeExplicitPhone(value));
      }
      if (field === 'linkedin_url') {
        sets.push('linkedin_url_normalized=?');
        values.push(normalizeLinkedInProfileUrl(value)?.toLowerCase() ?? null);
      }
    }
    sets.push('updated_at=?');
    values.push(at, String(row.id), workspaceId);
    row = await db
      .prepare(`UPDATE contacts SET ${sets.join(',')} WHERE id=? AND workspace_id=? RETURNING *`)
      .get<Record<string, unknown>>(...values);
    if (!row) throw new Error('Contact disappeared while updating');
  }

  if (externalId && sourceId) {
    await db
      .prepare(
        `
        INSERT INTO contact_external_identities (
          id,workspace_id,contact_id,capture_source_id,external_id,created_at
        ) VALUES (?,?,?,?,?,?)
        ON CONFLICT (capture_source_id,external_id) DO NOTHING
      `
      )
      .run(id('cxi'), workspaceId, String(row.id), sourceId, externalId, at);
  }

  return { contact: toContact(row), created, conflicts };
}

export interface ExplicitAccountResult {
  accountId: string;
  created: boolean;
  linked: boolean;
}

export async function resolveExplicitAccount(
  db: Db,
  workspaceId: string,
  contactId: string,
  input: {
    domain: string;
    name?: string | null;
    role?: string | null;
    source?: 'capture' | 'import' | 'manual';
    sourceDetail?: string | null;
  },
  now: Date = new Date()
): Promise<ExplicitAccountResult | null> {
  const domain = normalizeAccountDomain(input.domain);
  if (!domain) return null;
  let row = await db
    .prepare('SELECT id FROM accounts WHERE workspace_id=? AND lower(domain)=lower(?) LIMIT 1')
    .get<{ id: string }>(workspaceId, domain);
  let created = false;
  if (!row) {
    const account = await createAccount(
      db,
      workspaceId,
      { domain, name: input.name?.trim() || undefined, source: 'manual' },
      now
    );
    row = { id: account.id };
    created = true;
  }

  const at = now.toISOString();
  const inserted = await db
    .prepare(
      `
      INSERT INTO account_contacts (
        id,workspace_id,account_id,contact_id,role,source,confidence,source_detail,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'explicit',?,?,?)
      ON CONFLICT (workspace_id,account_id,contact_id) DO NOTHING
    `
    )
    .run(
      id('acp'),
      workspaceId,
      row.id,
      contactId,
      input.role?.trim() || null,
      input.source ?? 'capture',
      input.sourceDetail?.trim() || null,
      at,
      at
    );
  return { accountId: row.id, created, linked: inserted.changes > 0 };
}

export async function listContacts(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<ContactRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM contacts WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?')
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(limit, 500)));
  return rows.map(toContact);
}
