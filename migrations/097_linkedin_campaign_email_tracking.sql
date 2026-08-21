-- Native campaign email telemetry: one opaque open token per sent email and
-- opaque redirect tokens for every tracked link. Tokens are random identifiers,
-- never campaign/member ids, so public tracking endpoints disclose no tenant data.
ALTER TABLE linkedin_campaign_channel_actions
  ADD COLUMN IF NOT EXISTS tracking_token TEXT,
  ADD COLUMN IF NOT EXISTS telemetry_checked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_channel_tracking_token
  ON linkedin_campaign_channel_actions(tracking_token)
  WHERE tracking_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_campaign_email_tracking_links (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_action_id TEXT NOT NULL REFERENCES linkedin_campaign_channel_actions(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, channel_action_id, target_url)
);

CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_email_tracking_links_action
  ON linkedin_campaign_email_tracking_links(workspace_id, channel_action_id);
