-- Cascade deletes may fire child triggers after the workspace row is no longer visible.
-- Workspace deletion is a privacy boundary, so do not retain projection events for it.
CREATE OR REPLACE FUNCTION trevra_capture_commercial_entity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  row_data JSONB;
  workspace TEXT;
  entity TEXT;
  next_version BIGINT;
  op TEXT;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  workspace := trevra_commercial_workspace_id(TG_TABLE_NAME,row_data);
  entity := row_data->>'id';
  IF workspace IS NULL OR entity IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id=workspace) THEN RETURN COALESCE(NEW,OLD); END IF;
  op := CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END;

  INSERT INTO commercial_entity_versions (workspace_id,entity_type,entity_id,current_version,updated_at)
  VALUES (workspace,TG_TABLE_NAME,entity,1,CURRENT_TIMESTAMP)
  ON CONFLICT (workspace_id,entity_type,entity_id)
  DO UPDATE SET current_version=commercial_entity_versions.current_version+1,updated_at=CURRENT_TIMESTAMP
  RETURNING current_version INTO next_version;

  INSERT INTO commercial_entity_events (
    workspace_id,entity_type,entity_id,entity_version,operation,state_json,occurred_at
  ) VALUES (workspace,TG_TABLE_NAME,entity,next_version,op,row_data,CURRENT_TIMESTAMP);
  RETURN COALESCE(NEW,OLD);
END $$;
