import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDollarSign,
  Clock3,
  Inbox,
  LoaderCircle,
  Send
} from 'lucide-react';
import type { DashboardPayload, PlaybookRun, Recommendation } from '../../shared/types';
import {
  fetchLoopCost,
  getAgentTokens,
  getLinkedInActions,
  getLinkedInAnalytics,
  getLinkedInManagedCampaigns,
  getLinkedInManagerLeadLists,
  getLinkedInManagerWorkflows,
  getPlaybookRuns,
  type LinkedInAnalytics,
  type LinkedInLimitsReport,
  type LoopCost
} from '../api';
import { useSeatLimits } from '../LinkedInSafety';
import { LinkedInFunnel } from '../LinkedInAnalyticsScreen';
import { ConfidenceTag, WindowPicker } from '../LinkedInViz';
import { money, usd } from './format';
import { EmptyRecommendations, RecommendationList, type RecommendationActions } from './recommendations';

/* --------------------------------------------------------------------------
 * The home screen answers one question: what is the loop doing, and where is
 * it stuck.
 *
 * Not "what am I owed". `TodayView` opened on three variants of a hero card
 * and four tiles, and every one of those tiles was a RESULT or a config count
 * -- at risk, ready to invoice, collected, connected tools. None of them was a
 * queue with an owner, so none of them could be acted on, and none of them
 * said anything at all about the half of the loop that produces the work in
 * the first place.
 *
 * Six cells, one sentence, four queues. The decorative offset circle that used
 * to render `openRecommendations` a second time is gone: it was a number the
 * tiles already carried.
 * -------------------------------------------------------------------------- */

/** The six stages, in the order they happen. `docs/founder-skills.md` §2. */
type StageId = 'find' | 'reach' | 'answer' | 'deliver' | 'bill' | 'paid';

interface Stage {
  id: StageId;
  label: string;
  /** The number, or the words that stand in for a number nobody can prove. */
  value: string;
  unit: string;
  href: string | null;
  /** No backend in this build. Renders as words; never as a zero. */
  unavailable?: boolean;
}

/** The block: which stage is holding the loop up, and the one thing that clears it. */
interface Block {
  stage: StageId;
  sentence: string;
  action: string;
  href: string;
}

export interface LoopData {
  planned: number;
  exported: number;
  waitingApprovals: PlaybookRun[];
  analytics: LinkedInAnalytics | null;
}

export function LoopView({ data, recommendations, actions, onNavigate }: {
  data: DashboardPayload;
  /** The list minus anything still sitting inside its undo window. */
  recommendations: Recommendation[];
  actions: RecommendationActions;
  onNavigate: (path: string) => void;
}) {
  const { limits, error: seatError } = useSeatLimits();
  const [loop, setLoop] = useState<LoopData>({ planned: 0, exported: 0, waitingApprovals: [], analytics: null });
  const [cost, setCost] = useState<LoopCost | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Every one of these is optional: a build without the hosted agent, or a
      // workspace with no seat, must not take the home screen down.
      const [planned, exported, waiting, analytics] = await Promise.all([
        getLinkedInActions({ status: 'planned', limit: 200 }).catch(() => []),
        getLinkedInActions({ status: 'exported', limit: 200 }).catch(() => []),
        getPlaybookRuns({ status: 'waiting_approval', limit: 20 }).catch(() => [] as PlaybookRun[]),
        getLinkedInAnalytics(7).catch(() => null)
      ]);
      if (cancelled) return;
      setLoop({ planned: planned.length, exported: exported.length, waitingApprovals: waiting, analytics });
    })();
    void fetchLoopCost(30).then((next) => { if (!cancelled) setCost(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const metrics = data.metrics;
  const seat = limits?.seat ?? null;
  const queued = loop.planned + loop.exported;
  const funnel = loop.analytics?.total ?? null;
  const waitingCount = metrics.openRecommendations + loop.waitingApprovals.length;
  const isNew = data.clients.length === 0 && data.recommendations.length === 0 && !seat?.configured;

  const inviteDay = limits?.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day') ?? null;

  const stages: Stage[] = [
    {
      id: 'find',
      label: 'Find',
      // Lead sourcing has a module and a migration and NO route, and the
      // migration header switches it off on a hosted deployment outright. A
      // cell reading `0` would blame the operator for a switch they cannot
      // reach, so this one names the thing they CAN do.
      value: 'Build a lead list',
      unit: 'from a CSV or a search',
      href: '/outreach/manager'
    },
    {
      id: 'reach',
      label: 'Reach',
      // Until the seat has been read, this cell says it has not been read. "No
      // seat" on a workspace that has one, for the half-second before the
      // request lands, is a false statement about the thing this screen is
      // for.
      value: limits ? (seat?.configured ? String(queued) : 'No account') : seatError ? 'Not read' : 'Reading…',
      unit: limits
        ? (seat?.configured ? 'queued' : 'connect one first')
        : seatError ? 'the account could not be read' : 'one moment',
      href: limits ? (seat?.configured ? '/outreach/queue' : '/outreach') : null,
      unavailable: !limits
    },
    {
      id: 'answer',
      label: 'Answer',
      // The inbox reads real threads now, but this screen does not read them:
      // it would be a fourth request on the home screen for a number nothing
      // here decides on. So the cell names the screen that has the answer
      // rather than inventing a count -- and never renders a 0 it did not
      // count.
      value: 'Open the inbox',
      unit: 'replies to you land there',
      href: '/outreach/inbox',
      unavailable: true
    },
    {
      id: 'deliver',
      label: 'Deliver',
      value: String(data.clients.length),
      unit: data.clients.length === 1 ? 'client' : 'clients',
      href: '/money'
    },
    {
      id: 'bill',
      label: 'Bill',
      value: money(metrics.readyToInvoice, metrics.currency),
      unit: 'delivered, not billed',
      href: '/money'
    },
    {
      id: 'paid',
      label: 'Paid',
      value: String(metrics.overdueInvoices),
      unit: metrics.overdueInvoices === 1 ? 'invoice overdue' : 'invoices overdue',
      href: '/money'
    }
  ];

  const block = useMemo<Block | null>(() => {
    // Nothing is claimed to be stuck until the seat has actually been read.
    // "No seat is configured" is the loudest sentence on this screen and it
    // must never be the one shown while a request is in flight.
    if (!limits) return null;
    // Exactly one, and the earliest one that is genuinely holding up the rest:
    // clearing a later stage while an earlier one is stopped just refills the
    // same queue.
    if (seat?.configured && seat.posture === 'paused') {
      return {
        stage: 'reach',
        sentence: queued > 0
          ? `${queued} ${queued === 1 ? 'action is' : 'actions are'} scheduled and this LinkedIn account is paused${seat.pausedReason ? ` — ${seat.pausedReason}` : ''}. Resume it, or lower the daily limit.`
          : `This LinkedIn account is paused${seat.pausedReason ? `: ${seat.pausedReason}` : '.'} Nothing will be scheduled until it is resumed.`,
        action: 'Open the account',
        href: '/outreach'
      };
    }
    if (!seat?.configured) {
      return {
        stage: 'reach',
        sentence: 'No LinkedIn account is connected, so nothing can be scheduled and nothing can go out.',
        action: 'Connect an account',
        href: '/outreach'
      };
    }
    if (waitingCount > 0) {
      return {
        stage: metrics.readyToInvoice > 0 ? 'bill' : 'paid',
        sentence: `${waitingCount} ${waitingCount === 1 ? 'thing needs' : 'things need'} your decision${metrics.revenueAtRisk > 0 ? `, worth ${money(metrics.revenueAtRisk, metrics.currency)}` : ''}. Nothing moves until you decide.`,
        action: 'Review them',
        href: '/money'
      };
    }
    if (queued === 0) {
      return {
        stage: 'find',
        sentence: 'Your LinkedIn account is ready and nothing is queued to go out.',
        action: 'Start a campaign',
        href: '/outreach/manager'
      };
    }
    return null;
  }, [limits, seat, queued, waitingCount, metrics.readyToInvoice, metrics.revenueAtRisk, metrics.currency]);

  const goingOut = queued;
  const awaitingReply = funnel?.sent ?? 0;
  const answered = (funnel?.accepted ?? 0) + (funnel?.replied ?? 0);
  const decided = awaitingReply + answered;

  return <>
    {isNew && <OnboardingChecklist data={data} limits={limits} onNavigate={onNavigate} />}

    <section className="loop-stages" aria-label="The loop, stage by stage">
      {stages.map((stage) => {
        const className = `loop-stage${block?.stage === stage.id ? ' is-stuck' : ''}${stage.unavailable ? ' is-unavailable' : ''}`;
        const inner = <><span>{stage.label}</span><strong>{stage.value}</strong><small>{stage.unit}</small></>;
        return stage.href
          ? <button key={stage.id} type="button" className={className} onClick={() => onNavigate(stage.href as string)}>{inner}</button>
          : <div key={stage.id} className={className}>{inner}</div>;
      })}
    </section>

    <section className="loop-block">
      {block
        ? <>
            {/* The stage is named in words, not only by the highlight two rows up. */}
            <p><strong>{stages.find((stage) => stage.id === block.stage)?.label}.</strong> {block.sentence}</p>
            <button className="primary-button" type="button" onClick={() => onNavigate(block.href)}>
              {block.action} <ChevronRight size={16} />
            </button>
          </>
        : limits
          // Word for word what this screen already said, and it was already right.
          ? <p>Nothing needs you right now.</p>
          : seatError
            ? <p>{seatError}</p>
            : <p>Reading where the loop stands…</p>}
    </section>

    {!isNew && <OnboardingChecklist data={data} limits={limits} onNavigate={onNavigate} />}

    {/* Four queues, each one a thing somebody owns. Not four results. */}
    <section className="metrics-grid metrics-grid-four">
      <Metric
        icon={<Send />}
        label="Going out this week"
        value={String(goingOut)}
        detail={!seat?.configured
          ? 'No LinkedIn account is connected yet'
          : inviteDay
            ? `of ${inviteDay.ceiling} invites a day this account may send`
            : 'No daily limit has been worked out for this account yet'}
      />
      <Metric
        icon={<Inbox />}
        label="Waiting on a reply"
        value={String(awaitingReply)}
        detail={decided > 0
          ? `${answered} answered · ${Math.round((answered / decided) * 100)}%`
          : 'Nothing has gone out in the last 7 days'}
      />
      <Metric
        icon={<Clock3 />}
        label="Waiting on you"
        value={String(waitingCount)}
        detail={metrics.revenueAtRisk > 0
          ? `${money(metrics.revenueAtRisk, metrics.currency)} is waiting on your decision`
          : 'Nothing is held up on a decision'}
      />
      <Metric
        icon={<CircleDollarSign />}
        label="Waiting to be paid"
        value={money(metrics.readyToInvoice + metrics.revenueAtRisk, metrics.currency)}
        detail={`${money(metrics.revenueAtRisk, metrics.currency)} billed and unpaid, ${money(metrics.readyToInvoice, metrics.currency)} delivered and unbilled`}
      />
    </section>

    {cost && <section className="page-panel">
      <div className="section-heading">
        <div><h2>What this cost, and what it produced</h2><p>The last 30 days. Three numbers; the rest is one screen away.</p></div>
        <button className="secondary-button" type="button" onClick={() => onNavigate('/loop/cost')}>See all of it <ChevronRight size={15} /></button>
      </div>
      {/* Model spend is the one figure on this screen that is not in the
          workspace's currency, and it sat unlabelled beside one that is --
          "$0.10" next to "€0", with nothing saying they are different units.
          The label says which, rather than the reader guessing. */}
      <div className="run-facts">
        <div className="run-fact"><span>Spent on models</span><strong>{usd(cost.spent.costCents)}</strong><small>USD, billed by your model provider</small></div>
        <div className="run-fact"><span>Outreach actions sent</span><strong>{cost.sent.actionsTotal.toLocaleString('en-US')}</strong></div>
        <div className="run-fact"><span>Collected</span><strong>{money(cost.produced.revenueCollected, cost.produced.currency)}</strong></div>
      </div>
      <p className="panel-note">{cost.produced.attribution}</p>
    </section>}

    {/* The funnel belongs where the loop is read, not behind an analytics tab. */}
    <LinkedInFunnel />

    <section className="recommendations-panel">
      <div className="section-heading">
        <div><h2>What needs you</h2><p>Ranked by what it costs you to ignore. Press <kbd>j</kbd> and <kbd>k</kbd> to move through them.</p></div>
        <span className="status-pill">{waitingCount} open</span>
      </div>

      {/* A job that stopped for an approval used to be visible only if you
          happened to open Activity. It is a decision waiting on a human, so it
          belongs on the screen that lists decisions waiting on a human. */}
      {loop.waitingApprovals.length > 0 && <div className="workflow-approval">
        <div className="approval-banner">
          <CircleAlert size={19} />
          <p><strong>{loop.waitingApprovals.length} {loop.waitingApprovals.length === 1 ? 'job has' : 'jobs have'} stopped for your approval.</strong> Each one is holding its next step until you decide.</p>
        </div>
        <div>
          {loop.waitingApprovals.map((run) => <button
            key={run.id}
            type="button"
            className="secondary-button run-open"
            onClick={() => onNavigate(`/ledger/run/${run.id}`)}
          >{run.playbookId} <ChevronRight size={15} /></button>)}
        </div>
      </div>}

      <RecommendationList
        items={recommendations}
        actions={actions}
        empty={<EmptyRecommendations isNew={isNew} />}
      />
    </section>
  </>;
}

export function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <article className="metric-card"><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div></article>;
}

/* --------------------------------------------------------------------------
 * First run.
 *
 * Completion is derived from things that really exist: a LinkedIn account, a
 * saved lead list, a saved workflow, a campaign, an active agent token, a live
 * data connection, and imported clients. No "completed onboarding" flag exists
 * to drift away from reality.
 *
 * The preference is different: it is okay to remember which OUTCOME a person
 * chose to work on first. A brand-new workspace used to show the outreach and
 * revenue checklists at the same time, which made signup feel like configuring
 * two products before either one could be useful. The selector below remembers
 * only that presentation choice; every check mark still comes from server data.
 * -------------------------------------------------------------------------- */

interface Step {
  done: boolean;
  title: string;
  detail: string;
  cta: string;
  href: string;
}

type FirstRunJourney = 'outreach' | 'money';

function OnboardingChecklist({ data, limits, onNavigate }: {
  data: DashboardPayload;
  limits: LinkedInLimitsReport | null;
  onNavigate: (path: string) => void;
}) {
  const [hasAgent, setHasAgent] = useState<boolean | null>(null);
  const [outreachSetup, setOutreachSetup] = useState<{ leadLists: number; workflows: number; campaigns: number } | null>(null);
  const hasLiveConnection = data.connections.some((connection) => !connection.isDemo && connection.status === 'connected');
  const hasClients = data.clients.length > 0;
  const seat = limits?.seat ?? null;
  const hasMoneySide = hasLiveConnection || hasClients;

  const [journey, setJourney] = useState<FirstRunJourney>(() => {
    const remembered = typeof window !== 'undefined' ? window.localStorage.getItem('trevra:first-run-journey') : null;
    if (remembered === 'outreach' || remembered === 'money') return remembered;
    return hasMoneySide && !seat?.configured ? 'money' : 'outreach';
  });

  const chooseJourney = (next: FirstRunJourney) => {
    setJourney(next);
    try { window.localStorage.setItem('trevra:first-run-journey', next); } catch { /* preference only */ }
  };

  useEffect(() => {
    void getAgentTokens()
      .then((tokens) => setHasAgent(tokens.some((token) => !token.revokedAt)))
      .catch(() => setHasAgent(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getLinkedInManagerLeadLists().catch(() => []),
      getLinkedInManagerWorkflows().catch(() => []),
      getLinkedInManagedCampaigns().catch(() => [])
    ]).then(([leadLists, workflows, campaigns]) => {
      if (!cancelled) setOutreachSetup({ leadLists: leadLists.length, workflows: workflows.length, campaigns: campaigns.length });
    });
    return () => { cancelled = true; };
  }, []);

  const outreach: Step[] = [
    {
      done: Boolean(seat?.configured),
      title: 'Add the LinkedIn account you will send from',
      detail: 'Name the account, set its timezone and safe daily limits, and connect it when you are ready.',
      cta: 'Add account',
      href: '/outreach'
    },
    {
      done: (outreachSetup?.leadLists ?? 0) > 0,
      title: 'Build one lead list',
      detail: 'Import people you already know, or turn a LinkedIn search into a list you can review before contacting.',
      cta: 'Build lead list',
      href: '/outreach/manager'
    },
    {
      done: (outreachSetup?.workflows ?? 0) > 0,
      title: 'Build one workflow',
      detail: 'Choose the order: view, invite, message, follow, wait, or a manual message that stops for you.',
      cta: 'Build workflow',
      href: '/outreach/manager'
    },
    {
      done: (outreachSetup?.campaigns ?? 0) > 0,
      title: 'Create your first campaign',
      detail: 'Pick the sending account, lead list and workflow. Nothing goes out until you explicitly start it.',
      cta: 'Create campaign',
      href: '/outreach/manager'
    }
  ];

  const moneySteps: Step[] = [
    {
      done: hasAgent === true,
      title: 'Connect Claude Code or Codex',
      detail: 'Paste one generated command in your terminal so your agent can reach this workspace and prepare work.',
      cta: 'Connect agent',
      href: '/setup/agent'
    },
    {
      done: hasLiveConnection,
      title: 'Connect the source that knows what happened',
      detail: 'Email, accounting, or another connected tool gives Trevra the evidence behind agreements, delivery and payment.',
      cta: 'Connect data',
      href: '/setup/data'
    },
    {
      done: hasClients,
      title: 'Bring in your clients and agreements',
      detail: 'Sync them, upload an agreement, or import marketplace history. Trevra builds the commercial record from that.',
      cta: 'Bring in clients',
      href: '/setup/data'
    }
  ];

  const steps = journey === 'outreach' ? outreach : moneySteps;
  const progressReady = journey === 'outreach' ? outreachSetup !== null : hasAgent !== null;
  const completed = steps.filter((step) => step.done).length;
  if (progressReady && completed === steps.length) return null;
  const nextTitle = steps.find((step) => !step.done)?.title ?? null;

  return (
    <section className="onboarding-card">
      <div className="onboarding-head">
        <div>
          <h2>Get your first outcome working</h2>
          <p>Pick one job first. Trevra keeps the other one available without making you configure both up front.</p>
        </div>
        {progressReady && <span className="status-pill">{completed} of {steps.length} done</span>}
      </div>

      <div className="onboarding-choice" role="group" aria-label="First outcome">
        <button type="button" className={journey === 'outreach' ? 'is-active' : undefined} aria-pressed={journey === 'outreach'} onClick={() => chooseJourney('outreach')}>
          <strong>Win new business</strong><span>Find people and run a LinkedIn campaign</span>
        </button>
        <button type="button" className={journey === 'money' ? 'is-active' : undefined} aria-pressed={journey === 'money'} onClick={() => chooseJourney('money')}>
          <strong>Get paid for work</strong><span>Connect business data and surface what needs action</span>
        </button>
      </div>

      {journey === 'outreach' && <p className="panel-note">
        Before anything goes out: <button className="li-link" type="button" onClick={() => onNavigate('/outreach')} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }}>see the limits Trevra will enforce</button>. Your own LinkedIn account is the thing at risk, so the app shows which numbers are published facts and which are practitioner guidance.
      </p>}

      {!progressReady
        ? <p className="onboarding-loading"><LoaderCircle className="spin" size={16} /> Checking what is already set up…</p>
        : <ol className="onboarding-steps">
          {steps.map((step) => {
            const next = !step.done && step.title === nextTitle;
            return <li key={step.title} className={`${step.done ? 'is-done' : ''}${next ? ' is-next' : ''}`.trim()}>
              {step.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
              <div>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
              {next && <button className="primary-button" onClick={() => onNavigate(step.href)}>
                {step.cta} <ChevronRight size={15} />
              </button>}
            </li>;
          })}
        </ol>}
    </section>
  );
}

/* --------------------------------------------------------------------------
 * `/loop/cost` -- what did this cost me, and what did it produce.
 *
 * Three rows, one period selector, and one rule that outranks the layout:
 * EVERY SPEND LINE CARRIES ITS OWN CONFIDENCE FLAG. `usage_reported = true`
 * means the provider measured that call; false or NULL means Trevra estimated
 * it from a list-price table. Those are two different claims, so the tag sits
 * on the line rather than once at the top -- the same `ConfidenceTag` the
 * outreach screens use, which is the best idea in this codebase and had no
 * business staying inside the LinkedIn area.
 *
 * The Produced row prints the server's own sentence verbatim. Nothing joins a
 * model call or an outreach action to an invoice, and three adjacent rows must
 * not be allowed to read as one of them causing another.
 * -------------------------------------------------------------------------- */

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
        if (!cancelled) { setCost(next); setProblem(''); }
      } catch (error) {
        if (!cancelled) setProblem(error instanceof Error ? error.message : 'Could not read this period. Nothing changed — try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days]);

  return <div className="page-stack">
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h2>What this cost, and what it produced</h2>
          <p>One period, three rows. The rows are adjacent; they are not a chain.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => onNavigate('/loop')}>Back to the loop</button>
      </div>
      <WindowPicker days={days} onDaysChange={setDays} loading={loading} standalone />
      {problem && <div className="error-banner">
        <strong>{problem}</strong> The period selector still works — pick another window, or try this one again.
      </div>}
    </section>

    {!cost && loading && <section className="page-panel">
      <div className="empty-state"><LoaderCircle className="spin" size={28} /><h4 aria-level={2}>Reading the period…</h4><p>One moment.</p></div>
    </section>}

    {cost && <>
      <section className="page-panel">
        <div className="section-heading">
          <div>
            <h2>Spent</h2>
            <p>{usd(cost.spent.costCents)} on {cost.spent.calls.toLocaleString('en-US')} model {cost.spent.calls === 1 ? 'call' : 'calls'} in this window. Every figure in this panel is USD, billed by your model provider; the revenue figures elsewhere are in your workspace currency.</p>
          </div>
          <span className="status-pill">{usd(cost.spent.budget.spentCents)} this month</span>
        </div>

        {/* The meter is month-to-date and the table is the window. Two spans,
            said out loud, because they are two different numbers and putting
            them side by side without saying so is how a founder concludes the
            product cannot add up. */}
        <p className="byok-meter-copy">
          The cap is a calendar month: {usd(cost.spent.budget.spentCents)} of {usd(cost.spent.budget.monthlyCapCents)} used since{' '}
          {new Date(cost.spent.budget.periodStart).toLocaleDateString()}. The table below is the {cost.windowDays}-day window you picked.
        </p>
        {cost.spent.budget.spentCents > 0 && <div className="byok-meter"><i style={{
          width: `${Math.min(100, Math.round((cost.spent.budget.spentCents / Math.max(cost.spent.budget.monthlyCapCents, 1)) * 100))}%`
        }} /></div>}

        <div className="cost-table">
          {cost.spent.byModel.map((line) => <div className="cost-row is-spend" key={`${line.model}:${line.confidence}`}>
            <span>{line.model}</span>
            <ConfidenceTag
              confidence={line.confidence}
              source={line.usageReported ? 'your provider reported this usage' : 'estimated from a list-price table'}
            />
            <span>{line.calls.toLocaleString('en-US')} {line.calls === 1 ? 'call' : 'calls'}</span>
            <strong>{usd(line.costCents)}</strong>
          </div>)}
          {cost.spent.byModel.length === 0 && <p className="empty-copy">No paid model call in this window.</p>}
        </div>
        <p className="cost-note">
          <strong>HARD FACT</strong> means your provider reported what that call actually used. <strong>REPORTED</strong> means
          nothing came back and Trevra priced it from a list-price table — deliberately high, so the cap holds. A model
          that reported some calls and not others appears twice, because averaging the two would erase the difference.
        </p>
        <div className="panel-footer">
          <span>The cap and the spending switch are settings, so they live in Setup.</span>
          <button className="secondary-button" type="button" onClick={() => onNavigate('/setup/spend')}>Change the cap <ChevronRight size={15} /></button>
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div><h2>Sent</h2><p>What actually left, in the same window. Scheduled and skipped actions are not in here.</p></div>
          <span className="status-pill">{cost.sent.actionsTotal.toLocaleString('en-US')} actions</span>
        </div>
        <div className="cost-table">
          {cost.sent.actions.map((action) => <div className="cost-row" key={action.kind}>
            <span>{action.kind.replaceAll('_', ' ')}</span>
            <strong>{action.count.toLocaleString('en-US')}</strong>
          </div>)}
          {cost.sent.actions.length === 0 && <p className="empty-copy">Nothing went out in this window.</p>}
        </div>
        <div className="run-facts">
          <div className="run-fact"><span>Agent runs</span><strong>{cost.sent.agentRuns.total.toLocaleString('en-US')}</strong></div>
          <div className="run-fact"><span>Completed</span><strong>{cost.sent.agentRuns.completed.toLocaleString('en-US')}</strong></div>
          <div className="run-fact"><span>Failed</span><strong>{cost.sent.agentRuns.failed.toLocaleString('en-US')}</strong></div>
          <div className="run-fact"><span>Stopped</span><strong>{cost.sent.agentRuns.stopped.toLocaleString('en-US')}</strong></div>
          <div className="run-fact"><span>Still running</span><strong>{cost.sent.agentRuns.running.toLocaleString('en-US')}</strong></div>
        </div>
      </section>

      <section className="page-panel">
        <div className="section-heading">
          <div><h2>Produced</h2><p>The same window, next to the two rows above.</p></div>
        </div>
        <div className="cost-table">
          <div className="cost-row"><span>Invites accepted</span><strong>{cost.produced.accepted.toLocaleString('en-US')}</strong></div>
          <div className="cost-row"><span>Replies</span><strong>{cost.produced.replied.toLocaleString('en-US')}</strong></div>
          <div className="cost-row"><span>Ready to invoice <small>(a balance, not this window)</small></span><strong>{money(cost.produced.readyToInvoice, cost.produced.currency)}</strong></div>
          <div className="cost-row"><span>Collected</span><strong>{money(cost.produced.revenueCollected, cost.produced.currency)}</strong></div>
        </div>
        {/* The server ships this sentence so nobody can shorten it here. */}
        <p className="cost-note"><CircleAlert size={16} /> {cost.produced.attribution}</p>
      </section>

      <section className="page-panel">
        <div className="section-heading"><div><h2>Where these came from</h2><p>Every number above is a read of something already recorded.</p></div></div>
        <div className="run-facts">
          <div className="run-fact"><span>Window</span><strong>{cost.windowDays} days, from {new Date(cost.since).toLocaleDateString()}</strong></div>
          <div className="run-fact"><span>Clients</span><strong>{money(cost.produced.readyToInvoice, cost.produced.currency)} billable</strong></div>
        </div>
        <div className="panel-footer">
          <span>The evidence behind each run is in the ledger.</span>
          <button className="secondary-button" type="button" onClick={() => onNavigate('/ledger')}>Open the run ledger <ChevronRight size={15} /></button>
        </div>
      </section>
    </>}
  </div>;
}
