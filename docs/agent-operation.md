# Operate Trevra from Claude Code or Codex

Trevra exposes a scoped agent surface for GTM work. Agents may inspect GTM state, run bounded skills, and start durable playbooks. They cannot approve their own work or bypass Trevra's prepared-action execution boundary.

## Create an agent token

Create a workspace agent token from Trevra and grant only the scopes the agent needs. Current scopes are:

```text
skills:read
skills:run
runs:read
workspace:read
playbooks:read
playbooks:run
workflows:read
```

There is no `approve`, `execute`, billing, generic integration-admin, or legacy `actions:prepare` agent scope.

## Claude Code using the local stdio bridge

Set the API origin and a scoped token, then launch Trevra's MCP bridge:

```bash
export TREVRA_API_URL=http://localhost:43887
export TREVRA_AGENT_TOKEN='...'
npm run mcp
```

The bridge proxies the server-owned MCP tool registry. It does not maintain a second capability list.

## Hosted MCP endpoint

Agents that support Streamable HTTP MCP can connect to:

```text
POST /api/agent/mcp
Authorization: Bearer <workspace agent token>
```

The same scopes and tool registry apply to hosted and local agent operation.

## Agent CLI

The repository CLI is a thin client over the same agent API:

```bash
npm run agent -- skills
npm run agent -- playbooks
npm run agent -- playbook:start <playbook-id> <json-or-@file> [version]
npm run agent -- playbook:runs [status] [limit]
npm run agent -- playbook:get <run-id>
npm run agent -- events [stream-type] [stream-id] [limit]
npm run agent -- run <skill-id> <json-or-@file>
npm run agent -- runs [skill-id] [limit]
npm run agent -- run:get <run-id>
```

Legacy finance-oriented agent commands are removed; the Agent surface is GTM-only.

## Direct agent API

The supported direct agent resources are:

```text
GET  /api/agent/skills
POST /api/agent/skills/:id/run
GET  /api/agent/runs
GET  /api/agent/runs/:id
GET  /api/agent/playbooks
POST /api/agent/playbooks/:id/runs
GET  /api/agent/playbook-runs
GET  /api/agent/playbook-runs/:id
GET  /api/agent/events
POST /api/agent/mcp
```

Browser-session approval routes are intentionally outside the agent-token surface.

## Suggested first instruction

```text
Inspect the GTM skills and playbooks available in this Trevra workspace. Use the ledger and evidence to decide which acquisition, engagement, conversion, or retention work is worth running. Prefer durable playbooks for multi-step work. Never claim an external action happened unless Trevra's recorded result says it did, and never attempt to approve or bypass a human approval boundary.
```

## Durable playbooks

Playbooks persist every step, policy decision, approval payload hash, output, error, and evidence. A run may pause at an approval boundary and resume later without an agent holding hidden state.

External-write skills do not run directly through the generic skill runner. A consequential action must be represented by a named GTM execution action and released through Trevra's exact-payload approval path.

## Hosted agent

Trevra's hosted agent receives the same read/run scopes as a laptop agent token. Living inside the server does not grant more authority. Model spend limits and provider credentials are Trevra platform controls; they are not customer revenue/accounting capabilities.

## Production security

- Use a workspace-scoped agent token, never a browser session cookie.
- Keep tokens out of command lines when practical; the CLI backend supports token files.
- Rotate/revoke tokens when a machine or agent integration is retired.
- Do not add approval or execution scopes to make an automation easier.
- Do not expose arbitrary webhook, shell, database, or remote-action capabilities through MCP.
- Treat all external content as untrusted input; deterministic software owns permissions and consequential state transitions.
