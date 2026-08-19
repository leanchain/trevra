import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { loadThreadFeed } from './feed.js';
import { recordPost, recordSeenThreads } from './store.js';
import type { OutreachThread } from './types.js';

let db: Db;
const NOW = new Date('2026-08-19T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
  vi.unstubAllEnvs();
});

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'hackernews',
    externalId: 't1',
    url: 'https://news.ycombinator.com/item?id=t1',
    title: 'Ask HN: cutting token cost',
    content: 'Our api cost is out of hand.',
    author: 'someone',
    community: null,
    score: 5,
    numComments: 2,
    createdAt: NOW.toISOString(),
    metadata: {},
    ...overrides
  };
}

describe('loadThreadFeed', () => {
  it("ranks by relevance, not by the platform's own points", async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        thread({
          externalId: 'loud',
          title: 'Nvidia ships a GPU',
          content: 'no keywords here',
          score: 900
        }),
        thread({
          externalId: 'relevant',
          title: 'token cost of coding agents',
          content: 'our api cost tripled',
          score: 2
        })
      ],
      NOW
    );

    const feed = await loadThreadFeed(db, DEMO_WORKSPACE_ID, {}, NOW);

    expect(feed.map((entry) => entry.row.external_id)).toEqual(['relevant', 'loud']);
    expect(feed[0].relevance.score).toBeGreaterThan(feed[1].relevance.score);
    expect(feed[0].relevance.components.length).toBeGreaterThan(0);
    expect(feed[0].topics).toContain('token_cost');
  });

  it('reports a blocked thread in place, with the failing check named', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        thread({
          platform: 'reddit',
          externalId: 'r1',
          community: 'webdev',
          url: 'https://reddit.test/r1'
        })
      ],
      NOW
    );
    // A post into the same community minutes ago trips the cooldown.
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'other',
        threadUrl: 'https://reddit.test/other',
        payloadHash: 'hash-other',
        status: 'posted',
        provider: 'test',
        externalRef: 'ref',
        error: null,
        body: 'a reply'
      },
      new Date(NOW.getTime() - 60_000)
    );

    // reddit's own account-age/karma minimums (config.ts) would otherwise be
    // the first failing check for an undeclared account, masking the cooldown
    // this test is actually about. Stub a profile that clears both, same as
    // safety.test.ts's GOOD_ACCOUNT, so cooldown is what fails. vi.stubEnv +
    // the afterEach's unstubAllEnvs keeps this from leaking into other files
    // sharing the worker, unlike a raw process.env mutation.
    vi.stubEnv(
      'OUTREACH_ACCOUNT_PROFILES_JSON',
      JSON.stringify({ reddit: { accountAgeDays: 400, karma: 1200 } })
    );

    const feed = await loadThreadFeed(db, DEMO_WORKSPACE_ID, { platform: 'reddit' }, NOW);

    expect(feed).toHaveLength(1);
    expect(feed[0].guard.allowed).toBe(false);
    expect(feed[0].guard.failedChecks).toContain('community-cooldown');
    expect(feed[0].guard.reason).toMatch(/cooldown/);
  });

  it('never reports permission when the gate itself could not be evaluated', async () => {
    await recordSeenThreads(db, DEMO_WORKSPACE_ID, [thread({ externalId: 'ungated' })], NOW);
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('outreach_posts')) throw new Error('counter lookup exploded');
            return Reflect.get(target, property, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, property, receiver);
      }
    }) as Db;

    const feed = await loadThreadFeed(broken, DEMO_WORKSPACE_ID, {}, NOW);

    expect(feed).toHaveLength(1);
    expect(feed[0].guard.allowed).toBe(false);
    expect(feed[0].guard.reason).toMatch(/guard unknown/);
  });

  it('asks the database once per distinct community, not once per row', async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      thread({
        platform: 'reddit',
        externalId: `r${index}`,
        community: 'webdev',
        url: `https://reddit.test/r${index}`
      })
    );
    await recordSeenThreads(db, DEMO_WORKSPACE_ID, rows, NOW);

    let queries = 0;
    const counted = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            queries += 1;
            return Reflect.get(target, property, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, property, receiver);
      }
    }) as Db;

    const feed = await loadThreadFeed(counted, DEMO_WORKSPACE_ID, { platform: 'reddit' }, NOW);

    expect(feed).toHaveLength(12);
    // 1 list + 3 counter lookups for the single (reddit, webdev) pair.
    expect(queries).toBeLessThanOrEqual(5);
  });
});
