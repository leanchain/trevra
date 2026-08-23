/**
 * WHAT THE BROWSER DID, as opposed to what it sent.
 *
 * THE GAP THIS FILLS IS THE REASON THE 2026-08-14 INVESTIGATION WAS HARD.
 * Trevra recorded actions -- an invite, a DM, a view -- and nothing else. Not a
 * navigation, not a sign-in, not a checkpoint, not a limit wall. So when
 * LinkedIn restricted the account, Trevra's own data could not answer "what did
 * we actually do, and when": the timeline had to be rebuilt out of Chrome's
 * history database and cookie creation timestamps, neither of which is a thing
 * a product should depend on. A restriction builds over days; this is what lets
 * somebody see it building.
 *
 * NOT `audit_events`. That is the workspace's append-only record of what PEOPLE
 * did, and burying it under one row per page load would destroy it.
 *
 * NOTHING HERE HOLDS PAGE CONTENT, A CREDENTIAL, OR ANOTHER MEMBER'S DATA. A
 * kind, a URL, and a sentence built from constants -- the same rule every
 * `LinkedInDriverResult.detail` follows.
 *
 * NOTHING HERE THROWS. Every caller is a worker on its way somewhere else, and
 * a ledger write that could abort a batch would be a worse bug than the missing
 * ledger it replaced.
 */

import { id, type Db } from '../db.js';
import { OWNER_SEAT_KEY } from './seats.js';

export type LinkedInSeatEventKind =
  | 'browser_open'
  | 'navigate'
  | 'login'
  | 'session_reused'
  | 'recovery_verified'
  | 'reconnect_required'
  | 'challenge'
  | 'limit_wall'
  | 'sitting_start'
  | 'sitting_end'
  | 'background_run';

export interface LinkedInBackgroundRunDetail {
  startedAt: string;
  finishedAt: string;
  tasks: string[];
  status: 'completed' | 'partial' | 'blocked';
  failedTasks: string[];
  reason: string | null;
}

/** Structured detail for one read-only background visit; contains no page data. */
export function encodeBackgroundRunDetail(detail: LinkedInBackgroundRunDetail): string {
  return JSON.stringify(detail);
}

export function parseBackgroundRunDetail(raw: string | null): LinkedInBackgroundRunDetail | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return null;
    if (!Array.isArray(value.tasks) || !value.tasks.every((task) => typeof task === 'string'))
      return null;
    if (
      !Array.isArray(value.failedTasks) ||
      !value.failedTasks.every((task) => typeof task === 'string')
    )
      return null;
    if (value.status !== 'completed' && value.status !== 'partial' && value.status !== 'blocked')
      return null;
    if (value.reason !== null && typeof value.reason !== 'string') return null;
    return {
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      tasks: value.tasks,
      status: value.status,
      failedTasks: value.failedTasks,
      reason: value.reason as string | null
    };
  } catch {
    return null;
  }
}

export interface LinkedInSeatEvent {
  id: string;
  workspaceId: string;
  seatKey: string;
  kind: LinkedInSeatEventKind | string;
  url: string | null;
  detail: string | null;
  occurredAt: string;
}

/** How much history is worth keeping. Long enough to see a flag build. */
export const SEAT_EVENT_RETENTION_DAYS = 45;

export async function recordSeatEvent(
  db: Db,
  input: {
    workspaceId: string;
    seatKey?: string;
    kind: LinkedInSeatEventKind | string;
    url?: string | null;
    detail?: string | null;
  },
  now: Date = new Date()
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO linkedin_seat_events (id,workspace_id,seat_key,kind,url,detail,occurred_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        id('lse'),
        input.workspaceId,
        input.seatKey ?? OWNER_SEAT_KEY,
        input.kind,
        input.url ?? null,
        input.detail ?? null,
        now.toISOString()
      );
  } catch {
    // A missing table on an un-migrated database, a closed pool at shutdown, a
    // write that lost a race with an erasure -- none of them is a reason to
    // interrupt what the worker was doing when it reported this.
  }
}

/** Most recent first. The one read this table exists for. */
export async function listSeatEvents(
  db: Db,
  workspaceId: string,
  options: { seatKey?: string; limit?: number } = {}
): Promise<LinkedInSeatEvent[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const rows = options.seatKey
    ? await db
        .prepare(
          'SELECT id,workspace_id,seat_key,kind,url,detail,occurred_at FROM linkedin_seat_events WHERE workspace_id=? AND seat_key=? ORDER BY occurred_at DESC LIMIT ?'
        )
        .all<Record<string, unknown>>(workspaceId, options.seatKey, limit)
    : await db
        .prepare(
          'SELECT id,workspace_id,seat_key,kind,url,detail,occurred_at FROM linkedin_seat_events WHERE workspace_id=? ORDER BY occurred_at DESC LIMIT ?'
        )
        .all<Record<string, unknown>>(workspaceId, limit);
  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    seatKey: String(row.seat_key),
    kind: String(row.kind),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    occurredAt: new Date(String(row.occurred_at)).toISOString()
  }));
}

/** Drop what is older than the retention window. Safe to call on every tick. */
export async function pruneSeatEvents(db: Db, now: Date = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - SEAT_EVENT_RETENTION_DAYS * 86_400_000);
    await db
      .prepare('DELETE FROM linkedin_seat_events WHERE occurred_at < ?')
      .run(cutoff.toISOString());
  } catch {
    // Same reasoning as `recordSeatEvent`: housekeeping never breaks a tick.
  }
}

/* ---------------------------------------------------------------------------
 * The break between sittings, which has to outlive the process that set it.
 * ------------------------------------------------------------------------ */

/**
 * When this seat may next open a browser.
 *
 * IT IS A COLUMN AND NOT A MAP because the in-process Map this replaced was
 * forgotten on every worker restart -- and a restart is most likely right after
 * something went wrong, which is the exact moment a seat should NOT come back
 * early. It is also the only version of this that works on a fleet: a second
 * worker reading the same seat sees the break too.
 */
export async function setSeatRestingUntil(
  db: Db,
  workspaceId: string,
  seatKey: string,
  until: Date | null
): Promise<void> {
  try {
    await db
      .prepare('UPDATE linkedin_seats SET resting_until=? WHERE workspace_id=? AND seat_key=?')
      .run(until ? until.toISOString() : null, workspaceId, seatKey);
  } catch {
    // An un-migrated database keeps the previous behaviour: the in-process
    // break still applies for as long as this process lives.
  }
}

/** Null when the seat may act now. Never throws; unreadable means "may act". */
export async function seatRestingUntil(
  db: Db,
  workspaceId: string,
  seatKey: string
): Promise<Date | null> {
  try {
    const row = await db
      .prepare('SELECT resting_until FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
      .get<{ resting_until: string | null }>(workspaceId, seatKey);
    if (!row?.resting_until) return null;
    const at = new Date(row.resting_until);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}
