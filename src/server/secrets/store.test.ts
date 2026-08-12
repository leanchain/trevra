import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  deleteWorkspaceSecret,
  describeWorkspaceSecret,
  getWorkspaceAgentConfig,
  getWorkspaceAgentSetup,
  putWorkspaceAgentConfig,
  putWorkspaceSecret,
  readWorkspaceSecretPlaintext
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

async function storedRow(): Promise<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }> {
  const row = await db
    .prepare('SELECT ciphertext, iv, auth_tag FROM workspace_secrets WHERE workspace_id=? AND kind=?')
    .get<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(WORKSPACE_ID, 'model_api_key');
  if (!row) throw new Error('expected a stored secret');
  return row;
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

    expect(summary).toMatchObject({ kind: 'model_api_key', label: 'Anthropic', last4: '8017', keyVersion: 1 });
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
