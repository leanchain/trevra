import type { LinkedInQueueWaitReason } from './api';

export const MAINTENANCE_TASK_LABELS = {
  inbox: 'Inbox sync',
  pending_invites: 'Pending invites',
  acceptance: 'Acceptance checks',
  withdrawals: 'Withdrawal queue',
  lead_sources: 'Lead sourcing'
} as const;

export const QUEUE_WAIT_COPY: Record<LinkedInQueueWaitReason, string> = {
  computer: 'Waiting for your paired computer',
  account_paused: 'Waiting for this LinkedIn account to be resumed',
  account_cooldown: 'Waiting for this LinkedIn account to leave cooldown',
  worker: 'Waiting for LinkedIn execution to be available'
};

export function queueWaitCopy(reason: LinkedInQueueWaitReason | null | undefined): string | null {
  return reason ? QUEUE_WAIT_COPY[reason] : null;
}

export function formatVisitWindow(startIso: string | null | undefined, endIso: string | null | undefined, timezone?: string | null): string | null {
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

export function formatPlannedTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}
