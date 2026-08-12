import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  AgentBudgetError,
  assertAgentBudgetAvailable,
  estimateCostCents,
  getAgentBudget,
  recordAgentModelCall,
  setAgentBudget,
  unreportedUsageFloorCents
} from './budget.js';

let db: Db;

// Own workspace, own rows. The container outlives a single test file and other
// files clean only what they created.
const WORKSPACE_ID = 'ws_budget_test';
const USER_ID = 'usr_budget_test';

function monthStartUtc(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function lastMonthUtc(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 15)).toISOString();
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'Budget Test', new Date().toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(USER_ID, WORKSPACE_ID, 'budget@test.example', 'Budget Tester', new Date().toISOString());
  await db.prepare('DELETE FROM workspace_agent_budget WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM agent_model_calls WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

async function budgetRowCount(): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*)::int AS total FROM workspace_agent_budget WHERE workspace_id=?')
    .get<{ total: number }>(WORKSPACE_ID);
  return row?.total ?? 0;
}

async function storedSpent(): Promise<{ spent_cents: number; period_start: string }> {
  const row = await db
    .prepare(
      `SELECT spent_cents, TO_CHAR(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_start
       FROM workspace_agent_budget WHERE workspace_id=?`
    )
    .get<{ spent_cents: number; period_start: string }>(WORKSPACE_ID);
  if (!row) throw new Error('no budget row');
  return row;
}

describe('getAgentBudget', () => {
  it('reports the defaults for a workspace that never configured one, and creates nothing', async () => {
    // Section 5: default off. A stored key does not imply consent to spend it,
    // so asking about the budget must not manufacture one.
    const state = await getAgentBudget(db, WORKSPACE_ID);
    expect(state.monthlyCapCents).toBe(2000);
    expect(state.spentCents).toBe(0);
    expect(state.enabled).toBe(false);
    expect(state.workspaceId).toBe(WORKSPACE_ID);
    expect(Number.isNaN(Date.parse(state.periodStart))).toBe(false);

    expect(await budgetRowCount()).toBe(0);
  });
});

describe('assertAgentBudgetAvailable', () => {
  it('refuses by default, in words a founder can act on', async () => {
    const error = await assertAgentBudgetAvailable(db, WORKSPACE_ID).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentBudgetError);
    expect((error as AgentBudgetError).code).toBe('disabled');
    expect((error as AgentBudgetError).message).toBe('Agent spending is off. Turn it on in Setup.');
    expect(await budgetRowCount()).toBe(0);
  });

  it('passes once the switch is on and there is budget left', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);

    const state = await assertAgentBudgetAvailable(db, WORKSPACE_ID);
    expect(state.enabled).toBe(true);
    expect(state.monthlyCapCents).toBe(2000);
    expect(state.spentCents).toBe(0);
    expect(state.periodStart).toBe(monthStartUtc());
  });

  it('refuses once the month is spent, and says what the cap was', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true, monthlyCapCents: 2000 }, USER_ID);
    await db.prepare('UPDATE workspace_agent_budget SET spent_cents=? WHERE workspace_id=?').run(2000, WORKSPACE_ID);

    const error = await assertAgentBudgetAvailable(db, WORKSPACE_ID).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentBudgetError);
    expect((error as AgentBudgetError).code).toBe('cap_reached');
    expect((error as AgentBudgetError).message).toBe("This month's $20.00 agent budget is spent.");
  });

  it('turning the switch off stops it instantly, whatever is left in the budget', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);
    await setAgentBudget(db, WORKSPACE_ID, { enabled: false }, USER_ID);

    await expect(assertAgentBudgetAvailable(db, WORKSPACE_ID)).rejects.toMatchObject({ code: 'disabled' });
  });
});

describe('setAgentBudget', () => {
  it('leaves the field it was not given alone', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { monthlyCapCents: 500 }, USER_ID);
    const state = await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);
    expect(state.monthlyCapCents).toBe(500);
    expect(state.enabled).toBe(true);
  });

  it('writes an audit event, so raising a cap is findable afterwards', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true, monthlyCapCents: 5000 }, USER_ID);
    const row = await db
      .prepare(
        'SELECT actor_type, actor_id, event_type, entity_type, entity_id, metadata_json FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1'
      )
      .get<Record<string, string>>(WORKSPACE_ID);
    expect(row?.event_type).toBe('agent_budget.updated');
    expect(row?.entity_type).toBe('agent_budget');
    expect(row?.entity_id).toBe(WORKSPACE_ID);
    expect(row?.actor_type).toBe('user');
    expect(row?.actor_id).toBe(USER_ID);
    expect(JSON.parse(row?.metadata_json ?? '{}')).toMatchObject({ monthlyCapCents: 5000, enabled: true });
  });
});

describe('recordAgentModelCall', () => {
  it('logs the call and charges exactly the estimated cost', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);
    const expected = estimateCostCents('gpt-4o', 1_000_000, 100_000);
    expect(expected).toBe(350);

    const result = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_not_a_foreign_key',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 100_000
    });

    expect(result.costCents).toBe(expected);
    expect(result.budget.spentCents).toBe(expected);
    expect(result.budget.monthlyCapCents).toBe(2000);
    expect(result.budget.enabled).toBe(true);

    const call = await db
      .prepare(
        'SELECT run_id, model, prompt_tokens, completion_tokens, cost_cents FROM agent_model_calls WHERE workspace_id=?'
      )
      .all<Record<string, unknown>>(WORKSPACE_ID);
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({
      run_id: 'run_not_a_foreign_key',
      model: 'gpt-4o',
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      cost_cents: expected
    });
    expect((await storedSpent()).spent_cents).toBe(expected);
  });

  it('loses neither of two calls landing at the same moment', async () => {
    // Two worker cycles charging the same workspace concurrently. A
    // read-then-write increment would drop one of them and undercount spend.
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);
    const unit = estimateCostCents('gpt-4o', 1_000_000, 0);

    const [first, second] = await Promise.all([
      recordAgentModelCall(db, {
        workspaceId: WORKSPACE_ID,
        runId: 'run_a',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 0
      }),
      recordAgentModelCall(db, {
        workspaceId: WORKSPACE_ID,
        runId: 'run_b',
        model: 'gpt-4o',
        promptTokens: 1_000_000,
        completionTokens: 0
      })
    ]);

    expect(first.costCents).toBe(unit);
    expect(second.costCents).toBe(unit);
    expect((await storedSpent()).spent_cents).toBe(unit * 2);

    const rows = await db
      .prepare('SELECT COUNT(*)::int AS total FROM agent_model_calls WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(rows?.total).toBe(2);
  });

  it('creates the row on first charge even when nobody configured a budget', async () => {
    const result = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: null,
      model: 'gpt-4o-mini',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000
    });
    expect(result.budget.spentCents).toBe(result.costCents);
    expect(result.budget.enabled).toBe(false);
    expect(await budgetRowCount()).toBe(1);
  });
});

/**
 * The provider that reports nothing.
 *
 * Section 4's own caveat about OpenAI-compatible shims: plenty of them answer
 * with no `usage` block at all. Charged as zero, such an endpoint is free
 * forever -- spend never grows, the pre-flight never fires, and the cap is
 * decorative. "Absent" and "reported as zero" are different claims and only the
 * second one is trustworthy, so only the second one is charged zero.
 */
describe('a provider that does not report usage', () => {
  it('charges a floor instead of nothing, and says so on the row', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);

    const result = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_no_usage',
      model: 'gpt-4o',
      promptTokens: null,
      completionTokens: null
    });

    expect(result.usageReported).toBe(false);
    expect(result.costCents).toBe(unreportedUsageFloorCents('gpt-4o'));
    expect(result.costCents).toBeGreaterThan(0);
    expect(result.budget.spentCents).toBe(result.costCents);

    const call = await db
      .prepare(
        'SELECT prompt_tokens, completion_tokens, cost_cents, usage_reported FROM agent_model_calls WHERE workspace_id=?'
      )
      .get<Record<string, unknown>>(WORKSPACE_ID);
    // The counts are stored as 0 and that is only honest because the flag beside
    // them says they are absent rather than measured -- which is the sentence a
    // founder asking "why did this cost that" is owed.
    expect(call).toMatchObject({
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_cents: result.costCents,
      usage_reported: false
    });
  });

  it('charges the floor when only one of the two counts is missing', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);

    const half = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_half_usage',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: null
    });

    // A prompt count without a completion count is still an unpriceable call.
    expect(half.usageReported).toBe(false);
    expect(half.costCents).toBe(unreportedUsageFloorCents('gpt-4o'));
  });

  it('treats a garbage count as unreported, not as zero', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);

    const nan = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_nan_usage',
      model: 'gpt-4o',
      promptTokens: Number.NaN,
      completionTokens: Number.POSITIVE_INFINITY
    });

    expect(nan.usageReported).toBe(false);
    expect(nan.costCents).toBe(unreportedUsageFloorCents('gpt-4o'));
  });

  /**
   * A zero prompt count is a shrug, not a report.
   *
   * This test used to assert the opposite -- that `{prompt_tokens: 0}` was a
   * provider genuinely reporting a free call -- and that assertion was the hole:
   * an endpoint sending a zeroed usage block was charged nothing forever, so the
   * cap never bound. A completed chat call cannot have consumed zero prompt
   * tokens; the system prompt alone is ~150.
   */
  it('charges the floor when the provider reports a zero prompt count', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true }, USER_ID);

    const zero = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_zero_usage',
      model: 'gpt-4o',
      promptTokens: 0,
      completionTokens: 0
    });

    expect(zero.usageReported).toBe(false);
    expect(zero.costCents).toBe(unreportedUsageFloorCents('gpt-4o'));

    const call = await db
      .prepare('SELECT usage_reported FROM agent_model_calls WHERE workspace_id=?')
      .get<{ usage_reported: boolean }>(WORKSPACE_ID);
    expect(call?.usage_reported).toBe(false);
  });

  /**
   * THE property. Not "the floor is some number" but "a cap bounds how many
   * unmetered calls can happen before the agent is refused", which is the only
   * thing that makes an unmetered endpoint safe to point this at.
   */
  it('lets a $20 cap bound unmetered calls to a predictable, small number', async () => {
    const CAP_CENTS = 2000;
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true, monthlyCapCents: CAP_CENTS }, USER_ID);

    const floor = unreportedUsageFloorCents('gpt-4o');
    const expectedCalls = Math.ceil(CAP_CENTS / floor);
    expect(expectedCalls).toBeLessThanOrEqual(200);

    let calls = 0;
    for (;;) {
      try {
        await assertAgentBudgetAvailable(db, WORKSPACE_ID);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentBudgetError);
        expect((error as AgentBudgetError).code).toBe('cap_reached');
        break;
      }
      await recordAgentModelCall(db, {
        workspaceId: WORKSPACE_ID,
        runId: 'run_unmetered',
        model: 'gpt-4o',
        promptTokens: null,
        completionTokens: null
      });
      calls += 1;
      // Guards the test itself against the bug it exists to catch: if the floor
      // ever goes back to 0 this loop would otherwise never terminate.
      expect(calls).toBeLessThanOrEqual(expectedCalls);
    }

    expect(calls).toBe(expectedCalls);
    expect((await storedSpent()).spent_cents).toBeGreaterThanOrEqual(CAP_CENTS);
  });
});

describe('unreportedUsageFloorCents', () => {
  it('is never zero, for any model, known or not', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'llama-3.3-70b', 'some-shim-nobody-shipped-yet']) {
      expect(unreportedUsageFloorCents(model), model).toBeGreaterThan(0);
      // The bound the cap depends on, restated per model: $20 buys at most this
      // many calls from an endpoint that reports nothing.
      expect(Math.ceil(2000 / unreportedUsageFloorCents(model)), model).toBeLessThanOrEqual(200);
    }
  });

  it('costs more than a call that genuinely reported no tokens', () => {
    expect(unreportedUsageFloorCents('gpt-4o')).toBeGreaterThan(estimateCostCents('gpt-4o', 0, 0));
  });
});

describe('period rollover', () => {
  it('a new calendar month zeroes the spend and lets the agent run again', async () => {
    await setAgentBudget(db, WORKSPACE_ID, { enabled: true, monthlyCapCents: 2000 }, USER_ID);
    await db
      .prepare('UPDATE workspace_agent_budget SET spent_cents=?, period_start=? WHERE workspace_id=?')
      .run(9_999, lastMonthUtc(), WORKSPACE_ID);

    // Last month's overspend must not block this month.
    const preflight = await assertAgentBudgetAvailable(db, WORKSPACE_ID);
    expect(preflight.spentCents).toBe(0);
    expect(preflight.periodStart).toBe(monthStartUtc());

    const charged = await recordAgentModelCall(db, {
      workspaceId: WORKSPACE_ID,
      runId: 'run_after_rollover',
      model: 'gpt-4o',
      promptTokens: 1_000_000,
      completionTokens: 0
    });

    // The roll happened in the incrementing statement itself: the old spend is
    // gone and only this call is charged.
    expect(charged.budget.spentCents).toBe(charged.costCents);
    expect(charged.budget.periodStart).toBe(monthStartUtc());

    const stored = await storedSpent();
    expect(stored.spent_cents).toBe(charged.costCents);
    expect(stored.period_start).toBe(monthStartUtc());
  });
});

describe('estimateCostCents', () => {
  it('never charges zero for a call that spent tokens, including a model it has never heard of', async () => {
    // A model that rounds to zero is a model that never reaches the cap.
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'llama-3.3-70b', 'some-model-nobody-shipped-yet']) {
      expect(estimateCostCents(model, 1, 0)).toBeGreaterThanOrEqual(1);
      expect(estimateCostCents(model, 0, 1)).toBeGreaterThanOrEqual(1);
    }
    // Zero in, zero out, zero cents -- and that is correct HERE, because a
    // caller reaching this function has real counts to price and zero means the
    // provider reported a free call. It is emphatically not the answer for a
    // provider that reported nothing at all: "absent" is a different claim, it
    // is knowable only where the call is recorded, and
    // `recordAgentModelCall` charges `unreportedUsageFloorCents` for it there.
    // See the suite above, which is what stops an unmetered endpoint from being
    // free forever.
    expect(estimateCostCents('gpt-4o', 0, 0)).toBe(0);
  });

  it('prices an unknown model above every known one, so a surprise id caps early', async () => {
    const unknown = estimateCostCents('mystery-v9', 1_000_000, 1_000_000);
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'llama-3.3-70b']) {
      expect(unknown).toBeGreaterThan(estimateCostCents(model, 1_000_000, 1_000_000));
    }
  });

  it('does not price the mini variant as the full model', async () => {
    expect(estimateCostCents('gpt-4o-mini-2024-07-18', 1_000_000, 0)).toBe(15);
    expect(estimateCostCents('gpt-4o-2024-08-06', 1_000_000, 0)).toBe(250);
  });
});
