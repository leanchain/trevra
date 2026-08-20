-- Campaign-scoped email enrichment economics and provenance.
ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS enrichment_credit_cap INTEGER;

ALTER TABLE linkedin_campaign_channel_actions
  ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 0;

ALTER TABLE linkedin_lead_contacts
  ADD COLUMN IF NOT EXISTS email_provenance TEXT;

CREATE INDEX IF NOT EXISTS idx_linkedin_channel_enrichment_credits
  ON linkedin_campaign_channel_actions(workspace_id,campaign_id,kind,credits_used)
  WHERE kind='find_email' AND credits_used>0;
