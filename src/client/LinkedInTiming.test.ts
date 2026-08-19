import { describe, expect, it } from 'vitest';
import { plannedForFrom } from './LinkedInTiming';

/**
 * The composer's WHEN, on its own.
 *
 * A slot is the one thing on that screen that decides when bytes leave, so the
 * arithmetic behind it is tested apart from the pane it is drawn in: 'now' must
 * stay the route's default rather than this browser's clock, a wait must be
 * measured from the press, and a moment already gone must be refused here
 * rather than reaching a gate that would read it as "send it immediately".
 */
describe('plannedForFrom', () => {
  const now = new Date('2026-08-19T09:00:00.000Z');

  it('sends NO instant for "the next slot", so the route keeps its own default', () => {
    expect(plannedForFrom('now', 60, '2026-08-20T10:00', now)).toEqual({ at: null, problem: '' });
  });

  it('measures a wait from the moment it is asked, not from when it was picked', () => {
    const { at, problem } = plannedForFrom('in', 180, '', now);
    expect(problem).toBe('');
    expect(at?.toISOString()).toBe('2026-08-19T12:00:00.000Z');
  });

  it('reads a picked time as local wall-clock, which is what the input holds', () => {
    const { at, problem } = plannedForFrom('at', 60, '2026-08-19T18:30', now);
    expect(problem).toBe('');
    expect(at?.getTime()).toBe(new Date('2026-08-19T18:30').getTime());
  });

  it('refuses a moment that has passed, an empty one, and an unreadable one', () => {
    expect(plannedForFrom('at', 60, '2026-08-19T08:00', now).at).toBeNull();
    expect(plannedForFrom('at', 60, '2026-08-19T08:00', now).problem).toContain('already passed');
    expect(plannedForFrom('at', 60, '', now).problem).toContain('Pick the date and time');
    expect(plannedForFrom('at', 60, 'sometime soon', now).problem).toContain('not a date and time');
  });
});
