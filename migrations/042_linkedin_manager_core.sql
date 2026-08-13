-- Core state for the LinkedIn outreach manager.

ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_pkey;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_pkey PRIMARY KEY (workspace_id, seat_key);
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS working_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[];
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS working_start TIME NOT NULL DEFAULT TIME '08:00';
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS working_end TIME NOT NULL DEFAULT TIME '18:00';
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS operator_limits JSONB NOT NULL DEFAULT '{"invite":30,"message":25,"profile_view":25,"follow":20}'::jsonb;

ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS workflow_id TEXT;
ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS lead_list_id TEXT;
ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE linkedin_campaigns ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_seat ON linkedin_campaigns(workspace_id, seat_key, created_at DESC);

CREATE TABLE IF NOT EXISTS linkedin_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  country TEXT,
  linkedin_url TEXT,
  identity_key TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_contacts_identity
  ON linkedin_contacts(workspace_id, identity_key) WHERE identity_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS linkedin_lead_lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_lists_name ON linkedin_lead_lists(workspace_id, LOWER(name));

CREATE TABLE IF NOT EXISTS linkedin_lead_list_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES linkedin_contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_list_members_contact ON linkedin_lead_list_members(workspace_id, contact_id);

CREATE TABLE IF NOT EXISTS linkedin_imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES linkedin_lead_lists(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mapping_json JSONB NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
