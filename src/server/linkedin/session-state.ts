/**
 * The seat's signed-in state, for the browsers that have no disk to keep it on.
 *
 * WHY THIS EXISTS. `launchPersistentContext` gives a seat a user-data-dir, and
 * that directory IS the LinkedIn session: its cookies, its "remember this
 * browser" device trust, everything that stops the next run being a new-device
 * sign-in. `chromium.connectOverCDP` -- the whole hosted execution path --
 * attaches to a browser somebody else launched. There is no user-data-dir out
 * there and there never will be, so the session has to round-trip through
 * Postgres or the seat signs in from scratch on every single run. A brand-new
 * device sign-in per run is the loudest challenge signal LinkedIn has; it is
 * what `claimSeatLease`'s host pin exists to prevent for local workers, and
 * this is the same protection for remote ones.
 *
 * SEALED AS A PASSWORD, BECAUSE IT IS ONE. A LinkedIn `li_at` cookie
 * authenticates the account outright with no second factor in front of it --
 * it is strictly more dangerous to leak than the password, which at least
 * meets a device check. So: the same AES-256-GCM envelope as
 * `linkedin_seat_credentials`, the same TREVRA_SECRETS_KEY, the same rotation
 * window, and THE SEAT IN THE AAD -- one seat's stored session cannot be
 * opened as another seat's, or another tenant's, any more than a password can.
 * `sessionStateContext` below is the one place that identity is spelled.
 *
 * WRITE-ONLY OVER THE WIRE. Nothing here returns a cookie to any caller but
 * the browser provider. {@link describeSeatSession} is what a route may ask,
 * and it decrypts nothing: it answers when the state was saved and whether it
 * has expired, both of which are columns.
 *
 * DEGRADES TO "NEEDS RE-LOGIN", NEVER TO A SILENT UNAUTHENTICATED RUN. This is
 * the property the whole module is written around. A row that will not decrypt
 * (a rotated-away key, a tampered row, a transplant), a row whose JSON is not a
 * storage state, and a row whose authentication cookie has expired all resolve
 * to the SAME outcome: `{ status: 'needs_login' }` with a reason. They never
 * resolve to `null` meaning "no state, carry on" -- because a browser opened
 * with no state is a browser that will sit on a sign-in page and, on some
 * paths, act as nobody at all while the ledger records that it acted.
 */
import { linkedInWorkerConfig } from '../config.js';
import type { Db } from '../db.js';
import { openSecret, sealSecret, type SecretContext } from '../secrets/crypto.js';
import type { BrowserStorageState } from '../browser/provider.js';

/** The `kind` component of the AAD. One value: this table stores one thing. */
const SESSION_KIND = 'linkedin.storage_state';

/**
 * The cookies that mean "this browser is signed in as this member".
 *
 * `li_at` is the session itself; `JSESSIONID` is the CSRF token every write
 * request must echo. A stored state missing `li_at` is not a session, whatever
 * else it contains.
 */
const AUTH_COOKIE = 'li_at';

/**
 * The identity a `linkedin_seat_sessions` row is sealed against.
 *
 * Spelled once, here, so the write, the read and any future re-seal cannot
 * drift apart about what a row is -- the same discipline
 * `seatCredentialContext` follows in `secrets/linkedin.ts`.
 */
export function sessionStateContext(workspaceId: string, seatKey: string): SecretContext {
  return { store: 'linkedin_seat_sessions', workspaceId, seatKey, kind: SESSION_KIND };
}

/** What a caller may learn about a stored session without decrypting it. */
export interface SeatSessionSummary {
  hasSession: boolean;
  savedAt: string | null;
  /** When the browser said the authentication cookie stops working. Null when undated. */
  expiresAt: string | null;
  expired: boolean;
}

export type SeatSessionRead =
  | { status: 'ok'; state: BrowserStorageState; savedAt: string }
  /** No row at all. A first run, or a session that was cleared. */
  | { status: 'absent' }
  /** A row exists and cannot be used. The reason is operator-facing and names no secret. */
  | { status: 'needs_login'; reason: string };

interface SessionRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  key_id: string | null;
  expires_at: string | null;
  saved_at: string;
}

/**
 * The earliest expiry among the cookies that carry the authentication.
 *
 * WHY THE EARLIEST AND NOT THE LATEST: the session dies when its first
 * essential cookie does. Taking the latest would report a session as live for
 * days after it stopped working, which is precisely the silent-unauthenticated
 * run this module exists to prevent.
 *
 * Playwright writes `expires` as seconds since the epoch, and `-1` for a
 * session cookie (one that dies with the browser). A `-1` is not a date and is
 * skipped: a state made entirely of session cookies has no expiry to record,
 * which is a real and reportable answer.
 */
export function authCookieExpiry(state: BrowserStorageState): Date | null {
  let earliest: number | null = null;
  for (const cookie of state.cookies ?? []) {
    const name = typeof cookie.name === 'string' ? cookie.name : '';
    if (name !== AUTH_COOKIE) continue;
    const expires = typeof cookie.expires === 'number' ? cookie.expires : -1;
    if (!Number.isFinite(expires) || expires <= 0) continue;
    earliest = earliest === null ? expires : Math.min(earliest, expires);
  }
  return earliest === null ? null : new Date(earliest * 1000);
}

/**
 * Is this actually a signed-in LinkedIn session, or merely a well-formed JSON
 * object?
 *
 * A state with no `li_at` is a browser that visited LinkedIn and never signed
 * in. Restoring it and proceeding would produce exactly the run this module
 * refuses to allow: a browser that looks prepared, lands on a sign-in wall, and
 * reports whatever a driver makes of that.
 */
export function storageStateIsSignedIn(state: BrowserStorageState): boolean {
  return (state.cookies ?? []).some((cookie) => cookie.name === AUTH_COOKIE && typeof cookie.value === 'string' && cookie.value.length > 0);
}

/** True when this deployment may hold a stored browser session at all. */
function custodyRefusal(env: NodeJS.ProcessEnv): string | null {
  // The SAME gate the password takes, from the same one definition. A
  // deployment that may not hold the credential may not hold the cookie the
  // credential produced -- that would be the whole restriction, defeated by
  // storing the output instead of the input.
  return linkedInWorkerConfig(env).enabled
    ? null
    : 'This deployment does not run LinkedIn automation, so it will not store a browser session for a seat.';
}

/**
 * Save the seat's signed-in state, replacing whatever was there.
 *
 * CALLED AFTER EVERY SUCCESSFUL RUN, not only after a sign-in. LinkedIn rotates
 * its own cookies as a session is used, so a state saved once and never
 * refreshed goes stale while the account is still perfectly usable -- and the
 * refresh is what makes the stored session survive restarts indefinitely
 * instead of for one cookie lifetime.
 *
 * REFUSES TO STORE A STATE THAT IS NOT A SESSION. An unauthenticated state
 * would overwrite a good one with a useless one, turning a browser that merely
 * failed a navigation into a seat that needs a human. Returns false and writes
 * nothing.
 */
export async function saveSeatStorageState(
  db: Db,
  input: {
    workspaceId: string;
    seatKey: string;
    state: BrowserStorageState;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  }
): Promise<boolean> {
  const env = input.env ?? process.env;
  if (custodyRefusal(env)) return false;
  if (!storageStateIsSignedIn(input.state)) return false;

  // Throws when TREVRA_SECRETS_KEY is absent, exactly as the credential path
  // does: a server with no key stores nothing rather than storing a session
  // cookie in the clear.
  const sealed = sealSecret(
    JSON.stringify({ cookies: input.state.cookies ?? [], origins: input.state.origins ?? [] }),
    sessionStateContext(input.workspaceId, input.seatKey),
    env
  );
  const now = (input.now ?? new Date()).toISOString();
  const expiry = authCookieExpiry(input.state);
  await db.prepare(`
    INSERT INTO linkedin_seat_sessions (
      workspace_id, seat_key, ciphertext, iv, auth_tag, key_version, key_id, expires_at, saved_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,
      iv=EXCLUDED.iv,
      auth_tag=EXCLUDED.auth_tag,
      key_version=EXCLUDED.key_version,
      key_id=EXCLUDED.key_id,
      expires_at=EXCLUDED.expires_at,
      saved_at=EXCLUDED.saved_at,
      updated_at=EXCLUDED.updated_at
  `).run(
    input.workspaceId,
    input.seatKey,
    sealed.ciphertext,
    sealed.iv,
    sealed.authTag,
    sealed.keyVersion,
    sealed.keyId,
    expiry ? expiry.toISOString() : null,
    now,
    now,
    now
  );
  return true;
}

/**
 * The seat's stored state, or the reason it cannot be used.
 *
 * FOUR WAYS TO FAIL AND ONE WAY TO SUCCEED, and every failure is
 * `needs_login` rather than `absent`, because the caller's next decision
 * differs: `absent` means "open a browser and sign in with the stored
 * credential", `needs_login` means the same thing PLUS a line in the log saying
 * why a session that existed stopped working. Neither ever means "proceed
 * without a session".
 */
export async function readSeatStorageState(
  db: Db,
  workspaceId: string,
  seatKey: string,
  options: { env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<SeatSessionRead> {
  const env = options.env ?? process.env;
  const refusal = custodyRefusal(env);
  if (refusal) return { status: 'needs_login', reason: refusal };

  const row = await db.prepare(`
    SELECT ciphertext, iv, auth_tag, key_version, key_id,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
           to_char(saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS saved_at
    FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?
  `).get<SessionRow>(workspaceId, seatKey);
  if (!row) return { status: 'absent' };

  const now = options.now ?? new Date();
  // THE COLUMN IS CHECKED BEFORE THE DECRYPT. An expired session is not worth
  // opening, and asking the cheap question first means an expired seat costs a
  // column read rather than a key derivation.
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return { status: 'needs_login', reason: `its stored browser session expired at ${row.expires_at}` };
  }

  let plaintext: string;
  try {
    plaintext = openSecret(
      {
        ciphertext: toBuffer(row.ciphertext),
        iv: toBuffer(row.iv),
        authTag: toBuffer(row.auth_tag),
        keyVersion: row.key_version,
        keyId: row.key_id
      },
      sessionStateContext(workspaceId, seatKey),
      env
    );
  } catch (cause) {
    // The underlying message is deliberately NOT passed through: `openSecret`'s
    // failure text names key fingerprints and the row identity, which belongs
    // in a server log rather than in whatever renders this reason. What a
    // caller needs is the ACTION, and it is the same for every cause.
    return {
      status: 'needs_login',
      reason: `its stored browser session could not be opened (${cause instanceof Error && /does not hold/.test(cause.message) ? 'sealed with a server key this deployment no longer holds' : 'it failed authentication'}), so this seat must sign in again`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { status: 'needs_login', reason: 'its stored browser session is not readable, so this seat must sign in again' };
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as BrowserStorageState).cookies)) {
    return { status: 'needs_login', reason: 'its stored browser session has no cookies in it, so this seat must sign in again' };
  }
  const state: BrowserStorageState = {
    cookies: (parsed as BrowserStorageState).cookies,
    origins: Array.isArray((parsed as BrowserStorageState).origins) ? (parsed as BrowserStorageState).origins : []
  };
  if (!storageStateIsSignedIn(state)) {
    return { status: 'needs_login', reason: 'its stored browser session carries no LinkedIn sign-in cookie, so this seat must sign in again' };
  }
  return { status: 'ok', state, savedAt: row.saved_at };
}

/** What a status route may know: two dates and two booleans, and no decryption. */
export async function describeSeatSession(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date = new Date()
): Promise<SeatSessionSummary> {
  const row = await db.prepare(`
    SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
           to_char(saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS saved_at
    FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?
  `).get<{ expires_at: string | null; saved_at: string }>(workspaceId, seatKey);
  if (!row) return { hasSession: false, savedAt: null, expiresAt: null, expired: false };
  return {
    hasSession: true,
    savedAt: row.saved_at,
    expiresAt: row.expires_at,
    expired: Boolean(row.expires_at && new Date(row.expires_at).getTime() <= now.getTime())
  };
}

/**
 * Forget the seat's session.
 *
 * Called when a sign-in fails, when a checkpoint is detected, and when the seat
 * is disconnected -- three moments where keeping the bytes buys nothing and
 * risks a future run restoring a state LinkedIn has already invalidated.
 */
export async function clearSeatStorageState(db: Db, workspaceId: string, seatKey: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM linkedin_seat_sessions WHERE workspace_id=? AND seat_key=?').run(workspaceId, seatKey);
  return result.changes > 0;
}

/**
 * `bytea` comes back as a Buffer from `pg`, but a driver or a test double may
 * hand back a Uint8Array or a hex string. Normalised here rather than trusted,
 * because the failure mode of getting it wrong is an authentication error that
 * looks exactly like a tampered row.
 */
function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/, ''), 'hex');
  return Buffer.alloc(0);
}
