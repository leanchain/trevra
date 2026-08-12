/**
 * The operator's own Reddit sign-in: stored write-only, shown never,
 * decrypted at the one moment a browser types it.
 *
 * THE SAME ARRANGEMENT AS `secrets/linkedin.ts`, DELIBERATELY. Reddit publishes
 * an OAuth script-app flow, and `outreach/scouts/reddit.ts` already uses it to
 * SEARCH -- but that flow reads public listings and cannot comment as a human,
 * and its own password grant wants the same account password this module
 * holds. What this module exists for is the other half: a browser signed into
 * the operator's own account, on the operator's own machine, from the
 * operator's own IP, doing what that operator would do by hand.
 *
 * THE RULES, and every one of them is enforced below rather than remembered:
 *
 *  1. HOSTED REFUSES. `TREVRA_DEPLOYMENT_MODE=hosted` cannot store these and
 *     cannot read them, unconditionally and with no override -- the same gate,
 *     from the same one definition, as the worker itself.
 *  2. THE PASSWORD IS WRITE-ONLY. Nothing here returns it, no route returns it,
 *     and `describeRedditCredentials` -- the only read a route may call --
 *     cannot: it returns a boolean and the handle and touches no decryption.
 *  3. THE HANDLE IS THE ONE PLAINTEXT-DERIVED DISPLAY VALUE, and unlike the
 *     LinkedIn email it is NOT masked. `u/pankaj` is printed under every
 *     comment this account posts; masking it would hide which account is about
 *     to speak while protecting nothing that is not already public. The
 *     password has no display form at all.
 *  4. DECRYPT AT THE MOMENT OF USE. `readRedditCredentials` is called
 *     immediately before `page.fill()` and its result is not stored on any
 *     object that outlives the call.
 */
import { redditWorkerConfig } from '../config.js';
import type { Db } from '../db.js';
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
export const REDDIT_CREDENTIALS_HOSTED_REFUSAL =
  'This deployment is hosted, so it will not take custody of a Reddit password.';

/** Raised when TREVRA_SECRETS_KEY is absent, which is a deployment fact, not a fault. */
export const REDDIT_CREDENTIALS_UNSEALED_REFUSAL =
  'This server has no TREVRA_SECRETS_KEY, so it will not store a Reddit password in the clear.';

/** Everything a route, a log line or a screen may know about a stored sign-in. */
export interface RedditCredentialSummary {
  hasCredentials: boolean;
  /** `u/pankaj`, or null when nothing is stored. Public by design; see rule 3. */
  username: string | null;
}

/**
 * `pankaj` or ` /u/Pankaj ` -> `pankaj`.
 *
 * Reddit accepts the handle with or without the prefix at its own login form
 * and treats it case-insensitively, so both are normalised away here -- once,
 * on the write path -- rather than at each of the two places that would
 * otherwise have to compare them.
 */
export function normaliseHandle(username: string): string {
  return username.trim().replace(/^\/?(?:u\/|user\/)/i, '').trim();
}

/** The display form, which is the handle with the prefix Reddit itself shows. */
export function displayHandle(username: string): string {
  const handle = normaliseHandle(username);
  return handle ? `u/${handle}` : '';
}

/** True when this deployment may hold a Reddit password at all. */
function custodyAllowed(env: NodeJS.ProcessEnv): boolean {
  return !redditWorkerConfig(env).hosted;
}

/**
 * Store both halves, sealed, and return only what may be shown.
 *
 * Throws rather than returning a failure shape, because every caller is a route
 * that has to answer with a status code and every refusal here is a deployment
 * fact the operator can act on. NOTHING IT THROWS CONTAINS THE PASSWORD.
 */
export async function putRedditCredentials(
  db: Db,
  input: {
    workspaceId: string;
    username: string;
    password: string;
    actorUserId?: string | null;
    env?: NodeJS.ProcessEnv;
  }
): Promise<RedditCredentialSummary> {
  const env = input.env ?? process.env;
  // THE GATE FIRST, before anything is sealed, written or audited.
  if (!custodyAllowed(env)) throw new Error(REDDIT_CREDENTIALS_HOSTED_REFUSAL);

  const username = typeof input.username === 'string' ? normaliseHandle(input.username) : '';
  const password = typeof input.password === 'string' ? input.password : '';
  // Never quote the offending value back. An error message is the easiest place
  // in a codebase for a secret to end up in a log.
  if (!username) throw new Error('A Reddit username is required');
  if (!password) throw new Error('A Reddit password is required');

  const display = displayHandle(username);

  await putWorkspaceSecret(db, {
    workspaceId: input.workspaceId,
    kind: 'reddit.username',
    plaintext: username,
    // The display form, computed once here, so no read path ever decrypts to
    // render a settings screen.
    label: display,
    actorUserId: input.actorUserId ?? null
  });
  await putWorkspaceSecret(db, {
    workspaceId: input.workspaceId,
    kind: 'reddit.password',
    plaintext: password,
    // No label. There is nothing about a password that may be written down.
    label: null,
    actorUserId: input.actorUserId ?? null
  });

  return { hasCredentials: true, username: display };
}

/**
 * What is stored, without opening it.
 *
 * The only credential read a route may make. Two metadata lookups, no key
 * material touched, so it answers on a deployment whose TREVRA_SECRETS_KEY is
 * missing or has been rotated away -- which is what a status screen has to do.
 */
export async function describeRedditCredentials(db: Db, workspaceId: string): Promise<RedditCredentialSummary> {
  const [username, password] = await Promise.all([
    describeWorkspaceSecret(db, workspaceId, 'reddit.username'),
    describeWorkspaceSecret(db, workspaceId, 'reddit.password')
  ]);
  // BOTH halves, or neither. One without the other cannot sign anything in, and
  // reporting `hasCredentials: true` for it would leave an operator pressing a
  // Sign in button that can never work.
  if (!username || !password) return { hasCredentials: false, username: username?.label ?? null };
  return { hasCredentials: true, username: username.label };
}

/** Wipe both halves. True when anything was there to wipe. */
export async function deleteRedditCredentials(
  db: Db,
  workspaceId: string,
  actorUserId?: string | null
): Promise<boolean> {
  // Sequential, not Promise.all: both writes append an audit row, and the pair
  // reads better in order than interleaved.
  const username = await deleteWorkspaceSecret(db, workspaceId, 'reddit.username', actorUserId ?? null);
  const password = await deleteWorkspaceSecret(db, workspaceId, 'reddit.password', actorUserId ?? null);
  return username || password;
}

/**
 * INTERNAL. The only function that opens a stored Reddit sign-in.
 *
 * Call it immediately before the browser types it, use the result, and let it
 * go. Do not log it, do not return it from a route, do not put it on a
 * long-lived object, and do not add a caller: there is exactly one, in
 * `reddit/local-worker.ts`, and it hands both values straight to
 * `driver.loginWithCredentials`.
 *
 * Returns null -- rather than throwing -- for every reason it cannot produce a
 * pair: hosted, nothing stored, only one half stored. The caller is a worker
 * loop that must not die for any of them.
 */
export async function readRedditCredentials(
  db: Db,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ username: string; password: string } | null> {
  // The same unconditional gate as the write path. A hosted instance that
  // somehow inherited rows from a self-hosted dump still does not open them.
  if (!custodyAllowed(env)) return null;

  const username = await readWorkspaceSecretPlaintext(db, workspaceId, 'reddit.username');
  if (!username) return null;
  const password = await readWorkspaceSecretPlaintext(db, workspaceId, 'reddit.password');
  if (!password) return null;
  return { username, password };
}
