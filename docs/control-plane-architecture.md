# Trevra durable control plane

Trevra separates model reasoning from durable, deterministic execution.

```text
Claude / Codex / browser
          |
          v
Scoped APIs and MCP
          |
          v
Versioned playbooks
          |
          v
Temporal or PostgreSQL orchestration
   |          |           |
   v          v           v
Modules    Policies    Approvals
   |          |           |
   +----------+-----------+
              |
              v
Prepared-action gateway
              |
              v
Email / invoice / change order providers
```

## Durable playbooks

Playbooks are versioned graphs of typed skill, approval, and action steps. Every run persists its step attempts, retry schedule, evidence, policy verdict, exact approval hash, and final outcome.

Built-in closed loops include:

- `gtm.audit-led-outreach`: score, audit, draft, approve, and send;
- `revenue.invoice-delivered-work`: approve and create an invoice;
- `revenue.protect-scope`: approve and create a change order.

The standalone worker resumes work after process or infrastructure failure. Hosted deployments can use Temporal; simple self-hosted deployments use PostgreSQL leases.

## Events and projections

Control-plane events live in `domain_events`. Commercial entity changes are captured in `commercial_entity_events` with per-entity versions and global positions. The projection worker builds `commercial_entity_projections` exclusively from that append-only stream and can rebuild them from zero.

Existing operational tables remain transactionally authoritative during the incremental migration. New projections provide a rebuildable read model without requiring a flag-day rewrite.

## Policy and approval

Workspace policies produce `allow`, `deny`, or `require_approval` before module execution. Generic external-write modules are prohibited. Consequential work must use a dedicated action adapter.

Approval payloads are canonically serialized and SHA-256 hashed. Execution verifies the stored approval record and current payload hash immediately before calling a provider. Agent tokens have no approval or execution scope.

Current action adapters are:

- `email.send`;
- `invoice.create`;
- `change_order.create`.

## Signed modules and sandboxing

Community releases carry publisher identity, Ed25519 signature, artifact digest, JSON Schemas, requested permissions, SBOM, source commit, resource ceilings, and side-effect declarations.

Installed community modules execute through an isolated sandbox gateway. OCI modules can run as gVisor Kubernetes Jobs; local OCI and WASI runners are available for development. All runs use the same ledger, events, policies, MCP tools, and aggregate popularity counters as built-ins.

## Hosted registry and popularity

The hosted registry publishes total runs, successful and failed runs, success rate, historical unique workspaces, active installations, latest activity, and popularity rank. No workspace identity or run content is public.

See [`module-registry.md`](module-registry.md), [`sandbox-execution.md`](sandbox-execution.md), and [`temporal-orchestration.md`](temporal-orchestration.md).
