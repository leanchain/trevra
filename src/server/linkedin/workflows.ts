import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';

export const MANAGER_VARIABLES = ['first_name', 'last_name', 'company'] as const;
export type ManagerVariable = (typeof MANAGER_VARIABLES)[number];

export const workflowDelaySchema = z.object({
  amount: z.number().int().min(0).max(2160),
  unit: z.enum(['hours', 'days'])
}).strict();
export type WorkflowDelay = z.infer<typeof workflowDelaySchema>;

const variantSchema = z.object({
  id: z.string().trim().min(1).max(40),
  body: z.string().min(1).max(8000),
  weight: z.number().int().min(1).max(100).default(50)
}).strict();

const common = {
  id: z.string().trim().min(1).max(64),
  delayBefore: workflowDelaySchema.default({ amount: 0, unit: 'hours' as const })
};

export const workflowStepSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('connection_request'), config: z.object({ message: z.string().max(300).nullable().optional() }).strict() }).strict(),
  z.object({ ...common, action: z.literal('withdraw_pending'), config: z.object({ afterDays: z.number().int().min(1).max(90) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('profile_view'), config: z.object({}).strict() }).strict(),
  z.object({ ...common, action: z.literal('message'), config: z.object({ variants: z.array(variantSchema).min(1).max(2) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('manual_message'), config: z.object({ suggestedTemplate: z.string().max(8000).nullable().optional() }).strict() }).strict(),
  z.object({ ...common, action: z.literal('follow'), config: z.object({}).strict() }).strict()
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowStepsSchema = z.array(workflowStepSchema).min(1).max(50).superRefine((steps, ctx) => {
  const ids = new Set<string>();
  let inviteSeen = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (ids.has(step.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `Step id '${step.id}' is duplicated.` });
    ids.add(step.id);
    if (step.action === 'connection_request') inviteSeen = true;
    if (step.action === 'withdraw_pending' && !inviteSeen) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Withdraw-pending must come after a connection request.' });
    }
    if (step.action === 'message') {
      const variantIds = new Set(step.config.variants.map((variant) => variant.id));
      if (variantIds.size !== step.config.variants.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'config', 'variants'], message: 'A/B variant ids must be unique.' });
    }
    for (const template of templatesOf(step)) {
      const bad = unsupportedVariables(template);
      if (bad.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'config'], message: `Unsupported variable(s): ${bad.map((name) => `{{${name}}}`).join(', ')}. Supported: ${MANAGER_VARIABLES.map((name) => `{{${name}}}`).join(', ')}.` });
      }
    }
  }
});

function templatesOf(step: WorkflowStep): string[] {
  if (step.action === 'connection_request') return step.config.message ? [step.config.message] : [];
  if (step.action === 'message') return step.config.variants.map((variant) => variant.body);
  if (step.action === 'manual_message') return step.config.suggestedTemplate ? [step.config.suggestedTemplate] : [];
  return [];
}

export function unsupportedVariables(template: string): string[] {
  const allowed = new Set<string>(MANAGER_VARIABLES);
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (!allowed.has(match[1])) found.add(match[1]);
  }
  return [...found];
}

export function delayMilliseconds(delay: WorkflowDelay): number {
  const hours = delay.unit === 'days' ? delay.amount * 24 : delay.amount;
  return hours * 3_600_000;
}

export interface WorkflowMergeLead { firstName: string; lastName: string; company: string }

export function renderWorkflowTemplate(template: string, lead: WorkflowMergeLead): string {
  const values: Record<ManagerVariable, string> = {
    first_name: lead.firstName,
    last_name: lead.lastName,
    company: lead.company
  };
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name as ManagerVariable] : whole
  );
}

/** Stable A/B assignment: the same campaign member never changes variant after a retry. */
export function chooseMessageVariant(
  variants: Extract<WorkflowStep, { action: 'message' }>['config']['variants'],
  seed: string
): { id: string; body: string; weight: number } {
  if (variants.length === 1) return variants[0];
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const sample = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weight;
    if (sample < cursor) return variant;
  }
  return variants[variants.length - 1];
}

export interface LinkedInWorkflow {
  id: string;
  workspaceId: string;
  name: string;
  steps: WorkflowStep[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  steps_json: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

function parseSteps(value: unknown): WorkflowStep[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return workflowStepsSchema.parse(raw);
}

function toWorkflow(row: WorkflowRow): LinkedInWorkflow {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, steps: parseSteps(row.steps_json), version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function listWorkflows(db: Db, workspaceId: string): Promise<LinkedInWorkflow[]> {
  const rows = await db.prepare(`SELECT id,workspace_id,name,steps_json,version,created_at,updated_at FROM linkedin_workflows WHERE workspace_id=? ORDER BY updated_at DESC`)
    .all<WorkflowRow>(workspaceId);
  return rows.map(toWorkflow);
}

export async function getWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<LinkedInWorkflow | undefined> {
  const row = await db.prepare(`SELECT id,workspace_id,name,steps_json,version,created_at,updated_at FROM linkedin_workflows WHERE workspace_id=? AND id=?`)
    .get<WorkflowRow>(workspaceId, workflowId);
  return row ? toWorkflow(row) : undefined;
}

export async function saveWorkflow(
  db: Db,
  input: { workspaceId: string; id?: string; name: string; steps: unknown },
  now: Date = new Date()
): Promise<LinkedInWorkflow> {
  const name = input.name.trim();
  if (!name) throw new Error('Workflow name is required.');
  const steps = workflowStepsSchema.parse(input.steps);
  const workflowId = input.id ?? id('liwf');
  const timestamp = now.toISOString();
  const row = await db.prepare(`
    INSERT INTO linkedin_workflows (id,workspace_id,name,steps_json,version,created_at,updated_at)
    VALUES (?,?,?,?::jsonb,1,?,?)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      steps_json=EXCLUDED.steps_json,
      version=linkedin_workflows.version+1,
      updated_at=EXCLUDED.updated_at
    WHERE linkedin_workflows.workspace_id=EXCLUDED.workspace_id
    RETURNING id,workspace_id,name,steps_json,version,created_at,updated_at
  `).get<WorkflowRow>(workflowId, input.workspaceId, name, JSON.stringify(steps), timestamp, timestamp);
  if (!row) throw new Error('Workflow not found in this workspace.');
  return toWorkflow(row);
}

export async function deleteWorkflow(db: Db, workspaceId: string, workflowId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM linkedin_workflows WHERE workspace_id=? AND id=?').run(workspaceId, workflowId);
  return result.changes > 0;
}
