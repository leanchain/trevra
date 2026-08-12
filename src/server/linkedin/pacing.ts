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
  isPassiveKind,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import { OWNER_SEAT_KEY, effectivePosture, getSeat, warmupWeekOf } from './seats.js';

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
 * Seconds-of-day for `count` actions inside the business-hours window.
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
function spreadWithinBusinessHours(count: number, random: () => number, earliestSecond: number): number[] {
  if (count <= 0) return [];
  const windowStart = Math.max(BUSINESS_HOURS.start * 3600, earliestSecond);
  const windowEnd = BUSINESS_HOURS.end * 3600;
  const span = Math.max(0, windowEnd - windowStart);
  const spacing = span / count;
  const jitterRoom = Math.max(0, spacing - ACTION_GAP_SECONDS.max);

  const seconds: number[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
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
 * Weekend buckets are skipped, also on purpose. WEEKEND_FACTOR is 0, so a
 * Sunday is 0 by design, and seeding Monday's clamp from it would reset the
 * ramp every single week -- manufacturing the exact weekly sawtooth plan 1.3
 * describes as the thing that gets accounts restricted. Shared with `guard.ts`
 * so the plan and the gate can never disagree about what "yesterday" was.
 */
export function previousBusinessDayCount(history: readonly number[], todayLocal: LocalDate): number {
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const bucketDate = addLocalDays(todayLocal, -(history.length - 1 - index));
    if (isWeekend(weekdayOf(bucketDate))) continue;
    return history[index];
  }
  return 0;
}

/**
 * Plan `targets` for one seat and one kind.
 *
 * The seven steps of plan 4-phase-2, in order, each marked below.
 */
export async function planPacing(db: Db, input: PacingInput, now: Date): Promise<PacingPlan> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const seatRef: SeatRef = { workspaceId: input.workspaceId, seatKey };
  const reasons: string[] = [];
  const ceilingsApplied: string[] = [];

  // --- Step 1: posture, and the warm-up week derived from account age. ---
  const seat = await getSeat(db, input.workspaceId);
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

  // --- Step 2: base daily volume = band ceiling x warm-up multiplier. ---
  //
  // Passive kinds skip the multiplier -- 1.4's week 1 is "passive only", so
  // views ARE the warm-up rather than something it suppresses. Zeroing them
  // would leave a new seat inert for seven days and then acting, which is the
  // "slide and spike" shape this engine exists to avoid producing.
  const passive = isPassiveKind(input.kind);
  const multiplier = warmupMultiplierFor(input.kind, warmupWeek);
  const baseDaily = Math.floor(band.perDay * multiplier);
  reasons.push(
    `Seat '${seat.label}' is ${posture}, warm-up week ${warmupWeek}: ${band.perDay} ${input.kind}/day x ${multiplier} = ${baseDaily}/day before smoothing.`
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
  const startsToday = nowSecondOfDay < BUSINESS_HOURS.end * 3600;
  const startDate = startsToday ? todayLocal : addLocalDays(todayLocal, 1);

  // --- Step 3 seed: the most recent BUSINESS day's actual count. ---
  let previousActual = previousBusinessDayCount(history, todayLocal);
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
  let scanDayClamped = false;
  let weeklyClamped = false;
  let monthlyClamped = false;
  let backlogClamped = false;

  for (let dayIndex = 0; dayIndex < horizon && assigned < targets.length; dayIndex += 1) {
    const day = addLocalDays(startDate, dayIndex);
    const weekday = weekdayOf(day);

    // --- Step 3: variance smoothing against the previous day's ACTUAL. ---
    const deltaCeiling = Math.max(previousActual + MIN_RAMP_STEP, Math.floor(previousActual * (1 + MAX_DAY_OVER_DAY_DELTA)));
    let allowed = Math.min(baseDaily, deltaCeiling);
    if (deltaCeiling < baseDaily) deltaClamped = true;

    // --- Step 4: acceptance-rate throttle. Halves, never zeroes. ---
    if (throttled) allowed = Math.max(allowed > 0 ? 1 : 0, Math.floor(allowed * ACCEPTANCE_THROTTLE_FACTOR));

    // --- Step 5: weekend factor, then the Tue/Wed enforcement-scan rule. ---
    const weekend = isWeekend(weekday);
    if (weekend) {
      allowed = Math.floor(allowed * WEEKEND_FACTOR);
      weekendSkipped = true;
    } else if (ENFORCEMENT_SCAN_WEEKDAYS.includes(weekday)) {
      // Not skipped -- capped. A day's MAXIMUM is never scheduled on a scan
      // day; skipping two of five working days would create its own sawtooth.
      const capped = Math.min(allowed, Math.max(0, band.perDay - 1));
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

    // --- Step 6: spread inside business hours, seat-local, seeded jitter. ---
    const earliest = dayIndex === 0 && startsToday ? nowSecondOfDay : 0;
    for (const secondOfDay of spreadWithinBusinessHours(count, random, earliest)) {
      slots.push({
        plannedFor: zonedToUtc(day, secondOfDay, seat.timezone).toISOString(),
        kind: input.kind,
        targetRef: targets[assigned]
      });
      assigned += 1;
    }

    timeline.push(count);
    if (!weekend) previousActual = count;
  }

  // --- Step 7: report every ceiling that bound, not just the first. ---
  if (deltaClamped) {
    ceilingsApplied.push('day-over-day-delta');
    reasons.push(`Volume is ramped rather than started at ${baseDaily}/day: no day may exceed the one before it by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%, which is what keeps this seat off the "slide and spike" signature.`);
  }
  if (weekendSkipped) {
    ceilingsApplied.push('weekend');
    reasons.push('Weekend days are left empty; the ramp resumes from the last business day rather than from zero.');
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
  if (assigned < targets.length) {
    reasons.push(`${targets.length - assigned} of ${targets.length} target(s) do not fit inside ${horizon} day(s) at this pace and are not scheduled. Extend the horizon or split the campaign.`);
  }

  return { seatKey, slots, reasons, ceilingsApplied };
}

const kindSchema = z.enum(PACED_KIND_VALUES);

const inputSchema = z.object({
  seatKey: z.string().min(1).max(64).default(OWNER_SEAT_KEY),
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
      'Schedule LinkedIn actions for one seat across a horizon: warm-up ramp from account age, day-over-day variance smoothing against the real ledger, acceptance-rate throttle, weekend and enforcement-scan rules, and a deterministic spread inside the seat\'s business hours.',
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
        seatKey: input.seatKey,
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
