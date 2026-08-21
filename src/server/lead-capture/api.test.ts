import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE_ID = 'ws_capture_api';
const USER_ID = 'usr_capture_api';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Capture API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'capture-api@trevra.test', 'Capture API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function authed() {
  const cookie = `trevra_session=${session}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

function signedRequest(sourceId: string, secret: string, key: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`), Buffer.from(body)]))
    .digest('hex');
  return request(app)
    .post('/api/intake/v1/submissions')
    .set('Content-Type', 'application/json')
    .set('X-Trevra-Source', sourceId)
    .set('X-Trevra-Timestamp', timestamp)
    .set('X-Trevra-Idempotency-Key', key)
    .set('X-Trevra-Signature', `sha256=${signature}`)
    .send(body);
}

let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@capture-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('capture-owner');
  const member = await signUp('capture-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  const memberAuth = (await member.agent.get('/api/auth/session').expect(200)).body.auth as {
    workspaceId: string;
    role: 'owner' | 'member';
  };
  expect(memberAuth.workspaceId).toBe(owner.auth.workspaceId);
  expect(memberAuth.role).toBe('member');
  return { owner, member };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(WORKSPACE_ID);
  await db
    .prepare('DELETE FROM contact_external_identities WHERE workspace_id=?')
    .run(WORKSPACE_ID);
  await db.prepare('DELETE FROM capture_source_secrets WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM capture_sources WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM contacts WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('lead capture API surface', () => {
  it('requires a session and keeps credential-changing source management owner-only', async () => {
    await request(app).get('/api/capture-sources').expect(401);
    await request(app)
      .post('/api/capture-sources')
      .send({ name: 'Unauthorized', kind: 'website' })
      .expect(401);

    const { owner, member } = await ownerAndMember();
    const created = await owner.agent
      .post('/api/capture-sources')
      .send({ name: 'Owner source', kind: 'form' })
      .expect(201);
    const sourceId = created.body.source.id as string;
    await member.agent.get('/api/capture-sources').expect(200);
    await member.agent.get(`/api/capture-sources/${sourceId}`).expect(200);
    await member.agent
      .post('/api/capture-sources')
      .send({ name: 'Nope', kind: 'website' })
      .expect(403);
    await member.agent
      .patch(`/api/capture-sources/${sourceId}/status`)
      .send({ status: 'disabled' })
      .expect(403);
    await member.agent.post(`/api/capture-sources/${sourceId}/rotate`).expect(403);
  });

  it('creates and lists a workspace-owned source without ever listing its secret', async () => {
    const created = await authed()
      .post('/api/capture-sources')
      .send({ name: 'Website', kind: 'website' })
      .expect(201);
    expect(created.body.source).toMatchObject({ name: 'Website', status: 'active' });
    expect(created.body.secret).toMatch(/^trv_capture_/);

    const list = await authed().get('/api/capture-sources').expect(200);
    expect(list.body.sources).toHaveLength(1);
    expect(JSON.stringify(list.body.sources)).not.toContain(created.body.secret);
    await authed().get(`/api/capture-sources/${created.body.source.id}`).expect(200);

    const sealed = await db
      .prepare(
        'SELECT ciphertext FROM capture_source_secrets WHERE workspace_id=? AND capture_source_id=? AND slot=?'
      )
      .get<{ ciphertext: Buffer }>(WORKSPACE_ID, created.body.source.id, 'active');
    expect(sealed).toBeTruthy();
    expect(Buffer.from(sealed!.ciphertext).toString('utf8')).not.toContain(created.body.secret);
    const events = await db
      .prepare(
        'SELECT actor_type,actor_id,payload_json FROM domain_events WHERE workspace_id=? AND stream_id=?'
      )
      .all<{ actor_type: string; actor_id: string; payload_json: unknown }>(
        WORKSPACE_ID,
        created.body.source.id
      );
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ actor_type: 'human', actor_id: USER_ID })])
    );
    expect(JSON.stringify(events)).not.toContain(created.body.secret);
  });

  it('accepts the source secret through the real app before the JSON parser and exposes inbound reads', async () => {
    const list = await authed().get('/api/capture-sources').expect(200);
    const sourceId = list.body.sources[0].id as string;
    const rotated = await authed().post(`/api/capture-sources/${sourceId}/rotate`).expect(200);
    const secret = rotated.body.secret as string;
    const raw = JSON.stringify({
      kind: 'contact_message',
      person: { name: 'API Person', email: 'api-person@example.com' },
      message: 'Hello from the real app route.'
    });
    const accepted = await signedRequest(sourceId, secret, 'api-route-001', raw).expect(202);
    expect(accepted.body.personId).toMatch(/^con_/);

    const people = await authed().get('/api/inbound/people').expect(200);
    expect(people.body.people).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'api-person@example.com' })])
    );
    const submissions = await authed().get('/api/inbound/submissions').expect(200);
    expect(submissions.body.submissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'contact_message' })])
    );
  });

  it('disables a source immediately and keeps status management workspace-scoped', async () => {
    const list = await authed().get('/api/capture-sources').expect(200);
    const source = list.body.sources[0] as { id: string };
    const disabled = await authed()
      .patch(`/api/capture-sources/${source.id}/status`)
      .send({ status: 'disabled' })
      .expect(200);
    expect(disabled.body.source.status).toBe('disabled');
    await authed()
      .patch(`/api/capture-sources/${source.id}/status`)
      .send({ status: 'active' })
      .expect(200);
  });

  it('creates, lists, and lifts workspace GTM suppressions', async () => {
    const created = await authed()
      .post('/api/suppressions')
      .send({
        channel: 'email',
        email: 'suppressed@example.com',
        reason: 'Operator requested no email'
      })
      .expect(201);
    expect(created.body.suppression).toMatchObject({
      channel: 'email',
      email: 'suppressed@example.com',
      source: 'manual'
    });

    const listed = await authed().get('/api/suppressions').expect(200);
    expect(listed.body.suppressions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.suppression.id })])
    );

    await authed().delete(`/api/suppressions/${created.body.suppression.id}`).expect(200);
    const after = await authed().get('/api/suppressions').expect(200);
    expect(after.body.suppressions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.suppression.id })])
    );
  });

  it('returns 413 for an oversized public capture payload rather than a generic 500', async () => {
    const list = await authed().get('/api/capture-sources').expect(200);
    const sourceId = list.body.sources[0].id as string;
    const rotated = await authed().post(`/api/capture-sources/${sourceId}/rotate`).expect(200);
    const secret = rotated.body.secret as string;
    const raw = JSON.stringify({
      kind: 'contact_message',
      person: { email: 'huge@example.com' },
      message: 'x'.repeat(140 * 1024)
    });
    await signedRequest(sourceId, secret, 'api-huge-001', raw).expect(413);
  });
});
