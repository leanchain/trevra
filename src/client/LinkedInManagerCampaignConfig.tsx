import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, LoaderCircle, Plus, Users, Workflow as WorkflowIcon } from 'lucide-react';
import {
  createLinkedInManagedCampaign,
  previewLinkedInManagedCampaign,
  getLinkedInLimits,
  getLinkedInCampaignMailboxes,
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  startLinkedInManagedCampaign,
  updateLinkedInCampaignMailbox,
  type CampaignMailbox,
  type LinkedInCeilingSource,
  type LinkedInLimitsReport
} from './api';
import { effectiveDailyCeiling } from '../server/linkedin/limits';
import { useActiveSeatKey } from './LinkedInActiveAccount';
import { LinkedInManagerLeadConfig } from './LinkedInManagerLeadConfig';
import { LinkedInManagerWorkflowConfig } from './LinkedInManagerWorkflowConfig';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { LinkedInWorkflow, WorkflowStep } from '../server/linkedin/workflows';
import type { CampaignLaunchPreview, ManagedCampaign } from '../server/linkedin/managed-campaigns';
import { errorMessage } from './LinkedInSafety';
import { useIsWorkspaceOwner } from './auth-client';

/**
 * Creating a campaign, with the consequences shown before the button.
 *
 * Three selects used to be the whole screen, and none of them said what would
 * happen: how many people get enrolled, who sends to them, how long the
 * sequence runs, or that day one is deliberately slow. The right-hand column
 * answers all four while the form is still being filled in, and the two things
 * that quietly produce a campaign that never sends -- an empty list, an
 * account with no working days -- are warned about BEFORE the create, not
 * discovered a day later.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zonedLocalToIso(value: string, timezone: string): string | null {
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
  const partsOf = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(instant));
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
  let instant = wallAsUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const shown = partsOf(instant);
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
  const roundTrip = partsOf(instant);
  if (
    roundTrip.year !== requested.year ||
    roundTrip.month !== requested.month ||
    roundTrip.day !== requested.day ||
    roundTrip.hour !== requested.hour ||
    roundTrip.minute !== requested.minute
  )
    return null;
  return new Date(instant).toISOString();
}

function minuteOfClock(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]),
    minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View their profile',
  connection_request: 'Send a connection request',
  message: 'Send a message',
  manual_message: 'A message you write yourself',
  follow: 'Follow them',
  unfollow: 'Unfollow them',
  disconnect: 'Remove the connection',
  follow_company: 'Follow their company',
  like_company_post: 'Like a company post',
  invite_to_follow_company: 'Invite them to follow a company',
  invite_to_event: 'Invite them to an event',
  invite_to_group: 'Invite them to a group',
  group_message: 'Message them from a group',
  event_message: 'Message them from an event',
  withdraw_pending: 'Withdraw the invite if still pending',
  like_post: 'Like a recent post',
  endorse_skills: 'Endorse selected skills',
  wait: 'Wait',
  condition: 'Check a condition',
  monitor: 'Monitor a condition',
  end: 'End this path',
  inmail: 'Send InMail',
  email: 'Send email',
  find_email: 'Find email',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  manual_comment: 'Manual comment checkpoint'
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const stepHours = (step: WorkflowStep) =>
  step.delayBefore.unit === 'days' ? step.delayBefore.amount * 24 : step.delayBefore.amount;

const ACTION_SHORT_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View',
  connection_request: 'Invite',
  message: 'Message',
  manual_message: 'Manual note',
  follow: 'Follow',
  unfollow: 'Unfollow',
  disconnect: 'Remove connection',
  follow_company: 'Company follow',
  like_company_post: 'Company like',
  invite_to_follow_company: 'Company invite',
  invite_to_event: 'Event invite',
  invite_to_group: 'Group invite',
  group_message: 'Group message',
  event_message: 'Event message',
  withdraw_pending: 'Withdraw',
  like_post: 'Like',
  endorse_skills: 'Endorse',
  wait: 'Wait',
  condition: 'If',
  monitor: 'Monitor',
  end: 'End',
  inmail: 'InMail',
  email: 'Email',
  find_email: 'Find email',
  add_tag: '+Tag',
  remove_tag: '-Tag',
  manual_comment: 'Manual comment'
};

const BOTTLENECK_LABEL: Readonly<Record<string, string>> = {
  profile_view: 'Profile view',
  invite: 'Connection request',
  dm: 'Message',
  follow: 'Follow',
  unfollow: 'Unfollow',
  disconnect: 'Remove connection',
  like: 'Like',
  endorse: 'Endorse'
};

/** A workflow's steps as a compact trail for the card picker: "View → Invite → wait 3d → Message". */
function chipTrail(workflow: LinkedInWorkflow): string {
  const parts: string[] = [];
  for (const step of workflow.steps) {
    const hours = stepHours(step);
    if (hours > 0) parts.push(hours % 24 === 0 ? `wait ${hours / 24}d` : `wait ${hours}h`);
    parts.push(ACTION_SHORT_LABEL[step.action]);
  }
  return parts.join(' → ');
}

/* ---------------------------------------------------------------------------
 * WHAT A CAMPAIGN IS ACTUALLY ALLOWED TO SEND.
 *
 * Shared with the campaign screen and living HERE rather than there because
 * `LinkedInManagerRead.tsx` already imports this panel in order to render it;
 * exporting from that file and importing back would close a module cycle for
 * the sake of tidier filing.
 * ------------------------------------------------------------------------ */

/** The four paced kinds a managed campaign can spend, in the order they are shown. */
const MANAGED_KINDS = ['invite', 'dm', 'profile_view', 'follow'] as const;
export type ManagedKind = (typeof MANAGED_KINDS)[number];

/**
 * The campaign-day ramp, READ from the server instead of restated on the client.
 *
 * This panel used to compute it -- `Math.max(0.2, day * 0.2)` -- and multiply
 * the operator's raw setting by it. Two things were wrong at once: the ramp
 * ignored the per-seat warm-up week, and the operator's setting is not the
 * ceiling, so the preview promised 6 invites and 5 messages on a day the gate
 * allowed 3 and 2. `campaignWarmupFractions` is the same array `guard.ts`
 * paces against, so there is one ramp with one definition again -- including
 * how many days it runs for, which is not this file's opinion either.
 */
export function rampFractions(report: LinkedInLimitsReport | null): readonly number[] | null {
  const fractions = report?.campaignWarmupFractions;
  return fractions && fractions.length > 0 ? fractions : null;
}

/** The fraction for a 1-based campaign day. Days past the ramp sit at its last value. */
export function rampFractionForDay(
  report: LinkedInLimitsReport | null,
  day: number
): number | null {
  const fractions = rampFractions(report);
  if (!fractions) return null;
  return fractions[Math.min(Math.max(1, Math.floor(day)), fractions.length) - 1];
}

export interface EnforcedCeiling {
  kind: ManagedKind;
  /** Trevra's researched band for this account's posture, per day. */
  band: number;
  /** The number the operator typed on Setup -> LinkedIn account, where one exists. */
  operator: number | null;
  /** What this account may send today once the campaign is past its ramp. */
  full: number;
  /** The same with the campaign-day ramp on top: what may go out today. */
  today: number;
  /** Which of the two numbers `full` was built from. */
  source: LinkedInCeilingSource;
}

/**
 * What the gate will actually let a campaign on this account do, per kind.
 *
 * NOTHING IS RECOMPUTED THAT THE SERVER ALREADY ANSWERED. `ceiling` on a day
 * row is the account's real per-day allowance -- band, the operator's own
 * setting, the band override, the per-seat warm-up week, the acceptance-rate
 * throttle and posture, all already applied -- so it is read, not rebuilt out
 * of parts on a screen that cannot see the ledger those parts came from.
 *
 * THE ONE THING THAT IS COMPUTED IS THE CAMPAIGN RAMP, and it is computed the
 * way `guard.ts` computes it: the campaign-day fraction multiplies the ceiling
 * BEFORE the per-seat warm-up week, because the two ramps are separate clocks
 * measuring separate risks and it is the stricter of the two that binds. That
 * resolved-before-the-week number is what `effectiveDailyCeiling` returns, so
 * the function itself is imported from `limits.ts` and called rather than
 * mirrored -- a copy of a policy is a copy that drifts, and this screen
 * printing a number the gate disagrees with is the whole defect.
 *
 * Returns null when the limits report has not arrived. NOTHING IS GUESSED IN
 * ITS PLACE -- an operator setting rendered as a ceiling is what this function
 * exists to end, so a caller with no report prints no number at all.
 */
export function enforcedCeilings(
  report: LinkedInLimitsReport | null,
  campaignFraction: number
): Record<ManagedKind, EnforcedCeiling> | null {
  if (!report) return null;
  const entries: Array<readonly [ManagedKind, EnforcedCeiling]> = [];
  for (const kind of MANAGED_KINDS) {
    const row = report.limits.find((limit) => limit.kind === kind && limit.window === 'day');
    if (!row) return null;
    const operator = row.operatorLimit ?? null;
    const beforeRamps = effectiveDailyCeiling(
      row.bandCeiling,
      operator,
      report.seat.safetyBandOverride
    );
    entries.push([
      kind,
      {
        kind,
        band: report.bands[kind].perDay,
        operator,
        full: row.ceiling,
        today: Math.min(row.ceiling, Math.floor(beforeRamps * campaignFraction)),
        source: row.ceilingSource ?? 'band'
      }
    ]);
  }
  return Object.fromEntries(entries) as Record<ManagedKind, EnforcedCeiling>;
}

/**
 * Where a ceiling came from, in the operator's words.
 *
 * "I typed 30 and it says 18" is the only question the number raises, so the
 * answer travels with it everywhere it is printed.
 */
export function ceilingSourceNote(ceiling: EnforcedCeiling): string {
  if (ceiling.source === 'operator-override') {
    return `your own number, which this account is set to use in place of Trevra’s researched band of ${ceiling.band} a day`;
  }
  if (ceiling.source === 'operator') {
    return `your own setting of ${ceiling.operator ?? ceiling.band}, stricter than Trevra’s researched band of ${ceiling.band} a day`;
  }
  return `Trevra’s researched band of ${ceiling.band} a day, the stricter of it and your setting${ceiling.operator === null ? '' : ` of ${ceiling.operator}`}`;
}

/** Everything needed to build the same campaign a second time, minus the name. */
interface CampaignPrefill {
  /** A suggested name. The operator edits it before creating. */
  name: string;
  seatKey: string;
  leadListId: string;
  workflowId: string;
}

/**
 * One in-memory handoff from the operating screen to the dedicated builder.
 *
 * A rebuild is a suggestion, not a write. Keeping it in memory means Back or a
 * reload cannot silently recreate an old campaign choice days later, while the
 * immediate navigation can carry the account/list/workflow the operator just
 * asked to reuse without putting implementation ids in the URL.
 */
let stagedCampaignPrefill: CampaignPrefill | null = null;

export function stageCampaignPrefill(prefill: CampaignPrefill): void {
  stagedCampaignPrefill = prefill;
}

export function takeStagedCampaignPrefill(): CampaignPrefill | null {
  const staged = stagedCampaignPrefill;
  stagedCampaignPrefill = null;
  return staged;
}

export function LinkedInManagerCampaignConfig({
  onChanged,
  setToast,
  onCreated,
  prefill
}: {
  onChanged: () => Promise<void>;
  setToast: (message: string) => void;
  /** Creation is a navigation boundary: show the new campaign instead of resetting this form in place. */
  onCreated?: (campaign: ManagedCampaign) => void;
  /** Fills the form from a finished campaign, so "run this list again" is one click. */
  prefill?: CampaignPrefill | null;
}) {
  /** The sending account is the universal Outreach selection made in Settings. */
  const [activeSeatKey] = useActiveSeatKey();
  const isWorkspaceOwner = useIsWorkspaceOwner();
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [mailboxes, setMailboxes] = useState<CampaignMailbox[]>([]);
  const [name, setName] = useState('');
  /** Whether the operator has typed into the name field. Until then it auto-fills from the list + workflow choice; the first keystroke stops that. */
  const [nameTouched, setNameTouched] = useState(false);
  const seatKey = activeSeatKey;
  const [listId, setListId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [showListUploader, setShowListUploader] = useState(false);
  const [showWorkflowStarters, setShowWorkflowStarters] = useState(false);
  const [showSendingDetails, setShowSendingDetails] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [senderKeys, setSenderKeys] = useState<string[]>(activeSeatKey ? [activeSeatKey] : []);
  const [mailboxAssignments, setMailboxAssignments] = useState<Record<string, string>>({});
  const [inmailCreditCap, setInmailCreditCap] = useState<number | ''>('');
  const [enrichmentCreditCap, setEnrichmentCreditCap] = useState<number | ''>('');
  const [priority, setPriority] = useState<ManagedCampaign['priority']>('normal');
  const [maxWaveSize, setMaxWaveSize] = useState<number | ''>('');
  const [maxNewLeadsPerDay, setMaxNewLeadsPerDay] = useState<number | ''>('');
  const [maxInSequence, setMaxInSequence] = useState<number | ''>('');
  const [waveIntervalMinutes, setWaveIntervalMinutes] = useState<number | ''>('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [scheduledEnd, setScheduledEnd] = useState('');
  const [campaignWorkingDays, setCampaignWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [campaignWorkStart, setCampaignWorkStart] = useState('');
  const [campaignWorkEnd, setCampaignWorkEnd] = useState('');
  const [endBehavior, setEndBehavior] =
    useState<ManagedCampaign['schedule']['endBehavior']>('finish_waves');
  const [excludeExistingConversation, setExcludeExistingConversation] = useState(true);
  const [excludeSameSenderMessaged, setExcludeSameSenderMessaged] = useState(true);
  const [contactedLookbackDays, setContactedLookbackDays] = useState<number | ''>(30);
  const [suppressedCompanies, setSuppressedCompanies] = useState('');
  const [suppressedDomains, setSuppressedDomains] = useState('');
  const [launchPreview, setLaunchPreview] = useState<CampaignLaunchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [limits, setLimits] = useState<LinkedInLimitsReport | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{
    campaign: ManagedCampaign;
    enrolled: number;
    skippedAlreadyActive: number;
    excluded: number;
  } | null>(null);

  const refreshOptions = async () => {
    const [nextSeats, nextLists, nextWorkflows, nextMailboxes] = await Promise.all([
      getLinkedInManagerSeats(),
      getLinkedInManagerLeadLists(activeSeatKey),
      getLinkedInManagerWorkflows(),
      getLinkedInCampaignMailboxes()
    ]);
    setSeats(nextSeats);
    setLists(nextLists);
    setWorkflows(nextWorkflows);
    setMailboxes(nextMailboxes);
    setListId((current) =>
      nextLists.some((candidate) => candidate.id === current) ? current : nextLists[0]?.id || ''
    );
    setWorkflowId((current) => current || nextWorkflows[0]?.id || '');
  };
  useEffect(() => {
    setSenderKeys((current) =>
      current.length > 0 && current.includes(activeSeatKey)
        ? current
        : activeSeatKey
          ? [activeSeatKey]
          : []
    );
    void refreshOptions().catch(() => undefined);
  }, [activeSeatKey]);

  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setNameTouched(true);
    setWorkflowId(prefill.workflowId);
    if (prefill.seatKey === activeSeatKey) {
      setListId(prefill.leadListId);
      setError('');
    } else {
      setListId('');
      setError(
        'That campaign belongs to another LinkedIn account. Switch accounts in Outreach → Settings to reuse its lead list.'
      );
    }
  }, [prefill, activeSeatKey]);

  /**
   * The ceilings this account is really under, for the account chosen above.
   *
   * Refetched per account because the band a seat draws from depends on its
   * posture and its warm-up week, both of which are per-account facts.
   */
  useEffect(() => {
    if (!seatKey) {
      setLimits(null);
      return undefined;
    }
    let live = true;
    void getLinkedInLimits(seatKey)
      .then((report) => {
        if (live) setLimits(report);
      })
      .catch(() => {
        if (live) setLimits(null);
      });
    return () => {
      live = false;
    };
  }, [seatKey]);

  const seat = seats.find((candidate) => candidate.seatKey === activeSeatKey) ?? null;
  const list = lists.find((candidate) => candidate.id === listId) ?? null;
  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? null;
  const primarySender = seats.find((candidate) => candidate.seatKey === senderKeys[0]) ?? seat;
  const campaignTimezone =
    primarySender?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const workflowNeedsEmail = workflow?.steps.some((step) => step.action === 'email') ?? false;
  const workflowNeedsInmail = workflow?.steps.some((step) => step.action === 'inmail') ?? false;
  useEffect(() => {
    if (!workflowNeedsInmail) return;
    const allowed = new Set(
      seats
        .filter((candidate) => candidate.capabilities.inmail === 'available')
        .map((candidate) => candidate.seatKey)
    );
    setSenderKeys((current) => current.filter((key) => allowed.has(key)));
  }, [workflowNeedsInmail, seats]);
  const workflowNeedsFindEmail =
    workflow?.steps.some((step) => step.action === 'find_email') ?? false;

  useEffect(() => {
    if (nameTouched || !list || !workflow) return;
    setName(`${list.name} → ${workflow.name}`.slice(0, 120));
  }, [list?.name, workflow?.name, nameTouched]);

  const fractions = rampFractions(limits);
  const dayOneFraction = fractions?.[0] ?? null;
  const ceilings = useMemo(
    () => enforcedCeilings(limits, dayOneFraction ?? 1),
    [limits, dayOneFraction]
  );

  const schedule = useMemo(() => {
    if (!workflow) return { steps: [] as Array<{ step: WorkflowStep; day: number }>, days: 0 };
    let elapsed = 0;
    const steps = workflow.steps.map((step) => {
      elapsed += stepHours(step);
      return { step, day: Math.floor(elapsed / 24) + 1 };
    });
    return { steps, days: Math.max(1, Math.ceil(elapsed / 24)) };
  }, [workflow]);

  const admissionPolicy = useMemo<ManagedCampaign['admissionPolicy']>(
    () => ({
      ...(maxWaveSize === '' ? {} : { maxWaveSize }),
      ...(maxNewLeadsPerDay === '' ? {} : { maxNewLeadsPerDay }),
      ...(maxInSequence === '' ? {} : { maxInSequence }),
      ...(waveIntervalMinutes === '' ? {} : { minWaveIntervalMinutes: waveIntervalMinutes })
    }),
    [maxWaveSize, maxNewLeadsPerDay, maxInSequence, waveIntervalMinutes]
  );

  useEffect(() => {
    if (!listId || !workflowId || senderKeys.length === 0) {
      setLaunchPreview(null);
      return undefined;
    }
    let live = true;
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void previewLinkedInManagedCampaign({
        leadListId: listId,
        workflowId,
        senderKeys,
        admissionPolicy,
        enrichmentCreditCap: enrichmentCreditCap === '' ? null : enrichmentCreditCap
      })
        .then((preview) => {
          if (live) setLaunchPreview(preview);
        })
        .catch(() => {
          if (live) setLaunchPreview(null);
        })
        .finally(() => {
          if (live) setPreviewLoading(false);
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    listId,
    workflowId,
    senderKeys.join('|'),
    admissionPolicy.maxWaveSize,
    admissionPolicy.maxNewLeadsPerDay,
    admissionPolicy.maxInSequence,
    admissionPolicy.minWaveIntervalMinutes
  ]);

  const warnings: string[] = [];
  if (list && list.leadCount === 0)
    warnings.push(
      `“${list.name}” has no leads in it yet, so the campaign would start empty. Import leads into it first.`
    );
  if (seat && seat.workingDays.length === 0)
    warnings.push(
      `“${seat.label}” has no working days set, so nothing will go out until you set them on Setup → LinkedIn account.`
    );
  // Not a guess about the account: the ceiling the server reports for it is
  // zero right now, so a campaign started under it would enrol its leads and
  // then sit still. `rule` is the server's own sentence for why.
  if (seat && ceilings && ceilings.invite.full === 0 && ceilings.dm.full === 0) {
    warnings.push(
      `“${seat.label}” is not allowed to send anything at the moment, so the campaign would enrol its leads and then wait. ${limits?.limits.find((limit) => limit.kind === 'invite' && limit.window === 'day')?.rule ?? ''}`.trim()
    );
  }
  if (workflowNeedsEmail && mailboxes.length === 0)
    warnings.push(
      'This workflow sends email, but no connected Gmail or Microsoft 365 mailbox is available.'
    );
  if (
    workflowNeedsEmail &&
    senderKeys.some((key) => !mailboxAssignments[key]) &&
    mailboxes.length > 0
  )
    warnings.push(
      'Assign a mailbox to every selected LinkedIn sender used by this multichannel campaign.'
    );
  if (
    workflowNeedsInmail &&
    senderKeys.some(
      (key) =>
        seats.find((candidate) => candidate.seatKey === key)?.capabilities.inmail !== 'available'
    )
  )
    warnings.push(
      'This workflow contains InMail, but one or more selected LinkedIn accounts are not marked InMail-capable.'
    );
  if (workflowNeedsFindEmail && launchPreview?.enrichmentCredits.capped)
    warnings.push(
      `The Find Email stage is estimated to need ${launchPreview.enrichmentCredits.estimatedProviderLookups} provider credit(s), above the campaign cap of ${launchPreview.enrichmentCredits.cap ?? 0}. Leads beyond the cap will take the Email not found/failure path until the cap is raised while paused.`
    );

  const patchMailbox = (id: string, patch: Partial<CampaignMailbox>) =>
    setMailboxes((current) =>
      current.map((mailbox) => (mailbox.id === id ? { ...mailbox, ...patch } : mailbox))
    );
  const saveMailbox = async (mailbox: CampaignMailbox) => {
    setBusy(`mailbox:${mailbox.id}`);
    setError('');
    try {
      await updateLinkedInCampaignMailbox(mailbox.id, {
        dailyLimit: mailbox.dailyLimit,
        timezone: mailbox.timezone,
        workingDays: mailbox.workingDays,
        workStartMinute: mailbox.workStartMinute,
        workEndMinute: mailbox.workEndMinute
      });
      setToast(`Saved ${mailbox.provider} mailbox pacing.`);
      await refreshOptions();
    } catch (err) {
      setError(errorMessage(err, 'Unable to save mailbox pacing.'));
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    if (!name.trim() || !listId || !workflowId) return;
    setBusy('create');
    setError('');
    try {
      const csvValues = (value: string) => [
        ...new Set(
          value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      ];
      if (scheduledStart && !zonedLocalToIso(scheduledStart, campaignTimezone))
        throw new Error(
          `That start time does not exist in ${campaignTimezone} because of a timezone/DST transition.`
        );
      if (scheduledEnd && !zonedLocalToIso(scheduledEnd, campaignTimezone))
        throw new Error(
          `That end time does not exist in ${campaignTimezone} because of a timezone/DST transition.`
        );
      const workStartMinute = minuteOfClock(campaignWorkStart);
      const workEndMinute = minuteOfClock(campaignWorkEnd);
      if (workStartMinute !== null && workEndMinute !== null && workEndMinute <= workStartMinute)
        throw new Error('Campaign working hours need an end later than the start.');
      if (campaignWorkingDays.length === 0)
        throw new Error('Choose at least one campaign working day.');
      const result = await createLinkedInManagedCampaign({
        name: name.trim(),
        senderKeys,
        mailboxAssignments,
        inmailCreditCap: inmailCreditCap === '' ? null : inmailCreditCap,
        enrichmentCreditCap: enrichmentCreditCap === '' ? null : enrichmentCreditCap,
        leadListId: listId,
        workflowId,
        priority,
        admissionPolicy,
        exclusionPolicy: {
          excludeMissingProfile: true,
          excludeDoNotContact: true,
          excludeExistingConversation,
          excludeSameSenderMessaged,
          contactedLookbackDays: contactedLookbackDays === '' ? null : contactedLookbackDays,
          suppressedCompanies: csvValues(suppressedCompanies),
          suppressedDomains: csvValues(suppressedDomains)
        },
        schedule: {
          startAt: scheduledStart ? zonedLocalToIso(scheduledStart, campaignTimezone) : null,
          endAt: scheduledEnd ? zonedLocalToIso(scheduledEnd, campaignTimezone) : null,
          workingDays: campaignWorkingDays,
          workStartMinute: minuteOfClock(campaignWorkStart),
          workEndMinute: minuteOfClock(campaignWorkEnd),
          endBehavior
        }
      });
      setToast(
        `“${result.campaign.name}” was created with ${plural(result.enrolled, 'contact')}${
          result.skippedAlreadyActive > 0
            ? `; ${plural(result.skippedAlreadyActive, 'contact')} already active elsewhere ${result.skippedAlreadyActive === 1 ? 'was' : 'were'} skipped`
            : ''
        }. Nothing is running yet.`
      );
      onCreated?.(result.campaign);
      if (!onCreated) await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Unable to create that campaign.'));
    } finally {
      setBusy('');
    }
  };

  const missing = seats.length === 0;

  const createBlocker =
    busy !== ''
      ? ''
      : !name.trim()
        ? 'Name the campaign before creating it.'
        : !listId
          ? 'Choose or upload a lead list.'
          : !workflowId
            ? 'Choose or create a workflow.'
            : senderKeys.length === 0
              ? 'Choose at least one sending account.'
              : '';

  return (
    <section className="page-panel li-polished">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Create a campaign</h3>
          <p>
            The active LinkedIn account is the default sender. Add more senders only when you want a
            shared campaign.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {missing ? (
        <div className="mgr-empty">
          <h4 aria-level={3}>Add a LinkedIn account first</h4>
          <p>A campaign sends from a real LinkedIn account, with its own hours and limits.</p>
          <div className="mgr-actions">
            <a className="primary-button" href="/outreach/settings">
              Add a LinkedIn account
            </a>
          </div>
        </div>
      ) : (
        <div className="mgr-split">
          <div className="mgr-fields-stack">
            <div className="li-form-grid mgr-fields">
              <label>
                Campaign name
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameTouched(true);
                  }}
                  placeholder="Q3 founder outreach"
                />
              </label>
            </div>

            <div className="mgr-picker">
              <h4 aria-level={3}>
                <Users size={14} /> Leads
              </h4>
              <div className="li-wf-starters mgr-pick-grid">
                {lists.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`li-wf-starter${listId === candidate.id ? ' is-selected' : ''}`}
                    aria-pressed={listId === candidate.id}
                    onClick={() => {
                      setListId(candidate.id);
                      setShowListUploader(false);
                    }}
                  >
                    <strong>{candidate.name}</strong>
                    <p>{plural(candidate.leadCount, 'lead')}</p>
                  </button>
                ))}
                <button
                  type="button"
                  className={`li-wf-starter li-wf-starter-add${showListUploader ? ' is-selected' : ''}`}
                  onClick={() => setShowListUploader((value) => !value)}
                >
                  <Plus size={14} /> Upload a CSV
                </button>
              </div>
              {showListUploader && (
                <LinkedInManagerLeadConfig
                  compact
                  setToast={setToast}
                  onChanged={refreshOptions}
                  onImported={(uploaded) => {
                    setListId(uploaded.id);
                    setShowListUploader(false);
                  }}
                />
              )}
            </div>

            <div className="mgr-picker">
              <h4 aria-level={3}>
                <WorkflowIcon size={14} /> Workflow
              </h4>
              <div className="li-wf-starters mgr-pick-grid">
                {workflows.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`li-wf-starter${workflowId === candidate.id ? ' is-selected' : ''}`}
                    aria-pressed={workflowId === candidate.id}
                    onClick={() => {
                      setWorkflowId(candidate.id);
                      setShowWorkflowStarters(false);
                    }}
                  >
                    <strong>{candidate.name}</strong>
                    <p>{chipTrail(candidate) || plural(candidate.steps.length, 'step')}</p>
                  </button>
                ))}
                <button
                  type="button"
                  className={`li-wf-starter li-wf-starter-add${showWorkflowStarters ? ' is-selected' : ''}`}
                  onClick={() => setShowWorkflowStarters((value) => !value)}
                >
                  <Plus size={14} /> New from template
                </button>
              </div>
              {showWorkflowStarters && (
                <LinkedInManagerWorkflowConfig
                  compact
                  setToast={setToast}
                  onChanged={refreshOptions}
                  onCreated={(createdWorkflow) => {
                    setWorkflowId(createdWorkflow.id);
                    setShowWorkflowStarters(false);
                  }}
                />
              )}
            </div>

            <details
              className="mgr-advanced"
              open={showAdvanced}
              onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
            >
              <summary>Advanced campaign controls</summary>
              <div className="li-form-grid mgr-fields">
                <fieldset className="li-span-2">
                  <legend>Sending accounts</legend>
                  <p className="li-hint">
                    Each admitted lead is assigned one sender permanently for this campaign.
                  </p>
                  <div className="li-check-grid">
                    {seats.map((candidate) => (
                      <label key={candidate.seatKey} className="li-check-row">
                        <input
                          type="checkbox"
                          checked={senderKeys.includes(candidate.seatKey)}
                          disabled={
                            workflowNeedsInmail && candidate.capabilities.inmail !== 'available'
                          }
                          onChange={(event) =>
                            setSenderKeys((current) =>
                              event.target.checked
                                ? [...new Set([...current, candidate.seatKey])]
                                : current.filter((key) => key !== candidate.seatKey)
                            )
                          }
                        />
                        <span>
                          <b>{candidate.label}</b> · {candidate.timezone}
                          {workflowNeedsInmail && candidate.capabilities.inmail !== 'available'
                            ? ' · InMail unavailable/not verified'
                            : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {workflowNeedsEmail && (
                  <fieldset className="li-span-2">
                    <legend>Email mailbox assignment</legend>
                    <p className="li-hint">
                      Each lead keeps the mailbox paired with its LinkedIn sender for the whole
                      campaign.
                    </p>
                    <div className="mgr-pick-grid">
                      {senderKeys.map((key) => (
                        <label key={`mailbox-${key}`}>
                          {seats.find((candidate) => candidate.seatKey === key)?.label ?? key}
                          <select
                            value={mailboxAssignments[key] ?? ''}
                            onChange={(event) =>
                              setMailboxAssignments((current) => ({
                                ...current,
                                [key]: event.target.value
                              }))
                            }
                          >
                            <option value="">Choose mailbox</option>
                            {mailboxes.map((mailbox) => (
                              <option key={mailbox.id} value={mailbox.id}>
                                {mailbox.provider} · {mailbox.dailyLimit}/day · {mailbox.timezone}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    {mailboxes.length > 0 && (
                      <div className="li-span-2">
                        <p className="li-hint">
                          Mailbox pacing is enforced independently from LinkedIn pacing.{' '}
                          {isWorkspaceOwner
                            ? 'You can edit it here.'
                            : 'Only the workspace owner can change it.'}
                        </p>
                        {mailboxes.map((mailbox) => (
                          <details className="mgr-advanced" key={`mailbox-settings-${mailbox.id}`}>
                            <summary>
                              {mailbox.provider} · {mailbox.dailyLimit}/day · {mailbox.timezone}
                            </summary>
                            <div className="li-form-grid">
                              <label>
                                Daily email cap
                                <input
                                  type="number"
                                  min={1}
                                  max={1000}
                                  disabled={!isWorkspaceOwner || busy !== ''}
                                  value={mailbox.dailyLimit}
                                  onChange={(event) =>
                                    patchMailbox(mailbox.id, {
                                      dailyLimit: Math.max(
                                        1,
                                        Math.min(1000, Math.trunc(Number(event.target.value) || 1))
                                      )
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Mailbox timezone
                                <input
                                  disabled={!isWorkspaceOwner || busy !== ''}
                                  value={mailbox.timezone}
                                  onChange={(event) =>
                                    patchMailbox(mailbox.id, { timezone: event.target.value })
                                  }
                                />
                              </label>
                              <label>
                                Earliest email time
                                <input
                                  type="time"
                                  disabled={!isWorkspaceOwner || busy !== ''}
                                  value={clock(mailbox.workStartMinute)}
                                  onChange={(event) => {
                                    const minute = minuteOfClock(event.target.value);
                                    if (minute !== null)
                                      patchMailbox(mailbox.id, { workStartMinute: minute });
                                  }}
                                />
                              </label>
                              <label>
                                Latest email time
                                <input
                                  type="time"
                                  disabled={!isWorkspaceOwner || busy !== ''}
                                  value={clock(mailbox.workEndMinute)}
                                  onChange={(event) => {
                                    const minute = minuteOfClock(event.target.value);
                                    if (minute !== null)
                                      patchMailbox(mailbox.id, { workEndMinute: minute });
                                  }}
                                />
                              </label>
                              <fieldset className="li-span-2">
                                <legend>Email working days</legend>
                                <div className="li-check-grid">
                                  {WEEKDAYS.map((label, day) => (
                                    <label className="li-check-row" key={`${mailbox.id}-${day}`}>
                                      <input
                                        type="checkbox"
                                        disabled={!isWorkspaceOwner || busy !== ''}
                                        checked={mailbox.workingDays.includes(day)}
                                        onChange={(event) =>
                                          patchMailbox(mailbox.id, {
                                            workingDays: event.target.checked
                                              ? [...new Set([...mailbox.workingDays, day])].sort(
                                                  (a, b) => a - b
                                                )
                                              : mailbox.workingDays.filter((value) => value !== day)
                                          })
                                        }
                                      />{' '}
                                      {label}
                                    </label>
                                  ))}
                                </div>
                              </fieldset>
                            </div>
                            {isWorkspaceOwner && (
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={
                                  busy !== '' ||
                                  mailbox.workingDays.length === 0 ||
                                  mailbox.workEndMinute <= mailbox.workStartMinute ||
                                  !mailbox.timezone.trim()
                                }
                                onClick={() => void saveMailbox(mailbox)}
                              >
                                {busy === `mailbox:${mailbox.id}` ? (
                                  <LoaderCircle className="spin" size={14} />
                                ) : null}{' '}
                                Save mailbox pacing
                              </button>
                            )}
                          </details>
                        ))}
                      </div>
                    )}
                  </fieldset>
                )}
                {workflowNeedsInmail && (
                  <label>
                    Paid InMail credit cap
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={inmailCreditCap}
                      placeholder="0 — free/Open Profile only"
                      onChange={(event) =>
                        setInmailCreditCap(
                          event.target.value === ''
                            ? ''
                            : Math.max(0, Math.trunc(Number(event.target.value) || 0))
                        )
                      }
                    />
                    <span className="li-hint">
                      Paid credits are used only when the workflow explicitly allows them and both
                      campaign and account caps permit it.
                    </span>
                  </label>
                )}
                {workflowNeedsFindEmail && (
                  <label>
                    Enrichment credit cap
                    <input
                      type="number"
                      min={0}
                      max={100000}
                      value={enrichmentCreditCap}
                      placeholder="0 — no provider credits"
                      onChange={(event) =>
                        setEnrichmentCreditCap(
                          event.target.value === ''
                            ? ''
                            : Math.max(0, Math.trunc(Number(event.target.value) || 0))
                        )
                      }
                    />
                    <span className="li-hint">
                      One credit is reserved only when Trevra actually calls the configured
                      enrichment provider. Existing/imported emails cost zero.
                    </span>
                  </label>
                )}

                <label>
                  Campaign priority
                  <select
                    value={priority}
                    onChange={(event) =>
                      setPriority(event.target.value as ManagedCampaign['priority'])
                    }
                  >
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  Maximum wave size
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={maxWaveSize}
                    placeholder="Automatic"
                    onChange={(event) =>
                      setMaxWaveSize(
                        event.target.value === ''
                          ? ''
                          : Math.max(1, Math.trunc(Number(event.target.value) || 1))
                      )
                    }
                  />
                </label>
                <label>
                  Maximum new leads / day
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    value={maxNewLeadsPerDay}
                    placeholder="Automatic"
                    onChange={(event) =>
                      setMaxNewLeadsPerDay(
                        event.target.value === ''
                          ? ''
                          : Math.max(0, Math.trunc(Number(event.target.value) || 0))
                      )
                    }
                  />
                </label>
                <label>
                  Maximum leads in sequence
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={maxInSequence}
                    placeholder="Automatic"
                    onChange={(event) =>
                      setMaxInSequence(
                        event.target.value === ''
                          ? ''
                          : Math.max(1, Math.trunc(Number(event.target.value) || 1))
                      )
                    }
                  />
                </label>
                <label>
                  Minimum minutes between waves
                  <input
                    type="number"
                    min={0}
                    max={10080}
                    value={waveIntervalMinutes}
                    placeholder="No extra delay"
                    onChange={(event) =>
                      setWaveIntervalMinutes(
                        event.target.value === ''
                          ? ''
                          : Math.max(0, Math.trunc(Number(event.target.value) || 0))
                      )
                    }
                  />
                </label>
                <label>
                  Optional campaign start
                  <input
                    type="datetime-local"
                    value={scheduledStart}
                    onChange={(event) => setScheduledStart(event.target.value)}
                  />
                </label>
                <label>
                  Optional campaign end
                  <input
                    type="datetime-local"
                    value={scheduledEnd}
                    onChange={(event) => setScheduledEnd(event.target.value)}
                  />
                </label>
                <fieldset className="li-span-2">
                  <legend>Campaign working window</legend>
                  <p className="li-hint">
                    Start/end use {campaignTimezone}. Working hours narrow each sender's own local
                    account window; they can never widen it.
                  </p>
                  <div className="li-check-grid">
                    {WEEKDAYS.map((label, day) => (
                      <label className="li-check-row" key={`campaign-day-${day}`}>
                        <input
                          type="checkbox"
                          checked={campaignWorkingDays.includes(day)}
                          onChange={(event) =>
                            setCampaignWorkingDays((current) =>
                              event.target.checked
                                ? [...new Set([...current, day])].sort((a, b) => a - b)
                                : current.filter((value) => value !== day)
                            )
                          }
                        />{' '}
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="li-form-grid">
                    <label>
                      Earliest campaign time
                      <input
                        type="time"
                        value={campaignWorkStart}
                        onChange={(event) => setCampaignWorkStart(event.target.value)}
                      />
                    </label>
                    <label>
                      Latest campaign time
                      <input
                        type="time"
                        value={campaignWorkEnd}
                        onChange={(event) => setCampaignWorkEnd(event.target.value)}
                      />
                    </label>
                  </div>
                </fieldset>
                <label>
                  At campaign end
                  <select
                    value={endBehavior}
                    onChange={(event) =>
                      setEndBehavior(
                        event.target.value as ManagedCampaign['schedule']['endBehavior']
                      )
                    }
                  >
                    <option value="finish_waves">Finish admitted waves; admit nobody new</option>
                    <option value="pause_all">Pause campaign and hold queued work</option>
                    <option value="stop_immediately">Stop and release remaining leads</option>
                  </select>
                </label>
                <fieldset className="li-span-2">
                  <legend>Exclusions</legend>
                  <label className="li-check-row">
                    <input
                      type="checkbox"
                      checked={excludeExistingConversation}
                      onChange={(event) => setExcludeExistingConversation(event.target.checked)}
                    />{' '}
                    Exclude leads with an existing conversation
                  </label>
                  <label className="li-check-row">
                    <input
                      type="checkbox"
                      checked={excludeSameSenderMessaged}
                      onChange={(event) => setExcludeSameSenderMessaged(event.target.checked)}
                    />{' '}
                    Exclude leads already messaged by the assigned sender
                  </label>
                </fieldset>
                <label>
                  Contacted lookback (days)
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={contactedLookbackDays}
                    onChange={(event) =>
                      setContactedLookbackDays(
                        event.target.value === ''
                          ? ''
                          : Math.max(0, Math.trunc(Number(event.target.value) || 0))
                      )
                    }
                  />
                </label>
                <label>
                  Suppressed companies
                  <input
                    value={suppressedCompanies}
                    onChange={(event) => setSuppressedCompanies(event.target.value)}
                    placeholder="Acme, Contoso"
                  />
                </label>
                <label>
                  Suppressed email domains
                  <input
                    value={suppressedDomains}
                    onChange={(event) => setSuppressedDomains(event.target.value)}
                    placeholder="example.com, competitor.com"
                  />
                </label>
              </div>
            </details>

            <p className="li-hint">
              A lead can only be in one active campaign at a time. Anyone already in another one is
              left where they are, and every exclusion is retained with a reason.
            </p>
          </div>

          <aside className="mgr-preview">
            <h4 aria-level={3}>What will happen</h4>
            {list && workflow && seat ? (
              <>
                <p className="mgr-preview-lede">
                  <b>{plural(list.leadCount, 'lead')}</b> from {list.name} will be worked through{' '}
                  <b>{workflow.name}</b> by{' '}
                  <b>
                    {senderKeys
                      .map(
                        (key) => seats.find((candidate) => candidate.seatKey === key)?.label ?? key
                      )
                      .join(', ') || seat.label}
                  </b>
                  , over about <b>{plural(schedule.days, 'day')}</b> each.
                </p>
                <div className="mgr-preview-note">
                  {previewLoading ? (
                    <>
                      <LoaderCircle className="spin" size={13} /> Recalculating sustainable
                      admission…
                    </>
                  ) : launchPreview ? (
                    <>
                      <b>{plural(launchPreview.firstWaveSize, 'lead')}</b> in the estimated first
                      wave; about{' '}
                      <b>{plural(launchPreview.sustainableNewLeadsPerDay, 'new lead')}</b> can be
                      admitted per day under current downstream capacity.
                      {launchPreview.bottleneck && (
                        <>
                          {' '}
                          The limiting stage is{' '}
                          <b>
                            {BOTTLENECK_LABEL[launchPreview.bottleneck] ?? launchPreview.bottleneck}
                          </b>
                          .
                        </>
                      )}
                      {list.leadCount > launchPreview.firstWaveSize && (
                        <>
                          {' '}
                          The remaining{' '}
                          {plural(list.leadCount - launchPreview.firstWaveSize, 'lead')} stay
                          pending until earlier waves clear.
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Admission is calculated from the full workflow's bottleneck before any first
                      action is queued.
                    </>
                  )}
                </div>
                {launchPreview && workflowNeedsFindEmail && (
                  <div className="mgr-preview-note">
                    <b>Email enrichment:</b> {launchPreview.enrichmentCredits.alreadyAvailable}{' '}
                    lead(s) already have email;{' '}
                    {launchPreview.enrichmentCredits.estimatedProviderLookups} provider lookup(s)
                    are estimated.
                    {launchPreview.enrichmentCredits.cap !== null && (
                      <>
                        {' '}
                        Campaign cap: <b>{launchPreview.enrichmentCredits.cap}</b>.
                      </>
                    )}
                    {launchPreview.enrichmentCredits.capped && (
                      <>
                        {' '}
                        <b>The current cap is below the estimated demand.</b>
                      </>
                    )}
                  </div>
                )}
                {launchPreview && launchPreview.personalizationSamples.length > 0 && (
                  <div className="mgr-preview-note">
                    <b>Rendered for real leads</b>
                    {launchPreview.personalizationSamples.map((sample) => (
                      <details key={sample.contactId}>
                        <summary>{sample.label}</summary>
                        {sample.rendered.length > 0 ? (
                          sample.rendered.map((row) => (
                            <p className="li-template" key={`${sample.contactId}-${row.stepId}`}>
                              <span className="li-hint">{row.stepId}</span>
                              <br />
                              {row.text}
                            </p>
                          ))
                        ) : (
                          <p className="li-hint">No message-bearing step to preview.</p>
                        )}
                      </details>
                    ))}
                  </div>
                )}
                {launchPreview && launchPreview.diagnostics.length > 0 && (
                  <div className="mgr-preview-note">
                    <b>Review before launch</b>
                    <ul>
                      {launchPreview.diagnostics.map((diagnostic, index) => (
                        <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
                      ))}
                    </ul>
                    <span className="li-hint">
                      Suggestions only — Trevra never rewrites your workflow automatically.
                    </span>
                  </div>
                )}
                <ol className="mgr-preview-steps">
                  {schedule.steps.map(({ step, day }) => (
                    <li key={step.id}>
                      <span className="mgr-preview-day">Day {day}</span>
                      {ACTION_LABEL[step.action]}
                    </li>
                  ))}
                </ol>
                <p className="mgr-preview-note">
                  {seat.workingDays.length > 0
                    ? `Only on ${seat.workingDays.map((day) => WEEKDAYS[day]).join(', ')}, ${clock(seat.workStartMinute)}–${clock(seat.workEndMinute)} ${seat.timezone}.`
                    : 'This account has no working hours set, so nothing can go out yet.'}
                </p>
                {ceilings && fractions && dayOneFraction !== null ? (
                  <>
                    <button
                      type="button"
                      className="li-link mgr-details-toggle"
                      onClick={() => setShowSendingDetails((value) => !value)}
                    >
                      {showSendingDetails ? 'Hide sending details' : 'Show sending details'}
                    </button>
                    {showSendingDetails && (
                      <p className="mgr-preview-note">
                        Day 1 is held to {Math.round(dayOneFraction * 100)}% of what this account
                        may send — {plural(ceilings.invite.today, 'invite')} and{' '}
                        {plural(ceilings.dm.today, 'message')} across the whole campaign — and
                        reaches full speed on day {fractions.length}. Full speed is{' '}
                        {plural(ceilings.invite.full, 'invite')} and{' '}
                        {plural(ceilings.dm.full, 'message')} a day; the invite ceiling is{' '}
                        {ceilingSourceNote(ceilings.invite)}.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mgr-preview-note">
                    Day 1 is deliberately slow, and the campaign steps up to full speed over its
                    first few days.
                  </p>
                )}
              </>
            ) : (
              <p className="empty-copy">
                Choose a lead list and a workflow to see what this campaign will do.
              </p>
            )}

            {warnings.length > 0 && (
              <div className="li-warn-block">
                <CircleAlert size={16} />
                <div>
                  <strong>Worth fixing first</strong>
                  <ul>
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {!missing && (
        <div className="panel-footer">
          <span title={createBlocker || undefined}>
            {createBlocker ||
              'Creating a campaign queues nothing. Start is the only control that lets work go out.'}
          </span>
          <button
            className="primary-button"
            type="button"
            disabled={createBlocker !== ''}
            title={createBlocker || undefined}
            onClick={() => void create()}
          >
            {busy === 'create' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{' '}
            Create campaign
          </button>
        </div>
      )}
    </section>
  );
}
