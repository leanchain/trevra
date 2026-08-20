-- Remove the legacy post-sale/revenue domain. Trevra's product boundary is GTM only.
-- Trevra's own future SaaS subscription billing is a separate platform concern and
-- must not reuse these workspace-level customer-business records.

-- Retire old built-in revenue playbooks without destroying historical run ledgers.
UPDATE playbooks
SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE playbook_key IN ('revenue.invoice-delivered-work', 'revenue.protect-scope');

UPDATE workspace_playbooks
SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE playbook_key IN ('revenue.invoice-delivered-work', 'revenue.protect-scope');

-- Generic webhook / external-handoff workflow nodes are horizontal automation
-- primitives, not GTM product capabilities. Stop any campaign snapshot that
-- contains one, park its queued work, and delete obsolete channel-action rows
-- before constraining the surviving channel table to email and enrichment only.
-- Saved workflow definitions are then removed; campaigns reference them with ON DELETE SET NULL.
WITH invalid_workflows AS (
  SELECT id
  FROM linkedin_workflows
  WHERE jsonb_path_exists(
    steps_json,
    '$[*] ? (@.action == "webhook" || @.action == "external_handoff")'
  )
), invalid_campaigns AS (
  SELECT c.id, c.workspace_id
  FROM linkedin_campaigns c
  WHERE c.workflow_id IN (SELECT id FROM invalid_workflows)
     OR jsonb_path_exists(
          COALESCE(c.sequence_json, '{}'::jsonb),
          '$.steps[*] ? (@.action == "webhook" || @.action == "external_handoff")'
        )
)
UPDATE linkedin_campaigns c
SET status='stopped',
    stop_requested_at=COALESCE(c.stop_requested_at,CURRENT_TIMESTAMP),
    updated_at=CURRENT_TIMESTAMP
FROM invalid_campaigns invalid
WHERE c.id=invalid.id AND c.workspace_id=invalid.workspace_id;

WITH invalid_campaigns AS (
  SELECT id,workspace_id FROM linkedin_campaigns WHERE status='stopped' AND (
    jsonb_path_exists(
      COALESCE(sequence_json, '{}'::jsonb),
      '$.steps[*] ? (@.action == "webhook" || @.action == "external_handoff")'
    )
    OR workflow_id IN (
      SELECT id FROM linkedin_workflows
      WHERE jsonb_path_exists(
        steps_json,
        '$[*] ? (@.action == "webhook" || @.action == "external_handoff")'
      )
    )
  )
)
UPDATE linkedin_campaign_members m
SET status='removed',next_eligible_at=NULL,updated_at=CURRENT_TIMESTAMP
FROM invalid_campaigns invalid
WHERE m.campaign_id=invalid.id AND m.workspace_id=invalid.workspace_id
  AND m.status IN ('pending','active','waiting','manual','paused');

WITH invalid_campaigns AS (
  SELECT id,workspace_id FROM linkedin_campaigns WHERE status='stopped' AND (
    jsonb_path_exists(
      COALESCE(sequence_json, '{}'::jsonb),
      '$.steps[*] ? (@.action == "webhook" || @.action == "external_handoff")'
    )
    OR workflow_id IN (
      SELECT id FROM linkedin_workflows
      WHERE jsonb_path_exists(
        steps_json,
        '$[*] ? (@.action == "webhook" || @.action == "external_handoff")'
      )
    )
  )
)
UPDATE linkedin_manual_tasks t
SET status='cancelled'
FROM invalid_campaigns invalid
WHERE t.campaign_id=invalid.id AND t.workspace_id=invalid.workspace_id AND t.status='pending';
DELETE FROM linkedin_campaign_channel_actions
WHERE kind IN ('webhook','external_handoff');

ALTER TABLE linkedin_campaign_channel_actions
  DROP CONSTRAINT IF EXISTS linkedin_campaign_channel_actions_kind_check;
ALTER TABLE linkedin_campaign_channel_actions
  ADD CONSTRAINT linkedin_campaign_channel_actions_kind_check
  CHECK (kind IN ('email','find_email')); 

UPDATE linkedin_actions a
SET status='skipped',recorded_at=NULL,claimed_at=NULL
WHERE a.status IN ('planned','held') AND a.claimed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM linkedin_campaigns c
    WHERE c.id=a.campaign_id AND c.workspace_id=a.workspace_id AND c.status='stopped'
      AND jsonb_path_exists(
        COALESCE(c.sequence_json, '{}'::jsonb),
        '$.steps[*] ? (@.action == "webhook" || @.action == "external_handoff")'
      )
  );

DELETE FROM linkedin_workflows
WHERE jsonb_path_exists(
  steps_json,
  '$[*] ? (@.action == "webhook" || @.action == "external_handoff")'
);

-- Financial/project integrations are no longer Trevra product integrations.
DELETE FROM source_records
WHERE object_type IN ('invoice','payment','milestone','scope_item','contract')
   OR lower(provider) IN ('quickbooks','xero','stripe','honeybook','bonsai');

DELETE FROM connections
WHERE lower(provider) IN ('quickbooks','xero','stripe','honeybook','bonsai');

-- Keep only GTM follow-up recommendations. Actions/outcomes cascade from deleted recommendations.
DELETE FROM recommendations
WHERE type IN ('scope_creep','unbilled_milestone','overdue_invoice');

DELETE FROM automation_rules
WHERE recommendation_type IN ('scope_creep','unbilled_milestone','overdue_invoice');

-- Messages remain useful GTM history but no longer belong to projects.
ALTER TABLE messages DROP COLUMN IF EXISTS project_id;

-- Remove the post-sale business graph in child-first order.
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS deliverables CASCADE;
DROP TABLE IF EXISTS milestones CASCADE;
DROP TABLE IF EXISTS commitments CASCADE;
DROP TABLE IF EXISTS scope_items CASCADE;
DROP TABLE IF EXISTS contract_clauses CASCADE;
DROP TABLE IF EXISTS contracts CASCADE;
DROP TABLE IF EXISTS projects CASCADE;

-- Remove post-sale entities from the generic commercial projection history too.
-- Deleting a legacy finance source/connection above can itself append a final
-- delete event, so scrub those projected source/connection identities by their
-- captured state before removing the old entity-type histories.
DELETE FROM commercial_entity_versions
WHERE entity_type='source_records' AND entity_id IN (
  SELECT entity_id FROM commercial_entity_events
  WHERE entity_type='source_records' AND (
    state_json->>'object_type' IN ('invoice','payment','milestone','scope_item','contract')
    OR lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai')
  )
);
DELETE FROM commercial_entity_projections
WHERE entity_type='source_records' AND (
  state_json->>'object_type' IN ('invoice','payment','milestone','scope_item','contract')
  OR lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai')
);
DELETE FROM commercial_entity_events
WHERE entity_type='source_records' AND (
  state_json->>'object_type' IN ('invoice','payment','milestone','scope_item','contract')
  OR lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai')
);

DELETE FROM commercial_entity_versions
WHERE entity_type='connections' AND entity_id IN (
  SELECT entity_id FROM commercial_entity_events
  WHERE entity_type='connections'
    AND lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai')
);
DELETE FROM commercial_entity_projections
WHERE entity_type='connections'
  AND lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai');
DELETE FROM commercial_entity_events
WHERE entity_type='connections'
  AND lower(COALESCE(state_json->>'provider','')) IN ('quickbooks','xero','stripe','honeybook','bonsai');

-- The remaining projection stream is bounded to GTM entities such as people,
-- opportunities, messages, recommendations, approvals and actions.
DELETE FROM commercial_entity_projections
WHERE entity_type IN (
  'projects','contracts','contract_clauses','scope_items','milestones','deliverables',
  'commitments','invoices','payments','recommendation_outcomes'
);
DELETE FROM commercial_entity_events
WHERE entity_type IN (
  'projects','contracts','contract_clauses','scope_items','milestones','deliverables',
  'commitments','invoices','payments','recommendation_outcomes'
);
DELETE FROM commercial_entity_versions
WHERE entity_type IN (
  'projects','contracts','contract_clauses','scope_items','milestones','deliverables',
  'commitments','invoices','payments','recommendation_outcomes'
);

CREATE OR REPLACE FUNCTION trevra_commercial_workspace_id(table_name TEXT, row_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
  IF row_data ? 'workspace_id' THEN RETURN row_data->>'workspace_id'; END IF;
  CASE table_name
    WHEN 'proof_packs' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    WHEN 'proof_pack_items' THEN SELECT r.workspace_id INTO result FROM proof_packs pp JOIN recommendations r ON r.id=pp.recommendation_id WHERE pp.id=row_data->>'proof_pack_id';
    WHEN 'approvals' THEN SELECT a.workspace_id INTO result FROM actions a WHERE a.id=row_data->>'action_id';
    ELSE result := NULL;
  END CASE;
  RETURN result;
END $$;

-- Opportunity is minimal GTM pipeline state, not a revenue record.
ALTER TABLE opportunities DROP COLUMN IF EXISTS value;
ALTER TABLE opportunities DROP COLUMN IF EXISTS currency;

-- `clients` is temporary legacy identity until the People migration, but money
-- fields do not belong on that temporary identity record.
ALTER TABLE clients DROP COLUMN IF EXISTS active_value;
ALTER TABLE clients DROP COLUMN IF EXISTS currency;

-- Recommendations rank GTM work by evidence/confidence/urgency, not money.
ALTER TABLE recommendations DROP COLUMN IF EXISTS estimated_amount;
ALTER TABLE recommendations DROP COLUMN IF EXISTS currency;
ALTER TABLE automation_rules DROP COLUMN IF EXISTS max_amount;

-- The old outcome table existed to record revenue_invoiced/revenue_collected.
-- GTM action outcomes are already represented in the action/domain-event ledger.
DROP TABLE IF EXISTS recommendation_outcomes CASCADE;
