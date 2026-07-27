-- Public module registry, privacy-safe popularity counters, and event-derived commercial projections.

CREATE TABLE IF NOT EXISTS module_publishers (
  id TEXT PRIMARY KEY,
  owner_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  reputation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_packages (
  module_id TEXT PRIMARY KEY,
  publisher_id TEXT REFERENCES module_publishers(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('builtin','community')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  latest_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_releases (
  module_id TEXT NOT NULL REFERENCES module_packages(module_id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('builtin','oci','wasi','remote')),
  artifact_ref TEXT,
  artifact_digest TEXT NOT NULL,
  manifest_json JSONB NOT NULL,
  permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_schema_json JSONB NOT NULL,
  output_schema_json JSONB NOT NULL,
  side_effect TEXT NOT NULL CHECK (side_effect IN ('none','network-read','external-write')),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  signature TEXT,
  signature_payload_hash TEXT NOT NULL,
  sbom_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('draft','verified','blocked','deprecated')),
  published_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (module_id, version)
);

CREATE INDEX IF NOT EXISTS idx_module_releases_public
  ON module_releases(status, published_at DESC);

CREATE TABLE IF NOT EXISTS workspace_module_installations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  version TEXT NOT NULL,
  installed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, module_id),
  FOREIGN KEY (module_id, version) REFERENCES module_releases(module_id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS module_workspace_usage (
  module_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  total_runs BIGINT NOT NULL DEFAULT 0,
  successful_runs BIGINT NOT NULL DEFAULT 0,
  failed_runs BIGINT NOT NULL DEFAULT 0,
  first_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  PRIMARY KEY (module_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS module_usage_metrics (
  module_id TEXT PRIMARY KEY,
  total_runs BIGINT NOT NULL DEFAULT 0,
  successful_runs BIGINT NOT NULL DEFAULT 0,
  failed_runs BIGINT NOT NULL DEFAULT 0,
  unique_workspaces BIGINT NOT NULL DEFAULT 0,
  active_installations BIGINT NOT NULL DEFAULT 0,
  first_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Register built-in skills and backfill their public usage metrics.
INSERT INTO module_packages (module_id,source_type,name,description,latest_version,created_at,updated_at)
SELECT id,'builtin',name,name,version,created_at,updated_at FROM skills
ON CONFLICT (module_id) DO UPDATE SET
  name=excluded.name,latest_version=excluded.latest_version,updated_at=excluded.updated_at;

INSERT INTO module_releases (
  module_id,version,runtime,artifact_ref,artifact_digest,manifest_json,permissions_json,
  input_schema_json,output_schema_json,side_effect,requires_approval,signature,
  signature_payload_hash,sbom_json,status,published_at
)
SELECT id,version,'builtin',NULL,'builtin:' || id || '@' || version,
  jsonb_build_object('id',id,'version',version,'runtime','builtin'),
  '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'none',FALSE,NULL,
  md5(id || '@' || version),'{}'::jsonb,'verified',created_at
FROM skills
ON CONFLICT (module_id,version) DO NOTHING;

INSERT INTO module_workspace_usage (
  module_id,workspace_id,total_runs,successful_runs,failed_runs,first_run_at,last_run_at
)
SELECT skill_id,workspace_id,COUNT(*),COUNT(*) FILTER (WHERE status='ok'),COUNT(*) FILTER (WHERE status='error'),
  MIN(started_at),MAX(started_at)
FROM skill_runs GROUP BY skill_id,workspace_id
ON CONFLICT (module_id,workspace_id) DO UPDATE SET
  total_runs=excluded.total_runs,successful_runs=excluded.successful_runs,failed_runs=excluded.failed_runs,
  first_run_at=excluded.first_run_at,last_run_at=excluded.last_run_at;

INSERT INTO module_usage_metrics (
  module_id,total_runs,successful_runs,failed_runs,unique_workspaces,active_installations,first_run_at,last_run_at,updated_at
)
SELECT module_id,SUM(total_runs),SUM(successful_runs),SUM(failed_runs),COUNT(*),0,MIN(first_run_at),MAX(last_run_at),CURRENT_TIMESTAMP
FROM module_workspace_usage GROUP BY module_id
ON CONFLICT (module_id) DO UPDATE SET
  total_runs=excluded.total_runs,successful_runs=excluded.successful_runs,failed_runs=excluded.failed_runs,
  unique_workspaces=excluded.unique_workspaces,first_run_at=excluded.first_run_at,last_run_at=excluded.last_run_at,
  updated_at=CURRENT_TIMESTAMP;

-- Event capture for the commercial graph. Existing tables stay operational write models;
-- these events drive rebuildable projections and future event-sourced replacements.
CREATE TABLE IF NOT EXISTS commercial_entity_versions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  current_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id,entity_type,entity_id)
);

CREATE TABLE IF NOT EXISTS commercial_entity_events (
  position BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version BIGINT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id,entity_type,entity_id,entity_version)
);

CREATE INDEX IF NOT EXISTS idx_commercial_entity_events_position
  ON commercial_entity_events(position);
CREATE INDEX IF NOT EXISTS idx_commercial_entity_events_entity
  ON commercial_entity_events(workspace_id,entity_type,entity_id,entity_version);

CREATE TABLE IF NOT EXISTS commercial_entity_projections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version BIGINT NOT NULL,
  state_json JSONB NOT NULL,
  source_position BIGINT NOT NULL,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id,entity_type,entity_id)
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  last_position BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connections','source_records','clients','opportunities','projects','contracts','contract_clauses',
    'scope_items','milestones','deliverables','messages','commitments','invoices','recommendations',
    'proof_packs','proof_pack_items','actions','approvals','recommendation_outcomes'
  ] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trevra_capture_%I ON %I',table_name,table_name);
      EXECUTE format(
        'CREATE TRIGGER trevra_capture_%I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trevra_capture_commercial_entity()',
        table_name,table_name
      );
    END IF;
  END LOOP;
END $$;
