import type { WorkflowDelay, WorkflowStep } from '../server/linkedin/workflows';
import type {
  CampaignQueueSummary,
  ManagedCampaignWave
} from '../server/linkedin/managed-campaigns';
import { seatLocalTime } from './LinkedInExecutionBlocker';

export const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
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

/* ---------------------------------------------------------------------------
 * "17 PENDING" WAS NOT ONE NUMBER.
 *
 * The step card printed the whole backlog of a step as "N pending", which an
 * operator reads as "N leads are stuck". The live campaign this was written
 * against showed:
 *
 *     1. View their profile        13 done   11 pending
 *     2. Send a connection request  0 done   17 pending
 *
 * and the operator asked, reasonably, whether 17 leads were really pending --
 * because they were not. Five had a claimed invite whose outcome could not be
 * read back and were parked for a HUMAN to resolve; no browser was ever going
 * to take them. The other twelve had a perfectly healthy profile view behind
 * them and an invite scheduled for the next day, because step 2 of their own
 * workflow declares `delayBefore: 1 day` -- a fact the operator did not know
 * was in their workflow, and which nothing on this screen said. The 11 on step
 * 1 were a third thing again: due now, and genuinely queued for the browser.
 *
 * So the breakdown names each wait for what it is and, for the scheduled ones,
 * says WHEN in the account's own timezone and WHAT they are waiting out. The
 * headline number stays COMPLETED work: that is what the big number has meant
 * since the card started leading with it, and a breakdown is not a reason to
 * take it back.
 *
 * Nothing here classifies anything. Every bucket is a column the server
 * counted (`backlogByStep`), and a lead these predicates cannot name lands in
 * `other`, printed plainly, rather than being folded into whichever bucket
 * looks closest.
 * ------------------------------------------------------------------------ */

export interface CampaignStepProgress {
  stepId: string;
  label: string;
  /** Completed work. The card's headline number, unchanged. */
  completed: number;
  /** Every lead sitting on this step, whatever it is waiting for. */
  pending: number;
  /** Sequence-eligible, including leads that are parked. Kept for callers that ask about planner demand. */
  due: number;
  /** Eligible and claimable: waiting for the browser worker, and only this. */
  dueNow: number;
  /** A browser worker holds the claim right now. */
  running: number;
  /** Waiting for a future slot. */
  scheduled: number;
  /** ISO-8601 UTC of the earliest of those slots, or null. */
  scheduledFrom: string | null;
  /** Parked on an unreadable outcome, waiting for a person. */
  awaitingDecision: number;
  /** Leads on this step that none of the four buckets above named. Normally zero. */
  other: number;
  /**
   * The gap this step declares before it runs, when that is plausibly what the
   * scheduled leads are waiting out. Null for a step with no gap, and null for
   * monitor/condition steps, whose wait is driven by whether the PROSPECT did
   * something -- naming a delay there would explain the wrong thing.
   */
  delayBefore: WorkflowDelay | null;
}

export function campaignStepProgress(
  steps: readonly WorkflowStep[],
  backlog: CampaignQueueSummary['backlogByStep'],
  waves: readonly ManagedCampaignWave[] = []
): CampaignStepProgress[] {
  const byStep = new Map(backlog.map((entry) => [entry.stepId, entry]));
  const completedByStep = new Map<string, number>();
  for (const wave of waves) {
    for (const funnel of wave.stepFunnel ?? []) {
      completedByStep.set(
        funnel.stepId,
        (completedByStep.get(funnel.stepId) ?? 0) + Number(funnel.sent ?? 0)
      );
    }
  }
  return steps.map((step) => {
    const entry = byStep.get(step.id);
    const pending = entry?.count ?? 0;
    const dueNow = entry?.dueNow ?? 0;
    const running = entry?.running ?? 0;
    const scheduled = entry?.scheduled ?? 0;
    const awaitingDecision = entry?.awaitingDecision ?? 0;
    const timed =
      step.action !== 'monitor' &&
      step.action !== 'condition' &&
      (step.delayBefore?.amount ?? 0) > 0;
    return {
      stepId: step.id,
      label: ACTION_LABEL[step.action],
      completed: completedByStep.get(step.id) ?? 0,
      pending,
      due: entry?.due ?? 0,
      dueNow,
      running,
      scheduled,
      scheduledFrom: entry?.scheduledFrom ?? null,
      awaitingDecision,
      // Never negative: an old server that does not send the breakdown would
      // otherwise make every lead on the step read as "in another state".
      other: Math.max(0, pending - dueNow - running - scheduled - awaitingDecision),
      delayBefore: timed ? (step.delayBefore ?? null) : null
    };
  });
}

export interface CampaignStepStateLine {
  kind: 'due-now' | 'running' | 'scheduled' | 'awaiting-decision' | 'other';
  text: string;
  /** True when the wait ends because a PERSON does something, not because the system does. */
  attention: boolean;
}

/** '1 day', '2 days', '12 hours' -- the step's own declared gap, in words. */
function delayLabel(delay: WorkflowDelay): string {
  const unit = delay.unit === 'days' ? 'day' : 'hour';
  return `${delay.amount} ${unit}${delay.amount === 1 ? '' : 's'}`;
}

/**
 * The calendar date this instant falls on FOR THE ACCOUNT, as `YYYY-MM-DD`.
 *
 * "Tomorrow" is a statement about the account's day, not the reader's: an
 * operator in New York looking at a Zurich seat must be told when the seat will
 * send, or the word is a lie by six hours.
 */
function seatDayKey(at: Date, timezone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  try {
    return new Intl.DateTimeFormat('en-CA', {
      ...options,
      ...(timezone ? { timeZone: timezone } : {})
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', options).format(at);
  }
}

function seatDateLabel(at: Date, timezone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  };
  try {
    return new Intl.DateTimeFormat('en-GB', {
      ...options,
      ...(timezone ? { timeZone: timezone } : {})
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(at);
  }
}

/** 'from 14:30', 'for tomorrow from 11:47', 'for Wed 26 Aug from 09:15'. */
function scheduledWhen(iso: string, timezone: string | null, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = seatLocalTime(iso, timezone);
  const days = Math.round(
    (Date.parse(`${seatDayKey(at, timezone)}T00:00:00Z`) -
      Date.parse(`${seatDayKey(new Date(now), timezone)}T00:00:00Z`)) /
      86_400_000
  );
  if (days <= 0) return `from ${time}`;
  if (days === 1) return `for tomorrow from ${time}`;
  return `for ${seatDateLabel(at, timezone)} from ${time}`;
}

/**
 * The step's backlog as one line per thing it is waiting for, in the order an
 * operator can do anything about them: the browser's queue first, then the
 * clock, then the one line that is their own to-do.
 *
 * A zero is not printed. "0 scheduled" is noise on a card that has four
 * possible lines and usually one true one, and a step with no waiting leads
 * returns nothing at all so the caller can say so in its own words.
 */
export function campaignStepStateLines(
  entry: CampaignStepProgress,
  stepIndex: number,
  options: { timezone: string | null; now: number }
): CampaignStepStateLine[] {
  const lines: CampaignStepStateLine[] = [];
  if (entry.dueNow > 0)
    lines.push({ kind: 'due-now', text: `${entry.dueNow} due now`, attention: false });
  if (entry.running > 0)
    lines.push({ kind: 'running', text: `${entry.running} sending now`, attention: false });
  if (entry.scheduled > 0) {
    const when = entry.scheduledFrom
      ? scheduledWhen(entry.scheduledFrom, options.timezone, options.now)
      : '';
    /*
     * NAMING THE DELAY IS THE POINT OF THIS LINE. A scheduled lead is not a
     * problem, so "12 scheduled" alone invites the operator to go looking for
     * one. The gap is declared in their own workflow, and until the card said
     * so there was nowhere on this screen it appeared.
     */
    const because = entry.delayBefore
      ? ` — this step waits ${delayLabel(entry.delayBefore)} after ${
          stepIndex === 0 ? 'a lead joins the campaign' : 'the step before it'
        }`
      : '';
    lines.push({
      kind: 'scheduled',
      text: `${entry.scheduled} scheduled${when ? ` ${when}` : ''}${because}`,
      attention: false
    });
  }
  if (entry.awaitingDecision > 0)
    lines.push({
      kind: 'awaiting-decision',
      text: `${entry.awaitingDecision} awaiting your decision`,
      attention: true
    });
  if (entry.other > 0)
    lines.push({ kind: 'other', text: `${entry.other} in another state`, attention: false });
  return lines;
}
