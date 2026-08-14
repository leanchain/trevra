import { z } from 'zod';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import type { Db } from '../db.js';
import type { Skill, SkillContext } from '../skills/types.js';
import { acceptanceRate, countPendingInvites, dailyCountsForLastNDays, type SeatRef } from './actions.js';
import {
  ACCEPTANCE_THROTTLE_FACTOR,
  ACCEPTANCE_WINDOW_DAYS,
  ACTION_GAP_SECONDS,
  BUSINESS_HOURS,
  ENFORCEMENT_SCAN_WEEKDAYS,
  MAX_DAY_OVER_DAY_DELTA,
  MAX_OUTSTANDING_INVITES,
  MIN_ACCEPTANCE_RATE,
  MIN_RAMP_STEP,
  PACED_KINDS,
  PACED_KIND_VALUES,
  WARMUP_WEEKS,
  WEEKEND_FACTOR,
  bandFor,
  effectiveDailyCeiling,
  isPassiveKind,
  seatOperatorLimit,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import { OWNER_SEAT_KEY, effectivePosture, getSeat, listSeats, warmupWeekOf } from './seats.js';

/**
 * The pacing engine.
 *
 * This is the product. Everything else in `src/server/linkedin/` exists to
 * feed it or to check its output.
 *
 * The premise, from plan 1.3: LinkedIn's enforcement is BEHAVIOURAL, not a
 * volume threshold. The signature that precedes a disconnection is "Slide and
 * Spike" -- five to ten days of declining activity followed by a +120% surge
 * within 24-48h. So a daily cap is not a defence. A workspace that runs
 * 20/20/20/0/0/0/20 is under every published ceiling on every single day and
 * is in more danger than one running a flat 12. Dripify and Expandi ship the
 * cap and the randomised delay; neither models the variance, which is the
 * thing being measured.
 *
 * Hence step 3 below, and hence the fact that the previous day's number comes
 * from `linkedin_actions` -- what the seat ACTUALLY did -- and never from what
 * a previous plan intended it to do.
 *
 * NO Math.random() ANYWHERE IN THIS FILE. The jitter is seeded from a hash of
 * the plan's own inputs, so re-planning the same request produces byte-identical
 * output. That is not a nicety: the playbook engine binds an approval to
 * `canonicalPayloadHash(payload)` and fails closed when the payload drifts
 * afterwards, so a plan that re-randomised itself would invalidate its own
 * approval every time it was recomputed.
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
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute'), second: read('second') };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const local = localDateOf(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
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
  return { days: [...seat.workingDays], startMinute: seat.workStartMinute, endMinute: seat.workEndMinute };
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
 * HOW ONE DAY DIFFERS FROM THE NEXT, and why a plan is not a cron table.
 *
 * The configured window is 08:00-18:00 Mon-Fri and it never moved. A seat that
 * starts at 08:00:00 sharp, finishes at 18:00:00 sharp, works every configured
 * day and runs to exactly its ceiling on each of them is not a person with a
 * job -- it is a scheduler, and the shape of the week says so before any single
 * action does. Three things vary, all seeded from the seat and the CALENDAR
 * DAY, so every caller that asks about the same day gets the same answer:
 *
 *   the edges   up to 45 minutes later at the start and earlier at the end.
 *               Always INSIDE the configured window, never outside it, so the
 *               safety gate can keep enforcing the operator's own hours and can
 *               never refuse a slot this produced.
 *   rest days   about one working day in eight is left empty. Nobody prospects
 *               every single working day, and a seat that does is remarkable in
 *               a way no per-action realism can fix.
 *   the draw    a day takes 80-100% of its ceiling instead of all of it. This
 *               is what every published competitor rulebook does (Waalaxy draws
 *               80-100% of the configured max) and Trevra was the outlier in
 *               running to the number.
 *
 * SEEDED, NEVER `Math.random()`, like everything else in this file: the same
 * seat and the same date produce the same day on every machine, which is what
 * lets a plan be reproduced from the ledger and asserted in a test.
 */
export const DAY_EDGE_JITTER_MINUTES = 45;
export const REST_DAY_ODDS = 0.12;
export const DAILY_DRAW = { min: 0.8, max: 1 } as const;
/** The jitter never squeezes a working day below this. */
const MIN_DAY_SPAN_MINUTES = 180;

export interface DayShape {
  /** Inside the configured window, always. */
  startMinute: number;
  endMinute: number;
  /** True on a day this seat simply does not work. */
  resting: boolean;
  /** 0.8-1.0. What fraction of the day's ceiling to actually use. */
  draw: number;
}

export function dayShapeFor(seed: string, day: LocalDate, window: WorkWindow): DayShape {
  const random = seededRandom(canonicalPayloadHash({ seed, day: isoDate(day) }));
  const resting = random() < REST_DAY_ODDS;
  const draw = DAILY_DRAW.min + random() * (DAILY_DRAW.max - DAILY_DRAW.min);
  const room = Math.max(0, Math.floor((window.endMinute - window.startMinute - MIN_DAY_SPAN_MINUTES) / 2));
  const jitter = Math.min(DAY_EDGE_JITTER_MINUTES, room);
  return {
    startMinute: window.startMinute + Math.round(random() * jitter),
    endMinute: window.endMinute - Math.round(random() * jitter),
    resting,
    draw
  };
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function isoDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/**
 * mulberry32, seeded from the plan's payload hash.
 *
 * A named, fixed, 32-bit generator rather than anything the platform supplies:
 * the requirement is that the same inputs produce the same plan on every
 * machine and every Node version, and `Math.random()` guarantees the opposite.
 */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Seconds-of-day for `count` actions inside the seat's own working window.
 *
 * Evenly spread with jitter, NOT a randomised burst. 1.4 asks for two things
 * that sound like one -- "randomised 30-120s gaps" and "never a 2-hour block"
 * -- and only the spread satisfies both: eighteen actions at 30-120s gaps is
 * twenty minutes of machine-gun activity, which is the block. So the grid
 * spacing dominates, ACTION_GAP_SECONDS.max is the headroom reserved around
 * each grid point for jitter, and ACTION_GAP_SECONDS.min is the floor two
 * slots can never come closer than.
 *
 * `random` is consumed a fixed two draws per slot regardless of which branch
 * is taken, so the sequence cannot desynchronise between runs.
 */
function spreadWithinWorkingHours(count: number, random: () => number, earliestSecond: number, window: WorkWindow): number[] {
  if (count <= 0) return [];
  const windowStart = Math.max(window.startMinute * 60, earliestSecond);
  const windowEnd = window.endMinute * 60;
  const span = Math.max(0, windowEnd - windowStart);

  /**
   * How many slots this window can actually hold, spaced at least
   * `ACTION_GAP_SECONDS.max` apart in the worst case.
   *
   * WITHOUT THIS, a `count` that does not fit -- a same-day plan generated
   * late in the window is the normal way to reach one -- ran the loop below
   * anyway: `cursor = Math.min(at, windowEnd - 1)` clamped every slot past
   * the window's true capacity to the SAME second, `windowEnd - 1`. That is
   * several automated actions at one literal instant, a harder detection
   * signature than the "twenty minutes of machine-gun activity" this
   * function exists to avoid (see the comment above). Bounding by the
   * MAXIMUM gap rather than the minimum is deliberate conservatism: the
   * grid-plus-jitter placement below only needs `ACTION_GAP_SECONDS.min`
   * between slots when there is room to spare, but under `random()`'s worst
   * draw two slots can be up to `ACTION_GAP_SECONDS.max` apart, so that is
   * the bound capacity must respect for the loop to never need to clamp.
   */
  const capacity = span <= 0 ? 0 : Math.floor(span / ACTION_GAP_SECONDS.max) + 1;
  const scheduled = Math.min(count, capacity);
  if (scheduled <= 0) return [];

  const spacing = span / scheduled;
  const jitterRoom = Math.max(0, spacing - ACTION_GAP_SECONDS.max);

  const seconds: number[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scheduled; index += 1) {
    const target = windowStart + index * spacing + random() * jitterRoom;
    const gap = ACTION_GAP_SECONDS.min + random() * (ACTION_GAP_SECONDS.max - ACTION_GAP_SECONDS.min);
    const at = index === 0 ? target : Math.max(target, cursor + gap);
    cursor = Math.min(at, windowEnd - 1);
    seconds.push(Math.round(cursor));
  }
  return seconds;
}

function sumOfLast(values: readonly number[], count: number): number {
  return values.slice(Math.max(0, values.length - count)).reduce((total, value) => total + value, 0);
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
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const bucketDate = addLocalDays(todayLocal, -(history.length - 1 - index));
    if (weekdayVolumeFactor(window, weekdayOf(bucketDate)) === 0) continue;
    return history[index];
  }
  return 0;
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
    reasons.push('No LinkedIn seat is configured for this workspace, so there is nothing to pace. Add one with a label, a timezone, and the date the account was opened.');
    return { seatKey, slots: [], reasons, ceilingsApplied };
  }

  const posture = effectivePosture(seat, now);
  if (posture === 'paused') {
    ceilingsApplied.push('seat-paused');
    reasons.push(`Seat '${seat.label}' is paused${seat.pausedReason ? `: ${seat.pausedReason}` : ''}. Nothing is scheduled while it is paused.`);
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
  if (dropped > 0) reasons.push(`${dropped} empty or repeated target(s) were dropped; one target gets one slot.`);

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
   * Passive kinds skip the multiplier -- 1.4's week 1 is "passive only", so
   * views ARE the warm-up rather than something it suppresses. Zeroing them
   * would leave a new seat inert for seven days and then acting, which is the
   * "slide and spike" shape this engine exists to avoid producing.
   */
  const passive = isPassiveKind(input.kind);
  const multiplier = warmupMultiplierFor(input.kind, warmupWeek);
  const operatorLimit = seatOperatorLimit(seat, input.kind);
  const dailyCeiling = effectiveDailyCeiling(band.perDay, operatorLimit, seat.safetyBandOverride);
  const baseDaily = Math.floor(dailyCeiling * multiplier);
  reasons.push(
    `Seat '${seat.label}' is ${posture}, warm-up week ${warmupWeek}: ${dailyCeiling} ${input.kind}/day x ${multiplier} = ${baseDaily}/day before smoothing.`
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
      `This account is set to use your own daily limits instead of Trevra's safety bands, so ${operatorLimit} ${input.kind}(s)/day binds rather than the researched ${band.perDay}/day. Every other ceiling -- the warm-up ramp, the rolling 7-day and 30-day windows, and the day-over-day variance clamp -- still applies.`
    );
  }
  reasons.push(
    `Slots are placed between ${formatMinuteOfDay(window.startMinute)} and ${formatMinuteOfDay(window.endMinute)} in ${seat.timezone}, on weekday(s) ${window.days.join(', ')} -- this account's configured working window, which is the same window the safety gate refuses a slot outside of.`
  );
  if (passive && warmupWeek <= WARMUP_WEEKS) {
    reasons.push(`${input.kind} is passive activity, so it runs at the full ${posture} band during warm-up instead of being ramped. Every other ceiling still applies.`);
  }
  if (multiplier < 1) ceilingsApplied.push('warmup-multiplier');
  if (posture === 'cooldown') {
    ceilingsApplied.push('cooldown-band');
    reasons.push('Seat is in cooldown, so the conservative warm-up band applies instead of the steady one.');
  }
  if (seat.activatedAt === null) {
    // Fail closed. A seat with no activation instant is one this schema never
    // wrote, so it is paced as brand new rather than as trusted.
    reasons.push('This seat has no activation timestamp, so it is paced as a week-1 seat. The ramp clock starts on the seat\'s first write and no edit resets it.');
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

  // --- Step 3 seed: the most recent BUSINESS day's actual count. ---
  let previousActual = previousBusinessDayCount(history, todayLocal, window);
  reasons.push(`Previous business day carried ${previousActual} ${input.kind}(s); the next day may not exceed it by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%.`);

  const seed = canonicalPayloadHash({
    workspaceId: input.workspaceId,
    seatKey,
    kind: input.kind,
    targets,
    horizonDays: input.horizonDays,
    startDate: isoDate(startDate),
    timezone: seat.timezone
  });
  const random = seededRandom(seed);

  const horizon = Math.max(1, Math.min(Math.trunc(input.horizonDays), MAX_HORIZON_DAYS));
  const slots: PacingSlot[] = [];
  let assigned = 0;
  let deltaClamped = false;
  let weekendSkipped = false;
  let offDaySkipped = false;
  let scanDayClamped = false;
  let weeklyClamped = false;
  let monthlyClamped = false;
  let backlogClamped = false;
  let windowCapacityClamped = false;
  let restDayTaken = false;
  let dailyDrawApplied = false;

  for (let dayIndex = 0; dayIndex < horizon && assigned < targets.length; dayIndex += 1) {
    const day = addLocalDays(startDate, dayIndex);
    const weekday = weekdayOf(day);

    // --- Step 2b: what KIND of day this is. See `dayShapeFor`. ---
    //
    // One seed for the seat and the date, deliberately without the kind: every
    // kind planned for this seat on this day must agree about when the day
    // starts, when it ends, and whether it happens at all. A day where invites
    // rest and profile views do not is not a day off.
    const shape = shapeDay(`${input.workspaceId}:${seatKey}`, day, window);
    const dayWindow: WorkWindow = { days: window.days, startMinute: shape.startMinute, endMinute: shape.endMinute };
    const dayCeiling = shape.resting ? 0 : Math.floor(baseDaily * shape.draw);
    if (shape.resting) restDayTaken = true;
    else if (dayCeiling < baseDaily) dailyDrawApplied = true;

    // --- Step 3: variance smoothing against the previous day's ACTUAL. ---
    const deltaCeiling = Math.max(previousActual + MIN_RAMP_STEP, Math.floor(previousActual * (1 + MAX_DAY_OVER_DAY_DELTA)));
    let allowed = Math.min(dayCeiling, deltaCeiling);
    if (deltaCeiling < baseDaily) deltaClamped = true;

    // --- Step 4: acceptance-rate throttle. Halves, never zeroes. ---
    if (throttled) allowed = Math.max(allowed > 0 ? 1 : 0, Math.floor(allowed * ACCEPTANCE_THROTTLE_FACTOR));

    // --- Step 5: the seat's configured days, then the Tue/Wed scan rule. ---
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
    if (dayFactor > 0 && ENFORCEMENT_SCAN_WEEKDAYS.includes(weekday)) {
      // Not skipped -- capped. A day's MAXIMUM is never scheduled on a scan
      // day; skipping two of five working days would create its own sawtooth.
      // Measured against the EFFECTIVE ceiling, because that is what "a day's
      // maximum" means for this seat: an operator capped at 5 whose band is 18
      // would otherwise see this rule do nothing at all.
      const capped = Math.min(allowed, Math.max(0, dailyCeiling - 1));
      if (capped < allowed) scanDayClamped = true;
      allowed = capped;
    }

    // Rolling weekly and monthly budgets. The band's perWeek/perMonth are
    // ceilings over a WINDOW, so they are charged against the ledger's real
    // history plus everything this plan has already scheduled -- otherwise
    // 3 InMails a day for a fortnight quietly clears a 50-a-month quota.
    if (band.perWeek !== undefined) {
      const spentThisWeek = sumOfLast(timeline, 6);
      const capped = Math.min(allowed, Math.max(0, band.perWeek - spentThisWeek - outstandingInvites));
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

    // --- Step 6: spread inside the working window, seat-local, seeded jitter. ---
    const earliest = dayIndex === 0 && startsToday ? nowSecondOfDay : 0;
    const secondsOfDay = spreadWithinWorkingHours(count, random, earliest, dayWindow);
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
    if (dayFactor > 0) previousActual = secondsOfDay.length;
  }

  // --- Step 7: report every ceiling that bound, not just the first. ---
  if (deltaClamped) {
    ceilingsApplied.push('day-over-day-delta');
    reasons.push(`Volume is ramped rather than started at ${baseDaily}/day: no day may exceed the one before it by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%, which is what keeps this seat off the "slide and spike" signature.`);
  }
  if (restDayTaken) {
    reasons.push(
      `At least one working day in this horizon is left empty on purpose (about ${(REST_DAY_ODDS * 100).toFixed(0)}% of them are). Nobody prospects every single configured day, and a seat that does is a scheduler wearing a person's hours.`
    );
  }
  if (dailyDrawApplied) {
    reasons.push(
      `Each day takes ${(DAILY_DRAW.min * 100).toFixed(0)}-100% of its ceiling rather than running to it, and its start and end move by up to ${DAY_EDGE_JITTER_MINUTES} minutes inside the configured window. Both are seeded from the seat and the date, so the same day always plans the same way.`
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
  if (scanDayClamped) {
    ceilingsApplied.push('enforcement-scan-day');
    reasons.push('Tuesdays and Wednesdays never carry a day\'s maximum -- reported enforcement scans cluster there.');
  }
  if (weeklyClamped) {
    ceilingsApplied.push('weekly-band');
    reasons.push(`The rolling 7-day ceiling of ${band.perWeek} ${input.kind}(s) bound on at least one day.`);
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
    reasons.push(`${targets.length - assigned} of ${targets.length} target(s) do not fit inside ${horizon} day(s) at this pace and are not scheduled. Extend the horizon or split the campaign.`);
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
export async function resolveSkillSeatKey(db: Db, workspaceId: string, seatKey: string | undefined): Promise<string> {
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
      'Schedule LinkedIn actions for one seat across a horizon: warm-up ramp from account age, day-over-day variance smoothing against the real ledger, acceptance-rate throttle, weekend and enforcement-scan rules, and a deterministic spread inside the seat\'s own configured working days and hours.',
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
