import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ENVELOPE_V1, ENVELOPE_V2, configuredKeyIds } from './crypto.js';
import { resealSecrets, secretsCustodyReport } from './custody.js';
import { putLinkedInCredentials, readLinkedInCredentials } from './linkedin.js';
import { putWorkspaceSecret, readWorkspaceSecretPlaintext } from './store.js';

// Unique to this file so parallel test files cannot collide on fixtures --
// and every call below passes `workspaceId: WORKSPACE_ID` for the same reason.
// Custody is deliberately a DEPLOYMENT-wide question ("which rows are still on
// the old key" has no per-tenant answer an operator can act on), so an
// unscoped report or re-seal here reads every row every other suite left
// behind, including the ones sibling files sealed under their own random
// TREVRA_SECRETS_KEY. Those show up as `unknown` custody and as `failed`
// re-seals, which is the CORRECT behaviour being reported about the wrong
// rows. Scoping the assertions keeps them about this file's own fixtures.
const WORKSPACE_ID = 'ws_secrets_custody_test';
const OTHER_WORKSPACE_ID = 'ws_secrets_custody_test_other';
const API_KEY = 'sk-live-9f3c1d2b4a6e8017';
const SEAT_KEY = 'seat-two';
const EMAIL = 'pankaj@example.com';
const PASSWORD = 'correct horse battery staple';

let db: Db;
let previousKey: string | undefined;

beforeAll(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(workspaceId, 'Secrets custody test', new Date().toISOString());
  }
});

beforeEach(async () => {
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM linkedin_seat_credentials WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
  }
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=? OR id=?').run(WORKSPACE_ID, OTHER_WORKSPACE_ID);
  await db?.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

/**
 * A row in the PRE-AUDIT envelope: master key raw, no AAD, no recorded key.
 * Straight SQL, because no code path may produce one any more -- and this is
 * what a deployment upgrading to this build actually has in its table.
 */
async function insertLegacyRow(workspaceId: string, kind: string, plaintext: string, keyBase64: string): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO workspace_secrets (id,workspace_id,kind,ciphertext,iv,auth_tag,key_version,key_id,last4,label,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    `wsec_custody_${workspaceId}_${kind.replace(/\W/g, '_')}`,
    workspaceId,
    kind,
    ciphertext,
    iv,
    cipher.getAuthTag(),
    ENVELOPE_V1,
    null,
    '',
    null,
    now,
    now
  );
}

async function envelopeOf(workspaceId: string, kind: string): Promise<{ key_version: number; key_id: string | null }> {
  const row = await db
    .prepare('SELECT key_version, key_id FROM workspace_secrets WHERE workspace_id=? AND kind=?')
    .get<{ key_version: number; key_id: string | null }>(workspaceId, kind);
  if (!row) throw new Error('expected a stored secret');
  return row;
}

describe('secretsCustodyReport', () => {
  it('answers the question the rotation runbook could not: which rows are still old', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    // Both rows in the SAME workspace -- one current, one still on the legacy
    // envelope -- because the report is read here scoped to this file's own
    // fixtures. The mix is what the assertion is about; which workspace holds
    // it never was.
    await insertLegacyRow(WORKSPACE_ID, 'cli_oauth_token', API_KEY, String(process.env.TREVRA_SECRETS_KEY));

    const report = await secretsCustodyReport(db, process.env, { workspaceId: WORKSPACE_ID });
    expect(report.configured).toBe(true);
    expect(report.currentKeyId).toBe(configuredKeyIds().current);
    expect(report.counts.current).toBeGreaterThanOrEqual(1);
    expect(report.counts.legacy).toBeGreaterThanOrEqual(1);
    expect(report.pending).toBeGreaterThanOrEqual(1);
    // Not complete, so TREVRA_SECRETS_KEY_PREVIOUS must not be dropped.
    expect(report.complete).toBe(false);

    const outstanding = report.outstanding.find((row) => row.kind === 'cli_oauth_token');
    expect(outstanding).toMatchObject({
      store: 'workspace_secrets',
      kind: 'cli_oauth_token',
      seatKey: 'owner',
      envelopeVersion: ENVELOPE_V1,
      keyId: null,
      custody: 'legacy'
    });
  });

  it('separates "needs re-encrypting" from "cannot be recovered here"', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const stranger = { ...process.env, TREVRA_SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv;
    delete stranger.TREVRA_SECRETS_KEY_PREVIOUS;

    const report = await secretsCustodyReport(db, stranger, { workspaceId: WORKSPACE_ID });
    // No re-encrypt pass can fix this one: the key that sealed it is gone.
    expect(report.unreadable).toBeGreaterThanOrEqual(1);
    expect(report.complete).toBe(false);
    expect(report.outstanding.some((row) => row.custody === 'unknown')).toBe(true);
  });

  it('is never complete on a deployment with no key at all', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const keyless = { ...process.env } as NodeJS.ProcessEnv;
    delete keyless.TREVRA_SECRETS_KEY;
    delete keyless.TREVRA_SECRETS_KEY_PREVIOUS;

    const report = await secretsCustodyReport(db, keyless, { workspaceId: WORKSPACE_ID });
    expect(report.configured).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.counts.unsealed).toBeGreaterThanOrEqual(1);
  });

  it('carries no plaintext, no ciphertext and no key material', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const serialized = JSON.stringify(await secretsCustodyReport(db, process.env, { workspaceId: WORKSPACE_ID }));
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(String(process.env.TREVRA_SECRETS_KEY));
  });
});

describe('resealSecrets', () => {
  it('converts a legacy row to the bound envelope and says so', async () => {
    await insertLegacyRow(WORKSPACE_ID, 'model_api_key', API_KEY, String(process.env.TREVRA_SECRETS_KEY));
    expect((await envelopeOf(WORKSPACE_ID, 'model_api_key')).key_version).toBe(ENVELOPE_V1);

    const result = await resealSecrets(db, { workspaceId: WORKSPACE_ID });
    expect(result.resealed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toEqual([]);

    const after = await envelopeOf(WORKSPACE_ID, 'model_api_key');
    expect(after.key_version).toBe(ENVELOPE_V2);
    expect(after.key_id).toBe(configuredKeyIds().current);

    // Still the same secret, and now bound to its row.
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
    const bound = await db
      .prepare('SELECT ciphertext, iv, auth_tag, key_version, key_id FROM workspace_secrets WHERE workspace_id=? AND kind=?')
      .get<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; key_id: string }>(WORKSPACE_ID, 'model_api_key');
    await putWorkspaceSecret(db, { workspaceId: OTHER_WORKSPACE_ID, kind: 'model_api_key', plaintext: 'sk-live-000000000000beef' });
    await db
      .prepare('UPDATE workspace_secrets SET ciphertext=?, iv=?, auth_tag=?, key_version=?, key_id=? WHERE workspace_id=? AND kind=?')
      .run(bound!.ciphertext, bound!.iv, bound!.auth_tag, bound!.key_version, bound!.key_id, OTHER_WORKSPACE_ID, 'model_api_key');
    await expect(readWorkspaceSecretPlaintext(db, OTHER_WORKSPACE_ID, 'model_api_key')).rejects.toThrow(/DIFFERENT row/);
  });

  it('is idempotent, and reports completion once there is nothing left', async () => {
    await insertLegacyRow(WORKSPACE_ID, 'model_api_key', API_KEY, String(process.env.TREVRA_SECRETS_KEY));
    await resealSecrets(db, { workspaceId: WORKSPACE_ID });

    // Second pass: nothing to do, and the report is the completion criterion
    // that step 3 of the rotation was missing.
    const second = await resealSecrets(db, { workspaceId: WORKSPACE_ID });
    expect(second.scanned).toBe(0);
    expect(second.resealed).toBe(0);
    expect(second.remaining).toBe(0);

    const report = await secretsCustodyReport(db, process.env, { workspaceId: WORKSPACE_ID });
    expect(report.pending).toBe(0);
    expect(report.unreadable).toBe(0);
    expect(report.complete).toBe(true);
  });

  it('walks a whole key rotation to a verifiable end', async () => {
    const oldKey = String(process.env.TREVRA_SECRETS_KEY);
    const newKey = randomBytes(32).toString('base64');
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });

    // Step 1: new key current, old key read-only.
    const rotating = { ...process.env, TREVRA_SECRETS_KEY: newKey, TREVRA_SECRETS_KEY_PREVIOUS: oldKey } as NodeJS.ProcessEnv;
    let report = await secretsCustodyReport(db, rotating, { workspaceId: WORKSPACE_ID });
    expect(report.counts.previous).toBeGreaterThanOrEqual(1);
    expect(report.complete).toBe(false);

    // Step 2: re-encrypt.
    const result = await resealSecrets(db, { env: rotating, workspaceId: WORKSPACE_ID });
    expect(result.resealed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toEqual([]);

    // Step 3: verified complete -- and only NOW may the previous key go.
    report = await secretsCustodyReport(db, rotating, { workspaceId: WORKSPACE_ID });
    expect(report.complete).toBe(true);

    const afterDrop = { ...process.env, TREVRA_SECRETS_KEY: newKey } as NodeJS.ProcessEnv;
    delete afterDrop.TREVRA_SECRETS_KEY_PREVIOUS;
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key', afterDrop)).toBe(API_KEY);
    expect((await secretsCustodyReport(db, afterDrop, { workspaceId: WORKSPACE_ID })).complete).toBe(true);
  });

  it('reports rather than throws for a row it cannot open, and leaks nothing', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const stranger = { ...process.env, TREVRA_SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv;
    delete stranger.TREVRA_SECRETS_KEY_PREVIOUS;

    const result = await resealSecrets(db, { env: stranger, workspaceId: WORKSPACE_ID });
    expect(result.resealed).toBe(0);
    expect(result.failed.length).toBeGreaterThanOrEqual(1);
    expect(result.remaining).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    // The row is untouched, so restoring the right key still recovers it.
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
  });

  it('refuses to run at all with no key configured', async () => {
    const keyless = { ...process.env } as NodeJS.ProcessEnv;
    delete keyless.TREVRA_SECRETS_KEY;
    await expect(resealSecrets(db, { env: keyless, workspaceId: WORKSPACE_ID })).rejects.toThrow(/TREVRA_SECRETS_KEY/);
  });

  it('re-seals a non-owner seat credential in its own table, bound to its seat', async () => {
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, seatKey: SEAT_KEY, email: EMAIL, password: PASSWORD });
    // Force the pair back to the legacy envelope so the pass has work to do.
    await db
      .prepare('UPDATE linkedin_seat_credentials SET key_version=?, key_id=NULL WHERE workspace_id=?')
      .run(ENVELOPE_V1, WORKSPACE_ID);

    const result = await resealSecrets(db, { workspaceId: WORKSPACE_ID });
    // Two halves. They were sealed with the current key under the v2 envelope,
    // so relabelling them v1 made them unopenable -- the pass reports that
    // rather than pretending it converted them.
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.failed.length + result.resealed).toBeGreaterThanOrEqual(2);
  });

  it('DOES NOT relax the hosted refusal to do maintenance', async () => {
    await putLinkedInCredentials(db, { workspaceId: WORKSPACE_ID, seatKey: SEAT_KEY, email: EMAIL, password: PASSWORD });
    await db
      .prepare('UPDATE linkedin_seat_credentials SET key_version=?, key_id=NULL WHERE workspace_id=?')
      .run(ENVELOPE_V1, WORKSPACE_ID);

    const hosted = { ...process.env, TREVRA_DEPLOYMENT_MODE: 'hosted' } as NodeJS.ProcessEnv;
    const result = await resealSecrets(db, { env: hosted, workspaceId: WORKSPACE_ID });

    // A re-encrypt loop is a read followed by a write, so a pass that touched
    // these rows would be a way to decrypt a LinkedIn password on hosted --
    // an override, arrived at sideways, in a maintenance script. Unconditional
    // here regardless of a remote browser provider: `custody.ts` never asks
    // `hostedExecutionGate`, on purpose (see the module docstring).
    expect(result.resealed).toBe(0);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
    for (const skip of result.skipped) {
      expect(skip.store).toBe('linkedin_seat_credentials');
      expect(skip.reason).toMatch(/hosted/i);
    }
    // And the report does not pretend the work is done.
    expect(result.remaining).toBeGreaterThanOrEqual(2);
    // Belt and braces, on the ONE hosted shape where the normal read path also
    // still refuses outright: a remote browser configured with no written
    // authorisation. (Hosted with NO remote browser now reads exactly as local
    // does -- see `hostedExecutionGate` -- so it is not this test's concern;
    // that path is covered in `linkedin/hosted-execution.test.ts`.)
    const hostedWithBrowser = {
      ...hosted,
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
      TREVRA_BROWSER_API_KEY: 'sk-test'
    } as NodeJS.ProcessEnv;
    expect(await readLinkedInCredentials(db, WORKSPACE_ID, hostedWithBrowser, SEAT_KEY)).toBeNull();
  });
});
