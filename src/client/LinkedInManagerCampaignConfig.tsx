import { useEffect, useState } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import {
  createLinkedInManagedCampaign,
  getLinkedInManagerLeadLists,
  getLinkedInManagerWorkflows
} from './api';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { LinkedInWorkflow } from '../server/linkedin/workflows';
import { errorMessage } from './LinkedInSafety';

export function LinkedInManagerCampaignConfig({ onChanged, setToast }: { onChanged: () => Promise<void>; setToast: (message: string) => void }) {
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [name, setName] = useState('');
  const [listId, setListId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshOptions = async () => {
    const [nextLists, nextWorkflows] = await Promise.all([getLinkedInManagerLeadLists(), getLinkedInManagerWorkflows()]);
    setLists(nextLists);
    setWorkflows(nextWorkflows);
    setListId((current) => current || nextLists[0]?.id || '');
    setWorkflowId((current) => current || nextWorkflows[0]?.id || '');
  };
  useEffect(() => { void refreshOptions().catch(() => undefined); }, []);

  const create = async () => {
    if (!name.trim() || !listId || !workflowId) return;
    setBusy(true); setError('');
    try {
      const result = await createLinkedInManagedCampaign({ name: name.trim(), leadListId: listId, workflowId });
      setName('');
      setToast(`Campaign draft created: ${result.enrolled} lead(s) enrolled${result.skippedAlreadyActive ? `, ${result.skippedAlreadyActive} already claimed by another active campaign` : ''}. No action was queued.`);
      await Promise.all([refreshOptions(), onChanged()]);
    } catch (err) { setError(errorMessage(err, 'Unable to create that campaign draft.')); }
    finally { setBusy(false); }
  };

  return <section className="page-panel">
    <div className="section-heading"><div><h3 aria-level={2}>Create a managed campaign draft</h3><p>One persistent lead list + one reusable workflow. Enrollment takes the database-level one-active-campaign claim; creating the draft queues nothing.</p></div></div>
    {error && <div className="error-banner">{error}</div>}
    <div className="li-form-grid">
      <label>Campaign name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Q3 founder outreach" /></label>
      <label>Lead list<select value={listId} onChange={(event) => setListId(event.target.value)}><option value="">Choose a list</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.leadCount})</option>)}</select></label>
      <label>Workflow<select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}><option value="">Choose a workflow</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
    </div>
    <div className="panel-footer"><span>Paused members keep their one-campaign claim; only terminal removal/reply/completion/failure releases it.</span><button className="primary-button" type="button" disabled={busy || !name.trim() || !listId || !workflowId} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create draft</button></div>
  </section>;
}
