CREATE TABLE IF NOT EXISTS linkedin_action_attribution (
  action_id TEXT PRIMARY KEY REFERENCES linkedin_actions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  campaign_member_id TEXT NOT NULL REFERENCES linkedin_campaign_members(id) ON DELETE CASCADE,
  workflow_step_id TEXT NOT NULL,
  variant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_linkedin_action_attribution_member
  ON linkedin_action_attribution(workspace_id, campaign_member_id, workflow_step_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_action_attribution_variant
  ON linkedin_action_attribution(workspace_id, campaign_id, variant_id)
  WHERE variant_id IS NOT NULL;
