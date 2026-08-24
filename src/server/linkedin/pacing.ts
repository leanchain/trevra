import { z } from 'zod';
import type { Db } from '../db.js';
import type { Skill, SkillContext } from '../skills/types.js';
import {
  acceptanceRate,
  countPendingInvites,
  dailyCountsForLastNDays,
  type SeatRef
} from './actions.js';
import {
  ACCEPTANCE_THROTTLE_FACTOR,
  ACCEPTANCE_WINDOW_DAYS,
  ACTION_GAP_SECONDS,
  BUSINESS_HOURS,
  DAY_OVER_DAY_BASELINE_DAYS,
  MAX_DAY_OVER_DAY_DELTA,
  MAX_OUTSTANDING_INVITES,
  MIN_ACCEPTANCE_RATE,
  MIN_RAMP_STEP,
  PACED_KINDS,
  PACED_KIND_VALUES,
  WARMUP_WEEKS,
  WEEKEND_FACTOR,
  bandFor,
  dayOverDayCeiling,
  effectiveDailyCeiling,
  establishedDayOverDayFloor,
  isPassiveKind,
  seatOperatorLimit,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import { OWNER_SEAT_KEY, effectivePosture, getSeat, listSeats, warmupWeekOf } from './seats.js';

/**
 * LinkedIn pacing is deliberately deterministic and policy-driven. The
 * planner uses the seat's configured working days/hours, rolling ledger
 * ceilings, campaign/account ramps and outcome throttles. It does not add
 * random timing or synthetic browsing patterns to disguise automation.
 *
 * The previous business day's ACTUAL ledger count still matters because it
 * prevents abrupt volume increases after downtime or a quiet period.
 */

/** Longest plan this engine will produce. Beyond ~3 months the ledger it is reasoning from is stale. */
export const MAX_HORIZON_DAYS = 90;

/** How much ledger history the rolling weekly/monthly budgets need. */
const HISTORY_DAYS = 30;

export interface PacingSlot {
  /** ISO-8601 UTC instant. */
  plannedFor: string;
  kind: PacedKind;
  targetRef: string;
}

export interface PacingPlan {
  seatKey: string;
  slots: PacingSlot[];
  /** Written for a founder reading a plan, in order of derivation. */
  reasons: string[];
  /** Machine-readable ids of every ceiling that actually bound. */
  ceilingsApplied: string[];
}

export interface PacingInput {
  workspaceId: string;
  seatKey?: string;
  kind: PacedKind;
  targets: readonly string[];
  horizonDays: number;
}

/* -------------------------------------------------------------------------
 * Seat-local clock.
 *
 * Business hours are the SEAT's, so every day boundary and every hour here is
 * evaluated in the seat's IANA zone rather than in the server's. Exported
 * because `guard.ts` has to answer the same questions about a slot somebody
 * else produced.
 * ---------------------------------------------------------------------- */

export interface LocalMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type LocalDate = Pick<LocalMoment, 'year' | 'month' | 'day'>;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock reading of `instant` in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalMoment {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second')
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const local = localDateOf(instant, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant for a wall-clock time in `timeZone`.
 *
 * Two passes, because the offset is a function of the instant we are solving
 * for: the first guess picks an offset from the wrong side of a DST boundary
 * at most once a year, and the second correction lands on the right one.
 */
export function zonedToUtc(date: LocalDate, secondsFromMidnight: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + secondsFromMidnight * 1000;
  const first = naive - offsetMs(new Date(naive), timeZone);
  return new Date(naive - offsetMs(new Date(first), timeZone));
}

/** JS weekday for a local date. 0 = Sunday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

/**
 * The days and hours ONE SEAT actually works, in its own local clock.
 *
 * The operator's configuration is authoritative and `BUSINESS_HOURS` is the
 * fallback for the only case with no seat to ask -- `guard.ts` evaluating a
 * workspace that has never configured one.
 *
 * Both the planner and the gate read this same window, and that is the whole
 * point of it living here. A planner that placed slots against a hardcoded
 * 08:00-18:00 Mon-Fri while the gate enforced the seat's own 10:00-14:00
 * Tue/Thu does not produce a BLOCKED action -- it produces one that is
 * refused at execution time and silently never happens.
 */
export interface WorkWindow {
  /** JS weekday numbers, Sunday=0. Empty disables automated activity entirely. */
  days: readonly number[];
  /** Minutes after local midnight. `endMinute` is exclusive. */
  startMinute: number;
  endMinute: number;
}

/** The window for a workspace with no seat: the researched default, nothing configured. */
export const DEFAULT_WORK_WINDOW: WorkWindow = {
  days: [1, 2, 3, 4, 5],
  startMinute: BUSINESS_HOURS.start * 60,
  endMinute: BUSINESS_HOURS.end * 60
};

/** Structural, so neither this module nor `guard.ts` has to import the seat row's whole type. */
export interface WorkWindowSeat {
  workingDays: readonly number[];
  workStartMinute: number;
  workEndMinute: number;
}

export function workWindowOf(seat: WorkWindowSeat | null | undefined): WorkWindow {
  if (!seat) return DEFAULT_WORK_WINDOW;
  return {
    days: [...seat.workingDays],
    startMinute: seat.workStartMinute,
    endMinute: seat.workEndMinute
  };
}

/** 'HH:MM' for a minute-of-day, for the sentences both the plan and the gate write. */
export function formatMinuteOfDay(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * What one weekday's volume is multiplied by, and the single predicate the
 * planner and the gate both answer "may this seat act on this day" with.
 *
 * A DAY THE OPERATOR CONFIGURED IS A WORKING DAY, weekend or not. Ticking
 * Saturday in `working_days` is an explicit statement about this account, and
 * WEEKEND_FACTOR does not get to veto it -- the factor is VOLUME SHAPING for a
 * weekend day nobody configured (0.0 today: a founder's LinkedIn going quiet
 * at the weekend is the least remarkable thing about it). Any other
 * unconfigured day is 0: this seat does not work it.
 *
 * `> 0` is the workable-day test. Reading it in both files is what stops the
 * plan and the gate disagreeing about which days exist.
 */
export function weekdayVolumeFactor(window: WorkWindow, weekday: number): number {
  if (window.days.includes(weekday)) return 1;
  return isWeekend(weekday) ? WEEKEND_FACTOR : 0;
}

/**
 * Production uses the operator-configured day exactly as written. These
 * compatibility constants remain exported for API/test consumers, but no
 * random edge movement, invented rest day, or daily volume draw is applied.
 */
export const DAY_EDGE_JITTER_MINUTES = 0;
export const REST_DAY_ODDS = 0;
export const DAILY_DRAW = { min: 1, max: 1 } as const;
const MIN_DAY_SPAN_MINUTES = 0;

export interface DayShape {
  startMinute: number;
  endMinute: number;
  resting: boolean;
  draw: number;
}

export function dayShapeFor(_seed: string, _day: LocalDate, window: WorkWindow): DayShape {
  return {
    startMinute: window.startMinute,
    endMinute: window.endMinute,
    resting: false,
    draw: 1
  };
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function isoDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/**
 * Compatibility exports for the scheduling/UI surface. Autonomous work has
 * one eligibility window per configured working day: the seat's actual work
 * window. There is no separately generated browsing-session schedule.
 */
export const VISITS_PER_DAY = { min: 1, max: 1 } as const;
export const VISIT_MINUTES = { min: 0, max: 0 } as const;

/** The configured autonomous execution window for one day. */
export interface Visit {
  index: number;
  startMinute: number;
  endMinute: number;
  actions: number;
}

/** Return the configured work window without modifying it by seat, date, or load. */
export function visitsForDay(
  seed: string,
  day: LocalDate,
  window: { startMinute: number; endMinute: number },
  options: { actions?: number; earliestMinute?: number } = {}
): Visit[] {
  void seed;
  void day;
  void options.earliestMinute;
  if (window.endMinute <= window.startMinute) return [];
  return [
    {
      index: 0,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      actions: Math.max(0, Math.trunc(options.actions ?? 0))
    }
  ];
}

/**
 * Place actions deterministically inside the configured working window.
 * `visits` is retained in the signature for compatibility with callers that
 * render the same window, but no generated visit pattern changes timing.
 */
function spreadWithinVisits(
  count: number,
  earliestSecond: number,
  _visits: readonly Visit[],
  window: WorkWindow
): number[] {
  return spreadWithinWorkingHours(count, earliestSecond, window);
}

function spreadWithinWorkingHours(
  count: number,
  earliestSecond: number,
  window: WorkWindow
): number[] {
  if (count <= 0) return [];
  const windowStart = Math.max(window.startMinute * 60, earliestSecond);
  const windowEnd = window.endMinute * 60;
  const span = Math.max(0, windowEnd - windowStart);

  /**
   * Bound the number of slots by the remaining window capacity at the fixed
   * conservative action gap. Excess work rolls to a later configured day;
   * nothing is clamped onto the same second at the window's end.
   */
  const capacity = span <= 0 ? 0 : Math.floor(span / ACTION_GAP_SECONDS.max) + 1;
  const scheduled = Math.min(count, capacity);
  if (scheduled <= 0) return [];
  const spacing = span / scheduled;

  const seconds: number[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scheduled; index += 1) {
    const target = windowStart + index * spacing;
    const at = index === 0 ? target : Math.max(target, cursor + ACTION_GAP_SECONDS.max);
    cursor = Math.min(at, windowEnd - 1);
    seconds.push(Math.round(cursor));
  }
  return seconds;
}
function sumOfLast(values: readonly number[], count: number): number {
  return values
    .slice(Math.max(0, values.length - count))
    .reduce((total, value) => total + value, 0);
}

/**
 * The most recent completed BUSINESS day's count, from an oldest-first daily
 * history whose last bucket is the 24 hours before `todayLocal`.
 *
 * The newest bucket is deliberately EXCLUDED: it is the day in progress, not
 * the day before it. Including it would make the guard's day-over-day check
 * compare today's count against itself, which passes by construction and
 * gates nothing.
 *
 * NON-WORKING buckets are skipped, also on purpose. A day this seat does not
 * work is 0 by design -- a weekend under WEEKEND_FACTOR 0, or any weekday the
 * operator did not tick -- and seeding the next day's clamp from it would
 * reset the ramp every single week, manufacturing the exact weekly sawtooth
 * plan 1.3 describes as the thing that gets accounts restricted. A seat
 * configured for Tuesdays and Thursdays would otherwise ramp from a Monday
 * zero every Tuesday, forever.
 *
 * `window` defaults to the researched Mon-Fri window, which is what a
 * workspace with no seat is paced against. Shared with `guard.ts` so the plan
 * and the gate can never disagree about what "yesterday" was.
 */
export function previousBusinessDayCount(
  history: readonly number[],
  todayLocal: LocalDate,
  window: WorkWindow = DEFAULT_WORK_WINDOW
): number {
  return recentBusinessDayCounts(history, todayLocal, window, 1)[0] ?? 0;
}

/**
 * The last `days` completed BUSINESS days' counts, NEWEST FIRST.
 *
 * Same two exclusions `previousBusinessDayCount` documents above -- the day in
 * progress is never included, and days this seat does not work are skipped
 * rather than read as zeros -- applied `days` times instead of once. Shorter
 * than `days` only when the history itself runs out.
 */
export function recentBusinessDayCounts(
  history: readonly number[],
  todayLocal: LocalDate,
  window: WorkWindow = DEFAULT_WORK_WINDOW,
  days: number = DAY_OVER_DAY_BASELINE_DAYS
): number[] {
  const wanted = Math.max(0, Math.trunc(days));
  const counts: number[] = [];
  for (let index = history.length - 2; index >= 0 && counts.length < wanted; index -= 1) {
    const bucketDate = addLocalDays(todayLocal, -(history.length - 1 - index));
    if (weekdayVolumeFactor(window, weekdayOf(bucketDate)) === 0) continue;
    counts.push(history[index]);
  }
  return counts;
}

/**
 * THE NUMBER THE DAY-OVER-DAY CLAMP RAMPS FROM: the highest of the last
 * `DAY_OVER_DAY_BASELINE_DAYS` business days.
 *
 * Why a maximum over a window rather than yesterday's count is the whole
 * argument on `DAY_OVER_DAY_BASELINE_DAYS` in `limits.ts`, and it is the same
 * function here and in `guard.ts` so a plan and the gate that judges it can
 * never disagree about what this seat's current volume is.
 */
export function sustainedBusinessDayCount(
  history: readonly number[],
  todayLocal: LocalDate,
  window: WorkWindow = DEFAULT_WORK_WINDOW,
  days: number = DAY_OVER_DAY_BASELINE_DAYS
): number {
  const counts = recentBusinessDayCounts(history, todayLocal, window, days);
  return counts.length === 0 ? 0 : Math.max(...counts);
}

/**
 * Plan `targets` for one seat and one kind.
 *
 * The seven steps of plan 4-phase-2, in order, each marked below.
 */
/**
 * The day-shaping seam, injected exactly as `sleep` and `driver` are elsewhere.
 *
 * Production never passes it: the seeded `dayShapeFor` is the behaviour, and a
 * plan that did not vary its days is the thing this file was fixed to stop
 * producing. Tests that are ASSERTING A CEILING pass `FLAT_DAY_SHAPE`, because
 * "the warm-up band is 5/day" is a statement about the ceiling and would be
 * unreadable written as "5/day drawn down to 4 on this particular date".
 */
export type DayShapeFn = (seed: string, day: LocalDate, window: WorkWindow) => DayShape;

/** Every day identical and full: the pre-2026-08-14 behaviour, for ceiling tests. */
export const FLAT_DAY_SHAPE: DayShapeFn = (_seed, _day, window) => ({
  startMinute: window.startMinute,
  endMinute: window.endMinute,
  resting: false,
  draw: 1
});

export async function planPacing(
  db: Db,
  input: PacingInput,
  now: Date,
  options: { dayShape?: DayShapeFn } = {}
): Promise<PacingPlan> {
  const shapeDay = options.dayShape ?? dayShapeFor;
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const seatRef: SeatRef = { workspaceId: input.workspaceId, seatKey };
  const reasons: string[] = [];
  const ceilingsApplied: string[] = [];

  // --- Step 1: posture, and the warm-up week derived from account age. ---
  const seat = await getSeat(db, input.workspaceId, seatKey);
  if (!seat) {
    reasons.push(
      'No LinkedIn seat is configured for this workspace, so there is nothing to pace. Add one with a label, a timezone, and the date the account was opened.'
    );
    return { seatKey, slots: [], reasons, ceilingsApplied };
  }

  const posture = effectivePosture(seat, now);
  if (posture === 'paused') {
    ceilingsApplied.push('seat-paused');
    reasons.push(
      `Seat '${seat.label}' is paused${seat.pausedReason ? `: ${seat.pausedReason}` : ''}. Nothing is scheduled while it is paused.`
    );
    return { seatKey, slots: [], reasons, ceilingsApplied };
  }

  // The seat's own days and hours, not a constant. Every slot below is placed
  // inside this window because `guard.ts` refuses one outside it, and a plan
  // the gate refuses is an action that stalls rather than an action that is
  // blocked with a reason.
  const window = workWindowOf(seat);
  if (window.days.length === 0) {
    ceilingsApplied.push('working-days');
    reasons.push(
      `Seat '${seat.label}' has no working days configured, so there is no day this plan could place an action on. Tick at least one day in this account's schedule.`
    );
    return { seatKey, slots: [], reasons, ceilingsApplied };
  }

  const targets: string[] = [];
  const seenTargets = new Set<string>();
  for (const target of input.targets) {
    const trimmed = target.trim();
    if (!trimmed || seenTargets.has(trimmed)) continue;
    seenTargets.add(trimmed);
    targets.push(trimmed);
  }
  const dropped = input.targets.length - targets.length;
  if (dropped > 0)
    reasons.push(`${dropped} empty or repeated target(s) were dropped; one target gets one slot.`);

  const warmupWeek = warmupWeekOf(seat.activatedAt, now);
  const band = bandFor(input.kind, posture === 'steady' ? 'steady' : 'warmup');

  /* --- Step 2: base daily volume = daily ceiling x warm-up multiplier. ---
   *
   * THE CEILING, NOT THE BAND, and that distinction was missing entirely.
   * This function read `bandFor()` and nothing else, so it never once looked
   * at the four numbers the operator actually configured on the seat. An
   * operator who set 5 invites/day and asked for a plan got a schedule of 18 a
   * day -- every slot past the fifth refused by `guard.ts` at execution time,
   * which is not a blocked action with a reason, it is an action that silently
   * never happens. The planner and the gate reconcile the two numbers the same
   * way now, through the same function.
   *
   * Passive kinds skip the account multiplier entirely. Active outreach now
   * begins at a small non-zero week-1 volume, while passive activity stays at
   * the full conservative warm-up band. Both remain subject to every other
   * pacing and safety check.
   */
  const passive = isPassiveKind(input.kind);
  const multiplier = seat.warmupOverride ? 1 : warmupMultiplierFor(input.kind, warmupWeek);
  const operatorLimit = seatOperatorLimit(seat, input.kind);
  const dailyCeiling = effectiveDailyCeiling(band.perDay, operatorLimit, seat.safetyBandOverride);
  const baseDaily = Math.floor(dailyCeiling * multiplier);
  reasons.push(
    seat.warmupOverride
      ? `Seat '${seat.label}' is ${posture}. Account warm-up is explicitly skipped; the recorded clock is week ${warmupWeek}, so ${dailyCeiling} ${input.kind}/day x 1 = ${baseDaily}/day before smoothing.`
      : `Seat '${seat.label}' is ${posture}, warm-up week ${warmupWeek}: ${dailyCeiling} ${input.kind}/day x ${multiplier} = ${baseDaily}/day before smoothing.`
  );
  // THE BINDING NUMBER IS NAMED, whichever it is. These sentences are what a
  // founder reads to find out why a plan is the size it is, and "18/day"
  // against a form that says 30 is the question they would otherwise have to
  // ask support.
  if (operatorLimit !== null && operatorLimit < band.perDay && !seat.safetyBandOverride) {
    ceilingsApplied.push('operator-daily-limit');
    reasons.push(
      `Your own ceiling for this account is ${operatorLimit} ${input.kind}(s)/day, which is stricter than Trevra's ${band.perDay}/day ${posture} safety band, so yours is the one that binds. Raise it in this account's settings if you want more.`
    );
  } else if (operatorLimit !== null && operatorLimit > band.perDay && !seat.safetyBandOverride) {
    ceilingsApplied.push('safety-band');
    reasons.push(
      `You have set ${operatorLimit} ${input.kind}(s)/day for this account, but Trevra's researched ${posture} band is ${band.perDay}/day and the stricter of the two binds -- so this plan is built on ${band.perDay}/day, not ${operatorLimit}. Turning on "use my own daily limits" for this account makes your number the binding one; the warm-up ramps, the rolling windows and the variance clamp all still apply either way.`
    );
  } else if (operatorLimit !== null && seat.safetyBandOverride && operatorLimit > band.perDay) {
    ceilingsApplied.push('operator-daily-limit');
    reasons.push(
      `This account is set to use your own daily limits instead of Trevra's safety bands, so ${operatorLimit} ${input.kind}(s)/day binds rather than the researched ${band.perDay}/day. Every other applicable ceiling -- account warm-up unless explicitly skipped, the rolling 7-day and 30-day windows, and the day-over-day variance clamp -- still applies.`
    );
  }
  reasons.push(
    `Slots are placed between ${formatMinuteOfDay(window.startMinute)} and ${formatMinuteOfDay(window.endMinute)} in ${seat.timezone}, on weekday(s) ${window.days.join(', ')} -- this account's configured working window, which is the same window the safety gate refuses a slot outside of.`
  );
  if (passive && warmupWeek <= WARMUP_WEEKS) {
    reasons.push(
      `${input.kind} is passive activity, so it runs at the full ${posture} band during warm-up instead of being ramped. Every other ceiling still applies.`
    );
  }
  if (multiplier < 1) ceilingsApplied.push('warmup-multiplier');
  if (posture === 'cooldown') {
    ceilingsApplied.push('cooldown-band');
    reasons.push(
      'Seat is in cooldown, so the conservative warm-up band applies instead of the steady one.'
    );
  }
  if (seat.activatedAt === null) {
    // Fail closed. A seat with no activation instant is one this schema never
    // wrote, so it is paced as brand new rather than as trusted.
    reasons.push(
      "This seat has no activation timestamp, so it is paced as a week-1 seat. The ramp clock starts on the seat's first write and no edit resets it."
    );
  }

  // --- Step 4 (measured once, applied per day below). ---
  const acceptance = await acceptanceRate(db, seatRef, ACCEPTANCE_WINDOW_DAYS, now);
  const throttled = acceptance.rate !== null && acceptance.rate < MIN_ACCEPTANCE_RATE;
  if (throttled && acceptance.rate !== null) {
    ceilingsApplied.push('acceptance-rate');
    reasons.push(
      `throttled: ${ACCEPTANCE_WINDOW_DAYS}-day invite acceptance is ${(acceptance.rate * 100).toFixed(0)}% (${acceptance.accepted} of ${acceptance.decided} decided), below the ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}% floor. Volume is halved until it recovers.`
    );
  }

  /**
   * The invisible half of the backlog, charged against the WEEKLY headroom.
   *
   * The weekly clamp asks "how much of this seat's 7-day invite capacity is
   * already spent", and it answered from `recorded_at` alone -- which silently
   * assumed every invite older than the window had been resolved. It has not:
   * on LinkedIn's side an unanswered invite from March is still occupying
   * capacity in June, which is precisely why plan 1.4 measures acceptance
   * against invites OUTSTANDING rather than invites sent this week. Charging it
   * is what makes withdrawal do something; before this an operator could clear
   * two hundred stale invites and watch the planner emit the same schedule,
   * because nothing it read had changed.
   *
   * OLDER THAN THE WINDOW, NOT THE WHOLE BACKLOG, and that bound is the whole
   * correctness of it. `sumOfLast(timeline, 6)` below already charges every
   * invite sent in the last seven days; adding the full outstanding count on
   * top would charge this week's invites TWICE -- a seat that sent ten of its
   * twenty weekly invites and is waiting on all ten would be clamped to zero
   * rather than to ten. `now - 7 days` leaves exactly the part the rolling
   * window cannot see, which is the part that was missing.
   *
   * A CONSTANT FOR THE WHOLE PLAN, not decremented per day: the backlog is what
   * it is at planning time, and modelling it shrinking would be modelling
   * acceptances that have not happened.
   */
  const outstandingInvites =
    input.kind === 'invite'
      ? await countPendingInvites(db, seatRef, { before: new Date(now.getTime() - 7 * 86_400_000) })
      : 0;

  // Ledger history: the last element is the last 24 hours.
  const history = await dailyCountsForLastNDays(db, seatRef, input.kind, HISTORY_DAYS, now);
  const timeline = [...history];

  const todayLocal = localDateOf(now, seat.timezone);
  const nowSecondOfDay = todayLocal.hour * 3600 + todayLocal.minute * 60 + todayLocal.second;
  // A plan generated after the window has closed starts tomorrow rather than
  // back-dating slots into an evening nobody will act on.
  const startsToday = nowSecondOfDay < window.endMinute * 60;
  const startDate = startsToday ? todayLocal : addLocalDays(todayLocal, 1);

  // --- Step 3 seed: the recent BUSINESS days' actual counts, newest first. ---
  //
  // A WINDOW, NOT YESTERDAY. Seeding from the single previous business day made
  // one quiet day reset this seat to `MIN_RAMP_STEP` and cost it a ten-day
  // climb back -- see `DAY_OVER_DAY_BASELINE_DAYS` in `limits.ts` for why that
  // was manufacturing the sawtooth this clamp exists to prevent. The window
  // rolls forward through the simulated days below exactly as it reads back
  // through the ledger here, so day 4 of a plan is ramped from days 1-3 of that
  // same plan and not from a ledger that has not caught up yet.
  const recentActuals = recentBusinessDayCounts(history, todayLocal, window);
  // The floor an EXPLICITLY established account gets when Trevra's ledger has
  // nothing to ramp from. 0 for everybody else, and it raises this one ceiling
  // and nothing else. See `establishedDayOverDayFloor`.
  const establishedFloor = seat.warmupOverride ? establishedDayOverDayFloor(dailyCeiling) : 0;
  reasons.push(
    seat.warmupOverride
      ? `The last ${DAY_OVER_DAY_BASELINE_DAYS} business days carried at most ${recentActuals.length === 0 ? 0 : Math.max(...recentActuals)} ${input.kind}(s); the next day may not exceed that by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%, or ${establishedFloor}/day, whichever is higher. The floor is there because this account is marked established: an empty Trevra ledger is not evidence of a cold LinkedIn account.`
      : `The last ${DAY_OVER_DAY_BASELINE_DAYS} business days carried at most ${recentActuals.length === 0 ? 0 : Math.max(...recentActuals)} ${input.kind}(s); the next day may not exceed that by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%.`
  );

  const horizon = Math.max(1, Math.min(Math.trunc(input.horizonDays), MAX_HORIZON_DAYS));
  const slots: PacingSlot[] = [];
  let assigned = 0;
  let deltaClamped = false;
  let weekendSkipped = false;
  let offDaySkipped = false;
  let weeklyClamped = false;
  let monthlyClamped = false;
  let backlogClamped = false;
  let windowCapacityClamped = false;

  for (let dayIndex = 0; dayIndex < horizon && assigned < targets.length; dayIndex += 1) {
    const day = addLocalDays(startDate, dayIndex);
    const weekday = weekdayOf(day);

    // The day shape defaults to the operator-configured window with full
    // ceiling. A test or explicit policy injection may narrow it, but the
    // production planner adds no synthetic day variation.
    const shape = shapeDay(`${input.workspaceId}:${seatKey}`, day, window);
    const dayWindow: WorkWindow = {
      days: window.days,
      startMinute: shape.startMinute,
      endMinute: shape.endMinute
    };
    const dayCeiling = shape.resting ? 0 : Math.floor(baseDaily * shape.draw);

    // --- Step 3: variance smoothing against the recent days' ACTUALS. ---
    const baseline = recentActuals.length === 0 ? 0 : Math.max(...recentActuals);
    const deltaCeiling = dayOverDayCeiling(baseline, establishedFloor);
    let allowed = Math.min(dayCeiling, deltaCeiling);
    if (deltaCeiling < baseDaily) deltaClamped = true;

    // --- Step 4: acceptance-rate throttle. Halves, never zeroes. ---
    if (throttled)
      allowed = Math.max(allowed > 0 ? 1 : 0, Math.floor(allowed * ACCEPTANCE_THROTTLE_FACTOR));

    // --- Step 5: the seat's configured days. ---
    //
    // The configured days decide WHICH days exist for this seat; the weekend
    // factor only shapes the volume of a weekend day nobody configured. So an
    // operator who ticked Saturday gets Saturdays at full volume, and the gate
    // agrees because it reads the same `weekdayVolumeFactor`.
    const dayFactor = weekdayVolumeFactor(window, weekday);
    if (dayFactor < 1) {
      allowed = Math.floor(allowed * dayFactor);
      if (isWeekend(weekday)) weekendSkipped = true;
      else offDaySkipped = true;
    }

    // Rolling weekly and monthly budgets. The band's perWeek/perMonth are
    // ceilings over a WINDOW, so they are charged against the ledger's real
    // history plus everything this plan has already scheduled -- otherwise
    // 3 InMails a day for a fortnight quietly clears a 50-a-month quota.
    if (band.perWeek !== undefined) {
      const spentThisWeek = sumOfLast(timeline, 6);
      const capped = Math.min(
        allowed,
        Math.max(0, band.perWeek - spentThisWeek - outstandingInvites)
      );
      if (capped < allowed) {
        weeklyClamped = true;
        // Reported separately, because "you have sent too many this week" and
        // "two hundred of yours are still unanswered" have different fixes and
        // only one of them is "wait".
        if (outstandingInvites > 0) backlogClamped = true;
      }
      allowed = capped;
    }
    if (band.perMonth !== undefined) {
      const capped = Math.min(allowed, Math.max(0, band.perMonth - sumOfLast(timeline, 29)));
      if (capped < allowed) monthlyClamped = true;
      allowed = capped;
    }

    const count = Math.min(allowed, targets.length - assigned);

    // --- Step 6: spread deterministically across the configured work window. ---
    const earliest = dayIndex === 0 && startsToday ? nowSecondOfDay : 0;
    const dayVisits = visitsForDay(`${input.workspaceId}:${seatKey}`, day, shape, {
      actions: count,
      earliestMinute: earliest / 60
    });
    const secondsOfDay = spreadWithinVisits(count, earliest, dayVisits, dayWindow);
    // The window itself can hold fewer than `count` slots without crowding
    // (see `spreadWithinWorkingHours`'s own capacity note) -- typically only
    // the first, partial day of a plan generated late in the business-hours
    // window. Bookkeeping below uses what was ACTUALLY scheduled, never the
    // request: `timeline` and `previousActual` feed tomorrow's day-over-day
    // ceiling, and overstating today's count there would hand a future day a
    // more permissive ceiling than this seat actually earned.
    if (secondsOfDay.length < count) windowCapacityClamped = true;
    for (const secondOfDay of secondsOfDay) {
      slots.push({
        plannedFor: zonedToUtc(day, secondOfDay, seat.timezone).toISOString(),
        kind: input.kind,
        targetRef: targets[assigned]
      });
      assigned += 1;
    }

    timeline.push(secondsOfDay.length);
    // Only BUSINESS days enter the baseline window, for the same reason
    // `recentBusinessDayCounts` skips them when reading the ledger: a day this
    // seat does not work is 0 by design and must not drag the ramp down.
    if (dayFactor > 0) {
      recentActuals.unshift(secondsOfDay.length);
      recentActuals.length = Math.min(recentActuals.length, DAY_OVER_DAY_BASELINE_DAYS);
    }
  }

  // --- Step 7: report every ceiling that bound, not just the first. ---
  if (deltaClamped) {
    ceilingsApplied.push('day-over-day-delta');
    reasons.push(
      `Volume is ramped rather than started at ${baseDaily}/day: no day may exceed the highest of the last ${DAY_OVER_DAY_BASELINE_DAYS} business days by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%, which is what keeps this seat off the "slide and spike" signature.`
    );
  }
  if (weekendSkipped) {
    ceilingsApplied.push('weekend');
    reasons.push(
      WEEKEND_FACTOR === 0
        ? 'Weekend days this account has not configured as working days are left empty; the ramp resumes from the last working day rather than from zero.'
        : `Weekend days this account has not configured as working days carry ${(WEEKEND_FACTOR * 100).toFixed(0)}% of a working day's volume; a weekend day it HAS configured is a working day and carries a full one.`
    );
  }
  if (offDaySkipped) {
    ceilingsApplied.push('working-days');
    reasons.push(
      `Days outside this account's configured working days (${window.days.join(', ')}) are left empty. The safety gate refuses a slot outside them, so planning one would stall the action rather than perform it.`
    );
  }
  if (weeklyClamped) {
    ceilingsApplied.push('weekly-band');
    reasons.push(
      `The rolling 7-day ceiling of ${band.perWeek} ${input.kind}(s) bound on at least one day.`
    );
  }
  if (backlogClamped) {
    ceilingsApplied.push('pending-invite-backlog');
    reasons.push(
      `${outstandingInvites} invite(s) sent more than 7 days ago are still awaiting an answer, and they are charged against the same weekly capacity as new ones -- on LinkedIn's side an unanswered invite keeps occupying a slot until it is accepted or withdrawn. Withdrawing them returns that capacity; the ceiling on the whole backlog is ${MAX_OUTSTANDING_INVITES}, REPORTED from plan 1.4.`
    );
  }
  if (monthlyClamped) {
    ceilingsApplied.push('monthly-quota');
    reasons.push(
      input.kind === 'inmail'
        ? `LinkedIn's published 50-InMail monthly quota bound on at least one day; ${band.perMonth} is a hard quota, not a pacing preference.`
        : `The rolling 30-day ceiling of ${band.perMonth} ${input.kind}(s) bound on at least one day.`
    );
  }
  if (windowCapacityClamped) {
    ceilingsApplied.push('business-hours-window-capacity');
    reasons.push(
      `At least one day carried fewer than its allowed count: the remaining business-hours window did not have room for all of them at a safe ${ACTION_GAP_SECONDS.min}-${ACTION_GAP_SECONDS.max}s spacing, so the rest rolled to the next available day rather than crowding the window's close.`
    );
  }
  if (assigned < targets.length) {
    reasons.push(
      `${targets.length - assigned} of ${targets.length} target(s) do not fit inside ${horizon} day(s) at this pace and are not scheduled. Extend the horizon or split the campaign.`
    );
  }

  return { seatKey, slots, reasons, ceilingsApplied };
}

/**
 * The seat an MCP/skill call meant, when it did not say.
 *
 * WHY THE OLD `.default(OWNER_SEAT_KEY)` WAS A BUG AND NOT A CONVENIENCE.
 * Every function in `seats.ts` defaults its `seatKey` argument to the owner
 * seat, and that default is right THERE: it keeps a single-seat workspace's
 * pre-multi-seat call sites resolving the row they always did. On a SKILL
 * INPUT SCHEMA it is a different thing entirely. An agent calling
 * `gtm.linkedin-pace` or `gtm.linkedin-guard` without naming a seat is not
 * asking for the owner account -- it has simply not said which account it
 * means, and zod filling in 'owner' turns "unspecified" into a confident
 * answer about one particular LinkedIn identity. In a workspace running three
 * accounts that prices ceilings against the wrong one, and the plan or verdict
 * that comes back names a seat nobody chose. The failure mode of a defaulted
 * seat key is never a missing row; it is the wrong account acting.
 *
 * So the resolution is explicit and it fails loud in the one case that is
 * genuinely ambiguous:
 *
 *   - a seat key was supplied  -> use it, unchanged;
 *   - the workspace has ONE seat -> use it, whatever it is called. A
 *     single-account workspace has no ambiguity to resolve, and this is what
 *     keeps every existing single-seat caller working;
 *   - the workspace has SEVERAL -> refuse, naming them. Guessing here is the
 *     wrong-account action this exists to prevent;
 *   - the workspace has NONE -> the owner key, so the caller gets the gate's
 *     honest `seat-configured: false` verdict (or the planner's no-seat path)
 *     rather than an error about a choice there was nothing to choose from.
 */
export async function resolveSkillSeatKey(
  db: Db,
  workspaceId: string,
  seatKey: string | undefined
): Promise<string> {
  const named = seatKey?.trim();
  if (named) return named;
  const seats = await listSeats(db, workspaceId);
  if (seats.length === 1) return seats[0].seatKey;
  if (seats.length === 0) return OWNER_SEAT_KEY;
  throw new Error(
    `This workspace has ${seats.length} LinkedIn seats (${seats.map((seat) => seat.seatKey).join(', ')}), so 'seatKey' is required: every ceiling, every window and every plan below is a fact about ONE account, and picking one for you would price this against an account nobody chose.`
  );
}

const kindSchema = z.enum(PACED_KIND_VALUES);

const inputSchema = z.object({
  /** Absent means "unspecified", never "the owner seat" -- see {@link resolveSkillSeatKey}. */
  seatKey: z.string().min(1).max(64).optional(),
  /**
   * Only the kinds with a band. `comment` is recordable in the ledger and
   * refused here, because no pacing number was researched for it and no driver
   * routine performs it -- see limits.ts.
   */
  kind: kindSchema,
  /** Opaque handles or profile URLs. Trevra never resolves them. */
  targets: z.array(z.string().min(1).max(500)).min(1).max(500),
  horizonDays: z.number().int().min(1).max(MAX_HORIZON_DAYS).default(14)
});

const outputSchema = z.object({
  seatKey: z.string(),
  slots: z.array(z.object({ plannedFor: z.string(), kind: kindSchema, targetRef: z.string() })),
  reasons: z.array(z.string()),
  ceilingsApplied: z.array(z.string())
});

type PacingSkillInput = z.infer<typeof inputSchema>;

export const linkedinPacingSkill: Skill<PacingSkillInput, PacingPlan> = {
  manifest: {
    id: 'gtm.linkedin-pace',
    name: 'LinkedIn pacing plan',
    version: '1.0.0',
    description:
      'Schedule LinkedIn actions for one seat across a horizon using account/campaign ramps, rolling ledger limits, acceptance throttling, configured working days and hours, and deterministic fixed-gap placement.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx: SkillContext) {
    return planPacing(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        seatKey: await resolveSkillSeatKey(ctx.db, ctx.workspaceId, input.seatKey),
        kind: input.kind as PacedKind,
        targets: input.targets,
        horizonDays: input.horizonDays
      },
      ctx.now()
    );
  }
};

/** Re-exported so callers validating a kind do not have to reach into limits.ts. */
export { PACED_KINDS };
