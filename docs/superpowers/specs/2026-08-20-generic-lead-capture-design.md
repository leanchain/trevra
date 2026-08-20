# Generic lead capture into Trevra — design

**Date:** 2026-08-20  
**Status:** Proposed  
**Scope:** Any Trevra customer can connect one or more landing pages, marketing sites, product surfaces, forms, serverless functions, or backends to their own Trevra workspace and capture inbound people there.

**Related:** `docs/growth-gap-closure-proposal.md`, `docs/source-providers.md`.

---

## 1. Decision

Trevra is the GTM system of record for the startup using it.

A founder signs up to Trevra, gets a workspace, and connects that workspace to their website or landing page. Visitors who submit forms become **People** in that founder's Trevra workspace. Each form submission is stored as an immutable **Inbound Submission**.

A prospect/company **Account is not required** for inbound capture.

The standard flow is:

```text
Founder / startup
  -> Trevra workspace
  -> Setup -> Lead capture
  -> create Capture Source for website
  -> configure website backend / edge worker

Visitor
  -> startup landing page
  -> website-owned backend/edge adapter
  -> signed Trevra intake request
  -> founder's Trevra workspace
     -> Person
     -> Inbound Submission
     -> optional Account link only when explicitly known
     -> qualification / inbox / opportunity / follow-up
```

The request never chooses the workspace. The authenticated Capture Source determines it.

This is intentionally generic. Beseam's `landings/ecom-clean-lp` and Cloudflare Worker are the first migration example, not a special-case Trevra integration.

---

## 2. Core product model

There are four separate concepts.

### Workspace

The Trevra customer/startup account.

Examples:

```text
Beseam
Acme AI
Orbit Health
Founder Studio
```

Every capture source, person, submission and optional company association is workspace-scoped.

### Capture Source

One external producer connected to a workspace.

Examples:

```text
Beseam website
Acme marketing site
Acme product signup
Founder waitlist
Conference QR form
```

A startup can have many Capture Sources.

### Person

A real inbound human known to the workspace.

Examples:

```text
Ada Example <ada@example.com>
Kim Sidi <kim@...>
A visitor identified only by a product external ID
```

A Person does **not** need an Account.

### Inbound Submission

One immutable capture event from a Person or source.

Examples:

```text
contact_message
demo_request
waitlist_joined
newsletter_subscribed
store_health_review_requested
ai_scan_requested
trial_started
```

The same Person can have many Inbound Submissions.

An optional company/account association can be added when a real company identity is explicitly supplied or later established. Trevra must not invent one merely because an email has a domain.

---

## 3. Goals

1. Any Trevra workspace can connect a landing page without Trevra-specific backend code changes.
2. A founder can create multiple capture sources inside their own workspace.
3. The capture credential, never request-body data, determines the destination workspace.
4. A captured visitor can exist as a Person without a prospect Account.
5. Every submission preserves provenance, attribution, consent assertions, message and timestamp.
6. Person dedupe is deterministic and explainable.
7. Repeated delivery is safe through source-scoped idempotency.
8. Websites keep their own frontend and edge/backend-for-frontend.
9. Trevra owns commercial truth and downstream GTM lifecycle.
10. No model guesses company, role, intent or lifecycle state during ingestion.
11. Capture does not automatically send outreach merely because a public event arrived.
12. The wire contract is simple enough for Cloudflare Workers, Vercel, Netlify, Next.js, Rails, Django, FastAPI, Go, PHP or plain Node to implement.

---

## 4. Non-goals

- Hosting every customer's landing page in Trevra.
- Replacing Cloudflare Workers, Vercel Functions, Next route handlers or a customer's existing backend.
- Moving a startup's product APIs into Trevra.
- Requiring a company Account before storing a Person.
- Exposing a workspace secret to browser JavaScript.
- Treating a marketing-consent assertion as universal permission for every future channel.
- Inferring a company from `person@gmail.com`, `person@example.com`, a surname or free-text message.
- Building an arbitrary user-programmable field mapping language in v1.

---

## 5. Ownership boundary

### Website / landing runtime owns

- marketing UI;
- same-origin form endpoint;
- browser-facing validation;
- honeypot/CAPTCHA/bot controls;
- origin/CORS checks;
- request-size limits;
- rate limiting at the public edge;
- mapping the site's local form into the Trevra intake contract;
- redirects/assets;
- product API proxying when needed;
- retries of transient Trevra failures using the same idempotency key.

### Trevra owns

- workspace routing;
- capture-source credentials;
- People;
- inbound submission history;
- deterministic dedupe;
- source/provenance;
- UTM/referrer attribution;
- consent assertions;
- optional Account associations;
- qualification and enrichment;
- inbox/operator workflow;
- outreach approvals/execution;
- replies and suppressions;
- minimal opportunity linkage and GTM outcome attribution;
- append-only GTM events.

A landing page must not become a second CRM.

---

## 6. Why Beseam's Cloudflare Worker stays

`landings/ecom-clean-lp` already uses a Cloudflare Worker as the landing site's backend-for-frontend. That role remains useful.

Target boundary:

```text
landings/ecom-clean-lp
  -> Cloudflare Worker
     -> /api/lead          -> Trevra capture
     -> /api/answer-check  -> Beseam/e-commerce product API
     -> /api/product-image -> merchant/CDN proxy
     -> redirects/assets/edge security
```

The Worker should keep website-edge responsibilities and lose CRM/GTM ownership.

After cutover it should no longer use these as canonical lead state:

- SendPulse address-book membership;
- notification email delivery;
- local lead lifecycle/dedupe;
- any other website-owned commercial record Trevra later has to reconstruct.

Product behavior such as answer checks, store scans, image proxying and commerce intelligence remains outside Trevra.

---

## 7. Capture Source

A **Capture Source** is the integration unit a founder creates inside their Trevra workspace.

Recommended product path:

```text
Setup
  -> Lead capture
  -> Add capture source
  -> "Beseam website"
  -> create
  -> Trevra shows source ID + signing secret once
```

### Suggested `capture_sources` table

```text
id
workspace_id
name
key
kind                       -- website | product | event | partner | other
status                     -- active | disabled
secret_ref                 -- secret-custody reference, never plaintext
previous_secret_ref        -- optional rotation overlap
previous_secret_expires_at
last_seen_at
created_by_user_id
created_at
updated_at
```

Constraints:

- source belongs to exactly one workspace;
- source key is unique inside that workspace;
- source ID cannot be moved to a different workspace;
- `kind` is descriptive metadata, not a behavior switch;
- secret values never appear in normal query results.

### Credential behavior

On create/rotate:

1. generate a cryptographically random signing secret;
2. show it once;
3. store it through Trevra's existing secret-custody/KMS boundary;
4. support a short old/new overlap during rotation;
5. write an audit event containing source ID and actor, never the secret.

The startup stores that secret in Cloudflare/Vercel/Netlify/server environment secrets.

It is never placed in browser code or a `NEXT_PUBLIC_*` variable.

---

## 8. Person model

The canonical database noun can be `contacts`; the product noun is **People**.

### Suggested `contacts` table

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

A contact may exist with no Account.

### Identity rules

Use only explicit deterministic identity.

Preferred matching order:

```text
source-scoped external ID, when supplied
  -> normalized email
  -> normalized E.164 phone, only when the source explicitly supplied E.164
  -> create a new Person if a sufficient identity exists
```

Do not guess phone country codes.

Do not derive an Account from the email domain.

Do not merge two People because their names look similar.

### Source external identity

Authenticated product surfaces may have their own user/customer ID.

Store that through a source-scoped identity table such as:

```text
contact_external_identities
  workspace_id
  contact_id
  capture_source_id
  external_id
  created_at
```

Unique:

```text
(capture_source_id, external_id)
```

This lets a SaaS product send events for `user_123` without exposing Trevra IDs.

---

## 9. Optional Account association

Inbound capture does not require an Account.

When the source explicitly supplies a real company/store domain, Trevra may resolve/create an Account and associate it with the Person.

Examples where association is valid:

```text
"companyDomain": "acme.com"
"store": "https://shop.acme.com"
explicit operator link after capture
later deterministic enrichment establishes the company
```

Examples that do **not** establish an Account:

```text
email = ada@gmail.com
email = ada@example.com without a submitted company field
message mentions "Acme"
name resembles a company
```

The association is separate:

```text
account_contacts
  workspace_id
  account_id
  contact_id
  role
  source
  confidence
  created_at
  updated_at
```

This keeps Account targeting and inbound People compatible without making one depend on the other.

---

## 10. Inbound Submission ledger

A form submission is important independently of the Person record.

Changing the Person's name/email later must not rewrite what was originally submitted.

### Suggested `inbound_submissions` table

```text
id
workspace_id
capture_source_id
contact_id                   -- nullable only for non-person events
account_id                   -- nullable and normally null for inbound people
idempotency_key
source_event_id              -- optional producer event ID
kind
message                      -- nullable
page_url                     -- nullable
referrer                     -- nullable
attribution_json             -- bounded
consent_json                 -- bounded
properties_json              -- bounded
payload_hash
occurred_at                  -- nullable producer timestamp
received_at
created_at
```

Unique:

```text
(capture_source_id, idempotency_key)
```

The submission is append-only evidence.

Do not store by default:

- honeypot fields;
- signing secrets;
- arbitrary request headers;
- browser IP addresses;
- unbounded nested JSON;
- full raw HTTP bodies after accepted fields are normalized/preserved.

---

## 11. Generic intake API

Endpoint:

```text
POST /api/intake/v1/submissions
```

Headers:

```text
Content-Type: application/json
X-Trevra-Source: cap_01...
X-Trevra-Timestamp: 1787250000
X-Trevra-Idempotency-Key: 01J...
X-Trevra-Signature: sha256=<hex>
```

The body never contains `workspaceId`.

### Canonical body

```json
{
  "kind": "demo_request",
  "occurredAt": "2026-08-20T18:10:00.000Z",
  "person": {
    "name": "Ada Example",
    "email": "ada@example.com",
    "phone": "+41441234567",
    "role": "Founder",
    "externalId": null
  },
  "company": null,
  "page": {
    "url": "https://acme.example/demo",
    "referrer": "https://www.google.com/"
  },
  "attribution": {
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "brand"
  },
  "consent": {
    "marketingEmail": true,
    "privacyAccepted": true,
    "capturedAt": "2026-08-20T18:10:00.000Z",
    "textVersion": "2026-08"
  },
  "message": "I'd like a demo.",
  "properties": {
    "plan_interest": "growth"
  }
}
```

B2B/store form example with an explicit company:

```json
{
  "kind": "store_health_review_requested",
  "person": {
    "name": "Ada Example",
    "email": "ada@example.com"
  },
  "company": {
    "domain": "acme.com",
    "name": "Acme"
  },
  "message": "Please review our store."
}
```

### Minimum accepted identity

For a person-oriented event, require at least one usable explicit person identity:

- email;
- E.164 phone;
- source-scoped `externalId`.

A message with no identity can be rejected in v1 rather than creating anonymous pseudo-People.

Non-person product events are outside this v1 capture contract unless a later design explicitly adds them.

---

## 12. Open event kinds

`kind` is source-defined and bounded, not a Trevra deployment enum.

Examples:

```text
contact_message
demo_request
waitlist_joined
newsletter_subscribed
store_health_review_requested
ai_scan_requested
product_signup
trial_started
```

Validation syntax:

```text
[a-z][a-z0-9._-]{0,79}
```

Downstream automations may match:

```text
capture_source_id + kind
```

This lets every startup use its own funnel language without adding source-specific Trevra code.

---

## 13. Custom properties

`properties` preserves useful startup-specific form fields.

Examples:

```json
{
  "team_size": "11-50",
  "plan_interest": "growth",
  "scan_id": "scan_123",
  "current_platform": "shopify"
}
```

Rules:

- JSON object only;
- bounded total bytes;
- bounded nesting depth;
- primitives and small primitive arrays only in v1;
- reserved identity/lifecycle keys cannot be overridden;
- custom properties do not silently mutate Person or Account fields;
- downstream playbooks may use them as source evidence.

No generic arbitrary JSON-to-database mapping engine is required.

---

## 14. Signature and replay protection

The website backend signs the exact raw JSON bytes.

Signing input:

```text
<timestamp>.<idempotency-key>.<raw-body>
```

Signature:

```text
HMAC-SHA256(capture_source_secret, signing_input)
```

Verification order:

1. read `X-Trevra-Source`;
2. resolve its Capture Source;
3. derive workspace from the source row;
4. reject disabled/unknown source;
5. enforce request-size limit before expensive parsing;
6. enforce a short timestamp replay window, e.g. five minutes;
7. constant-time verify active or rotation-overlap secret;
8. validate the canonical JSON schema;
9. transactionally claim `(capture_source_id, idempotency_key)`;
10. resolve Person;
11. optionally resolve explicit Account/company;
12. create immutable Inbound Submission;
13. append domain/control-plane events;
14. return stable IDs.

Never accept a body `workspaceId` or `contactId` as an authorization mechanism.

---

## 15. Idempotency and retries

The website generates one idempotency key for one logical visitor submission and reuses it on retry.

Response semantics:

```text
202  first accepted delivery
200  duplicate retry with identical payload hash
400  invalid body; do not retry unchanged
401  bad/expired signature
404  unknown capture source
409  same idempotency key reused with a different payload
413  payload too large
429  throttled; retry later with same key
5xx  transient Trevra failure; retry with same key
```

If the same key and payload hash already exist, return the original stable result.

If the same key arrives with a different payload hash, return `409`. Never guess which request was intended.

---

## 16. Deterministic Person merge policy

Capture must not silently overwrite operator-owned data.

A safe initial merge policy:

- exact normalized email matches an existing Person;
- exact source external ID matches its existing Person;
- an explicit source field may fill an empty canonical field;
- a conflicting non-empty canonical field is preserved;
- the conflicting source value remains visible in the Inbound Submission;
- conflicts may raise a review flag/event;
- no fuzzy-name merge;
- no model merge.

This means a second form can add a missing phone number, but cannot silently replace a corrected operator name with a different submitted name.

---

## 17. Attribution

Trevra stores attribution on the Inbound Submission, not as Person identity.

Recommended normalized keys:

```text
utm_source
utm_medium
utm_campaign
utm_term
utm_content
```

Every submission should be able to answer:

- which Capture Source sent it;
- which event kind occurred;
- which page/referrer was reported;
- which UTM values were reported;
- which Person it resolved to;
- whether an explicit company was supplied;
- when it occurred;
- when Trevra received it.

GTM attribution belongs downstream and must not be silently decided by ingestion. Capture preserves the evidence required to explain later qualification, campaign, conversation, and opportunity outcomes; it does not attempt to own revenue/accounting attribution.

---

## 18. Consent

`consent` stores assertions made by the source at capture time.

Examples:

```text
marketingEmail = true
privacyAccepted = true
termsAccepted = true
capturedAt = ...
textVersion = ...
```

Trevra preserves those assertions and provenance.

They do not bypass Trevra's later channel policy, suppressions or approval boundary.

Examples:

- newsletter consent does not automatically authorize unrelated cold outreach;
- a contact-message submission does not automatically execute a follow-up email;
- an unsubscribe still wins over an older marketing-consent assertion.

---

## 19. Intake stops at durable state

A public form submission must not directly trigger an uncontrolled external write.

Successful ingestion writes durable state/events such as:

```text
capture.source.received
contact.created | contact.matched
account.created | account.matched        -- only when explicit company supplied
account_contact.linked                   -- only when applicable
inbound_submission.created
```

Then downstream Trevra behavior can react:

```text
inbound_submission.created
  -> notify founder
  -> qualify
  -> enrich
  -> assign
  -> create opportunity
  -> prepare follow-up
  -> require policy/approval where applicable
```

The capture endpoint itself does not send the email, LinkedIn message or other outbound action.

---

## 20. Founder setup UX

Recommended location:

```text
Setup
  -> Lead capture
```

### Empty state

```text
Capture leads from your website

Connect a landing page, contact form, waitlist or product signup.
Submissions go directly into this Trevra workspace.

[ Add capture source ]
```

### Create source

Fields:

```text
Name: Beseam website
Type: Website
```

After create:

```text
Source ID
cap_01...

Signing secret
trv_capture_...

This secret is shown once.
[ Copy secret ]
```

Then show integration recipes for:

- Cloudflare Worker;
- Next.js / Vercel;
- Netlify Function;
- Node server;
- curl/raw HTTP.

The protocol is the product. SDKs are optional convenience layers.

### Source detail

Show:

- source name;
- source ID;
- status active/disabled;
- last accepted submission;
- accepted/rejected counts;
- event kinds recently received;
- rotate secret;
- disable source;
- copy integration example;
- test connection;
- no plaintext secret after initial creation.

One workspace can have many sources.

---

## 21. Generic adapter examples

### Cloudflare Worker

```text
browser
  -> POST /api/lead
  -> validate origin/body/honeypot/rate limit
  -> map local body to Trevra contract
  -> create one idempotency key
  -> HMAC sign with Worker secret
  -> POST Trevra
  -> return safe success/error to browser
```

### Next.js / Vercel

```text
client form
  -> /api/contact route handler
  -> validate
  -> HMAC sign using server-only env
  -> POST Trevra
```

### Traditional backend

Any server capable of HTTPS + HMAC-SHA256 can call the same endpoint.

No Trevra SDK is required.

---

## 22. Static-only sites

A signing secret must not be embedded in browser JavaScript.

A purely static site needs a tiny server-side edge function such as:

- Cloudflare Worker/Pages Function;
- Vercel Function;
- Netlify Function;
- existing backend.

A future browser-direct mode may use a publishable source token + strict allowed origins + CAPTCHA/Turnstile + separate abuse semantics, but that is intentionally not v1.

The secure server-to-server contract remains the canonical integration.

---

## 23. Beseam migration

Current Beseam landing behavior includes:

- same-origin `/api/lead`;
- origin/body-size validation;
- honeypot handling;
- SendPulse address-book writes;
- review/contact notification email;
- `/api/answer-check` product proxy;
- `/api/product-image` proxy;
- redirects/assets.

Target:

```text
Beseam visitor
  -> beseam.com form
  -> existing Cloudflare Worker /api/lead
  -> signed Trevra Capture Source
  -> Beseam Trevra workspace
  -> Person
  -> Inbound Submission
```

No prospect Account is required.

If a Beseam form explicitly contains a Shopify/store/company domain, that domain may additionally resolve to an Account, but the Person and submission exist independently.

### Example mapping

Current local payload:

```json
{
  "source": "contact",
  "name": "Ada",
  "email": "ada@example.com",
  "message": "Can we talk?",
  "utm": {
    "utm_source": "google"
  }
}
```

Trevra payload:

```json
{
  "kind": "contact_message",
  "person": {
    "name": "Ada",
    "email": "ada@example.com"
  },
  "message": "Can we talk?",
  "attribution": {
    "utm_source": "google"
  },
  "properties": {
    "landing_source": "contact"
  }
}
```

Store-review payload with an explicit store:

```json
{
  "kind": "store_health_review_requested",
  "person": {
    "name": "Ada",
    "email": "ada@example.com"
  },
  "company": {
    "domain": "shop.example.com"
  }
}
```

### SendPulse transition

Do not dual-write forever.

Preferred cutover:

1. create `Beseam website` Capture Source in the Beseam Trevra workspace;
2. migrate useful historical contacts/submissions if needed;
3. make Trevra the canonical `/api/lead` destination;
4. if SendPulse is still needed for newsletters, make it an explicit downstream Trevra integration/sync;
5. remove SendPulse credentials/write logic from the landing Worker.

### Notification-email transition

Once Trevra has the inbound operator workflow:

```text
contact_message
  -> Inbound Submission
  -> Trevra notification/inbox
```

The Worker no longer emails a lead as the canonical handoff.

A temporary email notification may coexist during rollout only after Trevra is already the canonical record.

---

## 24. Relationship to e-commerce `services/growth`

This design moves website-generated inbound leads to Trevra, but it does **not** by itself make `services/growth` deletable.

The old Growth subsystem can be removed after the wider growth-gap plan has moved and cut over all load-bearing behavior:

- canonical People/contacts;
- legacy Growth lead state that still matters;
- suppressions;
- cold-email delivery and ambiguous-send semantics;
- inbound email replies;
- outbound/inbound message history and provider IDs;
- required audit/drafting behavior;
- final state migration;
- old Growth admin/proxy/deployment integrations.

Website capture should be cut over before deleting Growth so new inbound people no longer land in a separate GTM silo.

---

## 25. Failure behavior

### Trevra temporarily unavailable

The adapter should:

- keep the same idempotency key;
- retry only transient `429`/`5xx` responses;
- use bounded exponential backoff or its platform queue;
- never generate a new logical submission on each retry;
- show a truthful browser error if synchronous acceptance cannot be guaranteed.

Cloudflare/Vercel queues are transport reliability only. They do not become the GTM system of record.

### Source disabled or revoked

Trevra refuses the request.

The adapter must never fall back to another workspace or a global/default source.

### Conflicting Person data

Preserve canonical operator-owned values, preserve the new source submission, and surface the conflict for review. Do not silently overwrite or fuzzy-merge.

---

## 26. Security requirements

- [ ] Workspace is derived only from authenticated `capture_source_id`.
- [ ] A request body cannot choose or override workspace.
- [ ] Capture secrets are never exposed to browser code.
- [ ] Secrets use Trevra's secret-custody/KMS boundary.
- [ ] HMAC verification covers exact raw bytes.
- [ ] HMAC comparison is constant-time.
- [ ] Timestamp replay window is enforced.
- [ ] Source-scoped idempotency claim is transactional.
- [ ] Same idempotency key + different payload returns `409`.
- [ ] Request/body/property sizes are bounded.
- [ ] Custom JSON depth/value types are bounded.
- [ ] Every contact/submission/account-association query is workspace-scoped.
- [ ] Cross-workspace IDs cannot create associations.
- [ ] Capture never directly executes outreach.
- [ ] Analytics payloads contain no message/body content.
- [ ] Secret create/rotate/revoke is audited without secret values.

---

## 27. Implementation plan

### Phase A — shared People spine

- [ ] Add forward-only PostgreSQL migration for `contacts`.
- [ ] Add `contact_external_identities`.
- [ ] Add deterministic contact normalize/match/create service.
- [ ] Add workspace-isolation and dedupe tests.
- [ ] Refine `account_contacts` into an optional association rather than a prerequisite for Person existence.
- [ ] Connect folder-import contact evidence to the shared Person model when explicit identities are present.

### Phase B — Capture Sources

- [ ] Add `capture_sources` migration/store.
- [ ] Add source create/list/disable/rotate operations.
- [ ] Store signing secrets through secret custody.
- [ ] Add short previous-secret overlap for rotation.
- [ ] Add source audit events.

### Phase C — Inbound Submissions

- [ ] Add `inbound_submissions` migration/store.
- [ ] Add source-scoped idempotency + payload hash.
- [ ] Add bounded attribution/consent/properties schemas.
- [ ] Add immutable provenance fields.
- [ ] Add optional explicit Account association.

### Phase D — signed intake API

- [ ] Add `POST /api/intake/v1/submissions` using raw body bytes.
- [ ] Verify HMAC + timestamp before accepting the payload.
- [ ] Derive workspace only from Capture Source.
- [ ] Implement stable duplicate/retry responses.
- [ ] Add request-size/source-rate guards.
- [ ] Emit append-only intake/contact/submission events.

### Phase E — Trevra setup/operator UX

- [ ] Add `Setup -> Lead capture`.
- [ ] Create source wizard with one-time secret reveal.
- [ ] Add Cloudflare Worker recipe.
- [ ] Add Next.js/Vercel recipe.
- [ ] Add raw HTTP/curl recipe.
- [ ] Add test-event flow.
- [ ] Show source health/last received without exposing content in analytics.
- [ ] Add inbound People/Submission operator view.

### Phase F — Beseam landing cutover

- [ ] Create Beseam Capture Source in the Beseam Trevra workspace.
- [ ] Change `ecom-clean-lp /api/lead` to forward signed Trevra submissions.
- [ ] Keep Cloudflare Worker edge validation/honeypot/rate limiting.
- [ ] Keep answer-check/image/product proxying outside Trevra.
- [ ] Make Trevra the canonical lead write.
- [ ] Remove direct SendPulse lead storage from Worker after verification.
- [ ] Move any retained newsletter sync behind explicit Trevra integration behavior.
- [ ] Remove notification-email-as-record behavior after Trevra operator notifications are live.

### Phase G — Growth retirement gate

- [ ] Migrate remaining useful Growth people/state/suppressions/messages.
- [ ] Enable Trevra-only cold send/reply paths.
- [ ] Pause old Growth sender/reply/discovery jobs.
- [ ] Run a Trevra-only verification window.
- [ ] Remove e-commerce Growth admin UI/proxy/config/deployment references.
- [ ] Delete `services/growth` only after all cutover gates pass.

---

## 28. Required tests

### Tenant routing

- [ ] Source A always writes into workspace A.
- [ ] Body `workspaceId` is rejected/ignored and cannot redirect a request.
- [ ] Source A cannot link to a Person/Account from workspace B.
- [ ] Disabling a source immediately stops new captures.

### Authentication/replay

- [ ] Correct HMAC succeeds.
- [ ] Bad HMAC fails.
- [ ] Stale timestamp fails.
- [ ] Active secret works during rotation.
- [ ] Previous secret works only during configured overlap.
- [ ] Revoked/expired previous secret fails.

### Idempotency

- [ ] First delivery creates one submission.
- [ ] Exact retry creates no duplicate.
- [ ] Same key/different body returns `409`.
- [ ] Concurrent identical deliveries create exactly one submission.

### Person behavior

- [ ] New email creates a Person without requiring an Account.
- [ ] Same normalized email matches the same workspace Person.
- [ ] Same email in another workspace creates/uses a different Person.
- [ ] Explicit source external ID matches deterministically.
- [ ] Fuzzy names never auto-merge.
- [ ] Conflicting source field does not overwrite operator-owned canonical value.
- [ ] Explicit company domain may link an Account but is optional.
- [ ] Email domain alone never creates an Account.

### Payload safety

- [ ] Oversized body rejected before expensive work.
- [ ] Deep/unbounded custom properties rejected.
- [ ] Reserved property keys cannot mutate system state.
- [ ] Honeypot/internal transport data is not persisted by Trevra.
- [ ] Message/body content never enters analytics events.

### Beseam adapter

- [ ] Existing contact form maps into a Person + Inbound Submission.
- [ ] Store-review form may additionally resolve explicit company domain.
- [ ] Worker retry reuses one idempotency key.
- [ ] `/api/answer-check` is unaffected.
- [ ] `/api/product-image` is unaffected.
- [ ] SendPulse outage is irrelevant once Trevra is canonical.

---

## 29. Cutover definition

A website is considered cut over when:

1. every new form submission first becomes durable in the correct Trevra workspace;
2. retries are idempotent;
3. the founder can see the Person and submission in Trevra;
4. attribution and source are preserved;
5. no website-owned CRM/list/email notification is required to reconstruct the lead;
6. downstream actions happen from Trevra policy/workflows, not directly from the public form endpoint.

For Beseam specifically, the Cloudflare Worker remains deployed. Its `/api/lead` route becomes a secure Trevra adapter instead of a GTM datastore/orchestrator.

---

## 30. Architectural rule

> A startup owns its website. Its Trevra workspace owns its leads.

The landing runtime captures and transports. Trevra remembers, deduplicates, qualifies and operates.
