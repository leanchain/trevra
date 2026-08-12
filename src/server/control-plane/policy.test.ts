import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../db.js';
import { evaluatePolicy, policyAttributesFrom, type PolicyEffect } from './policy.js';

let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function openTestDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  return db;
}

async function insertPolicy(
  database: Db,
  input: { name: string; actionPattern: string; effect: PolicyEffect; conditions: Record<string, unknown> }
): Promise<void> {
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO workspace_policies (
      id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    id('pol'), DEMO_WORKSPACE_ID, input.name, 100, input.actionPattern, input.effect,
    JSON.stringify(input.conditions), true, now, now
  );
}

function evaluate(database: Db, attributes?: Record<string, unknown>) {
  return evaluatePolicy(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    action: 'action:invoice.create',
    actorType: 'user',
    sideEffect: 'external-write',
    ...(attributes === undefined ? {} : { attributes })
  });
}

// The real payload shapes, copied from the action schemas in `execution.ts`
// and the approval-step payloads in `playbooks/registry.ts`. `amount` is in
// MAJOR currency units everywhere -- see the unit note on `policyAttributesFrom`.
describe('policyAttributesFrom', () => {
  it('counts a single string recipient and finds no amount in an email.send payload', () => {
    expect(policyAttributesFrom({
      recipient: 'buyer@example.com',
      subject: 'Audit result',
      body: 'The audit is ready.',
      metadata: {}
    })).toEqual({ recipients: 1 });
  });

  it('reads a major-unit amount from an invoice.create payload', () => {
    expect(policyAttributesFrom({
      recipient: 'billing@example.com',
      amount: 2400,
      currency: 'USD',
      description: 'Final milestone',
      dueDays: 14,
      message: 'Invoice attached.'
    })).toEqual({ amount: 2400, recipients: 1 });
  });

  it('reads a major-unit amount from a change_order.create payload', () => {
    expect(policyAttributesFrom({
      recipient: 'client@example.com',
      subject: 'Additional scope',
      body: 'Please approve the added work.',
      amount: 750,
      currency: 'USD',
      description: 'Additional landing page'
    })).toEqual({ amount: 750, recipients: 1 });
  });

  it('determines nothing from a community.reply payload, which carries no amount and no recipient', () => {
    expect(policyAttributesFrom({
      platform: 'reddit',
      threadExternalId: 't3_abc',
      threadUrl: 'https://reddit.com/r/example/comments/abc',
      community: 'r/example',
      body: 'Here is what we found.',
      metadata: { relevanceScore: 0.8, threadTitle: 'Example' }
    })).toEqual({});
  });

  it('converts a *Cents field to major units, so EUR 5,000 never reads as EUR 500,000', () => {
    expect(policyAttributesFrom({ amountCents: 500_000 })).toEqual({ amount: 5000 });
    expect(policyAttributesFrom({ amount_cents: 250 })).toEqual({ amount: 2.5 });
    expect(policyAttributesFrom({ monthlyCapCents: 2000 })).toEqual({ amount: 20 });
  });

  it('prefers a plain major-unit amount over a cents field', () => {
    expect(policyAttributesFrom({ amount: 40, amountCents: 999_999 })).toEqual({ amount: 40 });
  });

  it('falls back to estimatedAmount in either casing', () => {
    expect(policyAttributesFrom({ estimatedAmount: 1200 })).toEqual({ amount: 1200 });
    expect(policyAttributesFrom({ estimated_amount: 1200 })).toEqual({ amount: 1200 });
  });

  it('counts recipients from a recipients or to array, and from a single string', () => {
    expect(policyAttributesFrom({ recipients: ['a@example.com', 'b@example.com'] })).toEqual({ recipients: 2 });
    expect(policyAttributesFrom({ to: ['a@example.com'] })).toEqual({ recipients: 1 });
    expect(policyAttributesFrom({ to: 'a@example.com' })).toEqual({ recipients: 1 });
    expect(policyAttributesFrom({ recipients: [] })).toEqual({ recipients: 0 });
  });

  it('reads confidence only when it is a number', () => {
    expect(policyAttributesFrom({ confidence: 0.92 })).toEqual({ confidence: 0.92 });
    expect(policyAttributesFrom({ confidence: 'high' })).toEqual({});
  });

  it('never throws and never guesses on any other shape', () => {
    expect(policyAttributesFrom(null)).toEqual({});
    expect(policyAttributesFrom(undefined)).toEqual({});
    expect(policyAttributesFrom('a string payload')).toEqual({});
    expect(policyAttributesFrom('{"amount":9000}')).toEqual({});
    expect(policyAttributesFrom(42)).toEqual({});
    expect(policyAttributesFrom([{ amount: 5 }])).toEqual({});
    expect(policyAttributesFrom({
      amount: 'a lot',
      amountCents: null,
      recipients: 7,
      recipient: '',
      confidence: [0.9],
      estimatedAmount: Number.NaN
    })).toEqual({});
    expect(policyAttributesFrom({ amount: Number.POSITIVE_INFINITY })).toEqual({});
  });
});

describe('numeric policy conditions', () => {
  it('matches a require_approval rule when the amount is within the bound', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Ask first over 5k', actionPattern: 'action:invoice.create',
      effect: 'require_approval', conditions: { maxAmount: 5000 }
    });
    const decision = await evaluate(database, { amount: 4000, recipients: 1 });
    expect(decision.effect).toBe('require_approval');
    expect(decision.policyName).toBe('Ask first over 5k');
  });

  it('does not match when the amount exceeds the bound', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Ask first over 5k', actionPattern: 'action:invoice.create',
      effect: 'require_approval', conditions: { maxAmount: 5000 }
    });
    const decision = await evaluate(database, { amount: 6000, recipients: 1 });
    expect(decision.policyId).toBeNull();
    expect(decision.policyName).toBe('Built-in external-write boundary');
  });

  // Fail closed: we could not prove the action is small enough to be safe.
  it('matches a restrictive rule when the attribute cannot be determined at all', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Ask first over 5k', actionPattern: 'action:invoice.create',
      effect: 'require_approval', conditions: { maxAmount: 5000 }
    });
    expect((await evaluate(database, {})).policyName).toBe('Ask first over 5k');
    expect((await evaluate(database)).policyName).toBe('Ask first over 5k');

    await database.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
    await insertPolicy(database, {
      name: 'Never over 5k', actionPattern: 'action:invoice.create',
      effect: 'deny', conditions: { maxAmount: 5000 }
    });
    const denied = await evaluate(database, {});
    expect(denied.effect).toBe('deny');
    expect(denied.policyName).toBe('Never over 5k');
  });

  // Fail closed the other way: never auto-allow on an unknown.
  it('does not match a permissive rule when the attribute cannot be determined', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Auto-send under 5k', actionPattern: 'action:invoice.create',
      effect: 'allow', conditions: { maxAmount: 5000 }
    });
    const unknown = await evaluate(database, {});
    expect(unknown.policyId).toBeNull();
    expect(unknown.effect).toBe('require_approval');

    const known = await evaluate(database, { amount: 4000 });
    expect(known.effect).toBe('allow');
    expect(known.policyName).toBe('Auto-send under 5k');
  });

  it('applies minConfidence in both directions', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Only when sure', actionPattern: 'action:invoice.create',
      effect: 'allow', conditions: { minConfidence: 0.9 }
    });
    expect((await evaluate(database, { confidence: 0.95 })).policyName).toBe('Only when sure');
    expect((await evaluate(database, { confidence: 0.5 })).policyId).toBeNull();
  });

  it('applies maxRecipients in both directions', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Small blasts only', actionPattern: 'action:invoice.create',
      effect: 'allow', conditions: { maxRecipients: 3 }
    });
    expect((await evaluate(database, { recipients: 2 })).policyName).toBe('Small blasts only');
    expect((await evaluate(database, { recipients: 9 })).policyId).toBeNull();
  });

  it('treats an unset bound as no constraint at all', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Any amount', actionPattern: 'action:invoice.create',
      effect: 'allow', conditions: { maxAmount: null }
    });
    expect((await evaluate(database, {})).policyName).toBe('Any amount');
  });
});
