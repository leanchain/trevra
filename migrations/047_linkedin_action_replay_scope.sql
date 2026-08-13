-- Preserve Trevra's legacy one-kind-per-target replay guard while allowing a
-- managed workflow to name an explicit, stable step scope. Existing writers
-- omit replay_scope and continue to collide exactly as before.

ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS replay_scope TEXT NOT NULL DEFAULT 'legacy';

DROP INDEX IF EXISTS idx_linkedin_actions_target;
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_actions_target
  ON linkedin_actions(workspace_id, seat_key, kind, target_ref, replay_scope)
  WHERE status <> 'skipped';

CREATE INDEX IF NOT EXISTS idx_linkedin_actions_legacy_target
  ON linkedin_actions(workspace_id, seat_key, kind, target_ref)
  WHERE status <> 'skipped' AND replay_scope='legacy';
