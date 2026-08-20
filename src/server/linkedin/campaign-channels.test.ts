import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  createManagedCampaign,
  listCampaignMembers,
  startManagedCampaign
} from './managed-campaigns.js';
import { recordCampaignEmailEvent, runCampaignChannelActions } from './campaign-channels.js';
import { runManagedCampaigns } from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

let db: Db;
const WORKSPACE = 'ws_campaign_channels_test';
const NOW = new Date('2026-08-20T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Channel tests', NOW.toISOString());
  for (const table of [
    'linkedin_campaign_email_events',
    'linkedin_campaign_channel_actions',
    'linkedin_actions',
    'linkedin_campaign_members',
    'linkedin_campaign_waves',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_list_members',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_seats'
  ]) {
    await db
      .prepare(`DELETE FROM ${table} WHERE workspace_id=?`)
      .run(WORKSPACE)
      .catch(() => undefined);
  }
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Owner', timezone: 'Europe/Zurich' },
    new Date('2026-01-01T09:00:00Z')
  );
});

afterEach(async () => db?.close());

async function campaignFor(steps: Parameters<typeof saveWorkflow>[1]['steps'], csv: string) {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Leads' }, NOW);
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  const workflow = await saveWorkflow(
    db,
    { workspaceId: WORKSPACE, name: 'Channel flow', steps },
    NOW
  );
  const created = await createManagedCampaign(
    db,
    {
      workspaceId: WORKSPACE,
      name: 'Channel campaign',
      leadListId: list.id,
      workflowId: workflow.id,
      admissionPolicy: { maxWaveSize: 10 }
    },
    NOW
  );
  await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
  return created.campaign.id;
}

describe('campaign channel executor', () => {
  it('uses an existing email without enrichment cost and advances the member exactly once', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: null, refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-smith\n'
    );

    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        `SELECT status,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND workflow_step_id='find'`
      )
      .get<{ status: string; external_ref: string | null }>(WORKSPACE, campaignId);
    expect(action).toMatchObject({ status: 'sent', external_ref: 'email:maya@example.com' });
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(member.stepIndex).toBe(1);
    expect(member.branchState['external:email_found']).toBe(true);

    await runManagedCampaigns(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('completed');
    const count = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=?`
      )
      .get<{ total: number }>(WORKSPACE, campaignId);
    expect(count?.total).toBe(1);
  });

  it('sends a webhook once with a stable idempotency key', async () => {
    let hits = 0;
    let idempotency = '';
    let server: Server | null = null;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        hits += 1;
        idempotency = String(req.headers['idempotency-key'] ?? '');
        req.resume();
        res.statusCode = 204;
        res.end();
      }).listen(0, '127.0.0.1', () => {
        const address = server!.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    try {
      const campaignId = await campaignFor(
        [
          {
            id: 'hook',
            action: 'webhook',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {
              url: `http://127.0.0.1:${port}/hook`,
              method: 'POST',
              bodyTemplate: '{"first":"{{first_name}}"}'
            }
          },
          {
            id: 'end',
            action: 'end',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { outcome: 'completed' }
          }
        ],
        'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/maya-smith\n'
      );
      await runManagedCampaigns(db, WORKSPACE, NOW);
      await runCampaignChannelActions(db, WORKSPACE, NOW);
      await runManagedCampaigns(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
      expect(hits).toBe(1);
      expect(idempotency).toMatch(/^[a-f0-9]{64}$/);
      const row = await db
        .prepare(
          `SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=?`
        )
        .get<{ status: string }>(WORKSPACE, campaignId);
      expect(row?.status).toBe('sent');
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it('an email reply stops LinkedIn and channel work for the same member', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-smith\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
       VALUES ('licha_email',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-email',?::timestamptz,'mail-ref','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-step',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,source,replay_scope,created_at)
       VALUES ('lact_future',?,'owner','dm','https://linkedin.com/in/maya-smith','planned',?::timestamptz,?,?, 'campaign','future',?::timestamptz)`
      )
      .run(
        WORKSPACE,
        new Date(NOW.getTime() + 3600000).toISOString(),
        campaignId,
        member.id,
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
       VALUES ('licha_future',?,?,?,?,?,'webhook','planned',?::timestamptz,'{}'::jsonb,'idem-future',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'hook-next',
        new Date(NOW.getTime() + 3600000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const event = await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      { channelActionId: 'licha_email', eventKind: 'replied', providerEventId: 'evt-reply' },
      NOW
    );
    expect(event.recorded).toBe(true);
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('replied');
    expect(
      (
        await db
          .prepare(`SELECT status FROM linkedin_actions WHERE id='lact_future'`)
          .get<{ status: string }>()
      )?.status
    ).toBe('skipped');
    expect(
      (
        await db
          .prepare(`SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_future'`)
          .get<{ status: string }>()
      )?.status
    ).toBe('skipped');
  });
});
