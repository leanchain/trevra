-- Remove the generic commercial mirror.
--
-- Trevra's canonical GTM state already lives in workspace-scoped domain tables
-- plus the control-plane/domain-event ledger. Mirroring arbitrary tables into a
-- second generic entity/event/projection graph creates duplicate truth and a
-- horizontal-platform surface Trevra explicitly does not own.

DO $$
DECLARE trigger_row RECORD;
BEGIN
  FOR trigger_row IN
    SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname='public'
      AND t.tgname LIKE 'trevra_capture_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
      trigger_row.trigger_name,trigger_row.schema_name,trigger_row.table_name);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS trevra_capture_commercial_entity() CASCADE;
DROP FUNCTION IF EXISTS trevra_commercial_workspace_id(TEXT,JSONB) CASCADE;

DROP TABLE IF EXISTS commercial_entity_projections CASCADE;
DROP TABLE IF EXISTS commercial_entity_events CASCADE;
DROP TABLE IF EXISTS commercial_entity_versions CASCADE;
DROP TABLE IF EXISTS projection_checkpoints CASCADE;
