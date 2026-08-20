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
import {
  disconnectProfile,
  endorseSkills,
  followProfile,
  likeRecentPost,
  unfollowProfile
} from './driver-engage.js';
import { publishPost } from './driver-post.js';
import {
  listConversations,
  readThread,
  sendReply,
  type LinkedInThreadListing,
  type LinkedInThreadTranscript
} from './driver-inbox.js';
import { hoverClick, readPage, settle, typeLike } from './human.js';

/** The seven outcomes a routine may report. Ordered as in plan 4.5. */
export type LinkedInFailureKind =
  | 'not_found'
  | 'already_connected'
  | 'limit_wall'
  | 'challenge'
  | 'selector_drift'
  | 'unknown'
  | 'compose_unavailable'
  | 'paid_credit_required';

export interface LinkedInDriverResult {
  ok: boolean;
  /** The canonical profile URL the action landed on. Absent on failure. */
  externalRef?: string;
  /** Null exactly when `ok` is true. */
  failureKind: LinkedInFailureKind | null;
  /** Written for the operator reading the ledger later, not for a log grep. */
  detail?: string;
  /** Verified channel facts discovered while performing the action. */
  metadata?: Record<string, unknown>;
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
  /** Optional Playwright file-input primitive, used only after a workflow explicitly carries media. */
  setInputFiles?(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  /**
   * Optional because only the sign-in form needs it, and every fake in the
   * tests would otherwise have to grow a method it never calls. Absent means
   * "this locator cannot type a key", which the one caller treats as a missing
   * submit control rather than as a failure.
   */
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  /**
   * OPTIONAL, and absent on every fake here for the same reason `press` is.
   *
   * `hover` walks the pointer to the control before it is clicked, and
   * `pressSequentially` puts text in a field one keystroke at a time. Both are
   * BEHAVIOUR, never correctness -- see `human.ts` for why a click with no
   * preceding pointer movement and a note that materialises in one `input`
   * event are two of the loudest automation signals a page can emit. A locator
   * without them does exactly what this file did before they existed.
   */
  hover?(options?: { timeout?: number }): Promise<void>;
  pressSequentially?(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
  /**
   * OPTIONAL, for the one read where LAYOUT IS CONTENT: a message body.
   *
   * `textContent` concatenates text nodes, and a `<br>` is not a text node --
   * so a message somebody wrote as three paragraphs came back as one run-on
   * line and was stored, and shown, that way. `innerText` is the RENDERED
   * text, line breaks included. Absent means the read falls back to
   * `textContent`: the words are still right, they are simply flat.
   */
  innerText?(options?: { timeout?: number }): Promise<string>;
}

export interface LinkedInPage {
  goto(
    url: string,
    options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }
  ): Promise<unknown>;
  url(): string;
  locator(selector: string): LinkedInLocator;
  waitForTimeout(ms: number): Promise<void>;
  /**
   * OPTIONAL. Real Playwright has both; no fake in this repo does.
   *
   * `mouse` is what makes a page that was READ look different from a page that
   * was HARVESTED (`readPage`), and `keyboard` is only ever used to put a line
   * break in a composer with `Shift+Enter` instead of an Enter that would send
   * the message half-written. Absent either one, the driver behaves exactly as
   * it did before.
   */
  mouse?: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard?: {
    press(key: string, options?: { delay?: number }): Promise<void>;
  };
  /**
   * OPTIONAL, and the most durable fact on a LinkedIn page: `<Name> | LinkedIn`
   * in every language, while the markup around it is hashed and reshuffled.
   * Read only when the heading selector finds nothing.
   */
  title?(): Promise<string>;
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
export type LinkedInLoginResult =
  { ok: true } | LinkedInDriverResult | { ok: false; needsOtp: true };

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
export interface LinkedInAttachment {
  url: string;
  name?: string | null;
  mediaKind?: 'file' | 'gif' | 'voice' | null;
}

export interface LinkedInDriver {
  sendInvite(page: LinkedInPage, target: string, note?: string): Promise<LinkedInDriverResult>;
  sendDm(
    page: LinkedInPage,
    target: string,
    body: string,
    options?: { attachment?: LinkedInAttachment | null }
  ): Promise<LinkedInDriverResult>;
  sendInMail?(
    page: LinkedInPage,
    target: string,
    subject: string,
    body: string,
    options?: { allowPaid?: boolean; attachment?: LinkedInAttachment | null }
  ): Promise<LinkedInDriverResult>;
  /**
   * Answer inside an existing conversation, by thread id rather than by
   * profile. NOT `sendDm` with different words: `sendDm` navigates to a profile
   * and opens a fresh composer, which for somebody already in the inbox opens
   * the wrong surface and can start a second conversation with the same person.
   */
  sendReply(page: LinkedInPage, threadUrn: string, body: string): Promise<LinkedInDriverResult>;
  /**
   * Re-read a conversation, LinkedIn's own record of it rather than Trevra's.
   *
   * Optional, and used for exactly one thing: `runLinkedInLocalBatch` calls it
   * right after `sendReply` lands, so the words just typed show up in the
   * transcript without an operator having to click "Sync this thread"
   * afterwards. A driver with no inbox-reading capability, or a test double
   * that never exercises this path, simply omits it -- the reply itself does
   * not depend on it.
   */
  readThread?(
    page: LinkedInPage,
    threadUrn: string,
    options?: { maxMessages?: number; now?: () => Date }
  ): Promise<LinkedInThreadTranscript | LinkedInDriverResult>;
  /**
   * Walk the inbox rail. Optional, and used for exactly one thing: right
   * after `sendDm` succeeds, `runLinkedInLocalBatch` looks a few conversations
   * deep for the one LinkedIn just opened -- a first message has no thread id
   * to hand `readThread` the way a reply does, and this is the only way to
   * find one. A driver with no inbox-reading capability simply omits it, same
   * as `readThread`.
   */
  listConversations?(
    page: LinkedInPage,
    options?: {
      maxThreads?: number;
      needsProfileUrl?: (threadUrn: string) => boolean;
      now?: () => Date;
    }
  ): Promise<LinkedInThreadListing | LinkedInDriverResult>;
  viewProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  followProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  unfollowProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  disconnectProfile(page: LinkedInPage, target: string): Promise<LinkedInDriverResult>;
  /** `seed` is the batch-scoped seed for the deterministic in-action click jitter. */
  likeRecentPost(
    page: LinkedInPage,
    target: string,
    options?: { seed?: string }
  ): Promise<LinkedInDriverResult>;
  endorseSkills(
    page: LinkedInPage,
    target: string,
    options?: { seed?: string; maxSkills?: number }
  ): Promise<LinkedInDriverResult>;
  /** Publish a rendered post to the feed. Optional -- see `driver-post.ts`, which owns its own selector table. */
  publishPost?(page: LinkedInPage, body: string): Promise<LinkedInDriverResult>;
  readSeat(
    page: LinkedInPage,
    options?: { skipConnections?: boolean }
  ): Promise<LinkedInSeatRead | LinkedInDriverResult>;
  /** Is this profile already signed in? Asked BEFORE any sign-in is attempted. */
  isLoggedIn(page: LinkedInPage): Promise<boolean>;
  /**
   * Why a companion session that failed the signed-in probe needs a human.
   * Optional so test doubles and non-companion callers do not have to know
   * about the recovery UI.
   */
  sessionRecoveryReason?(page: LinkedInPage): Promise<'challenge' | 'signed_out'>;
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
  /**
   * The connection-degree badge on the profile top card -- "1st", "2nd", "3rd+".
   *
   * THE ONLY PLACE LINKEDIN STATES A RELATIONSHIP RATHER THAN IMPLYING ONE, and
   * therefore the only honest answer to "did they accept". Everything else on
   * the page is circumstantial: the Message control appears for 1st-degree
   * connections AND for anyone already in the inbox AND on an open-profile
   * account, and the absence of a Connect button means as many things.
   *
   * Matched loosely on purpose. The badge has shipped as `span.dist-value`
   * inside `span.distance-badge`, as a bare `.distance-badge`, and inside a
   * hashed top-card container; the class fragment `distance-badge` has outlived
   * all three. A miss here is reported as an UNREAD degree, never as "not
   * connected" -- see {@link readProfileDegree}.
   */
  degreeBadge:
    'span.dist-value, span.distance-badge, span[class*="distance-badge"], .pv-top-card__distance-badge',
  /** Present on 1st-degree profiles; also the DM entry point. */
  messageButton: 'button[aria-label^="Message"]',
  messageComposeBox: 'div.msg-form__contenteditable[contenteditable="true"]',
  messageSendButton: 'button.msg-form__send-button, button[type="submit"][aria-label="Send"]',
  messageAttachmentInput:
    'div.msg-form__msg-content-container input[type="file"], form input[type="file"]',
  messageAttachmentPreview:
    '.msg-form__attachment-upload, .msg-attachment-list, [data-test-attachment], [aria-label*="attachment" i] img',
  /** InMail is a distinct paid/entitled surface; never fall back to Message. */
  inmailButton:
    'button[aria-label*="InMail" i], a[aria-label*="InMail" i], button:has-text("InMail")',
  inmailSubject:
    'input[name="subject"], input[placeholder*="Subject" i], input[aria-label*="Subject" i]',
  inmailComposeBox:
    'div.msg-form__contenteditable[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
  inmailSendButton:
    'button[aria-label*="Send InMail" i], button.msg-form__send-button, button[type="submit"]:has-text("Send")',
  inmailPaidWarning:
    'text=/paid InMail|credit will be used|use an InMail credit|purchase.*credit/i',
  inmailAttachmentInput: 'div[role="dialog"] input[type="file"], form input[type="file"]',
  inmailAttachmentPreview:
    'div[role="dialog"] .msg-form__attachment-upload, div[role="dialog"] .msg-attachment-list, div[role="dialog"] [data-test-attachment]',
  /** "You've reached the weekly invitation limit" and its siblings. */
  limitWall:
    'text=/reached the weekly invitation limit|You.ve reached the limit|try again next week|invitation limit/i',
  /** A restriction notice, which is a limit wall wearing different words. */
  restrictionNotice: 'text=/temporarily restricted|unusual activity|account has been restricted/i',
  /** Captcha, PIN entry, or any other "prove you are a human" interstitial. */
  challengeForm:
    'form.challenge, input[name="pin"], #captcha-internal, iframe[title*="challenge" i]',
  profileUnavailable: 'text=/This page doesn.t exist|Profile unavailable|page not found/i',
  /**
   * The display name on a profile page.
   *
   * KEPT, BUT NO LONGER TRUSTED ALONE. LinkedIn's current profile renders the
   * name in a `<p>` inside hash-classed divs and the page carries NO `h1` at
   * all -- measured on a live seat, where this selector matched nothing and the
   * read came back "the profile page has no readable heading". `readSeat` falls
   * back to the document title, which names the profile in every language and
   * survives the class churn this table keeps losing to.
   */
  profileHeading: 'main h1, h1',
  /**
   * "N connections" on the connections page, matched by TEXT rather than by
   * class. The class on that header has changed more often than anything else
   * in this table; the words have not.
   */
  connectionsCount: 'text=/[0-9][0-9.,\\s]*\\s*connections?/i',
  /**
   * THE SAME HEADER IN A LANGUAGE NOBODY LISTED.
   *
   * The English selector above is exact and stays first, but LinkedIn renders
   * its interface in the MEMBER's language, not the operator's: the seat that
   * exposed this reads `1 Kontakt`, and `/connections?/i` will never match it.
   * Enumerating LinkedIn's two dozen translations would be a table that goes
   * stale silently, so this matches the SHAPE every one of them shares -- a
   * number, then one word -- scoped to the page's main region so the navigation
   * chrome and the ad rail cannot answer.
   *
   * `parseConnectionsCount` still has the last word, and caps what it will
   * believe: see `MAX_CONNECTIONS`.
   */
  // The backslashes are DOUBLED because this string is parsed twice: Playwright
  // unescapes the quoted argument before compiling it as a regular expression,
  // so a single `\s` here reaches the regex as a literal 's' and the selector
  // silently matches nothing. Measured against the live page -- the doubled
  // form finds `1 Kontakt`, the single form finds zero elements.
  connectionsCountAny:
    'main :text-matches("^\\\\s*[0-9][0-9.,\\\\u00a0\\\\u202f ]*\\\\s+\\\\S+\\\\s*$")',

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
  loginPasswordField:
    'input#password, input[name="session_password"], input[type="password"]:visible',
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
  loginSubmitButton:
    'button[data-litms-control-urn="login-submit"], form.login__form button[type="submit"], form button[type="submit"]',
  /** "That's not the right password", "Couldn't find a LinkedIn account". */
  loginError:
    '#error-for-username, #error-for-password, div[error-for], .form__label--error, ' +
    'text=/that.s not the right password|Couldn.t find a LinkedIn account|we don.t recognize/i',
  /**
   * The verification-code box. ITS PRESENCE IS THE WHOLE 2FA/CAPTCHA
   * DISTINCTION: both land on /checkpoint/, and only one of them can be
   * finished by an operator typing six digits into a field we already have.
   */
  otpField:
    'input[name="pin"], input#input__phone_verification_pin, input[autocomplete="one-time-code"]',
  otpSubmitButton:
    'button#two-step-submit-button, button#email-pin-submit-button, form button[type="submit"]',
  /**
   * The signed-in chrome. On every authenticated page, on no signed-out one.
   *
   * THE `global-nav` CLASSES ARE GONE. LinkedIn's current chrome is hashed
   * (`header class="a7971c7d c099d5b6 ..."`) and carries no `global-nav`
   * anywhere -- measured on the live seat, where all four of the old selectors
   * matched ZERO elements on a perfectly signed-in feed. What that cost is the
   * whole system: `isLoggedIn` said no on every pass, every job then tried to
   * sign in, `/login` redirected the live session straight back to the feed,
   * and the sign-in reported "the sign-in page shows no input#username". Every
   * LinkedIn action in the product failed on that sentence, and none of them
   * had anything wrong with them.
   *
   * The classes are KEPT, because an older UI still answers on them, and two
   * markers are added that do not depend on a class name or on a language:
   * the member navigation's own React ref id, and a link to /mynetwork/, which
   * is a destination no signed-out page offers.
   */
  globalNav:
    'header.global-nav, nav.global-nav, .global-nav__me, img.global-nav__me-photo, ' +
    '#primaryNavLinksComponentRef, header a[href*="/mynetwork/"], nav a[href*="/mynetwork/"]'
} as const;

/** Where a checkpoint lands. URL-level, so it is caught before any selector is read. */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

/** LinkedIn hosts this driver may navigate to. Nothing else, ever. */
const ALLOWED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/**
 * THERE IS NO `SETTLE_MS` HERE ANY MORE, and its absence is the point.
 *
 * It was `1_500` in this file, in `driver-engage.ts`, in `driver-inbox.ts`, in
 * `driver-withdraw.ts` and in `driver-scrape.ts`. Five files agreeing on a
 * millisecond value is a timer, and a page that loads, waits exactly 1.500s
 * and then clicks is a timer LinkedIn can read in telemetry it already keeps
 * per member. Every pause is now `settle()` from `human.ts`: drawn from a
 * band, seeded from the URL and the step so it stays reproducible, and never
 * the same twice in one session.
 */
/**
 * A recognised device shows "We're logging you in" -- an interstitial with NO
 * form on it at all -- before it redirects to either the feed or a checkpoint.
 * Observed real-world redirects land ~4s after DOMContentLoaded, so a single
 * settle-and-read lands mid-interstitial and misreports a live redirect as
 * `selector_drift`. This is the outer budget the poll below is allowed to
 * spend waiting that redirect out; the common case (the form is already there)
 * never uses more than one iteration of it.
 */
const LOGIN_REDIRECT_TIMEOUT_MS = 8_000;
const LOGIN_REDIRECT_POLL_MS = 500;

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

/**
 * Reach a profile by CLICKING A LINK TO IT, when the page already shows one.
 *
 * WHY THIS IS NOT COSMETIC, and why it is the last structural difference
 * between this driver and a person. LinkedIn is a single-page app: when a
 * member clicks a profile link, the router handles it client-side -- no
 * document load, a `pageInstance` chain that ties the new view to the one it
 * came from, and a referer. When this driver calls `page.goto`, LinkedIn gets
 * a COLD DOCUMENT LOAD of `/in/<stranger>/` with no view before it and nothing
 * that led to it, which is what a scraper working from a list of URLs looks
 * like -- because that is exactly what it is.
 *
 * So: if a link to the target is already on screen -- a search result, a feed
 * card, a connections row, a notification -- click it and let the SPA route.
 * The click goes through `hoverClick`, so it carries pointer movement too.
 *
 * FALSE MEANS "NOTHING HAPPENED, USE THE ADDRESS BAR", and every failure path
 * returns it: no link, a click that threw, or a click that landed somewhere
 * other than the profile asked for. The caller's `goto` then runs exactly as
 * it did before, so this can only ever be an improvement on the load it
 * replaces -- never a way to end up on the wrong profile, because the landing
 * URL is checked against the requested one before this claims success.
 */
async function followLinkTo(page: LinkedInPage, url: string): Promise<boolean> {
  if (!onLinkedIn(page.url())) return false;
  const handle = /\/in\/([^/?#]+)/.exec(url)?.[1];
  if (!handle) return false;
  try {
    const link = page.locator(`a[href*="/in/${handle}"]`);
    if ((await link.count()) === 0) return false;
    await hoverClick(page, link.first(), `${url}#link`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#route`);
    return normalisedProfileUrl(page.url()) === url;
  } catch {
    // A link that would not be clicked says nothing about the profile behind
    // it. The caller loads it the old way.
    return false;
  }
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
async function openProfile(
  page: LinkedInPage,
  target: string
): Promise<{ url: string } | LinkedInDriverResult> {
  const url = profileUrlFor(target);
  if (!url) {
    return fail(
      'not_found',
      `'${target}' is not a LinkedIn profile URL or handle, so there is nothing to open. Targets are never resolved or guessed.`
    );
  }
  try {
    // A LINK IF THERE IS ONE, THE ADDRESS BAR ONLY IF THERE IS NOT.
    if (!(await followLinkTo(page, url))) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    }
    await settle(page, `${url}#open`);
    // A profile that is opened and acted on inside two seconds, with no pointer
    // movement and no scroll in between, is the exact shape the 2026-08-14
    // investigation found LinkedIn scoring. Read it first, the way the person
    // about to click Connect would read it. Decoration only: never throws.
    await readPage(page, `${url}#read`);
  } catch (cause) {
    // Navigation failed, so no action was taken. Definite, and reported as
    // drift rather than `unknown`: nothing was clicked.
    return fail(
      'selector_drift',
      `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
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
export async function sendInvite(
  page: LinkedInPage,
  target: string,
  note?: string
): Promise<LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;

  if (await present(page, SELECTORS.pendingInvite)) {
    return fail(
      'already_connected',
      `An invite to ${url} is already pending; a second one is not a thing to send.`
    );
  }

  // Connect is either on the action bar or behind "More". Both are read before
  // anything is clicked, so a miss on both is unambiguously "nothing happened".
  let connect = page.locator(SELECTORS.connectButton);
  if ((await connect.count()) === 0) {
    const more = page.locator(SELECTORS.moreActionsButton);
    if ((await more.count()) === 0) {
      if (await present(page, SELECTORS.messageButton)) {
        return fail(
          'already_connected',
          `${url} offers no Connect control and does offer Message, which is what a 1st-degree profile looks like.`
        );
      }
      return fail(
        'selector_drift',
        `Neither ${SELECTORS.connectButton} nor ${SELECTORS.moreActionsButton} matched on ${url}. Nothing was clicked.`
      );
    }
    try {
      await hoverClick(page, more.first(), `${url}#more`, CLICK_TIMEOUT_MS);
      await settle(page, `${url}#more-open`);
    } catch (cause) {
      return fail(
        'selector_drift',
        `Opening the More menu on ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    connect = page.locator(SELECTORS.connectInMoreMenu);
    if ((await connect.count()) === 0) {
      return fail(
        'selector_drift',
        `The More menu on ${url} contains no ${SELECTORS.connectInMoreMenu}. Nothing was clicked.`
      );
    }
  }

  // EVERYTHING BELOW THIS LINE IS POST-CLICK. An error from here on cannot
  // prove the invite did not go out, so it reports `unknown` and the worker
  // holds the claim instead of retrying it into a duplicate.
  try {
    await hoverClick(page, connect.first(), `${url}#connect`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#connect-modal`);

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
        await hoverClick(page, addNote.first(), `${url}#add-note`, CLICK_TIMEOUT_MS);
        await settle(page, `${url}#note-modal`);
      }
      const textarea = page.locator(SELECTORS.noteTextarea);
      if ((await textarea.count()) === 0) {
        // The modal is open and the note cannot be typed. Sending it without
        // the note would deliver something nobody approved, so this stops --
        // `unknown` because the modal is open and its state is ours to settle.
        return fail(
          'unknown',
          `The invite modal for ${url} is open but ${SELECTORS.noteTextarea} did not match, so the approved note could not be typed. Settle this invite by hand.`
        );
      }
      // Typed, not pasted -- and byte for byte either way. See `typeLike`.
      await typeLike(page, textarea.first(), note, `${url}#note`, CLICK_TIMEOUT_MS);
      const send = page.locator(SELECTORS.sendInviteButton);
      if ((await send.count()) === 0)
        return fail(
          'unknown',
          `No send control matched in the open invite modal for ${url}. Settle it by hand.`
        );
      await hoverClick(page, send.first(), `${url}#send-note`, CLICK_TIMEOUT_MS);
    } else {
      const withoutNote = page.locator(SELECTORS.sendWithoutNoteButton);
      const send =
        (await withoutNote.count()) > 0 ? withoutNote : page.locator(SELECTORS.sendInviteButton);
      if ((await send.count()) === 0) {
        // Some profiles send on the first click with no modal at all. If no
        // modal is on screen either, that is what happened.
        if (!(await present(page, SELECTORS.inviteModal))) {
          return {
            ok: true,
            externalRef: url,
            failureKind: null,
            detail: 'Invite sent without a modal step.'
          };
        }
        return fail(
          'unknown',
          `An invite modal is open for ${url} with no send control matched. Settle it by hand.`
        );
      }
      await hoverClick(page, send.first(), `${url}#send`, CLICK_TIMEOUT_MS);
    }

    await settle(page, `${url}#after-send`);
    const afterSend = await detectWall(page);
    if (afterSend) {
      return fail(
        afterSend,
        `LinkedIn answered the send for ${url} with a ${afterSend === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    }
    if (await present(page, SELECTORS.inviteModal)) {
      return fail(
        'unknown',
        `The invite modal for ${url} is still open after the send click; whether the invite left is unknown.`
      );
    }
    return { ok: true, externalRef: url, failureKind: null };
  } catch (cause) {
    return fail(
      'unknown',
      `The invite to ${url} was interrupted after the Connect click: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`
    );
  }
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function attachmentMime(name: string, contentType: string | null): string {
  if (contentType?.trim()) return contentType.split(';')[0]!.trim();
  const lower = name.toLowerCase();
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

async function uploadComposerAttachment(
  page: LinkedInPage,
  attachment: LinkedInAttachment,
  inputSelector: string,
  previewSelector: string
): Promise<LinkedInDriverResult | null> {
  if (attachment.mediaKind === 'voice') {
    return fail(
      'compose_unavailable',
      'Native LinkedIn voice messages are not exposed through a verified upload surface. The text draft was not sent.'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(attachment.url);
  } catch {
    return fail(
      'compose_unavailable',
      'The attachment URL is invalid. The text draft was not sent.'
    );
  }
  if (parsed.protocol !== 'https:') {
    return fail(
      'compose_unavailable',
      'LinkedIn campaign attachments must use HTTPS. The text draft was not sent.'
    );
  }
  const input = page.locator(inputSelector);
  if ((await input.count()) === 0 || !input.first().setInputFiles) {
    return fail(
      'compose_unavailable',
      `The LinkedIn composer has no verified file-input surface (${inputSelector}). The text draft was not sent.`
    );
  }
  try {
    const response = await fetch(parsed, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok)
      return fail(
        'compose_unavailable',
        `Attachment download returned HTTP ${response.status}. The text draft was not sent.`
      );
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES)
      return fail(
        'compose_unavailable',
        'Attachment is larger than the 10 MB campaign limit. The text draft was not sent.'
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES)
      return fail(
        'compose_unavailable',
        bytes.byteLength === 0
          ? 'Attachment is empty. The text draft was not sent.'
          : 'Attachment is larger than the 10 MB campaign limit. The text draft was not sent.'
      );
    const fallbackName = decodeURIComponent(
      parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'attachment'
    );
    const name = attachment.name?.trim() || fallbackName || 'attachment';
    await input.first().setInputFiles!({
      name: name.slice(0, 255),
      mimeType: attachmentMime(name, response.headers.get('content-type')),
      buffer: bytes
    });
    await settle(page, `${parsed.toString()}#attachment-upload`);
    if ((await page.locator(previewSelector).count()) === 0) {
      return fail(
        'unknown',
        'The file input accepted the attachment but LinkedIn did not show a verifiable attachment preview. Nothing was sent; inspect or discard the open draft.'
      );
    }
    return null;
  } catch (cause) {
    return fail(
      'compose_unavailable',
      `The attachment could not be prepared for LinkedIn: ${cause instanceof Error ? cause.message : String(cause)}. The text draft was not sent.`
    );
  }
}

/** Send a direct message. 1st-degree only, which the Message control is the proof of. */
export async function sendDm(
  page: LinkedInPage,
  target: string,
  body: string,
  options: { attachment?: LinkedInAttachment | null } = {}
): Promise<LinkedInDriverResult> {
  if (!body.trim()) {
    return fail(
      'selector_drift',
      'Refusing to open a message composer with no approved body to put in it.'
    );
  }
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;

  const message = page.locator(SELECTORS.messageButton);
  if ((await message.count()) === 0) {
    return fail(
      'selector_drift',
      `${SELECTORS.messageButton} did not match on ${url}. Nothing was clicked.`
    );
  }

  try {
    await hoverClick(page, message.first(), `${url}#message`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#composer`);

    const wall = await detectWall(page);
    if (wall)
      return fail(
        wall,
        `LinkedIn answered the Message click on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}.`
      );

    const compose = page.locator(SELECTORS.messageComposeBox);
    if ((await compose.count()) === 0) {
      return fail(
        'unknown',
        `The composer for ${url} did not appear as ${SELECTORS.messageComposeBox}; a draft may be open. Check it by hand.`
      );
    }
    await typeLike(page, compose.first(), body, `${url}#dm`, CLICK_TIMEOUT_MS);
    if (options.attachment) {
      const attachmentResult = await uploadComposerAttachment(
        page,
        options.attachment,
        SELECTORS.messageAttachmentInput,
        SELECTORS.messageAttachmentPreview
      );
      if (attachmentResult) return attachmentResult;
    }

    const send = page.locator(SELECTORS.messageSendButton);
    if ((await send.count()) === 0) {
      return fail(
        'unknown',
        `The composer for ${url} holds the approved body but no send control matched. Send or discard it by hand.`
      );
    }
    await hoverClick(page, send.first(), `${url}#dm-send`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#after-dm`);

    const afterSend = await detectWall(page);
    if (afterSend)
      return fail(
        afterSend,
        `LinkedIn answered the message send for ${url} with a ${afterSend === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    return { ok: true, externalRef: url, failureKind: null };
  } catch (cause) {
    return fail(
      'unknown',
      `The message to ${url} was interrupted after the composer opened: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`
    );
  }
}

/** Send a real InMail from its dedicated composer. Message is never used as a fallback. */
export async function readOpenProfile(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;
  const control = page.locator(SELECTORS.inmailButton);
  if ((await control.count()) === 0) {
    return { ok: true, externalRef: 'open-profile:false', failureKind: null };
  }
  try {
    await hoverClick(page, control.first(), `${url}#open-profile-probe`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#open-profile-probe-settle`);
    const wall = await detectWall(page);
    if (wall) return fail(wall, `LinkedIn blocked the Open Profile probe on ${url}.`);
    const paid = page.locator(SELECTORS.inmailPaidWarning);
    const usesCredit = (await paid.count()) > 0;
    return {
      ok: true,
      externalRef: usesCredit ? 'open-profile:false' : 'open-profile:true',
      failureKind: null,
      metadata: { inmailAvailable: true, paidCreditRequired: usesCredit }
    };
  } catch (cause) {
    return fail(
      'unknown',
      `The Open Profile probe for ${url} could not determine whether InMail is free: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
}

export async function sendInMail(
  page: LinkedInPage,
  target: string,
  subject: string,
  body: string,
  options: { allowPaid?: boolean; attachment?: LinkedInAttachment | null } = {}
): Promise<LinkedInDriverResult> {
  if (!subject.trim() || !body.trim())
    return fail('selector_drift', 'Refusing to open InMail without an approved subject and body.');
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;
  const control = page.locator(SELECTORS.inmailButton);
  if ((await control.count()) === 0)
    return fail(
      'compose_unavailable',
      `No InMail control matched on ${url}. This sender may not have InMail access for this profile.`
    );
  try {
    await hoverClick(page, control.first(), `${url}#inmail`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#inmail-composer`);
    const wall = await detectWall(page);
    if (wall)
      return fail(
        wall,
        `LinkedIn answered the InMail click on ${url} with a ${wall === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    const paid = page.locator(SELECTORS.inmailPaidWarning);
    const paidCredit = (await paid.count()) > 0;
    if (paidCredit && options.allowPaid !== true)
      return fail(
        'paid_credit_required',
        'LinkedIn says this InMail consumes a paid credit, but this workflow did not approve paid credits. Nothing was sent.'
      );
    const subjectBox = page.locator(SELECTORS.inmailSubject);
    const compose = page.locator(SELECTORS.inmailComposeBox);
    if ((await subjectBox.count()) === 0 || (await compose.count()) === 0)
      return fail(
        'unknown',
        'The InMail composer opened but its subject or body field could not be identified. Nothing was sent; inspect the open draft.'
      );
    await typeLike(page, subjectBox.first(), subject, `${url}#inmail-subject`, CLICK_TIMEOUT_MS);
    await typeLike(page, compose.first(), body, `${url}#inmail-body`, CLICK_TIMEOUT_MS);
    if (options.attachment) {
      const attachmentResult = await uploadComposerAttachment(
        page,
        options.attachment,
        SELECTORS.inmailAttachmentInput,
        SELECTORS.inmailAttachmentPreview
      );
      if (attachmentResult) return attachmentResult;
    }
    const send = page.locator(SELECTORS.inmailSendButton);
    if ((await send.count()) === 0)
      return fail(
        'unknown',
        'The approved InMail is in the composer but no send control matched. Send or discard the draft by hand.'
      );
    await hoverClick(page, send.first(), `${url}#inmail-send`, CLICK_TIMEOUT_MS);
    await settle(page, `${url}#after-inmail`);
    const after = await detectWall(page);
    if (after)
      return fail(
        after,
        `LinkedIn answered the InMail send for ${url} with a ${after === 'challenge' ? 'challenge' : 'limit wall'}.`
      );
    return {
      ok: true,
      externalRef: url,
      failureKind: null,
      metadata: { paidCreditConsumed: paidCredit }
    };
  } catch (cause) {
    return fail(
      'unknown',
      `The InMail to ${url} was interrupted after its composer opened: ${cause instanceof Error ? cause.message : String(cause)}. Whether it left is unknown.`
    );
  }
}

/**
 * View a profile. The whole action is the navigation -- LinkedIn records the
 * view server-side the moment the page loads, so there is nothing to click and
 * no post-click ambiguity to report.
 */
export async function viewProfile(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  return { ok: true, externalRef: opened.url, failureKind: null };
}

/* ---------------------------------------------------------------------------
 * Reading a relationship out of a profile, for acceptance detection.
 * ------------------------------------------------------------------------ */

/**
 * What one profile says about this seat's relationship to its owner.
 *
 * `degree: null` IS A FIRST-CLASS ANSWER AND IT MEANS "WE DID NOT READ IT",
 * never "they are not connected". The whole point of this read is to settle a
 * question the pending-invitations list cannot -- an invite that left the list
 * was accepted, declined, expired or withdrawn -- and a badge we failed to
 * parse must leave that question open. Reporting an unread badge as "not 1st
 * degree" would file real acceptances as non-acceptances, which is the same
 * fiction the sync in `withdraw.ts` refuses to invent, arrived at with an extra
 * step in between.
 *
 * `degraded` rather than `ok:false` for the reason `LinkedInSeatRead` gives:
 * the navigation succeeding and the badge failing is a partial answer, and
 * `pending` may still be readable when `degree` is not.
 */
export interface LinkedInDegreeRead {
  ok: true;
  /** Canonical, the form `profileUrlFor` produces, comparable against `target_ref`. */
  profileUrl: string;
  /** 1, 2 or 3. Null when the badge was absent or did not parse. */
  degree: 1 | 2 | 3 | null;
  /** LinkedIn still shows an invite from this seat awaiting their answer. */
  pending: boolean;
  degraded: string[];
}

/** Narrow a degree read. A read carries no `failureKind`; a failure always does. */
export function isDegreeRead(
  value: LinkedInDegreeRead | LinkedInDriverResult
): value is LinkedInDegreeRead {
  return !('failureKind' in value);
}

/**
 * "· 1st", "2nd degree connection", "3rd+" -> 1 | 2 | 3.
 *
 * ENGLISH ORDINALS ONLY, AND THAT IS A KNOWN BOUND RATHER THAN AN OVERSIGHT.
 * LinkedIn renders this badge in the viewer's interface language, so a seat
 * whose LinkedIn is set to French sees "1er" and a German one sees "1.". Every
 * one of those returns null here, which routes to UNKNOWN and leaves the
 * ledger saying what it already said. The failure mode of the missing
 * translations is therefore "detects nothing", never "detects wrongly", which
 * is the only acceptable way for a detector to be incomplete.
 */
export function parseConnectionDegree(text: string | null | undefined): 1 | 2 | 3 | null {
  if (!text) return null;
  const match = /\b(1st|2nd|3rd)\b/i.exec(text);
  if (!match) return null;
  const ordinal = match[1].charAt(0);
  return ordinal === '1' ? 1 : ordinal === '2' ? 2 : 3;
}

/**
 * Open a profile and read the connection degree off it.
 *
 * THIS IS A PROFILE VIEW AND THE CALLER MUST BUDGET IT AS ONE. There is no
 * cheaper way to ask: LinkedIn publishes no "are we connected" endpoint this
 * driver may touch, and the relationship badge lives on the profile page.
 * Opening it registers a view against the viewer's account exactly as
 * `viewProfile` does -- same navigation, same `openProfile`, same walls -- so
 * every caller in this repo files a `profile_view` ledger row for it and runs
 * the safety gate first. A detector that read a thousand profiles a night
 * without either would be the surge the whole engine exists to prevent, wearing
 * the name of a safety feature.
 *
 * Nothing is clicked, ever. A failure here is therefore always definite about
 * what did NOT happen, and `unknown` is not among the kinds it can return.
 */
export async function readProfileDegree(
  page: LinkedInPage,
  target: string
): Promise<LinkedInDegreeRead | LinkedInDriverResult> {
  const opened = await openProfile(page, target);
  if (isResult(opened)) return opened;
  const { url } = opened;

  const degraded: string[] = [];
  // Read BEFORE the badge, because it is the cheaper certainty: a profile still
  // showing "Pending" is one whose invite never left the pending list, whatever
  // a stale sync concluded, and the caller can stop there.
  const pending = await present(page, SELECTORS.pendingInvite);

  let degree: 1 | 2 | 3 | null = null;
  try {
    const badge = page.locator(SELECTORS.degreeBadge);
    if ((await badge.count()) === 0) {
      degraded.push(
        `No connection-degree badge matched ${SELECTORS.degreeBadge} on ${url}, so the relationship was not read.`
      );
    } else {
      const text = await badge.first().textContent({ timeout: CLICK_TIMEOUT_MS });
      degree = parseConnectionDegree(text);
      if (degree === null) {
        degraded.push(
          `The connection-degree badge on ${url} read '${(text ?? '').trim().slice(0, 40)}', which is not an English 1st/2nd/3rd ordinal.`
        );
      }
    }
  } catch (cause) {
    degraded.push(
      `The connection-degree badge on ${url} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  return { ok: true, profileUrl: url, degree, pending, degraded };
}

/**
 * The degree read, as its own injectable surface.
 *
 * NOT A METHOD ON `LinkedInDriver`, and the reason is the same one
 * `LinkedInWithdrawDriver` and `LinkedInInboxDriver` exist for: the action
 * worker dispatches against `LinkedInDriver`, this is not one of its actions,
 * and widening that interface would oblige every fake in every test that drives
 * the worker to grow a method none of them calls.
 */
export interface LinkedInDegreeDriver {
  readProfileDegree(
    page: LinkedInPage,
    target: string
  ): Promise<LinkedInDegreeRead | LinkedInDriverResult>;
}

export const playwrightDegreeDriver: LinkedInDegreeDriver = { readProfileDegree };

/* ---------------------------------------------------------------------------
 * Reading the operator's own seat out of the live session.
 * ------------------------------------------------------------------------ */

/** LinkedIn redirects this to the signed-in member's own vanity URL. */
const ME_URL = 'https://www.linkedin.com/in/me/';

/** Where a signed-in member lands, and the only page a session probe may load. */
const FEED_URL = 'https://www.linkedin.com/feed/';

/** Is this URL a LinkedIn page at all? `about:blank` and a dead tab are not. */
function onLinkedIn(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The connections list, and the ONLY place the exact count is readable.
 *
 * The profile page caps its own badge at "500+", so reading the count there
 * would record 500 for a 4,000-connection account -- a wrong number wearing
 * the shape of a right one.
 */
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

/** Narrow a `readSeat` answer. A read carries no `failureKind`; a failure always does. */
export function isSeatRead(
  value: LinkedInSeatRead | LinkedInDriverResult
): value is LinkedInSeatRead {
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

/**
 * LinkedIn's own ceiling on connections. A parse that produces more than this
 * read something that was not the connection count, and unknown beats wrong:
 * this number is paced against.
 */
const MAX_CONNECTIONS = 30_000;

/**
 * "1,234 connections" -> 1234, and "1 Kontakt" -> 1.
 *
 * TWO PATTERNS, IN ORDER OF CONFIDENCE. The English one may appear anywhere in
 * the text, because "Showing 1,234 connections" is still a statement about
 * connections. The language-free one is the whole string or nothing -- a bare
 * number followed by a single word -- because outside a known noun that shape
 * is the only evidence there is, and loosening it turns "3 gemeinsame Kontakte"
 * or an ad's "0 CHF" into a connection count.
 *
 * Null for no number, and null for a number too large to be one.
 */
export function parseConnectionsCount(text: string): number | null {
  const match =
    /([0-9][0-9.,   ]*)\s*connections?/i.exec(text) ??
    /^\s*([0-9][0-9.,   ]*)\s+\S+\s*$/.exec(text);
  if (!match) return null;
  const digits = match[1].replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value) || value > MAX_CONNECTIONS) return null;
  return value;
}

/**
 * The first of these selectors that reads as text, waiting a little for a page
 * that is still rendering itself.
 *
 * WHY WAITING IS PART OF THE READ. `settle` returns when the document is
 * quiet, and LinkedIn's connections page hydrates AFTER that: measured on the
 * live seat, the first snapshot was still the cookie notice and the count only
 * appeared a few seconds later. A single miss was recorded as "no header",
 * which is a claim about LinkedIn made from a page that had not finished.
 *
 * Bounded and small: this is one extra sentence's worth of patience, not a
 * retry loop, and a genuinely absent element still comes back null.
 */
async function readFirstText(
  page: LinkedInPage,
  selectors: readonly string[],
  attempts = 4
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const selector of selectors) {
      const text = await readText(page, selector);
      if (text !== null) return text;
    }
    if (attempt < attempts - 1) await page.waitForTimeout(1_500);
  }
  return null;
}

/**
 * The member's name out of the document title, which is `<Name> | LinkedIn`.
 *
 * THE ONE SOURCE THAT IS NOT A CLASS NAME. LinkedIn's profile markup is hashed
 * and reshuffled; the title is the same shape in every language and has been
 * for years. Used only when the heading selector found nothing -- see
 * `SELECTORS.profileHeading`.
 *
 * The unread-count prefix LinkedIn puts on its own tab (`(3) Name | LinkedIn`)
 * is stripped, and a title that is nothing but the site name is no name at all.
 */
async function readNameFromTitle(page: LinkedInPage): Promise<string | null> {
  if (typeof page.title !== 'function') return null;
  let title: string;
  try {
    title = await page.title();
  } catch {
    return null;
  }
  const name = (title ?? '')
    .replace(/^\s*\(\d+\)\s*/, '')
    .replace(/\s*[|–-]\s*LinkedIn\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || /^linkedin$/i.test(name)) return null;
  return name;
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
export async function readSeat(
  page: LinkedInPage,
  options: { skipConnections?: boolean } = {}
): Promise<LinkedInSeatRead | LinkedInDriverResult> {
  const degraded: string[] = [];

  try {
    await page.goto(ME_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${ME_URL}#seat`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `Could not open ${ME_URL}: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was read.`
    );
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

  const name =
    (await readFirstText(page, [SELECTORS.profileHeading], 2)) ?? (await readNameFromTitle(page));
  if (name === null) {
    degraded.push(
      `The profile page at ${profileUrl} has no readable heading and no name in its title, so the display name could not be read.`
    );
  }

  // A SECOND PAGE LOAD FOR ONE NUMBER, AND ONLY WHEN THE NUMBER IS MISSING.
  //
  // The connection count is the one fact the profile page will not give
  // honestly (its badge caps at "500+"), so reading it means loading
  // `/mynetwork/invite-connect/connections/` -- a second navigation on a
  // surface LinkedIn associates with prospecting, every single time anything
  // re-detected this seat. It moves by a handful a week. The caller says when
  // it already has a recent one, and then this does not go and look.
  if (options.skipConnections) {
    return { ok: true, profileUrl, name, connectionsCount: null, degraded };
  }

  try {
    await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${CONNECTIONS_URL}#seat`);
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

  const header = await readFirstText(page, [
    SELECTORS.connectionsCount,
    SELECTORS.connectionsCountAny
  ]);
  const connectionsCount = header === null ? null : parseConnectionsCount(header);
  if (connectionsCount === null) {
    degraded.push(
      header === null
        ? 'The connections page shows no count header in any language, so the connection count is unknown. It is left unset rather than recorded as zero.'
        : `The connections header read '${header}', which carries no usable number, so the connection count is unknown and is left unset.`
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
 * IT DOES NOT NAVIGATE WHEN IT DOES NOT HAVE TO, and when it does it loads the
 * FEED. `/in/me/` used to be the probe -- LinkedIn redirects it to the member's
 * own vanity URL, so the answer was the URL and no markup had to hold still.
 * That was a good way to read a boolean and a terrible way to browse: it made
 * every tick a profile fetch, from a client that did nothing else. The signed-in
 * global nav is now the signal, read off whatever page is already open, and
 * `/feed/` is the fallback because that is where a person who just opened
 * LinkedIn is sitting.
 *
 * NEVER THROWS. Anything it could not determine is `false`, which costs a
 * sign-in attempt that was probably unnecessary -- the cheap wrong answer.
 */
const FEED_PATH = /^\/feed\/?$/;
const CONNECT_SERVICES_PATH = /^\/connect-services\/?$/;
const SELF_PROFILE_URL = 'https://www.linkedin.com/in/me/';

export async function isLoggedIn(page: LinkedInPage): Promise<boolean> {
  // ANSWERED FROM THE PAGE THAT IS ALREADY OPEN, WHENEVER THERE IS ONE.
  //
  // THIS USED TO LOAD `/in/me/` EVERY SINGLE TIME IT WAS ASKED, and it is asked
  // on every worker tick, before every batch, and by every UI poll that reaches
  // `loginLinkedInSeat`. From LinkedIn's side that is a client which opens a
  // PROFILE PAGE every minute or two, forever, and never scrolls a feed,
  // never opens a conversation, never clicks a link to get there. Nobody
  // browses like that, `/in/me/` is a profile fetch like any other, and the
  // pattern is both the loudest automation tell this driver still emitted and
  // a steady drip against exactly the counter LinkedIn cites when it says an
  // account has been "accessing an unusually large amount of profile data".
  //
  // The doc comment above always claimed this only read the current page. Now
  // it does: the browser opens on the feed (`warmUpSession` in
  // `local-worker.ts`), so the common case is answered with NO navigation at
  // all, and the fallback loads the FEED rather than a profile -- the page a
  // person who just opened LinkedIn would be looking at.
  const current = page.url();
  if (onLinkedIn(current)) {
    if (CHECKPOINT_PATH.test(current)) return false;
    if (normalisedProfileUrl(current)) return true;
    if (await present(page, SELECTORS.globalNav)) return true;
    // NOT A NO YET. A miss here used to be the answer, so one reskin of the
    // navigation turned every signed-in session into a signed-out one. The
    // feed probe below is the second opinion, and it does not depend on a
    // class name at all.
  }

  try {
    await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `${FEED_URL}#probe`);
  } catch {
    return false;
  }
  if (CHECKPOINT_PATH.test(page.url())) return false;
  if (await present(page, SELECTORS.globalNav)) return true;
  if (normalisedProfileUrl(page.url()) !== null) return true;

  // LinkedIn now puts some signed-in EU members behind `/connect-services/`
  // until they choose whether its services should stay linked. That is an
  // account-preference interstitial, not a login page. Do not make the choice
  // for the member and do not mistake the missing global nav for a logged-out
  // browser. Only in this exceptional path, use LinkedIn's own `/in/me/`
  // redirect as a second opinion: a signed-in member resolves to their profile;
  // a guest does not. The normal tick still avoids profile probes entirely.
  if (CONNECT_SERVICES_PATH.test(pathOf(page.url()))) {
    try {
      await page.goto(SELF_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await settle(page, `${SELF_PROFILE_URL}#connect-services-probe`);
    } catch {
      return false;
    }
    if (CHECKPOINT_PATH.test(page.url())) return false;
    if (normalisedProfileUrl(page.url()) !== null) return true;
    return present(page, SELECTORS.globalNav);
  }

  // WHERE THE FEED LANDED, which is a fact about LinkedIn rather than about
  // markup: `/feed/` stays `/feed/` for a member and is bounced to the login
  // page, the authwall or the guest homepage for everybody else. It is the one
  // signal here that survives any reskin, in any language.
  return FEED_PATH.test(pathOf(page.url()));
}

/**
 * Classify the one recovery question the hosted companion cares about after
 * `isLoggedIn` has already returned false. A checkpoint/captcha/device check is
 * stronger than an ordinary expired/sign-out state; both require the member's
 * visible browser, and neither is something the headless worker should push
 * through on its own.
 */
export async function sessionRecoveryReason(
  page: LinkedInPage
): Promise<'challenge' | 'signed_out'> {
  return (await detectWall(page)) === 'challenge' ? 'challenge' : 'signed_out';
}

/** The path of a URL, or '' when it is not one. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
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
    await settle(page, `${LOGIN_URL}#form`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `Could not open the LinkedIn sign-in page: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was typed.`
    );
  }

  // A device LinkedIn already recognises answers /login with "We're logging
  // you in" -- no form, no checkpoint URL yet, nothing any selector below
  // matches -- and redirects on its own a few seconds later, to the feed or to
  // a checkpoint. POLL FOR THAT REDIRECT before concluding the form itself is
  // gone: a read taken mid-interstitial and a read taken after `SETTLE_MS` on a
  // genuinely reskinned page look identical from here, so the only way to tell
  // them apart is to give the redirect the time it actually takes.
  const deadline = Date.now() + LOGIN_REDIRECT_TIMEOUT_MS;
  let email = page.locator(SELECTORS.loginEmailField);
  while (
    (await email.count()) === 0 &&
    !(await present(page, SELECTORS.globalNav)) &&
    !CHECKPOINT_PATH.test(page.url()) &&
    !(await present(page, SELECTORS.otpField)) &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(LOGIN_REDIRECT_POLL_MS);
    email = page.locator(SELECTORS.loginEmailField);
  }

  if ((await email.count()) === 0) {
    // /login on a live session redirects to the feed, which is a success we
    // reached by a different door.
    if (await present(page, SELECTORS.globalNav)) return { ok: true };
    // Otherwise LinkedIn skipped the form and went straight to a checkpoint,
    // which `readLoginStanding` is exactly the reader for.
    if (CHECKPOINT_PATH.test(page.url()) || (await present(page, SELECTORS.otpField)))
      return readLoginStanding(page, otp);
    return fail(
      'selector_drift',
      `The sign-in page shows no ${SELECTORS.loginEmailField}. Nothing was typed.`
    );
  }

  // BOTH CONTROLS ARE READ BEFORE EITHER IS FILLED, so a miss on the second is
  // unambiguously "nothing was typed" rather than "an email address is sitting
  // in a form we then abandoned".
  const password = page.locator(SELECTORS.loginPasswordField);
  if ((await password.count()) === 0) {
    return fail(
      'selector_drift',
      `The sign-in page shows no ${SELECTORS.loginPasswordField}. Nothing was typed.`
    );
  }
  // A MISSING SUBMIT BUTTON IS NOT A FAILURE HERE (see the selector's note):
  // the password field's Enter key submits the same form, and refusing the
  // sign-in over a button we cannot name would strand every seat the moment
  // LinkedIn reskins its login page -- which is exactly what it did.
  const submit = page.locator(SELECTORS.loginSubmitButton);
  const submitByClick = (await submit.count()) > 0;
  const passwordField = password.first();
  if (!submitByClick && typeof passwordField.press !== 'function') {
    return fail(
      'selector_drift',
      `The sign-in page shows no ${SELECTORS.loginSubmitButton}, and this page cannot press a key. Nothing was typed.`
    );
  }

  try {
    await email.first().fill(credentials.email, { timeout: CLICK_TIMEOUT_MS });
    // A beat between the two fields, and NEITHER IS TYPED CHARACTER BY
    // CHARACTER. That is deliberate: `typeLike` is the more human shape, but
    // the standing guarantee of this file is that no failure path can echo a
    // credential, and `fill` is the call whose error text has been audited for
    // it. A sign-in is one form on one page -- the pauses buy most of what the
    // keystrokes would, and the guarantee is worth more than the remainder.
    await settle(page, `${LOGIN_URL}#between-fields`, 0.5);
    // The one moment the password exists outside the vault. `cause.message`
    // below is Playwright's own text about a timeout or a detached node and
    // never contains what was typed -- `fill` does not echo its argument.
    await passwordField.fill(credentials.password, { timeout: CLICK_TIMEOUT_MS });
    await settle(page, `${LOGIN_URL}#before-submit`, 0.5);
    if (submitByClick)
      await hoverClick(page, submit.first(), `${LOGIN_URL}#submit`, CLICK_TIMEOUT_MS);
    else await passwordField.press!('Enter', { timeout: CLICK_TIMEOUT_MS });
    // Twice the usual settle: this navigation is a full page load plus a
    // redirect, and reading the standing early reads the page we just left.
    await settle(page, `${LOGIN_URL}#after-submit`, 2);
  } catch (cause) {
    return fail(
      'unknown',
      `The sign-in was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether the session opened is unknown.`
    );
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
    return fail(
      'not_found',
      'LinkedIn did not accept that email address and password. Save the right ones and sign in again.'
    );
  }

  if (await isLoggedIn(page)) return { ok: true };

  return fail(
    'unknown',
    `The sign-in at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`
  );
}

/** Type a verification code and read what happened. Never called without one. */
async function submitOtp(page: LinkedInPage, otp: string): Promise<LinkedInLoginResult> {
  const field = page.locator(SELECTORS.otpField);
  if ((await field.count()) === 0) {
    return fail(
      'selector_drift',
      `No verification-code box matched ${SELECTORS.otpField}, so the code was not typed.`
    );
  }
  const submit = page.locator(SELECTORS.otpSubmitButton);
  if ((await submit.count()) === 0) {
    return fail(
      'selector_drift',
      `The verification-code box has no submit control matching ${SELECTORS.otpSubmitButton}, so the code was not sent.`
    );
  }

  try {
    // A code IS typed: six digits are not a stored credential, and a code box
    // filled in one event at a checkpoint is the worst possible place to look
    // like a machine.
    await typeLike(page, field.first(), otp, `${LOGIN_URL}#otp`, CLICK_TIMEOUT_MS);
    await hoverClick(page, submit.first(), `${LOGIN_URL}#otp-submit`, CLICK_TIMEOUT_MS);
    await settle(page, `${LOGIN_URL}#after-otp`, 2);
  } catch (cause) {
    return fail(
      'unknown',
      `The verification code was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether the session opened is unknown.`
    );
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
  return fail(
    'unknown',
    `The verification code at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`
  );
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
  sendInMail,
  sendReply,
  readThread,
  listConversations,
  viewProfile,
  followProfile,
  unfollowProfile,
  disconnectProfile,
  likeRecentPost,
  endorseSkills,
  publishPost,
  readSeat,
  isLoggedIn,
  sessionRecoveryReason,
  loginWithCredentials
};
