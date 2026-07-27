# Operate Trevra from Claude Code or Codex

Trevra exposes the same workspace through three agent interfaces:

1. **Hosted Streamable HTTP MCP** at `https://your-app.example/api/agent/mcp`.
2. **Local stdio MCP bridge** with `npm run mcp`.
3. **JSON CLI/API** for scripts and debugging.

All three use a scoped workspace agent token. The token can inspect the revenue brief, run typed skills, read the skill ledger, list pending actions, and prepare a recommendation for review. It cannot approve or execute an action, change integrations, manage billing, or administer the account.

## Create an agent token

Sign in to Trevra and open **Autopilot → Claude Code and Codex access**.

1. Give the token a name, such as `Claude Code on laptop`.
2. Select **Create token**.
3. Copy the token immediately. Trevra stores only its hash and cannot reveal it again.
4. Revoke the token from the same screen when the machine or agent no longer needs access.

Default token scopes:

- `skills:read`
- `skills:run`
- `runs:read`
- `workspace:read`
- `actions:prepare`

Approval and execution are intentionally not agent-token scopes.

## Claude Code using the local stdio bridge

Use an absolute path to the Trevra checkout:

```bash
claude mcp add trevra --scope user \
  --env TREVRA_API_URL=https://app.example.com \
  --env TREVRA_AGENT_TOKEN=<agent-token> \
  -- npm --prefix /absolute/path/to/trevra run mcp
```

For a local Trevra API, replace the URL with `http://localhost:43887`.

The bridge discovers the live skill registry at startup and publishes one MCP tool per enabled skill, plus:

- `trevra_revenue_brief`
- `trevra_list_pending_actions`
- `trevra_prepare_recommendation`
- `trevra_list_skills`
- `trevra_list_runs`
- `trevra_get_run`

## Codex using the hosted MCP endpoint

Keep the token in an environment variable rather than putting it in the URL:

```bash
export TREVRA_AGENT_TOKEN=<agent-token>

codex mcp add trevra \
  --url https://app.example.com/api/agent/mcp \
  --bearer-token-env-var TREVRA_AGENT_TOKEN
```

Codex can also use the local stdio bridge:

```bash
codex mcp add trevra-local \
  --env TREVRA_API_URL=http://localhost:43887 \
  --env TREVRA_AGENT_TOKEN=<agent-token> \
  -- npm --prefix /absolute/path/to/trevra run mcp
```

## Claude Code using the hosted endpoint directly

Claude Code supports an HTTP MCP server with custom headers. The local stdio bridge is preferred because it keeps the bearer token in the MCP subprocess environment rather than embedding it in a URL.

```bash
claude mcp add trevra-hosted --scope user \
  --transport http \
  --header "Authorization: Bearer <agent-token>" \
  https://app.example.com/api/agent/mcp
```

## Agent CLI

Set the API and token in the shell:

```bash
export TREVRA_API_URL=http://localhost:43887
export TREVRA_AGENT_TOKEN=<agent-token>
```

Read the revenue brief and prepare one recommendation:

```bash
npm run agent -- brief
npm run agent -- actions
npm run agent -- prepare <recommendation-id>
```

List installed skills:

```bash
npm run agent -- skills
```

Run a skill with inline JSON:

```bash
npm run agent -- run gtm.score-lead \
  '{"lead":{"platform":"shopify","vertical":"footwear","catalogSize":100}}'
```

Run with a JSON file:

```bash
npm run agent -- run gtm.visibility-audit @input.json
```

Read the ledger:

```bash
npm run agent -- runs gtm.score-lead 20
npm run agent -- run:get <run-id>
```

## Direct agent API

Every request uses a bearer agent token. Available routes:

```text
POST /api/agent/mcp
GET  /api/agent/revenue-brief
GET  /api/agent/actions
POST /api/agent/recommendations/:id/prepare
GET  /api/agent/skills
POST /api/agent/skills/:id/run
GET  /api/agent/runs
GET  /api/agent/runs/:id
```

The generic skill runner refuses `external-write` skills. External writes must become a Trevra action and pass through the existing exact-payload approval and execution path.

## Suggested first instruction

```text
Use Trevra to read the current revenue brief. Rank the three most important
opportunities by evidence, value, urgency, and confidence. Run any safe analysis
skills that improve the decision. Prepare the best next action, but do not approve
or execute anything. Return the Trevra run IDs and the prepared action ID.
```

The founder then opens Trevra, reviews the proof and exact payload, and approves or edits the action.

## Production security

- Set `TREVRA_AGENT_TOKEN_PEPPER` to a private random value in the product runtime.
- Never put a plaintext agent token in source control, logs, analytics, screenshots, or a public Cloudflare Pages variable.
- The MCP endpoint belongs on the authenticated Express/PostgreSQL product origin, not the static Cloudflare Pages marketing origin.
- Use HTTPS for hosted MCP.
- Create separate tokens per device or agent and revoke them independently.
- Keep external execution behind Trevra approvals; do not add approval or execution to default agent scopes.

## Durable playbooks

Agent tokens now include `playbooks:read`, `playbooks:run`, and `workflows:read` by default. Agents can start and inspect durable playbook runs but cannot approve a waiting step.

CLI commands:

```bash
npm run agent -- playbooks
npm run agent -- playbook:start gtm.audit-led-outreach @lead.json
npm run agent -- playbook:runs waiting_approval 20
npm run agent -- playbook:get <run-id>
npm run agent -- events playbook_run <run-id> 100
```

MCP tools:

- `trevra_list_playbooks`
- `trevra_start_playbook`
- `trevra_list_playbook_runs`
- `trevra_get_playbook_run`
- `trevra_list_events`

When a playbook reaches an approval step, the agent should report the run id, step id, evidence, and the fact that a founder decision is required. The decision is made in Trevra's **Work** view. After approval, a dedicated action step verifies the same payload hash before calling the provider gateway. The agent itself never receives approval authority.
