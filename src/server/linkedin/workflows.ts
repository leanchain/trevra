import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';
import { actionKindSupportsBranch } from './branching.js';
import type { LinkedInActionKind } from './actions.js';

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

export const workflowSlaSchema = workflowDelaySchema.refine((value) => value.amount > 0, {
  path: ['amount'],
  message: 'SLA must be at least one hour or day.'
});

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

export const workflowVariantSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    body: z.string().max(8000),
    weight: z.number().int().min(1).max(100).default(50),
    attachmentUrl: z.string().url().max(2000).nullable().optional(),
    attachmentName: z.string().trim().max(255).nullable().optional(),
    mediaKind: z.enum(['file', 'gif', 'voice']).nullable().optional()
  })
  .strict();
export type WorkflowVariant = z.infer<typeof workflowVariantSchema>;

const workflowConditionKindSchema = z.enum([
  'connected',
  'accepted',
  'replied',
  'open_profile',
  'email_available',
  'email_opened',
  'email_clicked',
  'email_bounced',
  'email_replied',
  'email_found'
]);
export type WorkflowConditionKind = z.infer<typeof workflowConditionKindSchema>;

export const workflowConditionSchema = z
  .object({
    kind: workflowConditionKindSchema,
    ofStepId: z.string().trim().min(1).max(64).nullable().optional()
  })
  .strict();
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

const stepId = z.string().trim().min(1).max(64);
const common = {
  id: stepId,
  delayBefore: workflowDelaySchema.default({ amount: 0, unit: 'hours' as const }),
  /** Optional target time after this step becomes due. It changes priority, never safety capacity. */
  sla: workflowSlaSchema.optional(),
  /** Explicit graph edge. Omitted preserves the legacy next-array-item behavior. */
  nextStepId: stepId.nullable().optional()
};

export const workflowStepSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('connection_request'),
      config: z
        .object({
          // `message` remains readable for every workflow saved before invite A/B existed.
          message: z.string().max(300).nullable().optional(),
          variants: z
            .array(workflowVariantSchema.extend({ body: z.string().max(300) }))
            .min(1)
            .max(MESSAGE_VARIANT_MAX)
            .optional()
        })
        .strict()
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
          variants: z
            .array(
              workflowVariantSchema.refine(
                (variant) => variant.body.trim().length > 0,
                'Message body is required.'
              )
            )
            .min(1)
            .max(MESSAGE_VARIANT_MAX),
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
  z.object({ ...common, action: z.literal('follow'), config: z.object({}).strict() }).strict(),
  z.object({ ...common, action: z.literal('unfollow'), config: z.object({}).strict() }).strict(),
  z
    .object({
      ...common,
      action: z.literal('disconnect'),
      config: z.object({ acknowledgeDestructive: z.literal(true) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('follow_company'),
      config: z.object({ companyUrl: z.string().url().max(2000) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('like_company_post'),
      config: z.object({ companyUrl: z.string().url().max(2000) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('invite_to_follow_company'),
      config: z.object({ companyUrl: z.string().url().max(2000) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('invite_to_event'),
      config: z.object({ eventUrl: z.string().url().max(2000) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('invite_to_group'),
      config: z.object({ groupUrl: z.string().url().max(2000) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('group_message'),
      config: z
        .object({
          groupUrl: z.string().url().max(2000),
          variants: z.array(workflowVariantSchema).min(1).max(MESSAGE_VARIANT_MAX)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('event_message'),
      config: z
        .object({
          eventUrl: z.string().url().max(2000),
          variants: z.array(workflowVariantSchema).min(1).max(MESSAGE_VARIANT_MAX)
        })
        .strict()
    })
    .strict(),
  z.object({ ...common, action: z.literal('like_post'), config: z.object({}).strict() }).strict(),
  z
    .object({
      ...common,
      action: z.literal('endorse_skills'),
      config: z.object({ maxSkills: z.number().int().min(1).max(10).default(3) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('wait'),
      config: z.object({ duration: workflowDelaySchema }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('condition'),
      config: z
        .object({ condition: workflowConditionSchema, yesStepId: stepId, noStepId: stepId })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('monitor'),
      config: z
        .object({
          condition: workflowConditionSchema,
          timeout: workflowDelaySchema,
          pollEveryMinutes: z.number().int().min(5).max(1440).default(60),
          yesStepId: stepId,
          noStepId: stepId
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('end'),
      config: z
        .object({
          outcome: z
            .enum(['completed', 'replied', 'not_accepted', 'manual', 'excluded'])
            .default('completed')
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('inmail'),
      config: z
        .object({
          subject: z.string().trim().min(1).max(200),
          variants: z.array(workflowVariantSchema).min(1).max(MESSAGE_VARIANT_MAX),
          allowPaid: z.boolean().default(false)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('email'),
      config: z
        .object({
          subject: z.string().trim().min(1).max(998),
          variants: z.array(workflowVariantSchema).min(1).max(MESSAGE_VARIANT_MAX),
          threaded: z.boolean().default(true),
          tracking: z.enum(['off', 'opens', 'opens_clicks']).default('off')
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('find_email'),
      config: z
        .object({
          providerId: z.string().trim().min(1).max(120).nullable().optional(),
          refresh: z.boolean().default(false)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('add_tag'),
      config: z.object({ tag: z.string().trim().min(1).max(100) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('remove_tag'),
      config: z.object({ tag: z.string().trim().min(1).max(100) }).strict()
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('manual_comment'),
      config: z
        .object({
          suggestedTemplate: z.string().max(3000).nullable().optional(),
          postUrl: z.string().url().max(2000).nullable().optional()
        })
        .strict()
    })
    .strict()
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

function workflowLinkedInResultKind(
  step: WorkflowStep | null | undefined
): LinkedInActionKind | null {
  if (!step) return null;
  switch (step.action) {
    case 'connection_request':
      return 'invite';
    case 'message':
      return 'dm';
    case 'inmail':
      return 'inmail';
    case 'group_message':
      return 'group_message';
    case 'event_message':
      return 'event_message';
    default:
      return null;
  }
}

export const workflowStepsSchema = z
  .array(workflowStepSchema)
  .min(1)
  .max(100)
  .superRefine((steps, ctx) => {
    const ids = new Set<string>();
    const indexById = new Map<string, number>();
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
      indexById.set(step.id, index);
      if (step.action === 'connection_request') inviteSeen = true;
      if (step.action === 'withdraw_pending' && !inviteSeen)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Withdraw-pending must come after a connection request.'
        });
      if (step.action === 'message') {
        if (step.config.requiresAcceptedConnection && !inviteSeen)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config', 'requiresAcceptedConnection'],
            message: 'A message that waits for acceptance must come after a connection request.'
          });
        const variantIds = new Set(step.config.variants.map((variant) => variant.id));
        if (variantIds.size !== step.config.variants.length)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config', 'variants'],
            message: 'A/B variant ids must be unique.'
          });
      }
      if (step.action === 'connection_request' && step.config.variants) {
        const variantIds = new Set(step.config.variants.map((variant) => variant.id));
        if (variantIds.size !== step.config.variants.length)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config', 'variants'],
            message: 'Invite A/B variant ids must be unique.'
          });
      }
      for (const template of templatesOf(step)) {
        const bad = unsupportedVariables(template);
        if (bad.length > 0)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config'],
            message: `Unsupported variable(s): ${bad.map((name) => `{{${name}}}`).join(', ')}. Built-ins: ${MANAGER_VARIABLES.map((name) => `{{${name}}}`).join(', ')}; custom fields use {{custom.field_name}}.`
          });
      }
    }

    const targetsOf = (step: WorkflowStep, index: number): string[] => {
      if (step.action === 'end') return [];
      if (step.action === 'condition' || step.action === 'monitor')
        return [step.config.yesStepId, step.config.noStepId];
      if (step.nextStepId === null) return [];
      if (step.nextStepId) return [step.nextStepId];
      return steps[index + 1] ? [steps[index + 1].id] : [];
    };
    const graphMode = steps.some(
      (step) =>
        step.action === 'condition' ||
        step.action === 'monitor' ||
        step.action === 'end' ||
        step.action === 'wait' ||
        step.nextStepId !== undefined
    );
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      for (const target of targetsOf(step, index)) {
        const targetIndex = indexById.get(target);
        if (targetIndex === undefined)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config'],
            message: `Step '${step.id}' points to missing step '${target}'.`
          });
        else if (targetIndex <= index)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'config'],
            message: `Step '${step.id}' points backward to '${target}'. Managed workflows are acyclic.`
          });
      }
      if (graphMode && step.action !== 'end' && targetsOf(step, index).length === 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Step '${step.id}' has no reachable next step. Add an End node.`
        });
      if (step.action === 'condition' || step.action === 'monitor') {
        const condition = step.config.condition;
        if (['accepted', 'replied'].includes(condition.kind)) {
          if (!condition.ofStepId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'config', 'condition'],
              message: `${condition.kind} needs an earlier result-bearing step.`
            });
          } else {
            const referencedIndex = indexById.get(condition.ofStepId);
            const referenced = referencedIndex === undefined ? null : steps[referencedIndex];
            const linkedInKind = workflowLinkedInResultKind(referenced);
            const valid =
              condition.kind === 'accepted'
                ? linkedInKind !== null && actionKindSupportsBranch(linkedInKind, 'accepted')
                : referenced?.action === 'email' ||
                  (linkedInKind !== null && actionKindSupportsBranch(linkedInKind, 'replied'));
            if (referencedIndex === undefined || referencedIndex >= index || !valid)
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'config', 'condition'],
                message: `${condition.kind} must reference an earlier ${condition.kind === 'accepted' ? 'connection request' : 'message'} step.`
              });
          }
        }
      }
    }

    // Reachability is checked after references. A disconnected lane is almost always an editor mistake.
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const index = indexById.get(id);
      if (index === undefined) return;
      for (const target of targetsOf(steps[index], index)) visit(target);
    };
    visit(steps[0]?.id ?? '');
    steps.forEach((step, index) => {
      const community = expectedCommunityUrl(step);
      if (community && !isExpectedCommunityUrl(community.kind, community.url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'config'],
          message: `Step '${step.id}' needs a LinkedIn ${community.kind} URL.`
        });
      }
      if (!reachable.has(step.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Step '${step.id}' is unreachable from the workflow start.`
        });
    });
  });

function expectedCommunityUrl(
  step: WorkflowStep
): { kind: 'company' | 'event' | 'group'; url: string } | null {
  if (
    step.action === 'follow_company' ||
    step.action === 'like_company_post' ||
    step.action === 'invite_to_follow_company'
  )
    return { kind: 'company', url: step.config.companyUrl };
  if (step.action === 'invite_to_event' || step.action === 'event_message')
    return { kind: 'event', url: step.config.eventUrl };
  if (step.action === 'invite_to_group' || step.action === 'group_message')
    return { kind: 'group', url: step.config.groupUrl };
  return null;
}

function isExpectedCommunityUrl(kind: 'company' | 'event' | 'group', raw: string): boolean {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())
    )
      return false;
    const rule =
      kind === 'company'
        ? /^\/company\/[^/]+/i
        : kind === 'event'
          ? /^\/events\/[^/]+/i
          : /^\/groups\/[^/]+/i;
    return rule.test(url.pathname);
  } catch {
    return false;
  }
}

function templatesOf(step: WorkflowStep): string[] {
  if (step.action === 'connection_request')
    return (
      step.config.variants?.map((variant) => variant.body) ??
      (step.config.message ? [step.config.message] : [])
    );
  if (
    step.action === 'message' ||
    step.action === 'group_message' ||
    step.action === 'event_message'
  )
    return step.config.variants.map((variant) => variant.body);
  if (step.action === 'email' || step.action === 'inmail')
    return [step.config.subject, ...step.config.variants.map((variant) => variant.body)];
  if (step.action === 'manual_message' || step.action === 'manual_comment')
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
export interface WorkflowDiagnostic {
  code:
    | 'too_many_touches'
    | 'repeated_action_bottleneck'
    | 'missing_reply_monitor'
    | 'missing_invite_cleanup'
    | 'missing_variable_coverage';
  severity: 'warning' | 'info';
  message: string;
  stepIds: string[];
}

export interface WorkflowVariableCoverage {
  present: number;
  total: number;
}

/** Canonical built-in/custom merge variables used anywhere in a workflow. */
export function workflowMergeVariables(steps: readonly WorkflowStep[]): string[] {
  const found = new Set<string>();
  for (const step of steps) {
    for (const template of templatesOf(step)) {
      for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g)) {
        const raw = match[1];
        if (raw.startsWith('custom.') && raw.length > 7) found.add(raw);
        else {
          const canonical = resolveManagerVariable(raw);
          if (canonical) found.add(canonical);
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Advisory sequence diagnostics. They never rewrite a workflow and never make
 * an otherwise-valid graph invalid; they exist to surface operational debt
 * before a large audience is admitted into it.
 */
export function diagnoseWorkflow(
  steps: readonly WorkflowStep[],
  variableCoverage: Readonly<Record<string, WorkflowVariableCoverage>> = {}
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const touchActions = new Set<WorkflowStep['action']>([
    'profile_view',
    'connection_request',
    'message',
    'manual_message',
    'follow',
    'unfollow',
    'disconnect',
    'follow_company',
    'like_company_post',
    'invite_to_follow_company',
    'invite_to_event',
    'invite_to_group',
    'group_message',
    'event_message',
    'like_post',
    'endorse_skills',
    'inmail',
    'email',
    'manual_comment'
  ]);
  const touchSteps = steps.filter((step) => touchActions.has(step.action));
  if (touchSteps.length > 8) {
    diagnostics.push({
      code: 'too_many_touches',
      severity: 'warning',
      message: `This workflow contains ${touchSteps.length} outreach touches. Long sequences consume downstream capacity and can feel repetitive; consider whether every touch earns its place.`,
      stepIds: touchSteps.map((step) => step.id)
    });
  }

  const repeated: Array<{ label: string; actions: WorkflowStep['action'][]; threshold: number }> = [
    {
      label: 'message',
      actions: ['message', 'inmail', 'email', 'group_message', 'event_message'],
      threshold: 4
    },
    { label: 'Like', actions: ['like_post', 'like_company_post'], threshold: 2 },
    { label: 'endorsement', actions: ['endorse_skills'], threshold: 2 },
    {
      label: 'invite',
      actions: [
        'connection_request',
        'invite_to_follow_company',
        'invite_to_event',
        'invite_to_group'
      ],
      threshold: 2
    }
  ];
  for (const spec of repeated) {
    const matches = steps.filter((step) => spec.actions.includes(step.action));
    if (matches.length >= spec.threshold) {
      diagnostics.push({
        code: 'repeated_action_bottleneck',
        severity: 'warning',
        message: `${matches.length} ${spec.label}${matches.length === 1 ? '' : ' touches'} share the same scarce action capacity. Later stages may lag even when the first touch fits today's ceiling.`,
        stepIds: matches.map((step) => step.id)
      });
    }
  }

  const messages = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      ['message', 'inmail', 'email', 'group_message', 'event_message'].includes(step.action)
    );
  for (let at = 1; at < messages.length; at += 1) {
    const previous = messages[at - 1];
    const current = messages[at];
    const hasReplyMonitor = steps
      .slice(previous.index + 1, current.index)
      .some(
        (step) =>
          step.action === 'monitor' &&
          (step.config.condition.kind === 'replied' ||
            step.config.condition.kind === 'email_replied')
      );
    if (!hasReplyMonitor) {
      diagnostics.push({
        code: 'missing_reply_monitor',
        severity: 'warning',
        message: `There is another outbound message at “${current.step.id}” without a reply monitor after “${previous.step.id}”. Add an outcome check so a reply can stop follow-ups immediately.`,
        stepIds: [previous.step.id, current.step.id]
      });
      break;
    }
  }

  const inviteSteps = steps.filter((step) => step.action === 'connection_request');
  if (inviteSteps.length > 0 && !steps.some((step) => step.action === 'withdraw_pending')) {
    diagnostics.push({
      code: 'missing_invite_cleanup',
      severity: 'info',
      message:
        'This workflow sends a connection request but has no stale-pending withdrawal step. Consider an explicit cleanup path for invitations that remain unanswered for weeks.',
      stepIds: inviteSteps.map((step) => step.id)
    });
  }

  for (const variable of workflowMergeVariables(steps)) {
    const coverage = variableCoverage[variable];
    if (!coverage || coverage.total <= 0) continue;
    const missing = Math.max(0, coverage.total - coverage.present);
    const missingShare = missing / coverage.total;
    if (missingShare >= 0.1 && missing >= 2) {
      diagnostics.push({
        code: 'missing_variable_coverage',
        severity: 'warning',
        message: `{{${variable}}} is missing for ${missing} of ${coverage.total} selected leads (${Math.round(missingShare * 100)}%). Missing values render as blank; add a fallback/branch or enrich the list before launch.`,
        stepIds: steps
          .filter((step) =>
            templatesOf(step).some((template) => template.includes(`{{${variable}}}`))
          )
          .map((step) => step.id)
      });
    }
  }

  return diagnostics;
}

export function unsupportedVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g)) {
    const name = match[1];
    if (name.startsWith('custom.') && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name.slice(7))) continue;
    if (resolveManagerVariable(name) === null) found.add(name);
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
  customFields?: Record<string, string | number | boolean | null | undefined>;
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
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g, (whole, name: string) => {
    if (name.startsWith('custom.')) {
      const value = lead.customFields?.[name.slice(7)];
      return value === null || value === undefined ? '' : String(value);
    }
    const canonical = resolveManagerVariable(name);
    // Saved workflows reject unknown tokens; fail closed here too rather than sending raw {{tokens}}.
    return canonical === null ? '' : values[canonical];
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
export function chooseMessageVariant<T extends { id: string; body: string; weight: number }>(
  variants: readonly T[],
  seed: string
): T {
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
  scope: 'workspace' | 'personal';
  ownerUserId: string | null;
  steps: WorkflowStep[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  scope: string;
  owner_user_id: string | null;
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
    scope: row.scope === 'personal' ? 'personal' : 'workspace',
    ownerUserId: row.owner_user_id,
    steps: parseSteps(row.steps_json),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listWorkflows(
  db: Db,
  workspaceId: string,
  viewerUserId?: string
): Promise<LinkedInWorkflow[]> {
  const rows = viewerUserId
    ? await db
        .prepare(
          `SELECT id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at
           FROM linkedin_workflows
           WHERE workspace_id=? AND (scope='workspace' OR owner_user_id=?)
           ORDER BY updated_at DESC`
        )
        .all<WorkflowRow>(workspaceId, viewerUserId)
    : await db
        .prepare(
          `SELECT id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at
           FROM linkedin_workflows WHERE workspace_id=? ORDER BY updated_at DESC`
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
      `SELECT id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at FROM linkedin_workflows WHERE workspace_id=? AND id=?`
    )
    .get<WorkflowRow>(workspaceId, workflowId);
  return row ? toWorkflow(row) : undefined;
}

export async function saveWorkflow(
  db: Db,
  input: {
    workspaceId: string;
    id?: string;
    name: string;
    steps: unknown;
    scope?: 'workspace' | 'personal';
    ownerUserId?: string | null;
  },
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
    INSERT INTO linkedin_workflows (id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?::jsonb,1,?,?)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      scope=CASE WHEN EXCLUDED.scope IN ('workspace','personal') THEN EXCLUDED.scope ELSE linkedin_workflows.scope END,
      owner_user_id=COALESCE(EXCLUDED.owner_user_id,linkedin_workflows.owner_user_id),
      steps_json=EXCLUDED.steps_json,
      version=linkedin_workflows.version+1,
      updated_at=EXCLUDED.updated_at
    WHERE linkedin_workflows.workspace_id=EXCLUDED.workspace_id
    RETURNING id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at
  `
    )
    .get<WorkflowRow>(
      workflowId,
      input.workspaceId,
      name,
      input.scope ?? 'workspace',
      input.ownerUserId ?? null,
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
