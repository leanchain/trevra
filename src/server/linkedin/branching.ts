import { z } from 'zod';
import type { LinkedInActionKind, LinkedInActionStatus } from './actions.js';

/**
 * Conditional branching: WHETHER a step runs, never WHEN.
 *
 * Dripify's campaign builder branches -- "if the invite was accepted send a
 * message, if it was not send an InMail" -- and ours was a flat list of steps
 * on fixed days (plan 4A, "Campaign builder w/ branching", the one row in that
 * table where we were behind). This module is that branch, and it is
 * deliberately the smallest thing that can be one.
 *
 * THREE RULES THIS FILE HOLDS TO, in the order they matter.
 *
 * 1. THE VOCABULARY IS CLOSED. Five values, listed in `BRANCH_ON_VALUES`, and
 *    an expression language is the thing that was NOT built. An expression is
 *    unvalidatable by construction: `validateSequenceSteps` refuses a merge
 *    field Trevra cannot fill and a day that goes backwards because it can
 *    name every one of them, and it could not do that for arbitrary code. A
 *    condition an operator can write but nobody can check before it sends is
 *    how a campaign discovers its own bug in a stranger's inbox.
 *
 * 2. BRANCHING NEVER MOVES A STEP EARLIER. `notBefore` is the step's declared
 *    day, floored again by whatever instant the pacing engine put on the
 *    step's own ledger row, and a satisfied condition cannot lower it. This is
 *    load-bearing rather than tidy: the daily ceiling, the warm-up ramp and
 *    the day-over-day variance clamp all live in `pacing.ts` and all reason
 *    about a calendar. A branch that could pull a step forward would be a
 *    route around every one of them -- "they accepted, so send now" is exactly
 *    how twelve invites become the +120% spike in plan 1.3. Pacing owns time;
 *    this file owns eligibility; they compose with `max`, never with `min`.
 *
 * 3. THE ANSWER IS THREE-WAY. `due`, `skipped`, and `pending` -- and `pending`
 *    is the common case, not the edge one. "The invite went out an hour ago
 *    and nobody has answered" is neither "send the accepted branch" nor "skip
 *    it forever", and collapsing it into either produces a wrong send: into
 *    `due` it sends a message to somebody who never connected, into `skipped`
 *    it retires a branch that was about to become true.
 *
 * PURE. No `Date.now()`, no `Math.random()`, no database. `evaluateBranches`
 * takes a sequence, one target's ledger rows and an injected `now`, and
 * returns a decision -- the same discipline `pacing.ts` keeps and for the same
 * reason: the playbook engine binds an approval to `canonicalPayloadHash`, so
 * anything that read a clock of its own would make a payload that drifts out
 * from under its own approval.
 *
 * A PURE EXTENSION. `condition` is optional and its absence means `always`, so
 * every sequence that exists today -- every stored `sequence_json`, every
 * entry in `templates.ts` -- keeps its exact current meaning with no backfill
 * and no migration of data. A sequence with no conditions evaluates to the
 * flat day-gated list it already was, and `branching.test.ts` asserts that
 * rather than trusting this paragraph.
 */

/* -------------------------------------------------------------------------
 * The vocabulary
 * ---------------------------------------------------------------------- */

/**
 * Every branch there is.
 *
 * `always` is redundant with omitting the condition and is listed anyway,
 * because a UI that renders a dropdown needs a value for the default arm and
 * a stored sequence that spells it out must not be refused.
 */
export const BRANCH_ON_VALUES = [
  'accepted',
  'replied',
  'not_accepted',
  'not_replied',
  'always'
] as const;

export type BranchOn = (typeof BRANCH_ON_VALUES)[number];

export interface StepCondition {
  on: BranchOn;
  /** The id of an EARLIER step in the same sequence. Earlier is what makes the graph acyclic. */
  ofStepId: string;
}

/**
 * A condition as it arrives from an editor or a stored sequence.
 *
 * Spliced into `sequenceStepInputSchema` (sequence.ts) and
 * `linkedinSequenceStepsSchema` (app.ts) as `condition: stepConditionSchema.nullish()`.
 * `ofStepId` is required even for `always`: the shape stays uniform, and an
 * `always` naming a step that does not exist is a broken edit an operator
 * wants to hear about at write time rather than never. The way to say "no
 * condition" is to send no condition.
 */
export const stepConditionSchema = z.object({
  on: z.enum(BRANCH_ON_VALUES),
  ofStepId: z.string().trim().min(1).max(64)
});

/**
 * The shape this module needs from a step, and nothing more.
 *
 * Structural on purpose: `SequenceStepInput` and `SequenceStep` both satisfy
 * it once they carry `condition`, so neither has to be imported here and the
 * module graph stays one-way (sequence.ts -> branching.ts). A cycle would put
 * `stepConditionSchema` in the temporal dead zone whichever module happened to
 * load second.
 */
export interface BranchableStep {
  id: string;
  /** Days after campaign start. The floor this module may never go below. */
  day: number;
  kind: LinkedInActionKind;
  /** Absent or null means `always`. */
  condition?: StepCondition | null;
}

/** The effective condition. Null is the honest spelling of "runs unconditionally". */
export function conditionOf(step: BranchableStep): StepCondition | null {
  const condition = step.condition;
  if (!condition) return null;
  if (condition.on === 'always') return null;
  return condition;
}

/** True when any step in this sequence branches. Lets a caller skip the evaluator entirely. */
export function hasBranching(steps: readonly BranchableStep[]): boolean {
  return steps.some((step) => conditionOf(step) !== null);
}

/* -------------------------------------------------------------------------
 * The validator
 * ---------------------------------------------------------------------- */

/**
 * Kinds whose outcome a branch can read.
 *
 * An invite is accepted or declined; a dm and a reply are replied to or not. A
 * profile view, a follow, a like, an endorsement and a comment produce no
 * outcome at all -- LinkedIn tells nobody whether a stranger noticed -- so a
 * condition on one of them is a branch that can never be decided, which in a
 * three-way evaluator means a step that stays `pending` for the life of the
 * campaign. That is a sequence with a dead arm in it, and it is refused at
 * write time instead.
 *
 * 'inmail' LEFT THIS LIST when it was retired (actions.ts
 * `UNSUPPORTED_ACTION_KINDS`). A branch may only depend on a step that can
 * actually run, and an InMail step is a step nothing sends -- so a condition on
 * one was a branch that could never be decided for exactly the reason the
 * paragraph above gives, arrived at from the other direction.
 */
const RESULT_BEARING_KINDS: readonly LinkedInActionKind[] = ['invite', 'dm', 'reply'];

/** Kind names as an operator reading a refusal would say them. */
const KIND_NOUNS: Record<LinkedInActionKind, string> = {
  invite: 'connection request',
  dm: 'message',
  reply: 'reply',
  inmail: 'InMail',
  profile_view: 'profile view',
  comment: 'comment',
  follow: 'follow',
  unfollow: 'unfollow',
  disconnect: 'disconnect',
  like: 'like',
  endorse: 'skill endorsement',
  withdraw: 'invite withdrawal'
};

/** Branches that ask whether an invite was accepted. Only an invite can answer. */
const ACCEPTANCE_BRANCHES: readonly BranchOn[] = ['accepted', 'not_accepted'];

function isBranchOn(value: unknown): value is BranchOn {
  return typeof value === 'string' && (BRANCH_ON_VALUES as readonly string[]).includes(value);
}

/**
 * Every rule a branch has to hold, or the one sentence that says which failed.
 *
 * RETURNS A MESSAGE RATHER THAN THROWING, which is the one thing about this
 * signature that will look odd next to `validateSequenceSteps`. Two reasons,
 * and the second is the real one:
 *
 *   - It keeps this module free of `SequenceValidationError`, so sequence.ts
 *     can import branching.ts without branching.ts importing sequence.ts back.
 *   - The caller stays the one place that decides what a refusal IS. sequence.ts
 *     turns it into a `SequenceValidationError`, which `app.ts` already maps to
 *     a 400 with the message verbatim, so a branch refusal reads to an operator
 *     exactly like "days cannot go backwards" does today.
 *
 * FIRST offence only, and it names the step, matching the existing validator:
 * this is an editor round-trip and an operator fixes one line at a time.
 */
export function conditionRejection(steps: readonly BranchableStep[]): string | null {
  const seenBefore = new Map<string, BranchableStep>();

  for (const step of steps) {
    const stepId = typeof step.id === 'string' ? step.id.trim() : '';
    const condition = step.condition;

    if (condition !== undefined && condition !== null) {
      if (!isBranchOn((condition as StepCondition).on)) {
        return `Step '${stepId}' branches on '${String((condition as StepCondition).on)}', which is not one of ${BRANCH_ON_VALUES.join(', ')}; a branch is a closed list of five outcomes so that every one of them can be checked before anything is sent.`;
      }

      const ofStepId = typeof condition.ofStepId === 'string' ? condition.ofStepId.trim() : '';
      if (!ofStepId) {
        return `Step '${stepId}' has a condition that names no step to wait on; a branch reads the outcome of one earlier step, so it has to say which.`;
      }
      if (ofStepId === stepId) {
        return `Step '${stepId}' waits on itself, and a step cannot be the evidence for whether it runs.`;
      }

      const referenced = seenBefore.get(ofStepId);
      if (!referenced) {
        const laterInList = steps.some(
          (other) => typeof other.id === 'string' && other.id.trim() === ofStepId
        );
        return laterInList
          ? `Step '${stepId}' waits on step '${ofStepId}', which comes after it in this sequence; a branch can only read a step that has already run.`
          : `Step '${stepId}' waits on step '${ofStepId}', which is not in this sequence, so nothing would ever decide whether this step runs.`;
      }

      // `always` reads no outcome, so the two rules below -- which are about
      // what an outcome MEANS -- do not apply to it. The reference rules above
      // still do: an `always` pointing at a step that vanished in an edit is
      // the same typo whether or not anybody reads the result.
      if (condition.on !== 'always') {
        if (!RESULT_BEARING_KINDS.includes(referenced.kind)) {
          return `Step '${stepId}' waits on the outcome of step '${ofStepId}', a ${KIND_NOUNS[referenced.kind] ?? referenced.kind}, which is never accepted or replied to, so this branch could never be decided either way.`;
        }
        if (ACCEPTANCE_BRANCHES.includes(condition.on) && referenced.kind !== 'invite') {
          return `Step '${stepId}' waits on whether step '${ofStepId}' was accepted, but '${ofStepId}' is a ${KIND_NOUNS[referenced.kind] ?? referenced.kind} and only a connection request can be accepted.`;
        }
      }
    }

    if (stepId) seenBefore.set(stepId, step);
  }

  return cycleRejection(steps);
}

/**
 * The cycle assertion.
 *
 * UNREACHABLE TODAY, ON PURPOSE, AND CHECKED ANYWAY. `conditionRejection`
 * refuses any reference that is not to an EARLIER step, and a graph whose
 * every edge points backwards in a list cannot contain a loop -- so this can
 * only fire if that rule is ever relaxed. It is written now because the day
 * somebody relaxes it is the day the failure mode becomes "two steps waiting
 * on each other forever", which the evaluator reports as `pending` and nobody
 * reads as a bug. An assertion that costs one pass over the steps is cheaper
 * than that conversation.
 *
 * Exported so the assertion can be tested against a hand-built cyclic list
 * that the earlier-only rule would never let through.
 */
export function cycleRejection(steps: readonly BranchableStep[]): string | null {
  const byId = new Map<string, BranchableStep>();
  for (const step of steps) {
    const stepId = typeof step.id === 'string' ? step.id.trim() : '';
    if (stepId && !byId.has(stepId)) byId.set(stepId, step);
  }

  const settled = new Set<string>();
  for (const start of byId.keys()) {
    if (settled.has(start)) continue;
    const path = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !settled.has(cursor)) {
      if (path.has(cursor)) {
        return `Step '${cursor}' is part of a loop of conditions that ends up waiting on itself, so no step in that loop could ever run.`;
      }
      path.add(cursor);
      const step = byId.get(cursor);
      const condition = step ? conditionOf(step) : null;
      cursor = condition ? condition.ofStepId.trim() : undefined;
    }
    for (const visited of path) settled.add(visited);
  }

  return null;
}

/* -------------------------------------------------------------------------
 * The evaluator
 * ---------------------------------------------------------------------- */

/**
 * One ledger row, as this module needs it.
 *
 * A narrow structural view of `linkedin_actions` rather than the row type,
 * because the evaluator must stay callable from a test with four object
 * literals and no database.
 */
export interface BranchActionRow {
  kind: LinkedInActionKind;
  status: LinkedInActionStatus;
  /**
   * Which sequence step wrote this row, when the ledger knows.
   *
   * `linkedin_actions` does not carry a step id today, so this is optional and
   * the fallback is `kind` -- sound for an invite, which `validateSequenceSteps`
   * already limits to one per sequence, and lossy for a second dm, which shares
   * a row with the first under the (workspace, seat, kind, target) replay guard
   * in 022. Reading it here rather than assuming it means the day a step id
   * lands on the ledger, this module needs no change.
   *
   * lc-debt: two dm steps against one target resolve to the same ledger row, so
   * a `replied` branch on the second reads the first's outcome; upgrade path is
   * a `step_id` column on `linkedin_actions` plus a widened replay guard, then
   * pass it here.
   */
  stepId?: string | null;
  /** The paced slot, when there is one. ISO-8601 or a Date. */
  plannedFor?: string | Date | null;
}

export type BranchOutcome = 'due' | 'skipped' | 'pending';

export interface StepDecision {
  stepId: string;
  outcome: BranchOutcome;
  /**
   * The earliest instant this step may run, ISO-8601.
   *
   * Never earlier than the step's declared day, and pushed later by the pacing
   * slot on the step's own ledger row when there is one. `outcome === 'due'`
   * always implies `now >= notBefore`.
   */
  notBefore: string;
  /** Why, in one sentence, in the register of the validator's refusals. */
  reason: string;
}

export interface BranchEvaluation {
  targetRef: string;
  /** One per step, in sequence order. */
  decisions: StepDecision[];
  /** Step ids by bucket, for a caller that only wants the answer. */
  due: string[];
  skipped: string[];
  pending: string[];
}

export interface BranchEvaluationInput {
  steps: readonly BranchableStep[];
  /** The one person these ledger rows are about. Opaque, never resolved. */
  targetRef: string;
  /** This target's `linkedin_actions` rows. Rows for anybody else must not be passed. */
  actions: readonly BranchActionRow[];
  /** Campaign day 0. `linkedin_campaigns.created_at` is the instant the day offsets count from. */
  campaignStartedAt: Date;
  /** Injected. This module never reads a clock. */
  now: Date;
}

const DAY_MS = 86_400_000;

/** Three-valued, because "nobody has answered yet" is not "no". */
type Tri = 'yes' | 'no' | 'unknown';

/**
 * Did they accept?
 *
 * 'replied' implies accepted -- the same reading `acceptanceRate` in actions.ts
 * takes, and for the same reason: a stranger cannot reply to a connection they
 * did not accept. A row still sitting at 'planned', 'exported' or 'sent' has no
 * answer in it, which is `unknown` and not `no`.
 */
function acceptedTri(status: LinkedInActionStatus): Tri {
  if (status === 'accepted' || status === 'replied') return 'yes';
  if (status === 'declined') return 'no';
  return 'unknown';
}

/** Did they reply? An accepted invite is not a reply; a declined one will never become one. */
function repliedTri(status: LinkedInActionStatus): Tri {
  if (status === 'replied') return 'yes';
  if (status === 'declined') return 'no';
  return 'unknown';
}

function instantOf(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The row this step produced, by step id when the ledger has one, else by kind. */
function rowForStep(
  step: BranchableStep,
  actions: readonly BranchActionRow[]
): BranchActionRow | undefined {
  const stepId = typeof step.id === 'string' ? step.id.trim() : '';
  const byStepId = actions.find(
    (action) =>
      typeof action.stepId === 'string' && action.stepId.trim() === stepId && stepId !== ''
  );
  if (byStepId) return byStepId;
  // A 'skipped' row released the target (022's replay guard excludes it), so a
  // live row for the same kind is the better answer when both exist.
  const sameKind = actions.filter((action) => action.kind === step.kind);
  return sameKind.find((action) => action.status !== 'skipped') ?? sameKind[0];
}

type ConditionVerdict = 'satisfied' | 'failed' | 'undecided';

/**
 * Decide the outcome of every step for one target.
 *
 * The steps are walked in list order, so a step's condition is resolved
 * against a referenced step whose own decision is already known -- which is
 * what makes a skipped branch CASCADE. If the invite was skipped, "send this
 * if the invite was accepted" is not merely false, it is unanswerable forever,
 * and every step hanging off it is skipped too. That is fail-closed in the one
 * direction that matters: the failure mode of guessing is a message to a
 * stranger who never connected.
 */
export function evaluateBranches(input: BranchEvaluationInput): BranchEvaluation {
  const startedAt = input.campaignStartedAt.getTime();
  const nowMs = input.now.getTime();

  const decisions: StepDecision[] = [];
  const outcomes = new Map<string, BranchOutcome>();
  const stepsById = new Map<string, BranchableStep>();

  for (const step of input.steps) {
    const stepId = typeof step.id === 'string' ? step.id.trim() : '';
    const own = rowForStep(step, input.actions);

    // THE FLOOR, AND THE WHOLE OF RULE 2. The declared day, then pushed later
    // -- never earlier -- by the pacing slot the engine actually chose. `max`
    // is the only operator that can appear here.
    const dayFloor = startedAt + Math.max(0, Math.trunc(step.day)) * DAY_MS;
    const paced = instantOf(own?.plannedFor);
    const notBeforeMs = paced === null ? dayFloor : Math.max(dayFloor, paced);
    const notBefore = new Date(notBeforeMs).toISOString();
    const dayReached = nowMs >= notBeforeMs;

    const condition = conditionOf(step);
    let verdict: ConditionVerdict;
    let reason: string;

    if (!condition) {
      verdict = 'satisfied';
      reason = dayReached
        ? `Step '${stepId}' has no condition and its day ${step.day} has arrived.`
        : `Step '${stepId}' has no condition and is waiting for day ${step.day}.`;
    } else {
      const ofStepId = condition.ofStepId.trim();
      const referencedStep = stepsById.get(ofStepId);
      const referencedOutcome = outcomes.get(ofStepId);

      if (!referencedStep) {
        // Unreachable through `conditionRejection`, and fail-closed anyway: a
        // branch nobody can resolve is a branch that does not send.
        verdict = 'failed';
        reason = `Step '${stepId}' waits on step '${ofStepId}', which is not an earlier step in this sequence, so it cannot run.`;
      } else if (referencedOutcome === 'skipped') {
        verdict = 'failed';
        reason = `Step '${stepId}' waits on step '${ofStepId}', which was itself skipped, so its outcome will never arrive.`;
      } else {
        const row = rowForStep(referencedStep, input.actions);
        if (!row) {
          verdict = 'undecided';
          reason = `Step '${stepId}' is waiting: step '${ofStepId}' has not been recorded against this target yet.`;
        } else if (row.status === 'skipped') {
          verdict = 'failed';
          reason = `Step '${stepId}' waits on step '${ofStepId}', which was skipped for this target, so its outcome will never arrive.`;
        } else {
          const positive =
            condition.on === 'accepted' || condition.on === 'not_accepted'
              ? acceptedTri(row.status)
              : repliedTri(row.status);
          const wantsPositive = condition.on === 'accepted' || condition.on === 'replied';
          const verb =
            condition.on === 'accepted' || condition.on === 'not_accepted' ? 'accepted' : 'replied';

          if (wantsPositive) {
            if (positive === 'yes') {
              verdict = 'satisfied';
              reason = dayReached
                ? `Step '${stepId}' runs: step '${ofStepId}' was ${verb} and day ${step.day} has arrived.`
                : `Step '${stepId}' is waiting for day ${step.day}; step '${ofStepId}' was already ${verb}, and a branch never brings a step forward.`;
            } else if (positive === 'no') {
              verdict = 'failed';
              reason = `Step '${stepId}' is skipped: step '${ofStepId}' was not ${verb}, and this step only runs when it was.`;
            } else {
              verdict = 'undecided';
              reason = `Step '${stepId}' is waiting: nobody has ${verb} step '${ofStepId}' yet, and "not yet" is not "no".`;
            }
          } else if (positive === 'yes') {
            verdict = 'failed';
            reason = `Step '${stepId}' is skipped: step '${ofStepId}' was ${verb} after all, so the branch for the other answer does not run.`;
          } else if (positive === 'no') {
            verdict = 'satisfied';
            reason = dayReached
              ? `Step '${stepId}' runs: step '${ofStepId}' was not ${verb} and day ${step.day} has arrived.`
              : `Step '${stepId}' is waiting for day ${step.day}; step '${ofStepId}' was not ${verb}, and a branch never brings a step forward.`;
          } else {
            // THE DEADLINE, and the only place a negative branch can get an
            // answer. "They did not reply" is never true in the abstract --
            // they might reply in an hour -- so the step's own day is the
            // moment the question is asked and answered with what is known.
            // Using the day this way can only ever make a step run LATER than
            // an unconditional one, never earlier, so rule 2 holds.
            verdict = dayReached ? 'satisfied' : 'undecided';
            reason = dayReached
              ? `Step '${stepId}' runs: day ${step.day} has arrived and step '${ofStepId}' has still not been ${verb}.`
              : `Step '${stepId}' is waiting until day ${step.day} to ask whether step '${ofStepId}' was ${verb}; before then "not yet" is not "no".`;
          }
        }
      }
    }

    const outcome: BranchOutcome =
      verdict === 'failed'
        ? 'skipped'
        : verdict === 'undecided'
          ? 'pending'
          : dayReached
            ? 'due'
            : 'pending';

    decisions.push({ stepId, outcome, notBefore, reason });
    if (stepId) {
      outcomes.set(stepId, outcome);
      if (!stepsById.has(stepId)) stepsById.set(stepId, step);
    }
  }

  return {
    targetRef: input.targetRef,
    decisions,
    due: decisions
      .filter((decision) => decision.outcome === 'due')
      .map((decision) => decision.stepId),
    skipped: decisions
      .filter((decision) => decision.outcome === 'skipped')
      .map((decision) => decision.stepId),
    pending: decisions
      .filter((decision) => decision.outcome === 'pending')
      .map((decision) => decision.stepId)
  };
}
