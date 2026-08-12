import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Db } from '../db.js';
import { PACED_KIND_VALUES } from '../linkedin/limits.js';
import { sequenceStepsSchema } from '../linkedin/sequence.js';
import type { PlaybookDefinition } from './types.js';

const playbooks = new Map<string, PlaybookDefinition>();

export const auditLedOutreachPlaybook: PlaybookDefinition = {
  id: 'gtm.audit-led-outreach',
  version: '1.0.0',
  name: 'Audit-led outreach',
  description: 'Score a lead, audit its AI visibility, prepare evidence-backed outreach, and stop for founder approval.',
  inputSchema: z.object({
    lead: z.object({
      domain: z.string().min(1),
      name: z.string().nullish(),
      contactName: z.string().nullish(),
      contactEmail: z.string().email(),
      platform: z.string().nullish(),
      vertical: z.string().nullish(),
      catalogSize: z.number().nonnegative().nullish()
    }),
    draftConfig: z.object({
      offer: z.string(),
      senderName: z.string(),
      postalAddress: z.string(),
      voiceSample: z.string().nullish()
    }).optional()
  }),
  steps: [
    {
      id: 'score',
      type: 'skill',
      skillId: 'gtm.score-lead',
      input: {
        lead: {
          platform: { $ref: '$.input.lead.platform' },
          vertical: { $ref: '$.input.lead.vertical' },
          catalogSize: { $ref: '$.input.lead.catalogSize' },
          contactEmail: { $ref: '$.input.lead.contactEmail' }
        }
      }
    },
    {
      id: 'audit',
      type: 'skill',
      skillId: 'gtm.visibility-audit',
      input: { domain: { $ref: '$.input.lead.domain' } },
      retry: { maxAttempts: 2, delaySeconds: 5 }
    },
    {
      id: 'draft',
      type: 'skill',
      skillId: 'gtm.outreach-draft',
      needs: ['score', 'audit'],
      input: {
        lead: {
          domain: { $ref: '$.input.lead.domain' },
          name: { $ref: '$.input.lead.name' },
          contactName: { $ref: '$.input.lead.contactName' },
          contactEmail: { $ref: '$.input.lead.contactEmail' },
          topFinding: { $ref: '$.steps.audit.output.topFinding' },
          findingDetail: { $ref: '$.steps.audit.output.evidence.0.detail' }
        },
        config: { $ref: '$.input.draftConfig' }
      }
    },
    {
      id: 'approve-outreach',
      type: 'approval',
      title: 'Approve outreach draft',
      needs: ['draft'],
      payload: {
        recipient: { $ref: '$.steps.draft.output.toEmail' },
        subject: { $ref: '$.steps.draft.output.subject' },
        body: { $ref: '$.steps.draft.output.bodyText' },
        metadata: {
          leadScore: { $ref: '$.steps.score.output.overall' },
          auditScore: { $ref: '$.steps.audit.output.score' },
          evidence: { $ref: '$.steps.audit.output.evidence' }
        }
      }
    },
    {
      id: 'send-outreach',
      type: 'action',
      actionType: 'email.send',
      approvalStepId: 'approve-outreach',
      needs: ['approve-outreach'],
      payload: { $ref: '$.steps.approve-outreach.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-outreach.output.approved' },
    delivery: { $ref: '$.steps.send-outreach.output' },
    draft: { $ref: '$.steps.draft.output' },
    score: { $ref: '$.steps.score.output' },
    audit: { $ref: '$.steps.audit.output' }
  },
  source: { type: 'builtin' }
};


export const invoiceDeliveredWorkPlaybook: PlaybookDefinition = {
  id: 'revenue.invoice-delivered-work',
  version: '1.0.0',
  name: 'Invoice delivered work',
  description: 'Prepare an invoice payload, require founder approval, and create it through the connected accounting provider.',
  inputSchema: z.object({
    recipient: z.string().email(),
    amount: z.number().positive().max(10_000_000),
    currency: z.string().length(3),
    description: z.string().min(1).max(500),
    dueDays: z.number().int().min(0).max(365).default(14),
    message: z.string().max(20_000).default('')
  }),
  steps: [
    {
      id: 'approve-invoice',
      type: 'approval',
      title: 'Approve invoice creation',
      payload: {
        recipient: { $ref: '$.input.recipient' },
        amount: { $ref: '$.input.amount' },
        currency: { $ref: '$.input.currency' },
        description: { $ref: '$.input.description' },
        dueDays: { $ref: '$.input.dueDays' },
        message: { $ref: '$.input.message' }
      }
    },
    {
      id: 'create-invoice',
      type: 'action',
      actionType: 'invoice.create',
      approvalStepId: 'approve-invoice',
      needs: ['approve-invoice'],
      payload: { $ref: '$.steps.approve-invoice.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: { invoice: { $ref: '$.steps.create-invoice.output' } },
  source: { type: 'builtin' }
};

export const protectScopePlaybook: PlaybookDefinition = {
  id: 'revenue.protect-scope',
  version: '1.0.0',
  name: 'Protect project scope',
  description: 'Require exact approval for a priced change order and create it through HoneyBook, Bonsai, or the configured communication provider.',
  inputSchema: z.object({
    recipient: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    amount: z.number().nonnegative().max(10_000_000),
    currency: z.string().length(3),
    description: z.string().min(1).max(500)
  }),
  steps: [
    {
      id: 'approve-change-order',
      type: 'approval',
      title: 'Approve change order',
      payload: {
        recipient: { $ref: '$.input.recipient' },
        subject: { $ref: '$.input.subject' },
        body: { $ref: '$.input.body' },
        amount: { $ref: '$.input.amount' },
        currency: { $ref: '$.input.currency' },
        description: { $ref: '$.input.description' }
      }
    },
    {
      id: 'create-change-order',
      type: 'action',
      actionType: 'change_order.create',
      approvalStepId: 'approve-change-order',
      needs: ['approve-change-order'],
      payload: { $ref: '$.steps.approve-change-order.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: { changeOrder: { $ref: '$.steps.create-change-order.output' } },
  source: { type: 'builtin' }
};

/**
 * Community outreach, end to end.
 *
 * Scout -> score -> gate -> draft -> APPROVE -> post, ported from the Python
 * reference's `main.py` pipeline (`run_scout`, `run_analyzer`, `run_writer`,
 * `run_poster`). The reference chained these behind a `dry_run: true` flag that
 * was never flipped, so "nothing posts without a human" was a config value one
 * edit away from false. Here it is structural: the post is an `action` step
 * bound to `approve-reply`, and the engine refuses to execute it unless a
 * completed approval exists whose payload hash equals the hash of the exact
 * payload about to be sent.
 *
 * The playbook handles ONE thread per run -- the top-ranked one. The engine's
 * steps are a linear DAG with no fan-out, and one approval per reply is the
 * correct granularity anyway: a founder approves a specific comment on a
 * specific thread, not a batch.
 *
 * `guard` runs BEFORE `draft` so a blocked thread never spends a drafting
 * cycle, and its verdict is carried into the approval payload -- the founder
 * sees the daily-cap, cooldown, and account-standing findings next to the copy
 * they are being asked to approve.
 *
 * A run that discovers NOTHING fails at `guard` with a `thread: Required`
 * validation error, because `$.steps.score.output.repliable.0.thread` resolves to
 * nothing and the engine's steps are an unconditional DAG. That is a failed
 * run rather than a silent success, which is the safer of the two available
 * answers; giving it a nicer one means a conditional step type, which is a
 * change to the engine and not to this port.
 */
export const communityOutreachPlaybook: PlaybookDefinition = {
  id: 'gtm.community-outreach',
  version: '1.0.0',
  name: 'Community outreach reply',
  description:
    'Find the best community thread discussing coding-agent cost, gate it against posting limits, draft a reply, and stop for founder approval before posting.',
  inputSchema: z.object({
    platforms: z.array(z.string().min(1)).max(20).optional(),
    queries: z.array(z.string().min(1)).max(50).optional(),
    limitPerPlatform: z.number().int().positive().max(100).default(25),
    minScore: z.number().min(0).max(10).default(5),
    product: z.object({
      name: z.string().min(1).max(80),
      url: z.string().url(),
      summary: z.string().min(1).max(300),
      mechanism: z.string().min(1).max(300),
      claims: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) })).max(8).default([])
    }),
    /** Overrides OUTREACH_ACCOUNT_PROFILES_JSON for this run. */
    account: z.object({ accountAgeDays: z.number().min(0), karma: z.number().min(0) }).nullish()
  }),
  steps: [
    {
      id: 'scout',
      type: 'skill',
      skillId: 'gtm.scout-threads',
      input: {
        platforms: { $ref: '$.input.platforms' },
        queries: { $ref: '$.input.queries' },
        limitPerPlatform: { $ref: '$.input.limitPerPlatform' }
      },
      retry: { maxAttempts: 2, delaySeconds: 15 }
    },
    {
      id: 'score',
      type: 'skill',
      skillId: 'gtm.score-threads',
      needs: ['scout'],
      input: { threads: { $ref: '$.steps.scout.output.threads' }, minScore: { $ref: '$.input.minScore' } }
    },
    {
      id: 'guard',
      type: 'skill',
      skillId: 'gtm.outreach-guard',
      needs: ['score'],
      input: {
        thread: { $ref: '$.steps.score.output.repliable.0.thread' },
        account: { $ref: '$.input.account' },
        // The stop signal. Without it the verdict is advisory and a blocked
        // thread still reaches a founder for approval.
        requireAllowed: true
      }
    },
    {
      id: 'draft',
      type: 'skill',
      skillId: 'gtm.draft-reply',
      needs: ['score', 'guard'],
      input: {
        thread: { $ref: '$.steps.score.output.repliable.0.thread' },
        product: { $ref: '$.input.product' },
        angle: { $ref: '$.steps.score.output.repliable.0.angle' }
      }
    },
    {
      id: 'approve-reply',
      type: 'approval',
      title: 'Approve community reply',
      needs: ['draft', 'guard'],
      payload: {
        platform: { $ref: '$.steps.score.output.repliable.0.thread.platform' },
        threadExternalId: { $ref: '$.steps.score.output.repliable.0.thread.externalId' },
        threadUrl: { $ref: '$.steps.score.output.repliable.0.thread.url' },
        community: { $ref: '$.steps.score.output.repliable.0.thread.community' },
        body: { $ref: '$.steps.draft.output.body' },
        metadata: {
          threadTitle: { $ref: '$.steps.score.output.repliable.0.thread.title' },
          // Carried so the CRM write-back can try to match the thread's author
          // to a known contact. Part of the approved payload, so what gets
          // attributed is visible to whoever approves it.
          threadAuthor: { $ref: '$.steps.score.output.repliable.0.thread.author' },
          relevanceScore: { $ref: '$.steps.score.output.repliable.0.score' },
          angle: { $ref: '$.steps.draft.output.angle' },
          safetyAllowed: { $ref: '$.steps.guard.output.allowed' },
          safetyReason: { $ref: '$.steps.guard.output.reason' },
          safetyChecks: { $ref: '$.steps.guard.output.checks' },
          critiquePassed: { $ref: '$.steps.draft.output.critique.passed' },
          critiqueFindings: { $ref: '$.steps.draft.output.critique.findings' },
          automationMode: { $ref: '$.steps.draft.output.automationMode' },
          submitUrl: { $ref: '$.steps.draft.output.submitUrl' }
        }
      }
    },
    {
      id: 'post-reply',
      type: 'action',
      actionType: 'community.reply',
      approvalStepId: 'approve-reply',
      needs: ['approve-reply'],
      payload: { $ref: '$.steps.approve-reply.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-reply.output.approved' },
    delivery: { $ref: '$.steps.post-reply.output' },
    draft: { $ref: '$.steps.draft.output' },
    safety: { $ref: '$.steps.guard.output' },
    thread: { $ref: '$.steps.score.output.repliable.0.thread' }
  },
  source: { type: 'builtin' }
};

export const linkedinOutreachPlaybook: PlaybookDefinition = {
  id: 'gtm.linkedin-outreach',
  version: '1.0.0',
  name: 'LinkedIn outreach campaign',
  description:
    "Write a LinkedIn sequence, pace it against the seat's warm-up week and real action ledger, gate it on every per-seat ceiling at once, and stop for founder approval before exporting the campaign for the operator's own tool.",
  inputSchema: z.object({
    /**
     * The brief. OPTIONAL, and only since sequences became editable data.
     *
     * A campaign assembled from steps -- a template, or an operator's own
     * nodes -- has copy already and needs nothing drafted, which is the whole
     * Dripify-shaped path: name it, build it, send it, never fill in an ICP
     * form. When the brief IS supplied alongside `sequenceSteps` it stops
     * being generation input and becomes critic evidence, which is why it is
     * still passed to the sequence step in both cases.
     */
    icp: z
      .object({
        role: z.string().min(1).max(120),
        segment: z.string().min(1).max(160),
        pain: z.string().min(1).max(300)
      })
      .optional(),
    offer: z
      .object({
        name: z.string().min(1).max(80),
        summary: z.string().min(1).max(300),
        mechanism: z.string().min(1).max(300),
        proof: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) })).max(6).default([]),
        url: z.string().url().nullish()
      })
      .optional(),
    /**
     * An explicit sequence, when the operator already has one. Validated and
     * critiqued by `gtm.linkedin-sequence` exactly as a drafted one is -- it is
     * the same code path with different starting values, not a bypass.
     */
    // IMPORTED, NOT RESTATED. This was a third hand-copy of the step object
    // (app.ts held the second), and a copy that lacked `condition` stripped
    // every branch out of the payload BEFORE `gtm.linkedin-sequence` saw it --
    // so a campaign created with branches was approved and exported without
    // them, looking correct the whole way. One definition, in the module that
    // owns the rules it encodes.
    sequenceSteps: sequenceStepsSchema.optional(),
    /** Opaque handles or profile URLs. Trevra never resolves them against LinkedIn. */
    targets: z.array(z.string().min(1).max(500)).min(1).max(500),
    tone: z.enum(['direct', 'consultative', 'peer']).default('consultative'),
    includeInMail: z.boolean().default(false),
    /** `none` drafts the connection request with no note at all. Ignored when `sequenceSteps` carries the copy. */
    inviteNote: z.enum(['drafted', 'none']).default('drafted'),
    /** The kind the plan paces. One kind per run, because each has its own band. */
    kind: z.enum(PACED_KIND_VALUES).default('invite'),
    horizonDays: z.number().int().min(1).max(90).default(14),
    seatKey: z.string().min(1).max(64).default('owner'),
    format: z.enum(['dripify', 'heyreach', 'expandi', 'generic']).default('dripify'),
    campaignId: z.string().min(1).max(120).nullish(),
    /** Names and companies for the merge fields. Optional: a target with no entry exports with empty columns. */
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
      .max(500)
      .optional()
  }).refine(
    (value) => Boolean(value.sequenceSteps) || (Boolean(value.icp) && Boolean(value.offer)),
    { message: 'Provide sequenceSteps, or an icp and an offer for gtm.linkedin-sequence to draft from' }
  ),
  steps: [
    {
      id: 'sequence',
      type: 'skill',
      skillId: 'gtm.linkedin-sequence',
      // A $ref that resolves to nothing is DROPPED from the resolved object
      // (playbooks/template.ts), so an absent `sequenceSteps` leaves the skill
      // to draft, and an absent brief leaves it to critique the steps against
      // the merge fields alone. Both are ordinary inputs, not failures.
      input: {
        steps: { $ref: '$.input.sequenceSteps' },
        icp: { $ref: '$.input.icp' },
        offer: { $ref: '$.input.offer' },
        targets: { $ref: '$.input.targets' },
        tone: { $ref: '$.input.tone' },
        includeInMail: { $ref: '$.input.includeInMail' },
        inviteNote: { $ref: '$.input.inviteNote' }
      }
    },
    {
      id: 'pace',
      type: 'skill',
      skillId: 'gtm.linkedin-pace',
      needs: ['sequence'],
      input: {
        seatKey: { $ref: '$.input.seatKey' },
        kind: { $ref: '$.input.kind' },
        targets: { $ref: '$.input.targets' },
        horizonDays: { $ref: '$.input.horizonDays' }
      }
    },
    {
      id: 'guard',
      type: 'skill',
      skillId: 'gtm.linkedin-guard',
      needs: ['pace'],
      input: {
        seatKey: { $ref: '$.input.seatKey' },
        kind: { $ref: '$.input.kind' },
        // The FIRST slot. The gate is per-action by design, and the first slot
        // is the one that fires soonest -- if the seat may not act then, the
        // whole plan is stale and no part of it should reach an approval.
        targetRef: { $ref: '$.steps.pace.output.slots.0.targetRef' },
        plannedFor: { $ref: '$.steps.pace.output.slots.0.plannedFor' },
        // The stop signal. Same reason as gtm.community-outreach: the engine's
        // steps are an unconditional DAG, so a verdict that is merely REPORTED
        // cannot stop the chain, and a gate that stops nothing is decoration.
        requireAllowed: true
      }
    },
    {
      id: 'approve-campaign',
      type: 'approval',
      title: 'Approve LinkedIn campaign',
      needs: ['sequence', 'pace', 'guard'],
      payload: {
        format: { $ref: '$.input.format' },
        campaignId: { $ref: '$.input.campaignId' },
        // The plan and the copy are carried IN the payload, not re-derived at
        // execution. The approval binds `canonicalPayloadHash(payload)`, so
        // what a founder read is what gets exported; a re-plan at execution
        // time would ship a different schedule under an unchanged hash.
        plan: { $ref: '$.steps.pace.output' },
        sequence: { $ref: '$.steps.sequence.output' },
        contacts: { $ref: '$.input.contacts' },
        metadata: {
          seatKey: { $ref: '$.steps.pace.output.seatKey' },
          ceilingsApplied: { $ref: '$.steps.pace.output.ceilingsApplied' },
          pacingReasons: { $ref: '$.steps.pace.output.reasons' },
          safetyAllowed: { $ref: '$.steps.guard.output.allowed' },
          safetyReason: { $ref: '$.steps.guard.output.reason' },
          safetyChecks: { $ref: '$.steps.guard.output.checks' },
          // LinkedIn is `prepare-only` and the payload says so where a human
          // reads it: an approved campaign is a file they run, never a thing
          // Trevra sends.
          automationMode: { $ref: '$.steps.guard.output.automationMode' },
          automationReason: { $ref: '$.steps.guard.output.automationReason' },
          antiSlopPassed: { $ref: '$.steps.sequence.output.antiSlopPassed' },
          antiSlopNotes: { $ref: '$.steps.sequence.output.antiSlopNotes' }
        }
      }
    },
    {
      id: 'export-campaign',
      type: 'action',
      actionType: 'linkedin.export',
      approvalStepId: 'approve-campaign',
      needs: ['approve-campaign'],
      payload: { $ref: '$.steps.approve-campaign.input' },
      retry: { maxAttempts: 3, delaySeconds: 30 }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-campaign.output.approved' },
    export: { $ref: '$.steps.export-campaign.output' },
    sequence: { $ref: '$.steps.sequence.output' },
    plan: { $ref: '$.steps.pace.output' },
    safety: { $ref: '$.steps.guard.output' }
  },
  source: { type: 'builtin' }
};

registerPlaybook(auditLedOutreachPlaybook);
registerPlaybook(communityOutreachPlaybook);
registerPlaybook(invoiceDeliveredWorkPlaybook);
registerPlaybook(protectScopePlaybook);
registerPlaybook(linkedinOutreachPlaybook);

export function registerPlaybook(playbook: PlaybookDefinition): PlaybookDefinition {
  validatePlaybook(playbook);
  const key = registryKey(playbook.id, playbook.version);
  const existing = playbooks.get(key);
  if (existing) return existing;
  playbooks.set(key, playbook);
  return playbook;
}

export function getPlaybook(id: string, version?: string): PlaybookDefinition | undefined {
  if (version) return playbooks.get(registryKey(id, version));
  return listPlaybooks().filter((playbook) => playbook.id === id).sort((a, b) => b.version.localeCompare(a.version))[0];
}

export function listPlaybooks(): PlaybookDefinition[] {
  return [...playbooks.values()].sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version));
}

export async function seedPlaybooks(db: Db, now: Date = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const playbook of listPlaybooks()) {
    const source = playbook.source ?? { type: 'builtin' as const };
    await db.prepare(`
      INSERT INTO playbooks (
        playbook_key,version,name,description,input_schema_json,definition_json,
        source_type,source_ref,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (playbook_key,version) DO UPDATE SET
        name=excluded.name,description=excluded.description,input_schema_json=excluded.input_schema_json,
        definition_json=excluded.definition_json,source_type=excluded.source_type,
        source_ref=excluded.source_ref,updated_at=excluded.updated_at
    `).run(
      playbook.id,
      playbook.version,
      playbook.name,
      playbook.description,
      JSON.stringify(zodToJsonSchema(playbook.inputSchema, { target: 'jsonSchema7', $refStrategy: 'none' })),
      JSON.stringify(publicDefinition(playbook)),
      source.type,
      source.ref ?? null,
      timestamp,
      timestamp
    );
  }
}

export async function listWorkspacePlaybooks(db: Db, workspaceId: string) {
  const rows = await db.prepare(`
    SELECT p.playbook_key,p.version,p.name,p.description,p.input_schema_json,p.definition_json,
      p.source_type,p.source_ref,p.enabled AS registry_enabled,
      COALESCE(wp.enabled,TRUE) AS workspace_enabled,wp.pinned_version,wp.config_json
    FROM playbooks p
    LEFT JOIN workspace_playbooks wp ON wp.workspace_id=? AND wp.playbook_key=p.playbook_key
    ORDER BY p.playbook_key,p.version DESC
  `).all<Record<string, unknown>>(workspaceId);
  return rows.map((row) => ({
    id: String(row.playbook_key),
    version: String(row.version),
    name: String(row.name),
    description: String(row.description),
    enabled: Boolean(row.registry_enabled) && Boolean(row.workspace_enabled),
    pinnedVersion: row.pinned_version ? String(row.pinned_version) : null,
    inputSchema: parseObject(row.input_schema_json),
    definition: parseObject(row.definition_json),
    source: { type: String(row.source_type), ref: row.source_ref ? String(row.source_ref) : null },
    config: parseObject(row.config_json)
  }));
}

function publicDefinition(playbook: PlaybookDefinition): Record<string, unknown> {
  return {
    id: playbook.id,
    version: playbook.version,
    steps: playbook.steps,
    output: playbook.output ?? null
  };
}

function validatePlaybook(playbook: PlaybookDefinition): void {
  if (!playbook.id || !playbook.version || !playbook.name) throw new Error('Playbook id, version, and name are required');
  const ids = new Set<string>();
  for (const step of playbook.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate playbook step: ${step.id}`);
    if (step.type === 'action' && !/^[a-z][a-z0-9_.-]{2,119}$/.test(step.actionType)) {
      throw new Error(`Invalid playbook action type: ${step.actionType}`);
    }
    for (const dependency of step.needs ?? []) {
      if (!ids.has(dependency)) throw new Error(`Playbook step ${step.id} depends on unknown or later step ${dependency}`);
    }
    ids.add(step.id);
  }
}

function registryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
