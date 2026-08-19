import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import type { OutreachThread } from './types.js';

/**
 * Postgres state for community outreach.
 *
 * The port of the reference's SQLite `db.Database`. Everything the reference
 * kept in a local file lives in the workspace's own Postgres here: there is no
 * second store, no cache file, and no path that works differently when a
 * process restarts on another host.
 *
 * All of it is workspace-scoped. The reference had one global database because
 * it ran on one laptop for one account; a multi-tenant deployment cannot share
 * a daily cap between two founders.
 */

/** Stable fingerprint of a thread's readable content. Changes when the thread is edited. */
export function threadContentHash(thread: Pick<OutreachThread, 'title' | 'content'>): string {
  return createHash('sha256').update(`${thread.title}\n${thread.content}`).digest('hex');
}

export interface SeenFilterResult {
  /** Threads still open to a reply, newest discovery first. */
  fresh: OutreachThread[];
  /** How many were withheld because we have already replied to them. */
  repliedCount: number;
  /** External ids whose content changed since we last saw them. */
  changed: string[];
}

/**
 * Record `threads` and return the ones still open to a reply.
 *
 * WHAT "SEEN" MEANS HERE, and why it is not what the reference meant.
 *
 * The reference excluded any thread it had ever parsed. That is wrong once
 * discovery outruns replying, which it does immediately: a run that finds 200
 * threads and replies to the best one would bury the other 199 forever, and
 * the second run would return nothing at all. Scoring is pure and cheap;
 * REPLYING is the expensive, irreversible act. So exclusion is keyed on the
 * post log -- a thread drops out when we have actually replied to it, not when
 * we have merely looked at it.
 *
 * `outreach_threads` therefore serves two jobs, neither of which is exclusion:
 * it is the denominator of the self-promotion ratio, and it is the record of
 * what a thread said when we first read it, so `changed` can report that an
 * author edited their question after we scored it.
 */
export async function recordSeenThreads(
  db: Db,
  workspaceId: string,
  threads: readonly OutreachThread[],
  now: Date
): Promise<SeenFilterResult> {
  const fresh: OutreachThread[] = [];
  const changed: string[] = [];
  let repliedCount = 0;
  const timestamp = now.toISOString();

  for (const thread of threads) {
    const hash = threadContentHash(thread);
    // The prior hash is read in a CTE that is evaluated against the snapshot
    // BEFORE the upsert writes the new one. Reading it from RETURNING instead
    // would always report the value just written, making an edit undetectable.
    const row = await db
      .prepare(
        `
      WITH prior AS (
        SELECT content_hash, TRUE AS existed FROM outreach_threads
        WHERE workspace_id=? AND platform=? AND external_id=?
      ), replied AS (
        SELECT TRUE AS done FROM outreach_posts
        WHERE workspace_id=? AND platform=? AND thread_external_id=? AND status <> 'failed'
        LIMIT 1
      ), upserted AS (
      INSERT INTO outreach_threads (
        id, workspace_id, platform, external_id, url, title, content, content_hash, author,
        community, score, num_comments, thread_created_at, metadata_json, first_seen_at, last_seen_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?)
      ON CONFLICT (workspace_id, platform, external_id) DO UPDATE SET
        score = excluded.score,
        num_comments = excluded.num_comments,
        title = excluded.title,
        content = excluded.content,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at
      RETURNING id
      )
      SELECT
        (SELECT content_hash FROM prior) AS previous_hash,
        COALESCE((SELECT existed FROM prior), FALSE) AS existed,
        COALESCE((SELECT done FROM replied), FALSE) AS replied
      FROM upserted
    `
      )
      .get<{ previous_hash: string | null; existed: boolean; replied: boolean }>(
        workspaceId,
        thread.platform,
        thread.externalId,
        workspaceId,
        thread.platform,
        thread.externalId,
        id('othr'),
        workspaceId,
        thread.platform,
        thread.externalId,
        thread.url,
        thread.title,
        thread.content,
        hash,
        thread.author,
        thread.community,
        Math.trunc(thread.score),
        Math.trunc(thread.numComments),
        thread.createdAt,
        JSON.stringify(thread.metadata ?? {}),
        timestamp,
        timestamp
      );

    if (row?.existed && row.previous_hash !== null && row.previous_hash !== hash)
      changed.push(thread.externalId);

    if (row?.replied) repliedCount += 1;
    else fresh.push(thread);
  }

  return { fresh, repliedCount, changed };
}

/** True when we have already replied to (or handed off) this thread. */
export async function isThreadReplied(
  db: Db,
  workspaceId: string,
  platform: string,
  externalId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `
    SELECT id FROM outreach_posts
    WHERE workspace_id=? AND platform=? AND thread_external_id=? AND status <> 'failed'
    LIMIT 1
  `
    )
    .get<{ id: string }>(workspaceId, platform, externalId);
  return row !== undefined;
}

/**
 * Posts on `platform` in the 24 hours before `now`.
 *
 * A rolling window, not a calendar day. The reference counted rows whose date
 * matched today's, which let a cap of 5 deliver 10 posts across a midnight
 * boundary -- and midnight in whose timezone was never defined.
 */
export async function countPostsToday(
  db: Db,
  workspaceId: string,
  platform: string,
  now: Date
): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const row = await db
    .prepare(
      `
    SELECT COUNT(*)::int AS total FROM outreach_posts
    WHERE workspace_id=? AND platform=? AND status <> 'failed' AND created_at > ?
  `
    )
    .get<{ total: number }>(workspaceId, platform, since);
  return row?.total ?? 0;
}

/** When we last posted into `community`, or null if never. */
export async function lastPostInCommunity(
  db: Db,
  workspaceId: string,
  platform: string,
  community: string
): Promise<Date | null> {
  // Formatted in SQL rather than parsed from pg's raw timestamptz text: the
  // pool sets a pass-through type parser for 1184, so the driver hands back
  // '2026-08-03 10:00:00+00' and leaves the parsing to us. Doing it here keeps
  // one unambiguous ISO shape instead of relying on Date's tolerance.
  const row = await db
    .prepare(
      `
    SELECT TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at
    FROM outreach_posts
    WHERE workspace_id=? AND platform=? AND LOWER(community)=LOWER(?) AND status <> 'failed'
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get<{ posted_at: string }>(workspaceId, platform, community);
  if (!row?.posted_at) return null;
  return new Date(row.posted_at);
}

export interface CommunityVolume {
  discovered: number;
  posted: number;
}

/** Threads discovered in, and posts made into, one community. The self-promo ratio's two terms. */
export async function communityVolume(
  db: Db,
  workspaceId: string,
  platform: string,
  community: string
): Promise<CommunityVolume> {
  const discovered = await db
    .prepare(
      `
    SELECT COUNT(*)::int AS total FROM outreach_threads
    WHERE workspace_id=? AND platform=? AND LOWER(community)=LOWER(?)
  `
    )
    .get<{ total: number }>(workspaceId, platform, community);
  const posted = await db
    .prepare(
      `
    SELECT COUNT(*)::int AS total FROM outreach_posts
    WHERE workspace_id=? AND platform=? AND LOWER(community)=LOWER(?) AND status <> 'failed'
  `
    )
    .get<{ total: number }>(workspaceId, platform, community);
  return { discovered: discovered?.total ?? 0, posted: posted?.total ?? 0 };
}

export interface ExistingPost {
  id: string;
  status: string;
  provider: string | null;
  external_ref: string | null;
}

/** The non-failed post already logged under this payload hash, if any. */
export async function existingPost(
  db: Db,
  workspaceId: string,
  payloadHash: string
): Promise<ExistingPost | undefined> {
  return db
    .prepare(
      `
    SELECT id, status, provider, external_ref FROM outreach_posts
    WHERE workspace_id=? AND payload_hash=? AND status <> 'failed'
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get<ExistingPost>(workspaceId, payloadHash);
}

/** Resolve a claimed (`pending`) row once the platform's answer is known. */
export async function settlePost(
  db: Db,
  postId: string,
  outcome: {
    status: OutreachPostStatus;
    provider: string | null;
    externalRef: string | null;
    error: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE outreach_posts SET status=?, provider=?, external_ref=?, error=? WHERE id=?
  `
    )
    .run(outcome.status, outcome.provider, outcome.externalRef, outcome.error, postId);
}

/**
 * - `pending`        -- the payload hash is CLAIMED and a write is in flight.
 * - `posted`         -- delivered through the platform's own write API.
 * - `manual_handoff` -- prepared for a human because the channel is prepare-only.
 * - `failed`         -- the platform explicitly rejected it; the claim is released.
 */
export type OutreachPostStatus = 'pending' | 'posted' | 'manual_handoff' | 'failed';

export interface OutreachPostRecord {
  workspaceId: string;
  platform: string;
  community: string | null;
  threadExternalId: string;
  threadUrl: string;
  payloadHash: string;
  status: OutreachPostStatus;
  provider: string | null;
  externalRef: string | null;
  error: string | null;
  body: string;
}

/**
 * Append to the post log.
 *
 * Returns the existing row id when this payload hash was already logged, so a
 * retried action step is a no-op rather than a duplicate comment. The unique
 * index does the enforcing; this just reports it without throwing.
 */
export async function recordPost(
  db: Db,
  record: OutreachPostRecord,
  now: Date
): Promise<{ id: string; duplicate: boolean }> {
  const postId = id('opst');
  const row = await db
    .prepare(
      `
    INSERT INTO outreach_posts (
      id, workspace_id, platform, community, thread_external_id, thread_url,
      payload_hash, status, provider, external_ref, error, body, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, payload_hash) WHERE status <> 'failed' DO NOTHING
    RETURNING id
  `
    )
    .get<{ id: string }>(
      postId,
      record.workspaceId,
      record.platform,
      record.community,
      record.threadExternalId,
      record.threadUrl,
      record.payloadHash,
      record.status,
      record.provider,
      record.externalRef,
      record.error,
      record.body,
      now.toISOString()
    );

  if (row) return { id: row.id, duplicate: false };

  const existing = await db
    .prepare(
      `
    SELECT id FROM outreach_posts
    WHERE workspace_id=? AND payload_hash=? AND status <> 'failed'
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get<{ id: string }>(record.workspaceId, record.payloadHash);
  return { id: existing?.id ?? postId, duplicate: true };
}

export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  /** The body as last read. '' for rows discovered before migration 082. */
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
  metadata_json: Record<string, unknown>;
}

/**
 * Discovered threads, best-scored first, tied breaking newest-first. The read
 * path `outreach_threads` never had -- see docs/superpowers/specs/2026-08-18-research-hub-design.md.
 */
export async function listOutreachThreads(
  db: Db,
  workspaceId: string,
  filters: { platform?: string; limit?: number } = {}
): Promise<OutreachThreadRow[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.platform) {
    clauses.push('platform=?');
    params.push(filters.platform);
  }
  params.push(limit);
  return db
    .prepare(
      `
    SELECT id, platform, external_id, url, title, content, author, community, score,
           num_comments, thread_created_at, first_seen_at, metadata_json
    FROM outreach_threads
    WHERE ${clauses.join(' AND ')}
    ORDER BY score DESC, first_seen_at DESC
    LIMIT ?
  `
    )
    .all<OutreachThreadRow>(...params);
}
