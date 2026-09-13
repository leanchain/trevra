import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { createWatch } from '../watch/store.js';
import {
  listMarketPulseSchedules,
  nextMarketPulseRunAt,
  runDueMarketPulseSchedules,
  upsertMarketPulseSchedule
} from './pulse-schedule.js';

let db: Db;
const WORKSPACE = 'ws_market_pulse_schedule';
const OTHER = 'ws_market_pulse_schedule_other';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
});

async function addWatchMention(
  workspaceId: string,
  watchId: string,
  idValue: string,
  url: string,
  at: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO brand_watch_mentions
       (id,workspace_id,watch_id,platform,external_id,url,title,content,score,num_comments,
        matched_keywords,sentiment_label,sentiment_score,sentiment_span,sentiment_version,content_hash,
        metadata_json,mention_created_at,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,'neutral',0,?,1,?,'{}'::jsonb,?,?,?)`
    )
    .run(
      idValue,
      workspaceId,
      watchId,
      'hackernews',
      `external-${idValue}`,
      url,
      `${idValue} title`,
      `${idValue} source-backed mention`,
      ['trevra'],
      `${idValue} source-backed mention`,
      `hash-${idValue}`,
      at,
      at,
      at
    );
}

async function addSignal(domain: string, name: string): Promise<void> {
  const account = await createAccount(db, WORKSPACE, { domain, name, source: 'manual' }, NOW);
  await db
    .prepare(
      `INSERT INTO account_signals
       (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id('sig'),
      WORKSPACE,
      account.id,
      'hiring-up',
      `${name} added engineering roles.`,
      `https://${domain}/careers`,
      '2026-09-11T10:00:00.000Z',
      `${domain}:hiring`,
      '2026-09-11T10:00:00.000Z'
    );
}

describe('Market Pulse schedules', () => {
  it('keeps schedules workspace-scoped and resets the due time when cadence changes', async () => {
    const created = await upsertMarketPulseSchedule(
      db,
      { workspaceId: WORKSPACE, cadence: 'weekly', enabled: true },
      NOW
    );
    await upsertMarketPulseSchedule(
      db,
      { workspaceId: OTHER, cadence: 'monthly', enabled: true },
      NOW
    );
    expect(await listMarketPulseSchedules(db, WORKSPACE)).toEqual([
      expect.objectContaining({ id: created.id, cadence: 'weekly', enabled: true })
    ]);

    const later = new Date('2026-09-13T09:00:00.000Z');
    const changed = await upsertMarketPulseSchedule(
      db,
      { workspaceId: WORKSPACE, cadence: 'monthly', enabled: true },
      later
    );
    expect(changed.id).toBe(created.id);
    expect(changed.nextRunAt).toBe(nextMarketPulseRunAt(later, 'monthly').toISOString());
  });

  it('prepares one ordinary draft when a due cross-account pulse exists and advances the schedule', async () => {
    await addSignal('one.example', 'One');
    await addSignal('two.example', 'Two');
    const schedule = await upsertMarketPulseSchedule(
      db,
      { workspaceId: WORKSPACE, cadence: 'weekly', enabled: true },
      NOW
    );
    await db
      .prepare('UPDATE content_pulse_schedules SET next_run_at=? WHERE workspace_id=? AND id=?')
      .run(NOW.toISOString(), WORKSPACE, schedule.id);

    const first = await runDueMarketPulseSchedules(db, WORKSPACE, NOW);
    expect(first).toEqual({ checked: 1, prepared: 1, blocked: 0, failed: 0 });
    const posts = await db
      .prepare(
        `SELECT status,scheduled_at,published_at FROM linkedin_posts
         WHERE workspace_id=? AND content_asset_id IS NOT NULL`
      )
      .all<Record<string, unknown>>(WORKSPACE);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ status: 'draft', scheduled_at: null, published_at: null });

    const afterRun = (await listMarketPulseSchedules(db, WORKSPACE))[0]!;
    expect(afterRun.lastPostId).toBeTruthy();
    expect(afterRun.lastBlocker).toBeNull();
    expect(afterRun.nextRunAt).toBe(nextMarketPulseRunAt(NOW, 'weekly').toISOString());

    const replay = await runDueMarketPulseSchedules(db, WORKSPACE, NOW);
    expect(replay.checked).toBe(0);
    const count = await db
      .prepare('SELECT COUNT(*)::int AS count FROM linkedin_posts WHERE workspace_id=?')
      .get<{ count: number }>(WORKSPACE);
    expect(count?.count).toBe(1);
  });

  it('advances a blocked schedule instead of retrying every worker tick', async () => {
    await addSignal('solo.example', 'Solo');
    const schedule = await upsertMarketPulseSchedule(
      db,
      { workspaceId: WORKSPACE, cadence: 'weekly', enabled: true },
      NOW
    );
    await db
      .prepare('UPDATE content_pulse_schedules SET next_run_at=? WHERE workspace_id=? AND id=?')
      .run(NOW.toISOString(), WORKSPACE, schedule.id);
    const result = await runDueMarketPulseSchedules(db, WORKSPACE, NOW);
    expect(result).toEqual({ checked: 1, prepared: 0, blocked: 1, failed: 0 });
    const afterBlockedRun = (await listMarketPulseSchedules(db, WORKSPACE))[0]!;
    expect(afterBlockedRun.lastBlocker).toContain('at least two active Accounts');
    expect(new Date(afterBlockedRun.nextRunAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('prepares a recurring Brand-watch Pulse through the same scheduler and rejects a foreign watch', async () => {
    const watch = await createWatch(
      db,
      WORKSPACE,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    await addWatchMention(
      WORKSPACE,
      watch.id,
      'watch_sched_one',
      'https://news.ycombinator.com/item?id=watch-sched-one',
      '2026-09-11T10:00:00.000Z'
    );
    await addWatchMention(
      WORKSPACE,
      watch.id,
      'watch_sched_two',
      'https://news.ycombinator.com/item?id=watch-sched-two',
      '2026-09-12T10:00:00.000Z'
    );
    const schedule = await upsertMarketPulseSchedule(
      db,
      {
        workspaceId: WORKSPACE,
        scopeType: 'brand_watch',
        watchId: watch.id,
        cadence: 'weekly',
        enabled: true
      },
      NOW
    );
    expect(schedule).toMatchObject({
      scopeType: 'brand_watch',
      watchId: watch.id,
      tag: null
    });
    await db
      .prepare('UPDATE content_pulse_schedules SET next_run_at=? WHERE workspace_id=? AND id=?')
      .run(NOW.toISOString(), WORKSPACE, schedule.id);

    const result = await runDueMarketPulseSchedules(db, WORKSPACE, NOW);
    expect(result).toEqual({ checked: 1, prepared: 1, blocked: 0, failed: 0 });
    const after = (await listMarketPulseSchedules(db, WORKSPACE)).find(
      (item) => item.id === schedule.id
    );
    expect(after?.lastPostId).toBeTruthy();
    expect(after?.lastBlocker).toBeNull();

    const foreignWatch = await createWatch(
      db,
      OTHER,
      { name: 'Foreign', keywords: ['foreign'], platforms: ['reddit'], cadence: 'daily' },
      NOW
    );
    await expect(
      upsertMarketPulseSchedule(
        db,
        {
          workspaceId: WORKSPACE,
          scopeType: 'brand_watch',
          watchId: foreignWatch.id,
          cadence: 'weekly',
          enabled: true
        },
        NOW
      )
    ).rejects.toThrow(/Brand watch not found/i);
  });

  it('clamps monthly recurrences to the last valid day of the target month', () => {
    expect(
      nextMarketPulseRunAt(new Date('2026-01-31T12:00:00.000Z'), 'monthly').toISOString()
    ).toBe('2026-02-28T12:00:00.000Z');
  });
});
