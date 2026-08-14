import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Gauge, LoaderCircle, Settings2, ShieldCheck, TrendingUp } from 'lucide-react';
import {
  ApiError,
  WARMUP_MULTIPLIERS,
  WARMUP_WEEKS,
  getLinkedInActions,
  getLinkedInLimits,
  getLinkedInManagedCampaigns,
  getLinkedInManagerSeats,
  pauseLinkedInSeat,
  resumeLinkedInSeat,
  updateLinkedInManagerSeat,
  type ExportFormat,
  type LinkedInActionKind,
  type LinkedInActionStatus,
  type LinkedInActionView,
  type LinkedInAnalytics,
  type LinkedInCeiling,
  type LinkedInCeilingSource,
  type LinkedInLimitConfidence,
  type LinkedInLimitsReport,
  type LinkedInOperatorRange,
  type LinkedInSeat,
  type PacedKind,
  type SeatPosture,
  type SequenceTone
} from './api';
import type { ManagedCampaign } from '../server/linkedin/managed-campaigns';
// The account screen owns which account every other screen is looking at, and
// it keeps that in one place so two mounted readers cannot disagree. This
// screen links to that screen per account, so it names the account first.
import { useActiveSeatKey } from './LinkedInAccounts';
import { AcceptanceMeter, ConfidenceTag, LiStat, VolumeChart, WarmupRamp, WindowPicker, type VolumePoint } from './LinkedInViz';
import { ConfirmDrawer } from './ui/dialog';

/**
 * The Safety screen -- the one screen that answers "is my account safe, and
 * why is it not sending more?"
 *
 * It leads with that answer, per LinkedIn account: what the account is doing
 * right now, the ONE thing holding its volume down, and when that lifts. The
 * charts and the full limit table are the evidence underneath it, not the
 * headline -- an operator who has to reconstruct "why is nothing going out"
 * from a variance band has been handed a puzzle instead of an answer.
 *
 * TWO SOURCES, BOTH AUTHORITATIVE, NEITHER SUFFICIENT ALONE.
 *
 * `GET /api/linkedin/limits` computes Trevra's own researched limits, with the
 * rule and the confidence tag that produced each one -- for ONE account, the
 * workspace's first. It knows nothing about the days, the hours and the four
 * per-account ceilings the operator typed, because those live on the account
 * row and are applied by the check that runs immediately before every action.
 * `GET /api/linkedin/manager/seats` has exactly those, for every account.
 *
 * So this screen reads both and labels which number came from where. A screen
 * that showed 08:00-18:00 while the engine enforced 10:00-14:00 Tue/Thu does
 * not merely mislead -- it contradicts the engine, and a screen that
 * contradicts the engine is worse than no screen.
 *
 * It still derives no limit of its own. Where a number is computed server-side
 * for an account this route does not report on, it says so rather than
 * guessing at it, and the few pieces of arithmetic here (which warm-up week an
 * account is in, which day of its ramp a campaign is on) mirror one named
 * server function each and say which.
 */

/* -------------------------------------------------------------------------
 * The vocabulary, in one place.
 *
 * These maps are EXPORTED and every LinkedIn screen reads them, because the
 * alternative -- which is what shipped -- was `profile_view` and `heyreach`
 * rendered raw into a <select> on one screen while this file quietly held a
 * sentence for the same value. The raw identifier stays the option's VALUE:
 * what goes on the wire is unchanged, only what a human reads is.
 * ---------------------------------------------------------------------- */

/** Plural, for a group heading or a filter. */
export const KIND_LABELS: Record<PacedKind, string> = {
  invite: 'Connection invites',
  dm: 'Direct messages',
  reply: 'Replies',
  inmail: 'InMail',
  profile_view: 'Profile views',
  follow: 'Follows',
  like: 'Likes',
  endorse: 'Endorsements'
};

/** Every paced kind, plus the one the ledger records but no sequence schedules. */
export const ACTION_KIND_LABELS: Record<LinkedInActionKind, string> = {
  ...KIND_LABELS,
  comment: 'Comments'
};

/** Singular, for one row in a table, where the plural reads as a count. */
export const ACTION_KIND_LABELS_ONE: Record<LinkedInActionKind, string> = {
  invite: 'Invite',
  dm: 'Message',
  reply: 'Reply',
  inmail: 'InMail',
  profile_view: 'Profile view',
  comment: 'Comment',
  follow: 'Follow',
  like: 'Like',
  endorse: 'Endorsement'
};

export const ACTION_STATUS_LABELS: Record<LinkedInActionStatus, string> = {
  planned: 'Planned',
  /* NAMED AFTER WHAT PUT IT THERE, because 'Held' alone is the wrong word
     twice over. This subsystem already says "held back" about an action a
     safety check refused -- a thing that will never happen -- and a held row
     is the opposite of that: it is intact, in order, and waiting on a human.
     And a reader meeting this chip has almost always just pressed Pause, so
     the label has to connect to the button they pressed.
     `pauseManagedCampaign` (migration 051) is the only writer of this status
     and resuming is the only thing that clears it back to 'planned'. */
  held: 'Held by pause',
  exported: 'Exported',
  sent: 'Sent',
  accepted: 'Accepted',
  replied: 'Replied',
  declined: 'Declined',
  skipped: 'Skipped',
  withdrawn: 'Withdrawn'
};

/**
 * A status the ledger holds and this map does not, spelled rather than blanked.
 *
 * THE TWO CASES THIS FALLBACK WAS WRITTEN FOR ARE BOTH CLOSED NOW, and the
 * history is why it stays. `withdrawn` (migration 032) and then `held` (051)
 * each spent a release being written into `linkedin_actions.status` and
 * counted by `campaigns.ts` while `LinkedInActionStatus` in
 * src/server/linkedin/actions.ts named neither -- so each arrived at every
 * reader typed as something it demonstrably was not, and this table had no
 * entry for it. `held` was the more expensive of the two: the operator meeting
 * it has just paused a campaign and is looking straight at these rows to find
 * out what the pause did.
 *
 * The union names both today, so this map is exhaustive and the compiler is
 * what keeps it that way -- the next status is a type error here rather than
 * an audit. What the fallback still covers is the window between the ledger
 * writing a value and a deployed client having learned it, and there a table
 * cell reading `undefined` beside an invite is worse than one reading the raw
 * word.
 */
export const actionStatusLabel = (status: LinkedInActionStatus): string =>
  ACTION_STATUS_LABELS[status] ?? String(status).replaceAll('_', ' ');

/** The competitors' own spelling of their own names. `generic` is ours. */
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  dripify: 'Dripify',
  heyreach: 'HeyReach',
  expandi: 'Expandi',
  generic: 'Generic CSV'
};

export const TONE_LABELS: Record<SequenceTone, string> = {
  direct: 'Direct',
  consultative: 'Consultative',
  peer: 'Peer to peer'
};

const WINDOW_LABELS = { day: 'any 24 hours', week: 'any 7 days', month: 'any 30 days' } as const;

/**
 * The three kinds ONE operator “messages” number counts together.
 *
 * Mirrors `MESSAGE_POOL_KINDS` in src/server/app.ts, which is the list the
 * limits route appends its pool note from and the list `guard.ts` counts the
 * operator's pool over.
 */
const MESSAGE_POOL_KINDS: readonly PacedKind[] = ['dm', 'reply', 'inmail'];

export const humanizeRule = (boundBy: string) => boundBy.replaceAll('-', ' ');

/**
 * One sentence out of whatever was thrown, or the caller's fallback.
 *
 * Exported because all three outreach files render the same class of failure,
 * and a third copy of this three-line function is a third place for the
 * wording to drift.
 */
export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

/* -------------------------------------------------------------------------
 * Refresh, from the shell.
 *
 * Refresh used to sit on the LinkedIn tab strip and call the one parent that
 * owned every screen's data. There is no such parent now -- each screen is its
 * own hash route and reads for itself -- so the button became a broadcast: the
 * shell calls `reloadOutreach()`, every mounted screen re-reads, and the
 * promise settles when the slowest of them has, which is what a spinner on
 * that button may be bound to.
 *
 * Nothing here holds a screen's data. It holds only the intent to re-read, so
 * a screen that is not mounted is simply not called.
 * ---------------------------------------------------------------------- */

type RefreshHandler = () => unknown;

const refreshHandlers = new Set<RefreshHandler>();

/** The shell's Refresh affordance. Resolves once every mounted screen has re-read. */
export async function reloadOutreach(): Promise<void> {
  await Promise.allSettled([...refreshHandlers].map((handler) => handler()));
}

/* -------------------------------------------------------------------------
 * Targets, handed from one screen to another.
 *
 * Lead sourcing produces a list of people; the campaign builder is where a
 * list of people becomes something. There is no route between them -- a
 * campaign's targets are set when it is created and no API amends them -- so
 * the handoff is a client one, and it lives here for the same reason
 * `reloadOutreach` does: this module is the channel between outreach screens,
 * and a second copy of it in either screen would be a second place for the
 * two ends to drift.
 *
 * IN MEMORY, NOT IN STORAGE, and taken exactly once. A reload clears it, which
 * is right: a list staged three days ago silently pre-filling a campaign form
 * is worse than an empty one. Nothing here writes anything to the server.
 * ---------------------------------------------------------------------- */

let stagedTargets: string[] = [];

/** Hand a list to the campaign builder. Replaces whatever was staged before. */
export function stageTargets(targets: readonly string[]): void {
  stagedTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
}

/** Read the staged list and clear it. Empty when nothing was staged. */
export function takeStagedTargets(): string[] {
  const taken = stagedTargets;
  stagedTargets = [];
  return taken;
}

/**
 * Re-read this screen when the shell asks, or when another screen changed the
 * ledger underneath it.
 *
 * The handler is held in a ref so a caller may pass a fresh closure every
 * render -- which is what a component reading its own filter state does --
 * without re-arming the subscription.
 */
export function useOutreachRefresh(reload: RefreshHandler): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const handler: RefreshHandler = () => latest.current();
    refreshHandlers.add(handler);
    return () => { refreshHandlers.delete(handler); };
  }, []);
}

/* -------------------------------------------------------------------------
 * The ceilings, read once per screen.
 * ---------------------------------------------------------------------- */

export interface SeatLimitsRead {
  /** Null until the first read lands, and after a first read that failed. */
  limits: LinkedInLimitsReport | null;
  /** True during the first read and during every re-read after it. */
  loading: boolean;
  /** The failed read, with what to do about it. Empty when the last one worked. */
  error: string;
  reload: () => Promise<void>;
}

/**
 * `GET /api/linkedin/limits`, for any screen that prices something.
 *
 * Each screen calls this rather than being handed a report by a parent,
 * because there is no longer a parent that could hand it one -- and because a
 * screen that cannot be opened on its own URL is not a route. The route stays
 * the single source of provenance: this hook derives no ceiling of its own,
 * and what it could not read stays null rather than rendering as zero.
 */
export function useSeatLimits(): SeatLimitsRead {
  const [limits, setLimits] = useState<LinkedInLimitsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setLimits(await getLinkedInLimits());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read this seat’s ceilings. Nothing was changed — try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useOutreachRefresh(reload);

  return { limits, loading, error, reload };
}

/* -------------------------------------------------------------------------
 * The stop, handed to the shell.
 *
 * The kill switch used to sit above the LinkedIn tab strip, and the rule
 * written over it was that IT MUST ALWAYS BE REACHABLE: the one moment it is
 * needed is the moment something else has already gone wrong, and a switch
 * somebody has to navigate to is a switch they find too late. Outreach is no
 * longer one screen with a strip over it, so that rule promotes one level --
 * out of this file and into the app shell's `StopBar`, which is on every route
 * and which also stops the agent's own runs. Two kill switches in two visual
 * languages, neither admitting the other existed, is the failure that fixes.
 *
 * What this module still owns is the SEAT half: its state, its two calls, and
 * every sentence written for them. The shell renders. It decides nothing about
 * the seat and it writes no copy of its own.
 * ---------------------------------------------------------------------- */

/**
 * Every string the kill switch owned, verbatim, for the shell to render.
 *
 * Copy travels with the thing it describes. A pause reason demanded in one
 * file and the sentence explaining why kept in another is how two kill
 * switches drifted apart in the first place.
 */
/**
 * The acceptance throttle, in words, from the factor the server actually sent.
 *
 * `signals.acceptance.throttleFactor` is 0.5 today and five sentences on this
 * screen wrote that 0.5 out as "halves" or "halved" in prose -- five copies of
 * a server constant in five places the server cannot reach, every one of which
 * would have gone on saying "halves" the day the factor moved. The factor is
 * in the payload the screen already holds, so it is read.
 *
 * The object is taken as an argument rather than appended by the caller
 * because the non-half phrasing needs it in the middle of the clause: "cuts
 * the volume to 30% of it", not "cuts to 30% the volume".
 */
const throttleVerb = (factor: number | null, object: string, past = false) =>
  factor === null ? `${past ? 'reduced' : 'reduces'} ${object}`
    : factor === 0.5 ? `${past ? 'halved' : 'halves'} ${object}`
      : `${past ? 'cut' : 'cuts'} ${object} to ${Math.round(factor * 100)}% of it`;

/** The same decision quoted as an imperative, for “X would quietly become end it”. */
const throttleImperative = (factor: number | null) =>
  factor === null ? 'reduce it' : factor === 0.5 ? 'halve it' : `cut it to ${Math.round(factor * 100)}%`;

export const SEAT_STOP_COPY = {
  /** The verb for an IMMEDIATE stop. Never used over the agent, whose stop is cooperative. */
  // Not "Pause everything": this stops the seat, and it now shares a bar with a
  // button that really does stop everything.
  pauseLabel: 'Pause outreach',
  resumeLabel: 'Resume outreach on this seat',
  reasonPlaceholder: 'Why are you stopping?',
  reasonFieldLabel: 'Reason for pausing',
  /** Enforced by `pause()` below, not merely printed. */
  reasonRequired: 'Say why. This is the note you will read three weeks from now.',
  running: 'Stop everything at once. Ceilings drop to zero, the worker halts within one tick, and a campaign already in a browser is the only thing that finishes.',
  paused: (reason: string | null) =>
    `Everything is stopped${reason ? `: ${reason}` : '.'} No slot will be scheduled and the local worker halts within one tick.`,
  /*
   * THERE IS DELIBERATELY NO `unconfigured` STRING HERE.
   *
   * One lived here -- "No seat is configured yet, so there is nothing to pause"
   * -- and shell section 3.6 retired it: the StopBar's idle state says
   * "Nothing is running" for every actor at once, which is true whether or not
   * a seat was ever configured and does not dead-end on a screen the operator
   * has not reached yet. It survived the retirement as a key with zero
   * references, which is a sentence nobody can read and nobody can find to
   * delete. The reasoning is worth keeping; the dead string is not.
   */
  pausedToast: 'Seat paused. Every ceiling is now zero and nothing will be scheduled.',
  resumedToast: 'Seat resumed. The warm-up ramp picks up where it left off — it is measured from when this seat started sending through Trevra, so resuming does not restart it.',
  pauseFailed: 'Unable to pause the seat. Nothing changed — the seat is still running. Try again, or stop the campaigns individually on Campaigns.',
  resumeFailed: 'Unable to resume the seat. It is still paused, which is the safe end of that failure. Try again.',
  /**
   * Pausing is protective and reversible; resuming puts real invites back on a
   * real account. The reason field was on the way DOWN only, so the cheap
   * direction was the guarded one. Both are guarded, and the expensive one is
   * the one that opens a drawer.
   */
  resume: {
    title: 'Resume outreach on this seat?',
    confirmLabel: 'Resume outreach on this seat',
    whatRestarts: (reason: string | null) =>
      'Real invites and messages start going out again, on the LinkedIn account this seat signs in as.'
      + (reason ? ` It was stopped because: ${reason}.` : ''),
    warmupKeeps: 'The warm-up ramp picks up where it left off — it is measured from when this seat started sending through Trevra, so resuming does not restart it.',
    /*
     * NO REASON FIELD ON THE WAY UP, AND THAT IS THE HONEST END OF IT.
     *
     * The drawer used to demand one. `POST /api/linkedin/seat/resume` parses
     * `linkedinSeatSelectorSchema` -- `seatKey` and nothing else -- and
     * `resumeLinkedInSeat` in api.ts sends nothing else, so the sentence the
     * operator was made to type before the button unlocked reached no call,
     * no column and no reader. A required field that is thrown away is worse
     * than no field: it teaches that the notes on this screen are decorative,
     * and the pause reason -- which IS stored, and IS the note read three
     * weeks later -- is one of them.
     *
     * So the confirmation still stops before the expensive direction and still
     * says what restarts; it just no longer asks for something it cannot keep.
     *
     * lc-debt: resuming leaves no record while pausing does; upgrade path is a
     * `reason` on that route stored beside `pausedReason`, at which point this
     * drawer takes `requireReason` back and passes the argument through.
     */
    noRecord: 'Pausing left a note; resuming does not. There is nowhere to store one on the way up — the pause reason it replaces is what the ledger keeps.'
  },
  /**
   * Why a human is the only thing that may cut a seat to zero.
   *
   * The acceptance throttle halves volume and never zeroes it, and the reason
   * is not caution: a seat cut to zero can never produce the outcomes that
   * would clear the throttle, so “halve it” would quietly become “end it”.
   * Ending a seat is a decision for a human, and this control is that
   * decision -- which is exactly why it demands a reason.
   */
  onlyAHumanZeroesASeat: (throttleFactor: number | null) =>
    `Trevra never cuts this seat to zero on its own. Below the acceptance floor it ${throttleVerb(throttleFactor, 'the volume')}, because a seat cut to zero can never produce the outcomes that would clear the throttle — “${throttleImperative(throttleFactor)}” would quietly become “end it”. Ending a seat is a decision for a human, and this is that decision.`
} as const;

export interface SeatStop {
  /** False when no seat exists: there is nothing to stop and nothing to resume. */
  configured: boolean;
  paused: boolean;
  posture: LinkedInLimitsReport['seat']['posture'];
  /** The note taken on the way down. Null while the seat is running. */
  pausedReason: string | null;
  /** True while the seat's state is being read. */
  loading: boolean;
  /** True while a pause or a resume is on the wire. */
  busy: boolean;
  /** The read failed; everything above it is the last good one. */
  readError: string;
  /** The pause or resume failed. Each of these names what did NOT change. */
  failure: string;
  /**
   * What the acceptance throttle multiplies volume by, for the one sentence the
   * shell renders about it. Null until the first read lands -- the copy then
   * says “reduces” rather than naming a number nobody sent.
   */
  throttleFactor: number | null;
  /** Refuses an empty reason before the wire and answers false. */
  pause: (reason: string) => Promise<boolean>;
  resume: () => Promise<boolean>;
  clearFailure: () => void;
  reload: () => Promise<void>;
}

/**
 * The seat half of the shell's stop control.
 *
 * It consults nothing -- not the plan, not the ledger, not the worker -- for
 * the same reason the server route does not: the one moment it is needed is
 * the moment something else is already wrong. The reason is required rather
 * than defaulted because “why is this stopped” three weeks later is the
 * question the column exists to answer, and it is enforced HERE so that a
 * shell which forgot to render the field still cannot pause without one.
 */
export function useSeatStop(): SeatStop {
  const { limits, loading, error, reload } = useSeatLimits();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const seat = limits?.seat ?? null;

  const pause = useCallback(async (reason: string) => {
    if (!reason.trim()) { setFailure(SEAT_STOP_COPY.reasonRequired); return false; }
    setBusy(true);
    setFailure('');
    try {
      await pauseLinkedInSeat(reason.trim());
      // Every mounted outreach screen is now describing a seat that stopped.
      await reloadOutreach();
      return true;
    } catch (err) {
      setFailure(errorMessage(err, SEAT_STOP_COPY.pauseFailed));
      return false;
    } finally { setBusy(false); }
  }, []);

  const resume = useCallback(async () => {
    setBusy(true);
    setFailure('');
    try {
      await resumeLinkedInSeat();
      await reloadOutreach();
      return true;
    } catch (err) {
      // The caller keeps its drawer open on a failure: closing it would leave
      // the operator unable to tell whether outreach restarted.
      setFailure(errorMessage(err, SEAT_STOP_COPY.resumeFailed));
      return false;
    } finally { setBusy(false); }
  }, []);

  return {
    configured: Boolean(seat?.configured),
    paused: seat?.posture === 'paused',
    posture: seat?.posture ?? null,
    pausedReason: seat?.pausedReason ?? null,
    loading,
    busy,
    readError: error,
    failure,
    throttleFactor: limits?.signals.acceptance.throttleFactor ?? null,
    pause,
    resume,
    clearFailure: () => setFailure(''),
    reload
  };
}
/* =========================================================================
 * The account's own configuration, read per account.
 *
 * Everything below mirrors ONE named server function each, and says which.
 * These are clocks and calendars, not limits: no ceiling is invented here.
 * ====================================================================== */

const DAY_MS = 86_400_000;

/**
 * The account `GET /api/linkedin/limits` reports on.
 *
 * Mirrors `OWNER_SEAT_KEY` in src/server/linkedin/seats.ts -- the key every
 * workspace's first account uses and the default that route takes. A second
 * account is paced by the same engine; that route simply does not publish its
 * numbers, and this screen says so on those panels rather than guessing.
 */
const PRIMARY_ACCOUNT_KEY = 'owner';

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Where a number came from, in words rather than in a file path. */
const sourceLabel = (confidence: LinkedInLimitConfidence) =>
  confidence === 'HARD FACT' ? 'published by LinkedIn' : 'measured by practitioners';

/** Mirrors `formatMinuteOfDay` in src/server/linkedin/pacing.ts. */
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * A moment, in the account's own clock when we know it.
 *
 * Everything else in an account panel is stated in that account's timezone --
 * "tomorrow at 10:00, Europe/Zurich" -- so a date rendered in the reader's
 * zone beside it would read as the account's and be an hour or a day out.
 */
function moment(at: number, timezone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, timezone ? { ...options, timeZone: timezone } : options).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(at));
  }
}

/**
 * Which warm-up week an account is in, 1-based.
 *
 * Mirrors `warmupWeekOf` in src/server/linkedin/seats.ts -- the ramp clock the
 * engine itself reads. An account with no start instant is week 1: the most
 * restrictive answer, and the right one when we do not know.
 */
function warmupWeekOf(activatedAt: string | null, now: number): number {
  if (!activatedAt) return 1;
  const activated = Date.parse(activatedAt);
  if (Number.isNaN(activated)) return 1;
  const days = Math.floor((now - activated) / DAY_MS);
  if (days < 0) return 1;
  return Math.floor(days / 7) + 1;
}

/** Mirrors `warmupMultiplier` in src/server/linkedin/limits.ts. Past the ramp is 1.0. */
const warmupMultiplierOf = (week: number) => (week < 1 ? WARMUP_MULTIPLIERS[0] : WARMUP_MULTIPLIERS[week - 1] ?? 1);

/** When `week` ends and the next one starts. Null when the clock is unknown or the ramp is over. */
function warmupWeekEndsAt(activatedAt: string | null, week: number): number | null {
  const activated = activatedAt ? Date.parse(activatedAt) : NaN;
  if (Number.isNaN(activated) || week > WARMUP_WEEKS) return null;
  return activated + week * 7 * DAY_MS;
}

/**
 * The status that actually applies, for an account this screen had to work it
 * out for. Mirrors `effectivePosture` in src/server/linkedin/seats.ts: a
 * human's pause or slow-down stands, everything else follows the ramp clock,
 * because warming-up-versus-running is a fact about the account and not a
 * preference about it.
 */
function statusOf(row: LinkedInSeat, now: number): SeatPosture {
  if (row.posture === 'paused' || row.posture === 'cooldown') return row.posture;
  return warmupWeekOf(row.activatedAt, now) > WARMUP_WEEKS ? 'steady' : 'warmup';
}

interface CampaignRamp {
  /** 1-based day since the campaign started. */
  day: number;
  /** What fraction of the account's daily ceiling this campaign may use today. */
  fraction: number;
  /** How many days the ramp lasts, counted off the server's own list. */
  steps: number;
  /** When the next step arrives. Null once the campaign is at full speed. */
  nextStepAt: number | null;
}

/**
 * The campaign's own ramp, READ off `campaignWarmupFractions` rather than
 * re-derived.
 *
 * The arithmetic used to live here as `Math.min(1, Math.max(0.2, day * 0.2))`
 * -- a second copy of `campaignWarmupFraction` in managed-campaigns.ts, right
 * only by coincidence, and able to drift in exactly one direction: a screen
 * promising a day-one number larger than what the runner would actually send.
 * The limits route now publishes the ramp asked of the function that applies
 * it, so this counts the days and looks the fraction up.
 *
 * It is still a different clock from the account ramp above -- that one counts
 * weeks since the ACCOUNT started sending through Trevra, this one counts days
 * since THIS CAMPAIGN started -- and both apply at once.
 */
function campaignRampOf(startedAt: string | null, now: number, fractions: readonly number[]): CampaignRamp | null {
  if (!startedAt || fractions.length === 0) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const day = start > now ? 1 : Math.floor((now - start) / DAY_MS) + 1;
  // Past the end of the published ramp is full speed, which is what the last
  // entry always is -- the server walks the ramp until it reaches 1.
  const fraction = fractions[Math.min(day, fractions.length) - 1] ?? 1;
  return { day, fraction, steps: fractions.length, nextStepAt: fraction < 1 ? start + day * DAY_MS : null };
}

/** Now, in one account's own clock. Null when the runtime does not know the timezone. */
function accountClock(timezone: string, now: number): { weekday: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(now));
    const weekday = WEEKDAY_SHORT.indexOf(parts.find((part) => part.type === 'weekday')?.value as typeof WEEKDAY_SHORT[number]);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    // Some ICU builds render midnight as hour 24 under hour12: false.
    return { weekday, minute: (hour % 24) * 60 + minute };
  } catch { return null; }
}

type HoursState =
  | { state: 'never' }
  | { state: 'unknown' }
  | { state: 'open'; until: string }
  | { state: 'closed'; opens: string };

/**
 * Whether this account may act at this moment, in its own clock.
 *
 * The same window `pacing.ts` places actions inside and `guard.ts` refuses
 * them outside -- `workWindowOf(seat)` there, the account's own row here.
 */
function hoursStateOf(row: LinkedInSeat, now: number): HoursState {
  if (row.workingDays.length === 0) return { state: 'never' };
  const local = accountClock(row.timezone, now);
  if (!local) return { state: 'unknown' };
  if (row.workingDays.includes(local.weekday) && local.minute >= row.workStartMinute && local.minute < row.workEndMinute) {
    return { state: 'open', until: clock(row.workEndMinute) };
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const weekday = (local.weekday + offset) % 7;
    if (!row.workingDays.includes(weekday)) continue;
    if (offset === 0 && local.minute >= row.workStartMinute) continue;
    const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : WEEKDAY_LONG[weekday];
    return { state: 'closed', opens: `${when} at ${clock(row.workStartMinute)}` };
  }
  return { state: 'never' };
}

/** The days an account works, in the operator's own order: Mon first, Sunday last. */
const workingDaysLabel = (days: readonly number[]) =>
  [1, 2, 3, 4, 5, 6, 0].filter((day) => days.includes(day)).map((day) => WEEKDAY_SHORT[day]).join(', ');

/**
 * The window Trevra falls back to when no account is configured, from the
 * payload rather than from a literal.
 *
 * Two places on this screen state this same fact, and one of them wrote
 * “08:00-18:00, Mon-Fri” as text while the other rendered
 * `signals.rhythm.businessHours`. Per-account working windows are configurable
 * and the fallback is a server constant, so a literal here is not merely a
 * duplicate -- it is a number that can be flatly, silently wrong, on the one
 * screen whose entire job is to be the number that is actually enforced.
 *
 * Mon-Fri is not a literal either: `weekendFactor` at 0 IS “weekends are left
 * empty”, and a non-zero one means the fallback works them at reduced volume,
 * so the sentence follows the factor.
 */
const fallbackWindowLabel = (rhythm: LinkedInLimitsReport['signals']['rhythm']) =>
  `${clock(rhythm.businessHours.start * 60)}–${clock(rhythm.businessHours.end * 60)}${rhythm.weekendFactor === 0 ? ', Mon–Fri' : ', every day'}`;

/* -------------------------------------------------------------------------
 * The per-account read.
 * ---------------------------------------------------------------------- */

/**
 * Statuses that never happened, so never consume a ceiling. Mirrors
 * `UNCOUNTED_STATUSES` in src/server/linkedin/actions.ts -- the value form of
 * the `COUNTED` predicate every window query in the engine bills against.
 *
 * 'held' WAS MISSING HERE AND THAT MADE THIS SCREEN OVERCOUNT. A held row is a
 * planned row a pause parked (migration 051): never claimed, never sent, and
 * excluded server-side by `status NOT IN ('planned','held','skipped')`. Read
 * as spent, it would tell an operator "18 of 20 used" about an account whose
 * campaigns are all paused -- on the one screen whose entire job is to be the
 * number that is actually enforced.
 *
 * `countLast24h` below also demands a `recordedAt`, which a held row does not
 * carry, so the omission was covered by two lines happening to sit next to
 * each other. actions.ts records at length why that is a coincidence and not a
 * rule; this list states the rule instead of leaning on it.
 */
const UNCOUNTED_STATUSES: readonly LinkedInActionStatus[] = ['planned', 'held', 'skipped'];

/**
 * The most rows `GET /api/linkedin/actions` will hand back, mirroring the
 * `max(500)` on `linkedinActionFiltersSchema` in src/server/app.ts.
 *
 * There is no cursor on that route, so this is a HARD ceiling on what this
 * screen can count for itself -- and a full page is therefore not a count, it
 * is a floor. The read below treats a full page as “not counted” rather than
 * as a number, because an undercount rendered as an exact figure is the one
 * failure this screen cannot afford: an operator reading “12 of 30 used” and
 * deciding to send more.
 *
 * lc-debt: an account past 500 counted actions in the 48-hour window reports
 * “not counted” instead of a number; upgrade path is a per-account 24h count
 * route, which `effectiveLinkedInLimits` already computes for the one account
 * it covers.
 */
const ACTION_READ_LIMIT = 500;

/** What this account actually did in the last 24 hours, counted the way the engine counts it. */
function countLast24h(actions: readonly LinkedInActionView[], now: number): Partial<Record<LinkedInActionKind, number>> {
  const since = now - DAY_MS;
  const counts: Partial<Record<LinkedInActionKind, number>> = {};
  for (const action of actions) {
    if (UNCOUNTED_STATUSES.includes(action.status)) continue;
    const at = action.recordedAt ? Date.parse(action.recordedAt) : NaN;
    if (!Number.isFinite(at) || at <= since) continue;
    counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  }
  return counts;
}

interface AccountTruth {
  accounts: LinkedInSeat[];
  campaigns: ManagedCampaign[];
  /**
   * Account key -> what it did in the last 24h. Absent for the account the
   * limits report already counts, and absent for one whose read hit the
   * route's row cap -- see `ACTION_READ_LIMIT`.
   */
  usage: Map<string, Partial<Record<LinkedInActionKind, number>>>;
  /** The read failed. Trevra's own limits still render; the operator's settings do not. */
  error: string;
}

/**
 * Every LinkedIn account, as configured, plus what each one has done today.
 *
 * The limits route answers for the first account only, so the second read is
 * not a nicety: the days, the hours and the four ceilings an operator set are
 * enforced at execution and exist nowhere in that report.
 */
function useAccountTruth(): AccountTruth {
  const [accounts, setAccounts] = useState<LinkedInSeat[]>([]);
  const [campaigns, setCampaigns] = useState<ManagedCampaign[]>([]);
  const [usage, setUsage] = useState<Map<string, Partial<Record<LinkedInActionKind, number>>>>(new Map());
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const [rows, managed] = await Promise.all([getLinkedInManagerSeats(), getLinkedInManagedCampaigns()]);
      setAccounts(rows);
      setCampaigns(managed);
      // Only for the accounts the limits report does not count. A 48-hour read
      // filtered down to 24 here: the route's own window bound is the action's
      // planned moment, which can sit a day before the moment it happened.
      //
      // Bounded at BOTH ends, which the read that shipped was not. That route
      // orders newest first and caps at `ACTION_READ_LIMIT`, so an open upper
      // bound spent the whole page on rows planned for next week -- rows that
      // are `planned`, are in `UNCOUNTED_STATUSES`, and could never contribute
      // to a count -- while the rows from the last 24 hours fell off the end.
      const now = Date.now();
      const since = new Date(now - 2 * DAY_MS).toISOString();
      const until = new Date(now).toISOString();
      const counted = await Promise.all(rows
        .filter((row) => row.seatKey !== PRIMARY_ACCOUNT_KEY)
        .map(async (row) => {
          const actions = await getLinkedInActions({ seatKey: row.seatKey, from: since, to: until, limit: ACTION_READ_LIMIT });
          // A FULL PAGE IS NOT A COUNT. There is no cursor, so a page that came
          // back full is a floor and every “used” figure derived from it would
          // undercount while reading as exact. The screen already knows how to
          // say “this could not be counted”, and that is the true answer here.
          return [row.seatKey, actions.length >= ACTION_READ_LIMIT ? null : countLast24h(actions, now)] as const;
        }));
      setUsage(new Map(counted.filter(
        (entry): entry is readonly [string, Partial<Record<LinkedInActionKind, number>>] => entry[1] !== null
      )));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read how these accounts are set up. Nothing was changed — try again.'));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useOutreachRefresh(reload);

  return { accounts, campaigns, usage, error };
}

/* =========================================================================
 * The screen.
 * ====================================================================== */

/** One account, normalised across the two reads that describe it. */
interface AccountView {
  key: string;
  label: string;
  status: SeatPosture | null;
  pausedReason: string | null;
  /** Null when only the limits report could be read: no days, hours or ceilings. */
  config: LinkedInSeat | null;
  /** True for the one account `GET /api/linkedin/limits` reports on. */
  primary: boolean;
}

export function LinkedInSafetyScreen({ limits, analytics, days, onDaysChange, seriesLoading }: {
  limits: LinkedInLimitsReport;
  analytics: LinkedInAnalytics | null;
  days: number;
  onDaysChange: (days: number) => void;
  seriesLoading: boolean;
}) {
  const { seat, signals } = limits;
  const { accounts, campaigns, usage, error: configError } = useAccountTruth();
  const now = Date.now();

  const views: AccountView[] = accounts.length > 0
    ? accounts.map((row) => ({
      key: row.seatKey,
      label: row.label,
      status: row.seatKey === PRIMARY_ACCOUNT_KEY && seat.posture ? seat.posture : statusOf(row, now),
      pausedReason: row.pausedReason,
      config: row,
      primary: row.seatKey === PRIMARY_ACCOUNT_KEY && seat.configured
    }))
    : seat.configured
      ? [{
        key: PRIMARY_ACCOUNT_KEY,
        label: seat.label ?? 'This LinkedIn account',
        status: seat.posture,
        pausedReason: seat.pausedReason,
        config: null,
        primary: true
      }]
      : [];

  // Nothing to answer for. Four em dashes, an empty chart and a warm-up ramp
  // for an account that does not exist reads as a broken product rather than
  // an unconfigured one.
  if (views.length === 0) {
    return <div className="page-stack li-viz">
      <section className="page-panel">
        <div className="empty-state">
          <Gauge size={28} />
          <h4 aria-level={2}>No LinkedIn account is set up yet</h4>
          <p>
            Every number on this screen describes one real account — its days, its hours, its limits and what it has
            already done today. Until there is an account, there is nothing here that would be true.
          </p>
          {/* A real link, not a callback: the account lives on its own route,
              so "go and set one up" is a URL a teammate can be sent. */}
          <a className="primary-button" href="#/setup/seat" style={{ textDecoration: 'none' }}>
            <Settings2 size={15} /> Set up the account
          </a>
        </div>
      </section>
    </div>;
  }

  const hardFacts = limits.limits.filter((limit) => limit.confidence === 'HARD FACT').length;
  const primaryLabel = views.find((view) => view.primary)?.label ?? seat.label ?? 'this account';
  /** LinkedIn's published InMail quota, from the band table rather than from a literal. */
  const inmailMonth = limits.bands.inmail.perMonth ?? null;

  const points: VolumePoint[] = (analytics?.series ?? []).map((day) => ({
    date: day.date,
    // What provably went out. `exported` is a row in a file the operator has
    // not necessarily run yet, so counting it as volume would inflate the one
    // series the day-to-day change limit is measured against.
    //
    // `accepted` ALREADY CONTAINS `replied`. The server counts it as
    // `status IN ('accepted','replied')` -- `funnelSelect` in
    // src/server/linkedin/campaigns.ts -- and an action row carries exactly one
    // status, so the three buckets are not disjoint. Adding `replied` on top
    // counted a replied invite THREE times and every accepted one twice, which
    // inflated the series and then drew the day-over-day variance band against
    // the inflated version of it: the chart that exists to show a steady line
    // was the least steady thing on the screen, and it moved most on the days
    // outcomes were reported rather than the days work went out.
    volume: day.sent + day.accepted,
    planned: day.planned
  }));

  const byKind = new Map<PacedKind, LinkedInCeiling[]>();
  for (const limit of limits.limits) {
    const bucket = byKind.get(limit.kind) ?? [];
    bucket.push(limit);
    byKind.set(limit.kind, bucket);
  }

  return <div className="page-stack li-viz">

    {configError && <div className="li-warn-block">
      <CircleAlert size={18} />
      <div>
        <strong>Your own settings for these accounts could not be read.</strong>
        <p>
          {configError} What is below is Trevra’s half of the limits only — the working days, the hours and the four
          per-account ceilings you set are missing from it, and they are enforced whether or not this screen can show them.
        </p>
      </div>
    </div>}

    {views.map((view) => <AccountPanel
      key={view.key}
      account={view}
      report={view.primary ? limits : null}
      ranges={limits.operatorRanges}
      fallbackWindow={fallbackWindowLabel(signals.rhythm)}
      campaigns={campaigns.filter((campaign) => campaign.seatKey === view.key)}
      campaignFractions={limits.campaignWarmupFractions}
      used={view.primary ? null : usage.get(view.key) ?? null}
      now={now}
    />)}

    {/* The honesty rule, stated once, before the evidence. */}
    <section className="li-honesty">
      <CircleAlert size={20} />
      <div>
        <strong>
          {hardFacts === 1 ? 'One limit here is published by LinkedIn.' : `${hardFacts} limits here are published by LinkedIn.`}
          {' '}Every other one was measured by people running their own accounts.
        </strong>
        {/* The InMail month is the one HARD FACT in the table and it was the one
            number written out as a literal beside the tag that says so. It is
            in `bands.inmail.perMonth`, in the same payload this screen is
            already holding, so it is read from there — and when the payload has
            no monthly figure for InMail the sentence simply does not claim one
            rather than falling back to a number nobody sent. */}
        <p>
          LinkedIn publishes the InMail quota{inmailMonth === null ? '' : <> — <b>{inmailMonth} a month</b> on a Sales
          Navigator seat</>} — and the one after that is refused by LinkedIn, not by Trevra. It publishes no invite limit
          at all. Everything else here is practitioner telemetry: the daily and weekly numbers, both warm-ups, the
          {' '}{Math.round(signals.dayOverDay.maxDelta * 100)}% day-to-day change limit and the
          {' '}{Math.round(signals.acceptance.floor * 100)}% acceptance floor. It is directionally right and it is not a
          guarantee — LinkedIn can restrict an account that stayed inside every number on this screen. You are betting
          your own account; the tags say which numbers are which.
        </p>
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>How much went out each day</h3>
          <p>
            A steady line is what keeps an account alive. A quiet week followed by a busy Monday is the shape LinkedIn
            restricts accounts for, so no day may differ from the last worked day by more than
            {' '}{Math.round(signals.dayOverDay.maxDelta * 100)}%, up or down.
          </p>
        </div>
        <ConfidenceTag confidence={signals.dayOverDay.confidence} source={sourceLabel(signals.dayOverDay.confidence)} />
      </div>
      <WindowPicker days={days} onDaysChange={onDaysChange} loading={seriesLoading} />
      {points.length === 0
        ? <p className="empty-copy">Nothing has been recorded in this window, so there is no volume to chart. The shaded range appears once this account has two worked days of history.</p>
        : <VolumeChart points={points} maxDelta={signals.dayOverDay.maxDelta} minRampStep={signals.dayOverDay.minRampStep}
          caption={`Actions that went out per day, last ${analytics?.windowDays ?? points.length} days`} />}
      <p className="panel-note">
        A step up is measured against the last day this account actually worked — days off and weekends are skipped, not
        counted as zero. The smallest step up allowed is {signals.dayOverDay.minRampStep} action a day, so an account
        sitting at zero is not frozen by a percentage of zero.{' '}
        {/* “The reported trigger is 50%” used to be typed out here with nothing
            behind it — no field, no tag, no way to tell whether it was still
            true. It is a real figure and it lives in exactly one place, the
            server's own rule sentence, which carries the caveat with it. That
            sentence is rendered instead of a literal restating half of it. */}
        {signals.dayOverDay.rule}{' '}
        {/* WHICH DAY EACH COLUMN IS, said rather than assumed. `linkedinAnalytics`
            in src/server/linkedin/campaigns.ts groups this series into UTC
            calendar days and hands back one total per day, so the client holds
            buckets and not the moments inside them — see `dayLabel` in
            LinkedInViz for why the labels are pinned to UTC to match. For an
            account working a long way from UTC that is not the account's own
            day, and the honest fix for a chart that cannot re-bucket what it
            was given is to name the bucket it is drawing. */}
        Each column is a UTC day, which is how this series is grouped — an account working a long way from UTC will see
        its late-evening actions land in the next column along.
      </p>
    </section>

    <div className="li-two-col">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>The account warm-up, week by week</h3>
            <p>{seat.warmupWeek > seat.warmupWeeks
              ? `${primaryLabel} is past its ramp, so Trevra’s full limits apply.`
              : `${primaryLabel} is in week ${seat.warmupWeek} of ${seat.warmupWeeks}, so it may use ${Math.round(seat.warmupMultiplier * 100)}% of those limits.`}</p>
          </div>
          <ConfidenceTag confidence="REPORTED" source={sourceLabel('REPORTED')} compact />
        </div>
        <WarmupRamp multipliers={WARMUP_MULTIPLIERS} currentWeek={seat.warmupWeek} weeks={seat.warmupWeeks} />
        <p className="panel-note">
          Week 1 is quiet on purpose: profile views, follows, likes and endorsements only, no invites and no messages.
          Those four are never reduced by the warm-up — they are what a warm-up consists of. The clock runs from when this
          account started sending through Trevra, not from the age of the LinkedIn account, so there is nothing to declare
          that would lift it early.
        </p>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>How many invites are being accepted</h3>
            <p>
              Sustained acceptance under {Math.round(signals.acceptance.floor * 100)}% reads as spam to LinkedIn. Counted
              over {signals.acceptance.windowDays} days, and only over invites that were answered — one sitting unopened
              is not a refusal.
            </p>
          </div>
          <ConfidenceTag confidence={signals.acceptance.confidence} source={sourceLabel(signals.acceptance.confidence)} compact />
        </div>
        <AcceptanceMeter
          rate={signals.acceptance.rate}
          floor={signals.acceptance.floor}
          decided={signals.acceptance.decided}
          accepted={signals.acceptance.accepted}
          windowDays={signals.acceptance.windowDays}
          throttled={signals.acceptance.throttled}
        />
        <p className="panel-note">
          Under the floor, Trevra {throttleVerb(signals.acceptance.throttleFactor, 'this account’s volume')} until it
          recovers — reduced, never stopped. An account cut to zero can never earn the acceptances that would clear it,
          so “{throttleImperative(signals.acceptance.throttleFactor)}” would quietly become “end it”, and ending an
          account is your decision, not a multiplier’s.
        </p>
      </section>
    </div>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Trevra’s own limits, and what {primaryLabel} has used</h3>
          {/* WHICH BAND THESE NUMBERS CAME FROM. `seat.band` was in the payload
              and on no screen, so the same table rendered two different sets of
              figures on two different days with nothing on the page to say why
              — and “why did my limits drop” is precisely the question this
              screen exists to answer. */}
          <p>
            Rolling windows, not calendar ones: “the last 24 hours”, never “since midnight”. These are Trevra’s
            {' '}<b>{seat.band === 'steady' ? 'steady' : 'warm-up'}</b> band figures — {seat.band === 'steady'
              ? 'what an account past its ramp gets'
              : 'the conservative set, which a paused or slowed-down account draws from too, not only one still on its ramp'}.
            Your own per-account numbers are in the panel above, and the two are separate ceilings that both have to pass.
          </p>
        </div>
        <Gauge size={20} className="li-heading-icon" />
      </div>
      <div className="li-ceilings">
        {[...byKind.entries()].map(([kind, rows]) => <div className="li-ceiling-group" key={kind}>
          <h4 aria-level={3}>{KIND_LABELS[kind]}</h4>
          {rows.map((limit) => <CeilingRow
            key={`${limit.kind}-${limit.window}`}
            limit={limit}
            throttleFactor={signals.acceptance.throttleFactor}
          />)}
        </div>)}
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>How actions are spaced out</h3>
          <p>Under every ceiling there is a second question — not how many, but when. Bursts are what get noticed.</p>
        </div>
        <ConfidenceTag confidence={signals.rhythm.confidence} source={sourceLabel(signals.rhythm.confidence)} />
      </div>
      <div className="li-stat-row">
        <LiStat
          label="Working hours"
          value="Each account’s own"
          detail={<>set per account, in its own timezone. Trevra falls back to {fallbackWindowLabel(signals.rhythm)} only when no account is configured</>}
        />
        <LiStat
          label="Gap between actions"
          value={`${signals.rhythm.actionGapSeconds.min}–${signals.rhythm.actionGapSeconds.max}s`}
          detail="randomised and spread across the day, never a block of back-to-back actions"
        />
        <LiStat
          label="Weekends"
          value={signals.rhythm.weekendFactor === 0 ? 'Left empty' : `×${signals.rhythm.weekendFactor}`}
          detail={signals.rhythm.weekendFactor === 0
            ? 'unless you tick Saturday or Sunday for an account, which Trevra then treats as an ordinary working day'
            : 'reduced weekend volume'}
        />
        <LiStat
          label="Days Trevra holds back"
          value={signals.rhythm.enforcementScanWeekdays.map((day) => WEEKDAY_SHORT[day]).join(' · ')}
          detail="restrictions cluster on these days, so a day’s maximum is never scheduled on one. They are capped, not skipped — skipping two of five working days would create the very sawtooth this engine avoids"
        />
      </div>
    </section>
  </div>;
}

/* =========================================================================
 * One account: the answer, its four ceilings, its schedule and its two ramps.
 * ====================================================================== */

/**
 * One kind inside an operator ceiling, with the numbers the gate checks it
 * against.
 */
interface CapKind {
  kind: PacedKind;
  /** Trevra's researched band for this kind per 24h, before either ramp. Null when unpublished for this account. */
  band: number | null;
  /** Which number the server built this kind's ceiling from. Null when unpublished for this account. */
  source: LinkedInCeilingSource | null;
  /** What the gate allows for this kind today, after the account's warm-up. Null when unpublished for this account. */
  ceiling: number | null;
  /** This kind's own last 24 hours. Null when it could not be counted. */
  used: number | null;
  /** A LONGER window that also binds this kind -- InMail's published month. Null when there is none. */
  alsoBoundBy: string | null;
}

/**
 * One operator ceiling, beside Trevra's own numbers for what it covers.
 *
 * `kinds` IS THE POINT OF THIS SHAPE. Trevra's band is per kind -- an InMail is
 * 3/day because InMails are 3/day -- while `dailyMessageLimit` is ONE POOL over
 * dm+reply+inmail, because “this account sends at most 25 messages a day” is a
 * statement about the account and not about DMs. `guard.ts` checks them as two
 * independent ceilings and both have to pass, so this carries both: one
 * operator number over `kinds` together, and one `CapKind` per kind inside it.
 *
 * The shape it replaces held a single `trevra: number`, which for the message
 * row was `dayLimit('dm').ceiling` -- 12 printed as Trevra's number for a pool
 * that also contains InMail, enforced at 3.
 */
interface AccountCap {
  key: string;
  label: string;
  /** The kinds the operator's ONE number counts together. Three for messages, one for the rest. */
  kinds: readonly PacedKind[];
  /** Trevra's own numbers for each of those kinds. */
  detail: CapKind[];
  /** The operator's own number over `kinds` TOGETHER, per 24 hours. Null when the account row could not be read. */
  yours: number | null;
  /** What the seat route accepts for `yours`. Server-owned, so this copy cannot offer a number the route refuses. */
  range: LinkedInOperatorRange;
  /** What this account has done across `kinds` in the last 24 hours. Null when it could not be counted. */
  used: number | null;
  /** True when this seat's operator ceilings bind INSTEAD of Trevra's band. */
  override: boolean;
}

const ANSWER_TONE_ICON = {
  ok: <ShieldCheck size={19} />,
  warn: <CircleAlert size={19} />,
  danger: <CircleAlert size={19} />
} as const;

function AccountPanel({ account, report, ranges, fallbackWindow, campaigns, campaignFractions, used, now }: {
  account: AccountView;
  /** Passed only for the account `GET /api/linkedin/limits` reports on. */
  report: LinkedInLimitsReport | null;
  /** What the seat route accepts for a hand-set ceiling. Workspace-wide, so the same for every account. */
  ranges: LinkedInLimitsReport['operatorRanges'];
  /** The window Trevra falls back to when an account has none, already in words. */
  fallbackWindow: string;
  campaigns: readonly ManagedCampaign[];
  /** The campaign-day ramp the runner itself applies, published by the limits route. */
  campaignFractions: readonly number[];
  /** Counted here for every other account; null when the report already counts them, or when the count failed. */
  used: Partial<Record<LinkedInActionKind, number>> | null;
  now: number;
}) {
  const config = account.config;
  const hours = config ? hoursStateOf(config, now) : null;
  const throttleFactor = report?.signals.acceptance.throttleFactor ?? null;
  // Naming the account before following the link: the account screen edits
  // whichever account is currently selected, and `#/setup/seat` carries no key.
  const [, selectAccount] = useActiveSeatKey();
  const openThisAccount = () => selectAccount(account.key);

  /* WHOSE CEILING BINDS ON THIS ACCOUNT. Off by default and read from the
     account row when there is one, because it is a per-seat decision and the
     limits route answers for one account only. */
  const override = config?.safetyBandOverride ?? report?.seat.safetyBandOverride ?? false;

  /* The two ramps. The first counts weeks since this ACCOUNT started sending
     through Trevra; the second counts days since a CAMPAIGN started. Both
     apply at once and the stricter one binds -- `guard.ts` checks each
     separately, and an action has to clear both. */
  const week = report ? report.seat.warmupWeek : warmupWeekOf(config?.activatedAt ?? null, now);
  const weeks = report ? report.seat.warmupWeeks : WARMUP_WEEKS;
  const multiplier = report ? report.seat.warmupMultiplier : warmupMultiplierOf(week);
  const weekEndsAt = warmupWeekEndsAt(config?.activatedAt ?? null, week);
  const rampEndsAt = warmupWeekEndsAt(config?.activatedAt ?? null, weeks);

  const running = campaigns
    .filter((campaign) => campaign.status === 'running')
    .map((campaign) => ({ campaign, ramp: campaignRampOf(campaign.startedAt, now, campaignFractions) }))
    .filter((entry): entry is { campaign: ManagedCampaign; ramp: CampaignRamp } => entry.ramp !== null);
  const slowest = running.reduce<{ campaign: ManagedCampaign; ramp: CampaignRamp } | null>(
    (lowest, entry) => (lowest === null || entry.ramp.fraction < lowest.ramp.fraction ? entry : lowest), null);

  const dayLimit = (kind: PacedKind) => report?.limits.find((limit) => limit.kind === kind && limit.window === 'day') ?? null;
  const monthLimit = (kind: PacedKind) => report?.limits.find((limit) => limit.kind === kind && limit.window === 'month') ?? null;
  const usedOf = (kinds: readonly PacedKind[]): number | null => {
    if (report) return kinds.reduce((total, kind) => total + (dayLimit(kind)?.used ?? 0), 0);
    if (!used) return null;
    return kinds.reduce((total, kind) => total + (used[kind] ?? 0), 0);
  };

  /**
   * The per-kind ceiling BEFORE either ramp.
   *
   * Mirrors `effectiveDailyCeiling` in src/server/linkedin/limits.ts, and it
   * has that function's three cases: no operator number is Trevra's band, an
   * operator number is the stricter of the two, and an operator number with
   * this seat's band override on is the operator's, whatever it is.
   */
  const baseOf = (kind: PacedKind, yours: number | null): number | null => {
    const limit = dayLimit(kind);
    if (limit === null) return yours;
    // `ceilingSource` IS the server's own verdict on this question, so it is
    // read rather than re-decided. Absent (a week or month row, or an older
    // payload) means nothing said otherwise, which is the band.
    return limit.ceilingSource === 'operator' || limit.ceilingSource === 'operator-override'
      ? limit.operatorLimit ?? limit.bandCeiling
      : limit.bandCeiling;
  };

  /**
   * What one kind is actually checked against per 24 hours: the server's own
   * number for it, unmodified.
   *
   * NOTHING IS RECOMPUTED HERE ANY MORE. `effectiveLinkedInLimits` now folds
   * the account's own setting and its band override into `ceiling` before
   * ramping it, so the day row IS the enforced figure. The arithmetic that
   * used to sit here -- combine the two numbers, then multiply by a ramp read
   * back as `ceiling / bandCeiling` -- would now apply the operator's number
   * twice: an account with a band of 18 and a setting of 5 would render 1.
   */
  const ceilingOf = (kind: PacedKind, yours: number | null): number | null =>
    dayLimit(kind)?.ceiling ?? yours;

  const capOf = (key: string, label: string, kinds: readonly PacedKind[], yours: number | null, range: LinkedInOperatorRange): AccountCap => ({
    key,
    label,
    kinds,
    yours,
    range,
    override,
    used: usedOf(kinds),
    detail: kinds.map((kind) => {
      const month = monthLimit(kind);
      return {
        kind,
        band: dayLimit(kind)?.bandCeiling ?? null,
        // Per row rather than per seat: `ceilingSource` says whether the
        // research or the operator's own number bound THIS kind, which the
        // seat-level flag alone cannot (an override with no number set for a
        // kind still leaves the band binding it).
        source: dayLimit(kind)?.ceilingSource ?? null,
        ceiling: ceilingOf(kind, yours),
        used: usedOf([kind]),
        // The published InMail quota is the live case and it is a MONTH, so it
        // belongs beside the daily number rather than under it: a day with room
        // left in it still refuses an InMail once the month is spent.
        alsoBoundBy: month === null
          ? null
          : `${month.ceiling} in ${WINDOW_LABELS[month.window]}${month.confidence === 'HARD FACT' ? ', published by LinkedIn' : ''}`
      };
    })
  });

  /* The four ceilings the operator owns. `dailyMessageLimit` is one pool over
     three kinds -- that is how the check counts it, so that is how it is
     shown. The ranges are the server's own, so “editable 0-75” cannot drift
     from what the route will accept. */
  const caps: AccountCap[] = [
    capOf('invite', 'Connection invites', ['invite'], config?.dailyInviteLimit ?? null, ranges.invite),
    capOf('message', 'Messages', MESSAGE_POOL_KINDS, config?.dailyMessageLimit ?? null, ranges.message),
    capOf('profile_view', 'Profile views', ['profile_view'], config?.dailyProfileViewLimit ?? null, ranges.profileView),
    capOf('follow', 'Follows', ['follow'], config?.dailyFollowLimit ?? null, ranges.follow)
  ];

  const invites = caps[0];
  const inviteCeiling = effectiveOf(invites);
  /* What one campaign on this account may take of the invite ceiling.
     `guard.ts` applies the campaign fraction to the SAME pre-ramp per-kind
     ceiling the rolling-24h check uses, so that is the base here too -- and
     the two ramps are then two separate checks with the stricter one binding,
     which is why they are compared as counts below rather than as fractions. */
  const campaignBase = baseOf('invite', invites.yours);
  const campaignInvites = slowest && campaignBase !== null ? Math.floor(campaignBase * slowest.ramp.fraction) : null;
  /** Whichever ramp actually binds today, as one number. */
  const invitesToday = smallest([inviteCeiling, campaignInvites]);

  /* ---------------------------------------------------------------------
   * The one thing holding this account back, and when it lifts.
   *
   * Ordered the way the check itself refuses an action: an account that is
   * paused never reaches its working hours, and one outside its hours never
   * reaches a ceiling.
   * ------------------------------------------------------------------ */
  const answer = (() => {
    if (account.status === 'paused') {
      return {
        tone: 'danger' as const,
        title: 'You paused this account. Nothing goes out.',
        detail: account.pausedReason
          ? <>The note you left: “{account.pausedReason}”.</>
          : <>No reason was recorded.</>,
        lifts: <>When you resume it. The Stop bar at the top of every screen does both.</>
      };
    }
    if (config && config.workingDays.length === 0) {
      return {
        tone: 'danger' as const,
        title: 'This account can never act: no working days are set.',
        detail: <>Trevra only acts on the days you tick for an account, and none are ticked, so every automated action is refused before any limit is consulted.</>,
        lifts: <>When you tick at least one day on <a className="li-link" href="#/setup/seat" onClick={openThisAccount}>this account’s screen</a>.</>
      };
    }
    if (hours?.state === 'closed' && config) {
      return {
        tone: 'warn' as const,
        title: `Outside this account’s hours. Nothing goes out until ${hours.opens}.`,
        detail: <>You set it to work {workingDaysLabel(config.workingDays)}, {clock(config.workStartMinute)}–{clock(config.workEndMinute)}, {config.timezone}. Actions are spread across that window, not fired at the open.</>,
        lifts: <>{hours.opens}, {config.timezone}.</>
      };
    }
    if (report?.signals.acceptance.throttled && report.signals.acceptance.rate !== null) {
      return {
        tone: 'danger' as const,
        title: `Too few invites are being accepted, so Trevra ${throttleVerb(throttleFactor, 'this account’s volume', true)}.`,
        detail: <>{report.signals.acceptance.accepted} of {report.signals.acceptance.decided} answered invites were accepted over {report.signals.acceptance.windowDays} days — {Math.round(report.signals.acceptance.rate * 100)}%, under the {Math.round(report.signals.acceptance.floor * 100)}% floor.</>,
        lifts: <>When acceptance climbs back over the floor. Better targeting lifts it; more invites do not.</>
      };
    }
    /* BOTH RAMPS ARE LIVE AT ONCE and they are two separate checks. The
       account ramp scales the per-kind ceiling; the campaign ramp scales the
       same pre-ramp base by its own fraction. Whichever allows less is the one
       an operator is feeling today, and they are compared as COUNTS: they are
       percentages of the same base, so only the number each one lands on is
       comparable once the floors are applied. */
    const campaignBinds = slowest !== null && campaignInvites !== null
      && (inviteCeiling === null || campaignInvites < inviteCeiling);
    if (campaignBinds && slowest) {
      return {
        tone: 'warn' as const,
        title: `“${slowest.campaign.name}” is on day ${slowest.ramp.day} of its own ${slowest.ramp.steps}-day warm-up.`,
        detail: <>
          A new campaign runs at {Math.round(slowest.ramp.fraction * 100)}% of this account’s daily ceiling on day
          {' '}{slowest.ramp.day}{campaignInvites === null ? '' : `, which is ${campaignInvites} invite${campaignInvites === 1 ? '' : 's'} today`}. It steps up each day to full speed on day {slowest.ramp.steps}. This is the single most common reason day one looks broken.
          {multiplier < 1 && <> The account is warming up too, at {Math.round(multiplier * 100)}%{inviteCeiling === null ? '' : `, which allows ${inviteCeiling}`}; whichever allows less is what you get.</>}
        </>,
        lifts: slowest.ramp.nextStepAt === null
          ? <>It is already at full speed.</>
          : <>{moment(slowest.ramp.nextStepAt, config?.timezone)} — day {slowest.ramp.day + 1}, at {Math.round((campaignFractions[Math.min(slowest.ramp.day + 1, slowest.ramp.steps) - 1] ?? 1) * 100)}%.</>
      };
    }
    if (multiplier < 1) {
      return {
        tone: 'warn' as const,
        title: `This account is in warm-up week ${week} of ${weeks}.`,
        detail: <>
          It may use {Math.round(multiplier * 100)}% of {override ? 'your own ceilings' : 'Trevra’s limits'}{inviteCeiling === null ? '' : `, which is ${inviteCeiling} invite${inviteCeiling === 1 ? '' : 's'} in any 24 hours`}. Profile views, follows, likes and endorsements are not reduced — they are what the warm-up consists of.
        </>,
        lifts: weekEndsAt === null
          ? <>When week {week + 1} starts. The clock runs from when this account started sending through Trevra.</>
          : <>{moment(weekEndsAt, config?.timezone)}, when week {week + 1} starts{rampEndsAt === null ? '' : `; the ramp is over on ${moment(rampEndsAt, config?.timezone)}`}.</>
      };
    }
    /* WHAT IS FULL -- pool and per-kind alike, because they are two
       independent ceilings and both have to pass. A message pool with room
       left in it still stops the moment Trevra's InMail number for today is
       spent, and a screen that only checked the pool would say nothing is
       holding the account back while every InMail was being refused. */
    const gates = caps.flatMap((cap) => [
      {
        cap,
        pooled: cap.kinds.length > 1,
        label: cap.label,
        used: cap.used,
        ceiling: effectiveOf(cap),
        // A pool has no Trevra band to name, and no single `ceilingSource`
        // either; a single-kind cap's are its own.
        band: cap.kinds.length > 1 ? null : cap.detail[0]?.band ?? null,
        source: cap.kinds.length > 1 ? null : cap.detail[0]?.source ?? null
      },
      ...(cap.kinds.length > 1
        ? cap.detail.map((entry) => ({
          cap, pooled: false, label: KIND_LABELS[entry.kind], used: entry.used, ceiling: entry.ceiling, band: entry.band, source: entry.source
        }))
        : [])
    ]);
    const full = gates.find((gate) => gate.used !== null && gate.ceiling !== null && gate.used >= gate.ceiling);
    if (full) {
      const ceiling = full.ceiling ?? 0;
      const band = full.band;
      return {
        tone: 'warn' as const,
        // Colon rather than "are done": this line now names a KIND as well as a
        // cap, and "InMail are done for now" is not a sentence.
        title: `${full.label}: done for now, ${full.used} of ${ceiling} used in the last 24 hours.`,
        // Same three cases as the chip, and from the same field for the same
        // reason: the row knows which number it was built from, the seat flag
        // only knows what the operator opted into.
        detail: full.pooled
          ? <>That ceiling is your own setting of {full.cap.yours} per 24 hours, counted over direct messages, replies and InMail <b>together</b> — one pool, the way the check counts it. Trevra’s own numbers for each of those three are separate and are below.</>
          : full.source === 'operator-override'
            ? <>That ceiling is your own setting of {full.cap.yours} per 24 hours, which you put ahead of Trevra’s researched band of {band ?? '—'}{multiplier < 1 ? `, and the warm-up week takes it to ${ceiling}` : ''}.</>
            : full.source === 'operator' || (full.source === null && full.cap.yours !== null && (band === null || full.cap.yours <= band))
              ? <>That ceiling is your own setting of {full.cap.yours} per 24 hours{band === null ? '' : `, which is the stricter of the two — Trevra’s band here is ${band}`}{multiplier < 1 ? `, and the warm-up week takes it to ${ceiling}` : ''}.</>
              : <>That ceiling is Trevra’s own limit for this account. Your setting of {full.cap.yours ?? '—'} per 24 hours is the higher of the two, so it is not what bound this.</>,
        lifts: <>Gradually, as the oldest of those actions ages past 24 hours. This window rolls; it does not reset at midnight.</>
      };
    }
    // Nothing is binding. What may be claimed here depends on what was read:
    // an account whose last 24 hours could not be counted is not an account
    // that is known to be under every ceiling.
    const counted = caps.every((cap) => cap.used !== null);
    return {
      tone: 'ok' as const,
      title: counted ? 'Nothing is holding this account back right now.' : 'Nothing on Trevra’s side is holding this account back.',
      detail: <>
        It is inside its working hours and past its warm-up{report ? ', and it is accepting invites at a healthy rate' : ''}
        {counted ? ', with room left under every ceiling' : ''}. What goes out from here is what the running campaigns have queued.
        {!counted && <> Its last 24 hours could not be counted on this screen, so the numbers above are incomplete.</>}
      </>,
      lifts: <>Nothing is waiting on a clock.</>
    };
  })();
  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3 aria-level={2}>{account.label}</h3>
        <p>
          {config
            ? <>Works {workingDaysLabel(config.workingDays) || 'no days'}, {clock(config.workStartMinute)}–{clock(config.workEndMinute)}, {config.timezone}.{' '}
              {hours?.state === 'open' ? `Inside its hours now, until ${hours.until}.`
                : hours?.state === 'closed' ? `Quiet until ${hours.opens}.`
                  : hours?.state === 'unknown' ? 'This browser does not recognise that timezone, so “now” could not be placed in it.'
                    : 'No working day is ticked, so nothing is ever scheduled.'}</>
            : <>Its working days, hours and per-account ceilings could not be read, so only Trevra’s own limits are shown for it.</>}
        </p>
      </div>
      <PostureBadge posture={account.status} reason={account.pausedReason} />
    </div>

    <div className={`li-answer li-answer-${answer.tone}`}>
      {ANSWER_TONE_ICON[answer.tone]}
      <div>
        <strong>{answer.title}</strong>
        <p>{answer.detail}</p>
        <p><b>Lifts:</b> {answer.lifts}</p>
      </div>
    </div>

    <div className="li-caps">
      {caps.map((cap) => <CapCell key={cap.key} cap={cap} />)}
    </div>
    <p className="panel-note">
      {/* NOT “the smaller one always applies” any more, because for messages it
          never was: your number is one pool over three kinds and Trevra's is
          per kind, so they are ceilings on two different quantities and both
          are checked. */}
      Your own numbers and Trevra’s researched band are <b>two ceilings and both have to pass</b>, which is exactly how
      the check immediately before every action composes them. Your messages number is one pool over direct messages,
      replies and InMail together; Trevra’s is per kind. Yours are editable on{' '}
      <a className="li-link" href="#/setup/seat" onClick={openThisAccount}>this account’s screen</a>:{' '}
      {caps.map((cap) => `${cap.label.toLowerCase()} ${cap.range.min}–${cap.range.max}`).join(', ')}
      {caps.every((cap) => cap.range.min === 0) ? ', and 0 switches that action off entirely' : ''}. Every window here is
      the last 24 hours, rolling.
      {!report && <> Trevra’s own limits for this account are applied on every action, but this screen can publish them
        {' '}for the workspace’s first account only.</>}
    </p>

    <div className="li-facts">
      <div className="li-fact">
        <h4 aria-level={3}>When it may act</h4>
        {config
          ? <p>
            <b>{workingDaysLabel(config.workingDays) || 'No days'}</b>, {clock(config.workStartMinute)}–{clock(config.workEndMinute)}, {config.timezone}.
            Outside that, every automated action is refused — the planner and the check both read this same window.
          </p>
          : <p>Not readable for this account. Trevra falls back to {fallbackWindow}, and only when no account is configured at all.</p>}
      </div>
      <div className="li-fact">
        <h4 aria-level={3}>Account warm-up</h4>
        <p>
          {week > weeks
            ? <>Finished. This account is past its ramp, so {override ? 'your own ceilings apply in full' : 'Trevra’s full limits apply'}.</>
            : <><b>Week {week} of {weeks}</b> — {Math.round(multiplier * 100)}% of {override ? 'your own ceilings' : 'Trevra’s limits'}{week === 1 ? ', and no invites or messages at all in week 1' : ''}.</>}
        </p>
        {week <= weeks && <p>
          {weekEndsAt === null
            ? <>Measured from when this account started sending through Trevra.</>
            : <>Week {week + 1} starts {moment(weekEndsAt, config?.timezone)}{rampEndsAt === null ? '' : `, full limits ${moment(rampEndsAt, config?.timezone)}`}.</>}
        </p>}
      </div>
      <div className="li-fact">
        <h4 aria-level={3}>Campaign warm-up</h4>
        {running.length === 0
          ? <p>No campaign is running on this account, so only the account warm-up above applies.</p>
          : <>
            <p>
              {running.map((entry) => `“${entry.campaign.name}” day ${entry.ramp.day} of ${entry.ramp.steps} (${Math.round(entry.ramp.fraction * 100)}%)`).join(' · ')}.
            </p>
            <p>
              {/* The steps are PRINTED FROM THE SERVER'S OWN LIST rather than
                  typed out as “20/40/60/80/100%”, which was a literal sitting
                  beside a client-side re-implementation of the same
                  arithmetic — two copies of one policy, neither of them the
                  one the runner reads. */}
              A campaign’s first {campaignFractions.length} days run at
              {' '}{campaignFractions.map((fraction) => `${Math.round(fraction * 100)}%`).join('/')} of this account’s
              daily ceiling, whatever the account’s own warm-up says. Both apply and the stricter one binds
              {invitesToday === null ? '' : `, which today is ${invitesToday} invite${invitesToday === 1 ? '' : 's'}`}.
            </p>
          </>}
      </div>
    </div>

    {config && <BandOverride account={config} caps={caps} week={week} weeks={weeks} rampDays={campaignFractions.length} />}
  </section>;
}

/* =========================================================================
 * Whose ceiling binds: Trevra's researched band, or the operator's own number.
 *
 * THE ONE CONTROL ON THIS SCREEN THAT RAISES RISK, so it states both numbers
 * before it is touched and it names whose risk it is. Trevra's band is what
 * the research says keeps an account alive; the operator's number is a
 * settings field, and a settings field is not evidence. Turning this on says
 * “I know this account and I want my own number” -- and it is recorded on the
 * account, where somebody can see the decision was made, rather than held in a
 * preference nobody can audit. `safetyBandOverride` in seats.ts holds it;
 * `effectiveDailyCeiling` in limits.ts is the four lines that read it.
 *
 * WHAT IT DOES NOT DO, said in the panel and again in the drawer, because this
 * is the sentence an operator will remember wrong: it lifts the BAND and
 * nothing else. Both warm-ups still multiply whichever ceiling ends up
 * applying, so week 2 of an overridden account is 40% of the operator's number
 * instead of 40% of Trevra's -- and it is still 40%. Every other ceiling in
 * the gate is untouched: the rolling 7-day and 30-day windows, the day-over-day
 * change limit, the acceptance floor, working hours, LinkedIn's published
 * InMail quota and the outstanding-invite backlog.
 *
 * Turning it OFF is protective and immediate. Only the expensive direction
 * opens a drawer, for the same reason the seat's resume does and its pause
 * does not.
 * ====================================================================== */
function BandOverride({ account, caps, week, weeks, rampDays }: {
  account: LinkedInSeat;
  caps: readonly AccountCap[];
  week: number;
  weeks: number;
  /** How many days the campaign ramp lasts, so the drawer names it rather than assuming five. */
  rampDays: number;
}) {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const on = account.safetyBandOverride;

  const write = async (next: boolean) => {
    setBusy(true);
    setFailure('');
    try {
      await updateLinkedInManagerSeat(account.seatKey, { safetyBandOverride: next });
      // Every mounted outreach screen is now pricing against a different ceiling.
      await reloadOutreach();
      setPending(false);
    } catch (error) {
      // Each of these names what did NOT change, which is the only thing an
      // operator can act on: the account is still on whichever ceiling it was.
      setFailure(errorMessage(error, next
        ? 'Unable to record that. Nothing changed — Trevra’s band is still what binds on this account.'
        : 'Unable to put Trevra’s band back. Nothing changed — your own numbers are still what bind on this account.'));
    } finally { setBusy(false); }
  };

  /** Both numbers for one cap, in one clause. The pool is stated as a pool. */
  const comparison = (cap: AccountCap) => cap.kinds.length > 1
    ? `${cap.label.toLowerCase()}, your pool of ${cap.yours ?? '—'} against Trevra’s per-kind bands of ${cap.detail.map((entry) => `${entry.band ?? '—'} ${KIND_LABELS[entry.kind].toLowerCase()}`).join(', ')}`
    : `${cap.label.toLowerCase()}, yours ${cap.yours ?? '—'} against Trevra’s band of ${cap.detail[0]?.band ?? '—'}`;
  const comparisons = caps.map(comparison).join('; ');
  const rampsStillApply = `Both warm-ups still apply. The account ramp (${week > weeks ? `finished, ${weeks} weeks` : `week ${week} of ${weeks}`}) and every campaign’s ${rampDays}-day ramp multiply whichever ceiling ends up binding, so this raises the number the ramps are a percentage OF — it never turns a ramp off.`;

  return <>
    {failure && <div className="error-banner">{failure}</div>}

    {on
      ? <div className="li-warn-block">
        <CircleAlert size={18} />
        <div>
          <strong>Your own ceilings bind on this account, ahead of Trevra’s researched band.</strong>
          <p>
            You set this. Where the two differ — {comparisons} — yours is what the check uses, higher or lower.
            Trevra’s band is the researched safe number and yours is your own risk: LinkedIn can restrict an account
            that stayed inside every number on this screen, and it will not ask which of the two you chose.
          </p>
          <p>{rampsStillApply}</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void write(false)}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} Put Trevra’s band back
          </button>
        </div>
      </div>
      : <>
        <p className="panel-note">
          <b>Trevra’s researched band is what binds on this account</b>, wherever it is the stricter of the two —
          {' '}{comparisons}. That is the safe default: the band is what the research says keeps an account alive, and a
          number typed into a settings field is a preference rather than evidence. If you know this account and want
          your own numbers to bind instead, you can say so — it is your account and your risk, and it is recorded here.
        </p>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setPending(true)}>
          <Settings2 size={14} /> Use my own ceilings on this account
        </button>
      </>}

    {pending && <ConfirmDrawer
      title="Let your own ceilings bind instead of Trevra’s band?"
      tone="danger"
      body={<>
        <p>Right now Trevra’s band binds wherever it is stricter: {comparisons}. Turn this on and your own numbers bind instead, whatever they are.</p>
        <p><b>Trevra’s band is the researched safe number. Yours is your own risk.</b> The band came from practitioners running their own accounts; the field you typed is a preference. LinkedIn can restrict an account that stayed inside every number on this screen, and it will not ask which of the two you chose.</p>
        <p>{rampsStillApply}</p>
        <p>It lifts the band and nothing else. The rolling 7-day and 30-day windows, the day-over-day change limit, the acceptance floor, this account’s working days and hours, LinkedIn’s published InMail quota and the outstanding-invite backlog are all unchanged and can all still refuse an action.</p>
        <p>It is stored on this account, so it stays visible as a decision somebody made rather than a setting that drifted.</p>
      </>}
      confirmLabel="Use my own ceilings"
      busy={busy}
      error={failure || null}
      onCancel={() => { if (!busy) { setPending(false); setFailure(''); } }}
      onConfirm={() => void write(true)}
    />}
  </>;
}

/** The smallest number that is actually known. Null when none of them is. */
function smallest(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * The one number a cap cell can headline: what stops this cap FIRST.
 *
 * For a single-kind cap that is the kind's own ceiling, which already has the
 * operator's number folded into it. For the message POOL there is no Trevra
 * figure to fold in -- Trevra publishes no pooled number, and its per-kind ones
 * are checked separately underneath -- so the pool's ceiling is the operator's
 * alone.
 */
const effectiveOf = (cap: AccountCap): number | null =>
  cap.kinds.length > 1 ? cap.yours : cap.detail[0]?.ceiling ?? cap.yours;

function CapCell({ cap }: { cap: AccountCap }) {
  const ceiling = effectiveOf(cap);
  const share = ceiling === null || ceiling === 0 || cap.used === null ? 0 : Math.min(1, cap.used / ceiling);
  const spent = ceiling !== null && cap.used !== null && cap.used >= ceiling;
  const pooled = cap.kinds.length > 1;
  const band = pooled ? null : cap.detail[0]?.band ?? null;

  /* WHICH OF THE TWO IS BINDING, taken from the server's own `ceilingSource`
     where it sent one. That field is per KIND, and the seat-level override
     flag is not: an account with the override on but no number set for a kind
     is still bound by the band there, and only the row knows it. The seat flag
     stays as the fallback for an account this route does not report on.

     The pool is none of those cases: it is the operator's alone, because there
     is no pooled Trevra figure for it to be the stricter of. */
  const source = pooled ? null : cap.detail[0]?.source ?? null;
  const binds = pooled ? 'Trevra’s are per kind, below'
    : source === 'operator-override' ? 'yours binds, ahead of the band'
      : source === 'operator' ? 'yours applies, the stricter one'
        : source === 'band' ? 'Trevra’s applies'
          : cap.override && cap.yours !== null ? 'yours binds, ahead of the band'
            : cap.yours === null ? 'Trevra’s applies'
              : band === null ? 'the smaller of the two applies'
                : cap.yours === band ? 'both agree'
                  : cap.yours < band ? 'yours applies' : 'Trevra’s applies';

  return <div className={`li-cap${spent ? ' li-cap-spent' : ''}`}>
    {/* One line per label, so the four numbers under them share a baseline.
        What a ceiling counts is a sentence, and it belongs with the other
        sentence in this cell rather than pushing the number down a line. */}
    <p className="li-cap-label">{cap.label}</p>
    <strong>{cap.used === null ? '—' : cap.used}<em>/{ceiling ?? '—'}</em></strong>
    <div className="li-cap-meter"><i style={{ width: `${share * 100}%` }} /></div>
    <small>
      Yours <b>{cap.yours ?? '—'}</b>{pooled ? ', over DMs, replies and InMail together' : <> · Trevra’s band <b>{band ?? 'not shown here'}</b></>} · {binds}
    </small>
    {pooled && <small className="li-cap-counts">
      {/* The pool has room in it right up until one KIND runs out, and then it
          stops — so both are shown. Printing one of Trevra's per-kind numbers
          as if it were the pool's is what put 12 beside a pool that also
          contains InMail, enforced at 3. */}
      {cap.detail.map((entry) => <span key={entry.kind}>
        {KIND_LABELS[entry.kind]} {entry.used ?? '—'}/{entry.ceiling ?? '—'} today
        {entry.band === null ? '' : ` of ${entry.band}`}
        {entry.alsoBoundBy === null ? '' : `, and ${entry.alsoBoundBy}`}.{' '}
      </span>)}
    </small>}
  </div>;
}

/* =========================================================================
 * Trevra's own limits, one row each, with the rule that produced it.
 * ====================================================================== */

/**
 * Which rule produced a ceiling, said the way an operator would say it.
 *
 * `operator-daily-limit` is deliberately NOT in this map. It is one rule with
 * two opposite meanings -- your own number was the stricter of the two, or you
 * raised it ABOVE the researched band -- and `ceilingSource` is the field that
 * says which. One chip reading “your own limit” over both would hide exactly
 * the distinction this screen exists to draw, so `boundByLabel` reads that
 * field and only the unambiguous rules live here.
 */
const BOUND_BY_LABELS: Record<string, string> = {
  'band-ceiling': 'Trevra’s safety limit',
  'seat-unconfigured': 'no account configured',
  'seat-paused': 'you paused this account',
  'acceptance-rate': 'acceptance under the floor',
  'warmup-multiplier': 'account warm-up',
  'cooldown-band': 'account set to slow down',
  'weekly-band': 'Trevra’s 7-day limit',
  'monthly-quota': 'monthly quota'
};

/** The chip over one ceiling. Anything unmet falls back to the raw rule, spelled out rather than blanked. */
function boundByLabel(limit: LinkedInCeiling): string {
  if (limit.boundBy === 'operator-daily-limit') {
    return limit.ceilingSource === 'operator-override'
      ? 'your own limit, ahead of the band'
      : 'your own limit, the stricter one';
  }
  return BOUND_BY_LABELS[limit.boundBy] ?? humanizeRule(limit.boundBy);
}

/**
 * What this ceiling would be once every ramp is over.
 *
 * `bandCeiling` stops being that number the moment the account's own setting
 * is the binding one, and `ceilingSource` is what says whether it is. A
 * warm-up sentence quoting “instead of the 18 a warmed-up account gets” to an
 * operator who typed 5 names a figure nothing downstream would ever honour --
 * which is the one thing a limits report may not do.
 */
const unrampedOf = (limit: LinkedInCeiling): number =>
  limit.ceilingSource === 'operator' || limit.ceilingSource === 'operator-override'
    ? limit.operatorLimit ?? limit.bandCeiling
    : limit.bandCeiling;

/** The pool caveat, on the three kinds one operator number counts together. */
const poolNote = (limit: LinkedInCeiling) =>
  MESSAGE_POOL_KINDS.includes(limit.kind)
    ? ' That one number is a pool over direct messages, replies and InMail together, not a ceiling on this kind alone.'
    : '';

/**
 * The same verdict the server sent, in the operator's words.
 *
 * Built from the structured fields rather than printing `limit.rule`, which is
 * written in this codebase's own vocabulary -- band, posture, seat. Anything
 * this map has not met falls back to that sentence rather than to silence.
 */
function ceilingSentence(limit: LinkedInCeiling, throttleFactor: number): string {
  const kind = KIND_LABELS[limit.kind].toLowerCase();
  const window = `in ${WINDOW_LABELS[limit.window]}`;
  const unramped = unrampedOf(limit);
  switch (limit.boundBy) {
    /* THE ANSWER THIS SCREEN EXISTS TO GIVE: “I typed 30 and it says 18”, and
       its opposite. Both arrive as `operator-daily-limit`; only
       `ceilingSource` separates the operator who is being protected by the
       band from the operator who has stepped out from behind it. */
    case 'operator-daily-limit':
      return limit.ceilingSource === 'operator-override'
        ? `Your own ${limit.operatorLimit} ${kind} ${window} is what binds here — this account is set to use your daily limits ahead of Trevra’s researched ${limit.bandCeiling}.${poolNote(limit)} Every ramp and every rolling window still applies on top of your number.`
        : `Your own ${limit.operatorLimit} ${kind} ${window} is stricter than Trevra’s ${limit.bandCeiling}, so yours is what binds.${poolNote(limit)}`;
    case 'warmup-multiplier':
      return `While this account warms up it may take ${limit.ceiling} ${kind} ${window}, instead of the ${unramped} it gets once the ramp is over.`;
    case 'acceptance-rate':
      return `Too few invites were accepted, so Trevra ${throttleVerb(throttleFactor, 'the volume', true)}: ${limit.ceiling} ${kind} ${window} until acceptance recovers.`;
    case 'seat-paused':
      return 'You paused this account, so nothing at all is scheduled for it.';
    case 'seat-unconfigured':
      return 'No LinkedIn account is configured, so nothing can be scheduled. An undeclared account is treated as brand new, never as established.';
    case 'cooldown-band':
      return `This account is set to slow down, so the cautious limit applies: ${limit.ceiling} ${kind} ${window}, instead of the ${unramped} it gets when it is running normally.`;
    case 'monthly-quota':
      return limit.kind === 'inmail'
        ? `LinkedIn’s own quota: ${limit.ceiling} InMails a month on a Sales Navigator seat. The 51st is refused by LinkedIn, not by Trevra.`
        : `${limit.ceiling} ${kind} ${window}.`;
    /* `band-ceiling` is ALSO reached with an operator number set -- one that is
       higher than the band, so the band won. Saying only “this is what Trevra
       allows” there leaves the obvious question unanswered on the one row that
       raises it, and the way out of it unmentioned. */
    case 'band-ceiling':
    case 'weekly-band':
      return limit.window === 'day' && limit.ceilingSource === 'band'
        && limit.operatorLimit !== null && limit.operatorLimit !== undefined && limit.operatorLimit > limit.bandCeiling
        ? `${limit.ceiling} ${kind} ${window} is what Trevra allows this account. Your own setting of ${limit.operatorLimit} is the higher of the two, so it is not what bound this${poolNote(limit)} — letting your own ceilings bind on this account is what would change it.`
        : `${limit.ceiling} ${kind} ${window} is what Trevra allows this account.`;
    default:
      return limit.rule;
  }
}

function CeilingRow({ limit, throttleFactor }: { limit: LinkedInCeiling; throttleFactor: number }) {
  const share = limit.ceiling === 0 ? 0 : Math.min(1, limit.used / limit.ceiling);
  const spent = limit.ceiling > 0 && limit.remaining === 0;
  return <div className="li-ceiling">
    <div className="li-ceiling-head">
      <span className="li-ceiling-window">{WINDOW_LABELS[limit.window]}</span>
      <strong className={spent ? 'li-ceiling-spent' : ''}>
        <b>{limit.used}</b> / {limit.ceiling}
      </strong>
      <span className="li-chip">{boundByLabel(limit)}</span>
      <ConfidenceTag confidence={limit.confidence} source={sourceLabel(limit.confidence)} compact />
    </div>
    <div className="li-ceiling-meter">
      <i className={spent ? 'li-ceiling-fill li-ceiling-fill-spent' : 'li-ceiling-fill'} style={{ width: `${share * 100}%` }} />
    </div>
    <p>{ceilingSentence(limit, throttleFactor)}</p>
    <small>
      {/* Compared against `unrampedOf`, not against the band: with the account's
          own setting binding, the band is not the number the ramps reduced and
          naming it here would describe a reduction that never happened. */}
      {limit.ceiling !== unrampedOf(limit) && <>
        Past every ramp this account gets {unrampedOf(limit)} here; {limit.ceiling} is what applies to it today.{' '}
      </>}
      {limit.ceilingSource === 'operator-override' && <>
        That number is yours rather than Trevra’s — the researched band here is {limit.bandCeiling}.{' '}
      </>}
      {limit.window !== 'day' && <>Rolling, not calendar — a calendar cap of {limit.ceiling} delivers {limit.ceiling * 2} across the boundary.{' '}</>}
      {/* `limit.source` shipped on every ceiling and appeared on no screen. It
          is the citation behind the tag beside it — which plan section a number
          came from — and “where did 18 come from” is a question an operator
          betting their own account is entitled to follow up. The words stay
          first; the reference is the last thing on the line. */}
      {limit.remaining} left · {sourceLabel(limit.confidence)} · <code>{limit.source}</code>
    </small>
  </div>;
}

/** What an account is doing, in the operator's words rather than the column's. */
const STATUS_LABELS: Record<string, string> = {
  warmup: 'Warming up',
  steady: 'Running',
  cooldown: 'Slowed down',
  paused: 'Paused'
};

export function PostureBadge({ posture, reason }: { posture: string | null; reason?: string | null }) {
  if (!posture) return <span className="li-posture li-posture-none"><CircleAlert size={13} /> No account</span>;
  const icon = posture === 'paused' || posture === 'cooldown' ? <CircleAlert size={13} />
    : posture === 'steady' ? <ShieldCheck size={13} /> : <TrendingUp size={13} />;
  return <span className={`li-posture li-posture-${posture}`} title={reason ?? undefined}>
    {icon} {STATUS_LABELS[posture] ?? posture}{posture === 'paused' && reason ? `: ${reason}` : ''}
  </span>;
}
