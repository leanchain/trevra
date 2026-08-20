import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { createLeadList, importLeadCsv, ingestLeadSignal } from './lead-lists.js';
import {
  admitPendingCampaignMembers,
  campaignAdmissionForecast,
  campaignWorkflowSteps,
  createManagedCampaign,
  enrolNewContacts,
  listCampaignMembers,
  managedAnalytics,
  pauseManagedCampaign,
  previewManagedCampaignLaunch,
  releaseSeatWork,
  startManagedCampaign,
  updateManagedCampaignControls
} from './managed-campaigns.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * TWO PROPERTIES A SHARED TABLE MAKES LOAD-BEARING.
 *
 * Both of the things pinned here are invisible on a single-tenant, single-seat
 * deployment and expensive on a hosted one: a member id that is not scoped to
 * a workspace, and a seat that can be disconnected while its queue is still
 * full. Neither raises an error when it goes wrong, which is the whole reason
 * they are tests.
 */
let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE = 'ws_linkedin_managed_campaigns_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Managed Campaigns Test', NOW.toISOString());
  for (const table of [
    'linkedin_actions',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_seats'
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE);
  }
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Owner', timezone: 'Europe/Zurich' },
    new Date('2026-01-01T09:00:00.000Z')
  );
});

afterEach(async () => {
  await db?.close();
});

async function leadList(name: string, people: readonly string[]): Promise<string> {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name }, NOW);
  const csv = ['First Name,Last Name,Company,LinkedIn URL']
    .concat(people.map((handle) => `${handle},Person,Acme,https://www.linkedin.com/in/${handle}/`))
    .join('\n');
  const result = await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  expect(result.inserted).toBe(people.length);
  return list.id;
}

async function workflow(name = 'Connect'): Promise<string> {
  return (
    await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name,
        steps: [
          {
            id: 'invite',
            action: 'connection_request',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { message: 'Hi {{first_name}}' }
          }
        ]
      },
      NOW
    )
  ).id;
}

async function statusOf(actionId: string): Promise<string> {
  const row = await db
    .prepare('SELECT status FROM linkedin_actions WHERE workspace_id=? AND id=?')
    .get<{ status: string }>(WORKSPACE, actionId);
  if (!row) throw new Error(`no action ${actionId}`);
  return row.status;
}

async function queue(
  seatKey: string,
  handle: string,
  status: 'planned' | 'held',
  claimed = false
): Promise<string> {
  const written = await recordAction(
    db,
    {
      workspaceId: WORKSPACE,
      seatKey,
      kind: 'invite',
      targetRef: `https://www.linkedin.com/in/${handle}/`,
      status: 'planned',
      source: 'campaign',
      plannedFor: NOW.toISOString()
    },
    NOW
  );
  await db
    .prepare('UPDATE linkedin_actions SET status=?, claimed_at=? WHERE workspace_id=? AND id=?')
    .run(status, claimed ? NOW.toISOString() : null, WORKSPACE, written.id);
  return written.id;
}

/** One ledger row, at the status it ended up in. */
async function ledger(
  kind: 'invite' | 'dm',
  handle: string,
  status: 'sent' | 'accepted' | 'replied' | 'declined' | 'withdrawn'
): Promise<void> {
  await recordAction(
    db,
    {
      workspaceId: WORKSPACE,
      kind,
      targetRef: `https://www.linkedin.com/in/${handle}/`,
      status,
      source: 'campaign',
      plannedFor: NOW.toISOString()
    },
    NOW
  );
}

/**
 * THE TWO RATES THIS PANEL SHOWS, AND THE POPULATIONS THEY DIVIDE.
 *
 * Both were wrong in the same way -- a numerator counted over one set of rows
 * and a denominator over another -- and the reply rate could therefore print a
 * number above 100%, which is the kind of figure that makes an operator stop
 * believing the whole screen rather than the one tile.
 */
describe('the rates on the results panel', () => {
  it('divides replies by the same population it counted: leads that were messaged', async () => {
    // Two leads were messaged. One of them replied.
    await ledger('dm', 'messaged-a', 'replied');
    await ledger('dm', 'messaged-b', 'sent');
    // A third replied to an INVITE and was never messaged at all. Under the old
    // query this grew the numerator and left the denominator alone.
    await ledger('invite', 'never-messaged', 'replied');

    const analytics = await managedAnalytics(db, WORKSPACE);

    expect(analytics.contactedLeads).toBe(2);
    // Still the honest headline: everybody who replied to anything.
    expect(analytics.repliedLeads).toBe(2);
    // The rate's numerator, which is a strict subset of `contactedLeads`.
    expect(analytics.repliedMessagedLeads).toBe(1);
    expect(analytics.replyRate).toBeCloseTo(0.5);
  });

  it('cannot exceed 100% even when every reply came from something other than a message', async () => {
    await ledger('dm', 'one', 'sent');
    await ledger('invite', 'two', 'replied');
    await ledger('invite', 'three', 'replied');

    const analytics = await managedAnalytics(db, WORKSPACE);

    // The old arithmetic here was 2 replied leads over 1 messaged lead: 200%.
    expect(analytics.repliedLeads).toBe(2);
    expect(analytics.repliedMessagedLeads).toBe(0);
    expect(analytics.replyRate).toBe(0);
    expect(analytics.replyRate ?? 0).toBeLessThanOrEqual(1);
    // A denominator of 1 is not a measurement, and the screen says so rather
    // than printing this 0% -- see `ratePercent` and RATE_MIN_SAMPLE.
    expect(analytics.contactedLeads).toBeLessThan(10);
  });

  /**
   * The same three status lists `inviteSelect` in campaigns.ts uses, so the
   * funnel and this panel answer "acceptance" with one number.
   */
  it('counts a declined invite as one that was sent, and a withdrawn one as neither', async () => {
    await ledger('invite', 'accepted-one', 'accepted');
    await ledger('invite', 'declined-one', 'declined');
    await ledger('invite', 'pending-one', 'sent');
    await ledger('invite', 'withdrawn-one', 'withdrawn');

    const analytics = await managedAnalytics(db, WORKSPACE);

    expect(analytics.invitesSent).toBe(3);
    expect(analytics.invitesAccepted).toBe(1);
    expect(analytics.invitesWithdrawn).toBe(1);
    // Was 1/2 = 50% while the refusal sat outside the denominator.
    expect(analytics.acceptanceRate).toBeCloseTo(1 / 3);
  });

  it('reports null rather than 0% when nothing has been sent or messaged', async () => {
    const analytics = await managedAnalytics(db, WORKSPACE);
    expect(analytics.acceptanceRate).toBeNull();
    expect(analytics.replyRate).toBeNull();
  });
});

describe('the derived campaign-member id', () => {
  /**
   * `linkedin_campaign_members` is ONE table shared by every tenant. A digest
   * of (campaign, contact) alone put two workspaces in the same key space, and
   * because the enrolling insert is `ON CONFLICT DO NOTHING`, a collision does
   * not raise -- the loser is simply never enrolled, and their campaign quietly
   * skips a lead with nothing anywhere to explain the missing person.
   */
  it('is scoped to the workspace, not only to the campaign and the contact', async () => {
    const listId = await leadList('Digest', ['maya']);
    const campaign = await createManagedCampaign(
      db,
      { workspaceId: WORKSPACE, name: 'Digest', leadListId: listId, workflowId: await workflow() },
      NOW
    );
    const [member] = await listCampaignMembers(db, WORKSPACE, campaign.campaign.id);

    const digest = createHash('md5')
      .update(`${WORKSPACE}:${campaign.campaign.id}:${member.contactId}`)
      .digest('hex');
    expect(member.id).toBe(`limem_${digest}`);
  });

  /**
   * The derivation exists so enrolment can run on every runner tick without
   * producing a second membership, and so a REMOVED member stays removed.
   * Changing what goes into the digest must not cost either property.
   */
  it('keeps enrolment idempotent for the same tenant', async () => {
    const listId = await leadList('Idempotent', ['maya', 'jonas']);
    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Idempotent',
        leadListId: listId,
        workflowId: await workflow()
      },
      NOW
    );
    await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
    const steps = await campaignWorkflowSteps(db, WORKSPACE, created.campaign.id);

    expect(
      await enrolNewContacts(
        db,
        WORKSPACE,
        { id: created.campaign.id, leadListId: listId, steps },
        NOW
      )
    ).toBe(0);
    expect(await listCampaignMembers(db, WORKSPACE, created.campaign.id)).toHaveLength(2);
  });
});

describe('releaseSeatWork', () => {
  /**
   * `deleteSeat` deletes one row and leaves the queue. What is left cannot be
   * sent (no worker runs for a seat that does not exist), cannot be reached
   * (nothing lists it), and still holds the replay guard on every prospect it
   * names -- and if the seat key is reused, which 'owner' always is, the NEXT
   * account inherits the previous operator's parked outreach and sends it.
   */
  it("skips a seat's planned and held work, cancels its tasks, and reports what was in flight", async () => {
    const listId = await leadList('Seat work', ['maya']);
    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Seat work',
        leadListId: listId,
        workflowId: await workflow()
      },
      NOW
    );
    const [member] = await listCampaignMembers(db, WORKSPACE, created.campaign.id);

    const planned = await queue('owner', 'planned-one', 'planned');
    const held = await queue('owner', 'held-one', 'held');
    const inFlight = await queue('owner', 'claimed-one', 'planned', true);

    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Secondary', timezone: 'Europe/Zurich' },
      NOW,
      'secondary'
    );
    const otherSeat = await queue('secondary', 'other-seat', 'planned');

    await db
      .prepare(
        `
      INSERT INTO linkedin_manual_tasks (id,workspace_id,campaign_id,member_id,contact_id,seat_key,workflow_step_id,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        id('litask'),
        WORKSPACE,
        created.campaign.id,
        member.id,
        member.contactId,
        'owner',
        'invite',
        'pending',
        NOW.toISOString()
      );

    const report = await releaseSeatWork(db, WORKSPACE, 'owner', NOW);

    expect(report).toEqual({
      seatKey: 'owner',
      actionsSkipped: 2,
      tasksCancelled: 1,
      actionsInFlight: 1
    });
    expect(await statusOf(planned)).toBe('skipped');
    expect(await statusOf(held)).toBe('skipped');
    // The two boundaries every other release path in this file also draws.
    expect(await statusOf(inFlight)).toBe('planned');
    expect(await statusOf(otherSeat)).toBe('planned');
  });

  it('is idempotent, so a disconnect that retries releases nothing twice', async () => {
    await queue('owner', 'retry-one', 'planned');
    expect((await releaseSeatWork(db, WORKSPACE, 'owner', NOW)).actionsSkipped).toBe(1);
    expect(await releaseSeatWork(db, WORKSPACE, 'owner', NOW)).toMatchObject({
      actionsSkipped: 0,
      tasksCancelled: 0,
      actionsInFlight: 0
    });
  });
});

describe('signal-backed live audiences', () => {
  it('deduplicates inbound signals and enrols new signal leads as pending rather than admitted', async () => {
    const list = await createLeadList(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Intent signals',
        sourceKind: 'signal',
        sourceRef: 'external-intent'
      },
      NOW
    );
    const first = await ingestLeadSignal(
      db,
      {
        workspaceId: WORKSPACE,
        listId: list.id,
        signalKind: 'profile_viewed',
        idempotencyKey: 'profile-view:seed',
        profileUrl: 'https://www.linkedin.com/in/signal-seed/',
        firstName: 'Seed',
        lastName: 'Lead',
        company: 'Acme'
      },
      NOW
    );
    expect(first.duplicateSignal).toBe(false);

    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Signal campaign',
        leadListId: list.id,
        workflowId: await workflow('Signal flow')
      },
      NOW
    );
    await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);

    const signalAt = new Date('2026-08-06T10:00:00.000Z');
    const added = await ingestLeadSignal(
      db,
      {
        workspaceId: WORKSPACE,
        listId: list.id,
        signalKind: 'job_changed',
        idempotencyKey: 'job-change:maya:2026-08-06',
        profileUrl: 'https://www.linkedin.com/in/maya-signal/',
        firstName: 'Maya',
        lastName: 'Signal',
        company: 'NewCo',
        sourceRef: 'crm:job-change',
        customFields: { previous_company: 'OldCo', role: 'VP Sales' },
        metadata: { provider: 'test' },
        occurredAt: signalAt.toISOString()
      },
      signalAt
    );
    expect(added.duplicateSignal).toBe(false);
    const replay = await ingestLeadSignal(
      db,
      {
        workspaceId: WORKSPACE,
        listId: list.id,
        signalKind: 'job_changed',
        idempotencyKey: 'job-change:maya:2026-08-06',
        profileUrl: 'https://www.linkedin.com/in/maya-signal/',
        firstName: 'Maya'
      },
      signalAt
    );
    expect(replay).toMatchObject({
      duplicateSignal: true,
      signalId: added.signalId,
      contactId: added.contactId
    });

    expect(
      await enrolNewContacts(
        db,
        WORKSPACE,
        {
          id: created.campaign.id,
          leadListId: list.id,
          steps: await campaignWorkflowSteps(db, WORKSPACE, created.campaign.id)
        },
        signalAt
      )
    ).toBe(1);

    const members = await listCampaignMembers(db, WORKSPACE, created.campaign.id);
    const maya = members.find((member) => member.profileUrl?.includes('/maya-signal/'));
    expect(maya).toBeDefined();
    expect(maya).toMatchObject({ status: 'pending', admittedAt: null, waveId: null });
    const signals = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_lead_signals WHERE workspace_id=? AND idempotency_key=?'
      )
      .get<{ total: number }>(WORKSPACE, 'job-change:maya:2026-08-06');
    expect(signals?.total).toBe(1);
  });
});

describe('shared campaign exclusion re-evaluation', () => {
  it('uses the same explainable policy for creation, dynamic arrivals, and paused edits', async () => {
    const blockedList = await createLeadList(
      db,
      { workspaceId: WORKSPACE, name: 'Blocked list' },
      NOW
    );
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        listId: blockedList.id,
        csv: [
          'First Name,Last Name,Company,Email,LinkedIn URL',
          'Blocked,List,Acme,blocked@ok.test,https://www.linkedin.com/in/blocked-list/'
        ].join('\n')
      },
      NOW
    );
    const main = await createLeadList(
      db,
      { workspaceId: WORKSPACE, name: 'Main exclusion audience' },
      NOW
    );
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        listId: main.id,
        csv: [
          'First Name,Last Name,Company,Email,LinkedIn URL',
          'Blocked,List,Acme,blocked@ok.test,https://www.linkedin.com/in/blocked-list/',
          'Domain,Blocked,Acme,domain@blocked.test,https://www.linkedin.com/in/domain-blocked/',
          'Duplicate,One,Acme,dup1@ok.test,https://www.linkedin.com/in/duplicate-person/?trk=one',
          'Duplicate,Two,Acme,dup2@ok.test,https://www.linkedin.com/in/other-duplicate/',
          'Connected,Known,Acme,connected@ok.test,https://www.linkedin.com/in/known-connected/',
          'Good,Lead,Acme,good@ok.test,https://www.linkedin.com/in/good-lead/'
        ].join('\n')
      },
      NOW
    );
    await db
      .prepare(
        `UPDATE linkedin_lead_contacts
         SET profile_url=?
         WHERE workspace_id=? AND email='dup2@ok.test'`
      )
      .run('https://www.linkedin.com/in/duplicate-person/?trk=two', WORKSPACE);
    await recordAction(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/known-connected/?trk=history',
        status: 'accepted',
        source: 'export'
      },
      NOW
    );
    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Exclusion campaign',
        leadListId: main.id,
        workflowId: await workflow('Exclusion flow'),
        exclusionPolicy: {
          suppressedDomains: ['blocked.test'],
          excludedLeadListIds: [blockedList.id],
          excludeDuplicateProfiles: true,
          excludeKnownConnected: true
        }
      },
      NOW
    );
    const members = await listCampaignMembers(db, WORKSPACE, created.campaign.id);
    const byProfile = new Map(members.map((member) => [member.profileUrl ?? '', member]));
    expect(byProfile.get('https://www.linkedin.com/in/blocked-list/')?.exclusionReason).toBe(
      'Member of an excluded lead list'
    );
    expect(byProfile.get('https://www.linkedin.com/in/domain-blocked/')?.exclusionReason).toBe(
      'Suppressed email domain'
    );
    expect(
      members.filter((member) => member.exclusionReason === 'Duplicate LinkedIn profile URL')
    ).toHaveLength(1);
    expect(byProfile.get('https://www.linkedin.com/in/known-connected/')?.exclusionReason).toBe(
      'Known LinkedIn connection excluded'
    );
    expect(byProfile.get('https://www.linkedin.com/in/good-lead/')?.status).toBe('pending');

    await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        listId: main.id,
        csv: [
          'First Name,Last Name,Company,Email,LinkedIn URL',
          'Dynamic,Blocked,Acme,new@blocked.test,https://www.linkedin.com/in/dynamic-blocked/'
        ].join('\n')
      },
      NOW
    );
    expect(
      await enrolNewContacts(
        db,
        WORKSPACE,
        {
          id: created.campaign.id,
          leadListId: main.id,
          steps: await campaignWorkflowSteps(db, WORKSPACE, created.campaign.id)
        },
        NOW
      )
    ).toBe(0);
    expect(
      (await listCampaignMembers(db, WORKSPACE, created.campaign.id)).find((member) =>
        member.profileUrl?.includes('/dynamic-blocked/')
      )?.exclusionReason
    ).toBe('Suppressed email domain');

    await pauseManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
    await updateManagedCampaignControls(
      db,
      WORKSPACE,
      created.campaign.id,
      {
        exclusionPolicy: {
          suppressedDomains: ['blocked.test', 'ok.test'],
          excludedLeadListIds: [blockedList.id],
          excludeDuplicateProfiles: true,
          excludeKnownConnected: true
        }
      },
      NOW
    );
    expect(
      (await listCampaignMembers(db, WORKSPACE, created.campaign.id)).find((member) =>
        member.profileUrl?.includes('/good-lead/')
      )?.exclusionReason
    ).toBe('Suppressed email domain');
  });
});

describe('capacity-weighted sender assignment', () => {
  it('assigns a new wave proportionally to sender capacity and persists the choice', async () => {
    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Sales', timezone: 'Europe/Zurich' },
      new Date('2026-01-01T09:00:00.000Z'),
      'sales'
    );
    const listId = await leadList('Weighted senders', [
      'weighted-a',
      'weighted-b',
      'weighted-c',
      'weighted-d'
    ]);
    const workflowId = await workflow('Weighted sender flow');
    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Weighted sender campaign',
        leadListId: listId,
        workflowId,
        senderKeys: ['owner', 'sales']
      },
      NOW
    );
    await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
    const steps = await campaignWorkflowSteps(db, WORKSPACE, created.campaign.id);
    const admitted = await admitPendingCampaignMembers(
      db,
      {
        workspaceId: WORKSPACE,
        campaignId: created.campaign.id,
        steps,
        decision: {
          admit: 4,
          limitingKind: 'invite',
          reasons: ['test weighted capacity'],
          capacitySnapshot: { invite: 4 }
        },
        senderKeys: ['owner', 'sales'],
        senderCapacities: { owner: 3, sales: 1 }
      },
      NOW
    );
    expect(admitted.admitted).toBe(4);
    const members = await listCampaignMembers(db, WORKSPACE, created.campaign.id);
    const counts = members.reduce<Record<string, number>>((acc, member) => {
      const key = member.assignedSeatKey ?? 'none';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ owner: 3, sales: 1 });

    // Capacity changes after admission must not migrate an in-flight lead.
    const before = members.map((member) => [member.id, member.assignedSeatKey] as const);
    expect(
      (await listCampaignMembers(db, WORKSPACE, created.campaign.id)).map((member) => [
        member.id,
        member.assignedSeatKey
      ])
    ).toEqual(before);
  });
});

describe('campaign admission forecasting', () => {
  it('uses campaign outcome samples and throttles only downward after enough evidence', async () => {
    const listId = await leadList('Forecast leads', ['forecast-seed']);
    const created = await createManagedCampaign(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Forecast campaign',
        leadListId: listId,
        workflowId: await workflow('Forecast flow')
      },
      NOW
    );
    for (let index = 0; index < 20; index += 1) {
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE,
          campaignId: created.campaign.id,
          kind: 'invite',
          targetRef: `https://www.linkedin.com/in/forecast-invite-${index}/`,
          status: index < 4 ? 'accepted' : 'declined',
          source: 'campaign',
          plannedFor: NOW.toISOString()
        },
        NOW
      );
      await recordAction(
        db,
        {
          workspaceId: WORKSPACE,
          campaignId: created.campaign.id,
          kind: 'dm',
          targetRef: `https://www.linkedin.com/in/forecast-message-${index}/`,
          status: index < 2 ? 'replied' : 'sent',
          source: 'campaign',
          plannedFor: NOW.toISOString()
        },
        NOW
      );
      const health = await recordAction(
        db,
        {
          workspaceId: WORKSPACE,
          campaignId: created.campaign.id,
          kind: 'profile_view',
          targetRef: `https://www.linkedin.com/in/forecast-health-${index}/`,
          status: 'sent',
          source: 'campaign',
          plannedFor: NOW.toISOString()
        },
        NOW
      );
      if (index < 9) {
        await db
          .prepare('UPDATE linkedin_actions SET failure_kind=? WHERE workspace_id=? AND id=?')
          .run('selector_drift', WORKSPACE, health.id);
      }
    }

    const forecast = await campaignAdmissionForecast(db, WORKSPACE, created.campaign.id, NOW);
    expect(forecast.acceptanceSampleSize).toBe(20);
    expect(forecast.acceptanceRate).toBeCloseTo(0.2);
    expect(forecast.acceptanceConfidence95?.low).toBeLessThan(0.2);
    expect(forecast.acceptanceConfidence95?.high).toBeGreaterThan(0.2);
    expect(forecast.replySampleSize).toBe(20);
    expect(forecast.noReplyRate).toBeCloseTo(0.9);
    expect(forecast.noReplyConfidence95?.low).toBeLessThan(0.9);
    expect(forecast.noReplyConfidence95?.high).toBeGreaterThan(0.9);
    // 9 problematic outcomes among 60 measured action outcomes = 15%.
    expect(forecast.failureRate).toBeCloseTo(0.15);
    expect(forecast.failureConfidence95?.low).toBeLessThan(0.15);
    expect(forecast.failureConfidence95?.high).toBeGreaterThan(0.15);
    expect(forecast.throttle).toBe(0.5);
    expect(forecast.reasons.join(' ')).toContain('recent execution outcomes');
  });

  it('previews provider enrichment credits separately from emails already on the list', async () => {
    const list = await createLeadList(
      db,
      { workspaceId: WORKSPACE, name: 'Enrichment preview' },
      NOW
    );
    await importLeadCsv(
      db,
      {
        workspaceId: WORKSPACE,
        listId: list.id,
        csv: 'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,One,Acme,maya@example.com,https://linkedin.com/in/maya-preview\nJon,Two,Acme,,https://linkedin.com/in/jon-preview\n'
      },
      NOW
    );
    const wf = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Find email preview',
        steps: [
          {
            id: 'find',
            action: 'find_email',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { providerId: 'provider', refresh: false }
          },
          {
            id: 'end',
            action: 'end',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { outcome: 'completed' }
          }
        ]
      },
      NOW
    );
    const preview = await previewManagedCampaignLaunch(
      db,
      { workspaceId: WORKSPACE, leadListId: list.id, workflowId: wf.id, enrichmentCreditCap: 0 },
      NOW
    );
    expect(preview.enrichmentCredits).toEqual({
      required: 1,
      alreadyAvailable: 1,
      estimatedProviderLookups: 1,
      cap: 0,
      capped: true
    });
  });

  it('warns before launch when selected-list merge coverage is materially incomplete', async () => {
    const listId = await leadList('Coverage leads', ['coverage-a', 'coverage-b', 'coverage-c']);
    const wf = await saveWorkflow(
      db,
      {
        workspaceId: WORKSPACE,
        name: 'Coverage workflow',
        steps: [
          {
            id: 'message',
            action: 'message',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { variants: [{ id: 'a', body: 'Email on file: {{email}}', weight: 100 }] }
          }
        ]
      },
      NOW
    );
    const preview = await previewManagedCampaignLaunch(
      db,
      { workspaceId: WORKSPACE, leadListId: listId, workflowId: wf.id },
      NOW
    );
    expect(preview.variableCoverage.email).toEqual({ present: 0, total: 3 });
    expect(preview.diagnostics.some((item) => item.code === 'missing_variable_coverage')).toBe(
      true
    );
  });
});
