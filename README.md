# Trevra

Trevra is a revenue chief of staff for independent professionals. It continuously reconstructs what was sold, requested, delivered, invoiced, and paid; assembles a Revenue Proof Pack for every finding; prepares the corrective work; and executes approved or explicitly delegated actions through the freelancer's existing tools.

## What is implemented

### Freelancer work console

- prioritized daily revenue queue;
- proposal follow-ups, scope protection, unbilled-work detection, and overdue-payment collection;
- Revenue Proof Packs connecting agreements, requests, delivery proof, invoices, and payment history;
- client commercial timelines;
- confirmed revenue-at-risk, invoiced, and collected metrics;
- editable prepared actions and scheduled delivery;
- configurable standing instructions through Autopilot.

### Execution

- Gmail and Microsoft 365 message delivery through Nango-managed connections;
- QuickBooks, Xero, or Stripe invoice creation through the standardized `trevra-create-invoice` Nango action;
- HoneyBook or Bonsai change-order creation through `trevra-create-change-order`;
- marketplace history imports for Upwork, Fiverr, Contra, and generic CSV exports;
- PDF, DOCX, TXT, Markdown, and RTF agreement imports that build contracts, clauses, scope items, and milestones;
- optional structured model extraction with a deterministic local fallback;
- direct signed Stripe payment webhooks;
- signed Nango auth and incremental-sync webhooks;
- a canonical ingestion API for private internal systems.

### Defensible product layer

- provider-independent commercial graph;
- immutable source provenance with content hashes;
- contract clauses and a living Scope Ledger;
- evidence-linked recommendations;
- standardized Revenue Proof Packs;
- exact approval hashing covering visible text and structured financial payloads;
- deterministic idempotency keys for external writes;
- recommendation outcomes and confirmed payment attribution;
- complete audit events.

### Production foundations

- Better Auth for account and session management;
- stable `better-sqlite3` databases with WAL and busy timeouts;
- automatic auth and application migrations;
- tenant-scoped queries and automatic workspace creation;
- Helmet security headers, same-origin write enforcement, secure cookies, and rate limiting;
- Pino structured request logs with credential and payload redaction;
- signed and deduplicated webhooks;
- background automation and scheduled-action worker;
- strict production environment validation;
- non-root multi-stage Docker image with persistent volume and health check;
- ten API and engine tests.

## Architecture boundary

Trevra does **not** reimplement OAuth, refresh-token rotation, provider credential storage, integration retries, rate-limit handling, or incremental sync infrastructure. Nango Cloud or a self-hosted Nango deployment provides that integration plumbing.

Trevra owns the part that differentiates the product:

```text
Connected provider
      ↓
Nango authorization, sync, retries, write-back
      ↓
Canonical commercial records + immutable provenance
      ↓
Commercial graph and Scope Ledger
      ↓
Revenue detection and Proof Pack
      ↓
Policy / standing instruction
      ↓
Prepare → approve or delegate → execute
      ↓
Invoice, message, change order, or payment outcome
```

The canonical models and action contracts are defined in [`docs/integration-contracts.md`](docs/integration-contracts.md).

## Local development

Requirements:

- Node.js 24+
- npm

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The sign-in screen includes a seeded demo button in development.

Frontend changes use Vite HMR. Server changes restart through `tsx watch`.

## Tests and build

```bash
npm run check
```

Individual commands:

```bash
npm run typecheck
npm test
npm run build
```

## Production configuration

Production startup rejects unsafe configuration. At minimum configure:

```bash
NODE_ENV=production
APP_ORIGIN=https://app.example.com
BETTER_AUTH_URL=https://app.example.com
BETTER_AUTH_SECRET=<at-least-32-random-characters>
COOKIE_SECURE=true
NANGO_API_KEY=<nango-secret-key>
NANGO_WEBHOOK_SIGNING_KEY=<nango-webhook-signing-key>
```

Also configure the provider integration IDs and sync/action names shown in `.env.example`. Set `OPENAI_API_KEY` and `OPENAI_EXTRACTION_MODEL` to use structured model extraction for uploaded agreements; without them, Trevra uses the deterministic local parser.

Production validation rejects demo authentication and simulated execution. It also requires a Stripe webhook secret whenever a Stripe secret key is configured.

## Nango setup

1. Create or self-host a Nango environment.
2. Add the provider integrations required for the launch segment.
3. Configure Nango Connect and the callback URLs for the deployment domain.
4. Implement sync functions that return the canonical models in `docs/integration-contracts.md`.
5. Implement `trevra-create-invoice` for the chosen accounting provider.
6. Optionally implement `trevra-create-change-order` for HoneyBook or Bonsai.
7. Point Nango webhooks to `https://<domain>/api/webhooks/nango`.
8. Set the matching integration and sync names in the environment.

Gmail and Microsoft message writes use Nango's proxy directly. Accounting and project-management writes use standardized Nango actions because creating an invoice or change order requires provider-specific customer, account, tax, and item mapping.

## Stripe setup

Point signed Stripe events to:

```text
https://<domain>/api/webhooks/stripe
```

Add `trevra_workspace_id` and, where available, `trevra_invoice_id` to Stripe metadata. Trevra verifies the raw webhook signature, stores the Stripe event ID before processing, updates the invoice ledger, and records confirmed collected revenue.

## Docker

Build:

```bash
docker build -t trevra:production .
```

Run:

```bash
docker run --rm \
  -p 8787:8787 \
  -v trevra-data:/app/data \
  --env-file .env.production \
  trevra:production
```

The image runs as a non-root `trevra` user. Both application and authentication databases live in `/app/data`.

## Deployment profile

The included database configuration is production-suitable for a **single application instance or private beta** with persistent storage, WAL, backups, and regular restore tests. A horizontally scaled multi-instance deployment should replace the application storage layer with PostgreSQL before enabling concurrent writers across instances. Better Auth already supports PostgreSQL; the commercial repository currently uses synchronous SQL tailored to SQLite.

## Primary API surface

### Authentication

- Better Auth endpoints under `/api/auth/*`
- `GET /api/auth/session`
- development-only `POST /api/auth/demo`

### Work

- `GET /api/dashboard`
- `GET /api/recommendations`
- `POST /api/recommendations/:id/prepare`
- `POST /api/recommendations/:id/snooze`
- `POST /api/recommendations/:id/dismiss`
- `POST /api/actions/:id/approve`
- `POST /api/actions/:id/execute`

### Connections and ingestion

- `GET /api/integrations`
- `POST /api/integrations/connect-session`
- `POST /api/integrations/:id/sync`
- `DELETE /api/integrations/:id`
- `POST /api/imports/marketplace`
- `POST /api/events`
- `POST /api/webhooks/nango`
- `POST /api/webhooks/stripe`

### Automation

- `GET /api/automation/rules`
- `PUT /api/automation/rules/:type`
- `POST /api/automation/run`

## Safety rules

- Scope changes can never be auto-executed.
- A manual or delegated approval stores the hash of visible and structured payloads.
- Execution is blocked if that payload changes.
- Production refuses simulated delivery.
- Scheduled work is executed only after its approved time.
- Provider writes receive deterministic idempotency keys.
- Incoming provider events are signature-verified and deduplicated.
- Every material state transition is audited.

## Before accepting paying customers

The software path is implemented, but the operator must still complete non-code launch requirements:

- provider OAuth applications, scopes, and any required reviews;
- Nango production integration functions and test connections;
- privacy policy, terms, DPA, subprocessor list, and deletion policy;
- encrypted infrastructure backups and restore drills;
- domain, TLS, transactional-email configuration, and monitoring alerts;
- security review and cross-tenant adversarial testing;
- accounting-provider sandbox certification where applicable.
