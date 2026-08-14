# The lead spine that isn't there

Written after the 1:15–1:33 call (Guido on data, signals, GTM). Two parts: what the
code actually joins today, and what the call says the spine should be.

## 1. Your question, answered from the code

**Does the plan take anything from a lead source? No.** Verified end to end:

| Piece | Reads from | Writes to |
| --- | --- | --- |
| `linkedin_leads` (migrations/030) | the LinkedIn walk | nothing downstream reads it server-side |
| `gtm.source-leads` (`src/server/research/source.ts:47`) | a free-text ICP query to a provider | returns `CandidateCompany[]` to the caller, stored nowhere |
| `gtm.channel-plan` (`src/server/channels/plan.ts:182`) | caller-supplied `audience: string[]` — free-form tags | a plan object |
| LinkedIn campaign targets (`src/server/app.ts:2049`) | CSV upload, 500 cap | `linkedin_actions` |
| `gtm.watch-signal` (`src/server/skills/signal.ts:350`) | the target's own site: careers, pricing, homepage | a standalone skill result, attached to no entity |
| `gtm.scout-threads` (`src/server/outreach/scout.ts`) | devto, github, hn, lobsters, mastodon, reddit, SO | a standalone skill result |

The only join that exists is client-side: `sendToBuilder` in `LinkedInLeads.tsx`
stages picked profile URLs into the campaign builder's targets textarea
(`stageTargets`, `LinkedInSafety.tsx:172`). That is a clipboard with extra steps.

Neither `watch-signal` nor `scout-threads` runs on the worker loop —
`automation-service.ts:runAutomationCycle` only drains scheduled actions and
automation rules. Both signal skills are manual/MCP-triggered only.

**There is no account or ICP table anywhere in migrations 001–038.** So Guido's
"here are 500 accounts to track" has nowhere to land. That is the actual hole,
and it is why every screen feels like a disconnected errand: there is no noun
the screens are all about.

## 2. What the call says

- Data quality first; **funding is a bad trigger** — noisy, late, and every rep
  chases the same event. We have no funding trigger, which turns out to be fine.
- **Layer signals**: hiring + site change + public commentary, combined, to infer
  intent *before* it pops. Relevance beats volume. Our `watch-signal` diffs are
  exactly this shape (hiring-up, pricing-changed, tech-added) but fire once, by
  hand, on one URL you type.
- **Real-time alerts on a known account list** beat broad discovery. Guido will
  hand over ~500 accounts. He does not want a search tool.
- **Setup must be near-zero.** Paste/import a list, get alerts. Our current front
  door asks the operator to construct a LinkedIn search URL.
- Distribution via his marketing-consultant network on a referral cut.

## 3. What follows from both halves

The spine is **account → signals → score → alert → outreach**, and today we have
the two ends and none of the middle.

1. **`accounts` table + import** — name, domain, optional LinkedIn URL, owner,
   tags, `source` (csv | sourced | lead-walk). One CSV/paste import, 500 rows.
   This is the missing noun; nothing else can be built cleanly without it.
2. **`account_signals`** — one row per observed change, `(account_id, kind,
   observed_at, evidence_url, payload)`. `watch-signal` writes here instead of
   returning into the void. Dedupe on (account, kind, fingerprint).
3. **Put the signal sweep on the worker cycle** — `runAutomationCycle` gains a
   signal pass over accounts due for a re-check, paced. This is the whole
   "real-time" ask, and it is a scheduler change, not new science.
4. **Score = combination, not event.** `score-lead` takes the account's signals
   in a window and weights co-occurrence (hiring + pricing change + a thread
   mention > any one alone). Guido's point about layering, encoded as weights.
5. **Alert + one-click plan.** A scored account crossing threshold becomes a
   pending recommendation; `channel-plan` takes an `accountIds[]` instead of
   typed audience tags, and campaign targets come from an account selection
   rather than a CSV.
6. **Demote LinkedIn walking to a source, not the front door.** A lead walk
   *imports into accounts* like every other source. `/outreach/leads` stops
   being where lead generation begins.

Order matters: 1 and 2 unblock everything, 3 makes it a product rather than a
report, 4–5 are where Guido's "relevance beats automation" actually lands.
