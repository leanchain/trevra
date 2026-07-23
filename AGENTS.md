# AGENTS.md — Trevra repository guidance

## Product
Trevra is an evidence-backed revenue chief of staff for freelancers. Preserve the core boundary: models interpret commercial content, deterministic software controls money, permissions, state transitions, approvals, and external execution.

## Architecture
- `src/client`: React work console and public conversion surface.
- `src/server`: Express API, Better Auth, PostgreSQL data access, commercial intelligence, integrations, automation, and public discovery routes.
- `migrations`: forward-only PostgreSQL migrations. Never add a SQLite runtime path.
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
