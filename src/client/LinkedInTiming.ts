import type { LinkedInQueueWaitReason } from './api';

export const MAINTENANCE_TASK_LABELS = {
  inbox: 'Inbox sync',
  pending_invites: 'Pending invites',
  acceptance: 'Acceptance checks',
  withdrawals: 'Withdrawal queue',
  lead_sources: 'Lead sourcing'
} as const;

const QUEUE_WAIT_COPY: Record<LinkedInQueueWaitReason, string> = {
  computer: 'Waiting for your paired computer',
  account_paused: 'Waiting for this LinkedIn account to be resumed',
  account_cooldown: 'Waiting for this LinkedIn account to leave cooldown',
  worker: 'Waiting for LinkedIn execution to be available'
};

export function queueWaitCopy(reason: LinkedInQueueWaitReason | null | undefined): string | null {
  return reason ? QUEUE_WAIT_COPY[reason] : null;
}

/**
 * The waits the reply composer offers, because "in a bit" is how a person
 * actually schedules a message -- an exact instant is the other, rarer half and
 * has a control of its own.
 */
export const DELAY_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 60 * 8, label: '8 hours' },
  { minutes: 60 * 24, label: '1 day' },
  { minutes: 60 * 24 * 2, label: '2 days' },
  { minutes: 60 * 24 * 7, label: '1 week' }
];

export type ScheduleMode = 'now' | 'in' | 'at';

/**
 * The instant a queued reply is for, out of what the composer is showing.
 *
 * 'now' RETURNS NULL, and that is not the same as `new Date()`: the route's own
 * default is the next slot the pacer will take, and sending this browser's
 * clock instead would answer a question the browser is not the authority on.
 *
 * 'in' is measured from the moment the button is PRESSED, not from when the
 * option was picked -- a wait chosen and then thought about for ten minutes is
 * still the wait that was asked for.
 *
 * 'at' is read as LOCAL time, which is what a `datetime-local` input holds and
 * what the person typing it means. A moment already gone is refused HERE rather
 * than sent to a gate that would read it as "send it immediately".
 */
export function plannedForFrom(
  mode: ScheduleMode,
  delayMinutes: number,
  sendAt: string,
  now: Date
): { at: Date | null; problem: string } {
  if (mode === 'now') return { at: null, problem: '' };
  if (mode === 'in') return { at: new Date(now.getTime() + delayMinutes * 60_000), problem: '' };
  if (!sendAt.trim()) {
    return {
      at: null,
      problem: 'Pick the date and time this should go out, or choose one of the other two.'
    };
  }
  const at = new Date(sendAt);
  if (Number.isNaN(at.getTime())) {
    return {
      at: null,
      problem: `'${sendAt}' is not a date and time this browser can read, so nothing was queued.`
    };
  }
  if (at.getTime() <= now.getTime()) {
    return {
      at: null,
      problem:
        'That moment has already passed. Pick one in the future, or queue it for the next slot.'
    };
  }
  return { at, problem: '' };
}

export function formatVisitWindow(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  timezone?: string | null
): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  }).format(start);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return `${day}, ${time.format(start)}–${time.format(end)} ${zone}`;
}
