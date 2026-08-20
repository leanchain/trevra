-- Shared-seat campaign fairness. This timestamp is not campaign activity in
-- general; it is the last instant the Managed runner successfully created an
-- outbound LinkedIn ledger row for this campaign. It exists so a sender with
-- fewer slots than campaigns can rotate the scarce slots instead of always
-- handing them to the same priority-ordered row.
ALTER TABLE linkedin_campaigns
  ADD COLUMN IF NOT EXISTS last_planned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_fair_planning
  ON linkedin_campaigns(workspace_id, status, last_planned_at, priority)
  WHERE status='running';
