/**
 * The hosted agent's schedule -- the half of app-spec.md §2 the loop cannot
 * deliver on its own.
 *
 * The only thing the hosted agent does that a laptop agent cannot is work when
 * the laptop is closed. A loop that starts only when somebody clicks Start does
 * not do that, so this module is where the promise in §2 is actually kept. It
 * is deliberately small: one standing goal per workspace, one cadence, one
 * atomic claim, and no queue.
 *
 * Three rules it exists to hold.
 *
 * 1. OPT IN TWICE. `enabled` defaults FALSE, exactly like the budget's own
 *    switch (byok-and-hosted-agent.md §5). Consenting to spend the key is one
 *    decision; consenting to spend it unattended on a timer is another, and it
 *    gets its own switch rather than inheriting the first one's.
 *
 * 2. EXACTLY ONCE. Two worker replicas sweep this table at the same moment.
 *    The claim is one UPDATE ... RETURNING and the returned row IS the lease --
 *    see {@link claimDueAgentSchedules}.
 *
 * 3. NEVER STALL. One workspace failing must not end the cycle for everyone
 *    else, and a workspace that hit its cap must come back by itself next
 *    month. So an `AgentBudgetError` is an ordinary expected outcome in here:
 *    logged at debug, never counted as a failure, and never a reason to switch
 *    a schedule off. Auto-disabling on a cap would turn "you spent $20" into
 *    "your agent silently stopped forever", which is a far worse product.
 */

import { id, type Db } from '../db.js';
import { ensureDefaultAgent, resolveActiveAgent } from '../agents.js';
import { AgentBudgetError } from './budget.js';
import { runHostedAgent } from './loop.js';
import { STALE_RUN_MINUTES } from './runs.js';

export interface AgentSchedule {
  workspaceId: string;
  agentId: string;
  enabled: boolean;
  goal: string;
  intervalMinutes: number;
  /** ISO-8601 UTC, or null until the schedule has run once. */
  lastRunAt: string | null;
  /** ISO-8601 UTC. The lease: the claim moves it, nothing else reads it. */
  nextRunAt: string;
}

/**
 * Floor and ceiling on the cadence.
 *
 * The floor is not a taste judgement. The claim advances `next_run_at` by one
 * interval, and that advance is what makes two replicas sweeping concurrently
 * safe -- it has to be comfortably larger than any clock difference between
 * them. Fifteen minutes is also about the shortest cadence at which an
 * unattended model loop is a schedule rather than a leak.
 *
 * The ceiling is a week: past that, "scheduled" stops being a useful word and
 * the operator wants a reminder, not an agent.
 */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 10_080;
export const DEFAULT_INTERVAL_MINUTES = 1440;

/**
 * What the agent is told to do when the operator turned the schedule on without
 * writing a goal. Phrased for the person who signs the cheque (app-spec.md §6)
 * and it stops at prepare, because so does every tool the agent has.
 */
export const DEFAULT_SCHEDULE_GOAL =
  'Review the GTM workspace: read current priorities, conversations, signals, and anything waiting for a decision, ' +
  'then prepare the GTM work that is worth a human looking at.';

/**
 * pg hands TIMESTAMPTZ back as raw text (see the type parsers in db.ts), so the
 * ISO-8601 conversion is done in SQL rather than through a `new Date()` round
 * trip that would quietly re-read the value in the server's zone. Same choice,
 * same reason, as runs.ts.
 */
const ISO = (column: string): string =>
  `TO_CHAR(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SCHEDULE_COLUMNS = `
  workspace_id, agent_id, enabled, goal, interval_minutes,
  ${ISO('last_run_at')} AS last_run_at,
  ${ISO('next_run_at')} AS next_run_at
`;

/** The workspace's schedule, or null when it never configured one. */
export async function getAgentSchedule(db: Db, workspaceId: string): Promise<AgentSchedule | null> {
  const row = await db
    .prepare(
      `
    SELECT ${SCHEDULE_COLUMNS} FROM workspace_agent_schedule WHERE workspace_id=?
  `
    )
    .get<Record<string, unknown>>(workspaceId);
  return row ? serialize(row) : null;
}

/**
 * Change the cadence, the goal and/or the switch, creating the row on first
 * write.
 *
 * Every field is optional and absent means unchanged -- turning the schedule on
 * must not quietly reset a goal or a cadence the operator chose, for the same
 * reason `setAgentBudget` leaves an untouched cap alone.
 *
 * A new row is due immediately: once both switches are on, the operator has
 * said yes twice and expects the first run on the next worker cycle, not
 * tomorrow. Shortening the interval pulls `next_run_at` in as well (the LEAST
 * below), so someone who moves a weekly schedule to hourly does not wait out
 * the rest of the week to find out whether it works.
 */
export async function setAgentSchedule(
  db: Db,
  workspaceId: string,
  patch: { enabled?: boolean; goal?: string; intervalMinutes?: number; agentId?: string },
  actorUserId?: string | null
): Promise<AgentSchedule> {
  if (patch.intervalMinutes !== undefined) assertInterval(patch.intervalMinutes);

  const goal = patch.goal === undefined ? null : patch.goal.trim();
  if (goal !== null && goal.length === 0) throw new Error('goal must not be empty');
  const interval = patch.intervalMinutes === undefined ? null : Math.trunc(patch.intervalMinutes);
  const enabled = patch.enabled === undefined ? null : patch.enabled;
  const existing = await db
    .prepare('SELECT agent_id FROM workspace_agent_schedule WHERE workspace_id=?')
    .get<{ agent_id: string }>(workspaceId);
  const agentId = patch.agentId?.trim()
    ? (await resolveActiveAgent(db, workspaceId, patch.agentId.trim(), actorUserId ?? null)).id
    : (existing?.agent_id ?? (await ensureDefaultAgent(db, workspaceId, actorUserId ?? null)).id);

  const row = await db
    .prepare(
      `
    INSERT INTO workspace_agent_schedule (workspace_id, agent_id, enabled, goal, interval_minutes, next_run_at)
    VALUES (?, ?, COALESCE(?::boolean, FALSE), COALESCE(?::text, ?::text), COALESCE(?::int, ?::int), now())
    ON CONFLICT (workspace_id) DO UPDATE SET
      agent_id = ?::text,
      enabled = COALESCE(?::boolean, workspace_agent_schedule.enabled),
      goal = COALESCE(?::text, workspace_agent_schedule.goal),
      interval_minutes = COALESCE(?::int, workspace_agent_schedule.interval_minutes),
      next_run_at = LEAST(
        workspace_agent_schedule.next_run_at,
        now() + make_interval(mins => COALESCE(?::int, workspace_agent_schedule.interval_minutes))
      ),
      updated_at = now()
    RETURNING ${SCHEDULE_COLUMNS}
  `
    )
    .get<Record<string, unknown>>(
      workspaceId,
      agentId,
      enabled,
      goal,
      DEFAULT_SCHEDULE_GOAL,
      interval,
      DEFAULT_INTERVAL_MINUTES,
      agentId,
      enabled,
      goal,
      interval,
      interval
    );
  if (!row) throw new Error(`Failed to save the agent schedule for ${workspaceId}`);
  const schedule = serialize(row);

  // Turning unattended spending on is exactly the kind of change somebody has to
  // be able to find afterwards -- same reason setAgentBudget writes one.
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
      actorUserId ? 'user' : 'system',
      actorUserId ?? null,
      'agent_schedule.updated',
      'agent_schedule',
      workspaceId,
      JSON.stringify({
        patch: {
          enabled: patch.enabled ?? null,
          goal: goal,
          intervalMinutes: patch.intervalMinutes ?? null,
          agentId: patch.agentId ?? null
        },
        agentId: schedule.agentId,
        enabled: schedule.enabled,
        intervalMinutes: schedule.intervalMinutes,
        nextRunAt: schedule.nextRunAt
      }),
      new Date().toISOString()
    );

  return schedule;
}

/**
 * Claim every workspace whose schedule is due, atomically.
 *
 * ONE statement, and that is the entire point. Selecting due rows and then
 * updating them would let two worker replicas both read the same row as due and
 * both start a run against one operator's key. Here the row is selected,
 * stamped and handed back in the same UPDATE: the second replica blocks on the
 * row lock, re-evaluates `next_run_at <= now()` against the version the first
 * one just wrote, finds it false, and gets nothing back. The returned rows are
 * the lease.
 *
 * `next_run_at` is advanced from NOW rather than from its old value on purpose.
 * After a worker outage, `next_run_at + interval` can still be in the past, and
 * the schedule would then fire again and again until it caught up -- a backlog
 * of identical unattended runs, each one spending real money, none of which
 * anybody asked for. A missed window is skipped, never replayed.
 *
 * `now` is injectable for tests only; production always passes the database's
 * clock, which is the one clock every replica shares.
 */
export async function claimDueAgentSchedules(db: Db, now?: Date): Promise<AgentSchedule[]> {
  const at = now ? now.toISOString() : null;
  const rows = await db
    .prepare(
      `
    UPDATE workspace_agent_schedule AS s
    SET last_run_at = COALESCE(?::timestamptz, now()),
        next_run_at = COALESCE(?::timestamptz, now()) + make_interval(mins => s.interval_minutes),
        updated_at = now()
    WHERE s.enabled AND s.next_run_at <= COALESCE(?::timestamptz, now())
    RETURNING ${SCHEDULE_COLUMNS}
  `
    )
    .all<Record<string, unknown>>(at, at, at);
  return rows.map(serialize);
}

/**
 * One sweep: claim what is due and run it. Returns how many runs it started.
 *
 * The count is runs STARTED, not workspaces claimed -- a workspace that was
 * claimed and then skipped or refused did not spend anything, and a number that
 * conflated the two would report activity that never happened (app-spec.md §6,
 * rule 3).
 *
 * Nothing in here is allowed to end the loop early. A workspace with a broken
 * endpoint, a missing key or a model that throws is one bad workspace, not a
 * stopped product for everyone else on the box.
 *
 * lc-debt: claimed workspaces are run sequentially inside the worker's cycle,
 * so one slow run delays every other control-plane cycle behind the worker's
 * one-at-a-time guard; upgrade path is to hand each claimed workspace to a job
 * queue and let the cycle return immediately.
 */
export async function runDueAgentSchedules(db: Db): Promise<number> {
  const due = await claimDueAgentSchedules(db);
  let started = 0;

  for (const schedule of due) {
    try {
      // A run still in flight means the last cadence has not finished yet.
      // Starting a second one would pile up loops on the same workspace, all
      // charging the same budget, and the ledger would show a workspace talking
      // over itself. The claim already moved next_run_at, so this workspace is
      // simply looked at again on its next window.
      const inFlight = await runningAgentRun(db, schedule.workspaceId);
      if (inFlight) {
        // WARN, not debug. This is the one skip an operator has to be able to
        // find: a run that no process is advancing any more holds this
        // workspace's autopilot shut on every cycle, and a debug line nobody
        // configures a level for made that failure completely invisible. The
        // run id is here so it can be looked up, and the recovery is named so
        // nobody has to read this file to know one exists.
        console.warn(
          `Hosted agent schedule skipped for ${schedule.workspaceId}: run ${inFlight.id} ` +
            `has been in flight since ${inFlight.startedAt}. If nothing is advancing it, ` +
            `reapStaleAgentRuns writes it off after ${STALE_RUN_MINUTES} minutes and the ` +
            'next cycle picks this workspace up again.'
        );
        continue;
      }

      await runHostedAgent(db, {
        workspaceId: schedule.workspaceId,
        agentId: schedule.agentId,
        goal: schedule.goal,
        trigger: 'schedule'
      });
      started += 1;
    } catch (error) {
      if (error instanceof AgentBudgetError) {
        // Expected, and not a fault: the switch is off or the month is spent.
        // Debug, not error -- and emphatically NOT a reason to disable the
        // schedule, or a capped month would become a permanently dead agent
        // instead of one that resumes on the first of the month by itself.
        console.debug(
          'Hosted agent schedule refused by the budget',
          schedule.workspaceId,
          error.message
        );
        continue;
      }
      console.error('Hosted agent schedule failed', schedule.workspaceId, error);
    }
  }

  return started;
}

/**
 * The oldest run still in flight for this workspace, or null.
 *
 * Returns the row rather than a bare yes/no because the skip above has to name
 * something an operator can go and look at. Oldest first: if several are
 * somehow open, the one that has been stuck longest is the one worth reporting.
 */
export async function runningAgentRun(
  db: Db,
  workspaceId: string
): Promise<{ id: string; startedAt: string } | null> {
  const row = await db
    .prepare(
      `
    SELECT id, ${ISO('started_at')} AS started_at FROM agent_runs
    WHERE workspace_id=? AND status='running'
    ORDER BY started_at ASC LIMIT 1
  `
    )
    .get<{ id: string; started_at: string }>(workspaceId);
  return row ? { id: String(row.id), startedAt: String(row.started_at) } : null;
}

/** Is a run for this workspace still going? */
export async function hasRunningAgentRun(db: Db, workspaceId: string): Promise<boolean> {
  return (await runningAgentRun(db, workspaceId)) !== null;
}

function assertInterval(minutes: number): void {
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_INTERVAL_MINUTES ||
    minutes > MAX_INTERVAL_MINUTES
  ) {
    throw new Error(
      `intervalMinutes must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`
    );
  }
}

function serialize(row: Record<string, unknown>): AgentSchedule {
  return {
    workspaceId: String(row.workspace_id),
    agentId: String(row.agent_id),
    enabled: row.enabled === true,
    goal: String(row.goal),
    intervalMinutes: Number(row.interval_minutes),
    lastRunAt:
      row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
    nextRunAt: String(row.next_run_at)
  };
}
