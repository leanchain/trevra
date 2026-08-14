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

/* ---------------------------------------------------------------------------
 * The multi-tenant sweep.
 * ------------------------------------------------------------------------ */

/** Advisory-lock namespace for "this workspace's cycle is being run". */
const LEASE_NAMESPACE = 'trevra-automation-cycle';

export interface AutomationSweepResult {
  /** Workspaces this process leased and ran. */
  claimed: number;
  /** Workspaces another worker already held. Not an error, and no work lost. */
  skipped: number;
  /** Cycles that threw. Each is isolated to its own workspace. */
  failed: number;
  /** Workspaces the budget ran out before starting. The next tick takes them. */
  deferred: number;
}

export interface AutomationSweepOptions {
  /** Workspaces run at once. Each holds a pooled connection while it runs. */
  concurrency?: number;
  /** Workspaces considered per tick, taken in rotation. */
  batchSize?: number;
  /** Budget for STARTING work. Nothing already in flight is interrupted. */
  budgetMs?: number;
  /**
   * The per-workspace cycle, injectable so the sweep's own behaviour --
   * concurrency, leasing, isolation, rotation -- is testable without standing
   * up a workspace's worth of rules and recommendations for each tenant.
   * Production passes nothing.
   */
  runCycle?: (db: Db, workspaceId: string) => Promise<unknown>;
}

/**
 * Where the next tick starts. Process-lifetime, deliberately not persisted.
 *
 * ROTATION IS THE FAIRNESS. The unbounded `SELECT id FROM workspaces` this
 * replaces returned every tenant in the same order every minute, and ran them
 * one after another in one process: at a thousand tenants the tail of that list
 * was reached only if the head was quick, and a single slow or erroring tenant
 * pushed everybody behind it into the next tick -- permanently, because the
 * next tick started from the head again. A cursor plus a bounded batch means
 * the tick after a bad one starts where the bad one stopped, so the cost of
 * being tenant 900 is a wait, never starvation.
 *
 * In-process rather than a table because it is a HINT, not a fact: the lease
 * below is what prevents duplicate work, so a cursor lost to a restart costs at
 * most one tick of overlap, and persisting it would have cost a migration --
 * plus a write per tick on the hottest loop in the system.
 */
let rotationCursor = '';

/** Test seam: the worker keeps one cursor for its whole life. */
export function resetAutomationRotation(): void {
  rotationCursor = '';
}

/**
 * One tick of automation across the tenants this worker can get to.
 *
 * THREE PROPERTIES, and the old loop had none of them:
 *
 *   BOUNDED CONCURRENCY. Tenants run `concurrency` at a time instead of one at
 *   a time, so a tenant whose cycle takes ten seconds delays one lane rather
 *   than every tenant after it. Bounded rather than `Promise.all` over the
 *   batch because each cycle borrows a pooled connection: unbounded fan-out
 *   over a thousand tenants would exhaust a ten-connection pool instantly and
 *   turn a slow tick into a failed one.
 *
 *   A LEASE. Each workspace is claimed with a session-scoped advisory lock, so
 *   several workers can run this loop against one database and divide the
 *   tenants between them instead of all doing the same ones. Advisory locks
 *   rather than a claimed_at column -- the house `FOR UPDATE SKIP LOCKED`
 *   pattern in linkedin/local-worker.ts claims a ROW it is about to update, and
 *   here there is no row to update and no schema to add one to; a lock keyed on
 *   the workspace id says exactly "somebody is running this tenant" and, being
 *   tied to the session, is released by the death of the worker holding it. No
 *   stale-lease reaper, no clock assumptions.
 *
 *   ISOLATION. A cycle that throws costs its own tenant and nothing else: it is
 *   counted, logged and left for the next tick.
 *
 * lc-debt: a tenant already in flight is never preempted, so one cycle stuck on
 * a slow query holds its lane until it returns; upgrade path is a per-tenant
 * statement timeout set on the cycle's own connection, which needs the cycle to
 * take a connection rather than the pooled handle.
 *
 * The budget bounds the whole tick instead of any single tenant, because
 * abandoning a cycle mid-flight would leave its queries running with nobody
 * waiting for them. The worker will not start a new tick while this one runs,
 * so a tick that overruns starves the playbook engine and the schedule sweep
 * that share its interval; stopping at the budget and resuming from the cursor
 * next time is what keeps that interval honest.
 */
export async function runAllAutomationCycles(db: Db, options: AutomationSweepOptions = {}): Promise<AutomationSweepResult> {
  const concurrency = Math.max(1, options.concurrency ?? envInt('TREVRA_AUTOMATION_CONCURRENCY', 4));
  const batchSize = Math.max(1, options.batchSize ?? envInt('TREVRA_AUTOMATION_BATCH', 100));
  const budgetMs = options.budgetMs ?? envInt('TREVRA_AUTOMATION_BUDGET_MS', 45_000);
  const cycle = options.runCycle ?? runAutomationCycle;
  const result: AutomationSweepResult = { claimed: 0, skipped: 0, failed: 0, deferred: 0 };

  const workspaceIds = await nextWorkspaceBatch(db, batchSize);
  if (workspaceIds.length === 0) return result;

  const deadline = Date.now() + budgetMs;
  // ONE connection for every lease this tick takes. Advisory locks are per
  // session and several may be held on one, so leasing costs one connection for
  // the tick rather than one per tenant -- which matters against a pool of ten.
  // The watchdog is told the tick's own budget: this checkout is SUPPOSED to be
  // long, and a warning printed every minute is a warning nobody reads.
  await db.withConnection('automation-lease', async (lease) => {
    // ONE CONNECTION, SEVERAL WORKERS, SO THE LOCK CALLS QUEUE HERE RATHER THAN
    // IN THE DRIVER. A pg client executes one query at a time and merely warns
    // when a second is handed to it mid-flight -- a warning that becomes an
    // error in pg 9. This chain is the queue, made explicit.
    let pending: Promise<unknown> = Promise.resolve();
    const onLease = <T>(work: () => Promise<T>): Promise<T> => {
      const next = pending.then(work, work);
      pending = next.catch(() => undefined);
      return next;
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= workspaceIds.length) return;
        const workspaceId = workspaceIds[index];
        if (Date.now() >= deadline) { result.deferred += 1; continue; }
        const claimed = await onLease(() => lease.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
          [LEASE_NAMESPACE, workspaceId]
        ));
        if (!claimed.rows[0]?.locked) { result.skipped += 1; continue; }
        try {
          await cycle(db, workspaceId);
          result.claimed += 1;
        } catch (error) {
          result.failed += 1;
          console.error(`Automation cycle failed for workspace ${workspaceId}`, error);
        } finally {
          await onLease(() => lease.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [LEASE_NAMESPACE, workspaceId]));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, workspaceIds.length) }, () => worker()));
  }, budgetMs + 5_000);

  return result;
}

/**
 * The next `batchSize` workspaces after the cursor, wrapping once at the end.
 *
 * Keyset rather than OFFSET so the scan stays an index read on the primary key
 * whatever the tenant count, and wrapping in the same call so a deployment with
 * fewer tenants than one batch still sees all of them every tick. The cursor
 * lands on the last id actually taken, including one taken from the wrap, so
 * the following tick continues past it rather than replaying the head.
 */
async function nextWorkspaceBatch(db: Db, batchSize: number): Promise<string[]> {
  const rows = await db.prepare('SELECT id FROM workspaces WHERE id > ? ORDER BY id LIMIT ?').all<{ id: string }>(rotationCursor, batchSize);
  const ids = rows.map((row) => row.id);
  if (ids.length < batchSize && rotationCursor !== '') {
    const seen = new Set(ids);
    const head = await db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT ?').all<{ id: string }>(batchSize - ids.length);
    for (const row of head) if (!seen.has(row.id)) ids.push(row.id);
  }
  rotationCursor = ids.length > 0 ? ids[ids.length - 1] : '';
  return ids;
}

/** An integer from the environment, or the default. Empty is not zero. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
