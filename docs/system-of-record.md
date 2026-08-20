# What Trevra owns, and what it borrows

**Canonical product boundary:** `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`.

---

## The rule

**Trevra is the system of record for GTM operational state and agent execution. It is not the system of record for the rest of the business.**

Trevra must contain enough local state to let founders and agents safely operate GTM even when no CRM is connected. When an external system owns a richer business record, Trevra keeps only the projection/link/evidence required to operate GTM and treats the external owner as authoritative for its own fields.

| Object                                                                       | Trevra role                                                                                | External owner when present                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| People used by GTM                                                           | **GTM operational truth**: explicit identity, provenance, channel identities, suppressions | CRM may own richer contact properties                            |
| Accounts targeted by GTM                                                     | **GTM operational truth**: domain, targeting, signals, score, tags                         | CRM may own richer company properties                            |
| Inbound submissions                                                          | **System of record**                                                                       | Website/landing runtime only transports them                     |
| GTM signals                                                                  | **System of record**                                                                       | Source systems remain evidence providers                         |
| Campaigns / playbooks                                                        | **System of record**                                                                       | —                                                                |
| Conversations required for Trevra execution                                  | **GTM operational truth**                                                                  | Gmail/Outlook/LinkedIn remain provider archives where applicable |
| Suppressions / consent enforcement                                           | **System of record for Trevra execution**                                                  | Provider/CRM may contribute additional constraints               |
| Agent runs, skill runs, approvals, evidence, prepared actions                | **System of record**                                                                       | —                                                                |
| Opportunity-lite                                                             | **Minimal native GTM state when needed**                                                   | CRM may be authoritative for its canonical deal/pipeline record  |
| CRM-specific custom properties, ownership, territory, pipeline configuration | Projection/link only                                                                       | **CRM**                                                          |
| Calendar                                                                     | Read/use for GTM                                                                           | **Google / Microsoft**                                           |
| Product analytics                                                            | Not Trevra core                                                                            | Product analytics system                                         |
| Accounting, invoices, payments                                               | Not Trevra core                                                                            | Accounting/payment systems                                       |
| Contracts, projects, milestones, deliverables                                | Not Trevra core                                                                            | Appropriate external business system                             |

Legacy tables for non-GTM concepts may remain during migration. They are not part of the target architecture and new GTM features must not depend on them.

---

## CRM boundary

Trevra should work without a CRM but should not try to replace one.

### Without a CRM

The founder can operate with Trevra's minimal People, Accounts, Conversations, Signals, Campaigns, and Opportunity-lite state.

### With a CRM

The CRM remains authoritative for CRM-specific records and fields. Trevra continues to own the operational GTM state required by its agents, campaigns, safety controls, approvals, and execution ledger.

Do not copy every CRM property into Trevra.

---

## Write-back: activity, never records by default

The current CRM write-back boundary is intentionally narrow and remains the safe default:

| Trevra writes                                         | Trevra does not write by default        |
| ----------------------------------------------------- | --------------------------------------- |
| A note/activity on an **existing** contact            | A new CRM contact                       |
| Subject/body/link/evidence for an approved GTM action | Contact/company properties              |
| Timestamp/source attribution                          | Deal stage, owner, amount, or territory |

A second silent writer is how two systems begin disagreeing.

Trevra must not invent a CRM contact merely to have somewhere to write an activity. A failed match is a valid, auditable `skipped` result.

### How it runs

```text
approved GTM action
  -> external execution
  -> crm.log-activity (best effort)
```

The CRM activity write must not cause an already-delivered external action to be retried.

The existing claim/idempotency discipline remains required.

### Turning CRM write-back off

Use the existing policy layer rather than adding a second bespoke switch:

```sql
INSERT INTO workspace_policies (id, workspace_id, name, priority, action_pattern, effect, enabled)
VALUES ('pol_no_crm_write', 'YOUR_WS', 'No CRM writes', 100, 'action:crm.log-activity', 'deny', TRUE);
```

### Current scopes

| CRM     | Scopes                                                 | Intentionally absent         |
| ------- | ------------------------------------------------------ | ---------------------------- |
| HubSpot | `crm.objects.contacts.read`, `crm.objects.notes.write` | `crm.objects.contacts.write` |
| Attio   | record read, note write                                | record write                 |

If Trevra later needs broader CRM mutation, that requires an explicit design for authority, field ownership, conflicts, scopes, approvals, and reconciliation. It must not arrive as an incidental connector expansion.

---

## Agents and provider credentials

Agents are GTM principals, not credential containers.

Provider credentials belong to workspace connections in Nango/Secret Manager or the provider-appropriate custody layer. An Agent may receive permission to use a connection capability, but it must not receive or persist the underlying secret.

---

## Small teams vs larger teams

|                                    | Solo founder / small GTM team               | Team with CRM                             |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------- |
| Core operating surface             | Trevra                                      | Trevra                                    |
| CRM required                       | No                                          | Optional/likely                           |
| People/Accounts                    | Trevra's minimal GTM identity is sufficient | Trevra GTM projection + CRM richer record |
| Opportunity                        | Trevra Opportunity-lite                     | CRM can be authoritative                  |
| Campaigns/actions/approvals/agents | Trevra                                      | Trevra                                    |
| CRM activity visibility            | n/a                                         | Best-effort activity write-back           |
| Accounting/project/revenue state   | Outside Trevra                              | Outside Trevra                            |

The product should scale by adding better principal permissions, team queues, assignment, and CRM interoperability—not by expanding Trevra into a general CRM or business-management suite.

---

## One connector licensing constraint

From `connector-vendors.md`: Nango is ELv2. Self-hosting Trevra with Nango is permitted. A paid hosted Trevra offering that resells Nango's OAuth flows may require a commercial agreement. Resolve this before hosted connector volume becomes material.

---

## Adding a CRM

The current adapter pattern remains intentionally small: one adapter file, one registry entry, explicit `writes`, contact lookup, and activity logging.

A provider with no adapter cannot be written to. Safe absence is preferable to generic fallback mutation.
