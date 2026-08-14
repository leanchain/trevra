import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  configuredKeyIds,
  needsReseal,
  openSecret,
  sealSecret,
  secretCustody,
  secretsConfigured,
  ENVELOPE_V1,
  ENVELOPE_V2,
  type SealedSecret,
  type SecretContext
} from './crypto.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const PLAINTEXT = 'sk-live-9f3c1d2b4a6e8017';

/** Tenant A's model key row, and the row it must never be movable out of. */
const CONTEXT: SecretContext = {
  store: 'workspace_secrets',
  workspaceId: 'ws_tenant_a',
  seatKey: 'owner',
  kind: 'model_api_key'
};

function env(value?: string, previous?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = value === undefined ? {} : { TREVRA_SECRETS_KEY: value };
  if (previous !== undefined) result.TREVRA_SECRETS_KEY_PREVIOUS = previous;
  return result;
}

/** Flips one bit in a copy, leaving the original sealed value untouched. */
function tamper(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  copy[0] ^= 0xff;
  return copy;
}

/**
 * A v1 envelope: master key raw, no AAD, no recorded key -- exactly what every
 * row in a deployment upgrading to this build already contains.
 *
 * Built here with node:crypto rather than exported from `crypto.ts`, on
 * purpose. A legacy SEALER exported from the custody module is a function
 * somebody can call by accident, and the one thing this envelope must never do
 * again is get written. Reading it is a compatibility obligation; writing it
 * is a regression.
 */
function sealV1(plaintext: string, keyBase64: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: ENVELOPE_V1, keyId: null };
}

describe('sealSecret / openSecret', () => {
  it('round-trips a value', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    expect(sealed.keyVersion).toBe(ENVELOPE_V2);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('sk-live');
    expect(openSecret(sealed, CONTEXT, env(KEY))).toBe(PLAINTEXT);
  });

  it('never reuses an IV, so the same key sealed twice looks different', () => {
    const first = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const second = sealSecret(PLAINTEXT, CONTEXT, env(KEY));

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(openSecret(first, CONTEXT, env(KEY))).toBe(openSecret(second, CONTEXT, env(KEY)));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, ciphertext: tamper(sealed.ciphertext) };
    expect(() => openSecret(attacked, CONTEXT, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses a tampered auth tag', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, authTag: tamper(sealed.authTag) };
    expect(() => openSecret(attacked, CONTEXT, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses a tampered IV', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, iv: tamper(sealed.iv) };
    expect(() => openSecret(attacked, CONTEXT, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses to open with the wrong server key: a stolen database alone is useless', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    expect(() => openSecret(sealed, CONTEXT, env(OTHER_KEY))).toThrow(/this deployment does not hold/i);
  });

  it('refuses a row sealed by an envelope version this server does not implement', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    expect(() => openSecret({ ...sealed, keyVersion: 3 }, CONTEXT, env(KEY))).toThrow(/envelope version 3/);
  });

  it('leaks neither plaintext nor key material in the failure message', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    try {
      openSecret(sealed, CONTEXT, env(OTHER_KEY));
      throw new Error('expected openSecret to throw');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain(PLAINTEXT);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(OTHER_KEY);
    }
  });

  it('refuses a context with an empty or separator-bearing component', () => {
    for (const broken of [
      { ...CONTEXT, workspaceId: '' },
      { ...CONTEXT, kind: '' },
      { ...CONTEXT, workspaceId: `ws_aws_b` },
      { ...CONTEXT, seatKey: `owner` }
    ]) {
      expect(() => sealSecret(PLAINTEXT, broken, env(KEY))).toThrow(/U\+001F|non-empty/);
    }
  });
});

/**
 * THE AUDIT FINDING, AS A TEST.
 *
 * Before the AAD binding, a (ciphertext, iv, auth_tag, key_version) tuple
 * lifted out of tenant A's row and written into tenant B's row decrypted
 * cleanly, with a valid tag, and was then used as B's credential --
 * `agent/provider.ts` would put A's API key in B's Authorization header.
 * Row scoping was a SQL WHERE clause and nothing else.
 *
 * Every case below is the same move: take a sealed value and present it as a
 * different row. All of them must refuse.
 */
describe('cross-tenant portability: a sealed value belongs to ONE row', () => {
  const sealedForA = () => sealSecret(PLAINTEXT, CONTEXT, env(KEY));

  it('refuses a row moved into another WORKSPACE, with an error that says why', () => {
    const stolen = sealedForA();
    const asTenantB: SecretContext = { ...CONTEXT, workspaceId: 'ws_tenant_b' };

    // The whole finding: this used to return tenant A's API key.
    expect(() => openSecret(stolen, asTenantB, env(KEY))).toThrow(/failed authentication/i);
    expect(() => openSecret(stolen, asTenantB, env(KEY))).toThrow(/sealed for a DIFFERENT row/);
    // The message names the row that was asked for, so an operator staring at
    // a 500 can tell a transplant from an ordinary key problem.
    expect(() => openSecret(stolen, asTenantB, env(KEY))).toThrow(/ws_tenant_b/);

    // ...and it still opens where it belongs, so this is a binding and not a
    // corruption.
    expect(openSecret(stolen, CONTEXT, env(KEY))).toBe(PLAINTEXT);
  });

  it('refuses a row moved between SEATS of the same workspace', () => {
    const seatA: SecretContext = {
      store: 'linkedin_seat_credentials',
      workspaceId: 'ws_tenant_a',
      seatKey: 'seat-one',
      kind: 'linkedin.password'
    };
    const sealed = sealSecret(PLAINTEXT, seatA, env(KEY));
    // A browser signing in as seat-two must not be handed seat-one's password.
    expect(() => openSecret(sealed, { ...seatA, seatKey: 'seat-two' }, env(KEY))).toThrow(/sealed for a DIFFERENT row/);
  });

  it('refuses a row relabelled as another KIND', () => {
    const sealed = sealedForA();
    // Rewriting kind='model_api_key' to kind='linkedin.password' would have
    // fed an API key to a login form.
    expect(() => openSecret(sealed, { ...CONTEXT, kind: 'linkedin.password' }, env(KEY))).toThrow(/sealed for a DIFFERENT row/);
  });

  it('refuses a row copied into the other TABLE', () => {
    const sealed = sealSecret(PLAINTEXT, { ...CONTEXT, kind: 'linkedin.password' }, env(KEY));
    expect(() =>
      openSecret(sealed, {
        store: 'linkedin_seat_credentials',
        workspaceId: CONTEXT.workspaceId,
        seatKey: 'owner',
        kind: 'linkedin.password'
      }, env(KEY))
    ).toThrow(/failed authentication/i);
  });

  it('gives each workspace its own data key, so one leaked key does not generalise', () => {
    const a = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const b = sealSecret(PLAINTEXT, { ...CONTEXT, workspaceId: 'ws_tenant_b' }, env(KEY));

    // Nothing is encrypted under the master key any more: neither row opens
    // with it directly, which is what makes a derived key a real boundary
    // rather than a relabelled master.
    const master = Buffer.from(KEY, 'base64');
    for (const sealed of [a, b]) {
      expect(() => {
        const decipher = createDecipheriv('aes-256-gcm', master, sealed.iv);
        decipher.setAuthTag(sealed.authTag);
        Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
      }).toThrow();
    }

    // Tenant A's derived key is not tenant B's: the ciphertexts are under
    // different keys as well as different AAD, which is what makes a single
    // leaked data key stop at one tenant.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

/**
 * Backwards compatibility is mandatory: a deployment that upgrades must keep
 * reading its secrets on the first request after the deploy, with no data step.
 */
describe('the v1 envelope: still read, never written', () => {
  it('opens a row sealed before the binding existed', () => {
    const legacy = sealV1(PLAINTEXT, KEY);
    expect(legacy.keyVersion).toBe(ENVELOPE_V1);
    expect(openSecret(legacy, CONTEXT, env(KEY))).toBe(PLAINTEXT);
  });

  it('opens a legacy row with the previous key during a rotation', () => {
    const legacy = sealV1(PLAINTEXT, OTHER_KEY);
    expect(openSecret(legacy, CONTEXT, env(KEY, OTHER_KEY))).toBe(PLAINTEXT);
  });

  it('is STILL PORTABLE, which is exactly why re-sealing is not optional', () => {
    const legacy = sealV1(PLAINTEXT, KEY);
    // This is the vulnerability, preserved deliberately in a test so that the
    // day someone deletes `resealSecrets` they find out what it was for: a v1
    // row opens in ANY context, because v1 authenticated bytes and not rows.
    // Migration 056 documents the operator's path to zero of these.
    expect(openSecret(legacy, { ...CONTEXT, workspaceId: 'ws_tenant_b' }, env(KEY))).toBe(PLAINTEXT);
    expect(secretCustody(ENVELOPE_V1, null, configuredKeyIds(env(KEY)))).toBe('legacy');
    expect(needsReseal(ENVELOPE_V1, null, configuredKeyIds(env(KEY)))).toBe(true);
  });

  it('never produces a v1 row: re-sealing a legacy value binds it', () => {
    const legacy = sealV1(PLAINTEXT, KEY);
    const resealed = sealSecret(openSecret(legacy, CONTEXT, env(KEY)), CONTEXT, env(KEY));

    expect(resealed.keyVersion).toBe(ENVELOPE_V2);
    expect(resealed.keyId).toBeTruthy();
    expect(() => openSecret(resealed, { ...CONTEXT, workspaceId: 'ws_tenant_b' }, env(KEY))).toThrow(/sealed for a DIFFERENT row/);
  });

  it('does not let a v2 row be downgraded to the unbound path by editing key_version', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const downgraded: SealedSecret = { ...sealed, keyVersion: ENVELOPE_V1, keyId: null };
    // Reading it as v1 means the master key and no AAD -- neither of which
    // sealed it -- so the attempt fails rather than stripping the binding.
    expect(() => openSecret(downgraded, CONTEXT, env(KEY))).toThrow(/failed authentication/i);
  });
});

describe('key configuration', () => {
  it('reports BYOK off and refuses to seal or open when the key is absent', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(KEY));

    expect(secretsConfigured(env())).toBe(false);
    expect(secretsConfigured(env('   '))).toBe(false);
    expect(secretsConfigured(env(KEY))).toBe(true);

    // Never a plaintext fallback: without the key the feature is simply off.
    expect(() => sealSecret(PLAINTEXT, CONTEXT, env())).toThrow(/TREVRA_SECRETS_KEY/);
    expect(() => openSecret(sealed, CONTEXT, env())).toThrow(/TREVRA_SECRETS_KEY/);
  });

  it('names the variable when the key is not base64', () => {
    expect(() => sealSecret(PLAINTEXT, CONTEXT, env('not base64 at all!!'))).toThrow(/TREVRA_SECRETS_KEY/);
  });

  it('names the variable when the key is the wrong length', () => {
    const tooShort = randomBytes(16).toString('base64');
    const tooLong = randomBytes(64).toString('base64');
    expect(() => sealSecret(PLAINTEXT, CONTEXT, env(tooShort))).toThrow(/TREVRA_SECRETS_KEY.*32 bytes/s);
    expect(() => sealSecret(PLAINTEXT, CONTEXT, env(tooLong))).toThrow(/TREVRA_SECRETS_KEY.*32 bytes/s);
  });
});

/**
 * The second half of the audit finding: a key has an IDENTITY now, recorded on
 * every row it seals, so "which rows are still on the old key" is a query and
 * not a guess -- and a wrong key is visible from metadata instead of surfacing
 * as a 500 at use time behind a green setup screen.
 */
describe('key identity', () => {
  it('records which key sealed the row, the same way every time', () => {
    const first = sealSecret(PLAINTEXT, CONTEXT, env(KEY));
    const second = sealSecret('something else', CONTEXT, env(KEY));
    const other = sealSecret(PLAINTEXT, CONTEXT, env(OTHER_KEY));

    expect(first.keyId).toBe(second.keyId);
    expect(first.keyId).not.toBe(other.keyId);
    expect(first.keyId).toBe(configuredKeyIds(env(KEY)).current);
  });

  it('is a fingerprint, not the key: it carries no key material', () => {
    const { current } = configuredKeyIds(env(KEY));
    expect(current).toBeTruthy();
    expect(current).not.toContain(KEY);
    expect(KEY).not.toContain(String(current));
    // 128 bits, base64url.
    expect(current).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('reports rather than throws for an absent or malformed key, so a status screen can ask', () => {
    expect(configuredKeyIds(env())).toEqual({ current: null, previous: null });
    expect(configuredKeyIds(env('not base64 at all!!'))).toEqual({ current: null, previous: null });
    expect(configuredKeyIds(env(KEY, 'also not base64!!')).previous).toBeNull();
    expect(configuredKeyIds(env(KEY, OTHER_KEY))).toEqual({
      current: configuredKeyIds(env(KEY)).current,
      previous: configuredKeyIds(env(OTHER_KEY)).current
    });
  });

  it('classifies every row from metadata alone, with no decryption', () => {
    const ids = configuredKeyIds(env(KEY, OTHER_KEY));
    const currentId = String(ids.current);
    const previousId = String(ids.previous);

    expect(secretCustody(ENVELOPE_V2, currentId, ids)).toBe('current');
    expect(secretCustody(ENVELOPE_V2, previousId, ids)).toBe('previous');
    expect(secretCustody(ENVELOPE_V1, null, ids)).toBe('legacy');
    // THE GREEN-SCREEN CASE: sealed with a key nobody here holds. Metadata
    // alone now says the deployment is broken.
    expect(secretCustody(ENVELOPE_V2, 'a-key-nobody-holds', ids)).toBe('unknown');
    expect(secretCustody(ENVELOPE_V2, null, ids)).toBe('unknown');
    // No key at all: not "configured", whatever the row says.
    expect(secretCustody(ENVELOPE_V2, currentId, configuredKeyIds(env()))).toBe('unsealed');

    expect(needsReseal(ENVELOPE_V2, currentId, ids)).toBe(false);
    for (const [version, keyId] of [[ENVELOPE_V2, previousId], [ENVELOPE_V1, null], [ENVELOPE_V2, 'nope']] as const) {
      expect(needsReseal(version, keyId, ids)).toBe(true);
    }
  });

  it('says the key is MISSING rather than "authentication failed" when it is missing', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(OTHER_KEY));
    // The distinction that makes a half-finished rotation diagnosable: the
    // fingerprint matched nothing, so this is not a tampered row and the
    // message must not suggest it is.
    expect(() => openSecret(sealed, CONTEXT, env(KEY))).toThrow(/does not hold/);
    expect(() => openSecret(sealed, CONTEXT, env(KEY))).toThrow(/TREVRA_SECRETS_KEY_PREVIOUS/);
    expect(() => openSecret(sealed, CONTEXT, env(KEY))).not.toThrow(/tampered/);
  });
});

/**
 * byok-and-hosted-agent.md section 3: the server key "can be rotated by
 * re-encrypting rows, without a schema change and without downtime". That needs
 * a read path that still accepts the outgoing key while the write path has
 * moved on -- AND, since the audit, a way to tell when step 2 is finished.
 */
describe('server key rotation', () => {
  const OLD = KEY;
  const NEW = OTHER_KEY;

  it('walks the whole rotation with no failed read and no failed write', () => {
    // Before: a row sealed with the old key.
    const existing = sealSecret(PLAINTEXT, CONTEXT, env(OLD));

    // Step 1 -- new key current, old key demoted to read-only. Deploy.
    const during = env(NEW, OLD);
    expect(openSecret(existing, CONTEXT, during)).toBe(PLAINTEXT);
    const written = sealSecret(PLAINTEXT, CONTEXT, during);
    expect(openSecret(written, CONTEXT, during)).toBe(PLAINTEXT);

    // Step 2 -- the background job re-encrypts: read, then write back. The row
    // now NAMES the key that sealed it, which is what makes step 3 checkable.
    const resealed = sealSecret(openSecret(existing, CONTEXT, during), CONTEXT, during);
    expect(secretCustody(resealed.keyVersion, resealed.keyId, configuredKeyIds(during))).toBe('current');
    expect(secretCustody(existing.keyVersion, existing.keyId, configuredKeyIds(during))).toBe('previous');

    // Step 3 -- drop the previous key. Everything written since step 1 opens.
    expect(openSecret(resealed, CONTEXT, env(NEW))).toBe(PLAINTEXT);
    expect(openSecret(written, CONTEXT, env(NEW))).toBe(PLAINTEXT);
  });

  it('seals with the current key only, never the previous one', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(NEW, OLD));
    // If writes had used the previous key this would fail after step 3.
    expect(openSecret(sealed, CONTEXT, env(NEW))).toBe(PLAINTEXT);
    expect(() => openSecret(sealed, CONTEXT, env(OLD))).toThrow(/does not hold/);
  });

  it('accepts the previous key for reads only while it is configured', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(OLD));
    expect(openSecret(sealed, CONTEXT, env(NEW, OLD))).toBe(PLAINTEXT);
    // Rotation finished: the old key is gone and so is the row's readability.
    expect(() => openSecret(sealed, CONTEXT, env(NEW))).toThrow(/does not hold/);
  });

  it('names both variables once a previous key is configured, and still leaks nothing', () => {
    const third = randomBytes(32).toString('base64');
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(third));
    try {
      openSecret(sealed, CONTEXT, env(NEW, OLD));
      throw new Error('expected openSecret to throw');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain('TREVRA_SECRETS_KEY is');
      expect(message).toContain('TREVRA_SECRETS_KEY_PREVIOUS is');
      for (const secret of [PLAINTEXT, OLD, NEW, third]) expect(message).not.toContain(secret);
    }
  });

  it('still refuses a tampered row rather than trying the previous key into garbage', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(NEW));
    const attacked: SealedSecret = { ...sealed, ciphertext: tamper(sealed.ciphertext) };
    expect(() => openSecret(attacked, CONTEXT, env(NEW, OLD))).toThrow(/failed authentication/i);
  });

  it('fails loudly on a malformed previous key instead of ignoring it', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(NEW));
    // A mis-deployed rotation must not look like a working one.
    expect(() => openSecret(sealed, CONTEXT, env(NEW, 'not base64 at all!!'))).toThrow(/TREVRA_SECRETS_KEY_PREVIOUS must be base64/);
    expect(() => openSecret(sealed, CONTEXT, env(NEW, randomBytes(16).toString('base64')))).toThrow(/TREVRA_SECRETS_KEY_PREVIOUS.*32 bytes/s);
  });

  it('tolerates a previous key identical to the current one', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(NEW));
    expect(openSecret(sealed, CONTEXT, env(NEW, NEW))).toBe(PLAINTEXT);
    // One key tried, so the failure text does not pretend there were two.
    const other = sealSecret(PLAINTEXT, CONTEXT, env(OLD));
    try {
      openSecret(other, CONTEXT, env(NEW, NEW));
      throw new Error('expected openSecret to throw');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('TREVRA_SECRETS_KEY_PREVIOUS is');
    }
  });

  it('ignores a blank previous key', () => {
    const sealed = sealSecret(PLAINTEXT, CONTEXT, env(NEW));
    expect(openSecret(sealed, CONTEXT, env(NEW, '   '))).toBe(PLAINTEXT);
  });
});
