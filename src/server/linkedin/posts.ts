import type { PostBlock } from '../../shared/linkedin-post-format.js';
import { id, type Db } from '../db.js';
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

export const LINKEDIN_POST_IMAGE_MAX_COUNT = 9;
export const LINKEDIN_POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LINKEDIN_POST_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
] as const;
export type LinkedInPostImageMime = (typeof LINKEDIN_POST_IMAGE_TYPES)[number];

export interface LinkedInPostImage {
  id: string;
  name: string;
  mimeType: LinkedInPostImageMime;
  size: number;
}

export interface LinkedInPostImagePayload extends LinkedInPostImage {
  buffer: Buffer;
}

export interface LinkedInPost {
  id: string;
  workspaceId: string;
  seatKey: string;
  status: LinkedInPostStatus;
  blocks: PostBlock[];
  media: LinkedInPostImage[];
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
  media_json: unknown;
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
  id, workspace_id, seat_key, status, blocks_json, media_json,
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
    media: (parseJson(row.media_json) as LinkedInPostImage[]) ?? [],
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    postedUrl: row.posted_url,
    error: (parseJson(row.error_json) as { kind: string; detail: string } | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
/**
 * 'failed' and 'missed' are editable ON PURPOSE. The spec's own words for a
 * missed post are "the user reschedules or discards from the UI", and with
 * only draft/scheduled here neither is reachable: a post that failed once (a
 * drifted selector, a worker restart) is a permanent dead end nothing can
 * move. Re-editing one clears its stored error -- see updatePost.
 */
const EDITABLE_STATUSES: readonly LinkedInPostStatus[] = ['draft', 'scheduled', 'failed', 'missed'];

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
        error_json = NULL,
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

function isPostImageMime(value: string): value is LinkedInPostImageMime {
  return (LINKEDIN_POST_IMAGE_TYPES as readonly string[]).includes(value);
}

interface PostMediaRow {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  bytes?: Buffer | Uint8Array;
}

function postImageOf(row: PostMediaRow): LinkedInPostImage {
  return {
    id: row.id,
    name: row.filename,
    mimeType: row.mime_type as LinkedInPostImageMime,
    size: Number(row.byte_size)
  };
}

async function refreshPostMediaMetadata(
  db: Db,
  workspaceId: string,
  postId: string,
  now: Date
): Promise<LinkedInPost> {
  const rows = await db
    .prepare(
      `SELECT id, filename, mime_type, byte_size
       FROM linkedin_post_media
       WHERE workspace_id = ? AND post_id = ?
       ORDER BY position ASC`
    )
    .all<PostMediaRow>(workspaceId, postId);
  await db
    .prepare(
      `UPDATE linkedin_posts
       SET media_json = ?::jsonb, updated_at = ?
       WHERE workspace_id = ? AND id = ?`
    )
    .run(JSON.stringify(rows.map(postImageOf)), now.toISOString(), workspaceId, postId);
  const post = await getPost(db, workspaceId, postId);
  if (!post) throw new LinkedInPostsApiError('No such post.', 404);
  return post;
}

export async function addPostImage(
  db: Db,
  workspaceId: string,
  postId: string,
  input: { name: string; mimeType: string; bytes: Buffer },
  now: Date
): Promise<LinkedInPost> {
  if (!isPostImageMime(input.mimeType)) {
    throw new LinkedInPostsApiError('Posts accept JPEG, PNG, WebP or GIF images only.', 415);
  }
  if (input.bytes.byteLength === 0) {
    throw new LinkedInPostsApiError('That image is empty.');
  }
  if (input.bytes.byteLength > LINKEDIN_POST_IMAGE_MAX_BYTES) {
    throw new LinkedInPostsApiError('Each post image must be 10 MB or smaller.', 413);
  }
  const name = input.name.trim().slice(0, 255) || 'image';

  return db.transaction(async (tx) => {
    // Serialize media changes for one post. Without the parent-row lock, two
    // simultaneous uploads could both read count=8, both choose position 8,
    // and turn a harmless double-click into a unique-key failure (or a cap
    // bypass if the position rule ever changed).
    const locked = await tx
      .prepare(`SELECT id FROM linkedin_posts WHERE workspace_id = ? AND id = ? FOR UPDATE`)
      .get<{ id: string }>(workspaceId, postId);
    if (!locked) throw new LinkedInPostsApiError('No such post.', 404);
    const post = await getPost(tx, workspaceId, postId);
    if (!post) throw new LinkedInPostsApiError('No such post.', 404);
    assertEditable(post);

    const count = await tx
      .prepare(
        `SELECT COUNT(*)::int AS count
         FROM linkedin_post_media
         WHERE workspace_id = ? AND post_id = ?`
      )
      .get<{ count: number }>(workspaceId, postId);
    const position = Number(count?.count ?? 0);
    if (position >= LINKEDIN_POST_IMAGE_MAX_COUNT) {
      throw new LinkedInPostsApiError(
        `A LinkedIn post can have at most ${LINKEDIN_POST_IMAGE_MAX_COUNT} images.`
      );
    }
    await tx
      .prepare(
        `INSERT INTO linkedin_post_media
          (id, workspace_id, post_id, position, filename, mime_type, bytes, byte_size, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('lipostimg'),
        workspaceId,
        postId,
        position,
        name,
        input.mimeType,
        input.bytes,
        input.bytes.byteLength,
        now.toISOString()
      );
    return refreshPostMediaMetadata(tx, workspaceId, postId, now);
  });
}

export async function loadPostImages(
  db: Db,
  workspaceId: string,
  postId: string
): Promise<LinkedInPostImagePayload[]> {
  const rows = await db
    .prepare(
      `SELECT id, filename, mime_type, byte_size, bytes
       FROM linkedin_post_media
       WHERE workspace_id = ? AND post_id = ?
       ORDER BY position ASC`
    )
    .all<PostMediaRow>(workspaceId, postId);
  return rows.map((row) => ({
    ...postImageOf(row),
    buffer: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes ?? [])
  }));
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
 *
 * `excludeSeatKeys` is how ONE tick keeps a broken seat from starving every
 * OTHER seat's due posts in the same workspace. Without it, a seat whose
 * companion session cannot open would have its due post re-claimed first on
 * every loop iteration (it is always the earliest `scheduled_at` again the
 * moment it is released) and nothing from a different, perfectly healthy seat
 * in the same workspace would ever be reached. `seat_key <> ALL(?)` with an
 * empty array is vacuously true for every row in Postgres -- "exclude
 * nothing" -- so the common single-seat case pays zero extra cost.
 */
export async function claimNextDuePost(
  db: Db,
  workspaceId: string,
  now: Date,
  excludeSeatKeys: readonly string[] = []
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
          AND seat_key <> ALL(?)
        ORDER BY scheduled_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING ${POST_COLUMNS}
    `
      )
      .get<PostRow>(now.toISOString(), workspaceId, now.toISOString(), [...excludeSeatKeys]);
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

/**
 * A post stuck in 'publishing' longer than this was claimed by a worker that
 * never reported back -- a crash, a deploy, an OOM kill between the claim and
 * the outcome. Left alone, `assertEditable` (draft/scheduled/failed/missed
 * only) and `claimNextDuePost` (scheduled only) both permanently ignore it:
 * nothing, automated or user-driven, can ever move it again. Swept into
 * 'failed' (not silently retried -- a duplicate post is worse than a missed
 * one) so the queue UI's existing failed-post affordance is what reaches it.
 */
export async function sweepStalePublishing(
  db: Db,
  workspaceId: string,
  now: Date,
  staleAfterMs = 15 * 60_000
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const result = await db
    .prepare(
      `
    UPDATE linkedin_posts
    SET status = 'failed',
        error_json = '{"kind":"unknown","detail":"worker restarted mid-publish -- check LinkedIn before rescheduling"}'::jsonb,
        updated_at = ?
    WHERE workspace_id = ? AND status = 'publishing' AND updated_at <= ?
  `
    )
    .run(now.toISOString(), workspaceId, cutoff);
  return result.changes;
}
