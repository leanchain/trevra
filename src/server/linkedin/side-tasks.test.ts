import { describe, expect, it } from 'vitest';
import { FLAT_DAY_SHAPE, type DayShapeFn } from './pacing.js';
import {
  MAX_TASKS_PER_VISIT,
  SIDE_TASK_MIN_HOURS,
  SIDE_TASK_NAMES,
  VISITS_PER_DAY,
  VISIT_MINUTES,
  dueSideTasks,
  visitAt,
  visitsForDay,
  type SideTaskRuns,
  type SideTaskSeat
} from './side-tasks.js';

/**
 * THE VISIT MODEL, WHICH IS THE WHOLE FIX.
 *
 * Every assertion here is about NOT being at LinkedIn. The jobs themselves were
 * never wrong -- they read an inbox, they reconcile a list -- and the account
 * was restricted anyway, because all five ran every sixty seconds around the
 * clock whether or not there was anything to read. A per-task interval was the
 * first attempt and was still a polling loop; this is 2-5 openings a day of
 * 2-5 minutes each, which is what the operator actually does.
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

/** Tuesday. */
const TUESDAY = { year: 2026, month: 8, day: 4 };
const WINDOW = { startMinute: 8 * 60, endMinute: 18 * 60 };

const RESTING: DayShapeFn = (_seed, _day, window) => ({
  startMinute: window.startMinute,
  endMinute: window.endMinute,
  resting: true,
  draw: 1
});

/** Every minute of a working day, and whether LinkedIn is open at it. */
function minutesOpen(seat: SideTaskSeat, date: string): number[] {
  const open: number[] = [];
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const at = new Date(`${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`);
    if (visitAt(seat, at, { dayShape: FLAT_DAY_SHAPE }).visit) open.push(minute);
  }
  return open;
}

describe('visitsForDay', () => {
  it('opens LinkedIn between two and five times', () => {
    for (let day = 1; day <= 28; day += 1) {
      const visits = visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW);
      expect(visits.length).toBeGreaterThanOrEqual(VISITS_PER_DAY.min);
      expect(visits.length).toBeLessThanOrEqual(VISITS_PER_DAY.max);
    }
  });

  it('keeps every visit to a few minutes, inside the working window', () => {
    for (let day = 1; day <= 28; day += 1) {
      for (const visit of visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW)) {
        const minutes = visit.endMinute - visit.startMinute;
        expect(minutes).toBeGreaterThanOrEqual(VISIT_MINUTES.min - 1);
        expect(minutes).toBeLessThanOrEqual(VISIT_MINUTES.max);
        expect(visit.startMinute).toBeGreaterThanOrEqual(WINDOW.startMinute);
        expect(visit.endMinute).toBeLessThanOrEqual(WINDOW.endMinute);
      }
    }
  });

  it('spreads them out -- a clump after a long silence is worse than a flat line', () => {
    for (let day = 1; day <= 28; day += 1) {
      const visits = visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW);
      for (let index = 1; index < visits.length; index += 1) {
        const gap = (visits[index] as { startMinute: number }).startMinute
          - (visits[index - 1] as { endMinute: number }).endMinute;
        expect(gap).toBeGreaterThan(40);
      }
    }
  });

  it('is fixed for a seat and a date, so a visit does not flicker tick to tick', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).toEqual(visitsForDay('ws:owner', TUESDAY, WINDOW));
  });

  it('gives two seats different days, so two accounts never open in lockstep', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).not.toEqual(visitsForDay('ws:sales', TUESDAY, WINDOW));
  });

  it('gives one seat a different shape tomorrow', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).not.toEqual(
      visitsForDay('ws:owner', { ...TUESDAY, day: 5 }, WINDOW)
    );
  });
});

describe('visitAt', () => {
  it('is open for only a handful of minutes on a working day', () => {
    const open = minutesOpen(SEAT, '2026-08-04');
    expect(open.length).toBeGreaterThan(0);
    // Five visits of five minutes is the ceiling; anything more is a session
    // that never ends, which is the shape this replaced.
    expect(open.length).toBeLessThanOrEqual(VISITS_PER_DAY.max * VISIT_MINUTES.max);
  });

  it('is never open at 03:00', () => {
    const night = new Date('2026-08-04T03:00:00.000Z');
    const verdict = visitAt(SEAT, night, { dayShape: FLAT_DAY_SHAPE });
    expect(verdict.visit).toBeNull();
    expect(verdict.reason).toContain('03:00');
  });

  it('is never open on a weekday this seat does not work', () => {
    expect(minutesOpen(SEAT, '2026-08-02')).toEqual([]);
  });

  it('is never open on a drawn rest day, exactly as the sender is', () => {
    const verdict = visitAt(SEAT, new Date('2026-08-04T10:00:00.000Z'), { dayShape: RESTING });
    expect(verdict.visit).toBeNull();
    expect(verdict.reason).toContain('away today');
  });

  it('reads the seat\'s configured window, not a hardcoded one', () => {
    const nightShift: SideTaskSeat = { ...SEAT, workStartMinute: 20 * 60, workEndMinute: 23 * 60 };
    for (const minute of minutesOpen(nightShift, '2026-08-04')) {
      expect(minute).toBeGreaterThanOrEqual(20 * 60);
      expect(minute).toBeLessThan(23 * 60);
    }
  });
});

describe('dueSideTasks', () => {
  const NOW = new Date('2026-08-04T10:00:00.000Z');

  it('never does more than a couple of things in one visit', () => {
    expect(dueSideTasks(SEAT, new Map(), NOW)).toHaveLength(MAX_TASKS_PER_VISIT);
  });

  it('picks the most overdue, so a cap of two does not starve the last three', () => {
    const runs: SideTaskRuns = new Map(
      SIDE_TASK_NAMES.map((task) => [task as string, new Date(NOW.getTime() - 60_000)] as const)
    );
    // Only these two have been waiting past their floor.
    runs.set('withdrawals', new Date(NOW.getTime() - 40 * 3_600_000));
    runs.set('acceptance', new Date(NOW.getTime() - 30 * 3_600_000));
    expect(dueSideTasks(SEAT, runs, NOW).sort()).toEqual(['acceptance', 'withdrawals']);
  });

  it('does nothing when the visit has nothing stale to look at', () => {
    const runs: SideTaskRuns = new Map(
      SIDE_TASK_NAMES.map((task) => [task as string, new Date(NOW.getTime() - 60_000)] as const)
    );
    expect(dueSideTasks(SEAT, runs, NOW)).toEqual([]);
  });

  it('lets the next visit look at messages again, but not the same minute', () => {
    const runs: SideTaskRuns = new Map([['inbox', NOW]]);
    const tasks = ['inbox'] as const;
    const floor = SIDE_TASK_MIN_HOURS.inbox * 3_600_000;
    expect(dueSideTasks(SEAT, runs, new Date(NOW.getTime() + floor - 1), { tasks })).toEqual([]);
    expect(dueSideTasks(SEAT, runs, new Date(NOW.getTime() + floor), { tasks })).toEqual(['inbox']);
  });

  it('treats a backwards clock as "just ran" rather than making everything eligible', () => {
    const runs: SideTaskRuns = new Map([['inbox', new Date(NOW.getTime() + 3_600_000)]]);
    expect(dueSideTasks(SEAT, runs, NOW, { tasks: ['inbox'] })).toEqual([]);
  });

  it('reads the inbox far more readily than it opens profiles', () => {
    expect(SIDE_TASK_MIN_HOURS.inbox).toBeLessThan(SIDE_TASK_MIN_HOURS.acceptance);
  });
});
