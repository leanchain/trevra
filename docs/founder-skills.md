# Founder Skills + Trevra as the ledger

Assessment of turning Trevra into an open-source agentic growth + CRM system for
founders, using `leanchain/e-commerce/growth` (beseam-growth) as the reference
implementation.

---

## 1. The verdict up front

The idea is strong, and stronger than you may realise — because **you have
already built both halves of it.**

The founder revenue loop is:

```
prospect -> outreach -> deal -> delivery -> invoice -> paid -> expand
\_______ beseam-growth _______/       \________ Trevra ________/
```

beseam-growth owns the **left half** and owns it well. Trevra owns the **right
half**. Nobody in the market closes the whole loop with evidence and approval
gates — HubSpot stops at closed-won, invoicing tools start at closed-won, and
the agentic GTM startups have no delivery/billing graph at all.

That gap is the real wedge. Not "open-source HubSpot."

The risk is equally real: this is three products (growth, CRM, delivery/billing)
and you are one person. Sequencing is the entire game. See §5.

---

## 2. The Founder Skills catalog

A **skill** is a small, deterministic, testable unit of go-to-market work with
an explicit contract: typed input, typed output, recorded evidence, no hidden
state. It is a library function first and an "agent" second.

This is the crucial framing difference from every AI-CRM on the market. They
sell an agent that does vague work. You sell **a repertoire of plays a founder
can read, fork, test, and trust** — some of which happen to call an LLM.

Nine of these already exist, working and tested, in beseam-growth:

| # | Skill | Contract | Reference |
|---|-------|----------|-----------|
| 1 | **Source** | config -> candidate domains | `sources/registry.py`, `sources/runner.py` |
| 2 | **Enrich** | domain -> platform, catalog size, tech, contacts | `sources/enrich.py` |
| 3 | **Score** | lead -> `{fits, overall, wedge, reasons[]}` | `scoring.py` |
| 4 | **Audit** | domain -> weighted check report + top finding | `audits/visibility.py` |
| 5 | **Draft** | lead + audit -> subject, body (LLM, template fallback) | `outreach/drafting.py` |
| 6 | **Send** | approved message -> delivered, capped, suppressed | `outreach/sending.py` |
| 7 | **Reply** | inbound -> classified, auto-suppressed | `outreach/replies.py` |
| 8 | **Ladder** | status transitions + event timeline | `service.py` |
| 9 | **Guard** | every outbound fetch -> SSRF-validated | `netguard.py` |

Five more complete the loop; two of them already exist inside Trevra:

| # | Skill | Status |
|----|-------|--------|
| 10 | **Position** — ICP + wedge hypothesis, versioned, diffable | to build |
| 11 | **Publish** — turn a skill or audit into a public artifact | to build (this is the growth engine, see §4) |
| 12 | **Measure** — funnel instrumentation, cohorts, conversion | partial: Trevra `marketing_events` + `getTractionReport` |
| 13 | **Close** — proposal, agreement, scope, change order | exists: Trevra commercial graph |
| 14 | **Collect** — milestone, invoice, payment, dunning | exists: Trevra recommendation engine |

### What makes these worth open-sourcing

The value is not the code volume — it is the **encoded judgement**. Concretely,
things in beseam-growth that a founder would otherwise learn by getting burned:

- **`scoring.py` is deterministic and explains itself.** Every contribution
  emits a reason string (`"visibility: +0.3 shopify (feed-driven)"`) and the
  wedge tie-break order is a locked, documented decision. A founder can argue
  with the model instead of trusting a black box.
- **`registry.py` disables `app_store` by default** with the reason written in
  the code: scraping app-store directories violates ToS. Ethics as a default,
  not a policy doc.
- **`sending.py` guards in order**: atomic `approved -> sending` claim (closes
  the double-send TOCTOU), suppression check, daily cap, and an explicit refusal
  to fake-send when SMTP is unconfigured. That is four separate ways founders
  torch their sending domain, all closed.
- **`drafting.py` falls back to a deterministic template** when the LLM path
  fails, and caps output length. Outreach never blocks on a model being up, and
  never emits a 900-word AI essay.
- **`netguard.py` re-validates every redirect hop.** The moment you fetch
  user-supplied domains, you have an SSRF surface. Most people find out later.
- **`visibility.py` renormalises weights when checks skip**, so a partial
  network outage still yields a usable score instead of a wrong one.

That list *is* the product pitch. "Here are the nine mistakes we already made
for you, in code, with tests."

---

## 3. Trevra as the ledger and control plane

Skills are stateless and forkable. Trevra becomes the thing that gives them
memory, safety, and a place to be watched. Three jobs, nothing more:

**a. Skill registry.** Install, enable, configure, schedule. Generalise
beseam-growth's `lead_sources` table (key, enabled, config_json, last_run_at,
yield_count) from lead sources to *any* skill. Idempotent back-fill seeding is
already the right pattern.

**b. Run ledger.** Every skill execution: inputs, outputs, evidence, duration,
cost, verdict. beseam-growth's `LeadEvent` timeline is the seed of this;
Trevra's audit records are the other half.

**c. Approval gates.** This is Trevra's single most valuable existing asset and
it is currently undersold. Trevra already **hashes the exact approved payload
before execution and rejects modified payloads** (`action-service.ts`).

That mechanism is the entire trust story for agentic GTM. The objection to every
AI sales agent is "I am not letting a model email my prospects unsupervised."
The answer is not "trust us, it's a good model." The answer is:

> Every action is evidence-backed, approval-gated, and the approved payload is
> cryptographically pinned. Delegation is scoped by action type, confidence
> ceiling, amount ceiling, and delay — or it does not happen.

No open-source GTM tool has this. Lead with it.

**d. The unified graph.** One entity chain, prospect through paid:

```
Source -> Lead -> Audit -> Sequence -> Deal -> Client -> Project
       -> Milestone -> Invoice -> Payment -> Outcome
```

The outcome edge is what makes it more than a CRM: **scoring gets a feedback
signal.** `score_lead()` today is hand-tuned constants. Once the graph closes to
`paid`, those weights can be fitted against real revenue. That is a moat that
compounds and that a fork cannot copy without the data.

---

## 4. Open source + hosted: the model

The model works (Supabase, PostHog, Cal.com, n8n). Two things decide whether it
works *for you*:

### Licensing

- **Skills SDK + skill packages: MIT.** Maximum adoption, maximum forking,
  maximum contribution. These are the marketing.
- **Trevra server (ledger, control plane, approvals): AGPLv3.** Anyone can
  self-host for free forever. A cloud provider reselling it must open their
  changes. This is the standard protective pairing and it is not hostile to a
  single self-hosting founder — which is the entire audience.

Do not use pure MIT on the server. You are one person; you cannot out-execute a
well-funded rehost.

### What hosting may charge for

Only, and visibly only:

1. Hosting, upgrades, backups, uptime.
2. **Managed OAuth applications.** This is the real friction — registering and
   getting review-approved for Gmail, Microsoft 365, QuickBooks, Xero, Stripe
   Connect is weeks of work per provider. Nango is already wired in. This alone
   justifies the price for most founders.
3. **Deliverability infrastructure.** Warmed sending domains and IP reputation
   are genuinely hard to self-host and genuinely valuable.
4. Opt-in anonymised benchmarks ("your reply rate vs. 400 other founders").

### What hosting must never gate

Skills, scoring, audits, the graph, approval gates, the run ledger, exports.
The moment a skill is cloud-only the pitch dies, because the pitch is *"the
plays are yours."*

### The distribution engine — the part people skip

Open source is not distribution. It is a licence. What makes this specific plan
work is that **each skill is simultaneously three artifacts**:

1. **Code** — forkable, tested, in the open repo.
2. **Content** — "How we built an AI-visibility audit in 200 lines of httpx."
   Every skill is a post. Fourteen skills is a year of technical content that
   ranks, because it is real code and not marketing.
3. **Lead magnet** — the audit runs against *the reader's own domain*, scores
   it, shows the top finding, and offers to track it over time. That is exactly
   what `visibility.py` already does for e-commerce prospects.

And then the recursion, which is the actual story: **Trevra's own growth runs on
Trevra's own skills.** The traction dashboard is public. Founders watch the tool
sell itself and can read every line that does it. That is not a campaign anyone
else can copy without also being open source.

---

## 5. Honest risks, and the sequencing

### Risks

1. **Scope explosion — the real one.** Growth + CRM + delivery/billing is three
   products. Solo, attempting all three in parallel produces three half-products
   and no users.
2. **ICP change.** Trevra today is "revenue chief of staff for *freelancers*."
   This pivot targets *founders*. Different buyer, different pain, different
   channel. The old ICP is encoded in `index.html`, `public-site.ts` (llms.txt,
   FAQ, structured data, OG tags), and the marketing copy — and you just bought
   `usetrevra.com` against the old positioning. The domain still works; the copy
   does not.
3. **Two languages.** beseam-growth is Python/FastAPI/SQLAlchemy/Temporal.
   Trevra is TypeScript/Express/Postgres. Do not rewrite either. Define the
   skill contract as **HTTP + JSON Schema** so skills stay polyglot; the ledger
   does not care what language ran the play.
4. **Cold outbound is a declining channel** and a regulatory minefield (GDPR,
   CAN-SPAM). beseam-growth handles compliance properly already (suppression,
   unsubscribe, postal address, caps). Keep that discipline — and weight the
   catalog toward inbound/audit-led skills over volume outbound.

### Suggested sequencing

**Phase 1 — publish the skills (weeks, not months).**
Extract the nine working skills from beseam-growth into a public repo with the
skill contract, tests, and one post each. Costs little, is immediately useful,
and is the top of the funnel. Trevra ships nothing yet.

**Phase 2 — Trevra becomes the ledger.**
Generalise `lead_sources` into a skill registry, add the run ledger, and point
the existing approval-hash mechanism at skill executions rather than only at
commercial actions. Narrow Trevra's story to *"the place your plays run, with
receipts."* Delivery/billing stays as-is; do not touch it.

**Phase 3 — close the loop.**
Join the prospect graph to the delivery graph. Now `Outcome` feeds back into
`Score`, and you have the thing no one else has.

**Phase 4 — hosted.**
Only once self-hosters are asking for it. Managed OAuth and deliverability are
the first two paid surfaces.

### One thing to decide before any code

Pick the **single loop you close end-to-end first**. The honest recommendation:
audit-led inbound (Skills 4 -> 5 -> 8 -> 12 -> 13). It is the loop beseam-growth
already proves, it needs no cold-email risk appetite, and the audit doubles as
the lead magnet that distributes the whole project.
