-- Per-step service-level deadline. This is a prioritisation deadline only: it
-- never raises a LinkedIn safety ceiling or turns a not-yet-due action due.
ALTER TABLE linkedin_actions
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_linkedin_actions_sla_due
  ON linkedin_actions(workspace_id,seat_key,sla_deadline_at,planned_for)
  WHERE status='planned' AND claimed_at IS NULL AND sla_deadline_at IS NOT NULL;
