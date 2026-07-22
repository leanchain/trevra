import { useEffect, useMemo, useState } from 'react';
import Nango from '@nangohq/frontend';
import {
  ArrowUpRight,
  Bell,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileUp,
  FileWarning,
  Inbox,
  Link2,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  Users,
  X,
  Zap
} from 'lucide-react';
import type {
  AutomationRule,
  AvailableIntegration,
  DashboardPayload,
  PreparedAction,
  Recommendation,
  RecommendationType
} from '../shared/types';
import {
  approveAction,
  createConnectSession,
  ApiError,
  disconnectIntegration,
  dismissRecommendation,
  endDemoSession,
  ensureSession,
  executeAction,
  getDashboard,
  getPublicConfig,
  importCommercialDocument,
  importMarketplace,
  prepareRecommendation,
  runAutomation,
  snoozeRecommendation,
  startDemoSession,
  syncIntegration,
  updateAutomationRule
} from './api';
import { authClient } from './auth-client';

type View = 'today' | 'clients' | 'integrations' | 'autopilot';

const money = (amount: number, currency = 'EUR') => new Intl.NumberFormat('en-CH', {
  style: 'currency', currency, maximumFractionDigits: 0
}).format(amount);

const recommendationLabels: Record<RecommendationType, string> = {
  stale_proposal: 'Proposal follow-up',
  scope_creep: 'Scope protection',
  unbilled_milestone: 'Ready to invoice',
  overdue_invoice: 'Payment collection'
};

export function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [activeView, setActiveView] = useState<View>('today');
  const [activeAction, setActiveAction] = useState<PreparedAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const load = async () => {
    try {
      setError('');
      await ensureSession();
      setData(await getDashboard());
      setNeedsAuth(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setData(null);
        setNeedsAuth(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load Trevra');
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const today = useMemo(() => new Intl.DateTimeFormat('en-CH', {
    weekday: 'long', month: 'long', day: 'numeric'
  }).format(new Date()), []);

  const prepare = async (recommendation: Recommendation) => {
    setBusyId(recommendation.id);
    try {
      const action = recommendation.preparedAction ?? await prepareRecommendation(recommendation.id);
      setActiveAction(action);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to prepare action');
    } finally { setBusyId(null); }
  };

  const snooze = async (id: string) => {
    setBusyId(id);
    try {
      await snoozeRecommendation(id);
      await load();
      setToast('Snoozed for 3 days');
    } finally { setBusyId(null); }
  };

  const dismiss = async (id: string) => {
    setBusyId(id);
    try {
      await dismissRecommendation(id, 'Not useful right now');
      await load();
    } finally { setBusyId(null); }
  };

  const signOut = async () => {
    await Promise.allSettled([authClient.signOut(), endDemoSession()]);
    setData(null);
    setNeedsAuth(true);
  };

  const execute = async () => {
    if (!activeAction) return;
    setBusyId(activeAction.id);
    try {
      const approved = await approveAction(activeAction.id, activeAction);
      if (approved.status === 'scheduled') {
        setActiveAction(null);
        await load();
        setToast('Action approved and scheduled');
      } else {
        await executeAction(approved.id);
        setActiveAction(null);
        await load();
        setToast('Trevra completed the action');
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to execute action');
    } finally { setBusyId(null); }
  };

  if (needsAuth) return <AuthScreen onAuthenticated={load} />;
  if (!data && !error) return <div className="center-state"><LoaderCircle className="spin" /> <span>Building your revenue brief…</span></div>;
  if (error) return <div className="center-state error"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  if (!data) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><span>Trevra</span></div>
        <nav>
          <NavButton active={activeView === 'today'} icon={<Sparkles size={18} />} label="Today" onClick={() => setActiveView('today')} />
          <NavButton active={activeView === 'clients'} icon={<Users size={18} />} label="Clients" onClick={() => setActiveView('clients')} />
          <NavButton active={activeView === 'integrations'} icon={<Link2 size={18} />} label="Connections" onClick={() => setActiveView('integrations')} />
          <NavButton active={activeView === 'autopilot'} icon={<Bot size={18} />} label="Autopilot" onClick={() => setActiveView('autopilot')} />
        </nav>
        <div className="sidebar-promise">
          <ShieldCheck size={18} />
          <div><strong>Commercial memory</strong><span>Every recommendation carries its proof.</span></div>
        </div>
        <div className="sidebar-bottom">
          <div className="workspace-avatar">NS</div>
          <div><strong>{data.workspace.name}</strong><span>{data.metrics.connectedSources} live sources</span></div>
          <button className="sidebar-signout" title="Sign out" onClick={() => void signOut()}><LogOut size={16} /></button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><p className="eyebrow">{today}</p><h1>{viewTitle(activeView)}</h1></div>
          <div className="top-actions">
            <button className="icon-button" aria-label="Search"><Search size={19} /></button>
            <button className="icon-button" aria-label="Notifications"><Bell size={19} />{data.metrics.openRecommendations > 0 && <i />}</button>
          </div>
        </header>

        {activeView === 'today' && (
          <TodayView
            data={data}
            busyId={busyId}
            onPrepare={prepare}
            onSnooze={snooze}
            onDismiss={dismiss}
            onNavigate={setActiveView}
          />
        )}
        {activeView === 'clients' && <ClientsView data={data} />}
        {activeView === 'integrations' && <IntegrationsView data={data} reload={load} setToast={setToast} busyId={busyId} setBusyId={setBusyId} />}
        {activeView === 'autopilot' && <AutopilotView rules={data.automationRules} reload={load} setToast={setToast} />}
      </main>

      {activeAction && (
        <ActionDrawer
          action={activeAction}
          busy={busyId === activeAction.id}
          onChange={setActiveAction}
          onClose={() => setActiveAction(null)}
          onExecute={() => void execute()}
        />
      )}
      {toast && <button className="toast" onClick={() => setToast('')}><Check size={16} />{toast}<X size={14} /></button>}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    void getPublicConfig().then((config) => setGoogleEnabled(config.googleAuthEnabled)).catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true);
    setAuthError('');
    try {
      const result = mode === 'signup'
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setAuthError(result.error.message ?? 'Authentication failed');
        return;
      }
      await onAuthenticated();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-shell">
    <section className="auth-story">
      <div className="brand auth-brand"><span className="brand-mark">T</span><span>Trevra</span></div>
      <div>
        <span className="hero-kicker"><Sparkles size={14} /> Revenue chief of staff</span>
        <h1>Your freelance business should run while you do the work.</h1>
        <p>Trevra connects your client systems, proves what you are owed, prepares the action, and completes approved commercial work.</p>
      </div>
      <div className="auth-proof-list">
        <span><Check size={16} /> Follow up on every proposal</span>
        <span><Check size={16} /> Stop unapproved scope creep</span>
        <span><Check size={16} /> Invoice delivered work automatically</span>
        <span><Check size={16} /> Track money through payment</span>
      </div>
    </section>
    <section className="auth-panel">
      <div className="auth-card">
        <span className="auth-icon"><ShieldCheck /></span>
        <h2>{mode === 'signin' ? 'Sign in to Trevra' : 'Create your workspace'}</h2>
        <p>{mode === 'signin' ? 'Continue to your revenue work queue.' : 'Start with a private commercial graph for your business.'}</p>
        {mode === 'signup' && <label>Name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" /></label>}
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@studio.com" /></label>
        <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} /></label>
        {authError && <div className="error-banner">{authError}</div>}
        <button className="primary-button auth-submit" disabled={busy || !email || password.length < 10 || (mode === 'signup' && !name.trim())} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{mode === 'signin' ? 'Sign in' : 'Create workspace'}</button>
        {googleEnabled && <button className="secondary-button auth-submit" onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: window.location.origin })}>Continue with Google</button>}
        {import.meta.env.DEV && <button className="ghost-button auth-submit" onClick={() => void startDemoSession().then(onAuthenticated)}>Open seeded demo</button>}
        <button className="auth-switch" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setAuthError(''); }}>
          {mode === 'signin' ? 'New to Trevra? Create an account' : 'Already have an account? Sign in'}
        </button>
      </div>
    </section>
  </main>;
}

function TodayView({ data, busyId, onPrepare, onSnooze, onDismiss, onNavigate }: {
  data: DashboardPayload;
  busyId: string | null;
  onPrepare: (item: Recommendation) => Promise<void>;
  onSnooze: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  onNavigate: (view: View) => void;
}) {
  const prepared = data.recommendations.filter((item) => item.preparedAction).length;
  return <>
    <section className="hero-card">
      <div>
        <span className="hero-kicker"><Zap size={14} /> Trevra is working</span>
        <h2>{money(data.metrics.revenueAtRisk, data.metrics.currency)} has a next action</h2>
        <p>{prepared > 0 ? `${prepared} actions are already prepared for review.` : 'Connect your tools and Trevra will prepare the work automatically.'}</p>
      </div>
      <div className="hero-orbit"><span>{data.metrics.openRecommendations}</span><small>open actions</small></div>
    </section>
    <section className="metrics-grid metrics-grid-four">
      <Metric icon={<CircleDollarSign />} label="Revenue at risk" value={money(data.metrics.revenueAtRisk, data.metrics.currency)} detail="Prioritized opportunities" />
      <Metric icon={<FileCheck2 />} label="Ready to invoice" value={money(data.metrics.readyToInvoice, data.metrics.currency)} detail="Delivered work found" />
      <Metric icon={<Check />} label="Collected by Trevra" value={money(data.metrics.revenueCollected, data.metrics.currency)} detail="Confirmed payment outcomes" />
      <Metric icon={<Link2 />} label="Live sources" value={String(data.metrics.connectedSources)} detail="Connected business systems" />
    </section>

    {data.metrics.connectedSources === 0 && (
      <section className="setup-banner">
        <div className="setup-icon"><Link2 /></div>
        <div><strong>Turn the demo into your real business</strong><p>Connect email, calendar, accounting, or import marketplace history. Trevra will build the commercial graph for you.</p></div>
        <button className="primary-button" onClick={() => onNavigate('integrations')}>Connect tools <ChevronRight size={16} /></button>
      </section>
    )}

    <section className="content-grid">
      <div className="recommendations-panel">
        <div className="section-heading"><div><h3>Work queue</h3><p>Actions Trevra found, proved, and ranked.</p></div><span className="status-pill">{prepared} prepared</span></div>
        <div className="recommendation-list">
          {data.recommendations.map((item) => (
            <RecommendationCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onPrepare={() => void onPrepare(item)}
              onSnooze={() => void onSnooze(item.id)}
              onDismiss={() => void onDismiss(item.id)}
            />
          ))}
          {data.recommendations.length === 0 && <div className="empty-state"><Check size={28} /><h4>Trevra handled today’s queue</h4><p>No revenue action needs attention right now.</p></div>}
        </div>
      </div>

      <aside className="client-panel">
        <div className="section-heading"><div><h3>Client pulse</h3><p>Where each commercial relationship stands.</p></div></div>
        <div className="client-list">
          {data.clients.map((client) => (
            <button className="client-row" key={client.id}>
              <span className="client-avatar">{initials(client.name)}</span>
              <span className="client-copy"><strong>{client.name}</strong><small>{client.nextAction ?? client.status}</small></span>
              <span className="client-value">{money(client.activeValue, client.currency)}<ChevronRight size={15} /></span>
            </button>
          ))}
        </div>
        <div className="security-note"><ShieldCheck size={18} /><div><strong>Evidence before action</strong><p>Trevra shows the agreement, request, delivery, and billing proof behind each decision.</p></div></div>
      </aside>
    </section>
  </>;
}

function ClientsView({ data }: { data: DashboardPayload }) {
  return <section className="page-panel">
    <div className="section-heading"><div><h3>Commercial relationships</h3><p>Value, latest activity, and the next revenue action for every client.</p></div></div>
    <div className="client-table">
      {data.clients.map((client) => <article key={client.id} className="client-card-large">
        <span className="client-avatar large">{initials(client.name)}</span>
        <div><h3>{client.name}</h3><p>{client.contactName} · {client.email}</p><span className={`client-status status-${client.status}`}>{client.status}</span></div>
        <div className="client-card-value"><small>Relationship value</small><strong>{money(client.activeValue, client.currency)}</strong></div>
        <div className="client-next"><small>Next action</small><strong>{client.nextAction ?? 'No urgent action'}</strong></div>
        <button className="icon-button"><ChevronRight size={18} /></button>
      </article>)}
    </div>
  </section>;
}

function IntegrationsView({ data, reload, setToast, busyId, setBusyId }: {
  data: DashboardPayload;
  reload: () => Promise<void>;
  setToast: (message: string) => void;
  busyId: string | null;
  setBusyId: (id: string | null) => void;
}) {
  const [provider, setProvider] = useState<'upwork' | 'fiverr' | 'contra' | 'generic'>('upwork');
  const [csv, setCsv] = useState('');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentHints, setDocumentHints] = useState({ clientName: '', contactName: '', clientEmail: '', projectName: '', currency: 'EUR' });
  const available: AvailableIntegration[] = data.availableIntegrations.filter((item) => item.mode === 'oauth');
  const connect = async (item: AvailableIntegration) => {
    setBusyId(item.key);
    try {
      const session = await createConnectSession([item.key]);
      const nango = new Nango({ connectSessionToken: session.token });
      nango.openConnectUI({
        sessionToken: session.token,
        onEvent: (event) => {
          if (event.type === 'close') {
            void reload();
            setToast('Connection flow closed. Trevra will sync when authorization completes.');
          }
        }
      });
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to connect');
    } finally { setBusyId(null); }
  };

  const importDocument = async () => {
    if (!documentFile) return;
    setBusyId('document-import');
    try {
      const result = await importCommercialDocument({ file: documentFile, ...documentHints });
      setDocumentFile(null);
      await reload();
      setToast(`Built Scope Ledger: ${result.scopeItems} scope items, ${result.clauses} clauses, ${result.milestones} milestones`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Document import failed');
    } finally { setBusyId(null); }
  };

  const importCsv = async () => {
    if (!csv.trim()) return;
    setBusyId('csv-import');
    try {
      const result = await importMarketplace(provider, csv);
      setCsv('');
      await reload();
      setToast(`Imported ${result.imported} records${result.skipped ? `; skipped ${result.skipped}` : ''}`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Import failed');
    } finally { setBusyId(null); }
  };

  return <div className="page-stack">
    <section className="page-panel">
      <div className="section-heading"><div><h3>Connected accounts</h3><p>Trevra uses existing integration infrastructure; your source data stays linked to its origin.</p></div></div>
      <div className="connection-grid">
        {data.connections.map((connection) => <article className="connection-card" key={connection.id}>
          <span className="integration-logo">{initials(connection.provider)}</span>
          <div><h4>{prettyProvider(connection.provider)}</h4><p>{connection.displayName ?? connection.providerConfigKey}</p><span className={`connection-status ${connection.status}`}>{connection.isDemo ? 'Demo' : connection.status.replace('_', ' ')}</span></div>
          <div className="connection-actions">
            {!connection.isDemo && <button className="icon-button" title="Sync now" disabled={busyId === connection.id} onClick={() => {
              setBusyId(connection.id);
              void syncIntegration(connection.id).then(() => setToast('Sync requested')).catch((err) => setToast(err.message)).finally(() => setBusyId(null));
            }}>{busyId === connection.id ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button>}
            {!connection.isDemo && <button className="icon-button danger" title="Disconnect" onClick={() => {
              setBusyId(connection.id);
              void disconnectIntegration(connection.id).then(reload).then(() => setToast('Disconnected')).catch((err) => setToast(err.message)).finally(() => setBusyId(null));
            }}><Unplug size={17} /></button>}
          </div>
        </article>)}
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3>Add a live source</h3><p>OAuth, token refresh, retries, and provider quirks are handled by the integration layer.</p></div></div>
      <div className="integration-grid">
        {available.map((item) => <article className="integration-card" key={item.key}>
          <span className="integration-logo">{initials(item.name)}</span>
          <div><h4>{item.name}</h4><p>{item.description}</p></div>
          <button className={item.connected ? 'secondary-button' : 'primary-button'} disabled={item.connected || busyId === item.key} onClick={() => void connect(item)}>
            {busyId === item.key ? <LoaderCircle className="spin" size={16} /> : item.connected ? <Check size={16} /> : <Link2 size={16} />}
            {item.connected ? 'Connected' : 'Connect'}
          </button>
        </article>)}
      </div>
    </section>

    <section className="page-panel import-panel">
      <div className="section-heading"><div><h3>Build the Scope Ledger from an agreement</h3><p>Upload a proposal, statement of work, or contract. Trevra extracts the commercial facts instead of asking you to enter them twice.</p></div></div>
      <div className="document-hints">
        <label>Client name<input value={documentHints.clientName} onChange={(event) => setDocumentHints({ ...documentHints, clientName: event.target.value })} placeholder="Acme Labs" /></label>
        <label>Project name<input value={documentHints.projectName} onChange={(event) => setDocumentHints({ ...documentHints, projectName: event.target.value })} placeholder="Website launch" /></label>
        <label>Contact email<input type="email" value={documentHints.clientEmail} onChange={(event) => setDocumentHints({ ...documentHints, clientEmail: event.target.value })} placeholder="client@example.com" /></label>
        <label>Currency<select value={documentHints.currency} onChange={(event) => setDocumentHints({ ...documentHints, currency: event.target.value })}><option>EUR</option><option>USD</option><option>GBP</option><option>CHF</option><option>CAD</option><option>AUD</option></select></label>
      </div>
      <div className="document-upload-row">
        <label className="file-picker"><FileUp size={18} /> {documentFile ? documentFile.name : 'Choose PDF, DOCX, or text'}<input type="file" accept=".pdf,.docx,.txt,.md,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)} /></label>
        <button className="primary-button" disabled={!documentFile || busyId === 'document-import'} onClick={() => void importDocument()}>{busyId === 'document-import' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} Build Scope Ledger</button>
      </div>
    </section>

    <section className="page-panel import-panel">
      <div className="section-heading"><div><h3>Import a marketplace export</h3><p>Useful when a marketplace API is unavailable or restricted. Trevra still normalizes the history into your commercial graph.</p></div></div>
      <div className="import-controls">
        <label>Platform<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="upwork">Upwork</option><option value="fiverr">Fiverr</option><option value="contra">Contra</option><option value="generic">Generic CSV</option></select></label>
        <label className="file-picker"><FileUp size={18} /> Choose CSV<input type="file" accept=".csv,text/csv" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then(setCsv);
        }} /></label>
      </div>
      <label>CSV preview<textarea rows={7} value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="Client,Project,Amount,Status,Date…" /></label>
      <div className="panel-footer"><span>{csv ? `${csv.split('\n').length - 1} possible records` : 'No file selected'}</span><button className="primary-button" disabled={!csv || busyId === 'csv-import'} onClick={() => void importCsv()}>{busyId === 'csv-import' ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />} Import history</button></div>
    </section>
  </div>;
}

function AutopilotView({ rules, reload, setToast }: { rules: AutomationRule[]; reload: () => Promise<void>; setToast: (message: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, AutomationRule>>(() => Object.fromEntries(rules.map((rule) => [rule.recommendationType, rule])));
  const [busy, setBusy] = useState('');

  useEffect(() => setDrafts(Object.fromEntries(rules.map((rule) => [rule.recommendationType, rule]))), [rules]);

  const save = async (type: RecommendationType) => {
    const rule = drafts[type];
    if (!rule) return;
    setBusy(type);
    try {
      await updateAutomationRule(type, {
        mode: rule.mode,
        minConfidence: rule.minConfidence,
        maxAmount: rule.maxAmount,
        delayMinutes: rule.delayMinutes,
        enabled: rule.enabled
      });
      await reload();
      setToast(`${recommendationLabels[type]} automation saved`);
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to save'); }
    finally { setBusy(''); }
  };

  const run = async () => {
    setBusy('run');
    try {
      const result = await runAutomation();
      await reload();
      setToast(`Autopilot prepared ${result.prepared} and completed ${result.executed} actions`);
    } catch (err) { setToast(err instanceof Error ? err.message : 'Autopilot failed'); }
    finally { setBusy(''); }
  };

  return <div className="page-stack">
    <section className="autopilot-hero">
      <div><span className="hero-kicker"><Bot size={14} /> Standing instructions</span><h2>Decide once. Trevra handles the routine work.</h2><p>Prepare actions automatically, or allow low-risk follow-ups within limits you control.</p></div>
      <button className="primary-button light" onClick={() => void run()} disabled={busy === 'run'}>{busy === 'run' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Run now</button>
    </section>
    <div className="automation-list">
      {(Object.keys(recommendationLabels) as RecommendationType[]).map((type) => {
        const rule = drafts[type];
        if (!rule) return null;
        const canExecute = type !== 'scope_creep';
        return <article className="automation-card" key={type}>
          <div className="automation-heading"><span className={`recommendation-icon type-${type}`}>{iconFor(type)}</span><div><h3>{recommendationLabels[type]}</h3><p>{automationDescription(type)}</p></div><label className="toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => setDrafts({ ...drafts, [type]: { ...rule, enabled: event.target.checked } })} /><span /></label></div>
          <div className="automation-fields">
            <label>What Trevra may do<select value={rule.mode} onChange={(event) => setDrafts({ ...drafts, [type]: { ...rule, mode: event.target.value as AutomationRule['mode'] } })}><option value="suggest">Suggest only</option><option value="prepare">Prepare for review</option>{canExecute && <option value="execute">Send automatically</option>}</select></label>
            <label>Minimum confidence<input type="number" min="50" max="100" value={Math.round(rule.minConfidence * 100)} onChange={(event) => setDrafts({ ...drafts, [type]: { ...rule, minConfidence: Number(event.target.value) / 100 } })} /><small>%</small></label>
            <label>Maximum value<input type="number" min="0" value={rule.maxAmount} onChange={(event) => setDrafts({ ...drafts, [type]: { ...rule, maxAmount: Number(event.target.value) } })} /><small>EUR</small></label>
            <label>Wait before action<input type="number" min="0" value={rule.delayMinutes} onChange={(event) => setDrafts({ ...drafts, [type]: { ...rule, delayMinutes: Number(event.target.value) } })} /><small>minutes</small></label>
          </div>
          {type === 'scope_creep' && <div className="rule-note"><ShieldCheck size={16} /> Change orders always require your approval.</div>}
          <div className="automation-footer"><span>{rule.enabled ? `Enabled · ${rule.mode.replace('_', ' ')}` : 'Disabled'}</span><button className="secondary-button" onClick={() => void save(type)} disabled={busy === type}>{busy === type ? <LoaderCircle className="spin" size={16} /> : <Settings2 size={16} />} Save rule</button></div>
        </article>;
      })}
    </div>
  </div>;
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <article className="metric-card"><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div></article>;
}

function RecommendationCard({ item, busy, onPrepare, onSnooze, onDismiss }: {
  item: Recommendation; busy: boolean; onPrepare: () => void; onSnooze: () => void; onDismiss: () => void;
}) {
  const proofItems = item.proofPack?.items ?? item.evidence;
  return <article className="recommendation-card">
    <div className={`recommendation-icon type-${item.type}`}>{iconFor(item.type)}</div>
    <div className="recommendation-body">
      <div className="recommendation-meta"><span>{recommendationLabels[item.type]}</span><i>•</i><span>{Math.round(item.confidence * 100)}% confidence</span>{item.preparedAction && <span className="prepared-badge"><Sparkles size={11} /> Prepared</span>}</div>
      <h4>{item.title}</h4>
      <p>{item.summary}</p>
      <details className="proof-pack">
        <summary><FileCheck2 size={14} /> Open Revenue Proof Pack</summary>
        <p className="proof-summary">{item.proofPack?.summary}</p>
        <div className="proof-items">{proofItems.map((evidence) => <div className={`proof-item proof-${evidence.category}`} key={evidence.id}><span>{evidence.label}</span><blockquote>{evidence.excerpt}</blockquote></div>)}</div>
      </details>
      <div className="recommendation-action"><strong>{item.recommendedAction}</strong><span>{money(item.estimatedAmount, item.currency)}</span></div>
      <div className="recommendation-buttons">
        <button className="primary-button" onClick={onPrepare} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : item.preparedAction ? <FileCheck2 size={16} /> : <Sparkles size={16} />} {item.preparedAction ? 'Review prepared action' : 'Prepare action'}</button>
        <button className="secondary-button" onClick={onSnooze} disabled={busy}><CalendarClock size={16} /> Snooze</button>
        <button className="ghost-button" onClick={onDismiss} disabled={busy}>Dismiss</button>
      </div>
    </div>
  </article>;
}

function ActionDrawer({ action, busy, onChange, onClose, onExecute }: {
  action: PreparedAction; busy: boolean; onChange: (action: PreparedAction) => void; onClose: () => void; onExecute: () => void;
}) {
  const scheduleValue = action.scheduledFor ? toLocalDateTime(action.scheduledFor) : '';
  return <div className="drawer-backdrop" role="presentation"><section className="drawer" role="dialog" aria-modal="true" aria-label="Review prepared action">
    <header><div><span className="drawer-kicker"><Sparkles size={14} /> Prepared by Trevra</span><h3>Review the completed work</h3></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header>
    <div className="drawer-body">
      <div className="approval-banner"><ShieldCheck size={19} /><p><strong>Exact-payload approval.</strong> Trevra executes only the recipient, subject, message, and schedule you approve.</p></div>
      <div className="delivery-row"><span>Delivery</span><strong>{prettyProvider(action.executionProvider)}</strong></div>
      <label>To<input value={action.recipient} onChange={(e) => onChange({ ...action, recipient: e.target.value })} /></label>
      <label>Subject<input value={action.subject} onChange={(e) => onChange({ ...action, subject: e.target.value })} /></label>
      <label>Message<textarea rows={14} value={action.body} onChange={(e) => onChange({ ...action, body: e.target.value })} /></label>
      <label>Send later <input type="datetime-local" value={scheduleValue} onChange={(event) => onChange({ ...action, scheduledFor: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
      {action.lastError && <div className="error-banner">{action.lastError}</div>}
    </div>
    <footer><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={onExecute} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : action.scheduledFor ? <CalendarClock size={16} /> : <Check size={16} />} {action.scheduledFor ? 'Approve & schedule' : 'Approve & send'}</button></footer>
  </section></div>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}{label}</button>;
}

function viewTitle(view: View) {
  if (view === 'today') return 'Your revenue workday';
  if (view === 'clients') return 'Clients';
  if (view === 'integrations') return 'Connections';
  return 'Autopilot';
}

function iconFor(type: RecommendationType) {
  if (type === 'scope_creep') return <FileWarning />;
  if (type === 'overdue_invoice') return <Clock3 />;
  if (type === 'unbilled_milestone') return <CircleDollarSign />;
  return <Inbox />;
}

function automationDescription(type: RecommendationType) {
  if (type === 'stale_proposal') return 'Follow up when a proposal goes quiet.';
  if (type === 'scope_creep') return 'Detect and price requests outside the agreement.';
  if (type === 'unbilled_milestone') return 'Prepare invoices when delivery is proven.';
  return 'Follow up when an invoice passes its due date.';
}

function prettyProvider(provider: string) {
  return provider.replace('google-mail', 'Gmail').replace('gmail', 'Gmail').replace('microsoft', 'Microsoft 365').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string) {
  return value.split(/[\s-]+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}
