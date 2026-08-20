# Product journeys and GTM usability contract

**Status:** Current  
**Product scope:** GTM only.

This document describes how a founder should move through the shipped Trevra product without learning the internal schema or worker architecture.

## 1. Product shell

Trevra has five primary destinations:

| Destination  | Job                                                                             |
| ------------ | ------------------------------------------------------------------------------- |
| **Loop**     | Show where the GTM loop is stuck and surface the next human decision.           |
| **Outreach** | Operate sending identities, targets, campaigns, conversations, and replies.     |
| **Ledger**   | Inspect what agents/workflows did and the evidence/approval behind it.          |
| **Research** | Investigate source-backed market/account/community signals.                     |
| **Setup**    | Configure access, providers, GTM sources, limits, and workspace administration. |

There is no Money/post-sale destination. Migration 095 removes Trevra-owned project, contract, scope, milestone, invoice and payment state.

## 2. Agent operation

- Claude Code/Codex and Trevra's hosted agent use the same read/run capability class.
- Agents can inspect skills/playbooks, run skills, start durable playbooks, and inspect run/event ledgers.
- Agents cannot approve or directly execute consequential work.
- Exact approved payloads, policy decisions, idempotency claims and results are durable Trevra state.
- Model budget/cost controls are Trevra platform controls, not customer revenue/accounting features.

## 3. Outbound founder journey

Goal: safely turn a target set into conversations and commercial opportunities.

```text
Sign in
 -> Loop
 -> Outreach -> LinkedIn/sending account
 -> build/import targets or lead list
 -> choose/build workflow
 -> create campaign
 -> preview/start
 -> Inbox / conversation
 -> qualify / Opportunity
 -> learn from outcome
```

The founder should not need to know `seat_key`, leases, replay scopes, provider connection IDs, or queue table names.

### Campaign prerequisites

A campaign construction flow should make the dependency order obvious:

1. a configured sending identity;
2. people/lead list;
3. a reusable GTM workflow;
4. campaign configuration;
5. start/approval where policy requires it.

Generic webhook or arbitrary downstream-handoff nodes are not valid workflow primitives.

## 4. Inbound founder journey

Goal: route real commercial inbound demand into Trevra without turning Trevra into the startup's application backend.

```text
Setup -> Lead capture
 -> create GTM source
 -> copy source/signing configuration into website backend/edge function
 -> visitor submits contact/demo/waitlist/signup form
 -> Trevra Person
 -> immutable Inbound Submission
 -> optional Account association when explicitly known
 -> qualification / Conversation / Opportunity / Playbook
```

A Person does not require an Account. The source credential determines the workspace; request data never chooses the tenant.

## 5. Research / signal journey

Goal: decide who is worth attention and why now.

```text
Research / account source
 -> source-backed observations
 -> Signal / account evidence
 -> qualification / scoring
 -> target list or Playbook
 -> result feeds back into future targeting
```

No collector may turn provider failure into a false empty result when the distinction matters. Evidence/provenance must survive into the decision.

## 6. Returning operator journey

Goal: spend attention only where deterministic automation cannot safely finish the job.

```text
Loop
 -> one blocker / approval / reply / safety exception
 -> resolve
 -> Loop
```

Typical exceptions:

- sending account paused/challenged;
- playbook waiting for approval;
- ambiguous/unknown external delivery outcome;
- inbound reply requiring a human answer;
- missing enrichment/source evidence;
- opportunity qualification decision;
- exhausted channel/campaign limit.

## 7. Team owner journey

Goal: collaborate without expanding every member/agent into an administrator.

- Workspace roles remain server-enforced.
- Destructive/security-sensitive controls remain owner-only where specified.
- Agent tokens are independently scoped and revocable.
- Provider credentials remain in the provider-appropriate custody layer and are never handed to agents as plaintext.
- Workspace export/erasure remains explicit and auditable.

## 8. Information architecture vocabulary

Primary outreach language should describe the founder's mental model:

- **LinkedIn/sending accounts** — identities that act on a channel.
- **Target accounts** — companies worth pursuing.
- **People** — real commercial humans.
- **Lead lists** — campaign audiences/input sets.
- **Workflows** — reusable GTM sequences/branches.
- **Campaigns** — an audience + workflow + sending identity/control set.
- **Inbox / Conversations** — relationship communication.
- **Opportunities** — minimal pipeline state.

Do not use project/accounting nouns as Trevra product navigation.

## 9. Empty-state contract

Every empty screen should answer `what next?` with a real GTM prerequisite derived from durable state.

Examples:

- no sending identity -> connect one;
- no targets -> source/import targets;
- no workflow -> build/choose one;
- no campaign -> create one;
- no research sources -> add/use a GTM source;
- no runs -> start from the GTM surface that creates work;
- no inbound source -> create Lead capture source.

No `onboarding_completed` flag should substitute for real state.

## 10. Safety and truthfulness contract

- `planned`, `approved`, `claimed`, `sent`, `failed`, and `unknown` are different states and must remain distinguishable.
- Never retry an ambiguous external side effect as if it definitely failed.
- Never let an agent approve its own consequential output.
- Preserve HARD FACT / reported/inferred distinctions where the product exposes them.
- Never claim attribution the data does not support.
- Never infer prospect Account identity merely from an email domain/name.
- Never treat a consent assertion as universal channel permission.

## 11. Product boundary

Trevra owns enough state to operate GTM independently of a CRM, but it does not own the rest of the customer's business.

Outside Trevra:

- project delivery;
- contracts / statements of work;
- scope administration;
- milestones / deliverables;
- customer invoices / payments / accounting;
- arbitrary application telemetry;
- generic webhooks / remote actions;
- application databases/backend runtime.

Narrow integrations may read context or write an approved GTM activity without importing the external system's whole data model.

## 12. Release-work rule

A product-scope removal is complete only when runtime, persistence, tests, deployment configuration, dependencies, and current documentation all agree on the boundary. Hiding a menu item is not a removal.
