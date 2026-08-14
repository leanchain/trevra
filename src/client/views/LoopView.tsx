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
      href: limits ? (seat?.configured ? '/outreach/queue' : '/setup/seat') : null,
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
        href: '/setup/seat'
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
 * Every step is DERIVED from real data rather than stored, so it cannot lie: a
 * step is done when the thing actually happened, and the whole card disappears
 * on its own once the workspace is running. There is no `onboarding_completed`
 * flag to get out of sync with reality, and this change does not introduce
 * one.
 *
 * WHICH PATH SHOWS is derived by the same rule. A seat exists -> the outreach
 * path. A connection or a client exists -> the money path. Neither -> both,
 * outreach first, because the outreach engine is the product and somebody who
 * signed up to send LinkedIn messages should not be handed a checklist about
 * accounting software.
 * -------------------------------------------------------------------------- */

interface Step {
  done: boolean;
  title: string;
  detail: string;
  cta: string | null;
  href: string | null;
  /**
   * Nothing this component already reads can say whether this step happened.
   *
   * It is shown as an instruction and left out of the count rather than given
   * a tick derived from something adjacent. A checklist that guesses is worse
   * than one that admits it does not know: the operator trusts the ticks, and
   * one wrong tick is one step they never come back to.
   */
  untracked?: true;
}

function OnboardingChecklist({ data, limits, onNavigate }: {
  data: DashboardPayload;
  limits: LinkedInLimitsReport | null;
  onNavigate: (path: string) => void;
}) {
  const [hasAgent, setHasAgent] = useState(true);
  const [hasCampaign, setHasCampaign] = useState<boolean | null>(null);
  const hasLiveConnection = data.connections.some((connection) => !connection.isDemo && connection.status === 'connected');
  const hasClients = data.clients.length > 0;
  const hasWork = data.recommendations.length > 0;
  const seat = limits?.seat ?? null;

  // Optimistic default above, so the step never flashes “not done” while the
  // token list is still loading.
  useEffect(() => {
    void getAgentTokens()
      .then((tokens) => setHasAgent(tokens.some((token) => !token.revokedAt)))
      .catch(() => setHasAgent(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [planned, sent] = await Promise.all([
        getLinkedInActions({ status: 'planned', limit: 1 }).catch(() => []),
        getLinkedInActions({ status: 'sent', limit: 1 }).catch(() => [])
      ]);
      if (cancelled) return;
      setHasCampaign(planned.length + sent.length > 0);
    })();
    return () => { cancelled = true; };
  }, []);

  // The order the product actually works in: one account, the hours it may
  // work, a list of people, the steps to run against them, and then a campaign
  // that puts the two together and starts. Only the first and the fifth leave a
  // trace this screen can read; the rest say so.
  const outreach: Step[] = [
    {
      done: Boolean(seat?.configured),
      title: 'Connect your LinkedIn account',
      detail: 'The account everything goes out from. Add it, then sign in once through the browser on your machine.',
      cta: 'Connect it',
      href: '/setup/seat'
    },
    {
      untracked: true,
      done: false,
      title: 'Set your working hours and daily limits',
      detail: 'The days and hours anything may go out, and how many invites, messages, profile views and follows a day.',
      cta: 'Set them',
      href: '/setup/seat'
    },
    {
      untracked: true,
      done: false,
      title: 'Build a lead list',
      detail: 'Upload a CSV of profiles, or save the results of a LinkedIn search as a list.',
      cta: 'Build one',
      href: '/outreach/manager'
    },
    {
      untracked: true,
      done: false,
      title: 'Build a workflow',
      detail: 'The steps each person goes through — view, invite, message — and how long to wait between them.',
      cta: 'Build one',
      href: '/outreach/manager'
    },
    {
      done: hasCampaign === true,
      title: 'Create a campaign and start it',
      detail: 'A lead list plus a workflow. Press Start and Trevra works through it inside your hours and limits.',
      cta: 'Create one',
      href: '/outreach/manager'
    },
    {
      untracked: true,
      done: false,
      title: 'Answer the replies',
      detail: 'Anyone who answers stops receiving the rest of the workflow, and waits for you in the inbox.',
      cta: 'Open the inbox',
      href: '/outreach/inbox'
    }
  ];

  // Order matters and is fixed: the agent comes first because nothing else
  // works until one can reach the workspace. See docs/app-spec.md §8.
  const moneySteps: Step[] = [
    {
      done: hasAgent,
      title: 'Connect Claude Code or Codex',
      detail: 'Your agent does the work. Paste one line in your terminal and it can reach this workspace.',
      cta: 'Connect',
      href: '/setup/agent'
    },
    {
      done: hasLiveConnection,
      title: 'Connect your email or accounting',
      detail: 'This is how your agent sees what you agreed, delivered, and billed.',
      cta: 'Connect',
      href: '/setup/data'
    },
    {
      done: hasClients,
      title: 'Bring in your clients',
      detail: 'Sync them from a connected tool, upload an agreement, or import a CSV.',
      cta: 'Import',
      href: '/setup/data'
    },
    {
      done: hasWork,
      title: 'Review what your agent found',
      detail: hasClients
        ? 'Money at risk, work ready to invoice, and payments that are overdue.'
        : 'Once your work is in, this fills in on its own.',
      cta: hasWork ? 'Review' : null,
      href: '/money'
    }
  ];

  const hasSeat = Boolean(seat?.configured);
  const hasMoneySide = hasLiveConnection || hasClients;
  const showOutreach = hasSeat || !hasMoneySide;
  const showMoney = hasMoneySide || !hasSeat;

  const shown: Array<{ heading: string; blurb: string; steps: Step[] }> = [];
  if (showOutreach) {
    shown.push({
      heading: 'Start reaching people',
      blurb: 'An account, a list, a workflow — and a campaign that works through them for you.',
      steps: outreach
    });
  }
  if (showMoney) {
    shown.push({
      heading: 'Get paid for it',
      blurb: 'The other end of the same loop: what you agreed, delivered, billed and collected.',
      steps: moneySteps
    });
  }

  const all = shown.flatMap((group) => group.steps);
  // Only the steps something here can actually verify are counted. The rest are
  // instructions, and counting them would either stall the card forever or make
  // it claim knowledge it does not have.
  const tracked = all.filter((step) => !step.untracked);
  const completed = tracked.filter((step) => step.done).length;
  if (tracked.length === 0 || completed === tracked.length) return null;

  return (
    <section className="onboarding-card">
      <div className="onboarding-head">
        <div>
          <h2>Let’s get you set up</h2>
          <p>A few short steps and the loop starts turning on its own.</p>
        </div>
        <span className="status-pill">{completed} of {tracked.length} done</span>
      </div>

      {/* Not a step, because there is nothing to derive it from and a stored
          “acknowledged” flag is exactly the thing this card refuses to keep.
          It is a standing line instead, and it is first. */}
      {showOutreach && <p className="panel-note">
        Before anything goes out: <button className="li-link" type="button" onClick={() => onNavigate('/outreach')} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }}>read what you are risking</button>. It is your own LinkedIn account on the line, and that screen says which of its numbers LinkedIn publishes and which ones people have only measured in practice.
      </p>}

      {shown.map((group) => <div key={group.heading}>
        {shown.length > 1 && <div className="section-heading"><div><h3>{group.heading}</h3><p>{group.blurb}</p></div></div>}
        <ol className="onboarding-steps">
          {group.steps.map((step) => (
            <li key={step.title} className={step.done ? 'is-done' : undefined}>
              {step.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
              <div>
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
              {!step.done && step.cta && step.href && (
                <button className="secondary-button" onClick={() => onNavigate(step.href as string)}>
                  {step.cta} <ChevronRight size={15} />
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>)}
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
