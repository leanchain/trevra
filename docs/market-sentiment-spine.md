# Market news + sentiment on the Trevra spine

How I would build it, given you already own price/market data and only need the
text side: harvest → dedupe → map to symbols → score → hand over, point-in-time.

The whole design has one non-negotiable: **the corpus must be replayable as of
any past instant.** Everything below follows from that.

---

## 1. Sources split into two tiers, and they are not equally worth building

**Tier A — open feeds. No credential, no browser, runs in the container.**
SEC EDGAR filing ATOM + full-text search, Fed / ECB / BoE / BoJ press RSS,
company IR feeds, exchange notices, Reuters/AP/FT syndicated RSS.
Boring, legal, machine-readable, timestamped by the issuer, and nobody can
revoke them. This is where the signal actually is.

Fetch them through the existing `src/server/skills/guard.ts` (`validateHost`)
so SSRF and redirect-to-internal stay covered for free.

**Tier B — gated social. Needs the signed-in headed browser on your machine.**
r/wallstreetbets, r/stocks, r/algotrading, X, StockTwits. High volume, low
information density, and the surface breaks every few months — I just lived
that with Reddit twice in one session.

Build Tier A first and completely. Tier B is a *later* module, not a v1
dependency, because its failure mode is a dead account rather than a stale row.

Providers register exactly like `src/server/research/registry.ts` and
`src/server/outreach/registry.ts` do today: a `Map` keyed by source id, each
provider declaring its own `availability(credentials)`. Per-source failure
degrades that source only — copy the boundary in `outreach/scout.ts`, where one
rate-limited platform never discards the seven that already worked.

---

## 2. Storage: append-only, as-of everything

New migration (next free number). Four tables, all insert-only.

```sql
-- The document, exactly as first seen.
market_documents(
  id, workspace_id, source_key, external_id, url,
  title, body, author,
  published_at,      -- what the issuer claims (UTC)
  first_seen_at,     -- when WE could first have acted on it   <-- backtests use this
  content_hash,      -- sha256 of normalised body
  retrieved_at
)
UNIQUE (source_key, external_id)          -- dedupe within a source

-- Silent edits are the norm on both news wires and Reddit. Keep them.
market_document_revisions(id, document_id, content_hash, body, seen_at)

-- One article touches many symbols. Never a `ticker` column on the document.
market_document_entities(document_id, symbol, mic, confidence, method)

-- Re-scoring must never destroy what you knew at the time.
market_sentiment_scores(document_id, model_id, model_version, label, score, scored_at)
```

**Rules that make it replayable:**

- Nothing is ever `UPDATE`d in place. A changed body is a new revision row; a
  re-scored document is a new score row.
- Backtests filter `first_seen_at <= t`, **not** `published_at <= t`. A filing
  timestamped 16:01 that your harvester saw at 16:44 was not tradeable at 16:02.
- A score joins as `scored_at <= t` too, or you have leaked a model you had not
  trained yet into 2023.
- `first_seen_at` is set once, on insert, and is immutable. Fetch time is not
  it; a re-fetch must not move it forward.

That is the whole point-in-time story, and it costs nothing to get right on day
one and is unrecoverable if you get it wrong.

---

## 3. Skills — this part is free

Each unit is a `Skill` under the existing contract in
`src/server/skills/types.ts`, so it gets ledger rows in `skill_runs`, typed
zod I/O, an evidence array with `sourceUrl`, and MCP exposure with no extra work.

| id | sideEffect | does |
|---|---|---|
| `mkt.harvest-feeds` | `network-read` | pull registered Tier-A sources, insert new documents + revisions, report per-source availability and warnings |
| `mkt.map-entities` | `none` | resolve symbols from title/body against a symbol table; deterministic, fixture-testable |
| `mkt.score-sentiment` | `none` | write a versioned score row per (document, model) |
| `mkt.digest` | `none` | roll a time window into a cited narrative brief — same shape as `gtm.research-brief` |

`SkillRetention` already exists on the output: any licensed wire gets
`retention: 'none'`, which keeps the ledger row (who ran what, when) and drops
the payload. That is your terms-of-service compliance seam, already built.

Chain them with `registerPlaybook` (`src/server/playbooks/registry.ts`) into a
`market.sweep` playbook, ticked by `src/worker/index.ts`. Harvest every 5–15
min; map and score on what harvest actually inserted, not on the whole table.

---

## 4. Handing it to your pipeline

Do **not** have your trading pipeline read these tables directly — that couples
it to my schema. Two clean seams:

1. **MCP read tools** — `trevra_market_documents(as_of, symbols[], since)` and
   `trevra_market_sentiment(as_of, symbols[])`, alongside the existing
   `mcp__trevra__*` surface. `as_of` is required, not optional; a missing
   `as_of` is the bug that produces a beautiful, fake backtest.
2. **A materialised view** keyed `(symbol, bucket_start, model_version)` with
   counts and mean/median score per bucket, refreshed after each sweep. Your
   pipeline joins that on symbol + time and never sees a document.

---

## 5. Tier B, when you get to it

Identical to the LinkedIn seat-detect queue in
`migrations/027_linkedin_seat_detect_requests.sql`:

- `market_read_requests(id, workspace_id, source_key, target, status, claimed_at, …)`
- partial unique index on `status='pending'` → pressing the button five times
  queues one request, enforced by the database, not by route code
- the claim is **reclaimable** (timestamped, stale-after-N-minutes), because
  these are pure reads — re-running one duplicates nothing
- the container writes requests; a `market:worker` on your machine probes
  readiness *before* its first claim, so the display-less container can never
  steal a request it cannot fulfil
- reuses `src/server/browser/local.ts`, which is already platform-neutral

The container's IP gets blocked and yours does not. That is not a bug to fix,
it is the reason the queue exists.

---

## 6. Traps, in the order they will bite you

1. **Syndication inflation.** One Reuters story appears on 40 sites. Without
   near-duplicate collapse (content hash, then title shingle / minhash) your
   "mention volume" feature is measuring the syndication network, not the market.
   This is the single most common way a news-sentiment feature looks predictive
   and is not.
2. **Silent edits.** Headlines get rewritten after the fact, often to match what
   happened. If you only keep the latest body you have imported hindsight.
   Revisions table, always.
3. **Ticker ambiguity.** `$ANY`, `IT`, `ALL`, `ON`, `DD`, `GO` are real symbols
   and real English. Require a cashtag, a company-name match, or an exchange
   qualifier; store `method` and `confidence` so you can tighten the threshold
   later without re-harvesting.
4. **Selection bias in social.** Deleted and privated posts vanish. Store on
   first sight and never re-fetch to "confirm" — re-fetching quietly rebuilds
   the corpus as survivors only.
5. **Market calendar vs UTC.** `published_at` is UTC; "before the open" is
   exchange-local and holiday-aware. Keep both, derive the second.
6. **Model drift.** Pin `model_version` on every score row. A prompt tweak is a
   new version — otherwise your 2024 scores are a blend of two models and every
   result is unreproducible.
7. **Latency honesty.** Measure and store `first_seen_at - published_at` per
   source. If your median is 4 minutes, no strategy with a 2-minute horizon is
   testable on this data, and you want to know that before, not after.

---

## 7. Build order

1. Migration + document store + dedupe + revisions. No sources. Fixture-tested.
2. Two Tier-A sources: SEC EDGAR ATOM and one central-bank RSS. Zero terms
   risk, zero credentials, highest signal-per-line in the whole plan.
3. `mkt.harvest-feeds` + `market.sweep` playbook + worker tick.
4. Entity mapping + the as-of MCP tool. **Usable by your pipeline here** —
   raw, cited, point-in-time text keyed by symbol, no sentiment yet.
5. Versioned sentiment scoring + the bucketed view.
6. Tier B queue + local worker, last.

Steps 1–4 are the product. 5 is an opinion you can swap. 6 is optional and is
the only part that can get an account banned.

---

## 8. One structural caveat

Trevra is a go-to-market product. This is a different product on the same
chassis — skills, playbooks, ledger, host guard, browser worker. That reuse is
real and worth a lot, but keep it in its own `src/server/market/` module behind
a config flag, importing the spine and never the GTM domain. Then it lifts out
into its own repo the day it deserves to, instead of being surgically extracted
from a lead pipeline.
