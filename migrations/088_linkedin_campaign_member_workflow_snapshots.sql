-- Preserve the exact workflow version each admitted lead is executing.
-- Pending leads intentionally keep these columns null until admission so an
-- explicit "apply latest to pending" can update only future waves.
ALTER TABLE linkedin_campaign_members
  ADD COLUMN IF NOT EXISTS workflow_snapshot_json JSONB,
  ADD COLUMN IF NOT EXISTS workflow_version INTEGER;

UPDATE linkedin_campaign_members m
SET workflow_snapshot_json=c.sequence_json,
    workflow_version=CASE
      WHEN (c.sequence_json->>'workflowVersion') ~ '^[0-9]+$'
        THEN (c.sequence_json->>'workflowVersion')::integer
      ELSE NULL
    END
FROM linkedin_campaigns c
WHERE c.id=m.campaign_id
  AND c.workspace_id=m.workspace_id
  AND m.admitted_at IS NOT NULL
  AND m.workflow_snapshot_json IS NULL;

CREATE INDEX IF NOT EXISTS idx_linkedin_campaign_members_workflow_version
  ON linkedin_campaign_members(workspace_id,campaign_id,workflow_version)
  WHERE admitted_at IS NOT NULL;
