import type { CampaignQueueSummary } from '../server/linkedin/managed-campaigns';
import type { LinkedInCampaignExecution } from '../server/linkedin/execution-state';
import type { LinkedInCompanionStatus, LinkedInWorkerStatus } from './api';

/* ---------------------------------------------------------------------------
 * ONE SENTENCE, AND IT HAS TO BE THE TRUE ONE.
 *
 * The campaign card prints a single headline for "needs attention", so whatever
 * this returns first is, in practice, the entire explanation an operator gets.
 * It used to be "N planned action(s) have reached their scheduled time and are
 * waiting for the LinkedIn executor to claim them" for every one of the states
 * below, which is the one sentence that is almost never the reason: it is true
 * of a ROW (nobody has claimed it) and says nothing about WHY nobody has.
 *
 * Live example this ladder was written against: companion online, browser
 * opening fine, 18 profile views due, seat resting until 13:52 Zurich after a
 * sitting in which every action was refused with `day-over-day-delta:
 * Previous business day carried 0 profile_view(s), so today's ceiling is 1`,
 * and 5 invites parked on an unknown outcome. The old banner said "waiting for
 * browser worker: 20 planned action(s)" -- wrong about the worker, wrong about
 * the count, and silent about all three real reasons.
 *
 * THE ORDER IS THE POINT, so each rung says why it outranks the next:
 *
 *  1. COMPANION OFFLINE / NOT PAIRED. No browser exists. Every other state
 *     below is a statement about what a browser WOULD do, so naming any of
 *     them first would send an operator to fix a rule when the machine that
 *     obeys it is not there.
 *  2. RECOVERY CHROME OPEN. A visible window is waiting for a person to finish
 *     signing in, and Trevra deliberately keeps background execution paused
 *     while it is open (including after the session verifies, until the window
 *     closes). It outranks the cooldown and the gate because it is the one
 *     state a human can end right now, and because nothing else can run until
 *     it ends. It ranks below (1) only in principle: an open recovery requires
 *     a heartbeat inside the same 90s window that makes a device "online", so
 *     in practice the two are mutually exclusive.
 *  3. AUTONOMOUS COOLDOWN. The seat finished a sitting and is resting.
 *     Everything is healthy and the wait is deliberate -- Trevra spaces
 *     sittings so the account does not look like a scheduler -- so this must
 *     not read as a fault, and it outranks the gate because the gate will not
 *     even be consulted until the break ends.
 *  4. THE SAFETY GATE IS REFUSING. The worker will open the browser and be
 *     told no, by a named check with its own number. This is the state most
 *     often mistaken for a broken worker, and it is the one an operator can
 *     act on (or, more usually, must simply wait out) once it has a name.
 *  5. ROWS PARKED ON AN UNRESOLVED OUTCOME. They were claimed, the outcome
 *     could not be read back, and no browser will ever take them again --
 *     re-running one can put a second invite in somebody's notifications. It
 *     is last of the real states because it blocks only itself: the rest of
 *     the queue keeps moving. It is also EXCLUDED from the due count, which is
 *     where two of the twenty phantom "waiting" actions came from.
 *  6. GENUINELY UNCLAIMED. Everything above is fine and the row is simply
 *     waiting its turn -- the original message, now printed only when it is
 *     the true one.
 *
 * The first four rungs are facts the browser holds (a live device heartbeat,
 * this process's readiness) or facts only the database holds (the cooldown
 * column, the gate verdict), which is why the ladder is assembled here and the
 * database half arrives as `execution` from `execution-state.ts`.
 * ------------------------------------------------------------------------ */

export type CampaignExecutionBlockerKind =
  | 'companion-offline'
  | 'recovery-open'
  | 'session-attention'
  | 'executor-unknown'
  | 'executor-not-ready'
  | 'seat-cooldown'
  | 'safety-gate'
  | 'awaiting-outcome-resolution'
  | 'unclaimed';

export interface CampaignExecutionBlocker {
  kind: CampaignExecutionBlockerKind;
  title: string;
  detail: string;
}

export interface CampaignExecutionBlockerInput {
  /** The accounts this campaign sends from. A recovery on another seat is not this campaign's blocker. */
  senderKeys: readonly string[];
  queues: CampaignQueueSummary | null;
  /** Absent until the campaign card is opened, or when the read failed. */
  execution: LinkedInCampaignExecution | null;
  workerStatus: LinkedInWorkerStatus | null;
  companionStatus: LinkedInCompanionStatus | null;
  /** Milliseconds. The cooldown is a deadline, so it needs a clock to be judged against. */
  now: number;
}

/** The noun an operator uses for each ledger kind, for sentences about them. */
const KIND_NOUN: Record<string, string> = {
  invite: 'invite',
  dm: 'message',
  reply: 'reply',
  inmail: 'InMail',
  profile_view: 'profile view',
  follow: 'follow',
  unfollow: 'unfollow',
  disconnect: 'disconnection',
  company_follow: 'company follow',
  company_like: 'company post like',
  company_invite_follow: 'company follow invite',
  event_invite: 'event invite',
  group_invite: 'group invite',
  group_message: 'group message',
  event_message: 'event message',
  like: 'like',
  endorse: 'endorsement'
};

function noun(kind: string | null): string {
  return (kind && KIND_NOUN[kind]) || 'action';
}

/** 'profile view' -> 'Profile-view', so a title reads as one thing rather than two words. */
function titleKind(kind: string | null): string {
  const word = noun(kind).replaceAll(' ', '-');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The clock an operator would read off the wall NEXT TO THE ACCOUNT, not the
 * one on their own desk. A cooldown is a fact about the seat's day -- its
 * working window, its rhythm -- and "until 11:52" is a different and confusing
 * instruction to somebody sitting two zones away from the account.
 */
export function seatLocalTime(iso: string, timezone: string | null): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  try {
    return new Intl.DateTimeFormat('en-GB', {
      ...options,
      ...(timezone ? { timeZone: timezone } : {})
    }).format(at);
  } catch {
    // An unknown IANA name on an old runtime is not a reason to print nothing.
    return new Intl.DateTimeFormat('en-GB', options).format(at);
  }
}

/**
 * What to call the check that refused, in the operator's words rather than the
 * gate's identifier. The gate's own `detail` still carries the numbers -- it is
 * written for exactly this reader -- so this only has to supply the headline.
 */
function gateTitle(check: string | null, kind: string | null): string {
  const subject = titleKind(kind);
  switch (check) {
    case 'seat-configured':
      return 'No LinkedIn account configured';
    case 'seat-paused':
      return 'LinkedIn account paused';
    case 'suppression':
      return 'Next lead is suppressed';
    case 'warmup-ceiling':
      return `${subject} blocked by account warm-up`;
    case 'campaign-warmup':
      return `${subject} blocked by the campaign ramp`;
    case 'rolling-24h':
      return `${subject} daily safety ceiling reached`;
    case 'rolling-7d':
      return `${subject} 7-day safety ceiling reached`;
    case 'rolling-30d':
      return `${subject} 30-day safety ceiling reached`;
    case 'day-over-day-delta':
      return `${subject} safety ceiling reached`;
    case 'acceptance-rate':
      return 'Invite acceptance rate is below the floor';
    case 'business-hours':
      return "Outside this account's working hours";
    case 'weekend':
      return "Outside this account's working days";
    case 'inmail-monthly-quota':
      return 'InMail quota exhausted';
    case 'pending-invite-backlog':
      return 'Pending-invite backlog is full';
    case 'duplicate-target':
      return `${subject} already logged against this person`;
    default:
      return `${subject} refused by the safety gate`;
  }
}

/**
 * The single true reason this campaign is not executing, or null when it is.
 *
 * Returns nothing at all when there is neither claimable work nor a parked row:
 * a queue with nothing due is not blocked, it is finished for now, and the card
 * already says so.
 */
export function campaignExecutionBlocker(
  input: CampaignExecutionBlockerInput
): CampaignExecutionBlocker | null {
  const { execution, queues, workerStatus, companionStatus } = input;
  // `queuedReady` is the number the rest of the card prints, and both counts
  // now exclude rows parked on an unresolved outcome, so the headline cannot
  // claim more work is waiting than the card shows.
  const due = queues?.queuedReady ?? execution?.dueNow ?? 0;
  const parked = execution?.awaitingResolution ?? 0;
  if (due <= 0 && parked <= 0) return null;

  const seatLabel = execution?.seatLabel ?? 'This LinkedIn account';
  const devices = companionStatus?.devices ?? [];
  const onlineCompanion = devices.some((device) => device.online);
  const seatRecovery = companionStatus?.recoveries.find((recovery) =>
    input.senderKeys.includes(recovery.seatKey)
  );
  const seatAttention = companionStatus?.attention.find((attention) =>
    input.senderKeys.includes(attention.seatKey)
  );

  // (1) No browser exists. Only claimed when the deployment actually executes
  // through a paired computer -- on a local install there is no companion to be
  // offline, and saying otherwise would send a self-hoster looking for a
  // pairing screen they never needed.
  if (workerStatus?.companionBrowser && !onlineCompanion)
    return devices.length === 0
      ? {
          kind: 'companion-offline',
          title: 'No paired computer',
          detail: `${due} planned action(s) are due, but no computer is paired with this workspace, so no browser can claim them.`
        }
      : {
          kind: 'companion-offline',
          title: 'Paired computer / companion offline',
          detail: `${due} planned action(s) are due, but the paired computer is not currently connected to Trevra, so no browser can claim them.`
        };

  // (2) A visible Chrome window is waiting for a person. Both halves of the
  // recovery state machine are kept: a VERIFIED session still holds background
  // execution until the window is closed, and an operator who is not told that
  // reasonably concludes Trevra is stuck.
  if (seatRecovery)
    return {
      kind: 'recovery-open',
      title:
        seatRecovery.status === 'verified'
          ? 'LinkedIn recovered — recovery window still open'
          : 'LinkedIn recovery in progress',
      detail:
        seatRecovery.status === 'verified'
          ? `${due} planned action(s) are due. The LinkedIn session is healthy, but Trevra intentionally keeps background execution paused until the visible recovery Chrome window closes.`
          : `${due} planned action(s) are due, but the visible recovery window is still completing sign-in or verification. No campaign action can run until recovery finishes.`
    };

  if (seatAttention)
    return {
      kind: 'session-attention',
      title:
        seatAttention.kind === 'challenge'
          ? 'LinkedIn needs human verification'
          : 'LinkedIn session needs reconnect',
      detail: `${due} planned action(s) are due, but the account session is not ready. ${seatAttention.message}`
    };

  if (!workerStatus)
    return {
      kind: 'executor-unknown',
      title: 'Executor status unavailable',
      detail: `${due} planned action(s) are due, but Trevra could not read browser-worker status.`
    };

  if (!workerStatus.ready)
    return {
      kind: 'executor-not-ready',
      title: 'LinkedIn executor not ready',
      detail: `${due} planned action(s) are due. ${workerStatus.blockers.join(' ') || 'The browser worker is not ready.'}`
    };

  // (3) Healthy, and deliberately resting. Worded so it does not read as a
  // fault: this is the rate control that keeps the account from looking like a
  // scheduler, and it ends by itself.
  if (execution?.restingUntil && new Date(execution.restingUntil).getTime() > input.now) {
    const until = seatLocalTime(execution.restingUntil, execution.timezone);
    return {
      kind: 'seat-cooldown',
      title: `Autonomous cooldown until ${until}`,
      detail: `${due} planned action(s) are due. ${seatLabel} finished a sitting and rests until ${until}${execution.timezone ? ` ${execution.timezone}` : ''} before opening the browser again, so the account is not driven at a constant rate. Nothing is wrong and no action is needed.`
    };
  }

  // (4) The browser would open and be refused. The gate's own sentence carries
  // the numbers; the check name is kept in the text because it is what a
  // support conversation and the worker's log line have in common.
  if (execution?.gate && !execution.gate.allowed)
    return {
      kind: 'safety-gate',
      title: gateTitle(execution.gate.check, execution.gate.kind),
      detail: `${due} planned action(s) are due, but the safety gate refuses the next one${
        execution.gate.check ? ` (${execution.gate.check})` : ''
      }: ${execution.gate.detail ?? 'the safety gate refused it.'} The queue resumes by itself once that stops binding.`
    };

  // (5) Waiting for a person, not for a browser -- and only ever the headline
  // when nothing else is due, because the rest of the queue is unaffected.
  if (due <= 0 && parked > 0) return parkedBlocker(execution, parked);

  return {
    kind: 'unclaimed',
    title: 'Waiting for browser worker',
    detail: `${due} planned action(s) have reached their scheduled time and are waiting for the LinkedIn executor to claim them.`
  };
}

/**
 * The parked rows as their own entry, so they are visible even when something
 * else is the headline. `campaignExecutionBlocker` returns the identical object
 * when they are the only thing left, and the caller drops the duplicate.
 */
export function awaitingResolutionBlocker(
  execution: LinkedInCampaignExecution | null
): CampaignExecutionBlocker | null {
  if (!execution || execution.awaitingResolution <= 0) return null;
  return parkedBlocker(execution, execution.awaitingResolution);
}

function parkedBlocker(
  execution: LinkedInCampaignExecution | null,
  parked: number
): CampaignExecutionBlocker {
  const word = noun(execution?.awaitingResolutionKind ?? null);
  return {
    kind: 'awaiting-outcome-resolution',
    title: `${plural(parked, word)} awaiting outcome resolution`,
    detail: `These were claimed and their outcome could not be read back, so Trevra parked them for you to resolve rather than risk repeating them. No browser will pick them up, and they are not counted as waiting for the executor.`
  };
}
