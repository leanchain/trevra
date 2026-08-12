import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { openDatabase, type Db } from '../db.js';
import { setAgentBudget } from './budget.js';
import { STALE_RUN_ERROR, STALE_RUN_MINUTES, listAgentRuns, reapStaleAgentRuns } from './runs.js';
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_SCHEDULE_GOAL,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  claimDueAgentSchedules,
  getAgentSchedule,
  hasRunningAgentRun,
  runDueAgentSchedules,
  setAgentSchedule
} from './schedule.js';

/**
 * The transport is the only thing faked, and only per workspace.
 *
 * A workspace with no installed double falls through to the REAL
 * `resolveWorkspaceModel`, which returns null for a workspace that never set
 * BYOK up -- that is what makes "this workspace is broken" a genuine failure
 * below rather than a stub pretending to be one. No network either way.
 */
const installed = vi.hoisted(() => ({ models: new Map<string, LanguageModelV4>() }));

vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  return {
    ...actual,
    resolveWorkspaceModel: async (db: never, workspaceId: string) => {
      const model = installed.models.get(workspaceId);
      if (!model) return actual.resolveWorkspaceModel(db, workspaceId);
      return { model, modelId: MODEL_ID, baseUrl: 'https://model.invalid/v1' };
    }
  };
});

let db: Db;

// Own workspaces, own rows. The container outlives a single test file.
const WS_OK = 'ws_schedule_ok';
const WS_BROKEN = 'ws_schedule_broken';
const WS_CAPPED = 'ws_schedule_capped';
const WS_BUSY = 'ws_schedule_busy';
const WORKSPACES = [WS_OK, WS_BROKEN, WS_CAPPED, WS_BUSY] as const;
const USER_ID = 'usr_schedule_test';
const MODEL_ID = 'gpt-4o-mini';

function usage(inputTokens: number, outputTokens: number): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
  };
}

function answer(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(1000, 200),
    warnings: []
  };
}

function installModel(workspaceId: string, text: string): void {
  installed.models.set(workspaceId, new MockLanguageModelV4({ modelId: MODEL_ID, doGenerate: [answer(text)] }));
}

/** Move a schedule's window into the past, so the next sweep is deterministic. */
async function makeDue(workspaceId: string): Promise<void> {
  await db
    .prepare("UPDATE workspace_agent_schedule SET next_run_at = now() - INTERVAL '1 minute' WHERE workspace_id=?")
    .run(workspaceId);
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  installed.models.clear();
  for (const workspaceId of WORKSPACES) {
    // Dropping the workspace cascades the schedule, the budget and the ledger,
    // so every test starts from nothing regardless of order.
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(workspaceId, `Schedule test ${workspaceId}`, new Date().toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(USER_ID, WS_OK, 'schedule@test.example', 'Schedule Tester', new Date().toISOString());

  // runDueAgentSchedules is deliberately GLOBAL -- it sweeps every workspace on
  // the box. Other test files share this container and leave workspaces behind,
  // so park anything that is not ours; otherwise this file's counts would
  // describe somebody else's fixtures.
  await db
    .prepare('UPDATE workspace_agent_schedule SET enabled=FALSE WHERE workspace_id NOT IN (?,?,?,?)')
    .run(...WORKSPACES);
});

describe('setAgentSchedule', () => {
  it('is off until somebody turns it on, and leaves untouched fields alone', async () => {
    // Autonomous spend is opt in twice: the budget's switch, and this one.
    expect(await getAgentSchedule(db, WS_OK)).toBeNull();

    const created = await setAgentSchedule(db, WS_OK, {}, USER_ID);
    expect(created).toMatchObject({
      workspaceId: WS_OK,
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      lastRunAt: null
    });
    expect(created.goal).toBe(DEFAULT_SCHEDULE_GOAL);

    // Due by the clock, and still not claimed, because it is off.
    await makeDue(WS_OK);
    expect(await claimDueAgentSchedules(db)).toEqual([]);

    await setAgentSchedule(db, WS_OK, { intervalMinutes: 60, goal: 'Look at the overdue invoices' }, USER_ID);
    const on = await setAgentSchedule(db, WS_OK, { enabled: true }, USER_ID);
    expect(on.enabled).toBe(true);
    expect(on.intervalMinutes).toBe(60);
    expect(on.goal).toBe('Look at the overdue invoices');
  });

  it('refuses a cadence outside the window, and writes nothing when it does', async () => {
    await expect(setAgentSchedule(db, WS_OK, { intervalMinutes: MIN_INTERVAL_MINUTES - 1 }))
      .rejects.toThrow(/between 15 and 10080/);
    await expect(setAgentSchedule(db, WS_OK, { intervalMinutes: MAX_INTERVAL_MINUTES + 1 }))
      .rejects.toThrow(/between 15 and 10080/);
    await expect(setAgentSchedule(db, WS_OK, { intervalMinutes: 90.5 })).rejects.toThrow();
    expect(await getAgentSchedule(db, WS_OK)).toBeNull();

    await expect(setAgentSchedule(db, WS_OK, { intervalMinutes: MIN_INTERVAL_MINUTES }))
      .resolves.toMatchObject({ intervalMinutes: MIN_INTERVAL_MINUTES });
    await expect(setAgentSchedule(db, WS_OK, { intervalMinutes: MAX_INTERVAL_MINUTES }))
      .resolves.toMatchObject({ intervalMinutes: MAX_INTERVAL_MINUTES });
  });

  it('records the change so turning unattended spending on is findable afterwards', async () => {
    await setAgentSchedule(db, WS_OK, { enabled: true, intervalMinutes: 720 }, USER_ID);
    const row = await db
      .prepare(
        'SELECT actor_type, actor_id, event_type, entity_id, metadata_json FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1'
      )
      .get<Record<string, string>>(WS_OK);
    expect(row?.event_type).toBe('agent_schedule.updated');
    expect(row?.entity_id).toBe(WS_OK);
    expect(row?.actor_type).toBe('user');
    expect(row?.actor_id).toBe(USER_ID);
    expect(JSON.parse(row?.metadata_json ?? '{}')).toMatchObject({ enabled: true, intervalMinutes: 720 });
  });
});

describe('claimDueAgentSchedules', () => {
  it('hands each due workspace to exactly one sweep, whatever else is sweeping', async () => {
    // Two worker replicas starting a cycle at the same instant is the normal
    // case, not the exotic one. Both must not run the same workspace.
    for (const workspaceId of WORKSPACES) {
      await setAgentSchedule(db, workspaceId, { enabled: true, intervalMinutes: MIN_INTERVAL_MINUTES });
      await makeDue(workspaceId);
    }

    const sweeps = await Promise.all([
      claimDueAgentSchedules(db),
      claimDueAgentSchedules(db),
      claimDueAgentSchedules(db)
    ]);
    const claimed = sweeps.flat().map((schedule) => schedule.workspaceId);

    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...WORKSPACES].sort());

    // The claim is also the lease: nothing is due again straight afterwards.
    expect(await claimDueAgentSchedules(db)).toEqual([]);
  });

  it('leaves a schedule alone until its window, and never claims a disabled one', async () => {
    await setAgentSchedule(db, WS_OK, { enabled: true, intervalMinutes: 60 });
    await db
      .prepare("UPDATE workspace_agent_schedule SET next_run_at = now() + INTERVAL '1 hour' WHERE workspace_id=?")
      .run(WS_OK);

    await setAgentSchedule(db, WS_CAPPED, { enabled: false, intervalMinutes: 60 });
    await makeDue(WS_CAPPED);

    expect(await claimDueAgentSchedules(db)).toEqual([]);

    // Two hours later the enabled one is due; the disabled one is due by the
    // clock and still never claimed.
    const claimed = await claimDueAgentSchedules(db, new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(claimed.map((schedule) => schedule.workspaceId)).toEqual([WS_OK]);
    expect(claimed[0]?.lastRunAt).not.toBeNull();
  });

  it('skips a missed window instead of replaying it', async () => {
    // A worker that was down for a week must not wake up and fire seven days of
    // identical unattended runs at the operator's key.
    await setAgentSchedule(db, WS_OK, { enabled: true, intervalMinutes: 1440 });
    await db
      .prepare("UPDATE workspace_agent_schedule SET next_run_at = now() - INTERVAL '7 days' WHERE workspace_id=?")
      .run(WS_OK);

    expect((await claimDueAgentSchedules(db)).map((schedule) => schedule.workspaceId)).toEqual([WS_OK]);
    expect(await claimDueAgentSchedules(db)).toEqual([]);

    const after = await getAgentSchedule(db, WS_OK);
    expect(Date.parse(after!.nextRunAt)).toBeGreaterThan(Date.now());
  });
});

describe('runDueAgentSchedules', () => {
  it('runs every due workspace, and one broken workspace does not end the cycle', async () => {
    installModel(WS_OK, 'Read the brief. Nothing needs a human today.');
    await setAgentBudget(db, WS_OK, { enabled: true });
    // Budget on, but no model endpoint and no key: a real, non-budget failure.
    await setAgentBudget(db, WS_BROKEN, { enabled: true });
    // WS_CAPPED keeps the default budget -- off -- which is the refusal path.

    for (const workspaceId of [WS_CAPPED, WS_BROKEN, WS_OK]) {
      await setAgentSchedule(db, workspaceId, { enabled: true, goal: `Nightly review for ${workspaceId}` });
      await makeDue(workspaceId);
    }

    expect(await runDueAgentSchedules(db)).toBe(1);

    const ran = await listAgentRuns(db, WS_OK, {});
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({
      trigger: 'schedule',
      status: 'completed',
      goal: `Nightly review for ${WS_OK}`
    });

    // Both failures predate a run row, so neither leaves a half-written one.
    expect(await listAgentRuns(db, WS_BROKEN, {})).toHaveLength(0);
    expect(await listAgentRuns(db, WS_CAPPED, {})).toHaveLength(0);

    // A budget refusal is an ordinary outcome: the schedule stays on, so a
    // capped month resumes by itself when the month rolls over.
    const capped = await getAgentSchedule(db, WS_CAPPED);
    expect(capped?.enabled).toBe(true);
    expect(Date.parse(capped!.nextRunAt)).toBeGreaterThan(Date.now());

    // Every claimed workspace was stamped, including the ones that failed --
    // otherwise a broken workspace would be retried on every single cycle.
    const broken = await getAgentSchedule(db, WS_BROKEN);
    expect(Date.parse(broken!.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it('skips a workspace whose previous run is still going', async () => {
    installModel(WS_BUSY, 'This must never run.');
    await setAgentBudget(db, WS_BUSY, { enabled: true });
    await db.prepare(`
      INSERT INTO agent_runs (id, workspace_id, trigger, status, goal, step_count, max_steps)
      VALUES (?,?,?,?,?,?,?)
    `).run('arun_schedule_busy', WS_BUSY, 'schedule', 'running', 'the previous cadence', 0, 12);

    await setAgentSchedule(db, WS_BUSY, { enabled: true, goal: 'the next cadence' });
    await makeDue(WS_BUSY);

    expect(await runDueAgentSchedules(db)).toBe(0);

    const runs = await listAgentRuns(db, WS_BUSY, {});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.goal).toBe('the previous cadence');

    // Claimed and skipped, not left due: a slow run must not make the worker
    // re-examine this workspace on every cycle until it ends.
    const schedule = await getAgentSchedule(db, WS_BUSY);
    expect(Date.parse(schedule!.nextRunAt)).toBeGreaterThan(Date.now());
  });
});

/**
 * The regression that matters.
 *
 * A worker that is rolled, OOM-killed or SIGKILLed mid-run leaves its row in
 * `running` with no process anywhere that will ever finish it. The skip above
 * then fired on EVERY subsequent cycle -- this workspace's autopilot was dead
 * permanently, from one ordinary deploy at the wrong moment, with nothing in
 * the product to press. This proves the reaper unsticks it without a human.
 */
describe('a run nothing is advancing any more', () => {
  it('wedges the schedule until it is reaped, and never again after', async () => {
    installModel(WS_BUSY, 'Read the brief. Nothing needs a human today.');
    await setAgentBudget(db, WS_BUSY, { enabled: true });
    await db.prepare(`
      INSERT INTO agent_runs (id, workspace_id, trigger, status, goal, step_count, max_steps, started_at)
      VALUES (?,?,?,?,?,?,?, now() - make_interval(mins => ?::int))
    `).run(
      'arun_schedule_wedged', WS_BUSY, 'schedule', 'running',
      'the run the worker was killed in the middle of', 3, 12, STALE_RUN_MINUTES + 30
    );

    await setAgentSchedule(db, WS_BUSY, { enabled: true, goal: 'the next cadence' });

    // Two full cycles, two skips. Left alone this repeats forever.
    await makeDue(WS_BUSY);
    expect(await runDueAgentSchedules(db)).toBe(0);
    await makeDue(WS_BUSY);
    expect(await runDueAgentSchedules(db)).toBe(0);
    expect(await hasRunningAgentRun(db, WS_BUSY)).toBe(true);

    // What the worker does at the top of every cycle, before the sweep.
    expect(await reapStaleAgentRuns(db, { workspaceId: WS_BUSY })).toBe(1);
    expect(await hasRunningAgentRun(db, WS_BUSY)).toBe(false);

    // Claimable again, and it actually runs.
    await makeDue(WS_BUSY);
    expect(await runDueAgentSchedules(db)).toBe(1);

    const runs = await listAgentRuns(db, WS_BUSY, {});
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ goal: 'the next cadence', status: 'completed', trigger: 'schedule' });

    // The abandoned run is not quietly deleted or relabelled 'completed'. It
    // stays in the ledger saying what actually happened to it.
    const abandoned = runs.find((run) => run.id === 'arun_schedule_wedged');
    expect(abandoned).toMatchObject({ status: 'failed', error: STALE_RUN_ERROR });
    expect(abandoned?.finishedAt).not.toBeNull();
  });
});
