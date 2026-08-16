-- Invite acceptance, observed rather than assumed -- plus the two ledger rows
-- that were being performed and never filed.
--
-- THE HOLE THIS CLOSES. `linkedin_actions.status='accepted'` had exactly one
-- writer: a human clicking "mark accepted" in the queue screen, which reaches
-- `writeActionStatus` through the outcome-ingest route. `writeActionStatus`
-- refused that status from every other caller by design (campaigns.ts:
-- "Trevra plans and approves; it never sends"), and the pending-invite sync in
-- `withdraw.ts` deliberately concluded NOTHING from an invite's disappearance
-- because accepted, declined, expired and withdrawn are indistinguishable from
-- the sent-invitations list.
--
-- Both of those decisions were right and their combination was a product that
-- could not answer its own headline question. An unattended campaign reported
-- "0 accepted, acceptance 0%" forever, and the workflow branch that is supposed
-- to fire AFTER an acceptance had nothing truthful to branch on.
--
-- WHAT IS ADDED IS EVIDENCE, NOT INFERENCE. An invite leaving the pending list
-- is a QUESTION, and the answer is read off the target's own profile: LinkedIn
-- renders the viewer's connection degree on every profile top card, and 1st
-- degree is acceptance stated by LinkedIn rather than deduced by us. A profile
-- whose degree could not be read stays UNKNOWN and keeps its 'sent' status --
-- the ledger says "we do not know", which is the only honest thing it can say
-- and the thing the previous code was right to protect.

-- ---------------------------------------------------------------------------
-- 1. Acceptance, and WHO SAID SO.
-- ---------------------------------------------------------------------------

-- WHEN the acceptance was established. Not when it happened -- nobody can know
-- that, because LinkedIn does not publish it -- but when Trevra first had
-- evidence for it. Separate from `recorded_at`, which stays pinned to the
-- moment the INVITE went out: every rolling window in `actions.ts` reads
-- `recorded_at`, so moving it forward when an acceptance arrives would charge
-- this week's invite budget for an invite sent three weeks ago.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

-- 'human' or 'detected'. NULL means acceptance was never established.
--
-- THE TWO CAN NEVER BE CONFUSED IN THE LEDGER, and that is the entire reason
-- this column exists rather than the status alone carrying the fact. A human
-- ticking "they accepted" is a report from somebody who looked; a detection is
-- a machine's reading of a badge on a page that may have been localised,
-- redesigned or A/B-tested since this code was written. An operator auditing a
-- campaign, and any future throttle that leans on the acceptance rate, is
-- entitled to know which of those it is looking at.
--
-- 'human' WINS. `writeActionStatus` refuses a detected acceptance over a row
-- a human has already marked, and a human mark over a detection overwrites the
-- source (keeping the earlier `accepted_at`, which is the earliest evidence).
-- Unconstrained TEXT for the same reason `status` is: see migration 032.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS accepted_source TEXT;

-- The last time the detector spent a PAGE VIEW on this invite.
--
-- A DETECTION COSTS A REAL PROFILE VIEW. Opening somebody's profile to read
-- their degree is indistinguishable, from LinkedIn's side, from viewing their
-- profile -- because it IS viewing their profile. So the check is budgeted,
-- gated and paced exactly like any other action, and this column is what stops
-- the same undecided invite being re-checked on every tick forever. It is
-- compared against `pending_seen_at`: an invite that reappears on the pending
-- list and disappears again is worth one more look; one that simply stayed
-- unreadable is not.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS acceptance_checked_at TIMESTAMPTZ;

-- The detector's own candidate query: this seat's invites that are still
-- filed as outstanding. Partial, because that is a small slice of a table
-- whose whole point is to grow forever.
CREATE INDEX IF NOT EXISTS linkedin_actions_pending_invite_idx
  ON linkedin_actions (workspace_id, seat_key, pending_seen_at)
  WHERE kind = 'invite' AND status IN ('sent', 'exported');

-- ---------------------------------------------------------------------------
-- 2. WHEN THE PENDING LIST WAS LAST READ IN FULL.
-- ---------------------------------------------------------------------------

-- "This invite is no longer on the pending list" is only a fact if we know the
-- list was read, and read completely. Without this column the detector would
-- have to infer the sync moment from the newest `pending_seen_at` on any row --
-- which is wrong in exactly the case that matters: a seat whose backlog
-- exceeded the driver's 500-card bound gets a TRUNCATED list, and every invite
-- in the unread tail would look as though it had vanished.
--
-- So it is written by `syncPendingInvites` ONLY when the driver reported the
-- list complete. A truncated read refreshes the evidence it did gather and
-- moves this clock not at all, which means a truncated sync can never license
-- a single disappearance conclusion.
ALTER TABLE linkedin_seats ADD COLUMN IF NOT EXISTS pending_synced_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. TWO ACTIONS THAT WERE HAPPENING AND WERE NOT BEING FILED.
-- ---------------------------------------------------------------------------
--
-- `linkedin_actions.kind` gains 'withdraw' and `linkedin_actions.source` gains
-- 'system'. Neither column carries a CHECK (migration 022, and 023/032/034/035
-- make the same call), so this is a documentation change here and a union
-- widening in `actions.ts` -- the two halves of one change, exactly as those
-- migrations describe.
--
-- WHY 'withdraw' IS A KIND AND NOT ONLY A STATUS. Migration 032 records a
-- withdrawal as `status='withdrawn'` on the INVITE row, which is the right
-- thing to say about the invite and says nothing at all about the withdrawal.
-- A withdrawal is a click in a real LinkedIn account on a real day: it is
-- traffic, it is paced (withdraw.ts runs it through the whole safety gate and
-- the same 30-120s gaps), and it was invisible to every rolling count and
-- every analytics panel in the product. `manual_message` had the same shape --
-- a workflow step that produces a real message, sent by a human from their own
-- LinkedIn, and no ledger row anywhere -- and it is filed as the 'dm' it
-- actually is, once, when the operator completes the task.
--
-- 'system' is the source for a row NO HUMAN AND NO CAMPAIGN ASKED FOR: the
-- profile view the acceptance detector spends, and the withdrawal the sweep
-- performs. Separate from 'campaign' because a campaign row is one an operator
-- approved a sequence for, and separate from 'manual' because nobody typed it.
--
-- 'inmail' STAYS IN THE COLUMN'S ENUMERATION AND IS UNSUPPORTED.
-- `local-worker.ts` has never had a driver routine for it, so an InMail action
-- could be planned, could consume a seat's monthly quota check, and could never
-- be sent by anything. It is now named in `UNSUPPORTED_ACTION_KINDS`
-- (actions.ts) and removed from every surface that offers or counts it, rather
-- than deleted from this column's history -- a value the schema once accepted
-- is a value old rows may hold.

COMMENT ON COLUMN linkedin_actions.kind IS
  'invite|dm|reply|profile_view|comment|follow|like|endorse|withdraw. '
  '''inmail'' is accepted for historical rows and is UNSUPPORTED: no driver sends it '
  '(see UNSUPPORTED_ACTION_KINDS in actions.ts). ''withdraw'' is one confirmed '
  'pending-invite withdrawal, filed alongside the invite row it retracted.';

COMMENT ON COLUMN linkedin_actions.source IS
  'export|manual|aggregator|campaign|system. ''system'' is work no human and no '
  'approved sequence asked for: the acceptance detector''s profile view and the '
  'withdrawal sweep''s click.';
