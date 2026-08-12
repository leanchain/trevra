# What Trevra owns, and what it borrows

The question this page answers: *why is there a `clients` table at all when the
team already pays for HubSpot?*

---

## The rule

**Trevra is a system of REFERENCE, not a system of RECORD** — except for the
revenue graph, which no CRM models.

Every object below has exactly one owner. Where the owner is external, Trevra
keeps a thin projection so it can reason and rank, and treats the external
system as truth on conflict.

| Object | System of record | What Trevra keeps | Why |
|---|---|---|---|
| Contacts, companies | **HubSpot / Attio** | `clients` — 10 columns, plus `contact_identities` | Ranking needs a name, an email and a last-touch date. It does not need 300 CRM properties. |
| Deals, pipeline stage | **HubSpot / Attio** | `opportunities` projection | Stage is the CRM's to move. Trevra reads it. |
| Invoices, payments | **Xero / QuickBooks / Stripe** | `invoices`, `payments` projection | Accounting is regulated and reconciled. Never Trevra's call. |
| Email | **Gmail / Outlook** | `messages` projection | The mailbox is the archive. |
| Calendar | **Google / Microsoft** | — | Read at query time. |
| **Contract → scope → milestone → deliverable** | **Trevra** | full model | **No CRM has this.** HubSpot stops at closed-won; accounting starts at invoice. This is the gap. |
| **Skill runs, playbook runs, approvals, evidence** | **Trevra** | full model | The audit trail of what an agent did and who approved it. Nothing else owns it. |
| **Outreach threads, post log, cooldowns** | **Trevra** | full model | Rate limits are per-workspace operational state. A CRM has no concept of a subreddit cooldown. |

`clients` is 10 columns. That is the evidence for the claim: it is an index, not
a CRM.

---

## Write-back: activity, never records

Until now the CRM connectors were read-only, which meant a founder could approve
outreach, watch it post — and the team's CRM never learned. For anyone whose
SDRs live in HubSpot, that made the work invisible.

Write-back now exists, and is deliberately the narrowest thing that closes the
loop:

| Trevra writes | Trevra never writes |
|---|---|
| A note on an **existing** contact | A new contact |
| …with the subject, body, link and evidence | Any contact property |
| …timestamped, attributed to an approved action | A deal, stage, amount, or owner |

Why so narrow: a second writer is how two systems start disagreeing. The worst
case here is a note nobody wanted. There is no path that mutates a pipeline.

**It will not invent a contact to have somewhere to write.** The common outcome
for community outreach is `skipped` — a GitHub handle usually belongs to nobody
in the CRM. Creating records from forum handles is how a sales database turns to
noise, and it is the one thing a CRM owner never forgives. The miss is still
recorded in `crm_activities` so "we could not attribute this" is countable.

### How it runs

```
approved action  ──▶  external write  ──▶  crm.log-activity
     │                    (post/email)          │
  payload hash                                best-effort,
  gates both                                  never fails the action
```

- Action type **`crm.log-activity`**, usable standalone from any playbook.
- Automatically after a community reply — *after* the post, best-effort. The
  reply is already public; a CRM outage must never turn a delivered reply into a
  failed action the engine then retries.
- Reached through the **Nango proxy**, so no Nango action script has to be
  deployed. A connected HubSpot works on day one.
- Idempotent per source: an action retry cannot leave two identical notes. Same
  claim-before-write discipline as the outreach post log — a 4xx releases the
  claim, an unknown outcome holds it.

### Turning it off

No new setting. Deny the existing policy:

```sql
INSERT INTO workspace_policies (id, workspace_id, name, priority, action_pattern, effect, enabled)
VALUES ('pol_no_crm_write', 'YOUR_WS', 'No CRM writes', 100, 'action:crm.log-activity', 'deny', TRUE);
```

The policy engine already gates every action; a bespoke toggle would be a second
place to look.

### Scopes to grant

| CRM | Scopes | Notably absent |
|---|---|---|
| HubSpot | `crm.objects.contacts.read`, `crm.objects.notes.write` | `crm.objects.contacts.write` — so it *cannot* edit a contact even if a future bug asked it to |
| Attio | record read, note write | record write |

---

## Small teams vs big teams

| | Small team / solo | Big team |
|---|---|---|
| CRM | Often none. `clients` is the whole CRM, populated by Gmail + Stripe sync and CSV import. | HubSpot/Attio is truth; Trevra projects from it and writes activity back. |
| Approvals | The founder approves everything. | **Gap** — no queue, assignment, or per-user routing. `workspace_policies` is the mechanism; nothing drives it. |
| Delivery graph | The main draw. | Also the main draw — it is the half no incumbent has. |
| Outreach | Manual handoffs are fine at 3–5/day. | Caps are per workspace, not per seat. Multi-seat outreach needs per-user accounting. |

The honest statement: **the data model is ready for big teams; the product
surface is not.** Multi-user approval routing is the next real gap, not more
connectors.

---

## One licensing constraint

From [`connector-vendors.md`](./connector-vendors.md): Nango is **ELv2**.
Self-hosting Trevra with Nango is permitted. A paid Trevra Cloud that resells
Nango's OAuth flows as a feature likely is not, without a commercial agreement.

This bites precisely when selling to big teams — the ones who want hosted. Worth
resolving before that becomes the go-to-market motion, not after.

---

## Adding a CRM

One file in `src/server/crm/adapters/`, one entry in `registry.ts`. The adapter
declares `writes` — a plain-language list shown on the connect screen — and
implements exactly two methods: `findContact` (by email only, never by handle)
and `logActivity`. A provider with no adapter simply cannot be written to, which
is the safe default.
