import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { LinkedInApiError, ingestOutcome, recordDetectedAcceptance } from './campaigns.js';
import { profileUrlFor } from './driver.js';
import type { LinkedInInboxMessage, LinkedInThreadSummary } from './driver-inbox.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { OWNER_SEAT_KEY } from './seats.js';

/**
 * The unified inbox: conversations in, one reply out.
 *
 * Until this file, Trevra could tell an operator what it had SENT and nothing
 * about what came back. The action queue is a send log; a conversation view is
 * what makes it a funnel, because a reply is the only outcome in the whole
 * chain that a human has to answer -- and, not incidentally, the outcome the
 * acceptance-rate throttle and the day-over-day clamp are starved of when
 * nobody reports it by hand.
 *
 * TWO RULES GOVERN THIS FILE, AND BOTH ARE ABOUT NOT ROUTING AROUND SOMETHING
 * THAT ALREADY WORKS.
 *
 * 1. A REPLY IS AN ACTION, SO IT GOES THROUGH THE GATE AND THE LEDGER.
 *    `enqueueReply` does not send anything. It runs `evaluateLinkedInSafety`
 *    for a `reply` -- its own kind, with its own row in `limits.ts` whose
 *    numbers are `dm`'s exactly -- and then files an ordinary
 *    `linkedin_actions` row for the local worker to claim, gate AGAIN at the
 *    moment of execution, and execute. There is no second sending path in this
 *    module and there must never be one. A "replies are different, they are
 *    just answering someone" shortcut is a hole straight through every ceiling
 *    in `limits.ts`: the account that gets restricted does not know which of
 *    its messages were replies.
 *
 *    The gate is therefore run TWICE, and that is deliberate rather than
 *    wasteful. Here, so an operator is told NOW that their reply is over the
 *    daily DM band instead of discovering it from a queue that silently never
 *    drains; and again in `runLinkedInLocalBatch`, because approval is a
 *    decision about CONTENT and the clock keeps moving afterwards.
 *
 * 2. AN INBOUND REPLY IS REPORTED THROUGH `ingestOutcome`, NEVER WRITTEN
 *    DIRECTLY. `writeActionStatus` refuses a worker-only status ('sent',
 *    'accepted', 'replied') from every caller except `via: 'outcome-ingest'`,
 *    on purpose: the API plans and approves, it never claims something reached
 *    LinkedIn. Detecting a reply IS a claim about what a stranger's account
 *    did, so it takes the sanctioned door -- which also means it inherits that
 *    path's refusals for free (a skipped action never went out and can carry no
 *    outcome). Writing `status='replied'` from here with an UPDATE would work
 *    on the first day and would delete the reason the rule exists.
 *
 * THE LINKAGE IS THE FEATURE, not a nicety. A conversation that cannot be tied
 * back to the campaign that started it leaves the funnel exactly as fictional
 * as it was before: 40 invites sent, unknown replies. The tie is
 * `linkedin_threads.profile_url` matched against `linkedin_actions.target_ref`,
 * and it is the reason the driver pays an extra navigation per conversation to
 * resolve a profile URL the messaging rail does not publish.
 *
 * NOTHING HERE PACES OFF ANYTHING IT READ FROM A PAGE. `last_message_at` and
 * `sent_at` are parses of rendered display text (see `parseInboxTimestamp`);
 * every ceiling in this subsystem reads `linkedin_actions.recorded_at` and
 * nothing else. That separation is rule 1 of actions.ts and this file does not
 * bend it.
 */

/* -------------------------------------------------------------------------
 * Read models.
 * ---------------------------------------------------------------------- */

export interface LinkedInThreadRecord {
  id: string;
  workspaceId: string;
  seatKey: string;
  threadUrn: string;
  /** Canonical profile URL, comparable with `linkedin_actions.target_ref`. */
  profileUrl: string | null;
  name: string | null;
  /** ISO-8601, approximate to the day, or null. Orders a screen; paces nothing. */
  lastMessageAt: string | null;
  unread: boolean;
  snippet: string;
  /** The campaign this conversation was resolved to, if the ledger knows one. */
  campaignId: string | null;
  syncedAt: string;
  createdAt: string;
  /** Stored messages in this conversation. */
  messageCount: number;
  /** Whether they have written at least once. The whole point of the inbox. */
  hasReply: boolean;
}

export interface LinkedInMessageRecord {
  id: string;
  threadId: string;
  direction: 'in' | 'out';
  body: string;
  /** ISO-8601 or null -- parsed from display text, never invented. */
  sentAt: string | null;
  externalRef: string;
  /** The ledger row that produced an outbound message, when it is attributable. */
  actionId: string | null;
  createdAt: string;
  /**
   * The Trevra user whose live request queued the `linkedin_actions` row
   * behind this message (migration 043, team-workspace-access design), read
   * off `action_id`. Null for an inbound message (nothing was queued), a
   * message with no attributable action, or one queued before that column
   * existed.
   */
  queuedByUserId: string | null;
}

interface ThreadRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  thread_urn: string;
  profile_url: string | null;
  name: string | null;
  last_message_at: string | null;
  unread: boolean;
  snippet: string;
  campaign_id: string | null;
  synced_at: string;
  created_at: string;
  message_count: number;
  has_reply: boolean;
}

interface MessageRow {
  id: string;
  thread_id: string;
  direction: string;
  body: string;
  sent_at: string | null;
  external_ref: string;
  action_id: string | null;
  created_at: string;
  queued_by_user_id: string | null;
}

/**
 * TIMESTAMPTZ is formatted in SQL rather than parsed from what the driver hands
 * back -- the pool installs a pass-through parser for 1184, so a raw column
 * arrives as Postgres' own text rendering. Same choice, same reason, as
 * `SEAT_COLUMNS` in seats.ts: one ISO-8601 shape crosses the API.
 */
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const THREAD_COLUMNS = `
  t.id, t.workspace_id, t.seat_key, t.thread_urn, t.profile_url, t.name,
  TO_CHAR(t.last_message_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS last_message_at,
  t.unread, t.snippet, t.campaign_id,
  TO_CHAR(t.synced_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS synced_at,
  TO_CHAR(t.created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  -- SCOPED TO THE WORKSPACE AS WELL AS THE THREAD, and the extra clause is the
  -- whole reason this subquery is affordable. idx_linkedin_messages_thread
  -- (031) is on (workspace_id, thread_id, position); the only index on
  -- thread_id alone is partial on direction='in'. So the unscoped form of this
  -- count could use neither, and one 500-row inbox page became 500 sequential
  -- scans of a table that holds every message ever synced. A message always
  -- belongs to its thread's workspace -- syncThreadMessages writes both from
  -- the same row, and the dedupe index is keyed on the pair -- so naming it
  -- here narrows nothing and turns the count into an index probe.
  (SELECT COUNT(*) FROM linkedin_messages m WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.id)::int AS message_count,
  EXISTS (SELECT 1 FROM linkedin_messages m WHERE m.thread_id = t.id AND m.direction = 'in') AS has_reply
`;

const MESSAGE_COLUMNS = `
  id, thread_id, direction, body,
  TO_CHAR(sent_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS sent_at,
  external_ref, action_id,
  TO_CHAR(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  (SELECT a.queued_by_user_id FROM linkedin_actions a WHERE a.id = linkedin_messages.action_id) AS queued_by_user_id
`;

function toThread(row: ThreadRow): LinkedInThreadRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    threadUrn: row.thread_urn,
    profileUrl: row.profile_url,
    name: row.name,
    lastMessageAt: row.last_message_at,
    unread: row.unread,
    snippet: row.snippet,
    campaignId: row.campaign_id,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    messageCount: row.message_count,
    hasReply: row.has_reply
  };
}

function toMessage(row: MessageRow): LinkedInMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    direction: row.direction === 'in' ? 'in' : 'out',
    body: row.body,
    sentAt: row.sent_at,
    externalRef: row.external_ref,
    actionId: row.action_id,
    createdAt: row.created_at,
    queuedByUserId: row.queued_by_user_id
  };
}

/* -------------------------------------------------------------------------
 * Matching a conversation to the ledger.
 * ---------------------------------------------------------------------- */

/**
 * Every spelling of one profile that a `target_ref` might legitimately hold.
 *
 * `linkedin_actions.target_ref` is documented as OPAQUE: whatever a human typed
 * or a CSV supplied, never resolved, never rewritten. So the same person is in
 * the ledger as a bare handle, as a URL with or without `www`, with or without
 * a trailing slash. The thread, by contrast, carries exactly one canonical
 * form. Matching therefore expands the canonical form into the small closed set
 * of spellings that mean the same person, all lower-cased, and compares against
 * `LOWER(target_ref)` -- the same case-folding 023 and 025 both settled on.
 *
 * It expands a KNOWN form into candidates; it never parses a stored one into a
 * person. An unrecognised `target_ref` simply does not match, which leaves an
 * action unlinked -- the safe direction to be wrong in, because the alternative
 * is marking the wrong stranger's invite as replied.
 */
export function targetRefCandidates(profileUrl: string): string[] {
  const canonical = profileUrlFor(profileUrl);
  if (!canonical) return [];
  const match = /\/in\/([^/]+)\/*$/.exec(new URL(canonical).pathname);
  if (!match) return [];
  let handle = match[1];
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // Keep the escaped form: it is what LinkedIn itself produced.
  }
  const encoded = match[1];
  const paths = new Set([handle, encoded]);
  const candidates = new Set<string>();
  for (const path of paths) {
    candidates.add(path);
    candidates.add(`in/${path}`);
    candidates.add(`/in/${path}`);
    for (const host of ['https://www.linkedin.com', 'https://linkedin.com', 'http://www.linkedin.com', 'http://linkedin.com']) {
      candidates.add(`${host}/in/${path}`);
      candidates.add(`${host}/in/${path}/`);
    }
    candidates.add(`www.linkedin.com/in/${path}`);
    candidates.add(`linkedin.com/in/${path}`);
  }
  return [...candidates].map((value) => value.toLowerCase());
}

interface LedgerMatch {
  id: string;
  kind: string;
  status: string;
  campaign_id: string | null;
}

/**
 * Ledger rows against the person in this conversation, best candidate first.
 *
 * ORDERED INVITE FIRST, then most recent. When a target has both an invite and
 * a DM, the invite is the row a reply should land on: `acceptanceRate` counts
 * invites and nothing else, and a reply is the strongest evidence an invite was
 * accepted (actions.ts treats 'replied' as implying acceptance everywhere). The
 * recency tiebreak is what settles everything else.
 *
 * `limit` IS REQUIRED AND IS NOT OPTIONAL BY OVERSIGHT. The ORDER BY is two
 * expressions -- a boolean over `kind` and a three-way COALESCE -- and no
 * index carries either, so Postgres must sort every matching row before it can
 * answer. Unbounded, that meant a seat with a long history against one person
 * sorted the whole set to hand back a list whose consumers read `[0]` and
 * `.length`. Every caller states the smallest number that answers its own
 * question, and both of them state 1.
 */
/**
 * This seat's invites to that person that are still awaiting an answer.
 *
 * A SEPARATE QUERY FROM `ledgerMatches` RATHER THAN A FILTER OVER IT, because
 * the two ask different questions. `ledgerMatches` finds the ONE best row a
 * reply should be reported against and takes `LIMIT 1` accordingly; this finds
 * every undecided invite, because a workspace that re-invited somebody after a
 * withdrawal can legitimately hold more than one and the reply proves all of
 * them were accepted. Bounded anyway: nobody has an unbounded number of
 * outstanding invites to one person, and an unbounded query would be a sort
 * over a person's entire history for a loop that writes at most a handful.
 */
async function pendingInvitesFor(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrl: string | null
): Promise<Array<{ id: string }>> {
  if (!profileUrl) return [];
  const candidates = targetRefCandidates(profileUrl);
  if (candidates.length === 0) return [];
  return db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind='invite'
      AND LOWER(target_ref) = ANY(?::text[])
      AND status IN ('sent', 'exported')
    ORDER BY COALESCE(recorded_at, created_at) DESC, id DESC
    LIMIT 5
  `).all<{ id: string }>(workspaceId, seatKey, candidates);
}

async function ledgerMatches(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrl: string | null,
  statuses: readonly string[] | null,
  limit: number
): Promise<LedgerMatch[]> {
  if (!profileUrl) return [];
  const candidates = targetRefCandidates(profileUrl);
  if (candidates.length === 0) return [];

  const clauses = ['workspace_id=?', 'seat_key=?', 'LOWER(target_ref) = ANY(?::text[])'];
  const params: unknown[] = [workspaceId, seatKey, candidates];
  if (statuses) {
    clauses.push('status = ANY(?::text[])');
    params.push([...statuses]);
  } else {
    clauses.push("status <> 'skipped'");
  }
  params.push(Math.max(1, Math.trunc(limit)));

  return db.prepare(`
    SELECT id, kind, status, campaign_id FROM linkedin_actions
    WHERE ${clauses.join(' AND ')}
    ORDER BY (kind = 'invite') DESC, COALESCE(recorded_at, planned_for, created_at) DESC, id DESC
    LIMIT ?
  `).all<LedgerMatch>(...params);
}

/**
 * The campaign each of these conversations belongs to, for a whole page of
 * them at once.
 *
 * THE BATCHED FORM OF WHAT `syncThreads` USED TO ASK PER THREAD. The question
 * is unchanged -- "among this person's non-skipped ledger rows, ordered invite
 * first and then most recent, what is the campaign on the best one that has
 * one" -- but a 5,000-conversation sync asked it 5,000 times, each time
 * expanding one profile URL into its spellings and sorting the result.
 *
 * One statement asks it for every conversation at once and the answer is
 * assembled here, IN THE SAME ORDER THE SINGLE-THREAD QUERY PRODUCED. The
 * comparator in the ORDER BY is the same one, and a total order restricted to
 * a subset keeps the relative order of that subset -- so walking the rows once
 * and taking, for each thread, the first row that carries a campaign is
 * exactly `matches.find((match) => match.campaign_id)` per thread, without the
 * per-thread round trip.
 *
 * A candidate spelling that two conversations share is a person in two
 * conversations, so it resolves for both rather than for whichever was seen
 * first.
 */
async function campaignByProfileUrl(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrls: readonly string[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (profileUrls.length === 0) return resolved;

  // Every spelling any of these people might be filed under, and which
  // conversation(s) each spelling belongs to.
  const owners = new Map<string, string[]>();
  for (const profileUrl of new Set(profileUrls)) {
    for (const candidate of targetRefCandidates(profileUrl)) {
      const existing = owners.get(candidate);
      if (existing) existing.push(profileUrl);
      else owners.set(candidate, [profileUrl]);
    }
  }
  if (owners.size === 0) return resolved;

  const rows = await db.prepare(`
    SELECT LOWER(target_ref) AS ref, campaign_id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND LOWER(target_ref) = ANY(?::text[]) AND status <> 'skipped'
    ORDER BY (kind = 'invite') DESC, COALESCE(recorded_at, planned_for, created_at) DESC, id DESC
  `).all<{ ref: string; campaign_id: string | null }>(workspaceId, seatKey, [...owners.keys()]);

  for (const row of rows) {
    if (!row.campaign_id) continue;
    for (const profileUrl of owners.get(row.ref) ?? []) {
      if (!resolved.has(profileUrl)) resolved.set(profileUrl, row.campaign_id);
    }
  }
  return resolved;
}

/**
 * Statuses a reply may be reported against.
 *
 * 'planned' is absent because a planned action HAS NOT HAPPENED -- nobody can
 * have replied to a message that was never sent, and marking it 'replied' would
 * both invent a send and consume budget for it. 'skipped' is absent because
 * `ingestOutcome` refuses it anyway, and for the better reason: the target was
 * released. 'declined' and 'replied' are absent because they are already
 * decided, which is also what makes re-syncing a conversation idempotent.
 */
const REPLYABLE: readonly string[] = ['exported', 'sent', 'accepted'];

/* -------------------------------------------------------------------------
 * Syncing what the driver read.
 * ---------------------------------------------------------------------- */

export interface ThreadSyncInput {
  workspaceId: string;
  seatKey?: string;
  /** Straight from `listConversations`. */
  threads: LinkedInThreadSummary[];
}

export interface ThreadSyncResult {
  created: number;
  updated: number;
  /** Conversations whose campaign pointer was resolved from the ledger this run. */
  linked: number;
  threads: LinkedInThreadRecord[];
}

/**
 * File what the conversation rail said, keyed by conversation id.
 *
 * IDEMPOTENT BY CONSTRUCTION: `thread_urn` is unique per workspace, so a second
 * sync updates the row it already wrote. What is OVERWRITTEN and what is KEPT
 * differs on purpose. `unread`, `snippet` and `synced_at` are facts about the
 * page just read and are replaced wholesale -- a stale unread badge is worse
 * than none. `profile_url`, `name` and `last_message_at` are COALESCEd, because
 * the driver reports null for "could not read this time", and letting a failed
 * profile hop erase a URL that was resolved last week would break the campaign
 * linkage on a bad afternoon.
 *
 * FOUR STATEMENTS FOR THE WHOLE PAGE, NOT THREE OR FOUR PER CONVERSATION.
 * This ran a loop: SELECT the existing row, ask the ledger which campaign the
 * person belongs to, upsert, then SELECT the stored row back to return it. A
 * 5,000-conversation sync was ~20,000 round trips, and the last of those four
 * was pure waste -- it re-read a row this function had just written, one at a
 * time, for the only reason that the upsert returned an id instead of the
 * record. Now: one SELECT for every existing row, one batched ledger question
 * (`campaignByProfileUrl`), one `unnest` upsert, one read-back for the whole
 * page. The number of statements no longer depends on how many conversations
 * LinkedIn showed us.
 *
 * NOTHING ABOUT THE RESULT CHANGED. `created` and `updated` are still decided
 * by whether the row was already there, `linked` still counts only the
 * conversations whose campaign pointer was resolved THIS RUN, and `threads` is
 * still every synced conversation in the order the rail listed them.
 *
 * DUPLICATE URNs IN ONE PAGE COLLAPSE TO THE LAST ONE. The loop's semantics
 * were the same -- the second write overwrote the first -- but a batched
 * `INSERT ... ON CONFLICT DO UPDATE` cannot touch a row twice in one
 * statement, so the collapse happens here, explicitly, instead of as a
 * runtime error.
 */
export async function syncThreads(db: Db, input: ThreadSyncInput, now: Date): Promise<ThreadSyncResult> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const timestamp = now.toISOString();
  const result: ThreadSyncResult = { created: 0, updated: 0, linked: 0, threads: [] };

  const summaries = new Map<string, LinkedInThreadSummary>();
  for (const summary of input.threads) {
    const threadUrn = summary.threadUrn?.trim();
    if (!threadUrn) continue;
    summaries.set(threadUrn, summary);
  }
  if (summaries.size === 0) return result;
  const urns = [...summaries.keys()];

  const existingRows = await db.prepare(`
    SELECT id, thread_urn, profile_url, campaign_id FROM linkedin_threads
    WHERE workspace_id=? AND seat_key=? AND thread_urn = ANY(?::text[])
  `).all<{ id: string; thread_urn: string; profile_url: string | null; campaign_id: string | null }>(
    input.workspaceId,
    seatKey,
    urns
  );
  const existing = new Map(existingRows.map((row) => [row.thread_urn, row]));

  // The profile URL each conversation will be stored with: what the rail read
  // this time, or what we already had. A failed profile hop reports null and
  // must not erase a URL resolved last week.
  const profileUrls = new Map<string, string | null>();
  for (const [threadUrn, summary] of summaries) {
    const known = existing.get(threadUrn);
    profileUrls.set(threadUrn, (summary.profileUrl ? profileUrlFor(summary.profileUrl) : null) ?? known?.profile_url ?? null);
  }

  // Resolved once and then left alone: the ledger's answer for a given target
  // does not change, and re-asking on every sync would run one query per
  // conversation forever for a pointer that is already correct. Asked here for
  // every conversation that still needs one, in a single statement.
  const unresolved = [...summaries.keys()]
    .filter((threadUrn) => !existing.get(threadUrn)?.campaign_id)
    .map((threadUrn) => profileUrls.get(threadUrn) ?? null)
    .filter((profileUrl): profileUrl is string => profileUrl !== null);
  const resolvedCampaigns = await campaignByProfileUrl(db, input.workspaceId, seatKey, unresolved);

  const ids: string[] = [];
  const workspaceIds: string[] = [];
  const seatKeys: string[] = [];
  const threadUrns: string[] = [];
  const urlColumn: Array<string | null> = [];
  const names: Array<string | null> = [];
  const lastMessageAts: Array<string | null> = [];
  const unreads: boolean[] = [];
  const snippets: string[] = [];
  const campaignIds: Array<string | null> = [];
  const timestamps: string[] = [];

  for (const [threadUrn, summary] of summaries) {
    const known = existing.get(threadUrn);
    const profileUrl = profileUrls.get(threadUrn) ?? null;
    let campaignId = known?.campaign_id ?? null;
    if (!campaignId && profileUrl) {
      campaignId = resolvedCampaigns.get(profileUrl) ?? null;
      if (campaignId) result.linked += 1;
    }

    ids.push(known?.id ?? id('lthr'));
    workspaceIds.push(input.workspaceId);
    seatKeys.push(seatKey);
    threadUrns.push(threadUrn);
    urlColumn.push(profileUrl);
    names.push(summary.name);
    lastMessageAts.push(summary.lastMessageAt);
    unreads.push(summary.unread);
    snippets.push(summary.snippet ?? '');
    campaignIds.push(campaignId);
    timestamps.push(timestamp);

    if (known) result.updated += 1;
    else result.created += 1;
  }

  await db.prepare(`
    INSERT INTO linkedin_threads (
      id, workspace_id, seat_key, thread_urn, profile_url, name,
      last_message_at, unread, snippet, campaign_id, synced_at, created_at
    )
    SELECT * FROM unnest(
      ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
      ?::timestamptz[], ?::boolean[], ?::text[], ?::text[], ?::timestamptz[], ?::timestamptz[]
    )
    ON CONFLICT (workspace_id, seat_key, thread_urn) DO UPDATE SET
      profile_url = COALESCE(excluded.profile_url, linkedin_threads.profile_url),
      name = COALESCE(excluded.name, linkedin_threads.name),
      last_message_at = COALESCE(excluded.last_message_at, linkedin_threads.last_message_at),
      unread = excluded.unread,
      snippet = excluded.snippet,
      campaign_id = COALESCE(excluded.campaign_id, linkedin_threads.campaign_id),
      synced_at = excluded.synced_at
  `).run(
    ids, workspaceIds, seatKeys, threadUrns, urlColumn, names,
    lastMessageAts, unreads, snippets, campaignIds, timestamps, timestamps
  );

  // One read-back for the page, then put it in the order the rail listed the
  // conversations in -- which is what the per-thread re-read used to produce
  // as a side effect of doing it inside the loop.
  const storedRows = await db.prepare(`
    SELECT ${THREAD_COLUMNS} FROM linkedin_threads t
    WHERE t.workspace_id=? AND t.seat_key=? AND t.thread_urn = ANY(?::text[])
  `).all<ThreadRow>(input.workspaceId, seatKey, urns);
  const stored = new Map(storedRows.map((row) => [row.thread_urn, toThread(row)]));
  for (const threadUrn of urns) {
    const record = stored.get(threadUrn);
    if (record) result.threads.push(record);
  }

  return result;
}

export interface ThreadMessageSyncInput {
  workspaceId: string;
  seatKey?: string;
  threadUrn: string;
  /** Straight from `readThread` in driver-inbox.ts, oldest first. */
  messages: LinkedInInboxMessage[];
}

export interface ThreadMessageSyncResult {
  threadId: string;
  inserted: number;
  /** Messages this sync had already stored. On a healthy re-sync, all of them. */
  duplicates: number;
  /** Newly stored inbound messages -- the ones that can mark an action replied. */
  inbound: number;
  /** The ledger row this reply was reported against, if any. */
  repliedActionId: string | null;
  /**
   * Pending invites this reply proved were accepted.
   *
   * Usually one, usually the same row `repliedActionId` names -- an invite that
   * is accepted and then answered ends the sync as 'replied', with
   * `accepted_at` and `accepted_source='detected'` recording the acceptance the
   * status no longer has room to say.
   */
  acceptedActionIds: string[];
  /** What happened to the campaign linkage, in a sentence an operator can act on. */
  linkage: string;
}

/**
 * The dedupe key for a message.
 *
 * A content hash rather than LinkedIn's own message id, because the driver's
 * locator surface cannot read an attribute (see migration 031). Direction is
 * included so the same sentence quoted back is not swallowed, and the rendered
 * timestamp is included because it is the only other thing that distinguishes
 * two identical messages. The residual collision -- the same text, the same
 * direction, the same rendered minute -- collapses into one row, which is the
 * correct way to be wrong when the alternative duplicates the whole transcript
 * on every sync.
 */
function messageRef(message: LinkedInInboxMessage): string {
  // JSON rather than a delimiter: the three parts stay unambiguously separated
  // whatever a message body happens to contain.
  const digest = createHash('sha256')
    .update(JSON.stringify([message.direction, message.at ?? '', message.body]))
    .digest('hex');
  return `sha256:${digest.slice(0, 32)}`;
}

/**
 * Store one conversation's messages, then report any reply to the ledger.
 *
 * THE REPLY REPORT GOES THROUGH `ingestOutcome`, for the reason in the module
 * header. It fires only for a NEWLY STORED inbound message against an action
 * that is still open, so re-syncing a conversation reports nothing a second
 * time and cannot walk an action's `recorded_at` forward on every tick.
 *
 * `occurredAt` is the message's own timestamp when it parsed, because the
 * outcome being reported is the reply and dating it at sync time would file
 * Tuesday's answer on Friday. When the rendered text did not parse, `now` is
 * used and the linkage sentence says so rather than pretending to a precision
 * that was not read.
 */
export async function syncThreadMessages(
  db: Db,
  input: ThreadMessageSyncInput,
  now: Date
): Promise<ThreadMessageSyncResult> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const thread = await threadByUrn(db, input.workspaceId, input.threadUrn, seatKey);
  if (!thread) {
    throw new LinkedInApiError(
      `No LinkedIn conversation '${input.threadUrn}' has been synced for this workspace. Conversations are stored by the inbox sync; this call does not create one to hold a message.`,
      404
    );
  }

  const highest = await db.prepare(`
    SELECT COALESCE(MAX(position), -1)::int AS top FROM linkedin_messages WHERE workspace_id=? AND thread_id=?
  `).get<{ top: number }>(input.workspaceId, thread.id);
  let position = (highest?.top ?? -1) + 1;

  const timestamp = now.toISOString();
  let inserted = 0;
  let duplicates = 0;
  let inbound = 0;
  let latestInboundAt: string | null = null;

  for (const message of input.messages) {
    if (!message.body?.trim()) continue;
    const row = await db.prepare(`
      INSERT INTO linkedin_messages (
        id, workspace_id, thread_id, direction, body, sent_at, position, external_ref, action_id, created_at
      ) VALUES (?,?,?,?,?,?::timestamptz,?::int,?,?,?::timestamptz)
      ON CONFLICT (workspace_id, thread_id, external_ref) DO NOTHING
      RETURNING id
    `).get<{ id: string }>(
      id('lmsg'),
      input.workspaceId,
      thread.id,
      message.direction === 'in' ? 'in' : 'out',
      message.body,
      message.at,
      position,
      messageRef(message),
      null,
      timestamp
    );

    if (!row) {
      duplicates += 1;
      continue;
    }
    inserted += 1;
    position += 1;
    if (message.direction === 'in') {
      inbound += 1;
      latestInboundAt = message.at ?? latestInboundAt;
    }
  }

  const result: ThreadMessageSyncResult = {
    threadId: thread.id,
    inserted,
    duplicates,
    inbound,
    repliedActionId: null,
    acceptedActionIds: [],
    linkage: 'No new inbound message arrived, so no outreach action changed.'
  };
  if (inbound === 0) return result;

  if (!thread.profileUrl) {
    result.linkage =
      'A reply arrived, but this conversation has no resolved profile URL, so there is no campaign target to attach it to. Re-run the inbox sync with profile resolution enabled.';
    return result;
  }

  /*
   * A REPLY IS ACCEPTANCE EVIDENCE, AND IT IS FILED BEFORE THE REPLY IS.
   *
   * Somebody this seat invited is now messaging it. On LinkedIn a message from
   * a stranger you have an outstanding invite to is, in the overwhelming
   * ordinary case, a message from somebody who has just accepted it -- the
   * Message control is shown to connections, and `local-worker.ts` builds its
   * whole implicit acceptance gate on exactly that fact.
   *
   * WHY IT CANNOT WAIT FOR `ingestOutcome` BELOW TO DO IT. That call moves the
   * invite to 'replied', which is a strictly stronger statement and is what the
   * funnel should show -- but 'replied' overwrites 'accepted', so the ledger
   * ends up with no record that the acceptance was ever established, no date
   * for it, and no provenance. Every acceptance counter in the product had to
   * compensate by spelling out `IN ('accepted','replied')`, and none of them
   * could say WHEN or on what evidence. Marking it first fills `accepted_at`
   * and `accepted_source`, which survive the status moving on (migration 070).
   *
   * It goes through `recordDetectedAcceptance`, so a human who already ruled on
   * this invite by hand outranks it and a decided invite is left alone.
   */
  const acceptedByReply: string[] = [];
  for (const invite of await pendingInvitesFor(db, input.workspaceId, seatKey, thread.profileUrl)) {
    const written = await recordDetectedAcceptance(
      db,
      {
        workspaceId: input.workspaceId,
        actionId: invite.id,
        // Dated at the reply, not at the sync: the acceptance is at least as old
        // as the message that proves it.
        ...(latestInboundAt === null ? {} : { detectedAt: latestInboundAt })
      },
      now
    );
    if (written.applied) acceptedByReply.push(invite.id);
  }
  result.acceptedActionIds = acceptedByReply;

  // ONE ROW IS THE WHOLE QUESTION. Only `open[0]` is ever reported against --
  // the ORDER BY is what decides which row that is -- so the query says so
  // rather than sorting a person's whole history to hand back a list this
  // function reads the head of.
  const open = await ledgerMatches(db, input.workspaceId, seatKey, thread.profileUrl, REPLYABLE, 1);
  if (open.length === 0) {
    // The same question the old `any.some((match) => match.status ===
    // 'replied')` asked, asked of the database instead of a materialised list:
    // is there a row against this person already settled as replied. 'replied'
    // is not 'skipped', so the status filter selects from exactly the set the
    // unfiltered call used to return.
    const alreadyReplied = await ledgerMatches(db, input.workspaceId, seatKey, thread.profileUrl, ['replied'], 1);
    result.linkage = alreadyReplied.length > 0
      ? `A reply arrived and ${thread.profileUrl} is already recorded as having replied, so nothing changed.`
      : `A reply arrived from ${thread.profileUrl}, and this seat has no outreach action against them that a reply could be reported against. The conversation is stored; the funnel is unchanged.`;
    return result;
  }

  const target = open[0];
  const view = await ingestOutcome(
    db,
    {
      workspaceId: input.workspaceId,
      actionId: target.id,
      outcome: 'replied',
      ...(latestInboundAt === null ? {} : { occurredAt: latestInboundAt })
    },
    now
  );

  result.repliedActionId = view.id;
  result.linkage =
    `${thread.profileUrl} replied, so their ${target.kind} (${target.id}) moved from '${target.status}' to 'replied'`
    + `${latestInboundAt === null ? ' and was dated at this sync, because the message carried no readable timestamp' : ''}.`
    + (acceptedByReply.length === 0
      ? ''
      : ` Their pending invite is also recorded as accepted, on the reply as evidence: ${acceptedByReply.join(', ')}.`);

  // A conversation whose reply landed on a campaign action belongs to that
  // campaign, even if the thread was first synced before the pointer existed.
  if (!thread.campaignId && view.campaignId) {
    await db.prepare('UPDATE linkedin_threads SET campaign_id=? WHERE id=? AND workspace_id=?')
      .run(view.campaignId, thread.id, input.workspaceId);
  }

  return result;
}

/**
 * Forget every stored conversation for this workspace: every `linkedin_thread`
 * and, by the `ON DELETE CASCADE` in migration 031, every `linkedin_message`
 * hanging off one.
 *
 * THE ONE CALLER IS AN ACCOUNT CHANGE. `local-worker.ts`'s `detectLinkedInSeat`
 * calls this the moment a freshly-confirmed `profileUrl` disagrees with the
 * one this workspace last stored: the threads and messages in this schema are
 * a READ CACHE of one specific LinkedIn account's inbox (seats.ts: one seat
 * per workspace, so nothing here is scoped to WHICH account produced it), and
 * leaving a previous account's conversations in place would show the operator
 * somebody else's DMs as their new seat's own.
 *
 * `linkedin_actions` -- the send ledger -- is never touched here, for the same
 * reason `deleteSeat` never touches it: it is history, not this account's
 * current view, and a reset must not double as a silent delete of what Trevra
 * actually sent.
 */
export async function clearInboxForWorkspace(db: Db, workspaceId: string): Promise<number> {
  const result = await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
  return result.changes;
}

/** Clear only the read cache belonging to one LinkedIn account. */
export async function clearInboxForSeat(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): Promise<number> {
  const result = await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=? AND seat_key=?').run(workspaceId, seatKey);
  return result.changes;
}

/* -------------------------------------------------------------------------
 * Reading the inbox.
 * ---------------------------------------------------------------------- */

export interface ThreadFilters {
  /** Conversations LinkedIn still showed a badge on at the last sync. */
  unread?: boolean;
  /** Conversations they have written in. `false` asks for the ones still silent. */
  hasReply?: boolean;
  campaignId?: string;
  seatKey?: string;
  limit?: number;
}

/**
 * The inbox list, always scoped to one workspace.
 *
 * `workspace_id=?` is the first clause and is not optional anywhere in this
 * file, for the reason campaigns.ts states about the action queue: a thread id
 * is a global identifier, so a handler that looked one up by id alone would
 * serve one workspace's private conversations to another's session.
 */
export async function listThreads(db: Db, workspaceId: string, filters: ThreadFilters = {}): Promise<LinkedInThreadRecord[]> {
  const clauses = ['t.workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) {
    clauses.push('t.seat_key=?');
    params.push(filters.seatKey);
  }
  if (filters.unread !== undefined) {
    clauses.push('t.unread=?');
    params.push(filters.unread);
  }
  if (filters.campaignId) {
    clauses.push('t.campaign_id=?');
    params.push(filters.campaignId);
  }
  if (filters.hasReply !== undefined) {
    clauses.push(
      `${filters.hasReply ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 FROM linkedin_messages m WHERE m.thread_id = t.id AND m.direction = 'in')`
    );
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));

  const rows = await db.prepare(`
    SELECT ${THREAD_COLUMNS} FROM linkedin_threads t
    WHERE ${clauses.join(' AND ')}
    ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC
    LIMIT ?
  `).all<ThreadRow>(...params);
  return rows.map(toThread);
}
// `threadById` lived here to re-read one conversation immediately after
// `syncThreads` had written it, one row at a time. The batched sync reads the
// whole page back in one statement, and nothing else ever looked a thread up
// by its opaque id -- every other path in this file keys on the URN, because
// that is what LinkedIn and the API both name -- so the helper is gone rather
// than left behind as the obvious thing for a future loop to reach for.
/** One conversation by LinkedIn's own id, or undefined. */
export async function threadByUrn(
  db: Db,
  workspaceId: string,
  threadUrn: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInThreadRecord | undefined> {
  const row = await db.prepare(`SELECT ${THREAD_COLUMNS} FROM linkedin_threads t WHERE t.thread_urn=? AND t.workspace_id=? AND t.seat_key=?`)
    .get<ThreadRow>(threadUrn, workspaceId, seatKey);
  return row ? toThread(row) : undefined;
}

export interface LinkedInConversation {
  thread: LinkedInThreadRecord;
  /** Oldest first, in the order LinkedIn rendered them. */
  messages: LinkedInMessageRecord[];
}

/**
 * One conversation and everything stored in it.
 *
 * ORDERED BY `position`, NOT BY `sent_at`. `sent_at` is a parse of display text
 * and is frequently null; `position` is the order the messages were read out of
 * a chronologically-rendered thread, which is the real sequence. Migration 031
 * carries the long version.
 */
export async function readThread(
  db: Db,
  workspaceId: string,
  threadUrn: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInConversation | undefined> {
  const thread = await threadByUrn(db, workspaceId, threadUrn, seatKey);
  if (!thread) return undefined;
  const rows = await db.prepare(`
    SELECT ${MESSAGE_COLUMNS} FROM linkedin_messages
    WHERE workspace_id=? AND thread_id=?
    ORDER BY position ASC, id ASC
  `).all<MessageRow>(workspaceId, thread.id);
  return { thread, messages: rows.map(toMessage) };
}

/* -------------------------------------------------------------------------
 * Replying.
 * ---------------------------------------------------------------------- */

export interface ReplyRequest {
  workspaceId: string;
  seatKey?: string;
  threadUrn: string;
  /** The approved bytes. Passed through verbatim or refused; never truncated. */
  body: string;
  /** ISO-8601 slot the reply is paced into. Defaults to now. */
  plannedFor?: string;
  /** The Trevra user whose live request queued this reply -- see `LinkedInActionRecord.queuedByUserId`. */
  queuedByUserId?: string | null;
  /**
   * The operator ticked "Override the warm-up ceiling" in the composer.
   *
   * THE ONLY PLACE IN TREVRA THAT MAY SET migration 044's
   * `linkedin_actions.override_warmup_ceiling`, which is what that column's own
   * COMMENT says and what makes the flag mean anything: it is a HUMAN saying "I
   * am answering somebody who wrote to me and I accept the ramp does not fit
   * this one message". Nothing infers it, nothing defaults it on, and the
   * worker never decides it -- the worker reads it back off the row so the
   * decision travels with the action it was made about.
   *
   * It relaxes the `warmup-ceiling` check and NOTHING ELSE. The gate still runs
   * whole and can still refuse this reply for any of its other reasons, and the
   * verdict returned to the composer says in the check's own detail that the
   * ceiling was overridden rather than passed.
   */
  overrideWarmupCeiling?: boolean;
}

export interface EnqueuedReply {
  actionId: string;
  threadId: string;
  threadUrn: string;
  /** The canonical profile URL the worker will send to. */
  targetRef: string;
  campaignId: string | null;
  plannedFor: string;
  /** The full verdict, so a UI can show what was checked rather than just that it passed. */
  verdict: LinkedInSafetyVerdict;
}

/**
 * The replay identity of a reply: this conversation, and the message it answers.
 *
 * WHY THIS PAIR AND NOT SOMETHING ELSE. `replay_scope` (migration 047) asks
 * "which action IS this, within its kind and target", and for a reply the
 * honest answer is not "a reply to Maya" -- Maya will be replied to many times
 * over a live conversation -- it is "the answer to what Maya just said". The
 * thread pins the conversation; the last stored message pins the point in it.
 * A thread that has moved on since gives the next reply a different identity;
 * a thread that has not gives it the same one, which is exactly when a second
 * queued reply is a double-submit rather than a follow-up.
 *
 * THE ANCHOR IS THE LAST MESSAGE IN THE THREAD, INBOUND OR OUTBOUND, and both
 * directions matter. Inbound is the ordinary case (they wrote, we answer).
 * Outbound is what lets a conversation be carried on: once this seat's reply
 * has been sent and the inbox sync has stored it, it becomes the anchor, so the
 * message after it is a new action rather than a permanent 409.
 *
 * `external_ref` is used rather than the row id because it is the content
 * digest `messageRef` computes -- stable across re-syncs of the same
 * transcript, where a row id is only stable while the row survives. A thread
 * with nothing stored yet anchors on 'thread-start', which is a real position
 * (nobody has said anything) rather than a missing value.
 *
 * Ordered by `position`, for the reason `readThread` documents: `sent_at` is a
 * parse of display text and is frequently null, while `position` is the order
 * LinkedIn rendered them in.
 */
async function replyReplayScope(db: Db, workspaceId: string, threadId: string, threadUrn: string): Promise<string> {
  const last = await db.prepare(`
    SELECT external_ref FROM linkedin_messages
    WHERE workspace_id=? AND thread_id=?
    ORDER BY position DESC, id DESC
    LIMIT 1
  `).get<{ external_ref: string }>(workspaceId, threadId);
  return `thread:${threadUrn}:${last?.external_ref ?? 'thread-start'}`;
}

/**
 * Queue one reply. NOTHING IS SENT HERE.
 *
 * The order below is the whole design and it is not rearrangeable:
 *
 *   1. The conversation must exist and must have a resolved profile URL. The
 *      driver sends a DM by navigating to a profile, so a thread without one is
 *      a conversation nobody can answer through this path -- and saying so is
 *      better than filing a row that can never execute.
 *   2. The gate runs, for kind `reply`, against that profile URL and the
 *      requested slot. A refusal is a 409 carrying the gate's own reason. This
 *      is the rule from the module header: a reply is an action.
 *   3. Only then is the row filed, through `recordAction` -- so the ledger's
 *      replay guard, its `recorded_at` discipline and its duplicate reporting
 *      all apply unchanged.
 *   4. The approved bytes and the conversation id are attached to the row that
 *      was just created, inside the same transaction. That ordering is safe for
 *      a reason worth naming: the worker's claim query refuses a `reply` whose
 *      body or `thread_urn` is null or empty (local-worker.ts), so a
 *      half-written row is not claimable rather than claimable-and-empty, and
 *      the transaction means it cannot survive at all.
 *
 * WHY ITS OWN KIND AND NOT A `dm`.
 *
 * The original reading -- a reply costs the account what a DM costs it, so file
 * it as one -- is right about the PACING and wrong about the LEDGER, and the
 * ledger is what broke. Two guards refuse a second action of one kind against
 * one target: `duplicate-target` in the gate, and the partial unique index from
 * 022 behind `recordAction`. Both are correct for a cold DM. But answering
 * somebody this seat has already messaged is the ORDINARY use of an inbox, not
 * the abuse those guards exist to stop, so filing a reply as a `dm` made the
 * normal case indistinguishable from the pathological one: every reply to a
 * campaign target was refused, and the refusal below -- written as
 * "defensive, and it should be unreachable" -- was in fact the common path.
 *
 * The choice was to weaken the replay guard for messages or to give a reply its
 * own kind. Weakening it means a hole through the one mechanism that stops a
 * replayed export from inviting the same stranger twice. The kind costs one row
 * in `limits.ts`, and that row is `dm`'s numbers copied verbatim, tagged
 * UNVERIFIED-VENDOR because the DECISION to mirror is ours -- so a reply can
 * never buy volume a DM could not, which is the half of the original reasoning
 * that was right.
 *
 * WHAT IS STILL REFUSED, AND WHAT STOPPED BEING REFUSED.
 *
 * The replay guard used to be keyed on (workspace, seat, kind, target) with no
 * further identity, and a reply filed under the default 'legacy' scope. That
 * made ONE reply per person the ceiling FOR THE LIFE OF THE LEDGER: the first
 * reply was queued, sent, and left as a non-skipped row, so the second reply to
 * the same conversation -- weeks later, answering a message that had not been
 * written yet -- was a permanent 409. A guard built to stop a replayed export
 * from inviting a stranger twice was ending conversations.
 *
 * Migration 047 widened that index to include `replay_scope`, and a reply now
 * names its own: THE CONVERSATION, PLUS THE MESSAGE IT IS ANSWERING (see
 * `replyReplayScope`). That key is the natural one because it is what a reply
 * IS -- an answer to a particular thing somebody said in a particular thread --
 * and it draws the line in the place the operator would draw it:
 *
 *   - a second reply after they have written again is a DIFFERENT answer to a
 *     DIFFERENT message, so it has a different scope and is queued;
 *   - a second reply after the first has been sent and synced back is likewise
 *     anchored past it, so a conversation can be carried on;
 *   - a double-submitted composer -- the same reply, twice, before either has
 *     moved the thread -- resolves to the SAME scope and is refused, which is
 *     the case the guard existed for.
 *
 * The refusal that remains is therefore "you already have an unsent answer to
 * that exact message", which is a true and useful thing to say, rather than
 * "this person has been replied to once, ever".
 */
export async function enqueueReply(db: Db, input: ReplyRequest, now: Date): Promise<EnqueuedReply> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const body = input.body ?? '';
  if (!body.trim()) {
    throw new LinkedInApiError('A reply needs a body. Trevra sends approved bytes and does not compose them.', 400);
  }

  // PER SEAT, AND THIS ARGUMENT IS LOAD-BEARING. `threadByUrn` defaults its
  // last parameter to the owner seat, and omitting it here meant a reply
  // queued for a SECONDARY account resolved the OWNER's conversation: the row
  // was filed against the wrong account's thread, its profile URL and campaign
  // came from the wrong inbox, and the worker would have sent it from a
  // LinkedIn identity nobody chose. The same silent default is what
  // `withdraw.ts` had in four places and what
  // `postgresLocalWorkerStore.seatPosture` carries its own comment about --
  // the failure mode of a defaulted seat key is never a missing row, it is the
  // wrong account acting, which is why the whole subsystem is per seat.
  //
  // A conversation that belongs to another seat is reported as NOT FOUND
  // rather than as a permission error, which is the same answer another
  // workspace's thread already gets: from this seat's point of view it does
  // not exist, and saying so leaks nothing about the other account's inbox.
  const thread = await threadByUrn(db, input.workspaceId, input.threadUrn, seatKey);
  if (!thread) throw new LinkedInApiError('LinkedIn conversation not found', 404);
  if (!thread.profileUrl) {
    throw new LinkedInApiError(
      'This conversation has no resolved LinkedIn profile URL, so a reply cannot be paced or addressed. Run the inbox sync with profile resolution first.',
      409
    );
  }
  const targetRef = thread.profileUrl;

  const plannedFor = input.plannedFor ?? now.toISOString();
  if (Number.isNaN(new Date(plannedFor).getTime())) {
    throw new LinkedInApiError(`'${plannedFor}' is not a parseable instant, so this reply has no slot to be paced into.`, 400);
  }

  const replayScope = await replyReplayScope(db, input.workspaceId, thread.id, thread.threadUrn);
  const overrideWarmupCeiling = input.overrideWarmupCeiling === true;

  const verdict = await evaluateLinkedInSafety(
    db,
    {
      workspaceId: input.workspaceId,
      seatKey,
      kind: 'reply',
      targetRef,
      plannedFor,
      // Asked in the ledger's own terms, so the gate and the row that is about
      // to be written agree about what would collide with what.
      replayScope,
      // The operator's decision, honoured here so they are told NOW whether the
      // override was enough -- and persisted below so it is honoured again at
      // the moment of execution without anybody having to remember it.
      ...(overrideWarmupCeiling ? { overrideWarmupCeiling: true } : {})
    },
    now
  );
  if (!verdict.allowed) {
    // FAIL CLOSED, and report the gate's own words. The alternative -- queue it
    // anyway and let the worker refuse -- looks kinder and is not: the operator
    // watches a reply sit in a queue that will never drain, with no way to see
    // why from the screen they typed it on.
    throw new LinkedInApiError(`This reply was refused by the LinkedIn safety gate -- ${verdict.reason}`, 409);
  }

  const filed = await db.transaction(async (tx) => {
    const record = await recordAction(
      tx,
      {
        workspaceId: input.workspaceId,
        seatKey,
        kind: 'reply',
        targetRef,
        campaignId: thread.campaignId,
        status: 'planned',
        plannedFor,
        source: 'manual',
        replayScope,
        queuedByUserId: input.queuedByUserId ?? null
      },
      now
    );
    if (record.duplicate) return record;
    // The approved bytes AND the conversation, in the same statement and the
    // same transaction as the row. The worker's claim refuses a reply missing
    // either (local-worker.ts), so a half-written row is not claimable rather
    // than claimable-and-unsendable -- and the transaction means it cannot
    // survive at all.
    // `override_warmup_ceiling` rides along in the same statement and the same
    // transaction as the bytes, because it is the same fact about the same
    // decision: this row is an operator's answer to a person, sent under an
    // exception they chose. Migration 044's COMMENT names `enqueueReply` as the
    // only writer, and this is it.
    await tx.prepare('UPDATE linkedin_actions SET body=?, thread_urn=?, override_warmup_ceiling=? WHERE id=? AND workspace_id=?')
      .run(body, thread.threadUrn, overrideWarmupCeiling, record.id, input.workspaceId);
    return record;
  });

  if (filed.duplicate) {
    // Defensive, and it should be unreachable: the gate's `duplicate-target`
    // check reads the same predicate as the ledger's replay guard, so a
    // duplicate here means one of them changed without the other. Reported
    // rather than swallowed, because silently returning the earlier row would
    // tell an operator their reply was queued when their words were dropped.
    throw new LinkedInApiError(
      `The ledger already holds a reply to ${targetRef} answering the same message in this conversation, so this one was not queued. Send or discard that one first; once the conversation moves on, the next reply is a different action.`,
      409
    );
  }

  return {
    actionId: filed.id,
    threadId: thread.id,
    threadUrn: thread.threadUrn,
    targetRef,
    campaignId: thread.campaignId,
    plannedFor,
    verdict
  };
}
