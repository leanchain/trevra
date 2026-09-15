-- Full-speed LinkedIn accounts can opt into the higher queue envelope without
-- being rejected by the older multi-seat constraints. This migration has not
-- shipped yet, so changing the constraints and the legacy-default upgrade in
-- one place keeps a fresh install and an upgraded install identical.
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_invite_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_invite_limit_check
  CHECK (daily_invite_limit BETWEEN 0 AND 100);
ALTER TABLE linkedin_seats DROP CONSTRAINT IF EXISTS linkedin_seats_profile_view_limit_check;
ALTER TABLE linkedin_seats ADD CONSTRAINT linkedin_seats_profile_view_limit_check
  CHECK (daily_profile_view_limit BETWEEN 0 AND 150);

UPDATE linkedin_seats
SET daily_invite_limit = CASE
      WHEN daily_invite_limit = 30 THEN 100
      ELSE daily_invite_limit
    END,
    daily_profile_view_limit = CASE
      WHEN daily_profile_view_limit = 25 THEN 150
      ELSE daily_profile_view_limit
    END,
    updated_at = NOW()
WHERE safety_band_override = TRUE
  AND warmup_override = TRUE
  AND (daily_invite_limit = 30 OR daily_profile_view_limit = 25);
