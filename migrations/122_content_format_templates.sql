-- Reusable content STRUCTURE only. Reference wording is deliberately absent:
-- a template remembers shape/provenance, never the post text it came from.

CREATE TABLE IF NOT EXISTS content_format_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('own_published_post','manual_reference')),
  source_ref TEXT NOT NULL,
  structure_json JSONB NOT NULL,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  performance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,fingerprint),
  UNIQUE (workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_content_format_templates_active
  ON content_format_templates(workspace_id,status,updated_at DESC);
