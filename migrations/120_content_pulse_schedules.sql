-- Opt-in recurring Market Pulse preparation.
--
-- This schedules DB-only content preparation, never publishing. The workspace
-- automation lease runs it; the resulting LinkedIn row remains an ordinary
-- draft that a human must edit/schedule/publish through the existing flow.

CREATE TABLE IF NOT EXISTS content_pulse_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tag TEXT,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_opportunity_id TEXT,
  last_post_id TEXT,
  last_blocker TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_pulse_schedule_scope
  ON content_pulse_schedules(workspace_id, COALESCE(LOWER(tag),''));

CREATE INDEX IF NOT EXISTS idx_content_pulse_schedule_due
  ON content_pulse_schedules(workspace_id,next_run_at)
  WHERE enabled=TRUE;
