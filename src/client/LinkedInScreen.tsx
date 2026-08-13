import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ban,
  Check,
  CircleAlert,
  ExternalLink,
  Linkedin,
  ListTree,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Undo2,
  Unplug
} from 'lucide-react';
import {
  ApiError,
  LINKEDIN_ACTION_KINDS,
  LINKEDIN_ACTION_STATUSES,
  PACED_KINDS,
  addLinkedInExclusions,
  deleteLinkedInCredentials,
  deleteLinkedInSeat,
  detectLinkedInSeat,
  getLinkedInActions,
  getLinkedInAnalytics,
  getLinkedInCampaigns,
  getLinkedInExclusions,
  getLinkedInSeat,
  getLinkedInWithdrawalCandidates,
  getLinkedInWithdrawals,
  getLinkedInWorkerStatus,
  loginLinkedInSeat,
  queueLinkedInWithdrawals,
  recordLinkedInOutcome,
  saveLinkedInCredentials,
  saveLinkedInSeat,
  skipLinkedInAction,
  syncLinkedInPendingInvites,
  type LinkedInActionKind,
  type LinkedInActionStatus,
  type LinkedInActionView,
  type LinkedInAnalytics,
  type LinkedInCampaign,
  type LinkedInExclusion,
  type LinkedInLimitsReport,
  type LinkedInSeatResponse,
  type LinkedInWithdrawalCandidates,
  type LinkedInWorkerStatus,
  type WithdrawalRecord,
  type WithdrawalStatus
} from './api';
import {
  ACTION_KIND_LABELS,
  ACTION_KIND_LABELS_ONE,
  ACTION_STATUS_LABELS,
  KIND_LABELS,
  actionStatusLabel,
  LinkedInSafetyScreen,
  PostureBadge,
  errorMessage,
  reloadOutreach,
  useOutreachRefresh,
  useSeatLimits
} from './LinkedInSafety';
import { useWorkspaceMembers } from './TeamScreen';
import { ConfidenceTag, LiStat } from './LinkedInViz';
import { ConfirmDrawer } from './ui/dialog';

/**
 * LinkedIn outreach (docs/linkedin-outreach-plan.md section 6).
 *
 * Four screens, each on its own hash route, and three things are true on every
 * one of them:
 *
 * 1. EACH ONE STANDS ALONE. There is no LinkedIn tab shell any more: the app
 *    shell routes `#/outreach`, `#/outreach/queue`, `#/setup/seat` and
 *    `#/setup/limits` straight at these components, so each reads what it
 *    needs for itself. Nothing here takes a prop only a parent tab strip could
 *    have supplied, because there is no parent tab strip to supply one.
 * 2. THE STOP IS ALWAYS REACHABLE -- and it is no longer here. The kill switch
 *    used to sit above the tab strip because the one moment it is needed is the
 *    moment something else has already gone wrong, and a switch somebody has to
 *    navigate to is a switch they find too late. That argument was always for a
 *    control ONE LEVEL UP, so it went there: `StopBar` in the app shell, on
 *    every route, stopping the agent in the same breath. What this area still
 *    owns is the seat's own state and every sentence written for it --
 *    `useSeatStop` and `SEAT_STOP_COPY` in LinkedInSafety.tsx.
 * 3. NO SCREEN SENDS ANYTHING. There is no route that would let one. What
 *    reaches LinkedIn reaches it through a file the operator downloads and runs
 *    in their own tool, or through the self-hosted worker driving a browser
 *    they logged into by hand.
 */

/**
 * `2 hours ago`. For the one timestamp an operator reads as a duration -- how
 * stale the signed-in session is -- where an absolute clock time answers a
 * question nobody asked. The seat card keeps its absolute dates.
 */
export const relativeTime = (iso: string) => {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12]
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), 'year');
};

/** `https://www.linkedin.com/in/pankaj-x/` -> `in/pankaj-x`. The URL still links. */
const vanityOf = (profileUrl: string) => {
  try {
    const path = new URL(profileUrl).pathname.replace(/\/+$/, '');
    return path.replace(/^\//, '') || profileUrl;
  } catch { return profileUrl; }
};

/* -------------------------------------------------------------------------
 * `#/outreach` -- the Seat screen.
 * ---------------------------------------------------------------------- */

/**
 * What may go out today, why that number, and where the variance is.
 *
 * It is the operating dashboard, which is why it is the root of `#/outreach`
 * rather than the third item behind a Setup tab. It reads and it writes
 * nothing: `setToast` is taken because the shell hands it to every outreach
 * screen, and this one never has cause to fire it.
 *
 * Two reads, two lifetimes. The ceilings come from `GET /api/linkedin/limits`
 * and do not depend on how many days of history somebody is looking at; the
 * series does, and refetches on its own when the window changes. A failed
 * series is not worth an error banner over a screen whose subject is the
 * ceilings.
 */
export function OutreachSeat(_props: { setToast: (message: string) => void }) {
  const { limits, loading, error, reload } = useSeatLimits();
  const [analytics, setAnalytics] = useState<LinkedInAnalytics | null>(null);
  const [days, setDays] = useState(30);
  const [seriesLoading, setSeriesLoading] = useState(true);
  /** Last request wins, so a fast 7-day read cannot overwrite a slow 90-day one. */
  const seriesToken = useRef(0);

  const loadSeries = useCallback(async () => {
    const token = seriesToken.current + 1;
    seriesToken.current = token;
    setSeriesLoading(true);
    try {
      const response = await getLinkedInAnalytics(days);
      if (seriesToken.current === token) setAnalytics(response);
    } catch { /* the window selector is not worth an error banner over the ceilings */ }
    finally { if (seriesToken.current === token) setSeriesLoading(false); }
  }, [days]);

  useEffect(() => { void loadSeries(); }, [loadSeries]);
  useOutreachRefresh(loadSeries);

  return <div className="page-stack">
    {error && <div className="error-banner">
      <strong>{error}</strong> Nothing was changed. Whatever is below is the last good read.{' '}
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read the ceilings again
      </button>
    </div>}

    {limits
      ? <LinkedInSafetyScreen
        limits={limits}
        analytics={analytics}
        days={days}
        onDaysChange={setDays}
        seriesLoading={seriesLoading}
      />
      : !error && <LoadingPanel loading={loading} />}
  </div>;
}

function LoadingPanel({ loading }: { loading: boolean }) {
  return <section className="page-panel">
    <p className="empty-copy">{loading ? 'Reading the seat’s ledger…' : 'No data.'}</p>
  </section>;
}

/* -------------------------------------------------------------------------
 * `#/setup/seat` -- seat identity, credentials, local worker.
 * ---------------------------------------------------------------------- */

/**
 * The seat, configured once.
 *
 * It left Outreach because it is not an operating screen: a seat is named,
 * connected and then left alone, and it sat in first position on a strip whose
 * other five items are read every day. What it does NOT take with it is the
 * kill switch, which was never a settings control -- see the file header.
 *
 * Three reads, because the screen answers three questions that come from three
 * places: who this seat is (`GET /api/linkedin/seat`), what it has spent today
 * (`GET /api/linkedin/limits`), and whether anything on this machine can drive
 * it (`GET /api/linkedin/worker`).
 */
export function LinkedInSeatSetup({ setToast }: { setToast: (message: string) => void }) {
  const [seat, setSeat] = useState<LinkedInSeatResponse | null>(null);
  const [worker, setWorker] = useState<LinkedInWorkerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { limits } = useSeatLimits();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [seatResponse, workerResponse] = await Promise.all([getLinkedInSeat(), getLinkedInWorkerStatus()]);
      setSeat(seatResponse);
      setWorker(workerResponse);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read this seat. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  return <div className="page-stack">
    {error && <div className="error-banner">
      <strong>{error}</strong> Whatever is below is the last good read, and nothing on this screen was saved.{' '}
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read the seat again
      </button>
    </div>}

    {/* A save here changes what every other outreach screen is pricing against,
        so the broadcast is the whole point: the ceilings on Seat and the
        binding rule under a campaign's horizon are stale the moment this
        succeeds. */}
    <SetupTab seat={seat} worker={worker} limits={limits} setToast={setToast} onSaved={() => void reloadOutreach()} />

    {/* The backlog, and the two-step way out of it. It sits here rather than on
        Safety because Safety reads and writes nothing, and both controls below
        write -- one of them drives a browser. */}
    <PendingInviteWithdrawals setToast={setToast} />
  </div>;
}

/* -------------------------------------------------------------------------
 * Pending invites, and withdrawing the stale ones.
 * ---------------------------------------------------------------------- */

const WITHDRAWAL_STATUS_LABELS: Record<WithdrawalStatus, string> = {
  queued: 'Queued',
  withdrawn: 'Withdrawn',
  stale: 'Gone from LinkedIn',
  failed: 'Failed',
  held: 'Held by the gate'
};

/**
 * The outstanding-invite backlog, and the two steps that clear it.
 *
 * WHY A BACKLOG IS A CEILING AT ALL. Every other count in this product is
 * rolling, because every other ceiling is about RATE. "Pending" has no window:
 * an invite sent in March is still occupying a slot in June, still consuming
 * the weekly invite capacity on LinkedIn's side, and still a permanent zero in
 * the acceptance numerator. Sending more does not return that capacity;
 * withdrawing the stale ones does.
 *
 * THE TWO STEPS ARE NOT ONE STEP, and the whole panel is shaped to make that
 * unmistakable. `Queue withdrawals` writes reversible database rows and its
 * response ALWAYS says `withdrawn: 0` -- the local worker claims each row,
 * re-runs the entire safety gate against it, and clicks at 30-120s gaps,
 * because clearing a backlog in one burst is the same volume spike as sending
 * one. A panel that reported "12 withdrawn" here would be read as broken the
 * first moment somebody checked LinkedIn.
 */
function PendingInviteWithdrawals({ setToast }: { setToast: (message: string) => void }) {
  const [backlog, setBacklog] = useState<LinkedInWithdrawalCandidates | null>(null);
  const [queue, setQueue] = useState<WithdrawalRecord[]>([]);
  const [olderThanDays, setOlderThanDays] = useState(21);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'sync' | 'queue' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  /** A 409 from the sync route: something to do on this machine, in the server's words. */
  const [blocked, setBlocked] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [candidates, withdrawals] = await Promise.all([
        getLinkedInWithdrawalCandidates({ olderThanDays }),
        getLinkedInWithdrawals({ limit: 50 })
      ]);
      setBacklog(candidates);
      setQueue(withdrawals);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the pending-invite backlog. Nothing was changed — try again.'));
    } finally { setLoading(false); }
  }, [olderThanDays]);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  const sync = async () => {
    setBusy('sync');
    setBlocked('');
    setError('');
    try {
      const result = await syncLinkedInPendingInvites();
      setToast(`${result.listed} invitation(s) listed · ${result.matched} matched to this ledger, ${result.unmatched} sent by hand, `
        + `${result.disappeared} no longer shown.${result.truncated ? ' The list was longer than one pass reads.' : ''}`);
      await load();
    } catch (err) {
      const message = errorMessage(err, 'Unable to re-read the sent-invitations list');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally { setBusy(null); }
  };

  const enqueue = async () => {
    setBusy('queue');
    setError('');
    try {
      const result = await queueLinkedInWithdrawals({ olderThanDays });
      setConfirming(false);
      setToast(`${result.queued} withdrawal(s) queued${result.duplicates > 0 ? `, ${result.duplicates} already queued` : ''}. `
        + `Nothing has been withdrawn yet — the response says withdrawn: ${result.withdrawn}, and it always will. `
        + 'The worker performs them one at a time, gated and paced.');
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to queue those withdrawals'));
      setConfirming(false);
    } finally { setBusy(null); }
  };

  const pending = backlog?.pendingInvites ?? 0;
  const ceiling = backlog?.maxOutstandingInvites ?? 0;
  const candidates = backlog?.candidates ?? [];
  const over = ceiling > 0 && pending >= ceiling;
  const share = ceiling > 0 ? Math.min(1, pending / ceiling) : 0;

  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3>Outstanding invites</h3>
        <p>
          Not a rolling window. An invite nobody answered keeps occupying a slot on LinkedIn’s side until it is accepted
          or withdrawn, so a backlog spends weekly capacity that sending more cannot return.
        </p>
      </div>
      <ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.4" compact />
    </div>

    {error && <div className="error-banner">{error}</div>}

    {blocked && <div className="li-connect-blocked">
      <strong><CircleAlert size={14} /> One thing has to happen on your machine first.</strong>
      <p className="li-blocked-message">{blocked}</p>
      <p>Nothing was read and nothing was queued.</p>
    </div>}

    <div className="li-backlog">
      <div className="li-backlog-head">
        <strong className={over ? 'li-backlog-over' : ''}>{pending}</strong>
        <span>of {ceiling || '—'} outstanding invites{over ? ' — at or past the ceiling' : ''}</span>
      </div>
      <div
        className="li-backlog-meter"
        role="img"
        aria-label={ceiling > 0
          ? `${pending} outstanding invites against a reported ceiling of ${ceiling}.`
          : `${pending} outstanding invites. No ceiling was reported for this seat.`}
      >
        <i className={over ? 'li-backlog-fill li-backlog-fill-over' : 'li-backlog-fill'} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="li-hint">
        {over
          ? 'The safety gate refuses a new invite past this line, and it is right to: LinkedIn measures the backlog too. '
            + 'Withdrawing the stale ones is what returns capacity here.'
          : 'The gate refuses a new invite once the backlog reaches the ceiling. This number is REPORTED, from the same figure that puts acceptance at 25–30% above 100 invites a week.'}
      </p>
    </div>

    <div className="li-filter-row">
      <label>Pending longer than
        <input
          type="number"
          min={0}
          max={365}
          value={olderThanDays}
          onChange={(event) => setOlderThanDays(Math.max(0, Math.trunc(Number(event.target.value) || 0)))}
        />
      </label>
      <span className="li-filter-label">days</span>
      <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void sync()}>
        {busy === 'sync' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Sync from LinkedIn
      </button>
      {loading && <LoaderCircle className="spin" size={14} aria-label="Reading the backlog" />}
    </div>
    <p className="panel-note">
      Syncing re-reads LinkedIn’s own sent-invitations list in a browser on this machine and writes EVIDENCE, never a
      conclusion: accepted, declined, expired and withdrawn all look identical from that list, so an invite’s absence is
      recorded as absence and nothing is inferred from it.
    </p>

    <h4 className="li-subhead">Stale enough to withdraw ({candidates.length})</h4>
    {candidates.length === 0
      ? <p className="empty-copy">
        Nothing has been waiting longer than {olderThanDays} day(s). This is a shortlist, not a decision — it shows what
        <em> would</em> be queued, before anything is.
      </p>
      : <div className="li-table-scroll">
        <table className="li-table">
          <thead><tr><th>Target</th><th>Waiting</th><th>Campaign</th></tr></thead>
          <tbody>{candidates.map((candidate) => <tr key={candidate.actionId}>
            <td className="li-target">{candidate.targetRef}</td>
            <td className="li-num">{candidate.pendingDays} day{candidate.pendingDays === 1 ? '' : 's'}</td>
            <td>{candidate.campaignId ?? '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>}

    <div className="li-two-step">
      <Undo2 size={20} />
      <div>
        <strong>Queueing is not withdrawing, and this response always says <code>withdrawn: 0</code>.</strong>
        <p>
          Queueing writes one reversible row per invite. The local worker then claims them one at a time, re-runs the
          whole safety gate against each, and clicks Withdraw at randomised 30–120 second gaps inside the seat’s business
          hours — because clearing a backlog in one burst is the same volume spike as sending one. Watch the queue below
          for what actually happened.
        </p>
      </div>
    </div>

    <div className="panel-footer">
      <span>
        Withdrawing does not un-send an invite: the ledger keeps counting it in every rolling window, so volume cannot be
        laundered by withdrawing and re-sending.
      </span>
      <button
        className="primary-button"
        type="button"
        disabled={busy !== null || candidates.length === 0}
        onClick={() => setConfirming(true)}
      >
        {busy === 'queue' ? <LoaderCircle className="spin" size={15} /> : <Undo2 size={15} />} Queue {candidates.length} withdrawal(s)
      </button>
    </div>

    {queue.length > 0 && <>
      <h4 className="li-subhead">The withdrawal queue</h4>
      <div className="li-table-scroll">
        <table className="li-table">
          <thead><tr><th>Target</th><th>Status</th><th>Waited</th><th>Queued</th><th>Finished</th></tr></thead>
          <tbody>{queue.map((record) => <tr key={record.id}>
            <td className="li-target">{record.targetRef}</td>
            <td>
              <span className={`li-chip li-wd-${record.status}`}>{WITHDRAWAL_STATUS_LABELS[record.status] ?? record.status}</span>
              {record.detail && <small className="li-failure">{record.detail}</small>}
            </td>
            <td className="li-num">{record.pendingDays === null ? '—' : `${record.pendingDays}d`}</td>
            <td>{new Date(record.queuedAt).toLocaleString()}</td>
            <td>{record.finishedAt ? new Date(record.finishedAt).toLocaleString() : '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}

    {confirming && <ConfirmDrawer
      title={`Queue ${candidates.length} withdrawal(s)?`}
      busy={busy === 'queue'}
      body={<>
        <p>
          <b>This queues them. It withdraws nothing.</b> The response will say <code>withdrawn: 0</code>, and that is
          correct — the rows are filed for the local worker to perform.
        </p>
        <p>
          The worker claims one at a time, re-runs the entire safety gate against it, and clicks Withdraw at randomised
          30–120 second gaps inside this seat’s business hours. Nothing happens at all while the seat is paused.
        </p>
        <p>
          Each withdrawal is real on LinkedIn and cannot be taken back — the person can be invited again, but this
          invite is gone. The ledger keeps counting the original send in every rolling window.
        </p>
      </>}
      confirmLabel={`Queue ${candidates.length} withdrawal(s)`}
      onConfirm={() => void enqueue()}
      onCancel={() => setConfirming(false)}
    />}
  </section>;
}

function SetupTab({ seat, worker, limits, setToast, onSaved }: {
  seat: LinkedInSeatResponse | null;
  worker: LinkedInWorkerStatus | null;
  limits: LinkedInLimitsReport | null;
  setToast: (message: string) => void;
  onSaved: () => void;
}) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = seat?.seat ?? null;
  const auth = seat?.auth ?? null;

  // The manual fields exist for what detection cannot cover, and nothing else.
  // They are behind a disclosure that starts closed, because a form that opens
  // itself is a form the operator believes they have to fill in.
  const [label, setLabel] = useState('');
  const [profileUrl, setProfileUrl] = useState('');
  const [timezone, setTimezone] = useState(browserZone);
  const [connections, setConnections] = useState('');
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [failure, setFailure] = useState('');
  /** A 409 or a 202 from the detect route. Something to go and do, not a fault -- shown verbatim. */
  const [blocked, setBlocked] = useState('');
  const [degraded, setDegraded] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Sign-in. `password` is the one value on this screen that must not outlive
  // its own submit, so nothing else ever reads it and it is cleared the moment
  // the request that carries it has been made.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'credentials' | 'otp'>('credentials');
  const [signingIn, setSigningIn] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingSeat, setDeletingSeat] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The server's own sentence. 'instruction' is a step to take; 'error' is something that went wrong. */
  const [note, setNote] = useState<{ tone: 'error' | 'instruction'; message: string } | null>(null);

  // A code the operator is halfway through typing outranks a stored credential:
  // the POST that saved it already succeeded, and swapping to the connected row
  // now would take the OTP field away mid-sign-in.
  const connected = Boolean(auth?.hasCredentials) && stage === 'credentials';

  useEffect(() => {
    if (hydrated || !seat) return;
    if (seat.seat) {
      setLabel(seat.seat.label);
      setProfileUrl(seat.seat.profileUrl ?? '');
      setTimezone(seat.seat.timezone);
      setConnections(seat.seat.connectionsCount === null ? '' : String(seat.seat.connectionsCount));
    }
    setHydrated(true);
  }, [seat, hydrated]);

  /**
   * One button, one field on the wire.
   *
   * The timezone is the only thing this browser knows that a worker driving the
   * session cannot read for itself, so it is the only thing sent. Everything
   * else -- name, vanity URL, connection count -- comes out of the session.
   */
  const detect = async () => {
    setDetecting(true);
    setFailure('');
    setBlocked('');
    try {
      const result = await detectLinkedInSeat(browserZone);
      // 202: this process cannot open a browser, so the read was queued for one
      // that can. The server's sentence names what to run; it is not an error.
      if (result.status === 'pending') {
        setBlocked(result.message ?? 'The read was queued for a machine that can open a browser.');
        onSaved();
        return;
      }
      setDegraded(result.degraded);
      setToast(result.detected
        ? `Read ${result.detected.name ?? 'the profile'} from your logged-in session.`
        : 'Reached LinkedIn but read nothing usable. Set what is missing by hand.');
      setHydrated(false);
      onSaved();
    } catch (err) {
      const message = errorMessage(err, 'Unable to read the profile from LinkedIn');
      // 409 is the login wall or a disabled worker. The server's message names
      // the one thing to do; rewriting it would drop the path forward.
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setFailure(message);
    } finally { setDetecting(false); }
  };

  /**
   * One round of the login route, and the four things it can answer.
   *
   * `otp_required` is a STEP, not a failure: LinkedIn took the password and is
   * waiting on the code it just sent, so the card swaps to one field rather
   * than turning red. `challenge` is a thing to go and do. Only `failed` is an
   * error, and all three arrive as one sentence written by the server.
   */
  const runLogin = async (code?: string) => {
    const result = await loginLinkedInSeat(code);
    if (result.status === 'otp_required') {
      setStage('otp');
      setNote(null);
      return;
    }
    if (result.status === 'ok') {
      setStage('credentials');
      setOtp('');
      setNote(null);
      setToast('Signed into LinkedIn on this machine.');
      await detect();
      return;
    }
    setNote({ tone: result.status === 'challenge' ? 'instruction' : 'error', message: result.message });
  };

  const attempt = async (run: () => Promise<void>) => {
    setSigningIn(true);
    try { await run(); }
    catch (err) { setNote({ tone: 'error', message: errorMessage(err, 'Unable to sign in to LinkedIn') }); }
    finally { setSigningIn(false); }
  };

  const signIn = () => void attempt(async () => {
    const address = email.trim();
    if (!address || !password) {
      setNote({ tone: 'error', message: 'Both the email and the password are needed to sign in.' });
      return;
    }
    setNote(null);
    try {
      await saveLinkedInCredentials({ email: address, password });
    } finally {
      // Out of component state the moment it is on the wire, whatever became of it.
      setPassword('');
    }
    await runLogin();
  });

  const disconnect = async () => {
    setDisconnecting(true);
    setNote(null);
    try {
      await deleteLinkedInCredentials();
      setStage('credentials');
      setEmail('');
      setOtp('');
      setToast('Credentials removed. Nothing on this machine can sign in until you add them again.');
      onSaved();
    } catch (err) {
      setNote({ tone: 'error', message: errorMessage(err, 'Unable to remove the stored credentials') });
    } finally { setDisconnecting(false); }
  };

  const removeSeat = async () => {
    setDeletingSeat(true);
    setDeleteError(null);
    try {
      await deleteLinkedInSeat();
      setConfirmingDelete(false);
      setToast('Seat deleted. A new one starts its warm-up ramp from week 1.');
      setHydrated(false);
      onSaved();
    } catch (err) {
      setDeleteError(errorMessage(err, 'Unable to delete the seat'));
    } finally { setDeletingSeat(false); }
  };

  const save = async () => {
    setBusy(true);
    setFailure('');
    try {
      await saveLinkedInSeat({
        label: label.trim(),
        timezone: timezone.trim(),
        profileUrl: profileUrl.trim() || null,
        connectionsCount: connections.trim() === '' ? null : Number(connections)
      });
      setToast('Seat saved. These values stand until the next read from the session replaces them.');
      onSaved();
    } catch (err) {
      setFailure(errorMessage(err, 'Unable to save the seat'));
    } finally { setBusy(false); }
  };

  // One sentence each, deduplicated, and NEVER from the other auth mode. The
  // server already scopes `blockers`; `browser.reasons` is the headed verdict,
  // which explains a manual seat's container and is simply not this machine's
  // problem on a credentials seat that runs headless.
  const problems = worker ? Array.from(new Set(worker.blockers)) : [];

  return <>
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>The seat</h3>
        </div>
        <PostureBadge posture={seat?.posture ?? null} reason={seat?.seat?.pausedReason ?? null} />
      </div>

      {failure && <div className="error-banner">{failure}</div>}

      {blocked && <div className="li-connect-blocked">
        <strong><CircleAlert size={14} /> One thing has to happen on your machine first.</strong>
        <p className="li-blocked-message">{blocked}</p>
      </div>}

      {current && <>
        <div className="li-seat-card">
          <div className="li-seat-head">
            <strong>{current.label.trim() || <span className="li-unknown">Name unknown</span>}</strong>
            {current.profileUrl
              ? <a className="li-seat-vanity" href={current.profileUrl} target="_blank" rel="noreferrer">
                {vanityOf(current.profileUrl)}<ExternalLink size={11} />
              </a>
              : <span className="li-unknown">Profile URL unknown</span>}
          </div>
          <dl className="li-seat-facts">
            <div>
              <dt>Connections</dt>
              <dd>{current.connectionsCount === null
                ? <span className="li-unknown">Unknown</span>
                : current.connectionsCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{current.timezone}</dd>
            </div>
            <div>
              <dt>Last read from LinkedIn</dt>
              <dd>{current.detectedAt
                ? new Date(current.detectedAt).toLocaleString()
                : <span className="li-unknown">Never — set by hand</span>}</dd>
            </div>
            <div>
              <dt>Sending through Trevra since</dt>
              <dd>{current.activatedAt
                ? new Date(current.activatedAt).toLocaleDateString()
                : <span className="li-unknown">Not started</span>}</dd>
            </div>
          </dl>
          <div className="li-seat-footer">
            <button className="ghost-button danger" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={13} /> Delete seat
            </button>
          </div>
        </div>

        {degraded.length > 0 && <div className="li-degraded">
          <strong>Read, but not all of it came back:</strong>
          <ul>{degraded.map((entry) => <li key={entry}>{entry}</li>)}</ul>
          <p>Anything missing is held as unknown, never as zero.</p>
        </div>}
      </>}

      {connected
        ? <div className="li-signin-row">
          <span className="li-signin-id"><Linkedin size={15} /> {auth?.maskedEmail ?? 'LinkedIn account'}</span>
          <span>{auth?.sessionValidAt
            ? `Session valid ${relativeTime(auth.sessionValidAt)}`
            : 'No session yet — the sign-in has not completed.'}</span>
          <div className="li-signin-actions">
            {!auth?.sessionValidAt && <button
              className="secondary-button"
              disabled={signingIn}
              onClick={() => void attempt(() => runLogin())}
            >{signingIn ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />} Sign in</button>}
            <button className="ghost-button danger" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />} Disconnect
            </button>
          </div>
        </div>
        : <>
          {/* THE REASSURANCE COMES FIRST. It used to sit under the fields at
              11px, which is after the moment it was for: by then the password
              of the exact account the Safety screen spends 240 lines
              protecting is already typed. A promise made after the ask is not
              a promise, it is a receipt. */}
          {stage === 'credentials' && <div className="li-dryrun" style={{ marginTop: 14 }}>
            <ShieldCheck size={20} />
            <div>
              <strong>Before you type it — what happens to this password.</strong>
              <p>
                It is encrypted at rest. It is sent nowhere but LinkedIn. It is used for exactly one thing: opening a
                browser session on this machine. You can remove it at any time, and nothing here can sign in again once
                you have. No screen ever renders it back — the masked address is the most Trevra will say.
              </p>
            </div>
          </div>}

          <div className="li-signin">
            <strong>Connect LinkedIn</strong>
            {stage === 'otp'
              ? <form className="li-signin-fields li-signin-otp" onSubmit={(event) => { event.preventDefault(); void attempt(() => runLogin(otp.trim())); }}>
                <label>Verification code<input
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  aria-label="Verification code"
                /></label>
                <button className="primary-button" type="submit" disabled={signingIn || otp.trim().length < 6}>
                  {signingIn ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Verify
                </button>
              </form>
              : <form className="li-signin-fields" onSubmit={(event) => { event.preventDefault(); signIn(); }}>
                <label>LinkedIn email<input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  placeholder="you@example.com"
                /></label>
                <label>LinkedIn password<input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                /></label>
                <button className="primary-button" type="submit" disabled={signingIn}>
                  {signingIn ? <LoaderCircle className="spin" size={15} /> : <LogIn size={15} />} Sign in to LinkedIn
                </button>
              </form>}
            {stage === 'otp' && <p className="li-hint">LinkedIn sent a code to your email or phone. Enter it to finish signing in.</p>}
            {note && <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>{note.message}</p>}
          </div>
        </>}

      {connected && note && <p className="li-signin-error">{note.message}</p>}

      <div className="li-seat-actions">
        <button className="secondary-button" disabled={detecting} onClick={() => void detect()}>
          {detecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {current ? ' Re-read from LinkedIn' : ' Read my profile from LinkedIn'}
        </button>
      </div>

      {/* Not the default path, and it must never look like one. Closed on first
          render, and it stays closed until somebody decides they need it. */}
      <details className="li-manual-fields">
        <summary><Settings2 size={13} /> Set these by hand</summary>
        <p className="li-hint">
          For what detection cannot cover: a profile the worker cannot reach, a seat you run in a timezone other than this
          browser’s, or a connection count LinkedIn renders as “500+”. Saving here stands until the next re-read replaces it.
        </p>
        <div className="li-form-grid">
          <label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Pankaj (founder)" /></label>
          <label>Timezone
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Zurich" list="li-timezones" />
            <datalist id="li-timezones"><option value={browserZone} /></datalist>
          </label>
          <label>Connections<input type="number" min={0} value={connections} onChange={(event) => setConnections(event.target.value)} placeholder="e.g. 640" /></label>
          <label>Profile URL<input value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} placeholder="https://www.linkedin.com/in/…" /></label>
        </div>
        <div className="panel-footer">
          <span>Leave a field empty to hold it as unknown. Unknown is paced conservatively; zero would not be.</span>
          <button className="primary-button" disabled={busy} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save seat
          </button>
        </div>
      </details>

      <div className="panel-footer">
        <span>
          The timezone comes from this browser — <code>{browserZone}</code> — and decides which 08:00–18:00 the plan spreads
          across. The warm-up ramp is measured from when this seat started sending through Trevra, not from the age of the
          LinkedIn account.
        </span>
        <ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.4" compact />
      </div>
    </section>

    {confirmingDelete && <ConfirmDrawer
      title="Delete this seat?"
      tone="danger"
      busy={deletingSeat}
      error={deleteError}
      body={<>
        <p>
          This removes the label, connection count, timezone and posture shown above — and the warm-up ramp clock with
          them. <b>The clock cannot be recovered.</b> Whatever seat this workspace gets next, however it gets one,
          starts back at week 1.
        </p>
        <p>
          Send history and any stored LinkedIn credentials are untouched — this deletes the seat record only. To
          remove a stored password, use Disconnect above instead.
        </p>
      </>}
      confirmLabel="Delete seat"
      onConfirm={() => void removeSeat()}
      onCancel={() => { setConfirmingDelete(false); setDeleteError(null); }}
    />}

    {seat && <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Last 24 hours</h3>
          <p>Rolling window, not since-midnight.</p>
        </div>
        {limits && <ConfidenceTag confidence="REPORTED" source="docs/linkedin-outreach-plan.md 1.4" compact />}
      </div>
      <div className="li-stat-row">
        {PACED_KINDS.map((kind) => {
          const ceiling = limits?.limits.find((limit) => limit.kind === kind && limit.window === 'day');
          return <LiStat
            key={kind}
            label={KIND_LABELS[kind]}
            value={String(seat.today[kind] ?? 0)}
            detail={ceiling ? <>of {ceiling.ceiling}, bound by {ceiling.boundBy.replaceAll('-', ' ')} · {ceiling.confidence}</> : undefined}
          />;
        })}
      </div>
    </section>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Local worker</h3>
          <p>Self-hosted only. A hosted Trevra cannot enable this.</p>
        </div>
        <Terminal size={20} className="li-heading-icon" />
      </div>

      {!worker
        ? <p className="empty-copy">Worker status unavailable.</p>
        : worker.ready
          // A working thing states that it works, in one line. The checklist,
          // the profile path and the source note are all evidence for a claim
          // nobody is disputing, and a panel that shouts on a healthy tab is a
          // panel operators learn to read past on the day it matters.
          ? <p className="li-worker-ready">
            <Check size={14} /> Local worker ready · {worker.browser.canLaunchHeaded ? 'headed Chrome on this machine' : 'headless Chromium'}
          </p>
          : <>
            {/* Only when something is actually wrong, and one line per problem. */}
            {problems.length > 0 && <ul className="li-blockers">
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>}

            <div className="li-checklist">
              <WorkerCheck ok={worker.enabled} label="Enabled for this deployment"
                detail={worker.enabled ? 'On for this deployment.' : 'Off for this deployment.'} />
              <WorkerCheck ok={worker.playwrightInstalled} label="Playwright installed"
                detail={worker.playwrightPath ?? 'npm i playwright && npx playwright install chromium'} />
              <WorkerCheck ok={worker.browser.canLaunchHeadless} label="Headless Chromium"
                detail={worker.browser.headlessReasons[0] ?? 'A browser can open here without a display.'} />
              <WorkerCheck ok={worker.loggedIn} label="Signed into LinkedIn"
                detail={worker.loggedIn
                  ? 'A session was confirmed live on this seat.'
                  : 'No session confirmed yet. Sign in above.'} />
            </div>

            <p className="panel-note">Source: {worker.source}</p>
          </>}
    </section>
  </>;
}

function WorkerCheck({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  const state = ok === null ? 'unknown' : ok ? 'ok' : 'no';
  return <div className={`li-check li-check-${state}`}>
    <span>{ok === null ? '?' : ok ? <Check size={13} /> : <CircleAlert size={13} />}</span>
    <div><strong>{label}</strong><small>{detail}</small></div>
  </div>;
}

/* -------------------------------------------------------------------------
 * `#/outreach/queue` -- the slots, and what became of them.
 * ---------------------------------------------------------------------- */

const OUTCOMES = ['sent', 'accepted', 'replied', 'declined'] as const;

const OUTCOME_LABELS: Record<typeof OUTCOMES[number], string> = {
  sent: 'Sent',
  accepted: 'Accepted',
  replied: 'Replied',
  declined: 'Declined'
};

/** The two statuses a slot can still be pulled out of. Everything else has happened. */
const isSkippable = (action: LinkedInActionView) => action.status === 'planned' || action.status === 'exported';

/**
 * The `linkedin_actions` ledger, filterable, with per-row skip and manual
 * outcome marking.
 *
 * Marking an outcome is a REPORT, not an instruction: the operator is telling
 * Trevra what already happened in their own tool, so the acceptance-rate
 * throttle and the day-over-day arithmetic have a real denominator. The date
 * field matters for the same reason -- an outcome reported on Friday for a send
 * that happened on Tuesday has to charge Tuesday's budget.
 */
export function OutreachQueue({ setToast }: { setToast: (message: string) => void }) {
  // Who queued each row -- team-workspace-access design goal 5, "Founder can
  // see which of the two of them queued a given LinkedIn action". The same
  // member list the workspace switcher and Team settings read, not a second
  // fetch of who is in this workspace.
  const { nameFor } = useWorkspaceMembers();
  const [actions, setActions] = useState<LinkedInActionView[]>([]);
  /** For the campaign picker. A filter you have to TYPE an id into is a filter nobody uses twice. */
  const [campaigns, setCampaigns] = useState<LinkedInCampaign[]>([]);
  const [status, setStatus] = useState<LinkedInActionStatus | ''>('');
  const [kind, setKind] = useState<LinkedInActionKind | ''>('');
  const [campaignId, setCampaignId] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setActions(await getLinkedInActions({
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(campaignId ? { campaignId } : {}),
        limit: 200
      }));
      setSelected(new Set());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to load the queue. Nothing was changed — press Apply to try again.'));
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [status, kind, campaignId]);
  useOutreachRefresh(load);

  useEffect(() => {
    // A picker that cannot be populated simply is not offered; it never blocks
    // the queue, which is the thing this screen is actually for.
    void (async () => {
      try { setCampaigns(await getLinkedInCampaigns()); }
      catch { /* the campaign filter is not worth an error banner over the queue */ }
    })();
  }, []);

  const filtered = Boolean(status || kind || campaignId);
  const skippable = actions.filter(isSkippable);
  const selectedIds = skippable.filter((action) => selected.has(action.id)).map((action) => action.id);
  const allSelected = skippable.length > 0 && selectedIds.length === skippable.length;

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const skip = async (id: string) => {
    setBusy(id);
    try {
      await skipLinkedInAction(id);
      setToast('Skipped. The slot is released and nothing is scheduled against it.');
      // The queue, and the seat's spent-today figures wherever else they are
      // on screen. This used to be `onChanged()` reaching up through the tab
      // shell; there is no shell now, so it is a broadcast instead.
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to skip that action. It is still in the queue — try it again.'));
    } finally { setBusy(null); }
  };

  /**
   * Skip everything that is ticked.
   *
   * A 200-action queue was 200 clicks, which is not a queue, it is a punishment
   * for having used the product. A partial failure names how many survived and
   * what to do, because "some of them worked" is the one outcome an operator
   * cannot act on.
   */
  const skipSelected = async () => {
    setBulkBusy(true);
    setError('');
    let done = 0;
    // lc-debt: one POST per action -- there is no batch skip route today; add
    // POST /api/linkedin/actions/skip taking ids[] before a queue routinely
    // runs to thousands.
    for (const id of selectedIds) {
      try { await skipLinkedInAction(id); done += 1; }
      catch { /* counted below; the loop finishes what it can */ }
    }
    const failed = selectedIds.length - done;
    if (failed === 0) {
      setConfirmingBulk(false);
      setToast(`${done} slot(s) skipped and released. Nothing is scheduled against any of them.`);
    } else {
      setError(`${done} of ${selectedIds.length} were skipped. The other ${failed} are still in the queue — they are `
        + 'reloaded below, so tick those and try again.');
      setConfirmingBulk(false);
    }
    setBulkBusy(false);
    await reloadOutreach();
  };

  const mark = async (action: LinkedInActionView, outcome: typeof OUTCOMES[number]) => {
    setBusy(action.id);
    try {
      await recordLinkedInOutcome({
        actionId: action.id,
        outcome,
        ...(occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : {})
      });
      setToast(`Recorded as ${outcome}${occurredAt ? ` on ${occurredAt}` : ''}.`);
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to record that outcome. Nothing was written — try that button again.'));
    } finally { setBusy(null); }
  };

  return <div className="page-stack">
    <section className="page-panel">
      {/* Status and campaign are what an operator actually scopes by. Kind was
          a sixth dropdown open on arrival next to a field asking them to TYPE
          an id they had copied off another tab. */}
      <div className="li-filter-row">
        <label>Status
          <select value={status} onChange={(event) => setStatus(event.target.value as LinkedInActionStatus | '')}>
            <option value="">Any status</option>
            {LINKEDIN_ACTION_STATUSES.map((option) => <option key={option} value={option}>{ACTION_STATUS_LABELS[option]}</option>)}
          </select>
        </label>
        <label>Campaign
          <select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
            <option value="">Any campaign</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Apply
        </button>
      </div>

      <details className="li-manual-fields">
        <summary><SlidersHorizontal size={13} /> Narrow it further</summary>
        <div className="li-form-grid">
          <label>Kind
            <select value={kind} onChange={(event) => setKind(event.target.value as LinkedInActionKind | '')}>
              <option value="">Any kind</option>
              {LINKEDIN_ACTION_KINDS.map((option) => <option key={option} value={option}>{ACTION_KIND_LABELS[option]}</option>)}
            </select>
          </label>
        </div>
      </details>
    </section>

    {error && <div className="error-banner">{error}</div>}

    <section className="page-panel">
      {/* The date belongs to MARKING, not to filtering. It sat in the filter row
          looking like a fifth way to narrow the list, which it never was. */}
      <div className="li-filter-row">
        <label>Report outcomes as happening on
          <input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} />
        </label>
        <span className="li-hint">
          Leave it empty for “now”. Marking an outcome tells Trevra what already happened in your own tool; it sends
          nothing. Every rolling window reads this date, so a Tuesday send reported on Friday has to charge Tuesday.
        </span>
      </div>

      {selectedIds.length > 0 && <div className="li-filter-row">
        <span className="li-filter-label">{selectedIds.length} selected</span>
        <button className="li-danger-button" type="button" disabled={bulkBusy} onClick={() => setConfirmingBulk(true)}>
          {bulkBusy ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />} Skip {selectedIds.length} slot(s)
        </button>
        <button className="ghost-button" type="button" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>}

      {actions.length === 0
        ? <div className="empty-state">
          <ListTree size={26} />
          <h4>{filtered ? 'Nothing in the queue matches this filter' : 'Nothing is in the queue yet'}</h4>
          <p>Slots enter the queue when an approved plan is exported.</p>
          {filtered && <button className="secondary-button" type="button" onClick={() => { setStatus(''); setKind(''); setCampaignId(''); }}>
            Clear the filters
          </button>}
        </div>
        : <div className="li-table-scroll">
          <table className="li-table">
            <thead><tr>
              <th>
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={skippable.length === 0}
                  aria-label={allSelected ? 'Clear the selection' : `Select all ${skippable.length} slot(s) that can still be skipped`}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(skippable.map((action) => action.id)))}
                />
              </th>
              <th>Target</th><th>Kind</th><th>Status</th><th>Planned for</th><th>Recorded</th><th>Source</th><th>Queued by</th><th>Mark as</th>
            </tr></thead>
            <tbody>{actions.map((action) => <tr key={action.id}>
              <td>
                {/* Only what a skip could still act on. A tick beside a sent
                    invite would be a promise the ledger cannot keep. */}
                {isSkippable(action) && <input
                  type="checkbox"
                  checked={selected.has(action.id)}
                  disabled={bulkBusy}
                  aria-label={`Select the ${ACTION_KIND_LABELS_ONE[action.kind].toLowerCase()} to ${action.targetRef ?? 'an unnamed target'}`}
                  onChange={() => toggle(action.id)}
                />}
              </td>
              <td className="li-target">{action.targetRef ?? '—'}</td>
              <td>{ACTION_KIND_LABELS_ONE[action.kind]}</td>
              <td>
                <span className={`li-chip li-status-${action.status}`}>{actionStatusLabel(action.status)}</span>
                {action.failureKind && <small className="li-failure">{action.failureKind}</small>}
              </td>
              <td>{action.plannedFor ? new Date(action.plannedFor).toLocaleString() : '—'}</td>
              <td>{action.recordedAt ? new Date(action.recordedAt).toLocaleString() : '—'}</td>
              <td>{action.source}</td>
              <td>{nameFor(action.queuedByUserId) ?? '—'}</td>
              <td className="li-row-actions">
                {OUTCOMES.map((outcome) => <button
                  key={outcome}
                  className="li-mini-button"
                  type="button"
                  disabled={busy === action.id || bulkBusy}
                  onClick={() => void mark(action, outcome)}
                >{OUTCOME_LABELS[outcome]}</button>)}
                {isSkippable(action) && <button
                  className="li-mini-button li-mini-danger"
                  type="button"
                  disabled={busy === action.id || bulkBusy}
                  onClick={() => void skip(action.id)}
                >Skip</button>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
    </section>

    {confirmingBulk && <ConfirmDrawer
      title={`Skip ${selectedIds.length} slot(s)?`}
      tone="danger"
      busy={bulkBusy}
      body={<>
        <p>Each one is released: the slot goes back and nothing is scheduled against it.</p>
        <p>
          Skipping is written to the ledger and there is no un-skip — a skipped slot has to be planned again from its
          campaign.
        </p>
        <p>Nobody is contacted either way. This changes what Trevra has queued, not what LinkedIn has seen.</p>
      </>}
      confirmLabel={`Skip ${selectedIds.length} slot(s)`}
      onConfirm={() => void skipSelected()}
      onCancel={() => setConfirmingBulk(false)}
    />}
  </div>;
}

/* -------------------------------------------------------------------------
 * `#/setup/limits` -- the never-contact list.
 * ---------------------------------------------------------------------- */

/**
 * Set once, and its own copy says so: there is no removal button, because
 * removing an entry is a database operation. That is not a screen an operator
 * returns to, which is why it sits under Setup beside the automation rules
 * rather than in the pipeline it constrains.
 */
export function LinkedInExclusions({ setToast }: { setToast: (message: string) => void }) {
  const [exclusions, setExclusions] = useState<LinkedInExclusion[]>([]);
  const [targets, setTargets] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try { setExclusions(await getLinkedInExclusions()); setError(''); }
    catch (err) { setError(errorMessage(err, 'Unable to load the exclusion list')); }
  };

  useEffect(() => { void load(); }, []);
  useOutreachRefresh(load);

  const add = async () => {
    const list = targets.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
    if (list.length === 0) { setError('Add at least one handle or profile URL.'); return; }
    setBusy(true);
    try {
      const result = await addLinkedInExclusions(list.map((targetRef) => ({ targetRef, reason: reason.trim() })));
      setToast(`${result.added} added, ${result.updated} already on the list and updated.`);
      setTargets('');
      setReason('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Unable to add those exclusions'));
    } finally { setBusy(false); }
  };

  return <div className="page-stack">
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3>Never contact</h3>
          <p>Applied before a plan is produced and before a campaign starts, never at send time.</p>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="li-form-grid">
        <label className="li-span-2">Handles or profile URLs, one per line
          <textarea rows={4} value={targets} onChange={(event) => setTargets(event.target.value)} />
        </label>
        <label className="li-span-2">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Asked to be left alone" /></label>
      </div>
      <div className="panel-footer">
        <span>
          Matching is textual and case-folded; Trevra never resolves a handle against LinkedIn. There is no removal button:
          removing an entry is a database operation.
        </span>
        <button className="primary-button" disabled={busy} onClick={() => void add()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Ban size={15} />} Add to the list
        </button>
      </div>
    </section>

    <section className="page-panel">
      {exclusions.length === 0
        ? <p className="empty-copy">Nobody is excluded yet.</p>
        : <div className="li-table-scroll">
          <table className="li-table">
            <thead><tr><th>Target</th><th>Reason</th><th>Source</th><th>Added</th></tr></thead>
            <tbody>{exclusions.map((entry) => <tr key={entry.id}>
              <td className="li-target">{entry.targetRef}</td>
              <td>{entry.reason || '—'}</td>
              <td>{entry.source}</td>
              <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
            </tr>)}</tbody>
          </table>
        </div>}
    </section>
  </div>;
}
