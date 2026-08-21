# Ruthless simplicity: intent-first GTM design

**Date:** 2026-08-21
**Status:** Proposed canonical UX/product design
**Scope:** First run, returning operator surface, outreach preparation, GTM intent compilation, progressive disclosure
**Architecture constraint:** Preserve Trevra's current GTM safety, evidence, policy, approval, idempotency, and ledger semantics.

**Related:**

- `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`
- `docs/product-journeys-and-autonomous-work.md`
- `docs/gtm-shell-shape.md`
- `docs/first-run.md`
- `docs/superpowers/specs/2026-08-19-managed-campaign-creation-smoother-design.md`
- `src/client/views/LoopView.tsx`
- `src/client/LinkedInManagerBuilder.tsx`
- `src/server/research/source.ts`
- `src/server/accounts/store.ts`
- `src/server/skills/registry.ts`
- `src/server/playbooks/registry.ts`
- `src/server/agent/tools.ts`

---

## 1. Decision

Trevra should expose **GTM jobs and outcomes**, not its internal GTM machinery.

The founder-facing contract is:

> Tell Trevra what outcome you want. Trevra prepares the work, shows exactly what it will do, and stops wherever your approval or judgment is required.

Trevra keeps its existing durable primitives internally:

- Accounts;
- People;
- Signals;
- lead lists;
- workflows;
- campaigns;
- playbooks;
- skill runs;
- prepared actions;
- policies;
- approvals;
- deliveries and channel outcomes;
- ledger/domain events.

Those nouns remain the implementation and audit model. They stop being concepts a founder must understand before receiving value.

This is a product-surface change, not a simplification of Trevra's safety model.

---

## 2. Product principle

The acceptance test for every default control is:

> Does the founder need to make this decision now?

If **no**, Trevra chooses a safe default.

If **sometimes**, the control moves behind progressive disclosure.

If **yes**, Trevra presents the decision in founder language and preserves the exact underlying state.

Examples:

| Question                                                           | Default treatment                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Which research provider should run?                                | Trevra chooses; provider stays inspectable under Advanced. |
| Which saved workflow object should an ordinary first campaign use? | Trevra chooses a blessed default.                          |
| Should consequential external work require approval?               | Yes by default.                                            |
| Which LinkedIn identity should send when several are configured?   | Founder chooses.                                           |
| Which people should be contacted?                                  | Founder chooses or explicitly reviews a sourced set.       |
| Is an ambiguous external delivery a failure?                       | Never. Preserve `unknown`.                                 |

The target user experience is:

```text
intent
  -> plan
  -> prepared result
  -> human decision when needed
```

The internal execution model remains:

```text
intent
  -> typed plan
  -> durable GTM primitives
  -> policy / limits / suppressions
  -> prepared action
  -> exact approval
  -> execution
  -> outcome + ledger
```

---

## 3. Why now

Trevra already contains most of the hard GTM infrastructure:

- workspace-scoped state;
- account sourcing and persistence;
- account signals and scoring;
- public-site enrichment;
- published-contact discovery;
- AI-visibility audit;
- research briefs;
- evidence-backed drafting and copy critique;
- LinkedIn managed campaigns;
- pacing, safety and outcome feedback;
- durable playbooks;
- agent tools and scopes;
- prepared-action approval semantics;
- append-only execution/audit state.

The missing product layer is not another tool registry or workflow canvas.

It is:

```text
Founder intent
      |
      v
Trevra plan
      |
      v
existing typed primitives
```

The complexity already exists on the correct server side. The founder currently sees too much of it during first run and campaign construction.

---

## 4. Grounding: the current first-run mismatch

The current product contracts already state that a new user should choose an **outcome first** and that a returning operator should resolve the one human decision Trevra cannot safely finish.

However, `src/client/views/LoopView.tsx` currently presents a four-step setup checklist:

```text
Add a LinkedIn account
Build one lead list
Build one workflow
Create your first campaign
```

These are implementation prerequisites, not user outcomes.

A founder does not want to "build a workflow." They want, for example:

> Prepare outreach to these 40 people.

The recent managed-campaign simplification already moved in the correct direction by collapsing campaign construction into one page, defaulting selections, and hiding detailed list/workflow management until explicitly requested.

This design moves one level higher: for the common path, the founder should not have to select or create a lead-list object and workflow object at all.

---

## 5. Founder mental model

The conceptual GTM loop remains:

```text
Find
 -> Understand
 -> Reach
 -> Respond
 -> Learn
```

That is useful as a product model, but it should not become five configuration wizards.

The default application experience should answer two questions:

1. **What do you want Trevra to do?**
2. **What needs you now?**

Everything else is supporting detail.

---

## 6. First-run surface

For a new or materially empty GTM workspace, `/loop` should present jobs, not setup objects.

Recommended primary choices:

### Find prospects

Find companies worth investigating or pursuing.

### Prepare outreach

Turn known people into a safe draft campaign.

### Watch accounts

Monitor target companies and surface source-backed reasons to act.

### Capture inbound

Route website/demo/waitlist/signup submissions into Trevra.

An optional natural-language input may sit below these job starters:

```text
Describe what you want Trevra to do
[ Find 30 Swiss B2B SaaS companies hiring salespeople and prepare LinkedIn outreach ]
```

The starter jobs must work without an LLM. Natural language fills the same typed intent contract; it is not the only interface and it is not the execution engine.

### First-run safety copy

One concise persistent statement is sufficient:

> Nothing is sent just because Trevra prepared it. External actions require approval by default.

Do not make policy configuration part of the initial job selection.

---

## 7. Returning operator surface: Today

The default returning surface should prioritize attention rather than topology.

Founder-facing label recommendation:

| Current label | Proposed label | Route       |
| ------------- | -------------- | ----------- |
| Loop          | Today          | `/loop`     |
| Outreach      | Outreach       | `/outreach` |
| Research      | Research       | `/research` |
| Ledger        | Activity       | `/ledger`   |
| Setup         | Settings       | `/setup`    |

This is a presentation-layer change only. Internal routes and server nouns do not need renaming.

`Today` should first show **Needs you**, then work Trevra is safely doing without human intervention.

Example:

```text
Needs you

Reply from Sarah Chen
LinkedIn · 18m
[Open]

7 messages ready for approval
Campaign: Swiss SaaS founders
[Review]

Sending account paused
Challenge detected
[Resolve]

Working

14 prospects researched
28 actions scheduled
3 accounts changed

[Start new work]
```

A healthy state may simply say:

> Nothing needs you right now.

That is success, not an empty-state failure.

---

## 8. Today server projection

The current Loop client fans out across LinkedIn actions, playbook approvals, limits, analytics and cost. That is acceptable while Loop is primarily an outreach dashboard; it is not the right shape once Today becomes the core human-attention surface.

Add a dedicated read projection:

```http
GET /api/today
```

Suggested response:

```ts
interface TodayPayload {
  needsAttention: TodayItem[];
  working: TodayItem[];
  recentResults: TodayItem[];
}
```

Suggested attention item kinds:

```ts
type TodayItemKind =
  | 'safety_block'
  | 'verified_reply'
  | 'delivery_unknown'
  | 'approval_waiting'
  | 'inbound_submission'
  | 'qualification_decision'
  | 'high_priority_account'
  | 'capacity_block';
```

Every item must contain:

- a stable id;
- workspace-scoped underlying object reference;
- deterministic priority;
- one concise sentence;
- one canonical destination/action;
- created/observed timestamp;
- evidence/reference metadata where relevant.

### Priority order

Use deterministic domain priority, not an LLM:

```text
1. safety / account challenge
2. verified reply
3. ambiguous or unknown external delivery
4. approval waiting
5. high-value inbound
6. qualification decision
7. newly high-priority account
8. capacity / limit blocker
```

Within a class, prefer oldest unresolved first unless the domain requires a different ordering.

---

## 9. Core new abstraction: GTM intent compiler

Do not add a generic automation canvas.

Do not let a model directly create arbitrary executable workflows.

Introduce a bounded **GTM intent compiler** whose input vocabulary describes user goals and whose output is a typed, inspectable plan.

Initial intent contract:

```ts
interface GtmIntent {
  objective:
    | 'find_accounts'
    | 'research_accounts'
    | 'prepare_outreach'
    | 'watch_accounts'
    | 'capture_inbound';

  audience?: {
    description?: string;
    domains?: string[];
    countries?: string[];
    vertical?: string;
    quantity?: number;
  };

  people?: {
    existingListId?: string;
    uploadedInputRef?: string;
    personaDescription?: string;
  };

  channels?: Array<'linkedin' | 'email' | 'community'>;

  autonomy?: 'prepare_only' | 'approval_required';

  timing?: {
    start?: string;
    recurring?: boolean;
  };
}
```

This is plan input, not a new universal commercial entity.

---

## 10. Compiler output: inspectable plan

The compiler returns a preview before state is prepared.

Example:

```text
Your plan

Find
30 Swiss B2B SaaS accounts

Research
Website, hiring and positioning changes

Prioritize
Require source-backed evidence before outreach

People
Use 18 people from founders-switzerland.csv

Reach
LinkedIn

Sequence
Connect
wait 3 days
message
wait 7 days
follow up

Limits
Existing LinkedIn account limits apply

Approval
Nothing will be sent until you approve it
```

Primary CTA:

**Prepare this**

Avoid internal-language CTAs such as:

- Run automation;
- Execute workflow;
- Launch agent.

### API

```http
POST /api/gtm/plan
```

Suggested result:

```ts
interface GtmPlan {
  objective: GtmIntent['objective'];
  summary: string;
  steps: Array<{
    kind: string;
    title: string;
    detail: string;
    externalEffect: boolean;
  }>;
  blockers: Array<{
    code: string;
    message: string;
    actionHref?: string;
  }>;
  defaults: Record<string, unknown>;
  consequences: {
    createsInternalState: boolean;
    externalWrites: boolean;
    approvalRequired: boolean;
  };
  planHash: string;
}
```

The plan must be derivable from typed workspace state. Natural-language interpretation may populate `GtmIntent`; it must not bypass typed validation.

---

## 11. Prepare boundary

Plan preview and preparation are separate operations.

```http
POST /api/gtm/prepare
```

Input:

```ts
interface PrepareGtmPlanRequest {
  plan: GtmPlan;
  planHash: string;
  idempotencyKey: string;
}
```

Rules:

1. Recompute or revalidate all workspace-sensitive plan inputs.
2. Reject stale/mismatched plan hashes.
3. Create only the internal GTM state represented by the plan.
4. Preserve the idempotency key through every composed creation step.
5. Never start a consequential external action merely because the plan was prepared.
6. Return canonical artifact references and the next human-visible destination.

Example:

```json
{
  "status": "prepared",
  "artifacts": {
    "leadListId": "...",
    "workflowId": "...",
    "campaignId": "..."
  },
  "next": {
    "kind": "review_campaign",
    "href": "/outreach/campaign/..."
  }
}
```

---

## 12. Do not add a `gtm_jobs` god object yet

The UI may call something a "job," but that does not justify a new durable universal `gtm_jobs` table.

Trevra already has durable nouns that own real state:

- Account;
- Person;
- Signal;
- Campaign;
- Conversation;
- PlaybookRun;
- SkillRun;
- PreparedAction;
- Delivery.

The intent/plan layer should begin as compilation and orchestration over those objects.

Only add a cross-artifact durable Job entity after a real requirement exists that cannot be represented by correlation ids, plan hashes, runs and canonical artifacts.

---

## 13. First killer workflow: Prepare outreach

Do not start with a universal natural-language GTM agent.

The first materially simpler path should be:

```text
people.csv
  + configured sender
  + safe Trevra defaults
       |
       v
campaign ready for review
```

### User surface

```text
Prepare outreach

People
[ Drop CSV ]

Channel
LinkedIn

Trevra will use
- your configured LinkedIn account
- Trevra's default safe sequence
- your existing account limits and working hours

[Prepare campaign]
```

When multiple senders exist, require a sender choice.

When no sender exists, show one blocker:

```text
One thing is missing
Connect the LinkedIn account you want to use.

[Connect account]
```

Do not show a four-step setup checklist.

### Result

```text
Campaign ready

42 people
LinkedIn
4 touches
~12 working days

Nothing has been sent.

[Review campaign]
```

---

## 14. Outreach preparation endpoint may precede the generic compiler

The fastest implementation does not need `/api/gtm/plan` first.

A narrower server composition endpoint can prove the UX:

```http
POST /api/outreach/prepare
```

Possible input:

```ts
interface PrepareOutreachRequest {
  senderKey?: string;
  existingLeadListId?: string;
  uploadedPeople?: string;
  workflowPreset?: 'default';
  existingWorkflowId?: string;
  name?: string;
  idempotencyKey: string;
}
```

Server behavior:

```text
validate sender
 -> import/reuse people
 -> create/reuse lead list
 -> resolve default workflow
 -> create draft managed campaign
 -> return campaign preview/reference
```

It must never start the campaign.

This immediately removes two implementation concepts from the common first-campaign flow without waiting for the full intent compiler.

---

## 15. Blessed default workflow

A first-time ordinary campaign should not require manual workflow construction.

Trevra should ship a versioned built-in default sequence, for example:

```text
View profile
Invite
Wait 3 days
Message
Wait 7 days
Follow up
```

The exact steps must be selected according to current LinkedIn safety/product decisions and covered by workflow validation.

Recommended identity:

```text
Trevra default — LinkedIn outreach v1
```

Requirements:

- versioned;
- valid under current workflow schema;
- immutable for already-created campaign snapshots;
- clonable/editable by advanced operators;
- never silently rewritten inside an existing campaign;
- default selection may advance only for new preparations.

---

## 16. Default autonomy and policy posture

First-run must not require users to configure permission machinery before seeing value.

Default posture:

```text
research               automatic
scoring                automatic
drafting               automatic
internal preparation   automatic
consequential external approval required
```

Existing channel ceilings, suppressions, working hours and safety guards remain authoritative.

Simplification may hide policy configuration. It must never bypass policy evaluation.

---

## 17. Progressive disclosure contract

The common path is:

```text
Goal
 -> Plan
 -> Result
```

Advanced controls live behind one explicit disclosure such as **Change plan** or **Advanced**.

Examples:

- source provider;
- exact workflow;
- exact sender when only one exists;
- working hours;
- daily ceilings;
- admission policy;
- exclusions;
- campaign priority;
- retention/provider details;
- raw underlying artifact ids.

Progressive disclosure means "not shown until useful," not "removed from the system."

---

## 18. State must remain precise

Ruthless simplicity applies to configuration, not truth.

Never collapse these states:

```text
planned
prepared
waiting approval
approved
scheduled
claimed
sent
failed
unknown
suppressed
```

The UI may translate them into plain founder language, but their semantic distinctions remain durable and inspectable.

In particular:

- `unknown` is not `failed`;
- `prepared` is not `sent`;
- `approved` is not `executed`;
- an external effect is never retried as definitely failed when the outcome is ambiguous.

---

## 19. Evidence contract

Intent-first execution must preserve the exact same evidence guarantees as direct skill execution.

For research and targeting:

- source/provider failure must not masquerade as no result;
- retained evidence/provenance must survive into Account/Signal/brief views;
- retention restrictions remain enforced;
- scores must remain explainable from durable components;
- generated summaries may not replace underlying evidence;
- person/account identity may not be guessed merely to make a plan look complete.

A simpler surface is not permission to make stronger claims than the data supports.

---

## 20. Account-side compiler mapping

### `find_accounts`

Compile into existing company-sourcing and persistence paths:

```text
source provider
 -> gtm.source-leads / account source API
 -> persist Accounts where retention permits
 -> score/sweep as applicable
```

Do not create a second candidate-company model.

### `research_accounts`

Compose existing skills where relevant:

```text
gtm.enrich-company
gtm.visibility-audit
gtm.find-contact
gtm.watch-signal
gtm.research-brief
gtm.score-lead
```

The plan may choose a subset based on the requested objective. It must state which checks will run.

### `watch_accounts`

Compile into existing Accounts, sweep scheduling, Signals and rescoring:

```text
Accounts
 -> scheduled sweeps
 -> Signals
 -> rescoring
 -> Today when something materially changes
```

---

## 21. Person-spine limitation

The Account spine is currently ahead of the universal Person/channel spine.

Trevra can already:

- find companies;
- persist and rank Accounts;
- research companies;
- import reviewed people;
- persist People from inbound/import paths;
- find published contact details;
- source LinkedIn people from supported LinkedIn inputs.

Trevra cannot yet honestly promise a universal flow of:

```text
find arbitrary companies
 -> reliably identify the right role-holder at each company
 -> create one canonical Person across all channels
 -> sequence that Person over LinkedIn/email
```

The intent compiler must expose that limitation rather than hallucinating people.

Example:

```text
30 accounts found.

To prepare outreach, Trevra needs people.

[Upload people]
[Use existing people]
[Find people on LinkedIn]
```

This is still simpler than exposing internal identity architecture.

---

## 22. Person convergence dependency

Before Trevra broadly promises "find and reach the right people," complete the existing GTM OS Person convergence work:

```text
canonical Person persistence
account-person association
LinkedIn identity adapter
email identity adapter
sourced-contact adapter
provenance/conflict handling
dedupe across entry paths
```

Exit criterion:

> One real human encountered through account research, import, inbound, LinkedIn or email is represented as one durable Person with inspectable identities and provenance.

---

## 23. Shared conversation dependency

The later simplification target is:

```text
Reach these people
```

rather than:

```text
Create a LinkedIn campaign
```

That requires the shared conversation work already identified in the canonical GTM OS design:

```text
Conversation
Message
Delivery
Suppression
verified inbound reply ingestion
email + LinkedIn operator view
```

Until that exists, the intent compiler should make channel boundaries explicit rather than pretend they are unified.

---

## 24. Natural-language interface rules

Natural language may be used to produce a `GtmIntent` only.

It must not directly:

- insert campaign rows;
- create arbitrary workflow definitions;
- approve work;
- execute external writes;
- override suppressions;
- override channel limits;
- infer hidden people/account identity;
- suppress validation errors;
- reinterpret an `unknown` external outcome as success/failure.

The server owns normalization and validation of the final intent.

### Model-independent parity

Every supported natural-language job must have an equivalent structured path.

For example:

```text
Prepare outreach

People
[upload CSV]

Channel
[LinkedIn]

Goal
[Book introductory conversations]

[Preview]
```

and:

```text
Reach out to these founders on LinkedIn about our AI visibility audit.
```

must converge on the same typed plan.

---

## 25. Do not build a blank chat product

A blank chat box alone creates:

- prompt anxiety;
- unclear supported capabilities;
- difficult recovery when a request is unsupported;
- temptation to bypass typed domain paths;
- ambiguous mutation boundaries.

The default pattern is:

```text
starter job
+
optional natural language
+
typed plan preview
```

Chat may become a useful command surface later. It is not the information architecture.

---

## 26. Navigation and terminology

Founder-facing navigation should use job language.

Recommended labels:

```text
Today
Outreach
Research
Activity
Settings
```

Internal vocabulary such as `playbook`, `prepared action`, `principal`, `seat_key`, `provider_connection_id` and raw ids belongs in:

- advanced detail;
- Activity/ledger inspectors;
- developer/API surfaces;
- troubleshooting.

It must not be necessary to complete ordinary first-run GTM work.

Do not add a sixth primary nav destination such as **Jobs**.

---

## 27. Marketing implication

Trevra's technical mechanism is a differentiator, but the outcome should be understood first.

Current mechanism-first language such as:

> Run GTM with Claude Code or Codex.

should be evaluated against an outcome-first hierarchy, for example:

```text
Tell Trevra who you want to reach.

It researches the account, prepares the outreach,
and waits for your approval before anything leaves the workspace.

Run it from Claude Code, Codex, or Trevra.
```

The policy/approval/ledger proof remains prominent immediately after the outcome is understood.

This spec does not mandate final marketing copy; it mandates the information hierarchy.

---

## 28. Documentation cleanup required before implementation

Current product documents contain drift from older post-sale/revenue-operations versions of Trevra.

Before implementing this design, reconcile the current contracts so implementation agents do not receive contradictory product boundaries.

Canonical direction should be derived in this order:

1. `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`
2. `docs/product-journeys-and-autonomous-work.md`
3. `docs/gtm-shell-shape.md`
4. `PRODUCT.md`
5. `docs/first-run.md`

Update older documents to the current GTM-only boundary and remove active guidance that reintroduces Money/post-sale ownership.

---

## 29. Explicit non-goals

This design does **not**:

- create a generic Zapier/n8n-style workflow product;
- remove workflows as internal reusable GTM procedures;
- remove lead lists as campaign inputs;
- weaken exact-payload approvals;
- let agents approve their own work;
- let a natural-language model execute external writes directly;
- turn chat into the only user interface;
- create a universal `gtm_jobs` persistence model;
- hide outcome ambiguity;
- silently select an unsafe sending identity;
- silently bypass provider retention rules;
- infer Person identity from weak company/email-name guesses;
- auto-start campaigns after preparation;
- add another primary navigation destination.

---

## 30. Implementation phases

### Phase 0 — product-contract cleanup

Reconcile current GTM-only product docs.

**Exit criterion:** product boundary, primary navigation, first-run contract, returning journey, and agent authority are described consistently across current docs.

### Phase 1 — replace setup onboarding with job choices

Modify `src/client/views/LoopView.tsx`.

Replace the current `OnboardingChecklist` with job starters:

```text
Find prospects
Prepare outreach
Watch accounts
Capture inbound
```

Initially they may route into existing canonical flows without new server abstractions.

Suggested first mappings:

```text
Prepare outreach -> /outreach/new
Find prospects    -> /outreach/accounts (or its current canonical fold/route)
Watch accounts    -> target-account surface
Capture inbound   -> /setup lead-capture surface
```

**Exit criterion:** a new founder is not told to create a list/workflow/campaign as top-level onboarding goals.

### Phase 2 — one-action outreach preparation

Add the narrow composition endpoint and UI described in sections 13–14.

Reuse existing lead import/list persistence, starter workflow validation and `createManagedCampaign`.

**Exit criterion:** with a valid people input and configured sender, the user can go from upload to draft campaign without separately creating a list or workflow.

### Phase 3 — Today projection

Add `GET /api/today` and migrate the Loop attention surface to it.

Rename the visible nav label `Loop` -> `Today` after the projection has enough data to deserve the name.

**Exit criterion:** a returning founder can resolve the highest-priority human item from the first screen.

### Phase 4 — typed GTM plan

Add `/api/gtm/plan` and `/api/gtm/prepare` after at least two job flows require shared compilation behavior.

Start with structured inputs. Add natural-language interpretation as an optional adapter to the typed contract.

**Exit criterion:** each supported job can preview what Trevra will do, create, require, and hold for approval before mutation.

### Phase 5 — account research compilation

Wire `find_accounts`, `research_accounts` and `watch_accounts` into existing account/source/skill paths.

**Exit criterion:** the founder requests a target outcome instead of manually choosing and invoking research utilities for the common path.

### Phase 6 — Person convergence

Complete the canonical Person adapters and cross-channel identity/provenance work.

**Exit criterion:** one real human is referenced consistently across sourcing/import/inbound/LinkedIn/email state.

### Phase 7 — shared conversations

Complete shared Conversation/Message/Delivery/Suppression and verified reply ingestion.

**Exit criterion:** the simple founder job can become "Reach these people" while Trevra truthfully coordinates more than one channel.

---

## 31. Recommended implementation order

Do the work in this order:

1. Fix product-document drift.
2. Replace setup-oriented first-run onboarding with job choices.
3. Make people input -> draft campaign one operation.
4. Build Today as a server-side attention projection.
5. Add the generic typed plan preview only after the narrow path proves the interaction.
6. Compile account sourcing/research into the same plan model.
7. Finish Person convergence.
8. Finish shared email/LinkedIn conversations.
9. Expand natural-language "find and reach X" promises only after identity/channel semantics support them.

Do not build an impressive conversational front end around missing Person/channel semantics.

---

## 32. Acceptance criteria

### First value

A new founder can understand the first useful actions without learning:

```text
playbook
prepared action
principal
workflow
ledger
seat key
provider connection id
```

### Outreach

With valid people input and one configured sender:

```text
upload
 -> preview
 -> campaign ready
```

No separate lead-list creation step is required.

No separate workflow creation step is required.

### Returning use

If Trevra needs human judgment, the highest-priority item is visible on Today.

If no human judgment is required, Today clearly reports that nothing needs the operator.

### Safety

No new path can confuse:

```text
prepared
approved
scheduled
claimed
sent
failed
unknown
```

### Evidence

Research invoked through an intent/job path produces the same durable evidence/provenance semantics as direct skill execution.

### Idempotency

Repeating a prepare request with the same idempotency key cannot create duplicate campaigns/lists/workflows or repeat an external side effect.

### External effects

Preparing a job never starts a campaign or sends a message merely because the requested goal eventually implies outreach.

---

## 33. Final product test

The target experience is:

```text
Founder:
I want to reach Swiss SaaS founders that are struggling with AI visibility.

Trevra:
I can do this in two stages.

1. Find and research Swiss SaaS accounts.
2. Prepare outreach once we have verified people.

I'll use source-backed company evidence and your existing LinkedIn limits.
Nothing will be sent without approval.

[Prepare research]
```

Then:

```text
31 companies found
12 strong fits
7 have usable people
5 have a specific reason to reach out now

[Prepare outreach to 5]
```

Then:

```text
5 outreach sequences prepared.

Nothing has been sent.

[Review]
```

The founder experiences:

```text
intent
 -> result
 -> decision
```

Trevra retains:

```text
identity
tenancy
evidence
signals
scoring
skills
playbooks
campaigns
limits
policies
approvals
idempotency
delivery semantics
audit history
```

The complexity does not disappear.

**It moves to the correct side of the interface.**
