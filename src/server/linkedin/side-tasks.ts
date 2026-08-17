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

import type { Db } from '../db.js';
import {
  VISITS_PER_DAY,
  VISIT_MINUTES,
  addLocalDays,
  dayShapeFor,
  localDateOf,
  visitsForDay,
  weekdayOf,
  weekdayVolumeFactor,
  workWindowOf,
  zonedToUtc,
  type DayShapeFn,
  type Visit,
  type WorkWindowSeat
} from './pacing.js';
export { VISITS_PER_DAY, VISIT_MINUTES, visitsForDay, type Visit };

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
 *
 * `visitsForDay` LIVES IN `pacing.ts`, not here, and that is not a filing
 * decision. The planner has to place its sends inside the same visits this
 * module reads inside -- that is what "one presence" means -- and `pacing.ts`
 * is what `guard.ts`, `planPacing` and this module all already depend on.
 * Putting the schedule there keeps the dependency in one direction; putting it
 * here would make the planner import the inbox reader.
 * ------------------------------------------------------------------------ */

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

/**
 * THE SAME LEDGER, IN THIS PROCESS, AND IT IS NOT AN OPTIMISATION.
 *
 * Both functions below swallow their errors, because a cadence row must never
 * be the reason a worker tick dies. On an UN-MIGRATED database that swallow
 * used to make things WORSE THAN BEFORE THE CADENCE EXISTED: the read returned
 * "never run", the write vanished, and so every tick inside a visit was a
 * fresh pass -- warming up, loading `/in/me/`, running two more jobs, sixty
 * seconds apart. The cap of two per VISIT silently became two per MINUTE.
 *
 * A missing table is not exotic. It is exactly the state of every deployment
 * between `git pull` and the next container restart, which is the window in
 * which somebody is most likely to be watching.
 *
 * So the Map is the floor. It is per-process and forgotten on restart -- which
 * is fine, because forgetting means the next visit runs, not that visits run
 * more often -- and the moment the column is there the column wins, since it
 * is the one a second worker can also see.
 *
 * lc-debt: per-process, so a fleet of workers on an un-migrated database would
 * each hold their own; upgrade path is running the migration, which is the
 * point.
 */
const localRuns = new Map<string, Date>();

function localKey(workspaceId: string, seatKey: string, task: string): string {
  return `${workspaceId} ${seatKey} ${task}`;
}

/** Forget every in-process cadence row. Tests only; a worker never wants this. */
export function resetSideTaskRuns(): void {
  localRuns.clear();
}

export async function sideTaskRuns(db: Db, workspaceId: string, seatKey: string): Promise<SideTaskRuns> {
  const runs: SideTaskRuns = new Map();
  // The in-process floor first, so a database that cannot answer still bounds
  // the visit. Anything the column knows overwrites it below.
  const prefix = `${workspaceId} ${seatKey} `;
  for (const [key, at] of localRuns) {
    if (key.startsWith(prefix)) runs.set(key.slice(prefix.length), at);
  }
  try {
    const rows = await db
      .prepare('SELECT task,last_run_at FROM linkedin_side_task_runs WHERE workspace_id=? AND seat_key=?')
      .all<{ task: string; last_run_at: string }>(workspaceId, seatKey);
    for (const row of rows) {
      const at = new Date(String(row.last_run_at));
      if (!Number.isNaN(at.getTime())) runs.set(String(row.task), at);
    }
  } catch {
    // Un-migrated, mid-deploy, or a pool closed at shutdown. The Map above is
    // what stops that becoming a tighter loop than the one this replaced.
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
  // WRITTEN TO MEMORY FIRST AND UNCONDITIONALLY. If the column write throws,
  // this is the only record that the visit happened -- and it is the record
  // that keeps the next tick from repeating it.
  localRuns.set(localKey(workspaceId, seatKey, task), at);
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

export interface SideTaskOpportunity {
  /** The deterministic LinkedIn visit window in which this task is expected. */
  startAt: Date;
  endAt: Date;
  visitIndex: number;
}

/**
 * Future LinkedIn visit windows for one seat, regardless of whether the visit
 * ends up sending, reading, or doing both. A visit already stamped in the
 * cadence ledger is skipped, and a visit whose end is in the past is never
 * replayed after a sleeping laptop wakes up.
 */
export function nextVisitOpportunities(
  seat: SideTaskSeat,
  runs: SideTaskRuns,
  now: Date,
  count = 1,
  options: { dayShape?: DayShapeFn; horizonDays?: number } = {}
): SideTaskOpportunity[] {
  const wanted = Math.max(1, Math.min(50, Math.trunc(count)));
  const horizonDays = Math.max(1, Math.min(31, Math.trunc(options.horizonDays ?? 14)));
  const shapeDay = options.dayShape ?? dayShapeFor;
  const window = workWindowOf(seat);
  const localToday = localDateOf(now, seat.timezone);
  const seed = `${seat.workspaceId}:${seat.seatKey}`;
  const opportunities: SideTaskOpportunity[] = [];

  for (let offset = 0; offset < horizonDays && opportunities.length < wanted; offset += 1) {
    const day = addLocalDays(localToday, offset);
    if (weekdayVolumeFactor(window, weekdayOf(day)) <= 0) continue;
    const shape = shapeDay(seed, day, window);
    if (shape.resting) continue;

    for (const visit of visitsForDay(seed, day, shape)) {
      const startAt = zonedToUtc(day, visit.startMinute * 60, seat.timezone);
      const endAt = zonedToUtc(day, visit.endMinute * 60, seat.timezone);
      if (endAt.getTime() <= now.getTime()) continue;
      if (runs.get(VISIT_MARKER)?.getTime() === startAt.getTime()) continue;
      opportunities.push({ startAt, endAt, visitIndex: visit.index });
      if (opportunities.length >= wanted) break;
    }
  }
  return opportunities;
}

/**
 * Future visit windows in which one side task is expected to be selected.
 *
 * This is the read-only mirror of the worker's scheduling decision. It advances
 * the same cadence map as `runLinkedInSideTasks`, so an operator can see WHEN a
 * queued read is expected without creating a second scheduler in the client.
 * Past visits are deliberately ignored: a laptop that slept through 10:22 does
 * not replay 10:22 at wake-up; the answer becomes the next normal visit.
 */
export function nextSideTaskOpportunities(
  seat: SideTaskSeat,
  runs: SideTaskRuns,
  task: SideTaskName,
  now: Date,
  count = 1,
  options: { dayShape?: DayShapeFn; horizonDays?: number } = {}
): SideTaskOpportunity[] {
  const wanted = Math.max(1, Math.min(50, Math.trunc(count)));
  const horizonDays = Math.max(1, Math.min(31, Math.trunc(options.horizonDays ?? 14)));
  const shapeDay = options.dayShape ?? dayShapeFor;
  const window = workWindowOf(seat);
  const localToday = localDateOf(now, seat.timezone);
  const simulated = new Map(runs);
  const seed = `${seat.workspaceId}:${seat.seatKey}`;
  const opportunities: SideTaskOpportunity[] = [];

  for (let offset = 0; offset < horizonDays && opportunities.length < wanted; offset += 1) {
    const day = addLocalDays(localToday, offset);
    if (weekdayVolumeFactor(window, weekdayOf(day)) <= 0) continue;
    const shape = shapeDay(seed, day, window);
    if (shape.resting) continue;

    for (const visit of visitsForDay(seed, day, shape)) {
      const startAt = zonedToUtc(day, visit.startMinute * 60, seat.timezone);
      const endAt = zonedToUtc(day, visit.endMinute * 60, seat.timezone);
      if (endAt.getTime() <= now.getTime()) continue;
      if (simulated.get(VISIT_MARKER)?.getTime() === startAt.getTime()) continue;

      // If the browser reconnects during a visit, the next worker tick may use
      // the remainder of that visit. Otherwise the visit's start is the
      // scheduling instant. Either way, never manufacture a missed tick.
      const decisionAt = new Date(Math.max(now.getTime(), startAt.getTime()));
      const due = dueSideTasks(seat, simulated, decisionAt);
      simulated.set(VISIT_MARKER, startAt);
      for (const selected of due) simulated.set(selected, decisionAt);

      if (due.includes(task)) {
        opportunities.push({ startAt, endAt, visitIndex: visit.index });
        if (opportunities.length >= wanted) break;
      }
    }
  }
  return opportunities;
}
