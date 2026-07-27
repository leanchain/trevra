CREATE TABLE IF NOT EXISTS research_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- gtm.watch-signal reads exactly one row per run: the newest capture for this
-- workspace+domain. History is kept rather than upserted onto a single row so a
-- signal can be re-derived later against any earlier baseline.
CREATE INDEX IF NOT EXISTS idx_research_snapshots_workspace_domain_captured ON research_snapshots(workspace_id, domain, captured_at DESC);
