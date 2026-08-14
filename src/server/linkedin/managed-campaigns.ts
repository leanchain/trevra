import { id, type Db } from '../db.js';
import { getLeadList } from './lead-lists.js';
import { getSeat, OWNER_SEAT_KEY } from './seats.js';
import { delayMilliseconds, getWorkflow, parseWorkflowSteps, type WorkflowStep } from './workflows.js';

export type ManagedCampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'stopped';
export type ManagedMemberStatus = 'pending' | 'active' | 'waiting' | 'manual' | 'paused' | 'replied' | 'completed' | 'removed' | 'failed';

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
  stepIndex: number;
  nextEligibleAt: string | null;
  assignedVariants: Record<string, string>;
  lastActionId: string | null;
  firstName: string;
  lastName: string;
  company: string;
  profileUrl: string | null;
}

interface CampaignRow { id: string; workspace_id: string; name: string; status: string; seat_key: string; lead_list_id: string; workflow_id: string; sequence_json: unknown; started_at: string | null; paused_at: string | null; member_count: number; active_count: number; created_at: string; updated_at: string }
interface MemberRow { id: string; campaign_id: string; contact_id: string; status: string; step_index: number; next_eligible_at: string | null; assigned_variants: unknown; last_action_id: string | null; first_name: string; last_name: string; company: string; profile_url: string | null }

const ACTIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;
const CAMPAIGN_SELECT = `
  c.id,c.workspace_id,c.name,c.status,c.seat_key,c.lead_list_id,c.workflow_id,c.sequence_json,c.started_at,c.paused_at,c.created_at,c.updated_at,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id) AS member_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status = ANY(ARRAY['pending','active','waiting','manual','paused'])) AS active_count
`;

/**
 * The steps stored in a campaign's `sequence_json` snapshot.
 *
 * NEVER THROWS, and that is deliberate: `linkedin_campaigns` also holds the
 * legacy playbook sequences (`campaigns.ts`), whose `sequence_json` is a
 * completely different shape, and a manager read that exploded on one of those
 * would take the campaign list down with it. An unreadable or foreign snapshot
 * is an empty list, which every caller already has to handle -- a campaign
 * whose workflow was deleted has always been able to have no steps.
 */
export function campaignSnapshotSteps(sequenceJson: unknown): WorkflowStep[] {
  const raw = typeof sequenceJson === 'string'
    ? (() => { try { return JSON.parse(sequenceJson) as unknown; } catch { return null; } })()
    : sequenceJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return parseWorkflowSteps((raw as Record<string, unknown>).steps);
}

function snapshotVersion(sequenceJson: unknown): number | null {
  const raw = typeof sequenceJson === 'string'
    ? (() => { try { return JSON.parse(sequenceJson) as unknown; } catch { return null; } })()
    : sequenceJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const version = (raw as Record<string, unknown>).workflowVersion;
  return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

function toCampaign(row: CampaignRow): ManagedCampaign {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, status: row.status as ManagedCampaignStatus, seatKey: row.seat_key, leadListId: row.lead_list_id, workflowId: row.workflow_id, workflowVersion: snapshotVersion(row.sequence_json), steps: campaignSnapshotSteps(row.sequence_json), startedAt: row.started_at, pausedAt: row.paused_at, memberCount: Number(row.member_count), activeCount: Number(row.active_count), createdAt: row.created_at, updatedAt: row.updated_at };
}
function parseVariants(value: unknown): Record<string, string> {
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return {}; } })() : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)])) : {};
}
function toMember(row: MemberRow): ManagedCampaignMember {
  return { id: row.id, campaignId: row.campaign_id, contactId: row.contact_id, status: row.status as ManagedMemberStatus, stepIndex: Number(row.step_index), nextEligibleAt: row.next_eligible_at, assignedVariants: parseVariants(row.assigned_variants), lastActionId: row.last_action_id, firstName: row.first_name, lastName: row.last_name, company: row.company, profileUrl: row.profile_url };
}

/** Campaign-day ramp requested by the manager brief: days 1..5 => 20/40/60/80/100%. */
export function campaignWarmupFraction(startedAt: string | null, now: Date): number {
  if (!startedAt) return 0.2;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || start > now.getTime()) return 0.2;
  const day = Math.floor((now.getTime() - start) / 86_400_000) + 1;
  return Math.min(1, Math.max(0.2, day * 0.2));
}

export function campaignActionLimit(accountLimit: number, startedAt: string | null, now: Date): number {
  return Math.floor(accountLimit * campaignWarmupFraction(startedAt, now));
}

export async function listManagedCampaigns(db: Db, workspaceId: string): Promise<ManagedCampaign[]> {
  const rows = await db.prepare(`SELECT ${CAMPAIGN_SELECT} FROM linkedin_campaigns c WHERE c.workspace_id=? AND c.lead_list_id IS NOT NULL AND c.workflow_id IS NOT NULL ORDER BY c.created_at DESC`).all<CampaignRow>(workspaceId);
  return rows.map(toCampaign);
}

export async function getManagedCampaign(db: Db, workspaceId: string, campaignId: string): Promise<ManagedCampaign | undefined> {
  const row = await db.prepare(`SELECT ${CAMPAIGN_SELECT} FROM linkedin_campaigns c WHERE c.workspace_id=? AND c.id=? AND c.lead_list_id IS NOT NULL AND c.workflow_id IS NOT NULL`).get<CampaignRow>(workspaceId, campaignId);
  return row ? toCampaign(row) : undefined;
}

export async function listCampaignMembers(db: Db, workspaceId: string, campaignId: string): Promise<ManagedCampaignMember[]> {
  const rows = await db.prepare(`
    SELECT m.id,m.campaign_id,m.contact_id,m.status,m.step_index,m.next_eligible_at,m.assigned_variants,m.last_action_id,
           l.first_name,l.last_name,l.company,l.profile_url
    FROM linkedin_campaign_members m JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
    WHERE m.workspace_id=? AND m.campaign_id=? ORDER BY m.created_at,m.id
  `).all<MemberRow>(workspaceId, campaignId);
  return rows.map(toMember);
}

export async function createManagedCampaign(
  db: Db,
  input: { workspaceId: string; name: string; seatKey?: string; leadListId: string; workflowId: string },
  now: Date = new Date()
): Promise<{ campaign: ManagedCampaign; enrolled: number; skippedAlreadyActive: number }> {
  const name = input.name.trim();
  if (!name) throw new Error('Campaign name is required.');
  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  const [seat, list, workflow] = await Promise.all([
    getSeat(db, input.workspaceId, seatKey), getLeadList(db, input.workspaceId, input.leadListId), getWorkflow(db, input.workspaceId, input.workflowId)
  ]);
  if (!seat) throw new Error(`LinkedIn account '${seatKey}' is not configured.`);
  if (!list) throw new Error('Lead list not found.');
  if (!workflow) throw new Error('Workflow not found.');
  const timestamp = now.toISOString();
  const campaignId = id('licmp');
  let enrolled = 0;
  let total = 0;
  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,playbook_run_id,seat_key,lead_list_id,workflow_id,created_at,updated_at)
      VALUES (?,?,?,'draft',?::jsonb,NULL,?,?,?,?,?)
    `).run(campaignId, input.workspaceId, name, JSON.stringify({ manager: true, workflowId: workflow.id, workflowVersion: workflow.version, steps: workflow.steps }), seatKey, list.id, workflow.id, timestamp, timestamp);
    // Membership is `linkedin_lead_list_members` (migration 052), not the
    // contact's own `list_id`: one person may sit in several lists, and
    // `list_id` only remembers the first one they were imported into.
    const count = await tx.prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?').get<{ total: number }>(input.workspaceId, list.id);
    total = count?.total ?? 0;
    const inserted = await tx.prepare(`
      INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,assigned_variants,created_at,updated_at)
      SELECT 'limem_' || md5(? || ':' || m.contact_id), ?, ?, m.contact_id, 'pending', 0, '{}'::jsonb, ?, ?
      FROM linkedin_lead_list_members m WHERE m.workspace_id=? AND m.list_id=?
      ON CONFLICT DO NOTHING RETURNING id
    `).all<{ id: string }>(campaignId, input.workspaceId, campaignId, timestamp, timestamp, input.workspaceId, list.id);
    enrolled = inserted.length;
  });
  const campaign = await getManagedCampaign(db, input.workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign could not be created.');
  return { campaign, enrolled, skippedAlreadyActive: Math.max(0, total - enrolled) };
}
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
 * The id is `md5(campaignId:contactId)`, exactly as creation computes it, so a
 * contact REMOVED from this campaign is not silently re-enrolled by the next
 * tick: the removed row still owns that primary key and the insert is a no-op.
 * Removal means removed.
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
  const inserted = await db.prepare(`
    INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,next_eligible_at,assigned_variants,created_at,updated_at)
    SELECT 'limem_' || md5(? || ':' || m.contact_id), ?, ?, m.contact_id, 'active', 0, ?::timestamptz, '{}'::jsonb, ?, ?
    FROM linkedin_lead_list_members m WHERE m.workspace_id=? AND m.list_id=?
    ON CONFLICT DO NOTHING RETURNING id
  `).all<{ id: string }>(campaign.id, workspaceId, campaign.id, eligible, timestamp, timestamp, workspaceId, campaign.leadListId);
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
export async function campaignWorkflowSteps(db: Db, workspaceId: string, campaignId: string): Promise<WorkflowStep[]> {
  const row = await db.prepare('SELECT sequence_json, workflow_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
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
export async function startManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status === 'stopped' || campaign.status === 'completed') throw new Error(`A ${campaign.status} campaign cannot be started again.`);
  const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
  if (!workflow) throw new Error('Campaign workflow no longer exists.');
  const timestamp = now.toISOString();
  const eligible = firstEligibleAt(workflow.steps, now);
  const snapshot = JSON.stringify({ manager: true, workflowId: workflow.id, workflowVersion: workflow.version, steps: workflow.steps });
  await db.transaction(async (tx) => {
    await tx.prepare(`UPDATE linkedin_campaigns SET status='running',started_at=COALESCE(started_at,?),paused_at=NULL,sequence_json=?::jsonb,updated_at=? WHERE workspace_id=? AND id=?`).run(timestamp, snapshot, timestamp, workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_campaign_members SET status='active',next_eligible_at=COALESCE(next_eligible_at,?::timestamptz),updated_at=? WHERE workspace_id=? AND campaign_id=? AND status='pending'`).run(eligible, timestamp, workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_actions SET status='planned' WHERE workspace_id=? AND campaign_id=? AND status='held'`).run(workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

/**
 * Pause a campaign, and HOLD the work it has already queued.
 *
 * Writing 'paused' into `linkedin_campaigns` on its own was decoration, for
 * exactly the reason `campaigns.ts` `stopCampaign` spells out about
 * `stop_requested_at`: the local worker claims out of `linkedin_actions` and
 * never looks at this table. So a pause stopped the PLANNER -- the runner
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
export async function pauseManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    const result = await tx.prepare(`UPDATE linkedin_campaigns SET status='paused',paused_at=?,updated_at=? WHERE workspace_id=? AND id=? AND status='running'`).run(timestamp, timestamp, workspaceId, campaignId);
    // Thrown, not returned: it rolls the hold back with it, so a refused pause
    // cannot leave half a campaign's queue parked.
    if (!result.changes) throw new Error('Only a running campaign can be paused.');
    await tx.prepare(`UPDATE linkedin_actions SET status='held' WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL`).run(workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function stopManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`UPDATE linkedin_campaigns SET status='stopped',stop_requested_at=COALESCE(stop_requested_at,?::timestamptz),updated_at=? WHERE workspace_id=? AND id=?`).run(timestamp, timestamp, workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=? WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])`).run(timestamp, workspaceId, campaignId, [...ACTIVE_MEMBER_STATUSES]);
    await tx.prepare(`UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND campaign_id=? AND status='pending'`).run(workspaceId, campaignId);
    // 'held' as well as 'planned': a campaign stopped while it was PAUSED has
    // its queue parked in 'held' (migration 051), and leaving those rows behind
    // would strand them -- unclaimable forever, and still holding the replay
    // guard against a target this stop is supposed to release.
    await tx.prepare(`UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_id=? AND status IN ('planned','held') AND claimed_at IS NULL`).run(workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function setCampaignMemberPaused(db: Db, workspaceId: string, memberId: string, paused: boolean, now: Date = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  const result = paused
    ? await db.prepare(`UPDATE linkedin_campaign_members SET status='paused',updated_at=? WHERE workspace_id=? AND id=? AND status IN ('pending','active','waiting','manual')`).run(timestamp, workspaceId, memberId)
    : await db.prepare(`UPDATE linkedin_campaign_members SET status='active',updated_at=? WHERE workspace_id=? AND id=? AND status='paused'`).run(timestamp, workspaceId, memberId);
  return result.changes > 0;
}

export async function removeCampaignMember(db: Db, workspaceId: string, memberId: string, now: Date = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const member = await tx.prepare(`UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND status = ANY(?::text[]) RETURNING campaign_id`).get<{ campaign_id: string }>(timestamp, workspaceId, memberId, [...ACTIVE_MEMBER_STATUSES]);
    if (!member) return false;
    await tx.prepare(`UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND member_id=? AND status='pending'`).run(workspaceId, memberId);
    await tx.prepare(`UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND status IN ('planned','held') AND claimed_at IS NULL`).run(workspaceId, memberId);
    return true;
  });
}

export interface ManualTaskView { id: string; campaignId: string; memberId: string; contactId: string; seatKey: string; workflowStepId: string; suggestedBody: string | null; status: string; createdAt: string; completedAt: string | null; firstName: string; lastName: string; company: string; profileUrl: string | null }

export async function listManualTasks(db: Db, workspaceId: string, filters: { seatKey?: string; status?: string } = {}): Promise<ManualTaskView[]> {
  const clauses = ['t.workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) { clauses.push('t.seat_key=?'); params.push(filters.seatKey); }
  if (filters.status) { clauses.push('t.status=?'); params.push(filters.status); }
  const rows = await db.prepare(`
    SELECT t.id,t.campaign_id,t.member_id,t.contact_id,t.seat_key,t.workflow_step_id,t.suggested_body,t.status,t.created_at,t.completed_at,
           l.first_name,l.last_name,l.company,l.profile_url
    FROM linkedin_manual_tasks t JOIN linkedin_lead_contacts l ON l.id=t.contact_id AND l.workspace_id=t.workspace_id
    WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC
  `).all<Record<string, unknown>>(...params);
  return rows.map((r) => ({ id: String(r.id), campaignId: String(r.campaign_id), memberId: String(r.member_id), contactId: String(r.contact_id), seatKey: String(r.seat_key), workflowStepId: String(r.workflow_step_id), suggestedBody: r.suggested_body == null ? null : String(r.suggested_body), status: String(r.status), createdAt: String(r.created_at), completedAt: r.completed_at == null ? null : String(r.completed_at), firstName: String(r.first_name), lastName: String(r.last_name), company: String(r.company), profileUrl: r.profile_url == null ? null : String(r.profile_url) }));
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
export async function completeManualTask(db: Db, workspaceId: string, taskId: string, now: Date = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    // FOR UPDATE, not an UPDATE: it takes the row lock that makes a
    // double-click one completion, without committing anything the member
    // update below might make untrue.
    const task = await tx.prepare(`SELECT member_id, campaign_id FROM linkedin_manual_tasks WHERE workspace_id=? AND id=? AND status='pending' FOR UPDATE`)
      .get<{ member_id: string; campaign_id: string }>(workspaceId, taskId);
    if (!task) return false;
    // RETURNING the NEW step_index, which is the index of the step this member
    // is about to wait for.
    const member = await tx.prepare(`UPDATE linkedin_campaign_members SET status='active',step_index=step_index+1,updated_at=? WHERE workspace_id=? AND id=? AND status='manual' RETURNING step_index`)
      .get<{ step_index: number }>(timestamp, workspaceId, task.member_id);
    if (!member) return false;
    const steps = await campaignWorkflowSteps(tx, workspaceId, task.campaign_id);
    const nextStep = steps[Number(member.step_index)];
    // No next step: due immediately, and the next tick files the member
    // 'completed' when it reads past the end of the sequence.
    const eligible = new Date(now.getTime() + (nextStep ? delayMilliseconds(nextStep.delayBefore) : 0)).toISOString();
    await tx.prepare(`UPDATE linkedin_campaign_members SET next_eligible_at=?::timestamptz WHERE workspace_id=? AND id=?`).run(eligible, workspaceId, task.member_id);
    await tx.prepare(`UPDATE linkedin_manual_tasks SET status='completed',completed_at=? WHERE workspace_id=? AND id=?`).run(timestamp, workspaceId, taskId);
    return true;
  });
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
  invitesAccepted: number;
  acceptanceRate: number | null;
  repliedLeads: number;
  contactedLeads: number;
  replyRate: number | null;
  variants: Array<{ workflowStepId: string; variantId: string; sent: number; replied: number }>;
}

export async function managedAnalytics(db: Db, workspaceId: string, filters: { campaignId?: string; seatKey?: string; sinceDays?: number } = {}): Promise<ManagedAnalytics> {
  const clauses = ['a.workspace_id=?', "a.status <> 'skipped'"];
  const params: unknown[] = [workspaceId];
  if (filters.campaignId) { clauses.push('a.campaign_id=?'); params.push(filters.campaignId); }
  if (filters.seatKey) { clauses.push('a.seat_key=?'); params.push(filters.seatKey); }
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
  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('sent','accepted','replied'))::int AS invites_sent,
      COUNT(*) FILTER (WHERE a.kind IN ('dm','reply','inmail') AND a.status IN ('sent','accepted','replied'))::int AS messages_sent,
      COUNT(*) FILTER (WHERE a.kind='profile_view' AND a.status IN ('sent','accepted','replied'))::int AS profile_views,
      COUNT(*) FILTER (WHERE a.kind='follow' AND a.status IN ('sent','accepted','replied'))::int AS follows_sent,
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status='withdrawn')::int AS invites_withdrawn,
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('accepted','replied'))::int AS invites_accepted,
      COUNT(DISTINCT a.target_ref) FILTER (WHERE a.status='replied')::int AS replied_leads,
      COUNT(DISTINCT a.target_ref) FILTER (WHERE a.kind IN ('dm','reply','inmail') AND a.status IN ('sent','accepted','replied'))::int AS contacted_leads
    FROM linkedin_actions a WHERE ${where}
  `).get<Record<string, number>>(...params);
  const invitesSent = Number(row?.invites_sent ?? 0);
  const invitesAccepted = Number(row?.invites_accepted ?? 0);
  const repliedLeads = Number(row?.replied_leads ?? 0);
  const contactedLeads = Number(row?.contacted_leads ?? 0);
  const variantParams = [...params];
  const variants = await db.prepare(`
    SELECT a.workflow_step_id,a.variant_id,
      COUNT(*) FILTER (WHERE a.status IN ('sent','accepted','replied'))::int AS sent,
      COUNT(*) FILTER (WHERE a.status='replied')::int AS replied
    FROM linkedin_actions a WHERE ${where} AND a.workflow_step_id IS NOT NULL AND a.variant_id IS NOT NULL
    GROUP BY a.workflow_step_id,a.variant_id ORDER BY a.workflow_step_id,a.variant_id
  `).all<{ workflow_step_id: string; variant_id: string; sent: number; replied: number }>(...variantParams);
  return {
    invitesSent,
    messagesSent: Number(row?.messages_sent ?? 0),
    profileViews: Number(row?.profile_views ?? 0),
    followsSent: Number(row?.follows_sent ?? 0),
    invitesWithdrawn: Number(row?.invites_withdrawn ?? 0),
    invitesAccepted,
    acceptanceRate: invitesSent === 0 ? null : invitesAccepted / invitesSent,
    repliedLeads,
    contactedLeads,
    replyRate: contactedLeads === 0 ? null : repliedLeads / contactedLeads,
    variants: variants.map((v) => ({ workflowStepId: v.workflow_step_id, variantId: v.variant_id, sent: Number(v.sent), replied: Number(v.replied) }))
  };
}
