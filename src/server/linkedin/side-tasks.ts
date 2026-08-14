/**
 * HOW OFTEN THE BROWSER IS ALLOWED TO GO AND LOOK, which until now was
 * "every sixty seconds, forever, including at 03:00".
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
 * No invite was sent. No message went out. The account was still restricted
 * for "accessing an unusually large amount of LinkedIn profile data over
 * time", and this is what was doing it.
 *
 * TWO GATES, AND THEY ANSWER DIFFERENT QUESTIONS:
 *
 *   1. IS IT DUE -- has enough time passed since this task last ran? The
 *      interval is DRAWN from a band rather than fixed, because a job that
 *      fires exactly every 30 minutes is a cron entry wearing a person's
 *      clothes. Seeded on the previous run instant, so the cadence is
 *      unpredictable to LinkedIn and reproducible from the ledger for us.
 *   2. WOULD A PERSON BE THERE -- is it inside this seat's own working window
 *      on a day this seat works, and is the seat not mid-break? A founder does
 *      not read their LinkedIn inbox at four in the morning, and a client that
 *      is present every minute of every day has no shape at all.
 *
 * BOTH ARE ANSWERED BEFORE A BROWSER OPENS. That is the whole point: the
 * refusals that already existed inside each job were all correct and all came
 * after Chrome had launched, signed in, and talked to LinkedIn from this
 * machine's IP.
 *
 * NOTHING HERE THROWS. Every caller is a worker tick on its way somewhere
 * else; an unreadable cadence row means "due", because the intervals are a
 * politeness and the safety gate is elsewhere.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../db.js';
import {
  dayShapeFor,
  localDateOf,
  weekdayOf,
  weekdayVolumeFactor,
  workWindowOf,
  type DayShapeFn,
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
 * How long between two runs of one task, in minutes, as a BAND.
 *
 * UNVERIFIED-VENDOR, every number: these are judgements about how often a
 * person opens each surface, not published limits. They bound nothing
 * safety-critical -- the ceilings and the gate do that -- so being wrong here
 * costs plausibility rather than an account. What matters is the order of
 * magnitude, and the order of magnitude was wrong by three:
 *
 *   inbox            22-55m   -- a founder checks messages several times a day.
 *   pending_invites   3-7h    -- reconciling the sent list is a weekly habit at
 *                               most; twice a day is already generous.
 *   acceptance        5-9h    -- this one OPENS PROFILES, which is precisely the
 *                               data LinkedIn counted. The slowest of the reads.
 *   withdrawals      11-18h   -- the sweep is about invites 21+ days old. Once a
 *                               day cannot be late.
 *   lead_sources    1.5-4h    -- harvesting is the loudest thing here and the
 *                               only one that is off by default.
 */
export const SIDE_TASK_INTERVAL_MINUTES: Record<SideTaskName, { min: number; max: number }> = {
  inbox: { min: 22, max: 55 },
  pending_invites: { min: 3 * 60, max: 7 * 60 },
  acceptance: { min: 5 * 60, max: 9 * 60 },
  withdrawals: { min: 11 * 60, max: 18 * 60 },
  lead_sources: { min: 90, max: 240 }
};

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

/**
 * This task's next gap, in milliseconds.
 *
 * SEEDED ON THE PREVIOUS RUN, not on the day: a per-day seed would draw one
 * number and then repeat it all day, which is a metronome with a longer beat.
 * Seeding on the last run instant redraws every time and stays reproducible --
 * the same ledger produces the same cadence.
 */
export function sideTaskIntervalMs(task: SideTaskName, seed: string): number {
  const band = SIDE_TASK_INTERVAL_MINUTES[task];
  const random = seededRandom(`side-task:${task}:${seed}`);
  return Math.round((band.min + random() * (band.max - band.min)) * 60_000);
}

/* ---------------------------------------------------------------------------
 * Would a person be at the keyboard?
 * ------------------------------------------------------------------------ */

/** Structural, so this module needs neither the seat row's whole type nor `seats.ts`. */
export interface SideTaskSeat extends WorkWindowSeat {
  workspaceId: string;
  seatKey: string;
  timezone: string;
}

export interface PresenceVerdict {
  /** True when a person plausibly has LinkedIn open right now. */
  present: boolean;
  /** Null exactly when `present`. One sentence, for the worker log. */
  reason: string | null;
}

/**
 * Is this seat's human plausibly at LinkedIn at `now`?
 *
 * THE SAME WINDOW THE SENDER USES, drawn from the same `dayShapeFor`, so the
 * reads and the sends belong to one presence rather than two. A seat whose
 * invites go out 09:12-16:40 and whose inbox is polled at 04:00 is two
 * different actors sharing a cookie.
 */
export function seatPresence(
  seat: SideTaskSeat,
  now: Date,
  options: { dayShape?: DayShapeFn } = {}
): PresenceVerdict {
  const shapeDay = options.dayShape ?? dayShapeFor;
  const window = workWindowOf(seat);
  const local = localDateOf(now, seat.timezone);
  const weekday = weekdayOf(local);

  if (weekdayVolumeFactor(window, weekday) <= 0) {
    return { present: false, reason: `This seat does not work weekday ${weekday}, so nothing was read.` };
  }

  const shape = shapeDay(`${seat.workspaceId}:${seat.seatKey}`, local, window);
  if (shape.resting) {
    return { present: false, reason: 'This seat is away today -- about one working day in eight is left empty on purpose -- so nothing was read.' };
  }

  const minuteOfDay = local.hour * 60 + local.minute;
  if (minuteOfDay < shape.startMinute || minuteOfDay >= shape.endMinute) {
    return {
      present: false,
      reason: `It is ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} in ${seat.timezone}, outside this seat's day, so nothing was read.`
    };
  }
  return { present: true, reason: null };
}

/* ---------------------------------------------------------------------------
 * The cadence ledger
 * ------------------------------------------------------------------------ */

/** Last run per task. Missing key means never, which means due. */
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
  task: SideTaskName,
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
    // runs again next tick -- the old behaviour, not a worse one.
  }
}

/**
 * Which of the five may run now.
 *
 * PURE, and separate from the two database calls around it, because the whole
 * value of this module is in a decision that has to be assertable without a
 * browser, a Postgres or a clock.
 *
 * MARKED EVEN WHEN IT FINDS NOTHING. The caller stamps `last_run_at` after the
 * job returns, whatever it returned: "I looked and there was nothing" is a
 * completed look, and re-looking in sixty seconds because the inbox was empty
 * is the exact loop this exists to end.
 */
export function dueSideTasks(
  seat: SideTaskSeat,
  runs: SideTaskRuns,
  now: Date,
  options: { tasks?: readonly SideTaskName[] } = {}
): SideTaskName[] {
  const due: SideTaskName[] = [];
  for (const task of options.tasks ?? SIDE_TASK_NAMES) {
    const last = runs.get(task);
    if (!last) {
      due.push(task);
      continue;
    }
    const elapsed = now.getTime() - last.getTime();
    // A clock that went backwards (a VM resume, an NTP correction) must not
    // make everything due at once; it is treated as "just ran".
    if (elapsed < 0) continue;
    if (elapsed >= nextSideTaskDelayMs(seat, task, last)) due.push(task);
  }
  return due;
}

/**
 * The gap this seat waits after `last` before running `task` again.
 *
 * THE SEAT IS IN THE SEED, and that is the whole reason `dueSideTasks` takes a
 * seat at all. Two accounts driven by one worker that were last read in the
 * same second would otherwise draw the SAME interval and come due together,
 * forever -- two browsers opening in lockstep, from one IP, for the life of the
 * deployment. Keyed on the seat, they drift apart on the first draw and never
 * re-align.
 */
export function nextSideTaskDelayMs(seat: SideTaskSeat, task: SideTaskName, last: Date): number {
  return sideTaskIntervalMs(task, `${seat.workspaceId}:${seat.seatKey}:${last.toISOString()}`);
}
