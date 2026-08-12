/**
 * The Playwright routines, one per executable Reddit action.
 *
 * This file is the ONLY place in Trevra that touches a Reddit page, and it is
 * reachable only from `local-worker.ts`, which is reachable only when the
 * deployment-mode gate in `config.ts` says this instance is self-hosted.
 * Nothing here runs on a hosted instance, ever.
 *
 * WHAT THIS IS AND IS NOT. `channels/adapters/reddit.ts` marks Reddit
 * `prepare-only` for SUBMISSIONS and that stays true: an unattended post into a
 * subreddit whose sidebar nobody read is a shadowban risk for the account and
 * the domain, and no code here submits one. What this drives is the narrower
 * thing a self-hoster does by hand anyway -- read a subreddit, and reply in a
 * thread they chose -- from THEIR OWN account, on THEIR OWN machine, at THEIR
 * OWN IP, one action at a time.
 *
 * THIS FILE NEVER STORES A CREDENTIAL, AND IT NEVER PRINTS ONE. Both halves are
 * sealed in `workspace_secrets`, opened at the moment of use, and arrive here
 * as two function arguments that are typed into a form and then let go.
 * `loginWithCredentials` is the only routine that sees them, and NOTHING IN
 * THIS FILE MAY ECHO EITHER VALUE: every `detail` string below is built from
 * constants, selector names and the page's own URL -- never from an argument --
 * so no failure path, however unusual, can put a password into a ledger row, a
 * log line or an HTTP response.
 *
 * A LIVE SESSION IS ALWAYS PREFERRED TO A FRESH LOGIN. `isLoggedIn` exists so
 * the credential path is the FALLBACK: re-authenticating on every run is slower
 * and a much stronger automation signal than a stable session, and a login
 * burst is exactly the shape Reddit's anti-abuse looks for.
 *
 * TWO LISTING SURFACES ARE TRIED, NEW REDDIT FIRST. `old.reddit.com` used to
 * render `div.thing` elements carrying `data-permalink`, `data-author` and
 * `data-score` -- markup that had not moved in a decade -- and this driver was
 * written against it. IT IS GONE: as of 2026-08 `old.reddit.com` serves the
 * same `theme-beta` app shell as `www`, so a driver that only knew `div.thing`
 * reported "no posts" on a subreddit with thousands. New Reddit's
 * `shreddit-post` element is now the primary surface and the old markup is
 * kept as a fallback, because some paths and some accounts still get served it
 * and reading it costs one extra `count()`.
 *
 * BEING BLOCKED IS NOT SELECTOR DRIFT, and telling them apart is why
 * `detectWall` runs before any listing selector is counted. Reddit answers a
 * datacenter IP or an unconvincing browser fingerprint with a JS challenge and
 * then with "You've been blocked by network security" -- a page that has no
 * posts on it for a reason that no selector repair will ever fix. Reporting
 * that as drift sends an operator to edit a CSS table when what they actually
 * need is to run the worker from their own machine.
 *
 * WHAT A FAILURE MEANS IS THE IMPORTANT PART. Every routine reports one of six
 * kinds, and the worker treats two of them as "Reddit is telling us to stop":
 *
 *   not_found       the thread or subreddit is gone, or the sign-in pair is
 *                   wrong. Definite; a retry with the same input fails again.
 *   forbidden       private, quarantined, locked, archived, or this account is
 *                   banned from that subreddit. Definite, and NOT a rate limit:
 *                   treating it as one would idle a healthy account for hours
 *                   over one subreddit that will never accept it.
 *   rate_limited    "you are doing that too much". STOP.
 *   challenge       a captcha or a verification wall. STOP -- a person has to
 *                   clear it in a real window.
 *   selector_drift  the control we needed was not on the page. Nothing was
 *                   clicked, so nothing was posted.
 *   unknown         we clicked and then lost track of the outcome. NOT
 *                   definite -- the caller holds the claim rather than
 *                   retrying, because a duplicate comment cannot be un-posted.
 *
 * NOTHING HERE THROWS. A routine that throws would abort a batch at an unknown
 * point, which is the one outcome a ledger cannot describe. Every path returns
 * a result.
 */

/** The six outcomes a routine may report. */
export type RedditFailureKind =
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  | 'challenge'
  | 'selector_drift'
  | 'unknown';

export interface RedditDriverResult {
  ok: boolean;
  /** The canonical URL the action landed on. Absent on failure. */
  externalRef?: string;
  /** Null exactly when `ok` is true. */
  failureKind: RedditFailureKind | null;
  /** Written for the operator reading the ledger later, not for a log grep. */
  detail?: string;
}

/**
 * The slice of Playwright's `Page` this driver uses, declared structurally.
 *
 * Playwright is an OPTIONAL dependency: importing its types here would make
 * `tsc` fail on every machine that has not installed the ~400MB of browser it
 * drags in, including the Cloudflare marketing build. A structural interface
 * costs one small declaration and keeps this file compiling with the package
 * absent -- which is the normal case for every deployment except a self-hoster
 * who opted in.
 */
export interface RedditLocator {
  count(): Promise<number>;
  first(): RedditLocator;
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
  /** Optional for the same reason: only the listing reader reads attributes. */
  getAttribute?(name: string, options?: { timeout?: number }): Promise<string | null>;
}

export interface RedditPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): RedditLocator;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * The three answers a sign-in attempt can give.
 *
 * `needsOtp` IS NOT A FAILURE, and the shape says so: it carries no
 * `failureKind` because nothing went wrong. Reddit asked for a two-factor code,
 * the operator has one in their authenticator, and the next call supplies it.
 * Modelling it as a failure is how a 2FA account becomes "this product does not
 * work with 2FA".
 */
export type RedditLoginResult = { ok: true } | RedditDriverResult | { ok: false; needsOtp: true };

/** Narrow a login answer to "ask the operator for the code and call again". */
export function isOtpRequired(value: RedditLoginResult): value is { ok: false; needsOtp: true } {
  return 'needsOtp' in value;
}

/** One post as the listing reported it. Every field is what old Reddit put in an attribute. */
export interface RedditThread {
  /** Reddit's own fullname, `t3_abc123`. Stable across title edits and re-sorts. */
  id: string;
  url: string;
  title: string;
  author: string | null;
  subreddit: string | null;
  /** Null when the listing did not carry it -- never zero, which is a real score. */
  score: number | null;
  comments: number | null;
  /** ISO 8601, or null when the listing did not carry a timestamp. */
  createdAt: string | null;
}

export interface RedditResearchRead {
  ok: true;
  subreddit: string;
  sort: RedditSort;
  /** Null for every sort but 'top', where it is the window that was ranked over. */
  time: RedditTime | null;
  threads: RedditThread[];
  /** What could not be read, in plain sentences an operator can act on. */
  degraded: string[];
}

/** Narrow a research answer to the success arm. */
export function isResearchRead(value: RedditResearchRead | RedditDriverResult): value is RedditResearchRead {
  return (value as RedditResearchRead).ok === true && Array.isArray((value as RedditResearchRead).threads);
}

/** What `local-worker.ts` needs; the fake in the tests implements exactly this. */
export interface RedditDriver {
  /** Is this profile already signed in? Asked BEFORE any sign-in is attempted. */
  isLoggedIn(page: RedditPage): Promise<boolean>;
  loginWithCredentials(
    page: RedditPage,
    credentials: { username: string; password: string; otp?: string }
  ): Promise<RedditLoginResult>;
  /** The signed-in account's own handle, without the `u/`. Null when it could not be read. */
  readHandle(page: RedditPage): Promise<string | null>;
  readSubreddit(page: RedditPage, subreddit: string, options?: RedditReadOptions): Promise<RedditResearchRead | RedditDriverResult>;
  commentOnThread(page: RedditPage, threadUrl: string, body: string): Promise<RedditDriverResult>;
}

/**
 * The four listing sorts old Reddit answers to, as a tuple.
 *
 * A tuple rather than a union plus an array, so `app.ts` can hand it straight
 * to `z.enum` and the route's accepted values and the driver's accepted values
 * are LITERALLY the same list. Two copies is one copy that eventually
 * disagrees with the other.
 */
export const REDDIT_SORTS = ['hot', 'new', 'top', 'rising'] as const;

export type RedditSort = (typeof REDDIT_SORTS)[number];

/**
 * The window `top` ranks over. Reddit's own `t` parameter.
 *
 * IT ONLY MEANS ANYTHING FOR `top`, and that is enforced rather than
 * documented: every other sort ignores it, and appending `t=year` to a `new`
 * listing would be a parameter that quietly does nothing.
 *
 * A SUBREDDIT'S ACTUAL BEST PRACTICES LIVE IN `top` OVER A LONG WINDOW. `hot`
 * is what is being argued about this afternoon; `top` of the year is what the
 * community has repeatedly agreed was worth reading. Research that only ever
 * reads `hot` learns the news and misses the knowledge.
 */
export const REDDIT_TIMES = ['hour', 'day', 'week', 'month', 'year', 'all'] as const;

export type RedditTime = (typeof REDDIT_TIMES)[number];

export interface RedditReadOptions {
  sort?: RedditSort;
  /** Applied only when `sort` is 'top'. Reddit's default is 'day'. */
  time?: RedditTime;
  /** How many posts to read at most. Clamped to [1, MAX_READ_LIMIT]. */
  limit?: number;
}

/**
 * EVERY DOM SELECTOR, IN ONE TABLE, ON PURPOSE.
 *
 * REDDIT CHANGES THESE. The `www` sign-in form and the comment composer have
 * both been rewritten as web components with generated class names, and nothing
 * published commits them to a shape. DRIFT IS THE EXPECTED STEADY STATE OF THE
 * `www` HALF OF THIS TABLE, which is why:
 *
 *   1. it is one exported constant rather than string literals scattered
 *      through the routines -- repairing drift is then a diff a reviewer can
 *      read;
 *   2. a miss is reported as `selector_drift` and NEVER as "the action failed";
 *   3. a miss on a control we were about to CLICK means nothing was clicked.
 *      Anything ambiguous after a click is `unknown`, not drift.
 *
 * The `old.reddit.com` half has been stable for a decade and is where every
 * read and every reply happens, which is the whole reason those two routines
 * use it.
 */
export const SELECTORS = {
  /* --- The sign-in form on www.reddit.com ----------------------------- */

  /**
   * The two sign-in inputs: NAMED MARKUP FIRST, TYPE-BASED AFTER.
   *
   * `input[name="username"]` is what both the current form and the legacy one
   * emit. The type-based fallbacks catch a rename; `:visible` is load-bearing
   * rather than tidiness, because Reddit renders the login form inside a
   * drawer that also exists collapsed on the same page, and `.first()` on an
   * unfiltered match fills the hidden copy and submits an empty form.
   */
  loginUsernameField: 'input[name="username"], input#loginUsername, input[name="user"], input[autocomplete="username"]:visible',
  loginPasswordField: 'input[name="password"], input#loginPassword, input[name="passwd"], input[type="password"]:visible',
  /**
   * OPTIONAL, unlike the two fields above. The current submit is a shadow-DOM
   * button with hashed classes and a label in whatever language Reddit decided
   * the viewer speaks. When this matches nothing, `loginWithCredentials`
   * presses Enter in the password field, which is what a person at that page
   * does anyway.
   */
  loginSubmitButton: 'button[type="submit"], button.login, faceplate-tracker[noun="login"] button',
  /** "Incorrect username or password", "invalid password". */
  loginError:
    'div[role="alert"], .error, .status.error, faceplate-form-error, '
    + 'text=/incorrect username or password|invalid (?:password|username)|wrong password|bad credentials/i',
  /**
   * The two-factor box. ITS PRESENCE IS THE WHOLE 2FA/CAPTCHA DISTINCTION:
   * both stall the sign-in, and only one of them can be finished by an operator
   * typing six digits into a field we already have.
   */
  otpField: 'input[name="otp"], input[autocomplete="one-time-code"], input#otp',
  otpSubmitButton: 'button[type="submit"], faceplate-tracker[noun="verify"] button',
  /** Captcha or "verify you are human". A person clears this, or nobody does. */
  challengeForm:
    'iframe[src*="recaptcha"], iframe[title*="challenge" i], div.g-recaptcha, #px-captcha, '
    + 'text=/verify you are human|complete the security check|unusual traffic/i',
  /**
   * THE WALL THAT LOOKS LIKE AN EMPTY PAGE, and the reason this entry exists.
   *
   * Reddit answers a datacenter IP -- which is what every container is -- with
   * a JS challenge and then with this: a 190KB document whose entire body is
   * "You've been blocked by network security". No posts, no sign-in chrome, no
   * error. Without this selector every routine downstream reports
   * `selector_drift`, and an operator goes looking for a CSS change that never
   * happened.
   */
  networkBlock: 'text=/blocked by network security|you.ve been blocked|file a ticket/i',
  /** "You are doing that too much. Try again in N minutes." */
  rateLimitNotice: 'text=/doing that too much|try again in \\d+ (?:second|minute|hour)|slow down/i',

  /* --- old.reddit.com: the surface everything else uses ---------------- */

  /**
   * A SIGN-IN OFFER, which only a signed-OUT visitor is shown.
   *
   * Scoped to the settings page by its one caller, and that scoping is what
   * makes it trustworthy: `Log In` also appears in the header of a public
   * listing that a signed-in member is reading, so used anywhere else this
   * would report every page as logged out.
   */
  signedOutMarker: 'a[href*="/login"], button:has-text("Log In")',
  /** The signed-in chrome. Present on every authenticated old-Reddit page. */
  oldUserBar: 'span.user a.user, form.logout, #header-bottom-right a.user',
  /** The signed-in handle, as old Reddit prints it in the top-right corner. */
  oldUserHandle: '#header-bottom-right span.user a, span.user a.user',
  /**
   * One post in a NEW Reddit listing. The primary surface since old Reddit was
   * retired. Every field this driver reads is an attribute on the element
   * itself, which is the one thing about a web component that is meant to be
   * read from outside it.
   */
  shredditPost: 'shreddit-post',
  /**
   * One post in an OLD Reddit listing. `.promoted` is excluded because an ad is
   * not a thread anybody asked to research, and its `data-permalink` points
   * off-site. Kept as a fallback: old Reddit is retired, not universally gone.
   */
  listingPost: '#siteTable div.thing.link:not(.promoted)',
  /**
   * The reply box on a thread page, and the button that files it.
   *
   * BOTH MARKUPS, new Reddit's composer first. UNVERIFIED AGAINST LIVE REDDIT:
   * every machine available while this was written is blocked by Reddit's
   * network security, so these were written from the published element names
   * and not confirmed against a rendered page. Expect `selector_drift` from the
   * reply path until somebody runs it from an unblocked machine, and repair it
   * HERE -- that is what this table is for.
   */
  commentBox:
    'shreddit-composer div[contenteditable="true"], shreddit-composer [role="textbox"], '
    + 'form.usertext.cloneable textarea[name="text"], .commentarea form.usertext textarea[name="text"]',
  commentSubmit:
    'shreddit-composer button[slot="submit-button"], shreddit-composer button[type="submit"], '
    + 'form.usertext.cloneable button.save, .commentarea form.usertext button[type="submit"]',
  /** Posted. Both surfaces re-render the comment tree with the new comment in it. */
  commentPosted: 'shreddit-comment, .commentarea div.comment',
  /** Locked, archived, or contributor-only. Reading is fine; replying is not. */
  repliesClosed:
    'text=/this thread is archived|this post is locked|you must be a? ?(?:approved )?(?:submitter|contributor)|comments are locked/i',
  /** Private, quarantined, or banned-from. Distinct from "does not exist". */
  subredditForbidden:
    'text=/this community is private|you must be invited to visit|has been banned|is quarantined|you are not allowed to post/i',
  /** "there doesn't seem to be anything here", "page not found". */
  notFoundNotice: 'text=/there doesn.t seem to be anything here|sorry, this page|page not found|this community does not exist/i'
} as const;

/** Reddit hosts this driver may navigate to. Nothing else, ever. */
const ALLOWED_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'np.reddit.com']);

/**
 * Where every thread reference is canonicalised to.
 *
 * `www`, not `old`. This was `old.reddit.com` while that surface still rendered
 * its own markup; it now serves the same app shell as `www`, so pointing a
 * reply at it buys nothing and costs a redirect. One constant, because a
 * thread URL is stored, compared and shown, and two spellings of the same
 * thread would dedupe as two.
 */
const THREAD_BASE = 'https://www.reddit.com';

const LOGIN_URL = 'https://www.reddit.com/login/';
/** URL-level proof of a session: signed out, Reddit bounces this to /login. */
const SETTINGS_URL = 'https://www.reddit.com/settings/';
const OLD_HOME_URL = 'https://old.reddit.com/';

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;
/** Long enough for Reddit's client-side render, short enough not to stall a batch. */
const SETTLE_MS = 1_500;

/**
 * The ceiling on one listing read.
 *
 * 100 is Reddit's own per-page maximum, and asking for more just paginates --
 * which is a second request per page and a second chance to be rate-limited,
 * for research nobody reads past the first screen of.
 */
export const MAX_READ_LIMIT = 100;
const DEFAULT_READ_LIMIT = 25;

/** Where a login page lands, checked before any selector is read. */
const LOGIN_PATH = /\/(?:login|register)\b/i;

/**
 * Reddit's bot check, WRITTEN INTO THE URL IT LEAVES BEHIND.
 *
 * The interstitial reloads the page it was serving with `?js_challenge=1` and
 * a `solution=` parameter bolted on, and it does that on the ORIGINAL path --
 * so a challenged `/settings/` request lands on a URL that still contains
 * `/settings/`. That is the false positive this exists to kill: `isLoggedIn`
 * would otherwise read "we are on /settings, therefore signed in" off a page
 * that is a bot check, stamp `session_valid_at`, and leave a status screen
 * claiming a live session that has never existed.
 */
const CHALLENGE_QUERY = /[?&](?:js_challenge=1|solution=)/i;

function fail(failureKind: RedditFailureKind, detail: string): RedditDriverResult {
  return { ok: false, failureKind, detail };
}

/** True when `selector` matches at least one node. Never throws. */
async function present(page: RedditPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    // A locator that could not even be evaluated is not evidence of anything.
    return false;
  }
}

/**
 * Which wall, if any, this page is showing.
 *
 * ORDERED BY SPECIFICITY, and the order is the point: a rate-limit notice and a
 * captcha can both be on screen during an anti-abuse response, and calling that
 * a rate limit would have the caller wait an hour for something no wait fixes.
 */
async function detectWall(page: RedditPage): Promise<RedditFailureKind | null> {
  // FIRST, because it is the one that renders as an empty page. Everything
  // below reads markup; a blocked request has none of it, and a blocked request
  // mistaken for anything else sends the operator to fix the wrong thing.
  if (CHALLENGE_QUERY.test(page.url())) return 'challenge';
  if (await present(page, SELECTORS.networkBlock)) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.rateLimitNotice)) return 'rate_limited';
  if (await present(page, SELECTORS.subredditForbidden)) return 'forbidden';
  if (await present(page, SELECTORS.notFoundNotice)) return 'not_found';
  return null;
}

/**
 * One sentence naming what the wall actually was, for the operator to act on.
 *
 * THE NETWORK BLOCK IS SPLIT OUT FROM THE CAPTCHA even though `detectWall`
 * reports both as `challenge`, because the two have COMPLETELY different
 * remedies and the failure kind is a signal to the caller, not a message to a
 * human. A captcha is cleared by a person at a window. A block is not cleared
 * at all -- Reddit has refused this IP, and the only thing that changes the
 * answer is running from a different one, which for a container means the
 * operator's own machine.
 */
async function wallDetail(page: RedditPage, wall: RedditFailureKind, what: string): Promise<string> {
  if (wall === 'challenge') {
    const blocked = CHALLENGE_QUERY.test(page.url()) || (await present(page, SELECTORS.networkBlock));
    return blocked
      ? `Reddit blocked this machine's network before ${what} loaded -- it answers with a bot check, not with posts. `
        + 'This is what a container or VPS IP gets. Run `npm run reddit:worker` on your own machine and read from there.'
      : `Reddit is holding ${what} behind a human check at ${page.url()}, which only a person at a browser window can finish.`;
  }
  if (wall === 'rate_limited') {
    return `Reddit answered ${what} with a rate-limit notice. Wait it out rather than retrying.`;
  }
  if (wall === 'forbidden') {
    return `${what} is private, quarantined, or this account cannot see it.`;
  }
  return `${what} does not exist, or has nothing to read.`;
}

/**
 * A subreddit name, or null.
 *
 * `subreddit` is an opaque string a human typed, and this driver navigates an
 * AUTHENTICATED browser to it. Reddit's own rule is 2-21 characters of
 * `[A-Za-z0-9_]`, so anything else -- a full URL to somebody else's site, a
 * multireddit `a+b`, a query string -- is refused here rather than dialled.
 *
 * TWO FORMS ARE ACCEPTED, AND ONLY TWO, because they are the two an operator
 * actually has in hand: a bare name, and a reddit.com path or URL whose FIRST
 * segment after `r/` is the name.
 *
 *   'SaaS'                                -> 'SaaS'
 *   'r/SaaS', '/r/SaaS'                   -> 'SaaS'
 *   'https://old.reddit.com/r/SaaS/new/'  -> 'SaaS'   (the sort is not the name)
 *   'r/SaaS/../../evil'                   -> 'SaaS'   (a path; only the name is kept)
 *   'SaaS/evil'                           -> null
 *
 * THE LAST TWO LINES ARE THE RULE THAT MATTERS AND THEY DIFFER ON PURPOSE. A
 * string that announces itself as a path -- it starts with `r/` or a reddit URL
 * -- has its trailing segments DISCARDED, and the name that survives is
 * re-validated character by character before it is ever interpolated into a
 * URL, so no traversal can escape it. A bare string with a slash in it
 * announces nothing; it is simply not a subreddit name, and quietly reading
 * `SaaS` for somebody who asked for `SaaS/evil` would answer a question they
 * did not ask.
 */
export function normaliseSubreddit(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;

  // The host is matched only to REMOVE it. Anything else -- `evil.example`, or
  // `reddit.com.evil.example` -- keeps its host in the string, fails both
  // patterns below, and comes back null.
  const path = trimmed.replace(/^https?:\/\/(?:www\.|old\.|np\.)?reddit\.com/i, '');
  const asPath = /^\/?r\/([A-Za-z0-9_]{2,21})(?:\/.*)?$/i.exec(path);
  if (asPath) return asPath[1];

  return /^[A-Za-z0-9_]{2,21}$/.test(trimmed) ? trimmed : null;
}

/**
 * The canonical old-Reddit URL for an operator-supplied thread reference.
 *
 * The host is CHECKED rather than trusted, for the same reason the subreddit
 * name is: a target of `https://evil.example/steal` would otherwise open a
 * session-bearing tab on somebody else's site. A permalink path
 * (`/r/sub/comments/abc/title/`) is accepted because that is exactly what
 * `readSubreddit` returns.
 */
export function threadUrlFor(target: string): string | null {
  const trimmed = typeof target === 'string' ? target.trim() : '';
  if (!trimmed) return null;

  if (trimmed.startsWith('/')) {
    return /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/[A-Za-z0-9]+/.test(trimmed)
      ? `${THREAD_BASE}${trimmed.endsWith('/') ? trimmed : `${trimmed}/`}`
      : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!/^\/r\/[A-Za-z0-9_]{2,21}\/comments\/[A-Za-z0-9]+/.test(url.pathname)) return null;
  // Query and hash are dropped: `?context=3` and `#t1_xyz` change what a human
  // sees and nothing about which thread is being replied to.
  return `${THREAD_BASE}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`;
}

/** A whole non-negative number, or null. A count nobody could read must never be paced against. */
function numberOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const digits = raw.replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/** Read one attribute without caring whether this locator implementation has the method. */
async function attribute(locator: RedditLocator, name: string): Promise<string | null> {
  if (typeof locator.getAttribute !== 'function') return null;
  try {
    return await locator.getAttribute(name, { timeout: CLICK_TIMEOUT_MS });
  } catch {
    return null;
  }
}

async function text(page: RedditPage, selector: string): Promise<string | null> {
  try {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) return null;
    const value = await locator.first().textContent({ timeout: CLICK_TIMEOUT_MS });
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Signing in: the fallback, never the default.
 * ------------------------------------------------------------------------ */

/**
 * Is this browser profile already signed in?
 *
 * ASKED BEFORE EVERY SIGN-IN, and it is the reason the credential path is a
 * fallback rather than a routine. A persistent user-data-dir keeps Reddit's
 * cookies for months; re-authenticating anyway would be slower on every run
 * and, more importantly, a much stronger automation signal than a session that
 * simply keeps working.
 *
 * `/settings/` is the probe rather than a selector on the front page, because
 * THE ANSWER IS THE URL and no markup has to hold still for it: signed out,
 * Reddit bounces it to `/login`. The old-Reddit user bar is a second chance for
 * a session that landed somewhere unexpected, never the first.
 *
 * NEVER THROWS. Anything it could not determine is `false`, which costs a
 * sign-in attempt that was probably unnecessary -- the cheap wrong answer.
 */
export async function isLoggedIn(page: RedditPage): Promise<boolean> {
  try {
    await page.goto(SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // FOUR TIMES THE USUAL SETTLE, AND IT IS NOT PADDING. The bounce to /login
    // is performed by Reddit's own client after the document has loaded, so a
    // short wait reads the URL BEFORE the redirect and concludes the session is
    // live. Measured: a signed-out profile still showed `/settings/` at 2.5s and
    // `/login/?dest=…` at 6s. This is the same false positive as the bot check
    // below, arriving by a different route.
    await page.waitForTimeout(SETTLE_MS * 4);
  } catch {
    return false;
  }
  if (LOGIN_PATH.test(page.url())) return false;
  // A bot check keeps the path it interrupted, so the URL test below would read
  // `/settings/?js_challenge=1` as a live session. It is not one: nothing has
  // been proved about this account, and saying otherwise stamps a session that
  // does not exist.
  if (CHALLENGE_QUERY.test(page.url())) return false;
  if (await present(page, SELECTORS.networkBlock)) return false;
  // A sign-in affordance ON THE SETTINGS PAGE settles it: a signed-in member is
  // never offered "Log In" there. Checked before the URL test, because the URL
  // is the signal that has now been wrong twice.
  if (await present(page, SELECTORS.signedOutMarker)) return false;
  if (/\/settings/i.test(page.url())) return true;
  return present(page, SELECTORS.oldUserBar);
}

/**
 * The signed-in account's own handle, read off old Reddit's header.
 *
 * Read rather than asked, for the same reason LinkedIn's seat detection reads
 * the profile out of the session: the browser already knows which account it
 * is, and a handle a human typed is a handle that can be wrong.
 *
 * NEVER THROWS. Null means "could not read it", which the caller records as
 * unknown rather than as a mismatch.
 */
export async function readHandle(page: RedditPage): Promise<string | null> {
  try {
    await page.goto(OLD_HOME_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch {
    return null;
  }
  const handle = await text(page, SELECTORS.oldUserHandle);
  if (!handle) return null;
  const bare = handle.replace(/^\/?u(?:ser)?\//i, '').trim();
  return /^[A-Za-z0-9_-]{3,20}$/.test(bare) ? bare : null;
}

/**
 * Type the operator's own username and password into Reddit's sign-in form.
 *
 * NEITHER VALUE SURVIVES THIS CALL. They arrive as arguments, go into two
 * `fill()`s, and are never assigned to anything that outlives the function,
 * never logged, and -- the rule that matters most -- never interpolated into a
 * returned `detail`. Every message below is built from constants, selector
 * names and `page.url()`.
 *
 * THE FOUR ANSWERS, and telling them apart is the entire job:
 *
 *   { ok: true }             signed in. The persistent user-data-dir now holds
 *                            the session; the caller stamps `session_valid_at`
 *                            so the next run reuses it.
 *   { ok: false, needsOtp }  Reddit wants a two-factor code. NOT A FAILURE --
 *                            it is a step, finished by calling again with `otp`.
 *   failureKind 'challenge'  a captcha. A PERSON has to clear this in a real
 *                            window; no code we could write finishes it, and
 *                            pretending otherwise would retry into a lockout.
 *   failureKind 'not_found'  Reddit does not recognise this pair. Definite, in
 *                            the exact sense the vocabulary already gives that
 *                            kind: it will not happen on a retry with the same
 *                            input.
 */
export async function loginWithCredentials(
  page: RedditPage,
  credentials: { username: string; password: string; otp?: string }
): Promise<RedditLoginResult> {
  const otp = credentials.otp?.trim() ?? '';

  // THE CODE PATH FIRST, and only when a code box is already on screen. An OTP
  // answers a two-factor page a previous call left open; navigating to /login
  // again would discard it and make Reddit issue a fresh challenge, which is
  // how an operator ends up typing an expired code forever.
  if (otp && (await present(page, SELECTORS.otpField))) return submitOtp(page, otp);

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    return fail('selector_drift', `Could not open the Reddit sign-in page: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was typed.`);
  }

  const username = page.locator(SELECTORS.loginUsernameField);
  if ((await username.count()) === 0) {
    // /login on a live session redirects to the front page, which is a success
    // we reached by a different door.
    if (!LOGIN_PATH.test(page.url())) return { ok: true };
    if (await present(page, SELECTORS.otpField)) return readLoginStanding(page, otp);
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginUsernameField}. Nothing was typed.`);
  }

  // BOTH CONTROLS ARE READ BEFORE EITHER IS FILLED, so a miss on the second is
  // unambiguously "nothing was typed" rather than "a username is sitting in a
  // form we then abandoned".
  const password = page.locator(SELECTORS.loginPasswordField);
  if ((await password.count()) === 0) {
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginPasswordField}. Nothing was typed.`);
  }
  // A MISSING SUBMIT BUTTON IS NOT A FAILURE HERE (see the selector's note):
  // the password field's Enter key submits the same form, and refusing the
  // sign-in over a button we cannot name would strand every account the moment
  // Reddit reskins its login page.
  const submit = page.locator(SELECTORS.loginSubmitButton);
  const submitByClick = (await submit.count()) > 0;
  const passwordField = password.first();
  if (!submitByClick && typeof passwordField.press !== 'function') {
    return fail('selector_drift', `The sign-in page shows no ${SELECTORS.loginSubmitButton}, and this page cannot press a key. Nothing was typed.`);
  }

  try {
    await username.first().fill(credentials.username, { timeout: CLICK_TIMEOUT_MS });
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
 * What Reddit did with the sign-in, read off whatever is now on screen.
 *
 * THE ORDER IS THE POINT. A two-factor prompt and a captcha both stall the same
 * page, and only one of them can be finished by an operator typing six digits
 * into a box we are already looking at -- so the code box is read FIRST, and
 * `challenge` means what is left.
 */
async function readLoginStanding(page: RedditPage, otp: string): Promise<RedditLoginResult> {
  if (await present(page, SELECTORS.otpField)) {
    if (otp) return submitOtp(page, otp);
    return { ok: false, needsOtp: true };
  }

  const wall = await detectWall(page);
  if (wall === 'challenge') {
    return fail(
      'challenge',
      `Reddit is holding this sign-in at ${page.url()} behind a human check, which only a person at a browser window can finish.`
    );
  }
  if (wall) {
    return fail(wall, `Reddit answered the sign-in with a ${wall === 'rate_limited' ? 'rate-limit notice' : 'refusal'}, so no session was opened.`);
  }

  if (await present(page, SELECTORS.loginError)) {
    // Definite and un-retryable with the same input, which is what 'not_found'
    // already means in this vocabulary. The message names neither value.
    return fail('not_found', 'Reddit did not accept that username and password. Save the right ones and sign in again.');
  }

  if (await isLoggedIn(page)) return { ok: true };

  return fail('unknown', `The sign-in at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`);
}

/** Type a two-factor code and read what happened. Never called without one. */
async function submitOtp(page: RedditPage, otp: string): Promise<RedditLoginResult> {
  const field = page.locator(SELECTORS.otpField);
  if ((await field.count()) === 0) {
    return fail('selector_drift', `No two-factor box matched ${SELECTORS.otpField}, so the code was not typed.`);
  }
  const submit = page.locator(SELECTORS.otpSubmitButton);
  const fieldFirst = field.first();
  const submitByClick = (await submit.count()) > 0;
  if (!submitByClick && typeof fieldFirst.press !== 'function') {
    return fail('selector_drift', `The two-factor box has no submit control matching ${SELECTORS.otpSubmitButton}, so the code was not sent.`);
  }

  try {
    await fieldFirst.fill(otp, { timeout: CLICK_TIMEOUT_MS });
    if (submitByClick) await submit.first().click({ timeout: CLICK_TIMEOUT_MS });
    else await fieldFirst.press!('Enter', { timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS * 2);
  } catch (cause) {
    return fail('unknown', `The two-factor code was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether the session opened is unknown.`);
  }

  // Still a code box: wrong or expired. Asking for another code is the whole
  // fix, so this is `needsOtp` again rather than a failure to interpret.
  if (await present(page, SELECTORS.otpField)) return { ok: false, needsOtp: true };

  const wall = await detectWall(page);
  if (wall) {
    return fail(
      wall,
      wall === 'challenge'
        ? `Reddit answered the two-factor code at ${page.url()} with a human check, which only a person at a browser window can finish.`
        : `Reddit answered the two-factor code with a ${wall === 'rate_limited' ? 'rate-limit notice' : 'refusal'}, so no session was opened.`
    );
  }

  if (await isLoggedIn(page)) return { ok: true };
  return fail('unknown', `The two-factor code at ${page.url()} neither succeeded nor reported an error, so whether a session opened is unknown.`);
}

/* ---------------------------------------------------------------------------
 * Research: read a subreddit the way a human scrolling it would.
 * ------------------------------------------------------------------------ */

/**
 * One listing page of a subreddit, read out of the signed-in session.
 *
 * READ-ONLY, AND THAT IS WHY IT NEEDS NO PACING. Nothing here posts, votes,
 * subscribes or follows: it is one GET of a page the account is already allowed
 * to see, which is the same request the operator's own scroll makes.
 *
 * A PARTIAL ANSWER IS STILL AN ANSWER. Success carries a `degraded` list rather
 * than an `ok:false`, because the fields fail independently -- a title we read
 * and a score we could not is a partial read, and reporting it as a failure
 * would throw away the part that worked. A count nobody could read comes back
 * NULL, never zero, because a number nobody measured must never be ranked on.
 */
export async function readSubreddit(
  page: RedditPage,
  subreddit: string,
  options: RedditReadOptions = {}
): Promise<RedditResearchRead | RedditDriverResult> {
  const name = normaliseSubreddit(subreddit);
  if (!name) {
    return fail('not_found', 'That is not a subreddit name. Use something like `SaaS` or `r/SaaS`, letters, digits and underscores only.');
  }
  const sort: RedditSort = REDDIT_SORTS.includes(options.sort as RedditSort) ? (options.sort as RedditSort) : 'hot';
  // Dropped for every other sort rather than passed and ignored, so the URL
  // this dialled is the URL the answer describes.
  const time: RedditTime | null = sort === 'top' && REDDIT_TIMES.includes(options.time as RedditTime)
    ? (options.time as RedditTime)
    : null;
  const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(options.limit ?? DEFAULT_READ_LIMIT) || DEFAULT_READ_LIMIT));

  const degraded: string[] = [];

  // NEW REDDIT FIRST, OLD REDDIT AS A FALLBACK. Old Reddit was the primary
  // surface until it was retired and started serving the same app shell as
  // `www`; trying it first now costs a wasted page load on every read.
  for (const surface of LISTING_SURFACES) {
    const url = `${surface.url(name, sort, limit)}${time ? `&t=${time}` : ''}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    } catch (cause) {
      return fail('unknown', `Could not open r/${name}: ${cause instanceof Error ? cause.message : String(cause)}.`);
    }

    // BEFORE ANY LISTING SELECTOR IS COUNTED. A blocked or challenged page has
    // no posts on it, and calling that drift is what sends an operator to edit
    // a CSS table over a network problem.
    const wall = await detectWall(page);
    if (wall) return fail(wall, await wallDetail(page, wall, `r/${name}`));
    // A login wall on a read means the session died between the last check and
    // this request. Reported as `unknown` rather than as a missing subreddit:
    // the caller re-opens the session, it does not go looking for the community.
    if (LOGIN_PATH.test(page.url())) {
      return fail('unknown', `Reddit asked for a sign-in at ${page.url()} instead of showing r/${name}, so the session is no longer live.`);
    }

    let total = 0;
    try {
      total = await page.locator(surface.post).count();
    } catch {
      total = 0;
    }
    if (total === 0) {
      degraded.push(`${surface.label} rendered no posts matching ${surface.post}.`);
      continue;
    }

    const threads = await readListing(page, surface, name, Math.min(total, limit), degraded);
    if (threads.length === 0) {
      return fail('selector_drift', `r/${name} rendered ${total} post(s) on ${surface.label} but none carried a readable permalink. Nothing was read.`);
    }
    return { ok: true, subreddit: name, sort, time, threads, degraded };
  }

  // BOTH SURFACES EMPTY. Named as drift because that is what it is once the
  // walls above have been ruled out -- but the sentence carries the thing an
  // operator is far more likely to be looking at, because a container's IP is
  // blocked long before Reddit renames an element.
  return fail(
    'selector_drift',
    `r/${name} rendered no posts on either surface (${LISTING_SURFACES.map((s) => s.post).join(' or ')}). `
    + 'If this machine is a container or a VPS, Reddit is most likely refusing it by IP rather than having changed its markup -- '
    + 'run `npm run reddit:worker` on your own machine and read from there.'
  );
}

/**
 * The two listing markups this driver can read, and where each one lives.
 *
 * ONE TABLE RATHER THAN TWO CODE PATHS, so adding a third surface -- or
 * deleting old Reddit once it is finally gone -- is a diff a reviewer can read
 * rather than a second copy of the loop below.
 */
interface ListingSurface {
  label: string;
  url(name: string, sort: RedditSort, limit: number): string;
  /** The element that IS one post. */
  post: string;
  /** Attribute names, per surface. `title` null means "read it from `titleSelector` instead". */
  fields: {
    id: string;
    permalink: string;
    title: string | null;
    author: string;
    subreddit: string;
    score: string;
    comments: string;
    created: string;
  };
  /** A descendant selector carrying the title, when it is not an attribute. */
  titleSelector: string | null;
}

const LISTING_SURFACES: readonly ListingSurface[] = [
  {
    label: 'new Reddit',
    url: (name, sort, limit) => `https://www.reddit.com/r/${name}/${sort}/?limit=${limit}`,
    post: SELECTORS.shredditPost,
    fields: {
      id: 'id',
      permalink: 'permalink',
      title: 'post-title',
      author: 'author',
      subreddit: 'subreddit-prefixed-name',
      score: 'score',
      comments: 'comment-count',
      created: 'created-timestamp'
    },
    titleSelector: null
  },
  {
    label: 'old Reddit',
    url: (name, sort, limit) => `https://old.reddit.com/r/${name}/${sort}/?limit=${limit}`,
    post: SELECTORS.listingPost,
    fields: {
      id: 'data-fullname',
      permalink: 'data-permalink',
      title: null,
      author: 'data-author',
      subreddit: 'data-subreddit',
      score: 'data-score',
      comments: 'data-comments-count',
      created: 'data-timestamp'
    },
    titleSelector: 'a.title'
  }
];

/**
 * Epoch milliseconds (old Reddit) or an ISO string (new Reddit), or null.
 *
 * Both forms are accepted because the two surfaces genuinely differ, and a
 * timestamp nobody could parse comes back NULL rather than as the epoch -- a
 * post dated 1970 would sort to the bottom of every list that trusts it.
 */
function timestampOrNull(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Walk one rendered listing. Appends to `degraded`; never throws. */
async function readListing(
  page: RedditPage,
  surface: ListingSurface,
  name: string,
  wanted: number,
  degraded: string[]
): Promise<RedditThread[]> {
  const threads: RedditThread[] = [];

  for (let index = 0; index < wanted; index += 1) {
    // Chained selectors rather than a child-locator method: `>> nth=N >>` is
    // Playwright's own syntax and keeps `RedditLocator` down to the handful of
    // methods a fake has to implement.
    const post = page.locator(`${surface.post} >> nth=${index}`);
    const permalink = await attribute(post, surface.fields.permalink);
    const id = await attribute(post, surface.fields.id);
    // Re-checked against the allowed-host list rather than trusted, even though
    // it came off a page we opened: a permalink on a crosspost or a rehosted
    // listing can point anywhere.
    const threadUrl = permalink ? threadUrlFor(permalink) : null;
    if (!threadUrl || !id) {
      // One unreadable row is not a failed read. It is named and skipped, so
      // the operator can see the listing was not complete.
      degraded.push(`Post ${index + 1} carried no usable permalink, so it was skipped.`);
      continue;
    }

    const title = surface.fields.title
      ? await attribute(post, surface.fields.title)
      : await text(page, `${surface.post} >> nth=${index} >> ${surface.titleSelector}`);
    if (!title) degraded.push(`Post ${index + 1} had no readable title.`);

    threads.push({
      id,
      url: threadUrl,
      title: title ?? '',
      author: await attribute(post, surface.fields.author),
      subreddit: (await attribute(post, surface.fields.subreddit)) ?? name,
      score: numberOrNull(await attribute(post, surface.fields.score)),
      comments: numberOrNull(await attribute(post, surface.fields.comments)),
      createdAt: timestampOrNull(await attribute(post, surface.fields.created))
    });
  }

  return threads;
}

/* ---------------------------------------------------------------------------
 * Replying: the one routine that writes.
 * ------------------------------------------------------------------------ */

/**
 * Post one comment in one thread the operator named.
 *
 * THE OPERATOR CHOSE THE THREAD AND WROTE THE WORDS. This routine navigates,
 * types and clicks; it does not decide where to speak or what to say, and
 * nothing calls it in a loop over a listing. That is the line between "an
 * account automating its owner" and the sitewide-spam-policy problem that keeps
 * `channels/adapters/reddit.ts` on `prepare-only` for submissions.
 *
 * `unknown` IS THE HONEST ANSWER AFTER A CLICK. Once the button is pressed we
 * may have posted; a caller that retries an `unknown` posts twice, and a
 * duplicate comment cannot be un-posted. So the only definite successes are the
 * ones where the comment tree came back with a comment in it.
 */
export async function commentOnThread(page: RedditPage, threadUrl: string, body: string): Promise<RedditDriverResult> {
  const url = threadUrlFor(threadUrl);
  if (!url) {
    return fail('not_found', 'That is not a Reddit thread URL. Nothing was opened.');
  }
  const message = typeof body === 'string' ? body.trim() : '';
  if (!message) return fail('not_found', 'A comment needs words. Nothing was opened.');

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (cause) {
    return fail('unknown', `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was typed.`);
  }

  const wall = await detectWall(page);
  if (wall) {
    return fail(
      wall,
      wall === 'rate_limited'
        ? `Reddit is rate-limiting this account at ${url}, so nothing was typed. Wait it out rather than retrying.`
        : `Reddit answered ${url} with a ${wall === 'challenge' ? 'human check' : wall === 'forbidden' ? 'refusal' : 'not-found page'}, so nothing was typed.`
    );
  }
  if (LOGIN_PATH.test(page.url())) {
    return fail('unknown', `Reddit asked for a sign-in at ${page.url()} instead of showing the thread, so the session is no longer live. Nothing was typed.`);
  }
  // Archived, locked, or contributor-only. Definite, and NOT a rate limit: no
  // amount of waiting opens an archived thread.
  if (await present(page, SELECTORS.repliesClosed)) {
    return fail('forbidden', `${url} is archived, locked, or restricted to approved contributors, so no reply is possible. Nothing was typed.`);
  }

  // BOTH CONTROLS ARE READ BEFORE EITHER IS USED, so a miss on the second is
  // unambiguously "nothing was typed".
  const box = page.locator(SELECTORS.commentBox);
  if ((await box.count()) === 0) {
    return fail('selector_drift', `The thread shows no reply box matching ${SELECTORS.commentBox}. Nothing was typed.`);
  }
  const submit = page.locator(SELECTORS.commentSubmit);
  if ((await submit.count()) === 0) {
    return fail('selector_drift', `The reply box has no submit control matching ${SELECTORS.commentSubmit}. Nothing was typed.`);
  }

  try {
    await box.first().fill(message, { timeout: CLICK_TIMEOUT_MS });
    await submit.first().click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS * 2);
  } catch (cause) {
    return fail('unknown', `The reply was interrupted after submit: ${cause instanceof Error ? cause.message : String(cause)}. Whether it posted is unknown.`);
  }

  // A rate limit AFTER the click is the common one: Reddit accepts the form and
  // answers "you are doing that too much". Nothing posted, and the caller must
  // not retry into a longer ban.
  if (await present(page, SELECTORS.rateLimitNotice)) {
    return fail('rate_limited', `Reddit answered the reply at ${url} with "you are doing that too much", so it did not post. Wait it out rather than retrying.`);
  }
  const afterWall = await detectWall(page);
  if (afterWall) {
    return fail(afterWall, `Reddit answered the reply at ${url} with a ${afterWall === 'challenge' ? 'human check' : 'refusal'}, so whether it posted is unknown.`);
  }

  if (await present(page, SELECTORS.commentPosted)) {
    return { ok: true, failureKind: null, externalRef: url, detail: `Replied in ${url}.` };
  }

  return fail('unknown', `The reply at ${url} neither appeared in the thread nor reported an error, so whether it posted is unknown. Check the thread before replying again.`);
}

/**
 * The real driver. `local-worker.ts` takes this as a parameter so tests can
 * pass a fake.
 */
export const playwrightRedditDriver: RedditDriver = {
  isLoggedIn,
  loginWithCredentials,
  readHandle,
  readSubreddit,
  commentOnThread
};
