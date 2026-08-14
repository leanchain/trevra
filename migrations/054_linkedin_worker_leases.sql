-- Worker leases, seat affinity, and the two indexes a MANY-WORKER LinkedIn
-- fleet cannot run without.
--
-- WHAT CHANGED UNDER THIS SUBSYSTEM. Every claim in 024 was written for the
-- shape the file it serves still describes: ONE worker process, on ONE machine,
-- driving the operator's own Chrome. Under that assumption `claimed_at IS NOT
-- NULL` needs no deadline (there is only one process, and if it died the human
-- who owns the laptop knows), the discovery query needs no `workspace_id`
-- predicate (there is one tenant), and "which host holds this seat's Chrome
-- profile" is not a question (there is one host). None of those three hold on a
-- hosted, multi-tenant deployment with several worker hosts, and each of them
-- fails in a way that is silent:
--
--   1. A worker killed between claiming a row and settling it left
--      `claimed_at` set forever. Nothing compared it to a deadline, so the row
--      was never handed out again and never will be -- a permanent hole in one
--      tenant's queue with no error anywhere.
--   2. That stranded row was INDISTINGUISHABLE from the deliberate hold the
--      loop takes on an `unknown` outcome, which keeps its claim on purpose so
--      a human settles it and no retry can duplicate an invite. A reaper that
--      could not tell them apart would either strand crashes or steal holds.
--   3. Discovery filtered `status='planned' AND claimed_at IS NULL AND
--      planned_for <= now` with no `workspace_id`, and every index on
--      `linkedin_actions` leads with `workspace_id`. So it full-scanned, and
--      against the pool's 30s `statement_timeout` it eventually did not finish
--      at all -- taking the whole deployment's LinkedIn queue down quietly.
--
-- Three answers, and they are the whole of this file:
--
--   * `claimed_by` + `lease_expires_at` on `linkedin_actions`: a claim now
--     names the worker that holds it and the instant it stops being valid.
--     A reaper releases what has expired; a live worker heartbeats it forward
--     while the action is in flight. Same model as
--     `linkedin_seat_detect_requests.claimed_at` (027) and
--     `agent_runs`'s stale-run reap (021), and for the same reason.
--   * `settlement_hold_at`: the deliberate human-settlement hold becomes a
--     FACT ON THE ROW instead of an inference from "claimed and never
--     settled", so no reaper can reach it. See the note below for why this is
--     a column and not a status.
--   * `linkedin_seat_leases`: one row per (workspace, seat) recording which
--     worker is driving that account right now, and -- the part that matters
--     across hosts -- which HOST holds its Chrome profile. That profile IS the
--     LinkedIn session (cookies, device trust). A second host picking the seat
--     up finds an empty profile directory and performs a full new-device
--     sign-in, which is the loudest challenge signal LinkedIn has. The lease
--     pins the seat to the host that has the profile.
--
-- ------------------------------------------------------------------------
-- WHAT THIS MIGRATION LOCKS, AND FOR HOW LONG
-- ------------------------------------------------------------------------
--
-- ADD COLUMN (twice, on `linkedin_actions`): ACCESS EXCLUSIVE, held only for
-- the catalog write -- single-digit milliseconds at any table size. Neither
-- column has a DEFAULT and neither is NOT NULL, so there is NO table rewrite
-- and no row is touched. Existing rows read NULL, which is exactly what they
-- mean: "claimed before leases existed" (see the reaper's treatment of them
-- below).
--
-- CREATE TABLE: takes nothing that exists yet.
--
-- THE INDEXES ARE SIZE-GUARDED, AND HERE IS WHY THEY ARE NOT CONCURRENT.
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and
-- `db.ts` `migrate()` runs EVERY migration inside one transaction, under an
-- advisory lock, on purpose (a half-applied schema is worse than a slow one).
-- A plain `CREATE INDEX` takes SHARE on the table, which blocks every INSERT
-- and UPDATE for the whole build -- on 5M rows that is minutes of a frozen
-- LinkedIn ledger, which this migration will not do.
--
-- So each index below is built inline ONLY while the table is still small
-- enough for the build to be sub-second (64MB, measured with
-- `pg_table_size` rather than `reltuples`, which is -1 on a table that has
-- never been analysed and would make a fresh install skip its own index).
-- Past that size the build is SKIPPED and a WARNING carries the exact
-- `CREATE INDEX CONCURRENTLY` to run by hand, outside any transaction. Both
-- statements are `IF NOT EXISTS`, so running them by hand is idempotent and
-- re-running this migration after them is a no-op.
--
-- The worker does not depend on the index existing: its discovery read is
-- bounded by a LIMIT and sharded, and a discovery failure is now loud rather
-- than an empty list. The index is what makes it fast, not what makes it
-- correct.
--
-- ONLY WORKER-CLAIM INDEXES LIVE HERE. General serving indexes for
-- `linkedin_actions` belong to migration 055.

-- ---------------------------------------------------------------------------
-- The lease on a claim
-- ---------------------------------------------------------------------------

-- WHICH worker holds this claim. Free text on purpose: a worker identity is
-- `TREVRA_WORKER_ID` when the deployment sets one and `<hostname>:<pid>`
-- otherwise, and neither is a key into anything. It exists to answer "whose
-- run left this row here" in a fleet where the answer used to be unknowable,
-- and to let a worker recognise its OWN claim after a restart.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS claimed_by TEXT;

-- WHEN this claim stops being valid. Written with `claimed_at`, pushed forward
-- by the running worker before every action it performs, and cleared on every
-- settle. NULL has two meanings and both are safe:
--
--   * on an unclaimed row  -- nothing to expire;
--   * on a row claimed BEFORE this migration -- a claim with no deadline. The
--     reaper releases one of those only when `failure_kind IS NULL`, because
--     the deliberate hold ALWAYS records a failure kind ('unknown'). A legacy
--     hold is therefore left alone for a human, and a legacy crash-strand is
--     recovered. Neither case is guessed at.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- THE DELIBERATE HOLD, AS A COLUMN AND NOT AS A STATUS.
--
-- When the driver clicks and loses the thread, the loop KEEPS the claim on
-- purpose: a retry could put a second invite in somebody's notifications and
-- that cannot be withdrawn. Until now that hold looked, in the database,
-- exactly like a row whose worker was killed -- `status='planned'`,
-- `claimed_at` set, nothing else -- so any reaper able to recover the second
-- would have stolen the first.
--
-- `settlement_hold_at` is the fact that tells them apart. Set once, by the
-- loop, at the moment it decides a human has to settle this row; never set by
-- anything else. The reaper's predicate is `settlement_hold_at IS NULL`, so it
-- cannot reach a hold however long the hold lasts -- which is the point, since
-- a hold is supposed to last until a person acts on it.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS settlement_hold_at TIMESTAMPTZ;

-- WHY NOT A STATUS, WHICH WOULD BE THE MORE OBVIOUS SHAPE.
--
-- Because the obvious name is TAKEN AND MEANS SOMETHING ELSE. Migration 051
-- introduced `status='held'` for a row parked by a PAUSED CAMPAIGN, and
-- `resumeManagedCampaign` flips every 'held' row of that campaign straight
-- back to 'planned'. Putting the unknown-outcome hold on the same status would
-- mean that resuming a campaign re-queues an invite that may already have
-- landed -- the exact duplicate this hold exists to prevent, reintroduced
-- through a button nobody would connect to it.
--
-- A third status ('unsettled') would work, but `LinkedInActionStatus` is a
-- closed union in `actions.ts` with exhaustive label maps in the client, and a
-- status the UI cannot render is a row a human is asked to settle and cannot
-- see. The column is the honest shape: the row stays 'planned' and uncounted
-- (`recorded_at` is still NULL, so no rolling window moves), it stays
-- unclaimable (`claimed_at` is still set, which is what the claim and the
-- discovery query both test), the replay guard still holds the target
-- (`status <> 'skipped'`), and the reason it is parked is now written down.
--
-- NOT BACK-FILLED. Converting existing permanent claims would be an unbounded
-- UPDATE over a 5M-row table inside this transaction, which is precisely the
-- lock this migration refuses to take. They are recognised in place by the
-- `failure_kind IS NULL` rule above and never touched by the reaper.

-- ---------------------------------------------------------------------------
-- Seat leases: who is driving this account, and which host has its session
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS linkedin_seat_leases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Not a foreign key to `linkedin_seats`, for the same reason
  -- `linkedin_seat_credentials` (049) is not: a lease can be taken for a seat
  -- whose row is missing, and that case has to reach the operator as a
  -- sentence about a missing seat rather than as a constraint violation on a
  -- machine they are not looking at.
  seat_key TEXT NOT NULL,
  -- The worker process holding it. `TREVRA_WORKER_ID`, or `<hostname>:<pid>`.
  worker_id TEXT NOT NULL,
  -- THE HOST, SEPARATELY FROM THE PROCESS, AND THIS IS THE AFFINITY.
  --
  -- A restarted worker on the same machine is a NEW worker_id but the SAME
  -- host, and it still has the seat's Chrome profile on its disk -- it may
  -- take the seat back the moment the old lease lapses. A worker on a
  -- DIFFERENT host does not have that profile, and letting it take the seat
  -- means a full new-device sign-in against an account LinkedIn already trusts
  -- a different device for. So the host is what the pin is written against.
  host TEXT NOT NULL,
  -- Where that host keeps the profile. Recorded so an operator moving a fleet
  -- around can see what would have to be copied, and so a refusal can name the
  -- directory the seat is waiting for instead of saying "somewhere else".
  profile_dir TEXT NOT NULL,
  leased_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The deadline. A worker heartbeats this forward while it is driving the
  -- seat; a worker that dies simply stops, and the lease lapses. Nothing
  -- deletes rows here on the normal path -- see `released_at`.
  lease_expires_at TIMESTAMPTZ NOT NULL,
  -- Set when a pass finishes cleanly. The row STAYS, because the row is also
  -- the affinity record: "this host has this seat's session" outlives "this
  -- process is using it right now", and deleting it on release would throw
  -- away the one fact that stops another host re-authenticating the account.
  released_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, seat_key)
);

-- "Which seats does this host hold", for an operator draining a machine.
CREATE INDEX IF NOT EXISTS idx_linkedin_seat_leases_host
  ON linkedin_seat_leases(host, lease_expires_at);

-- ---------------------------------------------------------------------------
-- The serving indexes, built inline only while that is free
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  -- 64MB: a partial-index build over a table this size is sub-second on any
  -- machine that can run Postgres at all, so the SHARE lock is not a stall
  -- anybody experiences. It is also comfortably past the size of every
  -- self-hosted install this subsystem was written for.
  inline_limit CONSTANT BIGINT := 64 * 1024 * 1024;
  actions_bytes BIGINT := 0;
  batches_bytes BIGINT := 0;
BEGIN
  SELECT pg_table_size('linkedin_actions') INTO actions_bytes;
  SELECT pg_table_size('linkedin_batches') INTO batches_bytes;

  IF actions_bytes <= inline_limit THEN
    -- THE DISCOVERY QUERY'S SERVING INDEX. The worker asks "which seats have a
    -- claimable action due" across EVERY tenant -- it has to, because a worker
    -- host serves a shard of the fleet and not a workspace -- and every other
    -- index on this table leads with `workspace_id`, which such a query cannot
    -- use. Partial, because 'planned AND unclaimed' is the small hot minority
    -- of this table forever: everything else is terminal history.
    --
    -- `workspace_id, seat_key` ride along after `planned_for` so the discovery
    -- read gets its grouping keys out of the index instead of the heap.
    CREATE INDEX IF NOT EXISTS idx_linkedin_actions_due_unclaimed
      ON linkedin_actions(planned_for, workspace_id, seat_key)
      WHERE status = 'planned' AND claimed_at IS NULL;

    -- THE LEASE REAPER'S INDEX. Its predicate is the exact complement of the
    -- one above -- claimed rows only -- so it indexes just the handful of rows
    -- that are in flight at any instant. Ordering by `lease_expires_at` puts
    -- the expired ones first and the NULL (pre-migration) claims last, which
    -- is the order the reaper wants to walk them in.
    CREATE INDEX IF NOT EXISTS idx_linkedin_actions_lease
      ON linkedin_actions(lease_expires_at)
      WHERE status = 'planned' AND claimed_at IS NOT NULL;
  ELSE
    RAISE WARNING 'linkedin_actions is % bytes, so migration 054 did NOT build its two worker indexes inline: a plain CREATE INDEX would hold SHARE (blocking every insert and update) for the whole build. Run these two by hand, outside a transaction, then re-run nothing -- they are IF NOT EXISTS: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_due_unclaimed ON linkedin_actions(planned_for, workspace_id, seat_key) WHERE status = ''planned'' AND claimed_at IS NULL; CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_actions_lease ON linkedin_actions(lease_expires_at) WHERE status = ''planned'' AND claimed_at IS NOT NULL;', actions_bytes;
  END IF;

  IF batches_bytes <= inline_limit THEN
    -- THE ORPHAN-BATCH REAPER'S INDEX. `idx_linkedin_batches_running` (024)
    -- leads with `workspace_id`, which is right for the per-workspace stop
    -- sweep and useless to a fleet-wide reaper asking "which batches have been
    -- running longer than any batch can be". Same partial predicate, no
    -- workspace in front of it.
    CREATE INDEX IF NOT EXISTS idx_linkedin_batches_stale
      ON linkedin_batches(started_at)
      WHERE status = 'running';
  ELSE
    RAISE WARNING 'linkedin_batches is % bytes, so migration 054 did NOT build idx_linkedin_batches_stale inline. Run it by hand, outside a transaction: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_linkedin_batches_stale ON linkedin_batches(started_at) WHERE status = ''running'';', batches_bytes;
  END IF;
END $$;
