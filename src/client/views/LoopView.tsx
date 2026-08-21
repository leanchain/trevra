import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock3, Inbox, LoaderCircle, Send } from 'lucide-react';
import type { DashboardPayload, PlaybookRun } from '../../shared/types';
import {
  fetchLoopCost,
  getLinkedInActions,
  getLinkedInAnalytics,
  getLinkedInManagedCampaigns,
  getLinkedInManagerLeadLists,
  getPlaybookRuns,
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
  planned: number;
  /** Of `planned`, the subset that is an invite rather than a follow-up step. */
  plannedInvites: number;
  waitingApprovals: PlaybookRun[];
}

export function LoopView({
  data: _data,
  onNavigate
}: {
  data: DashboardPayload;
  onNavigate: (path: string) => void;
}) {
  const { limits, error: seatError } = useSeatLimits();
  const [loop, setLoop] = useState<LoopData>({
    planned: 0,
    plannedInvites: 0,
    waitingApprovals: []
  });
  const [cost, setCost] = useState<LoopCost | null>(null);
  const [today, setToday] = useState<Awaited<ReturnType<typeof getToday>> | null>(null);
  const [todayError, setTodayError] = useState('');

  // The one operator-controlled window for this page's outreach numbers --
  // shared by the metric cards below and by <LinkedInFunnel>, so the two can
  // never disagree about what period they are counting.
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const [analytics, setAnalytics] = useState<LinkedInAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [planned, waiting] = await Promise.all([
        getLinkedInActions({ status: 'planned', limit: 200 }).catch(() => []),
        getPlaybookRuns({ status: 'waiting_approval', limit: 20 }).catch(() => [] as PlaybookRun[])
      ]);
      if (!cancelled)
        setLoop({
          planned: planned.length,
          plannedInvites: planned.filter((action) => action.kind === 'invite').length,
          waitingApprovals: waiting
        });
    })();
    void fetchLoopCost(30)
      .then((next) => {
        if (!cancelled) setCost(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
  const followUpsQueued = queued - invitesQueued;
  const funnel = analytics?.total ?? null;
  const waitingCount = loop.waitingApprovals.length;
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
          ? String(queued)
          : 'No account'
        : seatError
          ? 'Not read'
          : 'Reading…',
      unit: limits
        ? seat?.configured
          ? 'queued'
          : 'connect an account'
        : seatError
          ? 'unavailable'
          : 'loading',
      href: limits ? (seat?.configured ? '/outreach' : '/outreach/settings') : null,
      unavailable: !limits
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
          queued > 0
            ? `${queued} scheduled ${queued === 1 ? 'action is' : 'actions are'} paused${seat.pausedReason ? `: ${seat.pausedReason}` : '.'}`
            : `This LinkedIn account is paused${seat.pausedReason ? `: ${seat.pausedReason}` : '.'}`,
        action: 'Open Settings',
        href: '/outreach/settings'
      };
    }
    if (!seat?.configured)
      return {
        stage: 'reach',
        sentence: 'No LinkedIn account is connected.',
        action: 'Connect an account',
        href: '/outreach/settings'
      };
    if (waitingCount > 0)
      return {
        stage: 'answer',
        sentence: `${waitingCount} ${waitingCount === 1 ? 'run needs' : 'runs need'} your approval.`,
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

  const awaitingReply = funnel?.sent ?? 0;
  const accepted = funnel?.accepted ?? 0;
  const replied = funnel?.replied ?? 0;

  return (
    <>
      <TodayAttention today={today} problem={todayError} onNavigate={onNavigate} />
      <FirstRunJobs limits={limits} onNavigate={onNavigate} />
      <PlanWork onNavigate={onNavigate} />

      <section className="loop-stages" aria-label="The outreach loop, stage by stage">
        {stages.map((stage) => {
          const className = `loop-stage${block?.stage === stage.id ? ' is-stuck' : ''}${stage.unavailable ? ' is-unavailable' : ''}`;
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

      <section className="metrics-grid metrics-grid-four">
        {/* Repurposed from a bare queued count -- the Reach stage tile above
            already states that number once. This tile instead breaks it down
            by what it is: an invite vs. a follow-up in an existing sequence. */}
        <Metric
          icon={<Send />}
          label="Going out"
          value={seat?.configured ? `${invitesQueued} / ${followUpsQueued}` : '—'}
          detail={
            !seat?.configured
              ? 'No LinkedIn account connected'
              : `${invitesQueued} invite${invitesQueued === 1 ? '' : 's'} · ${followUpsQueued} follow-up${followUpsQueued === 1 ? '' : 's'} queued${inviteDay ? ` · ${inviteDay.ceiling}/day invite limit` : ''}`
          }
        />
        <Metric
          icon={<Inbox />}
          label="Waiting on a reply"
          value={String(awaitingReply)}
          detail={`Last ${days} days`}
        />
        <Metric
          icon={<CheckCircle2 />}
          label="Accepted / replied"
          value={String(accepted + replied)}
          detail={`${accepted} accepted · ${replied} replied`}
        />
        <Metric
          icon={<Clock3 />}
          label="Waiting on you"
          value={String(today?.needsAttention.length ?? waitingCount)}
          detail={today?.needsAttention.length ? 'Across GTM' : 'Nothing waiting'}
        />
      </section>

      {cost && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h2>Cost and activity</h2>
              <p>Last 30 days.</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onNavigate('/loop/cost')}
            >
              View details <ChevronRight size={15} />
            </button>
          </div>
          <div className="run-facts">
            <div className="run-fact">
              <span>Spent on models</span>
              <strong>{usd(cost.spent.costCents)}</strong>
              <small>USD, billed by your model provider</small>
            </div>
            <div className="run-fact">
              <span>Outreach actions sent</span>
              <strong>{cost.sent.actionsTotal.toLocaleString('en-US')}</strong>
            </div>
          </div>
        </section>
      )}

      <LinkedInFunnel
        analytics={analytics}
        loading={analyticsLoading}
        error={analyticsError}
        reload={loadAnalytics}
        days={days}
        onDaysChange={setDays}
      />

      {loop.waitingApprovals.length > 0 && (
        <section className="recommendations-panel">
          <div className="section-heading">
            <div>
              <h2>What needs you</h2>
              <p>Runs waiting for your approval.</p>
            </div>
            <span className="status-pill">{waitingCount} open</span>
          </div>
          {/* The count and the "needs your approval" fact are already stated
              once each above (status pill; loop-block CTA when this is the
              loop's top issue) -- this panel's job is the list of runs, not a
              third restatement of the sentence. */}
          <div className="workflow-approval">
            <div>
              {loop.waitingApprovals.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="secondary-button run-open"
                  onClick={() => onNavigate(`/ledger/run/${run.id}`)}
                >
                  {run.playbookId} <ChevronRight size={15} />
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
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

function PlanWork({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
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
              <select
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
              </select>
            </label>

            {objective === 'prepare_outreach' ? (
              <label>
                People
                <select
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
                </select>
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

function FirstRunJobs({
  limits,
  onNavigate
}: {
  limits: LinkedInLimitsReport | null;
  onNavigate: (path: string) => void;
}) {
  const [workspaceShape, setWorkspaceShape] = useState<{
    leadLists: number;
    campaigns: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getLinkedInManagerLeadLists().catch(() => []),
      getLinkedInManagedCampaigns().catch(() => [])
    ]).then(([leadLists, campaigns]) => {
      if (!cancelled)
        setWorkspaceShape({ leadLists: leadLists.length, campaigns: campaigns.length });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!workspaceShape) {
    return (
      <section className="onboarding-card">
        <p className="onboarding-loading">
          <LoaderCircle className="spin" size={16} /> Checking your workspace…
        </p>
      </section>
    );
  }

  const materiallyEmpty =
    !limits?.seat?.configured && workspaceShape.leadLists === 0 && workspaceShape.campaigns === 0;
  if (!materiallyEmpty) return null;

  const jobs = [
    {
      title: 'Find prospects',
      detail: 'Find and rank companies worth investigating.',
      href: '/research'
    },
    {
      title: 'Prepare outreach',
      detail: 'Turn known people into a campaign that is ready for review.',
      href: '/outreach/new'
    },
    {
      title: 'Watch accounts',
      detail: 'Monitor target companies and surface source-backed reasons to act.',
      href: '/research'
    },
    {
      title: 'Capture inbound',
      detail: 'Route demo, contact, waitlist, and signup submissions into Trevra.',
      href: '/setup/capture'
    }
  ] as const;

  return (
    <section className="onboarding-card">
      <div className="onboarding-head">
        <div>
          <h2>What do you want Trevra to do?</h2>
          <p>Choose a GTM job. You can inspect the machinery later if you need it.</p>
        </div>
      </div>
      <ol className="onboarding-steps">
        {jobs.map((job) => (
          <li key={job.title}>
            <Send size={19} />
            <div>
              <strong>{job.title}</strong>
              <small>{job.detail}</small>
            </div>
            <button className="primary-button" type="button" onClick={() => onNavigate(job.href)}>
              Start <ChevronRight size={15} />
            </button>
          </li>
        ))}
      </ol>
      <p className="onboarding-loading">
        Nothing is sent just because Trevra prepared it. External actions require approval by
        default.
      </p>
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
