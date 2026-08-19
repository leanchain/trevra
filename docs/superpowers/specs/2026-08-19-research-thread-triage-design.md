# Research thread triage: judge it, then draft it

Status: designed, not built. Successor to
[2026-08-18-research-hub-design.md](./2026-08-18-research-hub-design.md), which
gave `outreach_threads` its first reader and nothing else.

## The problem

`/research` lists discovered threads with title, community, author, and a bare
`score` -- which is the PLATFORM's own number (HN points, GitHub reactions),
not reply-worthiness. A founder reading that list cannot answer the only
question the list exists to answer: is this one worth opening? Everything
needed to answer it already exists and is thrown away at render time:
`gtm.score-threads` computes a 0-10 relevance with every contribution itemised,
`extractTopics`/`suggestAngle` say what the thread is about and how a reply
would land, and `gtm.outreach-guard` knows whether replying there is allowed at
all today.

And once a thread IS worth replying to, there is no path from the row to a
draft. `gtm.community-outreach` re-scouts from scratch and drafts against
`repliable.0` -- whatever the scorer liked best in that batch, never the row the
founder picked.

## Non-goals

- No new relevance model. The scorer is a faithful port and stays untouched.
- No posting. The gate is unchanged: draft stops at approval, always.
- No relevance column. Scores are derived on read, never persisted, so a
  keyword-list change is not a stale-data migration.

## 1. Read path

`outreach_threads` stores `content_hash`, never the content itself: the table was
built to detect edits and to be the self-promotion ratio's denominator, not to
be re-read. Relevance, topics and the drafted reply all read the body, so a
migration adds `content TEXT NOT NULL DEFAULT ''`, written on insert and on
conflict beside `title`. Rows discovered before the migration carry `''` until
the next scout re-reads them, which is the same path an edited thread already
takes.

`listOutreachThreads` then selects `content` and `metadata_json` in addition to
today's columns -- `scoreThread`, `extractTopics` and `suggestAngle` all read
them, and without them relevance would be computed against a title alone.

New module `src/server/outreach/feed.ts`:

```ts
export interface FeedThread {
  row: OutreachThreadRow; // as today, plus content/metadata
  relevance: {
    score: number; // 0-10, from scoreThread
    components: Array<{ label: string; points: number }>;
    highValueMatches: string[];
    negativeMatches: string[];
  };
  topics: string[];
  angle: ReplyAngle;
  guard: { allowed: boolean; reason: string | null; failedChecks: SafetyCheckName[] };
}

export async function loadThreadFeed(
  db: Db,
  workspaceId: string,
  filters: { platform?: string; limit?: number },
  now: Date
): Promise<FeedThread[]>;
```

Ordering moves from `score DESC` (platform points) to relevance DESC, ties
broken by `first_seen_at DESC`. The SQL keeps its own `ORDER BY score DESC` for
a stable, indexed page; the final sort happens in `loadThreadFeed` over that
page.

**Guard without N+1.** `evaluateSafety` issues up to three DB reads per thread
(`countPostsToday`, `lastPostInCommunity`, `communityVolume`). Fifty rows would
mean 150 round trips for facts that vary only by `(platform, community)` -- of
which a page has a handful. `SafetyOptions` gains an optional seam:

```ts
export interface SafetyCounters {
  postsToday(platform: string, now: Date): Promise<number>;
  lastPostInCommunity(platform: string, community: string): Promise<Date | null>;
  communityVolume(platform: string, community: string): Promise<CommunityVolume>;
}
```

Default implementation calls the same three store functions, so `evaluateSafety`
and `gtm.outreach-guard` behave exactly as today. `loadThreadFeed` passes a
memoised implementation keyed by `platform` / `platform|community`, making the
page's guard cost proportional to distinct communities, not rows.

`GET /api/outreach/threads` returns the `FeedThread` shape. It is the only
consumer, so the row shape changes in place rather than growing a second
endpoint.

## 2. The card

Each row leads with relevance, then the evidence for it:

```
7.4  Ask HN: What works for cutting AI token costs?
Hacker News · 2 comments · 5 points · 71d old · ask_hn
why: "token cost" ×2 · question · fresh thread
angle: cost_comparison · topics: token_cost, coding_agent
```

- Relevance is the only number called a score. The platform's number is
  labelled `points`, resolving today's ambiguity.
- `why` chips come from `relevance.components` verbatim -- the scorer already
  writes them for a human (`high-value keywords (2)`, `labelled question`).
  Negative matches render as a warning chip, not silently.
- Age is derived from `thread_created_at`, falling back to `first_seen_at` with
  a `first seen` label rather than presenting discovery time as thread age.
- A blocked row (`guard.allowed === false`) is dimmed, keeps its position, and
  states the failing check (`daily cap: 3 of 3 hackernews posts used`). It is
  never hidden: "nothing here" and "everything here is rate-limited" are
  different facts.

## 3. From judged to drafted

New builtin playbook `gtm.thread-reply` v1.0.0 -- `gtm.community-outreach`
without the `scout` and `score` steps, targeting one caller-supplied thread:

| step            | type                       | notes                                                                                |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `guard`         | skill `gtm.outreach-guard` | `requireAllowed: true`; a blocked thread fails the run rather than reaching approval |
| `draft`         | skill `gtm.draft-reply`    | `thread`, `product`, `angle` from input                                              |
| `approve-reply` | approval                   | same payload and metadata as the community playbook, `relevanceScore` from input     |
| `post-reply`    | action `community.reply`   | unchanged, gated on `approve-reply`                                                  |

Input: `{ thread: outreachThreadSchema, angle?: ReplyAngle, relevanceScore?: number, product: {...}, account?: {...} }`.
The thread is sent whole from the feed row, so the drafted reply targets the row
the founder chose, and `url` is the reply target (fixed for HN in 971f233).

**The dialog.** "Draft reply" opens a confirm dialog carrying the offer:
`name`, `url`, `summary`, `mechanism`, `claims`. Fields are prefilled from the
newest `linkedin_campaigns.brief_json` for the workspace (`offer.name`,
`offer.url`, `offer.summary`, `offer.mechanism`, `offer.proof`) and are
editable; a workspace with no campaign gets empty fields and the same dialog.
Submitting starts the playbook via the existing `POST /api/playbooks/:id/runs`
and reports the run id plus "draft waiting in approvals". Nothing about the
dialog is persisted -- it is the run's input, visible in the ledger.

A new client helper `getOutreachOfferDefaults()` reads the newest campaign
brief through a small `GET /api/outreach/offer-defaults` route; a workspace with
no campaigns gets `{}` and a 200, not a 404.

## 4. Failure and empty states

- Feed load failure keeps today's error panel; the guard seam failing for one
  platform must not fail the page -- a verdict that cannot be computed renders
  as `guard unknown`, never as `allowed`.
- Starting the playbook surfaces the API error inline in the dialog and leaves
  it open with the typed offer intact.
- A run that fails at `guard` (blocked thread) is reported as "blocked: <reason>"
  rather than as an error toast, because it is an answer, not a fault.

## 5. Testing

- `feed.test.ts` (postgres): ranks by relevance not points; memoised counters
  issue one lookup per distinct `(platform, community)` for a many-row page;
  blocked rows keep their place with the failing check named.
- `safety.test.ts`: the default counters path is unchanged; an injected
  counters implementation is used when supplied.
- Playbook test: `gtm.thread-reply` stops at `waiting_approval` with the payload
  hash covering the drafted body, and fails at `guard` for a blocked thread.
- The client has no DOM test environment (vitest runs `node`, no jsdom), so the
  card's derived strings -- age label, why chips, points-vs-score labelling --
  live in `src/client/views/researchFormat.ts` and are unit-tested there.
  `ResearchView` itself is verified by typecheck and by driving the running app.
