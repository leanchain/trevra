import { id, type Db } from '../db.js';
// `LinkedInApiError` and not a bare Error, for `deleteLeadList`'s refusal
// alone: it is the only thing in this file a route must turn into a 409 rather
// than a 400, and carrying the status on the error is how every other refusal
// in this subsystem reaches the response without the route re-deciding it.
// errors.ts is a leaf with no imports of its own, so this direction adds no
// cycle.
import { LinkedInApiError } from './errors.js';
import {
  normalizeLeadRow,
  normalizeScrapedLead,
  parseLeadCsv,
  type LeadFieldMapping,
  type NormalizedLeadInput
} from './lead-import.js';
import { LEAD_READ_LIMIT, getLeadSource, listLeads, type LeadSourceKind } from './leads.js';
import { OWNER_SEAT_KEY } from './seats.js';

/**
 * HOW MANY CONTACTS ARE EVER READ OUT OF ONE LIST AT ONCE. The default and the
 * ceiling, deliberately the same number, exported for the same reason
 * `LEAD_READ_LIMIT` is: the route used to pass a literal 5000, this function
 * used to default to 1000, and the screen printed "the first 1,000 are shown"
 * over whichever of the two had actually happened. Three numbers for one fact
 * is three chances to be wrong about it.
 *
 * Pair it with {@link countLeadContacts} (or `LinkedInLeadList.leadCount`,
 * which is the same total) so a truncated page can say what it truncated.
 */
export const LEAD_CONTACT_READ_LIMIT = 5_000;

export type LeadListSourceKind = 'csv' | 'linkedin_search' | 'sales_navigator' | 'post_keyword';

export interface LinkedInLeadList {
  id: string;
  workspaceId: string;
  seatKey: string;
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
  /**
   * The list this person FIRST arrived in, or null once that list has been
   * deleted.
   *
   * NULLABLE SINCE MIGRATION 053, and the null is the point. Until then this
   * column was a hard owner -- NOT NULL, ON DELETE CASCADE -- so deleting a
   * list would have deleted every person who happened to have entered the
   * workspace through it, INCLUDING the ones sitting in five other lists.
   * Migration 052 wrote that danger down in so many words and asked whoever
   * added a delete route to fix the FK first; 053 is that fix and this is the
   * type catching up with it. A person outlives the list they came in through.
   *
   * Reads that go through the membership table (`listLeadContacts`, and
   * anything using `MEMBER_CONTACT_SELECT`) never see the null: there the
   * column is the list actually being asked about.
   */
  listId: string | null;
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

interface ListRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  name: string;
  source_kind: string;
  source_ref: string | null;
  lead_count: number;
  created_at: string;
  updated_at: string;
}
interface ContactRow {
  id: string;
  workspace_id: string;
  list_id: string | null;
  first_name: string;
  last_name: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  profile_url: string | null;
  created_at: string;
  updated_at: string;
}

// The count comes off the MEMBERSHIP table, not off `linkedin_lead_contacts.
// list_id`: since migration 051 a person may sit in several lists while still
// being one contact row, and the column only records the list they first
// landed in.
const LIST_SELECT = `l.id,l.workspace_id,l.seat_key,l.name,l.source_kind,l.source_ref,l.created_at,l.updated_at,(SELECT COUNT(*)::int FROM linkedin_lead_list_members m WHERE m.list_id=l.id) AS lead_count`;
const CONTACT_SELECT = `id,workspace_id,list_id,first_name,last_name,company,email,phone,country,profile_url,created_at,updated_at`;
/** The same columns through the membership join, where `list_id` is the list asked for. */
const MEMBER_CONTACT_SELECT = `c.id,c.workspace_id,m.list_id,c.first_name,c.last_name,c.company,c.email,c.phone,c.country,c.profile_url,c.created_at,c.updated_at`;

function toList(row: ListRow): LinkedInLeadList {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    name: row.name,
    sourceKind: row.source_kind as LeadListSourceKind,
    sourceRef: row.source_ref,
    leadCount: Number(row.lead_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function toContact(row: ContactRow): LinkedInLeadContact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    listId: row.list_id,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    country: row.country,
    profileUrl: row.profile_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function assertLeadSourceUrl(
  kind: Extract<LeadListSourceKind, 'linkedin_search' | 'sales_navigator'>,
  raw: string
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Lead source must be an absolute LinkedIn URL.');
  }
  if (!['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()))
    throw new Error('Lead source must be on linkedin.com.');
  if (kind === 'linkedin_search' && !/^\/search\/results\/people\/?/i.test(url.pathname))
    throw new Error('Basic LinkedIn source must be a People search-results URL.');
  if (kind === 'sales_navigator' && !/^\/sales\/search\/people\/?/i.test(url.pathname))
    throw new Error('Sales Navigator source must be a people-search URL.');
  return url.toString();
}

export async function createLeadList(
  db: Db,
  input: {
    workspaceId: string;
    seatKey?: string;
    name: string;
    sourceKind?: LeadListSourceKind;
    sourceRef?: string | null;
  },
  now: Date = new Date()
): Promise<LinkedInLeadList> {
  const name = input.name.trim();
  if (!name) throw new Error('Lead list name is required.');
  const sourceKind = input.sourceKind ?? 'csv';
  const sourceRef =
    sourceKind === 'linkedin_search' || sourceKind === 'sales_navigator'
      ? assertLeadSourceUrl(sourceKind, input.sourceRef ?? '')
      : input.sourceRef?.trim() || null;
  const timestamp = now.toISOString();
  const listId = id('lilst');
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  await db
    .prepare(
      `INSERT INTO linkedin_lead_lists (id,workspace_id,seat_key,name,source_kind,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(listId, input.workspaceId, seatKey, name, sourceKind, sourceRef, timestamp, timestamp);
  const row = await db
    .prepare(
      `SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.id=? AND l.workspace_id=? AND l.seat_key=?`
    )
    .get<ListRow>(listId, input.workspaceId, seatKey);
  if (!row) throw new Error('Lead list could not be created.');
  return toList(row);
}

export async function listLeadLists(
  db: Db,
  workspaceId: string,
  seatKey = OWNER_SEAT_KEY
): Promise<LinkedInLeadList[]> {
  return (
    await db
      .prepare(
        `SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.workspace_id=? AND l.seat_key=? ORDER BY l.updated_at DESC`
      )
      .all<ListRow>(workspaceId, seatKey)
  ).map(toList);
}

export async function getLeadList(
  db: Db,
  workspaceId: string,
  listId: string,
  seatKey = OWNER_SEAT_KEY
): Promise<LinkedInLeadList | undefined> {
  const row = await db
    .prepare(
      `SELECT ${LIST_SELECT} FROM linkedin_lead_lists l WHERE l.workspace_id=? AND l.seat_key=? AND l.id=?`
    )
    .get<ListRow>(workspaceId, seatKey, listId);
  return row ? toList(row) : undefined;
}

/**
 * One page of a list's people, oldest membership first.
 *
 * READ THROUGH `linkedin_lead_list_members`, which is the only place list
 * membership lives now. `linkedin_lead_contacts.list_id` still exists and is
 * still NOT NULL, but it answers "which list did this person first arrive in",
 * not "which lists are they in" -- see migration 051 and {@link insertLead}.
 *
 * BOUNDED, AND THE BOUND IS SAYABLE. Pair with {@link countLeadContacts}: a
 * page of 5000 over a list of 6000 has to be able to say so, and the old
 * signature returned an array with no total, which is why the screen printed a
 * hardcoded sentence about the first thousand rows.
 */
export async function listLeadContacts(
  db: Db,
  workspaceId: string,
  listId: string,
  limit = LEAD_CONTACT_READ_LIMIT
): Promise<LinkedInLeadContact[]> {
  return (
    await db
      .prepare(
        `
    SELECT ${MEMBER_CONTACT_SELECT}
    FROM linkedin_lead_list_members m
    JOIN linkedin_lead_contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.list_id=? ORDER BY m.created_at,c.id LIMIT ?
  `
      )
      .all<ContactRow>(workspaceId, listId, Math.max(1, Math.min(limit, LEAD_CONTACT_READ_LIMIT)))
  ).map(toContact);
}

/**
 * How many people are in this list, ignoring any page bound.
 *
 * The same number `LinkedInLeadList.leadCount` carries; exported separately so
 * a caller holding only a list id does not have to re-read the list to say
 * "showing 5,000 of 6,214".
 */
export async function countLeadContacts(
  db: Db,
  workspaceId: string,
  listId: string
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?'
    )
    .get<{ total: number }>(workspaceId, listId);
  return Number(row?.total ?? 0);
}

/**
 * THE FROM/WHERE EVERY "the contacts in list X" QUERY MUST NOW USE, as a
 * fragment, because two of them live in a file this one may not edit.
 *
 * `linkedin_lead_contacts.list_id` is no longer the answer to "which list is
 * this person in" -- since migration 051 it records only the list they FIRST
 * arrived in, and membership lives in `linkedin_lead_list_members`. A query
 * still reading the column sees a person in exactly one list, which is the bug
 * this whole change exists to remove: a lead imported into a second list would
 * be enrolled from neither.
 *
 * Drops in where `linkedin_lead_contacts c WHERE c.workspace_id=? AND
 * c.list_id=?` used to be, binding the SAME two parameters in the same order,
 * and keeps the alias `c` so nothing else in the surrounding statement moves.
 */
export const LEAD_LIST_CONTACTS_FROM_WHERE = `linkedin_lead_contacts c
  JOIN linkedin_lead_list_members m ON m.contact_id=c.id AND m.workspace_id=c.workspace_id
  WHERE m.workspace_id=? AND m.list_id=?`;

/** What one insert did: a new contact, or the existing one it found instead. */
export interface LeadInsertOutcome {
  /** The contact this person is, new or already there. '' only when unfindable. */
  contactId: string;
  inserted: boolean;
  /** The person already existed elsewhere and was ADDED to this list as well. */
  reused: boolean;
}

/**
 * Write one lead, or find the row that already is that person -- and put them
 * in this list either way.
 *
 * `ON CONFLICT DO NOTHING` WITHOUT A TARGET, and that is the change migration
 * 048 requires. Naming `(workspace_id,list_id,dedupe_key)` only handled the
 * per-list guard; the workspace-wide indexes on LOWER(profile_url) and on
 * `dedupe_key` would have raised 23505 and aborted the surrounding
 * transaction, turning "you already have this person" into a failed import of
 * the whole file.
 *
 * A CONFLICT IS ANSWERED WITH THE EXISTING CONTACT, NOT AN ERROR AND NOT A
 * COPY. One person is one contact row per workspace -- that is what makes
 * `idx_linkedin_campaign_members_one_active` mean anything.
 *
 * AND THEN THEY ARE ADDED TO THE LIST ANYWAY, WHICH IS THE PART THAT WAS
 * MISSING. Membership used to be a single `list_id` column on the contact, so
 * finding the existing row was the END of the story: the person stayed in
 * whichever list they had first landed in and never appeared in this one.
 * Importing 500 people into "Q3 founders" when 200 of them already sat in an
 * older list silently produced a 300-row list, and the campaign built on it
 * could never reach those 200 -- a quiet, unattributable hole in an outreach
 * run. The brief constrains one CAMPAIGN per lead. It never said one LIST per
 * lead, and the two were only ever conflated because one column was doing both
 * jobs. `linkedin_lead_list_members` (migration 051) does the membership job
 * now; the one-campaign claim is unaffected, because it is keyed on the
 * contact id and there is still exactly one of those per person.
 */
async function insertLead(
  db: Db,
  workspaceId: string,
  listId: string,
  lead: NormalizedLeadInput,
  now: string
): Promise<LeadInsertOutcome> {
  const row = await db
    .prepare(
      `INSERT INTO linkedin_lead_contacts (id,workspace_id,list_id,first_name,last_name,company,email,phone,country,profile_url,dedupe_key,original_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?) ON CONFLICT DO NOTHING RETURNING id`
    )
    .get<{ id: string }>(
      id('lilead'),
      workspaceId,
      listId,
      lead.firstName,
      lead.lastName,
      lead.company,
      lead.email,
      lead.phone,
      lead.country,
      lead.profileUrl,
      lead.dedupeKey,
      JSON.stringify(lead.original),
      now,
      now
    );

  // ONE LOOKUP FOR BOTH IDENTITIES. The insert can be refused by either
  // workspace-wide index, and which one refused it is not reported, so the
  // search has to cover the same ground they do: the `dedupe_key` a
  // profile-less lead is identified by AND the profile URL, whose two
  // spellings fold to one only under LOWER().
  const contactId =
    row?.id ??
    (
      await db
        .prepare(
          `
    SELECT id FROM linkedin_lead_contacts
    WHERE workspace_id=? AND (dedupe_key=? OR (?::text IS NOT NULL AND LOWER(profile_url)=LOWER(?)))
    LIMIT 1
  `
        )
        .get<{ id: string }>(workspaceId, lead.dedupeKey, lead.profileUrl, lead.profileUrl)
    )?.id ??
    '';
  if (!contactId) return { contactId: '', inserted: false, reused: false };

  const link = await db
    .prepare(
      'INSERT INTO linkedin_lead_list_members (workspace_id,list_id,contact_id,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING'
    )
    .run(workspaceId, listId, contactId, now);

  // `reused` still means what its call sites print: "this person was already
  // one of your leads and is now in this list too". A person who was ALREADY
  // in this list adds no membership row and is a plain duplicate.
  return { contactId, inserted: Boolean(row), reused: !row && link.changes > 0 };
}

export async function importLeadCsv(
  db: Db,
  input: {
    workspaceId: string;
    seatKey?: string;
    listId: string;
    csv: string;
    mapping?: LeadFieldMapping;
  },
  now: Date = new Date()
): Promise<{
  inserted: number;
  duplicates: number;
  reused: number;
  rejected: Array<{ row: number; reason: string }>;
  mapping: LeadFieldMapping;
  headers: string[];
}> {
  if (!(await getLeadList(db, input.workspaceId, input.listId)))
    throw new Error('Lead list not found.');
  const parsed = parseLeadCsv(input.csv, input.mapping);
  const timestamp = now.toISOString();
  let inserted = 0;
  let duplicates = 0;
  let reused = 0;
  await db.transaction(async (tx) => {
    for (const lead of parsed.accepted) {
      const outcome = await insertLead(tx, input.workspaceId, input.listId, lead, timestamp);
      if (outcome.inserted) inserted += 1;
      else {
        duplicates += 1;
        // Counted apart from a same-list duplicate: "this person was already
        // one of your leads and is now in this list too" is a different
        // sentence from "you uploaded them twice", and only one of them means
        // the file was wrong. Both are still `duplicates`, because neither
        // created a person.
        if (outcome.reused) reused += 1;
      }
    }
    await tx
      .prepare('UPDATE linkedin_lead_lists SET updated_at=? WHERE id=? AND workspace_id=?')
      .run(timestamp, input.listId, input.workspaceId);
  });
  return {
    inserted,
    duplicates,
    reused,
    rejected: parsed.rejected.map(({ row, reason }) => ({ row, reason })),
    mapping: parsed.mapping,
    headers: parsed.headers
  };
}

/** Which kind of list a harvested source materialises into. */
const SOURCE_LIST_KIND: Record<LeadSourceKind, LeadListSourceKind> = {
  search: 'linkedin_search',
  sales_navigator: 'sales_navigator',
  post: 'post_keyword',
  content: 'post_keyword'
};

/**
 * Materialise a lead source's harvest into a list a campaign can enrol from.
 *
 * THE GAP THIS CLOSES. `storeLeads` writes `linkedin_leads`, and campaigns
 * enrol only from `linkedin_lead_contacts`. Those are two tables with no path
 * between them, so a search that harvested 80 people could not send a single
 * message -- the operator's only route was to export a CSV and upload it back
 * into the product that already had the data.
 *
 * IT IS THE CSV PATH'S RULES, NOT A SECOND SET. The same scrub, the same
 * first/last split and the same `dedupe_key`, because a harvested Maya Chen
 * and an uploaded Maya Chen have to collide -- and they only collide if both
 * writers computed identity the same way.
 *
 * A LEAD IS STILL NOT AN ACTION. This writes contacts; enrolling them in a
 * campaign remains a separate decision a human makes.
 *
 * `leadIds` IS THE OPERATOR'S SELECTION AND IS OPTIONAL. The leads screen has
 * always had working row selection -- "12 of 80 selected" -- and no way to
 * send it anywhere, so Save imported all 80 regardless of what was ticked.
 * When it is present, only those harvested rows are considered; when it is
 * absent the whole source is imported exactly as before, which is what every
 * existing caller and the worker still do. Ids that are not part of this
 * source simply match nothing: a selection is a filter over what was
 * harvested, never a way to reach another source's rows.
 */
export async function importLeadSourceContacts(
  db: Db,
  input: {
    workspaceId: string;
    seatKey?: string;
    sourceId: string;
    listId?: string;
    listName?: string;
    limit?: number;
    leadIds?: readonly string[];
  },
  now: Date = new Date()
): Promise<{
  list: LinkedInLeadList;
  inserted: number;
  duplicates: number;
  reused: number;
  skipped: number;
}> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const source = await getLeadSource(db, input.workspaceId, input.sourceId, seatKey);
  if (!source) throw new Error('Lead source not found.');

  const list = input.listId
    ? await getLeadList(db, input.workspaceId, input.listId, seatKey)
    : await createLeadList(
        db,
        {
          workspaceId: input.workspaceId,
          seatKey,
          name: input.listName?.trim() || `Lead source ${source.id}`,
          sourceKind: SOURCE_LIST_KIND[source.kind] ?? 'csv',
          sourceRef: source.url
        },
        now
      );
  if (!list) throw new Error('Lead list not found.');

  // The same ceiling the leads screen reads with, so what an operator reviewed
  // is what Save writes -- see LEAD_READ_LIMIT.
  const all = await listLeads(
    db,
    input.workspaceId,
    source.id,
    input.limit ?? LEAD_READ_LIMIT,
    seatKey
  );
  const selection = new Set(input.leadIds ?? []);
  const harvested = selection.size > 0 ? all.filter((lead) => selection.has(lead.id)) : all;
  const timestamp = now.toISOString();
  let inserted = 0;
  let duplicates = 0;
  let reused = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const lead of harvested) {
      const normalized = normalizeScrapedLead(lead);
      if (!normalized) {
        // A row with no readable name or no addressable profile. Counted rather
        // than silently dropped: 80 harvested and 61 imported is a number an
        // operator will ask about.
        skipped += 1;
        continue;
      }
      const outcome = await insertLead(tx, input.workspaceId, list.id, normalized, timestamp);
      if (outcome.inserted) inserted += 1;
      else {
        duplicates += 1;
        if (outcome.reused) reused += 1;
      }
    }
    await tx
      .prepare('UPDATE linkedin_lead_lists SET updated_at=? WHERE id=? AND workspace_id=?')
      .run(timestamp, list.id, input.workspaceId);
  });

  const refreshed = await getLeadList(db, input.workspaceId, list.id);
  return { list: refreshed ?? list, inserted, duplicates, reused, skipped };
}

export async function updateLeadContact(
  db: Db,
  input: {
    workspaceId: string;
    contactId: string;
    firstName: string;
    lastName: string;
    company: string;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
    profileUrl?: string | null;
  },
  now: Date = new Date()
): Promise<LinkedInLeadContact> {
  const normalized = normalizeLeadRow(
    {
      firstName: input.firstName,
      lastName: input.lastName,
      company: input.company,
      email: input.email ?? '',
      phone: input.phone ?? '',
      country: input.country ?? '',
      profileUrl: input.profileUrl ?? ''
    },
    {
      firstName: 'firstName',
      lastName: 'lastName',
      company: 'company',
      email: 'email',
      phone: 'phone',
      country: 'country',
      profileUrl: 'profileUrl'
    }
  );
  // A WORKSPACE-WIDE INDEX WOULD RAISE A BARE 23505 HERE, which the API layer
  // cannot tell apart from any other unique violation and reports as the
  // generic "that LinkedIn manager name or active lead claim already exists" --
  // a 409 that names neither the field nor the row and leaves an operator
  // guessing which of six inputs was the problem.
  //
  // BOTH INDEXES ARE CHECKED, NOT JUST THE PROFILE ONE. The old pre-check
  // covered `profile_url` alone, so editing a NAME or a COMPANY into another
  // row's `dedupe_key` -- which is exactly what an operator does when they fix
  // a typo in a duplicate they just spotted -- skipped it entirely and fell
  // through to the raw constraint. One lookup covers the same ground both
  // indexes do, and the refusal names what actually clashed.
  const clash = await db
    .prepare(
      `
    SELECT id,first_name,last_name FROM linkedin_lead_contacts
    WHERE workspace_id=? AND id<>? AND (dedupe_key=? OR (?::text IS NOT NULL AND LOWER(profile_url)=LOWER(?)))
    LIMIT 1
  `
    )
    .get<{ id: string; first_name: string; last_name: string }>(
      input.workspaceId,
      input.contactId,
      normalized.dedupeKey,
      normalized.profileUrl,
      normalized.profileUrl
    );
  if (clash)
    throw new Error(leadClashMessage(normalized, `${clash.first_name} ${clash.last_name}`.trim()));
  const row = await db
    .prepare(
      `UPDATE linkedin_lead_contacts SET first_name=?,last_name=?,company=?,email=?,phone=?,country=?,profile_url=?,dedupe_key=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING ${CONTACT_SELECT}`
    )
    .get<ContactRow>(
      normalized.firstName,
      normalized.lastName,
      normalized.company,
      normalized.email,
      normalized.phone,
      normalized.country,
      normalized.profileUrl,
      normalized.dedupeKey,
      now.toISOString(),
      input.workspaceId,
      input.contactId
    );
  if (!row) throw new Error('Lead not found.');
  return toContact(row);
}

/**
 * WHICH IDENTITY THE EDIT COLLIDED ON, IN A SENTENCE.
 *
 * The three branches mirror `leadDedupeKey`'s exactly, because the key is what
 * the index refused on: a lead with a profile URL is that profile, a lead with
 * only an email is that address, and a lead with neither is a name at a
 * company. Telling an operator "a lead already exists" without saying WHICH of
 * the six fields they just typed made it true is the whole complaint.
 */
function leadClashMessage(edited: NormalizedLeadInput, who: string): string {
  const other = who || 'another lead';
  const rule = 'One person is one lead row, so that campaign claim cannot be split in two.';
  if (edited.profileUrl)
    return `The LinkedIn profile ${edited.profileUrl} already belongs to ${other} in this workspace. ${rule}`;
  if (edited.email)
    return `The email address ${edited.email} already belongs to ${other} in this workspace. ${rule}`;
  return `${edited.firstName} ${edited.lastName} at ${edited.company} is already a lead in this workspace (${other}). ${rule} Give this row a LinkedIn profile or an email address if they are a different person of the same name.`;
}

/**
 * Delete one person, everywhere.
 *
 * NOT JUST THE ROW -- THE PLANNED ACTIONS TOO, AND IN THE SAME TRANSACTION.
 * The foreign keys cascade `linkedin_campaign_members` and
 * `linkedin_manual_tasks` away, which reads like the whole cleanup and is not:
 * `linkedin_actions.campaign_member_id` has NO foreign key (046 added it as a
 * plain attribution column), so a planned, unclaimed invite or DM survived the
 * delete with a dangling member id and the worker went on to FIRE IT AT THE
 * PERSON THE OPERATOR HAD JUST REMOVED. That is the worst failure this
 * subsystem has: not a missing message, an unwanted one, sent from the
 * operator's own account after they told us to stop.
 *
 * SAME THREE RULES AS `removeCampaignMember`, WHICH ALREADY GOT THIS RIGHT --
 * every status that has not left the building, only unclaimed, and 'skipped'
 * rather than deleted, so the ledger still shows that the action existed and
 * why it never went out. A row already claimed by a worker is left alone: it
 * is mid-flight and the ledger, not this function, is what reconciles it.
 *
 * 'held' AS WELL AS 'planned', AND THE OMISSION WAS THE WORST BUG IN THIS FILE.
 * This function predates migration 051, so it skipped 'planned' alone -- and a
 * campaign that is PAUSED has parked its entire queue in 'held'. Delete a lead
 * while the campaign they are in is paused and the sequence was:
 *
 *   1. the cascade removes the contact, their campaign membership and their
 *      manual tasks, and the screen says the person is gone;
 *   2. their held ledger rows survive it, because 'held' is not 'planned' and
 *      `campaign_member_id` has no foreign key to cascade through -- they are
 *      now orphans pointing at a member row that no longer exists;
 *   3. somebody resumes the campaign, and `startManagedCampaign` moves EVERY
 *      held row of that campaign back to 'planned' in one statement -- it has
 *      no way to know which of them lost their person;
 *   4. the worker claims them and sends.
 *
 * The result is an invite or a DM going out from the customer's own LinkedIn
 * account, to somebody they explicitly deleted, days after they deleted them,
 * and it cannot be recalled. `removeCampaignMember` and `stopManagedCampaign`
 * both already say `IN ('planned','held')` for exactly this reason; this was
 * the third door into the same state and the only one still open.
 *
 * THE SKIP RUNS FIRST. After the DELETE the cascade has taken the member rows
 * with it and there is nothing left to find the actions by.
 */
export async function removeLeadContact(
  db: Db,
  workspaceId: string,
  contactId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx
      .prepare(
        `
      UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL
      WHERE workspace_id=? AND status IN ('planned','held') AND claimed_at IS NULL AND campaign_member_id IN (
        SELECT id FROM linkedin_campaign_members WHERE workspace_id=? AND contact_id=?
      )
    `
      )
      .run(workspaceId, workspaceId, contactId);
    const result = await tx
      .prepare('DELETE FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
      .run(workspaceId, contactId);
    return result.changes > 0;
  });
}

/**
 * The member states migration 046's `idx_linkedin_campaign_members_one_active`
 * is partial on: the five that hold a contact's one-campaign claim.
 *
 * Spelled here rather than imported from `managed-campaigns.ts`, which owns the
 * same list under the name `ACTIVE_MEMBER_STATUSES` -- that module imports THIS
 * one (`getLeadList`), so importing it back would close a module cycle for a
 * five-element array. The index in migration 046 is the source of truth for
 * both copies, and it is the thing that would actually break if they drifted.
 */
const CLAIMING_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;

/**
 * The campaign states that make a list undeletable.
 *
 * 'running' is obvious. 'paused' is the one worth arguing: a paused campaign is
 * not a finished one -- `startManagedCampaign` will resume it, its members
 * still hold their one-campaign claim, and its queue is sitting in 'held'
 * waiting to be handed back. Deleting the list under it would leave a campaign
 * that resumes into an empty list, having already lost the membership rows that
 * told it who it was for. A pause is a reversible state and this is a
 * destructive act; the operator stops the campaign first, and then the delete
 * is a decision they made rather than one they discovered.
 */
const LIST_LOCKING_CAMPAIGN_STATUSES = ['running', 'paused'] as const;

/**
 * What deleting a list did, counted -- so a route can tell an operator what
 * they just changed instead of returning 204 over the top of it.
 */
export interface LeadListDeletion {
  listId: string;
  name: string;
  /**
   * People taken out of THIS list. Every one of them is still a contact, and
   * still in every other list they belong to (migration 052).
   */
  membershipsRemoved: number;
  /**
   * People whose ORIGIN list this was, and whose `list_id` is now null.
   *
   * NOT A DELETE COUNT. It is reported because it is the number an operator
   * would otherwise have to guess at: "these N leads came in through this list
   * and no longer record where they came from". Before migration 053 this was
   * the number of people the delete would have DESTROYED.
   */
  contactsDetached: number;
  /** Campaigns built on this list, whose `lead_list_id` the FK has set to null. */
  campaignsDetached: number;
  /** Members of those campaigns dropped out of their claiming state. */
  membersRemoved: number;
  /** Pending human checkpoints for those campaigns, cancelled. */
  tasksCancelled: number;
  /** Planned and held ledger rows for those campaigns, skipped so nothing sends. */
  actionsSkipped: number;
}

/**
 * Delete a lead list without deleting the people in it.
 *
 * THERE WAS NO ROUTE FOR THIS, AND THE SCHEMA IS WHY. Migration 046 made
 * `linkedin_lead_contacts.list_id` NOT NULL with ON DELETE CASCADE, so the
 * database's answer to "delete this list" was to delete every contact whose
 * origin list it was -- and after migration 052 split membership into its own
 * table, that included people sitting in five other lists and enrolled in
 * other campaigns. Their campaign memberships and manual tasks would have gone
 * with them by cascade, and their planned and held ledger rows would have
 * SURVIVED as orphans (`campaign_member_id` carries no foreign key), to be
 * resumed and sent later at people who no longer existed in the product. 052
 * wrote that hazard down and asked for the FK to be fixed before this function
 * was written; migration 053 fixes it, and this is the function it was fixed
 * for.
 *
 * SO THE DELETE IS NOW ADDITIVE-SAFE, AND THIS FUNCTION HANDLES THE REST:
 *
 *   * it REFUSES while a running or paused campaign is built on the list, with
 *     a 409 naming the campaign -- see `LIST_LOCKING_CAMPAIGN_STATUSES`;
 *   * for every other campaign on the list (draft, completed, stopped) it
 *     releases the work the way `stopManagedCampaign` does: members out of
 *     their claiming state, pending manual tasks cancelled, and planned AND
 *     HELD actions skipped. 'held' is not optional here for the same reason it
 *     is not optional in `removeLeadContact` -- a held row that outlives the
 *     thing it belongs to is an unwanted message waiting for somebody to press
 *     Resume;
 *   * `claimed_at IS NULL` is the same boundary every other writer draws: a
 *     claimed row is in a browser right now and belongs to the worker holding
 *     it;
 *   * it reports what it did, because "deleted" is not an adequate answer to a
 *     button that just removed 4,000 people from a list and unhooked two
 *     campaigns.
 *
 * ORDER MATTERS AND IS THE REVERSE OF THE CASCADE. Everything is counted and
 * released while the rows still exist to be found; the DELETE is last, and
 * the FKs (`ON DELETE CASCADE` for memberships, `ON DELETE SET NULL` for
 * contacts and for `linkedin_campaigns.lead_list_id`) finish the job.
 *
 * Returns undefined when there is no such list in this workspace, so a route
 * can answer 404 without a second read.
 */
export async function deleteLeadList(
  db: Db,
  workspaceId: string,
  listId: string
): Promise<LeadListDeletion | undefined> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: the refusal below and the delete at the bottom must see the
    // same list, and a concurrent campaign start must not slip between them.
    const list = await tx
      .prepare('SELECT id,name FROM linkedin_lead_lists WHERE workspace_id=? AND id=? FOR UPDATE')
      .get<{ id: string; name: string }>(workspaceId, listId);
    if (!list) return undefined;

    const blocking = await tx
      .prepare(
        `
      SELECT name,status FROM linkedin_campaigns
      WHERE workspace_id=? AND lead_list_id=? AND status = ANY(?::text[])
      ORDER BY created_at LIMIT 3
    `
      )
      .all<{ name: string; status: string }>(workspaceId, listId, [
        ...LIST_LOCKING_CAMPAIGN_STATUSES
      ]);
    if (blocking.length > 0) {
      const named = blocking.map((c) => `'${c.name}' (${c.status})`).join(', ');
      throw new LinkedInApiError(
        `This lead list is still driving ${named}. Stop ${blocking.length === 1 ? 'that campaign' : 'those campaigns'} first -- ` +
          'a paused campaign is one somebody intends to resume, and resuming it into a deleted list would leave it running for nobody.',
        409
      );
    }

    const scope =
      'campaign_id IN (SELECT id FROM linkedin_campaigns WHERE workspace_id=? AND lead_list_id=?)';

    const members = await tx
      .prepare(
        `
      UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE workspace_id=? AND status = ANY(?::text[]) AND ${scope}
    `
      )
      .run(workspaceId, [...CLAIMING_MEMBER_STATUSES], workspaceId, listId);

    const tasks = await tx
      .prepare(
        `
      UPDATE linkedin_manual_tasks SET status='cancelled'
      WHERE workspace_id=? AND status='pending' AND ${scope}
    `
      )
      .run(workspaceId, workspaceId, listId);

    const actions = await tx
      .prepare(
        `
      UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL
      WHERE workspace_id=? AND status IN ('planned','held') AND claimed_at IS NULL AND ${scope}
    `
      )
      .run(workspaceId, workspaceId, listId);

    // Counted BEFORE the delete, because after it the FKs have already moved
    // every one of these rows out of reach of the question.
    const memberships = await tx
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?'
      )
      .get<{ total: number }>(workspaceId, listId);
    const contacts = await tx
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=? AND list_id=?'
      )
      .get<{ total: number }>(workspaceId, listId);
    const campaigns = await tx
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_campaigns WHERE workspace_id=? AND lead_list_id=?'
      )
      .get<{ total: number }>(workspaceId, listId);

    await tx
      .prepare('DELETE FROM linkedin_lead_lists WHERE workspace_id=? AND id=?')
      .run(workspaceId, listId);

    return {
      listId: list.id,
      name: list.name,
      membershipsRemoved: Number(memberships?.total ?? 0),
      contactsDetached: Number(contacts?.total ?? 0),
      campaignsDetached: Number(campaigns?.total ?? 0),
      membersRemoved: members.changes,
      tasksCancelled: tasks.changes,
      actionsSkipped: actions.changes
    };
  });
}
