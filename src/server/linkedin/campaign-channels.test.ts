import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { findSuppression } from '../suppressions.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  campaignMemberTimeline,
  createManagedCampaign,
  listCampaignMembers,
  pauseManagedCampaign,
  startManagedCampaign,
  stopManagedCampaign
} from './managed-campaigns.js';
import {
  recordCampaignEmailEvent,
  recordCampaignEmailTrackingClick,
  recordCampaignEmailTrackingOpen,
  resolveCampaignChannelUnknownOutcome,
  runCampaignChannelActions,
  syncCampaignEmailProviderEvents
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
    'gtm_deliveries',
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
describe('campaign channel executor', () => {
  it('does not claim channel work while a campaign is paused and retires it on stop', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-paused-channel\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',admitted_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
          (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,outcome_known,created_at,updated_at)
         VALUES ('licha_pause',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'pause-key',TRUE,?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-fixture',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    await pauseManagedCampaign(db, WORKSPACE, campaignId, NOW);
    expect((await runCampaignChannelActions(db, WORKSPACE, NOW)).claimed).toBe(0);
    expect(
      await db
        .prepare(
          `SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id='licha_pause'`
        )
        .get<{ status: string }>(WORKSPACE)
    ).toEqual({ status: 'planned' });

    await stopManagedCampaign(db, WORKSPACE, campaignId, new Date(NOW.getTime() + 60_000));
    expect(
      await db
        .prepare(
          `SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id='licha_pause'`
        )
        .get<{ status: string }>(WORKSPACE)
    ).toEqual({ status: 'skipped' });
  });

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

  it('resolves an unknown channel outcome without replaying the side effect', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-unknown-channel\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    const channel = await db
      .prepare(
        `SELECT id FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND campaign_id=? AND workflow_step_id='find'`
      )
      .get<{ id: string }>(WORKSPACE, campaignId);
    expect(channel).toBeDefined();

    // Recreate the crash boundary: provider may have acted, but Trevra did not learn the outcome.
    await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status='unknown',outcome_known=FALSE,external_ref=NULL,provider=NULL,last_error='socket closed'
         WHERE workspace_id=? AND id=?`
      )
      .run(WORKSPACE, channel!.id);
    await db
      .prepare(
        `UPDATE linkedin_campaign_members
         SET step_index=0,current_step_id='find',completed_step_ids='[]'::jsonb,status='waiting',next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);

    const resolved = await resolveCampaignChannelUnknownOutcome(
      db,
      WORKSPACE,
      channel!.id,
      'sent',
      new Date(NOW.getTime() + 60_000)
    );
    expect(resolved.resolved).toBe(true);
    const settled = await db
      .prepare(
        `SELECT status,outcome_known,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?`
      )
      .get<{ status: string; outcome_known: boolean; external_ref: string | null }>(
        WORKSPACE,
        channel!.id
      );
    expect(settled).toMatchObject({
      status: 'sent',
      outcome_known: true,
      external_ref: 'operator-confirmed'
    });
    const after = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(after.stepIndex).toBe(1);
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

  it('turns a provider-observed email bounce into a durable email suppression', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'email',
          action: 'email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { variants: [{ id: 'a', body: 'Hi', weight: 100 }], subject: 'Hello' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,bounce-me@example.com,https://linkedin.com/in/maya-bounce\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
          (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
         VALUES ('licha_bounce',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-bounce',?::timestamptz,'mail-bounce','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const event = await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      {
        channelActionId: 'licha_bounce',
        eventKind: 'bounce',
        providerEventId: 'provider-bounce-1'
      },
      NOW
    );
    expect(event.recorded).toBe(true);
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'bounce-me@example.com' })
    ).toMatchObject({ reason: 'Email delivery hard-bounced', source: 'campaign_email_bounce' });
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
       VALUES ('licha_future',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'idem-future',?::timestamptz,?::timestamptz)`
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
      { channelActionId: 'licha_email', eventKind: 'reply', providerEventId: 'evt-reply' },
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

  it('never claims a channel action that is no longer the member current workflow node', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-stale-channel\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='end',step_index=1,next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
         VALUES ('licha_stale',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'stale-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'old-email-step',
        NOW.toISOString(),
        JSON.stringify({ recipient: 'maya@example.com', subject: 'Old', body: 'Do not send' }),
        NOW.toISOString(),
        NOW.toISOString()
      );

    expect((await runCampaignChannelActions(db, WORKSPACE, NOW)).claimed).toBe(0);
    expect(
      await db
        .prepare(`SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_stale'`)
        .get<{ status: string }>()
    ).toEqual({ status: 'planned' });
  });

  it('builds opaque tracking tokens and click mappings before an opted-in email is sent', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-track-send\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_demo_track',?,'gmail','trevra-gmail','demo-track','demo@example.com','connected',1,?::timestamptz,?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-live',step_index=0,next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
         VALUES ('licha_track_send',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'track-send-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-live',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@example.com',
          subject: 'Tracked email',
          body: 'See https://example.com/demo for details',
          tracking: 'opens_clicks',
          threaded: false
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run.sent).toBe(1);
    const action = await db
      .prepare(
        `SELECT status,tracking_token,connection_id FROM linkedin_campaign_channel_actions WHERE id='licha_track_send'`
      )
      .get<{ status: string; tracking_token: string | null; connection_id: string | null }>();
    expect(action?.status).toBe('sent');
    expect(action?.tracking_token).toMatch(/^lietrk_/);
    expect(action?.connection_id).toBe('conn_demo_track');
    const link = await db
      .prepare(
        `SELECT token,target_url FROM linkedin_campaign_email_tracking_links WHERE workspace_id=? AND channel_action_id='licha_track_send'`
      )
      .get<{ token: string; target_url: string }>(WORKSPACE);
    expect(link?.token).toMatch(/^lietl_/);
    expect(link?.target_url).toBe('https://example.com/demo');
  });

  it('records native tracking opens/clicks and resolves click redirects only from opaque token pairs', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-tracked\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,tracking_token,created_at,updated_at)
         VALUES ('licha_track',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'track-key',?::timestamptz,'mail-track','gmail','opaque-open-token',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-track-step',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_tracking_links
         (token,workspace_id,channel_action_id,target_url,created_at)
         VALUES ('opaque-link-token',?,'licha_track','https://example.com/demo',?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString());

    expect(await recordCampaignEmailTrackingOpen(db, 'opaque-open-token', NOW)).toBe(true);
    expect(
      await recordCampaignEmailTrackingClick(db, 'opaque-open-token', 'opaque-link-token', NOW)
    ).toBe('https://example.com/demo');
    expect(
      await recordCampaignEmailTrackingClick(db, 'wrong-token', 'opaque-link-token', NOW)
    ).toBeNull();
    const events = await db
      .prepare(
        `SELECT event_kind FROM linkedin_campaign_email_events WHERE workspace_id=? AND channel_action_id='licha_track' ORDER BY event_kind`
      )
      .all<{ event_kind: string }>(WORKSPACE);
    expect(events.map((row) => row.event_kind)).toEqual(['clicked', 'opened']);
    const refreshed = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(refreshed.branchState['external:email_opened']).toBe(true);
    expect(refreshed.branchState['external:email_clicked']).toBe(true);
  });

  it('polls mailbox thread telemetry automatically and a detected reply stops queued work', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-provider-reply\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_mail',?,'gmail','trevra-gmail','ext-mail','owner@example.com','connected',0,?::timestamptz,?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,connection_id,completed_at,external_ref,provider,created_at,updated_at)
         VALUES ('licha_provider',?,?,?,?,?,'email','sent',?::timestamptz,?::jsonb,'provider-key','conn_mail',?::timestamptz,'gmail-sent','gmail',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-provider-step',
        NOW.toISOString(),
        JSON.stringify({ recipient: 'maya@example.com' }),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,workflow_step_id,source,replay_scope,created_at)
         VALUES ('lact_after_email_reply',?,'owner','dm','https://linkedin.com/in/maya-provider-reply','planned',?::timestamptz,?,?, 'future-dm','campaign','future-reply',?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), campaignId, member.id, NOW.toISOString());

    const synced = await syncCampaignEmailProviderEvents(db, WORKSPACE, NOW, 50, async () => [
      {
        kind: 'reply',
        providerEventId: 'gmail:reply-1',
        occurredAt: '2026-08-20T09:01:00.000Z'
      }
    ]);
    expect(synced).toMatchObject({ checked: 1, replied: 1, bounced: 0, failed: 0 });
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('replied');
    expect(
      await db
        .prepare(`SELECT status FROM linkedin_actions WHERE id='lact_after_email_reply'`)
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
  });
});
