CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (poll_interval_minutes BETWEEN 15 AND 10080),
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, provider, name)
);
CREATE INDEX IF NOT EXISTS idx_research_sources_due ON research_sources(next_sync_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS research_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  parent_external_id TEXT,
  document_type TEXT NOT NULL CHECK(document_type IN ('post','comment')),
  community TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT,
  source_url TEXT NOT NULL,
  author_hash TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ,
  removed BOOLEAN NOT NULL DEFAULT FALSE,
  content_hash TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(workspace_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_research_documents_recent ON research_documents(workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_documents_community ON research_documents(workspace_id, provider, community);

CREATE TABLE IF NOT EXISTS research_source_documents (
  source_id TEXT NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
  matched_queries TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  discovered_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(source_id, document_id)
);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES research_sources(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('incremental','backfill')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  documents_seen INTEGER NOT NULL DEFAULT 0,
  documents_inserted INTEGER NOT NULL DEFAULT 0,
  documents_updated INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_research_runs_source ON research_runs(workspace_id, source_id, started_at DESC);
