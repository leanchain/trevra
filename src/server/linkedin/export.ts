import { z } from 'zod';
import type { Db } from '../db.js';
import { ACTION_KIND_VALUES, recordAction, type LinkedInActionKind } from './actions.js';
import { conditionOf, stepConditionSchema, type BranchableStep } from './branching.js';
import { MAX_DAY_OVER_DAY_DELTA, MIN_ACCEPTANCE_RATE, PACED_KIND_VALUES, WARMUP_WEEKS } from './limits.js';
import { localDateOf, type PacingPlan } from './pacing.js';
import { OWNER_SEAT_KEY, getSeat, warmupWeekOf } from './seats.js';
import type { LinkedInSequence } from './sequence.js';

/**
 * The deliverable: a campaign file the operator runs in THEIR OWN tool.
 *
 * This is where the architecture decision in plan 3 becomes a file on disk.
 * Trevra plans, paces, writes and gates; the sending arm is Dripify, HeyReach
 * or Expandi, driven by the operator, in their account, under their ToS
 * relationship. Nothing in this module talks to LinkedIn, and every export
 * says so in its own first lines -- see `HEADER_OWNERSHIP`.
 *
 * TWO THINGS THIS MODULE DOES THAT ARE NOT OBVIOUS:
 *
 * 1. IT WRITES THE LEDGER. An export that only produced bytes would leave
 *    `linkedin_actions` empty, and the pacing engine's day-over-day arithmetic
 *    is computed FROM that table (`actions.ts` `dailyCountsForLastNDays`). A
 *    campaign exported and never recorded is a campaign the next plan cannot
 *    see, so the next plan would ramp from zero while the operator was already
 *    at eighteen a day -- the exact "slide and spike" shape (plan 1.3) this
 *    system exists to prevent. Recording is therefore part of exporting, not a
 *    follow-up step somebody might skip.
 *
 * 2. IT RECORDS `recorded_at = plannedFor`, NOT `now`. `recordAction` defaults
 *    a counted status to the current instant, which is right for something
 *    that just happened and wrong for a fourteen-day plan handed over in one
 *    go: dating 200 slots "now" would make every rolling window believe the
 *    seat did 200 invites this afternoon and would block the seat outright.
 *    Dating each row at the slot it belongs to is what makes the ledger
 *    describe the campaign as it actually unfolds -- future slots simply do
 *    not count yet, because `dailyCountsForLastNDays` bounds on
 *    `recorded_at <= now`.
 *
 * On merge fields: each tool has its own placeholder vocabulary, so the
 * templates' `{{firstName}}` is rewritten per format on the way out. Those
 * mappings are REPORTED, not verified against a paid account -- an operator
 * whose tool expects a different token has one table to correct, in one place.
 */

export type ExportFormat = 'dripify' | 'heyreach' | 'expandi' | 'generic';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['dripify', 'heyreach', 'expandi', 'generic'];

/**
 * What the operator knows about one target.
 *
 * Every field is optional except the key, because `target_ref` is opaque by
 * design (plan 1.2 -- Trevra never resolves a LinkedIn profile) and the name
 * and company can only come from the operator's own list.
 */
export interface ExportContact {
  /** Must equal a `PacingSlot.targetRef`; that is how a row finds its schedule. */
  targetRef: string;
  profileUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  role?: string | null;
}

export interface CampaignExportInput {
  workspaceId: string;
  plan: PacingPlan;
  sequence: LinkedInSequence;
  format: ExportFormat;
  /** Keyed by `targetRef`. Targets with no entry export with empty name columns. */
  contacts?: readonly ExportContact[];
  /** Groups the ledger rows so an operator can retire one campaign without touching another. */
  campaignId?: string | null;
  /** The approved payload's hash, carried onto every ledger row for the audit trail. */
  payloadHash?: string | null;
}

/** One day of the plan, in the seat's own timezone. */
export interface ScheduledDay {
  /** 'YYYY-MM-DD', seat-local. */
  date: string;
  count: number;
  kinds: LinkedInActionKind[];
}

export interface CampaignExport {
  format: ExportFormat;
  filename: string;
  contentType: string;
  /** The provenance and ownership preamble, verbatim, also embedded in `content`. */
  headerBlock: string;
  /** The format payload alone, for a caller that wants to feed a parser directly. */
  body: string;
  /** What the operator downloads: header block followed by the payload. */
  content: string;
  schedule: ScheduledDay[];
  ceilingsApplied: string[];
  warmupWeek: number;
  timezone: string;
  /** Ledger outcome. `duplicate` is a target this seat had already been given an action of this kind for. */
  recorded: { attempted: number; written: number; duplicate: number };
}

/* -------------------------------------------------------------------------
 * RFC4180.
 *
 * Hand-rolled because the project depends on `csv-parse` and NOT on
 * `csv-stringify` -- there is no writer in the tree, and pulling a dependency
 * for eleven lines is worse than owning them. The rules, in full: quote a
 * field that contains a comma, a double quote, CR or LF; escape a double quote
 * by doubling it; separate records with CRLF.
 *
 * Company names are exactly where this bites. `Acme, Inc.` and
 * `The "Good" Company` are ordinary LinkedIn company names, and a naive
 * `values.join(',')` shifts every column right of them on import -- silently,
 * so the first sign of it is a message addressed to the wrong person.
 * ---------------------------------------------------------------------- */

const CRLF = '\r\n';

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(',');
}

export function csvDocument(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join(CRLF) + CRLF;
}

/* -------------------------------------------------------------------------
 * Merge fields.
 * ---------------------------------------------------------------------- */

/**
 * Trevra's placeholder name -> the destination tool's. REPORTED: taken from
 * each tool's documented personalisation tokens, not verified against a paid
 * account. An unmapped variable is left as written rather than dropped, so a
 * wrong guess is visible in the file instead of silently blanking a name.
 *
 * `jobTitle` is the supported name (sequence.ts `SUPPORTED_MERGE_FIELDS`);
 * `role` is its predecessor and stays mapped to the same destination token,
 * because sequences approved before the rename are still in the ledger and an
 * unmapped placeholder in one of them would reach a human as `{{role}}`.
 */
const MERGE_FIELDS: Record<ExportFormat, Readonly<Record<string, string>>> = {
  dripify: { firstName: 'first_name', lastName: 'last_name', company: 'company_name', jobTitle: 'job_title', role: 'job_title' },
  heyreach: { firstName: 'firstName', lastName: 'lastName', company: 'companyName', jobTitle: 'position', role: 'position' },
  expandi: { firstName: 'first_name', lastName: 'last_name', company: 'company_name', jobTitle: 'occupation', role: 'occupation' },
  generic: {}
};

export function applyMergeFields(template: string, format: ExportFormat): string {
  const mapping = MERGE_FIELDS[format];
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    mapping[name] ? `{{${mapping[name]}}}` : whole
  );
}

/* -------------------------------------------------------------------------
 * Branches, in an export that cannot resolve one.
 * ---------------------------------------------------------------------- */

/**
 * A step's condition as an instruction to the human running the file.
 *
 * AN EXPORT CANNOT EVALUATE A BRANCH, and pretending otherwise is the failure
 * this function exists to prevent. `exportCampaign` writes a ledger row per
 * slot UP FRONT, at a moment when every branch in the sequence is still
 * undecidable -- the invite it depends on has not been sent, let alone
 * answered. There is no instant at which the exporter could ask
 * `evaluateBranches` and get anything but `pending`.
 *
 * So the two things it must not do are: emit the conditional step as an
 * ordinary unconditional slot (which sends "thanks for connecting" to somebody
 * who never connected -- the exact wrong send `branching.ts` rule 3 is about),
 * or drop it (which silently deletes an arm the operator wrote and approved).
 * It does the third thing: it hands the condition to the person who CAN
 * resolve it, in their own file, in words, attached to the row it governs.
 *
 * Dripify, HeyReach and Expandi all have their own branching UIs. This is the
 * text an operator uses to set that up, not a Trevra feature pretending to run
 * inside somebody else's tool.
 */
export function conditionInstruction(step: BranchableStep): string | null {
  const condition = conditionOf(step);
  if (!condition) return null;
  const of = condition.ofStepId.trim();
  switch (condition.on) {
    case 'accepted':
      return `ONLY IF step '${of}' was accepted. Skip this step for anyone who has not accepted by day ${step.day}.`;
    case 'replied':
      return `ONLY IF step '${of}' was replied to. Skip this step for anyone who has not replied by day ${step.day}.`;
    case 'not_accepted':
      return `ONLY IF step '${of}' has NOT been accepted by day ${step.day}. Skip this step for anyone who accepted.`;
    case 'not_replied':
      return `ONLY IF step '${of}' has NOT been replied to by day ${step.day}. Skip this step for anyone who replied.`;
    default:
      return null;
  }
}

/** The instruction folded into the copy itself, for a format with nowhere else to put it. */
function withCondition(step: LinkedInSequence['steps'][number], text: string): string {
  const instruction = conditionInstruction(step);
  return instruction ? `[${instruction}] ${text}` : text;
}

/* -------------------------------------------------------------------------
 * The header block.
 * ---------------------------------------------------------------------- */

/**
 * The sentence this whole architecture rests on. Present in every export, in
 * every format, and not configurable: the file is executed by a human in an
 * account Trevra has no credential for, and the contractual relationship with
 * LinkedIn (plan 1.2, User Agreement 8.2) is theirs. A campaign file that did
 * not say so would be the one place the product misrepresented itself.
 */
export const HEADER_OWNERSHIP =
  'You execute this campaign in your own LinkedIn account, using your own tool. Trevra never connects to LinkedIn and owns no part of your ToS relationship with it.';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Group the plan's slots into seat-local days. */
export function scheduleOf(plan: PacingPlan, timezone: string): ScheduledDay[] {
  const days = new Map<string, { count: number; kinds: Set<LinkedInActionKind> }>();
  for (const slot of plan.slots) {
    const local = localDateOf(new Date(slot.plannedFor), timezone);
    const key = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
    const bucket = days.get(key) ?? { count: 0, kinds: new Set<LinkedInActionKind>() };
    bucket.count += 1;
    bucket.kinds.add(slot.kind);
    days.set(key, bucket);
  }
  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, bucket]) => ({ date, count: bucket.count, kinds: [...bucket.kinds].sort() }));
}

interface HeaderContext {
  plan: PacingPlan;
  sequence: LinkedInSequence;
  schedule: ScheduledDay[];
  warmupWeek: number;
  timezone: string;
  campaignId: string | null;
  generatedAt: string;
}

/**
 * The four things every export must state (plan 4, Phase 3): the pacing
 * schedule, the ceilings that were applied, the warm-up week, and who owns the
 * ToS relationship. Returned as plain lines; each format decides how to
 * comment them.
 */
export function headerLines(context: HeaderContext): string[] {
  const { plan, sequence, schedule, warmupWeek } = context;
  const total = schedule.reduce((sum, day) => sum + day.count, 0);
  const lines: string[] = [
    'Trevra LinkedIn campaign export',
    `Generated: ${context.generatedAt}`,
    `Seat: ${plan.seatKey}   Timezone: ${context.timezone}` + (context.campaignId ? `   Campaign: ${context.campaignId}` : ''),
    '',
    HEADER_OWNERSHIP,
    '',
    warmupWeek <= WARMUP_WEEKS
      ? `Warm-up week ${warmupWeek} of ${WARMUP_WEEKS}. Volume is deliberately below this seat's ceiling until the ramp completes; overriding it in your own tool is what the ramp exists to prevent.`
      : `Warm-up week ${warmupWeek}: past the ${WARMUP_WEEKS}-week ramp, so this seat is paced at its steady band.`,
    '',
    `Pacing schedule -- ${total} action(s) across ${schedule.length} day(s). Send exactly these counts on these dates, in ${context.timezone}:`
  ];

  for (const day of schedule) lines.push(`  ${day.date}  ${String(day.count).padStart(3)}  ${day.kinds.join(', ')}`);

  lines.push('');
  lines.push(
    plan.ceilingsApplied.length > 0
      ? `Ceilings applied: ${plan.ceilingsApplied.join(', ')}`
      : 'Ceilings applied: none -- every day fitted under this seat\'s bands without clamping.'
  );
  for (const reason of plan.reasons) lines.push(`  - ${reason}`);

  const branched = sequence.steps.filter((step) => conditionInstruction(step) !== null);
  if (branched.length > 0) {
    lines.push('');
    lines.push(
      `CONDITIONAL STEPS -- ${branched.length} of ${sequence.steps.length} step(s) in this campaign do not run for everyone.`
    );
    lines.push(
      'Trevra cannot resolve these here. The file is written before the first invite goes out, so no branch in it has an answer yet, and every row below is scheduled as if its condition held. Set these conditions up in your own tool, or work the list by hand -- an unconditional send of a conditional step is a message to somebody who never connected.'
    );
    for (const step of branched) lines.push(`  day ${step.day} ${step.kind} (${step.id}): ${conditionInstruction(step)}`);
  }

  lines.push('');
  lines.push(
    `Do not compress this into fewer days. A day-over-day change above ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}% is what the schedule is built to avoid, and sustained invite acceptance below ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}% reads as spam regardless of volume.`
  );
  lines.push('These numbers are practitioner-REPORTED, not published by LinkedIn. They are defaults with provenance, never a guarantee.');

  if (sequence.antiSlopNotes.length > 0) {
    lines.push('');
    lines.push('Copy review -- the anti-slop critic flagged the following. Edit before sending:');
    for (const note of sequence.antiSlopNotes) lines.push(`  - ${note}`);
  }

  return lines;
}

function commentBlock(lines: readonly string[], eol: string): string {
  return lines.map((line) => (line.length > 0 ? `# ${line}` : '#')).join(eol) + eol;
}

/* -------------------------------------------------------------------------
 * Formats.
 * ---------------------------------------------------------------------- */

/** Targets in plan order, de-duplicated: a target with three slots is one CSV row. */
function orderedTargets(plan: PacingPlan): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const slot of plan.slots) {
    if (seen.has(slot.targetRef)) continue;
    seen.add(slot.targetRef);
    targets.push(slot.targetRef);
  }
  return targets;
}

/** The invite step -- the one whose copy becomes the connection-request note. */
function inviteStep(sequence: LinkedInSequence) {
  return sequence.steps.find((step) => step.kind === 'invite' && step.template.trim().length > 0);
}

/** Steps that carry a message after the invite, oldest day first. */
function messageSteps(sequence: LinkedInSequence) {
  return sequence.steps
    .filter((step) => step.kind !== 'invite' && step.template.trim().length > 0)
    .sort((a, b) => a.day - b.day);
}

function contactRow(contact: ExportContact | undefined, targetRef: string): { profileUrl: string; firstName: string; lastName: string; company: string } {
  return {
    profileUrl: contact?.profileUrl?.trim() || targetRef,
    firstName: contact?.firstName?.trim() ?? '',
    lastName: contact?.lastName?.trim() ?? '',
    company: contact?.company?.trim() ?? ''
  };
}

function renderDripify(input: CampaignExportInput, contacts: Map<string, ExportContact>): string {
  const invite = inviteStep(input.sequence);
  const messages = messageSteps(input.sequence);
  const header = [
    'profile_url',
    'first_name',
    'last_name',
    'company',
    'note',
    ...messages.map((step) => `day_${step.day}_message`)
  ];
  const rows: string[][] = [header];
  for (const targetRef of orderedTargets(input.plan)) {
    const contact = contactRow(contacts.get(targetRef), targetRef);
    rows.push([
      contact.profileUrl,
      contact.firstName,
      contact.lastName,
      contact.company,
      invite ? withCondition(invite, applyMergeFields(invite.template, 'dripify')) : '',
      ...messages.map((step) => withCondition(step, applyMergeFields(step.template, 'dripify')))
    ]);
  }
  return csvDocument(rows);
}

function renderExpandi(input: CampaignExportInput, contacts: Map<string, ExportContact>): string {
  const invite = inviteStep(input.sequence);
  const messages = messageSteps(input.sequence);
  const header = [
    'profile_link',
    'first_name',
    'last_name',
    'company_name',
    'invite_note',
    ...messages.map((_step, index) => `followup_${index + 1}`)
  ];
  const rows: string[][] = [header];
  for (const targetRef of orderedTargets(input.plan)) {
    const contact = contactRow(contacts.get(targetRef), targetRef);
    rows.push([
      contact.profileUrl,
      contact.firstName,
      contact.lastName,
      contact.company,
      invite ? withCondition(invite, applyMergeFields(invite.template, 'expandi')) : '',
      ...messages.map((step) => withCondition(step, applyMergeFields(step.template, 'expandi')))
    ]);
  }
  return csvDocument(rows);
}

/**
 * HeyReach is JSON, and the other two are CSV, on purpose.
 *
 * HeyReach is one of only two tools in the category with a real API (plan 5),
 * so its import shape is structured rather than a flat sheet, and a sequence
 * with per-step delays does not fit one row per lead without inventing column
 * names. Guessing a CSV header for it would produce a file that imports
 * cleanly and means the wrong thing; JSON keeps the steps as steps and puts
 * the header block in a field a parser will not choke on.
 */
function renderHeyReach(input: CampaignExportInput, contacts: Map<string, ExportContact>, header: readonly string[], context: HeaderContext): string {
  return JSON.stringify(
    {
      trevra: {
        notice: HEADER_OWNERSHIP,
        headerBlock: header.join('\n'),
        generatedAt: context.generatedAt,
        seatKey: input.plan.seatKey,
        timezone: context.timezone,
        warmupWeek: context.warmupWeek,
        ceilingsApplied: input.plan.ceilingsApplied,
        reasons: input.plan.reasons,
        schedule: context.schedule,
        antiSlopNotes: input.sequence.antiSlopNotes
      },
      campaign: {
        id: input.campaignId ?? null,
        steps: input.sequence.steps.map((step) => ({
          day: step.day,
          kind: step.kind,
          intent: step.intent,
          message: applyMergeFields(step.template, 'heyreach'),
          variables: step.variables,
          // JSON has somewhere to put both, so it gets both: the machine-
          // readable branch a parser can act on, and the sentence a human
          // reads if nothing does.
          condition: conditionOf(step),
          conditionInstruction: conditionInstruction(step)
        }))
      },
      leads: orderedTargets(input.plan).map((targetRef) => {
        const contact = contactRow(contacts.get(targetRef), targetRef);
        return {
          linkedInProfileUrl: contact.profileUrl,
          firstName: contact.firstName,
          lastName: contact.lastName,
          companyName: contact.company,
          scheduledFor: input.plan.slots.filter((slot) => slot.targetRef === targetRef).map((slot) => ({ plannedFor: slot.plannedFor, kind: slot.kind }))
        };
      })
    },
    null,
    2
  );
}

/** Plan + copy + explicit per-day send counts, for an operator with no tool at all. */
function renderGeneric(input: CampaignExportInput, contacts: Map<string, ExportContact>, context: HeaderContext): string {
  const lines: string[] = ['SEQUENCE', ''];
  for (const step of input.sequence.steps) {
    lines.push(`Day ${step.day} -- ${step.kind}`);
    lines.push(`  Why: ${step.intent}`);
    const instruction = conditionInstruction(step);
    if (instruction) lines.push(`  Condition: ${instruction}`);
    if (step.template.trim().length > 0) {
      for (const line of step.template.split('\n')) lines.push(`  | ${line}`);
      if (step.variables.length > 0) lines.push(`  Merge fields: ${step.variables.join(', ')}`);
      if (step.critique) lines.push(`  Critic: ${step.critique.passed ? 'passed' : 'FAILED -- see the copy review above'}`);
    }
    lines.push('');
  }

  lines.push('DAILY SEND COUNTS');
  lines.push('');
  for (const day of context.schedule) lines.push(`  ${day.date}  send ${day.count}  (${day.kinds.join(', ')})`);
  lines.push('');

  lines.push('TARGETS AND SLOTS');
  lines.push('');
  for (const slot of input.plan.slots) {
    const contact = contactRow(contacts.get(slot.targetRef), slot.targetRef);
    const who = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const at = contact.company ? ` (${contact.company})` : '';
    lines.push(`  ${slot.plannedFor}  ${slot.kind}  ${contact.profileUrl}${who ? `  -- ${who}${at}` : at}`);
  }

  return lines.join('\n') + '\n';
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  dripify: 'text/csv',
  heyreach: 'application/json',
  expandi: 'text/csv',
  generic: 'text/plain'
};

const EXTENSIONS: Record<ExportFormat, string> = {
  dripify: 'csv',
  heyreach: 'json',
  expandi: 'csv',
  generic: 'txt'
};

/* -------------------------------------------------------------------------
 * The entry point.
 * ---------------------------------------------------------------------- */

/**
 * Render a paced campaign for the operator's own tool, and record it.
 *
 * Signature note: the plan documents this as `exportCampaign(plan, sequence,
 * format)`. It takes `(db, input, now)` instead, matching `planPacing` and
 * `evaluateLinkedInSafety`, for two reasons that are not stylistic -- the
 * ledger write in requirement 3 needs a handle, and the header block needs the
 * seat's timezone and warm-up week, neither of which survives into `PacingPlan`.
 * `plan`, `sequence` and `format` are the three fields of `input` that matter.
 */
export async function exportCampaign(db: Db, input: CampaignExportInput, now: Date): Promise<CampaignExport> {
  const seatKey = input.plan.seatKey || OWNER_SEAT_KEY;
  // THE SEAT THE PLAN NAMES. `getSeat` defaults to the owner seat, and
  // omitting the argument here did not merely check the wrong row -- the two
  // things this function needs the seat FOR are its timezone and its warm-up
  // week, and both are then used below. Exporting a plan for a New York seat
  // from a workspace whose owner seat is in Zurich printed every slot, every
  // DAILY SEND COUNTS line and the whole header block in the wrong hours, and
  // quoted a warm-up week belonging to a different account's ramp. The comment
  // under this line already said exporting without the right timezone prints a
  // schedule in the wrong hours; it was describing the bug above it.
  const seat = await getSeat(db, input.workspaceId, seatKey);
  if (!seat) {
    // Fail closed. A plan only exists because a seat did, so a missing one
    // here means the seat was deleted mid-flight -- and exporting without its
    // timezone would print a schedule in the wrong hours.
    throw new Error(`No LinkedIn seat '${seatKey}' is configured for this workspace; nothing can be exported for it.`);
  }

  const schedule = scheduleOf(input.plan, seat.timezone);
  const context: HeaderContext = {
    plan: input.plan,
    sequence: input.sequence,
    schedule,
    warmupWeek: warmupWeekOf(seat.activatedAt, now),
    timezone: seat.timezone,
    campaignId: input.campaignId ?? null,
    generatedAt: now.toISOString()
  };

  const contacts = new Map<string, ExportContact>();
  for (const contact of input.contacts ?? []) contacts.set(contact.targetRef, contact);

  const header = headerLines(context);
  const headerBlock = header.join('\n');

  let body: string;
  let content: string;
  if (input.format === 'dripify') {
    body = renderDripify(input, contacts);
    content = commentBlock(header, CRLF) + body;
  } else if (input.format === 'expandi') {
    body = renderExpandi(input, contacts);
    content = commentBlock(header, CRLF) + body;
  } else if (input.format === 'heyreach') {
    body = renderHeyReach(input, contacts, header, context);
    // Already carries the block in `trevra.headerBlock`; prefixing `#` lines
    // would make the file unparseable, which is the opposite of embedding it.
    content = body;
  } else {
    body = renderGeneric(input, contacts, context);
    content = `${headerBlock}\n\n${body}`;
  }

  // --- The ledger. See the module comment: this is not bookkeeping, it is
  // the input to the next plan's variance arithmetic. ---
  let written = 0;
  let duplicate = 0;
  for (const slot of input.plan.slots) {
    const result = await recordAction(
      db,
      {
        workspaceId: input.workspaceId,
        seatKey,
        kind: slot.kind,
        targetRef: slot.targetRef,
        campaignId: input.campaignId ?? null,
        status: 'exported',
        plannedFor: slot.plannedFor,
        // Dated at the slot, never at `now` -- see the module comment.
        recordedAt: slot.plannedFor,
        source: 'export',
        payloadHash: input.payloadHash ?? null
      },
      now
    );
    if (result.duplicate) duplicate += 1;
    else written += 1;
  }

  const stamp = context.generatedAt.slice(0, 10);
  const slug = (input.campaignId ?? stamp).replace(/[^a-zA-Z0-9_-]/g, '-');

  return {
    format: input.format,
    filename: `trevra-linkedin-${input.format}-${slug}.${EXTENSIONS[input.format]}`,
    contentType: CONTENT_TYPES[input.format],
    headerBlock,
    body,
    content,
    schedule,
    ceilingsApplied: input.plan.ceilingsApplied,
    warmupWeek: context.warmupWeek,
    timezone: seat.timezone,
    recorded: { attempted: input.plan.slots.length, written, duplicate }
  };
}

/* -------------------------------------------------------------------------
 * The approved-action payload.
 *
 * Lives here rather than in `control-plane/execution.ts` for the same reason
 * `communityReplyPayloadSchema` lives in `outreach/publish.ts`: the module
 * that consumes the payload owns its shape, and the executor stays a router.
 *
 * The plan and the sequence are carried IN the payload rather than re-derived
 * at execution time, and that is deliberate. The playbook engine binds an
 * approval to `canonicalPayloadHash(payload)` and fails closed when the
 * payload drifts; re-planning at execution would produce a different schedule
 * from the one a human read, with the same hash on the approval. What was
 * approved is what gets exported.
 * ---------------------------------------------------------------------- */

const pacedKindSchema = z.enum(PACED_KIND_VALUES);
const actionKindSchema = z.enum(ACTION_KIND_VALUES);

/**
 * The approved copy, on its own.
 *
 * Split out of the export payload so the two places that must agree about what
 * a sequence IS -- the approval payload and the campaign row -- can be hashed
 * through ONE schema. Comparing raw JSON instead would compare Zod's applied
 * defaults on one side against their absence on the other and report an edit
 * that never happened.
 */
export const linkedinSequencePayloadSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string().min(1).max(64),
      day: z.number().int().min(0),
      kind: actionKindSchema,
      intent: z.string().default(''),
      template: z.string().default(''),
      variables: z.array(z.string()).default([]),
      critique: z
        .object({
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
        })
        .nullable()
        .default(null),
      /**
       * The branch, carried through the approval.
       *
       * Without it here the payload schema would strip every condition on the
       * way into the approval, and the export would render an unconditional
       * campaign from a sequence a human approved with branches in it. It is
       * `nullish` with no default on purpose: an absent condition stays absent
       * through `canonicalPayloadHash`, so adding this field does not retire
       * the approvals of campaigns that have no branches.
       */
      condition: stepConditionSchema.nullish()
    })
  ),
  antiSlopNotes: z.array(z.string()).default([]),
  antiSlopPassed: z.boolean().default(true)
});

export const linkedinExportPayloadSchema = z.object({
  format: z.enum(['dripify', 'heyreach', 'expandi', 'generic']),
  campaignId: z.string().min(1).max(120).nullish(),
  plan: z.object({
    seatKey: z.string().min(1).max(64),
    slots: z
      .array(
        z.object({
          plannedFor: z.string().min(1),
          kind: pacedKindSchema,
          targetRef: z.string().min(1).max(500)
        })
      )
      .max(5000),
    reasons: z.array(z.string()).default([]),
    ceilingsApplied: z.array(z.string()).default([])
  }),
  sequence: linkedinSequencePayloadSchema,
  contacts: z
    .array(
      z.object({
        targetRef: z.string().min(1).max(500),
        profileUrl: z.string().max(500).nullish(),
        firstName: z.string().max(120).nullish(),
        lastName: z.string().max(120).nullish(),
        company: z.string().max(200).nullish(),
        role: z.string().max(200).nullish()
      })
    )
    .max(5000)
    .optional(),
  /** Carried through the approval so a reviewer sees the guard verdict; not read by the exporter. */
  metadata: z.record(z.unknown()).optional()
});

export type LinkedInExportPayload = z.infer<typeof linkedinExportPayloadSchema>;
