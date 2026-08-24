import type { Db } from '../db.js';
import { evaluateLinkedInSafety, type LinkedInCheckName } from './guard.js';
import type { PacedKind } from './limits.js';
import { EXECUTABLE_KINDS, KINDS_REQUIRING_BODY } from './local-worker.js';
import { seatRestingUntil } from './seat-events.js';
import { getSeat, OWNER_SEAT_KEY } from './seats.js';

/* ---------------------------------------------------------------------------
 * WHY NOTHING IS HAPPENING, ANSWERED BY THE THING THAT KNOWS.
 *
 * The campaign screen used to answer that question with one sentence -- "N
 * planned action(s) have reached their scheduled time and are waiting for the
 * LinkedIn executor to claim them" -- printed whenever a due, unclaimed row
 * existed. It is true of the ROW and almost never true of the SYSTEM: the
 * paired computer was online, the browser opened fine, and the reason nothing
 * moved was one of a handful of specific, legible states that the screen had no
 * way to name. An operator reading "waiting for browser worker" while the
 * worker is demonstrably running learns nothing and, worse, learns to distrust
 * the banner.
 *
 * This module supplies the FACTS the screen could not see, all of which live in
 * the database and none of which the browser can read for itself:
 *
 *   - how much work is genuinely claimable right now, with the rows that are
 *     parked on an unresolved outcome taken OUT of that count (they are not
 *     waiting for a browser; they are waiting for a person);
 *   - how many rows are so parked, and what kind they are;
 *   - whether the seat is inside its autonomous batch cooldown
 *     (`linkedin_seats.resting_until`), which is the single most common reason
 *     a healthy seat is doing nothing at this instant;
 *   - what the SAFETY GATE says about the very next action the worker would
 *     claim -- which check binds, and that check's own operator prose.
 *
 * THE GATE VERDICT IS COMPUTED ON READ, NOT STORED. The worker already
 * re-evaluates the gate immediately before every send and merely LOGS the
 * refusal (`local-worker.ts`: "skipped action ..."); nothing persists it. Two
 * ways to fix that: write a refusal row and read it back, or ask the gate the
 * same question the worker will ask. A stored refusal is stale the moment the
 * ledger moves -- and the ledger moves constantly, which is the whole point of
 * a day-over-day clamp -- so it would show an operator a reason that has
 * already stopped being true, and it would need a table, a writer, a retention
 * rule and a migration to say something the gate can answer in one round trip.
 * Asking is cheaper and cannot go stale. It is also EXACTLY the same call the
 * worker makes, with the same row excluded by primary key, so the screen and
 * the worker cannot disagree.
 *
 * NOTHING HERE ORDERS THESE FACTS INTO A MESSAGE. The priority ladder --
 * companion offline, then recovery, then cooldown, then the gate, then parked
 * rows, then the generic wait -- lives with the copy in the client
 * (`LinkedInExecutionBlocker.ts`), because two of its states (a live device
 * heartbeat, this process's browser readiness) are not database facts at all.
 * This module answers questions; it does not choose which one to print.
 * ------------------------------------------------------------------------ */

const EXECUTABLE_KIND_LIST = EXECUTABLE_KINDS.map((kind) => `'${kind}'`).join(', ');
const BODY_REQUIRED_LIST = KINDS_REQUIRING_BODY.map((kind) => `'${kind}'`).join(', ');
const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** What the safety gate says about the next action this campaign would run. */
export interface LinkedInCampaignExecutionGate {
  /** The kind the gate was asked about. The next claimable row's, not a guess. */
  kind: PacedKind;
  allowed: boolean;
  /** The first failing check in evaluation order, or null when the gate allows it. */
  check: LinkedInCheckName | null;
  /** That check's own sentence, verbatim. The gate writes for operators; this does not rewrite it. */
  detail: string | null;
}

export interface LinkedInCampaignExecution {
  /**
   * The account the next due action belongs to, or the campaign's own account
   * when nothing is due. A campaign may rotate several senders; the one that
   * matters for "why is this not moving" is the one whose row is next.
   */
  seatKey: string;
  seatLabel: string | null;
  /** IANA name. The cooldown clock is meaningless rendered in anybody else's zone. */
  timezone: string | null;
  /**
   * Planned rows whose slot has passed, unclaimed, and NOT parked on an
   * unresolved outcome. The same predicate `CampaignQueueSummary.queuedReady`
   * uses, so the two numbers cannot disagree.
   */
  dueNow: number;
  /**
   * Planned rows held on an unknown outcome (`settlement_hold_at`). They were
   * claimed, something happened that we could not read back, and re-running
   * them could put a second invite in somebody's notifications. NO BROWSER WILL
   * EVER TAKE THEM -- the reaper's predicate is `settlement_hold_at IS NULL` --
   * so counting them as "waiting for the executor" was reporting a person's
   * decision as a machine's queue.
   */
  awaitingResolution: number;
  /** The dominant kind among those parked rows, for a sentence that names them. */
  awaitingResolutionKind: string | null;
  /** ISO-8601 while the seat is inside its autonomous batch cooldown, else null. */
  restingUntil: string | null;
  /** Null when nothing is claimable, or when the gate itself could not be read. */
  gate: LinkedInCampaignExecutionGate | null;
}

interface NextDueRow {
  id: string;
  seat_key: string;
  kind: string;
  target_ref: string;
  planned_for: string;
  campaign_id: string | null;
  replay_scope: string | null;
  override_warmup_ceiling: boolean | null;
  reply_to_inbound: boolean | null;
  source: string | null;
}

/**
 * The ledger's account of why this campaign is or is not executing right now.
 *
 * One read, on demand, for ONE campaign -- this is reached from the campaign
 * card an operator has opened, never from a list. It never throws for a reason
 * of its own: a screen that answers "why is nothing sending" must not be the
 * screen that 500s, so an unreadable seat, an un-migrated column or a gate that
 * cannot evaluate all come back as an honest absence and the caller falls back
 * to the generic message it printed before this existed.
 */
export async function campaignExecutionState(
  db: Db,
  workspaceId: string,
  campaignId: string,
  now: Date = new Date()
): Promise<LinkedInCampaignExecution> {
  const nowIso = now.toISOString();

  /*
   * THREE INDEPENDENT QUESTIONS, ONE ROUND TRIP EACH, ISSUED TOGETHER. None is
   * an input to another: the campaign is named, the instant is known, and the
   * seat is read afterwards from whichever answer names it.
   */
  const [counts, parked, dueRow] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) FILTER (
             WHERE status='planned' AND claimed_at IS NULL AND settlement_hold_at IS NULL
               AND planned_for IS NOT NULL AND planned_for<=?::timestamptz
           )::int AS due_now,
           COUNT(*) FILTER (WHERE status='planned' AND settlement_hold_at IS NOT NULL)::int AS awaiting_resolution
         FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?`
      )
      .get<{ due_now: number; awaiting_resolution: number }>(nowIso, workspaceId, campaignId),
    db
      .prepare(
        `SELECT kind, COUNT(*)::int AS total FROM linkedin_actions
         WHERE workspace_id=? AND campaign_id=? AND status='planned' AND settlement_hold_at IS NOT NULL
         GROUP BY kind ORDER BY total DESC, kind ASC LIMIT 1`
      )
      .get<{ kind: string; total: number }>(workspaceId, campaignId),
    /*
     * THE ROW THE WORKER WOULD TAKE NEXT, selected by the claim's own
     * predicate and the claim's own ordering (`claimNextDueAction`), minus the
     * UPDATE. Asking the gate about any other row would answer a question
     * nobody is about to ask: an unclaimable row -- a message with no approved
     * body, a reply that lost its thread -- is not what the queue is stuck on,
     * and a row further down the order is not what it reaches first.
     */
    db
      .prepare(
        `SELECT id, seat_key, kind, target_ref,
                TO_CHAR(planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
                campaign_id, replay_scope, override_warmup_ceiling, reply_to_inbound, source
         FROM linkedin_actions
         WHERE workspace_id=? AND campaign_id=? AND status='planned' AND claimed_at IS NULL
           AND settlement_hold_at IS NULL
           AND planned_for IS NOT NULL AND planned_for<=?::timestamptz
           AND kind IN (${EXECUTABLE_KIND_LIST})
           AND target_ref IS NOT NULL
           AND (kind NOT IN (${BODY_REQUIRED_LIST}) OR (body IS NOT NULL AND body <> ''))
           AND (kind <> 'reply' OR (thread_urn IS NOT NULL AND thread_urn <> ''))
         ORDER BY
           (CASE WHEN sla_deadline_at IS NOT NULL AND sla_deadline_at <= ?::timestamptz THEN 1 ELSE 0 END) DESC,
           queue_priority DESC,
           planned_for ASC
         LIMIT 1`
      )
      .get<NextDueRow>(workspaceId, campaignId, nowIso, nowIso)
  ]);

  // The seat of the row that is next, when there is one. When there is not,
  // the campaign's own -- a cooldown is still worth naming on a queue that has
  // nothing due this minute, because it is why the next slot will not be taken
  // the moment it arrives either.
  const campaignSeat = dueRow
    ? null
    : await db
        .prepare('SELECT seat_key FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
        .get<{ seat_key: string }>(workspaceId, campaignId);
  const seatKey = dueRow?.seat_key ?? campaignSeat?.seat_key ?? OWNER_SEAT_KEY;

  const [seat, restingUntil] = await Promise.all([
    getSeat(db, workspaceId, seatKey).catch(() => undefined),
    seatRestingUntil(db, workspaceId, seatKey)
  ]);

  return {
    seatKey,
    seatLabel: seat?.label ?? null,
    timezone: seat?.timezone ?? null,
    dueNow: Number(counts?.due_now ?? 0),
    awaitingResolution: Number(counts?.awaiting_resolution ?? 0),
    awaitingResolutionKind: parked?.kind ?? null,
    // A break that has already ended is not a break. The column keeps its last
    // value after the seat wakes up, so the comparison -- not the presence of a
    // value -- is what says the seat is resting.
    restingUntil:
      restingUntil && restingUntil.getTime() > now.getTime() ? restingUntil.toISOString() : null,
    gate: dueRow ? await gateVerdict(db, workspaceId, dueRow, now) : null
  };
}

/**
 * The same call the worker makes immediately before it touches LinkedIn.
 *
 * `now` rather than the row's `planned_for`, for the reason `local-worker.ts`
 * spells out at its own call site: a slot paced hours ago can read as a valid
 * business-hours instant long after it stopped being one, and every other check
 * already reasons from the present. The row is excluded by primary key because
 * it is the SUBJECT of the question -- without that, `duplicate-target` finds
 * the action under evaluation and refuses it, every time.
 *
 * The three row-carried facts (`campaignId`, `replayScope`, and the two
 * relaxations) are passed exactly as the worker passes them: this preview must
 * not be able to reach a verdict the worker will not reach, in either
 * direction.
 */
async function gateVerdict(
  db: Db,
  workspaceId: string,
  row: NextDueRow,
  now: Date
): Promise<LinkedInCampaignExecutionGate | null> {
  try {
    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId,
        seatKey: row.seat_key,
        kind: row.kind as PacedKind,
        targetRef: row.target_ref,
        plannedFor: now.toISOString(),
        ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
        ...(row.replay_scope ? { replayScope: row.replay_scope } : {}),
        ...(row.override_warmup_ceiling ? { overrideWarmupCeiling: true } : {}),
        ...(row.reply_to_inbound ? { replyToInbound: true } : {}),
        ...(row.source === 'manual' ? { manual: true } : {})
      },
      now,
      { excludeActionId: row.id }
    );
    const failed = verdict.checks.find((check) => !check.passed) ?? null;
    return {
      kind: row.kind as PacedKind,
      allowed: verdict.allowed,
      check: failed?.check ?? null,
      detail: failed?.detail ?? null
    };
  } catch {
    // "I could not find out whether this is safe" is not "it is safe" -- but on
    // a READ it is also not a reason to fail the request. The caller prints the
    // generic wait it printed before this module existed, which is honest about
    // knowing less rather than inventing a blocker.
    return null;
  }
}
