/**
 * AES-256-GCM sealing for workspace secrets.
 *
 * The server key lives in TREVRA_SECRETS_KEY (environment), the ciphertext
 * lives in Postgres. Neither half is useful alone, which is the whole security
 * argument -- so this module has no plaintext fallback and no built-in key.
 * Absent the variable, BYOK is simply off: `secretsConfigured()` returns false
 * and sealing or opening throws rather than storing anything in the clear.
 *
 * GCM (not CBC/CTR) because it authenticates: a tampered ciphertext, tag or IV
 * fails to open instead of yielding garbage that would then be sent to a model
 * provider as an Authorization header.
 *
 * ## Rotating the server key
 *
 * byok-and-hosted-agent.md §3 promises the server key "can be rotated by
 * re-encrypting rows, without a schema change and without downtime". Two
 * variables make that true:
 *
 * | Variable | Used for |
 * |---|---|
 * | `TREVRA_SECRETS_KEY` | every write, and tried first on every read |
 * | `TREVRA_SECRETS_KEY_PREVIOUS` | reads only, tried second. Optional. |
 *
 * 1. Set `TREVRA_SECRETS_KEY_PREVIOUS` to the current key, `TREVRA_SECRETS_KEY`
 *    to the new one, and deploy. Every existing row still opens (second key),
 *    every write is already sealed with the new key.
 * 2. Re-encrypt in the background: read each secret and store it again.
 *    `putWorkspaceSecret` re-seals with the current key, so this is just a
 *    read-then-write loop and is safe to re-run.
 * 3. Drop `TREVRA_SECRETS_KEY_PREVIOUS` and deploy again.
 *
 * No step takes writes offline and no step needs a migration.
 *
 * Why two variables rather than a `key_version` → key map, which is what the
 * `key_version` column first suggested: a map makes the operator hand-maintain
 * version numbers in the environment and keep them in step with rows, and gets
 * that wrong exactly once before a row is unreadable. Trial decryption over at
 * most two keys is one extra GCM open on a 32-byte value during a rotation
 * window only, and GCM's tag makes "is this the right key" an exact question
 * rather than a guess. `key_version` stays what it can actually be checked
 * against -- the envelope FORMAT (v1 = AES-256-GCM, 96-bit IV, 128-bit tag) --
 * so a future change of scheme still has its version field, and openSecret
 * refuses a version it does not implement rather than mis-parsing it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV = 'TREVRA_SECRETS_KEY';
/** Read path only. Present during a rotation window, absent the rest of the time. */
const PREVIOUS_KEY_ENV = 'TREVRA_SECRETS_KEY_PREVIOUS';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits: the size GCM is specified for, and the only one that avoids an extra hashing step. */
const IV_BYTES = 12;
/** The envelope format, not the key's identity -- see the rotation note above. */
const CURRENT_KEY_VERSION = 1;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

/**
 * Whether BYOK is switched on for this process. Presence only: a key that is
 * present but malformed reports as configured and then fails loudly on use,
 * because silently reporting "off" would hide a deployment mistake.
 */
export function secretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[KEY_ENV]?.trim());
}

export function sealSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): SealedSecret {
  const key = loadKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

/**
 * Open a sealed secret with the current key, falling back to
 * `TREVRA_SECRETS_KEY_PREVIOUS` when one is configured.
 *
 * The fallback is read-only and deliberately narrow: exactly one older key, and
 * only while the operator has chosen to have one present.
 */
export function openSecret(sealed: SealedSecret, env: NodeJS.ProcessEnv = process.env): string {
  const keys = loadDecryptionKeys(env);
  if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(`Stored secret was sealed with key version ${sealed.keyVersion}, but this server only implements version ${CURRENT_KEY_VERSION}`);
  }
  for (const key of keys) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, tampered row, or both -- GCM cannot tell us which, and the
      // underlying error is discarded either way so nothing about the key or
      // the stored value can reach a log or a bug report. Try the next key.
    }
  }
  const tried = keys.length > 1 ? `${KEY_ENV} or ${PREVIOUS_KEY_ENV}` : KEY_ENV;
  throw new Error(`Stored secret failed authentication: it was sealed with a different ${tried}, or the row was tampered with`);
}

/** The current key first, then the previous one when it is set and differs. */
function loadDecryptionKeys(env: NodeJS.ProcessEnv): Buffer[] {
  const current = loadKey(env);
  const raw = env[PREVIOUS_KEY_ENV]?.trim();
  if (!raw) return [current];
  // Loud, not lenient: a malformed previous key means the rotation was
  // mis-deployed, and silently ignoring it would look like data loss later.
  const previous = parseKey(raw, PREVIOUS_KEY_ENV);
  return previous.equals(current) ? [current] : [current, previous];
}

function loadKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env[KEY_ENV]?.trim();
  if (!raw) throw new Error(`${KEY_ENV} is not configured, so encrypted secrets are unavailable`);
  return parseKey(raw, KEY_ENV);
}

function parseKey(raw: string, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error(`${name} must be base64 (generate with: openssl rand -base64 32)`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`${name} must decode to exactly ${KEY_BYTES} bytes, got ${key.byteLength} (generate with: openssl rand -base64 32)`);
  }
  return key;
}
