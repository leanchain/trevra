import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  CircleHelp,
  Coins,
  Copy,
  FileCheck2,
  FileUp,
  Inbox,
  KeyRound,
  Linkedin,
  Link2,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Repeat,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Unplug,
  Workflow,
  X
} from 'lucide-react';
import type {
  AgentSetup,
  AgentTokenSummary,
  AutomationRule,
  AvailableIntegration,
  ConnectionSummary,
  DashboardPayload,
  PreparedAction,
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
  deleteAgentCliToken,
  disconnectIntegration,
  deleteAgentKey,
  deletePolicy,
  dismissRecommendation,
  endDemoSession,
  ensureSession,
  executeAction,
  getAgentSetup,
  getAgentTokens,
  getDashboard,
  getLinkedInCompanionStatus,
  getPolicies,
  getPublicConfig,
  importCommercialDocument,
  importMarketplace,
  markLinkedInCompanionPresence,
  prepareRecommendation,
  revokeAgentToken,
  runAutomation,
  saveAgentBudget,
  saveAgentCliConfig,
  saveAgentCliToken,
  saveAgentKey,
  saveAgentModelConfig,
  saveAgentSchedule,
  setAgentCliRiskAccepted,
  snoozeRecommendation,
  startAgentRun,
  startDemoSession,
  syncIntegration,
  updateAutomationRule
} from './api';
import { authClient } from './auth-client';
import { AccountsScreen } from './AccountsScreen';
import { OutreachCampaigns, OutreachPlan } from './LinkedInCampaigns';
import { OutreachInbox } from './LinkedInInbox';
import { OutreachLeads } from './LinkedInLeads';
import { LinkedInAccounts, LinkedInCompanionAttention } from './LinkedInAccounts';
import { OutreachActivity } from './LinkedInActivity';
import { OutreachManagerBuilder } from './LinkedInManagerBuilder';
import { OutreachManagerRead } from './LinkedInManagerRead';
import { reloadOutreach } from './LinkedInSafety';
import { LinkedInExclusions, LinkedInSeatSetup, OutreachQueue, OutreachSeat } from './LinkedInScreen';
import { TeamSettingsView } from './TeamScreen';
import { RedditScreen } from './RedditScreen';
import { ResearchScreen } from './ResearchScreen';
import { trackEvent, trackPageView } from './analytics';
import { ConfirmDrawer, useDialog } from './ui/dialog';
import { BrandMark } from './ui/BrandMark';
import { HelpPanel, JumpPalette, ShortcutSheet } from './ui/HelpPanel';
import { useShortcuts } from './ui/keys';
import { isAccountsPath, navigate, replaceNavigate, usePathname, useRoute, type Route, type Section } from './ui/route';
import { SeatPauseButton, StopBar, useStopControls } from './ui/StopBar';
import { formatEvery } from './ui/duration';
import { formatMoment } from './views/inspector';
import { LedgerView } from './views/LedgerView';
import { LoopCostView, LoopView, Metric } from './views/LoopView';
import { SkillsView } from './views/SkillsView';
import { clip, initials, money, prettyProvider, usd } from './views/format';
import {
  EmptyRecommendations,
  RecommendationList,
  automationDescription,
  iconFor,
  recommendationLabels,
  type RecommendationActions
} from './views/recommendations';

/**
 * Five screens, because the product is one loop with two ends.
 *
 * The old four -- Approvals, Activity, LinkedIn, Setup -- described an
 * accounts-receivable product that had grown an outreach engine in a side
 * pocket. Nothing on screen said the two halves were the same loop, so the app
 * read as two products sharing a login. See docs/gtm-shell-shape.md §2.
 *
 * `docs/app-spec.md` §4 used to say "Three nav items. Not six." That table
 * predates the LinkedIn engine and had already lost the argument to a fourth
 * item; §4 is amended in the same change rather than quietly contradicted.
 */
const NAV_ITEMS: Array<{ section: Section; path: string; icon: React.ReactNode; label: string }> = [
  { section: 'loop', path: '/loop', icon: <Repeat size={18} />, label: 'Loop' },
  { section: 'outreach', path: '/outreach', icon: <Linkedin size={18} />, label: 'Outreach' },
  { section: 'money', path: '/money', icon: <Coins size={18} />, label: 'Money' },
  { section: 'ledger', path: '/ledger', icon: <Workflow size={18} />, label: 'Ledger' },
  { section: 'setup', path: '/setup', icon: <Settings2 size={18} />, label: 'Setup' }
];

/**
 * The six sub-screens of `/outreach`, in the order the work happens: the seat
 * you are risking, the people you found, what is planned, the campaigns that
 * plan came from, what is queued to leave, and what came back.
 *
 * Kept next to `NAV_ITEMS` rather than inside the view, because these two lists
 * plus `SETUP_ROUTES` are every route the shell offers and they should be
 * readable in one place. Must stay a subset of `SUB_ROUTES.outreach`
 * (ui/route.ts): a tab pointing at a segment the router does not answer to
 * would silently land on the section root.
 */
const OUTREACH_ROUTES: Array<{ sub: string; label: string; advanced?: true }> = [
  { sub: '', label: 'LinkedIn accounts' },
  { sub: 'accounts', label: 'Target accounts' },
  { sub: 'leads', label: 'Find people' },
  { sub: 'manager', label: 'Campaigns' },
  { sub: 'inbox', label: 'Inbox' },
  { sub: 'activity', label: 'Activity' },
  // THE ADVANCED THREE, and the order is the order they are used in.
  //
  // These are the ORIGINAL path: build a sequence, get its exact wording
  // approved, then either hand it to the local worker's queue or export it for
  // a tool Trevra does not drive. It still works and some operators need it --
  // an export is the only route on a hosted deployment, which cannot drive a
  // browser at all.
  //
  // It is not, however, what a first-time operator should meet. "Campaigns"
  // above is the product: a lead list plus a workflow, started with one button
  // and advanced by the runner. Two surfaces both called campaigns is how
  // somebody spends an afternoon configuring the wrong one, so the primary one
  // takes the name and these three are marked as the deeper path.
  { sub: 'plan', label: 'Plan', advanced: true },
  { sub: 'campaigns', label: 'Approve & export', advanced: true },
  { sub: 'queue', label: 'Send queue', advanced: true }
];

type ToastMessage = { message: string; undo?: () => void };

/** How long a snooze or a dismissal can still be taken back. */
const UNDO_MS = 9000;

const reducedMotion = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * `/leads` is the legacy address for the target-account screen.
 *
 * Target accounts now live inside Outreach at `/outreach/accounts`, where the
 * job has the surrounding context it was missing as a sixth primary nav item.
 * Keep detecting the old path only so `App` can replace it without breaking
 * bookmarks or links somebody already shared.
 */
function useAccountsRoute(): boolean {
  return isAccountsPath(usePathname());
}

const HOSTED_MARKETING_SITE_URL = typeof window !== 'undefined' && window.location.hostname.startsWith('app.')
  ? `${window.location.protocol}//${window.location.hostname.slice(4)}`
  : 'https://usetrevra.com';

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" width="18" height="18">
    <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.875 2.684-6.614Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.715H.956v2.333A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.963 10.705A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.167.281-1.705V4.962H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.038l3.007-2.333Z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.463.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.333C4.672 5.165 6.656 3.58 9 3.58Z" />
  </svg>;
}

/**
 * The header plus the incident bar below it, sharing one seat read.
 *
 * `useStopControls` polls the seat and the agent runs; calling it twice --
 * once for a header button, once for the bar -- would be two pollers racing
 * to describe the same seat. This is the one place it is called, and both
 * `SeatPauseButton` (in `.top-actions`, beside sign-out) and `StopBar` (the
 * agent/everything rows below) are handed the same result.
 */
function ShellTop({ route, setOverlay, signOut, setToast }: {
  route: Route;
  setOverlay: (overlay: 'help' | 'shortcuts' | 'jump' | null) => void;
  signOut: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const controls = useStopControls(setToast);
  return <>
    <header className="topbar">
      <div><h1>{viewTitle(route)}</h1></div>
      {/* Sign-out lives here rather than in the sidebar, because below
          760px the sidebar is not on the screen at all. */}
      <div className="top-actions">
        <SeatPauseButton controls={controls} />
        <button
          className="icon-button"
          aria-label="What this screen is for"
          title="What this screen is for"
          onClick={() => setOverlay('help')}
        ><CircleHelp size={18} /></button>
        <ThemeToggle />
        <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}><LogOut size={18} /></button>
      </div>
    </header>

    {/* One incident surface, on every route. It is never a nav item and it
        survives below 760px, where the sidebar does not. */}
    <StopBar controls={controls} />
  </>;
}

export function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [needsAuth, setNeedsAuth] = useState<boolean | null>(null);
  // Where you are lives in the URL as one path, so every screen is
  // addressable, bookmarkable and Back-able -- and reachable by typing, which
  // is the only escape hatch a phone has when a nav goes missing.
  const [route, go] = useRoute();
  // Read beside the route rather than out of it: see `useAccountsRoute`.
  const accountsOpen = useAccountsRoute();
  // `/leads` was the old top-level address for target-company scoring. Keep
  // bookmarks working, but put the job where it belongs: inside Outreach.
  useEffect(() => { if (accountsOpen) replaceNavigate('/outreach/accounts'); }, [accountsOpen]);
  const [activeAction, setActiveAction] = useState<PreparedAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToastState] = useState<ToastMessage | null>(null);
  // Rows already off the list while their undo window is still open.
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<'help' | 'shortcuts' | 'jump' | null>(null);
  const setToast = (message: string) => setToastState(message ? { message } : null);
  // True once the fetch gating the loading screen has run past a reasonable
  // window with no answer yet -- see the stall timer in `load` below.
  const [loadStalled, setLoadStalled] = useState(false);
  // Last call wins, matching the token pattern every other screen in this
  // codebase already uses for a fetch that can overlap itself (a StrictMode
  // double-mount, or a person hammering "Try again"). Without it, an older
  // call finishing after a newer one could stomp the newer one's state.
  const loadToken = useRef(0);
  const loadStallTimer = useRef<number | null>(null);

  const load = async () => {
    const token = ++loadToken.current;
    setLoadStalled(false);
    if (loadStallTimer.current !== null) window.clearTimeout(loadStallTimer.current);
    // The loading screen used to have no ceiling: if `ensureSession` or
    // `getDashboard` never settled -- a stuck connection, a backend mid-restart
    // -- the spinner ran forever with nothing on screen to say so or to retry.
    // 12s is past any normal cold load and short enough that a real stall gets
    // an exit before the person watching it gives up and reloads by hand.
    loadStallTimer.current = window.setTimeout(() => {
      if (loadToken.current === token) setLoadStalled(true);
    }, 12_000);
    try {
      setError('');
      await ensureSession();
      const next = await getDashboard();
      if (loadToken.current !== token) return;
      setData(next);
      setNeedsAuth(false);
    } catch (err) {
      if (loadToken.current !== token) return;
      if (err instanceof ApiError && err.status === 401) {
        setData(null);
        setNeedsAuth(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load Trevra');
    } finally {
      if (loadToken.current === token && loadStallTimer.current !== null) {
        window.clearTimeout(loadStallTimer.current);
        loadStallTimer.current = null;
      }
    }
  };

  useEffect(() => {
    void load();
    return () => { if (loadStallTimer.current !== null) window.clearTimeout(loadStallTimer.current); };
  }, []);

  /**
   * A paired LinkedIn computer runs only while a signed-in Trevra tab is alive.
   *
   * Presence is a LEASE, not an on/off flag: the server expires it if this tab
   * vanishes, the laptop sleeps or the network drops. That avoids a pagehide
   * from one tab turning off a second Trevra tab that is still open. A newly
   * paired/revoked device announces itself through one small window event so
   * this shell can start/stop the heartbeat without a reload.
   */
  useEffect(() => {
    if (needsAuth !== false) return undefined;
    let disposed = false;
    let heartbeat: number | null = null;

    const stopTimer = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    };
    const activateIfPaired = async () => {
      try {
        const status = await getLinkedInCompanionStatus();
        if (disposed) return;
        stopTimer();
        if (status.devices.length === 0 || !status.canUse) return;
        await markLinkedInCompanionPresence();
        if (disposed) return;
        heartbeat = window.setInterval(() => {
          void markLinkedInCompanionPresence().catch(() => undefined);
        }, 45_000);
      } catch {
        // Presence is a convenience gate, never something that should make the
        // whole app fail to load. The server simply lets the lease expire.
      }
    };
    const changed = () => { void activateIfPaired(); };
    window.addEventListener('trevra:linkedin-companion-changed', changed);
    void activateIfPaired();
    return () => {
      disposed = true;
      stopTimer();
      window.removeEventListener('trevra:linkedin-companion-changed', changed);
    };
  }, [needsAuth]);

  // Fired per screen, not once per session: page views that cannot see
  // navigation cannot tell you anything about navigation.
  useEffect(() => { trackPageView(); }, [route.path]);
  useEffect(() => {
    // An undo toast lives exactly as long as its undo window, so the button is
    // never on screen after it has stopped working.
    if (!toast || toast.undo) return;
    // 5s was under the time it takes to read the message, and the toast is the
    // only success confirmation in the product.
    const hold = Math.min(14_000, Math.max(7_000, toast.message.length * 60));
    const timer = window.setTimeout(() => setToastState(null), hold);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useShortcuts({
    onJump: () => setOverlay('jump'),
    onSheet: () => setOverlay('shortcuts'),
    // A dialog owns the keyboard while it is open, and `useDialog` traps Tab
    // and Escape inside it. A global binding firing underneath would be a
    // second thing listening to keys that are not addressed to it.
    suspended: overlay !== null || activeAction !== null
  });

  const prepare = async (recommendation: Recommendation) => {
    setBusyId(recommendation.id);
    try {
      const action = recommendation.preparedAction ?? await prepareRecommendation(recommendation.id);
      setActiveAction(action);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Unable to prepare action');
    } finally { setBusyId(null); }
  };

  /**
   * Snooze and dismiss are deferred, not fired.
   *
   * There is no route that reopens a snoozed or dismissed recommendation, so an
   * Undo offered after the write would be a promise the product cannot keep.
   * Instead the row leaves the list at once and the write goes out when the undo
   * window closes -- which is the only version of Undo that is true.
   */
  const pending = useRef<{ id: string; commit: () => Promise<void>; timer: number } | null>(null);

  const commitPending = async () => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    window.clearTimeout(job.timer);
    setToastState((current) => (current?.undo ? null : current));
    try {
      await job.commit();
      await load();
    } catch (err) {
      setToastState({ message: err instanceof Error ? err.message : 'That did not go through — nothing changed. Try it again.' });
    } finally {
      setHiddenIds((ids) => ids.filter((id) => id !== job.id));
    }
  };

  const deferRemoval = (id: string, message: string, commit: () => Promise<void>) => {
    // One at a time: starting a second lets the first one through.
    void commitPending();
    setHiddenIds((ids) => [...ids, id]);
    const timer = window.setTimeout(() => { void commitPending(); }, UNDO_MS);
    pending.current = { id, commit, timer };
    setToastState({
      message,
      undo: () => {
        const job = pending.current;
        if (!job) return;
        pending.current = null;
        window.clearTimeout(job.timer);
        setHiddenIds((ids) => ids.filter((entry) => entry !== job.id));
        setToastState(null);
      }
    });
  };

  // A tab closed inside the undo window must not quietly drop a write the toast
  // has already said happened.
  useEffect(() => {
    const flush = () => { void commitPending(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);

  const snooze = (id: string) => deferRemoval(id, 'Snoozed for 3 days. It comes back then.', () => snoozeRecommendation(id));

  const dismiss = (id: string) => deferRemoval(id, 'Dismissed. Trevra will not raise it again.', () => dismissRecommendation(id, 'Not useful right now'));

  const signOut = async () => {
    await Promise.allSettled([authClient.signOut(), endDemoSession()]);
    setData(null);
    setNeedsAuth(true);
    // Back to the front door, not to `/login`: signing out and being handed the
    // sign-in form is a loop, and the address has to stop naming a screen that
    // is no longer on it.
    navigate('/');
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

  // The bare spinner, and what replaces it once a stall has run past the
  // window above: the same error/retry shape every other read failure on this
  // screen already uses, not a second visual language for "still nothing".
  const loadingGate = <div className="center-state"><LoaderCircle className="spin" /> <span>Building your revenue brief…</span></div>;
  const stalledGate = <div className="center-state error">
    <p>Still trying to reach Trevra. This is taking longer than it should.</p>
    <button onClick={() => void load()}>Try again</button>
  </div>;

  if (needsAuth === null) return loadStalled ? stalledGate : loadingGate;
  if (needsAuth) return <AuthScreen onAuthenticated={load} onBack={() => window.location.assign(HOSTED_MARKETING_SITE_URL)} />;
  if (!data && !error) return loadStalled ? stalledGate : loadingGate;
  if (error) return <div className="center-state error"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>;
  if (!data) return null;

  // What is actually on the list right now, which is not the server's count
  // while something is sitting inside its undo window.
  const open = data.recommendations.filter((item) => !hiddenIds.includes(item.id));
  const recommendationActions: RecommendationActions = {
    busyId, onPrepare: prepare, onSnooze: snooze, onDismiss: dismiss
  };

  return (
    <div className="app-shell">
      {/* Five nav items and a sign-out precede the content on every load. One
          key gets past all of them. `href` is kept for the semantics and the
          default is prevented, because assigning `#main` would overwrite the
          route the hash is carrying. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main');
          main?.focus({ preventScroll: false });
        }}
      >Skip to what is on this screen</a>

      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><BrandMark /></span><span>Trevra</span></div>
        <nav>
          {NAV_ITEMS.map((item) => <NavButton
            key={item.section}
            active={route.section === item.section}
            icon={item.icon}
            label={item.label}
            // The unread count sits where clicking it already goes somewhere.
            badge={item.section === 'money' ? open.length : undefined}
            onClick={() => go(item.path)}
          />)}
        </nav>
        <div className="sidebar-promise">
        </div>
        <div className="sidebar-bottom">
          <div className="workspace-avatar">{initials(data.workspace.name)}</div>
          <div><strong>{data.workspace.name}</strong><span>{data.metrics.connectedSources} connected</span></div>
        </div>
        {/* Only when there is somewhere else to switch TO -- team-workspace-
            access design's "a dropdown in the app shell, shown only when
            organization.list returns more than one workspace". A member of
            exactly one workspace never sees a control for a choice he does
            not have. */}
        <WorkspaceSwitcher activeWorkspaceId={data.workspace.id} onSwitched={async () => { await load(); await reloadOutreach(); }} />
      </aside>

      <main className="main" id="main" tabIndex={-1}>
        <ShellTop route={route} setOverlay={setOverlay} signOut={signOut} setToast={setToast} />

        {route.section === 'loop' && (route.sub === 'cost'
          ? <LoopCostView onNavigate={go} />
          : <LoopView
            data={data}
            recommendations={open}
            actions={recommendationActions}
            onNavigate={go}
          />)}

        {route.section === 'outreach' && <div className="page-stack">
          <LinkedInCompanionAttention setToast={setToast} />
          {/* Same markup and class family as Setup's strip, because it is the
              same control and a second dialect would be a second thing to
              learn. The one addition is the divider: the last three tabs are
              the approve-and-export path, which is a different job from the
              first four and should not read as a continuation of them. */}
          <nav className="outreach-nav" aria-label="Outreach sections">
            {OUTREACH_ROUTES.map((entry, index) => <Fragment key={entry.sub}>
              {entry.advanced && !OUTREACH_ROUTES[index - 1]?.advanced && <span className="outreach-nav-divider" aria-hidden="true" />}
              <button
                type="button"
                className={route.sub === entry.sub ? 'is-active' : entry.advanced ? 'is-advanced' : undefined}
                aria-current={route.sub === entry.sub ? 'page' : undefined}
                onClick={() => go(`/outreach${entry.sub ? `/${entry.sub}` : ''}`)}
              >{entry.label}</button>
            </Fragment>)}
          </nav>

          {/* Accounts first: which LinkedIn accounts exist, which one you are
              working in, and how to add another. The seat panel below it is
              the detail for the active one. */}
          {route.sub === '' && <LinkedInAccounts setToast={setToast} />}
          {route.sub === '' && <OutreachSeat setToast={setToast} />}
          {route.sub === 'accounts' && <AccountsScreen setToast={setToast} />}
          {route.sub === 'campaigns' && <OutreachCampaigns setToast={setToast} campaignId={route.id} />}
          {route.sub === 'inbox' && <OutreachInbox setToast={setToast} />}
          {route.sub === 'activity' && <OutreachActivity />}
          {route.sub === 'leads' && <OutreachLeads setToast={setToast} />}
          {route.sub === 'manager' && (route.id === 'new'
            ? <OutreachManagerBuilder setToast={setToast} onNavigate={go} />
            : <OutreachManagerRead setToast={setToast} onNavigate={go} />)}
          {route.sub === 'plan' && <OutreachPlan setToast={setToast} />}
          {route.sub === 'queue' && <OutreachQueue setToast={setToast} />}
        </div>}

        {route.section === 'money' && <MoneyView
          data={data}
          recommendations={open}
          actions={recommendationActions}
          onNavigate={go}
        />}

        {route.section === 'ledger' && <LedgerView runId={route.id} setToast={setToast} onNavigate={go} />}

        {route.section === 'setup' && <SetupView
          route={route}
          data={data}
          reload={load}
          setToast={setToast}
          busyId={busyId}
          setBusyId={setBusyId}
          onNavigate={go}
        />}
      </main>

      {/* Below 760px the sidebar is gone and with it every route out of this
          screen. Rendered always; the stylesheet hides it above 760px. */}
      <nav className="mobile-tabbar" aria-label="Sections">
        {NAV_ITEMS.map((item) => <button
          key={item.section}
          type="button"
          className={route.section === item.section ? 'is-active' : undefined}
          aria-current={route.section === item.section ? 'page' : undefined}
          onClick={() => go(item.path)}
        >{item.icon}<span>{item.label}</span></button>)}
      </nav>

      {activeAction && (
        <ActionDrawer
          action={activeAction}
          busy={busyId === activeAction.id}
          onChange={setActiveAction}
          onClose={() => setActiveAction(null)}
          onExecute={() => void execute()}
        />
      )}

      {overlay === 'help' && <HelpPanel route={route} onClose={() => setOverlay(null)} />}
      {overlay === 'shortcuts' && <ShortcutSheet onClose={() => setOverlay(null)} />}
      {overlay === 'jump' && <JumpPalette onGo={go} onClose={() => setOverlay(null)} />}

      {/* A live region that outlives its messages -- announcing a toast means
          the region has to already be there when the text arrives -- and one
          mounted outside `.app-shell`, so an open dialog's `inert` cannot
          silence the product's only success confirmation. */}
      {createPortal(
        <div className="toast" role="status" style={toast ? { cursor: 'default' } : HIDDEN_LIVE_REGION}>
          {toast && <>
            <Check size={16} />
            <span>{toast.message}</span>
            {toast.undo && <button className="ghost-button" onClick={toast.undo}>Undo</button>}
            <button className="ghost-button" aria-label="Dismiss this message" onClick={() => setToastState(null)}><X size={14} /></button>
          </>}
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * The same switch the marketing site has, on the same attribute and the same
 * storage key, so a choice made before signing in survives signing in.
 *
 * `/theme.js` owns the state: it is a blocking script in the document head that
 * stamps `data-theme` before first paint and binds every `[data-theme-toggle]`
 * by delegation. So this renders markup and nothing else -- no handler, no
 * second copy of the state, one source of truth.
 */
function ThemeToggle() {
  return <button type="button" className="icon-button theme-toggle" data-theme-toggle aria-label="Switch theme">
    <svg className="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </svg>
    <svg className="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  </button>;
}

/* `display: none` takes a live region out of the accessibility tree, so the
   first message would arrive at a region the reader never saw appear. Empty, it
   stays mounted and unseen instead. */
const HIDDEN_LIVE_REGION: React.CSSProperties = {
  position: 'fixed', width: 1, height: 1, margin: -1, padding: 0, border: 0,
  overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', pointerEvents: 'none'
};

/* --------------------------------------------------------------------------
 * Setup, split into routes.
 *
 * It used to be one unbroken scroll of agent access, keys, spending,
 * connections, imports, autopilot, limits and modules, with a jump strip on
 * top. Changing a spend cap meant scrolling past all of it, and a jump is not
 * a URL: nobody could be sent a link to the limits.
 * -------------------------------------------------------------------------- */

/**
 * `spend` is deliberately NOT in here.
 *
 * It was a tab that rendered the Agent access screen and then scroll-jumped
 * inside it, so the strip underlined a section you were not on and the title
 * named a screen that does not exist. The block's own reasoning is why it
 * cannot be split out: where your key goes, your key, and what it may spend
 * are one decision in one order, and a separate screen would ask an operator
 * to set a cap for a key nobody has asked them for yet.
 *
 * So `/setup/spend` survives as a DEEP LINK -- "Change the cap" on the cost
 * screen still points at it, and it still lands on the cap -- and stops
 * pretending to be a peer of the six screens that are real.
 */
const SETUP_ROUTES: Array<{ sub: string; label: string; advanced?: true }> = [
  { sub: 'agent', label: 'Agent access' },
  { sub: 'data', label: 'Connections' },
  { sub: 'seat', label: 'LinkedIn' },
  // Safety controls stay visible. They are not expert configuration even when
  // most people change them rarely.
  { sub: 'limits', label: 'Limits' },
  { sub: 'team', label: 'Team' },
  { sub: 'research', label: 'Research', advanced: true },
  { sub: 'reddit', label: 'Reddit', advanced: true },
  { sub: 'skills', label: 'Skills', advanced: true }
];

const SETUP_PRIMARY_ROUTES = SETUP_ROUTES.filter((entry) => !entry.advanced);
const SETUP_ADVANCED_ROUTES = SETUP_ROUTES.filter((entry) => entry.advanced);

function SetupView({ route, data, reload, setToast, busyId, setBusyId, onNavigate }: {
  route: Route;
  data: DashboardPayload;
  reload: () => Promise<void>;
  setToast: (message: string) => void;
  busyId: string | null;
  setBusyId: (id: string | null) => void;
  onNavigate: (path: string) => void;
}) {
  // `/setup` on its own is agent access: nothing else in Trevra works until
  // an agent can reach the workspace, so it is both the first tab and the
  // default one. See docs/app-spec.md §9.
  const sub = route.sub === '' ? 'agent' : route.sub;

  // `/setup/spend` is a deep link into the Agent access screen, not a screen.
  // The strip below underlines Agent access for it, because that is where the
  // reader ends up.
  const navSub = sub === 'spend' ? 'agent' : sub;

  useEffect(() => {
    if (sub !== 'spend') return;
    // The block is inside a panel that renders nothing until its own read
    // lands, so the element is not there on the first frame. Look for it for a
    // couple of seconds and then stop -- a deployment without the hosted agent
    // has no such block at all, and hunting forever would be a leak.
    let tries = 0;
    const timer = window.setInterval(() => {
      const target = document.getElementById('setup-spend');
      if (target) {
        window.clearInterval(timer);
        target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        // The caret follows the eye, so the keyboard carries on from the jump
        // rather than from the top of the page.
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        return;
      }
      if (++tries > 20) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [sub]);

  return <div className="page-stack">
    <nav className="setup-nav" aria-label="Setup sections">
      {SETUP_PRIMARY_ROUTES.map((entry) => <button
        key={entry.sub}
        type="button"
        className={navSub === entry.sub ? 'is-active' : undefined}
        aria-current={navSub === entry.sub ? 'page' : undefined}
        onClick={() => onNavigate(`/setup/${entry.sub}`)}
      >{entry.label}</button>)}
      <label className={`setup-more-select${SETUP_ADVANCED_ROUTES.some((entry) => entry.sub === navSub) ? ' is-active' : ''}`}>
        <span className="sr-only">More setup sections</span>
        <select
          aria-label="More setup sections"
          value={SETUP_ADVANCED_ROUTES.some((entry) => entry.sub === navSub) ? navSub : ''}
          onChange={(event) => { if (event.target.value) onNavigate(`/setup/${event.target.value}`); }}
        >
          <option value="">More…</option>
          {SETUP_ADVANCED_ROUTES.map((entry) => <option key={entry.sub} value={entry.sub}>{entry.label}</option>)}
        </select>
      </label>
    </nav>

    {(sub === 'agent' || sub === 'spend') && <>
      <AgentAccessPanel setToast={setToast} />
      <HostedAgentPanel setToast={setToast} onInspectRun={(runId) => onNavigate(`/ledger/run/${runId}`)} />
    </>}

    {sub === 'data' && <ConnectionsView
      data={data}
      reload={reload}
      setToast={setToast}
      busyId={busyId}
      setBusyId={setBusyId}
    />}

    {sub === 'research' && <ResearchScreen connections={data.connections} setToast={setToast} />}

    {sub === 'seat' && <LinkedInSeatSetup setToast={setToast} />}

    {sub === 'reddit' && <RedditScreen setToast={setToast} />}

    {sub === 'skills' && <SkillsView setToast={setToast} onNavigate={onNavigate} />}

    {sub === 'limits' && <>
      <AutopilotView rules={data.automationRules} reload={reload} setToast={setToast} />
      <LinkedInExclusions setToast={setToast} />
    </>}

    {sub === 'team' && <TeamSettingsView route={route} setToast={setToast} reload={reload} onNavigate={onNavigate} />}
  </div>;
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
  const [emailPasswordEnabled, setEmailPasswordEnabled] = useState(false);

  useEffect(() => {
    void getPublicConfig().then((config) => {
      setGoogleEnabled(config.googleAuthEnabled);
      setEmailPasswordEnabled(config.emailPasswordAuthEnabled);
    }).catch(() => undefined);
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
        <a className="brand auth-brand" href="/" onClick={(event) => { event.preventDefault(); onBack(); }}><span className="brand-mark"><BrandMark /></span><span>Trevra</span></a>
        <div><h1>Run GTM with Claude Code or Codex.</h1><p>Research, outreach, revenue actions, approvals, and run history in one workspace.</p></div>
        <div className="auth-proof-list"><span><Check size={16} /> Evidence on every recommendation</span><span><Check size={16} /> Approval before external actions</span><span><Check size={16} /> Hard limits for agents</span><span><Check size={16} /> Open source and self-hostable</span></div>
      </section>
      <section className="auth-panel" id="get-started">
        <div className="auth-card">
          <span className="auth-icon"><ShieldCheck /></span>
          <h2>{mode === 'signin' ? 'Sign in to Trevra' : 'Create your workspace'}</h2>
          <p>{mode === 'signin' ? 'Continue to your workspace.' : 'Create a Trevra workspace.'}</p>
          {googleEnabled && <button className="google-auth-button" disabled={busy || googleBusy} onClick={() => void signInWithGoogle()}>{googleBusy ? <LoaderCircle className="spin" size={17} /> : <GoogleMark />}Continue with Google</button>}
          {googleEnabled && emailPasswordEnabled && <div className="auth-divider"><span>or</span></div>}
          {emailPasswordEnabled && <>
            {mode === 'signup' && <label>Name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Morgan" /></label>}
            <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
            <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} /></label>
          </>}
          {authError && <div className="error-banner">{authError}</div>}
          {emailPasswordEnabled && <button className="primary-button auth-submit" disabled={busy || googleBusy || !email || password.length < 10 || (mode === 'signup' && !name.trim())} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{mode === 'signin' ? 'Sign in' : 'Create workspace'}</button>}
          {import.meta.env.DEV && <button className="ghost-button auth-submit" disabled={busy || googleBusy} onClick={() => void startDemoSession().then(onAuthenticated)}>Open demo</button>}
          {emailPasswordEnabled && <button className="auth-switch" onClick={switchMode}>{mode === 'signin' ? 'Create an account' : 'Sign in instead'}</button>}
          <button className="auth-switch" onClick={onBack}>← Back to site</button>
          <p className="auth-consent">By continuing, you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Notice</a>.</p>
          <div className="auth-legal-links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a><a href="/how-it-works">How it works</a></div>
        </div>
      </section>
    </div>
  </main>;
}
/**
 * Connect Claude Code or Codex in one click.
 *
 * This is the most important button in the product: the operator is an agent,
 * so a workspace no agent can reach does nothing. It used to be seven manual
 * steps at the bottom of Autopilot -- name a token, create it, copy it, then
 * hand-assemble a command from the docs. Now it mints the token and hands back
 * the exact line to paste, with the real host and token already in it.
 *
 * The token is shown ONCE. It is stored as a hash, so the command is built
 * here, in the browser, at the only moment the secret exists.
 */
function AgentAccessPanel({ setToast }: { setToast: (message: string) => void }) {
  const [tokens, setTokens] = useState<AgentTokenSummary[]>([]);
  const [revealed, setRevealed] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [target, setTarget] = useState<'claude' | 'codex'>('claude');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AgentTokenSummary | null>(null);

  const reload = async () => setTokens(await getAgentTokens());

  useEffect(() => {
    void reload().catch(() => undefined);
    void getPublicConfig()
      .then((config) => setApiBaseUrl(config.apiBaseUrl ?? window.location.origin))
      .catch(() => setApiBaseUrl(window.location.origin));
  }, []);

  const active = tokens.filter((token) => !token.revokedAt);

  const create = async () => {
    setBusy('create');
    try {
      // Auto-named. Asking a founder to invent a token name before they can
      // connect anything was a question with no useful answer.
      const created = await createAgentToken({ name: `${target === 'claude' ? 'Claude Code' : 'Codex'} · ${new Date().toLocaleDateString()}` });
      setRevealed(created.token);
      await reload();
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not create the token');
    } finally { setBusy(''); }
  };

  const revoke = async (tokenId: string) => {
    setBusy(tokenId);
    try {
      await revokeAgentToken(tokenId);
      await reload();
      setToast('Access revoked. Any session using that token is now locked out.');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not revoke that token. Try again in a moment.');
    } finally { setBusy(''); setConfirmRevoke(null); }
  };

  const mcpUrl = `${apiBaseUrl || window.location.origin}/api/agent/mcp`;
  const secret = revealed || '<your-token>';
  const command = target === 'claude'
    ? `claude mcp add trevra --scope project --transport http ${mcpUrl} --header "Authorization: Bearer ${secret}"`
    : `export TREVRA_AGENT_TOKEN=${secret}\ncodex mcp add trevra --url ${mcpUrl} --bearer-token-env-var TREVRA_AGENT_TOKEN`;

  const copy = async () => {
    if (!revealed) {
      setToast('Click "Create access" first to generate your command');
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setToast('Command copied — paste it in your terminal');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setToast('Could not copy. Select the command and copy it manually.');
    }
  };

  return <section className="page-panel agent-panel" id="setup-agent">
    <div className="section-heading">
      <div>
        {/* aria-level, not <h2>: the page title is the topbar's h1, so a bare
            h3 here skips a level. The element stays h3 because that is what
            styles.css paints. */}
        <h3 aria-level={2}><Terminal size={18} /> Connect Claude Code or Codex</h3>
        <p>Trevra is run by your coding agent. Paste one line and it can read your revenue brief, run jobs, and prepare work — it can never approve or send anything.</p>
      </div>
      <span className="status-pill">{active.length} connected</span>
    </div>

    <div className="agent-target-switch">
      <button className={target === 'claude' ? 'is-active' : undefined} onClick={() => setTarget('claude')}>Claude Code</button>
      <button className={target === 'codex' ? 'is-active' : undefined} onClick={() => setTarget('codex')}>Codex</button>
    </div>

    {!revealed && (
      <button className="primary-button agent-create" onClick={() => void create()} disabled={busy === 'create'}>
        {busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
        Create access for {target === 'claude' ? 'Claude Code' : 'Codex'}
      </button>
    )}

    <div className="agent-command">
      <div className="agent-command-head">
        <span>{revealed ? 'Paste this in your terminal' : 'Your command will look like this'}</span>
        <button className="secondary-button" onClick={() => void copy()}>{copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}</button>
      </div>
      <pre><code>{command}</code></pre>
      {revealed
        ? <p className="agent-command-note">This is the only time the token is shown — Trevra stores it hashed. Lost it? Create another.</p>
        : <p className="agent-command-note">Create access above and the real token drops straight into this command.</p>}
      {target === 'claude' && <p className="agent-command-note">Run this from the project directory you want Trevra wired into. <code>--scope project</code> writes the server to that project's <code>.mcp.json</code> instead of your global config, so it only loads there — not in every Claude Code session — and can be shared with teammates via version control. Prefer it truly local and unshared? Drop <code>--scope project</code> to use the default <code>local</code> scope instead.</p>}
    </div>

    {active.length > 0 && <div className="agent-token-list">
      {tokens.map((token) => <article key={token.id} className={token.revokedAt ? 'is-revoked' : undefined}>
        <div><strong>{token.name}</strong><code>{token.prefix}…</code></div>
        <span>{token.revokedAt ? 'Revoked' : token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'Not used yet'}</span>
        {!token.revokedAt && <button className="ghost-button danger" disabled={busy === token.id} onClick={() => setConfirmRevoke(token)}>{busy === token.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Revoke</button>}
      </article>)}
    </div>}

    {confirmRevoke && <ConfirmDrawer
      title="Revoke this access?"
      tone="danger"
      body={<>
        <p><strong>{confirmRevoke.name}</strong> (<code>{confirmRevoke.prefix}…</code>) stops working the moment you revoke it. Any Claude Code or Codex session holding that token loses this workspace mid-job.</p>
        <p>Revoking cannot be undone. You can create fresh access straight afterwards, but you have to paste the new command everywhere this token was used.</p>
      </>}
      confirmLabel="Revoke this access"
      busy={busy === confirmRevoke.id}
      onCancel={() => setConfirmRevoke(null)}
      onConfirm={() => void revoke(confirmRevoke.id)}
    />}
  </section>;
}

/** How often the standing job runs, said the way a person would say it. */
const SCHEDULE_CHOICES = [60, 240, 720, 1440, 10080];

/**
 * Turn a failure from the setup routes into something a founder can act on.
 *
 * A status code is not an explanation. The 400s are already written for a
 * person -- the server owns the endpoint rules and says them in words -- so
 * those pass through, with the field name swapped for the thing it names.
 */
function agentSetupMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This workspace is on a build that does not run Trevra’s own agent yet. Your own agent above still works.';
    if (error.status === 409) return 'Nothing ran: spending is switched off, or this month’s cap is already used up.';
    if (error.status === 429) return 'Too many attempts in a row. Wait a minute, then try again.';
    if (error.status >= 500) return 'Trevra could not save that. Try again in a moment.';
    return error.message
      .replace(/^baseUrl /, 'The endpoint address ')
      .replace(/^model is required$/, 'Name the model you want it to use.');
  }
  return error instanceof Error ? error.message : fallback;
}

/** `a`, `a and b`, `a, b and c` -- for naming which parts of one save went through. */
const andList = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

/**
 * Trevra's agent, running on the operator's own key.
 *
 * The second way to be the operator (app-spec §2): identical permissions to
 * the laptop agent, on Trevra's side, so it keeps working when the laptop is
 * shut. Nothing here can approve or send -- see app-spec §11.
 *
 * Two deliberate absences.
 *
 * There is no reveal, no "show key", no copy-key control. Plaintext leaves
 * exactly one internal function on the server, at the moment of a model call,
 * and no route returns it at any privilege -- so such a control could not be
 * wired to anything, and adding one is a server redesign, not a UI change.
 *
 * And the warning is the first thing in the panel rather than a footnote under
 * the field. A hosted service holding customer model keys is a real,
 * concentrated liability; the design doc's §7 says the operator deserves to
 * weigh that before pasting, which only means anything if they read it first.
 *
 * ONE SAVE, NOT FOUR. Setting this up used to cost four round-trips and four
 * toasts -- Save endpoint, Store key, Save cap, Save schedule -- for what is
 * one sitting. The three blocks keep their order, their headings and their
 * argument, because that order IS the decision: where your key goes, then your
 * key, then what it may spend. What changed is that the button moved to the
 * bottom and writes only the parts that changed.
 *
 * Two writes stay on their own, and both for the same stated reason: an off
 * switch that needs a second click to take effect is not an off switch. The
 * spending toggle and the schedule toggle fire immediately.
 */
function HostedAgentPanel({ setToast, onInspectRun }: {
  setToast: (message: string) => void;
  onInspectRun: (runId: string) => void;
}) {
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [providerLabel, setProviderLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(false);
  const [capDollars, setCapDollars] = useState('20');
  const [goal, setGoal] = useState('');
  const [every, setEvery] = useState('1440');
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);
  // The third way to run the hosted agent: a workspace's own Claude/Codex
  // subscription (docs/cli-agent-and-hosted.md). Mirrors the BYOK state above.
  const [cliKind, setCliKind] = useState<'claude' | 'codex'>('claude');
  const [cliModel, setCliModel] = useState('');
  const [cliToken, setCliToken] = useState('');
  const [replacingCliToken, setReplacingCliToken] = useState(false);
  const [confirmRemoveCliToken, setConfirmRemoveCliToken] = useState(false);

  useEffect(() => {
    void getAgentSetup()
      .then((next) => {
        if (!next) return;
        setSetup(next);
        setBaseUrl(next.config?.baseUrl ?? '');
        setModel(next.config?.model ?? '');
        setProviderLabel(next.config?.label ?? next.secret?.label ?? '');
        setCapDollars(String(Math.round(next.budget.monthlyCapCents / 100)));
        if (next.schedule) {
          setGoal(next.schedule.goal ?? '');
          if (next.schedule.intervalMinutes > 0) setEvery(String(next.schedule.intervalMinutes));
        }
        if (next.cli.config) {
          setCliKind(next.cli.config.cli);
          setCliModel(next.cli.config.model);
        }
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const removeKey = async () => {
    setBusy('key-remove');
    setProblem('');
    try {
      await deleteAgentKey();
      setSetup((current) => current && { ...current, secret: null });
      setApiKey('');
      setReplacingKey(false);
      setToast('Key removed here. Revoke it at your provider too.');
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not remove the key'));
    } finally { setBusy(''); setConfirmRemoveKey(false); }
  };

  const removeCliToken = async () => {
    setBusy('cli-token-remove');
    setProblem('');
    try {
      await deleteAgentCliToken();
      setSetup((current) => current && { ...current, cli: { ...current.cli, tokenStored: false } });
      setCliToken('');
      setReplacingCliToken(false);
      setToast('Subscription token removed here. If you are unsure why, revoke the session at your provider too.');
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not remove the subscription token'));
    } finally { setBusy(''); setConfirmRemoveCliToken(false); }
  };

  // Its own write, not part of Save, for the same reason the spend and
  // schedule switches are: revoking consent must take effect in one click, and
  // must never be a side effect of saving something else.
  const setCliRisk = async (accepted: boolean) => {
    setBusy('cli-risk');
    setProblem('');
    try {
      const riskAccepted = await setAgentCliRiskAccepted(accepted);
      setSetup((current) => current && { ...current, cli: { ...current.cli, riskAccepted } });
      setToast(accepted
        ? 'Risk accepted. You can now store a subscription token below.'
        : 'Risk acceptance withdrawn. The subscription CLI will not run until you accept it again.');
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not change the risk acceptance'));
    } finally { setBusy(''); }
  };

  // Its own write, not part of Save: an off switch that needs a second click
  // to take effect is not an off switch.
  const setSpending = async (enabled: boolean) => {
    setBusy('spend');
    setProblem('');
    try {
      const budget = await saveAgentBudget({ enabled });
      setSetup((current) => current && { ...current, budget });
      setToast(enabled
        ? `Spending on, up to ${usd(budget.monthlyCapCents)} a month.`
        : 'Spending off. Trevra will not pay for another model call.');
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not change the spending switch'));
    } finally { setBusy(''); }
  };

  const setScheduleEnabled = async (enabled: boolean) => {
    setBusy('schedule-switch');
    setProblem('');
    try {
      const schedule = await saveAgentSchedule({ enabled });
      setSetup((current) => current && { ...current, schedule });
      setToast(enabled ? 'Autopilot on' : 'Autopilot off');
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not change the schedule switch'));
    } finally { setBusy(''); }
  };

  const runNow = async () => {
    const job = goal.trim();
    if (!job) return;
    setBusy('run');
    setProblem('');
    try {
      const run = await startAgentRun({ goal: job });
      setToast('Started. Every step it takes shows up in the run ledger as it happens.');
      onInspectRun(run.id);
    } catch (error) {
      setProblem(agentSetupMessage(error, 'Could not start the run'));
    } finally { setBusy(''); }
  };

  // Nothing at all rather than a broken panel: a build without the hosted
  // agent has no such route, and "this feature is not here" is not a question
  // to hand a founder.
  if (!loaded || !setup) return null;

  const { available, config, secret, budget } = setup;
  const schedule = setup.schedule;
  const hasSchedule = schedule !== undefined;

  const heading = <div className="section-heading">
    <div>
      <h3 aria-level={2}><Bot size={18} /> Or let Trevra run the agent, on your key</h3>
      <p>The same work, the same limits, on Trevra’s side instead of yours — so it keeps going with your laptop closed. It reads, researches and prepares. Like the agent above, it can never approve or send anything.</p>
    </div>
    <span className="status-pill">{!available ? 'Switched off' : secret ? 'Key stored' : 'Not set up'}</span>
  </div>;

  // No key field at all when the deployment cannot encrypt one. Offering a
  // paste box that is guaranteed to fail is worse than saying so.
  if (!available) return <section className="page-panel agent-panel byok-panel">
    {heading}
    <div className="byok-warning byok-warning-off">
      <CircleAlert size={18} />
      <div>
        <strong>This is switched off on this server.</strong>
        <p>There is nowhere here to encrypt a model key, so there is nothing to set up and nothing to paste. Your own agent above is unaffected and does the same work while you are at the keyboard.</p>
        <p>Running Trevra yourself? Whoever administers this server can switch it on, and this section fills in.</p>
      </div>
    </div>
  </section>;

  const capCents = Math.round(Number(capDollars) * 100);
  const capValid = Number.isFinite(Number(capDollars)) && Number(capDollars) >= 0 && Number(capDollars) <= 10_000;

  // What is on screen and not yet on the server, block by block. Each one is
  // also what the single Save writes -- it never sends a call for a block
  // nobody touched.
  const dirtyConfig = config
    ? baseUrl.trim() !== config.baseUrl || model.trim() !== config.model || (providerLabel.trim() || '') !== (config.label ?? '')
    : Boolean(baseUrl.trim() || model.trim());
  const dirtyKey = apiKey.trim().length > 0;
  const dirtyCap = capValid && capCents !== budget.monthlyCapCents;
  const dirtySchedule = hasSchedule && Boolean(schedule)
    && (goal.trim() !== (schedule?.goal ?? '') || Number(every) !== schedule?.intervalMinutes);

  const cliSetup = setup.cli;
  const dirtyCliConfig = cliSetup.config
    ? cliKind !== cliSetup.config.cli || cliModel.trim() !== cliSetup.config.model
    : Boolean(cliModel.trim());
  // Saved and not currently being edited -- the same gate the schedule toggle
  // below uses on its own goal ("disabled={... || !goal.trim() || dirtySchedule}"):
  // there is nothing to accept the risk of until a CLI and a model are on
  // record, and editing them mid-flight should not leave a stale acceptance
  // pointed at a config that no longer matches what is on screen.
  const cliConfigSaved = Boolean(cliSetup.config) && !dirtyCliConfig;
  const dirtyCliToken = cliSetup.riskAccepted && cliToken.trim().length > 0;

  const dirty = dirtyConfig || dirtyKey || dirtyCap || dirtySchedule || dirtyCliConfig || dirtyCliToken;

  const pendingLabels = [
    dirtyConfig ? 'the endpoint' : null,
    dirtyKey ? (secret ? 'the replacement key' : 'your key') : null,
    dirtyCap ? 'the cap' : null,
    dirtySchedule ? 'the standing job' : null,
    dirtyCliConfig ? 'the subscription CLI' : null,
    dirtyCliToken ? (cliSetup.tokenStored ? 'the replacement subscription token' : 'your subscription token') : null
  ].filter((entry): entry is string => entry !== null);

  /**
   * One button, in the order the blocks are read.
   *
   * Sequential rather than parallel because the order is the argument: the
   * endpoint is where the key goes, and a cap is a cap on calls made with it.
   * A failure stops there and names both halves -- what did save, and what did
   * not -- because "could not save" over a panel where three of four writes
   * went through is the worst version of this message.
   */
  const saveAll = async () => {
    if (!capValid) {
      setProblem('Set a monthly cap between $0 and $10,000. Nothing else was saved.');
      return;
    }
    if (dirtyConfig && (!baseUrl.trim() || !model.trim())) {
      setProblem('The endpoint needs both an address and a model name. Nothing was saved.');
      return;
    }
    if (dirtyCliConfig && !cliModel.trim()) {
      setProblem('Name the model your subscription CLI should use. Nothing was saved.');
      return;
    }
    setBusy('save');
    setProblem('');
    const done: string[] = [];
    try {
      if (dirtyConfig) {
        const next = await saveAgentModelConfig({
          baseUrl: baseUrl.trim(), model: model.trim(), label: providerLabel.trim() || undefined
        });
        setSetup((current) => current && { ...current, config: next });
        done.push('the endpoint');
      }
      if (dirtyKey) {
        const next = await saveAgentKey({ apiKey: apiKey.trim(), label: providerLabel.trim() || undefined });
        setSetup((current) => current && { ...current, secret: next });
        setApiKey('');
        setReplacingKey(false);
        done.push('your key');
      }
      if (dirtyCap) {
        const next = await saveAgentBudget({ monthlyCapCents: capCents });
        setSetup((current) => current && { ...current, budget: next });
        setCapDollars(String(Math.round(next.monthlyCapCents / 100)));
        done.push(`a cap of ${usd(next.monthlyCapCents)} a month`);
      }
      if (dirtySchedule) {
        const next = await saveAgentSchedule({ goal: goal.trim(), intervalMinutes: Number(every) });
        setSetup((current) => current && { ...current, schedule: next });
        done.push('the standing job');
      }
      if (dirtyCliConfig) {
        const next = await saveAgentCliConfig({ cli: cliKind, model: cliModel.trim() });
        setSetup((current) => current && { ...current, cli: { ...current.cli, config: next } });
        done.push('the subscription CLI');
      }
      if (dirtyCliToken) {
        await saveAgentCliToken({ token: cliToken.trim() });
        setSetup((current) => current && { ...current, cli: { ...current.cli, tokenStored: true } });
        setCliToken('');
        setReplacingCliToken(false);
        done.push('your subscription token');
      }
      setToast(done.length > 0 ? `Saved ${andList(done)}.` : 'Nothing had changed, so nothing was saved.');
    } catch (error) {
      setProblem(`${agentSetupMessage(error, 'Could not save that')}${done.length > 0
        ? ` ${andList(done)} did save — press Save again to finish the rest.`
        : ' Nothing was saved, so nothing changed.'}`);
    } finally { setBusy(''); }
  };

  const capReached = budget.spentCents >= budget.monthlyCapCents && budget.monthlyCapCents > 0;
  const spendLine = budget.spentCents > 0
    ? `${usd(budget.spentCents)} of ${usd(budget.monthlyCapCents)} used this month.`
    : `Nothing spent this month. The cap is ${usd(budget.monthlyCapCents)} a month.`;

  const nextRun = schedule ? formatMoment(schedule.nextRunAt) : null;
  const scheduleLine = !schedule || !schedule.enabled
    ? 'Off. Write the standing job, save it, then switch it on.'
    : schedule.lastRunAt
      ? `Last ran ${formatMoment(schedule.lastRunAt) ?? 'earlier'}${nextRun ? ` · next ${nextRun}` : ''}.`
      : `On. It has not run yet${nextRun ? ` — first run ${nextRun}` : ''}.`;

  // Two independent ways to be ready to run: a stored key against a configured
  // endpoint (BYOK), or a fully accepted subscription CLI. Either is enough --
  // this only asks for both when neither is done.
  const byokReady = Boolean(config && secret);
  const cliReady = Boolean(cliSetup.config && cliSetup.riskAccepted && cliSetup.tokenStored);

  // Each blocker names the next action, in the order you have to do them. The
  // unsaved case is first, because a run against a half-typed endpoint is a
  // run against the old one and the operator would read the result as the new.
  // The budget check applies whichever path runs it: a subscription CLI costs
  // no marginal dollars, but Trevra still charges it a notional amount and
  // still checks the cap, so a run through it is still gated by spending.
  const runBlocker = dirty ? `Save ${andList(pendingLabels)} first — a run uses what is stored, not what is typed.`
    : (!byokReady && !cliReady) ? 'Add the endpoint and model, or set up your subscription CLI below, first.'
      : !budget.enabled ? 'Switch spending on first — a run costs money at your provider.'
        : capReached ? `This month’s ${usd(budget.monthlyCapCents)} is used up. Raise the cap to run again.`
          : !goal.trim() ? 'Write what it should work on first.'
            : null;

  const goalField = (label: string) => <label>{label}<textarea
    rows={2}
    value={goal}
    onChange={(event) => setGoal(event.target.value)}
    placeholder="Check which invoices are overdue and draft the follow-ups."
  /></label>;

  const scheduleOptions = Array.from(new Set([...SCHEDULE_CHOICES, Number(every) || 1440])).sort((a, b) => a - b);

  return <section className="page-panel agent-panel byok-panel">
    {heading}

    {problem && <div className="error-banner byok-error">{problem}</div>}

    <div className="byok-warning">
      <CircleAlert size={18} />
      <div>
        <strong>Read this before you paste a key.</strong>
        <p>Trevra encrypts your key and uses it on your behalf. Nobody gets it back out — not you, not us, not through any screen, export or support ticket. But storing it here moves a real risk onto Trevra: on the hosted service, one break-in exposes the stored key of every workspace, including yours. You deserve to weigh that before pasting.</p>
        <p>You do not have to. Your own agent on your laptop does the same work and stores no key at all — that stays the default, and it stays the safer one. If you do paste a key, use one you can revoke at your provider in seconds, and set the monthly cap below.</p>
      </div>
    </div>

    <div className="byok-block">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}>Where your key goes</h4>
          <p>Any endpoint that speaks the OpenAI format works — OpenAI, Azure, Groq, OpenRouter, Together, or a server you run yourself. Trevra ships no default and does not guess: your key goes exactly where you name here, and nowhere else.</p>
        </div>
      </div>
      <div className="byok-fields">
        <label>Endpoint address<input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.openai.com/v1"
          autoComplete="off"
          spellCheck={false}
        /></label>
        <label>Model<input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="the model name your provider uses"
          autoComplete="off"
          spellCheck={false}
        /></label>
        <label>Call it something (optional)<input
          value={providerLabel}
          onChange={(event) => setProviderLabel(event.target.value)}
          placeholder="Work account"
          maxLength={120}
        /></label>
      </div>
      <p className="byok-meter-copy">{config
        ? `Saved ${formatMoment(config.updatedAt) ?? 'earlier'}.${dirtyConfig ? ' Edited since — Save at the bottom.' : ''}`
        : 'Nothing saved yet. Fill in the endpoint and the model, then save at the bottom.'}</p>
    </div>

    <div className="byok-block">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}>Your key</h4>
          <p>It goes in and never comes out. Trevra keeps it encrypted, applies it at the moment of a call, and shows you the last four characters so you can find this key at your provider. There is no screen anywhere that can display it back to you.</p>
        </div>
      </div>
      {secret && !replacingKey ? <div className="byok-key-stored">
        <span className="byok-key-mask"><KeyRound size={16} /> •••• {secret.last4}</span>
        <span>{secret.label ? `${secret.label} · ` : ''}Added {new Date(secret.createdAt).toLocaleDateString()}</span>
        <div className="byok-key-actions">
          <button className="secondary-button" onClick={() => setReplacingKey(true)}>Replace</button>
          {/* Removal is destructive and irreversible, so it is its own act with
              its own confirmation. It is not folded into Save. */}
          <button className="ghost-button danger" disabled={busy === 'key-remove'} onClick={() => setConfirmRemoveKey(true)}>
            {busy === 'key-remove' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Remove
          </button>
        </div>
      </div> : <>
        <div className="byok-fields byok-fields-one">
          <label>{secret ? 'New key' : 'Paste your key'}<input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste it here"
            autoComplete="off"
            spellCheck={false}
          /></label>
        </div>
        <p className="byok-meter-copy">{secret
          ? `This replaces •••• ${secret.last4} here when you save. The old key keeps working at your provider until you revoke it there.`
          : 'Trevra stores it encrypted and keeps it out of every log, error and transcript.'}</p>
        {secret && <div className="byok-key-actions">
          <button className="ghost-button" onClick={() => { setReplacingKey(false); setApiKey(''); }}>Cancel the replacement</button>
        </div>}
      </>}
    </div>

    <div className="byok-block">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}><Terminal size={15} /> Or run it through your own Claude/Codex subscription</h4>
          <p>Instead of a metered model key, Trevra can drive this workspace's own Claude Code or Codex subscription. Same limits, same run ledger, same rule that nothing sends itself — this only changes what pays for the tokens.</p>
        </div>
        <span className="status-pill">{cliSetup.tokenStored
          ? `${cliSetup.config?.cli === 'codex' ? 'Codex' : 'Claude'} subscription connected`
          : cliSetup.riskAccepted ? 'Risk accepted' : cliConfigSaved ? 'Needs risk acceptance' : 'Not set up'}</span>
      </div>

      <div className="byok-warning">
        <CircleAlert size={18} />
        <div>
          <strong>Read this before you accept it below.</strong>
          <p>This uses this workspace's own personal Claude or Codex subscription, not a metered API plan. Automated, server-side use of a personal subscription may itself violate that subscription's own consumer terms, independent of anything Trevra does — and the account could be suspended for it. That risk has nothing to do with Trevra and Trevra cannot mitigate it; it is the workspace's own to weigh, for its own subscription.</p>
        </div>
      </div>

      <div className="byok-fields byok-fields-schedule">
        <label>Which subscription<select value={cliKind} onChange={(event) => setCliKind(event.target.value as 'claude' | 'codex')}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select></label>
        <label>Model<input
          value={cliModel}
          onChange={(event) => setCliModel(event.target.value)}
          placeholder="the model name your subscription CLI uses"
          autoComplete="off"
          spellCheck={false}
        /></label>
      </div>
      <p className="byok-meter-copy">{cliSetup.config
        ? `Saved: ${cliSetup.config.cli === 'codex' ? 'Codex' : 'Claude'}, ${cliSetup.config.model}.${dirtyCliConfig ? ' Edited since — Save at the bottom.' : ''}`
        : 'Choose a CLI and a model, then save at the bottom.'}</p>

      <label className="byok-risk-check">
        <input
          type="checkbox"
          checked={cliSetup.riskAccepted}
          disabled={busy === 'cli-risk' || !cliConfigSaved}
          onChange={(event) => void setCliRisk(event.target.checked)}
        />
        <span>I understand this uses this workspace's own Claude or Codex subscription, not a metered plan. Automated, server-side use like this may itself violate that subscription's own consumer terms, independent of anything Trevra does, and the account could be suspended for it. This workspace is accepting that risk for its own subscription.</span>
      </label>
      {!cliConfigSaved && <p className="byok-meter-copy">Save the subscription CLI and model above first — there is nothing to accept the risk of yet.</p>}

      {cliSetup.riskAccepted && <>
        {cliSetup.tokenStored && !replacingCliToken ? <div className="byok-key-stored">
          <span className="byok-key-mask"><KeyRound size={16} /> Subscription token stored</span>
          <span />
          <div className="byok-key-actions">
            <button className="secondary-button" onClick={() => setReplacingCliToken(true)}>Replace</button>
            {/* Removal is destructive and irreversible, so it is its own act with
                its own confirmation, same as the model key above. Not folded into Save. */}
            <button className="ghost-button danger" disabled={busy === 'cli-token-remove'} onClick={() => setConfirmRemoveCliToken(true)}>
              {busy === 'cli-token-remove' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Remove
            </button>
          </div>
        </div> : <>
          <div className="byok-fields byok-fields-one">
            <label>{cliSetup.tokenStored ? 'New subscription token' : 'Paste your subscription token'}<input
              type="password"
              value={cliToken}
              onChange={(event) => setCliToken(event.target.value)}
              placeholder="Paste it here"
              autoComplete="off"
              spellCheck={false}
            /></label>
          </div>
          <p className="byok-meter-copy">{cliSetup.tokenStored
            ? 'This replaces the stored token here when you save. The old session keeps working at your provider until you sign it out there.'
            : 'Trevra stores it encrypted and keeps it out of every log, error and transcript. There is no screen anywhere that can display it back to you.'}</p>
          {cliSetup.tokenStored && <div className="byok-key-actions">
            <button className="ghost-button" onClick={() => { setReplacingCliToken(false); setCliToken(''); }}>Cancel the replacement</button>
          </div>}
        </>}
      </>}
    </div>

    <div className="byok-block" id="setup-spend">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}>What it may spend</h4>
          <p>Storing a key is not permission to spend it. Until you switch this on, Trevra will not make a single paid call — and it stops the moment you switch it back off.</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={budget.enabled} disabled={busy === 'spend'} onChange={(event) => void setSpending(event.target.checked)} />
          <span />
        </label>
      </div>
      <div className="byok-fields byok-fields-one">
        <label>Most it may spend a month<span className="byok-amount"><small>$</small><input
          type="number"
          min="0"
          max="10000"
          step="1"
          value={capDollars}
          onChange={(event) => setCapDollars(event.target.value)}
        /></span></label>
      </div>
      <p className="byok-meter-copy">{spendLine}{dirtyCap ? ' The cap on screen is not saved yet.' : ''}</p>
      {budget.spentCents > 0 && <div className="byok-meter"><i style={{
        width: `${Math.min(100, Math.round((budget.spentCents / Math.max(budget.monthlyCapCents, 1)) * 100))}%`
      }} /></div>}
      <p className="byok-meter-copy">{budget.enabled
        ? 'On. Trevra checks the cap before each call, so a long job cannot run past it.'
        : 'Off. Nothing Trevra’s agent does can cost you money.'}</p>
    </div>

    {/* Absent from the response means this build has no schedule yet. Hide it
        rather than show a control that writes to a route that is not there. */}
    {hasSchedule && <div className="byok-block">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}>Work on a schedule</h4>
          <p>Give it a standing job and Trevra picks it up on its own, with your laptop closed. It still stops at every approval — nothing leaves your business without you.</p>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={schedule?.enabled ?? false}
            disabled={busy === 'schedule-switch' || !goal.trim() || dirtySchedule}
            onChange={(event) => void setScheduleEnabled(event.target.checked)}
          />
          <span />
        </label>
      </div>
      <div className="byok-fields byok-fields-schedule">
        {goalField('Standing job')}
        <label>How often<select value={every} onChange={(event) => setEvery(event.target.value)}>
          {scheduleOptions.map((minutes) => <option key={minutes} value={String(minutes)}>{formatEvery(minutes)}</option>)}
        </select></label>
      </div>
      <p className="byok-meter-copy">{scheduleLine}{dirtySchedule
        ? ' The job on screen is not saved yet, so the switch is held until it is.'
        : ''}</p>
    </div>}

    {/* One button for the whole sitting. It writes only what changed, in the
        order the blocks are read, and names each part by what it is. */}
    <div className="panel-footer">
      <span>{dirty
        ? `Not saved yet: ${andList(pendingLabels)}.`
        : 'Everything on this panel matches what is stored.'}</span>
      <button className="primary-button" disabled={!dirty || busy === 'save'} onClick={() => void saveAll()}>
        {busy === 'save' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save {pendingLabels.length > 1 ? 'these changes' : 'this change'}
      </button>
    </div>

    <div className="byok-block">
      <div className="byok-block-head">
        <div>
          <h4 aria-level={3}>Run it once, now</h4>
          <p>{hasSchedule
            ? 'The same job, straight away, without waiting for the schedule.'
            : 'Give it a job and watch it work. Every step lands in the run ledger while it runs.'}</p>
        </div>
      </div>
      {!hasSchedule && <div className="byok-fields byok-fields-one">{goalField('What should it work on?')}</div>}
      <div className="panel-footer">
        <span>{runBlocker ?? 'It stops at the first thing that needs your decision, and waits for you in Money.'}</span>
        <button className="secondary-button" disabled={Boolean(runBlocker) || busy === 'run'} onClick={() => void runNow()}>
          {busy === 'run' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Run now
        </button>
      </div>
    </div>

    {confirmRemoveKey && secret && <ConfirmDrawer
      title="Remove this key from Trevra?"
      tone="danger"
      body={<>
        <p>Trevra deletes its encrypted copy of •••• {secret.last4}. Nothing here can read a key back out, so there is nothing to restore — you would have to paste it again from your provider.</p>
        <p>Anything Trevra’s agent is doing stops at its next model call. Your own agent on your laptop is unaffected and keeps working.</p>
        <p><strong>This does not revoke the key at your provider.</strong> If it may have leaked, revoke it there as well.</p>
      </>}
      confirmLabel="Remove this key"
      busy={busy === 'key-remove'}
      onCancel={() => setConfirmRemoveKey(false)}
      onConfirm={() => void removeKey()}
    />}

    {confirmRemoveCliToken && <ConfirmDrawer
      title="Remove this subscription token from Trevra?"
      tone="danger"
      body={<>
        <p>Trevra deletes its encrypted copy of the token. Nothing here can read a token back out, so there is nothing to restore — you would have to create and paste a new one.</p>
        <p>The subscription CLI stops running this workspace's agent at its next step. Your own agent above and Trevra's key-based agent, if either is set up, are unaffected.</p>
        <p><strong>This does not sign the session out at Claude or OpenAI.</strong> If it may have leaked, revoke it there as well.</p>
      </>}
      confirmLabel="Remove this token"
      busy={busy === 'cli-token-remove'}
      onCancel={() => setConfirmRemoveCliToken(false)}
      onConfirm={() => void removeCliToken()}
    />}
  </section>;
}

/* --------------------------------------------------------------------------
 * `/money` -- the paid end of the loop.
 *
 * Not a second product and not a legacy screen: it is stages 4 to 6 of the one
 * loop `/loop` draws. Every recommendation type, every string and every enum
 * member is untouched -- `stale_proposal`, `scope_creep`,
 * `unbilled_milestone`, `overdue_invoice` are the vocabulary of getting paid
 * and there is nothing wrong with them. What changed is only their GROUPING:
 * three columns, one per loop stage, so the flat list stops reading as an
 * undifferentiated inbox.
 * -------------------------------------------------------------------------- */

const MONEY_GROUPS: Array<{ heading: string; blurb: string; types: RecommendationType[] }> = [
  {
    heading: 'Delivered, not billed',
    blurb: 'Work that is proven done and has no invoice against it yet.',
    types: ['unbilled_milestone']
  },
  {
    heading: 'Billed, not paid',
    blurb: 'Invoices past their date. The money exists; it has not arrived.',
    types: ['overdue_invoice']
  },
  {
    heading: 'Not agreed',
    blurb: 'Requests outside the agreement, and proposals that went quiet.',
    types: ['scope_creep', 'stale_proposal']
  }
];

function MoneyView({ data, recommendations, actions, onNavigate }: {
  data: DashboardPayload;
  recommendations: Recommendation[];
  actions: RecommendationActions;
  onNavigate: (path: string) => void;
}) {
  const isNew = data.clients.length === 0 && data.recommendations.length === 0;
  // Figures on the screen that came from a demo rather than from the
  // operator's own tools. A workspace with no connection AND no data of its
  // own is not reading demo numbers -- it is reading zeros.
  const showsDemoNumbers = data.connections.some((connection) => connection.isDemo)
    || (data.metrics.connectedSources === 0 && !isNew);

  return <div className="page-stack">
    {showsDemoNumbers && (
      <section className="setup-banner">
        <div className="setup-icon"><Link2 /></div>
        <div><strong>This is demo data</strong><p>Connect your own email, calendar, or accounting and Trevra will work from your real business instead.</p></div>
        <button className="secondary-button" onClick={() => onNavigate('/setup/data')}>Connect tools <ChevronRight size={16} /></button>
      </section>
    )}

    <section className="metrics-grid metrics-grid-four">
      <Metric icon={<CircleDollarSign />} label="At risk" value={money(data.metrics.revenueAtRisk, data.metrics.currency)} detail="Billed and unpaid" />
      <Metric icon={<FileCheck2 />} label="Ready to invoice" value={money(data.metrics.readyToInvoice, data.metrics.currency)} detail="Delivered but not billed" />
      {/* The one trophy number in the product, and the only place it belongs:
          it is a result, not a queue, so it is not on the home screen. */}
      <Metric icon={<Check />} label="Collected" value={money(data.metrics.revenueCollected, data.metrics.currency)} detail="Paid after Trevra chased it" />
      <Metric icon={<BriefcaseBusiness />} label="Clients" value={String(data.metrics.activeClients)} detail="With something open right now" />
    </section>

    {MONEY_GROUPS.map((group) => {
      const items = recommendations.filter((item) => group.types.includes(item.type));
      // A column with nothing in it says nothing. The all-clear is said once,
      // below, rather than three times in three boxes.
      if (items.length === 0) return null;
      return <section className="recommendations-panel" key={group.heading}>
        <div className="section-heading">
          <div><h2>{group.heading}</h2><p>{group.blurb}</p></div>
          <span className="status-pill">{items.length} open</span>
        </div>
        <RecommendationList
          items={items}
          actions={actions}
          empty={<EmptyRecommendations isNew={isNew} />}
        />
      </section>;
    })}

    {recommendations.length === 0 && <section className="recommendations-panel">
      <div className="section-heading"><div><h2>What needs you</h2><p>Ranked by what it costs you to ignore.</p></div></div>
      <EmptyRecommendations isNew={isNew} />
    </section>}

    <ClientsView data={data} onNavigate={onNavigate} />
  </div>;
}

function ClientsView({ data, onNavigate }: { data: DashboardPayload; onNavigate: (path: string) => void }) {
  return <section className="page-panel">
    <div className="section-heading"><div><h2>Every client</h2><p>Value, latest activity, and the next revenue action for each one.</p></div></div>
    <div className="client-table">
      {data.clients.map((client) => <article key={client.id} className="client-card-large">
        <span className="client-avatar large">{initials(client.name)}</span>
        <div><h3>{client.name}</h3><p>{client.contactName} · {client.email}</p><span className={`client-status status-${client.status}`}>{client.status}</span></div>
        <div className="client-card-value"><small>Relationship value</small><strong>{money(client.activeValue, client.currency)}</strong></div>
        <div className="client-next"><small>Next action</small><strong title={client.nextAction ?? undefined}>{clip(client.nextAction ?? 'No urgent action', 60)}</strong></div>
      </article>)}
      {data.clients.length === 0 && <div className="empty-state"><BriefcaseBusiness size={28} /><h4 aria-level={3}>No clients yet</h4><p>Connect a tool or upload an agreement and your clients appear here.</p><button className="secondary-button" onClick={() => onNavigate('/setup/data')}>Connect a tool <ChevronRight size={15} /></button></div>}
    </div>
  </section>;
}

function ConnectionsView({ data, reload, setToast, busyId, setBusyId }: {
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
  // Disconnecting is the one control on this screen that takes data off every
  // other screen, and it sat 8px from Sync now at the same size in the same
  // grey. It now stops here first, like every other destructive act in the app.
  const [confirmDisconnect, setConfirmDisconnect] = useState<ConnectionSummary | null>(null);
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
    <section className="page-panel" id="setup-connections">
      <div className="section-heading"><div><h3 aria-level={2}>Connected accounts</h3><p>Your data stays in these tools. Trevra reads it, it does not copy it away.</p></div></div>
      <div className="connection-grid">
        {data.connections.map((connection) => <article className="connection-card" key={connection.id}>
          <span className="integration-logo">{initials(connection.provider)}</span>
          <div><h4 aria-level={3}>{prettyProvider(connection.provider)}</h4><p>{connection.displayName ?? connection.providerConfigKey}</p><span className={`connection-status ${connection.status}`}>{connection.isDemo ? 'Demo' : connection.status.replace('_', ' ')}</span></div>
          <div className="connection-actions">
            {!connection.isDemo && <button className="icon-button" aria-label={`Sync ${prettyProvider(connection.provider)} now`} title="Sync now" disabled={busyId === connection.id} onClick={() => {
              setBusyId(connection.id);
              void syncIntegration(connection.id).then(() => setToast('Sync requested')).catch((err) => setToast(err.message)).finally(() => setBusyId(null));
            }}>{busyId === connection.id ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button>}
            {!connection.isDemo && <button
              className="icon-button danger"
              aria-label={`Disconnect ${prettyProvider(connection.provider)}`}
              title={`Disconnect ${prettyProvider(connection.provider)}`}
              disabled={busyId === connection.id}
              onClick={() => setConfirmDisconnect(connection)}
            ><Unplug size={17} /></button>}
          </div>
        </article>)}
        {data.connections.length === 0 && <div className="empty-state"><Link2 size={28} /><h4 aria-level={3}>No tools connected</h4><p>Pick one below and sign in on the provider’s own screen — it takes about a minute.</p></div>}
      </div>
    </section>

    <section className="page-panel">
      <div className="section-heading"><div><h3 aria-level={2}>Connect a tool</h3><p>You sign in on the provider’s own screen. Trevra never sees or stores your password.</p></div></div>
      <div className="integration-grid">
        {available.map((item) => <article className="integration-card" key={item.key}>
          <span className="integration-logo">{initials(item.name)}</span>
          <div><h4 aria-level={3}>{item.name}</h4><p>{item.description}</p></div>
          <button className="secondary-button" disabled={item.connected || busyId === item.key} onClick={() => void connect(item)}>
            {busyId === item.key ? <LoaderCircle className="spin" size={16} /> : item.connected ? <Check size={16} /> : <Link2 size={16} />}
            {item.connected ? 'Connected' : 'Connect'}
          </button>
        </article>)}
      </div>
    </section>

    <section className="page-panel import-panel" id="setup-import">
      <div className="section-heading"><div><h3 aria-level={2}>Build the Scope Ledger from an agreement</h3><p>Upload a proposal, statement of work, or contract. Trevra extracts the commercial facts instead of asking you to enter them twice.</p></div></div>
      <div className="document-hints">
        <label>Client name<input value={documentHints.clientName} onChange={(event) => setDocumentHints({ ...documentHints, clientName: event.target.value })} placeholder="Acme Labs" /></label>
        <label>Project name<input value={documentHints.projectName} onChange={(event) => setDocumentHints({ ...documentHints, projectName: event.target.value })} placeholder="Website launch" /></label>
        <label>Contact email<input type="email" value={documentHints.clientEmail} onChange={(event) => setDocumentHints({ ...documentHints, clientEmail: event.target.value })} placeholder="client@example.com" /></label>
        <label>Currency<select value={documentHints.currency} onChange={(event) => setDocumentHints({ ...documentHints, currency: event.target.value })}><option>EUR</option><option>USD</option><option>GBP</option><option>CHF</option><option>CAD</option><option>AUD</option></select></label>
      </div>
      <div className="document-upload-row">
        <label className="file-picker"><FileUp size={18} /> {documentFile ? documentFile.name : 'Choose PDF, DOCX, or text'}<input type="file" accept=".pdf,.docx,.txt,.md,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)} /></label>
        <button className="secondary-button" disabled={!documentFile || busyId === 'document-import'} onClick={() => void importDocument()}>{busyId === 'document-import' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} Build Scope Ledger</button>
      </div>
    </section>

    <section className="page-panel import-panel">
      <div className="section-heading"><div><h3 aria-level={2}>Import from Upwork, Fiverr, or Contra</h3><p>Download your history as a CSV from the platform and drop it here. Trevra turns it into clients, projects, and payments.</p></div></div>
      <div className="import-controls">
        <label>Platform<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="upwork">Upwork</option><option value="fiverr">Fiverr</option><option value="contra">Contra</option><option value="generic">Generic CSV</option></select></label>
        <label className="file-picker"><FileUp size={18} /> Choose CSV<input type="file" accept=".csv,text/csv" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void file.text().then(setCsv);
        }} /></label>
      </div>
      <label>CSV preview<textarea rows={7} value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="Client,Project,Amount,Status,Date…" /></label>
      <div className="panel-footer"><span>{csv ? `${csv.split('\n').length - 1} possible records` : 'No file selected'}</span><button className="secondary-button" disabled={!csv || busyId === 'csv-import'} onClick={() => void importCsv()}>{busyId === 'csv-import' ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />} Import history</button></div>
    </section>

    {confirmDisconnect && <ConfirmDrawer
      title={`Disconnect ${prettyProvider(confirmDisconnect.provider)}?`}
      tone="danger"
      body={<>
        <p><strong>{prettyProvider(confirmDisconnect.provider)}</strong> — {confirmDisconnect.displayName ?? confirmDisconnect.providerConfigKey}</p>
        <p>Trevra stops reading this account immediately. Anything it was the only source of goes off the Money screen and out of the loop — invoices, milestones, replies and the evidence behind them stop being visible, and the agent stops being able to see the facts it was working from.</p>
        <p>Nothing already in Trevra is deleted, and reconnecting brings the account back. But it signs in again from scratch and only backfills what the provider still returns.</p>
      </>}
      confirmLabel={`Disconnect ${prettyProvider(confirmDisconnect.provider)}`}
      busy={busyId === confirmDisconnect.id}
      onCancel={() => { if (busyId !== confirmDisconnect.id) setConfirmDisconnect(null); }}
      onConfirm={() => {
        const target = confirmDisconnect;
        setBusyId(target.id);
        void disconnectIntegration(target.id)
          .then(reload)
          .then(() => { setConfirmDisconnect(null); setToast(`${prettyProvider(target.provider)} is disconnected. Trevra has stopped reading it.`); })
          .catch((err) => setToast(err instanceof Error ? err.message : 'That did not go through — nothing changed.'))
          .finally(() => setBusyId(null));
      }}
    />}
  </div>;
}

/**
 * The only condition keys the runtime actually matches on, with the only
 * values it ever compares against. Mirrors `matchesConditions` in
 * src/server/control-plane/policy.ts -- if that grows, this grows with it.
 *
 * `playbookIds` and `skillIds` are deliberately absent: there is no list of
 * them loaded on this screen, and asking a founder to type an id is a field a
 * machine should fill. See docs/app-spec.md §7.
 */
const SIDE_EFFECT_CHOICES = [
  { value: 'external-write', label: 'Sends or changes something outside your business' },
  { value: 'network-read', label: 'Reads something from outside' },
  { value: 'none', label: 'Thinks only, nothing leaves Trevra' }
] as const;

const ACTOR_CHOICES = [
  { value: 'agent', label: 'Your agent' },
  { value: 'user', label: 'You' },
  { value: 'system', label: 'Trevra, on a schedule' }
] as const;

const ENVIRONMENT_CHOICES = [
  { value: 'production', label: 'Your live workspace' },
  { value: 'development', label: 'A development copy' },
  { value: 'test', label: 'Automated tests' }
] as const;

type ConditionChoice = { value: string; label: string };

type ConditionDraft = {
  sideEffects: string[];
  actorTypes: string[];
  environments: string[];
  maxAmount: string;
  minConfidence: string;
  maxRecipients: string;
};

const EMPTY_CONDITIONS: ConditionDraft = {
  sideEffects: [], actorTypes: [], environments: [], maxAmount: '', minConfidence: '', maxRecipients: ''
};

const conditionLabel = (choices: readonly ConditionChoice[], value: string) =>
  choices.find((choice) => choice.value === value)?.label ?? value;

/** A list matches if ANY entry matches, so these read as "or". */
const orList = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;

const asStringList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Emit exactly the object the server matches on, with empty keys omitted:
 * `{sideEffects: []}` matches nothing, so sending it would silently disarm the
 * rule the founder just wrote.
 */
function buildConditions(draft: ConditionDraft): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  if (draft.sideEffects.length > 0) conditions.sideEffects = draft.sideEffects;
  if (draft.actorTypes.length > 0) conditions.actorTypes = draft.actorTypes;
  if (draft.environments.length > 0) conditions.environments = draft.environments;
  const amount = Number(draft.maxAmount);
  if (draft.maxAmount.trim() !== '' && Number.isFinite(amount)) conditions.maxAmount = amount;
  const confidence = Number(draft.minConfidence);
  if (draft.minConfidence.trim() !== '' && Number.isFinite(confidence)) conditions.minConfidence = confidence / 100;
  const recipients = Number(draft.maxRecipients);
  if (draft.maxRecipients.trim() !== '' && Number.isFinite(recipients)) conditions.maxRecipients = recipients;
  return conditions;
}

/** The saved rule, as a sentence a founder can check. Never as JSON. */
function describePolicy(effect: WorkspacePolicy['effect'], conditions: Record<string, unknown>): string {
  const verb = effect === 'deny' ? 'Blocks it' : effect === 'allow' ? 'Lets it run without asking' : 'Asks you first';
  const clauses: string[] = [];
  const sideEffects = asStringList(conditions.sideEffects);
  if (sideEffects.length > 0) clauses.push(`it ${orList(sideEffects.map((value) => conditionLabel(SIDE_EFFECT_CHOICES, value).toLowerCase()))}`);
  const actorTypes = asStringList(conditions.actorTypes);
  if (actorTypes.length > 0) clauses.push(`${orList(actorTypes.map((value) => conditionLabel(ACTOR_CHOICES, value).toLowerCase()))} is the one acting`);
  const environments = asStringList(conditions.environments);
  if (environments.length > 0) clauses.push(`it runs in ${orList(environments.map((value) => conditionLabel(ENVIRONMENT_CHOICES, value).toLowerCase()))}`);
  const playbookIds = asStringList(conditions.playbookIds);
  if (playbookIds.length > 0) clauses.push(`the job is ${orList(playbookIds)}`);
  const skillIds = asStringList(conditions.skillIds);
  if (skillIds.length > 0) clauses.push(`the step is ${orList(skillIds)}`);
  const maxAmount = asNumber(conditions.maxAmount);
  if (maxAmount !== null) clauses.push(`the amount is ${money(maxAmount)} or less`);
  const minConfidence = asNumber(conditions.minConfidence);
  if (minConfidence !== null) clauses.push(`Trevra is at least ${Math.round(minConfidence * 100)}% sure`);
  const maxRecipients = asNumber(conditions.maxRecipients);
  if (maxRecipients !== null) clauses.push(`it reaches ${maxRecipients} ${maxRecipients === 1 ? 'person' : 'people'} or fewer`);
  return clauses.length === 0 ? `${verb}, every time.` : `${verb} when ${clauses.join(', and ')}.`;
}

function ConditionChecklist({ legend, choices, selected, onToggle }: {
  legend: string;
  choices: readonly ConditionChoice[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return <fieldset className="condition-group">
    <legend>{legend}</legend>
    {choices.map((choice) => <label key={choice.value}>
      <input type="checkbox" checked={selected.includes(choice.value)} onChange={() => onToggle(choice.value)} />
      <span>{choice.label}</span>
    </label>)}
  </fieldset>;
}

function AutopilotView({ rules, reload, setToast }: { rules: AutomationRule[]; reload: () => Promise<void>; setToast: (message: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, AutomationRule>>(() => Object.fromEntries(rules.map((rule) => [rule.recommendationType, rule])));
  const [busy, setBusy] = useState('');
  const [policies, setPolicies] = useState<WorkspacePolicy[]>([]);
  const [confirmDeletePolicy, setConfirmDeletePolicy] = useState<WorkspacePolicy | null>(null);
  const [policyDraft, setPolicyDraft] = useState({
    name: 'Ask me before anything leaves my business',
    actionPattern: 'skill:*',
    effect: 'require_approval' as WorkspacePolicy['effect'],
    priority: 100
  });
  const [conditionDraft, setConditionDraft] = useState<ConditionDraft>({ ...EMPTY_CONDITIONS, sideEffects: ['external-write'] });

  const toggleCondition = (key: 'sideEffects' | 'actorTypes' | 'environments', value: string) =>
    setConditionDraft((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((entry) => entry !== value)
        : [...current[key], value]
    }));

  useEffect(() => setDrafts(Object.fromEntries(rules.map((rule) => [rule.recommendationType, rule]))), [rules]);
  useEffect(() => { void getPolicies().then(setPolicies).catch(() => undefined); }, []);

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
      setPolicies(await createPolicy({
        name: policyDraft.name.trim(),
        actionPattern: policyDraft.actionPattern.trim(),
        effect: policyDraft.effect,
        priority: policyDraft.priority,
        conditions: buildConditions(conditionDraft),
        enabled: true
      }));
      setToast('Limit saved');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Unable to save this limit'); }
    finally { setBusy(''); }
  };

  const removePolicy = async (policyId: string) => {
    setBusy(policyId);
    try {
      await deletePolicy(policyId);
      setPolicies(await getPolicies());
      setToast('Limit deleted. Your agent is no longer held by it.');
    } catch (err) { setToast(err instanceof Error ? err.message : 'Could not delete that limit. It is still in force — try again.'); }
    finally { setBusy(''); setConfirmDeletePolicy(null); }
  };

  return <div className="page-stack">
    <section className="page-panel" id="setup-autopilot">
      <div className="section-heading">
        <div><h3 aria-level={2}><Sparkles size={18} /> Standing instructions</h3><p>Decide once. Tell Trevra what it may do on its own, and where it must stop and ask you.</p></div>
        <button className="secondary-button" onClick={() => void run()} disabled={busy === 'run'}>{busy === 'run' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} Run now</button>
      </div>
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
    <section className="page-panel policy-panel" id="setup-limits">
      <div className="section-heading"><div><h3 aria-level={2}><ShieldCheck size={18} /> Hard limits</h3><p>Rules Trevra can never break, whatever else it is told to do. Anything that leaves your business needs your approval unless you say otherwise.</p></div><span className="status-pill">{policies.length} set</span></div>
      <div className="policy-editor">
        <label>Name it<input value={policyDraft.name} onChange={(event) => setPolicyDraft({ ...policyDraft, name: event.target.value })} /></label>
        <label>What it covers<input value={policyDraft.actionPattern} onChange={(event) => setPolicyDraft({ ...policyDraft, actionPattern: event.target.value })} placeholder="skill:*" /><small>* stands for everything</small></label>
        <label>What happens<select value={policyDraft.effect} onChange={(event) => setPolicyDraft({ ...policyDraft, effect: event.target.value as WorkspacePolicy['effect'] })}><option value="allow">Let it run</option><option value="require_approval">Ask me first</option><option value="deny">Block it</option></select></label>
        <label>Priority<input type="number" value={policyDraft.priority} onChange={(event) => setPolicyDraft({ ...policyDraft, priority: Number(event.target.value) })} /><small>higher wins a tie</small></label>
      </div>
      <fieldset className="policy-conditions">
        <legend>When does it apply?</legend>
        <p className="condition-hint">Leave a group untouched and it applies to all of them.</p>
        <div className="condition-groups">
          <ConditionChecklist legend="What is being done" choices={SIDE_EFFECT_CHOICES} selected={conditionDraft.sideEffects} onToggle={(value) => toggleCondition('sideEffects', value)} />
          <ConditionChecklist legend="Who is doing it" choices={ACTOR_CHOICES} selected={conditionDraft.actorTypes} onToggle={(value) => toggleCondition('actorTypes', value)} />
          <ConditionChecklist legend="Where it runs" choices={ENVIRONMENT_CHOICES} selected={conditionDraft.environments} onToggle={(value) => toggleCondition('environments', value)} />
        </div>
        <div className="condition-numbers">
          <label>Only when the amount is at most<span className="condition-number"><input type="number" min="0" step="100" placeholder="any amount" value={conditionDraft.maxAmount} onChange={(event) => setConditionDraft({ ...conditionDraft, maxAmount: event.target.value })} /><small>EUR</small></span></label>
          <label>Only when Trevra is at least this sure<span className="condition-number"><input type="number" min="0" max="100" placeholder="any confidence" value={conditionDraft.minConfidence} onChange={(event) => setConditionDraft({ ...conditionDraft, minConfidence: event.target.value })} /><small>%</small></span></label>
          <label>Only when it reaches at most<span className="condition-number"><input type="number" min="1" placeholder="any number" value={conditionDraft.maxRecipients} onChange={(event) => setConditionDraft({ ...conditionDraft, maxRecipients: event.target.value })} /><small>people</small></span></label>
        </div>
        <p className="policy-preview">{describePolicy(policyDraft.effect, buildConditions(conditionDraft))}</p>
      </fieldset>
      <div className="panel-footer"><span>Takes effect the moment you add it.</span><button className="secondary-button" disabled={busy === 'policy-create'} onClick={() => void addPolicy()}>{busy === 'policy-create' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Add limit</button></div>
      <div className="workspace-policy-list">
        {policies.map((policy) => <article key={policy.id}>
          <div><strong>{policy.name}</strong><code>{policy.actionPattern}</code></div>
          <span className={`policy-effect effect-${policy.effect}`}>{policy.effect.replace('_', ' ')}</span>
          <p className="policy-summary">{describePolicy(policy.effect, policy.conditions)}</p>
          <button className="ghost-button danger" disabled={busy === policy.id} onClick={() => setConfirmDeletePolicy(policy)}>{busy === policy.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Delete</button>
        </article>)}
        {policies.length === 0 && <p className="empty-copy">No limits of your own yet. Add one above — until then, Trevra still asks you before anything leaves your business.</p>}
      </div>
    </section>

    {confirmDeletePolicy && <ConfirmDrawer
      title="Delete this limit?"
      tone="danger"
      body={<>
        <p><strong>{confirmDeletePolicy.name}</strong> — {describePolicy(confirmDeletePolicy.effect, confirmDeletePolicy.conditions)}</p>
        <p>Deleting it takes that guardrail off your agent immediately. Work this limit was blocking, or holding back for your approval, can go through on the very next run.</p>
        <p>There is no undo. You can write the limit again, but it will not apply to anything that ran in between.</p>
      </>}
      confirmLabel="Delete this limit"
      busy={busy === confirmDeletePolicy.id}
      onCancel={() => setConfirmDeletePolicy(null)}
      onConfirm={() => void removePolicy(confirmDeletePolicy.id)}
    />}
  </div>;
}

function ActionDrawer({ action, busy, onChange, onClose, onExecute }: {
  action: PreparedAction; busy: boolean; onChange: (action: PreparedAction) => void; onClose: () => void; onExecute: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const opened = useRef(action);
  // A misclick outside the drawer must not throw away an edited draft. The X,
  // Cancel, and Escape are explicit; the backdrop is not.
  const edited = action.recipient !== opened.current.recipient
    || action.subject !== opened.current.subject
    || action.body !== opened.current.body
    || action.scheduledFor !== opened.current.scheduledFor;
  const closeIfUnedited = () => { if (!edited) onClose(); };
  const scheduleValue = action.scheduledFor ? toLocalDateTime(action.scheduledFor) : '';
  const scheduled = Boolean(action.scheduledFor);

  /**
   * The last gate, and the only one that was missing.
   *
   * Everything else in this product that cannot be taken back -- revoking a
   * token, deleting a limit, pausing a seat -- stops at a `ConfirmDrawer`
   * first, and the one act that reaches a person outside the business did not.
   * It does now, at the same interruption and in the same chrome.
   *
   * NO DEFERRED SEND, and the drawer says so rather than implying it. The nine
   * second hold behind Undo works for snooze and dismiss because those are
   * writes to Trevra's own tables, and Trevra can simply not make them. This
   * is a mail provider: there is no unsend to call, so a nine second window
   * would only be a period in which the app says "sent" while nothing has
   * been. This file already refuses that trade elsewhere -- a "Send" that does
   * not send is the one lie this product cannot afford -- and the same rule
   * applies to an Undo that does not undo. The delay would also move the
   * approve-then-execute failure to after the drawer had closed, with the
   * payload no longer on screen to fix.
   *
   * `tone="caution"`, not `"danger"`: sending the message you wrote is the
   * product working. Red is for a stop that already happened.
   */
  const [confirming, setConfirming] = useState(false);

  // Two dialogs, one Escape key. Both `useDialog` calls listen on `document` in
  // the capture phase, and `stopPropagation` does not reach a second listener
  // on the same node -- so without this guard one Escape would close the
  // confirmation AND throw away the draft underneath it.
  useDialog(dialog, () => { if (!confirming) onClose(); });

  // Cmd/Ctrl+Enter opens that confirmation -- it does not send. It works from
  // inside the message field on purpose: that is where the caret is when you
  // have finished reading, and a modified Enter is not a character anywhere.
  // What it must never be is a two-key path past the one gate.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy) {
      event.preventDefault();
      setConfirming(true);
    }
  };

  // Portalled out of `.app-shell` so the shell itself can be made inert while
  // this is open -- an ancestor cannot be switched off from inside.
  return createPortal(<><div className="drawer-backdrop" role="presentation" onClick={closeIfUnedited}><section ref={dialog} className="drawer" role="dialog" aria-modal="true" aria-labelledby="action-drawer-title" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
    {/* Prepared, not completed: nothing here has happened yet, and the button
        below is the thing that makes it happen. */}
    <header><div><span className="drawer-kicker"><Sparkles size={14} /> Prepared by Trevra</span><h3 id="action-drawer-title">Check this before it goes out</h3></div><button className="icon-button" aria-label="Close without sending" onClick={onClose}><X size={20} /></button></header>
    <div className="drawer-body">
      <div className="approval-banner"><ShieldCheck size={19} /><p><strong>Exact-payload approval.</strong> Trevra executes only the recipient, subject, message, and schedule you approve.</p></div>
      <div className="delivery-row"><span>Delivery</span><strong>{prettyProvider(action.executionProvider)}</strong></div>
      <label>To<input value={action.recipient} onChange={(e) => onChange({ ...action, recipient: e.target.value })} /></label>
      <label>Subject<input value={action.subject} onChange={(e) => onChange({ ...action, subject: e.target.value })} /></label>
      <label>Message<textarea rows={14} value={action.body} onChange={(e) => onChange({ ...action, body: e.target.value })} /></label>
      <label>Send later <input type="datetime-local" value={scheduleValue} onChange={(event) => onChange({ ...action, scheduledFor: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
      {action.lastError && <div className="error-banner">{action.lastError}</div>}
      <p className="panel-note">Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to reach the last check without reaching for the mouse.</p>
    </div>
    <footer><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => setConfirming(true)} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : scheduled ? <CalendarClock size={16} /> : <Check size={16} />} {scheduled ? 'Approve & schedule' : 'Approve & send'}</button></footer>
  </section></div>

    {confirming && <ConfirmDrawer
      tone="caution"
      title={scheduled
        ? `Schedule this for ${action.recipient}?`
        : `Send this to ${action.recipient} now?`}
      body={<>
        <p><strong>{action.subject}</strong> goes to <strong>{action.recipient}</strong> through {prettyProvider(action.executionProvider)}{scheduled ? <> at {formatMoment(action.scheduledFor as string)}</> : null}.</p>
        <p>{scheduled
          ? 'Trevra holds the exact wording you approved until that moment and then sends it. Nothing on this screen changes it afterwards.'
          : 'This leaves your business the moment you confirm.'} <strong>There is no recall.</strong> Trevra cannot take a message back out of someone else’s inbox, and it will not offer you an Undo it could not honour.</p>
        <p>Cancel here and the draft stays exactly as you edited it.</p>
      </>}
      confirmLabel={scheduled ? 'Schedule it' : 'Send it'}
      cancelLabel="Keep editing"
      busy={busy}
      onCancel={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); onExecute(); }}
    />}
  </>, document.body);
}

/**
 * The dropdown out of one workspace and into another (team-workspace-access
 * design's "Team management surface"). Renders nothing at all -- not even a
 * collapsed control -- for the common case, one workspace: `useListOrganizations`
 * for the founder who has never added a teammate and never been added to
 * anyone else's workspace returns exactly the one he already owns, and a
 * switcher with one destination, itself, is not a switcher.
 *
 * `onSwitched` is the shell's own reload, handed down rather than reimplemented
 * here: `App()`'s `load()` re-reads the dashboard this new workspace owns, and
 * `reloadOutreach()` is the same broadcast every other ledger-changing action in
 * the LinkedIn screens already uses (LinkedInSafety.tsx) -- switching workspaces
 * changes every one of their reads at once, so it gets the same signal a skip or
 * a reply does, not a bespoke one.
 */
function WorkspaceSwitcher({ activeWorkspaceId, onSwitched }: { activeWorkspaceId: string; onSwitched: () => Promise<void> }) {
  const { data: organizations } = authClient.useListOrganizations();
  const [switching, setSwitching] = useState(false);

  if (!organizations || organizations.length <= 1) return null;

  const switchTo = async (organizationId: string) => {
    if (!organizationId || organizationId === activeWorkspaceId) return;
    setSwitching(true);
    try {
      await authClient.organization.setActive({ organizationId });
      await onSwitched();
    } finally { setSwitching(false); }
  };

  return <select
    className="workspace-switcher"
    disabled={switching}
    value={activeWorkspaceId}
    onChange={(event) => void switchTo(event.target.value)}
    aria-label="Switch workspace"
    title="Switch workspace"
  >
    {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
  </select>;
}

function NavButton({ active, icon, label, badge, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void;
}) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
    {icon}{label}
    {badge !== undefined && badge > 0 && <span className="status-pill" style={{ marginLeft: 'auto' }} aria-label={`${badge} waiting for you`}>{badge}</span>}
  </button>;
}

/**
 * The heading over each screen.
 *
 * The nav item says "Money"; the heading over the queue inside it stays "What
 * needs you". Both sentences are true and neither is redundant: one names the
 * place, the other names the job.
 */
function viewTitle(route: Route): string {
  if (route.section === 'loop') return route.sub === 'cost' ? 'What this cost' : 'Your loop';
  if (route.section === 'outreach') {
    // ONE NAME PER SCREEN, and it is the name in the nav.
    //
    // `manager` had no case at all, so the tab labelled "Campaigns" landed on a
    // heading that said "Outreach seat" -- and `campaigns`, which the nav calls
    // "Approve & export", took the title "Campaigns" for itself. Two screens
    // claiming one name is the exact confusion OUTREACH_ROUTES was reorganised
    // to remove: see the comment there for why the managed runner is the one
    // that gets the word.
    if (route.sub === 'accounts') return 'Target accounts';
    if (route.sub === 'campaigns') return 'Approve & export';
    if (route.sub === 'inbox') return 'Inbox';
    if (route.sub === 'activity') return 'LinkedIn activity';
    if (route.sub === 'leads') return 'Find people';
    if (route.sub === 'manager') return route.id === 'new' ? 'New campaign' : 'Campaigns';
    if (route.sub === 'plan') return 'Plan preview';
    if (route.sub === 'queue') return 'Queue';
    return 'LinkedIn accounts';
  }
  if (route.section === 'money') return 'What needs you';
  if (route.section === 'ledger') return 'Run ledger';
  // `spend` is a deep link into Agent access, so it is titled as the screen it
  // actually lands on rather than as a screen of its own.
  const sub = route.sub === 'spend' ? 'agent' : route.sub;
  const setup = SETUP_ROUTES.find((entry) => entry.sub === sub);
  return setup ? `Setup · ${setup.label}` : 'Setup';
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}
