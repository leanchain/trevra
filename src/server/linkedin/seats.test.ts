import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  OWNER_SEAT_KEY,
  deleteSeat,
  effectivePosture,
  getSeat,
  getSeatPosture,
  listSeats,
  pauseSeat,
  resumeSeat,
  upsertSeat,
  warmupWeekOf,
  type LinkedInSeat
} from './seats.js';

// Real ephemeral Postgres, per the repo's test harness.
let db: Db;

// A Thursday, so "yesterday" is a business day everywhere below.
const NOW = new Date('2026-08-06T09:00:00.000Z');

/**
 * A seat activated long before NOW: one whose ramp is over.
 *
 * The ramp clock is the seat's FIRST WRITE, so "an established seat" is
 * expressed by writing it at an earlier instant rather than by declaring a
 * date on it. That is the whole change: there is no field to claim it with.
 */
const ACTIVATED = new Date('2026-01-01T09:00:00.000Z');

const WORKSPACE_ID = 'ws_linkedin_seats_test';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Seats Test', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
});

afterEach(async () => {
  await db?.close();
});

function create(patch: Partial<Parameters<typeof upsertSeat>[2]> = {}, at: Date = NOW): Promise<LinkedInSeat> {
  return upsertSeat(db, WORKSPACE_ID, { label: 'Pankaj (founder)', timezone: 'Europe/Zurich', ...patch }, at);
}

describe('upsertSeat', () => {
  it('creates the workspace seat and reports it under the owner key', async () => {
    const seat = await create({ accountOpenedOn: '2026-01-01', connectionsCount: 640, profileUrl: 'https://www.linkedin.com/in/example' });
    expect(seat.seatKey).toBe(OWNER_SEAT_KEY);
    expect(seat.label).toBe('Pankaj (founder)');
    expect(seat.accountOpenedOn).toBe('2026-01-01');
    expect(seat.connectionsCount).toBe(640);
    expect(seat.posture).toBe('warmup');
    expect(await listSeats(db, WORKSPACE_ID)).toHaveLength(1);
  });

  it('returns the date as a plain YYYY-MM-DD string, not a server-local Date', async () => {
    // pg's default DATE parser would hand back midnight in the SERVER's
    // timezone, which is a different day for half the planet.
    await create({ accountOpenedOn: '2026-01-01' });
    const seat = await getSeat(db, WORKSPACE_ID);
    expect(seat?.accountOpenedOn).toBe('2026-01-01');
  });

  it('treats an absent patch field as unchanged, never as cleared', async () => {
    await create({ accountOpenedOn: '2026-01-01', connectionsCount: 640 });
    const updated = await upsertSeat(db, WORKSPACE_ID, { timezone: 'America/New_York' }, NOW);
    expect(updated.timezone).toBe('America/New_York');
    expect(updated.accountOpenedOn).toBe('2026-01-01');
    expect(updated.connectionsCount).toBe(640);
    expect(updated.label).toBe('Pankaj (founder)');
  });

  it('clears a nullable field when null is passed explicitly', async () => {
    await create({ profileUrl: 'https://www.linkedin.com/in/typo' });
    const updated = await upsertSeat(db, WORKSPACE_ID, { profileUrl: null }, NOW);
    expect(updated.profileUrl).toBeNull();
  });

  it('refuses a first write without the two fields that have no default', async () => {
    await expect(upsertSeat(db, WORKSPACE_ID, { accountOpenedOn: '2026-01-01' }, NOW)).rejects.toThrow(/label/);
    await expect(upsertSeat(db, WORKSPACE_ID, { label: 'Solo' }, NOW)).rejects.toThrow(/timezone/);
  });

  it('refuses a timezone this runtime does not know', async () => {
    await expect(create({ timezone: 'Mars/Olympus' })).rejects.toThrow(/IANA/);
  });

  it('refuses an opening date that is not YYYY-MM-DD', async () => {
    await expect(create({ accountOpenedOn: '01/01/2026' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('the ramp clock', () => {
  it('starts on the first write', async () => {
    const seat = await create({}, ACTIVATED);
    expect(seat.activatedAt).toBe('2026-01-01T09:00:00.000Z');
    expect(seat.detectedAt).toBeNull();
  });

  it('IS NEVER RESET BY A LATER WRITE, whatever that write says', async () => {
    // The whole reason the ramp moved off `account_opened_on`: a clock an
    // operator can restart by saving a form again is not a clock. Every other
    // column below takes the new value; this one keeps the old one.
    await create({}, ACTIVATED);
    const edited = await upsertSeat(db, WORKSPACE_ID, { label: 'Renamed', timezone: 'America/New_York', accountOpenedOn: '2026-08-06' }, NOW);
    expect(edited.label).toBe('Renamed');
    expect(edited.accountOpenedOn).toBe('2026-08-06');
    expect(edited.activatedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('survives a pause and resume cycle', async () => {
    // Otherwise pausing would be a way to earn a ramp back, which is an
    // incentive pointing the wrong way.
    await create({}, ACTIVATED);
    await pauseSeat(db, WORKSPACE_ID, 'restricted', NOW);
    const resumed = await resumeSeat(db, WORKSPACE_ID, NOW);
    expect(resumed?.activatedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('records when the session was last read, without touching the clock', async () => {
    await create({}, ACTIVATED);
    const detected = await upsertSeat(db, WORKSPACE_ID, { detectedAt: NOW.toISOString(), connectionsCount: 1234 }, NOW);
    expect(detected.detectedAt).toBe('2026-08-06T09:00:00.000Z');
    expect(detected.connectionsCount).toBe(1234);
    expect(detected.activatedAt).toBe('2026-01-01T09:00:00.000Z');
  });
});

describe('pauseSeat / resumeSeat', () => {
  it('records why it stopped, and stops being paused on resume', async () => {
    await create({}, ACTIVATED);
    const paused = await pauseSeat(db, WORKSPACE_ID, 'LinkedIn asked for a re-login', NOW);
    expect(paused?.posture).toBe('paused');
    expect(paused?.pausedReason).toBe('LinkedIn asked for a re-login');
    expect(await getSeatPosture(db, WORKSPACE_ID, NOW)).toBe('paused');

    const resumed = await resumeSeat(db, WORKSPACE_ID, NOW);
    expect(resumed?.pausedReason).toBeNull();
    // Stored 'warmup', but a seat activated in January is past the ramp.
    expect(await getSeatPosture(db, WORKSPACE_ID, NOW)).toBe('steady');
  });

  it('drops a stale pause reason when an upsert moves the seat out of paused', async () => {
    await create({}, ACTIVATED);
    await pauseSeat(db, WORKSPACE_ID, 'restricted', NOW);
    const updated = await upsertSeat(db, WORKSPACE_ID, { posture: 'cooldown' }, NOW);
    expect(updated.posture).toBe('cooldown');
    expect(updated.pausedReason).toBeNull();
  });

  it('reports nothing for a workspace with no seat', async () => {
    expect(await getSeatPosture(db, WORKSPACE_ID, NOW)).toBeNull();
    expect(await pauseSeat(db, WORKSPACE_ID, 'nothing to pause', NOW)).toBeUndefined();
  });
});

describe('deleteSeat', () => {
  it('deletes the row, resets the ramp, and reports false for a second call', async () => {
    await create({}, ACTIVATED);
    expect(await deleteSeat(db, WORKSPACE_ID)).toBe(true);
    expect(await getSeat(db, WORKSPACE_ID)).toBeUndefined();
    expect(await deleteSeat(db, WORKSPACE_ID)).toBe(false);

    // A seat created afterwards is a brand new ramp clock, not a continuation.
    const next = await create({}, NOW);
    expect(next.activatedAt).toBe(NOW.toISOString());
  });
});

describe('warmupWeekOf', () => {
  it('counts days 0-6 as week 1 and day 7 as week 2', () => {
    expect(warmupWeekOf('2026-08-06T09:00:00.000Z', NOW)).toBe(1);
    expect(warmupWeekOf('2026-07-31T09:00:00.000Z', NOW)).toBe(1);
    expect(warmupWeekOf('2026-07-30T09:00:00.000Z', NOW)).toBe(2);
    expect(warmupWeekOf('2026-07-23T09:00:00.000Z', NOW)).toBe(3);
    expect(warmupWeekOf('2026-01-01T09:00:00.000Z', NOW)).toBeGreaterThan(4);
  });

  it('treats an absent, unparseable, or future activation as week 1', () => {
    // Unproven standing is not standing -- the same rule outreach/safety.ts
    // applies to an undeclared account profile.
    expect(warmupWeekOf(null, NOW)).toBe(1);
    expect(warmupWeekOf('not-a-timestamp', NOW)).toBe(1);
    expect(warmupWeekOf('2027-01-01T00:00:00.000Z', NOW)).toBe(1);
  });
});

describe('effectivePosture', () => {
  it('derives warmup vs steady from the ramp clock, ignoring a stored claim', async () => {
    // Storing 'steady' by hand must not buy a week-old seat out of its ramp:
    // how long this seat has been automated is a fact, not a preference.
    const young = await create({ posture: 'steady' }, new Date('2026-07-30T09:00:00.000Z'));
    expect(effectivePosture(young, NOW)).toBe('warmup');

    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(WORKSPACE_ID);
    const old = await create({}, ACTIVATED);
    expect(effectivePosture(old, NOW)).toBe('steady');
  });

  it('ignores a declared account age entirely', async () => {
    // The signal is automated activity (plan 1.3), not the account's birthday.
    // An account opened in 2011 whose automation started today is a week-1
    // risk, and this is the assertion that says so.
    const seat = await create({ accountOpenedOn: '2011-05-01', connectionsCount: 9000 }, NOW);
    expect(effectivePosture(seat, NOW)).toBe('warmup');
    expect(warmupWeekOf(seat.activatedAt, NOW)).toBe(1);
  });

  it('lets the two operator-set postures win', async () => {
    const seat = await create({ posture: 'cooldown' }, ACTIVATED);
    expect(effectivePosture(seat, NOW)).toBe('cooldown');
    const paused = await pauseSeat(db, WORKSPACE_ID, 'restricted', NOW);
    expect(effectivePosture(paused as LinkedInSeat, NOW)).toBe('paused');
  });

  it('falls back to week 1 for a row with no activation instant at all', async () => {
    await create({}, ACTIVATED);
    await db.prepare('UPDATE linkedin_seats SET activated_at=NULL WHERE workspace_id=?').run(WORKSPACE_ID);
    const seat = await getSeat(db, WORKSPACE_ID);
    expect(seat?.activatedAt).toBeNull();
    expect(effectivePosture(seat as LinkedInSeat, NOW)).toBe('warmup');
  });
});
