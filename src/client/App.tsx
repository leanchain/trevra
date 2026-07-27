import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Bell,
  Bot,
  Boxes,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  FileCheck2,
  FileUp,
  FileWarning,
  Inbox,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Terminal,
  Trash2,
  ShieldCheck,
  Sparkles,
  Unplug,
  Users,
  Workflow,
  X,
  Zap
} from 'lucide-react';
import type {
  AgentTokenSummary,
  AutomationRule,
  AvailableIntegration,
  DashboardPayload,
  PlaybookManifest,
  PlaybookRun,
  PreparedAction,
  PublicRegistryModule,
  InstalledCommunityModule,
  RegistryPublisher,
  Recommendation,
  RecommendationType,
  WorkspacePolicy
} from '../shared/types';
import {
  approveAction,
  createAgentToken,
  createPolicy,
  createConnectSession,
  ApiError,
  disconnectIntegration,
  decidePlaybookStep,
  deletePolicy,
  dismissRecommendation,
  endDemoSession,
  ensureSession,
  executeAction,
  getAgentTokens,
  getDashboard,
  getPlaybookRuns,
  getPlaybooks,
  getPolicies,
  getPublicConfig,
  getPublicRegistryModules,
  getInstalledRegistryModules,
  getRegistryPublishers,
  importCommercialDocument,
  installRegistryModule,
  importMarketplace,
  prepareRecommendation,
  createRegistryPublisher,
  publishRegistryModule,
  revokeAgentToken,
  runAutomation,
  snoozeRecommendation,
  startDemoSession,
  startPlaybook,
  syncIntegration,
  updateAutomationRule,
  uninstallRegistryModule
} from './api';
import { authClient } from './auth-client';
import { MarketingScreen } from './MarketingScreen';
import { trackEvent, trackPageView } from './analytics';

type View = 'today' | 'work' | 'modules' | 'clients' | 'integrations' | 'autopilot';

const MARKETING_ONLY = import.meta.env.VITE_MARKETING_ONLY === 'true';
const HOSTED_APP_URL = import.meta.env.VITE_HOSTED_APP_URL?.trim() ?? '';
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL?.trim() ?? '';

const money = (amount: number, currency = 'EUR') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, maximumFractionDigits: 0
}).format(amount);

const recommendationLabels: Record<RecommendationType, string> = {
  stale_proposal: 'Proposal follow-up',
  scope_creep: 'Scope protection',
  unbilled_milestone: 'Ready to invoice',
  overdue_invoice: 'Payment collection'
};

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18">
    <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.875 2.684-6.614Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.715H.956v2.333A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.963 10.705A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.167.281-1.705V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.333Z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.333C4.672 5.165 6.656 3.58 9 3.58Z" />
  </svg>;
}

export function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);
  const [showAuth, setShowAuth] = useState(false);
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

  useEffect(() => {
    trackPageView();
    if (MARKETING_ONLY) return;
    void load();
    if (window.location.hash === '#get-started') setShowAuth(true);
  }, []);
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
    setShowAuth(false);
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

  if (MARKETING_ONLY) return <MarketingScreen
    hostedAppUrl={HOSTED_APP_URL}
    githubUrl={GITHUB_URL}
    onGetStarted={() => document.getElementById('hosted')?.scrollIntoView({ behavior: 'smooth' })}
  />;
  if (needsAuth === null) return <div className="center-state"><LoaderCircle className="spin" /> <span>Building your revenue brief…</span></div>;
  if (needsAuth) return showAuth
    ? <AuthScreen onAuthenticated={load} onBack={() => setShowAuth(false)} />
    : <MarketingScreen githubUrl={GITHUB_URL} onGetStarted={() => setShowAuth(true)} />;
  if (!data && !error) return <div className="center-state"><LoaderCircle className="spin" /> <span>Building your revenue brief…</span></div>;
  if (error) return <div className="center-state error"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  if (!data) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><span>Trevra</span></div>
        <nav>
          <NavButton active={activeView === 'today'} icon={<Sparkles size={18} />} label="Today" onClick={() => setActiveView('today')} />
          <NavButton active={activeView === 'work'} icon={<Workflow size={18} />} label="Work" onClick={() => setActiveView('work')} />
          <NavButton active={activeView === 'modules'} icon={<Boxes size={18} />} label="Modules" onClick={() => setActiveView('modules')} />
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
        {activeView === 'work' && <WorkView setToast={setToast} />}
        {activeView === 'modules' && <ModulesView setToast={setToast} />}
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

function AuthScreen({ onAuthenticated, onBack }: { onAuthenticated: () => Promise<void>; onBack: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    void getPublicConfig().then((config) => setGoogleEnabled(config.googleAuthEnabled)).catch(() => undefined);
  }, []);

  const signInWithGoogle = async () => {
    setGoogleBusy(true);
    setAuthError('');
    trackEvent('google_auth_started');
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: `${window.location.origin}/` });
      if (result?.error) {
        setAuthError(result.error.message ?? 'Google sign-in failed');
        setGoogleBusy(false);
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Google sign-in failed');
      setGoogleBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setAuthError('');
    if (mode === 'signup') trackEvent('email_signup_submitted');
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

  const switchMode = () => {
    const next = mode === 'signin' ? 'signup' : 'signin';
    setMode(next);
    setAuthError('');
    if (next === 'signup') trackEvent('signup_started');
  };

  return <main className="marketing-runtime">
    <div className="auth-shell">
      <section className="auth-story">
        <a className="brand auth-brand" href="/" onClick={(event) => { event.preventDefault(); onBack(); }}><span className="brand-mark">T</span><span>Trevra</span></a>
        <div><span className="hero-kicker"><Sparkles size={14} /> Agentic GTM for founders</span><h1>Run growth from Claude. Trevra remembers what happened.</h1><p>Ask Claude to source, qualify, reach out, follow up, and bill. Every action is evidence-backed, approval-gated, and logged in one open-source ledger you own.</p></div>
        <div className="auth-proof-list"><span><Check size={16} /> Every action carries its evidence</span><span><Check size={16} /> Approved payloads hashed before execution</span><span><Check size={16} /> Delegation with explicit ceilings</span><span><Check size={16} /> Open source, self-hostable, yours</span></div>
      </section>
      <section className="auth-panel" id="get-started">
        <div className="auth-card">
          <span className="auth-icon"><ShieldCheck /></span>
          <h2>{mode === 'signin' ? 'Sign in to Trevra' : 'Create your workspace'}</h2>
          <p>{mode === 'signin' ? 'Continue to your approval queue.' : 'Start with a private revenue ledger only you control.'}</p>
          {googleEnabled && <><button className="google-auth-button" disabled={busy || googleBusy} onClick={() => void signInWithGoogle()}>{googleBusy ? <LoaderCircle className="spin" size={17} /> : <GoogleMark />}Continue with Google</button><div className="auth-divider"><span>Or the email</span></div></>}
          {mode === 'signup' && <label>Name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" /></label>}
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
          <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} /></label>
          {authError && <div className="error-banner">{authError}</div>}
          <button className="primary-button auth-submit" disabled={busy || googleBusy || !email || password.length < 10 || (mode === 'signup' && !name.trim())} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{mode === 'signin' ? 'Sign in' : 'Create workspace'}</button>
          {import.meta.env.DEV && <button className="ghost-button auth-submit" disabled={busy || googleBusy} onClick={() => void startDemoSession().then(onAuthenticated)}>Open seeded demo</button>}
          <button className="auth-switch" onClick={switchMode}>{mode === 'signin' ? 'New to Trevra? Create an account' : 'Already have an account? Sign in'}</button>
          <button className="auth-switch" onClick={onBack}>← Back to site</button>
          <p className="auth-consent">By creating or using a workspace, you agree to the <a href="/terms">Terms</a> and acknowledge the <a href="/privacy">Privacy Notice</a>.</p>
          <div className="auth-legal-links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="/how-it-works">How it works</a></div>
        </div>
      </section>
    </div>
  </main>;
}

/**
 * The theme boot script (served inline in the document head) binds the switch
 * by delegation on `[data-theme-toggle]`, so this renders markup only -- no
 * click handler, no duplicated state, one source of truth for the theme.
 */
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

const STARTER_PLAYBOOK_INPUT = JSON.stringify({
  lead: {
    domain: 'example.com',
    name: 'Example Company',
    contactName: 'Alex',
    contactEmail: 'alex@example.com',
    platform: 'shopify',
    vertical: 'footwear',
    catalogSize: 100
  },
  draftConfig: {
    offer: 'I can send the full audit if it is useful.',
    senderName: 'Your name',
    postalAddress: 'Your business postal address',
    voiceSample: null
  }
}, null, 2);

function WorkView({ setToast }: { setToast: (message: string) => void }) {
  const [playbooks, setPlaybooks] = useState<PlaybookManifest[]>([]);
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [input, setInput] = useState(STARTER_PLAYBOOK_INPUT);
  const [busy, setBusy] = useState('');

  const reload = async () => {
    const [nextPlaybooks, nextRuns] = await Promise.all([getPlaybooks(), getPlaybookRuns({ limit: 50 })]);
    setPlaybooks(nextPlaybooks);
    setRuns(nextRuns);
    if (!selectedId && nextPlaybooks[0]) setSelectedId(nextPlaybooks[0].id);
  };

  useEffect(() => { void reload().catch((error) => setToast(error instanceof Error ? error.message : 'Unable to load work')); }, []);

  const launch = async () => {
    const selected = playbooks.find((playbook) => playbook.id === selectedId);
    if (!selected) return;
    setBusy('launch');
    try {
      const payload = JSON.parse(input) as unknown;
      const run = await startPlaybook(selected.id, payload, selected.version);
      await reload();
      setToast(run.status === 'waiting_approval' ? 'Playbook reached an approval boundary' : `Playbook ${run.status}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to start playbook');
    } finally { setBusy(''); }
  };

  const decide = async (run: PlaybookRun, stepId: string, decision: 'approve' | 'reject') => {
    setBusy(`${run.id}:${stepId}`);
    try {
      const updated = await decidePlaybookStep(run.id, stepId, decision);
      await reload();
      setToast(decision === 'approve' ? `Approved; workflow is ${updated.status}` : 'Approval rejected');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to record decision');
    } finally { setBusy(''); }
  };

  const selected = playbooks.find((playbook) => playbook.id === selectedId);
  const waiting = runs.filter((run) => run.status === 'waiting_approval');

  return <div className="page-stack work-view">
    <section className="work-hero">
      <div><span className="hero-kicker"><Workflow size={14} /> Durable control plane</span><h2>Run GTM playbooks that survive restarts and stop for decisions.</h2><p>Every step, policy verdict, retry, approval, and result is persisted in the append-only event stream.</p></div>
      <div className="work-hero-count"><strong>{waiting.length}</strong><span>waiting approval</span></div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3>Start a playbook</h3><p>Playbooks compose typed modules into a versioned, durable workflow.</p></div><span className="status-pill">{playbooks.length} installed</span></div>
      <div className="playbook-launch-grid">
        <div className="playbook-catalog">
          {playbooks.map((playbook) => <button key={`${playbook.id}@${playbook.version}`} className={selectedId === playbook.id ? 'is-selected' : undefined} onClick={() => setSelectedId(playbook.id)}>
            <span><Workflow size={17} /><strong>{playbook.name}</strong></span>
            <p>{playbook.description}</p>
            <code>{playbook.id}@{playbook.version}</code>
          </button>)}
        </div>
        <div className="playbook-input">
          <div><strong>{selected?.name ?? 'Select a playbook'}</strong><span>Input is validated against the published JSON schema before a run is created.</span></div>
          <textarea rows={18} value={input} onChange={(event) => setInput(event.target.value)} spellCheck={false} />
          <button className="primary-button" disabled={!selected || busy === 'launch'} onClick={() => void launch()}>{busy === 'launch' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Start durable run</button>
        </div>
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3>Runs and approvals</h3><p>The current state is derived from persisted steps; approval decisions are applied to an exact payload hash.</p></div><button className="secondary-button" onClick={() => void reload()}><RefreshCw size={15} /> Refresh</button></div>
      <div className="playbook-run-list">
        {runs.map((run) => {
          const approval = run.steps.find((step) => step.status === 'waiting_approval');
          const completed = run.steps.filter((step) => step.status === 'completed').length;
          return <article key={run.id} className={`playbook-run status-${run.status}`}>
            <header><div><span className={`run-status run-${run.status}`}>{run.status.replace('_', ' ')}</span><h3>{run.playbookId}</h3><code>{run.id} · v{run.playbookVersion}</code></div><strong>{completed}/{run.steps.length}</strong></header>
            <div className="playbook-step-track">{run.steps.map((step) => <div key={step.id} className={`step-${step.status}`}><i /><span>{step.stepId}</span><small>{step.status.replace('_', ' ')}</small></div>)}</div>
            {run.error && <div className="error-banner">{run.error}</div>}
            {approval && <div className="workflow-approval">
              <div className="approval-banner"><ShieldCheck size={19} /><p><strong>Founder decision required.</strong> This exact payload is pinned as <code>{approval.approvalPayloadHash?.slice(0, 16)}…</code>.</p></div>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
              <div><button className="secondary-button" disabled={busy === `${run.id}:${approval.stepId}`} onClick={() => void decide(run, approval.stepId, 'reject')}>Reject</button><button className="primary-button" disabled={busy === `${run.id}:${approval.stepId}`} onClick={() => void decide(run, approval.stepId, 'approve')}>{busy === `${run.id}:${approval.stepId}` ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Approve exact payload</button></div>
            </div>}
            {run.status === 'completed' && <details className="run-output"><summary>View output</summary><pre>{JSON.stringify(run.output, null, 2)}</pre></details>}
          </article>;
        })}
        {runs.length === 0 && <div className="empty-state"><Workflow size={28} /><h4>No playbook runs yet</h4><p>Start the first durable GTM workflow above.</p></div>}
      </div>
    </section>
  </div>;
}

function ModulesView({ setToast }: { setToast: (message: string) => void }) {
  const [modules, setModules] = useState<PublicRegistryModule[]>([]);
  const [installed, setInstalled] = useState<InstalledCommunityModule[]>([]);
  const [publishers, setPublishers] = useState<RegistryPublisher[]>([]);
  const [busy, setBusy] = useState('');
  const [publisherDraft, setPublisherDraft] = useState({ slug: '', displayName: '', publicKeyPem: '' });
  const [releaseDraft, setReleaseDraft] = useState({ publisherId: '', manifest: '', sbom: '{}', signature: '' });

  const loadRegistry = async () => {
    const [publicModules, installations, publisherList] = await Promise.all([
      getPublicRegistryModules(), getInstalledRegistryModules(), getRegistryPublishers()
    ]);
    setModules(publicModules);
    setInstalled(installations);
    setPublishers(publisherList);
    if (!releaseDraft.publisherId && publisherList[0]) {
      setReleaseDraft((current) => ({ ...current, publisherId: publisherList[0].id }));
    }
  };

  useEffect(() => { void loadRegistry().catch((error) => setToast(error instanceof Error ? error.message : 'Unable to load registry')); }, []);
  const installedIds = new Set(installed.map((module) => module.id));

  const toggleInstall = async (module: PublicRegistryModule) => {
    if (!module.version || module.sourceType === 'builtin') return;
    setBusy(module.id);
    try {
      if (installedIds.has(module.id)) await uninstallRegistryModule(module.id);
      else await installRegistryModule(module.id, module.version);
      await loadRegistry();
      setToast(installedIds.has(module.id) ? `${module.name} uninstalled` : `${module.name} installed`);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Unable to update installation'); }
    finally { setBusy(''); }
  };

  const createPublisher = async () => {
    setBusy('publisher');
    try {
      const publisher = await createRegistryPublisher(publisherDraft);
      setPublisherDraft({ slug: '', displayName: '', publicKeyPem: '' });
      await loadRegistry();
      setReleaseDraft((current) => ({ ...current, publisherId: publisher.id }));
      setToast('Publisher identity created. Keep the matching private key outside Trevra.');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Unable to create publisher'); }
    finally { setBusy(''); }
  };

  const publishRelease = async () => {
    setBusy('release');
    try {
      const manifest = JSON.parse(releaseDraft.manifest) as Record<string, unknown>;
      const sbom = JSON.parse(releaseDraft.sbom) as Record<string, unknown>;
      const moduleId = String(manifest.id ?? '');
      if (!moduleId) throw new Error('Manifest must include an id');
      await publishRegistryModule({ moduleId, publisherId: releaseDraft.publisherId, manifest, sbom, signature: releaseDraft.signature });
      setReleaseDraft((current) => ({ ...current, manifest: '', sbom: '{}', signature: '' }));
      await loadRegistry();
      setToast(`${moduleId} published as a verified release`);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Unable to publish release'); }
    finally { setBusy(''); }
  };

  return <div className="page-stack">
    <section className="page-panel registry-summary">
      <div className="section-heading"><div><h3><Boxes size={18} /> Hosted module registry</h3><p>Popularity is aggregated from completed runs. Inputs, outputs, workspace names, and customer records are never published.</p></div><span className="status-pill">{modules.reduce((sum, module) => sum + module.popularity.totalRuns, 0).toLocaleString('en-US')} runs</span></div>
      <div className="registry-grid">
        {modules.map((module) => {
          const isInstalled = installedIds.has(module.id);
          return <article className="registry-card" key={module.id}>
            <div className="registry-card-head"><code>{module.id}</code><span>#{module.popularity.rank || '—'}</span></div>
            <h3>{module.name}</h3><p>{module.description}</p>
            <div className="registry-stats"><span><strong>{module.popularity.totalRuns.toLocaleString('en-US')}</strong>runs</span><span><strong>{module.popularity.successRate === null ? '—' : `${Math.round(module.popularity.successRate * 100)}%`}</strong>success</span><span><strong>{module.popularity.activeInstallations.toLocaleString('en-US')}</strong>installs</span></div>
            <div className="registry-trust"><span><ShieldCheck size={14} /> {module.publisher.verified ? 'Verified publisher' : module.publisher.name}</span><span>{module.trust.signed ? 'Signed' : 'Built in'} · {module.trust.sbom ? 'SBOM' : 'No SBOM'}</span></div>
            {module.sourceType === 'community' && <button className={isInstalled ? 'secondary-button' : 'primary-button'} disabled={busy === module.id || !module.version} onClick={() => void toggleInstall(module)}>{busy === module.id ? <LoaderCircle className="spin" size={15} /> : isInstalled ? <Trash2 size={15} /> : <Boxes size={15} />}{isInstalled ? 'Uninstall' : `Install v${module.version}`}</button>}
          </article>;
        })}
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3>Publisher identity</h3><p>Register an Ed25519 public key. Trevra never asks for or stores the private signing key.</p></div></div>
      <div className="registry-form-grid"><label>Slug<input value={publisherDraft.slug} onChange={(event) => setPublisherDraft({ ...publisherDraft, slug: event.target.value })} placeholder="your-company" /></label><label>Display name<input value={publisherDraft.displayName} onChange={(event) => setPublisherDraft({ ...publisherDraft, displayName: event.target.value })} placeholder="Your Company" /></label></div>
      <label>Ed25519 public key PEM<textarea rows={6} value={publisherDraft.publicKeyPem} onChange={(event) => setPublisherDraft({ ...publisherDraft, publicKeyPem: event.target.value })} placeholder="-----BEGIN PUBLIC KEY-----" /></label>
      <div className="panel-footer"><span>{publishers.length} publisher identities in this workspace</span><button className="primary-button" disabled={busy === 'publisher' || !publisherDraft.slug || !publisherDraft.displayName || !publisherDraft.publicKeyPem} onClick={() => void createPublisher()}>{busy === 'publisher' ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />} Create publisher</button></div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3>Publish a signed release</h3><p>Sign the canonical manifest and SBOM digest outside Trevra, then submit only the public artifact metadata and signature.</p></div></div>
      <label>Publisher<select value={releaseDraft.publisherId} onChange={(event) => setReleaseDraft({ ...releaseDraft, publisherId: event.target.value })}><option value="">Select publisher</option>{publishers.map((publisher) => <option value={publisher.id} key={publisher.id}>{publisher.displayName ?? publisher.slug}</option>)}</select></label>
      <label>Manifest JSON<textarea rows={12} value={releaseDraft.manifest} onChange={(event) => setReleaseDraft({ ...releaseDraft, manifest: event.target.value })} placeholder={'{"id":"acme.module","version":"1.0.0","runtime":"oci",...}'} /></label>
      <label>SBOM JSON<textarea rows={7} value={releaseDraft.sbom} onChange={(event) => setReleaseDraft({ ...releaseDraft, sbom: event.target.value })} /></label>
      <label>Base64 Ed25519 signature<textarea rows={4} value={releaseDraft.signature} onChange={(event) => setReleaseDraft({ ...releaseDraft, signature: event.target.value })} /></label>
      <div className="panel-footer"><span>Artifact digests, schemas, permissions, signature, and SBOM are verified before publication.</span><button className="primary-button" disabled={busy === 'release' || !releaseDraft.publisherId || !releaseDraft.manifest || !releaseDraft.signature} onClick={() => void publishRelease()}>{busy === 'release' ? <LoaderCircle className="spin" size={15} /> : <FileCheck2 size={15} />} Publish release</button></div>
    </section>
  </div>;
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
  // OAuth and API-key providers both connect through the Nango Connect UI; only CSV imports are excluded.
  const available: AvailableIntegration[] = data.availableIntegrations.filter((item) => item.mode !== 'import');
  const connect = async (item: AvailableIntegration) => {
    setBusyId(item.key);
    try {
      const session = await createConnectSession([item.key]);
      const { default: Nango } = await import('@nangohq/frontend');
      const nango = new Nango({ connectSessionToken: session.token, host: session.browser_host });
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
      <div className="section-heading"><div><h3>Add a live source</h3><p>OAuth, API keys, token refresh, retries, and provider quirks are handled by the integration layer. Credentials are entered in the provider connect screen and stay there; Trevra keeps only the connection reference.</p></div></div>
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
  const [agentTokens, setAgentTokens] = useState<AgentTokenSummary[]>([]);
  const [tokenName, setTokenName] = useState('Claude Code');
  const [revealedToken, setRevealedToken] = useState('');
  const [policies, setPolicies] = useState<WorkspacePolicy[]>([]);
  const [policyDraft, setPolicyDraft] = useState({
    name: 'Require approval for external writes',
    actionPattern: 'skill:*',
    effect: 'require_approval' as WorkspacePolicy['effect'],
    priority: 100,
    conditions: JSON.stringify({ sideEffects: ['external-write'] }, null, 2)
  });

  useEffect(() => setDrafts(Object.fromEntries(rules.map((rule) => [rule.recommendationType, rule]))), [rules]);
  useEffect(() => {
    void Promise.all([getAgentTokens(), getPolicies()]).then(([tokens, nextPolicies]) => {
      setAgentTokens(tokens);
      setPolicies(nextPolicies);
    }).catch(() => undefined);
  }, []);

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

  const addPolicy = async () => {
    if (!policyDraft.name.trim() || !policyDraft.actionPattern.trim()) return;
    setBusy('policy-create');
    try {
      const conditions = JSON.parse(policyDraft.conditions || '{}') as Record<string, unknown>;
      setPolicies(await createPolicy({
        name: policyDraft.name.trim(),
        actionPattern: policyDraft.actionPattern.trim(),
        effect: policyDraft.effect,
        priority: policyDraft.priority,
        conditions,
        enabled: true
      }));
      setToast('Workspace policy created');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to create policy'); }
    finally { setBusy(''); }
  };

  const removePolicy = async (policyId: string) => {
    setBusy(policyId);
    try {
      await deletePolicy(policyId);
      setPolicies(await getPolicies());
      setToast('Workspace policy deleted');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to delete policy'); }
    finally { setBusy(''); }
  };

  const createToken = async () => {
    if (!tokenName.trim()) return;
    setBusy('agent-token');
    try {
      const created = await createAgentToken({ name: tokenName.trim() });
      setRevealedToken(created.token);
      setAgentTokens(await getAgentTokens());
      setToast('Agent token created. Copy it now; Trevra will not show it again.');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to create agent token'); }
    finally { setBusy(''); }
  };

  const revokeToken = async (tokenId: string) => {
    setBusy(tokenId);
    try {
      await revokeAgentToken(tokenId);
      setAgentTokens(await getAgentTokens());
      setToast('Agent token revoked');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to revoke token'); }
    finally { setBusy(''); }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(revealedToken);
      setToast('Agent token copied');
    } catch { setToast('Copy failed. Select the token manually.'); }
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
    <section className="page-panel policy-panel">
      <div className="section-heading"><div><h3><ShieldCheck size={18} /> Workspace execution policies</h3><p>Policies are evaluated before every playbook skill step. A matching deny wins immediately; external writes remain approval-gated by default.</p></div><span className="status-pill">{policies.length} policies</span></div>
      <div className="policy-editor">
        <label>Name<input value={policyDraft.name} onChange={(event) => setPolicyDraft({ ...policyDraft, name: event.target.value })} /></label>
        <label>Action pattern<input value={policyDraft.actionPattern} onChange={(event) => setPolicyDraft({ ...policyDraft, actionPattern: event.target.value })} placeholder="skill:gtm.*" /></label>
        <label>Effect<select value={policyDraft.effect} onChange={(event) => setPolicyDraft({ ...policyDraft, effect: event.target.value as WorkspacePolicy['effect'] })}><option value="allow">Allow</option><option value="require_approval">Require approval</option><option value="deny">Deny</option></select></label>
        <label>Priority<input type="number" value={policyDraft.priority} onChange={(event) => setPolicyDraft({ ...policyDraft, priority: Number(event.target.value) })} /></label>
        <label className="policy-conditions">Conditions JSON<textarea rows={6} value={policyDraft.conditions} onChange={(event) => setPolicyDraft({ ...policyDraft, conditions: event.target.value })} spellCheck={false} /></label>
        <button className="primary-button" disabled={busy === 'policy-create'} onClick={() => void addPolicy()}>{busy === 'policy-create' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Add policy</button>
      </div>
      <div className="workspace-policy-list">
        {policies.map((policy) => <article key={policy.id}>
          <div><strong>{policy.name}</strong><code>{policy.actionPattern}</code></div>
          <span className={`policy-effect effect-${policy.effect}`}>{policy.effect.replace('_', ' ')}</span>
          <pre>{JSON.stringify(policy.conditions, null, 2)}</pre>
          <button className="ghost-button danger" disabled={busy === policy.id} onClick={() => void removePolicy(policy.id)}>{busy === policy.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Delete</button>
        </article>)}
        {policies.length === 0 && <p className="empty-copy">No custom policies. Built-in safe defaults still apply.</p>}
      </div>
    </section>

    <section className="page-panel agent-access-panel">
      <div className="section-heading"><div><h3><Terminal size={18} /> Claude Code and Codex access</h3><p>Create a scoped token for the Trevra MCP server. Agent tokens can inspect the revenue brief, run skills and durable playbooks, read workflow events, and prepare actions; they cannot approve, execute, manage integrations, or administer your account.</p></div></div>
      <div className="agent-token-create">
        <label>Token name<input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="Claude Code on laptop" /></label>
        <button className="primary-button" onClick={() => void createToken()} disabled={busy === 'agent-token' || !tokenName.trim()}>{busy === 'agent-token' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} Create token</button>
      </div>
      {revealedToken && <div className="agent-token-reveal">
        <div><strong>Copy this token now</strong><span>It is stored only as a hash and cannot be revealed again.</span></div>
        <code>{revealedToken}</code>
        <button className="secondary-button" onClick={() => void copyToken()}><Copy size={15} /> Copy</button>
      </div>}
      <div className="agent-token-command">
        <span>Run the local MCP server</span>
        <code>TREVRA_API_URL=http://localhost:43887 TREVRA_AGENT_TOKEN=… npm run mcp</code>
      </div>
      <div className="agent-token-list">
        {agentTokens.length === 0 && <p className="empty-copy">No agent tokens yet.</p>}
        {agentTokens.map((token) => <article key={token.id} className={token.revokedAt ? 'is-revoked' : undefined}>
          <div><strong>{token.name}</strong><code>{token.prefix}…</code></div>
          <span>{token.revokedAt ? 'Revoked' : token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'Never used'}</span>
          {!token.revokedAt && <button className="ghost-button danger" disabled={busy === token.id} onClick={() => void revokeToken(token.id)}>{busy === token.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Revoke</button>}
        </article>)}
      </div>
    </section>
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
  if (view === 'work') return 'Work and approvals';
  if (view === 'modules') return 'Modules and registry';
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
