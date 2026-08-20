import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Clock3,
  CircleStop,
  KeyRound,
  Laptop,
  Linkedin,
  LoaderCircle,
  LogIn,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
  Unplug,
  Users
} from 'lucide-react';
import {
  ApiError,
  deleteLinkedInCredentials,
  deleteLinkedInSeat,
  detectLinkedInSeat,
  getLinkedInLimits,
  getLinkedInManagerSeats,
  getLinkedInSeat,
  getLinkedInWithdrawalCandidates,
  getLinkedInWithdrawals,
  getLinkedInWorkerStatus,
  loginLinkedInSeat,
  pauseLinkedInSeat,
  queueLinkedInWithdrawals,
  resumeLinkedInSeat,
  saveLinkedInCredentials,
  syncLinkedInPendingInvites,
  type LinkedInDetectedProfile,
  type LinkedInLimitsReport,
  type LinkedInSeat,
  type LinkedInSeatResponse,
  type LinkedInWithdrawalCandidates,
  type LinkedInWorkerStatus,
  type WithdrawalRecord,
  type WithdrawalStatus
} from './api';
import { OWNER_ACCOUNT_KEY, useActiveSeatKey } from './LinkedInActiveAccount';
import {
  AddAccountForm,
  BROWSER_TIMEZONE,
  EditAccountForm,
  LIMIT_FIELDS,
  TimezoneOptions,
  describeDays,
  isWall,
  minutesToClock,
  usedToday
} from './LinkedInAccountForm';
import { CompanionPanel, Wall, WorkerNotice } from './LinkedInCompanion';
import { errorMessage, reloadOutreach, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime, sourceNote } from './LinkedInScreen';
import { MAINTENANCE_TASK_LABELS, formatVisitWindow, queueWaitCopy } from './LinkedInTiming';
import { ConfidenceTag, LiStat } from './LinkedInViz';
import { ConfirmDrawer } from './ui/dialog';
import { Hint } from './ui/hint';

/**
 * Every LinkedIn account this workspace sends from -- adding one, connecting
 * one, switching between them, and changing what one is allowed to do.
 *
 * THE WORD IS "ACCOUNT", EVERYWHERE ON THIS SCREEN. The server calls the unit
 * a seat and will keep calling it that (`seatKey` is on every route this file
 * touches), but nobody arriving from Dripify has ever heard the word, and the
 * thing it names is simply their LinkedIn account. The translation stops at
 * this file's boundary: the wire keeps its vocabulary, the screen keeps theirs.
 *
 * The same translation applies to every other internal noun this screen would
 * otherwise leak. "Posture" is a connection status. The "warm-up multiplier"
 * is how much of today's limit this account may use while it is easing in.
 * The "ledger" is the send history. None of those words appear below.
 *
 * NOTHING HERE SENDS ANYTHING. It stores a sign-in, opens a session with it,
 * reads a profile back, and writes limits -- the same four things the single-
 * account setup screen always did, once per account instead of once.
 */

/** `in/priya-sharma`, not the whole URL. The link still goes to the whole URL. */
const profileLabel = (url: string) =>
  url.replace(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i, '').replace(/\/+$/, '') || url;

/**
 * What an operator needs to know about an account before they pick it.
 *
 * Five answers, in the order they stop you: paused and cooling down are states
 * Trevra put the account into, not connection problems, so they outrank the
 * sign-in questions -- an account that is paused does not become useful by
 * signing in again.
 */
type AccountState =
  'connected' | 'easing-in' | 'needs-signin' | 'not-connected' | 'paused' | 'cooling-down';

const STATE_LABELS: Record<AccountState, string> = {
  connected: 'Connected',
  'easing-in': 'Easing in',
  'needs-signin': 'Needs sign-in',
  'not-connected': 'Not connected',
  paused: 'Paused',
  'cooling-down': 'Cooling down'
};

/** ok = working, warn = your move, stop = stopped, off = never started. */
const STATE_TONES: Record<AccountState, 'ok' | 'warn' | 'stop' | 'off'> = {
  connected: 'ok',
  'easing-in': 'ok',
  'needs-signin': 'warn',
  'not-connected': 'off',
  paused: 'stop',
  'cooling-down': 'warn'
};

function accountState(account: LinkedInSeat, detail: LinkedInSeatResponse | null): AccountState {
  const posture = detail?.posture ?? account.posture;
  if (posture === 'paused') return 'paused';
  if (posture === 'cooldown') return 'cooling-down';
  // A companion browser may be signed in without Trevra ever holding a
  // LinkedIn password. A confirmed session is therefore the strongest fact and
  // outranks credential custody; stored credentials without a confirmed
  // session still mean the account needs sign-in.
  if (detail?.auth.sessionValidAt) return posture === 'warmup' ? 'easing-in' : 'connected';
  if (!detail?.auth.hasCredentials) return 'not-connected';
  if (!detail.auth.sessionValidAt) return 'needs-signin';
  return posture === 'warmup' ? 'easing-in' : 'connected';
}

/** One sentence under the badge: what that state means for this account today. */
function stateSentence(
  state: AccountState,
  account: LinkedInSeat,
  detail: LinkedInSeatResponse | null
): string {
  switch (state) {
    case 'paused':
      return account.pausedReason
        ? `Stopped by you: ${account.pausedReason}. Nothing is scheduled or sent until you resume it.`
        : 'Stopped by you. Nothing is scheduled or sent until you resume it.';
    case 'cooling-down':
      return 'Trevra has cut this account back after a run of declined invites. It picks up again on its own.';
    case 'not-connected':
      return 'No sign-in stored, so Trevra cannot open LinkedIn as this account. Add it below.';
    case 'needs-signin':
      return 'The sign-in is stored but no LinkedIn session has been confirmed yet.';
    case 'easing-in':
      return detail
        ? `Week ${detail.warmupWeek} of ${detail.warmupWeeks} — easing in on purpose. Uses only part of the limits below until the ramp finishes.`
        : 'Easing in: this account may use only part of the limits you set below until the ramp finishes.';
    default:
      return 'Signed in and working to the limits below.';
  }
}

/* -------------------------------------------------------------------------
 * The screen.
 * ---------------------------------------------------------------------- */

export function LinkedInAccounts({ setToast }: { setToast: (message: string) => void }) {
  const [activeKey, setActiveKey] = useActiveSeatKey();
  const [accounts, setAccounts] = useState<LinkedInSeat[] | null>(null);
  const [details, setDetails] = useState<Record<string, LinkedInSeatResponse>>({});
  const [reports, setReports] = useState<Record<string, LinkedInLimitsReport>>({});
  const [worker, setWorker] = useState<LinkedInWorkerStatus | null>(null);
  const [safety, setSafety] = useState<LinkedInLimitsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [adding, setAdding] = useState(false);
  /** Only the newest refresh may replace the account list. An older request can
   * have started before a just-added account existed and must never "repair"
   * the active selection back to account #1 when it arrives late. */
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [list, workerStatus] = await Promise.all([
        getLinkedInManagerSeats(),
        // The worker read is evidence, not the subject. A failed one must not
        // take the account list down with it.
        getLinkedInWorkerStatus().catch(() => null)
      ]);
      if (sequence !== loadSequence.current) return;
      setAccounts(list);
      setWorker(workerStatus);
      // lc-debt: one GET /api/linkedin/seat per account -- fine at the handful
      // of accounts a person manages, wrong at fifty; upgrade path is a manager
      // route returning sign-in state and today's counts for every account at
      // once.
      const reads = await Promise.all(
        list.map(async (account) => {
          try {
            return [account.seatKey, await getLinkedInSeat(account.seatKey)] as const;
          } catch {
            return [account.seatKey, null] as const;
          }
        })
      );
      if (sequence !== loadSequence.current) return;
      setDetails(
        Object.fromEntries(
          reads.filter(
            (entry): entry is readonly [string, LinkedInSeatResponse] => entry[1] !== null
          )
        )
      );
      // Per account, and a failed one simply leaves that row saying it does not
      // know rather than falling back to the number the form holds.
      const ceilings = await Promise.all(
        list.map(async (account) => {
          try {
            return [account.seatKey, await getLinkedInLimits(account.seatKey)] as const;
          } catch {
            return [account.seatKey, null] as const;
          }
        })
      );
      if (sequence !== loadSequence.current) return;
      setReports(
        Object.fromEntries(
          ceilings.filter(
            (entry): entry is readonly [string, LinkedInLimitsReport] => entry[1] !== null
          )
        )
      );
      setFailure('');
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setFailure(
        errorMessage(
          error,
          'Unable to read your LinkedIn accounts. Nothing was changed — try again.'
        )
      );
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useOutreachRefresh(load);
  // The Settings tabs are the source of truth for selection. A refresh may
  // temporarily return a partial/stale account list, but it must never turn
  // that into a write that overrides the account the user clicked.
  const active = accounts?.find((account) => account.seatKey === activeKey) ?? null;
  /**
   * The ranges every limit control is built from, the bands those limits are
   * measured against, and the campaign ramp -- one read, and the only copy of
   * any of those numbers this screen has.
   *
   * PER ACCOUNT, because the band is not a constant: it depends on the
   * account's own posture and warm-up week, and a second account easing in is
   * not measured against the same numbers as one that has been running a year.
   * A failed read leaves the forms saying they do not know, which is what they
   * do not: no control here falls back to a number nobody checked.
   */
  const activeSeatKey = active?.seatKey;
  useEffect(() => {
    let cancelled = false;
    void getLinkedInLimits(activeSeatKey).then(
      (report) => {
        if (!cancelled) setSafety(report);
      },
      () => {
        if (!cancelled) setSafety(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [activeSeatKey]);

  const empty = accounts !== null && accounts.length === 0;

  return (
    <div className="page-stack">
      <TimezoneOptions />

      {failure && (
        <div className="error-banner">
          <strong>{failure}</strong>{' '}
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Try
            again
          </button>
        </div>
      )}

      <WorkerNotice worker={worker} />
      {worker?.companionBrowser && <CompanionPanel setToast={setToast} />}

      {accounts === null ? (
        <section className="page-panel">
          <p className="empty-copy">{loading ? 'Reading your LinkedIn accounts…' : 'No data.'}</p>
        </section>
      ) : empty ? (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>No LinkedIn account connected yet</h3>
              <p>
                Trevra paces, queues and reads replies per account. Add the first one and everything
                else on Outreach has something to run against.
              </p>
            </div>
            <Users size={20} className="li-heading-icon" />
          </div>
          <AddAccountForm
            existingKeys={[]}
            safety={safety}
            firstOne
            onCancel={null}
            onCreated={(created) => {
              // `load()` must land BEFORE the switch: `accounts` here is still the
              // pre-creation list, and setting `activeKey` to a key that list does
              // not contain yet trips the correction effect below straight back to
              // `accounts[0]` -- the account this form just added becomes
              // unreachable by clicking it, because the click set the very key this
              // race keeps erasing.
              setToast(`${created.label} added. Connect it below to start sending from it.`);
              void load().then(() => setActiveKey(created.seatKey));
            }}
          />
        </section>
      ) : (
        <>
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>
                  Your LinkedIn accounts
                  <Hint label="What switching an account changes">
                    Pick the account to work in — it follows you to the Inbox, Approve &amp; export,
                    the send queue, the plan preview, and this screen. Lead sources, your Never
                    contact list and workspace settings are shared across accounts, not per-account.
                  </Hint>
                </h3>
                {/* WHAT THE SWITCH ACTUALLY REACHES, and no more than that.
                  `useActiveSeatKey` is one value for the whole tab and it is
                  mirrored into the others, so every screen that reads it changes
                  the moment this does -- but a screen that is not about one
                  account has nothing to change, and claiming otherwise is how a
                  switch gets blamed for a list that was never per-account.

                  THIS LIST IS CHECKED AGAINST THE ROUTES, not against what the
                  switcher was meant to do. It named Campaigns and the send
                  queue while both read every account's rows: the queue sent no
                  seat at all, the campaign list had no filter to send one to,
                  and the funnel took a seat key only to relabel its days with.
                  Each of those now filters server-side, and each of those
                  screens carries the same switch above its rows -- so the four
                  names below are four routes that answer for one account. */}
              </div>
              <button
                className="secondary-button li-acct-nowrap"
                type="button"
                onClick={() => setAdding((open) => !open)}
              >
                <Plus size={14} /> {adding ? 'Cancel' : 'Add account'}
              </button>
            </div>

            <div className="li-acct-switch" role="group" aria-label="Switch LinkedIn account">
              {accounts.map((account) => {
                const detail = details[account.seatKey] ?? null;
                const state = accountState(account, detail);
                const isActive = active?.seatKey === account.seatKey;
                return (
                  <button
                    key={account.seatKey}
                    type="button"
                    className={`li-acct-tab${isActive ? ' is-active' : ''}`}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => setActiveKey(account.seatKey)}
                  >
                    <span className="li-acct-tab-head">
                      <i
                        className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`}
                        aria-hidden="true"
                      />
                      <strong>{account.label}</strong>
                    </span>
                    <small>
                      {detail?.auth.maskedEmail ??
                        (detail?.auth.sessionValidAt
                          ? 'Local browser session'
                          : 'No confirmed session')}
                    </small>
                    <small className="li-acct-tab-state">
                      {isActive ? 'Active account' : STATE_LABELS[state]}
                    </small>
                  </button>
                );
              })}
            </div>

            {adding && (
              <AddAccountForm
                existingKeys={accounts.map((account) => account.seatKey)}
                safety={safety}
                onCancel={() => setAdding(false)}
                onCreated={(created) => {
                  setAdding(false);
                  setToast(`${created.label} added. Connect it below to start sending from it.`);
                  // Same ordering as the first-account form above, and for the same
                  // reason: switch only once `accounts` actually contains this key.
                  void load().then(() => setActiveKey(created.seatKey));
                }}
              />
            )}
          </section>

          {active && (
            <AccountPanel
              key={active.seatKey}
              account={active}
              detail={details[active.seatKey] ?? null}
              safety={safety}
              companion={Boolean(worker?.companionBrowser)}
              setToast={setToast}
              onChanged={load}
              onRemoved={() => {
                setActiveKey(OWNER_ACCOUNT_KEY);
                void load();
              }}
            />
          )}

          {accounts.length > 1 && (
            <AccountsTable
              accounts={accounts}
              details={details}
              reports={reports}
              activeKey={active?.seatKey ?? ''}
              onSelect={setActiveKey}
            />
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The active account: connect it, read it, change it, stop it, remove it.
 * ---------------------------------------------------------------------- */

function AccountPanel({
  account,
  detail,
  safety,
  companion,
  setToast,
  onChanged,
  onRemoved
}: {
  account: LinkedInSeat;
  detail: LinkedInSeatResponse | null;
  /** Ranges, bands and the campaign ramp. Null while loading, or if that read failed. */
  safety: LinkedInLimitsReport | null;
  /** Hosted execution through the paired member computer, with local browser-session custody. */
  companion: boolean;
  setToast: (message: string) => void;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const auth = detail?.auth ?? null;
  const state = accountState(account, detail);
  // Account identity/profile facts are primary settings information, not
  // overflow. Keep the panel open by default so a healthy account still shows
  // the rich LinkedIn details that were previously visible on this route.
  const [detailsOpen, setDetailsOpen] = useState(true);
  // Sign-in. `password` is the one value here that must not outlive its own
  // submit: nothing else reads it and it is cleared the moment the request
  // carrying it has been made. No screen can render it back -- the API has no
  // route that returns it, by design.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'credentials' | 'otp'>('credentials');
  const [signingIn, setSigningIn] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** The server's own sentence. 'instruction' is a step to take; 'error' is a fault. */
  const [note, setNote] = useState<{ tone: 'error' | 'instruction'; message: string } | null>(null);

  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState('');
  const [degraded, setDegraded] = useState<string[]>([]);
  /**
   * What the last read of the live session returned, in this browser.
   *
   * The seat keeps the durable half of it -- `profileUrl`, `connectionsCount`,
   * `detectedAt`, and the label when it had none -- and the facts list below
   * renders those, so a read now leaves something behind. The display NAME is
   * the one thing a read produces that no column stores (it fills an empty
   * label and is otherwise dropped), so it is held here for as long as this
   * panel is open rather than shown once in a toast and then lost.
   */
  const [lastRead, setLastRead] = useState<LinkedInDetectedProfile | null>(null);

  /** Companion mode's manual sign-in is the default; this opts into the stored-password form instead. */
  const [wantsCredentialsForm, setWantsCredentialsForm] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const connected = Boolean(auth?.sessionValidAt) && stage === 'credentials';
  const storedSignIn = Boolean(auth?.hasCredentials) && stage === 'credentials';

  /**
   * A read queued for somebody else's machine.
   *
   * `detect` answers 202 when THIS process cannot open a browser: the request
   * is parked for the operator's own worker. There is nothing to do but wait,
   * so the screen waits -- re-reading every six seconds until the request
   * stops being pending, and giving up after two minutes rather than polling
   * a dead worker forever.
   */
  const request = detail?.detectRequest ?? null;
  const queued = request?.status === 'pending';
  useEffect(() => {
    if (!queued) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 20) {
        window.clearInterval(timer);
        return;
      }
      void onChanged();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [queued, onChanged]);

  /**
   * Read this account's profile out of the session Trevra just opened.
   *
   * The timezone is the only thing this browser knows that the worker driving
   * the session cannot read for itself, so it is the only thing sent.
   */
  const check = async () => {
    setChecking(true);
    setBlocked('');
    setActionError('');
    try {
      const result = await detectLinkedInSeat(
        account.timezone || BROWSER_TIMEZONE,
        account.seatKey
      );
      if (result.status === 'pending') {
        // 202. Not an error, and not this machine's job: the server's sentence
        // names what has to run and where.
        setBlocked(result.message ?? 'Queued for the machine that runs your local worker.');
        await onChanged();
        return;
      }
      setDegraded(result.degraded);
      setLastRead(result.detected);
      setToast(
        result.detected
          ? `Read ${result.detected.name ?? 'the profile'} from ${account.label}’s LinkedIn session.`
          : 'Reached LinkedIn but read nothing usable. Set what is missing by hand below.'
      );
      await onChanged();
    } catch (error) {
      const message = errorMessage(error, 'Unable to read this account’s profile from LinkedIn');
      if (isWall(error)) setBlocked(message);
      else setActionError(message);
    } finally {
      setChecking(false);
    }
  };

  /**
   * One round of the sign-in route, and the four answers it can give.
   *
   * `otp_required` is a STEP, not a failure -- LinkedIn took the password and
   * is waiting on the code it just sent, so the card swaps to one field rather
   * than turning red. `challenge` is a thing for a person to go and finish in a
   * browser, and the server's sentence says which. Only `failed` is an error.
   */
  const runLogin = async (code?: string) => {
    const result = await loginLinkedInSeat(code, account.seatKey);
    if (result.status === 'otp_required') {
      setStage('otp');
      setNote(null);
      return;
    }
    if (result.status === 'ok') {
      setStage('credentials');
      setOtp('');
      setNote(null);
      setToast(`Signed into LinkedIn as ${account.label}.`);
      await check();
      return;
    }
    setNote({
      tone: result.status === 'challenge' ? 'instruction' : 'error',
      message: result.message
    });
  };

  const attempt = async (run: () => Promise<void>) => {
    setSigningIn(true);
    try {
      await run();
    } catch (error) {
      setNote({ tone: 'error', message: errorMessage(error, 'Unable to sign in to LinkedIn') });
    } finally {
      setSigningIn(false);
    }
  };

  const signIn = () =>
    void attempt(async () => {
      const address = email.trim();
      if (!address || !password) {
        setNote({
          tone: 'error',
          message: 'Both the email and the password are needed to sign in.'
        });
        return;
      }
      setNote(null);
      try {
        await saveLinkedInCredentials({ email: address, password, seatKey: account.seatKey });
      } finally {
        // Out of component state the moment it is on the wire, whatever became of it.
        setPassword('');
      }
      await runLogin();
      await onChanged();
    });

  const forgetSignIn = async () => {
    setForgetting(true);
    setNote(null);
    try {
      await deleteLinkedInCredentials(account.seatKey);
      setStage('credentials');
      setEmail('');
      setOtp('');
      setToast(
        `Sign-in forgotten. Nothing can open LinkedIn as ${account.label} until you add it again.`
      );
      await onChanged();
    } catch (error) {
      setNote({
        tone: 'error',
        message: errorMessage(error, 'Unable to remove the stored sign-in')
      });
    } finally {
      setForgetting(false);
    }
  };

  const pause = async (reason: string) => {
    setPausing(true);
    setActionError('');
    try {
      await pauseLinkedInSeat(reason, account.seatKey);
      setConfirmPause(false);
      setToast(`${account.label} paused. Nothing is scheduled or sent from it until you resume.`);
      await onChanged();
    } catch (error) {
      setActionError(
        errorMessage(error, 'Unable to pause this account. It is still running — try again.')
      );
    } finally {
      setPausing(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    setActionError('');
    try {
      await resumeLinkedInSeat(account.seatKey);
      setToast(`${account.label} resumed. It eases back in rather than restarting from zero.`);
      await onChanged();
    } catch (error) {
      setActionError(
        errorMessage(
          error,
          'Unable to resume this account. It is still paused, which is the safe end of that failure.'
        )
      );
    } finally {
      setResuming(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await deleteLinkedInSeat(account.seatKey);
      setConfirmRemove(false);
      setToast(`${account.label} removed. Its stored inbox is gone; what it already sent is not.`);
      onRemoved();
    } catch (error) {
      setRemoveError(errorMessage(error, 'Unable to remove this account'));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <section className="page-panel li-acct-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>{account.label}</h3>
            <p>{stateSentence(state, account, detail)}</p>
          </div>
          <span className={`li-acct-state li-acct-state-${STATE_TONES[state]}`}>
            <i className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`} aria-hidden="true" />
            {STATE_LABELS[state]}
          </span>
        </div>

        {/* Keep the rich account/profile details visible by default. The panel
          is still a disclosure so an operator can collapse it explicitly, but
          healthy accounts no longer hide their LinkedIn identity and history
          just because they need no attention. */}
        <details
          className="li-manual-fields"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary>Details</summary>
          {detail?.backgroundRun && (
            <div className="li-next-background-run">
              <Clock3 size={17} aria-hidden="true" />
              <div>
                <span>Next LinkedIn background run</span>
                <strong>
                  {queueWaitCopy(detail.backgroundRun.waitingFor) ??
                    formatVisitWindow(
                      detail.backgroundRun.startAt,
                      detail.backgroundRun.endAt,
                      detail.backgroundRun.timezone
                    ) ??
                    'No scheduled window'}
                </strong>
                {detail.backgroundRun.waitingFor && (
                  <small>
                    Scheduled window:{' '}
                    {formatVisitWindow(
                      detail.backgroundRun.startAt,
                      detail.backgroundRun.endAt,
                      detail.backgroundRun.timezone
                    )}
                  </small>
                )}
              </div>
            </div>
          )}

          {detail?.maintenance && detail.maintenance.length > 0 && (
            <details className="li-maintenance-schedule">
              <summary>Next LinkedIn background activity</summary>
              <div className="li-maintenance-list">
                {detail.maintenance.map((timing) => {
                  const visit = formatVisitWindow(
                    timing.nextRunAt,
                    timing.nextRunWindowEndAt,
                    timing.timezone
                  );
                  const wait = queueWaitCopy(timing.waitingFor);
                  return (
                    <div className="li-maintenance-row" key={timing.task}>
                      <span>{MAINTENANCE_TASK_LABELS[timing.task]}</span>
                      <strong>{wait ?? visit ?? 'No eligible visit in the next two weeks'}</strong>
                      {wait && visit && <small>Next normal visit {visit}</small>}
                    </div>
                  );
                })}
              </div>
              <p className="li-hint">
                If this computer sleeps through a visit, Trevra skips that window and shows the next
                normal one. Missed visits are never replayed as a catch-up burst.
              </p>
            </details>
          )}

          <div className="li-seat-card">
            <div className="li-seat-head">
              <strong>{account.label}</strong>
              <span className="li-acct-key">{account.seatKey}</span>
            </div>
            {/* WHAT A READ LEAVES BEHIND.

            "Check this account on LinkedIn" writes four things onto the seat --
            which profile the session is signed in as, how many connections it
            has, when it was read, and a label when there was none -- and none
            of them were rendered anywhere. The read survived as a toast and
            then as nothing, so the only way to find out what it had said was to
            run it again. These are the seat's own columns, not this component's
            memory of a response: they are still here after a reload. */}
            <dl className="li-seat-facts">
              <div>
                <dt>Signs in as</dt>
                <dd>
                  {auth?.maskedEmail ??
                    (auth?.sessionValidAt ? (
                      'Local browser session'
                    ) : (
                      <span className="li-unknown">Not connected</span>
                    ))}
                </dd>
              </div>
              <div>
                <dt>LinkedIn profile</dt>
                <dd>
                  {account.profileUrl ? (
                    <a href={account.profileUrl} target="_blank" rel="noreferrer noopener">
                      {lastRead?.name ?? profileLabel(account.profileUrl)}
                    </a>
                  ) : (
                    <span className="li-unknown">Not read yet</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{account.timezone}</dd>
              </div>
              <div>
                <dt>Works</dt>
                <dd>
                  {describeDays(account.workingDays)}, {minutesToClock(account.workStartMinute)}–
                  {minutesToClock(account.workEndMinute)}
                </dd>
              </div>
              <div>
                <dt>Session confirmed</dt>
                <dd>
                  {auth?.sessionValidAt ? (
                    relativeTime(auth.sessionValidAt)
                  ) : (
                    <span className="li-unknown">Not yet</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Connections</dt>
                {/* Unknown, never zero: an unreadable count is reported in `degraded` and left as it was. */}
                <dd>
                  {account.connectionsCount === null ? (
                    <span className="li-unknown">Unknown</span>
                  ) : (
                    account.connectionsCount.toLocaleString()
                  )}
                </dd>
              </div>
              <div>
                <dt>Profile last read</dt>
                <dd>
                  {account.detectedAt ? (
                    relativeTime(account.detectedAt)
                  ) : (
                    <span className="li-unknown">Never</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Account opened</dt>
                {/* Informational, and nothing paces off it -- the ramp clock is
                `activatedAt`, which is when THIS seat started sending through
                Trevra. LinkedIn does not publish the opening date, so this is
                filled only when somebody says so. */}
                <dd>
                  {account.accountOpenedOn ?? <span className="li-unknown">Not recorded</span>}
                </dd>
              </div>
            </dl>
          </div>

          {degraded.length > 0 && (
            <div className="li-degraded">
              <strong>Read, but not all of it came back:</strong>
              <ul>
                {degraded.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <p>Anything missing is held as unknown, never as zero.</p>
            </div>
          )}

          {connected ? (
            <div className="li-signin-row">
              <span className="li-signin-id">
                <Linkedin size={15} /> {auth?.maskedEmail ?? 'LinkedIn account'}
              </span>
              <span>
                {auth?.sessionValidAt
                  ? `${companion ? 'Browser session' : 'Session'} confirmed ${relativeTime(auth.sessionValidAt)}`
                  : 'No session yet — the sign-in has not completed.'}
              </span>
              <div className="li-signin-actions">
                {auth?.hasCredentials && (
                  <button
                    className="ghost-button danger"
                    type="button"
                    disabled={forgetting}
                    onClick={() => void forgetSignIn()}
                  >
                    {forgetting ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Unplug size={14} />
                    )}{' '}
                    Forget stored password
                  </button>
                )}
              </div>
            </div>
          ) : companion && !auth?.hasCredentials && !wantsCredentialsForm ? (
            <div className="li-dryrun li-acct-promise">
              <Laptop size={20} />
              <div>
                <strong>No LinkedIn password is needed in Trevra.</strong>
                <p>
                  Keep <code>npx trevra linkedin</code> running, sign into LinkedIn in the Chrome
                  window it opens, then use <b>Check this account on LinkedIn</b> below. The
                  profile, cookies and IP stay on that computer.
                </p>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setWantsCredentialsForm(true)}
                >
                  Or save a password here to sign in automatically
                </button>
              </div>
            </div>
          ) : storedSignIn ? (
            <div className="li-signin-row">
              <span className="li-signin-id">
                <Linkedin size={15} /> {auth?.maskedEmail ?? 'LinkedIn account'}
              </span>
              <span>The password is stored, but no live session has been confirmed yet.</span>
              <div className="li-signin-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={signingIn}
                  onClick={() => void attempt(() => runLogin())}
                >
                  {signingIn ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />}{' '}
                  Sign in
                </button>
                <button
                  className="ghost-button danger"
                  type="button"
                  disabled={forgetting}
                  onClick={() => void forgetSignIn()}
                >
                  {forgetting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />}{' '}
                  Forget this sign-in
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* The reassurance comes BEFORE the field, not under it: a promise
              made after the password is typed is a receipt, not a promise. */}
              {stage === 'credentials' && (
                <div className="li-dryrun li-acct-promise">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>Before you type it — what happens to this password.</strong>
                    <p>
                      Encrypted at rest, sent nowhere but LinkedIn, used only to open this account’s
                      browser session. Remove it any time — no screen ever shows it back; the masked
                      address is the most Trevra will say.
                      {companion &&
                        ' On a paired computer, it is also used to sign that computer’s browser in automatically whenever its session needs to be renewed, instead of asking you to do it by hand there.'}
                    </p>
                  </div>
                </div>
              )}

              {companion && !auth?.hasCredentials && stage === 'credentials' && (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setWantsCredentialsForm(false)}
                >
                  ← Back to signing in manually on the paired computer
                </button>
              )}

              <div className="li-signin">
                <strong>Connect {account.label}</strong>
                {stage === 'otp' ? (
                  <form
                    className="li-signin-fields li-signin-otp"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void attempt(() => runLogin(otp.trim()));
                    }}
                  >
                    {/* NO LENGTH RULE, IN EITHER DIRECTION. LinkedIn's own
                    verification codes are six digits today, but the same field
                    takes whatever a challenge asks for -- and `maxLength={6}`
                    with a `< 6` guard on the button meant a code of any other
                    length could be neither typed in full nor submitted, which
                    is a dead end with no way out of it. Whether a code is right
                    is LinkedIn's answer to give; this refuses only an empty
                    one, because an empty one is not an attempt. */}
                    <label>
                      Verification code
                      <input
                        value={otp}
                        onChange={(event) => setOtp(event.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        aria-label="Verification code"
                      />
                    </label>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={signingIn || otp.trim().length === 0}
                    >
                      {signingIn ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Check size={15} />
                      )}{' '}
                      Verify
                    </button>
                  </form>
                ) : (
                  <form
                    className="li-signin-fields"
                    onSubmit={(event) => {
                      event.preventDefault();
                      signIn();
                    }}
                  >
                    <label>
                      LinkedIn email
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="username"
                        placeholder="you@example.com"
                      />
                    </label>
                    <label>
                      LinkedIn password
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                      />
                    </label>
                    <button className="primary-button" type="submit" disabled={signingIn}>
                      {signingIn ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <LogIn size={15} />
                      )}{' '}
                      Sign in to LinkedIn
                    </button>
                  </form>
                )}
                {stage === 'otp' && (
                  <p className="li-hint">
                    LinkedIn sent a code to this account’s email or phone. Enter it to finish
                    signing in.
                  </p>
                )}
                {note && (
                  <>
                    <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>
                      {note.message}
                    </p>
                    {note.tone === 'instruction' && (
                      <p className="li-hint">
                        LinkedIn wants a person, not a script. Finish that step in a browser signed
                        in as this account, then sign in here again.
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {connected && note && <p className="li-signin-error">{note.message}</p>}
        </details>

        {/* Feedback for Check / Pause / Resume lives here, not inside the
          disclosure above: those three buttons stay visible on a collapsed,
          healthy panel, so a failure or in-progress status they raise must
          stay visible too, not get buried behind a closed "Details". */}
        {actionError && <div className="error-banner">{actionError}</div>}

        {blocked && (
          <Wall title="One thing has to happen on your own machine first." message={blocked} />
        )}

        {queued && (
          <Wall
            title={
              queueWaitCopy(request?.waitingFor) ??
              (companion ? 'Waiting for your connected computer.' : 'Waiting on your own worker.')
            }
          >
            <p>
              {request?.nextAttemptAt
                ? `Expected by ${new Date(request.nextAttemptAt).toLocaleString()}. `
                : request?.waitingFor
                  ? 'There is no honest clock time until that prerequisite is back. '
                  : ''}
              Queued {request?.requestedAt ? relativeTime(request.requestedAt) : 'now'}. Missed
              worker checks are not replayed; once the prerequisite is ready, the next normal worker
              cycle picks it up.
            </p>
          </Wall>
        )}

        {request?.status === 'failed' && request.failureReason && (
          <Wall
            title="The last read of this account did not finish."
            message={request.failureReason}
          />
        )}

        <div className="li-seat-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={checking}
            onClick={() => void check()}
          >
            {checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Check
            this account on LinkedIn
          </button>
          {state === 'paused' ? (
            <button
              className="primary-button"
              type="button"
              disabled={resuming}
              onClick={() => void resume()}
            >
              {resuming ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} Resume
              this account
            </button>
          ) : (
            <button
              className="ghost-button danger"
              type="button"
              onClick={() => setConfirmPause(true)}
            >
              <CircleStop size={14} /> Pause this account
            </button>
          )}
          <button
            className="ghost-button danger li-acct-remove"
            type="button"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 size={13} /> Remove account
          </button>
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Today on {account.label}</h3>
            <p>
              The last 24 hours against the limits you set — a rolling window, not since midnight.
            </p>
          </div>
          <KeyRound size={20} className="li-heading-icon" />
        </div>
        <div className="li-stat-row">
          {LIMIT_FIELDS.map((limit) => {
            const ceiling = account[limit.field];
            const used = usedToday(limit, detail);
            return (
              <LiStat
                key={limit.field}
                label={limit.label}
                value={used === undefined ? '—' : String(used)}
                tone={
                  ceiling === 0 ? 'mute' : used !== undefined && used >= ceiling ? 'warn' : 'ok'
                }
                detail={
                  ceiling === 0 ? (
                    'turned off for this account'
                  ) : (
                    <>
                      of {ceiling} a day
                      {limit.pooledKindsLabel ? ` · ${limit.pooledKindsLabel} together` : ''}
                    </>
                  )
                }
              />
            );
          })}
        </div>

        <EditAccountForm
          account={account}
          safety={safety}
          setToast={setToast}
          onSaved={onChanged}
        />
      </section>

      <PendingInviteWithdrawalsSection setToast={setToast} />

      {confirmPause && (
        <ConfirmDrawer
          title={`Pause ${account.label}?`}
          tone="caution"
          busy={pausing}
          requireReason
          reasonLabel="Why are you pausing it?"
          body={
            <>
              <p>
                Nothing is scheduled or sent from this account until you resume it. Your other
                accounts keep running — pausing one stops one.
              </p>
              <p>
                Say why. This is the note you will read three weeks from now, when you are deciding
                whether to turn it back on.
              </p>
            </>
          }
          confirmLabel="Pause this account"
          onConfirm={(reason) => void pause(reason)}
          onCancel={() => setConfirmPause(false)}
        />
      )}

      {confirmRemove && (
        <ConfirmDrawer
          title={`Remove ${account.label}?`}
          tone="danger"
          busy={removing}
          error={removeError}
          body={
            <>
              <p>
                This forgets the account itself: its name, its timezone, its working hours, its
                daily limits, and the copy of its LinkedIn inbox that Trevra keeps.{' '}
                <b>The inbox copy cannot be recovered</b> — Trevra reads it back from LinkedIn only
                for accounts it still has.
              </p>
              <p>
                What this account already sent stays in your send history, untouched. So does its
                stored sign-in — to remove that too, use <b>Forget this sign-in</b> first.
              </p>
            </>
          }
          confirmLabel="Remove this account"
          onConfirm={() => void remove()}
          onCancel={() => {
            setConfirmRemove(false);
            setRemoveError(null);
          }}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------
 * Pending invites, and withdrawing the stale ones.
 *
 * Ported from the old `/setup/seat` screen (`LinkedInSeatSetup` in
 * LinkedInScreen.tsx) when that route became a redirect to Outreach ->
 * Settings: the capability had no reachable UI without a new home, and this
 * is it -- a collapsed section on the account it acts on, opened on demand
 * rather than fetched on every visit to this already-busy screen.
 * ---------------------------------------------------------------------- */

const WITHDRAWAL_STATUS_LABELS: Record<WithdrawalStatus, string> = {
  queued: 'Queued',
  withdrawn: 'Withdrawn',
  stale: 'Gone from LinkedIn',
  failed: 'Failed',
  held: 'Held back by your limits'
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
  /**
   * The operator's own staleness threshold, or null for the server's.
   *
   * `GET /api/linkedin/withdrawals/candidates` reports `staleAfterDays` -- the
   * threshold it actually applied -- and this screen sat a hardcoded 21 next to
   * it, so a deployment that calls an invite stale at 14 was queried at 21 with
   * nothing on screen saying the two had parted. Null means the first read asks
   * for whatever the server considers stale, and the field then shows that
   * number. Typing in it is an override, and an override wins from then on.
   */
  const [olderThanDays, setOlderThanDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'sync' | 'queue' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  /** A 409 from the sync route: something to do on this machine, in the server's words. */
  const [blocked, setBlocked] = useState('');

  /** What this server calls stale, once it has said so. Null before the first read. */
  const staleAfterDays = backlog?.staleAfterDays ?? null;
  /** The threshold actually in force: the operator's override, or the server's own. */
  const days = olderThanDays ?? staleAfterDays;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [candidates, withdrawals] = await Promise.all([
        getLinkedInWithdrawalCandidates(olderThanDays === null ? {} : { olderThanDays }),
        getLinkedInWithdrawals({ limit: 50 })
      ]);
      setBacklog(candidates);
      setQueue(withdrawals);
      setError('');
    } catch (err) {
      setError(
        errorMessage(
          err,
          'Unable to read your unanswered invites. Nothing was changed — try again.'
        )
      );
    } finally {
      setLoading(false);
    }
  }, [olderThanDays]);

  useEffect(() => {
    void load();
  }, [load]);
  useOutreachRefresh(load);
  const hasQueuedWithdrawals = queue.some((record) => record.status === 'queued');
  useEffect(() => {
    if (!hasQueuedWithdrawals) return;
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [hasQueuedWithdrawals, load]);

  const sync = async () => {
    setBusy('sync');
    setBlocked('');
    setError('');
    try {
      const result = await syncLinkedInPendingInvites();
      // A PARTIAL READ IS NOT A CLEAN ONE. `degraded` names what that page did
      // not give up, and dropping it reported a half-read invitation list as a
      // complete one -- which then makes every count below look authoritative.
      setToast(
        `${result.listed} invitation(s) still showing on LinkedIn · ${result.matched} that Trevra sent, ` +
          `${result.unmatched} you sent yourself, ${result.disappeared} no longer shown.` +
          `${result.truncated ? ' The list was longer than one pass reads.' : ''}` +
          `${
            result.degraded.length > 0
              ? ` Partial reading — ${result.degraded.length} thing(s) could not be read: ${result.degraded.join(', ')}.`
              : ''
          }`
      );
      await load();
    } catch (err) {
      const message = errorMessage(err, 'Unable to re-read the sent-invitations list');
      if (err instanceof ApiError && err.status === 409) setBlocked(message);
      else setError(message);
    } finally {
      setBusy(null);
    }
  };

  const enqueue = async () => {
    setBusy('queue');
    setError('');
    try {
      const result = await queueLinkedInWithdrawals(days === null ? {} : { olderThanDays: days });
      setConfirming(false);
      setToast(
        `${result.queued} withdrawal(s) queued${result.duplicates > 0 ? `, ${result.duplicates} already queued` : ''}. ` +
          `${result.withdrawn} have actually been withdrawn, and queueing never withdraws anything by itself. ` +
          'They go one at a time, spaced out, inside your working hours.'
      );
      await reloadOutreach();
    } catch (err) {
      setError(errorMessage(err, 'Unable to queue those withdrawals'));
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  };

  const pending = backlog?.pendingInvites ?? 0;
  const ceiling = backlog?.maxOutstandingInvites ?? 0;
  const candidates = backlog?.candidates ?? [];
  const over = ceiling > 0 && pending >= ceiling;
  const share = ceiling > 0 ? Math.min(1, pending / ceiling) : 0;

  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Invites nobody has answered</h3>
          <p>
            These do not expire out of the count. An invite that is neither accepted nor withdrawn
            keeps using up your weekly invite capacity on LinkedIn’s side, and sending more does not
            give any of it back.
          </p>
        </div>
        <ConfidenceTag confidence="REPORTED" source={sourceNote('REPORTED')} compact />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {blocked && (
        <div className="li-connect-blocked">
          <strong>
            <CircleAlert size={14} /> One thing has to happen on your machine first.
          </strong>
          <p className="li-blocked-message">{blocked}</p>
          <p>Nothing was read and nothing was queued.</p>
        </div>
      )}

      <div className="li-backlog">
        <div className="li-backlog-head">
          <strong className={over ? 'li-backlog-over' : ''}>{pending}</strong>
          <span>
            of {ceiling || '—'} unanswered invites{over ? ' — at or past the limit' : ''}
          </span>
        </div>
        <div
          className="li-backlog-meter"
          role="img"
          aria-label={
            ceiling > 0
              ? `${pending} unanswered invites against a reported limit of ${ceiling}.`
              : `${pending} unanswered invites. No limit was reported for this account.`
          }
        >
          <i
            className={over ? 'li-backlog-fill li-backlog-fill-over' : 'li-backlog-fill'}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <p className="li-hint">
          {over
            ? 'Trevra will not send another invite past this line, and it is right not to — LinkedIn counts the unanswered ' +
              'ones too. Withdrawing the oldest ones is the only thing that gives the capacity back.'
            : 'Trevra stops sending invites once this reaches the limit. The limit itself is a practitioner estimate rather ' +
              'than a published number — it comes from the same reporting that puts acceptance at 25–30% above 100 invites a week.'}
        </p>
      </div>

      <div className="li-filter-row">
        <label>
          Pending longer than
          <input
            type="number"
            min={0}
            max={365}
            value={days ?? ''}
            onChange={(event) =>
              setOlderThanDays(Math.max(0, Math.trunc(Number(event.target.value) || 0)))
            }
          />
        </label>
        <span className="li-filter-label">days</span>
        <button
          className="secondary-button"
          type="button"
          disabled={busy !== null}
          onClick={() => void sync()}
        >
          {busy === 'sync' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
          Sync from LinkedIn
        </button>
        {loading && <LoaderCircle className="spin" size={14} aria-label="Reading the backlog" />}
      </div>
      <p className="panel-note">
        Syncing opens LinkedIn’s own Sent invitations list in a browser on this machine and records
        only what that page shows. Accepted, declined, expired and withdrawn all look identical
        there, so an invite that has vanished from the list is recorded as vanished — Trevra will
        not guess which of the four it was.
      </p>

      <h4 className="li-subhead" aria-level={3}>
        Old enough to withdraw ({candidates.length})
      </h4>
      {candidates.length === 0 ? (
        <p className="empty-copy">
          Nothing has been waiting longer than {days ?? '—'} day(s). This is a shortlist, not a
          decision — it shows what
          <em> would</em> be queued, before anything is.
        </p>
      ) : (
        <div className="li-table-scroll">
          <table className="li-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Waiting</th>
                <th>Campaign</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.actionId}>
                  <td className="li-target">{candidate.targetRef}</td>
                  <td className="li-num">
                    {candidate.pendingDays} day{candidate.pendingDays === 1 ? '' : 's'}
                  </td>
                  <td>{candidate.campaignId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="li-two-step">
        <Undo2 size={20} />
        <div>
          <strong>Queueing is not withdrawing. Pressing the button withdraws nothing.</strong>
          <p>
            It puts one reversible line in the queue per invite. The worker on your machine then
            takes them one at a time, re-runs every safety check against each, and clicks Withdraw
            at random 30–120 second gaps inside your working hours — because clearing a backlog in
            one burst looks exactly like a sending spree. The queue below is where you see what
            actually happened.
          </p>
        </div>
      </div>

      <div className="panel-footer">
        <span>
          Withdrawing does not un-send an invite. Trevra goes on counting the original against every
          rolling limit, so withdrawing and re-sending cannot buy you extra volume.
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={busy !== null || candidates.length === 0}
          onClick={() => setConfirming(true)}
        >
          {busy === 'queue' ? <LoaderCircle className="spin" size={15} /> : <Undo2 size={15} />}{' '}
          Queue {candidates.length} withdrawal(s)
        </button>
      </div>

      {queue.length > 0 && (
        <>
          <h4 className="li-subhead" aria-level={3}>
            The withdrawal queue
          </h4>
          <div className="li-table-scroll">
            <table className="li-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th>Waited</th>
                  <th>Timing</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((record) => {
                  const visit = formatVisitWindow(
                    record.nextRunAt,
                    record.nextRunWindowEndAt,
                    record.nextRunTimezone
                  );
                  const wait = queueWaitCopy(record.waitingFor);
                  return (
                    <tr key={record.id}>
                      <td className="li-target">{record.targetRef}</td>
                      <td>
                        <span className={`li-chip li-wd-${record.status}`}>
                          {WITHDRAWAL_STATUS_LABELS[record.status] ?? record.status}
                        </span>
                        {record.detail && <small className="li-failure">{record.detail}</small>}
                      </td>
                      <td className="li-num">
                        {record.pendingDays === null ? '—' : `${record.pendingDays}d`}
                      </td>
                      <td className="li-queue-timing">
                        {record.status === 'queued' && record.claimedAt ? (
                          <>
                            <strong>Running now</strong>
                            <small>Picked up {relativeTime(record.claimedAt)}</small>
                          </>
                        ) : record.status === 'queued' ? (
                          <>
                            <strong>
                              {wait ??
                                (visit
                                  ? 'Expected in LinkedIn visit'
                                  : 'Waiting for next eligible visit')}
                            </strong>
                            {visit && <small>{visit}</small>}
                          </>
                        ) : (
                          <>
                            <strong>Queued {relativeTime(record.queuedAt)}</strong>
                          </>
                        )}
                      </td>
                      <td>
                        {record.finishedAt ? new Date(record.finishedAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirming && (
        <ConfirmDrawer
          title={`Queue ${candidates.length} withdrawal(s)?`}
          busy={busy === 'queue'}
          body={
            <>
              <p>
                <b>This queues them. It withdraws nothing.</b> Trevra will report none withdrawn,
                and that is correct — the work is filed for the browser on your machine to carry
                out.
              </p>
              <p>
                It takes one at a time, re-runs every safety check against it, and clicks Withdraw
                at random 30–120 second gaps inside your working hours. Nothing happens at all while
                this account is paused.
              </p>
              <p>
                Each withdrawal is real on LinkedIn and cannot be taken back — you can invite the
                person again, but this invite is gone. Trevra still counts the original invite
                against every rolling limit.
              </p>
            </>
          }
          confirmLabel={`Queue ${candidates.length} withdrawal(s)`}
          onConfirm={() => void enqueue()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

/**
 * The same panel, collapsed behind a toggle on the account it acts on.
 *
 * Nothing above fetches until this is opened: `PendingInviteWithdrawals`
 * mounts only once `open` is true, so an account you never expand never
 * spends a request on its withdrawal backlog. `.li-manual-fields`, matching
 * the disclosure style the rest of Outreach settled on -- not a `.mgr-inputs`
 * workaround any more; `.outreach-simple` used to blanket-hide `.mgr-inputs`,
 * but that rule is now scoped to the opt-in `.mgr-simple-hide` (see
 * styles.css).
 */
function PendingInviteWithdrawalsSection({ setToast }: { setToast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="li-manual-fields" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Undo2 size={13} /> Withdraw stale pending invites
      </summary>
      {open && <PendingInviteWithdrawals setToast={setToast} />}
    </details>
  );
}
/* -------------------------------------------------------------------------
 * Every account at once, for the comparison the panel above cannot make.
 * ---------------------------------------------------------------------- */

function AccountsTable({
  accounts,
  details,
  reports,
  activeKey,
  onSelect
}: {
  accounts: LinkedInSeat[];
  details: Record<string, LinkedInSeatResponse>;
  /** GET /api/linkedin/limits per account: the ceilings that are actually enforced. */
  reports: Record<string, LinkedInLimitsReport>;
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>All accounts</h3>
          <p>
            What each one actually sends in 24 hours, and what it has sent. Select a name to work in
            that account.
          </p>
        </div>
        <Users size={20} className="li-heading-icon" />
      </div>
      <div className="li-table-scroll li-acct-scroll">
        <table className="li-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>Timezone</th>
              <th>Works</th>
              {LIMIT_FIELDS.map((limit) => (
                <th key={limit.field} className="li-num">
                  {limit.column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const detail = details[account.seatKey] ?? null;
              const state = accountState(account, detail);
              const isActive = account.seatKey === activeKey;
              return (
                <tr key={account.seatKey} className={isActive ? 'li-acct-row-active' : undefined}>
                  <td>
                    <button
                      className="li-acct-pick"
                      type="button"
                      onClick={() => onSelect(account.seatKey)}
                    >
                      {account.label}
                    </button>
                    <small className="li-acct-row-mail">
                      {detail?.auth.maskedEmail ??
                        (detail?.auth.sessionValidAt
                          ? 'Local browser session'
                          : 'No confirmed session')}
                    </small>
                  </td>
                  <td>
                    <span className={`li-acct-state li-acct-state-${STATE_TONES[state]}`}>
                      <i
                        className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`}
                        aria-hidden="true"
                      />
                      {STATE_LABELS[state]}
                    </span>
                  </td>
                  <td>{account.timezone}</td>
                  <td>
                    {describeDays(account.workingDays)}
                    <br />
                    <small className="li-acct-row-mail">
                      {minutesToClock(account.workStartMinute)}–
                      {minutesToClock(account.workEndMinute)}
                    </small>
                  </td>
                  {LIMIT_FIELDS.map((limit) => {
                    const yours = account[limit.field];
                    /* THE NUMBER THE CHECK WILL USE, from the route that runs the
                   check. Never `min(...)` of the two here: which one binds is
                   the server's verdict (`ceilingSource`) and it depends on the
                   account's posture, its warm-up week and its band override --
                   none of which this row could see. */
                    const row =
                      reports[account.seatKey]?.limits.find(
                        (entry) => entry.kind === limit.kind && entry.window === 'day'
                      ) ?? null;
                    const ceiling = row?.ceiling ?? null;
                    const used = usedToday(limit, detail);
                    const share =
                      ceiling !== null && ceiling > 0 && used !== undefined
                        ? Math.min(1, used / ceiling)
                        : 0;
                    // BOTH NUMBERS AT THE POINT OF DECISION, and only when they
                    // differ -- "30 · 30" would be noise on the accounts that agree.
                    const overruled = row !== null && ceiling !== null && ceiling !== yours;
                    return (
                      <td key={limit.field} className="li-num">
                        {yours === 0 ? (
                          <span className="li-unknown">off</span>
                        ) : (
                          <>
                            {used === undefined ? '—' : used} / {ceiling ?? yours}
                            <span className="li-acct-usage" aria-hidden="true">
                              <span
                                className={`li-acct-usage-fill${share >= 1 ? ' is-full' : ''}`}
                                style={{ width: `${Math.round(share * 100)}%` }}
                              />
                            </span>
                            {overruled && (
                              <small className="li-acct-row-mail">you set {yours}</small>
                            )}
                            {row === null && (
                              <small className="li-acct-row-mail">
                                you set {yours}, enforced number unread
                              </small>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="panel-note">
        <Hint label="What the big number means" trigger={<>What the big number means</>}>
          It is <b>what will actually go out</b> — Trevra’s ceiling for that account today, after
          warm-up and anything else holding it back. Where your own setting differs it is named
          underneath: you set 30, 18 goes out. Trevra’s band wins whenever it is the lower of the
          two, unless you have said otherwise on that account.
          {LIMIT_FIELDS.filter((limit) => limit.pooledKindsLabel).map((limit) => (
            <span key={limit.field}>
              {' '}
              {limit.column} is one ceiling shared by {limit.pooledKindsLabel}: a reply spends room
              a new message would.
            </span>
          ))}
        </Hint>
      </p>
    </section>
  );
}
