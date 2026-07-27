import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { getSkill, listSkills, registerSkill, seedSkills } from './registry.js';
import { redactForLedger, runSkill } from './runner.js';
import type { Skill, SkillContext } from './types.js';

let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function openTestDatabase(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  return db;
}

function contextFor(database: Db, clock = new Date('2026-07-26T10:00:00.000Z')): SkillContext {
  return { db: database, workspaceId: DEMO_WORKSPACE_ID, now: () => clock };
}

const explodingSkill: Skill<{ boom: boolean }, { ok: boolean }> = {
  manifest: {
    id: 'test.explodes',
    name: 'Exploding test skill',
    version: '0.0.1',
    description: 'Always throws.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema: z.object({ boom: z.boolean() }),
    outputSchema: z.object({ ok: z.boolean() })
  },
  async run() {
    throw new Error('skill exploded on purpose');
  }
};

const liarSkill: Skill<Record<string, never>, unknown> = {
  manifest: {
    id: 'test.lies',
    name: 'Lying test skill',
    version: '0.0.1',
    description: 'Returns something its own output schema rejects.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema: z.object({}),
    outputSchema: z.object({ count: z.number() })
  },
  async run() {
    return { count: 'not a number' };
  }
};

registerSkill(explodingSkill);
registerSkill(liarSkill);

interface RunRow {
  id: string;
  skill_id: string;
  skill_version: string;
  workspace_id: string;
  status: string;
  input_json: unknown;
  output_json: unknown;
  error: string | null;
  evidence_json: unknown;
  duration_ms: number | null;
}

async function ledgerRow(database: Db, runId: string): Promise<RunRow | undefined> {
  return database.prepare('SELECT * FROM skill_runs WHERE id=?').get<RunRow & Record<string, unknown>>(runId);
}

describe('skill registry', () => {
  it('registers every ported skill under a stable id', () => {
    const ids = listSkills().map((skill) => skill.manifest.id);
    expect(ids).toEqual(expect.arrayContaining([
      'gtm.lead-status',
      'gtm.outreach-draft',
      'gtm.score-lead',
      'gtm.visibility-audit',
      'net.validate-host'
    ]));
    expect(getSkill('gtm.score-lead')?.manifest.sideEffect).toBe('none');
    expect(getSkill('gtm.visibility-audit')?.manifest.sideEffect).toBe('network-read');
    expect(getSkill('gtm.outreach-draft')?.manifest.requiresApproval).toBe(true);
  });

  it('never overwrites an already-registered id', () => {
    const imposter: Skill<unknown, unknown> = {
      manifest: { ...explodingSkill.manifest, name: 'Imposter' },
      async run() {
        return {};
      }
    };
    expect(registerSkill(imposter).manifest.name).toBe('Exploding test skill');
    expect(getSkill('test.explodes')?.manifest.name).toBe('Exploding test skill');
  });

  it('seeds idempotently without clobbering operator state', async () => {
    const database = await openTestDatabase();
    await seedSkills(database);
    await database.prepare("UPDATE skills SET enabled=FALSE, config_json='{\"tuned\":true}'::jsonb WHERE id=?").run('gtm.score-lead');
    await seedSkills(database);

    const row = await database.prepare('SELECT enabled,config_json,name FROM skills WHERE id=?')
      .get<{ enabled: boolean; config_json: Record<string, unknown>; name: string }>('gtm.score-lead');
    expect(row?.enabled).toBe(false);
    expect(row?.config_json).toEqual({ tuned: true });
    expect(row?.name).toBe('Score lead fit');

    const count = await database.prepare('SELECT COUNT(*)::int AS total FROM skills').get<{ total: number }>();
    expect(count?.total).toBeGreaterThanOrEqual(listSkills().length);
  });
});

describe('redactForLedger', () => {
  it('passes an ordinary output through untouched', () => {
    const output = { score: 48, evidence: [] };
    expect(redactForLedger(output)).toBe(output);
    expect(redactForLedger(null)).toBeNull();
  });

  it('replaces a retention:none payload with a stub that still records the refusal', () => {
    const redacted = redactForLedger({ retention: 'none', candidates: ['acme.test'] }) as Record<string, unknown>;
    expect(redacted.retention).toBe('none');
    expect(redacted.candidates).toBeUndefined();
    expect(String(redacted.withheld)).toContain('do not permit storing');
  });
});

describe('runSkill', () => {
  it('records a ledger row on success', async () => {
    const database = await openTestDatabase();
    await seedSkills(database);
    // `skills` is not workspace-scoped, so the counter survives resetDemoData
    // and any earlier run against this database; assert the delta, not the value.
    const before = await database.prepare('SELECT run_count FROM skills WHERE id=?').get<{ run_count: number }>('gtm.score-lead');
    const run = await runSkill('gtm.score-lead', { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } }, contextFor(database));

    expect(run.status).toBe('ok');
    expect(run.error).toBeNull();
    expect(run.skillId).toBe('gtm.score-lead');
    expect(run.skillVersion).toBe('1.0.0');
    expect((run.output as { wedge: string }).wedge).toBe('sizing');

    const row = await ledgerRow(database, run.id);
    expect(row?.status).toBe('ok');
    expect(row?.workspace_id).toBe(DEMO_WORKSPACE_ID);
    expect(row?.skill_version).toBe('1.0.0');
    expect(row?.error).toBeNull();
    expect((row?.output_json as { wedge: string }).wedge).toBe('sizing');

    const counter = await database.prepare('SELECT run_count,last_run_at FROM skills WHERE id=?')
      .get<{ run_count: number; last_run_at: string | null }>('gtm.score-lead');
    expect(counter?.run_count).toBe((before?.run_count ?? 0) + 1);
    expect(counter?.last_run_at).not.toBeNull();
  });

  it('records a ledger row on skill failure without throwing', async () => {
    const database = await openTestDatabase();
    await seedSkills(database);
    const run = await runSkill('test.explodes', { boom: true }, contextFor(database));

    expect(run.status).toBe('error');
    expect(run.error).toBe('skill exploded on purpose');
    expect(run.output).toBeNull();

    const row = await ledgerRow(database, run.id);
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('skill exploded on purpose');
    expect(row?.input_json).toEqual({ boom: true });
  });

  it('records an output-schema violation as an error and keeps the raw output', async () => {
    const database = await openTestDatabase();
    const run = await runSkill('test.lies', {}, contextFor(database));

    expect(run.status).toBe('error');
    expect(run.error).toContain('produced an invalid output');
    expect(run.output).toEqual({ count: 'not a number' });
    expect(run.evidence).toEqual([]);

    const row = await ledgerRow(database, run.id);
    expect(row?.status).toBe('error');
    expect(row?.output_json).toEqual({ count: 'not a number' });
  });

  it('throws on input validation failure and writes nothing', async () => {
    const database = await openTestDatabase();
    const before = await database.prepare('SELECT COUNT(*)::int AS total FROM skill_runs').get<{ total: number }>();
    await expect(runSkill('gtm.score-lead', { lead: { catalogSize: 'many' } }, contextFor(database))).rejects.toThrow();
    const after = await database.prepare('SELECT COUNT(*)::int AS total FROM skill_runs').get<{ total: number }>();
    expect(after?.total).toBe(before?.total);
  });

  it('throws for an unknown skill id', async () => {
    const database = await openTestDatabase();
    await expect(runSkill('gtm.nope', {}, contextFor(database))).rejects.toThrow('Unknown skill: gtm.nope');
  });

  it('lifts skill evidence into the ledger row', async () => {
    const database = await openTestDatabase();
    const evidenceSkill: Skill<Record<string, never>, { evidence: Array<{ label: string; detail: string }> }> = {
      manifest: {
        id: 'test.evidence',
        name: 'Evidence test skill',
        version: '0.0.1',
        description: 'Publishes evidence.',
        sideEffect: 'none',
        requiresApproval: false,
        inputSchema: z.object({}),
        outputSchema: z.object({ evidence: z.array(z.object({ label: z.string(), detail: z.string() })) })
      },
      async run() {
        return { evidence: [{ label: 'robots.txt', detail: 'GPTBot is blocked' }] };
      }
    };
    registerSkill(evidenceSkill);

    const run = await runSkill('test.evidence', {}, contextFor(database));
    expect(run.evidence).toEqual([{ label: 'robots.txt', detail: 'GPTBot is blocked' }]);
    const row = await ledgerRow(database, run.id);
    expect(row?.evidence_json).toEqual([{ label: 'robots.txt', detail: 'GPTBot is blocked' }]);
  });

  it('keeps the ledger row but drops a payload the provider licence forbids storing', async () => {
    const database = await openTestDatabase();
    const licensedSkill: Skill<Record<string, never>, unknown> = {
      manifest: {
        id: 'test.licensed',
        name: 'Licensed test skill',
        version: '0.0.1',
        description: 'Returns third-party data that may not be stored.',
        sideEffect: 'network-read',
        requiresApproval: false,
        inputSchema: z.object({}),
        outputSchema: z.object({
          retention: z.literal('none'),
          candidates: z.array(z.string()),
          evidence: z.array(z.object({ label: z.string(), detail: z.string() }))
        })
      },
      async run() {
        return { retention: 'none', candidates: ['acme.test'], evidence: [{ label: 'vendor', detail: 'acme.test' }] };
      }
    };
    registerSkill(licensedSkill);

    const run = await runSkill('test.licensed', {}, contextFor(database));

    expect(run.status).toBe('ok');
    // The caller still gets the data, in memory.
    expect((run.output as { candidates: string[] }).candidates).toEqual(['acme.test']);
    // The ledger keeps the fact of the run and nothing the licence covers.
    expect(run.evidence).toEqual([]);
    const row = await ledgerRow(database, run.id);
    expect(row?.status).toBe('ok');
    expect(row?.evidence_json).toEqual([]);
    expect(row?.output_json).toMatchObject({ retention: 'none' });
    expect(JSON.stringify(row?.output_json)).not.toContain('acme.test');
  });

  it('measures duration from the injected clock', async () => {
    const database = await openTestDatabase();
    let tick = 0;
    const ctx: SkillContext = {
      db: database,
      workspaceId: DEMO_WORKSPACE_ID,
      now: () => new Date(Date.UTC(2026, 6, 26, 10, 0, 0) + (tick++ * 250))
    };
    const run = await runSkill('gtm.lead-status', { currentStatus: 'new', targetStatus: 'enriched', domain: 'https://www.Shop.Example/x' }, ctx);
    expect(run.durationMs).toBe(250);
    expect((run.output as { allowed: boolean; normalizedDomain: string }).allowed).toBe(true);
    expect((run.output as { normalizedDomain: string }).normalizedDomain).toBe('shop.example');
  });
});
