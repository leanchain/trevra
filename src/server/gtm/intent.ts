import { z } from 'zod';
import type { Db } from '../db.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { listSeats } from '../linkedin/seats.js';
import {
  DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
  prepareOutreach,
  type PreparedOutreachResult
} from '../outreach/prepare.js';

export const GTM_OBJECTIVES = [
  'find_accounts',
  'research_accounts',
  'prepare_outreach',
  'watch_accounts',
  'capture_inbound'
] as const;

export type GtmObjective = (typeof GTM_OBJECTIVES)[number];

const audienceSchema = z
  .object({
    description: z.string().trim().min(1).max(500).optional(),
    domains: z.array(z.string().trim().min(1).max(253)).max(500).optional(),
    countries: z.array(z.string().trim().min(2).max(80)).max(100).optional(),
    vertical: z.string().trim().min(1).max(120).optional(),
    quantity: z.number().int().min(1).max(500).optional()
  })
  .strict();

const peopleSchema = z
  .object({
    existingListId: z.string().trim().min(1).max(160).optional(),
    uploadedInputRef: z.string().trim().min(1).max(500).optional(),
    personaDescription: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const timingSchema = z
  .object({
    start: z.string().datetime().optional(),
    recurring: z.boolean().optional()
  })
  .strict();

export const gtmIntentSchema = z
  .object({
    objective: z.enum(GTM_OBJECTIVES),
    audience: audienceSchema.optional(),
    people: peopleSchema.optional(),
    channels: z
      .array(z.enum(['linkedin', 'email', 'community']))
      .max(3)
      .optional(),
    autonomy: z.enum(['prepare_only', 'approval_required']).optional(),
    timing: timingSchema.optional()
  })
  .strict();

export type GtmIntent = z.infer<typeof gtmIntentSchema>;

export interface GtmPlanStep {
  kind: string;
  title: string;
  detail: string;
  externalEffect: boolean;
}

export interface GtmPlanBlocker {
  code: string;
  message: string;
  actionHref?: string;
}

export interface GtmPlan {
  objective: GtmObjective;
  intent: GtmIntent;
  summary: string;
  steps: GtmPlanStep[];
  blockers: GtmPlanBlocker[];
  defaults: Record<string, unknown>;
  consequences: {
    createsInternalState: boolean;
    externalWrites: boolean;
    approvalRequired: boolean;
  };
  next: {
    kind: string;
    href: string;
  };
  planHash: string;
}

export interface PreparedGtmPlanResult {
  status: 'prepared';
  objective: GtmObjective;
  artifacts: PreparedOutreachResult['artifacts'];
  next: PreparedOutreachResult['next'];
  result: PreparedOutreachResult;
}

export class GtmPlanError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

const planStepSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1),
    detail: z.string(),
    externalEffect: z.boolean()
  })
  .strict();

const blockerSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    actionHref: z.string().min(1).optional()
  })
  .strict();

const suppliedPlanSchema = z
  .object({
    objective: z.enum(GTM_OBJECTIVES),
    intent: gtmIntentSchema,
    summary: z.string().min(1),
    steps: z.array(planStepSchema),
    blockers: z.array(blockerSchema),
    defaults: z.record(z.unknown()),
    consequences: z
      .object({
        createsInternalState: z.boolean(),
        externalWrites: z.boolean(),
        approvalRequired: z.boolean()
      })
      .strict(),
    next: z.object({ kind: z.string().min(1), href: z.string().min(1) }).strict(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

function uniqueSorted(
  values: string[] | undefined,
  transform: (value: string) => string
): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map(transform).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeIntent(raw: unknown): GtmIntent {
  const parsed = gtmIntentSchema.parse(raw);
  const channels = parsed.channels
    ? ([...new Set(parsed.channels)].sort((left, right) =>
        left.localeCompare(right)
      ) as GtmIntent['channels'])
    : undefined;
  const audience = parsed.audience
    ? {
        ...parsed.audience,
        ...(parsed.audience.domains
          ? {
              domains: uniqueSorted(parsed.audience.domains, (value) =>
                value
                  .trim()
                  .toLowerCase()
                  .replace(/^https?:\/\//, '')
                  .replace(/^www\./, '')
                  .replace(/\/.*$/, '')
              )
            }
          : {}),
        ...(parsed.audience.countries
          ? {
              countries: uniqueSorted(parsed.audience.countries, (value) =>
                value.trim().toUpperCase()
              )
            }
          : {})
      }
    : undefined;
  return {
    ...parsed,
    ...(audience ? { audience } : {}),
    ...(parsed.people
      ? {
          people: {
            ...parsed.people,
            existingListId: parsed.people.existingListId?.trim(),
            uploadedInputRef: parsed.people.uploadedInputRef?.trim(),
            personaDescription: parsed.people.personaDescription?.trim()
          }
        }
      : {}),
    ...(channels ? { channels } : {}),
    autonomy: parsed.autonomy ?? 'approval_required'
  };
}

function audienceDescription(intent: GtmIntent): string {
  const audience = intent.audience;
  if (!audience) return 'the target audience';
  const parts = [
    audience.description,
    audience.vertical,
    audience.countries?.length ? audience.countries.join(', ') : null,
    audience.domains?.length ? `${audience.domains.length} named domains` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'the target audience';
}

function hasAudience(intent: GtmIntent): boolean {
  const audience = intent.audience;
  return Boolean(
    audience?.description ||
    audience?.vertical ||
    audience?.countries?.length ||
    audience?.domains?.length
  );
}

function finalizePlan(plan: Omit<GtmPlan, 'planHash'>): GtmPlan {
  return { ...plan, planHash: canonicalPayloadHash(plan) };
}

async function prepareOutreachPlan(
  db: Db,
  workspaceId: string,
  intent: GtmIntent
): Promise<GtmPlan> {
  const blockers: GtmPlanBlocker[] = [];
  const requestedChannels = intent.channels?.length ? intent.channels : ['linkedin'];
  if (requestedChannels.length !== 1 || requestedChannels[0] !== 'linkedin') {
    blockers.push({
      code: 'prepare_outreach_linkedin_only',
      message: 'The generic preparation compiler currently prepares LinkedIn outreach only.',
      actionHref: '/outreach/new'
    });
  }

  const existingListId = intent.people?.existingListId ?? null;
  const uploadedInputRef = intent.people?.uploadedInputRef ?? null;
  if (!existingListId && !uploadedInputRef) {
    blockers.push({
      code: 'people_required',
      message: 'Choose known People before Trevra can prepare outreach.',
      actionHref: '/outreach/new'
    });
  }
  if (existingListId && uploadedInputRef) {
    blockers.push({
      code: 'people_source_ambiguous',
      message: 'Choose one People source, not both an existing list and an uploaded input.',
      actionHref: '/outreach/new'
    });
  }
  if (uploadedInputRef) {
    blockers.push({
      code: 'uploaded_input_not_materialized',
      message:
        'The generic compiler does not materialize uploaded-input references yet. Use Prepare outreach for CSV input.',
      actionHref: '/outreach/new'
    });
  }

  const seats = await listSeats(db, workspaceId);
  let senderKey: string | null = seats.length === 1 ? seats[0]!.seatKey : null;
  let listName: string | null = null;
  if (existingListId) {
    const list = await db
      .prepare(
        'SELECT id,name,seat_key FROM linkedin_lead_lists WHERE workspace_id=? AND id=? LIMIT 1'
      )
      .get<{ id: string; name: string; seat_key: string }>(workspaceId, existingListId);
    if (!list) {
      blockers.push({
        code: 'lead_list_not_found',
        message: 'The selected People list no longer exists in this workspace.',
        actionHref: '/outreach/new'
      });
    } else {
      listName = list.name;
      senderKey = list.seat_key;
      if (!seats.some((seat) => seat.seatKey === list.seat_key)) {
        blockers.push({
          code: 'linkedin_sender_missing',
          message: 'The LinkedIn account attached to this People list is no longer connected.',
          actionHref: '/outreach/settings'
        });
      }
    }
  } else if (seats.length === 0) {
    blockers.push({
      code: 'linkedin_sender_missing',
      message: 'Connect the LinkedIn account you want Trevra to use.',
      actionHref: '/outreach/settings'
    });
  } else if (seats.length > 1) {
    blockers.push({
      code: 'linkedin_sender_ambiguous',
      message: 'Choose which LinkedIn account should own this outreach preparation.',
      actionHref: '/outreach/new'
    });
  }

  const summary = existingListId
    ? `Prepare LinkedIn outreach for ${listName ?? 'the selected People list'}`
    : 'Prepare LinkedIn outreach from known People';
  return finalizePlan({
    objective: 'prepare_outreach',
    intent,
    summary,
    steps: [
      {
        kind: 'people',
        title: 'People',
        detail: existingListId
          ? `Reuse People from ${listName ?? existingListId}.`
          : 'Resolve the supplied People input without inventing identities.',
        externalEffect: false
      },
      {
        kind: 'sequence',
        title: 'Sequence',
        detail: `Use ${DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME} with existing LinkedIn safety limits.`,
        externalEffect: false
      },
      {
        kind: 'campaign',
        title: 'Campaign ready for review',
        detail: 'Create a draft campaign only. Preparing it sends nothing.',
        externalEffect: false
      }
    ],
    blockers,
    defaults: {
      channel: 'linkedin',
      senderKey,
      leadListId: existingListId,
      workflowPreset: 'default',
      workflowName: DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
      prepareSupported: blockers.length === 0 && Boolean(existingListId && senderKey)
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    },
    next: { kind: 'review_outreach_plan', href: '/outreach/new' }
  });
}

function accountPlan(intent: GtmIntent): GtmPlan {
  const blockers: GtmPlanBlocker[] = [];
  if (!hasAudience(intent)) {
    blockers.push({
      code: 'audience_required',
      message: 'Describe the accounts you want Trevra to work on.',
      actionHref: '/research'
    });
  }
  const quantity = intent.audience?.quantity ?? 25;
  const audience = audienceDescription(intent);
  const objective = intent.objective;
  const common = {
    blockers,
    defaults: {
      quantity,
      evidenceRequired: true,
      prepareSupported: false
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: false
    },
    next: { kind: 'open_research', href: '/research' }
  } as const;

  if (objective === 'find_accounts') {
    return finalizePlan({
      objective,
      intent,
      summary: `Find up to ${quantity} accounts matching ${audience}`,
      steps: [
        {
          kind: 'find',
          title: 'Find',
          detail: `Discover accounts matching ${audience}.`,
          externalEffect: false
        },
        {
          kind: 'evidence',
          title: 'Evidence',
          detail: 'Preserve source-backed evidence and provenance for every account.',
          externalEffect: false
        },
        {
          kind: 'prioritize',
          title: 'Prioritize',
          detail: 'Score the resulting accounts using Trevra GTM signals.',
          externalEffect: false
        }
      ],
      ...common
    });
  }

  if (objective === 'research_accounts') {
    return finalizePlan({
      objective,
      intent,
      summary: `Research accounts matching ${audience}`,
      steps: [
        {
          kind: 'research',
          title: 'Research',
          detail: 'Collect current website, hiring, positioning and configured source evidence.',
          externalEffect: false
        },
        {
          kind: 'signals',
          title: 'Signals',
          detail: 'Normalize only GTM-relevant evidence into account signals.',
          externalEffect: false
        }
      ],
      ...common
    });
  }

  return finalizePlan({
    objective: 'watch_accounts',
    intent,
    summary: `Watch accounts matching ${audience}`,
    steps: [
      {
        kind: 'watch',
        title: 'Watch',
        detail:
          'Revisit configured account sources and preserve only materially changed GTM evidence.',
        externalEffect: false
      },
      {
        kind: 'attention',
        title: 'Surface changes',
        detail: 'Promote meaningful changes into Today instead of creating generic event noise.',
        externalEffect: false
      }
    ],
    ...common,
    defaults: { ...common.defaults, recurring: intent.timing?.recurring ?? true }
  });
}

function captureInboundPlan(intent: GtmIntent): GtmPlan {
  return finalizePlan({
    objective: 'capture_inbound',
    intent,
    summary: 'Capture website inbound into canonical People and immutable submissions',
    steps: [
      {
        kind: 'capture_source',
        title: 'Capture source',
        detail: 'Create or configure a workspace-bound signed GTM capture source.',
        externalEffect: false
      },
      {
        kind: 'person',
        title: 'Person',
        detail:
          'Resolve deterministic identity into canonical People without requiring an Account.',
        externalEffect: false
      },
      {
        kind: 'submission',
        title: 'Submission',
        detail: 'Preserve each inbound form submission as immutable GTM evidence.',
        externalEffect: false
      }
    ],
    blockers: [],
    defaults: { prepareSupported: false, signedIntake: true, accountOptional: true },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: false
    },
    next: { kind: 'open_inbound', href: '/outreach/inbound' }
  });
}

export async function compileGtmIntent(
  db: Db,
  workspaceId: string,
  rawIntent: unknown
): Promise<GtmPlan> {
  const intent = normalizeIntent(rawIntent);
  if (intent.objective === 'prepare_outreach') return prepareOutreachPlan(db, workspaceId, intent);
  if (
    intent.objective === 'find_accounts' ||
    intent.objective === 'research_accounts' ||
    intent.objective === 'watch_accounts'
  ) {
    return accountPlan(intent);
  }
  return captureInboundPlan(intent);
}

export async function prepareGtmPlan(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    plan: unknown;
    planHash: string;
    idempotencyKey: string;
  }
): Promise<PreparedGtmPlanResult> {
  const supplied = suppliedPlanSchema.parse(input.plan);
  if (input.planHash !== supplied.planHash) {
    throw new GtmPlanError('The supplied plan hash does not match the plan.', 409);
  }
  const current = await compileGtmIntent(db, input.workspaceId, supplied.intent);
  if (current.planHash !== supplied.planHash) {
    throw new GtmPlanError(
      'This GTM plan is stale because workspace state changed. Re-plan before preparing.',
      409
    );
  }
  if (current.blockers.length > 0) {
    throw new GtmPlanError(current.blockers[0]!.message, 409);
  }
  if (current.objective !== 'prepare_outreach') {
    throw new GtmPlanError(
      'This objective is inspectable but is not yet composed through the generic prepare boundary.',
      409
    );
  }
  const existingLeadListId = current.intent.people?.existingListId;
  const senderKey =
    typeof current.defaults.senderKey === 'string' ? current.defaults.senderKey : null;
  if (!existingLeadListId || !senderKey) {
    throw new GtmPlanError(
      'This outreach plan is missing a deterministic People list or sender.',
      409
    );
  }
  const result = await prepareOutreach(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    senderKey,
    existingLeadListId,
    name: 'Prepared outreach'
  });
  return {
    status: 'prepared',
    objective: current.objective,
    artifacts: result.artifacts,
    next: result.next,
    result
  };
}
