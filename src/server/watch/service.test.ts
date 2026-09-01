import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { createWatch, getWatch, listWatchMentions } from './store.js';
import { runBrandWatch, runDueBrandWatches } from './service.js';

let db: Db;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const noCredentials: CredentialAccessor = { get: () => undefined };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

const HN_HIT = {
  hits: [
    {
      objectID: '1',
      title: 'Trevra review',
      story_text: 'Trevra is excellent.',
      author: 'dev',
      points: 20,
      num_comments: 4,
      created_at_i: 1_756_713_600
    }
  ]
};

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify(HN_HIT), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

async function watchFor(cadence: 'daily' | 'weekly') {
  return createWatch(
    db,
    DEMO_WORKSPACE_ID,
    { name: `w-${cadence}`, keywords: ['trevra'], platforms: ['hackernews'], cadence },
    NOW
  );
}

describe('brand watch service', () => {
  it('runs a due watch, stores mentions, and advances a daily cadence by one day', async () => {
    const watch = await watchFor('daily');
    const result = await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    expect(result.ran).toBe(true);
    expect(result.inserted).toBe(1);
    expect(await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id)).toHaveLength(1);

    const after = await getWatch(db, DEMO_WORKSPACE_ID, watch.id);
    expect(after?.lastRunAt).toBe('2026-09-01T09:00:00.000Z');
    expect(after?.nextRunAt).toBe('2026-09-02T09:00:00.000Z');
    expect(after?.lastError).toBeNull();
  });

  it('advances a weekly cadence by seven days', async () => {
    const watch = await watchFor('weekly');
    await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    expect((await getWatch(db, DEMO_WORKSPACE_ID, watch.id))?.nextRunAt).toBe(
      '2026-09-08T09:00:00.000Z'
    );
  });

  it('skips a watch another worker holds and leaves it untouched', async () => {
    const watch = await watchFor('daily');
    await db
      .prepare(
        "UPDATE brand_watches SET lease_until = ?::timestamptz + INTERVAL '5 minutes' WHERE id=?"
      )
      .run(NOW.toISOString(), watch.id);
    const result = await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    expect(result.ran).toBe(false);
    expect((await getWatch(db, DEMO_WORKSPACE_ID, watch.id))?.lastRunAt).toBeNull();
  });

  it('records the error and still advances the cadence when a run fails', async () => {
    const watch = await watchFor('daily');
    const boom: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: boom,
      credentials: noCredentials
    });
    // A failed platform is a warning, not a thrown run.
    expect(result.warnings.join(' ')).toContain('network down');

    const after = await getWatch(db, DEMO_WORKSPACE_ID, watch.id);
    expect(after?.nextRunAt).toBe('2026-09-02T09:00:00.000Z');
  });

  it('releases the lease after a run', async () => {
    const watch = await watchFor('daily');
    await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    const row = await db
      .prepare('SELECT lease_until FROM brand_watches WHERE id=?')
      .get<{ lease_until: string | null }>(watch.id);
    expect(row?.lease_until).toBeNull();
  });

  it('runs a not-yet-due watch when forced', async () => {
    const watch = await watchFor('daily');
    await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    const forced = await runBrandWatch(db, DEMO_WORKSPACE_ID, watch.id, {
      now: NOW,
      force: true,
      fetchImpl: okFetch,
      credentials: noCredentials
    });
    expect(forced.ran).toBe(true);
  });

  it('picks up only enabled, due watches', async () => {
    // Deviation from the brief: the brief's literal test reuses `watchFor`
    // (platform 'hackernews') here too, and calls `runDueBrandWatches(db)`,
    // which has no fetch seam. `scoutClient(undefined)` -- see
    // outreach/scouts/http.ts -- then sets `resolve: true`, so the SSRF guard
    // does a REAL `dns.lookup` on hn.algolia.com before any fetch even runs.
    // Every other test in this repo's watch/scout suites is hermetic.
    //
    // Fix, per the project owner: use the 'linkedin' platform instead.
    // `watchMentions` checks `scout.availability(credentials)` first and
    // `continue`s without ever calling `scout.search` for anything not
    // 'ready' -- no scoutClient, no validatePublicHost, no DNS, no socket.
    // `linkedinScout.availability()` returns `disabled` unconditionally (it
    // is disabled by policy, not by a missing credential -- see
    // scouts/linkedin.ts), so this is deterministic on every machine,
    // regardless of which provider env vars happen to be exported locally.
    // 'reddit' / 'mastodon' were rejected for this: they only short-circuit
    // when their credentials are ABSENT, so a machine with REDDIT_* or
    // MASTODON_ACCESS_TOKEN set would silently start hitting the network.
    //
    // What the test asserts is unchanged: runDueBrandWatches selects only
    // enabled, due watches, respects the LIMIT, invokes runBrandWatch, and
    // lastRunAt becomes non-null.
    const due = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'due-linkedin', keywords: ['trevra'], platforms: ['linkedin'], cadence: 'daily' },
      NOW
    );
    const off = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'disabled',
        keywords: ['trevra'],
        platforms: ['linkedin'],
        cadence: 'daily',
        enabled: false
      },
      NOW
    );
    await db
      .prepare("UPDATE brand_watches SET next_run_at = now() + INTERVAL '1 day' WHERE id=?")
      .run(off.id);
    // Second deviation from the brief's literal text: `createWatch` sets
    // next_run_at to the fixed constant NOW ('2026-09-01T09:00:00.000Z'), and
    // `runDueBrandWatches` compares against Postgres's real, wall-clock
    // `now()`. Whether that fixed constant is "due" therefore depends on what
    // the real clock happens to read when the suite runs -- true of the
    // brief's version too, platform aside. Backdating explicitly, the same
    // way `off` is pushed forward, makes the test deterministic instead of
    // dependent on when in the day it happens to execute.
    await db
      .prepare("UPDATE brand_watches SET next_run_at = now() - INTERVAL '1 minute' WHERE id=?")
      .run(due.id);

    const count = await runDueBrandWatches(db);
    expect(count).toBe(1);
    expect((await getWatch(db, DEMO_WORKSPACE_ID, due.id))?.lastRunAt).not.toBeNull();
  });
});
