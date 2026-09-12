import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { compileAccountMarketPulse, materializeAccountMarketPulse } from './pulse.js';

let db: Db;
const WORKSPACE = 'ws_market_pulse';
const OTHER = 'ws_market_pulse_other';
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

async function signal(
  workspaceId: string,
  domain: string,
  name: string,
  kind: string,
  at: string,
  tags: string[] = []
): Promise<void> {
  const account = await createAccount(
    db,
    workspaceId,
    { domain, name, source: 'manual', tags },
    NOW
  );
  await db
    .prepare(
      `INSERT INTO account_signals
       (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id('sig'),
      workspaceId,
      account.id,
      kind,
      `${name} ${kind}.`,
      `https://${domain}/${kind}`,
      at,
      `${domain}:${kind}:${at}`,
      at
    );
}

describe('account market pulse', () => {
  it('compiles cross-account patterns from source-backed changes and keeps tenants isolated', async () => {
    await signal(WORKSPACE, 'one.example', 'One', 'hiring-up', '2026-09-10T10:00:00.000Z');
    await signal(WORKSPACE, 'two.example', 'Two', 'hiring-up', '2026-09-11T10:00:00.000Z');
    await signal(
      WORKSPACE,
      'three.example',
      'Three',
      'pricing-changed',
      '2026-09-12T10:00:00.000Z'
    );
    await signal(OTHER, 'foreign.example', 'Foreign', 'hiring-up', '2026-09-12T11:00:00.000Z');

    const pulse = await compileAccountMarketPulse(db, WORKSPACE, { days: 7 }, NOW);
    expect(pulse).toMatchObject({
      accountCount: 3,
      changedAccountCount: 3,
      signalCount: 3,
      canDraft: true
    });
    expect(pulse.patterns[0]).toMatchObject({
      kind: 'hiring-up',
      accountCount: 2,
      signalCount: 2
    });
    expect(pulse.patterns[0]?.examples.map((row) => row.accountName).sort()).toEqual([
      'One',
      'Two'
    ]);
    expect(JSON.stringify(pulse)).not.toContain('Foreign');
  });

  it('uses an existing Account tag as scope without inventing a Market entity', async () => {
    await signal(
      WORKSPACE,
      'dev-one.example',
      'Dev One',
      'tech-added',
      '2026-09-10T10:00:00.000Z',
      ['devtools']
    );
    await signal(
      WORKSPACE,
      'dev-two.example',
      'Dev Two',
      'tech-added',
      '2026-09-11T10:00:00.000Z',
      ['devtools']
    );
    await signal(WORKSPACE, 'fin.example', 'Fin', 'pricing-changed', '2026-09-11T11:00:00.000Z', [
      'fintech'
    ]);

    const pulse = await compileAccountMarketPulse(db, WORKSPACE, { days: 7, tag: 'DEVTOOLS' }, NOW);
    expect(pulse.scope).toEqual({ type: 'accounts', tag: 'DEVTOOLS' });
    expect(pulse.accountCount).toBe(2);
    expect(pulse.patterns).toEqual([
      expect.objectContaining({ kind: 'tech-added', accountCount: 2 })
    ]);
  });

  it('refuses to call a single-company event a market pattern and materializes a source-complete story when cross-account evidence exists', async () => {
    await signal(WORKSPACE, 'solo.example', 'Solo', 'hiring-up', '2026-09-11T10:00:00.000Z');
    const single = await materializeAccountMarketPulse(db, WORKSPACE, { days: 7 }, NOW);
    expect(single.opportunity).toBeNull();
    expect(single.pulse.canDraft).toBe(false);

    await signal(WORKSPACE, 'pair.example', 'Pair', 'hiring-up', '2026-09-12T10:00:00.000Z');
    const cross = await materializeAccountMarketPulse(db, WORKSPACE, { days: 7 }, NOW);
    expect(cross.opportunity).toMatchObject({ kind: 'market_pattern', status: 'ready' });
    expect(cross.opportunity?.thesis).toContain('2 companies');
    expect(cross.opportunity?.evidence).toHaveLength(2);
    expect(new Set(cross.opportunity?.evidence.map((row) => row.sourceId)).size).toBe(2);
  });
});
