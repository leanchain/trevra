import { id, type Db } from '../db.js';
import { recordAction, type SeatRef } from './actions.js';
import { recordDetectedAcceptance } from './campaigns.js';
import {
  normalisedProfileUrl,
  playwrightDegreeDriver,
  profileUrlFor,
  isDegreeRead,
  type LinkedInDegreeDriver,
  type LinkedInFailureKind,
  type LinkedInPage
} from './driver.js';
import type { LinkedInListPage, LinkedInWithdrawDriver, PendingInviteList } from './driver-withdraw.js';
import { evaluateLinkedInSafety, type LinkedInSafetyVerdict } from './guard.js';
import { bandFor } from './limits.js';
import { actionGapSeconds } from './local-worker.js';
import { OWNER_SEAT_KEY, getSeatPosture, upsertSeat, type SeatPosture } from './seats.js';

/**
 * Pending-invite withdrawal (plan 4A, 6A).
 *
 * WHAT THIS IS FOR. A pending invite is not free. It holds a slot in the
 * operator's weekly invite cap on LinkedIn's side for as long as it sits
 * unanswered, and it is a permanent zero in the acceptance numerator -- and a
 * sustained acceptance rate below MIN_ACCEPTANCE_RATE is itself the documented
 * ban signal (plan 1.3). Four hundred stale invites therefore leave a seat both
 * capped and flagged, and every other lever this engine has reduces SENDING,
 * which does nothing about a backlog. Withdrawal is the only lever that does.
 *
 * THREE RULES SHAPE EVERY FUNCTION BELOW.
 *
 * 1. A WITHDRAWAL IS AN ACTION, AND IT IS PACED LIKE ONE. Withdrawing four
 *    hundred invites in ten minutes is precisely the "+120% surge within
 *    24-48h" half of the Slide-and-Spike signature this engine exists to
 *    prevent -- the cure would manufacture the disease. So a withdrawal is
 *    queued, claimed, gated by `evaluateLinkedInSafety` and capped by its own
 *    daily ceiling, with the same seeded 30-120s gaps the invite worker uses.
 *    THERE IS NO PATH HERE THAT SKIPS THE GATE, and the gate's verdict is used
 *    WHOLE -- see `evaluateWithdrawalSafety` for why the ceiling is a second,
 *    separate number instead of a filtered check.
 *
 * 2. WITHDRAWING FREES LINKEDIN'S WEEKLY CAP, NOT OURS -- NOT YET. Trevra's
 *    rolling 7-day window counts invites by `recorded_at`, so an invite sent
 *    twenty-two days ago is already outside it and withdrawing it returns
 *    exactly zero headroom in our own arithmetic. The headroom it returns is
 *    real, but it is on LinkedIn's side of the line. `countPendingInvites`
 *    below is the number a later change to `guard.ts`/`pacing.ts` needs in
 *    order to model that, and it is exported for exactly that purpose. Nothing
 *    in this file edits either.
 *
 * 3. AN ACCEPTED INVITE IS NEVER WITHDRAWN. A list is stale the moment it is
 *    read, so standing is re-checked TWICE before anything is clicked: the
 *    ledger row is re-read here, and the live sent-invitations list is re-read
 *    by the driver at the instant of acting. The second check is the one that
 *    can actually be true, and it is not a parameter anybody can pass around.
 *
 * The database work is plain functions over `Db`, as in `actions.ts` and
 * `campaigns.ts`, rather than the store seam `local-worker.ts` uses. That seam
 * exists there so a browser-driving loop can be tested with no database at
 * all; here the interesting assertions are about SQL predicates -- which row
 * the sweep picks, which one the claim hands out, what the replay guard
 * refuses -- and those are only true if a real Postgres says so.
 */

/* ---------------------------------------------------------------------------
 * Constants and types
 * ------------------------------------------------------------------------ */

/**
 * The eighth `linkedin_actions.status`, added by migration 032.
 *
 * A named constant rather than a literal because `LinkedInActionStatus` in
 * `actions.ts` does not carry it: that union is the seven values migration 022
 * documented, and widening it is a change to a type every screen and route
 * already switches on. This module writes the value through SQL, which is
 * where the column's enumeration is actually enforced -- i.e. nowhere, since
 * the column is unconstrained TEXT (see 032 for why no CHECK was added).
 *
 * What it means for the three predicates that read that column is settled in
 * migration 032's comments and is the reason it is a new value rather than a
 * reuse of 'declined': a withdrawn invite still consumes its rolling windows
 * (LinkedIn saw it), is NOT counted as a refusal (nobody refused), and keeps
 * its claim on the target (something did go out).
 */
export const WITHDRAWN_STATUS = 'withdrawn';

/**
 * How long an invite may go unanswered before it is a withdrawal candidate.
 *
 * 21 days, from plan 4A: "Auto-withdraw after N days (default 21)". Configurable
 * per call, because the right number depends on a sales cycle nobody here
 * knows -- but it has a default, because a feature that requires a number
 * before it can protect anybody protects nobody.
 */
export const DEFAULT_STALE_AFTER_DAYS = 21;

/** How many candidates one sweep will enqueue. Keeps a single pass finite. */
export const DEFAULT_CANDIDATE_LIMIT = 100;

/** The most withdrawals one batch pass will perform. Mirrors the invite worker's bound. */
export const DEFAULT_MAX_WITHDRAWALS = 25;

/** The lifecycle of a `linkedin_withdrawals` row. See migration 032 for what each means. */
export type WithdrawalStatus = 'queued' | 'withdrawn' | 'stale' | 'failed' | 'held';

/** An invite old enough to withdraw, as the sweep found it. */
export interface WithdrawalCandidate {
  /** The `linkedin_actions` row. */
  actionId: string;
  /** The opaque handle-or-URL, exactly as the ledger stores it. */
  targetRef: string;
  /** Whole days it has been awaiting an answer, by LinkedIn's clock where we have it. */
  pendingDays: number;
  campaignId: string | null;
}

/** One claimed `linkedin_withdrawals` row, as the loop needs it. */
export interface ClaimedWithdrawal {
  id: string;
  workspaceId: string;
  seatKey: string;
  actionId: string;
  targetRef: string;
  pendingDays: number | null;
}

export interface PendingInviteSyncResult {
  /** Entries LinkedIn showed us. */
  listed: number;
  /** Of those, ones this ledger has an outstanding invite for. */
  matched: number;
  /**
   * Pending on LinkedIn with no matching ledger row -- almost always an invite
   * the operator sent by hand. Reported, never invented: writing a ledger row
   * for it would put an action Trevra never planned into the pacing history.
   */
  unmatched: number;
  /**
   * Ledger rows we had seen pending before and that are not on the list now.
   *
   * COUNTED, NOT INTERPRETED. Accepted, declined, expired and withdrawn all
   * look identical from here, and the ledger's `accepted`/`declined` statuses
   * are load-bearing for the acceptance-rate throttle. Guessing between them
   * would feed that throttle fiction.
   */
  disappeared: number;
  /** Straight from the driver: was the list a prefix rather than the whole backlog? */
  truncated: boolean;
}

/* ---------------------------------------------------------------------------
 * Matching a LinkedIn profile URL to an opaque ledger target
 * ------------------------------------------------------------------------ */

/**
 * The strings a ledger `target_ref` might hold for one person, lower-cased.
 *
 * `target_ref` is whatever a human typed or a CSV supplied -- Trevra never
 * resolves it (022) -- so it may be a bare handle, `in/handle`, or a URL on
 * either host with or without a trailing slash. The driver, by contrast,
 * always reports the canonical form. Matching them needs one of these two, and
 * a small explicit key set is the better one: a regex clever enough to
 * normalise every shape in SQL is a regex nobody can review, and it would run
 * against a column with no index it could use.
 *
 * Returns an empty array for anything that is not a LinkedIn profile at all,
 * which matches nothing rather than matching everything.
 */
export function targetMatchKeys(target: string): string[] {
  const raw = target.trim();
  const canonical = /^https?:\/\//i.test(raw) ? normalisedProfileUrl(raw) : profileUrlFor(raw);
  if (!canonical) return [];
  let handle: string;
  try {
    handle = decodeURIComponent(new URL(canonical).pathname.replace(/^\/in\//, '').replace(/\/+$/, ''));
  } catch {
    return [];
  }
  if (!handle) return [];
  const keys = [
    canonical,
    canonical.replace(/\/+$/, ''),
    `https://www.linkedin.com/in/${handle}/`,
    `https://www.linkedin.com/in/${handle}`,
    `https://linkedin.com/in/${handle}/`,
    `https://linkedin.com/in/${handle}`,
    `http://www.linkedin.com/in/${handle}/`,
    `http://www.linkedin.com/in/${handle}`,
    `/in/${handle}`,
    `in/${handle}`,
    handle
  ].map((key) => key.toLowerCase());
  return [...new Set(keys)];
}

/* ---------------------------------------------------------------------------
 * 1. Sync what LinkedIn says is still pending
 * ------------------------------------------------------------------------ */

/**
 * Reconcile a freshly-read sent-invitations list against the ledger.
 *
 * TAKES THE LIST, DOES NOT FETCH IT. The browser read lives in
 * `driver-withdraw.ts`; this function is pure database work, which is what
 * lets it be tested against real SQL with no Playwright anywhere near it.
 *
 * IT ONLY EVER WRITES EVIDENCE. `pending_seen_at` records that LinkedIn still
 * showed the invite, and `pending_since` records LinkedIn's own account of
 * when it was sent. Neither is a status change, and NOTHING here concludes
 * anything from an invite's absence -- see `disappeared` above.
 *
 * A TRUNCATED LIST IS STILL WORTH SYNCING, and it is safe to sync precisely
 * because absence means nothing here. Everything the list did contain gets
 * fresher evidence; everything it did not simply keeps what it had.
 */
export async function syncPendingInvites(
  db: Db,
  seat: SeatRef,
  list: PendingInviteList,
  now: Date
): Promise<PendingInviteSyncResult> {
  const nowIso = now.toISOString();
  let matched = 0;
  let unmatched = 0;

  /*
   * ONE UPDATE FOR THE WHOLE LIST, NOT ONE PER INVITE.
   *
   * LinkedIn's sent-invitations page carries up to 500 entries per seat and
   * this ran an UPDATE for each of them, so a routine reconciliation was 500
   * round trips per seat per sync -- 5,000 seats a tick is 2.5M through a pool
   * of ten connections. The predicate below is the old one verbatim; only the
   * number of statements changed.
   *
   * Each listed invite expands into the small closed set of spellings its
   * ledger row might be filed under, and the expansion is carried into SQL as
   * (index, key) pairs so the answer can be attributed back to the entry it
   * came from. `matched` therefore still means "list entries that found at
   * least one outstanding ledger row", exactly as `updated.changes > 0` did
   * per invite -- including the degenerate case where LinkedIn lists the same
   * person twice, which the old loop counted as two matches and this counts as
   * two matches, because `hits` is computed per ENTRY and not per row.
   *
   * The rows themselves are updated once each. Where two entries reach the
   * same row, DISTINCT ON takes the EARLIEST entry's `sentAt`, which is what
   * the loop produced: the first UPDATE set `pending_since` and every later
   * COALESCE over it was a no-op.
   */
  const entryIndexes: number[] = [];
  const entryKeys: string[] = [];
  const sentAts: Array<string | null> = [];
  for (const [index, invite] of list.invites.entries()) {
    const keys = targetMatchKeys(invite.profileUrl);
    if (keys.length === 0) {
      unmatched += 1;
      continue;
    }
    for (const key of keys) {
      entryIndexes.push(index);
      entryKeys.push(key);
      sentAts.push(invite.sentAt);
    }
  }

  if (entryIndexes.length > 0) {
    // COALESCE on pending_since, never an overwrite: LinkedIn's label is
    // relative and coarse ("3w"), so re-syncing weekly would otherwise walk the
    // recorded send date forward a few days at a time and make a three-week-old
    // invite look permanently three weeks old. The first reading is the closest
    // one to the truth we will ever get.
    const hit = await db.prepare(`
      WITH listed AS (
        SELECT * FROM unnest(?::int[], ?::text[], ?::timestamptz[]) AS t(entry, key, sent_at)
      ),
      hits AS (
        SELECT DISTINCT l.entry, a.id
        FROM listed l
        JOIN linkedin_actions a ON LOWER(a.target_ref) = l.key
        WHERE a.workspace_id=? AND a.seat_key=? AND a.kind='invite'
          AND a.status IN ('sent', 'exported')
      ),
      updated AS (
        UPDATE linkedin_actions a
        SET pending_seen_at=?::timestamptz, pending_since=COALESCE(a.pending_since, s.sent_at)
        FROM (
          SELECT DISTINCT ON (h.id) h.id, l.sent_at
          FROM hits h JOIN listed l ON l.entry = h.entry
          ORDER BY h.id, l.entry
        ) s
        WHERE a.id = s.id
        RETURNING 1
      )
      SELECT COUNT(DISTINCT entry)::int AS matched, (SELECT COUNT(*)::int FROM updated) AS rows_touched FROM hits
    `).get<{ matched: number; rows_touched: number }>(
      entryIndexes,
      entryKeys,
      sentAts,
      seat.workspaceId,
      seat.seatKey,
      nowIso
    );
    matched = hit?.matched ?? 0;
    unmatched += new Set(entryIndexes).size - matched;
  }

  // Rows we had positive evidence for before this sync and did not see in it.
  // Only rows with a `pending_seen_at` older than this sync are counted: an
  // invite nobody has ever seen on the list is not evidence of a disappearance,
  // it is evidence of never having looked.
  //
  // A SEPARATE STATEMENT ON PURPOSE, and it cannot be folded into the one
  // above. Every CTE in a statement reads the same snapshot, so a `disappeared`
  // count computed alongside the UPDATE would see the rows it just refreshed
  // with their OLD `pending_seen_at` -- which is, by construction, older than
  // this sync -- and report every invite LinkedIn had just shown us as gone.
  const gone = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND kind='invite'
      AND status IN ('sent', 'exported')
      AND pending_seen_at IS NOT NULL AND pending_seen_at < ?::timestamptz
  `).get<{ total: number }>(seat.workspaceId, seat.seatKey, nowIso);

  /*
   * THE SYNC CLOCK, AND A TRUNCATED READ DOES NOT MOVE IT.
   *
   * `disappeared` above is a COUNT this function reports and interprets not at
   * all -- see the paragraph on it. The acceptance detector DOES interpret it,
   * one invite at a time and only ever by going and looking, and the question
   * it has to answer first is "was the list actually read". Without a recorded
   * sync moment the only available proxy is the newest `pending_seen_at` on any
   * row, which is wrong in precisely the case that matters: LinkedIn's page
   * caps at `MAX_PENDING_INVITES` cards, so a seat with a larger backlog gets a
   * PREFIX, and every invite in the unread tail looks exactly like an invite
   * that has left the list.
   *
   * So the clock advances only on a complete read. A truncated sync still files
   * every piece of evidence it gathered -- the UPDATE above already ran -- and
   * licenses no conclusion whatsoever about anything it did not see. Migration
   * 070.
   */
  if (!list.truncated) {
    await db.prepare(`
      UPDATE linkedin_seats SET pending_synced_at=?::timestamptz
      WHERE workspace_id=? AND seat_key=?
    `).run(nowIso, seat.workspaceId, seat.seatKey);
  }

  return {
    listed: list.invites.length,
    matched,
    unmatched,
    disappeared: gone?.total ?? 0,
    truncated: list.truncated
  };
}

/**
 * How many invites this seat currently has awaiting an answer.
 *
 * THE NUMBER RULE 2 IS ABOUT, and it is now wired. `guard.ts` reads it as the
 * `pending-invite-backlog` check and `pacing.ts` subtracts it inside the weekly
 * clamp, against `MAX_OUTSTANDING_INVITES` in limits.ts -- which is what makes
 * a withdrawal give capacity back in Trevra's arithmetic and not only on
 * LinkedIn's side. Before that it gave back nothing: both files count invites
 * by `recorded_at` inside a rolling window, so a backlog older than the window
 * was invisible to them.
 *
 * IT LIVES IN `actions.ts` and is re-exported here under the same name. Its two
 * consumers are `guard.ts` and `pacing.ts`, and this module imports both of
 * them -- exporting the query from here would close a module cycle through
 * three files for a five-line SELECT over the ledger `actions.ts` owns. The
 * name and the call site are unchanged for every caller.
 */
export { countPendingInvites } from './actions.js';

/* ---------------------------------------------------------------------------
 * 2. Select candidates by age
 * ------------------------------------------------------------------------ */

export interface WithdrawalCandidateOptions {
  /** Pending longer than this many days. Default {@link DEFAULT_STALE_AFTER_DAYS}. */
  olderThanDays?: number;
  /** Default {@link DEFAULT_CANDIDATE_LIMIT}. */
  limit?: number;
  /**
   * Narrow the sweep to named `linkedin_actions.id`s. Absent means every
   * pending invite this seat has, which is the sweep every existing caller
   * wants.
   *
   * It exists for the managed-workflow `withdraw_pending` step (`runner.ts`),
   * which withdraws ONE member's own invite on that step's `afterDays` rather
   * than the seat's whole backlog on the account default. Scoping the existing
   * selector is the whole of that wiring -- the alternative was a second copy
   * of the staleness rule, the live-withdrawal exclusion and the
   * `pending_since`-over-`recorded_at` clock, in a file that would then drift
   * from this one.
   */
  actionIds?: readonly string[];
  /**
   * Named `linkedin_actions.id`s this sweep must NOT touch.
   *
   * The mirror of `actionIds`, and it exists for one caller for one reason.
   * `jobs.ts` runs the unattended sweep on the seat's ACCOUNT default staleness
   * (21 days), but an invite that belongs to a managed campaign member has a
   * staleness the workflow itself declared -- the `withdraw_pending` step's
   * `afterDays` -- and that number is the operator's decision about that
   * campaign, not a default to be quietly overridden. So the sweep runs once
   * per declared `afterDays` over the invites it applies to, and then once more
   * over everything else, and "everything else" is what this expresses.
   *
   * An include-list could not say it: `actionIds` would need every unmanaged
   * invite enumerated up front, which is the whole table, and would silently
   * stop being correct the moment a new one is written between the two queries.
   */
  excludeActionIds?: readonly string[];
}

/**
 * This seat's invites that have gone unanswered for longer than `olderThanDays`.
 *
 * AGE IS MEASURED BY COALESCE(pending_since, recorded_at) -- LinkedIn's word
 * about when the recipient got it, ours about when we logged it. They differ
 * for every invite an operator sent by hand, and for anything exported to a
 * third-party tool that sent it a day later. The recipient's experience is
 * what "stale" is about, so their clock wins where we have it.
 *
 * A SHORTLIST, NOT A DECISION. Everything here is re-checked before it is
 * acted on, twice. Rows with a live `linkedin_withdrawals` entry are excluded
 * so a second sweep does not re-propose what is already queued -- the partial
 * unique index would refuse the insert anyway, and this makes the count
 * honest rather than relying on a swallowed conflict.
 */
export async function selectWithdrawalCandidates(
  db: Db,
  seat: SeatRef,
  now: Date,
  options: WithdrawalCandidateOptions = {}
): Promise<WithdrawalCandidate[]> {
  const olderThanDays = Math.max(0, options.olderThanDays ?? DEFAULT_STALE_AFTER_DAYS);
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_CANDIDATE_LIMIT));
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
  // NULL, not an empty array: an absent filter must select everything, and
  // `= ANY('{}')` selects nothing.
  const actionIds = options.actionIds && options.actionIds.length > 0 ? [...options.actionIds] : null;
  // Same NULL-not-empty rule read the other way: an absent exclusion must
  // exclude nothing, and `<> ALL('{}')` is true for every row, so either shape
  // works here -- NULL is used anyway so both filters read identically.
  const excludeIds = options.excludeActionIds && options.excludeActionIds.length > 0 ? [...options.excludeActionIds] : null;

  const rows = await db.prepare(`
    SELECT a.id, a.target_ref, a.campaign_id,
      FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - COALESCE(a.pending_since, a.recorded_at))) / 86400)::int AS pending_days
    FROM linkedin_actions a
    WHERE a.workspace_id=? AND a.seat_key=? AND a.kind='invite'
      AND a.status IN ('sent', 'exported')
      AND a.target_ref IS NOT NULL
      AND COALESCE(a.pending_since, a.recorded_at) IS NOT NULL
      AND COALESCE(a.pending_since, a.recorded_at) <= ?::timestamptz
      AND (?::text[] IS NULL OR a.id = ANY(?::text[]))
      AND (?::text[] IS NULL OR NOT (a.id = ANY(?::text[])))
      AND NOT EXISTS (
        SELECT 1 FROM linkedin_withdrawals w
        WHERE w.workspace_id=a.workspace_id AND w.seat_key=a.seat_key
          AND w.action_id=a.id AND w.status <> 'failed'
      )
    ORDER BY COALESCE(a.pending_since, a.recorded_at) ASC
    LIMIT ?
  `).all<{ id: string; target_ref: string; campaign_id: string | null; pending_days: number }>(
    now.toISOString(),
    seat.workspaceId,
    seat.seatKey,
    cutoff,
    actionIds,
    actionIds,
    excludeIds,
    excludeIds,
    limit
  );

  return rows.map((row) => ({
    actionId: row.id,
    targetRef: row.target_ref,
    pendingDays: row.pending_days,
    campaignId: row.campaign_id
  }));
}

/* ---------------------------------------------------------------------------
 * 3. Enqueue
 * ------------------------------------------------------------------------ */

/**
 * Queue withdrawals for `candidates`.
 *
 * Idempotent by the database rather than by remembering: the partial unique
 * index in migration 032 holds one live row per invite, and a losing insert is
 * a no-op reported as a duplicate instead of an error -- the same contract
 * `recordAction` has, for the same reason. Running the sweep twice, or running
 * it while a pass is in flight, queues each invite once.
 * it while a pass is in flight, queues each invite once.
 *
 * ONE INSERT FOR THE WHOLE SWEEP. `DEFAULT_CANDIDATE_LIMIT` is 100 and the
 * unattended pass runs per seat, so the loop this replaced was 100 round trips
 * per seat per sweep for a statement whose only per-row input is four scalars.
 * `ON CONFLICT DO NOTHING` behaves identically over a multi-row VALUES set --
 * including for two rows in the SAME statement naming one invite, which is the
 * one case a DO UPDATE could not have expressed -- so the idempotency is still
 * the database's and still reported rather than thrown.
 */
export async function enqueueWithdrawals(
  db: Db,
  seat: SeatRef,
  candidates: readonly WithdrawalCandidate[],
  now: Date
): Promise<{ queued: number; duplicates: number; ids: string[] }> {
  if (candidates.length === 0) return { queued: 0, duplicates: 0, ids: [] };
  const nowIso = now.toISOString();

  const rows = await db.prepare(`
    INSERT INTO linkedin_withdrawals (
      id, workspace_id, seat_key, action_id, target_ref, status, pending_days, queued_at
    )
    SELECT * FROM unnest(
      ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::int[], ?::timestamptz[]
    )
    ON CONFLICT (workspace_id, seat_key, action_id) WHERE status <> 'failed' DO NOTHING
    RETURNING id
  `).all<{ id: string }>(
    candidates.map(() => id('lwd')),
    candidates.map(() => seat.workspaceId),
    candidates.map(() => seat.seatKey),
    candidates.map((candidate) => candidate.actionId),
    candidates.map((candidate) => candidate.targetRef),
    candidates.map(() => 'queued'),
    candidates.map((candidate) => candidate.pendingDays),
    candidates.map(() => nowIso)
  );

  const ids = rows.map((row) => row.id);
  return { queued: ids.length, duplicates: candidates.length - ids.length, ids };
}

/**
 * The whole sweep: find stale invites, queue them, report what happened.
 *
 * A convenience over the two functions above and deliberately not more than
 * that -- it performs no browser work and takes no driver, so an operator (or
 * a route) can see exactly what WOULD be withdrawn before anything is.
 */
export async function sweepStaleInvites(
  db: Db,
  seat: SeatRef,
  now: Date,
  options: WithdrawalCandidateOptions = {}
): Promise<{ candidates: WithdrawalCandidate[]; queued: number; duplicates: number }> {
  const candidates = await selectWithdrawalCandidates(db, seat, now, options);
  const { queued, duplicates } = await enqueueWithdrawals(db, seat, candidates, now);
  return { candidates, queued, duplicates };
}

/* ---------------------------------------------------------------------------
 * The queue, as a screen reads it
 * ------------------------------------------------------------------------ */

/** One `linkedin_withdrawals` row, in the shape the API returns. */
export interface WithdrawalRecord {
  id: string;
  workspaceId: string;
  seatKey: string;
  actionId: string;
  targetRef: string;
  status: WithdrawalStatus;
  /** Which of driver.ts's six kinds the last attempt reported, or null. */
  failureKind: LinkedInFailureKind | null;
  /** One sentence, for the operator reading this row weeks later. */
  detail: string | null;
  /** Whole days the invite had been awaiting an answer AT ENQUEUE. Frozen on purpose. */
  pendingDays: number | null;
  claimedAt: string | null;
  queuedAt: string;
  finishedAt: string | null;
  /** Read-only scheduler decoration. Recomputed on every queue read. */
  nextRunAt?: string | null;
  nextRunWindowEndAt?: string | null;
  nextRunTimezone?: string | null;
  waitingFor?: import('./leads.js').LinkedInQueueWaitReason | null;
}

interface WithdrawalRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  action_id: string;
  target_ref: string;
  status: string;
  failure_kind: string | null;
  detail: string | null;
  pending_days: number | null;
  claimed_at: string | null;
  queued_at: string;
  finished_at: string | null;
}

// TIMESTAMPTZ is formatted in SQL rather than parsed from what the pool hands
// back -- the same choice, for the same reason, as `SEAT_COLUMNS` in seats.ts:
// one ISO-8601 shape crosses the API.
const WITHDRAWAL_COLUMNS = `
  id, workspace_id, seat_key, action_id, target_ref, status, failure_kind, detail, pending_days,
  TO_CHAR(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at,
  TO_CHAR(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS queued_at,
  TO_CHAR(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at
`;

/**
 * The withdrawal queue for one workspace, newest first.
 *
 * `workspace_id=?` is the first clause and is not optional: a withdrawal id is
 * a global identifier, so a handler that looked one up by id alone would serve
 * one workspace's queue to another's session. Same rule as every other read in
 * this subsystem.
 */
export async function listWithdrawals(
  db: Db,
  workspaceId: string,
  filters: { status?: WithdrawalStatus; seatKey?: string; limit?: number } = {}
): Promise<WithdrawalRecord[]> {
  const clauses = ['workspace_id=?'];
  const params: unknown[] = [workspaceId];
  if (filters.seatKey) {
    clauses.push('seat_key=?');
    params.push(filters.seatKey);
  }
  if (filters.status) {
    clauses.push('status=?');
    params.push(filters.status);
  }
  params.push(Math.max(1, Math.min(filters.limit ?? 100, 500)));

  const rows = await db.prepare(`
    SELECT ${WITHDRAWAL_COLUMNS} FROM linkedin_withdrawals
    WHERE ${clauses.join(' AND ')}
    ORDER BY queued_at DESC, id DESC
    LIMIT ?
  `).all<WithdrawalRow>(...params);

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    actionId: row.action_id,
    targetRef: row.target_ref,
    status: row.status as WithdrawalStatus,
    failureKind: (row.failure_kind as LinkedInFailureKind | null) ?? null,
    detail: row.detail,
    pendingDays: row.pending_days,
    claimedAt: row.claimed_at,
    queuedAt: row.queued_at,
    finishedAt: row.finished_at
  }));
}

/* ---------------------------------------------------------------------------
 * 4. The gate, and the withdrawal's own ceiling
 * ------------------------------------------------------------------------ */

/**
 * The most withdrawals this seat may perform in a rolling 24 hours.
 *
 * DERIVED, NOT INVENTED, and that distinction is `limits.ts`'s house rule: no
 * number in this codebase pretends to be research when it is a guess. Nobody
 * has published a withdrawal ceiling, so rather than making one up this reads
 * the seat's own invite band -- a seat may take back no more invites per day
 * than it may send. It follows posture automatically (18/day steady, 5/day
 * warm-up or cooldown), and it is defensible on the plan's own terms: 1.3 says
 * detection is behavioural, so a day spent withdrawing should have the shape
 * of a day spent inviting.
 *
 * THE WARM-UP MULTIPLIER IS DELIBERATELY NOT APPLIED. Multiplying by the
 * week-1 zero would make withdrawal impossible during warm-up -- the period
 * where a seat is most fragile and least able to afford a backlog. The band is
 * the ceiling; the ramp governs sending.
 */
export function withdrawalCeilingFor(posture: SeatPosture | null): number {
  return bandFor('invite', posture === 'steady' ? 'steady' : 'warmup').perDay;
}

/** Withdrawals this seat actually performed in the `hours` before `now`. */
export async function withdrawalsInWindow(db: Db, seat: SeatRef, hours: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*)::int AS total FROM linkedin_withdrawals
    WHERE workspace_id=? AND seat_key=? AND status='withdrawn' AND finished_at > ?::timestamptz
  `).get<{ total: number }>(seat.workspaceId, seat.seatKey, since);
  return row?.total ?? 0;
}

export interface WithdrawalVerdict {
  allowed: boolean;
  /** The first thing that refused, in evaluation order. Null when nothing did. */
  reason: string | null;
  /** The seat gate's verdict, verbatim and unfiltered. */
  gate: LinkedInSafetyVerdict;
  usedToday: number;
  dailyCeiling: number;
}

/**
 * May this seat withdraw this invite, right now?
 *
 * TWO NUMBERS, AND NEITHER IS DISCOUNTED.
 *
 * The first is `evaluateLinkedInSafety` run for `invite`, used WHOLE. Not one
 * check of it, not all-but-one: `local-worker.ts` states the rule -- "NO
 * FILTERING OF THE VERDICT, ANYWHERE" -- because "ignore the guard under
 * conditions X" is a line whose next edit widens X. So a seat that has
 * exhausted its invite budget for the day does not withdraw either, and that
 * is the intended reading rather than an accident: both are automated activity
 * on the same account in the same hour, and plan 1.3's signal is the seat's
 * total behavioural volume, not a per-kind tally. One shared budget also means
 * withdrawal can never silently double a day's action count.
 *
 * `excludeActionId` names the invite being withdrawn, so `duplicate-target`
 * does not fail on the very row that is the subject of the question. It
 * excludes exactly that one row by primary key; any OTHER action against the
 * same person still fails the check.
 *
 * The second number is this module's own daily ceiling, which exists because
 * the gate cannot supply it: a withdrawal is not recorded as an invite in
 * `linkedin_actions` (it sent nothing), so it never increments the count
 * `rolling-24h` reads, and four hundred withdrawals would each pass that check
 * individually while collectively being the surge. It is a SEPARATE number
 * rather than a twelfth check because `LinkedInCheckName` is guard.ts's to
 * extend and this module does not edit guard.ts.
 */
export async function evaluateWithdrawalSafety(
  db: Db,
  seat: SeatRef,
  subject: { actionId: string; targetRef: string },
  now: Date
): Promise<WithdrawalVerdict> {
  const gate = await evaluateLinkedInSafety(
    db,
    {
      workspaceId: seat.workspaceId,
      seatKey: seat.seatKey,
      kind: 'invite',
      targetRef: subject.targetRef,
      // A withdrawal happens now, so `now` is the instant business hours and
      // the weekend rule are judged against. There is no planned slot to point
      // at: nothing schedules withdrawals in advance.
      plannedFor: now.toISOString()
    },
    now,
    { excludeActionId: subject.actionId }
  );

  // PER SEAT, and the omission this line replaces was not cosmetic:
  // `getSeatPosture` defaults its last argument to the OWNER seat, so a
  // withdrawal pass on a secondary account read the owner's posture. A paused
  // or cooling secondary kept withdrawing on the owner's say-so, and an owner
  // in cooldown froze accounts that were fine. `seat.seatKey` is the whole fix
  // and it is the same fix `postgresLocalWorkerStore.seatPosture` already
  // carries a comment about.
  const posture = await getSeatPosture(db, seat.workspaceId, now, seat.seatKey);
  const dailyCeiling = withdrawalCeilingFor(posture);
  const usedToday = await withdrawalsInWindow(db, seat, 24, now);
  const underCeiling = usedToday + 1 <= dailyCeiling;

  return {
    allowed: gate.allowed && underCeiling,
    reason: !gate.allowed
      ? gate.reason
      : underCeiling
        ? null
        : `withdrawal-daily-ceiling: ${usedToday} of ${dailyCeiling} withdrawals used in the last 24 hours (${posture ?? 'no seat'} band). Clearing a backlog in one burst is the same volume spike as sending one.`,
    gate,
    usedToday,
    dailyCeiling
  };
}

/* ---------------------------------------------------------------------------
 * 5. Claim, execute, settle
 * ------------------------------------------------------------------------ */

interface ClaimedRow {
  id: string;
  workspace_id: string;
  seat_key: string;
  action_id: string;
  target_ref: string;
  pending_days: number | null;
}

/**
 * Atomically claim the oldest queued withdrawal, or null when there is none.
 *
 * CLAIM AND SELECT IN ONE STATEMENT, exactly as `claimNextDueAction` does.
 * `FOR UPDATE SKIP LOCKED` means two workers on the same Postgres take
 * different rows instead of the same one, and `claimed_at IS NULL` means a
 * held row -- one whose outcome we never learned -- is never handed out again.
 */
export async function claimNextWithdrawal(
  db: Db,
  seat: SeatRef,
  batchId: string,
  now: Date
): Promise<ClaimedWithdrawal | null> {
  const row = await db.prepare(`
    UPDATE linkedin_withdrawals SET claimed_at=?, batch_id=?
    WHERE id = (
      SELECT id FROM linkedin_withdrawals
      WHERE workspace_id=? AND seat_key=? AND status='queued' AND claimed_at IS NULL
      ORDER BY queued_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, workspace_id, seat_key, action_id, target_ref, pending_days
  `).get<ClaimedRow>(now.toISOString(), batchId, seat.workspaceId, seat.seatKey);
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    actionId: row.action_id,
    targetRef: row.target_ref,
    pendingDays: row.pending_days
  };
}

/**
 * Rows an action inherits from the invite it is about.
 *
 * A withdrawal and an acceptance check are both ABOUT an invite, so both are
 * about that invite's campaign, member and workflow step -- and an analytics
 * panel that groups by any of the three would otherwise drop them on the floor.
 * `recordAction` does not take these columns (no caller had them until now), so
 * they are copied across in the same shape `runner.ts` uses after its own
 * insert.
 */
interface InviteLineage {
  campaign_id: string | null;
  campaign_member_id: string | null;
  workflow_step_id: string | null;
}

async function inviteLineage(db: Db, workspaceId: string, actionId: string): Promise<InviteLineage> {
  const row = await db.prepare(`
    SELECT campaign_id, campaign_member_id, workflow_step_id FROM linkedin_actions
    WHERE id=? AND workspace_id=?
  `).get<InviteLineage>(actionId, workspaceId);
  return row ?? { campaign_id: null, campaign_member_id: null, workflow_step_id: null };
}

/**
 * File one confirmed withdrawal as an action in its own right.
 *
 * WHY THIS IS NOT ALREADY COVERED BY `markActionWithdrawn`. That function
 * writes `status='withdrawn'` onto the INVITE, which is the correct and
 * complete thing to say about the invite: it went out, nobody answered, it was
 * taken back. It says nothing at all about the withdrawal, and the withdrawal
 * is a separate event with its own date, its own place in the day's traffic and
 * its own risk. Concretely, before this row existed:
 *
 *   - `countActionKindsInWindow` could not see a single withdrawal, so a seat
 *     that spent an afternoon clearing four hundred stale invites had, by every
 *     rolling count in `actions.ts`, done nothing that afternoon.
 *   - `managedAnalytics` reported `invitesWithdrawn` off the invite's terminal
 *     status and dated it by the INVITE's `recorded_at`, so the withdrawals a
 *     campaign performed this week appeared in the week the invites were sent.
 *   - the funnel's own "what did this account do today" had a hole in it the
 *     exact size of the feature that exists to protect the account.
 *
 * DATED `now`, WHICH IS THE POINT. The invite keeps its send date; this row
 * carries the withdrawal's own, so the two facts stop sharing one clock.
 *
 * `source: 'system'` -- no human queued it and no approved sequence contains
 * it; the stale-invite sweep decided it. `replayScope` is the invite's id, so
 * one invite can produce exactly one withdrawal row and a re-run of a settled
 * queue row is a no-op rather than a second entry (`recordAction` reports the
 * duplicate and writes nothing).
 *
 * DOES NOT GATE, AND MUST NOT. The click has already happened -- it happened
 * two lines above this call, after `evaluateWithdrawalSafety` allowed it. A row
 * that recorded only the withdrawals a gate would still permit would be a
 * ledger that under-reports precisely when the account is closest to trouble.
 */
async function recordWithdrawalAction(
  db: Db,
  seat: SeatRef,
  claimed: ClaimedWithdrawal,
  now: Date
): Promise<void> {
  const lineage = await inviteLineage(db, seat.workspaceId, claimed.actionId);
  const written = await recordAction(
    db,
    {
      workspaceId: seat.workspaceId,
      seatKey: seat.seatKey,
      kind: 'withdraw',
      targetRef: claimed.targetRef,
      campaignId: lineage.campaign_id,
      status: 'sent',
      source: 'system',
      replayScope: `withdraw:${claimed.actionId}`,
      recordedAt: now.toISOString()
    },
    now
  );
  if (written.duplicate) return;
  await db.prepare(`
    UPDATE linkedin_actions SET campaign_member_id=?, workflow_step_id=?, external_ref=?
    WHERE id=? AND workspace_id=?
  `).run(lineage.campaign_member_id, lineage.workflow_step_id, claimed.actionId, written.id, seat.workspaceId);
}

/** Put a claimed withdrawal back in the queue untouched. Nothing was clicked. */
export async function releaseWithdrawalClaim(db: Db, withdrawalId: string, workspaceId: string): Promise<void> {
  await db.prepare(`
    UPDATE linkedin_withdrawals SET claimed_at=NULL, batch_id=NULL
    WHERE id=? AND workspace_id=?
  `).run(withdrawalId, workspaceId);
}

/**
 * Mark the invite this withdrawal was for.
 *
 * THE ONLY PLACE `WITHDRAWN_STATUS` IS WRITTEN, and it is guarded by the
 * status the row must still be in: an invite that became 'accepted' between
 * the claim and this write is not overwritten, it is left alone and the update
 * changes nothing. Returns whether it landed, so a caller can tell "we
 * withdrew it and said so" from "we withdrew something whose ledger row moved
 * underneath us".
 *
 * `recorded_at` is untouched on purpose. The invite really was sent and every
 * rolling window must keep counting it; withdrawing does not un-send it, and a
 * status that returned the budget would let an operator launder volume by
 * withdrawing and re-sending. `pending_seen_at` is cleared because it is
 * evidence about something that is no longer pending.
 */
export async function markActionWithdrawn(db: Db, seat: SeatRef, actionId: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE linkedin_actions
    SET status='${WITHDRAWN_STATUS}', pending_seen_at=NULL
    WHERE id=? AND workspace_id=? AND seat_key=? AND kind='invite' AND status IN ('sent', 'exported')
  `).run(actionId, seat.workspaceId, seat.seatKey);
  return result.changes > 0;
}

async function settle(
  db: Db,
  withdrawalId: string,
  workspaceId: string,
  status: WithdrawalStatus,
  failureKind: LinkedInFailureKind | null,
  detail: string,
  now: Date,
  keepClaim = false
): Promise<void> {
  await db.prepare(`
    UPDATE linkedin_withdrawals
    SET status=?, failure_kind=?, detail=?, finished_at=?, claimed_at=${keepClaim ? 'claimed_at' : 'NULL'}
    WHERE id=? AND workspace_id=?
  `).run(status, failureKind, detail, now.toISOString(), withdrawalId, workspaceId);
}

export interface WithdrawalExecutionDeps {
  driver: LinkedInWithdrawDriver;
  page: LinkedInListPage;
  /** Defaults to {@link evaluateWithdrawalSafety}. Injected so a test can assert it ran. */
  evaluate?: (claimed: ClaimedWithdrawal, now: Date) => Promise<WithdrawalVerdict>;
}

export interface WithdrawalOutcome {
  /** What the queue row ended up as. 'queued' means the claim was released. */
  status: WithdrawalStatus;
  failureKind: LinkedInFailureKind | null;
  /** One sentence, written for the operator reading the queue later. */
  detail: string;
  /** True only when LinkedIn confirmed it AND the ledger row was marked. */
  withdrawn: boolean;
  /** True when the gate refused; nothing was clicked and the row is queued again. */
  blocked: boolean;
  /** True when the caller must end the pass rather than claim another row. */
  halt: boolean;
  /** Set when LinkedIn told us to stop, so the caller can put the seat in cooldown. */
  cooldown: boolean;
}

/**
 * Perform one claimed withdrawal, end to end.
 *
 * THE ORDER IS THE SAFETY PROPERTY, and each step is here because skipping it
 * produces a specific wrong outcome:
 *
 *   1. RE-READ THE LEDGER ROW. A sync between the sweep and now may have
 *      learned the invite was accepted. Acting on the queue row alone would
 *      withdraw an accepted connection -- the one destructive mistake this
 *      feature can make.
 *   2. RUN THE GATE, whole, immediately before acting. Never once per batch: a
 *      queue built this morning can be stale by this afternoon, and only the
 *      ledger knows. Same discipline as the invite worker.
 *   3. LET THE DRIVER RE-READ LINKEDIN. It opens the live sent-invitations
 *      list and clicks nothing if the entry is gone. That is the check that
 *      can actually be true at the instant it matters, and it is why step 1 is
 *      a cheap guard rather than the whole defence.
 *   4. MARK THE LEDGER ONLY ON A CONFIRMED WITHDRAWAL. Every other outcome
 *      leaves `linkedin_actions` exactly as it was, because an outcome nobody
 *      observed must not be written down.
 *
 * Returns rather than throws, for the reason `runLinkedInLocalBatch` gives: a
 * pass that ends early has still done real things to a real account, and the
 * caller needs to know which.
 */
export async function executeWithdrawal(
  db: Db,
  seat: SeatRef,
  deps: WithdrawalExecutionDeps,
  claimed: ClaimedWithdrawal,
  now: Date
): Promise<WithdrawalOutcome> {
  // --- 1. Is the invite still ours to withdraw? ---
  const subject = await db.prepare(`
    SELECT status FROM linkedin_actions
    WHERE id=? AND workspace_id=? AND seat_key=? AND kind='invite'
  `).get<{ status: string }>(claimed.actionId, seat.workspaceId, seat.seatKey);

  if (!subject || (subject.status !== 'sent' && subject.status !== 'exported')) {
    const detail = subject
      ? `The invite is '${subject.status}' in the ledger, not awaiting an answer, so there was nothing to withdraw and nothing was clicked.`
      : 'The invite this withdrawal was queued for is no longer in the ledger, so nothing was clicked.';
    await settle(db, claimed.id, seat.workspaceId, 'stale', null, detail, now);
    return { status: 'stale', failureKind: null, detail, withdrawn: false, blocked: false, halt: false, cooldown: false };
  }

  // --- 2. The gate, per action, immediately before the browser is touched. ---
  const evaluate =
    deps.evaluate ??
    ((row: ClaimedWithdrawal, at: Date) =>
      evaluateWithdrawalSafety(db, seat, { actionId: row.actionId, targetRef: row.targetRef }, at));

  let verdict: WithdrawalVerdict;
  try {
    verdict = await evaluate(claimed, now);
  } catch (cause) {
    // "I could not find out whether this is safe" is not "it is safe".
    await releaseWithdrawalClaim(db, claimed.id, seat.workspaceId);
    const detail = `The safety gate could not be evaluated: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { status: 'queued', failureKind: null, detail, withdrawn: false, blocked: true, halt: true, cooldown: false };
  }

  if (!verdict.allowed) {
    await releaseWithdrawalClaim(db, claimed.id, seat.workspaceId);
    const detail = verdict.reason ?? 'The safety gate refused this withdrawal.';
    return { status: 'queued', failureKind: null, detail, withdrawn: false, blocked: true, halt: false, cooldown: false };
  }

  // --- 3. The driver re-reads LinkedIn and acts. ---
  const result = await deps.driver.withdrawInvite(deps.page, claimed.targetRef);

  if (result.ok) {
    // --- 4. The ledger, and only now. ---
    const marked = await markActionWithdrawn(db, seat, claimed.actionId);
    // The withdrawal ITSELF, as its own action. See `recordWithdrawalAction`
    // for why the invite's status change is not the same fact. Filed whether or
    // not the invite row could still be marked: LinkedIn confirmed the click,
    // and the click is what this row records.
    await recordWithdrawalAction(db, seat, claimed, now);
    const detail = marked
      ? `Withdrawn after ${claimed.pendingDays ?? '?'} day(s) pending.`
      : 'LinkedIn withdrew the invite, but its ledger row had already moved on and was left exactly as it was. Nothing was overwritten.';
    await settle(db, claimed.id, seat.workspaceId, 'withdrawn', null, detail, now);
    return { status: 'withdrawn', failureKind: null, detail, withdrawn: marked, blocked: false, halt: false, cooldown: false };
  }

  const failureKind = result.failureKind ?? 'unknown';
  const detail = result.detail ?? `The withdrawal failed: ${failureKind}.`;

  if (failureKind === 'already_connected' || failureKind === 'not_found') {
    // DEFINITE, AND THE LEDGER IS LEFT ALONE. The entry was not on the live
    // list, and accepted / declined / expired / already-withdrawn are
    // indistinguishable from here. Writing any of them down would be a guess in
    // the one place -- the acceptance rate -- where a guess changes what the
    // pacing engine does next.
    await settle(db, claimed.id, seat.workspaceId, 'stale', failureKind, detail, now);
    return { status: 'stale', failureKind, detail, withdrawn: false, blocked: false, halt: false, cooldown: false };
  }

  if (failureKind === 'limit_wall' || failureKind === 'challenge') {
    // LINKEDIN SAID STOP. Nothing was withdrawn, so the row is released for a
    // later attempt -- but the seat goes into cooldown and the pass is over.
    // Whatever produced this needs a person, not a retry.
    await settle(db, claimed.id, seat.workspaceId, 'failed', failureKind, detail, now);
    return { status: 'failed', failureKind, detail, withdrawn: false, blocked: false, halt: true, cooldown: true };
  }

  if (failureKind === 'selector_drift') {
    // The driver guarantees nothing was clicked, so this is releasable. The
    // pass still ends: if one selector has drifted, every remaining row would
    // reload the same list for nothing.
    await settle(db, claimed.id, seat.workspaceId, 'failed', failureKind, detail, now);
    return { status: 'failed', failureKind, detail, withdrawn: false, blocked: false, halt: true, cooldown: false };
  }

  // `unknown`: we clicked and lost the thread. HOLD the claim -- the invite may
  // or may not still be standing, and both "withdrawn" and "still pending"
  // would be inventions. A human settles this row.
  await settle(db, claimed.id, seat.workspaceId, 'held', failureKind, detail, now, true);
  return { status: 'held', failureKind, detail, withdrawn: false, blocked: false, halt: true, cooldown: false };
}

/* ---------------------------------------------------------------------------
 * 6. One paced pass over the queue
 * ------------------------------------------------------------------------ */

export interface WithdrawalBatchDeps extends WithdrawalExecutionDeps {
  /**
   * The pass this run is recorded under. Supplied by the caller rather than
   * opened here: whether a withdrawal pass gets its own `linkedin_batches` row
   * -- and therefore whether `stopLinkedInBatches` reaches it -- is a wiring
   * decision, and this module does not make wiring decisions for routes it
   * cannot see.
   */
  batchId: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The kill switch, read between every action. Absent means nothing can stop it. */
  stopRequested?: () => Promise<boolean>;
  /** Default {@link DEFAULT_MAX_WITHDRAWALS}. */
  maxActions?: number;
  log?: (message: string) => void;
}

export interface WithdrawalBatchResult {
  workspaceId: string;
  seatKey: string;
  batchId: string;
  withdrawn: number;
  /** Not pending any more when we looked. Nothing was clicked. */
  stale: number;
  /** Refused by the gate and released. */
  blocked: number;
  failed: number;
  halted: boolean;
  haltReason: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Why this seat may not be worked, or null when it may.
 *
 * Identical to the invite worker's rule, including the part that is stricter
 * than the gate: a seat in cooldown is a seat LinkedIn pushed back on, and what
 * clears that is a person, not time passing. A withdrawal is still automated
 * traffic on a restricted account.
 */
function postureRefusal(posture: SeatPosture | null): string | null {
  if (posture === null) return 'No LinkedIn seat is configured for this workspace, so there is nothing to pace against.';
  if (posture === 'paused') return 'The seat is paused.';
  if (posture === 'cooldown') {
    return 'The seat is in cooldown after a limit wall or challenge; resume it by hand once you know why.';
  }
  return null;
}

/**
 * One paced pass over the withdrawal queue.
 *
 * THE GAP BETWEEN ACTIONS IS THE POINT OF THIS FUNCTION. Everything else here
 * is bookkeeping around `executeWithdrawal`; what only a loop can supply is the
 * seeded 30-120s pause that stops a backlog clearance from being a burst. It
 * uses `actionGapSeconds` from the invite worker rather than a second
 * generator, so both kinds of action are paced by the same band and the same
 * reproducible draw.
 *
 * The gap goes BEFORE the gate for the same reason it does there: the verdict
 * has to be the last thing that happens before the browser moves, and a
 * two-minute sleep after it would make it stale by exactly that much.
 */
export async function runWithdrawalBatch(
  db: Db,
  seat: SeatRef,
  deps: WithdrawalBatchDeps
): Promise<WithdrawalBatchResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  const maxActions = Math.max(1, Math.trunc(deps.maxActions ?? DEFAULT_MAX_WITHDRAWALS));
  const result: WithdrawalBatchResult = {
    workspaceId: seat.workspaceId,
    seatKey: seat.seatKey,
    batchId: deps.batchId,
    withdrawn: 0,
    stale: 0,
    blocked: 0,
    failed: 0,
    halted: false,
    haltReason: null
  };

  // Per seat, for the reason `evaluateWithdrawalSafety` gives: this batch is
  // ONE account's, and the posture that may stop it is that account's.
  const refusal = postureRefusal(await getSeatPosture(db, seat.workspaceId, now(), seat.seatKey));
  if (refusal) return { ...result, halted: true, haltReason: refusal };

  for (let index = 0; index < maxActions; index += 1) {
    if (deps.stopRequested && (await deps.stopRequested())) {
      result.halted = true;
      result.haltReason = 'A stop was requested for this batch.';
      break;
    }

    // Re-read every pass, so pausing the seat stops the loop within one action
    // rather than at the end of the queue -- and read for THIS seat, so pausing
    // this account stops this loop and pausing another one does not.
    const current = postureRefusal(await getSeatPosture(db, seat.workspaceId, now(), seat.seatKey));
    if (current) {
      result.halted = true;
      result.haltReason = current;
      break;
    }

    const claimed = await claimNextWithdrawal(db, seat, deps.batchId, now());
    if (!claimed) break;

    if (index > 0) await sleep(Math.round(actionGapSeconds(`${deps.batchId}:${claimed.id}`) * 1000));

    const outcome = await executeWithdrawal(db, seat, deps, claimed, now());

    if (outcome.status === 'withdrawn') result.withdrawn += 1;
    else if (outcome.status === 'stale') result.stale += 1;
    else if (outcome.blocked) result.blocked += 1;
    else result.failed += 1;

    if (outcome.blocked) log(`LinkedIn withdrawal ${claimed.id} was refused: ${outcome.detail}`);
    // THE SEAT THAT HIT THE WALL IS THE SEAT THAT COOLS. `upsertSeat` also
    // defaults to the owner, so a limit wall on a secondary account used to put
    // the OWNER into cooldown -- stopping the account that was behaving and
    // leaving the restricted one to keep clicking.
    if (outcome.cooldown) await upsertSeat(db, seat.workspaceId, { posture: 'cooldown' }, now(), seat.seatKey);

    if (outcome.halt) {
      result.halted = true;
      result.haltReason = outcome.detail;
      break;
    }
  }

  return result;
}

/* ---------------------------------------------------------------------------
 * 7. Acceptance detection
 * ------------------------------------------------------------------------ */

/**
 * WHY THIS LIVES IN THE WITHDRAWAL MODULE.
 *
 * It is the same evidence, read to answer the other half of the same question.
 * `syncPendingInvites` already reconciles LinkedIn's sent-invitations list
 * against the ledger, and the fact it deliberately refuses to interpret --
 * "this invite is no longer on the list" -- is the exact fact acceptance
 * detection starts from. The disappearance means accepted, declined, expired
 * or withdrawn, LinkedIn will not say which, and the sync is right to write
 * evidence and stop. This section is what goes and finds out.
 *
 * THREE RULES, and each one is why a previous attempt at this would have been
 * wrong:
 *
 * 1. THE ANSWER COMES FROM LINKEDIN, NOT FROM ARITHMETIC. A 1st-degree badge on
 *    the target's profile is LinkedIn stating the connection exists. Everything
 *    else available here -- an invite vanishing, a Connect button reappearing,
 *    a message going through -- is circumstantial, and one of them (the
 *    disappearance) is compatible with three outcomes that are not acceptance.
 *
 * 2. "GONE, DEGREE NOT CONFIRMED" IS UNKNOWN AND STAYS UNKNOWN. The invite
 *    keeps its 'sent' status, the acceptance rate keeps its old denominator,
 *    and `acceptance_checked_at` records that a page view was spent so the same
 *    unreadable profile is not re-read on every tick. A detector that guessed
 *    would be worse than no detector: `acceptanceRate` feeds a throttle, and a
 *    throttle fed guesses paces a real account on fiction.
 *
 * 3. A CHECK IS A PROFILE VIEW AND IS PACED, GATED AND BUDGETED AS ONE. There
 *    is no cheap way to read a relationship -- the badge is on the profile page
 *    -- so every check runs `evaluateLinkedInSafety` for `profile_view`
 *    immediately before it navigates, sleeps the same seeded 30-120s gap the
 *    invite worker uses, respects the seat's posture and working hours through
 *    that gate, halts the pass on a limit wall or a challenge, and files a
 *    `profile_view` ledger row so it charges the seat's own daily view ceiling.
 *    An unattended loop that opened a thousand profiles a night to protect an
 *    account would be the fastest way to lose one.
 *
 * EVERYTHING IS PER SEAT. The candidate query, the gate, the posture read, the
 * ledger row and the cooldown all take `seat` and none of them defaults to the
 * owner: a workspace running three accounts must not detect one account's
 * acceptances against another account's browser, budget or standing.
 */

/** How many profiles one detection pass will open. */
export const DEFAULT_MAX_ACCEPTANCE_CHECKS = 10;

/** An invite that left the pending list and has not been ruled on. */
export interface AcceptanceCandidate {
  actionId: string;
  targetRef: string;
  campaignId: string | null;
  campaignMemberId: string | null;
  workflowStepId: string | null;
  /** When LinkedIn last showed this invite as pending. */
  pendingSeenAt: string | null;
}

interface AcceptanceCandidateRow {
  id: string;
  target_ref: string;
  campaign_id: string | null;
  campaign_member_id: string | null;
  workflow_step_id: string | null;
  pending_seen_at: string | null;
}

/**
 * Invites worth spending a page view on.
 *
 * FOUR PREDICATES, AND EVERY ONE OF THEM IS THE DIFFERENCE BETWEEN A DETECTOR
 * AND A CRAWLER:
 *
 *   status IN ('sent','exported')  -- undecided. Anything else has an answer.
 *   pending_seen_at IS NOT NULL    -- we have positive evidence it WAS pending.
 *                                     An invite nobody ever saw on the list is
 *                                     not evidence of a disappearance, it is
 *                                     evidence of never having looked -- the
 *                                     same rule `syncPendingInvites` applies to
 *                                     its own `disappeared` count.
 *   pending_seen_at < pending_synced_at -- it was absent from a COMPLETE read
 *                                     of the list. The seat's clock, written
 *                                     only by an untruncated sync (migration
 *                                     070), is what makes this mean "gone"
 *                                     rather than "not reached".
 *   acceptance_checked_at IS NULL     -- not already looked at since it went
 *     OR < pending_seen_at              missing. An invite that REAPPEARS on
 *                                       the list and vanishes again moves
 *                                       `pending_seen_at` forward and is worth
 *                                       one more look; one that simply stayed
 *                                       unreadable is not, forever.
 *
 * OLDEST DISAPPEARANCE FIRST, so a seat with more candidates than one pass can
 * afford works through them in a stable order instead of re-reading the head of
 * an unordered set every tick.
 */
export async function selectAcceptanceCandidates(
  db: Db,
  seat: SeatRef,
  options: { limit?: number } = {}
): Promise<AcceptanceCandidate[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_MAX_ACCEPTANCE_CHECKS));
  const rows = await db.prepare(`
    SELECT a.id, a.target_ref, a.campaign_id, a.campaign_member_id, a.workflow_step_id, a.pending_seen_at
    FROM linkedin_actions a
    JOIN linkedin_seats s ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key
    WHERE a.workspace_id=? AND a.seat_key=? AND a.kind='invite'
      AND a.status IN ('sent', 'exported')
      AND a.target_ref IS NOT NULL
      AND a.pending_seen_at IS NOT NULL
      AND s.pending_synced_at IS NOT NULL
      AND a.pending_seen_at < s.pending_synced_at
      AND (a.acceptance_checked_at IS NULL OR a.acceptance_checked_at < a.pending_seen_at)
    ORDER BY a.pending_seen_at ASC, a.id ASC
    LIMIT ?
  `).all<AcceptanceCandidateRow>(seat.workspaceId, seat.seatKey, limit);

  return rows.map((row) => ({
    actionId: row.id,
    targetRef: row.target_ref,
    campaignId: row.campaign_id,
    campaignMemberId: row.campaign_member_id,
    workflowStepId: row.workflow_step_id,
    pendingSeenAt: row.pending_seen_at
  }));
}

/** Record that a page view was spent on this invite, so it is not re-read every tick. */
async function markAcceptanceChecked(db: Db, seat: SeatRef, actionId: string, now: Date): Promise<void> {
  await db.prepare(`
    UPDATE linkedin_actions SET acceptance_checked_at=?::timestamptz
    WHERE id=? AND workspace_id=? AND seat_key=?
  `).run(now.toISOString(), actionId, seat.workspaceId, seat.seatKey);
}

/** The profile still shows a pending invite: refresh the evidence and leave the status alone. */
async function markStillPending(db: Db, seat: SeatRef, actionId: string, now: Date): Promise<void> {
  await db.prepare(`
    UPDATE linkedin_actions SET pending_seen_at=?::timestamptz, acceptance_checked_at=?::timestamptz
    WHERE id=? AND workspace_id=? AND seat_key=?
  `).run(now.toISOString(), now.toISOString(), actionId, seat.workspaceId, seat.seatKey);
}

/**
 * File the profile view the check just performed.
 *
 * NOT OPTIONAL AND NOT DEFERRABLE. Opening the profile IS the view -- LinkedIn
 * records it server-side on load, exactly as `viewProfile` does -- so a
 * detector that skipped this row would spend a seat's profile-view budget
 * without charging it, and `guard.ts` would keep granting a ceiling that had
 * already been spent. `replayScope` is per invite so the duplicate guard sees a
 * re-check as the same action rather than as a forbidden second view, and so
 * that a campaign's OWN `profile_view` step against the same person is a
 * different row rather than a collision.
 */
async function recordAcceptanceCheckView(
  db: Db,
  seat: SeatRef,
  candidate: AcceptanceCandidate,
  now: Date
): Promise<void> {
  const written = await recordAction(
    db,
    {
      workspaceId: seat.workspaceId,
      seatKey: seat.seatKey,
      kind: 'profile_view',
      targetRef: candidate.targetRef,
      campaignId: candidate.campaignId,
      status: 'sent',
      source: 'system',
      replayScope: `acceptance:${candidate.actionId}`,
      recordedAt: now.toISOString()
    },
    now
  );
  if (written.duplicate) {
    // A re-check of the same invite. The view happened again and the budget was
    // spent again, so the row's date moves rather than a second row appearing:
    // one row per invite, dated at the most recent look.
    await db.prepare(`
      UPDATE linkedin_actions SET recorded_at=?::timestamptz
      WHERE id=? AND workspace_id=?
    `).run(now.toISOString(), written.id, seat.workspaceId);
    return;
  }
  await db.prepare(`
    UPDATE linkedin_actions SET campaign_member_id=?, workflow_step_id=?
    WHERE id=? AND workspace_id=?
  `).run(candidate.campaignMemberId, candidate.workflowStepId, written.id, seat.workspaceId);
}

export interface AcceptanceDetectionDeps {
  /** Defaults to the real Playwright routine. A test supplies a fake. */
  driver?: LinkedInDegreeDriver;
  page: LinkedInPage;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The kill switch, read between every check. Absent means nothing can stop it. */
  stopRequested?: () => Promise<boolean>;
  /** Default {@link DEFAULT_MAX_ACCEPTANCE_CHECKS}. */
  maxChecks?: number;
  /** Injected so a test can prove the gate ran. Defaults to the real gate. */
  evaluate?: (candidate: AcceptanceCandidate, at: Date) => Promise<LinkedInSafetyVerdict>;
  log?: (message: string) => void;
}

export interface AcceptanceDetectionResult {
  workspaceId: string;
  seatKey: string;
  /** Profiles actually opened. */
  checked: number;
  /** Invites LinkedIn confirmed as 1st-degree connections. */
  accepted: number;
  /** Still showing a pending invite on the profile: the sync was stale, not the invite decided. */
  stillPending: number;
  /** Gone from the list and the degree was NOT confirmed. Nothing was written to the status. */
  unknown: number;
  /** The safety gate refused the page view. Nothing was opened. */
  blocked: number;
  halted: boolean;
  haltReason: string | null;
}

/**
 * One paced pass over this seat's undecided invites.
 *
 * The order inside the loop is the safety property, and it is the invite
 * worker's order rather than a new one: stop switch, posture, gap, GATE,
 * browser. The gate is the last thing before the navigation because a verdict
 * with a two-minute sleep after it is a verdict that is two minutes stale.
 *
 * NEVER THROWS FOR A LINKEDIN PROBLEM, for the reason `jobs.ts` rule 2 gives:
 * half the callers are worker ticks and the other half are HTTP handlers.
 */
export async function detectAcceptedInvites(
  db: Db,
  seat: SeatRef,
  deps: AcceptanceDetectionDeps
): Promise<AcceptanceDetectionResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  const driver = deps.driver ?? playwrightDegreeDriver;
  const maxChecks = Math.max(1, Math.trunc(deps.maxChecks ?? DEFAULT_MAX_ACCEPTANCE_CHECKS));
  const result: AcceptanceDetectionResult = {
    workspaceId: seat.workspaceId,
    seatKey: seat.seatKey,
    checked: 0,
    accepted: 0,
    stillPending: 0,
    unknown: 0,
    blocked: 0,
    halted: false,
    haltReason: null
  };

  const refusal = postureRefusal(await getSeatPosture(db, seat.workspaceId, now(), seat.seatKey));
  if (refusal) return { ...result, halted: true, haltReason: refusal };

  const candidates = await selectAcceptanceCandidates(db, seat, { limit: maxChecks });

  for (const [index, candidate] of candidates.entries()) {
    if (deps.stopRequested && (await deps.stopRequested())) {
      result.halted = true;
      result.haltReason = 'A stop was requested for this batch.';
      break;
    }

    // Re-read per check, and for THIS seat: pausing this account stops this
    // loop within one page view rather than at the end of the list.
    const current = postureRefusal(await getSeatPosture(db, seat.workspaceId, now(), seat.seatKey));
    if (current) {
      result.halted = true;
      result.haltReason = current;
      break;
    }

    if (index > 0) await sleep(Math.round(actionGapSeconds(`acceptance:${candidate.actionId}`) * 1000));

    const at = now();
    const evaluate =
      deps.evaluate ??
      ((row: AcceptanceCandidate, when: Date) =>
        evaluateLinkedInSafety(
          db,
          {
            workspaceId: seat.workspaceId,
            seatKey: seat.seatKey,
            // A page view, because that is what it is. Business hours, the
            // weekend rule, the posture, the seat's own daily view ceiling and
            // the rolling windows all apply, unfiltered.
            kind: 'profile_view',
            targetRef: row.targetRef,
            plannedFor: when.toISOString(),
            ...(row.campaignId === null ? {} : { campaignId: row.campaignId }),
            replayScope: `acceptance:${row.actionId}`
          },
          when
        ));

    let verdict: LinkedInSafetyVerdict;
    try {
      verdict = await evaluate(candidate, at);
    } catch (cause) {
      // "I could not find out whether this is safe" is not "it is safe".
      result.halted = true;
      result.haltReason = `The safety gate could not be evaluated: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }
    if (!verdict.allowed) {
      result.blocked += 1;
      log(`LinkedIn acceptance check for ${candidate.targetRef} was refused: ${verdict.reason ?? 'the safety gate refused it.'}`);
      // The refusals that reach here are seat-wide almost every time -- outside
      // working hours, over the day's view ceiling, posture -- so continuing
      // would spend the pass discovering the same answer once per candidate.
      result.halted = true;
      result.haltReason = verdict.reason ?? 'The safety gate refused this acceptance check.';
      break;
    }

    const read = await driver.readProfileDegree(deps.page, candidate.targetRef);

    if (!isDegreeRead(read)) {
      const failureKind = read.failureKind ?? 'unknown';
      // `selector_drift` from `openProfile` means the NAVIGATION failed, so no
      // page was loaded and no view was registered. Every other kind is read
      // off a page that did load, and a page that loaded was viewed.
      if (failureKind !== 'selector_drift') await recordAcceptanceCheckView(db, seat, candidate, at);

      if (failureKind === 'limit_wall' || failureKind === 'challenge') {
        // LINKEDIN SAID STOP. The seat cools and the pass ends -- whatever
        // produced this needs a person, not another profile.
        await upsertSeat(db, seat.workspaceId, { posture: 'cooldown' }, at, seat.seatKey);
        result.halted = true;
        result.haltReason = read.detail ?? `LinkedIn answered the acceptance check with a ${failureKind}.`;
        break;
      }
      if (failureKind === 'selector_drift') {
        // One profile that would not open is one thing; the next nine would be
        // the same navigation failing nine more times.
        result.halted = true;
        result.haltReason = read.detail ?? 'A profile could not be opened, so the pass stopped rather than repeating it.';
        break;
      }
      // `not_found` (the profile is gone) and `unknown`. The invite's outcome is
      // still unknown and is left exactly as it was.
      result.checked += 1;
      result.unknown += 1;
      await markAcceptanceChecked(db, seat, candidate.actionId, at);
      continue;
    }

    result.checked += 1;
    await recordAcceptanceCheckView(db, seat, candidate, at);

    if (read.pending) {
      // The list read was stale, not the invite decided. The evidence is
      // refreshed so the next sweep measures staleness from today.
      result.stillPending += 1;
      await markStillPending(db, seat, candidate.actionId, at);
      continue;
    }

    if (read.degree === 1) {
      const written = await recordDetectedAcceptance(
        db,
        { workspaceId: seat.workspaceId, actionId: candidate.actionId, detectedAt: at.toISOString() },
        at
      );
      await markAcceptanceChecked(db, seat, candidate.actionId, at);
      if (written.applied) result.accepted += 1;
      else {
        result.unknown += 1;
        log(`LinkedIn acceptance for ${candidate.targetRef} was not filed: ${written.reason}`);
      }
      continue;
    }

    // Gone from the list, not 1st degree or the badge did not read. DECLINED,
    // EXPIRED, WITHDRAWN BY HAND AND A BADGE WE COULD NOT PARSE ARE ALL IN
    // HERE, and the ledger says the one thing that is true of all four: we do
    // not know. Rule 2.
    result.unknown += 1;
    await markAcceptanceChecked(db, seat, candidate.actionId, at);
    if (read.degraded.length > 0) log(`LinkedIn acceptance check for ${candidate.targetRef}: ${read.degraded.join(' ')}`);
  }

  return result;
}
