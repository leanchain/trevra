import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import {
  REDDIT_CREDENTIALS_HOSTED_REFUSAL,
  deleteRedditCredentials,
  describeRedditCredentials,
  displayHandle,
  normaliseHandle,
  putRedditCredentials,
  readRedditCredentials
} from '../secrets/reddit.js';
import type { RedditDriver, RedditLoginResult, RedditPage } from './driver.js';
import { loginRedditAccount } from './local-worker.js';
import { getRedditAccount, redditWorkspaceIds } from './account.js';

/**
 * The Reddit sign-in Trevra may now hold, and everything it must never do with
 * it.
 *
 * THE PASSWORD IN THIS FILE IS A CANARY. It is a string that appears nowhere
 * else in the codebase, and the assertions below grep for it in every place a
 * secret could plausibly end up: the credential routes' own bodies, the
 * serialised account response, the stored row, the audit trail, and the
 * sign-in outcome. A leak anywhere in that set fails a test rather than
 * shipping.
 *
 * THE HANDLE IS NOT A CANARY, and that asymmetry is the design: `u/pankaj` is
 * printed under every comment this account posts, so it rides in a label, in a
 * column and in an HTTP response ON PURPOSE (see secrets/reddit.ts, rule 3).
 * The password has no display form at all.
 *
 * Postgres-backed and route-level on purpose. What is being asserted is what
 * actually crosses the wire and what actually lands in a column, and a unit
 * test of a serializer would assert neither.
 */

const WORKSPACE_ID = 'ws_reddit_credentials_test';
const OTHER_WORKSPACE_ID = 'ws_reddit_credentials_test_other';
const NOW = new Date('2026-08-06T10:00:00.000Z');

/** Deliberately distinctive. Any occurrence of this string outside the vault is a bug. */
const PASSWORD = 'canary-Reddit-Pa55word-never-echo-me';
const USERNAME = 'trevra_canary';
/** The one display form, and the only thing a read path may show. */
const HANDLE = 'u/trevra_canary';

let db: Db;
let app: Express;
let session = '';
let previousKey: string | undefined;

async function seedSession(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(workspaceId, 'Reddit credentials test', NOW.toISOString());
  await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(userId, workspaceId, `${userId}@trevra.test`, 'Credentials test', NOW.toISOString());
  const token = randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(
    createHash('sha256').update(token).digest('hex'),
    userId,
    new Date(Date.now() + 86_400_000).toISOString(),
    new Date().toISOString()
  );
  return token;
}

function as(token: string) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `trevra_session=${token}`),
    post: (path: string) => request(app).post(path).set('Cookie', `trevra_session=${token}`),
    delete: (path: string) => request(app).delete(path).set('Cookie', `trevra_session=${token}`)
  };
}

/** A driver that records what it was handed and answers however the test says. */
function fakeDriver(options: { loggedIn?: boolean; answer?: () => RedditLoginResult; handle?: string | null } = {}) {
  const seen: Array<{ username: string; password: string; otp?: string }> = [];
  const driver: RedditDriver = {
    isLoggedIn: async () => options.loggedIn ?? false,
    readHandle: async () => (options.handle === undefined ? USERNAME : options.handle),
    loginWithCredentials: async (_page, credentials) => {
      seen.push({ ...credentials });
      return options.answer ? options.answer() : { ok: true };
    },
    // Nothing in this file reads or replies: these exist so the fake satisfies
    // the interface, and reaching either one is a bug in the test.
    readSubreddit: async () => {
      throw new Error('readSubreddit must not be reached by a sign-in test');
    },
    commentOnThread: async () => {
      throw new Error('commentOnThread must not be reached by a sign-in test');
    }
  };
  return { driver, seen };
}

const page = {} as RedditPage;
const config = { enabled: true, hosted: false, profileDir: '/tmp/trevra-reddit-credentials-test' };

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM reddit_accounts WHERE workspace_id=?').run(workspaceId);
  }
  session = await seedSession(WORKSPACE_ID);
  await seedSession(OTHER_WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
  delete process.env.TREVRA_DEPLOYMENT_MODE;
});

describe('the store', () => {
  it('seals both halves, and gives back a boolean and a public handle', async () => {
    // Saved with the prefix a human types; normalised once, on the write path.
    const stored = await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: `/u/${USERNAME}`, password: PASSWORD });
    expect(stored).toEqual({ hasCredentials: true, username: HANDLE });

    const described = await describeRedditCredentials(db, WORKSPACE_ID);
    expect(described).toEqual({ hasCredentials: true, username: HANDLE });

    // Round trips, so the sealing is real rather than a discard -- and the
    // handle comes back BARE, which is what Reddit's own form wants typed.
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toEqual({ username: USERNAME, password: PASSWORD });

    expect(await deleteRedditCredentials(db, WORKSPACE_ID)).toBe(true);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toBeNull();
    // Nothing left to wipe the second time.
    expect(await deleteRedditCredentials(db, WORKSPACE_ID)).toBe(false);
  });

  it('normalises the handle once, and has exactly one display form for it', () => {
    expect(normaliseHandle(' /u/Trevra_Canary ')).toBe('Trevra_Canary');
    expect(normaliseHandle('user/trevra_canary')).toBe('trevra_canary');
    expect(normaliseHandle('trevra_canary')).toBe('trevra_canary');
    expect(displayHandle('/u/trevra_canary')).toBe(HANDLE);
    expect(displayHandle('   ')).toBe('');
  });

  it('writes the password into a ciphertext column and nowhere else', async () => {
    await putRedditCredentials(db, {
      workspaceId: WORKSPACE_ID,
      username: USERNAME,
      password: PASSWORD,
      actorUserId: `usr_${WORKSPACE_ID}`
    });

    const rows = await db
      .prepare('SELECT kind, last4, label, ciphertext FROM workspace_secrets WHERE workspace_id=? ORDER BY kind')
      .all<{ kind: string; last4: string; label: string | null; ciphertext: Buffer }>(WORKSPACE_ID);
    expect(rows.map((row) => row.kind)).toEqual(['reddit.password', 'reddit.username']);

    // `last4` is four characters of a password sitting unencrypted in a column,
    // a backup and a replica. Both Reddit kinds are 'opaque', so it is empty.
    expect(rows.map((row) => row.last4)).toEqual(['', '']);
    // No label on the password -- there is nothing about it that may be written
    // down -- and the handle's label is the display form, computed on the write
    // path so no read path ever decrypts to render a screen.
    expect(rows[0].label).toBeNull();
    expect(rows[1].label).toBe(HANDLE);

    for (const row of rows) {
      expect(row.ciphertext.toString('utf8')).not.toContain(PASSWORD);
    }

    // And not into the audit trail either: the row says a password was stored,
    // never anything about what it was.
    await deleteRedditCredentials(db, WORKSPACE_ID, `usr_${WORKSPACE_ID}`);
    const audit = JSON.stringify(
      await db
        .prepare('SELECT event_type, metadata_json FROM audit_events WHERE workspace_id=? ORDER BY created_at, id')
        .all<{ event_type: string; metadata_json: string }>(WORKSPACE_ID)
    );
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain(PASSWORD.slice(-4));
  });

  it('reports half a pair as no pair at all', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    await db.prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND kind='reddit.password'").run(WORKSPACE_ID);

    // A handle with no password cannot sign anything in, and saying otherwise
    // would leave an operator pressing a Sign in button that can never work.
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: HANDLE });
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toBeNull();

    // The other half alone is just as useless.
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    await db.prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND kind='reddit.username'").run(WORKSPACE_ID);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toBeNull();
  });

  it('scopes a pair to the workspace that saved it', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });

    expect(await describeRedditCredentials(db, OTHER_WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
    expect(await readRedditCredentials(db, OTHER_WORKSPACE_ID)).toBeNull();
  });

  it('refuses hosted outright, and does not read what a dump might have left behind', async () => {
    const hosted = { ...process.env, TREVRA_DEPLOYMENT_MODE: 'hosted' } as NodeJS.ProcessEnv;

    await expect(putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD, env: hosted }))
      .rejects.toThrow(REDDIT_CREDENTIALS_HOSTED_REFUSAL);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });

    // And a hosted instance that somehow inherited rows still does not open
    // them: the gate is on the read path too, unconditionally.
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    expect(await readRedditCredentials(db, WORKSPACE_ID, hosted)).toBeNull();
    // The row is still there -- it is the READ that refuses, not a deletion.
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toEqual({ username: USERNAME, password: PASSWORD });
  });

  it('picks up a workspace that saved a pair before it ever signed in', async () => {
    // The UNION in `redditWorkspaceIds`: a workspace with credentials has no
    // account row until the first successful sign-in, and must still be worked.
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    expect(await getRedditAccount(db, WORKSPACE_ID)).toBeNull();
    expect(await redditWorkspaceIds(db)).toContain(WORKSPACE_ID);
    expect(await redditWorkspaceIds(db)).not.toContain(OTHER_WORKSPACE_ID);
  });
});

describe('the credential routes', () => {
  it('stores write-only, and answers with a boolean and a handle', async () => {
    const response = await as(session).post('/api/reddit/credentials').send({ username: USERNAME, password: PASSWORD }).expect(200);

    expect(response.body).toEqual({ hasCredentials: true, username: HANDLE });
    // Exactly two fields: there is no shape of this response that carries the
    // password, and no privilege level that changes that.
    expect(Object.keys(response.body as object).sort()).toEqual(['hasCredentials', 'username']);
    // THE CANARY, over the whole serialised body rather than the fields
    // somebody remembered to check.
    expect(response.text).not.toContain(PASSWORD);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: true, username: HANDLE });
  });

  it('NEVER echoes the password, not even out of a rejected body', async () => {
    const refusal = await as(session).post('/api/reddit/credentials')
      .send({ username: 'no', password: PASSWORD })
      .expect(400);
    // Zod issues carry a path and a code, never the offending value -- so the
    // shared error middleware cannot echo a password through a 400 either.
    expect(refusal.text).not.toContain(PASSWORD);
  });

  it('wipes the pair on delete, and says what else the disconnect removed', async () => {
    await as(session).post('/api/reddit/credentials').send({ username: USERNAME, password: PASSWORD }).expect(200);

    const wiped = await as(session).delete('/api/reddit/credentials').expect(200);

    // Deleting the two secret rows used to BE the disconnect, and it left the
    // account able to post: the `reddit_accounts` row survived and the browser
    // profile kept live cookies, so the reuse branch still found a signed-in
    // session. The route now runs the real revocation and reports each part of
    // it, because a disconnect that half-worked must not read as success.
    const body = wiped.body as {
      hasCredentials: boolean;
      username: string | null;
      disconnected: boolean;
      removed: { credentialsRemoved: boolean; problems: string[] };
    };
    expect(body.hasCredentials).toBe(false);
    expect(body.username).toBeNull();
    expect(body.disconnected).toBe(true);
    expect(body.removed.credentialsRemoved).toBe(true);
    expect(body.removed.problems).toEqual([]);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
    expect(await readRedditCredentials(db, WORKSPACE_ID)).toBeNull();
  });

  it('refuses to take custody on a hosted deployment', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';

    const refusal = (await as(session).post('/api/reddit/credentials').send({ username: USERNAME, password: PASSWORD }).expect(409))
      .body as { error: string };

    expect(refusal.error).toBe(REDDIT_CREDENTIALS_HOSTED_REFUSAL);
    expect(await describeRedditCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
  });

  it('scopes what it stored to the workspace that stored it', async () => {
    await as(session).post('/api/reddit/credentials').send({ username: USERNAME, password: PASSWORD }).expect(200);

    expect(await describeRedditCredentials(db, OTHER_WORKSPACE_ID)).toEqual({ hasCredentials: false, username: null });
    expect(await readRedditCredentials(db, OTHER_WORKSPACE_ID)).toBeNull();
  });
});

describe('GET /api/reddit/account', () => {
  it('carries the auth block, and NEVER the password', async () => {
    const before = (await as(session).get('/api/reddit/account').expect(200)).body as {
      account: null;
      auth: { hasCredentials: boolean; username: string | null; sessionValidAt: string | null };
    };
    expect(before.account).toBeNull();
    expect(before.auth).toEqual({ hasCredentials: false, username: null, sessionValidAt: null });

    await as(session).post('/api/reddit/credentials').send({ username: USERNAME, password: PASSWORD }).expect(200);

    const response = await as(session).get('/api/reddit/account').expect(200);
    const body = response.body as { auth: { hasCredentials: boolean; username: string | null; sessionValidAt: string | null } };
    expect(body.auth.hasCredentials).toBe(true);
    // The handle is public by design; it is the one plaintext-derived value here.
    expect(body.auth.username).toBe(HANDLE);
    // Saving a password does not confirm a session by itself: nothing has
    // signed in yet, so this stays null until a real login does.
    expect(body.auth.sessionValidAt).toBeNull();

    expect(response.text).not.toContain(PASSWORD);
    expect(response.text).not.toContain(PASSWORD.slice(0, 8));
  });
});

describe('loginRedditAccount', () => {
  it('REUSES a live session, and never opens the vault to do it', async () => {
    // NOTHING IS STORED, and the answer is still `ok`: that is the proof that
    // the reuse path does not decrypt. Re-authenticating anyway would be slower
    // on every run AND a much stronger automation signal than a session that
    // simply keeps working.
    const { driver, seen } = fakeDriver({ loggedIn: true });

    const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('ok');
    expect(seen).toHaveLength(0);
    const account = await getRedditAccount(db, WORKSPACE_ID);
    expect(account?.sessionValidAt).toBe(NOW.toISOString());
    expect(account?.username).toBe(USERNAME);
    // No password was typed, so nothing may claim this workspace holds one.
    expect(account?.authMode).toBe('manual');
  });

  it('signs in with the stored pair once the session has gone, and records that it holds one', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    const { driver, seen } = fakeDriver({ loggedIn: false });

    const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('ok');
    // Decrypted at the moment of use and handed straight to the driver.
    expect(seen).toEqual([{ username: USERNAME, password: PASSWORD, otp: undefined }]);

    const account = await getRedditAccount(db, WORKSPACE_ID);
    expect(account?.sessionValidAt).toBe(NOW.toISOString());
    expect(account?.authMode).toBe('credentials');
    expect(account?.username).toBe(USERNAME);
  });

  it('treats a 2FA prompt as a STEP, and passes the code through on the next call', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });

    const asking = fakeDriver({ loggedIn: false, answer: () => ({ ok: false, needsOtp: true }) });
    const first = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver: asking.driver, page, log: () => {} });

    // Not a failure: nothing went wrong, Reddit asked for six digits.
    expect(first.status).toBe('otp_required');
    expect(first.message).toContain('two-factor code');
    // And nothing is stamped, because no session opened.
    expect(await getRedditAccount(db, WORKSPACE_ID)).toBeNull();

    const answering = fakeDriver({ loggedIn: false });
    const second = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, otp: '123456', now: NOW, driver: answering.driver, page, log: () => {} });
    expect(second.status).toBe('ok');
    expect(answering.seen[0].otp).toBe('123456');
  });

  it('names the one thing to do when nothing is stored', async () => {
    const { driver, seen } = fakeDriver({ loggedIn: false });

    const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('failed');
    expect(seen).toHaveLength(0);
    expect(outcome.message).toBe('Save your Reddit username and password here to sign in.');
  });

  it('WRITES NOTHING an operator could read the password out of, on any branch', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });

    const lines: string[] = [];
    const log = (message: string) => lines.push(message);

    // Every branch a sign-in can take, against one collector.
    for (const answer of [
      () => ({ ok: true }) as RedditLoginResult,
      () => ({ ok: false, needsOtp: true }) as RedditLoginResult,
      () => ({ ok: false, failureKind: 'challenge' as const, detail: 'a human check' }) as RedditLoginResult,
      () => ({ ok: false, failureKind: 'not_found' as const, detail: 'Reddit did not accept that username and password.' }) as RedditLoginResult,
      () => ({ ok: false, failureKind: 'rate_limited' as const, detail: 'doing that too much' }) as RedditLoginResult,
      () => ({ ok: false, failureKind: 'unknown' as const }) as RedditLoginResult
    ]) {
      const { driver } = fakeDriver({ loggedIn: false, answer });
      const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, otp: '123456', now: NOW, driver, page, log });
      lines.push(outcome.message);
    }

    const output = lines.join('\n');
    expect(output).not.toContain(PASSWORD);
    // Not even a fragment: a truncated password is still a password.
    expect(output).not.toContain(PASSWORD.slice(0, 8));
  });

  it('says a captcha needs a person, in one sentence', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    const { driver } = fakeDriver({
      loggedIn: false,
      answer: () => ({ ok: false, failureKind: 'challenge', detail: 'Reddit is holding this sign-in behind a human check.' })
    });

    const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('challenge');
    expect(outcome.message).toContain('only a person at a browser window can finish');
    expect(await getRedditAccount(db, WORKSPACE_ID)).toBeNull();
  });

  it('will not sign in on a hosted deployment, whatever is in the vault', async () => {
    await putRedditCredentials(db, { workspaceId: WORKSPACE_ID, username: USERNAME, password: PASSWORD });
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    const { driver, seen } = fakeDriver({ loggedIn: false });

    const outcome = await loginRedditAccount(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    // The read gate refuses, so the driver is never handed anything.
    expect(seen).toHaveLength(0);
    expect(outcome.status).toBe('failed');
  });
});
