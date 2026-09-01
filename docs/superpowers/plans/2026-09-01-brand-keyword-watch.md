# Brand + Keyword Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a founder create named brand/keyword watches in the Research tab that sweep community platforms on a cadence, store each mention with a deterministic sentiment label and the sentence that decided it, render a 30-day sentiment trend, and promote any mention into the existing `gtm.thread-reply` approval flow.

**Architecture:** A pure lexicon scorer (`watch/sentiment.ts`) and a Postgres store (`watch/store.ts`) sit under one new skill (`gtm.watch-mentions`) that reuses the existing `outreach/scouts/*` fetchers. A worker entry (`watch/service.ts`) leases due watches and advances their cadence. Express routes expose CRUD, mentions, trend, manual run, and promotion; `ResearchView.tsx` gains a watch bar, a watch dialog, and a mention panel.

**Tech Stack:** TypeScript, Node, Express, React 18, Postgres via `pg` (no ORM), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-brand-keyword-watch-design.md`

## Global Constraints

- All new server modules live under `src/server/watch/`. ESM: every relative import ends in `.js`.
- Database access is `db.prepare(sql).all<T>(...)` / `.get<T>(...)` / `.run(...)` with `?` placeholders. Ids come from `id(prefix)` in `src/server/db.js`.
- Postgres `numeric` columns come back from `pg` as **strings**. Every read of `sentiment_score` and `score_sum` must go through `Number(...)`.
- Postgres `date` columns must be selected as `TO_CHAR(day,'YYYY-MM-DD') AS day`, never returned raw. Precedent: `lastPostInCommunity` in `src/server/outreach/store.ts`.
- Every query is workspace-scoped. No query may omit `workspace_id`.
- `keywords` capped at 20 per watch. `limit_per_platform` in `[1, 100]`, default 25. `cadence` is `'daily' | 'weekly'`.
- `linkedin` is never offered as a watch platform (its scout is permanently `disabled`).
- Default platform set for a new watch: `hackernews`, `stackoverflow`, `lobsters`, `github`.
- `SENTIMENT_VERSION` starts at `1`.
- Tests: `npm run test:unit -- <path>` for a single file; `npm test` runs the full suite with Postgres. Postgres-backed tests need `TEST_DATABASE_URL`; run them through `npm test` or `tsx scripts/test-with-postgres.ts`.
- Commit after every task. Pre-commit runs Prettier and auto-stages formatting.

---

## File Structure

| File                                            | Responsibility                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `migrations/112_brand_watches.sql`              | Create `brand_watches`, `brand_watch_mentions`, `brand_watch_sentiment_daily`.              |
| `src/server/watch/sentiment.ts`                 | Pure lexicon sentiment scorer. No I/O.                                                      |
| `src/server/watch/store.ts`                     | All Postgres reads/writes for watches, mentions, and the daily rollup.                      |
| `src/server/watch/skill.ts`                     | `watchMentions()` orchestration + the `gtm.watch-mentions` skill wrapper.                   |
| `src/server/watch/service.ts`                   | `runBrandWatch` (lease + cadence) and `runDueBrandWatches` (worker entry).                  |
| `src/server/outreach/types.ts` (modify)         | Add `communities?` to `ScoutQuery`.                                                         |
| `src/server/outreach/scouts/github.ts` (modify) | Honour `query.communities`.                                                                 |
| `src/server/outreach/scouts/reddit.ts` (modify) | Honour `query.communities`.                                                                 |
| `src/server/skills/registry.ts` (modify)        | Import + register `watchMentionsSkill`.                                                     |
| `src/worker/index.ts` (modify)                  | Add `runDueBrandWatches(db)` to `cycle()`.                                                  |
| `src/server/app.ts` (modify)                    | Eight `/api/watches` routes + their Zod schemas.                                            |
| `src/client/api.ts` (modify)                    | Typed client wrappers for those routes.                                                     |
| `src/client/views/ResearchView.tsx` (modify)    | Watch bar, `WatchDialog`, mention panel, trend strip.                                       |
| `src/client/views/researchFormat.ts` (modify)   | `sentimentChip` display formatter.                                                          |
| `src/client/styles.css` (modify)                | `.research-watch-*`, `.research-mention-panel`, `.research-trend*`, `.research-sentiment*`. |

---

## Task 1: Sentiment scorer

Independent of everything else. Start here so the mention shape is settled before the store is written.

**Files:**

- Create: `src/server/watch/sentiment.ts`
- Test: `src/server/watch/sentiment.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SENTIMENT_VERSION: number`, `Sentiment` interface, `scoreSentiment(text: string): Sentiment`.

```ts
export interface Sentiment {
  label: 'positive' | 'neutral' | 'negative';
  score: number; // -1..1, 3dp
  span: string; // verbatim deciding sentence, '' when neutral by default
  matches: Array<{ term: string; weight: number; negated: boolean }>;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/server/watch/sentiment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SENTIMENT_VERSION, scoreSentiment } from './sentiment.js';

describe('scoreSentiment', () => {
  it('labels a plainly positive sentence positive', () => {
    const result = scoreSentiment('Trevra is excellent and it saved us hours.');
    expect(result.label).toBe('positive');
    expect(result.score).toBeGreaterThan(0);
  });

  it('labels a plainly negative sentence negative', () => {
    const result = scoreSentiment('The onboarding was terrible and it broke twice.');
    expect(result.label).toBe('negative');
    expect(result.score).toBeLessThan(0);
  });

  it('treats a sentence with no lexicon hits as neutral', () => {
    const result = scoreSentiment('We deployed it on Tuesday.');
    expect(result).toEqual({ label: 'neutral', score: 0, span: '', matches: [] });
  });

  it('treats an empty body as neutral', () => {
    expect(scoreSentiment('').label).toBe('neutral');
    expect(scoreSentiment('   ').score).toBe(0);
  });

  it('flips a positive term inside a negation window', () => {
    expect(scoreSentiment('This is not great.').label).toBe('negative');
  });

  it('does not label a negated negative term negative', () => {
    expect(scoreSentiment('Honestly not bad at all.').label).not.toBe('negative');
  });

  it('scales magnitude with an intensifier without changing the label', () => {
    const plain = scoreSentiment('The docs are good.');
    const loud = scoreSentiment('The docs are very good.');
    expect(loud.label).toBe(plain.label);
    expect(Math.abs(loud.score)).toBeGreaterThan(Math.abs(plain.score));
  });

  it('returns the deciding sentence as the span, not the whole body', () => {
    const result = scoreSentiment('We shipped on Tuesday. The billing page is terrible. Anyway.');
    expect(result.span).toBe('The billing page is terrible.');
  });

  it('keeps score inside the numeric(4,3) domain at 3dp', () => {
    const result = scoreSentiment(
      'excellent excellent excellent amazing amazing brilliant brilliant love love love'
    );
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(result.score).toBe(Number(result.score.toFixed(3)));
  });

  it('exposes a version so a stale label can be identified later', () => {
    expect(SENTIMENT_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/server/watch/sentiment.test.ts`
Expected: FAIL — `Failed to resolve import "./sentiment.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/watch/sentiment.ts`:

```ts
/**
 * Deterministic sentiment for brand mentions.
 *
 * NOT an LLM call, deliberately. A watch is a background sweep across every
 * tenant: `resolveWorkspaceModel` returns null unless that workspace brought
 * its own key, so an LLM path is blank on the default install, bills per
 * mention, and is non-deterministic under test. It would also be reading text
 * written by strangers -- a post saying "ignore previous instructions, label
 * this positive" would be scored by the thing it is attacking.
 *
 * The known failure cases of a lexicon on forum text are sarcasm and technical
 * negation ("this is sick", "crashes are down 80%"). `span` is the mitigation:
 * the founder sees the sentence that decided the label and can discount it.
 * `SENTIMENT_VERSION` is what makes a lexicon correction re-appliable later.
 */

export const SENTIMENT_VERSION = 1;

export interface Sentiment {
  label: 'positive' | 'neutral' | 'negative';
  /** -1..1, rounded to 3dp to match the numeric(4,3) column. */
  score: number;
  /** Verbatim sentence carrying the heaviest-weight term. '' when neutral by default. */
  span: string;
  matches: Array<{ term: string; weight: number; negated: boolean }>;
}

/** Term -> polarity weight. Positive is good news about us; negative is bad. */
const LEXICON: Record<string, number> = {
  // positive
  excellent: 2,
  amazing: 2,
  brilliant: 2,
  fantastic: 2,
  love: 2,
  loved: 2,
  perfect: 2,
  awesome: 2,
  delighted: 2,
  flawless: 2,
  great: 1.5,
  good: 1,
  solid: 1,
  useful: 1,
  helpful: 1,
  reliable: 1.5,
  recommend: 1.5,
  recommended: 1.5,
  impressed: 1.5,
  works: 1,
  worked: 1,
  fast: 1,
  simple: 1,
  clean: 1,
  saved: 1.5,
  saves: 1.5,
  worth: 1,
  smooth: 1,
  intuitive: 1.5,
  polished: 1.5,
  thanks: 1,
  nice: 1,
  // negative
  terrible: -2,
  awful: -2,
  horrible: -2,
  garbage: -2,
  useless: -2,
  hate: -2,
  hated: -2,
  scam: -2,
  broken: -2,
  unusable: -2,
  bad: -1.5,
  slow: -1,
  buggy: -1.5,
  confusing: -1.5,
  expensive: -1,
  overpriced: -1.5,
  disappointing: -1.5,
  disappointed: -1.5,
  clunky: -1.5,
  crashed: -1.5,
  crashes: -1.5,
  fails: -1.5,
  failed: -1.5,
  broke: -1.5,
  frustrating: -1.5,
  painful: -1.5,
  misleading: -2,
  ignored: -1,
  wasted: -1.5
};

const NEGATORS = new Set([
  'not',
  'no',
  'never',
  'none',
  'nobody',
  'nothing',
  'cannot',
  "can't",
  "isn't",
  "wasn't",
  "doesn't",
  "didn't",
  "don't",
  "won't",
  "aren't",
  'without'
]);

const INTENSIFIERS = new Set(['very', 'really', 'extremely', 'incredibly', 'super', 'so']);

/** How many tokens back from a term a negator still flips it. */
const NEGATION_WINDOW = 3;

const NEUTRAL_BAND = 0.15;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function tokens(sentence: string): string[] {
  return sentence.toLowerCase().match(/[a-z']+/gu) ?? [];
}

export function scoreSentiment(text: string): Sentiment {
  const matches: Sentiment['matches'] = [];
  let total = 0;
  let heaviest = 0;
  let span = '';

  for (const sentence of sentences(text)) {
    const words = tokens(sentence);
    let sentenceWeight = 0;

    for (let index = 0; index < words.length; index += 1) {
      const base = LEXICON[words[index]];
      if (base === undefined) continue;

      let weight = base;
      const window = words.slice(Math.max(0, index - NEGATION_WINDOW), index);
      const negated = window.some((word) => NEGATORS.has(word));
      if (negated) weight = -weight;
      if (window.some((word) => INTENSIFIERS.has(word))) weight *= 1.5;

      matches.push({ term: words[index], weight, negated });
      sentenceWeight += weight;
      total += weight;
    }

    if (Math.abs(sentenceWeight) > Math.abs(heaviest)) {
      heaviest = sentenceWeight;
      span = sentence;
    }
  }

  if (matches.length === 0) return { label: 'neutral', score: 0, span: '', matches: [] };

  const raw = total / Math.sqrt(matches.length);
  const score = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
  const label = score > NEUTRAL_BAND ? 'positive' : score < -NEUTRAL_BAND ? 'negative' : 'neutral';

  return { label, score, span: label === 'neutral' ? '' : span, matches };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/server/watch/sentiment.test.ts`
Expected: PASS, 10 tests.

If the "not bad at all" case still reads negative, check that `NEGATORS` is consulted on the tokens **before** the term, not including it.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/server/watch/sentiment.ts src/server/watch/sentiment.test.ts
git commit -m "score brand mention sentiment without an LLM"
```

---

## Task 2: Migration and watch store

**Files:**

- Create: `migrations/112_brand_watches.sql`
- Create: `src/server/watch/store.ts`
- Test: `src/server/watch/store.test.ts`

**Interfaces:**

- Consumes: `id`, `Db` from `../db.js`.
- Produces:

```ts
export interface BrandWatch {
  id: string;
  workspaceId: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  enabled: boolean;
  limitPerPlatform: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}
export interface BrandWatchInput {
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  limitPerPlatform?: number;
  enabled?: boolean;
}
export function createWatch(
  db: Db,
  workspaceId: string,
  input: BrandWatchInput,
  now: Date
): Promise<BrandWatch>;
export function listWatches(db: Db, workspaceId: string): Promise<BrandWatch[]>;
export function getWatch(db: Db, workspaceId: string, watchId: string): Promise<BrandWatch | null>;
export function updateWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  patch: Partial<BrandWatchInput>,
  now: Date
): Promise<BrandWatch | null>;
export function deleteWatch(db: Db, workspaceId: string, watchId: string): Promise<boolean>;
```

- [ ] **Step 1: Write the migration**

Create `migrations/112_brand_watches.sql` with the exact DDL from the spec's "Data model" section (three `CREATE TABLE IF NOT EXISTS` statements plus their indexes), preceded by this comment:

```sql
-- Named brand/keyword watches and the mentions they find.
--
-- Deliberately NOT outreach_threads. That table is the denominator of the
-- self-promotion ratio in outreach/safety.ts, so writing brand mentions into
-- it would move the denominator and silently loosen the reply safety gate for
-- every campaign. A `source` discriminator does not fix that -- it would
-- require editing every existing query in store.ts, feed.ts and safety.ts, and
-- one missed query is a loosened gate.
```

Copy the DDL verbatim from the spec. Do not add a `-- trevra:no-transaction` marker; this migration is transactional.

- [ ] **Step 2: Apply and verify the migration**

Run: `npm run db:migrate`
Expected: `112_brand_watches.sql` in the applied list, no error.

Verify the constraint fires:

```bash
psql "$DATABASE_URL" -c "INSERT INTO brand_watches (id,workspace_id,name,keywords,platforms,cadence) VALUES ('bw_x','ws_demo','x',ARRAY['a'],ARRAY['hackernews'],'hourly');"
```

Expected: `new row for relation "brand_watches" violates check constraint`.

- [ ] **Step 3: Write the failing store test**

Create `src/server/watch/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { createWatch, deleteWatch, getWatch, listWatches, updateWatch } from './store.js';

let db: Db;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const OTHER_WORKSPACE = 'ws_other';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- src/server/watch/store.test.ts`
Expected: FAIL — cannot resolve `./store.js`.

- [ ] **Step 5: Write the store**

Create `src/server/watch/store.ts`:

```ts
import { id, type Db } from '../db.js';

/**
 * Postgres state for brand/keyword watches.
 *
 * Every statement is workspace-scoped, including the ones that take a watch id:
 * a watch id is guessable enough that scoping on it alone would be a
 * cross-tenant read. `getWatch`/`updateWatch` return null and `deleteWatch`
 * returns false when the row belongs to another workspace, so callers turn
 * that into a 404 rather than leaking that the id exists.
 */

export interface BrandWatch {
  id: string;
  workspaceId: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  enabled: boolean;
  limitPerPlatform: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface BrandWatchInput {
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  limitPerPlatform?: number;
  enabled?: boolean;
}

interface WatchRow {
  id: string;
  workspace_id: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: string;
  enabled: boolean;
  limit_per_platform: number;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
}

// The pool installs a pass-through parser for timestamptz, so these arrive as
// raw pg text ('2026-09-01 09:00:00+00'). Formatting them in SQL instead keeps
// one unambiguous ISO shape rather than relying on Date's tolerance.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const WATCH_COLUMNS = `
  id, workspace_id, name, keywords, platforms, cadence, enabled, limit_per_platform,
  TO_CHAR(next_run_at AT TIME ZONE 'UTC', ${ISO}) AS next_run_at,
  TO_CHAR(last_run_at AT TIME ZONE 'UTC', ${ISO}) AS last_run_at,
  last_error
`;

function serialize(row: WatchRow): BrandWatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    keywords: row.keywords ?? [],
    platforms: row.platforms ?? [],
    cadence: row.cadence === 'weekly' ? 'weekly' : 'daily',
    enabled: row.enabled,
    limitPerPlatform: row.limit_per_platform,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastError: row.last_error
  };
}

export async function createWatch(
  db: Db,
  workspaceId: string,
  input: BrandWatchInput,
  now: Date
): Promise<BrandWatch> {
  const timestamp = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO brand_watches
         (id, workspace_id, name, keywords, platforms, cadence, enabled, limit_per_platform,
          next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       RETURNING ${WATCH_COLUMNS}`
    )
    .get<WatchRow>(
      id('bw'),
      workspaceId,
      input.name,
      input.keywords,
      input.platforms,
      input.cadence,
      input.enabled ?? true,
      input.limitPerPlatform ?? 25,
      timestamp,
      timestamp,
      timestamp
    );
  if (!row) throw new Error('Could not create the watch.');
  return serialize(row);
}

export async function listWatches(db: Db, workspaceId: string): Promise<BrandWatch[]> {
  const rows = await db
    .prepare(`SELECT ${WATCH_COLUMNS} FROM brand_watches WHERE workspace_id=? ORDER BY name`)
    .all<WatchRow>(workspaceId);
  return rows.map(serialize);
}

export async function getWatch(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<BrandWatch | null> {
  const row = await db
    .prepare(`SELECT ${WATCH_COLUMNS} FROM brand_watches WHERE workspace_id=? AND id=?`)
    .get<WatchRow>(workspaceId, watchId);
  return row ? serialize(row) : null;
}

/**
 * Patch the supplied fields only.
 *
 * COALESCE on a NULL parameter rather than a built statement: every column
 * keeps its current value unless the caller named it, and there is one
 * statement to read instead of a string assembled from the patch keys.
 */
export async function updateWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  patch: Partial<BrandWatchInput>,
  now: Date
): Promise<BrandWatch | null> {
  const row = await db
    .prepare(
      `UPDATE brand_watches SET
         name = COALESCE(?, name),
         keywords = COALESCE(?, keywords),
         platforms = COALESCE(?, platforms),
         cadence = COALESCE(?, cadence),
         enabled = COALESCE(?, enabled),
         limit_per_platform = COALESCE(?, limit_per_platform),
         updated_at = ?
       WHERE workspace_id=? AND id=?
       RETURNING ${WATCH_COLUMNS}`
    )
    .get<WatchRow>(
      patch.name ?? null,
      patch.keywords ?? null,
      patch.platforms ?? null,
      patch.cadence ?? null,
      patch.enabled ?? null,
      patch.limitPerPlatform ?? null,
      now.toISOString(),
      workspaceId,
      watchId
    );
  return row ? serialize(row) : null;
}

export async function deleteWatch(db: Db, workspaceId: string, watchId: string): Promise<boolean> {
  const row = await db
    .prepare('DELETE FROM brand_watches WHERE workspace_id=? AND id=? RETURNING id')
    .get<{ id: string }>(workspaceId, watchId);
  return row !== undefined;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/server/watch/store.test.ts`
Expected: PASS, 7 tests.

If `keywords` comes back as a string rather than an array, the column was created as `text` instead of `text[]` — re-check the migration.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add migrations/112_brand_watches.sql src/server/watch/store.ts src/server/watch/store.test.ts
git commit -m "store named brand and keyword watches"
```

---

## Task 3: Mention persistence and trend

**Files:**

- Modify: `src/server/watch/store.ts` (append)
- Test: `src/server/watch/store.test.ts` (append a second `describe`)

**Interfaces:**

- Consumes: `Sentiment` from Task 1; `OutreachThread` from `../outreach/types.js`; `createWatch` from Task 2.
- Produces:

```ts
export interface WatchMention {
  id: string;
  watchId: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  matchedKeywords: string[];
  sentimentLabel: 'positive' | 'neutral' | 'negative';
  sentimentScore: number;
  sentimentSpan: string;
  metadata: Record<string, unknown>;
  mentionCreatedAt: string | null;
  firstSeenAt: string;
  promotedRunId: string | null;
}
export interface WatchMentionInput {
  thread: OutreachThread;
  matchedKeywords: string[];
  sentiment: Sentiment;
}
export interface TrendPoint {
  day: string;
  positive: number;
  neutral: number;
  negative: number;
  average: number;
}
export function recordWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  inputs: readonly WatchMentionInput[],
  now: Date
): Promise<{ inserted: number; updated: number }>;
export function listWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  filters?: { sentiment?: string; platform?: string; limit?: number }
): Promise<WatchMention[]>;
export function getWatchMention(
  db: Db,
  workspaceId: string,
  mentionId: string
): Promise<WatchMention | null>;
export function markMentionPromoted(
  db: Db,
  workspaceId: string,
  mentionId: string,
  runId: string,
  now: Date
): Promise<void>;
export function sentimentTrend(
  db: Db,
  workspaceId: string,
  watchId: string,
  days: number,
  now: Date
): Promise<TrendPoint[]>;
```

- [ ] **Step 1: Write the failing test**

Append to `src/server/watch/store.test.ts` (add the new names to the existing import from `./store.js`, and add `import { scoreSentiment } from './sentiment.js';` plus `import type { OutreachThread } from '../outreach/types.js';`):

```ts
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

  it('buckets on first_seen_at when the platform reported no creation time', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await recordWatchMentions(db, DEMO_WORKSPACE_ID, watch.id, [mention({ createdAt: null })], NOW);
    const trend = await sentimentTrend(db, DEMO_WORKSPACE_ID, watch.id, 7, NOW);
    expect(trend.find((point) => point.day === '2026-09-01')?.positive).toBe(1);
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
        `INSERT INTO playbook_runs (id, workspace_id, playbook_key, playbook_version, status, input_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?::jsonb,?,?)`
      )
      .run(
        'pbr_test',
        DEMO_WORKSPACE_ID,
        'gtm.thread-reply',
        '1.0.0',
        'waiting_approval',
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
```

If the `playbook_runs` insert fails on a missing column, run `psql "$DATABASE_URL" -c '\d playbook_runs'` and adjust the column list to the real one — the assertion that matters is the `SET NULL` behaviour, not the insert's shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/watch/store.test.ts`
Expected: FAIL — `recordWatchMentions is not exported`.

- [ ] **Step 3: Append the implementation to `src/server/watch/store.ts`**

Add `import { createHash } from 'node:crypto';`, `import type { OutreachThread } from '../outreach/types.js';`, and `import { SENTIMENT_VERSION, type Sentiment } from './sentiment.js';` at the top, then append:

```ts
export interface WatchMention {
  id: string;
  watchId: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  matchedKeywords: string[];
  sentimentLabel: 'positive' | 'neutral' | 'negative';
  sentimentScore: number;
  sentimentSpan: string;
  metadata: Record<string, unknown>;
  mentionCreatedAt: string | null;
  firstSeenAt: string;
  promotedRunId: string | null;
}

export interface WatchMentionInput {
  thread: OutreachThread;
  matchedKeywords: string[];
  sentiment: Sentiment;
}

export interface TrendPoint {
  day: string;
  positive: number;
  neutral: number;
  negative: number;
  average: number;
}

interface MentionRow {
  id: string;
  watch_id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  matched_keywords: string[];
  sentiment_label: string;
  sentiment_score: string;
  sentiment_span: string;
  metadata_json: unknown;
  mention_created_at: string | null;
  first_seen_at: string;
  promoted_run_id: string | null;
}

const MENTION_COLUMNS = `
  id, watch_id, platform, external_id, url, title, content, author, community,
  score, num_comments, matched_keywords, sentiment_label, sentiment_score,
  sentiment_span, metadata_json,
  TO_CHAR(mention_created_at AT TIME ZONE 'UTC', ${ISO}) AS mention_created_at,
  TO_CHAR(first_seen_at AT TIME ZONE 'UTC', ${ISO}) AS first_seen_at,
  promoted_run_id
`;

function serializeMention(row: MentionRow): WatchMention {
  return {
    id: row.id,
    watchId: row.watch_id,
    platform: row.platform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    content: row.content,
    author: row.author,
    community: row.community,
    score: row.score,
    numComments: row.num_comments,
    matchedKeywords: row.matched_keywords ?? [],
    sentimentLabel:
      row.sentiment_label === 'positive'
        ? 'positive'
        : row.sentiment_label === 'negative'
          ? 'negative'
          : 'neutral',
    // pg returns numeric as a string; every consumer wants a number.
    sentimentScore: Number(row.sentiment_score),
    sentimentSpan: row.sentiment_span,
    metadata:
      (typeof row.metadata_json === 'string'
        ? JSON.parse(row.metadata_json)
        : (row.metadata_json as Record<string, unknown>)) ?? {},
    mentionCreatedAt: row.mention_created_at,
    firstSeenAt: row.first_seen_at,
    promotedRunId: row.promoted_run_id
  };
}

function mentionContentHash(thread: Pick<OutreachThread, 'title' | 'content'>): string {
  return createHash('sha256').update(`${thread.title}\n${thread.content}`).digest('hex');
}

/**
 * Upsert `inputs` against `watchId` and roll the new ones into the daily trend.
 *
 * The rollup is incremented ONLY on the insert arm. A watch re-polls the same
 * thread on every run, and counting an update would inflate the trend line the
 * founder makes decisions on -- by exactly the number of times we happened to
 * look.
 */
export async function recordWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  inputs: readonly WatchMentionInput[],
  now: Date
): Promise<{ inserted: number; updated: number }> {
  const timestamp = now.toISOString();
  let inserted = 0;
  let updated = 0;

  for (const input of inputs) {
    const { thread, sentiment } = input;
    const row = await db
      .prepare(
        `INSERT INTO brand_watch_mentions (
           id, workspace_id, watch_id, platform, external_id, url, title, content, author,
           community, score, num_comments, matched_keywords, sentiment_label, sentiment_score,
           sentiment_span, sentiment_version, content_hash, metadata_json, mention_created_at,
           first_seen_at, last_seen_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (watch_id, platform, external_id) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           content = excluded.content,
           score = excluded.score,
           num_comments = excluded.num_comments,
           matched_keywords = excluded.matched_keywords,
           sentiment_label = excluded.sentiment_label,
           sentiment_score = excluded.sentiment_score,
           sentiment_span = excluded.sentiment_span,
           sentiment_version = excluded.sentiment_version,
           content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json,
           last_seen_at = excluded.last_seen_at
         RETURNING id, (xmax = 0) AS is_new,
           TO_CHAR(COALESCE(mention_created_at, first_seen_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket`
      )
      .get<{ id: string; is_new: boolean; bucket: string }>(
        id('bwm'),
        workspaceId,
        watchId,
        thread.platform,
        thread.externalId,
        thread.url,
        thread.title,
        thread.content,
        thread.author,
        thread.community,
        Math.trunc(thread.score),
        Math.trunc(thread.numComments),
        input.matchedKeywords,
        sentiment.label,
        sentiment.score,
        sentiment.span,
        SENTIMENT_VERSION,
        mentionContentHash(thread),
        JSON.stringify(thread.metadata ?? {}),
        thread.createdAt,
        timestamp,
        timestamp
      );

    if (!row) continue;
    if (!row.is_new) {
      updated += 1;
      continue;
    }
    inserted += 1;

    await db
      .prepare(
        `INSERT INTO brand_watch_sentiment_daily
           (workspace_id, watch_id, day, positive, neutral, negative, score_sum, updated_at)
         VALUES (?,?,?::date,?,?,?,?,?)
         ON CONFLICT (workspace_id, watch_id, day) DO UPDATE SET
           positive = brand_watch_sentiment_daily.positive + excluded.positive,
           neutral = brand_watch_sentiment_daily.neutral + excluded.neutral,
           negative = brand_watch_sentiment_daily.negative + excluded.negative,
           score_sum = brand_watch_sentiment_daily.score_sum + excluded.score_sum,
           updated_at = excluded.updated_at`
      )
      .run(
        workspaceId,
        watchId,
        row.bucket,
        sentiment.label === 'positive' ? 1 : 0,
        sentiment.label === 'neutral' ? 1 : 0,
        sentiment.label === 'negative' ? 1 : 0,
        sentiment.score,
        timestamp
      );
  }

  return { inserted, updated };
}

export async function listWatchMentions(
  db: Db,
  workspaceId: string,
  watchId: string,
  filters: { sentiment?: string; platform?: string; limit?: number } = {}
): Promise<WatchMention[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db
    .prepare(
      `SELECT ${MENTION_COLUMNS} FROM brand_watch_mentions
       WHERE workspace_id=? AND watch_id=?
         AND (?::text IS NULL OR sentiment_label = ?)
         AND (?::text IS NULL OR platform = ?)
       ORDER BY first_seen_at DESC
       LIMIT ?`
    )
    .all<MentionRow>(
      workspaceId,
      watchId,
      filters.sentiment ?? null,
      filters.sentiment ?? null,
      filters.platform ?? null,
      filters.platform ?? null,
      limit
    );
  return rows.map(serializeMention);
}

export async function getWatchMention(
  db: Db,
  workspaceId: string,
  mentionId: string
): Promise<WatchMention | null> {
  const row = await db
    .prepare(`SELECT ${MENTION_COLUMNS} FROM brand_watch_mentions WHERE workspace_id=? AND id=?`)
    .get<MentionRow>(workspaceId, mentionId);
  return row ? serializeMention(row) : null;
}

export async function markMentionPromoted(
  db: Db,
  workspaceId: string,
  mentionId: string,
  runId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE brand_watch_mentions SET promoted_run_id=?, promoted_at=? WHERE workspace_id=? AND id=?'
    )
    .run(runId, now.toISOString(), workspaceId, mentionId);
}

/**
 * The trend line, zero-filled across the whole window.
 *
 * generate_series rather than a GROUP BY over the rollup: a day with no
 * mentions must render as an empty bar, not as a gap that silently shortens
 * the strip.
 */
export async function sentimentTrend(
  db: Db,
  workspaceId: string,
  watchId: string,
  days: number,
  now: Date
): Promise<TrendPoint[]> {
  const window = Math.min(Math.max(Math.trunc(days), 1), 180);
  const rows = await db
    .prepare(
      `SELECT TO_CHAR(series.day, 'YYYY-MM-DD') AS day,
              COALESCE(rollup.positive, 0) AS positive,
              COALESCE(rollup.neutral, 0) AS neutral,
              COALESCE(rollup.negative, 0) AS negative,
              COALESCE(rollup.score_sum, 0) AS score_sum
       FROM generate_series(
              (?::timestamptz AT TIME ZONE 'UTC')::date - (? - 1),
              (?::timestamptz AT TIME ZONE 'UTC')::date,
              INTERVAL '1 day'
            ) AS series(day)
       LEFT JOIN brand_watch_sentiment_daily AS rollup
         ON rollup.day = series.day AND rollup.workspace_id = ? AND rollup.watch_id = ?
       ORDER BY series.day`
    )
    .all<{
      day: string;
      positive: number;
      neutral: number;
      negative: number;
      score_sum: string;
    }>(now.toISOString(), window, now.toISOString(), workspaceId, watchId);

  return rows.map((row) => {
    const total = row.positive + row.neutral + row.negative;
    return {
      day: row.day,
      positive: row.positive,
      neutral: row.neutral,
      negative: row.negative,
      average: total === 0 ? 0 : Number((Number(row.score_sum) / total).toFixed(3))
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/server/watch/store.test.ts`
Expected: PASS, 16 tests (7 from Task 2 plus 9 new).

If `is_new` is always true, the `ON CONFLICT` target does not match the unique index — it must be `(watch_id, platform, external_id)`, not the primary key.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/server/watch/store.ts src/server/watch/store.test.ts
git commit -m "record watch mentions and their daily sentiment rollup"
```

---

## Task 4: Sitewide scout queries

The riskiest change in the plan: `githubScout` and `redditScout` are shared with `gtm.scout-threads`. The regression assertion is the point of this task.

**Files:**

- Modify: `src/server/outreach/types.ts` (`ScoutQuery`)
- Modify: `src/server/outreach/scouts/github.ts`
- Modify: `src/server/outreach/scouts/reddit.ts`
- Test: `src/server/outreach/scouts/scouts.test.ts` (append)

**Interfaces:**

- Consumes: nothing new.
- Produces: `ScoutQuery.communities?: readonly string[]` — absent keeps each scout's configured default; `[]` means search sitewide.

- [ ] **Step 1: Write the failing test**

Append to `src/server/outreach/scouts/scouts.test.ts` (add `import { githubScout } from './github.js';` to the existing imports):

```ts
describe('scout community scoping', () => {
  const issues = { items: [] };

  it('keeps the configured repo filter when communities is absent', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['agent cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain('repo:');
  });

  it('drops the repo filter when communities is an empty array', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['trevra'], limit: 10, communities: [] },
      { credentials: noCredentials, fetchImpl }
    );
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).not.toContain('repo:');
    expect(decodeURIComponent(calls[0])).toContain('trevra');
    expect(decodeURIComponent(calls[0])).toContain('is:issue');
  });

  it('scopes to the supplied repos when communities is non-empty', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['trevra'], limit: 10, communities: ['acme/widgets'] },
      { credentials: noCredentials, fetchImpl }
    );
    expect(decodeURIComponent(calls[0])).toContain('repo:acme/widgets');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/server/outreach/scouts/scouts.test.ts`
Expected: FAIL — TypeScript rejects `communities` as an unknown property of `ScoutQuery`, or the empty-array case still contains `repo:`.

- [ ] **Step 3: Add the field**

In `src/server/outreach/types.ts`, inside `interface ScoutQuery`, after `limit`:

```ts
  /**
   * Communities (subreddits, repos) to scope the search to.
   *
   * ABSENT means each scout keeps its own configured target list -- that is
   * what `gtm.scout-threads` relies on and what its tests assert byte-for-byte.
   * An EMPTY ARRAY means search sitewide, which is what a brand watch needs: a
   * watch scoped to five hardcoded repos would report "nobody mentions you"
   * while never having looked anywhere a mention would be.
   */
  communities?: readonly string[];
```

- [ ] **Step 4: Honour it in the GitHub scout**

In `src/server/outreach/scouts/github.ts`, replace the `repoFilter` line:

```ts
const repos = query.communities ?? GITHUB_TARGET_REPOS;
const repoFilter = repos.map((repo) => `repo:${repo}`).join(' ');
```

and replace the `q` assignment so an empty filter leaves no double space:

```ts
url.searchParams.set('q', [term, repoFilter, 'is:issue'].filter(Boolean).join(' '));
```

and update the evidence detail to report the real count:

```ts
          detail: `Searched ${repos.length === 0 ? 'all of GitHub' : `${repos.length} target repo(s)`} for ${query.queries.length} term(s); ${threads.length} distinct issue(s).`,
```

- [ ] **Step 5: Honour it in the Reddit scout**

Open `src/server/outreach/scouts/reddit.ts` and find where `REDDIT_TARGET_SUBREDDITS` is sliced into the request. Replace that expression with:

```ts
const subreddits = query.communities ?? REDDIT_TARGET_SUBREDDITS.slice(0, 5);
```

Then use `subreddits` wherever the sliced list was used. When `subreddits.length === 0`, issue the search against `https://oauth.reddit.com/search` (sitewide) instead of the per-subreddit path, keeping every other parameter identical.

- [ ] **Step 6: Run the whole outreach suite**

Run: `npm test -- src/server/outreach`
Expected: PASS. Every pre-existing scout and scout-threads test must still pass unchanged — that is the no-regression gate. If any existing assertion changed, the default is wrong: it must be `?? GITHUB_TARGET_REPOS`, never `?? []`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/server/outreach/types.ts src/server/outreach/scouts/github.ts src/server/outreach/scouts/reddit.ts src/server/outreach/scouts/scouts.test.ts
git commit -m "let a scout search sitewide without changing its defaults"
```

---

## Task 5: The `gtm.watch-mentions` skill

**Files:**

- Create: `src/server/watch/skill.ts`
- Modify: `src/server/skills/registry.ts`
- Test: `src/server/watch/skill.test.ts`

**Interfaces:**

- Consumes: `getWatch`, `recordWatchMentions` (Tasks 2–3); `scoreSentiment` (Task 1); `ScoutQuery.communities` (Task 4); `getScout`, `listScouts` from `../outreach/registry.js`; `envCredentials` from `../research/types.js`; `SkillContext` from `../skills/types.js`.
- Produces:

```ts
export interface WatchMentionsRequest {
  watchId?: string;
  keywords?: string[];
  platforms?: string[];
  limitPerPlatform?: number;
}
export interface WatchMentionsOptions {
  credentials?: CredentialAccessor;
  fetchImpl?: FetchLike;
}
export function watchMentions(
  request: WatchMentionsRequest,
  ctx: SkillContext,
  options?: WatchMentionsOptions
): Promise<WatchMentionsResult>;
export const watchMentionsSkill: Skill<WatchMentionsInput, WatchMentionsResult>;
```

`WatchMentionsResult` matches the spec's `outputSchema`: `{ watchId, reports[], mentions[], summary, warnings, watchedAt, evidence }`.

- [ ] **Step 1: Write the failing test**

Create `src/server/watch/skill.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import type { SkillContext } from '../skills/types.js';
import { createWatch, listWatchMentions } from './store.js';
import { watchMentions, watchMentionsSkill } from './skill.js';

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

function ctx(): SkillContext {
  return { db, workspaceId: DEMO_WORKSPACE_ID, now: () => NOW };
}

const HN_HIT = {
  hits: [
    {
      objectID: '1',
      title: 'Trevra review',
      story_text: 'Trevra is excellent and saved us hours.',
      author: 'dev',
      points: 20,
      num_comments: 4,
      created_at_i: 1_756_713_600
    }
  ]
};

function jsonFetch(routes: Record<string, unknown>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input) => {
      calls.push(input);
      const match = Object.keys(routes).find((key) => input.includes(key));
      if (!match) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[match]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

describe('gtm.watch-mentions', () => {
  it('is registered under its manifest id', async () => {
    const { getSkill } = await import('../skills/registry.js');
    expect(getSkill('gtm.watch-mentions')).toBeDefined();
    expect(watchMentionsSkill.manifest.sideEffect).toBe('network-read');
    expect(watchMentionsSkill.manifest.requiresApproval).toBe(false);
  });

  it('records a scored mention against the named watch', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });

    expect(result.watchId).toBe(watch.id);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].sentiment.label).toBe('positive');
    expect(result.mentions[0].matchedKeywords).toEqual(['trevra']);
    expect(result.summary.positive).toBe(1);

    const stored = await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].sentimentSpan).not.toBe('');
  });

  it('searches sitewide rather than the scout’s default communities', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['github'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com': { items: [] } });
    await watchMentions({ watchId: watch.id }, ctx(), { credentials: noCredentials, fetchImpl });
    expect(decodeURIComponent(calls[0])).not.toContain('repo:');
  });

  it('reports a credential-gated platform instead of returning silently empty', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['reddit'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl } = jsonFetch({});
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.reports[0].availability.mode).toBe('needs-credential');
    expect(result.warnings.join(' ')).toContain('needs-credential');
  });

  it('keeps one platform’s failure from discarding another’s results', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'Trevra',
        keywords: ['trevra'],
        platforms: ['github', 'hackernews'],
        cadence: 'daily'
      },
      NOW
    );
    const fetchImpl: FetchLike = async (input) => {
      if (input.includes('api.github.com')) throw new Error('rate limited');
      return new Response(JSON.stringify(HN_HIT), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.mentions).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('rate limited');
  });

  it('rejects an unknown watch id', async () => {
    await expect(watchMentions({ watchId: 'bw_missing' }, ctx())).rejects.toThrow(/watch/i);
  });

  it('runs ad hoc from keywords with no watch row', async () => {
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions({ keywords: ['trevra'], platforms: ['hackernews'] }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.watchId).toBeNull();
    expect(result.mentions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/watch/skill.test.ts`
Expected: FAIL — cannot resolve `./skill.js`.

- [ ] **Step 3: Write the skill**

Create `src/server/watch/skill.ts`:

```ts
import { z } from 'zod';
import type { FetchLike } from '../skills/guard.js';
import {
  envCredentials,
  type CredentialAccessor,
  type ProviderAvailability
} from '../research/types.js';
import type { Skill, SkillContext, SkillEvidence } from '../skills/types.js';
import { getScout } from '../outreach/registry.js';
import type { OutreachThread } from '../outreach/types.js';
import { getWatch, recordWatchMentions, type WatchMentionInput } from './store.js';
import { scoreSentiment, type Sentiment } from './sentiment.js';

/**
 * gtm.watch-mentions -- search the community platforms for a watch's keywords.
 *
 * Structurally the same loop as `gtm.scout-threads`, and for the same three
 * reasons: availability is reported per platform, one platform's failure is a
 * warning rather than a dead run, and persistence happens once in `store.ts`.
 * It differs in exactly one way -- it passes `communities: []`, so a scout that
 * normally watches five configured repos or subreddits searches sitewide. A
 * brand watch scoped to somebody else's target list would answer "nobody
 * mentions you" without ever having looked.
 */

export interface ScoredMention {
  platform: string;
  externalId: string;
  url: string;
  title: string;
  excerpt: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  createdAt: string | null;
  matchedKeywords: string[];
  sentiment: Sentiment;
}

export interface WatchPlatformReport {
  platform: string;
  availability: ProviderAvailability;
  fresh: ScoredMention[];
  knownCount: number;
  warnings: string[];
}

export interface WatchMentionsResult {
  watchId: string | null;
  reports: WatchPlatformReport[];
  mentions: ScoredMention[];
  summary: { positive: number; neutral: number; negative: number; averageScore: number };
  warnings: string[];
  watchedAt: string;
  evidence: SkillEvidence[];
}

export interface WatchMentionsRequest {
  watchId?: string;
  keywords?: string[];
  platforms?: string[];
  limitPerPlatform?: number;
}

export interface WatchMentionsOptions {
  credentials?: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

const EXCERPT_MAX = 400;

function matchedKeywords(thread: OutreachThread, keywords: readonly string[]): string[] {
  const haystack = `${thread.title}\n${thread.content}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function toMention(
  thread: OutreachThread,
  keywords: string[],
  sentiment: Sentiment
): ScoredMention {
  return {
    platform: thread.platform,
    externalId: thread.externalId,
    url: thread.url,
    title: thread.title,
    excerpt: thread.content.slice(0, EXCERPT_MAX),
    author: thread.author,
    community: thread.community,
    score: thread.score,
    numComments: thread.numComments,
    createdAt: thread.createdAt,
    matchedKeywords: keywords,
    sentiment
  };
}

export async function watchMentions(
  request: WatchMentionsRequest,
  ctx: SkillContext,
  options: WatchMentionsOptions = {}
): Promise<WatchMentionsResult> {
  const credentials = options.credentials ?? envCredentials;
  const now = ctx.now();

  const watch = request.watchId ? await getWatch(ctx.db, ctx.workspaceId, request.watchId) : null;
  if (request.watchId && !watch) throw new Error(`Unknown watch: ${request.watchId}.`);

  const keywords = watch?.keywords ?? request.keywords ?? [];
  if (keywords.length === 0) throw new Error('A watch run needs at least one keyword.');

  const platforms = watch?.platforms ?? request.platforms ?? [];
  if (platforms.length === 0) throw new Error('A watch run needs at least one platform.');

  const limit = Math.min(
    Math.max(watch?.limitPerPlatform ?? request.limitPerPlatform ?? 25, 1),
    100
  );

  const reports: WatchPlatformReport[] = [];
  const warnings: string[] = [];
  const evidence: SkillEvidence[] = [];
  const collected: WatchMentionInput[] = [];

  for (const platform of platforms) {
    const scout = getScout(platform);
    if (!scout) {
      const message = `Unknown platform: ${platform}.`;
      warnings.push(message);
      reports.push({
        platform,
        availability: { mode: 'disabled', reason: message },
        fresh: [],
        knownCount: 0,
        warnings: [message]
      });
      continue;
    }

    const availability = scout.availability(credentials);
    if (availability.mode !== 'ready') {
      const message = `${scout.name} is ${availability.mode}: ${availability.reason}`;
      warnings.push(message);
      reports.push({ platform, availability, fresh: [], knownCount: 0, warnings: [message] });
      continue;
    }

    let result;
    try {
      result = await scout.search(
        // Sitewide: see the module comment.
        { queries: [...keywords], limit, communities: [] },
        { credentials, fetchImpl: options.fetchImpl }
      );
    } catch (cause) {
      const message = `${scout.name} watch search failed: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      warnings.push(message);
      reports.push({ platform, availability, fresh: [], knownCount: 0, warnings: [message] });
      continue;
    }

    const scored: ScoredMention[] = [];
    for (const thread of result.threads) {
      const hits = matchedKeywords(thread, keywords);
      // A platform without server-side search returns its whole window; a
      // thread that does not actually contain a keyword is not a mention.
      if (hits.length === 0) continue;
      const sentiment = scoreSentiment(`${thread.title}. ${thread.content}`);
      scored.push(toMention(thread, hits, sentiment));
      collected.push({ thread, matchedKeywords: hits, sentiment });
    }

    warnings.push(...result.warnings);
    evidence.push(...result.evidence);
    reports.push({
      platform,
      availability,
      fresh: scored,
      knownCount: result.threads.length,
      warnings: [...result.warnings]
    });
  }

  if (watch && collected.length > 0) {
    try {
      await recordWatchMentions(ctx.db, ctx.workspaceId, watch.id, collected, now);
    } catch (cause) {
      // Same boundary as scout-threads: a write failure must not discard the
      // reads every platform already completed.
      const message = `Watch mentions could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      warnings.push(message);
    }
  }

  const mentions = reports.flatMap((report) => report.fresh);
  const positive = mentions.filter((m) => m.sentiment.label === 'positive').length;
  const negative = mentions.filter((m) => m.sentiment.label === 'negative').length;
  const neutral = mentions.length - positive - negative;
  const averageScore =
    mentions.length === 0
      ? 0
      : Number(
          (mentions.reduce((sum, m) => sum + m.sentiment.score, 0) / mentions.length).toFixed(3)
        );

  return {
    watchId: watch?.id ?? null,
    reports,
    mentions,
    summary: { positive, neutral, negative, averageScore },
    warnings,
    watchedAt: now.toISOString(),
    evidence
  };
}

const inputSchema = z
  .object({
    watchId: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1).max(120)).max(20).optional(),
    platforms: z.array(z.string().min(1)).max(20).optional(),
    limitPerPlatform: z.number().int().positive().max(100).optional()
  })
  .refine((value) => Boolean(value.watchId) || (value.keywords?.length ?? 0) > 0, {
    message: 'Supply watchId or keywords.'
  });

const sentimentSchema = z.object({
  label: z.enum(['positive', 'neutral', 'negative']),
  score: z.number().min(-1).max(1),
  span: z.string(),
  matches: z.array(z.object({ term: z.string(), weight: z.number(), negated: z.boolean() }))
});

const mentionSchema = z.object({
  platform: z.string(),
  externalId: z.string(),
  url: z.string(),
  title: z.string(),
  excerpt: z.string(),
  author: z.string().nullable(),
  community: z.string().nullable(),
  score: z.number(),
  numComments: z.number(),
  createdAt: z.string().nullable(),
  matchedKeywords: z.array(z.string()),
  sentiment: sentimentSchema
});

const outputSchema = z.object({
  watchId: z.string().nullable(),
  reports: z.array(
    z.object({
      platform: z.string(),
      availability: z.object({
        mode: z.enum(['ready', 'needs-credential', 'disabled']),
        reason: z.string(),
        docsUrl: z.string().optional()
      }),
      fresh: z.array(mentionSchema),
      knownCount: z.number(),
      warnings: z.array(z.string())
    })
  ),
  mentions: z.array(mentionSchema),
  summary: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
    averageScore: z.number()
  }),
  warnings: z.array(z.string()),
  watchedAt: z.string(),
  evidence: z.array(
    z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() })
  )
});

type WatchMentionsInput = z.infer<typeof inputSchema>;

export const watchMentionsSkill: Skill<WatchMentionsInput, WatchMentionsResult> = {
  manifest: {
    id: 'gtm.watch-mentions',
    name: 'Watch brand and keyword mentions',
    version: '1.0.0',
    description:
      "Search the configured community platforms for a named watch's keywords, score each mention's sentiment with the in-repo lexicon, and record new mentions against that watch.",
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    return watchMentions(input, ctx);
  }
};
```

- [ ] **Step 4: Register the skill**

In `src/server/skills/registry.ts`, add the import beside the other outreach imports:

```ts
import { watchMentionsSkill } from '../watch/skill.js';
```

and add `watchMentionsSkill,` to the array in the `for (const skill of [...])` loop, immediately after `scoutThreadsSkill,`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/server/watch/skill.test.ts`
Expected: PASS, 7 tests.

If the registry test fails on a duplicate id, `registerSkill` already holds one — check for a stray second import.

- [ ] **Step 6: Confirm no other skill test regressed**

Run: `npm test -- src/server/skills`
Expected: PASS. A skills-catalog snapshot may need the new id added; update it, do not delete the assertion.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/server/watch/skill.ts src/server/watch/skill.test.ts src/server/skills/registry.ts
git commit -m "add the watch-mentions skill"
```

---

## Task 6: Cadence, leasing, and the worker entry

**Files:**

- Create: `src/server/watch/service.ts`
- Modify: `src/worker/index.ts`
- Test: `src/server/watch/service.test.ts`

**Interfaces:**

- Consumes: `watchMentions` (Task 5), `getWatch` (Task 2).
- Produces:

```ts
export interface BrandWatchRunResult {
  watchId: string;
  ran: boolean; // false when another worker holds the lease
  inserted: number;
  updated: number;
  reports: WatchPlatformReport[];
  warnings: string[];
}
export function runBrandWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  options?: { now?: Date; force?: boolean; fetchImpl?: FetchLike; credentials?: CredentialAccessor }
): Promise<BrandWatchRunResult>;
export function runDueBrandWatches(db: Db): Promise<number>;
```

`force: true` is what `POST /api/watches/:id/run` passes: it ignores `next_run_at` but still takes the lease.

- [ ] **Step 1: Write the failing test**

Create `src/server/watch/service.test.ts`:

```ts
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
    const due = await watchFor('daily');
    const off = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'disabled',
        keywords: ['trevra'],
        platforms: ['hackernews'],
        cadence: 'daily',
        enabled: false
      },
      NOW
    );
    await db
      .prepare("UPDATE brand_watches SET next_run_at = now() + INTERVAL '1 day' WHERE id=?")
      .run(off.id);

    const count = await runDueBrandWatches(db);
    expect(count).toBe(1);
    expect((await getWatch(db, DEMO_WORKSPACE_ID, due.id))?.lastRunAt).not.toBeNull();
  });
});
```

`runDueBrandWatches` hits the real network in that last test unless the platform list is one the stub covers. Keep `platforms: ['hackernews']` and accept that the sweep may record zero mentions — the assertion is on `lastRunAt`, not on results.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/watch/service.test.ts`
Expected: FAIL — cannot resolve `./service.js`.

- [ ] **Step 3: Write the service**

Create `src/server/watch/service.ts`:

```ts
import type { Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { recordWatchMentions, type WatchMentionInput } from './store.js';
import { watchMentions, type WatchPlatformReport } from './skill.js';

/**
 * Cadence and leasing for brand watches.
 *
 * Copies `runDueResearchSources`: a LIMIT-3 sweep, a lease claimed by UPDATE
 * ... RETURNING so a second worker on the same row simply gets nothing, and a
 * cadence that advances on failure as well as success. That last part is
 * deliberate -- a permanently broken watch that kept its due time would be
 * re-picked on every tick and starve the other two slots.
 */

const LEASE = "INTERVAL '10 minutes'";

export interface BrandWatchRunResult {
  watchId: string;
  /** False when another worker holds the lease. */
  ran: boolean;
  inserted: number;
  updated: number;
  reports: WatchPlatformReport[];
  warnings: string[];
}

export interface RunBrandWatchOptions {
  now?: Date;
  /** Ignore next_run_at. Still takes the lease. */
  force?: boolean;
  fetchImpl?: FetchLike;
  credentials?: CredentialAccessor;
}

export async function runBrandWatch(
  db: Db,
  workspaceId: string,
  watchId: string,
  options: RunBrandWatchOptions = {}
): Promise<BrandWatchRunResult> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();

  const claimed = await db
    .prepare(
      `UPDATE brand_watches
         SET lease_until = ?::timestamptz + ${LEASE}
       WHERE id=? AND workspace_id=? AND enabled
         AND (lease_until IS NULL OR lease_until <= ?::timestamptz)
         AND (${options.force ? 'TRUE' : 'next_run_at <= ?::timestamptz'})
       RETURNING id, cadence`
    )
    .get<{ id: string; cadence: string }>(
      ...(options.force
        ? [timestamp, watchId, workspaceId, timestamp]
        : [timestamp, watchId, workspaceId, timestamp, timestamp])
    );

  if (!claimed) {
    return { watchId, ran: false, inserted: 0, updated: 0, reports: [], warnings: [] };
  }

  const interval = claimed.cadence === 'weekly' ? "INTERVAL '7 days'" : "INTERVAL '1 day'";
  let inserted = 0;
  let updated = 0;
  let reports: WatchPlatformReport[] = [];
  let warnings: string[] = [];
  let failure: string | null = null;

  try {
    // The skill already records what it finds; this call re-records nothing.
    const result = await watchMentions(
      { watchId },
      { db, workspaceId, now: () => now },
      {
        credentials: options.credentials,
        fetchImpl: options.fetchImpl
      }
    );
    reports = result.reports;
    warnings = result.warnings;
    // recordWatchMentions is idempotent on (watch_id, platform, external_id),
    // so counting here would double-write. Derive the counts from the reports.
    inserted = result.mentions.length;
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
    warnings.push(failure);
  }

  await db
    .prepare(
      `UPDATE brand_watches SET
         lease_until = NULL,
         last_run_at = ?::timestamptz,
         last_error = ?,
         next_run_at = ?::timestamptz + ${interval},
         updated_at = ?::timestamptz
       WHERE id=? AND workspace_id=?`
    )
    .run(timestamp, failure, timestamp, timestamp, watchId, workspaceId);

  return { watchId, ran: true, inserted, updated, reports, warnings };
}

export async function runDueBrandWatches(db: Db): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT workspace_id, id FROM brand_watches
       WHERE enabled AND next_run_at <= now()
         AND (lease_until IS NULL OR lease_until <= now())
       ORDER BY next_run_at
       LIMIT 3`
    )
    .all<{ workspace_id: string; id: string }>();

  let done = 0;
  for (const row of rows) {
    try {
      await runBrandWatch(db, row.workspace_id, row.id);
      done += 1;
    } catch (error) {
      console.error('Brand watch run failed', row, error);
    }
  }
  return done;
}
```

Drop the unused `recordWatchMentions` / `WatchMentionInput` import if the typechecker flags it — the skill owns persistence.

- [ ] **Step 4: Wire the worker**

In `src/worker/index.ts`, add beside the `runDueResearchSources` import:

```ts
import { runDueBrandWatches } from '../server/watch/service.js';
```

and add it as a fifth entry in the `Promise.all` inside `cycle()`:

```ts
await Promise.all([
  runAllAutomationCycles(db),
  runReadyPlaybooks(db),
  runDueAgentSchedules(db),
  runDueResearchSources(db),
  runDueBrandWatches(db)
]);
```

Do not give it a separate `setInterval`. A watch pass is a handful of bounded HTTP GETs, the same class of work as `runDueResearchSources`; the LinkedIn loop is separate only because one batch runs for tens of minutes.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/server/watch/service.test.ts`
Expected: PASS, 7 tests.

If the timestamp assertions are off by the pg text format, check that `getWatch` selects through `TO_CHAR(... AT TIME ZONE 'UTC', ...)` as written in Task 2.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/server/watch/service.ts src/server/watch/service.test.ts src/worker/index.ts
git commit -m "sweep due brand watches from the worker cycle"
```

---

## Task 7: HTTP API and client wrappers

**Files:**

- Modify: `src/server/app.ts` (routes after the `/api/research/search` handler; schemas beside `outreachThreadFiltersSchema`)
- Modify: `src/client/api.ts` (after `getOutreachOfferDefaults`)
- Test: `src/server/app.test.ts` (new `describe('brand watches')`)

**Interfaces:**

- Consumes: everything from Tasks 2, 3, 6; `startPlaybookRun` (already imported in `app.ts`).
- Produces, in `src/client/api.ts`:

```ts
export interface BrandWatch { id: string; name: string; keywords: string[]; platforms: string[]; cadence: 'daily' | 'weekly'; enabled: boolean; limitPerPlatform: number; nextRunAt: string; lastRunAt: string | null; lastError: string | null; }
export interface BrandWatchMention { id: string; watchId: string; platform: string; externalId: string; url: string; title: string; content: string; author: string | null; community: string | null; score: number; numComments: number; matchedKeywords: string[]; sentimentLabel: 'positive' | 'neutral' | 'negative'; sentimentScore: number; sentimentSpan: string; metadata: Record<string, unknown>; mentionCreatedAt: string | null; firstSeenAt: string; promotedRunId: string | null; }
export interface WatchTrendPoint { day: string; positive: number; neutral: number; negative: number; average: number; }
export function getWatches(): Promise<BrandWatch[]>;
export function createWatch(input: {...}): Promise<BrandWatch>;
export function updateWatch(id: string, patch: {...}): Promise<BrandWatch>;
export function deleteWatch(id: string): Promise<void>;
export function runWatch(id: string): Promise<{ inserted: number; warnings: string[] }>;
export function getWatchMentions(id: string, filters?: { sentiment?: string; platform?: string; limit?: number }): Promise<BrandWatchMention[]>;
export function getWatchTrend(id: string, days?: number): Promise<WatchTrendPoint[]>;
export function draftMentionReply(watchId: string, mentionId: string, product: OutreachOffer): Promise<PlaybookRun>;
```

- [ ] **Step 1: Write the failing test**

Append to `src/server/app.test.ts`:

```ts
describe('brand watches', () => {
  const BODY = {
    name: 'Trevra',
    keywords: ['trevra'],
    platforms: ['hackernews'],
    cadence: 'daily'
  };

  it('round-trips create, list, patch and delete', async () => {
    const agent = await agentWithSession();
    const created = await agent.post('/api/watches').send(BODY).expect(201);
    const watchId = created.body.watch.id;
    expect(created.body.watch.limitPerPlatform).toBe(25);

    const listed = await agent.get('/api/watches').expect(200);
    expect(listed.body.watches).toHaveLength(1);

    const patched = await agent
      .patch(`/api/watches/${watchId}`)
      .send({ cadence: 'weekly' })
      .expect(200);
    expect(patched.body.watch.cadence).toBe('weekly');
    expect(patched.body.watch.keywords).toEqual(['trevra']);

    await agent.delete(`/api/watches/${watchId}`).expect(204);
    await agent.get(`/api/watches/${watchId}/mentions`).expect(404);
  });

  it('rejects an invalid cadence and an oversized keyword list', async () => {
    const agent = await agentWithSession();
    await agent
      .post('/api/watches')
      .send({ ...BODY, cadence: 'hourly' })
      .expect(400);
    await agent
      .post('/api/watches')
      .send({ ...BODY, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) })
      .expect(400);
  });

  it('404s an unknown watch id', async () => {
    const agent = await agentWithSession();
    await agent.get('/api/watches/bw_missing/mentions').expect(404);
    await agent.get('/api/watches/bw_missing/trend').expect(404);
    await agent.patch('/api/watches/bw_missing').send({ cadence: 'weekly' }).expect(404);
  });

  it('returns a zero-filled 30-day trend', async () => {
    const agent = await agentWithSession();
    const created = await agent.post('/api/watches').send(BODY).expect(201);
    const trend = await agent
      .get(`/api/watches/${created.body.watch.id}/trend?days=30`)
      .expect(200);
    expect(trend.body.points).toHaveLength(30);
    expect(trend.body.points.every((point: { average: number }) => point.average === 0)).toBe(true);
  });

  it('caps the mention limit rather than trusting the query string', async () => {
    const agent = await agentWithSession();
    const created = await agent.post('/api/watches').send(BODY).expect(201);
    await agent.get(`/api/watches/${created.body.watch.id}/mentions?limit=5000`).expect(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/app.test.ts -t "brand watches"`
Expected: FAIL — 404 on `POST /api/watches`.

- [ ] **Step 3: Add the request schemas**

In `src/server/app.ts`, beside `outreachThreadFiltersSchema`:

```ts
const brandWatchBodySchema = z.object({
  name: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(120)).min(1).max(20),
  // linkedin is absent on purpose: its scout is permanently disabled by policy,
  // so offering it would only ever produce a report saying so.
  platforms: z
    .array(
      z.enum(['hackernews', 'stackoverflow', 'lobsters', 'github', 'reddit', 'mastodon', 'devto'])
    )
    .min(1),
  cadence: z.enum(['daily', 'weekly']),
  limitPerPlatform: z.number().int().min(1).max(100).optional(),
  enabled: z.boolean().optional()
});

const brandWatchPatchSchema = brandWatchBodySchema.partial();

const brandWatchMentionFiltersSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  platform: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const brandWatchTrendSchema = z.object({
  days: z.coerce.number().int().min(1).max(180).optional()
});
```

- [ ] **Step 4: Add the routes**

In `src/server/app.ts`, immediately after the `app.post('/api/research/search', ...)` handler closes and before the `Custom record ingestion` comment block, add the imports at the top of the file:

```ts
import {
  createWatch,
  deleteWatch,
  getWatch,
  getWatchMention,
  listWatchMentions,
  listWatches,
  markMentionPromoted,
  sentimentTrend,
  updateWatch
} from './watch/store.js';
import { runBrandWatch } from './watch/service.js';
```

and the routes:

```ts
/**
 * Brand and keyword watches.
 *
 * Every :id route resolves the watch through getWatch FIRST, so another
 * workspace's id 404s instead of reaching a query that would have been
 * scoped anyway -- one refusal shape, and no route where a missing scope
 * would be a cross-tenant read.
 */
app.get('/api/watches', async (req: AuthedRequest, res, next) => {
  try {
    res.json({ watches: await listWatches(db, req.auth!.workspaceId) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/watches', async (req: AuthedRequest, res) => {
  try {
    const input = brandWatchBodySchema.parse(req.body ?? {});
    res
      .status(201)
      .json({ watch: await createWatch(db, req.auth!.workspaceId, input, new Date()) });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Could not create the watch' });
  }
});

app.patch('/api/watches/:id', async (req: AuthedRequest, res) => {
  try {
    const patch = brandWatchPatchSchema.parse(req.body ?? {});
    const watch = await updateWatch(
      db,
      req.auth!.workspaceId,
      String(req.params.id),
      patch,
      new Date()
    );
    if (!watch) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    res.json({ watch });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Could not update the watch' });
  }
});

app.delete('/api/watches/:id', async (req: AuthedRequest, res, next) => {
  try {
    const removed = await deleteWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/watches/:id/run', async (req: AuthedRequest, res) => {
  try {
    const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!watch) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    const result = await runBrandWatch(db, req.auth!.workspaceId, watch.id, { force: true });
    res.json({
      inserted: result.inserted,
      updated: result.updated,
      reports: result.reports,
      warnings: result.warnings
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'The watch run failed' });
  }
});

app.get('/api/watches/:id/mentions', async (req: AuthedRequest, res) => {
  try {
    const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!watch) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    const filters = brandWatchMentionFiltersSchema.parse(req.query);
    res.json({
      mentions: await listWatchMentions(db, req.auth!.workspaceId, watch.id, filters)
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Could not read mentions' });
  }
});

app.get('/api/watches/:id/trend', async (req: AuthedRequest, res) => {
  try {
    const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!watch) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    const { days } = brandWatchTrendSchema.parse(req.query);
    res.json({
      points: await sentimentTrend(db, req.auth!.workspaceId, watch.id, days ?? 30, new Date())
    });
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Could not read the trend' });
  }
});
```

Order matters: the `404` branch must run before the schema `parse`, or an unknown id with a bad query string reports 400 instead of 404. The mention-limit test asserts 400 for `limit=5000` on a watch that exists, so the parse still fires after the lookup.

- [ ] **Step 5: Add the client wrappers**

In `src/client/api.ts`, after `getOutreachOfferDefaults`, add the interfaces from this task's **Produces** block and:

```ts
export async function getWatches(): Promise<BrandWatch[]> {
  const result = await request<{ watches?: BrandWatch[] }>('/api/watches');
  return result.watches ?? [];
}

export async function createWatch(input: {
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
}): Promise<BrandWatch> {
  const result = await request<{ watch: BrandWatch }>('/api/watches', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.watch;
}

export async function updateWatch(
  id: string,
  patch: Partial<{
    name: string;
    keywords: string[];
    platforms: string[];
    cadence: 'daily' | 'weekly';
    enabled: boolean;
  }>
): Promise<BrandWatch> {
  const result = await request<{ watch: BrandWatch }>(`/api/watches/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return result.watch;
}

export async function deleteWatch(id: string): Promise<void> {
  await fetch(`/api/watches/${id}`, { method: 'DELETE', credentials: 'include' });
}

export async function runWatch(id: string): Promise<{ inserted: number; warnings: string[] }> {
  return request(`/api/watches/${id}/run`, { method: 'POST', body: '{}' });
}

export async function getWatchMentions(
  id: string,
  filters: { sentiment?: string; platform?: string; limit?: number } = {}
): Promise<BrandWatchMention[]> {
  const query = new URLSearchParams();
  if (filters.sentiment) query.set('sentiment', filters.sentiment);
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ mentions?: BrandWatchMention[] }>(
    `/api/watches/${id}/mentions${query.size ? `?${query}` : ''}`
  );
  return result.mentions ?? [];
}

export async function getWatchTrend(id: string, days = 30): Promise<WatchTrendPoint[]> {
  const result = await request<{ points?: WatchTrendPoint[] }>(
    `/api/watches/${id}/trend?days=${days}`
  );
  return result.points ?? [];
}
```

`draftMentionReply` is added in Task 8.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/server/app.test.ts -t "brand watches"`
Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/server/app.ts src/client/api.ts src/server/app.test.ts
git commit -m "expose brand watches over the api"
```

---

## Task 8: Promote a mention into the reply pipeline

**Files:**

- Modify: `src/server/app.ts` (one route)
- Modify: `src/client/api.ts` (`draftMentionReply`)
- Test: `src/server/app.test.ts` (append to `describe('brand watches')`)

**Interfaces:**

- Consumes: `getWatchMention`, `markMentionPromoted` (Task 3); `startPlaybookRun` (already in `app.ts`).
- Produces: `POST /api/watches/:id/mentions/:mentionId/reply` → `201 { run }`; `draftMentionReply(watchId, mentionId, product)` in the client.

- [ ] **Step 1: Write the failing test**

Append inside `describe('brand watches')` in `src/server/app.test.ts`:

```ts
const OFFER = {
  name: 'Trevra',
  url: 'https://trevra.com',
  summary: 'Runs go-to-market skills and records every attempt.',
  mechanism: 'Deterministic skills over a workspace ledger.',
  claims: [{ label: 'Ledger', value: 'Every run recorded' }]
};

it('promotes a mention into a thread-reply run and stamps it', async () => {
  const agent = await agentWithSession();
  const created = await agent.post('/api/watches').send(BODY).expect(201);
  const watchId = created.body.watch.id;

  await db
    .prepare(
      `INSERT INTO brand_watch_mentions (
           id, workspace_id, watch_id, platform, external_id, url, title, content,
           sentiment_label, sentiment_score, sentiment_version, content_hash,
           first_seen_at, last_seen_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,now(),now())`
    )
    .run(
      'bwm_test',
      DEMO_WORKSPACE_ID,
      watchId,
      'hackernews',
      'hn9',
      'https://news.ycombinator.com/item?id=hn9',
      'Trevra thread',
      'Trevra is excellent.',
      'positive',
      0.5,
      1,
      'hash'
    );

  const promoted = await agent
    .post(`/api/watches/${watchId}/mentions/bwm_test/reply`)
    .send({ product: OFFER })
    .expect(201);
  expect(promoted.body.run.id).toBeTruthy();

  const mentions = await agent.get(`/api/watches/${watchId}/mentions`).expect(200);
  expect(mentions.body.mentions[0].promotedRunId).toBe(promoted.body.run.id);
});

it('404s a mention that belongs to another watch', async () => {
  const agent = await agentWithSession();
  const created = await agent.post('/api/watches').send(BODY).expect(201);
  await agent
    .post(`/api/watches/${created.body.watch.id}/mentions/bwm_missing/reply`)
    .send({ product: OFFER })
    .expect(404);
});
```

The first test asserts a **201 regardless of the run's terminal status**: a blocked thread lands the run at `failed`, and the client renders that as "blocked" — the same branch `startDraft` already has. Do not assert `status === 'waiting_approval'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/app.test.ts -t "brand watches"`
Expected: FAIL — 404 on the reply route.

- [ ] **Step 3: Add the route**

In `src/server/app.ts`, after the `/api/watches/:id/trend` handler:

```ts
/**
 * Promote a mention into gtm.thread-reply.
 *
 * Server-side rather than "client starts the playbook, then PATCHes the
 * mention": two round trips leave a window where a run exists that no mention
 * points at, and nothing would ever reconcile it.
 */
app.post('/api/watches/:id/mentions/:mentionId/reply', async (req: AuthedRequest, res, next) => {
  try {
    const watch = await getWatch(db, req.auth!.workspaceId, String(req.params.id));
    if (!watch) {
      res.status(404).json({ error: 'Watch not found' });
      return;
    }
    const mention = await getWatchMention(db, req.auth!.workspaceId, String(req.params.mentionId));
    if (!mention || mention.watchId !== watch.id) {
      res.status(404).json({ error: 'Mention not found' });
      return;
    }

    const input = z
      .object({
        product: z.record(z.unknown()),
        angle: z.string().min(1).max(60).optional()
      })
      .parse(req.body ?? {});

    const run = await startPlaybookRun(db, {
      workspaceId: req.auth!.workspaceId,
      playbookId: 'gtm.thread-reply',
      payload: {
        thread: {
          platform: mention.platform,
          externalId: mention.externalId,
          url: mention.url,
          title: mention.title,
          content: mention.content,
          author: mention.author,
          community: mention.community,
          score: mention.score,
          numComments: mention.numComments,
          createdAt: mention.mentionCreatedAt,
          metadata: mention.metadata
        },
        // A watch does not score reply-worthiness; the playbook's own guard
        // and scorer still run. Supplying a fake relevance score here would
        // be the one number in the chain nobody computed.
        angle: input.angle ?? 'minimal_mention',
        product: input.product
      },
      actorType: 'user',
      actorId: req.auth!.userId
    });

    await markMentionPromoted(db, req.auth!.workspaceId, mention.id, run.id, new Date());
    res.status(201).json({ run });
  } catch (error) {
    next(error);
  }
});
```

If `gtm.thread-reply`'s input schema requires `relevanceScore`, pass `relevanceScore: 0` and leave the comment explaining why it is not invented.

- [ ] **Step 4: Add the client wrapper**

In `src/client/api.ts`, after `getWatchTrend`:

```ts
export async function draftMentionReply(
  watchId: string,
  mentionId: string,
  product: OutreachOffer
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/watches/${watchId}/mentions/${mentionId}/reply`,
    { method: 'POST', body: JSON.stringify({ product }) }
  );
  return result.run;
}
```

Use whatever the file already names the playbook-run type (the same one `startPlaybook` returns); do not declare a second one.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/server/app.test.ts -t "brand watches"`
Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/server/app.ts src/client/api.ts src/server/app.test.ts
git commit -m "promote a watch mention into the reply approval queue"
```

---

## Task 9: Research tab UI

**Files:**

- Modify: `src/client/views/ResearchView.tsx`
- Modify: `src/client/views/researchFormat.ts`
- Create: `src/client/views/researchFormat.test.ts` if absent, otherwise modify
- Modify: `src/client/styles.css`

**Interfaces:**

- Consumes: every client wrapper from Tasks 7–8.
- Produces: `sentimentChip(mention: { sentimentLabel: string; sentimentSpan: string }): { tone: string; text: string }` in `researchFormat.ts`.

- [ ] **Step 1: Write the failing formatter test**

In `src/client/views/researchFormat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sentimentChip } from './researchFormat';

describe('sentimentChip', () => {
  it('maps each label to its tone class', () => {
    expect(sentimentChip({ sentimentLabel: 'positive', sentimentSpan: 'It is great.' }).tone).toBe(
      'is-positive'
    );
    expect(sentimentChip({ sentimentLabel: 'negative', sentimentSpan: 'It is bad.' }).tone).toBe(
      'is-negative'
    );
    expect(sentimentChip({ sentimentLabel: 'neutral', sentimentSpan: '' }).tone).toBe('is-neutral');
  });

  it('quotes the deciding span', () => {
    expect(sentimentChip({ sentimentLabel: 'negative', sentimentSpan: 'It is bad.' }).text).toBe(
      '“It is bad.”'
    );
  });

  it('truncates a long span at the display cap', () => {
    const chip = sentimentChip({ sentimentLabel: 'positive', sentimentSpan: 'x'.repeat(200) });
    expect(chip.text.length).toBeLessThanOrEqual(122);
    expect(chip.text).toContain('…');
  });

  it('falls back to the label when there is no span', () => {
    expect(sentimentChip({ sentimentLabel: 'neutral', sentimentSpan: '' }).text).toBe('Neutral');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/client/views/researchFormat.test.ts`
Expected: FAIL — `sentimentChip` is not exported.

- [ ] **Step 3: Add the formatter**

Append to `src/client/views/researchFormat.ts`:

```ts
const SPAN_MAX = 120;

/** The sentiment chip: the deciding sentence, quoted, or the bare label when there is none. */
export function sentimentChip(mention: { sentimentLabel: string; sentimentSpan: string }): {
  tone: string;
  text: string;
} {
  const tone =
    mention.sentimentLabel === 'positive'
      ? 'is-positive'
      : mention.sentimentLabel === 'negative'
        ? 'is-negative'
        : 'is-neutral';
  const span = mention.sentimentSpan.trim();
  if (span === '') {
    return {
      tone,
      text: mention.sentimentLabel.charAt(0).toUpperCase() + mention.sentimentLabel.slice(1)
    };
  }
  const clipped = span.length > SPAN_MAX ? `${span.slice(0, SPAN_MAX)}…` : span;
  return { tone, text: `“${clipped}”` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/client/views/researchFormat.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the watch bar and dialog to `ResearchView.tsx`**

Extend the imports from `../api` with `createWatch`, `deleteWatch`, `draftMentionReply`, `getWatchMentions`, `getWatchTrend`, `getWatches`, `runWatch`, `type BrandWatch`, `type BrandWatchMention`, `type WatchTrendPoint`. Add `sentimentChip` to the `./researchFormat` import.

Add this constant beside `PLATFORM_FILTERS`:

```tsx
// linkedin is absent on purpose: its scout is permanently disabled by policy,
// so a watch on it could only ever report that.
const WATCH_PLATFORMS = [
  'hackernews',
  'stackoverflow',
  'lobsters',
  'github',
  'reddit',
  'mastodon',
  'devto'
];
const WATCH_DEFAULT_PLATFORMS = ['hackernews', 'stackoverflow', 'lobsters', 'github'];
```

Add state inside `ResearchView`, beside the existing `drafting` state:

```tsx
const [watches, setWatches] = useState<BrandWatch[]>([]);
const [watchesLoaded, setWatchesLoaded] = useState(false);
const [selectedWatch, setSelectedWatch] = useState<string | null>(null);
const [mentions, setMentions] = useState<BrandWatchMention[]>([]);
const [mentionsLoaded, setMentionsLoaded] = useState(false);
const [mentionsError, setMentionsError] = useState(false);
const [trend, setTrend] = useState<WatchTrendPoint[]>([]);
const [watchDialogOpen, setWatchDialogOpen] = useState(false);
const [runningWatch, setRunningWatch] = useState(false);
const [draftingMention, setDraftingMention] = useState<BrandWatchMention | null>(null);
```

Load watches once, and mentions plus trend whenever `selectedWatch` changes, following the existing `useEffect` cancellation idiom in this file (`let cancelled = false; ... return () => { cancelled = true; };`). Select the first watch automatically when the list loads and nothing is selected.

Render, between `.research-toolbar` and `.research-feed-grid`:

```tsx
{
  watchesLoaded && (
    <section className="research-watch-bar">
      <div className="li-filter-row" role="group" aria-label="Watch">
        <span className="li-filter-label">Watches</span>
        {watches.map((watch) => (
          <button
            key={watch.id}
            type="button"
            className={`li-range ${selectedWatch === watch.id ? 'is-active' : ''}`}
            aria-pressed={selectedWatch === watch.id}
            onClick={() => setSelectedWatch(watch.id)}
          >
            {watch.name}
          </button>
        ))}
        <button type="button" className="li-range" onClick={() => setWatchDialogOpen(true)}>
          New watch
        </button>
      </div>
      {selectedWatchRow && (
        <p className="research-watch-meta">
          Runs {selectedWatchRow.cadence}.{' '}
          {selectedWatchRow.lastRunAt
            ? `Last run ${new Date(selectedWatchRow.lastRunAt).toLocaleString()}.`
            : 'Not run yet.'}{' '}
          <button type="button" onClick={runSelectedWatch} disabled={runningWatch}>
            {runningWatch ? 'Running…' : 'Run now'}
          </button>
        </p>
      )}
      {watches.length === 0 && (
        <p className="research-watch-empty">
          Create a watch to start tracking mentions of your brand or a keyword.
        </p>
      )}
    </section>
  );
}
```

where `selectedWatchRow = watches.find((watch) => watch.id === selectedWatch) ?? null`, and `runSelectedWatch` calls `runWatch(selectedWatch)`, then re-fetches mentions and trend, and reports warnings through `setToast`.

Add a `WatchDialog` component in the same file, structured exactly like `DraftDialog` (`createPortal`, `.drawer-backdrop`, `.drawer`, `useDialog(dialog, close)`), with: a name text input, a comma-separated keywords input, a checkbox per `WATCH_PLATFORMS` defaulting to `WATCH_DEFAULT_PLATFORMS`, and a daily/weekly radio pair. Submit calls `createWatch`, appends the result to `watches`, selects it, and closes.

- [ ] **Step 6: Add the mention panel and trend strip**

Add as a third child of `.research-feed-grid`, before the briefs panel, rendered only when `selectedWatch !== null`:

```tsx
<section className="page-panel research-mention-panel">
  <div className="section-heading">
    <div>
      <h3 aria-level={2}>Mentions</h3>
      <p>Where this watch’s keywords came up, and how it was said.</p>
    </div>
    <div className="research-trend" aria-label="Sentiment over the last 30 days">
      {trend.map((point) => (
        <span
          key={point.day}
          className={`research-trend-bar ${
            point.average > 0.15
              ? 'is-positive'
              : point.average < -0.15
                ? 'is-negative'
                : 'is-neutral'
          }`}
          title={`${point.day}: +${point.positive} / ${point.neutral} / -${point.negative}`}
        />
      ))}
    </div>
  </div>
  <div className="client-table">
    {mentionsLoaded &&
      !mentionsError &&
      mentions.map((mention) => {
        const chip = sentimentChip(mention);
        return (
          <article className="client-card-large" key={mention.id}>
            <div className="client-avatar large">{platformLabel(mention.platform).slice(0, 2)}</div>
            <div>
              <h3>
                <a href={mention.url} target="_blank" rel="noreferrer">
                  {mention.title || mention.url}
                </a>
              </h3>
              <span className={`client-status research-sentiment ${chip.tone}`}>{chip.text}</span>
            </div>
            <button type="button" onClick={() => setDraftingMention(mention)}>
              Draft reply
            </button>
          </article>
        );
      })}
    {!mentionsLoaded && (
      <div className="empty-state">
        <LoaderCircle />
      </div>
    )}
    {mentionsLoaded && mentionsError && (
      <div className="empty-state">
        <CircleAlert /> Mentions could not be loaded.
      </div>
    )}
    {mentionsLoaded && !mentionsError && mentions.length === 0 && (
      <div className="empty-state">
        <MessageSquare />
        {selectedWatchRow?.lastRunAt
          ? 'Nothing found on the last run.'
          : `This watch runs ${selectedWatchRow?.cadence ?? 'daily'}; nothing found yet.`}
        {watchAvailabilityNote && <p>{watchAvailabilityNote}</p>}
      </div>
    )}
  </div>
</section>
```

`watchAvailabilityNote` is set from the `reports` returned by `runWatch`: join the `reason` of every report whose `availability.mode !== 'ready'`. **This is required, not decorative** — without it a founder whose only real mention source is Reddit reads a credential gap as "nobody is talking about us".

- [ ] **Step 7: Reuse the draft dialog for mentions**

Change `DraftDialog`'s prop `entry: FeedThread` to `title: string` and update its single use of `entry.row.title` to `title`. Pass `title={drafting.row.title}` at the existing call site.

Add a second render of `DraftDialog` driven by `draftingMention`, whose `onSubmit` calls:

```tsx
const run = await draftMentionReply(selectedWatch!, draftingMention.id, offer);
```

and then reuses the **existing** `waiting_approval` / blocked toast branch from `startDraft` verbatim. Extend the offer-prefill `useEffect` dependency array to `[drafting, draftingMention]` so a mention dialog prefills the same way a thread dialog does.

- [ ] **Step 8: Add the styles**

Append to `src/client/styles.css` after `.research-brief-panel .client-card-large`:

```css
.research-watch-bar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.research-watch-meta,
.research-watch-empty {
  margin: 0;
  font-size: 0.85rem;
  opacity: 0.75;
}
.research-mention-panel {
  min-width: 0;
}
.research-trend {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 24px;
}
.research-trend-bar {
  width: 4px;
  height: 100%;
  border-radius: 1px;
  background: var(--border);
}
.research-trend-bar.is-positive {
  background: var(--ok, #2e7d32);
}
.research-trend-bar.is-negative {
  background: var(--danger, #c62828);
}
.research-sentiment.is-positive {
  color: var(--ok, #2e7d32);
}
.research-sentiment.is-negative {
  color: var(--danger, #c62828);
}
.research-sentiment.is-neutral {
  opacity: 0.7;
}
```

Check the real variable names in `styles.css` before committing and use the ones this file already defines; the fallbacks above exist only so the panel is legible if a token is missing. Add `.research-mention-panel` to the existing responsive `@media` rule that already lists `.research-thread-panel`, so the grid collapses to one column on narrow screens.

- [ ] **Step 9: Verify in the running app**

Run: `npm run dev`

Then, in the browser: open `/research`, create a watch named `Trevra` with keyword `trevra` on Hacker News, click **Run now**, and confirm mentions render with a quoted sentiment span and a 30-bar trend strip. Click **Draft reply** on one mention and confirm it lands in the approval queue.

Expected: no console errors; the empty state names the platform availability when a credential-gated platform is selected.

- [ ] **Step 10: Full check and commit**

```bash
npm run typecheck
npm test
git add src/client/views/ResearchView.tsx src/client/views/researchFormat.ts src/client/views/researchFormat.test.ts src/client/styles.css
git commit -m "show brand watch mentions and their sentiment trend"
```

---

## Task 10: Settle the default platform set

The spec's one open question. Do this last, with real data.

**Files:**

- Possibly modify: `src/client/views/ResearchView.tsx` (`WATCH_DEFAULT_PLATFORMS`)
- Possibly modify: `docs/superpowers/specs/2026-08-30-brand-keyword-watch-design.md`

- [ ] **Step 1: Run a real watch against each candidate**

With the app running, create one watch per platform in `WATCH_DEFAULT_PLATFORMS` using a genuinely-discussed term (not your own brand — use something with known traffic, e.g. `postgres`), click **Run now**, and record how many mentions each returns.

- [ ] **Step 2: Decide and record**

Lobsters has no server-side search: it filters the current `newest.json` window client-side, so a mention older than that page is invisible. If Lobsters or Stack Overflow returns zero on a high-traffic term, drop it from `WATCH_DEFAULT_PLATFORMS` (leave it selectable) and replace the spec's "Open question to settle during implementation" section with the measured result and the decision.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "settle the default watch platform set against real results"
```

---

## Self-Review

**Spec coverage.** Sources → Task 4 + Task 5. Data model → Task 2 + Task 3. Sentiment → Task 1. Skill → Task 5. Scheduling → Task 6. API → Task 7 + Task 8. UI → Task 9. Testing → the test step of every task. Risk 1 (silent scouting change) → Task 4 Step 6. Risk 2 (thin credential-free coverage) → Task 9 Step 6, `watchAvailabilityNote`. Risk 3 (lexicon mislabels) → Task 1's `span` and `SENTIMENT_VERSION`, surfaced in Task 9. Open question → Task 10. No spec section is unimplemented.

**Type consistency.** `Sentiment` (Task 1) is consumed unchanged by `WatchMentionInput` (Task 3) and `ScoredMention` (Task 5). `BrandWatch`/`BrandWatchInput` (Task 2) are used by Tasks 5, 6, 7. `WatchMention` (Task 3) is the server row; the client's `BrandWatchMention` (Task 7) is its JSON mirror with the same camelCase field names. `WatchPlatformReport` (Task 5) is re-exported through `BrandWatchRunResult` (Task 6) and reaches the client as `reports` on `POST /run` (Task 7).

**Known deviations from the spec, both deliberate.** The spec listed `src/server/watch/store.test.ts` and a separate `service.test.ts`; this plan adds `skill.test.ts` as a third file because the skill is a distinct unit. The spec named `mentions[].excerpt` in the skill output and `content` on the stored row; both exist — the excerpt is the truncated API projection, `content` is the full stored text.
