/**
 * The hosted agent's run ledger.
 *
 * byok-and-hosted-agent.md §6: "Every model call and every tool call lands in
 * the ledger. An autonomous agent you cannot audit afterwards is not a
 * feature." This module is the only writer, so the ordering and the step
 * accounting are enforced in one place rather than trusted to a loop.
 *
 * It knows nothing about models or tools on purpose: the loop that owns those
 * decisions calls in here, and a second consumer (a schedule, a replay tool)
 * can be added without teaching this file anything new.
 */

import { id, type Db } from '../db.js';
import { resolveActiveAgent } from '../agents.js';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentRunStep {
  seq: number;
  kind: 'model' | 'tool';
  toolName: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
  /**
   * How long the step took, or `null` when nothing measured it -- every step
   * written before migration 019, and any step whose timing the model SDK did
   * not report. `null` is not `0`: the UI renders it as "not recorded", which
   * is a different and honest claim from "instant".
   */
  durationMs: number | null;
}

export interface AgentRunRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  trigger: 'manual' | 'schedule';
  status: AgentRunStatus;
  goal: string;
  stepCount: number;
  maxSteps: number;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * When somebody asked this run to stop, or `null` if nobody has.
   *
   * Deliberately distinct from `status`: this is the REQUEST, and `status` is
   * the OUTCOME. A run can be `running` with a stop requested -- that is the
   * normal state for the second or two between the operator clicking and the
   * loop reaching its next step boundary -- and the UI has to be able to say
   * "stopping" without claiming "stopped".
   */
  stopRequestedAt: string | null;
  /** Why a human asked it to stop. Never back-filled: older stops have none. */
  stopReason: string | null;
}

/**
 * pg hands TIMESTAMPTZ back as a raw string (see the type parsers in db.ts), so
 * the ISO-8601 conversion happens in SQL rather than in a `new Date()` round
 * trip that would quietly re-interpret the value in the server's zone.
 */
const ISO = (column: string): string =>
  `TO_CHAR(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const RUN_COLUMNS = `
  id, workspace_id, agent_id, trigger, status, goal, step_count, max_steps, summary, error,
  ${ISO('started_at')} AS started_at,
  ${ISO('finished_at')} AS finished_at,
  ${ISO('stop_requested_at')} AS stop_requested_at,
  stop_reason
`;

/**
 * How long a run may sit in `running` before the reaper calls it dead.
 *
 * Sized off the loop's own realistic ceiling rather than picked round:
 * `MAX_STEPS_CEILING` in loop.ts is 40 steps, and a single step is one model
 * generation plus, usually, one tool call -- and the tools include
 * `network-read` skills that fetch pages. Three minutes is a generous
 * worst-case for that pair, which puts the slowest run the loop can legally
 * produce at roughly 40 x 3 = 120 minutes.
 *
 * The threshold is that ceiling and not less, because being early here is the
 * expensive mistake. Reaping a run whose loop is still alive would recreate
 * exactly the bug this file was changed to fix: a terminal row with a process
 * still spending behind it. Being late costs a wedged workspace at most a
 * couple of extra cycles, and nothing at all in money.
 *
 * (Being late is also self-limiting: the reaper's write is itself observable
 * through {@link isAgentRunStopRequested}, so a loop that really was just very
 * slow sees its run is no longer `running` and stops itself rather than
 * carrying on against a row that has already been written off.)
 */
export const STALE_RUN_MINUTES = 120;

/**
 * What a reaped run says happened, in the words of the thing that actually
 * knows: the worker went away. Exported so a caller can recognise the outcome
 * without matching on prose.
 */
export const STALE_RUN_ERROR = 'the worker stopped before this run finished';

/**
 * Ceiling on a single serialised payload in the ledger.
 *
 * A run that dumps a 2 MB fetched page into a step is a real outage: it bloats
 * every subsequent read of the run, and a loop that does it twenty times does
 * it to the whole workspace's Postgres. Truncation loses the tail of one step;
 * not truncating loses the database.
 *
 * lc-debt: payloads are truncated at 8 KB inline, so a step whose full output
 * matters (a large page fetch a human later wants to re-read) is unrecoverable;
 * upgrade path is to spill oversized payloads to object storage and keep only
 * the reference plus this preview in the row.
 */
const PAYLOAD_LIMIT_BYTES = 8 * 1024;

export async function startAgentRun(
  db: Db,
  input: {
    workspaceId: string;
    agentId?: string | null;
    trigger: 'manual' | 'schedule';
    goal: string;
    maxSteps: number;
  }
): Promise<AgentRunRecord> {
  const agent = await resolveActiveAgent(db, input.workspaceId, input.agentId);
  const row = await db
    .prepare(
      `
    INSERT INTO agent_runs (id, workspace_id, agent_id, trigger, status, goal, step_count, max_steps)
    VALUES (?,?,?,?,'running',?,0,?)
    RETURNING ${RUN_COLUMNS}
  `
    )
    .get<Record<string, unknown>>(
      id('arun'),
      input.workspaceId,
      agent.id,
      input.trigger,
      input.goal,
      input.maxSteps
    );
  if (!row) throw new Error('Failed to start agent run');
  return serializeRun(row);
}

/**
 * Append one step and return the sequence number it was given.
 *
 * `seq` is allocated server-side inside the same statement that increments
 * `agent_runs.step_count`. The UPDATE takes a row lock on the parent run, so
 * two concurrent appends serialise behind it and cannot both claim the same
 * position -- reading a counter and then inserting would let them, and the
 * unique index on (run_id, seq) would turn that race into a lost step.
 */
export async function appendAgentRunStep(
  db: Db,
  input: {
    runId: string;
    workspaceId: string;
    kind: 'model' | 'tool';
    toolName?: string | null;
    input?: unknown;
    output?: unknown;
    error?: string | null;
    /**
     * Measured elapsed time for this step. Omit it when nothing measured the
     * step -- the column stays NULL and the run inspector says "not recorded"
     * rather than showing a number nobody stood behind.
     */
    durationMs?: number | null;
  }
): Promise<number> {
  const row = await db
    .prepare(
      `
    WITH bumped AS (
      UPDATE agent_runs SET step_count = step_count + 1
      -- Only a run that is still going may gain a step. Without the status
      -- predicate a straggler kept writing to a run the reaper had already
      -- written off, so a record with finished_at set quietly grew steps
      -- dated after it ended. Failing loudly here is the point: the INSERT
      -- selects FROM bumped, so no row bumped means no step written.
      WHERE id=? AND workspace_id=? AND status='running'
      RETURNING step_count
    )
    INSERT INTO agent_run_steps (id, run_id, workspace_id, seq, kind, tool_name, input_json, output_json, error, duration_ms)
    SELECT ?, ?, ?, bumped.step_count, ?, ?, ?, ?, ?, ? FROM bumped
    RETURNING seq
  `
    )
    .get<{ seq: number }>(
      input.runId,
      input.workspaceId,
      id('astep'),
      input.runId,
      input.workspaceId,
      input.kind,
      input.toolName ?? null,
      serializePayload(input.input),
      serializePayload(input.output),
      input.error ?? null,
      normalizeDurationMs(input.durationMs)
    );
  if (!row) throw new Error(`Agent run not found: ${input.runId}`);
  return Number(row.seq);
}

/**
 * Close a run out. The runner's own call: whatever is driving the loop says
 * here that it has genuinely put the model down.
 *
 * Only a `running` run is closed, and that guard is load-bearing in both
 * directions. A run the reaper already wrote off stays written off, so a loop
 * that surfaces from a long generation cannot rewrite the record into a clean
 * 'completed'; and a run somebody asked to stop is closed exactly once, by the
 * runner, with the status the runner observed.
 */
export async function finishAgentRun(
  db: Db,
  runId: string,
  outcome: {
    status: Exclude<AgentRunStatus, 'running'>;
    summary?: string | null;
    error?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE agent_runs
    SET status=?, summary=?, error=?, finished_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='running'
  `
    )
    .run(outcome.status, outcome.summary ?? null, outcome.error ?? null, runId);
}

export async function listAgentRuns(
  db: Db,
  workspaceId: string,
  options: { limit?: number } = {}
): Promise<AgentRunRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = await db
    .prepare(
      `
    SELECT ${RUN_COLUMNS} FROM agent_runs
    WHERE workspace_id=? ORDER BY started_at DESC, id DESC LIMIT ?
  `
    )
    .all<Record<string, unknown>>(workspaceId, limit);
  return rows.map(serializeRun);
}

export async function getAgentRun(
  db: Db,
  workspaceId: string,
  runId: string
): Promise<(AgentRunRecord & { steps: AgentRunStep[] }) | null> {
  const row = await db
    .prepare(
      `
    SELECT ${RUN_COLUMNS} FROM agent_runs WHERE workspace_id=? AND id=?
  `
    )
    .get<Record<string, unknown>>(workspaceId, runId);
  if (!row) return null;
  const steps = await db
    .prepare(
      `
    SELECT seq, kind, tool_name, input_json, output_json, error, duration_ms, ${ISO('created_at')} AS created_at
    FROM agent_run_steps WHERE run_id=? ORDER BY seq ASC
  `
    )
    .all<Record<string, unknown>>(runId);
  return { ...serializeRun(row), steps: steps.map(serializeStep) };
}

/**
 * The kill switch (§5): ask every run still in flight for one workspace to
 * stop, and report how many were asked, so a caller can tell "asked three"
 * from "there was nothing running".
 *
 * It writes `stop_requested_at` and LEAVES THE ROW `running`, which is the
 * whole correction. The previous version set `status='stopped'` here, and that
 * did not stop anything: the loop lives in another process, was mid-generation
 * against the operator's key, and went on to append its next step and charge
 * for it -- against a run the ledger had already declared over, and which
 * `finishAgentRun` then refused to correct. The record said stopped while the
 * money kept moving, which is the worst of both.
 *
 * So the row stays `running` until the thing that is actually running it says
 * otherwise. The loop reads {@link isAgentRunStopRequested} between steps and
 * closes the run out as 'stopped' itself. Until it does, the run is honestly
 * described as still going, with a stop pending.
 *
 * Asking twice is not an error and is not counted twice: a run that already
 * has a request keeps its original timestamp, so "when did somebody ask for
 * this to stop" survives an impatient second click.
 */
export async function stopRunningAgentRuns(db: Db, workspaceId: string): Promise<number> {
  const result = await db
    .prepare(
      `
    UPDATE agent_runs SET stop_requested_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND status='running' AND stop_requested_at IS NULL
  `
    )
    .run(workspaceId);
  return result.changes;
}

/**
 * True when this run has been asked to stop. Read between steps; a stopped run
 * must not start another model call.
 *
 * This is the entire contract between the kill switch and whatever is running
 * the loop, and it goes through Postgres on purpose: the process that receives
 * the stop (the API) is routinely not the process running the loop (the
 * worker), so an in-memory flag or an AbortSignal held by the API cannot reach
 * it. One `SELECT` between steps can.
 *
 * It answers "must I stop", not merely "did someone press the button", so it is
 * true in all three cases where continuing would be wrong:
 *
 *   - `stop_requested_at` is set -- a human asked.
 *   - the run is no longer `running` -- something else already closed it out
 *     (the reaper wrote it off, or a second runner finished it). Issuing
 *     another model call against a terminal run would spend money that can
 *     never be recorded, because `finishAgentRun` will not reopen the row.
 *   - the row is GONE -- the workspace was deleted out from under the run.
 *     There is nobody left to bill and nothing left to write to.
 *
 * A database error still throws. "I could not find out" is not "keep going":
 * the caller decides, and it must not be decided by a silent `false` here.
 */
export async function isAgentRunStopRequested(db: Db, runId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `
    SELECT 1 AS live FROM agent_runs
    WHERE id=? AND status='running' AND stop_requested_at IS NULL
  `
    )
    .get<{ live: number }>(runId);
  return row === undefined;
}

/**
 * Finish runs that have been `running` longer than any real run can be, as
 * 'failed'. Returns how many were written off.
 *
 * This exists because nothing else could ever end them. A worker that is
 * SIGKILLed, OOM-killed or rolled during a scheduled run leaves its row in
 * `running` forever -- no process owns it any more, and no process is coming
 * back for it. `hasRunningAgentRun` then skips that workspace's schedule on
 * every future cycle, so one ordinary deploy at the wrong moment permanently
 * disabled that workspace's autopilot, with nothing in the product a founder
 * or an operator could press to recover it.
 *
 * The error text is deliberately about the worker and not about the agent. The
 * run did not fail; it was abandoned, and saying "the model failed" would be
 * inventing a cause. See app-spec.md §6 rule 3.
 *
 * Safe to run concurrently on two replicas: the `status='running'` predicate is
 * re-evaluated under the row lock, so the second sweep matches nothing and
 * `changes` counts only rows that sweep actually closed. Nothing is
 * double-finished, and nothing is double-counted.
 *
 * `workspaceId` is optional and unset means every workspace -- the worker sweeps
 * the whole box, exactly like the schedule claim does.
 */
export async function reapStaleAgentRuns(
  db: Db,
  options: { olderThanMinutes?: number; workspaceId?: string } = {}
): Promise<number> {
  const minutes = Math.max(1, Math.trunc(options.olderThanMinutes ?? STALE_RUN_MINUTES));
  const result = await db
    .prepare(
      `
    UPDATE agent_runs
    SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP
    WHERE status='running'
      AND started_at < now() - make_interval(mins => ?::int)
      AND (?::text IS NULL OR workspace_id = ?::text)
  `
    )
    .run(STALE_RUN_ERROR, minutes, options.workspaceId ?? null, options.workspaceId ?? null);
  return result.changes;
}

function serializeRun(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    trigger: String(row.trigger) as 'manual' | 'schedule',
    status: String(row.status) as AgentRunStatus,
    goal: String(row.goal),
    stepCount: Number(row.step_count),
    maxSteps: Number(row.max_steps),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startedAt: String(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    stopRequestedAt:
      row.stop_requested_at === null || row.stop_requested_at === undefined
        ? null
        : String(row.stop_requested_at),
    stopReason:
      row.stop_reason === null || row.stop_reason === undefined ? null : String(row.stop_reason)
  };
}

function serializeStep(row: Record<string, unknown>): AgentRunStep {
  return {
    seq: Number(row.seq),
    kind: String(row.kind) as 'model' | 'tool',
    toolName: row.tool_name === null || row.tool_name === undefined ? null : String(row.tool_name),
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
    // Never coerced through `Number(undefined)` -> NaN: an absent duration is
    // the historical case and has to survive the read as null.
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms)
  };
}

/**
 * The ledger's rule for a step duration: a whole number of milliseconds, or
 * nothing at all.
 *
 * The two rejections are deliberately different, because they are different
 * statements:
 *
 *   - A NEGATIVE elapsed time is clamped up to 0. It means the clock moved
 *     backwards under the measurement or the step finished inside one tick;
 *     either way the step did happen and 0 is the nearest value that is not a
 *     lie about the order of events.
 *   - A NON-FINITE value (NaN from arithmetic on a missing timestamp,
 *     Infinity) has no number to clamp to, so it is stored as NULL -- the same
 *     "not recorded" that pre-019 rows carry. Storing 0 there would assert the
 *     step was instant, which is a claim nothing measured.
 *
 * Rounding is to whole milliseconds because the column is INTEGER, and because
 * the sub-millisecond tail of a step that made a network call is noise that
 * would only make two runs look different when they were not.
 */
function normalizeDurationMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializePayload(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    // Circular or otherwise unserialisable: record that it happened rather than
    // failing the append and losing the step entirely.
    text = JSON.stringify({ unserializable: String(value) });
  }
  if (text.length <= PAYLOAD_LIMIT_BYTES) return text;
  return JSON.stringify({
    truncated: true,
    originalLength: text.length,
    preview: text.slice(0, PAYLOAD_LIMIT_BYTES)
  });
}
