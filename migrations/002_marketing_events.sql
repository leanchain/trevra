CREATE TABLE IF NOT EXISTS marketing_events (
  id TEXT PRIMARY KEY,
  visitor_hash TEXT,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  path TEXT,
  referrer_domain TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  content TEXT,
  term TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_marketing_events_created ON marketing_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_events_name_created ON marketing_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_events_source_created ON marketing_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_events_visitor ON marketing_events(visitor_hash, created_at DESC);
