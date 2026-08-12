-- The kill switch, made real.
--
-- Before this column the "kill switch" of byok-and-hosted-agent.md §5 was a
-- relabel and nothing more: stopRunningAgentRuns set status='stopped' and
-- finished_at, and the loop -- which was in a different process, holding an
-- open model connection -- carried on, appended its next step, and charged the
-- operator's key for it. A row is not a process. Marking a run terminal from
-- the outside did not stop the spend; it only stopped the ledger from being
-- able to describe it, because the run then finished under a status nobody
-- could overwrite.
--
-- So the request and the outcome are now two different facts:
--
--   stop_requested_at  a human (or an operator tool) asked this run to stop.
--                      Written from outside the run, by any process.
--   status='stopped'   the run actually stopped. Written ONLY by whatever was
--                      running the loop, once it has really put the model down.
--
-- The loop reads the request between steps (isAgentRunStopRequested in
-- src/server/agent/runs.ts) and closes its own run out. That is why this is a
-- column and not an in-memory flag: the API process that receives the stop is
-- routinely not the worker process running the loop, and a signal that cannot
-- cross a process boundary cannot stop anything on a box with more than one.
--
-- NULLABLE, and never back-filled. NULL means "nobody asked", which is the
-- truth for every run that predates this migration.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;

-- The reaper (reapStaleAgentRuns) sweeps every workspace at once looking for
-- rows still 'running' past a threshold, and the schedule sweep asks "is a run
-- still in flight here" once per claimed workspace. Both are status-first
-- lookups; the existing (workspace_id, started_at) index cannot serve the
-- global one. Partial, because 'running' is the small, hot minority of this
-- table forever -- every other row is terminal and is never matched here.
CREATE INDEX IF NOT EXISTS idx_agent_runs_running
  ON agent_runs(started_at)
  WHERE status = 'running';
