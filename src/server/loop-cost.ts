/**
 * What did this cost me, and what did it produce.
 *
 * docs/gtm-shell-shape.md §3.5, Wave B1. The founder's only real question had no
 * screen and no route: agent spend lived in Setup behind `GET /api/agent-setup`,
 * outreach volume lived in the LinkedIn area behind `/api/linkedin/analytics`,
 * and nothing joined them. This is the one payload both halves come back in.
 *
 * NO NEW TABLES, and none were needed. `agent_model_calls.run_id` already
 * points at `agent_runs.id` and `linkedin_actions` already carries
 * `campaign_id`; every number below is a read.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 * 1. Every spend line carries its own confidence flag. `usage_reported=true`
 *    means the provider measured the call; false or NULL means Trevra guessed
 *    it from a list-price table (agent/budget.ts explains the guess and why it
 *    guesses high). Those are different claims and the UI has to be able to say
 *    which one it is showing. This is the LinkedIn epistemics -- HARD FACT vs
 *    REPORTED, from linkedin/limits.ts -- extended into the rest of the shell,
 *    and it costs one column that already exists.
 *
 * 2. NOTHING HERE IS ATTRIBUTED. No join exists from a model call or an
 *    outreach action to an invoice, so the payload must not imply one. The
 *    three rows are the same period and not the same causal chain, and
 *    {@link LOOP_COST_NO_ATTRIBUTION} is shipped IN THE PAYLOAD so the client
 *    renders that sentence verbatim rather than inventing a softer one.
 */

import type { Db } from './db.js';
import { getAgentBudget, type AgentBudgetState } from './agent/budget.js';
import {
  ACTION_KIND_VALUES,
  countActionsInWindow,
  ownerSeat,
  type LinkedInActionKind
} from './linkedin/actions.js';
import { linkedinAnalytics } from './linkedin/action-ledger.js';

/**
 * The same two words the LinkedIn limits table uses, on purpose. A founder who
 * has learnt what HARD FACT means on the Safety screen must not have to learn a
 * second vocabulary on the cost screen.
 */
export type LoopCostConfidence = 'HARD FACT' | 'REPORTED';

/**
 * The sentence the client renders verbatim under the Produced row.
 *
 * It is a constant, and it lives on the server, because the moment this becomes
 * client copy somebody will shorten it. src/client/LinkedInSafety.tsx's honesty
 * panel exists to forbid exactly the number this sentence refuses to claim.
 */
export const LOOP_COST_NO_ATTRIBUTION =
  'These are the same period, not the same causal chain. Trevra does not claim one produced the other.';

export const LOOP_COST_DEFAULT_WINDOW_DAYS = 30;
export const LOOP_COST_MAX_WINDOW_DAYS = 365;

export interface LoopCostModelLine {
  model: string;
  calls: number;
  /** Reported prompt tokens. 0 on a REPORTED line means "not reported", not "free". */
  promptTokens: number;
  completionTokens: number;
  costCents: number;
  /** The raw column, so a client never has to reverse the flag back out of the label. */
  usageReported: boolean;
  confidence: LoopCostConfidence;
}

export interface LoopCostSpent {
  /**
   * The live budget row. NOTE ITS PERIOD: `spentCents` is charged against the
   * calendar month in `periodStart`, NOT against the window this payload was
   * asked for. A 7-day window next to a month-to-date meter is not a bug, and
   * the client has to label them as the two different spans they are --
   * `costCents` below is the windowed number.
   */
  budget: AgentBudgetState;
  /** Model calls inside the window. */
  calls: number;
  /** What those calls were charged, in cents. Windowed; see `budget`. */
  costCents: number;
  /**
   * One line per (model, confidence). A model whose provider reported usage on
   * some calls and not on others appears TWICE, which is the honest shape: the
   * two halves are different claims and averaging them would erase the flag.
   */
  byModel: LoopCostModelLine[];
}

export interface LoopCostActionCount {
  kind: LinkedInActionKind;
  count: number;
}

export interface LoopCostAgentRuns {
  total: number;
  completed: number;
  failed: number;
  stopped: number;
  running: number;
}

export interface LoopCostSent {
  /**
   * Outreach actions that really went out, by kind. Planned and skipped slots
   * are excluded -- `countActionsInWindow` owns that rule and it is not
   * restated here.
   */
  actions: LoopCostActionCount[];
  actionsTotal: number;
  agentRuns: LoopCostAgentRuns;
}

export interface LoopCostProduced {
  /** Invites accepted in the window. A reply implies acceptance, as everywhere else. */
  accepted: number;
  replied: number;
}

export interface LoopCost {
  windowDays: number;
  /** ISO-8601 UTC. Start of the first whole UTC day in the window. */
  since: string;
  spent: LoopCostSpent;
  sent: LoopCostSent;
  produced: LoopCostProduced;
}

interface ModelCallRow {
  model: string;
  usage_reported: boolean;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_cents: number;
}

/**
 * The three rows, in one read.
 *
 * The window boundary is the one `linkedinAnalytics` already uses -- whole UTC
 * days, counted inclusive of today -- and every query here is pinned to it,
 * including the rolling-hours helper. One screen showing two definitions of
 * "30 days" is a screen nobody can reconcile.
 */
export async function loopCost(
  db: Db,
  workspaceId: string,
  windowDays: number,
  now: Date
): Promise<LoopCost> {
  const days = Math.max(1, Math.min(Math.trunc(windowDays), LOOP_COST_MAX_WINDOW_DAYS));
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  const since = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const sinceIso = since.toISOString();
  const sinceHours = (now.getTime() - since.getTime()) / 3_600_000;

  const seat = ownerSeat(workspaceId);

  const [budget, modelCalls, agentRuns, analytics, actionCounts] = await Promise.all([
    getAgentBudget(db, workspaceId),

    db
      .prepare(
        `
      SELECT model,
        COALESCE(usage_reported, FALSE) AS usage_reported,
        COUNT(*)::int AS calls,
        COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
        COALESCE(SUM(cost_cents), 0)::int AS cost_cents
      FROM agent_model_calls
      WHERE workspace_id=? AND created_at >= ?
      GROUP BY model, COALESCE(usage_reported, FALSE)
      ORDER BY cost_cents DESC, model ASC
    `
      )
      .all<ModelCallRow>(workspaceId, sinceIso),

    db
      .prepare(
        `
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='completed')::int AS completed,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE status='stopped')::int AS stopped,
        COUNT(*) FILTER (WHERE status='running')::int AS running
      FROM agent_runs
      WHERE workspace_id=? AND started_at >= ?
    `
      )
      .get<LoopCostAgentRuns>(workspaceId, sinceIso),

    // The outreach funnel. Its `series` is the windowed half -- `total` is
    // all-time and would quietly widen this payload's period if used here.
    linkedinAnalytics(db, workspaceId, days, now),

    // Per kind, through the helper that owns which statuses count. Iterating
    // ACTION_KIND_VALUES rather than a local list means a kind added to the
    // taxonomy shows up here without this file being touched.
    Promise.all(
      ACTION_KIND_VALUES.map(async (kind) => ({
        kind,
        count: await countActionsInWindow(db, seat, kind, sinceHours, now)
      }))
    )
  ]);

  const byModel: LoopCostModelLine[] = modelCalls.map((row) => ({
    model: row.model,
    calls: Number(row.calls),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    costCents: Number(row.cost_cents),
    usageReported: row.usage_reported === true,
    confidence: row.usage_reported === true ? 'HARD FACT' : 'REPORTED'
  }));

  const actions = actionCounts.filter((entry) => entry.count > 0);
  const windowed = analytics.series.reduce(
    (sum, day) => ({ accepted: sum.accepted + day.accepted, replied: sum.replied + day.replied }),
    { accepted: 0, replied: 0 }
  );

  return {
    windowDays: days,
    since: sinceIso,
    spent: {
      budget,
      calls: byModel.reduce((sum, line) => sum + line.calls, 0),
      costCents: byModel.reduce((sum, line) => sum + line.costCents, 0),
      byModel
    },
    sent: {
      actions,
      actionsTotal: actions.reduce((sum, entry) => sum + entry.count, 0),
      agentRuns: agentRuns ?? { total: 0, completed: 0, failed: 0, stopped: 0, running: 0 }
    },
    produced: {
      accepted: windowed.accepted,
      replied: windowed.replied
    }
  };
}
