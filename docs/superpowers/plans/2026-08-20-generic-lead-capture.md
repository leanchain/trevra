# Generic Lead Capture Implementation Plan

> **For agentic workers:** implement this plan task-by-task and keep the checkboxes current. This plan is grounded first in `AGENTS.md` and the canonical `docs/superpowers/specs/2026-08-20-agent-native-gtm-os-design.md`, then in `docs/system-of-record.md`, `docs/app-spec.md`, `docs/integration-contracts.md`, and the focused `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`.

**Goal:** Make Trevra the workspace-scoped system of record for inbound GTM People and form submissions, with a secure generic server-to-server intake contract that any founder can connect from a landing page or website backend.

**Architecture:** A workspace owner creates a Capture Source. Trevra generates a source ID and one-time HMAC signing secret stored through the existing encrypted secret-custody boundary. A website backend signs the exact raw JSON body and sends it to `POST /api/intake/v1/submissions`. Trevra derives the workspace exclusively from the Capture Source, deterministically resolves/creates a Person, optionally links an explicitly supplied Account, writes an immutable Inbound Submission, and emits append-only GTM events. Capture never sends outreach directly.

**Product boundary:** GTM only. No generic `/events`, product telemetry, revenue, accounting, project, ERP, CDP, or arbitrary remote-action behavior is added.

**Tech stack:** PostgreSQL migrations, Express + zod, Node crypto, React + TypeScript, Vitest/Supertest.

**Design spec:** `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md`

**Canonical GTM-OS relationship:** This slice completes the Trevra-core portion of Phase 2 (inbound GTM) and advances Phase 1 (Person spine). It does **not** claim that Person convergence across LinkedIn/email is finished, and it does not pull Phase 3+ conversations, GTM email, agent-principal, or Growth-retirement work into lead capture.

## Working-tree constraints

- The repository currently contains a large uncommitted GTM-only cleanup from another agent. Preserve it.
- Do not revert, stage, or commit unrelated files.
- Prefer new focused modules over adding large amounts of logic to `src/server/app.ts`.
- Migration numbering follows the already-present LinkedIn migrations; this plan uses `098_generic_lead_capture.sql`.
- Capture-source secrets must use Trevra's encrypted custody primitives; never store plaintext HMAC secrets.
- Browser code never receives a stored secret after the create/rotate response that generated it.
- Intake workspace routing comes only from the authenticated Capture Source.

## File structure

| File                                                               | Responsibility                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `migrations/098_generic_lead_capture.sql`                          | People, source identities, account associations, capture sources/secrets, inbound submissions |
| `src/server/lead-capture/types.ts`                                 | Public/internal capture types and zod schemas                                                 |
| `src/server/lead-capture/people.ts`                                | Deterministic Person normalize/match/create and account association                           |
| `src/server/lead-capture/sources.ts`                               | Capture Source CRUD, encrypted secret rotation and source metrics                             |
| `src/server/lead-capture/submissions.ts`                           | Transactional idempotency, immutable submission persistence, events                           |
| `src/server/lead-capture/http.ts`                                  | HMAC/raw-body intake middleware and API registration helpers                                  |
| `src/server/lead-capture/*.test.ts`                                | unit + DB-backed behavior                                                                     |
| `src/server/app.ts`                                                | Thin registration of authenticated management routes + public signed intake route             |
| `src/client/api.ts`                                                | Capture Source / People / Submission API client types                                         |
| `src/client/LeadCaptureSetup.tsx`                                  | Setup → Lead capture source management and recipes                                            |
| `src/client/InboundPeople.tsx`                                     | Operator list for People and inbound submissions                                              |
| `src/client/ui/route.ts`, `src/client/App.tsx`                     | Setup/inbound navigation only                                                                 |
| `src/client/styles.css` or focused CSS module                      | Minimal lead-capture UI styles                                                                |
| `docs/superpowers/specs/2026-08-20-generic-lead-capture-design.md` | Mark only verified checkboxes complete                                                        |

---

## Task 1 — Shared People spine

- [x] Add `contacts` with workspace-scoped deterministic email/phone identity indexes.
- [x] Add `contact_external_identities` unique on `(capture_source_id, external_id)`.
- [x] Add optional `account_contacts`; Person existence never depends on Account.
- [x] Implement normalization: lowercase email; accept phone identity only when already valid E.164; never infer country/company/name matches.
- [x] Implement match/create/fill-empty behavior; preserve conflicting non-empty canonical fields.
- [x] Add workspace-isolation and deterministic-dedupe tests.
- [x] Persist explicit contact evidence from folder imports when usable identities exist.

## Task 2 — Capture Sources and secret custody

- [x] Add `capture_sources` and encrypted `capture_source_secrets`.
- [x] Add create/list/detail/disable/enable/rotate operations.
- [x] Generate source IDs and one-time `trv_capture_...` secrets.
- [x] Encrypt active + previous rotation secret using the existing custody primitives and row-bound AAD.
- [x] Include Capture Source ciphertext in deployment custody reporting/reseal.
- [x] Support bounded previous-secret overlap.
- [x] Audit create/rotate/status changes without secret values.
- [x] Add authenticated owner/member management API tests; members may read source state but cannot create, rotate or change source credentials/status.

## Task 3 — Inbound Submission ledger

- [x] Add immutable `inbound_submissions` with source-scoped idempotency and payload hash.
- [x] Bound `properties`, attribution and consent object size/depth/value types.
- [x] Preserve submitted Person snapshots and explicit company evidence without silently overwriting canonical Person fields.
- [x] Resolve/create an Account only when an explicit company domain is supplied.
- [x] Emit append-only GTM domain events for source receive, Person create/match, Account create/match/link and submission create.
- [x] Add duplicate-identical, concurrent-duplicate and duplicate-conflict tests.

## Task 4 — Signed intake API

- [x] Add `POST /api/intake/v1/submissions` with raw JSON bytes preserved for HMAC verification.
- [x] Require source, timestamp, idempotency and signature headers.
- [x] Derive workspace only from Capture Source; body workspace IDs never route the request.
- [x] Enforce timestamp replay window and constant-time HMAC verification.
- [x] Accept active or unexpired previous secret during rotation.
- [x] Implement 202/200/400/401/404/409/413/429/5xx semantics from the design.
- [x] Add source-aware rate limiting/request-size guards.
- [x] Add cross-workspace, disabled-source, bad-signature, stale-timestamp, rotation-expiry and replay tests.

## Task 5 — Founder setup and operator UX

- [x] Add `Setup → Lead capture`.
- [x] Add source wizard with one-time secret reveal.
- [x] Add source list/detail, last seen, accepted/rejected counters, disable/enable and rotate.
- [x] Add Cloudflare Worker, Next.js/Vercel and curl recipes using the exact canonical signing contract.
- [x] Add a test-event helper that creates a signed request locally from the newly revealed secret; do not persist the secret in the browser after navigation/reload.
- [x] Add inbound People / Submission operator view with provenance, attribution and source.
- [x] Keep analytics/health summaries free of message/body content.

## Task 6 — Import integration

- [x] Extend the folder-import review payload so explicit contact emails/phones/names can be persisted through the shared People service.
- [x] Never create a Person from a name alone.
- [x] Associate imported People to the imported Account only when explicit evidence was attached to that account row.
- [x] Preserve source-file provenance and actor identity in the GTM ledger.
- [x] Add regression tests for structured folder contact evidence and no-identity rows.

## Task 7 — Beseam landing cutover

- [ ] In the Beseam workspace, create/configure a `Beseam website` Capture Source. **Operational deployment step; no production secret is invented in source control.**
- [x] Update `landings/ecom-clean-lp` Worker `/api/lead` to map local form payloads to Trevra's canonical contract and HMAC-sign them, with one browser-stable submission ID reused as Trevra's idempotency key across retries.
- [x] Keep origin validation, honeypot and body limits in the Worker.
- [ ] Add a real edge rate-limit binding if Beseam wants a second rate limit before Trevra. The existing Worker did not have one; Trevra already enforces source-scoped rate limits.
- [x] Keep answer-check/image/product proxy responsibilities outside Trevra.
- [ ] Make Trevra the live canonical lead write by provisioning the three Worker capture secrets and verifying production acceptance.
- [ ] Remove the legacy SendPulse fallback after live Trevra acceptance is verified.
- [ ] Remove the review notification-email fallback after live Trevra operator handling is verified.

## Task 8 — Documentation and cutover status

- [x] Update the design spec security/implementation/test checkboxes from verified behavior only.
- [x] Document the public intake protocol and integration recipes in `docs/lead-capture.md`.
- [x] Document source secret rotation/revocation and retry/idempotency behavior.
- [x] Leave Growth-retirement tasks unchecked unless cold send/reply/suppression migration is independently complete.

## Verification

- [x] `npm run typecheck`
- [x] focused lead-capture unit/API/DB tests
- [x] account import regression tests
- [x] `npm run build`
- [x] `npm run check`
- [x] `git diff --check` on Trevra implementation files
- [x] Beseam Worker tests (`node --test main.test.mjs` / `bun run test:worker`)
- [x] Beseam TypeScript + production build + focused Prettier + `git diff --check`
- [ ] Beseam repo-wide Prettier baseline: currently fails on 141 unrelated pre-existing files; do not rewrite them as part of this cutover.
