# Community outreach

Find threads where people are complaining about what an AI coding agent costs
them, and reply with something useful — under an approval gate that cannot be
turned off with a config flag.

Ported from the Python reference at `tools/outreach/` in the `lemoncrow-dev`
tree. Nothing Python ships here; that tree was the specification.

> **Running it rather than changing it?** Read
> [`src/server/outreach/README.md`](../src/server/outreach/README.md) instead —
> the operator guide: setup, approving replies, the posting limits and the
> arithmetic behind them, manual handoffs, and troubleshooting. This page is the
> design record: what was built, and why each decision went the way it did.

---

## The flow

```
scout ──▶ score ──▶ guard ──▶ draft ──▶ APPROVAL ──▶ post
  │         │         │         │          │           │
8 platforms 0-10    7 caps   anti-slop  founder    API or
            scale   & limits  critic    signs       manual
                                        exact       handoff
                                        payload
```

Registered as the `gtm.community-outreach` playbook, which runs the whole chain
for **one** thread — the top-ranked one. One approval per reply is the right
granularity: a founder approves a specific comment on a specific thread, not a
batch.

---

## Skills

| Skill | Side effect | What it does |
|---|---|---|
| `gtm.scout-threads` | `network-read` | Polls eight platforms, returns only threads not already triaged |
| `gtm.score-threads` | `none` | Ranks threads 0–10, itemising every scoring component |
| `gtm.outreach-guard` | `none` | Runs seven posting limits and reports all of them |
| `gtm.draft-reply` | `none` | Writes the reply, shapes it to the platform, runs the anti-slop critic |

Posting is not a skill. It is the `community.reply` **action type**, reachable
only through the approval path.

---

## Why nothing posts unattended

The reference guarded posting with `dry_run: true` in `config.yaml` — one edit
away from `false`, and then it posts. Here it is structural, and there are
**three independent gates**:

**1. The approval must match the payload byte for byte.** `post-reply` is an
`action` step bound to `approve-reply`. The playbook engine recomputes
`canonicalPayloadHash(payload)` at execution time and refuses unless a
completed approval exists with that exact hash. Change one character of the
draft after approval and the action fails.

The safety verdict rides *inside* that payload as `metadata.safetyAllowed`, and
`publishCommunityReply` refuses to post unless it is exactly `true`. Because it
is covered by the approval hash it cannot be flipped after the fact, and a
hand-built action that skips the guard step fails closed rather than open.

**2. The channel adapter decides whether Trevra may press the button at all.**
`src/server/channels/adapters/*.ts` already encodes each platform's policy, and
`publishCommunityReply` reads it. Two separate questions are asked, and
conflating them would be a real bug:

- *Does policy permit unattended posting?* Reddit's API can comment — the
  reference did exactly that — and doing it unattended is what gets an account
  shadowbanned. Reddit is `prepare-only`.
- *Does a reply API exist at all?* dev.to is `api-publish` for **your own
  articles** and has no comment endpoint whatsoever.

Only **GitHub** and **Mastodon** pass both. Everything else becomes a manual
handoff: the approved text is written to the post log with the thread URL, and
you post it. That still consumes the daily cap and starts the cooldown, because
a human posting it costs the community exactly as much attention.

**3. Time-varying limits are re-checked at execution.** An approval is a
decision about *content*; the daily cap and the community cooldown are facts
about the *clock*, and the clock moves between the click and the call.
`assertPostingWindow` re-reads both before posting — for manual handoffs too,
since a human posting it consumes the same community attention.

### Retry cannot double-post

The payload hash is **claimed** (`status: 'pending'`) *before* the network call,
and the claim is covered by the partial unique index. Three outcomes:

| Outcome | Row | Retry |
|---|---|---|
| Platform accepted | `posted` | short-circuits |
| Platform **refused** (4xx) | `failed` | allowed — nothing was published |
| **No answer** (timeout, reset, unreadable body) | stays `pending` | **blocked** |
| **5xx** | stays `pending` | **blocked** |
| Post succeeded, recording it failed | stays `pending` | **blocked** |

Everything below the first two rows is the same judgement: *we do not know
whether the comment is live*. If the request landed and only the response was
lost, retrying puts a second comment on a stranger's thread. A missing comment
can be posted by hand; a duplicate cannot be unposted, and duplicate replies are
what get an account banned. So an unknown outcome holds the claim and the error
names the thread and the row to settle by hand.

Three consequences worth stating explicitly, because each is a place the naive
version leaks a duplicate:

- **A 5xx is not a refusal.** It comes from a gateway and does not prove the
  origin skipped the write. Only a 4xx is evidence that nothing was written.
- **The success is recorded outside the `try`.** If the `posted` update were
  reachable by the catch, a pool blip after a successful post would write
  `failed`, release the claim, and the next retry would comment again.
- **A retry that meets a held claim throws.** It does not report a manual
  handoff — that would resolve the step and send a human to post a reply that
  may already be public, trading a machine duplicate for a human one.

---

## The safety gate

Seven checks, in `src/server/outreach/safety.ts`. **Every one runs**, even after
one fails — the reference short-circuited, so an operator fixed one blocker only
to meet the next on the following run. `reason` still reports the first failure.

The playbook calls the guard with `requireAllowed: true`, which makes a blocked
verdict **throw** and fail the run before anything is drafted. That flag exists
because the engine's steps are an unconditional DAG: a verdict that is only
*reported* cannot stop the chain, so a blocked thread would still be drafted and
put in front of a founder — which is how a gate becomes decoration. Direct
callers leave it `false` and use the skill as a question.

| Check | Source |
|---|---|
| `blacklisted-community` | `safety.blacklisted_subreddits` |
| `blacklisted-keyword` | `safety.blacklisted_keywords` |
| `daily-cap` | `platforms.*.max_posts_per_day` |
| `account-age` | `platforms.*.min_account_age_days` — **declared but never enforced by the reference** |
| `account-karma` | `platforms.*.min_karma` — **same** |
| `community-cooldown` | `safety.min_hours_between_same_community` |
| `self-promo-ratio` | `safety.max_self_promo_ratio` |

Account age and karma come from `OUTREACH_ACCOUNT_PROFILES_JSON`. A platform
with a non-zero minimum and **no declared profile fails** — unproven standing is
not sufficient standing.

The daily cap is a **rolling 24-hour window**, not a calendar day. The
reference matched on today's date, which let a cap of 5 deliver 10 across a
midnight boundary — in an undefined timezone.

---

## State

PostgreSQL only — migration `013_outreach.sql`. No SQLite, no local files.

- **`outreach_threads`** — the discovery ledger. Keyed on
  `(workspace_id, platform, external_id)`, storing what the thread said when we
  first read it so an author's later edit is detectable, and refreshing score
  and comment counts on every re-poll so the scorer reads current numbers.

  **It is not an exclusion list.** A thread drops out of scouting when we have
  *replied* to it — a fact about `outreach_posts`. The reference excluded
  anything it had ever parsed, which breaks the moment discovery outruns
  replying: a run that finds 200 threads and replies to the best one would bury
  the other 199 forever and the next run would return nothing. Scoring is pure
  and cheap; replying is the irreversible act, so replying is what excludes.
- **`outreach_posts`** — the post log, and the claim ledger. A partial unique
  index on `(workspace_id, payload_hash) WHERE status <> 'failed'` is what makes
  a retried action a no-op instead of a second comment.
- **Cooldowns get no table.** "Have we posted into r/webdev in 48 hours" is a
  query against the post log; a second table storing the same fact is a second
  thing to keep correct.

All of it is workspace-scoped. The reference had one global SQLite file because
it ran on one laptop for one account.

---

## Platforms

| Platform | Discovery | Posting an approved reply |
|---|---|---|
| Hacker News | ✅ no credential | manual — HN has no write API |
| Lobsters | ✅ no credential | manual — no write API |
| GitHub | ✅ (`GITHUB_TOKEN` raises the limit) | ✅ **API** |
| dev.to | ✅ (`DEVTO_API_KEY` raises the limit) | manual — no comment endpoint |
| Stack Overflow | ✅ (`STACKEXCHANGE_KEY` raises the quota) | manual — write API omits answers |
| Reddit | 🔑 all four `REDDIT_*` | manual — self-promotion policy |
| Mastodon | 🔑 `MASTODON_ACCESS_TOKEN` | ✅ **API** |
| LinkedIn | ⛔ disabled by policy | ⛔ |

LinkedIn is registered and permanently disabled. UA §8.2 prohibits automated
access and scraping; every third-party "LinkedIn post search" API resells
scraped data, and the official Marketing Developer Platform exposes no post
search. There is no compliant implementation — it is a policy fact, not a
missing credential. Recorded in `scouts/linkedin.ts` on the same principle as
`WITHHELD_PROVIDERS` in `research/registry.ts`.

---

## Adding a platform

One file in `src/server/outreach/scouts/`, one entry in `registry.ts`. Nothing
else needs to know it exists — the skill, the playbook, and the tests are all
driven off `listScouts()`.

---

## Notable divergences from the reference

| | Reference | Here | Why |
|---|---|---|---|
| Clock | `datetime.now(UTC)` inside `score()` | injected `now` | A score in the ledger has to be re-derivable from its inputs |
| Variant choice | `random.choice(examples)` | hash of the thread id | The text approved must be the text regenerated — otherwise the payload hash means nothing |
| Product claims | hardcoded name, URL, six benchmark numbers | a required `product` input | They are the operator's claims to stand behind, and they appear verbatim in the approval payload |
| Copy quality | no gate | `skills/voice.ts` critic | A forum is a worse place for slop than an inbox — permanent, attributable, downvoted |
| Dedup | per-scout, local SQLite, marked at parse | once, in Postgres, marked on return | Eight copies of one correct implementation |
| Failure | one bad API failed the run | per-platform warning | Seven platforms already did useful work |
| HTTP | `httpx` per scout | `createSsrfFetch` + `probe` constants | Redirect-revalidating SSRF guard, shared timeout and User-Agent |

---

## Running it

```ts
await startPlaybookRun(db, {
  workspaceId,
  playbookId: 'gtm.community-outreach',
  actorType: 'user',
  actorId: userId,
  payload: {
    platforms: ['hackernews', 'github'],
    minScore: 6,
    product: {
      name: 'Your tool',
      url: 'https://example.com',
      summary: 'One line on what it does.',
      mechanism: 'One sentence on WHY it is cheaper — not that it is.',
      claims: [{ label: 'SWE-bench cost', value: '29.5% lower' }]
    }
  }
});
```

The run stops at `waiting_approval`. Approve it and the action executes; reject
it and nothing happens.

`minScore` really filters: the playbook reads `score.output.repliable.0`, which
contains only threads that cleared the floor. A run where **nothing qualified**
fails at `guard` with `thread: Required`, as does a run that discovered nothing
at all — the engine's steps are an unconditional DAG, so there is no "skip the
rest" branch. A failed run is the safer of the two available answers; a nicer
one means a conditional step type, which is a change to the playbook engine
rather than to this port.

Credentials: see `.env.marketing.example`.
