import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Check,
  CircleAlert,
  CircleStop,
  Copy,
  KeyRound,
  Laptop,
  Linkedin,
  LoaderCircle,
  LogIn,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
  Users
} from 'lucide-react';
import {
  ApiError,
  createLinkedInCompanionPairing,
  createLinkedInManagerSeat,
  deleteLinkedInCredentials,
  deleteLinkedInSeat,
  detectLinkedInSeat,
  getLinkedInCompanionStatus,
  getLinkedInLimits,
  getLinkedInManagerSeats,
  getLinkedInSeat,
  getLinkedInWorkerStatus,
  loginLinkedInSeat,
  markLinkedInCompanionPresence,
  pauseLinkedInSeat,
  resumeLinkedInSeat,
  revokeLinkedInCompanionDevice,
  saveLinkedInCredentials,
  updateLinkedInManagerSeat,
  type LinkedInCompanionStatus,
  type LinkedInDetectedProfile,
  type LinkedInLimitsReport,
  type LinkedInSeat,
  type LinkedInSeatResponse,
  type LinkedInWorkerStatus,
  type PacedKind
} from './api';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { LiStat } from './LinkedInViz';
import { ConfirmDrawer } from './ui/dialog';

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

/**
 * The account key every workspace already has, and what an absent `seatKey`
 * means on every route in `api.ts`.
 *
 * Restated rather than imported: `OWNER_SEAT_KEY` lives in
 * `server/linkedin/seats.ts`, and importing a value from there would pull the
 * module -- and what it imports -- into the browser bundle for the sake of one
 * five-letter string.
 */
const OWNER_ACCOUNT_KEY = 'owner';

const ACTIVE_ACCOUNT_STORAGE_KEY = 'trevra.linkedin.active-account';

/**
 * Fired on `window` whenever the active account changes.
 *
 * `storage` only fires in OTHER tabs, so it cannot keep two components in THIS
 * one agreed -- which is the case that matters: the switcher on this screen
 * and whatever else adopts `useActiveSeatKey` are usually mounted together.
 * Both events are listened for, so a second tab follows along too.
 *
 * IT CARRIES THE KEY IT IS ANNOUNCING (`CustomEvent<string>`) rather than
 * telling every listener to go and re-read storage. That is not a convenience.
 * When the storage write FAILS -- private mode, blocked cookies -- a re-read
 * returns the PREVIOUS key, so a payload-free event would hand every other
 * subscriber the old value and quietly undo the switch for everybody except
 * the component that made it.
 */
const ACTIVE_ACCOUNT_EVENT = 'trevra:linkedin-active-account';

/**
 * The server's own rule for an account key (`linkedinSeatKeySchema` in
 * app.ts), restated so the field can refuse before the request is made.
 * A form that only learns the rule from a 400 is a form that taught nothing.
 */
export const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function readActiveAccountKey(): string {
  try {
    return window.localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) || OWNER_ACCOUNT_KEY;
  } catch {
    // Storage refused (private mode, blocked cookies). The default is still an
    // answer, and it is the account every workspace has.
    return OWNER_ACCOUNT_KEY;
  }
}

/**
 * THE ACTIVE ACCOUNT ITSELF, held once for the whole tab.
 *
 * A module variable rather than a `useState` per caller, because a copy per
 * caller is not a source of truth: every screen reading this hook has to see
 * the same key at the same moment, and one value behind `useSyncExternalStore`
 * is React's own answer to exactly that -- it also rules out the torn render a
 * pile of independent `useState`s allows under concurrent rendering.
 *
 * `localStorage` is where the choice is REMEMBERED, not where each subscriber
 * reads it from on every wake-up. See `ACTIVE_ACCOUNT_EVENT` for why the
 * difference decides what happens when storage refuses the write.
 *
 * Null until first read, so importing this module touches no browser API.
 */
let activeAccountKey: string | null = null;

/** Every mounted `useActiveSeatKey`, notified in one pass on every change. */
const activeAccountSubscribers = new Set<() => void>();

/**
 * The snapshot `useSyncExternalStore` compares between renders, so it has to be
 * the SAME string until something actually changes it -- never a fresh read of
 * storage, which would make every render a new snapshot and loop forever.
 */
function activeAccountSnapshot(): string {
  if (activeAccountKey === null) activeAccountKey = readActiveAccountKey();
  return activeAccountKey;
}

/** Take a key decided somewhere else: another component, or another tab. */
function adoptActiveAccountKey(next: string): void {
  if (!next || activeAccountKey === next) return;
  activeAccountKey = next;
  // A copy, because a subscriber is free to unsubscribe while being notified.
  for (const notify of [...activeAccountSubscribers]) notify();
}

const followActiveAccountEvent = (event: Event) => {
  const detail = (event as CustomEvent<string>).detail;
  if (typeof detail === 'string') adoptActiveAccountKey(detail);
};

/**
 * Another tab switched account. A `null` event key is a whole-storage clear,
 * which is a reset to the default account rather than a switch to nothing.
 */
const followActiveAccountStorage = (event: StorageEvent) => {
  if (event.key !== null && event.key !== ACTIVE_ACCOUNT_STORAGE_KEY) return;
  adoptActiveAccountKey(event.newValue || readActiveAccountKey());
};

/** One pair of window listeners for the whole tab, however many screens read the hook. */
function subscribeToActiveAccount(notify: () => void): () => void {
  if (activeAccountSubscribers.size === 0) {
    window.addEventListener(ACTIVE_ACCOUNT_EVENT, followActiveAccountEvent);
    window.addEventListener('storage', followActiveAccountStorage);
  }
  activeAccountSubscribers.add(notify);
  return () => {
    activeAccountSubscribers.delete(notify);
    if (activeAccountSubscribers.size === 0) {
      window.removeEventListener(ACTIVE_ACCOUNT_EVENT, followActiveAccountEvent);
      window.removeEventListener('storage', followActiveAccountStorage);
    }
  };
}

/**
 * Switch every screen in this tab -- and every other tab -- to one account.
 *
 * Order matters: remember it, then move the value every subscriber reads, then
 * announce it. The announcement is last because it is for listeners that are
 * NOT using the hook; the subscribers above have already been told, and the
 * event's own handler sees a key it already holds and stops.
 */
export function setActiveSeatKey(next: string): void {
  try { window.localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, next); }
  catch { /* Not remembered across reloads. The choice still holds for every screen in this tab, which is what the line below guarantees. */ }
  adoptActiveAccountKey(next);
  window.dispatchEvent(new CustomEvent<string>(ACTIVE_ACCOUNT_EVENT, { detail: next }));
}

/**
 * The account every other screen should be reading, remembered across reloads.
 *
 * Exported as a pair rather than a context because the screens that adopt it --
 * inbox, queue, campaigns, the manager -- are separate hash routes with no
 * common parent to hold a provider. The store above is that parent;
 * `localStorage` is only how it survives a reload, and the event is only how a
 * second tab hears about it.
 *
 * THE PAIR IS THIS FILE'S STABLE CONTRACT: `const [seatKey, setSeatKey] =
 * useActiveSeatKey()`. The setter is a module function, so its identity never
 * changes between renders and it is safe in a dependency array -- which is
 * exactly where a screen re-reading its own data on a switch will put it.
 */
export function useActiveSeatKey(): [string, (key: string) => void] {
  const key = useSyncExternalStore(subscribeToActiveAccount, activeAccountSnapshot, activeAccountSnapshot);
  return [key, setActiveSeatKey];
}

/**
 * The switch itself, on every screen that obeys it -- and the sentence saying
 * what obeying it means HERE.
 *
 * ONE COMPONENT, NOT A COPY PER SCREEN. The switch used to be rendered only on
 * `/outreach`, while the queue, the campaign list and the funnel each read
 * their own data with no seat at all: the choice was two clicks away from
 * every screen it governed, and on those screens nothing said which account
 * the rows belonged to -- so a workspace with two accounts read the first
 * one's queue under the second one's name. A screen that shows per-account
 * rows renders this above them; the account it names and the rows below it are
 * then the same account, on screen, in one glance.
 *
 * `scope` IS REQUIRED AND IT IS THE POINT. Every screen says in its own words
 * what this choice reaches on it -- and a screen whose data is NOT per-account
 * says that instead, in the same place, rather than letting a switcher over
 * workspace-wide rows imply a filter that is not there.
 *
 * Renders nothing at all when the workspace has no LinkedIn account yet, or
 * when the account list cannot be read: an empty picker is not a control, and
 * every screen that uses this has its own empty state saying to connect one.
 */
export function ActiveAccountBar({ scope }: { scope: ReactNode }) {
  const [seatKey, setSeatKey] = useActiveSeatKey();
  const [accounts, setAccounts] = useState<LinkedInSeat[] | null>(null);

  const load = useCallback(async () => {
    // Deliberately silent on failure. This is a control ABOVE the screen's own
    // read, which has its own error banner; a second banner for the picker
    // would report the same outage twice and push the actual work down.
    try { setAccounts(await getLinkedInManagerSeats()); }
    catch { setAccounts([]); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  // Same correction the Accounts screen makes: a remembered key can name an
  // account that has since been deleted, and the first account a workspace adds
  // is not necessarily `owner`. What the screen below reads must be what this
  // control shows, so the memory is fixed rather than quietly ignored.
  const active = accounts?.find((account) => account.seatKey === seatKey) ?? accounts?.[0] ?? null;
  useEffect(() => {
    if (active && active.seatKey !== seatKey) setSeatKey(active.seatKey);
  }, [active, seatKey, setSeatKey]);

  if (!accounts || accounts.length === 0) return null;

  return <section className="page-panel">
    <div className="li-filter-row">
      <label>Working in
        <select
          value={active?.seatKey ?? ''}
          aria-label="LinkedIn account this screen is showing"
          onChange={(event) => setSeatKey(event.target.value)}
        >
          {accounts.map((account) => <option key={account.seatKey} value={account.seatKey}>{account.label}</option>)}
        </select>
      </label>
      <a className="li-link" href="/outreach">Accounts</a>
    </div>
    <p className="panel-note">{scope}</p>
  </section>;
}

/* -------------------------------------------------------------------------
 * The vocabulary and the arithmetic, in one place.
 * ---------------------------------------------------------------------- */

/** JS weekday numbers, Sunday = 0, which is what the server stores. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

type LimitField = 'dailyInviteLimit' | 'dailyMessageLimit' | 'dailyProfileViewLimit' | 'dailyFollowLimit';

/**
 * What an operator may set each of the four ceilings to, and what a seat starts
 * on -- READ FROM THE SERVER, never restated here.
 *
 * `LINKEDIN_OPERATOR_RANGES` in app.ts builds the Zod fields that validate the
 * write AND is reported on GET /api/linkedin/limits for this form to build its
 * controls from, so the range this screen offers and the range the route
 * accepts are one table with one copy. The four numbers that used to sit in
 * this file were a second copy, right only until somebody moved the first.
 */
type OperatorRanges = LinkedInLimitsReport['operatorRanges'];
type OperatorRangeKey = keyof OperatorRanges;

/**
 * The four ceilings an operator sets, and every counter each one is spent by.
 *
 * `kinds` IS A LIST BECAUSE ONE OF THEM POOLS. The gate spends the message
 * ceiling on direct messages, replies and InMail together (`guard.ts`,
 * `messageKinds`), so "messages used today" that counted `dm` alone showed room
 * the gate then refused -- the screen saying 8 of 25 while the send is blocked.
 * `kind` is the one whose researched band this ceiling is compared against.
 */
const LIMIT_FIELDS: ReadonlyArray<{
  field: LimitField;
  kind: PacedKind;
  kinds: readonly PacedKind[];
  range: OperatorRangeKey;
  label: string;
  column: string;
  /** The operator's own words for a pooled ceiling. Absent when the label already names the only kind. */
  pooledKindsLabel?: string;
}> = [
  { field: 'dailyInviteLimit', kind: 'invite', kinds: ['invite'], range: 'invite', label: 'Connection invites', column: 'Invites' },
  {
    field: 'dailyMessageLimit',
    kind: 'dm',
    kinds: ['dm', 'reply', 'inmail'],
    range: 'message',
    label: 'Messages',
    column: 'Messages',
    pooledKindsLabel: 'new messages, replies and InMail'
  },
  { field: 'dailyProfileViewLimit', kind: 'profile_view', kinds: ['profile_view'], range: 'profileView', label: 'Profile views', column: 'Profile views' },
  { field: 'dailyFollowLimit', kind: 'follow', kinds: ['follow'], range: 'follow', label: 'Follows', column: 'Follows' }
];

type LimitSpec = (typeof LIMIT_FIELDS)[number];

/**
 * What this ceiling has been spent by in the last 24 hours: the sum of every
 * kind it pools, which for messages is three of them.
 *
 * `undefined` when there are no counts at all, and it stays an em dash on
 * screen. A count nobody has is never rendered as a zero.
 */
function usedToday(limit: LimitSpec, detail: LinkedInSeatResponse | null): number | undefined {
  const today = detail?.today;
  if (!today) return undefined;
  return limit.kinds.reduce((total, kind) => total + (today[kind] ?? 0), 0);
}

const minutesToClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const clockToMinutes = (clock: string): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59 && !(hour === 24 && minute !== 0)
    ? hour * 60 + minute
    : Number.NaN;
};

/** `Mon–Fri`, `Every day`, or the days themselves. Never a row of seven letters to decode. */
function describeDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'No days';
  if (sorted.length === 7) return 'Every day';
  if (sorted.join() === '1,2,3,4,5') return 'Mon–Fri';
  return sorted.map((day) => DAY_NAMES[day]).join(', ');
}

/** `in/priya-sharma`, not the whole URL. The link still goes to the whole URL. */
const profileLabel = (url: string) => url.replace(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i, '').replace(/\/+$/, '') || url;

/* -------------------------------------------------------------------------
 * Timezones, offered rather than guessed.
 * ---------------------------------------------------------------------- */

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const TIMEZONE_LIST_ID = 'li-acct-timezones';

/**
 * Every IANA zone this browser knows about.
 *
 * A `<datalist>` holding one option -- the value already in the field -- is an
 * autocomplete that completes nothing, which is what this was: a field asking
 * for `Europe/Zurich` with no way to discover that `Europe/Zurich` is the
 * spelling. The list is the ENGINE'S OWN, not a table shipped in this bundle,
 * so it cannot go stale and it cannot be wrong about what the server's IANA
 * validation will accept.
 */
const TIMEZONE_OPTIONS: readonly string[] = (() => {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes(BROWSER_TIMEZONE) ? zones : [BROWSER_TIMEZONE, ...zones];
  } catch {
    // An engine without `supportedValuesOf`. The field is still free text and
    // the server still validates it: what is lost is the suggestion, not the
    // setting.
    return [BROWSER_TIMEZONE];
  }
})();

/** Rendered ONCE for the screen: two forms sharing an id is one id too many. */
function TimezoneOptions() {
  return <datalist id={TIMEZONE_LIST_ID}>
    {TIMEZONE_OPTIONS.map((zone) => <option key={zone} value={zone} />)}
  </datalist>;
}

function TimezoneField({ value, onChange, className, hint }: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  hint?: string;
}) {
  return <label className={className}>Timezone
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Europe/Zurich"
      list={TIMEZONE_LIST_ID}
      spellCheck={false}
      autoComplete="off"
    />
    {hint && <small className="li-acct-range">{hint}</small>}
  </label>;
}

/**
 * What an operator needs to know about an account before they pick it.
 *
 * Five answers, in the order they stop you: paused and cooling down are states
 * Trevra put the account into, not connection problems, so they outrank the
 * sign-in questions -- an account that is paused does not become useful by
 * signing in again.
 */
type AccountState = 'connected' | 'easing-in' | 'needs-signin' | 'not-connected' | 'paused' | 'cooling-down';

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
function stateSentence(state: AccountState, account: LinkedInSeat, detail: LinkedInSeatResponse | null): string {
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
        ? `Week ${detail.warmupWeek} of ${detail.warmupWeeks}. New automation starts slow on purpose — this account may use only part of the limits you set below until the ramp finishes.`
        : 'Easing in: this account may use only part of the limits you set below until the ramp finishes.';
    default:
      return 'Signed in and working to the limits below.';
  }
}

/**
 * A 409 is a wall, not a fault: the server's sentence names the one thing to
 * go and do, so it is shown verbatim and in the instruction colour rather than
 * rewritten in red.
 */
const isWall = (error: unknown) => error instanceof ApiError && error.status === 409;

function Wall({ title, message, children }: { title: string; message?: string; children?: React.ReactNode }) {
  return <div className="li-connect-blocked">
    <strong><CircleAlert size={14} /> {title}</strong>
    {message && <p className="li-blocked-message">{message}</p>}
    {children}
  </div>;
}

/* -------------------------------------------------------------------------
 * The paired computer: hosted Trevra, local LinkedIn browser.
 * ---------------------------------------------------------------------- */

function CompanionPanel({ setToast }: { setToast: (message: string) => void }) {
  const [status, setStatus] = useState<LinkedInCompanionStatus | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; command: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const hadDevice = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await getLinkedInCompanionStatus();
      setStatus(next);
      setError('');
      if (next.devices.length > 0) {
        // Only the workspace owner can turn browser presence into executable
        // LinkedIn presence. Members can see which computer is online without
        // being able to start it indirectly by keeping this screen open.
        if (next.canManage) {
          void markLinkedInCompanionPresence().catch(() => undefined);
          if (!hadDevice.current) {
            hadDevice.current = true;
            window.dispatchEvent(new Event('trevra:linkedin-companion-changed'));
          }
        }
      } else {
        hadDevice.current = false;
      }
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to read connected computers.'));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const pair = async () => {
    setBusy('pair');
    setError('');
    try {
      const created = await createLinkedInCompanionPairing();
      setPairing(created);
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to create a pairing code.'));
    } finally { setBusy(''); }
  };

  const copy = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.command);
      setToast('Companion command copied. Run it in Terminal on the computer that should use LinkedIn.');
    } catch {
      setToast('Copy was blocked by the browser. Select the command and copy it manually.');
    }
  };

  const revoke = async (deviceId: string, label: string) => {
    setBusy(deviceId);
    setError('');
    try {
      await revokeLinkedInCompanionDevice(deviceId);
      setToast(`${label} disconnected. It can no longer lend Trevra a LinkedIn browser.`);
      window.dispatchEvent(new Event('trevra:linkedin-companion-changed'));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to disconnect that computer.'));
    } finally { setBusy(''); }
  };

  const online = status?.devices.find((device) => device.online) ?? null;
  return <section className="page-panel li-companion-panel">
    <div className="section-heading">
      <div>
        <h3 aria-level={2}>Run LinkedIn from your computer</h3>
        <p>
          Recommended for hosted Trevra. LinkedIn opens in Chrome on your computer and uses your normal internet
          connection and IP. Trevra keeps the campaign queue and safety rules; your LinkedIn browser profile stays on this computer.
        </p>
      </div>
      <Laptop size={20} className="li-heading-icon" />
    </div>

    {error && <div className="error-banner">{error}</div>}

    <div className="li-companion-status">
      <span className={`li-acct-state ${online ? 'li-acct-state-ok' : 'li-acct-state-off'}`}>
        <i className={`li-acct-dot ${online ? 'li-acct-dot-ok' : 'li-acct-dot-off'}`} aria-hidden="true" />
        {online ? `${online.label} online` : 'No paired computer online'}
      </span>
      {status?.devices.length ? <span className="li-hint">
        {status.websitePresent ? 'This Trevra tab is keeping LinkedIn work active.' : 'Keep this Trevra tab open to allow a cycle.'}
      </span> : null}
    </div>

    {status && status.devices.length > 0
      ? <div className="li-companion-devices">
        {status.devices.map((device) => <div className="li-companion-device" key={device.id}>
          <div>
            <strong>{device.label}</strong>
            <small>{device.online ? 'Online now' : device.lastSeenAt ? `Last seen ${relativeTime(device.lastSeenAt)}` : 'Never connected'}</small>
          </div>
          {status.canManage && <button className="ghost-button danger" type="button" disabled={busy === device.id} onClick={() => void revoke(device.id, device.label)}>
            {busy === device.id ? <LoaderCircle className="spin" size={13} /> : <Unplug size={13} />} Disconnect
          </button>}
        </div>)}
      </div>
      : <p className="empty-copy">Pair the computer whose browser and network you normally use for LinkedIn.</p>}

    {!status?.canManage && <p className="panel-note">Only the workspace owner can pair a computer or enable LinkedIn execution from it.</p>}

    {status?.canManage && pairing ? <div className="li-companion-command">
      <div>
        <strong>Run this once in Terminal</strong>
        <p>The code expires {relativeTime(pairing.expiresAt)}. The long device token is created only after this one-time code is exchanged and is never shown in Trevra.</p>
      </div>
      <code>{pairing.command}</code>
      <button className="secondary-button" type="button" onClick={() => void copy()}><Copy size={14} /> Copy command</button>
    </div> : status?.canManage ? <button className="primary-button" type="button" disabled={busy === 'pair'} onClick={() => void pair()}>
      {busy === 'pair' ? <LoaderCircle className="spin" size={14} /> : <Laptop size={14} />} Connect this computer
    </button> : null}

    <p className="panel-note">
      Leave <b>both</b> the companion command and Trevra open. If either disappears, no new LinkedIn cycle is claimed.
      The companion Chrome profile is dedicated to LinkedIn and Trevra can control that window while connected, so do not use it for email, banking or other private sites.
      When you return after being offline, Trevra runs one normal bounded sitting and then resumes the ordinary schedule — missed timer ticks are never replayed as a burst.
    </p>
  </section>;
}

/* -------------------------------------------------------------------------
 * The screen.
 * ---------------------------------------------------------------------- */

export function LinkedInAccounts({ setToast }: { setToast: (message: string) => void }) {
  const [activeKey, setActiveKey] = useActiveSeatKey();
  const [accounts, setAccounts] = useState<LinkedInSeat[] | null>(null);
  const [details, setDetails] = useState<Record<string, LinkedInSeatResponse>>({});
  /**
   * The ENFORCED ceilings, per account, straight from the route that enforces
   * them.
   *
   * The table below used to print the account's own configured number as the
   * ceiling -- "4 / 30" -- while the check immediately before every action was
   * applying `min(band, operator)` and letting 18 out. That is the silent
   * trade-off this screen exists to stop being silent about, and the only
   * honest fix is to print the number the server says will actually go out,
   * next to the one the operator set. Nothing here is computed from the two.
   */
  const [reports, setReports] = useState<Record<string, LinkedInLimitsReport>>({});
  const [worker, setWorker] = useState<LinkedInWorkerStatus | null>(null);
  const [safety, setSafety] = useState<LinkedInLimitsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, workerStatus] = await Promise.all([
        getLinkedInManagerSeats(),
        // The worker read is evidence, not the subject. A failed one must not
        // take the account list down with it.
        getLinkedInWorkerStatus().catch(() => null)
      ]);
      setAccounts(list);
      setWorker(workerStatus);
      // lc-debt: one GET /api/linkedin/seat per account -- fine at the handful
      // of accounts a person manages, wrong at fifty; upgrade path is a manager
      // route returning sign-in state and today's counts for every account at
      // once.
      const reads = await Promise.all(list.map(async (account) => {
        try { return [account.seatKey, await getLinkedInSeat(account.seatKey)] as const; }
        catch { return [account.seatKey, null] as const; }
      }));
      setDetails(Object.fromEntries(
        reads.filter((entry): entry is readonly [string, LinkedInSeatResponse] => entry[1] !== null)
      ));
      // Per account, and a failed one simply leaves that row saying it does not
      // know rather than falling back to the number the form holds.
      const ceilings = await Promise.all(list.map(async (account) => {
        try { return [account.seatKey, await getLinkedInLimits(account.seatKey)] as const; }
        catch { return [account.seatKey, null] as const; }
      }));
      setReports(Object.fromEntries(
        ceilings.filter((entry): entry is readonly [string, LinkedInLimitsReport] => entry[1] !== null)
      ));
      setFailure('');
    } catch (error) {
      setFailure(errorMessage(error, 'Unable to read your LinkedIn accounts. Nothing was changed — try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  // A remembered key can name an account that has since been removed, and the
  // first account a workspace adds may not be `owner`. What is on screen is
  // what is stored, so the memory is corrected rather than quietly ignored.
  const active = accounts?.find((account) => account.seatKey === activeKey) ?? accounts?.[0] ?? null;
  useEffect(() => {
    if (active && active.seatKey !== activeKey) setActiveKey(active.seatKey);
  }, [active, activeKey, setActiveKey]);

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
      (report) => { if (!cancelled) setSafety(report); },
      () => { if (!cancelled) setSafety(null); }
    );
    return () => { cancelled = true; };
  }, [activeSeatKey]);

  const empty = accounts !== null && accounts.length === 0;

  return <div className="page-stack">
    <TimezoneOptions />

    {failure && <div className="error-banner">
      <strong>{failure}</strong>{' '}
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
        {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Try again
      </button>
    </div>}

    <WorkerNotice worker={worker} />
    {worker?.companionBrowser && <CompanionPanel setToast={setToast} />}

    {accounts === null
      ? <section className="page-panel"><p className="empty-copy">{loading ? 'Reading your LinkedIn accounts…' : 'No data.'}</p></section>
      : empty
        ? <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>No LinkedIn account connected yet</h3>
              <p>Trevra paces, queues and reads replies per account. Add the first one and everything else on Outreach has something to run against.</p>
            </div>
            <Users size={20} className="li-heading-icon" />
          </div>
          <AddAccountForm
            existingKeys={[]}
            safety={safety}
            firstOne
            onCancel={null}
            onCreated={(created) => { setActiveKey(created.seatKey); setToast(`${created.label} added. Connect it below to start sending from it.`); void load(); }}
          />
        </section>
        : <>
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>Your LinkedIn accounts</h3>
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
              <p>
                Pick the account you are working in. Every outreach screen that reads or sends as one account follows
                this choice, in this tab and in your other ones: the Inbox, Approve &amp; export, the send queue, the
                plan preview, and the daily limits and funnel on this screen. Each of them shows the same picker over
                its rows. Lead sources, your Never contact list and workspace settings are not per-account — they are
                shared, and switching does not move them.
              </p>
              </div>
              <button className="secondary-button li-acct-nowrap" type="button" onClick={() => setAdding((open) => !open)}>
                <Plus size={14} /> {adding ? 'Cancel' : 'Add account'}
              </button>
            </div>

            <div className="li-acct-switch" role="group" aria-label="Switch LinkedIn account">
              {accounts.map((account) => {
                const detail = details[account.seatKey] ?? null;
                const state = accountState(account, detail);
                const isActive = active?.seatKey === account.seatKey;
                return <button
                  key={account.seatKey}
                  type="button"
                  className={`li-acct-tab${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => setActiveKey(account.seatKey)}
                >
                  <span className="li-acct-tab-head">
                    <i className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`} aria-hidden="true" />
                    <strong>{account.label}</strong>
                  </span>
                  <small>{detail?.auth.maskedEmail ?? (detail?.auth.sessionValidAt ? 'Local browser session' : 'No confirmed session')}</small>
                  <small className="li-acct-tab-state">{isActive ? 'Working in this account' : STATE_LABELS[state]}</small>
                </button>;
              })}
            </div>

            {adding && <AddAccountForm
              existingKeys={accounts.map((account) => account.seatKey)}
              safety={safety}
              onCancel={() => setAdding(false)}
              onCreated={(created) => {
                setAdding(false);
                setActiveKey(created.seatKey);
                setToast(`${created.label} added. Connect it below to start sending from it.`);
                void load();
              }}
            />}
          </section>

          {active && <AccountPanel
            key={active.seatKey}
            account={active}
            detail={details[active.seatKey] ?? null}
            safety={safety}
            companion={Boolean(worker?.companionBrowser)}
            setToast={setToast}
            onChanged={load}
            onRemoved={() => { setActiveKey(OWNER_ACCOUNT_KEY); void load(); }}
          />}

          {accounts.length > 1 && <AccountsTable
            accounts={accounts}
            details={details}
            reports={reports}
            activeKey={active?.seatKey ?? ''}
            onSelect={setActiveKey}
          />}
        </>}
  </div>;
}

/* -------------------------------------------------------------------------
 * What this machine can and cannot do, said before anybody types a password.
 * ---------------------------------------------------------------------- */

function WorkerNotice({ worker }: { worker: LinkedInWorkerStatus | null }) {
  if (!worker || worker.ready) return null;
  const blockers = Array.from(new Set(worker.blockers));

  /**
   * WHICH WALL THIS IS, read off the payload's own booleans instead of out of
   * its prose.
   *
   * These are the same three fields the server computes `ready` from
   * (`enabled && playwrightInstalled && (canLaunchHeaded || canLaunchHeadless)`),
   * so this panel cannot disagree with the flag that made it appear, and no
   * rewording of a blocker sentence can flip it. A HEADED browser counts, and
   * counting only the headless one is what had this wall appear on a machine
   * driving a real Chrome on an Xvfb display -- over the sentence explaining
   * that it declines to open an INVISIBLE browser. It also fixes the half of that guess
   * that was visible: the `npx playwright install` line is now printed under
   * exactly the condition the server emits that blocker under, rather than at
   * anybody whose blocker happened not to contain the word "hosted" -- which
   * included every operator who already has playwright.
   *
   * lc-debt: HOSTED-VERSUS-SWITCHED-OFF IS STILL NOT DISTINGUISHABLE HERE.
   * `linkedInOffReason` knows (`config.hosted`) and says so in its sentence,
   * but the status payload carries no flag for it. So the copy below claims
   * only what `enabled: false` proves -- automation is off on THIS server --
   * and leaves the server's own blocker, rendered verbatim underneath, to say
   * whether that is a deployment decision no setting can undo. Upgrade path:
   * add `hosted: boolean` to GET /api/linkedin/worker/status and branch the
   * first paragraph on it.
   */
  const off = !worker.enabled;
  const needsPlaywright = worker.enabled && !worker.playwrightInstalled;

  return <Wall title={off
    ? 'LinkedIn automation is off on this server.'
    : needsPlaywright
      ? 'Nothing on this machine can open LinkedIn yet.'
      : 'This machine has Playwright but cannot open a browser.'}>
    <p>{off
      ? 'You can still add accounts here and set their hours and daily limits. Connecting one, and sending from it, happens on a Trevra with LinkedIn automation on — the reason it is off here is below, in the server’s own words.'
      : needsPlaywright
        ? 'Add accounts and set their limits now. Connecting one needs a browser this server can open, which is two commands and a switch.'
        : 'Add accounts and set their limits now. Connecting one needs a browser this server can open, and what is stopping it from opening one is below.'}</p>
    {needsPlaywright && <p className="li-blocked-message"><code>npm i playwright &amp;&amp; npx playwright install chromium</code></p>}
    {blockers.length > 0 && <ul className="li-blockers">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
  </Wall>;
}

/* -------------------------------------------------------------------------
 * The active account: connect it, read it, change it, stop it, remove it.
 * ---------------------------------------------------------------------- */

function AccountPanel({ account, detail, safety, companion, setToast, onChanged, onRemoved }: {
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
      if (ticks > 20) { window.clearInterval(timer); return; }
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
      const result = await detectLinkedInSeat(account.timezone || BROWSER_TIMEZONE, account.seatKey);
      if (result.status === 'pending') {
        // 202. Not an error, and not this machine's job: the server's sentence
        // names what has to run and where.
        setBlocked(result.message ?? 'Queued for the machine that runs your local worker.');
        await onChanged();
        return;
      }
      setDegraded(result.degraded);
      setLastRead(result.detected);
      setToast(result.detected
        ? `Read ${result.detected.name ?? 'the profile'} from ${account.label}’s LinkedIn session.`
        : 'Reached LinkedIn but read nothing usable. Set what is missing by hand below.');
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
    setNote({ tone: result.status === 'challenge' ? 'instruction' : 'error', message: result.message });
  };

  const attempt = async (run: () => Promise<void>) => {
    setSigningIn(true);
    try { await run(); }
    catch (error) { setNote({ tone: 'error', message: errorMessage(error, 'Unable to sign in to LinkedIn') }); }
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
      setToast(`Sign-in forgotten. Nothing can open LinkedIn as ${account.label} until you add it again.`);
      await onChanged();
    } catch (error) {
      setNote({ tone: 'error', message: errorMessage(error, 'Unable to remove the stored sign-in') });
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
      setActionError(errorMessage(error, 'Unable to pause this account. It is still running — try again.'));
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
      setActionError(errorMessage(error, 'Unable to resume this account. It is still paused, which is the safe end of that failure.'));
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

  return <>
    <section className="page-panel li-acct-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>{account.label}</h3>
          <p>{stateSentence(state, account, detail)}</p>
        </div>
        <span className={`li-acct-state li-acct-state-${STATE_TONES[state]}`}>
          <i className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`} aria-hidden="true" />{STATE_LABELS[state]}
        </span>
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      {blocked && <Wall title="One thing has to happen on your own machine first." message={blocked} />}

      {queued && <Wall title={companion ? 'Waiting for your connected computer.' : 'Waiting on your own worker.'}>
        <p>{companion
          ? 'Keep this Trevra tab and `npx trevra linkedin` open. The pending read stays queued while either is offline and is picked up by the next normal cycle when both are back.'
          : 'This server cannot open a browser, so the read is parked for the Trevra worker running on your machine. It runs on the next tick and this panel updates itself — leave it open.'}</p>
      </Wall>}

      {request?.status === 'failed' && request.failureReason && <Wall
        title="The last read of this account did not finish."
        message={request.failureReason}
      />}

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
            <dd>{auth?.maskedEmail ?? (auth?.sessionValidAt ? 'Local browser session' : <span className="li-unknown">Not connected</span>)}</dd>
          </div>
          <div>
            <dt>LinkedIn profile</dt>
            <dd>{account.profileUrl
              ? <a href={account.profileUrl} target="_blank" rel="noreferrer noopener">
                {lastRead?.name ?? profileLabel(account.profileUrl)}
              </a>
              : <span className="li-unknown">Not read yet</span>}</dd>
          </div>
          <div>
            <dt>Timezone</dt>
            <dd>{account.timezone}</dd>
          </div>
          <div>
            <dt>Works</dt>
            <dd>{describeDays(account.workingDays)}, {minutesToClock(account.workStartMinute)}–{minutesToClock(account.workEndMinute)}</dd>
          </div>
          <div>
            <dt>Session confirmed</dt>
            <dd>{auth?.sessionValidAt
              ? relativeTime(auth.sessionValidAt)
              : <span className="li-unknown">Not yet</span>}</dd>
          </div>
          <div>
            <dt>Connections</dt>
            {/* Unknown, never zero: an unreadable count is reported in `degraded` and left as it was. */}
            <dd>{account.connectionsCount === null
              ? <span className="li-unknown">Unknown</span>
              : account.connectionsCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Profile last read</dt>
            <dd>{account.detectedAt
              ? relativeTime(account.detectedAt)
              : <span className="li-unknown">Never</span>}</dd>
          </div>
          <div>
            <dt>Account opened</dt>
            {/* Informational, and nothing paces off it -- the ramp clock is
                `activatedAt`, which is when THIS seat started sending through
                Trevra. LinkedIn does not publish the opening date, so this is
                filled only when somebody says so. */}
            <dd>{account.accountOpenedOn ?? <span className="li-unknown">Not recorded</span>}</dd>
          </div>
        </dl>
      </div>

      {degraded.length > 0 && <div className="li-degraded">
        <strong>Read, but not all of it came back:</strong>
        <ul>{degraded.map((entry) => <li key={entry}>{entry}</li>)}</ul>
        <p>Anything missing is held as unknown, never as zero.</p>
      </div>}

      {connected
        ? <div className="li-signin-row">
          <span className="li-signin-id"><Linkedin size={15} /> {auth?.maskedEmail ?? 'LinkedIn account'}</span>
          <span>{auth?.sessionValidAt
            ? `${companion ? 'Browser session' : 'Session'} confirmed ${relativeTime(auth.sessionValidAt)}`
            : 'No session yet — the sign-in has not completed.'}</span>
          <div className="li-signin-actions">
            {auth?.hasCredentials && <button className="ghost-button danger" type="button" disabled={forgetting} onClick={() => void forgetSignIn()}>
              {forgetting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />} Forget stored password
            </button>}
          </div>
        </div>
        : companion ? <div className="li-dryrun li-acct-promise">
          <Laptop size={20} />
          <div>
            <strong>No LinkedIn password is needed in Trevra.</strong>
            <p>
              Keep <code>npx trevra linkedin</code> running, sign into LinkedIn in the Chrome window it opens on your computer,
              then use <b>Check this account on LinkedIn</b> below. The browser profile and cookies stay on that computer;
              LinkedIn sees that computer&rsquo;s normal network and IP.
            </p>
            {auth?.hasCredentials && <button className="ghost-button danger" type="button" disabled={forgetting} onClick={() => void forgetSignIn()}>
              {forgetting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />} Remove the old stored password
            </button>}
          </div>
        </div>
        : storedSignIn ? <div className="li-signin-row">
          <span className="li-signin-id"><Linkedin size={15} /> {auth?.maskedEmail ?? 'LinkedIn account'}</span>
          <span>The password is stored, but no live session has been confirmed yet.</span>
          <div className="li-signin-actions">
            <button className="secondary-button" type="button" disabled={signingIn} onClick={() => void attempt(() => runLogin())}>
              {signingIn ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />} Sign in
            </button>
            <button className="ghost-button danger" type="button" disabled={forgetting} onClick={() => void forgetSignIn()}>
              {forgetting ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />} Forget this sign-in
            </button>
          </div>
        </div>
        : <>
          {/* The reassurance comes BEFORE the field, not under it: a promise
              made after the password is typed is a receipt, not a promise. */}
          {stage === 'credentials' && <div className="li-dryrun li-acct-promise">
            <ShieldCheck size={20} />
            <div>
              <strong>Before you type it — what happens to this password.</strong>
              <p>
                It is encrypted at rest, sent nowhere but LinkedIn, and used for exactly one thing: opening a browser
                session for this account on the machine running Trevra. You can remove it at any time, and nothing can
                sign in again once you have. No screen ever shows it back — the masked address is the most Trevra
                will say.
              </p>
            </div>
          </div>}

          <div className="li-signin">
            <strong>Connect {account.label}</strong>
            {stage === 'otp'
              ? <form
                className="li-signin-fields li-signin-otp"
                onSubmit={(event) => { event.preventDefault(); void attempt(() => runLogin(otp.trim())); }}
              >
                {/* NO LENGTH RULE, IN EITHER DIRECTION. LinkedIn's own
                    verification codes are six digits today, but the same field
                    takes whatever a challenge asks for -- and `maxLength={6}`
                    with a `< 6` guard on the button meant a code of any other
                    length could be neither typed in full nor submitted, which
                    is a dead end with no way out of it. Whether a code is right
                    is LinkedIn's answer to give; this refuses only an empty
                    one, because an empty one is not an attempt. */}
                <label>Verification code<input
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  aria-label="Verification code"
                /></label>
                <button className="primary-button" type="submit" disabled={signingIn || otp.trim().length === 0}>
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
            {stage === 'otp' && <p className="li-hint">LinkedIn sent a code to this account’s email or phone. Enter it to finish signing in.</p>}
            {note && <>
              <p className={note.tone === 'error' ? 'li-signin-error' : 'li-signin-note'}>{note.message}</p>
              {note.tone === 'instruction' && <p className="li-hint">
                LinkedIn wants a person, not a script. Finish that step in a browser signed in as this account, then
                sign in here again.
              </p>}
            </>}
          </div>
        </>}

      {connected && note && <p className="li-signin-error">{note.message}</p>}

      <div className="li-seat-actions">
        <button className="secondary-button" type="button" disabled={checking} onClick={() => void check()}>
          {checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {' '}Check this account on LinkedIn
        </button>
        {state === 'paused'
          ? <button className="primary-button" type="button" disabled={resuming} onClick={() => void resume()}>
            {resuming ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} Resume this account
          </button>
          : <button className="ghost-button danger" type="button" onClick={() => setConfirmPause(true)}>
            <CircleStop size={14} /> Pause this account
          </button>}
        <button className="ghost-button danger li-acct-remove" type="button" onClick={() => setConfirmRemove(true)}>
          <Trash2 size={13} /> Remove account
        </button>
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Today on {account.label}</h3>
          <p>The last 24 hours against the limits you set — a rolling window, not since midnight.</p>
        </div>
        <KeyRound size={20} className="li-heading-icon" />
      </div>
      <div className="li-stat-row">
        {LIMIT_FIELDS.map((limit) => {
          const ceiling = account[limit.field];
          const used = usedToday(limit, detail);
          return <LiStat
            key={limit.field}
            label={limit.label}
            value={used === undefined ? '—' : String(used)}
            tone={ceiling === 0 ? 'mute' : used !== undefined && used >= ceiling ? 'warn' : 'ok'}
            detail={ceiling === 0
              ? 'turned off for this account'
              : <>of {ceiling} a day{limit.pooledKindsLabel ? ` · ${limit.pooledKindsLabel} together` : ''}</>}
          />;
        })}
      </div>

      <EditAccountForm account={account} safety={safety} setToast={setToast} onSaved={onChanged} />
    </section>

    {confirmPause && <ConfirmDrawer
      title={`Pause ${account.label}?`}
      tone="caution"
      busy={pausing}
      requireReason
      reasonLabel="Why are you pausing it?"
      body={<>
        <p>
          Nothing is scheduled or sent from this account until you resume it. Your other accounts keep running —
          pausing one stops one.
        </p>
        <p>Say why. This is the note you will read three weeks from now, when you are deciding whether to turn it back on.</p>
      </>}
      confirmLabel="Pause this account"
      onConfirm={(reason) => void pause(reason)}
      onCancel={() => setConfirmPause(false)}
    />}

    {confirmRemove && <ConfirmDrawer
      title={`Remove ${account.label}?`}
      tone="danger"
      busy={removing}
      error={removeError}
      body={<>
        <p>
          This forgets the account itself: its name, its timezone, its working hours, its daily limits, and the copy of
          its LinkedIn inbox that Trevra keeps. <b>The inbox copy cannot be recovered</b> — Trevra reads it back from
          LinkedIn only for accounts it still has.
        </p>
        <p>
          What this account already sent stays in your send history, untouched. So does its stored sign-in — to remove
          that too, use <b>Forget this sign-in</b> first.
        </p>
      </>}
      confirmLabel="Remove this account"
      onConfirm={() => void remove()}
      onCancel={() => { setConfirmRemove(false); setRemoveError(null); }}
    />}
  </>;
}

/* -------------------------------------------------------------------------
 * Every account at once, for the comparison the panel above cannot make.
 * ---------------------------------------------------------------------- */

function AccountsTable({ accounts, details, reports, activeKey, onSelect }: {
  accounts: LinkedInSeat[];
  details: Record<string, LinkedInSeatResponse>;
  /** GET /api/linkedin/limits per account: the ceilings that are actually enforced. */
  reports: Record<string, LinkedInLimitsReport>;
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return <section className="page-panel">
    <div className="section-heading">
      <div>
        <h3 aria-level={2}>All accounts</h3>
        <p>What each one actually sends in 24 hours, and what it has sent. Select a name to work in that account.</p>
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
            {LIMIT_FIELDS.map((limit) => <th key={limit.field} className="li-num">{limit.column}</th>)}
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const detail = details[account.seatKey] ?? null;
            const state = accountState(account, detail);
            const isActive = account.seatKey === activeKey;
            return <tr key={account.seatKey} className={isActive ? 'li-acct-row-active' : undefined}>
              <td>
                <button className="li-acct-pick" type="button" onClick={() => onSelect(account.seatKey)}>
                  {account.label}
                </button>
                <small className="li-acct-row-mail">{detail?.auth.maskedEmail ?? (detail?.auth.sessionValidAt ? 'Local browser session' : 'No confirmed session')}</small>
              </td>
              <td>
                <span className={`li-acct-state li-acct-state-${STATE_TONES[state]}`}>
                  <i className={`li-acct-dot li-acct-dot-${STATE_TONES[state]}`} aria-hidden="true" />{STATE_LABELS[state]}
                </span>
              </td>
              <td>{account.timezone}</td>
              <td>{describeDays(account.workingDays)}<br />
                <small className="li-acct-row-mail">{minutesToClock(account.workStartMinute)}–{minutesToClock(account.workEndMinute)}</small>
              </td>
              {LIMIT_FIELDS.map((limit) => {
                const yours = account[limit.field];
                /* THE NUMBER THE CHECK WILL USE, from the route that runs the
                   check. Never `min(...)` of the two here: which one binds is
                   the server's verdict (`ceilingSource`) and it depends on the
                   account's posture, its warm-up week and its band override --
                   none of which this row could see. */
                const row = reports[account.seatKey]?.limits
                  .find((entry) => entry.kind === limit.kind && entry.window === 'day') ?? null;
                const ceiling = row?.ceiling ?? null;
                const used = usedToday(limit, detail);
                const share = ceiling !== null && ceiling > 0 && used !== undefined ? Math.min(1, used / ceiling) : 0;
                // BOTH NUMBERS AT THE POINT OF DECISION, and only when they
                // differ -- "30 · 30" would be noise on the accounts that agree.
                const overruled = row !== null && ceiling !== null && ceiling !== yours;
                return <td key={limit.field} className="li-num">
                  {yours === 0
                    ? <span className="li-unknown">off</span>
                    : <>
                      {used === undefined ? '—' : used} / {ceiling ?? yours}
                      <span className="li-acct-usage" aria-hidden="true">
                        <span
                          className={`li-acct-usage-fill${share >= 1 ? ' is-full' : ''}`}
                          style={{ width: `${Math.round(share * 100)}%` }}
                        />
                      </span>
                      {overruled && <small className="li-acct-row-mail">you set {yours}</small>}
                      {row === null && <small className="li-acct-row-mail">you set {yours}, enforced number unread</small>}
                    </>}
                </td>;
              })}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <p className="panel-note">
      The big number is <b>what will actually go out</b> — Trevra’s researched ceiling for that account today, after
      its warm-up and whatever else is holding it back. Where your own setting is a different number it is named
      underneath, so the two are never confused: you set 30, 18 goes out, and this is where you see both. Trevra’s
      band wins whenever it is the lower of the two, unless you have said otherwise on that account.
      {LIMIT_FIELDS.filter((limit) => limit.pooledKindsLabel).map((limit) => <span key={limit.field}>
        {' '}{limit.column} is one ceiling shared by {limit.pooledKindsLabel}: a reply spends room a new message would
        have used, which is exactly how the gate spends it.
      </span>)}
    </p>
  </section>;
}

/* -------------------------------------------------------------------------
 * The schedule and the ceilings, written once and used by both forms.
 * ---------------------------------------------------------------------- */

interface AccountDraft {
  label: string;
  timezone: string;
  workingDays: number[];
  workStart: string;
  workEnd: string;
  dailyInviteLimit: string;
  dailyMessageLimit: string;
  dailyProfileViewLimit: string;
  dailyFollowLimit: string;
  /** See `BandOverrideField`: whose daily ceiling binds, the operator's or Trevra's. */
  safetyBandOverride: boolean;
  /**
   * A NEW proxy URL to store, or ''.
   *
   * Always blank on open, even for an account that has one: the server will not
   * say a stored password back, so there is nothing to prefill and a field that
   * looked prefilled would be lying about what saving it would write. Blank
   * means "leave whatever is stored alone".
   */
  proxyUrl: string;
  /** Tick to remove the stored proxy. Explicit, because blank already means "unchanged". */
  proxyRemove: boolean;
}

/**
 * The number a seat starts on, from the server's own table.
 *
 * Empty when that table could not be read, which leaves the field blank and
 * `draftToPatch` refusing it. A blank is honest; a 30 nobody checked is a
 * number this screen invented and then wrote to somebody's account.
 */
const startingLimit = (ranges: OperatorRanges | null, key: OperatorRangeKey): string =>
  ranges ? String(ranges[key].default) : '';

const emptyDraft = (timezone: string, ranges: OperatorRanges | null): AccountDraft => ({
  label: '',
  timezone,
  workingDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  dailyInviteLimit: startingLimit(ranges, 'invite'),
  dailyMessageLimit: startingLimit(ranges, 'message'),
  dailyProfileViewLimit: startingLimit(ranges, 'profileView'),
  dailyFollowLimit: startingLimit(ranges, 'follow'),
  // A new account never opts out of the researched band on the way in: an
  // opt-out made before the account has sent anything is not an informed one.
  safetyBandOverride: false,
  proxyUrl: '',
  proxyRemove: false
});

const draftOf = (account: LinkedInSeat): AccountDraft => ({
  label: account.label,
  timezone: account.timezone,
  workingDays: account.workingDays,
  workStart: minutesToClock(account.workStartMinute),
  workEnd: minutesToClock(account.workEndMinute),
  dailyInviteLimit: String(account.dailyInviteLimit),
  dailyMessageLimit: String(account.dailyMessageLimit),
  dailyProfileViewLimit: String(account.dailyProfileViewLimit),
  dailyFollowLimit: String(account.dailyFollowLimit),
  safetyBandOverride: account.safetyBandOverride,
  // Never prefilled: the stored URL carries a password and the server has no
  // route that returns one.
  proxyUrl: '',
  proxyRemove: false
});

/** Refuses in the operator's words before the server refuses in its own. */
function draftToPatch(draft: AccountDraft, ranges: OperatorRanges | null) {
  const label = draft.label.trim();
  if (!label) throw new Error('Give this account a name you will recognise in a list — “Priya (sales)” beats “account 2”.');

  const timezone = draft.timezone.trim();
  if (!timezone) throw new Error('A timezone decides which 09:00 this account works to. Leave it as this browser’s if you are not sure.');

  const workStartMinute = clockToMinutes(draft.workStart);
  const workEndMinute = clockToMinutes(draft.workEnd);
  if (!Number.isFinite(workStartMinute) || !Number.isFinite(workEndMinute) || workEndMinute <= workStartMinute) {
    throw new Error('Working hours need a start and a later end on the same day.');
  }

  const limits = {} as Record<LimitField, number>;
  for (const limit of LIMIT_FIELDS) {
    const range = ranges?.[limit.range] ?? null;
    const raw = draft[limit.field].trim();
    const value = Number(raw);
    // A blank is not a zero. `Number('')` is 0, and 0 means "turn this off" --
    // saving an untouched blank as an off switch is the one wrong answer here.
    const outOfRange = range ? value < range.min || value > range.max : value < 0;
    if (raw === '' || !Number.isInteger(value) || outOfRange) {
      throw new Error(range
        ? `${limit.label} has to be a whole number between ${range.min} and ${range.max}.`
        : `${limit.label} has to be a whole number of actions a day.`);
    }
    limits[limit.field] = value;
  }

  // ABSENT MEANS UNCHANGED, all the way to the column. Only a typed URL or an
  // explicit removal is sent, so saving the name of an account never disturbs
  // the proxy it routes through.
  const proxyPatch: { proxyUrl?: string | null } = draft.proxyRemove
    ? { proxyUrl: null }
    : draft.proxyUrl.trim()
      ? { proxyUrl: draft.proxyUrl.trim() }
      : {};

  return {
    label,
    timezone,
    workingDays: [...new Set(draft.workingDays)].sort((a, b) => a - b),
    workStartMinute,
    workEndMinute,
    safetyBandOverride: draft.safetyBandOverride,
    ...proxyPatch,
    ...limits
  };
}

/* -------------------------------------------------------------------------
 * The account's own outbound proxy.
 *
 * WHY IT IS ON THIS SCREEN AT ALL. Trevra could always route one account's
 * browser through a proxy, and the only way to say so was an environment
 * variable on the machine running the worker -- which means an operator with a
 * second account on a residential line could not configure it, and a change
 * needed a restart. The proxy is a fact about an account, so it is edited where
 * the account is.
 *
 * WHAT THIS IS NOT: it is not a way to run more accounts than you have people,
 * and it is not the norm. Trevra's whole custody argument is that you drive your
 * own account from your own machine and your own address, which is a better
 * posture than the hosted tools that have to sell you a datacenter IP. Leave it
 * empty unless you genuinely have a second line to route through.
 *
 * AND THE SENTENCE THAT MATTERS MOST IS THE LAST ONE: a proxy Trevra cannot use
 * stops the account. It never quietly connects directly instead, because the
 * whole reason to set one is that this account must not be seen coming from
 * this machine.
 * ---------------------------------------------------------------------- */
function ProxyField({ draft, onChange, idPrefix, proxy }: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  idPrefix: string;
  /** What is stored now, redacted by the server. Null for a new account or one with none. */
  proxy: LinkedInSeat['proxy'] | null;
}) {
  return <>
    <h4 className="li-subhead" aria-level={3}>Outbound connection</h4>
    <p className="li-hint">
      {proxy
        ? <>This account goes out through <b>{proxy.server}</b>{proxy.username ? <> as <b>{proxy.username}</b></> : null}
          {proxy.hasPassword ? ' with a stored password' : ''}. Leave the box empty to keep it.</>
        : <>This account goes out from this machine’s own connection, which is usually what you want. Set a proxy only
          if this account should not be seen coming from here.</>}
    </p>
    <label htmlFor={`${idPrefix}-proxy`}>
      {proxy ? 'Replace the proxy' : 'Proxy'}
      <input
        id={`${idPrefix}-proxy`}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="http://user:password@host:3128"
        value={draft.proxyUrl}
        disabled={draft.proxyRemove}
        onChange={(event) => onChange({ proxyUrl: event.target.value })}
      />
      <small className="li-acct-range">
        http, https or socks5. A socks5 proxy may not carry a password — Chromium cannot answer its challenge.
        The password is stored and never shown again.
      </small>
    </label>
    {proxy && <label className="li-inline-check">
      <input
        type="checkbox"
        checked={draft.proxyRemove}
        onChange={(event) => onChange({ proxyRemove: event.target.checked, proxyUrl: '' })}
      />
      <span>Remove it and go out from this machine’s own connection</span>
    </label>}
    <p className="li-hint">
      If Trevra cannot use the proxy you set, <b>this account stops</b> — its work stays queued and nothing goes out.
      It is never sent directly instead, because that is the one outcome you set a proxy to prevent.
    </p>
  </>;
}

function ScheduleFields({ draft, onChange, idPrefix, safety, bandOverride = false, proxy = null }: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  idPrefix: string;
  /** Ranges, bands and the campaign ramp, all from GET /api/linkedin/limits. */
  safety: LinkedInLimitsReport | null;
  /** Whether to offer the band override. Off for an account that does not exist yet. */
  bandOverride?: boolean;
  /** The stored proxy, redacted by the server. Null for an account that does not exist yet. */
  proxy?: LinkedInSeat['proxy'] | null;
}) {
  const ranges = safety?.operatorRanges ?? null;

  return <>
    <h4 className="li-subhead" aria-level={3}>When this account may act</h4>
    <p className="li-hint">
      Outside these days and hours Trevra refuses every automated action on this account, whatever is queued.
    </p>
    <div className="li-filter-row">
      {DAY_NAMES.map((name, day) => <label className="li-inline-check" key={`${idPrefix}-${name}`}>
        <input
          type="checkbox"
          checked={draft.workingDays.includes(day)}
          onChange={() => onChange({
            workingDays: draft.workingDays.includes(day)
              ? draft.workingDays.filter((value) => value !== day)
              : [...draft.workingDays, day]
          })}
        />
        <span>{name}</span>
      </label>)}
    </div>
    <div className="li-form-grid">
      <label>Starts at<input type="time" value={draft.workStart} onChange={(event) => onChange({ workStart: event.target.value })} /></label>
      <label>Stops at<input type="time" value={draft.workEnd} onChange={(event) => onChange({ workEnd: event.target.value })} /></label>
    </div>

    <h4 className="li-subhead" aria-level={3}>Most this account may do in 24 hours</h4>
    <div className="li-form-grid">
      {LIMIT_FIELDS.map((limit) => {
        const range = ranges?.[limit.range] ?? null;
        /* BOTH NUMBERS BESIDE THE FIELD THAT SETS ONE OF THEM.
           The form accepts 30 invites a day; the check applies
           `min(band, operator)` and lets 18 out. Saying only "0–75" here is how
           an operator came to believe the number they typed was the number
           being used. The band is the server's own, read from the report -- no
           literal, and nothing derived from it. */
        const band: number | undefined = safety?.bands[limit.kind]?.perDay;
        const mine = Number(draft[limit.field].trim());
        const overruled = band !== undefined && Number.isFinite(mine) && mine > band && !draft.safetyBandOverride;
        return <label key={limit.field}>
          {limit.label}
          <input
            type="number"
            step={1}
            min={range?.min}
            max={range?.max}
            value={draft[limit.field]}
            onChange={(event) => onChange({ [limit.field]: event.target.value } as Partial<AccountDraft>)}
          />
          <small className="li-acct-range">
            {range
              ? <>{range.min}–{range.max}{range.min === 0 ? ' · 0 turns it off' : ''}</>
              : <>Trevra could not read the allowed range just now. The server still refuses anything outside it.</>}
            {band !== undefined && <> · Trevra’s researched ceiling {band}</>}
            {limit.pooledKindsLabel && <> · spent by {limit.pooledKindsLabel} together</>}
          </small>
          {overruled && <small className="li-acct-range">
            <b>You set {mine} · {band} will go out</b> — Trevra’s researched ceiling is the lower of the two and it is
            what binds{bandOverride ? '' : ', on this account and on every new one'}.
          </small>}
        </label>;
      })}
    </div>

    {bandOverride && <BandOverrideField draft={draft} onChange={onChange} safety={safety} />}

    <ProxyField draft={draft} onChange={onChange} idPrefix={idPrefix} proxy={proxy} />
  </>;
}

/**
 * The one control on this screen that can make Trevra send MORE than its own
 * research says is safe, so it is written as a decision and not as a switch.
 *
 * The form above lets an operator type 30 invites a day. `LINKEDIN_LIMITS` says
 * 18 for a steady seat, and every ceiling in the subsystem is `min(band,
 * operator)` -- so that 30 has always quietly become 18, with nothing anywhere
 * saying so. That silence is the defect: an operator is entitled to know their
 * number is not the one being used, and entitled to take theirs instead.
 *
 * BOTH NUMBERS, ALWAYS, in both states. Off, it says which one is applying and
 * what the other one is; on, it says the same thing the other way round. Neither
 * sentence is a warning colour, because neither is a mistake -- one is the
 * researched default and the other is an informed choice.
 *
 * WHAT IT CANNOT DO is written last and plainly: it changes WHICH ceiling is
 * ramped, never whether one is. The seat's warm-up week and the per-campaign day
 * ramp both still multiply whatever ceiling ends up binding, and both numbers
 * quoted below come from the server that applies them.
 */
function BandOverrideField({ draft, onChange, safety }: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  safety: LinkedInLimitsReport | null;
}) {
  const on = draft.safetyBandOverride;
  const bands = safety?.bands ?? null;
  const ramp = safety?.campaignWarmupFractions ?? null;

  return <>
    <h4 className="li-subhead" aria-level={3}>Whose daily ceiling binds</h4>
    <p className="li-hint">
      Trevra researched its own safety bands, and they are lower than what this form lets you type. Until you say
      otherwise the lower of the two applies — which is the band, not your number.
    </p>
    <label className="li-inline-check">
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => onChange({ safetyBandOverride: event.target.checked })}
      />
      <span>Use the numbers I set above, including where they are higher than Trevra’s band</span>
    </label>

    {bands
      ? <ul className="li-blockers">
        {LIMIT_FIELDS.map((limit) => {
          const band: number | undefined = bands[limit.kind]?.perDay;
          const mine = Number(draft[limit.field].trim() || Number.NaN);
          if (band === undefined || !Number.isFinite(mine)) return null;
          return <li key={limit.field}>
            <b>{limit.label}:</b>{' '}
            {mine <= band
              ? `your ${mine} a day, under Trevra’s ${band} — yours applies either way.`
              : on
                ? `${mine} a day, yours, instead of Trevra’s researched ${band}.`
                : `you set ${mine} a day, Trevra’s band is ${band}, and ${band} is what applies.`}
          </li>;
        })}
      </ul>
      : <p className="li-hint">Trevra could not read its own bands just now, so this cannot say which of the two numbers is binding.</p>}

    <p className="li-hint">
      Both ramps apply either way, and this lifts neither.{' '}
      {/* `warmupWeek` counts on past the ramp -- it is weeks since this account
          started sending through Trevra, not a position in a list -- so week 12
          of a 4-week ramp is a real answer and "12 of 4" is not a sentence. */}
      {safety
        ? safety.seat.warmupWeek > safety.seat.warmupWeeks
          ? `This account has finished its ${safety.seat.warmupWeeks}-week warm-up.`
          : `This account is on week ${safety.seat.warmupWeek} of its ${safety.seat.warmupWeeks}-week warm-up, and takes only part of its ceiling until that finishes.`
        : 'The per-account warm-up still applies.'}{' '}
      Every campaign then starts at{' '}
      {ramp && ramp.length > 0
        ? ramp.map((fraction) => `${Math.round(fraction * 100)}%`).join(', then ')
        : 'a fraction'}{' '}
      of whichever ceiling is binding. A different ceiling, never no ceiling.
    </p>
  </>;
}

/* -------------------------------------------------------------------------
 * Adding one.
 * ---------------------------------------------------------------------- */

function AddAccountForm({ existingKeys, safety, onCreated, onCancel, firstOne = false }: {
  existingKeys: string[];
  safety: LinkedInLimitsReport | null;
  onCreated: (account: LinkedInSeat) => void;
  onCancel: (() => void) | null;
  firstOne?: boolean;
}) {
  const ranges = safety?.operatorRanges ?? null;
  const [draft, setDraft] = useState<AccountDraft>(() => emptyDraft(BROWSER_TIMEZONE, ranges));
  const [key, setKey] = useState(existingKeys.length === 0 ? OWNER_ACCOUNT_KEY : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [wall, setWall] = useState('');

  // The starting numbers are the server's, and this form can open before the
  // read that carries them has landed. Only the fields nobody has touched yet
  // are filled in: a draft somebody is typing into is not overwritten by a
  // late response.
  useEffect(() => {
    if (!ranges) return;
    setDraft((current) => ({
      ...current,
      dailyInviteLimit: current.dailyInviteLimit || startingLimit(ranges, 'invite'),
      dailyMessageLimit: current.dailyMessageLimit || startingLimit(ranges, 'message'),
      dailyProfileViewLimit: current.dailyProfileViewLimit || startingLimit(ranges, 'profileView'),
      dailyFollowLimit: current.dailyFollowLimit || startingLimit(ranges, 'follow')
    }));
  }, [ranges]);

  const change = (patch: Partial<AccountDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setBusy(true);
    setFailure('');
    setWall('');
    try {
      const trimmedKey = key.trim();
      if (!ACCOUNT_KEY_PATTERN.test(trimmedKey)) {
        throw new Error('A short key is letters, numbers, dashes and underscores, starting with a letter or a number — no spaces, up to 64 characters.');
      }
      if (existingKeys.includes(trimmedKey)) {
        throw new Error('You already have an account with that key. Pick another — the key is how every queue, inbox and export tells them apart.');
      }
      const patch = draftToPatch(draft, ranges);
      onCreated(await createLinkedInManagerSeat({ seatKey: trimmedKey, ...patch }));
    } catch (error) {
      const message = errorMessage(error, 'Unable to add this account');
      if (isWall(error)) setWall(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * A REAL FORM, BECAUSE THE CONSTRAINTS ON THESE FIELDS ARE REAL.
   *
   * `pattern` on the short key and `min`/`max` on the four numbers do nothing
   * at all outside a form element -- the browser runs them on submit and there
   * was no submit -- so a `type="button"` handler left every one of them
   * decorative, and the field claiming "letters, numbers, dashes" would happily
   * post a space and wait for a 400. `submit()` still checks the same rules in
   * the operator's own words: the browser has no attribute for "a stop time
   * after the start time", and a sentence beats a bubble for the rules it does
   * have. Enter now submits, which is what a form of eight fields should do.
   */
  return <form
    className={`li-acct-add${firstOne ? ' is-first' : ''}`}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
  >
    {!firstOne && <h4 className="li-subhead" aria-level={3}>Add a LinkedIn account</h4>}
    <p className="li-hint">
      Each account keeps its own sign-in, its own browser profile, its own hours and its own daily limits. Nothing is
      shared between them, so a wall on one never stops another.
    </p>

    {failure && <div className="error-banner li-acct-error">{failure}</div>}
    {wall && <Wall title="That account could not be added." message={wall} />}

    <div className="li-form-grid">
      <label>Name
        <input
          value={draft.label}
          onChange={(event) => change({ label: event.target.value })}
          placeholder="Priya (sales)"
          autoComplete="off"
        />
        <small className="li-acct-range">What you will see in the switcher and on every queue.</small>
      </label>
      <label>Short key
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="priya"
          autoComplete="off"
          spellCheck={false}
          pattern={ACCOUNT_KEY_PATTERN.source}
          title="Letters, numbers, dashes and underscores, starting with a letter or a number. No spaces, up to 64 characters."
        />
        <small className="li-acct-range">Letters, numbers, dashes, underscores. Permanent — it is how exports and queues name this account.</small>
      </label>
      <TimezoneField
        className="li-span-2"
        value={draft.timezone}
        onChange={(timezone) => change({ timezone })}
        hint="Taken from this browser. Change it if this account is worked from somewhere else."
      />
    </div>

    <ScheduleFields draft={draft} onChange={change} idPrefix="add" safety={safety} />

    <div className="panel-footer">
      <span>Adding an account stores nothing on LinkedIn. You connect it in the next step.</span>
      <div className="li-acct-form-actions">
        {onCancel && <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add account
        </button>
      </div>
    </div>
  </form>;
}

/* -------------------------------------------------------------------------
 * Changing one.
 * ---------------------------------------------------------------------- */

function EditAccountForm({ account, safety, setToast, onSaved }: {
  account: LinkedInSeat;
  safety: LinkedInLimitsReport | null;
  setToast: (message: string) => void;
  onSaved: () => Promise<void>;
}) {
  const ranges = safety?.operatorRanges ?? null;
  const [draft, setDraft] = useState<AccountDraft>(() => draftOf(account));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [wall, setWall] = useState('');

  // The server is the record. A save elsewhere, or a read from the live
  // session, must not lose to a form somebody opened and left.
  useEffect(() => { setDraft(draftOf(account)); }, [account]);

  const change = (patch: Partial<AccountDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setBusy(true);
    setFailure('');
    setWall('');
    try {
      await updateLinkedInManagerSeat(account.seatKey, draftToPatch(draft, ranges));
      setToast(`${draft.label.trim() || account.label} saved. New limits apply to what is scheduled from now on.`);
      await onSaved();
    } catch (error) {
      const message = errorMessage(error, 'Unable to save this account');
      if (isWall(error)) setWall(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  return <details className="li-manual-fields li-acct-manage">
    <summary><Settings2 size={13} /> Change name, hours and limits</summary>

    {/* A form, for the same reason the add form is one: `min` and `max` on the
        four number fields are enforced by the browser on submit or not at all. */}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {failure && <div className="error-banner li-acct-error">{failure}</div>}
      {wall && <Wall title="That change was refused." message={wall} />}

      <div className="li-form-grid">
        <label>Name<input value={draft.label} onChange={(event) => change({ label: event.target.value })} /></label>
        <TimezoneField value={draft.timezone} onChange={(timezone) => change({ timezone })} />
      </div>

      <ScheduleFields
        draft={draft}
        onChange={change}
        idPrefix={`edit-${account.seatKey}`}
        safety={safety}
        bandOverride
        proxy={account.proxy}
      />

      <div className="panel-footer">
        <span>The short key <code>{account.seatKey}</code> cannot change — queues, exports and inboxes are filed under it.</span>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save changes
        </button>
      </div>
    </form>
  </details>;
}
