# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Founders and small-team operators running their own go-to-market — solo, or with one or two people — who today track a curated few-hundred-account watchlist by hand. They import a CSV of target accounts once, then are pulled back in only when Trevra needs a decision: approve outreach, approve an invoice send, approve a change order, connect a new data source. They are the same people running Claude Code or Codex; the agent works inside their own tool via MCP, not a separate app they context-switch into to "use AI." [docs/core-product.md persona; docs/app-spec.md "three jobs"]

## Product Purpose

Trevra is a workspace an agent operates and a human approves. It reconstructs the full commercial timeline — sourced, proposed, agreed, delivered, invoiced, paid — watches a founder-chosen account list for composite intent signals (hiring + site changes + public commentary layered together, never a single trigger treated as a finding), drafts and queues the outreach and collection work behind it, and executes only what was explicitly approved or delegated: through Gmail/Microsoft 365, QuickBooks/Xero/Stripe, HoneyBook/Bonsai, marketplace imports, and LinkedIn via a local Playwright-driven worker. Success means the founder is never asked to do what the agent already does better; every screen exists for one of the three things only a human can do — connect the agent, connect the data, approve or reject.

## Positioning

The composite-signal-plus-hold-for-approval mechanism, together, not either half alone. Every neighboring vendor (Clay, Cargo, Unify, Common Room, Dripify and the rest of docs/competitive-landscape.md) sells either a single-signal trigger or an agent that acts without a hard approval gate. Trevra pairs "a single signal is noise, a combination is an intent" (docs/core-product.md) with "nothing crosses this line without you" (docs/app-spec.md / landing copy), and backs every alert and every prepared action with source-linked, timestamped evidence that a competitor's black-box score can't reproduce after the fact.

## Operating Context

Five nav destinations, one per stage of one loop: **Loop** (what's stuck), **Outreach** (what goes out, at what pace, is the seat safe), **Money** (what's agreed / delivered / billed / paid, and what isn't), **Ledger** (what the agent actually did, with evidence), **Setup** (what can reach the workspace, what it may spend, what it may do). A stop control (`StopBar`) is reachable on every route outside the nav, not a sub-screen. The operator is always an agent: either the founder's own Claude Code/Codex reaching Trevra over MCP with an agent token (works only while their machine is on), or Trevra's own hosted BYOK agent (works while the laptop is closed, paid for by the founder's own API key). Both hold identical, execute-never scopes. LinkedIn outreach runs through a real local browser worker, not an API — selector rot against LinkedIn's DOM is an accepted, ongoing operating cost, not a one-time integration.

## Capabilities and Constraints

- **PostgreSQL-only.** No SQLite, no embedded dev database, no fallback path — never imply otherwise in copy, diagrams, or UI.
- **Every signal or finding traces to a source URL and a timestamp**, tagged **HARD FACT** (published, verifiable) vs **REPORTED** (practitioner-measured). Nothing is inferred without a source; a collector that fails says so rather than returning empty.
- **"Send" is reserved for actions that truly send.** Anything queued, drafted, or awaiting approval is "queue," "prepare," or "draft" — never "send," anywhere in copy or UI.
- Integrations (Gmail/M365, QuickBooks/Xero/Stripe, HoneyBook/Bonsai, marketplace CSV imports) run through Nango-managed connections; Trevra does not reimplement OAuth, refresh-token rotation, or rate-limit handling itself.
- Durable playbooks with exact-payload approvals — hashed and pinned, so an edited action can never reuse an old approval — on Temporal or PostgreSQL orchestration.
- Hosted module registry: Ed25519 publisher identities, signed digest-pinned releases, SBOMs, sandboxed OCI/WASI/remote execution, privacy-safe popularity counters shown publicly.
- The agent may read, score, draft, and prepare; it may **never** approve or execute — identical for both the BYO-agent (local Claude Code/Codex) and BYOK (hosted) operator, by design, not as a current limitation.

## Brand Commitments

Name: **Trevra**. Existing wordmark/favicon at `public/logo.svg`, `public/favicon.svg` — an identity to preserve, not repaint, absent an explicit rebrand request. Voice is precise and unhedged, not softened marketing copy: "Billed, not paid." "The money exists; it has not arrived." "Your agent works on a branch. You do the merge." Confidence tags (HARD FACT / REPORTED) belong in visible copy, not only behind a tooltip. No invented testimonials, customer names, logos, or benchmark numbers, anywhere.

## Evidence on Hand

No real customer testimonials, logos, or case studies exist yet — future work must not fabricate any. "Guido" in docs/core-product.md is an internal illustrative persona from a GTM research call, not a citable customer; never surface it as a testimonial or named case study. Real, live data that may be shown: the hosted module registry's run counts, success rates, installs, and popularity ranks, already displayed on the public landing page without exposing workspace or customer data.

## Product Principles

1. A single signal is noise; a combination, with evidence, is an intent — never ship a bare trigger as if it were a finding.
2. Nothing with a consequence — a send, an invoice, an irreversible LinkedIn action — crosses without an explicit, exact-payload-hashed approval that an edit cannot silently reuse.
3. The human never does what the agent does better; a screen built so a person can hand-do the agent's job is not a primary screen.
4. Evidence is not an appendix; it is the alert, the finding, the approval itself — the recipient decides without leaving the surface.
5. The browser worker is cheap to build and expensive to keep alive against a DOM that changes whenever LinkedIn likes — treat that maintenance cost as permanent, never as a one-time integration.
