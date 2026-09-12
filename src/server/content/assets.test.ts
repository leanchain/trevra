import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  createContentAsset,
  getContentAsset,
  listContentAssets,
  updateContentAsset
} from './assets.js';
import { upsertContentOpportunity } from './opportunities.js';

let db: Db;
const A = 'ws_content_assets_a';
const B = 'ws_content_assets_b';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const id of [A, B]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(id, id, NOW.toISOString());
  }
});
afterEach(async () => {
  for (const id of [A, B]) await db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
  await db.close();
});

async function opportunity() {
  return upsertContentOpportunity(
    db,
    {
      workspaceId: A,
      kind: 'company_change',
      title: 'Story',
      thesis: 'Two facts line up.',
      freshnessAt: NOW.toISOString(),
      score: 90,
      rationale: ['two facts'],
      fingerprint: 'asset-story',
      evidence: [
        {
          sourceType: 'account_signal',
          sourceId: 'sig_asset',
          label: 'hiring',
          detail: 'Hiring rose.',
          sourceUrl: 'https://asset.example/careers',
          observedAt: NOW.toISOString()
        }
      ]
    },
    NOW
  );
}

describe('content assets', () => {
  it('keeps assets workspace scoped and preserves claim evidence', async () => {
    const story = await opportunity();
    const asset = await createContentAsset(
      db,
      {
        workspaceId: A,
        opportunityId: story.id,
        format: 'text_post',
        angle: 'observation',
        hook: 'Something changed',
        body: 'Hiring rose.',
        claimMap: [{ claim: 'Hiring rose.', evidence: story.evidence }],
        generation: { mode: 'deterministic' },
        createdBy: 'usr_1'
      },
      NOW
    );
    expect((await getContentAsset(db, A, asset.id))?.claimMap[0]?.evidence[0]?.sourceUrl).toBe(
      'https://asset.example/careers'
    );
    expect(await getContentAsset(db, B, asset.id)).toBeNull();
    expect(await listContentAssets(db, A, story.id)).toHaveLength(1);
    expect(await listContentAssets(db, B)).toEqual([]);
  });

  it('refuses a cross-workspace opportunity reference', async () => {
    const story = await opportunity();
    await expect(
      createContentAsset(
        db,
        { workspaceId: B, opportunityId: story.id, format: 'text_post', angle: 'observation' },
        NOW
      )
    ).rejects.toThrow('not found');
  });

  it('updates review state without changing workspace ownership', async () => {
    const asset = await createContentAsset(
      db,
      { workspaceId: A, format: 'text_post', angle: 'list' },
      NOW
    );
    const approved = await updateContentAsset(
      db,
      A,
      asset.id,
      { status: 'approved', body: 'Approved body.' },
      NOW
    );
    expect(approved).toMatchObject({ status: 'approved', body: 'Approved body.', workspaceId: A });
  });
});
