import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createAccount } from '../accounts/store.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { createContentAsset } from './assets.js';
import { appendLinkedInContentMetric } from './performance.js';
import { upsertContentOpportunity } from './opportunities.js';
import { createPost, markPostPublished } from '../linkedin/posts.js';
import { upsertSeat } from '../linkedin/seats.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE = 'ws_content_api';
const OTHER = 'ws_content_api_other';
const USER = 'usr_content_api';
const NOW = new Date('2026-09-12T12:00:00.000Z');

async function seedSession(): Promise<string> {
  for (const [id, name] of [
    [WORKSPACE, 'Content API'],
    [OTHER, 'Other Content API']
  ] as const) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(id, name, NOW.toISOString());
  }
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER, WORKSPACE, 'content-api@trevra.test', 'Content API', NOW.toISOString());
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
  return token;
}

function authed(method: 'get' | 'post' | 'put' | 'patch', path: string) {
  return request(app)[method](path).set('Cookie', `trevra_session=${session}`);
}

async function seedStoryEvidence(): Promise<void> {
  const account = await createAccount(
    db,
    WORKSPACE,
    { domain: 'content-api.example', name: 'Content API Co', source: 'manual' },
    NOW
  );
  await db
    .prepare(
      `INSERT INTO account_scores
       (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      WORKSPACE,
      account.id,
      89,
      'hot',
      2,
      '2026-09-12T11:00:00.000Z',
      '{}',
      '2026-09-12T11:01:00.000Z'
    );
  for (const [id, kind, detail, url, at] of [
    [
      'sig_content_api_hiring',
      'hiring-up',
      'Added platform engineering roles.',
      'https://content-api.example/careers',
      '2026-09-12T10:00:00.000Z'
    ],
    [
      'sig_content_api_pricing',
      'pricing-changed',
      'Changed enterprise pricing.',
      'https://content-api.example/pricing',
      '2026-09-12T11:00:00.000Z'
    ]
  ] as const) {
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(id, WORKSPACE, account.id, kind, detail, url, at, `fp-${id}`, at);
  }
}

async function seedBrandWatchPulse(workspaceId: string, watchId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO brand_watches
       (id,workspace_id,name,keywords,platforms,cadence,enabled,limit_per_platform,next_run_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'daily',TRUE,25,?,?,?)`
    )
    .run(
      watchId,
      workspaceId,
      `${workspaceId} pulse watch`,
      ['trevra', 'founder'],
      ['hackernews', 'reddit'],
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString()
    );
  for (const [index, platform] of ['hackernews', 'reddit'].entries()) {
    const at = new Date(NOW.getTime() - index * 60 * 60 * 1000).toISOString();
    await db
      .prepare(
        `INSERT INTO brand_watch_mentions
         (id,workspace_id,watch_id,platform,external_id,url,title,content,author,community,
          score,num_comments,matched_keywords,sentiment_label,sentiment_score,sentiment_span,
          sentiment_version,content_hash,metadata_json,first_seen_at,last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?::jsonb,?,?)`
      )
      .run(
        `bwm_${workspaceId}_${index}`,
        workspaceId,
        watchId,
        platform,
        `${workspaceId}-${index}`,
        `https://${platform}.example/${workspaceId}/${index}`,
        `Founder discussion ${index + 1}`,
        `People are discussing Trevra founder workflows ${index + 1}.`,
        `author${index}`,
        platform === 'reddit' ? 'r/startups' : null,
        20 + index,
        4 + index,
        index === 0 ? ['trevra', 'founder'] : ['trevra'],
        index === 0 ? 'positive' : 'neutral',
        index === 0 ? 0.6 : 0,
        index === 0 ? 'positive discussion' : 'neutral discussion',
        1,
        `hash-${workspaceId}-${index}`,
        '{}',
        at,
        at
      );
  }
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const id of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
  app = createApp(db);
  session = await seedSession();
});

afterAll(async () => {
  for (const id of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
  await db.close();
  await closeAuthDatabase();
});

describe('content opportunity API', () => {
  it('keeps Brand-watch Pulse preview, drafting and schedules inside the authenticated workspace', async () => {
    const ownWatch = 'bw_content_api_own';
    const foreignWatch = 'bw_content_api_foreign';
    await seedBrandWatchPulse(WORKSPACE, ownWatch);
    await seedBrandWatchPulse(OTHER, foreignWatch);

    const preview = await authed(
      'get',
      `/api/content/pulse/watch/${encodeURIComponent(ownWatch)}?days=7`
    ).expect(200);
    expect(preview.body).toMatchObject({
      scope: { type: 'brand_watch', watchId: ownWatch },
      sourceCount: 2,
      platformCount: 2,
      canDraft: true
    });

    await authed(
      'get',
      `/api/content/pulse/watch/${encodeURIComponent(foreignWatch)}?days=7`
    ).expect(404);

    const drafted = await authed(
      'post',
      `/api/content/pulse/watch/${encodeURIComponent(ownWatch)}/draft`
    )
      .send({ days: 7 })
      .expect(200);
    expect(drafted.body.opportunity).toMatchObject({
      workspaceId: WORKSPACE,
      kind: 'watch_trend',
      status: 'ready'
    });

    await authed('post', `/api/content/pulse/watch/${encodeURIComponent(foreignWatch)}/draft`)
      .send({ days: 7 })
      .expect(404);

    const schedule = await authed('put', '/api/content/pulse/schedule')
      .send({
        scopeType: 'brand_watch',
        watchId: ownWatch,
        cadence: 'weekly',
        enabled: true
      })
      .expect(200);
    expect(schedule.body.schedule).toMatchObject({
      workspaceId: WORKSPACE,
      scopeType: 'brand_watch',
      watchId: ownWatch,
      cadence: 'weekly',
      enabled: true
    });

    await authed('put', '/api/content/pulse/schedule')
      .send({
        scopeType: 'brand_watch',
        watchId: foreignWatch,
        cadence: 'weekly',
        enabled: true
      })
      .expect(404);
    const schedules = await authed('get', '/api/content/pulse/schedules').expect(200);
    expect(schedules.body.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeType: 'brand_watch', watchId: ownWatch })
      ])
    );
    expect(JSON.stringify(schedules.body.schedules)).not.toContain(foreignWatch);

    await db
      .prepare("DELETE FROM content_opportunities WHERE workspace_id=? AND kind='watch_trend'")
      .run(WORKSPACE);
    await db.prepare('DELETE FROM brand_watches WHERE id IN (?,?)').run(ownWatch, foreignWatch);
  });

  it('refreshes only source-backed workspace stories and lets the founder dismiss one', async () => {
    await seedStoryEvidence();
    const before = await authed('get', '/api/content/opportunities').expect(200);
    expect(before.body.opportunities).toEqual([]);

    const refresh = await authed('post', '/api/content/opportunities/refresh').send({}).expect(200);
    expect(refresh.body.opportunities).toHaveLength(1);
    expect(refresh.body.opportunities[0]).toMatchObject({
      workspaceId: WORKSPACE,
      kind: 'company_change',
      score: 89
    });
    expect(refresh.body.opportunities[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceUrl: 'https://content-api.example/careers' }),
        expect.objectContaining({ sourceUrl: 'https://content-api.example/pricing' })
      ])
    );

    const storyId = refresh.body.opportunities[0].id as string;
    await authed('patch', `/api/content/opportunities/${encodeURIComponent(storyId)}`)
      .send({ status: 'dismissed' })
      .expect(200);
    expect(
      (await authed('get', '/api/content/opportunities').expect(200)).body.opportunities
    ).toEqual([]);
  });

  it('previews safe evidence-backed angles and persists only the founder-selected variant', async () => {
    await db
      .prepare("DELETE FROM content_opportunities WHERE workspace_id=? AND kind='company_change'")
      .run(WORKSPACE);
    await db
      .prepare("DELETE FROM accounts WHERE workspace_id=? AND domain='content-api.example'")
      .run(WORKSPACE);
    await seedStoryEvidence();
    const refresh = await authed('post', '/api/content/opportunities/refresh').send({}).expect(200);
    const storyId = String(refresh.body.opportunities[0]?.id ?? '');
    expect(storyId).not.toBe('');

    const preview = await authed(
      'get',
      `/api/content/opportunities/${encodeURIComponent(storyId)}/draft-variants`
    ).expect(200);
    expect(preview.body.strategy).toMatchObject({
      angle: 'observation',
      eligibleAngles: ['observation', 'teardown', 'list']
    });
    expect(preview.body.variants).toHaveLength(3);
    expect(
      new Set(preview.body.variants.map((variant: { body: string }) => variant.body)).size
    ).toBe(3);
    expect(preview.body.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ angle: 'observation', recommended: true }),
        expect.objectContaining({ angle: 'teardown', recommended: false }),
        expect.objectContaining({ angle: 'list', recommended: false })
      ])
    );
    for (const variant of preview.body.variants as Array<{
      claimMap: Array<{ evidence: Array<{ sourceUrl: string }> }>;
    }>) {
      expect(variant.claimMap.length).toBeGreaterThan(0);
      expect(variant.claimMap.every((claim) => claim.evidence.length > 0)).toBe(true);
      expect(
        variant.claimMap.every((claim) =>
          claim.evidence.every((evidence) => evidence.sourceUrl.startsWith('https://'))
        )
      ).toBe(true);
    }

    const canonical = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(storyId)}/draft-linkedin`
    )
      .send({})
      .expect(201);
    const teardown = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(storyId)}/draft-linkedin`
    )
      .send({ angle: 'teardown' })
      .expect(201);
    expect(teardown.body.post.id).not.toBe(canonical.body.post.id);
    expect(teardown.body.asset).toMatchObject({ angle: 'teardown' });
    const teardownReplay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(storyId)}/draft-linkedin`
    )
      .send({ angle: 'teardown' })
      .expect(200);
    expect(teardownReplay.body).toMatchObject({ reused: true });
    expect(teardownReplay.body.post.id).toBe(teardown.body.post.id);

    await authed('post', `/api/content/opportunities/${encodeURIComponent(storyId)}/draft-linkedin`)
      .send({ angle: 'comparison' })
      .expect(409);
  });

  it('keeps publication performance scoped to the authenticated workspace', async () => {
    for (const workspaceId of [WORKSPACE, OTHER]) {
      await upsertSeat(db, workspaceId, { label: 'Owner', timezone: 'UTC' }, NOW);
      const story = await upsertContentOpportunity(
        db,
        {
          workspaceId,
          kind: 'company_change',
          title: `${workspaceId} published story`,
          thesis: 'Published evidence.',
          freshnessAt: NOW.toISOString(),
          score: 88,
          rationale: [],
          fingerprint: `published-${workspaceId}`,
          evidence: [
            {
              sourceType: 'external_observation',
              sourceId: `evidence-${workspaceId}`,
              label: 'Observed change',
              detail: 'Observed change.',
              sourceUrl: `https://${workspaceId}.example/`,
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
      const postId = `lipost_${workspaceId}`;
      await createPost(
        db,
        {
          id: postId,
          workspaceId,
          blocks: [{ runs: [{ type: 'text', text: workspaceId }] }],
          contentAssetId: asset.id
        },
        NOW
      );
      await markPostPublished(
        db,
        postId,
        { postedUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${workspaceId}/` },
        NOW
      );
      await appendLinkedInContentMetric(
        db,
        {
          workspaceId,
          postId,
          observedAt: NOW.toISOString(),
          impressions: workspaceId === WORKSPACE ? 321 : 999
        },
        NOW
      );
    }

    const report = await authed('get', '/api/content/performance').expect(200);
    expect(report.body.totals.published).toBeGreaterThanOrEqual(1);
    expect(report.body.publications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          postId: `lipost_${WORKSPACE}`,
          latestMetrics: expect.objectContaining({ impressions: 321 })
        })
      ])
    );
    expect(report.body.publications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ postId: `lipost_${OTHER}` })])
    );
  });

  it('compiles a workspace-scoped market pulse and persists a recurring draft schedule', async () => {
    for (const [workspaceId, suffix] of [
      [WORKSPACE, 'own-a'],
      [WORKSPACE, 'own-b'],
      [OTHER, 'foreign']
    ] as const) {
      const account = await createAccount(
        db,
        workspaceId,
        {
          domain: `${suffix}.pulse-api.example`,
          name: suffix,
          source: 'manual',
          tags: ['pulse-api-test']
        },
        NOW
      );
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_pulse_${suffix}`,
          workspaceId,
          account.id,
          'hiring-up',
          `${suffix} added roles.`,
          `https://${suffix}.pulse-api.example/careers`,
          '2026-09-12T10:00:00.000Z',
          `fp-pulse-${suffix}`,
          '2026-09-12T10:00:00.000Z'
        );
    }

    const pulse = await authed('get', '/api/content/pulse?days=7&tag=pulse-api-test').expect(200);
    expect(pulse.body).toMatchObject({ accountCount: 2, changedAccountCount: 2, canDraft: true });
    expect(JSON.stringify(pulse.body)).not.toContain('foreign');

    const saved = await authed('put', '/api/content/pulse/schedule')
      .send({ cadence: 'weekly', enabled: true, tag: null })
      .expect(200);
    expect(saved.body.schedule).toMatchObject({
      workspaceId: WORKSPACE,
      cadence: 'weekly',
      enabled: true,
      tag: null
    });
    const schedules = await authed('get', '/api/content/pulse/schedules').expect(200);
    expect(schedules.body.schedules).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE, cadence: 'weekly', enabled: true })
    ]);
  });

  it('publishes an immutable public pulse snapshot and removes it from the public route on unpublish', async () => {
    for (const suffix of ['report-a', 'report-b', 'report-c'] as const) {
      const account = await createAccount(
        db,
        WORKSPACE,
        {
          domain: `${suffix}.public-report.example`,
          name: suffix,
          source: 'manual',
          tags: ['public-report-test']
        },
        NOW
      );
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_${suffix}`,
          WORKSPACE,
          account.id,
          'pricing-changed',
          `${suffix} changed pricing.`,
          `https://${suffix}.public-report.example/pricing`,
          '2026-09-12T10:30:00.000Z',
          `fp-${suffix}`,
          '2026-09-12T10:30:00.000Z'
        );
    }

    const customerCta = 'https://customer.example/demo?from=market-pulse';
    const created = await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test', ctaUrl: customerCta })
      .expect(201);
    expect(created.body.report).toMatchObject({
      workspaceId: WORKSPACE,
      status: 'published',
      template: 'market_pulse',
      ctaUrl: customerCta
    });
    const slug = created.body.report.slug as string;
    const publicPage = await request(app)
      .get(`/signals/${encodeURIComponent(slug)}`)
      .expect(200);
    expect(publicPage.text).toContain('report-a changed pricing.');
    expect(publicPage.text).toContain('report-b changed pricing.');
    expect(publicPage.text).toContain('Methodology');
    expect(publicPage.text).toContain('og:title');
    expect(publicPage.text).toContain('marketing-analytics.js');
    expect(publicPage.text).toContain(`data-public-report-slug="${slug}"`);
    expect(publicPage.text).toContain('https://customer.example/demo?');
    expect(publicPage.text).toContain('from=market-pulse');
    expect(publicPage.text).toContain('utm_source=trevra_public_report');
    expect(publicPage.text).toContain(`utm_campaign=${encodeURIComponent(slug)}`);
    expect(publicPage.text).not.toContain(WORKSPACE);
    expect(publicPage.text).not.toContain('sig_report-a');

    await request(app)
      .post('/api/marketing/events')
      .send({
        eventName: 'page_view',
        visitorId: 'report-reader-0001',
        workspaceId: OTHER,
        path: `/signals/${slug}`,
        metadata: { publicReportSlug: slug, publicReportTemplate: 'market_pulse' }
      })
      .expect(202);
    await request(app)
      .post('/api/marketing/events')
      .send({
        eventName: 'public_report_cta',
        visitorId: 'report-reader-0001',
        path: `/signals/${slug}`,
        metadata: { publicReportSlug: slug, publicReportTemplate: 'market_pulse' }
      })
      .expect(202);
    await request(app)
      .post('/api/marketing/events')
      .send({
        eventName: 'signup_completed',
        visitorId: 'report-reader-0001',
        path: '/signup',
        source: 'trevra_public_report',
        medium: 'report',
        campaign: slug,
        content: 'market_pulse'
      })
      .expect(202);

    const attributed = await db
      .prepare(
        `SELECT workspace_id,metadata_json FROM marketing_events
         WHERE event_name='page_view' AND path=? ORDER BY created_at DESC LIMIT 1`
      )
      .get<{ workspace_id: string; metadata_json: Record<string, unknown> }>(`/signals/${slug}`);
    expect(attributed?.workspace_id).toBe(WORKSPACE);
    expect(attributed?.metadata_json).toMatchObject({
      publicReportId: created.body.report.id,
      publicReportSlug: slug,
      publicReportTemplate: 'market_pulse'
    });

    const performance = await authed('get', '/api/content/public-reports/performance').expect(200);
    expect(performance.body.performance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reportId: created.body.report.id,
          slug,
          views: 1,
          uniqueVisitors: 1,
          ctaClicks: 1,
          ctaVisitors: 1,
          signupCompletions: 1
        })
      ])
    );

    const replay = await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test', ctaUrl: customerCta })
      .expect(201);
    expect(replay.body.report.id).toBe(created.body.report.id);
    expect(replay.body.report.slug).toBe(slug);

    const changedDestination = await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test', ctaUrl: 'https://customer.example/pricing' })
      .expect(201);
    expect(changedDestination.body.report.id).not.toBe(created.body.report.id);
    expect(changedDestination.body.report.ctaUrl).toBe('https://customer.example/pricing');

    await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test', ctaUrl: 'javascript:alert(1)' })
      .expect(400);

    await db
      .prepare("UPDATE account_signals SET detail='MUTATED PRIVATE STATE' WHERE id='sig_report-a'")
      .run();
    const frozen = await request(app)
      .get(`/signals/${encodeURIComponent(slug)}`)
      .expect(200);
    expect(frozen.text).toContain('report-a changed pricing.');
    expect(frozen.text).not.toContain('MUTATED PRIVATE STATE');

    const index = await authed('post', '/api/content/public-reports/index')
      .send({ days: 30, tag: 'public-report-test' })
      .expect(201);
    expect(index.body.report).toMatchObject({ template: 'index', status: 'published' });
    const indexPage = await request(app)
      .get(`/signals/${encodeURIComponent(index.body.report.slug)}`)
      .expect(200);
    expect(indexPage.text).toContain('Market Momentum Index');
    expect(indexPage.text).toContain('Diversity');
    expect(indexPage.text).toContain('Activity');
    expect(indexPage.text).toContain('Recency');
    expect(indexPage.text).toContain('MUTATED PRIVATE STATE');
    expect(indexPage.text).not.toContain(WORKSPACE);
    expect(indexPage.text).not.toContain('sig_report-a');

    await db
      .prepare("UPDATE account_signals SET detail='MUTATED AFTER INDEX' WHERE id='sig_report-a'")
      .run();
    const frozenIndex = await request(app)
      .get(`/signals/${encodeURIComponent(index.body.report.slug)}`)
      .expect(200);
    expect(frozenIndex.text).toContain('MUTATED PRIVATE STATE');
    expect(frozenIndex.text).not.toContain('MUTATED AFTER INDEX');

    const reports = await authed('get', '/api/content/public-reports').expect(200);
    expect(reports.body.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.body.report.id, status: 'published', slug }),
        expect.objectContaining({
          id: index.body.report.id,
          status: 'published',
          template: 'index'
        })
      ])
    );

    await authed(
      'post',
      `/api/content/public-reports/${encodeURIComponent(created.body.report.id)}/unpublish`
    )
      .send({})
      .expect(200);
    await request(app)
      .get(`/signals/${encodeURIComponent(slug)}`)
      .expect(404);
  });

  it('returns draft strategies only for ready stories in the authenticated workspace', async () => {
    const own = await upsertContentOpportunity(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'company_change',
        title: 'Own strategy story',
        thesis: 'Own evidence.',
        freshnessAt: NOW.toISOString(),
        score: 91,
        rationale: [],
        fingerprint: 'strategy-own',
        evidence: [
          {
            sourceType: 'external_observation',
            sourceId: 'strategy-own-evidence',
            label: 'own',
            detail: 'Own observed fact.',
            sourceUrl: 'https://strategy-own.example/',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );
    const foreign = await upsertContentOpportunity(
      db,
      {
        workspaceId: OTHER,
        kind: 'company_change',
        title: 'Foreign strategy story',
        thesis: 'Foreign evidence.',
        freshnessAt: NOW.toISOString(),
        score: 99,
        rationale: [],
        fingerprint: 'strategy-foreign',
        evidence: [
          {
            sourceType: 'external_observation',
            sourceId: 'strategy-foreign-evidence',
            label: 'foreign',
            detail: 'Foreign observed fact.',
            sourceUrl: 'https://strategy-foreign.example/',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );

    const result = await authed('get', '/api/content/draft-strategies?limit=200').expect(200);
    expect(result.body.strategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opportunityId: own.id,
          strategy: expect.objectContaining({ source: 'heuristic', minimumSample: 3 })
        })
      ])
    );
    expect(result.body.strategies).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ opportunityId: foreign.id })])
    );
  });

  it('creates one unscheduled LinkedIn draft per story+seat and cannot reach another workspace story', async () => {
    const story = await upsertContentOpportunity(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'company_change',
        title: 'Evidence story',
        thesis: 'Two current facts line up.',
        freshnessAt: NOW.toISOString(),
        score: 90,
        rationale: ['source-backed'],
        fingerprint: 'api-draft-story',
        evidence: [
          {
            sourceType: 'account_signal',
            sourceId: 'sig_api_draft',
            label: 'hiring up',
            detail: 'Added five roles.',
            sourceUrl: 'https://draft.example/careers',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );
    const first = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/draft-linkedin`
    )
      .send({ seatKey: 'owner' })
      .expect(201);
    expect(first.body).toMatchObject({
      reused: false,
      post: { status: 'draft', scheduledAt: null, publishedAt: null, postedUrl: null }
    });
    expect(first.body.post.contentAssetId).toBe(first.body.asset.id);

    const variants = await authed(
      'get',
      `/api/content/posts/${encodeURIComponent(first.body.post.id)}/channel-variants?channels=linkedin,x`
    ).expect(200);
    expect(variants.body.variants).toEqual([
      expect.objectContaining({
        key: 'linkedin',
        delivery: 'copy_only',
        post: expect.objectContaining({ channelKey: 'linkedin' })
      }),
      expect.objectContaining({
        key: 'x',
        delivery: 'copy_only',
        post: expect.objectContaining({ channelKey: 'x' })
      })
    ]);
    expect(variants.body.variants[1].post.body.length).toBeLessThanOrEqual(280);

    const replay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/draft-linkedin`
    )
      .send({ seatKey: 'owner' })
      .expect(200);
    expect(replay.body.reused).toBe(true);
    expect(replay.body.post.id).toBe(first.body.post.id);

    const card = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/evidence-card`
    )
      .send({ seatKey: 'owner', aspect: 'portrait' })
      .expect(201);
    expect(card.body).toMatchObject({
      reused: false,
      asset: { format: 'evidence_card' },
      post: { id: first.body.post.id, status: 'draft' }
    });
    expect(card.body.post.media).toHaveLength(1);
    expect(card.body.post.media[0]).toMatchObject({ mimeType: 'image/png' });

    const cardReplay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/evidence-card`
    )
      .send({ seatKey: 'owner', aspect: 'portrait' })
      .expect(200);
    expect(cardReplay.body.reused).toBe(true);
    expect(cardReplay.body.post.media).toHaveLength(1);

    const carousel = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/carousel`
    )
      .send({ seatKey: 'owner' })
      .expect(201);
    expect(carousel.body).toMatchObject({
      reused: false,
      asset: { format: 'carousel' },
      post: { status: 'draft' }
    });
    expect(carousel.body.post.id).not.toBe(first.body.post.id);
    expect(carousel.body.post.media).toHaveLength(3);

    const carouselReplay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/carousel`
    )
      .send({ seatKey: 'owner' })
      .expect(200);
    expect(carouselReplay.body.reused).toBe(true);
    expect(carouselReplay.body.post.id).toBe(carousel.body.post.id);
    expect(carouselReplay.body.post.media).toHaveLength(3);

    for (const [workspaceId, templateId] of [
      [WORKSPACE, 'fmt_api_own'],
      [OTHER, 'fmt_api_foreign']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO content_format_templates
           (id,workspace_id,status,name,source_kind,source_ref,structure_json,provenance_json,performance_json,fingerprint,created_at,updated_at)
           VALUES (?,?,'active',?,'own_published_post',?,?::jsonb,?::jsonb,?::jsonb,?,?,?)`
        )
        .run(
          templateId,
          workspaceId,
          'statement · bullet list · short',
          `${templateId}_post`,
          JSON.stringify({
            version: 1,
            hookType: 'statement',
            listStyle: 'bullet',
            rhythm: 'short',
            ctaType: 'none',
            paragraphCountBand: 'compact',
            evidenceSlots: 1,
            visualLayout: 'none'
          }),
          JSON.stringify({
            sourcePostIds: [`${templateId}_post_a`, `${templateId}_post_b`, `${templateId}_post_c`],
            extractedAt: NOW.toISOString()
          }),
          JSON.stringify({
            sampleSize: 3,
            metricSampleSize: 3,
            medianImpressions: 400,
            qualifiedDemand: 1,
            verifiedReplies: 1,
            opportunities: 0,
            won: 0
          }),
          `format-api-${templateId}`,
          NOW.toISOString(),
          NOW.toISOString()
        );
    }

    const templates = await authed('get', '/api/content/format-templates').expect(200);
    expect(templates.body.templates).toEqual([
      expect.objectContaining({ id: 'fmt_api_own', workspaceId: WORKSPACE, recommended: true })
    ]);

    const clone = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/clone-format`
    )
      .send({ templateId: 'fmt_api_own', seatKey: 'owner' })
      .expect(201);
    expect(clone.body).toMatchObject({
      reused: false,
      template: { id: 'fmt_api_own', workspaceId: WORKSPACE },
      post: { status: 'draft', scheduledAt: null }
    });
    expect(clone.body.post.id).not.toBe(first.body.post.id);

    const cloneReplay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/clone-format`
    )
      .send({ templateId: 'fmt_api_own', seatKey: 'owner' })
      .expect(200);
    expect(cloneReplay.body.reused).toBe(true);
    expect(cloneReplay.body.post.id).toBe(clone.body.post.id);

    await authed('post', `/api/content/opportunities/${encodeURIComponent(story.id)}/clone-format`)
      .send({ templateId: 'fmt_api_foreign' })
      .expect(404);

    const foreign = await upsertContentOpportunity(
      db,
      {
        workspaceId: OTHER,
        kind: 'company_change',
        title: 'Foreign story',
        thesis: 'Must stay foreign.',
        freshnessAt: NOW.toISOString(),
        score: 99,
        rationale: [],
        fingerprint: 'foreign-story',
        evidence: [
          {
            sourceType: 'external_observation',
            sourceId: 'foreign',
            label: 'foreign',
            detail: 'Foreign fact.',
            sourceUrl: 'https://foreign.example/',
            observedAt: NOW.toISOString()
          }
        ]
      },
      NOW
    );
    await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(foreign.id)}/draft-linkedin`
    )
      .send({})
      .expect(404);
    await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(foreign.id)}/evidence-card`
    )
      .send({})
      .expect(404);
    await authed('post', `/api/content/opportunities/${encodeURIComponent(foreign.id)}/carousel`)
      .send({})
      .expect(404);
    await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(foreign.id)}/clone-format`
    )
      .send({ templateId: 'fmt_api_own' })
      .expect(404);
  });
});
