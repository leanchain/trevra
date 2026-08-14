-- Two things the 2026-08-14 "unusual activity" investigation could not do
-- without, and one of them is the reason the investigation was hard.
--
-- 1. `linkedin_seats.resting_until` -- WHERE A SITTING'S BREAK LIVES.
--
-- `local-worker.ts` works a seat in sittings: 3-8 actions, then the browser
-- closes and the seat is away for 25-90 minutes, because a client that is
-- available to act from the minute its window opens until the minute it closes
-- has no shape to its day and nobody uses LinkedIn like that. That break was an
-- in-process Map, which means a worker restart forgets it and the seat starts
-- its next sitting early -- exactly when a restart is most likely, which is
-- after something went wrong. A column survives the restart, and it is visible
-- to every other worker in a fleet rather than to one process.
--
-- 2. `linkedin_seat_events` -- THE MISSING LEDGER.
--
-- Trevra recorded ACTIONS (an invite, a DM) and nothing else. Not a single
-- navigation, sign-in, checkpoint or limit wall. So when LinkedIn restricted
-- the account, there was no way to answer "what did we actually do, and when"
-- from Trevra's own data: the investigation had to be reconstructed out of
-- Chrome's history database and cookie timestamps. A flag builds over days and
-- this table is what makes that visible while it is happening rather than
-- afterwards.
--
-- DELIBERATELY NOT `audit_events`. That table is the workspace's own
-- append-only record of what PEOPLE did; this is a record of what the BROWSER
-- did, at a volume (every navigation) that would drown it.
--
-- NOTHING HERE STORES PAGE CONTENT OR ANOTHER MEMBER'S DATA: a kind, a URL, and
-- one sentence written from constants. `detail` is built the same way every
-- `LinkedInDriverResult.detail` is, so no credential and no scraped field can
-- reach it.
--
-- Idempotent: every statement is guarded, so a re-run and a fresh database are
-- both no-ops.
DO $$
BEGIN
  IF to_regclass('public.linkedin_seats') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = to_regclass('public.linkedin_seats')
         AND a.attname = 'resting_until' AND a.attnum > 0 AND NOT a.attisdropped
     ) THEN
    ALTER TABLE linkedin_seats ADD COLUMN resting_until TIMESTAMPTZ;
    RAISE NOTICE '061: added linkedin_seats.resting_until';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS linkedin_seat_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  seat_key TEXT NOT NULL,
  -- 'browser_open' | 'navigate' | 'login' | 'challenge' | 'limit_wall' |
  -- 'session_reused' | 'sitting_start' | 'sitting_end'. Free text on purpose:
  -- a CHECK constraint here would mean a migration every time the worker
  -- learns to report something new, and nothing branches on this value.
  kind TEXT NOT NULL,
  url TEXT,
  detail TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The only query this table exists to answer: "what did this seat do, most
-- recent first", and the retention sweep, which is the same index backwards.
CREATE INDEX IF NOT EXISTS linkedin_seat_events_seat_time
  ON linkedin_seat_events (workspace_id, seat_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS linkedin_seat_events_occurred
  ON linkedin_seat_events (occurred_at);
