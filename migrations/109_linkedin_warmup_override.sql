-- An established LinkedIn account may explicitly opt out of Trevra's account-level
-- automation warm-up. The clock in activated_at remains recorded and visible;
-- this flag only changes whether that clock constrains automated activity.
ALTER TABLE linkedin_seats
ADD COLUMN IF NOT EXISTS warmup_override BOOLEAN NOT NULL DEFAULT false;
