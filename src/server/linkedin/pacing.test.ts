import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { recordAction, type LinkedInActionKind, type LinkedInActionStatus } from './actions.js';
import { ACTION_GAP_SECONDS, BUSINESS_HOURS } from './limits.js';
import { planPacing, type PacingPlan } from './pacing.js';
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
    const week2 = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 5 }, NOW);
    // Warm-up band is 5/day; x0.4 = 2. The ramp still starts at 1 because the
    // ledger is empty and no day may be a jump from the one before it.
    expect(perDay(week2)).toEqual([1, 2, 0, 0, 2, 0, 0]);

    // A NEW seat, not the same one moved. The ramp clock is write-once, so
    // there is no edit that could walk this seat from week 2 into week 3 --
    // which is exactly the property `account_opened_on` did not have.
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
    await seat('2026-07-20');
    const week3 = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 6 }, NOW);
    // 5/day x0.7 = 3.
    expect(perDay(week3)).toEqual([1, 2, 0, 0, 3, 3, 0]);
  });

  it('uses the steady band once the account is past the ramp', async () => {
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(40), horizonDays: 7 }, NOW);
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

    const views = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'profile_view', targets: targets(20), horizonDays: 7 }, NOW);
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

describe('variance smoothing', () => {
  it('refuses a 0/0/0/20 burst: no day may be a spike over the day before it', async () => {
    // The core anti-"slide and spike" rule (plan 1.3). A cold ledger asking
    // for 20 invites does not get 20 invites on Thursday, whatever the band
    // ceiling says.
    await seat('2026-01-01');
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(20), horizonDays: 7 }, NOW);

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
    const plan = await planPacing(db, { workspaceId: WORKSPACE_ID, kind: 'invite', targets: targets(30), horizonDays: 1 }, NOW);
    // Warm-up band is 5/day, so smoothing's 13 does not apply.
    expect(perDay(plan)[0]).toBe(5);
    expect(plan.ceilingsApplied).toContain('cooldown-band');
  });
});
