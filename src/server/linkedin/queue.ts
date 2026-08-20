import { z } from 'zod';
import { linkedInWorkerConfig } from '../config.js';
import type { Db } from '../db.js';
import { recordAction } from './actions.js';
import { LinkedInApiError } from './errors.js';
import { linkedinSequencePayloadSchema, type ExportContact } from './export.js';
import { PACED_KIND_VALUES } from './limits.js';
import {
  EXECUTABLE_KINDS,
  KINDS_REQUIRING_BODY,
  linkedInOffReason,
  type ExecutableKind
} from './local-worker.js';
import type { PacingPlan } from './pacing.js';
import { OWNER_SEAT_KEY, getSeat } from './seats.js';
import { extractVariables, type LinkedInSequence, type SequenceStep } from './sequence.js';

/**
 * The other half of `export.ts`: an approved campaign queued for the LOCAL
 * WORKER instead of rendered for somebody else's tool.
 *
 * `local-worker.ts` has driver routines for `invite` and `dm` and lists both in
 * `EXECUTABLE_KINDS`, and until this module existed nothing ever wrote a row it
 * could claim -- `exportCampaign` files every slot as 'exported' (a file the
 * operator runs) and `enqueueReply` only ever files a `reply`. So the worker
 * was a complete sending arm with an empty queue. This is the missing writer,
 * and it is deliberately nothing more than that.
 *
 * WHAT THIS MODULE IS NOT:
 *
 * 1. IT DOES NOT SEND. It writes 'planned' rows and returns. Every ceiling,
 *    every posture check and every duplicate check still happens in the worker,
 *    per action, immediately before execution (`runLinkedInLocalBatch` rule 1),
 *    because these slots are days in the future and a plan approved on Monday
 *    can be stale by Thursday. Gating here as well would be gating on a clock
 *    that has not run yet -- `planPacing` already shaped these slots, and
 *    re-judging them at queue time would refuse a campaign for a budget that
 *    will have refilled long before its first slot fires.
 * 2. IT IS NOT REACHABLE BY AN AGENT. The only callers are the approved-action
 *    executor (`control-plane/execution.ts`, action type `linkedin.queue`) and
 *    the route that replays the same approved payload. Both require an approval
 *    whose payload hash a human signed.
 * 3. IT DOES NOT COMPOSE. Every byte queued here comes from the approved
 *    sequence with the operator's own contact values substituted in. A merge
 *    field this campaign's contact list cannot fill refuses the WHOLE call --
 *    see `renderBody` below.
 *
 * WHY THE ROWS ARE 'planned' AND CARRY NO `recorded_at`. 'planned' is the one
 * status `claimNextDueAction` will pick up, and it is also the one status that
 * consumes no budget (`actions.ts` COUNTED). That is the correct pair: nothing
 * has happened yet, and `settleSent` writes `recorded_at` at the moment it
 * does. This is the one place this module deliberately DIFFERS from
 * `exportCampaign`, which dates each row at its slot because an exported file
 * is about to be real and nobody will ever come back to confirm it.
 */

/**
 * Same shape as `CampaignExportInput` minus `format`.
 *
 * There is no format because there is no file: the destination is the
 * operator's own browser, driven by the local worker, and the only rendering
 * that happens is filling the approved copy's merge fields.
 */
export interface CampaignQueueInput {
  workspaceId: string;
  plan: PacingPlan;
  sequence: LinkedInSequence;
  /** Keyed by `targetRef`. A target with no entry can only be queued for copy that names nobody. */
  contacts?: readonly ExportContact[];
  /** Groups the ledger rows so an operator can stop one campaign without touching another. */
  campaignId?: string | null;
  /** The approved payload's hash, carried onto every ledger row for the audit trail. */
  payloadHash?: string | null;
  /** The Trevra user whose live request queued this campaign. Undefined when this runs off the approved-action executor instead of a route -- see `LinkedInActionRecord.queuedByUserId`. */
  queuedByUserId?: string | null;
}

export interface CampaignQueued {
  seatKey: string;
  /** The kinds actually queued, in plan order, de-duplicated. For a screen to say what is coming. */
  kinds: ExecutableKind[];
  /**
   * Ledger outcome, identical in meaning to `CampaignExport.recorded`.
   * `duplicate` is a target this seat had already been given an action of this
   * kind for -- the (workspace, seat, kind, target_ref) replay guard doing its
   * job, which is what makes a re-run a no-op rather than a second invite.
   */
  recorded: { attempted: number; written: number; duplicate: number };
}

/* -------------------------------------------------------------------------
 * Which kinds may be queued.
 * ---------------------------------------------------------------------- */

/**
 * `EXECUTABLE_KINDS` minus `reply`, and the exclusion is structural rather
 * than cautious.
 *
 * A reply is addressed by CONVERSATION: the worker's claim refuses one whose
 * `thread_urn` is null (migration 035), and a thread urn is a fact about an
 * inbox that a campaign plan has never seen. Queueing a `reply` from here would
 * write rows that are correct in every column but one and can therefore never
 * be claimed -- a queue that silently never drains, which is exactly the
 * failure `enqueueReply` refuses to create. `inbox.ts` is the only writer that
 * holds the missing column, so it stays the only writer of that kind.
 */
const QUEUEABLE_KINDS: readonly ExecutableKind[] = EXECUTABLE_KINDS.filter(
  (kind) => kind !== 'reply'
);

function isQueueable(kind: string): kind is ExecutableKind {
  return (QUEUEABLE_KINDS as readonly string[]).includes(kind);
}

/* -------------------------------------------------------------------------
 * Merge fields, filled rather than remapped.
 * ---------------------------------------------------------------------- */

/**
 * One contact field, trimmed, or null when the operator does not have it.
 *
 * `jobTitle` is the supported merge-field name (`sequence.ts`
 * SUPPORTED_MERGE_FIELDS) and `role` is its predecessor; both read
 * `ExportContact.role`, because the CONTACT record was never renamed and
 * sequences approved before the rename are still in the ledger. Anything else
 * is unknown here and refuses the call rather than resolving to an empty
 * string.
 */
function contactValue(contact: ExportContact | undefined, field: string): string | null {
  const pick =
    field === 'firstName'
      ? contact?.firstName
      : field === 'lastName'
        ? contact?.lastName
        : field === 'company'
          ? contact?.company
          : field === 'jobTitle' || field === 'role'
            ? contact?.role
            : null;
  const value = pick?.trim();
  return value ? value : null;
}

/**
 * The approved copy with THIS contact's real values in it.
 *
 * NOT `applyMergeFields`, and the difference is the whole point of this module.
 * That function rewrites `{{firstName}}` into the destination tool's own token
 * because the tool does the filling; here there is no other tool, the worker
 * types what it is given, and a surviving `{{firstName}}` would reach a human
 * literally. So this substitutes the VALUE and reports every field it could
 * not fill.
 *
 * Nothing is invented for a missing field -- not an empty string, not "there",
 * not the first word of a profile URL. `queueCampaign` refuses the whole call
 * on any miss.
 */
export function renderBody(
  template: string,
  contact: ExportContact | undefined
): { body: string; missing: string[] } {
  const missing: string[] = [];
  const body = template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const value = contactValue(contact, name);
    if (value === null) {
      if (!missing.includes(name)) missing.push(name);
      // Left as written so a caller that ignored `missing` still fails a
      // literal-placeholder assertion instead of sending half a sentence.
      return whole;
    }
    return value;
  });
  return { body, missing };
}

/**
 * The approved step this slot's copy comes from: earliest day of that kind.
 *
 * A `PacingPlan` is single-kind by construction (`planPacing` takes one
 * `kind`), so this resolves one step per plan in practice. It is written
 * per-slot anyway because the slot is what carries the kind, and a plan that
 * ever gains a second kind must not silently send the first kind's copy.
 */
function stepForKind(sequence: LinkedInSequence, kind: string): SequenceStep | undefined {
  return [...sequence.steps].sort((a, b) => a.day - b.day).find((step) => step.kind === kind);
}

/** Kinds whose entire content is their approved copy -- the worker's own rule, not a copy of it. */
function requiresBody(kind: ExecutableKind): boolean {
  return KINDS_REQUIRING_BODY.includes(kind);
}

/**
 * The rendered-body cache key: KIND AND TARGET, never target alone.
 *
 * `stepForKind` is deliberately resolved per slot so that a plan which ever
 * carries two kinds cannot send the first kind's copy as the second's. Caching
 * on `targetRef` alone would hand that guarantee straight back -- the second
 * kind's slot would hit the cache and reuse the invite's words as the DM's.
 * `planPacing` takes one kind today so this is unreachable, which is exactly
 * why it has to be written down rather than relied upon.
 *
 * ` ` separates because it is the one character a LinkedIn profile URL or
 * an opaque target handle cannot contain, so no pair of distinct (kind, target)
 * values can collide into one key.
 */
function bodyKey(kind: string, targetRef: string): string {
  return `${kind} ${targetRef}`;
}

/**
 * How many targets a refusal names before it summarises.
 *
 * JUDGEMENT, not evidence: ten lines is about as much as a person reads off an
 * error before scrolling, and the count that follows says nothing was hidden.
 */
const MAX_NAMED_TARGETS = 10;

function namedTargets(entries: readonly string[]): string {
  if (entries.length <= MAX_NAMED_TARGETS) return entries.join('; ');
  return `${entries.slice(0, MAX_NAMED_TARGETS).join('; ')}; and ${entries.length - MAX_NAMED_TARGETS} more`;
}

/* -------------------------------------------------------------------------
 * The entry point.
 * ---------------------------------------------------------------------- */

/**
 * Queue an approved campaign as `planned` actions the local worker can claim.
 *
 * Signature matches `exportCampaign(db, input, now)` for the same reasons: the
 * ledger write needs a handle, and the seat lookup needs a clock.
 *
 * EVERY REFUSAL HAPPENS BEFORE THE FIRST WRITE. A campaign is one decision a
 * human signed, so it is queued whole or not at all -- the alternative is a
 * half-queued plan whose pacing arithmetic describes a campaign that does not
 * exist, and an operator with no way to tell which half went in.
 */
export async function queueCampaign(
  db: Db,
  input: CampaignQueueInput,
  now: Date
): Promise<CampaignQueued> {
  const seatKey = input.plan.seatKey || OWNER_SEAT_KEY;

  // --- Refusal 1: the deployment gate. Cheapest, and reads no database. ---
  //
  // Hosted Trevra never queues for sending, and that is a decision about who is
  // the automation operator rather than a missing feature: the worker drives a
  // browser signed into one human's account, and a multi-tenant server doing
  // that on their behalf makes Trevra the operator under LinkedIn's User
  // Agreement 8.2 (docs/core-product.md section 8). The export path is what
  // exists there, and the sentence says so rather than leaving somebody hunting
  // for a switch -- same distinction `linkedInOffReason` draws.
  const worker = linkedInWorkerConfig();
  if (!worker.enabled) {
    throw new LinkedInApiError(
      worker.hosted
        ? 'An approved campaign cannot be queued for sending on a hosted deployment: the local worker drives a browser signed into one human account, so it is self-hosted only. Export the campaign instead -- that is the path that exists here.'
        : `${linkedInOffReason(worker)} An approved campaign cannot be queued for sending; export it instead.`,
      409
    );
  }

  // --- Refusal 2: a kind this worker cannot perform. ---
  //
  // `inmail` and `comment` are paced and recordable but `driver.ts` has no
  // routine for either, so a queued row would sit under a claim forever
  // (local-worker.ts EXECUTABLE_KINDS). Refused by name, with the path that
  // does work for it.
  const unqueueable = [
    ...new Set(input.plan.slots.map((slot) => slot.kind).filter((kind) => !isQueueable(kind)))
  ];
  if (unqueueable.length > 0) {
    throw new LinkedInApiError(
      `This plan plans ${unqueueable.join(', ')}, which the local worker cannot send -- it executes ${QUEUEABLE_KINDS.join(', ')}. Export the campaign for a tool that can, or re-plan it for a kind the worker performs.`,
      409
    );
  }

  // --- Refusal 3: no seat. Fail closed, exactly as `exportCampaign` does. ---
  //
  // THE SEAT THE PLAN NAMES, NOT THE OWNER SEAT. `getSeat` defaults its third
  // argument to `owner`, and omitting it here asked whether the OWNER account
  // existed while queueing for whichever seat the approved plan chose: a
  // workspace whose owner seat was configured and whose second seat was not
  // queued a campaign for an account that does not exist -- rows the worker can
  // never claim -- and the refusal, when it did fire, named a seat key it had
  // never looked up. The same silent default `enqueueReply` and
  // `exportCampaign` carry their own paragraphs about; the failure mode is
  // never a missing row, it is the wrong account.
  const seat = await getSeat(db, input.workspaceId, seatKey);
  if (!seat) {
    throw new Error(
      `No LinkedIn seat '${seatKey}' is configured for this workspace; nothing can be queued for it.`
    );
  }

  const contacts = new Map<string, ExportContact>();
  for (const contact of input.contacts ?? []) contacts.set(contact.targetRef, contact);

  // --- Refusal 4: copy that cannot be rendered. ---
  //
  // The worker sends APPROVED BYTES (plan 4.6), so a body still holding
  // `{{firstName}}` is not a cosmetic defect -- it is a stranger receiving a
  // template. Every slot is rendered here, before anything is written, and one
  // unfillable field refuses the whole campaign naming the targets and the
  // fields, because "which of my 200 contacts is missing a first name" is the
  // only question the operator actually has.
  const bodies = new Map<string, string | null>();
  const unrenderable: string[] = [];
  const emptyRequired: string[] = [];
  for (const slot of input.plan.slots) {
    const cacheKey = bodyKey(slot.kind, slot.targetRef);
    if (bodies.has(cacheKey)) continue;
    const kind = slot.kind as ExecutableKind;
    const step = stepForKind(input.sequence, kind);
    const template = step?.template ?? '';

    if (template.trim().length === 0) {
      // A note-less invite is legitimate and common (migration 024); a message
      // with nothing to say is not, and the worker's claim already refuses it.
      if (requiresBody(kind)) emptyRequired.push(`${slot.targetRef} (${kind})`);
      bodies.set(cacheKey, null);
      continue;
    }

    const rendered = renderBody(template, contacts.get(slot.targetRef));
    if (rendered.missing.length > 0) {
      unrenderable.push(
        `${slot.targetRef} needs ${rendered.missing.map((field) => `{{${field}}}`).join(', ')}`
      );
      continue;
    }
    bodies.set(cacheKey, rendered.body.trim().length > 0 ? rendered.body : null);
  }

  if (unrenderable.length > 0) {
    throw new LinkedInApiError(
      `This campaign was not queued: the approved copy needs merge fields these contacts do not have -- ${namedTargets(unrenderable)}. The worker sends the approved words and never invents a name, so fill the contact list or edit the copy and approve it again.`,
      400
    );
  }
  if (emptyRequired.length > 0) {
    throw new LinkedInApiError(
      `This campaign was not queued: ${namedTargets(emptyRequired)} would be a message with no approved words, and the worker has nothing to send. Approve copy for that step first.`,
      400
    );
  }

  // --- The ledger write. ---
  //
  // ONE TRANSACTION FOR THE WHOLE CAMPAIGN, and within it the `enqueueReply`
  // pattern per row: `recordAction` files the 'planned' row, then the body
  // lands in the same transaction, so a row is never visible to
  // `claimNextDueAction` before the bytes it is supposed to send exist. The
  // outer transaction adds the campaign-level half of the same promise -- a
  // crash mid-loop leaves no partial queue behind.
  //
  // Idempotency is the (workspace, seat, kind, target_ref) unique index, which
  // this module neither weakens nor works around: a re-run of an approved
  // action returns the earlier row's id and counts it as `duplicate`, which is
  // what makes the executor's retry of an action whose outcome was unknown safe.
  const queued = await db.transaction(async (tx) => {
    let written = 0;
    let duplicate = 0;
    for (const slot of input.plan.slots) {
      const result = await recordAction(
        tx,
        {
          workspaceId: input.workspaceId,
          seatKey,
          kind: slot.kind,
          targetRef: slot.targetRef,
          campaignId: input.campaignId ?? null,
          status: 'planned',
          plannedFor: slot.plannedFor,
          // No `recordedAt`: 'planned' has not happened, so it consumes no
          // rolling budget until `settleSent` dates it at the moment it did.
          source: 'campaign',
          payloadHash: input.payloadHash ?? null,
          queuedByUserId: input.queuedByUserId ?? null
        },
        now
      );
      if (result.duplicate) {
        duplicate += 1;
        continue;
      }
      written += 1;
      const body = bodies.get(bodyKey(slot.kind, slot.targetRef)) ?? null;
      if (body !== null) {
        await tx
          .prepare('UPDATE linkedin_actions SET body=? WHERE id=? AND workspace_id=?')
          .run(body, result.id, input.workspaceId);
      }
    }
    return { written, duplicate };
  });

  return {
    seatKey,
    kinds: [...new Set(input.plan.slots.map((slot) => slot.kind as ExecutableKind))],
    recorded: {
      attempted: input.plan.slots.length,
      written: queued.written,
      duplicate: queued.duplicate
    }
  };
}

/* -------------------------------------------------------------------------
 * The approved-action payload.
 *
 * Co-located with the module that consumes it, exactly as
 * `linkedinExportPayloadSchema` is -- the executor stays a router.
 *
 * IT IS `linkedin.queue`, NOT `linkedin.send`. Executing this action writes
 * 'planned' rows and sends nothing; the sending happens later, in the worker,
 * on the operator's own machine, behind the per-action safety gate. Naming it
 * `send` would be a name that claims more than the code does, which
 * docs/app-spec.md section 6 forbids of every string a human reads.
 *
 * The plan and the copy are carried IN the payload rather than re-derived at
 * execution time, for the reason the export schema gives: the approval binds
 * `canonicalPayloadHash(payload)`, and re-planning at execution would queue a
 * different schedule under the hash a human signed.
 * ---------------------------------------------------------------------- */

const pacedKindSchema = z.enum(PACED_KIND_VALUES);

export const linkedinQueuePayloadSchema = z.object({
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
  /** Carried through the approval so a reviewer sees the guard verdict; not read by the queue. */
  metadata: z.record(z.unknown()).optional()
});

export type LinkedInQueuePayload = z.infer<typeof linkedinQueuePayloadSchema>;
