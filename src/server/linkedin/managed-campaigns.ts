import { id, type Db } from '../db.js';
import { getLeadList } from './lead-lists.js';
import { getSeat, OWNER_SEAT_KEY } from './seats.js';
import { delayMilliseconds, getWorkflow, type WorkflowStep } from './workflows.js';

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

interface CampaignRow { id: string; workspace_id: string; name: string; status: string; seat_key: string; lead_list_id: string; workflow_id: string; started_at: string | null; paused_at: string | null; member_count: number; active_count: number; created_at: string; updated_at: string }
interface MemberRow { id: string; campaign_id: string; contact_id: string; status: string; step_index: number; next_eligible_at: string | null; assigned_variants: unknown; last_action_id: string | null; first_name: string; last_name: string; company: string; profile_url: string | null }

const ACTIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;
const CAMPAIGN_SELECT = `
  c.id,c.workspace_id,c.name,c.status,c.seat_key,c.lead_list_id,c.workflow_id,c.started_at,c.paused_at,c.created_at,c.updated_at,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id) AS member_count,
  (SELECT COUNT(*)::int FROM linkedin_campaign_members m WHERE m.campaign_id=c.id AND m.status = ANY(ARRAY['pending','active','waiting','manual','paused'])) AS active_count
`;

function toCampaign(row: CampaignRow): ManagedCampaign {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, status: row.status as ManagedCampaignStatus, seatKey: row.seat_key, leadListId: row.lead_list_id, workflowId: row.workflow_id, startedAt: row.started_at, pausedAt: row.paused_at, memberCount: Number(row.member_count), activeCount: Number(row.active_count), createdAt: row.created_at, updatedAt: row.updated_at };
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
    const count = await tx.prepare('SELECT COUNT(*)::int AS total FROM linkedin_lead_contacts WHERE workspace_id=? AND list_id=?').get<{ total: number }>(input.workspaceId, list.id);
    total = count?.total ?? 0;
    const inserted = await tx.prepare(`
      INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,assigned_variants,created_at,updated_at)
      SELECT 'limem_' || md5(? || ':' || c.id), ?, ?, c.id, 'pending', 0, '{}'::jsonb, ?, ?
      FROM linkedin_lead_contacts c WHERE c.workspace_id=? AND c.list_id=?
      ON CONFLICT DO NOTHING RETURNING id
    `).all<{ id: string }>(campaignId, input.workspaceId, campaignId, timestamp, timestamp, input.workspaceId, list.id);
    enrolled = inserted.length;
  });
  const campaign = await getManagedCampaign(db, input.workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign could not be created.');
  return { campaign, enrolled, skippedAlreadyActive: Math.max(0, total - enrolled) };
}

function firstEligibleAt(steps: WorkflowStep[], now: Date): string | null {
  if (steps.length === 0) return null;
  return new Date(now.getTime() + delayMilliseconds(steps[0].delayBefore)).toISOString();
}

export async function startManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const campaign = await getManagedCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (campaign.status === 'stopped' || campaign.status === 'completed') throw new Error(`A ${campaign.status} campaign cannot be started again.`);
  const workflow = await getWorkflow(db, workspaceId, campaign.workflowId);
  if (!workflow) throw new Error('Campaign workflow no longer exists.');
  const timestamp = now.toISOString();
  const eligible = firstEligibleAt(workflow.steps, now);
  await db.transaction(async (tx) => {
    await tx.prepare(`UPDATE linkedin_campaigns SET status='running',started_at=COALESCE(started_at,?),paused_at=NULL,updated_at=? WHERE workspace_id=? AND id=?`).run(timestamp, timestamp, workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_campaign_members SET status='active',next_eligible_at=COALESCE(next_eligible_at,?::timestamptz),updated_at=? WHERE workspace_id=? AND campaign_id=? AND status='pending'`).run(eligible, timestamp, workspaceId, campaignId);
  });
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function pauseManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  const result = await db.prepare(`UPDATE linkedin_campaigns SET status='paused',paused_at=?,updated_at=? WHERE workspace_id=? AND id=? AND status='running'`).run(timestamp, timestamp, workspaceId, campaignId);
  if (!result.changes) throw new Error('Only a running campaign can be paused.');
  return (await getManagedCampaign(db, workspaceId, campaignId)) as ManagedCampaign;
}

export async function stopManagedCampaign(db: Db, workspaceId: string, campaignId: string, now: Date = new Date()): Promise<ManagedCampaign> {
  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`UPDATE linkedin_campaigns SET status='stopped',stop_requested_at=COALESCE(stop_requested_at,?::timestamptz),updated_at=? WHERE workspace_id=? AND id=?`).run(timestamp, timestamp, workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,updated_at=? WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])`).run(timestamp, workspaceId, campaignId, [...ACTIVE_MEMBER_STATUSES]);
    await tx.prepare(`UPDATE linkedin_manual_tasks SET status='cancelled' WHERE workspace_id=? AND campaign_id=? AND status='pending'`).run(workspaceId, campaignId);
    await tx.prepare(`UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL`).run(workspaceId, campaignId);
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
    await tx.prepare(`UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_member_id=? AND status='planned' AND claimed_at IS NULL`).run(workspaceId, memberId);
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

/** Completes the human checkpoint only; sending the message remains the inbox/ledger's job. */
export async function completeManualTask(db: Db, workspaceId: string, taskId: string, now: Date = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const task = await tx.prepare(`UPDATE linkedin_manual_tasks SET status='completed',completed_at=? WHERE workspace_id=? AND id=? AND status='pending' RETURNING member_id`).get<{ member_id: string }>(timestamp, workspaceId, taskId);
    if (!task) return false;
    await tx.prepare(`UPDATE linkedin_campaign_members SET status='active',step_index=step_index+1,next_eligible_at=?::timestamptz,updated_at=? WHERE workspace_id=? AND id=? AND status='manual'`).run(timestamp, timestamp, workspaceId, task.member_id);
    return true;
  });
}

export interface ManagedAnalytics {
  invitesSent: number;
  messagesSent: number;
  profileViews: number;
  invitesAccepted: number;
  acceptanceRate: number | null;
  repliedLeads: number;
  contactedLeads: number;
  replyRate: number | null;
  variants: Array<{ workflowStepId: string; variantId: string; sent: number; replied: number }>;
}

export async function managedAnalytics(db: Db, workspaceId: string, filters: { campaignId?: string; seatKey?: string } = {}): Promise<ManagedAnalytics> {
  const clauses = ['a.workspace_id=?', "a.status <> 'skipped'"];
  const params: unknown[] = [workspaceId];
  if (filters.campaignId) { clauses.push('a.campaign_id=?'); params.push(filters.campaignId); }
  if (filters.seatKey) { clauses.push('a.seat_key=?'); params.push(filters.seatKey); }
  const where = clauses.join(' AND ');
  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE a.kind='invite' AND a.status IN ('sent','accepted','replied'))::int AS invites_sent,
      COUNT(*) FILTER (WHERE a.kind IN ('dm','reply','inmail') AND a.status IN ('sent','accepted','replied'))::int AS messages_sent,
      COUNT(*) FILTER (WHERE a.kind='profile_view' AND a.status IN ('sent','accepted','replied'))::int AS profile_views,
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
    invitesAccepted,
    acceptanceRate: invitesSent === 0 ? null : invitesAccepted / invitesSent,
    repliedLeads,
    contactedLeads,
    replyRate: contactedLeads === 0 ? null : repliedLeads / contactedLeads,
    variants: variants.map((v) => ({ workflowStepId: v.workflow_step_id, variantId: v.variant_id, sent: Number(v.sent), replied: Number(v.replied) }))
  };
}
