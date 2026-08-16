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
 * ## Two envelopes, and why
 *
 * v1 -- AES-256-GCM, 96-bit IV, 128-bit tag, the master key used RAW, and no
 *       additional authenticated data. Everything sealed before this file grew
 *       the section below. STILL READ, NEVER WRITTEN.
 * v2 -- the same primitive with two things added, and what every write
 *       produces now:
 *
 *         1. a PER-WORKSPACE data key, HKDF-SHA256 of the master key with the
 *            workspace id as info;
 *         2. the ROW'S IDENTITY as AAD, so a sealed value opens in the row it
 *            was sealed for and in no other row anywhere.
 *
 * ### What v1 got wrong: ciphertext was portable between tenants
 *
 * v1 authenticated the BYTES and nothing else. GCM proved "these bytes were
 * sealed by someone holding this key" and stopped there -- it said nothing
 * about WHICH ROW the bytes belonged to, and row scoping was a SQL `WHERE`
 * clause and nothing else. So the tuple (ciphertext, iv, auth_tag,
 * key_version) lifted out of tenant A's `workspace_secrets` row and written
 * into tenant B's row decrypted cleanly, with a valid tag, and was then used
 * as B's credential: `agent/provider.ts` would put A's API key in B's
 * Authorization header, and `linkedin/driver.ts` would type A's LinkedIn
 * password into a browser signed in as B.
 *
 * Anything able to write a row was therefore a cross-tenant credential
 * transplant: a mis-scoped UPDATE, a restore of the wrong dump into the wrong
 * workspace, a support script, a SQL injection anywhere else in the product.
 * On a HOSTED MULTI-TENANT deployment that is the whole ballgame, and "the
 * query has a WHERE clause" is not a custody boundary.
 *
 * v2 closes it by binding the ciphertext to the row. GCM already refuses when
 * the AAD does not match byte for byte; the fix is entirely a matter of giving
 * it the right AAD.
 *
 * ### The AAD tuple, exactly
 *
 *     "trevra.secret.v2" US <store> US <workspace_id> US <seat_key> US <kind>
 *
 * US is U+001F (unit separator) and no component may contain one -- checked,
 * not assumed, so a component can never be split or merged into its neighbour.
 *
 *  store        'workspace_secrets' or 'linkedin_seat_credentials' -- the two
 *               homes a sealed value may have (see the header of
 *               secrets/linkedin.ts for why there are two).
 *  workspace_id THE TENANT. This is the component that closes the audit
 *               finding; the rest are there because a row's identity is not
 *               only its tenant.
 *  seat_key     which LinkedIn account within the workspace.
 *               `workspace_secrets` has no seat dimension, so its rows use the
 *               literal 'owner': that table IS the owner seat, by the
 *               definition migration 049 wrote down and enforces from the
 *               other side (`linkedin_seat_credentials.seat_key <> 'owner'`).
 *  kind         'model_api_key', 'linkedin.password', 'reddit.password', ...
 *
 * Those four components are exactly each table's unique index plus the table
 * itself, and that is the point: the AAD IS the row's primary identity. "Moved
 * to another tenant", "moved to another seat", "relabelled as another kind" and
 * "moved to the other table" are then one failure with one cause, and every one
 * of them is a refusal rather than a successful decrypt.
 *
 * ### Per-workspace data keys: what they buy, and what they do NOT
 *
 * Nothing is ever encrypted with the master key any more. Every seal and open
 * uses `HKDF-SHA256(ikm = master, salt = "trevra.secrets.hkdf.v2",
 * info = "workspace:<workspace_id>")`, so each tenant's rows are under their
 * own 32-byte data key.
 *
 * WHAT THIS BUYS:
 *  - A single derived data key, leaked on its own (a heap dump taken mid-
 *    request, a key that escaped into a crash report, a debugging session on
 *    one tenant), opens THAT tenant's rows and no one else's. Under v1 the
 *    only key that existed opened everything.
 *  - It makes the AAD binding structural rather than merely diligent: a v2 row
 *    moved between tenants is under the wrong key AND the wrong AAD, so it
 *    fails twice, and it would keep failing even if somebody later removed the
 *    setAAD call by mistake.
 *  - It makes a future KMS or per-tenant-key upgrade a change of key SOURCE,
 *    not a change of envelope format: replace `deriveWorkspaceKey` with a call
 *    to a KMS that hands back the same 32 bytes for the same workspace, and
 *    every stored row keeps opening.
 *
 * WHAT THIS DOES NOT BUY, SAID PLAINLY SO NOBODY BUYS IT:
 *  - It is NOT per-tenant key custody. There is still exactly one secret in
 *    the environment, and ANYONE WHO LEAKS TREVRA_SECRETS_KEY DERIVES EVERY
 *    TENANT'S DATA KEY with two lines of code -- the workspace ids are in the
 *    same database as the ciphertext. An env leak is still a total compromise
 *    of every customer's LinkedIn password.
 *  - It does not reduce the blast radius of a compromised server process: that
 *    process holds the master and can derive anything it likes.
 *  - It is not a compliance story about tenant key isolation, and must not be
 *    described as one.
 *
 * THE HONEST UPGRADE IS A KMS OR AN HSM: a per-workspace key that Trevra can
 * ask to be USED but can never read, with the unwrap logged and revocable per
 * tenant. This module is deliberately shaped so that upgrade is a change of
 * `deriveWorkspaceKey` and nothing else.
 *
 * ## Rotating the server key
 *
 * byok-and-hosted-agent.md section 3 promises the server key "can be rotated by
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
 * 2. Re-encrypt in the background: `secrets/custody.ts` `resealSecrets()` reads
 *    each row and stores it again under the current key and the v2 envelope.
 *    It is a read-then-write loop, safe to re-run, and it REPORTS what is left.
 * 3. Drop `TREVRA_SECRETS_KEY_PREVIOUS` and deploy again -- but only once
 *    `secretsCustodyReport()` says `complete`. See below.
 *
 * No step takes writes offline and no step needs a migration.
 *
 * Why two variables rather than a `key_version` -> key map, which is what the
 * `key_version` column first suggested: a map makes the operator hand-maintain
 * version numbers in the environment and keep them in step with rows, and gets
 * that wrong exactly once before a row is unreadable. Trial decryption over at
 * most two keys is one extra GCM open on a 32-byte value during a rotation
 * window only, and GCM's tag makes "is this the right key" an exact question
 * rather than a guess. `key_version` stays what it can actually be checked
 * against -- the envelope FORMAT (v1 = raw key, no AAD; v2 = per-workspace key
 * + row-bound AAD) -- so a future change of scheme still has its version field,
 * and openSecret refuses a version it does not implement rather than
 * mis-parsing it.
 *
 * ### ...and why that argument still left rotation UNVERIFIABLE
 *
 * All of the above is true and none of it answered the only question an
 * operator actually has at step 3: WHICH ROWS ARE STILL ON THE OLD KEY? Trial
 * decryption tells you a row opens; it does not tell you which key opened it,
 * and nothing was written down. So step 2 had no completion criterion, step 3
 * was a guess, and dropping `TREVRA_SECRETS_KEY_PREVIOUS` one row too early
 * bricked the remainder silently -- the failure only surfaced later, at use
 * time, as a 500 on somebody's agent run.
 *
 * The fix is to give each key an IDENTITY and record it on the row it sealed:
 * `key_id`, a 128-bit HKDF fingerprint of the key material (`keyFingerprint`).
 * It is derived, not configured, so the objection above still holds in full --
 * the operator hand-maintains nothing and there is no map to get out of step.
 * A key IS its fingerprint, computed from the bytes it already has.
 *
 * With that column, `SELECT key_version, key_id, COUNT(*)` answers "what is
 * left" exactly, `resealSecrets()` has a completion criterion, and
 * `describeWorkspaceSecret` can tell an operator that a row is sealed under a
 * key THIS DEPLOYMENT DOES NOT HOLD -- without decrypting anything. That last
 * one is the other half of the audit finding: a wrong or half-rotated key used
 * to throw at USE time while the setup screen, which reads metadata only, kept
 * cheerfully reporting the secret as configured. A green screen over a broken
 * deployment. `secretCustody()` below is what a screen shows instead.
 *
 * Publishing the fingerprint is safe: it is a 128-bit HKDF output under its own
 * info string, so it cannot be inverted to key material and cannot be confused
 * with a data key. It buys an attacker with a database dump nothing they did
 * not already have -- GCM's tag already confirms a guessed key just as cheaply.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const KEY_ENV = 'TREVRA_SECRETS_KEY';
/** Read path only. Present during a rotation window, absent the rest of the time. */
const PREVIOUS_KEY_ENV = 'TREVRA_SECRETS_KEY_PREVIOUS';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits: the size GCM is specified for, and the only one that avoids an extra hashing step. */
const IV_BYTES = 12;

/** Master key used raw, no AAD. Read-only: nothing writes this any more. */
export const ENVELOPE_V1 = 1;
/** Per-workspace HKDF data key, row identity as AAD, key fingerprint recorded. */
export const ENVELOPE_V2 = 2;
/** The envelope every write produces. Stored in the `key_version` column. */
export const CURRENT_ENVELOPE_VERSION = ENVELOPE_V2;

/**
 * HKDF domain separation. The salt is a constant rather than random because
 * the input keying material is already a uniformly random 32 bytes -- HKDF's
 * extract step has nothing left to extract, and a per-row salt would have to
 * be stored, which is a column and a migration for no gain. The INFO string is
 * what carries the per-workspace separation, which is what HKDF's info
 * parameter is for.
 */
const HKDF_HASH = 'sha256';
const HKDF_SALT = Buffer.from('trevra.secrets.hkdf.v2', 'utf8');
/** A different info string, so a fingerprint can never collide with a data key. */
const KEY_ID_INFO = Buffer.from('trevra.secrets.key-id.v2', 'utf8');
/** 128 bits. Enough that two distinct keys will not share a fingerprint. */
const KEY_ID_BYTES = 16;

const AAD_PREFIX = 'trevra.secret.v2';
/** U+001F, unit separator: not producible by any id, seat key or kind. */
const AAD_SEPARATOR = '';

/**
 * The tables a sealed value may live in, and nothing else.
 *
 * `linkedin_seat_sessions` (migration 065) joined the list when hosted
 * execution did: a browser attached over CDP has no user-data-dir, so the
 * seat's signed-in state travels as `storageState` and a LinkedIn session
 * cookie IS the account -- the same custody as the password that produced it,
 * bound to the same (store, workspace, seat, kind) identity, or it is not
 * custody at all.
 */
export type SecretStore = 'workspace_secrets' | 'linkedin_seat_credentials' | 'linkedin_seat_sessions' | 'linkedin_seat_proxy_secrets';

/**
 * The seat component for a row with no seat dimension.
 *
 * Spelled here rather than imported from `linkedin/seats.ts` on purpose: this
 * literal is part of the AAD, so it is part of the on-disk format. Importing
 * it would let a rename on the other side of the codebase silently make every
 * stored secret unopenable, which is a worse failure than a duplicated string.
 * Same argument as `assertSeatKey` in secrets/linkedin.ts repeating the seat
 * alphabet rather than sharing it.
 */
export const OWNER_SEAT_COMPONENT = 'owner';

/**
 * WHICH ROW this ciphertext belongs to. Passed on both seal and open, and
 * authenticated by GCM -- so getting it wrong is a refusal, never a silent
 * decrypt into the wrong tenant's request.
 */
export interface SecretContext {
  store: SecretStore;
  workspaceId: string;
  /** `OWNER_SEAT_COMPONENT` for `workspace_secrets`. */
  seatKey: string;
  kind: string;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** The envelope FORMAT (`key_version` column): ENVELOPE_V1 or ENVELOPE_V2. */
  keyVersion: number;
  /** Fingerprint of the master key that sealed it. Null on v1 rows only. */
  keyId: string | null;
}

/** Fingerprints of the keys this process holds. Either may be null. */
export interface ConfiguredKeyIds {
  current: string | null;
  previous: string | null;
}

/**
 * Where one stored row stands, decided from metadata alone -- no decryption,
 * so a status screen can ask it on every read.
 *
 *  'current'  sealed with the key this deployment writes with. Nothing to do.
 *  'previous' sealed with the outgoing key. Readable; the rotation is not
 *             finished, and dropping TREVRA_SECRETS_KEY_PREVIOUS now would
 *             brick this row.
 *  'legacy'   a v1 envelope: opens, but is NOT bound to its row and records no
 *             key. Portable between tenants until it is re-sealed.
 *  'unknown'  sealed with a key this deployment does not hold. THIS ROW CANNOT
 *             BE OPENED. It is the case that used to look configured and green
 *             and then threw at use time.
 *  'unsealed' this process has no TREVRA_SECRETS_KEY at all, so BYOK is off
 *             and nothing here can be opened by anyone.
 */
export type SecretCustody = 'current' | 'previous' | 'legacy' | 'unknown' | 'unsealed';

interface ServerKey {
  id: string;
  key: Buffer;
  /** The variable it came from, for error messages only. */
  source: string;
}

/**
 * Whether BYOK is switched on for this process. Presence only: a key that is
 * present but malformed reports as configured and then fails loudly on use,
 * because silently reporting "off" would hide a deployment mistake.
 */
export function secretsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[KEY_ENV]?.trim());
}

/**
 * The fingerprints of the keys this process holds, for reporting.
 *
 * REPORTS RATHER THAN THROWS, and that is the one place in this module where
 * leniency is correct: this function exists to diagnose a broken deployment,
 * and a diagnostic that throws is how the broken deployment stayed invisible
 * in the first place. An absent or malformed key yields null, every row then
 * reads as 'unsealed' or 'unknown', and the screen says so. Every path that
 * actually USES a key still goes through `loadKey`, which still throws.
 */
export function configuredKeyIds(env: NodeJS.ProcessEnv = process.env): ConfiguredKeyIds {
  return {
    current: fingerprintOrNull(env[KEY_ENV], KEY_ENV),
    previous: fingerprintOrNull(env[PREVIOUS_KEY_ENV], PREVIOUS_KEY_ENV)
  };
}

/**
 * Where a stored row stands, from its two metadata columns and the environment.
 * No ciphertext, no key use, no decryption -- see `SecretCustody`.
 */
export function secretCustody(
  envelopeVersion: number,
  keyId: string | null,
  ids: ConfiguredKeyIds
): SecretCustody {
  if (!ids.current) return 'unsealed';
  if (envelopeVersion === ENVELOPE_V1) return 'legacy';
  if (keyId && keyId === ids.current) return 'current';
  if (keyId && keyId === ids.previous) return 'previous';
  // A v2 row with no fingerprint should not exist -- every v2 write records
  // one -- and if one does, it is unattributable, which is exactly 'unknown'.
  return 'unknown';
}

/** True while a row is not yet on the current key AND the v2 envelope. */
export function needsReseal(envelopeVersion: number, keyId: string | null, ids: ConfiguredKeyIds): boolean {
  return secretCustody(envelopeVersion, keyId, ids) !== 'current';
}

export function sealSecret(
  plaintext: string,
  context: SecretContext,
  env: NodeJS.ProcessEnv = process.env
): SealedSecret {
  const master = loadKey(env);
  const key = deriveWorkspaceKey(master, context.workspaceId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  // The line the audit was about. Before it, ciphertext was portable between
  // tenants; after it, a row only opens where it was written.
  cipher.setAAD(secretAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: CURRENT_ENVELOPE_VERSION,
    keyId: keyFingerprint(master)
  };
}

/**
 * Open a sealed secret with the current key, falling back to
 * `TREVRA_SECRETS_KEY_PREVIOUS` when one is configured.
 *
 * The fallback is read-only and deliberately narrow: exactly one older key, and
 * only while the operator has chosen to have one present.
 *
 * `context` must be the identity of the row the ciphertext was READ FROM, not
 * the row it is wanted for -- those are the same thing for every honest caller,
 * and their being different is precisely the attack this refuses.
 *
 * v1 rows still open, unbound, because a deployment that upgrades must keep
 * reading its secrets. They are not silently blessed: they report as 'legacy'
 * and `resealSecrets()` exists to end them.
 */
export function openSecret(
  sealed: SealedSecret,
  context: SecretContext,
  env: NodeJS.ProcessEnv = process.env
): string {
  const keys = loadDecryptionKeys(env);

  if (sealed.keyVersion === ENVELOPE_V1) return openLegacy(sealed, keys);
  if (sealed.keyVersion !== ENVELOPE_V2) {
    throw new Error(`Stored secret was sealed with envelope version ${sealed.keyVersion}, but this server only implements versions ${ENVELOPE_V1} and ${ENVELOPE_V2}`);
  }

  const aad = secretAad(context);
  // When the row names the key that sealed it, believe it: trying the other
  // key would turn "you are missing a key" into an indistinguishable
  // authentication failure, and that ambiguity is what made a half-finished
  // rotation impossible to diagnose.
  const candidates = sealed.keyId ? keys.filter((entry) => entry.id === sealed.keyId) : keys;
  if (candidates.length === 0) {
    throw new Error(
      `Stored secret was sealed with server key ${sealed.keyId}, which this deployment does not hold `
      + `(${KEY_ENV} is ${keys[0]?.id ?? 'absent'}${keys[1] ? `, ${PREVIOUS_KEY_ENV} is ${keys[1].id}` : ''}). `
      + `Restore that key as ${PREVIOUS_KEY_ENV} and re-encrypt, or delete and re-enter this secret.`
    );
  }

  for (const entry of candidates) {
    try {
      const decipher = createDecipheriv(ALGORITHM, deriveWorkspaceKey(entry.key, context.workspaceId), sealed.iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong row, tampered ciphertext, or any combination -- GCM
      // cannot tell us which, and the underlying error is discarded either way
      // so nothing about the key or the stored value can reach a log or a bug
      // report. Try the next key.
    }
  }

  // The key is right (its fingerprint matched) and the bytes still did not
  // authenticate, so what changed is the ROW: this ciphertext was sealed
  // somewhere else and moved here. Say that, because the alternative -- a
  // generic "failed authentication" -- is what let a cross-tenant transplant
  // look like an ordinary key problem.
  throw new Error(
    `Stored secret failed authentication for ${context.store} `
    + `(workspace ${context.workspaceId}, seat ${context.seatKey}, kind ${context.kind}): `
    + 'it was sealed for a DIFFERENT row -- another workspace, seat, kind or table -- or it was tampered with. '
    + 'A sealed secret is bound to the row it was written to and cannot be moved between rows.'
  );
}

/**
 * The pre-audit envelope: master key raw, no AAD, no recorded key.
 *
 * Kept because backwards compatibility with already-sealed rows is mandatory --
 * a deployment that upgrades must keep reading its secrets. It is NOT a
 * fallback for v2: `openSecret` dispatches on the stored version and never
 * retries here, so an attacker cannot downgrade a v2 row to the unbound path by
 * editing `key_version` (the version is not authenticated, but v2 ciphertext
 * fails under the master key anyway -- it was never sealed with it).
 */
function openLegacy(sealed: SealedSecret, keys: ServerKey[]): string {
  for (const entry of keys) {
    try {
      const decipher = createDecipheriv(ALGORITHM, entry.key, sealed.iv);
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // As above: nothing about the key or the value may reach a log.
    }
  }
  const tried = keys.length > 1 ? `${KEY_ENV} or ${PREVIOUS_KEY_ENV}` : KEY_ENV;
  throw new Error(`Stored secret failed authentication: it was sealed with a different ${tried}, or the row was tampered with`);
}

/**
 * The row's identity, as bytes GCM will authenticate.
 *
 * Every component is checked for the separator rather than trusted to be free
 * of it: an unchecked separator inside a component would let two different
 * rows produce the same AAD, which is the whole binding gone.
 */
function secretAad(context: SecretContext): Buffer {
  const parts = [AAD_PREFIX, context.store, context.workspaceId, context.seatKey, context.kind];
  for (const part of parts) {
    if (!part || part.includes(AAD_SEPARATOR)) {
      throw new Error('A secret context needs a non-empty store, workspaceId, seatKey and kind, none containing U+001F');
    }
  }
  return Buffer.from(parts.join(AAD_SEPARATOR), 'utf8');
}

/**
 * The workspace's data key. Cheap enough (two HMAC-SHA256 rounds on 32 bytes)
 * that caching it would only add a place for key material to outlive a request.
 */
function deriveWorkspaceKey(master: Buffer, workspaceId: string): Buffer {
  const info = Buffer.from(`workspace:${workspaceId}`, 'utf8');
  return Buffer.from(hkdfSync(HKDF_HASH, master, HKDF_SALT, info, KEY_BYTES));
}

/** A key's identity: derived from the key, never configured. See the header. */
function keyFingerprint(key: Buffer): string {
  return Buffer.from(hkdfSync(HKDF_HASH, key, HKDF_SALT, KEY_ID_INFO, KEY_ID_BYTES)).toString('base64url');
}

function fingerprintOrNull(raw: string | undefined, name: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return keyFingerprint(parseKey(trimmed, name));
  } catch {
    // Malformed. Reported as "no such key" so every row reads as unopenable,
    // which is the truth; the use paths still throw with the real reason.
    return null;
  }
}

/** The current key first, then the previous one when it is set and differs. */
function loadDecryptionKeys(env: NodeJS.ProcessEnv): ServerKey[] {
  const current = loadKey(env);
  const keys: ServerKey[] = [{ id: keyFingerprint(current), key: current, source: KEY_ENV }];
  const raw = env[PREVIOUS_KEY_ENV]?.trim();
  if (!raw) return keys;
  // Loud, not lenient: a malformed previous key means the rotation was
  // mis-deployed, and silently ignoring it would look like data loss later.
  const previous = parseKey(raw, PREVIOUS_KEY_ENV);
  if (previous.equals(current)) return keys;
  keys.push({ id: keyFingerprint(previous), key: previous, source: PREVIOUS_KEY_ENV });
  return keys;
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
