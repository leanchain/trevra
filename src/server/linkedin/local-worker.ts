import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { releaseStaleProfileLock } from '../browser/local.js';
import { id, type Db } from '../db.js';
import {
  browserProviderSettings,
  openSeatBrowser,
  type BrowserStorageState,
  type ProviderBrowserContext,
  type ProviderDriver
} from '../browser/provider.js';
import { readLinkedInCredentials } from '../secrets/linkedin.js';
import { companionBrowserSettings } from './companion.js';
import {
  clearSeatStorageState,
  readSeatStorageState,
  saveSeatStorageState
} from './session-state.js';
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
  playwrightDegreeDriver,
  playwrightDriver,
  readOpenProfile,
  type LinkedInDriver,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInLocator,
  type LinkedInPage,
  type LinkedInAttachment
} from './driver.js';
import {
  isThreadListing,
  isThreadTranscript,
  type LinkedInInboxMessage,
  type LinkedInThreadSummary
} from './driver-inbox.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { readPage, setHumanSessionSalt, settle, type HumanPage } from './human.js';
import {
  pruneSeatEvents,
  recordSeatEvent,
  seatRestingUntil,
  setSeatRestingUntil
} from './seat-events.js';
import { ACTION_GAP_SECONDS, type PacedKind } from './limits.js';
import { dayShapeFor, localDateOf, visitsForDay, workWindowOf, zonedToUtc } from './pacing.js';
import { clearInboxForSeat, syncThreadMessages, syncThreads } from './inbox.js';
import {
  OWNER_SEAT_KEY,
  assertTimezone,
  deleteSeat,
  getSeat,
  getSeatPosture,
  seatProxyUrl,
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
 * absent because `driver.ts` has no InMail routine, and claiming an action
 * nothing can perform would wedge it under a claim forever. `comment` is absent
 * for the same reason and has no band either.
 *
 * `inmail`'s ABSENCE IS NOW A DECLARATION RATHER THAN A SIDE EFFECT. It is
 * named in `UNSUPPORTED_ACTION_KINDS` (actions.ts) and removed from the
 * campaign builder, the branch vocabulary and every analytics counter, because
 * a list that quietly omitted it left every OTHER surface in the product
 * offering, pacing and counting a kind this line had already decided could
 * never be sent. `withdraw` is absent for a different reason and not a gap: a
 * withdrawal is performed by `runWithdrawalBatch`, which has its own claim, its
 * own queue and its own ceiling, and its ledger row is filed after the fact.
 *
 * `reply` and the three engagement kinds joined when `driver-inbox.ts` and
 * `driver-engage.ts` gave them routines. Every one of them still goes through
 * `evaluateLinkedInSafety` at the moment of execution, unfiltered -- being
 * cheap to perform is not a reason to be ungated, and liking two hundred posts
 * in an hour is a ban signal however harmless one like is.
 */
export type ExecutableKind =
  'invite' | 'dm' | 'reply' | 'inmail' | 'profile_view' | 'follow' | 'like' | 'endorse';
export const EXECUTABLE_KINDS: readonly ExecutableKind[] = [
  'invite',
  'dm',
  'reply',
  'inmail',
  'profile_view',
  'follow',
  'like',
  'endorse'
];

// ---------------------------------------------------------------------------
// Who this worker is, which slice of the fleet it serves, and for how long it
// may hold what it takes
// ---------------------------------------------------------------------------

/**
 * This process's identity, written onto everything it claims.
 *
 * IT USED TO BE UNNECESSARY AND NOW IT IS LOAD-BEARING. With one worker on one
 * machine, "who claimed this row" had exactly one answer and nobody had to
 * write it down. With many worker hosts, a claim with no owner is a claim
 * nothing can reason about: it cannot be reclaimed safely (whose was it?), it
 * cannot be recognised after a restart (was it mine?), and a lease cannot be
 * extended by the only process entitled to extend it.
 *
 * `TREVRA_WORKER_ID` when the deployment sets one -- a StatefulSet pod name, a
 * machine id, whatever the operator can look up -- and `<hostname>:<pid>`
 * otherwise, which is unique in practice and self-explanatory in a log.
 */
export function workerIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TREVRA_WORKER_ID?.trim();
  return configured || `${workerHost(env)}:${process.pid}`;
}

/**
 * WHICH MACHINE this process is on, separately from which process it is.
 *
 * The distinction is the whole of the seat-affinity rule: a restarted worker
 * is a new identity on the SAME disk, and that disk is where the seat's Chrome
 * profile -- which is to say the seat's LinkedIn session -- lives. See
 * {@link claimSeatLease}.
 */
export function workerHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TREVRA_WORKER_HOST?.trim();
  return configured || hostname();
}

/**
 * Which slice of the fleet this worker serves: `index` of `total`.
 *
 * WHY A SHARD AT ALL. Every worker used to run the identical discovery query
 * in the identical order, so they all reached for the same seat and
 * `launchPersistentContext` gave the profile directory's exclusive lock to
 * whichever arrived first; the rest failed and raced on to the next one
 * together. Adding a worker added contention and no throughput. A static
 * partition on (workspace, seat) means two workers cannot WANT the same seat,
 * so the leases below are a correctness backstop rather than the mechanism.
 *
 * Hashed rather than assigned, because assignment needs a coordinator and
 * hashing needs nothing. `hashtext` is Postgres's own, evaluated in the query,
 * so the partition is identical in every statement that uses it -- which is
 * what keeps a seat's actions, its side tasks and its browser profile on ONE
 * host.
 *
 * THROWS on a value that is not a partition. A worker that silently rounded
 * `TREVRA_LINKEDIN_WORKER_INDEX=5` of 3 down to something workable would serve
 * a slice nobody else serves or a slice somebody else already serves, and both
 * are silent. The entry points validate at startup, where an operator is
 * watching.
 */
export interface WorkerShard {
  index: number;
  total: number;
}

/** Everything, which is what one worker on one machine has always meant. */
export const SINGLE_WORKER_SHARD: WorkerShard = { index: 0, total: 1 };

export function workerShard(env: NodeJS.ProcessEnv = process.env): WorkerShard {
  const rawTotal = env.TREVRA_LINKEDIN_WORKER_COUNT?.trim();
  const rawIndex = env.TREVRA_LINKEDIN_WORKER_INDEX?.trim();
  if (!rawTotal && !rawIndex) return SINGLE_WORKER_SHARD;
  const total = Number.parseInt(rawTotal ?? '1', 10);
  const index = Number.parseInt(rawIndex ?? '0', 10);
  if (!Number.isFinite(total) || total < 1) {
    throw new Error('TREVRA_LINKEDIN_WORKER_COUNT must be a whole number of workers, 1 or more.');
  }
  if (!Number.isFinite(index) || index < 0 || index >= total) {
    throw new Error(
      `TREVRA_LINKEDIN_WORKER_INDEX must be between 0 and ${total - 1} when TREVRA_LINKEDIN_WORKER_COUNT is ${total}.`
    );
  }
  return { index, total };
}

/**
 * The shard test, as SQL, spelled in exactly one place.
 *
 * `hashtext` can return the most negative int32, and `abs()` of that raises
 * `integer out of range` -- a query that works for every seat until it does not
 * and then takes the whole discovery read down. `((h % t) + t) % t` is
 * non-negative for every input without ever negating anything.
 *
 * `total <= 1` short-circuits to true so an unsharded deployment does not pay
 * a hash per row, and so this expression is a no-op everywhere it is not
 * configured.
 */
function shardPredicate(expression: string): string {
  return `(?::int <= 1 OR (((hashtext(${expression}) % ?::int) + ?::int) % ?::int) = ?::int)`;
}

/** The five parameters {@link shardPredicate} consumes, in order. */
function shardParams(shard: WorkerShard): [number, number, number, number, number] {
  return [shard.total, shard.total, shard.total, shard.total, shard.index];
}

/**
 * How long a claim on ONE action is believed without a heartbeat.
 *
 * Generous on purpose. The cost of a lease that is too SHORT is a duplicate
 * invite (a second worker reclaims a row the first is mid-way through sending,
 * and a duplicate cannot be withdrawn from somebody's notifications); the cost
 * of one that is too LONG is that a genuinely dead worker's rows wait a few
 * more minutes. Those are not comparable, so this is minutes rather than
 * seconds, and it is refreshed immediately before every action.
 */
export const ACTION_LEASE_MS = 15 * 60_000;

/**
 * How long a claim on a SEAT is believed without a heartbeat.
 *
 * Longer than an action's, because a batch legitimately runs for tens of
 * minutes (up to 25 actions behind 30-120s gaps), and heartbeated while it
 * does.
 */
export const SEAT_LEASE_MS = 45 * 60_000;

/**
 * When a batch left 'running' is presumed abandoned.
 *
 * A full batch is ~50 minutes at the maximum gap, so this is comfortably past
 * anything a live worker can still be doing -- the same reasoning as
 * `STALE_RUN_MINUTES` in `agent/runs.ts`, and for the same reason: what the
 * drain cannot finish, the next worker writes off rather than leaving it to
 * wedge that seat's ledger forever.
 */
export const STALE_BATCH_MS = 2 * 60 * 60_000;

/**
 * How long a claim written BEFORE leases existed is left alone.
 *
 * A day, because these rows are unrecoverably ambiguous in only one direction:
 * a pre-lease claim with no `failure_kind` cannot be a deliberate hold (the
 * hold path always records one), so it is a crash-strand -- but there is no
 * deadline on it to compare against, so the only evidence available is that it
 * has been sitting there far longer than any batch runs.
 */
export const LEGACY_CLAIM_GRACE_MS = 24 * 60 * 60_000;

/**
 * How many seats one worker may drive at once.
 *
 * ONE WHERE A HUMAN IS WATCHING, SEVERAL WHERE NOBODY IS. Headed means the
 * operator's own laptop and their own Chrome windows: two of those fighting
 * over the foreground is worse than two batches in a row, which is the
 * argument `trevra-linkedin-worker.ts` has always made and it is still right.
 * Headless means a container serving other people's seats, where strictly
 * serial is not a preference but a queue that never drains -- a batch is ~31
 * minutes, so a hundred due seats is two days of work per tick.
 *
 * Bounded rather than unbounded because each in-flight seat is a whole
 * Chromium at ~350-500MB; the ceiling is memory, not patience.
 */
export function defaultSeatConcurrency(
  headless: boolean,
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number.parseInt(env.TREVRA_LINKEDIN_SEAT_CONCURRENCY ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return headless ? 3 : 1;
}
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
  /** Subject for InMail. Null for every other LinkedIn action. */
  subject?: string | null;
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
  /**
   * This reply answers a conversation the other person wrote in first.
   *
   * READ OFF THE ROW, NEVER DECIDED HERE, exactly like the field above and for
   * the same reason: `enqueueReply` read it from the thread's own history at
   * queue time (migration 074), and the gate this worker re-runs before typing
   * anything has to reach the same verdict or the reply it already accepted
   * would be refused at the last moment and sit in the queue forever.
   */
  replyToInbound?: boolean;
  /**
   * A PERSON put this row here, and the ledger says so.
   *
   * READ OFF THE ROW's `source` column, never decided here, exactly like the
   * two fields above it. `source='manual'` is what the hand-driven surfaces
   * write (`enqueueReply`, the engagement route) and what the planner and the
   * campaign runner never write, so the gate's pre-send re-evaluation reaches
   * the same verdict the queue-time call did: the working window and the
   * weekend rule pace what this account does BY ITSELF, and refusing a queued
   * manual action at the moment of execution would strand it in the queue for
   * a clock that already let it in.
   */
  manual?: boolean;
  channelMetadata?: Record<string, unknown>;
  attachment?: Record<string, unknown> | null;
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
  closeBatch(
    batchId: string,
    outcome: { status: BatchStatus; haltReason: string | null; executed: number },
    now: Date
  ): Promise<void>;
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
  claimNextDueAction(
    batchId: string,
    now: Date,
    exclude?: readonly string[]
  ): Promise<DueLinkedInAction | null>;
  /** Nothing was sent: put the action back in the queue, recording why. */
  releaseClaim(actionId: string, failureKind: LinkedInFailureKind | null): Promise<void>;
  /**
   * The LinkedIn page this target was FOUND on, when Trevra knows it.
   *
   * WHY A QUEUE NEEDS TO KNOW WHERE A LEAD CAME FROM. Every action used to
   * reach its target by typing the profile URL into the address bar: a cold
   * document load of `/in/<stranger>/` with no view before it, no referer and
   * nothing that led to it. That is not how a member reaches a profile and it
   * is exactly how a script working from a list of URLs does. Handed the
   * source page, the worker opens it once, reads it, and clicks the person's
   * card -- which is one page load for a whole sitting instead of one cold
   * load per action, and every action after the first is a client-side route.
   *
   * OPTIONAL, and null is the normal answer for a target nobody sourced
   * (a manual add, an import, a reply). The caller falls back to the address
   * bar, which is what it always did.
   */
  sourcePageFor?(targetRef: string): Promise<string | null>;
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
  settleSent(
    actionId: string,
    externalRef: string | null,
    now: Date,
    metadata?: Record<string, unknown>
  ): Promise<void>;
  /**
   * File a reply's own words into its conversation the moment it lands, off
   * the SAME re-read `runLinkedInLocalBatch` just took, so the thread shows
   * what Trevra typed without an operator clicking "Sync this thread"
   * afterwards. Optional: a store with no inbox table behind it (or a test
   * that never exercises this) simply skips it -- the send this follows has
   * already settled either way, and a failure here must never undo that.
   */
  recordReplyMessages?(
    threadUrn: string,
    messages: readonly LinkedInInboxMessage[],
    now: Date
  ): Promise<void>;
  /**
   * File the conversation a first message just opened, so it exists to hold
   * the reply it did not have a moment ago. Always called before
   * `recordReplyMessages` for the same thread -- that method requires the row
   * this one creates. Optional for the same reason every method in this pair
   * is: a store with no inbox table, or a test that never exercises this,
   * simply skips it.
   */
  recordNewThread?(summary: LinkedInThreadSummary, now: Date): Promise<void>;
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
  /**
   * Outcome unknown: KEEP the claim so no retry can duplicate it, and MARK it
   * so nothing can mistake it for a worker that died.
   *
   * The two used to look identical in the database -- 'planned' with a
   * `claimed_at` -- which is why there was no reaper at all: anything able to
   * recover a crashed worker's claims would also have re-queued an action that
   * may already have reached somebody's notifications. See migration 054.
   */
  holdClaim(actionId: string, failureKind: LinkedInFailureKind): Promise<void>;
  /**
   * Push the claimed row's lease forward while this batch is still working on
   * it.
   *
   * Called immediately before the driver acts -- after the paced gap, which is
   * the long wait -- so "the lease expired" can only ever mean "the worker is
   * gone" and never "the worker is slow". Everything about the reaper's safety
   * rests on that being true.
   */
  heartbeat(batchId: string, actionId: string | null, now: Date): Promise<void>;
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

/**
 * How many conversations deep a `dm` send looks for the thread it just
 * opened, right after sending -- never the full rail `syncRail` walks.
 * LinkedIn sorts the rail by recency, so the conversation a message just
 * opened is at or near the top; this only needs to be deep enough to survive
 * something else having moved above it in the moment between the send and
 * this read. Missing it costs nothing beyond what already happens today --
 * the operator's existing "Sync the inbox" / "mark as sent" fallback.
 */
const NEW_DM_THREAD_LOOKUP_DEPTH = 5;

/**
 * HOW LONG ONE SITTING LASTS, AND HOW LONG THE SEAT IS AWAY AFTERWARDS.
 *
 * `DEFAULT_MAX_ACTIONS` bounds a tick. It does not describe a person. A seat
 * that is available to act at a 30-120s gap from the moment its window opens
 * until the moment it closes -- and does that every working day -- has no
 * SHAPE to its day: no lunch, no meetings, no afternoon where it did something
 * else. Nobody uses LinkedIn like that. People use it in sittings: they open
 * it, do a handful of things, close the tab, and come back later.
 *
 * So a session is 3-8 actions, and then the seat is away for 25-90 minutes and
 * ITS BROWSER IS CLOSED. Closing matters as much as waiting -- a Chromium that
 * stays open on the feed all day, with a session that never ends, is its own
 * signal, and re-opening it is what makes the next sitting start on the feed
 * again like a person arriving.
 *
 * Seeded per seat and per session index, so consecutive sittings differ from
 * each other and from the next seat's, and none of it is `Math.random()`.
 *
 * lc-debt: in-process Maps, so a worker restart forgets an in-flight break and
 * the seat may start its next sitting early; the same trade `challengedSeats`
 * already makes. Upgrade path: a `resting_until` column on `linkedin_seats`.
 */
const SESSION_ACTIONS = { min: 3, max: 8 } as const;
const SESSION_BREAK_MS = { min: 25 * 60_000, max: 90 * 60_000 } as const;
/** seat handle key -> epoch ms this seat may next open a browser. */
const seatBreaks = new Map<string, number>();
/** seat handle key -> how many sittings this process has served it. */
const seatSessions = new Map<string, number>();

export function sessionActionBudget(seed: string): number {
  const random = seededRandom(createHash('sha256').update(seed).digest('hex'));
  return (
    SESSION_ACTIONS.min + Math.floor(random() * (SESSION_ACTIONS.max - SESSION_ACTIONS.min + 1))
  );
}

export function sessionBreakMs(seed: string): number {
  const random = seededRandom(createHash('sha256').update(seed).digest('hex'));
  return Math.round(
    SESSION_BREAK_MS.min + random() * (SESSION_BREAK_MS.max - SESSION_BREAK_MS.min)
  );
}

/** Forget every in-flight sitting. Tests only; a worker never wants this. */
export function resetLinkedInSessionRhythm(): void {
  seatBreaks.clear();
  seatSessions.clear();
}

/**
 * When the visit this seat is currently inside ends, or null when it is not
 * inside one (or has no window to compute one from).
 *
 * Reads the seat rather than taking it, because the one caller is deep inside
 * a batch loop that does not otherwise need the row, and this runs once per
 * sitting rather than once per action.
 */
/**
 * Is work a PERSON asked for sitting due for this seat right now?
 *
 * The one thing that may open a browser during a break, and both halves of it
 * are facts the ledger holds rather than claims a caller makes:
 * `source='manual'` is written by the hand-driven surfaces and by nothing the
 * planner or the campaign runner touches, and `reply_to_inbound` is written by
 * `enqueueReply` from the conversation's own history (migration 074). So an
 * automated action cannot reach this by calling itself urgent.
 *
 * WITHOUT THIS, RELAXING THE GATE WOULD BE HALF A PROMISE: the safety gate
 * stops refusing a manual action typed at 22:00, and then the worker sits on it
 * until the next visit at 08:36 anyway.
 */
export async function dueManualWork(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `
      SELECT 1 AS due FROM linkedin_actions
      WHERE workspace_id = ? AND seat_key = ? AND status = 'planned' AND planned_for <= ?
        AND (source = 'manual' OR (kind = 'reply' AND reply_to_inbound = true))
      LIMIT 1
    `
      )
      .get<{ due: number }>(workspaceId, seatKey, now.toISOString());
    return row !== undefined && row !== null;
  } catch {
    // An un-migrated database has no such column. Resting as before is the
    // safe direction to be wrong in.
    return false;
  }
}

async function visitEndsAt(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date
): Promise<Date | null> {
  try {
    const seat = await getSeat(db, workspaceId, seatKey);
    if (!seat) return null;
    const window = workWindowOf(seat);
    const local = localDateOf(now, seat.timezone);
    const shape = dayShapeFor(`${workspaceId}:${seatKey}`, local, window);
    if (shape.resting) return null;
    const minuteOfDay = local.hour * 60 + local.minute;
    // WITHOUT `actions`, so this is the BASE visit: the same schedule the
    // reading side sees. The planner's stretched end is not knowable here
    // without recomputing the day's ceiling, and erring short only means the
    // next sitting starts at the next visit rather than later in this one.
    const visit = visitsForDay(`${workspaceId}:${seatKey}`, local, shape).find(
      (candidate) => minuteOfDay >= candidate.startMinute && minuteOfDay < candidate.endMinute
    );
    if (!visit) return null;
    return zonedToUtc(local, visit.endMinute * 60, seat.timezone);
  } catch {
    // A seat that cannot be read falls back to the drawn break, which is what
    // this did before visits existed.
    return null;
  }
}

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
/**
 * Open the page this lead was found on, so the driver can click their card.
 *
 * THE LAST COLD LOAD. `driver.ts` `followLinkTo` already prefers a link on the
 * page it is already on; the missing half was ever BEING on such a page. A
 * campaign works from a stored list, so the browser sat on the feed and typed
 * profile URLs. Now the first action of a sitting opens the search or list page
 * the lead came from and reads it, and every action after that is already
 * there -- so the whole sitting costs one list load and N client-side routes,
 * which is both fewer page loads than before and the shape a person makes.
 *
 * ONLY LINKEDIN, ONLY ONCE, NEVER FATAL. The URL is checked against the same
 * host set the driver enforces, the navigation is skipped when the browser is
 * already there, and every failure is swallowed: the driver navigates by URL
 * afterwards exactly as it did before this existed.
 */
/** The same host set `driver.ts` enforces. Nothing else is ever navigated to. */
const LINKEDIN_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

async function arriveFromSource(
  store: LocalWorkerStore,
  page: LinkedInPage,
  targetRef: string,
  seed: string
): Promise<void> {
  if (typeof store.sourcePageFor !== 'function') return;
  try {
    const via = await store.sourcePageFor(targetRef);
    if (!via) return;
    const parsed = new URL(via);
    if (parsed.protocol !== 'https:' || !LINKEDIN_HOSTS.has(parsed.hostname.toLowerCase())) return;
    if (page.url() === via) return;
    await page.goto(via, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settle(page, `${seed}#source`);
    await readPage(page, `${seed}#source-read`);
  } catch {
    // A source page that will not open says nothing about the profile behind
    // it, and the action is not about the source page.
  }
}

async function execute(
  deps: LocalBatchDeps,
  action: DueLinkedInAction,
  seed: string
): Promise<LinkedInDriverResult> {
  switch (action.kind) {
    case 'invite':
      return deps.driver.sendInvite(deps.page, action.targetRef, action.body ?? undefined);
    case 'dm':
      return deps.driver.sendDm(deps.page, action.targetRef, action.body ?? '', {
        attachment: action.attachment as LinkedInAttachment | null | undefined
      });
    case 'inmail': {
      if (!deps.driver.sendInMail) {
        return {
          ok: false,
          failureKind: 'compose_unavailable',
          detail: 'This worker has no InMail driver configured. Nothing was attempted.'
        };
      }
      return deps.driver.sendInMail(
        deps.page,
        action.targetRef,
        action.subject ?? '',
        action.body ?? '',
        {
          allowPaid: action.channelMetadata?.allowPaid === true,
          attachment: action.attachment as LinkedInAttachment | null | undefined
        }
      );
    }
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
    case 'profile_view': {
      if (action.channelMetadata?.openProfileProbe === true) {
        return readOpenProfile(deps.page, action.targetRef);
      }
      if (action.channelMetadata?.connectionProbe === true) {
        const read = await playwrightDegreeDriver.readProfileDegree(deps.page, action.targetRef);
        if ('degree' in read) {
          return {
            ok: true,
            externalRef: `connection-degree:${read.degree ?? 'unknown'}`,
            failureKind: null,
            detail: read.degraded.length > 0 ? read.degraded.join(' ') : undefined
          };
        }
        return read;
      }
      return deps.driver.viewProfile(deps.page, action.targetRef);
    }
    case 'follow':
      return deps.driver.followProfile(deps.page, action.targetRef);
    case 'like':
      return deps.driver.likeRecentPost(deps.page, action.targetRef, { seed });
    case 'endorse':
      return deps.driver.endorseSkills(deps.page, action.targetRef, {
        seed,
        maxSkills:
          typeof action.channelMetadata?.maxSkills === 'number'
            ? action.channelMetadata.maxSkills
            : undefined
      });
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
export async function runLinkedInLocalBatch(
  store: LocalWorkerStore,
  deps: LocalBatchDeps
): Promise<LocalBatchResult> {
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
      log(
        `LinkedIn local worker skipped action ${action.id}: ${verdict.reason ?? 'the safety gate refused it'}`
      );
      continue;
    }

    // THE LAST THING BEFORE THE DRIVER TOUCHES LINKEDIN: push the lease out.
    //
    // An action can take a while (a page load, a composer, a send), and the gap
    // in front of it can be two minutes. A reaper comparing `lease_expires_at`
    // to now must never conclude that a worker in the middle of THIS is gone,
    // because reclaiming this row means somebody may get a second invite. So
    // the deadline is refreshed here, where it is provably still ours, rather
    // than only at claim time.
    await store.heartbeat(batchId, action.id, at);

    // ARRIVE THE WAY A PERSON WOULD, when we know where this lead came from.
    // No-op when the source is unknown, when the browser is already on that
    // page (the normal case after the first action of a sitting), or when
    // anything at all goes wrong -- the driver's own navigation is unchanged
    // and still runs.
    await arriveFromSource(store, deps.page, action.targetRef, `${batchId}:${action.id}`);

    // One seed per (batch, action), the same string the inter-action gap is
    // drawn from, so the whole of a batch's timing -- between actions and
    // within one -- is reproducible from two ids in the ledger.
    const outcome = await execute(deps, action, `${batchId}:${action.id}`);

    if (outcome.ok) {
      await store.settleSent(action.id, outcome.externalRef ?? null, at, outcome.metadata);
      // BEST-EFFORT, AND STRICTLY AFTER THE SETTLE ABOVE: the reply already
      // landed on LinkedIn and the ledger already says so. Re-reading the
      // conversation is only so the transcript catches up to that same fact
      // without a separate manual sync -- a failure here changes nothing
      // about what was sent, so it is swallowed rather than turned into a
      // batch failure over a message that already went out.
      if (
        action.kind === 'reply' &&
        action.threadUrn &&
        deps.driver.readThread &&
        store.recordReplyMessages
      ) {
        try {
          const transcript = await deps.driver.readThread(deps.page, action.threadUrn, { now });
          if (isThreadTranscript(transcript)) {
            await store.recordReplyMessages(action.threadUrn, transcript.messages, at);
          }
        } catch (cause) {
          log(
            `LinkedIn local worker sent action ${action.id} but could not re-sync its conversation: ${cause instanceof Error ? cause.message : String(cause)}. "Sync this thread" in the inbox still catches it up.`
          );
        }
      }
      // A FIRST MESSAGE HAS NO THREAD ID TO HAND `readThread` -- that is the
      // whole difference from a reply. LinkedIn only assigns one once the
      // conversation exists, so the only way to find it is the same rail walk
      // `syncRail` does, just a few conversations deep instead of the whole
      // inbox: the one this send just opened is new, so it sorts at or near
      // the top. Matched by `action.targetRef` against `profileUrl`, the same
      // key `syncThreadMessages` already ties a reply back to its action with.
      //
      // NOT FOUND IS NOT AN ERROR. It means this walk's bounded depth did not
      // reach it -- somebody else's conversation moved above it, say -- and the
      // operator is exactly as covered as before this existed: the task
      // composer's "Sync the inbox" / "mark as sent" fallback still applies.
      if (
        action.kind === 'dm' &&
        deps.driver.listConversations &&
        deps.driver.readThread &&
        store.recordNewThread &&
        store.recordReplyMessages
      ) {
        try {
          const listing = await deps.driver.listConversations(deps.page, {
            maxThreads: NEW_DM_THREAD_LOOKUP_DEPTH,
            needsProfileUrl: () => true,
            now
          });
          if (isThreadListing(listing)) {
            const summary = listing.threads.find(
              (thread) => thread.profileUrl === action.targetRef
            );
            if (summary) {
              await store.recordNewThread(summary, at);
              const transcript = await deps.driver.readThread(deps.page, summary.threadUrn, {
                now
              });
              if (isThreadTranscript(transcript)) {
                await store.recordReplyMessages(summary.threadUrn, transcript.messages, at);
              }
            }
          }
        } catch (cause) {
          log(
            `LinkedIn local worker sent action ${action.id} but could not find its new conversation: ${cause instanceof Error ? cause.message : String(cause)}. "Sync the inbox" still catches it up.`
          );
        }
      }
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
      failureKind === 'selector_drift' &&
      action.kind === 'dm' &&
      typeof outcome.detail === 'string' &&
      outcome.detail.startsWith(`${SELECTORS.messageButton} did not match`) &&
      (await store.hasUnacceptedInvite(action))
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
    {
      status: result.halted ? 'halted' : 'completed',
      haltReason: result.haltReason,
      executed: result.executed
    },
    now()
  );
  return result;
}

/** Why this seat may not be worked, or null when it may. */
function postureRefusal(posture: SeatPosture | null): string | null {
  if (posture === null)
    return 'No LinkedIn seat is configured for this workspace, so there is nothing to pace against.';
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
  subject: string | null;
  thread_urn: string | null;
  campaign_id: string | null;
  replay_scope: string | null;
  override_warmup_ceiling: boolean | null;
  reply_to_inbound: boolean | null;
  source: string | null;
  channel_metadata_json: unknown;
  attachment_json: unknown;
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
export const KINDS_REQUIRING_BODY: readonly ExecutableKind[] = ['dm', 'reply', 'inmail'];
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
    const step = entry as {
      id?: unknown;
      day?: unknown;
      kind?: unknown;
      action?: unknown;
      condition?: unknown;
    };
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
    const kind =
      typeof step.kind === 'string'
        ? (step.kind as LinkedInActionKind)
        : typeof step.action === 'string'
          ? (WORKFLOW_ACTION_KINDS[step.action] ?? null)
          : null;
    // `manual_message` and `withdraw_pending` write no outbound ledger row at
    // all (`runner.ts` `kindForStep` returns null for both), so there is no
    // action for a branch to be about and nothing here can reference them.
    if (kind === null) continue;

    const declared =
      typeof step.condition === 'object' &&
      step.condition !== null &&
      typeof (step.condition as StepCondition).on === 'string' &&
      typeof (step.condition as StepCondition).ofStepId === 'string'
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
    const condition =
      declared ??
      (kind === 'dm' && lastInviteStepId !== null
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

/**
 * The real store.
 *
 * `workerId` and `leaseMs` are what turn a claim from "somebody took this" into
 * "this process took this, until then" -- see `claimNextDueAction` and
 * migration 054. They default to the environment's own identity and the
 * standard lease, so every existing caller keeps working unchanged and a test
 * can pin both.
 */
export function postgresLocalWorkerStore(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY,
  options: { workerId?: string; leaseMs?: number } = {}
): LocalWorkerStore {
  const workerId = options.workerId ?? workerIdentity();
  const leaseMs = Math.max(60_000, Math.trunc(options.leaseMs ?? ACTION_LEASE_MS));
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
      await db
        .prepare(
          `
        INSERT INTO linkedin_batches (id, workspace_id, seat_key, status, started_at)
        VALUES (?,?,?,'running',?)
      `
        )
        .run(batchId, workspaceId, seatKey, now.toISOString());
      return batchId;
    },

    async closeBatch(batchId, outcome, now) {
      await db
        .prepare(
          `
        UPDATE linkedin_batches
        SET status=?, halt_reason=?, executed_count=?, finished_at=?
        WHERE id=? AND workspace_id=?
      `
        )
        .run(
          outcome.status,
          outcome.haltReason,
          outcome.executed,
          now.toISOString(),
          batchId,
          workspaceId
        );
    },

    async stopRequested(batchId) {
      // Absent means STOP, exactly like `isAgentRunStopRequested`: a batch that
      // is no longer running, or whose row is gone, is not a batch to keep
      // acting for. A database error still throws -- "I could not find out" is
      // not "carry on".
      const row = await db
        .prepare(
          `
        SELECT 1 AS live FROM linkedin_batches
        WHERE id=? AND workspace_id=? AND status='running' AND stop_requested_at IS NULL
      `
        )
        .get<{ live: number }>(batchId, workspaceId);
      return row === undefined;
    },

    async claimNextDueAction(batchId, now, exclude = []) {
      // CLAIM AND SELECT IN ONE STATEMENT. `FOR UPDATE SKIP LOCKED` means two
      // workers on the same box take different rows instead of the same one,
      // and `claimed_at IS NULL` means a held row (unknown outcome) is never
      // handed out again.
      //
      // THE CLAIM NOW CARRIES A NAME AND A DEADLINE. `claimed_at` alone said
      // only "somebody took this", which on one machine was enough and on a
      // fleet is the strandable state: nothing could say WHICH worker took it,
      // and nothing could say when the claim stopped being believable. So the
      // row records `claimed_by` (this process) and `lease_expires_at` (now +
      // the lease), the running batch pushes that deadline forward before every
      // action, and `reapExpiredActionLeases` releases what a dead worker left
      // behind. Nothing about the deliberate hold changes: it is marked with
      // `settlement_hold_at` and no reaper can see it.
      const row = await db
        .prepare(
          `
        UPDATE linkedin_actions SET claimed_at=?, batch_id=?, claimed_by=?, lease_expires_at=?
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
          ORDER BY queue_priority DESC, planned_for ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        -- campaign_id, replay_scope and override_warmup_ceiling are selected
        -- for ONE consumer: the pre-send re-evaluation of the safety gate.
        -- Without them that call could not run the campaign-day ramp (it was
        -- told no campaign was named, on every real send), could not ask the
        -- ledger's own scoped replay question, and could not honour an override
        -- an operator had already recorded on the row.
        -- for ONE consumer: the pre-send re-evaluation of the safety gate.
        -- Without them that call could not run the campaign-day ramp (it was
        -- told no campaign was named, on every real send), could not ask the
        -- ledger's own scoped replay question, could not honour an override an
        -- operator had already recorded on the row, and could not tell a row a
        -- person queued by hand from one the planner placed.
        RETURNING id, workspace_id, seat_key, kind, target_ref,
                  TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
                  body, subject, thread_urn, campaign_id, replay_scope, override_warmup_ceiling,
                  reply_to_inbound, source, channel_metadata_json, attachment_json
      `
        )
        .get<DueActionRow>(
          now.toISOString(),
          batchId,
          workerId,
          new Date(now.getTime() + leaseMs).toISOString(),
          workspaceId,
          seatKey,
          now.toISOString(),
          [...exclude]
        );
      if (!row) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        seatKey: row.seat_key,
        kind: row.kind as ExecutableKind,
        targetRef: row.target_ref,
        plannedFor: row.planned_for,
        body: row.body,
        subject: row.subject,
        threadUrn: row.thread_urn,
        campaignId: row.campaign_id,
        replayScope: row.replay_scope ?? 'legacy',
        overrideWarmupCeiling: row.override_warmup_ceiling === true,
        replyToInbound: row.reply_to_inbound === true,
        manual: row.source === 'manual',
        channelMetadata: (() => {
          const raw =
            typeof row.channel_metadata_json === 'string'
              ? (() => {
                  try {
                    return JSON.parse(row.channel_metadata_json) as unknown;
                  } catch {
                    return {};
                  }
                })()
              : row.channel_metadata_json;
          return raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        })(),
        attachment: (() => {
          const raw =
            typeof row.attachment_json === 'string'
              ? (() => {
                  try {
                    return JSON.parse(row.attachment_json) as unknown;
                  } catch {
                    return null;
                  }
                })()
              : row.attachment_json;
          return raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
        })()
      };
    },

    async hasUnacceptedInvite(action) {
      // Case-folded on both sides, the way every other target lookup in this
      // subsystem folds them (idx_linkedin_actions_target_ci, migration 031):
      // the invite and the message may have been written from different
      // renderings of the same profile URL.
      const row = await db
        .prepare(
          `
        SELECT 1 AS unaccepted FROM linkedin_actions
        WHERE workspace_id=? AND seat_key=? AND kind='invite'
          AND target_ref IS NOT NULL AND LOWER(target_ref)=LOWER(?)
          -- Every TERMINAL status, and the list is runner.ts's own: a declined
          -- or withdrawn invite is not still waiting to be accepted, it is
          -- finished. Leaving those two out parked the DM behind such an
          -- invite as not-yet-accepted on every pass, forever, on a row that
          -- can never resolve.
          AND status NOT IN ('accepted', 'replied', 'declined', 'withdrawn', 'skipped')
        LIMIT 1
      `
        )
        .get<{ unaccepted: number }>(workspaceId, action.seatKey, action.targetRef);
      return row !== undefined;
    },

    async branchDecision(action, now) {
      const campaign = await db
        .prepare(
          `
        SELECT c.sequence_json AS sequence_json,
               TO_CHAR(c.created_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS created_at
        FROM linkedin_actions a
        JOIN linkedin_campaigns c ON c.id = a.campaign_id AND c.workspace_id = a.workspace_id
        WHERE a.id=? AND a.workspace_id=?
      `
        )
        .get<{ sequence_json: unknown; created_at: string }>(action.id, workspaceId);
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

      const rows = await db
        .prepare(
          `
        SELECT kind, status,
               TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for
        FROM linkedin_actions
        WHERE workspace_id=? AND seat_key=? AND target_ref=?
      `
        )
        .all<{ kind: string; status: string; planned_for: string | null }>(
          workspaceId,
          action.seatKey,
          action.targetRef
        );

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
      await db
        .prepare(
          `
        UPDATE linkedin_actions
        SET claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL, batch_id=NULL, failure_kind=?
        WHERE id=? AND workspace_id=?
      `
        )
        .run(failureKind, actionId, workspaceId);
    },

    /**
     * The page this profile was harvested from, if this workspace harvested it.
     *
     * Newest source wins: a lead re-found by a later search is most likely to
     * still be on that page, and a card that is no longer there costs nothing
     * -- `followLinkTo` finds no link and the driver loads the profile the old
     * way. Scoped to the workspace, like every other read on this store.
     */
    async sourcePageFor(targetRef) {
      const trimmed = targetRef.trim();
      if (!trimmed) return null;
      const row = await db
        .prepare(
          `SELECT s.url AS url
             FROM linkedin_leads l
             JOIN linkedin_lead_sources s ON s.id = l.source_id AND s.workspace_id = l.workspace_id
            WHERE l.workspace_id = ? AND l.profile_url = ?
            ORDER BY l.created_at DESC
            LIMIT 1`
        )
        .get<{ url: string | null }>(workspaceId, trimmed);
      return row?.url ?? null;
    },

    async settleSent(actionId, externalRef, now, metadata) {
      // `recorded_at` is what every rolling window counts, so it is written
      // here and nowhere else: the moment the action actually happened.
      //
      // The lease is dropped with it. A settled row is not in flight, and a
      // deadline left behind on one would have a reaper reasoning about work
      // that is finished.
      await db
        .prepare(
          `
        UPDATE linkedin_actions
        SET status='sent', recorded_at=?, external_ref=?, failure_kind=NULL,
            paid_credit_used=CASE WHEN ?::boolean THEN TRUE ELSE paid_credit_used END,
            channel_metadata_json=channel_metadata_json || ?::jsonb,
            claimed_by=NULL, lease_expires_at=NULL
        WHERE id=? AND workspace_id=?
      `
        )
        .run(
          now.toISOString(),
          externalRef,
          metadata?.paidCreditConsumed === true,
          JSON.stringify(metadata ?? {}),
          actionId,
          workspaceId
        );
    },

    async recordReplyMessages(threadUrn, messages, now) {
      await syncThreadMessages(
        db,
        { workspaceId, seatKey, threadUrn, messages: [...messages] },
        now
      );
    },

    async recordNewThread(summary, now) {
      await syncThreads(db, { workspaceId, seatKey, threads: [summary] }, now);
    },

    async settleSkipped(actionId, failureKind) {
      await db
        .prepare(
          `
        UPDATE linkedin_actions
        SET status='skipped', recorded_at=NULL, claimed_at=NULL, claimed_by=NULL,
            lease_expires_at=NULL, failure_kind=?
        WHERE id=? AND workspace_id=?
      `
        )
        .run(failureKind, actionId, workspaceId);
    },

    // `_reason` is the evaluator's sentence and is deliberately not stored:
    // there is no column for it, and `failure_kind` is not one -- a branch that
    // resolved to "they never accepted" is the sequence working, and writing a
    // failure there would have the ledger report a driver problem that never
    // happened. It reaches the operator through the batch log instead.
    async settleBranchSkipped(actionId, _reason) {
      await db
        .prepare(
          `
        UPDATE linkedin_actions
        SET status='skipped', recorded_at=NULL, claimed_at=NULL, claimed_by=NULL,
            lease_expires_at=NULL, failure_kind=NULL
        WHERE id=? AND workspace_id=?
      `
        )
        .run(actionId, workspaceId);
    },

    async holdClaim(actionId, failureKind) {
      // `claimed_at` is left exactly as it is. That is the hold -- and
      // `settlement_hold_at` is what makes it legible to everything else.
      //
      // WHY THE COLUMN EXISTS (migration 054). Until it did, this row and a row
      // whose worker was killed mid-claim were indistinguishable: both were
      // 'planned' with a `claimed_at` and nothing more. That meant a reaper
      // able to recover the second would also have re-queued the first -- and
      // the first is an action that MAY ALREADY HAVE HAPPENED. We clicked and
      // lost the thread; a retry can put a second invite in somebody's
      // notifications, which cannot be withdrawn. The reaper's predicate is
      // `settlement_hold_at IS NULL`, so it cannot reach this row however long
      // the hold lasts, which is exactly as long as it takes a human to settle
      // it.
      //
      // The lease is CLEARED rather than extended: a hold is not work in
      // flight, and leaving a deadline on it would say a worker is still
      // coming back for it.
      await db
        .prepare(
          `
        UPDATE linkedin_actions
        SET failure_kind=?, claimed_by=?, lease_expires_at=NULL,
            settlement_hold_at=COALESCE(settlement_hold_at, CURRENT_TIMESTAMP)
        WHERE id=? AND workspace_id=?
      `
        )
        .run(failureKind, workerId, actionId, workspaceId);
    },

    async heartbeat(batchId, actionId, now) {
      // THE LEASE MOVES ONLY WHILE SOMETHING IS ACTUALLY HAPPENING TO THE ROW.
      //
      // Called immediately before the driver touches LinkedIn -- after the
      // 30-120s paced gap, which is the long wait -- so the deadline a reaper
      // compares against is never more than one action old. That is what makes an expired lease
      // mean "this worker is gone" rather than "this worker is slow" -- and
      // the whole safety of reclaiming a claim rests on that distinction, since
      // reclaiming a row somebody is mid-way through sending is a duplicate
      // invite.
      //
      // `claimed_by` and `batch_id` are in the predicate: a worker whose claim
      // was already reaped and re-granted must not be able to extend a lease it
      // no longer holds.
      await db
        .prepare(
          `
        UPDATE linkedin_actions SET lease_expires_at=?
        WHERE id=? AND workspace_id=? AND batch_id=? AND claimed_by=?
      `
        )
        .run(
          new Date(now.getTime() + leaseMs).toISOString(),
          actionId,
          workspaceId,
          batchId,
          workerId
        );
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
export async function stopLinkedInBatches(
  db: Db,
  workspaceId: string,
  seatKey?: string
): Promise<number> {
  // No seat named means EVERY seat in the workspace, which is what the API's
  // kill switch means when an operator presses Stop on the workspace. Naming
  // one stops one account and leaves the others running.
  const result = await db
    .prepare(
      `
    UPDATE linkedin_batches SET stop_requested_at=CURRENT_TIMESTAMP
    WHERE workspace_id=? AND (?::text IS NULL OR seat_key=?) AND status='running' AND stop_requested_at IS NULL
  `
    )
    .run(workspaceId, seatKey ?? null, seatKey ?? null);
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
 * One LinkedIn account this worker may serve, with everything the decision to
 * open a browser for it needs.
 */
export interface DueSeatForWorker extends DueSeat {
  /**
   * The seat's STORED posture, or null when the seat row is missing entirely.
   *
   * Joined into discovery rather than read per seat afterwards, and that is a
   * fix rather than an optimisation: a paused or cooling seat used to pay a
   * full Chromium launch, a stored sign-in and a LinkedIn navigation before
   * anything asked whether it was allowed to act. `jobs.ts` already made this
   * exact correction for the side tasks and left the send queue paying it.
   */
  posture: SeatPosture | null;
  /** ISO-8601: the oldest claimable slot on this seat. What tenants are ordered by. */
  oldestDue: string;
}

/** The most seats one pass will serve, and the most any one tenant may take of them. */
const DEFAULT_MAX_DUE_SEATS = 200;
const DEFAULT_MAX_SEATS_PER_WORKSPACE = 5;
/** How deep the orphan sweep below reads before giving up for this pass. */
const ORPHAN_SCAN_LIMIT = 2_000;

/**
 * The seats this worker should serve THIS PASS, in the order it should serve
 * them.
 *
 * THREE THINGS WERE WRONG WITH ASKING `linkedin_actions` DIRECTLY, and all
 * three only appear past one tenant on one machine:
 *
 * 1. IT WAS THE SAME QUERY FOR EVERY WORKER. No workspace predicate, no shard,
 *    ordered `workspace_id, seat_key` -- so every process on the deployment
 *    produced the identical list in the identical order and every one of them
 *    reached for the same seat first. Chromium's user-data-dir lock then gave
 *    it to whoever got there first and the rest failed and raced on to the next
 *    one together: adding workers added contention, not throughput.
 * 2. IT HAD NO LIMIT AND NO FAIRNESS. A tenant with a 50,000-action backlog
 *    sorted first was served first, to completion, on every single tick, and
 *    the tenant whose id sorted last was never reached at all.
 * 3. IT SCANNED. Every index on `linkedin_actions` leads with `workspace_id`
 *    and this query had no `workspace_id` to give, so it read the whole table
 *    and sorted it -- against a 30s `statement_timeout`, which it eventually
 *    lost. The caller turned that into an empty list, which is
 *    indistinguishable from "nothing is due", which is how a deployment's
 *    entire LinkedIn queue can stop with nothing in the log to say so.
 *
 * SO THE QUESTION IS ASKED FROM THE SEAT SIDE INSTEAD. One index probe per
 * seat into `idx_linkedin_actions_due_by_seat` (migration 049, which leads
 * with exactly the columns this needs), so the cost is proportional to how many
 * SEATS this worker's shard owns and NOT to how big anybody's backlog is. A
 * tenant with 50,000 due rows costs precisely one probe, the same as a tenant
 * with one. Ordering the result by each seat's OLDEST due slot then means the
 * account that has been waiting longest is served first, and the per-workspace
 * rank caps what any one tenant can take out of a single pass.
 *
 * Paused and cooling seats are excluded in SQL. They cannot become workable
 * without a human, and letting them consume the pass's seat budget is how a
 * tenant with 500 paused seats starves everybody else. The batch re-reads the
 * posture anyway, between every action, and remains the authority.
 */
export async function dueSeatsForWorker(
  db: Db,
  now: Date,
  options: {
    shard?: WorkerShard;
    seatKey?: string;
    maxSeats?: number;
    maxSeatsPerWorkspace?: number;
  } = {}
): Promise<DueSeatForWorker[]> {
  const shard = options.shard ?? SINGLE_WORKER_SHARD;
  const maxSeats = Math.max(1, Math.trunc(options.maxSeats ?? DEFAULT_MAX_DUE_SEATS));
  const perWorkspace = Math.max(
    1,
    Math.trunc(options.maxSeatsPerWorkspace ?? DEFAULT_MAX_SEATS_PER_WORKSPACE)
  );
  const seatKey = options.seatKey ?? null;

  const rows = await db
    .prepare(
      `
    SELECT ranked.workspace_id, ranked.seat_key, ranked.timezone, ranked.posture, ranked.oldest_due
    FROM (
      SELECT s.workspace_id, s.seat_key, s.timezone, s.posture,
             TO_CHAR(due.oldest_due AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS oldest_due,
             ROW_NUMBER() OVER (PARTITION BY s.workspace_id ORDER BY due.oldest_due ASC, s.seat_key ASC) AS seat_rank
      FROM linkedin_seats s
      CROSS JOIN LATERAL (
        SELECT a.planned_for AS oldest_due
        FROM linkedin_actions a
        WHERE a.workspace_id = s.workspace_id AND a.seat_key = s.seat_key
          AND a.status='planned' AND a.claimed_at IS NULL
          AND a.planned_for IS NOT NULL AND a.planned_for <= ?
          AND a.kind IN (${EXECUTABLE_KIND_LIST})
        ORDER BY a.planned_for ASC
        LIMIT 1
      ) due
      WHERE s.posture NOT IN ('paused', 'cooldown')
        AND (?::text IS NULL OR s.seat_key = ?::text)
        AND ${shardPredicate("s.workspace_id || '/' || s.seat_key")}
    ) ranked
    WHERE ranked.seat_rank <= ?::int
    ORDER BY ranked.oldest_due ASC, ranked.workspace_id ASC, ranked.seat_key ASC
    LIMIT ?::int
  `
    )
    .all<{
      workspace_id: string;
      seat_key: string;
      timezone: string | null;
      posture: string | null;
      oldest_due: string;
    }>(now.toISOString(), seatKey, seatKey, ...shardParams(shard), perWorkspace, maxSeats);

  const seats: DueSeatForWorker[] = rows.map((row) => ({
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    timezone: row.timezone,
    posture: (row.posture as SeatPosture | null) ?? null,
    oldestDue: row.oldest_due
  }));

  // THE SEATLESS QUEUE STILL HAS TO SURFACE, and driving discovery off
  // `linkedin_seats` is exactly how it would stop doing so. A due action whose
  // seat row is missing is a real state (the row was written before the seat
  // was connected, or the seat was deleted underneath it), and the batch has a
  // sentence for it -- 'No LinkedIn seat is configured...' -- that an operator
  // can act on. Dropping it here would leave a queue that quietly never moves,
  // which is the failure this whole discovery path exists to have stopped.
  //
  // Bounded on purpose: the anti-join is read over the oldest ORPHAN_SCAN_LIMIT
  // due rows rather than over the table, so its cost is fixed whatever the
  // backlog. An orphan newer than that many due rows is found on a later pass,
  // once the rows in front of it have drained.
  if (seats.length < maxSeats) {
    const orphans = await db
      .prepare(
        `
      WITH candidate AS (
        SELECT a.workspace_id, a.seat_key, a.planned_for
        FROM linkedin_actions a
        WHERE a.status='planned' AND a.claimed_at IS NULL
          AND a.planned_for IS NOT NULL AND a.planned_for <= ?
          AND a.kind IN (${EXECUTABLE_KIND_LIST})
          AND (?::text IS NULL OR a.seat_key = ?::text)
          AND ${shardPredicate("a.workspace_id || '/' || a.seat_key")}
        ORDER BY a.planned_for ASC
        LIMIT ${ORPHAN_SCAN_LIMIT}
      )
      SELECT c.workspace_id, c.seat_key,
             TO_CHAR(MIN(c.planned_for) AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS oldest_due
      FROM candidate c
      WHERE NOT EXISTS (
        SELECT 1 FROM linkedin_seats s
        WHERE s.workspace_id = c.workspace_id AND s.seat_key = c.seat_key
      )
      GROUP BY c.workspace_id, c.seat_key
      ORDER BY MIN(c.planned_for) ASC
      LIMIT ?::int
    `
      )
      .all<{ workspace_id: string; seat_key: string; oldest_due: string }>(
        now.toISOString(),
        seatKey,
        seatKey,
        ...shardParams(shard),
        maxSeats - seats.length
      );
    for (const row of orphans) {
      seats.push({
        workspaceId: row.workspace_id,
        seatKey: row.seat_key,
        timezone: null,
        posture: null,
        oldestDue: row.oldest_due
      });
    }
    seats.sort((left, right) => left.oldestDue.localeCompare(right.oldestDue));
  }

  return seats;
}

/**
 * Every SEAT with at least one claimable action due now, in workspace order.
 *
 * THE `AND seat_key='owner'` THIS REPLACED WAS THE BUG THAT MADE MULTI-SEAT
 * COSMETIC. Actions were planned, filed and paced per seat all the way down
 * the queue, and then the one query that decides what a worker picks up threw
 * every non-owner row away -- so a second account's queue filled up and never
 * drained, silently, with no error anywhere to notice.
 *
 * NOW A THIN VIEW OVER {@link dueSeatsForWorker}, which is what the worker
 * itself uses: one implementation of "what is due", so a discovery rule can
 * never be true of the listing and false of the loop. Unsharded and unbounded
 * by tenant here, because its callers are asking a question about the whole
 * deployment rather than about one worker's slice of it.
 */
export async function seatsWithDueActions(db: Db, now: Date): Promise<DueSeat[]> {
  const seats = await dueSeatsForWorker(db, now, {
    maxSeats: 10_000,
    maxSeatsPerWorkspace: 10_000
  });
  return seats
    .map((seat) => ({
      workspaceId: seat.workspaceId,
      seatKey: seat.seatKey,
      timezone: seat.timezone
    }))
    .sort(
      (left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) ||
        left.seatKey.localeCompare(right.seatKey)
    );
}

// ---------------------------------------------------------------------------
// Reapers: what a worker that stopped existing leaves behind
// ---------------------------------------------------------------------------

/**
 * Release claims whose lease has expired, and return how many.
 *
 * WHY THE ROWS WERE STRANDED FOREVER. `claimNextDueAction` set `claimed_at`
 * and every discovery and claim predicate tested `claimed_at IS NULL`. Nothing
 * anywhere compared that timestamp to a deadline -- there was no reason to,
 * with one worker on one machine that an operator could see. Kill that worker
 * between the claim and the settle (a deploy, an OOM, a laptop lid) and the
 * row was permanently invisible: not sent, not skipped, not claimable, and not
 * reported. On a fleet that is not an edge case, it is what every rolling
 * deploy does to whatever was in flight.
 *
 * WHAT IT WILL NOT TOUCH, WHICH IS THE HARD PART:
 *
 *   * `settlement_hold_at IS NOT NULL` -- the deliberate hold. The loop keeps
 *     the claim on an UNKNOWN outcome because a retry could put a second
 *     invite in somebody's notifications, and that cannot be withdrawn. A
 *     reaper that could not tell a hold from a crash would turn the single
 *     most dangerous failure mode in this subsystem into a routine one.
 *   * a live lease -- by definition, since the predicate is that it expired.
 *     The worker driving a batch pushes its lease forward before every action,
 *     so an expired lease means the process is gone, not slow.
 *   * a pre-lease claim that carries a `failure_kind` -- those are holds taken
 *     before this migration existed, recognisable because the hold path always
 *     records one and the claim path never does. They are left for a human.
 *
 * Bounded per call and `SKIP LOCKED`, so two workers reaping at once do
 * different rows and neither holds a long transaction open.
 */
export async function reapExpiredActionLeases(
  db: Db,
  options: { now?: Date; limit?: number; legacyGraceMs?: number } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.trunc(options.limit ?? 500));
  const legacyBefore = new Date(
    now.getTime() - Math.max(60_000, options.legacyGraceMs ?? LEGACY_CLAIM_GRACE_MS)
  );
  const result = await db
    .prepare(
      `
    UPDATE linkedin_actions
    SET claimed_at=NULL, claimed_by=NULL, lease_expires_at=NULL, batch_id=NULL
    WHERE id IN (
      SELECT id FROM linkedin_actions
      WHERE status='planned' AND claimed_at IS NOT NULL AND settlement_hold_at IS NULL
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          -- Claimed before leases existed: no deadline to compare, so the
          -- evidence has to be the absence of a hold's own fingerprint.
          OR (lease_expires_at IS NULL AND failure_kind IS NULL AND claimed_at < ?)
        )
      ORDER BY claimed_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
  `
    )
    .run(now.toISOString(), legacyBefore.toISOString());
  return result.changes;
}

/**
 * Close batches left 'running' by a worker that is gone, and return how many.
 *
 * The `linkedin_batches` half of the same problem, and it had no reaper at all.
 * A row stuck in 'running' is not merely untidy: `stopLinkedInBatches` counts
 * it, the operator's Stop button reports batches that nothing is driving, and
 * the ledger cannot say what happened during a deploy. Same shape and same
 * reasoning as `reapStaleAgentRuns` (`agent/runs.ts`), including the wording
 * rule: the batch was ABANDONED, not failed, and saying otherwise would invent
 * a cause.
 *
 * It is also a second kill switch by accident, and a welcome one: the loop
 * treats a batch row that is no longer 'running' as a stop request, so a
 * reaped batch whose worker turns out to be alive stops itself at its next
 * action rather than continuing under a closed row.
 */
export async function reapStaleLinkedInBatches(
  db: Db,
  options: { now?: Date; olderThanMs?: number; limit?: number } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const before = new Date(now.getTime() - Math.max(60_000, options.olderThanMs ?? STALE_BATCH_MS));
  const result = await db
    .prepare(
      `
    UPDATE linkedin_batches
    SET status='halted', halt_reason=?, finished_at=?
    WHERE id IN (
      SELECT id FROM linkedin_batches
      WHERE status='running' AND started_at < ?
      ORDER BY started_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
  `
    )
    .run(STALE_BATCH_REASON, now.toISOString(), before.toISOString());
  return result.changes;
}

const STALE_BATCH_REASON =
  'The worker driving this batch stopped without closing it, so a later worker wrote it off. Nothing about the actions it had already settled changed; anything it had claimed and not settled was released back to the queue.';

// ---------------------------------------------------------------------------
// Seat leases: one driver per account, pinned to the host that has its session
// ---------------------------------------------------------------------------

export type SeatLeaseOutcome = { ok: true; expiresAt: string } | { ok: false; reason: string };

interface SeatLeaseRow {
  worker_id: string;
  host: string;
  profile_dir: string;
  lease_expires_at: string;
}

/**
 * Take this seat for this worker, or say why it may not be taken.
 *
 * TWO DIFFERENT QUESTIONS, AND CONFLATING THEM IS WHY THIS IS NOT JUST A LOCK.
 *
 * The first is mutual exclusion: two processes must not drive one LinkedIn
 * account at the same time. The shard already makes that rare, but a static
 * partition overlaps during a rolling deploy (the old pod and the new one hold
 * the same index for a few seconds), and Chromium's own user-data-dir lock
 * turns the overlap into a launch failure rather than a queue.
 *
 * The second is SESSION PORTABILITY, and it is the one that costs an account.
 * The Chrome profile directory IS the LinkedIn session -- its cookies, its
 * "remember this browser" device trust -- and it lives on ONE host's local
 * disk (`resolveProfileDir`). A different host picking up the same seat finds
 * an empty directory and signs in from scratch: a new device, a new IP, on an
 * account LinkedIn already trusts a specific browser for. That is the single
 * loudest challenge signal available to us, and we would be generating it
 * ourselves, on every seat, every time a pod moved.
 *
 * So a lease is refused when ANOTHER host holds this seat's affinity and this
 * host has no profile for it. Not "until the lease expires" -- forever, until
 * either that host comes back or a human moves the profile. A seat that cannot
 * run here is a seat that waits; a seat that re-authenticates here is a seat
 * that may be gone.
 *
 * WHAT IS DELIBERATELY ALLOWED: the same host, always (a restarted worker is a
 * new pid and the same disk); any host when nobody holds the seat; and any
 * host when the profile is present here too (an operator who has copied or
 * shared the profile directory has said, by doing so, that this host is a home
 * for this seat).
 */
export async function claimSeatLease(
  db: Db,
  options: {
    workspaceId: string;
    seatKey: string;
    workerId: string;
    host: string;
    profileDir: string;
    leaseMs?: number;
  },
  now: Date = new Date()
): Promise<SeatLeaseOutcome> {
  const leaseMs = Math.max(60_000, Math.trunc(options.leaseMs ?? SEAT_LEASE_MS));
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();

  const current = await db
    .prepare(
      `
    SELECT worker_id, host, profile_dir,
           TO_CHAR(lease_expires_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS lease_expires_at
    FROM linkedin_seat_leases WHERE workspace_id=? AND seat_key=?
  `
    )
    .get<SeatLeaseRow>(options.workspaceId, options.seatKey);

  // WHOSE SESSION IS IT, AND CAN IT TRAVEL? The host pin below exists for one
  // reason: the Chrome profile IS the session and it sits on ONE host's local
  // disk, so a second host picking the seat up performs a new-device sign-in.
  // A REMOTE browser has no profile directory at all -- its session lives in
  // `linkedin_seat_sessions`, which every worker can read -- so for a seat held
  // that way the pin is not protecting anything and would instead pin the seat
  // to whichever hosted pod happened to take it first, forever.
  //
  // The distinction is read off the row rather than off this process's own
  // configuration, and that is the part that makes the two runners safe
  // together: a seat currently held by a LOCAL worker still refuses a hosted
  // one (that account's device trust is on that laptop), and a seat held
  // remotely still refuses a local worker with an empty profile directory. Only
  // remote-to-remote is portable, which is exactly the case where it is true.
  //
  // BOTH ENDS HAVE TO BE PORTABLE, not just the current one. A seat held
  // remotely and picked up by a LOCAL worker with an empty profile directory is
  // still a new-device sign-in -- the session is in the database and that
  // worker is not going to read it into a persistent Chrome profile. Only
  // remote-to-remote genuinely carries the session with it.
  const portable = current
    ? isRemoteSessionHome(current.profile_dir) && isRemoteSessionHome(options.profileDir)
    : false;

  if (
    current &&
    !portable &&
    current.host !== options.host &&
    !seatProfilePresent(options.profileDir)
  ) {
    return {
      ok: false,
      reason: isRemoteSessionHome(options.profileDir)
        ? `is pinned to host '${current.host}', which holds its signed-in Chrome profile at ${current.profile_dir}. Running it through a remote browser would start from an empty session and be a brand-new device sign-in on that account -- the loudest challenge signal there is. Stop the worker on that host first if this seat should move to the hosted runner.`
        : `is pinned to host '${current.host}', which holds its signed-in Chrome profile. This host has nothing at ${options.profileDir}, and running it here would be a brand-new device sign-in on that account -- the loudest challenge signal there is. Bring that host back, or copy ${current.profile_dir} here first.`
    };
  }

  // ATOMIC, AND THE `WHERE` IS THE WHOLE LOCK. A conflicting row is updated
  // only when it is ours already or its term has run out; otherwise the
  // statement writes nothing and returns nothing, which is a refusal with no
  // race window between the read above and this write.
  const taken = await db
    .prepare(
      `
    INSERT INTO linkedin_seat_leases (workspace_id, seat_key, worker_id, host, profile_dir, leased_at, lease_expires_at, released_at)
    VALUES (?,?,?,?,?,?,?,NULL)
    ON CONFLICT (workspace_id, seat_key) DO UPDATE
    SET worker_id=EXCLUDED.worker_id, host=EXCLUDED.host, profile_dir=EXCLUDED.profile_dir,
        leased_at=EXCLUDED.leased_at, lease_expires_at=EXCLUDED.lease_expires_at, released_at=NULL
    WHERE linkedin_seat_leases.worker_id = EXCLUDED.worker_id
       OR linkedin_seat_leases.released_at IS NOT NULL
       OR linkedin_seat_leases.lease_expires_at <= EXCLUDED.leased_at
    RETURNING TO_CHAR(lease_expires_at AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS lease_expires_at
  `
    )
    .get<{ lease_expires_at: string }>(
      options.workspaceId,
      options.seatKey,
      options.workerId,
      options.host,
      options.profileDir,
      now.toISOString(),
      expiresAt
    );

  if (!taken) {
    return {
      ok: false,
      reason: `is already being driven by worker '${current?.worker_id ?? 'another worker'}' until ${current?.lease_expires_at ?? 'its lease expires'}; this pass left it alone.`
    };
  }
  return { ok: true, expiresAt: taken.lease_expires_at };
}

/**
 * Push this worker's lease forward. False when it no longer holds it.
 *
 * `worker_id` is in the predicate on purpose: a worker whose lease was reaped
 * and re-granted elsewhere must NOT be able to extend it back into existence.
 */
export async function heartbeatSeatLease(
  db: Db,
  options: { workspaceId: string; seatKey: string; workerId: string; leaseMs?: number },
  now: Date = new Date()
): Promise<boolean> {
  const leaseMs = Math.max(60_000, Math.trunc(options.leaseMs ?? SEAT_LEASE_MS));
  const result = await db
    .prepare(
      `
    UPDATE linkedin_seat_leases SET lease_expires_at=?
    WHERE workspace_id=? AND seat_key=? AND worker_id=? AND released_at IS NULL
  `
    )
    .run(
      new Date(now.getTime() + leaseMs).toISOString(),
      options.workspaceId,
      options.seatKey,
      options.workerId
    );
  return result.changes > 0;
}

/**
 * Give the seat back, keeping the affinity.
 *
 * THE ROW IS NOT DELETED. `released_at` says "nobody is driving this right
 * now"; `host` and `profile_dir` go on saying "and this machine is where its
 * session lives", which is the fact another host has to respect tomorrow.
 * Deleting the row on release would throw that away every time a pass ended
 * cleanly -- which is to say, always.
 */
export async function releaseSeatLease(
  db: Db,
  options: { workspaceId: string; seatKey: string; workerId: string },
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_seat_leases SET released_at=?, lease_expires_at=?
    WHERE workspace_id=? AND seat_key=? AND worker_id=?
  `
    )
    .run(
      now.toISOString(),
      now.toISOString(),
      options.workspaceId,
      options.seatKey,
      options.workerId
    );
}

/**
 * Does this host actually hold a usable Chrome profile for the seat?
 *
 * An EMPTY directory is not a profile: `launchPersistentContext` creates the
 * path on first use, so "it exists" would be true on a host that had merely
 * tried once and failed. What makes it a session is content.
 */
/**
 * The value a lease's `profile_dir` takes when the seat's browser is remote.
 *
 * A MARKER, NOT A PATH, and it has to be recognisable as one: `claimSeatLease`
 * decides whether a seat is pinned to a host by asking whether its recorded
 * home is a directory on somebody's disk. The prefix cannot collide with a real
 * path, because an absolute path starts with `/` (or a drive letter) and
 * `resolveProfileDir` resolves every configured value to an absolute one.
 */
const REMOTE_SESSION_HOME_PREFIX = 'remote:';

export function remoteSessionHome(provider: string | null): string {
  return `${REMOTE_SESSION_HOME_PREFIX}${(provider ?? 'browser').replace(/\s+/g, '-')}`;
}

/** True when a recorded lease home is a remote browser rather than a directory. */
export function isRemoteSessionHome(profileDir: string): boolean {
  return profileDir.startsWith(REMOTE_SESSION_HOME_PREFIX);
}

/**
 * Where THIS process would keep the seat's session: a directory, or a provider.
 *
 * The one place the choice is made, so the lease, the refusal sentences and
 * the browser all agree about what this worker is.
 */
export function seatSessionHome(
  config: LinkedInLocalWorkerConfig,
  workspaceId: string,
  seatKey: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const provider = config.companionBrowser
    ? (companionBrowserSettings(env) ?? browserProviderSettings(env))
    : browserProviderSettings(env);
  return provider.kind === 'remote'
    ? remoteSessionHome(provider.remote?.label ?? null)
    : resolveProfileDir(config.profileDir, workspaceId, seatKey);
}
export function seatProfilePresent(profileDir: string): boolean {
  try {
    return statSync(profileDir).isDirectory() && readdirSync(profileDir).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The fleet, sliced: which seats and which workspaces are this worker's
// ---------------------------------------------------------------------------

/**
 * The seats in this worker's shard, for the periodic per-seat work.
 *
 * `linkedinSeatRefs` returns EVERY seat on the deployment, which is right for
 * the listing it is and wrong as the thing a worker iterates: the side-task
 * loop walked all of them, serially, on every tick -- 5,000 round trips before
 * a single browser opened, and every worker made the same 5,000. Sharded here
 * so each worker walks its own slice, and bounded so one tick cannot become
 * unbounded work.
 *
 * `after` is a cursor over (workspace_id, seat_key), so successive ticks cover
 * different seats instead of restarting at the same alphabetical head every
 * minute and never reaching the tail.
 */
export async function seatRefsForShard(
  db: Db,
  options: {
    shard?: WorkerShard;
    limit?: number;
    after?: { workspaceId: string; seatKey: string } | null;
  } = {}
): Promise<Array<{ workspaceId: string; seatKey: string }>> {
  const shard = options.shard ?? SINGLE_WORKER_SHARD;
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const after = options.after ?? null;
  const rows = await db
    .prepare(
      `
    SELECT workspace_id, seat_key FROM linkedin_seats
    WHERE (?::text IS NULL OR (workspace_id, seat_key) > (?::text, ?::text))
      AND ${shardPredicate("workspace_id || '/' || seat_key")}
    ORDER BY workspace_id ASC, seat_key ASC
    LIMIT ${limit}
  `
    )
    .all<{ workspace_id: string; seat_key: string }>(
      after?.workspaceId ?? null,
      after?.workspaceId ?? null,
      after?.seatKey ?? null,
      ...shardParams(shard)
    );
  return rows.map((row) => ({ workspaceId: row.workspace_id, seatKey: row.seat_key }));
}

/**
 * The workspaces in this worker's shard, for the once-per-workspace campaign
 * tick. Same cursor and the same reasoning as {@link seatRefsForShard}.
 *
 * Sharded on the WORKSPACE alone rather than on (workspace, seat): a campaign
 * tick is per workspace, and hashing it any other way would have two workers
 * both advancing one tenant's campaigns.
 */
export async function linkedinWorkspaceIdsForShard(
  db: Db,
  options: { shard?: WorkerShard; limit?: number; after?: string | null } = {}
): Promise<string[]> {
  const shard = options.shard ?? SINGLE_WORKER_SHARD;
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const after = options.after ?? null;
  const rows = await db
    .prepare(
      `
    SELECT DISTINCT workspace_id FROM linkedin_seats
    WHERE (?::text IS NULL OR workspace_id > ?::text)
      AND ${shardPredicate('workspace_id')}
    ORDER BY workspace_id ASC
    LIMIT ${limit}
  `
    )
    .all<{ workspace_id: string }>(after, after, ...shardParams(shard));
  return rows.map((row) => row.workspace_id);
}

// ---------------------------------------------------------------------------
// Is the queue actually being served? A question /health has to be able to ask
// ---------------------------------------------------------------------------

export interface LinkedInWorkerHealth {
  /** False once a discovery read has failed and not yet succeeded again. */
  discoveryHealthy: boolean;
  /** How many passes in a row could not read the queue. */
  consecutiveDiscoveryFailures: number;
  lastDiscoveryError: string | null;
  lastDiscoveryFailureAt: string | null;
  lastDiscoveryOkAt: string | null;
}

const discoveryState: LinkedInWorkerHealth = {
  discoveryHealthy: true,
  consecutiveDiscoveryFailures: 0,
  lastDiscoveryError: null,
  lastDiscoveryFailureAt: null,
  lastDiscoveryOkAt: null
};

/**
 * Record whether this pass could read the queue at all.
 *
 * THE FAILURE THAT LOOKED EXACTLY LIKE SUCCESS. A discovery error was caught,
 * logged at the same level as everything else, and turned into `[]` -- which is
 * byte-for-byte what "no seat has work due" returns. So the single most
 * consequential failure in this subsystem (nobody's queue is being served, on
 * any tenant) presented as its most ordinary state, and the only way to notice
 * was to read the log and know which line mattered. This is what makes it
 * answerable from outside the process.
 */
function recordDiscoveryOutcome(cause: unknown | null, now: Date): void {
  if (cause === null) {
    discoveryState.discoveryHealthy = true;
    discoveryState.consecutiveDiscoveryFailures = 0;
    discoveryState.lastDiscoveryError = null;
    discoveryState.lastDiscoveryOkAt = now.toISOString();
    return;
  }
  discoveryState.discoveryHealthy = false;
  discoveryState.consecutiveDiscoveryFailures += 1;
  discoveryState.lastDiscoveryError = cause instanceof Error ? cause.message : String(cause);
  discoveryState.lastDiscoveryFailureAt = now.toISOString();
}

/** What this process knows about whether the LinkedIn queue is moving. */
export function linkedInWorkerHealth(): LinkedInWorkerHealth {
  return { ...discoveryState };
}

// ---------------------------------------------------------------------------
// Playwright, loaded only if it is there
// ---------------------------------------------------------------------------

export interface LinkedInLocalWorkerConfig {
  enabled: boolean;
  /** Absent means the default below. */
  profileDir?: string | null;
  /**
   * True on a hosted deployment. Carried so refusals can distinguish a
   * deployment decision from a local off switch.
   */
  hosted?: boolean;
  /** A cloud browser provider is configured for this process. */
  remoteBrowser?: boolean;
  /** A paired member computer is the browser provider for this hosted process. */
  companionBrowser?: boolean;
  /**
   * May THIS PROCESS drive a seat with a browser nobody can see?
   *
   * ABSENT MEANS YES, which is every deployment that has not thought about it
   * and the behaviour this flag was added to leave alone.
   *
   * IT EXISTS BECAUSE "CAN" AND "SHOULD" CAME APART. The container in a normal
   * self-hosted stack has no display, and the design assumed that meant no
   * browser either -- `runDueLinkedInActions` and `runLinkedInSideTasks` both
   * lean on "a worker in a container returns immediately and claims no work
   * away from the operator's own `npm run linkedin:worker`". That stopped
   * being true the moment Chromium was installed in the image for other
   * features: the container could launch headless, so it did, and it served
   * the seat from a GPU-less container -- WebGL reporting SwiftShader, from a
   * container IP -- while the operator's headed worker sat idle.
   *
   * NOT `enabled: false`, which is the switch that was already there and is
   * too blunt: it turns the FEATURE off, so the API stops parking detect
   * requests for the machine that CAN do the work and answers "LinkedIn
   * automation is switched off" instead. This says something narrower and
   * true: this process may not be the one that opens the browser. Everything
   * else -- the queue, the ledger, the routes, the 202 that hands the job to
   * the host worker -- carries on.
   */
  headless?: boolean;
}

/**
 * One paired computer, one active LinkedIn account at a time. Each seat still
 * has its own browser profile/session; this only serializes their active use so
 * the laptop does not drive several accounts simultaneously from one machine.
 */
export function seatConcurrencyForConfig(
  config: LinkedInLocalWorkerConfig,
  headless: boolean,
  env: NodeJS.ProcessEnv = process.env
): number {
  return config.companionBrowser ? 1 : defaultSeatConcurrency(headless, env);
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

/**
 * Where an X server puts the socket for a local display. Fixed by X itself --
 * `:N` is served at `X{N}` in this directory on every Linux -- and overridable
 * only so a test can point at a directory it owns.
 */
const X11_SOCKET_DIR = '/tmp/.X11-unix';

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
  if (platform === 'win32')
    return join(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'ms-playwright');
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
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; xSocketDir?: string } = {}
): LinkedInBrowserReadiness {
  if (!config.enabled) return { canLaunchHeaded: false, reasons: [linkedInOffReason(config)] };

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (config.companionBrowser) {
    return {
      canLaunchHeaded: false,
      reasons: [
        'This hosted process drives the visible Chrome window on the paired member computer, not a window on the server.'
      ]
    };
  }

  // A REMOTE BROWSER IS NEVER HEADED, AND THAT IS NOT A BLOCKER -- it is what
  // a cloud browser is. Nobody is at the other end to watch a window, clear a
  // captcha or close it, so the honest answer to "can this process open a
  // browser the operator can see" is no, with the reason said plainly rather
  // than reported as a missing display. The headless probe is the one that
  // matters in this mode.
  const remote = browserProviderSettings(env);
  if (remote.kind === 'remote') {
    return {
      canLaunchHeaded: false,
      reasons: [
        `This deployment drives a remote browser at ${remote.remote?.label ?? 'the configured provider'}, so there is no window on this machine for anyone to watch.`
      ]
    };
  }

  const blockers = browserBlockers(env, platform);

  // THE DECISIVE SIGNAL ON LINUX. A headed browser needs somewhere to draw,
  // and neither X11 nor Wayland is reachable without one of these. macOS and
  // Windows have no equivalent variable and always have a window server.
  if (platform === 'linux') {
    const wayland = env.WAYLAND_DISPLAY?.trim();
    const display = env.DISPLAY?.trim();
    if (!wayland && !display) {
      blockers.push(
        'No display is attached to this process, so a browser window cannot open here.'
      );
    } else if (!wayland && display) {
      // SET IS NOT SERVED. `DISPLAY=:99` is an address, not a promise that
      // anything is listening at it, and the two came apart in this project's
      // own dev container: `docker restart` keeps /tmp, the stale
      // `/tmp/.X99-lock` made the new Xvfb exit at once, and DISPLAY stayed
      // set by the image. This probe said yes, the route dispatched the work,
      // and Playwright died with "you launched a headed browser without having
      // a XServer running" -- reported to the operator as "check that Chromium
      // is installed", the one thing that was fine.
      //
      // A local display's socket is at a known path and a `stat` is as cheap
      // as reading the variable, so the honest answer costs nothing. Only
      // LOCAL displays are checked: `host:0` reaches an X server over TCP and
      // has no socket here to look for. Wayland is exempted rather than
      // half-checked -- its socket lives in a runtime directory this process
      // may not be allowed to stat, and a false blocker is worse than none.
      const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
      if (local && !existsSync(join(options.xSocketDir ?? X11_SOCKET_DIR, `X${local[1]}`))) {
        blockers.push(
          `DISPLAY is ${display} but no X server is serving it, so a browser window cannot open here.`
        );
      }
    }
  }

  if (blockers.length === 0) return { canLaunchHeaded: true, reasons: [] };
  return {
    canLaunchHeaded: false,
    reasons: inContainer()
      ? [
          'This process runs in a container, which has no display and no browser of its own.',
          ...blockers
        ]
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
    blockers.push(
      'Playwright is not installed here; run `npm i playwright && npx playwright install chromium`.'
    );
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
  if (config.headless === false) {
    return {
      canLaunchHeadless: false,
      reasons: [
        'This process is configured not to drive LinkedIn with a browser nobody can see (TREVRA_LINKEDIN_HEADLESS=false), so the work waits for a machine with a display.'
      ]
    };
  }
  const env = options.env ?? process.env;

  if (config.companionBrowser) {
    return driverResolvable()
      ? { canLaunchHeadless: true, reasons: [] }
      : {
          canLaunchHeadless: false,
          reasons: [
            'No browser driver is installed on this hosted worker, so it cannot attach to the paired computer.'
          ]
        };
  }

  // REMOTE NEEDS THE CLIENT, NOT THE BROWSER. `npx playwright install chromium`
  // downloads a ~400MB binary this process would never launch: the browser it
  // drives is somebody else's, already running, and all this image needs is the
  // library that can speak CDP to it. Asking for a local Chromium here is what
  // would keep a correctly configured hosted deployment permanently "not
  // ready", which is precisely the silent dead queue this capability exists to
  // end.
  const remote = browserProviderSettings(env);
  if (remote.kind === 'remote') {
    return driverResolvable()
      ? { canLaunchHeadless: true, reasons: [] }
      : {
          canLaunchHeadless: false,
          reasons: [
            'No browser driver is installed here, so this process cannot attach to a remote browser; run `npm i patchright` (or playwright) in the image that runs the worker.'
          ]
        };
  }
  if (remote.problem) return { canLaunchHeadless: false, reasons: [remote.problem] };

  const blockers = browserBlockers(env, options.platform ?? process.platform);
  return blockers.length === 0
    ? { canLaunchHeadless: true, reasons: [] }
    : { canLaunchHeadless: false, reasons: blockers };
}

/** Is the driver LIBRARY here? The only local requirement a remote browser has. */
function driverResolvable(): boolean {
  for (const specifier of DRIVER_SPECIFIERS) {
    try {
      localWorkerRequire.resolve(specifier);
      return true;
    } catch {
      // Try the next one; both are optional and either will do.
    }
  }
  return false;
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
  /**
   * The cookies-and-origins bundle, for the contexts that have no disk.
   *
   * OPTIONAL BECAUSE A PERSISTENT CONTEXT DOES NOT NEED IT and because every
   * test fake in this repository is a hand-written object. Its absence degrades
   * the remote path to "this run's session could not be saved", which is
   * logged; it never fails a run.
   */
  storageState?(options?: Record<string, unknown>): Promise<BrowserStorageState>;
}

/**
 * The driver, as this file uses it.
 *
 * `connectOverCDP` and `connect` are OPTIONAL rather than required: a driver
 * too old to have them, or a test fake that implements only a launch, must
 * produce a refusal with a sentence in it rather than a TypeError three frames
 * inside a provider. `browser/provider.ts` is what checks.
 */
export interface PlaywrightLike {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options?: Record<string, unknown>
    ): Promise<LinkedInBrowserContext>;
    connectOverCDP?(
      endpointURL: string,
      options?: Record<string, unknown>
    ): Promise<{
      newContext(options?: Record<string, unknown>): Promise<LinkedInBrowserContext>;
      contexts?(): LinkedInBrowserContext[];
      close(): Promise<void>;
    }>;
    connect?(
      wsEndpoint: string,
      options?: Record<string, unknown>
    ): Promise<{
      newContext(options?: Record<string, unknown>): Promise<LinkedInBrowserContext>;
      contexts?(): LinkedInBrowserContext[];
      close(): Promise<void>;
    }>;
  };
}

interface BrowserHandle {
  page: LinkedInPage;
  /** Which mode this handle was opened in, so a reuse cannot silently be the wrong one. */
  headless: boolean;
  /**
   * `Date.now()` at the last open or reuse. What makes the idle sweep possible
   * at all -- a handle nobody can date is a handle nobody can retire.
   */
  lastUsedAt: number;
  /**
   * A monotonic use counter, and NOT the timestamp above, because eviction
   * order has to be a total order. Several seats opened inside one millisecond
   * share a `lastUsedAt`, and "least recently used" then degenerates into
   * whatever the map's insertion order happens to be -- which is the opposite
   * of the intent, since the seat opened first is usually the one being reused
   * most.
   */
  usedSeq: number;
  /**
   * Where this browser actually is.
   *
   * 'local' is this machine's own Chromium at a persistent profile directory --
   * everything this file did before hosted execution existed. 'remote' is a
   * cloud browser attached to over CDP, which has no profile directory, which
   * is why the field exists at all: it decides whether the seat's signed-in
   * state has to be written back to the database when the run ends.
   */
  provider: 'local' | 'remote';
  /**
   * Read the signed-in state back out. Null for a local handle, ALWAYS.
   *
   * The persistent profile directory IS the local session, so writing a copy of
   * it into Postgres would give the one fact that must not have two sources of
   * truth exactly two.
   */
  exportStorageState: null | (() => Promise<BrowserStorageState | null>);
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
 *
 * BOUNDED, WHICH IT WAS NOT. Nothing on any success path ever removed an entry,
 * so this map retained one LIVE Chromium for every seat this process had ever
 * touched -- at ~350-500MB each, a 16GB host fell over somewhere between 25 and
 * 40 seats, and on a hosted worker serving hundreds of seats that is not an
 * edge case, it is Tuesday. Two mechanisms bound it now and they answer two
 * different questions: {@link closeIdleBrowsers} retires contexts nobody is
 * using, and {@link evictSurplusBrowsers} retires the least recently used one
 * when every context IS being used and there are simply too many.
 *
 * Insertion order is LRU order: `browsers.set` on a fresh open appends, and a
 * reuse updates `lastUsedAt` in place, so eviction sorts on the timestamp
 * rather than trusting the Map's order.
 */
const browsers = new Map<string, BrowserHandle>();
let browserUseSeq = 0;

/** How many Chromium contexts this worker may hold open at once. */
const DEFAULT_MAX_OPEN_BROWSERS = 4;
/** How long a context may sit unused before the next pass closes it. */
const DEFAULT_BROWSER_IDLE_MS = 10 * 60_000;

function maxOpenBrowsers(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.TREVRA_LINKEDIN_MAX_BROWSERS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_OPEN_BROWSERS;
}

function browserIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.TREVRA_LINKEDIN_BROWSER_IDLE_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BROWSER_IDLE_MS;
}

/**
 * Close least-recently-used contexts until there is room for one more.
 *
 * `keep` is the handle about to be inserted, excluded so a cap of 1 still
 * works. Closing rather than merely forgetting: a forgotten context is a live
 * Chromium nothing can ever close, holding its profile directory's exclusive
 * lock, which strands that seat for every worker on this host.
 */
async function evictSurplusBrowsers(keep: string): Promise<void> {
  const cap = maxOpenBrowsers();
  const victims = [...browsers.entries()]
    .filter(([key]) => key !== keep)
    .sort((left, right) => left[1].usedSeq - right[1].usedSeq)
    .slice(0, Math.max(0, browsers.size + (browsers.has(keep) ? 0 : 1) - cap));
  for (const [key] of victims) browsers.delete(key);
  await Promise.all(
    victims.map(async ([, handle]) => {
      try {
        await handle.close();
      } catch {
        // Same as everywhere else: a context we cannot close must not take the
        // pass down with it.
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Log suppression that is per tenant, not per process
// ---------------------------------------------------------------------------

/**
 * How long one key stays quiet after it has spoken, and how many keys are kept.
 *
 * A WINDOW RATHER THAN A BOOLEAN, and per key rather than per process. The
 * three flags this replaces (`missingPlaywrightLogged`, `unreadyLogged`,
 * `loadedDriverLogged`) were module-level and permanent, which is right for one
 * operator on one laptop and wrong in exactly the way that matters on a fleet:
 * the FIRST tenant to hit a condition printed the line, and every other
 * tenant's identical condition -- a different account, a different queue, a
 * different person waiting for it -- was silent for the life of the process.
 * An hour is long enough that a per-minute tick does not flood the log and
 * short enough that a condition still present tomorrow says so again.
 *
 * The map is capped because its keys are tenant-derived and a hosted worker
 * sees thousands of them: an unbounded suppression table is a memory leak
 * wearing a log-hygiene costume. Oldest entries go first.
 */
const LOG_SUPPRESSION_MS = 60 * 60_000;
const MAX_LOG_KEYS = 2_000;
const loggedRecently = new Map<string, number>();

export function shouldLogOnce(
  key: string,
  now: Date,
  windowMs: number = LOG_SUPPRESSION_MS
): boolean {
  const at = now.getTime();
  const last = loggedRecently.get(key);
  if (last !== undefined && at - last < windowMs) return false;
  if (loggedRecently.size >= MAX_LOG_KEYS) {
    for (const oldest of [...loggedRecently.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, MAX_LOG_KEYS / 4)) {
      loggedRecently.delete(oldest[0]);
    }
  }
  loggedRecently.set(key, at);
  return true;
}

/**
 * The same log, with the tenant and the seat in front of every line.
 *
 * WHOSE RUN FAILED IS A QUESTION A HOSTED OPERATOR HAS TO BE ABLE TO ANSWER.
 * "LinkedIn local worker could not open a browser" is a complete sentence when
 * there is one account on one laptop and an unanswerable one across thousands
 * of workspaces, which is what every line in this pass used to be.
 */
function seatLogger(
  log: (message: string) => void,
  workspaceId: string,
  seatKey: string
): (message: string) => void {
  return (message: string) => log(`LinkedIn seat ${workspaceId}/${seatKey}: ${message}`);
}

/** A seat-scoped line said at most once per suppression window. */
function logOncePerSeat(
  say: (message: string) => void,
  reasonKey: string,
  workspaceId: string,
  seatKey: string,
  message: string,
  now: Date
): void {
  if (!shouldLogOnce(`${workspaceId}/${seatKey}:${reasonKey}`, now)) return;
  say(message);
}

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
  if (!seatTimezone)
    return { userAgent, locale: derived.locale, timezoneId: derived.timezoneId, viewport };
  const paired = SEAT_BROWSER_PROFILES.find((profile) => profile.timezoneId === seatTimezone);
  return {
    userAgent,
    locale: paired?.locale ?? derived.locale,
    timezoneId: seatTimezone,
    viewport
  };
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
  context: ProviderBrowserContext,
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
      // NO q-VALUES HERE. Chromium appends its own `;q=` weights to whatever
      // this string ends with, so writing them out produced the malformed
      // `de-CH,de;q=0.9;q=0.9` on the wire -- a header no browser emits and a
      // free anomaly. The bare list is what a real de-CH Chrome starts from.
      acceptLanguage: `${language},${language.split('-')[0]}`,
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
    // SCROLLBARS BACK ON, AND THIS IS NOT WHAT `ignoreDefaultArgs` DID.
    //
    // Dropping `--hide-scrollbars` from the command line was not enough: the
    // driver hides them over CDP as well, and a probe of the launched browser
    // still had `innerWidth === documentElement.clientWidth`, which is the
    // one-line check for it. Only this call actually gives the page the ~15px
    // gutter every desktop Chrome has.
    await cdp.send('Emulation.setScrollbarsHidden', { hidden: false });
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
const PROXY_MAP_ENV = 'TREVRA_LINKEDIN_PROXIES';

/** Whatever an id or a seat key is, this is what it may contribute to an env var name. */
function envSafe(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

/**
 * True when {@link envSafe} loses nothing about this value.
 *
 * The composed variable names below join their parts with `_`, and `_` is a
 * legal character in both a workspace id and a seat key -- so a name built
 * from a value containing one cannot be parsed back into the pair it came
 * from. Alphanumerics survive; everything else does not.
 */
function envSegmentIsLossless(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value.trim());
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
 * WHERE IT IS CONFIGURED, IN PRECEDENCE ORDER. The account's own setting
 * (`linkedin_seats.proxy_url`, migration 062) wins whenever it has one -- it is
 * a fact about that LinkedIn account, it is editable by the operator who owns
 * the account rather than by whoever can restart the process, and it is what a
 * deployment with more than one seat actually needs. The environment below is
 * unchanged and stays as the fallback for every seat without one, so a
 * deployment that has always configured proxies that way keeps working exactly
 * as it did.
 *
 * TWO WAYS TO CONFIGURE ONE IN THE ENVIRONMENT, AND THE FIRST IS THE ONE THAT SCALES:
 *
 *   TREVRA_LINKEDIN_PROXIES  a JSON object, keyed by the EXACT pair:
 *                              {"ws_a/sales": "http://user:pw@host:port",
 *                               "*\/sales":    "...",   // that seat key anywhere
 *                               "ws_a/*":     "...",   // every seat of one tenant
 *                               "*":          "..."}   // every seat here
 *   TREVRA_LINKEDIN_PROXY_<SEAT>  that seat key, in any workspace
 *   TREVRA_LINKEDIN_PROXY         every seat on this machine
 *
 * THE TWO-PART ENV VAR IS GONE, AND THIS IS WHY. `TREVRA_LINKEDIN_PROXY_<WS>_<SEAT>`
 * was built by flattening both ids to `[A-Z0-9_]` and joining them with `_` --
 * which is also a legal character inside both. So workspace `ws` + seat
 * `a_sales` and workspace `ws_a` + seat `sales` resolved to the SAME variable
 * name, and two unrelated tenants silently shared one exit IP: the single
 * outcome the whole fail-closed discipline below exists to prevent, arrived at
 * by a naming accident rather than by a misconfiguration anybody could see.
 * A name that cannot be parsed back into the pair it was built from cannot be
 * trusted, so an ambiguous one is REFUSED rather than guessed at, and the
 * refusal names the exact JSON key to use instead. The JSON map has no
 * separator to be ambiguous about: its keys are compared as whole strings.
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
  seatKey: string,
  /**
   * `linkedin_seats.proxy_url` for this seat, as stored. Null or absent means
   * the account has none and the environment decides.
   *
   * PARSED THROUGH THE SAME `parseProxyUrl` AS EVERY OTHER SOURCE, so a value
   * the launcher could not use is a throw here rather than a null -- the write
   * path calls this function to validate before storing, and both ends of that
   * therefore agree by construction rather than by two copies of the rules.
   */
  stored?: string | null
): SeatProxy | null {
  const configured = stored?.trim();
  if (configured) return parseProxyUrl("This account's own proxy setting", configured);

  const mapped = proxyFromMap(env, workspaceId, seatKey);
  if (mapped) return parseProxyUrl(mapped.source, mapped.raw);

  // A composed name is usable only when every id it was built from survives
  // the flattening unchanged. `sales` does; `a_sales` does not, because the
  // `_` it contributes is indistinguishable from the separator.
  const seatIsUnambiguous = envSegmentIsLossless(seatKey);
  const workspaceIsUnambiguous = envSegmentIsLossless(workspaceId);

  const pairName = `${PROXY_ENV_PREFIX}_${envSafe(workspaceId)}_${envSafe(seatKey)}`;
  const seatName = `${PROXY_ENV_PREFIX}_${envSafe(seatKey)}`;

  // SET BUT UNUSABLE IS AN ERROR, NOT A MISS. Ignoring it would fall through
  // to a broader key or to null, and null means "connect directly" -- from the
  // very machine this seat was configured not to be seen from.
  if (env[pairName]?.trim() && !(workspaceIsUnambiguous && seatIsUnambiguous)) {
    throw new Error(
      `${pairName} cannot be matched to exactly one workspace and seat, because '${workspaceId}' or '${seatKey}' contains a character that flattens into the same '_' the name uses as its separator -- another tenant's pair can produce this very name. Set TREVRA_LINKEDIN_PROXIES instead, with the exact key "${workspaceId}/${seatKey}".`
    );
  }
  if (env[seatName]?.trim() && !seatIsUnambiguous) {
    throw new Error(
      `${seatName} cannot be matched to exactly one seat key, because '${seatKey}' contains a character that flattens into the same '_' the name uses as its separator. Set TREVRA_LINKEDIN_PROXIES instead, with the exact key "*/${seatKey}".`
    );
  }

  const candidates = [
    ...(workspaceIsUnambiguous && seatIsUnambiguous ? [pairName] : []),
    ...(seatIsUnambiguous ? [seatName] : []),
    PROXY_ENV_PREFIX
  ];
  const name = candidates.find((candidate) => env[candidate]?.trim());
  if (!name) return null;
  return parseProxyUrl(name, env[name]!.trim());
}

/**
 * The JSON map, or null when it names nothing for this seat.
 *
 * MOST SPECIFIC WINS, and every key is compared whole: there is no separator
 * to mis-parse, so `{"ws/a_sales": ...}` and `{"ws_a/sales": ...}` are two
 * different entries that can hold two different proxies, which is exactly what
 * the env-var form could not express.
 *
 * A map that will not parse THROWS. A typo in the JSON must not degrade to "no
 * proxy configured", for the same reason a malformed URL must not.
 */
function proxyFromMap(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  seatKey: string
): { source: string; raw: string } | null {
  const raw = env[PROXY_MAP_ENV]?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The VALUE is never quoted back: this object is full of passwords.
    throw new Error(
      `${PROXY_MAP_ENV} is not valid JSON. It is an object keyed by "<workspace>/<seat>", with "*" allowed on either side.`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${PROXY_MAP_ENV} must be a JSON object keyed by "<workspace>/<seat>", with "*" allowed on either side.`
    );
  }
  const table = parsed as Record<string, unknown>;
  for (const key of [`${workspaceId}/${seatKey}`, `*/${seatKey}`, `${workspaceId}/*`, '*']) {
    const value = table[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `${PROXY_MAP_ENV} entry "${key}" is not a proxy URL. Use http://user:pass@host:port, https://... or socks5://host:port.`
      );
    }
    return { source: `${PROXY_MAP_ENV} entry "${key}"`, raw: value.trim() };
  }
  return null;
}

/** One proxy URL, validated the same way whichever configuration named it. */
function parseProxyUrl(source: string, raw: string): SeatProxy {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The VALUE is never quoted back: a proxy URL routinely carries a password.
    throw new Error(
      `${source} is not a URL. Use http://user:pass@host:port, https://... or socks5://host:port.`
    );
  }
  const scheme = url.protocol.replace(':', '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(
      `${source} uses an unsupported proxy scheme '${scheme}'. Chromium accepts http, https and socks5.`
    );
  }
  if (!url.hostname) throw new Error(`${source} names no proxy host.`);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (scheme === 'socks5' && (username || password)) {
    // Chromium cannot authenticate a SOCKS proxy. Accepting it would mean
    // launching with credentials that are silently dropped, which is a direct
    // connection wearing a proxy's clothes.
    throw new Error(
      `${source} is a SOCKS proxy with credentials, which Chromium cannot authenticate. Use an http proxy, or a SOCKS proxy that authorises this machine by IP.`
    );
  }
  return {
    server: `${scheme}://${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  };
}

/**
 * The one actionable line, logged once PER SCOPE (plan 4.4).
 *
 * Not once per process, which is what it was. `missingPlaywrightLogged` was a
 * module-level boolean, so the first seat that could not find a browser driver
 * printed the install instruction and every seat after it -- in every other
 * workspace, for the life of the worker -- printed nothing at all. On one
 * laptop that is the correct behaviour (a repeated per-minute line is a line
 * nobody reads). Across thousands of tenants it means the ONE symptom a
 * tenant's dead queue has is suppressed by an unrelated tenant's failure, and
 * the operator has no way to tell whose run failed. Keyed and time-boxed
 * instead: see {@link shouldLogOnce}.
 */
function reportMissingPlaywright(
  log: (message: string) => void,
  cause: unknown,
  scope = 'process'
): void {
  if (!shouldLogOnce(`playwright-missing:${scope}`, new Date())) return;
  log(
    `LinkedIn local worker is enabled but stays off: no browser driver installed; run npm i patchright && npx patchright install chromium (${cause instanceof Error ? cause.message : String(cause)})`
  );
}

/**
 * Say, once per distinct set of reasons per scope, that this process cannot
 * drive a browser. Same discipline as {@link reportMissingPlaywright}, and it
 * used to have the same defect: a single module-level string, so one scope's
 * message silenced every other scope's identical one forever.
 */
function reportUnready(
  log: (message: string) => void,
  readiness: LinkedInBrowserReadiness,
  scope = 'process'
): void {
  const summary = readiness.reasons.join(' ');
  if (!shouldLogOnce(`unready:${scope}:${summary}`, new Date())) return;
  log(`LinkedIn local worker stays off here: ${summary}`);
}

/**
 * PATCHRIGHT FIRST, STOCK PLAYWRIGHT SECOND.
 *
 * They are the same API -- Patchright is Playwright with the automation tells
 * patched out at the driver level -- so this is a swap of the import and
 * nothing else. What it buys is the one class of signal no launch option can
 * reach:
 *
 *   - Playwright calls `Runtime.enable` to get an execution-context id. That
 *     makes Chromium emit `Runtime.consoleAPICalled`, and because V8 only
 *     formats `Error.stack` on first access, a page detects an attached CDP
 *     client in five lines. It is the technique DataDome published and says
 *     every major anti-bot vendor now runs. Patchright uses isolated worlds
 *     instead and never enables the domain.
 *   - Stock Playwright injects `window.__pwInitScripts` and
 *     `window.__playwright__binding__` into every page. Patchright does not.
 *   - It also drops `--enable-automation` and friends from the default args,
 *     which is belt and braces with the `ignoreDefaultArgs` in `openBrowser`.
 *
 * THE FALLBACK IS DELIBERATE AND IS NOT A SILENT DOWNGRADE. Patchright pins its
 * own Chromium revision; an install that has playwright's browsers but not
 * Patchright's should keep working, because a seat that cannot open a browser
 * at all is worse than one that opens a more detectable browser. Which one was
 * loaded is logged once, so "why is this account getting challenged" has an
 * answer that does not require reading this file.
 *
 * The specifiers are typed as `string` rather than written as literals so that
 * neither `tsc` nor the Vite marketing build tries to resolve a package that is
 * deliberately optional. A HARD dependency would add ~400MB to the Oracle image
 * and break the Cloudflare build (plan 4.4) -- for a feature that is off on
 * every deployment except a self-hoster who asked for it.
 *
 * ABSENCE IS NEVER FATAL. This returns null; it does not throw. A worker
 * process that crashed because an optional browser was missing would take the
 * automation cycle, the playbook engine and the schedule sweep down with it.
 */
const DRIVER_SPECIFIERS: readonly string[] = ['patchright', 'playwright'];
/**
 * Which driver was loaded, said once per SCOPE rather than once per process.
 *
 * See {@link shouldLogOnce}: on a fleet, "once ever" means the first tenant to
 * hit a problem silences that problem's only symptom for every other tenant
 * for the life of the process.
 */
const loadedDriverLogged = new Set<string>();
/** Once per process: see where it is set. */
let swiftShaderWarned = false;

export async function loadLinkedInPlaywright(
  log: (message: string) => void = () => {},
  scope = 'process'
): Promise<PlaywrightLike | null> {
  let last: unknown;
  for (const specifier of DRIVER_SPECIFIERS) {
    try {
      const driver = (await import(specifier)) as PlaywrightLike;
      // WHICH driver is a fact about the process, not about a seat, so this
      // one really is once -- but it is keyed all the same, so a caller that
      // wants it per seat gets it per seat.
      if (!loadedDriverLogged.has(scope)) {
        if (loadedDriverLogged.size > MAX_LOG_KEYS) loadedDriverLogged.clear();
        loadedDriverLogged.add(scope);
        log(
          specifier === 'patchright'
            ? 'LinkedIn seats are driven by patchright (the patched Playwright: no Runtime.enable, no __pwInitScripts).'
            : 'LinkedIn seats are driven by stock playwright: patchright is not installed, so this browser answers an attached-CDP probe. Run npm i patchright && npx patchright install chromium.'
        );
      }
      return driver;
    } catch (cause) {
      last = cause;
    }
  }
  reportMissingPlaywright(log, last, scope);
  return null;
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
/**
 * Which browser to be, in order of preference.
 *
 * `'chrome'` IS GOOGLE CHROME -- the binary a member actually browses with,
 * with Widevine, the proprietary codecs, and `window.chrome.runtime` defined.
 * `'chromium'` is the open-source build: everything above is missing, and a
 * `window.chrome` object with no `runtime` on it is a documented, one-line
 * headless-Chromium check. Preferring Chrome costs nothing when it is
 * installed and falls back silently when it is not, which is what makes this
 * safe to ship ahead of the image change that installs it
 * (`npx playwright install chrome`, added to `Dockerfile.dev`).
 *
 * NEVER the default (no channel at all): that is how a headless launch
 * silently became `chrome-headless-shell`, which is the bug the comment inside
 * `openBrowser` describes at length.
 */
const BROWSER_CHANNELS: readonly string[] = ['chrome', 'chromium'];
let launchChannelLogged = false;

/**
 * Launch on the best channel this machine actually has.
 *
 * A missing channel throws at launch -- there is no way to ask Playwright
 * whether Google Chrome is installed without trying it -- so the fallback IS
 * the probe. The last channel's failure is rethrown unchanged, so a genuinely
 * broken install still reports its own error to `openBrowser`'s catch rather
 * than a summary of it.
 */
/**
 * THE COMMAND-LINE FLAGS A SEAT'S BROWSER IS LAUNCHED WITH, in ONE array.
 *
 * It was two, and that is the bug this function exists to make impossible: the
 * options object held `...(inContainer() ? { args: [ANGLE flags] } : {})` and,
 * eleven lines later, a literal `args: [...]`. The second key wins in an object
 * literal, so the ANGLE flags were silently discarded -- the measured fix for
 * "WebGL returns null in this container" was never actually passed to a single
 * browser. A duplicate key is not a merge, and nothing warned.
 *
 * `--no-sandbox` NOW APPLIES IN A CONTAINER WHATEVER THE MODE. It was
 * `headless && inContainer()`, which is the same container and the same root
 * user in either mode; making the flag depend on the mode is how "it works
 * headless and dies headed" happens.
 */
export function seatLaunchArgs(inside: boolean): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    // See the ANGLE note on the launch options: without these, WebGL in this
    // container returns null, which is rarer than a software renderer.
    ...(inside
      ? ['--use-gl=angle', '--use-angle=gl-egl', '--no-sandbox', '--disable-dev-shm-usage']
      : [])
  ];
}

// `releaseStaleProfileLock` is imported from `browser/local.ts`: a dead
// Chromium's lock is not a LinkedIn fact, and the Reddit worker opens
// persistent profiles the same way and was stranded the same way.

async function launchSeatBrowser(
  playwright: PlaywrightLike,
  profileDir: string,
  optionsFor: (channel: string) => Record<string, unknown>,
  log: (message: string) => void
): Promise<LinkedInBrowserContext> {
  // A LOCK LEFT BY A DEAD PROCESS IS NOT A LOCK. See the function.
  releaseStaleProfileLock(profileDir, log);
  let last: unknown;
  for (let index = 0; index < BROWSER_CHANNELS.length; index += 1) {
    const channel = BROWSER_CHANNELS[index] as string;
    try {
      const context = await playwright.chromium.launchPersistentContext(
        profileDir,
        optionsFor(channel)
      );
      if (!launchChannelLogged) {
        launchChannelLogged = true;
        log(
          channel === 'chrome'
            ? 'LinkedIn seat browser is Google Chrome, the same binary a member browses with.'
            : `LinkedIn seat browser is Chromium; Google Chrome is not installed here, so \`window.chrome.runtime\` is undefined where a real Chrome defines it. \`npx playwright install chrome\` closes that gap.`
        );
      }
      return context;
    } catch (cause) {
      last = cause;
    }
  }
  throw last;
}

/** Where a real session starts. Never a target, never a search. */
const FEED_URL = 'https://www.linkedin.com/feed/';

/**
 * The pages a person opens for no campaign reason at all.
 *
 * AN ACCOUNT THAT ONLY EVER DOES OUTREACH IS A ROBOT WITH A JOB. Every real
 * member checks who viewed them, clears a notification, looks at My Network.
 * None of it sends anything, none of it is paced (nothing here consumes a
 * ceiling -- these are reads of the member's OWN surfaces, not of other
 * people's profiles), and it is the cheapest possible way for a sitting to
 * contain something other than the thing that gets accounts flagged.
 */
const NOISE_URLS: readonly string[] = [
  'https://www.linkedin.com/mynetwork/',
  'https://www.linkedin.com/notifications/',
  'https://www.linkedin.com/feed/'
];

/**
 * Land on the feed and read it before the caller navigates anywhere.
 *
 * DECORATION, NEVER CORRECTNESS. A page object that cannot navigate (every
 * test fake), a feed that redirects to the sign-in page (a signed-out profile
 * -- which is exactly what a person opening LinkedIn would see), a navigation
 * that times out: all of them land here and are dropped. The caller's own
 * first `goto` is the one that matters and it happens either way.
 */
export async function warmUpSession(
  page: unknown,
  seed: string,
  log: (message: string) => void
): Promise<void> {
  const target = page as {
    goto?: (
      url: string,
      options?: { waitUntil?: 'domcontentloaded'; timeout?: number }
    ) => Promise<unknown>;
    waitForTimeout?: (ms: number) => Promise<void>;
  };
  if (typeof target.goto !== 'function' || typeof target.waitForTimeout !== 'function') return;
  try {
    await target.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settle(target as HumanPage, `${seed}#feed`);
    await readPage(target as HumanPage, `${seed}#feed-read`);
    // AND SOMETIMES SOMETHING ELSE FIRST. Seeded, so a sitting is still
    // reproducible; about half of them stop at the feed, the rest wander
    // through one of their own pages the way a person does before getting to
    // whatever they opened LinkedIn for.
    const random = seededRandom(createHash('sha256').update(`${seed}#noise`).digest('hex'));
    if (random() < 0.55) {
      const noise = NOISE_URLS[Math.floor(random() * NOISE_URLS.length)] ?? FEED_URL;
      await target.goto(noise, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(target as HumanPage, `${seed}#noise`);
      await readPage(target as HumanPage, `${seed}#noise-read`);
    }
  } catch (cause) {
    log(
      `LinkedIn seat browser could not open the feed before its first action (${cause instanceof Error ? cause.message : String(cause)}). The action itself is unaffected.`
    );
  }
}

/**
 * The remote half of {@link openBrowser}: a cloud browser, one context per
 * seat, with that seat's session restored into it.
 *
 * THREE THINGS THIS DOES THAT THE LOCAL PATH GETS FOR FREE FROM A DIRECTORY:
 *
 *   1. RESTORES THE SESSION. There is no user-data-dir out there, so the
 *      seat's cookies come from `linkedin_seat_sessions` (sealed, migration
 *      065) and go into `newContext({ storageState })` before the first
 *      request leaves the browser. Without this, every run is a brand-new
 *      device sign-in -- the loudest challenge signal LinkedIn has, and the
 *      exact thing the local worker's host pin exists to avoid.
 *   2. REFUSES WITHOUT A PROXY. `openSeatBrowser` will not attach a seat that
 *      has no proxy, because a cloud browser's shared datacentre address is
 *      the fastest way to get a LinkedIn account restricted, and "we could not
 *      honour the proxy" must never resolve to "connect from there anyway".
 *      The seat's work simply stays due.
 *   3. DEGRADES TO "NEEDS RE-LOGIN", NEVER TO AN UNAUTHENTICATED RUN. A stored
 *      state that will not open, has expired, or carries no sign-in cookie is
 *      reported and dropped, and the seat then signs itself in with the stored
 *      credential exactly as a first run does.
 *
 * NEVER THROWS, same contract as its caller: every failure is a logged
 * sentence and a null, because both callers are loops.
 */
async function openRemoteSeatHandle(input: {
  settings: ReturnType<typeof browserProviderSettings>;
  playwright: PlaywrightLike;
  db: Db | null;
  workspaceId: string;
  seatKey: string;
  handleKey: string;
  headless: boolean;
  profileDir: string;
  fingerprint: SeatContextFingerprint;
  proxy: SeatProxy | null;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}): Promise<BrowserHandle | null> {
  // THE SESSION IS READ BEFORE THE BROWSER IS OPENED, so a seat whose stored
  // state has expired pays a column read rather than a remote attach.
  let storageState: BrowserStorageState | null = null;
  // A paired computer's persistent Chrome profile IS the session. Do not read
  // or write a second copy of its cookies in Trevra merely because the worker
  // reaches that browser over CDP.
  if (input.settings.remote?.sessionPersistence !== 'browser' && input.db) {
    const stored = await readSeatStorageState(input.db, input.workspaceId, input.seatKey, {
      env: input.env
    });
    if (stored.status === 'ok') storageState = stored.state;
    else if (stored.status === 'needs_login') {
      logOncePerSeat(
        input.log,
        `session:${stored.reason}`,
        input.workspaceId,
        input.seatKey,
        `must sign in again: ${stored.reason}.`,
        new Date()
      );
      // The unusable row goes, so the next pass does not re-read and re-report
      // the same dead session forever.
      await clearSeatStorageState(input.db, input.workspaceId, input.seatKey);
    }
  }

  const opened = await openSeatBrowser(
    input.playwright as ProviderDriver,
    input.settings,
    {
      workspaceId: input.workspaceId,
      seatKey: input.seatKey,
      headless: input.headless,
      profileDir: input.profileDir,
      fingerprint: input.fingerprint,
      proxy: input.proxy,
      storageState,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars'],
      channels: BROWSER_CHANNELS
    },
    input.log
  );
  if ('refused' in opened) {
    // ONCE PER SEAT PER WINDOW. On a hosted fleet "this seat has no proxy" is a
    // steady state somebody has to fix, not a per-minute incident.
    logOncePerSeat(
      input.log,
      `remote:${opened.refused}`,
      input.workspaceId,
      input.seatKey,
      opened.refused,
      new Date()
    );
    return null;
  }

  const session = opened.session;
  try {
    // BEFORE ANY NAVIGATION, exactly as the local path does it: the context
    // opens on `about:blank`, so the first request LinkedIn sees already
    // carries a user agent and a `Sec-CH-UA*` set that agree with each other.
    await alignClientHints(session.context, session.page, input.fingerprint, input.log);
    setHumanSessionSalt(`${input.handleKey}:${new Date().toISOString().slice(0, 13)}`);
    await warmUpSession(session.page, input.handleKey, input.log);
    browserUseSeq += 1;
    const handle: BrowserHandle = {
      page: session.page as LinkedInPage,
      headless: input.headless,
      lastUsedAt: Date.now(),
      usedSeq: browserUseSeq,
      provider: 'remote',
      exportStorageState: session.exportStorageState,
      close: async () => {
        await session.close();
      }
    };
    await evictSurplusBrowsers(input.handleKey);
    browsers.set(input.handleKey, handle);
    return handle;
  } catch (cause) {
    // A remote session left open is a metered session left running as well as a
    // leaked handle, so nothing returns null from here without closing it.
    try {
      await session.close();
    } catch {
      // Already gone. Not a reason to withhold the answer.
    }
    input.log(
      `LinkedIn seat ${input.workspaceId}/${input.seatKey}: attached a remote browser and then closed it, because it could not be prepared for use (${cause instanceof Error ? cause.message : String(cause)}).`
    );
    return null;
  }
}

/**
 * Write this seat's signed-in state back, after a run that used it.
 *
 * LOCAL HANDLES ARE A NO-OP, and that is the whole reason this is a function
 * rather than an inline call: the local path's session lives in its profile
 * directory and must not acquire a second home.
 *
 * NEVER THROWS AND NEVER FAILS A RUN. The work is already done by the time
 * this is called; losing the session costs the next run a sign-in, which is a
 * cost worth paying rather than a reason to turn a completed batch into a
 * failed one.
 */
export async function persistSeatSession(
  db: Db,
  workspaceId: string,
  seatKey: string,
  log: (message: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const handle = browsers.get(seatHandleKey(workspaceId, seatKey));
  if (!handle || handle.provider !== 'remote' || !handle.exportStorageState) return false;
  try {
    const state = await handle.exportStorageState();
    if (!state) return false;
    return await saveSeatStorageState(db, { workspaceId, seatKey, state, env });
  } catch (cause) {
    log(
      `LinkedIn seat ${workspaceId}/${seatKey}: could not store this run's browser session (${cause instanceof Error ? cause.message : String(cause)}); the next run will sign in again.`
    );
    return false;
  }
}

export async function openBrowser(
  config: LinkedInLocalWorkerConfig,
  log: (message: string) => void,
  options: {
    /**
     * REQUIRED, and nullable rather than optional ON PURPOSE.
     *
     * The seat's own proxy (migration 062) lives in the database, and this
     * function is what hands Chromium a proxy. A caller that cannot supply a
     * database has to say so in as many characters as supplying one, so no
     * call site can omit it by accident and quietly open a direct connection
     * for a seat that was configured never to have one.
     */
    db: Db | null;
    workspaceId: string;
    seatKey?: string;
    headless?: boolean;
    /** The seat's own IANA timezone, when the caller already has it. */
    timezone?: string | null;
    /** Overridable so a test can drive the proxy rules without touching process.env. */
    env?: NodeJS.ProcessEnv;
    /**
     * The driver, injected.
     *
     * THE SAME SEAM `LocalWorkerStore` IS, AND FOR THE SAME REASON. What this
     * function has to get right -- close the context if anything after the
     * launch throws, keep the number of live contexts bounded, evict the least
     * recently used one -- is exactly the part no test could reach while the
     * only way in was a real 400MB Chromium. A leak that permanently strands a
     * seat is not something to verify by hand.
     */
    playwright?: PlaywrightLike;
  }
): Promise<BrowserHandle | null> {
  const headless = options.headless ?? false;
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  const handleKey = seatHandleKey(options.workspaceId, seatKey);
  const existing = browsers.get(handleKey);
  if (existing && existing.headless === headless) {
    // Touched on every reuse, which is what makes the eviction order an LRU
    // rather than "whichever seat this process happened to serve first".
    existing.lastUsedAt = Date.now();
    browserUseSeq += 1;
    existing.usedSeq = browserUseSeq;
    return existing;
  }
  if (existing) await closeLinkedInBrowser(options.workspaceId, seatKey);

  const playwright = options.playwright ?? (await loadLinkedInPlaywright(log, handleKey));
  if (!playwright) return null;
  const profileDir = resolveProfileDir(config.profileDir, options.workspaceId, seatKey);
  const providerSettings = config.companionBrowser
    ? (companionBrowserSettings(options.env ?? process.env) ??
      browserProviderSettings(options.env ?? process.env))
    : browserProviderSettings(options.env ?? process.env);
  const companion = providerSettings.remote?.sessionPersistence === 'browser';

  // A companion deliberately uses the member computer's own network. A proxy
  // configured for cloud execution is therefore ignored here rather than
  // silently moving the local browser back onto a third-party exit IP.
  let proxy: SeatProxy | null = null;
  if (!companion) {
    try {
      const stored = options.db
        ? await seatProxyUrl(options.db, options.workspaceId, seatKey)
        : null;
      proxy = resolveSeatProxy(options.env ?? process.env, options.workspaceId, seatKey, stored);
    } catch (cause) {
      log(
        `LinkedIn local worker will not open a browser for seat '${seatKey}': ${cause instanceof Error ? cause.message : String(cause)} A seat with a configured proxy is never connected directly.`
      );
      return null;
    }
  }

  const fingerprint = seatContextFingerprint(
    options.workspaceId,
    seatKey,
    options.timezone ?? null
  );

  // WHERE THE BROWSER IS, DECIDED HERE AND NOWHERE ELSE.
  if (providerSettings.kind === 'remote' || providerSettings.problem) {
    return openRemoteSeatHandle({
      settings: providerSettings,
      playwright,
      db: options.db,
      workspaceId: options.workspaceId,
      seatKey,
      handleKey,
      headless,
      profileDir,
      fingerprint,
      proxy,
      env: options.env ?? process.env,
      log
    });
  }

  try {
    const contextOptions = (channel: string): Record<string, unknown> => ({
      headless,
      channel,
      // THE FULL CHROMIUM BUILD, NEVER `chrome-headless-shell`. Omitting this
      // is how a headless launch silently became the headless SHELL binary --
      // a different product from Chrome that ships without the PDF viewer,
      // without `chrome.runtime`, with an empty `navigator.plugins`, with
      // SwiftShader as its WebGL renderer and with scrollbars switched off. It
      // announces itself to any fingerprinting script in the first frame, and
      // it was doing so while the user agent claimed to be desktop Chrome.
      // `channel: 'chromium'` is Playwright's opt-in to the real build running
      // `--headless=new`, which shares the headed browser's surface -- and
      // `'chrome'`, tried first, is better still: it is GOOGLE Chrome, the
      // actual consumer binary, with Widevine, the proprietary codecs and the
      // `chrome.runtime` object that Chromium builds simply do not have. See
      // {@link BROWSER_CHANNELS}.
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
      // ANGLE OVER EGL, AND ONLY WHERE THE DEFAULT PRODUCES NOTHING.
      //
      // Measured with `scripts/linkedin-fingerprint-probe.mjs`, headed Chrome
      // on an X display inside this container:
      //
      //   default                          -> getContext('webgl') returns NULL
      //   --use-gl=angle --use-angle=gl-egl -> ANGLE (Intel, Mesa Intel(R)
      //                                        Graphics (RPL-S), OpenGL ES 3.2)
      //
      // A browser with NO WebGL AT ALL is rarer than one with a software
      // renderer, so the default was the worse of the two. With a render node
      // passed in (compose.dev.yml `devices: /dev/dri`) these two flags reach
      // the host's real GPU; without one they land on Mesa's llvmpipe, which is
      // what a GPU-less cloud desktop reports.
      //
      // NOT ON THE OPERATOR'S OWN MACHINE. There the default already works and
      // reports desktop GL ('OpenGL 4.6'), which is exactly what every other
      // Chrome on that desktop reports. Forcing EGL would move it to
      // 'OpenGL ES 3.2' -- still real, still that GPU, but no longer the same
      // answer the member's own browser gives, and matching the neighbours is
      // the whole point.
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
      args: seatLaunchArgs(inContainer())
    });
    const context = await launchSeatBrowser(playwright, profileDir, contextOptions, log);
    // EVERYTHING PAST THE LAUNCH GETS ITS OWN TRY, AND THE CONTEXT IS CLOSED
    // IF ANY OF IT THROWS.
    //
    // This used to be one try around the whole block, with a catch that logged
    // and returned null -- and the launch is only the FIRST await in it.
    // `newPage`, `alignClientHints` and its CDP calls all come after, so any
    // failure there returned null while the context stayed open: a leaked
    // Chromium with nothing holding a handle to it, and -- much worse -- a
    // persistent user-data-dir whose exclusive lock that process now holds
    // forever. The seat it belonged to could not be opened again by anybody,
    // on this worker or any other, until a human killed the process. A leak
    // that permanently strands one tenant's account is not a leak, it is an
    // outage, and the fix is that nothing may return null from here without
    // closing what it opened.
    try {
      const existingPage = context.pages()[0];
      const page = (existingPage ?? (await context.newPage())) as LinkedInPage;
      // BEFORE ANY NAVIGATION. The context opens on `about:blank`, so no request
      // has left the browser yet and the first one LinkedIn sees already carries
      // a user agent and a `Sec-CH-UA*` set that agree with each other.
      await alignClientHints(context, page, fingerprint, log);
      // NO TWO SITTINGS SHARE A RHYTHM. Seeded by the seat and the hour, so a
      // run is still reproducible from the ledger while a restart -- or the
      // same profile opened twice -- never replays the same pauses. See
      // `setHumanSessionSalt`.
      setHumanSessionSalt(`${handleKey}:${new Date().toISOString().slice(0, 13)}`);
      // THE ONE FINGERPRINT NO CODE IN THIS FILE CAN FIX, said once per process
      // so it is on the operator's screen rather than in a document nobody
      // re-reads. A GPU-less container renders WebGL through SwiftShader and
      // says so, by name, to anything that asks -- and no consumer machine on
      // earth answers that. Everything else about this browser now agrees with
      // a real one; this does not, and only a real display fixes it.
      if (headless && inContainer() && !swiftShaderWarned) {
        swiftShaderWarned = true;
        log(
          'LinkedIn seat browser is running headless in a container, so its WebGL renderer reports SwiftShader -- a value no consumer machine reports, and the single strongest automation signal left. Run `npm run linkedin:worker` on a machine with a display to give this seat a real GPU string.'
        );
      }
      // AND ONLY THEN, THE FEED. A session whose very first request is
      // `/in/some-stranger/` or a search URL -- no feed load before it, no
      // referer, nothing in front of it -- is not a session a person has. A
      // person opens LinkedIn, lands on the feed, scrolls it, and goes
      // somewhere from there. This is the cheapest half of that and it costs
      // one page load per browser open, not per action.
      await warmUpSession(page, handleKey, log);
      browserUseSeq += 1;
      const handle: BrowserHandle = {
        page,
        headless,
        lastUsedAt: Date.now(),
        usedSeq: browserUseSeq,
        provider: 'local',
        // Null on purpose and not an oversight -- see the field's own comment.
        // The profile directory this context was launched at is the session.
        exportStorageState: null,
        close: async () => {
          await context.close();
        }
      };
      // The cap is enforced BEFORE the insert, so the number of live Chromium
      // processes this worker owns never exceeds it even momentarily.
      await evictSurplusBrowsers(handleKey);
      browsers.set(handleKey, handle);
      return handle;
    } catch (cause) {
      try {
        await context.close();
      } catch {
        // Already closing, already dead, or already gone. Nothing here is a
        // reason to leave the caller without an answer.
      }
      log(
        `LinkedIn local worker opened and then closed the browser profile at ${profileDir}: it could not be prepared for use (${cause instanceof Error ? cause.message : String(cause)}). Nothing was left holding the profile lock.`
      );
      lastBrowserOpenFailure.set(handleKey, cause);
      return null;
    }
  } catch (cause) {
    // NO RETRY WITHOUT THE PROXY, here or anywhere else. There is exactly one
    // launch attempt, and if it carried a proxy then every attempt for this
    // seat carries it.
    log(
      `LinkedIn local worker could not open the browser profile at ${profileDir}${proxy ? ` through ${proxy.server}` : ''}: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
    // WHY, not just that. The caller has only `null` to work with, and the one
    // thing an operator needs -- what the browser said -- is here.
    lastBrowserOpenFailure.set(handleKey, cause);
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
function seatBrowserMode(config: LinkedInLocalWorkerConfig): {
  headless: boolean;
  blocked: string | null;
} {
  const headed = linkedInBrowserReadiness(config);
  if (headed.canLaunchHeaded) return { headless: false, blocked: null };
  const headless = linkedInHeadlessReadiness(config);
  if (headless.canLaunchHeadless) return { headless: true, blocked: null };
  // Neither. The headed reasons are the fuller set and already carry the
  // container line that explains the rest.
  return {
    headless: false,
    blocked: headed.reasons[headed.reasons.length - 1] ?? linkedInOffReason(config)
  };
}

/** The four answers `POST /api/linkedin/seat/login` may give. */
export type LinkedInLoginStatus = 'ok' | 'otp_required' | 'challenge' | 'failed';

export interface LinkedInLoginOutcome {
  status: LinkedInLoginStatus;
  /** One sentence for the operator. NEVER carries either stored value. */
  message: string;
}

/**
 * What to tell the operator when a browser handle failed to open.
 *
 * IT USED TO NAME A CAUSE IT HAD NOT CHECKED -- "check that Chromium is
 * installed" -- and the first time it fired for real, Chromium was installed
 * and fine: the container's Xvfb had died on a stale lock, so Chrome could not
 * reach the display named in DISPLAY. The operator went looking for a missing
 * browser that was not missing, which is worse than being told nothing.
 *
 * `openBrowser` logs the launch error and returns null, so the sentence is
 * built from what the launch itself said. Only signatures that are UNAMBIGUOUS
 * become advice; anything else points at the log rather than guessing, because
 * a wrong next action costs more than an unspecific one.
 */
export function describeBrowserOpenFailure(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.message}` : String(cause ?? '');
  const opener = 'Could not open a LinkedIn browser session on this machine';
  if (/xserver|cannot open display|Missing X server/i.test(text)) {
    return `${opener}: a display is named but no X server is serving it, so the browser had nowhere to draw.`;
  }
  if (/Executable doesn't exist|ENOENT|playwright install/i.test(text)) {
    return `${opener}: the Chromium build is missing; run \`npx playwright install chromium\` where the worker runs.`;
  }
  return `${opener}; this server's log for this attempt has the reason the browser gave.`;
}

/**
 * The reason the last launch failed, per seat, so the message above can be
 * built where the failure is REPORTED rather than where it happened.
 *
 * Per seat and not global: two seats fail for two different reasons, and a
 * sentence about somebody else's proxy is a wrong sentence. Cleared as soon as
 * it is read -- it describes one attempt, not a state.
 */
const lastBrowserOpenFailure = new Map<string, unknown>();

function browserOpenFailedMessage(workspaceId: string, seatKey: string): string {
  const key = seatHandleKey(workspaceId, seatKey);
  const cause = lastBrowserOpenFailure.get(key);
  lastBrowserOpenFailure.delete(key);
  return describeBrowserOpenFailure(cause);
}

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
  const gap = (): number =>
    Math.round(TYPING_GAP_MS.min + random() * (TYPING_GAP_MS.max - TYPING_GAP_MS.min));

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
    if (typeof locator.press === 'function')
      wrapped.press = (key, options) => locator.press!(key, options);
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
 * How long a `challenge` result holds off the next login attempt, keyed the
 * same way {@link browsers} is.
 *
 * THE BUG THIS EXISTS TO FIX: every worker tick calls `loginLinkedInSeat`
 * again while a seat is not `isLoggedIn`, and the login path's first move is
 * `page.goto(LOGIN_URL)` -- so a human mid-way through LinkedIn's own device
 * check, in the exact window this worker opened for them, was getting
 * yanked back to a fresh login form every 60s, forever, because nothing
 * remembered that a challenge was already in flight. That reads as "it just
 * keeps refreshing" to the person trying to clear it, and repeated
 * automated-looking login attempts from one IP is itself the risk signal
 * this whole local-worker design exists to avoid.
 *
 * `isLoggedIn` is still checked first, every time, unconditionally: it only
 * reads the current page and never navigates, so it costs nothing to ask and
 * is what lets a challenge a human just cleared be picked up on the very next
 * tick rather than waiting out the cooldown. Only the RE-LOGIN attempt -- the
 * one that would drag the page away from what the human is looking at -- is
 * held off.
 */
const CHALLENGE_RETRY_COOLDOWN_MS = 10 * 60_000;
const challengedSeats = new Map<string, { until: number; message: string }>();

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
      db,
      workspaceId: options.workspaceId,
      seatKey,
      headless: mode.headless,
      timezone: options.timezone ?? null
    });
    if (!handle)
      return { status: 'failed', message: browserOpenFailedMessage(options.workspaceId, seatKey) };
    page = handle.page;
  }

  const driver = options.driver ?? playwrightDriver;

  // SESSION REUSE, AND IT IS THE NORMAL PATH. Nothing is decrypted to get here.
  // Per seat, because each seat has its own profile directory and therefore its
  // own session: one account's live session says nothing about another's.
  if (await driver.isLoggedIn(page)) {
    challengedSeats.delete(seatHandleKey(options.workspaceId, seatKey));
    await stampSeatSessionValid(db, options.workspaceId, now, seatKey);
    // THE CHEAPEST LINE IN THE LEDGER AND THE ONE MOST WORTH HAVING: a session
    // that keeps working, recorded, is what proves later that this seat was NOT
    // signing in over and over.
    await recordSeatEvent(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        kind: 'session_reused',
        url: typeof page.url === 'function' ? page.url() : null,
        detail: 'The stored session was still live; nothing was signed in.'
      },
      now
    );
    // REFRESHED EVEN THOUGH NOTHING SIGNED IN. LinkedIn rotates its own cookies
    // as a session is used, so a remote seat that only ever reuses would drift
    // towards a stored state older than the live one and eventually restore a
    // session LinkedIn has already retired. A no-op for a local handle.
    await persistSeatSession(db, options.workspaceId, seatKey, log);
    return {
      status: 'ok',
      message: 'That LinkedIn session is still live, so nothing had to be signed in.'
    };
  }

  // A companion seat signs in automatically when this workspace already has a
  // stored LinkedIn credential -- the same one the headless path below uses --
  // over the existing relay, exactly like `loginWithCredentials` further down.
  // Only when there is NO stored credential, or the attempt itself needs
  // something only a person can supply (an OTP, a checkpoint, a CAPTCHA), does
  // this fall back to a HUMAN recovery in the same profile. Record one durable
  // attention event in that case; a later `session_reused`/`login` event is
  // the proof that clears it.
  const companionHumanRecovery = async (
    forcedRecovery?: 'challenge' | 'signed_out'
  ): Promise<LinkedInLoginOutcome> => {
    const recovery =
      forcedRecovery ?? (await driver.sessionRecoveryReason?.(page!)) ?? 'signed_out';
    const command =
      seatKey === OWNER_SEAT_KEY
        ? 'trevra linkedin reconnect'
        : `trevra linkedin reconnect --seat ${seatKey}`;
    const message =
      recovery === 'challenge'
        ? `LinkedIn needs a human check on the paired computer. Run \`${command}\` to open the dedicated profile visibly, finish the CAPTCHA, verification or sign-in, then close that Chrome window. Background mode resumes automatically.`
        : `The LinkedIn session on the paired computer needs to be reconnected. Run \`${command}\` to open the dedicated profile visibly, sign in if asked, then close that Chrome window. Background mode resumes automatically.`;
    challengedSeats.set(seatHandleKey(options.workspaceId, seatKey), {
      until: now.getTime() + CHALLENGE_RETRY_COOLDOWN_MS,
      message
    });
    await recordSeatEvent(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        kind: recovery === 'challenge' ? 'challenge' : 'reconnect_required',
        url: typeof page!.url === 'function' ? page!.url() : null,
        detail: message
      },
      now
    );
    return { status: 'challenge', message };
  };

  const credentials = await readLinkedInCredentials(db, options.workspaceId, process.env, seatKey);

  if (config.companionBrowser && !credentials) return companionHumanRecovery();

  // A challenge from an earlier tick is still open in this same page. Say so
  // again, verbatim, rather than re-navigating to LOGIN_URL underneath the
  // person trying to clear it -- see CHALLENGE_RETRY_COOLDOWN_MS above.
  const challenged = challengedSeats.get(seatHandleKey(options.workspaceId, seatKey));
  if (challenged && challenged.until > now.getTime()) {
    return { status: 'challenge', message: challenged.message };
  }

  if (!credentials) {
    // Only reachable for a non-companion seat now -- a companion seat with no
    // stored credential already returned above. Covers hosted, nothing
    // stored, and half stored. One sentence -- naming the seat only when
    // there is more than one it could be, because "seat 'owner'" means
    // nothing to somebody running a single account.
    return {
      status: 'failed',
      message:
        seatKey === OWNER_SEAT_KEY
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
    // No interactive OTP channel exists on this call path for a companion
    // seat -- finishing a code is exactly the kind of step that needs a
    // person at the paired computer's own window.
    if (config.companionBrowser) return companionHumanRecovery('challenge');
    return {
      status: 'otp_required',
      message: 'LinkedIn wants a verification code; enter the one it just sent and sign in again.'
    };
  }
  if (result.ok) {
    challengedSeats.delete(seatHandleKey(options.workspaceId, seatKey));
    await stampSeatSessionValid(db, options.workspaceId, now, seatKey);
    // A SIGN-IN IS AN EVENT WORTH COUNTING. A burst of them is one of the
    // clearest things LinkedIn scores, and until this row existed nothing in
    // Trevra could have told you how many there had been.
    await recordSeatEvent(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        kind: 'login',
        url: typeof page.url === 'function' ? page.url() : null,
        detail: 'Signed in with stored credentials because the session was not active.'
      },
      now
    );
    // THE MOMENT WORTH STORING. A remote browser has no profile directory, so
    // without this line the sign-in that just happened would have to happen
    // again on the next run -- and a new-device sign-in on every run is the
    // loudest challenge signal LinkedIn has. A no-op for a local handle, whose
    // profile directory already holds it.
    const stored = await persistSeatSession(db, options.workspaceId, seatKey, log);
    return {
      status: 'ok',
      message: stored
        ? 'Signed in to LinkedIn; that session is now stored for this seat.'
        : 'Signed in to LinkedIn; that session is now stored in the browser profile.'
    };
  }
  if (result.failureKind === 'challenge') {
    // A companion profile keeps no Trevra-stored `storageState` to clear (see
    // docs/linkedin-companion.md) -- its session lives entirely in the local
    // Chrome profile, so the human-recovery fallback is the whole fix.
    if (config.companionBrowser) return companionHumanRecovery('challenge');
    const message =
      'LinkedIn wants a device check that only a person at a browser window can finish; run `npm run linkedin:worker` on a machine with a display, then complete it in that window.';
    challengedSeats.set(seatHandleKey(options.workspaceId, seatKey), {
      until: now.getTime() + CHALLENGE_RETRY_COOLDOWN_MS,
      message
    });
    // A CHALLENGED SESSION IS NOT A SESSION. Restoring the state that was in
    // the browser when LinkedIn stopped it would replay the challenge on every
    // run; the seat starts clean next time and signs in again.
    await clearSeatStorageState(db, options.workspaceId, seatKey);
    await recordSeatEvent(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        kind: 'challenge',
        url: typeof page.url === 'function' ? page.url() : null,
        detail: message
      },
      now
    );
    return { status: 'challenge', message };
  }

  if (config.companionBrowser) return companionHumanRecovery('signed_out');

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
  { ok: true; page: LinkedInPage; driver: LinkedInDriver } | { ok: false; blocked: string };

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
    db,
    workspaceId: options.workspaceId,
    seatKey,
    headless: mode.headless,
    timezone: options.timezone ?? null
  });
  if (!handle)
    return { ok: false, blocked: browserOpenFailedMessage(options.workspaceId, seatKey) };

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
        const prefix = `${workspaceId}`;
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
 * Close every context nobody has touched for `idleMs`.
 *
 * THE MAP USED TO BE APPEND-ONLY. Nothing on any success path ever removed a
 * handle, so this process retained one live Chromium per seat it had EVER
 * served -- at ~350-500MB each, a 16GB host died somewhere around 25-40 seats
 * and the only symptom was the OOM killer. Keeping a context open is a real
 * optimisation (a launch is seconds and a warm profile skips a sign-in), so
 * the answer is an expiry rather than closing everything after every batch:
 * a seat served every tick keeps its browser, a seat served once does not keep
 * it forever.
 *
 * {@link MAX_OPEN_BROWSERS} is the other half -- see `openBrowser`, which
 * evicts the least recently used context when the cap is reached, so memory is
 * bounded even when every seat is busy and nothing is idle.
 */
export async function closeIdleBrowsers(
  now: Date = new Date(),
  idleMs: number = browserIdleMs()
): Promise<number> {
  const deadline = now.getTime() - Math.max(60_000, idleMs);
  const stale = [...browsers.entries()].filter(([, handle]) => handle.lastUsedAt <= deadline);
  for (const [key] of stale) browsers.delete(key);
  await Promise.all(
    stale.map(async ([, handle]) => {
      try {
        await handle.close();
      } catch {
        // Same reasoning as the shutdown path: a context we cannot close is
        // not a reason to fail the pass that was tidying up after it.
      }
    })
  );
  return stale.length;
}

/**
 * The worker's entry point: one pass over the seats with work due THAT THIS
 * WORKER SERVES.
 *
 * ONE BATCH PER ACCOUNT, DRAINED INDEPENDENTLY. Each seat gets its own browser
 * (its own profile directory, its own session, its own fingerprint and its own
 * proxy if it has one), its own posture read, its own claim and its own
 * cooldown. A seat that is paused, cooling, unable to sign in, or that hits a
 * limit wall mid-batch is LOGGED AND SKIPPED, and the loop moves to the next
 * seat -- a checkpoint on one LinkedIn account must not stop the others, which
 * is the whole reason an operator runs more than one.
 *
 * WHAT CHANGED WHEN "THE WORKER" BECAME "THE WORKERS", and every line of it is
 * about a failure that only exists past one machine:
 *
 *   1. SHARDED. Discovery used to be the identical query, in the identical
 *      order, with no workspace predicate, run by every process on the
 *      deployment -- so N workers all reached for the same seat,
 *      `launchPersistentContext` handed the profile directory's exclusive lock
 *      to whichever got there first, and workers 2..N failed and raced each
 *      other to the next seat together. Adding a worker added contention and
 *      no throughput. Now each worker serves
 *      `hashtext(workspace||'/'||seat) % total = index` and two workers cannot
 *      want the same seat at all.
 *   2. LEASED, PER SEAT. The shard is a static partition and static partitions
 *      overlap during a rolling deploy (the old pod and the new one are the
 *      same index for a few seconds). `claimSeatLease` is what makes that safe
 *      AND what pins a seat to the HOST that holds its Chrome profile -- see
 *      that function for why moving a seat between hosts is a new-device login
 *      and therefore the loudest challenge signal available to us.
 *   3. CONCURRENT, BOUNDED. This loop was strictly serial: open a browser, sign
 *      in, drain up to 25 actions at a 30-120s gap each, then the next seat.
 *      That is ~31 minutes per seat, so a worker with 100 due seats needed ~52
 *      hours to finish a pass that the tick timer expected to take under a
 *      minute -- and `linkedinRunning` no-opped every later tick, so the queue
 *      drained at about two seats an hour whatever the hardware. The limit is
 *      bounded rather than absent because each in-flight seat is a whole
 *      Chromium (~350-500MB): unbounded parallelism is an OOM, not a speedup.
 *      It defaults to 1 where a human is watching (headed, one laptop, two
 *      Chrome windows fighting for the foreground is worse than two batches in
 *      a row) and to several where nobody is (headless, a container).
 *   4. FAIR. Discovery ordered by `workspace_id, seat_key` with no limit, so a
 *      tenant with a 50k backlog was served first, to completion, on every
 *      tick, and the tenant sorting last was never reached at all.
 *      `dueSeatsForWorker` bounds the share any one tenant gets per pass and
 *      orders tenants by how long they have been waiting.
 *   5. REAPED FIRST. A worker that died holding claims stranded those rows
 *      forever; nothing compared `claimed_at` to a deadline because there was
 *      never a second worker to compare it for. The pass now begins by
 *      releasing expired leases and closing batches whose worker is gone.
 *   6. LOUD WHEN DISCOVERY FAILS. It used to log one line and return `[]`,
 *      which is indistinguishable from "nothing is due" -- so a statement
 *      timeout on the unindexed discovery query stopped the entire
 *      deployment's LinkedIn queue with no alert anywhere. See
 *      {@link linkedInWorkerHealth}.
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
    /** Which slice of the fleet this process serves. Defaults to the environment's. */
    shard?: WorkerShard;
    /** Who this process is, for the claim and the lease. Defaults to the environment's. */
    workerId?: string;
    /** Which machine this process is on, for the profile pin. Defaults to this host's name. */
    host?: string;
    /** How many seats may be mid-batch at once. */
    concurrency?: number;
    /** The most seats one pass will touch. */
    maxSeats?: number;
    /** The most seats one TENANT may take from one pass. */
    maxSeatsPerWorkspace?: number;
    seatLeaseMs?: number;
    actionLeaseMs?: number;
    /** False in tests that want to observe a strand rather than have it repaired. */
    reap?: boolean;
    /**
     * Close each seat's browser when its batch ends. Defaults to true where
     * nobody is watching (headless): a hosted worker touching hundreds of
     * seats cannot keep one Chromium per seat alive.
     */
    closeAfterBatch?: boolean;
    /**
     * May this worker serve this seat at all? Absent means yes, always.
     *
     * THE HOSTED AUTHORISATION GATE, INJECTED RATHER THAN IMPORTED. On a
     * self-hosted deployment this is absent and the loop is byte-for-byte the
     * loop it always was -- no extra query per seat, no new failure mode. On a
     * hosted one it is `hostedSeatFilter`, which answers false for every
     * workspace that has not authorised Trevra to act on its LinkedIn account
     * from Trevra's own servers.
     *
     * CHECKED BEFORE THE LEASE AND BEFORE THE BROWSER, so an unauthorised
     * workspace costs one cached lookup rather than a claim it would have to
     * give back.
     */
    allowSeat?: (seat: { workspaceId: string; seatKey: string }) => Promise<boolean> | boolean;
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
  const headlessOnly = !headed.canLaunchHeaded;

  const shard = options.shard ?? workerShard();
  const workerId = options.workerId ?? workerIdentity();
  const host = options.host ?? workerHost();
  const seatLeaseMs = Math.max(60_000, Math.trunc(options.seatLeaseMs ?? SEAT_LEASE_MS));
  const actionLeaseMs = Math.max(60_000, Math.trunc(options.actionLeaseMs ?? ACTION_LEASE_MS));
  const concurrency = Math.max(
    1,
    Math.trunc(options.concurrency ?? defaultSeatConcurrency(headlessOnly))
  );
  const closeAfterBatch = options.closeAfterBatch ?? headlessOnly;

  // BEFORE DISCOVERY, ALWAYS. A row still claimed by a worker that no longer
  // exists is invisible to the discovery query (`claimed_at IS NULL`), so a
  // seat whose only due rows are stranded looks like a seat with no work --
  // forever. Reaping first is what lets this very pass see them. Each reaper
  // gets its own try: a failed reap must not cost the pass its actual work.
  if (options.reap !== false) {
    try {
      const released = await reapExpiredActionLeases(db, { now });
      if (released > 0)
        log(
          `LinkedIn local worker released ${released} action${released === 1 ? '' : 's'} whose worker stopped mid-claim; they are due again.`
        );
    } catch (cause) {
      log(
        `LinkedIn local worker could not release expired claims: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    try {
      const halted = await reapStaleLinkedInBatches(db, { now });
      if (halted > 0)
        log(
          `LinkedIn local worker closed ${halted} batch${halted === 1 ? '' : 'es'} left running by a worker that is gone.`
        );
    } catch (cause) {
      log(
        `LinkedIn local worker could not close abandoned batches: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  // Contexts nobody has used for a while, closed before this pass opens more.
  // A Chromium is ~350-500MB and the map used to be append-only for the life of
  // the process, so a host would die at a few dozen seats ever touched.
  await closeIdleBrowsers(now);

  const driver = options.driver ?? playwrightDriver;
  const results: LocalBatchResult[] = [];
  let seats: DueSeatForWorker[];
  try {
    seats = await dueSeatsForWorker(db, now, {
      shard,
      ...(options.seatKey ? { seatKey: options.seatKey } : {}),
      ...(options.maxSeats === undefined ? {} : { maxSeats: options.maxSeats }),
      ...(options.maxSeatsPerWorkspace === undefined
        ? {}
        : { maxSeatsPerWorkspace: options.maxSeatsPerWorkspace })
    });
    recordDiscoveryOutcome(null, now);
  } catch (cause) {
    // NOT A QUIET LOG AND AN EMPTY LIST. This read is the only thing standing
    // between a queued action and a worker, and the commonest way it fails --
    // a statement timeout against an unindexed scan -- produces exactly the
    // same `[]` as a genuinely empty queue. That equivalence is how an entire
    // deployment's LinkedIn automation stopped for hours with a single
    // debug-level line to show for it. It is recorded, so /health can report
    // it, and it goes to console.error rather than the caller's log.
    recordDiscoveryOutcome(cause, now);
    console.error(
      `LINKEDIN QUEUE STOPPED: the worker could not list due actions, so NO seat was served this tick (worker ${workerId}, shard ${shard.index + 1}/${shard.total}): ${cause instanceof Error ? cause.message : String(cause)}`
    );
    return [];
  }

  // Housekeeping on the event ledger, once a tick. Never throws; see the module.
  await pruneSeatEvents(db, now);

  await runBounded(seats, concurrency, async (seat) => {
    const { workspaceId, seatKey, timezone } = seat;
    // EVERY LINE THIS PASS LOGS NAMES THE TENANT AND THE SEAT. On one laptop
    // "could not open the browser" was a complete sentence; across thousands of
    // workspaces it is an unanswerable question.
    const say = seatLogger(log, workspaceId, seatKey);

    // BEFORE THE POSTURE, THE LEASE AND THE BROWSER: may this deployment act on
    // this workspace's account AT ALL? Absent on every self-hosted install, so
    // this is a no-op there; on a hosted one it is the recorded authorisation
    // from that workspace's owner. Silent by design -- a workspace that has not
    // opted in is not in an error state, and a per-minute line saying so for
    // every tenant that never asked for hosted execution is noise nobody reads.
    if (options.allowSeat && !(await options.allowSeat({ workspaceId, seatKey }))) return;

    // THE POSTURE IS READ FROM DISCOVERY, BEFORE A BROWSER EXISTS.
    //
    // `runLinkedInLocalBatch` checks it too and always will -- it is re-read
    // between every action so a pause takes effect within one tick. But it used
    // to be the FIRST check anything made, which meant a paused or cooling seat
    // paid a full Chromium launch, a sign-in and a LinkedIn navigation before
    // anything asked whether it was allowed to act. `jobs.ts` fixed exactly
    // this for the side tasks and left the send queue paying it; joining the
    // seat's posture into the discovery query is what pays it back here.
    const refusal = postureRefusal(seat.posture);
    if (refusal) {
      logOncePerSeat(say, `posture:${refusal}`, workspaceId, seatKey, refusal, now);
      results.push({
        batchId: null,
        workspaceId,
        seatKey,
        executed: 0,
        blocked: 0,
        failed: 0,
        branchSkipped: 0,
        branchPending: 0,
        halted: true,
        haltReason: refusal
      });
      return;
    }

    // BETWEEN SITTINGS, NOTHING OPENS. Checked here, next to the posture, and
    // for the same reason it is checked here: a seat that is resting must not
    // pay a Chromium launch and a LinkedIn navigation to find that out.
    const handleKey = seatHandleKey(workspaceId, seatKey);
    // BOTH THE MAP AND THE COLUMN. The Map is this process's memory of a break
    // it set itself; the column (migration 061) is what survives a restart and
    // what a second worker in a fleet can see. Whichever is later wins, because
    // the only wrong answer here is coming back early.
    const stored = await seatRestingUntil(db, workspaceId, seatKey);
    const restingUntil = Math.max(seatBreaks.get(handleKey) ?? 0, stored ? stored.getTime() : 0);
    // A PERSON'S OWN WORK OUTRANKS THE SEAT'S REST. The break paces what this
    // account does BY ITSELF; a row the ledger records as `source='manual'` is
    // the operator at the keyboard -- an answer to somebody who just wrote
    // (migration 074), a follow they just clicked -- and making them wait out a
    // two-hour gap between sittings is the same refusal the working window used
    // to make, wearing a different name. It is also the other half of the gate:
    // relaxing business hours for hand-driven work and then sleeping on it
    // until the next visit would change the error message and nothing else.
    //
    // Asked ONLY of a resting seat and answered by one indexed count, so the
    // ordinary tick pays nothing for it.
    const answerWaiting =
      restingUntil > now.getTime() && (await dueManualWork(db, workspaceId, seatKey, now));
    if (restingUntil > now.getTime() && !answerWaiting) {
      const reason = `is between sittings until ${new Date(restingUntil).toISOString()}`;
      logOncePerSeat(say, 'session-break', workspaceId, seatKey, reason, now);
      results.push({
        batchId: null,
        workspaceId,
        seatKey,
        executed: 0,
        blocked: 0,
        failed: 0,
        branchSkipped: 0,
        branchPending: 0,
        halted: true,
        haltReason: reason
      });
      return;
    }
    const sessionIndex = (seatSessions.get(handleKey) ?? 0) + 1;
    seatSessions.set(handleKey, sessionIndex);
    const sessionSeed = `${handleKey}:session:${sessionIndex}`;
    let restAfterBatch = false;

    // A DIRECTORY ON THIS DISK, OR A PROVIDER'S NAME. Which one decides whether
    // the lease pins this seat to this host -- see `claimSeatLease`. Passing
    // the profile directory unconditionally would have pinned every hosted seat
    // to whichever pod claimed it first, permanently, for a session that is not
    // on that pod's disk at all.
    const profileDir = seatSessionHome(config, workspaceId, seatKey);
    let lease: SeatLeaseOutcome;
    try {
      lease = await claimSeatLease(
        db,
        { workspaceId, seatKey, workerId, host, profileDir, leaseMs: seatLeaseMs },
        now
      );
    } catch (cause) {
      say(
        `could not be leased, so nothing was attempted for it: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      return;
    }
    if (!lease.ok) {
      // Once per seat per suppression window: on a fleet this is the normal
      // steady state (somebody else holds the seat), not an incident.
      logOncePerSeat(say, `lease:${lease.reason}`, workspaceId, seatKey, lease.reason, now);
      return;
    }

    // WHILE THE BATCH RUNS, THE LEASE IS PUSHED FORWARD. A batch legitimately
    // takes tens of minutes (25 actions behind 30-120s gaps), and a lease that
    // expired underneath a live worker would let a second worker open a second
    // Chrome on the same profile directory. Unref'd: a heartbeat must never be
    // the reason a process will not exit.
    const heartbeat = setInterval(
      () => {
        void heartbeatSeatLease(
          db,
          { workspaceId, seatKey, workerId, leaseMs: seatLeaseMs },
          new Date()
        ).catch(() => {
          // A missed heartbeat is not fatal on its own: the lease still has
          // whatever is left of its term, and the next one may well land.
        });
      },
      Math.max(15_000, Math.floor(seatLeaseMs / 3))
    );
    heartbeat.unref?.();

    try {
      // Opened lazily and once per SEAT, only after there is one to serve.
      const handle = await openBrowser(config, say, {
        db,
        workspaceId,
        seatKey,
        headless: headlessOnly,
        timezone
      });
      if (!handle) {
        // `continue`, not `return`. A browser this seat cannot open -- a proxy it
        // refused to skip, a profile directory another process holds -- says
        // nothing about the next seat, and returning here used to abandon every
        // remaining workspace's work for one workspace's problem.
        say('could not open a browser; its work stays due.');
        return;
      }

      // Every seat signs itself in: the session is made usable before the batch
      // opens, reused when it still works and signed in when it does not.
      const outcome = await loginLinkedInSeat(db, config, {
        workspaceId,
        seatKey,
        timezone,
        now,
        driver,
        page: handle.page,
        log: say
      });
      if (outcome.status !== 'ok') {
        say(`cannot be used: ${outcome.message}`);
        return;
      }

      await recordSeatEvent(
        db,
        {
          workspaceId,
          seatKey,
          kind: 'sitting_start',
          url: FEED_URL,
          detail: `Sitting ${sessionIndex} opened a browser and landed on the feed.`
        },
        new Date()
      );
      const store = postgresLocalWorkerStore(db, workspaceId, seatKey, {
        workerId,
        leaseMs: actionLeaseMs
      });
      const result = await runLinkedInLocalBatch(store, {
        driver,
        page: handle.page,
        // ONE SITTING, not "everything that is due". See SESSION_ACTIONS.
        maxActions: sessionActionBudget(sessionSeed),
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
              ...(action.overrideWarmupCeiling ? { overrideWarmupCeiling: true } : {}),
              // `replyToInbound` is the CONVERSATION's fact about who spoke
              // first (migration 074), carried the same way and for the same
              // reason: this worker never sets it and never infers it.
              ...(action.replyToInbound ? { replyToInbound: true } : {}),
              // `manual` is the LEDGER's fact about who queued this row
              // (`source='manual'`), carried for the same reason as the two
              // above and with the same rule: this worker never sets it and
              // never infers it. Without it, a reply or a follow a person
              // queued outside the working window passed the gate when they
              // typed it and was refused by the same gate at send time -- the
              // one shape of disagreement this re-evaluation exists to avoid.
              ...(action.manual ? { manual: true } : {})
            },
            at,
            // The claimed row is the SUBJECT of the question, not an answer to
            // it. Excluded by primary key; every other row still counts.
            { excludeActionId: action.id }
          ),
        now: () => new Date(),
        log: say
      });
      results.push(result);
      if (result.halted && result.haltReason) say(`stopped: ${result.haltReason}`);
      // A SITTING THAT DID SOMETHING ENDS IN A BREAK. A pass that found nothing
      // due did not use the account at all, so there is nothing to rest from --
      // resting on it would just make the queue slower without making anything
      // look more human.
      // BLOCKED COUNTS AS A SITTING TOO, and leaving it out was a bug worth
      // naming: a seat whose work is due but refused by the gate -- over its
      // daily ceiling, outside its hours, acceptance-throttled -- executed
      // nothing, so nothing rested it, so the next tick opened the browser,
      // loaded the feed and was refused again, once a minute, for as long as
      // the refusal lasted. A feed load every 60 seconds forever is a worse
      // pattern than the actions it was refusing to send, and every reason the
      // gate refuses for is one that needs HOURS to change, not a minute.
      if (result.executed > 0 || result.blocked > 0) {
        // AWAY UNTIL THE END OF THIS VISIT, WHICH IS THE SAME VISIT THE READS
        // USE. The break used to be an independent 25-90 minute draw, so an
        // account had two rhythms: `planPacing` now places every send inside a
        // visit, and a break that ignored those visits could end mid-way
        // through the next one or run straight past it. Resting to the end of
        // the current visit means the next opening of LinkedIn is the next
        // thing that happens -- one presence, not two.
        //
        // The drawn break is the FALLBACK, for a seat with no row, no window
        // or a window too short to hold a visit. It is also what this did
        // before, so the degraded path is the old behaviour rather than a new
        // one.
        const until =
          (await visitEndsAt(db, workspaceId, seatKey, new Date()))?.getTime() ??
          Date.now() + sessionBreakMs(sessionSeed);
        seatBreaks.set(handleKey, until);
        await setSeatRestingUntil(db, workspaceId, seatKey, new Date(until));
        await recordSeatEvent(
          db,
          {
            workspaceId,
            seatKey,
            kind: 'sitting_end',
            detail: `${result.executed} action(s) sent, ${result.blocked} refused by the gate, ${result.failed} failed. Away until ${new Date(until).toISOString()}.`
          },
          new Date()
        );
        restAfterBatch = true;
        say(
          result.executed > 0
            ? `finished a sitting of ${result.executed} action(s); away until ${new Date(until).toISOString()}`
            : `had ${result.blocked} action(s) refused by the gate and nothing to send; away until ${new Date(until).toISOString()}`
        );
      }
    } catch (cause) {
      // One SEAT's failure is one seat's failure. The pass carries on with the
      // other accounts rather than ending the tick.
      say(`failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      // THE SESSION IS WRITTEN BACK BEFORE THE BROWSER IS CLOSED, and in the
      // `finally` rather than on the success path: a batch that failed halfway
      // still signed in, still has live cookies, and losing them would cost the
      // next run a fresh sign-in for no reason. A no-op for a local handle,
      // whose session is its profile directory. Never throws.
      await persistSeatSession(db, workspaceId, seatKey, say);
      clearInterval(heartbeat);
      // The lease is RELEASED, not deleted: the row is also the record of which
      // host holds this seat's Chrome profile, and that outlives this pass.
      try {
        await releaseSeatLease(db, { workspaceId, seatKey, workerId }, new Date());
      } catch {
        // An unreleased lease expires on its own. Failing here would turn a
        // bookkeeping problem into a lost batch result.
      }
      // `restAfterBatch` closes it too: a sitting that ended is a tab that was
      // closed, and the next one starts by opening the feed again.
      if (closeAfterBatch || restAfterBatch) await closeLinkedInBrowser(workspaceId, seatKey);
    }
  });

  return results;
}

/**
 * Run `work` over `items` with at most `limit` in flight.
 *
 * Deliberately not `Promise.all` and deliberately not a library. `Promise.all`
 * over a thousand due seats is a thousand simultaneous Chromium launches,
 * which is an OOM rather than a fast pass; a serial loop is what this code did
 * before and it could not finish. `limit` lanes pulling from one cursor is the
 * whole of the middle ground, and the cursor is safe without a mutex because
 * `cursor++` cannot be interleaved: JavaScript only switches lanes at an await.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  if (limit <= 1) {
    for (const item of items) await work(item);
    return;
  }
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
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
  const refuse = (
    message: string,
    failureKind: LinkedInFailureKind | null = null
  ): DetectSeatResult => ({
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
      db,
      workspaceId: options.workspaceId,
      seatKey,
      headless: mode.headless,
      // The timezone the client just read off its own Intl settings, which for
      // a first detect is the only one that exists -- there is no seat row yet.
      timezone: options.timezone
    });
    if (!handle) return refuse(browserOpenFailedMessage(options.workspaceId, seatKey));
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
  if (outcome.status !== 'ok')
    return refuse(outcome.message, outcome.status === 'challenge' ? 'challenge' : null);

  // ONE PAGE, NOT TWO, WHEN THE SECOND ONE HAS NOTHING NEW TO SAY. `readSeat`
  // loads the connections list purely for the exact count -- a surface
  // LinkedIn associates with prospecting -- on every detect, forever. The
  // count moves by a handful a week; a week-old one is worth more than a
  // navigation. When it is skipped the read returns null and `upsertSeat`
  // leaves the stored number alone.
  const known = await getSeat(db, options.workspaceId, seatKey);
  const countIsFresh =
    known?.connectionsCount != null &&
    known.detectedAt != null &&
    now.getTime() - new Date(known.detectedAt).getTime() < 7 * 86_400_000;
  const read = await driver.readSeat(page, { skipConnections: countIsFresh });
  await recordSeatEvent(
    db,
    {
      workspaceId: options.workspaceId,
      seatKey,
      kind: 'navigate',
      url: typeof page.url === 'function' ? page.url() : null,
      detail: countIsFresh
        ? 'Read the seat from its own profile page; the connections list was skipped because the stored count is less than a week old.'
        : 'Read the seat from its own profile page and the connections list.'
    },
    now
  );
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
      `This browser signed in as ${read.profileUrl}, not ${previousProfileUrl} as this workspace last confirmed. ` +
      `${clearedThreads} stored conversation${clearedThreads === 1 ? '' : 's'} from the previous account ` +
      `${clearedThreads === 1 ? 'was' : 'were'} cleared and the warm-up ramp restarted for the new account.`;
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
    detected: {
      profileUrl: read.profileUrl,
      name: read.name,
      connectionsCount: read.connectionsCount
    },
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
  /** Read-only API decoration for a pending request; never persisted. */
  nextAttemptAt?: string | null;
  waitingFor?: import('./leads.js').LinkedInQueueWaitReason | null;
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
  await db
    .prepare(
      `
    INSERT INTO linkedin_seat_detect_requests (id, workspace_id, seat_key, timezone, status, requested_at)
    VALUES (?,?,?,?,'pending',?)
    ON CONFLICT (workspace_id, seat_key) WHERE status = 'pending' DO NOTHING
  `
    )
    .run(id('lsdr'), options.workspaceId, seatKey, options.timezone, now.toISOString());

  const row = await db
    .prepare(
      `
    SELECT ${SEAT_DETECT_COLUMNS} FROM linkedin_seat_detect_requests
    WHERE workspace_id=? AND seat_key=? AND status='pending'
  `
    )
    .get<SeatDetectRow>(options.workspaceId, seatKey);
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
  const row = await db
    .prepare(
      `
    SELECT ${SEAT_DETECT_COLUMNS} FROM linkedin_seat_detect_requests
    WHERE workspace_id=? AND seat_key=?
    ORDER BY requested_at DESC
    LIMIT 1
  `
    )
    .get<SeatDetectRow>(workspaceId, seatKey);
  return row ? toSeatDetectRequest(row) : null;
}

/**
 * Take the oldest pending detect request THIS WORKER MAY SERVE, or null.
 *
 * THREE PREDICATES, AND EVERY ONE OF THEM IS ABOUT A FLEET RATHER THAN A
 * LAPTOP:
 *
 *   * the stale-claim window (the original, 027): a detect is a pure READ, so
 *     a worker killed mid-flight must not wedge a workspace's setup forever;
 *   * `excludeWorkspaces`: the tenants this pass has already served, which is
 *     what stops one workspace's 5,000-seat onboarding from being a global
 *     FIFO that every other tenant's Connect button queues behind;
 *   * the shard: two workers on the same Postgres took the same row here,
 *     raced for the same profile directory, and the loser did nothing but
 *     burn a tick. Sharding on (workspace, seat) means adding a worker adds
 *     throughput instead of adding contention.
 *
 * `FOR UPDATE SKIP LOCKED` still guards the case the shard cannot: two
 * processes configured as the SAME shard index (a rolling deploy with an old
 * and a new pod overlapping) take different rows rather than the same one.
 */
async function claimSeatDetectRequest(
  db: Db,
  now: Date,
  staleClaimMs: number,
  excludeWorkspaces: readonly string[] = [],
  shard: WorkerShard = SINGLE_WORKER_SHARD
): Promise<SeatDetectRequest | null> {
  const staleBefore = new Date(now.getTime() - staleClaimMs).toISOString();
  const row = await db
    .prepare(
      `
    UPDATE linkedin_seat_detect_requests SET claimed_at=?
    WHERE id = (
      SELECT id FROM linkedin_seat_detect_requests
      WHERE status='pending' AND (claimed_at IS NULL OR claimed_at < ?)
        AND NOT (workspace_id = ANY(?::text[]))
        AND ${shardPredicate("workspace_id || '/' || seat_key")}
      ORDER BY requested_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${SEAT_DETECT_COLUMNS}
  `
    )
    .get<SeatDetectRow>(
      now.toISOString(),
      staleBefore,
      [...excludeWorkspaces],
      ...shardParams(shard)
    );
  return row ? toSeatDetectRequest(row) : null;
}

async function settleSeatDetectRequest(
  db: Db,
  requestId: string,
  outcome: { status: Exclude<SeatDetectStatus, 'pending'>; failureReason: string | null },
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE linkedin_seat_detect_requests
    SET status=?, failure_reason=?, finished_at=?
    WHERE id=?
  `
    )
    .run(outcome.status, outcome.failureReason, now.toISOString(), requestId);
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
    /**
     * Which slice of the fleet this process serves. Defaults to the
     * environment's own (see {@link workerShard}); a single worker is
     * `{ index: 0, total: 1 }`, which selects everything.
     */
    shard?: WorkerShard;
    /** May this worker serve this workspace/seat now? Used by hosted companion presence. */
    allowSeat?: (seat: { workspaceId: string; seatKey: string }) => Promise<boolean> | boolean;
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
  if (!options.page && !config.companionBrowser) {
    const readiness = linkedInBrowserReadiness(config);
    if (!readiness.canLaunchHeaded) {
      reportUnready(log, readiness);
      return [];
    }
  }

  const maxRequests = Math.max(1, Math.trunc(options.maxRequests ?? 5));
  const staleClaimMs = options.staleClaimMs ?? SEAT_DETECT_STALE_CLAIM_MS;
  const shard = options.shard ?? workerShard();
  const settled: SeatDetectRequest[] = [];
  /**
   * The tenants this pass has already served, and the whole of the fairness.
   *
   * ONE REQUEST PER WORKSPACE PER PASS. The claim below is a global FIFO --
   * correctly, because a detect is somebody standing at the Connect button --
   * and a global FIFO with no per-tenant bound is exactly how one workspace
   * onboarding 5,000 seats holds every other workspace's Connect button for
   * hours. Excluding the tenants already served this pass means five pending
   * requests are five DIFFERENT tenants, oldest first, and the big onboarding
   * still drains at five per tick per worker rather than all at once.
   */
  const servedWorkspaces: string[] = [];

  for (let index = 0; index < maxRequests; index += 1) {
    const now = options.now ?? new Date();
    let request: SeatDetectRequest | null;
    try {
      request = await claimSeatDetectRequest(db, now, staleClaimMs, servedWorkspaces, shard);
    } catch (cause) {
      log(
        `LinkedIn detect queue could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      return settled;
    }
    if (!request) break;
    servedWorkspaces.push(request.workspaceId);

    // A paired computer is deliberately ephemeral. Do not turn "laptop is
    // asleep" or "Trevra tab is closed" into a failed Connect request: put the
    // pure-read claim back and let the next real presence window pick it up.
    if (
      options.allowSeat &&
      !(await options.allowSeat({ workspaceId: request.workspaceId, seatKey: request.seatKey }))
    ) {
      await db
        .prepare(
          `UPDATE linkedin_seat_detect_requests SET claimed_at=NULL WHERE id=? AND status='pending'`
        )
        .run(request.id);
      continue;
    }

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
    if (failureReason)
      log(
        `LinkedIn seat detection failed for ${request.workspaceId}/${request.seatKey}: ${failureReason}`
      );
  }

  return settled;
}
