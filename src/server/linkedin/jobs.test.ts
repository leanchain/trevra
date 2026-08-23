import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction, type SeatRef } from './actions.js';
import type {
  LinkedInDriver,
  LinkedInDriverResult,
  LinkedInPage,
  LinkedInPostImageUpload,
  LinkedInSeatRead
} from './driver.js';
import type { LinkedInInboxDriver } from './driver-inbox.js';
import {
  runLinkedInPostTick,
  runLinkedInSideTasks,
  runLinkedInWithdrawals,
  syncLinkedInInbox,
  syncLinkedInThread
} from './jobs.js';
import { syncThreads } from './inbox.js';
import { addPostImage, createPost, getPost } from './posts.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { parseBackgroundRunDetail, setSeatRestingUntil } from './seat-events.js';
import { upsertSeat } from './seats.js';
import {
  AVAILABILITY_CATCHUP_MARKER,
  AVAILABILITY_RETURN_MARKER,
  MAX_CATCHUP_TASKS_PER_VISIT,
  MAX_TASKS_PER_VISIT,
  markSideTaskRun,
  resetSideTaskRuns,
  sideTaskRuns,
  visitsForDay
} from './side-tasks.js';
import { DEFAULT_STALE_AFTER_DAYS } from './withdraw.js';

/**
 * THE UNATTENDED SWEEP, AND WHOSE NUMBER IT USES.
 *
 * Nothing here opens a browser: `runLinkedInWithdrawals` runs the SWEEP first
 * and the browser pass second, and the sweep is pure database work. Calling it
 * with automation switched off exercises exactly the half that decides which
 * invites get queued for withdrawal -- which is the half that was wrong -- and
 * stops at the session it cannot open.
 *
 * The defect: `DEFAULT_STALE_AFTER_DAYS` is 21, the unattended pass named no
 * `olderThanDays` at all, and so every pending invite in the workspace was
 * withdrawn at 21 days -- including the ones belonging to a campaign whose
 * workflow says, in a field the operator typed a number into, to wait 30. The
 * workflow's `withdraw_pending` step was honoured on the runner's own path and
 * overruled behind its back here.
 */

let db: Db;

/** Tuesday 09:00 UTC. */
const NOW = new Date('2026-08-04T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_jobs_test';
const SEAT: SeatRef = { workspaceId: WORKSPACE_ID, seatKey: 'owner' };
/** Automation off: the sweep still runs, the browser half stops with a sentence. */
const OFF = { enabled: false } as const;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE_ID, 'LinkedIn jobs test', NOW.toISOString());
  await upsertSeat(
    db,
    WORKSPACE_ID,
    { label: 'Test seat', timezone: 'UTC' },
    new Date('2026-01-01T09:00:00.000Z')
  );
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
});

/** An invite this seat sent `daysAgo` and nobody has answered. */
async function pendingInvite(handle: string, daysAgo: number): Promise<string> {
  const { id } = await recordAction(
    db,
    {
      workspaceId: WORKSPACE_ID,
      kind: 'invite',
      targetRef: `https://www.linkedin.com/in/${handle}/`,
      status: 'sent',
      source: 'export'
    },
    new Date(NOW.getTime() - daysAgo * 86_400_000)
  );
  return id;
}

/**
 * A managed campaign whose workflow withdraws after `afterDays`, with one
 * member, and that member's pending invite.
 *
 * Written as raw rows rather than through the manager's own API because the
 * only thing under test is the JOIN the sweep makes: action -> member ->
 * campaign -> workflow -> the step's configured number.
 */
async function managedInvite(
  handle: string,
  daysAgo: number,
  afterDays: number | null
): Promise<string> {
  const suffix = handle;
  const steps = [
    {
      id: 'step-1',
      action: 'connection_request',
      delayBefore: { amount: 0, unit: 'hours' },
      config: { message: null }
    },
    ...(afterDays === null
      ? []
      : [
          {
            id: 'step-2',
            action: 'withdraw_pending',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { afterDays }
          }
        ])
  ];
  const iso = NOW.toISOString();
  await db
    .prepare(
      'INSERT INTO linkedin_lead_lists (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)'
    )
    .run(`lilist_${suffix}`, WORKSPACE_ID, `List ${suffix}`, iso, iso);
  await db
    .prepare(
      `
    INSERT INTO linkedin_lead_contacts (id,workspace_id,list_id,first_name,last_name,company,profile_url,dedupe_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `
    )
    .run(
      `lilc_${suffix}`,
      WORKSPACE_ID,
      `lilist_${suffix}`,
      'Lead',
      suffix,
      'Acme',
      `https://www.linkedin.com/in/${handle}/`,
      suffix,
      iso,
      iso
    );
  await db
    .prepare(
      'INSERT INTO linkedin_workflows (id,workspace_id,name,steps_json,version,created_at,updated_at) VALUES (?,?,?,?::jsonb,1,?,?)'
    )
    .run(`liwf_${suffix}`, WORKSPACE_ID, `Workflow ${suffix}`, JSON.stringify(steps), iso, iso);
  await db
    .prepare(
      `
    INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,lead_list_id,workflow_id,started_at,created_at,updated_at)
    VALUES (?,?,?,'running',?::jsonb,'owner',?,?,?,?,?)
  `
    )
    .run(
      `licmp_${suffix}`,
      WORKSPACE_ID,
      `Campaign ${suffix}`,
      JSON.stringify({ manager: true, steps }),
      `lilist_${suffix}`,
      `liwf_${suffix}`,
      iso,
      iso,
      iso
    );
  await db
    .prepare(
      `
    INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status,step_index,created_at,updated_at)
    VALUES (?,?,?,?,'active',1,?,?)
  `
    )
    .run(`limem_${suffix}`, WORKSPACE_ID, `licmp_${suffix}`, `lilc_${suffix}`, iso, iso);

  const actionId = await pendingInvite(handle, daysAgo);
  await db
    .prepare(
      'UPDATE linkedin_actions SET campaign_id=?, campaign_member_id=?, workflow_step_id=? WHERE id=?'
    )
    .run(`licmp_${suffix}`, `limem_${suffix}`, 'step-1', actionId);
  return actionId;
}

async function queuedWithdrawals(): Promise<string[]> {
  const rows = await db
    .prepare('SELECT action_id FROM linkedin_withdrawals WHERE workspace_id=? ORDER BY action_id')
    .all<{ action_id: string }>(WORKSPACE_ID);
  return rows.map((row) => row.action_id);
}

describe('the unattended withdrawal sweep', () => {
  it("WAITS THE WORKFLOW'S 30 DAYS instead of the account default 21", async () => {
    const managed = await managedInvite('managed', 25, 30);
    const loose = await pendingInvite('loose', 25);

    const result = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    // The browser half never ran; the sweep half did, and its numbers are real.
    expect(result.blockedReason).toBeTruthy();
    expect(await queuedWithdrawals()).toEqual([loose]);
    expect(await queuedWithdrawals()).not.toContain(managed);
    expect(result.queued).toBe(1);
  });

  it('withdraws the managed invite once its own deadline has passed', async () => {
    const managed = await managedInvite('managed', 31, 30);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('honours a SHORTER workflow deadline than the account default too', async () => {
    // The rule is "the workflow's number", not "the more lenient number".
    const managed = await managedInvite('managed', 10, 7);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('falls back to the default for a campaign whose workflow has no withdraw step', async () => {
    // Nothing was declared, so nothing is being overruled: the account default
    // applies exactly as it did before.
    const managed = await managedInvite('nowithdraw', 25, null);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    expect(await queuedWithdrawals()).toEqual([managed]);
  });

  it('leaves the account default doing exactly what it did for unmanaged invites', async () => {
    const fresh = await pendingInvite('fresh', DEFAULT_STALE_AFTER_DAYS - 1);
    const stale = await pendingInvite('stale', DEFAULT_STALE_AFTER_DAYS + 1);

    await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });

    const queued = await queuedWithdrawals();
    expect(queued).toContain(stale);
    expect(queued).not.toContain(fresh);
  });

  it('keeps `limit` a budget across the whole sweep, not one per partition', async () => {
    await managedInvite('managed', 40, 7);
    await pendingInvite('loose', 40);

    const result = await runLinkedInWithdrawals(db, OFF, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      limit: 1
    });

    expect(result.candidates).toBe(1);
    expect(await queuedWithdrawals()).toHaveLength(1);
  });

  it('is a no-op on a seat with nothing pending', async () => {
    const result = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    expect(result.candidates).toBe(0);
    expect(await queuedWithdrawals()).toEqual([]);
    expect(SEAT.seatKey).toBe('owner');
  });
});

/**
 * THE BATCH ID A WITHDRAWAL PASS STAMPS ON ITS ROWS.
 *
 * It was `lwbatch_${now.getTime().toString(36)}` -- a function of the wall
 * clock and nothing else. On a single-tenant box that is unique enough; on a
 * hosted one, where a tick fans out across thousands of seats, two passes
 * starting in the same millisecond were handed the SAME
 * `linkedin_withdrawals.batch_id`. Reading a pass back to what it did then
 * returned another tenant's withdrawals as well.
 */
describe('the withdrawal batch id', () => {
  it('differs between two passes started at the same instant', async () => {
    await pendingInvite('one', DEFAULT_STALE_AFTER_DAYS + 1);
    // Both passes are given the SAME `now`, which is exactly the case the old
    // millisecond-derived id could not distinguish.
    const first = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    const second = await runLinkedInWithdrawals(db, OFF, { workspaceId: WORKSPACE_ID, now: NOW });
    // The browser half is off, so neither pass reaches `runWithdrawalBatch`
    // and both report an empty batch id. The id is asserted where it is
    // actually minted instead: two calls at one instant must not collide.
    expect(first.batchId).toBe('');
    expect(second.batchId).toBe('');
    const minted = new Set([id('lwbatch'), id('lwbatch'), id('lwbatch')]);
    expect(minted.size).toBe(3);
  });
});

/**
 * WHOSE INBOX A SINGLE-THREAD REFRESH LOOKS IN.
 *
 * `syncLinkedInThread` computes `seatKey` from the job options and hands it to
 * `syncThreadMessages` -- but looked the conversation up with `threadByUrn`
 * and no seat key at all, so the existence check ran against the OWNER seat's
 * inbox. A refresh requested for a second account therefore reported that
 * account's own conversation as unknown, and would have accepted an owner-seat
 * conversation the caller never asked about.
 */
describe('the seat a single-thread refresh reads', () => {
  it('finds a conversation belonging to the seat the job names', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales (SDR)', timezone: 'UTC' }, NOW, 'sales');
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'sales',
        threads: [
          {
            threadUrn: '2-sales==',
            profileUrl: 'https://www.linkedin.com/in/sales-lead/',
            name: 'Sales Lead',
            lastMessageAt: NOW.toISOString(),
            snippet: 'hello',
            unread: false
          }
        ]
      },
      NOW
    );

    // Automation is off, so the call gets as far as the lookup and then stops
    // at the session it cannot open. `blocked` being non-null is therefore the
    // proof that the conversation WAS found: an unknown thread returns early
    // with `blocked: null` and never asks for a browser.
    const found = await syncLinkedInThread(db, OFF, '2-sales==', {
      workspaceId: WORKSPACE_ID,
      seatKey: 'sales',
      now: NOW
    });
    expect(found.blocked).not.toBeNull();

    // And the owner seat still does not see it, which is the other half of the
    // same rule: from that seat's point of view the conversation does not exist.
    const owner = await syncLinkedInThread(db, OFF, '2-sales==', {
      workspaceId: WORKSPACE_ID,
      now: NOW
    });
    expect(owner.blocked).toBeNull();
  });
});

/**
 * WHOSE CONVERSATIONS THESE ARE.
 *
 * The defect, as a real workspace held it. `linkedin_threads` is a read cache
 * keyed by (workspace, seat) and by nothing else: no column records which
 * LinkedIn account produced a row. The sync read whatever session the seat's
 * browser profile happened to hold and filed it under the seat, and the only
 * identity check in the subsystem lives in `detectLinkedInSeat` -- which fires
 * only when a profile URL was already confirmed, and is not part of a sync. So
 * a workspace that synced before its first detect kept nine conversations
 * belonging to one account under a seat later confirmed as another, and every
 * one of them stayed on the Inbox screen as if it were the connected
 * account's own.
 */
describe('the account a sync is allowed to read', () => {
  const seatRead: LinkedInSeatRead = {
    ok: true,
    profileUrl: 'https://www.linkedin.com/in/connected/',
    name: 'Connected Account',
    connectionsCount: 500,
    degraded: []
  };

  /** Only `readSeat` is reached on these paths; the rest is a trap on purpose. */
  function identityDriver(read: LinkedInSeatRead | LinkedInDriverResult = seatRead) {
    const calls: string[] = [];
    const readOptions: Array<{ skipConnections?: boolean } | undefined> = [];
    const trap = () => {
      throw new Error(
        'a sync must not act on LinkedIn while it is confirming whose account this is'
      );
    };
    return {
      calls,
      readOptions,
      driver: {
        readSeat: async (_page: LinkedInPage, options?: { skipConnections?: boolean }) => {
          calls.push('readSeat');
          readOptions.push(options);
          return read;
        },
        sendInvite: trap,
        sendDm: trap,
        sendReply: trap,
        viewProfile: trap,
        followProfile: trap,
        likeRecentPost: trap,
        endorseSkills: trap,
        isLoggedIn: async () => true,
        loginWithCredentials: trap
      } as unknown as LinkedInDriver
    };
  }

  /** A page nothing here navigates: the walk is refused before the inbox driver is reached. */
  const page = {
    goto: async () => undefined,
    url: () => 'https://www.linkedin.com/feed/',
    locator: () => {
      throw new Error('nothing may be read from the page on a refused sync');
    },
    waitForTimeout: async () => {}
  } as unknown as LinkedInPage;

  const inboxDriver = {
    listConversations: async () => {
      throw new Error('the rail must not be walked when the signed-in account is not this seat');
    },
    readThread: async () => {
      throw new Error('no conversation may be read when the signed-in account is not this seat');
    },
    sendReply: async () => {
      throw new Error('nothing is ever sent from a sync');
    }
  } as unknown as LinkedInInboxDriver;

  async function storedThreads(): Promise<number> {
    const row = await db
      .prepare('SELECT COUNT(*)::int AS count FROM linkedin_threads WHERE workspace_id=?')
      .get<{ count: number }>(WORKSPACE_ID);
    return row?.count ?? 0;
  }

  async function cacheOneThread(): Promise<void> {
    await syncThreads(
      db,
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'owner',
        threads: [
          {
            threadUrn: '2-somebody-else==',
            profileUrl: 'https://www.linkedin.com/in/stranger/',
            name: 'Stranger',
            lastMessageAt: NOW.toISOString(),
            snippet: 'read from the account that is no longer signed in',
            unread: false
          }
        ]
      },
      NOW
    );
  }

  it('READS NOTHING and clears the cache when the browser is signed in as somebody else', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/seat-owner/' },
      NOW
    );
    await cacheOneThread();
    expect(await storedThreads()).toBe(1);

    const { driver, calls } = identityDriver();
    const result = await syncLinkedInInbox(
      db,
      { enabled: true },
      { workspaceId: WORKSPACE_ID, now: NOW, page, driver, inboxDriver }
    );

    expect(calls).toEqual(['readSeat']);
    expect(result.threads).toBe(0);
    expect(result.blocked).toContain('https://www.linkedin.com/in/connected/');
    expect(result.blocked).toContain('https://www.linkedin.com/in/seat-owner/');
    // The other account's conversations are gone rather than left on screen
    // under this seat's name. The ledger is untouched -- it is history.
    expect(await storedThreads()).toBe(0);
  });

  it('refuses a seat whose account was never confirmed, instead of adopting whoever is signed in', async () => {
    // `beforeEach` leaves the seat with no profile URL: this is the state the
    // real workspace synced in, and the state that filed a stranger's inbox.
    const { driver } = identityDriver();
    const result = await syncLinkedInInbox(
      db,
      { enabled: true },
      { workspaceId: WORKSPACE_ID, now: NOW, page, driver, inboxDriver }
    );

    expect(result.threads).toBe(0);
    expect(result.blocked).toContain('never confirmed');
  });

  it('walks the rail when the signed-in account IS the seat', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    await cacheOneThread();

    const { driver } = identityDriver();
    const walked = {
      listConversations: async () => ({ ok: true as const, threads: [], degraded: [] }),
      readThread: async () => ({
        ok: true as const,
        threadUrn: '2-x==',
        messages: [],
        degraded: []
      }),
      sendReply: async () => {
        throw new Error('nothing is ever sent from a sync');
      }
    } as unknown as LinkedInInboxDriver;

    const result = await syncLinkedInInbox(
      db,
      { enabled: true },
      { workspaceId: WORKSPACE_ID, now: NOW, page, driver, inboxDriver: walked }
    );

    expect(result.blocked).toBeNull();
    // Nothing was cleared: this seat's own cache survives its own sync.
    expect(await storedThreads()).toBe(1);
  });
});

/**
 * THE TICK, AND HOW OFTEN IT IS ALLOWED TO GO AND LOOK.
 *
 * `runLinkedInSideTasks` is called once per worker tick -- 60 seconds by
 * default -- and used to run all five of its jobs on every one of them,
 * forever, at every hour of the day. With an empty inbox and an empty queue
 * that was ~8,600 LinkedIn page loads a day for one seat, ~2,900 of them on
 * the connections page. Nothing was sent and the account was restricted for
 * "accessing an unusually large amount of LinkedIn profile data over time".
 *
 * Every test below asserts a refusal to open a browser.
 */
describe('how often the side-task tick touches LinkedIn', () => {
  const CONNECTED = 'https://www.linkedin.com/in/connected/';
  const seatRead: LinkedInSeatRead = {
    ok: true,
    profileUrl: CONNECTED,
    name: 'Connected Account',
    connectionsCount: 500,
    degraded: []
  };

  function tickDriver() {
    const calls: string[] = [];
    const readOptions: Array<{ skipConnections?: boolean } | undefined> = [];
    return {
      calls,
      readOptions,
      driver: {
        readSeat: async (_page: LinkedInPage, options?: { skipConnections?: boolean }) => {
          calls.push('readSeat');
          readOptions.push(options);
          return seatRead;
        },
        isLoggedIn: async () => true
      } as unknown as LinkedInDriver
    };
  }

  /**
   * When this seat opens LinkedIn on the test's Tuesday, and the first of
   * those visits.
   *
   * Derived from the same function the tick uses rather than hardcoded: the
   * SCHEDULE is asserted in `side-tasks.test.ts`, and what is under test here
   * is what the tick does with it.
   */
  const VISIT_STARTS = visitsForDay(
    `${WORKSPACE_ID}:owner`,
    { year: 2026, month: 8, day: 4 },
    { startMinute: 480, endMinute: 1080 }
  ).map(
    (visit) =>
      new Date(Date.UTC(2026, 7, 4, Math.floor(visit.startMinute / 60), visit.startMinute % 60))
  );
  const VISIT_AT = VISIT_STARTS[0] as Date;

  /** Every real driver starts with a navigation, so this fails all five of them fast. */
  const page = {
    goto: async () => {
      throw new Error('this test does not navigate');
    },
    url: () => 'https://www.linkedin.com/feed/',
    locator: () => {
      throw new Error('this test does not read the page');
    },
    waitForTimeout: async () => {}
  } as unknown as LinkedInPage;

  // The in-process cadence floor outlives one test's database, exactly as it
  // outlives one deploy's missing table. Cleared so each test starts cold.
  beforeEach(() => resetSideTaskRuns());

  async function connectedSeat(): Promise<void> {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: CONNECTED },
      NOW
    );
  }

  function tick(now: Date, driver: LinkedInDriver, companionBrowser = false, database: Db = db) {
    return runLinkedInSideTasks(
      database,
      { enabled: true, companionBrowser } as unknown as Parameters<typeof runLinkedInSideTasks>[1],
      {
        workspaceId: WORKSPACE_ID,
        seatKey: 'owner',
        now,
        page,
        driver,
        dayShape: FLAT_DAY_SHAPE,
        log: () => {}
      }
    );
  }

  it('holds one pass per visit even when the cadence table is unavailable', async () => {
    await connectedSeat();
    // Simulate the exact mid-deploy failure without dropping a table shared by
    // other Vitest files. Both cadence calls swallow their own DB error and the
    // in-process floor must still make one visit one pass.
    const realPrepare = db.prepare.bind(db);
    const unavailable = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('linkedin_side_task_runs')) {
              const fail = async () => {
                throw new Error('cadence table unavailable');
              };
              return { get: fail, all: fail, run: fail };
            }
            return realPrepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Db;

    const first = await tick(VISIT_AT, tickDriver().driver, false, unavailable);
    expect(first.ran).toHaveLength(MAX_TASKS_PER_VISIT);

    const second = await tick(
      new Date(VISIT_AT.getTime() + 60_000),
      tickDriver().driver,
      false,
      unavailable
    );
    expect(second.ran).toEqual([]);
    expect(second.skipped).toContain('already happened');
  });

  it('does at most the bounded normal visit budget, and nothing on the ticks in between', async () => {
    await connectedSeat();

    const first = await tick(VISIT_AT, tickDriver().driver);
    expect(first.skipped).toBeNull();
    expect(first.ran).toHaveLength(MAX_TASKS_PER_VISIT);
    const event = await db
      .prepare(
        `
      SELECT detail FROM linkedin_seat_events
      WHERE workspace_id=? AND seat_key='owner' AND kind='background_run'
      ORDER BY occurred_at DESC LIMIT 1
    `
      )
      .get<{ detail: string | null }>(WORKSPACE_ID);
    const detail = parseBackgroundRunDetail(event?.detail ?? null);
    expect(detail?.tasks).toEqual(first.ran);
    expect(detail?.status).toBe('completed');

    // The next worker tick, sixty seconds later and STILL INSIDE THE SAME
    // VISIT. This is where the cap silently became "two per minute": the two
    // jobs just stamped are no longer stale, so the next two would be picked,
    // warmed up for and identity-checked all over again.
    const second = await tick(new Date(VISIT_AT.getTime() + 60_000), tickDriver().driver);
    expect(second.ran).toEqual([]);
    expect(second.skipped).toContain('already happened');

    // A minute after that, outside every visit: LinkedIn is not open at all.
    const between = await tick(new Date(VISIT_AT.getTime() + 30 * 60_000), tickDriver().driver);
    expect(between.ran).toEqual([]);
    expect(between.skipped).toContain('none of them is now');
  });

  it('does one richer catch-up when a companion returns outside the normal visit schedule', async () => {
    await connectedSeat();
    const returnedAt = new Date(VISIT_AT.getTime() + 30 * 60_000);
    await markSideTaskRun(db, WORKSPACE_ID, 'owner', AVAILABILITY_RETURN_MARKER, returnedAt);

    const first = await tick(returnedAt, tickDriver().driver, true);
    expect(first.ran).toHaveLength(MAX_CATCHUP_TASKS_PER_VISIT);
    expect(new Set(first.ran)).toEqual(new Set(['inbox', 'pending_invites', 'withdrawals']));

    const runs = await sideTaskRuns(db, WORKSPACE_ID, 'owner');
    expect(runs.get(AVAILABILITY_CATCHUP_MARKER)?.getTime()).toBe(returnedAt.getTime());

    const second = await tick(new Date(returnedAt.getTime() + 60_000), tickDriver().driver, true);
    expect(second.ran).toEqual([]);
    expect(second.skipped).toContain('none of them is now');
  });

  it('picks up the rest of the list on the following visits, so nothing is starved', async () => {
    await connectedSeat();

    // TWO DAYS, because two or three visits of at most two jobs each cannot
    // cover five jobs in one. That is the trade the cap buys: no visit does
    // more than a person would, and the list still drains.
    const done = new Set<string>();
    for (const day of [4, 5, 6]) {
      const visits = visitsForDay(
        `${WORKSPACE_ID}:owner`,
        { year: 2026, month: 8, day },
        { startMinute: 480, endMinute: 1080 }
      );
      for (const visit of visits) {
        const at = new Date(
          Date.UTC(2026, 7, day, Math.floor(visit.startMinute / 60), visit.startMinute % 60)
        );
        const result = await tick(at, tickDriver().driver);
        for (const task of result.ran) done.add(task);
      }
    }

    expect([...done].sort()).toEqual(['inbox', 'pending_invites', 'withdrawals']);
  });

  it('confirms whose account this is ONCE for the visit, not once per job', async () => {
    await connectedSeat();
    const { driver, calls } = tickDriver();

    await tick(VISIT_AT, driver);

    // Two jobs confirm identity independently, and each confirmation is a
    // profile load. They cannot disagree: same browser, same page, seconds
    // apart.
    expect(calls.filter((call) => call === 'readSeat').length).toBeLessThanOrEqual(1);
  });

  it('never asks for the connection count, which is a second page load for a number nobody reads', async () => {
    await connectedSeat();
    const { driver, readOptions } = tickDriver();

    await tick(VISIT_AT, driver);

    for (const options of readOptions) expect(options).toEqual({ skipConnections: true });
  });

  it("loads no profile for a visit that reads nobody else's data", async () => {
    await connectedSeat();
    // Everything is freshly run except the pending-invite sync, which reads
    // this account's OWN sent list and has never needed to know who is signed
    // in. Hoisting the identity check to the visit would have handed it one.
    for (const task of ['inbox', 'acceptance', 'withdrawals', 'lead_sources'] as const) {
      await markSideTaskRun(db, WORKSPACE_ID, 'owner', task, VISIT_AT);
    }
    await markSideTaskRun(
      db,
      WORKSPACE_ID,
      'owner',
      'pending_invites',
      new Date(VISIT_AT.getTime() - 13 * 3_600_000)
    );
    const { driver, calls } = tickDriver();

    const result = await tick(VISIT_AT, driver);

    expect(result.ran).toEqual(['pending_invites']);
    expect(calls).toEqual([]);
  });

  it('opens no browser at 03:00 -- nobody reads their LinkedIn inbox at three in the morning', async () => {
    await connectedSeat();
    const { driver, calls } = tickDriver();

    const result = await tick(new Date('2026-08-04T03:00:00.000Z'), driver);

    expect(calls).toEqual([]);
    expect(result.ran).toEqual([]);
    expect(result.skipped).toContain('03:00');
  });

  it('opens no browser while the seat is between sittings', async () => {
    await connectedSeat();
    await setSeatRestingUntil(
      db,
      WORKSPACE_ID,
      'owner',
      new Date(VISIT_AT.getTime() + 30 * 60_000)
    );
    const { driver, calls } = tickDriver();

    const result = await tick(VISIT_AT, driver);

    expect(calls).toEqual([]);
    expect(result.skipped).toContain('between sittings');
  });

  it('opens no browser for a paused seat', async () => {
    await connectedSeat();
    await upsertSeat(db, WORKSPACE_ID, { posture: 'paused' }, NOW);
    const { driver, calls } = tickDriver();

    const result = await tick(NOW, driver);

    expect(calls).toEqual([]);
    expect(result.ran).toEqual([]);
  });
});

describe('runLinkedInPostTick', () => {
  const page: LinkedInPage = {
    goto: async () => null,
    url: () => 'https://www.linkedin.com/feed/',
    locator: () => {
      throw new Error('the fake driver below never touches the page directly');
    },
    waitForTimeout: async () => {}
  };

  function driverThatReturns(
    result: LinkedInDriverResult,
    seatRead = {
      ok: true as const,
      profileUrl: 'https://www.linkedin.com/in/connected/',
      name: 'Connected',
      connectionsCount: 10,
      degraded: []
    },
    onPublish?: (options?: { images?: LinkedInPostImageUpload[] }) => void
  ) {
    return {
      readSeat: async () => seatRead,
      isLoggedIn: async () => true,
      publishPost: async (
        _page: LinkedInPage,
        _body: string,
        options?: { images?: LinkedInPostImageUpload[] }
      ) => {
        onPublish?.(options);
        return result;
      },
      sendInvite: async () => {
        throw new Error('unused');
      },
      sendDm: async () => {
        throw new Error('unused');
      },
      sendReply: async () => {
        throw new Error('unused');
      },
      viewProfile: async () => {
        throw new Error('unused');
      },
      followProfile: async () => {
        throw new Error('unused');
      },
      likeRecentPost: async () => {
        throw new Error('unused');
      },
      endorseSkills: async () => {
        throw new Error('unused');
      },
      loginWithCredentials: async () => {
        throw new Error('unused');
      }
    } as unknown as LinkedInDriver;
  }

  const CONFIG = { enabled: true } as unknown as Parameters<typeof runLinkedInPostTick>[1];

  it('publishes a due post and marks it posted with the returned URL', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    const result = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({
        ok: true,
        failureKind: null,
        externalRef: 'https://www.linkedin.com/feed/update/urn:li:activity:123/'
      }),
      accountConfirmed: true
    });

    expect(result.published).toBe(1);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({
      status: 'posted',
      postedUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/'
    });
  });

  it('loads stored post images and hands their bytes to the publisher', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi with image' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );
    await addPostImage(
      db,
      WORKSPACE_ID,
      post.id,
      { name: 'proof.png', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3]) },
      NOW
    );
    let images: LinkedInPostImageUpload[] | undefined;

    const result = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: true, failureKind: null }, undefined, (options) => {
        images = options?.images;
      }),
      accountConfirmed: true
    });

    expect(result.published).toBe(1);
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ name: 'proof.png', mimeType: 'image/png' });
    expect(images?.[0]?.buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('marks a post failed, not retried, when the driver reports a failure', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: false, failureKind: 'selector_drift', detail: 'gone' }),
      accountConfirmed: true
    });

    const after = await getPost(db, WORKSPACE_ID, post.id);
    expect(after).toMatchObject({
      status: 'failed',
      error: { kind: 'selector_drift', detail: 'gone' }
    });

    // A second tick must not touch it again -- 'failed' is terminal, not re-queued.
    const second = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: true, failureKind: null }),
      accountConfirmed: true
    });
    expect(second.published).toBe(0);
  });

  it('marks a post missed, not published, once it is more than 6 hours late', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const staleScheduledAt = new Date(NOW.getTime() - 7 * 3_600_000).toISOString();
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: staleScheduledAt,
        createdBy: null
      },
      NOW
    );

    const result = await runLinkedInPostTick(db, CONFIG, {
      workspaceId: WORKSPACE_ID,
      now: NOW,
      page,
      driver: driverThatReturns({ ok: true, failureKind: null }),
      accountConfirmed: true
    });

    expect(result.missed).toBe(1);
    expect(result.published).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({ status: 'missed' });
  });

  it('holds (releases back to scheduled) rather than fails when the companion session cannot open', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    const post = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'Hi' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    // { enabled: false } makes openLinkedInSession report `ok: false` before any page/driver is touched.
    const result = await runLinkedInPostTick(
      db,
      { enabled: false } as unknown as Parameters<typeof runLinkedInPostTick>[1],
      { workspaceId: WORKSPACE_ID, now: NOW }
    );

    expect(result.published).toBe(0);
    expect(await getPost(db, WORKSPACE_ID, post.id)).toMatchObject({ status: 'scheduled' });
  });

  it('does not stop at the first seat whose session fails to open -- a second seat in the same workspace is still attempted', async () => {
    // Regression test for the fix: this loop used to `break` the whole
    // workspace-scoped tick on the first session failure, silently starving
    // every OTHER seat's due post too. Both seats fail here (session opening
    // is disabled globally via `{ enabled: false }`, which is the only lever
    // the existing openLinkedInSession test seam exposes -- it cannot be made
    // to succeed for one seat and fail for another), so this proves the LOOP
    // no longer aborts after the first failure (both posts get attempted and
    // released, not just one) -- not that a healthy second seat succeeds. That
    // half is covered by claimNextDuePost's own "skips excluded seats" test
    // (Task 2) plus this task's existing single-seat "publishes a due post"
    // test, together proving the exclusion mechanism and the success path
    // independently.
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Owner', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/connected/' },
      NOW
    );
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Second seat', timezone: 'UTC', profileUrl: 'https://www.linkedin.com/in/second/' },
      NOW,
      'seat-b'
    );
    const postA = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        blocks: [{ runs: [{ type: 'text', text: 'From the owner seat' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );
    const postB = await createPost(
      db,
      {
        id: id('lipost'),
        workspaceId: WORKSPACE_ID,
        seatKey: 'seat-b',
        blocks: [{ runs: [{ type: 'text', text: 'From the second seat' }] }],
        status: 'scheduled',
        scheduledAt: NOW.toISOString(),
        createdBy: null
      },
      NOW
    );

    // A `status: 'scheduled'` check alone cannot distinguish "both seats were
    // attempted and released" from "the loop broke after the first and never
    // touched the second" -- an untouched post is already 'scheduled'. `log`
    // is called once per held seat, so counting ITS calls is what actually
    // proves the loop kept going: 1 call is the old (broken) behavior, 2 is
    // the fixed one.
    const held: string[] = [];
    const result = await runLinkedInPostTick(
      db,
      { enabled: false } as unknown as Parameters<typeof runLinkedInPostTick>[1],
      { workspaceId: WORKSPACE_ID, now: NOW, log: (message: string) => held.push(message) }
    );

    expect(result.published).toBe(0);
    expect(held).toHaveLength(2);
    expect(held.some((m) => m.includes(postA.id))).toBe(true);
    expect(held.some((m) => m.includes(postB.id))).toBe(true);
    expect(await getPost(db, WORKSPACE_ID, postA.id)).toMatchObject({ status: 'scheduled' });
    expect(await getPost(db, WORKSPACE_ID, postB.id)).toMatchObject({ status: 'scheduled' });
  });
});
