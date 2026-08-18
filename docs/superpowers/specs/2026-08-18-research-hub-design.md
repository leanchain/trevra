# A `Research` nav entry: one place to see LinkedIn/Reddit/etc. research

Date: 2026-08-18
Status: approved, pending implementation plan

## Problem

Pankaj asked where the research he's collected for LinkedIn, Reddit, etc. is,
and whether a `Research` sidebar entry could show it all in one place. It
turns out the data is real but scattered across three places, one of which
has no viewer at all:

1. **Reddit corpus** — scraped posts/comments, searchable — lives in
   `ResearchScreen.tsx`, mounted at `/setup/research`, buried under
   Setup → Advanced.
2. **Reddit live thread reads** — on-demand hot/new/top/rising plus reply
   posting — `RedditScreen.tsx`, `/setup/reddit`, also under Setup → Advanced.
   This is an outreach _action_ tool (it posts comments), not a research
   viewer, and is explicitly not part of this redesign.
3. **Cross-platform discovered/scored threads** — the `gtm.scout-threads` /
   `gtm.score-threads` skills (`src/server/outreach/scout.ts`,
   `src/server/outreach/scorer.ts`) cover reddit, hackernews, github, devto,
   lobsters, mastodon, stackoverflow, and **linkedin** (`PLATFORM_QUERIES`,
   `src/server/outreach/config.ts:48`). Results persist to `outreach_threads`
   (`migrations/013_outreach.sql:11`), which already has everything a viewer
   needs — platform, title, url, community, score, first-seen — but has **no
   read API and no screen**. This is the LinkedIn/HN/etc. research Pankaj
   can't find, because nothing renders it.
4. **Per-company research briefs** — `gtm.research-brief`
   (`src/server/skills/brief.ts`) joins audit+enrich+score into a
   `topFinding`/`findingDetail` per domain, used to draft outreach copy.
   Every run is stored in `skill_runs.output` and already queryable via the
   existing `GET /api/skill-runs?skillId=gtm.research-brief` route
   (`src/server/app.ts:992`) — just never surfaced as a feed.

## Goals

- One top-level nav item, **Research**, alongside Loop / Outreach / Ledger /
  Setup.
- A single feed at `/research` with a platform filter (chips: All, LinkedIn,
  Reddit, Hacker News, GitHub, Dev.to, Lobsters, Mastodon, Stack Overflow),
  showing two lanes:
  - **Discovered threads** — from `outreach_threads`, newest/highest-scored
    first, each row linking out to the source thread.
  - **Company research** — `gtm.research-brief` outputs as cards: domain,
    topFinding, findingDetail, evidence.
- The Reddit corpus (sources, sync runs, search) relocates into this page as
  the Reddit-filtered view, replacing its current home at
  `/setup/research`.

## Non-goals

- `RedditScreen` (`/setup/reddit`) is unchanged — it posts comments, it does
  not research.
- No new scout platforms, no change to how/when `scout-threads`,
  `score-threads`, or `research-brief` run today. This is a viewer over
  existing data, not a change to collection.
- No new database migration — `outreach_threads` already has every column
  the feed needs.
- No changes to the generic `/ledger` run history; `Research` is a
  purpose-built feed, `/ledger` stays the raw run log.

## Design

### Nav & routing

- `src/client/ui/route.ts:38` — `SECTIONS` gains `'research'`;
  `SUB_ROUTES.research = ['']` (single page, no sub-routes; the platform
  filter is client-side state, not part of the path).
- `src/client/App.tsx:105` — `NAV_ITEMS` gains `{ section: 'research', path:
'/research', icon: <Search size={18} />, label: 'Research' }`, positioned
  after Ledger.
- `SETUP_ROUTES` (`src/client/App.tsx:681`) drops the `research` entry
  (moved out); `reddit` stays, still under Advanced.
- `/setup/research` becomes a redirect to `/research`, same pattern as the
  existing `seat` → `/outreach` redirect at `App.tsx:726`, so old bookmarks
  survive.

### Backend: new read path for discovered threads

- `src/server/outreach/store.ts` — add:
  ```ts
  export async function listOutreachThreads(
    db: Db,
    workspaceId: string,
    filters: { platform?: string; limit?: number } = {}
  ): Promise<OutreachThreadRow[]>;
  ```
  `SELECT * FROM outreach_threads WHERE workspace_id=? [AND platform=?]
ORDER BY score DESC, first_seen_at DESC LIMIT ?` (limit clamped like
  `listWorkspaceSkillRuns` does at `skill-api.ts:184`, default 50, max 200).
- `src/server/app.ts` — add `GET /api/outreach/threads`, same shape as the
  neighboring `GET /api/skill-runs` route at `app.ts:992`: parse
  `{platform?, limit?}` from query, call `listOutreachThreads`, return
  `{ threads }`.
- `src/client/api.ts` — add `getOutreachThreads(filters)` wrapper.

### Backend: company research

None needed. `getSkillRuns({ skillId: 'gtm.research-brief' })` (existing
client wrapper around `GET /api/skill-runs`) is sufficient; the feed reads
`.output.topFinding` / `.output.findingDetail` / `.output.domain` /
`.output.evidence` per run (shape defined in `ResearchBrief`,
`src/server/skills/brief.ts:30`).

### Frontend: `ResearchView`

New `src/client/views/ResearchView.tsx`, mounted at `route.section ===
'research'`:

- Platform filter (chip row), client-side state, filters both lanes.
- **Discovered threads** lane: fetches `getOutreachThreads({platform})`,
  renders each as `platform badge · community · title (links out) · score`.
- **Company research** lane: fetches `getSkillRuns({skillId:
'gtm.research-brief'})`, renders each as a card (domain, topFinding,
  findingDetail, evidence links). When `platform === 'linkedin'` and no
  domain-to-platform mapping exists, this lane shows for `All` and
  `LinkedIn` only (research briefs aren't tagged by discovery platform today
  — see Open questions).
- **Reddit corpus** lane: the existing sources/sync/search UI from
  `ResearchScreen.tsx`, shown only under `All` and `Reddit` filters. The
  component itself is unchanged — `ResearchView` renders it, `SetupView` no
  longer does.
- Each lane: independent fetch, `.catch(() => [])` on failure (matches
  `LedgerView.tsx:96`) so one broken lane doesn't blank the page; existing
  `.empty-state` pattern for "nothing here yet".

## Error handling / edge cases

- No `gtm.research-brief` runs yet → empty state in that lane, not the whole
  page.
- No `outreach_threads` rows for a platform → empty state, not an error.
- Reddit not connected → same empty state `ResearchScreen` already renders
  today, unchanged.
- One lane's request failing (network, 500) → that lane shows its own error
  state; the other two lanes still render.

## Testing

- Server: `outreach/store.test.ts` — `listOutreachThreads` filters by
  platform, respects limit clamp, returns `[]` for a workspace with no rows.
  `app.test.ts` — `GET /api/outreach/threads` route smoke test (200, shape,
  workspace isolation).
- Client: smoke test that `/research` renders all three lanes, and that
  selecting a platform chip narrows each lane's visible rows.

## Open questions

- `outreach_threads.platform` is authoritative for the discovered-threads
  lane. `gtm.research-brief` runs have no platform tag (a brief is keyed by
  domain, not by where it was discovered) — for v1, briefs show under `All`
  and `LinkedIn` only, since that's their primary current use. Revisit if
  briefs start getting run from Reddit-sourced leads too.
