import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  campaignMemberTimeline,
  createManagedCampaign,
  listCampaignMembers,
  startManagedCampaign
} from './managed-campaigns.js';
import {
  assertSafeCampaignDestination,
  recordCampaignEmailEvent,
  runCampaignChannelActions
} from './campaign-channels.js';
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

async function campaignFor(
  steps: Parameters<typeof saveWorkflow>[1]['steps'],
  csv: string,
  options: { enrichmentCreditCap?: number | null } = {}
) {
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
      admissionPolicy: { maxWaveSize: 10 },
      enrichmentCreditCap: options.enrichmentCreditCap
    },
    NOW
  );
  await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
  return created.campaign.id;
}

describe('campaign destination safety', () => {
  it('rejects insecure, credentialed, and private destinations outside the test-local exception', async () => {
    await expect(
      assertSafeCampaignDestination('http://example.com/hook', { allowLocalTest: false })
    ).rejects.toThrow(/HTTPS/i);
    await expect(
      assertSafeCampaignDestination('https://user:pass@example.com/hook', { allowLocalTest: false })
    ).rejects.toThrow(/credentials/i);
    await expect(
      assertSafeCampaignDestination('https://127.0.0.1/hook', { allowLocalTest: false })
    ).rejects.toThrow(/private|reserved/i);
    await expect(
      assertSafeCampaignDestination('https://169.254.169.254/latest/meta-data', {
        allowLocalTest: false
      })
    ).rejects.toThrow(/private|reserved/i);
  });
});

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
    const timeline = await campaignMemberTimeline(db, WORKSPACE, member.id);
    expect(timeline?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'channel',
          label: 'find email',
          stepId: 'find',
          stepLabel: 'find email',
          status: 'sent'
        })
      ])
    );

    await runManagedCampaigns(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('completed');
    const count = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=?`
      )
      .get<{ total: number }>(WORKSPACE, campaignId);
    expect(count?.total).toBe(1);
  });

  it('reserves enrichment credits exactly once and blocks before the provider when the campaign cap is exhausted', async () => {
    let hits = 0;
    let server: Server | null = null;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        hits += 1;
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            email: `found${hits}@example.com`,
            confidence: 0.91,
            verificationStatus: 'verified'
          })
        );
      }).listen(0, '127.0.0.1', () => {
        const address = server!.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const previousUrl = process.env.TREVRA_EMAIL_ENRICHMENT_URL;
    process.env.TREVRA_EMAIL_ENRICHMENT_URL = `http://127.0.0.1:${port}/enrich`;
    try {
      const campaignId = await campaignFor(
        [
          {
            id: 'find',
            action: 'find_email',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { providerId: 'test', refresh: false }
          },
          {
            id: 'end',
            action: 'end',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { outcome: 'completed' }
          }
        ],
        'First Name,Last Name,Company,LinkedIn URL\nMaya,One,Acme,https://linkedin.com/in/maya-one\nJon,Two,Acme,https://linkedin.com/in/jon-two\n',
        { enrichmentCreditCap: 1 }
      );
      await runManagedCampaigns(db, WORKSPACE, NOW);
      expect(hits).toBe(1);
      const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
      expect(run.sent).toBe(0);
      expect(run.failed).toBe(0);
      const rows = await db
        .prepare(
          `SELECT status,credits_used,last_error FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email' ORDER BY id`
        )
        .all<{ status: string; credits_used: number; last_error: string | null }>(
          WORKSPACE,
          campaignId
        );
      expect(rows.map((row) => Number(row.credits_used)).sort()).toEqual([0, 1]);
      expect(
        rows.some(
          (row) => row.status === 'failed' && /credit cap reached/i.test(row.last_error ?? '')
        )
      ).toBe(true);
      const enriched = await db
        .prepare(
          `SELECT email,email_provenance,email_confidence,email_verification_status FROM linkedin_lead_contacts WHERE workspace_id=? AND email IS NOT NULL`
        )
        .all<{
          email: string;
          email_provenance: string | null;
          email_confidence: number | null;
          email_verification_status: string | null;
        }>(WORKSPACE);
      expect(enriched).toHaveLength(1);
      expect(enriched[0].email_provenance).toBe('enriched');
      expect(Number(enriched[0].email_confidence)).toBeCloseTo(0.91);
      expect(enriched[0].email_verification_status).toBe('verified');
      await runCampaignChannelActions(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
      expect(hits).toBe(1);
    } finally {
      if (previousUrl === undefined) delete process.env.TREVRA_EMAIL_ENRICHMENT_URL;
      else process.env.TREVRA_EMAIL_ENRICHMENT_URL = previousUrl;
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
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

  it('executes an approved remote handoff exactly once for CRM/list/sequencer actions', async () => {
    let hits = 0;
    let captured: Record<string, unknown> = {};
    let idempotency = '';
    let server: Server | null = null;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        hits += 1;
        idempotency = String(req.headers['x-trevra-idempotency-key'] ?? '');
        let body = '';
        req.on('data', (chunk) => (body += String(chunk)));
        req.on('end', () => {
          captured = JSON.parse(body) as Record<string, unknown>;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ provider: 'acme-crm', externalRef: 'contact_42' }));
        });
      }).listen(0, '127.0.0.1', () => {
        const address = server!.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const oldAdapters = process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON;
    const oldToken = process.env.TEST_CRM_ACTION_TOKEN;
    process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON = JSON.stringify([
      {
        actionType: 'acme.crm.update',
        endpoint: `http://127.0.0.1:${port}/action`,
        tokenEnv: 'TEST_CRM_ACTION_TOKEN',
        provider: 'acme-crm'
      }
    ]);
    process.env.TEST_CRM_ACTION_TOKEN = 'test-secret';
    try {
      const campaignId = await campaignFor(
        [
          {
            id: 'handoff',
            action: 'external_handoff',
            delayBefore: { amount: 0, unit: 'hours' },
            config: {
              provider: 'remote_action',
              destination: 'acme.crm.update',
              payloadTemplate: '{"stage":"qualified","lead":"{{first_name}}"}'
            }
          },
          {
            id: 'end',
            action: 'end',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { outcome: 'completed' }
          }
        ],
        'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Acme,https://linkedin.com/in/maya-crm\n'
      );
      await runManagedCampaigns(db, WORKSPACE, NOW);
      expect(hits).toBe(1);
      expect(idempotency).toMatch(/^[a-f0-9]{64}$/);
      expect(captured).toMatchObject({
        actionType: 'acme.crm.update',
        workspaceId: WORKSPACE,
        payload: { stage: 'qualified', lead: 'Maya' }
      });
      const row = await db
        .prepare(
          `SELECT status,provider,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='external_handoff'`
        )
        .get<{ status: string; provider: string | null; external_ref: string | null }>(
          WORKSPACE,
          campaignId
        );
      expect(row).toMatchObject({
        status: 'sent',
        provider: 'acme-crm',
        external_ref: 'contact_42'
      });
      await runManagedCampaigns(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
      expect(hits).toBe(1);
    } finally {
      if (oldAdapters === undefined) delete process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON;
      else process.env.TREVRA_REMOTE_ACTION_ADAPTERS_JSON = oldAdapters;
      if (oldToken === undefined) delete process.env.TEST_CRM_ACTION_TOKEN;
      else process.env.TEST_CRM_ACTION_TOKEN = oldToken;
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
