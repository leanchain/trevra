/**
 * Key custody reporting and re-encryption: the answer to "which rows are still
 * on the old key", and the loop that ends them.
 *
 * ## Why this module exists
 *
 * `crypto.ts` documents a three-step key rotation and could not verify step 2.
 * Nothing recorded WHICH key sealed a row, so "re-encrypt in the background"
 * had no completion criterion; the operator dropped
 * `TREVRA_SECRETS_KEY_PREVIOUS` when it felt long enough, and if that was one
 * row too early the remainder bricked SILENTLY -- the failure surfaced days
 * later as a 500 on somebody's agent run, with the key that would have fixed
 * it already gone.
 *
 * The same gap applies to the v1 -> v2 envelope transition. Rows sealed before
 * the AAD binding still open (backwards compatibility is mandatory), but they
 * are still portable between tenants until they are re-sealed. "Re-seal on
 * next write" fixes an active workspace; it never fixes the workspace that
 * saved its key eight months ago and has not touched it since.
 *
 * So: `secretsCustodyReport` counts, `resealSecrets` converts, and the pair of
 * them make both transitions VERIFIABLE. Neither invents a policy -- they read
 * `key_version` and `key_id`, which `crypto.ts` now writes on every seal.
 *
 * ## The operator's transition, end to end
 *
 *   1. Deploy this build. Reads accept v1 and v2; every write produces v2.
 *   2. Run the re-encrypt pass until it reports nothing left:
 *
 *        npx tsx --eval "const {openDatabase}=await import('./src/server/db.ts'); \
 *          const c=await import('./src/server/secrets/custody.ts'); \
 *          const db=await openDatabase({seedDemo:false}); \
 *          console.log(await c.resealSecrets(db)); \
 *          console.log(await c.secretsCustodyReport(db)); await db.close();"
 *
 *      It is a read-then-write loop, safe to re-run, and it never widens what
 *      may be read (see THE HOSTED REFUSAL below).
 *   3. `secretsCustodyReport(db).complete === true` means every row is on the
 *      v2 envelope AND on the CURRENT key. Only then may
 *      `TREVRA_SECRETS_KEY_PREVIOUS` be dropped -- that sentence is the whole
 *      point of this file.
 *
 * A row that reports `unknown` is sealed with a key this deployment does not
 * hold and CANNOT be recovered here: no amount of re-running helps, and the
 * report says so rather than looping. The fix is to restore that key as
 * `TREVRA_SECRETS_KEY_PREVIOUS`, or to delete the secret and have the
 * workspace enter it again.
 *
 * ## THE HOSTED REFUSAL IS NOT RELAXED FOR MAINTENANCE
 *
 * `secrets/linkedin.ts` and `secrets/reddit.ts` refuse to open a LinkedIn or
 * Reddit password on a hosted deployment, unconditionally and with no
 * override, including for rows a dump may have left behind. Re-encryption is a
 * read followed by a write, so a re-encrypt loop that touched those rows would
 * be a way to decrypt them on hosted -- an override, arrived at sideways, in a
 * maintenance script. It does not get one. Those rows are SKIPPED, with a
 * reason, and counted separately, so the report is honest about what it did
 * not convert rather than quietly reporting completion.
 */
import { linkedInWorkerConfig, redditWorkerConfig } from '../config.js';
import type { Db } from '../db.js';
import {
  configuredKeyIds,
  needsReseal,
  openSecret,
  sealSecret,
  secretCustody,
  OWNER_SEAT_COMPONENT,
  type SecretContext,
  type SecretCustody,
  type SecretStore
} from './crypto.js';
import { seatCredentialContext } from './linkedin.js';
import { seatProxySecretContext } from '../linkedin/seats.js';
import { workspaceSecretContext, type WorkspaceSecretKind } from './store.js';

/** One row's standing, with nothing about its value in it. */
export interface SecretCustodyRow {
  store: SecretStore;
  id: string;
  workspaceId: string;
  seatKey: string;
  kind: string;
  envelopeVersion: number;
  keyId: string | null;
  custody: SecretCustody;
}

export interface SecretsCustodyReport {
  /** Whether this process holds a TREVRA_SECRETS_KEY at all. */
  configured: boolean;
  currentKeyId: string | null;
  previousKeyId: string | null;
  total: number;
  counts: Record<SecretCustody, number>;
  /** Rows a re-encrypt pass would convert: legacy envelope or outgoing key. */
  pending: number;
  /** Rows sealed with a key nobody here holds. A re-encrypt pass cannot help. */
  unreadable: number;
  /**
   * TRUE MEANS `TREVRA_SECRETS_KEY_PREVIOUS` MAY BE DROPPED. Nothing else in
   * this codebase is allowed to be the basis for that decision.
   */
  complete: boolean;
  /** Every row that is not 'current', so an operator can chase specific ones. */
  outstanding: SecretCustodyRow[];
}

export interface ResealResult {
  scanned: number;
  resealed: number;
  /** Refused on purpose -- see THE HOSTED REFUSAL above. */
  skipped: Array<{ store: SecretStore; id: string; reason: string }>;
  /** Could not be opened. The reason never contains the value. */
  failed: Array<{ store: SecretStore; id: string; reason: string }>;
  /** Rows still not on the current key and envelope after this pass. */
  remaining: number;
}

interface CustodyRowData {
  store: SecretStore;
  id: string;
  workspace_id: string;
  seat_key: string;
  kind: string;
  key_version: number;
  key_id: string | null;
}

/*
 * Both reads take an optional workspace filter, and it is a real operator
 * capability rather than a test affordance: on a hosted deployment "re-key one
 * tenant" is a thing an operator does -- after a support incident, after a
 * customer's own key handling changes, or to stage a rotation over a fleet
 * rather than in one pass. The default remains deployment-wide, because the
 * question the rotation runbook could not answer is a deployment-wide one.
 */
const WORKSPACE_SECRET_ROWS = `
  SELECT id, workspace_id, kind, key_version, key_id
  FROM workspace_secrets
  WHERE (?::text IS NULL OR workspace_id = ?::text)
  ORDER BY workspace_id, kind
`;
const SEAT_CREDENTIAL_ROWS = `
  SELECT id, workspace_id, seat_key, kind, key_version, key_id
  FROM linkedin_seat_credentials
  WHERE (?::text IS NULL OR workspace_id = ?::text)
  ORDER BY workspace_id, seat_key, kind
`;
const SEAT_PROXY_ROWS = `
  SELECT id, workspace_id, seat_key, 'linkedin.proxy'::text AS kind, key_version, key_id
  FROM linkedin_seat_proxy_secrets
  WHERE (?::text IS NULL OR workspace_id = ?::text)
  ORDER BY workspace_id, seat_key
`;
const CAPTURE_SOURCE_SECRET_ROWS = `
  SELECT id, workspace_id, capture_source_id AS seat_key, slot AS kind, key_version, key_id
  FROM capture_source_secrets
  WHERE (?::text IS NULL OR workspace_id = ?::text)
  ORDER BY workspace_id, capture_source_id, slot
`;

/**
 * WHICH ROWS ARE STILL ON THE OLD KEY -- the question the rotation runbook
 * could not answer.
 *
 * Metadata only: two indexless scans of two small tables (one row per
 * workspace per kind), no ciphertext read, no key used, nothing decrypted. It
 * is therefore safe to call on a hosted deployment, on a deployment with no
 * key at all, and from a status endpoint.
 */
export async function secretsCustodyReport(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  options: { workspaceId?: string } = {}
): Promise<SecretsCustodyReport> {
  const ids = configuredKeyIds(env);
  const rows = await loadCustodyRows(db, options.workspaceId);
  const counts: Record<SecretCustody, number> = {
    current: 0,
    previous: 0,
    legacy: 0,
    unknown: 0,
    unsealed: 0
  };
  const outstanding: SecretCustodyRow[] = [];

  for (const row of rows) {
    const custody = secretCustody(Number(row.key_version), row.key_id, ids);
    counts[custody] += 1;
    if (custody === 'current') continue;
    outstanding.push({
      store: row.store,
      id: row.id,
      workspaceId: row.workspace_id,
      seatKey: row.seat_key,
      kind: row.kind,
      envelopeVersion: Number(row.key_version),
      keyId: row.key_id,
      custody
    });
  }

  const pending = counts.legacy + counts.previous;
  return {
    configured: ids.current !== null,
    currentKeyId: ids.current,
    previousKeyId: ids.previous,
    total: rows.length,
    counts,
    pending,
    unreadable: counts.unknown,
    // 'unsealed' rows are counted too: with no key configured, "complete"
    // would be a lie about a deployment that cannot open anything.
    complete:
      ids.current !== null && pending === 0 && counts.unknown === 0 && counts.unsealed === 0,
    outstanding
  };
}

/**
 * Re-encrypt every row that is not already on the current key and the current
 * envelope: open it with whatever still opens it, seal it again bound to its
 * own identity, write it back.
 *
 * Idempotent and interruptible -- a row already on the current key is not
 * touched, and a pass that dies halfway leaves every row either fully old or
 * fully new, never in between (one UPDATE per row, and the envelope's four
 * columns move together).
 *
 * The plaintext exists as a local for the two statements between the open and
 * the seal and is never logged, returned, audited or put on any object that
 * outlives the iteration. No audit row is written either: nothing about the
 * SECRET changed, only the bytes it is stored as, and an audit trail that
 * cannot distinguish "the operator replaced their key" from "maintenance
 * re-encrypted it" is worse than one that reports only the former.
 */
export async function resealSecrets(
  db: Db,
  options: { env?: NodeJS.ProcessEnv; workspaceId?: string } = {}
): Promise<ResealResult> {
  const env = options.env ?? process.env;
  const ids = configuredKeyIds(env);
  if (!ids.current) {
    throw new Error('TREVRA_SECRETS_KEY is not configured, so there is nothing to re-encrypt with');
  }

  const linkedInHosted = linkedInWorkerConfig(env).hosted;
  const redditHosted = redditWorkerConfig(env).hosted;
  const rows = await loadCustodyRows(db, options.workspaceId);

  const result: ResealResult = { scanned: 0, resealed: 0, skipped: [], failed: [], remaining: 0 };

  for (const row of rows) {
    if (!needsReseal(Number(row.key_version), row.key_id, ids)) continue;
    result.scanned += 1;

    const refusal = custodyRefusal(row, { linkedInHosted, redditHosted });
    if (refusal) {
      result.skipped.push({ store: row.store, id: row.id, reason: refusal });
      result.remaining += 1;
      continue;
    }

    const context = contextFor(row);
    try {
      const sealedRow = await readSealed(db, row);
      if (!sealedRow) continue; // Deleted between the scan and here. Nothing to do.
      const plaintext = openSecret(sealedRow, context, env);
      const sealed = sealSecret(plaintext, context, env);
      await writeSealed(db, row, sealed);
      result.resealed += 1;
    } catch (error) {
      // `openSecret` and `sealSecret` are both written never to put the value
      // or the key in their messages, which is what makes it safe to surface
      // this to an operator running a maintenance pass.
      result.failed.push({
        store: row.store,
        id: row.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      result.remaining += 1;
    }
  }

  return result;
}

/**
 * Why this row may not be opened here, or null when it may be.
 *
 * The refusals are the same ones `secrets/linkedin.ts` and `secrets/reddit.ts`
 * enforce on their own read paths, restated because this module reads those
 * tables directly and a gate that is only enforced somewhere else is not a
 * gate.
 */
function custodyRefusal(
  row: CustodyRowData,
  hosted: { linkedInHosted: boolean; redditHosted: boolean }
): string | null {
  // Password/email custody is gated by per-workspace hosted execution. A proxy
  // credential is different: the hosted runner must be able to use and rotate
  // it, and it is stored in its own sealed table precisely for that purpose.
  const isLinkedInCredential =
    row.store === 'linkedin_seat_credentials' ||
    (row.store === 'workspace_secrets' && row.kind.startsWith('linkedin.'));
  if (isLinkedInCredential && hosted.linkedInHosted) {
    return 'This deployment is hosted, so it will not open a LinkedIn credential -- not even to re-encrypt it.';
  }
  if (row.kind.startsWith('reddit.') && hosted.redditHosted) {
    return 'This deployment is hosted, so it will not open a Reddit credential -- not even to re-encrypt it.';
  }
  return null;
}

function contextFor(row: CustodyRowData): SecretContext {
  if (row.store === 'workspace_secrets') {
    return workspaceSecretContext(row.workspace_id, row.kind as WorkspaceSecretKind);
  }
  if (row.store === 'linkedin_seat_proxy_secrets') {
    return seatProxySecretContext(row.workspace_id, row.seat_key);
  }
  if (row.store === 'capture_source_secrets') {
    return {
      store: 'capture_source_secrets',
      workspaceId: row.workspace_id,
      seatKey: row.seat_key,
      kind: row.kind
    };
  }
  return seatCredentialContext(
    row.workspace_id,
    row.seat_key,
    row.kind as 'linkedin.email' | 'linkedin.password'
  );
}

async function loadCustodyRows(db: Db, workspaceId?: string): Promise<CustodyRowData[]> {
  const scope = workspaceId ?? null;
  const [workspaceRows, seatRows, proxyRows, captureRows] = await Promise.all([
    db.prepare(WORKSPACE_SECRET_ROWS).all<{
      id: string;
      workspace_id: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope),
    db.prepare(SEAT_CREDENTIAL_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope),
    db.prepare(SEAT_PROXY_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope),
    db.prepare(CAPTURE_SOURCE_SECRET_ROWS).all<{
      id: string;
      workspace_id: string;
      seat_key: string;
      kind: string;
      key_version: number;
      key_id: string | null;
    }>(scope, scope)
  ]);
  return [
    // `workspace_secrets` rows are the owner seat by definition -- see
    // `store.ts` `workspaceSecretContext` and migration 049.
    ...workspaceRows.map((row) => ({
      store: 'workspace_secrets' as const,
      ...row,
      seat_key: OWNER_SEAT_COMPONENT
    })),
    ...seatRows.map((row) => ({ store: 'linkedin_seat_credentials' as const, ...row })),
    ...proxyRows.map((row) => ({ store: 'linkedin_seat_proxy_secrets' as const, ...row })),
    ...captureRows.map((row) => ({ store: 'capture_source_secrets' as const, ...row }))
  ];
}

async function readSealed(db: Db, row: CustodyRowData) {
  const stored = await db
    .prepare(
      `SELECT ciphertext, iv, auth_tag, key_version, key_id FROM ${table(row.store)} WHERE id=?`
    )
    .get<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      key_version: number;
      key_id: string | null;
    }>(row.id);
  if (!stored) return null;
  return {
    ciphertext: stored.ciphertext,
    iv: stored.iv,
    authTag: stored.auth_tag,
    keyVersion: Number(stored.key_version),
    keyId: stored.key_id == null ? null : String(stored.key_id)
  };
}

async function writeSealed(
  db: Db,
  row: CustodyRowData,
  sealed: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
    keyId: string | null;
  }
): Promise<void> {
  // `updated_at` is deliberately NOT touched: it means "when did the operator
  // last change this secret", and a maintenance pass did not.
  await db
    .prepare(
      `UPDATE ${table(row.store)} SET ciphertext=?, iv=?, auth_tag=?, key_version=?, key_id=? WHERE id=?`
    )
    .run(sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, sealed.keyId, row.id);
}

/**
 * The table name, from a closed union and never from a caller's string. Table
 * names cannot be parameterised in SQL, so this is the one place a name is
 * interpolated and it is interpolated from a two-member type.
 */
function table(store: SecretStore): string {
  // EXHAUSTIVE, NOT A BINARY CHOICE. This used to be `store === 'workspace_secrets'
  // ? ... : 'linkedin_seat_credentials'`, which quietly answered
  // 'linkedin_seat_credentials' for any store added later -- so a third store
  // reaching here would have re-sealed the wrong table's rows. The rotation
  // sweep does not enumerate `linkedin_seat_sessions` (a session that cannot be
  // opened after a rotation degrades to "needs re-login", which is a cheap and
  // safe outcome; a password does not have that luxury), so this branch is
  // unreachable today and is written to stay correct if that changes.
  // lc-debt: stored browser sessions are not re-sealed on key rotation and are
  // dropped as "needs re-login" instead; upgrade path is to add
  // linkedin_seat_sessions to `collectRows` here and to `table` below.
  if (store === 'workspace_secrets') return 'workspace_secrets';
  if (store === 'linkedin_seat_sessions') return 'linkedin_seat_sessions';
  if (store === 'linkedin_seat_proxy_secrets') return 'linkedin_seat_proxy_secrets';
  if (store === 'capture_source_secrets') return 'capture_source_secrets';
  return 'linkedin_seat_credentials';
}
