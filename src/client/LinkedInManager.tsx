import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, Save, Settings2, TableProperties, Workflow } from 'lucide-react';
import {
  addManagerAccount,
  addManagerWorkflow,
  loadManagerAccounts,
  loadManagerContacts,
  loadManagerLists,
  loadManagerWorkflows,
  saveManagerAccount,
  saveManagerContact,
  type ManagerAccount,
  type ManagerContact,
  type ManagerLeadList,
  type ManagerWorkflow,
  type ManagerWorkflowStep
} from './linkedin-manager-data';

const DAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' }
];
const kinds: Array<{ value: ManagerWorkflowStep['kind']; label: string }> = [
  { value: 'invite', label: 'Connection request' },
  { value: 'withdraw', label: 'Withdraw pending invite' },
  { value: 'profile_view', label: 'Profile view' },
  { value: 'message', label: 'Message' },
  { value: 'manual_message', label: 'Manual message task' },
  { value: 'follow', label: 'Follow' }
];

type Pane = 'accounts' | 'lists' | 'workflows';
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 6 };
const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' };
const input: React.CSSProperties = { width: '100%', minHeight: 38, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', color: 'inherit' };
const button: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 36, padding: '7px 11px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer' };

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function AccountPane({ accounts, reload }: { accounts: ManagerAccount[]; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState(accounts[0]?.seatKey ?? '');
  const account = accounts.find((item) => item.seatKey === selected) ?? accounts[0] ?? null;
  const [draft, setDraft] = useState<ManagerAccount | null>(account);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newSeat, setNewSeat] = useState({ seatKey: '', label: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', profileUrl: '' });

  useEffect(() => setDraft(account), [account?.seatKey]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      await saveManagerAccount(draft.seatKey, {
        label: draft.label,
        timezone: draft.timezone,
        workingDays: draft.workingDays,
        workingStart: draft.workingStart,
        workingEnd: draft.workingEnd,
        operatorLimits: draft.operatorLimits
      });
      await reload();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function add() {
    setBusy(true); setError('');
    try {
      const created = await addManagerAccount({ ...newSeat, profileUrl: newSeat.profileUrl.trim() || null });
      setSelected(created.seatKey);
      setNewSeat({ seatKey: '', label: '', timezone: newSeat.timezone, profileUrl: '' });
      await reload();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <div><strong>LinkedIn accounts</strong><div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Each account owns its own schedule, ledger and limits.</div></div>
        {accounts.length > 0 && <select value={account?.seatKey ?? ''} onChange={(event) => setSelected(event.target.value)} style={input}>{accounts.map((item) => <option key={item.seatKey} value={item.seatKey}>{item.label}</option>)}</select>}
      </div>
      {draft ? <>
        <div style={grid}>
          <label style={field}><span style={label}>Label</span><input style={input} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
          <label style={field}><span style={label}>Timezone</span><input style={input} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></label>
          <label style={field}><span style={label}>Start</span><input style={input} type="time" value={draft.workingStart} onChange={(e) => setDraft({ ...draft, workingStart: e.target.value })} /></label>
          <label style={field}><span style={label}>End</span><input style={input} type="time" value={draft.workingEnd} onChange={(e) => setDraft({ ...draft, workingEnd: e.target.value })} /></label>
        </div>
        <div style={{ marginTop: 14 }}><div style={label}>Working days</div><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 7 }}>{DAYS.map((day) => <label key={day.value} style={{ ...button, background: draft.workingDays.includes(day.value) ? 'var(--surface-raised)' : 'transparent' }}><input type="checkbox" checked={draft.workingDays.includes(day.value)} onChange={(e) => setDraft({ ...draft, workingDays: e.target.checked ? [...draft.workingDays, day.value] : draft.workingDays.filter((value) => value !== day.value) })} />{day.label}</label>)}</div></div>
        <div style={{ ...grid, marginTop: 14 }}>
          {([['invite','Invites / 24h'],['message','Messages / 24h'],['profile_view','Profile views / 24h'],['follow','Follows / 24h']] as const).map(([key, text]) => <label key={key} style={field}><span style={label}>{text}</span><input style={input} type="number" min={0} value={draft.operatorLimits[key]} onChange={(e) => setDraft({ ...draft, operatorLimits: { ...draft.operatorLimits, [key]: Number(e.target.value) } })} /></label>)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button style={button} disabled={busy} onClick={() => void save()}><Save size={15} />Save account policy</button></div>
      </> : <div style={{ color: 'var(--text-muted)' }}>No account configured yet.</div>}
    </div>

    <div style={card}>
      <strong>Add account</strong>
      <div style={{ ...grid, marginTop: 12 }}>
        <label style={field}><span style={label}>Seat key</span><input style={input} placeholder="founder" value={newSeat.seatKey} onChange={(e) => setNewSeat({ ...newSeat, seatKey: e.target.value })} /></label>
        <label style={field}><span style={label}>Label</span><input style={input} placeholder="Founder account" value={newSeat.label} onChange={(e) => setNewSeat({ ...newSeat, label: e.target.value })} /></label>
        <label style={field}><span style={label}>Timezone</span><input style={input} value={newSeat.timezone} onChange={(e) => setNewSeat({ ...newSeat, timezone: e.target.value })} /></label>
        <label style={field}><span style={label}>Profile URL (optional)</span><input style={input} value={newSeat.profileUrl} onChange={(e) => setNewSeat({ ...newSeat, profileUrl: e.target.value })} /></label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button style={button} disabled={busy || !newSeat.seatKey.trim() || !newSeat.label.trim()} onClick={() => void add()}><Plus size={15} />Add account</button></div>
    </div>
    {error && <div style={{ ...card, borderColor: 'var(--danger)' }}><CircleAlert size={16} /> {error}</div>}
  </div>;
}

function ListsPane({ lists }: { lists: ManagerLeadList[] }) {
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [contacts, setContacts] = useState<ManagerContact[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<ManagerContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!listId) { setContacts([]); return; }
    setBusy(true); setError('');
    void loadManagerContacts(listId).then((rows) => { setContacts(rows); setSelected(rows[0]?.id ?? ''); }).catch((cause) => setError(messageOf(cause))).finally(() => setBusy(false));
  }, [listId]);
  useEffect(() => setDraft(contacts.find((item) => item.id === selected) ?? null), [selected, contacts]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const updated = await saveManagerContact(draft.id, { firstName: draft.firstName, lastName: draft.lastName, company: draft.company, email: draft.email, country: draft.country, linkedinUrl: draft.linkedinUrl });
      setContacts((rows) => rows.map((row) => row.id === updated.id ? updated : row));
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><div><strong>Canonical lead lists</strong><div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Review the normalized fields campaigns depend on.</div></div><select style={input} value={listId} onChange={(e) => setListId(e.target.value)}><option value="">Choose list</option>{lists.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.count}</option>)}</select></div>
    </div>
    {busy && <div style={card}><LoaderCircle size={17} /> Loading…</div>}
    {!busy && contacts.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, .8fr) minmax(300px, 1.2fr)', gap: 16 }}>
      <div style={card}>{contacts.map((contact) => <button key={contact.id} onClick={() => setSelected(contact.id)} style={{ ...button, width: '100%', justifyContent: 'space-between', marginBottom: 6, background: selected === contact.id ? 'var(--surface-raised)' : 'transparent' }}><span>{contact.firstName || '—'} {contact.lastName || ''}</span><small>{contact.company || 'Missing company'}</small></button>)}</div>
      {draft && <div style={card}><div style={grid}>{([['firstName','First name'],['lastName','Last name'],['company','Company'],['email','Email'],['country','Country'],['linkedinUrl','LinkedIn URL']] as const).map(([key, text]) => <label key={key} style={field}><span style={label}>{text}</span><input style={input} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value || null })} /></label>)}</div><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button style={button} disabled={busy} onClick={() => void save()}><Save size={15} />Save contact</button></div></div>}
    </div>}
    {!busy && listId && contacts.length === 0 && <div style={card}>This list has no contacts.</div>}
    {error && <div style={{ ...card, borderColor: 'var(--danger)' }}><CircleAlert size={16} /> {error}</div>}
  </div>;
}

function blankStep(index: number): ManagerWorkflowStep { return { id: `step-${index + 1}`, kind: 'profile_view', delay: { amount: index === 0 ? 0 : 1, unit: 'days' }, config: {} }; }

function WorkflowPane({ workflows, reload }: { workflows: ManagerWorkflow[]; reload: () => Promise<void> }) {
  const [name, setName] = useState('Founder outreach');
  const [steps, setSteps] = useState<ManagerWorkflowStep[]>([blankStep(0)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function setStep(index: number, next: ManagerWorkflowStep) { setSteps((rows) => rows.map((row, i) => i === index ? next : row)); }
  async function create() {
    setBusy(true); setError('');
    try {
      await addManagerWorkflow(name, { version: 1, steps });
      setName('Founder outreach'); setSteps([blankStep(0)]); await reload();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return <div style={{ display: 'grid', gap: 16 }}>
    <div style={card}>
      <strong>Reusable workflows</strong>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 3 }}>Variables: {'{{firstName}}'}, {'{{lastName}}'}, {'{{company}}'}. Delays are relative to the previous completed step.</div>
      <label style={{ ...field, marginTop: 12 }}><span style={label}>Workflow name</span><input style={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>{steps.map((step, index) => <div key={`${step.id}-${index}`} style={card}>
        <div style={grid}>
          <label style={field}><span style={label}>Step id</span><input style={input} value={step.id} onChange={(e) => setStep(index, { ...step, id: e.target.value })} /></label>
          <label style={field}><span style={label}>Action</span><select style={input} value={step.kind} onChange={(e) => setStep(index, { ...blankStep(index), id: step.id, delay: step.delay, kind: e.target.value as ManagerWorkflowStep['kind'] })}>{kinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label style={field}><span style={label}>Delay</span><input style={input} type="number" min={0} value={step.delay.amount} onChange={(e) => setStep(index, { ...step, delay: { ...step.delay, amount: Number(e.target.value) } })} /></label>
          <label style={field}><span style={label}>Unit</span><select style={input} value={step.delay.unit} onChange={(e) => setStep(index, { ...step, delay: { ...step.delay, unit: e.target.value as 'hours' | 'days' } })}><option value="hours">hours</option><option value="days">days</option></select></label>
        </div>
        {step.kind === 'invite' && <label style={{ ...field, marginTop: 10 }}><span style={label}>Invite note</span><textarea style={input} rows={3} value={String((step.config as { note?: unknown }).note ?? '')} onChange={(e) => setStep(index, { ...step, config: { note: e.target.value } })} /></label>}
        {step.kind === 'withdraw' && <label style={{ ...field, marginTop: 10 }}><span style={label}>Withdraw if still pending after days</span><input style={input} type="number" min={1} value={Number((step.config as { olderThanDays?: unknown }).olderThanDays ?? 14)} onChange={(e) => setStep(index, { ...step, config: { olderThanDays: Number(e.target.value) } })} /></label>}
        {step.kind === 'message' && <div style={{ marginTop: 10 }}><label style={field}><span style={label}>Variant A message</span><textarea style={input} rows={4} value={String(((step.config as { variants?: Array<{ body?: string }> }).variants)?.[0]?.body ?? '')} onChange={(e) => setStep(index, { ...step, config: { variants: [{ id: 'A', body: e.target.value, weight: 100 }], requireConnection: true } })} /></label><small style={{ color: 'var(--text-muted)' }}>The server validates persisted variants and requires weights to total 100.</small></div>}
        {step.kind === 'manual_message' && <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 10 }}>Manual-message steps require a validated message/task config. This client does not create an incomplete manual task definition.</div>}
      </div>)}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 12 }}><button style={button} onClick={() => setSteps((rows) => [...rows, blankStep(rows.length)])}><Plus size={15} />Add step</button><button style={button} disabled={busy || !name.trim()} onClick={() => void create()}><Save size={15} />Save workflow</button></div>
    </div>
    <div style={card}><strong>Saved workflows</strong><div style={{ display: 'grid', gap: 8, marginTop: 10 }}>{workflows.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>No reusable workflow saved yet.</span> : workflows.map((workflow) => <div key={workflow.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}><span><strong>{workflow.name}</strong><br /><small>{workflow.definition.steps.length} steps</small></span><small>{workflow.status}</small></div>)}</div></div>
    {error && <div style={{ ...card, borderColor: 'var(--danger)' }}><CircleAlert size={16} /> {error}</div>}
  </div>;
}

export function LinkedInManager() {
  const [pane, setPane] = useState<Pane>('accounts');
  const [accounts, setAccounts] = useState<ManagerAccount[]>([]);
  const [lists, setLists] = useState<ManagerLeadList[]>([]);
  const [workflows, setWorkflows] = useState<ManagerWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function reload() {
    setLoading(true); setError('');
    try {
      const [nextAccounts, nextLists, nextWorkflows] = await Promise.all([loadManagerAccounts(), loadManagerLists(), loadManagerWorkflows()]);
      setAccounts(nextAccounts); setLists(nextLists); setWorkflows(nextWorkflows);
    } catch (cause) { setError(messageOf(cause)); } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);

  const panes = useMemo(() => [
    { id: 'accounts' as const, label: 'Accounts & limits', Icon: Settings2 },
    { id: 'lists' as const, label: `Lead lists${lists.length ? ` · ${lists.length}` : ''}`, Icon: TableProperties },
    { id: 'workflows' as const, label: `Workflows${workflows.length ? ` · ${workflows.length}` : ''}`, Icon: Workflow }
  ], [lists.length, workflows.length]);

  return <div className="page-stack">
    <section className="page-panel">
      <div className="panel-heading"><div><span className="eyebrow">LinkedIn outreach manager</span><h2>Accounts, lead data, and reusable workflows</h2><p>Configure account-level safety, review canonical lead fields, and build workflows without creating a second send path around Trevra's existing approval and worker gates.</p></div></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>{panes.map(({ id, label: text, Icon }) => <button key={id} style={{ ...button, background: pane === id ? 'var(--surface-raised)' : 'transparent' }} onClick={() => setPane(id)}><Icon size={15} />{text}</button>)}</div>
    </section>
    {loading ? <section className="page-panel"><LoaderCircle size={18} /> Loading manager state…</section> : error ? <section className="page-panel"><CircleAlert size={18} /> {error}<button style={{ ...button, marginLeft: 10 }} onClick={() => void reload()}>Retry</button></section> : <>
      {pane === 'accounts' && <AccountPane accounts={accounts} reload={reload} />}
      {pane === 'lists' && <ListsPane lists={lists} />}
      {pane === 'workflows' && <WorkflowPane workflows={workflows} reload={reload} />}
    </>}
  </div>;
}
