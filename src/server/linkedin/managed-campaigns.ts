import { id, type Db } from '../db.js';
import { COUNTED_MESSAGE_KINDS, recordAction } from './actions.js';
import type { CampaignStatus } from './action-ledger.js';
import {
  ADMISSION_FORECAST_MIN_SAMPLE,
  decideAdmission,
  workflowAdmissionDemand,
  type AdmissionDecision,
  type AdmissionPolicy
} from './admission.js';
import { getLeadList } from './lead-lists.js';
import { effectivePosture, getSeat, OWNER_SEAT_KEY, warmupWeekOf } from './seats.js';
import {
  bandFor,
  effectiveDailyCeiling,
  seatOperatorLimit,
  warmupMultiplierFor,
  type PacedKind
} from './limits.js';
import {
  delayMilliseconds,
  diagnoseWorkflow,
  getWorkflow,
  parseWorkflowSteps,
  renderWorkflowTemplate,
  workflowMergeVariables,
  type WorkflowDiagnostic,
  type WorkflowMergeLead,
  type WorkflowStep,
  type WorkflowVariableCoverage
} from './workflows.js';

/**
 * AN ALIAS, NOT A SECOND UNION.
 *
 * It named the same column as `CampaignStatus` in action-ledger.ts and disagreed
 * with it about whether 'paused' exists -- this file had it, that one did not,
 * and both cast the same rows onto their own answer. Managed and legacy
 * campaigns are rows in ONE table with ONE status column; the manager adds a
 * writer for 'paused', not a second vocabulary. Kept as a name because it is
 * the one this module's callers read, and because "the status of a managed
 * campaign" is still a useful thing to say.
 */
export type ManagedCampaignStatus = CampaignStatus;
export type ManagedMemberStatus =
  | 'pending'
  | 'active'
  | 'waiting'
  | 'manual'
  | 'paused'
  | 'replied'
  | 'completed'
  | 'removed'
  | 'failed'
  | 'excluded';

export type CampaignPriority = 'low' | 'normal' | 'high';
export type CampaignEndBehavior = 'finish_waves' | 'pause_all' | 'stop_immediately';

export interface CampaignSchedule {
  startAt: string | null;
  endAt: string | null;
  workingDays: number[] | null;
  workStartMinute: number | null;
  workEndMinute: number | null;
  endBehavior: CampaignEndBehavior;
}

export interface ManagedCampaign {
  id: string;
  workspaceId: string;
  ownerUserId: string | null;
  ownerName: string | null;
  name: string;
  status: ManagedCampaignStatus;
  seatKey: string;
  /** One or more eligible senders. `seatKey` remains the compatibility/default sender. */
  senderKeys: string[];
  /** Stable LinkedIn-seat -> connected mailbox assignment for cross-channel steps. */
  mailboxAssignments: Record<string, string>;
  leadListId: string;
  workflowId: string;
  workflowVersion: number | null;
  steps: WorkflowStep[];
  priority: CampaignPriority;
  admissionPolicy: AdmissionPolicy;
  exclusionPolicy: CampaignExclusionPolicy;
  schedule: CampaignSchedule;
  /** Maximum paid InMail credits this campaign may consume. Null means no paid credits are approved campaign-wide. */
  inmailCreditCap: number | null;
  /** Maximum external email-enrichment credits this campaign may consume. Null means no provider credits are approved. */
  enrichmentCreditCap: number | null;
  lastAdmissionAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  memberCount: number;
  /** Compatibility: live claim holders including pending. */
  activeCount: number;
  pendingCount: number;
  inSequenceCount: number;
  waitingCount: number;
  manualCount: number;
  pausedCount: number;
  repliedCount: number;
  completedCount: number;
  failedCount: number;
  excludedCount: number;
  removedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignExclusionPolicy {
  excludeMissingProfile?: boolean;
  excludeDoNotContact?: boolean;
  excludeExistingConversation?: boolean;
  contactedLookbackDays?: number | null;
  excludeSameSenderMessaged?: boolean;
  suppressedCompanies?: string[];
  suppressedDomains?: string[];
  /** Exclude contacts who are members of any of these workspace lead lists. */
  excludedLeadListIds?: string[];
  /** Normalized duplicate profile URLs are excluded by default. */
  excludeDuplicateProfiles?: boolean;
  /** Only positive ledger evidence counts as connected; absence is never guessed. */
  excludeKnownConnected?: boolean;
  /** Require positive connection evidence; unknown/non-connected contacts stay excluded. */
  requireKnownConnected?: boolean;
}

export interface ManagedCampaignMember {
  id: string;
  campaignId: string;
  contactId: string;
  status: ManagedMemberStatus;
  /** Compatibility/display position; durable progress is keyed by step ids. */
  stepIndex: number;
  currentStepId: string | null;
  completedStepIds: string[];
  nextEligibleAt: string | null;
  admittedAt: string | null;
  waveId: string | null;
  waveOrdinal: number | null;
  assignedSeatKey: string | null;
  workflowVersion: number | null;
  assignedVariants: Record<string, string>;
  branchState: Record<string, unknown>;
  lastActionId: string | null;
  lastAction: {
    id: string;
    kind: string;
    status: string;
    plannedFor: string | null;
    claimedAt: string | null;
    settlementHoldAt: string | null;
    failureKind: string | null;
  } | null;
  exclusionReason: string | null;
  lastFailureReason: string | null;
  firstName: string;
  lastName: string;
  company: string;
  email: string | null;
  profileUrl: string | null;
  customFields: Record<string, unknown>;
}

export interface ManagedCampaignWave {
  id: string;
  campaignId: string;
  ordinal: number;
  admittedAt: string;
  memberCount: number;
  admissionReason: string | null;
  capacitySnapshot: Record<string, number>;
  stepFunnel?: Array<{
    stepId: string;
    planned: number;
    sent: number;
    accepted: number;
    replied: number;
    failed: number;
    medianMinutesFromAdmission: number | null;
    medianQueueLatencyMinutes: number | null;
  }>;
  acceptanceRate?: number | null;
  replyRate?: number | null;
  failureRate?: number | null;
  backlog?: number;
}

export interface CampaignQueueSummary {
  pending: number;
  /** Sequence-eligible members whose nextEligibleAt has passed. This is NOT a promise of executable capacity. */
  dueNow: number;
  /** Planned actions whose scheduled slot is in the next 24 hours. */
  scheduledToday: number;
  /**
   * Planned and due, not yet claimed, and genuinely claimable: rows parked on
   * an unresolved outcome (`settlement_hold_at`) are excluded, because no
   * browser will ever claim them and reporting them as waiting for one is the
   * misleading half of "waiting for browser worker".
   */
  queuedReady: number;
  /** Planned for a future slot. Parked rows are excluded for the same reason. */
  scheduledFuture: number;
  /** Currently leased by a browser worker. */
  executing: number;
  /** Claimed with an ambiguous outcome or explicitly parked for review. */
  heldForReview: number;
  waitingForConnection: number;
  waitingForReply: number;
  waitingOther: number;
  manual: number;
  held: number;
  blocked: number;
  failed: number;
  /** Actions already allocated inside the campaign's current 24h ramp day, by the four headline safety buckets. */
  allocatedCampaignDay: Record<'invite' | 'dm' | 'profile_view' | 'follow', number>;
  backlogByStep: Array<{ stepId: string; count: number; due: number }>;
}
interface CampaignRow {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
  owner_name: string | null;
  name: string;
  status: CampaignStatus;
  seat_key: string;
  lead_list_id: string;
  workflow_id: string;
  sequence_json: unknown;
  priority: number;
  admission_policy_json: unknown;
  exclusion_policy_json: unknown;
  sender_keys_json: unknown;
  mailbox_assignments_json: unknown;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  schedule_days_json: unknown;
  schedule_start_minute: number | null;
  schedule_end_minute: number | null;
  end_behavior: string;
  inmail_credit_cap: number | null;
  enrichment_credit_cap: number | null;
  last_admission_at: string | null;
  started_at: string | null;
  paused_at: string | null;
  member_count: number;
  active_count: number;
  pending_count: number;
  in_sequence_count: number;
  waiting_count: number;
  manual_count: number;
  paused_count: number;
  replied_count: number;
  completed_count: number;
  failed_count: number;
  excluded_count: number;
  removed_count: number;
  created_at: string;
  updated_at: string;
}
interface MemberRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: string;
  step_index: number;
  current_step_id: string | null;
  completed_step_ids: unknown;
  next_eligible_at: string | null;
  admitted_at: string | null;
  wave_id: string | null;
  wave_ordinal: number | null;
  assigned_seat_key: string | null;
  workflow_snapshot_json: unknown;
  workflow_version: number | null;
  assigned_variants: unknown;
  branch_state_json: unknown;
  last_action_id: string | null;
  last_action_kind: string | null;
  last_action_status: string | null;
  last_action_planned_for: string | null;
  last_action_claimed_at: string | null;
  last_action_settlement_hold_at: string | null;
  last_action_failure_kind: string | null;
  exclusion_reason: string | null;
  last_failure_reason: string | null;
  first_name: string;
  last_name: string;
  company: string;
  email: string | null;
  profile_url: string | null;
  custom_fields_json: unknown;
}

const ACTIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;
const CAMPAIGN_SELECT = `
  c.id,c.workspace_id,c.owner_user_id,(SELECT COALESCE(u.name,u.email) FROM users u WHERE u.id=c.owner_user_id) AS owner_name,c.name,c.status,c.seat_key,c.lead_list_id,c.workflow_id,c.sequence_json,
  c.priority,c.admission_policy_json,c.exclusion_policy_json,c.sender_keys_json,c.mailbox_assignments_json,
  c.scheduled_start_at,c.scheduled_end_at,c.schedule_days_json,c.schedule_start_minute,c.schedule_end_minute,c.end_behavior,c.inmail_credit_cap,c.enrichment_credit_cap,c.last_admission_at,
  c.started_at,c.paused_at,c.created_at,c.updated_at,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id) AS member_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status = ANY(ARRAY['pending','active','waiting','manual','paused'])) AS active_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='pending') AS pending_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.admitted_at IS NOT NULL AND m.status = ANY(ARRAY['active','waiting','manual','paused'])) AS in_sequence_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='waiting') AS waiting_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='manual') AS manual_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='paused') AS paused_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='replied') AS replied_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='completed') AS completed_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='failed') AS failed_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='excluded') AS excluded_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status='removed') AS removed_count
`;

/**
 * The steps stored in a campaign's `sequence_json` snapshot.
 *
 * NEVER THROWS, and that is deliberate: `linkedin_campaigns` also holds rows
 * written by the deleted legacy sequence-builder (formerly `campaigns.ts`),
 * whose `sequence_json` was a completely different shape, and a manager read
 * that exploded on one of those would take the campaign list down with it. An
 * unreadable or foreign snapshot
 * is an empty list, which every caller already has to handle -- a campaign
 * whose workflow was deleted has always been able to have no steps.
 */
export function campaignSnapshotSteps(sequenceJson: unknown): WorkflowStep[] {
  const raw =
    typeof sequenceJson === 'string'
      ? (() => {
          try {
            return JSON.parse(sequenceJson) as unknown;
          } catch {
            return null;
          }
        })()
      : sequenceJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return parseWorkflowSteps((raw as Record<string, unknown>).steps);
}

function snapshotVersion(sequenceJson: unknown): number | null {
  const raw =
    typeof sequenceJson === 'string'
      ? (() => {
          try {
            return JSON.parse(sequenceJson) as unknown;
          } catch {
            return null;
          }
        })()
      : sequenceJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const version = (raw as Record<string, unknown>).workflowVersion;
  return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parseStringArray(value: unknown): string[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function priorityOf(value: number): CampaignPriority {
  return value > 0 ? 'high' : value < 0 ? 'low' : 'normal';
}

function toCampaign(row: CampaignRow): ManagedCampaign {
  const senderKeys = parseStringArray(row.sender_keys_json);
  const daysRaw =
    typeof row.schedule_days_json === 'string'
      ? (() => {
          try {
            return JSON.parse(row.schedule_days_json) as unknown;
          } catch {
            return null;
          }
        })()
      : row.schedule_days_json;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    name: row.name,
    status: row.status,
    seatKey: row.seat_key,
    senderKeys: senderKeys.length > 0 ? senderKeys : [row.seat_key],
    mailboxAssignments: Object.fromEntries(
      Object.entries(parseJsonObject(row.mailbox_assignments_json)).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].trim().length > 0
      )
    ),
    leadListId: row.lead_list_id,
    workflowId: row.workflow_id,
    workflowVersion: snapshotVersion(row.sequence_json),
    steps: campaignSnapshotSteps(row.sequence_json),
    priority: priorityOf(Number(row.priority)),
    admissionPolicy: parseJsonObject(row.admission_policy_json) as AdmissionPolicy,
    exclusionPolicy: parseJsonObject(row.exclusion_policy_json) as CampaignExclusionPolicy,
    schedule: {
      startAt: row.scheduled_start_at,
      endAt: row.scheduled_end_at,
      workingDays: Array.isArray(daysRaw)
        ? daysRaw.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 6)
        : null,
      workStartMinute:
        row.schedule_start_minute === null ? null : Number(row.schedule_start_minute),
      workEndMinute: row.schedule_end_minute === null ? null : Number(row.schedule_end_minute),
      endBehavior: (['finish_waves', 'pause_all', 'stop_immediately'].includes(row.end_behavior)
        ? row.end_behavior
        : 'finish_waves') as CampaignEndBehavior
    },
    inmailCreditCap: row.inmail_credit_cap === null ? null : Number(row.inmail_credit_cap),
    enrichmentCreditCap:
      row.enrichment_credit_cap === null ? null : Number(row.enrichment_credit_cap),
    lastAdmissionAt: row.last_admission_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    memberCount: Number(row.member_count),
    activeCount: Number(row.active_count),
    pendingCount: Number(row.pending_count),
    inSequenceCount: Number(row.in_sequence_count),
    waitingCount: Number(row.waiting_count),
    manualCount: Number(row.manual_count),
    pausedCount: Number(row.paused_count),
    repliedCount: Number(row.replied_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    excludedCount: Number(row.excluded_count),
    removedCount: Number(row.removed_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function parseVariants(value: unknown): Record<string, string> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, String(v)])
      )
    : {};
}
function parseStepIds(value: unknown): string[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function nextUncompletedStep(
  steps: readonly WorkflowStep[],
  afterIndex: number,
  completedStepIds: readonly string[]
): { index: number; step: WorkflowStep | null } {
  const completed = new Set(completedStepIds);
  let index = Math.max(0, afterIndex + 1);
  while (index < steps.length && completed.has(steps[index].id)) index += 1;
  return { index, step: steps[index] ?? null };
}

function toMember(row: MemberRow): ManagedCampaignMember {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    status: row.status as ManagedMemberStatus,
    stepIndex: Number(row.step_index),
    currentStepId: row.current_step_id,
    completedStepIds: parseStepIds(row.completed_step_ids),
    nextEligibleAt: row.next_eligible_at,
    admittedAt: row.admitted_at,
    waveId: row.wave_id,
    waveOrdinal: row.wave_ordinal === null ? null : Number(row.wave_ordinal),
    assignedSeatKey: row.assigned_seat_key,
    workflowVersion: row.workflow_version === null ? null : Number(row.workflow_version),
    assignedVariants: parseVariants(row.assigned_variants),
    branchState: parseJsonObject(row.branch_state_json),
    lastActionId: row.last_action_id,
    lastAction:
      row.last_action_id && row.last_action_kind && row.last_action_status
        ? {
            id: row.last_action_id,
            kind: row.last_action_kind,
            status: row.last_action_status,
            plannedFor: row.last_action_planned_for,
            claimedAt: row.last_action_claimed_at,
            settlementHoldAt: row.last_action_settlement_hold_at,
            failureKind: row.last_action_failure_kind
          }
        : null,
    exclusionReason: row.exclusion_reason,
    lastFailureReason: row.last_failure_reason,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    email: row.email,
    profileUrl: row.profile_url,
    customFields: parseJsonObject(row.custom_fields_json)
  };
}

/** Campaign-day ramp requested by the manager brief: days 1..5 => 20/40/60/80/100%. */
export function campaignWarmupFraction(startedAt: string | null, now: Date): number {
  if (!startedAt) return 0.2;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || start > now.getTime()) return 0.2;
  const day = Math.floor((now.getTime() - start) / 86_400_000) + 1;
  return Math.min(1, Math.max(0.2, day * 0.2));
}

export function campaignActionLimit(
  accountLimit: number,
  startedAt: string | null,
  now: Date
): number {
  return Math.floor(accountLimit * campaignWarmupFraction(startedAt, now));
}

export async function listManagedCampaigns(
  db: Db,
  workspaceId: string
): Promise<ManagedCampaign[]> {
  const rows = await db
    .prepare(
      `SELECT ${CAMPAIGN_SELECT} FROM linkedin_campaigns c WHERE c.workspace_id=? AND c.lead_list_id IS NOT NULL AND c.workflow_id IS NOT NULL ORDER BY c.created_at DESC`
    )
    .all<CampaignRow>(workspaceId);
  return rows.map(toCampaign);
}

export async function getManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<ManagedCampaign | undefined> {
  const row = await db
    .prepare(
      `SELECT ${CAMPAIGN_SELECT} FROM linkedin_campaigns c WHERE c.workspace_id=? AND c.id=? AND c.lead_list_id IS NOT NULL AND c.workflow_id IS NOT NULL`
    )
    .get<CampaignRow>(workspaceId, campaignId);
  return row ? toCampaign(row) : undefined;
}

/** Permanently remove a terminal managed campaign. */
export async function deleteManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare('SELECT status FROM linkedin_campaigns WHERE workspace_id=? AND id=? FOR UPDATE')
      .get<{ status: CampaignStatus }>(workspaceId, campaignId);
    if (!row) return false;
    if (row.status !== 'stopped' && row.status !== 'completed') {
      throw new Error(
        'Only a stopped or completed campaign can be deleted. Cancel or stop it first.'
      );
    }
    const deleted = await tx
      .prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
      .run(workspaceId, campaignId);
    return deleted.changes > 0;
  });
}

export async function listCampaignMembers(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<ManagedCampaignMember[]> {
  const rows = await db
    .prepare(
      `
    SELECT m.id,m.campaign_id,m.contact_id,m.status,m.step_index,m.current_step_id,m.completed_step_ids,m.next_eligible_at,m.admitted_at,m.wave_id,w.ordinal AS wave_ordinal,
           m.assigned_seat_key,m.workflow_snapshot_json,m.workflow_version,m.assigned_variants,m.branch_state_json,m.last_action_id,m.exclusion_reason,m.last_failure_reason,
           a.kind AS last_action_kind,a.status AS last_action_status,a.planned_for AS last_action_planned_for,
           a.claimed_at AS last_action_claimed_at,a.settlement_hold_at AS last_action_settlement_hold_at,a.failure_kind AS last_action_failure_kind,
           l.first_name,l.last_name,l.company,l.email,l.profile_url,l.custom_fields_json
    FROM linkedin_campaign_members m
    JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
    LEFT JOIN linkedin_campaign_waves w ON w.id=m.wave_id AND w.workspace_id=m.workspace_id
    LEFT JOIN linkedin_actions a ON a.id=m.last_action_id AND a.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY m.created_at,m.id
  `
    )
    .all<MemberRow>(workspaceId, campaignId);
  return rows.map(toMember);
}

function assertCampaignSchedule(schedule: Partial<CampaignSchedule>): void {
  if (schedule.workingDays !== undefined && schedule.workingDays !== null) {
    if (
      schedule.workingDays.length === 0 ||
      schedule.workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      throw new Error('Campaign working days must contain at least one valid weekday.');
  }
  if (
    schedule.workStartMinute !== undefined &&
    schedule.workStartMinute !== null &&
    (!Number.isInteger(schedule.workStartMinute) ||
      schedule.workStartMinute < 0 ||
      schedule.workStartMinute > 1439)
  )
    throw new Error('Campaign start minute must be from 0 to 1439.');
  if (
    schedule.workEndMinute !== undefined &&
    schedule.workEndMinute !== null &&
    (!Number.isInteger(schedule.workEndMinute) ||
      schedule.workEndMinute < 1 ||
      schedule.workEndMinute > 1440)
  )
    throw new Error('Campaign end minute must be from 1 to 1440.');
  if (
    schedule.workStartMinute != null &&
    schedule.workEndMinute != null &&
    schedule.workEndMinute <= schedule.workStartMinute
  )
    throw new Error('Campaign working hours need an end later than the start.');
  const start = schedule.startAt ? new Date(schedule.startAt) : null;
  const end = schedule.endAt ? new Date(schedule.endAt) : null;
  if (start && Number.isNaN(start.getTime()))
    throw new Error('Campaign start must be a valid timestamp.');
  if (end && Number.isNaN(end.getTime()))
    throw new Error('Campaign end must be a valid timestamp.');
  if (start && end && end.getTime() <= start.getTime())
    throw new Error('Campaign end must be later than the campaign start.');
}

export async function createManagedCampaign(
  db: Db,
  input: {
    workspaceId: string;
    ownerUserId?: string | null;
    name: string;
    seatKey?: string;
    senderKeys?: string[];
    mailboxAssignments?: Record<string, string>;
    leadListId: string;
    workflowId: string;
    priority?: CampaignPriority;
    admissionPolicy?: AdmissionPolicy;
    exclusionPolicy?: CampaignExclusionPolicy;
    schedule?: Partial<CampaignSchedule>;
    inmailCreditCap?: number | null;
    enrichmentCreditCap?: number | null;
    /** Narrow intent-preparation correlation; never controls campaign execution. */
    preparationId?: string | null;
  },
  now: Date = new Date()
): Promise<{
  campaign: ManagedCampaign;
  enrolled: number;
  skippedAlreadyActive: number;
  excluded: number;
}> {
  assertCampaignSchedule(input.schedule ?? {});
  const name = input.name.trim();
  if (
    input.inmailCreditCap != null &&
    (!Number.isInteger(input.inmailCreditCap) ||
      input.inmailCreditCap < 0 ||
      input.inmailCreditCap > 10000)
  )
    throw new Error('Campaign InMail credit cap must be a whole number from 0 to 10000.');
  if (
    input.enrichmentCreditCap != null &&
    (!Number.isInteger(input.enrichmentCreditCap) ||
      input.enrichmentCreditCap < 0 ||
      input.enrichmentCreditCap > 100000)
  )
    throw new Error('Campaign enrichment credit cap must be a whole number from 0 to 100000.');
  if (!name) throw new Error('Campaign name is required.');
  const requestedSenders = [
    ...new Set(
      (input.senderKeys?.length ? input.senderKeys : [input.seatKey ?? OWNER_SEAT_KEY])
        .map((key) => key.trim())
        .filter(Boolean)
    )
  ];
  const seatKey = requestedSenders[0] ?? OWNER_SEAT_KEY;
  const [seats, list, workflow] = await Promise.all([
    Promise.all(requestedSenders.map((key) => getSeat(db, input.workspaceId, key))),
    getLeadList(db, input.workspaceId, input.leadListId, seatKey),
    getWorkflow(db, input.workspaceId, input.workflowId)
  ]);
  const missingSeat = requestedSenders.find((_key, index) => !seats[index]);
  if (missingSeat) throw new Error(`LinkedIn account '${missingSeat}' is not configured.`);
  if (!list) throw new Error('Lead list not found.');
  if (!workflow) throw new Error('Workflow not found.');
  const timestamp = now.toISOString();
  const campaignId = id('licmp');
  let enrolled = 0;
  let total = 0;
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `
      INSERT INTO linkedin_campaigns (
        id,workspace_id,owner_user_id,name,status,sequence_json,playbook_run_id,seat_key,sender_keys_json,mailbox_assignments_json,lead_list_id,workflow_id,
        priority,admission_policy_json,exclusion_policy_json,scheduled_start_at,scheduled_end_at,schedule_days_json,
        schedule_start_minute,schedule_end_minute,end_behavior,inmail_credit_cap,enrichment_credit_cap,preparation_id,created_at,updated_at
      )
      VALUES (?,?,?,?,'draft',?::jsonb,NULL,?,?::jsonb,?::jsonb,?,?,?,?::jsonb,?::jsonb,?,?,?::jsonb,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        campaignId,
        input.workspaceId,
        input.ownerUserId ?? null,
        name,
        JSON.stringify({
          manager: true,
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          steps: workflow.steps
        }),
        seatKey,
        JSON.stringify(requestedSenders),
        JSON.stringify(input.mailboxAssignments ?? {}),
        list.id,
        workflow.id,
        input.priority === 'high' ? 1 : input.priority === 'low' ? -1 : 0,
        JSON.stringify(input.admissionPolicy ?? {}),
        JSON.stringify(input.exclusionPolicy ?? {}),
        input.schedule?.startAt ?? null,
        input.schedule?.endAt ?? null,
        input.schedule?.workingDays ? JSON.stringify(input.schedule.workingDays) : null,
        input.schedule?.workStartMinute ?? null,
        input.schedule?.workEndMinute ?? null,
        input.schedule?.endBehavior ?? 'finish_waves',
        input.inmailCreditCap ?? null,
        input.enrichmentCreditCap ?? null,
        input.preparationId ?? null,
        timestamp,
        timestamp
      );
    // Membership is `linkedin_lead_list_members` (migration 052), not the
    // contact's own `list_id`: one person may sit in several lists, and
    // `list_id` only remembers the first one they were imported into.
    const count = await tx
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?'
      )
      .get<{ total: number }>(input.workspaceId, list.id);
    total = count?.total ?? 0;
    // Insert every audience member first so exclusions are explainable rather than silently disappearing.
    // A provisional excluded row does not contend with the one-live-campaign partial unique index.
    await tx
      .prepare(
        `
      INSERT INTO linkedin_campaign_members (
        id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,assigned_variants,exclusion_reason,created_at,updated_at
      )
      SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'excluded', 0, NULL, '[]'::jsonb, '{}'::jsonb, '__eligibility__', ?, ?
      FROM linkedin_lead_list_members m WHERE m.workspace_id=? AND m.list_id=?
      ON CONFLICT DO NOTHING
    `
      )
      .run(
        input.workspaceId,
        campaignId,
        input.workspaceId,
        campaignId,
        timestamp,
        timestamp,
        input.workspaceId,
        list.id
      );
  });
  const eligibility = await reevaluateCampaignExclusions(db, input.workspaceId, campaignId, now);
  enrolled = eligibility.pending;
  const campaign = await getManagedCampaign(db, input.workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign could not be created.');
  const excluded = Math.max(0, total - enrolled);
  const skippedAlreadyActive =
    (
      await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? AND exclusion_reason='Already in another live campaign'`
        )
        .get<{ total: number }>(input.workspaceId, campaignId)
    )?.total ?? 0;
  return { campaign, enrolled, skippedAlreadyActive, excluded };
}
const ELIGIBILITY_EXCLUSION_REASONS = new Set([
  '__eligibility__',
  'Do not contact',
  'Missing LinkedIn profile URL',
  'Suppressed company',
  'Suppressed email domain',
  'Member of an excluded lead list',
  'Duplicate LinkedIn profile URL',
  'Already in another live campaign',
  'Existing conversation',
  'Contacted inside campaign lookback window',
  'Already messaged by an assigned sender',
  'Known LinkedIn connection excluded',
  'Known LinkedIn connection required',
  'Excluded by campaign eligibility policy'
]);

function normalizedSuppressedDomains(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    )
  ];
}

function emailMatchesSuppressedDomain(email: string | null, domains: readonly string[]): boolean {
  const at = email?.lastIndexOf('@') ?? -1;
  if (at < 0 || domains.length === 0) return false;
  const domain = email!
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

/**
 * Recompute explainable eligibility for every UNADMITTED member of one campaign.
 * Creation, dynamic-list enrolment and paused campaign edits all call this exact
 * function so an exclusion cannot mean one thing on day zero and another thing
 * when the list grows later.
 */
export async function reevaluateCampaignExclusions(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<{ pending: number; excluded: number }> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const policy = campaign.exclusionPolicy ?? {};
  if (policy.excludeKnownConnected && policy.requireKnownConnected)
    throw new Error('A campaign cannot both require and exclude known LinkedIn connections.');
  const senders = campaign.senderKeys.length > 0 ? campaign.senderKeys : [campaign.seatKey];
  const excludedLists = [
    ...new Set((policy.excludedLeadListIds ?? []).map((v) => v.trim()).filter(Boolean))
  ];
  const lookback = Math.max(0, Math.trunc(policy.contactedLookbackDays ?? 0));
  const rows = await db
    .prepare(
      `SELECT m.id,m.status,m.exclusion_reason,c.email,c.company,c.profile_url,c.do_not_contact,
              EXISTS (
                SELECT 1 FROM suppressions s
                WHERE s.workspace_id=m.workspace_id AND s.lifted_at IS NULL
                  AND s.channel IN ('all','linkedin')
                  AND (
                    (s.person_id IS NOT NULL AND s.person_id=c.person_id)
                    OR (s.email_normalized IS NOT NULL AND c.email IS NOT NULL
                        AND s.email_normalized=LOWER(BTRIM(c.email)))
                    OR (s.linkedin_url IS NOT NULL AND pk.profile_key IS NOT NULL
                        AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(s.linkedin_url, chr(63),1),'#',1),'/'))=pk.profile_key)
                  )
              ) AS global_suppression,
              EXISTS (
                SELECT 1 FROM linkedin_campaign_members other
                WHERE other.workspace_id=m.workspace_id AND other.contact_id=m.contact_id
                  AND other.campaign_id<>m.campaign_id
                  AND other.status IN ('pending','active','waiting','manual','paused')
              ) AS other_live,
              EXISTS (
                SELECT 1 FROM linkedin_threads t
                JOIN linkedin_messages msg ON msg.thread_id=t.id AND msg.workspace_id=t.workspace_id
                WHERE t.workspace_id=m.workspace_id AND pk.profile_key IS NOT NULL
                  AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(t.profile_url, chr(63),1),'#',1),'/'))=pk.profile_key
                  AND msg.direction='in'
              ) AS existing_conversation,
              EXISTS (
                SELECT 1 FROM linkedin_actions a
                WHERE a.workspace_id=m.workspace_id AND pk.profile_key IS NOT NULL
                  AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(a.target_ref, chr(63),1),'#',1),'/'))=pk.profile_key
                  AND a.status<>'skipped'
                  AND a.created_at >= (?::timestamptz - (?::int * INTERVAL '1 day'))
              ) AS recent_contact,
              EXISTS (
                SELECT 1 FROM linkedin_actions a
                WHERE a.workspace_id=m.workspace_id AND a.seat_key = ANY(?::text[])
                  AND pk.profile_key IS NOT NULL
                  AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(a.target_ref, chr(63),1),'#',1),'/'))=pk.profile_key
                  AND a.kind IN ('dm','reply','inmail','group_message','event_message')
                  AND a.status IN ('sent','replied')
              ) AS same_sender_messaged,
              EXISTS (
                SELECT 1 FROM linkedin_lead_list_members lm
                WHERE lm.workspace_id=m.workspace_id AND lm.contact_id=m.contact_id
                  AND lm.list_id = ANY(?::text[])
              ) AS excluded_list,
              EXISTS (
                SELECT 1 FROM linkedin_actions a
                WHERE a.workspace_id=m.workspace_id AND pk.profile_key IS NOT NULL
                  AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(a.target_ref, chr(63),1),'#',1),'/'))=pk.profile_key
                  AND ((a.kind='invite' AND a.status IN ('accepted','replied'))
                    OR (a.kind IN ('dm','reply') AND a.status IN ('sent','accepted','replied')))
              ) AS known_connected,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(pk.profile_key, c.id)
                ORDER BY c.created_at,c.id
              )::int AS profile_rank
       FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
       CROSS JOIN LATERAL (
         SELECT CASE WHEN c.profile_url IS NULL OR BTRIM(c.profile_url)='' THEN NULL
                     ELSE LOWER(RTRIM(SPLIT_PART(SPLIT_PART(c.profile_url, chr(63),1),'#',1),'/')) END AS profile_key
       ) pk
       WHERE m.workspace_id=? AND m.campaign_id=? AND m.admitted_at IS NULL
         AND m.status IN ('pending','excluded')
       ORDER BY m.created_at,m.id`
    )
    .all<{
      id: string;
      status: string;
      exclusion_reason: string | null;
      email: string | null;
      company: string;
      profile_url: string | null;
      do_not_contact: boolean;
      global_suppression: boolean;
      other_live: boolean;
      existing_conversation: boolean;
      recent_contact: boolean;
      same_sender_messaged: boolean;
      excluded_list: boolean;
      known_connected: boolean;
      profile_rank: number;
    }>(now.toISOString(), lookback, senders, excludedLists, workspaceId, campaignId);

  const companies = new Set(
    (policy.suppressedCompanies ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean)
  );
  const domains = normalizedSuppressedDomains(policy.suppressedDomains);
  const ids: string[] = [];
  const statuses: string[] = [];
  const reasons: string[] = [];
  let pending = 0;
  let excluded = 0;
  for (const row of rows) {
    if (
      row.status === 'excluded' &&
      row.exclusion_reason &&
      !ELIGIBILITY_EXCLUSION_REASONS.has(row.exclusion_reason)
    )
      continue;
    let reason: string | null = null;
    // Global suppression is a workspace authority boundary. Campaign policy may
    // relax local eligibility heuristics, but it cannot opt a suppressed Person
    // back into outreach.
    if (row.global_suppression) reason = 'Workspace suppression';
    else if (policy.excludeDoNotContact !== false && row.do_not_contact) reason = 'Do not contact';
    else if (policy.excludeMissingProfile !== false && !row.profile_url?.trim())
      reason = 'Missing LinkedIn profile URL';
    else if (companies.has(row.company.trim().toLowerCase())) reason = 'Suppressed company';
    else if (emailMatchesSuppressedDomain(row.email, domains)) reason = 'Suppressed email domain';
    else if (row.excluded_list) reason = 'Member of an excluded lead list';
    else if (policy.excludeDuplicateProfiles !== false && row.profile_rank > 1)
      reason = 'Duplicate LinkedIn profile URL';
    else if (row.other_live) reason = 'Already in another live campaign';
    else if (policy.excludeExistingConversation === true && row.existing_conversation)
      reason = 'Existing conversation';
    else if (lookback > 0 && row.recent_contact)
      reason = 'Contacted inside campaign lookback window';
    else if (policy.excludeSameSenderMessaged === true && row.same_sender_messaged)
      reason = 'Already messaged by an assigned sender';
    else if (policy.excludeKnownConnected === true && row.known_connected)
      reason = 'Known LinkedIn connection excluded';
    else if (policy.requireKnownConnected === true && !row.known_connected)
      reason = 'Known LinkedIn connection required';

    ids.push(row.id);
    statuses.push(reason ? 'excluded' : 'pending');
    reasons.push(reason ?? '');
    if (reason) excluded += 1;
    else pending += 1;
  }
  if (ids.length > 0) {
    await db
      .prepare(
        `UPDATE linkedin_campaign_members m
         SET status=x.status, exclusion_reason=NULLIF(x.reason,''), updated_at=?::timestamptz
         FROM unnest(?::text[],?::text[],?::text[]) AS x(id,status,reason)
         WHERE m.workspace_id=? AND m.campaign_id=? AND m.id=x.id AND m.admitted_at IS NULL`
      )
      .run(now.toISOString(), ids, statuses, reasons, workspaceId, campaignId);
  }
  return { pending, excluded };
}

/**
 * The campaign-member primary key, DERIVED rather than minted -- and derived
 * over the WORKSPACE as well as the campaign.
 *
 * WHY IT IS DERIVED AT ALL. Enrolment runs twice by design: once at creation
 * and again on every runner tick (`enrolNewContacts`), because leads keep
 * arriving in a list after the campaign was built on it. A generated id would
 * make the second pass a second membership for the same person, so the id is a
 * pure function of who-and-where and the insert is `ON CONFLICT DO NOTHING`.
 * It is also what makes REMOVAL STICK: a removed member still owns this key,
 * so the next tick's insert is a no-op instead of a quiet re-enrolment.
 *
 * WHY THE WORKSPACE IS IN THE DIGEST. It was `md5(campaignId:contactId)`, and
 * `linkedin_campaign_members` is one table shared by every tenant of a hosted
 * deployment. Two workspaces that ever derived the same digest would collide
 * on the primary key -- and because the insert swallows conflicts, THE LOSER
 * IS SILENTLY NOT ENROLLED. No error, no log, no row: one tenant's campaign
 * simply never contacts one of their leads, and the count on their screen is
 * off by one with nothing anywhere to explain it. That is strictly the worse
 * of the two failure modes; an outright 23505 would at least have surfaced.
 * Prefixing the digest with the workspace makes the key tenant-scoped, which
 * is what every other identifier in a multi-tenant table already is.
 *
 * CHANGING THE DIGEST DOES NOT RE-ENROL ANYBODY WHO WAS REMOVED UNDER THE OLD
 * ONE, and that is the migration question worth answering out loud. The
 * primary key was never the only guard: migration 046's
 * `idx_linkedin_campaign_members_campaign_contact` is UNIQUE on
 * (campaign_id, contact_id), so an existing member row -- removed or live --
 * still makes a fresh insert for that pair a conflict, whatever id the new
 * insert would have carried. `ON CONFLICT DO NOTHING` covers every unique
 * index on the table, not just the one the id happens to be in.
 *
 * The `?` placeholders are workspace id then campaign id, in that order, at
 * both call sites.
 */
const DERIVED_MEMBER_ID = `'limem_' || md5(? || ':' || ? || ':' || m.contact_id)`;

function firstEligibleAt(steps: readonly WorkflowStep[], now: Date): string | null {
  if (steps.length === 0) return null;
  return new Date(now.getTime() + delayMilliseconds(steps[0].delayBefore)).toISOString();
}

/**
 * Enrol contacts that have appeared in this campaign's lead list since it was
 * created, so importing leads into a LIVE campaign actually reaches it.
 *
 * THE ONLY MEMBER INSERT USED TO BE IN `createManagedCampaign`, which made a
 * campaign's membership a photograph taken at creation. Every product path
 * that adds contacts afterwards -- a second CSV into the same list, the lead
 * ingestion pipeline, an operator adding one person by hand -- wrote a
 * `linkedin_lead_contacts` row that no campaign ever looked at again. The list
 * grew, the campaign screen showed the new leads on the list, and not one of
 * them was ever contacted.
 *
 * Called from the runner's tick for RUNNING campaigns only. Not on pause, not
 * on draft: enrolling into a paused campaign would quietly build a backlog
 * that fires the moment somebody resumes, and a draft has not been started, so
 * `startManagedCampaign` is what will pick its members up.
 *
 * READ OFF `linkedin_lead_list_members` (migration 052), which is where list
 * membership actually lives now -- a person may be in several lists, and the
 * contact's own `list_id` only remembers the first one they arrived through.
 * Adding an existing contact to this campaign's list is exactly the case this
 * function exists for, so reading the wrong column would reintroduce the bug
 * in a new dress.
 *
 * `ON CONFLICT DO NOTHING` covers both of migration 046's indexes at once, and
 * both matter here: `idx_linkedin_campaign_members_campaign_contact` makes a
 * re-tick a no-op instead of a second membership, and
 * `idx_linkedin_campaign_members_one_active` is what keeps a contact already
 * live in ANOTHER campaign out of this one -- the same one-active-campaign
 * claim creation respects, enforced by the same index rather than by a second
 * copy of the rule.
 *
 * The id is `derivedMemberId`, exactly as creation computes it, so a contact
 * REMOVED from this campaign is not silently re-enrolled by the next tick: the
 * removed row still owns that primary key and the insert is a no-op. Removal
 * means removed.
 */
export async function enrolNewContacts(
  db: Db,
  workspaceId: string,
  campaign: { id: string; leadListId: string; steps: readonly WorkflowStep[] },
  now: Date = new Date()
): Promise<number> {
  if (campaign.steps.length === 0) return 0;
  const timestamp = now.toISOString();
  // Record every newly seen audience member first, including exclusions. This
  // keeps dynamic-list growth explainable and lets the exact same eligibility
  // engine used at campaign creation decide whether the new member is Pending.
  const inserted = await db
    .prepare(
      `
    INSERT INTO linkedin_campaign_members
      (id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,next_eligible_at,assigned_variants,exclusion_reason,created_at,updated_at)
    SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'excluded', 0, NULL, '[]'::jsonb, NULL, '{}'::jsonb, '__eligibility__', ?, ?
    FROM linkedin_lead_list_members m
    WHERE m.workspace_id=? AND m.list_id=?
    ON CONFLICT DO NOTHING RETURNING id
  `
    )
    .all<{ id: string }>(
      workspaceId,
      campaign.id,
      workspaceId,
      campaign.id,
      timestamp,
      timestamp,
      workspaceId,
      campaign.leadListId
    );
  if (inserted.length === 0) return 0;
  await reevaluateCampaignExclusions(db, workspaceId, campaign.id, now);
  const promoted = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members
       WHERE workspace_id=? AND campaign_id=? AND id = ANY(?::text[]) AND status='pending'`
    )
    .get<{ total: number }>(
      workspaceId,
      campaign.id,
      inserted.map((row) => row.id)
    );
  return Number(promoted?.total ?? 0);
}

export async function listCampaignWaves(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<ManagedCampaignWave[]> {
  const rows = await db
    .prepare(
      `SELECT id,campaign_id,ordinal,
              TO_CHAR(admitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS admitted_at,
              member_count,admission_reason,capacity_snapshot
       FROM linkedin_campaign_waves
       WHERE workspace_id=? AND campaign_id=? ORDER BY ordinal DESC`
    )
    .all<{
      id: string;
      campaign_id: string;
      ordinal: number;
      admitted_at: string;
      member_count: number;
      admission_reason: string | null;
      capacity_snapshot: unknown;
    }>(workspaceId, campaignId);
  const funnels = await db
    .prepare(
      `SELECT m.wave_id,a.workflow_step_id,
            COUNT(*)::int AS planned,
            COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied'))::int AS sent,
            COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS accepted,
            COUNT(*) FILTER (WHERE a.status='replied')::int AS replied,
            COUNT(*) FILTER (WHERE a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied'))::int AS failed,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(a.recorded_at,a.planned_for)-m.admitted_at))/60.0)
              FILTER (WHERE m.admitted_at IS NOT NULL AND COALESCE(a.recorded_at,a.planned_for) IS NOT NULL) AS median_from_admission,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.recorded_at-a.planned_for))/60.0)
              FILTER (WHERE a.recorded_at IS NOT NULL AND a.planned_for IS NOT NULL) AS median_queue_latency
     FROM linkedin_actions a JOIN linkedin_campaign_members m ON m.id=a.campaign_member_id AND m.workspace_id=a.workspace_id
     WHERE a.workspace_id=? AND a.campaign_id=? AND m.wave_id IS NOT NULL AND a.workflow_step_id IS NOT NULL
     GROUP BY m.wave_id,a.workflow_step_id`
    )
    .all<{
      wave_id: string;
      workflow_step_id: string;
      planned: number;
      sent: number;
      accepted: number;
      replied: number;
      failed: number;
      median_from_admission: number | null;
      median_queue_latency: number | null;
    }>(workspaceId, campaignId);
  const byWave = new Map<string, ManagedCampaignWave['stepFunnel']>();
  for (const row of funnels) {
    const list = byWave.get(row.wave_id) ?? [];
    list.push({
      stepId: row.workflow_step_id,
      planned: Number(row.planned),
      sent: Number(row.sent),
      accepted: Number(row.accepted),
      replied: Number(row.replied),
      failed: Number(row.failed),
      medianMinutesFromAdmission:
        row.median_from_admission === null ? null : Number(row.median_from_admission),
      medianQueueLatencyMinutes:
        row.median_queue_latency === null ? null : Number(row.median_queue_latency)
    });
    byWave.set(row.wave_id, list);
  }
  const waveSummary = await db
    .prepare(
      `SELECT m.wave_id,
      COUNT(*) FILTER (WHERE m.status IN ('active','waiting','manual','paused'))::int AS backlog,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id AND a.kind='invite' AND a.status IN ('accepted','replied')))::int AS accepted_members,
      COUNT(*) FILTER (WHERE m.status='replied' OR EXISTS (SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id AND a.status='replied'))::int AS replied_members,
      COUNT(*) FILTER (WHERE m.status='failed' OR EXISTS (SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id AND a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied')))::int AS failed_members
      FROM linkedin_campaign_members m WHERE m.workspace_id=? AND m.campaign_id=? AND m.wave_id IS NOT NULL
      GROUP BY m.wave_id`
    )
    .all<{
      wave_id: string;
      backlog: number;
      accepted_members: number;
      replied_members: number;
      failed_members: number;
    }>(workspaceId, campaignId);
  const summaryByWave = new Map(waveSummary.map((item) => [item.wave_id, item]));

  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    ordinal: Number(row.ordinal),
    admittedAt: row.admitted_at,
    memberCount: Number(row.member_count),
    admissionReason: row.admission_reason,
    capacitySnapshot: Object.fromEntries(
      Object.entries(parseJsonObject(row.capacity_snapshot)).filter(
        ([, value]) => typeof value === 'number'
      )
    ) as Record<string, number>,
    stepFunnel: byWave.get(row.id) ?? [],
    acceptanceRate:
      row.member_count > 0
        ? Number(summaryByWave.get(row.id)?.accepted_members ?? 0) / Number(row.member_count)
        : null,
    replyRate:
      row.member_count > 0
        ? Number(summaryByWave.get(row.id)?.replied_members ?? 0) / Number(row.member_count)
        : null,
    failureRate:
      row.member_count > 0
        ? Number(summaryByWave.get(row.id)?.failed_members ?? 0) / Number(row.member_count)
        : null,
    backlog: Number(summaryByWave.get(row.id)?.backlog ?? 0)
  }));
}

/** Create one durable admission cohort and attach each chosen pending member exactly once. */
export async function admitPendingCampaignMembers(
  db: Db,
  input: {
    workspaceId: string;
    campaignId: string;
    steps: readonly WorkflowStep[];
    decision: AdmissionDecision;
    senderKeys: readonly string[];
    /** Sustainable new-lead capacity remaining on each sender for this wave. */
    senderCapacities?: Readonly<Record<string, number>>;
  },
  now: Date = new Date()
): Promise<{ wave: ManagedCampaignWave | null; admitted: number }> {
  const amount = Math.max(0, Math.trunc(input.decision.admit));
  if (amount <= 0) return { wave: null, admitted: 0 };
  const timestamp = now.toISOString();
  const firstEligible = firstEligibleAt(input.steps, now);
  const waveId = id('liwave');
  let ordinal = 0;
  let admitted = 0;
  await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT id FROM linkedin_campaigns WHERE workspace_id=? AND id=? FOR UPDATE')
      .get(input.workspaceId, input.campaignId);
    const next = await tx
      .prepare(
        'SELECT COALESCE(MAX(ordinal),0)::int + 1 AS ordinal FROM linkedin_campaign_waves WHERE workspace_id=? AND campaign_id=?'
      )
      .get<{ ordinal: number }>(input.workspaceId, input.campaignId);
    ordinal = Number(next?.ordinal ?? 1);
    const pending = await tx
      .prepare(
        `SELECT id FROM linkedin_campaign_members
         WHERE workspace_id=? AND campaign_id=? AND status='pending' AND admitted_at IS NULL
         ORDER BY created_at,id LIMIT ? FOR UPDATE SKIP LOCKED`
      )
      .all<{ id: string }>(input.workspaceId, input.campaignId, amount);
    if (pending.length === 0) return;

    const senderKeys = input.senderKeys.length > 0 ? [...input.senderKeys] : [OWNER_SEAT_KEY];
    const rotated = senderKeys.map((_, at) => senderKeys[(ordinal - 1 + at) % senderKeys.length]);
    const hasCapacity = input.senderCapacities !== undefined;
    const capacities = new Map(
      rotated.map((key) => [
        key,
        hasCapacity
          ? Math.max(0, Math.trunc(input.senderCapacities?.[key] ?? 0))
          : Number.POSITIVE_INFINITY
      ])
    );
    const weights = new Map(
      rotated.map((key) => [
        key,
        hasCapacity ? Math.max(1, Math.trunc(input.senderCapacities?.[key] ?? 0)) : 1
      ])
    );
    const assigned = new Map(rotated.map((key) => [key, 0]));
    const assignments: Array<{ memberId: string; sender: string }> = [];
    for (const member of pending) {
      const eligible = rotated.filter((key) => (capacities.get(key) ?? 0) > 0);
      if (eligible.length === 0) break;
      eligible.sort((left, right) => {
        const leftLoad = (assigned.get(left) ?? 0) / Math.max(1, weights.get(left) ?? 1);
        const rightLoad = (assigned.get(right) ?? 0) / Math.max(1, weights.get(right) ?? 1);
        return leftLoad - rightLoad || rotated.indexOf(left) - rotated.indexOf(right);
      });
      const sender = eligible[0];
      assignments.push({ memberId: member.id, sender });
      assigned.set(sender, (assigned.get(sender) ?? 0) + 1);
      if (hasCapacity) capacities.set(sender, Math.max(0, (capacities.get(sender) ?? 0) - 1));
    }
    if (assignments.length === 0) return;

    await tx
      .prepare(
        `INSERT INTO linkedin_campaign_waves (id,workspace_id,campaign_id,ordinal,admitted_at,member_count,admission_reason,capacity_snapshot,created_at)
         VALUES (?,?,?,?,?::timestamptz,?,?,?::jsonb,?::timestamptz)`
      )
      .run(
        waveId,
        input.workspaceId,
        input.campaignId,
        ordinal,
        timestamp,
        assignments.length,
        input.decision.reasons.join(' '),
        JSON.stringify(input.decision.capacitySnapshot),
        timestamp
      );
    // The choice is made once at admission and persisted. Later capacity changes
    // never migrate an in-flight thread to another sender.
    for (const assignment of assignments) {
      const result = await tx
        .prepare(
          `UPDATE linkedin_campaign_members m
           SET status='active',admitted_at=?::timestamptz,wave_id=?,assigned_seat_key=?,
               current_step_id=COALESCE(current_step_id,?),completed_step_ids=COALESCE(completed_step_ids,'[]'::jsonb),
               workflow_snapshot_json=(SELECT c.sequence_json FROM linkedin_campaigns c WHERE c.workspace_id=m.workspace_id AND c.id=m.campaign_id),
               workflow_version=(SELECT CASE WHEN (c.sequence_json->>'workflowVersion') ~ '^[0-9]+$' THEN (c.sequence_json->>'workflowVersion')::integer ELSE NULL END FROM linkedin_campaigns c WHERE c.workspace_id=m.workspace_id AND c.id=m.campaign_id),
               next_eligible_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=? AND status='pending' AND admitted_at IS NULL`
        )
        .run(
          timestamp,
          waveId,
          assignment.sender,
          input.steps[0]?.id ?? null,
          firstEligible,
          timestamp,
          input.workspaceId,
          assignment.memberId
        );
      admitted += result.changes;
    }
    await tx
      .prepare(
        'UPDATE linkedin_campaigns SET last_admission_at=?::timestamptz,updated_at=?::timestamptz WHERE workspace_id=? AND id=?'
      )
      .run(timestamp, timestamp, input.workspaceId, input.campaignId);
  });
  if (admitted === 0) return { wave: null, admitted: 0 };
  return {
    admitted,
    wave: {
      id: waveId,
      campaignId: input.campaignId,
      ordinal,
      admittedAt: timestamp,
      memberCount: admitted,
      admissionReason: input.decision.reasons.join(' '),
      capacitySnapshot: input.decision.capacitySnapshot
    }
  };
}

/**
 * The steps a campaign is executing: its own snapshot, or the live workflow when it has none.
 * The fallback is for campaigns created before the runner read snapshots, and
 * for the legacy playbook campaigns whose `sequence_json` is a different shape
 * entirely. It is a fallback and not the normal path -- a campaign started
 * after this change always has a snapshot, because `startManagedCampaign`
 * writes one.
 */
export async function campaignWorkflowSteps(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<WorkflowStep[]> {
  const row = await db
    .prepare(
      'SELECT sequence_json, workflow_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?'
    )
    .get<{ sequence_json: unknown; workflow_id: string | null }>(workspaceId, campaignId);
  if (!row) return [];
  const snapshot = campaignSnapshotSteps(row.sequence_json);
  if (snapshot.length > 0) return snapshot;
  if (!row.workflow_id) return [];
  return (await getWorkflow(db, workspaceId, row.workflow_id))?.steps ?? [];
}

/**
 * Start -- or resume -- a managed campaign.
 *
 * STARTING IS THE OPERATOR'S ACT OF CHOOSING A WORKFLOW VERSION, so this is
 * where the snapshot in `sequence_json` is (re)written. The runner executes
 * that snapshot and never the live workflow row, which is what makes the
 * campaign screen's promise -- "editing one does not change campaigns already
 * running on it" -- true: an edit reaches a running campaign when, and only
 * when, somebody restarts it.
 *
 * IT ALSO RELEASES THE WORK A PAUSE PARKED. `pauseManagedCampaign` moves this
 * campaign's unclaimed `planned` rows to 'held' (migration 051), which is the
 * only thing that actually stops a pause from sending -- the local worker
 * claims out of `linkedin_actions` and has never read `linkedin_campaigns`.
 * Restoring them here, rather than re-planning them, is what makes resume
 * lossless in both directions: the rows keep their ids, their slots, their
 * approved bodies and their place in the replay index, so nothing is
 * duplicated and nothing is dropped.
 */
export async function startManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status === 'stopped' || campaign.status === 'completed')
    throw new Error(`A ${campaign.status} campaign cannot be started again.`);
  const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
  if (!workflow) throw new Error('Campaign workflow no longer exists.');
  const timestamp = now.toISOString();
  // Resume is lossless. Workflow upgrades are explicit through
  // applyLatestWorkflowToPendingMembers; a pause/resume must never mutate the
  // sequence already chosen for pending leads, and admitted leads carry their
  // own immutable snapshot from wave admission.
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_campaigns SET status='running',started_at=COALESCE(started_at,?),paused_at=NULL,updated_at=? WHERE workspace_id=? AND id=?`
      )
      .run(timestamp, timestamp, workspaceId, campaignId);
    // Pending means not admitted. Starting/resuming a campaign never promotes the whole audience;
    // the runner's admission pass creates a capacity-safe wave later.
    await tx
      .prepare(
        `UPDATE linkedin_actions a SET status='planned'
         WHERE a.workspace_id=? AND a.campaign_id=? AND a.status='held'
           AND (
             a.campaign_member_id IS NULL OR EXISTS (
               SELECT 1 FROM linkedin_campaign_members m
               WHERE m.workspace_id=a.workspace_id AND m.id=a.campaign_member_id
                 AND m.status<>'paused'
             )
           )`
      )
      .run(workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

/**
 * Pause a campaign, and HOLD the work it has already queued.
 *
 * Writing 'paused' into `linkedin_campaigns` on its own was decoration: the
 * local worker claims out of `linkedin_actions` and never looks at this
 * table. So a pause stopped the PLANNER -- the runner
 * skips a campaign that is not running -- and left every invite and DM the
 * runner had already scheduled for the coming days to fire on time. The
 * operator pressed Pause, watched the campaign say Paused, and the sending
 * carried on for as long as the queue reached.
 *
 * REVERSIBLE IS THE CONSTRAINT, and it is what separates this from
 * `stopManagedCampaign` below. Nothing here is destroyed:
 *
 *   * the rows go to 'held' rather than 'skipped' (see migration 051), which
 *     keeps them out of the worker's claim query AND inside the replay index,
 *     so `startManagedCampaign` can hand them straight back;
 *   * MEMBERS ARE NOT TOUCHED. Collapsing 'waiting' and 'active' into 'paused'
 *     would lose the distinction on resume, and worse, it would be
 *     indistinguishable from the per-lead pause an operator sets by hand
 *     (`setCampaignMemberPaused`) -- resuming the campaign would silently
 *     un-pause the individual leads somebody paused deliberately. Members stop
 *     advancing anyway, because the runner only ticks running campaigns.
 *   * PENDING MANUAL TASKS ARE NOT CANCELLED. A cancelled task cannot be
 *     un-cancelled, and a human checkpoint sitting in somebody's queue is not
 *     automated sending -- it is work a person may still choose to do.
 *
 * `claimed_at IS NULL` is the boundary between the two writers, the same one
 * `stopCampaign` draws: a claimed row is already in a browser somewhere and
 * its outcome belongs to the worker holding it. Stopping mid-send is the seat
 * kill switch's job (POST /api/linkedin/seat/pause).
 */
export async function pauseManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    const result = await tx
      .prepare(
        `UPDATE linkedin_campaigns SET status='paused',paused_at=?,updated_at=? WHERE workspace_id=? AND id=? AND status='running'`
      )
      .run(timestamp, timestamp, workspaceId, campaignId);
    // Thrown, not returned: it rolls the hold back with it, so a refused pause
    // cannot leave half a campaign's queue parked.
    if (!result.changes) throw new Error('Only a running campaign can be paused.');
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='held' WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL`
      )
      .run(workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function stopManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_campaigns SET status='stopped',stop_requested_at=COALESCE(stop_requested_at,?::timestamptz),updated_at=? WHERE workspace_id=? AND id=?`
      )
      .run(timestamp, timestamp, workspaceId, campaignId);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=? WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])`
      )
      .run(timestamp, workspaceId, campaignId, [...ACTIVE_MEMBER_STATUSES]);
    await tx
      .prepare(
        `UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND campaign_id=? AND status='pending'`
      )
      .run(workspaceId, campaignId);
    // 'held' as well as 'planned': a campaign stopped while it was PAUSED has
    // its queue parked in 'held' (migration 051), and leaving those rows behind
    // would strand them -- unclaimable forever, and still holding the replay
    // guard against a target this stop is supposed to release.
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
      )
      .run(workspaceId, campaignId);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND campaign_id=?
           AND (status='planned' OR (status='failed' AND outcome_known=TRUE))`
      )
      .run(timestamp, workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function setCampaignMemberPaused(
  db: Db,
  workspaceId: string,
  memberId: string,
  paused: boolean,
  now: Date = new Date()
): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const result = paused
      ? await tx
          .prepare(
            `UPDATE linkedin_campaign_members
             SET paused_from_status=status,status='paused',updated_at=?
             WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual')`
          )
          .run(timestamp, workspaceId, memberId)
      : await tx
          .prepare(
            `UPDATE linkedin_campaign_members
             SET status=CASE
               WHEN admitted_at IS NULL THEN 'pending'
               WHEN paused_from_status IN ('active','waiting','manual') THEN paused_from_status
               ELSE 'active'
             END,
             paused_from_status=NULL,updated_at=?
             WHERE workspace_id=? AND id=? AND status='paused'`
          )
          .run(timestamp, workspaceId, memberId);
    if (!result.changes) return false;

    if (paused) {
      await tx
        .prepare(
          `UPDATE linkedin_actions SET status='held'
           WHERE workspace_id=? AND campaign_member_id=? AND status='planned' AND claimed_at IS NULL`
        )
        .run(workspaceId, memberId);
    } else {
      await tx
        .prepare(
          `UPDATE linkedin_actions a SET status='planned'
           WHERE a.workspace_id=? AND a.campaign_member_id=? AND a.status='held'
             AND EXISTS (
               SELECT 1
               FROM linkedin_campaign_members m
               JOIN linkedin_campaigns c
                 ON c.workspace_id=m.workspace_id AND c.id=m.campaign_id
               WHERE m.workspace_id=a.workspace_id AND m.id=a.campaign_member_id
                 AND c.status='running' AND m.status<>'paused'
             )`
        )
        .run(workspaceId, memberId);
    }
    return true;
  });
}

/**
 * Everything a seat still has outstanding, released -- the call that DELETING
 * OR DISCONNECTING A SEAT MUST MAKE, and did not.
 *
 * `deleteSeat` in seats.ts deletes one row out of `linkedin_seats` and says so
 * in its own comment: the ledger, the detect requests and the stored
 * credentials are deliberately left alone, because none of those are "the
 * seat". That is right about HISTORY and wrong about FUTURE WORK, and the
 * difference is the whole of this function.
 *
 * WHAT AN UNRELEASED SEAT LEAVES BEHIND. `linkedin_actions` rows are keyed on
 * (workspace_id, seat_key) and claimed by a worker running for that seat.
 * Delete the seat and its planned and held rows stay exactly where they were:
 *
 *   * they can never be sent, because no worker will ever run for a seat that
 *     does not exist -- so the work is not cancelled, it is abandoned;
 *   * they go on occupying `idx_linkedin_actions_target`, which is partial on
 *     `status <> 'skipped'` (migration 047), so the replay guard keeps holding
 *     a claim on every one of those prospects. Reconnecting the SAME account
 *     under the same seat key later finds them unreachable, for a reason
 *     nothing on any screen can explain;
 *   * and if the seat key is reused -- which is the normal case, since 'owner'
 *     is the key a single-seat workspace always uses -- a NEW account inherits
 *     the previous one's parked queue, and the first thing it does on being
 *     resumed is send messages the previous operator planned. On a hosted
 *     multi-tenant deployment that is somebody else's outreach going out of a
 *     customer's own LinkedIn account.
 *
 * Pending manual tasks are the same story with a human in it: a checkpoint
 * queued against a seat nobody can act as sits in the operator's task list
 * forever, because `completeManualTask` will happily complete it and advance a
 * member into a sequence that has no account left to run it.
 *
 * SO: SKIP, DO NOT DELETE, and the choice is the same one every other release
 * path here makes. 'skipped' is the ledger's word for "never happened" -- it
 * consumes no budget (actions.ts `COUNTED`), it releases the replay guard so
 * those people can be approached by another seat, and the row survives to say
 * that the action was planned and why it never went out. Deleting the rows
 * would destroy the record of what this seat had been about to do, which is
 * exactly the history `deleteSeat` is careful to preserve.
 *
 * 'held' ALONGSIDE 'planned', because a seat may be disconnected while one of
 * its campaigns is paused, and a held row outliving its seat is the same
 * orphan as a planned one with an extra step before it fires.
 *
 * `claimed_at IS NULL` IS STILL THE BOUNDARY, and the count of what it left is
 * REPORTED rather than swallowed. A claimed row is in a browser at this
 * instant; overwriting it here would file an action as never-happened while it
 * was happening, which is the rule `stopCampaign`, `pauseManagedCampaign` and
 * `removeCampaignMember` all draw. But a seat being disconnected is the one
 * case where nobody is coming back to reconcile those rows, so
 * `actionsInFlight` exists to let the caller say "3 actions were mid-send and
 * were left as they are" instead of quietly rounding it to zero.
 *
 * NOT SCOPED TO A CAMPAIGN. Every other release in this file is; this one is
 * per SEAT, across every campaign and every source -- exports, inbox replies
 * and manual rows included -- because the thing going away is the account, not
 * the plan.
 *
 * Idempotent: running it twice releases nothing the second time, so a
 * disconnect that retries is safe.
 */
export interface SeatWorkRelease {
  seatKey: string;
  /** Planned and held ledger rows moved to 'skipped'. */
  actionsSkipped: number;
  /** Pending manual tasks moved to 'cancelled'. */
  tasksCancelled: number;
  /** Unstarted API-backed channel actions retired with the disconnected sender. */
  channelActionsSkipped: number;
  /** Provider actions already claimed when the sender was disconnected. */
  channelActionsInFlight: number;
  /**
   * Rows a worker had already claimed and this call deliberately did not
   * touch. Zero in every ordinary case; non-zero means a batch was in flight
   * when the seat was disconnected and the caller should say so.
   */
  actionsInFlight: number;
}

export async function releaseSeatWork(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date = new Date()
): Promise<SeatWorkRelease> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const actions = await tx
      .prepare(
        `
      UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL
      WHERE workspace_id=? AND seat_key=? AND status IN ('planned','held') AND claimed_at IS NULL
    `
      )
      .run(workspaceId, seatKey);
    const tasks = await tx
      .prepare(
        `
      UPDATE linkedin_manual_tasks SET status='cancelled',completed_at=COALESCE(completed_at,?::timestamptz)
      WHERE workspace_id=? AND seat_key=? AND status='pending'
    `
      )
      .run(timestamp, workspaceId, seatKey);
    const channelActions = await tx
      .prepare(
        `
      UPDATE linkedin_campaign_channel_actions AS a
      SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
      WHERE a.workspace_id=?
        AND (a.status='planned' OR (a.status='failed' AND a.outcome_known=TRUE))
        AND EXISTS (
          SELECT 1 FROM linkedin_campaign_members m
          WHERE m.workspace_id=a.workspace_id AND m.id=a.member_id AND m.assigned_seat_key=?
        )
    `
      )
      .run(timestamp, workspaceId, seatKey);
    const channelInFlight = await tx
      .prepare(
        `
      SELECT COUNT(*)::int AS total
      FROM linkedin_campaign_channel_actions a
      WHERE a.workspace_id=? AND a.status='claimed'
        AND EXISTS (
          SELECT 1 FROM linkedin_campaign_members m
          WHERE m.workspace_id=a.workspace_id AND m.id=a.member_id AND m.assigned_seat_key=?
        )
    `
      )
      .get<{ total: number }>(workspaceId, seatKey);
    // Counted AFTER the skip, so it is exactly the set the skip refused to
    // touch rather than a number that includes rows this call has just cleared.
    const inFlight = await tx
      .prepare(
        `
      SELECT COUNT(*)::int AS total FROM linkedin_actions
      WHERE workspace_id=? AND seat_key=? AND status IN ('planned','held') AND claimed_at IS NOT NULL
    `
      )
      .get<{ total: number }>(workspaceId, seatKey);
    return {
      seatKey,
      actionsSkipped: actions.changes,
      tasksCancelled: tasks.changes,
      channelActionsSkipped: channelActions.changes,
      channelActionsInFlight: Number(channelInFlight?.total ?? 0),
      actionsInFlight: Number(inFlight?.total ?? 0)
    };
  });
}

export async function removeCampaignMember(
  db: Db,
  workspaceId: string,
  memberId: string,
  now: Date = new Date()
): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const member = await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND status = ANY(?::text[]) RETURNING campaign_id`
      )
      .get<{ campaign_id: string }>(timestamp, workspaceId, memberId, [...ACTIVE_MEMBER_STATUSES]);
    if (!member) return false;
    await tx
      .prepare(
        `UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND member_id=? AND status='pending'`
      )
      .run(workspaceId, memberId);
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
      )
      .run(workspaceId, memberId);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND member_id=?
           AND (status='planned' OR (status='failed' AND outcome_known=TRUE))`
      )
      .run(timestamp, workspaceId, memberId);
    return true;
  });
}

export interface ManualTaskView {
  id: string;
  campaignId: string;
  memberId: string;
  contactId: string;
  seatKey: string;
  workflowStepId: string;
  suggestedBody: string | null;
  taskKind: 'message' | 'comment';
  postUrl: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  firstName: string;
  lastName: string;
  company: string;
  profileUrl: string | null;
}

export async function listManualTasks(
  db: Db,
  workspaceId: string,
  filters: { seatKey?: string; status?: string } = {}
): Promise<ManualTaskView[]> {
  const clauses = ['t.workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) {
    clauses.push('t.seat_key=?');
    params.push(filters.seatKey);
  }
  if (filters.status) {
    clauses.push('t.status=?');
    params.push(filters.status);
  }
  const rows = await db
    .prepare(
      `
    SELECT t.id,t.campaign_id,t.member_id,t.contact_id,t.seat_key,t.workflow_step_id,t.suggested_body,t.task_kind,t.post_url,t.status,t.created_at,t.completed_at,
           l.first_name,l.last_name,l.company,l.profile_url
    FROM linkedin_manual_tasks t JOIN linkedin_lead_contacts l ON l.id=t.contact_id AND l.workspace_id=t.workspace_id
    WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC
  `
    )
    .all<Record<string, unknown>>(...params);
  return rows.map((r) => ({
    id: String(r.id),
    campaignId: String(r.campaign_id),
    memberId: String(r.member_id),
    contactId: String(r.contact_id),
    seatKey: String(r.seat_key),
    workflowStepId: String(r.workflow_step_id),
    suggestedBody: r.suggested_body == null ? null : String(r.suggested_body),
    taskKind: r.task_kind === 'comment' ? 'comment' : 'message',
    postUrl: r.post_url == null ? null : String(r.post_url),
    status: String(r.status),
    createdAt: String(r.created_at),
    completedAt: r.completed_at == null ? null : String(r.completed_at),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    company: String(r.company),
    profileUrl: r.profile_url == null ? null : String(r.profile_url)
  }));
}

/**
 * Tick the human checkpoint off, and move the lead on to the NEXT step's clock.
 *
 * Completes the checkpoint only; sending the message remains the
 * inbox/ledger's job.
 *
 * TWO THINGS THIS USED TO GET WRONG, and both of them were silent.
 *
 * 1. `next_eligible_at = now` ignored the next step's `delayBefore`. A
 *    workflow reading "manual message -> wait 3 days -> follow-up" fired the
 *    follow-up on the very next runner tick, seconds after the operator ticked
 *    the box, on top of the message they had just sent by hand. Per-step delays
 *    were honoured in exactly one place (`runner.ts` `advanceMember`) and this
 *    was the other door into the same state machine.
 *
 *    The delay is measured from `now` here, and that is the right clock for
 *    this door specifically: `advanceMember` measures from the SLOT the step
 *    was planned into because a scheduled step has one, and a manual step does
 *    not -- the only instant that exists for it is the moment the human said
 *    they had done it.
 *
 *    THE STEPS COME FROM THE CAMPAIGN'S SNAPSHOT, not from a live read of the
 *    workflow, for the same reason the runner reads the snapshot: this member
 *    is walking the sequence the campaign was started with.
 *
 * 2. The task was marked completed and `true` returned even when the member
 *    UPDATE matched no rows -- a member that had been paused, removed or had
 *    already replied is not in the 'manual' state, so the task vanished from
 *    the operator's queue and the lead never advanced. The order below is what
 *    fixes it: the member moves FIRST, and the task is only completed once it
 *    actually did. `false` here writes nothing at all, because the row lock is
 *    the only statement that ran before it.
 */
export async function completeManualTask(
  db: Db,
  workspaceId: string,
  taskId: string,
  now: Date = new Date()
): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    // FOR UPDATE, not an UPDATE: it takes the row lock that makes a
    // double-click one completion, without committing anything the member
    // update below might make untrue.
    const task = await tx
      .prepare(
        `
      SELECT t.member_id, t.campaign_id, t.seat_key, t.workflow_step_id, t.suggested_body, l.profile_url,
             m.step_index, m.current_step_id, m.completed_step_ids, m.workflow_snapshot_json
      FROM linkedin_manual_tasks t
      JOIN linkedin_campaign_members m ON m.id = t.member_id AND m.workspace_id = t.workspace_id
      JOIN linkedin_lead_contacts l ON l.id = m.contact_id AND l.workspace_id = m.workspace_id
      WHERE t.workspace_id=? AND t.id=? AND t.status='pending' FOR UPDATE OF t
    `
      )
      .get<{
        member_id: string;
        campaign_id: string;
        seat_key: string;
        workflow_step_id: string | null;
        suggested_body: string | null;
        profile_url: string | null;
        step_index: number;
        current_step_id: string | null;
        completed_step_ids: unknown;
        workflow_snapshot_json: unknown;
      }>(workspaceId, taskId);
    if (!task) return false;

    const snapshotSteps = campaignSnapshotSteps(task.workflow_snapshot_json);
    const steps =
      snapshotSteps.length > 0
        ? snapshotSteps
        : await campaignWorkflowSteps(tx, workspaceId, task.campaign_id);
    const completedStepIds = parseStepIds(task.completed_step_ids);
    if (task.workflow_step_id && !completedStepIds.includes(task.workflow_step_id)) {
      completedStepIds.push(task.workflow_step_id);
    }
    const completedIndex = task.workflow_step_id
      ? steps.findIndex((step) => step.id === task.workflow_step_id)
      : Number(task.step_index);
    const next = nextUncompletedStep(
      steps,
      completedIndex >= 0 ? completedIndex : Number(task.step_index),
      completedStepIds
    );
    const eligible = new Date(
      now.getTime() + (next.step ? delayMilliseconds(next.step.delayBefore) : 0)
    ).toISOString();
    const member = await tx
      .prepare(
        `UPDATE linkedin_campaign_members
         SET status='active', step_index=?, current_step_id=?, completed_step_ids=?::jsonb,
             next_eligible_at=?::timestamptz, updated_at=?
         WHERE workspace_id=? AND id=? AND status='manual' RETURNING id`
      )
      .get<{ id: string }>(
        next.index,
        next.step?.id ?? null,
        JSON.stringify(completedStepIds),
        eligible,
        timestamp,
        workspaceId,
        task.member_id
      );
    if (!member) return false;
    await tx
      .prepare(
        `UPDATE linkedin_manual_tasks SET status='completed',completed_at=? WHERE workspace_id=? AND id=?`
      )
      .run(timestamp, workspaceId, taskId);
    await recordManualMessageAction(tx, workspaceId, task, now);
    return true;
  });
}

/**
 * File the message a completed manual task represents.
 *
 * A `manual_message` STEP PRODUCES A REAL MESSAGE AND PRODUCED NO ROW. The
 * runner writes nothing for it -- `kindForStep` returns null, deliberately,
 * because Trevra does not send it -- and the operator then goes to LinkedIn and
 * sends it themselves, from the same account, on the same day, against the same
 * daily message ceiling as everything the worker sends. The ledger is the
 * denominator of every rolling window in `actions.ts` and of every analytics
 * panel in the product, and it did not contain those messages: a workflow built
 * entirely out of human checkpoints reported zero messages sent forever, and
 * the seat's own 24h message count was short by exactly the messages the
 * operator had been asked to send.
 *
 * FILED ON COMPLETION, NOT ON CREATION, and that is the whole of the
 * no-double-counting argument. A pending task is a request; only completion is
 * the operator saying the message went out. A cancelled task
 * (`releaseSeatWork`, `removeCampaignMember`) never reaches here and files
 * nothing, which is correct -- nothing was sent.
 *
 * KIND 'dm', because that is what it is: a message from this seat to this
 * person. Not a new kind, because a new kind would need its own band, its own
 * ceiling and its own place in the operator's message pool, and the honest
 * answer to all three is "the same as a DM's" -- LinkedIn does not know or care
 * which of the operator's hands sent it. `source: 'manual'` is what tells the
 * two apart in the ledger.
 *
 * `recorded_at` is NOW, the moment the operator says they sent it, so it lands
 * in the day it actually consumed.
 *
 * A member with no profile URL files nothing: `target_ref` is the replay key
 * and a null one would collapse every such task onto a single row.
 */
async function recordManualMessageAction(
  db: Db,
  workspaceId: string,
  task: {
    member_id: string;
    campaign_id: string;
    seat_key: string;
    workflow_step_id: string | null;
    suggested_body: string | null;
    profile_url: string | null;
  },
  now: Date
): Promise<void> {
  if (!task.profile_url) return;
  const written = await recordAction(
    db,
    {
      workspaceId,
      seatKey: task.seat_key,
      kind: 'dm',
      targetRef: task.profile_url,
      campaignId: task.campaign_id,
      status: 'sent',
      source: 'manual',
      // The same member+step scope the runner uses for every other step, so a
      // manual message is a distinct action from the workflow's other messages
      // to the same person and a re-completion is a duplicate rather than a
      // second message.
      replayScope: `${task.member_id}:${task.workflow_step_id ?? 'manual'}`,
      recordedAt: now.toISOString()
    },
    now
  );
  if (written.duplicate) return;
  await db
    .prepare(
      `
    UPDATE linkedin_actions SET body=?, campaign_member_id=?, workflow_step_id=?
    WHERE id=? AND workspace_id=?
  `
    )
    .run(task.suggested_body, task.member_id, task.workflow_step_id, written.id, workspaceId);
}

export interface CampaignLaunchPreview {
  audience: number;
  eligibleSenders: string[];
  dayOneCapacity: Partial<
    Record<'profile_view' | 'invite' | 'dm' | 'inmail' | 'follow' | 'like' | 'endorse', number>
  >;
  sustainableNewLeadsPerDay: number;
  firstWaveSize: number;
  bottleneck: string | null;
  demand: ReturnType<typeof workflowAdmissionDemand>;
  reasons: string[];
  variableCoverage: Record<string, WorkflowVariableCoverage>;
  diagnostics: WorkflowDiagnostic[];
  enrichmentCredits: {
    required: number;
    alreadyAvailable: number;
    estimatedProviderLookups: number;
    cap: number | null;
    capped: boolean;
  };
  personalizationSamples: Array<{
    contactId: string;
    label: string;
    rendered: Array<{ stepId: string; text: string }>;
  }>;
}

async function leadListVariableCoverage(
  db: Db,
  workspaceId: string,
  listId: string,
  variables: readonly string[]
): Promise<Record<string, WorkflowVariableCoverage>> {
  const totalRow = await db
    .prepare(
      'SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?'
    )
    .get<{ total: number }>(workspaceId, listId);
  const total = Number(totalRow?.total ?? 0);
  const coverage: Record<string, WorkflowVariableCoverage> = {};
  const columns: Record<string, string> = {
    first_name: 'first_name',
    last_name: 'last_name',
    company: 'company',
    email: 'email',
    phone: 'phone',
    country: 'country'
  };
  for (const variable of variables) {
    if (variable.startsWith('custom.')) {
      const key = variable.slice(7);
      const row = await db
        .prepare(
          `SELECT COUNT(*) FILTER (
             WHERE NULLIF(BTRIM(COALESCE(jsonb_extract_path_text(c.custom_fields_json, ?),'')),'') IS NOT NULL
           )::int AS present
           FROM linkedin_lead_list_members m
           JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
           WHERE m.workspace_id=? AND m.list_id=?`
        )
        .get<{ present: number }>(key, workspaceId, listId);
      coverage[variable] = { present: Number(row?.present ?? 0), total };
      continue;
    }
    const column = columns[variable];
    if (!column) continue;
    const row = await db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(c.${column},'')),'') IS NOT NULL)::int AS present
         FROM linkedin_lead_list_members m
         JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
         WHERE m.workspace_id=? AND m.list_id=?`
      )
      .get<{ present: number }>(workspaceId, listId);
    coverage[variable] = { present: Number(row?.present ?? 0), total };
  }
  return coverage;
}

function workflowKindToPaced(kind: keyof ReturnType<typeof workflowAdmissionDemand>): PacedKind {
  if (kind === 'invite') return 'invite';
  if (kind === 'dm') return 'dm';
  if (kind === 'profile_view') return 'profile_view';
  if (kind === 'inmail') return 'inmail';
  if (kind === 'follow') return 'follow';
  if (kind === 'like') return 'like';
  return 'endorse';
}

function previewTextForStep(step: WorkflowStep, lead: WorkflowMergeLead): string | null {
  let template: string | null = null;
  if (step.action === 'connection_request')
    template = step.config.variants?.[0]?.body ?? step.config.message ?? null;
  else if (
    step.action === 'message' ||
    step.action === 'group_message' ||
    step.action === 'event_message'
  )
    template = step.config.variants[0]?.body ?? null;
  else if (step.action === 'inmail' || step.action === 'email') {
    const body = step.config.variants[0]?.body ?? '';
    template = `${step.config.subject}${body ? `\n${body}` : ''}`;
  } else if (step.action === 'manual_message' || step.action === 'manual_comment')
    template = step.config.suggestedTemplate ?? null;
  if (!template?.trim()) return null;
  return renderWorkflowTemplate(template, lead);
}

export async function previewManagedCampaignLaunch(
  db: Db,
  input: {
    workspaceId: string;
    leadListId: string;
    workflowId: string;
    senderKeys?: string[];
    seatKey?: string;
    admissionPolicy?: AdmissionPolicy;
    enrichmentCreditCap?: number | null;
  },
  now: Date = new Date()
): Promise<CampaignLaunchPreview> {
  const senders = [
    ...new Set(
      (input.senderKeys?.length ? input.senderKeys : [input.seatKey ?? OWNER_SEAT_KEY]).filter(
        Boolean
      )
    )
  ];
  const workflow = await getWorkflow(db, input.workspaceId, input.workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  const list = await getLeadList(
    db,
    input.workspaceId,
    input.leadListId,
    senders[0] ?? OWNER_SEAT_KEY
  );
  if (!list) throw new Error('Lead list not found.');
  const variableCoverage = await leadListVariableCoverage(
    db,
    input.workspaceId,
    list.id,
    workflowMergeVariables(workflow.steps)
  );
  const diagnostics = diagnoseWorkflow(workflow.steps, variableCoverage);
  const sampleRows = await db
    .prepare(
      `SELECT c.id,c.first_name,c.last_name,c.company,c.email,c.phone,c.country,c.custom_fields_json
      FROM linkedin_lead_list_members m JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
      WHERE m.workspace_id=? AND m.list_id=? ORDER BY m.created_at,c.id LIMIT 3`
    )
    .all<{
      id: string;
      first_name: string;
      last_name: string;
      company: string;
      email: string | null;
      phone: string | null;
      country: string | null;
      custom_fields_json: unknown;
    }>(input.workspaceId, list.id);
  const personalizationSamples = sampleRows.map((row) => {
    const lead: WorkflowMergeLead = {
      firstName: row.first_name,
      lastName: row.last_name,
      company: row.company,
      email: row.email,
      phone: row.phone,
      country: row.country,
      customFields: parseJsonObject(row.custom_fields_json) as Record<
        string,
        string | number | boolean | null | undefined
      >
    };
    return {
      contactId: row.id,
      label: `${row.first_name} ${row.last_name}`.trim() || row.company || row.id,
      rendered: workflow.steps.flatMap((step) => {
        const text = previewTextForStep(step, lead);
        return text === null ? [] : [{ stepId: step.id, text }];
      })
    };
  });
  const demand = workflowAdmissionDemand(workflow.steps);
  const capacity: CampaignLaunchPreview['dayOneCapacity'] = {};
  const eligibleSenders: string[] = [];
  for (const key of senders) {
    const seat = await getSeat(db, input.workspaceId, key);
    if (!seat) continue;
    const posture = effectivePosture(seat, now);
    if (posture === 'paused' || posture === 'cooldown' || seat.workingDays.length === 0) continue;
    eligibleSenders.push(key);
    for (const kind of Object.keys(demand) as Array<keyof typeof demand>) {
      if (demand[kind] <= 0) continue;
      const paced = workflowKindToPaced(kind);
      const band = bandFor(paced, posture === 'steady' ? 'steady' : 'warmup');
      const ceiling = effectiveDailyCeiling(
        band.perDay,
        seatOperatorLimit(seat, paced),
        seat.safetyBandOverride
      );
      const warmupMultiplier = seat.warmupOverride
        ? 1
        : warmupMultiplierFor(paced, warmupWeekOf(seat.activatedAt, now));
      const accountToday = Math.floor(ceiling * warmupMultiplier);
      const dayOne = campaignActionLimit(accountToday, null, now);
      capacity[kind] = (capacity[kind] ?? 0) + dayOne;
    }
  }
  const decision = decideAdmission({
    steps: workflow.steps,
    pending: list.leadCount,
    inSequence: 0,
    admittedToday: 0,
    available: capacity,
    backlog: {},
    policy: input.admissionPolicy,
    now,
    hasUsableFutureSlot: eligibleSenders.length > 0
  });
  const findEmailSteps = workflow.steps.filter((step) => step.action === 'find_email').length;
  const emailRows = await db
    .prepare(
      `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(c.email,'')),'') IS NOT NULL)::int AS available
      FROM linkedin_lead_list_members m JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
      WHERE m.workspace_id=? AND m.list_id=?`
    )
    .get<{ total: number; available: number }>(input.workspaceId, list.id);
  const alreadyAvailable = Number(emailRows?.available ?? 0);
  const estimatedProviderLookups =
    findEmailSteps > 0
      ? Math.max(0, Number(emailRows?.total ?? list.leadCount) - alreadyAvailable)
      : 0;
  const enrichmentCap = input.enrichmentCreditCap ?? null;
  return {
    audience: list.leadCount,
    eligibleSenders,
    dayOneCapacity: capacity,
    sustainableNewLeadsPerDay: decision.admit,
    firstWaveSize: decision.admit,
    bottleneck: decision.limitingKind,
    demand,
    reasons: decision.reasons,
    variableCoverage,
    diagnostics,
    enrichmentCredits: {
      required: estimatedProviderLookups,
      alreadyAvailable,
      estimatedProviderLookups,
      cap: enrichmentCap,
      capped: enrichmentCap !== null && estimatedProviderLookups > enrichmentCap
    },
    personalizationSamples
  };
}

export async function campaignQueueSummary(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<CampaignQueueSummary> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const rows = await db
    .prepare(
      `SELECT step_index,status,COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE next_eligible_at IS NULL OR next_eligible_at<=?::timestamptz)::int AS due
     FROM linkedin_campaign_members
     WHERE workspace_id=? AND campaign_id=?
     GROUP BY step_index,status ORDER BY step_index,status`
    )
    .all<{ step_index: number; status: string; total: number; due: number }>(
      now.toISOString(),
      workspaceId,
      campaignId
    );
  const backlog = new Map<number, { count: number; due: number }>();
  let pending = 0,
    dueNow = 0,
    manual = 0,
    failed = 0,
    waitingForConnection = 0,
    waitingForReply = 0,
    waitingOther = 0;
  for (const row of rows) {
    const count = Number(row.total),
      due = Number(row.due);
    if (row.status === 'pending') pending += count;
    if (row.status === 'manual') manual += count;
    if (row.status === 'failed') failed += count;
    if (['active', 'waiting'].includes(row.status)) {
      dueNow += due;
      const current = backlog.get(Number(row.step_index)) ?? { count: 0, due: 0 };
      current.count += count;
      current.due += due;
      backlog.set(Number(row.step_index), current);
      const step = campaign.steps[Number(row.step_index)];
      if (
        (step?.action === 'monitor' || step?.action === 'condition') &&
        ['connected', 'accepted'].includes(step.config.condition.kind)
      )
        waitingForConnection += count;
      else if (
        (step?.action === 'monitor' || step?.action === 'condition') &&
        step.config.condition.kind === 'replied'
      )
        waitingForReply += count;
      else if (row.status === 'waiting') waitingOther += count;
    }
  }
  const actionCounts = await db
    .prepare(
      /*
       * A ROW PARKED ON AN UNRESOLVED OUTCOME IS NOT QUEUED WORK.
       *
       * `settlement_hold_at` means the action was claimed, something happened,
       * and we could not read back WHAT -- so re-running it could put a second
       * invite in somebody's notifications. The reaper's predicate is
       * `settlement_hold_at IS NULL`, so no browser will ever take these rows
       * again; they are waiting for a PERSON. Counting them in `queued_ready`
       * made the campaign card report them as "waiting for the LinkedIn
       * executor to claim them", which is a promise nothing in this system
       * intends to keep. They are still counted, once, in `held_for_review`.
       */
      `SELECT
       COUNT(*) FILTER (WHERE status='planned' AND planned_for>=?::timestamptz AND planned_for<?::timestamptz)::int AS scheduled,
       COUNT(*) FILTER (WHERE status='planned' AND planned_for<=?::timestamptz AND claimed_at IS NULL AND settlement_hold_at IS NULL)::int AS queued_ready,
       COUNT(*) FILTER (WHERE status='planned' AND planned_for>?::timestamptz AND claimed_at IS NULL AND settlement_hold_at IS NULL)::int AS scheduled_future,
       COUNT(*) FILTER (WHERE status='planned' AND claimed_at IS NOT NULL AND settlement_hold_at IS NULL)::int AS executing,
       COUNT(*) FILTER (WHERE status='held' OR settlement_hold_at IS NOT NULL)::int AS held_for_review,
       COUNT(*) FILTER (WHERE status='held')::int AS held
     FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?`
    )
    .get<{
      scheduled: number;
      queued_ready: number;
      scheduled_future: number;
      executing: number;
      held_for_review: number;
      held: number;
    }>(
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      workspaceId,
      campaignId
    );

  const campaignStart = campaign.startedAt ? Date.parse(campaign.startedAt) : Number.NaN;
  const dayStartMs = Number.isFinite(campaignStart)
    ? campaignStart +
      Math.max(0, Math.floor((now.getTime() - campaignStart) / 86_400_000)) * 86_400_000
    : now.getTime();
  const dayStart = new Date(dayStartMs).toISOString();
  const dayEnd = new Date(dayStartMs + 86_400_000).toISOString();
  const allocations = await db
    .prepare(
      `SELECT
       COUNT(*) FILTER (WHERE kind IN ('invite','group_invite','event_invite','company_invite'))::int AS invite,
       COUNT(*) FILTER (WHERE kind IN ('dm','reply','inmail','group_message','event_message'))::int AS dm,
       COUNT(*) FILTER (WHERE kind='profile_view')::int AS profile_view,
       COUNT(*) FILTER (WHERE kind IN ('follow','unfollow','disconnect','company_follow'))::int AS follow
     FROM linkedin_actions
     WHERE workspace_id=? AND campaign_id=? AND status<>'skipped'
       AND planned_for IS NOT NULL AND planned_for>=?::timestamptz AND planned_for<?::timestamptz`
    )
    .get<Record<'invite' | 'dm' | 'profile_view' | 'follow', number>>(
      workspaceId,
      campaignId,
      dayStart,
      dayEnd
    );
  const blocked =
    (
      await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members
     WHERE workspace_id=? AND campaign_id=? AND status IN ('active','waiting') AND last_failure_reason IS NOT NULL`
        )
        .get<{ total: number }>(workspaceId, campaignId)
    )?.total ?? 0;
  return {
    pending,
    dueNow,
    scheduledToday: Number(actionCounts?.scheduled ?? 0),
    queuedReady: Number(actionCounts?.queued_ready ?? 0),
    scheduledFuture: Number(actionCounts?.scheduled_future ?? 0),
    executing: Number(actionCounts?.executing ?? 0),
    heldForReview: Number(actionCounts?.held_for_review ?? 0),
    waitingForConnection,
    waitingForReply,
    waitingOther,
    manual,
    held: Number(actionCounts?.held ?? 0),
    blocked: Number(blocked),
    failed,
    allocatedCampaignDay: {
      invite: Number(allocations?.invite ?? 0),
      dm: Number(allocations?.dm ?? 0),
      profile_view: Number(allocations?.profile_view ?? 0),
      follow: Number(allocations?.follow ?? 0)
    },
    backlogByStep: [...backlog.entries()].map(([index, value]) => ({
      stepId: campaign.steps[index]?.id ?? `step-${index + 1}`,
      ...value
    }))
  };
}

export async function campaignAdmissionSummary(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<{
  campaign: ManagedCampaign;
  queues: CampaignQueueSummary;
  waves: ManagedCampaignWave[];
}> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const [queues, waves] = await Promise.all([
    campaignQueueSummary(db, workspaceId, campaignId, now),
    listCampaignWaves(db, workspaceId, campaignId)
  ]);
  return { campaign, queues, waves };
}

export async function updateManagedCampaignControls(
  db: Db,
  workspaceId: string,
  campaignId: string,
  input: {
    priority?: CampaignPriority;
    admissionPolicy?: AdmissionPolicy;
    exclusionPolicy?: CampaignExclusionPolicy;
    schedule?: Partial<CampaignSchedule>;
    senderKeys?: string[];
    mailboxAssignments?: Record<string, string>;
    inmailCreditCap?: number | null;
    enrichmentCreditCap?: number | null;
  },
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (input.schedule) assertCampaignSchedule({ ...campaign.schedule, ...input.schedule });
  if (
    (input.admissionPolicy ||
      input.exclusionPolicy ||
      input.schedule ||
      input.senderKeys ||
      input.mailboxAssignments) &&
    campaign.status === 'running'
  ) {
    throw new Error(
      'Pause the campaign before changing admission, exclusions, schedule, or sender settings. Priority may be changed while running.'
    );
  }
  const senderKeys = input.senderKeys
    ? [...new Set(input.senderKeys.map((v) => v.trim()).filter(Boolean))]
    : null;
  if (senderKeys) {
    if (senderKeys.length === 0) throw new Error('A campaign needs at least one sender.');
    for (const key of senderKeys)
      if (!(await getSeat(db, workspaceId, key)))
        throw new Error(`LinkedIn account '${key}' is not configured.`);
  }
  if (
    input.inmailCreditCap != null &&
    (!Number.isInteger(input.inmailCreditCap) ||
      input.inmailCreditCap < 0 ||
      input.inmailCreditCap > 10000)
  )
    throw new Error('Campaign InMail credit cap must be a whole number from 0 to 10000.');
  if (
    input.enrichmentCreditCap != null &&
    (!Number.isInteger(input.enrichmentCreditCap) ||
      input.enrichmentCreditCap < 0 ||
      input.enrichmentCreditCap > 100000)
  )
    throw new Error('Campaign enrichment credit cap must be a whole number from 0 to 100000.');
  const timestamp = now.toISOString();
  await db
    .prepare(
      `UPDATE linkedin_campaigns SET
       priority=COALESCE(?,priority),
       admission_policy_json=COALESCE(?::jsonb,admission_policy_json),
       exclusion_policy_json=COALESCE(?::jsonb,exclusion_policy_json),
       sender_keys_json=COALESCE(?::jsonb,sender_keys_json),
       mailbox_assignments_json=COALESCE(?::jsonb,mailbox_assignments_json),
       seat_key=COALESCE(?,seat_key),
       scheduled_start_at=CASE WHEN ?::boolean THEN ?::timestamptz ELSE scheduled_start_at END,
       scheduled_end_at=CASE WHEN ?::boolean THEN ?::timestamptz ELSE scheduled_end_at END,
       schedule_days_json=CASE WHEN ?::boolean THEN ?::jsonb ELSE schedule_days_json END,
       schedule_start_minute=CASE WHEN ?::boolean THEN ? ELSE schedule_start_minute END,
       schedule_end_minute=CASE WHEN ?::boolean THEN ? ELSE schedule_end_minute END,
       end_behavior=COALESCE(?,end_behavior),
       inmail_credit_cap=CASE WHEN ?::boolean THEN ? ELSE inmail_credit_cap END,
       enrichment_credit_cap=CASE WHEN ?::boolean THEN ? ELSE enrichment_credit_cap END,updated_at=?
     WHERE workspace_id=? AND id=?`
    )
    .run(
      input.priority === undefined
        ? null
        : input.priority === 'high'
          ? 1
          : input.priority === 'low'
            ? -1
            : 0,
      input.admissionPolicy === undefined ? null : JSON.stringify(input.admissionPolicy),
      input.exclusionPolicy === undefined ? null : JSON.stringify(input.exclusionPolicy),
      senderKeys === null ? null : JSON.stringify(senderKeys),
      input.mailboxAssignments === undefined ? null : JSON.stringify(input.mailboxAssignments),
      senderKeys?.[0] ?? null,
      input.schedule?.startAt !== undefined,
      input.schedule?.startAt ?? null,
      input.schedule?.endAt !== undefined,
      input.schedule?.endAt ?? null,
      input.schedule?.workingDays !== undefined,
      input.schedule?.workingDays === undefined ? null : JSON.stringify(input.schedule.workingDays),
      input.schedule?.workStartMinute !== undefined,
      input.schedule?.workStartMinute ?? null,
      input.schedule?.workEndMinute !== undefined,
      input.schedule?.workEndMinute ?? null,
      input.schedule?.endBehavior ?? null,
      input.inmailCreditCap !== undefined,
      input.inmailCreditCap ?? null,
      input.enrichmentCreditCap !== undefined,
      input.enrichmentCreditCap ?? null,
      timestamp,
      workspaceId,
      campaignId
    );
  if (input.exclusionPolicy !== undefined)
    await reevaluateCampaignExclusions(db, workspaceId, campaignId, now);
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function setManagedCampaignOwner(
  db: Db,
  workspaceId: string,
  campaignId: string,
  ownerUserId: string | null,
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const result = await db
    .prepare(
      'UPDATE linkedin_campaigns SET owner_user_id=?,updated_at=? WHERE workspace_id=? AND id=?'
    )
    .run(ownerUserId, now.toISOString(), workspaceId, campaignId);
  if (result.changes === 0) throw new Error('Campaign not found.');
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function duplicateManagedCampaign(
  db: Db,
  workspaceId: string,
  campaignId: string,
  name?: string,
  now: Date = new Date()
): Promise<{
  campaign: ManagedCampaign;
  enrolled: number;
  skippedAlreadyActive: number;
  excluded: number;
}> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  return createManagedCampaign(
    db,
    {
      workspaceId,
      ownerUserId: campaign.ownerUserId,
      name: (name?.trim() || `${campaign.name} copy`).slice(0, 120),
      senderKeys: campaign.senderKeys,
      leadListId: campaign.leadListId,
      workflowId: campaign.workflowId,
      priority: campaign.priority,
      admissionPolicy: campaign.admissionPolicy,
      exclusionPolicy: campaign.exclusionPolicy,
      schedule: campaign.schedule,
      inmailCreditCap: campaign.inmailCreditCap,
      enrichmentCreditCap: campaign.enrichmentCreditCap
    },
    now
  );
}

export async function applyLatestWorkflowToPendingMembers(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<{
  campaign: ManagedCampaign;
  previousVersion: number | null;
  latestVersion: number;
  pendingAffected: number;
}> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status === 'stopped' || campaign.status === 'completed')
    throw new Error(`A ${campaign.status} campaign cannot be upgraded.`);
  const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
  if (!workflow) throw new Error('Campaign workflow no longer exists.');
  const snapshot = JSON.stringify({
    manager: true,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    steps: workflow.steps
  });
  const timestamp = now.toISOString();
  const pending = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members
       WHERE workspace_id=? AND campaign_id=? AND admitted_at IS NULL AND status='pending'`
    )
    .get<{ total: number }>(workspaceId, campaignId);
  await db
    .prepare(
      `UPDATE linkedin_campaigns SET sequence_json=?::jsonb,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=?`
    )
    .run(snapshot, timestamp, workspaceId, campaignId);
  return {
    campaign: (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign,
    previousVersion: campaign.workflowVersion,
    latestVersion: workflow.version,
    pendingAffected: Number(pending?.total ?? 0)
  };
}

export interface CampaignMemberTimeline {
  member: ManagedCampaignMember;
  events: Array<{
    at: string | null;
    eventId?: string | null;
    requiresResolution?: boolean;
    kind: 'wave' | 'action' | 'channel' | 'manual' | 'branch' | 'state';
    label: string;
    status?: string;
    stepId?: string | null;
    stepLabel?: string | null;
    senderKey?: string | null;
    variantId?: string | null;
    approvedText?: string | null;
    detail?: string | null;
  }>;
}

export async function campaignMemberTimeline(
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<CampaignMemberTimeline | null> {
  const memberRow = await db
    .prepare(
      `SELECT m.id,m.campaign_id,m.contact_id,m.status,m.step_index,m.next_eligible_at,m.admitted_at,m.wave_id,w.ordinal AS wave_ordinal,
            m.assigned_seat_key,m.workflow_snapshot_json,m.workflow_version,m.assigned_variants,m.branch_state_json,m.last_action_id,m.exclusion_reason,m.last_failure_reason,
            la.kind AS last_action_kind,la.status AS last_action_status,la.planned_for AS last_action_planned_for,
            la.claimed_at AS last_action_claimed_at,la.settlement_hold_at AS last_action_settlement_hold_at,la.failure_kind AS last_action_failure_kind,
            l.first_name,l.last_name,l.company,l.email,l.profile_url,l.custom_fields_json
     FROM linkedin_campaign_members m JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
     LEFT JOIN linkedin_campaign_waves w ON w.id=m.wave_id AND w.workspace_id=m.workspace_id
     LEFT JOIN linkedin_actions la ON la.id=m.last_action_id AND la.workspace_id=m.workspace_id
     WHERE m.workspace_id=? AND m.id=?`
    )
    .get<MemberRow>(workspaceId, memberId);
  if (!memberRow) return null;
  const member = toMember(memberRow);
  const memberSteps = campaignSnapshotSteps(memberRow.workflow_snapshot_json);
  const stepLabel = (stepId: string | null): string | null => {
    if (!stepId) return null;
    const step = memberSteps.find((candidate) => candidate.id === stepId);
    return step ? step.action.replaceAll('_', ' ') : null;
  };
  const events: CampaignMemberTimeline['events'] = [];
  if (member.admittedAt)
    events.push({
      at: member.admittedAt,
      kind: 'wave',
      label: `Admitted${member.waveOrdinal ? ` in wave ${member.waveOrdinal}` : ''}`
    });
  const actions = await db
    .prepare(
      `SELECT id,kind,status,workflow_step_id,planned_for,recorded_at,failure_kind,external_ref,seat_key,variant_id,body,settlement_hold_at
     FROM linkedin_actions WHERE workspace_id=? AND campaign_member_id=? ORDER BY COALESCE(recorded_at,planned_for,created_at),created_at`
    )
    .all<{
      id: string;
      kind: string;
      status: string;
      workflow_step_id: string | null;
      planned_for: string | null;
      recorded_at: string | null;
      failure_kind: string | null;
      external_ref: string | null;
      seat_key: string;
      variant_id: string | null;
      body: string | null;
      settlement_hold_at: string | null;
    }>(workspaceId, memberId);
  for (const action of actions)
    events.push({
      at: action.recorded_at ?? action.planned_for,
      eventId: action.id,
      requiresResolution: action.settlement_hold_at !== null,
      kind: 'action',
      label: action.kind.replaceAll('_', ' '),
      status: action.status,
      stepId: action.workflow_step_id,
      stepLabel: stepLabel(action.workflow_step_id),
      senderKey: action.seat_key,
      variantId: action.variant_id,
      approvedText: action.body,
      detail: action.failure_kind ?? action.external_ref
    });
  const channelActions = await db
    .prepare(
      `SELECT id,kind,status,workflow_step_id,planned_for,completed_at,last_error,external_ref,provider,variant_id,payload_json
       FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND member_id=?
       ORDER BY COALESCE(completed_at,planned_for,created_at),created_at`
    )
    .all<{
      id: string;
      kind: string;
      status: string;
      workflow_step_id: string;
      planned_for: string;
      completed_at: string | null;
      last_error: string | null;
      external_ref: string | null;
      provider: string | null;
      variant_id: string | null;
      payload_json: unknown;
    }>(workspaceId, memberId);
  for (const action of channelActions) {
    const payload = parseJsonObject(action.payload_json);
    const subject = typeof payload.subject === 'string' ? payload.subject : '';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const approvedText = [subject, body].filter(Boolean).join('\n') || null;
    events.push({
      at: action.completed_at ?? action.planned_for,
      eventId: action.id,
      requiresResolution: action.status === 'unknown',
      kind: 'channel',
      label: action.kind.replaceAll('_', ' '),
      status: action.status,
      stepId: action.workflow_step_id,
      stepLabel: stepLabel(action.workflow_step_id),
      senderKey:
        typeof payload.connectionId === 'string'
          ? payload.connectionId
          : typeof payload.mailboxConnectionId === 'string'
            ? payload.mailboxConnectionId
            : null,
      variantId: action.variant_id,
      approvedText,
      detail: action.last_error ?? action.external_ref ?? action.provider
    });
    const emailEvents = await db
      .prepare(
        `SELECT event_kind,occurred_at FROM linkedin_campaign_email_events
         WHERE workspace_id=? AND channel_action_id=? ORDER BY occurred_at`
      )
      .all<{ event_kind: string; occurred_at: string }>(workspaceId, action.id);
    for (const emailEvent of emailEvents)
      events.push({
        at: emailEvent.occurred_at,
        kind: 'channel',
        label: `email ${emailEvent.event_kind.replaceAll('_', ' ')}`,
        status: emailEvent.event_kind,
        stepId: action.workflow_step_id,
        stepLabel: stepLabel(action.workflow_step_id),
        variantId: action.variant_id
      });
  }

  const manuals = await db
    .prepare(
      `SELECT status,workflow_step_id,created_at,completed_at FROM linkedin_manual_tasks WHERE workspace_id=? AND member_id=? ORDER BY created_at`
    )
    .all<{
      status: string;
      workflow_step_id: string;
      created_at: string;
      completed_at: string | null;
    }>(workspaceId, memberId);
  for (const task of manuals)
    events.push({
      at: task.created_at,
      kind: 'manual',
      label: 'Manual checkpoint',
      status: task.status,
      stepId: task.workflow_step_id,
      stepLabel: stepLabel(task.workflow_step_id)
    });
  for (const [key, value] of Object.entries(member.branchState)) {
    if (!key.startsWith('branch:')) continue;
    const obj =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    events.push({
      at: typeof obj.at === 'string' ? obj.at : null,
      kind: 'branch',
      label: `Branch ${String(obj.outcome ?? 'evaluated')}`,
      stepId: key.slice(7),
      stepLabel: stepLabel(key.slice(7)),
      detail: typeof obj.reason === 'string' ? obj.reason : null
    });
  }
  if (member.exclusionReason)
    events.push({
      at: null,
      kind: 'state',
      label: 'Excluded',
      status: 'excluded',
      detail: member.exclusionReason
    });
  events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return { member, events };
}

export async function endManagedCampaignMember(
  db: Db,
  workspaceId: string,
  memberId: string,
  outcome: 'completed' | 'excluded' | 'removed' = 'completed',
  now: Date = new Date()
): Promise<boolean> {
  const timestamp = now.toISOString();
  let changed = 0;
  await db.transaction(async (tx) => {
    const result = await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET status=?,next_eligible_at=NULL,ended_at=?::timestamptz,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual','paused')`
      )
      .run(outcome, timestamp, timestamp, workspaceId, memberId);
    changed = result.changes;
    if (changed > 0) {
      await tx
        .prepare(
          `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
        )
        .run(workspaceId, memberId);
      await tx
        .prepare(
          `UPDATE linkedin_campaign_channel_actions
           SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
           WHERE workspace_id=? AND member_id=?
             AND (status='planned' OR (status='failed' AND outcome_known=TRUE))`
        )
        .run(timestamp, workspaceId, memberId);
      await tx
        .prepare(
          `UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND member_id=? AND status='pending'`
        )
        .run(workspaceId, memberId);
    }
  });
  return changed > 0;
}

export async function skipManagedCampaignMemberStep(
  db: Db,
  workspaceId: string,
  memberId: string,
  now: Date = new Date()
): Promise<boolean> {
  if (await unresolvedOutcomeForMember(db, workspaceId, memberId))
    throw new Error(
      'Resolve the unknown action outcome before changing this lead’s workflow position.'
    );

  const context = await memberExecutionContext(db, workspaceId, memberId);
  if (!context || !['active', 'waiting', 'manual', 'paused'].includes(context.status)) return false;
  const currentIndex =
    context.currentStepId === null
      ? context.stepIndex
      : context.steps.findIndex((step) => step.id === context.currentStepId);
  const index = currentIndex >= 0 ? currentIndex : context.stepIndex;
  const step = context.steps[index];
  if (!step) return false;
  const completed = [...context.completedStepIds];
  if (!completed.includes(step.id)) completed.push(step.id);

  let nextIndex: number | null;
  if (step.nextStepId === null) nextIndex = null;
  else if (step.nextStepId) {
    const explicit = context.steps.findIndex((candidate) => candidate.id === step.nextStepId);
    if (explicit < 0) nextIndex = null;
    else {
      const nextUncompleted = nextUncompletedStep(context.steps, explicit - 1, completed);
      nextIndex = nextUncompleted.step ? nextUncompleted.index : null;
    }
  } else {
    const nextUncompleted = nextUncompletedStep(context.steps, index, completed);
    nextIndex = nextUncompleted.step ? nextUncompleted.index : null;
  }
  const next = nextIndex === null ? null : context.steps[nextIndex];
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL,claimed_by=NULL,
             lease_expires_at=NULL,batch_id=NULL
         WHERE workspace_id=? AND campaign_member_id=? AND workflow_step_id=?
           AND status IN ('planned','held') AND claimed_at IS NULL`
      )
      .run(workspaceId, memberId, step.id);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status='skipped',claimed_at=NULL,outcome_known=TRUE,updated_at=?::timestamptz
         WHERE workspace_id=? AND member_id=? AND workflow_step_id=?
           AND status IN ('planned','failed') AND outcome_known=TRUE`
      )
      .run(timestamp, workspaceId, memberId, step.id);
    await tx
      .prepare(
        `UPDATE linkedin_manual_tasks SET status='cancelled'
         WHERE workspace_id=? AND member_id=? AND workflow_step_id=? AND status='pending'`
      )
      .run(workspaceId, memberId, step.id);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_members
         SET step_index=?,current_step_id=?,completed_step_ids=?::jsonb,status=?,
             next_eligible_at=?::timestamptz,last_action_id=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(
        next ? nextIndex : context.steps.length,
        next?.id ?? null,
        JSON.stringify(completed),
        next ? 'waiting' : 'completed',
        next ? new Date(now.getTime() + delayMilliseconds(next.delayBefore)).toISOString() : null,
        timestamp,
        workspaceId,
        memberId
      );
  });
  return true;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Exportable campaign result rows with no internal ledger identifiers required by the recipient. */
export async function exportManagedCampaignCsv(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<string | null> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) return null;
  const rows = await db
    .prepare(
      `SELECT m.status,m.step_index,m.admitted_at,m.wave_id,w.ordinal AS wave_ordinal,m.assigned_seat_key,
              m.exclusion_reason,m.last_failure_reason,l.first_name,l.last_name,l.company,l.email,l.phone,l.country,l.profile_url,
              COUNT(a.id) FILTER (WHERE a.status IN ('sent','accepted','replied'))::int AS actions_sent,
              COUNT(a.id) FILTER (WHERE a.status='replied')::int AS replies,
              COUNT(a.id) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS invites_accepted
       FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
       LEFT JOIN linkedin_campaign_waves w ON w.id=m.wave_id AND w.workspace_id=m.workspace_id
       LEFT JOIN linkedin_actions a ON a.campaign_member_id=m.id AND a.workspace_id=m.workspace_id
       WHERE m.workspace_id=? AND m.campaign_id=?
       GROUP BY m.id,w.ordinal,l.id
       ORDER BY m.created_at,m.id`
    )
    .all<Record<string, unknown>>(workspaceId, campaignId);
  const headers = [
    'first_name',
    'last_name',
    'company',
    'email',
    'phone',
    'country',
    'linkedin_url',
    'status',
    'workflow_step',
    'wave',
    'sender',
    'admitted_at',
    'actions_sent',
    'invites_accepted',
    'replies',
    'exclusion_reason',
    'failure_reason'
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = [
      row.first_name,
      row.last_name,
      row.company,
      row.email,
      row.phone,
      row.country,
      row.profile_url,
      row.status,
      Number(row.step_index ?? 0) + 1,
      row.wave_ordinal,
      row.assigned_seat_key,
      row.admitted_at,
      row.actions_sent,
      row.invites_accepted,
      row.replies,
      row.exclusion_reason,
      row.last_failure_reason
    ];
    lines.push(values.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function recordManagedCampaignAudit(
  db: Db,
  input: {
    workspaceId: string;
    actorId: string;
    eventType: string;
    entityType: 'linkedin_campaign' | 'linkedin_campaign_member' | 'linkedin_workflow';
    entityId: string;
    metadata?: Record<string, unknown>;
  },
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?::timestamptz)`
    )
    .run(
      id('audit'),
      input.workspaceId,
      'user',
      input.actorId,
      input.eventType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.metadata ?? {}),
      now.toISOString()
    );
}

async function memberExecutionContext(
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<{
  campaignId: string;
  status: string;
  stepIndex: number;
  currentStepId: string | null;
  completedStepIds: string[];
  steps: WorkflowStep[];
} | null> {
  const row = await db
    .prepare(
      `SELECT campaign_id,status,step_index,current_step_id,completed_step_ids,workflow_snapshot_json
       FROM linkedin_campaign_members WHERE workspace_id=? AND id=?`
    )
    .get<{
      campaign_id: string;
      status: string;
      step_index: number;
      current_step_id: string | null;
      completed_step_ids: unknown;
      workflow_snapshot_json: unknown;
    }>(workspaceId, memberId);
  if (!row) return null;
  const memberSteps = campaignSnapshotSteps(row.workflow_snapshot_json);
  const steps =
    memberSteps.length > 0
      ? memberSteps
      : await campaignWorkflowSteps(db, workspaceId, row.campaign_id);
  return {
    campaignId: row.campaign_id,
    status: row.status,
    stepIndex: Number(row.step_index),
    currentStepId: row.current_step_id,
    completedStepIds: parseStepIds(row.completed_step_ids),
    steps
  };
}

export type UnknownOutcomeResolution = 'sent' | 'retry' | 'skip';

async function unresolvedOutcomeForMember(
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS unresolved
       WHERE EXISTS (
         SELECT 1 FROM linkedin_actions
         WHERE workspace_id=? AND campaign_member_id=? AND settlement_hold_at IS NOT NULL
       ) OR EXISTS (
         SELECT 1 FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND member_id=? AND status='unknown' AND outcome_known=FALSE
       )`
    )
    .get<{ unresolved: number }>(workspaceId, memberId, workspaceId, memberId);
  return row !== undefined;
}

async function advanceMemberAfterResolvedLinkedInAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  now: Date
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT a.campaign_member_id,a.workflow_step_id,
              m.current_step_id,m.step_index,m.completed_step_ids,m.workflow_snapshot_json,m.campaign_id
       FROM linkedin_actions a
       JOIN linkedin_campaign_members m
         ON m.workspace_id=a.workspace_id AND m.id=a.campaign_member_id
       WHERE a.id=? AND a.workspace_id=?`
    )
    .get<{
      campaign_member_id: string | null;
      workflow_step_id: string | null;
      current_step_id: string | null;
      step_index: number;
      completed_step_ids: unknown;
      workflow_snapshot_json: unknown;
      campaign_id: string;
    }>(actionId, workspaceId);
  if (!row?.campaign_member_id || !row.workflow_step_id) return;
  const memberSteps = campaignSnapshotSteps(row.workflow_snapshot_json);
  const steps =
    memberSteps.length > 0
      ? memberSteps
      : await campaignWorkflowSteps(db, workspaceId, row.campaign_id);
  const currentIndex = steps.findIndex((step) => step.id === row.workflow_step_id);
  if (currentIndex < 0) return;
  if (row.current_step_id !== null && row.current_step_id !== row.workflow_step_id) return;
  if (row.current_step_id === null && Number(row.step_index) !== currentIndex) return;
  const current = steps[currentIndex]!;
  const nextIndex =
    current.nextStepId === null
      ? -1
      : current.nextStepId
        ? steps.findIndex((step) => step.id === current.nextStepId)
        : currentIndex + 1;
  const next = nextIndex >= 0 && nextIndex < steps.length ? steps[nextIndex] : null;
  const completed = parseStepIds(row.completed_step_ids);
  if (!completed.includes(current.id)) completed.push(current.id);
  await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET step_index=?,current_step_id=?,completed_step_ids=?::jsonb,status=?,
           next_eligible_at=?::timestamptz,last_action_id=?,last_failure_reason=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=?
         AND (current_step_id=? OR (current_step_id IS NULL AND step_index=?))
         AND status IN ('active','waiting','paused')`
    )
    .run(
      next ? nextIndex : steps.length,
      next?.id ?? null,
      JSON.stringify(completed),
      next ? 'waiting' : 'completed',
      next ? new Date(now.getTime() + delayMilliseconds(next.delayBefore)).toISOString() : null,
      actionId,
      now.toISOString(),
      workspaceId,
      row.campaign_member_id,
      row.workflow_step_id,
      currentIndex
    );
}

/** Resolve an action whose browser side effect could not be proven. Never guesses. */
export async function resolveManagedCampaignLinkedInUnknownOutcome(
  db: Db,
  workspaceId: string,
  actionId: string,
  resolution: UnknownOutcomeResolution,
  now: Date = new Date()
): Promise<{ resolved: boolean; memberId: string | null; campaignId: string | null }> {
  const action = await db
    .prepare(
      `SELECT campaign_member_id,campaign_id FROM linkedin_actions
       WHERE workspace_id=? AND id=? AND settlement_hold_at IS NOT NULL`
    )
    .get<{ campaign_member_id: string | null; campaign_id: string | null }>(workspaceId, actionId);
  if (!action) return { resolved: false, memberId: null, campaignId: null };
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    if (resolution === 'retry') {
      await tx
        .prepare(
          `UPDATE linkedin_actions
           SET status='planned',recorded_at=NULL,failure_kind=NULL,claimed_at=NULL,claimed_by=NULL,
               lease_expires_at=NULL,batch_id=NULL,settlement_hold_at=NULL,planned_for=?::timestamptz
           WHERE workspace_id=? AND id=? AND settlement_hold_at IS NOT NULL`
        )
        .run(timestamp, workspaceId, actionId);
      if (action.campaign_member_id)
        await tx
          .prepare(
            `UPDATE linkedin_campaign_members SET status='waiting',next_eligible_at=?::timestamptz,
                 last_failure_reason=NULL,updated_at=?::timestamptz WHERE workspace_id=? AND id=?`
          )
          .run(timestamp, timestamp, workspaceId, action.campaign_member_id);
      return;
    }
    await tx
      .prepare(
        `UPDATE linkedin_actions
         SET status=?,recorded_at=?::timestamptz,failure_kind=NULL,claimed_at=NULL,claimed_by=NULL,
             lease_expires_at=NULL,batch_id=NULL,settlement_hold_at=NULL
         WHERE workspace_id=? AND id=? AND settlement_hold_at IS NOT NULL`
      )
      .run(
        resolution === 'sent' ? 'sent' : 'skipped',
        resolution === 'sent' ? timestamp : null,
        workspaceId,
        actionId
      );
    await advanceMemberAfterResolvedLinkedInAction(tx, workspaceId, actionId, now);
  });
  return {
    resolved: true,
    memberId: action.campaign_member_id,
    campaignId: action.campaign_id
  };
}

/** Re-evaluate a condition/monitor without replaying any outbound action. */
export async function rerunManagedCampaignCondition(
  db: Db,
  workspaceId: string,
  memberId: string,
  stepId?: string,
  now: Date = new Date()
): Promise<boolean> {
  const context = await memberExecutionContext(db, workspaceId, memberId);
  if (!context || ['replied', 'removed', 'excluded'].includes(context.status)) return false;
  const index = stepId ? context.steps.findIndex((step) => step.id === stepId) : context.stepIndex;
  const step = context.steps[index];
  if (!step || (step.action !== 'condition' && step.action !== 'monitor')) return false;
  const timestamp = now.toISOString();
  const keepCompleted = context.completedStepIds.filter((id) => {
    const completedIndex = context.steps.findIndex((candidate) => candidate.id === id);
    return completedIndex >= 0 && completedIndex < index;
  });
  const result = await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET step_index=?,current_step_id=?,completed_step_ids=?::jsonb,status='waiting',
           next_eligible_at=?::timestamptz,
           branch_state_json=(COALESCE(branch_state_json,'{}'::jsonb) - ?::text - ?::text),
           last_action_id=NULL,last_failure_reason=NULL,ended_at=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status NOT IN ('replied','removed','excluded')`
    )
    .run(
      index,
      step.id,
      JSON.stringify(keepCompleted),
      timestamp,
      `branch:${step.id}`,
      `monitor:${step.id}`,
      timestamp,
      workspaceId,
      memberId
    );
  return result.changes > 0;
}

/** Resume one lead at an exact node, cancelling only work that has not started. */
export async function resumeManagedCampaignMemberAtStep(
  db: Db,
  workspaceId: string,
  memberId: string,
  stepId: string,
  now: Date = new Date()
): Promise<boolean> {
  if (await unresolvedOutcomeForMember(db, workspaceId, memberId))
    throw new Error(
      'Resolve the unknown action outcome before changing this lead’s workflow position.'
    );

  const context = await memberExecutionContext(db, workspaceId, memberId);
  if (!context || ['replied', 'removed', 'excluded'].includes(context.status)) return false;
  const index = context.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return false;
  const timestamp = now.toISOString();
  let changed = 0;
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL,claimed_by=NULL,
             lease_expires_at=NULL,batch_id=NULL
         WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
      )
      .run(workspaceId, memberId);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND member_id=? AND status IN ('planned','failed') AND outcome_known=TRUE`
      )
      .run(timestamp, workspaceId, memberId);
    const keepCompleted = context.completedStepIds.filter((id) => {
      const completedIndex = context.steps.findIndex((candidate) => candidate.id === id);
      return completedIndex >= 0 && completedIndex < index;
    });
    const result = await tx
      .prepare(
        `UPDATE linkedin_campaign_members
         SET step_index=?,current_step_id=?,completed_step_ids=?::jsonb,status='waiting',
             next_eligible_at=?::timestamptz,last_action_id=NULL,last_failure_reason=NULL,
             ended_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND id=? AND status NOT IN ('replied','removed','excluded')`
      )
      .run(
        index,
        stepId,
        JSON.stringify(keepCompleted),
        timestamp,
        timestamp,
        workspaceId,
        memberId
      );
    changed = result.changes;
  });
  return changed > 0;
}

const RETRYABLE_LINKEDIN_FAILURES = [
  'not_found',
  'compose_unavailable',
  'paid_credit_required',
  'selector_drift',
  // A relay that dropped between two actions never clicked anything, exactly as
  // drift never clicked anything, so the row is safe to requeue on the same
  // rule. Deliberately absent from the campaign-health counters further down:
  // a browser session we lost is Trevra's plumbing, not evidence that this
  // campaign is being refused by LinkedIn.
  'session_lost',
  'limit_wall',
  'challenge'
] as const;

/**
 * Requeue only failures whose side effect is known not to have happened.
 * `unknown` and settlement-held rows are intentionally absent: retrying those
 * is how a campaign sends the same invite/message twice.
 */
export async function retryManagedCampaignFailures(
  db: Db,
  workspaceId: string,
  campaignId: string,
  memberIds: readonly string[] = [],
  now: Date = new Date()
): Promise<{ linkedinActions: number; channelActions: number; membersResumed: number }> {
  const timestamp = now.toISOString();
  const scopeMembers = [...new Set(memberIds.filter(Boolean))];
  const linkedinRows = await db
    .prepare(
      `UPDATE linkedin_actions SET status='planned',failure_kind=NULL,recorded_at=NULL,claimed_at=NULL,
           claimed_by=NULL,lease_expires_at=NULL,batch_id=NULL,settlement_hold_at=NULL,planned_for=?::timestamptz
       WHERE workspace_id=? AND campaign_id=? AND status='skipped'
         AND failure_kind = ANY(?::text[])
         AND (?::boolean=FALSE OR campaign_member_id = ANY(?::text[]))
       RETURNING campaign_member_id`
    )
    .all<{ campaign_member_id: string | null }>(
      timestamp,
      workspaceId,
      campaignId,
      [...RETRYABLE_LINKEDIN_FAILURES],
      scopeMembers.length > 0,
      scopeMembers
    );
  const channelRows = await db
    .prepare(
      `UPDATE linkedin_campaign_channel_actions SET status='planned',claimed_at=NULL,last_error=NULL,
           next_retry_at=NULL,planned_for=?::timestamptz,updated_at=?::timestamptz
       WHERE workspace_id=? AND campaign_id=? AND status='failed' AND outcome_known=TRUE
         AND (?::boolean=FALSE OR member_id = ANY(?::text[]))
       RETURNING member_id`
    )
    .all<{ member_id: string }>(
      timestamp,
      timestamp,
      workspaceId,
      campaignId,
      scopeMembers.length > 0,
      scopeMembers
    );
  const affected = [
    ...new Set([
      ...linkedinRows
        .map((row) => row.campaign_member_id)
        .filter((id): id is string => Boolean(id)),
      ...channelRows.map((row) => row.member_id)
    ])
  ];
  let membersResumed = 0;
  if (affected.length > 0) {
    const result = await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',next_eligible_at=?::timestamptz,
             last_failure_reason=NULL,ended_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND campaign_id=? AND id = ANY(?::text[]) AND status='failed'`
      )
      .run(timestamp, timestamp, workspaceId, campaignId, affected);
    membersResumed = result.changes;
  }
  return {
    linkedinActions: linkedinRows.length,
    channelActions: channelRows.length,
    membersResumed
  };
}

/** Move selected leads into another campaign only after releasing the source claim. */
export async function moveManagedCampaignMembers(
  db: Db,
  workspaceId: string,
  sourceCampaignId: string,
  targetCampaignId: string,
  memberIds: readonly string[],
  now: Date = new Date()
): Promise<{ moved: number; skipped: number }> {
  if (sourceCampaignId === targetCampaignId)
    throw new Error('Source and target campaign must differ.');
  const target = await getManagedCampaign(db, workspaceId, targetCampaignId);
  if (!target || ['stopped', 'completed'].includes(target.status))
    throw new Error('Target follow-up campaign must be draft, running, or paused.');
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (ids.length === 0) return { moved: 0, skipped: 0 };
  const timestamp = now.toISOString();
  let moved = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    const rows = await tx
      .prepare(
        `SELECT id,contact_id FROM linkedin_campaign_members
         WHERE workspace_id=? AND campaign_id=? AND id = ANY(?::text[]) FOR UPDATE`
      )
      .all<{ id: string; contact_id: string }>(workspaceId, sourceCampaignId, ids);
    for (const row of rows) {
      if (await unresolvedOutcomeForMember(tx, workspaceId, row.id)) {
        skipped += 1;
        continue;
      }
      await tx
        .prepare(
          `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL
           WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
        )
        .run(workspaceId, row.id);
      await tx
        .prepare(
          `UPDATE linkedin_campaign_channel_actions SET status='skipped',claimed_at=NULL,updated_at=?::timestamptz
           WHERE workspace_id=? AND member_id=? AND status IN ('planned','failed') AND outcome_known=TRUE`
        )
        .run(timestamp, workspaceId, row.id);
      await tx
        .prepare(
          `UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,ended_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=?`
        )
        .run(timestamp, timestamp, workspaceId, row.id);
      const occupied = await tx
        .prepare(
          `SELECT 1 AS occupied FROM linkedin_campaign_members
           WHERE workspace_id=? AND contact_id=? AND campaign_id<>? AND status IN ('pending','active','waiting','manual','paused')
           LIMIT 1`
        )
        .get(workspaceId, row.contact_id, targetCampaignId);
      if (occupied) {
        skipped += 1;
        continue;
      }
      await tx
        .prepare(
          `INSERT INTO linkedin_lead_list_members (workspace_id,list_id,contact_id,created_at)
           VALUES (?,?,?,?::timestamptz) ON CONFLICT DO NOTHING`
        )
        .run(workspaceId, target.leadListId, row.contact_id, timestamp);
      const inserted = await tx
        .prepare(
          `INSERT INTO linkedin_campaign_members
             (id,workspace_id,campaign_id,contact_id,status,step_index,assigned_variants,branch_state_json,created_at,updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, '{}'::jsonb, '{}'::jsonb, ?::timestamptz, ?::timestamptz)
           ON CONFLICT DO NOTHING`
        )
        .run(id('licm'), workspaceId, targetCampaignId, row.contact_id, timestamp, timestamp);
      if (inserted.changes > 0) moved += 1;
      else skipped += 1;
    }
    skipped += Math.max(0, ids.length - rows.length);
  });
  return { moved, skipped };
}

export interface ManagedAnalytics {
  invitesSent: number;
  messagesSent: number;
  profileViews: number;
  /**
   * Follows performed.
   *
   * Missing until now, and its absence was not cosmetic: `follow` is one of
   * the six actions a workflow can contain and one of the four kinds the seat
   * carries an operator ceiling for, so a follow-only workflow reported zeros
   * across the board -- forever -- while the settings screen showed a live
   * daily follow limit next to the empty panel.
   */
  followsSent: number;
  /**
   * Invites this campaign took back.
   *
   * The `withdraw_pending` step's only measurable output, and the number that
   * says whether it is doing anything. Counted off the ledger row's terminal
   * 'withdrawn' status (`markActionWithdrawn`), so it honours the same
   * campaign and seat filters as everything else here.
   *
   * DATED BY THE SEND, not by the withdrawal, because `recorded_at` is when
   * the invite went out and the withdrawal does not move it. Under a
   * `sinceDays` filter that means "invites sent in this window that have since
   * been withdrawn" -- the same clock every other counter above uses, which is
   * the property worth keeping when the alternative is one column in a panel
   * measuring a different week from its neighbours.
   *
   * A withdrawn invite leaves `invitesSent`, because its status is no longer
   * one of sent/accepted/replied. That is the ledger's existing meaning of a
   * withdrawal -- it was taken back -- and it is why the two numbers are
   * reported side by side rather than one being derived from the other.
   */
  invitesWithdrawn: number;
  /**
   * Withdrawals this campaign's seat actually performed, dated by the click.
   *
   * NOT A RENAME OF `invitesWithdrawn` AND NOT DERIVABLE FROM IT. That number
   * is counted off the invite's terminal status and dated by the invite's
   * `recorded_at`, so under `sinceDays` it answers "invites sent in this window
   * that have since been taken back". This one is counted off the withdrawal's
   * own ledger row (migration 070) and dated by the withdrawal, so it answers
   * "withdrawals performed in this window". Both are useful and neither is the
   * other; before the 'withdraw' kind existed only the first was available and
   * the second was unanswerable.
   */
  withdrawalsPerformed: number;
  invitesAccepted: number;
  /**
   * Of `invitesAccepted`, the ones a DETECTOR established rather than a person.
   *
   * SHIPPED SO A SCREEN CAN SAY WHICH. Until migration 070 `accepted` had one
   * writer -- a human clicking a button -- so the provenance question could not
   * arise and the number was zero on every unattended campaign. Now that most
   * of them will be machine-read off a 1st-degree badge, an operator auditing a
   * campaign is entitled to know how many of its acceptances rest on a selector
   * rather than on somebody having looked.
   */
  invitesAcceptedDetected: number;
  /**
   * `invitesAccepted / invitesSent`, or null at 0-of-0.
   *
   * THE SAME DENOMINATOR `action-ledger.ts` USES, deliberately: there were three
   * acceptance rates in this product over two screens and a throttle, and two
   * of them were shown to a user side by side without either page saying which
   * question it had answered. Invites sent is the one a user sees, here and in
   * `InviteOutcomes`; the decided-invite rate `actions.ts` throttles on is
   * named `acceptanceRateOfDecided` there and is not this number.
   */
  acceptanceRate: number | null;
  /**
   * People who replied to ANYTHING -- an invite that came back with a note
   * counts, and so does a reply to a message. The headline "replies" figure.
   */
  repliedLeads: number;
  contactedLeads: number;
  /**
   * People who replied AFTER BEING MESSAGED, which is the numerator
   * `replyRate` needs and `repliedLeads` is not.
   *
   * `repliedLeads` counts a reply to any kind of action while `contactedLeads`
   * counts only leads that were sent a message, so the old
   * `repliedLeads / contactedLeads` divided one population by another and
   * could -- and did -- exceed 100%: reply to an invite from somebody who was
   * never messaged and the numerator grows while the denominator does not.
   * This column is a strict subset of `contactedLeads`, so the rate cannot.
   */
  repliedMessagedLeads: number;
  /** `repliedMessagedLeads / contactedLeads`, or null when nobody has been messaged. */
  replyRate: number | null;
  variants: Array<{ workflowStepId: string; variantId: string; sent: number; replied: number }>;
}

export async function managedAnalytics(
  db: Db,
  workspaceId: string,
  filters: { campaignId?: string; seatKey?: string; sinceDays?: number } = {}
): Promise<ManagedAnalytics> {
  const clauses = ['a.workspace_id=?', "a.status <> 'skipped'"];
  const params: unknown[] = [workspaceId];
  if (filters.campaignId) {
    clauses.push('a.campaign_id=?');
    params.push(filters.campaignId);
  }
  if (filters.seatKey) {
    clauses.push('a.seat_key=?');
    params.push(filters.seatKey);
  }
  // Windowed on `recorded_at`, the same column every rolling ceiling counts on
  // (actions.ts rule 1). Counting `created_at` here would date a row by when it
  // was PLANNED, so a campaign queued on Monday would report Monday's numbers
  // for work that happens on Thursday -- and the dashboard would disagree with
  // the gate about what this seat did today.
  if (filters.sinceDays !== undefined) {
    clauses.push(`a.recorded_at IS NOT NULL AND a.recorded_at >= NOW() - (? || ' days')::interval`);
    params.push(String(Math.max(1, Math.floor(filters.sinceDays))));
  }
  const where = clauses.join(' AND ');
  /*
   * INLINED AS A SQL LITERAL LIST, NOT BOUND AS A PARAMETER, and the reason is
   * positional binding: this list appears in the SELECT clause, which comes
   * before the WHERE, so a `?` here would silently take the workspace id and
   * shift every filter below it by one. The values are a module constant of
   * fixed identifiers -- never operator input -- so there is nothing here for a
   * parameter to protect.
   */
  const messageKinds = COUNTED_MESSAGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const row = await db
    .prepare(
      `
    SELECT
      -- 'declined' IS AN INVITE THAT WAS SENT. Leaving it out inflated the
      -- acceptance rate below by exactly the refusals it was measuring. Same
      -- three-status list action-ledger.ts uses for its own invites_sent;
      -- 'withdrawn' stays out of all of them because a retracted invite never
      -- got its chance.
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('sent','accepted','replied','declined'))::int AS invites_sent,
      -- 'inmail' LEFT THIS FILTER AND ITS TWO SIBLINGS BELOW. Nothing in this
      -- deployment sends an InMail (UNSUPPORTED_ACTION_KINDS in actions.ts), so
      -- counting the kind here was a panel reporting delivery that could not
      -- have occurred. The list is imported rather than restated: it was
      -- spelled out three times in this one statement.
      COUNT(*) FILTER (WHERE a.kind IN (${messageKinds}) AND a.status IN ('sent','accepted','replied'))::int AS messages_sent,
      COUNT(*) FILTER (WHERE a.kind='profile_view' AND a.status IN ('sent','accepted','replied'))::int AS profile_views,
      COUNT(*) FILTER (WHERE a.kind='follow' AND a.status IN ('sent','accepted','replied'))::int AS follows_sent,
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status='withdrawn')::int AS invites_withdrawn,
      -- The withdrawal's OWN row (migration 070), dated by the WITHDRAWAL
      -- rather than by the invite it retracted. Kept beside invites_withdrawn
      -- and not merged into it, because under a sinceDays filter the two answer
      -- genuinely different questions: "invites sent in this window that have
      -- since been taken back" and "withdrawals this account performed in this
      -- window". Merging them would silently change what the older number has
      -- always meant.
      COUNT(*) FILTER (WHERE a.kind='withdraw' AND a.status IN ('sent','accepted','replied'))::int AS withdrawals_performed,
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS invites_accepted,
      -- Acceptances the detector established, as opposed to ones a human
      -- reported. Same rows, split by provenance, so a screen never has to
      -- present a badge reading and a person's word as the same evidence.
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.accepted_source='detected')::int AS invites_accepted_detected,
      COUNT(DISTINCT a.target_ref) FILTER (WHERE a.status='replied')::int AS replied_leads,
      -- The reply-rate numerator: messaged leads who replied. Same kinds and
      -- the same distinct-target counting as contacted_leads below, which is
      -- what makes one a subset of the other rather than a ratio between two
      -- different populations.
      COUNT(DISTINCT a.target_ref) FILTER (WHERE a.kind IN (${messageKinds}) AND a.status='replied')::int AS replied_messaged_leads,
      COUNT(DISTINCT a.target_ref) FILTER (WHERE a.kind IN (${messageKinds}) AND a.status IN ('sent','accepted','replied'))::int AS contacted_leads
    FROM linkedin_actions a WHERE ${where}
  `
    )
    .get<Record<string, number>>(...params);
  const invitesSent = Number(row?.invites_sent ?? 0);
  const invitesAccepted = Number(row?.invites_accepted ?? 0);
  const repliedLeads = Number(row?.replied_leads ?? 0);
  const repliedMessagedLeads = Number(row?.replied_messaged_leads ?? 0);
  const contactedLeads = Number(row?.contacted_leads ?? 0);
  const variantParams = [...params];
  const variants = await db
    .prepare(
      `
    SELECT a.workflow_step_id,a.variant_id,
      COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied'))::int AS sent,
      COUNT(*) FILTER (WHERE a.status='replied')::int AS replied
    FROM linkedin_actions a WHERE ${where} AND a.workflow_step_id IS NOT NULL AND a.variant_id IS NOT NULL
    GROUP BY a.workflow_step_id,a.variant_id ORDER BY a.workflow_step_id,a.variant_id
  `
    )
    .all<{ workflow_step_id: string; variant_id: string; sent: number; replied: number }>(
      ...variantParams
    );
  return {
    invitesSent,
    messagesSent: Number(row?.messages_sent ?? 0),
    profileViews: Number(row?.profile_views ?? 0),
    followsSent: Number(row?.follows_sent ?? 0),
    invitesWithdrawn: Number(row?.invites_withdrawn ?? 0),
    withdrawalsPerformed: Number(row?.withdrawals_performed ?? 0),
    invitesAccepted,
    invitesAcceptedDetected: Number(row?.invites_accepted_detected ?? 0),
    acceptanceRate: invitesSent === 0 ? null : invitesAccepted / invitesSent,
    repliedLeads,
    contactedLeads,
    repliedMessagedLeads,
    // Numerator and denominator over the SAME population -- messaged leads --
    // so this cannot exceed 1. It used to divide replies to any action kind by
    // messaged leads only.
    replyRate: contactedLeads === 0 ? null : repliedMessagedLeads / contactedLeads,
    variants: variants.map((v) => ({
      workflowStepId: v.workflow_step_id,
      variantId: v.variant_id,
      sent: Number(v.sent),
      replied: Number(v.replied)
    }))
  };
}

export interface CampaignAdmissionForecast {
  acceptanceRate: number | null;
  acceptanceSampleSize: number;
  acceptanceConfidence95: { low: number; high: number } | null;
  noReplyRate: number | null;
  replySampleSize: number;
  noReplyConfidence95: { low: number; high: number } | null;
  failureRate: number | null;
  outcomeSampleSize: number;
  failureConfidence95: { low: number; high: number } | null;
  throttle: number;
  reasons: string[];
}

function wilson95(successes: number, total: number): { low: number; high: number } | null {
  if (total < ADMISSION_FORECAST_MIN_SAMPLE || total <= 0) return null;
  const p = Math.max(0, Math.min(1, successes / total));
  const z = 1.959963984540054;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Recent campaign outcomes that are safe to feed back into admission.
 *
 * Forecasting is deliberately one-way: it may shrink a wave, never manufacture
 * capacity. Rates stay null until the minimum sample is present. Challenge,
 * limit-wall, selector-drift and unknown outcomes count as execution-health
 * failures; ordinary no-result/already-done skips do not.
 */
export async function campaignAdmissionForecast(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<CampaignAdmissionForecast> {
  const messageKinds = COUNTED_MESSAGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE kind='invite' AND status IN ('sent','accepted','replied','declined'))::int AS invite_sample,
         COUNT(*) FILTER (WHERE kind='invite' AND status IN ('accepted','replied'))::int AS invite_accepted,
         COUNT(*) FILTER (WHERE kind IN (${messageKinds}) AND status IN ('sent','accepted','replied'))::int AS message_sample,
         COUNT(*) FILTER (WHERE kind IN (${messageKinds}) AND status='replied')::int AS message_replied,
         COUNT(*) FILTER (WHERE (recorded_at IS NOT NULL OR failure_kind IS NOT NULL)
            AND created_at >= (?::timestamptz - INTERVAL '30 days'))::int AS outcome_sample,
         COUNT(*) FILTER (WHERE failure_kind IN ('challenge','limit_wall','selector_drift','unknown','compose_unavailable')
            AND created_at >= (?::timestamptz - INTERVAL '30 days'))::int AS bad_outcomes
       FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?`
    )
    .get<Record<string, number>>(now.toISOString(), now.toISOString(), workspaceId, campaignId);
  const acceptanceSampleSize = Number(row?.invite_sample ?? 0);
  const accepted = Number(row?.invite_accepted ?? 0);
  const replySampleSize = Number(row?.message_sample ?? 0);
  const replied = Number(row?.message_replied ?? 0);
  const outcomeSampleSize = Number(row?.outcome_sample ?? 0);
  const badOutcomes = Number(row?.bad_outcomes ?? 0);
  const acceptanceRate =
    acceptanceSampleSize >= ADMISSION_FORECAST_MIN_SAMPLE
      ? accepted / Math.max(1, acceptanceSampleSize)
      : null;
  const replyRate =
    replySampleSize >= ADMISSION_FORECAST_MIN_SAMPLE
      ? replied / Math.max(1, replySampleSize)
      : null;
  const failureRate =
    outcomeSampleSize >= ADMISSION_FORECAST_MIN_SAMPLE
      ? badOutcomes / Math.max(1, outcomeSampleSize)
      : null;
  const acceptanceConfidence95 = wilson95(accepted, acceptanceSampleSize);
  const replyConfidence95 = wilson95(replied, replySampleSize);
  const noReplyConfidence95 = replyConfidence95
    ? { low: 1 - replyConfidence95.high, high: 1 - replyConfidence95.low }
    : null;
  const failureConfidence95 = wilson95(badOutcomes, outcomeSampleSize);

  let throttle = 1;
  const reasons: string[] = [];
  if (acceptanceRate !== null && acceptanceRate < 0.1) {
    throttle = Math.min(throttle, 0.25);
    reasons.push(
      `Invite acceptance is ${Math.round(acceptanceRate * 100)}% across ${acceptanceSampleSize} decided sends, so new admission is reduced to protect downstream quality.`
    );
  } else if (acceptanceRate !== null && acceptanceRate < 0.2) {
    throttle = Math.min(throttle, 0.5);
    reasons.push(
      `Invite acceptance is ${Math.round(acceptanceRate * 100)}% across ${acceptanceSampleSize} decided sends, so new admission is reduced.`
    );
  }
  if (failureRate !== null && failureRate >= 0.3) {
    throttle = 0;
    reasons.push(
      `${Math.round(failureRate * 100)}% of ${outcomeSampleSize} recent execution outcomes are challenge/limit/drift/unknown failures; new admissions are stopped until execution health recovers.`
    );
  } else if (failureRate !== null && failureRate >= 0.12) {
    throttle = Math.min(throttle, 0.5);
    reasons.push(
      `${Math.round(failureRate * 100)}% of ${outcomeSampleSize} recent execution outcomes are challenge/limit/drift/unknown failures; new admissions are reduced.`
    );
  }

  return {
    acceptanceRate,
    acceptanceSampleSize,
    acceptanceConfidence95,
    noReplyRate: replyRate === null ? null : 1 - replyRate,
    replySampleSize,
    noReplyConfidence95,
    failureRate,
    outcomeSampleSize,
    failureConfidence95,
    throttle,
    reasons
  };
}

function seatWindowOpenNow(
  seat: Awaited<ReturnType<typeof getSeat>>,
  campaign: ManagedCampaign,
  now: Date
): boolean {
  if (!seat) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: seat.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((part) => part.type === 'weekday')?.value ?? 'Mon'
  );
  const localMinute =
    Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60 +
    Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const days = campaign.schedule.workingDays
    ? seat.workingDays.filter((day) => campaign.schedule.workingDays!.includes(day))
    : seat.workingDays;
  const start = Math.max(
    seat.workStartMinute,
    campaign.schedule.workStartMinute ?? seat.workStartMinute
  );
  const end = Math.min(seat.workEndMinute, campaign.schedule.workEndMinute ?? seat.workEndMinute);
  return days.includes(weekday) && localMinute >= start && localMinute < end && end > start;
}

export interface CampaignOperationalAnalytics {
  funnel: {
    totalAudience: number;
    pending: number;
    inSequence: number;
    invited: number;
    accepted: number;
    messaged: number;
    replied: number;
    completed: number;
    failed: number;
    excluded: number;
  };
  waves: Array<
    ManagedCampaignWave & {
      backlog: number;
      replied: number;
      accepted: number;
      failed: number;
      medianMinutesToFirstAction: number | null;
      acceptanceRate: number | null;
      replyRate: number | null;
      failureRate: number | null;
    }
  >;
  steps: Array<{
    workflowStepId: string;
    action: WorkflowStep['action'] | 'unknown';
    scheduled: number;
    executed: number;
    skipped: number;
    failed: number;
    overdue: number;
    outcomeRate: number | null;
    /** Actual execution timestamp minus the intended planned slot. Same measurement exposed as queue latency. */
    medianDelayVsIntendedMinutes: number | null;
    slaMeasured: number;
    slaMissed: number;
    slaMissRate: number | null;
    medianQueueLatencyMinutes: number | null;
  }>;
  variants: Array<{
    workflowStepId: string;
    variantId: string;
    kind: string;
    sent: number;
    accepted: number;
    replied: number;
    acceptanceRate: number | null;
    replyRate: number | null;
    eligibleForWinner: boolean;
  }>;
  senders: Array<{
    seatKey: string;
    planned: number;
    executed: number;
    invitesSent: number;
    accepted: number;
    messagesSent: number;
    replied: number;
    failed: number;
    safetyBlocks: number;
    acceptanceRate: number | null;
    replyRate: number | null;
    allocationShare: number | null;
  }>;
  bottlenecks: {
    pending: number;
    waitingOnCondition: number;
    overdueActions: number;
    heldActions: number;
    failedMembers: number;
    limitingKind: string | null;
    reason: string;
  };
  channels: {
    emailSent: number;
    emailReplied: number;
    inmailSent: number;
    inmailReplied: number;
    inmailFailed: number;
    inmailPaidCreditsUsed: number;
    inmailPaidCreditCap: number | null;
    enrichmentAttempts: number;
    enrichmentFound: number;
    enrichmentCreditsUsed: number;
    enrichmentCreditCap: number | null;
  };
  admissionForecast: CampaignAdmissionForecast;
}

/**
 * One server-side read model for operating a wave campaign. The campaign page
 * should not reconstruct this from thousands of members in React: every count
 * below is computed next to the rows that own the state and can therefore stay
 * consistent with the runner's queue semantics.
 */
export async function campaignOperationalAnalytics(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<CampaignOperationalAnalytics> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const admissionForecast = await campaignAdmissionForecast(db, workspaceId, campaignId, now);
  const messageKinds = COUNTED_MESSAGE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const funnel = await db
    .prepare(
      `SELECT
         COUNT(*)::int AS total_audience,
         COUNT(*) FILTER (WHERE m.status='pending')::int AS pending,
         COUNT(*) FILTER (WHERE m.admitted_at IS NOT NULL AND m.status IN ('active','waiting','manual','paused'))::int AS in_sequence,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
             AND a.kind='invite' AND a.status IN ('sent','accepted','replied','declined')
         ))::int AS invited,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
             AND a.kind='invite' AND a.status IN ('accepted','replied')
         ))::int AS accepted,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
             AND a.kind IN (${messageKinds}) AND a.status IN ('sent','accepted','replied')
         ) OR EXISTS (
           SELECT 1 FROM linkedin_campaign_channel_actions ca WHERE ca.workspace_id=m.workspace_id AND ca.member_id=m.id
             AND ca.kind='email' AND ca.status='completed'
         ))::int AS messaged,
         COUNT(*) FILTER (WHERE m.status='replied' OR EXISTS (
           SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id AND a.status='replied'
         ) OR EXISTS (
           SELECT 1 FROM linkedin_campaign_channel_actions ca
           JOIN linkedin_campaign_email_events ee ON ee.workspace_id=ca.workspace_id AND ee.channel_action_id=ca.id AND ee.event_kind='replied'
           WHERE ca.workspace_id=m.workspace_id AND ca.member_id=m.id
         ))::int AS replied,
         COUNT(*) FILTER (WHERE m.status='completed')::int AS completed,
         COUNT(*) FILTER (WHERE m.status='failed')::int AS failed,
         COUNT(*) FILTER (WHERE m.status='excluded')::int AS excluded
       FROM linkedin_campaign_members m WHERE m.workspace_id=? AND m.campaign_id=?`
    )
    .get<Record<string, number>>(workspaceId, campaignId);

  const waveRows = await listCampaignWaves(db, workspaceId, campaignId);
  const waveStats = await db
    .prepare(
      `SELECT m.wave_id,
         COUNT(*) FILTER (WHERE m.status IN ('active','waiting','manual','paused'))::int AS backlog,
         COUNT(*) FILTER (WHERE m.status='replied')::int AS replied,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id
             AND a.kind='invite' AND a.status IN ('accepted','replied')
         ))::int AS accepted,
         COUNT(*) FILTER (WHERE m.status='failed')::int AS failed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_action.first_at - m.admitted_at))/60.0)
           FILTER (WHERE first_action.first_at IS NOT NULL AND m.admitted_at IS NOT NULL) AS median_first_minutes
       FROM linkedin_campaign_members m
       LEFT JOIN LATERAL (
         SELECT MIN(a.recorded_at) AS first_at FROM linkedin_actions a
          WHERE a.workspace_id=m.workspace_id AND a.campaign_member_id=m.id AND a.recorded_at IS NOT NULL
       ) first_action ON TRUE
       WHERE m.workspace_id=? AND m.campaign_id=? AND m.wave_id IS NOT NULL
       GROUP BY m.wave_id`
    )
    .all<{
      wave_id: string;
      backlog: number;
      replied: number;
      accepted: number;
      failed: number;
      median_first_minutes: number | null;
    }>(workspaceId, campaignId);
  const statsByWave = new Map(waveStats.map((row) => [row.wave_id, row]));

  const stepRows = await db
    .prepare(
      `SELECT a.workflow_step_id,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE a.status NOT IN ('planned','held'))::int AS settled,
         COUNT(*) FILTER (WHERE a.status IN ('planned','held'))::int AS scheduled,
         COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied','declined','withdrawn'))::int AS executed,
         COUNT(*) FILTER (WHERE a.status='skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied'))::int AS failed,
         COUNT(*) FILTER (WHERE a.status IN ('planned','held') AND a.planned_for<?::timestamptz)::int AS overdue,
         COUNT(*) FILTER (WHERE a.sla_deadline_at IS NOT NULL AND (a.recorded_at IS NOT NULL OR a.sla_deadline_at<=?::timestamptz))::int AS sla_measured,
         COUNT(*) FILTER (WHERE a.sla_deadline_at IS NOT NULL AND (
           (a.recorded_at IS NOT NULL AND a.recorded_at>a.sla_deadline_at) OR
           (a.recorded_at IS NULL AND a.status IN ('planned','held') AND a.sla_deadline_at<=?::timestamptz)
         ))::int AS sla_missed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.recorded_at-a.planned_for))/60.0)
           FILTER (WHERE a.recorded_at IS NOT NULL AND a.planned_for IS NOT NULL) AS median_latency
       FROM linkedin_actions a
       WHERE a.workspace_id=? AND a.campaign_id=? AND a.workflow_step_id IS NOT NULL
       GROUP BY a.workflow_step_id ORDER BY a.workflow_step_id`
    )
    .all<{
      workflow_step_id: string;
      total: number;
      settled: number;
      scheduled: number;
      executed: number;
      skipped: number;
      failed: number;
      overdue: number;
      sla_measured: number;
      sla_missed: number;
      median_latency: number | null;
    }>(now.toISOString(), now.toISOString(), now.toISOString(), workspaceId, campaignId);
  const stepById = new Map(campaign.steps.map((step) => [step.id, step]));

  const variantRows = await db
    .prepare(
      `SELECT a.workflow_step_id,a.variant_id,a.kind,
         COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied','declined'))::int AS sent,
         COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS accepted,
         COUNT(*) FILTER (WHERE a.status='replied')::int AS replied
       FROM linkedin_actions a
       WHERE a.workspace_id=? AND a.campaign_id=? AND a.workflow_step_id IS NOT NULL AND a.variant_id IS NOT NULL
       GROUP BY a.workflow_step_id,a.variant_id,a.kind ORDER BY a.workflow_step_id,a.variant_id`
    )
    .all<{
      workflow_step_id: string;
      variant_id: string;
      kind: string;
      sent: number;
      accepted: number;
      replied: number;
    }>(workspaceId, campaignId);

  const senderRows = await db
    .prepare(
      `SELECT a.seat_key,
         COUNT(*) FILTER (WHERE a.status IN ('planned','held'))::int AS planned,
         COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied','declined','withdrawn'))::int AS executed,
         COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('sent','accepted','replied','declined'))::int AS invites_sent,
         COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS accepted,
         COUNT(*) FILTER (WHERE a.kind IN (${messageKinds}) AND a.status IN ('sent','accepted','replied'))::int AS messages_sent,
         COUNT(*) FILTER (WHERE a.status='replied')::int AS replied,
         COUNT(*) FILTER (WHERE a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied'))::int AS failed,
         COUNT(*) FILTER (WHERE a.failure_kind IN ('limit_wall','challenge'))::int AS safety_blocks
       FROM linkedin_actions a WHERE a.workspace_id=? AND a.campaign_id=?
       GROUP BY a.seat_key ORDER BY a.seat_key`
    )
    .all<Record<string, string | number>>(workspaceId, campaignId);

  const channelStats = await db
    .prepare(
      `SELECT
      COUNT(*) FILTER (WHERE kind='email' AND status='sent')::int AS email_sent,
      COUNT(*) FILTER (WHERE kind='find_email' AND status IN ('sent','failed','unknown'))::int AS enrichment_attempts,
      COUNT(*) FILTER (WHERE kind='find_email' AND status='sent' AND external_ref LIKE 'email:%' AND external_ref<>'email:not-found')::int AS enrichment_found,
      COALESCE(SUM(credits_used) FILTER (WHERE kind='find_email'),0)::int AS enrichment_credits_used
      FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=?`
    )
    .get<Record<string, number>>(workspaceId, campaignId);
  const inmailStats = await db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE kind='inmail' AND status IN ('sent','accepted','replied'))::int AS sent,
         COUNT(*) FILTER (WHERE kind='inmail' AND status='replied')::int AS replied,
         COUNT(*) FILTER (WHERE kind='inmail' AND failure_kind IS NOT NULL AND status NOT IN ('sent','accepted','replied'))::int AS failed,
         COUNT(*) FILTER (WHERE kind='inmail' AND paid_credit_used=TRUE AND status<>'skipped')::int AS paid_credits
       FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?`
    )
    .get<Record<string, number>>(workspaceId, campaignId);
  const emailReplyStats = await db
    .prepare(
      `SELECT COUNT(DISTINCT ca.id)::int AS total FROM linkedin_campaign_channel_actions ca
      JOIN linkedin_campaign_email_events ee ON ee.workspace_id=ca.workspace_id AND ee.channel_action_id=ca.id
      WHERE ca.workspace_id=? AND ca.campaign_id=? AND ca.kind='email' AND ee.event_kind='replied'`
    )
    .get<{ total: number }>(workspaceId, campaignId);

  const assignedSeats = (
    await Promise.all(campaign.senderKeys.map((seatKey) => getSeat(db, workspaceId, seatKey)))
  ).filter((seat): seat is NonNullable<typeof seat> => seat !== undefined && seat !== null);
  const seatPostures = assignedSeats.map((seat) => effectivePosture(seat, now));
  const anySenderWindowOpen = assignedSeats.some((seat) => seatWindowOpenNow(seat, campaign, now));
  const latestBatch = await db
    .prepare(
      `SELECT seat_key,status,halt_reason,started_at FROM linkedin_batches
      WHERE workspace_id=? AND seat_key = ANY(?::text[]) ORDER BY started_at DESC LIMIT 1`
    )
    .get<{ seat_key: string; status: string; halt_reason: string | null; started_at: string }>(
      workspaceId,
      campaign.senderKeys
    );

  const queues = await campaignQueueSummary(db, workspaceId, campaignId, now);
  const latestWave = waveRows[0] ?? null;
  const capacity = latestWave?.capacitySnapshot ?? {};
  const limitingEntry = Object.entries(capacity)
    .filter(([, value]) => Number.isFinite(value))
    .sort((left, right) => left[1] - right[1])[0];
  const limitingKind = limitingEntry?.[0] ?? null;
  const recentBatchHalt =
    latestBatch?.status === 'halted' &&
    now.getTime() - new Date(latestBatch.started_at).getTime() <= 24 * 60 * 60_000
      ? latestBatch.halt_reason
      : null;
  const allSendersPaused =
    seatPostures.length > 0 &&
    seatPostures.every((posture) => posture === 'paused' || posture === 'cooldown');
  const reason =
    queues.held > 0
      ? `${queues.held} action(s) are held for operator review.`
      : queues.failed > 0
        ? `${queues.failed} lead(s) have failed and need operator action.`
        : queues.dueNow > 0 && allSendersPaused
          ? 'All assigned LinkedIn senders are paused or cooling down; no browser work can execute until a sender recovers.'
          : queues.dueNow > 0 && !anySenderWindowOpen
            ? `Due work is waiting for an assigned sender's allowed working window (${assignedSeats.map((seat) => `${seat.label}: ${seat.timezone}`).join(', ') || 'no usable sender'}).`
            : queues.dueNow > 0 && recentBatchHalt
              ? `The latest browser batch halted: ${recentBatchHalt}`
              : queues.waitingForConnection + queues.waitingForReply > 0
                ? `${queues.waitingForConnection + queues.waitingForReply} lead(s) are waiting on an outcome.`
                : queues.pending > 0 && limitingKind
                  ? `New admission is constrained by ${limitingKind} capacity.`
                  : queues.pending > 0
                    ? `${queues.pending} lead(s) remain in the pending pool until downstream capacity clears.`
                    : 'No material campaign bottleneck is currently detected.';

  const totalSenderExecuted = senderRows.reduce((sum, row) => sum + Number(row.executed), 0);
  const n = (key: string) => Number(funnel?.[key] ?? 0);
  return {
    funnel: {
      totalAudience: n('total_audience'),
      pending: n('pending'),
      inSequence: n('in_sequence'),
      invited: n('invited'),
      accepted: n('accepted'),
      messaged: n('messaged'),
      replied: n('replied'),
      completed: n('completed'),
      failed: n('failed'),
      excluded: n('excluded')
    },
    waves: waveRows.map((wave) => {
      const row = statsByWave.get(wave.id);
      return {
        ...wave,
        backlog: Number(row?.backlog ?? 0),
        replied: Number(row?.replied ?? 0),
        accepted: Number(row?.accepted ?? 0),
        failed: Number(row?.failed ?? 0),
        medianMinutesToFirstAction:
          row?.median_first_minutes === null || row?.median_first_minutes === undefined
            ? null
            : Number(row.median_first_minutes),
        acceptanceRate: wave.memberCount > 0 ? Number(row?.accepted ?? 0) / wave.memberCount : null,
        replyRate: wave.memberCount > 0 ? Number(row?.replied ?? 0) / wave.memberCount : null,
        failureRate: wave.memberCount > 0 ? Number(row?.failed ?? 0) / wave.memberCount : null
      };
    }),
    steps: stepRows.map((row) => ({
      workflowStepId: row.workflow_step_id,
      action: stepById.get(row.workflow_step_id)?.action ?? 'unknown',
      scheduled: Number(row.scheduled),
      executed: Number(row.executed),
      skipped: Number(row.skipped),
      failed: Number(row.failed),
      overdue: Number(row.overdue),
      outcomeRate: Number(row.total) > 0 ? Number(row.settled) / Number(row.total) : null,
      medianDelayVsIntendedMinutes: row.median_latency === null ? null : Number(row.median_latency),
      slaMeasured: Number(row.sla_measured),
      slaMissed: Number(row.sla_missed),
      slaMissRate:
        Number(row.sla_measured) > 0 ? Number(row.sla_missed) / Number(row.sla_measured) : null,
      medianQueueLatencyMinutes: row.median_latency === null ? null : Number(row.median_latency)
    })),
    variants: variantRows.map((row) => {
      const sent = Number(row.sent);
      const accepted = Number(row.accepted);
      const replied = Number(row.replied);
      return {
        workflowStepId: row.workflow_step_id,
        variantId: row.variant_id,
        kind: row.kind,
        sent,
        accepted,
        replied,
        acceptanceRate: row.kind === 'invite' && sent > 0 ? accepted / sent : null,
        replyRate: sent > 0 ? replied / sent : null,
        eligibleForWinner: sent >= 20
      };
    }),
    senders: senderRows.map((row) => ({
      seatKey: String(row.seat_key),
      planned: Number(row.planned),
      executed: Number(row.executed),
      invitesSent: Number(row.invites_sent),
      accepted: Number(row.accepted),
      messagesSent: Number(row.messages_sent),
      replied: Number(row.replied),
      failed: Number(row.failed),
      safetyBlocks: Number(row.safety_blocks),
      acceptanceRate:
        Number(row.invites_sent) > 0 ? Number(row.accepted) / Number(row.invites_sent) : null,
      replyRate:
        Number(row.messages_sent) > 0 ? Number(row.replied) / Number(row.messages_sent) : null,
      allocationShare: totalSenderExecuted > 0 ? Number(row.executed) / totalSenderExecuted : null
    })),
    bottlenecks: {
      pending: queues.pending,
      waitingOnCondition:
        queues.waitingForConnection + queues.waitingForReply + queues.waitingOther,
      overdueActions: stepRows.reduce((sum, row) => sum + Number(row.overdue), 0),
      heldActions: queues.held,
      failedMembers: queues.failed,
      limitingKind,
      reason
    },
    channels: {
      emailSent: Number(channelStats?.email_sent ?? 0),
      emailReplied: Number(emailReplyStats?.total ?? 0),
      inmailSent: Number(inmailStats?.sent ?? 0),
      inmailReplied: Number(inmailStats?.replied ?? 0),
      inmailFailed: Number(inmailStats?.failed ?? 0),
      inmailPaidCreditsUsed: Number(inmailStats?.paid_credits ?? 0),
      inmailPaidCreditCap: campaign.inmailCreditCap,
      enrichmentAttempts: Number(channelStats?.enrichment_attempts ?? 0),
      enrichmentFound: Number(channelStats?.enrichment_found ?? 0),
      enrichmentCreditsUsed: Number(channelStats?.enrichment_credits_used ?? 0),
      enrichmentCreditCap: campaign.enrichmentCreditCap
    },
    admissionForecast
  };
}
