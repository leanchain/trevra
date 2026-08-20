import { useEffect, useMemo, useState } from 'react';
import {
  CircleAlert,
  LoaderCircle,
  Play,
  Plus,
  Users,
  Workflow as WorkflowIcon
} from 'lucide-react';
import {
  createLinkedInManagedCampaign,
  getLinkedInLimits,
  getLinkedInManagerLeadLists,
  getLinkedInManagerSeats,
  getLinkedInManagerWorkflows,
  startLinkedInManagedCampaign,
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
import type { ManagedCampaign } from '../server/linkedin/managed-campaigns';
import { errorMessage } from './LinkedInSafety';

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

const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View their profile',
  connection_request: 'Send a connection request',
  message: 'Send a message',
  manual_message: 'A message you write yourself',
  follow: 'Follow them',
  withdraw_pending: 'Withdraw the invite if still pending'
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
  withdraw_pending: 'Withdraw'
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
  onStarted,
  prefill
}: {
  onChanged: () => Promise<void>;
  setToast: (message: string) => void;
  /** After an explicit Start succeeds, the builder can return to operations. */
  onStarted?: (campaign: ManagedCampaign) => void;
  /** Fills the form from a finished campaign, so "run this list again" is one click. */
  prefill?: CampaignPrefill | null;
}) {
  /** The sending account is the universal Outreach selection made in Settings. */
  const [activeSeatKey] = useActiveSeatKey();
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [workflows, setWorkflows] = useState<LinkedInWorkflow[]>([]);
  const [name, setName] = useState('');
  /** Whether the operator has typed into the name field. Until then it auto-fills from the list + workflow choice; the first keystroke stops that. */
  const [nameTouched, setNameTouched] = useState(false);
  const seatKey = activeSeatKey;
  const [listId, setListId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [showListUploader, setShowListUploader] = useState(false);
  const [showWorkflowStarters, setShowWorkflowStarters] = useState(false);
  const [showSendingDetails, setShowSendingDetails] = useState(false);
  const [limits, setLimits] = useState<LinkedInLimitsReport | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{
    campaign: ManagedCampaign;
    enrolled: number;
    skippedAlreadyActive: number;
  } | null>(null);

  const refreshOptions = async () => {
    const [nextSeats, nextLists, nextWorkflows] = await Promise.all([
      getLinkedInManagerSeats(),
      getLinkedInManagerLeadLists(activeSeatKey),
      getLinkedInManagerWorkflows()
    ]);
    setSeats(nextSeats);
    setLists(nextLists);
    setWorkflows(nextWorkflows);
    setListId((current) =>
      nextLists.some((candidate) => candidate.id === current) ? current : nextLists[0]?.id || ''
    );
    setWorkflowId((current) => current || nextWorkflows[0]?.id || '');
  };
  useEffect(() => {
    void refreshOptions().catch(() => undefined);
  }, [activeSeatKey]);

  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setNameTouched(true);
    setWorkflowId(prefill.workflowId);
    setCreated(null);
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

  const create = async () => {
    if (!name.trim() || !listId || !workflowId) return;
    setBusy('create');
    setError('');
    try {
      const result = await createLinkedInManagedCampaign({
        name: name.trim(),
        seatKey: activeSeatKey,
        leadListId: listId,
        workflowId
      });
      setCreated(result);
      setName('');
      setNameTouched(false);
      await Promise.all([refreshOptions(), onChanged()]);
    } catch (err) {
      setError(errorMessage(err, 'Unable to create that campaign.'));
    } finally {
      setBusy('');
    }
  };

  const startNow = async () => {
    if (!created) return;
    setBusy('start');
    setError('');
    try {
      await startLinkedInManagedCampaign(created.campaign.id);
      setToast(
        `“${created.campaign.name}” is running.${dayOneFraction === null ? '' : ` Day one is held to ${Math.round(dayOneFraction * 100)}% of what this account may send.`}`
      );
      const started = created.campaign;
      setCreated(null);
      await onChanged();
      onStarted?.(started);
    } catch (err) {
      setError(errorMessage(err, 'The campaign was created but could not be started.'));
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
            : '';

  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>Create a campaign</h3>
          <p>The selected LinkedIn account in the header is the sender.</p>
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

            <p className="li-hint">
              A lead can only be in one active campaign at a time. Anyone already in another one is
              left where they are.
            </p>
          </div>

          <aside className="mgr-preview">
            <h4 aria-level={3}>What will happen</h4>
            {list && workflow && seat ? (
              <>
                <p className="mgr-preview-lede">
                  <b>{plural(list.leadCount, 'lead')}</b> from {list.name} will be worked through{' '}
                  <b>{workflow.name}</b> by <b>{seat.label}</b>, over about{' '}
                  <b>{plural(schedule.days, 'day')}</b> each.
                </p>
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

      {created && (
        <div className="li-dryrun mgr-created">
          <Play size={18} />
          <div>
            <strong>“{created.campaign.name}” is ready</strong>
            <p className="mgr-launch-summary">
              <b>{plural(created.enrolled, 'contact')}</b>
              {seat && (
                <>
                  {' '}
                  · <b>{seat.label}</b>
                </>
              )}
              {workflow && (
                <>
                  {' '}
                  · <b>{workflow.name}</b>
                </>
              )}
            </p>
            <p>
              {created.skippedAlreadyActive > 0 &&
                `${plural(created.skippedAlreadyActive, 'contact')} skipped — already in another active campaign. `}
              It is not running yet: nothing goes out until you start it.
            </p>
            <div className="mgr-actions">
              <button
                className="primary-button"
                type="button"
                disabled={busy !== ''}
                onClick={() => void startNow()}
              >
                {busy === 'start' ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Play size={14} />
                )}{' '}
                Start it now
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busy !== ''}
                onClick={() => setCreated(null)}
              >
                Create another campaign
              </button>
            </div>
          </div>
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
