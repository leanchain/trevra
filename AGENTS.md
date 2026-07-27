# AGENTS.md — Trevra repository guidance

## Product
Trevra is the evidence-backed ledger and control plane for agent-operated go-to-market, aimed at founders. Preserve the core boundary: models interpret commercial content, deterministic software controls money, permissions, state transitions, approvals, and external execution.

## Architecture
- `src/client`: React work console and public conversion surface.
- `src/server`: Express API, Better Auth, PostgreSQL data access, commercial intelligence, integrations, durable playbooks, policy evaluation, append-only events, automation, and public discovery routes.
- `migrations`: forward-only PostgreSQL migrations. Never add a SQLite runtime path.

- `src/server/playbooks`: versioned playbook definitions and PostgreSQL durable orchestration. Preserve resumability and exact approval payload hashing.
- `src/server/control-plane`: append-only domain events, exact payload hashing, execution adapters, and deterministic workspace policy evaluation.
- `src/server/registry` and `src/server/sandbox`: signed community releases, aggregate popularity, installation, and isolated execution.
- `src/worker` and `src/server/orchestration`: standalone workflow worker, Temporal integration, PostgreSQL fallback, automation, and projections.
- External-write skills must never execute through the generic skill or playbook runner. They require a dedicated prepared-action adapter and the existing approval/execution boundary.
- `docs/integration-contracts.md`: normalized Nango records and actions.
- `infra/gcp`: Cloud Run, Cloud SQL, Secret Manager, and self-hosted Nango deployment material.

## Required checks
Run `npm run check` before committing. Tests use a real PostgreSQL Testcontainer. Also run `npm audit --omit=dev`, `docker compose config`, and `terraform validate` when touching dependencies or infrastructure.

## Data safety
- Scope every commercial query by workspace.
- Use PostgreSQL transactions for multi-step writes and row locks for competing executions.
- Keep provider credentials in Nango or Secret Manager, never application tables or source control.
- External writes require deterministic idempotency keys.
- Scope changes always require manual approval.
- Analytics must not contain client content, email bodies, document text, invoice details, or IP addresses.

## Public discoverability
- Canonical public copy and machine resources are implemented in `src/server/public-site.ts`.
- The crawlable initial HTML is `index.html`; keep its visible FAQ consistent with JSON-LD.
- Keep `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt`, `/agents.md`, and `/.well-known/security.txt` public.
- Never expose authenticated routes, customer data, internal prompts, or provider credentials in discovery files.
- Add meaningful pages to the sitemap only when they contain distinct public value.

## Integrations
Do not rebuild OAuth, token rotation, rate-limit handling, or sync storage. Use Nango or official provider SDKs. Trevra owns normalization, source provenance, proof packs, policy, and outcomes.
