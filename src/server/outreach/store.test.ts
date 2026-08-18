import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { isThreadReplied, listOutreachThreads, recordPost, recordSeenThreads } from './store.js';
import type { OutreachThread } from './types.js';

let db: Db;
const NOW = new Date('2026-08-03T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'reddit',
    externalId: 't1',
    url: 'https://www.reddit.com/r/webdev/comments/t1/x',
    title: 'Keeping agent costs down',
    content: 'My api cost tripled.',
    author: 'someone',
    community: 'webdev',
    score: 10,
    numComments: 4,
    createdAt: NOW.toISOString(),
    metadata: {},
    ...overrides
  };
}

async function reply(externalId: string, platform = 'reddit'): Promise<void> {
  await recordPost(
    db,
    {
      workspaceId: DEMO_WORKSPACE_ID,
      platform,
      community: 'webdev',
      threadExternalId: externalId,
      threadUrl: 'https://example.test/x',
      payloadHash: `hash-${platform}-${externalId}`,
      status: 'posted',
      provider: 'test',
      externalRef: 'ref',
      error: null,
      body: 'a reply'
    },
    NOW
  );
}

describe('recordSeenThreads', () => {
  it('keeps returning a discovered thread until we have actually replied to it', async () => {
    // The backlog case. A run that discovers 3 threads and replies to 1 must
    // still offer the other 2 on the next run -- the reference buried them.
    const batch = [
      thread({ externalId: 'a' }),
      thread({ externalId: 'b' }),
      thread({ externalId: 'c' })
    ];

    const first = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(first.fresh.map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);
    expect(first.repliedCount).toBe(0);

    // Merely re-seeing them changes nothing.
    const second = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(second.fresh.map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);

    await reply('a');

    const third = await recordSeenThreads(db, DEMO_WORKSPACE_ID, batch, NOW);
    expect(third.fresh.map((entry) => entry.externalId)).toEqual(['b', 'c']);
    expect(third.repliedCount).toBe(1);
  });

  it('detects that a thread was edited after we first read it', async () => {
    await recordSeenThreads(db, DEMO_WORKSPACE_ID, [thread({ externalId: 'a' })], NOW);

    const unchanged = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(unchanged.changed).toEqual([]);

    // The OP adds the detail that makes the thread worth replying to.
    const edited = thread({ externalId: 'a', content: 'My api cost tripled. It is now $400/mo.' });
    const afterEdit = await recordSeenThreads(db, DEMO_WORKSPACE_ID, [edited], NOW);
    expect(afterEdit.changed).toEqual(['a']);

    // The edit is reported once, against the stored hash -- not on every poll.
    const settled = await recordSeenThreads(db, DEMO_WORKSPACE_ID, [edited], NOW);
    expect(settled.changed).toEqual([]);
  });

  it('refreshes engagement counters, so the scorer reads current numbers', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', score: 3, numComments: 1 })],
      NOW
    );
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', score: 92, numComments: 40 })],
      NOW
    );

    const row = await db
      .prepare(
        'SELECT score, num_comments FROM outreach_threads WHERE workspace_id=? AND external_id=?'
      )
      .get<{ score: number; num_comments: number }>(DEMO_WORKSPACE_ID, 'a');
    expect(row).toEqual({ score: 92, num_comments: 40 });
  });

  it('records one row per thread however many times it is re-polled', async () => {
    for (let index = 0; index < 3; index += 1) {
      await recordSeenThreads(db, DEMO_WORKSPACE_ID, [thread({ externalId: 'a' })], NOW);
    }
    const row = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM outreach_threads WHERE workspace_id=? AND external_id=?'
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID, 'a');
    expect(row?.total).toBe(1);
  });

  it('scopes both the dedup and the reply history per platform and per workspace', async () => {
    await reply('a', 'reddit');

    // Same external id on another platform is a different thread.
    const other = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a', platform: 'lobsters' })],
      NOW
    );
    expect(other.fresh).toHaveLength(1);

    // Another workspace has its own reply history. Created idempotently: the
    // container outlives a single test file and resetDemoData only drops the
    // demo workspace.
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run('ws_store_other', 'Other', NOW.toISOString());
    await db.prepare('DELETE FROM outreach_threads WHERE workspace_id=?').run('ws_store_other');
    const elsewhere = await recordSeenThreads(
      db,
      'ws_store_other',
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(elsewhere.fresh).toHaveLength(1);
  });

  it('withholds a thread that was handed off for manual posting, not just one posted by API', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'handoff-a',
        status: 'manual_handoff',
        provider: 'manual-handoff',
        externalRef: 'x',
        error: null,
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(0);
    expect(result.repliedCount).toBe(1);
  });

  it('does not withhold a thread whose only attempt failed', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'failed-a',
        status: 'failed',
        provider: null,
        externalRef: null,
        error: 'rejected',
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(1);
    expect(await isThreadReplied(db, DEMO_WORKSPACE_ID, 'reddit', 'a')).toBe(false);
  });

  it('treats a held pending claim as replied, so the thread is not offered twice', async () => {
    await recordPost(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        platform: 'reddit',
        community: 'webdev',
        threadExternalId: 'a',
        threadUrl: 'https://example.test/x',
        payloadHash: 'pending-a',
        status: 'pending',
        provider: null,
        externalRef: null,
        error: 'socket hang up',
        body: 'x'
      },
      NOW
    );
    const result = await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'a' })],
      NOW
    );
    expect(result.fresh).toHaveLength(0);
  });
});

describe('listOutreachThreads', () => {
  it('filters by platform and ranks by score, newest first on a tie', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        thread({ externalId: 'r1', platform: 'reddit', score: 5 }),
        thread({ externalId: 'r2', platform: 'reddit', score: 9 }),
        thread({ externalId: 'l1', platform: 'linkedin', score: 3 })
      ],
      NOW
    );

    const reddit = await listOutreachThreads(db, DEMO_WORKSPACE_ID, { platform: 'reddit' });
    expect(reddit.map((row) => row.external_id)).toEqual(['r2', 'r1']);

    const all = await listOutreachThreads(db, DEMO_WORKSPACE_ID);
    expect(all).toHaveLength(3);
  });

  it('returns nothing for a workspace with no discovered threads', async () => {
    const rows = await listOutreachThreads(db, 'ws_no_such_workspace');
    expect(rows).toEqual([]);
  });

  it('clamps limit to the same [1, 200] band the skill-run list uses', async () => {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [thread({ externalId: 'c1' }), thread({ externalId: 'c2' }), thread({ externalId: 'c3' })],
      NOW
    );

    const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, { limit: 0 });
    // limit=0 clamps to 1, not 0 -- with 3 rows seeded, [] would mean the
    // clamp is missing entirely rather than merely rounding down.
    expect(rows).toHaveLength(1);
  });
});
