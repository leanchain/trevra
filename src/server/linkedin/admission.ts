import type { WorkflowStep } from './workflows.js';

export const ADMISSION_KINDS = [
  'profile_view',
  'invite',
  'dm',
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
  /** Conservative expected fraction of DMs that later demand another DM. */
  noReplyRate?: number | null;
  hasUsableFutureSlot?: boolean;
}

export interface AdmissionDecision {
  admit: number;
  limitingKind: AdmissionKind | null;
  reasons: string[];
  capacitySnapshot: Record<string, number>;
}

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
        demand.invite += 1;
        break;
      case 'message':
        demand.dm += 1;
        break;
      case 'follow':
        demand.follow += 1;
        break;
      case 'like_post':
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
  // Unknown history is deliberately conservative. Accepted-connection DMs are forecast at 35%;
  // repeated no-reply follow-ups at 60%. Observed values, once supplied, replace these defaults.
  const acceptance = Math.min(1, Math.max(0.05, input.acceptanceRate ?? 0.35));
  const noReply = Math.min(1, Math.max(0.05, input.noReplyRate ?? 0.6));

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
      effectiveDemand = Math.max(
        acceptance,
        1 + Math.max(0, occurrences - 1) * acceptance * noReply
      );
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
