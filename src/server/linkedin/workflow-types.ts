import { z } from 'zod';

export const outreachDelaySchema=z.object({amount:z.number().int().min(0).max(8760),unit:z.enum(['hours','days'])});
export const outreachStepSchema=z.object({
 id:z.string().min(1).max(80),
 kind:z.enum(['invite','withdraw','profile_view','message','manual_message','follow']),
 delay:outreachDelaySchema,
 config:z.record(z.unknown()).default({})
});
export const outreachWorkflowSchema=z.object({version:z.literal(1),steps:z.array(outreachStepSchema).min(1).max(30)});
export type OutreachWorkflow=z.infer<typeof outreachWorkflowSchema>;
