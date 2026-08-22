import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Copy,
  Download,
  Inbox,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Users,
  Workflow as WorkflowIcon
} from 'lucide-react';
import {
  applyLatestLinkedInManagedCampaignWorkflow,
  completeLinkedInManualTask,
  deleteLinkedInManagedCampaign,
  duplicateLinkedInManagedCampaign,
  downloadLinkedInManagedCampaignExport,
  endLinkedInManagedMember,
  getLinkedInCampaignOperationalAnalytics,
  getLinkedInCampaignOperations,
  getLinkedInLimits,
  getLinkedInManagedAnalytics,
  getLinkedInManagedCampaign,
  getLinkedInManagedCampaigns,
  getLinkedInManagedMemberTimeline,
  getLinkedInWorkerStatus,
  getLinkedInCompanionStatus,
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  getLinkedInManualTasks,
  moveLinkedInManagedCampaignMembers,
  pauseLinkedInManagedCampaign,
  removeLinkedInManagedMember,
  resolveLinkedInManagedUnknownOutcome,
  rerunLinkedInManagedMemberCondition,
  resumeLinkedInManagedMemberAtStep,
  retryLinkedInManagedCampaignFailures,
  setLinkedInManagedCampaignOwner,
  setLinkedInManagedMemberPaused,
  skipLinkedInManagedMemberStep,
  startLinkedInManagedCampaign,
  stopLinkedInManagedCampaign,
  updateLinkedInCampaignControls,
  type LinkedInLimitsReport,
  type LinkedInWorkerStatus,
  type LinkedInCompanionStatus
} from './api';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { LinkedInWorkflow, WorkflowStep } from '../server/linkedin/workflows';
import type {
  CampaignMemberTimeline,
  CampaignOperationalAnalytics,
  CampaignQueueSummary,
  ManagedAnalytics,
  ManagedCampaign,
  ManagedCampaignMember,
  ManagedCampaignWave,
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
import { useIsWorkspaceOwner } from './auth-client';
import { useWorkspaceMembers } from './TeamScreen';
import { ConfirmDrawer } from './ui/dialog';
import { ChoiceMenu } from './ui/choice-menu';
import { ActionMenu } from './ui/action-menu';
import { Select } from './ui/primitives';
import { Hint } from './ui/hint';

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
  post_keyword: 'Post/comment keywords',
  recruiter: 'LinkedIn Recruiter',
  group_members: 'LinkedIn group',
  event_attendees: 'LinkedIn event',
  company_employees: 'LinkedIn company people',
  profile_urls: 'LinkedIn profile URLs',
  signal: 'External signal'
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
  'excluded',
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
  excluded: 'Excluded',
  failed: 'Failed'
};
const LIVE_STATUSES: readonly MemberStatus[] = ['pending', 'active', 'waiting', 'manual'];

const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View their profile',
  connection_request: 'Send a connection request',
  message: 'Send a message',
  manual_message: 'A message you write yourself',
  follow: 'Follow them',
  unfollow: 'Unfollow them',
  disconnect: 'Remove the connection',
  follow_company: 'Follow company',
  like_company_post: 'Like company post',
  invite_to_follow_company: 'Invite to follow company',
  invite_to_event: 'Invite to event',
  invite_to_group: 'Invite to group',
  group_message: 'Group message',
  event_message: 'Event message',
  withdraw_pending: 'Withdraw the invite if still pending',
  like_post: 'Like a recent post',
  endorse_skills: 'Endorse skills',
  wait: 'Wait',
  condition: 'Condition',
  monitor: 'Monitor',
  end: 'End',
  inmail: 'InMail',
  email: 'Email',
  find_email: 'Find email',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  manual_comment: 'Manual comment'
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
  return at <= now ? 'now' : `in ${span(at - now)}`;
}

function currentMemberStepIndex(
  member: ManagedCampaignMember,
  steps: readonly WorkflowStep[]
): number {
  if (member.currentStepId) {
    const byId = steps.findIndex((step) => step.id === member.currentStepId);
    if (byId >= 0) return byId;
  }
  return Math.max(0, Math.min(member.stepIndex, Math.max(0, steps.length - 1)));
}

function executionStateForMember(
  member: ManagedCampaignMember,
  steps: readonly WorkflowStep[],
  now: number
): { label: string; detail: string } {
  if (member.status === 'pending')
    return {
      label: 'Pending admission',
      detail:
        'This lead has not entered a wave yet. Capacity and exclusions are checked before admission.'
    };
  if (member.status === 'manual')
    return {
      label: 'Needs you',
      detail: 'This workflow step is manual and will not be executed by the LinkedIn worker.'
    };
  if (member.status === 'paused')
    return { label: 'Paused', detail: 'This lead is explicitly paused.' };
  if (member.status === 'failed')
    return {
      label: 'Failed',
      detail: member.lastFailureReason ?? 'This lead stopped after an execution failure.'
    };
  if (member.status === 'excluded')
    return {
      label: 'Excluded',
      detail: member.exclusionReason ?? 'This lead is excluded by campaign policy.'
    };
  if (member.status === 'replied')
    return { label: 'Stopped — replied', detail: 'Automation stopped because the lead replied.' };
  if (member.status === 'completed')
    return { label: 'Completed', detail: 'The workflow finished for this lead.' };
  if (member.status === 'removed')
    return { label: 'Removed', detail: 'This lead was removed from the campaign.' };

  const action = member.lastAction;
  if (action?.settlementHoldAt)
    return {
      label: 'Held for review',
      detail:
        'The worker cannot prove whether the last LinkedIn action happened, so Trevra will not retry it automatically.'
    };
  if (action?.status === 'held')
    return {
      label: 'Held',
      detail: 'The planned action is parked and cannot execute until it is released.'
    };
  if (action?.status === 'planned' && action.claimedAt)
    return { label: 'Executing', detail: 'A LinkedIn browser worker has claimed this action.' };
  if (action?.status === 'planned' && action.plannedFor) {
    const planned = Date.parse(action.plannedFor);
    if (!Number.isNaN(planned) && planned > now)
      return {
        label: 'Scheduled',
        detail: `A LinkedIn action is allocated for ${new Date(planned).toLocaleString()}.`
      };
    return {
      label: 'Queued for executor',
      detail:
        'The planner allocated this action and its scheduled time has arrived. A LinkedIn browser worker must claim it.'
    };
  }

  const step = steps[currentMemberStepIndex(member, steps)];
  if (step?.action === 'monitor' || step?.action === 'condition') {
    const kind = step.config.condition.kind;
    if (kind === 'accepted' || kind === 'connected')
      return {
        label: 'Waiting for connection',
        detail: 'The workflow is waiting for connection evidence or the monitor timeout.'
      };
    if (kind === 'replied')
      return {
        label: 'Waiting for reply',
        detail: 'The workflow is waiting for a reply or the monitor timeout.'
      };
    return {
      label: 'Waiting for condition',
      detail: `The workflow is waiting for the “${kind.replaceAll('_', ' ')}” condition.`
    };
  }

  if (member.nextEligibleAt) {
    const eligible = Date.parse(member.nextEligibleAt);
    if (!Number.isNaN(eligible) && eligible > now)
      return {
        label: 'Waiting for next step',
        detail: `Sequence timing makes this lead eligible ${dueIn(member.nextEligibleAt, now)}.`
      };
  }
  return {
    label: 'Eligible — not allocated',
    detail:
      'The sequence says this lead may advance now, but the planner has not allocated an execution slot yet. Check campaign capacity and blockers above.'
  };
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
    excluded: 0,
    failed: 0
  } as Record<MemberStatus, number>;
  for (const member of members) counts[member.status] += 1;
  return counts;
}

function campaignCountByStatus(campaign: ManagedCampaign): Record<MemberStatus, number> {
  return {
    pending: campaign.pendingCount,
    active: Math.max(
      0,
      campaign.inSequenceCount - campaign.waitingCount - campaign.manualCount - campaign.pausedCount
    ),
    waiting: campaign.waitingCount,
    manual: campaign.manualCount,
    paused: campaign.pausedCount,
    replied: campaign.repliedCount,
    completed: campaign.completedCount,
    removed: campaign.removedCount,
    excluded: campaign.excludedCount,
    failed: campaign.failedCount
  };
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

const CAPACITY_LABEL: Record<ManagedKind, string> = {
  invite: 'Invites',
  dm: 'Messages',
  profile_view: 'Profile views',
  follow: 'Relationship actions'
};

function CapacityBreakdown({
  ceilings,
  allocated
}: {
  ceilings: Record<ManagedKind, EnforcedCeiling>;
  allocated: CampaignQueueSummary['allocatedCampaignDay'];
}) {
  return (
    <div className="mgr-summary">
      {(['profile_view', 'invite', 'dm', 'follow'] as const).map((kind) => {
        const limit = ceilings[kind].today;
        const used = allocated[kind];
        const remaining = Math.max(0, limit - used);
        return (
          <span key={kind}>
            <b>{CAPACITY_LABEL[kind]}</b>: limit {limit} · {used} allocated · {remaining} remaining
          </span>
        );
      })}
    </div>
  );
}

function capacityKindForStep(step: WorkflowStep | undefined): ManagedKind | null {
  if (!step) return null;
  if (step.action === 'profile_view') return 'profile_view';
  if (
    step.action === 'connection_request' ||
    step.action === 'invite_to_group' ||
    step.action === 'invite_to_event' ||
    step.action === 'invite_to_follow_company'
  )
    return 'invite';
  if (
    step.action === 'message' ||
    step.action === 'inmail' ||
    step.action === 'group_message' ||
    step.action === 'event_message'
  )
    return 'dm';
  if (
    step.action === 'follow' ||
    step.action === 'unfollow' ||
    step.action === 'disconnect' ||
    step.action === 'follow_company'
  )
    return 'follow';
  return null;
}

function campaignBlockers({
  campaign,
  steps,
  operations,
  analytics,
  ceilings,
  report,
  workerStatus,
  companionStatus
}: {
  campaign: ManagedCampaign;
  steps: readonly WorkflowStep[];
  operations: { queues: CampaignQueueSummary; waves: ManagedCampaignWave[] } | null;
  analytics: CampaignOperationalAnalytics | null;
  ceilings: Record<ManagedKind, EnforcedCeiling> | null;
  report: LinkedInLimitsReport | null;
  workerStatus: LinkedInWorkerStatus | null;
  companionStatus: LinkedInCompanionStatus | null;
}): Array<{ title: string; detail: string }> {
  const out: Array<{ title: string; detail: string }> = [];
  if (campaign.status === 'draft')
    return [
      {
        title: 'Campaign not started',
        detail: 'No lead is admitted or planned until you start the campaign.'
      }
    ];
  if (campaign.status === 'paused')
    out.push({
      title: 'Campaign paused',
      detail:
        'New planning is paused. Already-started browser work is not created while the campaign is paused.'
    });
  if (report?.seat.pausedReason)
    out.push({ title: 'LinkedIn account paused', detail: report.seat.pausedReason });

  if (operations && ceilings) {
    const seen = new Set<ManagedKind>();
    for (const backlog of operations.queues.backlogByStep) {
      if (backlog.due <= 0) continue;
      const step = steps.find((candidate) => candidate.id === backlog.stepId);
      const kind = capacityKindForStep(step);
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      const allocated = operations.queues.allocatedCampaignDay[kind];
      const limit = ceilings[kind].today;
      if (allocated >= limit)
        out.push({
          title: `${CAPACITY_LABEL[kind]} capacity fully allocated`,
          detail: `${backlog.due} lead(s) are sequence-eligible at this step, but this campaign's current ramp limit is ${limit} and ${allocated} are already allocated. Remaining planner capacity is 0.`
        });
    }
  }

  const queues = operations?.queues;
  if (queues?.queuedReady) {
    const onlineCompanion = Boolean(companionStatus?.devices.some((device) => device.online));
    if (!workerStatus)
      out.push({
        title: 'Executor status unavailable',
        detail: `${queues.queuedReady} planned action(s) are due, but Trevra could not read browser-worker status.`
      });
    else if (!workerStatus.ready)
      out.push({
        title: 'LinkedIn executor not ready',
        detail: `${queues.queuedReady} planned action(s) are due. ${workerStatus.blockers.join(' ') || 'The browser worker is not ready.'}`
      });
    else if (workerStatus.companionBrowser && !onlineCompanion)
      out.push({
        title: 'Paired computer / companion offline',
        detail: `${queues.queuedReady} planned action(s) are due, but the paired computer is not currently connected to Trevra, so no browser can claim them.`
      });
    else
      out.push({
        title: 'Waiting for browser worker',
        detail: `${queues.queuedReady} planned action(s) have reached their scheduled time and are waiting for the LinkedIn executor to claim them.`
      });
  }
  if (queues?.scheduledFuture)
    out.push({
      title: 'Waiting for scheduled slots',
      detail: `${queues.scheduledFuture} action(s) are already allocated but intentionally scheduled for a later time.`
    });
  if (queues?.heldForReview)
    out.push({
      title: 'Actions held for review',
      detail: `${queues.heldForReview} action(s) are held because Trevra cannot safely infer or repeat their outcome.`
    });
  if ((queues?.waitingForConnection ?? 0) + (queues?.waitingForReply ?? 0) > 0)
    out.push({
      title: 'Waiting on prospect outcomes',
      detail: `${queues?.waitingForConnection ?? 0} lead(s) are waiting for connection evidence and ${queues?.waitingForReply ?? 0} are waiting for a reply or timeout.`
    });
  if (
    analytics?.bottlenecks.reason &&
    analytics.bottlenecks.reason !== 'No material campaign bottleneck is currently detected.'
  )
    out.push({ title: 'Planner diagnosis', detail: analytics.bottlenecks.reason });

  return out;
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
  const currentIndex = currentMemberStepIndex(member, steps);
  const completed = new Set(member.completedStepIds);
  return (
    <ol className="mgr-timeline">
      {steps.map((step, index) => {
        elapsed += stepHours(step);
        const done = completed.has(step.id);
        const current =
          member.currentStepId !== null ? step.id === member.currentStepId : index === currentIndex;
        const copy = stepCopy(step, member.assignedVariants[step.id] ?? null);
        const showBody = Boolean(copy.body) && (current || done || index === currentIndex + 1);
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
                  executionStateForMember(member, steps, now).label}
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

function MemberRecoveryControls({
  member,
  steps,
  busy,
  onRerunCondition,
  onResumeAtStep
}: {
  member: ManagedCampaignMember;
  steps: readonly WorkflowStep[];
  busy: boolean;
  onRerunCondition: (member: ManagedCampaignMember, stepId: string) => void;
  onResumeAtStep: (member: ManagedCampaignMember, stepId: string) => void;
}) {
  const currentIndex = currentMemberStepIndex(member, steps);
  const current = steps[currentIndex] ?? null;
  const [stepId, setStepId] = useState(current?.id ?? steps[0]?.id ?? '');
  useEffect(() => {
    setStepId(current?.id ?? steps[0]?.id ?? '');
  }, [member.id, member.currentStepId, member.stepIndex, current?.id, steps]);
  if (steps.length === 0) return null;
  return (
    <div className="li-row-actions mgr-recovery-controls">
      <span className="li-hint">Executing workflow v{member.workflowVersion ?? '?'}</span>
      {(current?.action === 'condition' || current?.action === 'monitor') && (
        <button
          className="li-mini-button"
          type="button"
          disabled={busy}
          onClick={() => onRerunCondition(member, current.id)}
        >
          <RefreshCw size={12} /> Re-run condition
        </button>
      )}
      <label className="li-inline-field">
        Resume from
        <Select value={stepId} onChange={(event) => setStepId(event.target.value)}>
          {steps.map((step, index) => (
            <option key={step.id} value={step.id}>
              {index + 1}. {ACTION_LABEL[step.action]}
            </option>
          ))}
        </Select>
      </label>
      <button
        className="li-mini-button"
        type="button"
        disabled={busy || !stepId || member.status === 'replied' || member.status === 'removed'}
        onClick={() => onResumeAtStep(member, stepId)}
      >
        Resume at node
      </button>
    </div>
  );
}

/* ==========================================================================
 * The member list: search, filter, sort, timeline, per-lead controls.
 * ======================================================================= */

type MemberSort = 'next' | 'name' | 'status' | 'step';

function CampaignExclusionEditor({
  campaign,
  lists,
  busy,
  onSave
}: {
  campaign: ManagedCampaign;
  lists: readonly LinkedInLeadList[];
  busy: boolean;
  onSave: (policy: ManagedCampaign['exclusionPolicy']) => Promise<void>;
}) {
  const policy = campaign.exclusionPolicy;
  const [companies, setCompanies] = useState((policy.suppressedCompanies ?? []).join(', '));
  const [domains, setDomains] = useState((policy.suppressedDomains ?? []).join(', '));
  const [excludedLists, setExcludedLists] = useState<string[]>(policy.excludedLeadListIds ?? []);
  const [lookback, setLookback] = useState(policy.contactedLookbackDays ?? 0);
  const [existingConversation, setExistingConversation] = useState(
    policy.excludeExistingConversation === true
  );
  const [sameSender, setSameSender] = useState(policy.excludeSameSenderMessaged === true);
  const [duplicateProfiles, setDuplicateProfiles] = useState(
    policy.excludeDuplicateProfiles !== false
  );
  const [excludeKnownConnected, setExcludeKnownConnected] = useState(
    policy.excludeKnownConnected === true
  );
  const [requireKnownConnected, setRequireKnownConnected] = useState(
    policy.requireKnownConnected === true
  );

  useEffect(() => {
    setCompanies((campaign.exclusionPolicy.suppressedCompanies ?? []).join(', '));
    setDomains((campaign.exclusionPolicy.suppressedDomains ?? []).join(', '));
    setExcludedLists(campaign.exclusionPolicy.excludedLeadListIds ?? []);
    setLookback(campaign.exclusionPolicy.contactedLookbackDays ?? 0);
    setExistingConversation(campaign.exclusionPolicy.excludeExistingConversation === true);
    setSameSender(campaign.exclusionPolicy.excludeSameSenderMessaged === true);
    setDuplicateProfiles(campaign.exclusionPolicy.excludeDuplicateProfiles !== false);
    setExcludeKnownConnected(campaign.exclusionPolicy.excludeKnownConnected === true);
    setRequireKnownConnected(campaign.exclusionPolicy.requireKnownConnected === true);
  }, [campaign.id, campaign.exclusionPolicy]);

  const values = (raw: string) => [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
  return (
    <section className="mgr-settings-block">
      <h4>Exclusions and suppression</h4>
      <p className="li-hint">
        Pause the campaign before changing eligibility. Saving re-evaluates only unadmitted leads;
        existing waves keep running exactly as admitted.
      </p>
      <div className="li-form-grid">
        <label>
          Suppressed companies
          <input
            value={companies}
            onChange={(event) => setCompanies(event.target.value)}
            placeholder="Acme, Example Inc"
          />
        </label>
        <label>
          Suppressed email domains
          <input
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            placeholder="competitor.com, agency.example"
          />
        </label>
        <label>
          Contacted lookback days
          <input
            type="number"
            min={0}
            max={3650}
            value={lookback}
            onChange={(event) =>
              setLookback(Math.max(0, Math.trunc(Number(event.target.value) || 0)))
            }
          />
        </label>
        <label>
          Excluded lead lists
          <Select
            multiple
            value={excludedLists}
            onChange={(event) =>
              setExcludedLists(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value)
              )
            }
          >
            {lists
              .filter((list) => list.id !== campaign.leadListId)
              .map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
          </Select>
        </label>
        <label className="li-check-row">
          <input
            type="checkbox"
            checked={existingConversation}
            onChange={(event) => setExistingConversation(event.target.checked)}
          />
          Exclude existing conversations
        </label>
        <label className="li-check-row">
          <input
            type="checkbox"
            checked={sameSender}
            onChange={(event) => setSameSender(event.target.checked)}
          />
          Exclude leads already messaged by an assigned sender
        </label>
        <label className="li-check-row">
          <input
            type="checkbox"
            checked={duplicateProfiles}
            onChange={(event) => setDuplicateProfiles(event.target.checked)}
          />
          Exclude normalized duplicate LinkedIn profiles
        </label>
        <label className="li-check-row">
          <input
            type="checkbox"
            checked={excludeKnownConnected}
            disabled={requireKnownConnected}
            onChange={(event) => setExcludeKnownConnected(event.target.checked)}
          />
          Exclude known 1st-degree connections
        </label>
        <label className="li-check-row">
          <input
            type="checkbox"
            checked={requireKnownConnected}
            disabled={excludeKnownConnected}
            onChange={(event) => setRequireKnownConnected(event.target.checked)}
          />
          Require known 1st-degree connection evidence
        </label>
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || campaign.status !== 'paused'}
        onClick={() =>
          void onSave({
            ...campaign.exclusionPolicy,
            suppressedCompanies: values(companies),
            suppressedDomains: values(domains),
            excludedLeadListIds: excludedLists,
            contactedLookbackDays: lookback,
            excludeExistingConversation: existingConversation,
            excludeSameSenderMessaged: sameSender,
            excludeDuplicateProfiles: duplicateProfiles,
            excludeKnownConnected,
            requireKnownConnected
          })
        }
      >
        Save exclusions and re-evaluate pending
      </button>
    </section>
  );
}

function CampaignScheduleEditor({
  campaign,
  timezone,
  busy,
  onSave
}: {
  campaign: ManagedCampaign;
  timezone: string;
  busy: boolean;
  onSave: (schedule: Partial<ManagedCampaign['schedule']>) => Promise<void>;
}) {
  const zonedParts = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
      second: read('second')
    };
  };
  const toLocal = (iso: string | null) => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const part = zonedParts(date);
    return `${part.year.toString().padStart(4, '0')}-${part.month.toString().padStart(2, '0')}-${part.day.toString().padStart(2, '0')}T${part.hour.toString().padStart(2, '0')}:${part.minute.toString().padStart(2, '0')}`;
  };
  const zonedLocalToIso = (value: string): string | null => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const requested = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5])
    };
    const wallAsUtc = Date.UTC(
      requested.year,
      requested.month - 1,
      requested.day,
      requested.hour,
      requested.minute
    );
    let instant = wallAsUtc;
    // Two passes converge across ordinary offsets and DST boundaries because the
    // timezone offset is derived from the candidate instant, never from the browser timezone.
    for (let pass = 0; pass < 3; pass += 1) {
      const shown = zonedParts(new Date(instant));
      const shownAsUtc = Date.UTC(
        shown.year,
        shown.month - 1,
        shown.day,
        shown.hour,
        shown.minute,
        shown.second
      );
      instant += wallAsUtc - shownAsUtc;
    }
    const roundTrip = zonedParts(new Date(instant));
    if (
      roundTrip.year !== requested.year ||
      roundTrip.month !== requested.month ||
      roundTrip.day !== requested.day ||
      roundTrip.hour !== requested.hour ||
      roundTrip.minute !== requested.minute
    )
      return null;
    return new Date(instant).toISOString();
  };
  const toTime = (minute: number | null) => {
    if (minute === null) return '';
    const h = Math.floor(minute / 60)
      .toString()
      .padStart(2, '0');
    const m = (minute % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  };
  const minuteOf = (value: string): number | null => {
    if (!value) return null;
    const [h, m] = value.split(':').map(Number);
    return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
  };
  const [startAt, setStartAt] = useState(toLocal(campaign.schedule.startAt));
  const [endAt, setEndAt] = useState(toLocal(campaign.schedule.endAt));
  const [days, setDays] = useState<number[]>(campaign.schedule.workingDays ?? [1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState(toTime(campaign.schedule.workStartMinute));
  const [endTime, setEndTime] = useState(toTime(campaign.schedule.workEndMinute));
  const [endBehavior, setEndBehavior] = useState(campaign.schedule.endBehavior);
  const [scheduleError, setScheduleError] = useState('');
  useEffect(() => {
    setStartAt(toLocal(campaign.schedule.startAt));
    setEndAt(toLocal(campaign.schedule.endAt));
    setDays(campaign.schedule.workingDays ?? [1, 2, 3, 4, 5]);
    setStartTime(toTime(campaign.schedule.workStartMinute));
    setEndTime(toTime(campaign.schedule.workEndMinute));
    setEndBehavior(campaign.schedule.endBehavior);
    setScheduleError('');
  }, [campaign.id, campaign.schedule]);
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <section className="mgr-settings-block">
      <h4>Campaign schedule</h4>
      <p className="li-hint">
        Uses {timezone}. Campaign hours can only narrow the LinkedIn account's working window; they
        never widen it. Pause before editing.
      </p>
      <div className="li-form-grid">
        <label>
          Start date/time
          <input
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
          />
        </label>
        <label>
          End date/time
          <input
            type="datetime-local"
            value={endAt}
            onChange={(event) => setEndAt(event.target.value)}
          />
        </label>
        <label>
          Earliest campaign time
          <input
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <label>
          Latest campaign time
          <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
        </label>
        <fieldset className="li-span-2">
          <legend>Working days</legend>
          <div className="mgr-pick-grid">
            {dayLabels.map((label, day) => (
              <label className="li-check-row" key={label}>
                <input
                  type="checkbox"
                  checked={days.includes(day)}
                  onChange={(event) =>
                    setDays((current) =>
                      event.target.checked
                        ? [...new Set([...current, day])].sort((a, b) => a - b)
                        : current.filter((value) => value !== day)
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          At campaign end
          <Select
            value={endBehavior}
            onChange={(event) =>
              setEndBehavior(event.target.value as ManagedCampaign['schedule']['endBehavior'])
            }
          >
            <option value="finish_waves">Stop new admission; finish admitted waves</option>
            <option value="pause_all">Pause all campaign work</option>
            <option value="stop_immediately">Stop immediately</option>
          </Select>
        </label>
      </div>
      {scheduleError && <p className="error-banner">{scheduleError}</p>}
      <button
        type="button"
        className="secondary-button"
        disabled={
          busy ||
          campaign.status !== 'paused' ||
          days.length === 0 ||
          (startTime !== '' &&
            endTime !== '' &&
            (minuteOf(endTime) ?? 0) <= (minuteOf(startTime) ?? 0))
        }
        onClick={() => {
          const resolvedStart = startAt ? zonedLocalToIso(startAt) : null;
          const resolvedEnd = endAt ? zonedLocalToIso(endAt) : null;
          if ((startAt && !resolvedStart) || (endAt && !resolvedEnd)) {
            setScheduleError(
              `That local date/time does not exist or is ambiguous in ${timezone}. Choose another time around the daylight-saving transition.`
            );
            return;
          }
          setScheduleError('');
          void onSave({
            startAt: resolvedStart,
            endAt: resolvedEnd,
            workingDays: days,
            workStartMinute: minuteOf(startTime),
            workEndMinute: minuteOf(endTime),
            endBehavior
          });
        }}
      >
        Save campaign schedule
      </button>
    </section>
  );
}

function CampaignMembers({
  members,
  steps,
  now,
  busy,
  onPause,
  onResume,
  onRemove,
  timelines,
  onLoadTimeline,
  onSkip,
  onEnd,
  onRerunCondition,
  onResumeAtStep,
  onResolveUnknown,
  followUpCampaigns,
  onBulkRetry,
  onMoveSelected
}: {
  members: readonly ManagedCampaignMember[];
  steps: readonly WorkflowStep[];
  now: number;
  busy: string;
  onPause: (member: ManagedCampaignMember) => void;
  onResume: (member: ManagedCampaignMember) => void;
  onRemove: (member: ManagedCampaignMember) => void;
  timelines: Readonly<Record<string, CampaignMemberTimeline>>;
  onLoadTimeline: (member: ManagedCampaignMember) => void;
  onSkip: (member: ManagedCampaignMember) => void;
  onEnd: (member: ManagedCampaignMember) => void;
  onRerunCondition: (member: ManagedCampaignMember, stepId: string) => void;
  onResumeAtStep: (member: ManagedCampaignMember, stepId: string) => void;
  onResolveUnknown: (
    member: ManagedCampaignMember,
    event: CampaignMemberTimeline['events'][number],
    resolution: 'sent' | 'retry' | 'skip'
  ) => void;
  followUpCampaigns: readonly ManagedCampaign[];
  onBulkRetry: (memberIds: string[]) => void;
  onMoveSelected: (targetCampaignId: string, memberIds: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | MemberStatus>('all');
  const [sort, setSort] = useState<MemberSort>('next');
  const [limit, setLimit] = useState(50);
  const [openId, setOpenId] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [targetCampaignId, setTargetCampaignId] = useState('');
  const [removeCandidate, setRemoveCandidate] = useState<ManagedCampaignMember | null>(null);

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

  useEffect(() => {
    const live = new Set(members.map((member) => member.id));
    setSelectedIds((current) => new Set([...current].filter((id) => live.has(id))));
  }, [members]);

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
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as 'all' | MemberStatus)}
          >
            <option value="all">All statuses</option>
            {present.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Sort by
          <Select value={sort} onChange={(event) => setSort(event.target.value as MemberSort)}>
            <option value="next">Next action first</option>
            <option value="name">Name A–Z</option>
            <option value="status">Status</option>
            <option value="step">Furthest through the sequence</option>
          </Select>
        </label>
        <p className="li-hint">
          Showing {shown.length} of {plural(members.length, 'lead')}.
        </p>
      </div>

      {selectedIds.size > 0 && (
        <div className="li-filter-row mgr-bulk-actions">
          <strong>{selectedIds.size} selected</strong>
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== ''}
            onClick={() => onBulkRetry([...selectedIds])}
          >
            <RefreshCw size={13} /> Retry selected failures
          </button>
          {followUpCampaigns.length > 0 && (
            <>
              <label>
                Follow-up campaign
                <Select
                  value={targetCampaignId}
                  onChange={(event) => setTargetCampaignId(event.target.value)}
                >
                  <option value="">Choose campaign…</option>
                  {followUpCampaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name} ({CAMPAIGN_STATUS_LABEL[campaign.status]})
                    </option>
                  ))}
                </Select>
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={busy !== '' || !targetCampaignId}
                onClick={() => {
                  onMoveSelected(targetCampaignId, [...selectedIds]);
                  setSelectedIds(new Set());
                }}
              >
                Move selected
              </button>
            </>
          )}
          <button className="ghost-button" type="button" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </button>
        </div>
      )}

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
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select visible leads"
                      checked={
                        shown.slice(0, limit).length > 0 &&
                        shown.slice(0, limit).every((member) => selectedIds.has(member.id))
                      }
                      onChange={(event) => {
                        const visible = shown.slice(0, limit).map((member) => member.id);
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          for (const id of visible)
                            event.target.checked ? next.add(id) : next.delete(id);
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th>Lead</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Execution state</th>
                  <th>
                    <span className="mgr-sr">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((member) => {
                  const open = openId === member.id;
                  const rowBusy = busy.startsWith(`member:${member.id}`);
                  const execution = executionStateForMember(member, steps, now);
                  return [
                    <tr key={member.id} className={open ? 'mgr-row-open' : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${member.firstName} ${member.lastName}`}
                          checked={selectedIds.has(member.id)}
                          onChange={(event) =>
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              event.target.checked ? next.add(member.id) : next.delete(member.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <button
                          className="mgr-linkish"
                          type="button"
                          aria-expanded={open}
                          onClick={() => {
                            setOpenId(open ? '' : member.id);
                            if (!open) onLoadTimeline(member);
                          }}
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
                        {steps.length > 0
                          ? (() => {
                              const currentIndex = currentMemberStepIndex(member, steps);
                              const currentStep = steps[currentIndex];
                              return (
                                <>
                                  {Math.min(currentIndex + 1, steps.length)} of {steps.length}
                                  {currentStep && (
                                    <span className="mgr-step-name">
                                      {ACTION_LABEL[currentStep.action]}
                                    </span>
                                  )}
                                </>
                              );
                            })()
                          : member.stepIndex + 1}
                      </td>
                      <td>
                        <strong>{execution.label}</strong>
                        <span className="mgr-step-name" title={execution.detail}>
                          {execution.detail}
                        </span>
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
                            <ActionMenu
                              compact
                              label={`More actions for ${member.firstName} ${member.lastName}`}
                              items={[
                                ...(member.status === 'active' ||
                                member.status === 'waiting' ||
                                member.status === 'manual' ||
                                member.status === 'paused'
                                  ? [
                                      {
                                        label: 'Skip current step',
                                        disabled: busy !== '',
                                        onSelect: () => onSkip(member)
                                      }
                                    ]
                                  : []),
                                {
                                  label: 'End automation',
                                  disabled: busy !== '',
                                  onSelect: () => onEnd(member)
                                },
                                {
                                  label: 'Remove from campaign',
                                  icon: <Trash2 size={12} />,
                                  disabled: busy !== '',
                                  danger: true,
                                  onSelect: () => setRemoveCandidate(member)
                                }
                              ]}
                            />
                          )}
                        </div>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${member.id}:detail`} className="mgr-row-detail">
                        <td colSpan={7}>
                          <MemberTimeline steps={steps} member={member} now={now} />
                          <MemberRecoveryControls
                            member={member}
                            steps={steps}
                            busy={busy !== ''}
                            onRerunCondition={onRerunCondition}
                            onResumeAtStep={onResumeAtStep}
                          />
                          {timelines[member.id] && (
                            <div className="mgr-timeline-events">
                              <h5>Recorded history</h5>
                              <ul>
                                {timelines[member.id].events.map((event, index) => (
                                  <li
                                    key={`${event.kind}:${event.stepId ?? ''}:${event.at ?? ''}:${index}`}
                                  >
                                    <b>{event.label}</b>
                                    {event.stepId
                                      ? ` · ${event.stepLabel ?? event.stepId} (${event.stepId})`
                                      : ''}
                                    {event.senderKey ? ` · sender ${event.senderKey}` : ''}
                                    {event.variantId ? ` · variant ${event.variantId}` : ''}
                                    {event.status ? ` · ${event.status}` : ''}
                                    {event.detail ? ` · ${event.detail}` : ''}
                                    {event.approvedText ? (
                                      <span className="mgr-step-name">
                                        Approved: {event.approvedText}
                                      </span>
                                    ) : null}
                                    {event.at ? (
                                      <span> · {new Date(event.at).toLocaleString()}</span>
                                    ) : null}
                                    {event.requiresResolution && event.eventId && (
                                      <div className="mgr-resolution">
                                        <strong>Confirm what happened</strong>
                                        <span>
                                          Trevra stopped here because the side effect could not be
                                          proven. Choose only what you verified.
                                        </span>
                                        <div className="mgr-resolution-actions">
                                          <button
                                            className="primary-button"
                                            type="button"
                                            disabled={busy !== ''}
                                            onClick={() => onResolveUnknown(member, event, 'sent')}
                                          >
                                            <Check size={13} /> It happened
                                          </button>
                                          <button
                                            className="secondary-button"
                                            type="button"
                                            disabled={busy !== ''}
                                            onClick={() => onResolveUnknown(member, event, 'retry')}
                                          >
                                            <RefreshCw size={13} /> Retry — it did not happen
                                          </button>
                                          <button
                                            className="ghost-button"
                                            type="button"
                                            disabled={busy !== ''}
                                            onClick={() => onResolveUnknown(member, event, 'skip')}
                                          >
                                            Skip this step
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ul>
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

      {removeCandidate && (
        <ConfirmDrawer
          title={`Remove ${removeCandidate.firstName} ${removeCandidate.lastName} from this campaign?`}
          body={
            <>
              <p>
                This ends campaign automation for this lead and cancels work that has not started.
                Actions that already happened remain in the lead history.
              </p>
              <p>
                If you only need a temporary stop, use Pause instead. Removing the lead is intended
                for a permanent campaign-level decision.
              </p>
            </>
          }
          confirmLabel="Remove from campaign"
          tone="danger"
          busy={busy.startsWith(`member:${removeCandidate.id}`)}
          onConfirm={() => {
            const member = removeCandidate;
            setRemoveCandidate(null);
            onRemove(member);
          }}
          onCancel={() => setRemoveCandidate(null)}
        />
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
  onNavigate,
  initialCampaignId
}: {
  setToast: (message: string) => void;
  onNavigate: (path: string) => void;
  /** Deep links created by the builder open the new campaign immediately. */
  initialCampaignId?: string | null;
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
  const isWorkspaceOwner = useIsWorkspaceOwner();
  const { members: workspaceMembers } = useWorkspaceMembers();
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [campaigns, setCampaigns] = useState<ManagedCampaign[]>([]);
  const [membersByCampaign, setMembersByCampaign] = useState<
    Record<string, ManagedCampaignMember[]>
  >({});
  const [operationsByCampaign, setOperationsByCampaign] = useState<
    Record<string, { queues: CampaignQueueSummary; waves: ManagedCampaignWave[] }>
  >({});
  const [operationalAnalyticsByCampaign, setOperationalAnalyticsByCampaign] = useState<
    Record<string, CampaignOperationalAnalytics>
  >({});
  const [timelinesByMember, setTimelinesByMember] = useState<
    Record<string, CampaignMemberTimeline>
  >({});
  /** One effective-limits report per account, keyed by account. */
  const [limitsBySeat, setLimitsBySeat] = useState<Record<string, LinkedInLimitsReport>>({});
  const [tasks, setTasks] = useState<ManualTaskView[]>([]);
  const [analytics, setAnalytics] = useState<ManagedAnalytics | null>(null);
  const [workerStatus, setWorkerStatus] = useState<LinkedInWorkerStatus | null>(null);
  const [companionStatus, setCompanionStatus] = useState<LinkedInCompanionStatus | null>(null);
  const [openCampaignId, setOpenCampaignId] = useState(initialCampaignId ?? '');
  const [openCampaignSection, setOpenCampaignSection] = useState('');
  const [waveFilterByCampaign, setWaveFilterByCampaign] = useState<Record<string, number | null>>(
    {}
  );
  const [openTaskId, setOpenTaskId] = useState('');
  const [loading, setLoading] = useState(true);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState<ManagedCampaign | null>(null);
  const [deleting, setDeleting] = useState<ManagedCampaign | null>(null);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [seatFilter, setSeatFilter] = useState(activeSeatKey);
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (initialCampaignId) setOpenCampaignId(initialCampaignId);
  }, [initialCampaignId]);

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
      const [
        nextSeats,
        nextLists,
        nextWorkflows,
        nextCampaigns,
        nextTasks,
        nextWorkerStatus,
        nextCompanionStatus
      ] = await Promise.all([
        getLinkedInManagerSeats(),
        getLinkedInManagerLeadLists(),
        getLinkedInManagerWorkflows(),
        getLinkedInManagedCampaigns(),
        getLinkedInManualTasks(),
        getLinkedInWorkerStatus().catch(() => null),
        getLinkedInCompanionStatus().catch(() => null)
      ]);
      setSeats(nextSeats);
      setLists(nextLists);
      setWorkflows(nextWorkflows);
      setCampaigns(nextCampaigns);
      setTasks(nextTasks);
      setWorkerStatus(nextWorkerStatus);
      setCompanionStatus(nextCompanionStatus);
      // Campaign rows already carry the operational status histogram. Member lists are loaded only
      // when a campaign is opened, so this screen stays one aggregate read regardless of campaign count.
      setMembersByCampaign((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) =>
            nextCampaigns.some((campaign) => campaign.id === id)
          )
        )
      );
      setOperationsByCampaign((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) =>
            nextCampaigns.some((campaign) => campaign.id === id)
          )
        )
      );
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
    const [detail, operations, operationalAnalytics] = await Promise.all([
      getLinkedInManagedCampaign(campaignId),
      getLinkedInCampaignOperations(campaignId),
      getLinkedInCampaignOperationalAnalytics(campaignId)
    ]);
    setMembersByCampaign((current) => ({ ...current, [campaignId]: detail.members }));
    setOperationsByCampaign((current) => ({
      ...current,
      [campaignId]: { queues: operations.queues, waves: operations.waves }
    }));
    setOperationalAnalyticsByCampaign((current) => ({
      ...current,
      [campaignId]: operationalAnalytics
    }));
    setCampaigns((current) =>
      current.map((campaign) => (campaign.id === campaignId ? detail.campaign : campaign))
    );
  };

  useEffect(() => {
    if (!openCampaignId) return;
    void refreshCampaign(openCampaignId).catch((err) =>
      setError(errorMessage(err, 'Unable to read that campaign.'))
    );
  }, [openCampaignId]);

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

  const applyLatestWorkflow = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        const result = await applyLatestLinkedInManagedCampaignWorkflow(campaign.id);
        setToast(
          result.pendingAffected > 0
            ? `Pending leads in “${campaign.name}” will use workflow v${result.latestVersion}. Existing waves stay on their original versions.`
            : `“${campaign.name}” now targets workflow v${result.latestVersion}; no pending leads were waiting to receive it.`
        );
        await refreshCampaign(campaign.id);
      },
      'Unable to apply the latest workflow version.'
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

  const deleteCampaign = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await deleteLinkedInManagedCampaign(campaign.id);
        setToast(`“${campaign.name}” was deleted from Campaigns.`);
        setDeleting(null);
        if (openCampaignId === campaign.id) setOpenCampaignId('');
        if (campaignFilter === campaign.id) setCampaignFilter('');
        await refreshAll();
      },
      'Unable to delete that campaign. Cancel or stop it first if it is still active.'
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

  const loadMemberTimeline = (member: ManagedCampaignMember) => {
    if (timelinesByMember[member.id]) return;
    void getLinkedInManagedMemberTimeline(member.id)
      .then((timeline) =>
        setTimelinesByMember((current) => ({ ...current, [member.id]: timeline }))
      )
      .catch((err) => setError(errorMessage(err, 'Unable to read that lead history.')));
  };

  const skipMember = (member: ManagedCampaignMember) =>
    guard(
      `member:${member.id}`,
      async () => {
        await skipLinkedInManagedMemberStep(member.id);
        setToast(`${member.firstName} ${member.lastName} skipped the current step.`);
        setTimelinesByMember((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        await refreshCampaign(member.campaignId);
      },
      'Unable to skip that step.'
    );

  const rerunMemberCondition = (member: ManagedCampaignMember, stepId: string) =>
    guard(
      `member:${member.id}`,
      async () => {
        await rerunLinkedInManagedMemberCondition(member.id, stepId);
        setToast(
          `${member.firstName} ${member.lastName}'s condition will be evaluated again without re-sending the previous action.`
        );
        setTimelinesByMember((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        await refreshCampaign(member.campaignId);
      },
      'Unable to re-run that condition.'
    );

  const resumeMemberAtStep = (member: ManagedCampaignMember, stepId: string) =>
    guard(
      `member:${member.id}`,
      async () => {
        await resumeLinkedInManagedMemberAtStep(member.id, stepId);
        setToast(
          `${member.firstName} ${member.lastName} will resume from the selected workflow node. Unstarted later work was cancelled.`
        );
        setTimelinesByMember((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        await refreshCampaign(member.campaignId);
      },
      'Unable to resume that lead at the selected node.'
    );

  const resolveUnknownOutcome = (
    member: ManagedCampaignMember,
    event: CampaignMemberTimeline['events'][number],
    resolution: 'sent' | 'retry' | 'skip'
  ) => {
    if (!event.eventId || (event.kind !== 'action' && event.kind !== 'channel')) return;
    return guard(
      `member:${member.id}`,
      async () => {
        await resolveLinkedInManagedUnknownOutcome(
          event.kind === 'action' ? 'linkedin' : 'channel',
          event.eventId!,
          resolution
        );
        setToast(
          resolution === 'sent'
            ? `Confirmed the action for ${member.firstName} happened. The workflow can continue without replaying it.`
            : resolution === 'retry'
              ? `Confirmed the action for ${member.firstName} did not happen. It is safe to try again.`
              : `Skipped the unresolved step for ${member.firstName}. It will not be retried.`
        );
        setTimelinesByMember((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        await refreshCampaign(member.campaignId);
        const timeline = await getLinkedInManagedMemberTimeline(member.id);
        setTimelinesByMember((current) => ({ ...current, [member.id]: timeline }));
      },
      'Unable to resolve that unknown outcome.'
    );
  };

  const endMember = (member: ManagedCampaignMember) =>
    guard(
      `member:${member.id}`,
      async () => {
        await endLinkedInManagedMember(member.id, 'completed');
        setToast(
          `${member.firstName} ${member.lastName} ended here. No later campaign action will run.`
        );
        setTimelinesByMember((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        await refreshCampaign(member.campaignId);
      },
      'Unable to end automation for that lead.'
    );

  const retrySelectedFailures = (campaign: ManagedCampaign, memberIds: string[]) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        const result = await retryLinkedInManagedCampaignFailures(campaign.id, memberIds);
        setToast(
          `Selected leads: requeued ${result.linkedinActions + result.channelActions} definite failure(s); unknown outcomes were left untouched.`
        );
        await refreshCampaign(campaign.id);
      },
      'Unable to retry the selected failures.'
    );

  const moveSelectedMembers = (
    campaign: ManagedCampaign,
    targetCampaignId: string,
    memberIds: string[]
  ) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        const result = await moveLinkedInManagedCampaignMembers(
          campaign.id,
          targetCampaignId,
          memberIds
        );
        setToast(
          `Moved ${result.moved} lead(s) to the follow-up campaign${result.skipped ? `; ${result.skipped} were skipped by dedupe/eligibility rules` : ''}.`
        );
        await refreshAll();
      },
      'Unable to move the selected leads.'
    );

  const retryCampaignFailures = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        const result = await retryLinkedInManagedCampaignFailures(campaign.id);
        setToast(
          result.linkedinActions + result.channelActions > 0
            ? `Requeued ${result.linkedinActions + result.channelActions} definite failure(s). Unknown outcomes were left untouched.`
            : 'No definite no-side-effect failures were eligible for retry.'
        );
        await refreshCampaign(campaign.id);
      },
      'Unable to retry campaign failures.'
    );

  const transferCampaignOwner = (campaign: ManagedCampaign, ownerUserId: string) =>
    guard(
      `owner:${campaign.id}`,
      async () => {
        const updated = await setLinkedInManagedCampaignOwner(campaign.id, ownerUserId);
        setToast(
          `“${campaign.name}” is now owned by ${updated.ownerName ?? 'the selected teammate'}.`
        );
        await refreshCampaign(campaign.id);
      },
      'Unable to transfer that campaign.'
    );

  const exportCampaign = (campaign: ManagedCampaign) =>
    guard(
      `export:${campaign.id}`,
      async () => {
        const blob = await downloadLinkedInManagedCampaignExport(campaign.id);
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `${campaign.name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'campaign'}-results.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(href);
        setToast(`Exported “${campaign.name}”.`);
      },
      'Unable to export that campaign.'
    );

  const setCampaignPriority = (campaign: ManagedCampaign, priority: ManagedCampaign['priority']) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await updateLinkedInCampaignControls(campaign.id, { priority });
        setToast(`“${campaign.name}” priority is now ${priority}. Safety ceilings are unchanged.`);
        await refreshCampaign(campaign.id);
      },
      'Unable to change campaign priority.'
    );

  const saveCampaignSchedule = (
    campaign: ManagedCampaign,
    schedule: Partial<ManagedCampaign['schedule']>
  ) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await updateLinkedInCampaignControls(campaign.id, { schedule });
        setToast(
          `Updated the schedule for “${campaign.name}”. Seat-level working hours remain authoritative.`
        );
        await refreshCampaign(campaign.id);
      },
      'Unable to update campaign schedule.'
    );

  const saveCampaignExclusions = (
    campaign: ManagedCampaign,
    exclusionPolicy: ManagedCampaign['exclusionPolicy']
  ) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        await updateLinkedInCampaignControls(campaign.id, { exclusionPolicy });
        setToast(`Re-evaluated pending leads for “${campaign.name}” with the updated exclusions.`);
        await refreshCampaign(campaign.id);
      },
      'Unable to update campaign exclusions.'
    );

  const duplicateCampaign = (campaign: ManagedCampaign) =>
    guard(
      `campaign:${campaign.id}`,
      async () => {
        const result = await duplicateLinkedInManagedCampaign(campaign.id);
        setToast(
          `Created draft “${result.campaign.name}” with the same audience, workflow, senders, exclusions, and wave controls.`
        );
        await refreshAll();
        setOpenCampaignId(result.campaign.id);
      },
      'Unable to duplicate that campaign.'
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
      setToast(
        task.taskKind === 'comment' ? 'Suggested comment copied.' : 'Suggested message copied.'
      );
    } catch {
      setError('Your browser blocked the copy. Select the text and copy it by hand.');
    }
  };

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
    <div className="page-stack li-polished">
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
              const counts = campaignCountByStatus(campaign);
              const workflow = workflowOf(campaign);
              const newerWorkflowAvailable = Boolean(
                workflow && workflow.version > (campaign.workflowVersion ?? 0)
              );
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
              const operations = operationsByCampaign[campaign.id] ?? null;
              const operationalAnalytics = operationalAnalyticsByCampaign[campaign.id] ?? null;
              const blockers = campaignBlockers({
                campaign,
                steps: campaignSteps,
                operations,
                analytics: operationalAnalytics,
                ceilings,
                report,
                workerStatus,
                companionStatus
              });
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
                      Cancel/Stop is the lifecycle boundary before hard deletion.
                      Draft, running and paused campaigns can still own leads or
                      queued work, so they must be cancelled/stopped first. Only
                      terminal campaigns expose Delete below.
                    */}
                      {(campaign.status === 'draft' ||
                        campaign.status === 'running' ||
                        campaign.status === 'paused') && (
                        <button
                          className="secondary-button is-danger"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => setStopping(campaign)}
                        >
                          <Square size={14} /> {campaign.status === 'draft' ? 'Cancel' : 'Stop'}
                        </button>
                      )}
                      {terminal && rebuildable && (
                        <button
                          className="primary-button"
                          type="button"
                          disabled={busy !== ''}
                          onClick={() => rebuild(campaign)}
                        >
                          <Copy size={14} /> Build it again
                        </button>
                      )}
                      {!terminal &&
                        (campaign.failedCount > 0 || (operations?.queues.failed ?? 0) > 0) && (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={busy !== ''}
                            title="Retries only failures known to have produced no side effect. Unknown sends remain held."
                            onClick={() => void retryCampaignFailures(campaign)}
                          >
                            <RefreshCw size={14} /> Retry safe failures
                          </button>
                        )}
                      {newerWorkflowAvailable && !terminal && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy !== ''}
                          title="Only pending, unadmitted leads change. Existing waves keep their original workflow snapshot."
                          onClick={() => void applyLatestWorkflow(campaign)}
                        >
                          <RefreshCw size={14} /> Apply workflow v{workflow!.version}
                        </button>
                      )}
                      <ActionMenu
                        label={`More actions for ${campaign.name}`}
                        items={[
                          ...(workflow
                            ? [
                                {
                                  label: 'Edit workflow',
                                  icon: <WorkflowIcon size={14} />,
                                  disabled: busy !== '',
                                  onSelect: () =>
                                    onNavigate(
                                      `/outreach/workflow/${encodeURIComponent(workflow.id)}/${encodeURIComponent(campaign.id)}`
                                    )
                                }
                              ]
                            : []),
                          {
                            label: 'Export CSV',
                            icon: <Download size={14} />,
                            disabled: busy !== '',
                            onSelect: () => exportCampaign(campaign)
                          },
                          {
                            label: 'Duplicate as draft',
                            icon: <Copy size={14} />,
                            disabled: busy !== '',
                            onSelect: () => duplicateCampaign(campaign)
                          },
                          ...(terminal
                            ? [
                                {
                                  label: 'Delete campaign',
                                  icon: <Trash2 size={14} />,
                                  disabled: busy !== '',
                                  danger: true,
                                  onSelect: () => setDeleting(campaign)
                                }
                              ]
                            : [])
                        ]}
                      />
                    </div>
                  </div>

                  {open ? (
                    <div className="mgr-meta">
                      <span>
                        Sends from <b>{campaign.senderKeys.map(seatLabel).join(', ')}</b>
                      </span>
                      <span>
                        Owned by <b>{campaign.ownerName ?? 'workspace owner'}</b>
                        {isWorkspaceOwner && workspaceMembers.length > 0 && (
                          <ChoiceMenu
                            label={`Change owner for ${campaign.name}`}
                            title="Choose campaign owner"
                            items={workspaceMembers.map((member) => ({
                              id: member.userId,
                              label: member.name
                            }))}
                            selectedId={campaign.ownerUserId}
                            disabled={busy !== ''}
                            onChoose={(userId) => transferCampaignOwner(campaign, userId)}
                          />
                        )}
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
                    </div>
                  ) : (
                    <div className="mgr-meta mgr-meta-compact">
                      <span>
                        {plural(campaign.memberCount, 'lead')} · {campaign.inSequenceCount} in
                        sequence
                      </span>
                      <span>{campaign.senderKeys.map(seatLabel).join(', ')}</span>
                    </div>
                  )}

                  {open && workflow && campaign.status === 'running' && (
                    <p className="mgr-warmup">
                      Workflow v{campaign.workflowVersion ?? '—'} locked
                      <Hint label="Why is this workflow version locked?">
                        Running leads keep the workflow version they entered with. Editing the saved
                        workflow does not change admitted waves; an explicit workflow upgrade only
                        updates pending, unadmitted leads.
                      </Hint>
                    </p>
                  )}

                  {open && (
                    <>
                      <StatusBar counts={counts} total={campaign.memberCount} />
                      <StatusLegend counts={counts} total={campaign.memberCount} />
                    </>
                  )}

                  {/*
                  A TERMINAL CAMPAIGN GETS AN EXPLANATION, NOT A WARM-UP LINE.
                  Stopped and finished campaigns used to fall through to "Full
                  speed: up to N invites a day", which is a sentence about work
                  that will never happen again, on a campaign whose only real
                  question is what became of its leads and what to do next.
                */}
                  {terminal ? (
                    <p className="mgr-warmup">
                      {campaign.status === 'stopped' ? 'Stopped' : 'Finished'}
                      <Hint
                        label={
                          campaign.status === 'stopped'
                            ? 'What happens after a campaign is stopped?'
                            : 'What happens after a campaign finishes?'
                        }
                      >
                        {campaign.status === 'stopped'
                          ? `Queued work that had not started was cancelled and its leads are free for another campaign.${rebuildable ? ' Build a new campaign from the same list and workflow to run them again.' : ''}`
                          : `Every lead reached the end of the workflow and nothing more will be sent.${rebuildable ? ' Build a new campaign from the same list and workflow to run them again.' : ''}`}
                      </Hint>
                    </p>
                  ) : (
                    <p className="mgr-warmup">
                      {campaign.status === 'draft' ? (
                        <>
                          Not started
                          {rampFractions(report) && fullCeilings && (
                            <Hint label="How will campaign warm-up work?">
                              Day 1 starts at{' '}
                              {Math.round((rampFractionForDay(report, 1) ?? 1) * 100)}% of{' '}
                              {seatLabel(campaign.seatKey)}&rsquo;s normal allowance and reaches
                              full speed on day {rampFractions(report)!.length}. At full speed the
                              current ceilings are {plural(fullCeilings.invite.full, 'invite')} and{' '}
                              {plural(fullCeilings.dm.full, 'message')} a day.
                            </Hint>
                          )}
                        </>
                      ) : warmup && warmup.fraction < 1 ? (
                        <>
                          <WarmupPips day={warmup.day} days={warmup.days} /> Warm-up {warmup.day}/
                          {warmup.days} · {Math.round(warmup.fraction * 100)}% today
                          <Hint label="Why is this campaign warming up?">
                            The campaign is temporarily limited to{' '}
                            {Math.round(warmup.fraction * 100)}% of {seatLabel(campaign.seatKey)}
                            &rsquo;s normal daily allowance to avoid a sudden activity spike. It
                            reaches full speed on day {warmup.days}.
                          </Hint>
                        </>
                      ) : warmup ? (
                        <>
                          <WarmupPips day={warmup.days} days={warmup.days} /> Full speed
                        </>
                      ) : campaign.startedAt ? (
                        <>Running · allowance unavailable</>
                      ) : (
                        <>Warm-up starts on launch</>
                      )}
                    </p>
                  )}

                  {open && (
                    <div
                      className={`mgr-campaign-health${blockers.length > 0 ? ' has-issues' : ''}`}
                    >
                      <div>
                        <strong>
                          {blockers.length === 0 ? 'No blockers detected' : 'Needs attention'}
                        </strong>
                        <span>
                          {blockers.length === 0
                            ? operations
                              ? `${operations.queues.queuedReady} queued · ${operations.queues.dueNow} eligible · ${campaign.inSequenceCount} in sequence`
                              : 'Reading current delivery state…'
                            : `${blockers[0]!.title}: ${blockers[0]!.detail}`}
                        </span>
                      </div>
                      {blockers.length > 1 && (
                        <span className="li-chip">{blockers.length - 1} more</span>
                      )}
                    </div>
                  )}

                  {open && (
                    <div
                      className="mgr-campaign-section-list"
                      role="group"
                      aria-label="Campaign details"
                    >
                      {(
                        [
                          [
                            'execution',
                            'Execution',
                            operations
                              ? `${operations.queues.queuedReady} queued · ${operations.queues.heldForReview} held`
                              : 'Pipeline, backlog and waves'
                          ],
                          [
                            'delivery',
                            'Delivery',
                            warmup && warmup.fraction < 1
                              ? `${Math.round(warmup.fraction * 100)}% today`
                              : 'Accounts, workflow and limits'
                          ],
                          [
                            'settings',
                            'Settings',
                            `${campaign.priority} priority · schedule · exclusions`
                          ],
                          [
                            'leads',
                            'Leads',
                            `${plural(campaign.memberCount, 'lead')} · ${campaign.inSequenceCount} in sequence`
                          ]
                        ] as const
                      ).map(([section, label, detail]) => {
                        const sectionKey = `${campaign.id}:${section}`;
                        const sectionOpen = openCampaignSection === sectionKey;
                        return (
                          <button
                            className="mgr-campaign-section-toggle"
                            type="button"
                            aria-expanded={sectionOpen}
                            key={section}
                            onClick={() => setOpenCampaignSection(sectionOpen ? '' : sectionKey)}
                          >
                            {sectionOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            <span>{label}</span>
                            <small>{detail}</small>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {open && openCampaignSection === `${campaign.id}:execution` && (
                    <div className="mgr-operations">
                      <h4>Execution pipeline</h4>
                      <p className="li-hint">
                        Sequence eligibility, planner allocation, scheduling and browser execution
                        are separate states.
                      </p>
                      <div className="li-stat-grid">
                        <div>
                          <span>Eligible · not allocated</span>
                          <strong>{operations?.queues.dueNow ?? 0}</strong>
                        </div>
                        <div>
                          <span>Queued · due for executor</span>
                          <strong>{operations?.queues.queuedReady ?? 0}</strong>
                        </div>
                        <div>
                          <span>Scheduled later</span>
                          <strong>{operations?.queues.scheduledFuture ?? 0}</strong>
                        </div>
                        <div>
                          <span>Executing now</span>
                          <strong>{operations?.queues.executing ?? 0}</strong>
                        </div>
                        <div>
                          <span>Held for review</span>
                          <strong>{operations?.queues.heldForReview ?? 0}</strong>
                        </div>
                        <div>
                          <span>Completed</span>
                          <strong>{campaign.completedCount}</strong>
                        </div>
                      </div>

                      <div className="mgr-callout">
                        <strong>What is preventing progress right now?</strong>
                        {blockers.length === 0 ? (
                          <p className="li-hint">No blocking condition is currently detected.</p>
                        ) : (
                          <ul>
                            {blockers.map((blocker, index) => (
                              <li key={`${blocker.title}-${index}`}>
                                <b>{blocker.title}:</b> {blocker.detail}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="li-stat-grid">
                        <div>
                          <span>Total audience</span>
                          <strong>{campaign.memberCount}</strong>
                        </div>
                        <div>
                          <span>Pending / not admitted</span>
                          <strong>{campaign.pendingCount}</strong>
                        </div>
                        <div>
                          <span>In sequence</span>
                          <strong>{campaign.inSequenceCount}</strong>
                        </div>
                        <div>
                          <span>Waiting on condition</span>
                          <strong>{campaign.waitingCount}</strong>
                        </div>
                        <div>
                          <span>Manual checkpoint</span>
                          <strong>{campaign.manualCount}</strong>
                        </div>
                        <div>
                          <span>Replied</span>
                          <strong>{campaign.repliedCount}</strong>
                        </div>
                        <div>
                          <span>Completed</span>
                          <strong>{campaign.completedCount}</strong>
                        </div>
                        <div>
                          <span>Failed</span>
                          <strong>{campaign.failedCount}</strong>
                        </div>
                        <div>
                          <span>Excluded</span>
                          <strong>{campaign.excludedCount}</strong>
                        </div>
                        <div>
                          <span>Paused leads</span>
                          <strong>{campaign.pausedCount}</strong>
                        </div>
                      </div>
                      {operations ? (
                        <>
                          <h4>Queue and backlog</h4>
                          <div className="li-stat-grid">
                            <div>
                              <span>Due now</span>
                              <strong>{operations.queues.dueNow}</strong>
                            </div>
                            <div>
                              <span>Scheduled next 24h</span>
                              <strong>{operations.queues.scheduledToday}</strong>
                            </div>
                            <div>
                              <span>Waiting for connection</span>
                              <strong>{operations.queues.waitingForConnection}</strong>
                            </div>
                            <div>
                              <span>Waiting for reply</span>
                              <strong>{operations.queues.waitingForReply}</strong>
                            </div>
                            <div>
                              <span>Other waits</span>
                              <strong>{operations.queues.waitingOther}</strong>
                            </div>
                            <div>
                              <span>Held by pause</span>
                              <strong>{operations.queues.held}</strong>
                            </div>
                            <div>
                              <span>Blocked</span>
                              <strong>{operations.queues.blocked}</strong>
                            </div>
                            <div>
                              <span>Failed</span>
                              <strong>{operations.queues.failed}</strong>
                            </div>
                          </div>
                          {operations.queues.backlogByStep.length > 0 && (
                            <p className="li-hint">
                              Backlog by node:{' '}
                              {operations.queues.backlogByStep
                                .map((row) => `${row.stepId} ${row.due}/${row.count} due`)
                                .join(' · ')}
                            </p>
                          )}
                          {operationalAnalytics && (
                            <>
                              <h4>Why this campaign is moving at this speed</h4>
                              <p className="li-hint">{operationalAnalytics.bottlenecks.reason}</p>
                              {operationalAnalytics.admissionForecast.reasons.length > 0 && (
                                <p className="li-hint">
                                  Admission throttle:{' '}
                                  {operationalAnalytics.admissionForecast.reasons.join(' ')}
                                </p>
                              )}
                              <div className="li-stat-grid">
                                <div>
                                  <span>Audience</span>
                                  <strong>{operationalAnalytics.funnel.totalAudience}</strong>
                                </div>
                                <div>
                                  <span>Pending</span>
                                  <strong>{operationalAnalytics.funnel.pending}</strong>
                                </div>
                                <div>
                                  <span>In sequence</span>
                                  <strong>{operationalAnalytics.funnel.inSequence}</strong>
                                </div>
                                <div>
                                  <span>Invited</span>
                                  <strong>{operationalAnalytics.funnel.invited}</strong>
                                </div>
                                <div>
                                  <span>Accepted</span>
                                  <strong>{operationalAnalytics.funnel.accepted}</strong>
                                </div>
                                <div>
                                  <span>Messaged</span>
                                  <strong>{operationalAnalytics.funnel.messaged}</strong>
                                </div>
                                <div>
                                  <span>Replied</span>
                                  <strong>{operationalAnalytics.funnel.replied}</strong>
                                </div>
                                <div>
                                  <span>Overdue actions</span>
                                  <strong>{operationalAnalytics.bottlenecks.overdueActions}</strong>
                                </div>
                                <div>
                                  <span>Forecast acceptance</span>
                                  <strong>
                                    {operationalAnalytics.admissionForecast.acceptanceRate === null
                                      ? `learning (${operationalAnalytics.admissionForecast.acceptanceSampleSize}/20)`
                                      : `${Math.round(operationalAnalytics.admissionForecast.acceptanceRate * 100)}%${operationalAnalytics.admissionForecast.acceptanceConfidence95 ? ` (95% ${Math.round(operationalAnalytics.admissionForecast.acceptanceConfidence95.low * 100)}–${Math.round(operationalAnalytics.admissionForecast.acceptanceConfidence95.high * 100)}%)` : ''}`}
                                  </strong>
                                </div>
                                <div>
                                  <span>New-admission multiplier</span>
                                  <strong>
                                    {Math.round(
                                      operationalAnalytics.admissionForecast.throttle * 100
                                    )}
                                    %
                                  </strong>
                                </div>
                                <div>
                                  <span>InMail sent</span>
                                  <strong>{operationalAnalytics.channels.inmailSent}</strong>
                                </div>
                                <div>
                                  <span>InMail replies</span>
                                  <strong>{operationalAnalytics.channels.inmailReplied}</strong>
                                </div>
                                <div>
                                  <span>InMail failures</span>
                                  <strong>{operationalAnalytics.channels.inmailFailed}</strong>
                                </div>
                                <div>
                                  <span>Paid InMail credits</span>
                                  <strong>
                                    {operationalAnalytics.channels.inmailPaidCreditsUsed}
                                    {operationalAnalytics.channels.inmailPaidCreditCap === null
                                      ? ''
                                      : ` / ${operationalAnalytics.channels.inmailPaidCreditCap}`}
                                  </strong>
                                </div>
                                <div>
                                  <span>Enrichment credits</span>
                                  <strong>
                                    {operationalAnalytics.channels.enrichmentCreditsUsed}
                                    {operationalAnalytics.channels.enrichmentCreditCap === null
                                      ? ''
                                      : ` / ${operationalAnalytics.channels.enrichmentCreditCap}`}
                                  </strong>
                                </div>
                                <div>
                                  <span>Emails found</span>
                                  <strong>
                                    {operationalAnalytics.channels.enrichmentFound} /{' '}
                                    {operationalAnalytics.channels.enrichmentAttempts}
                                  </strong>
                                </div>
                                <div>
                                  <span>Email replies</span>
                                  <strong>{operationalAnalytics.channels.emailReplied}</strong>
                                </div>
                              </div>
                              {operationalAnalytics.steps.length > 0 && (
                                <p className="li-hint">
                                  Step health:{' '}
                                  {operationalAnalytics.steps
                                    .map(
                                      (row) =>
                                        `${row.workflowStepId}: ${row.executed} done · ${row.skipped} skipped · ${row.failed} failed · ${row.overdue} overdue${row.outcomeRate === null ? '' : ` · ${Math.round(row.outcomeRate * 100)}% settled`}${row.slaMissRate === null ? '' : ` · SLA ${Math.round(row.slaMissRate * 100)}% missed (${row.slaMissed}/${row.slaMeasured})`}${row.medianDelayVsIntendedMinutes === null ? '' : ` · median ${Math.round(row.medianDelayVsIntendedMinutes)}m vs intended`}`
                                    )
                                    .join(' | ')}
                                </p>
                              )}
                              {operationalAnalytics.variants.length > 0 && (
                                <p className="li-hint">
                                  Variant outcomes:{' '}
                                  {operationalAnalytics.variants
                                    .map((row) => {
                                      const rates = [
                                        row.acceptanceRate === null
                                          ? ''
                                          : `${Math.round(row.acceptanceRate * 100)}% accepted`,
                                        row.replyRate === null
                                          ? ''
                                          : `${Math.round(row.replyRate * 100)}% replied`
                                      ]
                                        .filter(Boolean)
                                        .join(' · ');
                                      return `${row.workflowStepId}/${row.variantId.toUpperCase()}: ${row.sent} sent${rates ? ` · ${rates}` : ''} · ${row.eligibleForWinner ? 'enough sample to compare' : 'learning (<20 sends)'}`;
                                    })
                                    .join(' | ')}
                                </p>
                              )}
                              {operationalAnalytics.senders.length > 0 && (
                                <p className="li-hint">
                                  Sender allocation:{' '}
                                  {operationalAnalytics.senders
                                    .map((row) => {
                                      const rates = [
                                        row.acceptanceRate === null
                                          ? ''
                                          : `${Math.round(row.acceptanceRate * 100)}% accepted`,
                                        row.replyRate === null
                                          ? ''
                                          : `${Math.round(row.replyRate * 100)}% replied`,
                                        row.allocationShare === null
                                          ? ''
                                          : `${Math.round(row.allocationShare * 100)}% of executed work`
                                      ]
                                        .filter(Boolean)
                                        .join(' · ');
                                      return `${seatLabel(row.seatKey)} ${row.executed} actions · ${row.safetyBlocks} safety blocks${rates ? ` · ${rates}` : ''}`;
                                    })
                                    .join(' | ')}
                                </p>
                              )}
                            </>
                          )}
                          <h4>Admission waves</h4>
                          {operations.waves.length === 0 ? (
                            <p className="empty-copy">
                              No wave has been admitted yet. Pending leads remain untouched until
                              capacity is available.
                            </p>
                          ) : (
                            <div className="mgr-wave-list">
                              {operations.waves.map((wave) => (
                                <article className="mgr-wave" key={wave.id}>
                                  <strong>Wave {wave.ordinal}</strong> ·{' '}
                                  {plural(wave.memberCount, 'lead')} ·{' '}
                                  {new Date(wave.admittedAt).toLocaleString()}
                                  {' · '}
                                  <button
                                    type="button"
                                    className="li-mini-button"
                                    onClick={() =>
                                      setWaveFilterByCampaign((current) => ({
                                        ...current,
                                        [campaign.id]:
                                          current[campaign.id] === wave.ordinal
                                            ? null
                                            : wave.ordinal
                                      }))
                                    }
                                  >
                                    {waveFilterByCampaign[campaign.id] === wave.ordinal
                                      ? 'Show all leads'
                                      : 'Filter leads to wave'}
                                  </button>
                                  <p className="li-hint">
                                    Backlog {wave.backlog ?? 0} · accepted{' '}
                                    {wave.acceptanceRate === null ||
                                    wave.acceptanceRate === undefined
                                      ? '—'
                                      : `${Math.round(wave.acceptanceRate * 100)}%`}{' '}
                                    · replies{' '}
                                    {wave.replyRate === null || wave.replyRate === undefined
                                      ? '—'
                                      : `${Math.round(wave.replyRate * 100)}%`}{' '}
                                    · failures{' '}
                                    {wave.failureRate === null || wave.failureRate === undefined
                                      ? '—'
                                      : `${Math.round(wave.failureRate * 100)}%`}
                                  </p>
                                  {wave.admissionReason && (
                                    <p className="li-hint">{wave.admissionReason}</p>
                                  )}
                                  {wave.stepFunnel && wave.stepFunnel.length > 0 && (
                                    <p className="li-hint">
                                      {wave.stepFunnel
                                        .map(
                                          (row) =>
                                            `${row.stepId}: ${row.sent}/${row.planned} sent${row.accepted ? ` · ${row.accepted} accepted` : ''}${row.replied ? ` · ${row.replied} replied` : ''}${row.failed ? ` · ${row.failed} failed` : ''}${row.medianMinutesFromAdmission === null ? '' : ` · median ${Math.round(row.medianMinutesFromAdmission)}m from admission`}${row.medianQueueLatencyMinutes === null ? '' : ` · ${Math.round(row.medianQueueLatencyMinutes)}m queue latency`}`
                                        )
                                        .join(' | ')}
                                    </p>
                                  )}
                                </article>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="empty-copy">Loading queue and wave details…</p>
                      )}
                    </div>
                  )}

                  {open && openCampaignSection === `${campaign.id}:delivery` && (
                    <div className="mgr-operations">
                      <div className="li-stat-grid">
                        <div>
                          <span>Sends from</span>
                          <strong>{campaign.senderKeys.map(seatLabel).join(', ')}</strong>
                        </div>
                        <div>
                          <span>Workflow</span>
                          <strong>
                            {workflow
                              ? `${workflow.name}${campaign.workflowVersion === null ? '' : ` · v${campaign.workflowVersion}`}`
                              : 'Workflow unavailable'}
                          </strong>
                        </div>
                        <div>
                          <span>Pacing</span>
                          <strong>
                            {warmup && warmup.fraction < 1
                              ? `Warm-up ${warmup.day}/${warmup.days} · ${Math.round(warmup.fraction * 100)}%`
                              : warmup
                                ? 'Full speed'
                                : campaign.status === 'draft'
                                  ? 'Starts on launch'
                                  : 'Allowance unavailable'}
                          </strong>
                        </div>
                      </div>
                      {ceilings ? (
                        <>
                          <h4>Daily ceilings</h4>
                          <p className="mgr-warmup">
                            <Allowance
                              ceilings={ceilings}
                              of={warmup && warmup.fraction < 1 ? 'today' : 'full'}
                            />
                            <Hint label="How are these delivery limits chosen?">
                              The invite ceiling is {ceilingSourceNote(ceilings.invite)}. These
                              numbers are maximums for the day, not remaining capacity.
                            </Hint>
                          </p>
                          {operations && (
                            <CapacityBreakdown
                              ceilings={ceilings}
                              allocated={operations.queues.allocatedCampaignDay}
                            />
                          )}
                        </>
                      ) : (
                        <p className="empty-copy">Current delivery limits are unavailable.</p>
                      )}
                    </div>
                  )}

                  {open && openCampaignSection === `${campaign.id}:settings` && (
                    <div className="mgr-operations">
                      <section className="mgr-settings-block">
                        <h4>Priority</h4>
                        <div className="li-filter-row">
                          <label>
                            Campaign priority
                            <Select
                              value={campaign.priority}
                              disabled={busy !== ''}
                              onChange={(event) =>
                                void setCampaignPriority(
                                  campaign,
                                  event.target.value as ManagedCampaign['priority']
                                )
                              }
                            >
                              <option value="low">Low</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                            </Select>
                          </label>
                          <p className="li-hint">
                            Priority allocates remaining sender capacity; it never raises a safety
                            ceiling.
                          </p>
                        </div>
                      </section>
                      <CampaignScheduleEditor
                        campaign={campaign}
                        timezone={
                          seats.find((seat) => seat.seatKey === campaign.seatKey)?.timezone ?? 'UTC'
                        }
                        busy={busy !== ''}
                        onSave={(schedule) => saveCampaignSchedule(campaign, schedule)}
                      />
                      <CampaignExclusionEditor
                        campaign={campaign}
                        lists={lists}
                        busy={busy !== ''}
                        onSave={(policy) => saveCampaignExclusions(campaign, policy)}
                      />
                    </div>
                  )}

                  {open && openCampaignSection === `${campaign.id}:leads` && (
                    <CampaignMembers
                      members={
                        waveFilterByCampaign[campaign.id]
                          ? members.filter(
                              (member) => member.waveOrdinal === waveFilterByCampaign[campaign.id]
                            )
                          : members
                      }
                      steps={campaignSteps}
                      now={now}
                      busy={busy}
                      onPause={(member) => void setMemberPaused(member, true)}
                      onResume={(member) => void setMemberPaused(member, false)}
                      onRemove={(member) => void removeMember(member)}
                      timelines={timelinesByMember}
                      onLoadTimeline={loadMemberTimeline}
                      onSkip={(member) => void skipMember(member)}
                      onEnd={(member) => void endMember(member)}
                      onRerunCondition={(member, stepId) =>
                        void rerunMemberCondition(member, stepId)
                      }
                      onResumeAtStep={(member, stepId) => void resumeMemberAtStep(member, stepId)}
                      onResolveUnknown={(member, event, resolution) =>
                        void resolveUnknownOutcome(member, event, resolution)
                      }
                      followUpCampaigns={campaigns.filter(
                        (candidate) =>
                          candidate.id !== campaign.id &&
                          !['stopped', 'completed'].includes(candidate.status)
                      )}
                      onBulkRetry={(memberIds) => void retrySelectedFailures(campaign, memberIds)}
                      onMoveSelected={(targetCampaignId, memberIds) =>
                        void moveSelectedMembers(campaign, targetCampaignId, memberIds)
                      }
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
                <Select
                  value={campaignFilter}
                  onChange={(event) => setCampaignFilter(event.target.value)}
                >
                  <option value="">All campaigns</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                LinkedIn account
                <Select value={seatFilter} onChange={(event) => pickSeatFilter(event.target.value)}>
                  <option value="">All accounts</option>
                  {seats.map((seat) => (
                    <option key={seat.seatKey} value={seat.seatKey}>
                      {seat.label}
                    </option>
                  ))}
                </Select>
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
                                          <Copy size={14} />{' '}
                                          {task.taskKind === 'comment'
                                            ? 'Copy comment'
                                            : 'Copy message'}
                                        </button>
                                      )}
                                      {task.taskKind === 'comment' && task.postUrl ? (
                                        <a
                                          className="secondary-button"
                                          href={task.postUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          Open post to comment
                                        </a>
                                      ) : (
                                        <a className="secondary-button" href="/outreach/inbox">
                                          <Inbox size={14} /> Send it in the inbox
                                        </a>
                                      )}
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
                  It stays in the list as stopped until you choose Delete. A stopped campaign cannot
                  be started again; build a new one when you want this list to run.
                </p>
              </>
            ) : (
              <>
                <p>
                  Every lead still in this campaign stops where they are, and any queued action that
                  has not started is cancelled.
                </p>
                <p>
                  A stopped campaign cannot be started again — you can delete it afterwards, or
                  create a new campaign. To pick it up later, pause it instead.
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

      {deleting && (
        <ConfirmDrawer
          title={`Delete “${deleting.name}”?`}
          body={
            <>
              <p>
                This permanently removes the campaign and its lead progress from Campaigns. It
                cannot be undone.
              </p>
              <p>
                Running, paused and draft campaigns cannot be deleted. Cancel or stop them first.
                Actions that already reached LinkedIn remain in historical results.
              </p>
            </>
          }
          confirmLabel="Delete campaign"
          tone="danger"
          busy={busy === `campaign:${deleting.id}`}
          onConfirm={() => void deleteCampaign(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
