-- Immutable public intelligence snapshots. Workspace internals never render live on
-- public routes; publication freezes the exact evidence and methodology shared.

CREATE TABLE IF NOT EXISTS content_public_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  template TEXT NOT NULL CHECK (template IN ('market_pulse','index')),
  status TEXT NOT NULL CHECK (status IN ('published','unpublished')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  methodology_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot_hash TEXT NOT NULL,
  created_by TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  unpublished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,template,snapshot_hash),
  UNIQUE (workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_content_public_reports_workspace
  ON content_public_reports(workspace_id,published_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_public_reports_public
  ON content_public_reports(slug) WHERE status='published';
