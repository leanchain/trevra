import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { companionWorkspaceReady } from './companion.js';
import { recordSeatEvent } from './seat-events.js';
import { upsertSeat } from './seats.js';
const WORKSPACE_ID = 'ws_companion_api_test';
const NOW = new Date('2026-08-16T12:00:00.000Z');
let db: Db;
let app: Express;
let session = '';
let previousKey: string | undefined;

async function seedSession(): Promise<string> {
  const userId = 'usr_companion_api_owner';
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Companion API test', NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id'
    )
    .run(userId, WORKSPACE_ID, 'companion-owner@trevra.test', 'Companion owner', NOW.toISOString());
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString()
    );
  return token;
}

const authed = () => ({
  get: (path: string) => request(app).get(path).set('Cookie', `trevra_session=${session}`),
  post: (path: string) => request(app).post(path).set('Cookie', `trevra_session=${session}`),
  delete: (path: string) => request(app).delete(path).set('Cookie', `trevra_session=${session}`)
});

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

beforeEach(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM linkedin_companion_devices WHERE workspace_id=?').run(WORKSPACE_ID);
  await db
    .prepare('DELETE FROM linkedin_companion_pairings WHERE workspace_id=?')
    .run(WORKSPACE_ID);
  session = await seedSession();
  app = createApp(db);
});

afterEach(async () => {
  await db.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

describe('LinkedIn companion HTTP journey', () => {
  it('pairs with one short code, exposes no device token to the browser session, and can be revoked', async () => {
    const created = await authed().post('/api/linkedin/companion/pair').send({}).expect(201);
    expect(created.body.code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(created.body.command).toContain(
      'npx --yes --package=https://github.com/leanchain/trevra/releases/download/companion-v0.2.2/trevra-0.2.2.tgz trevra linkedin install --pair'
    );
    expect(created.body.command).toContain(created.body.code);

    // The exchange is deliberately a CLI route: no session cookie, just the
    // short-lived one-time code. A browser CSRF token is not the credential.
    const exchange = await request(app)
      .post('/api/linkedin/companion/exchange')
      .send({
        code: created.body.code,
        label: 'Pankaj laptop'
      })
      .expect(201);
    expect(exchange.body.token).toMatch(/^trv_cmp_/);

    const status = await authed().get('/api/linkedin/companion').expect(200);
    expect(JSON.stringify(status.body)).not.toContain(exchange.body.token);
    expect(status.body.devices).toEqual([
      expect.objectContaining({ id: exchange.body.deviceId, label: 'Pankaj laptop', online: false })
    ]);

    await authed()
      .delete(`/api/linkedin/companion/devices/${exchange.body.deviceId}`)
      .expect(200, { revoked: true });
    const after = await authed().get('/api/linkedin/companion').expect(200);
    expect(after.body.devices).toEqual([]);
  });

  it('treats visible recovery as online but non-executable, and clears attention as soon as the session is verified', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Pankaj Kumar', timezone: 'Europe/Zurich' },
      NOW,
      'Pankaj'
    );
    await recordSeatEvent(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'Pankaj',
        kind: 'challenge',
        detail: 'LinkedIn needs a human check.'
      },
      NOW
    );

    const created = await authed().post('/api/linkedin/companion/pair').send({}).expect(201);
    const exchange = await request(app)
      .post('/api/linkedin/companion/exchange')
      .send({ code: created.body.code, label: 'Pankaj laptop' })
      .expect(201);
    const recovery = (state: 'open' | 'verified' | 'closed') =>
      request(app)
        .post('/api/linkedin/companion/recovery/status')
        .set('Authorization', `Bearer ${exchange.body.token}`)
        .send({ seatKey: 'Pankaj', state });

    await recovery('open').expect(200, { ok: true });
    let status = (await authed().get('/api/linkedin/companion').expect(200)).body;
    expect(status.devices).toEqual([
      expect.objectContaining({ label: 'Pankaj laptop', online: true })
    ]);
    expect(status.attention).toEqual([
      expect.objectContaining({ seatKey: 'Pankaj', kind: 'challenge' })
    ]);
    expect(status.recoveries).toEqual([
      expect.objectContaining({ seatKey: 'Pankaj', status: 'open' })
    ]);
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, new Date())).toBe(false);

    await recovery('verified').expect(200, { ok: true });
    status = (await authed().get('/api/linkedin/companion').expect(200)).body;
    expect(status.attention).toEqual([]);
    expect(status.recoveries).toEqual([
      expect.objectContaining({ seatKey: 'Pankaj', status: 'verified' })
    ]);
    const latest = await db
      .prepare(
        `SELECT kind FROM linkedin_seat_events
         WHERE workspace_id=? AND seat_key=?
         ORDER BY occurred_at DESC LIMIT 1`
      )
      .get<{ kind: string }>(WORKSPACE_ID, 'Pankaj');
    expect(latest?.kind).toBe('recovery_verified');
    expect(await companionWorkspaceReady(db, WORKSPACE_ID, new Date())).toBe(false);

    await recovery('closed').expect(200, { ok: true });
    status = (await authed().get('/api/linkedin/companion').expect(200)).body;
    expect(status.recoveries).toEqual([]);
  });

  it('rejects recovery heartbeats from an unpaired token', async () => {
    await request(app)
      .post('/api/linkedin/companion/recovery/status')
      .set('Authorization', 'Bearer trv_cmp_not-a-real-device-token-value')
      .send({ seatKey: 'Pankaj', state: 'open' })
      .expect(401);
  });

  it('does not exchange a made-up pairing code', async () => {
    const response = await request(app)
      .post('/api/linkedin/companion/exchange')
      .send({
        code: 'ABCD-EF01-2345',
        label: 'Unknown laptop'
      })
      .expect(400);
    expect(response.body.error).toMatch(/pairing code/i);
  });
});
