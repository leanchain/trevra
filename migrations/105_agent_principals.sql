-- Durable agent principals.
--
-- Tokens are credentials, runs are executions, and schedules are assignments.
-- None of those is the actor itself. This migration introduces the durable
-- workspace-owned Agent principal and binds existing agent state to one default
-- principal without changing the workspace-wide budget or provider-credential
-- boundaries.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','disabled')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  policy_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_workspace_default
  ON agents(workspace_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_agents_workspace_status
  ON agents(workspace_id,status,created_at);

-- Existing workspaces that already have any agent-facing state get one stable
-- principal. The deterministic id makes migration/replay behavior inspectable.
WITH existing_agent_workspaces AS (
  SELECT workspace_id FROM agent_tokens
  UNION SELECT workspace_id FROM agent_runs
  UNION SELECT workspace_id FROM workspace_agent_schedule
  UNION SELECT workspace_id FROM workspace_agent_budget
)
INSERT INTO agents (
  id,workspace_id,name,purpose,status,is_default,created_at,updated_at
)
SELECT
  'agent_' || SUBSTR(MD5(workspace_id || ':default-agent'),1,24),
  workspace_id,
  'GTM Agent',
  'Coordinate and prepare GTM work across the workspace.',
  'active',
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM existing_agent_workspaces
ON CONFLICT (id) DO NOTHING;

ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS agent_id TEXT;
UPDATE agent_tokens t
SET agent_id=a.id
FROM agents a
WHERE a.workspace_id=t.workspace_id AND a.is_default AND t.agent_id IS NULL;
ALTER TABLE agent_tokens ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE agent_tokens
  DROP CONSTRAINT IF EXISTS agent_tokens_workspace_agent_fk;
ALTER TABLE agent_tokens
  ADD CONSTRAINT agent_tokens_workspace_agent_fk
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_agent_tokens_workspace_agent_created
  ON agent_tokens(workspace_id,agent_id,created_at DESC);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_id TEXT;
UPDATE agent_runs r
SET agent_id=a.id
FROM agents a
WHERE a.workspace_id=r.workspace_id AND a.is_default AND r.agent_id IS NULL;
ALTER TABLE agent_runs ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_workspace_agent_fk;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_workspace_agent_fk
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_agent_started
  ON agent_runs(workspace_id,agent_id,started_at DESC);

ALTER TABLE workspace_agent_schedule ADD COLUMN IF NOT EXISTS agent_id TEXT;
UPDATE workspace_agent_schedule s
SET agent_id=a.id
FROM agents a
WHERE a.workspace_id=s.workspace_id AND a.is_default AND s.agent_id IS NULL;
ALTER TABLE workspace_agent_schedule ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE workspace_agent_schedule
  DROP CONSTRAINT IF EXISTS workspace_agent_schedule_workspace_agent_fk;
ALTER TABLE workspace_agent_schedule
  ADD CONSTRAINT workspace_agent_schedule_workspace_agent_fk
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_agent_schedule_agent
  ON workspace_agent_schedule(workspace_id,agent_id);
