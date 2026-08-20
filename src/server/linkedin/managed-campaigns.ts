import { id, type Db } from '../db.js';
import { COUNTED_MESSAGE_KINDS, recordAction } from './actions.js';
import type { CampaignStatus } from './action-ledger.js';
import {
  decideAdmission,
  workflowAdmissionDemand,
  type AdmissionDecision,
  type AdmissionPolicy
} from './admission.js';
import { getLeadList } from './lead-lists.js';
import { effectivePosture, getSeat, OWNER_SEAT_KEY } from './seats.js';
import { bandFor, effectiveDailyCeiling, seatOperatorLimit, type PacedKind } from './limits.js';
import {
  delayMilliseconds,
  getWorkflow,
  parseWorkflowSteps,
  type WorkflowStep
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
}

export interface ManagedCampaignMember {
  id: string;
  campaignId: string;
  contactId: string;
  status: ManagedMemberStatus;
  stepIndex: number;
  nextEligibleAt: string | null;
  admittedAt: string | null;
  waveId: string | null;
  waveOrdinal: number | null;
  assignedSeatKey: string | null;
  workflowVersion: number | null;
  assignedVariants: Record<string, string>;
  branchState: Record<string, unknown>;
  lastActionId: string | null;
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
  }>;
}

export interface CampaignQueueSummary {
  pending: number;
  dueNow: number;
  scheduledToday: number;
  waitingForConnection: number;
  waitingForReply: number;
  waitingOther: number;
  manual: number;
  held: number;
  blocked: number;
  failed: number;
  backlogByStep: Array<{ stepId: string; count: number; due: number }>;
}
interface CampaignRow {
  id: string;
  workspace_id: string;
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
  c.id,c.workspace_id,c.name,c.status,c.seat_key,c.lead_list_id,c.workflow_id,c.sequence_json,
  c.priority,c.admission_policy_json,c.exclusion_policy_json,c.sender_keys_json,c.mailbox_assignments_json,
  c.scheduled_start_at,c.scheduled_end_at,c.schedule_days_json,c.schedule_start_minute,c.schedule_end_minute,c.end_behavior,c.inmail_credit_cap,c.last_admission_at,
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
function toMember(row: MemberRow): ManagedCampaignMember {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    status: row.status as ManagedMemberStatus,
    stepIndex: Number(row.step_index),
    nextEligibleAt: row.next_eligible_at,
    admittedAt: row.admitted_at,
    waveId: row.wave_id,
    waveOrdinal: row.wave_ordinal === null ? null : Number(row.wave_ordinal),
    assignedSeatKey: row.assigned_seat_key,
    workflowVersion: row.workflow_version === null ? null : Number(row.workflow_version),
    assignedVariants: parseVariants(row.assigned_variants),
    branchState: parseJsonObject(row.branch_state_json),
    lastActionId: row.last_action_id,
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

export async function listCampaignMembers(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<ManagedCampaignMember[]> {
  const rows = await db
    .prepare(
      `
    SELECT m.id,m.campaign_id,m.contact_id,m.status,m.step_index,m.next_eligible_at,m.admitted_at,m.wave_id,w.ordinal AS wave_ordinal,
           m.assigned_seat_key,m.workflow_snapshot_json,m.workflow_version,m.assigned_variants,m.branch_state_json,m.last_action_id,m.exclusion_reason,m.last_failure_reason,
           l.first_name,l.last_name,l.company,l.email,l.profile_url,l.custom_fields_json
    FROM linkedin_campaign_members m
    JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
    LEFT JOIN linkedin_campaign_waves w ON w.id=m.wave_id AND w.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY m.created_at,m.id
  `
    )
    .all<MemberRow>(workspaceId, campaignId);
  return rows.map(toMember);
}

export async function createManagedCampaign(
  db: Db,
  input: {
    workspaceId: string;
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
  },
  now: Date = new Date()
): Promise<{
  campaign: ManagedCampaign;
  enrolled: number;
  skippedAlreadyActive: number;
  excluded: number;
}> {
  const name = input.name.trim();
  if (
    input.inmailCreditCap != null &&
    (!Number.isInteger(input.inmailCreditCap) ||
      input.inmailCreditCap < 0 ||
      input.inmailCreditCap > 10000)
  )
    throw new Error('Campaign InMail credit cap must be a whole number from 0 to 10000.');
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
        id,workspace_id,name,status,sequence_json,playbook_run_id,seat_key,sender_keys_json,mailbox_assignments_json,lead_list_id,workflow_id,
        priority,admission_policy_json,exclusion_policy_json,scheduled_start_at,scheduled_end_at,schedule_days_json,
        schedule_start_minute,schedule_end_minute,end_behavior,inmail_credit_cap,created_at,updated_at
      )
      VALUES (?,?,?,'draft',?::jsonb,NULL,?,?::jsonb,?::jsonb,?,?,?,?::jsonb,?::jsonb,?,?,?::jsonb,?,?,?,?, ?,?)
    `
      )
      .run(
        campaignId,
        input.workspaceId,
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
        id,workspace_id,campaign_id,contact_id,status,step_index,assigned_variants,exclusion_reason,created_at,updated_at
      )
      SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'excluded', 0, '{}'::jsonb, '__eligibility__', ?, ?
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

    const policy = input.exclusionPolicy ?? {};
    const suppressedCompanies = (policy.suppressedCompanies ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const lookback = Math.max(0, Math.trunc(policy.contactedLookbackDays ?? 0));
    const promoted = await tx
      .prepare(
        `
      UPDATE linkedin_campaign_members m
      SET status='pending', exclusion_reason=NULL, updated_at=?
      FROM linkedin_lead_contacts c
      WHERE m.workspace_id=? AND m.campaign_id=? AND m.contact_id=c.id AND c.workspace_id=m.workspace_id
        AND m.status='excluded' AND m.exclusion_reason='__eligibility__'
        AND (?::boolean = false OR c.do_not_contact=false)
        AND (?::boolean = false OR (c.profile_url IS NOT NULL AND BTRIM(c.profile_url)<>''))
        AND (COALESCE(array_length(?::text[],1),0)=0 OR LOWER(c.company) <> ALL(?::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM linkedin_campaign_members other
          WHERE other.workspace_id=m.workspace_id AND other.contact_id=m.contact_id AND other.campaign_id<>m.campaign_id
            AND other.status IN ('pending','active','waiting','manual','paused')
        )
        AND (?::boolean=false OR NOT EXISTS (
          SELECT 1 FROM linkedin_threads t JOIN linkedin_messages msg ON msg.thread_id=t.id AND msg.workspace_id=t.workspace_id
          WHERE t.workspace_id=m.workspace_id AND c.profile_url IS NOT NULL AND LOWER(t.profile_url)=LOWER(c.profile_url) AND msg.direction='in'
        ))
        AND (?::int=0 OR NOT EXISTS (
          SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND c.profile_url IS NOT NULL
            AND LOWER(a.target_ref)=LOWER(c.profile_url) AND a.status<>'skipped'
            AND a.created_at >= (?::timestamptz - (?::int * INTERVAL '1 day'))
        ))
        AND (?::boolean=false OR NOT EXISTS (
          SELECT 1 FROM linkedin_actions a WHERE a.workspace_id=m.workspace_id AND a.seat_key = ANY(?::text[])
            AND c.profile_url IS NOT NULL AND LOWER(a.target_ref)=LOWER(c.profile_url)
            AND a.kind IN ('dm','reply','inmail') AND a.status IN ('sent','replied')
        ))
      RETURNING m.id
    `
      )
      .all<{ id: string }>(
        timestamp,
        input.workspaceId,
        campaignId,
        policy.excludeDoNotContact !== false,
        policy.excludeMissingProfile !== false,
        suppressedCompanies,
        suppressedCompanies,
        policy.excludeExistingConversation === true,
        lookback,
        now.toISOString(),
        lookback,
        policy.excludeSameSenderMessaged === true,
        requestedSenders
      );
    enrolled = promoted.length;

    await tx
      .prepare(
        `
      UPDATE linkedin_campaign_members m SET exclusion_reason = CASE
        WHEN EXISTS (SELECT 1 FROM linkedin_lead_contacts c WHERE c.id=m.contact_id AND c.workspace_id=m.workspace_id AND c.do_not_contact) THEN 'Do not contact'
        WHEN EXISTS (SELECT 1 FROM linkedin_lead_contacts c WHERE c.id=m.contact_id AND c.workspace_id=m.workspace_id AND (c.profile_url IS NULL OR BTRIM(c.profile_url)='')) THEN 'Missing LinkedIn profile URL'
        WHEN EXISTS (SELECT 1 FROM linkedin_campaign_members other WHERE other.workspace_id=m.workspace_id AND other.contact_id=m.contact_id AND other.campaign_id<>m.campaign_id AND other.status IN ('pending','active','waiting','manual','paused')) THEN 'Already in another live campaign'
        ELSE 'Excluded by campaign eligibility policy'
      END
      WHERE m.workspace_id=? AND m.campaign_id=? AND m.status='excluded' AND m.exclusion_reason='__eligibility__'
    `
      )
      .run(input.workspaceId, campaignId);
  });
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
  // Live-list additions join the pending pool. Admission, not enrolment, decides when their
  // first action can exist. Removed members keep their derived id and therefore never re-enter.
  const inserted = await db
    .prepare(
      `
    INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,next_eligible_at,assigned_variants,created_at,updated_at)
    SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'pending', 0, NULL, '{}'::jsonb, ?, ?
    FROM linkedin_lead_list_members m
    JOIN linkedin_lead_contacts c ON c.id=m.contact_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.list_id=?
      AND c.do_not_contact=false AND c.profile_url IS NOT NULL AND BTRIM(c.profile_url)<>''
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_campaign_members other
        WHERE other.workspace_id=? AND other.contact_id=m.contact_id AND other.campaign_id<>?
          AND other.status IN ('pending','active','waiting','manual','paused')
      )
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
      campaign.leadListId,
      workspaceId,
      campaign.id
    );
  return inserted.length;
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
            COUNT(*) FILTER (WHERE a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied'))::int AS failed
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
      failed: Number(row.failed)
    });
    byWave.set(row.wave_id, list);
  }
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
    stepFunnel: byWave.get(row.id) ?? []
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
        pending.length,
        input.decision.reasons.join(' '),
        JSON.stringify(input.decision.capacitySnapshot),
        timestamp
      );
    const senderKeys = input.senderKeys.length > 0 ? [...input.senderKeys] : [OWNER_SEAT_KEY];
    // Stable deterministic round-robin: wave ordinal and row order decide once; assignment is persisted.
    for (let at = 0; at < pending.length; at += 1) {
      const sender = senderKeys[(ordinal - 1 + at) % senderKeys.length];
      const result = await tx
        .prepare(
          `UPDATE linkedin_campaign_members m
           SET status='active',admitted_at=?::timestamptz,wave_id=?,assigned_seat_key=?,
               workflow_snapshot_json=(SELECT c.sequence_json FROM linkedin_campaigns c WHERE c.workspace_id=m.workspace_id AND c.id=m.campaign_id),
               workflow_version=(SELECT CASE WHEN (c.sequence_json->>'workflowVersion') ~ '^[0-9]+$' THEN (c.sequence_json->>'workflowVersion')::integer ELSE NULL END FROM linkedin_campaigns c WHERE c.workspace_id=m.workspace_id AND c.id=m.campaign_id),
               next_eligible_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=? AND status='pending' AND admitted_at IS NULL`
        )
        .run(
          timestamp,
          waveId,
          sender,
          firstEligible,
          timestamp,
          input.workspaceId,
          pending[at].id
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
        `UPDATE linkedin_actions SET status='planned' WHERE workspace_id=? AND campaign_id=? AND status='held'`
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
  const result = paused
    ? await db
        .prepare(
          `UPDATE linkedin_campaign_members
           SET paused_from_status=status,status='paused',updated_at=?
           WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual')`
        )
        .run(timestamp, workspaceId, memberId)
    : await db
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
  return result.changes > 0;
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
    SELECT t.id,t.campaign_id,t.member_id,t.contact_id,t.seat_key,t.workflow_step_id,t.suggested_body,t.status,t.created_at,t.completed_at,
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
      SELECT t.member_id, t.campaign_id, t.seat_key, t.workflow_step_id, t.suggested_body, l.profile_url
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
      }>(workspaceId, taskId);
    if (!task) return false;
    // RETURNING the NEW step_index, which is the index of the step this member
    // is about to wait for.
    const member = await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET status='active',step_index=step_index+1,updated_at=? WHERE workspace_id=? AND id=? AND status='manual' RETURNING step_index`
      )
      .get<{ step_index: number }>(timestamp, workspaceId, task.member_id);
    if (!member) return false;
    const steps = await campaignWorkflowSteps(tx, workspaceId, task.campaign_id);
    const nextStep = steps[Number(member.step_index)];
    // No next step: due immediately, and the next tick files the member
    // 'completed' when it reads past the end of the sequence.
    const eligible = new Date(
      now.getTime() + (nextStep ? delayMilliseconds(nextStep.delayBefore) : 0)
    ).toISOString();
    await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET next_eligible_at=?::timestamptz WHERE workspace_id=? AND id=?`
      )
      .run(eligible, workspaceId, task.member_id);
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

export async function previewManagedCampaignLaunch(
  db: Db,
  input: {
    workspaceId: string;
    leadListId: string;
    workflowId: string;
    senderKeys?: string[];
    seatKey?: string;
    admissionPolicy?: AdmissionPolicy;
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
      const dayOne = campaignActionLimit(ceiling, null, now);
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
  return {
    audience: list.leadCount,
    eligibleSenders,
    dayOneCapacity: capacity,
    sustainableNewLeadsPerDay: decision.admit,
    firstWaveSize: decision.admit,
    bottleneck: decision.limitingKind,
    demand,
    reasons: decision.reasons
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
      `SELECT
       COUNT(*) FILTER (WHERE status='planned' AND planned_for>=?::timestamptz AND planned_for<?::timestamptz)::int AS scheduled,
       COUNT(*) FILTER (WHERE status='held')::int AS held
     FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?`
    )
    .get<{ scheduled: number; held: number }>(
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
      workspaceId,
      campaignId
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
    waitingForConnection,
    waitingForReply,
    waitingOther,
    manual,
    held: Number(actionCounts?.held ?? 0),
    blocked: Number(blocked),
    failed,
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
    schedule?: Partial<CampaignSchedule>;
    senderKeys?: string[];
    mailboxAssignments?: Record<string, string>;
    inmailCreditCap?: number | null;
  },
  now: Date = new Date()
): Promise<ManagedCampaign> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (
    (input.admissionPolicy || input.schedule || input.senderKeys || input.mailboxAssignments) &&
    campaign.status === 'running'
  ) {
    throw new Error(
      'Pause the campaign before changing admission, schedule, or sender settings. Priority may be changed while running.'
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
  const timestamp = now.toISOString();
  await db
    .prepare(
      `UPDATE linkedin_campaigns SET
       priority=COALESCE(?,priority),
       admission_policy_json=COALESCE(?::jsonb,admission_policy_json),
       sender_keys_json=COALESCE(?::jsonb,sender_keys_json),
       mailbox_assignments_json=COALESCE(?::jsonb,mailbox_assignments_json),
       seat_key=COALESCE(?,seat_key),
       scheduled_start_at=CASE WHEN ?::boolean THEN ?::timestamptz ELSE scheduled_start_at END,
       scheduled_end_at=CASE WHEN ?::boolean THEN ?::timestamptz ELSE scheduled_end_at END,
       schedule_days_json=CASE WHEN ?::boolean THEN ?::jsonb ELSE schedule_days_json END,
       schedule_start_minute=CASE WHEN ?::boolean THEN ? ELSE schedule_start_minute END,
       schedule_end_minute=CASE WHEN ?::boolean THEN ? ELSE schedule_end_minute END,
       end_behavior=COALESCE(?,end_behavior),
       inmail_credit_cap=CASE WHEN ?::boolean THEN ? ELSE inmail_credit_cap END,updated_at=?
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
      timestamp,
      workspaceId,
      campaignId
    );
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
      name: (name?.trim() || `${campaign.name} copy`).slice(0, 120),
      senderKeys: campaign.senderKeys,
      leadListId: campaign.leadListId,
      workflowId: campaign.workflowId,
      priority: campaign.priority,
      admissionPolicy: campaign.admissionPolicy,
      exclusionPolicy: campaign.exclusionPolicy,
      schedule: campaign.schedule
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
    kind: 'wave' | 'action' | 'manual' | 'branch' | 'state';
    label: string;
    status?: string;
    stepId?: string | null;
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
            l.first_name,l.last_name,l.company,l.email,l.profile_url,l.custom_fields_json
     FROM linkedin_campaign_members m JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
     LEFT JOIN linkedin_campaign_waves w ON w.id=m.wave_id AND w.workspace_id=m.workspace_id
     WHERE m.workspace_id=? AND m.id=?`
    )
    .get<MemberRow>(workspaceId, memberId);
  if (!memberRow) return null;
  const member = toMember(memberRow);
  const events: CampaignMemberTimeline['events'] = [];
  if (member.admittedAt)
    events.push({
      at: member.admittedAt,
      kind: 'wave',
      label: `Admitted${member.waveOrdinal ? ` in wave ${member.waveOrdinal}` : ''}`
    });
  const actions = await db
    .prepare(
      `SELECT kind,status,workflow_step_id,planned_for,recorded_at,failure_kind,external_ref
     FROM linkedin_actions WHERE workspace_id=? AND campaign_member_id=? ORDER BY COALESCE(recorded_at,planned_for,created_at),created_at`
    )
    .all<{
      kind: string;
      status: string;
      workflow_step_id: string | null;
      planned_for: string | null;
      recorded_at: string | null;
      failure_kind: string | null;
      external_ref: string | null;
    }>(workspaceId, memberId);
  for (const action of actions)
    events.push({
      at: action.recorded_at ?? action.planned_for,
      kind: 'action',
      label: action.kind.replaceAll('_', ' '),
      status: action.status,
      stepId: action.workflow_step_id,
      detail: action.failure_kind ?? action.external_ref
    });
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
      stepId: task.workflow_step_id
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
  const row = await db
    .prepare(
      `SELECT campaign_id,step_index,status,workflow_snapshot_json FROM linkedin_campaign_members WHERE workspace_id=? AND id=?`
    )
    .get<{
      campaign_id: string;
      step_index: number;
      status: string;
      workflow_snapshot_json: unknown;
    }>(workspaceId, memberId);
  if (!row || !['active', 'waiting', 'manual', 'paused'].includes(row.status)) return false;
  const memberSteps = campaignSnapshotSteps(row.workflow_snapshot_json);
  const steps =
    memberSteps.length > 0
      ? memberSteps
      : await campaignWorkflowSteps(db, workspaceId, row.campaign_id);
  const step = steps[Number(row.step_index)];
  if (!step) return false;
  const targetId = step.nextStepId === null ? null : step.nextStepId;
  const nextIndex = targetId
    ? steps.findIndex((s) => s.id === targetId)
    : Number(row.step_index) + 1;
  const next = nextIndex >= 0 && nextIndex < steps.length ? steps[nextIndex] : null;
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND workflow_step_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
      )
      .run(workspaceId, memberId, step.id);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET step_index=?,status=?,next_eligible_at=?::timestamptz,updated_at=?::timestamptz WHERE workspace_id=? AND id=?`
      )
      .run(
        next ? nextIndex : steps.length,
        next ? 'waiting' : 'completed',
        next ? new Date(now.getTime() + delayMilliseconds(next.delayBefore)).toISOString() : null,
        timestamp,
        workspaceId,
        memberId
      );
  });
  return true;
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
  steps: WorkflowStep[];
} | null> {
  const row = await db
    .prepare(
      `SELECT campaign_id,status,step_index,workflow_snapshot_json
       FROM linkedin_campaign_members WHERE workspace_id=? AND id=?`
    )
    .get<{
      campaign_id: string;
      status: string;
      step_index: number;
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
    steps
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
  const result = await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET step_index=?,status='waiting',next_eligible_at=?::timestamptz,
           branch_state_json=(COALESCE(branch_state_json,'{}'::jsonb) - ?::text - ?::text),
           last_failure_reason=NULL,ended_at=NULL,updated_at=?::timestamptz
       WHERE workspace_id=? AND id=? AND status NOT IN ('replied','removed','excluded')`
    )
    .run(
      index,
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
    const result = await tx
      .prepare(
        `UPDATE linkedin_campaign_members SET step_index=?,status='waiting',next_eligible_at=?::timestamptz,
             last_action_id=NULL,last_failure_reason=NULL,ended_at=NULL,updated_at=?::timestamptz
         WHERE workspace_id=? AND id=? AND status NOT IN ('replied','removed','excluded')`
      )
      .run(index, timestamp, timestamp, workspaceId, memberId);
    changed = result.changes;
  });
  return changed > 0;
}

const RETRYABLE_LINKEDIN_FAILURES = [
  'not_found',
  'compose_unavailable',
  'paid_credit_required',
  'selector_drift',
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
         COUNT(*) FILTER (WHERE a.status IN ('planned','held'))::int AS scheduled,
         COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied','declined','withdrawn'))::int AS executed,
         COUNT(*) FILTER (WHERE a.status='skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE a.failure_kind IS NOT NULL AND a.status NOT IN ('sent','accepted','replied'))::int AS failed,
         COUNT(*) FILTER (WHERE a.status IN ('planned','held') AND a.planned_for<?::timestamptz)::int AS overdue,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a.recorded_at-a.planned_for))/60.0)
           FILTER (WHERE a.recorded_at IS NOT NULL AND a.planned_for IS NOT NULL) AS median_latency
       FROM linkedin_actions a
       WHERE a.workspace_id=? AND a.campaign_id=? AND a.workflow_step_id IS NOT NULL
       GROUP BY a.workflow_step_id ORDER BY a.workflow_step_id`
    )
    .all<{
      workflow_step_id: string;
      scheduled: number;
      executed: number;
      skipped: number;
      failed: number;
      overdue: number;
      median_latency: number | null;
    }>(now.toISOString(), workspaceId, campaignId);
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

  const queues = await campaignQueueSummary(db, workspaceId, campaignId, now);
  const latestWave = waveRows[0] ?? null;
  const capacity = latestWave?.capacitySnapshot ?? {};
  const limitingEntry = Object.entries(capacity)
    .filter(([, value]) => Number.isFinite(value))
    .sort((left, right) => left[1] - right[1])[0];
  const limitingKind = limitingEntry?.[0] ?? null;
  const reason =
    queues.held > 0
      ? `${queues.held} action(s) are held for operator review.`
      : queues.failed > 0
        ? `${queues.failed} lead(s) have failed and need operator action.`
        : queues.waitingForConnection + queues.waitingForReply > 0
          ? `${queues.waitingForConnection + queues.waitingForReply} lead(s) are waiting on an outcome.`
          : queues.pending > 0 && limitingKind
            ? `New admission is constrained by ${limitingKind} capacity.`
            : queues.pending > 0
              ? `${queues.pending} lead(s) remain in the pending pool until downstream capacity clears.`
              : 'No material campaign bottleneck is currently detected.';

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
            : Number(row.median_first_minutes)
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
      safetyBlocks: Number(row.safety_blocks)
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
    }
  };
}
