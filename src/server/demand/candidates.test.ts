import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { runRecommendationEngine } from '../recommendation-engine.js';
import { buildDemandCandidates } from './candidates.js';

const NOW = new Date('2026-09-12T08:00:00.000Z');
let db: Db;
const workspaces: string[] = [];

async function seedWorkspace(label: string): Promise<string> {
  const workspaceId = id('ws');
  workspaces.push(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, label, NOW.toISOString());
  return workspaceId;
}

async function seedInboundAtHotAccount(
  workspaceId: string,
  input: { tier?: 'hot' | 'warm'; score?: number; kind?: string } = {}
): Promise<{ personId: string; accountId: string; submissionId: string }> {
  const personId = id('con');
  const sourceId = id('cap');
  const submissionId = id('sub');
  await db
    .prepare(
      `INSERT INTO contacts
       (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      personId,
      workspaceId,
      'Maya Patel',
      `${personId}@example.test`,
      `${personId}@example.test`,
      'VP Growth',
      NOW.toISOString(),
      NOW.toISOString()
    );
  await db
    .prepare(
      `INSERT INTO capture_sources
       (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',0,0,?,?)`
    )
    .run(
      sourceId,
      workspaceId,
      'Website',
      `website-${sourceId}`,
      'website',
      NOW.toISOString(),
      NOW.toISOString()
    );

  const account = await createAccount(
    db,
    workspaceId,
    { domain: `${accountIdSafe(workspaceId)}.example`, name: 'Acme', source: 'manual' },
    new Date('2026-09-10T08:00:00.000Z')
  );

  await db
    .prepare(
      `INSERT INTO account_contacts
       (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
       VALUES (?,?,?,?,?,'capture','explicit',?,?)`
    )
    .run(
      id('ac'),
      workspaceId,
      account.id,
      personId,
      'VP Growth',
      NOW.toISOString(),
      NOW.toISOString()
    );

  await db
    .prepare(
      `INSERT INTO inbound_submissions
       (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
        person_name,person_email,person_role,company_domain,company_name,message,page_url,
        payload_hash,received_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      submissionId,
      workspaceId,
      sourceId,
      personId,
      account.id,
      `idem-${submissionId}`,
      input.kind ?? 'demo_request',
      'Maya Patel',
      `${personId}@example.test`,
      'VP Growth',
      `${accountIdSafe(workspaceId)}.example`,
      'Acme',
      'We would like to see a demo next week.',
      'https://example.test/demo',
      `hash-${submissionId}`,
      '2026-09-12T07:30:00.000Z',
      '2026-09-12T07:30:00.000Z'
    );

  await db
    .prepare(
      `INSERT INTO account_scores
       (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      workspaceId,
      account.id,
      input.score ?? 88,
      input.tier ?? 'hot',
      2,
      '2026-09-12T06:00:00.000Z',
      '{}',
      '2026-09-12T06:01:00.000Z'
    );

  for (const [index, signal] of [
    [
      'hiring-up',
      'Open roles increased from 3 to 8, including VP Platform.',
      'https://acme.example/careers'
    ],
    ['pricing-changed', 'Pricing page changed this week.', 'https://acme.example/pricing']
  ].entries()) {
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,previous,current,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('sig'),
        workspaceId,
        account.id,
        signal[0],
        signal[1],
        null,
        null,
        signal[2],
        `2026-09-12T0${5 + index}:00:00.000Z`,
        `fp-${submissionId}-${index}`,
        `2026-09-12T0${5 + index}:00:00.000Z`
      );
  }

  return { personId, accountId: account.id, submissionId };
}

function accountIdSafe(workspaceId: string): string {
  return workspaceId
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(-16);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('buildDemandCandidates', () => {
  it('joins explicit first-party intent with hot account intent and source evidence', async () => {
    const workspaceId = await seedWorkspace('Demand graph');
    const seeded = await seedInboundAtHotAccount(workspaceId);

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKey: `demand:${seeded.personId}:${seeded.accountId}`,
      personId: seeded.personId,
      accountId: seeded.accountId,
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      dimensions: {
        fit: null,
        accountIntent: 0.88,
        personIntent: 0,
        firstPartyIntent: 1,
        relationship: 0
      }
    });
    expect(candidates[0]?.evidence.map((item) => item.sourceType)).toEqual([
      'inbound_submission',
      'account_score',
      'account_signal',
      'account_signal'
    ]);
    expect(candidates[0]?.evidence.filter((item) => item.sourceType === 'account_signal')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalUrl: 'https://acme.example/careers' }),
        expect.objectContaining({ externalUrl: 'https://acme.example/pricing' })
      ])
    );
  });

  it('uses a recent verified inbound conversation as relationship evidence and replies instead of cold outreach', async () => {
    const workspaceId = await seedWorkspace('Relationship-aware demand');
    const seeded = await seedInboundAtHotAccount(workspaceId);
    const conversationId = id('conv');
    await db
      .prepare(
        `INSERT INTO conversations
         (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(
        conversationId,
        workspaceId,
        seeded.personId,
        '2026-09-12T07:45:00.000Z',
        '2026-09-12T07:45:00.000Z',
        '2026-09-12T07:45:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages (
          id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
          source_type,source_id,outcome_kind,verification_status,occurred_at,created_at
        ) VALUES (?,?,?,'email','gmail','inbound','Re: Demo','Yes, send me times for next week.',?,
          'campaign_email_reply',?,'reply','verified',?,?)`
      )
      .run(
        'cmsg_relationship_reply',
        workspaceId,
        conversationId,
        'gmail:relationship-reply',
        'relationship-reply',
        '2026-09-12T07:45:00.000Z',
        '2026-09-12T07:45:00.000Z'
      );

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      personId: seeded.personId,
      accountId: seeded.accountId,
      qualification: 'act_now',
      recommendedAction: 'reply',
      title: 'Reply to Maya Patel at Acme'
    });
    expect(candidates[0]!.dimensions.relationship).toBeGreaterThan(0.99);
    expect(candidates[0]!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'conversation_message',
          sourceId: 'cmsg_relationship_reply'
        })
      ])
    );
  });

  it('treats an explicit demo request as actionable even before an account score exists', async () => {
    const workspaceId = await seedWorkspace('Direct buying intent');
    const seeded = await seedInboundAtHotAccount(workspaceId, { kind: 'demo_request' });
    await db
      .prepare('DELETE FROM account_scores WHERE workspace_id=? AND account_id=?')
      .run(workspaceId, seeded.accountId);
    await db
      .prepare('DELETE FROM account_signals WHERE workspace_id=? AND account_id=?')
      .run(workspaceId, seeded.accountId);

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      personId: seeded.personId,
      accountId: seeded.accountId,
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      dimensions: { accountIntent: 0, firstPartyIntent: 1, relationship: 0 }
    });
    expect(candidates[0]!.evidence.map((item) => item.sourceType)).toEqual(['inbound_submission']);
    expect(candidates[0]!.rationale).toContain(
      'explicit demo/pilot/pricing intent does not require an inferred account score'
    );

    await runRecommendationEngine(db, workspaceId, NOW, { includeStaleProposals: false });
    const attributed = await db
      .prepare(
        `SELECT o.stage,o.person_id,o.account_id,o.origin_recommendation_id
         FROM opportunities o WHERE o.workspace_id=?`
      )
      .get<{
        stage: string;
        person_id: string | null;
        account_id: string | null;
        origin_recommendation_id: string | null;
      }>(workspaceId);
    expect(attributed).toMatchObject({
      stage: 'qualified',
      person_id: seeded.personId,
      account_id: seeded.accountId
    });
    expect(attributed?.origin_recommendation_id).toMatch(/^rec_/);
  });

  it('does not let a later weak event erase an earlier explicit buying request', async () => {
    const workspaceId = await seedWorkspace('Strong inbound survives later weak event');
    const seeded = await seedInboundAtHotAccount(workspaceId, { kind: 'demo_request' });
    const source = await db
      .prepare('SELECT capture_source_id FROM inbound_submissions WHERE id=?')
      .get<{ capture_source_id: string }>(seeded.submissionId);
    expect(source?.capture_source_id).toBeTruthy();
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
          person_name,person_email,company_domain,company_name,message,payload_hash,received_at,created_at)
         SELECT ?,workspace_id,capture_source_id,contact_id,account_id,?,'scan_completed',
                person_name,person_email,company_domain,company_name,'Later scan',?, ?, ?
         FROM inbound_submissions WHERE id=?`
      )
      .run(
        'sub_later_weak',
        'later-weak-idempotency',
        'hash-later-weak',
        '2026-09-12T07:50:00.000Z',
        '2026-09-12T07:50:00.000Z',
        seeded.submissionId
      );
    await db
      .prepare('DELETE FROM account_scores WHERE workspace_id=? AND account_id=?')
      .run(workspaceId, seeded.accountId);
    await db
      .prepare('DELETE FROM account_signals WHERE workspace_id=? AND account_id=?')
      .run(workspaceId, seeded.accountId);

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dimensions.firstPartyIntent).toBe(1);
    expect(candidates[0]?.evidence[0]).toMatchObject({
      sourceType: 'inbound_submission',
      sourceId: seeded.submissionId
    });
  });

  it('does not promote the same inbound event when account intent is only warm', async () => {
    const workspaceId = await seedWorkspace('Warm demand graph');
    await seedInboundAtHotAccount(workspaceId, { tier: 'warm', score: 55, kind: 'scan_completed' });

    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);
  });

  it('is workspace isolated', async () => {
    const first = await seedWorkspace('First');
    const second = await seedWorkspace('Second');
    const firstSeed = await seedInboundAtHotAccount(first);
    await seedInboundAtHotAccount(second);

    const candidates = await buildDemandCandidates(db, first, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.personId).toBe(firstSeed.personId);
    expect(candidates[0]?.accountId).toBe(firstSeed.accountId);
  });

  it('layers recent engagement on a Trevra-published LinkedIn post onto a hot Account', async () => {
    const workspaceId = await seedWorkspace('Published post engagement');
    const personId = id('con');
    const profileUrl = 'https://www.linkedin.com/in/post-engager/';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,linkedin_url,linkedin_url_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        workspaceId,
        'Jordan Lee',
        'jordan@engager.example',
        'jordan@engager.example',
        profileUrl,
        profileUrl.toLowerCase(),
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'engager.example', name: 'Engager Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_contacts
         (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
         VALUES (?,?,?,?,?,'manual','explicit',?,?)`
      )
      .run(
        'ac_post_engager',
        workspaceId,
        account.id,
        personId,
        'VP Engineering',
        '2026-09-10T08:00:00.000Z',
        '2026-09-10T08:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        91,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [0, 'hiring-up', 'Added platform roles.', 'https://engager.example/careers'],
      [1, 'tech-added', 'Added an infrastructure tool.', 'https://engager.example/']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_post_engagement_${index}`,
          workspaceId,
          account.id,
          kind,
          detail,
          url,
          `2026-09-12T0${6 + index}:00:00.000Z`,
          `post-engagement-${index}`,
          `2026-09-12T0${6 + index}:00:00.000Z`
        );
    }
    const postedUrl = 'https://www.linkedin.com/posts/trevra-market-signal-123';
    await db
      .prepare(
        `INSERT INTO linkedin_posts
         (id,workspace_id,seat_key,status,posted_url,published_at,created_at,updated_at)
         VALUES (?,?,?,'posted',?,?,?,?)`
      )
      .run(
        'lipost_demand_engagement',
        workspaceId,
        'owner',
        postedUrl,
        '2026-09-12T06:00:00.000Z',
        '2026-09-12T05:50:00.000Z',
        '2026-09-12T06:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_lead_sources
         (id,workspace_id,kind,url,status,requested_at,finished_at,result_count,created_at,updated_at,seat_key)
         VALUES (?,?,? ,?,'completed',?,?,1,?,?,?)`
      )
      .run(
        'llsrc_demand_engagement',
        workspaceId,
        'post',
        `${postedUrl}/`,
        '2026-09-12T06:05:00.000Z',
        '2026-09-12T07:30:00.000Z',
        '2026-09-12T06:05:00.000Z',
        '2026-09-12T07:30:00.000Z',
        'owner'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_leads
         (id,workspace_id,source_id,profile_url,name,first_name,last_name,company,post_url,interaction_kind,created_at,seat_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'lilead_demand_engagement',
        workspaceId,
        'llsrc_demand_engagement',
        profileUrl,
        'Jordan Lee',
        'Jordan',
        'Lee',
        'Engager Co',
        postedUrl,
        'comment',
        '2026-09-12T07:30:00.000Z',
        'owner'
      );

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKey: `demand:${personId}:${account.id}`,
      personId,
      accountId: account.id,
      personName: 'Jordan Lee',
      accountName: 'Engager Co',
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      dimensions: {
        accountIntent: 0.91,
        firstPartyIntent: 0,
        relationship: 0
      }
    });
    expect(candidates[0]!.dimensions.personIntent).toBeGreaterThan(0.79);
    expect(candidates[0]!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'linkedin_post_engagement',
          sourceId: 'lilead_demand_engagement',
          externalUrl: postedUrl
        })
      ])
    );

    await db
      .prepare(
        "UPDATE account_scores SET tier='warm',score=60 WHERE workspace_id=? AND account_id=?"
      )
      .run(workspaceId, account.id);
    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);
  });

  it('does not map a post engager to demand when their Account association is ambiguous', async () => {
    const workspaceId = await seedWorkspace('Ambiguous post engager');
    const personId = id('con');
    const profileUrl = 'https://www.linkedin.com/in/ambiguous-engager/';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,linkedin_url,linkedin_url_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        workspaceId,
        'Taylor Kim',
        'taylor@ambiguous.example',
        'taylor@ambiguous.example',
        profileUrl,
        profileUrl.toLowerCase(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const first = await createAccount(
      db,
      workspaceId,
      { domain: 'ambiguous-one.example', name: 'Ambiguous One', source: 'manual' },
      NOW
    );
    const second = await createAccount(
      db,
      workspaceId,
      { domain: 'ambiguous-two.example', name: 'Ambiguous Two', source: 'manual' },
      NOW
    );
    for (const [index, account] of [first, second].entries()) {
      await db
        .prepare(
          `INSERT INTO account_contacts
           (id,workspace_id,account_id,contact_id,source,confidence,created_at,updated_at)
           VALUES (?,?,?,?,'manual','explicit',?,?)`
        )
        .run(
          `ac_ambiguous_post_${index}`,
          workspaceId,
          account.id,
          personId,
          NOW.toISOString(),
          NOW.toISOString()
        );
      await db
        .prepare(
          `INSERT INTO account_scores
           (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
           VALUES (?,?,90,'hot',2,?,'{}',?)`
        )
        .run(workspaceId, account.id, '2026-09-12T07:00:00.000Z', '2026-09-12T07:01:00.000Z');
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_ambiguous_post_${index}`,
          workspaceId,
          account.id,
          'hiring-up',
          'Hiring increased.',
          `https://${account.domain}/careers`,
          '2026-09-12T07:00:00.000Z',
          `ambiguous-post-${index}`,
          '2026-09-12T07:00:00.000Z'
        );
    }
    const postedUrl = 'https://www.linkedin.com/posts/trevra-ambiguous-456';
    await db
      .prepare(
        `INSERT INTO linkedin_posts
         (id,workspace_id,seat_key,status,posted_url,published_at,created_at,updated_at)
         VALUES (?,?,?,'posted',?,?,?,?)`
      )
      .run(
        'lipost_ambiguous_engagement',
        workspaceId,
        'owner',
        postedUrl,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_lead_sources
         (id,workspace_id,kind,url,status,requested_at,finished_at,result_count,created_at,updated_at,seat_key)
         VALUES (?,?,? ,?,'completed',?,?,1,?,?,?)`
      )
      .run(
        'llsrc_ambiguous_engagement',
        workspaceId,
        'post',
        postedUrl,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        'owner'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_leads
         (id,workspace_id,source_id,profile_url,name,first_name,last_name,company,post_url,interaction_kind,created_at,seat_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'lilead_ambiguous_engagement',
        workspaceId,
        'llsrc_ambiguous_engagement',
        profileUrl,
        'Taylor Kim',
        'Taylor',
        'Kim',
        'Ambiguous',
        postedUrl,
        'comment',
        '2026-09-12T07:30:00.000Z',
        'owner'
      );

    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);
  });

  it('surfaces a hot account when exactly one explicit contact is already known', async () => {
    const workspaceId = await seedWorkspace('Known contact demand');
    const personId = id('con');
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        workspaceId,
        'Sarah Chen',
        'sarah@known.example',
        'sarah@known.example',
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'known-contact.example', name: 'Known Contact Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_contacts
         (id,workspace_id,account_id,contact_id,role,source,confidence,source_detail,created_at,updated_at)
         VALUES (?,?,?,?,?,'manual','explicit','Founder supplied contact',?,?)`
      )
      .run(
        'ac_known_contact',
        workspaceId,
        account.id,
        personId,
        'VP Engineering',
        '2026-09-10T08:00:00.000Z',
        '2026-09-10T08:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        93,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://known-contact.example/careers'
      ],
      [1, 'tech-added', 'Added a new infrastructure tool.', 'https://known-contact.example/']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id('sig'),
          workspaceId,
          account.id,
          kind,
          detail,
          url,
          `2026-09-12T0${6 + index}:00:00.000Z`,
          `known-contact-${index}`,
          `2026-09-12T0${6 + index}:00:00.000Z`
        );
    }

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKey: `demand:${personId}:${account.id}`,
      personId,
      accountId: account.id,
      personName: 'Sarah Chen',
      accountName: 'Known Contact Co',
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      dimensions: {
        fit: null,
        accountIntent: 0.93,
        personIntent: 0,
        firstPartyIntent: 0,
        relationship: 0
      }
    });
    expect(candidates[0]?.evidence[0]).toMatchObject({
      sourceType: 'account_contact',
      sourceId: 'ac_known_contact'
    });
  });

  it('does not choose among multiple known contacts without a persona model', async () => {
    const workspaceId = await seedWorkspace('Ambiguous contacts');
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'ambiguous-contacts.example', name: 'Ambiguous Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    for (const [index, name, role] of [
      [0, 'Sarah Chen', 'VP Engineering'],
      [1, 'Alex Meyer', 'Head of Platform']
    ] as const) {
      const personId = `con_ambiguous_${index}`;
      await db
        .prepare(
          `INSERT INTO contacts
           (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          personId,
          workspaceId,
          name,
          `${personId}@example.test`,
          `${personId}@example.test`,
          role,
          NOW.toISOString(),
          NOW.toISOString()
        );
      await db
        .prepare(
          `INSERT INTO account_contacts
           (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
           VALUES (?,?,?,?,?,'manual','explicit',?,?)`
        )
        .run(
          `ac_ambiguous_${index}`,
          workspaceId,
          account.id,
          personId,
          role,
          NOW.toISOString(),
          NOW.toISOString()
        );
    }
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        95,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sig_ambiguous',
        workspaceId,
        account.id,
        'hiring-up',
        'Added platform engineering roles.',
        'https://ambiguous-contacts.example/careers',
        '2026-09-12T07:00:00.000Z',
        'ambiguous-signal',
        '2026-09-12T07:00:00.000Z'
      );

    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);
  });

  it('uses the saved campaign buyer role to choose one clear contact among several', async () => {
    const workspaceId = await seedWorkspace('Persona-ranked contacts');
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'persona-ranked.example', name: 'Persona Ranked Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );

    await db
      .prepare(
        `INSERT INTO linkedin_campaigns
         (id,workspace_id,name,status,sequence_json,brief_json,seat_key,created_at,updated_at)
         VALUES (?,?,?,'draft','{}'::jsonb,?::jsonb,'owner',?,?)`
      )
      .run(
        'lic_persona_ranked',
        workspaceId,
        'Engineering leaders',
        JSON.stringify({
          icp: { role: 'VP Engineering', segment: 'B2B SaaS', pain: 'Platform scale' }
        }),
        '2026-09-11T08:00:00.000Z',
        '2026-09-11T08:00:00.000Z'
      );

    for (const [index, name, role] of [
      [0, 'Sarah Chen', 'VP Engineering'],
      [1, 'Alex Meyer', 'Head of Sales']
    ] as const) {
      const personId = `con_persona_${index}`;
      await db
        .prepare(
          `INSERT INTO contacts
           (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          personId,
          workspaceId,
          name,
          `${personId}@example.test`,
          `${personId}@example.test`,
          role,
          NOW.toISOString(),
          NOW.toISOString()
        );
      await db
        .prepare(
          `INSERT INTO account_contacts
           (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
           VALUES (?,?,?,?,?,'manual','explicit',?,?)`
        )
        .run(
          `ac_persona_${index}`,
          workspaceId,
          account.id,
          personId,
          role,
          NOW.toISOString(),
          NOW.toISOString()
        );
    }

    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        96,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://persona-ranked.example/careers'
      ],
      [1, 'tech-added', 'Added a new infrastructure tool.', 'https://persona-ranked.example/']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_persona_${index}`,
          workspaceId,
          account.id,
          kind,
          detail,
          url,
          `2026-09-12T0${6 + index}:00:00.000Z`,
          `persona-ranked-${index}`,
          `2026-09-12T0${6 + index}:00:00.000Z`
        );
    }

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      personId: 'con_persona_0',
      personName: 'Sarah Chen',
      accountId: account.id,
      recommendedAction: 'prepare_outreach'
    });
    expect(candidates[0]?.summary).toContain('clear best role match');
    expect(candidates[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'campaign_brief',
          sourceId: 'lic_persona_ranked',
          excerpt: expect.stringContaining('VP Engineering')
        })
      ])
    );
  });

  it('prepares company-employee discovery for a hot account with no known person', async () => {
    const workspaceId = await seedWorkspace('No known person');
    const account = await createAccount(
      db,
      workspaceId,
      {
        domain: 'no-known-person.example',
        name: 'No Known Person Co',
        linkedinUrl: 'https://www.linkedin.com/company/no-known-person/',
        source: 'manual'
      },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        91,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://no-known-person.example/careers'
      ],
      [
        1,
        'pricing-changed',
        'Changed enterprise pricing.',
        'https://no-known-person.example/pricing'
      ]
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_no_person_${index}`,
          workspaceId,
          account.id,
          kind,
          detail,
          url,
          `2026-09-12T0${6 + index}:00:00.000Z`,
          `no-person-${index}`,
          `2026-09-12T0${6 + index}:00:00.000Z`
        );
    }

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKey: `demand:find-person:${account.id}`,
      personId: null,
      personName: null,
      accountId: account.id,
      qualification: 'act_now',
      recommendedAction: 'find_person'
    });
    expect(candidates[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'discovery_plan',
          sourceId: `company_employees:${account.id}`,
          externalUrl: 'https://www.linkedin.com/company/no-known-person/people/'
        })
      ])
    );
  });

  it('falls back to a buyer-role people search when the hot account has no LinkedIn company URL', async () => {
    const workspaceId = await seedWorkspace('Persona discovery');
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'persona-discovery.example', name: 'Persona Discovery Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO linkedin_campaigns
         (id,workspace_id,name,status,sequence_json,brief_json,seat_key,created_at,updated_at)
         VALUES (?,?,?,'draft','{}'::jsonb,?::jsonb,'owner',?,?)`
      )
      .run(
        'lic_persona_discovery',
        workspaceId,
        'Platform buyers',
        JSON.stringify({
          icp: { role: 'VP Engineering', segment: 'B2B SaaS', pain: 'Platform scale' }
        }),
        '2026-09-11T08:00:00.000Z',
        '2026-09-11T08:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        92,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sig_persona_discovery',
        workspaceId,
        account.id,
        'hiring-up',
        'Added platform engineering roles.',
        'https://persona-discovery.example/careers',
        '2026-09-12T07:00:00.000Z',
        'persona-discovery',
        '2026-09-12T07:00:00.000Z'
      );

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);
    const plan = candidates[0]?.evidence.find((item) => item.sourceType === 'discovery_plan');

    expect(candidates).toHaveLength(1);
    expect(plan).toMatchObject({
      sourceId: `search:${account.id}`
    });
    expect(plan?.externalUrl).toContain('/search/results/people/');
    expect(new URL(plan?.externalUrl ?? '').searchParams.get('keywords')).toBe(
      'VP Engineering Persona Discovery Co'
    );
  });

  it('does not create fresh outreach demand when the account already has an open opportunity', async () => {
    const workspaceId = await seedWorkspace('Open opportunity');
    const personId = id('con');
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        workspaceId,
        'Sarah Chen',
        'sarah@open.example',
        'sarah@open.example',
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'open-opportunity.example', name: 'Open Opportunity Co', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_contacts
         (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
         VALUES (?,?,?,?,?,'manual','explicit',?,?)`
      )
      .run(
        'ac_open_opp',
        workspaceId,
        account.id,
        personId,
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO opportunities
         (id,workspace_id,person_id,account_id,title,stage,created_at,updated_at)
         VALUES (?,?,?,?,?,'qualified',?,?)`
      )
      .run(
        'opp_open_demand',
        workspaceId,
        personId,
        account.id,
        'Existing opportunity',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        94,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sig_open_opp',
        workspaceId,
        account.id,
        'pricing-changed',
        'Enterprise pricing changed.',
        'https://open-opportunity.example/pricing',
        '2026-09-12T07:00:00.000Z',
        'open-opp-signal',
        '2026-09-12T07:00:00.000Z'
      );

    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);

    await db
      .prepare('UPDATE opportunities SET updated_at=? WHERE workspace_id=? AND id=?')
      .run('2026-08-10T08:00:00.000Z', workspaceId, 'opp_open_demand');
    const reengagement = await buildDemandCandidates(db, workspaceId, NOW);
    expect(reengagement).toHaveLength(1);
    expect(reengagement[0]).toMatchObject({
      sourceKey: `demand:${personId}:${account.id}`,
      personId,
      accountId: account.id,
      title: 'Re-engage Sarah Chen at Open Opportunity Co',
      recommendedAction: 'prepare_outreach',
      dimensions: { relationship: 0.85 }
    });
    expect(reengagement[0]!.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'opportunity',
          sourceId: 'opp_open_demand',
          label: 'Dormant qualified opportunity'
        })
      ])
    );
  });
});
