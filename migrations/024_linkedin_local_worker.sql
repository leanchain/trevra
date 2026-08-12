-- The local Playwright worker's state (plan 4.5).
--
-- Two things this schema did not have and the worker cannot run without:
--
--   1. A CLAIM. `linkedin_actions` was written for a plan-and-export flow,
--      where nothing ever executes a row. A worker that executes rows needs to
--      be able to say "this one is mine, I am doing it now", or two ticks --
--      or two replicas -- send the same invite twice, and an invite cannot be
--      un-sent from the recipient's notifications. Same reasoning as the
--      `pending` claim on `outreach_posts` in 013.
--   2. A HANDLE TO STOP. The kill switch in plan 4.6 has to reach a loop
--      running in a different process from the one that receives the request,
--      so it goes through Postgres, exactly like `agent_runs.stop_requested_at`
--      in 021.
--
-- Nothing here stores a credential. The operator's LinkedIn session lives in a
-- Chrome profile on their own disk and never enters this database (plan 4.1).

CREATE TABLE IF NOT EXISTS linkedin_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Always 'owner' today; the ledger's seat model note in 022 applies here too.
  seat_key TEXT NOT NULL DEFAULT 'owner',
  -- 'running'   -- a worker is driving a browser for this batch right now
  -- 'completed' -- the pass ran out of due actions and ended normally
  -- 'halted'    -- it stopped early: a stop request, a paused seat, a limit
  --                wall, a challenge, selector drift, or an unknown outcome.
  --                `halt_reason` says which, in words an operator can act on.
  status TEXT NOT NULL DEFAULT 'running',
  executed_count INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  -- The REQUEST to stop, written from outside the loop by any process. The
  -- OUTCOME is `status`, written only by whatever is actually driving the
  -- browser, once it has really stopped. A row is not a process: marking a
  -- batch terminal from the outside would not close the tab or stop the next
  -- invite, it would only stop the ledger from being able to describe them.
  --
  -- NULLABLE and never back-filled. NULL means nobody asked.
  stop_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

-- The loop re-reads its own row between every action, and the stop sweep looks
-- up running batches by workspace. Partial, because 'running' is the small hot
-- minority of this table forever -- every other row is terminal.
CREATE INDEX IF NOT EXISTS idx_linkedin_batches_running
  ON linkedin_batches(workspace_id, started_at)
  WHERE status = 'running';

-- Which of the six kinds in driver.ts the last attempt reported:
-- not_found | already_connected | limit_wall | challenge | selector_drift |
-- unknown. Recorded even when the action is retried later, because "this seat
-- hit a limit wall on Tuesday" is the fact that explains a cooldown three
-- weeks on, and nothing else in the schema would remember it.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS failure_kind TEXT;

-- The claim, and the whole of the worker's idempotency.
--
-- Written BEFORE the browser touches LinkedIn and cleared only by a DEFINITE
-- failure -- one where we know nothing was sent. An outcome we never learned
-- keeps its claim forever on purpose: the row stays 'planned' but is never
-- handed out again, so a human settles it instead of a retry duplicating an
-- invite that may already be in someone's notifications. Exactly the hold
-- `outreach_posts` keeps for a write whose response was lost.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Which batch claimed it, so a halted batch can be read back to the actions it
-- actually took. No foreign key: the ledger is append-only history and must
-- outlive any pruning of batch rows.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS batch_id TEXT;

-- The profile URL the action landed on, as the driver saw it. The counterpart
-- of `outreach_posts.external_ref`: without it a 'sent' row cannot be checked
-- against anything.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- The approved bytes for this action: an invite note, or a DM body.
--
-- NULL is a real and common value -- a profile view has nothing to say, and an
-- invite may legitimately carry no note. It is NOT permission to improvise:
-- the worker refuses to claim a DM whose body is NULL, because "executes
-- approved bytes only" (plan 4.6) means an empty payload is nothing to send,
-- not a licence to compose one.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS body TEXT;

-- The claim query: oldest due, unclaimed, executable action for one seat.
-- Partial on the same predicate the worker selects with, because due-and-
-- unclaimed is a tiny slice of a ledger that keeps every action forever.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_claimable
  ON linkedin_actions(workspace_id, seat_key, planned_for)
  WHERE status = 'planned' AND claimed_at IS NULL;
