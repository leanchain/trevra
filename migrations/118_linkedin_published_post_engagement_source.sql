-- Provenance for the narrow LinkedIn engagement-observation bridge.
-- Generic browser lead sourcing remains disabled at the HTTP boundary; this
-- origin marks only a post Trevra itself published and lets the background
-- worker distinguish that bounded observation from arbitrary searches.

ALTER TABLE linkedin_lead_sources
  ADD COLUMN IF NOT EXISTS origin_type TEXT,
  ADD COLUMN IF NOT EXISTS origin_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='linkedin_lead_sources_origin_pair_check'
      AND conrelid='linkedin_lead_sources'::regclass
  ) THEN
    ALTER TABLE linkedin_lead_sources
      ADD CONSTRAINT linkedin_lead_sources_origin_pair_check
      CHECK ((origin_type IS NULL) = (origin_id IS NULL)) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_lead_sources_origin
  ON linkedin_lead_sources(workspace_id, seat_key, origin_type, origin_id)
  WHERE origin_type IS NOT NULL AND origin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_linkedin_lead_sources_published_post_pending
  ON linkedin_lead_sources(workspace_id, seat_key, requested_at)
  WHERE status='pending' AND origin_type='trevra_published_post';
