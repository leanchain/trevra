-- First-class InMail and non-browser campaign channels.

ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS paid_credit_used BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS mailbox_assignments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS inmail_credit_cap INTEGER;

CREATE TABLE IF NOT EXISTS linkedin_campaign_channel_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES linkedin_campaign_members(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  workflow_step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  planned_for TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  variant_id TEXT,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_ref TEXT,
  provider TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_channel_actions_due
  ON linkedin_campaign_channel_actions(workspace_id, status, planned_for, created_at)
  WHERE status='planned';
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_channel_member_step
  ON linkedin_campaign_channel_actions(member_id, workflow_step_id)
  WHERE status <> 'skipped';

CREATE TABLE IF NOT EXISTS linkedin_campaign_email_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_action_id TEXT NOT NULL REFERENCES linkedin_campaign_channel_actions(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  provider_event_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_email_provider_event
  ON linkedin_campaign_email_events(workspace_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_email_action_events
  ON linkedin_campaign_email_events(workspace_id, channel_action_id, occurred_at);

CREATE TABLE IF NOT EXISTS linkedin_campaign_mailbox_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  daily_limit INTEGER NOT NULL DEFAULT 50,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  working_days_json JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  work_start_minute INTEGER NOT NULL DEFAULT 480,
  work_end_minute INTEGER NOT NULL DEFAULT 1080,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, connection_id)
);

ALTER TABLE linkedin_campaign_channel_actions
  ADD COLUMN IF NOT EXISTS connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outcome_known BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_channel_retry
  ON linkedin_campaign_channel_actions(workspace_id, status, next_retry_at)
  WHERE status='failed' AND outcome_known=TRUE;
