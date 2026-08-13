-- Reusable lead lists, workflows and per-lead campaign state for the LinkedIn
-- outreach manager. This extends the existing campaign/action ledger; it does
-- not create a second outbound queue.

CREATE TABLE IF NOT EXISTS linkedin_lead_lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'csv',
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_lists_name
  ON linkedin_lead_lists(workspace_id, LOWER(name));

CREATE TABLE IF NOT EXISTS linkedin_lead_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  company TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  country TEXT,
  profile_url TEXT,
  dedupe_key TEXT NOT NULL,
  original_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_contacts_list_dedupe
  ON linkedin_lead_contacts(workspace_id, list_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_contacts_profile
  ON linkedin_lead_contacts(workspace_id, LOWER(profile_url))
  WHERE profile_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  steps_json JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_workflows_name
  ON linkedin_workflows(workspace_id, LOWER(name));

ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS lead_list_id TEXT REFERENCES linkedin_lead_lists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workflow_id TEXT REFERENCES linkedin_workflows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_seat_status
  ON linkedin_campaigns(workspace_id, seat_key, status, created_at DESC);

CREATE TABLE IF NOT EXISTS linkedin_campaign_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  step_index INTEGER NOT NULL DEFAULT 0,
  next_eligible_at TIMESTAMPTZ,
  assigned_variants JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_members_campaign_contact
  ON linkedin_campaign_members(campaign_id, contact_id);
-- Pausing a lead does not release it to another campaign. Only terminal removal,
-- reply, completion or failure releases the one-campaign claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_campaign_members_one_active
  ON linkedin_campaign_members(workspace_id, contact_id)
  WHERE status IN ('pending','active','waiting','manual','paused');
CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_due
  ON linkedin_campaign_members(workspace_id, campaign_id, next_eligible_at)
  WHERE status IN ('active','waiting');

CREATE TABLE IF NOT EXISTS linkedin_manual_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES linkedin_campaign_members(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_lead_contacts(id) ON DELETE CASCADE,
  seat_key TEXT NOT NULL DEFAULT 'owner',
  workflow_step_id TEXT NOT NULL,
  suggested_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_manual_tasks_pending_step
  ON linkedin_manual_tasks(member_id, workflow_step_id)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_linkedin_manual_tasks_queue
  ON linkedin_manual_tasks(workspace_id, seat_key, status, created_at DESC);

-- Attribution needed by workflow analytics and deterministic step reconciliation.
-- No existing caller is required to set these columns.
ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS campaign_member_id TEXT,
  ADD COLUMN IF NOT EXISTS workflow_step_id TEXT,
  ADD COLUMN IF NOT EXISTS variant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_member_step
  ON linkedin_actions(workspace_id, campaign_member_id, workflow_step_id)
  WHERE campaign_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_variant
  ON linkedin_actions(workspace_id, campaign_id, workflow_step_id, variant_id)
  WHERE variant_id IS NOT NULL;
