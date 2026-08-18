import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';

/**
 * The merge fields a managed-workflow template may use.
 *
 * THE CLOSED SET, and closed is the point: `unsupportedVariables` refuses
 * anything else at SAVE time, so a typo is a rejection naming the field rather
 * than the literal string `{{fistName}}` arriving in a stranger's inbox. Same
 * rule, same reason, as `sequence.ts` SUPPORTED_MERGE_FIELDS.
 *
 * EMAIL, PHONE AND COUNTRY ARE HERE BECAUSE THE DATA ALREADY IS. Migration 046
 * gives `linkedin_lead_contacts` an `email`, a `phone` and a `country`; the CSV
 * importer parses all three, the contact editor writes them and the lead table
 * renders them -- and until now not one of them could reach a message. Three
 * columns of data an operator had already supplied, with no way to use them.
 *
 * Canonically SNAKE_CASE, with camelCase accepted as an alias (see
 * {@link MANAGER_VARIABLE_ALIASES}).
 */
export const MANAGER_VARIABLES = [
  'first_name',
  'last_name',
  'company',
  'email',
  'phone',
  'country'
] as const;
export type ManagerVariable = (typeof MANAGER_VARIABLES)[number];

/**
 * camelCase spellings that mean the same field.
 *
 * TWO SPELLINGS EXIST IN THIS PRODUCT AND BOTH ARE DOCUMENTED. `sequence.ts`
 * SUPPORTED_MERGE_FIELDS is camelCase (`{{firstName}}`, `{{lastName}}`) and
 * that path is older, so a template author copying a line out of a sequence
 * into a workflow -- exactly what the two screens invite -- wrote
 * `{{firstName}}` and got it refused at save time, or worse, delivered
 * verbatim by any renderer that leaves unknown tokens standing.
 *
 * Aliased rather than added to {@link MANAGER_VARIABLES}: there is ONE
 * canonical name per field, the picker offers it, and the alias exists so the
 * other spelling is understood rather than so the set has two members. Only
 * the three fields `sequence.ts` shares with this path are listed, and only
 * two of them need an entry -- `company` is spelled identically in both.
 */
export const MANAGER_VARIABLE_ALIASES: Readonly<Record<string, ManagerVariable>> = {
  firstName: 'first_name',
  lastName: 'last_name'
};

/** The canonical field `name` refers to, in either spelling, or null when it is not one. */
export function resolveManagerVariable(name: string): ManagerVariable | null {
  if ((MANAGER_VARIABLES as readonly string[]).includes(name)) return name as ManagerVariable;
  return MANAGER_VARIABLE_ALIASES[name] ?? null;
}

export const workflowDelaySchema = z
  .object({
    amount: z.number().int().min(0).max(2160),
    unit: z.enum(['hours', 'days'])
  })
  .strict();
export type WorkflowDelay = z.infer<typeof workflowDelaySchema>;

/**
 * How many message versions ONE A/B step may carry.
 *
 * FOUR, and the ceiling is the READ rather than the storage. The results panel
 * holds every arm to `MIN_VARIANT_SENDS` (20) messages before it will name a
 * leader, because naming one off a handful of sends is noise wearing a chip.
 * Four arms therefore costs 80 sends of a single step before the comparison
 * says anything at all -- at the daily message allowance a warmed seat runs
 * at, most of a fortnight. A fifth arm buys a split nobody lives long enough
 * to read, so the schema stops here and the builder says so on the card.
 *
 * RAISING THIS IS SAFE FOR STORED WORKFLOWS AND LOWERING IT IS NOT. Every
 * 1- and 2-variant workflow already in `linkedin_workflows.steps_json` -- and
 * every campaign snapshot in `linkedin_campaigns.sequence_json`, which is what
 * a running campaign actually executes -- still parses unchanged, because the
 * bound is a maximum and nothing about it is migrated.
 */
export const MESSAGE_VARIANT_MAX = 4;

const variantSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    body: z.string().min(1).max(8000),
    weight: z.number().int().min(1).max(100).default(50)
  })
  .strict();

const common = {
  id: z.string().trim().min(1).max(64),
  delayBefore: workflowDelaySchema.default({ amount: 0, unit: 'hours' as const })
};

export const workflowStepSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('connection_request'),
      config: z.object({ message: z.string().max(300).nullable().optional() }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('withdraw_pending'),
      config: z.object({ afterDays: z.number().int().min(1).max(90) }).strict()
    })
    .strict(),
  z
    .object({ ...common, action: z.literal('profile_view'), config: z.object({}).strict() })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('message'),
      config: z
        .object({
          variants: z.array(variantSchema).min(1).max(MESSAGE_VARIANT_MAX),
          requiresAcceptedConnection: z.boolean().optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('manual_message'),
      config: z.object({ suggestedTemplate: z.string().max(8000).nullable().optional() }).strict()
    })
    .strict(),
  z.object({ ...common, action: z.literal('follow'), config: z.object({}).strict() }).strict()
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowStepsSchema = z
  .array(workflowStepSchema)
  .min(1)
  .max(50)
  .superRefine((steps, ctx) => {
    const ids = new Set<string>();
    let inviteSeen = false;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (ids.has(step.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Step id '${step.id}' is duplicated.`
        });
      ids.add(step.id);
      if (step.action === 'connection_request') inviteSeen = true;
      if (step.action === 'withdraw_pending' && !inviteSeen) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Withdraw-pending must come after a connection request.'
        });
      }
      if (step.action === 'message') {
        if (step.config.requiresAcceptedConnection && !inviteSeen) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config', 'requiresAcceptedConnection'],
            message: 'A message that waits for acceptance must come after a connection request.'
          });
        }
        const variantIds = new Set(step.config.variants.map((variant) => variant.id));
        if (variantIds.size !== step.config.variants.length)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config', 'variants'],
            message: 'A/B variant ids must be unique.'
          });
      }
      for (const template of templatesOf(step)) {
        const bad = unsupportedVariables(template);
        if (bad.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config'],
            message: `Unsupported variable(s): ${bad.map((name) => `{{${name}}}`).join(', ')}. Supported: ${MANAGER_VARIABLES.map((name) => `{{${name}}}`).join(', ')}.`
          });
        }
      }
    }
  });

function templatesOf(step: WorkflowStep): string[] {
  if (step.action === 'connection_request') return step.config.message ? [step.config.message] : [];
  if (step.action === 'message') return step.config.variants.map((variant) => variant.body);
  if (step.action === 'manual_message')
    return step.config.suggestedTemplate ? [step.config.suggestedTemplate] : [];
  return [];
}

/**
 * Tokens in `template` that name no merge field, in EITHER spelling.
 *
 * Still a refusal at save time and not a warning at send time -- that is the
 * whole contract, and widening the accepted set does not soften it: a name
 * that is neither a canonical field nor an alias is still reported here, and
 * `workflowStepsSchema` still rejects the save.
 */
export function unsupportedVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (resolveManagerVariable(match[1]) === null) found.add(match[1]);
  }
  return [...found];
}

export function delayMilliseconds(delay: WorkflowDelay): number {
  const hours = delay.unit === 'days' ? delay.amount * 24 : delay.amount;
  return hours * 3_600_000;
}

/**
 * The contact fields a template can merge from.
 *
 * The three optional ones are optional on the CONTACT too -- a CSV without an
 * email column produces rows with a null email -- so every caller can pass
 * what it has rather than inventing blanks.
 */
export interface WorkflowMergeLead {
  firstName: string;
  lastName: string;
  company: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
}

/**
 * Fill a template's merge fields.
 *
 * EMPTY-SAFE, never null-safe-looking: a contact with no phone renders the
 * empty string, not the word "null" and not the literal `{{phone}}`. A KNOWN
 * field with no value is a blank; only an UNKNOWN token is left standing, and
 * it is left standing on purpose -- the same choice `export.ts`
 * `applyMergeFields` makes, so a name that somehow got past the save-time
 * refusal is VISIBLE rather than silently blanked.
 *
 * Both spellings resolve here, so a `{{firstName}}` copied out of a sequence
 * renders instead of arriving verbatim.
 */
export function renderWorkflowTemplate(template: string, lead: WorkflowMergeLead): string {
  const values: Record<ManagerVariable, string> = {
    first_name: lead.firstName ?? '',
    last_name: lead.lastName ?? '',
    company: lead.company ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    country: lead.country ?? ''
  };
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const canonical = resolveManagerVariable(name);
    return canonical === null ? whole : values[canonical];
  });
}

/**
 * Stable A/B assignment: the same campaign member never changes variant after a retry.
 *
 * SEEDED, NOT RANDOM, and at any arm count. The draw is a hash of the caller's
 * `member:step` seed laid against the arms' CUMULATIVE weights, so two things
 * hold that a `Math.random()` split cannot: a retried tick re-derives the same
 * arm for the same member (the runner also persists the choice in
 * `assigned_variants`, so this is the second of two guarantees, not the only
 * one), and the split honours whatever integer weights the operator typed
 * without them having to sum to anything in particular -- the total is taken
 * from the arms themselves. 25/25/25/25 and 1/1/1/1 are the same split.
 */
export function chooseMessageVariant(
  variants: Extract<WorkflowStep, { action: 'message' }>['config']['variants'],
  seed: string
): { id: string; body: string; weight: number } {
  if (variants.length === 1) return variants[0];
  const total = variants.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  // Weights are `min(1)` in the schema, so this is unreachable through a saved
  // workflow -- and `% 0` is NaN, which would fall through every arm and read
  // as a silent "last variant wins" instead of as the bad input it is.
  if (total <= 0) return variants[0];
  const sample =
    Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += Math.max(0, variant.weight);
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

/**
 * Steps out of a STORED SNAPSHOT, never throwing.
 *
 * The strict {@link parseSteps} above is for `linkedin_workflows.steps_json`,
 * which this module wrote and validated on the way in. This one is for
 * `linkedin_campaigns.sequence_json`, which also holds the legacy playbook
 * sequences (`campaigns.ts`) in a completely different shape -- so "not a
 * managed workflow" is a normal answer here, not an error, and it must not
 * take a campaign list down.
 */
export function parseWorkflowSteps(value: unknown): WorkflowStep[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  const parsed = workflowStepsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function toWorkflow(row: WorkflowRow): LinkedInWorkflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    steps: parseSteps(row.steps_json),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listWorkflows(db: Db, workspaceId: string): Promise<LinkedInWorkflow[]> {
  const rows = await db
    .prepare(
      `SELECT id,workspace_id,name,steps_json,version,created_at,updated_at FROM linkedin_workflows WHERE workspace_id=? ORDER BY updated_at DESC`
    )
    .all<WorkflowRow>(workspaceId);
  return rows.map(toWorkflow);
}

export async function getWorkflow(
  db: Db,
  workspaceId: string,
  workflowId: string
): Promise<LinkedInWorkflow | undefined> {
  const row = await db
    .prepare(
      `SELECT id,workspace_id,name,steps_json,version,created_at,updated_at FROM linkedin_workflows WHERE workspace_id=? AND id=?`
    )
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
  const row = await db
    .prepare(
      `
    INSERT INTO linkedin_workflows (id,workspace_id,name,steps_json,version,created_at,updated_at)
    VALUES (?,?,?,?::jsonb,1,?,?)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      steps_json=EXCLUDED.steps_json,
      version=linkedin_workflows.version+1,
      updated_at=EXCLUDED.updated_at
    WHERE linkedin_workflows.workspace_id=EXCLUDED.workspace_id
    RETURNING id,workspace_id,name,steps_json,version,created_at,updated_at
  `
    )
    .get<WorkflowRow>(
      workflowId,
      input.workspaceId,
      name,
      JSON.stringify(steps),
      timestamp,
      timestamp
    );
  if (!row) throw new Error('Workflow not found in this workspace.');
  return toWorkflow(row);
}

export async function deleteWorkflow(
  db: Db,
  workspaceId: string,
  workflowId: string
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM linkedin_workflows WHERE workspace_id=? AND id=?')
    .run(workspaceId, workflowId);
  return result.changes > 0;
}
