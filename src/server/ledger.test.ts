import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { openDatabase, type Db } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { LOOP_COST_NO_ATTRIBUTION } from './loop-cost.js';

/**
 * The ledger export, the combined cost surface, and the agent stop reason
 * (docs/gtm-shell-shape.md sections 3.4, 3.5, 3.6 -- Wave B).
 *
 * TWO WORKSPACES THROUGHOUT, with real sessions rather than one workspace and a
 * trusting assertion. Every id in this area -- an export id, a run id -- is a
 * global identifier, and a scoping bug here does not look like a bug: it looks
 * like a working export that happens to contain somebody else's clients.
 */

let db: Db;
let app: Express;

const WORKSPACE_A = 'ws_ledger_a';
const WORKSPACE_B = 'ws_ledger_b';

let sessionA = '';
let sessionB = '';

/** A real row in `sessions`, hashed exactly as app.ts hashes the cookie it reads. */
async function seedSession(workspaceId: string, label: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(workspaceId, label, now);
  await db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(userId, workspaceId, `${userId}@trevra.test`, label, now);
  const token = randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(
    createHash('sha256').update(token).digest('hex'),
    userId,
    new Date(Date.now() + 86_400_000).toISOString(),
    now
  );
  return token;
}

function as(token: string) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `trevra_session=${token}`),
    post: (path: string) => request(app).post(path).set('Cookie', `trevra_session=${token}`)
  };
}

/**
 * A workspace with one of everything the export reads.
 *
 * The two model calls differ ONLY in `usage_reported`, which is the column the
 * whole confidence flag rests on -- seeding both is what makes "every line
 * carries its own flag" testable rather than asserted.
 */
async function seedLedger(workspaceId: string, marker: string): Promise<string> {
  const now = new Date().toISOString();
  const runId = `arun_${marker}`;

  await db.prepare(`
    INSERT INTO agent_runs (id,workspace_id,trigger,status,goal,step_count,max_steps,started_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(runId, workspaceId, 'manual', 'running', `goal for ${marker}`, 1, 12, now);

  await db.prepare(`
    INSERT INTO agent_run_steps (id,run_id,workspace_id,seq,kind,tool_name,input_json,output_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    `astep_${marker}`, runId, workspaceId, 1, 'tool', 'list-clients',
    JSON.stringify({ marker }), JSON.stringify({ nested: { evidence: marker } }), now
  );

  for (const [suffix, reported, cost] of [['hard', true, 42], ['soft', false, 10]] as const) {
    await db.prepare(`
      INSERT INTO agent_model_calls (id,workspace_id,run_id,model,prompt_tokens,completion_tokens,cost_cents,usage_reported,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(`amc_${marker}_${suffix}`, workspaceId, runId, 'gpt-4o-mini', reported ? 1000 : 0, reported ? 200 : 0, cost, reported, now);
  }

  await db.prepare(`
    INSERT INTO skill_runs (id,skill_id,skill_version,workspace_id,status,input_json,output_json,evidence_json,started_at)
    VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?)
  `).run(
    `srun_${marker}`, 'gtm.score-lead', '1.0.0', workspaceId, 'ok',
    JSON.stringify({ marker }), JSON.stringify({ overall: 80 }),
    JSON.stringify([{ label: 'Source', excerpt: marker }]), now
  );

  await db.prepare(`
    INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,recorded_at,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(`lact_${marker}`, workspaceId, 'owner', 'invite', `https://linkedin.test/${marker}`, 'accepted', now, 'manual', now);

  return runId;
}

/**
 * A ZIP reader, written out here rather than pulled in.
 *
 * It walks local file headers, which is only valid because zip.ts never sets
 * general-purpose bit 3 -- the sizes are in the header, not in a trailing data
 * descriptor. If that ever changes this loop stops finding entries, which is
 * the failure we want: loudly, in a test.
 */
function unzip(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const raw = archive.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    expect(data.length).toBe(uncompressedSize);
    files.set(name, data);
    offset = start + compressedSize;
  }
  return files;
}

function ndjson(file: Buffer): Array<Record<string, unknown>> {
  return file.toString('utf8').split('\n').filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Supertest hands back a parsed object by default; a zip has to be read as bytes. */
function binary(res: NodeJS.EventEmitter & { setEncoding: (encoding: string) => void }, callback: (error: Error | null, body: unknown) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); });
  res.on('end', () => { callback(null, Buffer.concat(chunks)); });
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  sessionA = await seedSession(WORKSPACE_A, 'Ledger A');
  sessionB = await seedSession(WORKSPACE_B, 'Ledger B');
  await seedLedger(WORKSPACE_A, 'alpha');
  await seedLedger(WORKSPACE_B, 'bravo');
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('POST /api/ledger/exports', () => {
  it('renders NDJSON per table plus a manifest whose sha256 pins every file', async () => {
    const created = (await as(sessionA)
      .post('/api/ledger/exports')
      .send({ window: 30, include: ['runs', 'steps', 'evidence', 'approvals', 'actions'] })
      .expect(201)).body as { id: string; counts: Record<string, number>; sha256: Record<string, string>; filename: string };

    expect(created.counts.agent_runs).toBe(1);
    expect(created.counts.agent_run_steps).toBe(1);
    expect(created.counts.skill_runs).toBe(1);
    expect(created.counts.evidence).toBe(1);
    expect(created.counts.linkedin_actions).toBe(1);
    // The query ran and found nothing, which is a different fact from "not asked
    // for" -- an approvals key missing entirely would hide a broken join.
    expect(created.counts.approvals).toBe(0);

    const download = await as(sessionA)
      .get(`/api/ledger/exports/${created.id}`)
      .buffer(true)
      .parse(binary as never)
      .expect(200);

    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${created.filename}"`);
    // The archive names clients, message bodies and outreach targets. A cache
    // that outlives a deletion keeps handing back somebody who asked to go.
    expect(download.headers['cache-control']).toBe('no-store');

    const files = unzip(download.body as Buffer);
    expect(files.has('manifest.json')).toBe(true);

    const manifest = JSON.parse((files.get('manifest.json') as Buffer).toString('utf8')) as {
      workspaceId: string;
      files: Array<{ name: string; rows: number; sha256: string; truncated: boolean }>;
    };
    expect(manifest.workspaceId).toBe(WORKSPACE_A);

    for (const entry of manifest.files) {
      const bytes = files.get(entry.name);
      expect(bytes, `${entry.name} is missing from the archive`).toBeDefined();
      // The whole point of publishing a digest: it has to name these bytes.
      expect(createHash('sha256').update(bytes as Buffer).digest('hex')).toBe(entry.sha256);
      expect(entry.sha256).toBe(created.sha256[entry.name]);
      expect(entry.truncated).toBe(false);
    }

    // The evidence survives as evidence, not as a flattened cell.
    const steps = ndjson(files.get('agent_run_steps.ndjson') as Buffer);
    expect(JSON.parse(String(steps[0]?.output_json))).toEqual({ nested: { evidence: 'alpha' } });
    const evidence = ndjson(files.get('evidence.ndjson') as Buffer);
    expect(evidence[0]?.evidence).toEqual({ label: 'Source', excerpt: 'alpha' });
  });

  it('never carries another workspace, and never serves another workspace its bytes', async () => {
    const created = (await as(sessionA).post('/api/ledger/exports').send({ window: 30 }).expect(201))
      .body as { id: string };

    const download = await as(sessionA)
      .get(`/api/ledger/exports/${created.id}`)
      .buffer(true)
      .parse(binary as never)
      .expect(200);

    const archive = (download.body as Buffer).toString('utf8');
    expect(archive.includes('bravo')).toBe(false);

    const files = unzip(download.body as Buffer);
    for (const [name, bytes] of files) {
      if (!name.endsWith('.ndjson')) continue;
      for (const row of ndjson(bytes)) {
        if ('workspace_id' in row) expect(row.workspace_id).toBe(WORKSPACE_A);
      }
    }

    // An export id is a global identifier. Looking one up without the scope
    // would hand B the whole of A's run ledger.
    await as(sessionB).get(`/api/ledger/exports/${created.id}`).expect(404);
  });

  it('honours the section list', async () => {
    const created = (await as(sessionA).post('/api/ledger/exports').send({ window: 30, include: ['runs'] }).expect(201))
      .body as { counts: Record<string, number>; sha256: Record<string, string> };
    expect(Object.keys(created.sha256).sort()).toEqual(['agent_runs.ndjson', 'playbook_runs.ndjson', 'skill_runs.ndjson']);
    expect(created.counts.linkedin_actions).toBeUndefined();
  });

  it('rejects an unknown section rather than silently dropping it', async () => {
    await as(sessionA).post('/api/ledger/exports').send({ window: 30, include: ['everything'] }).expect(400);
  });
});

describe('GET /api/loop/cost', () => {
  it('flags every spend line with who measured it, and refuses to attribute', async () => {
    const payload = (await as(sessionA).get('/api/loop/cost?window=30').expect(200)).body as {
      windowDays: number;
      spent: {
        costCents: number;
        calls: number;
        byModel: Array<{ model: string; costCents: number; usageReported: boolean; confidence: string }>;
      };
      sent: { actions: Array<{ kind: string; count: number }>; actionsTotal: number; agentRuns: { total: number; running: number } };
      produced: { accepted: number; replied: number; attribution: string };
    };

    expect(payload.windowDays).toBe(30);

    // One model, two claims: the provider measured one call and said nothing
    // about the other. Averaging them into a single line would erase the flag.
    expect(payload.spent.byModel).toHaveLength(2);
    const hard = payload.spent.byModel.find((line) => line.usageReported);
    const soft = payload.spent.byModel.find((line) => !line.usageReported);
    expect(hard?.confidence).toBe('HARD FACT');
    expect(soft?.confidence).toBe('REPORTED');
    expect(payload.spent.calls).toBe(2);
    expect(payload.spent.costCents).toBe(52);

    expect(payload.sent.actions).toEqual([{ kind: 'invite', count: 1 }]);
    expect(payload.sent.actionsTotal).toBe(1);
    expect(payload.sent.agentRuns.total).toBe(1);
    expect(payload.sent.agentRuns.running).toBe(1);

    expect(payload.produced.accepted).toBe(1);
    // Verbatim. The three rows are the same period and not the same causal
    // chain, and the payload says so rather than leaving the screen to imply it.
    expect(payload.produced.attribution).toBe(LOOP_COST_NO_ATTRIBUTION);
  });

  it('scopes spend to the caller', async () => {
    const b = (await as(sessionB).get('/api/loop/cost?window=30').expect(200)).body as {
      spent: { costCents: number; calls: number };
    };
    expect(b.spent.calls).toBe(2);
    expect(b.spent.costCents).toBe(52);
  });
});

describe('POST /api/agent-runs/stop', () => {
  it('records the reason it was given, once, and never overwrites it', async () => {
    const asked = (await as(sessionA)
      .post('/api/agent-runs/stop')
      .send({ runId: 'arun_alpha', reason: 'It was looping on the same invoice.' })
      .expect(200)).body as { stopped: number; requests: Array<{ runId: string; stopReason: string | null }> };

    expect(asked.stopped).toBe(1);
    expect(asked.requests[0]?.runId).toBe('arun_alpha');
    expect(asked.requests[0]?.stopReason).toBe('It was looping on the same invoice.');

    const stored = await db.prepare('SELECT stop_reason, stop_requested_at FROM agent_runs WHERE id=?')
      .get<{ stop_reason: string | null; stop_requested_at: string | null }>('arun_alpha');
    expect(stored?.stop_reason).toBe('It was looping on the same invoice.');
    expect(stored?.stop_requested_at).not.toBeNull();

    // A second click must not destroy the note written while it was happening.
    const again = (await as(sessionA).post('/api/agent-runs/stop').send({ reason: 'changed my mind' }).expect(200))
      .body as { stopped: number };
    expect(again.stopped).toBe(0);
    const unchanged = await db.prepare('SELECT stop_reason FROM agent_runs WHERE id=?')
      .get<{ stop_reason: string | null }>('arun_alpha');
    expect(unchanged?.stop_reason).toBe('It was looping on the same invoice.');

    // The stop stayed inside the workspace that asked for it.
    const other = await db.prepare('SELECT stop_reason, stop_requested_at FROM agent_runs WHERE id=?')
      .get<{ stop_reason: string | null; stop_requested_at: string | null }>('arun_bravo');
    expect(other?.stop_requested_at).toBeNull();
    expect(other?.stop_reason).toBeNull();
  });

  it('accepts a stop with no reason at all, and stores no placeholder', async () => {
    await db.prepare(`
      INSERT INTO agent_runs (id,workspace_id,trigger,status,goal,step_count,max_steps,started_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run('arun_silent', WORKSPACE_B, 'manual', 'running', 'no note given', 0, 12, new Date().toISOString());

    const asked = (await as(sessionB).post('/api/agent-runs/stop').send({}).expect(200)).body as { stopped: number };
    expect(asked.stopped).toBe(2);

    const stored = await db.prepare('SELECT stop_reason FROM agent_runs WHERE id=?')
      .get<{ stop_reason: string | null }>('arun_silent');
    // NULL means nobody said. A default string would be indistinguishable from
    // a real note three weeks from now, which is the failure the column exists
    // to prevent.
    expect(stored?.stop_reason).toBeNull();
  });
});
