-- LinkedIn seats and the per-seat action ledger.
--
-- Everything else in this schema is scoped by (workspace, platform), because
-- every other channel rate-limits an APPLICATION. LinkedIn rate-limits a
-- HUMAN: the ceilings in docs/linkedin-outreach-plan.md 1.4 are per account,
-- so "12 invites today" is a fact about Pankaj, not about the workspace. That
-- is the whole reason these two tables exist rather than another `platform`
-- value in outreach_posts.
--
-- SEAT MODEL, DECIDED (plan 7.1): one seat = the workspace owner. So
-- `linkedin_seats` is keyed by workspace_id ALONE and there is no seat_key
-- column on it. `linkedin_actions` keeps `seat_key` anyway, defaulted to
-- 'owner': the agency case (N seats staggered 2-4h apart) is deferred, not
-- refused, and the ledger is the one table that would be expensive to reshape
-- once it holds a year of history. A column that is constant today is cheaper
-- than a backfill later.

CREATE TABLE IF NOT EXISTS linkedin_seats (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- "Pankaj (founder)". Shown next to a plan so an operator knows whose
  -- account is about to be paced.
  label TEXT NOT NULL,
  -- Entered by the user, never scraped. Trevra does not read LinkedIn.
  profile_url TEXT,
  -- User-declared, and the only input to the warm-up week. Nullable because
  -- LinkedIn publishes no API that could tell us -- see seats.ts, where an
  -- undeclared date is paced as a week-1 account rather than as an
  -- established one.
  account_opened_on DATE,
  -- User-declared, refreshed by hand. Recorded because 1.4 bands on it
  -- ("established, 500+ conns"); nothing reads it as a ceiling yet.
  connections_count INTEGER,
  -- IANA name. Drives the business-hours window, so it is NOT NULL: spreading
  -- 08:00-18:00 in an unknown timezone is spreading it in the wrong one.
  timezone TEXT NOT NULL,
  -- 'warmup'   -- inside the ramp; the warm-up band and multiplier apply
  -- 'steady'   -- past the ramp; the steady band applies
  -- 'paused'   -- operator stopped it; nothing is planned or permitted
  -- 'cooldown' -- backing off after a restriction; the warm-up band applies
  --
  -- Only 'paused' and 'cooldown' are really operator state. warmup-vs-steady
  -- is DERIVED from account_opened_on on every read (seats.ts
  -- `effectivePosture`), because account age is a fact and storing 'steady'
  -- by hand must not buy a young account out of its ramp.
  posture TEXT NOT NULL DEFAULT 'warmup',
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS linkedin_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Always 'owner' today. See the seat-model note above.
  seat_key TEXT NOT NULL DEFAULT 'owner',
  -- invite | dm | inmail | profile_view | comment | follow.
  -- Different limits each, which is exactly why "a post" was not enough.
  -- Only the first four have published pacing bands (limits.ts); comment and
  -- follow are recordable but not paceable, because no number was researched
  -- for them and inventing one is worse than refusing.
  kind TEXT NOT NULL,
  -- Opaque, user-supplied handle or profile URL. Trevra never resolves it.
  target_ref TEXT,
  campaign_id TEXT,
  -- 'planned'  -- a paced slot; has NOT happened, and does not count toward
  --               any rolling window
  -- 'exported' -- handed to the user's own tool; from LinkedIn's point of view
  --               this is about to be real, so it DOES count
  -- 'sent'     -- confirmed sent
  -- 'accepted' -- invite accepted (numerator of the acceptance rate)
  -- 'replied'  -- they answered; implies accepted
  -- 'declined' -- withdrawn, ignored past its window, or refused
  -- 'skipped'  -- never went out, and the replay guard releases the target
  status TEXT NOT NULL,
  -- The paced slot this action was scheduled into.
  planned_for TIMESTAMPTZ,
  -- When it actually happened. NULL while 'planned'. Every rolling-window
  -- count reads THIS column, never created_at: a row written today for a slot
  -- next Tuesday must not consume today's 24h budget.
  recorded_at TIMESTAMPTZ,
  -- 'export' | 'manual' | 'aggregator'. Records who did it, so a ledger that
  -- later gains an aggregator (plan phase 4) stays readable.
  source TEXT NOT NULL,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replay guard, same shape as idx_outreach_posts_payload. Re-running an export
-- must not queue a second invite to the same person: one target gets one
-- action of one kind per seat, ever. 'skipped' is the single exclusion --
-- nothing went out, so the target is released for a later campaign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_actions_target
  ON linkedin_actions(workspace_id, seat_key, kind, target_ref)
  WHERE status <> 'skipped';

-- Rolling-window counts: 24h, 7d and 30d for one seat and one kind.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_window
  ON linkedin_actions(workspace_id, seat_key, kind, recorded_at DESC);

-- "What is queued", for the export and the schedule view.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_planned
  ON linkedin_actions(workspace_id, seat_key, planned_for)
  WHERE status = 'planned';
