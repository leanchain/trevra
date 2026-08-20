import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, Settings2 } from 'lucide-react';
import {
  ApiError,
  createLinkedInManagerSeat,
  updateLinkedInManagerSeat,
  updateLinkedInSeatCapabilities,
  type LinkedInLimitsReport,
  type LinkedInSeat,
  type LinkedInSeatResponse,
  type PacedKind
} from './api';
import { OWNER_ACCOUNT_KEY, slugifyAccountKey } from './LinkedInActiveAccount';
import { Wall } from './LinkedInCompanion';
import { errorMessage } from './LinkedInSafety';

/**
 * Adding a LinkedIn account and changing one: the two forms that write a
 * seat's schedule, ceilings and proxy, plus the vocabulary both of them and
 * the read-only screen in `LinkedInAccounts.tsx` share.
 */

/**
 * The server's own rule for an account key (`linkedinSeatKeySchema` in
 * app.ts), restated so the field can refuse before the request is made.
 * A form that only learns the rule from a 400 is a form that taught nothing.
 */
export const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/* -------------------------------------------------------------------------
 * The vocabulary and the arithmetic, in one place.
 * ---------------------------------------------------------------------- */

/** JS weekday numbers, Sunday = 0, which is what the server stores. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

type LimitField =
  'dailyInviteLimit' | 'dailyMessageLimit' | 'dailyProfileViewLimit' | 'dailyFollowLimit';

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
export const LIMIT_FIELDS: ReadonlyArray<{
  field: LimitField;
  kind: PacedKind;
  kinds: readonly PacedKind[];
  range: OperatorRangeKey;
  label: string;
  column: string;
  /** The operator's own words for a pooled ceiling. Absent when the label already names the only kind. */
  pooledKindsLabel?: string;
}> = [
  {
    field: 'dailyInviteLimit',
    kind: 'invite',
    kinds: ['invite', 'company_invite_follow', 'event_invite', 'group_invite'],
    range: 'invite',
    label: 'Connection invites',
    column: 'Invites'
  },
  {
    field: 'dailyMessageLimit',
    kind: 'dm',
    kinds: ['dm', 'reply', 'inmail', 'group_message', 'event_message'],
    range: 'message',
    label: 'Messages',
    column: 'Messages',
    pooledKindsLabel: 'new messages, replies, InMail, group messages and event messages'
  },
  {
    field: 'dailyProfileViewLimit',
    kind: 'profile_view',
    kinds: ['profile_view'],
    range: 'profileView',
    label: 'Profile views',
    column: 'Profile views'
  },
  {
    field: 'dailyFollowLimit',
    kind: 'follow',
    kinds: ['follow', 'unfollow', 'disconnect', 'company_follow'],
    range: 'follow',
    label: 'Relationship changes',
    column: 'Follow / cleanup'
  }
];

type LimitSpec = (typeof LIMIT_FIELDS)[number];

/**
 * What this ceiling has been spent by in the last 24 hours: the sum of every
 * kind it pools, which for messages is three of them.
 *
 * `undefined` when there are no counts at all, and it stays an em dash on
 * screen. A count nobody has is never rendered as a zero.
 */
export function usedToday(
  limit: LimitSpec,
  detail: LinkedInSeatResponse | null
): number | undefined {
  const today = detail?.today;
  if (!today) return undefined;
  return limit.kinds.reduce((total, kind) => total + (today[kind] ?? 0), 0);
}

export const minutesToClock = (minutes: number) =>
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
export function describeDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'No days';
  if (sorted.length === 7) return 'Every day';
  if (sorted.join() === '1,2,3,4,5') return 'Mon–Fri';
  return sorted.map((day) => DAY_NAMES[day]).join(', ');
}

/* -------------------------------------------------------------------------
 * Timezones, offered rather than guessed.
 * ---------------------------------------------------------------------- */

export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
export function TimezoneOptions() {
  return (
    <datalist id={TIMEZONE_LIST_ID}>
      {TIMEZONE_OPTIONS.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

function TimezoneField({
  value,
  onChange,
  className,
  hint
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  hint?: string;
}) {
  return (
    <label className={className}>
      Timezone
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Europe/Zurich"
        list={TIMEZONE_LIST_ID}
        spellCheck={false}
        autoComplete="off"
      />
      {hint && <small className="li-acct-range">{hint}</small>}
    </label>
  );
}

/**
 * A 409 is a wall, not a fault: the server's sentence names the one thing to
 * go and do, so it is shown verbatim and in the instruction colour rather than
 * rewritten in red.
 */
export const isWall = (error: unknown) => error instanceof ApiError && error.status === 409;

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
  if (!label)
    throw new Error(
      'Give this account a name you will recognise in a list — “Priya (sales)” beats “account 2”.'
    );

  const timezone = draft.timezone.trim();
  if (!timezone)
    throw new Error(
      'A timezone decides which 09:00 this account works to. Leave it as this browser’s if you are not sure.'
    );

  const workStartMinute = clockToMinutes(draft.workStart);
  const workEndMinute = clockToMinutes(draft.workEnd);
  if (
    !Number.isFinite(workStartMinute) ||
    !Number.isFinite(workEndMinute) ||
    workEndMinute <= workStartMinute
  ) {
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
      throw new Error(
        range
          ? `${limit.label} has to be a whole number between ${range.min} and ${range.max}.`
          : `${limit.label} has to be a whole number of actions a day.`
      );
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
function ProxyField({
  draft,
  onChange,
  idPrefix,
  proxy
}: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  idPrefix: string;
  /** What is stored now, redacted by the server. Null for a new account or one with none. */
  proxy: LinkedInSeat['proxy'] | null;
}) {
  // Collapsed by default when nothing is set -- the common case -- and open by
  // default when a proxy already routes this account, so the fact that it is
  // configured is not hidden behind a click nobody knows to make.
  const [open, setOpen] = useState(Boolean(proxy));
  return (
    <details
      className="li-manual-fields"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Settings2 size={13} /> Outbound connection
        {proxy && <span> — routed through {proxy.server}</span>}
      </summary>
      <p className="li-hint">
        {proxy ? (
          <>
            This account goes out through <b>{proxy.server}</b>
            {proxy.username ? (
              <>
                {' '}
                as <b>{proxy.username}</b>
              </>
            ) : null}
            {proxy.hasPassword ? ' with a stored password' : ''}. Leave the box empty to keep it.
          </>
        ) : (
          <>
            This account goes out from this machine’s own connection, which is usually what you
            want. Set a proxy only if this account should not be seen coming from here.
          </>
        )}
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
          http, https or socks5. A socks5 proxy may not carry a password — Chromium cannot answer
          its challenge. The password is stored and never shown again.
        </small>
      </label>
      {proxy && (
        <label className="li-inline-check">
          <input
            type="checkbox"
            checked={draft.proxyRemove}
            onChange={(event) => onChange({ proxyRemove: event.target.checked, proxyUrl: '' })}
          />
          <span>Remove it and go out from this machine’s own connection</span>
        </label>
      )}
      <p className="li-hint">
        If Trevra cannot use the proxy you set, <b>this account stops</b> — its work stays queued
        and nothing goes out. It is never sent directly instead, because that is the one outcome you
        set a proxy to prevent.
      </p>
    </details>
  );
}

function ScheduleFields({
  draft,
  onChange,
  idPrefix,
  safety,
  bandOverride = false,
  proxy = null
}: {
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

  return (
    <>
      <h4 className="li-subhead" aria-level={3}>
        When this account may act
      </h4>
      <p className="li-hint">
        Outside these days and hours Trevra refuses every automated action on this account, whatever
        is queued.
      </p>
      <div className="li-filter-row">
        {DAY_NAMES.map((name, day) => (
          <label className="li-inline-check" key={`${idPrefix}-${name}`}>
            <input
              type="checkbox"
              checked={draft.workingDays.includes(day)}
              onChange={() =>
                onChange({
                  workingDays: draft.workingDays.includes(day)
                    ? draft.workingDays.filter((value) => value !== day)
                    : [...draft.workingDays, day]
                })
              }
            />
            <span>{name}</span>
          </label>
        ))}
      </div>
      <div className="li-form-grid">
        <label>
          Starts at
          <input
            type="time"
            value={draft.workStart}
            onChange={(event) => onChange({ workStart: event.target.value })}
          />
        </label>
        <label>
          Stops at
          <input
            type="time"
            value={draft.workEnd}
            onChange={(event) => onChange({ workEnd: event.target.value })}
          />
        </label>
      </div>

      <h4 className="li-subhead" aria-level={3}>
        Most this account may do in 24 hours
      </h4>
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
          const overruled =
            band !== undefined && Number.isFinite(mine) && mine > band && !draft.safetyBandOverride;
          return (
            <label key={limit.field}>
              {limit.label}
              <input
                type="number"
                step={1}
                min={range?.min}
                max={range?.max}
                value={draft[limit.field]}
                onChange={(event) =>
                  onChange({ [limit.field]: event.target.value } as Partial<AccountDraft>)
                }
              />
              <small className="li-acct-range">
                {range ? (
                  <>
                    {range.min}–{range.max}
                    {range.min === 0 ? ' · 0 turns it off' : ''}
                  </>
                ) : (
                  <>
                    Trevra could not read the allowed range just now. The server still refuses
                    anything outside it.
                  </>
                )}
                {band !== undefined && <> · Trevra’s researched ceiling {band}</>}
                {limit.pooledKindsLabel && <> · spent by {limit.pooledKindsLabel} together</>}
              </small>
              {overruled && (
                <small className="li-acct-range">
                  <b>
                    You set {mine} · {band} will go out
                  </b>{' '}
                  — Trevra’s researched ceiling is the lower of the two and it is what binds
                  {bandOverride ? '' : ', on this account and on every new one'}.
                </small>
              )}
            </label>
          );
        })}
      </div>

      {bandOverride && <BandOverrideField draft={draft} onChange={onChange} safety={safety} />}

      <ProxyField draft={draft} onChange={onChange} idPrefix={idPrefix} proxy={proxy} />
    </>
  );
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
function BandOverrideField({
  draft,
  onChange,
  safety
}: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  safety: LinkedInLimitsReport | null;
}) {
  const on = draft.safetyBandOverride;
  const bands = safety?.bands ?? null;
  const ramp = safety?.campaignWarmupFractions ?? null;

  return (
    <>
      <h4 className="li-subhead" aria-level={3}>
        Whose daily ceiling binds
      </h4>
      <p className="li-hint">
        Trevra researched its own safety bands, and they are lower than what this form lets you
        type. Until you say otherwise the lower of the two applies — which is the band, not your
        number.
      </p>
      <label className="li-inline-check">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onChange({ safetyBandOverride: event.target.checked })}
        />
        <span>Use the numbers I set above, including where they are higher than Trevra’s band</span>
      </label>

      {bands ? (
        <ul className="li-blockers">
          {LIMIT_FIELDS.map((limit) => {
            const band: number | undefined = bands[limit.kind]?.perDay;
            const mine = Number(draft[limit.field].trim() || Number.NaN);
            if (band === undefined || !Number.isFinite(mine)) return null;
            return (
              <li key={limit.field}>
                <b>{limit.label}:</b>{' '}
                {mine <= band
                  ? `your ${mine} a day, under Trevra’s ${band} — yours applies either way.`
                  : on
                    ? `${mine} a day, yours, instead of Trevra’s researched ${band}.`
                    : `you set ${mine} a day, Trevra’s band is ${band}, and ${band} is what applies.`}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="li-hint">
          Trevra could not read its own bands just now, so this cannot say which of the two numbers
          is binding.
        </p>
      )}

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
    </>
  );
}

/* -------------------------------------------------------------------------
 * Adding one.
 * ---------------------------------------------------------------------- */

export function AddAccountForm({
  existingKeys,
  safety,
  onCreated,
  onCancel,
  firstOne = false
}: {
  existingKeys: string[];
  safety: LinkedInLimitsReport | null;
  onCreated: (account: LinkedInSeat) => void;
  onCancel: (() => void) | null;
  firstOne?: boolean;
}) {
  const ranges = safety?.operatorRanges ?? null;
  const [draft, setDraft] = useState<AccountDraft>(() => emptyDraft(BROWSER_TIMEZONE, ranges));
  const [key, setKey] = useState(existingKeys.length === 0 ? OWNER_ACCOUNT_KEY : '');
  // The very first account keeps its fixed 'owner' key regardless of what it is
  // named -- that key is a convention other reads lean on, not a name's slug --
  // so it starts already 'touched' and the name never overwrites it.
  const [keyTouched, setKeyTouched] = useState(existingKeys.length === 0);
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

  const change = (patch: Partial<AccountDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setBusy(true);
    setFailure('');
    setWall('');
    try {
      const trimmedKey = key.trim();
      if (!ACCOUNT_KEY_PATTERN.test(trimmedKey)) {
        throw new Error(
          'A short key is letters, numbers, dashes and underscores, starting with a letter or a number — no spaces, up to 64 characters.'
        );
      }
      if (existingKeys.includes(trimmedKey)) {
        throw new Error(
          'You already have an account with that key. Pick another — the key is how every queue, inbox and export tells them apart.'
        );
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
  return (
    <form
      className={`li-acct-add${firstOne ? ' is-first' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!firstOne && (
        <h4 className="li-subhead" aria-level={3}>
          Add a LinkedIn account
        </h4>
      )}
      <p className="li-hint">
        Each account keeps its own sign-in, its own browser profile, its own hours and its own daily
        limits. Nothing is shared between them, so a wall on one never stops another.
      </p>

      {failure && <div className="error-banner li-acct-error">{failure}</div>}
      {wall && <Wall title="That account could not be added." message={wall} />}

      <div className="li-form-grid">
        <label>
          Name
          <input
            value={draft.label}
            onChange={(event) => {
              const label = event.target.value;
              change({ label });
              // Smart default: the key is a mechanical slug of the name until the
              // operator types into the key field directly, at which point their
              // spelling wins for good.
              if (!keyTouched) setKey(slugifyAccountKey(label));
            }}
            placeholder="Priya (sales)"
            autoComplete="off"
          />
          <small className="li-acct-range">
            What you will see in the switcher and on every queue.
          </small>
        </label>
        <label>
          Short key
          <input
            value={key}
            onChange={(event) => {
              setKeyTouched(true);
              setKey(event.target.value);
            }}
            placeholder="priya"
            autoComplete="off"
            spellCheck={false}
            pattern={ACCOUNT_KEY_PATTERN.source}
            title="Letters, numbers, dashes and underscores, starting with a letter or a number. No spaces, up to 64 characters."
          />
          <small className="li-acct-range">
            Filled in from the name above until you edit it. Letters, numbers, dashes, underscores.
            Permanent — it is how exports and queues name this account.
          </small>
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
          {onCancel && (
            <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add account
          </button>
        </div>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------
 * Changing one.
 * ---------------------------------------------------------------------- */

export function EditAccountForm({
  account,
  safety,
  setToast,
  onSaved
}: {
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
  const [capDraft, setCapDraft] = useState(() => ({
    inmail: account.capabilities.inmail,
    premium: account.capabilities.premium,
    salesNavigator: account.capabilities.salesNavigator,
    recruiter: account.capabilities.recruiter,
    monthly: account.inmailMonthlyBudget === null ? '' : String(account.inmailMonthlyBudget),
    paid: account.inmailPaidCreditCap === null ? '' : String(account.inmailPaidCreditCap)
  }));

  // The server is the record. A save elsewhere, or a read from the live
  // session, must not lose to a form somebody opened and left.
  useEffect(() => {
    setDraft(draftOf(account));
    setCapDraft({
      inmail: account.capabilities.inmail,
      premium: account.capabilities.premium,
      salesNavigator: account.capabilities.salesNavigator,
      recruiter: account.capabilities.recruiter,
      monthly: account.inmailMonthlyBudget === null ? '' : String(account.inmailMonthlyBudget),
      paid: account.inmailPaidCreditCap === null ? '' : String(account.inmailPaidCreditCap)
    });
  }, [account]);

  const change = (patch: Partial<AccountDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setBusy(true);
    setFailure('');
    setWall('');
    try {
      await updateLinkedInManagerSeat(account.seatKey, draftToPatch(draft, ranges));
      const monthly = capDraft.monthly.trim() === '' ? null : Number(capDraft.monthly);
      const paid = capDraft.paid.trim() === '' ? null : Number(capDraft.paid);
      if (
        (monthly !== null && !Number.isInteger(monthly)) ||
        (paid !== null && !Number.isInteger(paid))
      )
        throw new Error('InMail budgets must be whole credit counts.');
      await updateLinkedInSeatCapabilities(account.seatKey, {
        inmail: capDraft.inmail,
        premium: capDraft.premium,
        salesNavigator: capDraft.salesNavigator,
        recruiter: capDraft.recruiter,
        inmailMonthlyBudget: monthly,
        inmailPaidCreditCap: paid
      });
      setToast(
        `${draft.label.trim() || account.label} saved. New limits apply to what is scheduled from now on.`
      );
      await onSaved();
    } catch (error) {
      const message = errorMessage(error, 'Unable to save this account');
      if (isWall(error)) setWall(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="li-manual-fields li-acct-manage">
      <summary>
        <Settings2 size={13} /> Account settings
      </summary>

      {/* A form, for the same reason the add form is one: `min` and `max` on the
        four number fields are enforced by the browser on submit or not at all. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {failure && <div className="error-banner li-acct-error">{failure}</div>}
        {wall && <Wall title="That change was refused." message={wall} />}

        <div className="li-form-grid">
          <label>
            Name
            <input
              value={draft.label}
              onChange={(event) => change({ label: event.target.value })}
            />
          </label>
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

        <fieldset className="li-span-2">
          <legend>LinkedIn license and InMail capability</legend>
          <p className="li-hint">
            Mark only capabilities this account actually has. Campaign setup uses these flags to
            keep unsupported senders out of InMail workflows.
          </p>
          <div className="li-form-grid">
            <label>
              InMail availability
              <select
                value={capDraft.inmail}
                onChange={(event) =>
                  setCapDraft((current) => ({
                    ...current,
                    inmail: event.target.value as typeof current.inmail
                  }))
                }
              >
                <option value="unknown">Unknown / not checked</option>
                <option value="available">Available</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </label>
            <label>
              Monthly InMail budget
              <input
                type="number"
                min={0}
                max={10000}
                value={capDraft.monthly}
                placeholder="Use researched ceiling"
                onChange={(event) =>
                  setCapDraft((current) => ({ ...current, monthly: event.target.value }))
                }
              />
            </label>
            <label>
              Paid-credit cap
              <input
                type="number"
                min={0}
                max={10000}
                value={capDraft.paid}
                placeholder="No paid credits"
                onChange={(event) =>
                  setCapDraft((current) => ({ ...current, paid: event.target.value }))
                }
              />
            </label>
            <label className="li-check-row">
              <input
                type="checkbox"
                checked={capDraft.premium}
                onChange={(event) =>
                  setCapDraft((current) => ({ ...current, premium: event.target.checked }))
                }
              />{' '}
              LinkedIn Premium
            </label>
            <label className="li-check-row">
              <input
                type="checkbox"
                checked={capDraft.salesNavigator}
                onChange={(event) =>
                  setCapDraft((current) => ({ ...current, salesNavigator: event.target.checked }))
                }
              />{' '}
              Sales Navigator
            </label>
            <label className="li-check-row">
              <input
                type="checkbox"
                checked={capDraft.recruiter}
                onChange={(event) =>
                  setCapDraft((current) => ({ ...current, recruiter: event.target.checked }))
                }
              />{' '}
              Recruiter
            </label>
          </div>
        </fieldset>

        <div className="panel-footer">
          <span>
            The short key <code>{account.seatKey}</code> cannot change — queues, exports and inboxes
            are filed under it.
          </span>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Save changes
          </button>
        </div>
      </form>
    </details>
  );
}
