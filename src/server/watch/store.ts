import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import type { OutreachThread } from '../outreach/types.js';
import { SENTIMENT_VERSION, type Sentiment } from './sentiment.js';

/**
 * Postgres state for brand/keyword watches.
 *
 * Every statement is workspace-scoped, including the ones that take a watch id:
 * a watch id is guessable enough that scoping on it alone would be a
 * cross-tenant read. `getWatch`/`updateWatch` return null and `deleteWatch`
 * returns false when the row belongs to another workspace, so callers turn
 * that into a 404 rather than leaking that the id exists.
 */

export interface BrandWatch {
  id: string;
  workspaceId: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  enabled: boolean;
  limitPerPlatform: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface BrandWatchInput {
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  limitPerPlatform?: number;
  enabled?: boolean;
}

interface WatchRow {
  id: string;
  workspace_id: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: string;
  enabled: boolean;
  limit_per_platform: number;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
}

// The pool installs a pass-through parser for timestamptz, so these arrive as
// raw pg text ('2026-09-01 09:00:00+00'). Formatting them in SQL instead keeps
// one unambiguous ISO shape rather than relying on Date's tolerance.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const WATCH_COLUMNS = `
  id, workspace_id, name, keywords, platforms, cadence, enabled, limit_per_platform,
  TO_CHAR(next_run_at AT TIME ZONE 'UTC', ${ISO}) AS next_run_at,
  TO_CHAR(last_run_at AT TIME ZONE 'UTC', ${ISO}) AS last_run_at,
  last_error
`;

function serialize(row: WatchRow): BrandWatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    keywords: row.keywords ?? [],
    platforms: row.platforms ?? [],
    cadence: row.cadence === 'weekly' ? 'weekly' : 'daily',
    enabled: row.enabled,
    limitPerPlatform: row.limit_per_platform,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error
  };
}

export async function createWatch(
  db: Db,
  workspaceId: string,
  input: BrandWatchInput,
  now: Date
): Promise<BrandWatch> {
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO brand_watches
         (id, workspace_id, name, keywords, platforms, cadence, enabled, limit_per_platform,
          next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       RETURNING ${WATCH_COLUMNS}`
    )
    .get<WatchRow>(
      id('bw'),
      workspaceId,
      input.name,
      input.keywords,
      input.platforms,
      input.cadence,
      input.enabled ?? true,
      input.limitPerPlatform ?? 25,
      timestamp,
      timestamp,
      timestamp
    );
  if (!row) throw new Error('Could not create the watch.');
  return serialize(row);
}

export async function listWatches(db: Db, workspaceId: string): Promise<BrandWatch[]> {
  const rows = await db
    .prepare(`SELECT ${WATCH_COLUMNS} FROM brand_watches WHERE workspace_id=? ORDER BY name`)
    .all<WatchRow>(workspaceId);
  return rows.map(serialize);
}

export async function getWatch(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<BrandWatch | null> {
  const row = await db
    .prepare(`SELECT ${WATCH_COLUMNS} FROM brand_watches WHERE workspace_id=? AND id=?`)
    .get<WatchRow>(workspaceId, watchId);
  return row ? serialize(row) : null;
}

/**
 * Patch the supplied fields only.
 *
 * COALESCE on a NULL parameter rather than a built statement: every column
 * keeps its current value unless the caller named it, and there is one
 * statement to read instead of a string assembled from the patch keys.
 */
export async function updateWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  patch: Partial<BrandWatchInput>,
  now: Date
): Promise<BrandWatch | null> {
  const row = await db
    .prepare(
      `UPDATE brand_watches SET
         name = COALESCE(?, name),
         keywords = COALESCE(?, keywords),
         platforms = COALESCE(?, platforms),
         cadence = COALESCE(?, cadence),
         enabled = COALESCE(?, enabled),
         limit_per_platform = COALESCE(?, limit_per_platform),
         updated_at = ?
       WHERE workspace_id=? AND id=?
       RETURNING ${WATCH_COLUMNS}`
    )
    .get<WatchRow>(
      patch.name ?? null,
      patch.keywords ?? null,
      patch.platforms ?? null,
      patch.cadence ?? null,
      patch.enabled ?? null,
      patch.limitPerPlatform ?? null,
      now.toISOString(),
      workspaceId,
      watchId
    );
  return row ? serialize(row) : null;
}

export async function deleteWatch(db: Db, workspaceId: string, watchId: string): Promise<boolean> {
  const row = await db
    .prepare('DELETE FROM brand_watches WHERE workspace_id=? AND id=? RETURNING id')
    .get<{ id: string }>(workspaceId, watchId);
  return row !== undefined;
}

export interface WatchMention {
  id: string;
  watchId: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  matchedKeywords: string[];
  sentimentLabel: 'positive' | 'neutral' | 'negative';
  sentimentScore: number;
  sentimentSpan: string;
  metadata: Record<string, unknown>;
  mentionCreatedAt: string | null;
  firstSeenAt: string;
  promotedRunId: string | null;
}

export interface WatchMentionInput {
  thread: OutreachThread;
  matchedKeywords: string[];
  sentiment: Sentiment;
}

export interface TrendPoint {
  day: string;
  positive: number;
  neutral: number;
  negative: number;
  average: number;
}

interface MentionRow {
  id: string;
  watch_id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  matched_keywords: string[];
  sentiment_label: string;
  sentiment_score: string;
  sentiment_span: string;
  metadata_json: unknown;
  mention_created_at: string | null;
  first_seen_at: string;
  promoted_run_id: string | null;
}

const MENTION_COLUMNS = `
  id, watch_id, platform, external_id, url, title, content, author, community,
  score, num_comments, matched_keywords, sentiment_label, sentiment_score,
  sentiment_span, metadata_json,
  TO_CHAR(mention_created_at AT TIME ZONE 'UTC', ${ISO}) AS mention_created_at,
  TO_CHAR(first_seen_at AT TIME ZONE 'UTC', ${ISO}) AS first_seen_at,
  promoted_run_id
`;

function serializeMention(row: MentionRow): WatchMention {
  return {
    id: row.id,
    watchId: row.watch_id,
    platform: row.platform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    content: row.content,
    author: row.author,
    community: row.community,
    score: row.score,
    numComments: row.num_comments,
    matchedKeywords: row.matched_keywords ?? [],
    sentimentLabel:
      row.sentiment_label === 'positive'
        ? 'positive'
        : row.sentiment_label === 'negative'
          ? 'negative'
          : 'neutral',
    // pg returns numeric as a string; every consumer wants a number.
    sentimentScore: Number(row.sentiment_score),
    sentimentSpan: row.sentiment_span,
    metadata:
      (typeof row.metadata_json === 'string'
        ? JSON.parse(row.metadata_json)
        : (row.metadata_json as Record<string, unknown>)) ?? {},
    mentionCreatedAt: row.mention_created_at,
    firstSeenAt: row.first_seen_at,
    promotedRunId: row.promoted_run_id
  };
}

function mentionContentHash(thread: Pick<OutreachThread, 'title' | 'content'>): string {
  return createHash('sha256').update(`${thread.title}\n${thread.content}`).digest('hex');
}

/**
 * Upsert `inputs` against `watchId` and roll the new ones into the daily trend.
 *
 * The rollup is incremented ONLY on the insert arm. A watch re-polls the same
 * thread on every run, and counting an update would inflate the trend line the
 * founder makes decisions on -- by exactly the number of times we happened to
 * look.
 */
export async function recordWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  inputs: readonly WatchMentionInput[],
  now: Date
): Promise<{ inserted: number; updated: number }> {
  const timestamp = now.toISOString();
  let inserted = 0;
  let updated = 0;

  for (const input of inputs) {
    const { thread, sentiment } = input;
    const row = await db
      .prepare(
        `INSERT INTO brand_watch_mentions (
           id, workspace_id, watch_id, platform, external_id, url, title, content, author,
           community, score, num_comments, matched_keywords, sentiment_label, sentiment_score,
           sentiment_span, sentiment_version, content_hash, metadata_json, mention_created_at,
           first_seen_at, last_seen_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (watch_id, platform, external_id) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           content = excluded.content,
           score = excluded.score,
           num_comments = excluded.num_comments,
           matched_keywords = excluded.matched_keywords,
           sentiment_label = excluded.sentiment_label,
           sentiment_score = excluded.sentiment_score,
           sentiment_span = excluded.sentiment_span,
           sentiment_version = excluded.sentiment_version,
           content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json,
           last_seen_at = excluded.last_seen_at
         RETURNING id, (xmax = 0) AS is_new,
           TO_CHAR(COALESCE(mention_created_at, first_seen_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket`
      )
      .get<{ id: string; is_new: boolean; bucket: string }>(
        id('bwm'),
        workspaceId,
        watchId,
        thread.platform,
        thread.externalId,
        thread.url,
        thread.title,
        thread.content,
        thread.author,
        thread.community,
        Math.trunc(thread.score),
        Math.trunc(thread.numComments),
        input.matchedKeywords,
        sentiment.label,
        sentiment.score,
        sentiment.span,
        SENTIMENT_VERSION,
        mentionContentHash(thread),
        JSON.stringify(thread.metadata ?? {}),
        thread.createdAt,
        timestamp,
        timestamp
      );

    if (!row) continue;
    if (!row.is_new) {
      updated += 1;
      continue;
    }
    inserted += 1;

    await db
      .prepare(
        `INSERT INTO brand_watch_sentiment_daily
           (workspace_id, watch_id, day, positive, neutral, negative, score_sum, updated_at)
         VALUES (?,?,?::date,?,?,?,?,?)
         ON CONFLICT (workspace_id, watch_id, day) DO UPDATE SET
           positive = brand_watch_sentiment_daily.positive + excluded.positive,
           neutral = brand_watch_sentiment_daily.neutral + excluded.neutral,
           negative = brand_watch_sentiment_daily.negative + excluded.negative,
           score_sum = brand_watch_sentiment_daily.score_sum + excluded.score_sum,
           updated_at = excluded.updated_at`
      )
      .run(
        workspaceId,
        watchId,
        row.bucket,
        sentiment.label === 'positive' ? 1 : 0,
        sentiment.label === 'neutral' ? 1 : 0,
        sentiment.label === 'negative' ? 1 : 0,
        sentiment.score,
        timestamp
      );
  }

  return { inserted, updated };
}

export async function listWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  filters: { sentiment?: string; platform?: string; limit?: number } = {}
): Promise<WatchMention[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db
    .prepare(
      `SELECT ${MENTION_COLUMNS} FROM brand_watch_mentions
       WHERE workspace_id=? AND watch_id=?
         AND (?::text IS NULL OR sentiment_label = ?)
         AND (?::text IS NULL OR platform = ?)
       ORDER BY first_seen_at DESC
       LIMIT ?`
    )
    .all<MentionRow>(
      workspaceId,
      watchId,
      filters.sentiment ?? null,
      filters.sentiment ?? null,
      filters.platform ?? null,
      filters.platform ?? null,
      limit
    );
  return rows.map(serializeMention);
}

export async function getWatchMention(
  db: Db,
  workspaceId: string,
  mentionId: string
): Promise<WatchMention | null> {
  const row = await db
    .prepare(`SELECT ${MENTION_COLUMNS} FROM brand_watch_mentions WHERE workspace_id=? AND id=?`)
    .get<MentionRow>(workspaceId, mentionId);
  return row ? serializeMention(row) : null;
}

export async function markMentionPromoted(
  db: Db,
  workspaceId: string,
  mentionId: string,
  runId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE brand_watch_mentions SET promoted_run_id=?, promoted_at=? WHERE workspace_id=? AND id=?'
    )
    .run(runId, now.toISOString(), workspaceId, mentionId);
}

/**
 * The trend line, zero-filled across the whole window.
 *
 * generate_series rather than a GROUP BY over the rollup: a day with no
 * mentions must render as an empty bar, not as a gap that silently shortens
 * the strip.
 */
export async function sentimentTrend(
  db: Db,
  workspaceId: string,
  watchId: string,
  days: number,
  now: Date
): Promise<TrendPoint[]> {
  const window = Math.min(Math.max(Math.trunc(days), 1), 180);
  const rows = await db
    .prepare(
      `SELECT TO_CHAR(series.day, 'YYYY-MM-DD') AS day,
              COALESCE(rollup.positive, 0) AS positive,
              COALESCE(rollup.neutral, 0) AS neutral,
              COALESCE(rollup.negative, 0) AS negative,
              COALESCE(rollup.score_sum, 0) AS score_sum
       FROM generate_series(
              (?::timestamptz AT TIME ZONE 'UTC')::date - (? - 1),
              (?::timestamptz AT TIME ZONE 'UTC')::date,
              INTERVAL '1 day'
            ) AS series(day)
       LEFT JOIN brand_watch_sentiment_daily AS rollup
         ON rollup.day = series.day AND rollup.workspace_id = ? AND rollup.watch_id = ?
       ORDER BY series.day`
    )
    .all<{
      day: string;
      positive: number;
      neutral: number;
      negative: number;
      score_sum: string;
    }>(now.toISOString(), window, now.toISOString(), workspaceId, watchId);

  return rows.map((row) => {
    const total = row.positive + row.neutral + row.negative;
    return {
      day: row.day,
      positive: row.positive,
      neutral: row.neutral,
      negative: row.negative,
      average: total === 0 ? 0 : Number((Number(row.score_sum) / total).toFixed(3))
    };
  });
}
