# Trevra agent-native GTM OS — canonical design

**Date:** 2026-08-20
**Status:** Proposed canonical product architecture
**Scope:** Trevra product boundary, actors, core GTM objects, channels, CRM boundary, inbound/outbound flows, and implementation direction.

**Related:** `AGENTS.md`, `docs/system-of-record.md`, `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`.

---

## 1. Decision

Trevra is a **pure, agent-native GTM operating system for founders and small GTM teams**.

The product thesis is:

> Trevra is the operating system where human and agent actors share GTM state, run GTM procedures, and execute external GTM actions under deterministic permissions, policy, approvals, and auditability.

Trevra owns the operational truth required to run GTM. It does **not** seek to own every business record produced after GTM succeeds.

The architecture is deliberately narrower than a CRM, ERP, CDP, analytics platform, generic automation platform, or backend-as-a-service.

The acceptance test for every new primitive is:

> Is this required to find, understand, engage, qualify, convert, or coordinate a commercial relationship?

If the answer is no, it does not belong in Trevra core.

---

## 2. Product boundary

### Trevra is

- an agent-native GTM control plane;
- a shared operating surface for founders, GTM operators, and agents;
- a source of truth for GTM operational state;
- a durable ledger of agent decisions, approvals, actions, and outcomes;
- a multichannel execution system for GTM work;
- a minimal standalone GTM workspace for founders who have no CRM;
- an overlay/control plane for teams that already use a CRM.

### Trevra is not

- a general CRM;
- a customer data platform;
- a product analytics platform;
- a generic event bus;
- an application backend;
- a generic workflow/automation product;
- an accounting system;
- an invoicing system;
- a payments ledger;
- a project-management suite;
- an ERP;
- a contract-management system;
- a generic agent platform.

Agents exist to operate GTM. APIs exist to integrate GTM. Signals exist because they have GTM meaning.

---

## 3. No revenue/product-operations ownership

Revenue, invoices, payments, contracts, projects, milestones, deliverables, and accounting are outside the target Trevra product boundary.

Trevra may observe a GTM-relevant outcome from an external system, for example:

```text
opportunity won
customer created
trial activated
CRM stage changed
```

but Trevra does not become the canonical system for the downstream business object that emitted the observation.

In particular, the target product must not require this chain:

```text
Opportunity -> Client -> Project -> Invoice -> Payment
```

The target GTM chain stops at GTM outcome:

```text
Person / Account
  -> Signal / Submission
  -> Conversation / Campaign
  -> Reply / Meeting / Qualification
  -> Opportunity
  -> Won | Lost | Disqualified
```

Legacy non-GTM tables may remain during migration while existing code is disentangled. They must not become prerequisites for new GTM features, and no new GTM architecture should depend on them.

---

## 4. Workspace is the operating boundary

A workspace represents one startup or GTM organization.

```text
Workspace
  |
  +-- Human principals
  +-- Agent principals
  +-- People
  +-- Accounts
  +-- Account-Person associations
  +-- Inbound submissions
  +-- Signals
  +-- Conversations
  +-- Campaigns / playbooks
  +-- Opportunities-lite
  +-- Connections
  +-- Policies
  +-- Approvals
  +-- Prepared actions / deliveries
  +-- GTM ledger
```

Every commercial query and write is workspace-scoped.

A founder should be able to create a workspace and operate GTM without first buying or configuring another CRM.

A larger team can connect a CRM without changing the rest of its Trevra operating model.

---

## 5. Principals: humans and agents are first-class actors

Agents are first-class **actors**, but they are not literally human users.

Use a principal abstraction:

```text
Principal
  +-- Human
  +-- Agent
  +-- System
```

### Human principal

A real workspace member. Human-only concerns include:

- authentication;
- MFA;
- invitations;
- workspace membership;
- billing/admin roles;
- human approvals.

### Agent principal

A durable workspace-owned GTM actor.

Suggested model:

```text
agents
  id
  workspace_id
  name
  purpose
  status
  policy_profile_id        -- optional
  runtime_config_ref       -- model/runtime configuration, not credentials
  created_by_user_id
  created_at
  updated_at
```

An agent can be granted GTM capabilities such as:

```text
accounts:read
accounts:source
people:read
people:write
signals:read
signals:write
campaigns:read
campaigns:operate
conversations:read
actions:prepare
playbooks:run
```

External execution remains separately policy-gated.

### System principal

Deterministic Trevra infrastructure performing a system-owned transition, reconciliation, webhook normalization, scheduler wake-up, or similar non-human/non-agent action.

### Ledger rule

Every meaningful GTM mutation records:

```text
actor_type = human | agent | system
actor_id
```

The founder should be able to answer who or what caused any important GTM state change.

---

## 6. Agents are workers, not playbooks

Keep these concepts separate:

```text
Agent           = actor
Playbook        = procedure
Policy          = authority
Run             = one execution instance
Prepared Action = exact proposed side effect
Execution       = deterministic external write
```

Example:

```text
Scout agent
  -> runs Account Research playbook
  -> produces evidence + signals
  -> Outreach agent prepares a message
  -> workspace policy requires approval
  -> human approves exact payload
  -> deterministic adapter executes
```

Do not create agent-specific copies of Accounts, People, campaigns, or conversations. Humans and agents operate the same workspace state.

---

## 7. Core GTM nouns

The canonical GTM model should stay deliberately small.

### 7.1 Person

Product noun: **Person**. The storage table may remain named `contacts` if that avoids unnecessary churn.

A Person is a human the startup may have a commercial relationship with.

```text
Person
  id
  workspace_id
  name
  email
  email_normalized
  phone
  phone_normalized
  linkedin_url
  role
  created_at
  updated_at
```

A Person does not require an Account.

Deterministic identity only. No fuzzy-name merge and no model-based identity merge.

### 7.2 Account

A company or commercial organization relevant to GTM.

```text
Account
  id
  workspace_id
  name
  domain
  linkedin_url
  tags
  status
  ICP/scoring state
  created_at
  updated_at
```

Account is the natural entry point for account-led outbound prospecting.

### 7.3 Account-Person association

A Person may optionally be associated with an Account.

```text
account_contacts
  workspace_id
  account_id
  contact_id
  role
  source
  confidence
  created_at
  updated_at
```

Do not infer an association merely from an email domain, fuzzy name, or free-text mention.

### 7.4 Inbound Submission

One immutable GTM capture event from a website, landing page, form, product surface, partner, or other trusted source.

Examples:

```text
demo_request
contact_message
waitlist_joined
newsletter_subscribed
store_review_requested
pricing_enquiry
```

A Person can have many submissions.

Submission owns source/provenance, message, UTM/referrer data, consent assertions, source-specific properties, and timestamps. Updating a Person must never rewrite an older submission.

### 7.5 Signal

A fact that changes GTM relevance, timing, qualification, or recommended action.

Examples:

```text
hiring_up
funding_announced
pricing_changed
decision_maker_found
demo_requested
email_replied
linkedin_replied
meeting_booked
trial_started
crm_stage_changed
```

Signals are not generic product telemetry. `button_clicked`, `job_completed`, `API_latency`, and similar application events are not GTM signals.

### 7.6 Conversation

A durable commercial communication relationship with a Person, optionally associated with an Account or campaign.

```text
Conversation
  id
  workspace_id
  person_id
  account_id optional
  channel
  status
  campaign_id optional
  last_activity_at
  created_at
  updated_at
```

Channel mechanics may remain specialized underneath.

Product experience should converge on the Person/conversation, not force the operator to think in separate LinkedIn-lead and email-recipient universes.

### 7.7 Message

One inbound or outbound item inside a Conversation.

```text
Message
  conversation_id
  direction
  channel
  subject optional
  body
  provider identifiers
  verification/thread references
  status
  sent/received timestamps
```

### 7.8 Delivery

The durable external-execution claim and outcome for an outbound message/action.

It owns idempotency, payload hash, provider IDs, `sent | failed | uncertain` outcome semantics, and retry safety.

### 7.9 Suppression / consent state

Operational GTM safety state owned by Trevra.

A suppression can be scoped by Person/email/domain/channel as appropriate and must be checked by every relevant agent/playbook/action.

A prior consent assertion does not override a later suppression.

### 7.10 Campaign

A durable GTM targeting/execution context.

Campaigns organize who is being targeted, through which sequence/channel policy, by which agents/operators, and with what progress/outcomes.

### 7.11 Playbook

A reusable deterministic/agentic GTM procedure.

Playbooks are versioned and resumable. They do not own identity or commercial state.

### 7.12 Opportunity-lite

Trevra needs only enough opportunity state for a founder to operate without a CRM.

Recommended native fields:

```text
Opportunity
  id
  workspace_id
  person_id optional
  account_id optional
  stage
  owner_principal optional
  next_action
  source
  external_crm_ref optional
  created_at
  updated_at
```

Recommended default stages:

```text
new
qualified
meeting
proposal
won
lost
```

No revenue amount is required. No forecasting suite, quote management, territory system, or customizable CRM object platform should be built into Trevra core.

---

## 8. Two entry paths, one GTM OS

### Outbound / account-led

```text
Source / research
  -> Account
  -> signals + score
  -> People
  -> Campaign / Playbook
  -> Conversation
  -> prepared action
  -> policy / approval
  -> execution
  -> reply / outcome
  -> optional Opportunity
```

### Inbound / person-led

```text
Website / landing / form
  -> Capture Source
  -> Person
  -> Inbound Submission
  -> qualification / signal
  -> Conversation / follow-up
  -> optional Account association
  -> optional Opportunity
```

Neither path creates a separate `Lead` database.

`Lead` may remain a UI word when useful, but it should not become another canonical persistence hierarchy.

---

## 9. GTM Sources and Connections

Use GTM-specific integration concepts rather than a generic application platform.

A source/connection answers one or both questions:

1. Where did Trevra learn this GTM fact?
2. Through what controlled capability can Trevra perform this GTM action?

Examples:

```text
Website / landing capture
CSV / folder import
Directory research
LinkedIn
Gmail
Microsoft 365
HubSpot
Attio
Other CRM
Partner source
Manual entry
```

Connections own provider configuration references. Provider credentials live in Nango/Secret Manager or provider-appropriate custody, never on Agent rows.

Agents receive permission to invoke capabilities through a workspace connection; they never receive the underlying credential.

---

## 10. Landing-page integration boundary

The landing page and its edge/backend runtime stay outside Trevra.

For Beseam:

```text
ecom-clean-lp
  -> Cloudflare Worker
     -> /api/lead          -> Trevra intake
     -> /api/answer-check  -> e-commerce/product API
     -> /api/product-image -> merchant/CDN proxy
     -> redirects/assets/edge security
```

The Worker keeps:

- public-edge validation;
- bot/honeypot/rate-limit controls;
- same-origin endpoints;
- request-size limits;
- product API proxies;
- assets/redirects;
- secure server-to-server signing.

The Worker loses GTM ownership:

- no canonical lead database;
- no GTM lifecycle;
- no SendPulse-as-source-of-truth;
- no duplicate sales workflow;
- no local follow-up state Trevra later has to reconstruct.

The generic capture protocol is specified in `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`.

---

## 11. CRM boundary

Trevra must remain useful with or without a CRM.

### No CRM connected

Trevra's People, Accounts, Conversations, Signals, Campaigns, and Opportunity-lite are sufficient to run early GTM.

### CRM connected

The CRM remains authoritative for CRM-specific sales records and fields.

Examples:

```text
CRM owns
  CRM record IDs
  CRM-specific custom properties
  CRM owner/territory semantics
  CRM pipeline configuration
  canonical deal record when the team chooses CRM authority

Trevra owns
  targeting
  GTM signals
  inbound submissions
  campaigns
  conversations required for Trevra execution
  suppressions
  agent runs
  playbooks
  prepared actions
  approvals
  delivery/execution history
  GTM ledger
```

Trevra should not reproduce hundreds of CRM properties.

### Write-back default

Preserve the current safe default: **activity, not record mutation**.

A CRM adapter may find an existing contact and append an evidence-backed activity/note. It should not silently create contacts, overwrite CRM properties, move deals, or change owners.

If broader CRM writes are ever added, they require a separate explicit design with field authority, conflict semantics, scopes, policy, and migration rules. Do not smuggle CRM mutation into a connector convenience method.

---

## 12. Agent authority model

First-class does not mean unrestricted.

Example:

```text
Research Agent
  can read Accounts
  can run research
  can create evidence/signals
  can prepare People candidates
  cannot send externally

Outreach Agent
  can read Accounts/People
  can prepare messages
  can prepare actions
  cannot approve its own restricted action
  cannot bypass suppression/caps

Inbox Agent
  can read inbound Conversations
  can classify verified replies
  can prepare next steps
  cannot unsuppress a Person
```

Policy evaluation considers:

```text
principal
capability/action type
resource
exact payload
workspace policy
channel safety state
connection availability
```

Possible outcomes:

```text
allow
require_approval
deny
```

Models do not decide the permission boundary.

---

## 13. Prepared-action boundary

All consequential external writes must preserve the existing Trevra rule:

```text
Agent / human decision
  -> Prepared Action
  -> exact payload hash
  -> policy evaluation
  -> approval when required
  -> durable execution claim
  -> provider adapter
  -> append-only outcome
```

Examples:

```text
email.send
linkedin.connect
linkedin.message
crm.log-activity
```

An LLM, generic skill runner, or generic playbook step must never perform an external write directly.

Ambiguous provider outcomes become `uncertain` and are not blindly retried.

---

## 14. Multichannel conversation model

Trevra should become channel-neutral at the product/core state layer while retaining channel-specific safety/execution implementations.

Target experience:

```text
Person: Kim Sidi

LinkedIn
  Aug 18  invitation accepted
  Aug 19  Kim replied

Email
  Aug 20  follow-up sent
  Aug 21  Kim replied
```

The system may persist separate channel threads underneath. The operator should still be able to understand one commercial relationship without switching mental models.

LinkedIn, email, and future channels are adapters around shared People/Campaign/Conversation state, not separate CRMs.

---

## 15. GTM-relevant email requirements

Generic `email.send` capability is insufficient for autonomous/semi-autonomous GTM.

The GTM email path needs:

- exact approved recipient/subject/body;
- workspace/channel policy;
- global/person/email/domain suppression checks;
- sender connection checks;
- daily/workspace limits;
- durable delivery claim;
- deterministic or stable Message-ID handling;
- provider response IDs;
- `failed` versus `uncertain` distinction;
- no blind retry after uncertain send;
- verified inbound reply threading through provider/message references;
- bounce and OOO separated from human reply;
- unsubscribe based on newly typed verified content, not quoted history.

This is required before the old e-commerce Growth sender/reply subsystem can be safely retired.

---

## 16. Operator experience: optimize for the GTM person

Architecture is successful only if the operator does less coordination work.

The daily Trevra surface should answer:

```text
What changed?
What needs judgment?
What are the agents doing?
What is blocked?
What should I do next?
```

Target summary:

```text
Today

3 inbound submissions
8 replies need attention
4 accounts became high-priority
17 accounts researched by Scout
5 actions prepared by agents
2 require approval
1 connection needs re-authentication
```

The operator should work from exceptions, approvals, conversations, and priority changes rather than manually moving records between tools.

---

## 17. Agent team product surface

The existing agent runtime should evolve into a visible GTM team, not a collection of hidden schedules/tokens.

Example:

```text
Agents

Scout
  Purpose: account prospecting
  Status: working
  Today: 17 accounts researched
  Waiting: none

Researcher
  Purpose: qualification and evidence
  Status: working
  Today: 4 high-priority accounts

Outreach
  Purpose: prepare and operate campaigns
  Status: waiting
  Waiting: 2 approvals

Inbox
  Purpose: classify and route replies
  Status: working
  Today: 8 replies reviewed
```

Each Agent view should expose:

- purpose;
- permissions/capability grants;
- supervising human or policy profile where applicable;
- active assignment/goal;
- recent runs;
- recent decisions/evidence;
- pending approvals/actions;
- failures/blockers;
- status.

Do not create one custom runtime per named agent. Reuse the shared agent/run/playbook/control-plane infrastructure.

---

## 18. What Trevra already has

The target is an evolution, not a rewrite.

### Already strong / keep

- [x] Workspace tenancy and workspace-scoped commercial state.
- [x] Agent tokens/scopes.
- [x] Agent run history, schedules, budgets, and tool execution runtime.
- [x] Durable playbooks and skill runs.
- [x] Prepared actions and exact approval payload hashing.
- [x] Workspace policy evaluation and append-only audit/domain events.
- [x] Nango/provider connection layer and secret boundaries.
- [x] Account persistence, import, sourcing, signals, scoring, and feedback.
- [x] Folder Import Review and provenance-preserving account ingestion.
- [x] Substantial LinkedIn campaign, pacing, safety, inbox, and action-ledger infrastructure.
- [x] HubSpot/Attio safe CRM activity adapters.
- [x] Existing opportunities data model that can be simplified toward Opportunity-lite.

### Partial / needs convergence

- [~] Agent identity: tokens/runs exist, but durable user-facing Agent principals/team model is incomplete.
- [~] People: canonical `contacts`/People is now the human identity spine for inbound, account-import evidence, LinkedIn lead contacts, connected messages/opportunities, and CRM activity attribution. Legacy `clients`/`contact_identities` remain only as compatibility bridges pending removal.
- [~] Conversations: shared Person-centric Conversation/Message projection now unifies stored LinkedIn and connected-email transcripts, with authenticated read APIs and a unified Messages operator surface. Channel-specific delivery/safety engines remain authoritative underneath, and shared Delivery normalization is still incomplete.
- [~] Email: Gmail/Microsoft execution, threading, provider reply/bounce observation, verified inbound reply-body capture, tracking, idempotency, execution-boundary suppression, shared transcript projection, and exact-payload conversation reply preparation/approval now exist. Unsubscribe/OOO/unverified-reply classification plus fully shared Delivery semantics remain incomplete.
- [~] CRM: safe adapter philosophy exists; product docs/data model still contain older revenue/delivery ownership assumptions.
- [~] Opportunity: existing schema exists, but target should be minimal GTM state rather than expanding CRM/revenue management.

### Missing

- [x] Canonical Person persistence and deterministic channel convergence exist for inbound/import, LinkedIn leads, connected messages/opportunities, and CRM activity. Legacy client rows are bridged with `person_id` until final removal.
- [x] Optional canonical Account-Person association.
- [x] Durable Capture Sources and Inbound Submissions.
- [x] Website/landing intake API and founder setup flow.
- [~] Global suppression authority exists and is enforced for email + LinkedIn, including manual suppressions, LinkedIn DNC sync, campaign admission, execution-time checks, and hard-bounce suppression. Consent normalization, unsubscribe/OOO semantics, and any future channel-specific enforcement remain.
- [~] GTM-specific email delivery state and verified inbound reply ingestion. Campaign email actions already have durable planned/claimed/sent/failed/unknown state and provider-verified reply/bounce ingestion with reply content projected into the shared transcript; a channel-neutral Delivery object is still pending.
- [x] Shared conversation/operator view across LinkedIn and email, including one Person-centric transcript and exact-payload email reply preparation/approval from the Messages surface.
- [ ] Durable Agent principal/team product model.
- [~] Intent-first operator layer: deterministic `Today`, first-run GTM job choices, and narrow retry-safe outreach preparation are implemented; bounded general intent compilation remains.
- [ ] Growth-service state migration and complete retirement.

---

## 19. Implementation sequence

This order maximizes usefulness to the GTM operator while reducing architectural duplication.

### Phase 1 — Person spine

- [x] Add canonical `contacts`/People persistence.
- [x] Add deterministic identities and dedupe.
- [x] Add optional `account_contacts` association.
- [x] Preserve provenance/conflicts rather than silently overwrite canonical fields.
- [x] Connect current account-import contact evidence to People.
- [x] Converge LinkedIn/contact/client identities onto canonical People without duplicating People. LinkedIn lead contacts now carry durable `person_id` + explicit resolution status; existing rows backfill deterministically; connected messages/opportunities, CRM activity, and temporary legacy client identity all bridge to canonical People.

Exit criterion: one real human can be referenced consistently across account sourcing, imported evidence, and channel state.

### Completed foundation — Person convergence

Implemented before shared Conversations so every channel can project onto one human identity:

1. [x] Add a canonical Person reference to LinkedIn lead contacts without replacing LinkedIn-specific campaign state.
2. [x] Backfill existing LinkedIn leads to canonical People using deterministic email, canonical LinkedIn profile URL, or explicit E.164 phone; never fuzzy-name matching. Identity-poor rows stay `insufficient_identity`, and conflicting deterministic identities stay `conflict`.
3. [x] Make new CSV, sourced, signal, and discovered LinkedIn leads resolve/create canonical People whenever deterministic identity exists; preserve explicit resolution state otherwise.
4. [x] Preserve LinkedIn-specific names/company/custom fields as channel evidence; fill empty canonical Person fields but never silently overwrite conflicting non-empty canonical values.
5. [x] Map connected email/message/opportunity ingestion, CRM activity, and legacy `clients`/`contact_identities` onto the same Person spine via temporary compatibility links.

Exit criterion: a person discovered on LinkedIn, imported by email, or arriving inbound resolves to one canonical Person ID while channel-specific evidence remains intact.

### Phase 1.5 — ruthless-simplicity operator layer

This phase adopts `2026-08-21-ruthless-simplicity-intent-compiler-design.md` without changing the GTM domain model. The founder sees jobs and outcomes; Trevra continues to compile them into the durable primitives defined by this spec.

- [x] Add deterministic `GET /api/today` projection for safety blocks, verified replies, unknown deliveries, approvals, inbound submissions, high-priority accounts, and capacity blockers. Qualification-decision projection can be added when that durable state exists.
- [x] Replace first-run implementation-object checklists with founder jobs: Find prospects, Prepare outreach, Watch accounts, Capture inbound.
- [x] Add narrow `POST /api/outreach/prepare` composition before a general intent compiler: validate sender -> import/reuse canonical People -> create/reuse lead list -> choose versioned safe default workflow -> create draft campaign -> return preview. The endpoint is retry-safe and never starts the campaign.
- [x] Ship a versioned blessed LinkedIn outreach workflow for ordinary first campaigns; `/outreach/new` now uses the simple CSV-to-draft path by default and keeps the existing list/workflow builder under Advanced.
- [~] Bounded typed `GtmIntent -> GtmPlan -> prepare` compilation is now implemented without a universal Job table: `POST /api/gtm/plan` deterministically plans all five bounded GTM objectives, Today exposes an inspectable Goal -> Plan surface, and `POST /api/gtm/prepare` currently composes only safe `prepare_outreach` plans through the existing draft-campaign preparation boundary with stale-plan hashing and idempotency. Other objectives remain inspectable/direct-surface plans until their composition primitives are deliberately added. Natural language may later populate the same typed intent but may never directly create arbitrary executable workflows.
- [~] Keep progressive disclosure strict: the ordinary `/outreach/new` path now hides list/workflow construction under Advanced; extend the same rule to later intent/compiler surfaces.

Exit criterion: a founder can state a GTM job, inspect what Trevra will prepare, and reach a useful result without learning lead-list/workflow/playbook internals; safety and exact state semantics remain unchanged.

### Phase 2 — inbound GTM

- [x] Add Capture Sources.
- [x] Add immutable Inbound Submissions.
- [x] Add signed/idempotent intake endpoint.
- [x] Add `Setup -> Lead capture` with integration snippets and request diagnostics.
- [~] Adapt Beseam `ecom-clean-lp /api/lead` through the existing Cloudflare Worker; code path, end-to-end retry idempotency, Worker tests and production build are ready, while live Capture Source provisioning/verification is pending.
- [ ] Remove SendPulse/local website lead state as canonical GTM state after live verification.

Exit criterion: a founder's landing page can create/match a Person and preserve each submission in that founder's Trevra workspace.

### Phase 3 — shared conversations + GTM email

- [x] Add/normalize shared Conversation, Message, Delivery, and Suppression persistence. Person-led conversations/messages span LinkedIn + email, workspace suppressions are shared across send paths, and `gtm_deliveries` is the canonical exact-payload email delivery claim across campaign/playbook/Agent execution.
- [x] Map LinkedIn conversation state into the shared operator model without weakening LinkedIn-specific safety. LinkedIn threads/messages project idempotently while the LinkedIn cache, ledger, pacing, and worker remain authoritative.
- [x] Add dedicated GTM email prepared action (`email.send`) through the deterministic prepared-action boundary.
- [x] Add suppression, provider checks, durable delivery claims, and `uncertain` semantics. The shared delivery boundary atomically claims an approved payload, persists provider identity, disables blind POST retries, replays confirmed sends without resending, makes ambiguous provider outcomes terminal for automatic resend, and enforces the mailbox outreach cap across campaign/playbook/Agent email. Conversation replies are explicitly exempt from cold-outreach capacity.
- [x] Add Gmail/Microsoft inbound normalization and verified reply handling. Provider conversation rereads capture verified reply bodies/subjects/senders and project them into the canonical Person transcript before consequential reply outcomes are recorded.
- [x] Add a Person-centric unified Messages read surface and exact-payload email reply preparation. `POST /api/conversations/:id/replies/prepare` creates a retry-safe `gtm.conversation-email-reply` approval-backed playbook; approval resumes the existing `email.send` executor and projects the confirmed outbound message back into the same transcript.
- [~] Separate reply, unsubscribe, hard bounce, delivery failure, OOO, automatic reply, unknown, and unverified sender-only outcomes. Provider-thread verified outcomes are now typed; unsubscribe/hard bounce create durable suppression, human reply/unsubscribe stop future campaign work, and OOO/automatic/unknown do not masquerade as a human response. A sender-only unverified presentation path remains intentionally non-authoritative work.

Exit criterion: the GTM operator can work email and LinkedIn around shared People and consistent outcome semantics.

### Phase 4 — agent principals + operator surface

- [x] Add durable Agent principal records.
- [x] Bind existing agent tokens/runs/schedules to Agent principals.
- [x] Add capability grants/policy display. Agent credentials grant explicit scopes while provider credentials remain connection-owned; the Team surface shows the granted capabilities.
- [x] Add GTM team UI for human + agent actors.
- [ ] Extend the earlier `Today` projection with attributable agent activity, agent blockers, delegated work, and per-agent drill-down.

Exit criterion: agents feel like delegated GTM workers whose work is visible, attributable, and governable.

### Phase 5 — minimal opportunity + CRM boundary cleanup

- [x] Remove runtime dependence on the legacy `clients` compatibility object; canonical People/Person identities now own human GTM identity.
- [x] Expose minimal Opportunity-lite for CRM-less founders with six fixed stages, Person/Account association, owner, and next action—no amount/forecast/custom CRM object model.
- [x] Preserve CRM activity write-back as safe default.
- [x] Keep CRM-specific deal/contact fields externally authoritative when a CRM is connected.
- [x] Remove customer revenue/accounting/project primitives from the GTM runtime and primary product surfaces.

Exit criterion: Trevra works standalone for early GTM without becoming a CRM, and cleanly overlays an external CRM when one exists.

## 20. What not to build on the way

Implementation must not be used as an excuse to add:

- a second `Lead` persistence model;
- a full CRM object/custom-field system;
- arbitrary product-event ingestion;
- revenue dashboards;
- invoice/payment ownership;
- contract/project management dependencies;
- generic automation unrelated to GTM;
- agent-specific copies of shared GTM state;
- agent-owned provider credentials;
- direct model-driven external writes;
- source-specific GTM databases for website, email, LinkedIn, or CRM.

---

## 21. Architectural invariants

1. Every GTM record is workspace-scoped.
2. Humans, Agents, and System are distinct principal types.
3. Every consequential GTM mutation has an actor.
4. A Person does not require an Account.
5. Account-Person association is explicit/deterministic, never fuzzy inference.
6. Inbound Submissions are immutable evidence, not mutable Person state.
7. Signals must have GTM meaning.
8. Channels share GTM identity/state but retain specialized safety mechanics where necessary.
9. Provider credentials belong to workspace connections, never Agents.
10. External writes require a dedicated prepared-action/execution boundary.
11. Approval binds to the exact payload being executed.
12. Suppression and hard safety rules cannot be bypassed by models or playbooks.
13. Ambiguous external outcomes are not blindly retried.
14. CRM integrations do not silently turn Trevra into a second CRM writer.
15. Revenue/accounting/project objects are not required by GTM core.
16. The GTM ledger is append-only and sufficient to explain important agent/human actions.

---

## 22. Acceptance test: the GTM operator

The architecture is complete enough when a GTM operator can spend the working day primarily in Trevra and answer:

```text
Who should we target now?
Why are they high priority?
Who are the relevant People?
What came inbound?
Which conversations need attention?
What are our campaigns doing?
What did the agents do?
What needs my approval/judgment?
What is blocked by safety, policy, or a broken connection?
What GTM outcome followed?
```

A successful daily workflow looks like:

```text
Trevra
  -> shows new inbound submissions
  -> shows newly high-priority Accounts/People
  -> agents research and prepare work
  -> operator reviews exceptions/approvals
  -> LinkedIn/email actions execute through policy
  -> replies converge into the work queue
  -> qualified conversations become Opportunities
  -> CRM receives/reflects activity when connected
```

The GTM operator should not need to manually reconcile a Trevra lead database, a LinkedIn lead database, a landing-page lead list, a SendPulse list, an email sequence database, and a CRM.

---

## 23. Final architecture

```text
                         TREVRA GTM OS

                          WORKSPACE
                              |
                  +-----------+-----------+
                  |                       |
               HUMANS                  AGENTS
                  |                       |
                  +------ PRINCIPALS -----+
                              |
                              v

              +--------- SHARED GTM STATE --------+
              |                                    |
           People <-----------------> Accounts     |
              |                         |          |
       Inbound Submissions          Signals        |
              |                         |          |
              +------------+------------+          |
                           v                       |
                     Opportunities-lite            |
                           |                       |
                     Conversations                 |
                           |                       |
                  Campaigns / Playbooks            |
                           |                       |
                           v                       |
                    Prepared Actions               |
                           |                       |
                  Policies / Approvals             |
                           |                       |
                           v                       |
                       Execution                   |
                           |                       |
                           v                       |
                    GTM Outcomes                   |
              +------------------------------------+

                              |
                     WORKSPACE CONNECTIONS
                              |
       +-----------+----------+----------+---------+----------+
       |           |          |          |         |          |
    Website      Gmail    Microsoft   LinkedIn    CRM      Sources
```

The defining rule is:

> **Trevra owns GTM operational state and agent execution. It does not own the rest of the startup.**
