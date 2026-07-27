CREATE TABLE IF NOT EXISTS event_streams (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  current_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, stream_type, stream_id)
);

CREATE TABLE IF NOT EXISTS domain_events (
  position BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  causation_id TEXT,
  correlation_id TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, stream_type, stream_id, stream_version)
);

CREATE INDEX IF NOT EXISTS idx_domain_events_workspace_position
  ON domain_events(workspace_id, position DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_stream
  ON domain_events(workspace_id, stream_type, stream_id, stream_version);
CREATE INDEX IF NOT EXISTS idx_domain_events_correlation
  ON domain_events(workspace_id, correlation_id, position)
  WHERE correlation_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS workspace_skills (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, skill_id)
);

INSERT INTO workspace_skills (workspace_id,skill_id,enabled,config_json)
SELECT w.id,s.id,s.enabled,s.config_json FROM workspaces w CROSS JOIN skills s
ON CONFLICT (workspace_id,skill_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  action_pattern TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'require_approval')),
  conditions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_policies_match
  ON workspace_policies(workspace_id, enabled, priority DESC);

CREATE TABLE IF NOT EXISTS playbooks (
  playbook_key TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema_json JSONB NOT NULL,
  definition_json JSONB NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'builtin',
  source_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playbook_key, version)
);

CREATE TABLE IF NOT EXISTS workspace_playbooks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  playbook_key TEXT NOT NULL,
  pinned_version TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, playbook_key)
);

CREATE TABLE IF NOT EXISTS playbook_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  playbook_key TEXT NOT NULL,
  playbook_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB,
  error TEXT,
  current_step_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (playbook_key, playbook_version) REFERENCES playbooks(playbook_key, version)
);

CREATE INDEX IF NOT EXISTS idx_playbook_runs_workspace_status
  ON playbook_runs(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_runs_correlation
  ON playbook_runs(workspace_id, correlation_id);

CREATE TABLE IF NOT EXISTS playbook_step_runs (
  id TEXT PRIMARY KEY,
  playbook_run_id TEXT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('skill','approval','action')),
  skill_id TEXT,
  skill_version TEXT,
  skill_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_approval','completed','failed','skipped','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  input_json JSONB,
  output_json JSONB,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  policy_decision_json JSONB,
  approval_payload_hash TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (playbook_run_id, step_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_playbook_steps_ready
  ON playbook_step_runs(status, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_playbook_steps_run
  ON playbook_step_runs(playbook_run_id, step_id, attempt DESC);

CREATE TABLE IF NOT EXISTS playbook_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  playbook_run_id TEXT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  step_run_id TEXT NOT NULL REFERENCES playbook_step_runs(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  payload_hash TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_playbook_approvals_run
  ON playbook_approvals(playbook_run_id, created_at DESC);
