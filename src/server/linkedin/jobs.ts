import type { Db } from '../db.js';
import { ownerSeat, type SeatRef } from './actions.js';
import type { LinkedInDriver, LinkedInPage } from './driver.js';
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
import { playwrightScrapeDriver, type LinkedInScrapeDriver, type LinkedInScrapePage } from './driver-scrape.js';
import {
  isPendingInviteList,
  playwrightWithdrawDriver,
  type LinkedInListPage,
  type LinkedInWithdrawDriver
} from './driver-withdraw.js';
import { syncThreadMessages, syncThreads, threadByUrn } from './inbox.js';
import { leadSourcingConfig, leadSourcingEnabled, runPendingLeadSources, type LeadSourceRunResult } from './leads.js';
import {
  openLinkedInSession,
  stopLinkedInBatches,
  type LinkedInLocalWorkerConfig
} from './local-worker.js';
import { runManagedCampaigns, type RunnerResult } from './runner.js';
import { OWNER_SEAT_KEY } from './seats.js';
import {
  DEFAULT_CANDIDATE_LIMIT,
  runWithdrawalBatch,
  sweepStaleInvites,
  syncPendingInvites,
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

export interface LinkedInJobOptions {
  workspaceId: string;
  seatKey?: string;
  now?: Date;
  /** Absent -- always, outside a test -- means the shared persistent-profile browser. */
  page?: LinkedInPage;
  driver?: LinkedInDriver;
  log?: (message: string) => void;
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
  options: LinkedInJobOptions & { maxThreads?: number; maxMessages?: number; inboxDriver?: LinkedInInboxDriver }
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
    return { ...empty, blocked: `${listing.failureKind ?? 'unknown'}: ${listing.detail ?? 'The inbox walk stopped early and said nothing about why.'}` };
  }

  const synced = await syncThreads(db, { workspaceId: options.workspaceId, seatKey, threads: listing.threads }, now);
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
      { workspaceId: options.workspaceId, seatKey, threadUrn: thread.threadUrn, messages: transcript.messages },
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
): Promise<{ blocked: string | null; inserted: number; inbound: number; linkage: string | null; degraded: string[] }> {
  const now = options.now ?? new Date();
  const seatKey = options.seatKey ?? OWNER_SEAT_KEY;

  // Refuses a conversation this workspace has never synced, rather than
  // navigating to an id somebody typed. `syncThreadMessages` would refuse it
  // too; asking here means the answer is a 404 and not a browser session.
  const known = await threadByUrn(db, options.workspaceId, threadUrn);
  if (!known) return { blocked: null, inserted: 0, inbound: 0, linkage: null, degraded: [] };

  const session = await openLinkedInSession(db, config, options);
  if (!session.ok) return { blocked: session.blocked, inserted: 0, inbound: 0, linkage: null, degraded: [] };

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
  const listed = await withdrawDriver.listPendingInvites(session.page as unknown as LinkedInListPage, {
    ...(options.maxInvites === undefined ? {} : { maxInvites: options.maxInvites }),
    seed: `pending:${options.workspaceId}`,
    now
  });
  if (!isPendingInviteList(listed)) {
    return {
      ...empty,
      blocked: `${listed.failureKind ?? 'unknown'}: ${listed.detail ?? 'The sent-invitations list could not be read.'}`
    };
  }

  const synced = await syncPendingInvites(db, seat, listed, now);
  return { ...synced, blocked: null, degraded: listed.degraded };
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
 * The staleness a managed workflow declared for one seat's invites.
 *
 * Every pending invite this seat holds that belongs to a campaign member whose
 * workflow has a `withdraw_pending` step, paired with that step's own
 * `afterDays`. Read from `linkedin_workflows.steps_json` -- the LIVE workflow,
 * the same one `runner.ts` reads when it ticks the step, rather than the
 * snapshot in `linkedin_campaigns.sequence_json`, so editing a workflow changes
 * the sweep exactly as it changes the runner.
 *
 * ONE STATEMENT RATHER THAN A LOOP OVER CAMPAIGNS: a seat can carry a dozen
 * campaigns and a lead list can carry thousands of members, and the answer is
 * one join away.
 *
 * The first `withdraw_pending` step wins when a workflow has several. That is a
 * choice and the conservative one is not available: a workflow with two
 * withdraw steps has two answers and no way to say which invite belongs to
 * which, and the FIRST one is the earliest deadline the operator wrote down.
 */
async function managedInviteStaleness(db: Db, seat: SeatRef): Promise<Array<{ actionId: string; afterDays: number }>> {
  const rows = await db.prepare(`
    SELECT a.id AS action_id, (
      SELECT (step->'config'->>'afterDays')::int
      FROM jsonb_array_elements(w.steps_json) AS step
      WHERE step->>'action' = 'withdraw_pending'
      LIMIT 1
    ) AS after_days
    FROM linkedin_actions a
    JOIN linkedin_campaign_members m ON m.id = a.campaign_member_id AND m.workspace_id = a.workspace_id
    JOIN linkedin_campaigns c ON c.id = m.campaign_id AND c.workspace_id = m.workspace_id
    JOIN linkedin_workflows w ON w.id = c.workflow_id AND w.workspace_id = c.workspace_id
    WHERE a.workspace_id=? AND a.seat_key=? AND a.kind='invite'
      AND a.status IN ('sent', 'exported')
      AND a.campaign_member_id IS NOT NULL
  `).all<{ action_id: string; after_days: number | null }>(seat.workspaceId, seat.seatKey);

  const out: Array<{ actionId: string; afterDays: number }> = [];
  for (const row of rows) {
    // A workflow with no withdraw step said nothing about staleness, so its
    // invites fall through to the account default with everything else.
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
  const sweepCounts = { candidates: swept.candidates.length, queued: swept.queued, duplicates: swept.duplicates };

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
  const batchId = `lwbatch_${now.getTime().toString(36)}`;

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
  options: LinkedInJobOptions & { maxSources?: number; scraper?: LinkedInScrapeDriver; env?: NodeJS.ProcessEnv }
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
      ...(options.scraper === undefined ? {} : { scraper: options.scraper }),
      now: () => options.now ?? new Date(),
      ...(options.log === undefined ? {} : { log: options.log })
    },
    options.maxSources === undefined ? {} : { maxSources: options.maxSources }
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
  withdrawals: WithdrawalJobResult | null;
  leads: LeadSourceRunResult[];
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
 * account of what is still outstanding rather than last week's. Then the
 * withdrawals themselves. Lead sourcing last, because it is the only one that
 * is off by default and the only one that touches nobody's account but the
 * operator's own reading history.
 *
 * NEVER THROWS. Each job is caught on its own: a workspace whose inbox will not
 * open must still get its withdrawal queue drained, and none of them may cost
 * the worker its tick.
 */
export async function runLinkedInSideTasks(
  db: Db,
  config: LinkedInLocalWorkerConfig,
  options: LinkedInJobOptions & { maxThreads?: number; maxWithdrawals?: number; maxSources?: number }
): Promise<LinkedInSideTaskResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const result: LinkedInSideTaskResult = {
    workspaceId: options.workspaceId,
    inbox: null,
    pendingInvites: null,
    withdrawals: null,
    leads: []
  };

  if (!config.enabled) return result;

  const jobs: Array<[string, () => Promise<void>]> = [
    [
      'inbox sync',
      async () => {
        result.inbox = await syncLinkedInInbox(db, config, options);
      }
    ],
    [
      'pending-invite sync',
      async () => {
        result.pendingInvites = await syncLinkedInPendingInvites(db, config, options);
      }
    ],
    [
      'withdrawal queue',
      async () => {
        result.withdrawals = await runLinkedInWithdrawals(db, config, {
          ...options,
          ...(options.maxWithdrawals === undefined ? {} : { maxActions: options.maxWithdrawals })
        });
      }
    ],
    [
      'lead sourcing',
      async () => {
        result.leads = (await runLinkedInLeadSources(db, config, options)).results;
      }
    ]
  ];

  for (const [name, run] of jobs) {
    try {
      await run();
    } catch (cause) {
      log(`LinkedIn ${name} failed for ${options.workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return result;
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
    log(`LinkedIn campaign tick failed for ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}

/** Re-exported so a route can stop a withdrawal pass with the switch that stops a batch. */
export { stopLinkedInBatches };
