/**
 * HOW OFTEN A PERSON ACTUALLY OPENS LINKEDIN, which is two to five times a day
 * for a few minutes -- not every sixty seconds, and not on a per-job timer.
 *
 * THE DEFECT, STATED PLAINLY. `runLinkedInSideTasks` is called once per worker
 * tick (`AUTOMATION_INTERVAL_MS`, 60s by default) and ran all five of its jobs
 * unconditionally. None of them asked when it last ran. With an empty queue,
 * an empty inbox and nothing scheduled, one connected seat produced six
 * LinkedIn navigations per tick -- about 8,600 page loads a day, ~2,900 of
 * them on `/mynetwork/invite-connect/connections/`, the surface LinkedIn most
 * associates with prospecting -- spread evenly across all twenty-four hours.
 * See migration 071 for the per-tick breakdown.
 *
 * THE MODEL IS A VISIT, NOT AN INTERVAL, and that distinction is the whole
 * file. A per-task interval -- "read the inbox every 30 minutes" -- is still a
 * polling loop; it just polls more slowly, and it produces a perfectly flat
 * access graph that no human has ever generated. What a person does is:
 *
 *   - open LinkedIn 2-5 times on a working day, at no fixed hour;
 *   - stay 2-5 minutes;
 *   - glance at the feed or notifications, look at messages, maybe one other
 *     thing;
 *   - close it and not come back for hours.
 *
 * So the browser is allowed out 2-5 times a day, the visits are drawn inside
 * the seat's own working window with a guaranteed gap between them, and each
 * visit may do AT MOST TWO of the five jobs -- because three minutes is not
 * enough time to walk an inbox, reconcile a sent-invite list, open profiles,
 * drain a withdrawal queue and harvest a lead source, and an account that
 * appears to do all five in one burst is not a person.
 *
 * Between visits the tab is closed. `scripts/linkedin-side-task-load.ts`
 * replays a week of ticks through these functions and counts what comes out.
 *
 * NOTHING HERE THROWS. Every caller is a worker tick on its way somewhere
 * else; an unreadable cadence row means "eligible", because the visit schedule
 * is the real bound and the safety gate is elsewhere.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../db.js';
import {
  dayShapeFor,
  localDateOf,
  weekdayOf,
  weekdayVolumeFactor,
  workWindowOf,
  zonedToUtc,
  type DayShapeFn,
  type LocalDate,
  type WorkWindowSeat
} from './pacing.js';

/** The five jobs in `runLinkedInSideTasks`, in the order that function runs them. */
export type SideTaskName = 'inbox' | 'pending_invites' | 'acceptance' | 'withdrawals' | 'lead_sources';

export const SIDE_TASK_NAMES: readonly SideTaskName[] = [
  'inbox',
  'pending_invites',
  'acceptance',
  'withdrawals',
  'lead_sources'
];

/**
 * The jobs that must know WHOSE account is signed in before they run, and the
 * only reason a visit ever loads `/in/me/`.
 *
 * `inbox` files another member's conversations against this seat, and
 * `acceptance` reads a connection DEGREE -- which is a property of the
 * relationship with whoever is signed in, not of the profile. Filing either
 * from the wrong session is the defect `confirmSeatAccount` exists to prevent.
 *
 * THE OTHER THREE NEVER NEEDED IT AND STILL DO NOT. The pending-invite list,
 * the withdrawal queue and a lead source read the account's OWN surfaces or
 * act on rows this workspace already owns. Confirming identity for a visit
 * that runs only those would be a profile load bought for nothing -- which is
 * exactly the class of page load this whole change is about.
 */
export const SIDE_TASKS_NEEDING_IDENTITY: ReadonlySet<SideTaskName> = new Set<SideTaskName>(['inbox', 'acceptance']);

/* ---------------------------------------------------------------------------
 * The visit
 * ------------------------------------------------------------------------ */

/**
 * How many times a day this account is opened at all.
 *
 * UNVERIFIED-VENDOR, and deliberately at the low end of what the operator
 * described: "1-2-3 times a day, maybe up to 5". Two to five bounds nothing
 * safety-critical -- the ceilings do that -- but it is the number that decides
 * whether the access graph looks like a person or a cron table.
 */
export const VISITS_PER_DAY = { min: 2, max: 5 } as const;

/** How long one visit lasts. "A few minutes, click here and there." */
export const VISIT_MINUTES = { min: 2, max: 5 } as const;

/**
 * The most jobs one visit may do.
 *
 * TWO, because a visit is two to five minutes long. Walking an inbox is
 * already most of that, and an account that reconciles its sent invitations,
 * opens profiles, drains a withdrawal queue AND harvests a lead source inside
 * one three-minute window is not somebody checking their messages -- it is a
 * batch job, which is what this stopped being.
 */
export const MAX_TASKS_PER_VISIT = 2;

/**
 * The least time that may pass before a job is worth doing again, in hours.
 *
 * NOT A SCHEDULE -- A FLOOR. Nothing runs because its floor elapsed; a visit
 * has to happen first, and then at most two of the eligible jobs are chosen.
 * The floor only stops a job being repeated in the next visit when there is
 * obviously nothing new to see.
 *
 * `inbox` is 0.7h so that consecutive visits -- which `visitsForDay`
 * guarantees are at least 40% of a slot apart -- each get to look at messages,
 * because looking at messages is what people open LinkedIn for. The rest are
 * housekeeping: reconciling a sent-invite list twice a day is already more
 * diligent than any real member.
 */
export const SIDE_TASK_MIN_HOURS: Record<SideTaskName, number> = {
  inbox: 0.7,
  pending_invites: 6,
  acceptance: 10,
  withdrawals: 20,
  lead_sources: 5
};

/** One opening of LinkedIn: local minutes after midnight, end exclusive. */
export interface Visit {
  /** 0-based, in the order they occur through the day. */
  index: number;
  startMinute: number;
  endMinute: number;
}

/**
 * mulberry32 over a sha256 of the seed. Copied, not imported, for the reason
 * `human.ts`, `driver-engage.ts` and `local-worker.ts` all record: `pacing.ts`
 * keeps it private, and widening a public surface to save four lines is the
 * worse trade.
 */
function seededRandom(seed: string): () => number {
  const digest = createHash('sha256').update(seed).digest('hex');
  let state = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The fraction of a slot a visit may start within, which is what guarantees the gap. */
const SLOT_HEAD = 0.6;

/**
 * When this seat opens LinkedIn on this day.
 *
 * ONE SLOT PER VISIT, AND THE START IS JITTERED INSIDE THE FIRST 60% OF IT.
 * Placing every visit anywhere in the window would let two of them land a
 * minute apart and then leave a nine-hour hole -- which is not "random", it is
 * clumped, and a clump of activity after a long silence is a worse signal than
 * a flat line. Confining each visit to its own slot spreads them; confining
 * the start to the head of the slot leaves at least 40% of a slot between
 * consecutive visits (about 48 minutes on a ten-hour day with five visits).
 *
 * Seeded on the seat and the date, so a day's shape is fixed for that seat and
 * that date rather than redrawn on every tick -- otherwise a visit would
 * flicker in and out of existence sixty seconds at a time.
 */
export function visitsForDay(
  seed: string,
  day: LocalDate,
  window: { startMinute: number; endMinute: number }
): Visit[] {
  const span = window.endMinute - window.startMinute;
  if (span <= VISIT_MINUTES.max) return [];

  const key = `${seed}:${day.year}-${day.month}-${day.day}`;
  const random = seededRandom(`visits:${key}`);
  const count = VISITS_PER_DAY.min + Math.floor(random() * (VISITS_PER_DAY.max - VISITS_PER_DAY.min + 1));
  const slot = span / count;

  const visits: Visit[] = [];
  for (let index = 0; index < count; index += 1) {
    const minutes = VISIT_MINUTES.min + random() * (VISIT_MINUTES.max - VISIT_MINUTES.min);
    const slotStart = window.startMinute + index * slot;
    // The head of the slot, less the visit's own length, so a visit never runs
    // past its slot and into the next one's gap.
    const headroom = Math.max(0, slot * SLOT_HEAD - minutes);
    const startMinute = Math.round(slotStart + random() * headroom);
    visits.push({
      index,
      startMinute,
      endMinute: Math.min(window.endMinute, Math.round(startMinute + minutes))
    });
  }
  return visits;
}

/* ---------------------------------------------------------------------------
 * Is a visit happening right now?
 * ------------------------------------------------------------------------ */

/** Structural, so this module needs neither the seat row's whole type nor `seats.ts`. */
export interface SideTaskSeat extends WorkWindowSeat {
  workspaceId: string;
  seatKey: string;
  timezone: string;
}

export interface VisitVerdict {
  /** The visit in progress, or null when LinkedIn is not open right now. */
  visit: Visit | null;
  /**
   * The instant this visit began, as a UTC `Date`. Null exactly when `visit` is.
   *
   * THE VISIT'S IDENTITY, and the reason it is here rather than derived by the
   * caller. A visit is two to five minutes and a tick is sixty seconds, so
   * every visit is seen by two to five consecutive ticks. Without a stable id
   * for "this visit", the second tick finds the first tick's jobs freshly
   * stamped, picks the next two off the list, warms up again and loads
   * `/in/me/` again -- and the cap of two per visit quietly becomes two per
   * MINUTE. Recording this instant is what makes one visit one pass.
   */
  startedAt: Date | null;
  /** Null exactly when `visit` is set. One sentence, for the worker log. */
  reason: string | null;
}

/**
 * The ledger key under which a completed visit is recorded.
 *
 * Not a `SideTaskName`: it names the pass rather than a job, and the column is
 * free text precisely so a row like this needs no migration.
 */
export const VISIT_MARKER = 'visit';

/**
 * Is this seat's human at LinkedIn at `now`, and in which of the day's visits?
 *
 * THE SAME DAY THE SENDER USES, drawn from the same `dayShapeFor`, so the reads
 * and the sends belong to one presence rather than two. A seat whose invites go
 * out 09:12-16:40 and whose inbox is polled at 04:00 is two different actors
 * sharing a cookie.
 */
export function visitAt(seat: SideTaskSeat, now: Date, options: { dayShape?: DayShapeFn } = {}): VisitVerdict {
  const shapeDay = options.dayShape ?? dayShapeFor;
  const window = workWindowOf(seat);
  const local = localDateOf(now, seat.timezone);
  const weekday = weekdayOf(local);
  const away = (reason: string): VisitVerdict => ({ visit: null, startedAt: null, reason });

  if (weekdayVolumeFactor(window, weekday) <= 0) {
    return away(`This seat does not work weekday ${weekday}, so LinkedIn was not opened.`);
  }

  const shape = shapeDay(`${seat.workspaceId}:${seat.seatKey}`, local, window);
  if (shape.resting) {
    return away(
      'This seat is away today -- about one working day in eight is left empty on purpose -- so LinkedIn was not opened.'
    );
  }

  const minuteOfDay = local.hour * 60 + local.minute;
  const visits = visitsForDay(`${seat.workspaceId}:${seat.seatKey}`, local, shape);
  const visit = visits.find((candidate) => minuteOfDay >= candidate.startMinute && minuteOfDay < candidate.endMinute);
  if (!visit) {
    return away(
      `It is ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} in ${seat.timezone}; this seat opens LinkedIn ${visits.length} time(s) today and none of them is now.`
    );
  }
  return { visit, startedAt: zonedToUtc(local, visit.startMinute * 60, seat.timezone), reason: null };
}

/* ---------------------------------------------------------------------------
 * The cadence ledger
 * ------------------------------------------------------------------------ */

/** Last run per task. Missing key means never, which means eligible. */
export type SideTaskRuns = Map<string, Date>;

export async function sideTaskRuns(db: Db, workspaceId: string, seatKey: string): Promise<SideTaskRuns> {
  const runs: SideTaskRuns = new Map();
  try {
    const rows = await db
      .prepare('SELECT task,last_run_at FROM linkedin_side_task_runs WHERE workspace_id=? AND seat_key=?')
      .all<{ task: string; last_run_at: string }>(workspaceId, seatKey);
    for (const row of rows) {
      const at = new Date(String(row.last_run_at));
      if (!Number.isNaN(at.getTime())) runs.set(String(row.task), at);
    }
  } catch {
    // An un-migrated database reads as "never run", which is the behaviour this
    // module replaced. It cannot be the reason a tick fails.
  }
  return runs;
}

export async function markSideTaskRun(
  db: Db,
  workspaceId: string,
  seatKey: string,
  task: SideTaskName | typeof VISIT_MARKER,
  at: Date
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO linkedin_side_task_runs (workspace_id,seat_key,task,last_run_at) VALUES (?,?,?,?)
         ON CONFLICT (workspace_id,seat_key,task) DO UPDATE SET last_run_at=EXCLUDED.last_run_at`
      )
      .run(workspaceId, seatKey, task, at.toISOString());
  } catch {
    // Same rule as the read. A cadence row that will not write means the task
    // is eligible in the next visit -- not that the visit runs more often.
  }
}

/**
 * What this visit does, at most two things, most-overdue first.
 *
 * PURE, and separate from the two database calls around it, because the whole
 * value of this module is in a decision that has to be assertable without a
 * browser, a Postgres or a clock.
 *
 * MARKED EVEN WHEN IT FINDS NOTHING. The caller stamps `last_run_at` after the
 * job returns, whatever it returned: "I looked and there was nothing" is a
 * completed look, and looking again in the next visit because the inbox was
 * empty is the loop this exists to end.
 */
export function dueSideTasks(
  seat: SideTaskSeat,
  runs: SideTaskRuns,
  now: Date,
  options: { tasks?: readonly SideTaskName[]; limit?: number } = {}
): SideTaskName[] {
  const limit = Math.max(1, Math.trunc(options.limit ?? MAX_TASKS_PER_VISIT));
  const overdue: Array<{ task: SideTaskName; by: number }> = [];

  for (const task of options.tasks ?? SIDE_TASK_NAMES) {
    const floorMs = SIDE_TASK_MIN_HOURS[task] * 3_600_000;
    const last = runs.get(task);
    if (!last) {
      overdue.push({ task, by: Number.POSITIVE_INFINITY });
      continue;
    }
    const elapsed = now.getTime() - last.getTime();
    // A clock that went backwards (a VM resume, an NTP correction) must not
    // make everything eligible at once; it is treated as "just ran".
    if (elapsed < 0) continue;
    if (elapsed >= floorMs) overdue.push({ task, by: elapsed - floorMs });
  }

  // MOST OVERDUE FIRST, so the two chosen are the two that have waited longest
  // rather than the two that happen to be first in the list -- otherwise a
  // cap of two would mean the last three jobs never ran at all.
  overdue.sort((left, right) => right.by - left.by);
  return overdue.slice(0, limit).map((entry) => entry.task);
}
