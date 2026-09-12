-- Preserve when recommendation proof was observed, distinct from when Trevra
-- materialised the recommendation/proof pack. Demand Graph recommendations may
-- combine a first-party event with older account evidence; auditability requires
-- both dates rather than pretending recommendation creation time is source time.
ALTER TABLE recommendation_evidence
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;

ALTER TABLE proof_pack_items
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;
