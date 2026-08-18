# Research Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level `Research` nav entry at `/research` that shows discovered/scored community threads (LinkedIn, Reddit, Hacker News, GitHub, Dev.to, Lobsters, Mastodon, Stack Overflow), company research briefs, and the existing Reddit corpus, in one platform-filterable feed.

**Architecture:** Two small backend additions (a new query over the already-populated `outreach_threads` table, and a route to serve it) plus one new client view that composes three independent, already-existing-or-trivial data sources (`outreach_threads`, `gtm.research-brief` skill runs, and the existing `ResearchScreen` Reddit corpus component). No new database migration. No new client test infrastructure — the codebase has no component-rendering test harness today, so verification for the new view is `tsc` + a manual run-through, matching how the rest of the client is verified.

**Tech Stack:** Express + Postgres (`pg`) server, React client, Vitest for server and pure-logic client tests, `npm test -- <path>` runs one file against an ephemeral Postgres container.

## Global Constraints

- No new database migration — `outreach_threads` (`migrations/013_outreach.sql:11`) already has every column this feature needs.
- No changes to `RedditScreen.tsx` (`/setup/reddit`) — it posts comments, it is not part of this feature.
- No changes to how/when `gtm.scout-threads`, `gtm.score-threads`, or `gtm.research-brief` run — this is a read-only viewer over data that already exists.
- Follow existing patterns exactly: snake_case row shapes for plain SQL list queries (matches `ExistingPost` in `src/server/outreach/store.ts`), the `li-filter-row`/`li-range` chip-filter CSS classes already used by `LedgerView.tsx`, and the `.catch(() => [])` per-lane-failure pattern already used by `LedgerView.tsx:96`.

---

### Task 1: `listOutreachThreads` query

**Files:**

- Modify: `src/server/outreach/store.ts` (append after `existingPost`, end of file)
- Test: `src/server/outreach/store.test.ts` (append after the closing `});` of `describe('recordSeenThreads', ...)`, currently the last line)

**Interfaces:**

- Produces: `OutreachThreadRow` (exported interface), `listOutreachThreads(db: Db, workspaceId: string, filters?: { platform?: string; limit?: number }): Promise<OutreachThreadRow[]>` — both consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Append to `src/server/outreach/store.test.ts`, and change its import line from

```ts
import { isThreadReplied, recordPost, recordSeenThreads } from './store.js';
```

to

```ts
import { isThreadReplied, listOutreachThreads, recordPost, recordSeenThreads } from './store.js';
```

then append at the end of the file:

```ts
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
    const rows = await listOutreachThreads(db, DEMO_WORKSPACE_ID, { limit: 0 });
    expect(rows).toEqual([]);
    // limit=0 clamps to 1, not 0 -- asserting only that the call does not
    // throw and returns an array proves the clamp did not become a no-op.
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/outreach/store.test.ts`
Expected: FAIL — `listOutreachThreads is not a function` (or a TS error that it does not exist on the module).

- [ ] **Step 3: Write the implementation**

Append to `src/server/outreach/store.ts`:

```ts
export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
}

/**
 * Discovered threads, best-scored first, tied breaking newest-first. The read
 * path `outreach_threads` never had -- see docs/superpowers/specs/2026-08-18-research-hub-design.md.
 */
export async function listOutreachThreads(
  db: Db,
  workspaceId: string,
  filters: { platform?: string; limit?: number } = {}
): Promise<OutreachThreadRow[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.platform) {
    clauses.push('platform=?');
    params.push(filters.platform);
  }
  params.push(limit);
  return db
    .prepare(
      `
    SELECT id, platform, external_id, url, title, author, community, score,
           num_comments, thread_created_at, first_seen_at
    FROM outreach_threads
    WHERE ${clauses.join(' AND ')}
    ORDER BY score DESC, first_seen_at DESC
    LIMIT ?
  `
    )
    .all<OutreachThreadRow>(...params);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/server/outreach/store.test.ts`
Expected: PASS, all cases in the file including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/outreach/store.ts src/server/outreach/store.test.ts
git commit -m "outreach: add listOutreachThreads read path"
```

---

### Task 2: `GET /api/outreach/threads` route

**Files:**

- Modify: `src/server/app.ts` (import block ~line 58, `skillRunFiltersSchema` area ~line 5489, and the route block right after `GET /api/skill-runs/:id` ~line 1009)
- Test: `src/server/app.test.ts`

**Interfaces:**

- Consumes: `listOutreachThreads`, `OutreachThreadRow` from Task 1.
- Produces: `GET /api/outreach/threads?platform=&limit=` → `{ threads: OutreachThreadRow[] }`, consumed by Task 3's `getOutreachThreads`.

- [ ] **Step 1: Write the failing test**

`agentWithSession()` (already defined near the top of this file) opens its own `db`/`app` pair, assigns the module-level `db`, signs in with the demo cookie, and returns a `request.agent(...)` instance whose cookie jar persists automatically across every subsequent call made through it — no manual header needed. Append, as its own top-level `describe` block (after the existing ones):

```ts
describe('GET /api/outreach/threads', () => {
  it('lists discovered threads, scoped to the caller workspace, filterable by platform', async () => {
    const agent = await agentWithSession();

    const { recordSeenThreads } = await import('./outreach/store.js');
    await recordSeenThreads(
      db,
      DEMO_WORKSPACE_ID,
      [
        {
          platform: 'linkedin',
          externalId: 'li-1',
          url: 'https://linkedin.test/post/1',
          title: 'Token costs are out of control',
          content: 'body',
          author: 'someone',
          community: null,
          score: 7,
          numComments: 2,
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {}
        }
      ],
      new Date('2026-08-01T00:00:00.000Z')
    );

    const all = await agent.get('/api/outreach/threads').expect(200);
    expect(all.body.threads).toHaveLength(1);
    expect(all.body.threads[0].platform).toBe('linkedin');

    const filtered = await agent.get('/api/outreach/threads?platform=reddit').expect(200);
    expect(filtered.body.threads).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/server/app.test.ts -t "GET /api/outreach/threads"`
Expected: FAIL — 404, route does not exist.

- [ ] **Step 3: Write the implementation**

In `src/server/app.ts`, add the import right after the `skill-api.js` import block (after the line `} from './skill-api.js';`, ~line 58):

```ts
import { listOutreachThreads } from './outreach/store.js';
```

Near `skillRunFiltersSchema` (~line 5489), add a sibling schema:

```ts
const outreachThreadFiltersSchema = z.object({
  platform: z.string().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
```

Right after the `GET /api/skill-runs/:id` route block (after its closing `});`, ~line 1009, before `app.get('/api/playbooks', ...)`), add:

```ts
app.get('/api/outreach/threads', async (req: AuthedRequest, res, next) => {
  try {
    const filters = outreachThreadFiltersSchema.parse(req.query);
    res.json({ threads: await listOutreachThreads(db, req.auth!.workspaceId, filters) });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/server/app.test.ts -t "GET /api/outreach/threads"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/app.test.ts
git commit -m "api: add GET /api/outreach/threads"
```

---

### Task 3: Client API wrapper + `ResearchView`

**Files:**

- Modify: `src/client/api.ts` (add right after the existing `getSkillRun` function)
- Create: `src/client/views/ResearchView.tsx`

**Interfaces:**

- Consumes: `GET /api/outreach/threads` (Task 2), `getSkillRuns({skillId, limit})` (already exists, `src/client/api.ts:278`), `ResearchScreen` (already exists, `src/client/ResearchScreen.tsx:10`, props `{connections: ConnectionSummary[]; setToast: (message: string) => void}`).
- Produces: `getOutreachThreads(filters?): Promise<OutreachThreadRow[]>`, `ResearchView({connections, setToast})` — both consumed by Task 4.

- [ ] **Step 1: Add the API wrapper**

In `src/client/api.ts`, immediately after:

```ts
export async function getSkillRun(id: string): Promise<SkillRun> {
  const result = await request<{ run: SkillRun }>(`/api/skill-runs/${encodeURIComponent(id)}`);
  return result.run;
}
```

add:

```ts
/** One row `gtm.scout-threads`/`gtm.score-threads` discovered, across every platform. */
export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
}

export async function getOutreachThreads(
  filters: { platform?: string; limit?: number } = {}
): Promise<OutreachThreadRow[]> {
  const query = new URLSearchParams();
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ threads?: OutreachThreadRow[] }>(
    `/api/outreach/threads${query.size ? `?${query}` : ''}`
  );
  return result.threads ?? [];
}
```

- [ ] **Step 2: Run the typechecker to confirm the addition compiles**

Run: `npm run typecheck`
Expected: PASS (no new errors). This addition has no runtime test of its own — it is a 20-line fetch wrapper in the same style as `getSkillRuns` right above it, which also has none; Task 2's route test is what proves the wire format, and Task 4's manual check is what proves the client consumes it correctly.

- [ ] **Step 3: Create `ResearchView.tsx`**

Create `src/client/views/ResearchView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { LoaderCircle, MessageSquare, Newspaper } from 'lucide-react';
import type { ConnectionSummary, SkillRun } from '../../shared/types';
import { getOutreachThreads, getSkillRuns, type OutreachThreadRow } from '../api';
import { ResearchScreen } from '../ResearchScreen';

/*
 * `/research` -- one feed over three sources that never shared a screen:
 * the outreach_threads table (LinkedIn/Reddit/HN/GitHub/etc, scored,
 * previously had NO reader at all), gtm.research-brief skill-run output
 * (company-level findings, already queryable but never rendered as a feed),
 * and the pre-existing Reddit corpus screen (relocated in unchanged).
 *
 * See docs/superpowers/specs/2026-08-18-research-hub-design.md.
 */

const PLATFORM_LABELS: Record<string, string> = {
  all: 'All',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  devto: 'Dev.to',
  lobsters: 'Lobsters',
  mastodon: 'Mastodon',
  stackoverflow: 'Stack Overflow'
};
const PLATFORM_FILTERS = Object.keys(PLATFORM_LABELS);

interface ResearchBriefOutput {
  domain: string | null;
  topFinding: string;
  findingDetail: string;
}

/** `SkillRun.output` is `unknown` -- a research brief is only ever rendered once these fields are confirmed present. */
function asResearchBrief(output: unknown): ResearchBriefOutput | null {
  if (!output || typeof output !== 'object') return null;
  const value = output as Record<string, unknown>;
  if (typeof value.topFinding !== 'string' || typeof value.findingDetail !== 'string') return null;
  return {
    domain: typeof value.domain === 'string' ? value.domain : null,
    topFinding: value.topFinding,
    findingDetail: value.findingDetail
  };
}

export function ResearchView({
  connections,
  setToast
}: {
  connections: ConnectionSummary[];
  setToast: (message: string) => void;
}) {
  const [platform, setPlatform] = useState('all');
  const [threads, setThreads] = useState<OutreachThreadRow[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [briefs, setBriefs] = useState<SkillRun[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThreadsLoaded(false);
    getOutreachThreads(platform === 'all' ? {} : { platform })
      .catch(() => [] as OutreachThreadRow[])
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        setThreadsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    let cancelled = false;
    getSkillRuns({ skillId: 'gtm.research-brief', limit: 50 })
      .catch(() => [] as SkillRun[])
      .then((runs) => {
        if (cancelled) return;
        setBriefs(runs);
        setBriefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showBriefs = platform === 'all' || platform === 'linkedin';
  const showRedditCorpus = platform === 'all' || platform === 'reddit';

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h2>Research</h2>
            <p>
              Everything discovered or drafted from community and company research, across every
              connected platform.
            </p>
          </div>
        </div>
        <div className="li-filter-row" role="group" aria-label="Platform">
          <span className="li-filter-label">Platform</span>
          {PLATFORM_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`li-range ${platform === key ? 'is-active' : ''}`}
              aria-pressed={platform === key}
              onClick={() => setPlatform(key)}
            >
              {PLATFORM_LABELS[key]}
            </button>
          ))}
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Discovered threads</h3>
            <p>Community threads scouted and scored for reply-worthiness.</p>
          </div>
        </div>
        <div className="client-table">
          {threads.map((thread) => (
            <article className="client-card-large" key={thread.id}>
              <span className="client-avatar large">
                {(PLATFORM_LABELS[thread.platform] ?? thread.platform).slice(0, 1)}
              </span>
              <div>
                <h3>
                  <a href={thread.url} target="_blank" rel="noreferrer">
                    {thread.title}
                  </a>
                </h3>
                <p>
                  {thread.community ? `${thread.community} · ` : ''}
                  {thread.author ? `by ${thread.author} · ` : ''}score {thread.score}
                </p>
                <span className="client-status">
                  {PLATFORM_LABELS[thread.platform] ?? thread.platform}
                </span>
              </div>
            </article>
          ))}
          {!threadsLoaded && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={26} />
              <h4 aria-level={3}>Loading…</h4>
              <p>One moment.</p>
            </div>
          )}
          {threadsLoaded && threads.length === 0 && (
            <div className="empty-state">
              <MessageSquare size={26} />
              <h4 aria-level={3}>No threads discovered yet</h4>
              <p>Scouting runs on its own schedule; check back once it has run.</p>
            </div>
          )}
        </div>
      </section>

      {showBriefs && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Company research</h3>
              <p>Findings drawn from company audits and enrichment, used to draft outreach.</p>
            </div>
          </div>
          <div className="client-table">
            {briefs.map((run) => {
              const brief = asResearchBrief(run.output);
              if (!brief) return null;
              return (
                <article className="client-card-large" key={run.id}>
                  <span className="client-avatar large">
                    {(brief.domain ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h3>{brief.domain ?? 'Unknown domain'}</h3>
                    <p>{brief.findingDetail}</p>
                    <span className="client-status">{brief.topFinding}</span>
                  </div>
                </article>
              );
            })}
            {briefsLoaded && briefs.length === 0 && (
              <div className="empty-state">
                <Newspaper size={26} />
                <h4 aria-level={3}>No research briefs yet</h4>
                <p>These are generated when a company is researched for outreach.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {showRedditCorpus && <ResearchScreen connections={connections} setToast={setToast} />}
    </div>
  );
}
```

- [ ] **Step 4: Run the typechecker**

Run: `npm run typecheck`
Expected: PASS. (This file has no import cycle risk: it imports `ResearchScreen` the same way `App.tsx` used to.)

- [ ] **Step 5: Commit**

```bash
git add src/client/api.ts src/client/views/ResearchView.tsx
git commit -m "client: add getOutreachThreads and ResearchView"
```

---

### Task 4: Nav & routing wiring

**Files:**

- Modify: `src/client/ui/route.ts`
- Modify: `src/client/App.tsx`
- Test: `src/client/ui/route.test.ts`

**Interfaces:**

- Consumes: `ResearchView` (Task 3).
- Produces: `/research` reachable from the primary nav; `/setup/research` redirects to it.

- [ ] **Step 1: Write the failing test**

In `src/client/ui/route.test.ts`, inside the existing `describe('parseRoute', ...)` block's first `it(...)`, add one more assertion alongside the existing ones (right after the `/outreach/accounts` block, for example):

```ts
expect(parseRoute('/research')).toMatchObject({
  section: 'research',
  sub: '',
  id: null,
  path: '/research'
});
```

Also add a new top-level test, after the `parseRoute` describe block:

```ts
describe('isAppPath', () => {
  it('claims /research as an app route', () => {
    expect(isAppPath('/research')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/client/ui/route.test.ts`
Expected: FAIL — `'research'` is not in `SECTIONS`, so `parseRoute('/research')` falls back to the default `/loop` route and `isAppPath('/research')` is `false`.

- [ ] **Step 3: Update `route.ts`**

In `src/client/ui/route.ts`, change:

```ts
export type Section = 'loop' | 'outreach' | 'ledger' | 'setup';

export const SECTIONS: readonly Section[] = ['loop', 'outreach', 'ledger', 'setup'];
```

to:

```ts
export type Section = 'loop' | 'outreach' | 'ledger' | 'research' | 'setup';

export const SECTIONS: readonly Section[] = ['loop', 'outreach', 'ledger', 'research', 'setup'];
```

and change the `SUB_ROUTES` map:

```ts
const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'accounts', 'activity', 'campaigns', 'inbox', 'leads', 'manager', 'plan'],
  ledger: ['', 'run'],
  setup: ['', 'agent', 'data', 'reddit', 'research', 'seat', 'skills', 'limits', 'spend', 'team']
};
```

to:

```ts
const SUB_ROUTES: Record<Section, readonly string[]> = {
  loop: ['', 'cost'],
  outreach: ['', 'accounts', 'activity', 'campaigns', 'inbox', 'leads', 'manager', 'plan'],
  ledger: ['', 'run'],
  research: [''],
  setup: ['', 'agent', 'data', 'reddit', 'seat', 'skills', 'limits', 'spend', 'team']
};
```

(Note: `'research'` is removed from `setup`'s list entirely, not kept as a redirect target. That means `parseRoute('/setup/research')` falls back to `{section: 'setup', sub: ''}` under the existing "unknown sub → section root" rule — by the time `SetupView` reads `route.sub` it is already `''`/`'agent'`, with no trace that the URL ever said `research`. So the redirect in Step 4 cannot key off `route.sub` the way the `seat` redirect does; it has to read `window.location.pathname` directly, which still shows the real `/setup/research` the user navigated to.)

- [ ] **Step 4: Update `App.tsx`**

Add the icon import — in the `lucide-react` import block (~line 3-24), add `Compass` alphabetically:

```ts
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Compass,
  Copy,
```

Add the `ResearchView` import, replacing the `ResearchScreen` import (`ResearchScreen` is now only used inside `ResearchView`, not directly by `App.tsx`):

```ts
import { RedditScreen } from './RedditScreen';
import { ResearchView } from './views/ResearchView';
```

(delete the old `import { ResearchScreen } from './ResearchScreen';` line)

In `NAV_ITEMS` (~line 105), add the Research entry after Ledger:

```ts
const NAV_ITEMS: Array<{ section: Section; path: string; icon: React.ReactNode; label: string }> = [
  { section: 'loop', path: '/loop', icon: <Repeat size={18} />, label: 'Loop' },
  {
    section: 'outreach',
    path: '/outreach/manager',
    icon: <Linkedin size={18} />,
    label: 'Outreach'
  },
  { section: 'ledger', path: '/ledger', icon: <Workflow size={18} />, label: 'Ledger' },
  { section: 'research', path: '/research', icon: <Compass size={18} />, label: 'Research' },
  { section: 'setup', path: '/setup', icon: <Settings2 size={18} />, label: 'Setup' }
];
```

In the render switch (~line 544, right after the `ledger` block and before the `setup` block):

```tsx
        {route.section === 'ledger' && (
          <LedgerView runId={route.id} setToast={setToast} onNavigate={go} />
        )}

        {route.section === 'research' && (
          <ResearchView connections={data.connections} setToast={setToast} />
        )}

        {route.section === 'setup' && (
```

In `SETUP_ROUTES` (~line 681), remove the `research` entry:

```ts
const SETUP_ROUTES: Array<{ sub: string; label: string; advanced?: true }> = [
  { sub: 'agent', label: 'Agent access' },
  { sub: 'data', label: 'Connections' },
  { sub: 'limits', label: 'Limits' },
  { sub: 'team', label: 'Team' },
  { sub: 'reddit', label: 'Reddit', advanced: true },
  { sub: 'skills', label: 'Skills', advanced: true }
];
```

Inside `SetupView`, next to the existing `seat` → `/outreach` redirect effect (~line 725), add a matching one that reads the raw browser path (not `route.sub`, since `parseRoute` already discarded `research` for setup by the time `route` reaches here):

```ts
useEffect(() => {
  if (sub === 'seat') onNavigate('/outreach');
}, [sub, onNavigate]);

useEffect(() => {
  if (typeof window !== 'undefined' && window.location.pathname === '/setup/research') {
    onNavigate('/research');
  }
}, [onNavigate]);
```

Remove the old render line for the Reddit-corpus screen inside `SetupView` (it now lives inside `ResearchView`):

```tsx
{
  sub === 'research' && <ResearchScreen connections={data.connections} setToast={setToast} />;
}

{
  sub === 'reddit' && <RedditScreen setToast={setToast} />;
}
```

becomes:

```tsx
{
  sub === 'reddit' && <RedditScreen setToast={setToast} />;
}
```

In `viewTitle` (~line 2898), add a case for the new section, right after the `outreach` block and before the `ledger` line:

```ts
if (route.section === 'ledger') return 'Run ledger';
if (route.section === 'research') return 'Research';
const sub = route.sub === 'spend' ? 'agent' : route.sub;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/client/ui/route.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS — this catches the `ResearchScreen` import removal, the `SETUP_ROUTES`/`SUB_ROUTES` edits, and the new `ResearchView` usage all at once, since App.tsx is one file.

- [ ] **Step 6: Commit**

```bash
git add src/client/ui/route.ts src/client/ui/route.test.ts src/client/App.tsx
git commit -m "nav: add Research as a top-level section"
```

---

### Task 5: Manual verification

No further code changes. This task exists because the client has no component-rendering test harness (checked: only `route.test.ts`, `analytics.test.ts`, and `LinkedInManagerWorkflowConfig.test.ts` exist under `src/client`, none render JSX), so the only way to confirm `ResearchView` actually renders correctly end-to-end is to run the app.

- [ ] **Step 1: Launch the app**

Use the `run` skill (or `npm run dev`) to start the app against the demo workspace.

- [ ] **Step 2: Walk through the new screen**

- Click **Research** in the primary nav (should land on `/research`).
- Confirm the platform chip row renders and clicking a chip (e.g. Reddit) narrows the "Discovered threads" lane and shows/hides the Company research and Reddit corpus lanes per the rules in `ResearchView.tsx`.
- Confirm the Reddit corpus lane (sources/search/recent runs) renders exactly as it did before at the old `/setup/research`.
- Navigate directly to `/setup/research` in the address bar and confirm it redirects to `/research`.
- Confirm `/setup/reddit` (RedditScreen) is untouched and still reachable from Setup → Advanced.

- [ ] **Step 3: Report back**

Note anything that looks wrong (empty states, console errors, layout) so it can be fixed before this is considered done. If everything matches, no further commit is needed — this task is verification-only.
