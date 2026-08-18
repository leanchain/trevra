-- Lead sourcing and reusable lead lists belong to the LinkedIn account that
-- performs/uses them. Existing pre-multi-account rows remain on the owner seat.

ALTER TABLE linkedin_lead_sources
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE linkedin_leads
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE linkedin_lead_lists
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE linkedin_lead_settings
  ADD COLUMN IF NOT EXISTS seat_key TEXT NOT NULL DEFAULT 'owner';

-- A live search URL is unique per LinkedIn account, not per workspace.
DROP INDEX IF EXISTS idx_linkedin_lead_sources_live;
CREATE UNIQUE INDEX idx_linkedin_lead_sources_live
  ON linkedin_lead_sources(workspace_id, seat_key, kind, LOWER(url))
  WHERE status IN ('pending', 'running');

DROP INDEX IF EXISTS idx_linkedin_lead_sources_claimable;
CREATE INDEX idx_linkedin_lead_sources_claimable
  ON linkedin_lead_sources(workspace_id, seat_key, requested_at)
  WHERE status = 'pending';

DROP INDEX IF EXISTS idx_linkedin_lead_sources_recent;
CREATE INDEX idx_linkedin_lead_sources_recent
  ON linkedin_lead_sources(workspace_id, seat_key, created_at DESC);

-- The same person may be sourced independently by two LinkedIn accounts.
DROP INDEX IF EXISTS idx_linkedin_leads_profile;
CREATE UNIQUE INDEX idx_linkedin_leads_profile
  ON linkedin_leads(workspace_id, seat_key, LOWER(profile_url));

DROP INDEX IF EXISTS idx_linkedin_leads_recent;
CREATE INDEX idx_linkedin_leads_recent
  ON linkedin_leads(workspace_id, seat_key, created_at DESC);

DROP INDEX IF EXISTS idx_linkedin_leads_source;
CREATE INDEX idx_linkedin_leads_source
  ON linkedin_leads(workspace_id, seat_key, source_id, created_at DESC);

-- Daily sourcing allowance is per account.
ALTER TABLE linkedin_lead_settings DROP CONSTRAINT IF EXISTS linkedin_lead_settings_pkey;
ALTER TABLE linkedin_lead_settings
  ADD CONSTRAINT linkedin_lead_settings_pkey PRIMARY KEY (workspace_id, seat_key);

-- Reusable lead-list names and visibility are per account. Contact rows remain
-- workspace-deduped; membership in an account-owned list determines where they
-- are offered for campaign enrollment.
DROP INDEX IF EXISTS idx_linkedin_lead_lists_name;
CREATE UNIQUE INDEX idx_linkedin_lead_lists_name
  ON linkedin_lead_lists(workspace_id, seat_key, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_linkedin_lead_lists_seat_recent
  ON linkedin_lead_lists(workspace_id, seat_key, updated_at DESC);
