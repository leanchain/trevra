-- Pending-invite withdrawal (plan 4A, 6A: "Withdraw pending invites").
--
-- WHY THIS EXISTS, AND WHY IT IS A SAFETY FEATURE RATHER THAN A TIDY-UP.
--
-- A pending invite is not free. It consumes the operator's weekly invite cap
-- on LinkedIn's side for as long as it sits there, and it is a permanent zero
-- in the acceptance numerator: plan 1.3's ban signal is a "sustained
-- acceptance rate <30% over a week" (MIN_ACCEPTANCE_RATE in limits.ts). An
-- operator with 400 stale invites is therefore capped AND flagged, and every
-- other lever this engine has -- the warm-up ramp, the variance clamp, the
-- acceptance throttle -- makes that worse rather than better, because all of
-- them reduce SENDING and none of them touch the backlog.
--
-- WITHDRAWING IS ITSELF AN ACTION, AND THE SCHEMA IS SHAPED BY THAT. Four
-- hundred withdrawals in ten minutes is exactly the "+120% surge within
-- 24-48h" half of the Slide-and-Spike signature in 1.3 -- the engine would
-- manufacture the shape it exists to prevent while believing it was cleaning
-- up. So a withdrawal is queued, claimed, paced and gated like any other
-- action, and this table is the queue that makes that possible.
--
-- Nothing here stores a credential, exactly as in 024 and 027.

-- ---------------------------------------------------------------------------
-- 1. The 'withdrawn' outcome on the existing ledger.
-- ---------------------------------------------------------------------------
--
-- READ BEFORE ASSUMED: `linkedin_actions.status` carries NO CHECK constraint.
-- 022 enumerated its seven values in a comment and left the column plain TEXT,
-- and 023 recorded the same decision for `contact_identities` in so many
-- words. This migration follows that, and deliberately does NOT introduce a
-- CHECK: adding one now would be a new constraint on a live ledger whose
-- history nobody has re-read, and the enumeration this family actually
-- enforces lives in `LinkedInActionStatus` (actions.ts) plus the comment
-- below. So the value is DOCUMENTED here, in the same place the other seven
-- are documented, and nothing needed altering to permit it.
--
-- The eighth value, and how it interacts with the three predicates that
-- already read this column -- all three answers are deliberate:
--
--   'withdrawn' -- the invite went out, went unanswered, and we took it back.
--
--   * `COUNTED` in actions.ts is `status NOT IN ('planned','skipped')`, so a
--     withdrawn invite STILL consumes its rolling 24h/7d/30d budget. That is
--     correct and it is the point: LinkedIn saw the invite. Withdrawing it
--     does not un-send it, and a status that quietly returned the budget
--     would let an operator launder volume through withdraw-and-resend.
--   * The acceptance denominator is `status IN ('accepted','replied',
--     'declined')`, so a withdrawn invite is NOT decided and does NOT count
--     as a refusal. Marking these 'declined' instead -- the tempting reuse --
--     would drive the measured acceptance rate toward zero and trip the
--     ACCEPTANCE_THROTTLE_FACTOR halving, i.e. the remedy would fire the
--     alarm it was clearing. Nobody refused; nobody answered.
--   * The replay guard `idx_linkedin_actions_target` excludes only 'skipped',
--     so a withdrawn target STAYS CLAIMED and cannot be re-invited by a later
--     campaign. 'skipped' means "nothing went out, release the target", and
--     something did go out here. Re-inviting somebody who ignored the first
--     ask for three weeks is also the exact behaviour that produces the low
--     acceptance rate this feature exists to repair.
--
-- Known consequence, recorded rather than hidden: `campaignFunnel` in
-- campaigns.ts counts the seven 022 statuses by name, so a withdrawn invite
-- drops out of its per-status totals until that query learns the eighth.

-- When LinkedIn's own sent-invitations manager last still showed this invite
-- as awaiting an answer.
--
-- EVIDENCE, NOT A GATE. Candidate selection may read it, but nothing acts on
-- it: a list is stale the moment it is read, and an invite accepted between
-- the sync and the click looks identical to one still pending. The driver
-- re-reads the live list at the instant of withdrawing and refuses if the
-- entry is gone, which is the only check that can actually be true.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS pending_seen_at TIMESTAMPTZ;

-- When LinkedIn says the invite was sent, as its own sent-invitations list
-- reports it ("Sent 3 weeks ago").
--
-- Separate from `recorded_at` because they answer different questions.
-- `recorded_at` is when TREVRA logged the action and is what every rolling
-- window counts; this is LinkedIn's account of when the invite reached the
-- recipient. They differ for every invite an operator sent by hand, for every
-- row imported after the fact, and for anything exported to a third-party tool
-- that sent it a day later. Age-based withdrawal must be measured against the
-- recipient's experience, so selection reads COALESCE(pending_since,
-- recorded_at) -- LinkedIn's word when we have it, ours when we do not.
--
-- NULL is normal and is not a defect: LinkedIn's label is relative and coarse
-- ("3w"), so an unparseable one is left null rather than guessed into a
-- timestamp that would then be treated as fact.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ;

-- The candidate sweep: this seat's invites that are still awaiting an answer,
-- oldest first. Partial on the same predicate the sweep selects with, because
-- outstanding invites are a small and shrinking slice of a ledger that keeps
-- every action forever.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_pending_invites
  ON linkedin_actions(workspace_id, seat_key, recorded_at)
  WHERE kind = 'invite' AND status IN ('sent', 'exported');

-- ---------------------------------------------------------------------------
-- 2. The withdrawal queue.
-- ---------------------------------------------------------------------------
--
-- SAME CLAIM-BEFORE-ACT SHAPE AS `linkedin_batches` AND
-- `linkedin_seat_detect_requests`, not a second queueing mechanism: a status
-- column, a `claimed_at` written before the browser is touched, a `batch_id`
-- to read a pass back to what it did, and a partial unique index as the replay
-- guard. The one thing worth restating is WHY a withdrawal needs a claim at
-- all, since it is destructive-in-reverse: two workers withdrawing the same
-- invite is harmless, but two workers each believing they withdrew it is not.
-- The second one would find the entry gone, and "gone" is indistinguishable
-- from "they accepted while we were looking" -- so an unclaimed queue turns a
-- race into a wrong ledger row.
CREATE TABLE IF NOT EXISTS linkedin_withdrawals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Always 'owner' today; the seat model note in 022 applies here too.
  seat_key TEXT NOT NULL DEFAULT 'owner',
  -- The `linkedin_actions` row being withdrawn.
  --
  -- No foreign key, for the same reason `linkedin_actions.batch_id` and
  -- `linkedin_campaigns.playbook_run_id` have none: this row is a record of
  -- something that was done to a real account, and it must stay readable if
  -- the ledger row it points at is ever pruned. `target_ref` is duplicated
  -- below so it stays legible on its own.
  action_id TEXT NOT NULL,
  -- The opaque handle-or-URL, copied from the ledger row at enqueue time. Also
  -- what the driver is handed, and what it re-reads the live list for.
  target_ref TEXT NOT NULL,
  -- 'queued'    -- outstanding. Claimed and released rows sit here too; the
  --                claim is `claimed_at`, not a status.
  -- 'withdrawn' -- LinkedIn confirmed it, and the ledger row was marked.
  -- 'stale'     -- the invite was not awaiting an answer any more when we
  --                looked, so NOTHING WAS CLICKED. Accepted, declined,
  --                expired and already-withdrawn all land here and are NOT
  --                told apart, because the sent-invitations list cannot tell
  --                them apart. The ledger row is left exactly as it was: an
  --                outcome nobody observed must not be written down.
  -- 'failed'    -- a definite failure. Nothing was withdrawn, and the replay
  --                guard below releases it so a later sweep may retry.
  -- 'held'      -- we clicked and lost the outcome. KEEPS its claim forever,
  --                exactly as an `unknown` invite does in 024, and a human
  --                settles it. The difference from 'failed' is the whole
  --                reason both exist.
  status TEXT NOT NULL DEFAULT 'queued',
  -- Written BEFORE the browser touches LinkedIn. Cleared by a definite outcome
  -- and by a refusal from the safety gate; deliberately NOT cleared by 'held'.
  claimed_at TIMESTAMPTZ,
  -- Which pass claimed it, so a halted pass reads back to what it really did.
  batch_id TEXT,
  -- Which of driver.ts's six kinds the last attempt reported. Recorded even
  -- for rows that will be retried, because "this seat hit a limit wall while
  -- withdrawing" is the fact that explains a cooldown later.
  failure_kind TEXT,
  -- One sentence, for the operator reading this row weeks later.
  detail TEXT,
  -- Whole days the invite had been awaiting an answer when it was enqueued.
  -- Frozen at enqueue on purpose: it is the reason this row exists, and
  -- recomputing it later would answer a different question.
  pending_days INTEGER,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

-- THE REPLAY GUARD, same shape and same reasoning as
-- `idx_linkedin_actions_target` (022), `idx_linkedin_campaigns_name` (025) and
-- `idx_linkedin_seat_detect_pending` (027): a partial unique index, so the
-- database enforces "one live withdrawal per invite" instead of the sweep
-- remembering to. Running the sweep twice, or running it while a pass is in
-- flight, produces one row.
--
-- 'failed' is the SINGLE exclusion, and it is the exact counterpart of
-- 'skipped' in 022: it is the one status that means nothing happened, so the
-- invite is released for a later attempt. 'stale' and 'held' are inside the
-- predicate on purpose -- re-queueing a stale row would only re-discover that
-- it is stale, and re-queueing a held one is precisely the retry that could
-- withdraw an invite twice or contradict a click nobody saw the result of.
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_withdrawals_live
  ON linkedin_withdrawals(workspace_id, seat_key, action_id)
  WHERE status <> 'failed';

-- The claim query: oldest queued, unclaimed withdrawal for one seat. Partial
-- on the same predicate the claim selects with, because queued-and-unclaimed
-- is a tiny hot slice of a table that keeps its history.
CREATE INDEX IF NOT EXISTS idx_linkedin_withdrawals_claimable
  ON linkedin_withdrawals(workspace_id, seat_key, queued_at)
  WHERE status = 'queued' AND claimed_at IS NULL;

-- "How many withdrawals has this seat actually performed lately" -- the
-- rolling ceiling that paces this queue, and the queue view an operator reads.
CREATE INDEX IF NOT EXISTS idx_linkedin_withdrawals_recent
  ON linkedin_withdrawals(workspace_id, seat_key, finished_at DESC);
