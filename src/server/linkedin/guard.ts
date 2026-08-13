import { z } from 'zod';
import { getChannel } from '../channels/registry.js';
import type { Db } from '../db.js';
import type { Skill, SkillContext } from '../skills/types.js';
import {
  acceptanceRate,
  countActionsInWindow,
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
import { OWNER_SEAT_KEY, effectivePosture, getSeat, warmupWeekOf, type LinkedInSeat } from './seats.js';

export type LinkedInCheckName =
  | 'seat-configured'
  | 'seat-paused'
  | 'operator-daily-limit'
  | 'operator-working-window'
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

export const LINKEDIN_CHECK_NAMES = [
  'seat-configured',
  'seat-paused',
  'operator-daily-limit',
  'operator-working-window',
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
  detail: string;
}

export interface LinkedInSafetyVerdict {
  allowed: boolean;
  reason: string | null;
  checks: LinkedInSafetyCheck[];
  automationMode: 'api-publish' | 'prepare-only' | 'disabled' | 'unknown';
  automationReason: string;
}

export interface LinkedInSafetyInput {
  workspaceId: string;
  seatKey?: string;
  kind: PacedKind;
  targetRef: string;
  plannedFor: string;
}

export interface LinkedInSafetyOptions {
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

const HISTORY_DAYS = 30;

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function operatorLimitFor(seat: LinkedInSeat | undefined, kind: PacedKind): number | null {
  if (!seat) return null;
  if (kind === 'invite') return seat.operatorLimits.invite;
  if (kind === 'dm' || kind === 'reply') return seat.operatorLimits.message;
  if (kind === 'profile_view') return seat.operatorLimits.profile_view;
  if (kind === 'follow') return seat.operatorLimits.follow;
  return null;
}

async function operatorUsed24h(db: Db, seat: SeatRef, kind: PacedKind, now: Date): Promise<number> {
  if (kind === 'dm' || kind === 'reply') {
    const [dms, replies] = await Promise.all([
      countActionsInWindow(db, seat, 'dm', 24, now),
      countActionsInWindow(db, seat, 'reply', 24, now)
    ]);
    return dms + replies;
  }
  return countActionsInWindow(db, seat, kind, 24, now);
}

export async function evaluateLinkedInSafety(
  db: Db,
  input: LinkedInSafetyInput,
  now: Date,
  options: LinkedInSafetyOptions = {}
): Promise<LinkedInSafetyVerdict> {
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const seatRef: SeatRef = { workspaceId: input.workspaceId, seatKey };
  const checks: LinkedInSafetyCheck[] = [];

  // This must be keyed by the account under evaluation. Falling back to the
  // owner row here would make a second account inherit the wrong timezone,
  // posture and limits while the ledger correctly counted the second account.
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
      : `No LinkedIn seat '${seatKey}' is configured for this workspace. Conservative week-1 limits in UTC apply.`
  });

  checks.push({
    check: 'seat-paused',
    passed: posture !== 'paused' && posture !== 'cooldown',
    detail: posture === 'paused' || posture === 'cooldown'
      ? `Seat is ${posture}${seat?.pausedReason ? `: ${seat.pausedReason}` : ''}. It cannot act until a human clears that state.`
      : `Seat posture is ${posture}, not paused or cooling down.`
  });

  const used24 = await countActionsInWindow(db, seatRef, input.kind, 24, now);
  const used7d = await countActionsInWindow(db, seatRef, input.kind, 24 * 7, now);
  const used30d = await countActionsInWindow(db, seatRef, input.kind, 24 * 30, now);
  const operatorLimit = operatorLimitFor(seat, input.kind);
  const operatorUsed = operatorLimit === null ? 0 : await operatorUsed24h(db, seatRef, input.kind, now);

  checks.push({
    check: 'operator-daily-limit',
    passed: operatorLimit === null || operatorUsed + 1 <= operatorLimit,
    detail: operatorLimit === null
      ? `No operator-configurable daily limit applies to ${input.kind}; the hard safety bands still apply.`
      : `${operatorUsed} of the operator's ${operatorLimit}/24h ${input.kind === 'dm' || input.kind === 'reply' ? 'message' : input.kind} limit are used. This setting can only make the hard safety gate stricter.`
  });

  const plannedAt = new Date(input.plannedFor);
  const parsed = !Number.isNaN(plannedAt.getTime());
  const local = parsed ? localDateOf(plannedAt, timezone) : null;
  const weekday = local === null ? null : weekdayOf(local);
  const operatorMinute = local === null ? null : local.hour * 60 + local.minute;
  const operatorWindow = seat
    ? local !== null
      && weekday !== null
      && seat.workingDays.includes(weekday)
      && operatorMinute !== null
      && operatorMinute >= clockMinutes(seat.workingStart)
      && operatorMinute < clockMinutes(seat.workingEnd)
    : false;

  checks.push({
    check: 'operator-working-window',
    passed: seat !== undefined && operatorWindow,
    detail: !seat
      ? 'No seat exists, so no operator working window can be established.'
      : local === null || weekday === null
        ? `'${input.plannedFor}' is not a parseable instant.`
        : `Scheduled for ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} on weekday ${weekday} in ${timezone}; account window is ${seat.workingStart}-${seat.workingEnd} on days ${seat.workingDays.join(',')}.`
  });

  const multiplier = warmupMultiplierFor(input.kind, warmupWeek);
  const warmupCeiling = Math.floor(band.perDay * multiplier);
  checks.push({
    check: 'warmup-ceiling',
    passed: used24 + 1 <= warmupCeiling,
    detail: warmupCeiling === 0
      ? `Warm-up week ${warmupWeek} permits no ${input.kind}s (${band.perDay}/day x ${multiplier}).`
      : isPassiveKind(input.kind) && warmupWeek <= WARMUP_WEEKS
        ? `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h. Passive warm-up activity is not multiplied down.`
        : `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h (warm-up week ${warmupWeek}: ${band.perDay}/day x ${multiplier}).`
  });

  checks.push({
    check: 'rolling-24h',
    passed: used24 + 1 <= band.perDay,
    detail: `${used24} of ${band.perDay} ${input.kind}s used in the last 24 hours (${posture} band).`
  });
  checks.push({
    check: 'rolling-7d',
    passed: band.perWeek === undefined || used7d + 1 <= band.perWeek,
    detail: band.perWeek === undefined
      ? `No 7-day ceiling is published for ${input.kind}, so none is invented here.`
      : `${used7d} of ${band.perWeek} ${input.kind}s used in the last 7 days (${posture} band).`
  });
  checks.push({
    check: 'rolling-30d',
    passed: band.perMonth === undefined || used30d + 1 <= band.perMonth,
    detail: band.perMonth === undefined
      ? `No 30-day ceiling is published for ${input.kind}, so none is invented here.`
      : `${used30d} of ${band.perMonth} ${input.kind}s used in the last 30 days (${posture} band).`
  });

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
    detail: acceptance.rate === null
      ? `No invite has been accepted or declined in the last ${ACCEPTANCE_WINDOW_DAYS} days, so there is no rate to judge.`
      : `${ACCEPTANCE_WINDOW_DAYS}-day invite acceptance is ${(acceptance.rate * 100).toFixed(0)}% (${acceptance.accepted} of ${acceptance.decided} decided); floor is ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}%.`
  });

  checks.push({
    check: 'business-hours',
    passed: local !== null && local.hour >= BUSINESS_HOURS.start && local.hour < BUSINESS_HOURS.end,
    detail: local === null
      ? `'${input.plannedFor}' is not a parseable instant, so it cannot be placed inside the hard business-hours window.`
      : `Scheduled for ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} in ${timezone}; hard window is ${BUSINESS_HOURS.start}:00-${BUSINESS_HOURS.end}:00.`
  });

  const onWeekend = weekday !== null && isWeekend(weekday);
  checks.push({
    check: 'weekend',
    passed: local !== null && (!onWeekend || WEEKEND_FACTOR > 0),
    detail: local === null
      ? `'${input.plannedFor}' is not a parseable instant, so its weekday is unknown.`
      : onWeekend
        ? `Scheduled on a weekend in ${timezone}, and the hard weekend factor is ${WEEKEND_FACTOR}.`
        : ENFORCEMENT_SCAN_WEEKDAYS.includes(weekday as number)
          ? `Scheduled on a weekday in ${timezone}. It is a reported enforcement-scan day, so pacing keeps it below the daily maximum.`
          : `Scheduled on a weekday in ${timezone}.`
  });

  checks.push({
    check: 'inmail-monthly-quota',
    passed: input.kind !== 'inmail' || used30d + 1 <= INMAIL_MONTHLY_QUOTA,
    detail: input.kind === 'inmail'
      ? `${used30d} of LinkedIn's ${INMAIL_MONTHLY_QUOTA} InMails used in the last 30 days.`
      : `The InMail quota applies to InMails; this is a ${input.kind}.`
  });

  const pendingInvites = await countPendingInvites(db, seatRef);
  checks.push({
    check: 'pending-invite-backlog',
    passed: input.kind !== 'invite' || pendingInvites + 1 <= MAX_OUTSTANDING_INVITES,
    detail: input.kind === 'invite'
      ? `${pendingInvites} of ${MAX_OUTSTANDING_INVITES} outstanding invites are still awaiting an answer.`
      : `The outstanding-invite ceiling applies to invites; this is a ${input.kind}. ${pendingInvites} invite(s) are pending for this seat.`
  });

  const excludeActionId = options.excludeActionId ?? null;
  const duplicate = await hasTarget(db, seatRef, input.kind, input.targetRef, excludeActionId);
  const subject = excludeActionId ? ' besides the one being evaluated' : '';
  checks.push({
    check: 'duplicate-target',
    passed: !duplicate,
    detail: duplicate
      ? `This seat already has a ${input.kind} logged against '${input.targetRef}'${subject}. A second one is blocked by the replay guard.`
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
  requireAllowed: z.boolean().default(false)
});

const outputSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  checks: z.array(z.object({
    check: z.enum(LINKEDIN_CHECK_NAMES),
    passed: z.boolean(),
    detail: z.string()
  })),
  automationMode: z.enum(['api-publish', 'prepare-only', 'disabled', 'unknown']),
  automationReason: z.string()
});

type LinkedInGuardInput = z.infer<typeof inputSchema>;

export const linkedinGuardSkill: Skill<LinkedInGuardInput, LinkedInSafetyVerdict> = {
  manifest: {
    id: 'gtm.linkedin-guard',
    name: 'LinkedIn seat safety gate',
    version: '1.1.0',
    description:
      'Check one proposed LinkedIn action against operator account limits plus every hard per-seat ceiling: pause/cooldown state, working window, warm-up, rolling windows, day-over-day variance, acceptance rate, business hours, weekends, InMail quota, pending invite backlog and duplicate targets.',
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
