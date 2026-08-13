import { useCallback, useEffect, useState } from 'react';
import { BarChart3, ClipboardList, LoaderCircle, RefreshCw, Users, Workflow as WorkflowIcon } from 'lucide-react';
import {
  getLinkedInManagedAnalytics,
  getLinkedInManagedCampaign,
  getLinkedInManagedCampaigns,
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  getLinkedInManualTasks,
  pauseLinkedInManagedMember,
  removeLinkedInManagedMember,
  stopLinkedInManagedCampaign
} from './api';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { LinkedInWorkflow } from '../server/linkedin/workflows';
import type { ManagedAnalytics, ManagedCampaign, ManagedCampaignMember, ManualTaskView } from '../server/linkedin/managed-campaigns';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import { LinkedInManagerLeadConfig } from './LinkedInManagerLeadConfig';
import { LinkedInManagerWorkflowConfig } from './LinkedInManagerWorkflowConfig';
import { LinkedInManagerCampaignConfig } from './LinkedInManagerCampaignConfig';

const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const SOURCE_LABELS: Record<LinkedInLeadList['sourceKind'], string> = {
  csv: 'CSV',
  linkedin_search: 'LinkedIn people search',
  sales_navigator: 'Sales Navigator',
  post_keyword: 'Post/comment keywords'
};

export function OutreachManagerRead({ setToast: _setToast }: { setToast: (message: string) => void }) {
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [campaigns, setCampaigns] = useState<ManagedCampaign[]>([]);
  const [tasks, setTasks] = useState<ManualTaskView[]>([]);
  const [analytics, setAnalytics] = useState<ManagedAnalytics | null>(null);
  const [openCampaignId, setOpenCampaignId] = useState('');
  const [members, setMembers] = useState<ManagedCampaignMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSeats, nextLists, nextWorkflows, nextCampaigns, nextTasks, nextAnalytics] = await Promise.all([
        getLinkedInManagerSeats(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagerWorkflows(),
        getLinkedInManagedCampaigns(),
        getLinkedInManualTasks(),
        getLinkedInManagedAnalytics()
      ]);
      setSeats(nextSeats);
      setLists(nextLists);
      setWorkflows(nextWorkflows);
      setCampaigns(nextCampaigns);
      setTasks(nextTasks);
      setAnalytics(nextAnalytics);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read Outreach Manager. Nothing was changed.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useOutreachRefresh(load);

  const openCampaign = async (campaignId: string) => {
    setOpenCampaignId(campaignId);
    try { setMembers((await getLinkedInManagedCampaign(campaignId)).members); }
    catch (err) { setError(errorMessage(err, 'Unable to read managed campaign members.')); }
  };

  const stopCampaign = async (campaign: ManagedCampaign) => {
    try {
      await stopLinkedInManagedCampaign(campaign.id);
      _setToast(`Campaign “${campaign.name}” stopped. Pending manager state and unclaimed planned rows were cancelled.`);
      setMembers([]); setOpenCampaignId(''); await load();
    } catch (err) { setError(errorMessage(err, 'Unable to stop that managed campaign.')); }
  };

  const pauseMember = async (member: ManagedCampaignMember) => {
    try {
      await pauseLinkedInManagedMember(member.id);
      _setToast(`${member.firstName} ${member.lastName} paused in this campaign.`);
      await openCampaign(member.campaignId); await load();
    } catch (err) { setError(errorMessage(err, 'Unable to pause that campaign member.')); }
  };

  const removeMember = async (member: ManagedCampaignMember) => {
    try {
      await removeLinkedInManagedMember(member.id);
      _setToast(`${member.firstName} ${member.lastName} removed from this campaign; their one-campaign claim is released.`);
      await openCampaign(member.campaignId); await load();
    } catch (err) { setError(errorMessage(err, 'Unable to remove that campaign member.')); }
  };

  return <div className="page-stack">
    {error && <div className="error-banner">{error}</div>}

    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Outreach Manager</h3>
          <p>Persistent lists, reusable workflow definitions, campaign membership, manual checkpoints and outcomes. The existing LinkedIn ledger remains the only execution boundary.</p>
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      <div className="li-stat-row">
        <div><span>LinkedIn accounts</span><strong>{seats.length}</strong></div>
        <div><span>Lead lists</span><strong>{lists.length}</strong></div>
        <div><span>Workflows</span><strong>{workflows.length}</strong></div>
        <div><span>Managed campaigns</span><strong>{campaigns.length}</strong></div>
        <div><span>Pending manual tasks</span><strong>{tasks.filter((task) => task.status === 'pending').length}</strong></div>
      </div>
      <div className="panel-footer">
        <span>Account working days/hours and daily ceilings are configured on <b>Setup → LinkedIn seat</b> and enforced again at execution time.</span>
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}>LinkedIn accounts</h3><p>Each configured seat has its own timezone, working window and account-level ceilings. Non-owner execution remains fail-closed rather than borrowing the owner session.</p></div></div>
      {seats.length === 0 ? <p className="empty-copy">No LinkedIn account is configured.</p> : <div className="li-table-scroll"><table className="li-table"><thead><tr><th>Account</th><th>Timezone</th><th>Working days</th><th>Window</th><th>Operator ceilings</th></tr></thead><tbody>{seats.map((seat) => <tr key={seat.seatKey}><td><strong>{seat.label}</strong><br /><code>{seat.seatKey}</code></td><td>{seat.timezone}</td><td>{seat.workingDays.join(', ') || 'disabled'}</td><td>{`${String(Math.floor(seat.workStartMinute / 60)).padStart(2, '0')}:${String(seat.workStartMinute % 60).padStart(2, '0')}`}–{`${String(Math.floor(seat.workEndMinute / 60)).padStart(2, '0')}:${String(seat.workEndMinute % 60).padStart(2, '0')}`}</td><td>{seat.dailyInviteLimit} invites · {seat.dailyMessageLimit} messages · {seat.dailyProfileViewLimit} views · {seat.dailyFollowLimit} follows</td></tr>)}</tbody></table></div>}
    </section>

    <LinkedInManagerLeadConfig onChanged={load} setToast={_setToast} />

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}><Users size={18} /> Persistent lead lists</h3><p>Normalized first name, last name, company and optional contact fields live here; source provenance stays attached to each list.</p></div></div>
      {lists.length === 0 ? <p className="empty-copy">No persistent lead list has been created yet.</p> : <div className="li-table-scroll">
        <table className="li-table"><thead><tr><th>List</th><th>Source</th><th>Leads</th><th>Updated</th></tr></thead><tbody>
          {lists.map((list) => <tr key={list.id}><td>{list.name}</td><td>{SOURCE_LABELS[list.sourceKind]}</td><td>{list.leadCount}</td><td>{new Date(list.updatedAt).toLocaleString()}</td></tr>)}
        </tbody></table>
      </div>}
    </section>

    <LinkedInManagerWorkflowConfig onChanged={load} setToast={_setToast} />

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}><WorkflowIcon size={18} /> Reusable workflows</h3><p>Stored definitions are versioned and server-validated before a managed campaign may reference them.</p></div></div>
      {workflows.length === 0 ? <p className="empty-copy">No reusable workflow has been saved yet.</p> : <div className="li-table-scroll">
        <table className="li-table"><thead><tr><th>Workflow</th><th>Steps</th><th>Version</th><th>Updated</th></tr></thead><tbody>
          {workflows.map((workflow) => <tr key={workflow.id}><td>{workflow.name}</td><td>{workflow.steps.length}</td><td>v{workflow.version}</td><td>{new Date(workflow.updatedAt).toLocaleString()}</td></tr>)}
        </tbody></table>
      </div>}
    </section>

    <LinkedInManagerCampaignConfig onChanged={load} setToast={_setToast} />

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}><ClipboardList size={18} /> Managed campaigns</h3><p>Each row binds one account, one persistent lead list and one reusable workflow. Membership enforces one active campaign per lead at the database level.</p></div></div>
      {campaigns.length === 0 ? <p className="empty-copy">No managed campaign draft exists yet.</p> : <div className="li-table-scroll">
        <table className="li-table"><thead><tr><th>Campaign</th><th>Status</th><th>Seat</th><th>Members</th><th>Active claim</th><th /></tr></thead><tbody>
          {campaigns.map((campaign) => <tr key={campaign.id}><td><button className="ghost-button" type="button" onClick={() => void openCampaign(campaign.id)}>{campaign.name}</button></td><td><span className="li-chip">{campaign.status}</span></td><td>{campaign.seatKey}</td><td>{campaign.memberCount}</td><td>{campaign.activeCount}</td><td>{campaign.status !== 'stopped' && <button className="ghost-button danger" type="button" onClick={() => void stopCampaign(campaign)}>Stop</button>}</td></tr>)}
        </tbody></table>
      </div>}
      {openCampaignId && <div className="li-table-scroll"><h4 aria-level={3}>Campaign members</h4>{members.length === 0 ? <p className="empty-copy">No member in this campaign.</p> : <table className="li-table"><thead><tr><th>Lead</th><th>Company</th><th>Status</th><th>Step</th><th>Next eligible</th><th /></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td>{member.firstName} {member.lastName}</td><td>{member.company}</td><td><span className="li-chip">{member.status}</span></td><td>{member.stepIndex + 1}</td><td>{member.nextEligibleAt ? new Date(member.nextEligibleAt).toLocaleString() : '—'}</td><td>{['pending','active','waiting','manual'].includes(member.status) && <button className="ghost-button" type="button" onClick={() => void pauseMember(member)}>Pause</button>} {['pending','active','waiting','manual','paused'].includes(member.status) && <button className="ghost-button danger" type="button" onClick={() => void removeMember(member)}>Remove</button>}</td></tr>)}</tbody></table>}</div>}
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}><BarChart3 size={18} /> Outcomes</h3><p>Acceptance and reply rates are derived from the same immutable action ledger used by the rest of Outreach.</p></div></div>
      <div className="li-stat-row">
        <div><span>Invites sent</span><strong>{analytics?.invitesSent ?? 0}</strong></div>
        <div><span>Accepted</span><strong>{analytics?.invitesAccepted ?? 0} · {percent(analytics?.acceptanceRate ?? null)}</strong></div>
        <div><span>Messages sent</span><strong>{analytics?.messagesSent ?? 0}</strong></div>
        <div><span>Replies</span><strong>{analytics?.repliedLeads ?? 0} · {percent(analytics?.replyRate ?? null)}</strong></div>
        <div><span>Profile views</span><strong>{analytics?.profileViews ?? 0}</strong></div>
      </div>
      {analytics?.variants.length ? <div className="li-table-scroll"><table className="li-table"><thead><tr><th>Workflow step</th><th>Variant</th><th>Sent</th><th>Replies</th></tr></thead><tbody>{analytics.variants.map((variant) => <tr key={`${variant.workflowStepId}:${variant.variantId}`}><td>{variant.workflowStepId}</td><td>{variant.variantId}</td><td>{variant.sent}</td><td>{variant.replied}</td></tr>)}</tbody></table></div> : <p className="empty-copy">No A/B-attributed outcome has been recorded yet.</p>}
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}>Manual-message tasks</h3><p>These are human checkpoints. A task may exist in campaign state without creating a second outbound queue.</p></div></div>
      {tasks.length === 0 ? <p className="empty-copy">No manual-message task has been created yet.</p> : <div className="li-table-scroll"><table className="li-table"><thead><tr><th>Lead</th><th>Company</th><th>Status</th><th>Campaign</th><th>Created</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td>{task.firstName} {task.lastName}</td><td>{task.company}</td><td><span className="li-chip">{task.status}</span></td><td>{task.campaignId}</td><td>{new Date(task.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
