-- Spend control for the hosted agent.
--
-- A loop holding the operator's own model key can burn real money with nobody
-- watching, so the cap ships WITH the feature rather than after the first
-- surprise bill. Two tables: the live budget the pre-flight check reads, and
-- the per-call ledger that answers "what did this run cost me".

CREATE TABLE IF NOT EXISTS workspace_agent_budget (
  -- One budget per workspace, not per key: a founder reasons about a monthly
  -- number, not about which provider it was spent through.
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- $20. Deliberately low: the first month should annoy, never bankrupt.
  monthly_cap_cents INTEGER NOT NULL DEFAULT 2000,
  -- Estimated, not billed. Enough to stop a runaway loop, not an invoice.
  spent_cents INTEGER NOT NULL DEFAULT 0,
  -- Start of the calendar month this spend belongs to. Kept as a column rather
  -- than derived so the rollover is a single atomic compare-and-reset inside
  -- whichever statement touches the row -- two worker cycles reading and then
  -- writing would double-spend across a month boundary.
  period_start TIMESTAMPTZ NOT NULL,
  -- Opt in, not out. A stored key does not imply consent to spend it, and this
  -- doubles as the kill switch: flip it false and the agent stops instantly.
  enabled BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS agent_model_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The run that caused the call, so cost has a per-job answer. Intentionally a
  -- plain TEXT with no foreign key: the runs table is owned by the agent loop
  -- and this ledger must not break, or block a migration, when that table is
  -- reshaped. An orphaned run id here is a worse outcome than a lost row there.
  run_id TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  -- The estimate charged against the budget at the moment of the call, frozen
  -- here so a later change to the price table cannot rewrite history.
  cost_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "What has this workspace spent lately", newest first -- the shape every
-- spend report and reconciliation walk asks for.
CREATE INDEX IF NOT EXISTS idx_agent_model_calls_workspace
  ON agent_model_calls(workspace_id, created_at DESC);

-- "What did this run cost". Separate index because run_id has no FK and so
-- gets no index for free.
CREATE INDEX IF NOT EXISTS idx_agent_model_calls_run
  ON agent_model_calls(workspace_id, run_id);
