-- Seat detection, asked for in one process and performed in another.
--
-- WHY THIS TABLE EXISTS AT ALL. Detection reads the operator's signed-in
-- LinkedIn session out of a HEADED Chrome window (plan 4.1). The API commonly
-- does not run anywhere such a window can exist -- a container has no display,
-- no browser binaries, and a home directory that is not the operator's -- so
-- the request and the act happen on two different machines. This is the queue
-- between them: the API writes a request, the operator's own
-- `npm run linkedin:worker` fulfils it, and the client polls the seat.
--
-- Nothing here stores a credential, exactly as in 024. The only thing that
-- crosses machines is "somebody pressed Connect, in this timezone".

CREATE TABLE IF NOT EXISTS linkedin_seat_detect_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Always 'owner' today; the seat model note in 022 applies here too.
  seat_key TEXT NOT NULL DEFAULT 'owner',
  -- The one fact the server cannot derive: which 08:00-18:00 a plan has to
  -- spread across. Read from the browser's own Intl settings and validated at
  -- the API before the row is written, so a bad name never becomes a failure
  -- on somebody else's machine minutes later.
  timezone TEXT NOT NULL,
  -- 'pending'   -- nobody has fulfilled it yet
  -- 'completed' -- a worker read the session and upserted the seat
  -- 'failed'    -- a worker tried and could not; `failure_reason` is the one
  --                sentence the operator has to act on
  status TEXT NOT NULL DEFAULT 'pending',
  -- The claim, mirroring `linkedin_actions.claimed_at` in 024. Written before
  -- the browser is opened so two workers on the same Postgres do not both
  -- drive a detect.
  --
  -- UNLIKE AN INVITE, THIS CLAIM IS RECLAIMABLE. A detect is a pure read: it
  -- sends nothing, and re-running it after a worker died mid-flight duplicates
  -- nothing in anybody's notifications. That is why the claim carries a
  -- timestamp rather than being permanent -- a worker killed between claiming
  -- and finishing must not wedge the workspace's setup forever.
  claimed_at TIMESTAMPTZ,
  failure_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

-- THE REPLAY GUARD, same shape as `idx_outreach_posts_payload` (013) and
-- `idx_linkedin_actions_target` (022): a partial unique index, so the database
-- enforces "one outstanding detect per seat" rather than the API remembering
-- to. An operator pressing Connect five times while the host worker starts up
-- gets one request, not five, and the insert that loses is a no-op instead of
-- an error. Terminal rows are outside the predicate, so the history stays.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_seat_detect_pending
  ON linkedin_seat_detect_requests(workspace_id, seat_key)
  WHERE status = 'pending';

-- The worker's claim query, and the seat route's "is one outstanding" read.
CREATE INDEX IF NOT EXISTS idx_linkedin_seat_detect_queue
  ON linkedin_seat_detect_requests(requested_at)
  WHERE status = 'pending';

-- "What happened to the last one", for the client polling GET /api/linkedin/seat.
CREATE INDEX IF NOT EXISTS idx_linkedin_seat_detect_latest
  ON linkedin_seat_detect_requests(workspace_id, requested_at DESC);
