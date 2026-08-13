CREATE TABLE IF NOT EXISTS linkedin_manual_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  campaign_member_id TEXT NOT NULL REFERENCES linkedin_campaign_members(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_contacts(id) ON DELETE RESTRICT,
  seat_key TEXT NOT NULL DEFAULT 'owner',
  workflow_step_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  instructions TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_manual_tasks_live
  ON linkedin_manual_tasks(campaign_member_id, workflow_step_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_linkedin_manual_tasks_queue
  ON linkedin_manual_tasks(workspace_id, seat_key, status, created_at);
