import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { ENVELOPE_V1, ENVELOPE_V2, configuredKeyIds } from './crypto.js';
import {
  deleteWorkspaceSecret,
  describeWorkspaceSecret,
  getWorkspaceAgentConfig,
  getWorkspaceAgentSetup,
  getWorkspaceCliAgentConfig,
  putWorkspaceAgentConfig,
  putWorkspaceCliAgentConfig,
  putWorkspaceSecret,
  readWorkspaceSecretPlaintext,
  setWorkspaceCliRiskAccepted
} from './store.js';

// Unique to this file so parallel test files cannot collide on fixtures.
const WORKSPACE_ID = 'ws_secrets_store_test';
const OTHER_WORKSPACE_ID = 'ws_secrets_store_test_other';
const USER_ID = 'usr_secrets_store_test';
const API_KEY = 'sk-live-9f3c1d2b4a6e8017';

let db: Db;
let previousKey: string | undefined;

beforeAll(async () => {
  previousKey = process.env.TREVRA_SECRETS_KEY;
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(workspaceId, 'Secrets store test', new Date().toISOString());
  }
});

beforeEach(async () => {
  for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await db.prepare('DELETE FROM workspace_secrets WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspace_agent_config WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspace_cli_agent_config WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM audit_events WHERE workspace_id=?').run(workspaceId);
  }
});

afterAll(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=? OR id=?').run(WORKSPACE_ID, OTHER_WORKSPACE_ID);
  await db?.close();
  if (previousKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousKey;
});

async function auditRows(workspaceId = WORKSPACE_ID): Promise<Array<{ event_type: string; actor_type: string; actor_id: string | null; metadata_json: string }>> {
  return db
    .prepare('SELECT event_type, actor_type, actor_id, metadata_json FROM audit_events WHERE workspace_id=? ORDER BY created_at, event_type')
    .all<{ event_type: string; actor_type: string; actor_id: string | null; metadata_json: string }>(workspaceId);
}

async function storedRow(workspaceId = WORKSPACE_ID): Promise<{
  id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; key_id: string | null;
}> {
  const row = await db
    .prepare('SELECT id, ciphertext, iv, auth_tag, key_version, key_id FROM workspace_secrets WHERE workspace_id=? AND kind=?')
    .get<{ id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; key_id: string | null }>(workspaceId, 'model_api_key');
  if (!row) throw new Error('expected a stored secret');
  return row;
}

/**
 * Write a row in the PRE-AUDIT envelope: master key raw, no AAD, no recorded
 * key -- byte for byte what a deployment upgrading to this build already has
 * in its table. Straight SQL, because no code path may produce one any more.
 */
async function insertLegacyRow(workspaceId: string, kind: string, plaintext: string): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(String(process.env.TREVRA_SECRETS_KEY), 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO workspace_secrets (id,workspace_id,kind,ciphertext,iv,auth_tag,key_version,key_id,last4,label,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    `wsec_legacy_${kind.replace(/\W/g, '_')}`,
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

describe('workspace secrets', () => {
  it('stores a key and describes it without ever handing back the value', async () => {
    const summary = await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE_ID,
      kind: 'model_api_key',
      plaintext: API_KEY,
      label: 'Anthropic',
      actorUserId: USER_ID
    });

    expect(summary).toMatchObject({
      kind: 'model_api_key',
      label: 'Anthropic',
      last4: '8017',
      // The row-bound envelope, sealed by the key this deployment writes with.
      keyVersion: ENVELOPE_V2,
      keyId: configuredKeyIds().current,
      custody: 'current'
    });
    expect(summary.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const described = await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key');
    expect(described).toEqual(summary);
    // The decisive property: nothing the UI can see contains the key.
    expect(JSON.stringify(described)).not.toContain(API_KEY);

    // Nor does the row itself hold it in the clear.
    const row = await storedRow();
    expect(row.ciphertext.toString('utf8')).not.toContain('sk-live');
    expect(row.iv).toHaveLength(12);
  });

  it('shows fewer than four characters rather than padding a short value', async () => {
    const summary = await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: 'ab' });
    expect(summary.last4).toBe('ab');
  });

  it('replaces the stored key, re-derives last4, and re-seals with a fresh IV', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY, label: 'Anthropic' });
    const before = await storedRow();

    const replaced = await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE_ID,
      kind: 'model_api_key',
      plaintext: 'sk-live-0000000000004242',
      label: 'OpenRouter'
    });
    const after = await storedRow();

    expect(replaced.last4).toBe('4242');
    expect(replaced.label).toBe('OpenRouter');
    expect(after.iv.equals(before.iv)).toBe(false);
    expect(after.ciphertext.equals(before.ciphertext)).toBe(false);

    // One secret per kind: the replaced ciphertext is gone, not left behind.
    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM workspace_secrets WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(count?.total).toBe(1);
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe('sk-live-0000000000004242');
  });

  it('returns the original value from the one internal plaintext path', async () => {
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBeNull();
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
  });

  // The read half of §3's "rotated ... without a schema change and without
  // downtime": a stored row stays readable across the swap, and re-saving it is
  // the whole re-encryption job.
  it('keeps a stored key readable while the server key is being rotated', async () => {
    const oldKey = process.env.TREVRA_SECRETS_KEY as string;
    const newKey = randomBytes(32).toString('base64');
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const sealedWithOld = await storedRow();

    try {
      // Step 1: new key current, old key read-only.
      process.env.TREVRA_SECRETS_KEY = newKey;
      process.env.TREVRA_SECRETS_KEY_PREVIOUS = oldKey;
      expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);

      // Step 2: re-encrypt by writing the value back.
      await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
      const resealed = await storedRow();
      expect(resealed.ciphertext.equals(sealedWithOld.ciphertext)).toBe(false);

      // Step 3: drop the previous key. The row still opens.
      delete process.env.TREVRA_SECRETS_KEY_PREVIOUS;
      expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
    } finally {
      delete process.env.TREVRA_SECRETS_KEY_PREVIOUS;
      process.env.TREVRA_SECRETS_KEY = oldKey;
    }
  });

  it('scopes secrets to their workspace', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    expect(await describeWorkspaceSecret(db, OTHER_WORKSPACE_ID, 'model_api_key')).toBeNull();
    expect(await readWorkspaceSecretPlaintext(db, OTHER_WORKSPACE_ID, 'model_api_key')).toBeNull();
  });

  it('deletes the secret and reports whether there was one', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });

    expect(await deleteWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', USER_ID)).toBe(true);
    expect(await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key')).toBeNull();
    expect(await deleteWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', USER_ID)).toBe(false);
  });

  it('rejects an empty or whitespace-only value', async () => {
    for (const plaintext of ['', '   ', '\n\t']) {
      await expect(putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext })).rejects.toThrow(/required/i);
    }
    expect(await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key')).toBeNull();
  });

  it('audits the put and the delete, and the audit trail never contains the key', async () => {
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE_ID,
      kind: 'model_api_key',
      plaintext: API_KEY,
      label: 'Anthropic',
      actorUserId: USER_ID
    });
    await deleteWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', USER_ID);

    const rows = await auditRows();
    expect(rows.map((row) => row.event_type)).toEqual(['workspace_secret.updated', 'workspace_secret.deleted']);
    for (const row of rows) {
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(USER_ID);
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect(metadata).toMatchObject({ kind: 'model_api_key', last4: '8017', label: 'Anthropic' });
      // The regression that matters: no audit row may carry the key itself.
      expect(row.metadata_json).not.toContain(API_KEY);
      expect(row.metadata_json).not.toContain('sk-live');
    }
  });
});

/**
 * THE AUDIT FINDING, AT THE STORE LEVEL.
 *
 * `WHERE workspace_id=?` is a query, not a custody boundary. Everything below
 * moves BYTES between rows the way a mis-scoped UPDATE, a restore of the wrong
 * dump or a SQL injection would, and checks that the database can no longer be
 * talked into handing one tenant's credential to another.
 */
describe('cross-tenant portability', () => {
  it('refuses a ciphertext transplanted from another workspace', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const victim = await storedRow(WORKSPACE_ID);

    // The attack: tenant B's row, tenant A's sealed bytes. Tag, IV and key
    // version all valid and self-consistent -- this used to decrypt cleanly
    // and then ride in tenant B's Authorization header.
    await putWorkspaceSecret(db, { workspaceId: OTHER_WORKSPACE_ID, kind: 'model_api_key', plaintext: 'sk-live-000000000000beef' });
    await db
      .prepare('UPDATE workspace_secrets SET ciphertext=?, iv=?, auth_tag=?, key_version=?, key_id=? WHERE workspace_id=? AND kind=?')
      .run(victim.ciphertext, victim.iv, victim.auth_tag, victim.key_version, victim.key_id, OTHER_WORKSPACE_ID, 'model_api_key');

    await expect(readWorkspaceSecretPlaintext(db, OTHER_WORKSPACE_ID, 'model_api_key'))
      .rejects.toThrow(/sealed for a DIFFERENT row/);
    // And the error names the row that was asked for, so the operator can tell
    // a transplant from an ordinary key problem.
    await expect(readWorkspaceSecretPlaintext(db, OTHER_WORKSPACE_ID, 'model_api_key'))
      .rejects.toThrow(new RegExp(OTHER_WORKSPACE_ID));

    // The victim's own row is untouched and still opens.
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
  });

  it('refuses a ciphertext relabelled as another kind in the same workspace', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const source = await storedRow();

    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: 'sk-ant-oat01-placeholder' });
    await db
      .prepare("UPDATE workspace_secrets SET ciphertext=?, iv=?, auth_tag=?, key_version=?, key_id=? WHERE workspace_id=? AND kind='cli_oauth_token'")
      .run(source.ciphertext, source.iv, source.auth_tag, source.key_version, source.key_id, WORKSPACE_ID);

    await expect(readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'cli_oauth_token'))
      .rejects.toThrow(/sealed for a DIFFERENT row/);
  });
});

/**
 * Backwards compatibility is mandatory: a deployment that upgrades keeps
 * reading its secrets on the first request after the deploy, with no data step
 * -- and "re-seal on next write" is what converts them.
 */
describe('rows sealed before the binding existed', () => {
  it('still opens, and reports as legacy rather than as fine', async () => {
    await insertLegacyRow(WORKSPACE_ID, 'model_api_key', API_KEY);

    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);

    const described = await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key');
    expect(described).toMatchObject({ keyVersion: ENVELOPE_V1, keyId: null, custody: 'legacy' });
  });

  it('is re-sealed and bound by the next write', async () => {
    await insertLegacyRow(WORKSPACE_ID, 'model_api_key', API_KEY);
    const before = await storedRow();
    expect(before.key_version).toBe(ENVELOPE_V1);

    const summary = await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    expect(summary).toMatchObject({ keyVersion: ENVELOPE_V2, custody: 'current' });

    const after = await storedRow();
    expect(after.key_id).toBe(configuredKeyIds().current);
    // The bytes are now bound: transplanting them no longer works.
    await putWorkspaceSecret(db, { workspaceId: OTHER_WORKSPACE_ID, kind: 'model_api_key', plaintext: 'sk-live-000000000000beef' });
    await db
      .prepare('UPDATE workspace_secrets SET ciphertext=?, iv=?, auth_tag=?, key_version=?, key_id=? WHERE workspace_id=? AND kind=?')
      .run(after.ciphertext, after.iv, after.auth_tag, after.key_version, after.key_id, OTHER_WORKSPACE_ID, 'model_api_key');
    await expect(readWorkspaceSecretPlaintext(db, OTHER_WORKSPACE_ID, 'model_api_key')).rejects.toThrow(/DIFFERENT row/);
  });
});

/**
 * The other half of the audit finding: `openSecret` threw at USE time when the
 * key was wrong, while `describeWorkspaceSecret` -- metadata only -- kept
 * reporting the secret as configured. A green setup screen over a deployment
 * whose next agent run would 500.
 */
describe('a wrong server key is visible before anything is run', () => {
  it('reports the secret as unopenable without decrypting it', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const stranger = { ...process.env, TREVRA_SECRETS_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv;
    delete stranger.TREVRA_SECRETS_KEY_PREVIOUS;

    const described = await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', stranger);
    // Used to be indistinguishable from a healthy row. Now it says so.
    expect(described).toMatchObject({ custody: 'unknown', last4: '8017' });

    // And the metadata read still WORKS -- no decryption happened, so a status
    // screen can render this instead of a 500.
    expect(described?.keyId).toBeTruthy();
    await expect(readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key', stranger))
      .rejects.toThrow(/does not hold/);
  });

  it('reports every row as unsealed when the deployment holds no key at all', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const keyless = { ...process.env } as NodeJS.ProcessEnv;
    delete keyless.TREVRA_SECRETS_KEY;
    delete keyless.TREVRA_SECRETS_KEY_PREVIOUS;

    expect(await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', keyless))
      .toMatchObject({ custody: 'unsealed' });
  });

  it('reports the outgoing key during a rotation, so the window is visible', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    const rotating = {
      ...process.env,
      TREVRA_SECRETS_KEY: randomBytes(32).toString('base64'),
      TREVRA_SECRETS_KEY_PREVIOUS: String(process.env.TREVRA_SECRETS_KEY)
    } as NodeJS.ProcessEnv;

    expect(await describeWorkspaceSecret(db, WORKSPACE_ID, 'model_api_key', rotating))
      .toMatchObject({ custody: 'previous' });
    // Still readable -- 'previous' is "not finished", not "broken".
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key', rotating)).toBe(API_KEY);
  });
});

describe('workspace agent config', () => {
  it('refuses to send a key over plain HTTP to a remote host', async () => {
    for (const baseUrl of ['http://evil.example', 'http://evil.example/v1', 'ftp://api.example.com', 'api.openai.com/v1', '']) {
      await expect(
        putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl, model: 'gpt-5-mini' })
      ).rejects.toThrow();
    }
    expect(await getWorkspaceAgentConfig(db, WORKSPACE_ID)).toBeNull();
  });

  // The server dials baseUrl itself, so a workspace member who can set it holds
  // a server-side request forgery primitive unless this holds.
  it('refuses a private or link-local endpoint by default', async () => {
    for (const baseUrl of [
      'https://169.254.169.254/v1',   // cloud instance metadata
      'https://10.0.0.5/v1',
      'https://127.0.0.1/v1',
      'https://[::1]/v1',
      'https://internal/v1',          // single-label host
      'https://db.local/v1',
      'http://localhost:11434'
    ]) {
      await expect(
        putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl, model: 'gpt-5-mini' })
      ).rejects.toThrow();
    }
    expect(await getWorkspaceAgentConfig(db, WORKSPACE_ID)).toBeNull();
  });

  it('accepts a public HTTPS endpoint without a DNS round trip', async () => {
    for (const baseUrl of ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1']) {
      const config = await putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl, model: 'gpt-5-mini', label: 'Hosted' });
      expect(config.baseUrl).toBe(baseUrl);
    }
  });

  it('accepts loopback only when the self-host escape hatch is set', async () => {
    const previous = process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
    process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = 'true';
    try {
      for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:8000/v1', 'https://vllm.internal/v1']) {
        const config = await putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl, model: 'gpt-5-mini', label: 'Local' });
        expect(config.baseUrl).toBe(baseUrl);
      }
    } finally {
      if (previous === undefined) delete process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS;
      else process.env.TREVRA_ALLOW_PRIVATE_MODEL_HOSTS = previous;
    }
  });

  it('requires a model and stores no endpoint by default', async () => {
    await expect(
      putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl: 'https://api.openai.com/v1', model: '  ' })
    ).rejects.toThrow(/model/i);
    expect(await getWorkspaceAgentConfig(db, WORKSPACE_ID)).toBeNull();
  });

  it('replaces the configuration in place and reports it with the secret summary', async () => {
    await putWorkspaceAgentConfig(db, { workspaceId: WORKSPACE_ID, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' });
    const updated = await putWorkspaceAgentConfig(db, {
      workspaceId: WORKSPACE_ID,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.5',
      label: 'OpenRouter'
    });
    expect(updated).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', label: 'OpenRouter' });

    const empty = await getWorkspaceAgentSetup(db, OTHER_WORKSPACE_ID);
    expect(empty).toEqual({ config: null, secret: null });

    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY, label: 'OpenRouter' });
    const setup = await getWorkspaceAgentSetup(db, WORKSPACE_ID);
    expect(setup.config).toEqual(updated);
    expect(setup.secret?.last4).toBe('8017');
    expect(JSON.stringify(setup)).not.toContain(API_KEY);
  });
});

// The third widening (module comment on WorkspaceSecretKind): a workspace's
// own Claude/Codex subscription token. Same crypto path, same table, same
// round-trip guarantees as 'model_api_key' -- this is the regression that
// matters, so it mirrors the first test in this file closely.
describe('workspace secrets: cli_oauth_token', () => {
  const TOKEN = 'sk-ant-oat01-example-9f3c1d2b4a6e8017';

  it('stores a subscription token and describes it without ever handing back the value', async () => {
    const summary = await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE_ID,
      kind: 'cli_oauth_token',
      plaintext: TOKEN,
      actorUserId: USER_ID
    });

    // NO last4. Four characters of a live subscription credential in every
    // backup and every replica bought nothing: there is one token per
    // workspace, it is never compared with another, and the only thing the
    // product shows about it is a boolean.
    expect(summary).toMatchObject({ kind: 'cli_oauth_token', last4: '', keyVersion: ENVELOPE_V2, custody: 'current' });

    const described = await describeWorkspaceSecret(db, WORKSPACE_ID, 'cli_oauth_token');
    expect(described).toEqual(summary);
    expect(JSON.stringify(described)).not.toContain(TOKEN);

    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'cli_oauth_token')).toBe(TOKEN);
  });

  it('is a separate row from a model_api_key stored for the same workspace', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'model_api_key', plaintext: API_KEY });
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });

    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'model_api_key')).toBe(API_KEY);
    expect(await readWorkspaceSecretPlaintext(db, WORKSPACE_ID, 'cli_oauth_token')).toBe(TOKEN);

    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM workspace_secrets WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE_ID);
    expect(count?.total).toBe(2);
  });

  it('deletes independently of the model key, and scopes to its workspace', async () => {
    await putWorkspaceSecret(db, { workspaceId: WORKSPACE_ID, kind: 'cli_oauth_token', plaintext: TOKEN });
    expect(await describeWorkspaceSecret(db, OTHER_WORKSPACE_ID, 'cli_oauth_token')).toBeNull();

    expect(await deleteWorkspaceSecret(db, WORKSPACE_ID, 'cli_oauth_token', USER_ID)).toBe(true);
    expect(await describeWorkspaceSecret(db, WORKSPACE_ID, 'cli_oauth_token')).toBeNull();
    expect(await deleteWorkspaceSecret(db, WORKSPACE_ID, 'cli_oauth_token', USER_ID)).toBe(false);
  });
});

describe('workspace CLI agent config', () => {
  it('is null until a CLI and a model are saved', async () => {
    expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toBeNull();
  });

  it('saves the CLI and model without touching risk acceptance', async () => {
    const saved = await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    expect(saved).toMatchObject({ cli: 'claude', model: 'sonnet', riskAcceptedAt: null });

    // Re-saving (e.g. switching CLI) must not silently imply consent.
    const resaved = await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'codex', model: 'gpt-5-codex' });
    expect(resaved).toMatchObject({ cli: 'codex', model: 'gpt-5-codex', riskAcceptedAt: null });

    expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toMatchObject({ cli: 'codex', model: 'gpt-5-codex' });
  });

  it('rejects an empty model', async () => {
    await expect(
      putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: '  ' })
    ).rejects.toThrow(/model/i);
    expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toBeNull();
  });

  it('scopes config to its workspace', async () => {
    await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });
    expect(await getWorkspaceCliAgentConfig(db, OTHER_WORKSPACE_ID)).toBeNull();
  });

  describe('setWorkspaceCliRiskAccepted', () => {
    it('returns null -- nothing to accept -- when no config row exists yet', async () => {
      expect(await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true)).toBeNull();
    });

    it('accepts, and clears back to null on revoke, once a config row exists', async () => {
      await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'claude', model: 'sonnet' });

      const accepted = await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
      expect(accepted?.riskAcceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toMatchObject({ riskAcceptedAt: accepted?.riskAcceptedAt });

      // Revoking is a real clear to NULL, not a boolean bolted on next to a
      // stale timestamp -- re-accepting later must look identical to accepting
      // the first time.
      const revoked = await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, false);
      expect(revoked?.riskAcceptedAt).toBeNull();
      expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toMatchObject({ riskAcceptedAt: null });
    });

    it('does not touch cli or model', async () => {
      await putWorkspaceCliAgentConfig(db, { workspaceId: WORKSPACE_ID, cli: 'codex', model: 'gpt-5-codex' });
      await setWorkspaceCliRiskAccepted(db, WORKSPACE_ID, true);
      expect(await getWorkspaceCliAgentConfig(db, WORKSPACE_ID)).toMatchObject({ cli: 'codex', model: 'gpt-5-codex' });
    });
  });
});
