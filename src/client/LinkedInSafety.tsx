import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getLinkedInLimits,
  getLinkedInManagerSeats,
  pauseLinkedInSeat,
  resumeLinkedInSeat,
  type ExportFormat,
  type LinkedInActionKind,
  type LinkedInActionStatus,
  type LinkedInLimitsReport,
  type LinkedInSeat,
  type PacedKind,
  type SequenceTone
} from './api';

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
  inmail: 'InMail (not sent by Trevra)',
  profile_view: 'Profile views',
  follow: 'Follows',
  unfollow: 'Unfollows',
  disconnect: 'Connection removals',
  like: 'Likes',
  endorse: 'Endorsements'
};

/**
 * The three kinds ONE operator “messages” number counts together.
 *
 * Mirrors `MESSAGE_POOL_KINDS` in src/server/app.ts, which is the list the
 * limits route appends its pool note from and the list `guard.ts` counts the
 * operator's pool over.
 */
const MESSAGE_POOL_KINDS: readonly PacedKind[] = ['dm', 'reply', 'inmail'];

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
    return () => {
      refreshHandlers.delete(handler);
    };
  }, []);
}

/* -------------------------------------------------------------------------
 * The ceilings, read once per screen.
 * ---------------------------------------------------------------------- */

interface SeatLimitsRead {
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
export function useSeatLimits(seatKey?: string): SeatLimitsRead {
  const [limits, setLimits] = useState<LinkedInLimitsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // WHICH ACCOUNT'S CEILINGS. Omitted, the route answers for the
      // workspace's first account -- which is the right default for a caller
      // that has no account in hand, and the wrong answer for a screen sitting
      // under the account switcher.
      setLimits(await getLinkedInLimits(seatKey));
      setError('');
    } catch (err) {
      setError(
        errorMessage(err, 'Unable to read this seat’s ceilings. Nothing was changed — try again.')
      );
    } finally {
      setLoading(false);
    }
  }, [seatKey]);

  useEffect(() => {
    void reload();
  }, [reload]);
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
  factor === null
    ? `${past ? 'reduced' : 'reduces'} ${object}`
    : factor === 0.5
      ? `${past ? 'halved' : 'halves'} ${object}`
      : `${past ? 'cut' : 'cuts'} ${object} to ${Math.round(factor * 100)}% of it`;

/** The same decision quoted as an imperative, for “X would quietly become end it”. */
const throttleImperative = (factor: number | null) =>
  factor === null
    ? 'reduce it'
    : factor === 0.5
      ? 'halve it'
      : `cut it to ${Math.round(factor * 100)}%`;

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
  running:
    'Stop everything at once. Ceilings drop to zero, the worker halts within one tick, and a campaign already in a browser is the only thing that finishes.',
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
  resumedToast:
    'Seat resumed. The warm-up ramp picks up where it left off — it is measured from when this seat started sending through Trevra, so resuming does not restart it.',
  pauseFailed:
    'Unable to pause the seat. Nothing changed — the seat is still running. Try again, or stop the campaigns individually on Campaigns.',
  resumeFailed:
    'Unable to resume the seat. It is still paused, which is the safe end of that failure. Try again.',
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
      'Real invites and messages start going out again, on the LinkedIn account this seat signs in as.' +
      (reason ? ` It was stopped because: ${reason}.` : ''),
    warmupKeeps:
      'The warm-up ramp picks up where it left off — it is measured from when this seat started sending through Trevra, so resuming does not restart it.',
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
    noRecord:
      'Pausing left a note; resuming does not. There is nowhere to store one on the way up — the pause reason it replaces is what the ledger keeps.'
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

interface SeatStop {
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
  const { limits, loading, error, reload: reloadLimits } = useSeatLimits();
  /**
   * EVERY ACCOUNT, NOT THE FIRST ONE.
   *
   * `GET /api/linkedin/limits` reports on ONE seat -- the workspace's first --
   * so a stop built on it alone paused the primary account and left every
   * secondary one sending. That is the exact failure this bar exists to
   * prevent, and it is worse than no bar: `AccountPanel` tells the operator of
   * a secondary account that "the Stop bar at the top of every screen does
   * both", so the one control they were pointed at silently did nothing for
   * them. `GET /api/linkedin/manager/seats` is the list of accounts that can
   * still act; every row it returns is a configured seat.
   *
   * Null means the list has not been read (or the read failed), and the
   * primary-only reading below is the fallback -- degraded, never absent: a
   * kill switch that renders nothing because a list call failed is a kill
   * switch that is missing at the one moment it is needed.
   */
  const [seats, setSeats] = useState<LinkedInSeat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const reloadSeats = useCallback(async () => {
    try {
      setSeats(await getLinkedInManagerSeats());
    } catch {
      /* Falls back to the primary seat below rather than blanking the control. */
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([reloadLimits(), reloadSeats()]);
  }, [reloadLimits, reloadSeats]);

  useEffect(() => {
    void reloadSeats();
  }, [reloadSeats]);
  useOutreachRefresh(reloadSeats);

  const primary = limits?.seat ?? null;
  const known = seats && seats.length > 0 ? seats : null;
  const live = known?.filter((row) => row.posture !== 'paused') ?? null;
  const configured = known ? true : Boolean(primary?.configured);
  // Paused means NOTHING CAN STILL ACT. With one account still running the bar
  // must keep offering the stop, which is what `StopBar` derives from this.
  const paused = live ? live.length === 0 : primary?.posture === 'paused';
  const pausedReason = known
    ? (known.find((row) => row.posture === 'paused')?.pausedReason ?? null)
    : (primary?.pausedReason ?? null);

  /**
   * One call per account that is not already in the state being asked for, all
   * at once, and each answer kept.
   *
   * `allSettled`, not `all`: a workspace where three accounts paused and the
   * fourth did not must say which one is still running, not report the whole
   * stop as failed and not report it as done.
   */
  const applyToSeats = useCallback(
    async (
      targets: LinkedInSeat[] | null,
      act: (seatKey: string | undefined) => Promise<unknown>,
      failedCopy: string
    ): Promise<boolean> => {
      const keys: Array<string | undefined> = targets
        ? targets.map((row) => row.seatKey)
        : [undefined];
      if (keys.length === 0) return true;
      const settled = await Promise.allSettled(keys.map((key) => act(key)));
      const broken = settled
        .map((outcome, index) => ({
          outcome,
          label: targets?.[index]?.label ?? targets?.[index]?.seatKey ?? null
        }))
        .filter((entry) => entry.outcome.status === 'rejected');
      if (broken.length === 0) return true;
      const named = broken
        .map((entry) => entry.label)
        .filter((label): label is string => Boolean(label));
      setFailure(
        named.length > 0 ? `${failedCopy} Still not changed: ${named.join(', ')}.` : failedCopy
      );
      return false;
    },
    []
  );

  const pause = useCallback(
    async (reason: string) => {
      if (!reason.trim()) {
        setFailure(SEAT_STOP_COPY.reasonRequired);
        return false;
      }
      setBusy(true);
      setFailure('');
      try {
        const ok = await applyToSeats(
          live,
          (seatKey) => pauseLinkedInSeat(reason.trim(), seatKey),
          SEAT_STOP_COPY.pauseFailed
        );
        // Every mounted outreach screen is now describing a seat that stopped.
        await reloadOutreach();
        await reloadSeats();
        return ok;
      } catch (err) {
        setFailure(errorMessage(err, SEAT_STOP_COPY.pauseFailed));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applyToSeats, live, reloadSeats]
  );

  const resume = useCallback(async () => {
    setBusy(true);
    setFailure('');
    try {
      const stopped = known?.filter((row) => row.posture === 'paused') ?? null;
      const ok = await applyToSeats(
        stopped,
        (seatKey) => resumeLinkedInSeat(seatKey),
        SEAT_STOP_COPY.resumeFailed
      );
      await reloadOutreach();
      await reloadSeats();
      return ok;
    } catch (err) {
      // The caller keeps its drawer open on a failure: closing it would leave
      // the operator unable to tell whether outreach restarted.
      setFailure(errorMessage(err, SEAT_STOP_COPY.resumeFailed));
      return false;
    } finally {
      setBusy(false);
    }
  }, [applyToSeats, known, reloadSeats]);

  return {
    configured,
    paused,
    posture: paused ? 'paused' : (primary?.posture ?? known?.[0]?.posture ?? null),
    pausedReason,
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
