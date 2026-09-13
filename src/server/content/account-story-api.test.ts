import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';

const WORKSPACE = 'ws_account_story_api';
const OTHER = 'ws_account_story_api_other';
const USER = 'usr_account_story_api';
const NOW = new Date('2026-09-13T09:20:00.000Z');
let db: Db;
let app: Express;
let session = '';

async function seedSession(): Promise<string> {
  for (const [id, name] of [
    [WORKSPACE, 'Account Story API'],
    [OTHER, 'Other Account Story API']
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
    .run(USER, WORKSPACE, 'account-story-api@trevra.test', 'Account Story API', NOW.toISOString());
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

function post(path: string) {
  return request(app).post(path).set('Cookie', `trevra_session=${session}`);
}

async function seedScoredAccount(input: {
  workspaceId: string;
  domain: string;
  name: string;
  score: number;
  tier: 'hot' | 'warm';
  signals: Array<{ id: string; kind: string; detail: string; url: string; at: string }>;
}) {
  const account = await createAccount(
    db,
    input.workspaceId,
    { domain: input.domain, name: input.name, source: 'manual' },
    NOW
  );
  await db
    .prepare(
      `INSERT INTO account_scores
       (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      input.workspaceId,
      account.id,
      input.score,
      input.tier,
      new Set(input.signals.map((signal) => signal.kind)).size,
      input.signals.at(-1)?.at ?? NOW.toISOString(),
      '{}',
      NOW.toISOString()
    );
  for (const signal of input.signals) {
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        signal.id,
        input.workspaceId,
        account.id,
        signal.kind,
        signal.detail,
        signal.url,
        signal.at,
        `fp-${signal.id}`,
        signal.at
      );
  }
  return account;
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
});

beforeEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM content_opportunities WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM accounts WHERE workspace_id=?').run(workspaceId);
  }
});

afterAll(async () => {
  await db.close();
  await closeAuthDatabase();
});

describe('account content opportunity API', () => {
  it('materializes one source-backed story for an eligible account and reuses it', async () => {
    const account = await seedScoredAccount({
      workspaceId: WORKSPACE,
      domain: 'account-story.example',
      name: 'Account Story',
      score: 86,
      tier: 'hot',
      signals: [
        {
          id: 'sig_account_story_hiring',
          kind: 'hiring-up',
          detail: 'Added platform roles.',
          url: 'https://account-story.example/careers',
          at: '2026-09-13T08:00:00.000Z'
        },
        {
          id: 'sig_account_story_pricing',
          kind: 'pricing-changed',
          detail: 'Changed enterprise pricing.',
          url: 'https://account-story.example/pricing',
          at: '2026-09-13T08:30:00.000Z'
        }
      ]
    });

    const first = await post(`/api/accounts/${account.id}/content-opportunity`)
      .send({})
      .expect(200);
    const second = await post(`/api/accounts/${account.id}/content-opportunity`)
      .send({})
      .expect(200);
    expect(first.body.opportunity).toMatchObject({
      workspaceId: WORKSPACE,
      kind: 'company_change',
      status: 'ready',
      score: 86
    });
    expect(first.body.opportunity.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceUrl: 'https://account-story.example/careers' }),
        expect.objectContaining({ sourceUrl: 'https://account-story.example/pricing' })
      ])
    );
    expect(second.body.opportunity.id).toBe(first.body.opportunity.id);
  });

  it('refuses insufficient evidence and another workspace account', async () => {
    const weak = await seedScoredAccount({
      workspaceId: WORKSPACE,
      domain: 'weak-story.example',
      name: 'Weak Story',
      score: 31,
      tier: 'warm',
      signals: [
        {
          id: 'sig_weak_story_hiring',
          kind: 'hiring-up',
          detail: 'Added one role.',
          url: 'https://weak-story.example/careers',
          at: '2026-09-13T08:00:00.000Z'
        }
      ]
    });
    const foreign = await seedScoredAccount({
      workspaceId: OTHER,
      domain: 'foreign-story.example',
      name: 'Foreign Story',
      score: 92,
      tier: 'hot',
      signals: [
        {
          id: 'sig_foreign_story_hiring',
          kind: 'hiring-up',
          detail: 'Added roles.',
          url: 'https://foreign-story.example/careers',
          at: '2026-09-13T08:00:00.000Z'
        },
        {
          id: 'sig_foreign_story_pricing',
          kind: 'pricing-changed',
          detail: 'Changed pricing.',
          url: 'https://foreign-story.example/pricing',
          at: '2026-09-13T08:30:00.000Z'
        }
      ]
    });

    await post(`/api/accounts/${weak.id}/content-opportunity`).send({}).expect(409);
    await post(`/api/accounts/${foreign.id}/content-opportunity`).send({}).expect(404);
  });
});
