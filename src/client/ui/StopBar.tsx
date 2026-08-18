import { useEffect, useState } from 'react';
import { CircleStop, LoaderCircle, Play } from 'lucide-react';
import type { AgentRunSummary } from '../../shared/types';
import { ApiError, getAgentRuns, stopAgentRun } from '../api';
import { SEAT_STOP_COPY, useSeatStop } from '../LinkedInSafety';
import { ConfirmDrawer } from './dialog';

/* --------------------------------------------------------------------------
 * One incident surface, in the shell, on every route.
 *
 * Two stop controls used to exist and neither admitted the other did: the
 * outreach kill switch above the LinkedIn tab strip, and the agent's "ask it
 * to stop" buried inside a run card in Activity. The moment you need one is
 * the moment you have no attention left to remember there is a second, so
 * there is now one bar that names every actor that can still act and gives
 * each one its own control.
 *
 * What is carried over rather than invented:
 *
 * 1. TWO COLOURS, BECAUSE THEY ARE TWO FACTS. Amber for the agent -- nothing
 *    has gone wrong, and a run still doing what it was asked to do must not be
 *    dressed as a failure. Red for a paused seat, which is a stopped account.
 *    `.stopbar.is-live` carries the amber; `PostureBadge` and
 *    `.li-danger-button` carry the red, as they already did.
 * 2. TWO VERBS. "Ask it to stop" is cooperative: the run ends when it reaches
 *    the end of the step it is already in the middle of. "Pause everything" is
 *    immediate: ceilings drop to zero and the worker halts within one tick.
 *    Never one verb over both.
 * 3. A REASON ON BOTH. "Say why. This is the note you will read three weeks
 *    from now" was never LinkedIn-specific reasoning, and the agent stop route
 *    now takes one.
 * 4. EACH CALL REPORTS ITSELF. `POST /api/agent-runs/stop` 404s on builds
 *    without the hosted agent, so Stop everything never claims both stopped
 *    when one did: the two calls are settled independently and each answer is
 *    named.
 * 5. SECONDARY AND DESTRUCTIVE-STYLED, NEVER PRIMARY. One primary per screen,
 *    and on every screen this appears on it is spoken for by the thing that
 *    starts work.
 *
 * The SEAT half of this -- its state, its two calls, and every sentence
 * written for them -- belongs to `useSeatStop` in LinkedInSafety.tsx. This
 * file renders. It decides nothing about the seat and writes no seat copy of
 * its own.
 *
 * The sidebar is hidden below 760px. This is not: it is the one control an
 * operator reaches for on a phone.
 * -------------------------------------------------------------------------- */

/** How often the agent half re-reads. Faster while something can still act. */
const POLL_LIVE_MS = 20_000;
const POLL_QUIET_MS = 60_000;

type Pending = 'seat' | 'agent' | 'everything';

/** The one 404 that means "this build has no hosted agent", said in words. */
const agentReach = (error: unknown) => error instanceof ApiError && error.status === 404
  ? 'this workspace is on a build that does not run Trevra’s own agent, so there was nothing to stop there.'
  : error instanceof Error ? error.message : 'the agent was not reached.';

export interface StopControls {
  seat: ReturnType<typeof useSeatStop>;
  live: AgentRunSummary[];
  stopping: AgentRunSummary[];
  agentLive: boolean;
  seatLive: boolean;
  state: 'is-live' | 'is-stopped' | 'is-idle';
  pending: Pending | null;
  setPending: (pending: Pending | null) => void;
  confirmResume: boolean;
  setConfirmResume: (open: boolean) => void;
  busy: string;
  failure: string;
  setFailure: (failure: string) => void;
  run: (what: Pending, reason: string) => Promise<void>;
  resume: () => Promise<void>;
  agentDetail: string;
}

/**
 * Everything the bar and the header's seat button both need, read once.
 *
 * `useSeatStop` polls; a second instance of it is a second poller reading and
 * writing the same seat, out of step with the first. So this is called once,
 * by `ShellTop` in App.tsx, and its return value is threaded to both --
 * `StopBar` for the agent/everything rows, `SeatPauseButton` for the header.
 */
export function useStopControls(setToast: (message: string) => void): StopControls {
  const seat = useSeatStop();
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmResume, setConfirmResume] = useState(false);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');

  // A deployment without the hosted agent has no such ledger, and that must not
  // take the seat half of the bar down with it.
  const readRuns = async () => setRuns(await getAgentRuns(20).catch(() => [] as AgentRunSummary[]));

  const live = runs.filter((run) => run.status === 'running');
  const stopping = live.filter((run) => run.stopRequestedAt);
  const agentLive = live.length > stopping.length;
  const seatLive = seat.configured && !seat.paused;
  const anyStopped = seat.paused || stopping.length > 0;
  const anyLive = seatLive || agentLive;

  // BOTH HALVES POLL, not just the agent's. The seat's state was read once on
  // mount and then only when something on this tab changed it, so a seat paused
  // from the account screen in a second tab -- or by a teammate -- left this bar
  // saying "sending" on every route until a reload. `seat.reload` is the same
  // re-read the shell's Refresh triggers, and it is stable across renders.
  const reloadSeat = seat.reload;
  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) { void readRuns(); void reloadSeat(); } };
    tick();
    const timer = window.setInterval(tick, anyLive || anyStopped ? POLL_LIVE_MS : POLL_QUIET_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [anyLive, anyStopped, reloadSeat]);

  const state = anyStopped ? 'is-stopped' : anyLive ? 'is-live' : 'is-idle';

  const askAgent = async (reason: string): Promise<string> => {
    const targets = live.filter((run) => !run.stopRequestedAt);
    if (targets.length === 0) return 'nothing was running by the time this went through, so there was nothing to stop.';
    const asked = await Promise.all(targets.map((run) => stopAgentRun(run.id, reason)));
    const total = asked.reduce((sum, count) => sum + count, 0);
    return total > 1
      ? `${total} runs were going. All of them were asked to stop.`
      : 'stop asked for. It finishes the step it is on and then stops.';
  };

  /**
   * Two calls, two answers. A settled pair is reported as a settled pair --
   * saying "stopped" when only one of them did is the exact claim this bar
   * exists to prevent.
   */
  const run = async (what: Pending, reason: string) => {
    setBusy(what);
    setFailure('');
    const jobs: Array<{ actor: string; work: Promise<string>; failed: (error: unknown) => string }> = [];
    if ((what === 'seat' || what === 'everything') && seatLive) {
      jobs.push({
        actor: 'Outreach seat',
        // `useSeatStop` owns the call, the reason rule and the wording. It
        // answers false rather than throwing, so a false is turned back into a
        // rejection here and reported like any other half that did not happen.
        work: seat.pause(reason).then((ok) => {
          if (!ok) throw new Error(SEAT_STOP_COPY.pauseFailed);
          return SEAT_STOP_COPY.pausedToast;
        }),
        failed: (error) => error instanceof Error ? error.message : SEAT_STOP_COPY.pauseFailed
      });
    }
    if ((what === 'agent' || what === 'everything') && live.length > 0) {
      jobs.push({ actor: 'Agent', work: askAgent(reason), failed: agentReach });
    }
    if (jobs.length === 0) { setBusy(''); setPending(null); return; }

    const settled = await Promise.allSettled(jobs.map((job) => job.work));
    const lines = settled.map((result, index) => result.status === 'fulfilled'
      ? `${jobs[index].actor}: ${result.value}`
      : `${jobs[index].actor} did NOT stop — ${jobs[index].failed(result.reason)}`);
    setToast(lines.join(' '));
    const broken = lines.filter((_, index) => settled[index].status === 'rejected');
    if (broken.length > 0) {
      setFailure(`${broken.join(' ')} Everything else here did go through. Try that one again, or stop the campaigns individually on Campaigns.`);
    }
    await readRuns();
    setBusy('');
    setPending(null);
  };

  /**
   * Resume takes no reason, and the drawer no longer asks for one.
   *
   * It used to: the drawer was `requireReason`, so the button stayed disabled
   * until the operator typed something -- and then `onConfirm` dropped the
   * argument, because `seat.resume()` takes none and
   * `POST /api/linkedin/seat/resume` parses `seatKey` and nothing else. The
   * sentence reached no call, no column and no reader. A required field that is
   * thrown away is worse than no field: it teaches that the notes on this bar
   * are decorative, and the pause reason -- which IS stored and IS the note read
   * three weeks later -- is one of them. See `SEAT_STOP_COPY.resume.noRecord`
   * for the lc-debt marker on the route that would let it come back.
   */
  const resume = async () => {
    setBusy('resume');
    setFailure('');
    const ok = await seat.resume();
    if (ok) {
      setConfirmResume(false);
      setToast(SEAT_STOP_COPY.resumedToast);
    }
    // On a failure the drawer stays open: closing it would leave the operator
    // unable to tell whether outreach restarted. `seat.failure` says what did
    // not change.
    setBusy('');
  };

  const agentDetail = live.length === 1
    ? `step ${live[0].stepCount} of ${live[0].maxSteps}`
    : `${live.length} runs going`;

  return {
    seat, live, stopping, agentLive, seatLive, state,
    pending, setPending, confirmResume, setConfirmResume,
    busy, failure, setFailure, run, resume, agentDetail
  };
}

/**
 * The seat's own control, compact enough for the header.
 *
 * The badge, the full "stop everything at once..." sentence and the
 * `Pause outreach` / `Resume outreach` button used to be a whole row inside
 * the bar below. That row is gone from there -- this button, and the reason
 * drawers `StopBar` still renders (they portal to `document.body`, so where
 * they are declared does not matter), are the whole of it now. The sentence
 * is not gone, it is the title: hover or focus still gets you "stop
 * everything at once, ceilings drop to zero..." -- it just no longer sits
 * under the H1 on every route by default.
 */
export function SeatPauseButton({ controls }: { controls: StopControls }) {
  const { seat } = controls;
  if (!seat.configured) return null;
  if (seat.paused) {
    return <button
      className="secondary-button"
      type="button"
      title={SEAT_STOP_COPY.paused(seat.pausedReason)}
      disabled={seat.busy}
      onClick={() => controls.setConfirmResume(true)}
    >
      {controls.busy === 'resume' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} {SEAT_STOP_COPY.resumeLabel}
    </button>;
  }
  return <button
    className="li-danger-button"
    type="button"
    title={`Outreach seat · sending. ${SEAT_STOP_COPY.running}`}
    disabled={seat.busy || controls.busy !== ''}
    onClick={() => controls.setPending('seat')}
  >
    <CircleStop size={15} /> {SEAT_STOP_COPY.pauseLabel}
  </button>;
}

export function StopBar({ controls }: { controls: StopControls }) {
  const {
    seat, live, stopping, agentLive, seatLive, state,
    pending, setPending, confirmResume, setConfirmResume,
    busy, failure, setFailure, run, resume, agentDetail
  } = controls;

  // The seat's own row moved to the header (`SeatPauseButton`); what is left
  // here is the agent row, the combined "Stop everything" row, and failure
  // banners. A seat sending normally -- the common case -- now leaves this
  // section with nothing of its own to say, and it renders nothing rather
  // than an empty coloured bar under the H1.
  const hasBarContent = state === 'is-idle' || live.length > 0 || Boolean(failure || seat.failure || seat.readError);

  return <>
    {hasBarContent && <section className={`stopbar ${state}`} aria-label="What is running, and how to stop it">
    {/* Not `.stopbar-actor`: that class carries the amber outline an actor row
        needs, and idle is not an actor. Wearing it put a 1px amber alert under
        the H1 on every route, which is how amber stops meaning anything by the
        time it is true. `.stopbar.is-idle` already supplies the muted colour,
        the size and the hairline. */}
    {/* "Nothing is running" is a CLAIM, and before the seat read lands nobody
        has checked. `seat.loading` is the difference between the two, and the
        bar says which one it is rather than asserting the safe-sounding one
        while the answer is still on the wire. */}
    {state === 'is-idle' && <p className="stopbar-idle">{seat.loading ? 'Reading what is running…' : 'Nothing is running.'}</p>}

    {live.length > 0 && <div className="stopbar-actor">
      <span className="run-status run-running">Agent</span>
      <span>{stopping.length === live.length
        ? 'Stop asked for. It finishes the step it is on and then stops — it will not start another. Anything it already prepared stays waiting for you.'
        : `Agent · ${agentDetail}. Asking it to stop is cooperative: it finishes the step it is on, then stops. Anything it already prepared stays waiting for you.`}</span>
      <button
        className="ghost-button danger"
        type="button"
        disabled={busy !== '' || !agentLive}
        onClick={() => setPending('agent')}
      >
        {busy === 'agent' ? <LoaderCircle className="spin" size={15} /> : <CircleStop size={15} />}
        {agentLive ? 'Ask it to stop' : 'Stop asked for'}
      </button>
    </div>}

    {seatLive && agentLive && <div className="stopbar-actor">
      <span>Both are going. These are two different stops, so one button asks each of them separately and tells you what each one answered.</span>
      <button className="li-danger-button" type="button" disabled={busy !== '' || seat.busy} onClick={() => setPending('everything')}>
        {busy === 'everything' ? <LoaderCircle className="spin" size={15} /> : <CircleStop size={15} />} Stop everything
      </button>
    </div>}

    {(failure || seat.failure || seat.readError) && !confirmResume
      && <div className="error-banner">{failure || seat.failure || seat.readError}</div>}
  </section>}

    {pending && <ConfirmDrawer
      title={pending === 'seat' ? 'Pause the outreach seat?'
        : pending === 'agent' ? 'Ask the agent to stop?'
          : 'Stop the seat and the agent?'}
      tone={pending === 'agent' ? 'caution' : 'danger'}
      requireReason
      reasonLabel={pending === 'agent' ? 'Why are you stopping it?' : SEAT_STOP_COPY.reasonFieldLabel}
      body={pending === 'seat'
        ? <>
            <p>{SEAT_STOP_COPY.running}</p>
            {/* The throttle factor is the server's, not this file's: the
                sentence used to say "halves" whatever the payload said. */}
            <p>{SEAT_STOP_COPY.onlyAHumanZeroesASeat(seat.throttleFactor)}</p>
            <p>{SEAT_STOP_COPY.reasonRequired}</p>
          </>
        : pending === 'agent'
          ? <>
              <p>Stopping is cooperative: the run ends when it reaches the end of the step it is already in the middle of, which may be a model call halfway through generating. Nothing says “stopped” until the run’s own status does.</p>
              <p>Anything it already prepared stays waiting for you. {SEAT_STOP_COPY.reasonRequired}</p>
            </>
          : <>
              <p>These are two different stops. The seat stops <strong>immediately</strong>: ceilings to zero, worker halted within one tick. The agent is <strong>asked</strong> to stop, and ends when it finishes the step it is on.</p>
              <p>They are two separate calls and each one answers for itself. If one fails you will be told which — and the other still went through.</p>
              <p>{SEAT_STOP_COPY.reasonRequired}</p>
            </>}
      confirmLabel={pending === 'seat' ? SEAT_STOP_COPY.pauseLabel
        : pending === 'agent' ? 'Ask it to stop'
          : 'Stop everything'}
      busy={busy === pending}
      error={busy === '' ? failure || null : null}
      onCancel={() => { if (busy === '') { setPending(null); setFailure(''); seat.clearFailure(); } }}
      onConfirm={(reason) => void run(pending, reason)}
    />}

    {confirmResume && <ConfirmDrawer
      title={SEAT_STOP_COPY.resume.title}
      body={<>
        <p>{SEAT_STOP_COPY.resume.whatRestarts(seat.pausedReason)}</p>
        <p>{SEAT_STOP_COPY.resume.warmupKeeps}</p>
        <p>{SEAT_STOP_COPY.resume.noRecord}</p>
      </>}
      confirmLabel={SEAT_STOP_COPY.resume.confirmLabel}
      busy={seat.busy}
      error={seat.failure || null}
      onCancel={() => { if (!seat.busy) { setConfirmResume(false); seat.clearFailure(); } }}
      onConfirm={() => void resume()}
    />}
  </>;
}
