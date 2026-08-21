/**
 * The Reddit worker: the server-side controller for Reddit browser actions and
 * the only caller of the one function that decrypts a Reddit password.
 *
 * Chrome itself is owned by Companion. The server attaches over CDP using a
 * reserved Reddit Companion profile and never launches a local browser.
 *
 * THE PASSWORD'S WHOLE LIFETIME IS ONE `const` IN `loginRedditAccount`. It is
 * decrypted at the moment of use, handed straight to the driver, and never
 * assigned to an outcome, a log line, or anything that outlives that call.
 *
 * Reddit uses a Companion profile distinct from LinkedIn and keeps one server
 * CDP handle per workspace. The legacy profile-path helpers below are retained
 * only to identify/clean old self-hosted profile directories during upgrade;
 * they are not used to launch Chrome.
 *
 * NEVER THROWS. Every refusal is a status plus one sentence, because the
 * callers are worker ticks and HTTP handlers and neither may 500 because Reddit
 * wants a captcha.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { openSeatBrowser, type ProviderDriver } from '../browser/provider.js';
import { redditWorkerConfig } from '../config.js';
import type { Db } from '../db.js';
import { companionBrowserSettings } from '../linkedin/companion.js';
import { deleteRedditCredentials, readRedditCredentials } from '../secrets/reddit.js';
import { deleteRedditAccount, getRedditAccount, stampRedditSessionValid } from './account.js';
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
  /** Deployment-mode metadata retained for API/config compatibility. */
  hosted?: boolean;
}

const DEFAULT_PROFILE_DIR_BASE = '~/.trevra/reddit';

/**
 * The characters a workspace id may keep in a directory name. Whatever an id
 * generator produces, this is a path component the moment it leaves this
 * function -- no `/`, no `..`, nothing a shell or a filesystem reads as
 * anything but literal text.
 */
function pathSafeId(id: string): string {
  const safe = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || 'default';
}

/** `~` expanded here rather than in `config.ts`; see `resolveRedditProfileDir`. */
function expandHome(raw: string): string {
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Legacy profile-directory base retained only for migration/cleanup of old
 * self-hosted installs. Active Reddit sessions live on Companion.
 */
export function redditProfileDirBase(configured?: string | null): string {
  return expandHome(configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR_BASE);
}

/**
 * Legacy Chrome profile directory for ONE WORKSPACE. Active sessions no longer
 * use this path; it is retained to clean up pre-Companion installs safely.
 *
 * ONE DIRECTORY PER WORKSPACE, NEVER ONE FOR THE WHOLE PROCESS. This function
 * used to take no workspace at all, so every tenant on the machine landed in
 * `~/.trevra/reddit-profile`. A persistent user-data-dir IS the Reddit
 * session: its cookies, its device standing, its "remember this browser"
 * record. Sharing one therefore does not mean two accounts sharing a window --
 * it means ONE account in it at a time, and whichever tenant's tick ran last
 * owning it. Both directions of that were live and both crossed the tenant
 * boundary:
 *
 *   - With workspace A's session still good, B's tick took the `isLoggedIn`
 *     early return, stamped `session_valid_at` on B's row carrying A's handle,
 *     and posted B's comment FROM A'S ACCOUNT.
 *   - With A's session expired, B's tick typed B's password into the shared
 *     profile, and A's next tick then spoke as B.
 *
 * Either way the wrong customer's identity published the content and the row
 * recorded the wrong handle. `openBrowser` enforces the other half of the fix
 * (a handle map keyed by workspace rather than one handle per process); this
 * is what makes two workspaces land on two different directories at all.
 * Neither half is sufficient alone: two directories with one cached handle
 * still hands the second tenant the first tenant's open page.
 *
 * ONE DIRECTORY PER WORKSPACE IS ALSO EXACTLY ENOUGH. `reddit_accounts`
 * (migration 041) is keyed by `workspace_id` alone and holds a single
 * `username`, so a workspace has exactly one Reddit identity -- there is no
 * second axis here to key on the way LinkedIn has to key on its seat. If a
 * workspace is ever allowed a second account, that key belongs in this path
 * AND in the `browsers` map key, and neither may be changed without the other.
 *
 * EXISTING INSTALLS SIGN IN ONE MORE TIME, and that is the price of the fix,
 * paid deliberately. The old path had no workspace segment at all, so there is
 * no suffix that preserves it for everybody; preserving it for one workspace
 * would just be choosing which tenant keeps the shared session, which is the
 * defect wearing a migration's clothes. The first tick after this change finds
 * an empty directory, reports the session as gone, and signs in again from the
 * vault -- or, on a `manual` account, asks the operator to.
 *
 * `configured` (`TREVRA_REDDIT_PROFILE_DIR`) remains a legacy cleanup base and
 * is still suffixed per workspace so old tenant-isolated directories can be
 * removed without reintroducing a shared path.
 */
export function resolveRedditProfileDir(
  configured: string | null | undefined,
  workspaceId: string
): string {
  const base = configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR_BASE;
  return expandHome(`${base}-${pathSafeId(workspaceId)}-profile`);
}

/** Why Reddit automation is off, in one sentence. */
export function redditOffReason(_config: Pick<RedditLocalWorkerConfig, 'hosted'>): string {
  return 'Reddit browser automation needs a paired Companion device; server-local Chrome launches are disabled.';
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
 * Compatibility probe for the retired server-local browser mode. It remains
 * deliberately false even when Chromium happens to exist on this machine,
 * because active Reddit browser execution attaches to Companion instead.
 */
export function redditBrowserReadiness(
  config: RedditLocalWorkerConfig,
  _options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): RedditBrowserReadiness {
  return {
    canLaunchHeaded: false,
    reasons: [redditOffReason(config)]
  };
}

/** Same ownership rule for headless execution: Docker never becomes the fallback. */
export function redditHeadlessReadiness(
  config: RedditLocalWorkerConfig,
  _options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): RedditHeadlessReadiness {
  return {
    canLaunchHeadless: false,
    reasons: [redditOffReason(config)]
  };
}

interface BrowserHandle {
  page: RedditPage;
  /** Retained for API compatibility while browser ownership moves to Companion. */
  headless: boolean;
  close(): Promise<void>;
}
/**
 * One open Companion CDP handle per WORKSPACE, never one for the whole process.
 *
 * A single shared `browser` here was the other half of the tenant-crossing bug
 * `resolveRedditProfileDir` describes, and the half that survives fixing the
 * directories: even with two workspaces on two different profile directories,
 * a lone module-scope handle would still answer the second workspace's call
 * with the first workspace's already-open page -- same session, same cookies,
 * wrong account, and a comment published under a customer who never wrote it.
 * Keyed by workspace, exactly as the profile directory now is.
 *
 * THE KEY IS THE WORKSPACE ID ALONE because `reddit_accounts` is keyed by
 * workspace id alone (migration 041). It is a bare id and not a composed
 * string on purpose: a second axis added later must be added HERE and in
 * `resolveRedditProfileDir` together, and a composed key would let one of
 * those two edits look complete on its own.
 *
 * lc-debt: entries live until `closeRedditBrowser` is called, so a long-lived
 * API process retains one remote handle per workspace it has served; an
 * idle-eviction sweep over this map is the upgrade path if that count grows.
 */
const browsers = new Map<string, BrowserHandle>();

/**
 * The last "this process cannot drive a browser" line said FOR EACH WORKSPACE.
 *
 * PER WORKSPACE, NOT PER PROCESS, even though the reasons themselves are
 * facts about the process. A single flag meant the first workspace's failure
 * silenced the identical message for every workspace behind it, so an operator
 * whose worker loops over five tenants saw one line and reasonably concluded
 * one tenant had been skipped. Bounded by the number of workspaces this
 * process has served, which is the same bound `browsers` has.
 */
const unreadyLogged = new Map<string, string>();

/**
 * Say once per workspace, per distinct set of reasons, that this process
 * cannot drive a browser for it. This runs on a per-tick loop, and a repeated
 * line is a line nobody reads.
 */
function reportUnready(
  workspaceId: string,
  log: (message: string) => void,
  reasons: string[]
): void {
  const summary = reasons.join(' ');
  if (unreadyLogged.get(workspaceId) === summary) return;
  unreadyLogged.set(workspaceId, summary);
  log(`Reddit browser worker is unavailable for ${workspaceId}: ${summary}`);
}

/**
 * Attach to this workspace's persistent Reddit profile on Companion over CDP.
 *
 * The server never launches Chrome. The `headless` bit is retained in the
 * handle/request shape for compatibility, but Companion owns the actual browser
 * process and visibility.
 *
 * A DIFFERENT WORKSPACE NEVER REUSES. The lookup is keyed by workspace before
 * the mode is even considered, so there is no path -- not a mode match, not a
 * warm handle, not a fast tick -- by which one tenant's call is answered with
 * another tenant's page. `workspaceId` is required rather than defaulted for
 * the same reason `resolveRedditProfileDir` requires one: a default here would
 * be a shared browser reintroduced by omission.
 */
const REDDIT_COMPANION_PROFILE_KEY = '__reddit__';
const REDDIT_DRIVER_SPECIFIERS: readonly string[] = ['patchright', 'playwright'];

async function loadRedditBrowserDriver(
  log: (message: string) => void
): Promise<ProviderDriver | null> {
  for (const specifier of REDDIT_DRIVER_SPECIFIERS) {
    try {
      return (await import(specifier)) as unknown as ProviderDriver;
    } catch {
      // Either package may provide the CDP client; try the next one.
    }
  }
  log(
    'Reddit browser automation cannot attach to Companion because neither patchright nor playwright is installed in the server image.'
  );
  return null;
}

async function openBrowser(
  _config: RedditLocalWorkerConfig,
  log: (message: string) => void,
  options: {
    workspaceId: string;
    headless?: boolean;
    env?: NodeJS.ProcessEnv;
    playwright?: ProviderDriver;
  }
): Promise<BrowserHandle | null> {
  const headless = options.headless ?? false;
  const existing = browsers.get(options.workspaceId);
  if (existing && existing.headless === headless) return existing;
  if (existing) await closeRedditBrowser(options.workspaceId);

  const env = options.env ?? process.env;
  const settings = companionBrowserSettings(env);
  if (!settings) {
    log(
      `Reddit browser execution is unavailable for ${options.workspaceId}: pair a Companion device. Server-local Chrome launches are disabled.`
    );
    return null;
  }
  const playwright = options.playwright ?? (await loadRedditBrowserDriver(log));
  if (!playwright) return null;

  const opened = await openSeatBrowser(
    playwright,
    settings,
    {
      workspaceId: options.workspaceId,
      seatKey: REDDIT_COMPANION_PROFILE_KEY,
      headless,
      profileDir: '',
      fingerprint: {
        userAgent: '',
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: 1365, height: 768 }
      },
      proxy: null,
      storageState: null,
      args: [],
      ignoreDefaultArgs: [],
      channels: []
    },
    log
  );
  if ('refused' in opened) {
    log(`Reddit Companion browser could not attach for ${options.workspaceId}: ${opened.refused}`);
    return null;
  }

  const handle: BrowserHandle = {
    page: opened.session.page as RedditPage,
    headless,
    close: opened.session.close
  };
  browsers.set(options.workspaceId, handle);
  return handle;
}

/** Reddit handles are unique case-insensitively, so `u/Pankaj` and `u/pankaj` are one account. */
function sameHandle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

type RedditIdentityCheck = { ok: true } | { ok: false; blocked: string };

/**
 * Is the session in front of us the one this workspace is entitled to speak
 * through?
 *
 * `isLoggedIn` PROVES A SESSION EXISTS AND NOTHING ELSE. It answers "somebody
 * is signed in here", never "the right somebody", and stamping
 * `session_valid_at` on the strength of the first alone is exactly how one
 * workspace's row came to record another workspace's handle -- and then post
 * under it. The stamp's whole purpose is to say a session was CONFIRMED, so
 * confirming it has to include confirming whose it is.
 *
 * REFUSE RATHER THAN GUESS, in both failing shapes:
 *
 *   MISMATCH  the profile is signed in as somebody who is not this workspace's
 *             account. Nothing here can fix that by reopening -- the session
 *             lives in that directory, so the same directory yields the same
 *             wrong account -- so the browser is closed and a human is told
 *             which two handles are involved. Both are public (see account.ts).
 *   UNREADABLE we could not read the handle at all. That is UNKNOWN, not a
 *             mismatch, and it is still not proof; a comment must not go out
 *             under an identity nobody could confirm, so it refuses with its
 *             own sentence rather than borrowing the mismatch one.
 *
 * NO EXPECTED HANDLE IS NOT A FAILURE. A workspace that has never confirmed a
 * session has nothing to contradict, and the directory it is looking at is
 * one only that workspace has ever opened, so whatever handle it reports is
 * adopted as this workspace's account. That is the first-run path for both
 * `manual` (a human signed the window in) and `credentials`.
 */
function confirmSessionIdentity(expected: string | null, live: string | null): RedditIdentityCheck {
  if (!expected) return { ok: true };
  if (!live) {
    return {
      ok: false,
      blocked: `Could not read which account that Reddit browser profile is signed in as, so nothing was done through it; run \`npm run reddit:worker\` on a machine with a display and check the window is still u/${expected}.`
    };
  }
  if (!sameHandle(expected, live)) {
    return {
      ok: false,
      blocked: `That Reddit browser profile is signed in as u/${live}, but this workspace's account is u/${expected}; sign that window out, or reconnect the account here, before anything is posted.`
    };
  }
  return { ok: true };
}

/**
 * Which browser mode this process should use, or the one thing to do about it.
 *
 * HEADED WINS WHEN IT IS AVAILABLE, always. A window the operator can see is
 * strictly better than one they cannot: they can watch it, close it, and clear
 * a captcha in it. Headless is what is left when there is no display.
 */
function accountBrowserMode(config: RedditLocalWorkerConfig): {
  headless: boolean;
  blocked: string | null;
} {
  const headed = redditBrowserReadiness(config);
  if (headed.canLaunchHeaded) return { headless: false, blocked: null };
  const headless = redditHeadlessReadiness(config);
  if (headless.canLaunchHeadless) return { headless: true, blocked: null };
  // Neither. The headed reasons are the fuller set and already carry the
  // container line that explains the rest.
  return {
    headless: false,
    blocked: headed.reasons[headed.reasons.length - 1] ?? redditOffReason(config)
  };
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
  'Could not attach to a Reddit Companion browser session; server-local Chrome launches are disabled.';

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
    env?: NodeJS.ProcessEnv;
    playwright?: ProviderDriver;
  }
): Promise<RedditLoginOutcome> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { status: 'failed', message: redditOffReason(config) };

  let page = options.page ?? null;
  if (!page) {
    const handle = await openBrowser(config, log, {
      workspaceId: options.workspaceId,
      headless: true,
      env: options.env,
      playwright: options.playwright
    });
    if (!handle) return { status: 'failed', message: BROWSER_OPEN_FAILED_MESSAGE };
    page = handle.page;
  }

  const driver = options.driver ?? playwrightRedditDriver;

  // SESSION REUSE, AND IT IS THE NORMAL PATH. Nothing is decrypted to get here.
  if (await driver.isLoggedIn(page)) {
    const handle = await driver.readHandle(page);
    // WHOSE session it is, asked before it is used for anything. Reading the
    // expected handle costs one indexed row and opens no secret, so the reuse
    // path stays the path that never decrypts.
    const expected = (await getRedditAccount(db, options.workspaceId))?.username ?? null;
    const identity = confirmSessionIdentity(expected, handle);
    if (!identity.ok) {
      // CLOSED, NOT HANDED ON. A page signed in as somebody else is not a page
      // to leave warm in the map for the next caller to be given, and holding
      // its profile directory open blocks the operator from fixing it in a
      // window of their own.
      await closeRedditBrowser(options.workspaceId);
      return { status: 'failed', message: identity.blocked };
    }
    const account = await stampRedditSessionValid(db, options.workspaceId, now, {
      username: handle
    });
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
    return {
      status: 'otp_required',
      message: 'Reddit wants your two-factor code; enter it and sign in again.'
    };
  }
  if (result.ok) {
    const handle = await driver.readHandle(page);
    // THE STRONGEST FORM OF THE SAME CHECK, and it is free: this call typed
    // `credentials.username` a moment ago, so the session it just opened is
    // that account or the sign-in did not do what it reported. Compared against
    // what was typed rather than against the stored row, because on a first
    // sign-in there is no stored row yet and this is the fact that creates it.
    const identity = confirmSessionIdentity(credentials.username, handle);
    if (!identity.ok) {
      await closeRedditBrowser(options.workspaceId);
      return { status: 'failed', message: identity.blocked };
    }
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
      message:
        'Reddit wants a human check that only a person at a browser window can finish; run `npm run reddit:worker` on a machine with a display, then complete it in that window.'
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
  { ok: true; page: RedditPage; driver: RedditDriver } | { ok: false; blocked: string };

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
    env?: NodeJS.ProcessEnv;
    playwright?: ProviderDriver;
  }
): Promise<RedditSessionResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();
  const driver = options.driver ?? playwrightRedditDriver;

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { ok: false, blocked: redditOffReason(config) };

  if (options.page) {
    const outcome = await loginRedditAccount(db, config, {
      ...options,
      now,
      driver,
      page: options.page,
      log,
      env: options.env,
      playwright: options.playwright
    });
    return outcome.status === 'ok'
      ? { ok: true, page: options.page, driver }
      : { ok: false, blocked: outcome.message };
  }

  const handle = await openBrowser(config, log, {
    workspaceId: options.workspaceId,
    headless: true,
    env: options.env,
    playwright: options.playwright
  });
  if (!handle) return { ok: false, blocked: BROWSER_OPEN_FAILED_MESSAGE };

  const outcome = await loginRedditAccount(db, config, {
    workspaceId: options.workspaceId,
    now,
    driver,
    page: handle.page,
    log
  });
  if (outcome.status !== 'ok') return { ok: false, blocked: outcome.message };

  return { ok: true, page: handle.page, driver };
}

/**
 * Close ONE workspace's browser, or -- called with no argument, from the
 * worker's drain -- every one this process opened.
 *
 * Two scopes because two callers need two different things: a shutdown closes
 * everything (a browser left open holds its profile directory locked and the
 * next worker cannot attach to it), while a single workspace being reopened in
 * a different mode, or refused for signing in as the wrong account, closes
 * only itself and leaves every other tenant's session running.
 */
export async function closeRedditBrowser(workspaceId?: string): Promise<void> {
  const handles: BrowserHandle[] = [];
  if (workspaceId) {
    const handle = browsers.get(workspaceId);
    browsers.delete(workspaceId);
    if (handle) handles.push(handle);
  } else {
    handles.push(...browsers.values());
    browsers.clear();
  }
  await Promise.all(
    handles.map(async (handle) => {
      try {
        await handle.close();
      } catch {
        // A browser we cannot close is not a reason to fail a shutdown.
      }
    })
  );
}

/** What a disconnect actually removed. Every field is an observation, not an intention. */
export interface RedditDisconnectResult {
  /** A browser this process had open for the workspace, if there was one. */
  browserClosed: boolean;
  /** The Chrome profile directory -- the cookies, which ARE the session. */
  profileRemoved: boolean;
  /** The absolute directory that was removed, or that was already absent. */
  profileDir: string;
  /** The sealed username/password pair, if there was one. */
  credentialsRemoved: boolean;
  /** The `reddit_accounts` row: the handle and the session-validity stamp. */
  accountRemoved: boolean;
  /**
   * Empty exactly when the disconnect is COMPLETE. One sentence each, and a
   * caller that receives a non-empty list must show it rather than report
   * success -- a revocation that silently half-happened is precisely the
   * failure this function exists to end.
   */
  problems: string[];
}

/**
 * Make a disconnect TRUE: after this, this workspace's Reddit account cannot
 * act, and nothing in this process can be persuaded otherwise.
 *
 * WHAT WAS BROKEN, AND WHY DELETING ROWS WAS NOT ENOUGH. Disconnecting used to
 * wipe the two sealed credential rows and stop there. That does not sign
 * anything out, because the session is NOT in the database -- it is the cookie
 * jar inside the Chrome profile directory. So the row said "no credentials",
 * the screen said disconnected, and `loginRedditAccount` still took its reuse
 * branch (`isLoggedIn` true, nothing decrypted, nothing needed), so
 * `commentOnRedditThread` still published from an account the customer
 * believed was gone. On a hosted platform that is the customer's own Reddit
 * identity posting after they revoked it, which is not a bug about tidiness.
 *
 * THE PROFILE DIRECTORY IS DELETED RATHER THAN SIGNED OUT. Clicking log-out
 * needs a browser, a network, and Reddit to cooperate; each is a way for a
 * revocation to quietly not happen, and the operator would be told it did.
 * Removing the directory needs none of them and cannot half-succeed in a way
 * that leaves a usable cookie: the session is the files, so no files is no
 * session. It is also what makes the next sign-in a real one.
 *
 * THE ORDER IS THE SAFETY ARGUMENT. The browser is closed first (a running
 * Chrome holds the directory open and rewrites its cookie jar on exit, so
 * deleting underneath it would restore what was just removed), then the
 * directory, then the credentials, then the row. Every step therefore destroys
 * the ABILITY TO ACT before it destroys the RECORD of it: if this fails
 * halfway, what is left behind is bookkeeping, never a live session.
 *
 * NOTHING HERE IS GATED ON `config.enabled`. Every other function in this file
 * refuses when Reddit automation is switched off; this one must not. "We will
 * not revoke your account because automation is disabled" is an answer with no
 * defensible reading, and switching automation off is one of the moments a
 * revocation is most likely to be asked for.
 *
 * IDEMPOTENT. Every field comes back false on a second call, with no problems:
 * a disconnect that errors because it already happened would have operators
 * clicking it twice to find out whether it worked.
 *
 * NEVER THROWS, like everything else here -- the caller is an HTTP handler.
 * A failure is a sentence in `problems`, and `problems` is the field that says
 * whether the customer may be told the account is gone.
 */
export async function disconnectRedditWorkspace(
  db: Db,
  workspaceId: string,
  options: {
    /** Defaults to this process's own; passed in by a route that already resolved it. */
    config?: RedditLocalWorkerConfig;
    /** Recorded on the credential wipe's audit row. */
    actorUserId?: string | null;
  } = {}
): Promise<RedditDisconnectResult> {
  const config = options.config ?? redditWorkerConfig();
  const profileDir = resolveRedditProfileDir(config.profileDir, workspaceId);
  const problems: string[] = [];

  // 1. THE BROWSER, BEFORE ANYTHING ON DISK.
  const browserClosed = browsers.has(workspaceId);
  await closeRedditBrowser(workspaceId);
  // This workspace has no further ticks to be quiet about.
  unreadyLogged.delete(workspaceId);

  // 2. THE COOKIES.
  let profileRemoved = false;
  if (!profileDir.endsWith('-profile')) {
    // Unreachable through `resolveRedditProfileDir`, which always appends that
    // suffix -- which is exactly why it is asserted here. This is a recursive
    // delete of a path built partly from an operator's environment variable,
    // and the invariant that makes that safe (the target is always a named
    // child, never the configured base and never a filesystem root) is worth
    // one branch rather than one comment.
    problems.push(
      'Refused to remove that Reddit profile directory because it is not one this worker builds.'
    );
  } else {
    try {
      profileRemoved = existsSync(profileDir);
      await rm(profileDir, { recursive: true, force: true });
      if (existsSync(profileDir)) {
        profileRemoved = false;
        problems.push(
          `Could not remove the Reddit browser profile at ${profileDir}; that session is still signed in until it is deleted by hand.`
        );
      }
    } catch (cause) {
      profileRemoved = false;
      problems.push(
        `Could not remove the Reddit browser profile at ${profileDir}: ${cause instanceof Error ? cause.message : String(cause)}.`
      );
    }
  }

  // 3. THE PASSWORD. Left behind, it is not a leftover -- it is a sign-in: the
  // next tick would find the profile gone, open the vault, and reconnect the
  // account the customer just disconnected.
  let credentialsRemoved = false;
  try {
    credentialsRemoved = await deleteRedditCredentials(
      db,
      workspaceId,
      options.actorUserId ?? null
    );
  } catch (cause) {
    problems.push(
      `Could not remove the stored Reddit sign-in: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }

  // 4. THE ROW: the handle and the session-validity stamp, which now describe
  // an account this workspace no longer has.
  let accountRemoved = false;
  try {
    accountRemoved = await deleteRedditAccount(db, workspaceId);
  } catch (cause) {
    problems.push(
      `Could not remove the Reddit account record: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }

  return {
    browserClosed,
    profileRemoved,
    profileDir,
    credentialsRemoved,
    accountRemoved,
    problems
  };
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
): Promise<
  | { ok: true; result: RedditDriverResult }
  | { ok: false; blocked: string; result?: RedditDriverResult }
> {
  const session = await openRedditSession(db, config, options);
  if (!session.ok) return session;

  const result = await session.driver.commentOnThread(
    session.page,
    options.threadUrl,
    options.body
  );
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
  /**
   * The asking workspace's own profile directory, or -- when the caller named
   * no workspace -- the base every workspace's directory hangs off. There is
   * deliberately no single answer that covers both: one directory for the
   * whole process is the defect this module was fixed for, so a status card
   * that showed one would be showing something that no longer exists.
   */
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
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; workspaceId?: string } = {}
): RedditWorkerStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const headed = redditBrowserReadiness(config, { env, platform });
  const headless = redditHeadlessReadiness(config, { env, platform });
  // READY means this deployment is configured to attach to a Companion browser;
  // no local Chromium installation is part of readiness anymore.
  const ready = config.enabled;
  return {
    enabled: config.enabled,
    playwrightPath: null,
    profileDir: options.workspaceId
      ? resolveRedditProfileDir(config.profileDir, options.workspaceId)
      : redditProfileDirBase(config.profileDir),
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
