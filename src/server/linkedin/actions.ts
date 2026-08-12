import { id, type Db } from '../db.js';
import { OWNER_SEAT_KEY } from './seats.js';

/**
 * The per-seat action ledger.
 *
 * This is the denominator of everything the pacing engine claims. Plan 1.3
 * says detection is behavioural, so the engine's job is to reason about what a
 * seat ACTUALLY did day by day -- and that is only knowable from rows written
 * here. An export that does not land in this table makes the next plan's
 * day-over-day arithmetic fiction.
 *
 * Two rules make the counts mean something:
 *
 * 1. Windows read `recorded_at`, never `created_at`. A row written today for a
 *    slot next Tuesday must not consume today's 24h budget.
 * 2. Windows are ROLLING, not calendar days -- the same call
 *    `outreach/store.ts` made for the same reason: a calendar cap of 20
 *    delivers 40 across a midnight boundary, and midnight in whose timezone
 *    was never defined.
 */

/**
 * Everything the ledger records.
 *
 * `reply` is separate from `dm` on purpose, and the reason is a guard rather
 * than a taxonomy preference. The partial unique index below and the guard's
 * `duplicate-target` check both refuse a second action of one kind against one
 * target -- correctly, for a cold DM. But answering somebody this seat has
 * already messaged is the NORMAL case in an inbox, so filing a reply as a `dm`
 * would make the ordinary use of the inbox indistinguishable from the abuse
 * those two guards exist to stop. The choice was to weaken the replay guard
 * for messages or to give a reply its own kind; the second costs one row in
 * `limits.ts` and leaves both guards exactly as strict as they were.
 *
 * `like` and `endorse` join `follow` as the three ENGAGEMENT kinds that
 * `driver-engage.ts` performs. Migration 034 widens the column's documented
 * enumeration; this union is the other half of the same widening.
 */
export const ACTION_KIND_VALUES = [
  'invite',
  'dm',
  'reply',
  'inmail',
  'profile_view',
  'comment',
  'follow',
  'like',
  'endorse'
] as const;

export type LinkedInActionKind = (typeof ACTION_KIND_VALUES)[number];

export type LinkedInActionStatus = 'planned' | 'exported' | 'sent' | 'accepted' | 'replied' | 'declined' | 'skipped' | 'withdrawn';

/**
 * Who put the row here.
 *
 * 'campaign' is an approved campaign queued for the LOCAL WORKER (`queue.ts`),
 * and it is separate from 'export' on purpose even though both come from the
 * same approval: an 'export' row was handed to a tool Trevra does not drive and
 * nobody will ever confirm it, while a 'campaign' row is one this deployment
 * intends to execute itself and will later date with a real `recorded_at`. A
 * ledger that filed both as 'export' could not answer "what did this machine
 * actually do", which is the question the whole subsystem exists to answer.
 * Widening the column is free: it carries no CHECK (migration 022; the same
 * call 023, 032, 034 and 035 make about this table's other enumerations), so
 * migration 038 widens its documented enumeration and this union is the other
 * half of that widening.
 */
export type LinkedInActionSource = 'export' | 'manual' | 'aggregator' | 'campaign';

/** Everything a rolling window is counted for. */
export interface SeatRef {
  workspaceId: string;
  seatKey: string;
}

export function ownerSeat(workspaceId: string): SeatRef {
  return { workspaceId, seatKey: OWNER_SEAT_KEY };
}

/**
 * Statuses that consume budget.
 *
 * 'exported' counts even though nobody has confirmed it went out. From
 * LinkedIn's point of view an exported invite is about to be real, and a
 * ceiling that only counted CONFIRMED sends would let a workspace export three
 * campaigns in a morning and discover the problem from a restriction notice.
 * 'planned' and 'skipped' never happened, so neither counts.
 */
const COUNTED = `status NOT IN ('planned', 'skipped')`;

export interface LinkedInActionRecord {
  workspaceId: string;
  /** Defaults to the owner seat -- the only one that exists today. */
  seatKey?: string;
  kind: LinkedInActionKind;
  targetRef: string | null;
  campaignId?: string | null;
  status: LinkedInActionStatus;
  /** ISO-8601. The paced slot this action belongs to. */
  plannedFor?: string | null;
  source: LinkedInActionSource;
  payloadHash?: string | null;
  /**
   * When it actually happened. Defaults to `now` for any counted status and to
   * null for 'planned'/'skipped', which is what makes rule 1 above hold
   * without every caller having to remember it.
   */
  recordedAt?: string | null;
}

/**
 * Append to the ledger.
 *
 * Returns the existing row id when this target already has an action of this
 * kind, so a re-run of an export is a no-op rather than a second invite to the
 * same person. The partial unique index does the enforcing; this reports it
 * without throwing -- same contract as `outreach/store.ts` `recordPost`.
 */
export async function recordAction(db: Db, record: LinkedInActionRecord, now: Date): Promise<{ id: string; duplicate: boolean }> {
  const seatKey = record.seatKey ?? OWNER_SEAT_KEY;
  const counted = record.status !== 'planned' && record.status !== 'skipped';
  const recordedAt = record.recordedAt === undefined ? (counted ? now.toISOString() : null) : record.recordedAt;
  const actionId = id('lact');

  const row = await db.prepare(`
    INSERT INTO linkedin_actions (
      id, workspace_id, seat_key, kind, target_ref, campaign_id,
      status, planned_for, recorded_at, source, payload_hash, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key, kind, target_ref) WHERE status <> 'skipped' DO NOTHING
    RETURNING id
  `).get<{ id: string }>(
    actionId,
    record.workspaceId,
    seatKey,
    record.kind,
    record.targetRef,
    record.campaignId ?? null,
    record.status,
    record.plannedFor ?? null,
    recordedAt,
    record.source,
    record.payloadHash ?? null,
    now.toISOString()
  );

  if (row) return { id: row.id, duplicate: false };

  const existing = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=? AND status <> 'skipped'
    ORDER BY created_at DESC LIMIT 1
  `).get<{ id: string }>(record.workspaceId, seatKey, record.kind, record.targetRef);
  return { id: existing?.id ?? actionId, duplicate: true };
}

/** Actions of `kind` this seat took in the `sinceHours` before `now`. */
export async function countActionsInWindow(
  db: Db,
  seat: SeatRef,
  kind: LinkedInActionKind,
  sinceHours: number,
  now: Date
): Promise<number> {
  const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND ${COUNTED} AND recorded_at > ?
  `).get<{ total: number }>(seat.workspaceId, seat.seatKey, kind, since);
  return row?.total ?? 0;
}

export interface AcceptanceRate {
  /** Invites whose outcome is known. The denominator. */
  decided: number;
  /** Of those, the ones that were accepted (a reply implies acceptance). */
  accepted: number;
  /** null when nothing has been decided yet -- see below. */
  rate: number | null;
}

/**
 * Invite acceptance over the last `days`.
 *
 * Scoped to invites because that is what the reported signal measures (1.3:
 * "sustained acceptance rate <30% over a week") and the only kind that can be
 * accepted at all.
 *
 * THE DENOMINATOR IS DECIDED INVITES, NOT SENT ONES. An invite sitting
 * unanswered is not a refusal, and counting it as one would mean every fresh
 * export instantly drags the rate toward zero and trips the throttle on
 * evidence that has not arrived yet.
 *
 * No decided invites returns `rate: null`, and callers do NOT throttle on it.
 * This is the one place that deliberately departs from the fail-closed rule in
 * `outreach/safety.ts`, and it is because the two situations are different:
 * there, the unknown is the operator's own standing, which they can declare
 * here, the unknown is whether strangers accepted invites that have not been
 * sent yet. Throttling on no evidence would halve a brand-new seat forever,
 * for a signal that cannot exist until it has sent something. The warm-up ramp
 * is what protects a new account; this loop is what protects an active one.
 */
export async function acceptanceRate(db: Db, seat: SeatRef, days: number, now: Date): Promise<AcceptanceRate> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('accepted', 'replied', 'declined'))::int AS decided,
      COUNT(*) FILTER (WHERE status IN ('accepted', 'replied'))::int AS accepted
    FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind='invite' AND recorded_at > ?
  `).get<{ decided: number; accepted: number }>(seat.workspaceId, seat.seatKey, since);

  const decided = row?.decided ?? 0;
  const accepted = row?.accepted ?? 0;
  return { decided, accepted, rate: decided === 0 ? null : accepted / decided };
}

/**
 * Per-day counts for the last `n` days, OLDEST FIRST.
 *
 * The buckets are rolling 24h windows ending at `now`, not local calendar
 * days: the last element is "the last 24 hours". Calendar days would need a
 * timezone, and the one that matters -- LinkedIn's own enforcement clock -- is
 * not a timezone we know. Every consumer of this array (variance smoothing,
 * the rolling weekly and monthly budgets) compares adjacent buckets, and
 * adjacent rolling buckets are exactly as comparable as adjacent calendar
 * days.
 */
export async function dailyCountsForLastNDays(
  db: Db,
  seat: SeatRef,
  kind: LinkedInActionKind,
  n: number,
  now: Date
): Promise<number[]> {
  const days = Math.max(1, Math.trunc(n));
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const rows = await db.prepare(`
    SELECT
      FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - recorded_at)) / 86400)::int AS bucket,
      COUNT(*)::int AS total
    FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND ${COUNTED}
      AND recorded_at > ? AND recorded_at <= ?
    GROUP BY 1
  `).all<{ bucket: number; total: number }>(nowIso, seat.workspaceId, seat.seatKey, kind, since, nowIso);

  // bucket 0 is the newest 24h; the array is oldest-first, so it lands last.
  const counts = new Array<number>(days).fill(0);
  for (const row of rows) {
    const index = days - 1 - row.bucket;
    if (index >= 0 && index < days) counts[index] = row.total;
  }
  return counts;
}

/**
 * How many invites this seat currently has awaiting an answer.
 *
 * NOT SCOPED TO A WINDOW, and that is the whole point of it existing beside
 * `countActionsInWindow`. Every other count in this file is rolling, because
 * every other ceiling is about RATE. "Pending" has no window: an invite sent in
 * March is still occupying a slot in June, it is still consuming the
 * operator's weekly invite capacity on LinkedIn's side, and it is still a
 * permanent zero in the acceptance numerator. A backlog older than the rolling
 * window was invisible to both `guard.ts` and `pacing.ts`, which is why
 * withdrawing one returned no headroom in Trevra's arithmetic even though it
 * did on LinkedIn's.
 *
 * 'sent' and 'exported' are the two statuses that mean "it went out and nobody
 * has answered". 'accepted', 'replied' and 'declined' are decided; 'withdrawn'
 * was taken back; 'planned' never happened; 'skipped' released the target.
 *
 * `before` NARROWS IT TO THE INVISIBLE PART, and exists for exactly one caller.
 * `guard.ts` wants the WHOLE backlog, because its ceiling is on the backlog
 * itself. `pacing.ts` charges the backlog against the rolling WEEKLY budget,
 * and there the whole number would double-count: an invite sent on Tuesday is
 * already inside the 7-day window the weekly clamp reads, so subtracting it a
 * second time as "outstanding" would charge one invite twice and take a seat
 * that sent ten this week from five a day to zero. Passing `now - 7 days`
 * leaves exactly the part the rolling window cannot see, which is the part the
 * clamp was blind to and the reason it needed fixing.
 *
 * Dated by COALESCE(pending_since, recorded_at) -- LinkedIn's own account of
 * when the recipient got it where we have it, ours where we do not, the same
 * clock `selectWithdrawalCandidates` measures staleness on. A row with neither
 * cannot be placed in time and is left out of a `before` count rather than
 * assumed old.
 *
 * It lives HERE rather than in `withdraw.ts`, where the withdrawal feature
 * that needed it was written, for one structural reason: its two consumers are
 * `guard.ts` and `pacing.ts`, and `withdraw.ts` imports both of them. Exporting
 * it from there would close a cycle through three modules for a five-line
 * SELECT over the table this file owns. `withdraw.ts` re-exports it under the
 * same name.
 */
export async function countPendingInvites(
  db: Db,
  seat: SeatRef,
  options: { before?: Date } = {}
): Promise<number> {
  const before = options.before;
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind='invite' AND status IN ('sent', 'exported')
      AND (?::timestamptz IS NULL OR COALESCE(pending_since, recorded_at) < ?::timestamptz)
  `).get<{ total: number }>(
    seat.workspaceId,
    seat.seatKey,
    before?.toISOString() ?? null,
    before?.toISOString() ?? null
  );
  return row?.total ?? 0;
}

/**
 * True when this seat already has a non-skipped action of `kind` against
 * `targetRef`.
 *
 * `excludeActionId` drops exactly ONE row from the lookup, by primary key. It
 * exists for the caller that has already claimed its own ledger row and is now
 * asking whether that target was touched by anything ELSE -- a row cannot be
 * its own duplicate. It is deliberately an id and not a flag: excluding a
 * named row keeps the question "is there another one", where a flag would turn
 * it into "skip this check", which is a different and much weaker question.
 */
export async function hasTarget(
  db: Db,
  seat: SeatRef,
  kind: LinkedInActionKind,
  targetRef: string,
  excludeActionId: string | null = null
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=? AND status <> 'skipped'
      AND id IS DISTINCT FROM ?::text
    LIMIT 1
  `).get<{ id: string }>(seat.workspaceId, seat.seatKey, kind, targetRef, excludeActionId);
  return row !== undefined;
}
