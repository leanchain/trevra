import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { LinkedInApiError, ingestOutcome } from './campaigns.js';
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
  (SELECT COUNT(*) FROM linkedin_messages m WHERE m.thread_id = t.id)::int AS message_count,
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
 */
async function ledgerMatches(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrl: string | null,
  statuses: readonly string[] | null
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

  return db.prepare(`
    SELECT id, kind, status, campaign_id FROM linkedin_actions
    WHERE ${clauses.join(' AND ')}
    ORDER BY (kind = 'invite') DESC, COALESCE(recorded_at, planned_for, created_at) DESC, id DESC
  `).all<LedgerMatch>(...params);
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
 */
export async function syncThreads(db: Db, input: ThreadSyncInput, now: Date): Promise<ThreadSyncResult> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const timestamp = now.toISOString();
  const result: ThreadSyncResult = { created: 0, updated: 0, linked: 0, threads: [] };

  for (const summary of input.threads) {
    const threadUrn = summary.threadUrn?.trim();
    if (!threadUrn) continue;

    const existing = await db.prepare(`
      SELECT id, profile_url, campaign_id FROM linkedin_threads WHERE workspace_id=? AND seat_key=? AND thread_urn=?
    `).get<{ id: string; profile_url: string | null; campaign_id: string | null }>(input.workspaceId, seatKey, threadUrn);

    const profileUrl = (summary.profileUrl ? profileUrlFor(summary.profileUrl) : null) ?? existing?.profile_url ?? null;

    // Resolved once and then left alone: the ledger's answer for a given target
    // does not change, and re-asking on every sync would run one query per
    // conversation forever for a pointer that is already correct.
    let campaignId = existing?.campaign_id ?? null;
    if (!campaignId && profileUrl) {
      const matches = await ledgerMatches(db, input.workspaceId, seatKey, profileUrl, null);
      campaignId = matches.find((match) => match.campaign_id)?.campaign_id ?? null;
      if (campaignId) result.linked += 1;
    }

    const row = await db.prepare(`
      INSERT INTO linkedin_threads (
        id, workspace_id, seat_key, thread_urn, profile_url, name,
        last_message_at, unread, snippet, campaign_id, synced_at, created_at
      ) VALUES (?,?,?,?,?,?,?::timestamptz,?,?,?,?::timestamptz,?::timestamptz)
      ON CONFLICT (workspace_id, seat_key, thread_urn) DO UPDATE SET
        profile_url = COALESCE(excluded.profile_url, linkedin_threads.profile_url),
        name = COALESCE(excluded.name, linkedin_threads.name),
        last_message_at = COALESCE(excluded.last_message_at, linkedin_threads.last_message_at),
        unread = excluded.unread,
        snippet = excluded.snippet,
        campaign_id = COALESCE(excluded.campaign_id, linkedin_threads.campaign_id),
        synced_at = excluded.synced_at
      RETURNING id
    `).get<{ id: string }>(
      existing?.id ?? id('lthr'),
      input.workspaceId,
      seatKey,
      threadUrn,
      profileUrl,
      summary.name,
      summary.lastMessageAt,
      summary.unread,
      summary.snippet ?? '',
      campaignId,
      timestamp,
      timestamp
    );

    if (existing) result.updated += 1;
    else result.created += 1;

    const stored = await threadById(db, input.workspaceId, (row as { id: string }).id);
    if (stored) result.threads.push(stored);
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
    linkage: 'No new inbound message arrived, so no outreach action changed.'
  };
  if (inbound === 0) return result;

  if (!thread.profileUrl) {
    result.linkage =
      'A reply arrived, but this conversation has no resolved profile URL, so there is no campaign target to attach it to. Re-run the inbox sync with profile resolution enabled.';
    return result;
  }

  const open = await ledgerMatches(db, input.workspaceId, seatKey, thread.profileUrl, REPLYABLE);
  if (open.length === 0) {
    const any = await ledgerMatches(db, input.workspaceId, seatKey, thread.profileUrl, null);
    result.linkage = any.some((match) => match.status === 'replied')
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
    + `${latestInboundAt === null ? ' and was dated at this sync, because the message carried no readable timestamp' : ''}.`;

  // A conversation whose reply landed on a campaign action belongs to that
  // campaign, even if the thread was first synced before the pointer existed.
  if (!thread.campaignId && view.campaignId) {
    await db.prepare('UPDATE linkedin_threads SET campaign_id=? WHERE id=? AND workspace_id=?')
      .run(view.campaignId, thread.id, input.workspaceId);
  }

  return result;
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

async function threadById(db: Db, workspaceId: string, threadId: string): Promise<LinkedInThreadRecord | undefined> {
  const row = await db.prepare(`SELECT ${THREAD_COLUMNS} FROM linkedin_threads t WHERE t.id=? AND t.workspace_id=?`)
    .get<ThreadRow>(threadId, workspaceId);
  return row ? toThread(row) : undefined;
}

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
 * WHAT IS STILL REFUSED. A second reply to the same person in the same
 * conversation, because `duplicate-target` and the replay guard now apply to
 * `reply` exactly as they applied to `dm`. That is a real limitation and it is
 * the conservative direction: one queued reply per person at a time, and the
 * next one may be queued once this one has been sent... which it may not, since
 * a sent row is still non-skipped.
 *
 * lc-debt: one reply per (seat, target) for the life of the ledger, so a
 * conversation cannot be answered twice through this path; upgrade path is a
 * replay guard keyed on (workspace, seat, kind, target, thread_urn) for
 * kind='reply' plus the matching `hasTarget` predicate, which needs the 022
 * index widened rather than dropped.
 */
export async function enqueueReply(db: Db, input: ReplyRequest, now: Date): Promise<EnqueuedReply> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const body = input.body ?? '';
  if (!body.trim()) {
    throw new LinkedInApiError('A reply needs a body. Trevra sends approved bytes and does not compose them.', 400);
  }

  const thread = await threadByUrn(db, input.workspaceId, input.threadUrn);
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

  const verdict = await evaluateLinkedInSafety(
    db,
    { workspaceId: input.workspaceId, seatKey, kind: 'reply', targetRef, plannedFor },
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
    await tx.prepare('UPDATE linkedin_actions SET body=?, thread_urn=? WHERE id=? AND workspace_id=?')
      .run(body, thread.threadUrn, record.id, input.workspaceId);
    return record;
  });

  if (filed.duplicate) {
    // Defensive, and it should be unreachable: the gate's `duplicate-target`
    // check reads the same predicate as the ledger's replay guard, so a
    // duplicate here means one of them changed without the other. Reported
    // rather than swallowed, because silently returning the earlier row would
    // tell an operator their reply was queued when their words were dropped.
    throw new LinkedInApiError(
      `The ledger already holds a reply to ${targetRef} for this seat, so this one was not queued. One target takes one action of one kind per seat.`,
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
