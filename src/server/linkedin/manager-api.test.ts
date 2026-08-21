import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, workspaceId, NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
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
  await clear(A);
  await clear(B);
  tokenA = await session(A);
  tokenB = await session(B);
  await upsertSeat(
    db,
    A,
    { label: 'Owner A', timezone: 'Europe/Zurich' },
    new Date('2026-06-01T09:00:00Z')
  );
  await upsertSeat(
    db,
    B,
    { label: 'Owner B', timezone: 'Europe/Zurich' },
    new Date('2026-06-01T09:00:00Z')
  );
});
afterEach(async () => db?.close());

describe('LinkedIn manager HTTP surface', () => {
  it('requires a Trevra session', async () => {
    await request(app).get('/api/linkedin/manager/lead-lists').expect(401);
    await request(app).get('/api/linkedin/manager/analytics').expect(401);
  });

  it('keeps list/workflow/campaign read models workspace-scoped', async () => {
    const listA = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'A leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await as(tokenB)
      .post('/api/linkedin/manager/lead-lists')
      .send({ name: 'B leads', sourceKind: 'csv' })
      .expect(201);
    const listsA = (await as(tokenA).get('/api/linkedin/manager/lead-lists').expect(200)).body
      .lists as Array<{ id: string; name: string }>;
    expect(listsA.map((list) => list.name)).toEqual(['A leads']);
    await as(tokenB).get(`/api/linkedin/manager/lead-lists/${listA.id}/contacts`).expect(404);
  });

  it('previews and automatches CSV without persisting a contact', async () => {
    const csv = Buffer.from(
      'First Name,Last Name,Company,Email\nDr. Maya,Smith,Acme,maya@acme.test\n'
    );
    const body = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists/preview')
        .attach('file', csv, { filename: 'leads.csv', contentType: 'text/csv' })
        .expect(200)
    ).body;
    expect(body.acceptedCount).toBe(1);
    expect(body.mapping).toMatchObject({
      firstName: 'First Name',
      lastName: 'Last Name',
      company: 'Company'
    });
    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=?')
      .get<{ total: number }>(A);
    expect(count?.total ?? 0).toBe(0);
  });

  it('supports strict reusable workflow CRUD and rejects unsupported variables', async () => {
    const valid = {
      name: 'Founder flow',
      steps: [
        {
          id: 'invite',
          action: 'connection_request',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { message: 'Hi {{first_name}}' }
        },
        {
          id: 'msg',
          action: 'message',
          delayBefore: { amount: 2, unit: 'days' },
          config: {
            variants: [
              { id: 'a', body: 'Hi {{first_name}}', weight: 50 },
              { id: 'b', body: 'Hey {{first_name}} at {{company}}', weight: 50 }
            ]
          }
        }
      ]
    };
    const created = (
      await as(tokenA).post('/api/linkedin/manager/workflows').send(valid).expect(201)
    ).body.workflow;
    expect(created.version).toBe(1);
    const updated = (
      await as(tokenA)
        .put(`/api/linkedin/manager/workflows/${created.id}`)
        .send({ ...valid, name: 'Founder flow v2' })
        .expect(200)
    ).body.workflow;
    expect(updated.version).toBe(2);
    await as(tokenA)
      .post('/api/linkedin/manager/workflows')
      .send({
        name: 'bad',
        steps: [
          {
            id: 'invite',
            action: 'connection_request',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { message: 'Hi {{job_title}}' }
          }
        ]
      })
      .expect(400);
  });

  it('creates a campaign draft with enrollment but zero ledger actions', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Campaign leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      {
        workspaceId: A,
        listId: list.id,
        csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/maya-smith\n'
      },
      NOW
    );
    const workflow = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Draft flow',
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
    const result = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'Draft campaign', leadListId: list.id, workflowId: workflow.id })
        .expect(201)
    ).body;
    expect(result.enrolled).toBe(1);
    expect(result.campaign.status).toBe('draft');
    const actions = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?'
      )
      .get<{ total: number }>(A, result.campaign.id);
    expect(actions?.total ?? 0).toBe(0);
  });

  it('accepts only signed provider email events and applies reply stop exactly once', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Email event leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      {
        workspaceId: A,
        listId: list.id,
        csv: 'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-email-event\n'
      },
      NOW
    );
    const workflow = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Email event flow',
          steps: [
            {
              id: 'email',
              action: 'email',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {
                subject: 'Hello',
                variants: [{ id: 'a', body: 'Hi {{first_name}}', weight: 100 }],
                threaded: true,
                tracking: 'off'
              }
            }
          ]
        })
        .expect(201)
    ).body.workflow;
    const campaign = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'Email event campaign', leadListId: list.id, workflowId: workflow.id })
        .expect(201)
    ).body.campaign;
    const member = await db
      .prepare(
        'SELECT id,contact_id FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? LIMIT 1'
      )
      .get<{ id: string; contact_id: string }>(A, campaign.id);
    expect(member).toBeDefined();
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
         VALUES ('licha_signed',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'signed-event-idem',?::timestamptz,'provider-message-42','gmail',?::timestamptz,?::timestamptz)`
      )
      .run(
        A,
        campaign.id,
        member!.id,
        member!.contact_id,
        'email',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,source,replay_scope,created_at)
         VALUES ('lact_after_email',?,'owner','dm','https://linkedin.com/in/maya-email-event','planned',?::timestamptz,?,?,'campaign','after-email',?::timestamptz)`
      )
      .run(
        A,
        new Date(NOW.getTime() + 3_600_000).toISOString(),
        campaign.id,
        member!.id,
        NOW.toISOString()
      );

    const oldSecret = process.env.LINKEDIN_CAMPAIGN_EMAIL_WEBHOOK_SECRET;
    process.env.LINKEDIN_CAMPAIGN_EMAIL_WEBHOOK_SECRET = 'provider-test-secret';
    const body = JSON.stringify({
      workspaceId: A,
      externalRef: 'provider-message-42',
      eventKind: 'reply',
      providerEventId: 'provider-event-42',
      occurredAt: NOW.toISOString()
    });
    try {
      await request(app)
        .post('/api/webhooks/linkedin-campaign-email')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401);
      const signature = createHmac('sha256', 'provider-test-secret').update(body).digest('hex');
      const first = await request(app)
        .post('/api/webhooks/linkedin-campaign-email')
        .set('Content-Type', 'application/json')
        .set('x-trevra-signature', `sha256=${signature}`)
        .send(body)
        .expect(202);
      expect(first.body).toMatchObject({ recorded: true, memberId: member!.id });
      const replay = await request(app)
        .post('/api/webhooks/linkedin-campaign-email')
        .set('Content-Type', 'application/json')
        .set('x-trevra-signature', `sha256=${signature}`)
        .send(body)
        .expect(200);
      expect(replay.body).toMatchObject({ recorded: false, memberId: member!.id });
    } finally {
      if (oldSecret === undefined) delete process.env.LINKEDIN_CAMPAIGN_EMAIL_WEBHOOK_SECRET;
      else process.env.LINKEDIN_CAMPAIGN_EMAIL_WEBHOOK_SECRET = oldSecret;
    }
    expect(
      (
        await db
          .prepare('SELECT status FROM linkedin_campaign_members WHERE id=?')
          .get<{ status: string }>(member!.id)
      )?.status
    ).toBe('replied');
    expect(
      (
        await db
          .prepare("SELECT status FROM linkedin_actions WHERE id='lact_after_email'")
          .get<{ status: string }>()
      )?.status
    ).toBe('skipped');
  });

  it('reports the missing LinkedIn account as a 400, not a 500, when creating a campaign before one is connected', async () => {
    const workspaceId = 'ws_li_manager_api_no_seat';
    const token = await session(workspaceId);
    const list = (
      await as(token)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'No seat leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      { workspaceId, listId: list.id, csv: 'First Name,Last Name,Company\nMaya,Smith,Acme\n' },
      NOW
    );
    const workflow = (
      await as(token)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'No seat flow',
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
    const body = (
      await as(token)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'No seat campaign', leadListId: list.id, workflowId: workflow.id })
        .expect(400)
    ).body;
    expect(body.error).toMatch(/not configured/i);
  });

  it('stores additional seat configuration separately from the owner seat', async () => {
    const second = (
      await as(tokenA)
        .post('/api/linkedin/manager/seats')
        .send({
          seatKey: 'founder-eu',
          label: 'Founder EU',
          timezone: 'Europe/Zurich',
          workingDays: [1, 2, 3, 4, 5],
          workStartMinute: 540,
          workEndMinute: 1020,
          dailyInviteLimit: 20,
          dailyMessageLimit: 15,
          dailyProfileViewLimit: 20,
          dailyFollowLimit: 10
        })
        .expect(201)
    ).body.seat;
    expect(second.seatKey).toBe('founder-eu');
    const seats = (await as(tokenA).get('/api/linkedin/manager/seats').expect(200)).body
      .seats as Array<{ seatKey: string }>;
    expect(seats.map((seat) => seat.seatKey).sort()).toEqual(['founder-eu', 'owner']);
    expect(
      (await as(tokenB).get('/api/linkedin/manager/seats').expect(200)).body.seats
    ).toHaveLength(1);
  });

  it('requires an active campaign to be stopped before it can be deleted', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Delete lifecycle', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    const workflow = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Delete lifecycle flow',
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
    const campaign = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'Delete lifecycle', leadListId: list.id, workflowId: workflow.id })
        .expect(201)
    ).body.campaign;

    await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${campaign.id}/start`)
      .send({})
      .expect(200);
    const refused = await as(tokenA)
      .delete(`/api/linkedin/manager/campaigns/${campaign.id}`)
      .expect(409);
    expect(refused.body.error).toMatch(/stop it first/i);

    await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${campaign.id}/stop`)
      .send({})
      .expect(200);
    await as(tokenA).delete(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200);
    await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(404);
  });

  it('only exposes safety-reducing member controls and releases the active lead claim on remove', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Safe controls', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      {
        workspaceId: A,
        listId: list.id,
        csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/safe-maya\n'
      },
      NOW
    );
    const workflow = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Safe flow',
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
    const campaign = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'Safety controls', leadListId: list.id, workflowId: workflow.id })
        .expect(201)
    ).body.campaign;
    const detail = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)
    ).body;
    const member = detail.members[0];
    await as(tokenA).post(`/api/linkedin/manager/members/${member.id}/pause`).send({}).expect(200);
    const paused = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)
    ).body.members[0];
    expect(paused.status).toBe('paused');
    await as(tokenA).delete(`/api/linkedin/manager/members/${member.id}`).expect(200);
    const removed = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaign.id}`).expect(200)
    ).body.members[0];
    expect(removed.status).toBe('removed');
  });

  it('previews launch capacity and exposes wave, queue, control, duplicate, and member timeline operations', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Wave controls', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      {
        workspaceId: A,
        listId: list.id,
        csv: 'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/wave-maya\nNoah,Jones,Beta,https://linkedin.com/in/wave-noah\n'
      },
      NOW
    );
    const flow = {
      name: 'Wave graph',
      steps: [
        {
          id: 'view',
          action: 'profile_view',
          delayBefore: { amount: 0, unit: 'hours' },
          nextStepId: 'end',
          config: {}
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ]
    };
    const validation = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows/validate')
        .send({ steps: flow.steps })
        .expect(200)
    ).body;
    expect(validation).toMatchObject({ valid: true, issues: [] });
    const workflow = (
      await as(tokenA).post('/api/linkedin/manager/workflows').send(flow).expect(201)
    ).body.workflow;
    const preview = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns/preview')
        .send({
          leadListId: list.id,
          workflowId: workflow.id,
          admissionPolicy: { maxWaveSize: 1 }
        })
        .expect(200)
    ).body.preview;
    expect(preview.audience).toBe(2);
    expect(preview.firstWaveSize).toBe(1);
    expect(preview.dayOneCapacity.profile_view).toBeGreaterThan(0);

    const created = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({
          name: 'Wave operations',
          leadListId: list.id,
          workflowId: workflow.id,
          priority: 'high',
          admissionPolicy: { maxWaveSize: 1 }
        })
        .expect(201)
    ).body;
    expect(created.campaign.pendingCount).toBe(2);
    const campaignId = created.campaign.id as string;
    await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${campaignId}/start`)
      .send({})
      .expect(200);
    await as(tokenA).post('/api/linkedin/manager/tick').send({}).expect(200);

    const operations = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaignId}/operations`).expect(200)
    ).body;
    expect(operations.queues.pending).toBe(1);
    expect(operations.queues.allocatedCampaignDay.profile_view).toBe(1);
    expect(
      operations.queues.queuedReady +
        operations.queues.scheduledFuture +
        operations.queues.executing
    ).toBe(1);
    const activeMember = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaignId}`).expect(200)
    ).body.members.find((value: { waveId: string | null }) => value.waveId);
    expect(activeMember.lastAction).toMatchObject({ kind: 'profile_view', status: 'planned' });
    expect(activeMember.lastAction.plannedFor).toEqual(expect.any(String));
    expect(operations.waves).toHaveLength(1);
    expect(operations.waves[0]).toMatchObject({ ordinal: 1, memberCount: 1 });
    expect(operations.waves[0].stepFunnel[0]).toMatchObject({ stepId: 'view', planned: 1 });

    await as(tokenA)
      .patch(`/api/linkedin/manager/campaigns/${campaignId}/controls`)
      .send({ priority: 'low' })
      .expect(200);
    await as(tokenA)
      .patch(`/api/linkedin/manager/campaigns/${campaignId}/controls`)
      .send({ admissionPolicy: { maxWaveSize: 2 } })
      .expect(409);
    await as(tokenA)
      .post(`/api/linkedin/manager/campaigns/${campaignId}/pause`)
      .send({})
      .expect(200);
    const controls = (
      await as(tokenA)
        .patch(`/api/linkedin/manager/campaigns/${campaignId}/controls`)
        .send({
          admissionPolicy: { maxWaveSize: 2, minWaveIntervalMinutes: 30 },
          schedule: { workingDays: [1, 2, 3, 4, 5], workStartMinute: 540, workEndMinute: 1020 }
        })
        .expect(200)
    ).body.campaign;
    expect(controls.admissionPolicy.maxWaveSize).toBe(2);
    expect(controls.schedule.workingDays).toEqual([1, 2, 3, 4, 5]);

    const member = (
      await as(tokenA).get(`/api/linkedin/manager/campaigns/${campaignId}`).expect(200)
    ).body.members.find((value: { waveId: string | null }) => value.waveId);
    const timeline = (
      await as(tokenA).get(`/api/linkedin/manager/members/${member.id}/timeline`).expect(200)
    ).body;
    expect(timeline.events.some((event: { kind: string }) => event.kind === 'wave')).toBe(true);
    expect(timeline.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action',
          stepId: 'view',
          stepLabel: 'profile view',
          senderKey: 'owner'
        })
      ])
    );
    await as(tokenA).post(`/api/linkedin/manager/members/${member.id}/skip`).send({}).expect(200);

    const duplicate = (
      await as(tokenA)
        .post(`/api/linkedin/manager/campaigns/${campaignId}/duplicate`)
        .send({ name: 'Wave copy' })
        .expect(201)
    ).body;
    expect(duplicate.campaign).toMatchObject({ name: 'Wave copy', status: 'draft' });
    expect(duplicate.campaign.id).not.toBe(campaignId);
  });
});
