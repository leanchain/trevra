/**
 * LinkedIn pacing limits.
 *
 * Code-owned policy in one diff-reviewable table, for the same reason
 * `outreach/config.ts` keeps PLATFORM_LIMITS out of YAML and out of a settings
 * row: an operator who wants a different ceiling is asking for a different
 * policy, and a different policy is a commit somebody reviewed.
 *
 * EVERY constant below carries its source and a confidence tag:
 *
 *   HARD FACT -- published by LinkedIn or a contractual term. Exactly one
 *                number in this file qualifies: the InMail quota.
 *   REPORTED  -- practitioner telemetry (PhantomBuster, June 2026, plus the
 *                pacing table in docs/linkedin-outreach-plan.md 1.4).
 *                Directionally right, never a guarantee. This is why the guard
 *                REPORTS a verdict instead of promising an outcome, and why
 *                the confidence tag is meant to reach the UI rather than stop
 *                at this file.
 *
 * The important thing these numbers are NOT: a daily ceiling is not the
 * defence. Plan 1.3 -- detection is behavioural, and 20/20/20/0/0/0/20 is more
 * dangerous than a flat 12/day even though every day is under the cap. The
 * ceilings here bound the pacing engine; MAX_DAY_OVER_DAY_DELTA is what
 * actually keeps a seat alive.
 */

import type { LinkedInSeat } from './seats.js';

/**
 * The kinds with a pacing band.
 *
 * `comment` is recordable in the ledger and deliberately absent here: no number
 * was researched for it, no driver routine performs it, and inventing one to
 * fill the table would launder a guess into a limit. Pacing and the guard
 * refuse it by type rather than pace it by fiction.
 *
 * EVERY OTHER LEDGER KIND IS HERE, AND THAT IS NOT AN ACCIDENT.
 * `evaluateLinkedInSafety` reads `bandFor(kind)` before it can check anything,
 * so a kind with no row here cannot be gated at all -- which makes "nobody
 * researched a ceiling for it" and "the driver may perform it" mutually
 * exclusive. The resolution is NOT to leave the performable kinds ungated; it
 * is to give each one a band and to say plainly, in the table below, which
 * bands are evidence and which are our own judgement. Five rows are REPORTED
 * or a HARD FACT; four (`reply`, `follow`, `like`, `endorse`) are
 * UNVERIFIED-VENDOR and say so.
 */
export const PACED_KIND_VALUES = [
  'invite',
  'dm',
  'reply',
  'inmail',
  'profile_view',
  'follow',
  'unfollow',
  'disconnect',
  'company_follow',
  'company_like',
  'company_invite_follow',
  'event_invite',
  'group_invite',
  'group_message',
  'event_message',
  'like',
  'endorse'
] as const;

export type PacedKind = (typeof PACED_KIND_VALUES)[number];

/**
 * The same list as an array, and the one every zod enum is built from.
 *
 * `PACED_KIND_VALUES` is the tuple `z.enum()` needs; `PACED_KINDS` is what
 * runtime callers iterate. Both are the same eight strings by construction, so
 * a kind cannot be paced by the engine and refused by an API schema -- which
 * is exactly what a hand-copied `z.enum(['invite', 'dm', ...])` in six files
 * eventually produces.
 */
export const PACED_KINDS: readonly PacedKind[] = PACED_KIND_VALUES;

export interface LinkedInBand {
  perDay: number;
  /** Absent when no weekly figure was reported for this kind. */
  perWeek?: number;
  /** Absent when no monthly figure was reported for this kind. */
  perMonth?: number;
}

/** Which band a posture draws from. `cooldown` and `paused` fall back to the conservative one. */
export type BandName = 'warmup' | 'steady';

/**
 * Per-kind ceilings, by band. All REPORTED except the InMail month.
 *
 * - invite  -- 1.4: 5-10/day new, 10-20/day established; <=25/week holds
 *              acceptance above 40%, >100/week drops it to 25-30%. 5 and 18
 *              sit inside those bands rather than at their tops; 20 and 90 are
 *              the weekly figures those daily numbers imply.
 * - dm      -- 1.4: 1-3/day new, 5-15/day established (1st-degree only).
 * - inmail  -- perMonth 50 is a HARD FACT: LinkedIn's published Sales
 *              Navigator seat quota (1.1). It is a quota, not a guideline, and
 *              it is identical in both bands because LinkedIn does not care
 *              how warmed up the account is. perDay 3 is REPORTED (1.4:
 *              "pace 2-3/day").
 *              LinkedIn resets it on a calendar month; every window in this
 *              codebase is ROLLING (see actions.ts), so 50-in-any-30-days is
 *              what is enforced. That is the stricter of the two everywhere
 *              except the 1st of the month, which is the right direction to
 *              be wrong in.
 * - profile_view -- 1.4: <=20/day new, 20-50/day established, >100 flagged.
 *
 * THE REPLY ROW IS UNVERIFIED-VENDOR AND MIRRORS `dm` EXACTLY.
 *
 * A reply exists as its own kind because filing one as a `dm` collides with
 * two guards that are both right: `duplicate-target` and the 022 replay index
 * both refuse a second action of one kind against one target, and answering
 * somebody this seat has already messaged is the NORMAL case in an inbox, not
 * the abuse those guards were built for. Splitting the kind keeps the invite
 * and dm windows honest without punching a hole in either guard.
 *
 * Splitting the kind is NOT a licence to invent a friendlier ceiling for it.
 * Nobody researched a reply band, and the tempting argument -- "a reply is
 * inbound-triggered, so it is safer than a cold DM" -- is a claim about
 * LinkedIn's heuristics that we have no evidence for, and one that a
 * `reply`-shaped hole through the dm ceiling would rest on entirely. So the
 * numbers are `dm`'s, copied deliberately: the confidence tag is
 * UNVERIFIED-VENDOR because the DECISION to mirror is ours, and the effect is
 * that a reply can never buy volume a DM could not.
 *
 * THE THREE ENGAGEMENT ROWS ARE UNVERIFIED-VENDOR TOO -- ours, not evidence.
 * Plan 1.4's table has rows for invites, DMs, InMail and profile views and
 * none for these three, and LinkedIn publishes nothing. They are anchored to
 * `profile_view`, the only passive kind that does have a reported band, and
 * every one of them sits strictly below it, because a follow and a like both
 * land in the target's notifications where a profile view frequently does not.
 * Pacing a louder action above a quieter one would be incoherent whatever the
 * numbers were.
 *
 * - like    -- 10 / 30. The loudest of the three per unit of effort and the
 *              one 1.4 names as warm-up activity, so it gets the most headroom
 *              of the three while staying under profile views.
 * - follow  -- 8 / 20. Below likes: a follow is a standing relationship rather
 *              than a single reaction, and a burst of them reads as
 *              list-processing.
 * - endorse -- 3 / 8. The lowest by a wide margin, for two reasons. Endorsing
 *              a stranger's skills is the least plausible human behaviour of
 *              the three, and ONE endorse action already performs up to three
 *              clicks (`driver-engage.ts` `endorseSkills`), so 8 actions is up
 *              to 24 clicks.
 *
 * DAILY ONLY for all four judgement rows: no `perWeek`, no `perMonth`.
 * Supplying a daily figure is already a stretch and the gate cannot run
 * without one; supplying three would be three guesses where one is needed, and
 * `guard.ts` already reports an absent weekly or monthly ceiling by saying so
 * out loud. (`reply` is the exception that proves it: its weekly figure is not
 * a fourth guess, it is `dm`'s REPORTED number, unchanged.)
 */
// WARM-UP `perDay` for invite, dm, profile_view and follow is an OPERATOR
// OVERRIDE of the researched figures below, not a fourth guess of our own --
// requested and confirmed explicitly, above what 1.4 reports, because the
// operator accepted the higher ban risk that implies. `perWeek` on invite/dm
// is UNCHANGED, so the rolling 7-day ceiling (20 and 10) now binds well
// before 7 days of the new daily figure would: raise it too if the daily
// increase should actually be reachable rather than merely on paper.
export const LINKEDIN_LIMITS: Readonly<
  Record<PacedKind, Readonly<Record<BandName, LinkedInBand>>>
> = {
  invite: { warmup: { perDay: 10, perWeek: 20 }, steady: { perDay: 18, perWeek: 90 } },
  dm: { warmup: { perDay: 4, perWeek: 10 }, steady: { perDay: 12, perWeek: 60 } },
  reply: { warmup: { perDay: 2, perWeek: 10 }, steady: { perDay: 12, perWeek: 60 } },
  inmail: { warmup: { perDay: 1, perMonth: 50 }, steady: { perDay: 3, perMonth: 50 } },
  profile_view: { warmup: { perDay: 30 }, steady: { perDay: 45 } },
  follow: { warmup: { perDay: 16 }, steady: { perDay: 20 } },
  // Relationship cleanup shares Follow's conservative band; guard.ts also aggregates the three kinds into one bucket.
  unfollow: { warmup: { perDay: 16 }, steady: { perDay: 20 } },
  disconnect: { warmup: { perDay: 16 }, steady: { perDay: 20 } },
  company_follow: { warmup: { perDay: 16 }, steady: { perDay: 20 } },
  company_like: { warmup: { perDay: 10 }, steady: { perDay: 30 } },
  company_invite_follow: {
    warmup: { perDay: 10, perWeek: 20 },
    steady: { perDay: 18, perWeek: 90 }
  },
  event_invite: { warmup: { perDay: 10, perWeek: 20 }, steady: { perDay: 18, perWeek: 90 } },
  group_invite: { warmup: { perDay: 10, perWeek: 20 }, steady: { perDay: 18, perWeek: 90 } },
  group_message: { warmup: { perDay: 4, perWeek: 10 }, steady: { perDay: 12, perWeek: 60 } },
  event_message: { warmup: { perDay: 4, perWeek: 10 }, steady: { perDay: 12, perWeek: 60 } },
  like: { warmup: { perDay: 10 }, steady: { perDay: 30 } },
  endorse: { warmup: { perDay: 3 }, steady: { perDay: 8 } }
};

/**
 * The most invites this seat may leave awaiting an answer at once.
 *
 * REPORTED (1.4), and read carefully, because the figure is being used for a
 * neighbouring question rather than the one it was measured on. What 1.4
 * reports is about SENDING: ">100/week drops acceptance to 25-30%", against a
 * <=25/week rate that holds it above 40%. It is the closest reported number
 * there is to an outstanding-invite ceiling, and it is used as one here rather
 * than a rounder guess -- but it is not upgraded to a HARD FACT by being
 * repurposed, and nothing below claims LinkedIn publishes an outstanding cap.
 *
 * WHY IT EXISTS AT ALL. A pending invite consumes the operator's weekly invite
 * capacity on LinkedIn's side for as long as it sits there and is a permanent
 * zero in the acceptance numerator (1.3: sustained acceptance below 30% reads
 * as spam). Trevra's own arithmetic could not see that: `guard.ts` and
 * `pacing.ts` both count invites by `recorded_at` inside a rolling window, so
 * a backlog older than the window was invisible and withdrawing it returned no
 * headroom here even though it did on LinkedIn. `pending-invite-backlog` in
 * the guard and the weekly clamp in `pacing.ts` are the two places that read
 * this, and between them they are what makes a withdrawal give something back.
 */
export const MAX_OUTSTANDING_INVITES = 100;

/**
 * The core anti-"Slide and Spike" number, and the one this engine exists for.
 *
 * REPORTED (1.3): a day-over-day volume change above 50% is a trigger, and the
 * disconnection signature is 5-10 days of decline followed by a +120% surge
 * within 24-48h. 0.35 sits deliberately BELOW the reported 0.5 trigger --
 * riding the edge of a practitioner-reported threshold is not a margin.
 */
export const MAX_DAY_OVER_DAY_DELTA = 0.35;

/**
 * The smallest day a ramp may step up by, in absolute actions.
 *
 * NOT from the research, and marked as such: it is arithmetic. A ratio clamp
 * cannot leave zero (0 x 1.35 = 0) and cannot move integers near it (1 x 1.35
 * floors back to 1), so a seat with no history would be frozen at zero
 * forever. One action per day is the smallest step that lets a cold ledger
 * start, and going from 1 to 2 is an integer, not a surge. Above roughly 3
 * actions/day the ratio is what binds and this constant stops mattering.
 */
export const MIN_RAMP_STEP = 1;

/**
 * Sustained acceptance below this reads as spam. REPORTED (1.3): "<30% over a
 * week". Measured over ACCEPTANCE_WINDOW_DAYS.
 */
export const MIN_ACCEPTANCE_RATE = 0.3;

/** The week in "acceptance rate <30% over a week". REPORTED (1.3). */
export const ACCEPTANCE_WINDOW_DAYS = 7;

/**
 * What a failing acceptance rate multiplies volume by. Plan 4-phase-2 step 4.
 *
 * A throttle, not a stop: halving never takes a day that was allowed at least
 * one action down to zero (see pacing.ts). A seat cut to zero can never
 * generate the outcomes that would clear the throttle, so "halve it" would
 * become "end it" -- which is a decision for a human, not for a multiplier.
 */
export const ACCEPTANCE_THROTTLE_FACTOR = 0.5;

/**
 * The spread window, in the SEAT's local hours. REPORTED (1.4): "spread across
 * 08:00-18:00 recipient/user local". `end` is exclusive.
 */
export const BUSINESS_HOURS = { start: 8, end: 18 };

/**
 * Minimum and maximum seconds between two consecutive actions. REPORTED (1.4):
 * "randomised 30-120s gaps, never a 2-hour block".
 *
 * Both halves are used, for different jobs: `min` is the hard floor the
 * scheduler will never place two slots closer than, and `max` is the headroom
 * reserved around each grid point so jitter can never eat that floor. In
 * practice the even spread across the business-hours window produces gaps far
 * larger than either -- which is the "never a block" half of the same
 * sentence.
 */
export const ACTION_GAP_SECONDS = { min: 30, max: 120 };

/**
 * What a weekend day's volume is multiplied by. REPORTED (1.4): "weekends ~50%
 * of weekday rate or zero". Zero is chosen: the conservative end of a
 * practitioner-reported range, and a founder's LinkedIn going quiet at the
 * weekend is the least remarkable thing about it.
 */
export const WEEKEND_FACTOR = 0.0;

/**
 * Days LinkedIn's enforcement scan clusters on, as JS weekday numbers
 * (0=Sunday). REPORTED (1.3): "disconnections cluster on Tuesdays and
 * Wednesdays".
 *
 * The rule is narrow on purpose -- these days are not skipped, they are
 * capped: a day's maximum is never scheduled on one. Skipping two of five
 * working days would itself create the weekly sawtooth this engine exists to
 * avoid.
 */
export const ENFORCEMENT_SCAN_WEEKDAYS: readonly number[] = [2, 3];

/**
 * InMails per calendar month, per Sales Navigator seat. HARD FACT (1.1):
 * published by LinkedIn. Not a pacing preference -- the 51st is refused by
 * LinkedIn, not by us.
 */
export const INMAIL_MONTHLY_QUOTA = 50;

/**
 * Warm-up multipliers by week, index 0 = week 1. REPORTED (1.4): "wk1 passive
 * only (views/likes, 0 invites) -> wk2 5-10 light actions, 0-5 invites -> wk3+
 * ramp to ~10/day". Any week past the table is 1.0 -- the band ceiling itself.
 *
 * These apply to ACTIVE kinds only. See PASSIVE_KINDS.
 */
export const WARMUP_MULTIPLIERS: readonly number[] = [0, 0.4, 0.7];

/** Weeks the ramp lasts. Week WARMUP_WEEKS+1 onward is `steady`. */
export const WARMUP_WEEKS = WARMUP_MULTIPLIERS.length;

/**
 * Kinds the warm-up ramp does NOT zero. REPORTED (1.4): week 1 is "passive
 * only (views/likes, 0 invites)" -- passive activity is the warm-up, not a
 * thing the warm-up suppresses.
 *
 * Multiplying these by the week-1 zero would mean a brand-new seat does
 * literally nothing for seven days and then starts acting, which is the
 * "Slide and Spike" shape from 1.3 -- the engine would manufacture the exact
 * signature it exists to prevent. A warm-up that performs no actions is not a
 * warm-up.
 *
 * Only the multiplier is bypassed. Passive kinds are still subject to the
 * posture band, the rolling windows, the day-over-day variance clamp, the
 * business-hours window, the weekend factor, and paused/cooldown posture.
 *
 * `follow`, `like` and `endorse` joined the moment `driver-engage.ts` could
 * perform them, and all three belong here with no exception: a follow, a like
 * and an endorsement are things a member does while READING, not things they
 * send. Nobody has to accept one, none of them consumes an invite, and none
 * produces the acceptance-rate signal 1.3's spam heuristic reads.
 *
 * `reply` is deliberately NOT here. A reply is a message somebody receives,
 * which is the whole distinction this list draws, and warming up an account by
 * messaging strangers is not a warm-up.
 *
 * Typed as strings rather than PacedKind so a kind can join the moment the
 * driver can perform it, without this list needing the pacing table to exist
 * for it first.
 */
export const PASSIVE_KINDS: readonly string[] = [
  'profile_view',
  'follow',
  'unfollow',
  'disconnect',
  'company_follow',
  'company_like',
  'like',
  'endorse'
];

export function isPassiveKind(kind: string): boolean {
  return PASSIVE_KINDS.includes(kind);
}

/** The multiplier for a 1-based warm-up week. Weeks past the ramp are 1.0. */
export function warmupMultiplier(week: number): number {
  if (week < 1) return WARMUP_MULTIPLIERS[0];
  return WARMUP_MULTIPLIERS[week - 1] ?? 1;
}

/** The multiplier that actually applies to `kind`. Passive kinds skip the ramp entirely. */
export function warmupMultiplierFor(kind: string, week: number): number {
  return isPassiveKind(kind) ? 1 : warmupMultiplier(week);
}

/** The band for one kind. `cooldown`/`paused` postures pass 'warmup' -- backing off means the conservative band. */
export function bandFor(kind: PacedKind, band: BandName): LinkedInBand {
  return LINKEDIN_LIMITS[kind][band];
}

/**
 * The operator's own daily number for one kind, or null when they set none.
 *
 * `linkedin_seats` carries FOUR operator ceilings and this file paces EIGHT
 * kinds, so the mapping is not one-to-one and the shape of the mismatch
 * matters:
 *
 *   invite                -> dailyInviteLimit
 *   dm | reply | inmail   -> dailyMessageLimit, ONE POOL over three kinds
 *   profile_view          -> dailyProfileViewLimit
 *   follow                -> dailyFollowLimit
 *   like | endorse        -> null; the operator was never asked for a number
 *
 * THE MESSAGE ROW IS A POOL AND THAT IS THE WHOLE REASON THIS FUNCTION EXISTS
 * SEPARATELY FROM THE BAND TABLE. "25 messages a day" is a statement about the
 * account's total outbound messaging, not about DMs specifically, so it is
 * compared against the count of all three kinds together -- while the band
 * above it (`LINKEDIN_LIMITS`) is per kind and is compared against that kind's
 * own count. Collapsing the two into a single `Math.min` is exactly the bug
 * this pair of functions replaced: an InMail's 3/day band would clamp the
 * operator's whole 25-message pool to 3, so three DMs blocked every InMail.
 * `guard.ts` keeps them as two independent ceilings; both must pass.
 *
 * Null for `like` and `endorse` is deliberate rather than a gap to fill later:
 * inventing an operator number nobody typed would launder a guess into a
 * setting, exactly as inventing a band would launder one into a limit. Their
 * band is the only ceiling they have, which is the honest answer.
 *
 * `LinkedInSeat` is imported as a TYPE ONLY. `seats.ts` imports `WARMUP_WEEKS`
 * from this file, so a value import here would close a runtime cycle for a
 * four-way switch; a type import is erased and closes nothing.
 */
export function seatOperatorLimit(seat: LinkedInSeat | undefined, kind: PacedKind): number | null {
  if (!seat) return null;
  switch (kind) {
    case 'invite':
    case 'company_invite_follow':
    case 'event_invite':
    case 'group_invite':
      return seat.dailyInviteLimit;
    case 'dm':
    case 'reply':
    case 'inmail':
    case 'group_message':
    case 'event_message':
      return seat.dailyMessageLimit;
    case 'profile_view':
      return seat.dailyProfileViewLimit;
    case 'follow':
    case 'unfollow':
    case 'disconnect':
    case 'company_follow':
      return seat.dailyFollowLimit;
    default:
      return null;
  }
}

/**
 * The daily ceiling that actually binds for one kind.
 *
 * THREE CASES, AND THE THIRD IS THE ONE WITH A POLICY IN IT.
 *
 *   no operator number      -> Trevra's researched band. Nobody said otherwise.
 *   operator number         -> the STRICTER of the two. An operator asking for
 *                              less than the band gets less; an operator asking
 *                              for more than the band does not get more, because
 *                              the band is what the research says keeps the
 *                              account alive and a settings field is not
 *                              evidence.
 *   operator number, and
 *   the seat's band override -> the operator's number, whatever it is.
 *
 * THE OVERRIDE IS A DELIBERATE, RECORDED DECISION AND NOT A CONVENIENCE. It
 * lives on the seat (`safetyBandOverride`), so turning it on is an edit to the
 * account somebody can see, and it lifts exactly one thing: the steady/warm-up
 * BAND cap. It is not a bypass of the gate. Every other ceiling in `guard.ts`
 * still applies unchanged -- the rolling 7-day and 30-day windows, the
 * day-over-day variance clamp, the acceptance-rate throttle, business hours,
 * the published InMail quota, the outstanding-invite backlog -- and BOTH ramps
 * (the per-seat warm-up week and the per-campaign day ramp) still multiply
 * whatever this returns. An override raises the number the ramps are a
 * percentage OF; it never turns a ramp off. That distinction is the difference
 * between "I know my account and I want my own number" and "send everything
 * now", and only the first one is offered.
 *
 * `operatorLimit === null` with the override on is not an override of anything:
 * there is no operator number to prefer, so the band stands.
 */
export function effectiveDailyCeiling(
  bandPerDay: number,
  operatorLimit: number | null,
  overrideBands: boolean
): number {
  if (overrideBands && operatorLimit !== null) return operatorLimit;
  return operatorLimit === null ? bandPerDay : Math.min(bandPerDay, operatorLimit);
}
