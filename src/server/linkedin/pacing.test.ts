import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { evaluateLinkedInSafety } from './guard.js';
import { ACTION_GAP_SECONDS, BUSINESS_HOURS } from './limits.js';
import { FLAT_DAY_SHAPE, VISITS_PER_DAY, addLocalDays, dayShapeFor, planPacing, resolveSkillSeatKey, visitsForDay, type PacingPlan } from './pacing.js';
import { upsertSeat } from './seats.js';

// Real ephemeral Postgres, per the repo's test harness: the smoothing IS the
// ledger query, so a stub would test nothing that ships.
let db: Db;

// A THURSDAY, deliberately. It puts a real weekend inside the first five plan
// days, and it makes "yesterday" (Wednesday) a business day, so the
// day-over-day seed is exercised rather than skipped.
const NOW = new Date('2026-08-06T09:00:00.000Z');

// 08-06 Thu, 08-07 Fri, 08-08 Sat, 08-09 Sun, 08-10 Mon, 08-11 Tue, 08-12 Wed.
const WEEK = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12'];

const WORKSPACE_ID = 'ws_linkedin_pacing_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Pacing Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

/**
 * The seat is in UTC, so a slot's ISO date prefix IS its local date.
 *
 * `activatedOn` is the instant of the seat's FIRST WRITE, which is the ramp
 * clock -- there is no declared field to claim an age with any more. Null
 * means "activated now", which is what a brand-new seat looks like.
 */
function seat(activatedOn: string | null) {
  const activatedAt = activatedOn ? new Date(`${activatedOn}T09:00:00.000Z`) : NOW;
  return upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, activatedAt);
}

let actionSeq = 0;
async function log(kind: LinkedInActionKind, status: LinkedInActionStatus, hoursAgo: number): Promise<void> {
  actionSeq += 1;
  await recordAction(
    db,
    { workspaceId: WORKSPACE_ID, kind, targetRef: `logged-${actionSeq}`, status, source: 'export' },
    new Date(NOW.getTime() - hoursAgo * 3_600_000)
  );
}

function perDay(plan: PacingPlan, dates: readonly string[] = WEEK): number[] {
  const counts = new Map<string, number>();
  for (const slot of plan.slots) {
    const date = slot.plannedFor.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return dates.map((date) => counts.get(date) ?? 0);
}

function targets(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://www.linkedin.com/in/target-${index}`);
}

describe('warm-up ramp', () => {
  it('schedules nothing in week 1, which is what "passive only" means', async () => {
    await seat('2026-08-04');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(10), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.ceilingsApplied).toContain('warmup-multiplier');
    expect(plan.reasons.join(' ')).toContain('warm-up week 1');
  });

  it('lifts the ceiling week by week: 0.4 of the band in week 2, 0.7 in week 3', async () => {
    await seat('2026-07-27');
    const week2 = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 5 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    // Warm-up band is 5/day; x0.4 = 2. The ramp still starts at 1 because the
    // ledger is empty and no day may be a jump from the one before it.
    expect(perDay(week2)).toEqual([1, 2, 0, 0, 2, 0, 0]);

    // A NEW seat, not the same one moved. The ramp clock is write-once, so
    // there is no edit that could walk this seat from week 2 into week 3 --
    // which is exactly the property `account_opened_on` did not have.
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
    await seat('2026-07-20');
    const week3 = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 6 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    // 5/day x0.7 = 3.
    expect(perDay(week3)).toEqual([1, 2, 0, 0, 3, 3, 0]);
  });

  it('uses the steady band once the account is past the ramp', async () => {
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(40), horizonDays: 7 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(perDay(plan)).toEqual([1, 2, 0, 0, 3, 4, 5]);
    expect(plan.reasons.join(' ')).toContain('18 invite/day');
  });

  it('does not ramp passive activity: week 1 is 0 invites AND real profile views', async () => {
    // 1.4's week 1 is "passive only (views/likes, 0 invites)". Zeroing views
    // too would leave the seat inert for seven days and then acting, which is
    // the slide-and-spike shape from 1.3 -- the engine would manufacture the
    // signature it exists to prevent.
    await seat('2026-08-04');

    const invites = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 7 }, NOW);
    expect(invites.slots).toHaveLength(0);

    const views = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'profile_view', targets: targets(20), horizonDays: 7 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(views.slots.length).toBeGreaterThan(0);
    // Full warm-up band (15/day), un-multiplied -- but every OTHER ceiling
    // still binds, so it is the variance clamp that shapes the week.
    expect(perDay(views)).toEqual([1, 2, 0, 0, 3, 4, 5]);
    expect(views.ceilingsApplied).not.toContain('warmup-multiplier');
    expect(views.ceilingsApplied).toContain('day-over-day-delta');
    expect(views.ceilingsApplied).toContain('weekend');
    expect(views.reasons.join(' ')).toContain('passive activity');
  });

  it('still stops passive activity dead when the seat is paused', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', posture: 'paused' }, NOW);
    const views = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'profile_view', targets: targets(20), horizonDays: 7 }, NOW);
    expect(views.slots).toHaveLength(0);
    expect(views.ceilingsApplied).toContain('seat-paused');
  });

  it('paces a freshly activated seat as week 1 and says so', async () => {
    // No form filled in, nothing declared: the seat is week 1 because Trevra
    // has been automating it for zero days, which is the fact plan 1.3 cares
    // about and the only one we can actually verify.
    await seat(null);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(10), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.reasons.join(' ')).toContain('warm-up week 1');
  });

  it('paces a seat with no activation instant as week 1, and says why', async () => {
    // Fail closed: a row this schema never wrote is paced as brand new rather
    // than as trusted.
    await seat('2026-01-01');
    await db.prepare('UPDATE linkedin_seats SET activated_at=NULL WHERE workspace_id=?').run(WORKSPACE_ID);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(10), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.reasons.join(' ')).toContain('no activation timestamp');
  });

  it('ignores a declared account age entirely', async () => {
    // An account opened in 2011 whose automation starts today is a week-1
    // risk. `account_opened_on` is informational and nothing paces off it.
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', accountOpenedOn: '2011-05-01', connectionsCount: 9000 }, NOW);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(10), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.reasons.join(' ')).toContain('warm-up week 1');
  });
});

/**
 * THE OPERATOR'S OWN CEILING, which the planner used to ignore completely.
 *
 * `planPacing` read `bandFor()` and never once looked at the four daily limits
 * sitting on the seat row -- so an operator who set 5 invites a day got a plan
 * of 18 a day, and thirteen of those slots were refused by `guard.ts` at
 * execution time. A refused slot is not a blocked action with a reason; it is
 * an action that silently never happens.
 */
describe('the operator\'s configured daily limit', () => {
  it('binds when it is stricter than the band, and names the number', async () => {
    await seat('2026-01-01');
    await upsertSeat(db, WORKSPACE_ID, { dailyInviteLimit: 5 }, NOW);
    // Real volume yesterday, so the day-over-day ramp is not what binds.
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    // The steady band is 18/day and the smoothing clamp would allow 24. Five
    // is what the operator asked for and five is what the gate will pass.
    expect(perDay(plan)[0]).toBe(5);
    expect(plan.ceilingsApplied).toContain('operator-daily-limit');
    expect(plan.reasons.join(' ')).toContain('Your own ceiling for this account is 5 invite(s)/day');
  });

  it('keeps the safety band binding when the operator asks for more, and says so', async () => {
    await seat('2026-01-01');
    // The shipped default: 30/day against an 18/day researched band.
    await upsertSeat(db, WORKSPACE_ID, { dailyInviteLimit: 30 }, NOW);
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(40), horizonDays: 1 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(perDay(plan)[0]).toBe(18);
    expect(plan.ceilingsApplied).toContain('safety-band');
    expect(plan.reasons.join(' ')).toContain('You have set 30 invite(s)/day');
  });

  it('lets the operator\'s number win once the band override is on', async () => {
    await seat('2026-01-01');
    await upsertSeat(db, WORKSPACE_ID, { dailyInviteLimit: 30, safetyBandOverride: true }, NOW);
    for (let index = 0; index < 30; index += 1) await log('invite', 'sent', 30);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(60), horizonDays: 1 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(perDay(plan)[0]).toBe(30);
    expect(plan.ceilingsApplied).toContain('operator-daily-limit');
    expect(plan.reasons.join(' ')).toContain('use your own daily limits');
  });

  it('still ramps an overridden seat through its warm-up weeks', async () => {
    // The override lifts the BAND cap and nothing else. A week-1 seat with the
    // flag on still sends zero invites, because the warm-up multiplier is a
    // separate rule and it is the one that says "week 1 is passive only".
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', dailyInviteLimit: 75, safetyBandOverride: true }, new Date('2026-08-04T09:00:00.000Z'));
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.ceilingsApplied).toContain('warmup-multiplier');
  });
});

describe('variance smoothing', () => {
  it('refuses a 0/0/0/20 burst: no day may be a spike over the day before it', async () => {
    // The core anti-"slide and spike" rule (plan 1.3). A cold ledger asking
    // for 20 invites does not get 20 invites on Thursday, whatever the band
    // ceiling says.
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 7 }, NOW, { dayShape: FLAT_DAY_SHAPE });

    const days = perDay(plan);
    expect(Math.max(...days)).toBe(5);
    expect(days).toEqual([1, 2, 0, 0, 3, 4, 5]);
    expect(plan.slots).toHaveLength(15);
    expect(plan.ceilingsApplied).toContain('day-over-day-delta');
    expect(plan.reasons.join(' ')).toContain('5 of 20 target(s) do not fit');
  });

  it('ramps from what the seat ACTUALLY did, not from zero, when history exists', async () => {
    await seat('2026-01-01');
    // 10 invites yesterday (Wednesday, a business day).
    for (let index = 0; index < 10; index += 1) await log('invite', 'sent', 30);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(40), horizonDays: 1 }, NOW);
    // 10 x 1.35 = 13.5 -> 13.
    expect(perDay(plan)[0]).toBe(13);
  });

  it('does not let a weekend zero reset the ramp on Monday', async () => {
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(40), horizonDays: 5 }, NOW);
    const days = perDay(plan);
    // Friday 2 -> Saturday 0 -> Sunday 0 -> Monday 3, not Monday 1.
    expect(days[1]).toBe(2);
    expect(days[2]).toBe(0);
    expect(days[3]).toBe(0);
    expect(days[4]).toBe(3);
    expect(plan.ceilingsApplied).toContain('weekend');
  });
});

describe('determinism', () => {
  it('produces a byte-identical plan for identical inputs', async () => {
    // The playbook engine binds an approval to canonicalPayloadHash(payload)
    // and fails closed on drift, so a plan that re-randomised itself would
    // invalidate its own approval every time it was recomputed.
    await seat('2026-01-01');
    const input = { workspaceId: WORKSPACE_ID, kind: 'invite' as const, targets: targets(20), horizonDays: 7 };
    const first = await planPacing(db, input, NOW);
    const second = await planPacing(db, input, NOW);
    expect(second).toEqual(first);
    // ...and not because it is trivially empty.
    expect(first.slots.length).toBeGreaterThan(0);
  });

  it('moves the slots when the targets change, so the plan is not a constant', async () => {
    await seat('2026-01-01');
    const first = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 7 }, NOW);
    const second = await planPacing(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20).map((target) => `${target}-b`), horizonDays: 7 },
      NOW
    );
    expect(second.slots.map((slot) => slot.plannedFor)).not.toEqual(first.slots.map((slot) => slot.plannedFor));
  });
});

describe('acceptance-rate throttle', () => {
  async function seatWithOutcomes(accepted: number, declined: number): Promise<void> {
    await seat('2026-01-01');
    for (let index = 0; index < accepted; index += 1) await log('invite', 'accepted', 30);
    for (let index = 0; index < declined; index += 1) await log('invite', 'declined', 30);
  }

  it('halves volume below the 30% floor and names the reason', async () => {
    await seatWithOutcomes(2, 8);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW);
    // Smoothing allows 13; the throttle halves it.
    expect(perDay(plan)[0]).toBe(6);
    expect(plan.ceilingsApplied).toContain('acceptance-rate');
    expect(plan.reasons.some((reason) => reason.startsWith('throttled:'))).toBe(true);
  });

  it('leaves a healthy seat alone', async () => {
    await seatWithOutcomes(8, 2);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW);
    expect(perDay(plan)[0]).toBe(13);
    expect(plan.ceilingsApplied).not.toContain('acceptance-rate');
  });

  it('does not throttle on an absent signal', async () => {
    // No invite has been decided, so there is no rate. Throttling here would
    // halve every new seat forever for evidence that cannot exist yet.
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW);
    expect(plan.ceilingsApplied).not.toContain('acceptance-rate');
  });
});

describe('InMail monthly quota', () => {
  it('stops at the published 50-a-month quota, not at the daily band', async () => {
    await seat('2026-01-01');
    // 48 InMails spread over the last 24 days: two per rolling day.
    for (let index = 0; index < 48; index += 1) await log('inmail', 'sent', 2 + Math.floor(index / 2) * 24);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'inmail', targets: targets(10), horizonDays: 3 }, NOW);
    // The daily band would allow 3 + 3 + 3 over these days and the ramp would
    // allow 3 + 3 + 0; the quota leaves room for exactly 2.
    expect(plan.slots).toHaveLength(2);
    expect(plan.ceilingsApplied).toContain('monthly-quota');
    expect(plan.reasons.join(' ')).toContain('50-InMail monthly quota');
    expect(plan.reasons.join(' ')).toContain('8 of 10 target(s) do not fit');
  });

  it('lets capacity return as old InMails age out of the rolling window', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 48; index += 1) await log('inmail', 'sent', 2 + Math.floor(index / 2) * 24);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'inmail', targets: targets(10), horizonDays: 14 }, NOW);
    // A ROLLING 30-day window, not a calendar month: the quota does not
    // unblock all at once on the 1st, it unblocks as the oldest InMails fall
    // out. Over a fortnight that is more headroom than three days, and still
    // never 50 inside any 30-day span.
    expect(plan.slots.length).toBeGreaterThan(2);
    expect(plan.ceilingsApplied).toContain('monthly-quota');
  });
});

describe('slot placement', () => {
  it('keeps every slot inside the seat\'s business hours, spread rather than bursted', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 10; index += 1) await log('invite', 'sent', 30);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(13), horizonDays: 1 }, NOW);
    expect(plan.slots).toHaveLength(13);

    const times = plan.slots.map((slot) => new Date(slot.plannedFor));
    for (const time of times) {
      expect(time.getUTCHours()).toBeGreaterThanOrEqual(BUSINESS_HOURS.start);
      expect(time.getUTCHours()).toBeLessThan(BUSINESS_HOURS.end);
    }
    for (let index = 1; index < times.length; index += 1) {
      const gap = (times[index].getTime() - times[index - 1].getTime()) / 1000;
      expect(gap).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min);
    }
    // Thirteen actions across nine remaining hours is not a two-hour block.
    const span = (times[times.length - 1].getTime() - times[0].getTime()) / 3_600_000;
    expect(span).toBeGreaterThan(2);
  });

  it('drops repeated targets rather than scheduling the same person twice', async () => {
    await seat('2026-01-01');
    const plan = await planPacing(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targets: ['https://in/a', 'https://in/a', ' '], horizonDays: 7 },
      NOW
    );
    expect(plan.slots).toHaveLength(1);
    expect(plan.reasons.join(' ')).toContain('2 empty or repeated target(s)');
  });
});

describe('seat state', () => {
  it('plans nothing, and explains itself, when there is no seat', async () => {
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(5), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.reasons.join(' ')).toContain('No LinkedIn seat is configured');
  });

  it('plans nothing while the seat is paused', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', posture: 'paused' }, new Date('2026-01-01T09:00:00.000Z'));
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(5), horizonDays: 7 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.ceilingsApplied).toContain('seat-paused');
  });

  it('charges the outstanding-invite backlog against the weekly ceiling', async () => {
    await seat('2026-01-01');
    // Yesterday's real volume, so the day-over-day ramp is not what binds.
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);
    // Sent three months ago and still unanswered. Every rolling window in the
    // engine is blind to them -- and on LinkedIn's side they are still
    // occupying this seat's invite capacity, which is exactly why withdrawing
    // them used to return nothing here.
    for (let index = 0; index < 70; index += 1) await log('invite', 'sent', 24 * 90);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(60), horizonDays: 1 }, NOW);

    // Steady band is 90/week. 18 went out this week and 70 are still
    // outstanding from before it, so the first day may carry 2 -- not the 18
    // the daily band and the ramp would both have allowed.
    expect(perDay(plan)[0]).toBe(2);
    expect(plan.ceilingsApplied).toContain('pending-invite-backlog');
    expect(plan.reasons.join(' ')).toContain('70 invite(s) sent more than 7 days ago');
  });

  it('does not charge this week\'s invites twice', async () => {
    await seat('2026-01-01');
    // Inside the rolling 7-day window, so `sumOfLast(timeline, 6)` already
    // charges them. Counting them again as "outstanding" would take a seat that
    // used half its weekly budget straight to zero.
    for (let index = 0; index < 10; index += 1) await log('invite', 'sent', 30);

    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW);
    expect(plan.slots.length).toBeGreaterThan(0);
    expect(plan.ceilingsApplied).not.toContain('pending-invite-backlog');
  });

  it('falls back to the conservative band in cooldown', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', posture: 'cooldown' }, new Date('2026-01-01T09:00:00.000Z'));
    for (let index = 0; index < 10; index += 1) await log('invite', 'sent', 30);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW, { dayShape: FLAT_DAY_SHAPE });
    // Warm-up band is 5/day, so smoothing's 13 does not apply.
    expect(perDay(plan)[0]).toBe(5);
    expect(plan.ceilingsApplied).toContain('cooldown-band');
  });
});

/**
 * THE REGRESSION `spreadWithinBusinessHours` exists to hold down: a day whose
 * remaining business-hours window is too short to fit its allowed count at a
 * safe spacing used to fall through to `cursor = Math.min(at, windowEnd - 1)`
 * for every slot past the window's true capacity -- which clamps them all to
 * the SAME second. Several actions at one literal instant is a harder
 * detection signature than the "twenty minutes of machine-gun activity" the
 * spread exists to avoid. The fix bounds how many slots a day's remaining
 * window is asked to hold and rolls the rest to the next available day
 * instead of crowding the window's close.
 */
describe('spreading inside a short business-hours window', () => {
  it('never schedules two slots in the same window at the same second, and rolls the rest to the next day', async () => {
    await seat('2026-01-01');
    // Steady, established volume, so the day's allowed count is the full
    // 18/day band rather than something the ramp or the delta clamp already
    // shrank to fit.
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);

    // Thursday, 17:55 UTC -- five minutes before BUSINESS_HOURS.end (18:00).
    // Eighteen invites are allowed today; the window has room for only a few
    // of them at ACTION_GAP_SECONDS.max spacing.
    const lateNow = new Date('2026-08-06T17:55:00.000Z');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(18), horizonDays: 3 }, lateNow, { dayShape: FLAT_DAY_SHAPE });

    const today = plan.slots.filter((slot) => slot.plannedFor.startsWith('2026-08-06'));
    // NOTHING TODAY, and that is the visit model doing its job. The last visit
    // of the day is long over by 17:55; a person who last opened LinkedIn at
    // half past three does not fire three invitations at 17:57, and "three
    // actions in the final five minutes of the window" is the end-of-day burst
    // this whole file exists to avoid. Before visits, the answer here was 3.
    expect(today.length).toBe(0);

    // The original defect: every slot past capacity collapsed onto the same
    // clamped second. Distinct timestamps is the assertion that matters, and it
    // holds across the whole plan and not just today.
    const distinctSeconds = new Set(plan.slots.map((slot) => slot.plannedFor));
    expect(distinctSeconds.size).toBe(plan.slots.length);

    // Nothing was scheduled behind the clock either.
    for (const slot of plan.slots) {
      expect(new Date(slot.plannedFor).getTime()).toBeGreaterThanOrEqual(lateNow.getTime());
    }

    expect(plan.ceilingsApplied).toContain('business-hours-window-capacity');
    // The eighteen were not dropped -- they rolled into the next available
    // business day(s) rather than crowding today's close.
    expect(plan.slots.length).toBeGreaterThan(0);
  });

  it('puts every slot inside one of the day\'s visits, not spread across the whole window', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);

    // Monday 06:00 UTC, before the window opens, so no visit is behind us.
    const early = new Date('2026-08-03T06:00:00.000Z');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(18), horizonDays: 1 }, early, { dayShape: FLAT_DAY_SHAPE });
    expect(plan.slots.length).toBeGreaterThan(0);

    const visits = visitsForDay(`${WORKSPACE_ID}:owner`, { year: 2026, month: 8, day: 3 }, { startMinute: 480, endMinute: 1080 }, {
      actions: plan.slots.length,
      earliestMinute: 360
    });

    for (const slot of plan.slots) {
      const at = new Date(slot.plannedFor);
      const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
      const inside = visits.some((visit) => minuteOfDay >= visit.startMinute && minuteOfDay <= visit.endMinute);
      expect(inside, `${slot.plannedFor} (minute ${minuteOfDay}) is outside every visit ${JSON.stringify(visits)}`).toBe(true);
    }

    // And the sends are clustered, not evenly smeared: a handful of bursts
    // rather than one every thirty minutes for ten hours.
    const occupied = new Set(
      plan.slots.map((slot) => {
        const at = new Date(slot.plannedFor);
        const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
        return visits.findIndex((visit) => minuteOfDay >= visit.startMinute && minuteOfDay <= visit.endMinute);
      })
    );
    expect(occupied.size).toBeLessThanOrEqual(VISITS_PER_DAY.max);
  });
});

/**
 * THE SEAT'S OWN SCHEDULE, which the planner used to ignore.
 *
 * It planned against the hardcoded 08:00-18:00 Mon-Fri `BUSINESS_HOURS` while
 * `guard.ts` enforced `working_days` / `work_start_minute` / `work_end_minute`
 * from the seat row. An account configured for 10:00-14:00 on Tuesdays and
 * Thursdays therefore got slots the gate refused -- and a refused slot is not
 * a blocked action with a reason, it is an action that silently never happens.
 */
describe('the seat\'s configured working window', () => {
  function configuredSeat(days: number[], startMinute: number, endMinute: number) {
    return upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Test seat', timezone: 'UTC', workingDays: days, workStartMinute: startMinute, workEndMinute: endMinute },
      new Date('2026-01-01T09:00:00.000Z')
    );
  }

  it('places every slot inside a 10:00-14:00 Tuesday/Thursday window', async () => {
    await configuredSeat([2, 4], 600, 840);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(12), horizonDays: 21 }, NOW);

    expect(plan.slots.length).toBeGreaterThan(0);
    for (const slot of plan.slots) {
      const at = new Date(slot.plannedFor);
      expect([2, 4]).toContain(at.getUTCDay());
      const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
      expect(minuteOfDay).toBeGreaterThanOrEqual(600);
      expect(minuteOfDay).toBeLessThan(840);
    }
    // Monday, Wednesday and Friday are working days for nobody here, and the
    // plan says so rather than quietly emitting nothing.
    expect(plan.ceilingsApplied).toContain('working-days');
    expect(plan.reasons.join(' ')).toContain('10:00 and 14:00');
  });

  it('works Saturdays for a seat whose operator ticked Saturday', async () => {
    // WEEKEND_FACTOR is volume shaping for a weekend nobody configured. It
    // does not get to veto a day somebody configured on purpose.
    await configuredSeat([6], 600, 840);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(5), horizonDays: 14 }, NOW);

    expect(plan.slots.length).toBeGreaterThan(0);
    for (const slot of plan.slots) expect(new Date(slot.plannedFor).getUTCDay()).toBe(6);
    // Both Saturdays inside the horizon, ramped 1 then 2 rather than started
    // at the band ceiling.
    expect(new Set(plan.slots.map((slot) => slot.plannedFor.slice(0, 10)))).toEqual(new Set(['2026-08-08', '2026-08-15']));
  });

  it('plans nothing when the operator has ticked no days at all', async () => {
    await configuredSeat([], 600, 840);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(5), horizonDays: 14 }, NOW);
    expect(plan.slots).toHaveLength(0);
    expect(plan.ceilingsApplied).toContain('working-days');
    expect(plan.reasons.join(' ')).toContain('no working days configured');
  });
});

/**
 * THE REGRESSION THAT MATTERS MOST: the planner and the gate answering the
 * same question about the same instant the same way. They are two files and
 * one policy, and when they drift the failure is silent -- the plan looks
 * healthy and every action it produced is refused at execution time.
 */
describe('the planner and the gate agree', () => {
  it('produces slots the safety gate accepts, including on a configured Saturday', async () => {
    await upsertSeat(
      db,
      WORKSPACE_ID,
      { label: 'Test seat', timezone: 'UTC', workingDays: [2, 4, 6], workStartMinute: 600, workEndMinute: 840 },
      new Date('2026-01-01T09:00:00.000Z')
    );
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(6), horizonDays: 14 }, NOW);
    expect(plan.slots.length).toBeGreaterThan(2);
    expect(plan.slots.some((slot) => new Date(slot.plannedFor).getUTCDay() === 6)).toBe(true);

    for (const slot of plan.slots) {
      const verdict = await evaluateLinkedInSafety(
        db,
        { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: slot.targetRef, plannedFor: slot.plannedFor },
        NOW
      );
      const timing = verdict.checks.filter((entry) => entry.check === 'business-hours' || entry.check === 'weekend');
      expect(timing.map((entry) => entry.passed)).toEqual([true, true]);
    }

    // ...and the first slot clears the whole gate, not just the timing pair.
    const first = await evaluateLinkedInSafety(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: plan.slots[0].targetRef, plannedFor: plan.slots[0].plannedFor },
      NOW
    );
    expect(first.reason).toBeNull();
    expect(first.allowed).toBe(true);
  });

  it('agrees on the default Monday-to-Friday window too', async () => {
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(4), horizonDays: 7 }, NOW);
    expect(plan.slots.length).toBeGreaterThan(0);
    for (const slot of plan.slots) {
      const verdict = await evaluateLinkedInSafety(
        db,
        { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: slot.targetRef, plannedFor: slot.plannedFor },
        NOW
      );
      const timing = verdict.checks.filter((entry) => entry.check === 'business-hours' || entry.check === 'weekend');
      expect(timing.map((entry) => entry.passed)).toEqual([true, true]);
    }
  });
});

/**
 * WHICH ACCOUNT AN AGENT MEANT WHEN IT DID NOT SAY.
 *
 * `gtm.linkedin-pace` and `gtm.linkedin-guard` both declared
 * `seatKey: z.string().default(OWNER_SEAT_KEY)` on their skill input schemas.
 * That default is right in `seats.ts`, where it keeps a single-seat
 * workspace's pre-multi-seat call sites resolving the row they always did. On
 * a skill input it is a different thing: it turns "the caller did not say"
 * into a confident answer about one particular LinkedIn identity, and in a
 * workspace running three accounts it prices every ceiling against an account
 * nobody chose -- then names that account in the plan it hands back.
 */
describe('resolving the seat a skill call meant', () => {
  it('uses the seat key when one was supplied', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'UTC' }, NOW);
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales', timezone: 'UTC' }, NOW, 'sales');
    expect(await resolveSkillSeatKey(db, WORKSPACE_ID, 'sales')).toBe('sales');
  });

  it('uses the workspace\'s only seat when it has exactly one, whatever it is called', async () => {
    // A single-account workspace has no ambiguity to resolve, and this is what
    // keeps every existing single-seat caller working -- including one whose
    // only account is not the owner key.
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales', timezone: 'UTC' }, NOW, 'sales');
    expect(await resolveSkillSeatKey(db, WORKSPACE_ID, undefined)).toBe('sales');
  });

  it('refuses, naming the seats, when the workspace has several', async () => {
    await upsertSeat(db, WORKSPACE_ID, { label: 'Owner', timezone: 'UTC' }, NOW);
    await upsertSeat(db, WORKSPACE_ID, { label: 'Sales', timezone: 'UTC' }, NOW, 'sales');
    await expect(resolveSkillSeatKey(db, WORKSPACE_ID, undefined)).rejects.toThrow(/owner, sales/);
    await expect(resolveSkillSeatKey(db, WORKSPACE_ID, '  ')).rejects.toThrow(/'seatKey' is required/);
  });

  it('falls back to the owner key when the workspace has no seat at all', async () => {
    // There is nothing to choose from, so the caller should get the planner's
    // and the gate's honest no-seat answers rather than an error about a
    // choice that did not exist.
    expect(await resolveSkillSeatKey(db, WORKSPACE_ID, undefined)).toBe('owner');
  });
});

/**
 * WHAT MAKES A WEEK LOOK LIKE A PERSON'S WEEK rather than a scheduler's.
 *
 * The per-action realism (`human.ts`) is about one click. This is about the
 * shape of a month: days that start and finish at slightly different times,
 * days that are simply skipped, and days that stop short of the ceiling. All
 * three are seeded, so they are assertable rather than merely hoped for.
 */
describe('day shaping', () => {
  const WINDOW = { days: [1, 2, 3, 4, 5], startMinute: BUSINESS_HOURS.start * 60, endMinute: BUSINESS_HOURS.end * 60 };

  it('is deterministic, and never places a day outside the configured window', () => {
    const first = dayShapeFor('ws:owner', { year: 2026, month: 8, day: 17 }, WINDOW);
    const second = dayShapeFor('ws:owner', { year: 2026, month: 8, day: 17 }, WINDOW);
    expect(first).toEqual(second);
    expect(first.startMinute).toBeGreaterThanOrEqual(WINDOW.startMinute);
    expect(first.endMinute).toBeLessThanOrEqual(WINDOW.endMinute);
    expect(first.draw).toBeGreaterThanOrEqual(0.8);
    expect(first.draw).toBeLessThanOrEqual(1);
  });

  it('rests some days, shortens others, and rarely runs a day to its ceiling', () => {
    const shapes = Array.from({ length: 60 }, (_, index) =>
      dayShapeFor('ws:owner', addLocalDays({ year: 2026, month: 8, day: 17 }, index), WINDOW)
    );
    expect(shapes.some((shape) => shape.resting)).toBe(true);
    expect(shapes.some((shape) => shape.draw < 1)).toBe(true);
    expect(shapes.some((shape) => shape.startMinute > WINDOW.startMinute)).toBe(true);
    expect(shapes.some((shape) => shape.endMinute < WINDOW.endMinute)).toBe(true);
    // Two different seats do not share a calendar.
    const other = dayShapeFor('ws:sales', { year: 2026, month: 8, day: 17 }, WINDOW);
    expect(other).not.toEqual(shapes[0]);
  });

  it('keeps every planned slot inside the operator\'s configured hours', async () => {
    await seat('2026-01-01');
    for (let index = 0; index < 18; index += 1) await log('invite', 'sent', 30);
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(120), horizonDays: 21 }, NOW);
    expect(plan.slots.length).toBeGreaterThan(0);
    for (const slot of plan.slots) {
      const at = new Date(slot.plannedFor);
      const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
      expect(minute).toBeGreaterThanOrEqual(WINDOW.startMinute);
      expect(minute).toBeLessThan(WINDOW.endMinute);
    }
    // The gate would refuse anything outside the window, so a plan that fits
    // inside a jittered day also fits inside the configured one. And no day
    // ever exceeds the seat's 18/day ceiling.
    const perDate = new Map<string, number>();
    for (const slot of plan.slots) {
      const date = slot.plannedFor.slice(0, 10);
      perDate.set(date, (perDate.get(date) ?? 0) + 1);
    }
    expect(Math.max(...perDate.values())).toBeLessThanOrEqual(18);
  });
});
