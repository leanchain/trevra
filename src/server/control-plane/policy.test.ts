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
  input: {
    name: string;
    actionPattern: string;
    effect: PolicyEffect;
    conditions: Record<string, unknown>;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .prepare(
      `
      INSERT INTO workspace_policies (
        id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `
    )
    .run(
      id('pol'),
      DEMO_WORKSPACE_ID,
      input.name,
      100,
      input.actionPattern,
      input.effect,
      JSON.stringify(input.conditions),
      true,
      now,
      now
    );
}

function evaluate(database: Db, attributes?: Record<string, unknown>) {
  return evaluatePolicy(database, {
    workspaceId: DEMO_WORKSPACE_ID,
    action: 'action:email.send',
    actorType: 'agent',
    sideEffect: 'external-write',
    ...(attributes === undefined ? {} : { attributes })
  });
}

describe('policyAttributesFrom', () => {
  it('counts recipients and preserves numeric confidence for GTM execution', () => {
    expect(
      policyAttributesFrom({
        recipient: 'buyer@example.com',
        subject: 'Audit result',
        body: 'The audit is ready.',
        confidence: 0.92
      })
    ).toEqual({ recipients: 1, confidence: 0.92 });
    expect(policyAttributesFrom({ recipients: ['a@example.com', 'b@example.com'] })).toEqual({
      recipients: 2
    });
    expect(policyAttributesFrom({ to: ['a@example.com'] })).toEqual({ recipients: 1 });
    expect(policyAttributesFrom({ to: 'a@example.com' })).toEqual({ recipients: 1 });
    expect(policyAttributesFrom({ recipients: [] })).toEqual({ recipients: 0 });
  });

  it('deliberately ignores customer-money fields', () => {
    expect(
      policyAttributesFrom({
        recipient: 'lead@example.com',
        amount: 2400,
        amountCents: 240_000,
        estimatedAmount: 1200,
        currency: 'USD'
      })
    ).toEqual({ recipients: 1 });
  });

  it('determines nothing from a community reply with no recipient or confidence', () => {
    expect(
      policyAttributesFrom({
        platform: 'reddit',
        threadExternalId: 't3_abc',
        body: 'Here is what we found.'
      })
    ).toEqual({});
  });

  it('never throws or guesses on malformed/non-object shapes', () => {
    expect(policyAttributesFrom(null)).toEqual({});
    expect(policyAttributesFrom(undefined)).toEqual({});
    expect(policyAttributesFrom('a string payload')).toEqual({});
    expect(policyAttributesFrom(42)).toEqual({});
    expect(policyAttributesFrom([{ recipient: 'x@example.com' }])).toEqual({});
    expect(policyAttributesFrom({ recipients: 7, recipient: '', confidence: 'high' })).toEqual({});
  });
});

describe('GTM numeric policy conditions', () => {
  it('applies minConfidence in both directions', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Only when sure',
      actionPattern: 'action:email.send',
      effect: 'allow',
      conditions: { minConfidence: 0.9 }
    });
    expect((await evaluate(database, { confidence: 0.95, recipients: 1 })).policyName).toBe(
      'Only when sure'
    );
    expect((await evaluate(database, { confidence: 0.5, recipients: 1 })).policyId).toBeNull();
  });

  it('applies maxRecipients in both directions', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Small sends only',
      actionPattern: 'action:email.send',
      effect: 'allow',
      conditions: { maxRecipients: 3 }
    });
    expect((await evaluate(database, { recipients: 2 })).policyName).toBe('Small sends only');
    expect((await evaluate(database, { recipients: 9 })).policyId).toBeNull();
  });

  it('fails closed for restrictive rules when the required GTM attribute is unknown', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Require confidence',
      actionPattern: 'action:email.send',
      effect: 'require_approval',
      conditions: { minConfidence: 0.9 }
    });
    const decision = await evaluate(database, { recipients: 1 });
    expect(decision.effect).toBe('require_approval');
    expect(decision.policyName).toBe('Require confidence');
  });

  it('never auto-allows when a permissive rule depends on an unknown GTM attribute', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Auto only when sure',
      actionPattern: 'action:email.send',
      effect: 'allow',
      conditions: { minConfidence: 0.9 }
    });
    const decision = await evaluate(database, { recipients: 1 });
    expect(decision.policyId).toBeNull();
    expect(decision.effect).toBe('require_approval');
    expect(decision.policyName).toBe('Built-in external-write boundary');
  });

  it('treats an unset GTM bound as no constraint', async () => {
    const database = await openTestDb();
    await insertPolicy(database, {
      name: 'Any recipient count',
      actionPattern: 'action:email.send',
      effect: 'allow',
      conditions: { maxRecipients: null }
    });
    expect((await evaluate(database, {})).policyName).toBe('Any recipient count');
  });
});
