import { createHash } from 'node:crypto';
import { id, type Db } from '../db.js';
import { recordAction } from './actions.js';
import { ACTION_GAP_SECONDS, bandFor, effectiveDailyCeiling, seatOperatorLimit } from './limits.js';
import { campaignActionLimit, campaignSnapshotSteps, enrolNewContacts } from './managed-campaigns.js';
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
const BUDGETED_KINDS = ['invite', 'dm', 'profile_view', 'follow'] as const;
type BudgetedKind = (typeof BUDGETED_KINDS)[number];

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
  workflow_id: string;
  lead_list_id: string;
  sequence_json: unknown;
  started_at: string | null;
}

interface DueMemberRow {
  id: string;
  contact_id: string;
  step_index: number;
  assigned_variants: unknown;
  first_name: string;
  last_name: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  profile_url: string | null;
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

/** The ledger kind a step writes, or null for the two steps that write none. */
function kindForStep(step: WorkflowStep): BudgetedKind | null {
  switch (step.action) {
    case 'connection_request':
      return 'invite';
    case 'message':
      return 'dm';
    case 'profile_view':
      return 'profile_view';
    case 'follow':
      return 'follow';
    case 'manual_message':
    case 'withdraw_pending':
      return null;
  }
}

function parseVariants(value: unknown): Record<string, string> {
  const raw = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return {}; } })()
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
function scheduleSlot(seat: LinkedInSeat, earliest: Date, floor: Date | null, seed: string): Date | null {
  const jitterMs = Math.round(seededUnit(seed) * (ACTION_GAP_SECONDS.max - ACTION_GAP_SECONDS.min) * 1000);
  const gapMs = ACTION_GAP_SECONDS.min * 1000 + jitterMs;
  let candidate = new Date(earliest.getTime() + jitterMs);
  if (floor && floor.getTime() + gapMs > candidate.getTime()) candidate = new Date(floor.getTime() + gapMs);
  return nextOpenInstant(seat, candidate);
}

function parseInstant(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The latest slot this seat already holds, so a new run never lands on top of one. */
async function ledgerFloorFor(db: Db, workspaceId: string, seatKey: string): Promise<Date | null> {
  const row = await db.prepare(`
    SELECT TO_CHAR(MAX(planned_for) AT TIME ZONE 'UTC', ${UTC_ISO}) AS latest
    FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND status <> 'skipped' AND planned_for IS NOT NULL
  `).get<{ latest: string | null }>(workspaceId, seatKey);
  return parseInstant(row?.latest ?? null);
}

/**
 * Contacts among `profileUrls` that have already answered.
 *
 * Two sources, both case-folded the way every other target lookup in this
 * subsystem folds them (`idx_linkedin_actions_target_ci`, migration 031): a
 * ledger row settled `replied`, and an inbound message on a thread resolved to
 * that profile. Batched per campaign rather than asked per member -- 500
 * members is 500 round trips otherwise.
 */
async function repliedProfiles(db: Db, workspaceId: string, profileUrls: readonly string[]): Promise<Set<string>> {
  if (profileUrls.length === 0) return new Set();
  const keys = profileUrls.map((url) => url.toLowerCase());
  const rows = await db.prepare(`
    SELECT LOWER(a.target_ref) AS profile FROM linkedin_actions a
      WHERE a.workspace_id=? AND a.status='replied' AND a.target_ref IS NOT NULL AND LOWER(a.target_ref) = ANY(?::text[])
    UNION
    SELECT LOWER(t.profile_url) AS profile FROM linkedin_threads t
      JOIN linkedin_messages m ON m.thread_id=t.id AND m.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND t.profile_url IS NOT NULL AND LOWER(t.profile_url) = ANY(?::text[]) AND m.direction='in'
  `).all<{ profile: string }>(workspaceId, keys, workspaceId, keys);
  return new Set(rows.map((row) => row.profile));
}

/* -------------------------------------------------------------------------
 * The tick
 * ---------------------------------------------------------------------- */

export async function runManagedCampaigns(db: Db, workspaceId: string, now: Date = new Date()): Promise<RunnerResult> {
  const result: RunnerResult = {
    campaignsTicked: 0,
    actionsPlanned: 0,
    manualTasksCreated: 0,
    membersCompleted: 0,
    membersBlocked: 0
  };

  const campaigns = await db.prepare(`
    SELECT id, seat_key, workflow_id, lead_list_id, sequence_json,
           TO_CHAR(started_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS started_at
    FROM linkedin_campaigns
    WHERE workspace_id=? AND status='running' AND lead_list_id IS NOT NULL AND workflow_id IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `).all<CampaignRow>(workspaceId);
  if (campaigns.length === 0) return result;

  // One seat may carry several campaigns. Both caches are per tick: the seat
  // row does not change under us, and the slot floor MUST be shared or two
  // campaigns would each schedule against the same starting point.
  const seats = new Map<string, LinkedInSeat | null>();
  const floors = new Map<string, Date | null>();

  for (const campaign of campaigns) {
    /* --- The steps this campaign is running. ---
     *
     * ITS OWN SNAPSHOT, NOT A LIVE READ OF THE WORKFLOW, and the difference is
     * a promise the product makes out loud: the campaign screen says "editing
     * one does not change campaigns already running on it". Loading the
     * workflow by id here made that false -- saving an edit rewrote the
     * sequence of every campaign already mid-flight, so a member who had had
     * step 2 of the old workflow got step 3 of the new one, and shortening a
     * workflow completed everybody past its new end.
     *
     * `startManagedCampaign` writes the snapshot, because STARTING is the
     * operator's act of choosing a version. An edit therefore reaches a
     * running campaign when, and only when, somebody restarts it.
     *
     * The live workflow is the FALLBACK, for campaigns created before this
     * file read snapshots. A campaign with neither is one that cannot tick;
     * skipped rather than thrown, because one broken campaign must not stop
     * every other one.
     */
    const snapshot = campaignSnapshotSteps(campaign.sequence_json);
    const steps = snapshot.length > 0
      ? snapshot
      : (await getWorkflow(db, workspaceId, campaign.workflow_id))?.steps ?? [];
    if (steps.length === 0) continue;

    if (!seats.has(campaign.seat_key)) {
      seats.set(campaign.seat_key, (await getSeat(db, workspaceId, campaign.seat_key)) ?? null);
    }
    const seat = seats.get(campaign.seat_key) ?? null;
    if (!seat) {
      const blocked = await db.prepare(`
        SELECT COUNT(*)::int AS total FROM linkedin_campaign_members
        WHERE workspace_id=? AND campaign_id=? AND status IN ('active','waiting')
      `).get<{ total: number }>(workspaceId, campaign.id);
      result.membersBlocked += blocked?.total ?? 0;
      continue;
    }
    if (!floors.has(campaign.seat_key)) {
      floors.set(campaign.seat_key, await ledgerFloorFor(db, workspaceId, campaign.seat_key));
    }

    result.campaignsTicked += 1;

    /* --- Contacts imported into this campaign's list since it started. ---
     *
     * Enrolment lived only in `createManagedCampaign`, so a campaign's
     * membership was a photograph taken at creation and every lead added to
     * the list afterwards was invisible to it forever. Done per tick, and only
     * for a RUNNING campaign, which is what this loop already selects for.
     */
    await enrolNewContacts(db, workspaceId, { id: campaign.id, leadListId: campaign.lead_list_id, steps }, now);

    /* --- The campaign warm-up budget. ---
     *
     * `campaignActionLimit` is the ramp; what it is measured against is every
     * row this campaign has PLANNED, not what the seat has sent. A ceiling
     * counted on confirmed sends would let one tick plan a week of invites for
     * tomorrow morning and discover the problem from a restriction notice,
     * which is precisely the failure the ramp exists to prevent. Rolling, not
     * calendar, for the reason `actions.ts` gives.
     *
     * THE WINDOW LOOKS BOTH WAYS, and that is deliberate. A forward-only
     * window ("the 24 hours ending at now+24h") re-grants the whole ramp on
     * every tick: slots placed a minute ago fall out of it the moment the
     * clock moves, so a campaign capped at two invites a day plans two more
     * every time the job runs. Charging the 24 hours already spent as well as
     * the 24 booked ahead is the conservative way to be wrong -- a ramp that
     * under-grants delays a campaign, and one that over-grants is the ban this
     * whole subsystem exists to avoid.
     */
    const windowStart = new Date(now.getTime() - 86_400_000).toISOString();
    const windowEnd = new Date(now.getTime() + 86_400_000).toISOString();
    const used = await db.prepare(`
      SELECT kind, COUNT(*)::int AS total FROM linkedin_actions
      WHERE workspace_id=? AND campaign_id=? AND status <> 'skipped'
        AND planned_for IS NOT NULL AND planned_for >= ?::timestamptz AND planned_for <= ?::timestamptz
        AND kind = ANY(?::text[])
      GROUP BY kind
    `).all<{ kind: string; total: number }>(workspaceId, campaign.id, windowStart, windowEnd, [...BUDGETED_KINDS]);
    const usedByKind = new Map(used.map((row) => [row.kind, Number(row.total)]));
    const budget = new Map<BudgetedKind, number>();
    for (const kind of BUDGETED_KINDS) {
      // The ramp is a percentage of THE CEILING THE GATE WILL ENFORCE, not of
      // the raw operator setting -- see `seatDailyCeilingFor`.
      const limit = campaignActionLimit(seatDailyCeilingFor(seat, kind, now), campaign.started_at, now);
      budget.set(kind, Math.max(0, limit - (usedByKind.get(kind) ?? 0)));
    }

    const members = await db.prepare(`
      SELECT m.id, m.contact_id, m.step_index, m.assigned_variants,
             l.first_name, l.last_name, l.company, l.email, l.phone, l.country, l.profile_url
      FROM linkedin_campaign_members m
      JOIN linkedin_lead_contacts l ON l.id=m.contact_id AND l.workspace_id=m.workspace_id
      WHERE m.workspace_id=? AND m.campaign_id=? AND m.status IN ('active','waiting')
        AND (m.next_eligible_at IS NULL OR m.next_eligible_at <= ?::timestamptz)
      ORDER BY m.next_eligible_at ASC NULLS FIRST, m.id ASC
      LIMIT ${MEMBER_BATCH}
    `).all<DueMemberRow>(workspaceId, campaign.id, now.toISOString());

    const replied = await repliedProfiles(
      db,
      workspaceId,
      members.map((member) => member.profile_url).filter((url): url is string => Boolean(url))
    );

    for (const member of members) {
      const nowIso = now.toISOString();
      // Every merge field the contact carries, not the three the renderer used
      // to know about: email, phone and country are parsed on import, stored,
      // and displayed, so a template asking for one gets it.
      const lead = {
        firstName: member.first_name,
        lastName: member.last_name,
        company: member.company,
        email: member.email,
        phone: member.phone,
        country: member.country
      };

      /* --- Reply short-circuit. ---
       *
       * A conversation started is the campaign's whole objective, so the
       * workflow stops the moment one does: the next scripted follow-up would
       * arrive on top of a human answer.
       */
      if (member.profile_url && replied.has(member.profile_url.toLowerCase())) {
        await db.prepare(`
          UPDATE linkedin_campaign_members SET status='replied', next_eligible_at=NULL, updated_at=?
          WHERE workspace_id=? AND id=?
        `).run(nowIso, workspaceId, member.id);
        continue;
      }

      const stepIndex = Number(member.step_index);
      const step = steps[stepIndex];
      if (!step) {
        await db.prepare(`
          UPDATE linkedin_campaign_members SET status='completed', next_eligible_at=NULL, updated_at=?
          WHERE workspace_id=? AND id=?
        `).run(nowIso, workspaceId, member.id);
        result.membersCompleted += 1;
        continue;
      }

      /* --- The human checkpoint. --- */
      if (step.action === 'manual_message') {
        const template = step.config.suggestedTemplate ?? '';
        const suggested = template.trim().length > 0 ? renderWorkflowTemplate(template, lead) : null;
        const inserted = await db.transaction(async (tx) => {
          // ON CONFLICT DO NOTHING against the pending partial unique index:
          // re-ticking a member that is already waiting on a human must not
          // queue the same task twice.
          const row = await tx.prepare(`
            INSERT INTO linkedin_manual_tasks (
              id, workspace_id, campaign_id, member_id, contact_id, seat_key, workflow_step_id, suggested_body, status, created_at
            ) VALUES (?,?,?,?,?,?,?,?,'pending',?)
            ON CONFLICT DO NOTHING RETURNING id
          `).get<{ id: string }>(
            id('limt'), workspaceId, campaign.id, member.id, member.contact_id, campaign.seat_key, step.id, suggested, nowIso
          );
          // NOT advanced: `completeManualTask` owns `step_index+1`, and doing it
          // here as well would skip the step after this one.
          await tx.prepare(`
            UPDATE linkedin_campaign_members SET status='manual', next_eligible_at=NULL, updated_at=?
            WHERE workspace_id=? AND id=?
          `).run(nowIso, workspaceId, member.id);
          return row !== undefined;
        });
        if (inserted) result.manualTasksCreated += 1;
        continue;
      }

      /* --- Withdraw a stale invite. Writes no outbound action of its own. --- */
      if (step.action === 'withdraw_pending') {
        const outcome = await handleWithdrawStep(db, {
          workspaceId,
          seatKey: campaign.seat_key,
          memberId: member.id,
          afterDays: step.config.afterDays,
          now
        });
        if (outcome.waitUntil) {
          // The invite is not stale yet. Left ON this step, woken at the exact
          // instant it becomes stale rather than re-polled every tick.
          await db.prepare(`
            UPDATE linkedin_campaign_members SET status='waiting', next_eligible_at=?::timestamptz, updated_at=?
            WHERE workspace_id=? AND id=?
          `).run(outcome.waitUntil.toISOString(), nowIso, workspaceId, member.id);
          continue;
        }
        const advanced = await advanceMember(db, {
          workspaceId,
          memberId: member.id,
          stepIndex,
          steps,
          from: now,
          actionId: null,
          now
        });
        if (advanced.completed) result.membersCompleted += 1;
        continue;
      }

      /* --- Everything else writes a `planned` ledger row. --- */
      const kind = kindForStep(step);
      if (!kind) continue;

      // An action with no target is unclaimable (`claimNextDueAction` requires
      // `target_ref NOT NULL`), so a member with no profile URL would sit due
      // forever and hold the contact's one-active-campaign claim. Failed is
      // terminal and releases it.
      if (!member.profile_url) {
        await db.prepare(`
          UPDATE linkedin_campaign_members SET status='failed', next_eligible_at=NULL, updated_at=?
          WHERE workspace_id=? AND id=?
        `).run(nowIso, workspaceId, member.id);
        result.membersBlocked += 1;
        continue;
      }

      const remaining = budget.get(kind) ?? 0;
      // Out of ramp for this kind today. The member keeps its due-ness and is
      // the first thing the next tick looks at.
      if (remaining <= 0) continue;

      let variantId: string | null = null;
      let body: string | null = null;
      if (step.action === 'connection_request') {
        const template = step.config.message ?? '';
        body = template.trim().length > 0 ? renderWorkflowTemplate(template, lead) : null;
      } else if (step.action === 'message') {
        // The stored choice wins on every re-run: an A/B split that moved a
        // contact between arms would measure nothing.
        const assigned = parseVariants(member.assigned_variants)[step.id];
        const variant = step.config.variants.find((candidate) => candidate.id === assigned)
          ?? chooseMessageVariant(step.config.variants, `${member.id}:${step.id}`);
        variantId = variant.id;
        body = renderWorkflowTemplate(variant.body, lead);
      }

      const plannedFor = scheduleSlot(seat, now, floors.get(campaign.seat_key) ?? null, `${member.id}:${step.id}`);
      if (!plannedFor) {
        result.membersBlocked += 1;
        continue;
      }

      const written = await db.transaction(async (tx) => {
        const action = await recordAction(
          tx,
          {
            workspaceId,
            seatKey: campaign.seat_key,
            kind,
            targetRef: member.profile_url,
            campaignId: campaign.id,
            status: 'planned',
            plannedFor: plannedFor.toISOString(),
            source: 'campaign',
            // Member+step, so a workflow may touch one person twice with the
            // same kind while the legacy one-kind-per-target guard stays exactly
            // as strict for every other writer (migration 047).
            replayScope: `${member.id}:${step.id}`
          },
          now
        );
        if (!action.duplicate) {
          // Same transaction as the ledger row: `claimNextDueAction` must never
          // see a dm whose approved bytes have not landed yet.
          await tx.prepare(`
            UPDATE linkedin_actions SET body=?, campaign_member_id=?, workflow_step_id=?, variant_id=?
            WHERE id=? AND workspace_id=?
          `).run(body, member.id, step.id, variantId, action.id, workspaceId);
        }
        if (variantId) {
          await tx.prepare(`
            UPDATE linkedin_campaign_members
            SET assigned_variants = COALESCE(assigned_variants,'{}'::jsonb) || ?::jsonb, updated_at=?
            WHERE workspace_id=? AND id=?
          `).run(JSON.stringify({ [step.id]: variantId }), nowIso, workspaceId, member.id);
        }
        return action;
      });

      // A duplicate means this member already ran this step -- the slot is not
      // consumed and the ramp is not charged, but the member still moves on.
      if (!written.duplicate) {
        result.actionsPlanned += 1;
        budget.set(kind, remaining - 1);
        floors.set(campaign.seat_key, plannedFor);
      }

      const advanced = await advanceMember(db, {
        workspaceId,
        memberId: member.id,
        stepIndex,
        steps,
        from: plannedFor,
        actionId: written.id,
        now
      });
      if (advanced.completed) result.membersCompleted += 1;
    }

    // A campaign with nothing left to do says so, rather than being re-scanned
    // on every tick forever.
    const live = await db.prepare(`
      SELECT COUNT(*)::int AS total FROM linkedin_campaign_members
      WHERE workspace_id=? AND campaign_id=? AND status = ANY(?::text[])
    `).get<{ total: number }>(workspaceId, campaign.id, [...LIVE_MEMBER_STATUSES]);
    if ((live?.total ?? 0) === 0) {
      await db.prepare(`
        UPDATE linkedin_campaigns SET status='completed', updated_at=? WHERE workspace_id=? AND id=? AND status='running'
      `).run(now.toISOString(), workspaceId, campaign.id);
    }
  }

  return result;
}

/**
 * `step_index+1`, and the delay the NEXT step declares.
 *
 * THIS IS WHERE PER-STEP DELAYS BECOME REAL. `delayBefore` is measured from the
 * slot the step just planned, not from the tick that planned it: a message due
 * "two days after the invite" means after the invite's own slot, and measuring
 * from `now` would compound every tick's scheduling drift into the sequence.
 */
async function advanceMember(
  db: Db,
  input: {
    workspaceId: string;
    memberId: string;
    stepIndex: number;
    steps: readonly WorkflowStep[];
    from: Date;
    actionId: string | null;
    now: Date;
  }
): Promise<{ completed: boolean }> {
  const nextIndex = input.stepIndex + 1;
  const nextStep = input.steps[nextIndex];
  const nowIso = input.now.toISOString();
  const status = nextStep ? 'waiting' : 'completed';
  const nextEligible = nextStep
    ? new Date(input.from.getTime() + delayMilliseconds(nextStep.delayBefore)).toISOString()
    : null;
  await db.prepare(`
    UPDATE linkedin_campaign_members
    SET step_index=?, status=?, next_eligible_at=?::timestamptz, last_action_id=COALESCE(?, last_action_id), updated_at=?
    WHERE workspace_id=? AND id=?
  `).run(nextIndex, status, nextEligible, input.actionId, nowIso, input.workspaceId, input.memberId);
  return { completed: !nextStep };
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
  const invite = await db.prepare(`
    SELECT id, status,
           TO_CHAR(COALESCE(pending_since, recorded_at) AT TIME ZONE 'UTC', ${UTC_ISO}) AS sent_at
    FROM linkedin_actions
    WHERE workspace_id=? AND campaign_member_id=? AND kind='invite'
    ORDER BY created_at DESC LIMIT 1
  `).get<InviteRow>(input.workspaceId, input.memberId);

  // Nothing to withdraw, or already decided one way or the other: the step has
  // no work and the workflow moves on. 'skipped' is in the list because a
  // stopped campaign or a removed member releases its queue that way -- there
  // is no invite outstanding and there never will be.
  if (!invite) return { waitUntil: null };
  if (['accepted', 'replied', 'declined', 'withdrawn', 'skipped'].includes(invite.status)) return { waitUntil: null };

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
export async function runManagedCampaignsForAllWorkspaces(db: Db, now: Date = new Date()): Promise<RunnerResult> {
  const rows = await db.prepare(`
    SELECT DISTINCT workspace_id FROM linkedin_campaigns
    WHERE status='running' AND lead_list_id IS NOT NULL AND workflow_id IS NOT NULL
    ORDER BY workspace_id
  `).all<{ workspace_id: string }>();

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
