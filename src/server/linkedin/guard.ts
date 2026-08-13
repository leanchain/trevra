import { z } from 'zod';
import { getChannel } from '../channels/registry.js';
import type { Db } from '../db.js';
import type { Skill, SkillContext } from '../skills/types.js';
import {
  acceptanceRate,
  countActionsInWindow,
  countActionKindsInWindow,
  countPendingInvites,
  dailyCountsForLastNDays,
  hasTarget,
  type SeatRef
} from './actions.js';
import {
  ACCEPTANCE_WINDOW_DAYS,
  BUSINESS_HOURS,
  ENFORCEMENT_SCAN_WEEKDAYS,
  INMAIL_MONTHLY_QUOTA,
  MAX_DAY_OVER_DAY_DELTA,
  MAX_OUTSTANDING_INVITES,
  MIN_ACCEPTANCE_RATE,
  MIN_RAMP_STEP,
  PACED_KIND_VALUES,
  WARMUP_WEEKS,
  WEEKEND_FACTOR,
  bandFor,
  isPassiveKind,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import { isWeekend, localDateOf, previousBusinessDayCount, weekdayOf } from './pacing.js';
import { OWNER_SEAT_KEY, effectivePosture, getSeat, warmupWeekOf } from './seats.js';

/**
 * The LinkedIn safety gate, mirroring `outreach/safety.ts` `evaluateSafety()`.
 *
 * Same contract, and it is the contract that matters: EVERY CHECK ALWAYS RUNS.
 * Nothing short-circuits on the first failure, so an operator sees the whole
 * blocker list at once instead of fixing one and discovering the next on the
 * following run. `reason` still reports the first failure, so a caller that
 * only wants a yes/no gets the same fail-fast answer as before.
 *
 * The gate is the pre-flight for one action. The pacing engine decides WHEN a
 * seat may act; this decides whether a specific action, at a specific instant,
 * against a specific target, is still permitted at the moment it is about to
 * happen. Both are needed: a plan approved on Monday can be stale by Thursday
 * because a human did things by hand in between, and the ledger is what knows.
 */

export type LinkedInCheckName =
  | 'seat-configured'
  | 'seat-paused'
  | 'warmup-ceiling'
  | 'rolling-24h'
  | 'rolling-7d'
  | 'rolling-30d'
  | 'day-over-day-delta'
  | 'acceptance-rate'
  | 'business-hours'
  | 'weekend'
  | 'inmail-monthly-quota'
  | 'pending-invite-backlog'
  | 'duplicate-target';

/** The same names as a tuple, so the skill's output schema cannot drift from the union. */
export const LINKEDIN_CHECK_NAMES = [
  'seat-configured',
  'seat-paused',
  'warmup-ceiling',
  'rolling-24h',
  'rolling-7d',
  'rolling-30d',
  'day-over-day-delta',
  'acceptance-rate',
  'business-hours',
  'weekend',
  'inmail-monthly-quota',
  'pending-invite-backlog',
  'duplicate-target'
] as const satisfies readonly LinkedInCheckName[];

export interface LinkedInSafetyCheck {
  check: LinkedInCheckName;
  passed: boolean;
  /** Written for an operator deciding what to do next, not for a log grep. */
  detail: string;
}

export interface LinkedInSafetyVerdict {
  allowed: boolean;
  /** The first failing check, in evaluation order. Null when all passed. */
  reason: string | null;
  checks: LinkedInSafetyCheck[];
  /**
   * Straight from the channel adapter, exactly as `evaluateSafety` reports it.
   * LinkedIn is `prepare-only` and this verdict says so on every call: an
   * allowed action means "this is safe for a human to perform in their own
   * account", never "Trevra will perform it".
   */
  automationMode: 'api-publish' | 'prepare-only' | 'disabled' | 'unknown';
  automationReason: string;
}

export interface LinkedInSafetyInput {
  workspaceId: string;
  seatKey?: string;
  kind: PacedKind;
  /** Opaque handle or profile URL, as supplied by the operator. */
  targetRef: string;
  /** ISO-8601 instant the action is scheduled for. */
  plannedFor: string;
}

export interface LinkedInSafetyOptions {
  /**
   * A `linkedin_actions.id` the `duplicate-target` check must ignore.
   *
   * For the caller that CLAIMS its ledger row and then re-runs this gate
   * immediately before executing it: the claimed row is in the ledger, so
   * without this the check finds the action under evaluation and fails on it,
   * every time. A row cannot be its own duplicate.
   *
   * It excludes exactly one row, by primary key. Any OTHER non-skipped row
   * against the same target still fails the check, and no other check is
   * affected -- all twelve of them still see the whole ledger. That is the
   * difference between this and the alternative a caller might reach for,
   * which is to run the gate and then discount a failing check afterwards:
   * that puts "ignore the guard under conditions X" in the caller, where the
   * next edit widens X. The gate stays authoritative; it is simply told which
   * row is the subject of the question.
   *
   * Absent means absent: omitting it preserves the export-mode semantics
   * exactly, and it is deliberately NOT on the skill's input schema, so an
   * approved playbook payload cannot name a row to excuse.
   */
  excludeActionId?: string | null;
}

function automationOfLinkedIn(): Pick<LinkedInSafetyVerdict, 'automationMode' | 'automationReason'> {
  const channel = getChannel('linkedin');
  if (!channel) {
    return {
      automationMode: 'unknown',
      automationReason: "No channel adapter is registered for 'linkedin', so Trevra has no policy statement about acting there. Treated as manual-only."
    };
  }
  return { automationMode: channel.automation.mode, automationReason: channel.automation.reason };
}

/** How much history the day-over-day seed and the 30-day window need. */
const HISTORY_DAYS = 30;

/**
 * Run every gate against one proposed action.
 *
 * A workspace with NO seat still gets all thirteen checks, evaluated against the
 * most conservative assumptions available (warm-up band, week 1, UTC). The
 * alternative -- returning early with one blocker -- is the short-circuit this
 * module exists to avoid, and it would hide the fact that the action is also
 * a duplicate, also outside business hours, and also over the InMail quota.
 */
export async function evaluateLinkedInSafety(
  db: Db,
  input: LinkedInSafetyInput,
  now: Date,
  options: LinkedInSafetyOptions = {}
): Promise<LinkedInSafetyVerdict> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const seatRef: SeatRef = { workspaceId: input.workspaceId, seatKey };
  const checks: LinkedInSafetyCheck[] = [];

  const seat = await getSeat(db, input.workspaceId, seatKey);
  const posture = seat ? effectivePosture(seat, now) : 'warmup';
  const timezone = seat?.timezone ?? 'UTC';
  const warmupWeek = seat ? warmupWeekOf(seat.activatedAt, now) : 1;
  const band = bandFor(input.kind, posture === 'steady' ? 'steady' : 'warmup');

  checks.push({
    check: 'seat-configured',
    passed: seat !== undefined,
    detail: seat
      ? `Seat '${seat.label}' (${timezone}), posture ${posture}.`
      : 'No LinkedIn seat is configured for this workspace. Every ceiling below is evaluated against a brand-new week-1 account in UTC, which is the safest thing to assume when nobody has said otherwise.'
  });

  checks.push({
    check: 'seat-paused',
    passed: posture !== 'paused',
    detail:
      posture === 'paused'
        ? `Seat is paused${seat?.pausedReason ? `: ${seat.pausedReason}` : ''}. Resume it before acting.`
        : `Seat posture is ${posture}, not paused.`
  });

  const used24 = await countActionsInWindow(db, seatRef, input.kind, 24, now);
  const messageKinds = ['dm', 'reply', 'inmail'] as const;
  const isMessage = messageKinds.includes(input.kind as (typeof messageKinds)[number]);
  const operatorLimit = seat
    ? input.kind === 'invite' ? seat.dailyInviteLimit
      : isMessage ? seat.dailyMessageLimit
        : input.kind === 'profile_view' ? seat.dailyProfileViewLimit
          : input.kind === 'follow' ? seat.dailyFollowLimit
            : null
    : null;
  const operatorUsed24 = operatorLimit === null
    ? used24
    : isMessage
      ? await countActionKindsInWindow(db, seatRef, [...messageKinds], 24, now)
      : used24;
  const used7d = await countActionsInWindow(db, seatRef, input.kind, 24 * 7, now);
  const used30d = await countActionsInWindow(db, seatRef, input.kind, 24 * 30, now);

  // Passive kinds skip the ramp -- see PASSIVE_KINDS. They are still checked
  // here, just against the full band: only the multiplier is bypassed.
  const multiplier = warmupMultiplierFor(input.kind, warmupWeek);
  const warmupCeiling = Math.floor(band.perDay * multiplier);
  checks.push({
    check: 'warmup-ceiling',
    passed: used24 + 1 <= warmupCeiling,
    detail:
      warmupCeiling === 0
        ? `Warm-up week ${warmupWeek} permits no ${input.kind}s at all (${band.perDay}/day x ${multiplier}). ${seat === undefined ? 'No seat is configured, so this is paced as a brand-new one; detect the seat to start its ramp.' : 'Wait for the ramp. It is keyed to how long this seat has been automated, not to the account\'s age, so there is nothing to declare that would lift it.'}`
        : isPassiveKind(input.kind) && warmupWeek <= WARMUP_WEEKS
          ? `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h. Passive activity is not ramped during warm-up; it is what the warm-up consists of.`
          : `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h (warm-up week ${warmupWeek}: ${band.perDay}/day x ${multiplier}).`
  });

  const effectiveDailyLimit = operatorLimit === null ? band.perDay : Math.min(band.perDay, operatorLimit);
  checks.push({
    check: 'rolling-24h',
    passed: used24 + 1 <= band.perDay && operatorUsed24 + 1 <= effectiveDailyLimit,
    detail: operatorLimit === null
      ? `${used24} of ${band.perDay} ${input.kind}s used in the last 24 hours (${posture} band).`
      : `${operatorUsed24} of ${effectiveDailyLimit} account-level ${isMessage ? 'messages' : `${input.kind}s`} used in the last 24 hours; the effective ceiling is the stricter of Trevra's ${band.perDay}/day safety band and the operator setting ${operatorLimit}/day.`
  });

  checks.push({
    check: 'rolling-7d',
    passed: band.perWeek === undefined || used7d + 1 <= band.perWeek,
    detail:
      band.perWeek === undefined
        ? `No 7-day ceiling is published for ${input.kind}, so none is invented here.`
        : `${used7d} of ${band.perWeek} ${input.kind}s used in the last 7 days (${posture} band).`
  });

  checks.push({
    check: 'rolling-30d',
    passed: band.perMonth === undefined || used30d + 1 <= band.perMonth,
    detail:
      band.perMonth === undefined
        ? `No 30-day ceiling is published for ${input.kind}, so none is invented here.`
        : `${used30d} of ${band.perMonth} ${input.kind}s used in the last 30 days (${posture} band).`
  });

  // The anti-"slide and spike" check, and the reason this module exists at all
  // (plan 1.3): a day-over-day jump is the signal, not the daily total.
  const history = await dailyCountsForLastNDays(db, seatRef, input.kind, HISTORY_DAYS, now);
  const previous = previousBusinessDayCount(history, localDateOf(now, timezone));
  const deltaCeiling = Math.max(previous + MIN_RAMP_STEP, Math.floor(previous * (1 + MAX_DAY_OVER_DAY_DELTA)));
  checks.push({
    check: 'day-over-day-delta',
    passed: used24 + 1 <= deltaCeiling,
    detail: `Previous business day carried ${previous} ${input.kind}(s), so today's ceiling is ${deltaCeiling} (+${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%); ${used24} used so far.`
  });

  const acceptance = await acceptanceRate(db, seatRef, ACCEPTANCE_WINDOW_DAYS, now);
  checks.push({
    check: 'acceptance-rate',
    passed: acceptance.rate === null || acceptance.rate >= MIN_ACCEPTANCE_RATE,
    detail:
      acceptance.rate === null
        ? `No invite has been accepted or declined in the last ${ACCEPTANCE_WINDOW_DAYS} days, so there is no rate to judge. An absent signal is not a bad one.`
        : `${ACCEPTANCE_WINDOW_DAYS}-day invite acceptance is ${(acceptance.rate * 100).toFixed(0)}% (${acceptance.accepted} of ${acceptance.decided} decided); floor is ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}%.`
  });

  const plannedAt = new Date(input.plannedFor);
  const parsed = !Number.isNaN(plannedAt.getTime());
  const local = parsed ? localDateOf(plannedAt, timezone) : null;

  const weekday = local === null ? null : weekdayOf(local);
  const minuteOfDay = local === null ? null : local.hour * 60 + local.minute;
  const configuredDays = seat?.workingDays ?? [1, 2, 3, 4, 5];
  const configuredStart = seat?.workStartMinute ?? BUSINESS_HOURS.start * 60;
  const configuredEnd = seat?.workEndMinute ?? BUSINESS_HOURS.end * 60;
  const insideConfiguredWindow =
    local !== null && weekday !== null && configuredDays.includes(weekday)
    && minuteOfDay !== null && minuteOfDay >= configuredStart && minuteOfDay < configuredEnd;
  const hhmm = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  checks.push({
    check: 'business-hours',
    passed: insideConfiguredWindow,
    detail:
      local === null
        ? `'${input.plannedFor}' is not a parseable instant, so it cannot be placed inside a working-hours window.`
        : `Scheduled for ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} in ${timezone}; this account works on weekday(s) ${configuredDays.join(',') || 'none'} between ${hhmm(configuredStart)} and ${hhmm(configuredEnd)}.`
  });
  const onWeekend = weekday !== null && isWeekend(weekday);
  checks.push({
    check: 'weekend',
    // WEEKEND_FACTOR is the policy; this check just reads it. Raise the factor
    // above zero and weekends stop being blocked, with no edit here.
    passed: local !== null && (!onWeekend || WEEKEND_FACTOR > 0),
    detail:
      local === null
        ? `'${input.plannedFor}' is not a parseable instant, so its weekday is unknown.`
        : onWeekend
          ? `Scheduled on a weekend in ${timezone}, and the weekend factor is ${WEEKEND_FACTOR}.`
          : ENFORCEMENT_SCAN_WEEKDAYS.includes(weekday as number)
            ? `Scheduled on a weekday in ${timezone}. It is a reported enforcement-scan day, so the pacing engine keeps it below the daily maximum.`
            : `Scheduled on a weekday in ${timezone}.`
  });

  // Separate from rolling-30d on purpose. That check enforces whatever band we
  // chose; this one enforces LinkedIn's own published quota, which is a HARD
  // FACT and does not move with posture, warm-up, or anybody's opinion.
  checks.push({
    check: 'inmail-monthly-quota',
    passed: input.kind !== 'inmail' || used30d + 1 <= INMAIL_MONTHLY_QUOTA,
    detail:
      input.kind === 'inmail'
        ? `${used30d} of LinkedIn's ${INMAIL_MONTHLY_QUOTA} InMails used in the last 30 days. This one is LinkedIn's published quota, not a pacing preference.`
        : `The InMail quota applies to InMails; this is a ${input.kind}.`
  });

  // THE BACKLOG, and the one ceiling in this file that is not about rate.
  //
  // Every other window here counts by `recorded_at`, so an invite that went out
  // four months ago and has never been answered is invisible to all of them --
  // while on LinkedIn's side it is still consuming the seat's invite capacity
  // and is still a permanent zero in the acceptance numerator. That is the gap
  // withdrawal exists to close, and without this check closing it returned no
  // headroom in Trevra's own arithmetic: an operator could withdraw two hundred
  // stale invites and see the plan produce exactly the same schedule.
  //
  // Scoped to invites because that is the only kind that can be outstanding.
  // Nobody leaves a profile view pending.
  const pendingInvites = await countPendingInvites(db, seatRef);
  checks.push({
    check: 'pending-invite-backlog',
    passed: input.kind !== 'invite' || pendingInvites + 1 <= MAX_OUTSTANDING_INVITES,
    detail:
      input.kind === 'invite'
        ? `${pendingInvites} of ${MAX_OUTSTANDING_INVITES} outstanding invites are still awaiting an answer. Withdrawing the stale ones is what returns capacity here; sending more does not. The ceiling is REPORTED, from the same 1.4 figure that puts acceptance at 25-30% above 100 invites a week.`
        : `The outstanding-invite ceiling applies to invites; this is a ${input.kind}. ${pendingInvites} invite(s) are pending for this seat.`
  });

  const excludeActionId = options.excludeActionId ?? null;
  const duplicate = await hasTarget(db, seatRef, input.kind, input.targetRef, excludeActionId);
  const subject = excludeActionId ? ' besides the one being evaluated' : '';
  checks.push({
    check: 'duplicate-target',
    passed: !duplicate,
    detail: duplicate
      ? `This seat already has a ${input.kind} logged against '${input.targetRef}'${subject}. A second one is the thing the ledger's replay guard exists to prevent.`
      : `No prior ${input.kind} against '${input.targetRef}'${subject}.`
  });

  const failed = checks.find((entry) => !entry.passed);
  return {
    allowed: failed === undefined,
    reason: failed ? `${failed.check}: ${failed.detail}` : null,
    checks,
    ...automationOfLinkedIn()
  };
}

const inputSchema = z.object({
  seatKey: z.string().min(1).max(64).default(OWNER_SEAT_KEY),
  kind: z.enum(PACED_KIND_VALUES),
  targetRef: z.string().min(1).max(500),
  plannedFor: z.string().min(1),
  /**
   * Fail the run when the gate says no, instead of reporting it. Same reason
   * `gtm.outreach-guard` has it: the playbook engine's steps are an
   * unconditional DAG, so a verdict that is merely REPORTED cannot stop the
   * chain, and a gate that cannot stop anything is decoration.
   */
  requireAllowed: z.boolean().default(false)
});

const outputSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  checks: z.array(
    z.object({
      check: z.enum(LINKEDIN_CHECK_NAMES),
      passed: z.boolean(),
      detail: z.string()
    })
  ),
  automationMode: z.enum(['api-publish', 'prepare-only', 'disabled', 'unknown']),
  automationReason: z.string()
});

type LinkedInGuardInput = z.infer<typeof inputSchema>;

export const linkedinGuardSkill: Skill<LinkedInGuardInput, LinkedInSafetyVerdict> = {
  manifest: {
    id: 'gtm.linkedin-guard',
    name: 'LinkedIn seat safety gate',
    version: '1.0.0',
    description:
      'Check one proposed LinkedIn action against every per-seat ceiling at once: pause state, warm-up week, rolling 24h/7d/30d windows, day-over-day variance, acceptance rate, business hours, weekends, the published InMail quota, the outstanding-invite backlog, and duplicate targets.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx: SkillContext) {
    const verdict = await evaluateLinkedInSafety(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        seatKey: input.seatKey,
        kind: input.kind as PacedKind,
        targetRef: input.targetRef,
        plannedFor: input.plannedFor
      },
      ctx.now()
    );
    if (input.requireAllowed && !verdict.allowed) {
      throw new Error(
        `LinkedIn action blocked for ${input.targetRef} -- ${verdict.reason}. Failing checks: ${verdict.checks
          .filter((entry) => !entry.passed)
          .map((entry) => entry.check)
          .join(', ')}.`
      );
    }
    return verdict;
  }
};
