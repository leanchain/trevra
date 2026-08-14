import { createHash } from 'node:crypto';
import {
  SELECTORS,
  normalisedProfileUrl,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInPage
} from './driver.js';

/**
 * The Playwright routines for the unified inbox: walk the conversation list,
 * read one conversation, send one reply.
 *
 * THE SAME RULES AS `driver.ts`, WHICH IS WHY ITS TYPES ARE IMPORTED RATHER
 * THAN RESTATED. This file is the second and last place in Trevra that touches
 * a LinkedIn page, it is reachable only from the self-hosted local worker
 * path, and it obeys the identical contract:
 *
 *   * NOTHING HERE THROWS. Every path returns a result, because a routine that
 *     throws aborts a run at an unknown point -- the one outcome the ledger
 *     cannot describe.
 *   * THE SAME SIX FAILURE KINDS, with the same meanings. `limit_wall` and
 *     `challenge` mean LinkedIn is telling us to stop and the caller must stop;
 *     `selector_drift` means nothing was clicked; `unknown` means we clicked
 *     and lost track.
 *   * THE SAME HOST CHECK. This driver navigates an authenticated browser, so
 *     every URL it opens is either built here from a validated fragment or
 *     checked against ALLOWED_HOSTS before it is trusted.
 *
 * A FEW CONSTANTS ARE COPIED FROM `driver.ts` RATHER THAN IMPORTED, because
 * that module keeps them private. This is the same trade `local-worker.ts`
 * documents where it copies `seededRandom` out of `pacing.ts`: reaching into
 * another module's internals -- or widening its exported surface for a
 * convenience -- is a worse deal than a few lines that are visibly identical.
 * They must stay identical; a reviewer changing one changes both.
 *
 * READING IS NOT SENDING, AND ONLY ONE ROUTINE HERE SENDS ANYTHING.
 * `listConversations` and `readThread` write nothing to LinkedIn and consume no
 * pacing budget. `sendReply` puts bytes in front of a stranger, and it is
 * therefore never called except as the execution of a ledger row that has
 * already passed `evaluateLinkedInSafety` -- see the module header of
 * `inbox.ts` for how that is enforced on the way in.
 */

/* -------------------------------------------------------------------------
 * Copied from driver.ts. Keep byte-identical.
 * ---------------------------------------------------------------------- */

/** Where a checkpoint lands. URL-level, so it is caught before any selector is read. */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

/** LinkedIn hosts this driver may navigate to. Nothing else, ever. */
const ALLOWED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/** Long enough for LinkedIn's client-side render, short enough not to stall a run. */
const SETTLE_MS = 1_500;

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

/* -------------------------------------------------------------------------
 * Where the inbox lives, and how a conversation is named.
 * ---------------------------------------------------------------------- */

/** The messaging rail. Trailing slash included: every thread URL is built from it. */
export const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

/**
 * The shape of a conversation id as LinkedIn puts it in the URL
 * (`2-NTk3...==`). Validated rather than trusted for exactly the reason
 * `profileUrlFor` validates a target: this string comes back from a database
 * row or an HTTP body and is then pasted into a URL an authenticated browser
 * opens.
 */
const THREAD_URN = /^[A-Za-z0-9=_%.+-]{1,200}$/;

/** The canonical URL for a conversation, or null when the URN is not one. */
export function threadUrlFor(threadUrn: string): string | null {
  const trimmed = threadUrn.trim();
  if (!trimmed || !THREAD_URN.test(trimmed)) return null;
  return `${MESSAGING_URL}thread/${encodeURIComponent(trimmed)}/`;
}

/**
 * The conversation id in a messaging URL, or null when there is not one.
 *
 * The host is re-checked here even though the browser is ours: `page.url()`
 * after a click is whatever LinkedIn decided to navigate to, and a redirect
 * off-site must not come back as a thread id we then store and re-open.
 */
export function threadUrnFrom(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = /^\/messaging\/thread\/([^/]+)\/*$/.exec(parsed.pathname);
  if (!match) return null;
  let urn = match[1];
  try {
    urn = decodeURIComponent(urn);
  } catch {
    // A malformed escape is the browser's own string. Passed through as-is
    // rather than repaired into something LinkedIn never said.
  }
  return THREAD_URN.test(urn) ? urn : null;
}

/* -------------------------------------------------------------------------
 * The selectors.
 * ---------------------------------------------------------------------- */

/**
 * EVERY INBOX SELECTOR, IN ONE TABLE, for the reasons `SELECTORS` in driver.ts
 * gives at length: LinkedIn re-labels this markup, drift is the expected steady
 * state, a miss is `selector_drift` and never "it failed", and repairing drift
 * has to be one readable diff.
 *
 * Composition selectors are reused from `SELECTORS` rather than duplicated --
 * the composer and the send button in a thread are the same two controls
 * `sendDm` already drives.
 */
export const INBOX_SELECTORS = {
  /** The conversation rail. Its presence is how "empty inbox" is told from "drift". */
  conversationList: 'ul.msg-conversations-container__conversations-list',
  conversationRow: 'ul.msg-conversations-container__conversations-list > li',
  /** The clickable row. Clicking it is what puts the thread URN in the URL. */
  rowLink: 'a.msg-conversation-listitem__link',
  rowName: '.msg-conversation-listitem__participant-names',
  rowSnippet: '.msg-conversation-card__message-snippet',
  rowTimestamp: 'time.msg-conversation-listitem__time-stamp, .msg-conversation-listitem__time-stamp',
  rowUnreadBadge: '.notification-badge--show, .msg-conversation-card__unread-count',
  /**
   * The participant's name in the open thread, which is also a link to their
   * profile. Read for the name and CLICKED for the profile URL -- the rail
   * publishes no href this driver can read.
   */
  threadProfileLink: 'a.msg-thread__link-to-profile, .msg-entity-lockup a[href*="/in/"], .msg-title-bar a[href*="/in/"]',
  messageList: 'ul.msg-s-message-list-content',
  /**
   * THE MESSAGE BUBBLE INSIDE ONE `<li>`. Read only to tell "this item is a
   * message" from "this item is a date separator, a system notice, or drift".
   */
  messageItem: '.msg-s-event-listitem',
  /**
   * THE MODIFIER THE OTHER PARTICIPANT'S MESSAGE CARRIES, exactly as its name
   * says, and it sits on the bubble INSIDE the `<li>` rather than on the item.
   *
   * THAT DISTINCTION IS THE BUG THIS TABLE USED TO CARRY. Scoped with no
   * separator the selector reads `li:nth-child(3).msg-s-event-listitem--other`,
   * which matches nothing on any page LinkedIn has ever served, so `present`
   * answered false for every message and DIRECTION BECAME A CONSTANT --
   * whichever way the two branches were wired. The stored transcripts of
   * 2026-08-13 are the evidence: nine conversations, several of them plainly
   * answered by the other person, and not one inbound row in the database.
   *
   * That silent constant is also what the flip of 2026-08-14 mis-read as
   * "`--other` marks the operator's own message". It does not; the selector
   * simply never matched, and a class name is not evidence of the reverse of
   * itself. Matched as item-or-descendant below, so a future move of the class
   * onto the `<li>` cannot re-open this hole.
   */
  messageInboundMarker: '.msg-s-event-listitem--other',
  messageBody: '.msg-s-event-listitem__body',
  messageTimestamp: 'time.msg-s-message-group__timestamp, .msg-s-message-group__timestamp'
} as const;

/**
 * Scope a selector list to one row or one message item.
 *
 * NOT string concatenation, and the difference is a real bug. A selector like
 * `.a, .b` is a LIST, so `li:nth-child(3) .a, .b` means "(.a inside row 3) or
 * (.b ANYWHERE ON THE PAGE)" -- which is how one conversation's unread badge
 * ends up reported for another. Every part gets the prefix.
 *
 * `join` is ' ' for a descendant and '' for a class on the element itself.
 */
function scoped(prefix: string, selector: string, join: ' ' | '' = ' '): string {
  return selector
    .split(',')
    .map((part) => `${prefix}${join}${part.trim()}`)
    .join(', ');
}

/**
 * The nth conversation row, 0-based.
 *
 * `:nth-child` rather than a locator index because the driver's page interface
 * is deliberately tiny -- count/first/click/fill/textContent, no `nth`, no
 * attribute read -- and widening it would mean editing `driver.ts`, whose whole
 * point is to declare the smallest slice of Playwright that works with the
 * package absent (it is an optional dependency). CSS can already express
 * "row 3", so CSS does it.
 */
function rowSelector(index: number, suffix?: string, join: ' ' | '' = ' '): string {
  const row = `${INBOX_SELECTORS.conversationList} > li:nth-child(${index + 1})`;
  return suffix ? scoped(row, suffix, join) : row;
}
function messageSelector(index: number, suffix?: string, join: ' ' | '' = ' '): string {
  const item = `${INBOX_SELECTORS.messageList} > li:nth-child(${index + 1})`;
  return suffix ? scoped(item, suffix, join) : item;
}

/**
 * A class on the nth message item OR on anything inside it.
 *
 * Both forms, because which of the two LinkedIn uses is exactly the fact this
 * driver got wrong: the modifier lives on the bubble today and the item is
 * where the class name reads as though it would live. Asking for one and
 * silently answering "no" for the other is how a direction became a constant.
 */
function messageMarkerSelector(index: number, marker: string): string {
  return `${messageSelector(index, marker, '')}, ${messageSelector(index, marker, ' ')}`;
}

/* -------------------------------------------------------------------------
 * Page reads. Same helpers, same failure semantics, as driver.ts.
 * ---------------------------------------------------------------------- */

async function countOf(page: LinkedInPage, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  return (await countOf(page, selector)) > 0;
}

/** The first match's collapsed text. Null for absent, empty, or unreadable. */
async function textOf(page: LinkedInPage, selector: string): Promise<string | null> {
  try {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) return null;
    const text = await locator.first().textContent({ timeout: CLICK_TIMEOUT_MS });
    const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
    return collapsed || null;
  } catch {
    return null;
  }
}

/**
 * The three "stop now" reads, done BEFORE anything is clicked, in the same
 * order and for the same reason `detectWall` uses in driver.ts: a challenge
 * outranks a limit wall outranks a missing page, because a checkpoint can also
 * render the words "invitation limit" and the human-intervention case must win.
 */
async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
  if (await present(page, SELECTORS.profileUnavailable)) return 'not_found';
  return null;
}

function wallDetail(wall: LinkedInFailureKind, where: string): string {
  if (wall === 'challenge') {
    return `LinkedIn is showing a challenge at ${where}. A human has to clear it in the profile window; nothing else will.`;
  }
  if (wall === 'limit_wall') {
    return `LinkedIn answered ${where} with a limit or restriction notice. This is LinkedIn asking us to stop, so nothing further was read.`;
  }
  return `${where} does not resolve to a page this driver can read, which is what a signed-out session also looks like.`;
}

/* -------------------------------------------------------------------------
 * Pacing the walk.
 * ---------------------------------------------------------------------- */

/**
 * Seconds between two navigations inside one inbox run.
 *
 * DELIBERATELY NOT `ACTION_GAP_SECONDS`. That window (30-120s, limits.ts) is
 * the reported gap between two LEDGER ACTIONS -- invites and DMs, the things
 * LinkedIn counts and bans for. Reading your own conversations writes nothing,
 * consumes no budget and is not an action in any of those tables, so pacing it
 * at 30-120s would make a ten-conversation sync take half an hour and buy
 * nothing.
 *
 * THESE TWO NUMBERS ARE OURS AND ARE MARKED AS SUCH, in the manner limits.ts
 * marks `MIN_RAMP_STEP`: nothing published or reported covers "how fast may a
 * person read their own inbox", and giving a guess a research tag would launder
 * it into a fact. They sit deliberately slower than a human clicking quickly
 * and far faster than the action gap, which is the range the honest answer
 * lives in. What actually bounds the risk is that the walk is CAPPED
 * (DEFAULT_MAX_THREADS) -- a bound is a guarantee, a delay is a hope.
 */
export const READ_GAP_SECONDS = { min: 2, max: 7 };

/** The conversations one run will walk, and the ceiling an option may raise it to. */
export const DEFAULT_MAX_THREADS = 10;
const MAX_THREADS_CEILING = 50;
/** The messages one run will read from a single conversation, newest first. */
export const DEFAULT_MAX_MESSAGES = 40;
const MAX_MESSAGES_CEILING = 200;

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * mulberry32, seeded from a hash of the run and the step.
 *
 * The same generator, copied for the same stated reason, as `local-worker.ts`
 * and `pacing.ts`: identical inputs must produce identical timing on every
 * machine and every Node version. `Math.random()` guarantees the opposite and
 * appears nowhere in this subsystem.
 */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Seconds to wait before the next navigation, drawn from READ_GAP_SECONDS.
 *
 * Randomised here means UNPREDICTABLE TO LINKEDIN, not unreproducible to us:
 * the sequence has no pattern a rate limiter could key on, and re-running the
 * same walk produces the same gaps, so a test asserts the delays instead of
 * tolerating them.
 */
export function readGapSeconds(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  const random = seededRandom(digest);
  return READ_GAP_SECONDS.min + random() * (READ_GAP_SECONDS.max - READ_GAP_SECONDS.min);
}

export interface InboxWalkOptions {
  /** Conversations to walk. Capped at 50 however high this is set. */
  maxThreads?: number;
  /** Messages to read from one conversation, taken from the NEWEST end. Capped at 200. */
  maxMessages?: number;
  /**
   * The jitter seed. Callers pass something per-run (a batch id) so two runs do
   * not share a delay pattern.
   *
   * The default is a CONSTANT on purpose: an omitted seed produces a
   * reproducible walk rather than a secretly random one, so the omission shows
   * up in a test as a fixed sequence instead of hiding as noise.
   */
  seed?: string;
  /** Defaults to a real timer. Injected so a test can assert the gaps. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to the real clock. Only ever used to resolve rendered timestamps. */
  now?: () => Date;
  /**
   * Whether this conversation still needs its participant's profile URL
   * resolved, which costs one extra navigation each.
   *
   * The caller knows and the driver cannot: a thread whose `profile_url` is
   * already stored never needs the hop again. Defaults to "yes, every one",
   * because a linkage that silently does not happen is worse than a slow walk.
   */
  needsProfileUrl?: (threadUrn: string) => boolean;
}

interface Walk {
  seed: string;
  sleep: (ms: number) => Promise<void>;
  navigations: number;
}

function walkOf(options: InboxWalkOptions): Walk {
  return { seed: options.seed ?? 'linkedin-inbox', sleep: options.sleep ?? defaultSleep, navigations: 0 };
}

function bounded(value: number, ceiling: number): number {
  return Math.max(1, Math.min(Math.trunc(value), ceiling));
}

/**
 * Wait out the gap before a navigation. Skipped for the first one, exactly as
 * `runLinkedInLocalBatch` skips the gap before its first action: the delay is
 * between two page loads, and there is nothing before the first.
 */
async function pace(walk: Walk, step: string): Promise<void> {
  if (walk.navigations > 0) {
    await walk.sleep(Math.round(readGapSeconds(`${walk.seed}:${walk.navigations}:${step}`) * 1000));
  }
  walk.navigations += 1;
}

/** Navigate and read the walls. Returns the failure to report, or null. */
async function openUrl(page: LinkedInPage, walk: Walk, url: string): Promise<LinkedInDriverResult | null> {
  await pace(walk, url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    // Navigation failed, so nothing was read and nothing was clicked.
    return fail('selector_drift', `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const wall = await detectWall(page);
  return wall ? fail(wall, wallDetail(wall, url)) : null;
}

/* -------------------------------------------------------------------------
 * Rendered timestamps.
 * ---------------------------------------------------------------------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function startOfUtcDay(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * A LinkedIn conversation timestamp, as an ISO-8601 instant, or null.
 *
 * LinkedIn renders these as display text -- "10:42 AM", "Tue", "Aug 3" -- and
 * publishes no machine-readable instant this driver can read, so this is a
 * PARSE OF A HUMAN STRING and it is treated as one:
 *
 *   * Anything it does not recognise returns NULL. It never guesses, never
 *     falls back to "now", and never invents a year.
 *   * Everything is resolved in UTC against `now`. The rendered value is in
 *     the browser's own locale and zone, which this process does not know, so
 *     the result is accurate to the day and is documented as such in migration
 *     031 -- it orders a screen and NOTHING SAFETY-CRITICAL MAY READ IT. Every
 *     ceiling in this subsystem reads `linkedin_actions.recorded_at`.
 */
export function parseInboxTimestamp(text: string | null, now: Date): string | null {
  if (!text) return null;
  const value = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!value) return null;

  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(value);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (minute > 59) return null;
    if (clock[3]) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (clock[3] === 'pm' ? 12 : 0);
    } else if (hour > 23) {
      return null;
    }
    return isoAt(startOfUtcDay(now) + hour * 3_600_000 + minute * 60_000);
  }

  if (value === 'today') return isoAt(startOfUtcDay(now));
  if (value === 'yesterday') return isoAt(startOfUtcDay(now) - 86_400_000);

  if (/^[a-z]{3,9}$/.test(value)) {
    const weekday = WEEKDAYS.findIndex((day) => value.startsWith(day));
    if (weekday >= 0) {
      // The most recent such weekday, today included. A conversation rail only
      // renders a weekday name inside the last seven days.
      const back = (now.getUTCDay() - weekday + 7) % 7;
      return isoAt(startOfUtcDay(now) - back * 86_400_000);
    }
    return null;
  }

  const monthFirst = /^([a-z]{3,9}) (\d{1,2})(?:,? (\d{4}))?$/.exec(value);
  const dayFirst = /^(\d{1,2}) ([a-z]{3,9})(?:,? (\d{4}))?$/.exec(value);
  const parts = monthFirst
    ? { month: monthFirst[1], day: Number(monthFirst[2]), year: monthFirst[3] }
    : dayFirst
      ? { month: dayFirst[2], day: Number(dayFirst[1]), year: dayFirst[3] }
      : null;
  if (!parts) return null;

  const month = MONTHS.findIndex((name) => parts.month.startsWith(name));
  if (month < 0 || parts.day < 1 || parts.day > 31) return null;
  if (parts.year) return isoAt(Date.UTC(Number(parts.year), month, parts.day));

  // No year rendered means "this one", unless that would be in the future --
  // LinkedIn drops the year for dates inside the last twelve months.
  const thisYear = Date.UTC(now.getUTCFullYear(), month, parts.day);
  return isoAt(thisYear > now.getTime() ? Date.UTC(now.getUTCFullYear() - 1, month, parts.day) : thisYear);
}

/* -------------------------------------------------------------------------
 * What the routines return.
 * ---------------------------------------------------------------------- */

export interface LinkedInThreadSummary {
  /** LinkedIn's conversation id. The stable identity of the thread. */
  threadUrn: string;
  /** Canonical, in the form `profileUrlFor` produces, or null when it could not be resolved. */
  profileUrl: string | null;
  name: string | null;
  /** ISO-8601, or null when the rendered text did not resolve. Never a guess. */
  lastMessageAt: string | null;
  snippet: string;
  unread: boolean;
}

export interface LinkedInInboxMessage {
  /** ISO-8601, or null. See `parseInboxTimestamp`. */
  at: string | null;
  direction: 'in' | 'out';
  body: string;
}

/**
 * A partial read is a SUCCESS, carrying `degraded` -- the same shape and the
 * same reasoning as `LinkedInSeatRead`: a conversation whose profile URL could
 * not be resolved is a partial answer, and reporting the whole walk as a
 * failure would throw away the nine that worked.
 */
export interface LinkedInThreadListing {
  ok: true;
  threads: LinkedInThreadSummary[];
  degraded: string[];
}

export interface LinkedInThreadTranscript {
  ok: true;
  threadUrn: string;
  messages: LinkedInInboxMessage[];
  degraded: string[];
}

/** Narrow a listing answer. A read carries no `failureKind`; a failure always does. */
export function isThreadListing(value: LinkedInThreadListing | LinkedInDriverResult): value is LinkedInThreadListing {
  return !('failureKind' in value);
}

export function isThreadTranscript(value: LinkedInThreadTranscript | LinkedInDriverResult): value is LinkedInThreadTranscript {
  return !('failureKind' in value);
}

/** The rail text for one row, read before anything is clicked. */
interface RailRow {
  name: string | null;
  snippet: string;
  stamp: string | null;
  unread: boolean;
}

/** Rail names are truncated; a prefix match either way is the same person. */
/**
 * A name with LinkedIn's own screen-reader text cut off the end of it.
 *
 * BOTH PLACES A NAME IS READ RETURN MORE THAN A NAME. `textContent` collapses
 * everything inside an element, and LinkedIn renders the presence state --
 * and, in the thread header, the person's headline -- inside the same lockup
 * as the name. That is how conversations came to be stored, and shown to an
 * operator, as "Daryna Radiichuk Status is offline CEO at G-MOS.com | ...".
 *
 * THE CUT IS MADE AT LINKEDIN'S OWN PRESENCE PHRASE AND NOWHERE ELSE. A name
 * that does not carry one comes back byte for byte, and a cut that would leave
 * nothing behind is refused rather than filed as a nameless conversation --
 * this trims rendered decoration, it never invents a name.
 */
const PRESENCE_TEXT = /\s*\bstatus\b\s*(?:is|ist|:)\s.*$/i;

function displayName(text: string | null): string | null {
  if (text === null) return null;
  const cut = text.replace(PRESENCE_TEXT, '').trim();
  return cut || text;
}

/** Rail names are truncated; a prefix match either way is the same person. */
function sameName(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Walk the conversation rail.
 *
 * TWO PASSES, AND THE ORDER MATTERS. Pass one reads every row's text with ZERO
 * navigation, because the rail re-orders the moment a new message arrives and
 * reading nine rows across nine page loads would pair one conversation's
 * snippet with another's name. Pass two opens each row for the two facts the
 * rail does not publish as text -- the conversation id, which only appears in
 * the URL, and the participant's profile URL, which requires opening their
 * profile because this driver cannot read an href.
 *
 * The pairing is then VERIFIED rather than assumed: the name in the opened
 * thread is compared with the name in the row that was clicked, and a mismatch
 * drops that entry with a note instead of filing one person's reply under
 * another person's name.
 *
 * BOUNDED AND JITTERED. `maxThreads` caps the run whatever the inbox holds, and
 * every navigation waits out a seeded gap (READ_GAP_SECONDS) so a walk is not a
 * burst of identical page loads.
 */
export async function listConversations(
  page: LinkedInPage,
  options: InboxWalkOptions = {}
): Promise<LinkedInThreadListing | LinkedInDriverResult> {
  const walk = walkOf(options);
  const maxThreads = bounded(options.maxThreads ?? DEFAULT_MAX_THREADS, MAX_THREADS_CEILING);
  const needsProfileUrl = options.needsProfileUrl ?? (() => true);
  const now = options.now ?? (() => new Date());
  const degraded: string[] = [];

  const opened = await openUrl(page, walk, MESSAGING_URL);
  if (opened) return opened;

  const total = await countOf(page, INBOX_SELECTORS.conversationRow);
  if (total === 0) {
    // An empty inbox and a drifted selector look identical from the row count
    // alone, and they are opposite facts: one is "nobody has written", the
    // other is "we can no longer see whether anybody has".
    if (await present(page, INBOX_SELECTORS.conversationList)) {
      return { ok: true, threads: [], degraded };
    }
    return fail('selector_drift', `${INBOX_SELECTORS.conversationList} did not match on ${MESSAGING_URL}. Nothing was read.`);
  }

  const walked = Math.min(total, maxThreads);
  if (total > walked) {
    degraded.push(`${total} conversations are on screen and this run walked the newest ${walked}. Raise maxThreads to read further back.`);
  }

  const rows: RailRow[] = [];
  for (let index = 0; index < walked; index += 1) {
    rows.push({
      name: displayName(await textOf(page, rowSelector(index, INBOX_SELECTORS.rowName))),
      snippet: (await textOf(page, rowSelector(index, INBOX_SELECTORS.rowSnippet))) ?? '',
      stamp: await textOf(page, rowSelector(index, INBOX_SELECTORS.rowTimestamp)),
      unread: await present(page, rowSelector(index, INBOX_SELECTORS.rowUnreadBadge))
    });
  }

  const threads: LinkedInThreadSummary[] = [];
  let onRail = true;

  for (let index = 0; index < walked; index += 1) {
    const row = rows[index];

    if (!onRail) {
      const back = await openUrl(page, walk, MESSAGING_URL);
      if (back) return back;
      onRail = true;
    }

    const link = rowSelector(index, INBOX_SELECTORS.rowLink);
    if (!(await present(page, link))) {
      degraded.push(`Conversation ${index + 1} has no ${INBOX_SELECTORS.rowLink} to open, so its id could not be read. Nothing was clicked.`);
      continue;
    }

    await pace(walk, `thread:${index}`);
    try {
      await page.locator(link).first().click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    } catch (cause) {
      // Opening a conversation sends nothing, so an interrupted click is
      // reported and skipped rather than held: there is no ambiguity to settle.
      onRail = false;
      degraded.push(`Conversation ${index + 1} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }

    const wall = await detectWall(page);
    // A wall ENDS THE WALK. Clicking through a limit notice to see whether the
    // next one works is the behaviour that turns a restriction into a ban.
    if (wall) return fail(wall, wallDetail(wall, `conversation ${index + 1} on ${MESSAGING_URL}`));

    const threadUrn = threadUrnFrom(page.url());
    if (!threadUrn) {
      degraded.push(`Opening conversation ${index + 1} landed on '${page.url()}', which carries no conversation id, so it was skipped.`);
      continue;
    }

    const headerName = displayName(await textOf(page, INBOX_SELECTORS.threadProfileLink));
    if (row.name && headerName && !sameName(row.name, headerName)) {
      degraded.push(
        `Conversation ${index + 1} was listed as '${row.name}' and opened as '${headerName}', so the rail re-ordered mid-walk and this one was skipped rather than filed under the wrong name.`
      );
      continue;
    }

    let profileUrl: string | null = null;
    if (needsProfileUrl(threadUrn)) {
      if (!(await present(page, INBOX_SELECTORS.threadProfileLink))) {
        degraded.push(`Conversation ${index + 1} shows no link to the participant's profile, so it cannot be matched to a campaign target yet.`);
      } else {
        await pace(walk, `profile:${index}`);
        try {
          await page.locator(INBOX_SELECTORS.threadProfileLink).first().click({ timeout: CLICK_TIMEOUT_MS });
          onRail = false;
          await page.waitForTimeout(SETTLE_MS);
          const profileWall = await detectWall(page);
          if (profileWall) return fail(profileWall, wallDetail(profileWall, `the profile behind conversation ${index + 1}`));
          profileUrl = normalisedProfileUrl(page.url());
          if (!profileUrl) {
            degraded.push(`The profile link in conversation ${index + 1} landed on '${page.url()}', which is not a LinkedIn profile URL, so no campaign target was recorded.`);
          }
        } catch (cause) {
          onRail = false;
          degraded.push(`The profile behind conversation ${index + 1} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }

    threads.push({
      threadUrn,
      profileUrl,
      name: headerName ?? row.name,
      lastMessageAt: parseInboxTimestamp(row.stamp, now()),
      snippet: row.snippet,
      unread: row.unread
    });
  }

  return { ok: true, threads, degraded };
}

/**
 * Read one conversation, oldest of the read window first.
 *
 * THE NEWEST `maxMessages` ARE READ, NOT THE FIRST. A three-year thread cannot
 * be walked in a bounded run, and the half worth reading is the recent half --
 * a reply arrived at the end.
 *
 * DIRECTION IS READ OFF THE ITEM, not inferred from the sender's name: LinkedIn
 * marks the OPERATOR'S OWN message with a class (`messageOwnMarker` --
 * despite its `--other` modifier name, verified against real markup rather
 * than assumed), and a name comparison would call every message from a
 * person who shares the operator's name outbound.
 *
 * A message with no timestamp of its own INHERITS the last one seen above it,
 * because LinkedIn renders one timestamp per group rather than per message. The
 * first messages of a partial read can therefore have `at: null`, which is the
 * honest answer -- their group header was above the window.
 */
export async function readThread(
  page: LinkedInPage,
  threadUrn: string,
  options: InboxWalkOptions = {}
): Promise<LinkedInThreadTranscript | LinkedInDriverResult> {
  const url = threadUrlFor(threadUrn);
  if (!url) {
    return fail('not_found', `'${threadUrn}' is not a LinkedIn conversation id, so there is nothing to open. Conversation ids are never guessed.`);
  }

  const walk = walkOf(options);
  const maxMessages = bounded(options.maxMessages ?? DEFAULT_MAX_MESSAGES, MAX_MESSAGES_CEILING);
  const now = options.now ?? (() => new Date());
  const degraded: string[] = [];

  const opened = await openUrl(page, walk, url);
  if (opened) return opened;

  const total = await countOf(page, `${INBOX_SELECTORS.messageList} > li`);
  if (total === 0) {
    if (await present(page, INBOX_SELECTORS.messageList)) return { ok: true, threadUrn, messages: [], degraded };
    return fail('selector_drift', `${INBOX_SELECTORS.messageList} did not match on ${url}. Nothing was read.`);
  }

  const start = Math.max(0, total - maxMessages);
  if (start > 0) {
    degraded.push(`This conversation holds ${total} messages and the newest ${total - start} were read. Raise maxMessages to read further back.`);
  }

  const messages: LinkedInInboxMessage[] = [];
  let stamp: string | null = null;
  /**
   * Whether ANY item on this page carried the message bubble at all.
   *
   * The one guard against the failure this routine already shipped once: a
   * marker selector that matches nothing turns direction into a constant and
   * says nothing about it, and a transcript in which the operator appears to
   * have written every word is not a readable conversation. When the bubble
   * itself cannot be found, the inbound marker inside it cannot be trusted
   * either, and this run says so instead of quietly filing everything as ours.
   */
  let sawBubble = false;

  for (let index = start; index < total; index += 1) {
    const own = await textOf(page, messageSelector(index, INBOX_SELECTORS.messageTimestamp));
    if (own) stamp = own;

    const body = await textOf(page, messageSelector(index, INBOX_SELECTORS.messageBody));
    if (body === null) {
      // A separator, a system notice, or drift. Either way there is no message
      // text to file, and inventing an empty one would put a blank bubble in a
      // transcript a human reads.
      continue;
    }

    if (!sawBubble) sawBubble = await present(page, messageMarkerSelector(index, INBOX_SELECTORS.messageItem));
    const inbound = await present(page, messageMarkerSelector(index, INBOX_SELECTORS.messageInboundMarker));
    messages.push({ at: parseInboxTimestamp(stamp, now()), direction: inbound ? 'in' : 'out', body });
  }

  if (messages.length === 0) {
    degraded.push(`${total} message items are on screen at ${url} and none of them carries ${INBOX_SELECTORS.messageBody}, so nothing could be read.`);
  } else if (!sawBubble) {
    degraded.push(
      `No message at ${url} carries ${INBOX_SELECTORS.messageItem}, so nothing they wrote could be told apart from something you sent and every message was filed as outbound. Direction in this conversation is not trustworthy until that selector is repaired.`
    );
  }
  return { ok: true, threadUrn, messages, degraded };
}

/**
 * Send one message into an existing conversation.
 *
 * THE ONLY ROUTINE IN THIS FILE THAT WRITES ANYTHING, and it is never a path of
 * its own: it executes bytes that are already a `linkedin_actions` row which
 * has already passed `evaluateLinkedInSafety`. A caller that reaches this
 * function with a body no gate approved has built the hole this subsystem
 * exists to prevent -- see the module header of `inbox.ts`.
 *
 * The body is passed through byte for byte or not at all, exactly as `sendDm`
 * does: truncating it would send bytes no human approved.
 *
 * The composer is expected to be ON the thread page, so a miss is
 * `selector_drift` (nothing was typed) rather than `unknown`. Everything after
 * the first `fill` is post-write and reports `unknown` on ambiguity, because a
 * message that may have left cannot be un-sent.
 */
export async function sendReply(page: LinkedInPage, threadUrn: string, body: string): Promise<LinkedInDriverResult> {
  if (!body.trim()) {
    return fail('selector_drift', 'Refusing to open a message composer with no approved body to put in it.');
  }
  const url = threadUrlFor(threadUrn);
  if (!url) {
    return fail('not_found', `'${threadUrn}' is not a LinkedIn conversation id, so there is nothing to reply to.`);
  }

  const walk = walkOf({});
  const opened = await openUrl(page, walk, url);
  if (opened) return opened;

  const compose = page.locator(SELECTORS.messageComposeBox);
  if ((await countOf(page, SELECTORS.messageComposeBox)) === 0) {
    return fail('selector_drift', `${SELECTORS.messageComposeBox} did not match on ${url}. Nothing was typed.`);
  }
  // BOTH CONTROLS ARE READ BEFORE EITHER IS USED, so a missing send button is
  // "nothing was typed" rather than "an unsent draft is sitting in a thread".
  if ((await countOf(page, SELECTORS.messageSendButton)) === 0) {
    return fail('selector_drift', `${SELECTORS.messageSendButton} did not match on ${url}. Nothing was typed.`);
  }

  try {
    await compose.first().fill(body, { timeout: CLICK_TIMEOUT_MS });
    await page.locator(SELECTORS.messageSendButton).first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    return fail(
      'unknown',
      `The reply in ${url} was interrupted after the composer was filled: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`
    );
  }

  const afterSend = await detectWall(page);
  if (afterSend) {
    return fail(afterSend, `LinkedIn answered the reply in ${url} with a ${afterSend === 'challenge' ? 'challenge' : 'limit wall'}.`);
  }
  return { ok: true, externalRef: url, failureKind: null };
}

/** What an inbox sync needs; the fake in the tests implements exactly this. */
export interface LinkedInInboxDriver {
  listConversations(page: LinkedInPage, options?: InboxWalkOptions): Promise<LinkedInThreadListing | LinkedInDriverResult>;
  readThread(page: LinkedInPage, threadUrn: string, options?: InboxWalkOptions): Promise<LinkedInThreadTranscript | LinkedInDriverResult>;
  sendReply(page: LinkedInPage, threadUrn: string, body: string): Promise<LinkedInDriverResult>;
}

/** The real driver. Taken as a parameter by its callers so tests can pass a fake. */
export const playwrightInboxDriver: LinkedInInboxDriver = {
  listConversations,
  readThread,
  sendReply
};
