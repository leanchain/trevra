import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  listContentOpportunities,
  setContentOpportunityStatus,
  upsertContentOpportunity
} from './opportunities.js';

let db: Db;
const A = 'ws_content_opportunity_a';
const B = 'ws_content_opportunity_b';
const NOW = new Date('2026-09-12T12:00:00.000Z');
const evidence = [
  {
    sourceType: 'account_signal' as const,
    sourceId: 'sig_1',
    label: 'hiring up',
    detail: 'Added five platform roles.',
    sourceUrl: 'https://acme.example/careers',
    observedAt: '2026-09-12T10:00:00.000Z'
  }
];

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

describe('content opportunities', () => {
  it('is workspace scoped and dedupes by deterministic fingerprint', async () => {
    const first = await upsertContentOpportunity(
      db,
      {
        workspaceId: A,
        kind: 'company_change',
        title: 'Acme changed',
        thesis: 'Several independent changes line up.',
        freshnessAt: '2026-09-12T10:00:00.000Z',
        score: 88,
        rationale: ['two signal kinds'],
        evidence,
        fingerprint: 'company_change:acme:one'
      },
      NOW
    );
    const replay = await upsertContentOpportunity(
      db,
      {
        workspaceId: A,
        kind: 'company_change',
        title: 'Acme changed again',
        thesis: 'The same evidence cluster is still current.',
        freshnessAt: '2026-09-12T11:00:00.000Z',
        score: 91,
        rationale: ['same cluster'],
        evidence,
        fingerprint: 'company_change:acme:one'
      },
      new Date('2026-09-12T12:05:00.000Z')
    );

    expect(replay.id).toBe(first.id);
    expect(replay.score).toBe(91);
    expect(await listContentOpportunities(db, A)).toHaveLength(1);
    expect(await listContentOpportunities(db, B)).toEqual([]);
  });

  it('does not resurrect a dismissed story when its builder runs again', async () => {
    const first = await upsertContentOpportunity(
      db,
      {
        workspaceId: A,
        kind: 'company_change',
        title: 'Dismiss me',
        thesis: 'Evidence exists.',
        freshnessAt: '2026-09-12T10:00:00.000Z',
        score: 80,
        rationale: [],
        evidence,
        fingerprint: 'dismissed'
      },
      NOW
    );
    await setContentOpportunityStatus(db, A, first.id, 'dismissed', NOW);
    const replay = await upsertContentOpportunity(
      db,
      {
        workspaceId: A,
        kind: 'company_change',
        title: 'Do not revive',
        thesis: 'Still evidence.',
        freshnessAt: '2026-09-12T11:00:00.000Z',
        score: 99,
        rationale: [],
        evidence,
        fingerprint: 'dismissed'
      },
      new Date('2026-09-12T12:10:00.000Z')
    );
    expect(replay.status).toBe('dismissed');
    expect(replay.title).toBe('Dismiss me');
  });

  it('rejects evidence without a URL rather than creating an unauditable story', async () => {
    await expect(
      upsertContentOpportunity(
        db,
        {
          workspaceId: A,
          kind: 'company_change',
          title: 'Bad evidence',
          thesis: 'No source.',
          freshnessAt: NOW.toISOString(),
          score: 50,
          rationale: [],
          evidence: [{ ...evidence[0]!, sourceUrl: '' }],
          fingerprint: 'bad'
        },
        NOW
      )
    ).rejects.toThrow('source URL');
  });
});
