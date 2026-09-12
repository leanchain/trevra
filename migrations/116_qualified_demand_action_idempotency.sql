-- One prepared external action path per qualified-demand recommendation.
-- A recommendation is one commercial decision; a double-click or two API
-- instances racing must not create two approval runs for the same decision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_runs_qualified_demand_recommendation
  ON playbook_runs(workspace_id,(input_json->>'recommendationId'))
  WHERE playbook_key IN ('gtm.qualified-demand-email','gtm.conversation-email-reply')
    AND NULLIF(input_json->>'recommendationId','') IS NOT NULL
    AND status IN ('queued','running','waiting_approval');
