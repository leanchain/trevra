import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  acceptanceRate,
  countActionsInWindow,
  dailyCountsForLastNDays,
  hasTarget,
  ownerSeat,
  recordAction,
  type LinkedInActionKind,
  type LinkedInActionStatus,
  type SeatRef
} from './actions.js';

// Real ephemeral Postgres, per the repo's test harness: every window here IS a
// query, so an in-memory stub would test nothing that ships.
let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');

const WORKSPACE_ID = 'ws_linkedin_actions_test';
const SEAT: SeatRef = { workspaceId: WORKSPACE_ID, seatKey: 'owner' };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Actions Test', NOW.toISOString());
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run('ws_linkedin_actions_other', 'Someone Else', NOW.toISOString());
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id IN (?,?)').run(WORKSPACE_ID, 'ws_linkedin_actions_other');
});

afterEach(async () => {
  await db?.close();
});

interface LogOptions {
  kind?: LinkedInActionKind;
  status?: LinkedInActionStatus;
  hoursAgo?: number;
  target?: string;
  seatKey?: string;
  workspaceId?: string;
}

let actionSeq = 0;
async function log(options: LogOptions = {}): Promise<{ id: string; duplicate: boolean }> {
  actionSeq += 1;
  return recordAction(
    db,
    {
      workspaceId: options.workspaceId ?? WORKSPACE_ID,
      seatKey: options.seatKey,
      kind: options.kind ?? 'invite',
      targetRef: options.target ?? `target-${actionSeq}`,
      status: options.status ?? 'sent',
      source: 'export'
    },
    new Date(NOW.getTime() - (options.hoursAgo ?? 1) * 3_600_000)
  );
}

async function rowFor(target: string): Promise<{ recorded_at: string | null; planned_for: string | null; seat_key: string; status: string }> {
  const row = await db
    .prepare('SELECT recorded_at, planned_for, seat_key, status FROM linkedin_actions WHERE workspace_id=? AND target_ref=? ORDER BY created_at DESC LIMIT 1')
    .get<{ recorded_at: string | null; planned_for: string | null; seat_key: string; status: string }>(WORKSPACE_ID, target);
  if (!row) throw new Error(`no row for ${target}`);
  return row;
}

describe('recordAction', () => {
  it('defaults to the owner seat, the only one that exists today', async () => {
    await log({ target: 'a' });
    expect((await rowFor('a')).seat_key).toBe('owner');
    expect(ownerSeat(WORKSPACE_ID)).toEqual(SEAT);
  });

  it('stamps recorded_at for a counted status and leaves it null for one that never happened', async () => {
    // Windows read recorded_at, never created_at: a row written today for a
    // slot next Tuesday must not consume today's 24h budget.
    await log({ target: 'sent-one', status: 'sent' });
    expect((await rowFor('sent-one')).recorded_at).not.toBeNull();

    await log({ target: 'planned-one', status: 'planned' });
    expect((await rowFor('planned-one')).recorded_at).toBeNull();

    await log({ target: 'skipped-one', status: 'skipped' });
    expect((await rowFor('skipped-one')).recorded_at).toBeNull();
  });

  it('honours an explicitly supplied recorded_at, including an explicit null', async () => {
    await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'explicit', status: 'sent', source: 'manual', recordedAt: null },
      NOW
    );
    expect((await rowFor('explicit')).recorded_at).toBeNull();
  });

  it('reports a repeat as a duplicate instead of queueing a second invite to the same person', async () => {
    const first = await log({ target: 'https://in/dupe' });
    const second = await log({ target: 'https://in/dupe' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('scopes the replay guard to the kind, so a DM after an invite is a new action', async () => {
    await log({ target: 'https://in/both', kind: 'invite' });
    const dm = await log({ target: 'https://in/both', kind: 'dm' });
    expect(dm.duplicate).toBe(false);
  });

  it('releases a target that was skipped: nothing went out, so it can be tried again', async () => {
    await log({ target: 'https://in/released', status: 'skipped' });
    const retry = await log({ target: 'https://in/released', status: 'sent' });
    expect(retry.duplicate).toBe(false);
  });
});

describe('countActionsInWindow', () => {
  it('counts only what actually consumed budget', async () => {
    await log({ status: 'exported' });
    await log({ status: 'sent' });
    await log({ status: 'accepted' });
    await log({ status: 'replied' });
    await log({ status: 'declined' });
    // Neither of these happened.
    await log({ status: 'planned' });
    await log({ status: 'skipped' });
    expect(await countActionsInWindow(db, SEAT, 'invite', 24, NOW)).toBe(5);
  });

  it('uses a strict rolling boundary: an action exactly one window old has aged out', async () => {
    await log({ hoursAgo: 23.9 });
    await log({ hoursAgo: 24 });
    await log({ hoursAgo: 25 });
    expect(await countActionsInWindow(db, SEAT, 'invite', 24, NOW)).toBe(1);
    expect(await countActionsInWindow(db, SEAT, 'invite', 26, NOW)).toBe(3);
  });

  it('is a rolling window, not a calendar day', async () => {
    // Five invites yesterday evening do not vanish because a clock passed
    // midnight -- and midnight in whose timezone was never defined anyway.
    for (let index = 0; index < 5; index += 1) await log({ hoursAgo: 20 });
    expect(await countActionsInWindow(db, SEAT, 'invite', 24, NOW)).toBe(5);
  });

  it('separates kinds, seats and workspaces', async () => {
    await log({ kind: 'invite' });
    await log({ kind: 'dm' });
    await log({ kind: 'invite', seatKey: 'second-seat' });
    await log({ kind: 'invite', workspaceId: 'ws_linkedin_actions_other' });
    expect(await countActionsInWindow(db, SEAT, 'invite', 24, NOW)).toBe(1);
    expect(await countActionsInWindow(db, SEAT, 'dm', 24, NOW)).toBe(1);
    expect(await countActionsInWindow(db, { workspaceId: WORKSPACE_ID, seatKey: 'second-seat' }, 'invite', 24, NOW)).toBe(1);
  });
});

describe('acceptanceRate', () => {
  it('reports null when nothing has been decided, so no caller throttles on silence', async () => {
    for (let index = 0; index < 10; index += 1) await log({ status: 'exported' });
    const rate = await acceptanceRate(db, SEAT, 7, NOW);
    expect(rate).toEqual({ decided: 0, accepted: 0, rate: null });
  });

  it('divides by DECIDED invites, not by sent ones', async () => {
    // An invite sitting unanswered is not a refusal. Counting it as one would
    // drag every fresh export toward zero and trip the throttle on evidence
    // that has not arrived yet.
    await log({ status: 'accepted' });
    await log({ status: 'declined' });
    for (let index = 0; index < 20; index += 1) await log({ status: 'exported' });
    const rate = await acceptanceRate(db, SEAT, 7, NOW);
    expect(rate.decided).toBe(2);
    expect(rate.rate).toBe(0.5);
  });

  it('treats a reply as an acceptance, because it implies one', async () => {
    await log({ status: 'replied' });
    await log({ status: 'declined' });
    const rate = await acceptanceRate(db, SEAT, 7, NOW);
    expect(rate.accepted).toBe(1);
    expect(rate.rate).toBe(0.5);
  });

  it('drops outcomes older than the window', async () => {
    await log({ status: 'accepted', hoursAgo: 24 * 8 });
    await log({ status: 'declined', hoursAgo: 24 * 8 });
    expect((await acceptanceRate(db, SEAT, 7, NOW)).rate).toBeNull();
    expect((await acceptanceRate(db, SEAT, 30, NOW)).rate).toBe(0.5);
  });

  it('measures invites, the only kind that can be accepted', async () => {
    await log({ kind: 'dm', status: 'declined' });
    await log({ kind: 'inmail', status: 'declined' });
    await log({ kind: 'invite', status: 'accepted' });
    const rate = await acceptanceRate(db, SEAT, 7, NOW);
    expect(rate.decided).toBe(1);
    expect(rate.rate).toBe(1);
  });
});

describe('dailyCountsForLastNDays', () => {
  it('returns exactly n buckets, oldest first, with the last 24 hours last', async () => {
    await log({ hoursAgo: 1 });
    await log({ hoursAgo: 25 });
    await log({ hoursAgo: 25 });
    await log({ hoursAgo: 49 });
    await log({ hoursAgo: 49 });
    await log({ hoursAgo: 49 });
    expect(await dailyCountsForLastNDays(db, SEAT, 'invite', 3, NOW)).toEqual([3, 2, 1]);
  });

  it('puts the boundary at exactly 24 hours', async () => {
    await log({ hoursAgo: 23.9 });
    await log({ hoursAgo: 24.1 });
    expect(await dailyCountsForLastNDays(db, SEAT, 'invite', 2, NOW)).toEqual([1, 1]);
  });

  it('drops anything older than the window rather than piling it into bucket 0', async () => {
    await log({ hoursAgo: 1 });
    await log({ hoursAgo: 73 });
    expect(await dailyCountsForLastNDays(db, SEAT, 'invite', 3, NOW)).toEqual([0, 0, 1]);
  });

  it('pads empty days with zeros so adjacent buckets stay comparable', async () => {
    expect(await dailyCountsForLastNDays(db, SEAT, 'invite', 5, NOW)).toEqual([0, 0, 0, 0, 0]);
  });

  it('ignores actions that never happened', async () => {
    await log({ hoursAgo: 1, status: 'planned' });
    await log({ hoursAgo: 1, status: 'skipped' });
    await log({ hoursAgo: 1, status: 'exported' });
    expect(await dailyCountsForLastNDays(db, SEAT, 'invite', 2, NOW)).toEqual([0, 1]);
  });
});

describe('hasTarget', () => {
  it('finds a target this seat has already touched, per kind', async () => {
    await log({ target: 'https://in/seen', kind: 'invite' });
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/seen')).toBe(true);
    expect(await hasTarget(db, SEAT, 'dm', 'https://in/seen')).toBe(false);
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/unseen')).toBe(false);
  });

  it('does not treat a skipped target as touched', async () => {
    await log({ target: 'https://in/skipped', status: 'skipped' });
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/skipped')).toBe(false);
  });

  it('excludes one named row so a claimed action is not its own duplicate', async () => {
    const claimed = await log({ target: 'https://in/claimed', status: 'planned' });
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/claimed')).toBe(true);
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/claimed', claimed.id)).toBe(false);
    // A different id leaves the real row visible: the exclusion is keyed on
    // the row, never on the target.
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/claimed', 'lact_someone_else')).toBe(true);
    // And an explicit null is the same as omitting it.
    expect(await hasTarget(db, SEAT, 'invite', 'https://in/claimed', null)).toBe(true);
  });
});
