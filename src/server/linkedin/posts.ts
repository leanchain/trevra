import { id, type Db } from '../db.js';
import type { PostBlock } from '../../shared/linkedin-post-format.js';
import { OWNER_SEAT_KEY } from './seats.js';

export class LinkedInPostsApiError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'LinkedInPostsApiError';
  }
}

export type LinkedInPostStatus =
  'draft' | 'scheduled' | 'publishing' | 'posted' | 'failed' | 'missed' | 'canceled';

export interface LinkedInPost {
  id: string;
  workspaceId: string;
  seatKey: string;
  status: LinkedInPostStatus;
  blocks: PostBlock[];
  scheduledAt: string | null;
  publishedAt: string | null;
  postedUrl: string | null;
  error: { kind: string; detail: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PostRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  status: LinkedInPostStatus;
  blocks_json: unknown;
  scheduled_at: string | null;
  published_at: string | null;
  posted_url: string | null;
  error_json: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// TIMESTAMPTZ columns are formatted here rather than left to the driver's raw
// text output ('2026-08-20 09:00:00+00', not JS-comparable) -- the same
// TO_CHAR(... AT TIME ZONE 'UTC', ...) idiom every other store module in this
// codebase uses for the same reason (see seats.ts's SEAT_COLUMNS, runner.ts's
// UTC_ISO, outreach/store.ts, etc).
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const POST_COLUMNS = `
  id, workspace_id, seat_key, status, blocks_json,
  TO_CHAR(scheduled_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS scheduled_at,
  TO_CHAR(published_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS published_at,
  posted_url, error_json, created_by,
  TO_CHAR(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
  TO_CHAR(updated_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS updated_at
`;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toPost(row: PostRow): LinkedInPost {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    status: row.status,
    blocks: (parseJson(row.blocks_json) as PostBlock[]) ?? [],
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    postedUrl: row.posted_url,
    error: (parseJson(row.error_json) as { kind: string; detail: string } | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const EDITABLE_STATUSES: readonly LinkedInPostStatus[] = ['draft', 'scheduled'];

export interface PostInsert {
  id: string;
  workspaceId: string;
  seatKey?: string;
  blocks: PostBlock[];
  status?: 'draft' | 'scheduled';
  scheduledAt?: string | null;
  createdBy?: string | null;
}

export async function createPost(db: Db, input: PostInsert, now: Date): Promise<LinkedInPost> {
  const status = input.status ?? 'draft';
  if (status === 'scheduled' && !input.scheduledAt) {
    throw new LinkedInPostsApiError('scheduledAt is required to schedule a post.');
  }
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `
    INSERT INTO linkedin_posts (
      id, workspace_id, seat_key, status, blocks_json, scheduled_at, created_by, created_at, updated_at
    ) VALUES (?,?,?,?,?::jsonb,?,?,?,?)
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(
      input.id,
      input.workspaceId,
      input.seatKey ?? OWNER_SEAT_KEY,
      status,
      JSON.stringify(input.blocks),
      input.scheduledAt ?? null,
      input.createdBy ?? null,
      timestamp,
      timestamp
    );
  return toPost(row!);
}

export async function listPosts(
  db: Db,
  workspaceId: string,
  filters: { seatKey?: string; status?: LinkedInPostStatus; limit?: number }
): Promise<LinkedInPost[]> {
  const conditions = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) {
    conditions.push('seat_key = ?');
    params.push(filters.seatKey);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  params.push(filters.limit ?? 100);
  const rows = await db
    .prepare(
      `
    SELECT ${POST_COLUMNS} FROM linkedin_posts
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(scheduled_at, created_at) DESC
    LIMIT ?
  `
    )
    .all<PostRow>(...params);
  return rows.map(toPost);
}

export async function getPost(
  db: Db,
  workspaceId: string,
  id: string
): Promise<LinkedInPost | undefined> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM linkedin_posts WHERE workspace_id = ? AND id = ?`)
    .get<PostRow>(workspaceId, id);
  return row ? toPost(row) : undefined;
}

function assertEditable(post: LinkedInPost): void {
  if (!EDITABLE_STATUSES.includes(post.status)) {
    throw new LinkedInPostsApiError(
      `This post is '${post.status}' and can no longer be edited or canceled.`,
      409
    );
  }
}

export async function updatePost(
  db: Db,
  workspaceId: string,
  postId: string,
  patch: { blocks?: PostBlock[]; status?: 'draft' | 'scheduled'; scheduledAt?: string | null },
  now: Date
): Promise<LinkedInPost> {
  const existing = await getPost(db, workspaceId, postId);
  if (!existing) throw new LinkedInPostsApiError('No such post.', 404);
  assertEditable(existing);
  const nextStatus = patch.status ?? existing.status;
  const nextScheduledAt =
    patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduledAt;
  if (nextStatus === 'scheduled' && !nextScheduledAt) {
    throw new LinkedInPostsApiError('scheduledAt is required to schedule a post.');
  }
  const row = await db
    .prepare(
      `
    UPDATE linkedin_posts
    SET blocks_json = COALESCE(?::jsonb, blocks_json),
        status = ?,
        scheduled_at = ?,
        updated_at = ?
    WHERE workspace_id = ? AND id = ?
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(
      patch.blocks ? JSON.stringify(patch.blocks) : null,
      nextStatus,
      nextScheduledAt,
      now.toISOString(),
      workspaceId,
      postId
    );
  return toPost(row!);
}

export async function cancelPost(
  db: Db,
  workspaceId: string,
  postId: string,
  now: Date
): Promise<LinkedInPost> {
  const existing = await getPost(db, workspaceId, postId);
  if (!existing) throw new LinkedInPostsApiError('No such post.', 404);
  assertEditable(existing);
  const row = await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'canceled', updated_at = ?
    WHERE workspace_id = ? AND id = ?
    RETURNING ${POST_COLUMNS}
  `
    )
    .get<PostRow>(now.toISOString(), workspaceId, postId);
  return toPost(row!);
}

/**
 * Atomically claim ONE due post and move it to 'publishing', so two worker
 * replicas ticking at once can never both pick the same row -- `FOR UPDATE
 * SKIP LOCKED` inside the subquery is Postgres's standard "claim one queued
 * row, race-free, no shared lease table needed" idiom.
 */
export async function claimNextDuePost(
  db: Db,
  workspaceId: string,
  now: Date
): Promise<LinkedInPost | undefined> {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `
      UPDATE linkedin_posts
      SET status = 'publishing', updated_at = ?
      WHERE id = (
        SELECT id FROM linkedin_posts
        WHERE workspace_id = ? AND status = 'scheduled' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING ${POST_COLUMNS}
    `
      )
      .get<PostRow>(now.toISOString(), workspaceId, now.toISOString());
    return row ? toPost(row) : undefined;
  });
}

/** The companion was offline, or the wrong account was signed in -- not the post's fault. Retry next tick. */
export async function releasePostToScheduled(db: Db, postId: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE linkedin_posts SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'publishing'`
    )
    .run(now.toISOString(), postId);
}

export async function markPostPublished(
  db: Db,
  postId: string,
  patch: { postedUrl: string | null },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'posted', published_at = ?, posted_url = ?, updated_at = ? WHERE id = ?
  `
    )
    .run(now.toISOString(), patch.postedUrl, now.toISOString(), postId);
}

export async function markPostFailed(
  db: Db,
  postId: string,
  error: { kind: string; detail: string },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_posts SET status = 'failed', error_json = ?::jsonb, updated_at = ? WHERE id = ?
  `
    )
    .run(JSON.stringify(error), now.toISOString(), postId);
}

export async function markPostMissed(db: Db, postId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE linkedin_posts SET status = 'missed', updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), postId);
}
