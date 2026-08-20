# The core — what Trevra must have, and nothing else

Written after the GTM call, against the research in
[swan-parity.md](./swan-parity.md) and
[competitive-landscape.md](./competitive-landscape.md). Those two documents
answer "what does the market have". This one answers the only question that
matters: **what must work, properly, for the work to actually get done.**

The premise: building is cheap, making it right is not, and every extra feature
spends the expensive thing on the cheap one. The parity list is therefore mostly
a list of things to _not_ build.

---

## 1. What the call actually specified

Stripped of politeness, the requirement from the GTM side was narrow and
unusually clear:

| Said                                                                     | Means                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Data quality is primary                                                  | Precision beats coverage. A wrong alert is worse than no alert.                                      |
| Funding triggers are noisy, crowded, late                                | **Do not build the signal everyone else sells.** By the time it fires, twenty reps are in the inbox. |
| Signals from posts and comments show real intent                         | Public commentary is the source that isn't commoditised.                                             |
| Layer hiring + site changes + public commentary                          | **A single signal is noise. A combination is an intent.** This is the product.                       |
| Early detection is critical — once a signal pops, the opportunity decays | Latency is a feature, not an optimisation.                                                           |
| Extremely simple, low friction, works with existing account lists        | Setup is a CSV, not an onboarding project.                                                           |
| 500 target accounts to track                                             | The unit of work is **an account watchlist**, not a lead database.                                   |
| Real-time alerts for early signals over broad coverage                   | Depth on 500 beats breadth on 50,000.                                                                |
| Public feeds + paid local data (trade registries)                        | Source adapters, bring-your-own key. Big vendors skip painful local markets — that is the edge.      |

Note what is absent: no sequences, no credits, no CRM sync, no visitor
deanonymisation, no AI SDR. The people who will use this asked for none of it.

---

## 2. The one job

> **Watch a list of accounts I chose, tell me the moment several independent
> things line up into an intent worth acting on, and show me the evidence.**

Everything below either serves that sentence or gets cut.

---

## 3. The six things that must exist

For each: what it is, and — the expensive part — **what "works properly" means.**

### 3.1 A watchlist

Import 500 accounts from a CSV or a Sheet in one paste. Domain is the key.
Resolve, dedupe, and keep them.

**Works properly when:** 500 rows in under a minute, no manual field mapping, no
row silently dropped, and every account resolves to something checkable.
Today's `clients` table plus the marketplace CSV importer is 80% of this.

### 3.2 Collectors that do not lie

Per account, on a schedule: public commentary (GitHub, HN, Reddit, Lobsters,
dev.to, Mastodon, Stack Exchange — **all seven already exist as scouts**), site
change diffs, hiring/careers page diffs, and one pluggable slot for paid local
sources (a national trade register, an industry feed).

**Works properly when:** every observation carries a **source URL and a
timestamp**, nothing is inferred without one, a collector that fails says so
rather than returning empty, and rate limits are respected so it still works on
day 200. This is the entire quality burden of the product and it is where the
time should go.

### 3.3 Composite intent rules

The actual invention. Not "account did X" but **"account did X and Y within N
days, and Z is also true"**. Guido's example: hiring a platform engineer +
language change on the pricing page + a CTO comment on an open-source thread →
_evaluating a move to open source_.

Defined per workspace, in the customer's own words, with a window and a
threshold. A handful of them, curated, not a rule-builder IDE.

**Works properly when:** a rule can be stated in one sentence, dry-run against
the last 90 days of collected history before it goes live, and **its precision
is measurable** — alerts sent versus alerts acted on. A rule nobody acts on gets
retired. Trevra does not have this today; it is the one genuinely new build.

### 3.4 The alert, with its evidence

Slack or email, within minutes of the last contributing observation. One
paragraph: the account, the intent, the three things that fired it, each a
clickable link with a date, and how confident and why.

**Works properly when:** the recipient can decide in fifteen seconds without
opening the app, and can always answer "why did this fire" without asking us.
Evidence is not an appendix — it _is_ the alert.

### 3.5 The touch — and yes, Trevra sends it

**Decision: replace Dripify.** It costs $39–79/user/mo, it cannot do the two
things this product needs most, and — the part that matters — **we already built
the replacement and forgot to wire it up.**

#### Why replacing it is the right call, not just the cheaper one

Dripify is a hard ceiling on exactly the thing §3.3 makes the product:

| Dripify cannot                                                                                                                                               | Trevra can, today, in code that exists                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Personalise per lead — **no custom CSV variables**, only ~17 built-in tokens, still "In Development"                                                         | Draft a message per target citing the actual signal that fired                                      |
| Evaluate a branch we defined — an export can never resolve `if accepted → X`, which is why `conditionInstruction()` exists as a written apology to the human | `branching.ts` evaluates `accepted / replied / not_accepted / not_replied` against real inbox state |
| Tell us what happened without a webhook config per trigger per campaign, on a Pro plan, carrying no message content                                          | Record the outcome as the action executes — no webhook, no form, no self-reporting                  |
| Smooth variance across days, ramp from account age, throttle on acceptance rate                                                                              | All three, shipped, in `limits.ts`, every constant confidence-tagged                                |

The self-reported outcome loop is the defect that makes §6's act-on rate
unmeasurable. Sending it ourselves doesn't just save the subscription — it is
the only path where the KPI is real.

#### What is actually missing

Almost nothing, and this is the surprising part.
[linkedin-outreach-plan.md](./linkedin-outreach-plan.md) Phase 4 — the local
Playwright worker — was specified, sanctioned and **built**. `driver.ts` has the
routines. `local-worker.ts` lists invite and dm in `EXECUTABLE_KINDS`. The safety
gate re-runs per action immediately before execution. Inbox sync, branch
evaluation, invite withdrawal and outcome recording are all shipped.

The gap is one missing writer. Only three things ever insert into
`linkedin_actions`: the exporter (status `exported`), the engagement queue
(follow/like/endorse only, and invite/dm are explicitly refused at the route),
and inbox replies. **No API path queues an invite or a DM as `planned`**, so the
worker that could execute them never sees one. That is the build.

| To replace Dripify                                                      | Effort                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Queue invite + dm from an approved campaign — the missing writer        | small                                                                   |
| Verify every driver selector against a live account, and keep verifying | **the real cost — see below**                                           |
| Lead import from a search URL or a post's engagers                      | skip for now — Guido brings a CSV of 500                                |
| Keep the exporter                                                       | free, and it is the migration path for anyone already paying for a tool |

#### The honest cost, stated once

1. **Selector rot is the treadmill.** LinkedIn changes its DOM whenever it likes.
   A browser-driving product is a maintenance commitment, not a feature you
   finish — and it is genuinely most of what $59/mo buys from Dripify. This is
   the one place where "building is cheap, quality is not" bites hardest. Budget
   for it deliberately or don't start.
2. **ToS exposure does not disappear — it relocates.** User Agreement §8.2 names
   browser plugins and add-ons by category; Dripify is in scope of it and so is
   a Playwright driver. The recorded posture that makes this defensible is
   [linkedin-outreach-plan.md](./linkedin-outreach-plan.md) §3.1 and §4.2: the
   **operator** runs the worker, on **their own machine**, against **their own
   logged-in Chrome profile**, and Trevra holds no credentials and never touches
   LinkedIn. That is a materially different position from shipping an extension
   or proxying a cookie session through a datacenter — and it is also _safer for
   the account_, because a real browser on a real residential IP is not the
   fingerprint enforcement looks for.
3. **The account risk is the operator's, and the UI must say so** in the same
   breath as it shows a REPORTED limit. That rule is already written down.
4. **Hosted mode still refuses, and that is the one unresolved thing.**
   `config.ts` blocks all LinkedIn automation when
   `TREVRA_DEPLOYMENT_MODE=hosted`, in three places, with a loud startup failure.
   Self-hosting yourself: fine today. **Selling a managed hosted product: not
   fine today**, and lifting the gate would put Trevra's own infrastructure in
   §8.2's crosshairs and make us the automation operator. The answer that keeps
   both halves is **hosted brain, local hands** — a signed companion the customer
   runs, driven by the hosted control plane, executing only what a human already
   approved. That is the same worker with a different transport, and it is a
   better story than any cloud sender can tell: _we never hold your session, so
   we cannot get you banned._

#### The shape, then

Signal fires → Trevra drafts a message citing the evidence → human approves the
exact payload → the local worker sends it, paced by `limits.ts` → the outcome
records itself → the branch resolves against real inbox state → the act-on rate
in §6 is a measured number rather than a hope.

**Works properly when:** no message leaves without a human signature on the exact
payload; every send is paced by the engine rather than a loop; every outcome is
observed rather than reported; and a selector break surfaces as a loud failure,
never as an account that silently looks quiet.

**Volume is still not the goal.** The ceiling is the pacing engine's, not
Dripify's, and the success case remains a handful of relevant touches a week.

Already built, already the best thing in the repo. Every collection, every rule
evaluation, every alert, every send — inspectable, with evidence, exportable.

**Works properly when:** it is how _we_ debug a bad alert, not just how a
customer audits one. If the ledger cannot explain a false positive, the ledger
is incomplete.

---

## 4. What that means for the code

| Need                                        | State today                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Account watchlist from CSV                  | ~80% — `clients` + marketplace importer, needs a domain-first path                                                                      |
| Seven commentary collectors                 | **shipped** — `outreach/scouts/*`, real API calls                                                                                       |
| Site + tech fingerprint                     | **shipped** — `gtm.enrich-company`, but fingerprints once, never diffs                                                                  |
| Change detection over time                  | partial — `gtm.watch-signal` is snapshot-diff, per-domain, no upsert                                                                    |
| Hiring/careers watcher                      | absent — small; a careers-page diff, not a jobs data vendor                                                                             |
| Paid local source adapter                   | absent — needs the same shape as a scout, BYO key                                                                                       |
| **Composite rules across signals and time** | **absent — the build**                                                                                                                  |
| Real-time alerting                          | absent — polling exists (60s worker), no Slack, no alert object                                                                         |
| Approved draft + send                       | **shipped** — `gtm.outreach-draft`, approval path, Gmail/Graph                                                                          |
| Dripify/HeyReach/Expandi CSV export         | **removed** — the legacy campaign system it shipped under is gone; the managed system (`linkedin/managed-campaigns.ts`) does not export |
| **Outcome webhook ingest from Dripify**     | **absent — the second build.** Today outcomes are operator-reported via `POST /api/linkedin/actions/outcome`                            |
| Ledger + evidence + export                  | **shipped**                                                                                                                             |

One honest constraint: everything runs on a single 60-second `setInterval` and
`domain_events` has no subscribers. "Within minutes" is reachable on that; true
real-time is not, and does not need to be.

---

## 5. What gets cut

Not "later". Cut.

- **Campaign machinery that duplicates a tool we are replacing.** Sending stays
  (§3.5) — what goes is everything around it that exists because the sending
  used to happen elsewhere: A/B spintax, multi-variant campaign builders,
  agency-shaped campaign management, analytics dashboards beyond the one funnel
  the KPI needs. The engine we keep is narrow: queue → pace → guard → send →
  observe. Keep the exporter too — it costs nothing and it is the migration path
  for anyone already paying for a tool.
- **Enrichment waterfalls, contact discovery, lookalikes.** Guido brings the
  accounts. We watch them. Buying a contact database is a different company.
- **Visitor deanonymisation, CRM record writes, credits, multi-seat,
  prompt→workflow authoring, the six Swan plays.** All of it. See
  [swan-parity.md](./swan-parity.md) §7.
- **Funding, leadership-change and other single-event triggers.** Explicitly
  rejected on the call, and correctly — crowded and late.
- **Broad coverage.** 500 accounts deeply is the product. 50,000 shallowly is
  the thing that already exists and doesn't work.

### The uncomfortable one

**Trevra currently contains two products.** The signal watchlist above, and the
revenue graph — contract → scope → milestone → deliverable → invoice, with its
four recommendation detectors and its approval queue. The second one is
genuinely uncontested (§3.7 of the landscape doc: nobody models the delivery
half) and it is also **not what the call was about**, not what the 500 accounts
need, and not what an open-source release would be adopted for.

Two products at the quality bar this document demands is exactly the thing that
cannot be afforded. **Decided 2026-08-05: the money half is frozen** — keep it
working, stop extending it, ship nothing new there — and everything goes into the
watchlist. It is a reversible decision and the code does not rot. Note also that
`invoice.create` currently throws in any deployment that hasn't hand-authored
the missing Nango action scripts, so "frozen" is closer to today's reality than
"shipped" is.

If that is wrong — if the delivery graph is the business and the watchlist is
the marketing tool for it — that is a fine answer too, but it has to be _the_
answer, said once, and then the other half stops getting attention.

---

## 6. What decides whether it works

These are the risks, and they are all quality risks rather than feature risks:

1. **Precision.** If one alert in three is junk, Guido stops reading them in
   week two and the product is dead. Instrument it from day one: alerts sent,
   alerts acted on, per rule. That ratio is the only KPI.
2. **Freshness.** A signal found four days late is a signal someone else already
   acted on. Measure time-from-event-to-alert and publish it to ourselves.
3. **Rate limits and ToS.** 500 accounts × 7 sources × daily is real traffic
   against APIs with real limits, several of which forbid what a careless
   implementation would do. Budget per source, back off, and record refusals as
   refusals.
4. **Source coverage honesty.** If a collector found nothing because it broke,
   the account must not read as quiet. Silent failure is the failure mode that
   makes the whole thing untrustworthy.
5. **The rule vocabulary.** Too rigid and it cannot express the intent Guido
   cares about; too free and it becomes the workflow builder we just refused.
   Start with a fixed grammar over collected observation types and widen only on
   evidence.

---

## 7. The first milestone

One sentence, testable:

> **Guido's 500 accounts loaded, one intent rule live, alerts landing in Slack
> with evidence, the first approved touches sent by Trevra itself, and a
> measured act-on rate after four weeks.**

That is the whole scope. Nothing in §5 is needed to reach it. If the act-on rate
is good, this is a product — open source it, host it, and the referral network
from the call has something real to distribute. If it is bad, we learned the
expensive thing cheaply, and no time went into sequences, credits or a CRM sync
that would have been wasted anyway.

---

## 8. What is left to build

Two tracks. **Track W** (watch → rule → alert) is strictly sequential — each
step needs the one before it. **Track L** (LinkedIn) is independent and can run
alongside. Do §8.0 first because it is hours, not days.

### 8.0 Stop the product from lying — first, cheap

- `invoice.create` and `change_order.create` call Nango action scripts
  (`trevra-create-invoice`, `trevra-create-change-order`) **that do not exist in
  this repo** — they throw in any deployment that hasn't hand-authored them.
  The money half is frozen (§8 decision 1), so mark them unavailable rather than
  pretending they work.
- Google Calendar connects, syncs, and **drops every record** — there is no
  `meeting` canonical kind, so `normalizeNangoRecord` returns null.
- `EXA_API_KEY` is undocumented and disconnected from the Nango `exa` catalog
  entry, so connecting Exa in the UI does not enable it.

### Track W

**W1 — The watchlist.** A domain-keyed watched-account table and a paste-a-CSV
import for 500 rows. Deliberately **not** `clients`: a watched account is not a
customer, and overloading a 10-column index that exists for ranking revenue is
how both concepts get worse. _Decision needed: new table (recommended) vs. a
flag on `clients`._

**W2 — Observations.** The substrate everything else reads: one append-only row
per thing seen — account, source, kind, URL, observed-at, payload, hash. Nothing
without a URL and a timestamp ever becomes a row.

**W3 — Collectors that fill it.** The seven scouts exist but they are _thread_
scouts — they score public threads for reply opportunities, keyed to topics, not
to accounts. **Repointing them to "what did this account's people do" is real
work, not a config change.** Plus: a periodic site diff (`gtm.enrich-company`
fingerprints once and never compares), and a careers-page diff. The paid local
source adapter (trade register) is a later slot with the same shape.

**W4 — Composite rules.** The one genuinely new thing in the product: a fixed
grammar over observation kinds with a window and a threshold, evaluated on the
worker tick, dry-runnable against collected history. Cannot start before W2/W3
have produced history to dry-run against.

**W5 — Alerts.** An alert object, a Slack app, email as fallback, and evidence
rendered as the alert rather than appended to it — account, intent, the three
links with dates, and why it fired.

**W6 — Precision instrumentation.** Alerts sent vs. alerts acted on, per rule.
Build it with W5, not after; a rule with no measured precision cannot be retired
honestly.

### Track L — LinkedIn

**L1 — The missing writer.** Queue invite and dm as `planned` from an approved
campaign. Everything downstream exists.

**L2 — Selector verification against a live account,** and a loud failure when
one breaks. An account that looks quiet because a selector rotted is the failure
mode that destroys trust in the whole product.

**L3 — The signed local companion.** **On the critical path** — hosted is being
sold this year, and `TREVRA_DEPLOYMENT_MODE=hosted` refuses all LinkedIn
automation until this exists. Hosted control plane decides and approves; the
customer's own machine executes. If it cannot ship with the hosted launch, then
hosted v1 is watch-and-alert only, said out loud.

### Ledger

Shipped, but extend it as W2–W5 land: a collection, a rule evaluation and an
alert each need to be inspectable. §3.6's bar is that the ledger explains a
**false positive**, and today none of those three produce a row.

### Decisions — resolved 2026-08-05

1. **The money half is frozen.** Keep it compiling, ship nothing new there, and
   mark `invoice.create` / `change_order.create` unavailable rather than letting
   them throw. §5's recommendation is now the decision.
2. **W1 storage: a new watched-account table.** A watched account is not a
   customer; `clients` stays the 10-column revenue index it is.
3. **Rule grammar: fixed vocabulary first,** over the observation kinds W2
   defines. Widen only on measured evidence, or it becomes the workflow builder
   §5 refused.
4. **Hosted is being sold this year — so L3 is on the critical path,** not a
   later item. See below.

### What "hosted this year" changes

Selling a managed product moves two things from _later_ to _scope_, and one from
_noted_ to _blocking_:

- **L3 stops being optional.** `TREVRA_DEPLOYMENT_MODE=hosted` refuses all
  LinkedIn automation in three places with a loud startup failure. A hosted
  customer who signed up for the outreach loop hits that wall on day one. Either
  the signed companion ships alongside the hosted product, or hosted launches
  **watch-and-alert only** — which is a coherent v1 (Track W needs no browser at
  all) but has to be a stated choice, not a discovered limitation.
- **The key-custody warning becomes customer-facing copy.**
  [byok-and-hosted-agent.md](./byok-and-hosted-agent.md) §7 already says a hosted
  service holding customer model keys is a concentrated liability and that users
  deserve to weigh it _before_ pasting. That paragraph now has to exist on a
  screen, not just in a document.
- **Nango's licence is now a blocker, not a footnote.**
  [system-of-record.md](./system-of-record.md) records it plainly: Nango is
  ELv2. Self-hosting Trevra with Nango is permitted; **a paid Trevra Cloud that
  resells Nango's OAuth flows as a feature likely is not, without a commercial
  agreement.** That doc says to resolve it _before_ hosted becomes the
  go-to-market motion. It now is. Resolve it early — a licence conversation has
  a lead time that a launch date does not forgive.
