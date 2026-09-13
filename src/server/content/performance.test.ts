import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { resolveContact } from '../lead-capture/people.js';
import { createLeadSource, TREVRA_PUBLISHED_POST_ORIGIN } from '../linkedin/leads.js';
import { createPost, markPostPublished } from '../linkedin/posts.js';
import { upsertSeat } from '../linkedin/seats.js';
import { promoteVerifiedDemandRepliesToOpportunities } from '../demand/opportunities.js';
import { createContentAsset } from './assets.js';
import { upsertContentOpportunity } from './opportunities.js';
import {
  appendLinkedInContentMetric,
  contentPerformanceReport,
  CONTENT_LEARNING_MIN_SAMPLE
} from './performance.js';

let db: Db;
const workspaces: string[] = [];
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db.close();
});

async function workspace(name = 'Content performance'): Promise<string> {
  const workspaceId = id('ws');
  workspaces.push(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, name, NOW.toISOString());
  await upsertSeat(db, workspaceId, { label: 'Owner', timezone: 'UTC' }, NOW);
  return workspaceId;
}

async function publishedStory(
  workspaceId: string,
  suffix: string,
  impressions: number | null
): Promise<{ postId: string; assetId: string; opportunityId: string }> {
  const story = await upsertContentOpportunity(
    db,
    {
      workspaceId,
      kind: 'company_change',
      title: `Story ${suffix}`,
      thesis: `Evidence-backed change ${suffix}.`,
      freshnessAt: NOW.toISOString(),
      score: 90,
      rationale: ['two independent changes'],
      fingerprint: `story-${suffix}`,
      evidence: [
        {
          sourceType: 'account_signal',
          sourceId: `sig-${suffix}`,
          label: 'Hiring changed',
          detail: `Hiring changed ${suffix}.`,
          sourceUrl: `https://example.test/${suffix}`,
          observedAt: NOW.toISOString()
        }
      ]
    },
    NOW
  );
  const asset = await createContentAsset(
    db,
    {
      workspaceId,
      opportunityId: story.id,
      format: 'text_post',
      angle: 'observation',
      body: `Body ${suffix}`,
      claimMap: []
    },
    NOW
  );
  const postId = id('lipost');
  await createPost(
    db,
    {
      id: postId,
      workspaceId,
      blocks: [{ runs: [{ type: 'text', text: `Post ${suffix}` }] }],
      status: 'draft',
      contentAssetId: asset.id,
      publicationMeta: { contentOpportunityId: story.id }
    },
    NOW
  );
  await markPostPublished(
    db,
    postId,
    { postedUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${suffix}/` },
    NOW
  );
  if (impressions !== null) {
    await appendLinkedInContentMetric(
      db,
      {
        workspaceId,
        postId,
        observedAt: '2026-09-12T12:05:00.000Z',
        impressions,
        reactions: Math.round(impressions / 100),
        comments: Math.round(impressions / 500)
      },
      NOW
    );
  }
  return { postId, assetId: asset.id, opportunityId: story.id };
}

async function attachCommercialOutcome(
  workspaceId: string,
  postId: string
): Promise<{ recommendationId: string }> {
  const person = await resolveContact(
    db,
    workspaceId,
    {
      name: 'Maya Buyer',
      email: 'maya@example.test',
      linkedinUrl: 'https://www.linkedin.com/in/maya-performance/'
    },
    NOW
  );
  const account = await createAccount(db, workspaceId, {
    domain: 'performance-buyer.example',
    name: 'Performance Buyer',
    source: 'manual'
  });
  await db
    .prepare(
      `INSERT INTO account_contacts
       (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
       VALUES (?,?,?,?,?,'manual','verified',?,?)`
    )
    .run(
      id('ac'),
      workspaceId,
      account.id,
      person.contact.id,
      'VP Engineering',
      NOW.toISOString(),
      NOW.toISOString()
    );
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:commercial-${postId}/`;
  await db
    .prepare('UPDATE linkedin_posts SET posted_url=? WHERE workspace_id=? AND id=?')
    .run(postUrl, workspaceId, postId);
  const source = await createLeadSource(
    db,
    {
      workspaceId,
      kind: 'post',
      url: postUrl,
      originType: TREVRA_PUBLISHED_POST_ORIGIN,
      originId: postId
    },
    NOW
  );
  const leadId = id('ll');
  await db
    .prepare(
      `INSERT INTO linkedin_leads
       (id,workspace_id,seat_key,source_id,profile_url,name,first_name,last_name,headline,company,
        post_url,interaction_kind,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      leadId,
      workspaceId,
      'owner',
      source.source.id,
      'https://www.linkedin.com/in/maya-performance/',
      'Maya Buyer',
      'Maya',
      'Buyer',
      'VP Engineering',
      'Performance Buyer',
      postUrl,
      'comment',
      '2026-09-12T12:10:00.000Z'
    );
  const recommendationId = id('rec');
  await db
    .prepare(
      `INSERT INTO recommendations (
         id,workspace_id,person_id,account_id,source_key,type,title,summary,confidence,urgency,
         priority_score,status,recommended_action,created_at,updated_at
       ) VALUES (?,?,?,?,?,'qualified_demand','Talk to Maya','Demand',0.9,1.1,990,'completed',
         'prepare_outreach',?,?)`
    )
    .run(
      recommendationId,
      workspaceId,
      person.contact.id,
      account.id,
      `demand:${person.contact.id}:${account.id}`,
      NOW.toISOString(),
      NOW.toISOString()
    );
  await db
    .prepare(
      `INSERT INTO recommendation_evidence
       (id,workspace_id,recommendation_id,source_type,source_id,label,category,excerpt,observed_at,created_at)
       VALUES (?,?,?,'linkedin_post_engagement',?,'Commented on your LinkedIn post','supporting',
         'Maya commented.',?,?)`
    )
    .run(
      id('ev'),
      workspaceId,
      recommendationId,
      leadId,
      '2026-09-12T12:10:00.000Z',
      NOW.toISOString()
    );
  const conversationId = id('conv');
  await db
    .prepare(
      `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      conversationId,
      workspaceId,
      person.contact.id,
      '2026-09-12T12:30:00.000Z',
      NOW.toISOString(),
      '2026-09-12T12:30:00.000Z'
    );
  await db
    .prepare(
      `INSERT INTO conversation_messages (
         id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
         source_type,source_id,verification_status,occurred_at,created_at
       ) VALUES (?,?,?,'email','gmail','outbound','Hello','Evidence-based outreach','gmail:out',
         'qualified_demand_outreach',?,'verified',?,?)`
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversationId,
      recommendationId,
      '2026-09-12T12:20:00.000Z',
      '2026-09-12T12:20:00.000Z'
    );
  await db
    .prepare(
      `INSERT INTO conversation_messages (
         id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
         source_type,source_id,outcome_kind,verification_status,occurred_at,created_at
       ) VALUES (?,?,?,'email','gmail','inbound','Re: Hello','Let’s talk','gmail:in',
         'legacy_message',?,'reply','verified',?,?)`
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversationId,
      `provider-reply-${recommendationId}`,
      '2026-09-12T12:30:00.000Z',
      '2026-09-12T12:30:00.000Z'
    );
  const created = await promoteVerifiedDemandRepliesToOpportunities(db, workspaceId, NOW);
  expect(created).toHaveLength(1);
  await db
    .prepare(
      "UPDATE opportunities SET stage='won',updated_at=? WHERE workspace_id=? AND origin_recommendation_id=?"
    )
    .run('2026-09-12T12:40:00.000Z', workspaceId, recommendationId);
  return { recommendationId };
}

describe('content commercial performance', () => {
  it('follows explicit post engagement lineage through qualified demand, verified reply, opportunity and win', async () => {
    const workspaceId = await workspace();
    const publication = await publishedStory(workspaceId, 'commercial', 1000);
    await appendLinkedInContentMetric(
      db,
      {
        workspaceId,
        postId: publication.postId,
        observedAt: '2026-09-12T13:00:00.000Z',
        impressions: 1500,
        reactions: 18,
        comments: 4
      },
      NOW
    );
    await attachCommercialOutcome(workspaceId, publication.postId);

    const report = await contentPerformanceReport(db, workspaceId);
    expect(report.totals).toEqual({
      published: 1,
      engagers: 1,
      resolvedPeople: 1,
      qualifiedDemand: 1,
      verifiedReplies: 1,
      opportunities: 1,
      won: 1
    });
    expect(report.publications).toHaveLength(1);
    expect(report.publications[0]).toMatchObject({
      postId: publication.postId,
      latestMetrics: { impressions: 1500, reactions: 18, comments: 4 },
      velocity: {
        snapshotCount: 2,
        impressionsDelta: 500,
        reactionsDelta: 8,
        commentsDelta: 2,
        repostsDelta: null
      },
      commercial: {
        engagers: 1,
        resolvedPeople: 1,
        qualifiedDemand: 1,
        verifiedReplies: 1,
        opportunities: 1,
        won: 1
      }
    });
    expect(report.publications[0]?.velocity.windowHours).toBeCloseTo(55 / 60, 5);
    expect(report.publications[0]?.velocity.impressionsPerHour).toBeCloseTo(545.45, 1);
    expect(
      report.learning.find((row) => row.dimension === 'angle' && row.value === 'observation')
    ).toMatchObject({ sampleSize: 1, eligibleForComparison: false });
  });

  it('uses medians and refuses comparison claims until three published samples exist', async () => {
    const workspaceId = await workspace('Learning sample');
    const one = await publishedStory(workspaceId, 'one', 100);
    await publishedStory(workspaceId, 'two', 300);
    let report = await contentPerformanceReport(db, workspaceId);
    expect(report.publications.find((row) => row.postId === one.postId)?.velocity).toMatchObject({
      snapshotCount: 1,
      windowHours: null,
      impressionsDelta: null,
      impressionsPerHour: null
    });
    let angle = report.learning.find(
      (row) => row.dimension === 'angle' && row.value === 'observation'
    );
    expect(angle).toMatchObject({
      sampleSize: 2,
      metricSampleSize: 2,
      medianImpressions: 200,
      eligibleForComparison: false
    });
    expect(angle?.summary).toContain(`2/${CONTENT_LEARNING_MIN_SAMPLE}`);

    await publishedStory(workspaceId, 'three', 200);
    report = await contentPerformanceReport(db, workspaceId);
    angle = report.learning.find((row) => row.dimension === 'angle' && row.value === 'observation');
    expect(angle).toMatchObject({
      sampleSize: 3,
      metricSampleSize: 3,
      medianImpressions: 200,
      eligibleForComparison: true
    });
    expect(angle?.summary).toContain('median 200 impressions across 3 posts');
  });

  it('refuses metric snapshots for another workspace or an unpublished draft', async () => {
    const workspaceId = await workspace('Metric scope');
    const other = await workspace('Other metric scope');
    const publication = await publishedStory(workspaceId, 'scope', null);
    await expect(
      appendLinkedInContentMetric(db, {
        workspaceId: other,
        postId: publication.postId,
        observedAt: NOW.toISOString(),
        impressions: 99
      })
    ).rejects.toThrow('Published content post not found');

    const story = await upsertContentOpportunity(
      db,
      {
        workspaceId,
        kind: 'company_change',
        title: 'Draft only',
        thesis: 'Not published.',
        freshnessAt: NOW.toISOString(),
        score: 80,
        rationale: [],
        fingerprint: 'draft-only',
        evidence: [
          {
            sourceType: 'external_observation',
            sourceId: 'draft-only',
            label: 'Draft evidence',
            detail: 'Still a draft.',
            sourceUrl: 'https://draft-only.example/',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );
    const asset = await createContentAsset(
      db,
      { workspaceId, opportunityId: story.id, format: 'text_post', angle: 'observation' },
      NOW
    );
    const draftId = id('lipost');
    await createPost(
      db,
      {
        id: draftId,
        workspaceId,
        blocks: [{ runs: [{ type: 'text', text: 'Draft' }] }],
        contentAssetId: asset.id
      },
      NOW
    );
    await expect(
      appendLinkedInContentMetric(db, {
        workspaceId,
        postId: draftId,
        observedAt: NOW.toISOString(),
        impressions: 99
      })
    ).rejects.toThrow('Published content post not found');
  });
});
