-- How this seat gets into LinkedIn, and when we last saw that it was in.
--
-- Until now there was exactly one answer and it was not stored anywhere,
-- because it was not a fact about Trevra: the operator opened a real Chrome
-- window against the persistent profile directory and logged in by hand
-- (docs/linkedin-outreach-plan.md 4.1). Trevra held no credential, and that is
-- still the default and still fully supported -- `auth_mode='manual'` is what
-- a fresh seat gets, and the two host-side CLIs still work exactly as before.
--
-- What this migration adds is the SECOND path, for the case 4.1 could not
-- reach: a containerised deployment, where there is no display, no browser
-- binary the operator can see, and a profile directory on a filesystem they
-- never touch (4.9). A headless Chromium can type a password; it cannot show a
-- human a window. So a self-hoster automating THEIR OWN account may hand
-- Trevra their own LinkedIn email and password, and Trevra signs in for them --
-- which is precisely what Dripify, the product this is matched against, has
-- always done.
--
-- WHERE THE SECRET LIVES IS NOT HERE. There is no password column on this
-- table and there must never be one. Both values go into `workspace_secrets`
-- (migration 015) under kinds 'linkedin.email' and 'linkedin.password',
-- AES-256-GCM sealed with TREVRA_SECRETS_KEY, through the one crypto path this
-- codebase has. This column records only WHICH path a seat uses, so the worker
-- can tell "log in for me" from "I logged in myself" without decrypting
-- anything to find out.
--
-- THE HOSTED GATE IS UNCHANGED AND UNCONDITIONAL. TREVRA_DEPLOYMENT_MODE=hosted
-- refuses credential storage outright, in `secrets/linkedin.ts` and again at
-- the route: one operator holding their own password is a different and much
-- smaller risk than a multi-tenant service holding many humans'.

ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'manual';

-- 'manual'      -- the zero-custody path: a human logged this profile in.
-- 'credentials' -- Trevra holds this operator's own email and password and
--                  signs in headlessly when the stored session has expired.
--
-- Constrained rather than commented: `auth_mode` decides whether a password is
-- read out of the vault at all, and a typo'd third value must fail at the write
-- rather than silently take neither branch.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linkedin_seats_auth_mode_check') THEN
    ALTER TABLE linkedin_seats
      ADD CONSTRAINT linkedin_seats_auth_mode_check CHECK (auth_mode IN ('manual','credentials'));
  END IF;
END $$;

-- The last time we CONFIRMED the stored browser session was live -- by landing
-- on the signed-in profile, not by signing in.
--
-- It exists so the session gets REUSED. Re-authenticating on every run is both
-- slower and a far stronger ban signal than a stable session (1.3, "Slide and
-- Spike" is about a surge in automated activity, and a login burst is exactly
-- that shape). Logging in is the fallback; a session that still works is the
-- normal case, and this column is how the UI can say so.
--
-- Nullable, and null means UNKNOWN rather than "expired": a seat nobody has
-- checked is not a seat we know is signed out.
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS session_valid_at TIMESTAMPTZ;
