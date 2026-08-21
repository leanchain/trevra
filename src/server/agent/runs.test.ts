import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  STALE_RUN_ERROR,
  STALE_RUN_MINUTES,
  appendAgentRunStep,
  finishAgentRun,
  getAgentRun,
  isAgentRunStopRequested,
  listAgentRuns,
  reapStaleAgentRuns,
  startAgentRun,
  stopRunningAgentRuns
} from './runs.js';

let db: Db;
const WORKSPACE_ID = 'ws_agent_runs_test';
const OTHER_WORKSPACE_ID = 'ws_agent_runs_test_other';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    // The cascade from workspaces clears agent_runs and its steps, so every
    // test sees a ledger with only its own rows in it.
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, `Agent runs test ${workspaceId}`, new Date().toISOString());
  }
});

afterEach(async () => {
  await db?.close();
});

function start(overrides: Partial<Parameters<typeof startAgentRun>[1]> = {}) {
  return startAgentRun(db, {
    workspaceId: WORKSPACE_ID,
    trigger: 'manual',
    goal: 'Follow up the Acme proposal',
    maxSteps: 12,
    ...overrides
  });
}

describe('the run lifecycle', () => {
  it('starts running, records steps in order, and closes out', async () => {
    const run = await start();
    expect(run.status).toBe('running');
    expect(run.stepCount).toBe(0);
    expect(run.maxSteps).toBe(12);
    expect(run.summary).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.startedAt).toMatch(ISO_8601);

    const first = await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'model',
      input: { messages: 1 },
      output: { toolCall: 'trevra_gtm_brief' }
    });
    const second = await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'tool',
      toolName: 'trevra_gtm_brief',
      input: {},
      output: { recommendations: [] }
    });
    expect([first, second]).toEqual([1, 2]);

    await finishAgentRun(db, run.id, { status: 'completed', summary: 'Prepared one draft.' });

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    expect(loaded?.status).toBe('completed');
    expect(loaded?.summary).toBe('Prepared one draft.');
    expect(loaded?.error).toBeNull();
    expect(loaded?.stepCount).toBe(2);
    expect(loaded?.finishedAt).toMatch(ISO_8601);
    expect(loaded?.steps.map((step) => [step.seq, step.kind, step.toolName])).toEqual([
      [1, 'model', null],
      [2, 'tool', 'trevra_gtm_brief']
    ]);
    expect(loaded?.steps[1].input).toEqual({});
    expect(loaded?.steps[1].output).toEqual({ recommendations: [] });
    expect(loaded?.steps[0].createdAt).toMatch(ISO_8601);
  });

  it('records a failure with its error', async () => {
    const run = await start();
    await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'tool',
      toolName: 'trevra_get_run',
      error: 'Skill run not found'
    });
    await finishAgentRun(db, run.id, { status: 'failed', error: 'Skill run not found' });

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    expect(loaded?.status).toBe('failed');
    expect(loaded?.error).toBe('Skill run not found');
    expect(loaded?.steps[0].error).toBe('Skill run not found');
    // Nothing was passed for either payload, so nothing is invented for them.
    expect(loaded?.steps[0].input).toBeNull();
    expect(loaded?.steps[0].output).toBeNull();
  });

  it('will not reopen a run that is already closed', async () => {
    const run = await start();
    await finishAgentRun(db, run.id, { status: 'stopped', summary: 'Killed by the operator.' });
    await finishAgentRun(db, run.id, { status: 'completed', summary: 'All good, honest.' });

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    expect(loaded?.status).toBe('stopped');
    expect(loaded?.summary).toBe('Killed by the operator.');
  });

  it('refuses to append to a run that does not exist', async () => {
    await expect(
      appendAgentRunStep(db, {
        runId: 'arun_missing',
        workspaceId: WORKSPACE_ID,
        kind: 'model'
      })
    ).rejects.toThrow('Agent run not found: arun_missing');
  });
});

describe('appendAgentRunStep under concurrency', () => {
  it('hands every concurrent append its own sequence number', async () => {
    const run = await start();
    const seqs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendAgentRunStep(db, {
          runId: run.id,
          workspaceId: WORKSPACE_ID,
          kind: 'tool',
          toolName: `tool_${index}`,
          input: { index }
        })
      )
    );

    expect([...seqs].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(seqs).size).toBe(8);

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    // The denormalised counter and the rows cannot be allowed to disagree --
    // the bounded-loop ceiling is enforced from the counter.
    expect(loaded?.stepCount).toBe(8);
    expect(loaded?.steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('payload size', () => {
  it('truncates an oversized payload instead of putting it all in the ledger', async () => {
    const run = await start();
    const huge = 'x'.repeat(200_000);
    await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'tool',
      toolName: 'trevra_gtm_visibility-audit',
      input: { small: true },
      output: { page: huge }
    });

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    const output = loaded?.steps[0].output as {
      truncated?: boolean;
      originalLength?: number;
      preview?: string;
    };
    expect(output.truncated).toBe(true);
    expect(output.originalLength).toBeGreaterThan(200_000);
    expect(output.preview?.length).toBe(8 * 1024);
    // A payload under the cap is stored whole, not previewed.
    expect(loaded?.steps[0].input).toEqual({ small: true });
  });
});

describe('step duration', () => {
  it('stores a measured duration, and null for a step nothing timed', async () => {
    const run = await start();
    await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'model',
      durationMs: 1234.6
    });
    await appendAgentRunStep(db, {
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      kind: 'tool',
      toolName: 'trevra_list_skills'
    });

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    // Whole milliseconds: the column is INTEGER and the sub-ms tail is noise.
    expect(loaded?.steps[0].durationMs).toBe(1235);
    // Nothing measured the second step. It reads back as null, NOT as 0 --
    // 0 would claim the tool returned instantly, which nobody observed.
    expect(loaded?.steps[1].durationMs).toBeNull();
    expect(loaded?.steps[1].durationMs).not.toBe(0);
  });

  it('clamps a negative duration and records nothing for a non-finite one', async () => {
    const run = await start();
    for (const durationMs of [-42, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      await appendAgentRunStep(db, {
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        kind: 'tool',
        toolName: 'trevra_list_skills',
        durationMs
      });
    }

    const loaded = await getAgentRun(db, WORKSPACE_ID, run.id);
    // A clock that went backwards is clamped to 0 -- the step still happened.
    // A non-finite value has no number to clamp to, so it is not recorded at
    // all rather than becoming a 0 that reads as "instant".
    expect(loaded?.steps.map((step) => step.durationMs)).toEqual([0, null, null, null]);
  });
});

describe('reading the ledger', () => {
  it('lists a workspace newest first and honours a limit', async () => {
    const first = await start({ goal: 'first' });
    const second = await start({ goal: 'second' });
    const third = await start({ goal: 'third', trigger: 'schedule' });
    // CURRENT_TIMESTAMP can be identical for several inserts in the same
    // database transaction. Give this ordering test distinct times explicitly
    // so it tests "newest first" rather than depending on statement timing.
    for (const [runId, startedAt] of [
      [first.id, '2026-01-01T00:00:01Z'],
      [second.id, '2026-01-01T00:00:02Z'],
      [third.id, '2026-01-01T00:00:03Z']
    ] as const) {
      await db.prepare('UPDATE agent_runs SET started_at=? WHERE id=?').run(startedAt, runId);
    }
    await startAgentRun(db, {
      workspaceId: OTHER_WORKSPACE_ID,
      trigger: 'manual',
      goal: 'someone else',
      maxSteps: 3
    });

    const runs = await listAgentRuns(db, WORKSPACE_ID);
    expect(runs.map((run) => run.id)).toEqual([third.id, second.id, first.id]);
    expect(runs.map((run) => run.trigger)).toEqual(['schedule', 'manual', 'manual']);

    const limited = await listAgentRuns(db, WORKSPACE_ID, { limit: 2 });
    expect(limited.map((run) => run.id)).toEqual([third.id, second.id]);
  });

  it('does not read a run across a workspace boundary', async () => {
    const run = await start();
    expect(await getAgentRun(db, OTHER_WORKSPACE_ID, run.id)).toBeNull();
    expect(await getAgentRun(db, WORKSPACE_ID, 'arun_missing')).toBeNull();
  });
});

/**
 * The kill switch.
 *
 * BEHAVIOUR CHANGE, deliberate and demonstrated: the version of this suite that
 * shipped asserted that `stopRunningAgentRuns` set `status='stopped'` and
 * `finished_at` immediately. That assertion was the bug written down. The loop
 * runs in a different process, and marking the row terminal from the API did
 * not reach it: it appended its next step and charged 75 cents against a run
 * the ledger had already closed -- and `finishAgentRun` then refused to correct
 * the record, because the row was no longer `running`. A row is not a process.
 *
 * The switch now records a REQUEST and the runner records the OUTCOME.
 */
describe('stopRunningAgentRuns', () => {
  it('asks the running rows of one workspace to stop, and leaves them running', async () => {
    const running = await start({ goal: 'still going' });
    const alsoRunning = await start({ goal: 'also going' });
    const done = await start({ goal: 'already done' });
    await finishAgentRun(db, done.id, {
      status: 'completed',
      summary: 'finished before the switch'
    });
    const elsewhere = await startAgentRun(db, {
      workspaceId: OTHER_WORKSPACE_ID,
      trigger: 'schedule',
      goal: 'another tenant',
      maxSteps: 5
    });

    expect(await isAgentRunStopRequested(db, running.id)).toBe(false);
    expect(await stopRunningAgentRuns(db, WORKSPACE_ID)).toBe(2);

    // What the loop reads between steps. This is the whole mechanism.
    expect(await isAgentRunStopRequested(db, running.id)).toBe(true);
    expect(await isAgentRunStopRequested(db, alsoRunning.id)).toBe(true);

    // And the row still says 'running', because nothing has stopped yet. The
    // UI can say "stopping"; nothing may say "stopped" until the runner does.
    const asked = await getAgentRun(db, WORKSPACE_ID, running.id);
    expect(asked?.status).toBe('running');
    expect(asked?.finishedAt).toBeNull();
    expect(asked?.stopRequestedAt).toMatch(ISO_8601);

    const untouched = await getAgentRun(db, WORKSPACE_ID, done.id);
    expect(untouched?.status).toBe('completed');
    expect(untouched?.summary).toBe('finished before the switch');
    expect(untouched?.stopRequestedAt).toBeNull();

    // Another tenant's run is neither stopped nor asked to stop.
    expect((await getAgentRun(db, OTHER_WORKSPACE_ID, elsewhere.id))?.status).toBe('running');
    expect(await isAgentRunStopRequested(db, elsewhere.id)).toBe(false);

    // The runner sees the request and closes its own run out -- the only path
    // by which a run becomes 'stopped'.
    await finishAgentRun(db, running.id, { status: 'stopped', summary: 'Stopped when asked.' });
    const stopped = await getAgentRun(db, WORKSPACE_ID, running.id);
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.summary).toBe('Stopped when asked.');
    expect(stopped?.finishedAt).toMatch(ISO_8601);

    // Asking twice counts only what had not been asked, and does not move the
    // original timestamp -- "when did somebody ask" survives an impatient click.
    const before = (await getAgentRun(db, WORKSPACE_ID, alsoRunning.id))?.stopRequestedAt;
    expect(await stopRunningAgentRuns(db, WORKSPACE_ID)).toBe(0);
    expect((await getAgentRun(db, WORKSPACE_ID, alsoRunning.id))?.stopRequestedAt).toBe(before);
  });

  it('tells a loop to stop when its run is already over, or gone', async () => {
    const finished = await start();
    await finishAgentRun(db, finished.id, { status: 'completed', summary: 'done' });

    // Nobody pressed anything. Continuing would spend against a run the ledger
    // can no longer record, because finishAgentRun will not reopen it.
    expect(await isAgentRunStopRequested(db, finished.id)).toBe(true);
    // The workspace was deleted out from under the run: nobody to bill, nothing
    // to write to.
    expect(await isAgentRunStopRequested(db, 'arun_missing')).toBe(true);
  });
});

/** Age a run's start, so "long enough ago" is exact instead of slept for. */
async function age(runId: string, minutes: number): Promise<void> {
  await db
    .prepare('UPDATE agent_runs SET started_at = now() - make_interval(mins => ?::int) WHERE id=?')
    .run(minutes, runId);
}

describe('reapStaleAgentRuns', () => {
  it('writes off only the runs past the threshold', async () => {
    const stale = await start({ goal: 'abandoned by a worker that never came back' });
    const fresh = await start({ goal: 'genuinely still going' });
    const finished = await start({ goal: 'already done' });
    await finishAgentRun(db, finished.id, { status: 'completed', summary: 'fine' });
    await age(stale.id, STALE_RUN_MINUTES + 5);
    // Old AND terminal: age is not the test, being stuck in 'running' is.
    await age(finished.id, STALE_RUN_MINUTES + 5);

    expect(await reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID })).toBe(1);

    const reaped = await getAgentRun(db, WORKSPACE_ID, stale.id);
    expect(reaped?.status).toBe('failed');
    // Honest about what happened: the worker went away. The run did not fail,
    // and claiming the model failed would be inventing a cause.
    expect(reaped?.error).toBe(STALE_RUN_ERROR);
    expect(reaped?.finishedAt).toMatch(ISO_8601);

    // A run that started twenty minutes ago is a slow run, not a dead one.
    expect((await getAgentRun(db, WORKSPACE_ID, fresh.id))?.status).toBe('running');
    const stillDone = await getAgentRun(db, WORKSPACE_ID, finished.id);
    expect(stillDone?.status).toBe('completed');
    expect(stillDone?.summary).toBe('fine');

    // If that loop was merely very slow rather than dead, it finds out at its
    // next step boundary instead of spending against a written-off run.
    expect(await isAgentRunStopRequested(db, stale.id)).toBe(true);
  });

  it('only touches the workspace it was given', async () => {
    const mine = await start({ goal: 'mine, abandoned' });
    const theirs = await startAgentRun(db, {
      workspaceId: OTHER_WORKSPACE_ID,
      trigger: 'schedule',
      goal: 'another tenant, also abandoned',
      maxSteps: 5
    });
    await age(mine.id, STALE_RUN_MINUTES + 5);
    await age(theirs.id, STALE_RUN_MINUTES + 5);

    expect(await reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID })).toBe(1);
    expect((await getAgentRun(db, WORKSPACE_ID, mine.id))?.status).toBe('failed');
    expect((await getAgentRun(db, OTHER_WORKSPACE_ID, theirs.id))?.status).toBe('running');

    // Unscoped, it is the worker's whole-box sweep and catches the other one.
    await reapStaleAgentRuns(db);
    expect((await getAgentRun(db, OTHER_WORKSPACE_ID, theirs.id))?.status).toBe('failed');
  });

  it('honours a threshold the caller chose', async () => {
    const run = await start();
    await age(run.id, 20);

    expect(await reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID, olderThanMinutes: 30 })).toBe(
      0
    );
    expect((await getAgentRun(db, WORKSPACE_ID, run.id))?.status).toBe('running');

    expect(await reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID, olderThanMinutes: 15 })).toBe(
      1
    );
    expect((await getAgentRun(db, WORKSPACE_ID, run.id))?.status).toBe('failed');
  });

  it('does not double-finish a run when several workers reap at once', async () => {
    // Two worker replicas start a cycle at the same instant. That is the normal
    // case, and one run must be written off once, by exactly one of them.
    const stale = await start({ goal: 'abandoned' });
    await age(stale.id, STALE_RUN_MINUTES + 30);

    const counts = await Promise.all([
      reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID }),
      reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID }),
      reapStaleAgentRuns(db, { workspaceId: WORKSPACE_ID })
    ]);

    expect(counts.reduce((total, count) => total + count, 0)).toBe(1);
    const reaped = await getAgentRun(db, WORKSPACE_ID, stale.id);
    expect(reaped?.status).toBe('failed');
    expect(reaped?.error).toBe(STALE_RUN_ERROR);

    // One finish, one finished_at -- nothing overwrote anything.
    const rows = await listAgentRuns(db, WORKSPACE_ID);
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(1);
  });
});
