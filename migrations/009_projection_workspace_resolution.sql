CREATE OR REPLACE FUNCTION trevra_commercial_workspace_id(table_name TEXT, row_data JSONB)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE result TEXT;
BEGIN
  IF row_data ? 'workspace_id' THEN RETURN row_data->>'workspace_id'; END IF;
  CASE table_name
    WHEN 'contract_clauses' THEN SELECT workspace_id INTO result FROM contracts WHERE id=row_data->>'contract_id';
    WHEN 'scope_items' THEN SELECT workspace_id INTO result FROM projects WHERE id=row_data->>'project_id';
    WHEN 'milestones' THEN SELECT p.workspace_id INTO result FROM projects p WHERE p.id=row_data->>'project_id';
    WHEN 'deliverables' THEN SELECT p.workspace_id INTO result FROM projects p WHERE p.id=row_data->>'project_id';
    WHEN 'commitments' THEN SELECT workspace_id INTO result FROM clients WHERE id=row_data->>'client_id';
    WHEN 'proof_packs' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    WHEN 'proof_pack_items' THEN SELECT r.workspace_id INTO result FROM proof_packs pp JOIN recommendations r ON r.id=pp.recommendation_id WHERE pp.id=row_data->>'proof_pack_id';
    WHEN 'approvals' THEN SELECT a.workspace_id INTO result FROM actions a WHERE a.id=row_data->>'action_id';
    WHEN 'recommendation_outcomes' THEN SELECT r.workspace_id INTO result FROM recommendations r WHERE r.id=row_data->>'recommendation_id';
    ELSE result := NULL;
  END CASE;
  RETURN result;
END $$;
