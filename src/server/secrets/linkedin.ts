/**
 * The operator's own LinkedIn sign-in: stored write-only, shown never,
 * decrypted at the one moment a browser types it.
 *
 * WHY THIS EXISTS AT ALL. A headless Chromium can type a password; it cannot
 * show a human a window, so this is how a container with no display
 * (docs/linkedin-outreach-plan.md 4.9) -- or any other machine -- signs a seat
 * in at all. It is the path every competitor already takes -- Dripify takes
 * the email and password and signs in for you -- with the risk posture
 * strictly better than theirs, because this signs in from the operator's own
 * machine and own IP rather than from a datacenter (which is why Dripify
 * sells dedicated proxies).
 *
 * THE RULES, and every one of them is enforced below rather than remembered:
 *
 *  1. HOSTED REFUSES. `TREVRA_DEPLOYMENT_MODE=hosted` cannot store these and
 *     cannot read them, unconditionally and with no override -- the same gate,
 *     from the same one definition, as the worker itself. One operator holding
 *     their own password is a small, informed, self-inflicted risk; a
 *     multi-tenant service holding many humans' LinkedIn passwords is a
 *     different product with a different threat model.
 *  2. THE PASSWORD IS WRITE-ONLY. Nothing here returns it, no route returns it,
 *     and `describeLinkedInCredentials` -- the only read a route may call --
 *     cannot: it returns a boolean and the email's masked form and touches no
 *     decryption at all.
 *  3. NO PLAINTEXT-DERIVED DISPLAY VALUE IS STORED. `store.ts` writes an empty
 *     `last4` for both kinds. The masked email lives in `label`, computed once
 *     on write, so the setup screen never needs a decrypt.
 *  4. DECRYPT AT THE MOMENT OF USE. `readLinkedInCredentials` is called
 *     immediately before the browser types it and its result is not stored on
 *     any object that outlives the call.
 *  5. ONE SIGN-IN PER SEAT, NOT PER WORKSPACE. Every function here takes a
 *     `seatKey` that defaults to `owner`, because a workspace automating two
 *     LinkedIn accounts needs two sign-ins and every seat now signs itself in.
 *     Where the bytes live depends on the seat and on nothing else -- see
 *     TWO HOMES, ONE POSTURE below.
 *
 * TWO HOMES, ONE POSTURE, AND WHICH IS WHICH IS DECIDED HERE AND ONLY HERE.
 *
 *  owner  -> `workspace_secrets`, kinds 'linkedin.email'/'linkedin.password',
 *            through `secrets/store.ts`, byte for byte as before this file grew
 *            a seat dimension. NOTHING WAS MIGRATED: every owner-seat
 *            credential stored before the multi-seat change resolves through
 *            the same rows and the same code path it always did, which is the
 *            cheapest possible backward-compatibility story -- there is no
 *            migration to have gone wrong.
 *  others -> `linkedin_seat_credentials` (migration 049), which exists because
 *            `workspace_secrets` is UNIQUE on (workspace_id, kind) by design
 *            and store.ts upserts on exactly that pair. Migration 049's header
 *            has the full argument; the short version is that widening the
 *            BYOK vault's shape for a LinkedIn-only need would change the
 *            storage contract of every secret in Trevra.
 *
 * The custody posture is IDENTICAL across both: the same AES-256-GCM envelope
 * from `crypto.ts`, the same TREVRA_SECRETS_KEY (and the same
 * TREVRA_SECRETS_KEY_PREVIOUS rotation window), the same unconditional hosted
 * refusal on both the read and the write path, the same write-only rule, and
 * the same "no plaintext-derived display value" rule -- `linkedin_seat_credentials`
 * has no `last4` column at all. Adding a seat dimension does not widen WHERE a
 * password may live by one inch, and the CHECK on that table (`seat_key <>
 * 'owner'`) makes the split impossible to get wrong from the database's side.
 */
import { linkedInWorkerConfig } from '../config.js';
import { id, type Db } from '../db.js';
import { OWNER_SEAT_KEY } from '../linkedin/seats.js';
import { openSecret, sealSecret } from './crypto.js';
import {
  deleteWorkspaceSecret,
  describeWorkspaceSecret,
  putWorkspaceSecret,
  readWorkspaceSecretPlaintext
} from './store.js';

/**
 * The hosted refusal, verbatim, so the route can recognise its own store's
 * answer and turn it into a 409 rather than a 500.
 *
 * One sentence, and it ends the conversation: there is no switch to go and
 * find, so naming one would send the operator looking for it.
 */
export const LINKEDIN_CREDENTIALS_HOSTED_REFUSAL =
  'This deployment is hosted, so it will not take custody of a LinkedIn password.';

/** Raised when TREVRA_SECRETS_KEY is absent, which is a deployment fact, not a fault. */
export const LINKEDIN_CREDENTIALS_UNSEALED_REFUSAL =
  'This server has no TREVRA_SECRETS_KEY, so it will not store a LinkedIn password in the clear.';

/** Everything a route, a log line or a screen may know about a stored sign-in. */
export interface LinkedInCredentialSummary {
  hasCredentials: boolean;
  /** `p...@domain.com`, or null when nothing is stored. Never the address itself. */
  maskedEmail: string | null;
}

/**
 * `pankaj@example.com` -> `p•••@example.com`.
 *
 * The domain survives intact and the local part does not, because the domain is
 * what an operator needs to recognise which of their accounts this is, and the
 * local part is the half that is also half of somebody's login. Computed on
 * write and stored as the secret's `label`, so no read path ever decrypts to
 * render a settings screen.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${trimmed.slice(0, 1)}•••${trimmed.slice(at)}`;
}

/** True when this deployment may hold a LinkedIn password at all. */
function custodyAllowed(env: NodeJS.ProcessEnv): boolean {
  return !linkedInWorkerConfig(env).hosted;
}

/** The two halves, named once so no call site spells a kind by hand. */
type CredentialHalf = 'linkedin.email' | 'linkedin.password';

/**
 * Reject a seat key before it reaches SQL or a path.
 *
 * The same alphabet `seats.ts` `upsertSeat` enforces, repeated rather than
 * imported-and-shared because this module is a security boundary and a
 * validation it delegates is a validation somebody can widen from the other
 * side of the codebase without ever opening this file.
 */
function assertSeatKey(seatKey: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seatKey)) {
    throw new Error('seat_key must be 1-64 letters, numbers, underscores or dashes.');
  }
}

/**
 * Seal one half into `linkedin_seat_credentials`.
 *
 * Non-owner seats only, by the table's own CHECK. The audit row mirrors what
 * `store.ts` writes for a `workspace_secrets` update, and carries the same
 * nothing: an event type, the seat, the kind, and -- for the email half only --
 * the masked form that was already computed for display. No `last4`, because
 * this table has no such column and a password has no nickname.
 */
async function putSeatSecret(
  db: Db,
  input: {
    workspaceId: string;
    seatKey: string;
    kind: CredentialHalf;
    plaintext: string;
    label: string | null;
    actorUserId: string | null;
    env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  // Throws when TREVRA_SECRETS_KEY is absent, which is exactly what the owner
  // path does through `putWorkspaceSecret`: a server with no key stores
  // nothing rather than storing a password in the clear.
  const sealed = sealSecret(input.plaintext, input.env);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO linkedin_seat_credentials (
      id, workspace_id, seat_key, kind, ciphertext, iv, auth_tag, key_version, label, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key, kind) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,
      iv=EXCLUDED.iv,
      auth_tag=EXCLUDED.auth_tag,
      key_version=EXCLUDED.key_version,
      label=EXCLUDED.label,
      updated_at=EXCLUDED.updated_at
  `).run(
    id('lsec'),
    input.workspaceId,
    input.seatKey,
    input.kind,
    sealed.ciphertext,
    sealed.iv,
    sealed.authTag,
    sealed.keyVersion,
    input.label,
    now,
    now
  );
  await writeCredentialAudit(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    eventType: 'workspace_secret.updated',
    seatKey: input.seatKey,
    kind: input.kind,
    label: input.label,
    now
  });
}

/** The stored label for one half, or null when nothing is stored. */
async function describeSeatSecret(
  db: Db,
  workspaceId: string,
  seatKey: string,
  kind: CredentialHalf
): Promise<{ label: string | null } | null> {
  const row = await db
    .prepare('SELECT label FROM linkedin_seat_credentials WHERE workspace_id=? AND seat_key=? AND kind=?')
    .get<{ label: string | null }>(workspaceId, seatKey, kind);
  return row ? { label: row.label } : null;
}

/** INTERNAL. Opens one half. Same rules as `readWorkspaceSecretPlaintext`. */
async function readSeatSecret(
  db: Db,
  workspaceId: string,
  seatKey: string,
  kind: CredentialHalf,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const row = await db
    .prepare('SELECT ciphertext, iv, auth_tag, key_version FROM linkedin_seat_credentials WHERE workspace_id=? AND seat_key=? AND kind=?')
    .get<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }>(workspaceId, seatKey, kind);
  if (!row) return null;
  return openSecret(
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: Number(row.key_version) },
    env
  );
}

/** Wipe one half. True when there was something to wipe. */
async function deleteSeatSecret(
  db: Db,
  workspaceId: string,
  seatKey: string,
  kind: CredentialHalf,
  actorUserId: string | null
): Promise<boolean> {
  const row = await db
    .prepare('DELETE FROM linkedin_seat_credentials WHERE workspace_id=? AND seat_key=? AND kind=? RETURNING label')
    .get<{ label: string | null }>(workspaceId, seatKey, kind);
  if (!row) return false;
  await writeCredentialAudit(db, {
    workspaceId,
    actorUserId,
    eventType: 'workspace_secret.deleted',
    seatKey,
    kind,
    label: row.label,
    now: new Date().toISOString()
  });
  return true;
}

/**
 * The audit row for a seat credential.
 *
 * Written here rather than reached for in `store.ts` because that module's
 * `writeAudit` is private and stays that way: this is a five-line insert, and
 * exporting a general audit writer to save it would be a wider change to a
 * security module than the thing it saves. The METADATA is what matters, and
 * it is the same nothing store.ts writes for an opaque kind -- the kind, the
 * seat, and the masked email that was already a display value.
 */
async function writeCredentialAudit(
  db: Db,
  event: {
    workspaceId: string;
    actorUserId: string | null;
    eventType: string;
    seatKey: string;
    kind: CredentialHalf;
    label: string | null;
    now: string;
  }
): Promise<void> {
  await db.prepare(`
    INSERT INTO audit_events (
      id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    id('audit'),
    event.workspaceId,
    event.actorUserId ? 'user' : 'system',
    event.actorUserId,
    event.eventType,
    'workspace_secret',
    `${event.workspaceId}:${event.seatKey}:${event.kind}`,
    JSON.stringify({ kind: event.kind, seatKey: event.seatKey, label: event.label }),
    event.now
  );
}

/**
 * Store both halves, sealed, and return only what may be shown.
 *
 * Throws rather than returning a failure shape, because every caller is a route
 * that has to answer with a status code and every refusal here is a deployment
 * fact the operator can act on. NOTHING IT THROWS CONTAINS EITHER VALUE.
 */
export async function putLinkedInCredentials(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    password: string;
    actorUserId?: string | null;
    env?: NodeJS.ProcessEnv;
    /** Which LinkedIn account in this workspace. Absent means the owner seat. */
    seatKey?: string;
  }
): Promise<LinkedInCredentialSummary> {
  const env = input.env ?? process.env;
  // THE GATE FIRST, before anything is sealed, written or audited.
  if (!custodyAllowed(env)) throw new Error(LINKEDIN_CREDENTIALS_HOSTED_REFUSAL);

  const seatKey = input.seatKey ?? OWNER_SEAT_KEY;
  assertSeatKey(seatKey);

  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  // Never quote the offending value back. An error message is the easiest place
  // in a codebase for a secret to end up in a log.
  if (!email) throw new Error('A LinkedIn email address is required');
  if (!password) throw new Error('A LinkedIn password is required');

  const maskedEmail = maskEmail(email);

  if (seatKey === OWNER_SEAT_KEY) {
    // UNCHANGED, DELIBERATELY. Same table, same kinds, same store.ts calls as
    // before the seat dimension existed, so nothing already stored has to move
    // and nothing already stored can fail to be found afterwards.
    await putWorkspaceSecret(db, {
      workspaceId: input.workspaceId,
      kind: 'linkedin.email',
      plaintext: email,
      // The masked form, computed once here. This is the ONLY plaintext-derived
      // value either kind stores in the clear, and it is deliberately the half
      // that identifies the account without helping anyone into it.
      label: maskedEmail,
      actorUserId: input.actorUserId ?? null
    });
    await putWorkspaceSecret(db, {
      workspaceId: input.workspaceId,
      kind: 'linkedin.password',
      plaintext: password,
      // No label. There is nothing about a password that may be written down.
      label: null,
      actorUserId: input.actorUserId ?? null
    });
    return { hasCredentials: true, maskedEmail };
  }

  await putSeatSecret(db, {
    workspaceId: input.workspaceId,
    seatKey,
    kind: 'linkedin.email',
    plaintext: email,
    label: maskedEmail,
    actorUserId: input.actorUserId ?? null,
    env
  });
  await putSeatSecret(db, {
    workspaceId: input.workspaceId,
    seatKey,
    kind: 'linkedin.password',
    plaintext: password,
    label: null,
    actorUserId: input.actorUserId ?? null,
    env
  });

  return { hasCredentials: true, maskedEmail };
}

/**
 * What is stored, without opening it.
 *
 * The only credential read a route may make. Two metadata lookups, no key
 * material touched, so it answers on a deployment whose TREVRA_SECRETS_KEY is
 * missing or has been rotated away -- which is what a status screen has to do.
 */
export async function describeLinkedInCredentials(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInCredentialSummary> {
  const [email, password] = await Promise.all(
    seatKey === OWNER_SEAT_KEY
      ? [
          describeWorkspaceSecret(db, workspaceId, 'linkedin.email'),
          describeWorkspaceSecret(db, workspaceId, 'linkedin.password')
        ]
      : [
          describeSeatSecret(db, workspaceId, seatKey, 'linkedin.email'),
          describeSeatSecret(db, workspaceId, seatKey, 'linkedin.password')
        ]
  );
  // BOTH halves, or neither. One without the other cannot sign anything in, and
  // reporting `hasCredentials: true` for it would leave an operator pressing a
  // Sign in button that can never work.
  if (!email || !password) return { hasCredentials: false, maskedEmail: email?.label ?? null };
  return { hasCredentials: true, maskedEmail: email.label };
}

/** Wipe both halves. True when anything was there to wipe. */
export async function deleteLinkedInCredentials(
  db: Db,
  workspaceId: string,
  actorUserId?: string | null,
  seatKey: string = OWNER_SEAT_KEY
): Promise<boolean> {
  // Sequential, not Promise.all: both writes append an audit row, and the pair
  // reads better in order than interleaved.
  if (seatKey === OWNER_SEAT_KEY) {
    const email = await deleteWorkspaceSecret(db, workspaceId, 'linkedin.email', actorUserId ?? null);
    const password = await deleteWorkspaceSecret(db, workspaceId, 'linkedin.password', actorUserId ?? null);
    return email || password;
  }
  const email = await deleteSeatSecret(db, workspaceId, seatKey, 'linkedin.email', actorUserId ?? null);
  const password = await deleteSeatSecret(db, workspaceId, seatKey, 'linkedin.password', actorUserId ?? null);
  return email || password;
}

/**
 * INTERNAL. The only function that opens a stored LinkedIn sign-in.
 *
 * Call it immediately before the browser types it, use the result, and let it
 * go. Do not log it, do not return it from a route, do not put it on a
 * long-lived object, and do not add a caller: there is exactly one, in
 * `linkedin/local-worker.ts`, and it hands both values straight to
 * `driver.loginWithCredentials`.
 *
 * Returns null -- rather than throwing -- for every reason it cannot produce a
 * pair: hosted, nothing stored, only one half stored. The caller is a worker
 * loop that must not die for any of them.
 */
export async function readLinkedInCredentials(
  db: Db,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
  seatKey: string = OWNER_SEAT_KEY
): Promise<{ email: string; password: string } | null> {
  // The same unconditional gate as the write path. A hosted instance that
  // somehow inherited rows from a self-hosted dump still does not open them --
  // for every seat, not just the owner.
  if (!custodyAllowed(env)) return null;

  // `seatKey` comes last so that every existing 2- and 3-argument call site --
  // and the tests that pass a hosted `env` as the third argument -- keeps
  // resolving the owner seat exactly as it did.
  if (seatKey === OWNER_SEAT_KEY) {
    const email = await readWorkspaceSecretPlaintext(db, workspaceId, 'linkedin.email');
    if (!email) return null;
    const password = await readWorkspaceSecretPlaintext(db, workspaceId, 'linkedin.password');
    if (!password) return null;
    return { email, password };
  }

  const email = await readSeatSecret(db, workspaceId, seatKey, 'linkedin.email', env);
  if (!email) return null;
  const password = await readSeatSecret(db, workspaceId, seatKey, 'linkedin.password', env);
  if (!password) return null;
  return { email, password };
}
