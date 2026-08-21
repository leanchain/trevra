import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderDriver } from '../browser/provider.js';
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

const WS_A = 'ws_reddit_tenancy_a';
const WS_B = 'ws_reddit_tenancy_b';
const NOW = new Date('2026-08-14T10:00:00.000Z');
const LATER = new Date('2026-08-14T11:00:00.000Z');
const HANDLE_A = 'tenant_alpha';
const HANDLE_B = 'tenant_beta';
const PASSWORD_A = 'alpha-Pa55word-never-echo-me';
const PASSWORD_B = 'beta-Pa55word-never-echo-me';
const PROFILE_BASE = join(tmpdir(), 'trevra-reddit-tenancy-test');

const config = { enabled: true, hosted: false, profileDir: PROFILE_BASE };

type FakePage = RedditPage & { workspaceId: string; liveHandle: string | null };

function pageFor(workspaceId: string, liveHandle: string | null = null): FakePage {
  return { workspaceId, liveHandle } as FakePage;
}

function dirFor(workspaceId: string): string {
  return resolveRedditProfileDir(PROFILE_BASE, workspaceId);
}

function sessionDriver(overrides: Partial<RedditDriver> = {}) {
  const typed: Array<{ workspaceId: string; username: string }> = [];
  const driver: RedditDriver = {
    isLoggedIn: async (page) => (page as FakePage).liveHandle !== null,
    readHandle: async (page) => (page as FakePage).liveHandle,
    loginWithCredentials: async (page, credentials) => {
      const target = page as FakePage;
      typed.push({ workspaceId: target.workspaceId, username: credentials.username });
      target.liveHandle = credentials.username;
      return { ok: true };
    },
    readSubreddit: async () => {
      throw new Error('readSubreddit must not be reached by this test');
    },
    commentOnThread: async () => {
      throw new Error('commentOnThread must not be reached by this test');
    },
    ...overrides
  };
  return { driver, typed };
}

let db: Db;
let previousKey: string | undefined;

async function seedWorkspace(workspaceId: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, 'Reddit tenancy test', NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(
      `usr_${workspaceId}`,
      workspaceId,
      `usr_${workspaceId}@trevra.test`,
      'Tenancy test',
      NOW.toISOString()
    );
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  delete process.env.TREVRA_DEPLOYMENT_MODE;

  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WS_A, WS_B]) {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM reddit_accounts WHERE workspace_id=?').run(workspaceId);
    await seedWorkspace(workspaceId);
    await rm(dirFor(workspaceId), { recursive: true, force: true });
  }
});

afterEach(async () => {
  await closeRedditBrowser();
  for (const workspaceId of [WS_A, WS_B])
    await rm(dirFor(workspaceId), { recursive: true, force: true });
  await db?.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

describe('legacy profile paths', () => {
  it('remain tenant-scoped only for cleanup/migration purposes', () => {
    expect(dirFor(WS_A)).not.toBe(dirFor(WS_B));
    expect(dirFor(WS_A)).toBe(`${PROFILE_BASE}-${WS_A}-profile`);
    expect(resolveRedditProfileDir(PROFILE_BASE, '../../etc')).toBe(
      `${PROFILE_BASE}-______etc-profile`
    );
    expect(redditProfileDirBase(PROFILE_BASE)).toBe(PROFILE_BASE);
    expect(redditWorkerStatus(config, { workspaceId: WS_B }).profileDir).toBe(dirFor(WS_B));
  });
});

describe('browser ownership', () => {
  it('refuses to create a Reddit browser in the server process', async () => {
    const lines: string[] = [];
    const session = await openRedditSession(db, config, {
      workspaceId: WS_A,
      driver: sessionDriver().driver,
      log: (message) => lines.push(message)
    });

    expect(session.ok).toBe(false);
    if (session.ok) throw new Error('unreachable');
    expect(session.blocked).toMatch(/server-local Chrome launches are disabled/);
    expect(session.blocked).toMatch(/Companion/);
  });

  it('attaches to the reserved Reddit profile on Companion and never launches local Chromium', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    const page = pageFor(WS_A);
    const { driver, typed } = sessionDriver();
    let localLaunches = 0;
    const endpoints: string[] = [];
    const closed: string[] = [];
    const context = {
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
      on: () => {}
    };
    const playwright = {
      chromium: {
        launchPersistentContext: async () => {
          localLaunches += 1;
          throw new Error('server-local Chromium must never launch');
        },
        connectOverCDP: async (endpoint: string) => {
          endpoints.push(endpoint);
          return {
            contexts: () => [context],
            newContext: async () => context,
            close: async () => {
              closed.push(endpoint);
            }
          };
        }
      }
    } as unknown as ProviderDriver;
    const env = {
      TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080',
      TREVRA_SECRETS_KEY: 'reddit-companion-test-secret'
    };

    const session = await openRedditSession(db, config, {
      workspaceId: WS_A,
      driver,
      env,
      playwright
    });

    expect(session.ok).toBe(true);
    expect(localLaunches).toBe(0);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toContain(
      '/api/linkedin/companion/browser/ws_reddit_tenancy_a/__reddit__'
    );
    expect(typed).toEqual([{ workspaceId: WS_A, username: HANDLE_A }]);
    expect((await getRedditAccount(db, WS_A))?.username).toBe(HANDLE_A);

    await closeRedditBrowser(WS_A);
    expect(closed).toEqual(endpoints);
  });

  it('keeps browser-independent login logic tenant-scoped when a page is injected', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    await putRedditCredentials(db, { workspaceId: WS_B, username: HANDLE_B, password: PASSWORD_B });
    const alpha = pageFor(WS_A);
    const beta = pageFor(WS_B);
    const { driver, typed } = sessionDriver();

    const firstA = await loginRedditAccount(db, config, {
      workspaceId: WS_A,
      page: alpha,
      driver,
      now: NOW
    });
    const firstB = await loginRedditAccount(db, config, {
      workspaceId: WS_B,
      page: beta,
      driver,
      now: NOW
    });

    expect([firstA.status, firstB.status]).toEqual(['ok', 'ok']);
    expect([firstA.username, firstB.username]).toEqual([HANDLE_A, HANDLE_B]);
    expect(typed).toEqual([
      { workspaceId: WS_A, username: HANDLE_A },
      { workspaceId: WS_B, username: HANDLE_B }
    ]);
    expect((await getRedditAccount(db, WS_A))?.username).toBe(HANDLE_A);
    expect((await getRedditAccount(db, WS_B))?.username).toBe(HANDLE_B);

    const secondA = await loginRedditAccount(db, config, {
      workspaceId: WS_A,
      page: alpha,
      driver,
      now: LATER
    });
    const secondB = await loginRedditAccount(db, config, {
      workspaceId: WS_B,
      page: beta,
      driver,
      now: LATER
    });
    expect([secondA.username, secondB.username]).toEqual([HANDLE_A, HANDLE_B]);
    expect(typed).toHaveLength(2);
  });
});

describe('session identity', () => {
  it('refuses a live page signed in as the wrong account', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    const page = pageFor(WS_A);
    const { driver } = sessionDriver();
    expect(
      (await loginRedditAccount(db, config, { workspaceId: WS_A, page, driver, now: NOW })).status
    ).toBe('ok');

    page.liveHandle = 'someone_else';
    const outcome = await loginRedditAccount(db, config, {
      workspaceId: WS_A,
      page,
      driver,
      now: LATER
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('signed in as u/someone_else');
    expect(outcome.message).toContain(`account is u/${HANDLE_A}`);
    expect((await getRedditAccount(db, WS_A))?.username).toBe(HANDLE_A);
  });

  it('refuses rather than guessing when the live handle cannot be read', async () => {
    await putRedditCredentials(db, { workspaceId: WS_A, username: HANDLE_A, password: PASSWORD_A });
    const page = pageFor(WS_A);
    const first = sessionDriver();
    expect(
      (
        await loginRedditAccount(db, config, {
          workspaceId: WS_A,
          page,
          driver: first.driver,
          now: NOW
        })
      ).status
    ).toBe('ok');

    const blind = sessionDriver({ readHandle: async () => null });
    const outcome = await loginRedditAccount(db, config, {
      workspaceId: WS_A,
      page,
      driver: blind.driver,
      now: LATER
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('Could not read which account');
  });

  it('adopts a live handle on a first manual session without opening a browser', async () => {
    const page = pageFor(WS_A, HANDLE_A);
    const { driver, typed } = sessionDriver();
    const outcome = await loginRedditAccount(db, config, {
      workspaceId: WS_A,
      page,
      driver,
      now: NOW
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.username).toBe(HANDLE_A);
    expect(typed).toHaveLength(0);
    const account = await getRedditAccount(db, WS_A);
    expect(account?.username).toBe(HANDLE_A);
    expect(account?.authMode).toBe('manual');
  });
});

describe('disconnectRedditWorkspace', () => {
  async function seedConnectedWorkspace(
    workspaceId: string,
    handle: string,
    password: string
  ): Promise<void> {
    await putRedditCredentials(db, { workspaceId, username: handle, password });
    const page = pageFor(workspaceId);
    const { driver } = sessionDriver();
    const outcome = await loginRedditAccount(db, config, { workspaceId, page, driver, now: NOW });
    expect(outcome.status).toBe('ok');
    await mkdir(dirFor(workspaceId), { recursive: true });
    await writeFile(join(dirFor(workspaceId), 'Cookies'), 'legacy-session');
  }

  it('removes credentials, account state, and any legacy server profile without needing browser execution', async () => {
    await seedConnectedWorkspace(WS_A, HANDLE_A, PASSWORD_A);

    const removed = await disconnectRedditWorkspace(db, WS_A, {
      config: { ...config, enabled: false }
    });

    expect(removed.problems).toEqual([]);
    expect(removed.browserClosed).toBe(false);
    expect(removed.profileRemoved).toBe(true);
    expect(removed.credentialsRemoved).toBe(true);
    expect(removed.accountRemoved).toBe(true);
    expect(existsSync(dirFor(WS_A))).toBe(false);
    expect(await getRedditAccount(db, WS_A)).toBeNull();
    expect(await describeRedditCredentials(db, WS_A)).toEqual({
      hasCredentials: false,
      username: null
    });

    const comment = await commentOnRedditThread(
      db,
      { ...config, enabled: false },
      {
        workspaceId: WS_A,
        threadUrl: 'https://old.reddit.com/r/test/comments/abc/thread/',
        body: 'this must never be posted',
        now: LATER,
        driver: sessionDriver().driver,
        log: () => {}
      }
    );
    expect(comment.ok).toBe(false);
  });

  it("disconnects one workspace without deleting another workspace's state", async () => {
    await seedConnectedWorkspace(WS_A, HANDLE_A, PASSWORD_A);
    await seedConnectedWorkspace(WS_B, HANDLE_B, PASSWORD_B);

    await disconnectRedditWorkspace(db, WS_A, { config });

    expect(await getRedditAccount(db, WS_A)).toBeNull();
    expect((await getRedditAccount(db, WS_B))?.username).toBe(HANDLE_B);
    expect(await describeRedditCredentials(db, WS_B)).toEqual({
      hasCredentials: true,
      username: `u/${HANDLE_B}`
    });
    expect(existsSync(dirFor(WS_B))).toBe(true);
  });

  it('is idempotent', async () => {
    await seedConnectedWorkspace(WS_A, HANDLE_A, PASSWORD_A);
    await disconnectRedditWorkspace(db, WS_A, { config });
    const second = await disconnectRedditWorkspace(db, WS_A, { config });

    expect(second).toEqual({
      browserClosed: false,
      profileRemoved: false,
      profileDir: dirFor(WS_A),
      credentialsRemoved: false,
      accountRemoved: false,
      problems: []
    });
  });
});
