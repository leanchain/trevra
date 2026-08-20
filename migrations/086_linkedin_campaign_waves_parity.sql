-- Campaign waves, admission state, queue controls, and parity metadata.
-- A wave is an admission cohort. It is deliberately separate from linkedin_batches,
-- which remains one physical browser execution pass.

ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS admission_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS exclusion_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sender_keys_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_days_json JSONB,
  ADD COLUMN IF NOT EXISTS schedule_start_minute INTEGER,
  ADD COLUMN IF NOT EXISTS schedule_end_minute INTEGER,
  ADD COLUMN IF NOT EXISTS end_behavior TEXT NOT NULL DEFAULT 'finish_waves',
  ADD COLUMN IF NOT EXISTS last_admission_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_running_priority
  ON linkedin_campaigns(workspace_id, status, priority DESC, created_at ASC)
  WHERE status='running';

CREATE TABLE IF NOT EXISTS linkedin_campaign_waves (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL,
  member_count INTEGER NOT NULL,
  admission_reason TEXT,
  capacity_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_waves_campaign
  ON linkedin_campaign_waves(workspace_id, campaign_id, ordinal DESC);

ALTER TABLE linkedin_campaign_members
  ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wave_id TEXT REFERENCES linkedin_campaign_waves(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_seat_key TEXT,
  ADD COLUMN IF NOT EXISTS queue_priority INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS branch_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS paused_from_status TEXT,
  ADD COLUMN IF NOT EXISTS exclusion_reason TEXT,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_pending_admission
  ON linkedin_campaign_members(workspace_id, campaign_id, created_at, id)
  WHERE status='pending' AND admitted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_wave
  ON linkedin_campaign_members(workspace_id, campaign_id, wave_id)
  WHERE wave_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_assigned_seat
  ON linkedin_campaign_members(workspace_id, assigned_seat_key, status)
  WHERE assigned_seat_key IS NOT NULL;

-- Audience eligibility and personalization metadata shared by every campaign.
ALTER TABLE linkedin_lead_contacts
  ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS custom_fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS email_source TEXT,
  ADD COLUMN IF NOT EXISTS email_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS email_verification_status TEXT;

-- Workflow graph evolution is versioned independently from the row version.
ALTER TABLE linkedin_workflows
  ADD COLUMN IF NOT EXISTS graph_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace';

-- Queue and branch audit metadata. Existing action semantics remain unchanged.
ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS queue_priority INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS branch_decision_json JSONB,
  ADD COLUMN IF NOT EXISTS external_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS channel_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attachment_json JSONB;
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_due_priority
  ON linkedin_actions(workspace_id, seat_key, status, planned_for, queue_priority DESC)
  WHERE status='planned';
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_actions_external_idempotency
  ON linkedin_actions(workspace_id, external_idempotency_key)
  WHERE external_idempotency_key IS NOT NULL;

-- Operator-declared LinkedIn capability state; unknown is always the safe default.
ALTER TABLE linkedin_seats
  ADD COLUMN IF NOT EXISTS capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS inmail_monthly_budget INTEGER,
  ADD COLUMN IF NOT EXISTS inmail_paid_credit_cap INTEGER;
