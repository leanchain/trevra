import { createHash } from 'node:crypto';
import {
  SELECTORS,
  normalisedProfileUrl,
  profileUrlFor,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import { hoverClick, readPage, settle } from './human.js';

/**
 * The Playwright routines for LinkedIn's sent-invitations manager.
 *
 * A companion to `driver.ts`, under the same rules and reachable the same way:
 * self-hosted only, one file, no credential ever stored or printed, nothing
 * throws, every path returns a result. It is separate only because it drives a
 * different surface -- `/mynetwork/invitation-manager/sent/` rather than a
 * profile page -- and mixing two selector tables in one file is how a drift
 * repair turns into archaeology.
 *
 * IT REUSES `driver.ts` RATHER THAN RESTATING IT. The failure vocabulary, the
 * result shape, the page contract, the selector table for walls and
 * challenges, and the host-checked URL canonicalisation are all imported. The
 * only things redefined here are the two constants `driver.ts` keeps private
 * (its navigation timeout and its checkpoint path), and they are kept byte
 * identical.
 *
 * WHAT THE SIX FAILURE KINDS MEAN ON THIS SURFACE. Five carry over unchanged.
 * The sixth is remapped, and it is the most important line in this file:
 *
 *   already_connected -- THE INVITE IS NO LONGER AWAITING AN ANSWER. Its entry
 *                        is not on the sent-invitations list, so there is
 *                        nothing to withdraw. Accepted, declined, expired and
 *                        already-withdrawn are INDISTINGUISHABLE here, because
 *                        LinkedIn removes the entry in every one of those
 *                        cases and says nothing about which. This is exactly
 *                        the shape `already_connected` already had on a
 *                        profile page -- "there is nothing to send, and that
 *                        is definite" -- so it is reused rather than a seventh
 *                        kind being invented for it.
 *
 * AND THAT REMAP IS THE SAFETY PROPERTY. An accepted invite must never be
 * withdrawn, and the only moment at which "is this still pending" can be
 * answered truthfully is the instant before the click. A list read a minute
 * ago cannot answer it and neither can a database. So `withdrawInvite` reads
 * the live list itself, every time, and clicks nothing when the entry is
 * absent -- the caller cannot opt out of that check, because it is not a
 * parameter.
 *
 * NO `Math.random()`. The pauses while paging the list are drawn from a
 * generator seeded by the caller's seed and the page index, the same
 * convention `local-worker.ts` and `pacing.ts` use, for the same reason:
 * unpredictable to LinkedIn, reproducible for us, assertable in a test.
 */

/* ---------------------------------------------------------------------------
 * The page contract, widened by exactly three methods.
 * ------------------------------------------------------------------------ */

/**
 * `driver.ts`'s locator plus what reading a LIST needs.
 *
 * `LinkedInLocator` was declared for routines that act on ONE control, so it
 * offers `first()` and nothing else. Walking a list of invitation cards and
 * reading a field out of each one needs three more methods, and all three are
 * on Playwright's real `Locator`, so this stays a structural declaration and
 * this file still compiles with Playwright absent (plan 4.4).
 *
 * It EXTENDS the driver's interface rather than restating it, so the two can
 * never drift into describing different objects.
 */
export interface LinkedInListLocator extends LinkedInLocator {
  first(): LinkedInListLocator;
  /** The i-th match. The whole reason this interface exists. */
  nth(index: number): LinkedInListLocator;
  /** Scope a search INSIDE this element -- how a card's own link is found. */
  locator(selector: string): LinkedInListLocator;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
}

/** `driver.ts`'s page, with the widened locator. Playwright's `Page` satisfies it. */
export interface LinkedInListPage extends Omit<LinkedInPage, 'locator'> {
  locator(selector: string): LinkedInListLocator;
}

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

/** One invitation still awaiting the recipient's answer. */
export interface PendingInvite {
  /**
   * Canonical, in the exact form `profileUrlFor` produces, so it is comparable
   * against `linkedin_actions.target_ref` without a second formatter existing.
   */
  profileUrl: string;
  name: string | null;
  /**
   * ISO-8601, resolved from LinkedIn's relative label ("Sent 3 weeks ago").
   *
   * Null when the label could not be read or understood, and null is the right
   * answer there rather than a guess: this value decides whether an invite is
   * old enough to withdraw, and a fabricated timestamp would make that
   * decision on evidence nobody has.
   */
  sentAt: string | null;
}

/**
 * A successful read of the sent-invitations list.
 *
 * Carries `degraded` rather than failing, mirroring `LinkedInSeatRead` in
 * `driver.ts` and for the same reason: a card whose name we could not read is
 * still a card whose profile URL we could, and reporting the whole list as a
 * failure would throw away the part that worked.
 */
export interface PendingInviteList {
  ok: true;
  invites: PendingInvite[];
  /**
   * True when LinkedIn still had more to show and a bound stopped us.
   *
   * IT MUST REACH THE CALLER. "These are the pending invites" and "these are
   * the first 500 pending invites" are different facts, and a sweep that
   * treated a truncated list as complete would conclude that everything it did
   * not see has stopped being pending.
   */
  truncated: boolean;
  /** What could not be read, in plain sentences an operator can act on. */
  degraded: string[];
}

export interface ListPendingInvitesOptions {
  /** How many "show more" expansions to perform. Default {@link MAX_LIST_PAGES}. */
  maxPages?: number;
  /** How many cards to read at most. Default {@link MAX_PENDING_INVITES}. */
  maxInvites?: number;
  /** Seed for the between-page pauses. Same seed, same pauses, any machine. */
  seed?: string;
  /** The instant relative labels are resolved against. Defaults to the clock. */
  now?: Date;
}

/** What a caller needs from this surface; a test's fake implements exactly this. */
export interface LinkedInWithdrawDriver {
  listPendingInvites(
    page: LinkedInListPage,
    options?: ListPendingInvitesOptions
  ): Promise<PendingInviteList | LinkedInDriverResult>;
  withdrawInvite(page: LinkedInListPage, profileUrl: string): Promise<LinkedInDriverResult>;
}

/** Narrow a list read. A read carries no `failureKind`; a failure always does. */
export function isPendingInviteList(value: PendingInviteList | LinkedInDriverResult): value is PendingInviteList {
  return !('failureKind' in value);
}

/* ---------------------------------------------------------------------------
 * Selectors and constants
 * ------------------------------------------------------------------------ */

/**
 * EVERY DOM SELECTOR FOR THIS SURFACE, IN ONE TABLE, for exactly the reasons
 * `driver.ts` gives for its own. Drift is the expected steady state; a miss on
 * a control we were about to click is `selector_drift` and means nothing was
 * clicked; anything ambiguous AFTER a click is `unknown`.
 *
 * The wall, challenge and restriction selectors are NOT repeated here -- they
 * are imported from `driver.ts`'s table, so a repair to "how LinkedIn says
 * stop" is still one edit in one place.
 */
export const WITHDRAW_SELECTORS = {
  /** One sent invitation. LinkedIn has shipped all three of these shapes. */
  invitationCard: 'li.invitation-card, li[componentkey^="InvitationManager"], div.invitation-card',
  /** The profile link inside a card; the only reliable identity a card carries. */
  invitationProfileLink: 'a[href*="/in/"]',
  /** The recipient's name. Informational -- a miss degrades, never fails. */
  invitationName: '.invitation-card__title, a[href*="/in/"] span[aria-hidden="true"], strong',
  /** "Sent 3 weeks ago", or the compact "3w". Informational in the same way. */
  invitationSentAt: 'time, .invitation-card__time-badge, .time-badge',
  /** The withdraw control inside a card. */
  withdrawButton: 'button[aria-label^="Withdraw"], button[aria-label*="withdraw" i]',
  /** LinkedIn asks again in a modal before it actually withdraws. */
  confirmDialog: 'div[role="dialog"], div.artdeco-modal[role="dialog"]',
  confirmWithdrawButton:
    'div[role="dialog"] button[aria-label^="Withdraw"], div[role="dialog"] button[data-test-dialog-primary-btn]',
  /** Infinite scroll's manual escape hatch. Absent once the list is exhausted. */
  showMoreButton: 'button.scaffold-finite-scroll__load-button, button[aria-label*="Show more" i]',
  /** No outstanding invitations at all -- a real and common answer, not a failure. */
  emptyState: 'text=/No pending invitations|no sent invitations|You have no pending/i',
  /**
   * THE EMPTY STATE IN A LANGUAGE THIS FILE DOES NOT SPEAK.
   *
   * LinkedIn renders its interface in the MEMBER's language, and this seat's is
   * German: the sent-invitations page says `Keine neuen Einladungen`, which the
   * English matcher above will never see. The result was the worst of the two
   * possible wrong answers -- an empty list reported as SELECTOR DRIFT, which
   * is the answer that means "stop, something is broken", filed against a page
   * that was working perfectly.
   *
   * Every sent invitation carries a link to the person it was sent to (that is
   * what `invitationProfileLink` reads). So a main region with no cards AND no
   * profile links anywhere in it has nothing to withdraw, in any language --
   * whereas profile links WITHOUT cards is genuine drift and still fails.
   */
  invitationProfileLinkAnywhere: 'main a[href*="/in/"]'
} as const;

/** The sent-invitations manager. The only URL this file navigates to. */
export const SENT_INVITES_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';

/**
 * Where a checkpoint lands, and how long a navigation may take.
 *
 * Copied from `driver.ts`, which keeps both private. Duplicated rather than
 * exported-from-there for the same trade `local-worker.ts` documents about
 * mulberry32: reaching into another module's internals to save two lines is
 * the worse of the two, and these two values have not moved since the file was
 * written. They must stay identical -- a checkpoint this file failed to
 * recognise is a challenge it would try to click past.
 */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;
const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/* The post-load pause is `settle()` from `human.ts`: a band, seeded per step,
 * not the 1,500ms constant five driver files used to share. */

/**
 * The bounds. Not pacing -- the ceiling and the gaps between WITHDRAWALS are
 * `withdraw.ts`'s job. These keep one list read finite, so a seat with a
 * pathological backlog cannot hold a tick open forever.
 */
export const MAX_LIST_PAGES = 25;
export const MAX_PENDING_INVITES = 500;

/**
 * Seconds to pause between "show more" expansions.
 *
 * DELIBERATELY MUCH SHORTER THAN `ACTION_GAP_SECONDS` (30-120s), and the
 * distinction is the point: paging a list the operator is already looking at
 * is a scroll, not an action against another human. Twenty-five expansions at
 * the invite gap would be half an hour of doing nothing. The 30-120s band
 * still governs the gap between withdrawals themselves, applied by
 * `withdraw.ts` where the actions actually are.
 */
const PAGE_GAP_SECONDS = { min: 2, max: 6 };

/* ---------------------------------------------------------------------------
 * Deterministic jitter -- the local-worker.ts convention
 * ------------------------------------------------------------------------ */

/**
 * mulberry32, seeded from a hash of the caller's seed and the page index.
 *
 * The same generator as `pacing.ts` and `local-worker.ts`, copied for the
 * reason `local-worker.ts` states: both of those keep it private, and reaching
 * into another module's internals to save six lines is a worse trade than the
 * six lines. Importing `local-worker.ts` from a driver would be worse still --
 * it would drag the worker's filesystem and secrets dependencies into the one
 * layer that must keep compiling with Playwright absent.
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

/** Seconds to wait before expanding the list again. Seeded, so it is assertable. */
export function pageGapSeconds(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  const random = seededRandom(digest);
  return PAGE_GAP_SECONDS.min + random() * (PAGE_GAP_SECONDS.max - PAGE_GAP_SECONDS.min);
}

/* ---------------------------------------------------------------------------
 * Shared helpers -- the same shapes driver.ts uses
 * ------------------------------------------------------------------------ */

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

async function present(page: LinkedInListPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    // A locator that cannot even be evaluated is drift, not absence. Answering
    // `false` here would let a routine sail past a wall it failed to read.
    return false;
  }
}

/**
 * Is this an empty invitation list, rather than a list this driver failed to
 * read? That distinction decides between "nothing to withdraw" and "stop".
 *
 * Two ways to be sure, and either is enough: LinkedIn's own empty-state
 * sentence (exact, English only), or the structural fact that the page offers
 * no person at all -- no card, and no profile link anywhere in `main`. The
 * second is what answers for the twenty-odd languages the first cannot read,
 * and it was measured on the German page that reported drift while saying
 * `Keine neuen Einladungen`.
 */
async function emptyInviteList(page: LinkedInListPage): Promise<boolean> {
  if (await present(page, WITHDRAW_SELECTORS.emptyState)) return true;
  return !(await present(page, WITHDRAW_SELECTORS.invitationProfileLinkAnywhere));
}

/**
 * The three "stop now" reads, done BEFORE anything is clicked.
 *
 * Identical order and identical selectors to `driver.ts` `detectWall`: a
 * challenge outranks a limit wall outranks a missing page, because a
 * checkpoint can also render the words "invitation limit" and the
 * human-intervention case must win.
 */
async function detectWall(page: LinkedInListPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
  return null;
}

/** Open the sent-invitations manager and read the walls. Null means it is safe to read. */
async function openSentInvites(page: LinkedInListPage): Promise<LinkedInDriverResult | null> {
  try {
    await page.goto(SENT_INVITES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${SENT_INVITES_URL}#open`);
    await readPage(page, `${SENT_INVITES_URL}#read`);
  } catch (cause) {
    // Navigation failed, so nothing was read and nothing was clicked.
    return fail(
      'selector_drift',
      `Could not open ${SENT_INVITES_URL}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const wall = await detectWall(page);
  if (!wall) return null;
  return fail(
    wall,
    wall === 'challenge'
      ? `LinkedIn is showing a challenge at ${page.url()}. A human has to clear it in the profile window; nothing else will.`
      : `LinkedIn refused ${SENT_INVITES_URL}: a limit or restriction notice is on screen. This is LinkedIn asking us to stop.`
  );
}

/** The first match's collapsed text, or null for absent, empty, or unreadable. */
async function textOf(scope: LinkedInListLocator, selector: string): Promise<string | null> {
  try {
    const locator = scope.locator(selector);
    if ((await locator.count()) === 0) return null;
    const text = await locator.first().textContent({ timeout: CLICK_TIMEOUT_MS });
    const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
    return collapsed || null;
  } catch {
    return null;
  }
}

/** A card's canonical profile URL, or null when it carries no readable one. */
async function cardProfileUrl(card: LinkedInListLocator): Promise<string | null> {
  try {
    const link = card.locator(WITHDRAW_SELECTORS.invitationProfileLink);
    if ((await link.count()) === 0) return null;
    const href = await link.first().getAttribute('href', { timeout: CLICK_TIMEOUT_MS });
    if (!href) return null;
    // Relative hrefs are what LinkedIn actually renders. Resolved against
    // SENT_INVITES_URL rather than string-patched, so the host check in
    // `normalisedProfileUrl` still sees a real origin and still applies.
    let absolute: string;
    try {
      absolute = new URL(href, SENT_INVITES_URL).toString();
    } catch {
      return null;
    }
    return normalisedProfileUrl(absolute);
  } catch {
    return null;
  }
}

/**
 * Expand the list once. True when it grew, false when there is nothing more.
 *
 * The pause happens BEFORE the click, seeded by the caller's seed and the page
 * index, so the same read produces the same rhythm on every machine.
 */
async function expandList(page: LinkedInListPage, pageIndex: number, seed: string): Promise<boolean> {
  const more = page.locator(WITHDRAW_SELECTORS.showMoreButton);
  try {
    if ((await more.count()) === 0) return false;
    await page.waitForTimeout(Math.round(pageGapSeconds(`${seed}:${pageIndex}`) * 1000));
    await hoverClick(page, more.first(), `${seed}:${pageIndex}#more`, CLICK_TIMEOUT_MS);
    await settle(page, `${seed}:${pageIndex}#more-open`);
    return true;
  } catch {
    // Expanding failed. Not a failure of the read: what is already on screen is
    // still true, and the caller learns the list is truncated.
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * "Sent 3 weeks ago" -> an instant
 * ------------------------------------------------------------------------ */

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000
};

/**
 * LinkedIn's relative label, resolved against `now`.
 *
 * Handles the long form ("Sent 3 weeks ago") and the compact one ("3w", "2mo"),
 * because LinkedIn renders both depending on viewport. Returns null for
 * anything it does not recognise, and that is deliberate: this value decides
 * whether an invite is old enough to withdraw, so an unrecognised label must
 * leave the age UNKNOWN rather than resolve to `now` and make every stale
 * invite look fresh -- or to the epoch and make every fresh one look stale.
 *
 * `mo` is checked before `m` because "3mo" and "3m" are three months and three
 * minutes, and getting that backwards is a four-order-of-magnitude error in
 * exactly the number this feature keys on.
 */
export function parsePendingSince(label: string | null, now: Date): string | null {
  if (!label) return null;
  const text = label.trim().toLowerCase();
  if (!text) return null;
  if (/\b(today|just now|now|moments? ago)\b/.test(text)) return now.toISOString();
  if (/\byesterday\b/.test(text)) return new Date(now.getTime() - UNIT_MS.d).toISOString();

  const long = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/.exec(text);
  if (long) {
    const unit = long[2] === 'month' ? 'mo' : long[2][0];
    const ms = UNIT_MS[unit];
    if (ms === undefined) return null;
    return new Date(now.getTime() - Number.parseInt(long[1], 10) * ms).toISOString();
  }

  const compact = /(\d+)\s*(mo|[smhdwy])\b/.exec(text);
  if (compact) {
    const ms = UNIT_MS[compact[2]];
    if (ms === undefined) return null;
    return new Date(now.getTime() - Number.parseInt(compact[1], 10) * ms).toISOString();
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * The two routines
 * ------------------------------------------------------------------------ */

/**
 * Walk the sent-invitations manager and report what is still awaiting an
 * answer.
 *
 * A PURE READ. It clicks "show more" and nothing else, so re-running it
 * duplicates nothing in anybody's notifications -- the same property that lets
 * `linkedin_seat_detect_requests` (027) hold a reclaimable claim. It is not
 * paced against any ceiling for the same reason.
 *
 * An empty list is `ok` with no invites, never a failure: "this seat has no
 * outstanding invitations" is an answer, and the most desirable one.
 */
export async function listPendingInvites(
  page: LinkedInListPage,
  options: ListPendingInvitesOptions = {}
): Promise<PendingInviteList | LinkedInDriverResult> {
  const opened = await openSentInvites(page);
  if (opened) return opened;

  const maxPages = Math.max(1, Math.trunc(options.maxPages ?? MAX_LIST_PAGES));
  const maxInvites = Math.max(1, Math.trunc(options.maxInvites ?? MAX_PENDING_INVITES));
  const seed = options.seed ?? SENT_INVITES_URL;
  const now = options.now ?? new Date();

  const invites: PendingInvite[] = [];
  const degraded: string[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  let undated = 0;
  let truncated = false;
  let cursor = 0;

  // READ, THEN EXPAND, and the order is load-bearing: expanding last means
  // whatever the final expansion loaded is still read on the next turn. Bound
  // the EXPANSIONS rather than the turns, or the last page LinkedIn hands over
  // is silently dropped and the list reports itself complete.
  let expansions = 0;
  for (;;) {
    let count: number;
    try {
      count = await page.locator(WITHDRAW_SELECTORS.invitationCard).count();
    } catch (cause) {
      return fail(
        'selector_drift',
        `Could not count ${WITHDRAW_SELECTORS.invitationCard} on ${SENT_INVITES_URL}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }

    if (count === 0 && cursor === 0) {
      // No cards at all. An empty state is the answer; anything else is drift,
      // and the two must not be conflated -- "you have no pending invites" and
      // "we could not see your pending invites" lead to opposite decisions.
      if (await emptyInviteList(page)) {
        return { ok: true, invites: [], truncated: false, degraded: [] };
      }
      return fail(
        'selector_drift',
        `Neither ${WITHDRAW_SELECTORS.invitationCard} nor an empty list matched on ${SENT_INVITES_URL} -- the page holds profile links but no cards this driver can read, so whether this seat has pending invites is unknown. Repair WITHDRAW_SELECTORS in driver-withdraw.ts.`
      );
    }

    for (; cursor < count && invites.length < maxInvites; cursor += 1) {
      const card = page.locator(WITHDRAW_SELECTORS.invitationCard).nth(cursor);
      const profileUrl = await cardProfileUrl(card);
      if (!profileUrl) {
        unreadable += 1;
        continue;
      }
      // A card LinkedIn rendered twice across an expansion is one invite.
      if (seen.has(profileUrl)) continue;
      seen.add(profileUrl);
      const sentAt = parsePendingSince(await textOf(card, WITHDRAW_SELECTORS.invitationSentAt), now);
      if (sentAt === null) undated += 1;
      invites.push({ profileUrl, name: await textOf(card, WITHDRAW_SELECTORS.invitationName), sentAt });
    }

    if (invites.length >= maxInvites) {
      truncated = cursor < count || (await present(page, WITHDRAW_SELECTORS.showMoreButton));
      break;
    }
    if (expansions >= maxPages || !(await expandList(page, expansions, seed))) {
      truncated = await present(page, WITHDRAW_SELECTORS.showMoreButton);
      break;
    }
    expansions += 1;
  }

  if (unreadable > 0) {
    degraded.push(
      `${unreadable} invitation card(s) carried no readable LinkedIn profile link, so they were left out of this list rather than guessed at.`
    );
  }
  if (undated > 0) {
    degraded.push(
      `${undated} invitation(s) had no readable "sent" label, so their age is unknown. Age-based withdrawal will fall back to when Trevra recorded the invite.`
    );
  }
  if (truncated) {
    degraded.push(
      `LinkedIn still had more sent invitations to show after ${invites.length}. This list is a prefix, not the whole backlog.`
    );
  }
  return { ok: true, invites, truncated, degraded };
}

/**
 * Withdraw one pending invite.
 *
 * THE LIVE RE-READ IS THE WHOLE ROUTINE, and it is not optional. Every call
 * opens the sent-invitations manager itself and looks for this profile's entry
 * before touching anything. An accepted invite has no entry, so it cannot be
 * clicked; a list a caller read ten minutes ago has no bearing on it. This is
 * the only place the question "is it still pending" can be asked at the moment
 * the answer has to be true, which is why it is asked here and cannot be
 * passed in.
 *
 * The entry being absent is reported as `already_connected` -- "there is
 * nothing to do, definitely" -- and the caller must not read it as "the invite
 * was withdrawn".
 */
export async function withdrawInvite(page: LinkedInListPage, profileUrl: string): Promise<LinkedInDriverResult> {
  const raw = profileUrl.trim();
  const url = /^https?:\/\//i.test(raw) ? normalisedProfileUrl(raw) : profileUrlFor(raw);
  if (!url) {
    return fail(
      'not_found',
      `'${profileUrl}' is not a LinkedIn profile URL or handle, so there is no invitation to look for. Targets are never resolved or guessed.`
    );
  }

  const opened = await openSentInvites(page);
  if (opened) return opened;

  let card: LinkedInListLocator | null = null;
  let cursor = 0;
  let expansions = 0;
  while (card === null) {
    let count: number;
    try {
      count = await page.locator(WITHDRAW_SELECTORS.invitationCard).count();
    } catch (cause) {
      return fail(
        'selector_drift',
        `Could not count ${WITHDRAW_SELECTORS.invitationCard} while looking for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (count === 0 && cursor === 0 && !(await emptyInviteList(page))) {
      return fail(
        'selector_drift',
        `Neither ${WITHDRAW_SELECTORS.invitationCard} nor ${WITHDRAW_SELECTORS.emptyState} matched on ${SENT_INVITES_URL}, so whether ${url} is still pending is unknown. Nothing was clicked.`
      );
    }
    for (; cursor < count; cursor += 1) {
      const candidate = page.locator(WITHDRAW_SELECTORS.invitationCard).nth(cursor);
      if ((await cardProfileUrl(candidate)) === url) {
        card = candidate;
        break;
      }
    }
    if (card !== null) break;
    // Same read-then-expand order as the list walk, and the same bound.
    if (expansions >= MAX_LIST_PAGES || !(await expandList(page, expansions, url))) break;
    expansions += 1;
  }

  if (card === null) {
    return fail(
      'already_connected',
      `${url} has no entry in the sent-invitations list, so there is no invite awaiting an answer and nothing was clicked. An invite that was accepted looks exactly like this, which is precisely why nothing was clicked.`
    );
  }

  const withdraw = card.locator(WITHDRAW_SELECTORS.withdrawButton);
  if ((await withdraw.count()) === 0) {
    return fail(
      'selector_drift',
      `The invitation card for ${url} contains no ${WITHDRAW_SELECTORS.withdrawButton}. Nothing was clicked.`
    );
  }

  // EVERYTHING BELOW THIS LINE IS POST-CLICK. An error from here on cannot
  // prove the invite is still standing, so it reports `unknown` and the caller
  // holds the claim rather than deciding either way about the ledger row.
  try {
    await hoverClick(page, withdraw.first(), `${url}#withdraw`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#after-withdraw`);

    const wall = await detectWall(page);
    if (wall) {
      return fail(
        wall,
        `LinkedIn answered the Withdraw click for ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}. The withdrawal was refused, not performed.`
      );
    }

    // LinkedIn asks again in a modal on most surfaces and on none of the
    // others. A dialog with no confirm control is `unknown`: it is open, we put
    // it there, and whether dismissing it would withdraw or cancel is not ours
    // to assume.
    if (await present(page, WITHDRAW_SELECTORS.confirmDialog)) {
      const confirm = page.locator(WITHDRAW_SELECTORS.confirmWithdrawButton);
      if ((await confirm.count()) === 0) {
        return fail(
          'unknown',
          `A confirmation dialog is open for ${url} and ${WITHDRAW_SELECTORS.confirmWithdrawButton} did not match it, so whether the invite was withdrawn is unknown. Settle it by hand.`
        );
      }
      await hoverClick(page, confirm.first(), `${url}#confirm-withdraw`, CLICK_TIMEOUT_MS);
      await settle(page, `${url}#after-confirm`);
    }

    const after = await detectWall(page);
    if (after) {
      return fail(
        after,
        `LinkedIn answered the withdrawal confirmation for ${url} with a ${after === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    }
    if (await present(page, WITHDRAW_SELECTORS.confirmDialog)) {
      return fail(
        'unknown',
        `The confirmation dialog for ${url} is still open after the confirm click; whether the invite was withdrawn is unknown.`
      );
    }
    return { ok: true, externalRef: url, failureKind: null };
  } catch (cause) {
    return fail(
      'unknown',
      `The withdrawal of ${url} was interrupted after the Withdraw click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it went through is unknown.`
    );
  }
}

/** The real driver. `withdraw.ts` takes this behind an interface so tests need no browser. */
export const playwrightWithdrawDriver: LinkedInWithdrawDriver = { listPendingInvites, withdrawInvite };
