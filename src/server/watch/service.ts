import type { Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { watchMentions, type WatchPlatformReport } from './skill.js';
import type { WatchRunWarning } from './store.js';

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

/**
 * Flatten each report's per-platform warnings -- already populated even when
 * every request degraded rather than threw, see `outreach/scouts/http.ts` --
 * plus any top-level warning `watchMentions` pushed that is not tied to a
 * report, plus a whole-run failure message, if any, into one persistable
 * list.
 *
 * The top-level pass matters on its own: `watchMentions` pushes the
 * persistence failure from `recordWatchMentions` ("Watch mentions could not
 * be recorded: ...") onto `result.warnings` alone -- it has no platform to
 * attach a report to, since every platform's own search already succeeded.
 * Reading only `report.warnings` misses exactly that message, which is the
 * one path that loses real data: mentions were found and then never
 * persisted, `failure` stays null, and every report still says `ready`.
 */
function collectRunWarnings(
  reports: readonly WatchPlatformReport[],
  topLevelWarnings: readonly string[],
  failure: string | null
): WatchRunWarning[] {
  const collected: WatchRunWarning[] = [];
  const attributed = new Set<string>();
  for (const report of reports) {
    for (const message of report.warnings) {
      collected.push({ platform: report.platform, reason: message });
      attributed.add(message);
    }
  }
  // Every report-tied warning is pushed onto `topLevelWarnings` verbatim by
  // `watchMentions` (same string, both places) -- skip those so they are not
  // duplicated under `platform: null`.
  for (const message of topLevelWarnings) {
    if (attributed.has(message)) continue;
    collected.push({ platform: null, reason: message });
  }
  if (failure) collected.push({ platform: null, reason: failure });
  return collected;
}

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

  // The realistic failure mode never reaches the catch above that sets
  // `failure`/`last_error`: outreach/scouts/http.ts's `getJson` degrades every
  // non-200, timeout, transport error and unparseable body to a warning and
  // returns null, so a run where GitHub 403s, HN times out and Stack Overflow
  // throttles ends with `failure === null` and every platform still `ready`.
  // Persisting the per-platform warnings here is what gives the worker's own
  // cadence sweep -- which runs with no session watching -- something to show
  // instead of being indistinguishable from a run that found nothing.
  const runWarnings = collectRunWarnings(reports, warnings, failure);

  await db
    .prepare(
      `UPDATE brand_watches SET
         lease_until = NULL,
         last_run_at = ?::timestamptz,
         last_error = ?,
         last_run_warnings = ?::jsonb,
         next_run_at = ?::timestamptz + ${interval},
         updated_at = ?::timestamptz
       WHERE id=? AND workspace_id=?`
    )
    .run(
      timestamp,
      failure,
      JSON.stringify(runWarnings),
      timestamp,
      timestamp,
      watchId,
      workspaceId
    );

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
