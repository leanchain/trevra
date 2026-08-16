import { getChannel } from '../channels/registry.js';
import type { Db } from '../db.js';
import { countActionsInWindow, hasTarget, recordAction, type LinkedInActionRecord, type SeatRef } from './actions.js';
import { evaluateLinkedInSafety, type LinkedInSafetyOptions, type LinkedInSafetyVerdict } from './guard.js';
import { LINKEDIN_LIMITS, PACED_KINDS, bandFor, type BandName, type LinkedInBand, type PacedKind } from './limits.js';
import { OWNER_SEAT_KEY } from './seats.js';

/**
 * The ledger-facing half of the three ENGAGEMENT kinds: follow, like, endorse.
 * `driver-engage.ts` performs them; this file is what says how often.
 *
 * WHY THEY EXIST. Plan 4A, the honest feature diff: "extra actions: endorse,
 * follow, like -- yes | driver has invite/dm/view only | Ph.7", and 6A which
 * schedules that phase. Dripify and Waalaxy ship all three. More importantly
 * plan 1.4's warm-up ramp is written IN TERMS OF them -- "wk1 passive only
 * (views/likes, 0 invites)" -- so without them the warm-up could only ever
 * perform half of what the research says a warm-up is.
 *
 * THE TWO RULES, and they are in tension, which is why both are written down.
 *
 * 1. THESE ARE PASSIVE KINDS. `limits.ts` `PASSIVE_KINDS` must contain all
 *    three. That carve-out already records the reasoning at length and it was
 *    written for exactly this case: multiplying passive activity by the week-1
 *    zero means a brand-new seat does literally nothing for seven days and
 *    then starts acting, which is the "Slide and Spike" signature of plan 1.3
 *    -- the engine manufacturing the shape it exists to prevent. Follow-and-
 *    like warming IS the warm-up. `PASSIVE_ENGAGEMENT_KINDS` below is the
 *    exact value that list must gain; this file does not make the edit,
 *    because `limits.ts` is where policy lives and a policy change is a commit
 *    somebody reviewed.
 *
 * 2. PASSIVE DOES NOT MEAN UNPACED. Each kind carries its own daily ceiling
 *    (`ENGAGEMENT_LIMITS`) and each still goes through
 *    `evaluateLinkedInSafety` -- every one of its checks, unfiltered. Liking
 *    200 posts in an hour is a ban signal regardless of how harmless one like
 *    is, and the ceiling is only the first of the gates that stops it: the
 *    day-over-day variance clamp, the business-hours window, the weekend
 *    factor and the 30-120s inter-action gap all still apply. Only the warm-up
 *    MULTIPLIER is bypassed, exactly as it is for `profile_view` today.
 *
 * CONFIDENCE. Every number is tagged, in the vocabulary `limits.ts`
 * established -- HARD FACT, REPORTED, UNVERIFIED-VENDOR -- and all three
 * engagement ceilings are UNVERIFIED-VENDOR: plan 1.4's table has rows for
 * invites, DMs, InMail and profile views, none for these three, and LinkedIn
 * publishes nothing. They are OUR judgement calls, anchored to the one passive
 * kind that does have a reported band, and they are not evidence about
 * LinkedIn's behaviour. The numbers themselves now live in `limits.ts`
 * `LINKEDIN_LIMITS` beside every other band, carrying that reasoning verbatim;
 * `ENGAGEMENT_LIMITS` below is a PROJECTION of that table, not a second copy
 * of it, because two tables of ceilings is one table that eventually disagrees
 * with the other.
 *
 * ONE SEAM REMAINS, named here because nothing else in the tree would remember
 * it: `driver.ts` `LinkedInLocator` exposes no `getAttribute`, so
 * `likeRecentPost` cannot read the liked post's own permalink and records the
 * canonical profile URL in `external_ref` instead. That matches what migration
 * 024 says the column holds; recording the post URN would mean widening the
 * structural Playwright slice first.
 */

/** The three kinds this module owns. */
export type EngagementKind = 'follow' | 'like' | 'endorse';

export const ENGAGEMENT_KINDS: readonly EngagementKind[] = ['follow', 'like', 'endorse'];

export function isEngagementKind(kind: string): kind is EngagementKind {
  return (ENGAGEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The three kinds `limits.ts` `PASSIVE_KINDS` carries beyond `profile_view`.
 *
 * All three, with no exception. A follow, a like and an endorsement are things
 * a member does while reading, not things they send -- nobody has to accept
 * one, none of them consumes an invite, and none produces the acceptance-rate
 * signal that plan 1.3's spam heuristic reads. That is what `PASSIVE_KINDS`
 * means, and it is why the week-1 zero must not touch them.
 */
export const PASSIVE_ENGAGEMENT_KINDS: readonly EngagementKind[] = ENGAGEMENT_KINDS;

/**
 * The three engagement rows of `LINKEDIN_LIMITS`, PROJECTED -- never restated.
 *
 * This is a view over the one diff-reviewable table of ceilings, so an
 * operator who changes the `like` band changes it in the place `limits.ts`'s
 * own header says policy lives, and this module cannot drift from the gate
 * that enforces it. The reasoning behind each number is recorded there, beside
 * the rows it is anchored to.
 *
 * DAILY ONLY, which the projection preserves rather than asserts: `limits.ts`
 * publishes no `perWeek` or `perMonth` for these three, and `guard.ts` already
 * reports an absent weekly or monthly ceiling by saying so out loud -- "No
 * 7-day ceiling is published for X, so none is invented here."
 *
 * The warm-up column is never zero and never can be -- see the invariant
 * asserted in `engagement.test.ts`. A passive kind whose warm-up ceiling
 * floored to zero would defeat the entire point of rule 1 by arithmetic rather
 * than by policy.
 */
export const ENGAGEMENT_LIMITS: Readonly<Record<EngagementKind, Readonly<Record<BandName, LinkedInBand>>>> = {
  follow: LINKEDIN_LIMITS.follow,
  like: LINKEDIN_LIMITS.like,
  endorse: LINKEDIN_LIMITS.endorse
};

/** The band for one engagement kind. `limits.ts` `bandFor`, narrowed. */
export function engagementBandFor(kind: EngagementKind, band: BandName): LinkedInBand {
  return bandFor(kind, band);
}

/** A ledger row for an engagement action. `LinkedInActionRecord` with the kind narrowed. */
export type EngagementRecord = Omit<LinkedInActionRecord, 'kind'> & { kind: EngagementKind };

/**
 * Append an engagement action to `linkedin_actions`.
 *
 * A thin pass-through to `recordAction` on purpose -- it is the same ledger,
 * with the same replay guard and the same `recorded_at` rule, and a second
 * writer would be a second set of those rules to keep in step. What this adds
 * is the narrowed kind.
 *
 * NOTE WHAT THE REPLAY GUARD MEANS FOR A LIKE. The unique index is on
 * (workspace, seat, kind, target_ref), so one seat gets ONE like row per
 * target, ever -- `target_ref` is a person, not a post. That is deliberate for
 * now and it is the conservative direction: repeatedly liking the same
 * stranger's posts is a much stronger automation tell than liking one post
 * each from thirty people. Migration 034 records the same thing.
 */
export function recordEngagement(db: Db, record: EngagementRecord, now: Date): Promise<{ id: string; duplicate: boolean }> {
  return recordAction(db, record, now);
}

/** Engagement actions of `kind` this seat took in the `sinceHours` before `now`. */
export function countEngagementInWindow(
  db: Db,
  seat: SeatRef,
  kind: EngagementKind,
  sinceHours: number,
  now: Date
): Promise<number> {
  return countActionsInWindow(db, seat, kind, sinceHours, now);
}

/** True when this seat already has a non-skipped action of `kind` against `targetRef`. */
export function hasEngagementTarget(
  db: Db,
  seat: SeatRef,
  kind: EngagementKind,
  targetRef: string,
  excludeActionId: string | null = null
): Promise<boolean> {
  return hasTarget(db, seat, kind, targetRef, excludeActionId);
}

/**
 * How many more of `kind` this seat may take in the next 24 hours.
 *
 * The ceiling minus the rolling-24h count, floored at zero. It is a PLANNING
 * number and not a permission: it reads one gate of the several
 * `evaluateLinkedInSafety` runs, so a positive answer here can still be
 * refused there for variance, hours, weekend or duplication. Named `Remaining`
 * rather than `Allowed` for exactly that reason.
 */
export async function engagementRemainingToday(
  db: Db,
  seat: SeatRef,
  kind: EngagementKind,
  band: BandName,
  now: Date
): Promise<number> {
  const used = await countEngagementInWindow(db, seat, kind, 24, now);
  return Math.max(0, engagementBandFor(kind, band).perDay - used);
}

export interface EngagementSafetyInput {
  workspaceId: string;
  seatKey?: string;
  kind: EngagementKind;
  /** Opaque handle or profile URL, as supplied by the operator. */
  targetRef: string;
  /** ISO-8601 instant the action is scheduled for. */
  /** ISO-8601 instant the action is scheduled for. */
  plannedFor: string;
  /**
   * A PERSON clicked this, now.
   *
   * Set by the live request in `app.ts` -- which files the row as
   * `source: 'manual'` -- and by nothing that runs on a schedule. It relaxes
   * the gate's two time checks and nothing else: an operator who follows
   * somebody on a Sunday evening is a person using LinkedIn, and the working
   * window paces what the account does BY ITSELF. Every ceiling still applies,
   * so this is still one follow, counted like every other.
   */
  manual?: boolean;
}

/**
 * Injected collaborators, defaulting to the real ones.
 *
 * `isPaced` is not a knob. It is how this module stays FAIL-CLOSED across the
 * integration edit: until `limits.ts` lists these kinds in `PACED_KINDS` and
 * `LINKEDIN_LIMITS`, `bandFor` has no band to return and calling the gate
 * would throw a TypeError inside a batch that has already claimed a row. Both
 * are injectable so the two worlds -- before the edit and after it -- are
 * assertable today, rather than one of them being a test that starts failing
 * the moment somebody lands the wiring.
 */
export interface EngagementSafetyDeps {
  /** Defaults to `evaluateLinkedInSafety`. */
  evaluate?: typeof evaluateLinkedInSafety;
  /** Defaults to `PACED_KINDS` membership. */
  isPaced?: (kind: string) => boolean;
}

function pacedByDefault(kind: string): boolean {
  return (PACED_KINDS as readonly string[]).includes(kind);
}

/**
 * The channel's own automation statement, mirroring the private helper in
 * `guard.ts`. Duplicated rather than exported from there because it is four
 * lines and the alternative is widening that module's surface for them.
 */
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

/**
 * Run the full LinkedIn safety gate against one proposed engagement action.
 *
 * THE POINT OF THIS FUNCTION IS THAT IT ADDS NO EXCEPTION. It does not filter
 * a verdict, discount a check, or wave an action through because it is
 * "only a like". It is the ordinary gate, called with an engagement kind,
 * because rule 2 says these are paced like everything else. The only thing it
 * contributes is the refusal below.
 *
 * FAIL-CLOSED WHEN THE KIND HAS NO BAND. A kind absent from `PACED_KINDS` has
 * no ceiling for the gate to read, and "I could not find out whether this is
 * safe" is not "it is safe" -- the same rule `local-worker.ts` applies when the
 * gate itself throws. The refusal carries an empty `checks` array because none
 * ran: reporting invented checks would be worse than reporting none.
 */
export async function evaluateEngagementSafety(
  db: Db,
  input: EngagementSafetyInput,
  now: Date,
  options: LinkedInSafetyOptions & EngagementSafetyDeps = {}
): Promise<LinkedInSafetyVerdict> {
  const isPaced = options.isPaced ?? pacedByDefault;
  if (!isPaced(input.kind)) {
    return {
      allowed: false,
      reason: `no-published-band: '${input.kind}' is not in PACED_KINDS, so there is no ceiling to check it against and no verdict to give. Add it to LINKEDIN_LIMITS, PACED_KINDS and PASSIVE_KINDS in limits.ts before scheduling one.`,
      checks: [],
      ...automationOfLinkedIn()
    };
  }

  const evaluate = options.evaluate ?? evaluateLinkedInSafety;
  return evaluate(
    db,
    {
      workspaceId: input.workspaceId,
      seatKey: input.seatKey ?? OWNER_SEAT_KEY,
      kind: input.kind,
      targetRef: input.targetRef,
      plannedFor: input.plannedFor,
      // Carried, not decided here: this module is the gate's caller, not a
      // second gate.
      ...(input.manual === true ? { manual: true } : {})
    },
    now,
    { excludeActionId: options.excludeActionId ?? null }
  );
}
