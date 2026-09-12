import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { createAccount, getAccount } from './store.js';

const WORKSPACE = 'ws_account_identity_api';
const OTHER_WORKSPACE = 'ws_account_identity_other';
const USER = 'usr_account_identity_api';
let db: Db;
let app: Express;
let session = '';

async function seedSession(): Promise<string> {
  const now = new Date().toISOString();
  for (const [id, name] of [
    [WORKSPACE, 'Account Identity API'],
    [OTHER_WORKSPACE, 'Other Workspace']
  ] as const) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(id, name, now);
  }
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER, WORKSPACE, 'identity-api@trevra.test', 'Identity API', now);
  const token = randomBytes(24).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      now
    );
  return token;
}

function patch(path: string) {
  return request(app).patch(path).set('Cookie', `trevra_session=${session}`);
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  session = await seedSession();
});

beforeEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.prepare('DELETE FROM accounts WHERE workspace_id=?').run(workspaceId);
  }
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('account observation identity API', () => {
  it('sets and clears an exact Meta Page ID while preserving workspace isolation', async () => {
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'identity.example', source: 'manual', tags: ['dach'] },
      new Date('2026-09-12T10:00:00.000Z')
    );
    const other = await createAccount(
      db,
      OTHER_WORKSPACE,
      { domain: 'other.example', source: 'manual' },
      new Date('2026-09-12T10:00:00.000Z')
    );

    const saved = await patch(`/api/accounts/${account.id}/observation-identity`)
      .send({ metaPageId: '123456789012345' })
      .expect(200);
    expect(saved.body.account.tags).toEqual(['dach', 'meta-page-id:123456789012345']);
    expect(saved.body.account.nextSweepAt).toBeTruthy();

    await patch(`/api/accounts/${account.id}/observation-identity`)
      .send({ metaPageId: 'brand-name' })
      .expect(400);
    expect((await getAccount(db, WORKSPACE, account.id))?.tags).toEqual([
      'dach',
      'meta-page-id:123456789012345'
    ]);

    await patch(`/api/accounts/${other.id}/observation-identity`)
      .send({ metaPageId: '99999' })
      .expect(404);
    expect((await getAccount(db, OTHER_WORKSPACE, other.id))?.tags).toEqual([]);

    const cleared = await patch(`/api/accounts/${account.id}/observation-identity`)
      .send({ metaPageId: null })
      .expect(200);
    expect(cleared.body.account.tags).toEqual(['dach']);
  });
});
