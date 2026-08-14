import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../db.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { describeRedditCredentials, putRedditCredentials } from '../secrets/reddit.js';
import { getRedditAccount } from './account.js';
import type { RedditDriver, RedditPage } from './driver.js';
import {
  closeRedditBrowser,
  commentOnRedditThread,
  disconnectRedditWorkspace,
  loginRedditAccount,
  openRedditSession,
  redditProfileDirBase,
  redditWorkerStatus,
  resolveRedditProfileDir
} from './local-worker.js';

/**
 * ONE TENANT'S REDDIT SESSION MUST NEVER SERVE ANOTHER TENANT.
 *
 * WHAT WAS BROKEN. This module used to hold one process-global Chrome profile
 * (`~/.trevra/reddit-profile`) and one process-global browser handle, and the
 * worker looped every workspace through both. That is two separate ways for a
 * comment to go out under the wrong customer's name, and both were live:
 *
 *   - Workspace A's session still good: B's tick found `isLoggedIn` true, took
 *     the reuse branch, stamped `session_valid_at` on B's row carrying A's
 *     handle, and posted B's words from A's account.
 *   - Workspace A's session expired: B's tick typed B's password into the one
 *     shared profile, and A's next tick then spoke as B.
 *
 * WHY THE BROWSER IS FAKED AND THE PROFILE DIRECTORY IS NOT. The bug is not in
 * Playwright, it is in which DIRECTORY gets opened and which HANDLE gets
 * handed back, so `openPersistentBrowser` is stubbed and everything above it --
 * `resolveRedditProfileDir`, the handle map, the identity check, the stamp,
 * the disconnect -- is the real code. The stub models the one property that
 * made this a security bug rather than an inconvenience: A PERSISTENT
 * USER-DATA-DIR IS THE SESSION. So the session here is a REAL FILE in a real
 * directory under `os.tmpdir()`: signing in writes `<profile>/Cookies`,
 * `isLoggedIn` is that file existing, and the handle is its contents. Nothing
 * is held in a variable the code under test cannot reach, which is what lets
 * `disconnectRedditWorkspace`'s recursive delete be observed for what it is
 * rather than mocked away.
 *
 * The fake page carries nothing but the directory it came from, so the only
 * identity a test can read is the one that profile holds.
 *
 * A WORKER PASS IS `loginRedditAccount` PER WORKSPACE IN ORDER, which is
 * literally what `src/cli/trevra-reddit-worker.ts` does, and no `page` is
 * injected: these tests go through the real `openBrowser`.
 *
 * Postgres-backed on purpose. What is being asserted is which handle lands in
 * WHICH WORKSPACE'S ROW, and a fake store would assert nothing about that.
 */

const WS_A = 'ws_reddit_tenancy_a';
const WS_B = 'ws_reddit_tenancy_b';
const NOW = new Date('2026-08-14T10:00:00.000Z');
const LATER = new Date('2026-08-14T11:00:00.000Z');

const HANDLE_A = 'tenant_alpha';
const HANDLE_B = 'tenant_beta';
const PASSWORD_A = 'alpha-Pa55word-never-echo-me';
const PASSWORD_B = 'beta-Pa55word-never-echo-me';

/** Absolute, so nothing here depends on the process's working directory. */
const PROFILE_BASE = join(tmpdir(), 'trevra-reddit-tenancy-test');

/**
 * The machine, faked at the one seam that touches it.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above every import and
 * may not close over ordinary module-scope bindings.
 */
const stubbedBrowser = vi.hoisted(() => ({
  /** What `browserBlockers` answers. Empty means this process can open a browser. */
  blockers: [] as string[],
  /** Every launch, in order, with the directory it was pointed at. */
  opened: [] as Array<{ profileDir: string; headless: boolean }>,
  /** Every context close, by directory. */
  closed: [] as string[]
}));

vi.mock('../browser/local.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/local.js')>();
  const { mkdirSync } = await import('node:fs');
  return {
    ...actual,
    browserBlockers: () => [...stubbedBrowser.blockers],
    // Null means "a window can open here", so the readiness probe picks headed
    // and the test never depends on whether this machine has a display.
    displayBlocker: () => null,
    openPersistentBrowser: async (profileDir: string, options: { headless: boolean }) => {
      stubbedBrowser.opened.push({ profileDir, headless: options.headless });
      // A real launch CREATES the user-data-dir and does not put a session in
      // it. Modelled, because it is the difference between "a browser opened
      // here" and "somebody is signed in here" -- and after a disconnect the
      // first must not be mistaken for the second.
      mkdirSync(profileDir, { recursive: true });
      return {
        context: {
          pages: () => [],
          newPage: async () => ({}),
          close: async () => {
            stubbedBrowser.closed.push(profileDir);
          }
        },
        // The page IS its directory, and carries nothing else: any identity a
        // test can read off it had to come from the profile it was opened on.
        page: { profileDir }
      };
    }
  };
});

const config = { enabled: true, hosted: false, profileDir: PROFILE_BASE };

function profileOf(page: RedditPage): string {
  return (page as unknown as { profileDir: string }).profileDir;
}

function dirFor(workspaceId: string): string {
  return resolveRedditProfileDir(PROFILE_BASE, workspaceId);
}

/** The cookie jar. Its existence is the session; its contents are the account. */
function cookieJar(profileDir: string): string {
  return join(profileDir, 'Cookies');
}

/** Who is signed into that profile directory, read the way the browser would. */
function sessionIn(profileDir: string): string | null {
  const jar = cookieJar(profileDir);
  return existsSync(jar) ? readFileSync(jar, 'utf8') : null;
}

/** Sign an account into a profile directory. REPLACES whoever was there. */
async function signIntoProfile(profileDir: string, handle: string): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  await writeFile(cookieJar(profileDir), handle);
}

/**
 * A driver that answers from the profile directory it is standing in, exactly
 * as a real browser does.
 */
function sessionDriver(overrides: Partial<RedditDriver> = {}) {
  const typed: Array<{ profileDir: string; username: string }> = [];
  const driver: RedditDriver = {
    isLoggedIn: async (page) => sessionIn(profileOf(page)) !== null,
    readHandle: async (page) => sessionIn(profileOf(page)),
    loginWithCredentials: async (page, credentials) => {
      typed.push({ profileDir: profileOf(page), username: credentials.username });
      // One user-data-dir holds one signed-in account, so signing in evicts
      // whoever was there -- which is how the second direction of the bug
      // logged the first tenant out and then acted as them.
      await signIntoProfile(profileOf(page), credentials.username);
      return { ok: true };
    },
    readSubreddit: async () => {
      throw new Error('readSubreddit must not be reached by a tenancy test');
    },
    commentOnThread: async () => {
      throw new Error('commentOnThread must not be reached by a tenancy test');
    },
    ...overrides
  };
  return { driver, typed };
}

/** One worker pass: every workspace in order, through the real browser plumbing. */
async function workerPass(
  workspaceIds: string[],
  driver: RedditDriver,
  options: { now?: Date; log?: (message: string) => void } = {}
) {
  const outcomes = [];
  for (const workspaceId of workspaceIds) {
    outcomes.push(
      await loginRedditAccount(db, config, {
        workspaceId,
        now: options.now ?? NOW,
        driver,
        log: options.log ?? (() => {})
      })
    );
  }
  return outcomes;
}

let db: Db;
let previousKey: string | undefined;

async function seedWorkspace(workspaceId: string): Promise<void> {
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(workspaceId, 'Reddit tenancy test', NOW.toISOString());
  await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(`usr_${workspaceId}`, workspaceId, `usr_${workspaceId}@trevra.test`, 'Tenancy test', NOW.toISOString());
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  // A leaked `hosted` from another file would refuse every credential read and
  // turn these into failures about the deployment mode.
  delete process.env.TREVRA_DEPLOYMENT_MODE;

  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WS_A, WS_B]) {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM reddit_accounts WHERE workspace_id=?').run(workspaceId);
    await seedWorkspace(workspaceId);
  }

  stubbedBrowser.blockers = [];
  stubbedBrowser.opened.length = 0;
  stubbedBrowser.closed.length = 0;
  for (const workspaceId of [WS_A, WS_B]) await rm(dirFor(workspaceId), { recursive: true, force: true });
});

afterEach(async () => {
  // The handle map is module state by design (a browser outlives a request), so
  // a test that left one open would lend it to the next test -- the same shape
  // as the bug under test.
  await closeRedditBrowser();
  for (const workspaceId of [WS_A, WS_B]) await rm(dirFor(workspaceId), { recursive: true, force: true });
  await db?.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

describe('the profile directory', () => {
  it('is per workspace, and a workspace id cannot climb out of the base', () => {
    expect(dirFor(WS_A)).not.toBe(dirFor(WS_B));
    expect(dirFor(WS_A)).toBe(`${PROFILE_BASE}-${WS_A}-profile`);
    // Whatever an id generator produces is a path COMPONENT by the time it
    // leaves that function: no separator, no `..`, nothing a filesystem reads
    // as anything but literal text.
    expect(resolveRedditProfileDir(PROFILE_BASE, '../../etc')).toBe(`${PROFILE_BASE}-______etc-profile`);
    // The base is not a profile directory and is not offered as one.
    expect(redditProfileDirBase(PROFILE_BASE)).toBe(PROFILE_BASE);
    expect(redditWorkerStatus(config, { workspaceId: WS_B }).profileDir).toBe(dirFor(WS_B));
  });
});

describe('one worker pass over two workspaces', () => {
  it('does NOT let the second workspace inherit the first workspace\'s live session', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await putRedditCredentials(db, { workspaceId: WS_B, username: HANDLE_B, password: PASSWORD_B });

    const { driver, typed } = sessionDriver();
    const outcomes = await workerPass([WS_A, WS_B], driver);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok']);
    // The assertion the old code failed: B's answer is B, not A.
    expect(outcomes.map((outcome) => outcome.username)).toEqual([HANDLE_A, HANDLE_B]);

    // Two directories were opened, never one.
    expect(new Set(stubbedBrowser.opened.map((open) => open.profileDir)).size).toBe(2);

    // Each workspace signed ITS OWN account into ITS OWN directory. Under the
    // shared profile B never signed in at all -- it took A's session.
    expect(typed).toEqual([
      { profileDir: dirFor(WS_A), username: HANDLE_A },
      { profileDir: dirFor(WS_B), username: HANDLE_B }
    ]);

    // And the rows record the account that actually spoke.
    expect((await getRedditAccount(db, WS_A))?.username).toBe(HANDLE_A);
    expect((await getRedditAccount(db, WS_B))?.username).toBe(HANDLE_B);

    // A's session survived B's pass. Under one shared directory, B's sign-in
    // evicted it and A's next tick would have spoken as B.
    expect(sessionIn(dirFor(WS_A))).toBe(HANDLE_A);
    expect(sessionIn(dirFor(WS_B))).toBe(HANDLE_B);
  });

  it('refuses the second workspace outright rather than lending it a session it never established', async () => {
    // Only A can sign in. B has nothing stored, so there is exactly one correct
    // answer for B and it is a refusal -- the old code answered `ok` and handed
    // B a signed-in page belonging to A.
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });

    const { driver } = sessionDriver();
    const [alpha, beta] = await workerPass([WS_A, WS_B], driver);

    expect(alpha.status).toBe('ok');
    expect(alpha.username).toBe(HANDLE_A);

    expect(beta.status).toBe('failed');
    expect(beta.message).toBe('Save your Reddit username and password here to sign in.');
    // Nothing was stamped, so nothing recorded A's handle against B.
    expect(await getRedditAccount(db, WS_B)).toBeNull();
  });

  it('keeps each workspace\'s warm browser to itself across ticks', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await putRedditCredentials(db, { workspaceId: WS_B, username: HANDLE_B, password: PASSWORD_B });

    const { driver, typed } = sessionDriver();
    await workerPass([WS_A, WS_B], driver);
    expect(stubbedBrowser.opened).toHaveLength(2);

    const second = await workerPass([WS_A, WS_B], driver);

    // Nothing reopened: each workspace found ITS OWN handle warm. A single
    // process-global handle would also have opened nothing here -- and would
    // have answered both calls with the same page.
    expect(stubbedBrowser.opened).toHaveLength(2);
    expect(second.map((outcome) => outcome.status)).toEqual(['ok', 'ok']);
    expect(second.map((outcome) => outcome.username)).toEqual([HANDLE_A, HANDLE_B]);
    // Reuse decrypts nothing: still one sign-in each, from the first pass.
    expect(typed).toHaveLength(2);
  });
});

describe('the session-validity stamp', () => {
  it('refuses, and closes the window, when the profile is signed in as somebody else', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    const { driver } = sessionDriver();
    await workerPass([WS_A], driver);
    const stamped = (await getRedditAccount(db, WS_A))?.sessionValidAt;
    expect(stamped).toBe(NOW.toISOString());

    // Somebody signs that window into a different account -- by hand, or
    // because a profile directory was restored from somewhere else.
    await signIntoProfile(dirFor(WS_A), 'someone_else');

    const [outcome] = await workerPass([WS_A], driver, { now: LATER });

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('signed in as u/someone_else');
    expect(outcome.message).toContain(`account is u/${HANDLE_A}`);

    // `isLoggedIn` was true, and that is still not a confirmation: the stamp
    // did not move and the handle was not overwritten.
    const account = await getRedditAccount(db, WS_A);
    expect(account?.sessionValidAt).toBe(stamped);
    expect(account?.username).toBe(HANDLE_A);

    // The wrong session is not left warm in the map for the next caller.
    expect(stubbedBrowser.closed).toContain(dirFor(WS_A));
  });

  it('refuses rather than guess when it cannot read who is signed in', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await workerPass([WS_A], sessionDriver().driver);

    // A live session whose handle will not read. That is UNKNOWN, not proof --
    // and a comment must not go out under an identity nobody could confirm.
    const blind = sessionDriver({ readHandle: async () => null });
    const [outcome] = await workerPass([WS_A], blind.driver, { now: LATER });

    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('Could not read which account');
    expect((await getRedditAccount(db, WS_A))?.sessionValidAt).toBe(NOW.toISOString());
  });

  it('adopts the handle on a first run, because that directory is this workspace\'s alone', async () => {
    // No row yet, and nothing to contradict. The directory has never been
    // opened by anybody else, so whatever it reports is this workspace's.
    await signIntoProfile(dirFor(WS_A), HANDLE_A);
    const { driver, typed } = sessionDriver();

    const [outcome] = await workerPass([WS_A], driver);

    expect(outcome.status).toBe('ok');
    expect(typed).toHaveLength(0);
    const account = await getRedditAccount(db, WS_A);
    expect(account?.username).toBe(HANDLE_A);
    expect(account?.sessionValidAt).toBe(NOW.toISOString());
    // Nothing typed a password, so nothing may claim this workspace holds one.
    expect(account?.authMode).toBe('manual');
  });
});

describe('disconnectRedditWorkspace', () => {
  /**
   * `config` IS PASSED EXPLICITLY IN EVERY CALL HERE, and must be. Omitting it
   * makes the function resolve this process's real environment, and the thing
   * it then deletes is the operator's own `~/.trevra/reddit-*-profile`.
   */
  it('leaves nothing the reuse branch can find, so the account cannot post afterwards', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    const { driver } = sessionDriver();
    await workerPass([WS_A], driver);
    expect(sessionIn(dirFor(WS_A))).toBe(HANDLE_A);

    const removed = await disconnectRedditWorkspace(db, WS_A, { config });

    expect(removed).toEqual({
      browserClosed: true,
      profileRemoved: true,
      profileDir: dirFor(WS_A),
      credentialsRemoved: true,
      accountRemoved: true,
      problems: []
    });
    // The cookies are gone, not merely unreferenced. Wiping the two secret rows
    // -- which is all a disconnect used to do -- left this directory untouched.
    expect(existsSync(dirFor(WS_A))).toBe(false);
    expect(await getRedditAccount(db, WS_A)).toBeNull();
    expect(await describeRedditCredentials(db, WS_A)).toEqual({ hasCredentials: false, username: null });

    // THE ASSERTION THIS FUNCTION EXISTS FOR. The next tick opens a browser on
    // that directory again -- and finds nobody signed in, so `isLoggedIn` is
    // false, the reuse branch is not taken, and there is no vault left to fall
    // back to. Before this, the same call answered `ok`.
    const [after] = await workerPass([WS_A], driver, { now: LATER });
    expect(after.status).toBe('failed');
    expect(after.message).toBe('Save your Reddit username and password here to sign in.');
    expect(sessionIn(dirFor(WS_A))).toBeNull();

    // And the thing the customer actually revoked: publishing.
    const comment = await commentOnRedditThread(db, config, {
      workspaceId: WS_A,
      threadUrl: 'https://old.reddit.com/r/test/comments/abc/thread/',
      body: 'this must never be posted',
      now: LATER,
      driver,
      log: () => {}
    });
    expect(comment.ok).toBe(false);
    expect(await getRedditAccount(db, WS_A)).toBeNull();
  });

  it('disconnects ONE workspace, and leaves every other tenant signed in', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await putRedditCredentials(db, { workspaceId: WS_B, username: HANDLE_B, password: PASSWORD_B });
    const { driver } = sessionDriver();
    await workerPass([WS_A, WS_B], driver);

    await disconnectRedditWorkspace(db, WS_A, { config });

    expect(sessionIn(dirFor(WS_B))).toBe(HANDLE_B);
    expect((await getRedditAccount(db, WS_B))?.username).toBe(HANDLE_B);
    expect(await describeRedditCredentials(db, WS_B)).toEqual({ hasCredentials: true, username: `u/${HANDLE_B}` });

    const [beta] = await workerPass([WS_B], driver, { now: LATER });
    expect(beta.status).toBe('ok');
    expect(beta.username).toBe(HANDLE_B);
  });

  it('is idempotent, and reports honestly that there was nothing left to remove', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await workerPass([WS_A], sessionDriver().driver);

    await disconnectRedditWorkspace(db, WS_A, { config });
    const second = await disconnectRedditWorkspace(db, WS_A, { config });

    // Not an error -- an operator clicking twice must not be told the second
    // press failed -- and not a false claim of having removed anything either.
    expect(second).toEqual({
      browserClosed: false,
      profileRemoved: false,
      profileDir: dirFor(WS_A),
      credentialsRemoved: false,
      accountRemoved: false,
      problems: []
    });
  });

  it('works with Reddit automation switched off, because a revocation is not a feature', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await workerPass([WS_A], sessionDriver().driver);

    const removed = await disconnectRedditWorkspace(db, WS_A, { config: { ...config, enabled: false } });

    expect(removed.problems).toEqual([]);
    expect(removed.profileRemoved).toBe(true);
    expect(removed.accountRemoved).toBe(true);
    expect(existsSync(dirFor(WS_A))).toBe(false);
  });
});

describe('the unready log', () => {
  it('names every workspace it skips, instead of letting the first one silence the rest', async () => {
    stubbedBrowser.blockers = ['Chromium is not installed here.'];
    const lines: string[] = [];
    const log = (message: string) => lines.push(message);
    const { driver } = sessionDriver();

    for (const workspaceId of [WS_A, WS_B]) {
      const session = await openRedditSession(db, config, { workspaceId, now: NOW, driver, log });
      expect(session.ok).toBe(false);
    }

    // Two workspaces were skipped, so two workspaces are named. One line here
    // meant an operator read "one tenant is stuck" about all of them.
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes(WS_A))).toBe(true);
    expect(lines.some((line) => line.includes(WS_B))).toBe(true);

    // Still deduplicated WITHIN a workspace: this runs on a per-tick loop and a
    // repeated line is a line nobody reads.
    await openRedditSession(db, config, { workspaceId: WS_A, now: NOW, driver, log });
    expect(lines).toHaveLength(2);
  });
});
