-- Migration 050: the operator's daily ceiling, made binding on request.
--
-- TWO NUMBERS DESCRIBE ONE CEILING, AND UNTIL NOW ONLY ONE OF THEM COULD WIN.
--
-- `linkedin_seats.daily_invite_limit` and its three siblings are the operator's
-- setting, and the product brief gives them ranges an operator picks inside:
-- invites default 30 (0-75), messages 25 (0-75), profile views 25 (0-100),
-- follows 20 (0-50). Trevra's own researched bands (`limits.ts`, REPORTED from
-- plan 1.4) are stricter than every one of those defaults -- 18 invites/day and
-- 12 dm/day in the steady band, less during warm-up -- and every ceiling in the
-- subsystem is `min(band, operator)`.
--
-- The result was a form that lied. An operator typed 30, saved it, saw 30 on
-- the screen, and got 18 -- with no refusal, no warning and no sentence
-- anywhere naming the number that actually bound. "Silently obeyed something
-- other than what you configured" is the worst of the three available
-- behaviours; the other two are "refuse the setting" and "obey it, once you
-- have been told what you are overriding".
--
-- This column is the third. False -- the default, and the value every existing
-- seat gets -- keeps `min(band, operator)` exactly as it was. True is the
-- operator saying they have read what Trevra's band is and are taking their own
-- number instead, and it makes the operator's figure the one that binds.
--
-- WHAT IT DOES NOT LIFT, which is why it is safe to offer at all:
--
--   * the per-seat warm-up ramp (weeks 1..3, `warmupMultiplierFor`);
--   * the per-campaign 20/40/60/80/100% day ramp (`campaignActionLimit`);
--   * the rolling 7-day and 30-day windows and the InMail quota;
--   * the day-over-day variance clamp, which is the actual defence (1.3);
--   * the seat's working days and hours, and its posture.
--
-- It lifts the STEADY/WARM-UP BAND CAP and nothing else. An override is a
-- different ceiling, never an absence of one -- and a seat in week 1 with this
-- flag set still sends zero invites, because the ramp is a separate rule.
--
-- NOT NULL DEFAULT false rather than a nullable tri-state: "nobody has decided"
-- and "the operator declined" must both mean the conservative behaviour, and a
-- NULL that some future reader coerces the wrong way is a ban.

ALTER TABLE linkedin_seats
ADD COLUMN IF NOT EXISTS safety_band_override BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN linkedin_seats.safety_band_override IS
'True only when the operator has explicitly opted this seat out of Trevra''s researched per-kind safety bands (limits.ts LINKEDIN_LIMITS) in favour of their own daily_*_limit figures. False (the default, and the value of every seat that predates this column) keeps the effective daily ceiling at min(band, operator setting). Read by effectiveDailyCeiling (limits.ts) and by nothing else; set exclusively from the seat settings form via upsertSeat. It relaxes ONLY the steady/warm-up band cap: the per-seat warm-up week ramp, the per-campaign 20/40/60/80/100% day ramp, the rolling 7d/30d windows, the day-over-day variance clamp, the working window and the seat posture all still apply and can all still refuse.';
