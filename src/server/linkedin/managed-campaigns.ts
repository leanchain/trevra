import { id, type Db } from '../db.js';
import { COUNTED_MESSAGE_KINDS, recordAction } from './actions.js';
import type { CampaignStatus } from './action-ledger.js';
import { getLeadList } from './lead-lists.js';
import { getSeat, OWNER_SEAT_KEY } from './seats.js';
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
  | 'failed';

export interface ManagedCampaign {
  id: string;
  workspaceId: string;
  name: string;
  status: ManagedCampaignStatus;
  seatKey: string;
  leadListId: string;
  workflowId: string;
  /**
   * The workflow VERSION this campaign is executing, out of its own snapshot.
   *
   * Not the workflow's current version, and the difference is the whole point:
   * a running campaign executes the steps it was started with, so an operator
   * looking at this number is looking at what is actually happening to their
   * leads rather than at what the workflow editor happens to contain today.
   * Null for a campaign with no readable snapshot.
   */
  workflowVersion: number | null;
  /**
   * THE STEPS THIS CAMPAIGN IS ACTUALLY RUNNING -- its own snapshot, not a
   * live read of `linkedin_workflows`.
   *
   * The campaign screen tells the operator, in so many words, that "editing
   * one does not change campaigns already running on it". That sentence was
   * false: `runner.ts` loaded the workflow by id on every tick, so saving an
   * edit rewrote the sequence of every campaign already mid-flight -- moving
   * people who had had step 2 to a different step 3, or off the end of a
   * shortened workflow entirely.
   *
   * It is served here so a member timeline renders the steps that member is
   * really on, including ones an edit has since deleted from the workflow.
   */
  steps: WorkflowStep[];
  startedAt: string | null;
  pausedAt: string | null;
  memberCount: number;
  activeCount: number;
  createdAt: string;
  updatedAt: string;
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
  assignedVariants: Record<string, string>;
  lastActionId: string | null;
  firstName: string;
  lastName: string;
  company: string;
  profileUrl: string | null;
}

// `status` is `CampaignStatus`, narrowed where action-ledger.ts narrows it and
// for the reason given there -- so `toCampaign` below needs no cast either.
interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  status: CampaignStatus;
  seat_key: string;
  lead_list_id: string;
  workflow_id: string;
  sequence_json: unknown;
  started_at: string | null;
  paused_at: string | null;
  member_count: number;
  active_count: number;
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
  assigned_variants: unknown;
  last_action_id: string | null;
  first_name: string;
  last_name: string;
  company: string;
  profile_url: string | null;
}

const ACTIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;
const CAMPAIGN_SELECT = `
  c.id,c.workspace_id,c.name,c.status,c.seat_key,c.lead_list_id,c.workflow_id,c.sequence_json,c.started_at,c.paused_at,c.created_at,c.updated_at,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id) AS member_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status = ANY(ARRAY['pending','active','waiting','manual','paused'])) AS active_count
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

function toCampaign(row: CampaignRow): ManagedCampaign {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    seatKey: row.seat_key,
    leadListId: row.lead_list_id,
    workflowId: row.workflow_id,
    workflowVersion: snapshotVersion(row.sequence_json),
    steps: campaignSnapshotSteps(row.sequence_json),
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    memberCount: Number(row.member_count),
    activeCount: Number(row.active_count),
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
    assignedVariants: parseVariants(row.assigned_variants),
    lastActionId: row.last_action_id,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    profileUrl: row.profile_url
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
    SELECT m.id,m.campaign_id,m.contact_id,m.status,m.step_index,m.current_step_id,m.completed_step_ids,
           m.next_eligible_at,m.assigned_variants,m.last_action_id,
           l.first_name,l.last_name,l.company,l.profile_url
    FROM linkedin_campaign_members m JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
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
    leadListId: string;
    workflowId: string;
  },
  now: Date = new Date()
): Promise<{ campaign: ManagedCampaign; enrolled: number; skippedAlreadyActive: number }> {
  const name = input.name.trim();
  if (!name) throw new Error('Campaign name is required.');
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const [seat, list, workflow] = await Promise.all([
    getSeat(db, input.workspaceId, seatKey),
    getLeadList(db, input.workspaceId, input.leadListId, seatKey),
    getWorkflow(db, input.workspaceId, input.workflowId)
  ]);
  if (!seat) throw new Error(`LinkedIn account '${seatKey}' is not configured.`);
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
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,playbook_run_id,seat_key,lead_list_id,workflow_id,created_at,updated_at)
      VALUES (?,?,?,'draft',?::jsonb,NULL,?,?,?,?,?)
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
        list.id,
        workflow.id,
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
    // THE DIGEST IS KEYED ON THE WORKSPACE FIRST -- see `derivedMemberId`.
    const inserted = await tx
      .prepare(
        `
      INSERT INTO linkedin_campaign_members (
        id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,assigned_variants,created_at,updated_at
      )
      SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'pending', 0, ?, '[]'::jsonb, '{}'::jsonb, ?, ?
      FROM linkedin_lead_list_members m WHERE m.workspace_id=? AND m.list_id=?
      ON CONFLICT DO NOTHING RETURNING id
    `
      )
      .all<{ id: string }>(
        input.workspaceId,
        campaignId,
        input.workspaceId,
        campaignId,
        workflow.steps[0]?.id ?? null,
        timestamp,
        timestamp,
        input.workspaceId,
        list.id
      );
    enrolled = inserted.length;
  });
  const campaign = await getManagedCampaign(db, input.workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign could not be created.');
  return { campaign, enrolled, skippedAlreadyActive: Math.max(0, total - enrolled) };
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
  // Straight to 'active' on the first step's own delay -- the campaign is
  // already running, so there is no start event coming to promote a 'pending'
  // row, and a member stuck at 'pending' is one the runner never selects.
  const eligible = firstEligibleAt(campaign.steps, now);
  const inserted = await db
    .prepare(
      `
    INSERT INTO linkedin_campaign_members (
      id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,next_eligible_at,assigned_variants,created_at,updated_at
    )
    SELECT ${DERIVED_MEMBER_ID}, ?, ?, m.contact_id, 'active', 0, ?, '[]'::jsonb, ?::timestamptz, '{}'::jsonb, ?, ?
    FROM linkedin_lead_list_members m WHERE m.workspace_id=? AND m.list_id=?
    ON CONFLICT DO NOTHING RETURNING id
  `
    )
    .all<{ id: string }>(
      workspaceId,
      campaign.id,
      workspaceId,
      campaign.id,
      campaign.steps[0]?.id ?? null,
      eligible,
      timestamp,
      timestamp,
      workspaceId,
      campaign.leadListId
    );
  return inserted.length;
}

/**
 * The steps a campaign is executing: its own snapshot, or the live workflow
 * when it has none.
 *
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
  const eligible = firstEligibleAt(workflow.steps, now);
  const snapshot = JSON.stringify({
    manager: true,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    steps: workflow.steps
  });
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE linkedin_campaigns SET status='running',started_at=COALESCE(started_at,?),paused_at=NULL,sequence_json=?::jsonb,updated_at=? WHERE workspace_id=? AND id=?`
      )
      .run(timestamp, snapshot, timestamp, workspaceId, campaignId);
    await tx
      .prepare(
        `UPDATE linkedin_campaign_members
         SET status='active',
             current_step_id=COALESCE(current_step_id,?),
             next_eligible_at=COALESCE(next_eligible_at,?::timestamptz),
             updated_at=?
         WHERE workspace_id=? AND campaign_id=? AND status='pending'`
      )
      .run(workflow.steps[0]?.id ?? null, eligible, timestamp, workspaceId, campaignId);
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
          `UPDATE linkedin_campaign_members SET status='paused',updated_at=? WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual')`
        )
        .run(timestamp, workspaceId, memberId)
    : await db
        .prepare(
          `UPDATE linkedin_campaign_members SET status='active',updated_at=? WHERE workspace_id=? AND id=? AND status='paused'`
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
      SELECT t.member_id, t.campaign_id, t.seat_key, t.workflow_step_id, t.suggested_body, l.profile_url,
             m.step_index, m.current_step_id, m.completed_step_ids
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
      }>(workspaceId, taskId);
    if (!task) return false;

    const steps = await campaignWorkflowSteps(tx, workspaceId, task.campaign_id);
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
