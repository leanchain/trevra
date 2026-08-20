# Trevra app specification

**Status:** Current  
**Canonical product boundary:** `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`

## 1. The one sentence

> **Trevra is a GTM operating system an agent can operate and a human governs.**

Trevra exists to help a founder acquire, engage, convert, and retain commercial relationships. It owns the GTM state, evidence, policies, approvals, and execution records required to operate that loop safely.

It is not a project-management, contract, accounting, invoicing, payment, application-backend, generic event-bus, or arbitrary webhook-automation product.

## 2. Who does what

| Actor      | Job                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| **Agent**  | Research, source, enrich, score, draft, inspect, and start durable GTM playbooks.                              |
| **Trevra** | Store GTM truth, enforce tenancy/policy/idempotency, persist evidence, and execute named approved GTM actions. |
| **Human**  | Connect sources/accounts, set boundaries, resolve exceptions, and approve consequential external actions.      |

A hosted agent and a laptop agent get the same capability class. Living closer to Trevra does not make the hosted agent more trusted.

Current agent scopes are read/run scopes only:

```text
skills:read
skills:run
runs:read
workspace:read
playbooks:read
playbooks:run
workflows:read
```

There is no agent approval scope, execution scope, or legacy `actions:prepare` scope.

## 3. The GTM loop

A new workspace should be able to get one GTM loop working without configuring an unrelated second product.

A typical outbound first run is:

```text
Sign in
  -> Loop
  -> connect a sending identity
  -> build/import a lead list or target-account set
  -> choose/build a workflow
  -> create a campaign
  -> start
  -> monitor replies / exceptions / opportunity state
```

A typical inbound first run is:

```text
Sign in
  -> Setup -> Lead capture
  -> create a GTM source
  -> connect website form / edge adapter
  -> Person + Inbound Submission arrives
  -> qualify / associate Account when explicitly known
  -> Conversation / Opportunity / Playbook
```

Inbound capture is part of GTM. Arbitrary product telemetry is not.

## 4. Information architecture

The shipped shell has five primary destinations:

| Screen       | Path        | The one question it answers                                          |
| ------------ | ----------- | -------------------------------------------------------------------- |
| **Loop**     | `/loop`     | What is the GTM loop doing, and where does it need attention?        |
| **Outreach** | `/outreach` | Who are we trying to reach, what is going out, and what came back?   |
| **Ledger**   | `/ledger`   | What did Trevra/agents actually do, with what evidence and approval? |
| **Research** | `/research` | Which market/account evidence and signals are worth acting on?       |
| **Setup**    | `/setup`    | What may reach the workspace, what may act, and what limits apply?   |

There is no primary **Money** screen. Post-sale project, agreement, invoice, and collection workflows are outside Trevra.

A control that must always be reachable is shell chrome, not a destination. The stop controls therefore remain available across the app rather than becoming another nav item.

## 5. Screen contracts

### Loop

- **Purpose:** summarize the active GTM loop and name the next exception/action that deserves attention.
- **Primary action:** the single most relevant next GTM action.
- **Empty state:** point to the first missing GTM prerequisite, not to unrelated accounting setup.
- **Never:** report an unavailable signal or channel as a factual zero.

### Outreach

- **Purpose:** operate target accounts/people, sending identities, lead lists, workflows, campaigns, inbox, and channel safety.
- **Primary action:** context dependent; campaign creation/start is the main construction path.
- **Never:** bypass channel pacing, suppression, idempotency, or explicit approval boundaries.
- **Workflow boundary:** no arbitrary webhook or external-handoff nodes. Workflow actions must have GTM semantics.

### Ledger

- **Purpose:** show runs, steps, evidence, policy decisions, approvals, and consequential action records.
- **Primary action:** inspect/export.
- **Never:** imply an action happened when only a plan/draft exists.

### Research

- **Purpose:** inspect source-backed market/account/community evidence that can influence GTM targeting or timing.
- **Primary action:** investigate/save/use evidence in a GTM workflow.
- **Never:** become a general-purpose web data warehouse.

### Setup

- **Purpose:** configure workspace access, provider connections, GTM capture sources, safety limits, team permissions, and agent access.
- **Primary action:** connect the next required GTM capability.
- **Never:** expose provider secrets after creation or mix customer-business finance into workspace configuration.

## 6. Canonical product nouns

The target GTM model is:

```text
Workspace
  -> People
  -> optional Accounts
  -> Inbound Submissions / Signals
  -> Conversations
  -> Opportunities
  -> Campaigns / Playbooks
  -> Prepared Actions / Deliveries
  -> GTM Results
```

Rules:

- A Person can exist without an Account.
- Account association must be explicit/deterministic, never inferred from a free-mail domain or fuzzy name.
- Opportunity is minimal commercial pipeline state, not a revenue/accounting record.
- Conversations unify the founder-facing relationship across supported GTM channels.
- External execution is a closed set of named GTM actions, not an arbitrary remote runtime.

## 7. External-write invariant

**No agent approves its own work.**

A consequential GTM action must pass through deterministic policy and, when required, a human approval over the exact payload. Changing the payload after approval invalidates that approval.

Generic external-write skills cannot execute directly through the skill runner. Named GTM action adapters own external execution. Current prepared playbook execution is intentionally limited to:

```text
email.send
community.reply
crm.log-activity
```

Adding another action requires an explicit GTM use case, bounded payload schema, provider semantics, policy/approval behavior, idempotency/reconciliation, and tests.

## 8. Data/connector boundary

A connector belongs in Trevra only if it either:

1. observes GTM state/evidence; or
2. executes a named GTM action.

Examples that fit: Gmail/Outlook messages, CRM contact/activity context, account-signal providers, LinkedIn GTM operations, website lead capture.

Examples that do not fit: customer accounting systems for invoice/payment ownership, project delivery tools, generic application events, arbitrary webhook endpoints, product database changes.

## 9. Usability contract

- Founder-facing screens use product nouns, not database/worker terminology.
- Every empty state identifies the next useful GTM action.
- Every status that releases external execution comes from real durable state.
- Safety/confidence labels preserve what is known versus inferred/reported.
- One decision should require one save where practical.
- Rare developer/registry tooling stays out of primary founder navigation.

## 10. Definition of done for scope changes

A change is not GTM-only merely because the UI hides a feature. When a capability is cut, remove or close all of these where applicable:

- public/server route;
- type/schema;
- runtime adapter;
- policy/action surface;
- provider catalog/config;
- deployment secret/env knob;
- migration/state ownership;
- tests that assert the old capability;
- current product/integration documentation.

Historical migrations remain forward-only. A new migration removes old domain state from upgraded databases rather than rewriting migration history.
