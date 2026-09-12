import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { openDatabase, type Db } from '../db.js';
import { compileAccountMomentumIndex } from './index.js';

let db: Db;
const WORKSPACE = 'ws_content_index';
const OTHER = 'ws_content_index_other';
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

async function accountWithSignals(
  workspaceId: string,
  suffix: string,
  signals: Array<{ kind: string; at: string }>,
  tags: string[] = ['index-test']
): Promise<void> {
  const account = await createAccount(
    db,
    workspaceId,
    { domain: `${suffix}.index.example`, name: suffix, source: 'manual', tags },
    NOW
  );
  for (const [index, signal] of signals.entries()) {
    await db
      .prepare(
        `INSERT INTO account_signals
      (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        `sig_${workspaceId}_${suffix}_${index}`,
        workspaceId,
        account.id,
        signal.kind,
        `${suffix} ${signal.kind} ${index}`,
        `https://${suffix}.index.example/${signal.kind}/${index}`,
        signal.at,
        `fp_${workspaceId}_${suffix}_${index}`,
        signal.at
      );
  }
}

describe('compileAccountMomentumIndex', () => {
  it('ranks Accounts from explicit visible components and keeps tenants isolated', async () => {
    await accountWithSignals(WORKSPACE, 'alpha', [
      { kind: 'hiring-up', at: '2026-09-12T10:00:00.000Z' },
      { kind: 'pricing-changed', at: '2026-09-11T10:00:00.000Z' },
      { kind: 'tech-added', at: '2026-09-10T10:00:00.000Z' }
    ]);
    await accountWithSignals(WORKSPACE, 'beta', [
      { kind: 'hiring-up', at: '2026-09-12T09:00:00.000Z' },
      { kind: 'pricing-changed', at: '2026-09-09T10:00:00.000Z' }
    ]);
    await accountWithSignals(WORKSPACE, 'gamma', [
      { kind: 'hiring-up', at: '2026-09-01T10:00:00.000Z' }
    ]);
    await accountWithSignals(OTHER, 'foreign', [
      { kind: 'hiring-up', at: '2026-09-12T10:00:00.000Z' },
      { kind: 'pricing-changed', at: '2026-09-12T10:00:00.000Z' },
      { kind: 'tech-added', at: '2026-09-12T10:00:00.000Z' }
    ]);

    const result = await compileAccountMomentumIndex(
      db,
      WORKSPACE,
      { days: 30, tag: 'index-test' },
      NOW
    );
    expect(result).toMatchObject({ accountCount: 3, scoredAccountCount: 3, canPublish: true });
    expect(result.rows.map((row) => row.accountName)).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.rows[0]).toMatchObject({
      rank: 1,
      score: 88,
      distinctKinds: 3,
      signalCount: 3,
      components: { diversity: 50, activity: 18, recency: 20 }
    });
    expect(result.rows[1]).toMatchObject({
      score: 72,
      components: { diversity: 40, activity: 12, recency: 20 }
    });
    expect(result.rows[2]).toMatchObject({
      score: 36,
      components: { diversity: 20, activity: 6, recency: 10 }
    });
    expect(JSON.stringify(result)).not.toContain('foreign');
    expect(result.rows[0]?.evidence).toHaveLength(3);
  });

  it('refuses to publish a tiny ranking that would look more authoritative than it is', async () => {
    await accountWithSignals(WORKSPACE, 'one', [
      { kind: 'hiring-up', at: '2026-09-12T10:00:00.000Z' }
    ]);
    await accountWithSignals(WORKSPACE, 'two', [
      { kind: 'pricing-changed', at: '2026-09-12T10:00:00.000Z' }
    ]);
    const result = await compileAccountMomentumIndex(db, WORKSPACE, { days: 30 }, NOW);
    expect(result.canPublish).toBe(false);
    expect(result.publishBlocker).toContain('three active Accounts');
  });
});
