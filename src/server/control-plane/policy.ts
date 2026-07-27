import type { Db } from '../db.js';

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyContext {
  workspaceId: string;
  action: string;
  actorType: string;
  actorId?: string | null;
  sideEffect?: 'none' | 'network-read' | 'external-write';
  playbookId?: string;
  skillId?: string;
  environment?: string;
  attributes?: Record<string, unknown>;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  policyId: string | null;
  policyName: string;
  reason: string;
  evaluatedAt: string;
}

interface PolicyRow {
  id: string;
  name: string;
  priority: number;
  action_pattern: string;
  effect: PolicyEffect;
  conditions_json: unknown;
}

export async function evaluatePolicy(db: Db, context: PolicyContext): Promise<PolicyDecision> {
  const rows = await db.prepare(`
    SELECT id,name,priority,action_pattern,effect,conditions_json
    FROM workspace_policies
    WHERE workspace_id=? AND enabled=TRUE
    ORDER BY priority DESC,created_at ASC
  `).all<PolicyRow & Record<string, unknown>>(context.workspaceId);

  for (const row of rows) {
    if (!matchesPattern(row.action_pattern, context.action)) continue;
    const conditions = parseObject(row.conditions_json);
    if (!matchesConditions(conditions, context)) continue;
    return {
      effect: row.effect,
      policyId: row.id,
      policyName: row.name,
      reason: `Matched workspace policy ${row.name}`,
      evaluatedAt: new Date().toISOString()
    };
  }

  if (context.sideEffect === 'external-write') {
    return {
      effect: 'require_approval',
      policyId: null,
      policyName: 'Built-in external-write boundary',
      reason: 'External writes require explicit approval unless a stricter workspace policy denies them.',
      evaluatedAt: new Date().toISOString()
    };
  }

  return {
    effect: 'allow',
    policyId: null,
    policyName: 'Built-in safe execution default',
    reason: 'Pure computation and network reads are allowed unless a workspace policy overrides them.',
    evaluatedAt: new Date().toISOString()
  };
}

export async function listWorkspacePolicies(db: Db, workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.prepare(`
    SELECT id,name,version,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
    FROM workspace_policies WHERE workspace_id=? ORDER BY priority DESC,created_at ASC
  `).all<Record<string, unknown>>(workspaceId);
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    version: Number(row.version),
    priority: Number(row.priority),
    actionPattern: String(row.action_pattern),
    effect: String(row.effect),
    conditions: parseObject(row.conditions_json),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }));
}

function matchesPattern(pattern: string, action: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(action);
}

function matchesConditions(conditions: Record<string, unknown>, context: PolicyContext): boolean {
  if (!matchesStringList(conditions.actorTypes, context.actorType)) return false;
  if (!matchesStringList(conditions.sideEffects, context.sideEffect)) return false;
  if (!matchesStringList(conditions.playbookIds, context.playbookId)) return false;
  if (!matchesStringList(conditions.skillIds, context.skillId)) return false;
  if (!matchesStringList(conditions.environments, context.environment)) return false;

  const attributes = context.attributes ?? {};
  if (!numberAtMost(attributes.amount, conditions.maxAmount)) return false;
  if (!numberAtLeast(attributes.confidence, conditions.minConfidence)) return false;
  if (!numberAtMost(attributes.recipients, conditions.maxRecipients)) return false;
  return true;
}

function matchesStringList(condition: unknown, actual: string | undefined): boolean {
  if (condition === undefined) return true;
  if (!Array.isArray(condition)) return false;
  return typeof actual === 'string' && condition.some((value) => value === actual);
}

function numberAtMost(actual: unknown, maximum: unknown): boolean {
  if (maximum === undefined) return true;
  return typeof actual === 'number' && typeof maximum === 'number' && actual <= maximum;
}

function numberAtLeast(actual: unknown, minimum: unknown): boolean {
  if (minimum === undefined) return true;
  return typeof actual === 'number' && typeof minimum === 'number' && actual >= minimum;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
