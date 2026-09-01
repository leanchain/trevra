import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEMO_WORKSPACE_ID,
  migrationDirectory,
  openDatabase,
  resetDemoData,
  type Db
} from '../db.js';
import {
  createWatch,
  deleteWatch,
  getWatch,
  getWatchMention,
  listWatchMentions,
  listWatches,
  markMentionPromoted,
  recordWatchMentions,
  sentimentTrend,
  updateWatch
} from './store.js';
import { scoreSentiment } from './sentiment.js';
import type { OutreachThread } from '../outreach/types.js';

let db: Db;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const OTHER_WORKSPACE = 'ws_other';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  // The fixed OTHER_WORKSPACE id (unlike a fresh id('ws') per test) would
  // otherwise leak a workspace -- and any watch created in it -- into every
  // later test in this file; resetDemoData only clears DEMO_WORKSPACE_ID.
  // Precedent: research/service.test.ts's afterEach workspace cleanup.
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(OTHER_WORKSPACE);
  await db?.close();
});

const INPUT = {
  name: 'Trevra',
  keywords: ['trevra', 'cold outreach'],
  platforms: ['hackernews', 'github'],
  cadence: 'daily' as const
};

describe('brand watch store', () => {
  it('creates a watch that is due immediately and defaults its limit', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(watch.name).toBe('Trevra');
    expect(watch.keywords).toEqual(['trevra', 'cold outreach']);
    expect(watch.platforms).toEqual(['hackernews', 'github']);
    expect(watch.cadence).toBe('daily');
    expect(watch.enabled).toBe(true);
    expect(watch.limitPerPlatform).toBe(25);
    expect(watch.lastRunAt).toBeNull();
    expect(watch.lastRunWarnings).toEqual([]);
    expect(new Date(watch.nextRunAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('rejects a second watch with the same name in one workspace', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await expect(createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW)).rejects.toThrow();
  });

  it('allows the same watch name in a different workspace', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(OTHER_WORKSPACE, 'Other', NOW.toISOString());
    const other = await createWatch(db, OTHER_WORKSPACE, INPUT, NOW);
    expect(other.workspaceId).toBe(OTHER_WORKSPACE);
  });

  it('lists only this workspace’s watches', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const rows = await listWatches(db, DEMO_WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(await listWatches(db, OTHER_WORKSPACE)).toEqual([]);
  });

  it('patches only the supplied fields', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const patched = await updateWatch(
      db,
      DEMO_WORKSPACE_ID,
      created.id,
      { cadence: 'weekly', enabled: false },
      NOW
    );
    expect(patched?.cadence).toBe('weekly');
    expect(patched?.enabled).toBe(false);
    expect(patched?.keywords).toEqual(['trevra', 'cold outreach']);
    expect(patched?.platforms).toEqual(['hackernews', 'github']);
  });

  it('will not read, patch or delete another workspace’s watch', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(await getWatch(db, OTHER_WORKSPACE, created.id)).toBeNull();
    expect(
      await updateWatch(db, OTHER_WORKSPACE, created.id, { cadence: 'weekly' }, NOW)
    ).toBeNull();
    expect(await deleteWatch(db, OTHER_WORKSPACE, created.id)).toBe(false);
    expect(await getWatch(db, DEMO_WORKSPACE_ID, created.id)).not.toBeNull();
  });

  it('deletes a watch and reports whether it existed', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(await deleteWatch(db, DEMO_WORKSPACE_ID, created.id)).toBe(true);
    expect(await deleteWatch(db, DEMO_WORKSPACE_ID, created.id)).toBe(false);
  });
});

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'hackernews',
    externalId: 'hn1',
    url: 'https://news.ycombinator.com/item?id=hn1',
    title: 'Trevra thread',
    content: 'Trevra is excellent.',
    author: 'someone',
    community: null,
    score: 12,
    numComments: 3,
    createdAt: '2026-09-01T08:00:00.000Z',
    metadata: {},
    ...overrides
  };
}

function mention(overrides: Partial<OutreachThread> = {}) {
  const row = thread(overrides);
  return { thread: row, matchedKeywords: ['trevra'], sentiment: scoreSentiment(row.content) };
}

describe('brand watch mentions', () => {
  it('records a new mention and increments exactly one rollup day', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const result = await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention()], NOW);
    expect(result).toEqual({ inserted: 1, updated: 0 });

    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 7, NOW);
    const day = trend.find((point) => point.day === '2026-09-01');
    expect(day).toMatchObject({ positive: 1, neutral: 0, negative: 0 });
    expect(day?.average).toBeGreaterThan(0);
  });

  it('re-polling the same mention updates it and does not double-count the rollup', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention()], NOW);
    const again = await recordWatchMentions(
      db,
      DEMO_WORKSPACE_ID,
      watch.id,
      [mention({ score: 40 })],
      new Date('2026-09-02T09:00:00.000Z')
    );
    expect(again).toEqual({ inserted: 0, updated: 1 });

    const rows = await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(40);

    const trend = await sentimentTrend(
      db,
      DEMO_WORKSPACE_ID,
      watch.id,
      7,
      new Date('2026-09-02T09:00:00.000Z')
    );
    expect(trend.reduce((sum, point) => sum + point.positive, 0)).toBe(1);
  });

  it('buckets on the discovery day (first_seen_at), not the thread’s own creation date', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    // mention_created_at falls inside this same 7-day window. Under the old
    // COALESCE(mention_created_at, first_seen_at) rule this thread would land
    // on 2026-08-28, not today -- so unlike the previous version of this test
    // (which used createdAt: null and got the same bucket under both rules by
    // coincidence), this fixture actually catches a regression to the old rule.
    await recordWatchMentions(
      db,
      DEMO_WORKSPACE_ID,
      watch.id,
      [mention({ createdAt: '2026-08-28T00:00:00.000Z' })],
      NOW
    );
    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 7, NOW);
    expect(trend.find((point) => point.day === '2026-09-01')?.positive).toBe(1);
    expect(trend.find((point) => point.day === '2026-08-28')?.positive).toBe(0);
  });

  it('still buckets on first_seen_at when the platform reported no creation time', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention({ createdAt: null })], NOW);
    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 7, NOW);
    expect(trend.find((point) => point.day === '2026-09-01')?.positive).toBe(1);
  });

  it('a years-old mention_created_at still lands on today’s rollup and appears in a 30-day trend', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    // HN's Algolia /search is relevance-ranked, GitHub sorts by `updated`,
    // Stack Overflow returns newest-matching -- so a real mention's own
    // creation date is routinely months or years old. Bucketing on it would
    // put the mention permanently outside any 30-day discovery window.
    await recordWatchMentions(
      db,
      DEMO_WORKSPACE_ID,
      watch.id,
      [mention({ createdAt: '2019-03-04T00:00:00.000Z' })],
      NOW
    );
    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 30, NOW);
    expect(trend).toHaveLength(30);
    expect(trend[29].day).toBe('2026-09-01');
    expect(trend[29].positive).toBe(1);
  });

  it('gives two watches their own row for the same url', async () => {
    const first = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const second = await createWatch(db, DEMO_WORKSPACE_ID, { ...INPUT, name: 'Second' }, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, first.id, [mention()], NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, second.id, [mention()], NOW);
    expect(await listWatchMentions(db, DEMO_WORKSPACE_ID, first.id)).toHaveLength(1);
    expect(await listWatchMentions(db, DEMO_WORKSPACE_ID, second.id)).toHaveLength(1);
  });

  it('filters by sentiment and platform, and is workspace-scoped', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(
      db,
      DEMO_WORKSPACE_ID,
      watch.id,
      [
        mention(),
        mention({ externalId: 'gh1', platform: 'github', content: 'The billing page is terrible.' })
      ],
      NOW
    );
    expect(
      await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, { sentiment: 'negative' })
    ).toHaveLength(1);
    expect(
      await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, { platform: 'github' })
    ).toHaveLength(1);
    expect(await listWatchMentions(db, OTHER_WORKSPACE, watch.id)).toEqual([]);
  });

  it('returns a numeric sentiment score, not the pg numeric string', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention()], NOW);
    const [row] = await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id);
    expect(typeof row.sentimentScore).toBe('number');
  });

  it('zero-fills every day in the requested window', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 30, NOW);
    expect(trend).toHaveLength(30);
    expect(trend[0].day).toBe('2026-08-03');
    expect(trend[29].day).toBe('2026-09-01');
    expect(trend.every((point) => point.average === 0)).toBe(true);
  });

  it('cascades mentions and rollups when the watch is deleted', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention()], NOW);
    await deleteWatch(db, DEMO_WORKSPACE_ID, watch.id);
    const left = await db
      .prepare('SELECT COUNT(*)::int AS total FROM brand_watch_mentions WHERE watch_id=?')
      .get<{ total: number }>(watch.id);
    const rollups = await db
      .prepare('SELECT COUNT(*)::int AS total FROM brand_watch_sentiment_daily WHERE watch_id=?')
      .get<{ total: number }>(watch.id);
    expect(left?.total).toBe(0);
    expect(rollups?.total).toBe(0);
  });

  it('keeps the mention when its promoted run row is deleted', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention()], NOW);
    const [row] = await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id);
    await db
      .prepare(
        `INSERT INTO playbook_runs (id, workspace_id, playbook_key, playbook_version, status, actor_type, correlation_id, input_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?::jsonb,?,?)`
      )
      .run(
        'pbr_test',
        DEMO_WORKSPACE_ID,
        'gtm.thread-reply',
        '1.0.0',
        'waiting_approval',
        'system',
        'corr_pbr_test',
        '{}',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await markMentionPromoted(db, DEMO_WORKSPACE_ID, row.id, 'pbr_test', NOW);
    expect((await getWatchMention(db, DEMO_WORKSPACE_ID, row.id))?.promotedRunId).toBe('pbr_test');

    await db.prepare('DELETE FROM playbook_runs WHERE id=?').run('pbr_test');
    const after = await getWatchMention(db, DEMO_WORKSPACE_ID, row.id);
    expect(after).not.toBeNull();
    expect(after?.promotedRunId).toBeNull();
  });
});

describe('migration 114 -- devto removed from stored platform arrays', () => {
  // Migrations apply once ever (tracked in schema_migrations), so by the time
  // this test's beforeEach runs, migration 114 has already run against
  // whatever data existed then -- not the rows this test is about to create.
  // Executing the real file's SQL text directly against manufactured
  // pre-existing rows is the only way left to exercise it: it proves the
  // actual bytes the production migration runner applies, not a
  // reimplementation that could silently drift from them.
  it('drops devto from a mixed-platform watch, and disables a watch whose only platform was devto', async () => {
    const mixed = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'Mixed',
        keywords: ['trevra'],
        platforms: ['hackernews', 'github'],
        cadence: 'daily'
      },
      NOW
    );
    // brandWatchBodySchema's enum already excludes devto from every route
    // that could create or edit a watch; raw SQL is the only way left to
    // reproduce the pre-existing row this migration exists to repair.
    await db
      .prepare('UPDATE brand_watches SET platforms = ? WHERE id=?')
      .run(['hackernews', 'devto', 'github'], mixed.id);

    const devtoOnly = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Devto only', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    await db
      .prepare('UPDATE brand_watches SET platforms = ? WHERE id=?')
      .run(['devto'], devtoOnly.id);

    const sql = await readFile(
      resolve(migrationDirectory(), '114_remove_devto_watch_platform.sql'),
      'utf8'
    );
    await db.exec(sql);

    const afterMixed = await getWatch(db, DEMO_WORKSPACE_ID, mixed.id);
    expect(afterMixed?.platforms).toEqual(['hackernews', 'github']);
    expect(afterMixed?.enabled).toBe(true);
    expect(afterMixed?.lastError).toBeNull();

    const afterDevtoOnly = await getWatch(db, DEMO_WORKSPACE_ID, devtoOnly.id);
    expect(afterDevtoOnly?.platforms).toEqual([]);
    expect(afterDevtoOnly?.enabled).toBe(false);
    expect(afterDevtoOnly?.lastError).toContain('devto');
    // last_error alone is never rendered client-side (no reference to
    // lastError anywhere in ResearchView.tsx) -- last_run_warnings is what
    // the mentions panel's empty state actually reads, via
    // lastRunWarningsNote, so the explanation has to land there too.
    expect(afterDevtoOnly?.lastRunWarnings).toEqual([
      { platform: null, reason: expect.stringContaining('devto') }
    ]);

    const devtoOnlyRow = await db
      .prepare('SELECT updated_at FROM brand_watches WHERE id=?')
      .get<{ updated_at: string }>(devtoOnly.id);
    expect(new Date(devtoOnlyRow!.updated_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('preserves a pre-existing last_error but still records last_run_warnings when disabling', async () => {
    const devtoOnly = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'Devto only, already broken',
        keywords: ['trevra'],
        platforms: ['hackernews'],
        cadence: 'daily'
      },
      NOW
    );
    await db
      .prepare('UPDATE brand_watches SET platforms = ?, last_error = ? WHERE id=?')
      .run(['devto'], 'network down', devtoOnly.id);

    const sql = await readFile(
      resolve(migrationDirectory(), '114_remove_devto_watch_platform.sql'),
      'utf8'
    );
    await db.exec(sql);

    const after = await getWatch(db, DEMO_WORKSPACE_ID, devtoOnly.id);
    expect(after?.enabled).toBe(false);
    // The pre-existing real error is not clobbered by the housekeeping
    // disablement message...
    expect(after?.lastError).toBe('network down');
    // ...but last_run_warnings -- the field the client actually renders --
    // still gets the explanation, unconditionally.
    expect(after?.lastRunWarnings).toEqual([
      { platform: null, reason: expect.stringContaining('devto') }
    ]);
  });

  it('is a no-op for a watch that never had devto', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const sql = await readFile(
      resolve(migrationDirectory(), '114_remove_devto_watch_platform.sql'),
      'utf8'
    );
    await db.exec(sql);
    const after = await getWatch(db, DEMO_WORKSPACE_ID, watch.id);
    expect(after?.platforms).toEqual(INPUT.platforms);
    expect(after?.enabled).toBe(true);
    expect(after?.lastError).toBeNull();
  });
});
