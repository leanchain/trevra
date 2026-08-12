/**
 * The Playwright routines, one per executable action kind.
 *
 * This file is the ONLY place in Trevra that touches a LinkedIn page, and it
 * is reachable only from `local-worker.ts`, which is reachable only when the
 * deployment-mode gate in `config.ts` says this instance is self-hosted
 * (plan 4.3). Nothing here runs on a hosted instance, ever.
 *
 * THIS FILE NEVER STORES A CREDENTIAL, AND IT NEVER PRINTS ONE. A self-hoster
 * automating THEIR OWN account hands Trevra their own email and password
 * (plan 4.9). Those are sealed in `workspace_secrets`, opened at the moment of
 * use, and arrive here as two function arguments that are typed into a form
 * and then let go. `loginWithCredentials` is the only routine that sees them.
 *
 * NOTHING IN THIS FILE MAY ECHO EITHER VALUE. Every `detail` string below is
 * built from constants, selector names and the page's own URL -- never from an
 * argument -- so no failure path, however unusual, can put a password into a
 * ledger row, a log line or an HTTP response.
 *
 * A LIVE SESSION IS ALWAYS PREFERRED TO A FRESH LOGIN. `isLoggedIn` exists so
 * the credential path is the FALLBACK: re-authenticating on every run is slower
 * and a much stronger ban signal than a stable session (plan 1.3 is about a
 * surge in automated activity, and a login burst is exactly that shape).
 *
 * WHAT A FAILURE MEANS IS THE IMPORTANT PART. Every routine reports one of six
 * kinds, and the worker treats three of them as "LinkedIn is telling us to
 * stop":
 *
 *   not_found         the profile is gone or was never there. Definite; the
 *                     action did not happen and never will.
 *   already_connected there is nothing to send. Definite.
 *   limit_wall        LinkedIn refused because a ceiling was hit. STOP.
 *   challenge         LinkedIn wants a human (captcha, PIN, checkpoint). STOP.
 *   selector_drift    the control we needed was not on the page. Nothing was
 *                     clicked, so nothing was sent.
 *   unknown           we clicked and then lost track of the outcome. NOT
 *                     definite -- the worker holds the claim rather than
 *                     retrying, for the same reason `publish.ts` holds a
 *                     `PlatformUnreachable` write: a duplicate invite cannot
 *                     be un-sent.
 *
 * `limit_wall` and `challenge` put the seat into `cooldown` and end the batch
 * (plan 4.5). Pushing past either is precisely what turns a temporary
 * restriction into a permanent ban, so they are not retried, not counted as
 * ordinary failures, and not survivable by the loop.
 *
 * NOTHING HERE THROWS. A routine that throws would abort the batch at an
 * unknown point with an unclaimed action, which is the one outcome the ledger
 * cannot describe. Every path returns a result.
 */

// The sibling selector tables. Type-only in the other direction, so this pair
// of cycles resolves before either module body needs a binding from the other.
import { endorseSkills, followProfile, likeRecentPost } from './driver-engage.js';
import { sendReply } from './driver-inbox.js';

/** The six outcomes a routine may report. Ordered as in plan 4.5. */
export type LinkedInFailureKind =
  | 'not_found'
  | 'already_connected'
  | 'limit_wall'
  | 'challenge'
  | 'selector_drift'
  | 'unknown';

export interface LinkedInDriverResult {
  ok: boolean;
  /** The canonical profile URL the action landed on. Absent on failure. */
  externalRef?: string;
  /** Null exactly when `ok` is true. */
  failureKind: LinkedInFailureKind | null;
  /** Written for the operator reading the ledger later, not for a log grep. */
  detail?: string;
}

/**
 * The slice of Playwright's `Page` this driver uses, declared structurally.
 *
 * Playwright is an OPTIONAL dependency (plan 4.4): importing its types here
 * would make `tsc` fail on every machine that has not installed the 400MB of
 * browser it drags in, including the Cloudflare marketing build. A structural
 * interface costs one small declaration and keeps this file compiling with the
 * package absent -- which is the normal case for every deployment except a
 * self-hoster who opted in.
 */
export interface LinkedInLocator {
  count(): Promise<number>;
  first(): LinkedInLocator;
  click(options?: { timeout?: number }): Promise<void>;
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  /**
   * Optional because only the sign-in form needs it, and every fake in the
   * tests would otherwise have to grow a method it never calls. Absent means
   * "this locator cannot type a key", which the one caller treats as a missing
   * submit control rather than as a failure.
   */
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
}

export interface LinkedInPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): LinkedInLocator;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * What the signed-in session says this seat is.
 *
 * Success carries a `degraded` list rather than an `ok:false`, because the
 * three fields fail independently: a profile URL we read and a connection
 * count we could not is a PARTIAL ANSWER, and reporting it as a failure would
 * throw away the part that worked. Mirrors `CompanyProfile.degraded` in
 * skills/enrich.ts, and for the same reason -- a field nobody could read comes
 * back null, never zero, because a number nobody measured must never be paced
 * against.
 */
export interface LinkedInSeatRead {
  ok: true;
  /** Canonical, in the exact form `profileUrlFor` produces, so ledger `target_ref`s stay comparable. */
  profileUrl: string;
  name: string | null;
  connectionsCount: number | null;
  /** What could not be read, in plain sentences an operator can act on. */
  degraded: string[];
}

/**
 * The three answers a sign-in attempt can give.
 *
 * `needsOtp` IS NOT A FAILURE, and the shape says so: it carries no
 * `failureKind` because nothing went wrong. LinkedIn asked for a code, the
 * operator has one on their phone, and the next call supplies it. Modelling it
 * as a failure is how a two-factor account becomes "this product does not
 * work with 2FA".
 */
export type LinkedInLoginResult = { ok: true } | LinkedInDriverResult | { ok: false; needsOtp: true };

/** Narrow a login answer to "ask the operator for the code and call again". */
export function isOtpRequired(value: LinkedInLoginResult): value is { ok: false; needsOtp: true } {
  return 'needsOtp' in value;
}

/**
 * What `local-worker.ts` needs; the fake in the tests implements exactly this.
 *
 * ONE INTERFACE, THREE FILES BEHIND IT. `sendInvite`, `sendDm`, `viewProfile`
 * and the session routines live here; the engagement trio lives in
 * `driver-engage.ts` and `sendReply` in `driver-inbox.ts`, because mixing
 * selector tables for four different LinkedIn surfaces in one file is how a
 * drift repair turns into archaeology. The WORKER should not have to know
 * that: it dispatches one action to one driver, and the split is a fact about
 * where the selectors are maintained, not about how a batch is executed.
 */
export interface LinkedInDriver {
  sendInvite(page: LinkedInPage, target: string, note?: string): Promise<LinkedInDriverResult>;
  sendDm(page: LinkedInPage, target: string, body: string): Promise<LinkedInDriverResult>;
  /**
   * Answer inside an existing conversation, by thread id rather than by
   * profile. NOT `sendDm` with different words: `sendDm` navigates to a profile
   * and opens a fresh composer, which for somebody already in the inbox opens
   * the wrong surface and can start a second conversation with the same person.
   */
  sendReply(page: LinkedInPage, threadUrn: string, body: string): Promise<LinkedInDriverResult>;
  viewProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  followProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  /** `seed` is the batch-scoped seed for the deterministic in-action click jitter. */
  likeRecentPost(page: LinkedInPage, target: string, options?: { seed?: string }): Promise<LinkedInDriverResult>;
  endorseSkills(page: LinkedInPage, target: string, options?: { seed?: string }): Promise<LinkedInDriverResult>;
  readSeat(page: LinkedInPage): Promise<LinkedInSeatRead | LinkedInDriverResult>;
  /** Is this profile already signed in? Asked BEFORE any sign-in is attempted. */
  isLoggedIn(page: LinkedInPage): Promise<boolean>;
  loginWithCredentials(
    page: LinkedInPage,
    credentials: { email: string; password: string; otp?: string }
  ): Promise<LinkedInLoginResult>;
}

/**
 * EVERY DOM SELECTOR, IN ONE TABLE, ON PURPOSE.
 *
 * LINKEDIN CHANGES THESE. Not "might": the profile action bar, the invite
 * modal and the message composer have all been re-labelled repeatedly, and
 * nothing published commits them to a shape. DRIFT IS THE EXPECTED STEADY
 * STATE OF THIS TABLE, which is why:
 *
 *   1. it is one exported constant rather than string literals scattered
 *      through three routines -- repairing drift is then a diff a reviewer can
 *      read, not an archaeology exercise;
 *   2. a miss is reported as `selector_drift` and NEVER as "the action failed"
 *      -- those are different facts, and conflating them would have the pacing
 *      engine ramp a seat down for a CSS change;
 *   3. a miss on a control we were about to CLICK means nothing was clicked.
 *      Anything ambiguous after a click is `unknown`, not drift.
 *
 * When a routine below starts returning `selector_drift` for everything, this
 * table is the thing to fix, and it is the only thing to fix.
 */
export const SELECTORS = {
  /** The primary "Connect" on the profile action bar. */
  connectButton: 'button[aria-label^="Invite"][aria-label*="connect"]',
  /** LinkedIn hides Connect behind "More" on many profiles. */
  moreActionsButton: 'button[aria-label="More actions"], button[aria-label="More"]',
  connectInMoreMenu: 'div[role="button"][aria-label^="Invite"]',
  addNoteButton: 'button[aria-label="Add a note"]',
  noteTextarea: 'textarea#custom-message, textarea[name="message"]',
  sendInviteButton: 'button[aria-label="Send invitation"], button[aria-label="Send now"]',
  sendWithoutNoteButton: 'button[aria-label="Send without a note"]',
  /** Open modal. Still visible after "send" means the send did not go through. */
  inviteModal: 'div[role="dialog"].send-invite, div.artdeco-modal[role="dialog"]',
  /** An invite already awaiting their answer. */
  pendingInvite: 'button[aria-label^="Pending"]',
  /** Present on 1st-degree profiles; also the DM entry point. */
  messageButton: 'button[aria-label^="Message"]',
  messageComposeBox: 'div.msg-form__contenteditable[contenteditable="true"]',
  messageSendButton: 'button.msg-form__send-button, button[type="submit"][aria-label="Send"]',
  /** "You've reached the weekly invitation limit" and its siblings. */
  limitWall:
    'text=/reached the weekly invitation limit|You.ve reached the limit|try again next week|invitation limit/i',
  /** A restriction notice, which is a limit wall wearing different words. */
  restrictionNotice: 'text=/temporarily restricted|unusual activity|account has been restricted/i',
  /** Captcha, PIN entry, or any other "prove you are a human" interstitial. */
  challengeForm: 'form.challenge, input[name="pin"], #captcha-internal, iframe[title*="challenge" i]',
  profileUnavailable: 'text=/This page doesn.t exist|Profile unavailable|page not found/i',
  /** The display name on a profile page. LinkedIn's top card carries exactly one h1. */
  profileHeading: 'main h1, h1',
  /**
   * "N connections" on the connections page, matched by TEXT rather than by
   * class. The class on that header has changed more often than anything else
   * in this table; the words have not.
   */
  connectionsCount: 'text=/[0-9][0-9.,\\s]*\\s*connections?/i',

  /* --- The sign-in form (see `loginWithCredentials`) ------------------- */

  /**
   * The two sign-in inputs: NAMED MARKUP FIRST, TYPE-BASED AFTER.
   *
   * `#username`/`session_key` is the older form and still answers on
   * /uas/login. The current React form gives its inputs GENERATED ids
   * (`input id="«R3jvukejj35655j6»"`) and no `name` at all, so the only stable
   * thing left about them is what they are -- an email box and a password box.
   *
   * `:visible` is load-bearing, not tidiness: that form is rendered TWICE, one
   * copy hidden, and `.first()` on an unfiltered match fills the hidden one and
   * submits an empty form.
   */
  loginEmailField: 'input#username, input[name="session_key"], input[type="email"]:visible',
  loginPasswordField: 'input#password, input[name="session_password"], input[type="password"]:visible',
  /**
   * OPTIONAL, unlike the two fields above.
   *
   * The current form's submit is a `<button type="button">` with hashed
   * classes, no id, no `data-litms-control-urn`, no `<form>` ancestor, and a
   * label that is whatever language LinkedIn decided the viewer speaks --
   * there is nothing on it to match that would survive a week. So when this
   * matches nothing, `loginWithCredentials` presses Enter in the password
   * field, which is what a person at that page does anyway.
   */
  loginSubmitButton: 'button[data-litms-control-urn="login-submit"], form.login__form button[type="submit"], form button[type="submit"]',
  /** "That's not the right password", "Couldn't find a LinkedIn account". */
  loginError:
    '#error-for-username, #error-for-password, div[error-for], .form__label--error, '
    + 'text=/that.s not the right password|Couldn.t find a LinkedIn account|we don.t recognize/i',
  /**
   * The verification-code box. ITS PRESENCE IS THE WHOLE 2FA/CAPTCHA
   * DISTINCTION: both land on /checkpoint/, and only one of them can be
   * finished by an operator typing six digits into a field we already have.
   */
  otpField: 'input[name="pin"], input#input__phone_verification_pin, input[autocomplete="one-time-code"]',
  otpSubmitButton: 'button#two-step-submit-button, button#email-pin-submit-button, form button[type="submit"]',
  /** The signed-in chrome. On every authenticated page, on no signed-out one. */
  globalNav: 'header.global-nav, nav.global-nav, .global-nav__me, img.global-nav__me-photo'
} as const;

/** Where a checkpoint lands. URL-level, so it is caught before any selector is read. */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

/** LinkedIn hosts this driver may navigate to. Nothing else, ever. */
const ALLOWED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/** Long enough for LinkedIn's client-side render, short enough not to stall a batch. */
const SETTLE_MS = 1_500;

function fail(failureKind: LinkedInFailureKind, detail: string): LinkedInDriverResult {
  return { ok: false, failureKind, detail };
}

/**
 * The canonical profile URL for an operator-supplied target.
 *
 * `target_ref` is an opaque string a human typed or a CSV supplied, and this
 * driver navigates an AUTHENTICATED browser to it. So the host is checked
 * rather than trusted: a target of `https://evil.example/steal` would
 * otherwise open a session-bearing tab on somebody else's site. Returns null
 * for anything that is not a LinkedIn URL or a bare handle.
 */
export function profileUrlFor(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  }
  const handle = trimmed.replace(/^\/+|\/+$/g, '').replace(/^in\//i, '');
  if (!/^[A-Za-z0-9\-_%À-ÿ]{1,120}$/.test(handle)) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(handle)}/`;
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    // A locator that cannot even be evaluated is drift, not presence. Reporting
    // `false` here would let a routine sail past a limit wall it failed to read.
    return false;
  }
}

/**
 * The three "stop now" reads, done BEFORE anything is clicked.
 *
 * Order matters: a challenge outranks a limit wall outranks a missing profile,
 * because a checkpoint page can also render the words "invitation limit" and
 * the human-intervention case is the one that must win.
 */
async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
  if (await present(page, SELECTORS.profileUnavailable)) return 'not_found';
  return null;
}

/** Navigate and read the walls. Returns the failure to report, or the URL. */
async function openProfile(page: LinkedInPage, target: string): Promise<{ url: string } | LinkedInDriverResult> {
  const url = profileUrlFor(target);
  if (!url) {
    return fail(
      'not_found',
      `'${target}' is not a LinkedIn profile URL or handle, so there is nothing to open. Targets are never resolved or guessed.`
    );
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    // Navigation failed, so no action was taken. Definite, and reported as
    // drift rather than `unknown`: nothing was clicked.
    return fail('selector_drift', `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const wall = await detectWall(page);
  if (wall) {
    return fail(
      wall,
      wall === 'challenge'
        ? `LinkedIn is showing a challenge at ${page.url()}. A human has to clear it in the profile window; nothing else will.`
        : wall === 'limit_wall'
          ? `LinkedIn refused at ${url}: a limit or restriction notice is on screen. This is LinkedIn asking us to stop.`
          : `${url} does not resolve to a profile.`
    );
  }
  return { url };
}

function isResult(value: { url: string } | LinkedInDriverResult): value is LinkedInDriverResult {
  return 'failureKind' in value;
}

/**
 * Send a connection invite, with the approved note if there is one.
 *
 * The note is passed through byte for byte or not at all. LinkedIn caps invite
 * notes (see `sequence.ts` `INVITE_NOTE_MAX_CHARS`), and enforcing that here by
 * truncating would send bytes no human approved -- so length is the sequence
 * generator's problem and a rejected note surfaces as an ordinary failure.
 */
export async function sendInvite(page: LinkedInPage, target: string, note?: string): Promise<LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;

  if (await present(page, SELECTORS.pendingInvite)) {
    return fail('already_connected', `An invite to ${url} is already pending; a second one is not a thing to send.`);
  }

  // Connect is either on the action bar or behind "More". Both are read before
  // anything is clicked, so a miss on both is unambiguously "nothing happened".
  let connect = page.locator(SELECTORS.connectButton);
  if ((await connect.count()) === 0) {
    const more = page.locator(SELECTORS.moreActionsButton);
    if ((await more.count()) === 0) {
      if (await present(page, SELECTORS.messageButton)) {
        return fail('already_connected', `${url} offers no Connect control and does offer Message, which is what a 1st-degree profile looks like.`);
      }
      return fail('selector_drift', `Neither ${SELECTORS.connectButton} nor ${SELECTORS.moreActionsButton} matched on ${url}. Nothing was clicked.`);
    }
    try {
      await more.first().click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    } catch (cause) {
      return fail('selector_drift', `Opening the More menu on ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    connect = page.locator(SELECTORS.connectInMoreMenu);
    if ((await connect.count()) === 0) {
      return fail('selector_drift', `The More menu on ${url} contains no ${SELECTORS.connectInMoreMenu}. Nothing was clicked.`);
    }
  }

  // EVERYTHING BELOW THIS LINE IS POST-CLICK. An error from here on cannot
  // prove the invite did not go out, so it reports `unknown` and the worker
  // holds the claim instead of retrying it into a duplicate.
  try {
    await connect.first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const wall = await detectWall(page);
    if (wall) {
      return fail(
        wall,
        `LinkedIn answered the Connect click on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}. The invite was refused, not sent.`
      );
    }

    if (note && note.trim()) {
      const addNote = page.locator(SELECTORS.addNoteButton);
      if ((await addNote.count()) > 0) {
        await addNote.first().click({ timeout: CLICK_TIMEOUT_MS });
        await page.waitForTimeout(SETTLE_MS);
      }
      const textarea = page.locator(SELECTORS.noteTextarea);
      if ((await textarea.count()) === 0) {
        // The modal is open and the note cannot be typed. Sending it without
        // the note would deliver something nobody approved, so this stops --
        // `unknown` because the modal is open and its state is ours to settle.
        return fail('unknown', `The invite modal for ${url} is open but ${SELECTORS.noteTextarea} did not match, so the approved note could not be typed. Settle this invite by hand.`);
      }
      await textarea.first().fill(note, { timeout: CLICK_TIMEOUT_MS });
      const send = page.locator(SELECTORS.sendInviteButton);
      if ((await send.count()) === 0) return fail('unknown', `No send control matched in the open invite modal for ${url}. Settle it by hand.`);
      await send.first().click({ timeout: CLICK_TIMEOUT_MS });
    } else {
      const withoutNote = page.locator(SELECTORS.sendWithoutNoteButton);
      const send = (await withoutNote.count()) > 0 ? withoutNote : page.locator(SELECTORS.sendInviteButton);
      if ((await send.count()) === 0) {
        // Some profiles send on the first click with no modal at all. If no
        // modal is on screen either, that is what happened.
        if (!(await present(page, SELECTORS.inviteModal))) {
          return { ok: true, externalRef: url, failureKind: null, detail: 'Invite sent without a modal step.' };
        }
        return fail('unknown', `An invite modal is open for ${url} with no send control matched. Settle it by hand.`);
      }
      await send.first().click({ timeout: CLICK_TIMEOUT_MS });
    }

    await page.waitForTimeout(SETTLE_MS);
    const afterSend = await detectWall(page);
    if (afterSend) {
      return fail(afterSend, `LinkedIn answered the send for ${url} with a ${afterSend === 'challenge' ? 'challenge' : 'limit wall'}.`);
    }
    if (await present(page, SELECTORS.inviteModal)) {
      return fail('unknown', `The invite modal for ${url} is still open after the send click; whether the invite left is unknown.`);
    }
    return { ok: true, externalRef: url, failureKind: null };
  } catch (cause) {
    return fail('unknown', `The invite to ${url} was interrupted after the Connect click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`);
  }
}

/** Send a direct message. 1st-degree only, which the Message control is the proof of. */
export async function sendDm(page: LinkedInPage, target: string, body: string): Promise<LinkedInDriverResult> {
  if (!body.trim()) {
    return fail('selector_drift', 'Refusing to open a message composer with no approved body to put in it.');
  }
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;

  const message = page.locator(SELECTORS.messageButton);
  if ((await message.count()) === 0) {
    return fail('selector_drift', `${SELECTORS.messageButton} did not match on ${url}. Nothing was clicked.`);
  }

  try {
    await message.first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const wall = await detectWall(page);
    if (wall) return fail(wall, `LinkedIn answered the Message click on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}.`);

    const compose = page.locator(SELECTORS.messageComposeBox);
    if ((await compose.count()) === 0) {
      return fail('unknown', `The composer for ${url} did not appear as ${SELECTORS.messageComposeBox}; a draft may be open. Check it by hand.`);
    }
    await compose.first().fill(body, { timeout: CLICK_TIMEOUT_MS });

    const send = page.locator(SELECTORS.messageSendButton);
    if ((await send.count()) === 0) {
      return fail('unknown', `The composer for ${url} holds the approved body but no send control matched. Send or discard it by hand.`);
    }
    await send.first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const afterSend = await detectWall(page);
    if (afterSend) return fail(afterSend, `LinkedIn answered the message send for ${url} with a ${afterSend === 'challenge' ? 'challenge' : 'limit wall'}.`);
    return { ok: true, externalRef: url, failureKind: null };
  } catch (cause) {
    return fail('unknown', `The message to ${url} was interrupted after the composer opened: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`);
  }
}

/**
 * View a profile. The whole action is the navigation -- LinkedIn records the
 * view server-side the moment the page loads, so there is nothing to click and
 * no post-click ambiguity to report.
 */
export async function viewProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  return { ok: true, externalRef: opened.url, failureKind: null };
}

/* ---------------------------------------------------------------------------
 * Reading the operator's own seat out of the live session.
 * ------------------------------------------------------------------------ */

/** LinkedIn redirects this to the signed-in member's own vanity URL. */
const ME_URL = 'https://www.linkedin.com/in/me/';

/**
 * The connections list, and the ONLY place the exact count is readable.
 *
 * The profile page caps its own badge at "500+", so reading the count there
 * would record 500 for a 4,000-connection account -- a wrong number wearing
 * the shape of a right one.
 */
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

/** Narrow a `readSeat` answer. A read carries no `failureKind`; a failure always does. */
export function isSeatRead(value: LinkedInSeatRead | LinkedInDriverResult): value is LinkedInSeatRead {
  return !('failureKind' in value);
}

/**
 * `page.url()` reduced to the canonical profile form.
 *
 * Query and hash are dropped and the host is re-checked against ALLOWED_HOSTS,
 * for the same reason `profileUrlFor` checks it: this string is stored on the
 * seat and compared against `linkedin_actions.target_ref`, so a `?trk=...` on
 * the end would make one person two people to the replay guard. It is built by
 * `profileUrlFor` itself rather than by a second formatter, so the two can
 * never drift into producing different strings for the same handle.
 */
export function normalisedProfileUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = /^\/in\/([^/]+)\/*$/.exec(parsed.pathname);
  if (!match) return null;
  let handle = match[1];
  try {
    handle = decodeURIComponent(handle);
  } catch {
    // A malformed escape is the browser's own string. Passed through as-is
    // rather than repaired into something LinkedIn never said.
  }
  return profileUrlFor(handle);
}

/** "1,234 connections" -> 1234. Null when the text carries no number at all. */
export function parseConnectionsCount(text: string): number | null {
  const match = /([0-9][0-9.,   ]*)\s*connections?/i.exec(text);
  if (!match) return null;
  const digits = match[1].replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/** The first match's collapsed text. Null for absent, empty, or unreadable. */
async function readText(page: LinkedInPage, selector: string): Promise<string | null> {
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
 * Read the seat out of the session the operator logged into by hand.
 *
 * THIS IS WHY THE SETUP FORM CAN GO. Waalaxy, Dripify and HeyReach ask an
 * operator for exactly one thing -- log in -- and read everything else from
 * the session. So does this: the profile URL, the display name and the exact
 * connection count are all facts the signed-in browser already holds, and none
 * of them is worth asking a human to type and then trusting.
 *
 * A PARTIAL READ IS A SUCCESS. Anything unreadable lands in `degraded` as a
 * sentence and its field comes back null -- never zero, never a guess.
 *
 * A CHALLENGE IS NOT A DEGRADATION. If LinkedIn wants a human at any point,
 * this returns the ordinary failure shape and the caller tells the operator to
 * go and log in. Storing a seat read through a half-authenticated session
 * would be recording a guess as a fact.
 */
export async function readSeat(page: LinkedInPage): Promise<LinkedInSeatRead | LinkedInDriverResult> {
  const degraded: string[] = [];

  try {
    await page.goto(ME_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    return fail('selector_drift', `Could not open ${ME_URL}: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was read.`);
  }

  const wall = await detectWall(page);
  if (wall) {
    return fail(
      wall,
      wall === 'challenge'
        ? `LinkedIn is showing a challenge or a login page at ${page.url()} instead of your profile. A human has to clear it in the profile window; nothing else will.`
        : wall === 'limit_wall'
          ? `LinkedIn answered ${ME_URL} with a limit or restriction notice. This is LinkedIn asking us to stop, so nothing was read.`
          : `${ME_URL} does not resolve to a profile, which is what a signed-out session looks like.`
    );
  }

  const landed = page.url();
  const profileUrl = normalisedProfileUrl(landed);
  if (!profileUrl) {
    // /in/me/ redirects to the vanity URL for a signed-in member and nowhere
    // useful otherwise, so this is the signed-out case wearing a 200. Reported
    // as `challenge` because the fix is the same one: a human logs in.
    return fail(
      'challenge',
      `${ME_URL} did not redirect to a LinkedIn profile URL -- it landed on '${landed}', which is what a signed-out or challenged session looks like.`
    );
  }

  const name = await readText(page, SELECTORS.profileHeading);
  if (name === null) {
    degraded.push(`The profile page at ${profileUrl} has no readable heading, so the display name could not be read.`);
  }

  try {
    await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    degraded.push(
      `The connections page could not be opened (${cause instanceof Error ? cause.message : String(cause)}), so the connection count is unknown and is left unset.`
    );
    return { ok: true, profileUrl, name, connectionsCount: null, degraded };
  }

  const connectionsWall = await detectWall(page);
  if (connectionsWall === 'challenge') {
    // The session stopped being usable half way through the read. That needs a
    // person, and it is not a thing to record as "partially detected".
    return fail(
      'challenge',
      `LinkedIn is showing a challenge at ${page.url()} while reading the connection count. A human has to clear it in the profile window.`
    );
  }
  if (connectionsWall) {
    degraded.push(
      `LinkedIn answered the connections page with a ${connectionsWall === 'limit_wall' ? 'limit or restriction notice' : 'not-found page'}, so the connection count is unknown and is left unset.`
    );
    return { ok: true, profileUrl, name, connectionsCount: null, degraded };
  }

  const header = await readText(page, SELECTORS.connectionsCount);
  const connectionsCount = header === null ? null : parseConnectionsCount(header);
  if (connectionsCount === null) {
    degraded.push(
      header === null
        ? 'The connections page shows no "N connections" header, so the connection count is unknown. It is left unset rather than recorded as zero.'
        : `The connections header read '${header}', which carries no number, so the connection count is unknown and is left unset.`
    );
  }

  return { ok: true, profileUrl, name, connectionsCount, degraded };
}

/* ---------------------------------------------------------------------------
 * Signing in: the fallback, never the default.
 * ------------------------------------------------------------------------ */

const LOGIN_URL = 'https://www.linkedin.com/login';

/**
 * Is this browser profile already signed in?
 *
 * ASKED BEFORE EVERY SIGN-IN, and it is the reason the credential path is a
 * fallback rather than a routine. A persistent user-data-dir keeps LinkedIn's
 * cookies for weeks; re-authenticating anyway would be slower on every run and,
 * more importantly, a much stronger ban signal than a session that simply keeps
 * working (plan 1.3). The cheapest safe automation is the automation that logs
 * in least.
 *
 * `/in/me/` is the probe rather than a selector on `/feed/`, because it is the
 * same signal `readSeat` already trusts: LinkedIn redirects it to the signed-in
 * member's own vanity URL and nowhere useful otherwise, so the ANSWER IS THE
 * URL and no markup has to hold still for it. The global-nav check is a second
 * chance for a signed-in page that landed somewhere unexpected, never the first.
 *
 * NEVER THROWS. Anything it could not determine is `false`, which costs a
 * sign-in attempt that was probably unnecessary -- the cheap wrong answer.
 */
export async function isLoggedIn(page: LinkedInPage): Promise<boolean> {
  try {
    await page.goto(ME_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch {
    return false;
  }
  if (CHECKPOINT_PATH.test(page.url())) return false;
  if (normalisedProfileUrl(page.url())) return true;
  return present(page, SELECTORS.globalNav);
}

/**
 * Type the operator's own email and password into LinkedIn's sign-in form.
 *
 * NEITHER VALUE SURVIVES THIS CALL. They arrive as arguments, go into two
 * `fill()`s, and are never assigned to anything that outlives the function,
 * never logged, and -- the rule that matters most -- never interpolated into a
 * returned `detail`. Every message below is built from constants, selector
 * names and `page.url()`.
 *
 * THE FOUR ANSWERS, and telling them apart is the entire job:
 *
 *   { ok: true }               signed in. The persistent user-data-dir now
 *                              holds the session; the caller stamps
 *                              `session_valid_at` so the next run reuses it.
 *   { ok: false, needsOtp }    LinkedIn wants a 2FA code. NOT A FAILURE -- it
 *                              is a step, and the operator finishes it by
 *                              calling again with `otp`.
 *   failureKind 'challenge'    a captcha or device verification. A PERSON has
 *                              to clear this in a real window; no code we could
 *                              write finishes it, and pretending otherwise
 *                              would have the caller retry into a lockout.
 *   failureKind 'not_found'    LinkedIn does not recognise this pair. Definite,
 *                              in the exact sense the vocabulary already gives
 *                              that kind: the sign-in did not happen and will
 *                              not happen on a retry with the same input. The
 *                              six kinds are not widened for this -- a seventh
 *                              would have to mean something to the batch loop,
 *                              and no action ever returns it.
 */
export async function loginWithCredentials(
  page: LinkedInPage,
  credentials: { email: string; password: string; otp?: string }
): Promise<LinkedInLoginResult> {
  const otp = credentials.otp?.trim() ?? '';

  // THE CODE PATH FIRST, and only when a code box is already on screen. An OTP
  // answers a challenge page a previous call left open; navigating to /login
  // again would discard it and make LinkedIn issue a second code, which is how
  // an operator ends up typing an expired one forever.
  if (otp && (await present(page, SELECTORS.otpField))) return submitOtp(page, otp);

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    return fail('selector_drift', `Could not open the LinkedIn sign-in page: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was typed.`);
  }

  const email = page.locator(SELECTORS.loginEmailField);
  if ((await email.count()) === 0) {
    // /login on a live session redirects to the feed, which is a success we
    // reached by a different door.
    if (await present(page, SELECTORS.globalNav)) return { ok: true };
    // Otherwise LinkedIn skipped the form and went straight to a checkpoint,
    // which `readLoginStanding` is exactly the reader for.
    if (CHECKPOINT_PATH.test(page.url()) || (await present(page, SELECTORS.otpField))) return readLoginStanding(page, otp);
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginEmailField}. Nothing was typed.`);
  }

  // BOTH CONTROLS ARE READ BEFORE EITHER IS FILLED, so a miss on the second is
  // unambiguously "nothing was typed" rather than "an email address is sitting
  // in a form we then abandoned".
  const password = page.locator(SELECTORS.loginPasswordField);
  if ((await password.count()) === 0) {
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginPasswordField}. Nothing was typed.`);
  }
  // A MISSING SUBMIT BUTTON IS NOT A FAILURE HERE (see the selector's note):
  // the password field's Enter key submits the same form, and refusing the
  // sign-in over a button we cannot name would strand every seat the moment
  // LinkedIn reskins its login page -- which is exactly what it did.
  const submit = page.locator(SELECTORS.loginSubmitButton);
  const submitByClick = (await submit.count()) > 0;
  const passwordField = password.first();
  if (!submitByClick && typeof passwordField.press !== 'function') {
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginSubmitButton}, and this page cannot press a key. Nothing was typed.`);
  }

  try {
    await email.first().fill(credentials.email, { timeout: CLICK_TIMEOUT_MS });
    // The one moment the password exists outside the vault. `cause.message`
    // below is Playwright's own text about a timeout or a detached node and
    // never contains what was typed -- `fill` does not echo its argument.
    await passwordField.fill(credentials.password, { timeout: CLICK_TIMEOUT_MS });
    if (submitByClick) await submit.first().click({ timeout: CLICK_TIMEOUT_MS });
    else await passwordField.press!('Enter', { timeout: CLICK_TIMEOUT_MS });
    // Twice the usual settle: this navigation is a full page load plus a
    // redirect, and reading the standing early reads the page we just left.
    await page.waitForTimeout(SETTLE_MS * 2);
  } catch (cause) {
    return fail('unknown', `The sign-in was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether the session opened is unknown.`);
  }

  return readLoginStanding(page, otp);
}

/**
 * What LinkedIn did with the sign-in, read off whatever is now on screen.
 *
 * THE ORDER IS THE POINT. `SELECTORS.challengeForm` matches `input[name="pin"]`,
 * so `detectWall` would call a two-factor prompt a challenge -- reporting "a
 * human must clear this" when the human only has to type six digits into the
 * box we are already looking at. The code box is therefore read FIRST, and
 * `challenge` means what is left: a captcha or a device verification.
 */
async function readLoginStanding(page: LinkedInPage, otp: string): Promise<LinkedInLoginResult> {
  if (await present(page, SELECTORS.otpField)) {
    if (otp) return submitOtp(page, otp);
    return { ok: false, needsOtp: true };
  }

  const wall = await detectWall(page);
  if (wall === 'challenge') {
    return fail(
      'challenge',
      `LinkedIn is holding this sign-in at ${page.url()} for a device check, which only a person at a browser window can finish.`
    );
  }
  if (wall) {
    return fail(
      wall,
      `LinkedIn answered the sign-in with a ${wall === 'limit_wall' ? 'limit or restriction notice' : 'not-found page'}, so no session was opened.`
    );
  }

  if (await present(page, SELECTORS.loginError)) {
    // Definite and un-retryable with the same input, which is what 'not_found'
    // already means in this vocabulary. The message names neither value.
    return fail('not_found', 'LinkedIn did not accept that email address and password. Save the right ones and sign in again.');
  }

  if (await isLoggedIn(page)) return { ok: true };

  return fail('unknown', `The sign-in at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`);
}

/** Type a verification code and read what happened. Never called without one. */
async function submitOtp(page: LinkedInPage, otp: string): Promise<LinkedInLoginResult> {
  const field = page.locator(SELECTORS.otpField);
  if ((await field.count()) === 0) {
    return fail('selector_drift', `No verification-code box matched ${SELECTORS.otpField}, so the code was not typed.`);
  }
  const submit = page.locator(SELECTORS.otpSubmitButton);
  if ((await submit.count()) === 0) {
    return fail('selector_drift', `The verification-code box has no submit control matching ${SELECTORS.otpSubmitButton}, so the code was not sent.`);
  }

  try {
    await field.first().fill(otp, { timeout: CLICK_TIMEOUT_MS });
    await submit.first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS * 2);
  } catch (cause) {
    return fail('unknown', `The verification code was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether the session opened is unknown.`);
  }

  // Still a code box: wrong or expired. Asking for another code is the whole
  // fix, so this is `needsOtp` again rather than a failure the operator would
  // have to interpret.
  if (await present(page, SELECTORS.otpField)) return { ok: false, needsOtp: true };

  const wall = await detectWall(page);
  if (wall) {
    return fail(
      wall,
      wall === 'challenge'
        ? `LinkedIn answered the verification code at ${page.url()} with a device check, which only a person at a browser window can finish.`
        : `LinkedIn answered the verification code with a ${wall === 'limit_wall' ? 'limit or restriction notice' : 'not-found page'}, so no session was opened.`
    );
  }

  if (await isLoggedIn(page)) return { ok: true };
  return fail('unknown', `The verification code at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`);
}

/**
 * The real driver. `local-worker.ts` takes this as a parameter so tests can
 * pass a fake.
 *
 * The three engagement routines and the inbox reply are imported here rather
 * than re-implemented, so there is exactly one composed driver and the worker
 * has one thing to dispatch against. The import is at the BOTTOM of this file
 * and the sibling modules import only types and hoisted functions back, which
 * is what keeps the cycle harmless: nothing in `driver-engage.ts` or
 * `driver-inbox.ts` reads a binding from this file at module-evaluation time.
 */
export const playwrightDriver: LinkedInDriver = {
  sendInvite,
  sendDm,
  sendReply,
  viewProfile,
  followProfile,
  likeRecentPost,
  endorseSkills,
  readSeat,
  isLoggedIn,
  loginWithCredentials
};
