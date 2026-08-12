/**
 * The Reddit worker: the only thing that opens a browser at Reddit, and the
 * only caller of the one function that decrypts a Reddit password.
 *
 * SELF-HOSTED ONLY, AND THE GATE IS FIRST IN EVERY FUNCTION. `config.enabled`
 * is false on a hosted deployment and no environment variable makes it true.
 * Nothing below runs on a hosted instance.
 *
 * THE PASSWORD'S WHOLE LIFETIME IS ONE `const` IN `loginRedditAccount`. It is
 * decrypted at the moment of use, handed straight to the driver, and never
 * assigned to an outcome, a log line, or anything that outlives that call.
 *
 * A SEPARATE BROWSER PROFILE FROM LINKEDIN'S, NECESSARILY. One persistent
 * user-data-dir holds one signed-in Chrome, and pointing both workers at the
 * same directory would have them fight over the profile lock. Default:
 * `~/.trevra/reddit-profile`.
 *
 * NEVER THROWS. Every refusal is a status plus one sentence, because the
 * callers are worker ticks and HTTP handlers and neither may 500 because Reddit
 * wants a captcha.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  browserBlockers,
  displayBlocker,
  inContainer,
  openPersistentBrowser,
  playwrightBrowsersPath,
  type BrowserContextLike
} from '../browser/local.js';
import type { Db } from '../db.js';
import { readRedditCredentials } from '../secrets/reddit.js';
import { stampRedditSessionValid } from './account.js';
import {
  playwrightRedditDriver,
  type RedditDriver,
  type RedditDriverResult,
  type RedditPage,
  type RedditReadOptions,
  type RedditResearchRead
} from './driver.js';

export interface RedditLocalWorkerConfig {
  enabled: boolean;
  /** Absent means the default below. */
  profileDir?: string | null;
  /**
   * True on a hosted deployment, where `enabled` is false and cannot be made
   * true. Carried so a refusal can say WHICH kind of off it is: "turned off"
   * has a fix, "hosted" does not, and telling an operator to go looking for a
   * switch that does not exist is the dead end this flag removes.
   */
  hosted?: boolean;
}

const DEFAULT_PROFILE_DIR = '~/.trevra/reddit-profile';

/**
 * The Chrome profile directory, `~` expanded here rather than in `config.ts`.
 *
 * Resolved at the use site on purpose: `$HOME` belongs to the process that
 * actually launches the browser, and baking it into config would put one
 * machine's home directory into a value other machines read.
 */
export function resolveRedditProfileDir(configured?: string | null): string {
  const raw = configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR;
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Why Reddit automation is off, in one sentence.
 *
 * TWO KINDS OF OFF, and conflating them is what sends an operator hunting for
 * a switch. Hosted is a decision the deployment made and no environment
 * variable can undo it; anything else is a self-hoster's own setting.
 */
export function redditOffReason(config: Pick<RedditLocalWorkerConfig, 'hosted'>): string {
  return config.hosted
    ? 'This deployment is hosted, so Reddit automation is off and cannot be enabled.'
    : 'Reddit automation is switched off on this server.';
}

export interface RedditBrowserReadiness {
  canLaunchHeaded: boolean;
  /** Empty exactly when `canLaunchHeaded` is true. One sentence each. */
  reasons: string[];
}

export interface RedditHeadlessReadiness {
  canLaunchHeadless: boolean;
  /** Empty exactly when `canLaunchHeadless` is true. One sentence each. */
  reasons: string[];
}

/**
 * Can this process open a headed Chrome, and if not, what is the one thing to
 * do about it?
 *
 * The container line is CONTEXT, not a verdict: a container with a forwarded
 * display can genuinely run this. It is emitted only alongside a real blocker,
 * because it is the fact that explains why the others are true -- an operator
 * told "no display" inside Docker has learned nothing they can act on.
 */
export function redditBrowserReadiness(
  config: RedditLocalWorkerConfig,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): RedditBrowserReadiness {
  if (!config.enabled) return { canLaunchHeaded: false, reasons: [redditOffReason(config)] };

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const blockers = browserBlockers(env, platform);
  const display = displayBlocker(env, platform);
  if (display) blockers.push(display);

  if (blockers.length === 0) return { canLaunchHeaded: true, reasons: [] };
  return {
    canLaunchHeaded: false,
    reasons: inContainer()
      ? ['This process runs in a container, which has no display and no browser of its own.', ...blockers]
      : blockers
  };
}

/**
 * Can this process open a HEADLESS Chromium?
 *
 * The same probe minus the display check, because that is the entire
 * difference: a headless browser needs a binary and nothing to draw on. In a
 * container the headed answer is always no and this one is yes as soon as
 * `npx playwright install chromium` has run in the image.
 *
 * An account that stored its own sign-in needs nothing else to be usable -- it
 * opens its own session and shows no human a login form because none is needed.
 */
export function redditHeadlessReadiness(
  config: RedditLocalWorkerConfig,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): RedditHeadlessReadiness {
  if (!config.enabled) return { canLaunchHeadless: false, reasons: [redditOffReason(config)] };
  const blockers = browserBlockers(options.env ?? process.env, options.platform ?? process.platform);
  return blockers.length === 0 ? { canLaunchHeadless: true, reasons: [] } : { canLaunchHeadless: false, reasons: blockers };
}

interface BrowserHandle {
  page: RedditPage;
  /** Which mode this handle was opened in, so a reuse cannot silently be the wrong one. */
  headless: boolean;
  close(): Promise<void>;
}

let browser: BrowserHandle | null = null;
let unreadyLogged = '';

/**
 * Say once, per distinct set of reasons, that this process cannot drive a
 * browser. This runs on a per-tick loop, and a repeated line is a line nobody
 * reads.
 */
function reportUnready(log: (message: string) => void, reasons: string[]): void {
  const summary = reasons.join(' ');
  if (unreadyLogged === summary) return;
  unreadyLogged = summary;
  log(`Reddit local worker stays off here: ${summary}`);
}

/**
 * Attach to this account's persistent Chrome profile, launching Chromium if
 * needed.
 *
 * HEADED IS PREFERRED WHENEVER IT IS AVAILABLE. The operator can watch what the
 * worker does and close it, and a signed-in window is strictly easier to
 * troubleshoot than one nobody can see. `headless: true` is what a container
 * falls back to: no display, no window to show. Either way the account signs
 * itself in with its own stored credentials -- headless just means nobody is
 * watching it do so.
 *
 * A MODE CHANGE REOPENS. The handle records which mode it was launched in, so a
 * headless job cannot silently be answered by a headed window left over from
 * something else, or the reverse.
 */
async function openBrowser(
  config: RedditLocalWorkerConfig,
  log: (message: string) => void,
  options: { headless?: boolean } = {}
): Promise<BrowserHandle | null> {
  const headless = options.headless ?? false;
  if (browser && browser.headless === headless) return browser;
  if (browser) await closeRedditBrowser();

  const profileDir = resolveRedditProfileDir(config.profileDir);
  const opened = await openPersistentBrowser(profileDir, { headless });
  if ('failed' in opened) {
    log(`Reddit local worker could not open a browser: ${opened.failed}`);
    return null;
  }

  const context: BrowserContextLike = opened.context;
  browser = {
    page: opened.page as RedditPage,
    headless,
    close: async () => {
      await context.close();
    }
  };
  return browser;
}

/**
 * Which browser mode this process should use, or the one thing to do about it.
 *
 * HEADED WINS WHEN IT IS AVAILABLE, always. A window the operator can see is
 * strictly better than one they cannot: they can watch it, close it, and clear
 * a captcha in it. Headless is what is left when there is no display.
 */
function accountBrowserMode(config: RedditLocalWorkerConfig): { headless: boolean; blocked: string | null } {
  const headed = redditBrowserReadiness(config);
  if (headed.canLaunchHeaded) return { headless: false, blocked: null };
  const headless = redditHeadlessReadiness(config);
  if (headless.canLaunchHeadless) return { headless: true, blocked: null };
  // Neither. The headed reasons are the fuller set and already carry the
  // container line that explains the rest.
  return { headless: false, blocked: headed.reasons[headed.reasons.length - 1] ?? redditOffReason(config) };
}

/** The four answers `POST /api/reddit/login` may give. */
export type RedditLoginStatus = 'ok' | 'otp_required' | 'challenge' | 'failed';

export interface RedditLoginOutcome {
  status: RedditLoginStatus;
  /** One sentence for the operator. NEVER carries either stored value. */
  message: string;
  /** The handle the session reports, once one is live. Public; see account.ts. */
  username?: string | null;
}

/** Every place a browser handle failed to open says this, verbatim. */
const BROWSER_OPEN_FAILED_MESSAGE =
  'Could not open a Reddit browser session on this machine; check that Chromium is installed and try again.';

/**
 * Make this workspace's Reddit session usable: reuse it if it works, sign in if
 * it does not.
 *
 * THE ORDER IS THE SECURITY AND THE SAFETY ARGUMENT AT ONCE. `isLoggedIn` runs
 * first, every time, and the stored session wins whenever it still works -- a
 * persistent user-data-dir keeps Reddit's cookies for months, and
 * re-authenticating anyway would be slower on every run and a much stronger
 * automation signal than a session that simply keeps working. The password is
 * therefore NOT EVEN READ on the normal path; it is opened only when the
 * session has actually expired.
 *
 * NEVER THROWS. Every refusal is a `status` plus one sentence, because its
 * callers are worker loops and HTTP handlers.
 */
export async function loginRedditAccount(
  db: Db,
  config: RedditLocalWorkerConfig,
  options: {
    workspaceId: string;
    /** A two-factor code the operator just read off their authenticator. */
    otp?: string;
    now?: Date;
    driver?: RedditDriver;
    /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
    page?: RedditPage;
    log?: (message: string) => void;
  }
): Promise<RedditLoginOutcome> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { status: 'failed', message: redditOffReason(config) };

  let page = options.page ?? null;
  if (!page) {
    const mode = accountBrowserMode(config);
    if (mode.blocked) return { status: 'failed', message: mode.blocked };
    const handle = await openBrowser(config, log, { headless: mode.headless });
    if (!handle) return { status: 'failed', message: BROWSER_OPEN_FAILED_MESSAGE };
    page = handle.page;
  }

  const driver = options.driver ?? playwrightRedditDriver;

  // SESSION REUSE, AND IT IS THE NORMAL PATH. Nothing is decrypted to get here.
  if (await driver.isLoggedIn(page)) {
    const handle = await driver.readHandle(page);
    const account = await stampRedditSessionValid(db, options.workspaceId, now, { username: handle });
    return {
      status: 'ok',
      message: 'That Reddit session is still live, so nothing had to be signed in.',
      username: account.username
    };
  }

  const credentials = await readRedditCredentials(db, options.workspaceId);
  if (!credentials) {
    // Covers hosted, nothing stored, and half stored. One sentence.
    return { status: 'failed', message: 'Save your Reddit username and password here to sign in.' };
  }

  const result = await driver.loginWithCredentials(page, {
    username: credentials.username,
    password: credentials.password,
    otp: options.otp
  });

  if ('needsOtp' in result) {
    return { status: 'otp_required', message: 'Reddit wants your two-factor code; enter it and sign in again.' };
  }
  if (result.ok) {
    const handle = await driver.readHandle(page);
    const account = await stampRedditSessionValid(db, options.workspaceId, now, {
      username: handle,
      // Trevra typed the password, so this row now records that it holds one.
      authMode: 'credentials'
    });
    return {
      status: 'ok',
      message: 'Signed in to Reddit; that session is now stored in the browser profile.',
      username: account.username
    };
  }
  if (result.failureKind === 'challenge') {
    return {
      status: 'challenge',
      message: 'Reddit wants a human check that only a person at a browser window can finish; run `npm run reddit:worker` on a machine with a display, then complete it in that window.'
    };
  }

  // `detail` is written by driver.ts from constants and the page's own URL, so
  // it can be handed to an operator verbatim.
  return { status: 'failed', message: result.detail ?? 'Reddit refused the sign-in.' };
}

/**
 * A signed-in page for one workspace's Reddit account, or the one thing to do
 * about it.
 *
 * THE PREAMBLE EVERY JOB SHARES, lifted out and named: is automation on, can
 * this process open a browser at all, and is there a live session. Hand-copying
 * that into each caller is three chances to get one of them wrong.
 *
 * NEVER THROWS. Every refusal is `{ ok: false }` plus one sentence an operator
 * can act on.
 */
export type RedditSessionResult =
  | { ok: true; page: RedditPage; driver: RedditDriver }
  | { ok: false; blocked: string };

export async function openRedditSession(
  db: Db,
  config: RedditLocalWorkerConfig,
  options: {
    workspaceId: string;
    now?: Date;
    driver?: RedditDriver;
    /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
    page?: RedditPage;
    log?: (message: string) => void;
  }
): Promise<RedditSessionResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();
  const driver = options.driver ?? playwrightRedditDriver;

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { ok: false, blocked: redditOffReason(config) };

  if (options.page) {
    const outcome = await loginRedditAccount(db, config, { ...options, now, driver, page: options.page, log });
    return outcome.status === 'ok' ? { ok: true, page: options.page, driver } : { ok: false, blocked: outcome.message };
  }

  const mode = accountBrowserMode(config);
  if (mode.blocked) {
    reportUnready(log, [mode.blocked]);
    return { ok: false, blocked: mode.blocked };
  }

  const handle = await openBrowser(config, log, { headless: mode.headless });
  if (!handle) return { ok: false, blocked: BROWSER_OPEN_FAILED_MESSAGE };

  const outcome = await loginRedditAccount(db, config, { workspaceId: options.workspaceId, now, driver, page: handle.page, log });
  if (outcome.status !== 'ok') return { ok: false, blocked: outcome.message };

  return { ok: true, page: handle.page, driver };
}

/** Close the shared browser. Called from the worker's drain. */
export async function closeRedditBrowser(): Promise<void> {
  const handle = browser;
  browser = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // A browser we cannot close is not a reason to fail a shutdown.
  }
}

/**
 * Read one subreddit through the signed-in session.
 *
 * The session preamble plus one driver call. Read-only, so there is nothing to
 * pace and nothing to claim: if it fails, the operator presses the button
 * again.
 */
export async function researchSubreddit(
  db: Db,
  config: RedditLocalWorkerConfig,
  options: {
    workspaceId: string;
    subreddit: string;
    read?: RedditReadOptions;
    now?: Date;
    driver?: RedditDriver;
    page?: RedditPage;
    log?: (message: string) => void;
  }
): Promise<{ ok: true; read: RedditResearchRead } | { ok: false; blocked: string }> {
  const session = await openRedditSession(db, config, options);
  if (!session.ok) return session;

  const result = await session.driver.readSubreddit(session.page, options.subreddit, options.read);
  if ('threads' in result) return { ok: true, read: result };
  return { ok: false, blocked: result.detail ?? `Could not read r/${options.subreddit}.` };
}

/**
 * Post one comment the operator wrote, in one thread the operator chose.
 *
 * ONE CALL, ONE COMMENT. Nothing here loops over a listing, and nothing
 * schedules a second call: pacing a comment stream is a queue's job, and there
 * is no queue in this scope. The `unknown` result is passed through verbatim
 * rather than retried, because a duplicate comment cannot be un-posted.
 */
export async function commentOnRedditThread(
  db: Db,
  config: RedditLocalWorkerConfig,
  options: {
    workspaceId: string;
    threadUrl: string;
    body: string;
    now?: Date;
    driver?: RedditDriver;
    page?: RedditPage;
    log?: (message: string) => void;
  }
): Promise<{ ok: true; result: RedditDriverResult } | { ok: false; blocked: string; result?: RedditDriverResult }> {
  const session = await openRedditSession(db, config, options);
  if (!session.ok) return session;

  const result = await session.driver.commentOnThread(session.page, options.threadUrl, options.body);
  if (result.ok) return { ok: true, result };
  return { ok: false, blocked: result.detail ?? 'Reddit refused the reply.', result };
}

/**
 * What this process could do about Reddit, answered WITHOUT opening anything.
 *
 * Feeds the status card. Cheap and non-launching, for the same reason the
 * probes are: a status endpoint that opens Chrome is a status endpoint that
 * hangs.
 */
export interface RedditWorkerStatus {
  enabled: boolean;
  playwrightPath: string | null;
  profileDir: string;
  browser: {
    canLaunchHeaded: boolean;
    canLaunchHeadless: boolean;
    reasons: string[];
    headlessReasons: string[];
  };
  ready: boolean;
  blockers: string[];
}

export function redditWorkerStatus(
  config: RedditLocalWorkerConfig,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): RedditWorkerStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const headed = redditBrowserReadiness(config, { env, platform });
  const headless = redditHeadlessReadiness(config, { env, platform });
  // READY MEANS "SOME BROWSER CAN OPEN HERE", either kind. A container with
  // chromium installed is ready; a laptop with no playwright is not.
  const ready = config.enabled && (headed.canLaunchHeaded || headless.canLaunchHeadless);
  return {
    enabled: config.enabled,
    playwrightPath: playwrightBrowsersPath(env, platform),
    profileDir: resolveRedditProfileDir(config.profileDir),
    browser: {
      canLaunchHeaded: headed.canLaunchHeaded,
      canLaunchHeadless: headless.canLaunchHeadless,
      reasons: headed.reasons,
      headlessReasons: headless.reasons
    },
    ready,
    // Deduplicated: the headed and headless probes report the same missing
    // package, and saying it twice reads as two problems.
    blockers: ready ? [] : Array.from(new Set([...headless.reasons, ...headed.reasons]))
  };
}
