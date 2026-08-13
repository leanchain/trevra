CREATE TABLE IF NOT EXISTS linkedin_campaign_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_contacts(id) ON DELETE RESTRICT,
  identity_key TEXT NOT NULL,
  seat_key TEXT NOT NULL DEFAULT 'owner',
  state TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 0,
  earliest_execution_at TIMESTAMPTZ,
  variant_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_members_one_active
  ON linkedin_campaign_members(workspace_id, identity_key)
  WHERE state IN ('pending','active','waiting','waiting_for_connection','waiting_for_manual_message','paused');

CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_progress
  ON linkedin_campaign_members(workspace_id, campaign_id, state, earliest_execution_at);
