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

    const created = await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test' })
      .expect(201);
    expect(created.body.report).toMatchObject({
      workspaceId: WORKSPACE,
      status: 'published',
      template: 'market_pulse'
    });
    const slug = created.body.report.slug as string;
    const publicPage = await request(app)
      .get(`/signals/${encodeURIComponent(slug)}`)
      .expect(200);
    expect(publicPage.text).toContain('report-a changed pricing.');
    expect(publicPage.text).toContain('report-b changed pricing.');
    expect(publicPage.text).toContain('Methodology');
    expect(publicPage.text).toContain('og:title');
    expect(publicPage.text).not.toContain(WORKSPACE);
    expect(publicPage.text).not.toContain('sig_report-a');

    const replay = await authed('post', '/api/content/public-reports/market-pulse')
      .send({ days: 7, tag: 'public-report-test' })
      .expect(201);
    expect(replay.body.report.id).toBe(created.body.report.id);
    expect(replay.body.report.slug).toBe(slug);

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

    const replay = await authed(
      'post',
      `/api/content/opportunities/${encodeURIComponent(story.id)}/draft-linkedin`
    )
      .send({ seatKey: 'owner' })
      .expect(200);
    expect(replay.body.reused).toBe(true);
    expect(replay.body.post.id).toBe(first.body.post.id);

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
  });
});
