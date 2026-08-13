import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import {
  createLinkedInManagerWorkflow,
  deleteLinkedInManagerWorkflow,
  getLinkedInManagerWorkflows,
  updateLinkedInManagerWorkflow
} from './api';
import type { LinkedInWorkflow, WorkflowStep } from '../server/linkedin/workflows';
import { errorMessage } from './LinkedInSafety';

const ACTION_LABELS: Record<WorkflowStep['action'], string> = {
  connection_request: 'Connection request',
  withdraw_pending: 'Withdraw pending invite',
  profile_view: 'Profile view',
  message: 'Message (A/B)',
  manual_message: 'Manual message checkpoint',
  follow: 'Follow'
};

function stepFor(action: WorkflowStep['action'], index: number, previous?: WorkflowStep): WorkflowStep {
  const base = { id: previous?.id ?? `step-${index + 1}`, delayBefore: previous?.delayBefore ?? { amount: index === 0 ? 0 : 1, unit: 'days' as const } };
  if (action === 'connection_request') return { ...base, action, config: { message: '' } };
  if (action === 'withdraw_pending') return { ...base, action, config: { afterDays: 14 } };
  if (action === 'profile_view') return { ...base, action, config: {} };
  if (action === 'message') return { ...base, action, config: { variants: [{ id: 'a', body: '', weight: 50 }, { id: 'b', body: '', weight: 50 }] } };
  if (action === 'manual_message') return { ...base, action, config: { suggestedTemplate: '' } };
  return { ...base, action: 'follow', config: {} };
}

export function LinkedInManagerWorkflowConfig({ onChanged, setToast }: { onChanged: () => Promise<void>; setToast: (message: string) => void }) {
  const [library, setLibrary] = useState<LinkedInWorkflow[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<WorkflowStep[]>([stepFor('connection_request', 0), stepFor('message', 1)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => setLibrary(await getLinkedInManagerWorkflows());
  useEffect(() => { void refresh().catch(() => undefined); }, []);

  const replaceStep = (index: number, next: WorkflowStep) => setSteps((current) => current.map((step, at) => at === index ? next : step));
  const reset = () => { setId(null); setName(''); setSteps([stepFor('connection_request', 0), stepFor('message', 1)]); };
  const edit = (workflow: LinkedInWorkflow) => { setId(workflow.id); setName(workflow.name); setSteps(workflow.steps); setError(''); };

  const save = async () => {
    if (!name.trim()) { setError('Give the workflow a name.'); return; }
    setBusy(true); setError('');
    try {
      const saved = id ? await updateLinkedInManagerWorkflow(id, { name: name.trim(), steps }) : await createLinkedInManagerWorkflow({ name: name.trim(), steps });
      setToast(`Workflow “${saved.name}” saved. This stored configuration and queued nothing.`);
      reset();
      await Promise.all([refresh(), onChanged()]);
    } catch (err) { setError(errorMessage(err, 'Unable to save that workflow.')); }
    finally { setBusy(false); }
  };

  const remove = async (workflow: LinkedInWorkflow) => {
    setBusy(true); setError('');
    try {
      await deleteLinkedInManagerWorkflow(workflow.id);
      if (id === workflow.id) reset();
      setToast(`Workflow “${workflow.name}” deleted.`);
      await Promise.all([refresh(), onChanged()]);
    } catch (err) { setError(errorMessage(err, 'Unable to delete that workflow.')); }
    finally { setBusy(false); }
  };

  return <section className="page-panel">
    <div className="section-heading"><div><h3 aria-level={2}>Reusable workflow builder</h3><p>Definitions are versioned and validated. Saving a workflow never creates a LinkedIn action.</p></div>{id && <button className="ghost-button" type="button" onClick={reset}>New workflow</button>}</div>
    {error && <div className="error-banner">{error}</div>}
    <label>Workflow name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Founder connect + follow-up" /></label>
    <div className="li-source-list">{steps.map((step, index) => <div className="li-source-row" key={step.id}>
      <div className="li-form-grid">
        <label>Action<select value={step.action} onChange={(event) => replaceStep(index, stepFor(event.target.value as WorkflowStep['action'], index, step))}>{Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Wait<input type="number" min={0} max={2160} value={step.delayBefore.amount} onChange={(event) => replaceStep(index, { ...step, delayBefore: { ...step.delayBefore, amount: Math.max(0, Math.trunc(Number(event.target.value) || 0)) } } as WorkflowStep)} /></label>
        <label>Unit<select value={step.delayBefore.unit} onChange={(event) => replaceStep(index, { ...step, delayBefore: { ...step.delayBefore, unit: event.target.value as 'hours' | 'days' } } as WorkflowStep)}><option value="hours">hours</option><option value="days">days</option></select></label>
      </div>
      {step.action === 'connection_request' && <label>Optional note<textarea maxLength={300} value={step.config.message ?? ''} onChange={(event) => replaceStep(index, { ...step, config: { message: event.target.value } })} placeholder="Hi {{first_name}}…" /></label>}
      {step.action === 'withdraw_pending' && <label>Withdraw after days<input type="number" min={1} max={90} value={step.config.afterDays} onChange={(event) => replaceStep(index, { ...step, config: { afterDays: Math.max(1, Math.trunc(Number(event.target.value) || 1)) } })} /></label>}
      {step.action === 'message' && <div className="li-form-grid">{step.config.variants.map((variant, variantIndex) => <label key={variant.id}>Variant {variant.id.toUpperCase()}<textarea value={variant.body} onChange={(event) => replaceStep(index, { ...step, config: { variants: step.config.variants.map((item, at) => at === variantIndex ? { ...item, body: event.target.value } : item) } })} placeholder="Hi {{first_name}}, noticed {{company}}…" /></label>)}</div>}
      {step.action === 'manual_message' && <label>Optional suggestion<textarea value={step.config.suggestedTemplate ?? ''} onChange={(event) => replaceStep(index, { ...step, config: { suggestedTemplate: event.target.value } })} placeholder="Review the thread and write a personal note." /></label>}
      <button className="ghost-button" type="button" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, at) => at !== index))}><Trash2 size={13} /> Remove step</button>
    </div>)}</div>
    <div className="panel-footer"><button className="secondary-button" type="button" onClick={() => setSteps((current) => [...current, stepFor('profile_view', current.length)])}><Plus size={14} /> Add step</button><button className="primary-button" type="button" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} {id ? 'Update workflow' : 'Save workflow'}</button></div>
    {library.length > 0 && <div className="li-table-scroll"><table className="li-table"><thead><tr><th>Workflow</th><th>Steps</th><th>Version</th><th /></tr></thead><tbody>{library.map((workflow) => <tr key={workflow.id}><td><button className="ghost-button" type="button" onClick={() => edit(workflow)}>{workflow.name}</button></td><td>{workflow.steps.length}</td><td>v{workflow.version}</td><td><button className="icon-button" type="button" title="Delete workflow" onClick={() => void remove(workflow)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>}
  </section>;
}
