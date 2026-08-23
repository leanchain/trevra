import { describe, expect, it } from 'vitest';
import { FLAT_DAY_SHAPE, type DayShapeFn } from './pacing.js';
import {
  MAX_TASKS_PER_VISIT,
  SIDE_TASK_MIN_HOURS,
  SIDE_TASK_NAMES,
  VISITS_PER_DAY,
  VISIT_MINUTES,
  dueSideTasks,
  nextSideTaskOpportunities,
  nextVisitOpportunities,
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
    const at = new Date(
      `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`
    );
    if (visitAt(seat, at, { dayShape: FLAT_DAY_SHAPE }).visit) open.push(minute);
  }
  return open;
}

describe('visitsForDay', () => {
  it('uses exactly one operator-configured execution window per working day', () => {
    for (let day = 1; day <= 28; day += 1) {
      const visits = visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW);
      expect(visits).toHaveLength(1);
      expect(visits.length).toBe(VISITS_PER_DAY.max);
    }
  });

  it('matches the configured working window exactly', () => {
    for (let day = 1; day <= 28; day += 1) {
      const [visit] = visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW);
      expect(visit.startMinute).toBe(WINDOW.startMinute);
      expect(visit.endMinute).toBe(WINDOW.endMinute);
      expect(visit.endMinute - visit.startMinute).toBe(WINDOW.endMinute - WINDOW.startMinute);
    }
    expect(VISIT_MINUTES).toEqual({ min: 0, max: 0 });
  });

  it('spreads them out -- a clump after a long silence is worse than a flat line', () => {
    for (let day = 1; day <= 28; day += 1) {
      const visits = visitsForDay('ws:owner', { year: 2026, month: 9, day }, WINDOW);
      for (let index = 1; index < visits.length; index += 1) {
        const gap =
          (visits[index] as { startMinute: number }).startMinute -
          (visits[index - 1] as { endMinute: number }).endMinute;
        expect(gap).toBeGreaterThan(40);
      }
    }
  });

  it('is fixed for a seat and a date, so a visit does not flicker tick to tick', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).toEqual(
      visitsForDay('ws:owner', TUESDAY, WINDOW)
    );
  });

  it('does not alter the operator window by seat identity', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).toEqual(
      visitsForDay('ws:sales', TUESDAY, WINDOW)
    );
  });

  it('does not alter the operator window by calendar date', () => {
    expect(visitsForDay('ws:owner', TUESDAY, WINDOW)).toEqual(
      visitsForDay('ws:owner', { ...TUESDAY, day: 5 }, WINDOW)
    );
  });
});

describe('visitAt', () => {
  it('is eligible throughout the configured working window', () => {
    const open = minutesOpen(SEAT, '2026-08-04');
    expect(open.length).toBe(SEAT.workEndMinute - SEAT.workStartMinute);
    expect(open[0]).toBe(SEAT.workStartMinute);
    expect(open.at(-1)).toBe(SEAT.workEndMinute - 1);
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

  it("reads the seat's configured window, not a hardcoded one", () => {
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

  it('keeps all account polling out; withdrawals are only an explicit queued-work executor', () => {
    expect(SIDE_TASK_NAMES).toEqual(['withdrawals']);
    const runs: SideTaskRuns = new Map([
      ['inbox', NOW],
      ['pending_invites', NOW],
      ['acceptance', new Date(NOW.getTime() - 30 * 3_600_000)],
      ['withdrawals', new Date(NOW.getTime() - 40 * 3_600_000)],
      ['lead_sources', new Date(NOW.getTime() - 40 * 3_600_000)]
    ]);
    const selected = dueSideTasks(SEAT, runs, NOW);
    expect(selected).not.toContain('acceptance');
    expect(selected).toContain('withdrawals');
    expect(selected).not.toContain('lead_sources');
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

  it('does not advertise a background schedule for operator-only harvesting', () => {
    const now = new Date('2026-08-04T07:00:00.000Z');
    expect(
      nextSideTaskOpportunities(SEAT, new Map(), 'lead_sources', now, 1, {
        dayShape: FLAT_DAY_SHAPE
      })
    ).toEqual([]);
  });

  it('exposes the next overall LinkedIn visit and skips a visit already stamped as run', () => {
    const now = new Date('2026-08-04T07:00:00.000Z');
    const visits = visitsForDay('ws_side_tasks:owner', TUESDAY, WINDOW);
    const first = visits[0]!;
    const firstStart = new Date(Date.UTC(2026, 7, 4, 0, first.startMinute));
    expect(
      nextVisitOpportunities(SEAT, new Map(), now, 1, {
        dayShape: FLAT_DAY_SHAPE
      })[0]?.startAt.toISOString()
    ).toBe(firstStart.toISOString());

    const runs: SideTaskRuns = new Map([['visit', firstStart]]);
    const [next] = nextVisitOpportunities(SEAT, runs, now, 1, { dayShape: FLAT_DAY_SHAPE });
    expect(next?.startAt.getTime()).toBeGreaterThan(firstStart.getTime());
  });

  it('advertises no background schedule for operator-only account polling', () => {
    const now = new Date('2026-08-04T19:00:00.000Z');
    expect(
      nextSideTaskOpportunities(SEAT, new Map(), 'inbox', now, 1, {
        dayShape: FLAT_DAY_SHAPE
      })
    ).toEqual([]);
    expect(
      nextSideTaskOpportunities(SEAT, new Map(), 'pending_invites', now, 1, {
        dayShape: FLAT_DAY_SHAPE
      })
    ).toEqual([]);
    expect(
      nextSideTaskOpportunities(SEAT, new Map(), 'lead_sources', now, 1, {
        dayShape: FLAT_DAY_SHAPE
      })
    ).toEqual([]);
  });

  it('treats a backwards clock as "just ran" rather than making everything eligible', () => {
    const runs: SideTaskRuns = new Map([['inbox', new Date(NOW.getTime() + 3_600_000)]]);
    expect(dueSideTasks(SEAT, runs, NOW, { tasks: ['inbox'] })).toEqual([]);
  });

  it('reads the inbox far more readily than it opens profiles', () => {
    expect(SIDE_TASK_MIN_HOURS.inbox).toBeLessThan(SIDE_TASK_MIN_HOURS.acceptance);
  });
});
