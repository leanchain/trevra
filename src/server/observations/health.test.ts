import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  listObservationProviderHealth,
  recordObservationProviderFailure,
  recordObservationProviderSuccess
} from './health.js';

const WORKSPACE = 'ws_observation_health_test';
const OTHER_WORKSPACE = 'ws_observation_health_other';
const T0 = new Date('2026-09-12T08:00:00.000Z');
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, workspaceId, T0.toISOString());
    await db
      .prepare(
        "DELETE FROM research_snapshots WHERE workspace_id=? AND domain LIKE 'observation-health:%'"
      )
      .run(workspaceId);
  }
});

afterEach(async () => {
  await db?.close();
});

function byKey(rows: Awaited<ReturnType<typeof listObservationProviderHealth>>, key: string) {
  const row = rows.find((entry) => entry.key === key);
  if (!row) throw new Error(`provider ${key} missing`);
  return row;
}

describe('observation provider health', () => {
  it('shows built-ins even when optional credentials are not configured', async () => {
    const priorYouTube = process.env.TREVRA_YOUTUBE_API_KEY;
    const priorMeta = process.env.TREVRA_META_GRAPH_ACCESS_TOKEN;
    const priorInstagram = process.env.TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID;
    delete process.env.TREVRA_YOUTUBE_API_KEY;
    delete process.env.TREVRA_META_GRAPH_ACCESS_TOKEN;
    delete process.env.TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID;
    try {
      const rows = await listObservationProviderHealth(db, WORKSPACE, T0);
      expect(byKey(rows, 'substack-public-feed').availability.mode).toBe('ready');
      expect(byKey(rows, 'youtube-data-api').availability.mode).toBe('needs-credential');
      expect(byKey(rows, 'instagram-business-discovery').availability.mode).toBe(
        'needs-credential'
      );
    } finally {
      if (priorYouTube === undefined) delete process.env.TREVRA_YOUTUBE_API_KEY;
      else process.env.TREVRA_YOUTUBE_API_KEY = priorYouTube;
      if (priorMeta === undefined) delete process.env.TREVRA_META_GRAPH_ACCESS_TOKEN;
      else process.env.TREVRA_META_GRAPH_ACCESS_TOKEN = priorMeta;
      if (priorInstagram === undefined) delete process.env.TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID;
      else process.env.TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID = priorInstagram;
    }
  });

  it('persists success, warning and failure without multiplying health rows', async () => {
    await recordObservationProviderSuccess(
      db,
      WORKSPACE,
      'substack-public-feed',
      T0,
      'One target feed was incomplete.'
    );
    let row = byKey(await listObservationProviderHealth(db, WORKSPACE, T0), 'substack-public-feed');
    expect(row.operationalStatus).toBe('warning');
    expect(row.lastSuccessAt).toBe(T0.toISOString());
    expect(row.lastWarning).toContain('incomplete');

    const failedAt = new Date(T0.getTime() + 60_000);
    await recordObservationProviderFailure(
      db,
      WORKSPACE,
      'substack-public-feed',
      failedAt,
      new Error('transport failed')
    );
    row = byKey(
      await listObservationProviderHealth(db, WORKSPACE, failedAt),
      'substack-public-feed'
    );
    expect(row.operationalStatus).toBe('error');
    expect(row.lastSuccessAt).toBe(T0.toISOString());
    expect(row.lastError).toBe('transport failed');
    expect(row.consecutiveFailures).toBe(1);

    const count = await db
      .prepare(
        "SELECT COUNT(*)::int AS n FROM research_snapshots WHERE workspace_id=? AND domain='observation-health:substack-public-feed'"
      )
      .get<{ n: number }>(WORKSPACE);
    expect(count?.n).toBe(1);
  });

  it('marks an old successful provider stale and keeps health workspace-scoped', async () => {
    await recordObservationProviderSuccess(db, WORKSPACE, 'substack-public-feed', T0);
    const muchLater = new Date(T0.getTime() + 40 * 60 * 60 * 1_000);
    const own = byKey(
      await listObservationProviderHealth(db, WORKSPACE, muchLater),
      'substack-public-feed'
    );
    const other = byKey(
      await listObservationProviderHealth(db, OTHER_WORKSPACE, muchLater),
      'substack-public-feed'
    );
    expect(own.operationalStatus).toBe('stale');
    expect(other.operationalStatus).toBe('ready');
    expect(other.lastSuccessAt).toBeNull();
  });
});
