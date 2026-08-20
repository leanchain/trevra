import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { acceptedTri, repliedTri } from './branching.js';
import { runCampaignChannelActions } from './campaign-channels.js';
import {
  decideAdmission,
  workflowAdmissionDemand,
  type AdmissionKind,
  type AdmissionPolicy
} from './admission.js';
import {
  ACTION_GAP_SECONDS,
  INMAIL_MONTHLY_QUOTA,
  bandFor,
  effectiveDailyCeiling,
  seatOperatorLimit
} from './limits.js';
import {
  admitPendingCampaignMembers,
  campaignActionLimit,
  campaignAdmissionForecast,
  campaignSnapshotSteps,
  enrolNewContacts
} from './managed-campaigns.js';
import { addLocalDays, localDateOf, weekdayOf, zonedToUtc } from './pacing.js';
import { effectivePosture, getSeat, type LinkedInSeat } from './seats.js';
import { enqueueWithdrawals, selectWithdrawalCandidates } from './withdraw.js';
import {
  chooseMessageVariant,
  delayMilliseconds,
  getWorkflow,
  renderWorkflowTemplate,
  type WorkflowStep
} from './workflows.js';

/**
 * The managed-campaign RUNTIME: the tick that turns a workflow into ledger rows.
 *
 * Everything else in the manager describes intent -- a lead list, a workflow, a
 * campaign, a member sitting on a step. Nothing moved any of it. This module is
 * the only thing that reads `steps[member.stepIndex]`, decides WHEN the seat may
 * perform it, writes the `planned` row the local worker claims, and moves the
 * member to the next step. Per-step delays 2..N existed in the schema and were
 * honoured nowhere until this file scheduled off them.
 *
 * IT PLANS, IT NEVER SENDS. Every row it writes is `status='planned'` with a
 * `planned_for` in the future; `local-worker.ts` claims it, re-runs the safety
 * gate at the moment of execution and settles it. That separation is the same
 * one `queue.ts` keeps, for the same reason: an approval decides WHAT, the
 * ledger decides WHETHER, and neither is allowed to be a browser call.
 *
 * THREE CEILINGS BIND HERE, in this order:
 *   1. the campaign warm-up ramp (20/40/60/80/100% of the seat's daily limit
 *      over the campaign's first five days) -- per campaign, per ledger kind;
 *   2. the seat's own working days and hours, in the seat's timezone;
 *   3. a floor of `ACTION_GAP_SECONDS.min` between consecutive slots for one
 *      seat, counted across every campaign this run touches AND against the
 *      slots already sitting in the ledger.
 *
 * Nothing here is random. The jitter is a seeded draw off `member.id:step.id`,
 * so the same tick over the same state produces the same schedule on every
 * machine -- the property `pacing.ts` and `local-worker.ts` already hold, and
 * the only reason a schedule is assertable in a test at all.
 */

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** One tick's worth of work, as an operator (or a job log) reads it. */
export interface RunnerResult {
  campaignsTicked: number;
  actionsPlanned: number;
  manualTasksCreated: number;
  membersCompleted: number;
  /** Members this tick could not act for: no profile URL, no seat, no open slot. */
  membersBlocked: number;
}

/** Ledger kinds a workflow step can produce, and the four the ramp is budgeted per. */
const BUDGETED_KINDS = [
  'invite',
  'dm',
  'inmail',
  'profile_view',
  'follow',
  'like',
  'endorse'
] as const;
type BudgetedKind = (typeof BUDGETED_KINDS)[number];
const MANAGED_LEDGER_KINDS: readonly LinkedInActionKind[] = [
  'invite',
  'dm',
  'inmail',
  'profile_view',
  'follow',
  'unfollow',
  'disconnect',
  'company_follow',
  'company_like',
  'company_invite_follow',
  'event_invite',
  'group_invite',
  'group_message',
  'event_message',
  'like',
  'endorse'
];

/** Statuses that still hold the one-active-campaign claim on a contact. */
const LIVE_MEMBER_STATUSES = ['pending', 'active', 'waiting', 'manual', 'paused'] as const;

/**
 * How far ahead a slot search will walk before giving up.
 *
 * A seat working one day a week still lands inside three weeks; a seat with no
 * working days at all never lands, and that is the configured answer rather
 * than a bug -- `seats.ts` documents an empty list as "disables automated
 * activity".
 */
const SLOT_SEARCH_DAYS = 21;

/** A sane ceiling on one campaign's share of one tick. */
const MEMBER_BATCH = 500;

/**
 * How often a `withdraw_pending` step re-checks an invite that has not been
 * sent yet.
 *
 * A poll rather than a computed wake-up, because what it is waiting for is the
 * local worker claiming and sending the row, and no instant here predicts
 * that. An hour is short enough that the step resumes promptly once the invite
 * goes out and long enough that a member parked behind a stopped worker is not
 * re-read on every tick forever.
 */
const UNSENT_INVITE_RECHECK_MS = 3_600_000;

interface CampaignRow {
  id: string;
  seat_key: string;
  sender_keys_json: unknown;
  mailbox_assignments_json: unknown;
  workflow_id: string;
  lead_list_id: string;
  sequence_json: unknown;
  priority: number;
  admission_policy_json: unknown;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  schedule_days_json: unknown;
  schedule_start_minute: number | null;
  schedule_end_minute: number | null;
  end_behavior: string;
  inmail_credit_cap: number | null;
  last_admission_at: string | null;
  last_planned_at: string | null;
  created_at: string;
  started_at: string | null;
}

interface DueMemberRow {
  id: string;
  contact_id: string;
  step_index: number;
  next_eligible_at: string | null;
  admitted_at: string | null;
  assigned_seat_key: string | null;
  workflow_snapshot_json: unknown;
  workflow_version: number | null;
  assigned_variants: unknown;
  branch_state_json: unknown;
  first_name: string;
  last_name: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  profile_url: string | null;
  custom_fields_json: unknown;
}

interface InviteRow {
  id: string;
  status: string;
  sent_at: string | null;
}

/**
 * The daily ceiling the campaign ramp is a percentage OF, for one kind.
 *
 * THE SAME ARITHMETIC THE GATE DOES, and it has to be, because the gate is
 * what refuses the row this file plans. `guard.ts` ramps its `campaign-warmup`
 * check off `campaignActionLimit(effectiveDailyLimit, ...)` where
 * `effectiveDailyLimit` is the band reconciled with the operator's setting;
 * this file budgeted off the RAW operator number instead.
 *
 * The two disagreed in the direction that stalls: an operator who set 30
 * invites got a day-five budget of 30 from the planner and a refusal at 18
 * from the gate, so twelve members a day were planned, refused at send time,
 * and left sitting with nothing anywhere saying why. Reading one function for
 * both is the only durable fix -- two copies of "the effective ceiling" drift
 * again the moment either side gains a rule, which is exactly what
 * `safetyBandOverride` just was.
 *
 * The posture band, not a constant: a seat in cooldown draws from the
 * conservative band here for the same reason it does everywhere else.
 */
function seatDailyCeilingFor(seat: LinkedInSeat, kind: BudgetedKind, now: Date): number {
  const posture = effectivePosture(seat, now);
  const band = bandFor(kind, posture === 'steady' ? 'steady' : 'warmup');
  return effectiveDailyCeiling(band.perDay, seatOperatorLimit(seat, kind), seat.safetyBandOverride);
}

/** The exact ledger kind a step writes. */
function ledgerKindForStep(step: WorkflowStep): LinkedInActionKind | null {
  switch (step.action) {
    case 'connection_request':
      return 'invite';
    case 'message':
      return 'dm';
    case 'inmail':
      return 'inmail';
    case 'profile_view':
      return 'profile_view';
    case 'follow':
      return 'follow';
    case 'unfollow':
      return 'unfollow';
    case 'disconnect':
      return 'disconnect';
    case 'follow_company':
      return 'company_follow';
    case 'like_company_post':
      return 'company_like';
    case 'invite_to_follow_company':
      return 'company_invite_follow';
    case 'invite_to_event':
      return 'event_invite';
    case 'invite_to_group':
      return 'group_invite';
    case 'group_message':
      return 'group_message';
    case 'event_message':
      return 'event_message';
    case 'like_post':
      return 'like';
    case 'endorse_skills':
      return 'endorse';
    default:
      return null;
  }
}

/** Capacity bucket a step consumes. Several distinct ledger kinds intentionally share one. */
function budgetKindForStep(step: WorkflowStep): BudgetedKind | null {
  const ledger = ledgerKindForStep(step);
  return ledger ? budgetKindForLedgerKind(ledger) : null;
}

function budgetKindForLedgerKind(kind: LinkedInActionKind): BudgetedKind | null {
  if (
    kind === 'invite' ||
    kind === 'company_invite_follow' ||
    kind === 'event_invite' ||
    kind === 'group_invite'
  )
    return 'invite';
  if (kind === 'dm' || kind === 'group_message' || kind === 'event_message') return 'dm';
  if (kind === 'inmail') return 'inmail';
  if (kind === 'profile_view') return 'profile_view';
  if (
    kind === 'follow' ||
    kind === 'unfollow' ||
    kind === 'disconnect' ||
    kind === 'company_follow'
  )
    return 'follow';
  if (kind === 'like' || kind === 'company_like') return 'like';
  if (kind === 'endorse') return 'endorse';
  return null;
}

function admissionKindForStep(step: WorkflowStep): AdmissionKind | null {
  return budgetKindForStep(step);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parseStringArray(value: unknown): string[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function parseVariants(value: unknown): Record<string, string> {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, String(v)])
  );
}

/**
 * A deterministic unit draw in [0, 1).
 *
 * `Math.random()` is banned on every path this subsystem schedules from: the
 * gaps must be unpredictable TO LINKEDIN, which a hash of a stable seed already
 * is, and reproducible TO US, which a platform RNG never is. Same call, same
 * reason, as `local-worker.ts` `actionGapSeconds`.
 */
function seededUnit(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
}

/**
 * The first instant at or after `from` that is inside this seat's working
 * window, IN THE SEAT'S TIMEZONE.
 *
 * Returns null when the seat has no working day within {@link SLOT_SEARCH_DAYS}
 * -- an empty `workingDays` is the operator saying "never", and a caller that
 * cannot place a slot leaves the member where it is rather than inventing one.
 */
function nextOpenInstant(seat: LinkedInSeat, from: Date): Date | null {
  const days = new Set(seat.workingDays);
  if (days.size === 0) return null;
  const startSec = seat.workStartMinute * 60;
  const endSec = seat.workEndMinute * 60;

  let cursor = from;
  for (let step = 0; step <= SLOT_SEARCH_DAYS; step += 1) {
    const local = localDateOf(cursor, seat.timezone);
    const date = { year: local.year, month: local.month, day: local.day };
    if (days.has(weekdayOf(date))) {
      const secondsIntoDay = local.hour * 3600 + local.minute * 60 + local.second;
      if (secondsIntoDay < endSec) {
        return secondsIntoDay >= startSec ? cursor : zonedToUtc(date, startSec, seat.timezone);
      }
    }
    // Past this day's window, or not a working day: reopen at tomorrow's start.
    cursor = zonedToUtc(addLocalDays(date, 1), startSec, seat.timezone);
  }
  return null;
}

/**
 * The slot for one action.
 *
 * `earliest` is when the workflow says it may happen; `floor` is the last slot
 * this seat has been given, either earlier in this run or already in the
 * ledger. The gap between two slots is never below `ACTION_GAP_SECONDS.min`,
 * and the jitter on top of it is the seeded draw -- which is what keeps a
 * sequence of actions from arriving on a grid a rate-limiter could key on.
 */
function scheduleSlot(
  seat: LinkedInSeat,
  earliest: Date,
  floor: Date | null,
  seed: string
): Date | null {
  const jitterMs = Math.round(
    seededUnit(seed) * (ACTION_GAP_SECONDS.max - ACTION_GAP_SECONDS.min) * 1000
  );
  const gapMs = ACTION_GAP_SECONDS.min * 1000 + jitterMs;
  let candidate = new Date(earliest.getTime() + jitterMs);
  if (floor && floor.getTime() + gapMs > candidate.getTime())
    candidate = new Date(floor.getTime() + gapMs);
  return nextOpenInstant(seat, candidate);
}

function parseInstant(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The latest slot this seat already holds, so a new run never lands on top of one. */
async function ledgerFloorFor(db: Db, workspaceId: string, seatKey: string): Promise<Date | null> {
  const row = await db
    .prepare(
      `
    SELECT TO_CHAR(MAX(planned_for) AT TIME ZONE 'UTC', ${UTC_ISO}) AS latest
    FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND status <> 'skipped' AND planned_for IS NOT NULL
  `
    )
    .get<{ latest: string | null }>(workspaceId, seatKey);
  return parseInstant(row?.latest ?? null);
}

/**
 * One profile URL reduced to the key both sides of a target comparison use.
 *
 * Lower-cased, and with any query or fragment removed. `target_ref` is opaque
 * -- whatever a human typed or a CSV supplied, never resolved (022) -- and a
 * harvested LinkedIn href carries `?miniProfileUrn=...` every single time, so
 * `.../in/maya/` and `.../in/maya/?trk=x` are one person filed two ways.
 *
 * It is the JS side of migration 055's
 * `idx_linkedin_actions_workspace_target_ci`, which indexes exactly
 * `LOWER(SPLIT_PART(SPLIT_PART(target_ref, chr(63), 1), '#', 1))`. `leads.ts`
 * carries the same expression against the same index for the same reason --
 * duplicated rather than imported for the reason `withdraw.ts` gives about
 * `targetMatchKeys`: the alternative is a module cycle through three files for
 * one line.
 *
 * `chr(63)` IS THE QUESTION MARK, and it is spelled that way rather than '?'
 * because `Db.prepare` rewrites every `?` in a statement into a positional
 * placeholder before Postgres ever sees it -- including the ones inside string
 * literals. A '?' in this expression would silently become `$1` and shift
 * every real parameter along by one. The migration spells it `chr(63)` too, so
 * the two expressions are textually identical and the planner matches the
 * index.
 */
function targetKey(profileUrl: string): string {
  return profileUrl.split(/[?#]/, 1)[0].toLowerCase();
}

/**
 * Contacts among `profileUrls` that have already answered.
 *
 * Two sources: a ledger row settled `replied`, and an inbound message on a
 * thread resolved to that profile. Batched per campaign rather than asked per
 * member -- 500 members is 500 round trips otherwise.
 *
 * NEITHER ARM NAMES A SEAT, and that is deliberate: a reply to ANY of this
 * workspace's accounts means the campaign's objective is met, and the next
 * scripted follow-up must not arrive on top of it. That is also why
 * `idx_linkedin_actions_target_ci` (031) could not serve the first arm --
 * `seat_key` sits in the middle of it -- so both arms were sequential scans of
 * tables that keep everything forever. Migration 055 adds the two
 * workspace-scoped, case-folded indexes these two predicates are written
 * against.
 *
 * The ledger side compares NORMALISED keys ({@link targetKey}) rather than raw
 * lower-cased ones, so a `replied` row stored with a tracking query stops the
 * workflow for the person it names instead of being invisible to it. The
 * thread side compares `LOWER(profile_url)` because that column is canonical
 * by construction -- `syncThreads` stores `profileUrlFor(...)` output, which
 * carries no query -- and the key side is already normalised, so the two meet.
 */
async function repliedProfiles(
  db: Db,
  workspaceId: string,
  profileUrls: readonly string[]
): Promise<Set<string>> {
  if (profileUrls.length === 0) return new Set();
  const keys = profileUrls.map(targetKey);
  const rows = await db
    .prepare(
      `
    SELECT LOWER(SPLIT_PART(SPLIT_PART(a.target_ref, chr(63), 1), '#', 1)) AS profile FROM linkedin_actions a
      WHERE a.workspace_id=? AND a.status='replied' AND a.target_ref IS NOT NULL
        AND LOWER(SPLIT_PART(SPLIT_PART(a.target_ref, chr(63), 1), '#', 1)) = ANY(?::text[])
    UNION
    SELECT LOWER(t.profile_url) AS profile FROM linkedin_threads t
      JOIN linkedin_messages m ON m.thread_id=t.id AND m.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND t.profile_url IS NOT NULL AND LOWER(t.profile_url) = ANY(?::text[]) AND m.direction='in'
  `
    )
    .all<{ profile: string }>(workspaceId, keys, workspaceId, keys);
  return new Set(rows.map((row) => row.profile));
}

/* -------------------------------------------------------------------------
 * The tick
 * ---------------------------------------------------------------------- */

/** The advisory-lock namespace this tick leases a workspace under. */
const RUNNER_LEASE_NAMESPACE = 'trevra-linkedin-runner';

/**
 * One planning pass for one workspace, and NEVER TWO AT ONCE.
 *
 * Everything below reads a budget and then plans against it: `used` counts the
 * rows already in the ledger's rolling window, `ledgerFloorFor` reads the last
 * slot taken so the next one can be gap-spaced after it. Both are READS, and
 * the writes that answer them land a long way further down -- so two ticks for
 * the same workspace overlapping (the manual `POST /api/linkedin/manager/tick`
 * racing the scheduled one, or two schedulers in a hosted deployment) each saw
 * the same stale snapshot and each planned a full ramp's worth on top of it.
 * The result is close to double the day's intended volume, un-gap-spaced --
 * which is the exact account-risk this whole subsystem exists to prevent.
 *
 * `pg_try_advisory_lock`, not the blocking form: a tick that finds another
 * already running for this workspace RETURNS EMPTY rather than queueing behind
 * it. The work is idempotent per tick and runs again on the next one, so
 * waiting buys nothing and holding an HTTP request open costs a connection.
 * The lease is namespaced and taken on a connection of its own, the same shape
 * `automation-service.ts` uses for the same reason.
 */
export async function runManagedCampaigns(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<RunnerResult> {
  const planned = await db.withConnection('linkedin-runner-lease', async (lease) => {
    const claimed = await lease.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
      [RUNNER_LEASE_NAMESPACE, workspaceId]
    );
    if (!claimed.rows[0]?.locked) {
      return {
        campaignsTicked: 0,
        actionsPlanned: 0,
        manualTasksCreated: 0,
        membersCompleted: 0,
        membersBlocked: 0
      };
    }
    try {
      return await planManagedCampaigns(db, workspaceId, now);
    } finally {
      await lease
        .query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          RUNNER_LEASE_NAMESPACE,
          workspaceId
        ])
        .catch(() => undefined);
    }
  });
  // API-backed channels execute outside the LinkedIn planner lease: a mailbox or webhook
  // network call must never hold the workspace's scheduling lock.
  await runCampaignChannelActions(db, workspaceId, now);
  return planned;
}

type ConditionOutcome = 'yes' | 'no' | 'unknown';

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function scheduleDays(value: unknown): number[] | null {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return null;
  const days = raw.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
  return days.length > 0 ? days : [];
}

function campaignSeatWindow(seat: LinkedInSeat, campaign: CampaignRow): LinkedInSeat {
  const overrideDays = scheduleDays(campaign.schedule_days_json);
  const workingDays =
    overrideDays === null
      ? seat.workingDays
      : seat.workingDays.filter((day) => overrideDays.includes(day));
  const workStartMinute =
    campaign.schedule_start_minute === null
      ? seat.workStartMinute
      : Math.max(seat.workStartMinute, campaign.schedule_start_minute);
  const workEndMinute =
    campaign.schedule_end_minute === null
      ? seat.workEndMinute
      : Math.min(seat.workEndMinute, campaign.schedule_end_minute);
  return { ...seat, workingDays, workStartMinute, workEndMinute };
}

function campaignStartedForSchedule(campaign: CampaignRow, now: Date): boolean {
  const start = parseIso(campaign.scheduled_start_at);
  return !start || now.getTime() >= start.getTime();
}

function campaignAdmissionOpen(campaign: CampaignRow, now: Date): boolean {
  if (!campaignStartedForSchedule(campaign, now)) return false;
  const end = parseIso(campaign.scheduled_end_at);
  return !end || now.getTime() < end.getTime();
}

async function evaluateWorkflowCondition(
  db: Db,
  workspaceId: string,
  member: DueMemberRow,
  condition: Extract<WorkflowStep, { action: 'condition' | 'monitor' }>['config']['condition'],
  probeStepId?: string
): Promise<ConditionOutcome> {
  const branchState = parseJsonObject(member.branch_state_json);
  const key = `condition:${condition.kind}`;
  if (branchState[key] === true) return 'yes';
  if (branchState[key] === false) return 'no';

  if (condition.kind === 'email_available' || condition.kind === 'email_found') {
    return member.email && member.email.trim().length > 0 ? 'yes' : 'no';
  }

  if (condition.kind === 'open_profile') {
    const probe = await db
      .prepare(
        `SELECT external_ref,status FROM linkedin_actions
         WHERE workspace_id=? AND campaign_member_id=? AND kind='profile_view' AND workflow_step_id=?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get<{ external_ref: string | null; status: string }>(
        workspaceId,
        member.id,
        probeStepId ?? ''
      );
    if (probe?.external_ref === 'open-profile:true') return 'yes';
    if (probe?.external_ref === 'open-profile:false') return 'no';
    return 'unknown';
  }

  if (condition.kind === 'connected') {
    const known = await db
      .prepare(
        `SELECT status,failure_kind,external_ref FROM linkedin_actions
         WHERE workspace_id=? AND campaign_member_id=?
           AND (kind='invite' OR (kind='profile_view' AND workflow_step_id=?))
         ORDER BY created_at DESC LIMIT 10`
      )
      .all<{ status: string; failure_kind: string | null; external_ref: string | null }>(
        workspaceId,
        member.id,
        probeStepId ?? ''
      );
    if (
      known.some(
        (row) =>
          row.status === 'accepted' ||
          row.status === 'replied' ||
          row.failure_kind === 'already_connected'
      )
    )
      return 'yes';
    const probe = known.find(
      (row) =>
        typeof row.external_ref === 'string' && row.external_ref.startsWith('connection-degree:')
    );
    if (probe?.external_ref === 'connection-degree:1') return 'yes';
    if (
      probe?.external_ref === 'connection-degree:2' ||
      probe?.external_ref === 'connection-degree:3'
    )
      return 'no';
    return 'unknown';
  }

  if (condition.kind === 'accepted') {
    if (!condition.ofStepId) return 'unknown';
    const action = await db
      .prepare(
        `SELECT status FROM linkedin_actions
         WHERE workspace_id=? AND campaign_member_id=? AND workflow_step_id=? AND kind='invite'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get<{ status: string }>(workspaceId, member.id, condition.ofStepId);
    if (!action) return 'unknown';
    return acceptedTri(action.status as LinkedInActionStatus);
  }

  if (condition.kind === 'replied') {
    if (condition.ofStepId) {
      const action = await db
        .prepare(
          `SELECT status FROM linkedin_actions
           WHERE workspace_id=? AND campaign_member_id=? AND workflow_step_id=?
           ORDER BY created_at DESC LIMIT 1`
        )
        .get<{ status: string }>(workspaceId, member.id, condition.ofStepId);
      if (action) {
        const verdict = repliedTri(action.status as LinkedInActionStatus);
        if (verdict !== 'unknown') return verdict;
      }
    }
    if (member.profile_url) {
      const replied = await repliedProfiles(db, workspaceId, [member.profile_url]);
      if (replied.has(targetKey(member.profile_url))) return 'yes';
    }
    return 'unknown';
  }

  // External-channel and capability evidence is written into branch_state_json by the
  // channel executor. Unknown stays unknown; Monitor is what turns time into a No.
  const externalValue = branchState[`external:${condition.kind}`];
  if (externalValue === true) return 'yes';
  if (externalValue === false) return 'no';
  return 'unknown';
}

function monitorState(branchState: unknown, stepId: string): { startedAt: string | null } {
  const raw = parseJsonObject(branchState)[`monitor:${stepId}`];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { startedAt: null };
  const startedAt = (raw as Record<string, unknown>).startedAt;
  return { startedAt: typeof startedAt === 'string' ? startedAt : null };
}

function branchStatePatch(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value });
}

function stayOnStep(
  stepIndex: number,
  nextEligibleAt: Date | null,
  now: Date,
  branchState: string | null = null
): MemberWrite {
  return {
    stepIndex,
    status: 'waiting',
    nextEligibleAt: nextEligibleAt?.toISOString() ?? null,
    lastActionId: null,
    variants: null,
    branchState,
    updatedAt: now.toISOString()
  };
}

function targetIndexForBranch(steps: readonly WorkflowStep[], targetStepId: string): number | null {
  return indexOfStepId(steps, targetStepId);
}

function queuePriorityForStep(
  step: WorkflowStep,
  stepIndex: number,
  now: Date,
  dueAt: string | null
): number {
  // Continuation before acquisition, then reply-sensitive/message work, then overdue age.
  let score = stepIndex > 0 ? 1_000 : 0;
  if (step.action === 'message' || step.action === 'manual_message' || step.action === 'monitor')
    score += 300;
  if (
    step.action === 'connection_request' ||
    step.action === 'invite_to_follow_company' ||
    step.action === 'invite_to_event' ||
    step.action === 'invite_to_group'
  )
    score += 150;
  if (step.action === 'unfollow' || step.action === 'disconnect') score -= 250;
  if (
    step.action === 'profile_view' ||
    step.action === 'follow' ||
    step.action === 'follow_company' ||
    step.action === 'like_company_post' ||
    step.action === 'like_post' ||
    step.action === 'endorse_skills'
  )
    score += 50;
  if (dueAt) {
    const due = Date.parse(dueAt);
    if (Number.isFinite(due) && due < now.getTime()) {
      const overdueMs = now.getTime() - due;
      score += Math.min(500, Math.floor(overdueMs / 3_600_000));
      if (step.sla) {
        const slaMs = delayMilliseconds(step.sla);
        if (slaMs > 0 && overdueMs >= slaMs) {
          // A breached continuation SLA outranks ordinary continuation age.
          score += 1_000 + Math.min(1_000, Math.floor((overdueMs - slaMs) / 3_600_000));
        }
      }
    }
  }
  return score;
}

function workflowStepsForMember(
  member: Pick<DueMemberRow, 'workflow_snapshot_json'>,
  fallback: readonly WorkflowStep[]
): WorkflowStep[] {
  const snapshot = campaignSnapshotSteps(member.workflow_snapshot_json);
  return snapshot.length > 0 ? snapshot : [...fallback];
}

function campaignPriorityWeight(priority: number): number {
  return priority > 0 ? 4 : priority < 0 ? 1 : 2;
}

function campaignSenderKeys(campaign: CampaignRow): string[] {
  const configured = parseStringArray(campaign.sender_keys_json);
  return configured.length > 0 ? configured : [campaign.seat_key];
}

function campaignPlanningOpen(campaign: CampaignRow, now: Date): boolean {
  if (!campaignStartedForSchedule(campaign, now)) return false;
  const end = parseIso(campaign.scheduled_end_at);
  if (!end || now.getTime() < end.getTime()) return true;
  return campaign.end_behavior === 'finish_waves';
}

/** Capacity buckets this workflow may need while it still has live/pending work. */
function workflowPlanningDemandKinds(steps: readonly WorkflowStep[]): BudgetedKind[] {
  const kinds = new Set<BudgetedKind>();
  for (const step of steps) {
    const kind = budgetKindForStep(step);
    if (kind) kinds.add(kind);
    if (
      (step.action === 'condition' || step.action === 'monitor') &&
      (step.config.condition.kind === 'connected' || step.config.condition.kind === 'open_profile')
    )
      kinds.add('profile_view');
  }
  return [...kinds];
}

function fairQuotaKey(campaignId: string, seatKey: string, kind: BudgetedKind): string {
  return `${campaignId}\u0000${seatKey}\u0000${kind}`;
}

/**
 * Split an integer seat remainder between campaigns. Every demanding campaign
 * receives one slot before priority weights matter when capacity permits. When
 * capacity is scarcer than campaign count, oldest `last_planned_at` wins and is
 * moved to the back when it actually plans work, producing deterministic
 * round-robin starvation protection across ticks.
 */
export function allocateCampaignCapacity(
  total: number,
  campaigns: readonly Pick<CampaignRow, 'id' | 'priority' | 'last_planned_at' | 'created_at'>[]
): Map<string, number> {
  const capacity = Math.max(0, Math.trunc(total));
  const out = new Map(campaigns.map((campaign) => [campaign.id, 0]));
  if (capacity === 0 || campaigns.length === 0) return out;
  const oldest = [...campaigns].sort((left, right) => {
    const la = Date.parse(left.last_planned_at ?? left.created_at);
    const ra = Date.parse(right.last_planned_at ?? right.created_at);
    if (la !== ra) return la - ra;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.id.localeCompare(right.id);
  });
  if (capacity < oldest.length) {
    for (const campaign of oldest.slice(0, capacity)) out.set(campaign.id, 1);
    return out;
  }

  for (const campaign of campaigns) out.set(campaign.id, 1);
  let remaining = capacity - campaigns.length;
  if (remaining <= 0) return out;
  const weightTotal = campaigns.reduce(
    (sum, campaign) => sum + campaignPriorityWeight(campaign.priority),
    0
  );
  const fractions: Array<{ id: string; fraction: number }> = [];
  let assigned = 0;
  for (const campaign of campaigns) {
    const raw = (remaining * campaignPriorityWeight(campaign.priority)) / Math.max(1, weightTotal);
    const whole = Math.floor(raw);
    out.set(campaign.id, (out.get(campaign.id) ?? 0) + whole);
    assigned += whole;
    fractions.push({ id: campaign.id, fraction: raw - whole });
  }
  let leftover = remaining - assigned;
  fractions.sort(
    (left, right) => right.fraction - left.fraction || left.id.localeCompare(right.id)
  );
  for (const row of fractions) {
    if (leftover <= 0) break;
    out.set(row.id, (out.get(row.id) ?? 0) + 1);
    leftover -= 1;
  }
  return out;
}

async function planManagedCampaigns(db: Db, workspaceId: string, now: Date): Promise<RunnerResult> {
  const result: RunnerResult = {
    campaignsTicked: 0,
    actionsPlanned: 0,
    manualTasksCreated: 0,
    membersCompleted: 0,
    membersBlocked: 0
  };

  const campaigns = await db
    .prepare(
      `
    SELECT id,seat_key,sender_keys_json,mailbox_assignments_json,workflow_id,lead_list_id,sequence_json,priority,admission_policy_json,
           scheduled_start_at,scheduled_end_at,schedule_days_json,schedule_start_minute,schedule_end_minute,end_behavior,inmail_credit_cap,last_admission_at,
           TO_CHAR(last_planned_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS last_planned_at,
           TO_CHAR(created_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS created_at,
           TO_CHAR(started_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS started_at
    FROM linkedin_campaigns
    WHERE workspace_id=? AND status='running' AND lead_list_id IS NOT NULL AND workflow_id IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `
    )
    .all<CampaignRow>(workspaceId);
  if (campaigns.length === 0) return result;

  const seats = new Map<string, LinkedInSeat | null>();
  const floors = new Map<string, Date | null>();

  const loadSeat = async (seatKey: string): Promise<LinkedInSeat | null> => {
    if (!seats.has(seatKey)) seats.set(seatKey, (await getSeat(db, workspaceId, seatKey)) ?? null);
    return seats.get(seatKey) ?? null;
  };

  // ONE SEAT BUDGET, shared by every campaign that can spend it this tick.
  // Before this pre-pass, each campaign independently subtracted only its own
  // planned rows from the same seat ceiling. Two campaigns could therefore
  // each plan "the remaining 10" and leave the send-time guard to reject the
  // oversubscription. Fairness must happen before planning, not as a refusal
  // after a browser worker has a queue.
  const windowStart = new Date(now.getTime() - 86_400_000).toISOString();
  const windowEnd = new Date(now.getTime() + 86_400_000).toISOString();
  const cachedSteps = new Map<string, WorkflowStep[]>();
  const cachedUsableSenders = new Map<string, Array<{ key: string; seat: LinkedInSeat }>>();
  const demanders = new Map<string, CampaignRow[]>();
  const seatsInDemand = new Set<string>();

  for (const campaign of campaigns) {
    if (!campaignPlanningOpen(campaign, now)) continue;
    const snapshot = campaignSnapshotSteps(campaign.sequence_json);
    const steps =
      snapshot.length > 0
        ? snapshot
        : ((await getWorkflow(db, workspaceId, campaign.workflow_id))?.steps ?? []);
    if (steps.length === 0) continue;
    cachedSteps.set(campaign.id, steps);

    const live = await db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM linkedin_campaign_members
           WHERE workspace_id=? AND campaign_id=?
             AND status IN ('pending','active','waiting')
         ) AS live`
      )
      .get<{ live: boolean }>(workspaceId, campaign.id);
    if (live?.live !== true) continue;

    const usable: Array<{ key: string; seat: LinkedInSeat }> = [];
    for (const key of campaignSenderKeys(campaign)) {
      const loaded = await loadSeat(key);
      if (!loaded) continue;
      const posture = effectivePosture(loaded, now);
      if (posture === 'paused' || posture === 'cooldown') continue;
      const scoped = campaignSeatWindow(loaded, campaign);
      if (scoped.workingDays.length === 0 || scoped.workEndMinute <= scoped.workStartMinute)
        continue;
      usable.push({ key, seat: scoped });
      seatsInDemand.add(key);
      for (const kind of workflowPlanningDemandKinds(steps)) {
        const mapKey = `${key}\u0000${kind}`;
        const rows = demanders.get(mapKey) ?? [];
        if (!rows.some((row) => row.id === campaign.id)) rows.push(campaign);
        demanders.set(mapKey, rows);
      }
    }
    cachedUsableSenders.set(campaign.id, usable);
  }

  const sharedRemaining = new Map<string, Map<BudgetedKind, number>>();
  const paidInmailSeatRemaining = new Map<string, number>();
  for (const seatKey of seatsInDemand) {
    const seat = await loadSeat(seatKey);
    if (!seat) continue;
    const used = await db
      .prepare(
        `SELECT kind,COUNT(*)::int AS total FROM linkedin_actions
         WHERE workspace_id=? AND seat_key=? AND status<>'skipped'
           AND planned_for IS NOT NULL AND planned_for>=?::timestamptz AND planned_for<=?::timestamptz
           AND kind = ANY(?::text[]) GROUP BY kind`
      )
      .all<{ kind: string; total: number }>(workspaceId, seatKey, windowStart, windowEnd, [
        ...MANAGED_LEDGER_KINDS
      ]);
    const usedByKind = new Map<BudgetedKind, number>();
    for (const row of used) {
      const bucket = budgetKindForLedgerKind(row.kind as LinkedInActionKind);
      if (bucket) usedByKind.set(bucket, (usedByKind.get(bucket) ?? 0) + Number(row.total));
    }
    const inmailUsage = await db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE kind='inmail' AND status<>'skipped')::int AS total,
                COUNT(*) FILTER (WHERE kind='inmail' AND paid_credit_used=TRUE AND status<>'skipped')::int AS paid
         FROM linkedin_actions
         WHERE workspace_id=? AND seat_key=? AND COALESCE(recorded_at,planned_for,created_at)>=?::timestamptz`
      )
      .get<{ total: number; paid: number }>(
        workspaceId,
        seatKey,
        new Date(now.getTime() - 30 * 86_400_000).toISOString()
      );
    const byKind = new Map<BudgetedKind, number>();
    for (const kind of BUDGETED_KINDS) {
      let remaining = Math.max(
        0,
        seatDailyCeilingFor(seat, kind, now) - (usedByKind.get(kind) ?? 0)
      );
      if (kind === 'inmail') {
        const monthlyLimit = seat.inmailMonthlyBudget ?? INMAIL_MONTHLY_QUOTA;
        remaining = Math.min(
          remaining,
          Math.max(0, monthlyLimit - Number(inmailUsage?.total ?? 0))
        );
      }
      byKind.set(kind, remaining);
    }
    sharedRemaining.set(seatKey, byKind);
    paidInmailSeatRemaining.set(
      seatKey,
      Math.max(0, (seat.inmailPaidCreditCap ?? 0) - Number(inmailUsage?.paid ?? 0))
    );
  }

  const fairQuota = new Map<string, number>();
  for (const [mapKey, rows] of demanders) {
    const split = mapKey.indexOf('\u0000');
    const seatKey = mapKey.slice(0, split);
    const kind = mapKey.slice(split + 1) as BudgetedKind;
    const total = sharedRemaining.get(seatKey)?.get(kind) ?? 0;
    for (const [campaignId, quota] of allocateCampaignCapacity(total, rows))
      fairQuota.set(fairQuotaKey(campaignId, seatKey, kind), quota);
  }

  for (const campaign of campaigns) {
    const cached = cachedSteps.get(campaign.id);
    const snapshot = cached ? [] : campaignSnapshotSteps(campaign.sequence_json);
    const steps =
      cached ??
      (snapshot.length > 0
        ? snapshot
        : ((await getWorkflow(db, workspaceId, campaign.workflow_id))?.steps ?? []));
    if (steps.length === 0) continue;

    if (!campaignStartedForSchedule(campaign, now)) continue;
    const endAt = parseIso(campaign.scheduled_end_at);
    const ended = Boolean(endAt && now.getTime() >= endAt.getTime());
    if (ended && campaign.end_behavior === 'stop_immediately') {
      const timestamp = now.toISOString();
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            `UPDATE linkedin_campaigns SET status='stopped',updated_at=? WHERE workspace_id=? AND id=? AND status='running'`
          )
          .run(timestamp, workspaceId, campaign.id);
        await tx
          .prepare(
            `UPDATE linkedin_campaign_members SET status='removed',next_eligible_at=NULL,ended_at=?::timestamptz,updated_at=?::timestamptz WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])`
          )
          .run(timestamp, timestamp, workspaceId, campaign.id, [...LIVE_MEMBER_STATUSES]);
        await tx
          .prepare(
            `UPDATE linkedin_actions SET status='skipped',recorded_at=NULL,claimed_at=NULL WHERE workspace_id=? AND campaign_id=? AND status IN ('planned','held') AND claimed_at IS NULL`
          )
          .run(workspaceId, campaign.id);
      });
      continue;
    }
    if (ended && campaign.end_behavior === 'pause_all') {
      const timestamp = now.toISOString();
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            `UPDATE linkedin_campaigns SET status='paused',paused_at=?::timestamptz,updated_at=?::timestamptz WHERE workspace_id=? AND id=? AND status='running'`
          )
          .run(timestamp, timestamp, workspaceId, campaign.id);
        await tx
          .prepare(
            `UPDATE linkedin_actions SET status='held' WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL`
          )
          .run(workspaceId, campaign.id);
      });
      continue;
    }

    const usableSenders =
      cachedUsableSenders.get(campaign.id) ??
      (await (async () => {
        const usable: Array<{ key: string; seat: LinkedInSeat }> = [];
        for (const key of campaignSenderKeys(campaign)) {
          const loaded = await loadSeat(key);
          if (!loaded) continue;
          const posture = effectivePosture(loaded, now);
          if (posture === 'paused' || posture === 'cooldown') continue;
          const scoped = campaignSeatWindow(loaded, campaign);
          if (scoped.workingDays.length === 0 || scoped.workEndMinute <= scoped.workStartMinute)
            continue;
          usable.push({ key, seat: scoped });
        }
        return usable;
      })());
    for (const sender of usableSenders)
      if (!floors.has(sender.key))
        floors.set(sender.key, await ledgerFloorFor(db, workspaceId, sender.key));
    if (usableSenders.length === 0) {
      const blocked = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? AND status IN ('active','waiting')`
        )
        .get<{ total: number }>(workspaceId, campaign.id);
      result.membersBlocked += blocked?.total ?? 0;
      continue;
    }

    result.campaignsTicked += 1;
    const actionsBeforeCampaign = result.actionsPlanned;
    const admissionOpen = campaignAdmissionOpen(campaign, now);
    if (admissionOpen) {
      await enrolNewContacts(
        db,
        workspaceId,
        { id: campaign.id, leadListId: campaign.lead_list_id, steps },
        now
      );
    } else if (ended && campaign.end_behavior === 'finish_waves') {
      // The audience that never entered a wave must not keep the campaign alive forever.
      await db
        .prepare(
          `UPDATE linkedin_campaign_members SET status='excluded',exclusion_reason='Campaign admission window ended',ended_at=?::timestamptz,updated_at=?::timestamptz
         WHERE workspace_id=? AND campaign_id=? AND status='pending' AND admitted_at IS NULL`
        )
        .run(now.toISOString(), now.toISOString(), workspaceId, campaign.id);
    }

    const budgetBySeat = new Map<string, Map<BudgetedKind, number>>();
    const paidInmailRemainingBySeat = new Map<string, number>();
    for (const sender of usableSenders) {
      // Campaign warm-up is a SECOND, narrower ceiling inside the fair share.
      // Count this campaign's already-planned rows so a rerun of the same tick
      // cannot spend its share twice.
      const used = await db
        .prepare(
          `SELECT kind,COUNT(*)::int AS total FROM linkedin_actions
         WHERE workspace_id=? AND campaign_id=? AND seat_key=? AND status<>'skipped'
           AND planned_for IS NOT NULL AND planned_for>=?::timestamptz AND planned_for<=?::timestamptz
           AND kind = ANY(?::text[]) GROUP BY kind`
        )
        .all<{ kind: string; total: number }>(
          workspaceId,
          campaign.id,
          sender.key,
          windowStart,
          windowEnd,
          [...MANAGED_LEDGER_KINDS]
        );
      const campaignUsed = new Map<BudgetedKind, number>();
      for (const row of used) {
        const bucket = budgetKindForLedgerKind(row.kind as LinkedInActionKind);
        if (bucket) campaignUsed.set(bucket, (campaignUsed.get(bucket) ?? 0) + Number(row.total));
      }
      const budget = new Map<BudgetedKind, number>();
      for (const kind of BUDGETED_KINDS) {
        const fairShare = fairQuota.get(fairQuotaKey(campaign.id, sender.key, kind)) ?? 0;
        const campaignLimit = campaignActionLimit(
          seatDailyCeilingFor(sender.seat, kind, now),
          campaign.started_at,
          now
        );
        budget.set(
          kind,
          Math.min(fairShare, Math.max(0, campaignLimit - (campaignUsed.get(kind) ?? 0)))
        );
      }

      const campaignPaid = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM linkedin_actions
           WHERE workspace_id=? AND campaign_id=? AND seat_key=? AND kind='inmail'
             AND paid_credit_used=TRUE AND status<>'skipped'
             AND COALESCE(recorded_at,planned_for,created_at)>=?::timestamptz`
        )
        .get<{ total: number }>(
          workspaceId,
          campaign.id,
          sender.key,
          new Date(now.getTime() - 30 * 86_400_000).toISOString()
        );
      const campaignPaidRemaining = Math.max(
        0,
        (campaign.inmail_credit_cap ?? 0) - Number(campaignPaid?.total ?? 0)
      );
      paidInmailRemainingBySeat.set(
        sender.key,
        Math.min(paidInmailSeatRemaining.get(sender.key) ?? 0, campaignPaidRemaining)
      );
      budgetBySeat.set(sender.key, budget);
    }

    if (admissionOpen) {
      const counts = await db
        .prepare(
          `SELECT
           COUNT(*) FILTER (WHERE status='pending' AND admitted_at IS NULL)::int AS pending,
           COUNT(*) FILTER (WHERE admitted_at IS NOT NULL AND status IN ('active','waiting','manual','paused'))::int AS in_sequence,
           COUNT(*) FILTER (WHERE admitted_at>=?::timestamptz)::int AS admitted_today
         FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?`
        )
        .get<{ pending: number; in_sequence: number; admitted_today: number }>(
          new Date(now.getTime() - 86_400_000).toISOString(),
          workspaceId,
          campaign.id
        );

      const backlogRows = await db
        .prepare(
          `SELECT step_index,COUNT(*)::int AS total FROM linkedin_campaign_members
         WHERE workspace_id=? AND campaign_id=? AND admitted_at IS NOT NULL AND status IN ('active','waiting')
         GROUP BY step_index`
        )
        .all<{ step_index: number; total: number }>(workspaceId, campaign.id);
      const backlog: Partial<Record<AdmissionKind, number>> = {};
      for (const row of backlogRows) {
        const step = steps[Number(row.step_index)];
        if (!step) continue;
        const kind = admissionKindForStep(step);
        if (kind) backlog[kind] = (backlog[kind] ?? 0) + Number(row.total);
      }
      const available: Partial<Record<AdmissionKind, number>> = {};
      for (const kind of [
        'invite',
        'dm',
        'inmail',
        'profile_view',
        'follow',
        'like',
        'endorse'
      ] as const) {
        available[kind] = usableSenders.reduce(
          (sum, sender) => sum + (budgetBySeat.get(sender.key)?.get(kind) ?? 0),
          0
        );
      }
      const policy = parseJsonObject(campaign.admission_policy_json) as AdmissionPolicy;
      const forecast = await campaignAdmissionForecast(db, workspaceId, campaign.id, now);
      const decision = decideAdmission({
        steps,
        pending: counts?.pending ?? 0,
        inSequence: counts?.in_sequence ?? 0,
        admittedToday: counts?.admitted_today ?? 0,
        available,
        backlog,
        policy,
        lastAdmissionAt: campaign.last_admission_at,
        now,
        acceptanceRate: forecast.acceptanceRate,
        acceptanceSampleSize: forecast.acceptanceSampleSize,
        noReplyRate: forecast.noReplyRate,
        replySampleSize: forecast.replySampleSize,
        outcomeThrottle: forecast.throttle,
        outcomeSampleSize: forecast.outcomeSampleSize,
        outcomeThrottleReason: forecast.reasons.join(' '),
        hasUsableFutureSlot: usableSenders.some(({ seat }) => nextOpenInstant(seat, now) !== null)
      });
      if (decision.admit > 0) {
        const perLeadDemand = workflowAdmissionDemand(steps);
        const hasPacedDemand = Object.values(perLeadDemand).some((demand) => demand > 0);
        const senderCapacities: Record<string, number> = {};
        if (hasPacedDemand) {
          for (const sender of usableSenders) {
            const limits: number[] = [];
            for (const [kind, demand] of Object.entries(perLeadDemand) as Array<
              [AdmissionKind, number]
            >) {
              if (demand <= 0) continue;
              limits.push(
                Math.floor((budgetBySeat.get(sender.key)?.get(kind) ?? 0) / Math.max(1, demand))
              );
            }
            senderCapacities[sender.key] = Math.max(0, Math.min(...limits));
          }
        }
        await admitPendingCampaignMembers(
          db,
          {
            workspaceId,
            campaignId: campaign.id,
            steps,
            decision,
            senderKeys: usableSenders.map((sender) => sender.key),
            ...(hasPacedDemand ? { senderCapacities } : {})
          },
          now
        );
      }
    }

    const members = await db
      .prepare(
        `SELECT m.id,m.contact_id,m.step_index,m.next_eligible_at,m.admitted_at,m.assigned_seat_key,m.workflow_snapshot_json,m.workflow_version,m.assigned_variants,m.branch_state_json,
              l.first_name,l.last_name,l.company,l.email,l.phone,l.country,l.profile_url,l.custom_fields_json
       FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
       WHERE m.workspace_id=? AND m.campaign_id=? AND m.status IN ('active','waiting')
         AND m.admitted_at IS NOT NULL AND (m.next_eligible_at IS NULL OR m.next_eligible_at<=?::timestamptz)
       ORDER BY (CASE WHEN m.step_index>0 THEN 1 ELSE 0 END) DESC,
                m.queue_priority DESC,m.next_eligible_at ASC NULLS FIRST,m.admitted_at ASC,m.id ASC
       LIMIT ${MEMBER_BATCH}`
      )
      .all<DueMemberRow>(workspaceId, campaign.id, now.toISOString());

    // Apply action-aware priority without losing the SQL's deterministic tie-breaks.
    members.sort((left, right) => {
      const leftSteps = workflowStepsForMember(left, steps);
      const rightSteps = workflowStepsForMember(right, steps);
      const a = leftSteps[Number(left.step_index)];
      const b = rightSteps[Number(right.step_index)];
      const aScore = a
        ? queuePriorityForStep(a, Number(left.step_index), now, left.next_eligible_at)
        : 0;
      const bScore = b
        ? queuePriorityForStep(b, Number(right.step_index), now, right.next_eligible_at)
        : 0;
      return bScore - aScore;
    });

    const replied = await repliedProfiles(
      db,
      workspaceId,
      members.map((member) => member.profile_url).filter((url): url is string => Boolean(url))
    );

    const manualTaskIds: string[] = [];
    const manualTaskMemberIds: string[] = [];
    const manualTaskContactIds: string[] = [];
    const manualTaskStepIds: string[] = [];
    const manualTaskBodies: Array<string | null> = [];
    const manualTaskSeatKeys: string[] = [];
    const memberWrites = new Map<string, MemberWrite>();

    await db.transaction(async (tx) => {
      for (const member of members) {
        const nowIso = now.toISOString();
        const stepIndex = Number(member.step_index);
        const executionSteps = workflowStepsForMember(member, steps);
        const step = executionSteps[stepIndex];
        const senderKey =
          member.assigned_seat_key && budgetBySeat.has(member.assigned_seat_key)
            ? member.assigned_seat_key
            : usableSenders[0].key;
        const seat =
          usableSenders.find((candidate) => candidate.key === senderKey)?.seat ??
          usableSenders[0].seat;
        const budget = budgetBySeat.get(senderKey)!;
        const lead = {
          firstName: member.first_name,
          lastName: member.last_name,
          company: member.company,
          email: member.email,
          phone: member.phone,
          country: member.country,
          customFields: parseJsonObject(member.custom_fields_json) as Record<
            string,
            string | number | boolean | null | undefined
          >
        };

        if (!step) {
          memberWrites.set(member.id, {
            stepIndex,
            status: 'completed',
            nextEligibleAt: null,
            lastActionId: null,
            variants: null,
            branchState: null,
            updatedAt: nowIso
          });
          result.membersCompleted += 1;
          continue;
        }

        const hasReply = Boolean(member.profile_url && replied.has(targetKey(member.profile_url)));
        if (hasReply) {
          if (
            (step.action === 'condition' || step.action === 'monitor') &&
            step.config.condition.kind === 'replied'
          ) {
            const target = targetIndexForBranch(executionSteps, step.config.yesStepId);
            const transitioned = transitionMember({
              targetIndex: target,
              steps: executionSteps,
              from: now,
              actionId: null,
              now,
              branchState: branchStatePatch(`branch:${step.id}`, { outcome: 'yes', at: nowIso })
            });
            memberWrites.set(member.id, transitioned.write);
            if (transitioned.completed) result.membersCompleted += 1;
          } else {
            memberWrites.set(member.id, {
              stepIndex,
              status: 'replied',
              nextEligibleAt: null,
              lastActionId: null,
              variants: null,
              branchState: null,
              updatedAt: nowIso
            });
          }
          continue;
        }

        if (step.action === 'wait') {
          const waitUntil = new Date(now.getTime() + delayMilliseconds(step.config.duration));
          const transitioned = transitionMember({
            targetIndex: nextStepIndex(executionSteps, stepIndex),
            steps: executionSteps,
            from: waitUntil,
            actionId: null,
            now,
            branchState: branchStatePatch(`wait:${step.id}`, {
              completedAt: waitUntil.toISOString()
            })
          });
          memberWrites.set(member.id, transitioned.write);
          if (transitioned.completed) result.membersCompleted += 1;
          continue;
        }

        if (step.action === 'end') {
          const terminal =
            step.config.outcome === 'replied'
              ? 'replied'
              : step.config.outcome === 'excluded'
                ? 'excluded'
                : 'completed';
          memberWrites.set(member.id, {
            stepIndex,
            status: terminal,
            nextEligibleAt: null,
            lastActionId: null,
            variants: null,
            branchState: branchStatePatch(`end:${step.id}`, {
              outcome: step.config.outcome,
              at: nowIso
            }),
            updatedAt: nowIso
          });
          if (terminal === 'completed') result.membersCompleted += 1;
          continue;
        }

        if (step.action === 'condition' || step.action === 'monitor') {
          const verdict = await evaluateWorkflowCondition(
            tx,
            workspaceId,
            member,
            step.config.condition,
            step.id
          );
          const branchTarget = (outcome: 'yes' | 'no') =>
            targetIndexForBranch(
              executionSteps,
              outcome === 'yes' ? step.config.yesStepId : step.config.noStepId
            );

          if (verdict === 'yes' || verdict === 'no') {
            const transitioned = transitionMember({
              targetIndex: branchTarget(verdict),
              steps: executionSteps,
              from: now,
              actionId: null,
              now,
              branchState: branchStatePatch(`branch:${step.id}`, { outcome: verdict, at: nowIso })
            });
            memberWrites.set(member.id, transitioned.write);
            if (transitioned.completed) result.membersCompleted += 1;
            continue;
          }

          // An initial connection-status decision is the one condition for which "unknown"
          // can be resolved by Trevra itself. The probe is filed as a real profile view and
          // consumes the same budget as any other view.
          if (
            step.config.condition.kind === 'connected' ||
            step.config.condition.kind === 'open_profile'
          ) {
            if (!member.profile_url) {
              memberWrites.set(member.id, {
                stepIndex,
                status: 'failed',
                nextEligibleAt: null,
                lastActionId: null,
                variants: null,
                branchState: null,
                updatedAt: nowIso
              });
              result.membersBlocked += 1;
              continue;
            }
            const remaining = budget.get('profile_view') ?? 0;
            if (remaining <= 0) continue;
            const plannedFor = scheduleSlot(
              seat,
              now,
              floors.get(senderKey) ?? null,
              `${member.id}:${step.id}:connection-probe`
            );
            if (!plannedFor) {
              result.membersBlocked += 1;
              continue;
            }
            const written = await recordAction(
              tx,
              {
                workspaceId,
                seatKey: senderKey,
                kind: 'profile_view',
                targetRef: member.profile_url,
                campaignId: campaign.id,
                status: 'planned',
                plannedFor: plannedFor.toISOString(),
                source: 'campaign',
                replayScope: `${member.id}:${step.id}:${step.config.condition.kind}-probe`
              },
              now
            );
            if (!written.duplicate) {
              await tx
                .prepare(
                  `UPDATE linkedin_actions SET campaign_member_id=?,workflow_step_id=?,queue_priority=?,sla_deadline_at=?::timestamptz,channel_metadata_json=?::jsonb
                 WHERE id=? AND workspace_id=?`
                )
                .run(
                  member.id,
                  step.id,
                  queuePriorityForStep(step, stepIndex, now, nowIso),
                  step.sla
                    ? new Date(now.getTime() + delayMilliseconds(step.sla)).toISOString()
                    : null,
                  JSON.stringify(
                    step.config.condition.kind === 'connected'
                      ? { connectionProbe: true }
                      : { openProfileProbe: true }
                  ),
                  written.id,
                  workspaceId
                );
              budget.set('profile_view', remaining - 1);
              floors.set(senderKey, plannedFor);
              result.actionsPlanned += 1;
            }
            memberWrites.set(
              member.id,
              stayOnStep(stepIndex, new Date(plannedFor.getTime() + 3_600_000), now)
            );
            continue;
          }

          if (step.action === 'condition') {
            const transitioned = transitionMember({
              targetIndex: branchTarget('no'),
              steps: executionSteps,
              from: now,
              actionId: null,
              now,
              branchState: branchStatePatch(`branch:${step.id}`, {
                outcome: 'no',
                at: nowIso,
                reason: 'unknown treated as false by one-time condition'
              })
            });
            memberWrites.set(member.id, transitioned.write);
            if (transitioned.completed) result.membersCompleted += 1;
            continue;
          }

          const state = monitorState(member.branch_state_json, step.id);
          const startedAt = parseIso(state.startedAt) ?? now;
          const timeoutAt = new Date(startedAt.getTime() + delayMilliseconds(step.config.timeout));
          if (now.getTime() >= timeoutAt.getTime()) {
            const transitioned = transitionMember({
              targetIndex: branchTarget('no'),
              steps: executionSteps,
              from: now,
              actionId: null,
              now,
              branchState: branchStatePatch(`branch:${step.id}`, {
                outcome: 'no',
                at: nowIso,
                reason: 'monitor timeout'
              })
            });
            memberWrites.set(member.id, transitioned.write);
            if (transitioned.completed) result.membersCompleted += 1;
          } else {
            const pollAt = new Date(
              Math.min(timeoutAt.getTime(), now.getTime() + step.config.pollEveryMinutes * 60_000)
            );
            memberWrites.set(
              member.id,
              stayOnStep(
                stepIndex,
                pollAt,
                now,
                state.startedAt
                  ? null
                  : branchStatePatch(`monitor:${step.id}`, { startedAt: startedAt.toISOString() })
              )
            );
          }
          continue;
        }

        // Legacy acceptance gate remains valid for old workflows; new graph workflows normally
        // express the same rule with Monitor(accepted).
        if (step.action === 'message' && step.config.requiresAcceptedConnection) {
          const invite = await tx
            .prepare(
              `SELECT id,status,TO_CHAR(COALESCE(pending_since,recorded_at) AT TIME ZONE 'UTC', ${UTC_ISO}) AS sent_at
             FROM linkedin_actions WHERE workspace_id=? AND campaign_member_id=? AND kind='invite'
             ORDER BY created_at DESC LIMIT 1`
            )
            .get<InviteRow>(workspaceId, member.id);
          const accepted = invite && ['accepted', 'replied'].includes(invite.status);
          if (!accepted) {
            const terminalNegative =
              invite && ['declined', 'withdrawn', 'skipped'].includes(invite.status);
            const nextWithdraw = executionSteps
              .slice(stepIndex + 1)
              .find(
                (candidate): candidate is Extract<WorkflowStep, { action: 'withdraw_pending' }> =>
                  candidate.action === 'withdraw_pending'
              );
            const sentAt = invite ? parseInstant(invite.sent_at) : null;
            const staleAt =
              nextWithdraw && sentAt
                ? new Date(sentAt.getTime() + nextWithdraw.config.afterDays * 86_400_000)
                : null;
            const stale = staleAt !== null && now.getTime() >= staleAt.getTime();
            if (terminalNegative || stale) {
              const advanced = advanceMember({
                stepIndex,
                steps: executionSteps,
                from: now,
                actionId: null,
                now
              });
              memberWrites.set(member.id, advanced.write);
              if (advanced.completed) result.membersCompleted += 1;
              continue;
            }
            const recheckAt = new Date(now.getTime() + UNSENT_INVITE_RECHECK_MS);
            const nextCheck =
              staleAt && staleAt.getTime() < recheckAt.getTime() ? staleAt : recheckAt;
            memberWrites.set(member.id, stayOnStep(stepIndex, nextCheck, now));
            continue;
          }
        }

        if (step.action === 'manual_message' || step.action === 'manual_comment') {
          const template = step.config.suggestedTemplate ?? '';
          const suggested =
            template.trim().length > 0 ? renderWorkflowTemplate(template, lead) : null;
          manualTaskIds.push(id('limt'));
          manualTaskMemberIds.push(member.id);
          manualTaskContactIds.push(member.contact_id);
          manualTaskStepIds.push(step.id);
          manualTaskBodies.push(suggested);
          manualTaskSeatKeys.push(senderKey);
          memberWrites.set(member.id, {
            stepIndex,
            status: 'manual',
            nextEligibleAt: null,
            lastActionId: null,
            variants: null,
            branchState: null,
            updatedAt: nowIso
          });
          continue;
        }

        if (step.action === 'withdraw_pending') {
          const outcome = await handleWithdrawStep(tx, {
            workspaceId,
            seatKey: senderKey,
            memberId: member.id,
            afterDays: step.config.afterDays,
            now
          });
          if (outcome.waitUntil) {
            memberWrites.set(member.id, stayOnStep(stepIndex, outcome.waitUntil, now));
            continue;
          }
          const advanced = advanceMember({
            stepIndex,
            steps: executionSteps,
            from: now,
            actionId: null,
            now
          });
          memberWrites.set(member.id, advanced.write);
          if (advanced.completed) result.membersCompleted += 1;
          continue;
        }

        if (step.action === 'add_tag' || step.action === 'remove_tag') {
          const contact = await tx
            .prepare(
              `SELECT tags_json FROM linkedin_lead_contacts WHERE workspace_id=? AND id=? FOR UPDATE`
            )
            .get<{ tags_json: unknown }>(workspaceId, member.contact_id);
          const tags = new Set(parseStringArray(contact?.tags_json));
          if (step.action === 'add_tag') tags.add(step.config.tag);
          else tags.delete(step.config.tag);
          await tx
            .prepare(
              `UPDATE linkedin_lead_contacts SET tags_json=?::jsonb,updated_at=? WHERE workspace_id=? AND id=?`
            )
            .run(JSON.stringify([...tags]), nowIso, workspaceId, member.contact_id);
          const advanced = advanceMember({
            stepIndex,
            steps: executionSteps,
            from: now,
            actionId: null,
            now
          });
          memberWrites.set(member.id, advanced.write);
          if (advanced.completed) result.membersCompleted += 1;
          continue;
        }

        if (
          step.action === 'email' ||
          step.action === 'find_email' ||
          step.action === 'webhook' ||
          step.action === 'external_handoff'
        ) {
          const existing = await tx
            .prepare(
              `SELECT status FROM linkedin_campaign_channel_actions
               WHERE workspace_id=? AND member_id=? AND workflow_step_id=?
               ORDER BY created_at DESC LIMIT 1`
            )
            .get<{ status: string }>(workspaceId, member.id, step.id);
          if (existing) {
            if (existing.status === 'unknown') {
              memberWrites.set(
                member.id,
                stayOnStep(stepIndex, new Date(now.getTime() + 24 * 3_600_000), now)
              );
            } else if (existing.status === 'planned' || existing.status === 'claimed') {
              memberWrites.set(
                member.id,
                stayOnStep(stepIndex, new Date(now.getTime() + 5 * 60_000), now)
              );
            }
            // Known outcomes are advanced by campaign-channels.ts. If the member is still
            // here, a later tick will see the channel executor's state update rather than
            // planning the side effect a second time.
            continue;
          }

          if (step.action === 'email' && (!member.email || !member.email.trim())) {
            const advanced = advanceMember({
              stepIndex,
              steps: executionSteps,
              from: now,
              actionId: null,
              now
            });
            memberWrites.set(member.id, {
              ...advanced.write,
              branchState: branchStatePatch('external:email_available', false)
            });
            if (advanced.completed) result.membersCompleted += 1;
            continue;
          }

          let payload: Record<string, unknown>;
          let variantId: string | null = null;
          if (step.action === 'email') {
            const assigned = parseVariants(member.assigned_variants)[step.id];
            const variant =
              step.config.variants.find((candidate) => candidate.id === assigned) ??
              chooseMessageVariant(step.config.variants, `${member.id}:${step.id}`);
            variantId = variant.id;
            payload = {
              recipient: member.email,
              subject: renderWorkflowTemplate(step.config.subject, lead),
              body: renderWorkflowTemplate(variant.body, lead),
              threaded: step.config.threaded,
              tracking: step.config.tracking
            };
          } else if (step.action === 'find_email') {
            payload = { providerId: step.config.providerId ?? null, refresh: step.config.refresh };
          } else if (step.action === 'webhook') {
            payload = {
              url: step.config.url,
              method: step.config.method,
              body: renderWorkflowTemplate(step.config.bodyTemplate, lead),
              provider: 'webhook'
            };
          } else {
            payload = {
              provider: step.config.provider,
              destination: step.config.destination,
              payload: renderWorkflowTemplate(step.config.payloadTemplate, lead)
            };
          }
          const mailboxMap = parseJsonObject(campaign.mailbox_assignments_json);
          const connectionId =
            step.action === 'email' && typeof mailboxMap[senderKey] === 'string'
              ? String(mailboxMap[senderKey])
              : null;
          const channelId = id('licha');
          const idempotencyKey = createHash('sha256')
            .update(`${workspaceId}:${campaign.id}:${member.id}:${step.id}`)
            .digest('hex');
          await tx
            .prepare(
              `INSERT INTO linkedin_campaign_channel_actions (
                 id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,variant_id,idempotency_key,connection_id,created_at,updated_at
               ) VALUES (?,?,?,?,?,?,?,'planned',?::timestamptz,?::jsonb,?,?,?,?::timestamptz,?::timestamptz)
               ON CONFLICT (workspace_id,idempotency_key) DO NOTHING`
            )
            .run(
              channelId,
              workspaceId,
              campaign.id,
              member.id,
              member.contact_id,
              step.id,
              step.action,
              nowIso,
              JSON.stringify(payload),
              variantId,
              idempotencyKey,
              connectionId,
              nowIso,
              nowIso
            );
          memberWrites.set(member.id, {
            ...stayOnStep(stepIndex, new Date(now.getTime() + 5 * 60_000), now),
            variants: variantId ? JSON.stringify({ [step.id]: variantId }) : null
          });
          continue;
        }

        const ledgerKind = ledgerKindForStep(step);
        const budgetKind = budgetKindForStep(step);
        if (!ledgerKind || !budgetKind) continue;
        if (!member.profile_url) {
          memberWrites.set(member.id, {
            stepIndex,
            status: 'failed',
            nextEligibleAt: null,
            lastActionId: null,
            variants: null,
            branchState: null,
            updatedAt: nowIso
          });
          result.membersBlocked += 1;
          continue;
        }

        if (ledgerKind === 'inmail' && seat.capabilities.inmail !== 'available') {
          memberWrites.set(
            member.id,
            stayOnStep(
              stepIndex,
              new Date(now.getTime() + 24 * 3_600_000),
              now,
              branchStatePatch(`blocked:${step.id}`, {
                reason: `InMail capability is ${seat.capabilities.inmail}.`,
                at: nowIso
              })
            )
          );
          result.membersBlocked += 1;
          continue;
        }

        const remaining = budget.get(budgetKind) ?? 0;
        if (remaining <= 0) continue;

        let variantId: string | null = null;
        let body: string | null = null;
        let subject: string | null = null;
        let attachment: Record<string, unknown> | null = null;
        if (step.action === 'connection_request') {
          if (step.config.variants && step.config.variants.length > 0) {
            const assigned = parseVariants(member.assigned_variants)[step.id];
            const variant =
              step.config.variants.find((candidate) => candidate.id === assigned) ??
              chooseMessageVariant(step.config.variants, `${member.id}:${step.id}`);
            variantId = variant.id;
            body =
              variant.body.trim().length > 0 ? renderWorkflowTemplate(variant.body, lead) : null;
          } else {
            const template = step.config.message ?? '';
            body = template.trim().length > 0 ? renderWorkflowTemplate(template, lead) : null;
          }
        } else if (
          step.action === 'message' ||
          step.action === 'inmail' ||
          step.action === 'group_message' ||
          step.action === 'event_message'
        ) {
          const assigned = parseVariants(member.assigned_variants)[step.id];
          const variant =
            step.config.variants.find((candidate) => candidate.id === assigned) ??
            chooseMessageVariant(step.config.variants, `${member.id}:${step.id}`);
          variantId = variant.id;
          body = renderWorkflowTemplate(variant.body, lead);
          if (step.action === 'inmail') subject = renderWorkflowTemplate(step.config.subject, lead);
          if (variant.attachmentUrl)
            attachment = {
              url: variant.attachmentUrl,
              name: variant.attachmentName ?? null,
              mediaKind: variant.mediaKind ?? 'file'
            };
        }

        const plannedFor = scheduleSlot(
          seat,
          now,
          floors.get(senderKey) ?? null,
          `${member.id}:${step.id}`
        );
        if (!plannedFor) {
          result.membersBlocked += 1;
          continue;
        }
        const written = await recordAction(
          tx,
          {
            workspaceId,
            seatKey: senderKey,
            kind: ledgerKind,
            targetRef: member.profile_url,
            campaignId: campaign.id,
            status: 'planned',
            plannedFor: plannedFor.toISOString(),
            source: 'campaign',
            replayScope: `${member.id}:${step.id}`
          },
          now
        );
        if (!written.duplicate) {
          await tx
            .prepare(
              `UPDATE linkedin_actions SET body=?,subject=?,campaign_member_id=?,workflow_step_id=?,variant_id=?,queue_priority=?,sla_deadline_at=?::timestamptz,attachment_json=?::jsonb,channel_metadata_json=?::jsonb
             WHERE id=? AND workspace_id=?`
            )
            .run(
              body,
              subject,
              member.id,
              step.id,
              variantId,
              queuePriorityForStep(step, stepIndex, now, plannedFor.toISOString()),
              step.sla
                ? new Date(plannedFor.getTime() + delayMilliseconds(step.sla)).toISOString()
                : null,
              attachment ? JSON.stringify(attachment) : null,
              JSON.stringify(
                step.action === 'endorse_skills'
                  ? { maxSkills: step.config.maxSkills }
                  : step.action === 'inmail'
                    ? {
                        allowPaid:
                          step.config.allowPaid &&
                          (paidInmailRemainingBySeat.get(senderKey) ?? 0) > 0,
                        paidCreditCapRemaining: paidInmailRemainingBySeat.get(senderKey) ?? 0
                      }
                    : step.action === 'follow_company' ||
                        step.action === 'like_company_post' ||
                        step.action === 'invite_to_follow_company'
                      ? { companyUrl: step.config.companyUrl }
                      : step.action === 'invite_to_event' || step.action === 'event_message'
                        ? { eventUrl: step.config.eventUrl }
                        : step.action === 'invite_to_group' || step.action === 'group_message'
                          ? { groupUrl: step.config.groupUrl }
                          : {}
              ),
              written.id,
              workspaceId
            );
          result.actionsPlanned += 1;
          budget.set(budgetKind, remaining - 1);
          floors.set(senderKey, plannedFor);
        }

        const advanced = advanceMember({
          stepIndex,
          steps,
          from: plannedFor,
          actionId: written.id,
          now
        });
        memberWrites.set(member.id, {
          ...advanced.write,
          variants: variantId === null ? null : JSON.stringify({ [step.id]: variantId })
        });
        if (advanced.completed) result.membersCompleted += 1;
      }

      if (manualTaskIds.length > 0) {
        const inserted = await tx
          .prepare(
            `INSERT INTO linkedin_manual_tasks (
             id,workspace_id,campaign_id,member_id,contact_id,seat_key,workflow_step_id,suggested_body,status,created_at
           ) SELECT * FROM unnest(
             ?::text[],?::text[],?::text[],?::text[],?::text[],?::text[],?::text[],?::text[],?::text[],?::timestamptz[]
           ) ON CONFLICT DO NOTHING RETURNING id`
          )
          .all<{ id: string }>(
            manualTaskIds,
            manualTaskIds.map(() => workspaceId),
            manualTaskIds.map(() => campaign.id),
            manualTaskMemberIds,
            manualTaskContactIds,
            manualTaskSeatKeys,
            manualTaskStepIds,
            manualTaskBodies,
            manualTaskIds.map(() => 'pending'),
            manualTaskIds.map(() => now.toISOString())
          );
        result.manualTasksCreated += inserted.length;
      }
      await flushMemberWrites(tx, workspaceId, memberWrites);
    });

    if (result.actionsPlanned > actionsBeforeCampaign) {
      await db
        .prepare(
          `UPDATE linkedin_campaigns SET last_planned_at=?::timestamptz,updated_at=?::timestamptz
           WHERE workspace_id=? AND id=?`
        )
        .run(now.toISOString(), now.toISOString(), workspaceId, campaign.id);
    }

    const live = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])`
      )
      .get<{ total: number }>(workspaceId, campaign.id, [...LIVE_MEMBER_STATUSES]);
    if ((live?.total ?? 0) === 0) {
      await db
        .prepare(
          `UPDATE linkedin_campaigns SET status='completed',updated_at=? WHERE workspace_id=? AND id=? AND status='running'`
        )
        .run(now.toISOString(), workspaceId, campaign.id);
    }
  }
  return result;
}

/**
 * What one member's row should say after this tick.
 *
 * A VALUE, NOT A WRITE, and that is the whole point of it existing. Every
 * branch of the member loop produces one of these and the loop flushes them
 * together; nothing in the loop issues a single-row UPDATE any more.
 */
interface MemberWrite {
  stepIndex: number;
  status: string;
  nextEligibleAt: string | null;
  lastActionId: string | null;
  /** A jsonb object merged into `assigned_variants`, or null to leave it alone. */
  variants: string | null;
  /** A jsonb object merged into branch/monitor state, or null to leave it alone. */
  branchState: string | null;
  updatedAt: string;
}

/**
 * `step_index+1`, and the delay the NEXT step declares.
 *
 * THIS IS WHERE PER-STEP DELAYS BECOME REAL. `delayBefore` is measured from the
 * slot the step just planned, not from the tick that planned it: a message due
 * "two days after the invite" means after the invite's own slot, and measuring
 * from `now` would compound every tick's scheduling drift into the sequence.
 *
 * It takes no database handle: the arithmetic was always the interesting part
 * and the UPDATE was always the same one. Returning the row state lets 500
 * members share one statement instead of paying a round trip each.
 */
function indexOfStepId(
  steps: readonly WorkflowStep[],
  stepId: string | null | undefined
): number | null {
  if (!stepId) return null;
  const index = steps.findIndex((step) => step.id === stepId);
  return index >= 0 ? index : null;
}

function nextStepIndex(steps: readonly WorkflowStep[], stepIndex: number): number | null {
  const step = steps[stepIndex];
  if (!step) return null;
  if (step.nextStepId === null) return null;
  if (step.nextStepId) return indexOfStepId(steps, step.nextStepId);
  const next = stepIndex + 1;
  return next < steps.length ? next : null;
}

function transitionMember(input: {
  targetIndex: number | null;
  steps: readonly WorkflowStep[];
  from: Date;
  actionId: string | null;
  now: Date;
  branchState?: string | null;
}): { write: MemberWrite; completed: boolean } {
  const nextStep = input.targetIndex === null ? null : input.steps[input.targetIndex];
  const status = nextStep ? 'waiting' : 'completed';
  const nextEligible = nextStep
    ? new Date(input.from.getTime() + delayMilliseconds(nextStep.delayBefore)).toISOString()
    : null;
  return {
    write: {
      stepIndex: input.targetIndex ?? input.steps.length,
      status,
      nextEligibleAt: nextEligible,
      lastActionId: input.actionId,
      variants: null,
      branchState: input.branchState ?? null,
      updatedAt: input.now.toISOString()
    },
    completed: !nextStep
  };
}

function advanceMember(input: {
  stepIndex: number;
  steps: readonly WorkflowStep[];
  from: Date;
  actionId: string | null;
  now: Date;
  branchState?: string | null;
}): { write: MemberWrite; completed: boolean } {
  return transitionMember({
    targetIndex: nextStepIndex(input.steps, input.stepIndex),
    steps: input.steps,
    from: input.from,
    actionId: input.actionId,
    now: input.now,
    branchState: input.branchState
  });
}

/**
 * Every member decision this tick made, in one statement.
 *
 * The column list is the union of what the six single-row UPDATEs it replaces
 * wrote, and each one keeps its own semantics rather than being flattened into
 * a blanket overwrite:
 *
 *   - `last_action_id` is COALESCEd, so a member that planned nothing this
 *     tick keeps the action id it already had -- the same `COALESCE(?,
 *     last_action_id)` `advanceMember`'s UPDATE carried;
 *   - `assigned_variants` is MERGED and only when this tick chose a variant,
 *     which is what the separate `|| ?::jsonb` update did. A null leaves the
 *     column exactly as it was rather than clearing an A/B assignment made on
 *     an earlier tick;
 *   - `step_index` is written on every branch because every branch knows it:
 *     the terminal statuses restate the member's current step and only the
 *     advancing ones move it.
 *
 * `workspace_id` is in the WHERE clause for the reason it is everywhere else
 * in this subsystem: a member id is a global identifier.
 */
async function flushMemberWrites(
  db: Db,
  workspaceId: string,
  writes: Map<string, MemberWrite>
): Promise<void> {
  if (writes.size === 0) return;
  const entries = [...writes.entries()];
  await db
    .prepare(
      `
    UPDATE linkedin_campaign_members m
    SET step_index = w.step_index,
        status = w.status,
        next_eligible_at = w.next_eligible_at,
        last_action_id = COALESCE(w.last_action_id, m.last_action_id),
        assigned_variants = CASE
          WHEN w.variants IS NULL THEN m.assigned_variants
          ELSE COALESCE(m.assigned_variants, '{}'::jsonb) || w.variants
        END,
        branch_state_json = CASE
          WHEN w.branch_state IS NULL THEN m.branch_state_json
          ELSE COALESCE(m.branch_state_json, '{}'::jsonb) || w.branch_state
        END,
        updated_at = w.updated_at
    FROM unnest(?::text[], ?::int[], ?::text[], ?::timestamptz[], ?::text[], ?::jsonb[], ?::jsonb[], ?::timestamptz[])
      AS w(id, step_index, status, next_eligible_at, last_action_id, variants, branch_state, updated_at)
    WHERE m.workspace_id=? AND m.id = w.id
  `
    )
    .run(
      entries.map(([memberId]) => memberId),
      entries.map(([, write]) => write.stepIndex),
      entries.map(([, write]) => write.status),
      entries.map(([, write]) => write.nextEligibleAt),
      entries.map(([, write]) => write.lastActionId),
      entries.map(([, write]) => write.variants),
      entries.map(([, write]) => write.branchState),
      entries.map(([, write]) => write.updatedAt),
      workspaceId
    );
}

/**
 * The withdraw step, which is the one step that acts on a row it did not write.
 *
 * It reads the invite THIS MEMBER's earlier connection_request produced --
 * `campaign_member_id` is what makes that a lookup rather than a guess -- and
 * hands it to the existing withdrawal subsystem. No withdrawal logic is
 * duplicated here: `selectWithdrawalCandidates` still decides what is
 * withdrawable and `enqueueWithdrawals` still owns the idempotency, this only
 * scopes them to one action id with the workflow's own `afterDays`.
 *
 * AGE IS MEASURED FROM WHEN THE INVITE WAS ACTUALLY SENT --
 * COALESCE(pending_since, recorded_at): LinkedIn's word about when the
 * recipient got it, ours about when it went out. `planned_for` used to be a
 * third fallback, and it was the bug: it dated an invite that HAS NOT BEEN
 * SENT by the slot it is still waiting for.
 *
 * The consequence was a member skipping its own withdraw step. Once
 * `afterDays` elapsed from the SLOT, this function called the invite stale and
 * asked `selectWithdrawalCandidates` for it -- which requires
 * `status IN ('sent','exported')`, so a row still sitting at 'planned'
 * returned an empty list, nothing was queued, and the member advanced past the
 * step as though the withdrawal had been handled. Every ordinary reason for a
 * queued invite to sit there produced it: the worker off for a few days, the
 * seat cooling, a paused campaign, a slot further out than `afterDays`.
 *
 * So an unsent invite HOLDS the member instead. There is nothing to withdraw
 * yet and there may be something to withdraw later, and those are the same
 * answer: wait. It is re-checked on {@link UNSENT_INVITE_RECHECK_MS} rather
 * than woken at a computed instant, because the instant this step is really
 * waiting for -- when the worker sends the thing -- is not knowable from here.
 */
async function handleWithdrawStep(
  db: Db,
  input: { workspaceId: string; seatKey: string; memberId: string; afterDays: number; now: Date }
): Promise<{ waitUntil: Date | null }> {
  const invite = await db
    .prepare(
      `
    SELECT id, status,
           TO_CHAR(COALESCE(pending_since, recorded_at) AT TIME ZONE 'UTC', ${UTC_ISO}) AS sent_at
    FROM linkedin_actions
    WHERE workspace_id=? AND campaign_member_id=? AND kind='invite'
    ORDER BY created_at DESC LIMIT 1
  `
    )
    .get<InviteRow>(input.workspaceId, input.memberId);

  // Nothing to withdraw, or already decided one way or the other: the step has
  // no work and the workflow moves on. 'skipped' is in the list because a
  // stopped campaign or a removed member releases its queue that way -- there
  // is no invite outstanding and there never will be.
  if (!invite) return { waitUntil: null };
  if (['accepted', 'replied', 'declined', 'withdrawn', 'skipped'].includes(invite.status))
    return { waitUntil: null };

  const sentAt = parseInstant(invite.sent_at);
  // Queued but not sent (planned, or held by a pause). The withdrawal clock
  // has not started, so the member waits rather than advancing past a step
  // that would have had work to do.
  if (!sentAt) return { waitUntil: new Date(input.now.getTime() + UNSENT_INVITE_RECHECK_MS) };
  const staleAt = new Date(sentAt.getTime() + input.afterDays * 86_400_000);
  if (input.now.getTime() < staleAt.getTime()) return { waitUntil: staleAt };

  const seat = { workspaceId: input.workspaceId, seatKey: input.seatKey };
  const candidates = await selectWithdrawalCandidates(db, seat, input.now, {
    olderThanDays: input.afterDays,
    actionIds: [invite.id],
    limit: 1
  });
  if (candidates.length > 0) await enqueueWithdrawals(db, seat, candidates, input.now);
  return { waitUntil: null };
}

/**
 * Every workspace with a running managed campaign, ticked once.
 *
 * Keyed off the campaign rather than off due actions or off seats: a workspace
 * whose queue is empty is exactly the one that needs planning, and a workspace
 * with a seat but no running campaign has nothing to plan.
 */
export async function runManagedCampaignsForAllWorkspaces(
  db: Db,
  now: Date = new Date()
): Promise<RunnerResult> {
  const rows = await db
    .prepare(
      `
    SELECT DISTINCT workspace_id FROM linkedin_campaigns
    WHERE status='running' AND lead_list_id IS NOT NULL AND workflow_id IS NOT NULL
    ORDER BY workspace_id
  `
    )
    .all<{ workspace_id: string }>();

  const total: RunnerResult = {
    campaignsTicked: 0,
    actionsPlanned: 0,
    manualTasksCreated: 0,
    membersCompleted: 0,
    membersBlocked: 0
  };
  for (const row of rows) {
    const one = await runManagedCampaigns(db, row.workspace_id, now);
    total.campaignsTicked += one.campaignsTicked;
    total.actionsPlanned += one.actionsPlanned;
    total.manualTasksCreated += one.manualTasksCreated;
    total.membersCompleted += one.membersCompleted;
    total.membersBlocked += one.membersBlocked;
  }
  return total;
}
