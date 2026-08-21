# Trevra GTM integration contracts

**Status:** Current  
**Product boundary:** Trevra is a GTM operating system. Integrations may observe GTM state or execute an explicit GTM action. They do not turn Trevra into an accounting system, application backend, generic event bus, or arbitrary webhook runtime.

## Connection identity

Live provider connections are workspace scoped. Trevra stores provider/config connection references; provider credentials remain in the configured credential provider (normally Nango or Trevra secret custody).

A provider connection must never choose a workspace from payload data. The authenticated connection/source determines the workspace.

## Synced canonical records

The Nango canonical sync surface is intentionally narrow. It accepts only GTM records that map onto Trevra's canonical Person, Account, Conversation, and Opportunity-lite state.

### Message

```json
{
  "kind": "message",
  "id": "provider-message-id",
  "accountName": "Acme Labs",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "direction": "inbound",
  "subject": "Re: proposal",
  "body": "Can we talk on Thursday?",
  "occurredAt": "2026-08-20T09:00:00.000Z",
  "externalUrl": "https://provider.example/message/123"
}
```

### Opportunity

```json
{
  "kind": "opportunity",
  "id": "provider-opportunity-id",
  "accountName": "Acme Labs",
  "personName": "Maya Chen",
  "personEmail": "maya@acme.example",
  "title": "Expansion conversation",
  "status": "proposal",
  "proposalSentAt": "2026-08-18T09:00:00.000Z",
  "expectedResponseAt": "2026-08-25T09:00:00.000Z",
  "externalUrl": "https://provider.example/opportunity/123"
}
```

Opportunity is minimal GTM progression state. Its bounded stages are `new`, `qualified`, `meeting`, `proposal`, `won`, and `lost`; it does not own amount, forecast, accounting currency, delivery milestones, contracts, projects, or payment state.

## Explicit GTM execution actions

External writes use Trevra's prepared-action / exact-payload approval boundary. The execution registry is closed, not user-programmable.

Current prepared execution action types are:

- `email.send` — send through a connected Gmail or Microsoft 365 mailbox.
- `community.reply` — publish a governed reply through a supported GTM community channel.
- `crm.log-activity` — append a GTM activity to a connected CRM record.

There is no generic remote-action adapter and no arbitrary webhook action. A new external write requires a named GTM action, a bounded payload schema, policy/approval semantics, a dedicated adapter, and tests.

## Nango sync behavior

A Nango sync is resolved from the registered provider configuration and external connection identity to exactly one Trevra workspace. Ambiguous connection ownership is refused.

For each returned record Trevra:

1. removes Nango transport metadata;
2. maps only a supported GTM model alias;
3. validates the bounded canonical schema;
4. stores source evidence with workspace/provider identity;
5. deterministically resolves a canonical Person and optional Account identity;
6. records provider identity evidence and upserts the GTM message or Opportunity-lite state.

Unsupported models are counted as skipped rather than silently treated as a successful empty sync.

## Inbound website lead capture

Website/form ingestion is **not** the old generic `/api/events` route. It is a GTM-specific capture source contract described in `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`; the operator/integrator runbook is `docs/lead-capture.md`.

The intended resource model is:

```text
Workspace
  -> GTM/Capture Source
  -> Person
  -> Inbound Submission
  -> optional Account association
  -> Signal / Opportunity / Conversation / Playbook
```

The request never supplies the destination workspace. The authenticated GTM source determines it.

## CRM integrations

HubSpot and Attio may observe GTM records. CRM activity write-back is a dedicated `crm.log-activity` action behind Trevra's approval/execution boundary. Do not add ungated record mutation to the sync path.

## Provider admission rule

A connector belongs in Trevra only when it does at least one of these:

1. **Observe GTM state** — People, Accounts, Conversations, GTM signals, Opportunities, and campaign/reply outcomes.
2. **Execute a GTM action** — a bounded founder-approved outreach or CRM action.

Do not add providers whose primary purpose is customer accounting, invoicing, project delivery, contract administration, arbitrary application telemetry, generic storage, or arbitrary webhook automation.

## Explicitly removed / unsupported

Trevra does not expose or own customer-business:

- projects;
- contracts / clauses;
- scope items / commitments / deliverables;
- milestones;
- invoices;
- payments;
- accounting-provider actions;
- customer Stripe payment webhooks;
- generic `/api/events` ingestion;
- generic remote action adapters;
- campaign workflow `webhook` or `external_handoff` primitives.

Trevra's own future SaaS subscription billing is a separate platform concern and must not recreate these customer-business entities.
