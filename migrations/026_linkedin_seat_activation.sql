-- The warm-up ramp is keyed to TOOL USE, not to the account's birthday.
--
-- 022 keyed `effectivePosture` and the warm-up week off `account_opened_on`: a
-- date the operator typed into a form, about a fact LinkedIn publishes no API
-- for (plan 1.1) and Trevra could therefore never verify. Two things were
-- wrong with that, and only the second one is about safety:
--
--   1. IT MADE A FORM THE PRICE OF ENTRY. Waalaxy, Dripify and HeyReach ask
--      the operator for exactly one thing -- log in -- and read everything
--      else from the session. A field nobody can check is a field nobody
--      should be asked for.
--   2. IT WAS THE WRONG SIGNAL. The documented risk model (plan 1.3, "Slide
--      and Spike") is about a surge in AUTOMATED activity: 5-10 days of
--      decline followed by a +120% spike, day-over-day change above 50%. That
--      is a fact about how this seat uses Trevra, and `linkedin_actions` --
--      our own ledger -- owns it. An account opened in 2011 whose automation
--      started this morning is a week-1 RISK whatever its birthday says, and
--      pacing it as established is exactly the mistake that gets it
--      restricted.
--
-- So the ramp clock becomes `activated_at`: the first moment this workspace
-- had a LinkedIn seat at all. `upsertSeat` writes it once and COALESCEs it on
-- conflict, so no later edit can reset it -- a ramp an operator can restart by
-- re-saving a form is not a ramp.
--
-- `account_opened_on` and `connections_count` are kept and stay settable. They
-- become purely informational: after this migration nothing derives a ceiling,
-- a band or a posture from a user-declared value.
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

-- When the local worker last read this seat out of the live browser session
-- (`readSeat` in linkedin/driver.ts). Informational: it answers "how old is the
-- profile URL and connection count on this screen", and nothing safety-critical
-- reads it.
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;

-- BACKFILL, AND IT IS NOT OPTIONAL.
--
-- Without it every existing seat would read as `activated_at IS NULL`, which
-- fails closed to week 1. Failing closed is right as a DEFAULT and wrong as a
-- MIGRATION: a seat that has been pacing at the steady band for a month would
-- be thrown back to "no invites at all" by an upgrade that changed no policy,
-- and the operator would experience a safety improvement as an outage.
-- `created_at` is the honest answer to "when did this workspace start using
-- Trevra against LinkedIn", and it is already NOT NULL.
UPDATE linkedin_seats SET activated_at = created_at WHERE activated_at IS NULL;
