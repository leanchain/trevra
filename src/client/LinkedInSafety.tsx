import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Gauge, Settings2, ShieldCheck, TrendingUp } from 'lucide-react';
import {
  ApiError,
  WARMUP_MULTIPLIERS,
  getLinkedInLimits,
  pauseLinkedInSeat,
  resumeLinkedInSeat,
  type ExportFormat,
  type LinkedInActionKind,
  type LinkedInActionStatus,
  type LinkedInAnalytics,
  type LinkedInCeiling,
  type LinkedInLimitsReport,
  type PacedKind,
  type SequenceTone
} from './api';
import { AcceptanceMeter, ConfidenceTag, Define, LiStat, VolumeChart, WarmupRamp, WindowPicker, type VolumePoint } from './LinkedInViz';

/**
 * The Safety screen -- the loudest screen in the product, on purpose.
 *
 * Every other tool in the category ships a daily cap. Plan 1.3 is that a daily
 * cap is not the defence: detection is behavioural, and 20/20/20/0/0/0/20 is
 * more dangerous than a flat 12/day even though every day is under the cap. So
 * what this screen leads with is not the ceiling, it is the VARIANCE, and every
 * number on it arrives with the rule that produced it and a tag saying whether
 * LinkedIn published it or a practitioner reported it.
 *
 * The screen renders what the server computed. It derives no ceiling of its
 * own: `GET /api/linkedin/limits` is the single source, provenance included,
 * and anything this file could not get from there is shown as unknown rather
 * than guessed at.
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
 * `withdrawn` is the live case: migration 032 writes it into
 * `linkedin_actions.status` when the worker takes an invite back, and
 * `campaigns.ts` counts it, but `LinkedInActionStatus` in
 * src/server/linkedin/actions.ts was never widened to include it. Until it is,
 * an action row can arrive carrying a status this table has no entry for, and
 * a table cell reading `undefined` beside an invite is worse than one reading
 * the raw word.
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

const WINDOW_LABELS = { day: 'per day', week: 'rolling 7 days', month: 'rolling 30 days' } as const;

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
  /**
   * Kept so nothing is lost. Shell section 3.6 retires it: the StopBar's idle
   * state says “Nothing is running” for every actor at once, which is true
   * whether or not a seat was ever configured and does not dead-end on a
   * screen the operator has not reached yet.
   */
  unconfigured: 'No seat is configured yet, so there is nothing to pause. Set one up first.',
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
    reasonLabel: 'What changed?',
    whatRestarts: (reason: string | null) =>
      'Real invites and messages start going out again, on the LinkedIn account this seat signs in as.'
      + (reason ? ` It was stopped because: ${reason}.` : ''),
    warmupKeeps: 'The warm-up ramp picks up where it left off — it is measured from when this seat started sending through Trevra, so resuming does not restart it.',
    // lc-debt: the resume reason is confirmed but not stored -- POST
    // /api/linkedin/seat/resume takes no body. Add `reason` to that route and
    // keep it beside `pausedReason`, so the way up leaves a record like the
    // way down does.
    noteNotStored: 'Say what changed. There is nowhere to store this note on the way up — the pause reason it replaces is what the ledger keeps. It is asked for because the way down asks for one, and this is the more expensive direction.'
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
  onlyAHumanZeroesASeat: 'Trevra never cuts this seat to zero on its own. Below the acceptance floor it halves the volume, because a seat cut to zero can never produce the outcomes that would clear the throttle — “halve it” would quietly become “end it”. Ending a seat is a decision for a human, and this is that decision.'
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
    pause,
    resume,
    clearFailure: () => setFailure(''),
    reload
  };
}

export function LinkedInSafetyScreen({ limits, analytics, days, onDaysChange, seriesLoading }: {
  limits: LinkedInLimitsReport;
  analytics: LinkedInAnalytics | null;
  days: number;
  onDaysChange: (days: number) => void;
  seriesLoading: boolean;
}) {
  const { seat, signals } = limits;

  // Nothing to pace, so nothing to draw. Four em dashes, an empty variance
  // chart, a warm-up ramp for a seat that does not exist and a banner counting
  // the hard facts in all of it is a dashboard about nothing -- it reads as a
  // product that is broken rather than one that has not been set up.
  if (!seat.configured) {
    return <div className="page-stack li-viz">
      <section className="page-panel">
        <div className="empty-state">
          <Gauge size={28} />
          <h4>There is no seat to pace yet</h4>
          <p>
            Every ceiling on this screen is computed from one seat’s real ledger, so until a seat exists there is nothing
            here that would be true.
          </p>
          {/* The one action, and it is a real link: the seat lives on its own
              route now, so “go and set one up” is a URL a teammate can be sent
              rather than a callback only the old tab shell could supply. */}
          <a className="primary-button" href="#/setup/seat" style={{ textDecoration: 'none' }}>
            <Settings2 size={15} /> Set up the seat
          </a>
        </div>
      </section>
    </div>;
  }

  const inviteDay = limits.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day');
  const hardFacts = limits.limits.filter((limit) => limit.confidence === 'HARD FACT').length;

  const points: VolumePoint[] = (analytics?.series ?? []).map((day) => ({
    date: day.date,
    // What provably went out. `exported` is a row in a file the operator has
    // not necessarily run yet, so counting it as volume would inflate the one
    // series the variance band is measured against.
    volume: day.sent + day.accepted + day.replied,
    planned: day.planned
  }));

  const byKind = new Map<PacedKind, LinkedInCeiling[]>();
  for (const limit of limits.limits) {
    const bucket = byKind.get(limit.kind) ?? [];
    bucket.push(limit);
    byKind.set(limit.kind, bucket);
  }

  return <div className="page-stack li-viz">

    {/* The honesty rule, stated once, at the top, before any number. */}
    <section className="li-honesty">
      <CircleAlert size={20} />
      <div>
        <strong>Exactly {hardFacts} number on this screen is a HARD FACT. Every other one is REPORTED.</strong>
        <p>
          <b>HARD FACT</b> means LinkedIn published the number, or refuses the action past it. <b>REPORTED</b> means
          practitioners measured it and LinkedIn has never confirmed it.{' '}
          The InMail monthly quota is published by LinkedIn: the 51st is refused by LinkedIn, not by Trevra. Everything
          else here — daily and weekly bands, the warm-up ramp, the {Math.round(signals.dayOverDay.maxDelta * 100)}% variance
          clamp, the {Math.round(signals.acceptance.floor * 100)}% acceptance floor — is practitioner telemetry. It is
          directionally right and it is not a guarantee. LinkedIn publishes no invite limit and can restrict an account that
          stays inside every number below. You are betting your own account; the tags tell you which bets are which.
        </p>
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Where this seat stands</h3>
          <p>{`${seat.label ?? 'Seat'} · ${seat.timezone ?? 'no timezone'} · drawing from the ${seat.band} band.`}</p>
          <Define term="Posture">
            the seat’s stance right now — warming up, steady, cooling down, or paused. It decides whether anything may be
            scheduled at all, before any ceiling is consulted.
          </Define>
        </div>
        <PostureBadge posture={seat.posture} reason={seat.pausedReason} />
      </div>

      <div className="li-stat-row">
        <LiStat
          label="Invites left today"
          value={inviteDay ? String(inviteDay.remaining) : '—'}
          tone={inviteDay && inviteDay.remaining === 0 ? 'warn' : 'ok'}
          detail={inviteDay ? <>of {inviteDay.ceiling}, bound by {humanizeRule(inviteDay.boundBy)}</> : 'no invite ceiling was reported for this seat'}
        />
        <LiStat
          label="Warm-up"
          value={seat.warmupWeek > seat.warmupWeeks ? 'Complete' : `Week ${seat.warmupWeek} of ${seat.warmupWeeks}`}
          detail={<>volume multiplier ×{seat.warmupMultiplier}</>}
        />
        <LiStat
          label={`Acceptance, last ${signals.acceptance.windowDays} days`}
          value={signals.acceptance.rate === null ? 'No data' : `${Math.round(signals.acceptance.rate * 100)}%`}
          tone={signals.acceptance.throttled ? 'danger' : signals.acceptance.rate === null ? 'mute' : 'ok'}
          detail={signals.acceptance.throttled
            ? <>below the {Math.round(signals.acceptance.floor * 100)}% floor — volume halved</>
            : <>floor is {Math.round(signals.acceptance.floor * 100)}%</>}
        />
        <LiStat
          label="Day-over-day clamp"
          value={`±${Math.round(signals.dayOverDay.maxDelta * 100)}%`}
          detail={<>the most today may differ from the previous business day, up or down. Reported trigger is 50%; this sits under it</>}
        />
      </div>
    </section>

    {/* The differentiator, drawn. */}
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Volume and its variance</h3>
          <p>{signals.dayOverDay.rule}</p>
        </div>
        <ConfidenceTag confidence={signals.dayOverDay.confidence} source={signals.dayOverDay.source} />
      </div>
      <WindowPicker days={days} onDaysChange={onDaysChange} loading={seriesLoading} />
      {points.length === 0
        ? <p className="empty-copy">No action has been recorded in this window, so there is no volume to chart. The band appears once this seat has two business days of history.</p>
        : <VolumeChart points={points} maxDelta={signals.dayOverDay.maxDelta} minRampStep={signals.dayOverDay.minRampStep}
          caption={`Actions that went out per day, last ${analytics?.windowDays ?? points.length} days`} />}
      <p className="panel-note">
        A step up is clamped to {Math.round(signals.dayOverDay.maxDelta * 100)}% of the previous <em>business</em> day;
        weekends are skipped rather than counted as zero.{' '}
        <b>Minimum ramp step</b> — the smallest increase a day is allowed to make, so a seat sitting at zero is not frozen
        by a percentage of zero — is {signals.dayOverDay.minRampStep} action/day.
      </p>
    </section>

    <div className="li-two-col">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Warm-up ramp</h3>
            <p>{seat.warmupWeek > seat.warmupWeeks
              ? `This seat is past the ramp: week ${seat.warmupWeek}, so the band ceiling applies in full.`
              : `Week ${seat.warmupWeek} of ${seat.warmupWeeks}. Active kinds are multiplied by ×${seat.warmupMultiplier} this week.`}</p>
          </div>
          <ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.4" compact />
        </div>
        <WarmupRamp multipliers={WARMUP_MULTIPLIERS} currentWeek={seat.warmupWeek} weeks={seat.warmupWeeks} />
        <p className="panel-note">
          Week 1 is passive-only: views and likes, no invites. Profile views are exempt from the multiplier.
        </p>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3>Acceptance rate against the throttle</h3>
            <p>{signals.acceptance.rule}</p>
          </div>
          <ConfidenceTag confidence={signals.acceptance.confidence} source={signals.acceptance.source} compact />
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
          Below the floor, volume is multiplied by {signals.acceptance.throttleFactor} until it recovers — halved, never zeroed.
          A seat cut to zero can never produce the outcomes that would clear the throttle, so “halve it” would quietly become
          “end it”, and ending a seat is a decision for a human.
        </p>
      </section>
    </div>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Today’s ceilings, and which rule bound each</h3>
        </div>
        <Gauge size={20} className="li-heading-icon" />
      </div>
      <div className="li-ceilings">
        {[...byKind.entries()].map(([kind, rows]) => <div className="li-ceiling-group" key={kind}>
          <h4>{KIND_LABELS[kind]}</h4>
          {rows.map((limit) => <CeilingRow key={`${limit.kind}-${limit.window}`} limit={limit} />)}
        </div>)}
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Rhythm</h3>
          <p>{signals.rhythm.rule}</p>
        </div>
        <ConfidenceTag confidence={signals.rhythm.confidence} source={signals.rhythm.source} />
      </div>
      <div className="li-stat-row">
        <LiStat label="Business hours (seat local)" value={`${signals.rhythm.businessHours.start}:00–${signals.rhythm.businessHours.end}:00`} detail="end exclusive" />
        <LiStat label="Gap between actions" value={`${signals.rhythm.actionGapSeconds.min}–${signals.rhythm.actionGapSeconds.max}s`} detail="randomised, never a block" />
        <LiStat label="Weekend factor" value={`×${signals.rhythm.weekendFactor}`} detail={signals.rhythm.weekendFactor === 0 ? 'weekends left empty' : 'reduced weekend volume'} />
        <LiStat
          label="Enforcement-scan days"
          value={signals.rhythm.enforcementScanWeekdays.map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(' · ')}
          detail="never carry a day’s maximum"
        />
      </div>
    </section>
  </div>;
}

function CeilingRow({ limit }: { limit: LinkedInCeiling }) {
  const share = limit.ceiling === 0 ? 0 : Math.min(1, limit.used / limit.ceiling);
  const spent = limit.ceiling > 0 && limit.remaining === 0;
  return <div className="li-ceiling">
    <div className="li-ceiling-head">
      <span className="li-ceiling-window">{WINDOW_LABELS[limit.window]}</span>
      <strong className={spent ? 'li-ceiling-spent' : ''}>
        <b>{limit.used}</b> / {limit.ceiling}
      </strong>
      <span className="li-chip">bound by {humanizeRule(limit.boundBy)}</span>
      <ConfidenceTag confidence={limit.confidence} source={limit.source} compact />
    </div>
    <div className="li-ceiling-meter">
      <i className={spent ? 'li-ceiling-fill li-ceiling-fill-spent' : 'li-ceiling-fill'} style={{ width: `${share * 100}%` }} />
    </div>
    <p>{limit.rule}</p>
    <small>
      {limit.ceiling !== limit.bandCeiling && <>
        <b>Band ceiling</b> — what this seat’s connection-count band allows before any other rule touches it — is{' '}
        {limit.bandCeiling}; {limit.ceiling} is what applies after the rule above.{' '}
      </>}
      {limit.remaining} left · source: {limit.source}
    </small>
  </div>;
}

export function PostureBadge({ posture, reason }: { posture: string | null; reason?: string | null }) {
  if (!posture) return <span className="li-posture li-posture-none"><CircleAlert size={13} /> No seat</span>;
  const icon = posture === 'paused' || posture === 'cooldown' ? <CircleAlert size={13} />
    : posture === 'steady' ? <ShieldCheck size={13} /> : <TrendingUp size={13} />;
  return <span className={`li-posture li-posture-${posture}`} title={reason ?? undefined}>
    {icon} {posture}{posture === 'paused' && reason ? `: ${reason}` : ''}
  </span>;
}
