-- Idempotency / unknown-outcome ledger for founder-approved Buffer draft creation.
-- A Buffer draft is an external write even though it is not scheduled or published.
-- We therefore claim an exact payload before the network call and never blindly retry
-- an ambiguous outcome.
CREATE TABLE IF NOT EXISTS content_buffer_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_post_id TEXT NOT NULL REFERENCES linkedin_posts(id) ON DELETE CASCADE,
  buffer_channel_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating','created','unknown','failed')),
  external_ref TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, buffer_channel_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_content_buffer_drafts_post
  ON content_buffer_drafts(workspace_id,source_post_id,created_at DESC);
