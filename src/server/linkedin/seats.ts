import type { Db } from '../db.js';
import { WARMUP_WEEKS } from './limits.js';

/**
 * The LinkedIn seat: the human account everything else is paced against.
 *
 * One seat per workspace (plan 7.1, DECIDED), so every function here is keyed
 * by workspace_id alone. The ledger still carries a `seat_key` for the agency
 * case; this module supplies the only value it ever takes today.
 *
 * NOTHING SAFETY-CRITICAL READS A USER-DECLARED FIELD ANY MORE, and that is
 * the rule this module now enforces.
 *
 * The warm-up ramp used to key off `account_opened_on` -- a date typed into a
 * form, about a fact no LinkedIn API publishes (plan 1.1) and that Trevra
 * could never verify. It was a question competitors never ask (they ask for a
 * login and read the rest from the session) and, more importantly, THE WRONG
 * SIGNAL: the documented risk model (plan 1.3, "Slide and Spike") is about a
 * surge in AUTOMATED activity. That is a fact about this seat's use of Trevra,
 * and we own it -- it is `activated_at` plus the `linkedin_actions` ledger. An
 * account opened in 2011 whose automation started this morning is a week-1
 * risk whatever its birthday says.
 *
 * `account_opened_on` and `connections_count` survive as INFORMATIONAL
 * columns: still stored, still settable, still shown. Nothing derives a
 * ceiling, a band or a posture from either one.
 *
 * The fail-closed rule is unchanged, and it is still the point: an unknown
 * ramp clock is paced as week 1, never as an established seat -- the same rule
 * `outreach/safety.ts` applies to an undeclared account profile, for the same
 * reason. Unproven standing is not standing.
 */

export type SeatPosture = 'warmup' | 'steady' | 'paused' | 'cooldown';

/**
 * The only seat key in use. Written into `linkedin_actions.seat_key` so the
 * ledger already has the column the deferred multi-seat case needs.
 */
export const OWNER_SEAT_KEY = 'owner';

export interface LinkedInSeat {
  workspaceId: string;
  seatKey: string;
  label: string;
  profileUrl: string | null;
  /** 'YYYY-MM-DD', or null. INFORMATIONAL -- nothing paces off it. */
  accountOpenedOn: string | null;
  /** INFORMATIONAL. Read from the live session when the local worker can. */
  connectionsCount: number | null;
  /** IANA name, validated on write. */
  timezone: string;
  /**
   * ISO-8601. THE RAMP CLOCK: when this workspace first had a seat at all.
   *
   * Written on the FIRST write and never overwritten (see `upsertSeat`), so it
   * measures how long this seat has been automated -- which is the thing plan
   * 1.3 is actually about. Null only for a row this schema never wrote.
   */
  activatedAt: string | null;
  /** ISO-8601. When the local worker last read this seat from the live session. */
  detectedAt: string | null;
  /**
   * ISO-8601. The last time we CONFIRMED the stored browser session was live --
   * by landing on the signed-in profile, not by signing in.
   *
   * It exists so the session gets REUSED. Re-authenticating on every run is
   * slower and a far stronger ban signal than a stable session, so logging in
   * is the fallback and a working session is the normal case. Null means
   * UNKNOWN, never "signed out": a seat nobody has checked is not a seat we
   * know is out.
   */
  sessionValidAt: string | null;
  /** As STORED. `effectivePosture` is what pacing and the guard read. */
  posture: SeatPosture;
  pausedReason: string | null;
  /** JS weekday numbers, Sunday=0. An empty list disables automated activity. */
  workingDays: number[];
  /** Minutes after local midnight. */
  workStartMinute: number;
  workEndMinute: number;
  /** Operator ceilings. Trevra's researched safety bands may be lower. */
  dailyInviteLimit: number;
  dailyMessageLimit: number;
  dailyProfileViewLimit: number;
  dailyFollowLimit: number;
}

/**
 * A seat edit.
 *
 * `activatedAt` is deliberately absent. The ramp clock is not editable by
 * anyone, through any path: a clock an operator can reset is not a clock, and
 * the whole reason the ramp moved off `account_opened_on` was to stop it being
 * a claim.
 */
export interface SeatPatch {
  label?: string;
  profileUrl?: string | null;
  accountOpenedOn?: string | null;
  connectionsCount?: number | null;
  timezone?: string;
  posture?: SeatPosture;
  /** ISO-8601, written by the detect path. Absent means unchanged. */
  detectedAt?: string | null;
  /** ISO-8601, written whenever a live session is confirmed. Absent means unchanged. */
  sessionValidAt?: string | null;
  workingDays?: number[];
  workStartMinute?: number;
  workEndMinute?: number;
  dailyInviteLimit?: number;
  dailyMessageLimit?: number;
  dailyProfileViewLimit?: number;
  dailyFollowLimit?: number;
}

interface SeatRow {
  workspace_id: string;
  seat_key: string;
  label: string;
  profile_url: string | null;
  account_opened_on: string | null;
  connections_count: number | null;
  timezone: string;
  activated_at: string | null;
  detected_at: string | null;
  session_valid_at: string | null;
  posture: string;
  paused_reason: string | null;
  working_days: unknown;
  work_start_minute: number;
  work_end_minute: number;
  daily_invite_limit: number;
  daily_message_limit: number;
  daily_profile_view_limit: number;
  daily_follow_limit: number;
}

/**
 * DATE and TIMESTAMPTZ are both formatted in SQL rather than parsed from what
 * the driver hands back -- the pool sets a pass-through parser for 1184, and
 * pg's default DATE parser would produce a Date at the SERVER process's local
 * midnight, which is a different day for half the planet. Same choice, same
 * reason, as `outreach/store.ts`.
 */
// `linkedin_seats.auth_mode` (migration 028) is no longer read or written here:
// the manual/zero-custody sign-in path was removed and every seat now signs
// itself in with stored credentials. The column and its CHECK constraint are
// left in the schema rather than dropped in this pass.
// lc-debt: auth_mode column left unused rather than dropped; upgrade path is a
// follow-up migration to remove it once nothing references migration 028.
const SEAT_COLUMNS = `
  workspace_id,
  seat_key,
  label,
  profile_url,
  TO_CHAR(account_opened_on, 'YYYY-MM-DD') AS account_opened_on,
  connections_count,
  timezone,
  TO_CHAR(activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activated_at,
  TO_CHAR(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detected_at,
  TO_CHAR(session_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS session_valid_at,
  posture,
  paused_reason,
  working_days,
  work_start_minute,
  work_end_minute,
  daily_invite_limit,
  daily_message_limit,
  daily_profile_view_limit,
  daily_follow_limit
`;

function parsedWorkingDays(value: unknown): number[] {
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })() : value;
  if (!Array.isArray(raw)) return [];
  return raw.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function toSeat(row: SeatRow): LinkedInSeat {
  return {
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    label: row.label,
    profileUrl: row.profile_url,
    accountOpenedOn: row.account_opened_on,
    connectionsCount: row.connections_count,
    timezone: row.timezone,
    activatedAt: row.activated_at,
    detectedAt: row.detected_at,
    sessionValidAt: row.session_valid_at,
    posture: row.posture as SeatPosture,
    pausedReason: row.paused_reason,
    workingDays: parsedWorkingDays(row.working_days),
    workStartMinute: Number(row.work_start_minute),
    workEndMinute: Number(row.work_end_minute),
    dailyInviteLimit: Number(row.daily_invite_limit),
    dailyMessageLimit: Number(row.daily_message_limit),
    dailyProfileViewLimit: Number(row.daily_profile_view_limit),
    dailyFollowLimit: Number(row.daily_follow_limit)
  };
}

/** The workspace's seat, or undefined when none is configured. */
export async function getSeat(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? AND seat_key=?`).get<SeatRow>(workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Every seat in the workspace: today, zero or one.
 *
 * Plural because the caller's shape must not change when the agency case
 * lands, and because a UI that lists seats should not be rewritten to list
 * one.
 */
/**
 * Every workspace with a LinkedIn seat, for a worker deciding whose turn it is.
 *
 * DRIVEN OFF THE SEAT AND NOT OFF DUE ACTIONS, which is the difference between
 * this and `workspacesWithDueActions`. That one answers "who has something
 * scheduled"; this answers "who has a LinkedIn account Trevra acts for". The
 * periodic work -- reading the inbox, reconciling LinkedIn's pending-invite
 * list, draining the withdrawal queue -- is exactly what a workspace with an
 * EMPTY send queue needs, and keying it off due actions would skip the
 * workspaces it exists to help.
 *
 * Paused and cooling seats are included: every job re-reads the posture and
 * refuses for itself, and filtering here would put that rule in two places.
 */
export async function linkedinWorkspaceIds(db: Db): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT workspace_id FROM linkedin_seats ORDER BY workspace_id
  `).all<{ workspace_id: string }>();
  return rows.map((row) => row.workspace_id);
}

export async function listSeats(db: Db, workspaceId: string): Promise<LinkedInSeat[]> {
  const rows = await db.prepare(`SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? ORDER BY created_at ASC, seat_key ASC`).all<SeatRow>(workspaceId);
  return rows.map(toSeat);
}

/**
 * Throw unless `timezone` is a name this runtime's ICU actually knows.
 *
 * Validated on write and never on read: a bad name stored once would fail
 * every plan afterwards, at a point where the operator has no idea which field
 * was wrong. Exported because a detect request is QUEUED here and executed on
 * another machine minutes later -- a timezone the caller could have been told
 * about immediately must not surface as a worker-side failure instead.
 */
export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`'${timezone}' is not an IANA timezone name. Use something like 'Europe/Zurich' or 'America/New_York'.`);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create or update the seat.
 *
 * Absent patch fields mean UNCHANGED, never cleared: an operator turning a
 * seat's timezone into something correct must not silently wipe the rest of
 * it. Explicit `null` does clear a nullable field, which is how a mistaken
 * profile URL is removed.
 *
 * `label` and `timezone` have no defaults to fall back to, so the first write
 * must supply both, and the error says so rather than surfacing a NOT NULL
 * violation.
 *
 * THE FIRST WRITE STARTS THE RAMP, AND ONLY THE FIRST WRITE. `activated_at` is
 * set from `now` on insert and COALESCEd on conflict, so it survives every
 * later edit -- including this function's own, including a re-detect, and
 * including a `resumeSeat` cycle. That is not a nicety: it is the difference
 * between a ramp and a suggestion. Anything an operator could reset by saving
 * a form again is exactly the property that made `account_opened_on` the wrong
 * signal to pace on.
 */
export async function upsertSeat(
  db: Db,
  workspaceId: string,
  patch: SeatPatch,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seatKey)) throw new Error('seat_key must be 1-64 letters, numbers, underscores or dashes.');
  const existing = await getSeat(db, workspaceId, seatKey);

  const label = patch.label ?? existing?.label;
  if (!label?.trim()) throw new Error('A LinkedIn seat needs a label, e.g. "Pankaj (founder)".');
  const timezone = patch.timezone ?? existing?.timezone;
  if (!timezone?.trim()) throw new Error('A LinkedIn seat needs an IANA timezone; it decides which 08:00-18:00 the plan spreads across.');
  assertTimezone(timezone);

  const accountOpenedOn = patch.accountOpenedOn === undefined ? (existing?.accountOpenedOn ?? null) : patch.accountOpenedOn;
  if (accountOpenedOn !== null && !ISO_DATE.test(accountOpenedOn)) {
    throw new Error(`account_opened_on must be a 'YYYY-MM-DD' date; got '${accountOpenedOn}'.`);
  }

  const posture = patch.posture ?? existing?.posture ?? 'warmup';
  // A seat that is no longer paused has no pause reason. Keeping the old
  // string around would leave the UI explaining a stop that is over.
  const pausedReason = posture === 'paused' ? (existing?.pausedReason ?? null) : null;
  const detectedAt = patch.detectedAt === undefined ? (existing?.detectedAt ?? null) : patch.detectedAt;
  const sessionValidAt = patch.sessionValidAt === undefined ? (existing?.sessionValidAt ?? null) : patch.sessionValidAt;
  const workingDays = patch.workingDays ?? existing?.workingDays ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(workingDays) || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('working_days must contain only weekday numbers 0-6.');
  }
  const workStartMinute = patch.workStartMinute ?? existing?.workStartMinute ?? 480;
  const workEndMinute = patch.workEndMinute ?? existing?.workEndMinute ?? 1080;
  if (!Number.isInteger(workStartMinute) || !Number.isInteger(workEndMinute) || workStartMinute < 0 || workEndMinute > 1440 || workEndMinute <= workStartMinute) {
    throw new Error('Working hours must be whole minutes in one local day, with the end after the start.');
  }
  const resolveLimit = (value: number | undefined, fallback: number, max: number, name: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) throw new Error(`${name} must be a whole number from 0 to ${max}.`);
    return resolved;
  };
  const dailyInviteLimit = resolveLimit(patch.dailyInviteLimit, existing?.dailyInviteLimit ?? 30, 75, 'daily_invite_limit');
  const dailyMessageLimit = resolveLimit(patch.dailyMessageLimit, existing?.dailyMessageLimit ?? 25, 75, 'daily_message_limit');
  const dailyProfileViewLimit = resolveLimit(patch.dailyProfileViewLimit, existing?.dailyProfileViewLimit ?? 25, 100, 'daily_profile_view_limit');
  const dailyFollowLimit = resolveLimit(patch.dailyFollowLimit, existing?.dailyFollowLimit ?? 20, 50, 'daily_follow_limit');
  const timestamp = now.toISOString();

  const row = await db.prepare(`
    INSERT INTO linkedin_seats (
      workspace_id, seat_key, label, profile_url, account_opened_on, connections_count,
      timezone, activated_at, detected_at, session_valid_at, posture, paused_reason,
      working_days, work_start_minute, work_end_minute, daily_invite_limit,
      daily_message_limit, daily_profile_view_limit, daily_follow_limit, created_at, updated_at
    ) VALUES (?,?,?, ?,?::date,?::int,?,?::timestamptz,?::timestamptz,?::timestamptz,?,?,?::jsonb,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
      label = excluded.label,
      profile_url = excluded.profile_url,
      account_opened_on = excluded.account_opened_on,
      connections_count = excluded.connections_count,
      timezone = excluded.timezone,
      -- WRITE-ONCE, and the COALESCE is the enforcement. Every other column
      -- here takes the incoming value; this one keeps the one already stored.
      activated_at = COALESCE(linkedin_seats.activated_at, excluded.activated_at),
      detected_at = excluded.detected_at,
      session_valid_at = excluded.session_valid_at,
      posture = excluded.posture,
      paused_reason = excluded.paused_reason,
      working_days = excluded.working_days,
      work_start_minute = excluded.work_start_minute,
      work_end_minute = excluded.work_end_minute,
      daily_invite_limit = excluded.daily_invite_limit,
      daily_message_limit = excluded.daily_message_limit,
      daily_profile_view_limit = excluded.daily_profile_view_limit,
      daily_follow_limit = excluded.daily_follow_limit,
      updated_at = excluded.updated_at
    RETURNING ${SEAT_COLUMNS}
  `).get<SeatRow>(
    workspaceId,
    seatKey,
    label.trim(),
    patch.profileUrl === undefined ? (existing?.profileUrl ?? null) : patch.profileUrl,
    accountOpenedOn,
    patch.connectionsCount === undefined ? (existing?.connectionsCount ?? null) : patch.connectionsCount,
    timezone.trim(),
    timestamp,
    detectedAt,
    sessionValidAt,
    posture,
    pausedReason,
    JSON.stringify([...new Set(workingDays)]),
    workStartMinute,
    workEndMinute,
    dailyInviteLimit,
    dailyMessageLimit,
    dailyProfileViewLimit,
    dailyFollowLimit,
    timestamp,
    timestamp
  );

  return toSeat(row as SeatRow);
}

/**
 * Record that this seat's stored browser session was seen to be LIVE.
 *
 * Written only where that was actually observed -- a signed-in profile page
 * loaded, or a sign-in that just succeeded -- and never on an attempt. The
 * column's whole job is to let the next run REUSE a session instead of
 * re-authenticating, and a timestamp written on hope would defeat it.
 */
export async function stampSeatSessionValid(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`
    UPDATE linkedin_seats SET session_valid_at=?, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `).get<SeatRow>(now.toISOString(), now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Stop the seat, with a reason an operator will read later.
 *
 * The reason is not decoration: `pauseSeat` is what gets called when LinkedIn
 * restricts an account, and "why is this stopped" three weeks later is the
 * question the column answers.
 */
export async function pauseSeat(db: Db, workspaceId: string, reason: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`
    UPDATE linkedin_seats SET posture='paused', paused_reason=?, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `).get<SeatRow>(reason, now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Restart the seat.
 *
 * Stores 'warmup', which is the conservative value and not necessarily the one
 * that takes effect: `effectivePosture` re-derives warmup-vs-steady from the
 * ramp clock on the next read. Resuming a seat that has been automated for a
 * year does not put it back through the ramp, and resuming a three-week-old
 * one does not let it out. The clock itself is untouched here -- a pause is
 * not a reason to restart a ramp, and being able to earn one back by pausing
 * would be an incentive pointing the wrong way.
 */
export async function resumeSeat(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`
    UPDATE linkedin_seats SET posture='warmup', paused_reason=NULL, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `).get<SeatRow>(now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Forget this workspace ever had a seat.
 *
 * THIS RESETS THE RAMP CLOCK, ON PURPOSE, AND THAT IS THE ONE THING TO KNOW
 * BEFORE CALLING IT. `activatedAt` is write-once everywhere else in this
 * module -- no patch, no re-detect, no pause/resume cycle can touch it -- and
 * this function is the sole exception, because deleting the row is the one
 * operator action that legitimately means "start over": the next seat this
 * workspace gets, however it gets one, is a brand new week-1 account by the
 * same rule an undeclared seat already is. It is not a rule this function
 * bends; it is the one path that was always meant to end the ramp instead of
 * pausing it.
 *
 * Leaves `linkedin_actions` (the send ledger), `linkedin_seat_detect_requests`
 * and any stored credentials untouched -- none of those are "the seat", and a
 * delete here must not quietly erase send history or a password the operator
 * did not ask to remove.
 */
export async function deleteSeat(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): Promise<boolean> {
  const result = await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key=?').run(workspaceId, seatKey);
  return result.changes > 0;
}

/**
 * The 1-based warm-up week for a seat's ramp clock.
 *
 * `activatedAt` is an ISO-8601 instant: the moment this workspace first had a
 * seat, and therefore the moment its automated activity could first exist.
 * Days 0-6 are week 1. An absent, unparseable, or future instant is week 1 --
 * the most restrictive answer, and the one that is right when we do not know.
 */
export function warmupWeekOf(activatedAt: string | null, now: Date): number {
  if (!activatedAt) return 1;
  const activated = Date.parse(activatedAt);
  if (Number.isNaN(activated)) return 1;
  const days = Math.floor((now.getTime() - activated) / 86_400_000);
  if (days < 0) return 1;
  return Math.floor(days / 7) + 1;
}

/**
 * The posture that actually applies.
 *
 * Operator state wins where it is real: 'paused' and 'cooldown' are decisions
 * a human made and nothing here overrides them. Everything else is derived
 * from the ramp clock, because warmup-vs-steady is a fact about how long this
 * seat has been automated and not a preference about it -- a stored 'steady'
 * on a two-week-old seat is a mistake, and honouring it would be the expensive
 * kind.
 */
export function effectivePosture(seat: LinkedInSeat, now: Date): SeatPosture {
  if (seat.posture === 'paused' || seat.posture === 'cooldown') return seat.posture;
  return warmupWeekOf(seat.activatedAt, now) > WARMUP_WEEKS ? 'steady' : 'warmup';
}

/** The effective posture for the workspace's seat, or null when it has none. */
export async function getSeatPosture(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<SeatPosture | null> {
  const seat = await getSeat(db, workspaceId, seatKey);
  return seat ? effectivePosture(seat, now) : null;
}
