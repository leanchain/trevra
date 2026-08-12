-- The hosted agent's run ledger.
--
-- byok-and-hosted-agent.md §6: "Every model call and every tool call lands in
-- the ledger. An autonomous agent you cannot audit afterwards is not a
-- feature." The agent runs with the laptop closed, so the only account of what
-- it did is the one it writes down. An operator who wakes up to a prepared
-- action has to be able to ask what the goal was, what the model asked for, and
-- what came back -- and get the answer from Postgres, not from whichever
-- process happened to still be alive.
--
-- This is a ledger, not a queue. Nothing here schedules or resumes work. Rows
-- are appended as a run progresses and are not rewritten afterwards, which is
-- what makes the record worth trusting later.
--
-- It is deliberately separate from skill_runs and domain_events. Those record
-- what the RUNTIME did; this records what the MODEL decided, including the
-- steps that produced nothing. A loop that burned twenty steps failing on one
-- tool leaves no trace anywhere else, and that is exactly the run an operator
-- needs to see.

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 'manual'   -- a human asked for this run
  -- 'schedule' -- the worker started it, nobody watching
  trigger TEXT NOT NULL,
  -- 'running' | 'completed' | 'failed' | 'stopped'.
  -- 'stopped' is the kill switch (§5) and is not a failure: it means a human or
  -- a budget cap ended a run that was otherwise healthy. Keeping it distinct
  -- from 'failed' is what makes "did the cap bite" answerable.
  status TEXT NOT NULL,
  goal TEXT NOT NULL,
  -- Denormalised from agent_run_steps so the bounded-loop ceiling can be
  -- enforced without counting rows on every step.
  step_count INT NOT NULL DEFAULT 0,
  max_steps INT NOT NULL,
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  -- Carried down from the run so an audit query never has to join to find out
  -- whose data a step touched.
  workspace_id TEXT NOT NULL,
  seq INT NOT NULL,
  -- 'model' | 'tool'. Both, because §6 asks for both and because a tool call
  -- without the reasoning that chose it is not an audit trail.
  kind TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Order is the whole point of a ledger, and two concurrent appends must not be
-- able to claim the same position. seq is allocated under the parent row's lock
-- (see appendAgentRunStep); this index is the guarantee that a future writer
-- which forgets to cannot corrupt the record silently.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_steps_seq
  ON agent_run_steps(run_id, seq);

-- The Activity screen reads "what has the agent been doing lately", newest
-- first, per workspace.
CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_started
  ON agent_runs(workspace_id, started_at DESC);
