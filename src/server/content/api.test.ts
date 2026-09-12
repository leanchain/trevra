import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createAccount } from '../accounts/store.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { upsertContentOpportunity } from './opportunities.js';

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

function authed(method: 'get' | 'post' | 'patch', path: string) {
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
