import { id, type Db } from '../db.js';
import { normalizeLeadRow, parseLeadCsv, type LeadFieldMapping, type NormalizedLeadInput } from './lead-import.js';

export type LeadListSourceKind = 'csv' | 'linkedin_search' | 'sales_navigator' | 'post_keyword';

export interface LinkedInLeadList {
  id: string;
  workspaceId: string;
  name: string;
  sourceKind: LeadListSourceKind;
  sourceRef: string | null;
  leadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedInLeadContact {
  id: string;
  workspaceId: string;
  listId: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  profileUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListRow { id: string; workspace_id: string; name: string; source_kind: string; source_ref: string | null; lead_count: number; created_at: string; updated_at: string }
interface ContactRow { id: string; workspace_id: string; list_id: string; first_name: string; last_name: string; company: string; email: string | null; phone: string | null; country: string | null; profile_url: string | null; created_at: string; updated_at: string }

const LIST_SELECT = `l.id,l.workspace_id,l.name,l.source_kind,l.source_ref,l.created_at,l.updated_at,(SELECT COUNT(*)::int FROM linkedin_lead_contacts c WHERE c.list_id=l.id) AS lead_count`;
const CONTACT_SELECT = `id,workspace_id,list_id,first_name,last_name,company,email,phone,country,profile_url,created_at,updated_at`;

function toList(row: ListRow): LinkedInLeadList {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, sourceKind: row.source_kind as LeadListSourceKind, sourceRef: row.source_ref, leadCount: Number(row.lead_count), createdAt: row.created_at, updatedAt: row.updated_at };
}
function toContact(row: ContactRow): LinkedInLeadContact {
  return { id: row.id, workspaceId: row.workspace_id, listId: row.list_id, firstName: row.first_name, lastName: row.last_name, company: row.company, email: row.email, phone: row.phone, country: row.country, profileUrl: row.profile_url, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function assertLeadSourceUrl(kind: Extract<LeadListSourceKind, 'linkedin_search' | 'sales_navigator'>, raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Lead source must be an absolute LinkedIn URL.'); }
  if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())) throw new Error('Lead source must be on linkedin.com.');
  if (kind === 'linkedin_search' && !/^\/search\/results\/people\/?/i.test(url.pathname)) throw new Error('Basic LinkedIn source must be a People search-results URL.');
  if (kind === 'sales_navigator' && !/^\/sales\/search\/people\/?/i.test(url.pathname)) throw new Error('Sales Navigator source must be a people-search URL.');
  return url.toString();
}

export async function createLeadList(db: Db, input: { workspaceId: string; name: string; sourceKind?: LeadListSourceKind; sourceRef?: string | null }, now: Date = new Date()): Promise<LinkedInLeadList> {
  const name = input.name.trim();
  if (!name) throw new Error('Lead list name is required.');
  const sourceKind = input.sourceKind ?? 'csv';
  const sourceRef = sourceKind === 'linkedin_search' || sourceKind === 'sales_navigator' ? assertLeadSourceUrl(sourceKind, input.sourceRef ?? '') : input.sourceRef?.trim() || null;
  const timestamp = now.toISOString();
  const listId = id('lilst');
  await db.prepare(`INSERT INTO linkedin_lead_lists (id,workspace_id,name,source_kind,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(listId, input.workspaceId, name, sourceKind, sourceRef, timestamp, timestamp);
  const row = await db.prepare(`SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.id=? AND l.workspace_id=?`).get<ListRow>(listId, input.workspaceId);
  if (!row) throw new Error('Lead list could not be created.');
  return toList(row);
}

export async function listLeadLists(db: Db, workspaceId: string): Promise<LinkedInLeadList[]> {
  return (await db.prepare(`SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.workspace_id=? ORDER BY l.updated_at DESC`).all<ListRow>(workspaceId)).map(toList);
}

export async function getLeadList(db: Db, workspaceId: string, listId: string): Promise<LinkedInLeadList | undefined> {
  const row = await db.prepare(`SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.workspace_id=? AND l.id=?`).get<ListRow>(workspaceId, listId);
  return row ? toList(row) : undefined;
}

export async function listLeadContacts(db: Db, workspaceId: string, listId: string, limit = 1000): Promise<LinkedInLeadContact[]> {
  return (await db.prepare(`SELECT ${CONTACT_SELECT} FROM linkedin_lead_contacts WHERE workspace_id=? AND list_id=? ORDER BY created_at,id LIMIT ?`).all<ContactRow>(workspaceId, listId, Math.max(1, Math.min(limit, 5000)))).map(toContact);
}

async function insertLead(db: Db, workspaceId: string, listId: string, lead: NormalizedLeadInput, now: string): Promise<boolean> {
  const row = await db.prepare(`INSERT INTO linkedin_lead_contacts (id,workspace_id,list_id,first_name,last_name,company,email,phone,country,profile_url,dedupe_key,original_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?) ON CONFLICT (workspace_id,list_id,dedupe_key) DO NOTHING RETURNING id`)
    .get<{ id: string }>(id('lilead'), workspaceId, listId, lead.firstName, lead.lastName, lead.company, lead.email, lead.phone, lead.country, lead.profileUrl, lead.dedupeKey, JSON.stringify(lead.original), now, now);
  return Boolean(row);
}

export async function importLeadCsv(db: Db, input: { workspaceId: string; listId: string; csv: string; mapping?: LeadFieldMapping }, now: Date = new Date()): Promise<{ inserted: number; duplicates: number; rejected: Array<{ row: number; reason: string }>; mapping: LeadFieldMapping; headers: string[] }> {
  if (!(await getLeadList(db, input.workspaceId, input.listId))) throw new Error('Lead list not found.');
  const parsed = parseLeadCsv(input.csv, input.mapping);
  const timestamp = now.toISOString();
  let inserted = 0;
  let duplicates = 0;
  await db.transaction(async (tx) => {
    for (const lead of parsed.accepted) {
      if (await insertLead(tx, input.workspaceId, input.listId, lead, timestamp)) inserted += 1;
      else duplicates += 1;
    }
    await tx.prepare('UPDATE linkedin_lead_lists SET updated_at=? WHERE id=? AND workspace_id=?').run(timestamp, input.listId, input.workspaceId);
  });
  return { inserted, duplicates, rejected: parsed.rejected.map(({ row, reason }) => ({ row, reason })), mapping: parsed.mapping, headers: parsed.headers };
}

export async function updateLeadContact(
  db: Db,
  input: { workspaceId: string; contactId: string; firstName: string; lastName: string; company: string; email?: string | null; phone?: string | null; country?: string | null; profileUrl?: string | null },
  now: Date = new Date()
): Promise<LinkedInLeadContact> {
  const normalized = normalizeLeadRow(
    { firstName: input.firstName, lastName: input.lastName, company: input.company, email: input.email ?? '', phone: input.phone ?? '', country: input.country ?? '', profileUrl: input.profileUrl ?? '' },
    { firstName: 'firstName', lastName: 'lastName', company: 'company', email: 'email', phone: 'phone', country: 'country', profileUrl: 'profileUrl' }
  );
  const row = await db.prepare(`UPDATE linkedin_lead_contacts SET first_name=?,last_name=?,company=?,email=?,phone=?,country=?,profile_url=?,dedupe_key=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING ${CONTACT_SELECT}`)
    .get<ContactRow>(normalized.firstName, normalized.lastName, normalized.company, normalized.email, normalized.phone, normalized.country, normalized.profileUrl, normalized.dedupeKey, now.toISOString(), input.workspaceId, input.contactId);
  if (!row) throw new Error('Lead not found.');
  return toContact(row);
}

export async function removeLeadContact(db: Db, workspaceId: string, contactId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?').run(workspaceId, contactId);
  return result.changes > 0;
}
