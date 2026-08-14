-- WHEN EACH SIDE TASK LAST TOUCHED LINKEDIN, so the next one can decline.
--
-- THE DEFECT THIS EXISTS TO FIX, in the numbers it was found with.
-- `runLinkedInSideTasks` ran on every worker tick -- AUTOMATION_INTERVAL_MS,
-- 60 seconds by default -- and not one of the five jobs inside it asked how
-- long it had been since the last time. So for ONE seat, with an EMPTY queue,
-- an EMPTY inbox and nothing scheduled, one tick was:
--
--   2 x /in/me/                                 (inbox sync, acceptance detection:
--   2 x /mynetwork/invite-connect/connections/   each confirmed identity itself,
--                                                and `readSeat` loads both pages)
--   1 x /messaging/                             (the rail walk)
--   1 x /mynetwork/invitation-manager/sent/     (the pending-invite list)
--   -------------------------------------------
--   6 navigations x 1,440 ticks = ~8,600 page loads per day, round the clock,
--   including 03:00 -- of which ~2,900 were the connections page, the single
--   surface LinkedIn most associates with prospecting, and ~2,900 more were
--   the profile page.
--
-- Under the code the restricted account actually ran, it was worse: `isLoggedIn`
-- navigated to /in/me/ on EVERY call (fixed in 098c13d), which added one more
-- profile load per job per tick -- about 11 navigations a tick, ~15,800 a day.
--
-- That is the shape of "accessing an unusually large amount of LinkedIn
-- profile data over time", and it was Trevra doing it, unprompted, with
-- nothing queued and nothing sent.
--
-- A ROW PER (SEAT, TASK), NOT AN EVENT STREAM. `linkedin_seat_events` records
-- what happened and is read most-recent-first for a timeline; this is read on
-- every tick to answer one question -- "is this task due" -- and that read has
-- to be a primary-key lookup, not a MAX() over a growing log.
--
-- Idempotent: safe on a re-run and on a fresh database.
CREATE TABLE IF NOT EXISTS linkedin_side_task_runs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seat_key TEXT NOT NULL,
  -- 'inbox' | 'pending_invites' | 'acceptance' | 'withdrawals' | 'lead_sources'.
  -- Free text for the same reason `linkedin_seat_events.kind` is: a new job
  -- must not need a migration, and nothing branches on the value in SQL.
  task TEXT NOT NULL,
  last_run_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, seat_key, task)
);

-- THE CASCADE IS NOT DECORATION, and it is here as a separate guarded step
-- because the table shipped without it for exactly as long as it took one test
-- to notice. A cadence row that outlives its workspace is a row that says "the
-- inbox was read four minutes ago" about a seat that no longer exists -- and
-- when that workspace id is reused, the new seat's first tick silently does
-- nothing. Every other table in this subsystem cascades from `workspaces`;
-- this one now does too, on a fresh database and on one that already ran the
-- statement above without it.
DO $$
BEGIN
  IF to_regclass('public.linkedin_side_task_runs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.linkedin_side_task_runs')
         AND contype = 'f'
     ) THEN
    DELETE FROM linkedin_side_task_runs r
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = r.workspace_id);
    ALTER TABLE linkedin_side_task_runs
      ADD CONSTRAINT linkedin_side_task_runs_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
    RAISE NOTICE '071: added linkedin_side_task_runs workspace cascade';
  END IF;
END $$;
