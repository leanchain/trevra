# Research Thread Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/research` answer "is this thread worth opening?" on the card, and turn a yes into a drafted reply waiting for approval in one click.

**Architecture:** The relevance scorer, topic extractor, angle suggester and safety gate already exist as pure or near-pure functions over an `OutreachThread`. This plan stores the one field they need and the table never kept (`content`), adds a read-side module (`outreach/feed.ts`) that joins them onto stored rows, gives `evaluateSafety` a counters seam so a page of rows costs one lookup per distinct community rather than three per row, and adds a `gtm.thread-reply` playbook that drafts against ONE caller-chosen thread instead of re-scouting.

**Tech Stack:** TypeScript, Express, PostgreSQL (no SQLite, ever), zod, React 18, vitest. Tests that touch the database run through `npx tsx scripts/test-with-postgres.ts <path>`, which starts a throwaway Postgres via testcontainers.

## Global Constraints

- **PostgreSQL only.** No SQLite, no embedded fallback, no dev-only path.
- **"Send" is reserved for actions that truly send.** Queued/drafted/awaiting-approval work is "draft", "queue" or "prepare" in every string, comment, and UI label.
- **The agent never approves or executes.** `gtm.thread-reply` stops at `waiting_approval`; posting stays behind the existing action step.
- **Every finding traces to a source.** Relevance chips are rendered from `components` the scorer itself produced; nothing is invented for display.
- **No new relevance model.** `scoreThread`, `extractTopics`, `suggestAngle`, `evaluateSafety` keep their current behaviour; only their call sites change.
- Spec: `docs/superpowers/specs/2026-08-19-research-thread-triage-design.md`.
- Client tests run in vitest's `node` environment (no jsdom). No React component tests: derived display strings go in a pure module and are tested there.

---

### Task 1: Persist thread content

`outreach_threads` keeps `content_hash` but not the content. Relevance, topics and the drafted reply all read the body, so the column has to exist before anything else in this plan works.

**Files:**

- Create: `migrations/082_outreach_thread_content.sql`
- Modify: `src/server/outreach/store.ts` (the `recordSeenThreads` upsert, `OutreachThreadRow`, `listOutreachThreads`)
- Test: `src/server/outreach/store.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `OutreachThreadRow` gains `content: string` and `metadata_json: Record<string, unknown>`; `listOutreachThreads(db, workspaceId, {platform?, limit?})` returns them.

- [ ] **Step 1: Write the failing test**

Add to `src/server/outreach/store.test.ts`, inside the existing `describe('listOutreachThreads', ...)` block (create the block if the file does not have one yet):

```ts
it('returns the body and metadata a re-score needs, not just the hash', async () => {
  await recordSeenThreads(
    db,
    DEMO_WORKSPACE_ID,
    [
      thread({
        externalId: 'body-1',
        content: 'my api cost tripled last month',
        metadata: { tags: ['ask_hn'] }
      })
    ],
    NOW
  );

  const [row] = await listOutreachThreads(db, DEMO_WORKSPACE_ID, {});

  expect(row.content).toBe('my api cost tripled last month');
  expect(row.metadata_json).toEqual({ tags: ['ask_hn'] });
});

it('refreshes stored content when an author edits the thread', async () => {
  await recordSeenThreads(
    db,
    DEMO_WORKSPACE_ID,
    [thread({ externalId: 'body-2', content: 'first read' })],
    NOW
  );
  await recordSeenThreads(
    db,
    DEMO_WORKSPACE_ID,
    [thread({ externalId: 'body-2', content: 'edited later' })],
    NOW
  );

  const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, {});
  expect(rows.find((row) => row.external_id === 'body-2')?.content).toBe('edited later');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach/store.test.ts`
Expected: FAIL -- `row.content` is `undefined` (the column does not exist).

- [ ] **Step 3: Add the migration**

`migrations/082_outreach_thread_content.sql`:

```sql
-- The body of a discovered thread, not just its hash.
--
-- 013_outreach.sql stored content_hash alone because the table existed to
-- detect edits and to be the self-promotion ratio's denominator -- both of
-- which a hash answers. /research asks a question a hash cannot: how relevant
-- is this thread, and what would a reply to it say. Both read the body.
--
-- Rows discovered before this migration carry '' until the next scout re-reads
-- them, which is the same path an edited thread already takes.
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 4: Write the content on insert and on conflict**

In `src/server/outreach/store.ts`, in `recordSeenThreads`: add `content` to the `INSERT` column list (after `title`), add one more `?` to the `VALUES` tuple in the same position, pass `thread.content` in that position of the parameter list, and add `content = excluded.content,` to the `ON CONFLICT DO UPDATE SET` list beside `title = excluded.title,`.

- [ ] **Step 5: Return it from the read path**

In the same file:

```ts
export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  /** The body as last read. '' for rows discovered before migration 082. */
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
  metadata_json: Record<string, unknown>;
}
```

and in `listOutreachThreads`, extend the `SELECT` list to
`SELECT id, platform, external_id, url, title, content, author, community, score, num_comments, thread_created_at, first_seen_at, metadata_json`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add migrations/082_outreach_thread_content.sql src/server/outreach/store.ts src/server/outreach/store.test.ts
git commit -m "outreach: store discovered thread content, not only its hash"
```

---

### Task 2: A counters seam for the safety gate

`evaluateSafety` issues up to three DB reads per thread. A page of 50 rows would issue 150 for facts that vary only by `(platform, community)`.

**Files:**

- Modify: `src/server/outreach/safety.ts`
- Test: `src/server/outreach/safety.test.ts`

**Interfaces:**

- Consumes: `countPostsToday`, `lastPostInCommunity`, `communityVolume`, `CommunityVolume` from `./store.js`.
- Produces: `export interface SafetyCounters`, `export function dbCounters(db, workspaceId): SafetyCounters`, `export function memoisedCounters(inner: SafetyCounters): SafetyCounters`, and `SafetyOptions.counters?: SafetyCounters`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/outreach/safety.test.ts`:

```ts
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
    { workspaceId: DEMO_WORKSPACE_ID, thread: thread({ platform: 'reddit', community: 'webdev' }) },
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
```

The file's existing `thread(...)` helper and `db`/`NOW` fixtures follow the same shape as `store.test.ts`; reuse them. If `safety.test.ts` has no `thread()` helper, copy the one from `store.test.ts` verbatim.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach/safety.test.ts`
Expected: FAIL -- `memoisedCounters` is not exported, and `counters` is not a known option.

- [ ] **Step 3: Add the seam**

In `src/server/outreach/safety.ts`:

```ts
import {
  communityVolume,
  countPostsToday,
  lastPostInCommunity,
  type CommunityVolume
} from './store.js';

/**
 * The three DB-derived facts the gate needs, behind an interface.
 *
 * They vary by (platform, community), never by thread, so a page of fifty rows
 * asks a handful of distinct questions. Callers scoring one thread get the
 * direct implementation and behave exactly as before.
 */
export interface SafetyCounters {
  postsToday(platform: string, now: Date): Promise<number>;
  lastPostInCommunity(platform: string, community: string): Promise<Date | null>;
  communityVolume(platform: string, community: string): Promise<CommunityVolume>;
}

export function dbCounters(db: Db, workspaceId: string): SafetyCounters {
  return {
    postsToday: (platform, now) => countPostsToday(db, workspaceId, platform, now),
    lastPostInCommunity: (platform, community) =>
      lastPostInCommunity(db, workspaceId, platform, community),
    communityVolume: (platform, community) => communityVolume(db, workspaceId, platform, community)
  };
}

/** Same answers, asked once per distinct key. Request-scoped: never a module-level cache. */
export function memoisedCounters(inner: SafetyCounters): SafetyCounters {
  const posts = new Map<string, Promise<number>>();
  const last = new Map<string, Promise<Date | null>>();
  const volume = new Map<string, Promise<CommunityVolume>>();
  const once = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>
  ): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = load();
    cache.set(key, pending);
    return pending;
  };
  return {
    postsToday: (platform, now) => once(posts, platform, () => inner.postsToday(platform, now)),
    lastPostInCommunity: (platform, community) =>
      once(last, `${platform}|${community}`, () => inner.lastPostInCommunity(platform, community)),
    communityVolume: (platform, community) =>
      once(volume, `${platform}|${community}`, () => inner.communityVolume(platform, community))
  };
}
```

Add `counters?: SafetyCounters;` to `SafetyOptions`, then inside `evaluateSafety` resolve it once --
`const counters = options.counters ?? dbCounters(db, workspaceId);` -- and replace the three direct store calls with `counters.postsToday(thread.platform, now)`, `counters.lastPostInCommunity(thread.platform, community)` and `counters.communityVolume(thread.platform, community)`. Nothing else in the function changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach/safety.test.ts`
Expected: PASS, including every pre-existing test in the file (the default path must be unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/server/outreach/safety.ts src/server/outreach/safety.test.ts
git commit -m "outreach: let the safety gate take injected counters"
```

---

### Task 3: The feed module

**Files:**

- Create: `src/server/outreach/feed.ts`
- Create: `src/server/outreach/feed.test.ts`

**Interfaces:**

- Consumes: `listOutreachThreads`, `OutreachThreadRow` (Task 1); `evaluateSafety`, `dbCounters`, `memoisedCounters`, `SafetyCheckName` (Task 2); `scoreThread`, `extractTopics`, `suggestAngle`, `ReplyAngle` from `./scorer.js`.
- Produces: `export interface FeedThread`, `export function threadFromRow(row: OutreachThreadRow): OutreachThread`, `export async function loadThreadFeed(db, workspaceId, filters, now): Promise<FeedThread[]>`.

- [ ] **Step 1: Write the failing test**

`src/server/outreach/feed.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach/feed.test.ts`
Expected: FAIL -- `Cannot find module './feed.js'`.

- [ ] **Step 3: Write the module**

`src/server/outreach/feed.ts`:

```ts
import type { Db } from '../db.js';
import {
  dbCounters,
  evaluateSafety,
  memoisedCounters,
  type SafetyCheckName,
  type SafetyVerdict
} from './safety.js';
import { extractTopics, scoreThread, suggestAngle, type ReplyAngle } from './scorer.js';
import { listOutreachThreads, type OutreachThreadRow } from './store.js';
import type { OutreachThread } from './types.js';

/**
 * The read model behind /research: one stored row, plus every derived judgement
 * a founder needs to decide whether to open it.
 *
 * Nothing here is persisted. Relevance is a pure function of the row and the
 * keyword lists in config.ts, so a keyword change is a redeploy, not a
 * backfill -- and a score shown in the UI is always the score today's rules
 * produce, never a stale one recorded at discovery time.
 */
export interface FeedThread {
  row: OutreachThreadRow;
  relevance: {
    score: number;
    components: Array<{ label: string; points: number }>;
    highValueMatches: string[];
    negativeMatches: string[];
  };
  topics: string[];
  angle: ReplyAngle;
  guard: { allowed: boolean; reason: string | null; failedChecks: SafetyCheckName[] };
}

/** Project a stored row back onto the shape every outreach skill consumes. */
export function threadFromRow(row: OutreachThreadRow): OutreachThread {
  return {
    platform: row.platform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    content: row.content,
    author: row.author,
    community: row.community,
    score: row.score,
    numComments: row.num_comments,
    createdAt: row.thread_created_at,
    metadata: row.metadata_json ?? {}
  };
}

export async function loadThreadFeed(
  db: Db,
  workspaceId: string,
  filters: { platform?: string; limit?: number },
  now: Date
): Promise<FeedThread[]> {
  const rows = await listOutreachThreads(db, workspaceId, filters);
  const counters = memoisedCounters(dbCounters(db, workspaceId));

  const entries: FeedThread[] = [];
  for (const row of rows) {
    const thread = threadFromRow(row);
    const breakdown = scoreThread(thread, now);
    const topics = extractTopics(thread);
    // A gate that cannot be computed is never reported as permission. The row
    // still renders -- "we could not check" is a fact worth showing.
    let verdict: SafetyVerdict | null = null;
    try {
      verdict = await evaluateSafety(db, { workspaceId, thread }, now, { counters });
    } catch {
      verdict = null;
    }
    entries.push({
      row,
      relevance: {
        score: breakdown.score,
        components: breakdown.components,
        highValueMatches: breakdown.highValueMatches,
        negativeMatches: breakdown.negativeMatches
      },
      topics,
      angle: suggestAngle(thread, topics),
      guard: verdict
        ? {
            allowed: verdict.allowed,
            reason: verdict.reason,
            failedChecks: verdict.checks
              .filter((check) => !check.passed)
              .map((check) => check.check)
          }
        : {
            allowed: false,
            reason: 'guard unknown: the safety gate could not be evaluated.',
            failedChecks: []
          }
    });
  }

  // Relevance first; discovery order breaks ties, so the list is stable between
  // reloads that discovered nothing new.
  return entries.sort(
    (left, right) =>
      right.relevance.score - left.relevance.score ||
      Date.parse(right.row.first_seen_at) - Date.parse(left.row.first_seen_at)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/outreach`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/outreach/feed.ts src/server/outreach/feed.test.ts
git commit -m "outreach: derive relevance, topics and guard verdict for stored threads"
```

---

### Task 4: Serve the feed

**Files:**

- Modify: `src/server/app.ts` (the `GET /api/outreach/threads` handler, ~line 1012)
- Modify: `src/client/api.ts` (`OutreachThreadRow`, `getOutreachThreads`)
- Modify: `src/client/views/ResearchView.tsx` (type import only -- rendering lands in Task 8)
- Test: `src/server/app.test.ts`

**Interfaces:**

- Consumes: `loadThreadFeed`, `FeedThread` (Task 3).
- Produces: `GET /api/outreach/threads` returns `{ threads: FeedThread[] }`; client exports `interface FeedThread` and `getOutreachThreads(filters): Promise<FeedThread[]>`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/app.test.ts`, in the block that already covers `/api/outreach/threads` (search for the path; if absent, add a new `describe('outreach threads', ...)` next to the nearest outreach test):

```ts
it('returns relevance, topics and a guard verdict with every discovered thread', async () => {
  await recordSeenThreads(
    db,
    DEMO_WORKSPACE_ID,
    [
      {
        platform: 'hackernews',
        externalId: 'feed-1',
        url: 'https://news.ycombinator.com/item?id=feed-1',
        title: 'Ask HN: token cost of coding agents',
        content: 'our api cost tripled',
        author: 'someone',
        community: null,
        score: 5,
        numComments: 2,
        createdAt: '2026-08-18T00:00:00.000Z',
        metadata: {}
      }
    ],
    new Date('2026-08-19T00:00:00.000Z')
  );

  const response = await agent.get('/api/outreach/threads').expect(200);

  expect(response.body.threads).toHaveLength(1);
  const [entry] = response.body.threads;
  expect(entry.row.external_id).toBe('feed-1');
  expect(entry.relevance.score).toBeGreaterThan(0);
  expect(entry.topics).toContain('token_cost');
  expect(entry.guard).toMatchObject({ allowed: expect.any(Boolean) });
});
```

Use the file's existing authenticated supertest agent and `db` fixtures; import `recordSeenThreads` from `./outreach/store.js` if the file does not already.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/app.test.ts -t 'relevance, topics and a guard verdict'`
Expected: FAIL -- `entry.row` is undefined (the route still returns bare rows).

- [ ] **Step 3: Serve the feed from the route**

In `src/server/app.ts`, import `loadThreadFeed` from `./outreach/feed.js` beside the existing `listOutreachThreads` import (drop that import if it has no other caller), and replace the handler body:

```ts
app.get('/api/outreach/threads', async (req: AuthedRequest, res, next) => {
  try {
    const filters = outreachThreadFiltersSchema.parse(req.query);
    res.json({ threads: await loadThreadFeed(db, req.auth!.workspaceId, filters, new Date()) });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Mirror the shape in the client**

In `src/client/api.ts`, replace `OutreachThreadRow`'s declaration and `getOutreachThreads`'s return type:

```ts
/** One row `gtm.scout-threads` discovered, plus what /research needs to judge it. */
export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
  metadata_json: Record<string, unknown>;
}

export interface FeedThread {
  row: OutreachThreadRow;
  relevance: {
    score: number;
    components: Array<{ label: string; points: number }>;
    highValueMatches: string[];
    negativeMatches: string[];
  };
  topics: string[];
  angle: 'technical_deepdive' | 'cost_comparison' | 'alternative_suggestion' | 'minimal_mention';
  guard: { allowed: boolean; reason: string | null; failedChecks: string[] };
}

export async function getOutreachThreads(
  filters: { platform?: string; limit?: number } = {}
): Promise<FeedThread[]> {
  const query = new URLSearchParams();
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ threads?: FeedThread[] }>(
    `/api/outreach/threads${query.size ? `?${query}` : ''}`
  );
  return result.threads ?? [];
}
```

In `src/client/views/ResearchView.tsx`, change the import to `import { getOutreachThreads, getSkillRuns, type FeedThread } from '../api';`, change the state to `useState<FeedThread[]>([])`, and read `thread.row.*` inside the existing card so the file compiles. Full card work is Task 8.

- [ ] **Step 5: Run typecheck and the tests**

Run: `npm run typecheck && npx tsx scripts/test-with-postgres.ts src/server/app.test.ts -t 'relevance, topics and a guard verdict'`
Expected: typecheck clean, test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts src/client/api.ts src/client/views/ResearchView.tsx
git commit -m "api: serve relevance and guard verdict with discovered threads"
```

---

### Task 5: The `gtm.thread-reply` playbook

`gtm.community-outreach` re-scouts and drafts against `repliable.0`. A founder who picked a row needs a run that drafts against THAT row.

**Files:**

- Modify: `src/server/playbooks/registry.ts`
- Test: `src/server/playbooks/engine.test.ts`

**Interfaces:**

- Consumes: `gtm.outreach-guard`, `gtm.draft-reply`, `outreachThreadSchema` (already imported by the registry's neighbours -- import from `../outreach/scorer.js`).
- Produces: builtin playbook `gtm.thread-reply` v1.0.0 with steps `guard`, `draft`, `approve-reply`, `post-reply`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/playbooks/engine.test.ts`:

```ts
it('drafts a reply to the thread it was handed and stops for approval', async () => {
  const run = await startPlaybookRun(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    playbookId: 'gtm.thread-reply',
    input: {
      thread: {
        platform: 'hackernews',
        externalId: '48457585',
        url: 'https://news.ycombinator.com/item?id=48457585',
        title: 'Ask HN: What works for cutting AI token costs?',
        content: 'My LLM token bill is getting painful.',
        author: 'leoncos',
        community: null,
        score: 5,
        numComments: 2,
        createdAt: '2026-06-09T07:04:29.000Z',
        metadata: {}
      },
      angle: 'cost_comparison',
      relevanceScore: 7.4,
      account: { accountAgeDays: 900, karma: 1200 },
      product: {
        name: 'Trevra',
        url: 'https://usetrevra.com',
        summary: 'A go-to-market workspace an agent operates and a human approves.',
        mechanism: 'Composite intent signals plus a hard approval gate.',
        claims: [{ label: 'Execution', value: 'Nothing sends without founder approval' }]
      }
    }
  });

  expect(run.status).toBe('waiting_approval');
  const approval = run.steps.find((step) => step.stepId === 'approve-reply');
  expect(approval?.status).toBe('waiting_approval');
  expect(approval?.input).toMatchObject({
    threadUrl: 'https://news.ycombinator.com/item?id=48457585',
    metadata: { relevanceScore: 7.4 }
  });
});

it('fails at the gate rather than drafting into a blocked thread', async () => {
  const run = await startPlaybookRun(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    playbookId: 'gtm.thread-reply',
    input: {
      thread: {
        platform: 'reddit',
        externalId: 'blocked-1',
        url: 'https://reddit.test/blocked-1',
        title: 'token cost',
        // A blacklisted term is the cheapest deterministic block: no post log needed.
        content: 'please stop spamming this sub with promo links',
        author: 'someone',
        community: 'webdev',
        score: 3,
        numComments: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        metadata: {}
      },
      account: { accountAgeDays: 900, karma: 1200 },
      product: {
        name: 'Trevra',
        url: 'https://usetrevra.com',
        summary: 'A go-to-market workspace an agent operates and a human approves.',
        mechanism: 'Composite intent signals plus a hard approval gate.',
        claims: []
      }
    }
  });

  expect(run.status).toBe('failed');
  expect(run.steps.find((step) => step.stepId === 'draft')?.status).not.toBe('completed');
});
```

Check `BLACKLISTED_KEYWORDS` in `src/server/outreach/config.ts` before relying on the phrase above; if `stop spamming` is not in that list, use a term that is, and say which in a comment.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/playbooks/engine.test.ts -t 'thread it was handed'`
Expected: FAIL -- unknown playbook `gtm.thread-reply`.

- [ ] **Step 3: Register the playbook**

In `src/server/playbooks/registry.ts`, after `communityOutreachPlaybook`:

```ts
/**
 * One thread, chosen by a human, drafted for approval.
 *
 * The community playbook scouts and then drafts against `repliable.0` -- the
 * best thread in a fresh batch, which is the right answer for a scheduled run
 * and the wrong one for a founder who just picked a row in /research. Same
 * gate, same approval payload, no scout and no score: the thread arrives whole
 * from the caller, and its relevance was already computed on the read path.
 */
export const threadReplyPlaybook: PlaybookDefinition = {
  id: 'gtm.thread-reply',
  version: '1.0.0',
  name: 'Reply to one discovered thread',
  description:
    'Gate one chosen community thread against posting limits, draft a reply to it, and stop for founder approval before posting.',
  inputSchema: z.object({
    thread: outreachThreadSchema,
    angle: z
      .enum(['technical_deepdive', 'cost_comparison', 'alternative_suggestion', 'minimal_mention'])
      .optional(),
    relevanceScore: z.number().min(0).max(10).optional(),
    product: z.object({
      name: z.string().min(1).max(80),
      url: z.string().url(),
      summary: z.string().min(1).max(300),
      mechanism: z.string().min(1).max(300),
      claims: z
        .array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) }))
        .max(8)
        .default([])
    }),
    account: z.object({ accountAgeDays: z.number().min(0), karma: z.number().min(0) }).nullish()
  }),
  steps: [
    {
      id: 'guard',
      type: 'skill',
      skillId: 'gtm.outreach-guard',
      input: {
        thread: { $ref: '$.input.thread' },
        account: { $ref: '$.input.account' },
        requireAllowed: true
      }
    },
    {
      id: 'draft',
      type: 'skill',
      skillId: 'gtm.draft-reply',
      needs: ['guard'],
      input: {
        thread: { $ref: '$.input.thread' },
        product: { $ref: '$.input.product' },
        angle: { $ref: '$.input.angle' }
      }
    },
    {
      id: 'approve-reply',
      type: 'approval',
      title: 'Approve community reply',
      needs: ['draft', 'guard'],
      payload: {
        platform: { $ref: '$.input.thread.platform' },
        threadExternalId: { $ref: '$.input.thread.externalId' },
        threadUrl: { $ref: '$.input.thread.url' },
        community: { $ref: '$.input.thread.community' },
        body: { $ref: '$.steps.draft.output.body' },
        metadata: {
          threadTitle: { $ref: '$.input.thread.title' },
          threadAuthor: { $ref: '$.input.thread.author' },
          relevanceScore: { $ref: '$.input.relevanceScore' },
          angle: { $ref: '$.steps.draft.output.angle' },
          safetyAllowed: { $ref: '$.steps.guard.output.allowed' },
          safetyReason: { $ref: '$.steps.guard.output.reason' },
          safetyChecks: { $ref: '$.steps.guard.output.checks' },
          critiquePassed: { $ref: '$.steps.draft.output.critique.passed' },
          critiqueFindings: { $ref: '$.steps.draft.output.critique.findings' },
          automationMode: { $ref: '$.steps.draft.output.automationMode' },
          submitUrl: { $ref: '$.steps.draft.output.submitUrl' }
        }
      }
    },
    {
      id: 'post-reply',
      type: 'action',
      actionType: 'community.reply',
      approvalStepId: 'approve-reply',
      needs: ['approve-reply'],
      payload: { $ref: '$.steps.approve-reply.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-reply.output.approved' },
    delivery: { $ref: '$.steps.post-reply.output' },
    draft: { $ref: '$.steps.draft.output' },
    safety: { $ref: '$.steps.guard.output' },
    thread: { $ref: '$.input.thread' }
  },
  source: { type: 'builtin' }
};
```

Add `registerPlaybook(threadReplyPlaybook);` beside the other four registrations, and add `import { outreachThreadSchema } from '../outreach/scorer.js';` to the imports if it is not already there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx scripts/test-with-postgres.ts src/server/playbooks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/playbooks/registry.ts src/server/playbooks/engine.test.ts
git commit -m "playbooks: add gtm.thread-reply for one chosen thread"
```

---

### Task 6: Offer defaults for the draft dialog

**Files:**

- Modify: `src/server/app.ts` (new route beside `/api/outreach/threads`)
- Modify: `src/client/api.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**

- Consumes: `linkedin_campaigns.brief_json` (`{ icp, offer: { name, summary, mechanism, proof: [{label, value}], url } }`).
- Produces: `GET /api/outreach/offer-defaults` -> `{ offer: { name: string; url: string; summary: string; mechanism: string; claims: Array<{label: string; value: string}> } }`; client `getOutreachOfferDefaults(): Promise<OutreachOffer>`.

- [ ] **Step 1: Write the failing test**

In `src/server/app.test.ts`:

```ts
it('prefills the reply offer from the newest campaign brief, and returns blanks without one', async () => {
  const empty = await agent.get('/api/outreach/offer-defaults').expect(200);
  expect(empty.body.offer).toEqual({ name: '', url: '', summary: '', mechanism: '', claims: [] });

  await db
    .prepare(
      `INSERT INTO linkedin_campaigns (id, workspace_id, name, status, sequence_json, brief_json, created_at, updated_at)
       VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?)`
    )
    .run(
      'camp_offer_1',
      DEMO_WORKSPACE_ID,
      'Offer source',
      'draft',
      JSON.stringify([]),
      JSON.stringify({
        icp: { role: 'founder', segment: 'seed saas', pain: 'cost' },
        offer: {
          name: 'Trevra',
          summary: 'A workspace an agent operates and a human approves.',
          mechanism: 'Composite signals plus a hard approval gate.',
          proof: [{ label: 'Execution', value: 'Nothing sends without approval' }],
          url: 'https://usetrevra.com'
        }
      }),
      '2026-08-19T00:00:00.000Z',
      '2026-08-19T00:00:00.000Z'
    );

  const filled = await agent.get('/api/outreach/offer-defaults').expect(200);
  expect(filled.body.offer).toEqual({
    name: 'Trevra',
    url: 'https://usetrevra.com',
    summary: 'A workspace an agent operates and a human approves.',
    mechanism: 'Composite signals plus a hard approval gate.',
    claims: [{ label: 'Execution', value: 'Nothing sends without approval' }]
  });
});
```

Check the real `linkedin_campaigns` column list before running (`\d linkedin_campaigns`); include every NOT NULL column the table has.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-with-postgres.ts src/server/app.test.ts -t 'prefills the reply offer'`
Expected: FAIL with 404.

- [ ] **Step 3: Add the route**

In `src/server/app.ts`, directly after the `/api/outreach/threads` handler:

```ts
/**
 * The offer the draft dialog starts from.
 *
 * Read from the newest campaign brief because that is where a founder already
 * wrote it down; NEVER inferred and never remembered here. A workspace with no
 * campaign gets empty strings and a 200 -- "nothing recorded yet" is an answer,
 * not an error, and the dialog is editable either way.
 */
app.get('/api/outreach/offer-defaults', async (req: AuthedRequest, res, next) => {
  try {
    const row = await db
      .prepare(
        `SELECT brief_json FROM linkedin_campaigns WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1`
      )
      .get<{ brief_json: unknown }>(req.auth!.workspaceId);
    const brief = (
      typeof row?.brief_json === 'string' ? JSON.parse(row.brief_json) : row?.brief_json
    ) as { offer?: Record<string, unknown> } | undefined;
    const offer = (brief?.offer ?? {}) as Record<string, unknown>;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const proof = Array.isArray(offer.proof) ? offer.proof : [];
    res.json({
      offer: {
        name: text(offer.name),
        url: text(offer.url),
        summary: text(offer.summary),
        mechanism: text(offer.mechanism),
        claims: proof
          .filter(
            (entry): entry is { label: string; value: string } =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof (entry as { label?: unknown }).label === 'string' &&
              typeof (entry as { value?: unknown }).value === 'string'
          )
          .map((entry) => ({ label: entry.label, value: entry.value }))
      }
    });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Add the client helper**

In `src/client/api.ts`, beside `getOutreachThreads`:

```ts
export interface OutreachOffer {
  name: string;
  url: string;
  summary: string;
  mechanism: string;
  claims: Array<{ label: string; value: string }>;
}

export async function getOutreachOfferDefaults(): Promise<OutreachOffer> {
  const result = await request<{ offer: OutreachOffer }>('/api/outreach/offer-defaults');
  return result.offer;
}
```

- [ ] **Step 5: Run typecheck and the test**

Run: `npm run typecheck && npx tsx scripts/test-with-postgres.ts src/server/app.test.ts -t 'prefills the reply offer'`
Expected: typecheck clean, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts src/client/api.ts
git commit -m "api: expose the offer the reply dialog starts from"
```

---

### Task 7: Card display helpers

Vitest runs in the `node` environment with no jsdom, so the card's derived strings are pure functions tested directly.

**Files:**

- Create: `src/client/views/researchFormat.ts`
- Create: `src/client/views/researchFormat.test.ts`

**Interfaces:**

- Consumes: `FeedThread` from `../api` (Task 4).
- Produces: `ageLabel(entry, now): string`, `whyChips(entry): string[]`, `factsLine(entry): string`.

- [ ] **Step 1: Write the failing test**

`src/client/views/researchFormat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FeedThread } from '../api';
import { ageLabel, factsLine, whyChips } from './researchFormat';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function entry(overrides: Partial<FeedThread> = {}): FeedThread {
  return {
    row: {
      id: 'ot_1',
      platform: 'hackernews',
      external_id: '48457585',
      url: 'https://news.ycombinator.com/item?id=48457585',
      title: 'Ask HN: What works for cutting AI token costs?',
      content: 'My LLM token bill is getting painful.',
      author: 'leoncos',
      community: null,
      score: 5,
      num_comments: 2,
      thread_created_at: '2026-08-17T12:00:00.000Z',
      first_seen_at: '2026-08-19T09:00:00.000Z',
      metadata_json: { tags: ['story', 'ask_hn'] }
    },
    relevance: {
      score: 7.4,
      components: [
        { label: 'high-value keywords (2)', points: 4 },
        { label: 'labelled question', points: 0.5 }
      ],
      highValueMatches: ['token cost', 'api cost'],
      negativeMatches: []
    },
    topics: ['token_cost'],
    angle: 'cost_comparison',
    guard: { allowed: true, reason: null, failedChecks: [] },
    ...overrides
  };
}

describe('ageLabel', () => {
  it("measures from the thread's own timestamp", () => {
    expect(ageLabel(entry(), NOW)).toBe('2d old');
  });

  it('says so when only the discovery time is known', () => {
    const row = { ...entry().row, thread_created_at: null };
    expect(ageLabel(entry({ row }), NOW)).toBe('first seen 3h ago');
  });
});

describe('whyChips', () => {
  it("renders the scorer's own components", () => {
    expect(whyChips(entry())).toEqual(['high-value keywords (2)', 'labelled question']);
  });

  it('surfaces a negative match rather than hiding it', () => {
    const chips = whyChips(
      entry({
        relevance: { ...entry().relevance, negativeMatches: ['stop spamming'] }
      })
    );
    expect(chips).toContain('negative: stop spamming');
  });
});

describe('factsLine', () => {
  it('labels the platform number points, never score', () => {
    expect(factsLine(entry(), NOW)).toBe('Hacker News · 2 comments · 5 points · 2d old');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/client/views/researchFormat.test.ts`
Expected: FAIL -- module not found.

- [ ] **Step 3: Write the module**

`src/client/views/researchFormat.ts`:

```ts
import type { FeedThread } from '../api';

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  devto: 'Dev.to',
  lobsters: 'Lobsters',
  mastodon: 'Mastodon',
  stackoverflow: 'Stack Overflow'
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function elapsed(from: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(from)) / 3_600_000);
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Thread age, or discovery age said plainly.
 *
 * A platform that reports no timestamp leaves only first_seen_at, which is when
 * WE looked -- presenting that as the thread's age would date a two-year-old
 * post to this morning.
 */
export function ageLabel(entry: FeedThread, now: Date): string {
  if (entry.row.thread_created_at) return `${elapsed(entry.row.thread_created_at, now)} old`;
  return `first seen ${elapsed(entry.row.first_seen_at, now)} ago`;
}

/** The scorer's own reasons, verbatim. Nothing is invented for display. */
export function whyChips(entry: FeedThread): string[] {
  return [
    ...entry.relevance.components.map((component) => component.label),
    ...entry.relevance.negativeMatches.map((match) => `negative: ${match}`)
  ];
}

/** The platform's own numbers, labelled so they are never read as relevance. */
export function factsLine(entry: FeedThread, now: Date): string {
  return [
    platformLabel(entry.row.platform),
    `${entry.row.num_comments} comments`,
    `${entry.row.score} points`,
    ageLabel(entry, now)
  ].join(' · ');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/client/views/researchFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/views/researchFormat.ts src/client/views/researchFormat.test.ts
git commit -m "research: pure helpers for the thread card's derived strings"
```

---

### Task 8: The card and the draft dialog

**Files:**

- Modify: `src/client/views/ResearchView.tsx`
- Modify: `src/client/styles.css` (or the stylesheet the view already uses -- follow whatever `client-card-large` is defined in)

**Interfaces:**

- Consumes: `FeedThread`, `getOutreachThreads`, `getOutreachOfferDefaults`, `startPlaybook` from `../api`; `ageLabel`, `factsLine`, `whyChips`, `platformLabel` from `./researchFormat`.
- Produces: no exports beyond the existing `ResearchView`.

- [ ] **Step 1: Render the judgement on the card**

Replace the body of the discovered-threads `<article>` so each row leads with relevance and explains it:

```tsx
<article
  className={`client-card-large ${entry.guard.allowed ? '' : 'is-blocked'}`}
  key={entry.row.id}
>
  <span className="client-avatar large">{entry.relevance.score.toFixed(1)}</span>
  <div>
    <h3>
      <a href={entry.row.url} target="_blank" rel="noreferrer">
        {entry.row.title}
      </a>
    </h3>
    <p>{factsLine(entry, now)}</p>
    <p className="client-why">
      {whyChips(entry).map((chip) => (
        <span className="client-status" key={chip}>
          {chip}
        </span>
      ))}
    </p>
    <p>
      angle: {entry.angle}
      {entry.topics.length > 0 ? ` · topics: ${entry.topics.join(', ')}` : ''}
    </p>
    {!entry.guard.allowed && <p className="client-blocked">Blocked: {entry.guard.reason}</p>}
    <button
      type="button"
      className="li-range"
      disabled={!entry.guard.allowed}
      onClick={() => setDrafting(entry)}
    >
      Draft reply
    </button>
  </div>
</article>
```

`now` is a single `useMemo(() => new Date(), [])` for the view, so every row measures age against the same instant.

- [ ] **Step 2: Add the dialog state and the offer prefill**

```tsx
const [drafting, setDrafting] = useState<FeedThread | null>(null);
const [offer, setOffer] = useState<OutreachOffer>({
  name: '',
  url: '',
  summary: '',
  mechanism: '',
  claims: []
});
const [starting, setStarting] = useState(false);
const [dialogError, setDialogError] = useState<string | null>(null);

useEffect(() => {
  if (!drafting) return;
  let cancelled = false;
  getOutreachOfferDefaults()
    .then((loaded) => {
      if (!cancelled) setOffer(loaded);
    })
    .catch(() => {
      /* An absent brief is not an error; the dialog stays editable and empty. */
    });
  return () => {
    cancelled = true;
  };
}, [drafting]);
```

- [ ] **Step 3: Start the playbook from the dialog**

```tsx
async function startDraft(entry: FeedThread): Promise<void> {
  setStarting(true);
  setDialogError(null);
  try {
    const run = await startPlaybook('gtm.thread-reply', {
      thread: {
        platform: entry.row.platform,
        externalId: entry.row.external_id,
        url: entry.row.url,
        title: entry.row.title,
        content: entry.row.content,
        author: entry.row.author,
        community: entry.row.community,
        score: entry.row.score,
        numComments: entry.row.num_comments,
        createdAt: entry.row.thread_created_at,
        metadata: entry.row.metadata_json
      },
      angle: entry.angle,
      relevanceScore: entry.relevance.score,
      product: offer
    });
    setDrafting(null);
    setToast(`Draft prepared for approval (run ${run.id}).`);
  } catch (error) {
    setDialogError(error instanceof Error ? error.message : 'Could not start the draft.');
  } finally {
    setStarting(false);
  }
}
```

The dialog renders five labelled inputs bound to `offer` (name, url, summary, mechanism, and claims as read-only chips), a Cancel button that clears `drafting`, and a submit button disabled while `starting` or when `offer.name`/`offer.url`/`offer.summary`/`offer.mechanism` is empty. `dialogError` renders inline above the buttons and leaves the typed offer intact.

- [ ] **Step 4: Style the blocked and why rows**

Add to the stylesheet that defines `client-card-large`:

```css
.client-card-large.is-blocked {
  opacity: 0.55;
}
.client-why {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.client-blocked {
  color: var(--danger, #b42318);
}
```

- [ ] **Step 5: Verify against the running app**

Run: `npm run typecheck && npx vitest run src/client`
Then open the dev app (`http://localhost:43173`) at `/research`, confirm: rows are ordered by relevance, the leading number is relevance and the platform number reads `N points`, why-chips match the scorer, a blocked row is dimmed and names its failing check, and "Draft reply" opens the dialog prefilled from the newest campaign brief. Start one draft and confirm it lands as `waiting_approval`:

```bash
docker exec trevra-dev-postgres-1 psql -U trevra -d trevra -P pager=off \
  -c "select id,playbook_key,status from playbook_runs order by created_at desc limit 3"
```

- [ ] **Step 6: Commit**

```bash
git add src/client/views/ResearchView.tsx src/client/styles.css
git commit -m "research: lead the thread card with relevance and draft in one click"
```

---

## Final verification

- [ ] `npm test` (full suite through testcontainers Postgres)
- [ ] `npm run build`
- [ ] Re-scout once (`gtm.scout-threads`) and confirm `/research` rows now carry stored `content`, so relevance is computed against bodies rather than titles alone.
