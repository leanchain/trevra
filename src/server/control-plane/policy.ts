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
    if (!matchesConditions(conditions, context, row.effect)) continue;
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

/**
 * Derive the policy attributes -- `amount`, `recipients`, `confidence` -- that
 * `matchesConditions` compares against `maxAmount` / `maxRecipients` /
 * `minConfidence`, from a resolved action payload or skill input.
 *
 * UNIT: `amount` is in MAJOR currency units (EUR 5,000 -- not 500,000 cents),
 * which is also the unit of the `maxAmount` condition the founder types into
 * the policy form and the unit of every `amount` in the action payload schemas
 * (`invoice.create`, `change_order.create`) and of `recommendations.estimated_amount`.
 * A `*Cents` field is divided by 100 on the way in. A cents/euros mix-up here
 * is a 100x policy error, so that conversion happens once, here, and nowhere else.
 *
 * Payload shapes are NOT uniform across action types -- `email.send` carries a
 * single `recipient` string and no amount, `invoice.create` and
 * `change_order.create` carry a major-unit `amount`, `community.reply` carries
 * neither -- so every rule is best-effort, tolerates any shape without
 * throwing, and OMITS a key it cannot determine. Never guess: a guessed value
 * is evaluated as fact, and an omitted one is failed closed on by effect.
 */
export function policyAttributesFrom(payload: unknown): Record<string, unknown> {
  const source = plainObject(payload);
  const attributes: Record<string, unknown> = {};

  const amount = amountFrom(source);
  if (amount !== undefined) attributes.amount = amount;

  const recipients = recipientCountFrom(source);
  if (recipients !== undefined) attributes.recipients = recipients;

  if (isFiniteNumber(source.confidence)) attributes.confidence = source.confidence;

  return attributes;
}

/** Major currency units. See the unit note on `policyAttributesFrom`. */
function amountFrom(source: Record<string, unknown>): number | undefined {
  if (isFiniteNumber(source.amount)) return source.amount;
  const cents = centsFrom(source);
  if (cents !== undefined) return cents / 100;
  if (isFiniteNumber(source.estimatedAmount)) return source.estimatedAmount;
  if (isFiniteNumber(source.estimated_amount)) return source.estimated_amount;
  return undefined;
}

function centsFrom(source: Record<string, unknown>): number | undefined {
  if (isFiniteNumber(source.amountCents)) return source.amountCents;
  if (isFiniteNumber(source.amount_cents)) return source.amount_cents;
  for (const [key, value] of Object.entries(source)) {
    if ((key.endsWith('Cents') || key.endsWith('_cents')) && isFiniteNumber(value)) return value;
  }
  return undefined;
}

/** A count of people this action reaches, not the addresses themselves. */
function recipientCountFrom(source: Record<string, unknown>): number | undefined {
  for (const key of ['recipients', 'to', 'recipient']) {
    const value = source[key];
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'string' && value.trim() !== '') return 1;
  }
  return undefined;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function matchesPattern(pattern: string, action: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(action);
}

function matchesConditions(
  conditions: Record<string, unknown>,
  context: PolicyContext,
  effect: PolicyEffect
): boolean {
  if (!matchesStringList(conditions.actorTypes, context.actorType)) return false;
  if (!matchesStringList(conditions.sideEffects, context.sideEffect)) return false;
  if (!matchesStringList(conditions.playbookIds, context.playbookId)) return false;
  if (!matchesStringList(conditions.skillIds, context.skillId)) return false;
  if (!matchesStringList(conditions.environments, context.environment)) return false;

  const attributes = context.attributes ?? {};
  if (!numberAtMost(attributes.amount, conditions.maxAmount, effect)) return false;
  if (!numberAtLeast(attributes.confidence, conditions.minConfidence, effect)) return false;
  if (!numberAtMost(attributes.recipients, conditions.maxRecipients, effect)) return false;
  return true;
}

function matchesStringList(condition: unknown, actual: string | undefined): boolean {
  if (condition === undefined) return true;
  if (!Array.isArray(condition)) return false;
  return typeof actual === 'string' && condition.some((value) => value === actual);
}

/**
 * A numeric condition is UNEVALUABLE when either side is not a finite number:
 * the action carried no such attribute (`policyAttributesFrom` omits what it
 * cannot determine), or the stored bound is malformed. An unevaluable
 * condition is resolved by the rule's OWN EFFECT -- never by quietly failing
 * to match, which would leave a control the founder set deliberately silently
 * inert:
 *
 *   - effect `deny` or `require_approval` (restrictive) -> a missing attribute
 *     MATCHES. If we cannot prove the action is small enough to be safe, we
 *     treat it as needing the restriction.
 *   - effect `allow` (permissive) -> a missing attribute DOES NOT match. We
 *     never auto-allow on an unknown.
 *
 * So `if (missing) return effect !== 'allow'` is load-bearing, not a
 * convoluted `return false`. Collapsing it to one restores the bug where
 * "ask me first before anything over EUR 5,000" matched nothing at all.
 *
 * A bound of `undefined` or `null` means the condition was not set and is not
 * a constraint -- that is a different case from an unevaluable one.
 */
function numberAtMost(actual: unknown, maximum: unknown, effect: PolicyEffect): boolean {
  if (maximum === undefined || maximum === null) return true;
  const missing = !isFiniteNumber(actual) || !isFiniteNumber(maximum);
  if (missing) return effect !== 'allow';
  return actual <= maximum;
}

function numberAtLeast(actual: unknown, minimum: unknown, effect: PolicyEffect): boolean {
  if (minimum === undefined || minimum === null) return true;
  const missing = !isFiniteNumber(actual) || !isFiniteNumber(minimum);
  if (missing) return effect !== 'allow';
  return actual >= minimum;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
