-- A workspace's own Claude/Codex subscription, opted into per workspace --
-- the third way to run the hosted agent, alongside BYOK (migration 015) and
-- the operator's global TREVRA_AGENT_CLI env vars (cli.ts, unchanged by this
-- migration).
--
-- WHY THIS IS A DIFFERENT DECISION FROM THE GLOBAL ENV PATH'S HOSTED REFUSAL.
-- cli.ts's top comment calls the global path "a licence boundary, not a
-- preference": ONE operator's personal subscription silently backing EVERY
-- tenant's work is the actual ToS/multi-tenancy problem. A row here is scoped
-- to exactly one workspace and backs only that workspace's own runs -- the
-- same shape as BYOK's model key, not the shape the global guard exists to
-- stop. See the doc comment on `resolveWorkspaceCliBackend` in
-- src/server/agent/cli.ts for the full threat model.
--
-- What remains genuinely on the workspace, and is not mitigated by scoping:
-- pasting a personal subscription's OAuth session into any automated context
-- may itself brush against that subscription's own consumer terms, independent
-- of multi-tenancy. `risk_accepted_at` is how the workspace says, in writing,
-- that they were told this before they pasted anything.

CREATE TABLE IF NOT EXISTS workspace_cli_agent_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  cli TEXT NOT NULL CHECK (cli IN ('claude','codex')),

  -- Passed through to the CLI's own --model. Unlike the global env path,
  -- there is no "null means the CLI's default" here: the config screen always
  -- has a value on screen, so the stored row always has one too.
  model TEXT NOT NULL,

  -- THE GATE. Null until the workspace has explicitly accepted the risk
  -- disclaimer; `resolveWorkspaceCliBackend` refuses to resolve a backend at
  -- all until this is set, on every deployment mode -- self-host included.
  -- The frictionless path for a self-hoster who does not want the extra click
  -- is unchanged: the global TREVRA_AGENT_CLI env vars, which this table does
  -- not touch and do not require this column.
  --
  -- A timestamp rather than a boolean so the audit question "when did they
  -- agree to this" has an answer, and set back to NULL (never just flipped to
  -- false) by the revoke route, so re-accepting always means pasting into a
  -- screen that shows the disclaimer again rather than flipping a switch back.
  risk_accepted_at TIMESTAMPTZ,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The subscription OAuth token itself does NOT live in a column on this table
-- -- it goes into workspace_secrets (migration 015) under
-- kind='cli_oauth_token', sealed through the one AES-256-GCM crypto path that
-- table already has. `kind` there is TEXT with no CHECK constraint (see
-- migration 015's comment: widening it is an application-layer decision), so
-- no schema change is needed on that table for this migration to be additive.
-- What DOES need widening is the TypeScript `WorkspaceSecretKind` union in
-- src/server/secrets/store.ts, done alongside this migration.
