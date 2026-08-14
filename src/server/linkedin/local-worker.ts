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
  SELECTORS,
  isSeatRead,
  playwrightDriver,
  type LinkedInDriver,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { ACTION_GAP_SECONDS, type PacedKind } from './limits.js';
import { clearInboxForSeat } from './inbox.js';
import {
  OWNER_SEAT_KEY,
  assertTimezone,
  deleteSeat,
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
 * own email and password, sealed by `secrets/linkedin.ts`, is opened only
 * inside `loginLinkedInSeat` and handed straight to the driver. `isLoggedIn`
 * runs before any sign-in -- a stored session that still works is reused,
 * because re-authenticating every run is slower and a much stronger ban signal
 * than a session that simply keeps working.
 *
 * EVERYTHING HERE IS PER SEAT, NOT PER WORKSPACE, AND THAT IS THE UNIT.
 * A workspace may automate several LinkedIn accounts, and two accounts that
 * share anything share the thing that gets them both restricted. So each
 * (workspace_id, seat_key) has, separately: its own row in the due-work
 * discovery query, its own claim and batch, its own posture and cooldown, its
 * own stored sign-in, its own persistent Chrome profile directory, its own
 * open browser handle, its own user agent / locale / timezone, and its own
 * outbound proxy if the operator configured one. A checkpoint, a limit wall or
 * a pause on one account therefore stops THAT account and leaves the others
 * draining -- which is the entire point of running more than one.
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
  /**
   * The campaign this row belongs to, when it belongs to one.
   *
   * CARRIED SO THE PRE-SEND GATE CAN SEE IT, and it exists because it could
   * not. `guard.ts` runs a second ramp -- 20/40/60/80/100% of the seat's daily
   * ceiling over a managed campaign's first five days -- and it can only run it
   * for a campaign it was told about. The claim did not select the column and
   * the pre-send call did not pass one, so `campaign-warmup` took its "no
   * campaign was named for this action" branch and passed unconditionally on
   * every real send this worker has ever made: the campaign ramp existed at
   * PLAN time (`runner.ts` budgets against it) and nowhere at SEND time.
   */
  campaignId?: string | null;
  /**
   * This row's replay identity within its kind and target (migration 047).
   *
   * Passed back into the gate for the same reason `campaignId` is: the gate's
   * `duplicate-target` check asks the ledger's replay question, and asking it
   * without the scope makes the gate stricter than the index it mirrors, which
   * is how a managed workflow's second message step becomes permanently
   * unsendable.
   */
  replayScope?: string;
  /**
   * The operator overrode this ONE reply's warm-up ceiling (migration 044).
   *
   * READ OFF THE ROW, NEVER DECIDED HERE. The column's own COMMENT is explicit
   * about both halves: it is set exclusively by `enqueueReply` from an operator
   * action in the inbox composer, and it is read back here so the override
   * sticks to the row rather than having to be re-supplied at execution time.
   * Nothing in this worker may set it, and nothing in this worker may infer it.
   */
  overrideWarmupCeiling?: boolean;
}

export type BatchStatus = 'completed' | 'halted';

export interface LocalBatchResult {
  batchId: string | null;
  workspaceId: string;
  /** WHICH LINKEDIN ACCOUNT this pass drained. A batch is per seat, never per workspace. */
  seatKey: string;
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
  /**
   * The seat this store is bound to. EVERY method below is scoped to
   * (workspaceId, seatKey) and none of them may widen to the workspace:
   * claiming, the posture read, the cooldown write and the branch lookup are
   * all per account, which is what makes a limit wall on one seat leave the
   * others draining.
   */
  readonly seatKey: string;
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
  /**
   * Does this seat hold an invite to this target that was never accepted?
   *
   * Asked for ONE question and it is a narrow one: a profile with no Message
   * control on it. `driver.ts` reports that as `selector_drift` -- correctly,
   * from where it stands, since a control it needed was not on the page -- and
   * the loop halts the seat's whole batch on drift, because if one selector has
   * moved the next action would load a profile for nothing. But there is a
   * completely ordinary reason for a missing Message button that has nothing to
   * do with CSS: LinkedIn only offers it for a 1st-degree connection, and a
   * managed workflow that sent an invite and queued a message behind it will
   * reach that message while the invite is still pending.
   *
   * TRUE MEANS POSITIVE EVIDENCE, NEVER ABSENCE OF EVIDENCE. It answers "this
   * seat invited this person and they have not accepted", not "we have no
   * record of a connection" -- the second would classify a genuine drift on any
   * profile Trevra never invited as a routine skip, which is precisely the
   * detection this must not weaken. 'skipped' invites are excluded: a skipped
   * row never happened and is evidence of nothing.
   */
  hasUnacceptedInvite(action: DueLinkedInAction): Promise<boolean>;
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
    seatKey: store.seatKey,
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
      // DEFERRED, EXACTLY AS A PENDING BRANCH IS DEFERRED, and for exactly the
      // same reason. `claimNextDueAction` orders by `planned_for ASC`, so a row
      // that is released and not excluded is the OLDEST due row again on the
      // very next iteration -- and the gate that just refused it refuses it
      // again, because nothing about the ledger changed in between. The loop
      // used to spend all 25 iterations, each behind a 30-120s sleep, re-asking
      // one question it already had the answer to, while every other action in
      // the queue went untouched. One refusal per row per pass; the row stays
      // planned, and the next pass asks again against a ledger that has moved.
      deferred.push(action.id);
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

    const failureKind = outcome.failureKind ?? 'unknown';
    const detail = outcome.detail ? ` ${outcome.detail}` : '';

    /*
     * NOT DRIFT: A MESSAGE BUTTON THAT IS ABSENT BECAUSE THEY NEVER CONNECTED.
     *
     * LinkedIn offers a Message control on a profile only for a 1st-degree
     * connection. `driver.ts` cannot tell WHY the control is missing -- from
     * where it stands, a selector it needed did not match, which is honestly
     * reported as `selector_drift` -- and the branch below then halts the
     * seat's ENTIRE batch, because a genuinely drifted selector means every
     * following action would load a page for nothing.
     *
     * That is the right treatment for drift and the wrong treatment for the
     * commonest managed-workflow shape there is: invite, then a message step
     * behind it. Reach that message while the invite is still pending and one
     * lead who has not answered yet takes down the whole account's queue for
     * that pass.
     *
     * So the two are told apart, with EVIDENCE ON BOTH SIDES rather than a
     * guess:
     *
     *   - it must be the Message control specifically that did not match, which
     *     is why the test is against `SELECTORS.messageButton` from driver.ts
     *     itself rather than a copied string -- repairing that selector moves
     *     this test with it;
     *   - and this seat must hold an invite to this very person that was never
     *     accepted. Positive evidence, not "we have no record of a connection":
     *     a profile Trevra never invited still halts the batch, so drift on
     *     anything else is detected exactly as strongly as before.
     *
     * The action is DEFERRED rather than skipped. "They have not accepted yet"
     * is not "they never will" -- the same three-way reading `branching.ts`
     * takes -- so the row stays planned for a later pass, is excluded from this
     * pass's claims so the loop moves on, and nothing is settled. It is counted
     * as a branch-pending deferral because that is what it is: a step waiting
     * on an answer that has not arrived.
     */
    if (
      failureKind === 'selector_drift'
      && action.kind === 'dm'
      && typeof outcome.detail === 'string'
      && outcome.detail.startsWith(`${SELECTORS.messageButton} did not match`)
      && (await store.hasUnacceptedInvite(action))
    ) {
      await store.releaseClaim(action.id, null);
      deferred.push(action.id);
      result.branchPending += 1;
      log(
        `LinkedIn local worker deferred action ${action.id}: ${action.targetRef} offers no Message control and this seat's invite to them has not been accepted, so they are not a 1st-degree connection yet. This is not selector drift and the batch continues.`
      );
      continue;
    }

    result.failed += 1;

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
  // Every refusal below is about ONE seat. `runDueLinkedInActions` logs it and
  // moves to the next seat rather than ending the tick, so a paused or cooling
  // account never stops the workspace's other accounts.
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
  campaign_id: string | null;
  replay_scope: string | null;
  override_warmup_ceiling: boolean | null;
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
  // The id of the most recent connection_request step seen so far, for the
  // implicit acceptance gate below. Null until a manager workflow declares one.
  let lastInviteStepId: string | null = null;

  for (const entry of steps) {
    if (typeof entry !== 'object' || entry === null) continue;
    const step = entry as { id?: unknown; day?: unknown; kind?: unknown; action?: unknown; condition?: unknown };
    if (typeof step.id !== 'string') continue;

    // TWO SEQUENCE DIALECTS, ONE PARSER, AND `action` IS THE CANONICAL ONE.
    //
    // A 025-era sequence stores a ledger `kind` per step. A manager workflow
    // (`workflows.ts`, snapshot into `sequence_json` by
    // `createManagedCampaign`) stores an `action` from its own discriminated
    // union instead, and this parser only knew about `kind` -- so every
    // manager campaign parsed to zero steps, `hasBranching` answered false, and
    // the whole branch evaluation was skipped for exactly the campaigns this
    // deployment runs itself.
    const kind = typeof step.kind === 'string'
      ? (step.kind as LinkedInActionKind)
      : typeof step.action === 'string'
        ? WORKFLOW_ACTION_KINDS[step.action] ?? null
        : null;
    // `manual_message` and `withdraw_pending` write no outbound ledger row at
    // all (`runner.ts` `kindForStep` returns null for both), so there is no
    // action for a branch to be about and nothing here can reference them.
    if (kind === null) continue;

    const declared =
      typeof step.condition === 'object' && step.condition !== null
        && typeof (step.condition as StepCondition).on === 'string'
        && typeof (step.condition as StepCondition).ofStepId === 'string'
        ? (step.condition as StepCondition)
        : null;

    /*
     * THE IMPLICIT ACCEPTANCE GATE, AND WHY IT IS NOT AN INVENTION.
     *
     * The manager's step vocabulary has no `condition` field: an operator
     * builds "connection request, wait two days, message" and there is nowhere
     * for them to say "...if they accepted". Nowhere, because on LinkedIn it is
     * not a choice -- a profile message goes through the Message control, and
     * LinkedIn shows that control to 1st-degree connections only. A message
     * step behind a connection request is therefore ALREADY conditional on
     * acceptance in fact, and the only question is whether Trevra knows it.
     *
     * It did not, and the failure ran all the way to the end: the message was
     * claimed, gated, executed against somebody who never accepted, found no
     * Message button, was reported as `selector_drift` and halted the seat's
     * entire batch. One unanswered invite, one dead queue.
     *
     * So a message step that follows a connection request in the same workflow
     * gets the condition the surface already imposes. It can only make a step
     * run LATER or not at all -- `branching.ts` rule 2 -- so nothing is
     * scheduled earlier, no ceiling is widened, and a workflow with no
     * connection request in front of its message (messaging people this seat is
     * already connected to) keeps running unconditionally, which is correct for
     * exactly the same reason.
     *
     * A condition the operator DID declare always wins: this fills a gap, it
     * does not overrule an author.
     */
    const condition = declared ?? (kind === 'dm' && lastInviteStepId !== null
      ? { on: 'accepted' as const, ofStepId: lastInviteStepId }
      : null);

    parsed.push({
      id: step.id,
      // Manager workflows carry no absolute day: their spacing is `delayBefore`
      // per step, which `runner.ts` has already turned into the row's
      // `planned_for`. `evaluateBranches` floors every step at
      // `max(day, plannedFor)`, so 0 here means "the paced slot is the floor",
      // which is the truth for a managed row and never earlier than it.
      day: typeof step.day === 'number' ? step.day : 0,
      kind,
      condition
    });

    if (kind === 'invite') lastInviteStepId = step.id;
  }
  return parsed;
}

/**
 * A manager workflow action to the ledger kind it writes.
 *
 * The same mapping `runner.ts` `kindForStep` makes when it writes the row, and
 * it has to stay the same one: this file reads back what that file wrote, so a
 * disagreement here is a step whose own ledger row cannot be found.
 * `manual_message` and `withdraw_pending` write nothing, and null says so.
 */
const WORKFLOW_ACTION_KINDS: Readonly<Record<string, LinkedInActionKind | null>> = {
  connection_request: 'invite',
  message: 'dm',
  profile_view: 'profile_view',
  follow: 'follow',
  manual_message: null,
  withdraw_pending: null
};

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
    seatKey,

    async seatPosture(now) {
      // PER SEAT, and this line is load-bearing: it used to default to the
      // owner seat, so a second account's batch read the OWNER's posture and
      // would happily keep sending while its own seat was paused, or refuse
      // while its own seat was fine.
      return getSeatPosture(db, workspaceId, now, seatKey);
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
        -- campaign_id, replay_scope and override_warmup_ceiling are selected
        -- for ONE consumer: the pre-send re-evaluation of the safety gate.
        -- Without them that call could not run the campaign-day ramp (it was
        -- told no campaign was named, on every real send), could not ask the
        -- ledger's own scoped replay question, and could not honour an override
        -- an operator had already recorded on the row.
        RETURNING id, workspace_id, seat_key, kind, target_ref,
                  TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
                  body, thread_urn, campaign_id, replay_scope, override_warmup_ceiling
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
        threadUrn: row.thread_urn,
        campaignId: row.campaign_id,
        replayScope: row.replay_scope ?? 'legacy',
        overrideWarmupCeiling: row.override_warmup_ceiling === true
      };
    },

    async hasUnacceptedInvite(action) {
      // Case-folded on both sides, the way every other target lookup in this
      // subsystem folds them (idx_linkedin_actions_target_ci, migration 031):
      // the invite and the message may have been written from different
      // renderings of the same profile URL.
      const row = await db.prepare(`
        SELECT 1 AS unaccepted FROM linkedin_actions
        WHERE workspace_id=? AND seat_key=? AND kind='invite'
          AND target_ref IS NOT NULL AND LOWER(target_ref)=LOWER(?)
          AND status NOT IN ('accepted', 'replied', 'skipped')
        LIMIT 1
      `).get<{ unaccepted: number }>(workspaceId, action.seatKey, action.targetRef);
      return row !== undefined;
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
      // THE COOLDOWN LANDS ON THE SEAT THAT HIT THE WALL, and only on it.
      // LinkedIn restricts an ACCOUNT, not a workspace: cooling every seat
      // because one of them saw a limit wall would stop accounts that are
      // perfectly healthy, and each of those then needs a human to resume it.
      await upsertSeat(db, workspaceId, { posture: 'cooldown' }, now, seatKey);
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
export async function stopLinkedInBatches(db: Db, workspaceId: string, seatKey?: string): Promise<number> {
  // No seat named means EVERY seat in the workspace, which is what the API's
  // kill switch means when an operator presses Stop on the workspace. Naming
  // one stops one account and leaves the others running.
  const result = await db.prepare(`
    UPDATE linkedin_batches SET stop_requested_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND (?::text IS NULL OR seat_key=?) AND status='running' AND stop_requested_at IS NULL
  `).run(workspaceId, seatKey ?? null, seatKey ?? null);
  return result.changes;
}

/** One LinkedIn account with work waiting for it, and what its browser should look like. */
export interface DueSeat {
  workspaceId: string;
  seatKey: string;
  /**
   * The seat's own IANA timezone, or null when no seat row exists yet.
   *
   * Carried out of the discovery query rather than fetched per seat because it
   * is what the browser context advertises (see {@link seatContextFingerprint}):
   * a Zurich account whose browser claims to be in Chicago is a fingerprint
   * inconsistency we would be creating for ourselves.
   */
  timezone: string | null;
}

/**
 * Every SEAT with at least one claimable action due now.
 *
 * THE `AND seat_key='owner'` THIS REPLACES WAS THE BUG THAT MADE MULTI-SEAT
 * COSMETIC. Actions were planned, filed and paced per seat all the way down
 * the queue, and then the one query that decides what a worker picks up threw
 * every non-owner row away -- so a second account's queue filled up and never
 * drained, silently, with no error anywhere to notice.
 *
 * LEFT JOIN, so a due action whose seat row is missing still surfaces: the
 * batch refuses it with 'No LinkedIn seat is configured...', which is a
 * sentence an operator can act on, where dropping it here would be a queue
 * that quietly never moves -- the exact failure this function just stopped
 * having.
 */
export async function seatsWithDueActions(db: Db, now: Date): Promise<DueSeat[]> {
  const rows = await db.prepare(`
    SELECT DISTINCT a.workspace_id, a.seat_key, s.timezone
    FROM linkedin_actions a
    LEFT JOIN linkedin_seats s ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key
    WHERE a.status='planned' AND a.claimed_at IS NULL
      AND a.planned_for IS NOT NULL AND a.planned_for <= ?
      AND a.kind IN (${EXECUTABLE_KIND_LIST})
    ORDER BY a.workspace_id, a.seat_key
  `).all<{ workspace_id: string; seat_key: string; timezone: string | null }>(now.toISOString());
  return rows.map((row) => ({ workspaceId: row.workspace_id, seatKey: row.seat_key, timezone: row.timezone }));
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

const DEFAULT_PROFILE_DIR_BASE = '~/.trevra/linkedin';

/**
 * The characters a workspace id may keep in a directory name. Whatever an id
 * generator produces, this is a path component the moment it leaves this
 * function -- no `/`, no `..`, nothing a shell or a filesystem reads as
 * anything but literal text.
 */
function pathSafeId(id: string): string {
  const safe = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || 'default';
}

/**
 * The base a workspace's profile directory is built from, for a startup
 * message printed before any workspace is known -- `resolveProfileDir` itself
 * always requires one, on purpose, so nothing can quietly resolve the old
 * single shared path by omitting it.
 */
export function profileDirBase(configured?: string | null): string {
  return configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR_BASE;
}

/**
 * The Chrome profile directory for ONE SEAT, `~` expanded here rather than in
 * `config.ts`.
 *
 * ONE DIRECTORY PER (WORKSPACE, SEAT), NEVER ONE FOR THE WHOLE PROCESS AND
 * NEVER ONE PER WORKSPACE EITHER. A persistent user-data-dir IS the LinkedIn
 * session: its cookies, its device fingerprint, its "remember this browser"
 * standing. Two accounts sharing one directory do not merely see each other's
 * inbox -- the second sign-in REPLACES the first one's session, so two seats
 * would spend every tick logging each other out, which is both broken and the
 * single loudest ban signal a pair of accounts can emit. `openBrowser` is what
 * enforces the other half (a handle map keyed by seat, not one per process);
 * this is what makes two seats land on two different directories at all.
 *
 * THE OWNER SEAT KEEPS THE PATH IT ALREADY HAS. `<base>-<workspace>-profile`
 * is unchanged for `owner` and only additional seats get the extra segment, so
 * an existing install does not wake up on an empty profile directory and
 * silently need a fresh sign-in on the account it was already signed into.
 *
 * Resolved at the use site on purpose: `$HOME` belongs to the process that
 * actually launches the browser, and baking it into config would put one
 * machine's home directory into a value other machines read.
 *
 * `configured` is a BASE an operator may still override (`TREVRA_LINKEDIN_PROFILE_DIR`)
 * -- still suffixed per seat, because the isolation this exists for is not
 * something a global env var should be able to switch back off by accident.
 */
export function resolveProfileDir(
  configured: string | null | undefined,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY
): string {
  const base = configured?.trim() ? configured.trim() : DEFAULT_PROFILE_DIR_BASE;
  const seatSegment = seatKey === OWNER_SEAT_KEY ? '' : `-${pathSafeId(seatKey)}`;
  const raw = `${base}-${pathSafeId(workspaceId)}${seatSegment}-profile`;
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * The map key, and the one place the pair is spelled.
 *
 * ` ` rather than `:` because a seat key is operator-supplied. It cannot
 * contain a NUL by `upsertSeat`'s alphabet, so no two distinct pairs can
 * collide into one key -- which with a `:` they could (`ws:a` + `b` vs `ws` +
 * `a:b`), and a collision here means two accounts sharing one browser.
 */
function seatHandleKey(workspaceId: string, seatKey: string): string {
  return `${workspaceId} ${seatKey}`;
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

/**
 * One attached DevTools-protocol client.
 *
 * OPTIONAL ON THE CONTEXT, because every test fake in this repo is a hand-written
 * object and none of them speak CDP. A context that cannot open a session gets
 * the plain launch options and nothing else -- the identity work below degrades,
 * it never fails.
 */
export interface LinkedInCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  detach?(): Promise<void>;
}

/** The slice of a Playwright persistent context this codebase touches. */
export interface LinkedInBrowserContext {
  pages(): unknown[];
  newPage(): Promise<unknown>;
  cookies(urls?: string | string[]): Promise<Array<{ name: string; domain: string }>>;
  on(event: 'close', handler: () => void): void;
  close(): Promise<void>;
  newCDPSession?(page: unknown): Promise<LinkedInCdpSession>;
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

/**
 * One open browser per SEAT, never one per workspace and never one for the
 * whole process.
 *
 * A single shared handle here was the other half of the profile-directory bug
 * `resolveProfileDir` fixes: even with two seats on two different profile
 * directories, a lone `browser` variable would still hand the second seat's
 * call the first seat's already-open page -- same session, same cookies, wrong
 * account. Keyed by (workspace, seat), exactly as the profile directory now is.
 */
const browsers = new Map<string, BrowserHandle>();
let missingPlaywrightLogged = false;

// ---------------------------------------------------------------------------
// Per-seat browser identity: stable, non-default, and derived, never drawn
// ---------------------------------------------------------------------------

/**
 * What one seat's browser context claims to be.
 *
 * THE DEFAULTS ARE THE PROBLEM THIS SOLVES. Playwright's own defaults are a
 * `HeadlessChrome/<version>` user agent, the host's locale and the host's
 * timezone. The first is a literal announcement of automation; the other two
 * make every seat this machine drives look like the same person, which is the
 * shape of an agency farm rather than of several humans.
 *
 * DERIVED, NEVER DRAWN. `Math.random()` would give each seat a NEW identity on
 * every launch -- a browser whose user agent, locale and timezone change
 * between sessions is a far stronger signal than any single wrong value, and
 * it is unreproducible for us too. Everything here is a pure function of
 * (workspaceId, seatKey), which is the same determinism rule the pacing gaps
 * already follow.
 */
export interface SeatContextFingerprint {
  userAgent: string;
  locale: string;
  timezoneId: string;
  /** The window this seat's headless browser reports. Never Playwright's 800x600. */
  viewport: { width: number; height: number };
}

/**
 * The user agent, on the platform this machine ACTUALLY RUNS.
 *
 * ONE TEMPLATE, LINUX, AND NOT A LIST OF PLATFORMS. This used to draw a
 * per-seat string from a list that included Windows and macOS, and that was a
 * self-inflicted wound: Playwright's `userAgent` option rewrites the UA STRING
 * AND NOTHING ELSE. `Sec-CH-UA-Platform`, `Sec-CH-UA-Arch`,
 * `navigator.userAgentData.platform` and `navigator.platform` all kept saying
 * Linux, so every single request carried a client contradicting itself --
 * a far louder signal than "another Linux Chrome" could ever be. Two seats on
 * one machine SHOULD look like two profiles in one browser on one machine,
 * because that is what they are; they are told apart by cookie jar, locale,
 * timezone and (when configured) exit IP, none of which lie about the host.
 *
 * The major version is a fallback only. `alignClientHints` replaces this with
 * the launched binary's own version as soon as the context is open, so the UA
 * cannot drift from the Chromium that is actually rendering the page -- the
 * skew this file used to ship with was UA 138/139 against a 151 binary.
 */
const FALLBACK_CHROME_MAJOR = 151;

function linuxChromeUserAgent(major: number): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Real desktop window sizes, seeded per seat.
 *
 * Playwright's headless default is 1280x720 for every context it has ever
 * opened, which is both a known automation default and identical across every
 * seat on the machine. These are ordinary laptop and monitor sizes; the seat
 * keeps one forever, because a window that changes size between sessions is
 * the same instability the user agent is not allowed to have.
 */
const SEAT_VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1512, height: 856 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 }
];

/**
 * Locale/timezone PAIRS, never two independent draws.
 *
 * A context claiming `de-CH` from `America/Chicago` is more suspicious than
 * either value alone, because no real browser is configured that way by
 * accident. Pairing them means the derived identity is at least internally
 * consistent even when we have no seat row to read a real timezone from.
 */
const SEAT_BROWSER_PROFILES: ReadonlyArray<{ locale: string; timezoneId: string }> = [
  { locale: 'en-US', timezoneId: 'America/New_York' },
  { locale: 'en-US', timezoneId: 'America/Chicago' },
  { locale: 'en-US', timezoneId: 'America/Los_Angeles' },
  { locale: 'en-GB', timezoneId: 'Europe/London' },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  { locale: 'de-CH', timezoneId: 'Europe/Zurich' },
  { locale: 'en-CA', timezoneId: 'America/Toronto' },
  { locale: 'en-AU', timezoneId: 'Australia/Sydney' }
];

/** A stable index into a list, from a seed. The same seed always picks the same entry. */
function seededIndex(seed: string, offset: number, length: number): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  return Number.parseInt(digest.slice(offset, offset + 8), 16) % length;
}

/**
 * The identity this seat's browser context advertises, every time it opens.
 *
 * `timezone` is the SEAT'S OWN IANA name when we have one, and it wins: the
 * seat row already carries the timezone the operator's plans are spread
 * across, so using it makes the browser agree with the account's actual
 * working hours instead of contradicting them. The locale follows the
 * timezone where a pair exists for it, so the two stay consistent. Only when
 * no seat row exists yet -- a queue whose seat has not been detected -- does
 * the timezone fall back to the derived pair.
 */
export function seatContextFingerprint(
  workspaceId: string,
  seatKey: string,
  timezone?: string | null,
  chromeMajor: number = FALLBACK_CHROME_MAJOR
): SeatContextFingerprint {
  const seed = `linkedin-context:${workspaceId}:${seatKey}`;
  const derived = SEAT_BROWSER_PROFILES[seededIndex(seed, 0, SEAT_BROWSER_PROFILES.length)];
  const userAgent = linuxChromeUserAgent(chromeMajor);
  const viewport = SEAT_VIEWPORTS[seededIndex(seed, 16, SEAT_VIEWPORTS.length)];
  const seatTimezone = timezone?.trim();
  if (!seatTimezone) return { userAgent, locale: derived.locale, timezoneId: derived.timezoneId, viewport };
  const paired = SEAT_BROWSER_PROFILES.find((profile) => profile.timezoneId === seatTimezone);
  return { userAgent, locale: paired?.locale ?? derived.locale, timezoneId: seatTimezone, viewport };
}

/**
 * Make the Client Hints agree with the user agent, using the browser's own
 * version -- the one thing Playwright's context options cannot do.
 *
 * WHY THIS EXISTS AT ALL. `userAgent` on a context rewrites exactly one string.
 * A page reads at least five other places for the same fact:
 * `Sec-CH-UA`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Full-Version-List` and
 * `Sec-CH-UA-Arch` on every request, and `navigator.userAgentData` plus
 * `navigator.platform` from script. `Emulation.setUserAgentOverride` with a
 * `userAgentMetadata` block is the only call that sets all of them at once and
 * keeps them consistent, which is why it is worth reaching past Playwright's
 * API for.
 *
 * THE VERSION IS READ, NEVER GUESSED. `Browser.getVersion` returns the binary's
 * real UA; the only edit made to it is `HeadlessChrome` -> `Chrome`, which is
 * the one token that has to go and the one thing about it that is not true of a
 * person's browser. Everything downstream -- brand list, full version list,
 * `Sec-CH-UA` -- is derived from that same number, so there is no second source
 * to drift out of step.
 *
 * THE SESSION IS NOT DETACHED. Chromium drops emulation overrides when the last
 * client for a target goes away, so detaching here would quietly undo the whole
 * function. It lives as long as the context does and closes with it.
 *
 * NEVER THROWS AND NEVER BLOCKS A LAUNCH. A context with no `newCDPSession` (a
 * test fake) and a CDP call that fails both land in the same place: the seat
 * keeps the launch-time user agent, which is at least internally consistent
 * because it already names the real platform.
 */
async function alignClientHints(
  context: LinkedInBrowserContext,
  page: unknown,
  fingerprint: SeatContextFingerprint,
  log: (message: string) => void
): Promise<void> {
  if (typeof context.newCDPSession !== 'function') return;
  try {
    const cdp = await context.newCDPSession(page);
    const version = await cdp.send('Browser.getVersion');
    const reported = typeof version.userAgent === 'string' ? version.userAgent : '';
    const full = /Chrome\/([\d.]+)/.exec(reported)?.[1];
    if (!full) return;
    const major = full.split('.')[0];
    const language = fingerprint.locale;
    await cdp.send('Emulation.setUserAgentOverride', {
      // `HeadlessChrome` is the whole reason an override is still needed once
      // the browser is the full Chromium build rather than the headless shell.
      userAgent: reported.replace('HeadlessChrome', 'Chrome'),
      acceptLanguage: `${language},${language.split('-')[0]};q=0.9`,
      platform: 'Linux x86_64',
      userAgentMetadata: {
        // The GREASE entry is part of what a real Chrome sends; a brand list
        // without one is as identifying as a wrong version.
        brands: [
          { brand: 'Not;A=Brand', version: '99' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major }
        ],
        fullVersionList: [
          { brand: 'Not;A=Brand', version: '99.0.0.0' },
          { brand: 'Chromium', version: full },
          { brand: 'Google Chrome', version: full }
        ],
        fullVersion: full,
        platform: 'Linux',
        platformVersion: '6.8.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false
      }
    });
  } catch (cause) {
    log(
      `LinkedIn seat browser kept its launch-time user agent: the client-hint override failed (${cause instanceof Error ? cause.message : String(cause)}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Per-seat outbound proxy. Absent by default; NEVER silently skipped.
// ---------------------------------------------------------------------------

/** Playwright's proxy shape, declared here so this file still compiles without playwright. */
export interface SeatProxy {
  server: string;
  username?: string;
  password?: string;
}

const PROXY_ENV_PREFIX = 'TREVRA_LINKEDIN_PROXY';

/** Whatever an id or a seat key is, this is what it may contribute to an env var name. */
function envSafe(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * This seat's outbound proxy, or null when it has none.
 *
 * ABSENT BY DEFAULT, ON PURPOSE. The custody argument for this whole subsystem
 * is that a self-hoster automates their own account from their own machine and
 * their own IP -- which is why it is a strictly better risk posture than the
 * hosted competitors that have to sell you a datacenter proxy. A proxy is for
 * the operator who genuinely needs one (a second account on a residential line
 * that is not this machine's), and it is opt-in per seat.
 *
 * THREE KEYS, MOST SPECIFIC WINS:
 *
 *   TREVRA_LINKEDIN_PROXY_<WORKSPACE>_<SEAT>  one seat in one workspace
 *   TREVRA_LINKEDIN_PROXY_<SEAT>              that seat key, in any workspace
 *   TREVRA_LINKEDIN_PROXY                     every seat on this machine
 *
 * lc-debt: the two-part key is built by flattening both ids to `[A-Z0-9_]`, so
 * workspace `ws` + seat `a_sales` and workspace `ws_a` + seat `sales` produce
 * the same variable name; upgrade path is a single
 * `TREVRA_LINKEDIN_PROXIES` JSON map keyed by the exact pair.
 *
 * THROWS RATHER THAN RETURNING NULL FOR ANYTHING IT CANNOT PARSE, and that is
 * the entire safety property. "A proxy was configured and we could not use it"
 * must never resolve to "connect directly": the operator configured it because
 * this account must not be seen coming from this IP, and a silent direct
 * connection is the one outcome that cannot be undone once LinkedIn has logged
 * it. The caller turns the throw into a refusal to open the browser at all.
 */
export function resolveSeatProxy(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  seatKey: string
): SeatProxy | null {
  const candidates = [
    `${PROXY_ENV_PREFIX}_${envSafe(workspaceId)}_${envSafe(seatKey)}`,
    `${PROXY_ENV_PREFIX}_${envSafe(seatKey)}`,
    PROXY_ENV_PREFIX
  ];
  const name = candidates.find((candidate) => env[candidate]?.trim());
  if (!name) return null;
  const raw = env[name]!.trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The VALUE is never quoted back: a proxy URL routinely carries a password.
    throw new Error(`${name} is not a URL. Use http://user:pass@host:port, https://... or socks5://host:port.`);
  }
  const scheme = url.protocol.replace(':', '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`${name} uses an unsupported proxy scheme '${scheme}'. Chromium accepts http, https and socks5.`);
  }
  if (!url.hostname) throw new Error(`${name} names no proxy host.`);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (scheme === 'socks5' && (username || password)) {
    // Chromium cannot authenticate a SOCKS proxy. Accepting it would mean
    // launching with credentials that are silently dropped, which is a direct
    // connection wearing a proxy's clothes.
    throw new Error(`${name} is a SOCKS proxy with credentials, which Chromium cannot authenticate. Use an http proxy, or a SOCKS proxy that authorises this machine by IP.`);
  }
  return {
    server: `${scheme}://${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  };
}

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
 *
 * ONE CONTEXT PER SEAT, WITH THAT SEAT'S OWN IDENTITY. The user-data-dir, the
 * handle-map key, the user agent, the locale, the timezone and the proxy are
 * all functions of (workspace, seat). Two accounts driven from this machine
 * therefore share nothing -- not a cookie jar, not a fingerprint, not an exit
 * IP if the operator configured one.
 */
async function openBrowser(
  config: LinkedInLocalWorkerConfig,
  log: (message: string) => void,
  options: {
    workspaceId: string;
    seatKey?: string;
    headless?: boolean;
    /** The seat's own IANA timezone, when the caller already has it. */
    timezone?: string | null;
    /** Overridable so a test can drive the proxy rules without touching process.env. */
    env?: NodeJS.ProcessEnv;
  }
): Promise<BrowserHandle | null> {
  const headless = options.headless ?? false;
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  const handleKey = seatHandleKey(options.workspaceId, seatKey);
  const existing = browsers.get(handleKey);
  if (existing && existing.headless === headless) return existing;
  if (existing) await closeLinkedInBrowser(options.workspaceId, seatKey);

  const playwright = await loadLinkedInPlaywright(log);
  if (!playwright) return null;
  const profileDir = resolveProfileDir(config.profileDir, options.workspaceId, seatKey);

  // THE PROXY IS RESOLVED BEFORE THE LAUNCH, AND A BAD ONE ENDS IT HERE.
  // Refusing to open a browser at all is the only correct answer to "this seat
  // must not be seen from this IP, and I cannot honour that": the work stays
  // due for a worker that can, and nothing reaches LinkedIn from the wrong
  // address in the meantime.
  let proxy: SeatProxy | null;
  try {
    proxy = resolveSeatProxy(options.env ?? process.env, options.workspaceId, seatKey);
  } catch (cause) {
    log(
      `LinkedIn local worker will not open a browser for seat '${seatKey}': ${cause instanceof Error ? cause.message : String(cause)} A seat with a configured proxy is never connected directly.`
    );
    return null;
  }

  const fingerprint = seatContextFingerprint(options.workspaceId, seatKey, options.timezone ?? null);
  try {
    const context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless,
      // THE FULL CHROMIUM BUILD, NEVER `chrome-headless-shell`. Omitting this
      // is how a headless launch silently became the headless SHELL binary --
      // a different product from Chrome that ships without the PDF viewer,
      // without `chrome.runtime`, with an empty `navigator.plugins`, with
      // SwiftShader as its WebGL renderer and with scrollbars switched off. It
      // announces itself to any fingerprinting script in the first frame, and
      // it was doing so while the user agent claimed to be desktop Chrome.
      // `channel: 'chromium'` is Playwright's opt-in to the real build running
      // `--headless=new`, which shares the headed browser's surface.
      channel: 'chromium',
      // TWO OF PLAYWRIGHT'S OWN DEFAULTS, REMOVED.
      //
      // `--enable-automation` is Chromium's "this browser is being controlled"
      // switch. It is readable from the page and it is the first thing every
      // published detection writeup checks; shipping it while also passing
      // `--disable-blink-features=AutomationControlled` was answering the same
      // question twice, once truthfully.
      //
      // `--hide-scrollbars` zeroes the scrollbar width, which a page measures in
      // one line (`innerWidth === documentElement.clientWidth`) and which no
      // desktop Chrome on Linux or Windows would ever report.
      ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars'],
      // Headed follows the real window; headless gets the seat's own stable
      // desktop size rather than Playwright's 1280x720, which is both a known
      // automation default and identical for every seat on this machine.
      ...(headless ? { viewport: fingerprint.viewport } : { viewport: null }),
      // Stable per seat and never the Playwright default -- see
      // `seatContextFingerprint` for why all three travel together. The user
      // agent here is the fallback; `alignClientHints` replaces it below with
      // the launched binary's real version and matching client hints.
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      // Absent unless the operator configured one. Passed as the context option
      // rather than as a `--proxy-server` arg so Chromium can also answer the
      // proxy's auth challenge, and so nothing here can accidentally be paired
      // with a `--no-proxy-server` that would undo it.
      ...(proxy ? { proxy } : {}),
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(headless && inContainer() ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])
      ]
    });
    const existingPage = context.pages()[0];
    const page = (existingPage ?? (await context.newPage())) as LinkedInPage;
    // BEFORE ANY NAVIGATION. The context opens on `about:blank`, so no request
    // has left the browser yet and the first one LinkedIn sees already carries
    // a user agent and a `Sec-CH-UA*` set that agree with each other.
    await alignClientHints(context, page, fingerprint, log);
    const handle: BrowserHandle = {
      page,
      headless,
      close: async () => {
        await context.close();
      }
    };
    browsers.set(handleKey, handle);
    return handle;
  } catch (cause) {
    // NO RETRY WITHOUT THE PROXY, here or anywhere else. There is exactly one
    // launch attempt, and if it carried a proxy then every attempt for this
    // seat carries it.
    log(
      `LinkedIn local worker could not open the browser profile at ${profileDir}${proxy ? ` through ${proxy.server}` : ''}: ${cause instanceof Error ? cause.message : String(cause)}.`
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

/** The band a keystroke gap is drawn from. Slow enough to be human, fast enough to finish. */
const TYPING_GAP_MS = { min: 45, max: 165 } as const;

/**
 * The same page, but anything typed into it is typed at a human's speed.
 *
 * WHY THIS IS A WRAPPER AND NOT AN EDIT TO `driver.ts`. The sign-in form's
 * selectors, its four outcomes and its "nothing was typed" guarantees are
 * `driver.ts`'s subject and belong there. HOW FAST the characters go in is a
 * posture decision this worker makes about a seat -- it is the same category
 * of decision as the 30-120s inter-action gap and the per-seat fingerprint,
 * both of which already live here. Wrapping the page keeps the two concerns in
 * the two files that own them, and it means the cadence applies to every field
 * the login flow types (the email, the password and the 2FA code) without
 * `driver.ts` having to be told about any of them.
 *
 * WHAT IT ACTUALLY FIXES. `locator.fill()` sets the input's value in one
 * operation and dispatches a single input event: twenty characters arrive in
 * the same millisecond, with no keydown/keyup pairs and no inter-key timing at
 * all. That is not what a person does, it is trivially observable from the
 * page, and the sign-in form is the single surface where LinkedIn is looking
 * hardest. Here the field is cleared and then each character is pressed, with a
 * seeded pause in between.
 *
 * NO `Math.random()`, the same hard rule as everywhere else in this file: the
 * gaps come from a generator seeded by the seat, so a sign-in is reproducible
 * and a test can assert the cadence rather than tolerate it.
 *
 * NEITHER CREDENTIAL IS TOUCHED BEYOND BEING SPLIT INTO CHARACTERS. Nothing
 * here logs, stores, or returns any part of the text it types.
 */
export function humanCadencePage(page: LinkedInPage, seed: string): LinkedInPage {
  const random = seededRandom(createHash('sha256').update(seed).digest('hex'));
  const gap = (): number => Math.round(TYPING_GAP_MS.min + random() * (TYPING_GAP_MS.max - TYPING_GAP_MS.min));

  const wrapLocator = (locator: LinkedInLocator): LinkedInLocator => {
    const wrapped: LinkedInLocator = {
      count: () => locator.count(),
      first: () => wrapLocator(locator.first()),
      click: (options) => locator.click(options),
      textContent: (options) => locator.textContent(options),
      fill: async (text, options) => {
        // An empty fill is a CLEAR, not typing, and there is nothing to pace.
        // A locator with no `press` is a test fake or a page object that cannot
        // send keys; `driver.ts` already treats that as "cannot press a key",
        // so falling back to the plain fill keeps this wrapper transparent
        // rather than turning a missing capability into a sign-in failure.
        if (!text || typeof locator.press !== 'function') return locator.fill(text, options);
        await locator.fill('', options);
        for (const character of [...text]) {
          await locator.press(character, options);
          await page.waitForTimeout(gap());
        }
      }
    };
    // Preserved exactly as found: `driver.ts` reads `typeof field.press` to
    // decide whether the form can be submitted with Enter, and inventing the
    // method here would have it press Enter on a page that cannot.
    if (typeof locator.press === 'function') wrapped.press = (key, options) => locator.press!(key, options);
    return wrapped;
  };

  return {
    goto: (url, options) => page.goto(url, options),
    url: () => page.url(),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    locator: (selector) => wrapLocator(page.locator(selector))
  };
}

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
    /** Which LinkedIn account. Absent means the owner seat. */
    seatKey?: string;
    /** The seat's own IANA timezone, when the caller already has it. */
    timezone?: string | null;
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
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { status: 'failed', message: linkedInOffReason(config) };

  let page = options.page ?? null;
  if (!page) {
    const mode = seatBrowserMode(config);
    if (mode.blocked) return { status: 'failed', message: mode.blocked };
    const handle = await openBrowser(config, log, {
      workspaceId: options.workspaceId,
      seatKey,
      headless: mode.headless,
      timezone: options.timezone ?? null
    });
    if (!handle) return { status: 'failed', message: BROWSER_OPEN_FAILED_MESSAGE };
    page = handle.page;
  }

  const driver = options.driver ?? playwrightDriver;

  // SESSION REUSE, AND IT IS THE NORMAL PATH. Nothing is decrypted to get here.
  // Per seat, because each seat has its own profile directory and therefore its
  // own session: one account's live session says nothing about another's.
  if (await driver.isLoggedIn(page)) {
    await stampSeatSessionValid(db, options.workspaceId, now, seatKey);
    return { status: 'ok', message: 'That LinkedIn session is still live, so nothing had to be signed in.' };
  }

  const credentials = await readLinkedInCredentials(db, options.workspaceId, process.env, seatKey);
  if (!credentials) {
    // Covers hosted, nothing stored, and half stored. One sentence -- naming
    // the seat only when there is more than one it could be, because "seat
    // 'owner'" means nothing to somebody running a single account.
    return {
      status: 'failed',
      message: seatKey === OWNER_SEAT_KEY
        ? 'Save your LinkedIn email and password here to sign in.'
        : `Save the LinkedIn email and password for seat '${seatKey}' to sign it in.`
    };
  }

  const result = await driver.loginWithCredentials(
    // HUMAN CADENCE ON THE ONE FORM THAT MATTERS. The wrapper is applied here
    // and nowhere else: this is the only call in the codebase that types a
    // credential, and every other page interaction is a click on a control the
    // driver just found. Seeded by the seat, so the same account types at the
    // same speed on every machine.
    humanCadencePage(page, `linkedin-login:${options.workspaceId}:${seatKey}`),
    {
      email: credentials.email,
      password: credentials.password,
      otp: options.otp
    }
  );

  if ('needsOtp' in result) {
    return { status: 'otp_required', message: 'LinkedIn wants a verification code; enter the one it just sent and sign in again.' };
  }
  if (result.ok) {
    await stampSeatSessionValid(db, options.workspaceId, now, seatKey);
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
    /** Which LinkedIn account. Absent means the owner seat. */
    seatKey?: string;
    /** The seat's own IANA timezone, when the caller already has it. */
    timezone?: string | null;
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
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;

  // The gate first, before anything is imported, opened or queried.
  if (!config.enabled) return { ok: false, blocked: linkedInOffReason(config) };

  if (options.page) return { ok: true, page: options.page, driver };

  const mode = seatBrowserMode(config);
  if (mode.blocked) return { ok: false, blocked: mode.blocked };

  const handle = await openBrowser(config, log, {
    workspaceId: options.workspaceId,
    seatKey,
    headless: mode.headless,
    timezone: options.timezone ?? null
  });
  if (!handle) return { ok: false, blocked: BROWSER_OPEN_FAILED_MESSAGE };

  // Every seat signs itself in: the session is reused when it still works, and
  // signed in with the stored email and password when it does not.
  const outcome = await loginLinkedInSeat(db, config, {
    workspaceId: options.workspaceId,
    seatKey,
    timezone: options.timezone ?? null,
    now,
    driver,
    page: handle.page,
    log
  });
  if (outcome.status !== 'ok') return { ok: false, blocked: outcome.message };

  return { ok: true, page: handle.page, driver };
}

/**
 * Close one seat's browser, one workspace's, or -- called with no arguments,
 * from the worker's drain -- every one this process opened.
 *
 * Three scopes because three callers need three different things: a shutdown
 * closes everything (a browser left open holds its profile directory locked
 * and the next worker cannot attach), a workspace being torn down closes its
 * seats, and a single seat that has to be reopened in a different mode closes
 * only itself and leaves its sibling accounts running.
 */
export async function closeLinkedInBrowser(workspaceId?: string, seatKey?: string): Promise<void> {
  const handles = workspaceId
    ? (() => {
        // A seat key names exactly one handle; without one, every seat under
        // this workspace, which is what "close this workspace's browser" has
        // to mean now that a workspace can have several.
        const prefix = `${workspaceId} `;
        const keys = seatKey
          ? [seatHandleKey(workspaceId, seatKey)]
          : [...browsers.keys()].filter((key) => key.startsWith(prefix));
        const found: BrowserHandle[] = [];
        for (const key of keys) {
          const handle = browsers.get(key);
          browsers.delete(key);
          if (handle) found.push(handle);
        }
        return found;
      })()
    : [...browsers.values()];
  if (!workspaceId) browsers.clear();
  await Promise.all(
    handles.map(async (handle) => {
      try {
        await handle.close();
      } catch {
        // A browser we cannot close is not a reason to fail a shutdown.
      }
    })
  );
}

/**
 * The worker's entry point: one pass over every SEAT with work due.
 *
 * ONE BATCH PER ACCOUNT, DRAINED INDEPENDENTLY. Each seat gets its own browser
 * (its own profile directory, its own session, its own fingerprint and its own
 * proxy if it has one), its own posture read, its own claim and its own
 * cooldown. A seat that is paused, cooling, unable to sign in, or that hits a
 * limit wall mid-batch is LOGGED AND SKIPPED, and the loop moves to the next
 * seat -- a checkpoint on one LinkedIn account must not stop the others, which
 * is the whole reason an operator runs more than one.
 *
 * Sequential rather than parallel, deliberately: two headed Chrome windows
 * racing on one laptop is a worse experience than two batches in a row, and
 * the per-action gaps mean a batch is mostly sleeping anyway.
 *
 * NEVER THROWS. It is called from the worker cycle alongside the automation
 * sweep and the playbook engine, and a LinkedIn failure must not cost any of
 * them their tick.
 */
export async function runDueLinkedInActions(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: {
    now?: Date;
    driver?: LinkedInDriver;
    log?: (message: string) => void;
    /**
     * Serve only this seat key. Absent means every seat with work due, which is
     * the normal single-process case; naming one is how an operator splits
     * accounts across processes or machines (`npm run linkedin:worker --
     * --seat=sales`).
     */
    seatKey?: string;
  } = {}
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
  let seats: DueSeat[];
  try {
    seats = await seatsWithDueActions(db, now);
  } catch (cause) {
    log(`LinkedIn local worker could not list due actions: ${cause instanceof Error ? cause.message : String(cause)}`);
    return [];
  }
  if (options.seatKey) seats = seats.filter((seat) => seat.seatKey === options.seatKey);

  for (const { workspaceId, seatKey, timezone } of seats) {
    // Opened lazily and once per SEAT, only after there is one to serve.
    const handle = await openBrowser(config, log, {
      workspaceId,
      seatKey,
      headless: !headed.canLaunchHeaded,
      timezone
    });
    if (!handle) {
      // `continue`, not `return`. A browser this seat cannot open -- a proxy it
      // refused to skip, a profile directory another process holds -- says
      // nothing about the next seat, and returning here used to abandon every
      // remaining workspace's work for one workspace's problem.
      log(`LinkedIn local worker could not open a browser for ${workspaceId}/${seatKey}; its work stays due.`);
      continue;
    }

    // Every seat signs itself in: the session is made usable before the batch
    // opens, reused when it still works and signed in when it does not.
    const outcome = await loginLinkedInSeat(db, config, { workspaceId, seatKey, timezone, now, driver, page: handle.page, log });
    if (outcome.status !== 'ok') {
      log(`LinkedIn local worker cannot use seat ${workspaceId}/${seatKey}: ${outcome.message}`);
      continue;
    }

    const store = postgresLocalWorkerStore(db, workspaceId, seatKey);
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
              // `at`, NOT `action.plannedFor`. This re-check happens immediately
              // before the driver touches LinkedIn, so `at` IS the instant the
              // action is about to happen -- the same principle `withdraw.ts`
              // `evaluateWithdrawalSafety` already documents ("a withdrawal
              // happens now, so `now` is the instant business hours and the
              // weekend rule are judged against"). `action.plannedFor` is the
              // slot the ledger row was ORIGINALLY paced for; once a batch falls
              // behind (seat paused, worker downtime, a backlog drained on
              // resume), that slot can be hours or days stale while still
              // reading as a valid business-hours instant, which let the
              // business-hours and weekend checks pass real sends that were
              // actually about to fire at night or on a weekend. Every other
              // check in the gate already reasons from `at`; this brings
              // business-hours/weekend in line with them.
              plannedFor: at.toISOString(),
              // THE THREE FACTS THAT LIVE ON THE ROW AND NOWHERE ELSE.
              //
              // `campaignId` turns the campaign-day ramp on. It was omitted,
              // and the claim did not even select the column, so
              // `campaign-warmup` took its "no campaign was named" branch and
              // passed unconditionally on every send this worker made: the
              // 20/40/60/80/100% ramp shaped planning (`runner.ts`) and nothing
              // at all at the moment of execution.
              //
              // `replayScope` is what makes `duplicate-target` ask the ledger's
              // own question (migration 047) instead of a stricter one the
              // ledger would not have asked.
              //
              // `overrideWarmupCeiling` is the operator's recorded decision
              // about ONE reply (migration 044), read off the row so it sticks
              // to it. This worker never sets it and never infers it -- it
              // carries what `enqueueReply` wrote.
              ...(action.campaignId ? { campaignId: action.campaignId } : {}),
              ...(action.replayScope ? { replayScope: action.replayScope } : {}),
              ...(action.overrideWarmupCeiling ? { overrideWarmupCeiling: true } : {})
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
      if (result.halted && result.haltReason) log(`LinkedIn local worker stopped for ${workspaceId}/${seatKey}: ${result.haltReason}`);
    } catch (cause) {
      // One SEAT's failure is one seat's failure. The loop carries on to the
      // next account rather than ending the tick.
      log(`LinkedIn local worker failed for ${workspaceId}/${seatKey}: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    /** Which LinkedIn account is being connected. Absent means the owner seat. */
    seatKey?: string;
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
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
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
    const handle = await openBrowser(config, log, {
      workspaceId: options.workspaceId,
      seatKey,
      headless: mode.headless,
      // The timezone the client just read off its own Intl settings, which for
      // a first detect is the only one that exists -- there is no seat row yet.
      timezone: options.timezone
    });
    if (!handle) return refuse(BROWSER_OPEN_FAILED_MESSAGE);
    page = handle.page;
  }

  const driver = options.driver ?? playwrightDriver;

  // The session is made usable before anything is read: reused when it still
  // works, signed in with the stored email and password when it does not.
  const outcome = await loginLinkedInSeat(db, config, {
    workspaceId: options.workspaceId,
    seatKey,
    timezone: options.timezone,
    now,
    driver,
    page,
    log
  });
  if (outcome.status !== 'ok') return refuse(outcome.message, outcome.status === 'challenge' ? 'challenge' : null);

  const read = await driver.readSeat(page);
  if (!isSeatRead(read)) {
    return refuse(
      'LinkedIn did not return a readable profile page; run `npm run linkedin:worker` on a machine with a display to see why.',
      read.failureKind ?? 'unknown'
    );
  }

  const existing = await getSeat(db, options.workspaceId, seatKey);

  // A DIFFERENT LINKEDIN ACCOUNT THAN LAST TIME. `previousProfileUrl` is the
  // identity this workspace last CONFIRMED (written by this same function on
  // an earlier run); `read.profileUrl` is who the browser is signed in as
  // right now, just re-verified by `loginLinkedInSeat` above. When they
  // disagree, an operator has swapped which LinkedIn account this workspace
  // automates -- new credentials saved over old ones -- and two things about
  // the OLD account must not silently carry over to the new one:
  //
  //   1. THE STORED INBOX. `linkedin_threads`/`linkedin_messages` are a read
  //      cache of one specific human's conversations, and since migration 045
  //      they are keyed by (workspace_id, seat_key) -- so only THIS seat's
  //      cache is cleared below. Left in place, the new account's Inbox screen
  //      would show somebody else's DMs as its own; cleared workspace-wide, a
  //      re-connect of one account would wipe every other account's inbox.
  //   2. THE RAMP CLOCK. `activatedAt` measures how long THIS ACCOUNT has been
  //      automated (plan 1.3); carrying an old account's clock into a brand
  //      new one would pace it as an established seat on day one.
  //
  // `linkedin_actions` -- the send ledger -- is deliberately left alone, for
  // the exact reason `deleteSeat` already leaves it alone: it is history, not
  // this account's current view.
  const previousProfileUrl = existing?.profileUrl ?? null;
  const accountChanged = previousProfileUrl !== null && previousProfileUrl !== read.profileUrl;
  let accountChangeNote: string | null = null;
  if (accountChanged) {
    const clearedThreads = await clearInboxForSeat(db, options.workspaceId, seatKey);
    // The same "start over" path `DELETE /api/linkedin/seat` already offers on
    // purpose (seats.ts): the `upsertSeat` call below re-inserts the row
    // fresh, so `activatedAt` becomes `now` and the ramp restarts at week 1.
    // Per seat, for the same reason the inbox clear is: swapping which account
    // seat B automates must not restart seat A's warm-up ramp.
    await deleteSeat(db, options.workspaceId, seatKey);
    accountChangeNote =
      `This browser signed in as ${read.profileUrl}, not ${previousProfileUrl} as this workspace last confirmed. `
      + `${clearedThreads} stored conversation${clearedThreads === 1 ? '' : 's'} from the previous account `
      + `${clearedThreads === 1 ? 'was' : 'were'} cleared and the warm-up ramp restarted for the new account.`;
    log(accountChangeNote);
  }

  const seat = await upsertSeat(
    db,
    options.workspaceId,
    {
      // The label is the operator's own words. A detected display name only
      // fills a seat that has none -- re-detecting must not rewrite "Pankaj
      // (founder)" into whatever the profile heading says this month. That
      // holds across an account change too: `existing` was captured before the
      // reset above, so a custom label survives it on purpose -- it names this
      // workspace's seat, not the LinkedIn account behind it.
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
    now,
    seatKey
  );

  return {
    detected: { profileUrl: read.profileUrl, name: read.name, connectionsCount: read.connectionsCount },
    seat,
    degraded: accountChangeNote ? [accountChangeNote, ...read.degraded] : read.degraded,
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
        // The request has always carried the seat it is for (migration 045);
        // it was simply never read here, so a Connect pressed for a second
        // account detected the FIRST one and wrote its identity over the
        // second seat's row.
        seatKey: request.seatKey,
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
    if (failureReason) log(`LinkedIn seat detection failed for ${request.workspaceId}/${request.seatKey}: ${failureReason}`);
  }

  return settled;
}
