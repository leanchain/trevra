-- Conditional branching on a stored sequence: "if the invite was accepted send
-- a message, if it was not send an InMail".
--
-- WHY THIS MIGRATION ADDS NO COLUMN AND NO TABLE, which is the whole of it.
--
-- 025 stores the approved copy as `linkedin_campaigns.sequence_json` -- "the
-- copy exactly as `gtm.linkedin-sequence` produced it and a human approved it"
-- -- and that blob is a list of steps. A branch is a property OF a step: it
-- says whether that step runs, in the same way `day` says when it runs and
-- `template` says what it says. So it belongs on the step, inside the same
-- JSONB, and every alternative is worse in a specific way:
--
--   A `linkedin_sequence_conditions` table keyed by (campaign, step id) would
--   split one approved artefact across two rows. `canonicalPayloadHash` binds
--   an approval to the payload (playbooks/registry.ts) and the sequence edit
--   route re-earns that approval on every change; a condition living outside
--   the hashed blob could be edited without invalidating the approval it
--   changes the meaning of. That is not a normalisation choice, it is a hole
--   in the approval gate.
--
--   A `branching_json` column beside `sequence_json` has the same defect in a
--   smaller box, plus a join by step id that nothing enforces.
--
-- SO THE SHAPE, written down here because JSONB enforces none of it:
--
--   sequence_json.steps[*].condition = { "on": <branch>, "ofStepId": <step id> }
--
--   `on` is one of: accepted | replied | not_accepted | not_replied | always
--   `ofStepId` names an EARLIER step in the same `steps` array
--
-- AND THE COMPATIBILITY CLAIM, which is why there is no backfill and no
-- UPDATE statement in this file: `condition` is OPTIONAL and its absence means
-- `always`. Every sequence already in this table is a list of steps with no
-- `condition` key, so after this migration every one of them means exactly
-- what it meant before it -- a flat list gated only by `day`. This is a pure
-- extension. 026 had to back-fill because it changed what an existing value
-- MEANT; this changes nothing about any value that exists.
--
-- The reader is `src/server/linkedin/branching.ts`: `conditionRejection()`
-- refuses a bad branch at write time, `evaluateBranches()` decides per target
-- whether a step is due, skipped, or still waiting. A branch gates WHETHER a
-- step runs and never WHEN -- `pacing.ts` owns the calendar, and a condition
-- that could pull a step earlier than its declared day would be a route around
-- the daily band, the warm-up ramp and the day-over-day variance clamp all at
-- once.

-- The closed vocabulary, enforced by the database as well as by the validator.
--
-- WHY A CHECK HERE WHEN 023 ARGUED AGAINST ONE. 023 refused to add a CHECK to
-- `contact_identities.provider` because that would have been "a restriction,
-- not a permission, and it would fail on any workspace that has already
-- imported an identity kind we did not anticipate". Neither half applies to
-- this constraint: `condition` is a key no row in this table has ever carried,
-- so this cannot fail on existing data (`jsonb_path_exists` finds nothing in a
-- step that has no `condition`, and nothing in the `{}` default), and the
-- vocabulary is closed BY DESIGN rather than by our current imagination -- an
-- expression language was the thing deliberately not built, because a
-- condition nobody can check before it sends is a campaign that discovers its
-- own bug in a stranger's inbox.
--
-- WHAT IT DOES AND DOES NOT CHECK, precisely, so nobody reads more into it:
-- it rejects a step whose `condition.on` is a STRING outside the five. It does
-- not check that `ofStepId` exists, that it names an earlier step, that the
-- referenced step is an invite when the branch asks about acceptance, or that
-- the graph is acyclic -- every one of those is a statement about the step
-- list as a whole, and expressing them in jsonpath would be exactly the
-- unreviewable expression language this design refused. `conditionRejection()`
-- owns them, is the only writer, and names the offending step in its refusal.
-- This constraint is the floor under a hand-written UPDATE and under whatever
-- writes this column next.
ALTER TABLE linkedin_campaigns
  ADD CONSTRAINT linkedin_campaigns_sequence_condition_vocabulary
  CHECK (
    NOT jsonb_path_exists(
      sequence_json,
      '$.steps[*].condition.on ? (@ != "accepted" && @ != "replied" && @ != "not_accepted" && @ != "not_replied" && @ != "always")'
    )
  );

-- "Which live campaigns branch?"
--
-- Not an analytics index -- an operational one. A branch is the newest thing
-- that can be wrong about a send, so the first question after a bad report is
-- which campaigns are running one at all, and without this it is a sequential
-- scan over every sequence blob in the workspace. Partial on the same
-- predicate as the two guards in 025: a stopped campaign sends nothing, so it
-- is not part of that question and does not belong in the index.
CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_branching
  ON linkedin_campaigns(workspace_id, created_at DESC)
  WHERE status <> 'stopped' AND jsonb_path_exists(sequence_json, '$.steps[*].condition');
