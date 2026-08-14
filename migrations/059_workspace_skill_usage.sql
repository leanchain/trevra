-- Per-workspace skill usage, split out of the global `skills` catalogue.
--
-- `skills` is a CATALOGUE: one row per skill id that ships with this build,
-- carrying the name, version, enabled flag and operator config. It has no
-- `workspace_id` and it never will -- every tenant on a hosted deployment sees
-- the same catalogue, and that is correct.
--
-- `skills.run_count` and `skills.last_run_at` were not catalogue data. They were
-- USAGE, and putting usage in a global table gave a hosted deployment one
-- counter that every tenant incremented: tenant A's run advanced the number
-- tenant B read, and `last_run_at` told tenant B that somebody else had just run
-- the skill, which is a timing signal about another customer's activity. There
-- is no per-tenant question those two columns can answer honestly.
--
-- So usage moves here, keyed by (workspace_id, skill_id), and the two columns
-- are dropped rather than left behind to be read by accident. The backfill runs
-- first and reconstructs the real per-tenant numbers from `skill_runs`, which is
-- the append-only ledger every run already wrote to -- so no history is lost;
-- what is lost is the meaningless cross-tenant SUM the old columns held.
--
-- `skill_id` deliberately carries no foreign key to `skills`, for the same
-- reason `skill_runs.skill_id` does not: usage is history and must survive a
-- skill being removed from the catalogue by a later build.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, an ON CONFLICT DO NOTHING backfill,
-- and DROP COLUMN IF EXISTS. Safe to re-run against a database that already has
-- it, and safe against one that still holds the old columns and live data.

CREATE TABLE IF NOT EXISTS workspace_skill_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  run_count BIGINT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_skill_usage_recent
  ON workspace_skill_usage(workspace_id, last_run_at DESC);

-- Rebuild the per-tenant counters from the ledger before the global ones go.
-- `skill_runs` rows are only ever written with the running workspace's id, so
-- this is the true attribution the dropped columns never had.
INSERT INTO workspace_skill_usage (workspace_id,skill_id,run_count,last_run_at,created_at,updated_at)
SELECT workspace_id,skill_id,COUNT(*),MAX(started_at),MIN(started_at),MAX(started_at)
FROM skill_runs
GROUP BY workspace_id,skill_id
ON CONFLICT (workspace_id,skill_id) DO NOTHING;

ALTER TABLE skills DROP COLUMN IF EXISTS run_count;
ALTER TABLE skills DROP COLUMN IF EXISTS last_run_at;
