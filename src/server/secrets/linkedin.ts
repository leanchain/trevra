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
 *     immediately before `page.fill()` and its result is not stored on any
 *     object that outlives the call.
 */
import { linkedInWorkerConfig } from '../config.js';
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
  }
): Promise<LinkedInCredentialSummary> {
  const env = input.env ?? process.env;
  // THE GATE FIRST, before anything is sealed, written or audited.
  if (!custodyAllowed(env)) throw new Error(LINKEDIN_CREDENTIALS_HOSTED_REFUSAL);

  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  // Never quote the offending value back. An error message is the easiest place
  // in a codebase for a secret to end up in a log.
  if (!email) throw new Error('A LinkedIn email address is required');
  if (!password) throw new Error('A LinkedIn password is required');

  const maskedEmail = maskEmail(email);

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

/**
 * What is stored, without opening it.
 *
 * The only credential read a route may make. Two metadata lookups, no key
 * material touched, so it answers on a deployment whose TREVRA_SECRETS_KEY is
 * missing or has been rotated away -- which is what a status screen has to do.
 */
export async function describeLinkedInCredentials(db: Db, workspaceId: string): Promise<LinkedInCredentialSummary> {
  const [email, password] = await Promise.all([
    describeWorkspaceSecret(db, workspaceId, 'linkedin.email'),
    describeWorkspaceSecret(db, workspaceId, 'linkedin.password')
  ]);
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
  actorUserId?: string | null
): Promise<boolean> {
  // Sequential, not Promise.all: both writes append an audit row, and the pair
  // reads better in order than interleaved.
  const email = await deleteWorkspaceSecret(db, workspaceId, 'linkedin.email', actorUserId ?? null);
  const password = await deleteWorkspaceSecret(db, workspaceId, 'linkedin.password', actorUserId ?? null);
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
  env: NodeJS.ProcessEnv = process.env
): Promise<{ email: string; password: string } | null> {
  // The same unconditional gate as the write path. A hosted instance that
  // somehow inherited rows from a self-hosted dump still does not open them.
  if (!custodyAllowed(env)) return null;

  const email = await readWorkspaceSecretPlaintext(db, workspaceId, 'linkedin.email');
  if (!email) return null;
  const password = await readWorkspaceSecretPlaintext(db, workspaceId, 'linkedin.password');
  if (!password) return null;
  return { email, password };
}
