import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Db } from '../db.js';
import { outreachThreadSchema } from '../outreach/scorer.js';
import type { PlaybookDefinition } from './types.js';

// GTM-only registry: post-sale revenue/project playbooks and financial action flows are intentionally absent.
const playbooks = new Map<string, PlaybookDefinition>();

export const auditLedOutreachPlaybook: PlaybookDefinition = {
  id: 'gtm.audit-led-outreach',
  version: '1.0.0',
  name: 'Audit-led outreach',
  description:
    'Score a lead, audit its AI visibility, prepare evidence-backed outreach, and stop for founder approval.',
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
    draftConfig: z
      .object({
        offer: z.string(),
        senderName: z.string(),
        postalAddress: z.string(),
        voiceSample: z.string().nullish()
      })
      .optional()
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

/**
 * Community outreach, end to end.
 *
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
      claims: z
        .array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) }))
        .max(8)
        .default([])
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
      input: {
        threads: { $ref: '$.steps.scout.output.threads' },
        minScore: { $ref: '$.input.minScore' }
      }
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

/**
 * One thread, chosen by a human, drafted for approval.
 *
 * The community playbook scouts and then drafts against `repliable.0` -- the
 * best thread in a fresh batch, which is the right answer for a scheduled run
 * and the wrong one for a founder who just picked a row in /research. Same
 * gate, same approval payload, no scout and no score: the thread arrives whole
 * from the caller, and its relevance was already computed on the read path.
 */
export const threadReplyPlaybook: PlaybookDefinition = {
  id: 'gtm.thread-reply',
  version: '1.0.0',
  name: 'Reply to one discovered thread',
  description:
    'Gate one chosen community thread against posting limits, draft a reply to it, and stop for founder approval before posting.',
  inputSchema: z.object({
    thread: outreachThreadSchema,
    angle: z
      .enum(['technical_deepdive', 'cost_comparison', 'alternative_suggestion', 'minimal_mention'])
      .optional(),
    relevanceScore: z.number().min(0).max(10).optional(),
    product: z.object({
      name: z.string().min(1).max(80),
      url: z.string().url(),
      summary: z.string().min(1).max(300),
      mechanism: z.string().min(1).max(300),
      claims: z
        .array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(80) }))
        .max(8)
        .default([])
    }),
    account: z.object({ accountAgeDays: z.number().min(0), karma: z.number().min(0) }).nullish()
  }),
  steps: [
    {
      id: 'guard',
      type: 'skill',
      skillId: 'gtm.outreach-guard',
      input: {
        thread: { $ref: '$.input.thread' },
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
      needs: ['guard'],
      input: {
        thread: { $ref: '$.input.thread' },
        product: { $ref: '$.input.product' },
        angle: { $ref: '$.input.angle' }
      }
    },
    {
      id: 'approve-reply',
      type: 'approval',
      title: 'Approve community reply',
      needs: ['draft', 'guard'],
      payload: {
        platform: { $ref: '$.input.thread.platform' },
        threadExternalId: { $ref: '$.input.thread.externalId' },
        threadUrl: { $ref: '$.input.thread.url' },
        community: { $ref: '$.input.thread.community' },
        body: { $ref: '$.steps.draft.output.body' },
        metadata: {
          threadTitle: { $ref: '$.input.thread.title' },
          // Carried so the CRM write-back can try to match the thread's author
          // to a known contact. Part of the approved payload, so what gets
          // attributed is visible to whoever approves it.
          threadAuthor: { $ref: '$.input.thread.author' },
          relevanceScore: { $ref: '$.input.relevanceScore' },
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
    thread: { $ref: '$.input.thread' }
  },
  source: { type: 'builtin' }
};

registerPlaybook(auditLedOutreachPlaybook);
registerPlaybook(communityOutreachPlaybook);
registerPlaybook(threadReplyPlaybook);

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
  return listPlaybooks()
    .filter((playbook) => playbook.id === id)
    .sort((a, b) => b.version.localeCompare(a.version))[0];
}

export function listPlaybooks(): PlaybookDefinition[] {
  return [...playbooks.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version)
  );
}

export async function seedPlaybooks(db: Db, now: Date = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const playbook of listPlaybooks()) {
    const source = playbook.source ?? { type: 'builtin' as const };
    await db
      .prepare(
        `
      INSERT INTO playbooks (
        playbook_key,version,name,description,input_schema_json,definition_json,
        source_type,source_ref,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (playbook_key,version) DO UPDATE SET
        name=excluded.name,description=excluded.description,input_schema_json=excluded.input_schema_json,
        definition_json=excluded.definition_json,source_type=excluded.source_type,
        source_ref=excluded.source_ref,updated_at=excluded.updated_at
    `
      )
      .run(
        playbook.id,
        playbook.version,
        playbook.name,
        playbook.description,
        JSON.stringify(
          zodToJsonSchema(playbook.inputSchema, { target: 'jsonSchema7', $refStrategy: 'none' })
        ),
        JSON.stringify(publicDefinition(playbook)),
        source.type,
        source.ref ?? null,
        timestamp,
        timestamp
      );
  }
}

export async function listWorkspacePlaybooks(db: Db, workspaceId: string) {
  const rows = await db
    .prepare(
      `
    SELECT p.playbook_key,p.version,p.name,p.description,p.input_schema_json,p.definition_json,
      p.source_type,p.source_ref,p.enabled AS registry_enabled,
      COALESCE(wp.enabled,TRUE) AS workspace_enabled,wp.pinned_version,wp.config_json
    FROM playbooks p
    LEFT JOIN workspace_playbooks wp ON wp.workspace_id=? AND wp.playbook_key=p.playbook_key
    ORDER BY p.playbook_key,p.version DESC
  `
    )
    .all<Record<string, unknown>>(workspaceId);
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
  if (!playbook.id || !playbook.version || !playbook.name)
    throw new Error('Playbook id, version, and name are required');
  const ids = new Set<string>();
  for (const step of playbook.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate playbook step: ${step.id}`);
    if (step.type === 'action' && !/^[a-z][a-z0-9_.-]{2,119}$/.test(step.actionType)) {
      throw new Error(`Invalid playbook action type: ${step.actionType}`);
    }
    for (const dependency of step.needs ?? []) {
      if (!ids.has(dependency))
        throw new Error(`Playbook step ${step.id} depends on unknown or later step ${dependency}`);
    }
    ids.add(step.id);
  }
}

function registryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
