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

/**
 * Every status a ledger row can hold.
 *
 * 'held' IS FIRST-CLASS HERE, and it took two migrations to become so.
 * Migration 051 introduced it as the status `pauseManagedCampaign` parks a
 * scheduled-but-unclaimed row in, and for a while it lived only in that
 * migration's prose and in three WHERE clauses: `campaigns.ts` casts a raw
 * `status` column straight onto this union, so every held row arrived at every
 * reader typed as something it demonstrably was not. That is not a cosmetic
 * gap -- it is why the funnel had no column for it, why `SKIPPABLE` refused
 * it, and why `stopCampaign` could strand it, all three without a single
 * compiler complaint. A status the ledger WRITES is a status this union NAMES.
 *
 * 'withdrawn' is the same story one migration earlier (032) and was widened in
 * for the same reason. The rule the two of them establish: adding a value to
 * `linkedin_actions.status` -- which carries no CHECK constraint by design,
 * see migration 032 -- means adding it here in the same change, so the places
 * that must learn about it are a typecheck rather than an audit.
 *
 * The order below is the ledger's own lifecycle: never-happened-yet, then
 * out-the-door, then decided, then the two terminal cancellations.
 *
 * PUBLISHED AS VALUES, NOT ONLY AS A TYPE, for the reason `ACTION_KIND_VALUES`
 * above already is. A type cannot be handed to `z.enum`, so the HTTP layer had
 * to restate this list by hand -- and `app.ts` says in its own comment that a
 * hand-copied vocabulary is how `linkedinPacedKind` came to refuse a kind
 * `limits.ts` was already pacing. That is not hypothetical here: the route
 * enum was missing BOTH 'held' and 'withdrawn', so
 * `GET /api/linkedin/actions?status=held` answered 400 and the rows a pause
 * parks were unreadable through the only API that lists the queue. It was
 * later given a `satisfies` plus an `Exclude` guard, which does turn drift
 * into a build failure -- but only after somebody hand-copied the list
 * correctly one more time, and only in the one file that remembered to write
 * the guard. The client's copy has no guard at all.
 *
 * One importable constant removes the copying rather than checking it: the
 * route enum is `z.enum(ACTION_STATUS_VALUES)` and the client's filter list is
 * the same array, so a status added here reaches both without anybody being
 * asked to remember.
 */
export const ACTION_STATUS_VALUES = [
  'planned',
  'held',
  'exported',
  'sent',
  'accepted',
  'replied',
  'declined',
  'skipped',
  'withdrawn'
] as const;

export type LinkedInActionStatus = (typeof ACTION_STATUS_VALUES)[number];

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
 * Statuses that assert nothing left the building, as values.
 *
 * The value form of `COUNTED` below, so the one rule has one home: three
 * separate functions across two modules had each spelled it out as their own
 * `status !== 'planned' && status !== 'skipped'`, which is exactly how 'held'
 * came to be missing from some of them and not others.
 */
export const UNCOUNTED_STATUSES: readonly LinkedInActionStatus[] = ['planned', 'held', 'skipped'];

/** True when this status is a claim that something reached the outside world. */
export function isCountedStatus(status: LinkedInActionStatus): boolean {
  return !(UNCOUNTED_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that consume budget.
 *
 * 'exported' counts even though nobody has confirmed it went out. From
 * LinkedIn's point of view an exported invite is about to be real, and a
 * ceiling that only counted CONFIRMED sends would let a workspace export three
 * campaigns in a morning and discover the problem from a restriction notice.
 * 'planned' and 'skipped' never happened, so neither counts.
 *
 * NEITHER DOES 'held', AND UNTIL NOW THAT WAS AN ACCIDENT RATHER THAN A RULE.
 * A held row is a planned row a pause parked (migration 051): never claimed,
 * never sent, and `startManagedCampaign` hands the identical slot back. Billing
 * it as delivered would charge a seat's daily, weekly and monthly ceilings for
 * work a human explicitly stopped -- so pressing Pause on one campaign would
 * SHRINK the headroom of every other campaign on that seat, which is the
 * opposite of what the button means.
 *
 * It was excluded in practice only because every caller of this predicate also
 * carries an `AND recorded_at > ?` bound and a held row's `recorded_at` is
 * NULL. Nothing enforced that pairing -- it is a convention held together by
 * two lines happening to sit next to each other -- and the next window query
 * written without the bound would have silently billed a paused campaign. The
 * predicate now states the rule itself, and the `recorded_at` bound is back to
 * meaning only what it says.
 */
const COUNTED = `status NOT IN ('planned', 'held', 'skipped')`;

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
   * Replay identity within one kind+target. Existing callers remain `legacy`;
   * managed workflows use a stable member+step scope so a later follow-up is
   * distinct without weakening the default duplicate guard.
   */
  replayScope?: string;
  /**
   * When it actually happened. Defaults to `now` for any counted status and to
   * null for the three that never happened -- 'planned', 'held' and 'skipped'
   * (`UNCOUNTED_STATUSES`) -- which is what makes rule 1 above hold without
   * every caller having to remember it.
   */
  recordedAt?: string | null;
  /**
   * The Trevra user whose live request queued this row -- migration 043,
   * team-workspace-access design. Set by every caller that queues a
   * 'planned' row FOR THIS DEPLOYMENT'S OWN WORKER off a live request
   * (`queueCampaign`, `enqueueReply`, `recordEngagement`'s app.ts caller):
   * `req.auth.userId`. Left undefined (stored NULL) for `source: 'export'`
   * rows -- an export is handed to a tool Trevra does not drive, a different
   * provenance kind from "queued for this worker" -- and for the
   * approved-action executor's replay of an already-approved queue action
   * (`control-plane/execution.ts`), which runs outside a live request with no
   * captured human actor to attribute the row to.
   */
  queuedByUserId?: string | null;
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
  const counted = isCountedStatus(record.status);
  const recordedAt = record.recordedAt === undefined ? (counted ? now.toISOString() : null) : record.recordedAt;
  const actionId = id('lact');
  const replayScope = record.replayScope?.trim() || 'legacy';

  const row = await db.prepare(`
    INSERT INTO linkedin_actions (
      id, workspace_id, seat_key, kind, target_ref, campaign_id,
      status, planned_for, recorded_at, source, payload_hash, queued_by_user_id, replay_scope, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key, kind, target_ref, replay_scope) WHERE status <> 'skipped' DO NOTHING
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
    record.queuedByUserId ?? null,
    replayScope,
    now.toISOString()
  );

  if (row) return { id: row.id, duplicate: false };

  const existing = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=? AND replay_scope=? AND status <> 'skipped'
    ORDER BY created_at DESC LIMIT 1
  `).get<{ id: string }>(record.workspaceId, seatKey, record.kind, record.targetRef, replayScope);
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
  return countActionKindsInWindow(db, seat, [kind], sinceHours, now);
}

/** Aggregate account-level ceilings such as "messages/day" across several ledger kinds. */
export async function countActionKindsInWindow(
  db: Db,
  seat: SeatRef,
  kinds: readonly LinkedInActionKind[],
  sinceHours: number,
  now: Date
): Promise<number> {
  if (kinds.length === 0) return 0;
  const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind = ANY(?::text[]) AND ${COUNTED} AND recorded_at > ?
  `).get<{ total: number }>(seat.workspaceId, seat.seatKey, [...kinds], since);
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
 * `targetRef` IN THE SAME REPLAY SCOPE.
 *
 * `excludeActionId` drops exactly ONE row from the lookup, by primary key. It
 * exists for the caller that has already claimed its own ledger row and is now
 * asking whether that target was touched by anything ELSE -- a row cannot be
 * its own duplicate. It is deliberately an id and not a flag: excluding a
 * named row keeps the question "is there another one", where a flag would turn
 * it into "skip this check", which is a different and much weaker question.
 *
 * `replayScope` IS THE OTHER HALF OF MIGRATION 047, AND WITHOUT IT THIS QUERY
 * CONTRADICTED THE LEDGER IT GUARDS.
 *
 * 047 widened the partial unique index behind `recordAction` from
 * (workspace, seat, kind, target) to (workspace, seat, kind, target,
 * replay_scope), precisely so a managed workflow can touch one person twice
 * with one kind under a stable `member:step` scope while every legacy writer
 * -- which supplies no scope and stores 'legacy' -- keeps colliding exactly as
 * before. This predicate is what `guard.ts` `duplicate-target` asks, and it
 * ignored the new column: so the ledger would happily accept a workflow's
 * second message step while the gate refused it forever, because the FIRST
 * step's row was already `sent` against the same person. A campaign with two
 * message steps could never send the second one.
 *
 * The rule is therefore the index's rule, verbatim: a row vetoes this one only
 * when it shares its replay scope. Different scope, different action -- the
 * ledger would store both, so the gate must allow both. Same scope, or both
 * unscoped, is still a duplicate, so nothing an existing caller does changes:
 * an export, an inbox reply and a manual row all default to 'legacy' here for
 * the same reason `recordAction` defaults them to 'legacy' there, and the
 * legacy one-kind-per-target guard is exactly as strict as it ever was.
 *
 * A genuine repeat of the SAME step for the SAME member still fails, because
 * that repeat carries the same `member:step` scope by construction.
 */
export async function hasTarget(
  db: Db,
  seat: SeatRef,
  kind: LinkedInActionKind,
  targetRef: string,
  excludeActionId: string | null = null,
  replayScope: string | null = null
): Promise<boolean> {
  // The same normalisation `recordAction` applies on the way in, so the
  // question and the write can never disagree about which scope a row is in.
  const scope = replayScope?.trim() || 'legacy';
  const row = await db.prepare(`
    SELECT id FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind=? AND target_ref=? AND replay_scope=? AND status <> 'skipped'
      AND id IS DISTINCT FROM ?::text
    LIMIT 1
  `).get<{ id: string }>(seat.workspaceId, seat.seatKey, kind, targetRef, scope, excludeActionId);
  return row !== undefined;
}
