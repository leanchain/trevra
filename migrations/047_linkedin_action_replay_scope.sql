DROP INDEX IF EXISTS idx_linkedin_actions_target;
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_actions_target
  ON linkedin_actions(workspace_id, seat_key, kind, target_ref, COALESCE(campaign_id, ''), COALESCE(planned_for, created_at))
  WHERE status <> 'skipped';
