import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import { evaluateSafety, memoisedCounters } from './safety.js';
import { recordPost, recordSeenThreads } from './store.js';
import type { OutreachThread } from './types.js';

// Real ephemeral Postgres, per the repo's test harness: the caps ARE the
// queries, so an in-memory stub would test nothing that ships.
let db: Db;

const NOW = new Date('2026-08-03T12:00:00.000Z');

/** No environment leaks into these tests. */
const noCredentials: CredentialAccessor = { get: () => undefined };

const GOOD_ACCOUNT = { accountAgeDays: 400, karma: 1200 };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  // resetDemoData recreates the workspace, cascading the outreach tables clean.
});

afterEach(async () => {
  await db?.close();
});

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'reddit',
    externalId: 't1',
    url: 'https://www.reddit.com/r/webdev/comments/t1/x',
    title: 'How do you keep coding agent costs down',
    content: 'My api cost tripled this month.',
    author: 'someone',
    community: 'webdev',
    score: 30,
    numComments: 12,
    createdAt: NOW.toISOString(),
    metadata: {},
    ...overrides
  };
}

let postSeq = 0;
async function logPost(
  overrides: {
    platform?: string;
    community?: string | null;
    hoursAgo?: number;
    status?: 'posted' | 'manual_handoff' | 'failed';
  } = {}
): Promise<void> {
  postSeq += 1;
  await recordPost(
    db,
    {
      workspaceId: DEMO_WORKSPACE_ID,
      platform: overrides.platform ?? 'reddit',
      community: overrides.community === undefined ? 'webdev' : overrides.community,
      threadExternalId: `thread-${postSeq}`,
      threadUrl: `https://example.test/${postSeq}`,
      payloadHash: `hash-${postSeq}`,
      status: overrides.status ?? 'posted',
      provider: 'test',
      externalRef: `ref-${postSeq}`,
      error: null,
      body: 'a reply'
    },
    new Date(NOW.getTime() - (overrides.hoursAgo ?? 0) * 3_600_000)
  );
}

function check(verdict: Awaited<ReturnType<typeof evaluateSafety>>, name: string) {
  const found = verdict.checks.find((entry) => entry.check === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe('daily cap', () => {
  it('allows a reply while under the platform cap', async () => {
    // Reddit's cap is 5.
    for (let index = 0; index < 4; index += 1) await logPost({ community: `sub${index}` });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'daily-cap').passed).toBe(true);
    expect(check(verdict, 'daily-cap').detail).toContain('4 of 5');
  });

  it('blocks the reply that would exceed the cap', async () => {
    for (let index = 0; index < 5; index += 1) await logPost({ community: `sub${index}` });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('daily-cap');
    expect(check(verdict, 'daily-cap').detail).toContain('5 of 5');
  });

  it('uses a rolling 24h window, so posts do not reset at midnight', async () => {
    // Five posts, but all older than 24 hours.
    for (let index = 0; index < 5; index += 1)
      await logPost({ community: `sub${index}`, hoursAgo: 25 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'daily-cap').passed).toBe(true);
    expect(check(verdict, 'daily-cap').detail).toContain('0 of 5');
  });

  it('counts manual handoffs against the cap, because a human posting costs the same attention', async () => {
    for (let index = 0; index < 5; index += 1)
      await logPost({ community: `sub${index}`, status: 'manual_handoff' });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'daily-cap').passed).toBe(false);
  });

  it('does not count failed attempts against the cap', async () => {
    for (let index = 0; index < 5; index += 1)
      await logPost({ community: `sub${index}`, status: 'failed' });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'daily-cap').passed).toBe(true);
  });

  it('caps per platform, not globally', async () => {
    for (let index = 0; index < 5; index += 1) await logPost({ community: `sub${index}` });
    // GitHub's cap is 10 and it has its own counter.
    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({
          platform: 'github',
          community: 'anthropics/claude-code',
          url: 'https://github.com/anthropics/claude-code/issues/1'
        })
      },
      NOW,
      { account: GOOD_ACCOUNT, credentials: noCredentials }
    );
    expect(check(verdict, 'daily-cap').passed).toBe(true);
    expect(check(verdict, 'daily-cap').detail).toContain('0 of 10');
  });
});

describe('community cooldown', () => {
  it('blocks a second post into the same community inside the window', async () => {
    await logPost({ community: 'webdev', hoursAgo: 1 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(false);
    expect(check(verdict, 'community-cooldown').passed).toBe(false);
    expect(check(verdict, 'community-cooldown').detail).toContain('48h cooldown not elapsed');
  });

  it('allows the post once the cooldown has elapsed', async () => {
    await logPost({ community: 'webdev', hoursAgo: 49 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'community-cooldown').passed).toBe(true);
  });

  it('scopes the cooldown to one community, not the whole platform', async () => {
    await logPost({ community: 'programming', hoursAgo: 1 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread({ community: 'webdev' }) },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'community-cooldown').passed).toBe(true);
  });

  it('matches communities case-insensitively', async () => {
    await logPost({ community: 'WebDev', hoursAgo: 1 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread({ community: 'webdev' }) },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'community-cooldown').passed).toBe(false);
  });

  it('exempts platforms with no community concept', async () => {
    await logPost({ platform: 'hackernews', community: null, hoursAgo: 1 });
    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({
          platform: 'hackernews',
          community: null,
          url: 'https://news.ycombinator.com/item?id=1'
        })
      },
      NOW,
      { account: GOOD_ACCOUNT, credentials: noCredentials }
    );
    expect(check(verdict, 'community-cooldown').passed).toBe(true);
    expect(check(verdict, 'self-promo-ratio').passed).toBe(true);
  });
});

describe('account standing', () => {
  it('fails age and karma when no profile is declared for a platform that requires them', async () => {
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: null,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(false);
    expect(check(verdict, 'account-age').passed).toBe(false);
    expect(check(verdict, 'account-age').detail).toContain('OUTREACH_ACCOUNT_PROFILES_JSON');
    expect(check(verdict, 'account-karma').passed).toBe(false);
  });

  it('fails an account below the platform minimum', async () => {
    // Reddit wants 30 days and 50 karma.
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: { accountAgeDays: 12, karma: 20 },
        credentials: noCredentials
      }
    );
    expect(check(verdict, 'account-age').passed).toBe(false);
    expect(check(verdict, 'account-age').detail).toContain('12 days old; 30 required');
    expect(check(verdict, 'account-karma').passed).toBe(false);
  });

  it('enforces the stricter Hacker News minimums', async () => {
    const hn = thread({
      platform: 'hackernews',
      community: null,
      url: 'https://news.ycombinator.com/item?id=1'
    });
    // Passes on Reddit's 30/50, fails HN's 60/100.
    const verdict = await evaluateSafety(db, { workspaceId: DEMO_WORKSPACE_ID, thread: hn }, NOW, {
      account: { accountAgeDays: 45, karma: 80 },
      credentials: noCredentials
    });
    expect(check(verdict, 'account-age').passed).toBe(false);
    expect(check(verdict, 'account-karma').passed).toBe(false);
  });

  it('needs no profile on a platform that sets no minimums', async () => {
    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({
          platform: 'github',
          community: 'anthropics/claude-code',
          url: 'https://github.com/anthropics/claude-code/issues/1'
        })
      },
      NOW,
      { account: null, credentials: noCredentials }
    );
    expect(check(verdict, 'account-age').passed).toBe(true);
    expect(check(verdict, 'account-karma').passed).toBe(true);
  });

  it('reads the profile from OUTREACH_ACCOUNT_PROFILES_JSON when none is passed', async () => {
    const credentials: CredentialAccessor = {
      get: (name) =>
        name === 'OUTREACH_ACCOUNT_PROFILES_JSON'
          ? JSON.stringify({ reddit: { accountAgeDays: 900, karma: 5000 } })
          : undefined
    };
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      { credentials }
    );
    expect(check(verdict, 'account-age').passed).toBe(true);
    expect(check(verdict, 'account-karma').passed).toBe(true);
  });
});

describe('blacklists', () => {
  it('blocks a blacklisted community regardless of how relevant the thread is', async () => {
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread({ community: 'AskReddit' }) },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('blacklisted-community');
  });

  it('blocks a thread whose text contains a blacklisted term', async () => {
    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({ content: 'this is obvious spam, reported' })
      },
      NOW,
      { account: GOOD_ACCOUNT, credentials: noCredentials }
    );
    expect(check(verdict, 'blacklisted-keyword').passed).toBe(false);
  });
});

describe('self-promotion ratio', () => {
  async function discover(count: number, community: string): Promise<void> {
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      Array.from({ length: count }, (_, index) =>
        thread({ externalId: `${community}-seen-${index}`, community })
      ),
      NOW
    );
  }

  it('allows a reply that stays at or under 10% of discovered threads', async () => {
    await discover(10, 'webdev');
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    // (0 posted + 1) / 10 = exactly 10%.
    expect(check(verdict, 'self-promo-ratio').passed).toBe(true);
  });

  it('blocks a reply that would push us over 10%', async () => {
    await discover(9, 'webdev');
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    // (0 + 1) / 9 = 11.1%.
    expect(check(verdict, 'self-promo-ratio').passed).toBe(false);
    expect(check(verdict, 'self-promo-ratio').detail).toContain('11.1%');
  });

  it('counts posts already made into that community', async () => {
    await discover(20, 'webdev');
    // Two posted long enough ago that the cooldown is clear.
    await logPost({ community: 'webdev', hoursAgo: 200 });
    await logPost({ community: 'webdev', hoursAgo: 150 });
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    // (2 + 1) / 20 = 15%.
    expect(check(verdict, 'self-promo-ratio').passed).toBe(false);
  });
});

describe('verdict shape', () => {
  it('runs every check even after one has failed, and reports the first failure as the reason', async () => {
    await logPost({ community: 'webdev', hoursAgo: 1 });
    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({ community: 'AskReddit', content: 'spam' })
      },
      NOW,
      { account: null, credentials: noCredentials }
    );
    expect(verdict.checks).toHaveLength(7);
    // Four distinct failures are visible in one pass rather than one per run.
    expect(verdict.checks.filter((entry) => !entry.passed).length).toBeGreaterThanOrEqual(4);
    // Blacklist is first in evaluation order.
    expect(verdict.reason).toContain('blacklisted-community');
  });

  it('passes a clean thread on a fresh workspace', async () => {
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.checks.every((entry) => entry.passed)).toBe(true);
  });

  it('reports what the platform permits, so approval shows whether Trevra may post at all', async () => {
    const reddit = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    // Reddit's channel adapter is prepare-only: an approved reply is a handoff.
    expect(reddit.automationMode).toBe('prepare-only');
    expect(reddit.automationReason).toMatch(/self-promotion/i);

    const github = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({
          platform: 'github',
          community: 'anthropics/claude-code',
          url: 'https://github.com/anthropics/claude-code/issues/1'
        })
      },
      NOW,
      { account: GOOD_ACCOUNT, credentials: noCredentials }
    );
    expect(github.automationMode).toBe('api-publish');
  });

  it('isolates workspaces: another workspace’s posts do not consume our cap', async () => {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run('ws_safety_other', 'Other', NOW.toISOString());
    await db.prepare('DELETE FROM outreach_posts WHERE workspace_id=?').run('ws_safety_other');
    for (let index = 0; index < 5; index += 1) {
      await recordPost(
        db,
        {
          workspaceId: 'ws_safety_other',
          platform: 'reddit',
          community: 'webdev',
          threadExternalId: `other-${index}`,
          threadUrl: 'https://example.test/other',
          payloadHash: `other-hash-${index}`,
          status: 'posted',
          provider: 'test',
          externalRef: 'ref',
          error: null,
          body: 'x'
        },
        NOW
      );
    }
    const verdict = await evaluateSafety(
      db,
      { workspaceId: DEMO_WORKSPACE_ID, thread: thread() },
      NOW,
      {
        account: GOOD_ACCOUNT,
        credentials: noCredentials
      }
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe('injectable counters', () => {
  it('asks a supplied counters implementation instead of the database', async () => {
    const asked: string[] = [];
    const counters = {
      async postsToday(platform: string) {
        asked.push(`postsToday:${platform}`);
        return 0;
      },
      async lastPostInCommunity(platform: string, community: string) {
        asked.push(`lastPost:${platform}/${community}`);
        return null;
      },
      async communityVolume(platform: string, community: string) {
        asked.push(`volume:${platform}/${community}`);
        return { posted: 0, discovered: 0 };
      }
    };

    const verdict = await evaluateSafety(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        thread: thread({ platform: 'reddit', community: 'webdev' })
      },
      NOW,
      { account: { accountAgeDays: 900, karma: 1200 }, counters }
    );

    expect(verdict.allowed).toBe(true);
    expect(asked).toEqual(['postsToday:reddit', 'lastPost:reddit/webdev', 'volume:reddit/webdev']);
  });

  it('memoises repeated lookups for the same platform and community', async () => {
    let calls = 0;
    const inner = {
      async postsToday() {
        calls += 1;
        return 0;
      },
      async lastPostInCommunity() {
        return null;
      },
      async communityVolume() {
        return { posted: 0, discovered: 0 };
      }
    };
    const counters = memoisedCounters(inner);

    await counters.postsToday('reddit', NOW);
    await counters.postsToday('reddit', NOW);
    await counters.postsToday('hackernews', NOW);

    expect(calls).toBe(2);
  });

  it('evicts a rejected lookup so the next caller retries instead of being poisoned', async () => {
    let calls = 0;
    const inner = {
      async postsToday() {
        calls += 1;
        if (calls === 1) throw new Error('transient DB error');
        return 3;
      },
      async lastPostInCommunity() {
        return null;
      },
      async communityVolume() {
        return { posted: 0, discovered: 0 };
      }
    };
    const counters = memoisedCounters(inner);

    await expect(counters.postsToday('reddit', NOW)).rejects.toThrow('transient DB error');
    await expect(counters.postsToday('reddit', NOW)).resolves.toBe(3);

    expect(calls).toBe(2);
  });
});
