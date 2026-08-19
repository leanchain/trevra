import { id, type Db } from '../db.js';
import { renderPostBody } from '../../shared/linkedin-post-format.js';
import { ownerSeat, type SeatRef } from './actions.js';
import {
  isSeatRead,
  type LinkedInDegreeDriver,
  type LinkedInDriver,
  type LinkedInPage
} from './driver.js';
// `readThread` names two different things in this subsystem: the browser
// routine that opens a conversation in Chrome, and the database read that
// returns the one Trevra has stored. Both are the right word in their own file,
// so neither is renamed -- the driver's is aliased HERE, at the one place both
// are in scope, and nowhere else has to care.
import {
  isThreadListing,
  isThreadTranscript,
  playwrightInboxDriver,
  readThread as readThreadFromLinkedIn,
  type LinkedInInboxDriver
} from './driver-inbox.js';
import {
  playwrightScrapeDriver,
  type LinkedInScrapeDriver,
  type LinkedInScrapePage
} from './driver-scrape.js';
import {
  isPendingInviteList,
  playwrightWithdrawDriver,
  type LinkedInListPage,
  type LinkedInWithdrawDriver
} from './driver-withdraw.js';
import { clearInboxForSeat, syncThreadMessages, syncThreads, threadByUrn } from './inbox.js';
import {
  leadSourcingConfig,
  leadSourcingEnabled,
  runPendingLeadSources,
  type LeadSourceRunResult
} from './leads.js';
import {
  openLinkedInSession,
  stopLinkedInBatches,
  warmUpSession,
  type LinkedInLocalWorkerConfig
} from './local-worker.js';
import {
  claimNextDuePost,
  markPostFailed,
  markPostMissed,
  markPostPublished,
  releasePostToScheduled,
  sweepStalePublishing
} from './posts.js';
import { runManagedCampaigns, type RunnerResult } from './runner.js';
import type { DayShapeFn } from './pacing.js';
import { encodeBackgroundRunDetail, recordSeatEvent, seatRestingUntil } from './seat-events.js';
import { OWNER_SEAT_KEY, effectivePosture, getSeat } from './seats.js';
import {
  AVAILABILITY_CATCHUP_MARKER,
  MAX_CATCHUP_TASKS_PER_VISIT,
  SIDE_TASKS_NEEDING_IDENTITY,
  VISIT_MARKER,
  availabilityCatchUpPending,
  dueSideTasks,
  markSideTaskRun,
  sideTaskRuns,
  visitAt,
  type SideTaskName
} from './side-tasks.js';
import {
  DEFAULT_CANDIDATE_LIMIT,
  detectAcceptedInvites,
  runWithdrawalBatch,
  sweepStaleInvites,
  syncPendingInvites,
  type AcceptanceDetectionResult,
  type WithdrawalBatchResult,
  type WithdrawalCandidate,
  type WithdrawalCandidateOptions
} from './withdraw.js';

/**
 * The four browser jobs that are not the invite queue.
 *
 * `local-worker.ts` owns ONE loop: claim a due `linkedin_actions` row, gate it,
 * execute it. Modules 030-034 added four more pieces of browser work that do
 * not fit that shape -- walking the inbox, reading the sent-invitations list,
 * draining the withdrawal queue, harvesting a lead source -- and each of them
 * arrived as a pure function that takes a page it does not know how to open.
 *
 * This file is where they get one. It exists rather than four copies of the
 * same preamble inside `app.ts` and `worker/index.ts`, and rather than a
 * thousand more lines in `local-worker.ts`, because every one of them has to
 * answer the same three questions in the same order and the third is easy to
 * get wrong: is automation on, can this process open a browser at all, and may
 * this process serve THIS seat. `openLinkedInSession` answers all three; every
 * function here starts by calling it.
 *
 * THREE RULES, inherited rather than restated:
 *
 * 1. NOTHING HERE BYPASSES A GATE. The withdrawal pass runs
 *    `evaluateWithdrawalSafety`, which runs `evaluateLinkedInSafety` whole; the
 *    lead walk checks the seat's posture; the inbox sync sends nothing at all.
 *    Not one function in this file writes a `linkedin_actions` status directly.
 * 2. NOTHING HERE THROWS FOR A LINKEDIN PROBLEM. Every refusal is a result with
 *    a sentence in it, because half these callers are worker ticks and the
 *    other half are HTTP handlers, and neither may 500 because LinkedIn wants a
 *    captcha.
 * 3. NO `Math.random()`. Every pause below is drawn from a seeded generator in
 *    the driver that owns it, seeded from ids that are already in the database.
 */

function seatOf(workspaceId: string, seatKey?: string): SeatRef {
  return seatKey ? { workspaceId, seatKey } : ownerSeat(workspaceId);
}

/** Two spellings of one profile URL. A trailing slash and a capital letter are not two people. */
function sameAccount(left: string, right: string): boolean {
  const canon = (value: string) => value.trim().toLowerCase().replace(/\/+$/, '');
  return canon(left) === canon(right);
}

/**
 * WHOSE INBOX THIS BROWSER IS SIGNED IN TO, asked BEFORE one conversation is
 * filed against this seat.
 *
 * THE HOLE THIS CLOSES, in the order it actually happened. `linkedin_threads`
 * and `linkedin_messages` are a read cache keyed by (workspace, seat) and by
 * nothing else -- no column records WHICH LinkedIn account produced a row. The
 * sync opened whatever session the seat's browser profile happened to hold,
 * read that person's rail, and filed it under the seat. `detectLinkedInSeat`
 * is the only place that ever compared identities, it only fires when a
 * profile URL was ALREADY confirmed, and it is not part of a sync -- so a
 * workspace that synced before its first detect kept a stranger's
 * conversations forever, under the name of the account it later connected.
 * That is exactly what a real workspace ended up holding on 2026-08-13: nine
 * conversations read from one account, sitting under a seat confirmed as
 * another.
 *
 * COSTS ONE NAVIGATION PER SYNC RUN, not per conversation, and the walk that
 * follows already pays one per thread. Reading somebody else's DMs into an
 * operator's inbox is not a price worth saving it for.
 *
 * IT USED TO COST TWO, AND THE SECOND ONE WAS THE EXPENSIVE ONE. `readSeat`
 * defaults to also loading `/mynetwork/invite-connect/connections/` for the
 * exact connection count -- a surface LinkedIn associates with prospecting --
 * and this function reads nothing from it. It only ever wanted `profileUrl`.
 * Called on every side-task tick, that was thousands of connections-page loads
 * a day for a number nobody here looks at.
 *
 * A MISMATCH CLEARS THIS SEAT'S CACHE AND READS NOTHING, which is the same
 * decision `detectLinkedInSeat` makes and for the same reason: what is stored
 * belongs to the account that is no longer signed in, and leaving it in place
 * shows one human's private messages to another. The ledger is never touched.
 *
 * Returns a sentence to block the run with, or null when the seat and the
 * session are the same person.
 */
async function confirmSeatAccount(
  db: Db,
  session: { page: LinkedInPage; driver: LinkedInDriver },
  workspaceId: string,
  seatKey: string
): Promise<string | null> {
  const seat = await getSeat(db, workspaceId, seatKey);
  const confirmed = seat?.profileUrl ?? null;
  if (!confirmed) {
    return "This workspace has never confirmed which LinkedIn account this seat is, so nothing was read -- an unconfirmed seat is exactly how one account's conversations end up stored as another's. Connect the account first; detecting it is what records who it is.";
  }

  const read = await session.driver.readSeat(session.page, { skipConnections: true });
  if (!isSeatRead(read)) {
    return `Which LinkedIn account this browser is signed in as could not be confirmed (${read.failureKind ?? 'unknown'}: ${read.detail ?? 'no detail'}), so nothing was read. Conversations are only stored against an account we just verified.`;
  }

  if (sameAccount(read.profileUrl, confirmed)) return null;

  const cleared = await clearInboxForSeat(db, workspaceId, seatKey);
  return (
    `This browser is signed in as ${read.profileUrl}, and this seat is ${confirmed}. Nothing was read. ` +
    `${cleared} stored conversation${cleared === 1 ? '' : 's'} belonging to the account that is no longer signed in ` +
    `${cleared === 1 ? 'was' : 'were'} cleared, because they are not this seat's to show. ` +
    `Sign this browser back into ${confirmed}, or re-connect the seat to keep the account that is signed in now.`
  );
}

export interface LinkedInJobOptions {
  workspaceId: string;
  seatKey?: string;
  now?: Date;
  /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
  page?: LinkedInPage;
  driver?: LinkedInDriver;
  log?: (message: string) => void;
  /**
   * The caller has ALREADY confirmed, on this page, in this pass, that the
   * signed-in account is this seat's. Set only by `runLinkedInSideTasks`.
   *
   * NOT A WAY TO SKIP THE CHECK -- a way to not repeat it. Every job below
   * that files another member's data confirms the identity first, and each one
   * used to do it independently: two jobs in one tick meant two `/in/me/`
   * loads to answer a question whose answer cannot change between them,
   * because it is the same browser on the same page seconds apart. An HTTP
   * route never sets this, so a hand-triggered sync still asks.
   */
  accountConfirmed?: boolean;
}

/* ---------------------------------------------------------------------------
 * The inbox
 * ------------------------------------------------------------------------ */

export interface InboxSyncResult {
  /** Null when the walk ran. A sentence the operator can act on when it did not. */
  blocked: string | null;
  threads: number;
  created: number;
  updated: number;
  /** Conversations whose campaign pointer was resolved from the ledger this run. */
  linked: number;
  /** Messages newly stored across every conversation read. */
  messages: number;
  /** Newly stored INBOUND messages -- the ones that can mark an action replied. */
  inbound: number;
  /** One per conversation whose reply landed on a ledger row, in the ingest's own words. */
  linkage: string[];
  /** What could not be read. Never a reason to fail the run. */
  degraded: string[];
}

/**
 * Walk the conversation rail, then read the conversations it found.
 *
 * TWO PASSES AND THE SECOND ONE IS THE POINT. The rail gives a snippet and an
 * unread badge; only opening a conversation produces the inbound MESSAGE that
 * `syncThreadMessages` reports through `ingestOutcome` as a reply. A sync that
 * stopped at the list would leave the funnel exactly as fictional as it was
 * before -- 40 invites sent, unknown replies.
 *
 * `needsProfileUrl` is answered from what is already stored, which is what
 * keeps the walk affordable: resolving a participant's profile costs one extra
 * navigation per conversation, and a thread whose URL was resolved last week
 * does not need it again.
 *
 * BOUNDED. `maxThreads` caps the run whatever the inbox holds, and the driver
 * caps it again at 50. A full inbox walk at the driver's own seeded 2-7s gaps
 * is minutes of real time, so this is deliberately not "read everything".
 */
export async function syncLinkedInInbox(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & {
    maxThreads?: number;
    maxMessages?: number;
    inboxDriver?: LinkedInInboxDriver;
  }
): Promise<InboxSyncResult> {
  const now = options.now ?? new Date();
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  const empty: InboxSyncResult = {
    blocked: null,
    threads: 0,
    created: 0,
    updated: 0,
    linked: 0,
    messages: 0,
    inbound: 0,
    linkage: [],
    degraded: []
  };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok) return { ...empty, blocked: session.blocked };

  // Whose inbox this is, before a word of it is stored. See `confirmSeatAccount`.
  const wrongAccount = options.accountConfirmed
    ? null
    : await confirmSeatAccount(db, session, options.workspaceId, seatKey);
  if (wrongAccount) return { ...empty, blocked: wrongAccount };

  const inbox = options.inboxDriver ?? playwrightInboxDriver;
  const seed = `inbox:${options.workspaceId}:${now.toISOString().slice(0, 13)}`;

  const listing = await inbox.listConversations(session.page, {
    ...(options.maxThreads === undefined ? {} : { maxThreads: options.maxThreads }),
    seed,
    now: () => now,
    // One query per conversation, and it is the cheap one: the alternative is
    // one NAVIGATION per conversation for URLs we already hold.
    needsProfileUrl: () => true
  });
  if (!isThreadListing(listing)) {
    return {
      ...empty,
      blocked: `${listing.failureKind ?? 'unknown'}: ${listing.detail ?? 'The inbox walk stopped early and said nothing about why.'}`
    };
  }

  const synced = await syncThreads(
    db,
    { workspaceId: options.workspaceId, seatKey, threads: listing.threads },
    now
  );
  const result: InboxSyncResult = {
    ...empty,
    threads: synced.threads.length,
    created: synced.created,
    updated: synced.updated,
    linked: synced.linked,
    degraded: [...listing.degraded]
  };

  for (const thread of synced.threads) {
    const transcript = await readThreadFromLinkedIn(session.page, thread.threadUrn, {
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
      seed: `${seed}:${thread.threadUrn}`,
      now: () => now
    });
    if (!isThreadTranscript(transcript)) {
      // ONE CONVERSATION'S FAILURE IS ONE CONVERSATION'S FAILURE. A thread that
      // would not open is reported and the walk continues: the rest of the
      // inbox is still readable, and stopping would throw away the replies
      // already stored above.
      result.degraded.push(
        `Conversation ${thread.threadUrn} could not be read (${transcript.failureKind ?? 'unknown'}): ${transcript.detail ?? 'no detail'}`
      );
      continue;
    }
    result.degraded.push(...transcript.degraded);

    const stored = await syncThreadMessages(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        threadUrn: thread.threadUrn,
        messages: transcript.messages
      },
      now
    );
    result.messages += stored.inserted;
    result.inbound += stored.inbound;
    if (stored.inbound > 0) result.linkage.push(stored.linkage);
  }

  return result;
}

/** One conversation, re-read from LinkedIn and re-filed. The screen's "refresh this thread". */
export async function syncLinkedInThread(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  threadUrn: string,
  options: LinkedInJobOptions & { maxMessages?: number }
): Promise<{
  blocked: string | null;
  inserted: number;
  inbound: number;
  linkage: string | null;
  degraded: string[];
}> {
  const now = options.now ?? new Date();
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;

  // Refuses a conversation this workspace has never synced, rather than
  // navigating to an id somebody typed. `syncThreadMessages` would refuse it
  // too; asking here means the answer is a 404 and not a browser session.
  //
  // PER SEAT, AND THE ARGUMENT IS LOAD-BEARING -- exactly the case
  // `enqueueReply` carries its own paragraph about. `threadByUrn` defaults its
  // last parameter to the owner seat, and omitting it here meant a refresh
  // requested for a SECONDARY account looked the URN up in the OWNER's inbox:
  // a thread that belongs to this seat was reported as unknown, and a thread
  // that belongs to the owner was accepted and then handed to
  // `syncThreadMessages` WITH `seatKey` -- which resolves the other seat's
  // conversation, or refuses. The seat key is already computed on the line
  // above and was simply not passed.
  const known = await threadByUrn(db, options.workspaceId, threadUrn, seatKey);
  if (!known) return { blocked: null, inserted: 0, inbound: 0, linkage: null, degraded: [] };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok)
    return { blocked: session.blocked, inserted: 0, inbound: 0, linkage: null, degraded: [] };

  // Same check as the full walk: a refresh is a read of one conversation, and
  // a conversation read from the wrong account is the same defect one thread
  // at a time.
  const wrongAccount = await confirmSeatAccount(db, session, options.workspaceId, seatKey);
  if (wrongAccount)
    return { blocked: wrongAccount, inserted: 0, inbound: 0, linkage: null, degraded: [] };

  const transcript = await readThreadFromLinkedIn(session.page, threadUrn, {
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    seed: `thread:${threadUrn}`,
    now: () => now
  });
  if (!isThreadTranscript(transcript)) {
    return {
      blocked: `${transcript.failureKind ?? 'unknown'}: ${transcript.detail ?? 'That conversation could not be read.'}`,
      inserted: 0,
      inbound: 0,
      linkage: null,
      degraded: []
    };
  }

  const stored = await syncThreadMessages(
    db,
    { workspaceId: options.workspaceId, seatKey, threadUrn, messages: transcript.messages },
    now
  );
  return {
    blocked: null,
    inserted: stored.inserted,
    inbound: stored.inbound,
    linkage: stored.linkage,
    degraded: transcript.degraded
  };
}

/* ---------------------------------------------------------------------------
 * Pending invites and withdrawal
 * ------------------------------------------------------------------------ */

export interface PendingSyncJobResult {
  blocked: string | null;
  listed: number;
  matched: number;
  unmatched: number;
  disappeared: number;
  truncated: boolean;
  degraded: string[];
}

/**
 * Re-read LinkedIn's own sent-invitations list and file what it said.
 *
 * WRITES EVIDENCE, NEVER A CONCLUSION. `syncPendingInvites` records that
 * LinkedIn still showed an invite (`pending_seen_at`) and LinkedIn's own
 * account of when it was sent (`pending_since`), and concludes NOTHING from an
 * invite's absence: accepted, declined, expired and withdrawn all look
 * identical from that list, and the acceptance-rate throttle reads the
 * difference. Guessing between them would feed that throttle fiction.
 *
 * The page type is widened at this seam. `driver.ts` declares the minimum
 * Playwright slice the invite routines need; the invitation-manager list needs
 * `nth`, a scoped `locator` and `getAttribute` on top of it. Playwright's real
 * `Page` satisfies both, and the cast is the one place that fact is asserted
 * rather than assumed everywhere.
 */
export async function syncLinkedInPendingInvites(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & { maxInvites?: number; withdrawDriver?: LinkedInWithdrawDriver }
): Promise<PendingSyncJobResult> {
  const now = options.now ?? new Date();
  const seat = seatOf(options.workspaceId, options.seatKey);
  const empty: PendingSyncJobResult = {
    blocked: null,
    listed: 0,
    matched: 0,
    unmatched: 0,
    disappeared: 0,
    truncated: false,
    degraded: []
  };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok) return { ...empty, blocked: session.blocked };

  const withdrawDriver = options.withdrawDriver ?? playwrightWithdrawDriver;
  const listed = await withdrawDriver.listPendingInvites(
    session.page as unknown as LinkedInListPage,
    {
      ...(options.maxInvites === undefined ? {} : { maxInvites: options.maxInvites }),
      seed: `pending:${options.workspaceId}`,
      now
    }
  );
  if (!isPendingInviteList(listed)) {
    return {
      ...empty,
      blocked: `${listed.failureKind ?? 'unknown'}: ${listed.detail ?? 'The sent-invitations list could not be read.'}`
    };
  }

  const synced = await syncPendingInvites(db, seat, listed, now);
  return { ...synced, blocked: null, degraded: listed.degraded };
}

export interface AcceptanceDetectionJobResult extends AcceptanceDetectionResult {
  /** Why no browser work happened, or null when it did. Same distinction as `WithdrawalJobResult`. */
  blockedReason: string | null;
}

/**
 * Find out which of this seat's vanished invites were actually accepted.

 * WHY THE ACCOUNT CHECK IS NOT OPTIONAL HERE, and is in fact more load-bearing
 * than it is for the inbox sync. A connection degree is not a property of a
 * profile; it is a property of the RELATIONSHIP between that profile and
 * WHOEVER IS SIGNED IN. Reading "1st" out of a browser logged into a different
 * account than the seat this invite belongs to would file that other person's
 * connection as this seat's acceptance -- a wrong number in the one place a
 * wrong number changes what the pacing engine does next. So the session's own
 * identity is confirmed before a single profile is opened, exactly as
 * `syncLinkedInInbox` confirms it before a single conversation is read.
 *
 * Everything else -- the gate, the pacing, the posture, the ledger row for the
 * page view -- belongs to `detectAcceptedInvites` and is not restated here.
 * This function's whole job is the browser and the seat.
 */
export async function detectLinkedInAcceptances(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & {
    maxChecks?: number;
    degreeDriver?: LinkedInDegreeDriver;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<AcceptanceDetectionJobResult> {
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  const seat = seatOf(options.workspaceId, seatKey);
  const empty: AcceptanceDetectionJobResult = {
    workspaceId: seat.workspaceId,
    seatKey: seat.seatKey,
    checked: 0,
    accepted: 0,
    stillPending: 0,
    unknown: 0,
    blocked: 0,
    halted: false,
    haltReason: null,
    blockedReason: null
  };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok)
    return { ...empty, halted: true, haltReason: session.blocked, blockedReason: session.blocked };

  const wrongAccount = options.accountConfirmed
    ? null
    : await confirmSeatAccount(db, session, options.workspaceId, seatKey);
  if (wrongAccount)
    return { ...empty, halted: true, haltReason: wrongAccount, blockedReason: wrongAccount };

  const outcome = await detectAcceptedInvites(db, seat, {
    page: session.page,
    now: () => options.now ?? new Date(),
    ...(options.degreeDriver === undefined ? {} : { driver: options.degreeDriver }),
    ...(options.maxChecks === undefined ? {} : { maxChecks: options.maxChecks }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.log === undefined ? {} : { log: options.log })
  });
  return { ...outcome, blockedReason: null };
}

export interface WithdrawalJobResult extends WithdrawalBatchResult {
  /**
   * Why no browser work happened, or null when it did.
   *
   * NOT `blocked`, which `WithdrawalBatchResult` already uses for a COUNT of
   * withdrawals the safety gate refused. Two different facts -- "this process
   * could not open a browser" and "three of these were over the seat's ceiling"
   * -- and giving them one name is how a screen ends up reporting one as the
   * other.
   */
  blockedReason: string | null;
  /** Invites the sweep found stale enough to withdraw on this pass. */
  candidates: number;
  queued: number;
  duplicates: number;
}

/**
 * How many managed pending invites one staleness scan will read.
 *
 * Twenty times `DEFAULT_CANDIDATE_LIMIT`, because the scan feeds a pass that
 * queues at most that many withdrawals and the extra headroom is what keeps
 * the EXCLUSION half of the sweep honest: everything this list names is
 * withheld from the account-default sweep so it is not withdrawn a week early,
 * and a bound far above the budget means the invites the pass could actually
 * reach are all inside it. See {@link managedInviteStaleness} for why ordering
 * by the sweep's own clock is what makes truncation safe rather than merely
 * unlikely.
 */
const MANAGED_STALENESS_SCAN_LIMIT = DEFAULT_CANDIDATE_LIMIT * 20;

/**
 * The staleness a managed workflow declared for one seat's invites.
 *
 * Every pending invite this seat holds that belongs to a campaign member whose
 * workflow has a `withdraw_pending` step, paired with that step's own
 * `afterDays`. Read from `linkedin_workflows.steps_json` -- the LIVE workflow,
 * the same one `runner.ts` reads when it ticks the step, rather than the
 * snapshot in `linkedin_campaigns.sequence_json`, so editing a workflow changes
 * the sweep exactly as it changes the runner.
 * ONE STATEMENT RATHER THAN A LOOP OVER CAMPAIGNS: a seat can carry a dozen
 * campaigns and a lead list can carry thousands of members, and the answer is
 * one join away.
 *
 * The first `withdraw_pending` step wins when a workflow has several. That is a
 * choice and the conservative one is not available: a workflow with two
 * withdraw steps has two answers and no way to say which invite belongs to
 * which, and the FIRST one is the earliest deadline the operator wrote down.
 *
 * THE `jsonb_array_elements` LATERAL RUNS ONCE PER WORKFLOW, NOT ONCE PER
 * INVITE. It used to sit in the SELECT list of the invite query, so a seat
 * with 5,000 pending invites across three campaigns unpacked and scanned the
 * same three `steps_json` documents 5,000 times. Lifting it into its own CTE
 * over `linkedin_workflows` asks the question once per workflow and joins the
 * answer on, and moving the null test into the WHERE clause means the
 * workflows that said nothing about staleness are dropped by Postgres rather
 * than by a JS loop over rows that were shipped anyway.
 *
 * AND IT IS BOUNDED, WHICH IT WAS NOT. The whole pending backlog came back --
 * every row, no limit -- for a caller whose budget is at most
 * `DEFAULT_CANDIDATE_LIMIT` (100) invites per pass. The bound is
 * {@link MANAGED_STALENESS_SCAN_LIMIT} and the ORDER BY is what makes
 * truncating it safe: the sweep withdraws OLDEST FIRST, and the second half of
 * the sweep excludes these invites so they are not swept at the account
 * default instead of at the workflow's own number. Ordering by the same clock
 * the sweep selects on -- COALESCE(pending_since, recorded_at) -- means the
 * invites that could actually be reached by this pass are exactly the ones at
 * the head of the list, so a truncated tail is a tail this pass was never
 * going to touch. A seat holding more than the bound in managed pending
 * invites still sweeps correctly; it simply learns about the oldest 2,000 of
 * them per pass.
 */
async function managedInviteStaleness(
  db: Db,
  seat: SeatRef
): Promise<Array<{ actionId: string; afterDays: number }>> {
  const rows = await db
    .prepare(
      `
    WITH workflow_staleness AS (
      SELECT w.id AS workflow_id, (
        SELECT (step->'config'->>'afterDays')::int
        FROM jsonb_array_elements(w.steps_json) AS step
        WHERE step->>'action' = 'withdraw_pending'
        LIMIT 1
      ) AS after_days
      FROM linkedin_workflows w
      WHERE w.workspace_id=?
    )
    SELECT a.id AS action_id, s.after_days
    FROM linkedin_actions a
    JOIN linkedin_campaign_members m ON m.id = a.campaign_member_id AND m.workspace_id = a.workspace_id
    JOIN linkedin_campaigns c ON c.id = m.campaign_id AND c.workspace_id = m.workspace_id
    JOIN workflow_staleness s ON s.workflow_id = c.workflow_id
    WHERE a.workspace_id=? AND a.seat_key=? AND a.kind='invite'
      AND a.status IN ('sent', 'exported')
      AND a.campaign_member_id IS NOT NULL
      AND s.after_days IS NOT NULL AND s.after_days > 0
    ORDER BY COALESCE(a.pending_since, a.recorded_at) ASC NULLS LAST, a.id ASC
    LIMIT ?
  `
    )
    .all<{ action_id: string; after_days: number | null }>(
      seat.workspaceId,
      seat.workspaceId,
      seat.seatKey,
      MANAGED_STALENESS_SCAN_LIMIT
    );

  const out: Array<{ actionId: string; afterDays: number }> = [];
  for (const row of rows) {
    // A workflow with no withdraw step said nothing about staleness, so its
    // invites fall through to the account default with everything else. The
    // predicate above already dropped those; this is the belt on the braces,
    // because `afterDays` arrives from operator-supplied JSON.
    if (row.after_days === null) continue;
    const afterDays = Number(row.after_days);
    if (!Number.isFinite(afterDays) || afterDays <= 0) continue;
    out.push({ actionId: row.action_id, afterDays });
  }
  return out;
}

/**
 * The sweep, run once per staleness rule instead of once on the account default.
 *
 * THE DEFAULT WAS OVERRULING THE OPERATOR. `DEFAULT_STALE_AFTER_DAYS` is 21,
 * and the unattended pass supplied no `olderThanDays` at all, so every pending
 * invite in the workspace was withdrawn at 21 days -- including the ones
 * belonging to a campaign whose workflow says, in a field the operator typed a
 * number into, to wait 30. The workflow's `withdraw_pending` step was honoured
 * only on the runner's own path (`handleWithdrawStep`), and this pass quietly
 * withdrew the invite a week early behind it.
 *
 * So the invites are partitioned. Each declared `afterDays` sweeps its own
 * invites at its own age; everything else -- a one-off export, a hand-sent
 * invite, a campaign whose workflow has no withdraw step -- sweeps at the
 * caller's number or the account default, and is the only thing that does.
 *
 * A CALLER'S EXPLICIT `olderThanDays` DOES NOT REACH THE MANAGED ONES, and that
 * is deliberate rather than an oversight. "Withdraw everything older than seven
 * days" is a statement about the backlog; "wait thirty days before withdrawing
 * on this campaign" is a statement about a specific campaign, made in that
 * campaign's own workflow, and the narrower statement wins. The direction it
 * errs in is leaving an invite pending longer, never withdrawing one sooner
 * than somebody asked.
 *
 * `limit` is a budget across the WHOLE sweep, not per partition, so splitting
 * the query cannot multiply how much one pass queues.
 */
async function sweepStaleInvitesRespectingWorkflows(
  db: Db,
  seat: SeatRef,
  now: Date,
  options: WithdrawalCandidateOptions = {}
): Promise<{ candidates: WithdrawalCandidate[]; queued: number; duplicates: number }> {
  const managed = await managedInviteStaleness(db, seat);

  const byAfterDays = new Map<number, string[]>();
  for (const entry of managed) {
    const bucket = byAfterDays.get(entry.afterDays);
    if (bucket) bucket.push(entry.actionId);
    else byAfterDays.set(entry.afterDays, [entry.actionId]);
  }

  const candidates: WithdrawalCandidate[] = [];
  let queued = 0;
  let duplicates = 0;
  let budget = Math.max(1, Math.trunc(options.limit ?? DEFAULT_CANDIDATE_LIMIT));

  // Ascending, so the oldest deadline gets first call on the budget when a pass
  // cannot queue everything it found.
  for (const afterDays of [...byAfterDays.keys()].sort((left, right) => left - right)) {
    if (budget <= 0) break;
    const swept = await sweepStaleInvites(db, seat, now, {
      olderThanDays: afterDays,
      actionIds: byAfterDays.get(afterDays) as string[],
      limit: budget
    });
    candidates.push(...swept.candidates);
    queued += swept.queued;
    duplicates += swept.duplicates;
    budget -= swept.candidates.length;
  }

  if (budget > 0) {
    const swept = await sweepStaleInvites(db, seat, now, {
      ...(options.olderThanDays === undefined ? {} : { olderThanDays: options.olderThanDays }),
      ...(managed.length === 0 ? {} : { excludeActionIds: managed.map((entry) => entry.actionId) }),
      limit: budget
    });
    candidates.push(...swept.candidates);
    queued += swept.queued;
    duplicates += swept.duplicates;
  }

  return { candidates, queued, duplicates };
}

/**
 * Sweep stale invites into the queue, then drain the queue at paced gaps.
 *
 * THE SWEEP AND THE DRAIN ARE ONE CALL AND TWO DECISIONS. Queueing is pure
 * database work and reversible; withdrawing clicks a button in a real account
 * and is not. They stay separate functions in `withdraw.ts` precisely so a
 * route can show an operator what WOULD be withdrawn without withdrawing it,
 * and this composes them for the unattended path.
 *
 * The pass borrows the invite worker's `linkedin_batches` row, so
 * `stopLinkedInBatches` -- the kill switch the API already has -- reaches a
 * withdrawal pass too. A queue that could not be stopped by the button that
 * stops everything else would be the one automated loop with no brake.
 */
export async function runLinkedInWithdrawals(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & {
    withdrawDriver?: LinkedInWithdrawDriver;
    maxActions?: number;
    sleep?: (ms: number) => Promise<void>;
  } & WithdrawalCandidateOptions
): Promise<WithdrawalJobResult> {
  const now = options.now ?? new Date();
  const seat = seatOf(options.workspaceId, options.seatKey);
  const log = options.log ?? (() => {});

  const swept = await sweepStaleInvitesRespectingWorkflows(db, seat, now, {
    ...(options.olderThanDays === undefined ? {} : { olderThanDays: options.olderThanDays }),
    ...(options.limit === undefined ? {} : { limit: options.limit })
  });

  // The sweep already ran and its numbers are real whether or not a browser
  // opens: those rows are queued, and the next pass drains them.
  const sweepCounts = {
    candidates: swept.candidates.length,
    queued: swept.queued,
    duplicates: swept.duplicates
  };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok) {
    return {
      workspaceId: seat.workspaceId,
      seatKey: seat.seatKey,
      batchId: '',
      withdrawn: 0,
      stale: 0,
      blocked: 0,
      failed: 0,
      halted: true,
      haltReason: session.blocked,
      blockedReason: session.blocked,
      ...sweepCounts
    };
  }

  const withdrawDriver = options.withdrawDriver ?? playwrightWithdrawDriver;
  // UNIQUE PER PASS, NOT PER MILLISECOND. This was
  // `lwbatch_${now.getTime().toString(36)}`, which is a function of the clock
  // and nothing else: two workspaces -- or two seats in one workspace --
  // sweeping in the same millisecond were handed the SAME
  // `linkedin_withdrawals.batch_id`, so reading a pass back to the withdrawals
  // it performed returned another tenant's as well, and `stopLinkedInBatches`
  // aimed at one of them would have named both. A random id is the same shape
  // every other identifier in this schema uses and cannot collide by timing.
  const batchId = id('lwbatch');

  const outcome = await runWithdrawalBatch(db, seat, {
    driver: withdrawDriver,
    page: session.page as unknown as LinkedInListPage,
    batchId,
    now: () => new Date(),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.maxActions === undefined ? {} : { maxActions: options.maxActions }),
    log
  });

  return { ...outcome, blockedReason: null, ...sweepCounts };
}

/* ---------------------------------------------------------------------------
 * Lead sourcing
 * ------------------------------------------------------------------------ */

/**
 * Walk this workspace's pending lead sources.
 *
 * TWO GATES, AND THEY ARE DIFFERENT SWITCHES. `config.enabled` is the local
 * worker's; `leadSourcingEnabled` is lead sourcing's own opt-in, which is OFF
 * by default where the worker is ON by default -- because harvesting other
 * people's profiles is a decision with a different name on it, and a
 * self-hoster who upgraded must not acquire a crawler they never asked for.
 * `runPendingLeadSources` re-checks its own gate; asking here means nothing
 * opens a browser for a feature that is off.
 */
export async function runLinkedInLeadSources(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & {
    maxSources?: number;
    scraper?: LinkedInScrapeDriver;
    env?: NodeJS.ProcessEnv;
  }
): Promise<{ blocked: string | null; results: LeadSourceRunResult[] }> {
  const leadConfig = leadSourcingConfig(options.env ?? process.env);
  if (!leadSourcingEnabled(leadConfig)) return { blocked: null, results: [] };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok) return { blocked: session.blocked, results: [] };

  const results = await runPendingLeadSources(
    db,
    options.workspaceId,
    {
      page: session.page as unknown as LinkedInScrapePage,
      config: leadConfig,
      // Whose session this page is signed into, so the posture that may refuse
      // a page fetch is that account's and not the owner seat's by default.
      seatKey: options.seatKey ?? OWNER_SEAT_KEY,
      ...(options.scraper === undefined ? {} : { scraper: options.scraper }),
      now: () => options.now ?? new Date(),
      ...(options.log === undefined ? {} : { log: options.log })
    },
    // ONE SOURCE PER VISIT ON THE UNATTENDED PATH. The default is 3, which is
    // right for an operator who clicked "find leads" and is watching; a visit
    // is two to five minutes and already reads one to three pages of the
    // source it picks. Three sources deep would put nine search-page loads in
    // a window a person spends checking their messages.
    { maxSources: options.maxSources ?? 1 }
  );
  return { blocked: null, results };
}

/* ---------------------------------------------------------------------------
 * The tick
 * ------------------------------------------------------------------------ */

export interface LinkedInSideTaskResult {
  workspaceId: string;
  inbox: InboxSyncResult | null;
  pendingInvites: PendingSyncJobResult | null;
  acceptance: AcceptanceDetectionJobResult | null;
  withdrawals: WithdrawalJobResult | null;
  leads: LeadSourceRunResult[];
  /**
   * Which of the five were ATTEMPTED this pass -- a job that ran and failed is
   * listed, because it went to LinkedIn and that is what this field is for.
   *
   * Empty is the NORMAL outcome: on a 60s tick with intervals measured in tens
   * of minutes to hours, the overwhelming majority of passes do nothing, and
   * that is the fix rather than a fault.
   */
  ran: SideTaskName[];
  /** Why this pass opened no browser, or null when it did. One sentence. */
  skipped: string | null;
}

/**
 * Every browser job except the invite queue, for one workspace, once.
 *
 * ORDERED, AND THE ORDER IS AN ARGUMENT. The inbox first, because it is the
 * only one that REPORTS OUTCOMES: a reply detected here moves an action to
 * 'replied' through `ingestOutcome`, and every decision the other three make is
 * read from that same ledger. Running the withdrawal sweep first would have it
 * select invites as stale that this tick was about to learn had been answered
 * -- and withdrawing an accepted connection is the one destructive mistake in
 * this subsystem.
 *
 * Then the pending-invite sync, so the withdrawal sweep reads LinkedIn's own
 * account of what is still outstanding rather than last week's.
 *
 * THEN ACCEPTANCE DETECTION, AND IT SITS BETWEEN THOSE TWO AND THE WITHDRAWALS
 * FOR THE SAME REASON THE INBOX SITS FIRST. It is the second outcome reporter:
 * it turns "this invite left the pending list" into 'accepted' or into nothing,
 * by opening the target's profile and reading LinkedIn's own degree badge. It
 * must run AFTER the sync, because the sync is what tells it which invites left
 * the list; and it must run BEFORE the withdrawal sweep, because withdrawing a
 * connection that was accepted an hour ago is the one destructive mistake in
 * this subsystem, and this pass is the thing most likely to have just learned
 * that it was.
 *
 * Then the withdrawals themselves. Lead sourcing last, because it is the only
 * one that is off by default and the only one that touches nobody's account but
 * the operator's own reading history.
 *
 * NEVER THROWS. Each job is caught on its own: a workspace whose inbox will not
 * open must still get its withdrawal queue drained, and none of them may cost
 * the worker its tick.
 */
export async function runLinkedInSideTasks(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & {
    maxThreads?: number;
    maxWithdrawals?: number;
    maxSources?: number;
    /** The day-shape seam, so a test can assert the cadence without waiting for a Tuesday. */
    dayShape?: DayShapeFn;
  }
): Promise<LinkedInSideTaskResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const result: LinkedInSideTaskResult = {
    workspaceId: options.workspaceId,
    inbox: null,
    pendingInvites: null,
    acceptance: null,
    withdrawals: null,
    leads: [],
    ran: [],
    skipped: null
  };

  if (!config.enabled) return result;

  // NO SEAT ROW, OR A PAUSED ONE, AND NO BROWSER OPENS. NOT ONE.
  //
  // This runs once per row in `linkedin_seats`, every tick, and each of the
  // four jobs below opens that seat's Chrome before it reads its own posture
  // and refuses. The refusals were all correct and every one of them came too
  // late: the browser was already open, already signed in, and already talking
  // to LinkedIn from this machine's IP. On the machine this was found on that
  // meant SEVEN live Chromium processes on every tick -- six of them for
  // test-fixture workspaces that had leaked into the database and name no real
  // account at all.
  //
  // A paused seat is a seat an operator or a safety rule has switched off, and
  // "switched off" has to include the sign-in. Checking here rather than in
  // `linkedinSeatRefs` keeps that listing honest -- it still returns every seat,
  // because other callers need it to -- and puts the refusal at the one place
  // that would otherwise pay for it in an open browser.
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;
  const now = options.now ?? new Date();
  const seat = await getSeat(db, options.workspaceId, seatKey);
  if (!seat) return result;
  if (effectivePosture(seat, now) === 'paused') return result;

  // A NORMAL VISIT follows the deterministic daily rhythm. A COMPANION RETURN
  // may additionally create one consolidated state catch-up after the laptop
  // or the signed-in Trevra tab was genuinely absent long enough for its lease
  // to expire. That catch-up is one visit NOW -- never replay of every visit
  // the machine slept through.
  const runs = await sideTaskRuns(db, options.workspaceId, seatKey);
  const returnedAt = config.companionBrowser ? availabilityCatchUpPending(runs) : null;
  const verdict = visitAt(
    seat,
    now,
    options.dayShape === undefined ? {} : { dayShape: options.dayShape }
  );
  const normalVisit = Boolean(verdict.visit && verdict.startedAt);
  const catchUp = Boolean(returnedAt);
  if (!normalVisit && !catchUp) return { ...result, skipped: verdict.reason };
  const startedAt = normalVisit ? verdict.startedAt! : now;
  const visitIndex = normalVisit ? verdict.visit!.index : -1;

  // MID-SITTING-BREAK. A reconnect does not outrank a break set by a sitting
  // that just used the account. The availability marker remains pending and is
  // consumed later, so nothing is lost and the browser is not reopened early.
  const resting = await seatRestingUntil(db, options.workspaceId, seatKey);
  if (resting && resting.getTime() > now.getTime()) {
    return {
      ...result,
      skipped: `This seat is between sittings until ${resting.toISOString()}, so nothing was read.`
    };
  }

  // ONE PASS PER NORMAL VISIT, plus at most ONE availability-return catch-up.
  // If reconnect happens inside a visit that already ran, only stale tasks can
  // be selected because every completed task has its own cadence stamp.
  const lastVisit = runs.get(VISIT_MARKER);
  if (normalVisit && !catchUp && lastVisit && lastVisit.getTime() === startedAt.getTime()) {
    return {
      ...result,
      skipped: 'This visit has already happened; the tab is open and nothing new is being loaded.'
    };
  }

  // Normal visits may do three stale maintenance jobs. A return after real
  // absence may do all five categories ONCE so an occasionally-online laptop
  // can get current without manufacturing the missed visits as a burst.
  const due = new Set(
    dueSideTasks(seat, runs, now, { limit: catchUp ? MAX_CATCHUP_TASKS_PER_VISIT : undefined })
  );
  if (due.size === 0) {
    if (catchUp)
      await markSideTaskRun(db, options.workspaceId, seatKey, AVAILABILITY_CATCHUP_MARKER, now);
    return {
      ...result,
      skipped: 'LinkedIn is open, but nothing has gone stale since the last visit.'
    };
  }

  // STAMPED BEFORE THE BROWSER OPENS, so a visit that dies half way through --
  // a challenge, a crash, a browser that will not launch -- is a visit that
  // HAPPENED. A failed catch-up is also consumed: hammering the same checkpoint
  // every minute is worse than waiting for the next normal visit or reconnect.
  if (normalVisit && (!lastVisit || lastVisit.getTime() !== startedAt.getTime())) {
    await markSideTaskRun(db, options.workspaceId, seatKey, VISIT_MARKER, startedAt);
  }
  if (catchUp)
    await markSideTaskRun(db, options.workspaceId, seatKey, AVAILABILITY_CATCHUP_MARKER, now);

  // ONE SESSION AND AT MOST ONE IDENTITY CHECK FOR THE WHOLE PASS, rather than
  // one per job. Each job called `openLinkedInSession` itself and two of them
  // confirmed the account itself, so a tick that ran all five probed the
  // session five times and loaded `/in/me/` twice -- to answer, seconds apart,
  // in the same browser, a question with one answer. The page is threaded
  // down; a job handed a page opens no browser of its own.
  const session = await openLinkedInSession(db, config, {
    ...options,
    timezone: seat.timezone,
    now
  });
  if (!session.ok) {
    await recordSeatEvent(
      db,
      {
        workspaceId: options.workspaceId,
        seatKey,
        kind: 'background_run',
        detail: encodeBackgroundRunDetail({
          startedAt: startedAt.toISOString(),
          finishedAt: now.toISOString(),
          tasks: [...due],
          status: 'blocked',
          failedTasks: [],
          reason: session.blocked
        })
      },
      now
    );
    return { ...result, skipped: session.blocked };
  }

  // A VISIT STARTS ON THE FEED, because that is where a person lands when they
  // open LinkedIn -- not on `/mynetwork/invitation-manager/sent/`. Same helper
  // the sending sittings use, so a read visit and a send visit begin the same
  // way; it also wanders to notifications or My Network about half the time.
  // Decoration, never correctness: a page that cannot navigate drops it.
  await warmUpSession(
    session.page,
    `${options.workspaceId}:${seatKey}:${catchUp ? 'return' : `visit${visitIndex}`}:${now.toISOString().slice(0, 10)}`,
    log
  );

  // AND NOT AT ALL WHEN NOTHING IN THIS PASS NEEDS IT. Only the inbox walk and
  // acceptance detection file data whose meaning depends on who is signed in;
  // a pass that is just the withdrawal sweep would otherwise buy a profile load
  // to answer a question it never asks. Hoisting the check to the pass made
  // this possible AND made it necessary -- confirming unconditionally here
  // would have given `/in/me/` to three jobs that never loaded it before.
  const needsIdentity = [...due].some((task) => SIDE_TASKS_NEEDING_IDENTITY.has(task));
  if (needsIdentity) {
    const wrongAccount = await confirmSeatAccount(db, session, options.workspaceId, seatKey);
    if (wrongAccount) {
      await recordSeatEvent(
        db,
        {
          workspaceId: options.workspaceId,
          seatKey,
          kind: 'background_run',
          detail: encodeBackgroundRunDetail({
            startedAt: startedAt.toISOString(),
            finishedAt: now.toISOString(),
            tasks: [...due],
            status: 'blocked',
            failedTasks: [],
            reason: wrongAccount
          })
        },
        now
      );
      return { ...result, skipped: wrongAccount };
    }
  }

  const shared: LinkedInJobOptions & {
    maxThreads?: number;
    maxWithdrawals?: number;
    maxSources?: number;
  } = {
    ...options,
    seatKey,
    now,
    page: session.page,
    driver: session.driver,
    // ONLY WHEN IT ACTUALLY WAS. A pass that skipped the check must not tell a
    // job the check passed -- if a future job starts filing member data, it
    // confirms for itself rather than inheriting a confirmation nobody made.
    accountConfirmed: needsIdentity
  };

  const jobs: Array<[SideTaskName, string, () => Promise<void>]> = [
    [
      'inbox',
      'inbox sync',
      async () => {
        result.inbox = await syncLinkedInInbox(db, config, shared);
      }
    ],
    [
      'pending_invites',
      'pending-invite sync',
      async () => {
        result.pendingInvites = await syncLinkedInPendingInvites(db, config, shared);
      }
    ],
    [
      'acceptance',
      'acceptance detection',
      async () => {
        result.acceptance = await detectLinkedInAcceptances(db, config, shared);
      }
    ],
    [
      'withdrawals',
      'withdrawal queue',
      async () => {
        result.withdrawals = await runLinkedInWithdrawals(db, config, {
          ...shared,
          ...(options.maxWithdrawals === undefined ? {} : { maxActions: options.maxWithdrawals })
        });
      }
    ],
    [
      'lead_sources',
      'lead sourcing',
      async () => {
        result.leads = (await runLinkedInLeadSources(db, config, shared)).results;
      }
    ]
  ];

  const failedTasks: SideTaskName[] = [];
  for (const [task, name, run] of jobs) {
    if (!due.has(task)) continue;
    result.ran.push(task);
    try {
      await run();
    } catch (cause) {
      failedTasks.push(task);
      log(
        `LinkedIn ${name} failed for ${options.workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    // STAMPED WHATEVER HAPPENED, including a failure. A job that could not read
    // the inbox does not get to retry sixty seconds later: whatever stopped it
    // -- a challenge, a limit wall, a selector that moved -- is not a thing
    // another page load in a minute will fix, and hammering it is the shape
    // that got the account looked at in the first place.
    //
    // STAMPED WITH THE PASS'S OWN CLOCK, not `new Date()`. Every other decision
    // in this function reads `now`, and a stamp from a different clock is how a
    // test with an injected date silently exercises the backwards-clock branch
    // instead of the interval it meant to assert.
    await markSideTaskRun(db, options.workspaceId, seatKey, task, now);
  }

  // THE TAB IS CLOSED AT THE END OF THE VISIT, and this is not tidiness.
  //
  // A LinkedIn page left open holds a realtime connection and keeps reporting
  // the member as present. A browser parked on `/messaging/` for twenty-two
  // hours a day, every day, with no interaction, is an account that is online
  // permanently and active for four minutes -- which is a stranger shape than
  // the polling this change removed. Navigating away ends it without fighting
  // the sending loop for the browser handle, which is why this is a `goto` and
  // not a `closeLinkedInBrowser`.
  await leaveLinkedIn(session.page, log);

  await recordSeatEvent(
    db,
    {
      workspaceId: options.workspaceId,
      seatKey,
      kind: 'background_run',
      detail: encodeBackgroundRunDetail({
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        tasks: result.ran,
        status: failedTasks.length > 0 ? 'partial' : 'completed',
        failedTasks,
        reason:
          failedTasks.length > 0
            ? `${failedTasks.length} background task(s) failed; later visits continue normally.`
            : null
      })
    },
    new Date()
  );

  // ONE LINE PER VISIT THAT DID SOMETHING, and none for the ticks that did not.
  // An operator asking "is it alive" needs a heartbeat; at 1,440 ticks a day a
  // line per tick is not a heartbeat, it is the log.
  if (result.ran.length > 0) {
    log(
      `LinkedIn ${catchUp ? 'availability catch-up' : `visit ${visitIndex + 1}`} for ${options.workspaceId}/${seatKey}: ${result.ran.join(', ')}.`
    );
  }

  return result;
}

/**
 * Leave LinkedIn at the end of a visit. Never throws, never matters.
 *
 * `about:blank` rather than closing the browser: the sending loop owns the
 * browser handle and its own sitting rhythm, and a side-task pass that closed
 * it out from under a batch would be a far worse bug than an idle tab.
 */
async function leaveLinkedIn(page: LinkedInPage, log: (message: string) => void): Promise<void> {
  const target = page as unknown as {
    goto?: (
      url: string,
      options?: { waitUntil?: 'domcontentloaded'; timeout?: number }
    ) => Promise<unknown>;
  };
  if (typeof target.goto !== 'function') return;
  try {
    await target.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (cause) {
    log(
      `LinkedIn tab could not be closed after the visit (${cause instanceof Error ? cause.message : String(cause)}). Nothing was read or sent because of it.`
    );
  }
}

/** Beyond this, a due post is stale enough that firing it late is worse than not firing it at all. */
const POST_GRACE_MS = 6 * 3_600_000;
/**
 * ONE ACTUAL PUBLISH per tick, deliberately. Typing a 3000-character post at
 * human speed takes the driver 5-9 minutes, and this loop runs SERIALLY inside
 * the same per-workspace tick as the paced invite/DM queue -- five posts back
 * to back would hold that queue for the better part of half an hour. A
 * workspace with several posts due at once drains them one tick at a time.
 *
 * It counts PUBLISH ATTEMPTS, not claims: a post marked 'missed' or a seat
 * whose session will not open costs one UPDATE and no typing at all, so
 * neither may consume the budget -- otherwise one dead seat's post would eat
 * the whole tick and starve every other seat in the workspace, which is the
 * exact bug `failedSeats`/`excludeSeatKeys` exists to prevent.
 */
const POSTS_PER_WORKSPACE_TICK = 1;

/**
 * The tick still has to end. Claims that spend no publish budget (missed,
 * held) are cheap but not free, and without this a workspace holding hundreds
 * of long-expired posts would sweep them all in one pass.
 */
const MAX_POST_CLAIMS_PER_TICK = 20;

/**
 * Publish every LinkedIn post that has come due for one workspace, up to
 * `POSTS_PER_WORKSPACE_TICK` per tick.
 *
 * Claims posts one at a time via `claimNextDuePost` -- see that function for
 * why (`FOR UPDATE SKIP LOCKED`, so two worker replicas ticking at once never
 * both grab the same row). A post more than `POST_GRACE_MS` late is marked
 * 'missed' rather than fired -- publishing hours later than scheduled is worse
 * than not publishing at all. A companion session that will not open, or that
 * turns out to be signed into the wrong account, HOLDS the post -- released
 * back to 'scheduled' for the next tick to retry -- and records that seat in
 * `failedSeats`, which `claimNextDuePost`'s `excludeSeatKeys` then keeps out
 * of every remaining claim this tick. The loop CONTINUES rather than aborting:
 * a different, healthy seat in the same workspace still has its due posts
 * reached. Only an actual publish attempt that comes back `!ok` is terminal
 * ('failed', never retried).
 *
 * Opens by sweeping posts left in 'publishing' by a worker that died between
 * the claim and the outcome -- see `sweepStalePublishing` for why that state
 * is otherwise unrecoverable.
 */
export async function runLinkedInPostTick(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions
): Promise<{ published: number; missed: number }> {
  const { workspaceId } = options;
  const now = options.now ?? new Date();
  const log = options.log ?? ((message: string) => console.log(message));
  let published = 0;
  let missed = 0;
  // A seat whose session fails must not starve every OTHER seat's due post in
  // the same workspace-scoped tick -- see claimNextDuePost's own doc comment.
  // `runLinkedInSideTasks` solves the identical problem by ticking per seat;
  // this function claims across a whole workspace, so it tracks failures
  // in-loop instead. Once a seat is in this set, its remaining due posts are
  // left `scheduled` for the next tick rather than reclaimed and failed again
  // this same pass.
  const failedSeats = new Set<string>();

  await sweepStalePublishing(db, workspaceId, now);

  let attempted = 0;
  for (
    let claims = 0;
    claims < MAX_POST_CLAIMS_PER_TICK && attempted < POSTS_PER_WORKSPACE_TICK;
    claims += 1
  ) {
    const claimed = await claimNextDuePost(db, workspaceId, now, [...failedSeats]);
    if (!claimed) break;

    const scheduledAt = claimed.scheduledAt ? new Date(claimed.scheduledAt) : now;
    if (now.getTime() - scheduledAt.getTime() > POST_GRACE_MS) {
      await markPostMissed(db, claimed.id, now);
      missed += 1;
      continue;
    }

    const session = await openLinkedInSession(db, config, {
      workspaceId,
      seatKey: claimed.seatKey,
      now,
      ...(options.page ? { page: options.page } : {}),
      ...(options.driver ? { driver: options.driver } : {})
    });
    if (!session.ok) {
      await releasePostToScheduled(db, claimed.id, now);
      log(
        `LinkedIn post ${claimed.id} held for ${workspaceId}/${claimed.seatKey}: ${session.blocked}`
      );
      failedSeats.add(claimed.seatKey);
      continue; // a DIFFERENT seat in this workspace may still have a healthy session
    }

    const wrongAccount = options.accountConfirmed
      ? null
      : await confirmSeatAccount(db, session, workspaceId, claimed.seatKey);
    if (wrongAccount) {
      await releasePostToScheduled(db, claimed.id, now);
      log(`LinkedIn post ${claimed.id} held: ${wrongAccount}`);
      failedSeats.add(claimed.seatKey);
      continue;
    }

    attempted += 1;
    const body = renderPostBody(claimed.blocks);
    const result = session.driver.publishPost
      ? await session.driver.publishPost(session.page, body)
      : {
          ok: false as const,
          failureKind: 'compose_unavailable' as const,
          detail: 'This driver has no publishPost capability.'
        };

    if (result.ok) {
      await markPostPublished(db, claimed.id, { postedUrl: result.externalRef ?? null }, now);
      published += 1;
    } else {
      await markPostFailed(
        db,
        claimed.id,
        { kind: result.failureKind ?? 'unknown', detail: result.detail ?? '' },
        now
      );
      log(`LinkedIn post ${claimed.id} failed (${result.failureKind}): ${result.detail}`);
    }
  }

  return { published, missed };
}

/**
 * Advance every running managed campaign in one workspace.
 *
 * SEPARATE FROM `runLinkedInSideTasks`, and separate for two reasons.
 *
 * It is WORKSPACE work, not SEAT work. The side tasks now run once per seat --
 * each account has its own inbox to read and its own backlog to reconcile --
 * but a campaign advances once per tick regardless of how many accounts the
 * workspace has, and running the tick per seat would hand the same member two
 * steps in one cycle.
 *
 * It also NEEDS NO BROWSER. It reads campaign state and writes 'planned' rows,
 * which is arithmetic, not automation, so it must keep working on a deployment
 * where the local worker is off -- otherwise a paused install silently freezes
 * every campaign mid-workflow with nothing recording why.
 *
 * Ordered AFTER the side tasks by its callers, deliberately: it plans from
 * outcomes the inbox sync has already recorded, rather than from a ledger that
 * is half-updated for this cycle.
 */
export async function runLinkedInCampaignTick(
  db: Db,
  workspaceId: string,
  options: { now?: Date; log?: (message: string) => void } = {}
): Promise<RunnerResult | null> {
  const log = options.log ?? ((message: string) => console.log(message));
  try {
    return await runManagedCampaigns(db, workspaceId, options.now ?? new Date());
  } catch (cause) {
    log(
      `LinkedIn campaign tick failed for ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    return null;
  }
}

/** Re-exported so a route can stop a withdrawal pass with the switch that stops a batch. */
export { stopLinkedInBatches };
