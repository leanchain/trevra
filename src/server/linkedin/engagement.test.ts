import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { LINKEDIN_LIMITS, WARMUP_MULTIPLIERS } from './limits.js';
import type { evaluateLinkedInSafety, LinkedInSafetyInput } from './guard.js';
import {
  ENGAGEMENT_KINDS,
  ENGAGEMENT_LIMITS,
  PASSIVE_ENGAGEMENT_KINDS,
  countEngagementInWindow,
  engagementBandFor,
  engagementRemainingToday,
  evaluateEngagementSafety,
  hasEngagementTarget,
  isEngagementKind,
  recordEngagement,
  type EngagementKind
} from './engagement.js';
import { ownerSeat } from './actions.js';

let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const SLOT = '2026-08-06T10:00:00.000Z';
const WORKSPACE_ID = 'ws_linkedin_engagement_test';
const SEAT = ownerSeat(WORKSPACE_ID);

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Engagement Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

function log(kind: EngagementKind, target: string, hoursAgo: number) {
  return recordEngagement(
    db,
    { workspaceId: WORKSPACE_ID, kind, targetRef: target, status: 'sent', source: 'manual' },
    new Date(NOW.getTime() - hoursAgo * 3_600_000)
  );
}

describe('the ceilings', () => {
  it('covers exactly the three kinds, in both bands', () => {
    expect(ENGAGEMENT_KINDS).toEqual(['follow', 'like', 'endorse']);
    for (const kind of ENGAGEMENT_KINDS) {
      expect(engagementBandFor(kind, 'warmup').perDay).toBeGreaterThan(0);
      expect(engagementBandFor(kind, 'steady').perDay).toBeGreaterThan(0);
    }
    expect(isEngagementKind('follow')).toBe(true);
    expect(isEngagementKind('invite')).toBe(false);
  });

  /**
   * THE INVARIANT RULE 1 IS ABOUT, stated as arithmetic rather than as prose.
   *
   * A passive kind skips the warm-up multiplier, so its warm-up ceiling is
   * what a week-1 seat actually gets. If that number could floor to zero the
   * carve-out would be defeated by arithmetic instead of by policy, and a
   * brand-new seat would sit dormant for a week and then start acting -- the
   * "Slide and Spike" shape the engine exists to prevent.
   */
  it('never lets a warm-up ceiling reach zero, which is what makes these kinds a warm-up', () => {
    for (const kind of ENGAGEMENT_KINDS) {
      expect(engagementBandFor(kind, 'warmup').perDay).toBeGreaterThanOrEqual(1);
      // Even if the multiplier were ever applied by mistake, week 1 is the
      // zero, so this records what such a mistake would cost.
      expect(Math.floor(engagementBandFor(kind, 'warmup').perDay * WARMUP_MULTIPLIERS[0])).toBe(0);
    }
  });

  // The anchor. profile_view is the only passive kind with a REPORTED band
  // (plan 1.4), and a follow or a like lands in the target's notifications
  // where a profile view frequently does not. Pacing a louder action above a
  // quieter one would be incoherent whatever the numbers were.
  it('sits strictly below the one passive kind that has a reported band', () => {
    for (const kind of ENGAGEMENT_KINDS) {
      expect(engagementBandFor(kind, 'warmup').perDay).toBeLessThan(LINKEDIN_LIMITS.profile_view.warmup.perDay);
      expect(engagementBandFor(kind, 'steady').perDay).toBeLessThan(LINKEDIN_LIMITS.profile_view.steady.perDay);
    }
  });

  it('ramps up from warm-up to steady, never down', () => {
    for (const kind of ENGAGEMENT_KINDS) {
      expect(engagementBandFor(kind, 'steady').perDay).toBeGreaterThan(engagementBandFor(kind, 'warmup').perDay);
    }
  });

  // Supplying a daily figure is already a judgement call; supplying three
  // would be three. guard.ts reports an absent window as absent rather than
  // inventing one, which is the behaviour this asserts is still reachable.
  it('publishes no weekly or monthly figure, because none was researched', () => {
    for (const kind of ENGAGEMENT_KINDS) {
      for (const band of ['warmup', 'steady'] as const) {
        expect(ENGAGEMENT_LIMITS[kind][band].perWeek).toBeUndefined();
        expect(ENGAGEMENT_LIMITS[kind][band].perMonth).toBeUndefined();
      }
    }
  });

  // The list limits.ts must gain, asserted here rather than against
  // PASSIVE_KINDS itself: this file does not own that constant, and a test
  // pinned to its present value would start failing the moment the wiring
  // lands, which is the opposite of what it is for.
  it('declares all three passive, with no exception', () => {
    expect(PASSIVE_ENGAGEMENT_KINDS).toEqual(ENGAGEMENT_KINDS);
    expect(PASSIVE_ENGAGEMENT_KINDS).toHaveLength(3);
  });
});

describe('the ledger', () => {
  it('writes an engagement row the rolling window can count', async () => {
    await log('like', 'https://www.linkedin.com/in/a/', 1);
    await log('like', 'https://www.linkedin.com/in/b/', 5);
    await log('follow', 'https://www.linkedin.com/in/a/', 2);

    expect(await countEngagementInWindow(db, SEAT, 'like', 24, NOW)).toBe(2);
    expect(await countEngagementInWindow(db, SEAT, 'follow', 24, NOW)).toBe(1);
    expect(await countEngagementInWindow(db, SEAT, 'endorse', 24, NOW)).toBe(0);
  });

  it('counts by recorded_at, so yesterday does not consume today', async () => {
    await log('like', 'https://www.linkedin.com/in/old/', 30);
    expect(await countEngagementInWindow(db, SEAT, 'like', 24, NOW)).toBe(0);
    expect(await countEngagementInWindow(db, SEAT, 'like', 24 * 7, NOW)).toBe(1);
  });

  // One seat gets one like row per TARGET, ever -- target_ref is a person, not
  // a post. Conservative on purpose: repeatedly reacting to one stranger's
  // posts is a stronger automation tell than reacting once to thirty people's.
  it('refuses a second engagement of the same kind against the same target', async () => {
    const first = await log('like', 'https://www.linkedin.com/in/a/', 1);
    const second = await log('like', 'https://www.linkedin.com/in/a/', 0);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await countEngagementInWindow(db, SEAT, 'like', 24, NOW)).toBe(1);
  });

  it('keeps the kinds independent, so a follow does not block a like', async () => {
    await log('follow', 'https://www.linkedin.com/in/a/', 1);
    expect(await hasEngagementTarget(db, SEAT, 'follow', 'https://www.linkedin.com/in/a/')).toBe(true);
    expect(await hasEngagementTarget(db, SEAT, 'like', 'https://www.linkedin.com/in/a/')).toBe(false);
  });

  it('reports what is left of a daily ceiling, floored at zero', async () => {
    expect(await engagementRemainingToday(db, SEAT, 'endorse', 'warmup', NOW)).toBe(3);
    for (let index = 0; index < 5; index += 1) {
      await log('endorse', `https://www.linkedin.com/in/e${index}/`, 1);
    }
    expect(await engagementRemainingToday(db, SEAT, 'endorse', 'warmup', NOW)).toBe(0);
    expect(await engagementRemainingToday(db, SEAT, 'endorse', 'steady', NOW)).toBe(3);
  });
});

describe('the gate', () => {
  const input = { workspaceId: WORKSPACE_ID, kind: 'like' as const, targetRef: 'https://www.linkedin.com/in/a/', plannedFor: SLOT };

  /**
   * FAIL-CLOSED ACROSS THE INTEGRATION EDIT. Until `limits.ts` lists these
   * kinds, `bandFor` has no band to return and calling the gate would throw a
   * TypeError inside a batch that has already claimed a row. "I could not find
   * out whether this is safe" is not "it is safe".
   */
  it('refuses, rather than throwing, for a kind with no published band', async () => {
    const verdict = await evaluateEngagementSafety(db, input, NOW, { isPaced: () => false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('no-published-band');
    expect(verdict.reason).toContain('PASSIVE_KINDS');
    expect(verdict.checks).toEqual([]);
    expect(verdict.automationMode).toBe('prepare-only');
  });

  // Holds before the integration edit and after it: one branch refuses, the
  // other runs the real gate, and neither throws.
  it('always returns a verdict with the default collaborators', async () => {
    const verdict = await evaluateEngagementSafety(db, input, NOW);
    expect(typeof verdict.allowed).toBe('boolean');
    expect(Array.isArray(verdict.checks)).toBe(true);
  });

  it('hands the whole action to the ordinary gate once the kind is paced, adding no exception', async () => {
    const seen: Array<{ passed: LinkedInSafetyInput; excludeActionId: string | null }> = [];
    const stub: typeof evaluateLinkedInSafety = async (_db, passed, _now, options = {}) => {
      seen.push({ passed, excludeActionId: options.excludeActionId ?? null });
      return { allowed: true, reason: null, checks: [], automationMode: 'prepare-only', automationReason: 'stub' };
    };

    const verdict = await evaluateEngagementSafety(db, input, NOW, {
      isPaced: () => true,
      evaluate: stub,
      excludeActionId: 'lact_under_evaluation'
    });

    expect(verdict.allowed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].passed).toEqual({ workspaceId: WORKSPACE_ID, seatKey: 'owner', kind: 'like', targetRef: input.targetRef, plannedFor: SLOT });
    // The gate is told which row is the subject of the question; it is not
    // told to skip a check.
    expect(seen[0].excludeActionId).toBe('lact_under_evaluation');
  });
});
