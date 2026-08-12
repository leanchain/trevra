-- When the hosted agent runs with nobody watching.
--
-- app-spec.md §2 is the whole reason this table exists. The hosted agent's one
-- advantage over the agent on your laptop is the row that says it "works when
-- your laptop is closed", and a loop that only ever starts because a human
-- clicked Start does not deliver that -- it is the laptop agent with extra
-- steps. The schedule is not a convenience layered on the feature; without it
-- the feature is not the one that was promised.
--
-- One row per workspace, deliberately, and not a job queue. A workspace has one
-- standing thing it wants looked at on a cadence. agent_runs already records
-- every execution, and a queue table sitting next to it would become a second
-- account of what the agent did -- the ledger is the trust surface and it does
-- not get a rival.

CREATE TABLE IF NOT EXISTS workspace_agent_schedule (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Off until an operator says otherwise, and this is the SECOND such switch:
  -- workspace_agent_budget.enabled is the first. byok-and-hosted-agent.md §5
  -- makes spending opt-in because "a stored key does not imply consent to spend
  -- it"; spending it unattended, on a timer, is a further decision that does not
  -- get to ride along on the budget's consent.
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- The standing instruction. Stored rather than derived so the operator can
  -- read back the exact sentence their money is being spent on, and so a run
  -- started by the schedule carries the same goal text into agent_runs as a run
  -- a human started by hand.
  goal TEXT NOT NULL,
  -- Daily. The floor of 15 minutes and the ceiling of one week are enforced in
  -- schedule.ts. The floor is load-bearing rather than tidy: the atomic claim
  -- pushes next_run_at forward by this much, so it has to comfortably exceed the
  -- clock difference between two worker replicas or the claim stops being safe.
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  -- Reporting only. Nothing schedules off this column.
  last_run_at TIMESTAMPTZ,
  -- The lease, not a derived value. The same UPDATE that selects a due row moves
  -- this forward, which is what stops two worker replicas both starting a run
  -- for one workspace and charging the operator's key twice for it. Deriving it
  -- from last_run_at + interval instead would put the decision in the reader,
  -- and two readers agree with each other right up until they don't.
  next_run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The worker asks "who is due?" across every workspace on every cycle, forever.
-- Partial on `enabled` because a disabled schedule is never due and most rows
-- are expected to be disabled -- the default is off.
CREATE INDEX IF NOT EXISTS idx_agent_schedule_due
  ON workspace_agent_schedule(next_run_at)
  WHERE enabled;
