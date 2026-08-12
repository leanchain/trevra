-- The conversation a queued reply answers in (integration of 030-034).
--
-- WHY A COLUMN AND NOT A JOIN.
--
-- `enqueueReply` (inbox.ts) files an ordinary `linkedin_actions` row and the
-- local worker claims it, gates it and executes it like any other action. But
-- a reply is addressed by THREAD and every other action is addressed by
-- PROFILE: `driver.ts` `sendDm` navigates to a profile and opens a fresh
-- composer, which for somebody already in the inbox is the wrong surface and
-- can start a second conversation with the same person. So the worker needs
-- LinkedIn's own conversation id at the moment it dispatches.
--
-- The alternative was to look the thread up from `linkedin_threads` by
-- matching `profile_url` against `target_ref` inside the claim. That works
-- today only because `enqueueReply` happens to set `target_ref` to the
-- thread's canonical `profile_url` -- an implementation detail of one function,
-- holding up the routing of a message to a stranger. `target_ref` is
-- documented as OPAQUE across this whole subsystem (022: whatever a human
-- typed, never resolved, never rewritten), so a join on it is a join on a
-- column whose contents nobody promised. The reply carries its own pointer
-- instead.
--
-- NULL FOR EVERY OTHER KIND, and that is enforced where it matters rather than
-- by a constraint: the worker's claim query refuses a `reply` whose
-- `thread_urn` is null or empty, exactly as it already refuses a `dm` with no
-- approved body. A half-written reply row is therefore not claimable, rather
-- than claimable and unsendable -- and `enqueueReply` writes the body and this
-- column in the same transaction as the row itself, so a half-written one
-- cannot survive at all.
--
-- No CHECK constraint, for the reason 032 gives at length about the eighth
-- status: `linkedin_actions` carries no CHECK on `kind` either, this family's
-- enumerations live in TypeScript plus the comments that document the column,
-- and adding a constraint to a live ledger whose history nobody has re-read is
-- a different change from adding a column that defaults to null.
ALTER TABLE linkedin_actions ADD COLUMN IF NOT EXISTS thread_urn TEXT;

COMMENT ON COLUMN linkedin_actions.thread_urn IS
  'LinkedIn conversation id for a kind=''reply'' action; NULL for every other kind. Written by enqueueReply and required by the local worker''s claim, because a reply is addressed by thread and not by profile.';

-- "Which conversation did this reply belong to?", and its inverse.
--
-- Partial on `reply`, because that is the only kind that ever carries one and
-- the column is null on every other row in the table -- an unpartitioned index
-- here would be an index that is overwhelmingly NULL. Narrow on purpose: this
-- answers the inbox screen's "is there a reply queued in this thread" without
-- a sequential scan over the ledger.
CREATE INDEX IF NOT EXISTS idx_linkedin_actions_reply_thread
  ON linkedin_actions(workspace_id, thread_urn)
  WHERE kind = 'reply' AND thread_urn IS NOT NULL;
