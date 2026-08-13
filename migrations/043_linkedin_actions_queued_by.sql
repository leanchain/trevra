-- Who queued this row, when it was a live human request that did:
-- `linkedin_actions.queued_by_user_id`.
--
-- Team workspace access (docs/superpowers/specs/2026-08-13-team-workspace-
-- access-design.md) makes it possible for more than one Trevra user to
-- operate the same workspace's LinkedIn seat. Goal 5 of that design is
-- specific: "Founder can see which of the two of them queued a given
-- LinkedIn action." Nothing in this table answered that before -- `source`
-- (022, widened by 038) records the MECHANISM (export / manual / campaign /
-- aggregator), never the human.
--
-- NULLABLE, ON DELETE SET NULL, and both are deliberate. A row must not
-- become unqueryable, or a user must not become undeletable, because of who
-- happened to click queue on it -- the same posture `approvals.user_id` and
-- `audit_events.actor_id` already take on this exact question elsewhere in
-- the schema. NULL means one of: queued before this migration existed,
-- queued by the approved-action executor running outside a live request (see
-- `control-plane/execution.ts`'s `linkedin.queue` handler), or queued by a
-- since-deleted user -- an inbox/queue screen showing "queued by <name>" can
-- fall back to "queued" for any of those without lying about which one it was.
--
-- NOT SET ON EVERY ROW. It is set at the three routes that queue a 'planned'
-- row for THIS DEPLOYMENT'S OWN local worker off a live request --
-- `queueCampaign` (queue.ts), `enqueueReply` (inbox.ts) and `recordEngagement`
-- (engagement.ts) -- never on the worker's own status-transition UPDATEs
-- (local-worker.ts writes what it DID, not who asked for it) and never on an
-- `exportCampaign` ('exported') row, which was handed to a tool Trevra does
-- not drive -- a different provenance question from "who queued this for our
-- own worker", see the `source` column's own comment (migration 038).
ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS queued_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN linkedin_actions.queued_by_user_id IS
  'The Trevra user (users.id) whose live request queued this row, for workspaces with more than one member. NULL for rows queued before this column existed, queued by the approved-action executor outside a live request, queued by a since-deleted user, or filed with source=''export'' (handed to a tool Trevra does not drive). Set by queueCampaign (queue.ts), enqueueReply (inbox.ts) and recordEngagement''s app.ts caller (engagement.ts); never by the local worker''s own status-transition updates.';
