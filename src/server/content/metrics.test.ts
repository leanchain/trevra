import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { appendContentPublicationMetric, listContentPublicationMetrics } from './metrics.js';

let db: Db;
const A = 'ws_content_metrics_a';
const B = 'ws_content_metrics_b';
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

describe('content publication metrics', () => {
  it('is append-only across observation timestamps and workspace scoped', async () => {
    const first = await appendContentPublicationMetric(
      db,
      {
        workspaceId: A,
        channel: 'linkedin',
        publicationId: 'post_1',
        observedAt: '2026-09-12T10:00:00.000Z',
        impressions: 100,
        reactions: 5,
        raw: { sample: 'first' }
      },
      NOW
    );
    const replay = await appendContentPublicationMetric(
      db,
      {
        workspaceId: A,
        channel: 'linkedin',
        publicationId: 'post_1',
        observedAt: '2026-09-12T10:00:00.000Z',
        impressions: 999,
        raw: { sample: 'overwrite-attempt' }
      },
      new Date('2026-09-12T12:05:00.000Z')
    );
    await appendContentPublicationMetric(
      db,
      {
        workspaceId: A,
        channel: 'linkedin',
        publicationId: 'post_1',
        observedAt: '2026-09-12T11:00:00.000Z',
        impressions: 140,
        reactions: 8
      },
      NOW
    );
    expect(replay.id).toBe(first.id);
    expect(replay.impressions).toBe(100);
    expect(replay.raw).toEqual({ sample: 'first' });
    const series = await listContentPublicationMetrics(db, A, 'linkedin', 'post_1');
    expect(series.map((row) => row.impressions)).toEqual([100, 140]);
    expect(await listContentPublicationMetrics(db, B, 'linkedin', 'post_1')).toEqual([]);
  });

  it('does not turn unavailable metrics into zero and rejects negative measurements', async () => {
    const snapshot = await appendContentPublicationMetric(
      db,
      {
        workspaceId: A,
        channel: 'linkedin',
        publicationId: 'post_2',
        observedAt: NOW.toISOString(),
        comments: null
      },
      NOW
    );
    expect(snapshot.comments).toBeNull();
    expect(snapshot.clicks).toBeNull();
    await expect(
      appendContentPublicationMetric(
        db,
        {
          workspaceId: A,
          channel: 'linkedin',
          publicationId: 'post_3',
          observedAt: NOW.toISOString(),
          impressions: -1
        },
        NOW
      )
    ).rejects.toThrow('non-negative');
  });
});
