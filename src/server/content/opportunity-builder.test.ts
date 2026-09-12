import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { runAutomationCycle } from '../automation-service.js';
import { openDatabase, type Db } from '../db.js';
import { buildCompanyChangeOpportunities } from './opportunity-builder.js';
import { listContentOpportunities } from './opportunities.js';

let db: Db;
const WORKSPACE = 'ws_content_builder';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Content builder', NOW.toISOString());
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db.close();
});

async function seedAccount(signalCount = 2) {
  const account = await createAccount(
    db,
    WORKSPACE,
    { domain: 'story.example', name: 'Story Co', source: 'manual' },
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
      84,
      'hot',
      signalCount,
      '2026-09-12T11:00:00.000Z',
      '{}',
      '2026-09-12T11:01:00.000Z'
    );
  const rows = [
    [
      'sig_story_hiring',
      'hiring-up',
      'Added platform roles.',
      'https://story.example/careers',
      '2026-09-12T10:00:00.000Z'
    ],
    [
      'sig_story_pricing',
      'pricing-changed',
      'Changed enterprise pricing.',
      'https://story.example/pricing',
      '2026-09-12T11:00:00.000Z'
    ]
  ].slice(0, signalCount);
  for (const [id, kind, detail, url, at] of rows) {
    await db
      .prepare(
        `INSERT INTO account_signals
      (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(id, WORKSPACE, account.id, kind, detail, url, at, `fp-${id}`, at);
  }
  return account;
}

describe('buildCompanyChangeOpportunities', () => {
  it('creates one evidence-backed story and is idempotent for the same evidence cluster', async () => {
    const account = await seedAccount(2);
    const first = await buildCompanyChangeOpportunities(db, WORKSPACE, NOW);
    const second = await buildCompanyChangeOpportunities(
      db,
      WORKSPACE,
      new Date('2026-09-12T12:05:00.000Z')
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(first[0]).toMatchObject({ kind: 'company_change', score: 84, status: 'ready' });
    expect(first[0]?.title).toContain('Story Co');
    expect(first[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'sig_story_hiring',
          sourceUrl: 'https://story.example/careers'
        }),
        expect.objectContaining({
          sourceId: 'sig_story_pricing',
          sourceUrl: 'https://story.example/pricing'
        })
      ])
    );
    expect(await listContentOpportunities(db, WORKSPACE)).toHaveLength(1);
    expect(first[0]?.fingerprint).toContain('company_change:');
    expect(account.id).toBeTruthy();
  });

  it('creates no story when only one inspectable signal kind exists', async () => {
    await seedAccount(1);
    expect(await buildCompanyChangeOpportunities(db, WORKSPACE, NOW)).toEqual([]);
  });

  it('refreshes story opportunities inside the existing leased workspace automation cycle', async () => {
    const account = await seedAccount(2);
    // Avoid a network sweep in this integration test; story/recommendation
    // projections still run for the workspace regardless of account sweepability.
    await db
      .prepare("UPDATE accounts SET status='archived' WHERE workspace_id=? AND id=?")
      .run(WORKSPACE, account.id);

    const result = await runAutomationCycle(db, WORKSPACE);

    expect(result.failed).toBe(0);
    expect(await listContentOpportunities(db, WORKSPACE, { status: 'ready' })).toHaveLength(1);
  });
});
