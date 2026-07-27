-- Keep public popularity and installation counters transactionally aligned with source rows.
CREATE OR REPLACE FUNCTION trevra_record_module_run_metrics()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  first_workspace BOOLEAN := FALSE;
  successful INTEGER := CASE WHEN NEW.status='ok' THEN 1 ELSE 0 END;
  failed INTEGER := CASE WHEN NEW.status='error' THEN 1 ELSE 0 END;
BEGIN
  INSERT INTO module_workspace_usage (
    module_id,workspace_id,total_runs,successful_runs,failed_runs,first_run_at,last_run_at
  ) VALUES (NEW.skill_id,NEW.workspace_id,1,successful,failed,NEW.started_at,NEW.started_at)
  ON CONFLICT (module_id,workspace_id) DO NOTHING;
  GET DIAGNOSTICS first_workspace = ROW_COUNT;

  IF NOT first_workspace THEN
    UPDATE module_workspace_usage SET
      total_runs=total_runs+1,
      successful_runs=successful_runs+successful,
      failed_runs=failed_runs+failed,
      first_run_at=COALESCE(first_run_at,NEW.started_at),
      last_run_at=NEW.started_at
    WHERE module_id=NEW.skill_id AND workspace_id=NEW.workspace_id;
  END IF;

  INSERT INTO module_usage_metrics (
    module_id,total_runs,successful_runs,failed_runs,unique_workspaces,
    active_installations,first_run_at,last_run_at,updated_at
  ) VALUES (
    NEW.skill_id,1,successful,failed,CASE WHEN first_workspace THEN 1 ELSE 0 END,
    0,NEW.started_at,NEW.started_at,CURRENT_TIMESTAMP
  )
  ON CONFLICT (module_id) DO UPDATE SET
    total_runs=module_usage_metrics.total_runs+1,
    successful_runs=module_usage_metrics.successful_runs+successful,
    failed_runs=module_usage_metrics.failed_runs+failed,
    unique_workspaces=module_usage_metrics.unique_workspaces+CASE WHEN first_workspace THEN 1 ELSE 0 END,
    first_run_at=COALESCE(module_usage_metrics.first_run_at,NEW.started_at),
    last_run_at=NEW.started_at,
    updated_at=CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trevra_module_run_metrics ON skill_runs;
CREATE TRIGGER trevra_module_run_metrics
AFTER INSERT ON skill_runs
FOR EACH ROW EXECUTE FUNCTION trevra_record_module_run_metrics();

CREATE OR REPLACE FUNCTION trevra_record_module_install_metrics()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO module_usage_metrics (module_id,active_installations,updated_at)
    VALUES (NEW.module_id,1,CURRENT_TIMESTAMP)
    ON CONFLICT (module_id) DO UPDATE SET
      active_installations=module_usage_metrics.active_installations+1,
      updated_at=CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  UPDATE module_usage_metrics SET
    active_installations=GREATEST(0,active_installations-1),updated_at=CURRENT_TIMESTAMP
  WHERE module_id=OLD.module_id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trevra_module_install_metrics ON workspace_module_installations;
CREATE TRIGGER trevra_module_install_metrics
AFTER INSERT OR DELETE ON workspace_module_installations
FOR EACH ROW EXECUTE FUNCTION trevra_record_module_install_metrics();

UPDATE module_usage_metrics metrics SET
  active_installations=(SELECT COUNT(*) FROM workspace_module_installations installation WHERE installation.module_id=metrics.module_id),
  updated_at=CURRENT_TIMESTAMP;
