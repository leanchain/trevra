/**
 * Asking an agent run to stop, and saying why.
 *
 * `stopRunningAgentRuns` in runs.ts records the REQUEST and nothing else --
 * migration 021 explains at length why the request and the outcome are two
 * different facts, and that argument is unchanged. What it could not record
 * was the reason, because there was no column for one.
 *
 * There is now (migration 036), and the reason is written by the SAME statement
 * that sets `stop_requested_at`. Two statements would leave a window in which a
 * run is marked stopping with no note, and the note is the entire point:
 * src/client/LinkedInScreen.tsx has demanded one from the LinkedIn seat kill
 * switch since it shipped -- "Say why. This is the note you will read three
 * weeks from now." -- and the agent stop is the same act on the other half of
 * the product.
 *
 * The reason is OPTIONAL here and mandatory in neither layer below. An operator
 * reaching for a kill switch at 2am is not owed a form validation, and a
 * placeholder auto-filled on their behalf would be indistinguishable from a
 * real note later. No reason is recorded as NULL, which reads as "nobody said".
 */

import type { Db } from '../db.js';

/**
 * Long enough for a sentence about what went wrong, short enough that the
 * column stays a note rather than a log dump. Matched to the LinkedIn pause
 * reason, which is the same field on the other actor.
 */
export const AGENT_STOP_REASON_MAX_CHARS = 500;

export interface AgentRunStopRequest {
  runId: string;
  /** ISO-8601 UTC. When the stop was asked for -- never when it took effect. */
  stopRequestedAt: string;
  /** What the operator said, or null when they said nothing. Never a placeholder. */
  stopReason: string | null;
}

const ISO = (column: string): string =>
  `TO_CHAR(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface StopRow {
  id: string;
  stop_requested_at: string;
  stop_reason: string | null;
}

/**
 * Ask this workspace's running agent runs to stop, recording the reason given.
 *
 * Scoped to one run when `runId` is supplied and to every running run when it
 * is not -- the second is what the existing route did and what the workspace
 * -wide "stop everything" needs, the first is what a StopBar naming one live
 * actor needs. Both are one statement, so a stop cannot half-apply.
 *
 * A run that has ALREADY been asked is left completely alone, reason included.
 * The `stop_requested_at IS NULL` guard is what makes this idempotent, and
 * overwriting an earlier note with a later click would destroy the first
 * account of the incident -- the one written while it was still happening.
 *
 * Returns the runs it actually asked. An empty array is not a failure: it means
 * nothing was running, or everything running had already been asked.
 */
export async function requestAgentRunStop(
  db: Db,
  workspaceId: string,
  options: { runId?: string | null; reason?: string | null } = {}
): Promise<AgentRunStopRequest[]> {
  const reason = normalizeReason(options.reason);
  const runId = options.runId ?? null;

  const rows = await db.prepare(`
    UPDATE agent_runs SET stop_requested_at=CURRENT_TIMESTAMP, stop_reason=?
    WHERE workspace_id=? AND status='running' AND stop_requested_at IS NULL
      AND (?::text IS NULL OR id=?::text)
    RETURNING id, ${ISO('stop_requested_at')} AS stop_requested_at, stop_reason
  `).all<StopRow>(reason, workspaceId, runId, runId);

  return rows.map((row) => ({
    runId: row.id,
    stopRequestedAt: row.stop_requested_at,
    stopReason: row.stop_reason ?? null
  }));
}

/**
 * The note as it will be stored, or null.
 *
 * Whitespace-only input is null rather than an empty string: a blank note is
 * something an operator did not write, and storing `''` would make the column
 * claim otherwise. Truncation is silent and deliberate -- a stop must never
 * fail validation on the length of its explanation.
 */
function normalizeReason(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, AGENT_STOP_REASON_MAX_CHARS);
}
