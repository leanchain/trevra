import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { id, type Db } from '../db.js';
import { readLinkedInCredentials } from '../secrets/linkedin.js';
import type { LinkedInActionKind, LinkedInActionStatus } from './actions.js';
import {
  evaluateBranches,
  hasBranching,
  type BranchActionRow,
  type BranchOutcome,
  type BranchableStep,
  type StepCondition
} from './branching.js';
import {
  isSeatRead,
  playwrightDriver,
  type LinkedInDriver,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInPage
} from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { ACTION_GAP_SECONDS, type PacedKind } from './limits.js';
import {
  OWNER_SEAT_KEY,
  assertTimezone,
  getSeat,
  getSeatPosture,
  stampSeatSessionValid,
  upsertSeat,
  type LinkedInSeat,
  type SeatPosture
} from './seats.js';

/**
 * The local Playwright worker (plan 4.5, 4.6): claim a due action, re-run the
 * safety gate against it, execute it in the operator's own browser, record
 * what happened.
 *
 * SELF-HOSTED ONLY. Nothing in this file runs unless `config.ts` says
 * `linkedinLocalWorker.enabled`, which is false on any hosted instance by
 * construction (plan 4.3).
 *
 * ONE WAY INTO LINKEDIN, AND THE SESSION IS ALWAYS TRIED FIRST. A self-hoster's
 * own email and password, sealed in `workspace_secrets`, is opened only inside
 * `loginLinkedInSeat` and handed straight to the driver. `isLoggedIn` runs
 * before any sign-in -- a stored session that still works is reused, because
 * re-authenticating every run is slower and a much stronger ban signal than a
 * session that simply keeps working.
 *
 * FOUR INVARIANTS, and each one exists because breaking it is how a LinkedIn
 * account dies:
 *
 * 1. THE GATE RUNS PER ACTION, IMMEDIATELY BEFORE EXECUTION -- never once per
 *    batch. A plan approved on Monday can be stale by Thursday because the
 *    operator did things by hand in between, and only the ledger knows. Same
 *    discipline as `assertPostingWindow()` in `outreach/publish.ts`: approval
 *    is a decision about CONTENT, and the clock keeps moving afterwards.
 * 2. CLAIM BEFORE ACT, AND ONLY DEFINITE FAILURES RELEASE. Mirrors the
 *    `outreach_posts` pattern. An outcome we never learned (`unknown`) HOLDS
 *    its claim forever rather than being retried, because a duplicate invite
 *    cannot be withdrawn from the recipient's notifications.
 * 3. LINKEDIN'S "STOP" ENDS THE BATCH. `limit_wall` and `challenge` put the
 *    seat in `cooldown` and halt. Continuing past either is what escalates a
 *    temporary restriction into a permanent ban (plan 1.3).
 * 4. NO `Math.random()`. The inter-action gap is drawn from a generator seeded
 *    by the batch and action ids, so the same batch produces the same pacing
 *    on any machine and any Node version -- and a test can assert the delays
 *    instead of tolerating them.
 *
 * The loop talks to Postgres through {@link LocalWorkerStore} rather than
 * inline SQL. That is not architecture for its own sake: it is what lets the
 * tests drive every one of the four invariants above with a fake driver and no
 * database and, above all, NO REAL LINKEDIN CALL.
 */

/**
 * The kinds this worker will execute.
 *
 * A KIND BELONGS HERE EXACTLY WHEN A DRIVER ROUTINE PERFORMS IT. `inmail` is
 * deliberately absent even though it is paced: `driver.ts` has no InMail
 * routine, and claiming an action nothing can perform would wedge it under a
 * claim forever. `comment` is absent for the same reason and has no band
 * either.
 *
 * `reply` and the three engagement kinds joined when `driver-inbox.ts` and
 * `driver-engage.ts` gave them routines. Every one of them still goes through
 * `evaluateLinkedInSafety` at the moment of execution, unfiltered -- being
 * cheap to perform is not a reason to be ungated, and liking two hundred posts
 * in an hour is a ban signal however harmless one like is.
 */
export type ExecutableKind = 'invite' | 'dm' | 'reply' | 'profile_view' | 'follow' | 'like' | 'endorse';
export const EXECUTABLE_KINDS: readonly ExecutableKind[] = [
  'invite',
  'dm',
  'reply',
  'profile_view',
  'follow',
  'like',
  'endorse'
];

/** One claimed row, as the loop needs it. */
export interface DueLinkedInAction {
  id: string;
  workspaceId: string;
  seatKey: string;
  kind: ExecutableKind;
  targetRef: string;
  /** ISO-8601. The paced slot, and what the gate judges business hours against. */
  plannedFor: string;
  /** The approved bytes: an invite note, a DM body, a reply. Null for the passive kinds. */
  body: string | null;
  /**
   * The conversation a `reply` answers in. Null for every other kind.
   *
   * A reply is addressed by THREAD, not by profile: `sendDm` navigates to a
   * profile and opens a fresh composer, which for somebody already in the
   * inbox is the wrong surface. Written by `enqueueReply` (migration 035) and
   * required by the claim, so a reply row that lost its thread is not
   * claimable rather than claimable-and-unsendable.
   */
  threadUrn?: string | null;
}

export type BatchStatus = 'completed' | 'halted';

export interface LocalBatchResult {
  batchId: string | null;
  workspaceId: string;
  /** Actions the driver reported `ok` for. */
  executed: number;
  /** Claimed, refused by the gate, released untouched. */
  blocked: number;
  /** Claimed, attempted, and failed for any reason. */
  failed: number;
  /** Claimed, and settled 'skipped' because its branch will never be satisfied. */
  branchSkipped: number;
  /** Claimed, released, and left planned because its branch has no answer yet. */
  branchPending: number;
  halted: boolean;
  /** Why the batch stopped early, for an operator reading it later. */
  haltReason: string | null;
}

/** What a branch says about one claimed action, in the evaluator's own words. */
export interface BranchGateDecision {
  outcome: BranchOutcome;
  reason: string;
}

/**
 * Everything the loop does to the database, behind one seam.
 *
 * Implemented for real by {@link postgresLocalWorkerStore}. The seam exists so
 * the invariants above are testable without Postgres and without a browser;
 * every method here is three to six lines of SQL there.
 */
export interface LocalWorkerStore {
  readonly workspaceId: string;
  /** The EFFECTIVE posture (seats.ts derives warmup/steady). Null means no seat. */
  seatPosture(now: Date): Promise<SeatPosture | null>;
  /** Open a stoppable batch and return its id. */
  openBatch(now: Date): Promise<string>;
  closeBatch(batchId: string, outcome: { status: BatchStatus; haltReason: string | null; executed: number }, now: Date): Promise<void>;
  /** True when this batch must stop -- see `isAgentRunStopRequested` for the shape. */
  stopRequested(batchId: string): Promise<boolean>;
  /**
   * Atomically claim the oldest due action, or null when there is none.
   *
   * `exclude` names rows this PASS has already looked at and deferred -- a
   * branch that is still undecided releases its claim and leaves the row
   * planned, and without this the very next claim would hand back the same
   * row, forever, and no other action in the queue would ever be reached.
   */
  claimNextDueAction(batchId: string, now: Date, exclude?: readonly string[]): Promise<DueLinkedInAction | null>;
  /** Nothing was sent: put the action back in the queue, recording why. */
  releaseClaim(actionId: string, failureKind: LinkedInFailureKind | null): Promise<void>;
  settleSent(actionId: string, externalRef: string | null, now: Date): Promise<void>;
  settleSkipped(actionId: string, failureKind: LinkedInFailureKind): Promise<void>;
  /**
   * This step's branch can never be satisfied: retire the row.
   *
   * Separate from `settleSkipped` because the two are different facts and only
   * one of them is a driver outcome. `failure_kind` is a `LinkedInFailureKind`
   * and a branch that resolved to "they never accepted" is not a failure of
   * anything -- it is the sequence working. The status is the same ('skipped':
   * nothing went out, the target is released) and the reason is the
   * evaluator's own sentence.
   */
  settleBranchSkipped(actionId: string, reason: string): Promise<void>;
  /**
   * What this action's branch says right now, or null when nothing branches.
   *
   * Null covers three cases that are all "run it": the action belongs to no
   * campaign, the campaign's sequence has no conditions at all, or no step in
   * that sequence matches this row. A store that cannot answer THROWS rather
   * than returning null -- "I could not find out whether this step should run"
   * is not "run it", and the loop treats a throw exactly as it treats a gate
   * that could not be evaluated.
   */
  branchDecision(action: DueLinkedInAction, now: Date): Promise<BranchGateDecision | null>;
  /** Outcome unknown: KEEP the claim so no retry can duplicate it. */
  holdClaim(actionId: string, failureKind: LinkedInFailureKind): Promise<void>;
  enterCooldown(now: Date): Promise<void>;
}

export interface LocalBatchDeps {
  driver: LinkedInDriver;
  page: LinkedInPage;
  /** Defaults to `evaluateLinkedInSafety`. Injected so a test can count calls. */
  evaluate: (action: DueLinkedInAction, now: Date) => Promise<LinkedInSafetyVerdict>;
  now?: () => Date;
  /** Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Hard stop on one pass, so a stuck batch cannot hold a tick open forever. */
  maxActions?: number;
  log?: (message: string) => void;
}

/**
 * The most actions one pass will take.
 *
 * Not a pacing limit -- the gate owns those. This is the bound that keeps one
 * tick finite: at the maximum gap, 25 actions is roughly 50 minutes, which is
 * already far longer than an automation interval.
 */
const DEFAULT_MAX_ACTIONS = 25;

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * mulberry32, seeded from a hash of the batch and action ids.
 *
 * Deliberately the same generator as `pacing.ts` uses for slot jitter, for the
 * same reason: the requirement is that identical inputs produce identical
 * timing on every machine and every Node version, and `Math.random()`
 * guarantees the opposite. (It is copied rather than imported because
 * `pacing.ts` keeps it private, and reaching into another module's internals
 * to save six lines is a worse trade than the six lines.)
 */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Seconds to wait before the next action, drawn from ACTION_GAP_SECONDS.
 *
 * The plan asks for "randomised 30-120s gaps" (1.4), and randomised here means
 * UNPREDICTABLE TO LINKEDIN, not unreproducible to us. A seeded draw is both:
 * the sequence has no pattern a rate-limiter could key on, and re-running the
 * same batch produces the same gaps, so this is assertable rather than merely
 * hoped for.
 */
export function actionGapSeconds(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  const random = seededRandom(digest);
  return ACTION_GAP_SECONDS.min + random() * (ACTION_GAP_SECONDS.max - ACTION_GAP_SECONDS.min);
}

/**
 * Dispatch one claimed action to the routine that performs it.
 *
 * EXHAUSTIVE, AND LOUD WHEN IT IS NOT. This used to end in a bare
 * `return deps.driver.viewProfile(...)`, which read as a default and behaved as
 * a trapdoor: every kind that was not 'invite' or 'dm' fell through to a
 * profile view. That was harmless while `ExecutableKind` had three members and
 * became a silent wrong send the moment it had seven -- a `follow` row would
 * have been claimed, gated, settled 'sent', and recorded in the ledger as a
 * follow that never happened, while the seat actually loaded a profile. The
 * ledger is the single input the whole pacing engine reasons from, so a wrong
 * row there is worse than a failed action.
 *
 * The `never` binding below is the enforcement: adding a kind to
 * `ExecutableKind` without adding a case here stops compiling. If one somehow
 * arrives at runtime -- a ledger row whose `kind` the claim query allowed and
 * this union does not -- it is reported as `unknown`, which HOLDS the claim and
 * halts the batch. That is the loudest outcome available to a function that
 * must not throw, and it is the right one: a row nobody can perform should
 * stop the pass and wait for a human, not be quietly retried.
 *
 * `seed` is the batch-scoped seed (`${batchId}:${action.id}`), threaded through
 * to the routines that pause BETWEEN CLICKS inside one action. Same discipline
 * as `actionGapSeconds`: randomised means unpredictable to LinkedIn, never
 * unreproducible to us, and there is no `Math.random()` on this path.
 */
async function execute(deps: LocalBatchDeps, action: DueLinkedInAction, seed: string): Promise<LinkedInDriverResult> {
  switch (action.kind) {
    case 'invite':
      return deps.driver.sendInvite(deps.page, action.targetRef, action.body ?? undefined);
    case 'dm':
      return deps.driver.sendDm(deps.page, action.targetRef, action.body ?? '');
    case 'reply': {
      // Unreachable through the claim, which requires a thread_urn on a reply.
      // Reported rather than asserted, because the alternative -- falling back
      // to `sendDm` -- is exactly the silent substitution this function exists
      // to stop, and it would open a second conversation with somebody who is
      // already in one.
      if (!action.threadUrn) {
        return {
          ok: false,
          failureKind: 'not_found',
          detail: `Action ${action.id} is a reply with no conversation to answer in, so there is nothing to send it to. Re-sync the inbox and queue the reply again.`
        };
      }
      return deps.driver.sendReply(deps.page, action.threadUrn, action.body ?? '');
    }
    case 'profile_view':
      return deps.driver.viewProfile(deps.page, action.targetRef);
    case 'follow':
      return deps.driver.followProfile(deps.page, action.targetRef);
    case 'like':
      return deps.driver.likeRecentPost(deps.page, action.targetRef, { seed });
    case 'endorse':
      return deps.driver.endorseSkills(deps.page, action.targetRef, { seed });
    default: {
      const unhandled: never = action.kind;
      return {
        ok: false,
        failureKind: 'unknown',
        detail: `Action ${action.id} has kind '${String(unhandled)}', which this worker has no routine for. Nothing was attempted; the row is held under its claim rather than run as something else.`
      };
    }
  }
}

/**
 * One pass over one workspace's due actions.
 *
 * Returns rather than throws: a batch that ends early has still done real
 * things to a real account, and the caller needs the count more than it needs
 * a stack trace.
 */
export async function runLinkedInLocalBatch(store: LocalWorkerStore, deps: LocalBatchDeps): Promise<LocalBatchResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((message: string) => console.log(message));
  const maxActions = Math.max(1, Math.trunc(deps.maxActions ?? DEFAULT_MAX_ACTIONS));
  const result: LocalBatchResult = {
    batchId: null,
    workspaceId: store.workspaceId,
    executed: 0,
    blocked: 0,
    failed: 0,
    branchSkipped: 0,
    branchPending: 0,
    halted: false,
    haltReason: null
  };

  /**
   * Rows this pass has already looked at and put back.
   *
   * A branch that is still undecided releases its claim, because the action has
   * not been refused -- it is waiting for an answer that may arrive tomorrow.
   * Released rows are immediately claimable again and the claim is ordered by
   * `planned_for ASC`, so without this set the loop would hand itself the same
   * row on every iteration and burn the whole pass on one pending step while
   * everything behind it stayed due.
   */
  const deferred: string[] = [];

  // Checked before a batch is even opened. A seat that is paused or cooling
  // down is a decision a human (or a limit wall) made, and opening a batch
  // against it would be the loop asking the question again until it liked the
  // answer.
  const posture = await store.seatPosture(now());
  const refusal = postureRefusal(posture);
  if (refusal) return { ...result, halted: true, haltReason: refusal };

  const batchId = await store.openBatch(now());
  result.batchId = batchId;

  for (let index = 0; index < maxActions; index += 1) {
    // THE KILL SWITCH, read from Postgres between every action. The process
    // that receives the stop (the API) is not the process running this loop,
    // so an in-memory flag could not reach it -- exactly the reasoning behind
    // `agent_runs.stop_requested_at` in migration 021.
    if (await store.stopRequested(batchId)) {
      result.halted = true;
      result.haltReason = 'A stop was requested for this batch.';
      break;
    }

    // Re-read every pass, so pausing the seat stops the loop within one tick
    // rather than at the end of the batch.
    const current = postureRefusal(await store.seatPosture(now()));
    if (current) {
      result.halted = true;
      result.haltReason = current;
      break;
    }

    const action = await store.claimNextDueAction(batchId, now(), deferred);
    if (!action) break;

    /**
     * THE BRANCH, EVALUATED IN THE LOOP AND NOT IN THE CLAIM.
     *
     * It could not be in the SQL and should not be: deciding a branch needs the
     * campaign's whole sequence, its start instant, and every ledger row
     * against this one target, and `evaluateBranches` is the one place those
     * three are read together. Expressing it as a WHERE clause would be a
     * second implementation of the evaluator in jsonpath, which is the
     * unreviewable thing `branching.ts` was written to avoid -- and it would
     * silently disagree with the tested one.
     *
     * It runs AFTER the claim so the row is not handed to another worker while
     * this one is deciding, and BEFORE the gate so a step that is not supposed
     * to run at all never costs a gate evaluation, a gap, or a page load.
     *
     * Three answers, three different things to do, and none of them is "send
     * it anyway":
     *   skipped -- the branch can never be satisfied (they declined; the step
     *              it waits on was itself skipped). Settled 'skipped': nothing
     *              went out, the target is released.
     *   pending -- no answer yet. "Not yet" is not "no", so the claim is
     *              released and the row stays planned for a later pass.
     *   due     -- run it, through every gate below, unchanged.
     */
    let branch: BranchGateDecision | null;
    try {
      branch = await store.branchDecision(action, now());
    } catch (cause) {
      // Same rule as a gate that throws: "I could not find out whether this
      // should run" is not "it should run".
      await store.releaseClaim(action.id, null);
      result.blocked += 1;
      result.halted = true;
      result.haltReason = `The branch for action ${action.id} could not be evaluated: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }

    if (branch && branch.outcome === 'skipped') {
      await store.settleBranchSkipped(action.id, branch.reason);
      result.branchSkipped += 1;
      log(`LinkedIn local worker retired action ${action.id}: ${branch.reason}`);
      continue;
    }
    if (branch && branch.outcome === 'pending') {
      await store.releaseClaim(action.id, null);
      deferred.push(action.id);
      result.branchPending += 1;
      log(`LinkedIn local worker deferred action ${action.id}: ${branch.reason}`);
      continue;
    }

    // The gap goes BEFORE the gate, not after it: the gate's verdict has to be
    // the last thing that happens before the driver touches LinkedIn, and a
    // 30-120s sleep in between would make it stale by exactly that much.
    if (index > 0) await sleep(Math.round(actionGapSeconds(`${batchId}:${action.id}`) * 1000));

    const at = now();
    let verdict: LinkedInSafetyVerdict;
    try {
      verdict = await deps.evaluate(action, at);
    } catch (cause) {
      // "I could not find out whether this is safe" is not "it is safe".
      await store.releaseClaim(action.id, null);
      result.blocked += 1;
      result.halted = true;
      result.haltReason = `The safety gate could not be evaluated: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }

    // NO FILTERING OF THE VERDICT, ANYWHERE. Every check the gate fails blocks
    // the action, full stop. The one refusal this loop used to discount --
    // `duplicate-target` firing on the claimed row itself -- is now the gate's
    // own business, via `excludeActionId` (guard.ts): the row under evaluation
    // is excluded by primary key before the check runs, so any OTHER row
    // against that target still fails it. "Ignore the guard under conditions
    // X" does not belong on this side of the call, because the next edit is
    // what widens X.
    if (!verdict.allowed) {
      await store.releaseClaim(action.id, null);
      result.blocked += 1;
      log(`LinkedIn local worker skipped action ${action.id}: ${verdict.reason ?? 'the safety gate refused it'}`);
      continue;
    }

    // One seed per (batch, action), the same string the inter-action gap is
    // drawn from, so the whole of a batch's timing -- between actions and
    // within one -- is reproducible from two ids in the ledger.
    const outcome = await execute(deps, action, `${batchId}:${action.id}`);

    if (outcome.ok) {
      await store.settleSent(action.id, outcome.externalRef ?? null, at);
      result.executed += 1;
      continue;
    }

    result.failed += 1;
    const failureKind = outcome.failureKind ?? 'unknown';
    const detail = outcome.detail ? ` ${outcome.detail}` : '';

    if (failureKind === 'limit_wall' || failureKind === 'challenge') {
      // LINKEDIN SAID STOP. Nothing was sent, so the claim is released -- but
      // the seat goes into cooldown and this batch is over. The next pass will
      // refuse to open a batch at all until a human resumes the seat, which is
      // the point: whatever produced this needs a person, not a retry.
      await store.releaseClaim(action.id, failureKind);
      await store.enterCooldown(at);
      result.halted = true;
      result.haltReason = `LinkedIn returned a ${failureKind === 'limit_wall' ? 'limit wall' : 'challenge'}; the seat is now in cooldown and this batch stopped.${detail}`;
      break;
    }

    if (failureKind === 'not_found' || failureKind === 'already_connected') {
      // Definite, and no retry will change it. 'skipped' keeps it out of every
      // rolling window (it never happened) and releases the target, which is
      // what the ledger's replay guard treats 'skipped' as meaning.
      await store.settleSkipped(action.id, failureKind);
      continue;
    }

    if (failureKind === 'selector_drift') {
      // Nothing was clicked (driver.ts guarantees it), so the action goes back
      // in the queue untouched. The batch still ends: if one selector has
      // drifted, the next action would load a page for nothing, and hammering
      // LinkedIn with pointless profile loads is its own risk.
      await store.releaseClaim(action.id, failureKind);
      result.halted = true;
      result.haltReason = `A selector no longer matches, so this batch stopped rather than reloading profiles for nothing. Repair SELECTORS in driver.ts.${detail}`;
      break;
    }

    // `unknown`: we clicked and lost the thread. HOLD the claim -- a retry
    // would risk a second invite to the same person, and that cannot be
    // undone. A human settles this row.
    await store.holdClaim(action.id, failureKind);
    result.halted = true;
    result.haltReason = `The outcome of action ${action.id} is unknown, so it is held under its claim for a human to settle and this batch stopped.${detail}`;
    break;
  }

  await store.closeBatch(
    batchId,
    { status: result.halted ? 'halted' : 'completed', haltReason: result.haltReason, executed: result.executed },
    now()
  );
  return result;
}

/** Why this seat may not be worked, or null when it may. */
function postureRefusal(posture: SeatPosture | null): string | null {
  if (posture === null) return 'No LinkedIn seat is configured for this workspace, so there is nothing to pace against.';
  if (posture === 'paused') return 'The seat is paused.';
  if (posture === 'cooldown') {
    // STRICTER THAN THE GATE, DELIBERATELY. `evaluateLinkedInSafety` lets a
    // cooling seat act at the conservative band, which is right for a human
    // deciding what to do next. It is not right for an unattended browser: a
    // seat is in cooldown because LinkedIn pushed back, and the thing that
    // clears it is a person calling `resumeSeat()`, not time passing.
    return 'The seat is in cooldown after a limit wall or challenge; resume it by hand once you know why.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface DueActionRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  kind: string;
  target_ref: string;
  planned_for: string;
  body: string | null;
  thread_urn: string | null;
}

const EXECUTABLE_KIND_LIST = EXECUTABLE_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * The kinds whose entire content is their approved copy. An empty one is
 * nothing to send.
 *
 * Exported because the claim's rule and the WRITERS' rule have to be the same
 * rule: `queue.ts` refuses to file a row this predicate would make unclaimable,
 * and a second hand-written `['dm', 'reply']` over there is how a queue that
 * silently never drains gets built.
 */
export const KINDS_REQUIRING_BODY: readonly ExecutableKind[] = ['dm', 'reply'];
const BODY_REQUIRED_LIST = KINDS_REQUIRING_BODY.map((kind) => `'${kind}'`).join(', ');

const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * A stored `sequence_json` as `branching.ts` needs it, or an empty list.
 *
 * DEFENSIVE BY DESIGN, and the failure direction is deliberate. This reads a
 * jsonb blob written by an approval that may predate every field below, so
 * anything it cannot recognise becomes "no steps", which `hasBranching`
 * answers false for, which means the action runs exactly as it did before
 * branching existed. The alternative -- throwing on a shape surprise -- would
 * halt a batch over a campaign's copy rather than over anything about the
 * seat.
 *
 * A condition it cannot read is DROPPED rather than guessed, and a dropped
 * condition means the step runs unconditionally. That is the one place here
 * that is not fail-closed, and it is bounded by the fact that
 * `validateSequenceSteps` and migration 033's CHECK both refuse an
 * unreadable condition at write time: to reach this branch a row would have to
 * have been written around both.
 */
function branchableSteps(sequence: unknown): BranchableStep[] {
  const raw = typeof sequence === 'string' ? safeJson(sequence) : sequence;
  if (typeof raw !== 'object' || raw === null) return [];
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];

  const parsed: BranchableStep[] = [];
  for (const entry of steps) {
    if (typeof entry !== 'object' || entry === null) continue;
    const step = entry as { id?: unknown; day?: unknown; kind?: unknown; condition?: unknown };
    if (typeof step.id !== 'string' || typeof step.kind !== 'string') continue;
    const condition =
      typeof step.condition === 'object' && step.condition !== null
        && typeof (step.condition as StepCondition).on === 'string'
        && typeof (step.condition as StepCondition).ofStepId === 'string'
        ? (step.condition as StepCondition)
        : null;
    parsed.push({
      id: step.id,
      day: typeof step.day === 'number' ? step.day : 0,
      kind: step.kind as LinkedInActionKind,
      condition
    });
  }
  return parsed;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function postgresLocalWorkerStore(db: Db, workspaceId: string, seatKey: string = OWNER_SEAT_KEY): LocalWorkerStore {
  return {
    workspaceId,

    async seatPosture(now) {
      return getSeatPosture(db, workspaceId, now);
    },

    async openBatch(now) {
      const batchId = id('lbatch');
      await db.prepare(`
        INSERT INTO linkedin_batches (id, workspace_id, seat_key, status, started_at)
        VALUES (?,?,?,'running',?)
      `).run(batchId, workspaceId, seatKey, now.toISOString());
      return batchId;
    },

    async closeBatch(batchId, outcome, now) {
      await db.prepare(`
        UPDATE linkedin_batches
        SET status=?, halt_reason=?, executed_count=?, finished_at=?
        WHERE id=? AND workspace_id=?
      `).run(outcome.status, outcome.haltReason, outcome.executed, now.toISOString(), batchId, workspaceId);
    },

    async stopRequested(batchId) {
      // Absent means STOP, exactly like `isAgentRunStopRequested`: a batch that
      // is no longer running, or whose row is gone, is not a batch to keep
      // acting for. A database error still throws -- "I could not find out" is
      // not "carry on".
      const row = await db.prepare(`
        SELECT 1 AS live FROM linkedin_batches
        WHERE id=? AND workspace_id=? AND status='running' AND stop_requested_at IS NULL
      `).get<{ live: number }>(batchId, workspaceId);
      return row === undefined;
    },

    async claimNextDueAction(batchId, now, exclude = []) {
      // CLAIM AND SELECT IN ONE STATEMENT. `FOR UPDATE SKIP LOCKED` means two
      // workers on the same box take different rows instead of the same one,
      // and `claimed_at IS NULL` means a held row (unknown outcome) is never
      // handed out again.
      const row = await db.prepare(`
        UPDATE linkedin_actions SET claimed_at=?, batch_id=?
        WHERE id = (
          SELECT id FROM linkedin_actions
          WHERE workspace_id=? AND seat_key=? AND status='planned' AND claimed_at IS NULL
            AND planned_for IS NOT NULL AND planned_for <= ?
            AND kind IN (${EXECUTABLE_KIND_LIST})
            AND target_ref IS NOT NULL
            -- A message with no approved body is not this worker's to send.
            -- Left planned rather than skipped: the export path can still
            -- deliver it, and "executes approved bytes only" (plan 4.6) means
            -- there is nothing here to execute.
            AND (kind NOT IN (${BODY_REQUIRED_LIST}) OR (body IS NOT NULL AND body <> ''))
            -- A reply is addressed by conversation. One that lost its thread is
            -- not claimable rather than claimable-and-unsendable, for the same
            -- reason as the body rule above.
            AND (kind <> 'reply' OR (thread_urn IS NOT NULL AND thread_urn <> ''))
            -- Rows this pass already deferred on a branch that has no answer
            -- yet. Excluded by id so the loop moves on instead of re-claiming
            -- the same undecided row until the pass is exhausted.
            AND NOT (id = ANY(?::text[]))
          ORDER BY planned_for ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, workspace_id, seat_key, kind, target_ref,
                  TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
                  body, thread_urn
      `).get<DueActionRow>(now.toISOString(), batchId, workspaceId, seatKey, now.toISOString(), [...exclude]);
      if (!row) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        seatKey: row.seat_key,
        kind: row.kind as ExecutableKind,
        targetRef: row.target_ref,
        plannedFor: row.planned_for,
        body: row.body,
        threadUrn: row.thread_urn
      };
    },

    async branchDecision(action, now) {
      const campaign = await db.prepare(`
        SELECT c.sequence_json AS sequence_json,
               TO_CHAR(c.created_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS created_at
        FROM linkedin_actions a
        JOIN linkedin_campaigns c ON c.id = a.campaign_id AND c.workspace_id = a.workspace_id
        WHERE a.id=? AND a.workspace_id=?
      `).get<{ sequence_json: unknown; created_at: string }>(action.id, workspaceId);
      // No campaign, or a campaign with no conditions: nothing to decide, and
      // the action runs exactly as it did before branching existed.
      if (!campaign) return null;

      const steps = branchableSteps(campaign.sequence_json);
      if (!hasBranching(steps)) return null;

      /**
       * WHICH STEP WROTE THIS ROW.
       *
       * By kind, because `linkedin_actions` carries no step id -- the same
       * fallback `branching.ts` `rowForStep` uses, deliberately, so the two
       * sides of the question resolve identically. Taking the first step of
       * this kind is what makes them agree.
       *
       * lc-debt: two dm steps against one target share a ledger row under the
       * 022 replay guard, so the second one's branch is decided from the
       * first's row; upgrade path is a `step_id` column on `linkedin_actions`
       * plus a widened replay guard, then match on it here and in `rowForStep`.
       */
      const index = steps.findIndex((step) => step.kind === action.kind);
      if (index === -1) return null;

      const rows = await db.prepare(`
        SELECT kind, status,
               TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for
        FROM linkedin_actions
        WHERE workspace_id=? AND seat_key=? AND target_ref=?
      `).all<{ kind: string; status: string; planned_for: string | null }>(workspaceId, action.seatKey, action.targetRef);

      const actions: BranchActionRow[] = rows.map((row) => ({
        kind: row.kind as LinkedInActionKind,
        status: row.status as LinkedInActionStatus,
        plannedFor: row.planned_for
      }));

      const evaluation = evaluateBranches({
        steps,
        targetRef: action.targetRef,
        actions,
        campaignStartedAt: new Date(campaign.created_at),
        now
      });
      const decision = evaluation.decisions[index];
      return decision ? { outcome: decision.outcome, reason: decision.reason } : null;
    },

    async releaseClaim(actionId, failureKind) {
      await db.prepare(`
        UPDATE linkedin_actions SET claimed_at=NULL, batch_id=NULL, failure_kind=?
        WHERE id=? AND workspace_id=?
      `).run(failureKind, actionId, workspaceId);
    },

    async settleSent(actionId, externalRef, now) {
      // `recorded_at` is what every rolling window counts, so it is written
      // here and nowhere else: the moment the action actually happened.
      await db.prepare(`
        UPDATE linkedin_actions
        SET status='sent', recorded_at=?, external_ref=?, failure_kind=NULL
        WHERE id=? AND workspace_id=?
      `).run(now.toISOString(), externalRef, actionId, workspaceId);
    },

    async settleSkipped(actionId, failureKind) {
      await db.prepare(`
        UPDATE linkedin_actions
        SET status='skipped', recorded_at=NULL, claimed_at=NULL, failure_kind=?
        WHERE id=? AND workspace_id=?
      `).run(failureKind, actionId, workspaceId);
    },

    // `_reason` is the evaluator's sentence and is deliberately not stored:
    // there is no column for it, and `failure_kind` is not one -- a branch that
    // resolved to "they never accepted" is the sequence working, and writing a
    // failure there would have the ledger report a driver problem that never
    // happened. It reaches the operator through the batch log instead.
    async settleBranchSkipped(actionId, _reason) {
      await db.prepare(`
        UPDATE linkedin_actions
        SET status='skipped', recorded_at=NULL, claimed_at=NULL, failure_kind=NULL
        WHERE id=? AND workspace_id=?
      `).run(actionId, workspaceId);
    },

    async holdClaim(actionId, failureKind) {
      // `claimed_at` is left exactly as it is. That is the hold.
      await db.prepare(`
        UPDATE linkedin_actions SET failure_kind=?
        WHERE id=? AND workspace_id=?
      `).run(failureKind, actionId, workspaceId);
    },

    async enterCooldown(now) {
      await upsertSeat(db, workspaceId, { posture: 'cooldown' }, now);
    }
  };
}

/**
 * Ask a workspace's running batches to stop. Mirrors `stopRunningAgentRuns`.
 *
 * The request and the outcome stay two different facts: this writes the
 * request, and only the loop that is actually driving a browser writes the
 * status. Asking twice keeps the original timestamp, so "when did somebody ask
 * for this to stop" survives an impatient second click.
 */
export async function stopLinkedInBatches(db: Db, workspaceId: string): Promise<number> {
  const result = await db.prepare(`
    UPDATE linkedin_batches SET stop_requested_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND status='running' AND stop_requested_at IS NULL
  `).run(workspaceId);
  return result.changes;
}

/** Workspaces with at least one claimable action due now. */
export async function workspacesWithDueActions(db: Db, now: Date): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT workspace_id FROM linkedin_actions
    WHERE status='planned' AND claimed_at IS NULL
      AND planned_for IS NOT NULL AND planned_for <= ?
      AND seat_key='owner'
      AND kind IN (${EXECUTABLE_KIND_LIST})
  `).all<{ workspace_id: string }>(now.toISOString());
  return rows.map((row) => row.workspace_id);
}

// ---------------------------------------------------------------------------
// Playwright, loaded only if it is there
// ---------------------------------------------------------------------------

export interface LinkedInLocalWorkerConfig {
  enabled: boolean;
  /** Absent means the default below. */
  profileDir?: string | null;
  /**
   * True on a hosted deployment, where `enabled` is false and cannot be made
   * true. Carried so a refusal can say WHICH kind of off it is: "turned off"
   * has a fix, "hosted" does not, and telling an operator to go looking for a
   * switch that does not exist is the dead end this flag removes.
   */
  hosted?: boolean;
}

const DEFAULT_PROFILE_DIR = '~/.trevra/linkedin-profile';

/**
 * The Chrome profile directory, `~` expanded here rather than in `config.ts`.
 *
 * Resolved at the use site on purpose: `$HOME` belongs to the process that
 * actually launches the browser, and baking it into config would put one
 * machine's home directory into a value other machines read.
 */
export function resolveProfileDir(configured?: string | null): string {
  const raw = configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR;
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Why LinkedIn automation is off, in one sentence.
 *
 * TWO KINDS OF OFF, and conflating them is what sends an operator hunting for
 * a switch. Hosted is a decision the deployment made and no environment
 * variable can undo it; anything else is a self-hoster's own setting.
 */
export function linkedInOffReason(config: Pick<LinkedInLocalWorkerConfig, 'hosted'>): string {
  return config.hosted
    ? 'This deployment is hosted, so LinkedIn automation is off and cannot be enabled.'
    : 'LinkedIn automation is switched off on this server.';
}

// ---------------------------------------------------------------------------
// Can this process open a headed browser? Answered WITHOUT opening one.
// ---------------------------------------------------------------------------

const localWorkerRequire = createRequire(import.meta.url);

export interface LinkedInBrowserReadiness {
  canLaunchHeaded: boolean;
  /** Empty exactly when `canLaunchHeaded` is true. One sentence each. */
  reasons: string[];
}

/** True when this process is inside a container -- the fact that explains the rest. */
export function inContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|podman|kubepods|lxc/i.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    // No /proc/1/cgroup is not evidence of a container; on macOS and Windows it
    // simply does not exist.
    return false;
  }
}

/**
 * Where Playwright keeps its downloaded browsers, derived rather than asked.
 *
 * Asking would mean importing playwright, which is the ~400MB load this whole
 * probe exists to avoid. The rules are Playwright's own and stable: the env
 * override wins, `0` means "inside the package", and otherwise it is the
 * platform cache directory.
 */
export function playwrightBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured === '0') {
    try {
      return join(dirname(localWorkerRequire.resolve('playwright-core')), '.local-browsers');
    } catch {
      return null;
    }
  }
  if (configured) return configured;
  if (platform === 'win32') return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'ms-playwright');
}

/** A chromium build actually present in the registry, not just the registry directory. */
function chromiumInstalled(browsersPath: string | null): boolean {
  if (!browsersPath) return false;
  try {
    if (!statSync(browsersPath).isDirectory()) return false;
    return readdirSync(browsersPath).some((entry) => entry.startsWith('chromium'));
  } catch {
    return false;
  }
}

/**
 * Can this process open a headed Chrome, and if not, what is the one thing to
 * do about it?
 *
 * CHEAP AND NON-LAUNCHING, and that is a hard requirement rather than an
 * optimisation. This feeds a status endpoint and the detect route, and a
 * status endpoint that opens Chrome is a status endpoint that hangs. Every
 * check here is a `require.resolve`, a `stat` or an environment read.
 *
 * FAILS CLOSED. Anything it could not determine counts as not ready, because
 * the cost of a wrong `true` is a request routed to a process that will sit
 * there failing to launch a browser nobody can see.
 *
 * The container line is CONTEXT, not a verdict: a container with a forwarded
 * display can genuinely run this. It is emitted only alongside a real blocker,
 * because it is the fact that explains why the others are true -- an operator
 * told "no display" inside Docker has learned nothing they can act on.
 */
export function linkedInBrowserReadiness(
  config: LinkedInLocalWorkerConfig,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): LinkedInBrowserReadiness {
  if (!config.enabled) return { canLaunchHeaded: false, reasons: [linkedInOffReason(config)] };

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const blockers = browserBlockers(env, platform);

  // THE DECISIVE SIGNAL ON LINUX. A headed browser needs somewhere to draw,
  // and neither X11 nor Wayland is reachable without one of these. macOS and
  // Windows have no equivalent variable and always have a window server.
  if (platform === 'linux' && !(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim())) {
    blockers.push('No display is attached to this process, so a browser window cannot open here.');
  }

  if (blockers.length === 0) return { canLaunchHeaded: true, reasons: [] };
  return {
    canLaunchHeaded: false,
    reasons: inContainer()
      ? ['This process runs in a container, which has no display and no browser of its own.', ...blockers]
      : blockers
  };
}

/** The two checks a browser of ANY kind needs: the package, and a chromium build. */
function browserBlockers(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const blockers: string[] = [];

  let playwrightResolvable = false;
  try {
    localWorkerRequire.resolve('playwright');
    playwrightResolvable = true;
  } catch {
    blockers.push('Playwright is not installed here; run `npm i playwright && npx playwright install chromium`.');
  }

  // Only worth asking once playwright itself resolves: "install the browsers"
  // is not the next action for somebody who has no playwright.
  if (playwrightResolvable && !chromiumInstalled(playwrightBrowsersPath(env, platform))) {
    blockers.push('No Chromium is installed here; run `npx playwright install chromium`.');
  }

  return blockers;
}

export interface LinkedInHeadlessReadiness {
  canLaunchHeadless: boolean;
  /** Empty exactly when `canLaunchHeadless` is true. One sentence each. */
  reasons: string[];
}

/**
 * Can this process open a HEADLESS Chromium?
 *
 * The same probe as {@link linkedInBrowserReadiness} minus the display check,
 * because that is the entire difference: a headless browser needs a binary and
 * nothing to draw on. In a container the headed answer is always no and this
 * one is yes as soon as `npx playwright install chromium` has run in the image.
 *
 * Every seat signs itself in with stored credentials, so a headless browser
 * needs nothing else to be usable -- it opens its own session and shows no
 * human a login form because none is needed.
 *
 * Same discipline as the headed probe: cheap, non-launching, fails closed.
 */
export function linkedInHeadlessReadiness(
  config: LinkedInLocalWorkerConfig,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): LinkedInHeadlessReadiness {
  if (!config.enabled) return { canLaunchHeadless: false, reasons: [linkedInOffReason(config)] };
  const blockers = browserBlockers(options.env ?? process.env, options.platform ?? process.platform);
  return blockers.length === 0 ? { canLaunchHeadless: true, reasons: [] } : { canLaunchHeadless: false, reasons: blockers };
}

/** The slice of a Playwright persistent context this codebase touches. */
export interface LinkedInBrowserContext {
  pages(): unknown[];
  newPage(): Promise<unknown>;
  cookies(urls?: string | string[]): Promise<Array<{ name: string; domain: string }>>;
  on(event: 'close', handler: () => void): void;
  close(): Promise<void>;
}

export interface PlaywrightLike {
  chromium: {
    launchPersistentContext(userDataDir: string, options?: Record<string, unknown>): Promise<LinkedInBrowserContext>;
  };
}

interface BrowserHandle {
  page: LinkedInPage;
  /** Which mode this handle was opened in, so a reuse cannot silently be the wrong one. */
  headless: boolean;
  close(): Promise<void>;
}

let browser: BrowserHandle | null = null;
let missingPlaywrightLogged = false;

/**
 * The one actionable line, logged once (plan 4.4).
 *
 * Once, because this runs on every worker tick and a per-minute repetition of
 * the same install instruction is how a log stops being read.
 */
function reportMissingPlaywright(log: (message: string) => void, cause: unknown): void {
  if (missingPlaywrightLogged) return;
  missingPlaywrightLogged = true;
  log(
    `LinkedIn local worker is enabled but stays off: playwright not installed; run npm i playwright && npx playwright install chromium (${cause instanceof Error ? cause.message : String(cause)})`
  );
}

let unreadyLogged = '';

/**
 * Say once, per distinct set of reasons, that this process cannot drive a
 * browser. Same discipline as {@link reportMissingPlaywright}: this is on a
 * per-minute tick, and a repeated line is a line nobody reads.
 */
function reportUnready(log: (message: string) => void, readiness: LinkedInBrowserReadiness): void {
  const summary = readiness.reasons.join(' ');
  if (unreadyLogged === summary) return;
  unreadyLogged = summary;
  log(`LinkedIn local worker stays off here: ${summary}`);
}

/**
 * Load Playwright, or report its absence and stay off.
 *
 * The specifier is typed as `string` rather than written as a literal so that
 * neither `tsc` nor the Vite marketing build tries to resolve a package that
 * is deliberately optional. A HARD dependency would add ~400MB to the Oracle
 * image and break the Cloudflare build (plan 4.4) -- for a feature that is off
 * on every deployment except a self-hoster who asked for it.
 *
 * ABSENCE IS NEVER FATAL. This returns null; it does not throw. A worker
 * process that crashed because an optional browser was missing would take the
 * automation cycle, the playbook engine and the schedule sweep down with it.
 */
export async function loadLinkedInPlaywright(log: (message: string) => void = () => {}): Promise<PlaywrightLike | null> {
  const specifier: string = 'playwright';
  try {
    return (await import(specifier)) as PlaywrightLike;
  } catch (cause) {
    reportMissingPlaywright(log, cause);
    return null;
  }
}

/**
 * Attach to this seat's persistent Chrome profile, launching Chromium if
 * needed.
 *
 * HEADED IS PREFERRED WHENEVER IT IS AVAILABLE. The operator can watch what
 * the worker does and close it, and a signed-in window is strictly easier to
 * troubleshoot than one nobody can see. `headless: true` is what a container
 * falls back to (plan 4.9): no display, no window to show. Either way the seat
 * signs itself in with its own stored credentials -- headless just means
 * nobody is watching it do so.
 *
 * `--no-sandbox` goes on only in a container, where Chromium runs as root and
 * refuses to start without it. It is not added on a normal machine: weakening
 * the browser sandbox for a process that does not need it would be paying a
 * real cost for nothing.
 *
 * A MODE CHANGE REOPENS. The handle records which mode it was launched in, so a
 * detect that needs headless cannot silently be answered by a headed window
 * left over from something else, or the reverse.
 */
async function openBrowser(
  config: LinkedInLocalWorkerConfig,
  log: (message: string) => void,
  options: { headless?: boolean } = {}
): Promise<BrowserHandle | null> {
  const headless = options.headless ?? false;
  if (browser && browser.headless === headless) return browser;
  if (browser) await closeLinkedInBrowser();

  const playwright = await loadLinkedInPlaywright(log);
  if (!playwright) return null;
  const profileDir = resolveProfileDir(config.profileDir);
  try {
    const context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless,
      ...(headless ? {} : { viewport: null }),
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(headless && inContainer() ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])
      ]
    });
    const existing = context.pages()[0];
    const page = (existing ?? (await context.newPage())) as LinkedInPage;
    browser = {
      page,
      headless,
      close: async () => {
        await context.close();
      }
    };
    return browser;
  } catch (cause) {
    log(
      `LinkedIn local worker could not open the browser profile at ${profileDir}: ${cause instanceof Error ? cause.message : String(cause)}. Log into LinkedIn by hand in that profile first.`
    );
    return null;
  }
}

/**
 * Which browser mode this process should use, or the one thing to do about it.
 *
 * HEADED WINS WHEN IT IS AVAILABLE, always. A window the operator can see is
 * strictly better than one they cannot: they can watch it, close it, and clear
 * a captcha in it. Headless is what is left when there is no display -- the
 * container -- and it is usable only by a seat that can sign itself in.
 */
function seatBrowserMode(config: LinkedInLocalWorkerConfig): { headless: boolean; blocked: string | null } {
  const headed = linkedInBrowserReadiness(config);
  if (headed.canLaunchHeaded) return { headless: false, blocked: null };
  const headless = linkedInHeadlessReadiness(config);
  if (headless.canLaunchHeadless) return { headless: true, blocked: null };
  // Neither. The headed reasons are the fuller set and already carry the
  // container line that explains the rest.
  return { headless: false, blocked: headed.reasons[headed.reasons.length - 1] ?? linkedInOffReason(config) };
}

/** The four answers `POST /api/linkedin/seat/login` may give. */
export type LinkedInLoginStatus = 'ok' | 'otp_required' | 'challenge' | 'failed';

export interface LinkedInLoginOutcome {
  status: LinkedInLoginStatus;
  /** One sentence for the operator. NEVER carries either stored value. */
  message: string;
}

/** Every place a browser handle failed to open says this, verbatim. */
const BROWSER_OPEN_FAILED_MESSAGE =
  'Could not open a LinkedIn browser session on this machine; check that Chromium is installed and try again.';

/**
 * Make this seat's browser session usable: reuse it if it works, sign in if it
 * does not.
 *
 * THE ORDER IS THE SECURITY AND THE SAFETY ARGUMENT AT ONCE. `isLoggedIn` runs
 * first, every time, and the stored session wins whenever it still works --
 * a persistent user-data-dir keeps LinkedIn's cookies for weeks, and
 * re-authenticating anyway would be slower on every run and a much stronger ban
 * signal than a session that simply keeps working (plan 1.3). The password is
 * therefore not even READ on the normal path; it is opened only when the
 * session has actually expired.
 *
 * THE PASSWORD'S WHOLE LIFETIME IS THE `credentials` CONST BELOW. It is
 * decrypted at the moment of use, passed straight to the driver, and never
 * assigned to the outcome, to a log line, or to anything that outlives this
 * call. `driver.loginWithCredentials` guarantees the same for its own return
 * value, so no branch here can leak it into a response.
 *
 * NEVER THROWS. Every refusal is a `status` plus one sentence, because two of
 * its three callers are worker loops that must survive anything LinkedIn does.
 */
export async function loginLinkedInSeat(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: {
    workspaceId: string;
    /** A verification code the operator just read off their phone. */
    otp?: string;
    now?: Date;
    driver?: LinkedInDriver;
    /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
    page?: LinkedInPage;
    log?: (message: string) => void;
  }
): Promise<LinkedInLoginOutcome> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { status: 'failed', message: linkedInOffReason(config) };

  let page = options.page ?? null;
  if (!page) {
    const mode = seatBrowserMode(config);
    if (mode.blocked) return { status: 'failed', message: mode.blocked };
    const handle = await openBrowser(config, log, { headless: mode.headless });
    if (!handle) return { status: 'failed', message: BROWSER_OPEN_FAILED_MESSAGE };
    page = handle.page;
  }

  const driver = options.driver ?? playwrightDriver;

  // SESSION REUSE, AND IT IS THE NORMAL PATH. Nothing is decrypted to get here.
  if (await driver.isLoggedIn(page)) {
    await stampSeatSessionValid(db, options.workspaceId, now);
    return { status: 'ok', message: 'That LinkedIn session is still live, so nothing had to be signed in.' };
  }

  const credentials = await readLinkedInCredentials(db, options.workspaceId);
  if (!credentials) {
    // Covers hosted, nothing stored, and half stored. One sentence.
    return {
      status: 'failed',
      message: 'Save your LinkedIn email and password here to sign in.'
    };
  }

  const result = await driver.loginWithCredentials(page, {
    email: credentials.email,
    password: credentials.password,
    otp: options.otp
  });

  if ('needsOtp' in result) {
    return { status: 'otp_required', message: 'LinkedIn wants a verification code; enter the one it just sent and sign in again.' };
  }
  if (result.ok) {
    await stampSeatSessionValid(db, options.workspaceId, now);
    return { status: 'ok', message: 'Signed in to LinkedIn; that session is now stored in the browser profile.' };
  }
  if (result.failureKind === 'challenge') {
    return {
      status: 'challenge',
      message: 'LinkedIn wants a device check that only a person at a browser window can finish; run `npm run linkedin:worker` on a machine with a display, then complete it in that window.'
    };
  }

  // `detail` is written by driver.ts from constants and the page's own URL, so
  // it can be handed to an operator verbatim.
  return { status: 'failed', message: result.detail ?? 'LinkedIn refused the sign-in.' };
}

/**
 * A signed-in page for one workspace's seat, or the one thing to do about it.
 *
 * THE FRONT HALF OF `runDueLinkedInActions`, LIFTED OUT AND NAMED, because four
 * other jobs now need exactly the same preamble: the inbox sync, the pending-
 * invite sync, the withdrawal queue and the lead-source walk. Every one of them
 * has to answer the same two questions in the same order -- is automation on,
 * and can this process open a browser AT ALL -- and four hand-copied versions
 * of that is four chances to get one of them wrong. Every seat signs itself in
 * with its own stored credentials, so any process that can open a browser, in
 * any mode, may serve any seat.
 *
 * NEVER THROWS. Every refusal is `{ ok: false }` plus one sentence an operator
 * can act on, because its callers are worker ticks and HTTP handlers and
 * neither may 500 on "LinkedIn wants a captcha".
 */
export type LinkedInSessionResult =
  | { ok: true; page: LinkedInPage; driver: LinkedInDriver }
  | { ok: false; blocked: string };

export async function openLinkedInSession(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: {
    workspaceId: string;
    now?: Date;
    driver?: LinkedInDriver;
    /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
    page?: LinkedInPage;
    log?: (message: string) => void;
  }
): Promise<LinkedInSessionResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();
  const driver = options.driver ?? playwrightDriver;

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { ok: false, blocked: linkedInOffReason(config) };

  if (options.page) return { ok: true, page: options.page, driver };

  const mode = seatBrowserMode(config);
  if (mode.blocked) return { ok: false, blocked: mode.blocked };

  const handle = await openBrowser(config, log, { headless: mode.headless });
  if (!handle) return { ok: false, blocked: BROWSER_OPEN_FAILED_MESSAGE };

  // Every seat signs itself in: the session is reused when it still works, and
  // signed in with the stored email and password when it does not.
  const outcome = await loginLinkedInSeat(db, config, { workspaceId: options.workspaceId, now, driver, page: handle.page, log });
  if (outcome.status !== 'ok') return { ok: false, blocked: outcome.message };

  return { ok: true, page: handle.page, driver };
}

/** Close the shared browser. Called from the worker's drain. */
export async function closeLinkedInBrowser(): Promise<void> {
  const handle = browser;
  browser = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // A browser we cannot close is not a reason to fail a shutdown.
  }
}

/**
 * The worker's entry point: one pass over every workspace with work due.
 *
 * NEVER THROWS. It is called from the worker cycle alongside the automation
 * sweep and the playbook engine, and a LinkedIn failure must not cost any of
 * them their tick.
 */
export async function runDueLinkedInActions(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: { now?: Date; driver?: LinkedInDriver; log?: (message: string) => void } = {}
): Promise<LocalBatchResult[]> {
  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return [];
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();

  // Then the capability probe, before the database is touched. A process that
  // can open NEITHER a headed nor a headless browser -- no playwright, no
  // chromium -- would otherwise spend every tick discovering it. The work is
  // not lost: it stays due, and a worker that can takes it.
  const headed = linkedInBrowserReadiness(config);
  const headless = linkedInHeadlessReadiness(config);
  if (!headed.canLaunchHeaded && !headless.canLaunchHeadless) {
    reportUnready(log, headed);
    return [];
  }

  const driver = options.driver ?? playwrightDriver;
  const results: LocalBatchResult[] = [];
  let workspaceIds: string[];
  try {
    workspaceIds = await workspacesWithDueActions(db, now);
  } catch (cause) {
    log(`LinkedIn local worker could not list due actions: ${cause instanceof Error ? cause.message : String(cause)}`);
    return [];
  }

  for (const workspaceId of workspaceIds) {
    // Opened lazily and once, only after there is a workspace to serve.
    const handle = await openBrowser(config, log, { headless: !headed.canLaunchHeaded });
    if (!handle) return results;

    // Every seat signs itself in: the session is made usable before the batch
    // opens, reused when it still works and signed in when it does not.
    const outcome = await loginLinkedInSeat(db, config, { workspaceId, now, driver, page: handle.page, log });
    if (outcome.status !== 'ok') {
      log(`LinkedIn local worker cannot use the seat for ${workspaceId}: ${outcome.message}`);
      continue;
    }

    const store = postgresLocalWorkerStore(db, workspaceId);
    try {
      const result = await runLinkedInLocalBatch(store, {
        driver,
        page: handle.page,
        // The gate is called as a FUNCTION, not through the `gtm.linkedin-guard`
        // skill: `excludeActionId` is deliberately absent from the skill's
        // input schema so an approved playbook payload cannot name a row to
        // excuse itself, and this caller has a row id that is its own by
        // construction -- it just claimed it.
        evaluate: (action, at) =>
          evaluateLinkedInSafety(
            db,
            {
              workspaceId: action.workspaceId,
              seatKey: action.seatKey,
              kind: action.kind as PacedKind,
              targetRef: action.targetRef,
              plannedFor: action.plannedFor
            },
            at,
            // The claimed row is the SUBJECT of the question, not an answer to
            // it. Excluded by primary key; every other row still counts.
            { excludeActionId: action.id }
          ),
        now: () => new Date(),
        log
      });
      results.push(result);
      if (result.halted && result.haltReason) log(`LinkedIn local worker stopped for ${workspaceId}: ${result.haltReason}`);
    } catch (cause) {
      // One workspace's failure is one workspace's failure.
      log(`LinkedIn local worker failed for ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// One-shot detection: read the seat out of the session, instead of asking
// ---------------------------------------------------------------------------

/** Exactly what the live session said, before anything was stored. */
export interface DetectedSeatIdentity {
  profileUrl: string;
  name: string | null;
  connectionsCount: number | null;
}

export interface DetectSeatResult {
  detected: DetectedSeatIdentity | null;
  seat: LinkedInSeat | null;
  /** What could not be read. Empty on a complete read; never a reason to fail. */
  degraded: string[];
  /** Null when the read succeeded; otherwise the thing the operator has to go and do. */
  blocked: string | null;
  failureKind: LinkedInFailureKind | null;
}

/** `https://www.linkedin.com/in/pankaj/` -> `pankaj`. The last-resort seat label. */
function handleOf(profileUrl: string): string {
  const match = /\/in\/([^/]+)\/*$/.exec(profileUrl);
  if (!match) return 'LinkedIn seat';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Read this workspace's seat out of the browser the operator already logged
 * into, and store what it said.
 *
 * THE POINT OF THIS FUNCTION IS THE FORM IT DELETES. Every competitor asks the
 * operator for one thing -- log in -- and reads the rest from the session; the
 * profile URL, the display name and the exact connection count are facts the
 * signed-in browser already holds. Trevra asked for them in a form only
 * because nothing here could open a browser, and now something can.
 *
 * `timezone` is the ONE thing still passed in, because it is the one fact the
 * server genuinely cannot derive: the client knows which 08:00-18:00 a plan
 * has to spread across and the server does not. It is read from the browser's
 * own Intl settings, not typed by anybody.
 *
 * THE DEPLOYMENT GATE APPLIES UNCHANGED (plan 4.3). A hosted Trevra must not
 * be able to read one human's LinkedIn session, and "it is only a read" is not
 * a distinction that survives contact with §8.2 or with the operator's
 * employer. `config.enabled` is checked before anything is imported or opened,
 * exactly as `runDueLinkedInActions` checks it.
 *
 * NEVER THROWS for a browser or LinkedIn problem: those come back as `blocked`
 * with the sentence that fixes them, naming the actual profile directory. A
 * bad timezone still throws, because that is caller input and `seats.ts` owns
 * the message.
 */
export async function detectLinkedInSeat(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: {
    workspaceId: string;
    /** IANA name, from the client's own Intl settings. Not derivable server-side. */
    timezone: string;
    now?: Date;
    driver?: LinkedInDriver;
    /**
     * The page to read. Absent -- always, outside a test -- means the shared
     * persistent-profile browser, opened exactly as the batch loop opens it.
     */
    page?: LinkedInPage;
    log?: (message: string) => void;
  }
): Promise<DetectSeatResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? new Date();
  const refuse = (message: string, failureKind: LinkedInFailureKind | null = null): DetectSeatResult => ({
    detected: null,
    seat: null,
    degraded: [],
    blocked: message,
    failureKind
  });

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return refuse(linkedInOffReason(config));

  let page = options.page ?? null;
  if (!page) {
    const mode = seatBrowserMode(config);
    if (mode.blocked) return refuse(mode.blocked);
    const handle = await openBrowser(config, log, { headless: mode.headless });
    if (!handle) return refuse(BROWSER_OPEN_FAILED_MESSAGE);
    page = handle.page;
  }

  const driver = options.driver ?? playwrightDriver;

  // The session is made usable before anything is read: reused when it still
  // works, signed in with the stored email and password when it does not.
  const outcome = await loginLinkedInSeat(db, config, { workspaceId: options.workspaceId, now, driver, page, log });
  if (outcome.status !== 'ok') return refuse(outcome.message, outcome.status === 'challenge' ? 'challenge' : null);

  const read = await driver.readSeat(page);
  if (!isSeatRead(read)) {
    return refuse(
      'LinkedIn did not return a readable profile page; run `npm run linkedin:worker` on a machine with a display to see why.',
      read.failureKind ?? 'unknown'
    );
  }

  const existing = await getSeat(db, options.workspaceId);
  const seat = await upsertSeat(
    db,
    options.workspaceId,
    {
      // The label is the operator's own words. A detected display name only
      // fills a seat that has none -- re-detecting must not rewrite "Pankaj
      // (founder)" into whatever the profile heading says this month.
      label: existing?.label.trim() || read.name?.trim() || handleOf(read.profileUrl),
      timezone: options.timezone,
      profileUrl: read.profileUrl,
      // A count we could not read leaves the stored one UNCHANGED. Not null,
      // and above all not zero: `degraded` is where the operator learns it was
      // unreadable, and a fabricated zero would be a fact nobody measured.
      connectionsCount: read.connectionsCount === null ? undefined : read.connectionsCount,
      detectedAt: now.toISOString(),
      // A successful `readSeat` IS the confirmation: we just loaded this
      // member's own signed-in profile page.
      sessionValidAt: now.toISOString()
    },
    now
  );

  return {
    detected: { profileUrl: read.profileUrl, name: read.name, connectionsCount: read.connectionsCount },
    seat,
    degraded: read.degraded,
    blocked: null,
    failureKind: null
  };
}

// ---------------------------------------------------------------------------
// Detection across the container/host split (plan 4.9)
// ---------------------------------------------------------------------------

export type SeatDetectStatus = 'pending' | 'completed' | 'failed';

export interface SeatDetectRequest {
  id: string;
  workspaceId: string;
  seatKey: string;
  timezone: string;
  status: SeatDetectStatus;
  requestedAt: string;
  finishedAt: string | null;
  /** The one sentence to act on. Null unless `status` is 'failed'. */
  failureReason: string | null;
}

/**
 * How long a claim on a detect request is honoured before another worker may
 * take it.
 *
 * SAFE TO RECLAIM, unlike every other claim in this subsystem, and the reason
 * is the whole difference between a read and a write: a detect sends nothing.
 * Re-running one after a worker was killed mid-flight duplicates nothing in
 * anybody's notifications, so the failure mode to protect against here is a
 * wedged setup screen, not a duplicate invite.
 */
export const SEAT_DETECT_STALE_CLAIM_MS = 10 * 60_000;

interface SeatDetectRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  timezone: string;
  status: string;
  requested_at: string;
  finished_at: string | null;
  failure_reason: string | null;
}

const SEAT_DETECT_COLUMNS = `
  id, workspace_id, seat_key, timezone, status, failure_reason,
  TO_CHAR(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
  TO_CHAR(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at
`;

function toSeatDetectRequest(row: SeatDetectRow): SeatDetectRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    timezone: row.timezone,
    status: row.status as SeatDetectStatus,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    failureReason: row.failure_reason
  };
}

/**
 * Ask whichever machine CAN open a browser to read this workspace's seat.
 *
 * IDEMPOTENT BY INDEX, NOT BY CHECK-THEN-INSERT. The partial unique index in
 * migration 027 is the guard: an operator pressing Connect while the host
 * worker is still starting up gets one outstanding request however many times
 * they press, and the losing insert is a no-op rather than an error. Same
 * mechanism `linkedin_actions` uses against a replayed export (022).
 *
 * The timezone is validated HERE, at the moment somebody can still be told
 * about it, rather than on the machine that runs the browser several minutes
 * later.
 */
export async function requestSeatDetect(
  db: Db,
  options: { workspaceId: string; timezone: string; seatKey?: string },
  now: Date = new Date()
): Promise<SeatDetectRequest> {
  assertTimezone(options.timezone);
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  await db.prepare(`
    INSERT INTO linkedin_seat_detect_requests (id, workspace_id, seat_key, timezone, status, requested_at)
    VALUES (?,?,?,?,'pending',?)
    ON CONFLICT (workspace_id, seat_key) WHERE status = 'pending' DO NOTHING
  `).run(id('lsdr'), options.workspaceId, seatKey, options.timezone, now.toISOString());

  const row = await db.prepare(`
    SELECT ${SEAT_DETECT_COLUMNS} FROM linkedin_seat_detect_requests
    WHERE workspace_id=? AND seat_key=? AND status='pending'
  `).get<SeatDetectRow>(options.workspaceId, seatKey);
  // The insert either wrote a pending row or lost to one that was already
  // there. Both leave exactly one, so an absence here is a schema problem
  // rather than a race, and saying so beats returning a fabricated request.
  if (!row) throw new Error('The detect request could not be queued.');
  return toSeatDetectRequest(row);
}

/** The most recent request for this workspace, whatever became of it. */
export async function latestSeatDetectRequest(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<SeatDetectRequest | null> {
  const row = await db.prepare(`
    SELECT ${SEAT_DETECT_COLUMNS} FROM linkedin_seat_detect_requests
    WHERE workspace_id=? AND seat_key=?
    ORDER BY requested_at DESC
    LIMIT 1
  `).get<SeatDetectRow>(workspaceId, seatKey);
  return row ? toSeatDetectRequest(row) : null;
}

async function claimSeatDetectRequest(db: Db, now: Date, staleClaimMs: number): Promise<SeatDetectRequest | null> {
  const staleBefore = new Date(now.getTime() - staleClaimMs).toISOString();
  const row = await db.prepare(`
    UPDATE linkedin_seat_detect_requests SET claimed_at=?
    WHERE id = (
      SELECT id FROM linkedin_seat_detect_requests
      WHERE status='pending' AND (claimed_at IS NULL OR claimed_at < ?)
      ORDER BY requested_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${SEAT_DETECT_COLUMNS}
  `).get<SeatDetectRow>(now.toISOString(), staleBefore);
  return row ? toSeatDetectRequest(row) : null;
}

async function settleSeatDetectRequest(
  db: Db,
  requestId: string,
  outcome: { status: Exclude<SeatDetectStatus, 'pending'>; failureReason: string | null },
  now: Date
): Promise<void> {
  await db.prepare(`
    UPDATE linkedin_seat_detect_requests
    SET status=?, failure_reason=?, finished_at=?
    WHERE id=?
  `).run(outcome.status, outcome.failureReason, now.toISOString(), requestId);
}

/**
 * Fulfil queued detect requests, on the machine that can actually do it.
 *
 * CLAIMS NOTHING IT CANNOT FULFIL. The readiness probe runs BEFORE the first
 * claim, so the API container -- which polls this same Postgres and has no
 * display -- never takes a request away from the operator's own worker. That
 * ordering is the whole correctness argument for running this loop in both
 * processes.
 *
 * A request that cannot be fulfilled ends 'failed' with the one thing to do,
 * rather than returning to the queue. A browser that would not open will not
 * open on the next tick either, and a request retried forever is a setup
 * screen that spins forever.
 *
 * NEVER THROWS: it is called from a worker tick beside everything else.
 */
export async function runPendingSeatDetectRequests(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: {
    now?: Date;
    driver?: LinkedInDriver;
    page?: LinkedInPage;
    log?: (message: string) => void;
    maxRequests?: number;
    staleClaimMs?: number;
  } = {}
): Promise<SeatDetectRequest[]> {
  if (!config.enabled) return [];
  const log = options.log ?? ((message: string) => console.log(message));

  // THE PROBE RUNS BEFORE THE FIRST CLAIM, and that ordering is the whole
  // correctness argument for running this loop in two processes at once.
  //
  // Skipped only when a page was handed in -- always a test -- because the
  // question the probe answers is "can I OPEN a browser", and a caller holding
  // one has already answered it.
  if (!options.page) {
    const readiness = linkedInBrowserReadiness(config);
    if (!readiness.canLaunchHeaded) {
      reportUnready(log, readiness);
      return [];
    }
  }

  const maxRequests = Math.max(1, Math.trunc(options.maxRequests ?? 5));
  const staleClaimMs = options.staleClaimMs ?? SEAT_DETECT_STALE_CLAIM_MS;
  const settled: SeatDetectRequest[] = [];

  for (let index = 0; index < maxRequests; index += 1) {
    const now = options.now ?? new Date();
    let request: SeatDetectRequest | null;
    try {
      request = await claimSeatDetectRequest(db, now, staleClaimMs);
    } catch (cause) {
      log(`LinkedIn detect queue could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
      return settled;
    }
    if (!request) break;

    let failureReason: string | null;
    try {
      const result = await detectLinkedInSeat(db, config, {
        workspaceId: request.workspaceId,
        timezone: request.timezone,
        now,
        driver: options.driver,
        page: options.page,
        log
      });
      failureReason = result.blocked;
    } catch (cause) {
      // Everything detect throws is caller input -- a timezone this runtime's
      // ICU does not know is the only one -- and it is the operator's to fix.
      failureReason = cause instanceof Error ? cause.message : String(cause);
    }

    const status = failureReason ? 'failed' : 'completed';
    await settleSeatDetectRequest(db, request.id, { status, failureReason }, now);
    settled.push({ ...request, status, failureReason, finishedAt: now.toISOString() });
    if (failureReason) log(`LinkedIn seat detection failed for ${request.workspaceId}: ${failureReason}`);
  }

  return settled;
}
