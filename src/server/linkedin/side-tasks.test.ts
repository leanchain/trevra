import { describe, expect, it } from 'vitest';
import { FLAT_DAY_SHAPE, type DayShapeFn } from './pacing.js';
import {
  SIDE_TASK_INTERVAL_MINUTES,
  SIDE_TASK_NAMES,
  dueSideTasks,
  nextSideTaskDelayMs,
  seatPresence,
  sideTaskIntervalMs,
  type SideTaskName,
  type SideTaskRuns,
  type SideTaskSeat
} from './side-tasks.js';

/**
 * THE CADENCE, WHICH IS THE WHOLE FIX.
 *
 * Every assertion here is about NOT going to LinkedIn. The jobs themselves were
 * never wrong -- they read an inbox, they reconcile a list -- and the account
 * was restricted anyway, because all five of them ran every sixty seconds
 * around the clock whether or not there was anything to read.
 */

/** Mon-Fri 08:00-18:00 in a zone with no DST surprises during the test dates. */
const SEAT: SideTaskSeat = {
  workspaceId: 'ws_side_tasks',
  seatKey: 'owner',
  timezone: 'UTC',
  workingDays: [1, 2, 3, 4, 5],
  workStartMinute: 8 * 60,
  workEndMinute: 18 * 60
};

/** Tuesday, 10:00 UTC -- inside any plausible drawn window. */
const MIDDAY = new Date('2026-08-04T10:00:00.000Z');

const RESTING: DayShapeFn = (_seed, _day, window) => ({
  startMinute: window.startMinute,
  endMinute: window.endMinute,
  resting: true,
  draw: 1
});

describe('sideTaskIntervalMs', () => {
  it('draws inside the band for every task', () => {
    for (const task of SIDE_TASK_NAMES) {
      const band = SIDE_TASK_INTERVAL_MINUTES[task];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const drawn = sideTaskIntervalMs(task, `seed-${attempt}`);
        expect(drawn).toBeGreaterThanOrEqual(band.min * 60_000);
        expect(drawn).toBeLessThanOrEqual(band.max * 60_000);
      }
    }
  });

  it('is a band and not a constant -- a fixed gap is a cron entry wearing a hat', () => {
    const drawn = new Set(Array.from({ length: 40 }, (_, index) => sideTaskIntervalMs('inbox', `run-${index}`)));
    expect(drawn.size).toBeGreaterThan(20);
  });

  it('is reproducible from the same seed', () => {
    expect(sideTaskIntervalMs('inbox', 'x')).toBe(sideTaskIntervalMs('inbox', 'x'));
  });

  it('reads the inbox far more often than it opens profiles', () => {
    expect(SIDE_TASK_INTERVAL_MINUTES.inbox.max).toBeLessThan(SIDE_TASK_INTERVAL_MINUTES.acceptance.min);
  });
});

describe('dueSideTasks', () => {
  it('runs everything that has never run', () => {
    expect(dueSideTasks(SEAT, new Map(), MIDDAY).sort()).toEqual([...SIDE_TASK_NAMES].sort());
  });

  it('runs nothing a minute after everything ran -- the 60s tick is the defect', () => {
    const runs: SideTaskRuns = new Map(SIDE_TASK_NAMES.map((task) => [task as string, MIDDAY] as const));
    const aMinuteLater = new Date(MIDDAY.getTime() + 60_000);
    expect(dueSideTasks(SEAT, runs, aMinuteLater)).toEqual([]);
  });

  it('runs a task once its own drawn interval has elapsed, and not before', () => {
    const last = MIDDAY;
    const runs: SideTaskRuns = new Map([['inbox', last]]);
    const interval = nextSideTaskDelayMs(SEAT, 'inbox', last);
    const tasks: readonly SideTaskName[] = ['inbox'];

    expect(dueSideTasks(SEAT, runs, new Date(last.getTime() + interval - 1), { tasks })).toEqual([]);
    expect(dueSideTasks(SEAT, runs, new Date(last.getTime() + interval), { tasks })).toEqual(['inbox']);
  });

  it('gives two seats different intervals from the same instant, so they never open in lockstep', () => {
    const other: SideTaskSeat = { ...SEAT, seatKey: 'sales' };
    expect(nextSideTaskDelayMs(SEAT, 'inbox', MIDDAY)).not.toBe(nextSideTaskDelayMs(other, 'inbox', MIDDAY));
  });

  it('treats a backwards clock as "just ran" rather than making everything due', () => {
    const runs: SideTaskRuns = new Map([['inbox', new Date(MIDDAY.getTime() + 3_600_000)]]);
    expect(dueSideTasks(SEAT, runs, MIDDAY, { tasks: ['inbox'] })).toEqual([]);
  });
});

describe('seatPresence', () => {
  it('is present inside the seat\'s own working window', () => {
    expect(seatPresence(SEAT, MIDDAY, { dayShape: FLAT_DAY_SHAPE })).toEqual({ present: true, reason: null });
  });

  it('is absent at 03:00 -- nobody reads their LinkedIn inbox at three in the morning', () => {
    const night = new Date('2026-08-04T03:00:00.000Z');
    const verdict = seatPresence(SEAT, night, { dayShape: FLAT_DAY_SHAPE });
    expect(verdict.present).toBe(false);
    expect(verdict.reason).toContain('03:00');
  });

  it('is absent on a weekday this seat does not work', () => {
    const sunday = new Date('2026-08-02T10:00:00.000Z');
    const verdict = seatPresence(SEAT, sunday, { dayShape: FLAT_DAY_SHAPE });
    expect(verdict.present).toBe(false);
    expect(verdict.reason).toContain('weekday 0');
  });

  it('is absent on a drawn rest day, exactly as the sender is', () => {
    const verdict = seatPresence(SEAT, MIDDAY, { dayShape: RESTING });
    expect(verdict.present).toBe(false);
    expect(verdict.reason).toContain('away today');
  });

  it('reads the seat\'s configured window, not a hardcoded one', () => {
    const nightShift: SideTaskSeat = { ...SEAT, workStartMinute: 22 * 60, workEndMinute: 23 * 60 };
    expect(seatPresence(nightShift, MIDDAY, { dayShape: FLAT_DAY_SHAPE }).present).toBe(false);
    expect(
      seatPresence(nightShift, new Date('2026-08-04T22:30:00.000Z'), { dayShape: FLAT_DAY_SHAPE }).present
    ).toBe(true);
  });
});
