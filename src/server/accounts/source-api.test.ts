import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { createApp } from '../app.js';
import { registerProvider } from '../research/registry.js';
import type { ResearchProvider } from '../research/types.js';

let db: Db;
let app: Express;
let session = '';

const WORKSPACE_ID = 'ws_account_source_api';
const USER_ID = 'usr_account_source_api';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE_ID, 'Account Source API', now);
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER_ID, WORKSPACE_ID, 'source-api@trevra.test', 'Source API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER_ID,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function asSession() {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `trevra_session=${session}`),
    post: (path: string) => request(app).post(path).set('Cookie', `trevra_session=${session}`)
  };
}

const memoryOnlyProvider: ResearchProvider = {
  key: 'test-memory-only',
  name: 'Test memory-only source',
  docsUrl: 'https://example.com/source-docs',
  credentialEnvVar: null,
  retention: 'none',
  availability() {
    return { mode: 'ready', reason: 'Test provider is ready.' };
  },
  async search() {
    return {
      providerKey: 'test-memory-only',
      candidates: [
        {
          domain: 'memory-only.example',
          name: 'Memory Only',
          description: null,
          providerKey: 'test-memory-only',
          sourceUrl: 'https://example.com/source'
        }
      ],
      warnings: [],
      evidence: []
    };
  }
};

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  registerProvider(memoryOnlyProvider);
  session = await seedSession();
  await db.prepare('DELETE FROM accounts WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM skill_runs WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('generic account sourcing API', () => {
  it('lists source metadata without credentials or deployment routing details', async () => {
    const response = await asSession().get('/api/accounts/source-providers').expect(200);
    const providers = response.body.providers as Array<{
      key: string;
      retention: string;
      availability: { mode: string };
    }>;
    expect(providers.find((provider) => provider.key === 'directory')).toMatchObject({
      retention: 'default',
      availability: { mode: 'ready' }
    });
    expect(providers.find((provider) => provider.key === 'test-memory-only')).toMatchObject({
      retention: 'none',
      availability: { mode: 'ready' }
    });
  });

  it('runs a storable provider through the skill ledger and converges into accounts', async () => {
    const first = await asSession()
      .post('/api/accounts/source')
      .send({
        provider: 'seed',
        domains: ['https://www.acme.com/pricing', 'acme.com', 'orbit.com'],
        limit: 10,
        tags: ['source-api']
      })
      .expect(201);

    expect(first.body.providerKey).toBe('seed');
    expect(first.body.found).toBe(2);
    expect(first.body.import.created).toBe(2);
    expect(first.body.import.duplicate).toBe(0);
    expect(first.body.runId).toMatch(/^run_/);

    const accounts = await db
      .prepare('SELECT domain,source,tags FROM accounts WHERE workspace_id=? ORDER BY domain')
      .all<{ domain: string; source: string; tags: string[] }>(WORKSPACE_ID);
    expect(accounts).toEqual([
      { domain: 'acme.com', source: 'sourced', tags: ['source-api'] },
      { domain: 'orbit.com', source: 'sourced', tags: ['source-api'] }
    ]);

    const ledger = await db
      .prepare(
        "SELECT skill_id,status FROM skill_runs WHERE workspace_id=? AND skill_id='gtm.source-leads' ORDER BY started_at DESC LIMIT 1"
      )
      .get<{ skill_id: string; status: string }>(WORKSPACE_ID);
    expect(ledger).toEqual({ skill_id: 'gtm.source-leads', status: 'ok' });

    const again = await asSession()
      .post('/api/accounts/source')
      .send({ provider: 'seed', domains: ['acme.com', 'orbit.com'], limit: 10 })
      .expect(200);
    expect(again.body.import.created).toBe(0);
    expect(again.body.import.duplicate).toBe(2);
  });

  it('refuses persistence when the selected provider declares memory-only retention', async () => {
    const response = await asSession()
      .post('/api/accounts/source')
      .send({ provider: 'test-memory-only', limit: 10 })
      .expect(409);

    expect(response.body.providerKey).toBe('test-memory-only');
    expect(response.body.found).toBe(1);
    expect(response.body.error).toContain('does not permit Trevra to persist');

    const stored = await db
      .prepare('SELECT id FROM accounts WHERE workspace_id=? AND domain=?')
      .get(WORKSPACE_ID, 'memory-only.example');
    expect(stored).toBeUndefined();
  });
});
