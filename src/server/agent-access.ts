import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from './db.js';
import { id } from './db.js';

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
export interface AgentIdentity {
  tokenId: string;
  workspaceId: string;
  createdByUserId: string | null;
  name: string;
  scopes: AgentScope[];
}

export interface AgentTokenSummary {
  id: string;
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
    /**
     * The human who asked for this token, or `null` when Trevra itself minted
     * it -- the CLI agent backend does that once per run (`agent/cli.ts`). The
     * column is nullable and the audit row says 'system' rather than naming a
     * user who did not click anything.
     */
    userId: string | null;
    name: string;
    scopes?: AgentScope[];
    expiresAt?: string | null;
  }
): Promise<{ token: string; record: AgentTokenSummary }> {
  const scopes = normalizeScopes(input.scopes ?? [...AGENT_SCOPES]);
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
      id,workspace_id,created_by_user_id,name,token_prefix,token_hash,
      scopes_json,last_used_at,expires_at,revoked_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `
    )
    .run(
      tokenId,
      input.workspaceId,
      input.userId,
      input.name.trim(),
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
      JSON.stringify({ name: input.name.trim(), prefix, scopes, expiresAt }),
      now
    );

  return {
    token,
    record: {
      id: tokenId,
      name: input.name.trim(),
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
    SELECT id,name,token_prefix,scopes_json,last_used_at,expires_at,revoked_at,created_at
    FROM agent_tokens WHERE workspace_id=? ORDER BY created_at DESC
  `
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(serializeToken);
}

export async function revokeAgentToken(
  db: Db,
  workspaceId: string,
  /** `null` when Trevra revokes its own single-run token. */
  userId: string | null,
  tokenId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `
    UPDATE agent_tokens SET revoked_at=?
    WHERE id=? AND workspace_id=? AND revoked_at IS NULL
  `
    )
    .run(now, tokenId, workspaceId);
  if (result.changes === 0) return false;

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
      '{}',
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
    SELECT id,workspace_id,created_by_user_id,name,scopes_json
    FROM agent_tokens
    WHERE token_hash=? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `
    )
    .get<Record<string, unknown>>(hashAgentToken(token), now);
  if (!row) return null;

  const scopes = normalizeScopes(parseJsonArray(row.scopes_json));
  await db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?').run(now, String(row.id));
  return {
    tokenId: String(row.id),
    workspaceId: String(row.workspace_id),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    name: String(row.name),
    scopes
  };
}

export function hasAgentScope(identity: AgentIdentity, scope: AgentScope): boolean {
  return identity.scopes.includes(scope);
}

function serializeToken(row: Record<string, unknown>): AgentTokenSummary {
  return {
    id: String(row.id),
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
