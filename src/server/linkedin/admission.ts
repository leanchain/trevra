import type { WorkflowStep } from './workflows.js';

export const ADMISSION_KINDS = [
  'profile_view',
  'invite',
  'dm',
  'inmail',
  'follow',
  'like',
  'endorse'
] as const;
export type AdmissionKind = (typeof ADMISSION_KINDS)[number];

export interface AdmissionPolicy {
  mode?: 'automatic' | 'manual';
  maxNewLeadsPerDay?: number | null;
  maxWaveSize?: number | null;
  minWaveIntervalMinutes?: number | null;
  stopAdmittingAt?: string | null;
  /** Optional operator hard cap for currently admitted, non-terminal members. */
  maxInSequence?: number | null;
}

export interface AdmissionInput {
  steps: readonly WorkflowStep[];
  pending: number;
  inSequence: number;
  admittedToday?: number;
  available: Partial<Record<AdmissionKind, number>>;
  backlog: Partial<Record<AdmissionKind, number>>;
  policy?: AdmissionPolicy | null;
  lastAdmissionAt?: string | null;
  now: Date;
  /** Conservative expected fraction of invites that later demand a DM. */
  acceptanceRate?: number | null;
  acceptanceSampleSize?: number | null;
  /** Conservative expected fraction of DMs that later demand another DM. */
  noReplyRate?: number | null;
  replySampleSize?: number | null;
  /** Outcome-based throttle may only reduce admission, never increase it. */
  outcomeThrottle?: number | null;
  outcomeSampleSize?: number | null;
  outcomeThrottleReason?: string | null;
  hasUsableFutureSlot?: boolean;
}

export interface AdmissionDecision {
  admit: number;
  limitingKind: AdmissionKind | null;
  reasons: string[];
  capacitySnapshot: Record<string, number>;
}

/** Enough independent outcomes to let observed rates replace conservative defaults. */
export const ADMISSION_FORECAST_MIN_SAMPLE = 20;

export function workflowAdmissionDemand(
  steps: readonly WorkflowStep[]
): Record<AdmissionKind, number> {
  const demand = Object.fromEntries(ADMISSION_KINDS.map((kind) => [kind, 0])) as Record<
    AdmissionKind,
    number
  >;
  for (const step of steps) {
    switch (step.action) {
      case 'profile_view':
        demand.profile_view += 1;
        break;
      case 'connection_request':
      case 'invite_to_follow_company':
      case 'invite_to_event':
      case 'invite_to_group':
        demand.invite += 1;
        break;
      case 'message':
      case 'group_message':
      case 'event_message':
        demand.dm += 1;
        break;
      case 'inmail':
        demand.inmail += 1;
        break;
      case 'follow':
      case 'unfollow':
      case 'disconnect':
      case 'follow_company':
        demand.follow += 1;
        break;
      case 'like_post':
      case 'like_company_post':
        demand.like += 1;
        break;
      case 'endorse_skills':
        demand.endorse += 1;
        break;
      default:
        break;
    }
  }
  return demand;
}

/**
 * Pure, deterministic admission sizing. It intentionally under-admits when history is thin:
 * a delayed campaign is recoverable; a downstream queue that exceeds a seat's hard ceiling is not.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const reasons: string[] = [];
  const policy = input.policy ?? {};
  const pending = Math.max(0, Math.trunc(input.pending));
  const snapshot: Record<string, number> = {
    pending,
    inSequence: Math.max(0, Math.trunc(input.inSequence))
  };
  if (pending === 0)
    return {
      admit: 0,
      limitingKind: null,
      reasons: ['No pending leads.'],
      capacitySnapshot: snapshot
    };
  if (policy.mode === 'manual')
    return {
      admit: 0,
      limitingKind: null,
      reasons: ['Automatic admission is disabled.'],
      capacitySnapshot: snapshot
    };
  if (input.hasUsableFutureSlot === false)
    return {
      admit: 0,
      limitingKind: null,
      reasons: ['The sender has no usable future working slot.'],
      capacitySnapshot: snapshot
    };

  if (policy.stopAdmittingAt) {
    const stop = Date.parse(policy.stopAdmittingAt);
    if (Number.isFinite(stop) && input.now.getTime() >= stop)
      return {
        admit: 0,
        limitingKind: null,
        reasons: ['The campaign admission end date has been reached.'],
        capacitySnapshot: snapshot
      };
  }
  if (policy.minWaveIntervalMinutes && input.lastAdmissionAt) {
    const previous = Date.parse(input.lastAdmissionAt);
    const next = previous + Math.max(0, policy.minWaveIntervalMinutes) * 60_000;
    if (Number.isFinite(previous) && input.now.getTime() < next)
      return {
        admit: 0,
        limitingKind: null,
        reasons: ['The minimum interval between waves has not elapsed.'],
        capacitySnapshot: snapshot
      };
  }
  if (policy.maxInSequence != null && input.inSequence >= policy.maxInSequence)
    return {
      admit: 0,
      limitingKind: null,
      reasons: ['The in-sequence population cap is full.'],
      capacitySnapshot: snapshot
    };

  const demand = workflowAdmissionDemand(input.steps);
  // Unknown/thin history is deliberately conservative. Observed outcomes replace these
  // defaults only after enough independent sends exist to avoid steering a wave from noise.
  const acceptanceSample = Math.max(0, Math.trunc(input.acceptanceSampleSize ?? 0));
  const replySample = Math.max(0, Math.trunc(input.replySampleSize ?? 0));
  const observedAcceptance =
    input.acceptanceRate != null && acceptanceSample >= ADMISSION_FORECAST_MIN_SAMPLE;
  const observedReply = input.noReplyRate != null && replySample >= ADMISSION_FORECAST_MIN_SAMPLE;
  const acceptance = Math.min(1, Math.max(0.05, observedAcceptance ? input.acceptanceRate! : 0.35));
  const noReply = Math.min(1, Math.max(0.05, observedReply ? input.noReplyRate! : 0.6));
  snapshot.forecast_acceptance_bps = Math.round(acceptance * 10_000);
  snapshot.forecast_no_reply_bps = Math.round(noReply * 10_000);
  snapshot.acceptance_sample = acceptanceSample;
  snapshot.reply_sample = replySample;
  if (observedAcceptance)
    reasons.push(
      `Observed invite acceptance (${Math.round(acceptance * 100)}% across ${acceptanceSample}) is used for downstream forecasting.`
    );
  else if (acceptanceSample > 0)
    reasons.push(
      `Invite history is still thin (${acceptanceSample}/${ADMISSION_FORECAST_MIN_SAMPLE}); conservative acceptance forecasting remains in use.`
    );
  if (observedReply)
    reasons.push(
      `Observed no-reply rate (${Math.round(noReply * 100)}% across ${replySample}) is used for follow-up forecasting.`
    );

  let limit = pending;
  let limitingKind: AdmissionKind | null = null;
  for (const kind of ADMISSION_KINDS) {
    const occurrences = demand[kind];
    if (occurrences <= 0) continue;
    const available = Math.max(0, Math.trunc(input.available[kind] ?? 0));
    const backlog = Math.max(0, Math.trunc(input.backlog[kind] ?? 0));
    snapshot[`available_${kind}`] = available;
    snapshot[`backlog_${kind}`] = backlog;
    snapshot[`demand_${kind}`] = occurrences;
    let effectiveDemand = occurrences;
    if (kind === 'dm' && demand.invite > 0) {
      const gatedMessages = input.steps.filter(
        (step) => step.action === 'message' && step.config.requiresAcceptedConnection === true
      ).length;
      const unconditionalMessages = Math.max(0, occurrences - gatedMessages);
      // Only an explicitly acceptance-gated message is forecast probabilistically.
      // Unconditional DMs remain one full unit each. For multiple gated follow-ups,
      // the first follows acceptance and later ones additionally depend on no reply.
      const gatedDemand =
        gatedMessages <= 0 ? 0 : acceptance * (1 + Math.max(0, gatedMessages - 1) * noReply);
      effectiveDemand = unconditionalMessages + gatedDemand;
    }
    const free = Math.max(0, available - backlog);
    const byKind = Math.floor(free / Math.max(0.05, effectiveDemand));
    if (byKind < limit) {
      limit = byKind;
      limitingKind = kind;
    }
  }

  if (policy.maxInSequence != null)
    limit = Math.min(limit, Math.max(0, policy.maxInSequence - input.inSequence));
  if (policy.maxNewLeadsPerDay != null)
    limit = Math.min(
      limit,
      Math.max(0, policy.maxNewLeadsPerDay - Math.max(0, input.admittedToday ?? 0))
    );
  if (policy.maxWaveSize != null) limit = Math.min(limit, Math.max(0, policy.maxWaveSize));
  const outcomeSample = Math.max(0, Math.trunc(input.outcomeSampleSize ?? 0));
  const throttle = Math.min(1, Math.max(0, input.outcomeThrottle ?? 1));
  snapshot.outcome_sample = outcomeSample;
  snapshot.outcome_throttle_bps = Math.round(throttle * 10_000);
  if (throttle < 1) {
    limit = Math.floor(limit * throttle);
    reasons.push(
      input.outcomeThrottleReason?.trim() ||
        `Recent verified outcomes reduce new admissions to ${Math.round(throttle * 100)}% of available capacity.`
    );
  }
  // Automatic waves should remain bounded even when the first step is passive and has a very large ceiling.
  limit = Math.min(limit, 250);
  limit = Math.max(0, Math.trunc(limit));

  if (limitingKind) reasons.push(`${limitingKind} is the limiting downstream capacity.`);
  if (limit === 0 && reasons.length === 0)
    reasons.push('Downstream backlog currently consumes the available capacity.');
  if (limit > 0)
    reasons.push(
      `Admit ${limit} lead${limit === 1 ? '' : 's'} without exceeding forecast downstream capacity.`
    );
  return { admit: limit, limitingKind, reasons, capacitySnapshot: snapshot };
}
