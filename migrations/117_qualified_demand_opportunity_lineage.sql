-- Attribute Opportunity-lite rows created from explicit high-intent inbound demand
-- back to the exact recommendation that justified commercial progression.
--
-- A recommendation may be recomputed many times. The partial unique index makes
-- Opportunity creation idempotent across reruns and across concurrent workers.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS origin_recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_origin_recommendation
  ON opportunities(workspace_id,origin_recommendation_id)
  WHERE origin_recommendation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_opportunities_origin_recommendation_lookup
  ON opportunities(origin_recommendation_id)
  WHERE origin_recommendation_id IS NOT NULL;
