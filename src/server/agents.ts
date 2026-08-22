import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { id } from './db.js';

export type AgentStatus = 'active' | 'paused' | 'disabled';

export interface AgentPrincipal {
  id: string;
  workspaceId: string;
  name: string;
  purpose: string;
  status: AgentStatus;
  isDefault: boolean;
  createdByUserId: string | null;
  policyProfile: Record<string, unknown>;
  config: {
    instructions?: string;
    skillIds?: string[];
    [key: string]: unknown;
  };
  activeTokenCount: number;
  runCount: number;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunAt: string | null;
  scheduleEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class AgentPrincipalError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

const DEFAULT_AGENT_NAME = 'GTM Agent';
const DEFAULT_AGENT_PURPOSE = 'Coordinate and prepare GTM work across the workspace.';

function defaultAgentId(workspaceId: string): string {
  return `agent_${createHash('md5').update(`${workspaceId}:default-agent`).digest('hex').slice(0, 24)}`;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function ensureDefaultAgent(
  db: Db,
  workspaceId: string,
  createdByUserId: string | null = null
): Promise<AgentPrincipal> {
  const existing = await getDefaultAgent(db, workspaceId);
  if (existing) return existing;

  const agentId = defaultAgentId(workspaceId);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `
        INSERT INTO agents (
          id,workspace_id,created_by_user_id,name,purpose,status,is_default,created_at,updated_at
        ) VALUES (?,?,?,?,?,'active',TRUE,?,?)
        ON CONFLICT (id) DO NOTHING
      `
      )
      .run(
        agentId,
        workspaceId,
        createdByUserId,
        DEFAULT_AGENT_NAME,
        DEFAULT_AGENT_PURPOSE,
        now,
        now
      );
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code !== '23505') throw error;
  }

  const resolved = await getDefaultAgent(db, workspaceId);
  if (!resolved) throw new Error('Default Agent principal could not be created.');
  return resolved;
}

export async function resolveActiveAgent(
  db: Db,
  workspaceId: string,
  agentId?: string | null,
  createdByUserId: string | null = null
): Promise<AgentPrincipal> {
  const agent = agentId?.trim()
    ? await getAgent(db, workspaceId, agentId.trim())
    : await ensureDefaultAgent(db, workspaceId, createdByUserId);
  if (!agent) throw new AgentPrincipalError('Agent not found in this workspace.', 404);
  if (agent.status !== 'active') {
    throw new AgentPrincipalError(
      `Agent ${agent.name} is ${agent.status}; resume it before assigning work.`,
      409
    );
  }
  return agent;
}

export async function getDefaultAgent(db: Db, workspaceId: string): Promise<AgentPrincipal | null> {
  const row = await db
    .prepare(
      `
      SELECT a.*,
        (SELECT COUNT(*)::int FROM agent_tokens t
         WHERE t.workspace_id=a.workspace_id AND t.agent_id=a.id AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at>CURRENT_TIMESTAMP)) AS active_token_count,
        (SELECT COUNT(*)::int FROM agent_runs r
         WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id) AS run_count,
        latest.id AS latest_run_id, latest.status AS latest_run_status,
        latest.started_at AS latest_run_at,
        COALESCE(s.enabled,FALSE) AS schedule_enabled
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT r.id,r.status,r.started_at
        FROM agent_runs r
        WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id
        ORDER BY r.started_at DESC,r.id DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN workspace_agent_schedule s
        ON s.workspace_id=a.workspace_id AND s.agent_id=a.id
      WHERE a.workspace_id=? AND a.is_default=TRUE
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(workspaceId);
  return row ? serializeAgent(row) : null;
}

export async function getAgent(
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<AgentPrincipal | null> {
  const row = await db
    .prepare(
      `
      SELECT a.*,
        (SELECT COUNT(*)::int FROM agent_tokens t
         WHERE t.workspace_id=a.workspace_id AND t.agent_id=a.id AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at>CURRENT_TIMESTAMP)) AS active_token_count,
        (SELECT COUNT(*)::int FROM agent_runs r
         WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id) AS run_count,
        latest.id AS latest_run_id, latest.status AS latest_run_status,
        latest.started_at AS latest_run_at,
        COALESCE(s.enabled,FALSE) AS schedule_enabled
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT r.id,r.status,r.started_at
        FROM agent_runs r
        WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id
        ORDER BY r.started_at DESC,r.id DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN workspace_agent_schedule s
        ON s.workspace_id=a.workspace_id AND s.agent_id=a.id
      WHERE a.workspace_id=? AND a.id=?
      LIMIT 1
    `
    )
    .get<Record<string, unknown>>(workspaceId, agentId);
  return row ? serializeAgent(row) : null;
}

export async function listAgents(db: Db, workspaceId: string): Promise<AgentPrincipal[]> {
  const rows = await db
    .prepare(
      `
      SELECT a.*,
        (SELECT COUNT(*)::int FROM agent_tokens t
         WHERE t.workspace_id=a.workspace_id AND t.agent_id=a.id AND t.revoked_at IS NULL
           AND (t.expires_at IS NULL OR t.expires_at>CURRENT_TIMESTAMP)) AS active_token_count,
        (SELECT COUNT(*)::int FROM agent_runs r
         WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id) AS run_count,
        latest.id AS latest_run_id, latest.status AS latest_run_status,
        latest.started_at AS latest_run_at,
        COALESCE(s.enabled,FALSE) AS schedule_enabled
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT r.id,r.status,r.started_at
        FROM agent_runs r
        WHERE r.workspace_id=a.workspace_id AND r.agent_id=a.id
        ORDER BY r.started_at DESC,r.id DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN workspace_agent_schedule s
        ON s.workspace_id=a.workspace_id AND s.agent_id=a.id
      WHERE a.workspace_id=?
      ORDER BY a.is_default DESC,a.created_at ASC,a.id ASC
    `
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serializeAgent);
}

export async function createAgent(
  db: Db,
  input: {
    workspaceId: string;
    createdByUserId: string;
    name: string;
    purpose: string;
    instructions?: string;
    skillIds?: string[];
  }
): Promise<AgentPrincipal> {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  const instructions = input.instructions?.trim() ?? '';
  const skillIds = input.skillIds
    ? [...new Set(input.skillIds.map((value) => value.trim()).filter(Boolean))]
    : undefined;
  if (!name) throw new AgentPrincipalError('Agent name is required.');
  if (!purpose) throw new AgentPrincipalError('Agent purpose is required.');
  if (name.length > 100) throw new AgentPrincipalError('Agent name is too long.');
  if (purpose.length > 500) throw new AgentPrincipalError('Agent purpose is too long.');
  if (instructions.length > 4000) throw new AgentPrincipalError('Agent instructions are too long.');
  const config = {
    ...(instructions ? { instructions } : {}),
    ...(skillIds !== undefined ? { skillIds } : {})
  };
  const agentId = id('agent');
  const now = new Date().toISOString();
  await db
    .prepare(
      `
      INSERT INTO agents (
        id,workspace_id,created_by_user_id,name,purpose,status,is_default,config_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,'active',FALSE,?,?,?)
    `
    )
    .run(
      agentId,
      input.workspaceId,
      input.createdByUserId,
      name,
      purpose,
      JSON.stringify(config),
      now,
      now
    );
  await recordAgentAudit(db, input.workspaceId, input.createdByUserId, 'agent.created', agentId, {
    name,
    purpose,
    instructions,
    skillIds
  });
  const created = await getAgent(db, input.workspaceId, agentId);
  if (!created) throw new Error('Agent could not be reloaded.');
  return created;
}

export async function updateAgent(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    agentId: string;
    name?: string;
    purpose?: string;
    instructions?: string;
    skillIds?: string[];
    status?: AgentStatus;
  }
): Promise<AgentPrincipal> {
  const existing = await getAgent(db, input.workspaceId, input.agentId);
  if (!existing) throw new AgentPrincipalError('Agent not found in this workspace.', 404);
  const name = input.name === undefined ? existing.name : input.name.trim();
  const purpose = input.purpose === undefined ? existing.purpose : input.purpose.trim();
  const instructions =
    input.instructions === undefined
      ? typeof existing.config.instructions === 'string'
        ? existing.config.instructions
        : ''
      : input.instructions.trim();
  const skillIds =
    input.skillIds === undefined
      ? configuredAgentSkillIds(existing)
      : [...new Set(input.skillIds.map((value) => value.trim()).filter(Boolean))];
  if (!name) throw new AgentPrincipalError('Agent name is required.');
  if (!purpose) throw new AgentPrincipalError('Agent purpose is required.');
  if (name.length > 100) throw new AgentPrincipalError('Agent name is too long.');
  if (purpose.length > 500) throw new AgentPrincipalError('Agent purpose is too long.');
  if (instructions.length > 4000) throw new AgentPrincipalError('Agent instructions are too long.');
  const status = input.status ?? existing.status;
  const config = {
    ...existing.config,
    ...(instructions ? { instructions } : { instructions: undefined }),
    ...(skillIds !== null ? { skillIds } : {})
  };
  if (!instructions) delete config.instructions;
  const now = new Date().toISOString();
  await db
    .prepare(
      'UPDATE agents SET name=?,purpose=?,status=?,config_json=?,updated_at=? WHERE workspace_id=? AND id=?'
    )
    .run(name, purpose, status, JSON.stringify(config), now, input.workspaceId, input.agentId);
  await recordAgentAudit(db, input.workspaceId, input.actorUserId, 'agent.updated', input.agentId, {
    name,
    purpose,
    instructions,
    skillIds,
    status
  });
  const updated = await getAgent(db, input.workspaceId, input.agentId);
  if (!updated) throw new Error('Agent could not be reloaded.');
  return updated;
}

async function recordAgentAudit(
  db: Db,
  workspaceId: string,
  actorUserId: string,
  eventType: string,
  agentId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO audit_events (
        id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
      ) VALUES (?,?,?,?,?,'agent',?,?,?)
    `
    )
    .run(
      id('audit'),
      workspaceId,
      'user',
      actorUserId,
      eventType,
      agentId,
      JSON.stringify(metadata),
      new Date().toISOString()
    );
}

export function configuredAgentSkillIds(agent: AgentPrincipal): string[] | null {
  const value = agent.config.skillIds;
  if (!Array.isArray(value)) return null;
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
        .map((entry) => entry.trim())
    )
  ];
}

export function agentInstructions(agent: AgentPrincipal): string {
  return typeof agent.config.instructions === 'string' ? agent.config.instructions.trim() : '';
}

function serializeAgent(row: Record<string, unknown>): AgentPrincipal {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    purpose: String(row.purpose),
    status: String(row.status) as AgentStatus,
    isDefault: Boolean(row.is_default),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    policyProfile: parseObject(row.policy_profile_json),
    config: parseObject(row.config_json),
    activeTokenCount: Number(row.active_token_count ?? 0),
    runCount: Number(row.run_count ?? 0),
    latestRunId: row.latest_run_id ? String(row.latest_run_id) : null,
    latestRunStatus: row.latest_run_status ? String(row.latest_run_status) : null,
    latestRunAt: row.latest_run_at ? new Date(String(row.latest_run_at)).toISOString() : null,
    scheduleEnabled: Boolean(row.schedule_enabled),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}
