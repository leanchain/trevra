# Trevra

Trevra is the open-source ledger and control plane for agent-operated go-to-market. Claude runs the revenue loop through modular skills; Trevra reconstructs what was sourced, proposed, agreed, delivered, invoiced, and paid, assembles a Revenue Proof Pack behind every finding, prepares the corrective work, and executes only what the founder approved or explicitly delegated — through the tools the business already uses.

## Public launch and discoverability

Trevra includes crawlable launch copy, canonical and social metadata, JSON-LD, a sitemap, robots directives, Web App Manifest, `llms.txt`, `llms-full.txt`, public `agents.md`, `humans.txt`, RFC 9116 `security.txt`, IndexNow support, and privacy-preserving first-party traction measurement. Configuration and launch verification are documented in [`docs/discoverability.md`](docs/discoverability.md).

## Storage guarantee

Trevra is **PostgreSQL-only**. There is no SQLite dependency, fallback, database file, or embedded development database.

- Application data and Better Auth use PostgreSQL.
- Every multi-step write uses a real PostgreSQL transaction.
- Action preparation and execution use row locks to prevent duplicate concurrent work.
- Schema migrations use a PostgreSQL advisory lock, so multiple Cloud Run instances cannot race migrations.
- Tests run against a real ephemeral PostgreSQL container.

## What is implemented

### Approval and evidence console

- prioritized daily revenue queue;
- proposal follow-ups, scope protection, unbilled-work detection, and overdue-payment collection;
- Revenue Proof Packs connecting agreements, requests, delivery proof, invoices, and payment history;
- client commercial timelines;
- confirmed revenue-at-risk, invoiced, and collected metrics;
- editable prepared actions and scheduled delivery;
- configurable standing instructions through Autopilot.

### Execution and integrations

- Gmail and Microsoft 365 message delivery through Nango-managed connections;
- QuickBooks, Xero, or Stripe invoice creation through `trevra-create-invoice`;
- HoneyBook or Bonsai change-order creation through `trevra-create-change-order`;
- marketplace history imports for Upwork, Fiverr, Contra, and generic CSV exports;
- PDF, DOCX, TXT, Markdown, and RTF agreement imports that create contracts, clauses, scope items, and milestones;
- optional structured model extraction with a deterministic local fallback;
- signed and deduplicated Stripe and Nango webhooks;
- canonical ingestion API for private systems.

Trevra does not rebuild OAuth, refresh-token rotation, provider credential storage, integration retries, or rate-limit handling. Nango Cloud or a self-hosted Nango deployment provides that plumbing. The canonical model and action contracts are in [`docs/integration-contracts.md`](docs/integration-contracts.md).

Proprietary systems can use sandboxed read modules, the trusted canonical ingestion endpoint, and configured HTTPS action adapters. Proprietary writes still pass through a playbook approval, exact-payload hash, JSON-schema validation, signed request, and idempotency key.

## Durable playbooks and hosted module registry

Trevra includes Temporal or PostgreSQL durable orchestration, exact-payload approvals, event-derived commercial projections, and built-in outreach, invoice, and change-order playbooks.

The hosted module registry supports Ed25519 publisher identities, signed digest-pinned releases, SBOMs, workspace installation, isolated OCI/WASI/remote execution, and privacy-safe popularity counters. The public landing page displays real run counts, success rates, installations, and popularity ranks without publishing workspace or customer data.

Architecture and operations are documented in:

- [`docs/control-plane-architecture.md`](docs/control-plane-architecture.md)
- [`docs/module-registry.md`](docs/module-registry.md)
- [`docs/sandbox-execution.md`](docs/sandbox-execution.md)
- [`docs/temporal-orchestration.md`](docs/temporal-orchestration.md)

## Operate from Claude Code or Codex

Trevra ships a restricted agent API, a local stdio MCP server, and a hosted Streamable HTTP MCP endpoint. Agent tokens can read the evidence-backed revenue brief, run enabled skills, inspect the run ledger, list pending actions, and prepare recommendations. They cannot approve or execute actions.

Create a scoped token in **Setup → Agent access**, then connect a local MCP bridge:

```bash
claude mcp add trevra --scope user \
  --env TREVRA_API_URL=http://localhost:43887 \
  --env TREVRA_AGENT_TOKEN=<agent-token> \
  -- npm --prefix /absolute/path/to/trevra run mcp
```

Or connect Codex directly to the hosted product runtime:

```bash
export TREVRA_AGENT_TOKEN=<agent-token>
codex mcp add trevra \
  --url https://app.example.com/api/agent/mcp \
  --bearer-token-env-var TREVRA_AGENT_TOKEN
```

Complete setup, CLI commands, API routes, scopes, and operating boundaries are documented in [`docs/agent-operation.md`](docs/agent-operation.md).

## Fastest local start

Requirements:

- Docker with Compose v2
- at least 6 GB of free Docker memory for the complete Trevra + Nango stack

Create your development environment file. It ships with a dedicated high-port block to avoid common local conflicts; every host port remains overrideable:

```bash
cp .env.dev.example .env.dev
```

Current defaults are `43173`, `43887`, `45432`, `45433`, `46379`, `43003`, and `43009`. Change any value in `.env.dev` before startup if one is already occupied.

Generate a unique Nango encryption key and replace the example value in `.env.dev`:

```bash
openssl rand -base64 32
```

Start Trevra, PostgreSQL, Redis, and self-hosted Nango:

```bash
docker compose --env-file .env.dev -f compose.dev.yml up --build
```

Open:

- Trevra: `http://localhost:43173`
- Trevra API: `http://localhost:43887`
- Nango API/dashboard: `http://localhost:43003`
- Nango Connect UI: `http://localhost:43009`
- Trevra PostgreSQL: `localhost:45432`
- Nango PostgreSQL: `localhost:45433`

### Google sign-in

Create a Google OAuth **Web application** client and configure:

- Authorized JavaScript origin: `http://localhost:43173`
- Authorized redirect URI: `http://localhost:43173/api/auth/callback/google`

Put the credentials in `.env.dev`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Then restart Trevra:

```bash
docker compose --env-file .env.dev -f compose.dev.yml up -d --force-recreate trevra
```

The sign-in flow requests only `openid`, `email`, and `profile`. Gmail and Calendar permissions are requested separately through Nango when the founder explicitly connects those tools.

The Trevra frontend and API hot-reload through the bind-mounted source tree.

After Nango starts, configure its provider integrations and copy the Nango environment secret key and webhook signing key into `.env.dev` as `NANGO_API_KEY` and `NANGO_WEBHOOK_SIGNING_KEY`. Restart only Trevra afterward:

```bash
docker compose --env-file .env.dev -f compose.dev.yml up -d --force-recreate trevra
```

Until those Nango keys are configured, the core Trevra demo, document import, marketplace import, recommendations, Proof Packs, and simulated development execution still work; live OAuth connections do not.

Stop the stack without deleting data:

```bash
docker compose --env-file .env.dev -f compose.dev.yml down
```

Delete all local development data explicitly:

```bash
docker compose --env-file .env.dev -f compose.dev.yml down -v
```

## Run the app directly against PostgreSQL

Start only PostgreSQL:

```bash
docker compose --env-file .env.dev -f compose.dev.yml up -d postgres
```

Then:

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:43173`.
## Tests and build

The test runner launches a real PostgreSQL 17 Testcontainer. Docker must be running.

```bash
npm run check
```

### Single-operator production

For one operator on one machine, deploy the hardened production build on loopback with:

```bash
npm run selfhost:deploy
```

This creates a gitignored `0600` secret file, a dedicated PostgreSQL volume, runs migrations once, and starts separate API and worker containers on `http://localhost:43900` by default. PostgreSQL is not published to the host. Create a custom-format backup with `npm run selfhost:backup`.

See [`docs/self-hosted-production.md`](docs/self-hosted-production.md) before exposing the service beyond the local machine; remote access requires HTTPS and secure cookies.

Individual commands:
Individual commands:

```bash
npm run typecheck
npm test
npm run build
```

## Production on Google Cloud

The supported production path is:

```text
Browser
   ↓
Cloud Run: Trevra
   ↓ Unix socket through Cloud SQL integration
Cloud SQL for PostgreSQL: regional HA + backups + PITR

Trevra Cloud Run
   ↓ HTTPS
Self-hosted Nango service
   ↓
Separate Nango PostgreSQL and Redis
```

Terraform under [`infra/gcp/terraform`](infra/gcp/terraform) provisions:

- Artifact Registry;
- a dedicated Cloud Run service account;
- Cloud Run with startup and liveness probes;
- Cloud SQL PostgreSQL 16 with regional high availability;
- SSD autoscaling, automated backups, 14 retained backups, and seven days of point-in-time recovery logs;
- Secret Manager values for the PostgreSQL URL, Better Auth, Nango, and internal ingestion;
- Cloud SQL Client and Secret Manager least-privilege access;
- migration-safe multi-instance startup.

### 1. Bootstrap remote Terraform state

```bash
export GCP_PROJECT_ID=your-project
export GCP_REGION=europe-west6
export TF_STATE_BUCKET=your-globally-unique-trevra-tfstate

./infra/gcp/bootstrap.sh
```

### 2. Deploy Trevra

Use a production HTTPS domain for the app and a separately deployed HTTPS Nango endpoint:

```bash
export GCP_PROJECT_ID=your-project
export GCP_REGION=europe-west6
export TF_STATE_BUCKET=your-globally-unique-trevra-tfstate
export APP_ORIGIN=https://app.example.com
export BETTER_AUTH_URL=https://app.example.com
export GOOGLE_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export GOOGLE_CLIENT_SECRET='your-client-secret'
export NANGO_HOST=https://nango-api.example.com
export NANGO_API_KEY='...'
export NANGO_WEBHOOK_SIGNING_KEY='...'

./infra/gcp/deploy.sh
```

The script enables required APIs, prepares Artifact Registry, builds the image with Cloud Build, and applies Terraform.

Cloud Run Compose is also represented in [`compose.gcp.yml`](compose.gcp.yml) for inspection or preview deployment, but [`infra/gcp/terraform`](infra/gcp/terraform) is the production source of truth.

### Production self-hosted Nango

[`compose.nango.production.yml`](compose.nango.production.yml) runs Nango with a Cloud SQL Auth Proxy and an external Redis endpoint. It is intended for a hardened GCE VM or equivalent long-running container host—not inside the Trevra Cloud Run service.

```bash
cp .env.nango.production.example .env.nango.production
chmod 600 .env.nango.production
docker compose --env-file .env.nango.production -f compose.nango.production.yml up -d
```

Place a TLS reverse proxy or HTTPS load balancer in front of ports 3003 and 3009. Keep the Nango encryption key permanently backed up: changing it after credentials have been encrypted can make those credentials unreadable.

See [`docs/deployment.md`](docs/deployment.md) for DNS, secrets, scaling, backup, restore, and Nango details.

## Database operations

Migrations run automatically at startup from `migrations/`. Trevra and Better Auth migrations are serialized with PostgreSQL advisory locks.

### One-time migration from the previous SQLite build

The application never reads SQLite at runtime. A separate migration utility exists only to preserve data from the previous build and requires Python 3's standard library.

Stop the old application, point `DATABASE_URL` at a **fresh PostgreSQL database**, and inspect the transfer first:

```bash
npm run db:migrate-sqlite -- --dry-run \
  --app data/trevra.db \
  --auth data/trevra-auth.db
```

Commit the migration:

```bash
npm run db:migrate-sqlite -- \
  --app data/trevra.db \
  --auth data/trevra-auth.db
```

Before reading any rows, the utility uses Python's SQLite backup API to create consistent snapshots in a timestamped `data/sqlite-backup-*` directory. The PostgreSQL import is one transaction and aborts if rows conflict. `--allow-conflicts` enables a non-destructive merge that skips existing rows.

Reset only the seeded demo workspace:

```bash
npm run db:reset
```

Production data is never deleted by this command.

Recommended production controls:

- Cloud SQL deletion protection;
- regional high availability;
- point-in-time recovery;
- automated backups plus periodic on-demand backups;
- scheduled logical exports to a separate project or bucket;
- quarterly restore drills into an isolated Cloud SQL instance;
- alerting on storage, connections, replication, backup failures, and database availability.

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
- `POST /api/imports/document`
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
- Approval hashes cover visible text and structured financial payloads.
- Execution is blocked if an approved payload changes.
- Production refuses simulated delivery.
- Scheduled work executes only after the approved time.
- External writes receive deterministic idempotency keys.
- Provider events are signature-verified and deduplicated.
- Every material state transition is audited.

## Before accepting paying customers

The code and deployment foundations are implemented. The operator still must complete:

- provider OAuth applications, scopes, reviews, and callback domains;
- Nango production integration functions and provider test connections;
- privacy policy, terms, DPA, subprocessor list, and deletion process;
- custom domains and DNS;
- alerts, incident response, backup validation, and restore drills;
- accounting-provider sandbox certification where applicable;
- security review and cross-tenant adversarial testing.

## Durable GTM control plane

Trevra includes a versioned playbook engine above the individual skill runner. Playbook runs persist their step state, attempts, evidence, policy decisions, approval payload hashes, retries, and outcomes in PostgreSQL. An append-only domain event stream records the same run across process restarts and worker resumptions.

The first built-in playbook is `gtm.audit-led-outreach`:

```text
score lead -> audit domain -> prepare outreach -> founder approval -> email execution
```

The **Work** view starts playbooks, displays step progress, and handles exact-payload approval or rejection. **Autopilot** includes a workspace policy editor and scoped Claude Code/Codex tokens.

Architecture and migration details are in [`docs/control-plane-architecture.md`](docs/control-plane-architecture.md).

### Playbook API

```text
GET    /api/playbooks
POST   /api/playbooks/:id/runs
GET    /api/playbook-runs
GET    /api/playbook-runs/:id
POST   /api/playbook-runs/:id/steps/:stepId/decision
GET    /api/control-plane/events
GET    /api/policies
POST   /api/policies
DELETE /api/policies/:id
```

Agent equivalents live under `/api/agent` and deliberately omit approval and execution.
