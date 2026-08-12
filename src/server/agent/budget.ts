import { id, type Db } from '../db.js';

/**
 * Spend control for the hosted agent (design doc §5).
 *
 * Three jobs: hold the cap, refuse the call BEFORE it is made, and record what
 * each call actually cost. Nothing here calls a model or knows a key exists.
 *
 * The check is deliberately PRE-FLIGHT ONLY. It runs before a request and never
 * mid-stream, so a long generation can overshoot the cap by at most one call.
 * That is the design, not an oversight: aborting mid-stream burns the tokens
 * anyway, loses the output, and leaves the run in a state nobody can resume.
 * Do not "fix" this into a mid-stream abort.
 */

export interface AgentBudgetState {
  workspaceId: string;
  monthlyCapCents: number;
  spentCents: number;
  /** ISO-8601 UTC. Start of the calendar month the spend belongs to. */
  periodStart: string;
  enabled: boolean;
}

export class AgentBudgetError extends Error {
  readonly code: 'disabled' | 'cap_reached';

  constructor(code: 'disabled' | 'cap_reached', message: string) {
    super(message);
    this.name = 'AgentBudgetError';
    this.code = code;
  }
}

/** §5: $20, deliberately low. Applied without writing a row -- see getAgentBudget. */
const DEFAULT_CAP_CENTS = 2000;

/**
 * The pg pool parses TIMESTAMPTZ straight through as text, so every timestamp
 * leaving this module is formatted in SQL into one unambiguous ISO-8601 UTC
 * shape -- the same choice, for the same reason, as outreach/store.ts.
 */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Start of the current UTC month, as a timestamptz. */
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * True when the stored period belongs to an earlier calendar month (UTC).
 *
 * Always evaluated INSIDE the statement that reads or increments the row, never
 * as a read-then-write pair: two worker cycles crossing a month boundary would
 * each see the stale period and each reset the counter, spending the new
 * month's budget twice.
 */
function rolledOver(table: string): string {
  return `((${table}.period_start AT TIME ZONE 'UTC') < date_trunc('month', now() AT TIME ZONE 'UTC'))`;
}

interface BudgetRow {
  monthly_cap_cents: number;
  spent_cents: number;
  period_start: string;
  enabled: boolean;
}

function toState(workspaceId: string, row: BudgetRow): AgentBudgetState {
  return {
    workspaceId,
    monthlyCapCents: row.monthly_cap_cents,
    spentCents: row.spent_cents,
    periodStart: row.period_start,
    enabled: row.enabled
  };
}

/**
 * The workspace's budget, or the defaults when it has never been configured.
 *
 * A missing row is not an error and is NOT created here. §5: default off -- a
 * stored key does not imply consent to spend it, so merely asking about the
 * budget must not manufacture one.
 *
 * A row whose period has expired is reported rolled (spend 0, period moved to
 * this month) without being written: reads stay reads, and the next increment
 * performs the same roll for real.
 */
export async function getAgentBudget(db: Db, workspaceId: string): Promise<AgentBudgetState> {
  const row = await db.prepare(`
    SELECT
      monthly_cap_cents,
      CASE WHEN ${rolledOver('workspace_agent_budget')} THEN 0 ELSE spent_cents END AS spent_cents,
      TO_CHAR(
        CASE WHEN ${rolledOver('workspace_agent_budget')}
          THEN date_trunc('month', now() AT TIME ZONE 'UTC')
          ELSE (period_start AT TIME ZONE 'UTC')
        END,
        ${ISO_UTC}
      ) AS period_start,
      enabled
    FROM workspace_agent_budget
    WHERE workspace_id=?
  `).get<BudgetRow>(workspaceId);

  if (row) return toState(workspaceId, row);

  return {
    workspaceId,
    monthlyCapCents: DEFAULT_CAP_CENTS,
    spentCents: 0,
    periodStart: new Date().toISOString(),
    enabled: false
  };
}

/**
 * Change the cap and/or the kill switch, creating the row on first write.
 *
 * Both fields are optional and absent means unchanged -- turning the agent on
 * must not silently reset a cap the operator lowered.
 */
export async function setAgentBudget(
  db: Db,
  workspaceId: string,
  patch: { monthlyCapCents?: number; enabled?: boolean },
  actorUserId?: string | null
): Promise<AgentBudgetState> {
  const cap = patch.monthlyCapCents === undefined ? null : Math.max(0, Math.trunc(patch.monthlyCapCents));
  const enabled = patch.enabled === undefined ? null : patch.enabled;

  const row = await db.prepare(`
    INSERT INTO workspace_agent_budget (workspace_id, monthly_cap_cents, spent_cents, period_start, enabled)
    VALUES (?, COALESCE(?::int, ${DEFAULT_CAP_CENTS}), 0, ${MONTH_START}, COALESCE(?::boolean, FALSE))
    ON CONFLICT (workspace_id) DO UPDATE SET
      monthly_cap_cents = COALESCE(?::int, workspace_agent_budget.monthly_cap_cents),
      enabled = COALESCE(?::boolean, workspace_agent_budget.enabled),
      spent_cents = CASE WHEN ${rolledOver('workspace_agent_budget')} THEN 0 ELSE workspace_agent_budget.spent_cents END,
      period_start = CASE WHEN ${rolledOver('workspace_agent_budget')} THEN ${MONTH_START} ELSE workspace_agent_budget.period_start END
    RETURNING
      monthly_cap_cents,
      spent_cents,
      TO_CHAR(period_start AT TIME ZONE 'UTC', ${ISO_UTC}) AS period_start,
      enabled
  `).get<BudgetRow>(workspaceId, cap, enabled, cap, enabled);

  const state = toState(workspaceId, row as BudgetRow);

  // Turning spending on, or raising the cap, is exactly the kind of change an
  // operator must be able to find afterwards.
  await db.prepare(`
    INSERT INTO audit_events (
      id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id('audit'),
    workspaceId,
    actorUserId ? 'user' : 'system',
    actorUserId ?? null,
    'agent_budget.updated',
    'agent_budget',
    workspaceId,
    JSON.stringify({
      patch: { monthlyCapCents: patch.monthlyCapCents ?? null, enabled: patch.enabled ?? null },
      monthlyCapCents: state.monthlyCapCents,
      spentCents: state.spentCents,
      enabled: state.enabled
    }),
    new Date().toISOString()
  );

  return state;
}

/**
 * Pre-flight. Throws AgentBudgetError when the agent must not make the call.
 *
 * Called immediately before a model request and nowhere else. Messages are read
 * by a founder looking at a stopped agent, so they say what happened and what
 * to do -- no codes, no jargon.
 */
export async function assertAgentBudgetAvailable(db: Db, workspaceId: string): Promise<AgentBudgetState> {
  const state = await getAgentBudget(db, workspaceId);
  if (!state.enabled) {
    throw new AgentBudgetError('disabled', 'Agent spending is off. Turn it on in Setup.');
  }
  if (state.spentCents >= state.monthlyCapCents) {
    throw new AgentBudgetError(
      'cap_reached',
      `This month's ${formatDollars(state.monthlyCapCents)} agent budget is spent.`
    );
  }
  return state;
}

/**
 * Log one model call and charge it to the budget.
 *
 * The ledger row and the increment are one statement, so a crash cannot leave
 * spend recorded without a call to explain it, or a call nobody was charged
 * for. The period rollover rides along in the same statement for the same
 * reason the read does.
 *
 * `promptTokens`/`completionTokens` are `number | null`, and the two states are
 * DIFFERENT CLAIMS. A number -- including 0 -- is the provider saying what the
 * call cost. `null` is the provider saying nothing, which §4 predicts of the
 * OpenAI-compatible shims people point this at: they answer without a `usage`
 * block at all. Charging that 0 makes the endpoint free forever, so the cap
 * never binds and the pre-flight never fires. An unreported call is charged
 * {@link unreportedUsageFloorCents} instead, and the row records which of the
 * two happened -- a founder asking "why did this cost that" is owed "your
 * endpoint did not report usage, so this was estimated".
 */
export async function recordAgentModelCall(
  db: Db,
  input: {
    workspaceId: string;
    runId: string | null;
    model: string;
    /** Reported prompt tokens, or null when the provider reported none. */
    promptTokens: number | null;
    /** Reported completion tokens, or null when the provider reported none. */
    completionTokens: number | null;
  }
): Promise<{ costCents: number; usageReported: boolean; budget: AgentBudgetState }> {
  const reportedPrompt = reportedTokens(input.promptTokens);
  const reportedCompletion = reportedTokens(input.completionTokens);
  // A ZERO PROMPT COUNT IS NOT A REPORT, IT IS A SHRUG.
  //
  // Treating an absent `usage` block as unreported closed only half the hole:
  // an endpoint answering `usage: {prompt_tokens: 0, completion_tokens: 0}` --
  // an ordinary shim and proxy shape -- landed back on "reported, and it cost
  // nothing", so the cap never bound and the endpoint was free forever. Same
  // failure, one JSON field away.
  //
  // The distinction is not observable and cannot be true: HOSTED_AGENT_SYSTEM_PROMPT
  // alone is ~150 tokens, so a completed chat call that claims zero prompt
  // tokens is stating something impossible. Route it to the floor exactly as
  // `null` is routed. Completion tokens may legitimately be 0 (a call that
  // produced nothing), so only the prompt side carries this rule.
  const promptCountIsCredible = reportedPrompt !== null && reportedPrompt > 0;
  const usageReported = promptCountIsCredible && reportedCompletion !== null;

  // Stored as 0 when unreported, which is honest only because `usage_reported`
  // sits beside it: the column says the counts are absent, not zero.
  const promptTokens = reportedPrompt ?? 0;
  const completionTokens = reportedCompletion ?? 0;
  const costCents = usageReported
    ? estimateCostCents(input.model, promptTokens, completionTokens)
    : unreportedUsageFloorCents(input.model);

  const row = await db.prepare(`
    WITH charged AS (
      INSERT INTO workspace_agent_budget (workspace_id, monthly_cap_cents, spent_cents, period_start, enabled)
      VALUES (?, ${DEFAULT_CAP_CENTS}, ?::int, ${MONTH_START}, FALSE)
      ON CONFLICT (workspace_id) DO UPDATE SET
        spent_cents =
          CASE WHEN ${rolledOver('workspace_agent_budget')} THEN 0 ELSE workspace_agent_budget.spent_cents END
          + EXCLUDED.spent_cents,
        period_start =
          CASE WHEN ${rolledOver('workspace_agent_budget')} THEN ${MONTH_START} ELSE workspace_agent_budget.period_start END
      RETURNING monthly_cap_cents, spent_cents, period_start, enabled
    ), logged AS (
      INSERT INTO agent_model_calls (
        id, workspace_id, run_id, model, prompt_tokens, completion_tokens, cost_cents, usage_reported
      ) VALUES (?,?,?,?,?::int,?::int,?::int,?::boolean)
      RETURNING id
    )
    SELECT
      monthly_cap_cents,
      spent_cents,
      TO_CHAR(period_start AT TIME ZONE 'UTC', ${ISO_UTC}) AS period_start,
      enabled
    FROM charged
  `).get<BudgetRow>(
    input.workspaceId,
    costCents,
    id('amc'),
    input.workspaceId,
    input.runId,
    input.model,
    promptTokens,
    completionTokens,
    costCents,
    usageReported
  );

  return { costCents, usageReported, budget: toState(input.workspaceId, row as BudgetRow) };
}

/**
 * A token count the provider actually reported, or null when it did not.
 *
 * `undefined`, `NaN` and `Infinity` are all "did not": a shim that fills the
 * field with garbage has told us nothing, and treating garbage as 0 is the same
 * free-forever bug as treating an absent field as 0.
 */
function reportedTokens(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

/**
 * The assumed size of a call whose usage was not reported.
 *
 * Chosen to sit at or above what a real hosted-agent step plausibly costs, not
 * at the average. This loop resends the whole transcript every step, so a late
 * step in a 12-step run genuinely approaches a six-figure prompt; 100k in and
 * 4k out is a long, tool-heavy step, deliberately near the top of the range
 * rather than in the middle. Guessing high is the safe direction: the worst
 * outcome of overcharging an unmetered endpoint is that the agent stops early
 * and a human is told why, while the worst outcome of undercharging it is the
 * bill this cap exists to prevent.
 */
const UNREPORTED_PROMPT_TOKENS = 100_000;
const UNREPORTED_COMPLETION_TOKENS = 4_000;

/**
 * The absolute floor, for the cheap end of the price table.
 *
 * At llama prices the assumption above still only comes to ~3 cents, which
 * would let a $20 cap absorb ~700 unmetered calls -- finite, but not small
 * enough to call bounded. 10 cents caps that at 200 calls, and the cap being
 * the thing that binds is worth more here than the estimate being tight.
 */
const UNREPORTED_MIN_CENTS = 10;

/**
 * What one call with NO reported usage is charged, in whole cents.
 *
 * The property this exists for: an endpoint that never reports usage can make
 * at most `ceil(monthlyCapCents / unreportedUsageFloorCents(model))` calls in a
 * month before the pre-flight refuses. At the $20 default that is ~12 calls for
 * an unknown model, ~69 for gpt-4o and 200 in the worst (cheapest) case --
 * finite and small, which is the whole point. Never 0, whatever the model.
 */
export function unreportedUsageFloorCents(model: string): number {
  return Math.max(
    UNREPORTED_MIN_CENTS,
    estimateCostCents(model, UNREPORTED_PROMPT_TOKENS, UNREPORTED_COMPLETION_TOKENS)
  );
}

/**
 * Published list prices, in cents per 1M tokens, as [prompt, completion].
 *
 * Matched by substring against the normalised model name, so provider-prefixed
 * and dated ids ('anthropic/claude-sonnet-4-5', 'gpt-4o-2024-08-06') land on
 * the right row. Order matters: the longest, most specific needle first, or
 * 'gpt-4o-mini' would be priced as 'gpt-4o' and cost 16x too much.
 */
const MODEL_PRICES: ReadonlyArray<readonly [string, number, number]> = [
  ['gpt-4o-mini', 15, 60],
  ['gpt-4o', 250, 1000],
  ['gpt-4.1-mini', 40, 160],
  ['gpt-4.1', 200, 800],
  ['o4-mini', 110, 440],
  ['claude-haiku', 100, 500],
  ['claude-sonnet', 300, 1500],
  ['haiku', 100, 500],
  ['sonnet', 300, 1500],
  ['llama', 20, 60]
];

/**
 * Deliberately expensive. An unrecognised model is assumed to be a frontier one
 * so the cap bites EARLY rather than late -- guessing cheap on a model we do
 * not know would let an unknown id spend most of a real budget invisibly.
 */
const FALLBACK_PRICE: readonly [number, number] = [1500, 7500];

/**
 * Estimated cost of one call, in whole cents, rounded UP.
 *
 * This is an estimate for CAPPING, not billing truth. It uses list prices, so
 * it ignores cache discounts, batch pricing, and whatever the operator actually
 * negotiated -- close enough to stop a runaway loop, never close enough to put
 * on an invoice. Rounding up matters more than accuracy: a call that rounds to
 * zero is a call that never reaches the cap, and an unknown model would become
 * free and therefore uncapped.
 *
 * Zero tokens is 0 cents, and only because zero here means the provider
 * REPORTED zero -- a claim we can take at face value. "Reported nothing" is a
 * different claim and never reaches this function: it is knowable only at the
 * call-recording layer, which charges `unreportedUsageFloorCents` instead.
 *
 * lc-debt: static list-price table, drifts as providers reprice; upgrade path:
 * read the real cost from the provider's usage/billing payload where exposed
 * (OpenAI `usage`, Anthropic usage headers) and reconcile spent_cents against
 * it, keeping this table only as the pre-flight estimate.
 */
export function estimateCostCents(model: string, promptTokens: number, completionTokens: number): number {
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, Math.trunc(promptTokens)) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, Math.trunc(completionTokens)) : 0;
  if (prompt + completion === 0) return 0;

  const normalized = model.toLowerCase().replaceAll('_', '-');
  const match = MODEL_PRICES.find(([needle]) => normalized.includes(needle));
  const [promptPrice, completionPrice] = match ? [match[1], match[2]] : FALLBACK_PRICE;

  const cents = (prompt * promptPrice + completion * completionPrice) / 1_000_000;
  // Never 0 when tokens were spent: free calls do not accumulate toward a cap.
  return Math.max(1, Math.ceil(cents));
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
