-- The body of a discovered thread, not just its hash.
--
-- 013_outreach.sql stored content_hash alone because the table existed to
-- detect edits and to be the self-promotion ratio's denominator -- both of
-- which a hash answers. /research asks a question a hash cannot: how relevant
-- is this thread, and what would a reply to it say. Both read the body.
--
-- Rows discovered before this migration carry '' until the next scout re-reads
-- them, which is the same path an edited thread already takes.
ALTER TABLE outreach_threads ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
