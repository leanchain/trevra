import type { Db } from '../db.js';
import { WARMUP_WEEKS } from './limits.js';

export type SeatPosture = 'warmup' | 'steady' | 'paused' | 'cooldown';
export const OWNER_SEAT_KEY = 'owner';

export const PRODUCT_LIMIT_DEFAULTS = { invite: 30, message: 25, profile_view: 25, follow: 20 } as const;
export const PRODUCT_LIMIT_RANGES = {
  invite: { min: 0, max: 75 },
  message: { min: 0, max: 75 },
  profile_view: { min: 0, max: 100 },
  follow: { min: 0, max: 50 }
} as const;

export interface LinkedInOperatorLimits {
  invite: number;
  message: number;
  profile_view: number;
  follow: number;
}

export interface LinkedInSeat {
  workspaceId: string;
  seatKey: string;
  label: string;
  profileUrl: string | null;
  accountOpenedOn: string | null;
  connectionsCount: number | null;
  timezone: string;
  activatedAt: string | null;
  detectedAt: string | null;
  sessionValidAt: string | null;
  posture: SeatPosture;
  pausedReason: string | null;
  /** JS weekday numbers, 0 Sunday .. 6 Saturday. */
  workingDays: number[];
  workingStart: string;
  workingEnd: string;
  operatorLimits: LinkedInOperatorLimits;
}

export interface SeatPatch {
  label?: string;
  profileUrl?: string | null;
  accountOpenedOn?: string | null;
  connectionsCount?: number | null;
  timezone?: string;
  posture?: SeatPosture;
  detectedAt?: string | null;
  sessionValidAt?: string | null;
  workingDays?: number[];
  workingStart?: string;
  workingEnd?: string;
  operatorLimits?: Partial<LinkedInOperatorLimits>;
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
  working_days: number[] | null;
  working_start: string | null;
  working_end: string | null;
  operator_limits: unknown;
}

const SEAT_COLUMNS = `
  workspace_id, seat_key, label, profile_url,
  TO_CHAR(account_opened_on, 'YYYY-MM-DD') AS account_opened_on,
  connections_count, timezone,
  TO_CHAR(activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activated_at,
  TO_CHAR(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detected_at,
  TO_CHAR(session_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS session_valid_at,
  posture, paused_reason, working_days,
  TO_CHAR(working_start, 'HH24:MI') AS working_start,
  TO_CHAR(working_end, 'HH24:MI') AS working_end,
  operator_limits
`;

function finiteInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback;
}

function normalizeLimits(value: unknown): LinkedInOperatorLimits {
  const row = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return {
    invite: finiteInt(row.invite, PRODUCT_LIMIT_DEFAULTS.invite),
    message: finiteInt(row.message, PRODUCT_LIMIT_DEFAULTS.message),
    profile_view: finiteInt(row.profile_view, PRODUCT_LIMIT_DEFAULTS.profile_view),
    follow: finiteInt(row.follow, PRODUCT_LIMIT_DEFAULTS.follow)
  };
}

function toSeat(row: SeatRow): LinkedInSeat {
  return {
    workspaceId: row.workspace_id,
    seatKey: row.seat_key || OWNER_SEAT_KEY,
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
    workingDays: Array.isArray(row.working_days) && row.working_days.length > 0 ? row.working_days.map(Number) : [1,2,3,4,5],
    workingStart: row.working_start ?? '08:00',
    workingEnd: row.working_end ?? '18:00',
    operatorLimits: normalizeLimits(row.operator_limits)
  };
}

export function assertSeatKey(seatKey: string): string {
  const value = seatKey.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error('A LinkedIn seat key must be 1-64 letters, numbers, underscores or hyphens.');
  }
  return value;
}

export async function getSeat(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const key = assertSeatKey(seatKey);
  const row = await db.prepare(`SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? AND seat_key=?`)
    .get<SeatRow>(workspaceId, key);
  return row ? toSeat(row) : undefined;
}

export async function listSeats(db: Db, workspaceId: string): Promise<LinkedInSeat[]> {
  const rows = await db.prepare(`SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? ORDER BY created_at ASC, seat_key ASC`)
    .all<SeatRow>(workspaceId);
  return rows.map(toSeat);
}

/** Every workspace with at least one seat; retained for workspace-level maintenance jobs. */
export async function linkedinWorkspaceIds(db: Db): Promise<string[]> {
  const rows = await db.prepare('SELECT DISTINCT workspace_id FROM linkedin_seats ORDER BY workspace_id').all<{ workspace_id: string }>();
  return rows.map((row) => row.workspace_id);
}

/** Every actual seat; worker code should prefer this when a job is account-specific. */
export async function linkedinSeatRefs(db: Db): Promise<Array<{ workspaceId: string; seatKey: string }>> {
  const rows = await db.prepare('SELECT workspace_id, seat_key FROM linkedin_seats ORDER BY workspace_id, seat_key')
    .all<{ workspace_id: string; seat_key: string }>();
  return rows.map((row) => ({ workspaceId: row.workspace_id, seatKey: row.seat_key }));
}

export function assertTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new Error(`'${timezone}' is not an IANA timezone name. Use something like 'Europe/Zurich' or 'America/New_York'.`); }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function assertClock(value: string, field: string): void {
  if (!CLOCK.test(value)) throw new Error(`${field} must be HH:MM in 24-hour time.`);
}

function validateWorkingDays(days: readonly number[]): number[] {
  const normalized = [...new Set(days.map(Number))].sort((a, b) => a - b);
  if (normalized.length === 0 || normalized.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('workingDays must contain one or more weekday numbers from 0 (Sunday) through 6 (Saturday).');
  }
  return normalized;
}

function validateLimits(input: Partial<LinkedInOperatorLimits>, base: LinkedInOperatorLimits): LinkedInOperatorLimits {
  const result = { ...base, ...input };
  for (const key of Object.keys(PRODUCT_LIMIT_RANGES) as Array<keyof LinkedInOperatorLimits>) {
    const value = result[key];
    const range = PRODUCT_LIMIT_RANGES[key];
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      throw new Error(`${key} limit must be a whole number from ${range.min} to ${range.max}.`);
    }
  }
  return result;
}

export async function upsertSeat(
  db: Db,
  workspaceId: string,
  patch: SeatPatch,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat> {
  const key = assertSeatKey(seatKey);
  const existing = await getSeat(db, workspaceId, key);
  const label = patch.label ?? existing?.label;
  if (!label?.trim()) throw new Error('A LinkedIn seat needs a label.');
  const timezone = patch.timezone ?? existing?.timezone;
  if (!timezone?.trim()) throw new Error('A LinkedIn seat needs an IANA timezone.');
  assertTimezone(timezone);

  const accountOpenedOn = patch.accountOpenedOn === undefined ? (existing?.accountOpenedOn ?? null) : patch.accountOpenedOn;
  if (accountOpenedOn !== null && !ISO_DATE.test(accountOpenedOn)) throw new Error("account_opened_on must be a 'YYYY-MM-DD' date.");
  const posture = patch.posture ?? existing?.posture ?? 'warmup';
  const pausedReason = posture === 'paused' ? (existing?.pausedReason ?? null) : null;
  const workingDays = patch.workingDays === undefined ? (existing?.workingDays ?? [1,2,3,4,5]) : validateWorkingDays(patch.workingDays);
  const workingStart = patch.workingStart ?? existing?.workingStart ?? '08:00';
  const workingEnd = patch.workingEnd ?? existing?.workingEnd ?? '18:00';
  assertClock(workingStart, 'workingStart');
  assertClock(workingEnd, 'workingEnd');
  if (workingStart >= workingEnd) throw new Error('workingEnd must be later than workingStart.');
  const operatorLimits = validateLimits(patch.operatorLimits ?? {}, existing?.operatorLimits ?? { ...PRODUCT_LIMIT_DEFAULTS });
  const timestamp = now.toISOString();

  const row = await db.prepare(`
    INSERT INTO linkedin_seats (
      workspace_id, seat_key, label, profile_url, account_opened_on, connections_count,
      timezone, activated_at, detected_at, session_valid_at, posture, paused_reason,
      working_days, working_start, working_end, operator_limits, created_at, updated_at
    ) VALUES (?,?,?,?,?::date,?::int,?,?::timestamptz,?::timestamptz,?::timestamptz,?,?,?::smallint[],?::time,?::time,?::jsonb,?,?)
    ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
      label=excluded.label, profile_url=excluded.profile_url, account_opened_on=excluded.account_opened_on,
      connections_count=excluded.connections_count, timezone=excluded.timezone,
      activated_at=COALESCE(linkedin_seats.activated_at, excluded.activated_at),
      detected_at=excluded.detected_at, session_valid_at=excluded.session_valid_at,
      posture=excluded.posture, paused_reason=excluded.paused_reason,
      working_days=excluded.working_days, working_start=excluded.working_start, working_end=excluded.working_end,
      operator_limits=excluded.operator_limits, updated_at=excluded.updated_at
    RETURNING ${SEAT_COLUMNS}
  `).get<SeatRow>(
    workspaceId, key, label.trim(), patch.profileUrl === undefined ? (existing?.profileUrl ?? null) : patch.profileUrl,
    accountOpenedOn, patch.connectionsCount === undefined ? (existing?.connectionsCount ?? null) : patch.connectionsCount,
    timezone.trim(), timestamp,
    patch.detectedAt === undefined ? (existing?.detectedAt ?? null) : patch.detectedAt,
    patch.sessionValidAt === undefined ? (existing?.sessionValidAt ?? null) : patch.sessionValidAt,
    posture, pausedReason, workingDays, workingStart, workingEnd, JSON.stringify(operatorLimits), timestamp, timestamp
  );
  if (!row) throw new Error('LinkedIn seat could not be stored.');
  return toSeat(row);
}

export async function stampSeatSessionValid(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`UPDATE linkedin_seats SET session_valid_at=?, updated_at=? WHERE workspace_id=? AND seat_key=? RETURNING ${SEAT_COLUMNS}`)
    .get<SeatRow>(now.toISOString(), now.toISOString(), workspaceId, assertSeatKey(seatKey));
  return row ? toSeat(row) : undefined;
}

export async function pauseSeat(db: Db, workspaceId: string, reason: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`UPDATE linkedin_seats SET posture='paused', paused_reason=?, updated_at=? WHERE workspace_id=? AND seat_key=? RETURNING ${SEAT_COLUMNS}`)
    .get<SeatRow>(reason, now.toISOString(), workspaceId, assertSeatKey(seatKey));
  return row ? toSeat(row) : undefined;
}

export async function resumeSeat(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<LinkedInSeat | undefined> {
  const row = await db.prepare(`UPDATE linkedin_seats SET posture='warmup', paused_reason=NULL, updated_at=? WHERE workspace_id=? AND seat_key=? RETURNING ${SEAT_COLUMNS}`)
    .get<SeatRow>(now.toISOString(), workspaceId, assertSeatKey(seatKey));
  return row ? toSeat(row) : undefined;
}

export async function deleteSeat(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): Promise<boolean> {
  const result = await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key=?').run(workspaceId, assertSeatKey(seatKey));
  return result.changes > 0;
}

export function warmupWeekOf(activatedAt: string | null, now: Date): number {
  if (!activatedAt) return 1;
  const activated = Date.parse(activatedAt);
  if (Number.isNaN(activated)) return 1;
  const days = Math.floor((now.getTime() - activated) / 86_400_000);
  if (days < 0) return 1;
  return Math.floor(days / 7) + 1;
}

export function effectivePosture(seat: LinkedInSeat, now: Date): SeatPosture {
  if (seat.posture === 'paused' || seat.posture === 'cooldown') return seat.posture;
  return warmupWeekOf(seat.activatedAt, now) > WARMUP_WEEKS ? 'steady' : 'warmup';
}

export async function getSeatPosture(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY): Promise<SeatPosture | null> {
  const seat = await getSeat(db, workspaceId, seatKey);
  return seat ? effectivePosture(seat, now) : null;
}
