# First run: signed up → qualified leads

Companion to `docs/lead-spine.md`, which says *why* the pieces don't join today.
This one says what the operator does, screen by screen, and what each step calls.

Design rule for every step below: **the operator supplies context, never
mechanics.** No URL construction, no facet ids, no "pick a provider". If a step
can be derived, it is derived and shown for correction rather than asked for.

## The journey, four steps, one funnel

### Step 0 — Sign up (exists)
Email + workspace. Nothing else. No connector, no key, no LinkedIn seat. The
first screen after signup is Step 1, not a dashboard.

### Step 1 — "Who do you sell to?" (one fork, both doors converge)

**Door A — no list.** One field: *your* website URL. We read the homepage and
pricing page (`gtm.watch-signal`'s existing readers, `src/server/skills/signal.ts:184`)
and propose an ICP in plain words: what you sell, to which vertical, at which
size. Shown as an editable sentence, not a form:

> "Companies in **developer tooling**, **20–200 people**, that publish an
> engineering blog and are hiring **platform engineers**."

Edit the bold parts, confirm. That sentence becomes `gtm.source-leads`’ request
(`keywords`, `vertical`, `countries` — `src/server/research/source.ts:47`) and
returns `CandidateCompany[]`.

**Door B — has a list (Guido).** Drop a CSV, or paste domains one per line. No
column mapping UI: sniff `domain`/`company`/`website` headers, show the first
three rows parsed, accept. 500 rows is the whole ask.

Both doors write the same rows into **`accounts`** — the table that does not
exist yet and that everything downstream needs (`docs/lead-spine.md` §3.1).
Door A's rows carry `source='sourced'`, Door B's `source='csv'`.

### Step 2 — "What counts as a good moment?" (defaulted, skippable)

Three toggles, all on by default, each one signal we can already read:

| Toggle | What it reads today |
| --- | --- |
| They're hiring for it | careers page diff → `hiring-up` (`signal.ts:350`) |
| They changed their pitch or pricing | homepage/pricing diff → `headline-changed`, `pricing-changed` |
| They're talking about it in public | `gtm.scout-threads` over hn, reddit, github, dev.to, lobsters, SO, mastodon |

One slider under them: **how strict** — "any one signal" → "two or more in 30
days". Default: two or more. That default *is* Guido's point about layering,
and it is the only place the strictness is expressed.

"Skip, use sensible defaults" is a first-class button. A user who presses it
never sees this screen again and still gets a correct product.

### Step 3 — The sweep runs, and the operator can leave

We queue a paced signal pass over every account and say so honestly:

> "Reading 500 sites at a paced gap. First results in a few minutes, all of them
> within the hour. You can close this — we'll email you when the first ten land."

This is the existing worker cycle (`src/worker/index.ts:37`) gaining a signal
pass; no new runtime. The screen streams accounts in as they resolve, so the
page is never a spinner.

### Step 4 — The payoff screen: a ranked list with its evidence attached

One list, sorted by score. Each row is one account and reads as a sentence, not
a record:

> **Kestrel Data** · score 87
> Posted 3 platform-engineering roles this week, and their pricing page dropped
> the "Enterprise" tier on 2 Aug. Two signals, both inside 9 days.
> [ Why this score ] [ Draft the opener ] [ Not a fit ]

- **Why this score** expands into the raw signals with their evidence URLs.
  Nothing is asserted without a link to what we read.
- **Draft the opener** runs `gtm.research-brief` + `gtm.outreach-draft` for that
  one account, lands in approvals — unchanged from today, except the input is an
  account rather than a typed audience string.
- **Not a fit** is training data: it down-weights that signal shape and is the
  cheapest honest feedback loop we have.

That screen is the "boom". Everything before it is four questions, two of which
have defaults.

## What this journey deliberately does NOT do

- **No LinkedIn in the first run.** It is opt-in, self-host-only, and legally a
  different act (`linkedin/leads.ts:100`). It appears later as *one more source
  that imports into accounts*, never as the front door. Today it is the front
  door, and that is the single biggest reason the flow feels hard.
- **No connectors, no API keys at signup.** `source-leads` falls back to the
  `seed` provider without credentials; Exa improves results, it does not gate
  them (`research/registry.ts`).
- **No empty dashboard.** There is no state in this journey where the operator
  sees a screen with nothing on it and no obvious next click.

## Build order (each step ships usable on its own)

1. `accounts` + `account_signals` tables and the CSV/paste import — Door B alone
   is already a product for Guido.
2. Signal pass on the worker cycle, writing `account_signals`. Step 3 + 4 become
   real with no new UI beyond one list.
3. Scoring over co-occurring signals in a window (`gtm.score-lead` reading the
   account's rows) + the "why this score" expansion.
4. Door A: site → ICP sentence → `source-leads` → accounts.
5. "Draft the opener" wiring account → `research-brief` → `outreach-draft` →
   approvals.
6. LinkedIn walk demoted to an importer into `accounts`.
