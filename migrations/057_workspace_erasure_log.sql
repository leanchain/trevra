-- The record that an erasure happened, and the only row in this schema that is
-- SUPPOSED to survive the workspace it describes.
--
-- WHY THIS TABLE HAS NO FOREIGN KEY. Every audit trail this product keeps is
-- workspace-scoped: `audit_events`, `domain_events`, `skill_runs`,
-- `playbook_runs` all reference `workspaces(id) ON DELETE CASCADE`, which is
-- exactly right while a workspace exists and useless the moment one does not.
-- `DELETE FROM workspaces` takes seventy-odd tables with it, including every
-- place that could have recorded the deletion -- so the deletion is the one
-- event this product could not, until now, prove it had performed. A regulator,
-- a support escalation and a customer asking "did you actually delete it" are
-- all the same question, and it had no answer anywhere.
--
-- So: no `REFERENCES workspaces(id)`. Not an oversight, and not a candidate for
-- a later migration to "fix" -- a foreign key here would cascade this row away
-- with everything else and re-open the gap it exists to close. The workspace id
-- is stored as an opaque string precisely because the thing it names is gone.
--
-- WHAT IT STORES IS COUNTS AND NAMES, NEVER CONTENTS. `rows_removed_json` is a
-- map of table name to row count, which is what makes the record useful --
-- "1,412 rows across 38 tables" is an auditable claim -- without turning the
-- erasure log into a surviving copy of the data that was erased. That would be
-- the same mistake as a backup nobody thought about, wearing an audit trail's
-- clothes. The requester's user id and email are kept because "by whom" is half
-- the question, and both are facts about the person who ASKED, not about the
-- workspace's customers.
--
-- Written by `DELETE /api/workspace` in the same transaction as the delete, so
-- there is no state where the rows are gone and the record of it is not.

CREATE TABLE IF NOT EXISTS workspace_erasures (
  id TEXT PRIMARY KEY,
  -- Deliberately unconstrained: the workspace this names no longer exists.
  workspace_id TEXT NOT NULL,
  -- Kept because an id is not a name, and a year later nobody remembers which
  -- customer `ws_01H...` was.
  workspace_name TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  requested_by_email TEXT NOT NULL,
  -- { "clients": 12, "linkedin_actions": 340, ... }. Counts only.
  rows_removed_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

-- "Was this workspace erased, and when?" -- the only question this table is
-- ever asked, and the only index it needs.
CREATE INDEX IF NOT EXISTS idx_workspace_erasures_workspace
  ON workspace_erasures(workspace_id, created_at DESC);
