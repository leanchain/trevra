import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Inbox, LoaderCircle, Send } from 'lucide-react';
import type { DashboardPayload, PlaybookRun } from '../../shared/types';
import {
  fetchLoopCost,
  getAgentSetup,
  getAgentTokens,
  getLinkedInActions,
  getLinkedInAnalytics,
  getLinkedInManagedCampaigns,
  getLinkedInManagerLeadLists,
  getPlaybookRuns,
  getPolicies,
  getToday,
  planGtmIntent,
  prepareCompiledGtmPlan,
  type LinkedInAnalytics,
  type LinkedInLimitsReport,
  type LoopCost
} from '../api';
import { errorMessage, useOutreachRefresh, useSeatLimits } from '../LinkedInSafety';
import { DEFAULT_WINDOW_DAYS, LinkedInFunnel } from '../LinkedInAnalyticsScreen';
import { ConfidenceTag, WindowPicker } from '../LinkedInViz';
import { Select } from '../ui/primitives';
import { ACTIVATION_STEPS, nextActivationStep, type ActivationSignals } from './activation';
import { money, usd } from './format';

type StageId = 'find' | 'reach' | 'answer';

interface Stage {
  id: StageId;
  label: string;
  value: string;
  unit: string;
  href: string | null;
  unavailable?: boolean;
}

interface Block {
  stage: StageId;
  sentence: string;
  action: string;
  href: string;
}

interface LoopData {
  planned: number | null;
  /** Of planned, the subset that is an invite rather than a follow-up step. */
  plannedInvites: number | null;
  waitingApprovals: PlaybookRun[] | null;
}

interface RemoteActivation {
  agent: boolean | null;
  policy: boolean | null;
  work: boolean | null;
  problems: string[];
}

function combineChecks(left: boolean | null, right: boolean | null): boolean | null {
  if (left === true || right === true) return true;
  if (left === false && right === false) return false;
  return null;
}

function useWorkspaceActivation(
  data: DashboardPayload,
  limits: LinkedInLimitsReport | null,
  seatError: string
) {
  const [remote, setRemote] = useState<RemoteActivation>({
    agent: null,
    policy: null,
    work: null,
    problems: []
  });

  const reload = useCallback(async () => {
    setRemote({ agent: null, policy: null, work: null, problems: [] });
    const [tokensResult, setupResult, policiesResult, listsResult, campaignsResult] =
      await Promise.allSettled([
        getAgentTokens(),
        getAgentSetup(),
        getPolicies(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagedCampaigns()
      ]);

    const problems: string[] = [];
    if (tokensResult.status === 'rejected') problems.push('agent access');
    if (setupResult.status === 'rejected') problems.push('hosted agent setup');
    if (policiesResult.status === 'rejected') problems.push('approval policies');
    if (listsResult.status === 'rejected') problems.push('People lists');
    if (campaignsResult.status === 'rejected') problems.push('campaigns');

    const tokenAgent =
      tokensResult.status === 'fulfilled'
        ? tokensResult.value.some((token) => !token.revokedAt)
        : null;
    const hostedAgent =
      setupResult.status === 'fulfilled'
        ? Boolean(
            setupResult.value &&
            ((setupResult.value.config && setupResult.value.secret) ||
              (setupResult.value.cli.config &&
                setupResult.value.cli.tokenStored &&
                setupResult.value.cli.riskAccepted))
          )
        : null;
    const policy =
      policiesResult.status === 'fulfilled'
        ? policiesResult.value.some((entry) => entry.enabled)
        : null;
    const listsHaveWork = listsResult.status === 'fulfilled' ? listsResult.value.length > 0 : null;
    const campaignsHaveWork =
      campaignsResult.status === 'fulfilled' ? campaignsResult.value.length > 0 : null;

    setRemote({
      agent: combineChecks(tokenAgent, hostedAgent),
      policy,
      work: combineChecks(listsHaveWork, campaignsHaveWork),
      problems
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const hasConnectedSource = data.connections.some(
    (connection) => connection.status === 'connected'
  );
  const source = hasConnectedSource ? true : limits ? Boolean(limits.seat?.configured) : null;
  const problems =
    !hasConnectedSource && seatError
      ? [...remote.problems, 'connected outreach source']
      : remote.problems;

  return {
    signals: {
      agent: remote.agent,
      source,
      policy: remote.policy,
      work: remote.work
    } satisfies ActivationSignals,
    problems,
    reload
  };
}

function ActivationGuide({
  signals,
  problems,
  onRetry,
  onNavigate,
  onPlan,
  onExplore
}: {
  signals: ActivationSignals;
  problems: string[];
  onRetry: () => void;
  onNavigate: (path: string) => void;
  onPlan: () => void;
  onExplore: () => void;
}) {
  const resolution = nextActivationStep(signals);
  const activeId = resolution.step?.id ?? null;

  return (
    <section className="onboarding-card activation-card" aria-labelledby="activation-title">
      <div className="onboarding-head">
        <div>
          <span className="activation-kicker">Workspace activation</span>
          <h2 id="activation-title">Get to one evidence-backed job</h2>
          <p>
            Trevra checks each prerequisite and gives you one next action. Nothing is sent merely
            because you finish setup.
          </p>
        </div>
        <span className="status-pill">
          {ACTIVATION_STEPS.filter((step) => signals[step.id] === true).length} of{' '}
          {ACTIVATION_STEPS.length}
        </span>
      </div>

      <ol className="onboarding-steps activation-steps">
        {ACTIVATION_STEPS.map((step, index) => {
          const done = signals[step.id] === true;
          const active = step.id === activeId;
          const stateLabel = done
            ? 'Complete'
            : active && resolution.state === 'next'
              ? 'Next'
              : active
                ? 'Not verified'
                : 'Later';
          return (
            <li
              key={step.id}
              className={done ? 'is-done' : active ? 'is-next' : undefined}
              aria-current={active && !done ? 'step' : undefined}
            >
              <span className="activation-step-index" aria-hidden="true">
                {done ? <CheckCircle2 size={18} /> : index + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
                <span className="activation-step-state">{stateLabel}</span>
              </div>
              {active && resolution.state === 'next' && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => (step.href ? onNavigate(step.href) : onPlan())}
                >
                  {step.action} <ChevronRight size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {resolution.state === 'unknown' &&
        (problems.length ? (
          <div className="activation-problem" role="alert">
            <p>
              Trevra could not verify {problems.join(', ')}. Those states remain unknown; they were
              not treated as empty.
            </p>
            <button className="primary-button" type="button" onClick={onRetry}>
              Check again
            </button>
          </div>
        ) : (
          <p className="onboarding-loading" role="status">
            <LoaderCircle className="spin" size={16} /> Checking this workspace…
          </p>
        ))}

      <div className="activation-actions">
        <p>External actions still stop at the approval boundary you set.</p>
        <button className="ghost-button" type="button" onClick={onExplore}>
          Explore without finishing setup
        </button>
      </div>
    </section>
  );
}

export function LoopView({
  data,
  onNavigate
}: {
  data: DashboardPayload;
  onNavigate: (path: string) => void;
}) {
  const { limits, error: seatError } = useSeatLimits();
  const activation = useWorkspaceActivation(data, limits, seatError);
  const [explore, setExplore] = useState(false);
  const [plannerInitiallyOpen, setPlannerInitiallyOpen] = useState(false);
  const [loop, setLoop] = useState<LoopData>({
    planned: null,
    plannedInvites: null,
    waitingApprovals: null
  });
  const [loopLoading, setLoopLoading] = useState(true);
  const [loopError, setLoopError] = useState('');
  const [cost, setCost] = useState<LoopCost | null>(null);
  const [today, setToday] = useState<Awaited<ReturnType<typeof getToday>> | null>(null);
  const [todayError, setTodayError] = useState('');
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const [analytics, setAnalytics] = useState<LinkedInAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState('');

  const loadLoop = useCallback(async () => {
    setLoopLoading(true);
    const [plannedResult, waitingResult, costResult] = await Promise.allSettled([
      getLinkedInActions({ status: 'planned', limit: 200 }),
      getPlaybookRuns({ status: 'waiting_approval', limit: 20 }),
      fetchLoopCost(30)
    ]);
    const unread: string[] = [];
    if (plannedResult.status === 'rejected') unread.push('queued outreach');
    if (waitingResult.status === 'rejected') unread.push('waiting approvals');
    if (costResult.status === 'rejected') unread.push('cost and activity');

    setLoop({
      planned: plannedResult.status === 'fulfilled' ? plannedResult.value.length : null,
      plannedInvites:
        plannedResult.status === 'fulfilled'
          ? plannedResult.value.filter((action) => action.kind === 'invite').length
          : null,
      waitingApprovals: waitingResult.status === 'fulfilled' ? waitingResult.value : null
    });
    setCost(costResult.status === 'fulfilled' ? costResult.value : null);
    setLoopError(
      unread.length
        ? 'Could not read ' +
            unread.join(', ') +
            '. Those values remain unknown; nothing was changed.'
        : ''
    );
    setLoopLoading(false);
  }, []);

  useEffect(() => {
    void loadLoop();
  }, [loadLoop]);

  const loadToday = useCallback(async () => {
    try {
      setToday(await getToday());
      setTodayError('');
    } catch (error) {
      setTodayError(errorMessage(error, 'Unable to read what needs you right now.'));
    }
  }, []);

  useEffect(() => {
    void loadToday();
  }, [loadToday]);
  useOutreachRefresh(loadToday);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      setAnalytics(await getLinkedInAnalytics(days));
      setAnalyticsError('');
    } catch (err) {
      setAnalytics(null);
      setAnalyticsError(
        errorMessage(err, 'Unable to read the outreach ledger. Nothing was changed — try again.')
      );
    } finally {
      setAnalyticsLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);
  useOutreachRefresh(loadAnalytics);

  const seat = limits?.seat ?? null;
  const queued = loop.planned;
  const invitesQueued = loop.plannedInvites;
  const followUpsQueued = queued !== null && invitesQueued !== null ? queued - invitesQueued : null;
  const funnel = analytics?.total ?? null;
  const waitingCount = loop.waitingApprovals?.length ?? null;
  const inviteDay =
    limits?.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day') ?? null;

  const stages: Stage[] = [
    {
      id: 'find',
      label: 'Find',
      value: 'Build a lead list',
      unit: 'CSV or search',
      href: '/outreach'
    },
    {
      id: 'reach',
      label: 'Reach',
      value: limits
        ? seat?.configured
          ? queued === null
            ? 'Not read'
            : String(queued)
          : 'No account'
        : seatError
          ? 'Not read'
          : 'Reading…',
      unit: limits
        ? seat?.configured
          ? queued === null
            ? 'unavailable'
            : 'queued'
          : 'connect an account'
        : seatError
          ? 'unavailable'
          : 'loading',
      href: limits ? (seat?.configured ? '/outreach' : '/setup/workspace') : null,
      unavailable: !limits || queued === null
    },
    {
      id: 'answer',
      label: 'Answer',
      value: 'Open Messages',
      unit: 'conversations',
      href: '/outreach/inbox'
    }
  ];

  const block = useMemo<Block | null>(() => {
    if (!limits) return null;
    if (seat?.configured && seat.posture === 'paused') {
      return {
        stage: 'reach',
        sentence:
          queued !== null && queued > 0
            ? String(queued) +
              ' scheduled ' +
              (queued === 1 ? 'action is' : 'actions are') +
              ' paused' +
              (seat.pausedReason ? ': ' + seat.pausedReason : '.')
            : 'This LinkedIn account is paused' +
              (seat.pausedReason ? ': ' + seat.pausedReason : '.'),
        action: 'Open workspace setup',
        href: '/setup/workspace'
      };
    }
    if (!seat?.configured)
      return {
        stage: 'reach',
        sentence: 'No LinkedIn account is connected.',
        action: 'Connect an account',
        href: '/setup/workspace'
      };
    if (waitingCount !== null && waitingCount > 0)
      return {
        stage: 'answer',
        sentence:
          String(waitingCount) +
          ' ' +
          (waitingCount === 1 ? 'run needs' : 'runs need') +
          ' your approval.',
        action: 'Open ledger',
        href: '/ledger'
      };
    if (queued === 0)
      return {
        stage: 'find',
        sentence: 'Nothing is queued.',
        action: 'Start a campaign',
        href: '/outreach'
      };
    return null;
  }, [limits, seat, queued, waitingCount]);

  if (!explore && activation.signals.work !== true) {
    return (
      <ActivationGuide
        signals={activation.signals}
        problems={activation.problems}
        onRetry={() => void activation.reload()}
        onNavigate={onNavigate}
        onPlan={() => {
          setPlannerInitiallyOpen(true);
          setExplore(true);
        }}
        onExplore={() => setExplore(true)}
      />
    );
  }

  const awaitingReply = funnel ? funnel.sent : null;

  return (
    <>
      <TodayAttention today={today} problem={todayError} onNavigate={onNavigate} />

      {today && today.needsAttention.length === 0 && block && (
        <section className="loop-block" aria-label="Current blocker">
          <div>
            <strong>Next operational decision</strong>
            <p>{block.sentence}</p>
          </div>
          <button className="primary-button" type="button" onClick={() => onNavigate(block.href)}>
            {block.action} <ChevronRight size={15} />
          </button>
        </section>
      )}

      {loopError && (
        <div className="loop-read-error" role="alert">
          <p>{loopError}</p>
          <button className="secondary-button" type="button" onClick={() => void loadLoop()}>
            Retry state
          </button>
        </div>
      )}

      <section className="loop-stages" aria-label="The outreach loop, stage by stage">
        {stages.map((stage) => {
          const className =
            'loop-stage' +
            (block?.stage === stage.id ? ' is-stuck' : '') +
            (stage.unavailable ? ' is-unavailable' : '');
          const inner = (
            <>
              <span>{stage.label}</span>
              <strong>{stage.value}</strong>
              <small>{stage.unit}</small>
            </>
          );
          return stage.href ? (
            <button
              key={stage.id}
              type="button"
              className={className}
              onClick={() => onNavigate(stage.href as string)}
            >
              {inner}
            </button>
          ) : (
            <div key={stage.id} className={className}>
              {inner}
            </div>
          );
        })}
      </section>

      <section className="metrics-grid metrics-grid-two" aria-label="Current outreach movement">
        <Metric
          icon={<Send />}
          label="Going out"
          value={
            invitesQueued === null || followUpsQueued === null
              ? '—'
              : String(invitesQueued) + ' / ' + String(followUpsQueued)
          }
          detail={
            !seat?.configured
              ? 'No LinkedIn account connected'
              : invitesQueued === null || followUpsQueued === null
                ? loopLoading
                  ? 'Reading queued actions…'
                  : 'Queued actions unavailable'
                : String(invitesQueued) +
                  ' invite' +
                  (invitesQueued === 1 ? '' : 's') +
                  ' · ' +
                  String(followUpsQueued) +
                  ' follow-up' +
                  (followUpsQueued === 1 ? '' : 's') +
                  ' queued' +
                  (inviteDay ? ' · ' + String(inviteDay.ceiling) + '/day invite limit' : '')
          }
        />
        <Metric
          icon={<Inbox />}
          label="Waiting on a reply"
          value={awaitingReply === null ? '—' : String(awaitingReply)}
          detail={analyticsError ? 'Outreach ledger unavailable' : 'Last ' + String(days) + ' days'}
        />
      </section>

      <PlanWork onNavigate={onNavigate} initiallyOpen={plannerInitiallyOpen} />

      <details className="loop-secondary">
        <summary>
          <span>
            <strong>Performance and cost</strong>
            <small>Outreach outcomes and model spend, when you need the detail.</small>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </summary>
        <div className="loop-secondary-body loop-performance-grid">
          <LinkedInFunnel
            analytics={analytics}
            loading={analyticsLoading}
            error={analyticsError}
            reload={loadAnalytics}
            days={days}
            onDaysChange={setDays}
          />

          <section className="page-panel loop-cost-summary">
            <div className="section-heading">
              <div>
                <h2>Model usage</h2>
                <p>Last 30 days.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onNavigate('/loop/cost')}
              >
                Cost details <ChevronRight size={15} />
              </button>
            </div>
            {cost ? (
              <div className="run-facts">
                <div className="run-fact">
                  <span>Spent</span>
                  <strong>{usd(cost.spent.costCents)}</strong>
                  <small>USD, billed by your model provider</small>
                </div>
                <div className="run-fact">
                  <span>Model calls</span>
                  <strong>{cost.spent.calls.toLocaleString('en-US')}</strong>
                </div>
              </div>
            ) : (
              <p className="onboarding-loading">
                {loopLoading ? 'Reading model usage…' : 'Model usage unavailable.'}
              </p>
            )}
          </section>
        </div>
      </details>
    </>
  );
}
function Metric({
  icon,
  label,
  value,
  detail
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric-card">
      <span className="metric-icon">{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function TodayAttention({
  today,
  problem,
  onNavigate
}: {
  today: Awaited<ReturnType<typeof getToday>> | null;
  problem: string;
  onNavigate: (path: string) => void;
}) {
  const items = today?.needsAttention ?? [];
  return (
    <section className="recommendations-panel">
      <div className="section-heading">
        <div>
          <h2>Needs you</h2>
          <p>Only GTM work Trevra cannot safely finish without your judgment.</p>
        </div>
        {today && <span className="status-pill">{items.length} open</span>}
      </div>

      {problem ? (
        <div className="error-banner">{problem}</div>
      ) : !today ? (
        <p className="onboarding-loading">
          <LoaderCircle className="spin" size={16} /> Reading your GTM state…
        </p>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2 size={24} />
          <h4>Nothing needs you right now</h4>
          <p>
            Trevra has no unresolved safety block, reply, approval, inbound request, or hot-account
            review to hand you.
          </p>
        </div>
      ) : (
        <ol className="onboarding-steps">
          {items.map((item) => (
            <li key={item.id}>
              <Inbox size={19} />
              <div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onNavigate(item.href)}
              >
                Open <ChevronRight size={15} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type PlannerObjective =
  'find_accounts' | 'research_accounts' | 'prepare_outreach' | 'watch_accounts' | 'capture_inbound';

const PLANNER_OBJECTIVES: ReadonlyArray<{ value: PlannerObjective; label: string }> = [
  { value: 'find_accounts', label: 'Find prospects' },
  { value: 'research_accounts', label: 'Research accounts' },
  { value: 'prepare_outreach', label: 'Prepare outreach' },
  { value: 'watch_accounts', label: 'Watch accounts' },
  { value: 'capture_inbound', label: 'Capture inbound' }
];

function plannerPrepareKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `gtm-plan-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function PlanWork({
  onNavigate,
  initiallyOpen = false
}: {
  onNavigate: (path: string) => void;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [objective, setObjective] = useState<PlannerObjective>('find_accounts');
  const [audience, setAudience] = useState('');
  const [quantity, setQuantity] = useState(25);
  const [leadLists, setLeadLists] = useState<
    Awaited<ReturnType<typeof getLinkedInManagerLeadLists>>
  >([]);
  const [leadListId, setLeadListId] = useState('');
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof planGtmIntent>> | null>(null);
  const [prepared, setPrepared] = useState<Awaited<
    ReturnType<typeof prepareCompiledGtmPlan>
  > | null>(null);
  const [prepareKey, setPrepareKey] = useState('');
  const [planning, setPlanning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getLinkedInManagerLeadLists()
      .then((lists) => {
        if (cancelled) return;
        setLeadLists(lists);
        setLeadListId((current) =>
          current && lists.some((list) => list.id === current) ? current : (lists[0]?.id ?? '')
        );
      })
      .catch(() => {
        if (!cancelled) setLeadLists([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetPlan = () => {
    setPlan(null);
    setPrepared(null);
    setPrepareKey('');
    setProblem('');
  };

  const compile = async () => {
    setPlanning(true);
    setProblem('');
    setPrepared(null);
    try {
      const intent =
        objective === 'prepare_outreach'
          ? {
              objective,
              ...(leadListId ? { people: { existingListId: leadListId } } : {}),
              channels: ['linkedin'] as Array<'linkedin' | 'email' | 'community'>,
              autonomy: 'approval_required' as const
            }
          : objective === 'capture_inbound'
            ? { objective }
            : {
                objective,
                audience: {
                  ...(audience.trim() ? { description: audience.trim() } : {}),
                  quantity
                }
              };
      const next = await planGtmIntent(intent);
      setPlan(next);
      setPrepareKey(plannerPrepareKey());
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to plan this GTM job. Nothing was changed.'));
    } finally {
      setPlanning(false);
    }
  };

  const prepare = async () => {
    if (!plan) return;
    const key = prepareKey || plannerPrepareKey();
    if (!prepareKey) setPrepareKey(key);
    setPreparing(true);
    setProblem('');
    try {
      setPrepared(await prepareCompiledGtmPlan(plan, key));
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to prepare this GTM plan. Nothing was sent.'));
    } finally {
      setPreparing(false);
    }
  };

  const prepareSupported = plan?.defaults.prepareSupported === true && plan.blockers.length === 0;

  return (
    <section className="page-panel gtm-plan-work">
      <div className="section-heading">
        <div>
          <h2>Start new work</h2>
          <p>
            State a bounded GTM job, inspect Trevra's deterministic plan, then prepare only what the
            plan allows.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Close' : 'Plan work'}
        </button>
      </div>

      {open && (
        <div className="gtm-plan-body">
          <div className="gtm-plan-form">
            <label>
              Goal
              <Select
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value as PlannerObjective);
                  resetPlan();
                }}
              >
                {PLANNER_OBJECTIVES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </label>

            {objective === 'prepare_outreach' ? (
              <label>
                People
                <Select
                  value={leadListId}
                  onChange={(event) => {
                    setLeadListId(event.target.value);
                    resetPlan();
                  }}
                >
                  <option value="">Choose a People list</option>
                  {leadLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} · {list.leadCount} people
                    </option>
                  ))}
                </Select>
              </label>
            ) : objective === 'capture_inbound' ? null : (
              <>
                <label>
                  Audience
                  <input
                    value={audience}
                    onChange={(event) => {
                      setAudience(event.target.value);
                      resetPlan();
                    }}
                    placeholder="Swiss B2B SaaS companies hiring salespeople"
                    maxLength={500}
                  />
                </label>
                <label>
                  Quantity
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={quantity}
                    onChange={(event) => {
                      setQuantity(Math.max(1, Math.min(500, Number(event.target.value) || 1)));
                      resetPlan();
                    }}
                  />
                </label>
              </>
            )}

            <button
              className="primary-button"
              type="button"
              disabled={planning}
              onClick={() => void compile()}
            >
              {planning ? 'Planning…' : 'Show plan'}
            </button>
          </div>

          {problem && <div className="error-banner">{problem}</div>}

          {plan && (
            <div className="gtm-plan-preview">
              <div className="gtm-plan-preview-head">
                <div>
                  <span>Your plan</span>
                  <strong>{plan.summary}</strong>
                </div>
                <span className="status-pill">
                  {plan.consequences.externalWrites ? 'External write' : 'No external write'}
                </span>
              </div>

              <ol className="gtm-plan-steps">
                {plan.steps.map((step) => (
                  <li key={`${step.kind}:${step.title}`}>
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))}
              </ol>

              {plan.blockers.length > 0 && (
                <div className="gtm-plan-blockers">
                  <strong>
                    {plan.blockers.length === 1 ? 'One thing is missing' : 'Things to resolve'}
                  </strong>
                  {plan.blockers.map((blocker) => (
                    <div key={blocker.code}>
                      <span>{blocker.message}</span>
                      {blocker.actionHref && (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => onNavigate(blocker.actionHref!)}
                        >
                          Resolve <ChevronRight size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="gtm-plan-actions">
                {prepareSupported ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={preparing}
                    onClick={() => void prepare()}
                  >
                    {preparing ? 'Preparing…' : 'Prepare this'}
                  </button>
                ) : plan.blockers.length === 0 ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => onNavigate(plan.next.href)}
                  >
                    Continue <ChevronRight size={15} />
                  </button>
                ) : null}
                <span>
                  {plan.consequences.approvalRequired
                    ? 'Nothing will be sent until the consequential action is approved.'
                    : 'This plan contains no consequential external action.'}
                </span>
              </div>

              {prepared && (
                <div className="gtm-plan-result">
                  <strong>Prepared</strong>
                  <span>
                    {prepared.result.campaign.enrolled} people · campaign remains{' '}
                    {prepared.result.campaign.status}
                  </span>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => onNavigate(prepared.next.href)}
                  >
                    Review campaign <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
export function LoopCostView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [days, setDays] = useState(30);
  const [cost, setCost] = useState<LoopCost | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const next = await fetchLoopCost(days);
        if (!cancelled) {
          setCost(next);
          setProblem('');
        }
      } catch (error) {
        if (!cancelled)
          setProblem(
            error instanceof Error
              ? error.message
              : 'Could not read this period. Nothing changed — try again.'
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="page-stack">
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h2>What this cost, and what it produced</h2>
            <p>One period, three rows. The rows are adjacent; they are not a chain.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => onNavigate('/loop')}>
            Back to the loop
          </button>
        </div>
        <WindowPicker days={days} onDaysChange={setDays} loading={loading} standalone />
        {problem && (
          <div className="error-banner">
            <strong>{problem}</strong> The period selector still works — pick another window, or try
            this one again.
          </div>
        )}
      </section>

      {!cost && loading && (
        <section className="page-panel">
          <div className="empty-state">
            <LoaderCircle className="spin" size={28} />
            <h4 aria-level={2}>Reading the period…</h4>
            <p>One moment.</p>
          </div>
        </section>
      )}

      {cost && (
        <>
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h2>Spent</h2>
                <p>
                  {usd(cost.spent.costCents)} on {cost.spent.calls.toLocaleString('en-US')} model{' '}
                  {cost.spent.calls === 1 ? 'call' : 'calls'} in this window. Every figure in this
                  panel is USD, billed by your model provider. Trevra does not model customer
                  revenue or payment state.
                </p>
              </div>
              <span className="status-pill">{usd(cost.spent.budget.spentCents)} this month</span>
            </div>

            {/* The meter is month-to-date and the table is the window. Two spans,
            said out loud, because they are two different numbers and putting
            them side by side without saying so is how a founder concludes the
            product cannot add up. */}
            <p className="byok-meter-copy">
              The cap is a calendar month: {usd(cost.spent.budget.spentCents)} of{' '}
              {usd(cost.spent.budget.monthlyCapCents)} used since{' '}
              {new Date(cost.spent.budget.periodStart).toLocaleDateString()}. The table below is the{' '}
              {cost.windowDays}-day window you picked.
            </p>
            {cost.spent.budget.spentCents > 0 && (
              <div className="byok-meter">
                <i
                  style={{
                    width: `${Math.min(100, Math.round((cost.spent.budget.spentCents / Math.max(cost.spent.budget.monthlyCapCents, 1)) * 100))}%`
                  }}
                />
              </div>
            )}

            <div className="cost-table">
              {cost.spent.byModel.map((line) => (
                <div className="cost-row is-spend" key={`${line.model}:${line.confidence}`}>
                  <span>{line.model}</span>
                  <ConfidenceTag
                    confidence={line.confidence}
                    source={
                      line.usageReported
                        ? 'your provider reported this usage'
                        : 'estimated from a list-price table'
                    }
                  />
                  <span>
                    {line.calls.toLocaleString('en-US')} {line.calls === 1 ? 'call' : 'calls'}
                  </span>
                  <strong>{usd(line.costCents)}</strong>
                </div>
              ))}
              {cost.spent.byModel.length === 0 && (
                <p className="empty-copy">No paid model call in this window.</p>
              )}
            </div>
            <p className="cost-note">
              <strong>HARD FACT</strong> means your provider reported what that call actually used.{' '}
              <strong>REPORTED</strong> means nothing came back and Trevra priced it from a
              list-price table — deliberately high, so the cap holds. A model that reported some
              calls and not others appears twice, because averaging the two would erase the
              difference.
            </p>
            <div className="panel-footer">
              <span>The cap and the spending switch are settings, so they live in Setup.</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onNavigate('/setup')}
              >
                Change the cap <ChevronRight size={15} />
              </button>
            </div>
          </section>

          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h2>Sent</h2>
                <p>
                  What actually left, in the same window. Scheduled and skipped actions are not in
                  here.
                </p>
              </div>
              <span className="status-pill">
                {cost.sent.actionsTotal.toLocaleString('en-US')} actions
              </span>
            </div>
            <div className="cost-table">
              {cost.sent.actions.map((action) => (
                <div className="cost-row" key={action.kind}>
                  <span>{action.kind.replaceAll('_', ' ')}</span>
                  <strong>{action.count.toLocaleString('en-US')}</strong>
                </div>
              ))}
              {cost.sent.actions.length === 0 && (
                <p className="empty-copy">Nothing went out in this window.</p>
              )}
            </div>
            {/* Operational/debugging detail -- how the agent runs behind this
                spend behaved -- not part of the cost summary itself, so it
                stays closed by default. The counts are already in `cost`,
                fetched above for this same window; opening this costs no
                extra read. */}
            <details className="run-raw">
              <summary>
                Agent run detail ({cost.sent.agentRuns.total.toLocaleString('en-US')} runs)
              </summary>
              <div className="run-facts">
                <div className="run-fact">
                  <span>Agent runs</span>
                  <strong>{cost.sent.agentRuns.total.toLocaleString('en-US')}</strong>
                </div>
                <div className="run-fact">
                  <span>Completed</span>
                  <strong>{cost.sent.agentRuns.completed.toLocaleString('en-US')}</strong>
                </div>
                <div className="run-fact">
                  <span>Failed</span>
                  <strong>{cost.sent.agentRuns.failed.toLocaleString('en-US')}</strong>
                </div>
                <div className="run-fact">
                  <span>Stopped</span>
                  <strong>{cost.sent.agentRuns.stopped.toLocaleString('en-US')}</strong>
                </div>
                <div className="run-fact">
                  <span>Still running</span>
                  <strong>{cost.sent.agentRuns.running.toLocaleString('en-US')}</strong>
                </div>
              </div>
            </details>
          </section>
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h2>Produced</h2>
                <p>Outreach outcomes recorded in the same window.</p>
              </div>
            </div>
            <div className="cost-table">
              <div className="cost-row">
                <span>Invites accepted</span>
                <strong>{cost.produced.accepted.toLocaleString('en-US')}</strong>
              </div>
              <div className="cost-row">
                <span>Replies</span>
                <strong>{cost.produced.replied.toLocaleString('en-US')}</strong>
              </div>
            </div>
          </section>

          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h2>Where these came from</h2>
                <p>Every number above is a read of something already recorded.</p>
              </div>
            </div>
            <div className="run-facts">
              <div className="run-fact">
                <span>Window</span>
                <strong>
                  {cost.windowDays} days, from {new Date(cost.since).toLocaleDateString()}
                </strong>
              </div>
            </div>
            <div className="panel-footer">
              <span>The evidence behind each run is in the ledger.</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onNavigate('/ledger')}
              >
                Open the run ledger <ChevronRight size={15} />
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
