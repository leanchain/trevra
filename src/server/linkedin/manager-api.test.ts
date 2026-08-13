import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { importLeadCsv } from './lead-lists.js';
import { upsertSeat } from './seats.js';

let db: Db;
let app: Express;
const A = 'ws_li_manager_api_a';
const B = 'ws_li_manager_api_b';
const NOW = new Date('2026-08-13T09:00:00.000Z');
let tokenA = '';
let tokenB = '';

async function session(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING').run(workspaceId, workspaceId, NOW.toISOString());
  await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING').run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), userId, new Date(Date.now() + 86_400_000).toISOString(), NOW.toISOString());
  return token;
}

function as(token: string) {
  const cookie = `trevra_session=${token}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    patch: (path: string) => request(app).patch(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie),
    delete: (path: string) => request(app).delete(path).set('Cookie', cookie)
  };
}

async function clear(workspaceId: string) {
  await db.prepare('DELETE FROM linkedin_manual_tasks WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_campaign_members WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_workflows WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_lead_contacts WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_lead_lists WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(workspaceId);
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await clear(A); await clear(B);
  tokenA = await session(A); tokenB = await session(B);
  await upsertSeat(db, A, { label: 'Owner A', timezone: 'Europe/Zurich' }, new Date('2026-06-01T09:00:00Z'));
  await upsertSeat(db, B, { label: 'Owner B', timezone: 'Europe/Zurich' }, new Date('2026-06-01T09:00:00Z'));
});
afterEach(async () => db?.close());

describe('LinkedIn manager HTTP surface', () => {
  it('requires a Trevra session', async () => {
    await request(app).get('/api/linkedin/manager/lead-lists').expect(401);
    await request(app).get('/api/linkedin/manager/analytics').expect(401);
  });

  it('keeps list/workflow/campaign read models workspace-scoped', async () => {
    const listA = (await as(tokenA).post('/api/linkedin/manager/lead-lists').send({ name: 'A leads', sourceKind: 'csv' }).expect(201)).body.list;
    await as(tokenB).post('/api/linkedin/manager/lead-lists').send({ name: 'B leads', sourceKind: 'csv' }).expect(201);
    const listsA = (await as(tokenA).get('/api/linkedin/manager/lead-lists').expect(200)).body.lists as Array<{ id: string; name: string }>;
    expect(listsA.map((list) => list.name)).toEqual(['A leads']);
    await as(tokenB).get(`/api/linkedin/manager/lead-lists/${listA.id}/contacts`).expect(404);
  });

  it('previews and automatches CSV without persisting a contact', async () => {
    const csv = Buffer.from('First Name,Last Name,Company,Email\nDr. Maya,Smith,Acme,maya@acme.test\n');
    const body = (await as(tokenA).post('/api/linkedin/manager/lead-lists/preview').attach('file', csv, { filename: 'leads.csv', contentType: 'text/csv' }).expect(200)).body;
    expect(body.acceptedCount).toBe(1);
    expect(body.mapping).toMatchObject({ firstName: 'First Name', lastName: 'Last Name', company: 'Company' });
    const count = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=?').get<{ total: number }>(A);
    expect(count?.total ?? 0).toBe(0);
  });

  it('supports strict reusable workflow CRUD and rejects unsupported variables', async () => {
    const valid = {
      name: 'Founder flow',
      steps: [
        { id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{first_name}}' } },
        { id: 'msg', action: 'message', delayBefore: { amount: 2, unit: 'days' }, config: { variants: [{ id: 'a', body: 'Hi {{first_name}}', weight: 50 }, { id: 'b', body: 'Hey {{first_name}} at {{company}}', weight: 50 }] } }
      ]
    };
    const created = (await as(tokenA).post('/api/linkedin/manager/workflows').send(valid).expect(201)).body.workflow;
    expect(created.version).toBe(1);
    const updated = (await as(tokenA).put(`/api/linkedin/manager/workflows/${created.id}`).send({ ...valid, name: 'Founder flow v2' }).expect(200)).body.workflow;
    expect(updated.version).toBe(2);
    await as(tokenA).post('/api/linkedin/manager/workflows').send({ name: 'bad', steps: [{ id: 'invite', action: 'connection_request', delayBefore: { amount: 0, unit: 'hours' }, config: { message: 'Hi {{job_title}}' } }] }).expect(400);
  });

  it('creates a campaign draft with enrollment but zero ledger actions', async () => {
    const list = (await as(tokenA).post('/api/linkedin/manager/lead-lists').send({ name: 'Campaign leads', sourceKind: 'csv' }).expect(201)).body.list;
    await importLeadCsv(db, { workspaceId: A, listId: list.id, csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/maya-smith\n' }, NOW);
    const workflow = (await as(tokenA).post('/api/linkedin/manager/workflows').send({ name: 'Draft flow', steps: [{ id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} }] }).expect(201)).body.workflow;
    const result = (await as(tokenA).post('/api/linkedin/manager/campaigns').send({ name: 'Draft campaign', leadListId: list.id, workflowId: workflow.id }).expect(201)).body;
    expect(result.enrolled).toBe(1);
    expect(result.campaign.status).toBe('draft');
    const actions = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?').get<{ total: number }>(A, result.campaign.id);
    expect(actions?.total ?? 0).toBe(0);
  });

  it('stores additional seat configuration separately from the owner seat', async () => {
    const second = (await as(tokenA).post('/api/linkedin/manager/seats').send({ seatKey: 'founder-eu', label: 'Founder EU', timezone: 'Europe/Zurich', workingDays: [1,2,3,4,5], workStartMinute: 540, workEndMinute: 1020, dailyInviteLimit: 20, dailyMessageLimit: 15, dailyProfileViewLimit: 20, dailyFollowLimit: 10 }).expect(201)).body.seat;
    expect(second.seatKey).toBe('founder-eu');
    const seats = (await as(tokenA).get('/api/linkedin/manager/seats').expect(200)).body.seats as Array<{ seatKey: string }>;
    expect(seats.map((seat) => seat.seatKey).sort()).toEqual(['founder-eu', 'owner']);
    expect((await as(tokenB).get('/api/linkedin/manager/seats').expect(200)).body.seats).toHaveLength(1);
  });

  it('only exposes safety-reducing member controls and releases the active lead claim on remove', async () => {
    const list = (await as(tokenA).post('/api/linkedin/manager/lead-lists').send({ name: 'Safe controls', sourceKind: 'csv' }).expect(201)).body.list;
    await importLeadCsv(db, { workspaceId: A, listId: list.id, csv: 'First Name,Last Name,Company\nMaya,Smith,Acme\n' }, NOW);
    const workflow = (await as(tokenA).post('/api/linkedin/manager/workflows').send({ name: 'Safe flow', steps: [{ id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} }] }).expect(201)).body.workflow;
    const campaign = (await as(tokenA).post('/api/linkedin/manager/campaigns').send({ name: 'Safety controls', leadListId: list.id, workflowId: workflow.id }).expect(201)).body.campaign;
    const detail = (await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)).body;
    const member = detail.members[0];
    await as(tokenA).post(`/api/linkedin/manager/members/${member.id}/pause`).send({}).expect(200);
    const paused = (await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)).body.members[0];
    expect(paused.status).toBe('paused');
    await as(tokenA).delete(`/api/linkedin/manager/members/${member.id}`).expect(200);
    const removed = (await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)).body.members[0];
    expect(removed.status).toBe('removed');
  });
});
