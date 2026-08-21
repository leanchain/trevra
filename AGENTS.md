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

## Client UI system

- `src/client/ui/primitives.tsx` is the default entry point for ordinary form controls. Use `Button`, `Field`, `Input`, `Select`, and `Textarea` instead of inventing a new local skin for standard controls.
- The authenticated app shell carries the shared polished-control scope. New screens must visually fit that system by default; a feature-specific stylesheet may change layout, not redefine the base appearance of text inputs, selects, textareas, or primary/secondary buttons.
- Use the existing token layer in `src/client/styles.css` (`--t-*`). Do not introduce arbitrary hex colors, one-off radii, shadows, font sizes, or tap heights when an existing token expresses the role.
- Standard controls are at least `--t-tap` high, keyboard focus must remain visible, labels stay attached to their controls, disabled state must be obvious, and icon-only buttons require an accessible name.
- Buttons have semantic hierarchy: one primary action per local task, secondary for normal alternatives, ghost for low-emphasis chrome, danger only for destructive actions. Do not make every action visually primary.
- Native `<select>` is acceptable when styled through the shared primitive. Do not build a custom combobox unless the interaction genuinely needs search, async loading, grouping, or multi-select behavior; custom widgets must preserve keyboard and screen-reader behavior.
- Prefer progressive disclosure over dense forms. Put rare or advanced settings behind an existing details/drawer pattern instead of exposing every field at once.
- Reuse existing structural patterns (`page-panel`, `section-heading`, `panel-footer`, `li-table`, `ConfirmDrawer`, action/choice menus) before adding another card, modal, table, or menu implementation.
- Feature CSS should own composition (grid, spacing between sections, responsive behavior). Shared UI CSS owns the visual language of controls. If a feature stylesheet contains a full button/input/select skin, that is usually a design-system bug.
- Avoid inline `style` for reusable presentation. Add a named class or shared primitive instead.
- Touch and pointer targets must respect `--t-tap`; do not shrink actionable controls below it just to make a table or toolbar denser.
- Validate UI changes in both light and dark themes and at narrow/mobile widths. Keep `prefers-reduced-motion` behavior intact when adding animation.

## Client routing

- **Screens are addressed by PATH, never by hash.** `/outreach/inbox`, not `#/outreach/inbox`. `src/client/ui/route.ts` is the only router; it reads `location.pathname` and moves with `history.pushState`.
- **`#` means one thing: scroll to an element on the page you are already on.** The marketing page in `index.html` owns those anchors (`#hosted`, `#approval`, `#deploy`). No screen may read or write `location.hash`.
- In-app links are plain `<a href="/outreach/inbox">`. A document-level interceptor in `ui/route.ts` catches them; there is no `<Link>` component and none is needed.
- Adding a route means adding it in three places that must agree: `SECTIONS`/`SUB_ROUTES`/`SHELL_PATHS` in `src/client/ui/route.ts`, and `APP_PATH_HEADS` in `src/server/index.ts` so a reload of that URL serves the app instead of a 404.
- `src/client/ui/route.test.ts` fails the suite on any `#/` route literal or `location.hash` use in `src/client`. If it fires, the fix is the code, not the test.

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
