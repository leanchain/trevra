# The GTM shell: current shape

**Status:** Current  
**Supersedes:** the earlier shell plan that treated accounts receivable as a `/money` end of the product.

Trevra is one GTM operating system. The shell reflects the work a founder repeatedly does to acquire, engage, convert, and retain commercial relationships; post-sale project/accounting administration is outside the product.

## 1. The loop

The founder-facing loop is deliberately compact:

```text
Find
  -> Reach
  -> Answer
  -> Qualify / Convert
  -> learn from results
  -> Find again
```

Supporting capabilities cut across those stages:

- **Evidence** — every meaningful finding/action should be inspectable.
- **Guard** — channel policy, pacing, suppression, approval, and stop controls.
- **Cost** — Trevra's own model/agent operating cost, not customer invoice/payment state.
- **Signals** — source-backed observations that change who is relevant or when to act.

There are no Deliver/Bill/Get-paid product stages. Contracts, projects, milestones, invoices and payments are owned elsewhere.

## 2. Primary navigation

The shipped shell has exactly five recurring destinations:

| Label        | Path        | Job                                                                         |
| ------------ | ----------- | --------------------------------------------------------------------------- |
| **Loop**     | `/loop`     | See the GTM loop and its single clearest blocker/next action.               |
| **Outreach** | `/outreach` | Operate targets, sending identities, campaigns, conversations, and replies. |
| **Ledger**   | `/ledger`   | Inspect runs, evidence, approvals, and action history.                      |
| **Research** | `/research` | Explore market/account/community evidence and signals.                      |
| **Setup**    | `/setup`    | Configure access, sources, accounts, limits, team, and capture.             |

`/money` is not a product destination and must not be reintroduced.

## 3. Loop

Loop is the default route. It should answer three questions quickly:

1. Do we have suitable people/accounts to pursue?
2. Is GTM outreach/capture operating safely?
3. Is there a reply, approval, qualification decision, or other exception that needs a human?

The current outbound visualization can use Find / Reach / Answer. As first-class inbound capture and Opportunity mature, Loop may expose conversion state, but only when backed by durable GTM data.

A missing integration is `not connected`, never a zero result.

## 4. Outreach

Outreach is the operational home for relationship initiation and conversation:

- LinkedIn/sending accounts;
- target accounts;
- people/lead lists;
- reusable GTM workflows;
- managed campaigns;
- email and LinkedIn/channel delivery state;
- inbox/conversations;
- suppressions/exclusions;
- pacing/safety controls;
- campaign analytics/outcomes.

A workflow is not a generic automation canvas. Supported actions must have explicit GTM semantics. Arbitrary `webhook` and `external_handoff` workflow nodes are removed.

## 5. Ledger

Ledger is the audit/evidence surface:

- agent runs;
- skill runs;
- playbook runs/steps;
- evidence;
- policy decisions;
- approval payload hashes;
- prepared/executed GTM actions;
- channel action outcomes.

Export preserves nested evidence and policy state. It does not flatten the record into a misleading activity feed.

## 6. Research

Research is for discovering and validating GTM relevance/timing, not storing arbitrary scraped data for unrelated uses.

Good examples:

- account/site/hiring signals;
- public commentary suggesting intent;
- target-account evidence;
- source-provider discovery for prospective accounts;
- research that can feed a GTM playbook or targeting decision.

Every observation should preserve source/provenance and distinguish failure/no-result where operationally important.

## 7. Setup

Setup holds infrequently changed GTM/platform controls:

- agent access and hosted-agent configuration;
- model spend limits;
- Gmail/Microsoft/CRM/research connections;
- LinkedIn account/device configuration;
- exclusions/suppressions and workspace policies;
- team/workspace administration;
- GTM lead-capture sources and signing credentials as that surface lands;
- export/erasure controls.

It does not expose accounting connections, customer Stripe webhooks, generic event-ingest secrets, or arbitrary action-adapter endpoints.

## 8. Always-reachable stop boundary

Stopping consequential automation is shell-level behavior. It must remain reachable regardless of which GTM screen the founder is on.

Stopping/pausing must affect durable queued work, not merely hide UI controls. Claimed external work follows channel-specific uncertain-outcome reconciliation rules rather than blind retries.

## 9. Founder vocabulary

Prefer:

```text
Person
Account
Signal
Conversation
Opportunity
Campaign
Playbook
Prepared action
Delivery
Result
```

Avoid reviving post-sale nouns as Trevra product objects:

```text
Project
Contract
Scope item
Milestone
Invoice
Payment
```

Provider-specific implementation names should not leak into primary navigation.

## 10. Boundary test

Before adding a shell destination or workflow primitive, ask:

> Does this directly help the founder acquire, engage, convert, or retain a commercial relationship, and does Trevra need to own this state/action to operate GTM?

If not, integrate with the external system at a narrow boundary or leave it outside Trevra.
