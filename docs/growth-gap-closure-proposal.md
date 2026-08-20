# Proposal: Close the growth gap inside Trevra before retiring `e-commerce/growth`

**Status:** Proposed  
**Date:** 2026-08-20  
**Scope:** Trevra only. The e-commerce repository remains unchanged until the exit criteria in this document are satisfied.

---

## 1. Decision

Trevra should become the sole GTM operating system for the founder from prospect discovery/inbound capture through conversation, qualification, opportunity outcome, and follow-up, while the Beseam e-commerce backend remains an optional source of domain intelligence.

The migration rule is deliberately one-way:

1. Close every runtime and safety gap in Trevra.
2. Prove Trevra can operate the loop independently.
3. Migrate state from `e-commerce/growth` into Trevra.
4. Only then remove `e-commerce/growth`.

Do **not** port the Python growth application literally. Trevra already has stronger primitives for accounts, skills, durable playbooks, approvals, policy, execution, and the run ledger. The work is to preserve the remaining growth behaviours inside those primitives.

The target ownership model is:

```text
Trevra
  owns:
    prospect/account identity
    contacts
    sourcing orchestration
    enrichment / score / audit / draft
    approval
    cold-outreach safety
    email delivery state
    inbound reply ingestion
    suppressions
    funnel / opportunity state
    conversations / verified replies
    ledger / evidence
    GTM outcomes such as qualified / won / lost / disqualified

Beseam e-commerce backend
  optionally provides:
    e-commerce-specific candidate intelligence

No Trevra runtime path depends on the Python growth service.
```

This preserves the repository boundary in `AGENTS.md`: models may interpret commercial content, while deterministic software owns state transitions, approvals, permissions, policy, and external execution.

---

## 2. Why this is now a Trevra completion project, not a port

The original `docs/founder-skills.md` assessment is stale in an important way. Trevra now already contains most of the control plane it proposed.

### Already present in Trevra

| Capability                                 | Current Trevra owner                                                         | Decision                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Account identity                           | `migrations/039_accounts.sql`, `src/server/accounts/*`                       | Keep. Do not recreate a `leads` table.                                        |
| Generic lead sourcing                      | `src/server/research/source.ts` (`gtm.source-leads`)                         | Extend with providers.                                                        |
| Enrich                                     | `src/server/skills/enrich.ts`                                                | Keep.                                                                         |
| Score                                      | `src/server/skills/score.ts`                                                 | Keep.                                                                         |
| Audit                                      | `src/server/skills/audit.ts`                                                 | Keep.                                                                         |
| Draft                                      | `src/server/skills/draft.ts`                                                 | Keep.                                                                         |
| Ladder rule                                | `src/server/skills/ladder.ts`                                                | Reuse for outreach lifecycle rules.                                           |
| SSRF guard                                 | `src/server/skills/guard.ts`                                                 | Reuse for directory/source fetches.                                           |
| Skill ledger                               | `src/server/skills/runner.ts`                                                | Keep.                                                                         |
| Durable orchestration                      | `src/server/playbooks/engine.ts`                                             | Keep.                                                                         |
| Exact-payload approval                     | `src/server/playbooks/engine.ts`, `src/server/action-service.ts`             | Keep. This is stronger than the growth implementation.                        |
| Email execution                            | `src/server/control-plane/execution.ts`, `src/server/integration-service.ts` | Reuse transport; add cold-outreach safety.                                    |
| Gmail / Microsoft 365 provider integration | Nango-backed integration service                                             | Keep. Do not add a new SMTP subsystem.                                        |
| Audit-led outreach playbook                | `gtm.audit-led-outreach` in `src/server/playbooks/registry.ts`               | Extend send semantics, do not rewrite.                                        |
| Domain event ledger                        | `src/server/control-plane/events.ts` and `domain_events`                     | Reuse.                                                                        |
| Opportunity-lite                           | `opportunities`                                                              | Keep minimal GTM pipeline state; do not rebuild post-sale revenue/accounting. |

### Still missing or incomplete

The real remaining gap is narrower:

1. E-commerce-oriented sourcing adapters:
   - operator-supplied directory/listicle crawling;
   - Beseam intelligence as an optional candidate provider.
2. A generic prospect contact model attached to `accounts`.
3. A generic email outreach thread/message/delivery model.
4. Cold-email-specific send invariants on top of Trevra's existing action engine.
5. Generic workspace suppressions for email/domain outreach.
6. Inbound Gmail/Microsoft reply ingestion with verified thread matching.
7. Reply/bounce/unsubscribe lifecycle transitions and inbox APIs.
8. A durable link from account/person/outreach outcome into minimal Opportunity state and explicit GTM outcomes.
9. Cutover tooling and parity tests proving the Python growth service is redundant.

`src/server/outreach/reply.ts` does **not** close item 6. It drafts replies to public/community threads; it is not inbound email reply ingestion.

---

## 3. Product invariant: Trevra has one GTM spine

Do not introduce a second CRM-shaped tree under names copied from the Python app.

The GTM spine has two valid entry shapes:

```text
Outbound / account-led
  Account
    -> Person
    -> Outreach thread
    -> Outreach message / delivery
    -> Reply outcome
    -> Opportunity
    -> Won | Lost | Disqualified

Inbound / person-led
  Website / product / form
    -> Person
    -> Inbound submission
    -> optional Account association
    -> qualification / conversation
    -> optional Opportunity
```

A Person does **not** require an Account. Outbound company discovery converges at `accounts`; inbound website/product capture converges at the shared Person model. When a real company identity is explicitly known, both paths can be associated without creating a second lead database.

This follows the intent of migration `039_accounts.sql` for company identity while keeping inbound people independent of company identity. The generic capture boundary is specified in `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`, and the canonical GTM-only product boundary is `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`.

### Proposed new nouns

#### `contacts`

One canonical Person inside a workspace.

Suggested fields:

```text
id
workspace_id
name
email
email_normalized
phone
phone_normalized
role
created_at
updated_at
```

Constraints:

- every query/write is workspace scoped;
- deterministic normalized email/external identity prevents duplicate People where practical;
- a Person can exist without an Account;
- fuzzy names and email domains never invent identity/company links;
- conflicting source values do not silently overwrite operator-owned canonical fields.

#### `account_contacts`

Optional association between a Person and an Account when a real company relationship is explicitly known.

Suggested fields:

```text
workspace_id
account_id
contact_id
role
source
confidence
created_at
updated_at
```

Constraints:

- workspace-scoped foreign keys;
- unique `(workspace_id, account_id, contact_id)`;
- source/provenance survives later enrichment;
- neither inbound capture nor Person existence depends on this association.

#### `outreach_threads`

One channel-specific outreach relationship with one contact/account.

Suggested fields:

```text
id
workspace_id
account_id
contact_id
channel                 -- initially email; generic enough for later channels
stage                   -- new -> enriched -> scored -> audited -> drafted -> approved -> sent -> replied/bounced
wedge
source_playbook_run_id
last_event_at
created_at
updated_at
```

`gtm.lead-status` remains the deterministic transition rule. Persistence belongs here, not inside the skill.

#### `outreach_messages`

Individual inbound and outbound messages.

Suggested fields:

```text
id
workspace_id
thread_id
direction               -- in | out
subject
body_text
body_html
status
provider
provider_message_id
internet_message_id
in_reply_to_message_id
sent_at
received_at
error
created_at
```

Message content is commercial data and must remain workspace-scoped. It must never leak into analytics.

#### `outreach_deliveries`

The durable external-write claim and reconciliation record for outbound email.

Suggested fields:

```text
id
workspace_id
thread_id
message_id
payload_hash            -- unique within workspace, preferably globally unique by construction
provider
provider_message_id
internet_message_id
status                   -- claimed | sending | sent | failed | uncertain
claimed_at
sent_at
last_error
created_at
updated_at
```

This table is not optional. It closes the ambiguous-send retry gap described in section 6.

#### `outreach_suppressions`

Workspace-wide suppression, independent of campaign/playbook.

Suggested fields:

```text
id
workspace_id
email_normalized nullable
domain_normalized nullable
reason
source                   -- manual | unsubscribe | bounce | import | migration
source_message_id nullable
created_at
```

At least one of email/domain must be present.

A suppression applies to every future outreach path in the workspace, not merely the campaign that created it.

---

## 4. Sourcing design

Trevra already has the correct abstraction: `gtm.source-leads` selects a research provider and returns candidate companies. Discovery must become providers, not a parallel source runner and not a copy of another product's storage tree.

The governing rule is:

> Trevra owns prospects, evidence, and actions -- not the system prospects were discovered in.

### 4.1 Generic file/paste import

The account import path must remain a first-class source and accept common operator-owned formats without a Trevra-specific export step:

- newline-separated domains;
- CSV with or without headers;
- JSON arrays of strings or account objects;
- JSON envelopes containing `accounts` or `candidates` arrays;
- browser-selected or dropped `.csv`, `.json`, and `.txt` files.

Every format normalizes into the existing `accounts` spine. No source-specific account table is introduced.

### 4.2 Directory provider

Provider:

```text
src/server/research/providers/directory.ts
```

Input:

```json
{
  "provider": "directory",
  "urls": ["https://example.com/best-companies"],
  "limit": 100
}
```

Required invariants:

- bounded URL count and bounded candidate count;
- structural SSRF checks before fetch;
- SSRF revalidation on redirects through Trevra's guard path;
- ignore directory-self links;
- filter obvious social/platform/infrastructure hosts;
- filter non-prospect suffixes such as `.gov`, `.edu`, `.mil`;
- structural public-host validation for candidates;
- first candidate wins on in-batch dedupe;
- evidence includes the directory URL that produced the candidate.

The provider returns candidates only. Persistence/dedup into `accounts` remains a shared Trevra concern.

### 4.3 Existing shop artifacts: direct folder import, no Beseam candidates API

Do not carry the current Python -> Temporal -> `SingleActivityWorkflow` bridge into Trevra, and do not add a Beseam candidates endpoint solely to move the existing shop corpus.

The e-commerce repository already materializes the generic company identity Trevra needs: `shops/domains/<domain>/domain_summary.json` contains a top-level `domain` plus optional platform/provenance metadata. Trevra's account screen accepts the whole folder directly.

Target migration path:

```text
e-commerce/shops/
  -> browser Choose folder
  -> local manifest scan
  -> editable Import Review with provenance
  -> confirmed compact { accounts: [...] } payload
  -> POST /api/accounts/import
  -> accounts
```

The browser does not upload every product, collection, page, or crawl artifact. It reads likely small JSON manifests locally, extracts only top-level company identities, ignores unrelated artifacts, and opens a review table before import. Invalid/duplicate domains remain visible, exact source file/field provenance is shown, operator edits are explicit and resettable, and only included rows are serialized through Trevra's normal account import path.

This keeps Trevra generic: the importer recognizes company-shaped JSON rather than a Beseam directory schema. `domain_summary.json` works because it already satisfies that generic contract, not because Trevra knows what a Beseam shop is.

Deployment-owned HTTP providers remain available for future live intelligence systems, but they are optional and are not a cutover dependency.

The exact import/provider behavior lives in `docs/source-providers.md`.

---

Do not use `sendTransactionalEmail()` for cold outreach, and do not add a separate SMTP subsystem.

Do not overload generic `email.send` with hidden cold-outreach behaviour either.

Introduce a dedicated prepared-action type:

```text
outreach.email.send
```

Transport still routes through the existing Gmail/Microsoft 365 integration path. The new action adds a deterministic safety envelope around it.

### Required execution order

```text
exact approved payload
  -> durable atomic delivery claim
  -> normalize recipient/domain
  -> suppression check
  -> workspace/channel daily-cap check
  -> provider / connection configured check
  -> required compliance fields check
  -> external send
  -> persist provider identifiers + internet Message-ID
  -> mark delivery sent
  -> mark outreach message sent
  -> advance thread to sent
  -> append domain events
```

### Required invariants

The following behaviours from `e-commerce/growth/outreach/sending.py` are product requirements, not implementation details:

1. **No double claim.** Only one worker can own a send attempt.
2. **No suppressed send.** Email and account domain are checked immediately before external execution.
3. **Daily cap is authoritative.** A send above the configured cap is refused.
4. **No fake send.** Missing provider credentials/connection is a hard failure, never simulated in production.
5. **The exact approved payload is what executes.** Trevra already provides this invariant and it must remain structural.
6. **External writes use deterministic idempotency identity.** This is already required by `AGENTS.md`.
7. **Ambiguous external success is not automatically retried.** See section 6.

The generic skill runner must not execute this action. `AGENTS.md` already requires external-write skills/actions to pass through the dedicated approval/execution boundary.

---

## 6. Close the ambiguous-send / double-email failure mode

Trevra's playbook engine already atomically claims a pending step before execution and leases it. That prevents two workers from executing the same pending step concurrently.

It does **not by itself** prove that a retry is safe after the provider may have accepted the message but Trevra failed before persisting completion.

Failure example:

```text
Trevra claims action
  -> Gmail accepts message
  -> process/network fails before Trevra records success
  -> lease eventually recovers
  -> generic action retry runs
  -> prospect may receive the same email twice
```

For outreach email, the safe state machine must be:

```text
claimed -> sending -> sent
                   -> failed       (provider definitively rejected)
                   -> uncertain    (provider outcome cannot be proven)
```

`uncertain` is terminal for automatic resend. It requires reconciliation or a human decision.

### Deterministic internet Message-ID

Trevra already creates a deterministic Gmail MIME Message-ID from the payload hash in `src/server/integration-service.ts`:

```text
<payloadHash@trevra.app>
```

Keep that property and persist it in `outreach_deliveries` / `outreach_messages`.

The Microsoft path should reach equivalent semantics: persist a real internet message identity that can be used for inbound thread verification and reconciliation. A provider request ID is not a substitute for an RFC message-thread identity.

### Retry policy

- provider says definite 4xx/5xx rejection before acceptance -> `failed`, retry only when the error class is explicitly retryable;
- provider timeout/disconnect after request transmission where acceptance is unknown -> `uncertain`, **no blind retry**;
- `sent` -> never retry;
- `uncertain` -> reconciliation/manual handling only.

This is stricter than the old growth implementation and is required before Trevra becomes the sole sender.

---

## 7. Reply design: inbound provider sync, not IMAP polling

Do not port `imaplib` polling from the Python service.

Trevra already owns Gmail/Microsoft OAuth through its integration layer. Inbound email should use those provider connections and their official APIs/Nango sync contracts.

The essential security rule from `e-commerce/growth/outreach/replies.py` must survive:

> A state-changing reply is verified by a known thread/message reference, not merely by the `From` address.

### Inbound pipeline

```text
provider inbox sync / webhook-compatible poll
  -> normalize provider payload
  -> decode text + HTML safely
  -> strip quoted original text for intent classification
  -> collect In-Reply-To / References identities
  -> find known outbound internet_message_id
       | yes
       v
     verified
       |
       +-> persist inbound outreach_message
       +-> mark original message replied where appropriate
       +-> thread -> replied
       +-> classify unsubscribe / bounce / OOO / normal
       +-> append domain events

       no
       v
     unverified
       |
       +-> optional match by sender for presentation only
       +-> persist provenance
       +-> DO NOT advance thread
       +-> DO NOT create suppression
       +-> DO NOT trigger autonomous follow-up
```

A bare `From: prospect@example.com` is spoofable. It is enough to show the message to an operator, not enough to mutate funnel state.

### Reply classifications

Minimum useful states:

- `reply` — verified human response; thread becomes `replied`;
- `unsubscribe` — verified request; add workspace suppression and thread becomes `suppressed`;
- `bounce` — provider-delivery evidence; thread becomes `bounced`, optionally add address-level suppression depending on bounce class;
- `out_of_office` — persist but do not count as a reply outcome or advance the thread;
- `unverified` — persist/read-only, no state-changing automation.

Do not use `src/server/outreach/reply.ts` for this purpose. That file is a community-thread reply drafting skill and should keep its current responsibility.

---

## 8. Approval and policy model

Cold outreach should reuse Trevra's existing exact-payload approval model, not create a second approval table or weaker status flag.

The canonical flow remains:

```text
Draft skill
  -> approval step hashes exact recipient + subject + body + metadata
  -> founder approves exact hash
  -> `outreach.email.send` action recomputes / receives canonical hash
  -> action executes only if the matching approval exists
```

The cold-email-specific guard belongs immediately before the external write. It does not replace policy evaluation or exact approval.

Suggested policy attributes include:

```text
recipient
recipientDomain
channel=email
campaign/playbook id
sender identity
messagesSentToday
workspaceDailyCap
suppressed=true|false
```

This lets the existing workspace policy layer deny or require approval at a higher level while the send adapter still enforces non-negotiable transport/suppression invariants.

---

## 9. GTM outcome linkage

Closing the runtime gap is not complete if Trevra can send and receive but still cannot connect activity to a GTM outcome.

Target graph:

```text
Account / Person
  -> Outreach thread or Inbound Submission
  -> verified Reply / Qualification
  -> Opportunity
  -> Won | Lost | Disqualified
```

The initial implementation does not need automated causal attribution. It does need stable IDs and explicit relationships so Trevra can later answer:

```text
source provider / capture source
  -> account / person
  -> signal / audit wedge
  -> campaign / outreach variant
  -> reply / qualification
  -> opportunity outcome
```

Trevra does not need a revenue, invoice, payment, contract, or project graph to close the GTM loop. Those business records belong to external systems and are outside the target GTM-OS boundary.

---

---

## 10. Implementation phases

The phases are ordered so each leaves Trevra more coherent without requiring the e-commerce repository to change.

### Phase A — persistence and lifecycle spine

Add forward-only PostgreSQL migrations and server stores for:

- [ ] `contacts` as the workspace Person spine;
- [ ] optional `account_contacts` associations;
- [ ] `outreach_threads`;
- [ ] `outreach_messages`;
- [ ] `outreach_deliveries`;
- [ ] `outreach_suppressions`.

Add deterministic services for:

- [ ] Person/contact upsert/lookup without requiring an Account;
- [ ] optional Account↔Person association;
- [ ] thread creation and lifecycle transition;
- [ ] suppression add/check;
- [ ] outbound message/delivery claim;
- [ ] domain-event emission.

- [ ] Tests cover workspace isolation, Person dedupe, optional Account association, legal/illegal ladder transitions, suppression precedence, and competing delivery claims.

### Phase B — sourcing parity inside Trevra

- [x] Add the directory research provider.
- [x] Add directory behavior tests for junk filtering, evidence, missing input and dedupe.
- [ ] Add explicit provider-level regression tests covering SSRF rejection, redirect revalidation and source/candidate bounds end to end. The guard exists, but this release-gate coverage is not yet complete.
- [x] Add a generic deployment-owned HTTP provider contract without requiring Beseam or the e-commerce backend.
- [x] Add the account persistence path from `gtm.source-leads` results, including retention enforcement before persistence.
- [x] Make paste/file/folder upload the standard ingestion path for existing prospect data.
- [x] Add the client-side Import Review workbench with editable fields, include/exclude controls, duplicate/invalid review, provenance and exact-payload inspection.
- [x] Support direct import of existing `e-commerce/shops/` manifests without a Beseam candidates API.
- [ ] Persist detected contact names/emails/phones into the future shared Person/contact spine without requiring an Account. They are review-only evidence today.

### Phase B.5 — generic inbound lead capture

Design: `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`.

- [ ] Add workspace-scoped Capture Sources with one-time signing secrets and rotation.
- [ ] Add `inbound_submissions` as immutable source/UTM/consent/message evidence.
- [ ] Add signed, idempotent `POST /api/intake/v1/submissions` that derives workspace only from the Capture Source.
- [ ] Add `Setup -> Lead capture` so any founder/startup can connect its own landing page to its own Trevra workspace.
- [ ] Capture/match a Person directly; an Account is optional and only linked when explicitly known.
- [ ] Cut Beseam `ecom-clean-lp /api/lead` over through its existing Cloudflare Worker while keeping product/edge endpoints outside Trevra.

### Phase C — guarded cold-email action

- [ ] Add `outreach.email.send` to the prepared-action execution layer.
- [ ] Wire suppression and cap checks.
- [ ] Persist deterministic message identity.
- [ ] Add durable delivery claiming.
- [ ] Add `uncertain` semantics and prevent blind retries.
- [ ] Update `gtm.audit-led-outreach` to use the new action type.
- [ ] Preserve exact approval hashing and policy evaluation.

### Phase D — inbound email and reply state

- [ ] Normalize Gmail inbound messages.
- [ ] Normalize Microsoft 365 inbound messages.
- [ ] Track sync cursor/checkpoint per workspace connection using existing integration patterns.
- [ ] Verify replies through `In-Reply-To` / `References` or provider-equivalent stable thread identity.
- [ ] Ingest inbound messages.
- [ ] Classify unsubscribe, bounce, OOO, normal reply and unverified sender-only matches.
- [ ] Add suppression on verified unsubscribe.
- [ ] Expose API required by `/outreach/inbox` / `/outreach/replies`.

### Phase E — loop integration

- [ ] Connect replied/qualified threads to opportunity creation/association.
- [ ] Expose funnel counts from sourced/inbound -> engaged -> replied/qualified -> opportunity -> won/lost.
- [ ] Add run/message/reply links in the ledger.
- [ ] Update `docs/founder-skills.md` to reflect what is actually live after implementation.

### Phase F — cutover preparation, still without deleting e-commerce code

Build Trevra-side migration/import tooling for:

- [ ] growth leads -> accounts as a full legacy-growth migration;
- [x] existing shop company manifests -> accounts through the standard folder-import path;
- [ ] contact names/emails/phones -> shared People/contacts, with optional Account association only when explicitly known;
- [ ] suppressions -> outreach suppressions;
- [ ] sent messages and message IDs -> outreach messages/deliveries;
- [ ] terminal lead states -> outreach thread state where mapping is unambiguous.

Existing Python `approved` messages must **not** be imported as executable Trevra approvals. They may be imported as drafts, but sending requires a new Trevra exact-payload approval.

Only after this phase passes the exit criteria does work begin in the e-commerce repository.
---

## 11. Tests required before cutover

The following are release gates, not nice-to-have tests.

### Sourcing

1. Running the same directory source twice does not create duplicate accounts.
2. Private/local/invalid targets and unsafe redirects are rejected.
3. Social/platform junk links do not become accounts.
4. A disabled/unavailable Beseam provider reports why it cannot run; it does not silently return a false successful zero.

### Sending

5. Two concurrent executions of the same approved payload produce exactly one delivery claim.
6. Email-level suppression blocks the provider call.
7. Domain-level suppression blocks the provider call.
8. Daily cap blocks the provider call once the cap is reached.
9. Missing live provider connection refuses execution in production.
10. Edited recipient/subject/body after approval fails the approval hash check.
11. A definite provider rejection is recorded as failed and does not advance the thread to `sent`.
12. An ambiguous provider outcome becomes `uncertain` and is not automatically retried.
13. A successful send persists a deterministic internet Message-ID and advances the thread exactly once.

### Replies

14. A verified `In-Reply-To`/`References` match records the inbound message and advances the thread to `replied`.
15. A sender-only match records an unverified inbound item but changes no lifecycle state.
16. A verified unsubscribe creates a suppression and prevents every later email action to that email/domain as configured.
17. Quoted original text containing words such as "unsubscribe" does not create a suppression when the newly typed reply does not request it.
18. OOO does not count as a human reply outcome.
19. Bounce handling does not masquerade as a reply and follows its own state path.

### Tenancy and ledger

20. Every contact/thread/message/delivery/suppression query is workspace-scoped.
21. Cross-tenant identifiers cannot satisfy an approval, suppression, reply match or delivery reconciliation.
22. Every send attempt and reply state change leaves an append-only event/ledger trace.
23. Message bodies and customer content do not enter analytics payloads.

Run the repository-required `npm run check` before declaring any phase complete.

---

## 12. Migration and cutover rules

The future cutover from `e-commerce/growth` must use these rules.

### Import first

1. suppressions;
2. accounts/leads;
3. contacts;
4. sent outbound messages and their external/internet message IDs;
5. inbound reply history where thread identity can be proven;
6. terminal status/history as non-authoritative historical events where exact mapping is not possible.

Suppressions come first so an imported prospect can never be accidentally contacted in the interval before its opt-out arrives.

### Do not import authority that Trevra did not grant

- Python `approved` does not equal Trevra exact-payload approval.
- Old queued/scheduled sends are not resumed automatically.
- Ambiguous historical message identity does not become a verified reply chain.
- Historical sender-only reply matches remain unverified unless a message/thread reference proves them.

### Cutover operation

When ready:

1. pause the Python growth sender and reply poller;
2. perform final incremental import;
3. enable Trevra sourcing/sending/inbound workers;
4. run a controlled live cohort;
5. verify counts and suppression behaviour;
6. keep Python growth read-only during the verification window;
7. only then remove the Python runtime paths.

No dual active senders.

---

## 13. Definition of done: when `e-commerce/growth` is removable

The growth service is redundant only when **all** of the following are true:

- [ ] Trevra can source e-commerce candidate domains through directory inputs without Python growth.
- [ ] Trevra has a defined optional Beseam intelligence provider contract that does not depend on Python growth.
- [ ] Sourced companies converge into `accounts` with dedupe/provenance.
- [ ] Trevra owns contacts for sourced accounts.
- [ ] `gtm.audit-led-outreach` runs score -> audit -> draft -> exact approval -> guarded send entirely inside Trevra.
- [ ] Cold-email sends enforce suppression, cap, live-provider and deterministic-idempotency invariants.
- [ ] Ambiguous sends cannot automatically duplicate an email.
- [ ] Gmail and Microsoft replies are ingested without IMAP/Python growth.
- [ ] Verified replies, unsubscribes, bounces and unverified messages follow distinct deterministic state paths.
- [ ] Suppressions are workspace-wide and consulted by every email outreach send.
- [ ] `/outreach/inbox` or the current canonical outreach reply surface is backed by real inbound data.
- [ ] Outreach state is visible in the ledger and domain-event stream.
- [ ] A replied account can be associated with an opportunity/client and followed through invoice/payment.
- [ ] Migration tooling can import all live growth state needed for continuity.
- [ ] All parity and tenancy tests in section 11 pass.
- [ ] A controlled live Trevra-only cohort sends and receives successfully while Python growth is paused.

Only then is deletion work in the e-commerce repository allowed to start.

---

## 14. Non-goals

This proposal deliberately does **not** include:

- recreating the Python FastAPI application inside Trevra;
- adding SQLAlchemy/Alembic concepts to Trevra;
- adding SMTP/IMAP as a second email stack when Gmail/Microsoft provider integrations already exist;
- moving Beseam e-commerce intelligence/data tables into Trevra;
- deleting or modifying e-commerce code before Trevra is proven;
- rebuilding OAuth/token rotation outside Nango or official provider SDKs;
- turning all outreach channels into one fake abstraction when channel safety genuinely differs;
- automated revenue attribution before a real causal relationship exists;
- high-volume cold-email infrastructure or warmed-domain hosting as part of the first parity milestone.

---

## 15. Architectural rules for implementation

These rules are binding unless a later design explicitly supersedes this proposal.

1. **One account spine.** New GTM state attaches to `accounts`; no duplicate `leads` table.
2. **One approval boundary.** Exact-payload Trevra approval remains authoritative for external writes.
3. **One email provider layer.** Reuse Gmail/Microsoft through existing integration infrastructure.
4. **Cold outreach gets its own action semantics.** Transport may be shared; safety rules are not hidden inside transactional email.
5. **No blind retry after uncertain external success.** Safety beats throughput.
6. **Verified thread reference beats sender identity.** Sender-only inbound matches are read-only evidence.
7. **Suppression is global within a workspace.** A campaign may not override it.
8. **Sources are providers.** Directory/Beseam integrations extend `gtm.source-leads` rather than creating a new source framework.
9. **Beseam is optional intelligence, not a Trevra runtime dependency.**
10. **Every state-changing operation is workspace-scoped and leaves evidence.**
11. **No e-commerce deletion before parity is demonstrated live.**

---

## 16. Recommended first implementation slice

Start with **Phase A only** and keep it deliberately boring:

```text
migration
  -> account_contacts
  -> outreach_threads
  -> outreach_messages
  -> outreach_deliveries
  -> outreach_suppressions

server stores/services
  -> contact upsert
  -> create/transition thread
  -> add/check suppression
  -> claim/finalize delivery
  -> append events

tests
  -> tenancy
  -> dedupe
  -> lifecycle
  -> suppression
  -> competing claims
```

Do not start provider integrations or UI until this spine is solid. Every later piece depends on it, and it is the part most expensive to change after live outreach data exists.

Once Phase A lands, Phase B (directory provider) and Phase C (guarded send) can proceed independently against the same model.
