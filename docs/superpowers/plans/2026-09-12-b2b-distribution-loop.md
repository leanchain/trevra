# B2B Market-to-Distribution Loop — Execution Plan

Date: 2026-09-12

## Goal

Turn Trevra into the founder GTM engine that answers one question exceptionally well:

**Who should I talk to today, why now, and what should I do next?**

The primary loop is:

**observe market + first-party demand → resolve Person × Account → combine independent evidence → rank commercial relevance → prepare the next best action → human approval → conversation → meeting/opportunity → learn.**

Distribution is a feeder into that loop, not the product boundary:

**market evidence → evidence-backed content → publish → engagement → Person/Account resolution → commercial qualification → next best action.**

This is horizontal B2B. Ecommerce-specific observations (products, Meta ads, newsletters, ecommerce apps, etc.) and startup-specific events (`scan_completed`, `install_registered`, `pilot_requested`) are optional evidence providers, not core schema concepts.

The first shipping loop is deliberately narrower than the original distribution plan:

**recent first-party inbound + hot composite account intent → one evidence-backed qualified-demand recommendation → Today → prepare action.**

Only after that works do we close the public-distribution loop with LinkedIn posts and engagement. Do not build a generic "AI social studio" or an enterprise CRM suite. The advantage is that Trevra can connect market movement, person activity, first-party intent and relationship state into a decision.

---

## Product constraints

1. **Evidence first.** Every factual claim in generated content must map to stored Trevra evidence with source URL + timestamp. Unsupported claims are rejected, not softened.
2. **Channel-neutral core.** LinkedIn is publisher #1, not the data model. No generation logic belongs inside `src/server/linkedin/*`.
3. **Horizontal B2B.** No core schema fields named for Shopify, products, Meta ads, ecommerce, etc. Provider-specific payloads stay behind observation/evidence adapters.
4. **Human owns publishing.** Generating a draft is safe; scheduling/publishing remains an explicit human action through the existing LinkedIn post flow.
5. **No new primary nav destination.** Discovery starts from Research / account evidence. Publishing remains under Outreach → Posts. Do not add a sixth top-level screen.
6. **Do not duplicate arbitrary evidence corpora.** Keep canonical source IDs and store only the minimal immutable fact/excerpt, URL and timestamp needed to preserve auditability if the source row later disappears.
7. **No invented virality.** Trevra may recommend a format based on measured performance. It may not label something "viral" without observed metrics.
8. **Learning must be explainable.** "Use this hook" must be attributable to the user's own post history and metrics, not a hidden opaque score.

---

## Existing foundation to reuse

Trevra already has most of the expensive infrastructure:

- `account_signals` — append-only, source-linked company changes (`migrations/039_accounts.sql`).
- Account scoring — composite, recency-aware evidence ranking (`src/server/accounts/score.ts`).
- Brand/keyword watches + mentions + sentiment (`migrations/112_brand_watches.sql`, `src/server/watch/*`).
- Research briefs and evidence-aware skill runs (`src/server/skills/brief.ts`, `src/server/skills/runner.ts`).
- Playbook approval / exact action mechanics (`src/server/playbooks/*`).
- LinkedIn structured post composer, media, scheduling and browser publisher (`src/client/LinkedInPosts.tsx`, `src/server/linkedin/posts.ts`, `src/server/linkedin/driver-post.ts`, `src/server/linkedin/jobs.ts`).
- `posted_url` is already captured for published LinkedIn posts.

The major missing pieces, in product priority order, are:

- a deterministic **Demand Candidate** projection joining canonical Person + Account + first-party + market evidence;
- a qualification model that keeps **ICP fit, account intent, person intent, first-party intent, relationship state and recency** separate and explainable;
- a generalized next-best-action recommendation engine (today it only creates `stale_proposal` recommendations);
- `Today` collapsing overlapping raw events into one compound commercial decision instead of listing inbound and hot-account rows independently;
- orchestration from a hot account to the right existing Person, or a targeted people-search when the workspace has nobody suitable;
- opportunity/source attribution so Trevra can learn which evidence and actions created conversations, meetings and wins;
- a channel-neutral "story opportunity" object;
- an evidence-constrained content drafter;
- provenance linking generated assets back to their evidence;
- a bridge from Trevra-published posts to existing LinkedIn post-engager harvesting and canonical Person resolution;
- feed-post analytics (impressions/reactions/comments/etc. — current LinkedIn analytics is campaign/outreach analytics, not post analytics);
- shareable evidence-card rendering, recurring market-pulse generation and public reports after the commercial loop is working.

---

# Primary architecture — Founder Demand Graph

Do **not** create one giant polymorphic `signals` table. Existing domain evidence remains canonical. Add a deterministic read/projection layer that joins it for commercial decisions.

```text
Account evidence ───────┐
                        │
Person engagement ──────┤
                        │
First-party inbound ────┼──► Demand Candidate(Person × Account)
                        │              │
Conversation history ───┤              ▼
                        │       Next Best Action
Opportunity state ──────┘              │
                                       ▼
                                     Today
```

V1 `DemandCandidate` shape:

```ts
interface DemandCandidate {
  personId: string;
  accountId: string;
  evidence: DemandEvidence[];
  dimensions: {
    fit: number | null;
    accountIntent: number;
    personIntent: number;
    firstPartyIntent: number;
    relationship: number;
    recency: number;
  };
  qualification: 'act_now' | 'watch' | 'ignore';
  recommendedAction: 'reply' | 'prepare_outreach' | 'find_person' | 'qualify' | 'watch';
  rationale: string[];
}
```

Rules:

1. Keep the dimensions separately inspectable; never hide them behind one unexplained score.
2. A single weak engagement never creates `act_now`.
3. Explicit first-party actions (demo request, diagnostic/scan, pilot request) may be strong evidence but still preserve their source/provenance.
4. Account intent comes from the existing composite scorer; do not duplicate that scoring arithmetic here.
5. Person identity is deterministic only. Email, phone, LinkedIn profile/provider identity may resolve; fuzzy name/company matching may not.
6. A Demand Candidate is a projection, not a new CRM hierarchy and not a separate `Lead` database.
7. Recommendations persist the actionable decision and immutable proof; the candidate itself may be recomputed from current canonical state.

# Secondary architecture — Market-to-Distribution Loop

## 1. Observation / evidence — existing systems remain canonical

Inputs may include:

- account site changes;
- hiring changes;
- pricing changes;
- technology changes;
- public forum/community mentions;
- GitHub activity;
- newsletters;
- ads;
- product/catalog changes;
- social activity;
- local/private providers;
- future connectors.

Do **not** normalize all providers into a lossy mega-table before this project. The content layer consumes a small canonical evidence reference plus normalized facts exposed by each source.

## 2. Story opportunity — new channel-neutral object

A story is the bridge between "something happened" and "this is worth telling an audience."

Proposed table: `content_opportunities`.

```sql
content_opportunities (
  id text primary key,
  workspace_id text not null,
  status text not null, -- candidate | ready | dismissed | expired
  kind text not null,   -- company_change | market_pattern | watch_trend | comparison | index_move
  title text not null,
  thesis text not null,
  audience text,
  freshness_at timestamptz not null,
  score numeric not null,
  rationale_json jsonb not null,
  evidence_json jsonb not null,
  fingerprint text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, fingerprint)
)
```

`evidence_json` contains **references plus the minimal immutable fact snapshot used by the claim**, not free-form model prose. The snapshot is necessary because canonical source rows may later be deleted with their parent account; a published claim must remain auditable. Minimum shape:

```ts
type ContentEvidenceRef = {
  sourceType: 'account_signal' | 'brand_watch_mention' | 'skill_run' | 'external_observation';
  sourceId: string;
  label: string;
  detail: string; // immutable fact/excerpt actually used by the claim
  sourceUrl: string;
  observedAt: string;
};
```

An opportunity does not need an LLM to exist. V1 candidate selection should be deterministic so it is debuggable and cheap.

## 3. Content asset — canonical content, independent of channel

Proposed table: `content_assets`.

```sql
content_assets (
  id text primary key,
  workspace_id text not null,
  opportunity_id text references content_opportunities(id),
  status text not null, -- draft | approved | archived
  format text not null, -- text_post | evidence_card | market_pulse | report
  angle text not null,  -- observation | contrarian | list | teardown | prediction | comparison
  hook text not null,
  body text not null,
  claim_map_json jsonb not null,
  generation_json jsonb not null,
  created_by text,
  created_at timestamptz not null,
  updated_at timestamptz not null
)
```

`claim_map_json` is load-bearing:

```ts
type ClaimMapEntry = {
  claim: string;
  evidence: ContentEvidenceRef[];
};
```

A draft fails validation if a factual sentence that requires evidence cannot be mapped to evidence.

The canonical asset is plain semantic content. Channel renderers convert it to LinkedIn `PostBlock[]` or future platform formats.

## 4. Publication — reuse channel-specific systems

Do not replace `linkedin_posts`.

Add provenance fields to it with an additive migration:

```sql
ALTER TABLE linkedin_posts ADD COLUMN content_asset_id text REFERENCES content_assets(id) ON DELETE SET NULL;
ALTER TABLE linkedin_posts ADD COLUMN publication_meta_json jsonb NOT NULL DEFAULT '{}'::jsonb;
```

Publishing still follows the existing path:

`content asset → LinkedIn renderer → linkedin_posts draft → human edits/approves → schedule/publish worker`.

A user can always detach/edit the final post. Provenance remains so analytics can learn from the original angle/format.

## 5. Metrics — separate observed history

Proposed table: `content_publication_metrics`.

```sql
content_publication_metrics (
  id text primary key,
  workspace_id text not null,
  channel text not null,
  publication_id text not null,
  observed_at timestamptz not null,
  impressions integer,
  reactions integer,
  comments integer,
  reposts integer,
  clicks integer,
  profile_views integer,
  follows integer,
  raw_json jsonb not null,
  unique (workspace_id, channel, publication_id, observed_at)
)
```

Metrics are append-only snapshots. Never overwrite yesterday's count; velocity matters.

## 6. Learning layer — deterministic first

Do not begin with an LLM recommender.

Aggregate performance by:

- opportunity kind;
- signal/evidence kind;
- angle;
- hook family;
- format;
- topic/entity tags;
- day/time;
- audience/market when enough sample exists.

Show sample size alongside every recommendation.

Example:

> Company-change + list hooks: median 4,820 impressions across 11 posts, 1.9× your 30-day median.

The drafter may use this later as input, but the calculation itself stays deterministic.

---

# Execution sequence

## Implementation status — 2026-09-12

- [x] Recent first-party inbound + hot Account → `DemandCandidate`.
- [x] `qualified_demand` recommendation with immutable proof and source timestamps.
- [x] `Today` collapses duplicate inbound + hot-account events into one decision.
- [x] `Today` remains visible before outreach activation, so inbound demand is never hidden behind setup.
- [x] Worker refreshes qualified-demand recommendations without activating dormant stale-proposal automation.
- [x] Hot Account ≥80 + exactly one explicit/verified known Person → outbound demand decision.
- [x] Precision guards: multiple candidate People are not auto-selected; Accounts with open opportunities are not re-prospected.
- [x] Multiple-contact persona/buying-role ranking from the latest saved campaign ICP role, with minimum-score + margin guards and proof evidence.
- [x] Hot Account with no known Person → account-scoped `person_discovery` recommendation and prefilled LinkedIn company-employee / buyer-role people search; nothing queues until the founder acts.
- [x] Recommendation → exact prepared action → provider-verified conversation reply → Opportunity-lite attribution.
- [x] Distribution/content loop feeding Person-intent evidence from Trevra-published LinkedIn posts.
- [x] Evidence-backed story → deterministic LinkedIn draft with canonical `content_asset_id` provenance.
- [x] Real publish permalink capture → bounded engager observation → Demand Graph qualification.
- [x] Append-only own-post metrics with tapered 6h/24h lifecycle reads; unreadable metrics stay null.
- [x] Commercial content attribution: engager → Person → qualified demand → verified reply → Opportunity → won.
- [x] Outcome-aware draft framing with minimum `n=3` per angle and visible reasoning; commercial outcomes outrank reach.
- [x] Evidence-card rendering / native visual attachment, including revision-safe PNG proof cards and carousel variants.
- [x] Brand-watch Market Pulse scope with source-count guards, sentiment/keyword summaries, manual drafting and opt-in weekly/monthly preparation through the existing workspace automation lease.
- [ ] Generic saved-filter Market Pulse scope is deferred until Trevra has a canonical saved-filter model; do not invent a parallel filter entity just to satisfy the plan.
- [x] Public reports/indexes with external acquisition attribution, safe format cloning, and additional copy-only publisher adapters/handoffs.

## Phase 0 — Demand Graph V1

### 0.1 Demand Candidate projection

Create `src/server/demand/candidates.ts` with deterministic, workspace-scoped candidate builders.

First candidate rule (ship this before adding more):

- a recent `inbound_submission` resolves to a canonical Person;
- the submission has an explicit Account;
- that Account currently has `tier = 'hot'` from the existing composite account scorer;
- load the actual contributing `account_signals` so the candidate is backed by source URLs, not merely by a score.

Output one Person × Account candidate with:

- first-party evidence;
- account score summary;
- 2–4 fresh account signal evidence rows;
- explicit dimension values;
- deterministic `act_now` qualification;
- recommended action `prepare_outreach` or `reply` depending on conversation state.

Fingerprint by Person + Account + recommendation family so repeated submissions refresh one commercial decision rather than flooding Today.

### 0.2 Generalize recommendations

Extend `RecommendationType` beyond `stale_proposal` with `qualified_demand` first.

`runRecommendationEngine` should consume Demand Candidates and upsert a `qualified_demand` recommendation with proof pack. It remains idempotent and workspace-scoped.

The evidence must preserve:

- inbound submission id/kind/message/page URL;
- account score/tier and distinct-signal count;
- actual account signal ids/details/source URLs/timestamps.

### 0.3 Make Today compound evidence

`getToday` should project ready `qualified_demand` recommendations as `qualification_decision` items ahead of raw inbound/high-priority-account rows.

When a raw inbound submission and hot account are already represented by an active `qualified_demand` recommendation, suppress those duplicate raw cards. The founder should see **one decision**, not three events.

**Gate:** a Beseam-style scan/demo from a Person at an already-hot Account produces one Today card explaining the combined evidence and the next action.

---

## Phase 1 — Expand demand evidence

Add candidate adapters, one at a time, without changing the Demand Candidate contract:

1. Trevra-published LinkedIn post reactors/commenters;
2. brand/watch mention authors when deterministic identity exists;
3. verified replies/conversation activity;
4. product/diagnostic/install events submitted through generic capture sources;
5. dormant opportunity + newly hot account;
6. existing relationship/person at a newly hot account.

A provider-specific event remains evidence, never a new core entity.

### 1.1 Hot account → right person

When an Account is hot but no high-confidence Person exists:

- check canonical `account_contacts` first;
- prefer existing relationships over new sourcing;
- if none exists, prepare a targeted company-employee / people-search source using the workspace persona;
- never enroll harvested people into outreach automatically.

### 1.2 Outcome attribution

Add durable lineage from recommendation → prepared action → conversation/reply → opportunity stage transition. This is what eventually lets Trevra learn which evidence combinations create meetings/wins instead of optimizing for views.

**Gate:** `Today` answers "who should I talk to today?" from both inbound and outbound evidence.

---

## Phase 2 — Close the distribution-to-demand bridge

Before sophisticated content analytics, connect the existing publisher to lead generation:

1. a Trevra-created LinkedIn post retains `content_asset_id` and `posted_url`;
2. after publish, its URL can be queued through the existing LinkedIn `post` lead-source harvester;
3. reactors/commenters resolve through the canonical Person identity spine;
4. that engagement becomes Person-intent evidence for Demand Candidates;
5. engagement alone never creates `act_now`; it must layer with fit/account/first-party/relationship evidence.

**Gate:** a person engaging with a Trevra-published post can later appear in Today only when the commercial evidence justifies it.

---

## Phase 3 — content contracts and seams

### 0.1 Define the content domain types

Create:

- `src/server/content/types.ts`
- `src/server/content/evidence.ts`

Types:

- `ContentEvidenceRef`
- `ContentOpportunity`
- `ContentAsset`
- `ClaimMapEntry`
- `ContentAngle`
- `ContentFormat`

Acceptance:

- no channel-specific fields;
- no ecommerce-specific fields;
- evidence reference always includes source URL + observed timestamp;
- exact source object can be reloaded from its canonical store.

### 0.2 Add migrations

Create sequential migrations for:

- `content_opportunities`;
- `content_assets`;
- `content_publication_metrics`;
- `linkedin_posts.content_asset_id` + publication metadata.

Every table/query must be workspace scoped.

### 0.3 Add stores with no generation yet

Create:

- `src/server/content/opportunities.ts`
- `src/server/content/assets.ts`
- `src/server/content/metrics.ts`

Tests first for tenant isolation, fingerprints/dedupe and append-only metric snapshots.

**Gate:** data model can persist one story and trace it all the way back to source evidence before any UI or LLM work begins.

---

# Phase 4 — Signal → story opportunity

This creates the first genuinely new product capability.

## 1.1 Deterministic candidate builder

Create `src/server/content/opportunity-builder.ts`.

V1 sources:

1. hot/warm account scores with at least two independent evidence kinds;
2. fresh high-signal account events;
3. brand-watch clusters/trends;
4. recurring pattern across multiple accounts within a time window.

Examples:

- `company_change`: one company has a layered, recent change worth explaining;
- `market_pattern`: 7 of 120 watched companies increased engineering hiring this week;
- `watch_trend`: a watched topic's mention volume or sentiment moved materially;
- `comparison`: multiple named companies made comparable changes.

Do **not** emit opportunities from `first-capture` or one weak signal alone.

Scoring factors:

- evidence independence;
- recency;
- magnitude;
- number of entities;
- source diversity;
- novelty vs recently generated opportunities;
- user dismissals / prior performance later.

Store rationale so `score = rationale` remains auditable, following the account scorer's existing design philosophy.

## 1.2 Fingerprinting / dedupe

Fingerprint from the normalized story identity, not its generated title.

Examples:

- company story: entity + contributing evidence IDs;
- market pattern: sorted entity IDs + signal family + time bucket;
- watch trend: watch ID + metric movement + time bucket.

Re-running discovery must not create the same story every hour.

## 1.3 Worker integration

Add a paced background pass after relevant evidence collectors complete. It should use already-stored observations and perform **no network calls**.

Potential entry:

- `runContentOpportunityTick(db)` from `src/worker/index.ts`.

**Gate:** Research can show "3 stories worth telling" with exact evidence before content generation exists.

---

# Phase 5 — Evidence-constrained drafting

**Status: V1 shipped through the deterministic evidence renderer rather than a separate LLM skill.** Research can now compare every safe framing for a story before persistence, inspect each claim→source map, and choose the exact angle that opens in the ordinary LinkedIn composer. Preview is read-only; selected non-default angles get their own revision/idempotency key, while the recommended angle reuses the canonical draft. A deterministic content critic remains the next correctness layer; model-assisted drafting is optional rather than required for the founder loop.

## 2.1 New skill: `gtm.content-draft`

Create `src/server/skills/content-draft.ts` and register it.

Input:

```ts
{
  opportunityId,
  channel?: 'linkedin',
  angle?: ContentAngle,
  voiceSample?: string,
  performanceHints?: PerformanceHint[]
}
```

Output:

```ts
{
  (hook, body, angle, claimMap, evidence, generator, critique);
}
```

Reuse the current skill runner so input/output/evidence are automatically recorded in `skill_runs`.

## 2.2 Draft five meaningfully different angles

Initial angle family:

- **Observation** — "X changed; here is why it matters."
- **Pattern/list** — several companies / changes.
- **Contrarian** — challenges a common interpretation using the evidence.
- **Teardown** — one company, several observed moves.
- **Prediction** — clearly labels inference/prediction separately from observed facts.

Do not generate five paraphrases of the same post.

## 2.3 Content critic

**Status: deterministic V1 shipped.** Before a preview can be selected or a draft can be created/reused, Trevra verifies that every factual claim belongs to the canonical story snapshot, every claim has exact stored provenance with an inspectable HTTP(S) URL and observation timestamp, the story is still fresh, and the rendered copy is inside the LinkedIn length boundary. Prediction framing must label inference explicitly. Overlong/promotional/thesis-light copy is surfaced as warnings, and critique results are stored with the ContentAsset generation metadata. Stale evidence blocks even an already-existing idempotent draft from reopening through the story action.

Create `src/server/content/critic.ts`.

Hard blockers:

- unsupported factual claim;
- missing provenance;
- source date omitted where freshness is material;
- inference presented as observed fact;
- named-company assertion backed only by another company's evidence;
- fabricated metric;
- stale story beyond configured freshness window.

Warnings:

- generic hook;
- repetitive structure;
- excessive length;
- evidence dump with no thesis;
- overly promotional CTA.

The critic should resemble `skills/voice.ts`: deterministic checks first, optional model revision second.

## 2.4 LinkedIn renderer

Create `src/server/content/renderers/linkedin.ts`.

Converts the approved canonical content asset into existing `PostBlock[]`.

It does **not** publish.

**Gate:** from one story, user can generate variants, choose one, and open an ordinary Trevra LinkedIn draft with provenance intact.

---

# Phase 6 — Product surface: Story → Post

## 3.1 Research surface

Do not add a new nav item.

Inside `ResearchView` add a compact "Stories" section above raw mentions/briefs when opportunities exist.

Each story card shows:

- thesis;
- freshness;
- involved entities;
- 2–4 evidence rows;
- why Trevra thinks it is worth telling;
- `Draft post`;
- `Dismiss`.

A story is useful without generating anything. Evidence is visible before the CTA.

## 3.2 Account-level entry point

**Status: shipped.** Expanded hot/warm target-account rows now expose `Turn into post` when the score has at least two signal kinds. The server re-validates recency and source-backed independent evidence, materializes or reuses the ordinary deterministic `company_change` opportunity for that exact workspace Account, creates/reuses the same provenance-linked LinkedIn draft, and opens the existing Posts composer. There is no account-specific generator or second content model.

## 3.3 Draft UX

**Status: V1 shipped.** Research shows the performance-backed recommended framing plus a compact `Compare angles` surface. Safe alternatives use the same deterministic renderer as persisted drafts, expose the exact body and claim→source map, and open the selected angle in the existing composer. No duplicate editor or second generation path was introduced.

Use a modal/drawer or focused flow from Research; do not duplicate the full `LinkedInPosts` editor.

Flow:

1. choose angle / inspect 3–5 variants;
2. inspect evidence backing the selected variant;
3. `Open in LinkedIn composer`;
4. existing composer handles edit/media/schedule/publish.

The human should never wonder whether a generated fact was invented.

**Gate:** end-to-end first loop works with current publisher and no new top-level screen.

---

# Phase 7 — Evidence cards

**Status: V1 shipped.** Deterministic source-backed cards render to real PNGs in 1:1, 4:5 and 16:9 shapes; Research exposes the 4:5 default as `Draft + card`, and the image is idempotently attached to the existing editable LinkedIn draft. No model/image generation is involved.

This is the first built-in sharing mechanic.

## 4.1 Deterministic card spec

Create `src/server/content/cards/*` or a server-rendered HTML/SVG renderer.

Card fields:

- entity / market name;
- one headline observation;
- up to three evidence-derived metrics/facts;
- observation dates;
- subtle `Trevra` provenance;
- optional source count;
- never a fabricated benchmark.

Formats:

- 1:1;
- 4:5;
- 16:9 / OG.

No image generation is needed for v1. Deterministic typography is cheaper, safer and keeps the proof legible.

## 4.2 Attach to LinkedIn post

Reuse the existing LinkedIn image attachment support.

`Generate evidence card` creates media on the content asset; `Open in composer` carries it across to `linkedin_posts`.

## 4.3 Shareability rule

A card must remain useful if the viewer has never heard of Trevra. Branding is provenance, not the point of the image.

**Gate:** a user can publish an evidence-backed post with a native visual without leaving Trevra. **Met for deterministic PNG evidence cards.**

---

# Phase 8 — Feed-post analytics

**Shipped 2026-09-12:** bounded own-post metric reader, real publish-permalink capture, append-only snapshots, tapered lifecycle scheduling, authenticated performance API, Research distribution outcomes, and explicit nulls for unreadable metrics. Post-history velocity and richer per-post UI remain follow-up polish.

This closes the loop and is required before claiming Trevra learns distribution.

## 5.1 LinkedIn metric collector

The existing LinkedIn post design explicitly deferred impressions/reactions/comments. Implement this as a sibling to publishing, not as campaign analytics.

Add a driver read path that, for a Trevra-published `posted_url`, observes whatever LinkedIn exposes to the logged-in post owner:

- impressions/views;
- reactions;
- comments;
- reposts when available;
- any reliably exposed profile/follower metrics only if attributable.

Collector failure must be explicit; never turn "not readable" into zero.

## 5.2 Snapshot schedule

Take append-only snapshots at sensible lifecycle points after publish and then taper. The exact worker cadence should be configurable and rate-conscious.

Do not continuously scrape every historical post.

## 5.3 Publication analytics API/UI

On post history show:

- current observed metrics;
- metric velocity where enough snapshots exist;
- comparison with the user's own recent baseline;
- no global vanity benchmark without data.

**Gate:** Trevra can answer "which of my evidence-backed posts actually worked?" from observed data.

---

# Phase 9 — Learning / format selection

**Shipped 2026-09-12:** generation-time feature extraction, deterministic angle buckets with `n`, commercial-outcome attribution, minimum-sample guards, safe heuristic exploration, and visible performance-backed framing hints. Commercial outcomes are compared per post before reach; reach is only a tiebreaker when both buckets have enough readable impression samples. Early-velocity and rolling-baseline refinements remain optional follow-up.

## 6.1 Feature extraction

Every content asset already has stable metadata:

- angle;
- hook family;
- format;
- evidence/source kinds;
- number of entities;
- content length;
- optional market/topic tags.

Persist these in `generation_json` / normalized derived views as appropriate.

## 6.2 Performance baselines

Create deterministic analytics over sufficiently-sized samples.

Examples:

- median impressions by angle;
- comments per 1k impressions;
- reaction rate;
- early velocity;
- performance vs rolling personal median.

Always include `n`.

## 6.3 Feed hints back into drafting

`gtm.content-draft` may receive a small set of observed hints, e.g.:

```text
Your last 9 teardown posts: median 7.1k impressions (1.8x 30-day baseline).
Your last 4 prediction posts: insufficient sample / no uplift.
```

The model remains free to produce content, but the evidence for the strategy recommendation is visible.

**Gate:** the next batch is informed by what actually worked for this user.

---

# Phase 10 — Recurring Market Pulse

**Shipped 2026-09-12 for Account scopes:** deterministic 7/30-day compiler over the existing active Account watchlist, optional existing Account-tag scope, cross-account pattern gate, source-backed examples, one-click pulse draft, and opt-in weekly/monthly draft preparation. Brand-watch and saved-filter scopes remain extensions of the same compiler contract; no new Market entity was introduced.

Only build after the one-story loop and metrics are working.

## 7.1 Market definition

Do not invent an elaborate market ontology initially.

Use existing user-defined scopes:

- account watchlists / tags;
- brand watches;
- optional named saved filters.

A `Market` object can be introduced later if users need reusable composition across these scopes.

## 7.2 Pulse compiler

Create `src/server/content/pulse.ts`.

For a selected scope + period:

- summarize counts and deltas from canonical observations;
- identify top story clusters;
- select named examples with evidence;
- generate a draft only after deterministic statistics exist.

Examples:

- "What changed across 126 European devtools companies this week"
- "7 security vendors increasing platform hiring"
- "The pricing changes we observed in vertical SaaS this month"

No ecommerce assumptions.

## 7.3 Recurrence

Let users opt into a weekly/monthly draft cadence. The system prepares a draft; it does not auto-publish by default.

**Gate:** Trevra repeatedly creates new distribution material from new market activity without manual research.

---

# Phase 11 — Public reports / indexes

**Status: shipped for account-watchlist Market Pulse + explainable Market Momentum Index.** Public pages are immutable publication-time snapshots, source-backed, crawlable, explicitly published/unpublished by a human, and never expose live workspace state.

This is the stronger external acquisition loop, but it should not precede trust in the private workflow.

## 8.1 Public report model

Create explicit public snapshots. Do not expose live workspace internals directly.

A published report freezes:

- title;
- description;
- included observations;
- methodology;
- generated charts/cards;
- publication date;
- source links allowed for public display.

Use a separate public slug/token and publication state.

## 8.2 Public route

Add a server-rendered public route under a stable namespace such as:

`/signals/:slug`

It must have:

- strong OG metadata;
- crawlable HTML;
- evidence/source links;
- methodology;
- tasteful Trevra CTA;
- no workspace navigation or private data.

## 8.3 Trevra Index

An index is a specific report template, not a special hard-coded vertical.

Examples:

- AI Infrastructure Momentum Index;
- Swiss Fintech Hiring Index;
- European Cybersecurity GTM Index;
- Developer Tool Adoption Watch.

Index components must be explicit and sourceable. If the score cannot be explained row-by-row, do not publish the index.

**Gate:** external readers can discover Trevra because customers publish useful market intelligence, not because Trevra injected an ad badge. **Met for account-watchlist Pulse and the explainable momentum Index.**

---

# Phase 12 — Format cloning

Build this after Trevra has its own performance data.

**Shipped for the founder's own published LinkedIn history:** Trevra now groups published posts by reusable structure, requires at least 3 examples before calling a recipe recommended, ranks recipes by commercial outcomes before reach, and exposes the sample size and outcome trail before the founder applies one. The reusable template stores structure + provenance only; reference wording is never persisted in the recipe.

Extract **structure**, not copied wording:

- hook type;
- sentence rhythm;
- section/paragraph density;
- bullet / numbered / narrative shape;
- number of evidence examples;
- CTA type;
- visual evidence-card layout.

`content_format_templates` stores the recipe, source-post provenance and measured performance. A cloned draft gets a distinct idempotency key, regenerates every claim from the current story evidence, and recreates a fresh evidence card when the learned visual structure used one. Story/card idempotency is revision-aware, so refreshed evidence creates new auditable proof instead of reopening stale copy or imagery.

Manual external inputs (pasted text, screenshot metadata or manually supplied example structure) remain future work and must obey the same structure-only/source constraints before being enabled.

**Gate:** the founder can apply a sufficiently-sampled proven structure to a new evidence-backed story without copying the reference wording or reusing its factual claims. **Met for own published LinkedIn history.**

This gives Trevra the useful part of DistribBuddy's "clone a winner" without becoming a plagiarism machine.

# Phase 13 — additional channels

Only after the channel-neutral content model and LinkedIn loop prove themselves.

**First bridge shipped:** Trevra already had a policy-aware `ChannelAdapter` registry for X, dev.to, Hashnode, Hacker News, Reddit, Bluesky, Mastodon, GitHub, Product Hunt, Indie Hackers, Lobsters, Instagram and LinkedIn. Do not create a second `ContentPublisherAdapter` abstraction. Evidence-backed content now feeds that existing registry through a copy-only preparation surface in the Posts editor.

For a provenance-linked saved story draft, Trevra:

- reads the current edited/saved post body;
- retains the ContentAsset / ContentOpportunity evidence as the critic anchor;
- applies each destination's existing length/link/tag/media policy;
- runs the existing copy critic on the adapted text;
- exposes warnings, revision instructions and the platform submit URL when one exists;
- never publishes from this reuse surface, even when the registry says the underlying platform has an API.

**First genuinely new destination shipped:** Medium. The adapter preserves a real article title, supports long-form links, points the founder to Medium's web editor, and stays `prepare-only` because Medium no longer issues new API integration tokens or allows new API integrations.

**Newsletter handoff shipped:** Beehiiv now has a concrete `prepare-only` adapter. Trevra preserves a real newsletter title/body, opens the Beehiiv app for handoff, and keeps the API path disabled because Beehiiv's Create Post API is restricted to Max and Enterprise publications.

**Short-form carousel shipped:** Trevra can turn one source-backed story into a separate revision-aware LinkedIn carousel draft: cover, up to five evidence slides, and a sources slide. Every slide is a deterministic 1080×1350 PNG generated from current evidence, and carousel performance can feed the same proven-format learner so successful carousel structure is reusable without copying historical claims or images.

**External scheduler draft handoff shipped:** Buffer is now a concrete connected integration. A provenance-linked saved story can target one workspace-owned Buffer channel, stop for exact-payload founder approval, and then create an unscheduled Buffer draft using `saveToDraft: true`. Trevra keeps a per-payload external-write ledger: confirmed replays are idempotent, while ambiguous transport outcomes are marked unknown and never blindly retried.

Still open as genuinely new destination work after the proven copy-only/channel-neutral bridge:

- company LinkedIn pages, once Trevra has an explicit company-page identity/configuration model;
- provider-specific publish + metric collection, which must use the normal approval/external-write boundary rather than this copy-only surface.

These are extension work, not blockers for the founder GTM/distribution loop.

**Gate:** one evidence-backed Trevra story can be safely reshaped for the existing channel registry from the editor without losing provenance or creating an external write. **Met.**

---

# API shape

Suggested endpoints, exact naming can follow current route conventions:

```text
GET    /api/content/opportunities
POST   /api/content/opportunities/discover
POST   /api/content/opportunities/:id/dismiss
POST   /api/content/opportunities/:id/drafts

GET    /api/content/assets/:id
PATCH  /api/content/assets/:id
POST   /api/content/assets/:id/render/linkedin
POST   /api/content/assets/:id/evidence-card

GET    /api/content/performance
GET    /api/content/assets/:id/performance

POST   /api/content/pulses
POST   /api/content/reports/:id/publish      # later phase
```

`render/linkedin` creates an ordinary `linkedin_posts` draft. It must not publish.

`render/linkedin` creates an ordinary `linkedin_posts` draft. It must not publish.

---

## Unit

- evidence ref loading for every source type;
- opportunity scorer + rationale reconciliation;
- fingerprint/dedupe;
- claim/evidence validation;
- inference-vs-fact critic;
- LinkedIn renderer;
- performance aggregation with minimum sample sizes;
- pulse statistics;
- public report redaction.

## PostgreSQL integration

- workspace isolation for all content tables;
- source deletion behavior does not silently orphan published claims;
- asset → LinkedIn post provenance;
- append-only metric snapshots;
- worker leases / duplicate prevention.

## End-to-end happy path

1. seed two independent account signals;
2. run opportunity discovery;
3. see one deterministic story;
4. draft variants;
5. choose one;
6. render to LinkedIn draft;
7. publish through existing worker fixture;
8. attach metric snapshots;
9. verify performance aggregation affects the next draft hints.

## Adversarial cases

- source fetch failed → no fake zero / no story;
- one weak signal only → no market claim;
- model invents a percentage → critic blocks;
- model mixes evidence between two companies → critic blocks;
- stale event → freshness warning/block according to policy;
- deleted/dismissed opportunity → no recurring duplicate;
- LinkedIn metrics unavailable → "unavailable", never `0`;
- low sample → no "best format" claim.

---

# What not to build in the first release

- generic image/video generation;
- TikTok/Instagram automation;
- broad multi-channel scheduler;
- complicated market taxonomy;
- arbitrary social listening duplication;
- a Canva-like editor;
- auto-publish without explicit user choice;
- a public leaderboard before score methodology is proven;
- "viral score" generated by an LLM;
- engagement pods / automated engagement;
- templates that reproduce other creators' wording.

These all increase surface area without strengthening the core loop.

---

# Shipping checkpoints

## Checkpoint A — one commercial decision, not three events

A recent first-party action from a Person at a hot Account becomes one `qualified_demand` recommendation with the inbound evidence and the account signals behind it. `Today` suppresses the duplicate raw inbound/hot-account cards.

If this is weak, stop. Content distribution will only create more disconnected events.

## Checkpoint B — founder next-best-action loop

`Today` reliably answers who deserves attention and why, including hot-account-to-person resolution and relationship state. Recommendations remain deterministic, source-backed and workspace-scoped.

## Checkpoint C — action and outcome attribution

A recommendation can be prepared into the appropriate outbound/reply path under the existing approval boundary, and the resulting conversation/meeting/opportunity remains attributable to the evidence that triggered it.

## Checkpoint D — distribution feeds demand

Selected market evidence flows into the existing LinkedIn post system; reactors/commenters can be resolved into canonical People and become person-intent evidence without being auto-enrolled into outreach.

## Checkpoint E — distribution learning closes

Published post metrics are observed reliably enough to compare formats/topics, while commercial analytics also report qualified people, conversations and opportunities rather than optimizing only for impressions.

Only now may Trevra claim it learns what distribution creates useful demand.

## Checkpoint F — compounding output

Market Pulse repeatedly produces useful fresh drafts from new observations.

## Checkpoint G — external loop

Public reports/indexes cause readers to visit Trevra/customer properties and can be attributed into the same demand graph.

Current status:

- [x] public report views are privacy-respecting client events, so crawlers and DNT/GPC readers are not silently counted;
- [x] the browser sends only the public report slug; Trevra resolves report/workspace ownership server-side;
- [x] report CTAs carry cross-origin-safe UTM lineage and same-origin session attribution;
- [x] Research reports readers, CTA clicks and attributed signup/demo conversions per public report;
- [x] the founder can snapshot an explicit http(s) customer-property CTA per public report; blank keeps the hosted Trevra CTA;
- [x] customer-property CTAs receive the same report UTM lineage automatically;
- [x] the existing signed generic capture preserves that lineage on identity-bearing demo/pricing/pilot requests;
- [x] Demand Graph resolves only a real same-workspace report slug and adds an `Originating public report` proof item to `qualified_demand`;
- [x] no anonymous report reader becomes a Person until an explicit identity-bearing capture occurs.

**Checkpoint G is met:** public intelligence can now create measurable anonymous acquisition and, after an explicit customer-property conversion, attributable canonical Person × Account demand without a parallel lead model.

---

# Recommended implementation order

Execute in this exact order:

1. Demand Candidate projection over existing canonical evidence;
2. `qualified_demand` recommendation + proof pack;
3. compound `Today` projection that suppresses duplicate raw events;
4. worker refresh of recommendations after evidence/account scoring;
5. hot Account → right existing Person → targeted person discovery when missing;
6. recommendation → prepared action → conversation/opportunity attribution;
7. content types + migrations + stores;
8. deterministic story opportunity builder;
9. `gtm.content-draft` + factual claim critic;
10. LinkedIn renderer + provenance into existing `linkedin_posts`;
11. Trevra-published post → post-engager harvest → Person-intent evidence;
12. LinkedIn feed-post metrics + commercial attribution analytics;
13. evidence cards and deterministic performance hints;
14. recurring Market Pulse;
15. public reports + attribution + index template;
16. format cloning;
17. additional publisher adapters.

The first founder-GTM release should stop after **step 6** if necessary. At that point Trevra already answers the core commercial question instead of merely surfacing events. Steps 7–11 turn market intelligence and distribution into another demand source. Steps 12–15 create the compounding and external acquisition loops.

---

# Core product sentence after this ships

> **Trevra watches your market and your inbound, tells you who is worth talking to now and why, then turns the same evidence into distribution that creates more qualified demand.**

That sentence remains true for cybersecurity, devtools, agencies, recruiting, fintech, vertical SaaS, ecommerce and other B2B markets without changing the underlying product model.
