import type { Db } from './db.js';
import { id } from './db.js';
import { runAccountSweep } from './accounts/sweep.js';
import { rescoreAccounts } from './accounts/score.js';
import { rejectedSignalShapes } from './accounts/store.js';
import { approveActionByRule, executeAction, prepareAction } from './action-service.js';

/**
 * Accounts swept per cycle. Small on purpose: a pass paces itself 20-90s
 * between accounts, and this cycle also drives the action queue, so a big batch
 * would hold everything else behind a sequence of sleeps. Two a minute is
 * ~2,880 a day against a 24h sweep interval -- far more headroom than any
 * account list has -- and whatever is left simply stays due for the next tick.
 *
 * lc-debt: shares `cycle()` with the action queue, so a slow host still delays
 * the rest of the pass by up to one gap; upgrade path is its own loop and
 * in-flight flag in the worker, exactly as the LinkedIn batch already has.
 */
const SWEEP_ACCOUNTS_PER_CYCLE = 2;

export interface AutomationResult {
  prepared: number;
  executed: number;
  failed: number;
}

export async function runAutomationCycle(db: Db, workspaceId: string): Promise<AutomationResult> {
  const result: AutomationResult = { prepared: 0, executed: 0, failed: 0 };

  // The account signal sweep. Guarded by a single indexed existence check
  // because most workspaces have no accounts at all, and claiming on an empty
  // table once a minute per workspace is a query bought for nothing. The sweep
  // itself never throws -- a dead host is a recorded `sweep_error` -- so this
  // catch is only for the case it is wrong about that, and it must not cost the
  // action queue its turn.
  const sweepable = await db.prepare(
    "SELECT id FROM accounts WHERE workspace_id=? AND status='active' LIMIT 1"
  ).get<{ id: string }>(workspaceId);
  if (sweepable) {
    try {
      const sweep = await runAccountSweep(db, workspaceId, {}, { maxAccounts: SWEEP_ACCOUNTS_PER_CYCLE });
      // SCORING FOLLOWS THE SWEEP IN THE SAME TURN, and only over the accounts
      // that were actually touched. A signal stored but never scored is a row
      // no screen ranks and no operator sees, which is the same as not having
      // read the page at all -- and rescoring the whole workspace to catch two
      // changed accounts would be a full table pass every minute.
      //
      // The operator's own rejections are passed in rather than looked up
      // inside the scorer: what "not a fit" means is a fact about this
      // workspace's judgement, and the scorer stays a pure function of the
      // signals plus that judgement.
      if (sweep.accountIds.length > 0) {
        const rejectedShapes = await rejectedSignalShapes(db, workspaceId);
        await rescoreAccounts(db, workspaceId, sweep.accountIds, { rejectedShapes });
      }
    } catch {
      result.failed += 1;
    }
  }
  const scheduled = await db.prepare(`
    SELECT id FROM actions
    WHERE workspace_id=? AND status='scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?
    ORDER BY scheduled_for LIMIT 50
  `).all<{ id: string }>(workspaceId, new Date().toISOString());
  for (const action of scheduled) {
    try {
      await executeAction(db, workspaceId, action.id);
      result.executed += 1;
    } catch {
      result.failed += 1;
    }
  }

  const rules = await db.prepare(`
    SELECT * FROM automation_rules WHERE workspace_id=? AND enabled=1 AND mode IN ('prepare','execute')
  `).all<Record<string, unknown>>(workspaceId);

  for (const rule of rules) {
    const recommendations = await db.prepare(`
      SELECT * FROM recommendations
      WHERE workspace_id=? AND type=? AND status IN ('ready','approved')
        AND confidence >= ? AND estimated_amount <= ?
        AND created_at + (? * INTERVAL '1 minute') <= CURRENT_TIMESTAMP
      ORDER BY priority_score DESC
    `).all<Record<string, unknown>>(
      workspaceId,
      String(rule.recommendation_type),
      Number(rule.min_confidence),
      Number(rule.max_amount),
      Number(rule.delay_minutes)
    );

    for (const recommendation of recommendations) {
      try {
        const action = await prepareAction(db, workspaceId, String(recommendation.id));
        if (action.status === 'draft' || action.status === 'failed') result.prepared += 1;
        if (rule.mode !== 'execute') continue;
        if (String(rule.recommendation_type) === 'scope_creep') continue;

        let approved = action;
        if (action.status === 'draft' || action.status === 'failed') {
          approved = await approveActionByRule(db, workspaceId, String(rule.id), action.id, {
            recipient: action.recipient,
            subject: action.subject,
            body: action.body
          });
        }
        if (approved.status === 'approved') {
          await executeAction(db, workspaceId, approved.id);
          result.executed += 1;
        }
      } catch (error) {
        result.failed += 1;
        await db.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id('audit'), workspaceId, 'automation', String(rule.id), 'automation.failed', 'recommendation', String(recommendation.id),
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), new Date().toISOString());
      }
    }
  }
  return result;
}

export async function runAllAutomationCycles(db: Db): Promise<void> {
  const workspaces = await db.prepare('SELECT id FROM workspaces').all<{ id: string }>();
  for (const workspace of workspaces) await runAutomationCycle(db, workspace.id);
}
