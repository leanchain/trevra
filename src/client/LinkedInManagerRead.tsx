import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Copy,
  Inbox,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
  Zap
} from 'lucide-react';
import {
  completeLinkedInManualTask,
  getLinkedInLimits,
  getLinkedInManagedAnalytics,
  getLinkedInManagedCampaign,
  getLinkedInManagedCampaigns,
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  getLinkedInManualTasks,
  pauseLinkedInManagedCampaign,
  removeLinkedInManagedMember,
  setLinkedInManagedMemberPaused,
  startLinkedInManagedCampaign,
  stopLinkedInManagedCampaign,
  tickLinkedInManagedCampaigns,
  type LinkedInLimitsReport,
  type ManagedCampaignTickResult
} from './api';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { LinkedInWorkflow, WorkflowStep } from '../server/linkedin/workflows';
import type {
  ManagedAnalytics,
  ManagedCampaign,
  ManagedCampaignMember,
  ManualTaskView
} from '../server/linkedin/managed-campaigns';
import { errorMessage, useOutreachRefresh } from './LinkedInSafety';
import {
  ceilingSourceNote,
  enforcedCeilings,
  rampFractionForDay,
  rampFractions,
  stageCampaignPrefill,
  type EnforcedCeiling,
  type ManagedKind
} from './LinkedInManagerCampaignConfig';
import { NOT_ENOUGH_DATA, RATE_MIN_SAMPLE, ratePercent } from './analytics';
import { useActiveSeatKey } from './LinkedInActiveAccount';
import { ConfirmDrawer } from './ui/dialog';

/**
 * Campaigns: the screen an operator lives on.
 *
 * Everything here answers one of four questions -- is it running, how far has
 * it got, what is it about to do to this person, and did any of it work -- so
 * the campaign list is the page and configuration sits underneath it.
 *
 * NO INTERNAL VOCABULARY REACHES THIS SURFACE. No ledger, no execution
 * boundary, no claim, no planned row, no seat: a LinkedIn account is a
 * LinkedIn account, and a lead that another campaign already owns is simply
 * "already in another campaign". The words below are the only ones a Dripify
 * user has ever needed.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/**
 * EVERY version needs this many messages before a winner is worth naming.
 *
 * Per arm, not in total, and that is the whole point now a step may carry up
 * to four of them: a four-way test is not readable at 20 sends spread over it,
 * it is readable at 20 sends EACH. Until the thinnest arm clears the bar the
 * panel says how many more it needs and names nobody -- a leader chip off a
 * handful of sends is noise with a rosette on.
 */
const MIN_VARIANT_SENDS = 20;

type MemberStatus = ManagedCampaignMember['status'];

const SOURCE_LABELS: Record<LinkedInLeadList['sourceKind'], string> = {
  csv: 'CSV',
  linkedin_search: 'LinkedIn people search',
  sales_navigator: 'Sales Navigator',
  post_keyword: 'Post/comment keywords'
};

/** Bar and legend order: what is moving first, what has stopped last. */
const STATUS_ORDER: readonly MemberStatus[] = [
  'active',
  'waiting',
  'manual',
  'pending',
  'paused',
  'replied',
  'completed',
  'removed',
  'failed'
];
const STATUS_LABEL: Record<MemberStatus, string> = {
  pending: 'Not started',
  active: 'In progress',
  waiting: 'Waiting for next step',
  manual: 'Needs a message from you',
  paused: 'Paused',
  replied: 'Replied',
  completed: 'Finished',
  removed: 'Removed',
  failed: 'Failed'
};
const LIVE_STATUSES: readonly MemberStatus[] = ['pending', 'active', 'waiting', 'manual'];

const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View their profile',
  connection_request: 'Send a connection request',
  message: 'Send a message',
  manual_message: 'A message you write yourself',
  follow: 'Follow them',
  withdraw_pending: 'Withdraw the invite if still pending'
};

const CAMPAIGN_STATUS_LABEL: Record<ManagedCampaign['status'], string> = {
  draft: 'Not started',
  running: 'Running',
  paused: 'Paused',
  completed: 'Finished',
  stopped: 'Stopped'
};

/*
 * NO LOCAL `percent` HERE ANY MORE, and that is the point of importing one.
 *
 * The old helper took a pre-divided rate and printed it, so 1-of-2 and
 * 500-of-1000 both came out "50%" and 0-of-0 came out as an em dash on this
 * screen and as "0%" on another. `ratePercent` takes the two counts and says
 * "not enough data" whenever the denominator is too small to divide by, which
 * is the same sentence on every outreach screen.
 */
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function stepHours(step: WorkflowStep): number {
  return step.delayBefore.unit === 'days' ? step.delayBefore.amount * 24 : step.delayBefore.amount;
}

function dayLabel(hoursFromStart: number): string {
  return `Day ${Math.floor(hoursFromStart / 24) + 1}`;
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(Math.max(1, minutes), 'min', 'min');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.round(hours / 24), 'day');
}

/** When something scheduled happens. Anything already due says so plainly. */
function dueIn(iso: string | null, now: number): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  return at <= now ? 'due now' : `in ${span(at - now)}`;
}

function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  return at >= now ? 'just now' : `${span(now - at)} ago`;
}

function countByStatus(members: readonly ManagedCampaignMember[]): Record<MemberStatus, number> {
  const counts = {
    pending: 0,
    active: 0,
    waiting: 0,
    manual: 0,
    paused: 0,
    replied: 0,
    completed: 0,
    removed: 0,
    failed: 0
  } as Record<MemberStatus, number>;
  for (const member of members) counts[member.status] += 1;
  return counts;
}

/**
 * The first days of a campaign run at a fraction of what the account may send
 * -- the single most common reason an operator thinks day one is broken.
 *
 * THE RAMP IS NO LONGER RESTATED HERE. It used to be `day * 0.2`, a second
 * copy of the policy `campaignWarmupFraction` owns on the server, and a copy is
 * a thing that drifts. The fractions arrive with the limits report now, so how
 * many days the ramp runs for and how big each step is are whatever the gate is
 * actually pacing against. With no report there is no fraction, and the screen
 * says nothing rather than inventing one.
 */
function warmupOf(
  campaign: ManagedCampaign,
  now: number,
  report: LinkedInLimitsReport | null
): { day: number; days: number; fraction: number } | null {
  if (!campaign.startedAt) return null;
  const start = Date.parse(campaign.startedAt);
  if (Number.isNaN(start)) return null;
  const fractions = rampFractions(report);
  if (!fractions) return null;
  const day = start > now ? 1 : Math.floor((now - start) / DAY_MS) + 1;
  return { day, days: fractions.length, fraction: rampFractionForDay(report, day) ?? 1 };
}

/* ==========================================================================
 * Small presentational pieces.
 * ======================================================================= */

/** The status bar. An <svg> so the widths are attributes, not inline styles. */
function StatusBar({ counts, total }: { counts: Record<MemberStatus, number>; total: number }) {
  if (total === 0) return null;
  let cursor = 0;
  const segments = STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => {
    const width = (counts[status] / total) * 100;
    const x = cursor;
    cursor += width;
    return { status, x, width };
  });
  return (
    <svg
      className="mgr-bar"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {segments.map((segment) => (
        <rect
          key={segment.status}
          className={`mgr-seg-${segment.status}`}
          x={segment.x}
          y="0"
          width={segment.width}
          height="6"
        />
      ))}
    </svg>
  );
}

function StatusLegend({ counts, total }: { counts: Record<MemberStatus, number>; total: number }) {
  if (total === 0) return <p className="empty-copy">No lead is enrolled in this campaign.</p>;
  return (
    <ul className="mgr-legend">
      {STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => (
        <li key={status}>
          <i className={`mgr-dot-${status}`} aria-hidden="true" />
          <b>{counts[status]}</b> {STATUS_LABEL[status].toLowerCase()}
        </li>
      ))}
    </ul>
  );
}

function MemberState({ status }: { status: MemberStatus }) {
  return (
    <span className="mgr-state">
      <i className={`mgr-dot-${status}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The ramp's days, as pips. No dynamic width, so no inline style. */
function WarmupPips({ day, days }: { day: number; days: number }) {
  return (
    <span className="mgr-pips" aria-hidden="true">
      {Array.from({ length: days }, (_, index) => index + 1).map((pip) => (
        <i key={pip} className={pip <= day ? 'is-on' : ''} />
      ))}
    </span>
  );
}

/**
 * The four numbers a day of this campaign is really capped at, and their source.
 *
 * The screen used to print the operator's settings straight out of the seat and
 * call them the campaign's allowance. They are not: what goes out is the
 * STRICTER of the setting and Trevra's researched band, unless this account has
 * been explicitly set to use its own numbers instead -- and both ramps cut into
 * even that. Saying which of the two produced the number is the difference
 * between a limit an operator can act on and one they can only be surprised by.
 */
function Allowance({
  ceilings,
  of
}: {
  ceilings: Record<ManagedKind, EnforcedCeiling>;
  of: 'today' | 'full';
}) {
  return (
    <>
      : {plural(ceilings.invite[of], 'invite')}, {plural(ceilings.dm[of], 'message')},{' '}
      {plural(ceilings.profile_view[of], 'profile view')} and{' '}
      {plural(ceilings.follow[of], 'follow')}
    </>
  );
}

function stepCopy(
  step: WorkflowStep,
  variantId: string | null
): { body: string | null; variant: string | null; note: string | null } {
  if (step.action === 'message') {
    const variants = step.config.variants;
    const chosen = variantId
      ? (variants.find((variant) => variant.id === variantId) ?? null)
      : null;
    if (chosen)
      return {
        body: chosen.body,
        variant: chosen.id,
        note: variants.length > 1 ? `Version ${chosen.id} of ${variants.length} in test` : null
      };
    return {
      body: variants[0]?.body ?? null,
      variant: null,
      note:
        variants.length > 1
          ? `${variants.length} versions in test — one is picked for this lead when the step runs`
          : null
    };
  }
  if (step.action === 'connection_request') {
    return {
      body: step.config.message ?? null,
      variant: null,
      note: step.config.message ? null : 'Sent without a note.'
    };
  }
  if (step.action === 'manual_message') {
    return {
      body: step.config.suggestedTemplate ?? null,
      variant: null,
      note: 'You write and send this one yourself.'
    };
  }
  if (step.action === 'withdraw_pending') {
    return {
      body: null,
      variant: null,
      note: `Only if the invite is still pending after ${plural(step.config.afterDays, 'day')}.`
    };
  }
  // THE TWO PASSIVE ACTIONS CARRY NO COPY, WHICH IS NOT THE SAME AS HAVING
  // NOTHING TO SAY. Falling through to all-nulls left the timeline row for a
  // lead sitting on a profile view or a follow visibly blank, on the one screen
  // that answers "what is about to happen to this person" -- while the other
  // four kinds each explained themselves.
  if (step.action === 'profile_view') {
    return {
      body: null,
      variant: null,
      note: 'Nothing is sent. Their profile is opened, and the visit shows up on it.'
    };
  }
  if (step.action === 'follow') {
    return {
      body: null,
      variant: null,
      note: 'Nothing is sent. The account follows them, which LinkedIn may notify them about.'
    };
  }
  return { body: null, variant: null, note: null };
}

/** Where this one person is in the sequence, and what happens to them next. */
function MemberTimeline({
  steps,
  member,
  now
}: {
  steps: readonly WorkflowStep[];
  member: ManagedCampaignMember;
  now: number;
}) {
  if (steps.length === 0)
    return (
      <p className="empty-copy">
        This campaign&rsquo;s workflow has been deleted, so its steps can no longer be shown.
      </p>
    );
  let elapsed = 0;
  return (
    <ol className="mgr-timeline">
      {steps.map((step, index) => {
        elapsed += stepHours(step);
        const done = index < member.stepIndex;
        const current = index === member.stepIndex;
        const copy = stepCopy(step, member.assignedVariants[step.id] ?? null);
        const showBody = Boolean(copy.body) && (current || done || index === member.stepIndex + 1);
        return (
          <li
            key={step.id}
            className={`mgr-tl ${done ? 'mgr-tl-done' : current ? 'mgr-tl-current' : 'mgr-tl-next'}`}
          >
            <span className="mgr-tl-mark" aria-hidden="true" />
            <div>
              <p className="mgr-tl-head">
                <strong>{ACTION_LABEL[step.action]}</strong>
                <span>{dayLabel(elapsed)}</span>
                {copy.variant && <span className="li-chip">Version {copy.variant}</span>}
              </p>
              <p className="mgr-tl-when">
                {done && 'Done'}
                {current && member.status === 'manual' && 'Waiting for you to send it'}
                {current && member.status === 'paused' && 'Paused — resume this lead to continue'}
                {current &&
                  member.status === 'failed' &&
                  'This step failed and the lead stopped here'}
                {current &&
                  (member.status === 'pending' ||
                    member.status === 'active' ||
                    member.status === 'waiting') &&
                  `Next up — ${dueIn(member.nextEligibleAt, now)}`}
                {current &&
                  (member.status === 'replied' ||
                    member.status === 'completed' ||
                    member.status === 'removed') &&
                  `Stopped here (${STATUS_LABEL[member.status].toLowerCase()})`}
                {!done && !current && 'Later'}
              </p>
              {copy.note && <p className="mgr-tl-note">{copy.note}</p>}
              {showBody && <p className="li-template mgr-tl-body">{copy.body}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
 * The member list: search, filter, sort, timeline, per-lead controls.
 * ======================================================================= */

type MemberSort = 'next' | 'name' | 'status' | 'step';

function CampaignMembers({
  members,
  steps,
  now,
  busy,
  onPause,
  onResume,
  onRemove
}: {
  members: readonly ManagedCampaignMember[];
  steps: readonly WorkflowStep[];
  now: number;
  busy: string;
  onPause: (member: ManagedCampaignMember) => void;
  onResume: (member: ManagedCampaignMember) => void;
  onRemove: (member: ManagedCampaignMember) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | MemberStatus>('all');
  const [sort, setSort] = useState<MemberSort>('next');
  const [limit, setLimit] = useState(50);
  const [openId, setOpenId] = useState('');

  useEffect(() => {
    setLimit(50);
  }, [query, status, sort]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = members.filter((member) => {
      if (status !== 'all' && member.status !== status) return false;
      if (!needle) return true;
      return `${member.firstName} ${member.lastName} ${member.company}`
        .toLowerCase()
        .includes(needle);
    });
    const byName = (a: ManagedCampaignMember, b: ManagedCampaignMember) =>
      `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return byName(a, b);
      if (sort === 'step') return b.stepIndex - a.stepIndex || byName(a, b);
      if (sort === 'status')
        return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byName(a, b);
      const left = a.nextEligibleAt ? Date.parse(a.nextEligibleAt) : Number.POSITIVE_INFINITY;
      const right = b.nextEligibleAt ? Date.parse(b.nextEligibleAt) : Number.POSITIVE_INFINITY;
      return left - right || byName(a, b);
    });
  }, [members, query, status, sort]);

  const present = STATUS_ORDER.filter((value) => members.some((member) => member.status === value));

  return (
    <div className="mgr-members">
      <div className="li-filter-row">
        <label>
          Search leads
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or company"
            type="search"
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as 'all' | MemberStatus)}
          >
            <option value="all">All statuses</option>
            {present.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value as MemberSort)}>
            <option value="next">Next action first</option>
            <option value="name">Name A–Z</option>
            <option value="status">Status</option>
            <option value="step">Furthest through the sequence</option>
          </select>
        </label>
        <p className="li-hint">
          Showing {shown.length} of {plural(members.length, 'lead')}.
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="empty-copy">
          No lead matches that search. Clear the filters to see the whole list.
        </p>
      ) : (
        <div className="mgr-wide">
          <div className="li-table-scroll">
            <table className="li-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Next action</th>
                  <th>
                    <span className="mgr-sr">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((member) => {
                  const open = openId === member.id;
                  const rowBusy = busy.startsWith(`member:${member.id}`);
                  return [
                    <tr key={member.id} className={open ? 'mgr-row-open' : undefined}>
                      <td>
                        <button
                          className="mgr-linkish"
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenId(open ? '' : member.id)}
                        >
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {member.firstName} {member.lastName}
                        </button>
                      </td>
                      <td>{member.company || '—'}</td>
                      <td>
                        <MemberState status={member.status} />
                      </td>
                      <td className="li-num">
                        {steps.length > 0 ? (
                          <>
                            {Math.min(member.stepIndex + 1, steps.length)} of {steps.length}
                            {steps[member.stepIndex] && (
                              <span className="mgr-step-name">
                                {ACTION_LABEL[steps[member.stepIndex].action]}
                              </span>
                            )}
                          </>
                        ) : (
                          member.stepIndex + 1
                        )}
                      </td>
                      <td>
                        {LIVE_STATUSES.includes(member.status)
                          ? dueIn(member.nextEligibleAt, now)
                          : '—'}
                      </td>
                      <td>
                        <div className="li-row-actions">
                          {LIVE_STATUSES.includes(member.status) && (
                            <button
                              className="li-mini-button"
                              type="button"
                              disabled={busy !== ''}
                              onClick={() => onPause(member)}
                            >
                              {rowBusy ? (
                                <LoaderCircle className="spin" size={12} />
                              ) : (
                                <Pause size={12} />
                              )}{' '}
                              Pause
                            </button>
                          )}
                          {member.status === 'paused' && (
                            <button
                              className="li-mini-button"
                              type="button"
                              disabled={busy !== ''}
                              onClick={() => onResume(member)}
                            >
                              {rowBusy ? (
                                <LoaderCircle className="spin" size={12} />
                              ) : (
                                <Play size={12} />
                              )}{' '}
                              Resume
                            </button>
                          )}
                          {(LIVE_STATUSES.includes(member.status) ||
                            member.status === 'paused') && (
                            <button
                              className="li-mini-button li-mini-danger"
                              type="button"
                              disabled={busy !== ''}
                              onClick={() => onRemove(member)}
                            >
                              <Trash2 size={12} /> Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${member.id}:detail`} className="mgr-row-detail">
                        <td colSpan={6}>
                          <MemberTimeline steps={steps} member={member} now={now} />
                        </td>
                      </tr>
                    ) : null
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {shown.length > limit && (
        <div className="mgr-more">
          <button
            className="secondary-button"
            type="button"
            onClick={() => setLimit((current) => current + 100)}
          >
            Show 100 more
          </button>
          <span className="li-hint">{shown.length - limit} more lead(s) in this filter.</span>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
 * A/B results.
 * ======================================================================= */

function VariantResults({
  analytics,
  stepsById
}: {
  analytics: ManagedAnalytics;
  stepsById: ReadonlyMap<string, WorkflowStep | null>;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ManagedAnalytics['variants']>();
    for (const row of analytics.variants) {
      const bucket = map.get(row.workflowStepId) ?? [];
      bucket.push(row);
      map.set(row.workflowStepId, bucket);
    }
    return [...map.entries()];
  }, [analytics]);

  if (groups.length === 0)
    return (
      <p className="empty-copy">
        No message has gone out with a version attached yet. Once a campaign whose message step
        carries more than one version starts sending, the comparison appears here.
      </p>
    );

  return (
    <div className="mgr-ab">
      {groups.map(([stepId, rows]) => {
        // `has` and `get` answer two different questions here: an id absent from
        // the map belongs to no campaign in this filter, while an id present but
        // mapped to null is one two campaigns define differently -- ambiguous, and
        // said so rather than resolved to whichever happened to be first.
        const known = stepsById.has(stepId);
        const step = stepsById.get(stepId) ?? null;
        const withRate = rows.map((row) => ({
          ...row,
          rate: row.sent === 0 ? null : row.replied / row.sent
        }));
        const thin = withRate.filter((row) => row.sent < MIN_VARIANT_SENDS);
        const best = [...withRate].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))[0];
        const decided =
          thin.length === 0 &&
          withRate.length > 1 &&
          withRate.some((row) => (row.rate ?? 0) !== (best.rate ?? 0));
        const peak = Math.max(...withRate.map((row) => row.rate ?? 0), 0.0001);
        return (
          <div className="mgr-ab-group" key={stepId}>
            <h5 className="mgr-ab-head" aria-level={4} role="heading">
              {step ? ACTION_LABEL[step.action] : 'A message step'}
              <span>
                {step
                  ? `Step "${stepId}"`
                  : known
                    ? `Step "${stepId}" — more than one campaign here runs a different step under that name`
                    : `Step "${stepId}" — no campaign in this filter still runs it`}
              </span>
            </h5>
            <div className="mgr-variants">
              {withRate.map((row) => {
                const body =
                  step && step.action === 'message'
                    ? (step.config.variants.find((variant) => variant.id === row.variantId)?.body ??
                      null)
                    : null;
                const leading = decided && row.variantId === best.variantId;
                return (
                  <article
                    className={`mgr-variant${leading ? ' is-leading' : ''}`}
                    key={row.variantId}
                  >
                    <header>
                      <strong>Version {row.variantId}</strong>
                      {leading && <span className="li-chip mgr-chip-running">Leading</span>}
                    </header>
                    {body ? (
                      <p className="li-template">{body}</p>
                    ) : (
                      <p className="mgr-tl-note">
                        {known
                          ? 'Pick a single campaign above to see the wording this version was sent with.'
                          : 'The wording for this version is no longer in any campaign shown here.'}
                      </p>
                    )}
                    <p className="mgr-variant-nums">
                      <b>{ratePercent(row.replied, row.sent, MIN_VARIANT_SENDS)}</b> replied ·{' '}
                      {row.replied} of {plural(row.sent, 'message')}
                    </p>
                    <svg
                      className="mgr-rate"
                      viewBox="0 0 100 4"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <rect
                        className="mgr-rate-fill"
                        x="0"
                        y="0"
                        width={Math.max(1, ((row.rate ?? 0) / peak) * 100)}
                        height="4"
                      />
                    </svg>
                  </article>
                );
              })}
            </div>
            {/*
          THE GATE IS PER ARM AND IT DOES NOT SOFTEN AS ARMS ARE ADDED. A step
          may now run up to four versions, and the arithmetic of "one of these
          looks ahead" gets easier to satisfy by luck with every arm added --
          so a leader is named only once EVERY version has cleared
          MIN_VARIANT_SENDS, and until then the panel says which ones are short
          and by how much rather than pointing at whichever is briefly on top.
        */}
            {withRate.length < 2 ? (
              <p className="mgr-tl-note">
                Only one version has been used at this step, so there is nothing to compare it with.
              </p>
            ) : thin.length > 0 ? (
              <p className="mgr-tl-note">
                Not enough data yet.{' '}
                {thin
                  .map(
                    (row) => `version ${row.variantId} needs ${MIN_VARIANT_SENDS - row.sent} more`
                  )
                  .join(', ')}{' '}
                before a difference across {plural(withRate.length, 'version')} means anything.
              </p>
            ) : !decided ? (
              <p className="mgr-tl-note">
                {withRate.length === 2
                  ? 'Both versions are'
                  : `All ${withRate.length} versions are`}{' '}
                replying at the same rate so far.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
 * The screen.
 * ======================================================================= */

export function OutreachManagerRead({
  setToast,
  onNavigate
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
}) {
  /**
   * The account the operator picked, shared with every other LinkedIn screen.
   *
   * The results filter both STARTS from it and WRITES BACK to it, so choosing
   * an account to read results for is the same act as choosing the account the
   * inbox and the queue are showing. "All accounts" is deliberately not a
   * write: it is a question about every account rather than a different pick,
   * and silently repointing the inbox because somebody widened a chart would be
   * a surprise nobody asked for.
   */
  const [activeSeatKey, setActiveSeatKey] = useActiveSeatKey();
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [campaigns, setCampaigns] = useState<ManagedCampaign[]>([]);
  const [membersByCampaign, setMembersByCampaign] = useState<
    Record<string, ManagedCampaignMember[]>
  >({});
  /** One effective-limits report per account, keyed by account. */
  const [limitsBySeat, setLimitsBySeat] = useState<Record<string, LinkedInLimitsReport>>({});
  const [tasks, setTasks] = useState<ManualTaskView[]>([]);
  const [analytics, setAnalytics] = useState<ManagedAnalytics | null>(null);
  const [openCampaignId, setOpenCampaignId] = useState('');
  const [openTaskId, setOpenTaskId] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState<ManagedCampaignTickResult | null>(null);
  const [stopping, setStopping] = useState<ManagedCampaign | null>(null);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [seatFilter, setSeatFilter] = useState(activeSeatKey);
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // A remembered account that no longer exists would filter every number on
  // this screen to nothing and explain that nowhere, so an unknown key falls
  // back to all accounts rather than to an empty screen.
  useEffect(() => {
    if (seats.length === 0 || !seatFilter) return;
    if (!seats.some((seat) => seat.seatKey === seatFilter)) setSeatFilter('');
  }, [seats, seatFilter]);

  // The Results panel reads whichever campaign is EXPANDED, the same way
  // seatFilter above starts from the account picked elsewhere: opening a
  // different card is the operator choosing what those numbers are about, so
  // the filter follows it. An explicit pick from the Results dropdown itself
  // is not fought -- it only reverts when openCampaignId next changes, i.e.
  // when a card is opened or closed.
  useEffect(() => {
    setCampaignFilter(openCampaignId);
  }, [openCampaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSeats, nextLists, nextWorkflows, nextCampaigns, nextTasks] = await Promise.all([
        getLinkedInManagerSeats(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagerWorkflows(),
        getLinkedInManagedCampaigns(),
        getLinkedInManualTasks()
      ]);
      setSeats(nextSeats);
      setLists(nextLists);
      setWorkflows(nextWorkflows);
      setCampaigns(nextCampaigns);
      setTasks(nextTasks);
      // lc-debt: one read per campaign to get its per-status counts; upgrade path:
      // return the status histogram alongside member_count on GET /manager/campaigns.
      const details = await Promise.all(
        nextCampaigns.map(async (campaign) => {
          try {
            return [campaign.id, (await getLinkedInManagedCampaign(campaign.id)).members] as const;
          } catch {
            return [campaign.id, [] as ManagedCampaignMember[]] as const;
          }
        })
      );
      setMembersByCampaign(Object.fromEntries(details));
      // lc-debt: one limits read per account, so the ceilings this screen prints
      // are the gate's own numbers instead of a second opinion about them;
      // upgrade path: return the effective per-kind ceilings alongside the
      // account on GET /manager/seats.
      const reports = await Promise.all(
        nextSeats.map(async (seat) => {
          try {
            return [seat.seatKey, await getLinkedInLimits(seat.seatKey)] as const;
          } catch {
            return [seat.seatKey, null] as const;
          }
        })
      );
      setLimitsBySeat(
        Object.fromEntries(
          reports.filter(
            (entry): entry is readonly [string, LinkedInLimitsReport] => entry[1] !== null
          )
        )
      );
      setNow(Date.now());
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read your campaigns. Nothing was changed.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      setAnalytics(
        await getLinkedInManagedAnalytics({
          campaignId: campaignFilter || undefined,
          seatKey: seatFilter || undefined,
          sinceDays: windowDays ?? undefined
        })
      );
    } catch (err) {
      setError(errorMessage(err, 'Unable to read campaign results.'));
    } finally {
      setAnalyticsLoading(false);
    }
  }, [campaignFilter, seatFilter, windowDays]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadAnalytics()]);
  }, [load, loadAnalytics]);
  useOutreachRefresh(refreshAll);

  const seatLabel = useCallback(
    (seatKey: string) => seats.find((seat) => seat.seatKey === seatKey)?.label ?? seatKey,
    [seats]
  );
  const workflowOf = useCallback(
    (campaign: ManagedCampaign) =>
      workflows.find((workflow) => workflow.id === campaign.workflowId) ?? null,
    [workflows]
  );
  const listOf = useCallback(
    (campaign: ManagedCampaign) => lists.find((list) => list.id === campaign.leadListId) ?? null,
    [lists]
  );

  const refreshCampaign = async (campaignId: string) => {
    const detail = await getLinkedInManagedCampaign(campaignId);
    setMembersByCampaign((current) => ({ ...current, [campaignId]: detail.members }));
    setCampaigns((current) =>
      current.map((campaign) => (campaign.id === campaignId ? detail.campaign : campaign))
    );
  };

  const guard = async (key: string, work: () => Promise<void>, fallback: string) => {
    setBusy(key);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err, fallback));
    } finally {
      setBusy('');
    }
  };

  const startCampaign = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await startLinkedInManagedCampaign(campaign.id);
        setToast(
          `“${campaign.name}” is running. First actions are queued for the account's next working hours.`
        );
        await refreshAll();
      },
      'Unable to start that campaign.'
    );

  const pauseCampaign = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await pauseLinkedInManagedCampaign(campaign.id);
        setToast(`“${campaign.name}” is paused. Nothing new is queued until you resume it.`);
        await refreshAll();
      },
      'Unable to pause that campaign.'
    );

  const stopCampaign = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await stopLinkedInManagedCampaign(campaign.id);
        setToast(
          campaign.status === 'draft'
            ? `“${campaign.name}” was cancelled before it ever ran. Its leads are free for another campaign.`
            : `“${campaign.name}” is stopped. Queued work that had not started was cancelled.`
        );
        setStopping(null);
        if (openCampaignId === campaign.id) setOpenCampaignId('');
        await refreshAll();
      },
      'Unable to stop that campaign.'
    );

  const setMemberPaused = (member: ManagedCampaignMember, paused: boolean) =>
    guard(
      `member:${member.id}`,
      async () => {
        await setLinkedInManagedMemberPaused(member.id, paused);
        setToast(
          `${member.firstName} ${member.lastName} ${paused ? 'paused' : 'resumed'} in this campaign.`
        );
        await refreshCampaign(member.campaignId);
      },
      paused ? 'Unable to pause that lead.' : 'Unable to resume that lead.'
    );

  const removeMember = (member: ManagedCampaignMember) =>
    guard(
      `member:${member.id}`,
      async () => {
        await removeLinkedInManagedMember(member.id);
        setToast(
          `${member.firstName} ${member.lastName} removed. They can be added to another campaign now.`
        );
        await refreshCampaign(member.campaignId);
      },
      'Unable to remove that lead.'
    );

  const completeTask = (task: ManualTaskView) =>
    guard(
      `task:${task.id}`,
      async () => {
        await completeLinkedInManualTask(task.id);
        setToast(
          `Marked done for ${task.firstName} ${task.lastName}. The sequence continues from the next step.`
        );
        await refreshAll();
      },
      'Unable to mark that message done.'
    );

  const copyBody = async (task: ManualTaskView) => {
    try {
      await navigator.clipboard.writeText(task.suggestedBody ?? '');
      setToast('Suggested message copied.');
    } catch {
      setError('Your browser blocked the copy. Select the text and copy it by hand.');
    }
  };

  const runNow = () =>
    guard(
      'tick',
      async () => {
        const result = await tickLinkedInManagedCampaigns();
        setTick(result);
        await refreshAll();
      },
      'Unable to advance the running campaigns.'
    );

  const pickSeatFilter = (key: string) => {
    setSeatFilter(key);
    if (key) setActiveSeatKey(key);
  };

  /**
   * The one thing a campaign in a terminal state can still do.
   *
   * A stopped campaign cannot be started again and a finished one has nothing
   * left to send, so the useful action is not "restart" -- it is "run this list
   * through this workflow again", which is a NEW campaign with its own ramp,
   * built from the same two things. The form is FILLED IN, not submitted:
   * enrolling the leads and starting them stay the operator's decisions.
   */
  const rebuild = (campaign: ManagedCampaign) => {
    stageCampaignPrefill({
      name: `${campaign.name} (again)`,
      seatKey: campaign.seatKey,
      leadListId: campaign.leadListId,
      workflowId: campaign.workflowId
    });
    onNavigate('/outreach/new');
  };

  const pendingTasks = tasks.filter((task) => task.status === 'pending');
  const visiblePendingTasks = pendingTasks.filter(
    (task) =>
      (!campaignFilter || task.campaignId === campaignFilter) &&
      (!seatFilter || task.seatKey === seatFilter)
  );
  const runningCount = campaigns.filter((campaign) => campaign.status === 'running').length;
  const leadsInFlight = Object.values(membersByCampaign)
    .flat()
    .filter((member) => LIVE_STATUSES.includes(member.status)).length;
  /**
   * Which workflow step a variant result row belongs to.
   *
   * STEP IDS ARE UNIQUE WITHIN A WORKFLOW AND NOWHERE ELSE. Every workflow
   * names its first step `step-1`, so flat-mapping every workflow's steps into
   * one list and resolving with `find` returned whichever workflow happened to
   * come first -- and the A/B panel rendered ANOTHER campaign's message as this
   * variant's copy, underneath this variant's reply rate.
   *
   * A campaign carries the snapshot of the steps it is actually running, so
   * with one campaign selected the resolution is exact. Across all campaigns
   * nothing in a variant row says which campaign produced it, so an id that two
   * campaigns define DIFFERENTLY is genuinely ambiguous: it maps to null, and
   * the panel asks for a campaign instead of picking one on the operator's
   * behalf. Two campaigns running the identical step are not ambiguous at all --
   * either answer is the same wording -- so they keep it.
   */
  const variantStepsById = useMemo(() => {
    const scope = campaignFilter
      ? campaigns.filter((campaign) => campaign.id === campaignFilter)
      : campaigns;
    const byId = new Map<string, WorkflowStep | null>();
    const shapes = new Map<string, string>();
    for (const campaign of scope) {
      for (const step of campaign.steps) {
        const shape = JSON.stringify(step);
        const seen = shapes.get(step.id);
        if (seen === undefined) {
          shapes.set(step.id, shape);
          byId.set(step.id, step);
        } else if (seen !== shape) byId.set(step.id, null);
      }
    }
    return byId;
  }, [campaigns, campaignFilter]);

  return (
    <div className="page-stack">
      {error && <div className="error-banner">{error}</div>}

      <section className="page-panel" id="mgr-campaigns">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Campaigns</h3>
            <p>
              One LinkedIn account, one lead list, one workflow each. Work is queued for the
              account&rsquo;s own working hours and daily limits, so a campaign never moves faster
              than the account safely can.
            </p>
          </div>
          <div className="mgr-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => onNavigate('/outreach/new')}
            >
              <Plus size={14} /> New campaign
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== '' || runningCount === 0}
              onClick={() => void runNow()}
            >
              {busy === 'tick' ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />}{' '}
              Run now
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={loading}
              onClick={() => void refreshAll()}
            >
              {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
              Refresh
            </button>
          </div>
        </div>

        <p className="mgr-summary">
          <span>{plural(campaigns.length, 'campaign')}</span>
          <span>{runningCount} running</span>
          <span>{plural(leadsInFlight, 'lead')} in a sequence</span>
          <span>
            <a className="li-link" href="/outreach/inbox">
              {plural(pendingTasks.length, 'message')} waiting for you
            </a>
          </span>
        </p>
        {runningCount === 0 && campaigns.length > 0 && (
          <p className="li-hint">Run now becomes available once a campaign is running.</p>
        )}

        {tick && (
          <div className="li-dryrun">
            <Zap size={18} />
            <div>
              <strong>Run now finished</strong>
              <p>
                Advanced {plural(tick.campaignsTicked, 'campaign')}:{' '}
                {plural(tick.actionsPlanned, 'action')} queued,{' '}
                {plural(tick.manualTasksCreated, 'message')} for you to write,{' '}
                {plural(tick.membersCompleted, 'lead')} finished.
                {tick.membersBlocked > 0 &&
                  ` ${plural(tick.membersBlocked, 'lead')} could not move yet — no profile link, or today's limit for that account is already used.`}
              </p>
            </div>
          </div>
        )}

        {loading && campaigns.length === 0 ? (
          <div className="mgr-list" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div className="mgr-skel" key={row} />
            ))}
          </div>
        ) : campaigns.length === 0 ? (
          <div className="mgr-empty">
            <h4 aria-level={3}>No campaigns yet</h4>
            <p>
              The builder walks through the sending account, lead list and workflow in order.
              Nothing is sent while you build.
            </p>
            <div className="mgr-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => onNavigate('/outreach/new')}
              >
                <Plus size={14} /> Build your first campaign
              </button>
            </div>
          </div>
        ) : (
          <div className="mgr-list">
            {campaigns.map((campaign) => {
              const members = membersByCampaign[campaign.id] ?? [];
              const counts = countByStatus(members);
              const workflow = workflowOf(campaign);
              const report = limitsBySeat[campaign.seatKey] ?? null;
              const warmup = warmupOf(campaign, now, report);
              /**
               * THE STEPS THIS CAMPAIGN IS ACTUALLY RUNNING, not the workflow as
               * it stands today. A campaign carries its own snapshot precisely so
               * a lead who is on step 3 is shown step 3 as it was when they
               * reached it, including a step an edit has since deleted. The live
               * workflow is the fallback only for a campaign with no readable
               * snapshot, which is the case that predates the snapshot existing.
               */
              const campaignSteps =
                campaign.steps.length > 0 ? campaign.steps : (workflow?.steps ?? []);
              const ceilings = enforcedCeilings(
                report,
                warmup?.fraction ?? rampFractionForDay(report, 1) ?? 1
              );
              const fullCeilings = enforcedCeilings(report, 1);
              const terminal = campaign.status === 'stopped' || campaign.status === 'completed';
              /** "Build it again" needs both halves to still exist; it cannot conjure a deleted list. */
              const rebuildable = Boolean(listOf(campaign) && workflowOf(campaign));
              const open = openCampaignId === campaign.id;
              const busyHere = busy === `campaign:${campaign.id}`;
              return (
                <article className={`mgr-campaign${open ? ' is-open' : ''}`} key={campaign.id}>
                  <div className="mgr-campaign-head">
                    <button
                      className="mgr-toggle"
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenCampaignId(open ? '' : campaign.id)}
                    >
                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <strong>{campaign.name}</strong>
                      <span className={`li-chip mgr-chip-${campaign.status}`}>
                        {CAMPAIGN_STATUS_LABEL[campaign.status]}
                      </span>
                    </button>
                    <div className="mgr-actions">
                      {(campaign.status === 'draft' || campaign.status === 'paused') && (
                        <button
                          className="primary-button"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => void startCampaign(campaign)}
                        >
                          {busyHere ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <Play size={14} />
                          )}{' '}
                          {campaign.status === 'draft' ? 'Start' : 'Resume'}
                        </button>
                      )}
                      {campaign.status === 'running' && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => void pauseCampaign(campaign)}
                        >
                          {busyHere ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <Pause size={14} />
                          )}{' '}
                          Pause
                        </button>
                      )}
                      {/*
                      STOP IS OFFERED ON A DRAFT TOO, and it is the only way out
                      of a campaign created by mistake. There is no delete route
                      and this screen does not invent one: stopping a draft is a
                      real server operation that takes its leads back out of it,
                      which is the part an operator actually needs. The drawer
                      says exactly what it does and what it does not undo before
                      it happens.
                    */}
                      {(campaign.status === 'draft' ||
                        campaign.status === 'running' ||
                        campaign.status === 'paused') && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => setStopping(campaign)}
                        >
                          <Square size={14} /> {campaign.status === 'draft' ? 'Cancel' : 'Stop'}
                        </button>
                      )}
                      {terminal && rebuildable && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => rebuild(campaign)}
                        >
                          <Copy size={14} /> Build it again
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="mgr-meta">
                    <span>
                      Sends from <b>{seatLabel(campaign.seatKey)}</b>
                    </span>
                    <span>
                      {plural(campaign.memberCount, 'lead')} from{' '}
                      {listOf(campaign)?.name ?? 'a deleted list'}
                    </span>
                    <span>
                      {workflow
                        ? `${workflow.name} · ${plural(campaignSteps.length, 'step')}${
                            campaign.workflowVersion === null
                              ? ''
                              : campaign.workflowVersion === workflow.version
                                ? ` · v${campaign.workflowVersion}`
                                : ` · running v${campaign.workflowVersion}, the workflow is now v${workflow.version}`
                          }`
                        : campaignSteps.length > 0
                          ? `Its workflow was deleted · still running its own copy of ${plural(campaignSteps.length, 'step')}`
                          : 'Workflow deleted'}
                    </span>
                    {campaign.startedAt && <span>Started {ago(campaign.startedAt, now)}</span>}
                  </p>

                  <StatusBar counts={counts} total={members.length} />
                  <StatusLegend counts={counts} total={members.length} />

                  {/*
                  A TERMINAL CAMPAIGN GETS AN EXPLANATION, NOT A WARM-UP LINE.
                  Stopped and finished campaigns used to fall through to "Full
                  speed: up to N invites a day", which is a sentence about work
                  that will never happen again, on a campaign whose only real
                  question is what became of its leads and what to do next.
                */}
                  {terminal ? (
                    <p className="mgr-warmup">
                      {campaign.status === 'stopped' ? (
                        <>
                          Stopped. Every lead still in it was taken out where they stood and any
                          queued action that had not started was cancelled, so those leads are free
                          for another campaign. A stopped campaign cannot be started again
                          {rebuildable ? (
                            <>
                              {' '}
                              — build a new one from the same list and workflow to pick the work
                              back up.
                            </>
                          ) : (
                            ', and its lead list or workflow no longer exists to rebuild it from.'
                          )}
                        </>
                      ) : (
                        <>
                          Finished: every lead reached the end of the workflow, and nothing more
                          goes out from it
                          {rebuildable ? (
                            <>
                              {' '}
                              — build a new one from the same list and workflow to run them through
                              it again.
                            </>
                          ) : (
                            '.'
                          )}
                        </>
                      )}
                    </p>
                  ) : (
                    <>
                      {/* ONE LINE, ALWAYS. The four-number Allowance breakdown and its
                        band/operator citation are detail an operator asks for by
                        opening the card, exactly like the member list and timeline
                        just below -- not a paragraph every collapsed card pays for. */}
                      <p className="mgr-warmup">
                        {campaign.status === 'draft' ? (
                          <>
                            Not started.{' '}
                            {rampFractions(report) && fullCeilings ? (
                              <>
                                Day 1 is held to{' '}
                                {Math.round((rampFractionForDay(report, 1) ?? 1) * 100)}% of what{' '}
                                {seatLabel(campaign.seatKey)} may send.
                              </>
                            ) : (
                              <>Nothing goes out until you start it.</>
                            )}
                          </>
                        ) : warmup && warmup.fraction < 1 ? (
                          <>
                            <WarmupPips day={warmup.day} days={warmup.days} /> Warm-up day{' '}
                            {warmup.day} of {warmup.days} — this campaign may use{' '}
                            {Math.round(warmup.fraction * 100)}% of what{' '}
                            {seatLabel(campaign.seatKey)} is allowed today. That is why day one
                            looks slow.
                          </>
                        ) : warmup ? (
                          <>
                            <WarmupPips day={warmup.days} days={warmup.days} /> Full speed.
                          </>
                        ) : campaign.startedAt ? (
                          // Started, but this account's ceilings could not be
                          // read. Saying nothing beats printing a ramp day
                          // that was never confirmed by anything.
                          <>
                            Running. Today&rsquo;s allowance for {seatLabel(campaign.seatKey)} could
                            not be read just now.
                          </>
                        ) : (
                          <>Warm-up starts when the campaign starts.</>
                        )}
                      </p>

                      {open &&
                        campaign.status === 'draft' &&
                        rampFractions(report) &&
                        fullCeilings && (
                          <p className="mgr-warmup mgr-warmup-detail">
                            Reaching full speed on day {rampFractions(report)?.length}. At full
                            speed that is {plural(fullCeilings.invite.full, 'invite')} and{' '}
                            {plural(fullCeilings.dm.full, 'message')} a day.
                          </p>
                        )}
                      {open &&
                        campaign.status !== 'draft' &&
                        warmup &&
                        warmup.fraction < 1 &&
                        ceilings && (
                          <p className="mgr-warmup mgr-warmup-detail">
                            Allowed today
                            <Allowance ceilings={ceilings} of="today" />. The invite ceiling is{' '}
                            {ceilingSourceNote(ceilings.invite)}.
                          </p>
                        )}
                      {open &&
                        campaign.status !== 'draft' &&
                        warmup &&
                        warmup.fraction >= 1 &&
                        ceilings && (
                          <p className="mgr-warmup mgr-warmup-detail">
                            At full speed
                            <Allowance ceilings={ceilings} of="full" />. The invite ceiling is{' '}
                            {ceilingSourceNote(ceilings.invite)}.
                          </p>
                        )}
                    </>
                  )}

                  {open && (
                    <CampaignMembers
                      members={members}
                      steps={campaignSteps}
                      now={now}
                      busy={busy}
                      onPause={(member) => void setMemberPaused(member, true)}
                      onResume={(member) => void setMemberPaused(member, false)}
                      onRemove={(member) => void removeMember(member)}
                    />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {campaigns.length > 0 && (
        <>
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>
                  <BarChart3 size={18} className="li-heading-icon" /> Results
                </h3>
                <p>
                  Counted from what your LinkedIn accounts actually did, in the window you choose. A
                  percentage reads &ldquo;{NOT_ENOUGH_DATA}&rdquo; until there are at least{' '}
                  {RATE_MIN_SAMPLE} in its denominator — three of four is four invites, not 75%.
                </p>
              </div>
            </div>

            <div className="li-filter-row">
              <label>
                Campaign
                <select
                  value={campaignFilter}
                  onChange={(event) => setCampaignFilter(event.target.value)}
                >
                  <option value="">All campaigns</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                LinkedIn account
                <select value={seatFilter} onChange={(event) => pickSeatFilter(event.target.value)}>
                  <option value="">All accounts</option>
                  {seats.map((seat) => (
                    <option key={seat.seatKey} value={seat.seatKey}>
                      {seat.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mgr-window" role="group" aria-label="Time window">
                {(
                  [
                    ['7 days', 7],
                    ['30 days', 30],
                    ['90 days', 90],
                    ['All time', null]
                  ] as const
                ).map(([label, value]) => (
                  <button
                    key={label}
                    className={`li-range${windowDays === value ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={windowDays === value}
                    onClick={() => setWindowDays(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {analyticsLoading && (
                <span className="li-hint">
                  <LoaderCircle className="spin" size={12} /> Reading…
                </span>
              )}
            </div>

            {/* The one or two numbers an operator checks without clicking anything:
              volume and quality. Everything else this panel knows -- the other
              eight tiles and the full A/B breakdown -- is real detail, not a
              headline, and sits behind the toggle below the same way "Campaign
              inputs" further down does. */}
            <div className="li-stat-row mgr-stats">
              <div className="li-stat">
                <p>Invites sent</p>
                <strong>{analytics?.invitesSent ?? 0}</strong>
              </div>
              <div className="li-stat">
                <p>Reply rate</p>
                <strong>
                  {ratePercent(
                    analytics?.repliedMessagedLeads ?? 0,
                    analytics?.contactedLeads ?? 0
                  )}
                </strong>
                <span>
                  {analytics?.repliedMessagedLeads ?? 0} of {analytics?.contactedLeads ?? 0} leads
                  messaged replied
                </span>
              </div>
            </div>

            <details className="mgr-inputs mgr-simple-hide">
              <summary>
                More results
                <span>{plural(visiblePendingTasks.length, 'task')} waiting · message versions</span>
              </summary>
              <div className="mgr-inputs-body">
                <div className="li-stat-row mgr-stats">
                  {/* ACCEPTED OUT OF INVITES SENT -- the one acceptance denominator a
                user is shown, here and on the funnel. "Invites sent" now counts
                declined invites too: they were sent, and leaving them out inflated
                this percentage by exactly the refusals it was measuring. */}
                  <div className="li-stat">
                    <p>Invites accepted</p>
                    <strong>{analytics?.invitesAccepted ?? 0}</strong>
                    <span>
                      {ratePercent(analytics?.invitesAccepted ?? 0, analytics?.invitesSent ?? 0)} of
                      invites sent
                    </span>
                  </div>
                  <div className="li-stat">
                    <p>Messages sent</p>
                    <strong>{analytics?.messagesSent ?? 0}</strong>
                  </div>
                  <div className="li-stat mgr-stat-secondary">
                    <p>Leads messaged</p>
                    <strong>{analytics?.contactedLeads ?? 0}</strong>
                    <span>People who got at least one message</span>
                  </div>
                  {/* TWO TILES, BECAUSE THEY COUNT TWO POPULATIONS. "Replies" is anyone
                who replied to anything, an invite that came back with a note
                included. The rate divides messaged leads who replied by messaged
                leads -- the same population top and bottom, which is what stops it
                printing 133%, as it did when the numerator counted replies to any
                action kind and the denominator counted messaged leads only. */}
                  <div className="li-stat">
                    <p>Replies</p>
                    <strong>{analytics?.repliedLeads ?? 0}</strong>
                    <span>People who replied to anything</span>
                  </div>
                  <div className="li-stat mgr-stat-secondary">
                    <p>Profile views</p>
                    <strong>{analytics?.profileViews ?? 0}</strong>
                  </div>
                  {/*
              SIX OF THE WORKFLOW'S ACTIONS CAN RUN; ALL SIX ARE COUNTED HERE.
              Follows and withdrawals were missing, so a workflow built out of them
              reported nothing but zeros forever -- while the accounts table below
              advertised a daily follow limit as a live ceiling on work this panel
              insisted was never happening.
            */}
                  <div className="li-stat mgr-stat-secondary">
                    <p>Follows</p>
                    <strong>{analytics?.followsSent ?? 0}</strong>
                  </div>
                  <div className="li-stat mgr-stat-withdrawn">
                    <p>Invites withdrawn</p>
                    <strong>{analytics?.invitesWithdrawn ?? 0}</strong>
                    <span>Still-pending invites the workflow cleaned up</span>
                  </div>
                  <div className="li-stat mgr-stat-needs-you">
                    <p>Needs you</p>
                    <strong>{visiblePendingTasks.length}</strong>
                    {visiblePendingTasks.length > 0 ? (
                      <a className="li-link" href="/outreach/inbox">
                        Open Messages
                      </a>
                    ) : (
                      <span>No manual messages waiting</span>
                    )}
                  </div>
                </div>

                <h4 className="li-subhead" aria-level={3}>
                  Message versions, side by side
                </h4>
                {analytics ? (
                  <VariantResults analytics={analytics} stepsById={variantStepsById} />
                ) : (
                  <p className="empty-copy">Reading results…</p>
                )}
              </div>
            </details>
          </section>

          <section className="page-panel mgr-manual-tasks">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>
                  <ClipboardList size={18} className="li-heading-icon" /> Messages to send yourself
                </h3>
                <p>
                  Some steps are deliberately yours: write the message in the inbox, send it, then
                  mark it done and the sequence carries on from the next step. Ones already sent,
                  and ones cancelled because their campaign was stopped or the lead was taken out of
                  it, stay on the list so the record is complete.
                </p>
              </div>
              <a className="secondary-button" href="/outreach/inbox">
                <Inbox size={14} /> Open inbox
              </a>
            </div>
            {tasks.length === 0 ? (
              <p className="empty-copy">
                Nothing is waiting on you. Steps marked &ldquo;a message you write yourself&rdquo;
                in a workflow show up here when a lead reaches them.
              </p>
            ) : (
              <div className="mgr-wide">
                <div className="li-table-scroll">
                  <table className="li-table">
                    <thead>
                      <tr>
                        <th>Lead</th>
                        <th>Company</th>
                        <th>Campaign</th>
                        <th>Account</th>
                        <th>Waiting</th>
                        <th>
                          <span className="mgr-sr">Controls</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...tasks]
                        .sort(
                          (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')
                        )
                        .map((task) => {
                          const open = openTaskId === task.id;
                          return [
                            <tr key={task.id} className={open ? 'mgr-row-open' : undefined}>
                              <td>
                                <button
                                  className="mgr-linkish"
                                  type="button"
                                  aria-expanded={open}
                                  onClick={() => setOpenTaskId(open ? '' : task.id)}
                                >
                                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                  {task.firstName} {task.lastName}
                                </button>
                              </td>
                              <td>{task.company || '—'}</td>
                              <td>
                                {campaigns.find((campaign) => campaign.id === task.campaignId)
                                  ?.name ?? 'Deleted campaign'}
                              </td>
                              <td>{seatLabel(task.seatKey)}</td>
                              {/*
                    A CANCELLED TASK IS NOT A DONE TASK. Stopping a campaign, or
                    removing a lead from one, cancels its outstanding manual
                    messages -- and everything that was not `pending` used to
                    render as "Done", with the completed dot, telling the
                    operator they had sent a message that was called off.
                  */}
                              <td>
                                {task.status === 'pending' ? (
                                  <>Waiting for you · {ago(task.createdAt, now)}</>
                                ) : task.status === 'cancelled' ? (
                                  <span className="mgr-state">
                                    <i className="mgr-dot-removed" aria-hidden="true" />
                                    Cancelled
                                  </span>
                                ) : (
                                  <span className="mgr-state">
                                    <i className="mgr-dot-completed" aria-hidden="true" />
                                    Done
                                  </span>
                                )}
                              </td>
                              <td>
                                {task.status === 'pending' && (
                                  <div className="li-row-actions">
                                    <button
                                      className="li-mini-button"
                                      type="button"
                                      disabled={busy !== ''}
                                      onClick={() => void completeTask(task)}
                                    >
                                      {busy === `task:${task.id}` ? (
                                        <LoaderCircle className="spin" size={12} />
                                      ) : (
                                        <Check size={12} />
                                      )}{' '}
                                      Mark done
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>,
                            open ? (
                              <tr key={`${task.id}:detail`} className="mgr-row-detail">
                                <td colSpan={6}>
                                  {task.status === 'cancelled' && (
                                    <p className="mgr-tl-note">
                                      Cancelled: its campaign was stopped, or this lead was taken
                                      out of it. Nothing needs sending, and the sequence will not
                                      carry on from here.
                                    </p>
                                  )}
                                  {task.suggestedBody ? (
                                    <p className="li-template">{task.suggestedBody}</p>
                                  ) : (
                                    <p className="mgr-tl-note">
                                      This step has no suggested wording. Write it yourself.
                                    </p>
                                  )}
                                  {task.status !== 'cancelled' && (
                                    <div className="mgr-actions">
                                      {task.suggestedBody && (
                                        <button
                                          className="secondary-button"
                                          type="button"
                                          onClick={() => void copyBody(task)}
                                        >
                                          <Copy size={14} /> Copy message
                                        </button>
                                      )}
                                      <a className="secondary-button" href="/outreach/inbox">
                                        <Inbox size={14} /> Send it in the inbox
                                      </a>
                                      {task.profileUrl && (
                                        <a
                                          className="li-link"
                                          href={task.profileUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          Open their LinkedIn profile
                                        </a>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ) : null
                          ];
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <details className="mgr-inputs mgr-simple-hide">
        <summary>
          Campaign inputs{' '}
          <span>
            {seats.length} accounts · {lists.length} lead lists · {workflows.length} workflows
          </span>
        </summary>
        <div className="mgr-inputs-body">
          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>LinkedIn accounts</h3>
                <p>
                  Each sending account has its own timezone, working hours and daily limits. Manage
                  them on Outreach &rarr; Settings. If an account is not connected, its campaigns
                  wait instead of sending from another account.
                </p>
              </div>
            </div>
            {seats.length === 0 ? (
              <div className="mgr-empty">
                <h4 aria-level={3}>No LinkedIn account yet</h4>
                <p>
                  Campaigns send from a real LinkedIn account. Add one, sign it in, and set the
                  hours it is allowed to work.
                </p>
                <div className="mgr-actions">
                  <a className="primary-button" href="/outreach/settings">
                    Add a LinkedIn account
                  </a>
                </div>
              </div>
            ) : (
              <div className="mgr-wide">
                <div className="li-table-scroll">
                  <table className="li-table">
                    {/*
            THREE COLUMNS OF NUMBERS, BECAUSE THERE ARE THREE NUMBERS AND ONLY
            ONE OF THEM IS THE CEILING. This table used to print the operator's
            settings alone and label them the account's daily limits. That is not
            what happens: what goes out is the STRICTER of the setting and
            Trevra's researched band, unless this account has been explicitly set
            to use its own numbers in place of the band. An operator reading "30
            invites" here while the gate allowed 18 had nowhere to find out why,
            and no reason to suspect there was a why.
          */}
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Timezone</th>
                        <th>Working days</th>
                        <th>Hours</th>
                        <th>Your setting</th>
                        <th>Trevra&rsquo;s band</th>
                        <th>What actually goes out</th>
                      </tr>
                    </thead>
                    <tbody>
                      {seats.map((seat) => {
                        const ceilings = enforcedCeilings(limitsBySeat[seat.seatKey] ?? null, 1);
                        return (
                          <tr key={seat.seatKey}>
                            <td>
                              <strong>{seat.label}</strong>
                              {seat.seatKey === activeSeatKey && (
                                <>
                                  {' '}
                                  <span className="li-chip">Active</span>
                                </>
                              )}
                            </td>
                            <td>{seat.timezone}</td>
                            <td>
                              {seat.workingDays.length === 0 ? (
                                <span className="mgr-state">
                                  <i className="mgr-dot-failed" aria-hidden="true" />
                                  None — this account cannot work
                                </span>
                              ) : (
                                seat.workingDays.map((day) => WEEKDAYS[day]).join(', ')
                              )}
                            </td>
                            <td>
                              {clock(seat.workStartMinute)}–{clock(seat.workEndMinute)}
                            </td>
                            <td>
                              {seat.dailyInviteLimit} · {seat.dailyMessageLimit} ·{' '}
                              {seat.dailyProfileViewLimit} · {seat.dailyFollowLimit}
                            </td>
                            <td>
                              {ceilings
                                ? `${ceilings.invite.band} · ${ceilings.dm.band} · ${ceilings.profile_view.band} · ${ceilings.follow.band}`
                                : '—'}
                            </td>
                            <td>
                              {ceilings ? (
                                <>
                                  {ceilings.invite.full} · {ceilings.dm.full} ·{' '}
                                  {ceilings.profile_view.full} · {ceilings.follow.full}
                                  {ceilings.invite.source === 'operator-override' && (
                                    <>
                                      {' '}
                                      <span className="li-chip">Your numbers</span>
                                    </>
                                  )}
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {seats.length > 0 && (
              <p className="li-hint">
                The three number columns each read invites · messages · profile views · follows.
                What goes out is the stricter of your setting and Trevra&rsquo;s researched band,
                and a campaign in its first days is a fraction of even that.
              </p>
            )}
          </section>

          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>
                  <Users size={18} className="li-heading-icon" /> Lead lists
                </h3>
                <p>
                  Names, companies and contact details, kept with a note of where each list came
                  from.
                </p>
              </div>
            </div>
            {lists.length === 0 ? (
              <p className="empty-copy">
                No lead list yet. Import a CSV above and it becomes available to every campaign.
              </p>
            ) : (
              <div className="mgr-wide">
                <div className="li-table-scroll">
                  <table className="li-table">
                    <thead>
                      <tr>
                        <th>List</th>
                        <th>Source</th>
                        <th>Leads</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lists.map((list) => (
                        <tr key={list.id}>
                          <td>
                            <strong>{list.name}</strong>
                          </td>
                          <td>{SOURCE_LABELS[list.sourceKind]}</td>
                          <td className="li-num">{list.leadCount}</td>
                          <td>{new Date(list.updatedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>

          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>
                  <WorkflowIcon size={18} className="li-heading-icon" /> Saved workflows
                </h3>
                <p>
                  A workflow is the order of steps and the wait between them. A campaign runs the
                  copy of the workflow it was started with, so editing one here shapes the campaigns
                  you start from now on and leaves the ones already going on their own copy — nobody
                  mid-sequence is moved to a different step. To put an edit in front of a campaign
                  that is already running, pause it and start it again.
                </p>
              </div>
            </div>
            {workflows.length === 0 ? (
              <p className="empty-copy">
                No workflow yet. Build one above — a view, an invite and two follow-up messages is
                the usual shape.
              </p>
            ) : (
              <div className="mgr-wide">
                <div className="li-table-scroll">
                  <table className="li-table">
                    <thead>
                      <tr>
                        <th>Workflow</th>
                        <th>Steps</th>
                        <th>Takes</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workflows.map((workflow) => {
                        const hours = workflow.steps.reduce(
                          (total, step) => total + stepHours(step),
                          0
                        );
                        return (
                          <tr key={workflow.id}>
                            <td>
                              <strong>{workflow.name}</strong>
                            </td>
                            <td className="li-num">{workflow.steps.length}</td>
                            <td>
                              {hours < 24
                                ? 'Same day'
                                : `about ${plural(Math.ceil(hours / 24), 'day')}`}
                            </td>
                            <td>{new Date(workflow.updatedAt).toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      </details>

      {stopping && (
        <ConfirmDrawer
          title={
            stopping.status === 'draft' ? `Cancel “${stopping.name}”?` : `Stop “${stopping.name}”?`
          }
          body={
            stopping.status === 'draft' ? (
              <>
                <p>
                  This campaign has never run, so nothing has gone out and nothing is queued.
                  Cancelling takes its leads back out of it, which frees them for another campaign.
                </p>
                <p>
                  There is no way to delete a campaign, so it stays in the list as stopped, and a
                  stopped campaign cannot be started. Build a new one when you want this list to
                  run.
                </p>
              </>
            ) : (
              <>
                <p>
                  Every lead still in this campaign stops where they are, and any queued action that
                  has not started is cancelled.
                </p>
                <p>
                  A stopped campaign cannot be started again — you would create a new one. To pick
                  it up later, pause it instead.
                </p>
              </>
            )
          }
          confirmLabel={stopping.status === 'draft' ? 'Cancel this campaign' : 'Stop this campaign'}
          tone="danger"
          busy={busy === `campaign:${stopping.id}`}
          onConfirm={() => void stopCampaign(stopping)}
          onCancel={() => setStopping(null)}
        />
      )}
    </div>
  );
}
