import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { sealSecret } from '../secrets/crypto.js';
import {
  authCookieExpiry,
  clearSeatStorageState,
  describeSeatSession,
  readSeatStorageState,
  saveSeatStorageState,
  sessionStateContext,
  storageStateIsSignedIn
} from './session-state.js';
import type { BrowserStorageState } from '../browser/provider.js';

/**
 * THE SESSION IS A CREDENTIAL, AND THIS FILE IS WHERE THAT IS PROVEN.
 *
 * A browser attached over CDP has no profile directory, so a hosted seat's
 * signed-in state round-trips through Postgres. A LinkedIn `li_at` cookie
 * authenticates the account outright with no second factor in front of it --
 * it is strictly more dangerous to leak than the password, which at least meets
 * a device check. So the assertions here are the same ones the password gets:
 *
 *   1. IT IS NOT IN THE DATABASE IN THE CLEAR. The cookie value below is a
 *      canary; the raw row is searched for it.
 *   2. IT IS BOUND TO ITS ROW. A ciphertext moved to another seat, or another
 *      workspace, does not open.
 *   3. EVERY FAILURE IS "NEEDS RE-LOGIN", NEVER A SILENT UNAUTHENTICATED RUN.
 *      A rotated-away key, a tampered row, an expired cookie and a state with
 *      no sign-in cookie all land in the same place, with a reason.
 */

const WORKSPACE_ID = 'ws_li_session_state_test';
const OTHER_WORKSPACE_ID = 'ws_li_session_state_other';
const NOW = new Date('2026-08-14T10:00:00.000Z');

/** Deliberately distinctive. Any occurrence of this outside the vault is a bug. */
const COOKIE_CANARY = 'li-at-canary-4f19c7ab-never-in-the-clear';

let db: Db;
let previousKey: string | undefined;

function stateWith(overrides: Partial<BrowserStorageState> = {}, expires = 2_000_000_000): BrowserStorageState {
  return {
    cookies: [
      { name: 'li_at', value: COOKIE_CANARY, domain: '.linkedin.com', path: '/', expires, httpOnly: true, secure: true },
      { name: 'JSESSIONID', value: 'ajax:1234', domain: '.www.linkedin.com', path: '/', expires: -1 }
    ],
    origins: [{ origin: 'https://www.linkedin.com', localStorage: [{ name: 'voyager', value: 'x' }] }],
    ...overrides
  };
}

beforeAll(() => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
});

afterAll(() => {
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const id of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(id, 'LinkedIn session state test', NOW.toISOString());
    await db.prepare('DELETE FROM linkedin_seat_sessions WHERE workspace_id=?').run(id);
  }
});

afterEach(async () => {
  await db.close();
});

describe('a stored browser session', () => {
  it('round-trips exactly, and nothing about it is in the row in the clear', async () => {
    expect(await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW })).toBe(true);

    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: NOW });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') throw new Error('unreachable');
    expect(read.state.cookies[0]?.value).toBe(COOKIE_CANARY);
    expect(read.state.origins).toEqual(stateWith().origins);

    // The row itself, as bytes. The canary must appear nowhere in it.
    const row = await db.prepare('SELECT * FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?')
      .get<Record<string, unknown>>(WORKSPACE_ID, 'sales');
    expect(JSON.stringify(row)).not.toContain(COOKIE_CANARY);
    expect(Buffer.from(row?.ciphertext as Uint8Array).toString('utf8')).not.toContain('li_at');
  });

  it('records the expiry the browser reported, without decrypting to answer', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith({}, 1_800_000_000), now: NOW });
    const summary = await describeSeatSession(db, WORKSPACE_ID, 'sales', NOW);
    expect(summary.hasSession).toBe(true);
    expect(summary.expiresAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(summary.expired).toBe(false);
    // The session-only JSESSIONID (`expires: -1`) is not a date and is skipped;
    // the earliest DATED auth cookie is what the session dies with.
    expect(authCookieExpiry(stateWith({}, 1_800_000_000))?.getTime()).toBe(1_800_000_000 * 1000);
  });

  it('survives a restart, which is the entire point of storing it', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    await db.close();
    // A brand-new pool and a brand-new process-level read: nothing in memory
    // carried the session across.
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: NOW });
    expect(read.status).toBe('ok');
  });

  it('is bound to its seat: another seat\'s row cannot be opened as this one', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    const source = await db.prepare('SELECT ciphertext, iv, auth_tag, key_version, key_id FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?')
      .get<Record<string, unknown>>(WORKSPACE_ID, 'sales');

    // The transplant: seat 'sales' ciphertext written into seat 'founder'.
    await db.prepare(`
      INSERT INTO linkedin_seat_sessions (workspace_id, seat_key, ciphertext, iv, auth_tag, key_version, key_id, saved_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(WORKSPACE_ID, 'founder', source?.ciphertext, source?.iv, source?.auth_tag, source?.key_version, source?.key_id, NOW.toISOString());

    const read = await readSeatStorageState(db, WORKSPACE_ID, 'founder', { now: NOW });
    expect(read.status).toBe('needs_login');
    if (read.status !== 'needs_login') throw new Error('unreachable');
    expect(read.reason).toContain('sign in again');
  });

  it('is bound to its tenant: another workspace\'s row cannot be opened here', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    const source = await db.prepare('SELECT ciphertext, iv, auth_tag, key_version, key_id FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?')
      .get<Record<string, unknown>>(WORKSPACE_ID, 'sales');
    await db.prepare(`
      INSERT INTO linkedin_seat_sessions (workspace_id, seat_key, ciphertext, iv, auth_tag, key_version, key_id, saved_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(OTHER_WORKSPACE_ID, 'sales', source?.ciphertext, source?.iv, source?.auth_tag, source?.key_version, source?.key_id, NOW.toISOString());

    const read = await readSeatStorageState(db, OTHER_WORKSPACE_ID, 'sales', { now: NOW });
    expect(read.status).toBe('needs_login');
  });
});

describe('a session that cannot be used', () => {
  it('degrades to needs_login when it has expired, and says when', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith({}, 1_700_000_000), now: NOW });
    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: new Date(1_700_000_001 * 1000) });
    expect(read.status).toBe('needs_login');
    if (read.status !== 'needs_login') throw new Error('unreachable');
    expect(read.reason).toContain('expired');
  });

  it('degrades to needs_login when the sealing key is gone, never to "no session"', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    // A rotation that dropped the old key without re-sealing.
    const rotated = { ...process.env, TREVRA_SECRETS_KEY: randomBytes(32).toString('base64') };
    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { env: rotated, now: NOW });
    // ABSENT would mean "first run, sign in" -- which is the same next action,
    // but it would also mean the operator never learns a stored session broke.
    expect(read.status).toBe('needs_login');
  });

  it('refuses to store a state that is not signed in, rather than overwriting a good one', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    const unauthenticated: BrowserStorageState = { cookies: [{ name: 'bcookie', value: 'v' }], origins: [] };
    expect(storageStateIsSignedIn(unauthenticated)).toBe(false);
    expect(await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: unauthenticated, now: NOW })).toBe(false);
    // The good one is untouched.
    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: NOW });
    expect(read.status).toBe('ok');
  });

  it('degrades to needs_login when the sealed bytes are not a storage state at all', async () => {
    const sealed = sealSecret('"a string, not a state"', sessionStateContext(WORKSPACE_ID, 'sales'), process.env);
    await db.prepare(`
      INSERT INTO linkedin_seat_sessions (workspace_id, seat_key, ciphertext, iv, auth_tag, key_version, key_id, saved_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(WORKSPACE_ID, 'sales', sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, sealed.keyId, NOW.toISOString());
    const read = await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: NOW });
    expect(read.status).toBe('needs_login');
  });

  it('reports absent -- not needs_login -- when there simply is no row', async () => {
    expect((await readSeatStorageState(db, WORKSPACE_ID, 'never-seen', { now: NOW })).status).toBe('absent');
  });

  it('is forgotten on demand, so a challenged session is not replayed', async () => {
    await saveSeatStorageState(db, { workspaceId: WORKSPACE_ID, seatKey: 'sales', state: stateWith(), now: NOW });
    expect(await clearSeatStorageState(db, WORKSPACE_ID, 'sales')).toBe(true);
    expect((await readSeatStorageState(db, WORKSPACE_ID, 'sales', { now: NOW })).status).toBe('absent');
    expect((await describeSeatSession(db, WORKSPACE_ID, 'sales', NOW)).hasSession).toBe(false);
  });
});
