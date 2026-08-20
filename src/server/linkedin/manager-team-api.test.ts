import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';

let db: Db;
let seq = 0;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
afterEach(async () => db?.close());

async function signUp(app: ReturnType<typeof createApp>, label: string) {
  seq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${seq}@team-parity.test`;
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: res.body.user.id as string, auth };
}

async function ownerAndMember(app: ReturnType<typeof createApp>) {
  const owner = await signUp(app, 'owner');
  const member = await signUp(app, 'member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  const memberAuth = (await member.agent.get('/api/auth/session').expect(200)).body.auth;
  expect(memberAuth.role).toBe('member');
  return { owner, member };
}

describe('managed campaign team ownership', () => {
  it('lets a teammate use only assigned senders and personal workflows while workspace templates stay owner-managed', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const { owner, member } = await ownerAndMember(app);

    const mateSeatResponse = await owner.agent.post('/api/linkedin/manager/seats').send({
      seatKey: 'mate-seat',
      label: 'Mate LinkedIn',
      timezone: 'Europe/Zurich',
      ownerUserId: member.userId
    });
    if (mateSeatResponse.status !== 201)
      console.error('seat assignment response', mateSeatResponse.status, mateSeatResponse.body);
    expect(mateSeatResponse.status).toBe(201);
    const mateSeat = mateSeatResponse.body.seat;
    expect(mateSeat.ownerUserId).toBe(member.auth.userId);

    await owner.agent
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'owner-seat', label: 'Owner LinkedIn', timezone: 'Europe/Zurich' })
      .expect(201);

    const list = (
      await member.agent
        .post('/api/linkedin/manager/lead-lists')
        .send({ seatKey: 'mate-seat', name: 'Mate leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;

    const personal = (
      await member.agent
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'My flow',
          scope: 'personal',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            }
          ]
        })
        .expect(201)
    ).body.workflow;
    expect(personal.scope).toBe('personal');
    expect(personal.ownerUserId).toBe(member.auth.userId);

    await member.agent
      .post('/api/linkedin/manager/workflows')
      .send({
        name: 'Workspace flow',
        scope: 'workspace',
        steps: [
          {
            id: 'view',
            action: 'profile_view',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {}
          }
        ]
      })
      .expect(403);

    const campaign = (
      await member.agent
        .post('/api/linkedin/manager/campaigns')
        .send({
          name: 'Assigned campaign',
          seatKey: 'mate-seat',
          leadListId: list.id,
          workflowId: personal.id
        })
        .expect(201)
    ).body.campaign;
    expect(campaign.ownerUserId).toBe(member.auth.userId);
    await member.agent
      .post(`/api/linkedin/manager/campaigns/${campaign.id}/start`)
      .send({})
      .expect(200);

    await member.agent
      .post('/api/linkedin/manager/campaigns')
      .send({
        name: 'Wrong sender',
        seatKey: 'owner-seat',
        leadListId: list.id,
        workflowId: personal.id
      })
      .expect(403);

    const audit = await db
      .prepare(
        'SELECT event_type,actor_id FROM audit_events WHERE workspace_id=? AND entity_id=? ORDER BY created_at'
      )
      .all<{ event_type: string; actor_id: string }>(owner.auth.workspaceId, campaign.id);
    expect(audit.map((row) => row.event_type)).toContain('linkedin_campaign.created');
    expect(audit.map((row) => row.event_type)).toContain('linkedin_campaign.started');
    expect(audit.every((row) => row.actor_id === member.auth.userId)).toBe(true);

    const exported = await member.agent
      .get(`/api/linkedin/manager/campaigns/${campaign.id}/export.csv`)
      .expect(200)
      .expect('Content-Type', /text\/csv/);
    expect(exported.text).toContain('first_name,last_name,company');
  });
});
