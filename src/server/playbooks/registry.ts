import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Db } from '../db.js';
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

registerPlaybook(auditLedOutreachPlaybook);
registerPlaybook(invoiceDeliveredWorkPlaybook);
registerPlaybook(protectScopePlaybook);

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
