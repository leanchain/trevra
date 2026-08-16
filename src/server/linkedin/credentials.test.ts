import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import {
  deleteLinkedInCredentials,
  describeLinkedInCredentials,
  maskEmail,
  putLinkedInCredentials,
  readLinkedInCredentials
} from '../secrets/linkedin.js';
import type { LinkedInDriver, LinkedInLoginResult, LinkedInPage } from './driver.js';
import { detectLinkedInSeat, loginLinkedInSeat } from './local-worker.js';
import { getSeat, upsertSeat } from './seats.js';

/**
 * The LinkedIn sign-in Trevra may now hold, and everything it must never do
 * with it.
 *
 * THE PASSWORD IN THIS FILE IS A CANARY. It is a string that appears nowhere
 * else in the codebase, and the assertions below grep for it in every place a
 * secret could plausibly end up: the serialised seat response, the credential
 * routes' own bodies, the worker's log output, the sign-in outcome, and the
 * audit rows. A leak anywhere in that set fails a test rather than shipping.
 *
 * Postgres-backed and route-level on purpose. What is being asserted is what
 * actually crosses the wire and what actually lands in a column, and a unit
 * test of a serializer would assert neither.
 */

const WORKSPACE_ID = 'ws_li_credentials_test';
const OTHER_WORKSPACE_ID = 'ws_li_credentials_test_other';
const NOW = new Date('2026-08-04T10:00:00.000Z');

/** Deliberately distinctive. Any occurrence of this string outside the vault is a bug. */
const PASSWORD = 'canary-Pa55word-never-echo-me';
const EMAIL = 'pankaj@example.com';
const MASKED = 'p•••@example.com';

let db: Db;
let app: Express;
let session = '';
let previousKey: string | undefined;

async function seedSession(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(workspaceId, 'LinkedIn credentials test', NOW.toISOString());
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
function fakeDriver(options: { loggedIn?: boolean; answer?: () => LinkedInLoginResult } = {}) {
  const seen: Array<{ email: string; password: string; otp?: string }> = [];
  const driver: LinkedInDriver = {
    sendInvite: async () => ({ ok: true, failureKind: null }),
    sendDm: async () => ({ ok: true, failureKind: null }),
    // Nothing in this file exercises a send: these exist so the fake satisfies
    // the interface, and every one of them is a trap if it is ever reached.
    sendReply: async () => ({ ok: true, failureKind: null }),
    viewProfile: async () => ({ ok: true, failureKind: null }),
    followProfile: async () => ({ ok: true, failureKind: null }),
    likeRecentPost: async () => ({ ok: true, failureKind: null }),
    endorseSkills: async () => ({ ok: true, failureKind: null }),
    readSeat: async () => ({ ok: true, profileUrl: 'https://www.linkedin.com/in/pankaj/', name: 'Pankaj', connectionsCount: 12, degraded: [] }),
    isLoggedIn: async () => options.loggedIn ?? false,
    loginWithCredentials: async (_page, credentials) => {
      seen.push({ ...credentials });
      return options.answer ? options.answer() : { ok: true };
    }
  };
  return { driver, seen };
}

const page = {} as LinkedInPage;
const config = { enabled: true, hosted: false, profileDir: '/tmp/trevra-credentials-test' };

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
    await db.prepare('DELETE FROM linkedin_messages WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_threads WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(workspaceId);
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
  it('seals both halves, and gives back a boolean and a mask', async () => {
    const stored = await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    expect(stored).toEqual({ hasCredentials: true, maskedEmail: MASKED });

    const described = await describeLinkedInCredentials(db, WORKSPACE_ID);
    expect(described).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    // The mask keeps the domain and loses the half that is also half a login.
    expect(described.maskedEmail).not.toContain('pankaj');

    // Round trips, so the sealing is real rather than a discard.
    expect(await readLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('stores NO plaintext-derived display value for either half', async () => {
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });

    const rows = await db
      .prepare('SELECT kind, last4, label, ciphertext FROM workspace_secrets WHERE workspace_id=? ORDER BY kind')
      .all<{ kind: string; last4: string; label: string | null; ciphertext: Buffer }>(WORKSPACE_ID);
    expect(rows.map((row) => row.kind)).toEqual(['linkedin.email', 'linkedin.password']);

    // `last4` is a nickname for an API key and four characters of a password.
    // Both LinkedIn kinds therefore store the empty string: there is nothing
    // about either value that may sit unencrypted in a column, a backup or a
    // replica -- which is the entire point of the ciphertext/key split.
    expect(rows.map((row) => row.last4)).toEqual(['', '']);
    expect(rows[0].label).toBe(MASKED);
    expect(rows[1].label).toBeNull();

    // And the ciphertext really is ciphertext.
    for (const row of rows) {
      expect(row.ciphertext.toString('utf8')).not.toContain(PASSWORD);
      expect(row.ciphertext.toString('utf8')).not.toContain(EMAIL);
    }
  });

  it('never writes either value into an audit row', async () => {
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD, actorUserId: `usr_${WORKSPACE_ID}` });
    await deleteLinkedInCredentials(db, WORKSPACE_ID, `usr_${WORKSPACE_ID}`);

    const rows = await db
      .prepare('SELECT event_type, metadata_json FROM audit_events WHERE workspace_id=? ORDER BY created_at, id')
      .all<{ event_type: string; metadata_json: string }>(WORKSPACE_ID);
    expect(rows.length).toBe(4);

    const audit = JSON.stringify(rows);
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain(EMAIL);
    // Not even the four characters `last4` would have carried.
    expect(audit).not.toContain(PASSWORD.slice(-4));
  });

  it('reports half a pair as no pair at all', async () => {
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    await db.prepare("DELETE FROM workspace_secrets WHERE workspace_id=? AND kind='linkedin.password'").run(WORKSPACE_ID);

    // An email with no password cannot sign anything in, and saying otherwise
    // would leave an operator pressing a button that can never work.
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: MASKED });
    expect(await readLinkedInCredentials(db, WORKSPACE_ID)).toBeNull();
  });

  it('hosted with no remote browser stores and reads exactly like local -- there is no cloud browser to refuse on behalf of', async () => {
    const hosted = { ...process.env, TREVRA_DEPLOYMENT_MODE: 'hosted' } as NodeJS.ProcessEnv;

    const saved = await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD, env: hosted });
    expect(saved).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    expect(await readLinkedInCredentials(db, WORKSPACE_ID, hosted)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('hosted WITH a remote browser configured still refuses without the workspace\'s written authorisation', async () => {
    const hostedWithBrowser = {
      ...process.env,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
      TREVRA_BROWSER_API_KEY: 'sk-test'
    } as NodeJS.ProcessEnv;

    await expect(putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD, env: hostedWithBrowser }))
      .rejects.toThrow(/authorised Trevra to act on its LinkedIn account/);
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: null });
  });

  it('DOES NOT read what a dump might have left behind, when a remote browser is configured and unacknowledged', async () => {
    const hostedWithBrowser = {
      ...process.env,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
      TREVRA_BROWSER_API_KEY: 'sk-test'
    } as NodeJS.ProcessEnv;

    // The gate is on the read path too, unconditionally on this specific case.
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    expect(await readLinkedInCredentials(db, WORKSPACE_ID, hostedWithBrowser)).toBeNull();
  });

  it('masks an address without inventing one', () => {
    expect(maskEmail('pankaj@example.com')).toBe(MASKED);
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskEmail('not-an-address')).toBe('•••');
  });
});

describe('the credential routes', () => {
  it('stores write-only, and answers with a boolean and a mask', async () => {
    const saved = (await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200))
      .body as { hasCredentials: boolean; maskedEmail: string };
    expect(saved).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
  });

  it('accepts exactly two fields', async () => {
    await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL }).expect(400);
    await as(session).post('/api/linkedin/seat/credentials').send({ email: 'not-an-address', password: PASSWORD }).expect(400);
    await as(session).post('/api/linkedin/seat/credentials')
      .send({ email: EMAIL, password: PASSWORD, authMode: 'credentials' })
      .expect(400);
  });

  it('NEVER echoes the password, not even out of a rejected body', async () => {
    const refusal = await as(session).post('/api/linkedin/seat/credentials')
      .send({ email: 'not-an-address', password: PASSWORD })
      .expect(400);
    // Zod issues carry a path and a code, never the offending value -- so the
    // shared error middleware cannot echo a password through a 400 either.
    expect(JSON.stringify(refusal.body)).not.toContain(PASSWORD);
  });

  it('stores credentials, and wipes them on delete', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' }, NOW);
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: null });

    const saved = (await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200))
      .body as { hasCredentials: boolean; maskedEmail: string };
    expect(saved).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: true, maskedEmail: MASKED });

    const wiped = (await as(session).delete('/api/linkedin/seat/credentials').expect(200))
      .body as { hasCredentials: boolean; maskedEmail: null };
    expect(wiped).toEqual({ hasCredentials: false, maskedEmail: null });
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: null });
  });

  it('takes custody on a hosted deployment with no remote browser, exactly as local does', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    const saved = (await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200))
      .body as { hasCredentials: boolean; maskedEmail: string };
    expect(saved).toEqual({ hasCredentials: true, maskedEmail: MASKED });
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: true, maskedEmail: MASKED });
  });

  it('still refuses on a hosted deployment WITH a remote browser and no written authorisation', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    process.env.TREVRA_BROWSER_PROVIDER = 'remote';
    process.env.TREVRA_BROWSER_CDP_URL = 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}';
    process.env.TREVRA_BROWSER_API_KEY = 'sk-test';
    const refusal = (await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(409))
      .body as { error: string };
    expect(refusal.error).toMatch(/authorised Trevra to act on its LinkedIn account/);
    expect(await describeLinkedInCredentials(db, WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: null });
    delete process.env.TREVRA_BROWSER_PROVIDER;
    delete process.env.TREVRA_BROWSER_CDP_URL;
    delete process.env.TREVRA_BROWSER_API_KEY;
  });

  it('refuses rather than storing anything in the clear with no server key', async () => {
    delete process.env.TREVRA_SECRETS_KEY;
    const refusal = (await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(409))
      .body as { error: string };
    expect(refusal.error).toContain('TREVRA_SECRETS_KEY');
    expect(refusal.error).not.toContain(PASSWORD);
  });

  it('scopes credentials to the workspace that saved them', async () => {
    await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200);
    expect(await describeLinkedInCredentials(db, OTHER_WORKSPACE_ID)).toEqual({ hasCredentials: false, maskedEmail: null });
    expect(await readLinkedInCredentials(db, OTHER_WORKSPACE_ID)).toBeNull();
  });
});

describe('GET /api/linkedin/seat', () => {
  it('carries the auth block, and NEVER the password', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich' }, NOW);

    const before = (await as(session).get('/api/linkedin/seat').expect(200)).body as {
      auth: { hasCredentials: boolean; maskedEmail: string | null; sessionValidAt: string | null };
    };
    expect(before.auth).toEqual({ hasCredentials: false, maskedEmail: null, sessionValidAt: null });

    await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const response = await as(session).get('/api/linkedin/seat').expect(200);
    const body = response.body as { auth: { hasCredentials: boolean; maskedEmail: string | null; sessionValidAt: string | null } };
    expect(body.auth.hasCredentials).toBe(true);
    expect(body.auth.maskedEmail).toBe(MASKED);
    // Saving a password does not confirm a session by itself: nothing has
    // signed in yet, so this stays null until a real login does.
    expect(body.auth.sessionValidAt).toBeNull();

    // THE CANARY, over the whole serialised response rather than over the two
    // fields somebody remembered to check.
    expect(response.text).not.toContain(PASSWORD);
    expect(response.text).not.toContain(EMAIL);
  });

  it('reports credentials as saved before any seat exists, because that is the order they happen in', async () => {
    // Typing an email and a password is the FIRST thing an operator does; the
    // seat is created afterwards, by detection reading the session.
    await as(session).post('/api/linkedin/seat/credentials').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const body = (await as(session).get('/api/linkedin/seat').expect(200)).body as {
      seat: null;
      auth: { hasCredentials: boolean; sessionValidAt: string | null };
    };
    expect(body.seat).toBeNull();
    expect(body.auth.hasCredentials).toBe(true);
    expect(body.auth.sessionValidAt).toBeNull();
  });
});

describe('POST /api/linkedin/seat/login', () => {
  it('accepts a code and nothing else', async () => {
    await as(session).post('/api/linkedin/seat/login').send({ otp: '123456', email: EMAIL }).expect(400);
    await as(session).post('/api/linkedin/seat/login').send({ otp: 'no' }).expect(400);
  });

  it('answers with a status and a sentence rather than a stack trace', async () => {
    // No browser exists in this suite, so this exercises the honest refusal
    // path: one sentence, 200, and nothing about either stored value.
    const body = (await as(session).post('/api/linkedin/seat/login').send({}).expect(200))
      .body as { status: string; message: string };
    expect(['ok', 'otp_required', 'challenge', 'failed']).toContain(body.status);
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.message).not.toContain(PASSWORD);
  });

  it('refuses on a hosted deployment', async () => {
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    const refusal = (await as(session).post('/api/linkedin/seat/login').send({}).expect(409)).body as { error: string };
    expect(refusal.error).toBe('This deployment is hosted, so LinkedIn automation is off and cannot be enabled.');
  });
});

describe('loginLinkedInSeat', () => {
  it('REUSES a live session and never opens the password to do it', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    const { driver, seen } = fakeDriver({ loggedIn: true });

    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('ok');
    // The whole reason `session_valid_at` exists: a stored session that still
    // works is reused, because re-authenticating every run is slower AND a much
    // stronger ban signal than a session that simply keeps working.
    expect(seen).toHaveLength(0);
    expect((await getSeat(db, WORKSPACE_ID))?.sessionValidAt).toBe(NOW.toISOString());
  });

  it('signs in with the stored pair only once the session has gone', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    const { driver, seen } = fakeDriver({ loggedIn: false });

    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('ok');
    // Decrypted at the moment of use and handed straight to the driver.
    expect(seen).toEqual([{ email: EMAIL, password: PASSWORD, otp: undefined }]);
    expect((await getSeat(db, WORKSPACE_ID))?.sessionValidAt).toBe(NOW.toISOString());
  });

  it('treats a 2FA prompt as a STEP, and passes the code through on the next call', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });

    const asking = fakeDriver({ loggedIn: false, answer: () => ({ ok: false, needsOtp: true }) });
    const first = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver: asking.driver, page, log: () => {} });
    expect(first.status).toBe('otp_required');
    // Not a failure, so nothing is stamped and nothing is paused.
    expect((await getSeat(db, WORKSPACE_ID))?.sessionValidAt).toBeNull();

    const answering = fakeDriver({ loggedIn: false });
    const second = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, otp: '123456', now: NOW, driver: answering.driver, page, log: () => {} });
    expect(second.status).toBe('ok');
    expect(answering.seen[0].otp).toBe('123456');
  });

  it('says in one sentence that a device check needs a person', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    const { driver } = fakeDriver({
      loggedIn: false,
      answer: () => ({ ok: false, failureKind: 'challenge', detail: 'LinkedIn is holding this sign-in for a device check.' })
    });

    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('challenge');
    expect(outcome.message).toContain('only a person at a browser window can finish');
    expect((await getSeat(db, WORKSPACE_ID))?.sessionValidAt).toBeNull();

    // A real challenge now holds off the next login attempt for a while (see
    // the cooldown test below) -- clear that module-level stamp so it does not
    // outlive this test and swallow a later, unrelated one on the same seat.
    await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: NOW, driver: fakeDriver({ loggedIn: true }).driver, page, log: () => {} }
    );
  });

  it('does not re-navigate a challenged seat away from itself every tick', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    const challenge = () => ({ ok: false, failureKind: 'challenge' as const, detail: 'LinkedIn is holding this sign-in for a device check.' });

    const first = fakeDriver({ loggedIn: false, answer: challenge });
    const firstOutcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver: first.driver, page, log: () => {} });
    expect(firstOutcome.status).toBe('challenge');
    expect(first.seen).toHaveLength(1);

    // A second tick, one minute later, well inside the cooldown, on a FRESH
    // driver instance still reporting `loggedIn: false` -- the human has not
    // finished yet. If this called `loginWithCredentials` again it would
    // `page.goto(LOGIN_URL)` out from under them; `seen` staying empty is the
    // proof it did not touch the page at all.
    const second = fakeDriver({ loggedIn: false, answer: challenge });
    const secondOutcome = await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: new Date(NOW.getTime() + 60_000), driver: second.driver, page, log: () => {} }
    );
    expect(secondOutcome.status).toBe('challenge');
    expect(secondOutcome.message).toBe(firstOutcome.message);
    expect(second.seen).toHaveLength(0);

    // The human clears it mid-cooldown. `isLoggedIn` is asked unconditionally,
    // so the very next tick picks the session up rather than waiting out the
    // rest of the window -- and clears the stamp so a later, unrelated
    // challenge on this seat is not silently swallowed too.
    const cleared = fakeDriver({ loggedIn: true });
    const clearedOutcome = await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: new Date(NOW.getTime() + 120_000), driver: cleared.driver, page, log: () => {} }
    );
    expect(clearedOutcome.status).toBe('ok');
    expect(cleared.seen).toHaveLength(0);

    // Cooldown cleared: a fresh challenge right after is reported immediately,
    // not swallowed by a stale stamp from the one above.
    const after = fakeDriver({ loggedIn: false, answer: challenge });
    const afterOutcome = await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: new Date(NOW.getTime() + 180_000), driver: after.driver, page, log: () => {} }
    );
    expect(afterOutcome.status).toBe('challenge');
    expect(after.seen).toHaveLength(1);

    // Clean up the module-level stamp this test just left behind -- it is
    // keyed only on (workspace, seat), and this file reuses WORKSPACE_ID
    // across every other `it` below, none of which expect a challenge already
    // in flight when they start.
    await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: new Date(NOW.getTime() + 240_000), driver: fakeDriver({ loggedIn: true }).driver, page, log: () => {} }
    );
  });

  it('reports a rejected pair as failed, without repeating it back', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    const { driver } = fakeDriver({
      loggedIn: false,
      answer: () => ({
        ok: false,
        failureKind: 'not_found',
        detail: 'LinkedIn did not accept that email address and password. Save the right ones and sign in again.'
      })
    });

    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('failed');
    expect(outcome.message).not.toContain(PASSWORD);
    expect(outcome.message).not.toContain(EMAIL);
  });

  it('names the one thing to do when nothing is stored', async () => {
    const { driver, seen } = fakeDriver({ loggedIn: false });
    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    expect(outcome.status).toBe('failed');
    expect(seen).toHaveLength(0);
    expect(outcome.message).toBe('Save your LinkedIn email and password here to sign in.');
  });

  it('WRITES NOTHING TO THE LOG that a password could hide in', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });

    const lines: string[] = [];
    const log = (message: string) => lines.push(message);

    // Every branch a worker tick can take, against one log collector.
    for (const answer of [
      () => ({ ok: true }) as LinkedInLoginResult,
      () => ({ ok: false, needsOtp: true }) as LinkedInLoginResult,
      () => ({ ok: false, failureKind: 'challenge' as const, detail: 'device check' }) as LinkedInLoginResult,
      () => ({ ok: false, failureKind: 'not_found' as const, detail: 'rejected' }) as LinkedInLoginResult,
      () => ({ ok: false, failureKind: 'unknown' as const }) as LinkedInLoginResult
    ]) {
      const { driver } = fakeDriver({ loggedIn: false, answer });
      const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, otp: '123456', now: NOW, driver, page, log });
      lines.push(outcome.message);
    }

    const output = lines.join('\n');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(EMAIL);
    // Not even a fragment: a truncated password is still a password.
    expect(output).not.toContain(PASSWORD.slice(0, 8));

    // The 'challenge' iteration above stamped a cooldown for this seat; clear
    // it so it does not silently short-circuit the next test's own call.
    await loginLinkedInSeat(
      db, config,
      { workspaceId: WORKSPACE_ID, now: NOW, driver: fakeDriver({ loggedIn: true }).driver, page, log: () => {} }
    );
  });

  it('will not sign in with a remote browser configured and no written authorisation, whatever is in the vault', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich' }, NOW);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: EMAIL, password: PASSWORD });
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    // A remote browser IS configured here -- unlike a plain hosted deployment,
    // which now reads its own client-side worker's stored credential exactly
    // as local does. What still refuses is Trevra's own servers acting as the
    // member with no per-workspace written authorisation on file.
    process.env.TREVRA_BROWSER_PROVIDER = 'remote';
    process.env.TREVRA_BROWSER_CDP_URL = 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}';
    process.env.TREVRA_BROWSER_API_KEY = 'sk-test';
    const { driver, seen } = fakeDriver({ loggedIn: false });

    const outcome = await loginLinkedInSeat(db, config, { workspaceId: WORKSPACE_ID, now: NOW, driver, page, log: () => {} });

    // The read gate refuses, so the driver is never handed anything.
    expect(seen).toHaveLength(0);
    expect(outcome.status).toBe('failed');

    delete process.env.TREVRA_BROWSER_PROVIDER;
    delete process.env.TREVRA_BROWSER_CDP_URL;
    delete process.env.TREVRA_BROWSER_API_KEY;
  });
});

/**
 * A workspace reconnecting a DIFFERENT LinkedIn account -- new credentials
 * saved over old ones, then re-detected -- must not keep showing the previous
 * account's conversations or pace the new one as though it were established.
 */
describe('detectLinkedInSeat on an account change', () => {
  const PREVIOUS_PROFILE = 'https://www.linkedin.com/in/pankaj/';
  const NEW_PROFILE = 'https://www.linkedin.com/in/daryna-radiichuk/';

  it('wipes the stored inbox and restarts the ramp when a different LinkedIn account signs in', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich', profileUrl: PREVIOUS_PROFILE }, NOW);
    await db.prepare(`
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url, name)
      VALUES ('lthr_stale', ?, 'owner', '2-stale==', ?, 'Someone from the old account')
    `).run(WORKSPACE_ID, PREVIOUS_PROFILE);
    await db.prepare(`
      INSERT INTO linkedin_messages (id, workspace_id, thread_id, direction, body, external_ref)
      VALUES ('lmsg_stale', ?, 'lthr_stale', 'in', 'A message from before the reconnect', 'sha256:stale')
    `).run(WORKSPACE_ID);
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, email: 'daryna@example.com', password: PASSWORD });

    const { driver } = fakeDriver({ loggedIn: false, answer: () => ({ ok: true }) });
    driver.readSeat = async () => ({ ok: true, profileUrl: NEW_PROFILE, name: 'Daryna Radiichuk', connectionsCount: 512, degraded: [] });

    const later = new Date(NOW.getTime() + 30 * 86_400_000);
    const lines: string[] = [];
    const result = await detectLinkedInSeat(db, config, {
      workspaceId: WORKSPACE_ID,
      timezone: 'Europe/Zurich',
      now: later,
      driver,
      page,
      log: (message: string) => lines.push(message)
    });

    expect(result.blocked).toBeNull();
    expect(result.seat?.profileUrl).toBe(NEW_PROFILE);
    // The ramp restarted: `activatedAt` is `later`, not the original `NOW`.
    expect(result.seat?.activatedAt).toBe(later.toISOString());
    // The operator's own label survives an account change; it names the seat, not the account.
    expect(result.seat?.label).toBe('Pankaj (founder)');

    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0]).toContain(NEW_PROFILE);
    expect(result.degraded[0]).toContain(PREVIOUS_PROFILE);
    expect(result.degraded[0]).toContain('1 stored conversation');
    expect(lines).toContain(result.degraded[0]);

    expect(await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_ID)).toEqual([]);
    expect(await db.prepare('SELECT id FROM linkedin_messages WHERE workspace_id=?').all(WORKSPACE_ID)).toEqual([]);
  });

  it('does not reset anything when the same account re-detects', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj', timezone: 'Europe/Zurich', profileUrl: PREVIOUS_PROFILE }, NOW);
    await db.prepare(`
      INSERT INTO linkedin_threads (id, workspace_id, seat_key, thread_urn, profile_url)
      VALUES ('lthr_kept', ?, 'owner', '2-kept==', ?)
    `).run(WORKSPACE_ID, PREVIOUS_PROFILE);

    const { driver } = fakeDriver({ loggedIn: true });

    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const result = await detectLinkedInSeat(db, config, {
      workspaceId: WORKSPACE_ID,
      timezone: 'Europe/Zurich',
      now: later,
      driver,
      page,
      log: () => {}
    });

    expect(result.seat?.profileUrl).toBe(PREVIOUS_PROFILE);
    expect(result.seat?.activatedAt).toBe(NOW.toISOString());
    expect(result.degraded).toEqual([]);
    expect(await db.prepare('SELECT id FROM linkedin_threads WHERE workspace_id=?').all(WORKSPACE_ID)).toHaveLength(1);
  });
});
