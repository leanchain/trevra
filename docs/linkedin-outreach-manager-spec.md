# LinkedIn Outreach Manager — Product & Engineering Spec

Status: implementation spec  
Date: 2026-08-13  
Branch: `feat/dripify-outreach-manager`

## 0. Purpose

Turn Trevra's existing LinkedIn subsystem into a complete Dripify-style outreach manager without creating a parallel execution system.

The product loop is:

> Connect account → import leads → build workflow → create campaign → paced execution → inbox/manual tasks → analytics

The existing Trevra safety boundary remains authoritative:

- `linkedin_actions` is the only outbound action ledger.
- Campaign/workflow state may schedule actions but may not execute around the ledger.
- Every external write is paced and safety-checked immediately before execution.
- Hosted deployments continue to refuse local LinkedIn browser automation and credential custody.
- A limit is a safety ceiling, not a guarantee that LinkedIn will allow the activity.
- Retry/idempotency rules must prevent duplicate external actions.

This spec is a delta against the implementation currently in `main`, not a greenfield design.

---

## 1. Current Trevra baseline

The following capabilities already exist and should be extended rather than rebuilt.

| Requirement area | Existing implementation | Status against this spec |
| --- | --- | --- |
| LinkedIn account/seat | `migrations/022_linkedin_seats.sql`, `src/server/linkedin/seats.ts` | Partial: one owner seat/workspace today; multi-account still required |
| Action ledger | `linkedin_actions`, `src/server/linkedin/actions.ts` | Reuse as source of truth |
| Local execution | `src/server/linkedin/local-worker.ts`, `driver*.ts`, `src/cli/trevra-linkedin-worker.ts` | Reuse; self-hosted only |
| Account credentials/session | `src/server/secrets/linkedin.ts`, migration 028 | Reuse existing hosted gate and secret-store boundary |
| Pacing and safety | `limits.ts`, `pacing.ts`, `guard.ts` | Strong existing engine; add operator-configurable ceilings and requested campaign ramp |
| Campaign object | migration 025, `campaigns.ts` | Extend with reusable lead-list/workflow enrollment semantics |
| Sequence/workflow data | `sequence.ts`, `branching.ts` | Partial: editable ordered steps/conditions exist; add delay units, A/B variants and manual task semantics |
| Connection request | `invite` action and driver | Existing |
| Connection request without note | `inviteNote: 'none'` in sequence | Existing |
| Withdraw pending invite | migration 032, `withdraw.ts`, driver withdrawal path | Existing subsystem; expose as workflow step/policy |
| Profile view | `profile_view` action | Existing |
| Message | `dm`, `reply`, `inmail` actions | Existing |
| Follow | `follow` action and engagement driver | Existing |
| LinkedIn search sourcing | migration 030, `leads.ts`, scrape driver | Existing for basic people-search URLs; gated opt-in |
| Post/comment sourcing | migration 030 + engagement scraping | Existing foundation for nice-to-have discovery; keyword discovery/quotas still required |
| CSV upload | no normalized CSV lead-import boundary | Missing |
| Required lead fields | current harvested lead is `name/headline/company` | Missing first/last/company contract |
| Name scrubber | no import-time scrubber matching this brief | Missing |
| Inbox | migration 031, `inbox.ts`, `driver-inbox.ts`, `LinkedInInbox.tsx` | Existing; extend with manual workflow tasks and account switching |
| Outcome ingest | action statuses + inbox outcome path | Existing foundation |
| Analytics | `LinkedInAnalyticsScreen.tsx` and action outcomes | Partial; align exact funnel metrics/denominators |
| Multiple LinkedIn accounts | action tables carry `seat_key`, but `linkedin_seats` is owner-only | Missing product/data model |

### Architectural consequence

Do not introduce a second campaign action table, scheduler or message outbox. New workflow features compile into `linkedin_actions` and the local worker remains the only local execution path.

---

## 2. Product requirements

### 2.1 LinkedIn accounts

A workspace can eventually connect and manage multiple LinkedIn accounts ("seats"). Each seat has independent:

- connection/session status;
- timezone;
- working days and working hours;
- per-action limits;
- activity counters;
- health/posture;
- campaign assignments;
- inbox conversations.

The account switcher supports `All accounts` plus each connected account.

#### Safety language

The UI must never promise "will not be blocked". It may say Trevra spaces activity, enforces operator limits and stops on known walls/challenges. LinkedIn can still restrict an account.

### 2.2 Working schedule

Per seat:

- select working weekdays;
- select local start/end time;
- no automated action may execute outside that window;
- actions that mature outside the window remain queued until an eligible window;
- timezone is the seat's IANA timezone.

Requested default working schedule for new seats: Monday–Friday, 08:00–18:00 local, unless product design chooses a different explicit onboarding default.

### 2.3 Operator activity ceilings

Expose per-seat ceilings while retaining Trevra's internal safety policy as a hard upper bound.

| Action | Product default | Allowed user setting |
| --- | ---: | ---: |
| Connection requests | 30/day | 0–75/day |
| Messages | 25/day | 0–75/day |
| Profile views | 25/day | 0–100/day |
| Follows | 20/day | 0–50/day |

`reply` must remain separately ledgered for idempotency, but the product must state whether replies consume the message budget. Default: yes, because the existing safety engine deliberately mirrors DM limits for replies.

The effective allowance is always:

`min(operator ceiling, Trevra safety ceiling, remaining rolling-window capacity, campaign warm-up allowance)`.

A user setting can make Trevra stricter; it cannot bypass a code-owned hard safety restriction or a seat cooldown.

### 2.4 Campaign warm-up

Every campaign has a five-day requested ramp:

- Day 1: 20% of effective configured limit
- Day 2: 40%
- Day 3: 60%
- Day 4: 80%
- Day 5+: 100%

Use deterministic rounding: `floor(limit * multiplier)` with a zero limit staying zero.

This campaign ramp is additive to, not a replacement for, Trevra's existing account-age/posture warm-up and variance smoothing. The stricter result wins.

### 2.5 Pacing

Eligible actions must be spread across the available working window. They must not all fire at window start.

Requirements:

- preserve deterministic scheduling/idempotency;
- no `Math.random()` in an approval-bound plan;
- use deterministic jitter already established by the pacing engine;
- enforce a minimum inter-action gap;
- re-run safety immediately before execution;
- halt on a challenge/limit wall according to current worker rules.

---

## 3. Leads and lead lists

### 3.1 Canonical lead record

A campaignable lead needs these normalized fields:

Required:

- `firstName`
- `lastName`
- `company`

Optional:

- `email`
- `phone`
- `country`
- `linkedinUrl`

Audit/source fields:

- source type;
- source id;
- original imported values;
- created timestamp.

For browser-harvested leads, do not fabricate missing first/last/company. A harvested result can exist as an incomplete lead, but it cannot enroll into a campaign until required campaign fields are present.

### 3.2 Lead list

A lead list is a reusable collection. Sources:

1. CSV upload.
2. Basic LinkedIn people-search URL.
3. LinkedIn Sales Navigator search URL.
4. Future post/comment keyword discovery.

A list can contain incomplete leads; campaign enrollment reports and excludes them.

### 3.3 CSV import

Flow:

1. Upload `.csv`.
2. Parse safely, including quoted fields, commas and UTF-8 BOM.
3. Show headers + first rows.
4. Automatch known aliases.
5. Allow manual field mapping overrides.
6. Scrub names.
7. Validate required fields row-by-row.
8. Present import summary.
9. Persist valid rows and keep enough raw data for audit/debugging.

Automatch aliases must at least cover common forms of:

- first name: `first`, `firstname`, `first_name`, `first name`, `given name`;
- last name: `last`, `lastname`, `last_name`, `last name`, `surname`, `family name`;
- company: `company`, `company name`, `employer`, `organization`, `organisation`;
- email: `email`, `email address`, `e-mail`;
- phone: `phone`, `phone number`, `mobile`, `telephone`;
- country: `country`, `country code`, `location country`;
- LinkedIn URL: `linkedin`, `linkedin url`, `linkedin profile`, `profile url`.

Automatching is a suggestion. The operator can override it before persistence.

### 3.4 Data scrubber

Clean first and last names at import time.

Remove:

- emoji, including examples `🙂` and `💪`;
- `. , ? !`;
- standalone, case-insensitive tokens:
  `mr`, `ms`, `mrs`, `miss`, `jr`, `sr`, `snr`, `jnr`, `prof`, `professor`, `dr`, `drs`, `doc`, `doctor`, `phd`, `ba`, `bfa`, `bs`, `ma`, `mba`, `mfa`, `jd`, `md`, `do`, `ceo`, `lion`, `lme`, `lmt`, `mim`, `msc`, `sip`, `rpm`.

Rules:

- removal is token-based, never substring replacement (`ma` must not corrupt `Maya`);
- trim and collapse whitespace;
- keep original raw values separately;
- preserve legitimate apostrophes and hyphens.

Example: `Dr. Maya 🙂, MBA` → `Maya`.

### 3.5 One active campaign per lead

A person may only be enrolled in one active/running campaign per workspace at a time.

Identity order for enrollment/dedupe:

1. canonical LinkedIn profile URL when present;
2. normalized email when no LinkedIn URL exists;
3. normalized `(firstName, lastName, company)` fallback.

Enforce server-side and, where practical, with a database constraint/claim. UI checks alone are insufficient.

Campaign enrollment reports:

- selected;
- enrolled;
- already active elsewhere;
- missing required fields;
- excluded/do-not-contact;
- duplicates.

---

## 4. Workflow builder

A workflow is reusable independently of a campaign and lead list.

A workflow is an ordered list of steps plus delays. Campaign creation binds:

`seat + lead list + workflow + campaign name`.

### 4.1 Step kinds

#### Connection request

- message optional;
- supports `{{firstName}}`, `{{lastName}}`, `{{company}}`;
- compiles to existing `invite` action.

#### Withdraw connection request

- configured as "withdraw if still pending after X days";
- integrates the existing withdrawal subsystem;
- never withdraw an accepted/replied invite.

#### Profile view

- no copy;
- compiles to `profile_view`.

#### Message

- one or more message variants;
- V1 A/B supports two variants with an explicit percentage split;
- assignment is deterministic and persisted per campaign lead/step;
- the assigned variant never changes on retry/resume;
- analytics can attribute sent/replied outcomes to variant.

#### Manual message

- creates a durable manual task;
- campaign lead state becomes `waiting_for_manual_message`;
- no later workflow step is scheduled/executed until completion;
- task appears in the unified inbox;
- sending/completing the manual message records an action/event, then advances the workflow.

#### Follow

- compiles to existing `follow` action and remains subject to the follow budget.

### 4.2 Delay model

Between any two steps the operator selects:

- integer amount;
- unit `hours` or `days`.

Persist the delay as data on the workflow step/edge. Do not flatten hours into a campaign-wide day offset in the editor, because the product requirement is explicitly hour-or-day precision.

The scheduler computes `earliest_execution_at`; working windows and safety limits may push actual execution later, never earlier.

### 4.3 Variables

V1 supported merge fields for user-authored campaign messages:

- `{{firstName}}`
- `{{lastName}}`
- `{{company}}`

The existing `jobTitle` support can remain internally/backward-compatible, but the V1 UI need not expose it.

Unknown variables fail validation before campaign approval.

---

## 5. Campaigns

### 5.1 Creation

Wizard:

1. Name + LinkedIn account.
2. Lead list + eligibility summary.
3. Workflow + preview.
4. Review effective working hours/limits/warm-up.
5. Save draft or start.

### 5.2 Lifecycle

Required states:

- `draft`
- `running`
- `paused`
- `stopped`
- `completed`

Semantics:

- pause is resumable;
- stop terminates remaining automation and releases/cancels unclaimed planned work according to ledger invariants;
- start/resume cannot bypass approval/safety boundaries.

### 5.3 Per-lead campaign state

Each campaign lead has independent state, e.g.:

- pending;
- active;
- waiting;
- waiting_for_connection;
- waiting_for_manual_message;
- paused;
- replied;
- completed;
- removed;
- failed.

Actions:

- pause lead;
- continue lead;
- remove lead;
- open lead/conversation.

On inbound reply, default behavior is to stop further automated outreach for that lead and set the state to `replied`.

---

## 6. Inbox and manual tasks

Reuse `linkedin_threads` and `linkedin_messages` as the conversation snapshot. Do not create a second message outbox.

Inbox filters:

- all;
- unread;
- replies;
- manual tasks;
- LinkedIn account;
- campaign.

Conversation view shows:

- lead name/company/profile;
- campaign;
- workflow position;
- transcript;
- composer.

Manual tasks appear in the same left-hand queue as conversations but are visually marked `Action required`.

A reply sent from the inbox must still become a ledger action and go through the existing safety/execution boundary.

---

## 7. Analytics

V1 dashboard per workspace/account/campaign:

- invites sent;
- messages sent;
- profile views;
- invites accepted;
- acceptance percentage;
- unique replying leads;
- reply percentage.

Definitions:

`acceptance % = accepted invites / sent invites * 100`

`reply % = unique leads who replied / unique leads who received at least one message * 100`

Return `0%` or `—` consistently for a zero denominator; choose one presentation convention in UI tests.

For A/B messages, retain `variant_id` attribution so later analytics can show per-variant sent/reply metrics without reconstructing assignments.

---

## 8. Team / multi-account model

The current schema deliberately has one `linkedin_seats` row per workspace while downstream tables already carry `seat_key`. Multi-account requires promoting seat identity into the seat table instead of adding a parallel account table.

Target shape:

- primary key/unique claim: `(workspace_id, seat_key)`;
- migrate existing row to `seat_key='owner'`;
- every LinkedIn query remains workspace-scoped and additionally seat-scoped where account-specific;
- campaigns store the chosen `seat_key`;
- inbox threads already carry `seat_key` and become account-filterable;
- activity budgets are per seat across all campaigns.

Do this as a dedicated migration with explicit compatibility tests; it touches the safety boundary and must not be mixed casually into CSV import work.

---

## 9. Nice-to-have: keyword lead discovery

Build on the existing post-engagement lead-source path after MVP.

Operator configures:

- keywords;
- maximum leads/day.

Result:

- first name;
- last name;
- company;
- LinkedIn URL;
- LinkedIn post URL;
- interaction type: `post` or `comment`.

Requirements:

- explicit lead-sourcing opt-in remains required;
- hosted deployment remains refused under current policy;
- deterministic per-day cap;
- dedupe against known leads, exclusions and contacted targets;
- source attribution retained.

---

## 10. Implementation plan

### Slice 1 — normalized import boundary (start here)

1. Add pure `lead-import.ts` module.
2. Implement deterministic header automatching.
3. Implement exact name scrubber rules.
4. Parse CSV with the already-installed `csv-parse` dependency.
5. Return row-level required-field errors without persisting anything.
6. Unit-test quoted CSV, BOM, mappings, scrubber and missing fields.

Why first: it establishes the canonical lead contract without changing the worker or action ledger and can be tested without a browser or LinkedIn session.

### Slice 2 — persistence + CSV API/UI

1. Forward-only migration extending `linkedin_leads` with normalized contact fields and raw import data, or introduce a canonical lead table if review shows the existing harvested-lead table should remain source-only.
2. Add CSV source/list persistence.
3. Add preview + mapping API.
4. Add upload/mapping UI in `LinkedInLeads.tsx`.
5. Add campaign eligibility checks.

### Slice 3 — reusable workflow model

1. Persist workflow definitions separately from campaign snapshots.
2. Add hours/days delays.
3. Model manual message steps.
4. Add A/B message variants + deterministic assignment.
5. Compile workflow steps into `linkedin_actions` only after campaign approval/enrollment.
6. Adapt existing sequence editor rather than creating a second builder.

### Slice 4 — operator seat settings

1. Add per-seat working days/hours.
2. Add requested configurable limits with hard product ranges.
3. Add five-day campaign warm-up.
4. Combine these with existing code-owned bands, account warm-up, rolling windows and variance smoothing using the strictest allowance.

### Slice 5 — campaign-lead state

1. Durable enrollment table/state machine.
2. Enforce one active campaign per lead.
3. Pause/resume/remove individual lead.
4. Stop automation on reply.
5. Wire withdrawal timing and branch outcomes to workflow advancement.

### Slice 6 — manual tasks + inbox

1. Add durable manual-task rows or a task projection keyed to campaign enrollment/step.
2. Surface in `LinkedInInbox.tsx`.
3. Completion writes/queues the appropriate ledger action and advances workflow.

### Slice 7 — multi-account

Promote seat key to a first-class `linkedin_seats` key and thread it through campaigns, settings, inbox, analytics, workers and UI.

### Slice 8 — analytics alignment and keyword discovery

Finish requested funnel metrics/A-B attribution, then add keyword discovery and daily lead caps.

---

## 11. Acceptance criteria for MVP

The MVP is complete when an operator can:

1. Connect/select a supported self-hosted LinkedIn seat using the existing Trevra integration boundary.
2. Configure working days/hours.
3. Configure the four requested product ceilings within their ranges.
4. Import a CSV, review automapping, correct mappings and see row errors.
5. Import from supported LinkedIn search sources under the existing explicit sourcing gate.
6. Store campaignable leads with first name, last name and company.
7. Create/edit a reusable workflow using invite, withdrawal, profile view, message, manual message and follow.
8. Configure hour/day delays.
9. Use first name, last name and company variables.
10. Configure and persist A/B message variants.
11. Create a named campaign from one seat + one lead list + one workflow.
12. Prevent a lead from being active in two campaigns.
13. Start/pause/stop a campaign.
14. Pause/resume/remove one campaign lead without losing workflow position.
15. Apply the five-day campaign ramp in addition to existing Trevra safety rules.
16. Execute only during working windows and under the effective account budget.
17. Receive/sync LinkedIn conversations in the existing inbox.
18. Reply through the same ledger/safety execution boundary.
19. Complete a manual-message task and resume the lead's workflow.
20. Stop future automated steps for a lead on reply by default.
21. View invites/messages/profile views/acceptance/reply metrics.
22. Switch among multiple connected LinkedIn accounts once the multi-seat migration ships.

---

## 12. Non-goals for the first implementation slices

- bypassing LinkedIn challenges, CAPTCHAs, limits or account restrictions;
- proxy/fingerprint rotation for evasion;
- a second outbound execution path outside `linkedin_actions` + worker;
- CRM replacement;
- email outreach;
- arbitrary expression-language workflow conditions;
- AI-generated custom variables beyond the approved merge-field contract;
- hosted multi-tenant LinkedIn credential custody under the current Trevra policy.

---

## 13. Engineering invariants

These are release blockers, not preferences.

1. Every query/write is workspace-scoped.
2. Seat-specific safety state is seat-scoped.
3. External writes are idempotent and claim-before-act.
4. Worker safety is re-evaluated immediately before every LinkedIn write/action.
5. Approval-bound payloads are deterministic; no runtime randomness may mutate approved copy/targets.
6. UI-only enforcement is never sufficient for campaign exclusivity, limits or external writes.
7. CSV parsing is pure until the operator confirms the mapping/import.
8. Original imported values remain auditable after normalization.
9. Missing scraped data stays missing; Trevra does not infer names/company and store guesses as facts.
10. Existing hosted/local LinkedIn gates remain enforced at the network/secret boundary, not only in routes or UI.
