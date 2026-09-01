import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { createWatch, deleteWatch, getWatch, listWatches, updateWatch } from './store.js';

let db: Db;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const OTHER_WORKSPACE = 'ws_other';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  // The fixed OTHER_WORKSPACE id (unlike a fresh id('ws') per test) would
  // otherwise leak a workspace -- and any watch created in it -- into every
  // later test in this file; resetDemoData only clears DEMO_WORKSPACE_ID.
  // Precedent: research/service.test.ts's afterEach workspace cleanup.
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(OTHER_WORKSPACE);
  await db?.close();
});

const INPUT = {
  name: 'Trevra',
  keywords: ['trevra', 'cold outreach'],
  platforms: ['hackernews', 'github'],
  cadence: 'daily' as const
};

describe('brand watch store', () => {
  it('creates a watch that is due immediately and defaults its limit', async () => {
    const watch = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(watch.name).toBe('Trevra');
    expect(watch.keywords).toEqual(['trevra', 'cold outreach']);
    expect(watch.platforms).toEqual(['hackernews', 'github']);
    expect(watch.cadence).toBe('daily');
    expect(watch.enabled).toBe(true);
    expect(watch.limitPerPlatform).toBe(25);
    expect(watch.lastRunAt).toBeNull();
    expect(new Date(watch.nextRunAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('rejects a second watch with the same name in one workspace', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await expect(createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW)).rejects.toThrow();
  });

  it('allows the same watch name in a different workspace', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(OTHER_WORKSPACE, 'Other', NOW.toISOString());
    const other = await createWatch(db, OTHER_WORKSPACE, INPUT, NOW);
    expect(other.workspaceId).toBe(OTHER_WORKSPACE);
  });

  it('lists only this workspace’s watches', async () => {
    await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const rows = await listWatches(db, DEMO_WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(await listWatches(db, OTHER_WORKSPACE)).toEqual([]);
  });

  it('patches only the supplied fields', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    const patched = await updateWatch(
      db,
      DEMO_WORKSPACE_ID,
      created.id,
      { cadence: 'weekly', enabled: false },
      NOW
    );
    expect(patched?.cadence).toBe('weekly');
    expect(patched?.enabled).toBe(false);
    expect(patched?.keywords).toEqual(['trevra', 'cold outreach']);
    expect(patched?.platforms).toEqual(['hackernews', 'github']);
  });

  it('will not read, patch or delete another workspace’s watch', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(await getWatch(db, OTHER_WORKSPACE, created.id)).toBeNull();
    expect(
      await updateWatch(db, OTHER_WORKSPACE, created.id, { cadence: 'weekly' }, NOW)
    ).toBeNull();
    expect(await deleteWatch(db, OTHER_WORKSPACE, created.id)).toBe(false);
    expect(await getWatch(db, DEMO_WORKSPACE_ID, created.id)).not.toBeNull();
  });

  it('deletes a watch and reports whether it existed', async () => {
    const created = await createWatch(db, DEMO_WORKSPACE_ID, INPUT, NOW);
    expect(await deleteWatch(db, DEMO_WORKSPACE_ID, created.id)).toBe(true);
    expect(await deleteWatch(db, DEMO_WORKSPACE_ID, created.id)).toBe(false);
  });
});
