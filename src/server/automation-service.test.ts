import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase, type Db } from './db.js';
import { resetAutomationRotation, runAllAutomationCycles } from './automation-service.js';

/**
 * The multi-tenant sweep: concurrency, leasing, isolation, rotation.
 *
 * ITS OWN DATABASE, because every assertion here is about WHICH workspaces the
 * sweep picked and in what order, and `workspaces` in the shared test database
 * holds whatever the rest of the suite has created.
 *
 * `runCycle` is injected throughout. What one workspace's cycle does is
 * `runAutomationCycle`'s business and is covered where that behaviour lives;
 * what is under test here is the loop around it.
 */
const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const WORKSPACES = ['ws_auto_a', 'ws_auto_b', 'ws_auto_c', 'ws_auto_d', 'ws_auto_e'];

let db: Db;
let scratchUrl = '';
let scratchName = '';

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  scratchName = `trevra_automation_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin(`CREATE DATABASE "${scratchName}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${scratchName}`;
  scratchUrl = url.toString();
  db = await openDatabase({ connectionString: scratchUrl, seedDemo: false });
  for (const workspaceId of WORKSPACES) {
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, workspaceId, new Date().toISOString());
  }
});

afterAll(async () => {
  await db.close();
  await admin(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
});

beforeEach(() => resetAutomationRotation());

describe('runAllAutomationCycles', () => {
  it('runs tenants with bounded concurrency instead of one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const result = await runAllAutomationCycles(db, {
      concurrency: 2,
      batchSize: WORKSPACES.length,
      runCycle: async (_db, workspaceId) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        seen.push(workspaceId);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
      }
    });
    expect(result).toMatchObject({ claimed: 5, skipped: 0, failed: 0, deferred: 0 });
    expect([...seen].sort()).toEqual([...WORKSPACES].sort());
    expect(peak).toBe(2);
  });

  it('leases every tenant it starts, so a second worker takes none of them', async () => {
    const other = await openDatabase({ connectionString: scratchUrl, seedDemo: false });
    let started = 0;
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const first = runAllAutomationCycles(db, {
      concurrency: WORKSPACES.length,
      batchSize: WORKSPACES.length,
      runCycle: async () => { started += 1; await gate; }
    });
    try {
      await waitFor(() => started === WORKSPACES.length, 'every tenant to be claimed');
      resetAutomationRotation();
      const secondSeen: string[] = [];
      const second = await runAllAutomationCycles(other, {
        concurrency: WORKSPACES.length,
        batchSize: WORKSPACES.length,
        runCycle: async (_db, workspaceId) => { secondSeen.push(workspaceId); }
      });
      expect(second).toMatchObject({ claimed: 0, skipped: 5, failed: 0 });
      expect(secondSeen).toEqual([]);
    } finally {
      openGate();
      await expect(first).resolves.toMatchObject({ claimed: 5, skipped: 0 });
      await other.close();
    }
  });

  it('hands a released tenant to the next worker', async () => {
    const other = await openDatabase({ connectionString: scratchUrl, seedDemo: false });
    try {
      await runAllAutomationCycles(db, { concurrency: 1, batchSize: WORKSPACES.length, runCycle: async () => {} });
      resetAutomationRotation();
      const result = await runAllAutomationCycles(other, { concurrency: 1, batchSize: WORKSPACES.length, runCycle: async () => {} });
      expect(result).toMatchObject({ claimed: 5, skipped: 0 });
    } finally {
      await other.close();
    }
  });

  it('keeps one failing tenant off every other tenant', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const result = await runAllAutomationCycles(db, {
      concurrency: 2,
      batchSize: WORKSPACES.length,
      runCycle: async (_db, workspaceId) => {
        seen.push(workspaceId);
        if (workspaceId === 'ws_auto_c') throw new Error('tenant exploded');
      }
    });
    errors.mockRestore();
    expect(result).toMatchObject({ claimed: 4, failed: 1, skipped: 0, deferred: 0 });
    expect([...seen].sort()).toEqual([...WORKSPACES].sort());
  });

  it('rotates instead of starting from the head of the tenant list every tick', async () => {
    const ticks: string[][] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const seen: string[] = [];
      await runAllAutomationCycles(db, { concurrency: 1, batchSize: 2, runCycle: async (_db, workspaceId) => { seen.push(workspaceId); } });
      ticks.push(seen);
    }
    expect(ticks[0]).toEqual(['ws_auto_a', 'ws_auto_b']);
    expect(ticks[1]).toEqual(['ws_auto_c', 'ws_auto_d']);
    // The wrap: the tail, then back to the head, so no tenant is starved.
    expect(ticks[2]).toEqual(['ws_auto_e', 'ws_auto_a']);
  });

  it('defers the rest of the batch when the tick budget is spent', async () => {
    const seen: string[] = [];
    const result = await runAllAutomationCycles(db, {
      concurrency: 1,
      batchSize: WORKSPACES.length,
      budgetMs: 40,
      runCycle: async (_db, workspaceId) => {
        seen.push(workspaceId);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.claimed + result.deferred).toBe(WORKSPACES.length);
  });

  it('does nothing, cheaply, with no tenants', async () => {
    const empty = await openDatabase({ connectionString: scratchUrl, seedDemo: false });
    try {
      await empty.prepare('DELETE FROM workspaces WHERE id = ANY(?::text[])').run(WORKSPACES);
      resetAutomationRotation();
      const result = await runAllAutomationCycles(empty, { runCycle: async () => { throw new Error('must not run'); } });
      expect(result).toEqual({ claimed: 0, skipped: 0, failed: 0, deferred: 0 });
    } finally {
      for (const workspaceId of WORKSPACES) {
        await empty.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
          .run(workspaceId, workspaceId, new Date().toISOString());
      }
      await empty.close();
    }
  });
});
