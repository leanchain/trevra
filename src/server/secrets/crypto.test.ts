import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret, secretsConfigured, type SealedSecret } from './crypto.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const PLAINTEXT = 'sk-live-9f3c1d2b4a6e8017';

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

describe('sealSecret / openSecret', () => {
  it('round-trips a value', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('sk-live');
    expect(openSecret(sealed, env(KEY))).toBe(PLAINTEXT);
  });

  it('never reuses an IV, so the same key sealed twice looks different', () => {
    const first = sealSecret(PLAINTEXT, env(KEY));
    const second = sealSecret(PLAINTEXT, env(KEY));

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(openSecret(first, env(KEY))).toBe(openSecret(second, env(KEY)));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, ciphertext: tamper(sealed.ciphertext) };
    expect(() => openSecret(attacked, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses a tampered auth tag', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, authTag: tamper(sealed.authTag) };
    expect(() => openSecret(attacked, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses a tampered IV', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    const attacked: SealedSecret = { ...sealed, iv: tamper(sealed.iv) };
    expect(() => openSecret(attacked, env(KEY))).toThrow(/failed authentication/i);
  });

  it('refuses to open with the wrong server key: a stolen database alone is useless', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    expect(() => openSecret(sealed, env(OTHER_KEY))).toThrow(/failed authentication/i);
  });

  it('refuses a row sealed by a key version this server does not hold', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    expect(() => openSecret({ ...sealed, keyVersion: 2 }, env(KEY))).toThrow(/key version 2/);
  });

  it('leaks neither plaintext nor key material in the failure message', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));
    try {
      openSecret(sealed, env(OTHER_KEY));
      throw new Error('expected openSecret to throw');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain(PLAINTEXT);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(OTHER_KEY);
    }
  });
});

describe('key configuration', () => {
  it('reports BYOK off and refuses to seal or open when the key is absent', () => {
    const sealed = sealSecret(PLAINTEXT, env(KEY));

    expect(secretsConfigured(env())).toBe(false);
    expect(secretsConfigured(env('   '))).toBe(false);
    expect(secretsConfigured(env(KEY))).toBe(true);

    // Never a plaintext fallback: without the key the feature is simply off.
    expect(() => sealSecret(PLAINTEXT, env())).toThrow(/TREVRA_SECRETS_KEY/);
    expect(() => openSecret(sealed, env())).toThrow(/TREVRA_SECRETS_KEY/);
  });

  it('names the variable when the key is not base64', () => {
    expect(() => sealSecret(PLAINTEXT, env('not base64 at all!!'))).toThrow(/TREVRA_SECRETS_KEY/);
  });

  it('names the variable when the key is the wrong length', () => {
    const tooShort = randomBytes(16).toString('base64');
    const tooLong = randomBytes(64).toString('base64');
    expect(() => sealSecret(PLAINTEXT, env(tooShort))).toThrow(/TREVRA_SECRETS_KEY.*32 bytes/s);
    expect(() => sealSecret(PLAINTEXT, env(tooLong))).toThrow(/TREVRA_SECRETS_KEY.*32 bytes/s);
  });
});

/**
 * byok-and-hosted-agent.md §3: the server key "can be rotated by re-encrypting
 * rows, without a schema change and without downtime". That needs a read path
 * that still accepts the outgoing key while the write path has moved on.
 */
describe('server key rotation', () => {
  const OLD = KEY;
  const NEW = OTHER_KEY;

  it('walks the whole rotation with no failed read and no failed write', () => {
    // Before: a row sealed with the old key.
    const existing = sealSecret(PLAINTEXT, env(OLD));

    // Step 1 -- new key current, old key demoted to read-only. Deploy.
    const during = env(NEW, OLD);
    expect(openSecret(existing, during)).toBe(PLAINTEXT);
    const written = sealSecret(PLAINTEXT, during);
    expect(openSecret(written, during)).toBe(PLAINTEXT);

    // Step 2 -- the background job re-encrypts: read, then write back.
    const resealed = sealSecret(openSecret(existing, during), during);

    // Step 3 -- drop the previous key. Everything written since step 1 opens.
    expect(openSecret(resealed, env(NEW))).toBe(PLAINTEXT);
    expect(openSecret(written, env(NEW))).toBe(PLAINTEXT);
  });

  it('seals with the current key only, never the previous one', () => {
    const sealed = sealSecret(PLAINTEXT, env(NEW, OLD));
    // If writes had used the previous key this would fail after step 3.
    expect(openSecret(sealed, env(NEW))).toBe(PLAINTEXT);
    expect(() => openSecret(sealed, env(OLD))).toThrow(/failed authentication/i);
  });

  it('accepts the previous key for reads only while it is configured', () => {
    const sealed = sealSecret(PLAINTEXT, env(OLD));
    expect(openSecret(sealed, env(NEW, OLD))).toBe(PLAINTEXT);
    // Rotation finished: the old key is gone and so is the row's readability.
    expect(() => openSecret(sealed, env(NEW))).toThrow(/failed authentication/i);
  });

  it('names both variables once a previous key is configured, and still leaks nothing', () => {
    const third = randomBytes(32).toString('base64');
    const sealed = sealSecret(PLAINTEXT, env(third));
    try {
      openSecret(sealed, env(NEW, OLD));
      throw new Error('expected openSecret to throw');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toMatch(/TREVRA_SECRETS_KEY or TREVRA_SECRETS_KEY_PREVIOUS/);
      for (const secret of [PLAINTEXT, OLD, NEW, third]) expect(message).not.toContain(secret);
    }
  });

  it('still refuses a tampered row rather than trying the previous key into garbage', () => {
    const sealed = sealSecret(PLAINTEXT, env(NEW));
    const attacked: SealedSecret = { ...sealed, ciphertext: tamper(sealed.ciphertext) };
    expect(() => openSecret(attacked, env(NEW, OLD))).toThrow(/failed authentication/i);
  });

  it('fails loudly on a malformed previous key instead of ignoring it', () => {
    const sealed = sealSecret(PLAINTEXT, env(NEW));
    // A mis-deployed rotation must not look like a working one.
    expect(() => openSecret(sealed, env(NEW, 'not base64 at all!!'))).toThrow(/TREVRA_SECRETS_KEY_PREVIOUS must be base64/);
    expect(() => openSecret(sealed, env(NEW, randomBytes(16).toString('base64')))).toThrow(/TREVRA_SECRETS_KEY_PREVIOUS.*32 bytes/s);
  });

  it('tolerates a previous key identical to the current one', () => {
    const sealed = sealSecret(PLAINTEXT, env(NEW));
    expect(openSecret(sealed, env(NEW, NEW))).toBe(PLAINTEXT);
    // One key tried, so the failure text does not pretend there were two.
    const other = sealSecret(PLAINTEXT, env(OLD));
    expect(() => openSecret(other, env(NEW, NEW))).toThrow(/different TREVRA_SECRETS_KEY,/);
  });

  it('ignores a blank previous key', () => {
    const sealed = sealSecret(PLAINTEXT, env(NEW));
    expect(openSecret(sealed, env(NEW, '   '))).toBe(PLAINTEXT);
  });
});
