import { z } from 'zod';
import { critique, critiqueToInstructions, type Critique, type CriticOptions } from '../skills/voice.js';
import type { Skill } from '../skills/types.js';
import { ACTION_KIND_VALUES, type LinkedInActionKind } from './actions.js';
import { conditionRejection, stepConditionSchema, type StepCondition } from './branching.js';

/**
 * gtm.linkedin-sequence -- the copy half of the LinkedIn deliverable.
 *
 * `pacing.ts` decides WHEN a seat acts. This decides WHAT it says, and it is
 * deliberately the smaller of the two: the pacing brain is the differentiator
 * (plan 0), the copy is table stakes that every tool in the category ships.
 * What is NOT table stakes is refusing to emit slop, which is why every
 * template here goes through the SAME critic `gtm.draft-reply` uses
 * (`skills/voice.ts`), imported and not forked. A second copy of that gate
 * would drift from the first, and the whole point of a deterministic critic is
 * that two pieces of Trevra copy are held to one standard.
 *
 * Three properties this module holds to:
 *
 * 1. TEMPLATES, NOT MESSAGES. Every step emits a template with `{{variable}}`
 *    placeholders and the list of variables it uses, because the export
 *    formats (Dripify, HeyReach, Expandi) all do their own merge-field
 *    substitution inside the user's own tool. Rendering names here would mean
 *    Trevra shipping N personalised messages instead of one reviewable
 *    campaign, and an approval payload that changes with every target.
 *
 * 2. THE CRITIC RUNS ON THE PLACEHOLDER TEXT. A placeholder is exactly as
 *    generic as the sentence around it, so critiquing pre-merge is the honest
 *    test: a sentence that only becomes specific once `{{company}}` is filled
 *    in was carrying no information the sender had before they looked.
 *
 * 3. A FAILING CRITIQUE IS REPORTED, NEVER SWALLOWED -- same contract as
 *    `outreach/reply.ts` and `channels/prepare.ts`. `antiSlopNotes` is the
 *    report, it reaches the approval payload, and a human decides.
 *
 * NO `Math.random()`. The sequence is a pure function of its input for the
 * same reason `pacing.ts` is: the playbook engine binds an approval to
 * `canonicalPayloadHash(payload)` and fails closed on drift, so a sequence
 * that regenerated differently would invalidate its own approval.
 */

/**
 * A sequence step is a template scheduled at a day offset from campaign start.
 *
 * `day` is an OFFSET, not a date. The offset is what a human reviews and what
 * the export formats' `day_N_message` columns want; the calendar instant comes
 * from `pacing.ts`, which is the only thing that knows the seat's timezone,
 * its warm-up week, and what the ledger says it already did.
 */
export interface SequenceStep {
  /** Stable id, used to attribute an anti-slop note back to the step it came from. */
  id: string;
  /** Days after campaign start. Step 1 is day 0. */
  day: number;
  /** Same taxonomy as `linkedin_actions.kind` -- one vocabulary across the ledger, the plan, and the copy. */
  kind: LinkedInActionKind;
  /** Why this step exists, for the human approving the campaign. */
  intent: string;
  /** The copy, with `{{variable}}` merge fields. Empty for kinds that carry no message. */
  template: string;
  /** Merge fields actually present in `template`, in first-appearance order. */
  variables: string[];
  /** The critic's verdict on this step's template. Null when the step has no copy. */
  critique: Critique | null;
  /**
   * WHETHER this step runs, never when. Null or absent means unconditional,
   * which is what every sequence written before `branching.ts` existed means
   * and what it keeps meaning with no backfill.
   */
  condition?: StepCondition | null;
}

export interface LinkedInSequence {
  steps: SequenceStep[];
  /**
   * Every critic finding across every step, prefixed with the step it belongs
   * to. Empty means every template passed -- it does NOT mean the critic was
   * skipped; `steps[].critique` is always populated for steps with copy.
   */
  antiSlopNotes: string[];
  /** True when every step with copy passed. Carried into the approval payload. */
  antiSlopPassed: boolean;
}

export const icpSchema = z.object({
  /** The job title being written to, e.g. "Head of RevOps". */
  role: z.string().min(1).max(120),
  /** The segment, e.g. "Series A B2B SaaS". */
  segment: z.string().min(1).max(160),
  /**
   * The specific problem, in the ICP's own words where possible. This is the
   * single largest contributor to passing the substitution test: a pain named
   * concretely is a token the critic can find in a sentence.
   */
  pain: z.string().min(1).max(300)
});

export type LinkedInIcp = z.infer<typeof icpSchema>;

export const offerSchema = z.object({
  name: z.string().min(1).max(80),
  /** One line on what it does. */
  summary: z.string().min(1).max(300),
  /**
   * WHY it works, in one sentence -- the mechanism, not the outcome. Same
   * field, same reason, as `outreach/reply.ts`: a claim with no mechanism is
   * the thing that gets ignored.
   */
  mechanism: z.string().min(1).max(300),
  /** Verifiable numbers. A bare number is recipient-specific enough for the critic. */
  proof: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) })).max(6).default([]),
  url: z.string().url().nullish()
});

export type LinkedInOffer = z.infer<typeof offerSchema>;

/**
 * How direct the copy is.
 *
 * Three values, not a free-text style prompt, because the templates are code
 * and a reviewer has to be able to read every branch in a diff.
 */
export type SequenceTone = 'direct' | 'consultative' | 'peer';

export interface SequenceInput {
  icp: LinkedInIcp;
  offer: LinkedInOffer;
  /**
   * Opaque handles or profile URLs. NOTHING per-target reaches the copy: the
   * templates are per-campaign and personalise through merge fields. The list
   * is carried so the sequence and the pacing plan describe the same campaign,
   * and so the step count can be sanity-checked against it.
   */
  targets: readonly string[];
  tone: SequenceTone;
  /** Include the InMail step. Off by default -- it needs a Sales Navigator seat (plan 1.1). */
  includeInMail?: boolean;
  /**
   * Whether the connection request carries a note at all.
   *
   * `none` is a FIRST-CLASS choice, not a degraded draft. A note written
   * before a stranger has accepted anything is the most-read and least-earned
   * sentence in the whole sequence, and a generic one costs acceptance rather
   * than buying it; a bare invite says nothing until there is a thread to say
   * it in. The driver already sends noteless invites (driver.ts `sendInvite`)
   * and the validator already allows an empty invite template -- this is the
   * drafter learning to ASK for that instead of always writing a sentence.
   */
  inviteNote?: 'drafted' | 'none';
  criticOptions?: CriticOptions;
}

/** `{{name}}` merge fields, in first-appearance order, de-duplicated. */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/* -------------------------------------------------------------------------
 * Merge fields.
 *
 * A CLOSED set, and that is the whole point. `extractVariables` will happily
 * parse `{{fistName}}`, and without this list the typo travels all the way to
 * a stranger's inbox as the literal string `{{fistName}}` -- the export step
 * leaves an unmapped placeholder alone (export.ts `applyMergeFields`) rather
 * than blanking it, precisely so a wrong guess is visible in the file. Visible
 * in the file is too late. It is visible HERE instead, as a rejection naming
 * the field, on the write that introduced it.
 *
 * Every name here has a mapping in `export.ts` MERGE_FIELDS for every format.
 * Adding one without adding those mappings is what this comment exists to
 * stop.
 * ---------------------------------------------------------------------- */

export const SUPPORTED_MERGE_FIELDS = ['firstName', 'lastName', 'company', 'jobTitle'] as const;

export type MergeField = (typeof SUPPORTED_MERGE_FIELDS)[number];

export function isSupportedMergeField(name: string): name is MergeField {
  return (SUPPORTED_MERGE_FIELDS as readonly string[]).includes(name);
}

/**
 * The merge-field NAMES as critic evidence.
 *
 * A sentence built around `{{company}}` is specific once merged, and
 * penalising it pre-merge would push the copy toward naming nothing at all.
 * `role` is carried alongside the supported names because sequences written
 * before `jobTitle` existed used it, and dropping it would retroactively make
 * their critiques stricter than the ones a human already read.
 */
export const MERGE_FIELD_EVIDENCE = [...SUPPORTED_MERGE_FIELDS, 'role'].join(' ');

/* -------------------------------------------------------------------------
 * A sequence is DATA.
 *
 * `buildSequence` is the default draft, not the only possible shape. What an
 * operator assembles by hand, what a template ships, and what the AI drafts
 * are the same thing -- an ordered list of steps -- and they all arrive here,
 * at one validator and one critic pass. The rules below were implicit in
 * `buildSequence`'s hardcoded skeleton; a hardcoded skeleton stops being an
 * enforcement the moment the list becomes editable, so they are written out.
 * ---------------------------------------------------------------------- */

/** A step as an operator, a template, or an edit supplies it: copy, no verdict. */
export interface SequenceStepInput {
  id: string;
  day: number;
  kind: LinkedInActionKind;
  intent?: string;
  template?: string;
  /** A branch on an EARLIER step's outcome. Absent or null means unconditional. */
  condition?: StepCondition | null;
}

/** A refusal an operator caused. Routes answer it as a 400 with the message verbatim. */
export class SequenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceValidationError';
  }
}

/** Kinds whose entire purpose is the message. An empty one is a step that does nothing. */
const KINDS_REQUIRING_COPY: readonly LinkedInActionKind[] = ['dm', 'inmail'];

/**
 * Every rule a stored sequence has to hold, checked in list order.
 *
 * Throws on the FIRST offending step and names it, rather than collecting
 * every problem: this is an editor round-trip, not a batch import, and an
 * operator fixes one line at a time. (`guard.ts` collects all its blockers
 * because there the operator cannot fix anything -- the seat is what it is.)
 */
export function validateSequenceSteps(steps: readonly SequenceStepInput[]): void {
  if (steps.length === 0) {
    throw new SequenceValidationError('A sequence needs at least one step; an empty sequence would export an empty campaign.');
  }

  const seen = new Set<string>();
  let previousDay = 0;
  let invites = 0;

  for (const step of steps) {
    const stepId = typeof step.id === 'string' ? step.id.trim() : '';
    if (!stepId) {
      throw new SequenceValidationError('Every step needs a non-empty id, because an anti-slop note is attributed back to the step it came from.');
    }
    if (seen.has(stepId)) {
      throw new SequenceValidationError(`Step '${stepId}' repeats a step id already used earlier in this sequence, and an id has to identify exactly one step.`);
    }
    seen.add(stepId);

    if (!Number.isInteger(step.day) || step.day < 0) {
      throw new SequenceValidationError(`Step '${stepId}' has day ${String(step.day)}; a day is a whole number of days after the campaign starts, so it cannot be negative.`);
    }
    if (step.day < previousDay) {
      throw new SequenceValidationError(`Step '${stepId}' is on day ${step.day}, before the step above it on day ${previousDay}; a sequence is read and sent in list order, so its days cannot go backwards.`);
    }
    previousDay = step.day;

    const template = step.template ?? '';

    if (step.kind === 'profile_view') {
      if (template.trim().length > 0) {
        throw new SequenceValidationError(`Step '${stepId}' is a profile view, which carries no message, so the copy on it would never be sent anywhere.`);
      }
    }

    if (step.kind === 'invite') {
      invites += 1;
      if (invites > 1) {
        throw new SequenceValidationError(`Step '${stepId}' is a second connection request, and a person can only be invited once.`);
      }
      if (template.length > INVITE_NOTE_MAX_CHARS) {
        throw new SequenceValidationError(`Step '${stepId}' has a ${template.length}-character invite note; LinkedIn truncates connection notes at ${INVITE_NOTE_MAX_CHARS}, so shorten it rather than let the platform cut it mid-sentence.`);
      }
    }

    if (KINDS_REQUIRING_COPY.includes(step.kind) && template.trim().length === 0) {
      throw new SequenceValidationError(`Step '${stepId}' is a ${step.kind} with no message, and a ${step.kind} is nothing but its message.`);
    }

    for (const variable of extractVariables(template)) {
      if (!isSupportedMergeField(variable)) {
        throw new SequenceValidationError(
          `Step '${stepId}' uses the merge field {{${variable}}}, which Trevra cannot fill, so it would be sent to a human exactly as written; the supported fields are ${SUPPORTED_MERGE_FIELDS.map((field) => `{{${field}}}`).join(', ')}.`
        );
      }
    }
  }

  /**
   * The branch rules, in a SECOND PASS, after the loop.
   *
   * Every rule above is a property of one step and can be decided the moment
   * that step is read. Not one branch rule can: "waits on an earlier step",
   * "waits on an invite", "is not part of a loop" are all statements about the
   * whole list, and checking them inside the loop would mean deciding them
   * against a list that is still half-read. `conditionRejection` walks the list
   * itself and returns the first offence as a sentence; this turns it into the
   * same `SequenceValidationError` every other rule here throws, which `app.ts`
   * already maps to a 400 with the message verbatim.
   */
  const rejection = conditionRejection(steps);
  if (rejection) throw new SequenceValidationError(rejection);
}

interface StepDraft {
  id: string;
  day: number;
  kind: LinkedInActionKind;
  intent: string;
  template: string;
  /** Carried through the critic untouched: a branch is not copy and has nothing to critique. */
  condition?: StepCondition | null;
}

/** The critic pass, shared by the default draft and by every hand-written sequence. */
function critiqueSteps(
  drafts: readonly StepDraft[],
  evidence: readonly string[],
  options: CriticOptions
): { steps: SequenceStep[]; antiSlopNotes: string[] } {
  const antiSlopNotes: string[] = [];
  const steps: SequenceStep[] = drafts.map((draft) => {
    const verdict = draft.template.trim().length > 0 ? critique(draft.template, [...evidence], options) : null;
    if (verdict) {
      const instructions = critiqueToInstructions(verdict);
      if (instructions) {
        for (const line of instructions.split('\n')) antiSlopNotes.push(`${draft.id} (day ${draft.day}): ${line.replace(/^- /, '')}`);
      }
    }
    return {
      id: draft.id,
      day: draft.day,
      kind: draft.kind,
      intent: draft.intent,
      template: draft.template,
      variables: extractVariables(draft.template),
      critique: verdict,
      // Omitted rather than nulled when there is none, so a sequence with no
      // branches hashes exactly as it did before this field existed -- the
      // approval payload binds `canonicalPayloadHash`, and a new key with a
      // null value would retire every approval in flight.
      ...(draft.condition ? { condition: draft.condition } : {})
    };
  });
  return { steps, antiSlopNotes };
}

export interface SequenceFromStepsOptions {
  /** Operator-supplied facts the critic may count as specific. Usually `sequenceEvidence(brief)`. */
  evidence?: readonly string[];
  criticOptions?: CriticOptions;
}

/**
 * Turn an explicit step list into a sequence: validate it, then critique it.
 *
 * The critic runs on hand-written copy for exactly the reason it runs on
 * drafted copy -- a human writing to a list is no more immune to a banned
 * phrase than a generator is -- and its verdict is REPORTED, never fatal.
 * Validation is the opposite: those failures are structural, the operator can
 * fix every one of them, and storing a sequence that breaks them would export
 * a campaign LinkedIn silently mangles.
 */
export function sequenceFromSteps(steps: readonly SequenceStepInput[], options: SequenceFromStepsOptions = {}): LinkedInSequence {
  validateSequenceSteps(steps);
  const evidence = [...(options.evidence ?? []), MERGE_FIELD_EVIDENCE].filter((value) => value.trim().length > 0);
  const drafts: StepDraft[] = steps.map((step) => ({
    id: step.id.trim(),
    day: step.day,
    kind: step.kind,
    intent: step.intent ?? '',
    template: step.template ?? '',
    ...(step.condition ? { condition: step.condition } : {})
  }));
  const { steps: critiqued, antiSlopNotes } = critiqueSteps(drafts, evidence, options.criticOptions ?? {});
  return {
    steps: critiqued,
    antiSlopNotes,
    antiSlopPassed: critiqued.every((step) => step.critique === null || step.critique.passed)
  };
}

/**
 * What the critic is allowed to count as specific.
 *
 * The ICP's pain, the segment, the offer's mechanism and its proof labels --
 * every fact the operator supplied. The merge-field NAMES are included too
 * (`firstName`, `company`), because a sentence built around `{{company}}` will
 * be specific after the merge and penalising it pre-merge would push the copy
 * toward naming nothing at all.
 */
export function sequenceEvidence(input: Pick<SequenceInput, 'icp' | 'offer'>): string[] {
  return [
    input.icp.role,
    input.icp.segment,
    input.icp.pain,
    input.offer.name,
    input.offer.summary,
    input.offer.mechanism,
    input.offer.url ?? '',
    ...input.offer.proof.flatMap((claim) => [claim.label, claim.value]),
    MERGE_FIELD_EVIDENCE
  ].filter((value) => value.trim().length > 0);
}

function proofLine(offer: LinkedInOffer): string {
  const first = offer.proof[0];
  return first ? `${first.label}: ${first.value}.` : '';
}

/**
 * The invite note.
 *
 * Kept short on purpose and NOT because of a style preference: LinkedIn caps a
 * connection-request note at 300 characters, so anything longer is truncated
 * by the platform rather than by us. `buildSequence` asserts the ceiling.
 */
export const INVITE_NOTE_MAX_CHARS = 300;

function inviteNote(input: SequenceInput): string {
  const { icp, offer } = input;
  if (input.tone === 'direct') {
    return `{{firstName}} -- ${icp.pain} is the part of ${icp.segment} I keep hearing about. ${offer.name} handles it: ${offer.mechanism}`;
  }
  if (input.tone === 'peer') {
    return `{{firstName}}, {{company}} is the kind of ${icp.segment} where ${icp.pain} shows up early. ${offer.mechanism}`;
  }
  return `{{firstName}} -- most ${icp.role}s in ${icp.segment} hit ${icp.pain}. ${offer.mechanism}`;
}

function firstMessage(input: SequenceInput): string {
  const { icp, offer } = input;
  const proof = proofLine(offer);
  const link = offer.url ? `\n\n${offer.url}` : '';
  if (input.tone === 'direct') {
    return `Thanks for connecting, {{firstName}}. ${icp.pain} at {{company}} is what ${offer.name} was built for -- ${offer.mechanism} ${proof}${link}`.trim();
  }
  if (input.tone === 'peer') {
    return `{{firstName}} -- when ${icp.pain} came up for me, ${offer.mechanism} ${proof} That is ${offer.summary}${link}`.trim();
  }
  return `{{firstName}}, on ${icp.pain}: ${offer.mechanism} ${proof} ${offer.summary}${link}`.trim();
}

function proofMessage(input: SequenceInput): string {
  const { icp, offer } = input;
  const second = offer.proof[1] ?? offer.proof[0];
  const numbers = second ? `${second.label} moved to ${second.value}.` : `${offer.mechanism}`;
  return `{{firstName}} -- the number that matters for ${icp.pain}: ${numbers} Worth a look for {{company}}?`;
}

/**
 * The last step, and the only one that asks nothing.
 *
 * A final message with a question in it is a fourth ask on somebody who has
 * answered none of the first three. Closing the loop without one is both
 * better manners and better copy, and it is why the critic's `multiple-asks`
 * check never fires on this sequence as a whole.
 */
function closeMessage(input: SequenceInput): string {
  const { icp, offer } = input;
  return `{{firstName}}, closing the loop on ${icp.pain} -- I will leave it here. ${offer.name} is at ${offer.url ?? offer.summary} whenever {{company}} looks at it.`;
}

function inMailMessage(input: SequenceInput): string {
  const { icp, offer } = input;
  return `{{firstName}} -- ${icp.pain} is what ${offer.name} exists for. ${offer.mechanism} ${proofLine(offer)}`.trim();
}

/**
 * The step skeleton, and why these days.
 *
 * Day 0 profile view, day 1 invite, day 3 first message, day 7 proof, day 14
 * close. The gaps are wide because the pacing engine has to fit every target
 * into per-day ceilings (limits.ts) -- a sequence with steps on consecutive
 * days multiplies a campaign's daily action count by the number of live steps,
 * which is the fastest way to breach a ceiling that every individual step
 * respected.
 *
 * The day-0 profile view carries no copy. It exists because 1.4 gives it its
 * own generous ceiling and it is the cheapest signal that precedes an invite.
 */
export function buildSequence(input: SequenceInput): LinkedInSequence {
  const evidence = sequenceEvidence(input);
  const options = input.criticOptions ?? {};

  const drafts: StepDraft[] = [
    {
      id: 'view',
      day: 0,
      kind: 'profile_view',
      intent: 'Show up in their "who viewed your profile" before the invite lands. No copy.',
      template: ''
    },
    input.inviteNote === 'none'
      ? {
        id: 'invite',
        day: 1,
        kind: 'invite',
        intent: 'Connection request with no note. Nothing is claimed before they have accepted anything.',
        template: ''
      }
      : {
        id: 'invite',
        day: 1,
        kind: 'invite',
        intent: 'Connection request with a note naming the pain, not the sender.',
        template: inviteNote(input)
      },
    {
      id: 'message-1',
      day: 3,
      kind: 'dm',
      intent: 'First message after acceptance: the mechanism and one number.',
      template: firstMessage(input)
    },
    {
      id: 'message-2',
      day: 7,
      kind: 'dm',
      intent: 'The proof step. One number, one question, nothing else.',
      template: proofMessage(input)
    },
    {
      id: 'close',
      day: 14,
      kind: 'dm',
      intent: 'Close the loop. No ask, so the thread ends cleanly either way.',
      template: closeMessage(input)
    }
  ];

  if (input.includeInMail) {
    drafts.splice(2, 0, {
      id: 'inmail',
      day: 2,
      kind: 'inmail',
      intent: 'Sales Navigator InMail for targets who did not accept. Counts against the published 50/month quota.',
      template: inMailMessage(input)
    });
  }

  const { steps, antiSlopNotes } = critiqueSteps(drafts, evidence, options);

  // The platform's own ceiling, REPORTED here rather than rejected, because
  // this is the DRAFT path: a note cut at 300 chars mid-sentence is worse than
  // one a human shortened, and nobody has read this copy yet. The write path
  // (`sequenceFromSteps`) refuses the same overflow outright -- by then a human
  // has read it and chosen to keep it.
  for (const step of steps) {
    if (step.kind === 'invite' && step.template.length > INVITE_NOTE_MAX_CHARS) {
      antiSlopNotes.push(
        `${step.id} (day ${step.day}): invite note is ${step.template.length} characters; LinkedIn truncates connection notes at ${INVITE_NOTE_MAX_CHARS}. Shorten the pain or the mechanism.`
      );
    }
  }

  return {
    steps,
    antiSlopNotes,
    antiSlopPassed: steps.every((step) => step.critique === null || step.critique.passed)
  };
}

const critiqueSchema = z.object({
  passed: z.boolean(),
  wordCount: z.number(),
  genericRatio: z.number(),
  findings: z.array(
    z.object({
      check: z.string(),
      severity: z.enum(['block', 'warn']),
      detail: z.string(),
      excerpt: z.string().optional()
    })
  )
});

/** A step as it arrives from a template, an editor, or a `steps` override. */
export const sequenceStepInputSchema = z.object({
  id: z.string().trim().min(1).max(64),
  day: z.number().int().min(0).max(365),
  kind: z.enum(ACTION_KIND_VALUES),
  intent: z.string().max(500).default(''),
  template: z.string().max(4000).default(''),
  /**
   * `nullish` and not `optional`: an editor that clears a branch sends null,
   * and a stored sequence that never had one sends nothing. Both mean
   * unconditional, and refusing either would make "remove this branch" a
   * 400. What the VALUES may be is `branching.ts`'s to say.
   */
  condition: stepConditionSchema.nullish()
});

/** A sequence has at most this many steps. Past it, nobody reviews the copy they approve. */
export const MAX_SEQUENCE_STEPS = 25;

/**
 * The whole ordered list, as every caller that accepts a sequence receives it.
 *
 * ONE DECLARATION, and it is the only one. `POST /api/linkedin/campaigns`,
 * `PATCH /api/linkedin/campaigns/:id/sequence` and the `gtm.linkedin-sequence`
 * skill are three doors into the same list, and app.ts used to hold its own
 * hand-copied version of this object. That copy was not a style problem: it
 * had no `condition` field, so both campaign routes silently STRIPPED every
 * branch an operator wrote, and the campaign that came back looked fine
 * because a stripped branch is a valid unconditional step. A schema that
 * exists once cannot do that.
 */
export const sequenceStepsSchema = z.array(sequenceStepInputSchema).min(1).max(MAX_SEQUENCE_STEPS);

/**
 * TWO WAYS IN, ONE WAY OUT.
 *
 * `steps` supplied -> critique exactly those, in that order. That is a
 * template, an operator's edit, or a sequence assembled node by node.
 * `steps` absent -> draft the default five-touch shape from the brief.
 *
 * When BOTH arrive, `steps` wins and the brief becomes critic EVIDENCE: an
 * operator who edited the copy did not ask for it to be regenerated, but the
 * facts they gave are still the facts the copy is measured against.
 *
 * `targets` no longer requires at least one entry, because a DRAFT has no
 * target list yet -- that is the point of drafting from a domain. The campaign
 * playbook still requires one, which is the layer where an empty list actually
 * means something is wrong.
 */
const inputSchema = z
  .object({
    steps: sequenceStepsSchema.optional(),
    icp: icpSchema.optional(),
    offer: offerSchema.optional(),
    /** Opaque handles or profile URLs, matching `gtm.linkedin-pace`'s ceiling. */
    targets: z.array(z.string().min(1).max(500)).max(500).default([]),
    tone: z.enum(['direct', 'consultative', 'peer']).default('consultative'),
    includeInMail: z.boolean().default(false),
    /** `none` drafts a bare connection request. Defaults to a note, which is what every campaign before this got. */
    inviteNote: z.enum(['drafted', 'none']).default('drafted'),
    criticOptions: z
      .object({
        maxWords: z.number().int().positive().optional(),
        maxGenericRatio: z.number().min(0).max(1).optional(),
        maxWarnings: z.number().int().min(0).optional(),
        maxAdverbsPer100: z.number().min(0).optional()
      })
      .optional()
  })
  .refine((value) => Boolean(value.steps) || (Boolean(value.icp) && Boolean(value.offer)), {
    message: 'Provide steps to critique, or an icp and an offer to draft the default sequence from'
  });

const outputSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      day: z.number().int().min(0),
      kind: z.enum(ACTION_KIND_VALUES),
      intent: z.string(),
      template: z.string(),
      variables: z.array(z.string()),
      critique: critiqueSchema.nullable(),
      // Carried OUT as well as in: the approval payload is built from this
      // output, so a branch that survived validation and then vanished from
      // the schema would be a campaign approved without the condition its
      // author wrote.
      condition: stepConditionSchema.nullish()
    })
  ),
  antiSlopNotes: z.array(z.string()),
  antiSlopPassed: z.boolean()
});

type SequenceSkillInput = z.infer<typeof inputSchema>;

export const linkedinSequenceSkill: Skill<SequenceSkillInput, LinkedInSequence> = {
  manifest: {
    id: 'gtm.linkedin-sequence',
    name: 'LinkedIn outreach sequence',
    version: '1.0.0',
    description:
      'Write or critique a multi-touch LinkedIn sequence as merge-field templates. Given a step list it validates and critiques exactly that list; given an ICP and offer it drafts the default five-touch shape. Either way every template goes through the same anti-slop critic as gtm.draft-reply, and a failed critique is reported rather than passed through.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    const criticOptions = input.criticOptions === undefined ? {} : { criticOptions: input.criticOptions };

    if (input.steps) {
      const evidence = input.icp && input.offer ? sequenceEvidence({ icp: input.icp, offer: input.offer }) : [];
      return sequenceFromSteps(input.steps, { evidence, ...criticOptions });
    }

    // Unreachable through the schema's refinement; kept because an assertion
    // here would be a lie the type system cannot check at the call site.
    if (!input.icp || !input.offer) {
      throw new SequenceValidationError('Drafting a sequence needs an icp and an offer; supply steps instead to critique copy you already have.');
    }

    return buildSequence({
      icp: input.icp,
      offer: input.offer,
      targets: input.targets,
      tone: input.tone,
      includeInMail: input.includeInMail,
      inviteNote: input.inviteNote,
      ...criticOptions
    });
  }
};
