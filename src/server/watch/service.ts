import type { Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { watchMentions, type WatchPlatformReport } from './skill.js';

/**
 * Cadence and leasing for brand watches.
 *
 * Copies `runDueResearchSources`: a LIMIT-3 sweep, a lease claimed by UPDATE
 * ... RETURNING so a second worker on the same row simply gets nothing, and a
 * cadence that advances on failure as well as success. That last part is
 * deliberate -- a permanently broken watch that kept its due time would be
 * re-picked on every tick and starve the other two slots.
 */

const LEASE = "INTERVAL '10 minutes'";

export interface BrandWatchRunResult {
  watchId: string;
  /** False when another worker holds the lease. */
  ran: boolean;
  inserted: number;
  updated: number;
  reports: WatchPlatformReport[];
  warnings: string[];
}

export interface RunBrandWatchOptions {
  now?: Date;
  /** Ignore next_run_at. Still takes the lease. */
  force?: boolean;
  fetchImpl?: FetchLike;
  credentials?: CredentialAccessor;
}

export async function runBrandWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  options: RunBrandWatchOptions = {}
): Promise<BrandWatchRunResult> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();

  const claimed = await db
    .prepare(
      `UPDATE brand_watches
         SET lease_until = ?::timestamptz + ${LEASE}
       WHERE id=? AND workspace_id=? AND enabled
         AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
         AND (${options.force ? 'TRUE' : 'next_run_at <= ?::timestamptz'})
       RETURNING id, cadence`
    )
    .get<{ id: string; cadence: string }>(
      ...(options.force
        ? [timestamp, watchId, workspaceId, timestamp]
        : [timestamp, watchId, workspaceId, timestamp, timestamp])
    );

  if (!claimed) {
    return { watchId, ran: false, inserted: 0, updated: 0, reports: [], warnings: [] };
  }

  const interval = claimed.cadence === 'weekly' ? "INTERVAL '7 days'" : "INTERVAL '1 day'";
  let inserted = 0;
  let updated = 0;
  let reports: WatchPlatformReport[] = [];
  let warnings: string[] = [];
  let failure: string | null = null;

  try {
    // The skill already records what it finds; this call re-records nothing.
    const result = await watchMentions(
      { watchId },
      { db, workspaceId, now: () => now },
      {
        credentials: options.credentials,
        fetchImpl: options.fetchImpl
      }
    );
    reports = result.reports;
    warnings = result.warnings;
    // recordWatchMentions is idempotent on (watch_id, platform, external_id),
    // so counting here would double-write. Derive the counts from the reports.
    inserted = result.mentions.length;
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
    warnings.push(failure);
  }

  await db
    .prepare(
      `UPDATE brand_watches SET
         lease_until = NULL,
         last_run_at = ?::timestamptz,
         last_error = ?,
         next_run_at = ?::timestamptz + ${interval},
         updated_at = ?::timestamptz
       WHERE id=? AND workspace_id=?`
    )
    .run(timestamp, failure, timestamp, timestamp, watchId, workspaceId);

  return { watchId, ran: true, inserted, updated, reports, warnings };
}

export async function runDueBrandWatches(db: Db): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT workspace_id, id FROM brand_watches
       WHERE enabled AND next_run_at <= now()
         AND (lease_until IS NULL OR lease_until <= now())
       ORDER BY next_run_at
       LIMIT 3`
    )
    .all<{ workspace_id: string; id: string }>();

  let done = 0;
  for (const row of rows) {
    try {
      await runBrandWatch(db, row.workspace_id, row.id);
      done += 1;
    } catch (error) {
      console.error('Brand watch run failed', row, error);
    }
  }
  return done;
}
