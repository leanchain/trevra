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
  effectiveDailyCeiling,
  isPassiveKind,
  seatOperatorLimit,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import { campaignActionLimit, campaignWarmupFraction } from './managed-campaigns.js';
import { formatMinuteOfDay, isWeekend, localDateOf, previousBusinessDayCount, weekdayOf, weekdayVolumeFactor, workWindowOf } from './pacing.js';
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
  | 'campaign-warmup'
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
  'campaign-warmup',
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
  /**
   * The campaign this action belongs to, when it belongs to one.
   *
   * Absent is the ordinary case -- a one-off export has no campaign -- and the
   * `campaign-warmup` check says so out loud rather than vanishing. Present
   * and MANAGED (started, with a workflow) is what turns the campaign-day ramp
   * on for this action.
   */
  campaignId?: string;
  /**
   * The replay identity of the action under evaluation, within its kind and
   * target. Absent means 'legacy', exactly as it does in `recordAction`.
   *
   * `duplicate-target` asks the ledger's own replay question, so it has to ask
   * it in the ledger's own terms (migration 047): a row only duplicates this
   * one when it shares this scope. A managed workflow supplies `member:step`,
   * so its second message step is a different action rather than a forbidden
   * repeat of the first; every other caller supplies nothing and gets the
   * legacy one-kind-per-target guard unchanged.
   *
   * Deliberately NOT on the skill's input schema, for the same reason
   * `excludeActionId` is not: an approved playbook payload must not be able to
   * name a scope that excuses it from the duplicate check.
   */
  replayScope?: string;
  /**
   * The operator overrode a `warmup-ceiling` refusal for THIS ONE reply.
   *
   * Migration 044 (`linkedin_actions.override_warmup_ceiling`) is the record of
   * that decision and its COMMENT is the specification this field implements:
   * set exclusively by `enqueueReply` from the inbox composer's "Override the
   * warm-up ceiling" control, read back off the row by the local worker's
   * pre-send re-evaluation so the override STICKS TO THE ROW instead of having
   * to be re-supplied by whoever happens to call the gate next.
   *
   * IT RELAXES EXACTLY ONE CHECK. `warmup-ceiling`, and nothing else. Posture,
   * both rolling windows, the campaign ramp, the day-over-day clamp, the
   * acceptance throttle, business hours, weekends, the InMail quota, the
   * pending-invite backlog and `duplicate-target` all still run and can all
   * still refuse -- and the relaxed check says in its own `detail` that it was
   * overridden, so a verdict never reads as a clean pass it did not earn.
   *
   * REPLIES ONLY, enforced here as well as at the write site. A warm-up ramp
   * exists to stop a new seat from behaving like an established one, and the
   * one action where a human is answering somebody who wrote to them first is
   * the only one where "I know what I am doing" is a claim about a real
   * conversation rather than about volume. Anything else carrying this flag is
   * ignored rather than honoured: fail-closed is the direction a gate is
   * allowed to be wrong in.
   *
   * Absent from the skill's input schema for the third time and the same
   * reason as the two fields above it.
   */
  overrideWarmupCeiling?: boolean;
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
   * Any OTHER non-skipped row against the same target still fails the check,
   * and no other check is affected -- all of them still see the ledger. That is the
   * difference between this and the alternative a caller might reach for,
   * which is to run the gate and then discount a failing check afterwards:
   * that puts "ignore the guard under conditions X" in the caller, where the
   * next edit widens X. The gate stays authoritative; it is simply told which
   * row is the subject of the question.
   *
   * It excludes exactly one row, by primary key, and every other check still
   * sees the whole ledger.
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
 * The campaign's ramp clock, or undefined when there is nothing to ramp.
 *
 * A campaign qualifies only when it has BOTH a `started_at` and a
 * `workflow_id` -- that pair is what makes it a managed campaign this
 * deployment drives, as opposed to a draft, or a 025-era campaign folder whose
 * actions a human exported by hand. A campaign that fails the test is reported
 * as not ramped, never treated as ramped-to-zero.
 */
async function managedCampaignRamp(db: Db, workspaceId: string, campaignId: string): Promise<{ startedAt: string } | undefined> {
  const row = await db
    .prepare('SELECT started_at, workflow_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
    .get<{ started_at: string | null; workflow_id: string | null }>(workspaceId, campaignId);
  if (!row || row.started_at === null || row.workflow_id === null) return undefined;
  return { startedAt: row.started_at };
}

/**
 * This campaign's non-skipped actions of one kind in the rolling window.
 *
 * Deliberately NOT `actions.ts`'s seat-scoped counters: every ceiling there
 * asks "what has this SEAT done", and the campaign ramp asks "what has this
 * CAMPAIGN done" -- one seat legitimately runs several campaigns and their
 * ramps are independent. Same two rules as every other window in the ledger:
 * `recorded_at`, and rolling rather than calendar.
 */
async function countCampaignActionsInWindow(
  db: Db,
  workspaceId: string,
  campaignId: string,
  kind: PacedKind,
  sinceHours: number,
  now: Date
): Promise<number> {
  const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();
  const row = await db
    .prepare(`
      SELECT COUNT(*)::int AS total FROM linkedin_actions
      WHERE workspace_id=? AND campaign_id=? AND kind=? AND status <> 'skipped' AND recorded_at > ?
    `)
    .get<{ total: number }>(workspaceId, campaignId, kind, since);
  return row?.total ?? 0;
}

/** 1-based campaign day, for the sentence the operator reads. */
function campaignDayOf(startedAt: string, now: Date): number {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 1;
  return Math.max(1, Math.floor((now.getTime() - start) / 86_400_000) + 1);
}

/**
 * Run every gate against one proposed action.
 *
 * A workspace with NO seat still gets all fourteen checks, evaluated against the
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
  // The seat's own days and hours, or the researched default when there is no
  // seat to ask. Same window `pacing.ts` places slots inside.
  const window = workWindowOf(seat);

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
  // The operator's own number for this kind, and whether the seat says it wins
  // over Trevra's researched band. Both live in `limits.ts` -- the mapping from
  // eight paced kinds onto four settings fields, and the three-case rule for
  // combining a band with a setting, are policy, and policy belongs in the file
  // that carries the evidence for it rather than restated in the gate.
  const operatorLimit = seatOperatorLimit(seat, input.kind);
  const overrideBands = seat?.safetyBandOverride ?? false;
  const operatorUsed24 = operatorLimit === null
    ? used24
    : isMessage
      ? await countActionKindsInWindow(db, seatRef, [...messageKinds], 24, now)
      : used24;
  const used7d = await countActionsInWindow(db, seatRef, input.kind, 24 * 7, now);
  const used30d = await countActionsInWindow(db, seatRef, input.kind, 24 * 30, now);

  const effectiveDailyLimit = effectiveDailyCeiling(band.perDay, operatorLimit, overrideBands);

  /**
   * WHERE THE PER-KIND CEILING CAME FROM, in the operator's words.
   *
   * Every detail below that quotes a daily number quotes this instead of
   * `band.perDay`, because after the override those are different numbers and a
   * refusal that names the wrong one sends somebody to the wrong screen. When
   * the override is on the sentence says so explicitly and quotes BOTH figures:
   * an operator who lifted the band deserves to see, on every ceiling they
   * read, that what is binding is their number and not Trevra's research.
   */
  const ceilingSource =
    operatorLimit === null
      ? `${band.perDay}/day`
      : overrideBands
        ? `${operatorLimit}/day, the operator's own ceiling, which overrides Trevra's researched ${band.perDay}/day safety band for this seat`
        : `${effectiveDailyLimit}/day, the stricter of Trevra's ${band.perDay}/day safety band and the operator setting ${operatorLimit}/day`;

  // Passive kinds skip the ramp -- see PASSIVE_KINDS. They are still checked
  // here, just against the full ceiling: only the multiplier is bypassed.
  //
  // THE RAMP MULTIPLIES `effectiveDailyLimit`, NOT `band.perDay`. That is what
  // makes the override lift a CAP without ever lifting a RAMP: week 2 of an
  // overridden seat is 40% of the operator's number instead of 40% of ours, and
  // it is still 40%. It also makes the ramp respect an operator who asked for
  // LESS than the band, which the old `band.perDay x multiplier` quietly did
  // not.
  const multiplier = warmupMultiplierFor(input.kind, warmupWeek);
  const warmupCeiling = Math.floor(effectiveDailyLimit * multiplier);
  const warmupPassed = used24 + 1 <= warmupCeiling;
  // Migration 044, honoured for `reply` and ignored for everything else. See
  // `LinkedInSafetyInput.overrideWarmupCeiling`.
  const overrideWarmup = input.overrideWarmupCeiling === true && input.kind === 'reply';
  const warmupDetail =
    warmupCeiling === 0
      ? `Warm-up week ${warmupWeek} permits no ${input.kind}s at all (${ceilingSource} x ${multiplier}). ${seat === undefined ? 'No seat is configured, so this is paced as a brand-new one; detect the seat to start its ramp.' : 'Wait for the ramp. It is keyed to how long this seat has been automated, not to the account\'s age, so there is nothing to declare that would lift it.'}`
      : isPassiveKind(input.kind) && warmupWeek <= WARMUP_WEEKS
        ? `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h. Passive activity is not ramped during warm-up; it is what the warm-up consists of.`
        : `${used24} of ${warmupCeiling} ${input.kind}s used in the last 24h (warm-up week ${warmupWeek}: ${ceilingSource} x ${multiplier}).`;
  checks.push({
    check: 'warmup-ceiling',
    passed: warmupPassed || overrideWarmup,
    detail: overrideWarmup
      ? `${warmupDetail} The operator explicitly overrode the warm-up ceiling for this one reply, so this check ${warmupPassed ? 'would have passed anyway and the override changed nothing' : 'does not refuse it'}. It relaxes this ceiling and nothing else -- every other check below still runs and can still refuse.`
      : warmupDetail
  });

  // THE SECOND RAMP, and it is a different clock from the one above.
  //
  // `warmup-ceiling` ramps by WEEK since this SEAT was first automated.
  // This one ramps by DAY since this CAMPAIGN was started: 20/40/60/80/100%
  // over days 1..5, implemented once in `managed-campaigns.ts` and READ here
  // rather than restated, so the manager's ramp and the gate's ramp cannot
  // drift into two different policies wearing the same name.
  //
  // Both apply and the stricter one binds. A seat automated since January is
  // at full seat capacity; a campaign it started this morning still gets 20%
  // of that capacity, because the risk the campaign ramp answers is a NEW
  // burst of near-identical outreach, not a new account.
  const campaignId = input.campaignId?.trim() || null;
  const campaign = campaignId === null ? undefined : await managedCampaignRamp(db, input.workspaceId, campaignId);
  const campaignLimit = campaign === undefined ? null : campaignActionLimit(effectiveDailyLimit, campaign.startedAt, now);
  const campaignUsed24 =
    campaign === undefined || campaignId === null ? 0 : await countCampaignActionsInWindow(db, input.workspaceId, campaignId, input.kind, 24, now);
  checks.push({
    check: 'campaign-warmup',
    passed: campaignLimit === null || campaignUsed24 + 1 <= campaignLimit,
    detail:
      campaign !== undefined && campaignLimit !== null
        ? `${campaignUsed24} of ${campaignLimit} ${input.kind}s used by this campaign in the last 24 hours: campaign day ${campaignDayOf(campaign.startedAt, now)} is ${(campaignWarmupFraction(campaign.startedAt, now) * 100).toFixed(0)}% of the seat's ${effectiveDailyLimit}/day ceiling. The campaign ramp and the per-seat warm-up both apply; whichever is stricter binds.`
        : campaignId === null
          ? `No campaign was named for this action, so the campaign-day ramp does not apply and only the per-seat warm-up week does. The ramp shapes managed campaigns -- the ones this deployment runs itself.`
          : `Campaign '${campaignId}' is not a managed campaign in this workspace (a managed campaign has a workflow and has been started), so the 20/40/60/80/100% campaign-day ramp does not apply to it. The per-seat warm-up above still does.`
  });

  /**
   * TWO INDEPENDENT DAILY CEILINGS, AND BOTH HAVE TO PASS.
   *
   * They were one, and being one was a bug with teeth. Trevra's band is PER
   * KIND (`limits.ts`: an InMail is 3/day because InMails are 3/day) while the
   * operator's "messages" setting is ONE POOL over dm+reply+inmail ("this
   * account sends at most 25 messages a day" is a statement about the account,
   * not about DMs). The old line compared the POOL count against
   * `min(band.perDay, operatorLimit)`, which multiplied the two mistakes
   * together: evaluating an InMail collapsed the whole 25-message pool to
   * min(3, 25) = 3, so three DMs already sent refused every InMail, and twelve
   * DMs refused every reply. A per-kind number was being used as a pool cap.
   *
   * So each ceiling is now checked against the number it is a ceiling ON:
   *
   *   the per-kind ceiling  (`effectiveDailyLimit`) against this kind's own
   *                         count (`used24`);
   *   the operator's pool   (`operatorLimit`)       against the operator's own
   *                         number (`operatorUsed24`, which IS the pool for the
   *                         three message kinds and is the same as `used24` for
   *                         every other kind).
   *
   * Neither is discounted by the other and the stricter one binds, which is the
   * same composition every other pair of ceilings in this file uses.
   */
  const bandPassed = used24 + 1 <= effectiveDailyLimit;
  const poolPassed = operatorLimit === null || operatorUsed24 + 1 <= operatorLimit;
  const poolNoun = isMessage ? 'messages (DMs, replies and InMails share one operator ceiling)' : `${input.kind}s`;
  checks.push({
    check: 'rolling-24h',
    passed: bandPassed && poolPassed,
    detail: operatorLimit === null
      ? `${used24} of ${effectiveDailyLimit} ${input.kind}s used in the last 24 hours (${posture} band).`
      : `${used24} of ${ceilingSource} used in the last 24 hours for ${input.kind}s, and ${operatorUsed24} of the operator's ${operatorLimit}/day account-level ${poolNoun}. Two independent ceilings -- the per-kind one and the operator's pool -- and ${bandPassed && poolPassed ? 'both pass' : !bandPassed && !poolPassed ? 'both are full' : bandPassed ? 'the operator pool is full' : 'the per-kind ceiling is full'}.`
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
  const previous = previousBusinessDayCount(history, localDateOf(now, timezone), window);
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

  // The window and the weekday predicate BOTH come from `pacing.ts`, and that
  // is the fix for the gap that made this comment necessary: the planner used
  // to place slots against a hardcoded 08:00-18:00 Mon-Fri while this gate
  // enforced the seat's own configuration, so a seat working 10:00-14:00
  // Tue/Thu was handed slots that were refused here and never happened.
  const weekday = local === null ? null : weekdayOf(local);
  const minuteOfDay = local === null ? null : local.hour * 60 + local.minute;
  // > 0 means "this seat may act on this weekday at all". A day the operator
  // configured scores 1 whether or not it is a weekend; an unconfigured
  // weekend scores WEEKEND_FACTOR; anything else scores 0.
  const dayFactor = weekday === null ? 0 : weekdayVolumeFactor(window, weekday);
  const insideConfiguredWindow =
    local !== null && dayFactor > 0
    && minuteOfDay !== null && minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute;
  checks.push({
    check: 'business-hours',
    passed: insideConfiguredWindow,
    detail:
      local === null
        ? `'${input.plannedFor}' is not a parseable instant, so it cannot be placed inside a working-hours window.`
        : `Scheduled for ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} in ${timezone}; this account works on weekday(s) ${window.days.join(',') || 'none'} between ${formatMinuteOfDay(window.startMinute)} and ${formatMinuteOfDay(window.endMinute)}.`
  });
  const onWeekend = weekday !== null && isWeekend(weekday);
  const configuredDay = weekday !== null && window.days.includes(weekday);
  checks.push({
    check: 'weekend',
    // THE OPERATOR'S CONFIGURED DAYS ARE AUTHORITATIVE for the weekday
    // question. Ticking Saturday in `working_days` is an explicit statement
    // about this account, and WEEKEND_FACTOR does not get to overrule it --
    // the factor shapes the VOLUME of a weekend day nobody configured. Raise
    // it above zero and unconfigured weekends stop being blocked, with no edit
    // here. Same predicate the planner places slots with, so this check can
    // never refuse an instant the plan just produced.
    passed: local !== null && (!onWeekend || dayFactor > 0),
    detail:
      local === null
        ? `'${input.plannedFor}' is not a parseable instant, so its weekday is unknown.`
        : onWeekend
          ? configuredDay
            ? `Scheduled on a weekend in ${timezone}, and this account is explicitly configured to work weekday ${weekday}. A configured day is a working day; the weekend factor of ${WEEKEND_FACTOR} shapes only the days nobody configured.`
            : `Scheduled on a weekend in ${timezone} that this account has not configured as a working day, and the weekend factor is ${WEEKEND_FACTOR}.`
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

  // SCOPED, EXACTLY AS THE LEDGER'S REPLAY INDEX IS SCOPED (migration 047).
  //
  // Asking the unscoped question here made the gate stricter than the table it
  // guards: a managed workflow's second message step carries its own
  // `member:step` scope and the ledger would store it, but this check found the
  // first step's `sent` row against the same person and refused forever, so a
  // two-message workflow could never send its second message. Handing the scope
  // to `hasTarget` makes the two agree by construction. A row in a DIFFERENT
  // scope is a different action and does not veto this one; a row in the SAME
  // scope -- including the legacy/unscoped default every existing caller uses --
  // still does, which is what keeps a genuine repeat of one step for one member,
  // and a replayed export, refused.
  const excludeActionId = options.excludeActionId ?? null;
  const replayScope = input.replayScope?.trim() || 'legacy';
  const duplicate = await hasTarget(db, seatRef, input.kind, input.targetRef, excludeActionId, replayScope);
  const subject = excludeActionId ? ' besides the one being evaluated' : '';
  const scoped = replayScope === 'legacy' ? '' : ` in replay scope '${replayScope}'`;
  checks.push({
    check: 'duplicate-target',
    passed: !duplicate,
    detail: duplicate
      ? `This seat already has a ${input.kind} logged against '${input.targetRef}'${scoped}${subject}. A second one is the thing the ledger's replay guard exists to prevent.`
      : `No prior ${input.kind} against '${input.targetRef}'${scoped}${subject}.`
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
  /** The managed campaign this action belongs to, when it belongs to one. */
  campaignId: z.string().min(1).max(64).optional(),
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
      'Check one proposed LinkedIn action against every per-seat ceiling at once: pause state, warm-up week, the campaign-day warm-up ramp, rolling 24h/7d/30d windows, day-over-day variance, acceptance rate, the seat\'s configured working days and hours, weekends, the published InMail quota, the outstanding-invite backlog, and duplicate targets.',
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
        plannedFor: input.plannedFor,
        campaignId: input.campaignId
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
