-- Companion execution no longer requires a live, signed-in Trevra browser tab
-- alongside the paired computer -- the paired computer runs independently once
-- paired. Drop the website-presence lease this required.
DROP TABLE IF EXISTS linkedin_companion_presence;
