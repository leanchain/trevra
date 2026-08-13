import { z } from 'zod';

export const outreachDelaySchema = z.object({
  amount: z.number().int().min(0).max(8760),
  unit: z.enum(['hours', 'days'])
}).strict();

const variantSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/, 'Variant ids may contain letters, numbers, _ and - only.'),
  body: z.string().trim().min(1).max(8000),
  weight: z.number().int().min(1).max(100)
}).strict();

const messageConfigSchema = z.object({
  /** Persisted once per member; execution never re-rolls a variant. */
  variants: z.array(variantSchema).min(1).max(2),
  /** A campaign message defaults to first-degree connections only. */
  requireConnection: z.boolean().default(true)
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, variant] of value.variants.entries()) {
    if (ids.has(variant.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants', index, 'id'], message: `Variant id '${variant.id}' is repeated.` });
    }
    ids.add(variant.id);
  }
  const total = value.variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (total !== 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants'], message: `Variant weights must total 100; received ${total}.` });
  }
});

const inviteConfigSchema = z.object({
  note: z.string().trim().max(300).optional().default('')
}).strict();

const withdrawConfigSchema = z.object({
  /** The step may only target the campaign member's own outstanding invite. */
  olderThanDays: z.number().int().min(1).max(365).default(21)
}).strict();

const passiveConfigSchema = z.object({}).strict();
const manualMessageConfigSchema = messageConfigSchema.and(z.object({
  taskTitle: z.string().trim().min(1).max(160).default('Send LinkedIn message manually')
}).strict());

const baseStep = {
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, 'Step ids may contain letters, numbers, _ and - only.'),
  delay: outreachDelaySchema
};

export const outreachStepSchema = z.discriminatedUnion('kind', [
  z.object({ ...baseStep, kind: z.literal('invite'), config: inviteConfigSchema.default({}) }).strict(),
  z.object({ ...baseStep, kind: z.literal('withdraw'), config: withdrawConfigSchema.default({}) }).strict(),
  z.object({ ...baseStep, kind: z.literal('profile_view'), config: passiveConfigSchema.default({}) }).strict(),
  z.object({ ...baseStep, kind: z.literal('message'), config: messageConfigSchema }).strict(),
  z.object({ ...baseStep, kind: z.literal('manual_message'), config: manualMessageConfigSchema }).strict(),
  z.object({ ...baseStep, kind: z.literal('follow'), config: passiveConfigSchema.default({}) }).strict()
]);

export const outreachWorkflowSchema = z.object({
  version: z.literal(1),
  steps: z.array(outreachStepSchema).min(1).max(30)
}).strict().superRefine((workflow, ctx) => {
  const ids = new Set<string>();
  let invites = 0;
  for (const [index, step] of workflow.steps.entries()) {
    if (ids.has(step.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'id'], message: `Step id '${step.id}' is repeated.` });
    }
    ids.add(step.id);
    if (step.kind === 'invite') invites += 1;
  }
  if (invites > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'A workflow may contain at most one connection request per person.' });
  }
});

export type OutreachWorkflow = z.infer<typeof outreachWorkflowSchema>;
export type OutreachWorkflowStep = z.infer<typeof outreachStepSchema>;
export type OutreachMessageVariant = z.infer<typeof variantSchema>;
