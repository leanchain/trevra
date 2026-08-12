/**
 * The Reddit account row: which handle this workspace speaks as, and when its
 * browser session was last seen to be live.
 *
 * ONE ACCOUNT PER WORKSPACE, keyed by workspace_id alone -- the same shape
 * `linkedin/seats.ts` settled on, for the same reason: Reddit rate-limits an
 * ACCOUNT, not an application, so "three comments in the last hour" is a fact
 * about one human's handle.
 *
 * NO CREDENTIAL LIVES HERE AND NONE MAY BE ADDED. Both halves of the sign-in
 * are sealed in `workspace_secrets` through `secrets/reddit.ts`. `username`
 * below is the PUBLIC handle -- the one printed under every comment the account
 * posts -- kept in the clear so a screen can say which account is about to
 * speak without decrypting anything.
 *
 * NOTHING HERE PACES ANYTHING. There is no ramp, no posture and no ceiling in
 * this module: the chosen scope is sign-in plus a read and a reply the operator
 * initiates one at a time. When a queue arrives it will need its own table, and
 * this row is what it will hang off.
 */
import type { Db } from '../db.js';

/**
 * How this account gets into Reddit.
 *
 * 'manual'      -- a human signed this browser profile in by hand; Trevra holds
 *                  no credential at all. The default, and the zero-custody path.
 * 'credentials' -- Trevra holds the operator's own username and password and
 *                  signs in when the stored session has expired.
 */
export type RedditAuthMode = 'manual' | 'credentials';

export interface RedditAccount {
  workspaceId: string;
  /** Without the `u/`, exactly as the session reported it. Null until a session was read. */
  username: string | null;
  authMode: RedditAuthMode;
  /**
   * ISO-8601, or null for UNKNOWN -- which is not the same as expired. An
   * account nobody has checked is not an account we know is signed out.
   */
  sessionValidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Postgres timestamps come back raw (see db.ts type parsers), so format to ISO in SQL. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ACCOUNT_COLUMNS = `
  workspace_id, username, auth_mode,
  TO_CHAR(session_valid_at AT TIME ZONE 'UTC', ${ISO}) AS session_valid_at,
  TO_CHAR(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
  TO_CHAR(updated_at AT TIME ZONE 'UTC', ${ISO}) AS updated_at
`;

interface AccountRow {
  workspace_id: string;
  username: string | null;
  auth_mode: string;
  session_valid_at: string | null;
  created_at: string;
  updated_at: string;
}

function toAccount(row: AccountRow): RedditAccount {
  return {
    workspaceId: row.workspace_id,
    username: row.username,
    // Anything the schema check would have refused reads as 'manual', which is
    // the side that holds no credential. Fail closed, as everywhere else here.
    authMode: row.auth_mode === 'credentials' ? 'credentials' : 'manual',
    sessionValidAt: row.session_valid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getRedditAccount(db: Db, workspaceId: string): Promise<RedditAccount | null> {
  const row = await db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM reddit_accounts WHERE workspace_id=?`)
    .get<AccountRow>(workspaceId);
  return row ? toAccount(row) : null;
}

/**
 * Create or update the row, touching only what the caller named.
 *
 * `undefined` means "leave it alone" and `null` means "clear it", which is the
 * distinction every partial update in this codebase makes -- a detect that
 * could not read the handle must not blank the one already stored.
 */
export async function upsertRedditAccount(
  db: Db,
  workspaceId: string,
  patch: { username?: string | null; authMode?: RedditAuthMode },
  now: Date
): Promise<RedditAccount> {
  const existing = await getRedditAccount(db, workspaceId);
  const username = patch.username === undefined ? (existing?.username ?? null) : patch.username;
  const authMode = patch.authMode ?? existing?.authMode ?? 'manual';
  const timestamp = now.toISOString();

  const row = await db.prepare(`
    INSERT INTO reddit_accounts (workspace_id, username, auth_mode, session_valid_at, created_at, updated_at)
    VALUES (?,?,?,?::timestamptz,?::timestamptz,?::timestamptz)
    ON CONFLICT (workspace_id) DO UPDATE SET
      username = excluded.username,
      auth_mode = excluded.auth_mode,
      updated_at = excluded.updated_at
    RETURNING ${ACCOUNT_COLUMNS}
  `).get<AccountRow>(workspaceId, username, authMode, existing?.sessionValidAt ?? null, timestamp, timestamp);

  return toAccount(row as AccountRow);
}

/**
 * Record that this account's stored browser session was seen to be LIVE.
 *
 * Written only where that was actually observed -- a signed-in page loaded, or
 * a sign-in that just succeeded -- and never on an attempt. The column's whole
 * job is to let the next run REUSE a session instead of re-authenticating, and
 * a timestamp written on hope would defeat it.
 *
 * Inserts when the row is absent, because the first thing that ever happens to
 * a workspace's Reddit account is a successful sign-in, and requiring a form to
 * be saved first would be a step that exists only to satisfy a foreign key.
 */
export async function stampRedditSessionValid(
  db: Db,
  workspaceId: string,
  now: Date,
  patch: { username?: string | null; authMode?: RedditAuthMode } = {}
): Promise<RedditAccount> {
  const existing = await getRedditAccount(db, workspaceId);
  const username = patch.username === undefined ? (existing?.username ?? null) : patch.username;
  const authMode = patch.authMode ?? existing?.authMode ?? 'manual';
  const timestamp = now.toISOString();

  const row = await db.prepare(`
    INSERT INTO reddit_accounts (workspace_id, username, auth_mode, session_valid_at, created_at, updated_at)
    VALUES (?,?,?,?::timestamptz,?::timestamptz,?::timestamptz)
    ON CONFLICT (workspace_id) DO UPDATE SET
      username = COALESCE(excluded.username, reddit_accounts.username),
      auth_mode = excluded.auth_mode,
      session_valid_at = excluded.session_valid_at,
      updated_at = excluded.updated_at
    RETURNING ${ACCOUNT_COLUMNS}
  `).get<AccountRow>(workspaceId, username, authMode, timestamp, timestamp, timestamp);

  return toAccount(row as AccountRow);
}

/**
 * Forget the row.
 *
 * Does NOT touch the stored credentials -- `deleteRedditCredentials` is that,
 * and it is a separate button for a reason -- and does not sign the browser
 * profile out, because deleting a row cannot: the cookies are in the profile
 * directory on disk.
 */
/**
 * Every workspace this machine might have Reddit work for.
 *
 * The UNION is deliberate and both halves earn their place: a workspace that
 * saved credentials but has never signed in has no `reddit_accounts` row yet
 * and must still be picked up on the very first run, and a workspace that was
 * signed in by hand (`auth_mode='manual'`) has a row and no secret. Reading
 * only one side would strand one of those two operators.
 *
 * METADATA ONLY. `workspace_secrets` is joined on its `kind` column; nothing
 * here decrypts anything, and nothing here may start to.
 */
export async function redditWorkspaceIds(db: Db): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT workspace_id FROM reddit_accounts
    UNION
    SELECT workspace_id FROM workspace_secrets WHERE kind='reddit.username'
    ORDER BY workspace_id
  `).all<{ workspace_id: string }>();
  return rows.map((row) => row.workspace_id);
}

export async function deleteRedditAccount(db: Db, workspaceId: string): Promise<boolean> {
  const row = await db
    .prepare('DELETE FROM reddit_accounts WHERE workspace_id=? RETURNING workspace_id')
    .get<{ workspace_id: string }>(workspaceId);
  return Boolean(row);
}
