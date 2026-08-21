import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from './db.js';
import { id } from './db.js';
import { resolveActiveAgent } from './agents.js';

export const AGENT_SCOPES = [
  'skills:read',
  'skills:run',
  'runs:read',
  'workspace:read',
  'playbooks:read',
  'playbooks:run',
  'workflows:read'
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** A credential resolves to an Agent principal. The token itself is never the actor. */
export interface AgentIdentity {
  agentId: string;
  tokenId: string;
  workspaceId: string;
  createdByUserId: string | null;
  name: string;
  tokenName: string;
  scopes: AgentScope[];
}

export interface AgentTokenSummary {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function createAgentToken(
  db: Db,
  input: {
    workspaceId: string;
    /** Human who asked for this credential; null when Trevra minted a single-run CLI token. */
    userId: string | null;
    agentId?: string | null;
    name: string;
    scopes?: AgentScope[];
    expiresAt?: string | null;
  }
): Promise<{ token: string; record: AgentTokenSummary }> {
  const agent = await resolveActiveAgent(db, input.workspaceId, input.agentId, input.userId);
  const scopes = normalizeScopes(input.scopes ?? [...AGENT_SCOPES]);
  const tokenName = input.name.trim();
  if (!tokenName) throw new Error('Token name is required');
  const token = `trv_live_${randomBytes(32).toString('base64url')}`;
  const tokenId = id('tok');
  const prefix = token.slice(0, 18);
  const now = new Date().toISOString();
  const expiresAt = input.expiresAt ?? null;

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw new Error('Token expiry must be in the future');
  }

  await db
    .prepare(
      `
      INSERT INTO agent_tokens (
        id,workspace_id,agent_id,created_by_user_id,name,token_prefix,token_hash,
        scopes_json,last_used_at,expires_at,revoked_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      tokenId,
      input.workspaceId,
      agent.id,
      input.userId,
      tokenName,
      prefix,
      hashAgentToken(token),
      JSON.stringify(scopes),
      null,
      expiresAt,
      null,
      now
    );

  await db
    .prepare(
      `
      INSERT INTO audit_events (
        id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      id('audit'),
      input.workspaceId,
      input.userId ? 'user' : 'system',
      input.userId,
      'agent_token.created',
      'agent_token',
      tokenId,
      JSON.stringify({ agentId: agent.id, tokenName, prefix, scopes, expiresAt }),
      now
    );

  return {
    token,
    record: {
      id: tokenId,
      agentId: agent.id,
      agentName: agent.name,
      name: tokenName,
      prefix,
      scopes,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
      createdAt: now
    }
  };
}

export async function listAgentTokens(db: Db, workspaceId: string): Promise<AgentTokenSummary[]> {
  const rows = await db
    .prepare(
      `
      SELECT t.id,t.agent_id,a.name AS agent_name,t.name,t.token_prefix,t.scopes_json,
             t.last_used_at,t.expires_at,t.revoked_at,t.created_at
      FROM agent_tokens t
      JOIN agents a ON a.workspace_id=t.workspace_id AND a.id=t.agent_id
      WHERE t.workspace_id=?
      ORDER BY t.created_at DESC
    `
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serializeToken);
}

export async function revokeAgentToken(
  db: Db,
  workspaceId: string,
  userId: string | null,
  tokenId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `
      UPDATE agent_tokens SET revoked_at=?
      WHERE id=? AND workspace_id=? AND revoked_at IS NULL
      RETURNING agent_id
    `
    )
    .get<{ agent_id: string }>(now, tokenId, workspaceId);
  if (!row) return false;

  await db
    .prepare(
      `
      INSERT INTO audit_events (
        id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      id('audit'),
      workspaceId,
      userId ? 'user' : 'system',
      userId,
      'agent_token.revoked',
      'agent_token',
      tokenId,
      JSON.stringify({ agentId: row.agent_id }),
      now
    );
  return true;
}

export async function resolveAgentIdentity(
  db: Db,
  headers: IncomingHttpHeaders
): Promise<AgentIdentity | null> {
  const authorization = firstHeader(headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token.startsWith('trv_live_') || token.length < 40 || token.length > 200) return null;

  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `
      SELECT t.id,t.agent_id,t.workspace_id,t.created_by_user_id,t.name AS token_name,
             t.scopes_json,a.name AS agent_name
      FROM agent_tokens t
      JOIN agents a ON a.workspace_id=t.workspace_id AND a.id=t.agent_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)
        AND a.status='active'
    `
    )
    .get<Record<string, unknown>>(hashAgentToken(token), now);
  if (!row) return null;

  const scopes = normalizeScopes(parseJsonArray(row.scopes_json));
  await db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?').run(now, String(row.id));
  return {
    agentId: String(row.agent_id),
    tokenId: String(row.id),
    workspaceId: String(row.workspace_id),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    name: String(row.agent_name),
    tokenName: String(row.token_name),
    scopes
  };
}

export function hasAgentScope(identity: AgentIdentity, scope: AgentScope): boolean {
  return identity.scopes.includes(scope);
}

function serializeToken(row: Record<string, unknown>): AgentTokenSummary {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    name: String(row.name),
    prefix: String(row.token_prefix),
    scopes: normalizeScopes(parseJsonArray(row.scopes_json)),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at)
  };
}

function normalizeScopes(scopes: readonly unknown[]): AgentScope[] {
  const allowed = new Set<AgentScope>(AGENT_SCOPES);
  return [
    ...new Set(
      scopes.filter(
        (scope): scope is AgentScope =>
          typeof scope === 'string' && allowed.has(scope as AgentScope)
      )
    )
  ];
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hashAgentToken(token: string): string {
  const pepper = process.env.TREVRA_AGENT_TOKEN_PEPPER ?? '';
  return createHash('sha256').update(`${pepper}\u0000${token}`).digest('hex');
}
