import { id, type Db } from '../db.js';

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
