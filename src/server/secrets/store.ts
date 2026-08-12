/**
 * Workspace secret store: the only module that reads or writes ciphertext.
 *
 * Access rules (docs/byok-and-hosted-agent.md section 3), enforced here:
 *  1. `readWorkspaceSecretPlaintext` is the ONLY function that returns
 *     plaintext, and it is called at the moment a model request is built --
 *     nowhere else. Everything else deals in `last4` and `label`.
 *  2. No API route returns plaintext. There is no reveal endpoint, for anyone,
 *     at any privilege level.
 *  3. Nothing here logs, throws, or returns the plaintext in an error message,
 *     and no plaintext reaches a skill input, evidence, a domain event, an
 *     audit row, or a payload hash.
 *  4. The value is applied as an HTTP header at the edge of the model call and
 *     never crosses back into application state.
 *
 * The pasted value is trimmed before sealing: operators paste keys with a
 * trailing newline, and that newline would otherwise end up in an
 * Authorization header and fail every request with an unexplainable 401.
 */
import { id, type Db } from '../db.js';
import { validatePublicHost } from '../skills/guard.js';
import { openSecret, sealSecret } from './crypto.js';

/**
 * What may be sealed here.
 *
 * `model_api_key` is the original and the one section 8 of
 * docs/byok-and-hosted-agent.md warned about widening. The two LinkedIn kinds
 * are that widening, taken deliberately and once: they are the operator's own
 * LinkedIn sign-in, stored so a headless Chromium can type it in a container
 * where no human can be shown a window (docs/linkedin-outreach-plan.md 4.1,
 * 4.9). They reuse THIS crypto path and THIS table on purpose -- a second
 * envelope format or a second secrets table would be a second thing to get
 * right, and the first one is already reviewed.
 *
 * The hosted gate that decides whether the LinkedIn kinds may be written at all
 * lives in `secrets/linkedin.ts`, not here: this module seals bytes, it does
 * not hold deployment policy.
 */
export type WorkspaceSecretKind =
  | 'model_api_key'
  | 'linkedin.email'
  | 'linkedin.password'
  | 'reddit.username'
  | 'reddit.password';

/**
 * What may be SHOWN about a stored secret without decrypting it.
 *
 *  'last4'  -- the trailing four characters are stored in the clear, so the UI
 *              can say "which key is this" with no reveal endpoint anywhere.
 *              Right for an API key: four characters of a 51-character token
 *              identify it and guess nothing.
 *  'opaque' -- NOTHING derived from the plaintext is stored in the clear.
 *
 * A PASSWORD IS 'opaque', AND THAT IS THE WHOLE REASON THIS TABLE EXISTS.
 * `last4` of an API key is a nickname; `last4` of a password is four characters
 * of a password, sitting unencrypted in a column, in every backup and every
 * replica -- which is exactly the leak the ciphertext/key split was built to
 * prevent. The email is 'opaque' too and carries its masked form in `label`
 * instead, so the setup screen can show `p...@domain.com` without a decryption
 * ever happening on a read path.
 */
const KIND_DISPLAY: Record<WorkspaceSecretKind, 'last4' | 'opaque'> = {
  model_api_key: 'last4',
  'linkedin.email': 'opaque',
  'linkedin.password': 'opaque',
  // The Reddit pair, added for the same reason and under the same gate as the
  // LinkedIn pair: `secrets/reddit.ts` holds the policy, this module seals the
  // bytes. 'opaque' for BOTH -- the handle is public and rides in `label`
  // unmasked, which is a display value the write path computes, not something
  // `last4` may derive from a password.
  'reddit.username': 'opaque',
  'reddit.password': 'opaque'
};

export interface WorkspaceSecretSummary {
  kind: WorkspaceSecretKind;
  label: string | null;
  last4: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentConfig {
  baseUrl: string;
  model: string;
  label: string | null;
  updatedAt: string;
}

export interface WorkspaceAgentSetup {
  config: WorkspaceAgentConfig | null;
  secret: WorkspaceSecretSummary | null;
}

/** Postgres timestamps come back raw (see db.ts type parsers), so format to ISO in SQL. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const SECRET_COLUMNS = `
  kind, last4, label, key_version,
  TO_CHAR(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
  TO_CHAR(updated_at AT TIME ZONE 'UTC', ${ISO}) AS updated_at
`;
const CONFIG_COLUMNS = `
  base_url, model, label,
  TO_CHAR(updated_at AT TIME ZONE 'UTC', ${ISO}) AS updated_at
`;

/** Loopback only. Anything else must be HTTPS: a key sent over plain HTTP to a remote host is a key given away. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Opt-in escape hatch for self-hosters running a model on their own network.
 *
 * `baseUrl` is workspace-supplied and the server dials it, so on a hosted
 * deployment it is a server-side request forgery primitive: a member could point
 * it at `https://169.254.169.254/` and read cloud instance metadata through the
 * agent's own transcript. Default is therefore DENY, and a self-hoster running
 * Ollama or vLLM on a private address turns it on deliberately.
 */
const PRIVATE_HOSTS_ENV = 'TREVRA_ALLOW_PRIVATE_MODEL_HOSTS';

function privateModelHostsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PRIVATE_HOSTS_ENV] === 'true';
}

export async function putWorkspaceSecret(
  db: Db,
  input: {
    workspaceId: string;
    kind: WorkspaceSecretKind;
    plaintext: string;
    label?: string | null;
    actorUserId?: string | null;
  }
): Promise<WorkspaceSecretSummary> {
  const plaintext = typeof input.plaintext === 'string' ? input.plaintext.trim() : '';
  // Never quote the offending value back: an error message is the easiest
  // place for a secret to leak into a log.
  if (!plaintext) throw new Error('A secret value is required');

  const sealed = sealSecret(plaintext);
  const last4 = deriveLast4(plaintext, input.kind);
  const label = normalizeLabel(input.label);
  const now = new Date().toISOString();

  const row = await db.prepare(`
    INSERT INTO workspace_secrets (
      id,workspace_id,kind,ciphertext,iv,auth_tag,key_version,last4,label,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, kind) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,
      iv=EXCLUDED.iv,
      auth_tag=EXCLUDED.auth_tag,
      key_version=EXCLUDED.key_version,
      last4=EXCLUDED.last4,
      label=EXCLUDED.label,
      updated_at=EXCLUDED.updated_at
    RETURNING id, ${SECRET_COLUMNS}
  `).get<Record<string, unknown>>(
    id('wsec'),
    input.workspaceId,
    input.kind,
    sealed.ciphertext,
    sealed.iv,
    sealed.authTag,
    sealed.keyVersion,
    last4,
    label,
    now,
    now
  );
  if (!row) throw new Error('Failed to store the workspace secret');

  await writeAudit(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId ?? null,
    eventType: 'workspace_secret.updated',
    entityId: String(row.id),
    // last4 and label only, and for an opaque kind not even that: the audit
    // row says a LinkedIn password was replaced, never anything about what it
    // was replaced with.
    metadata: KIND_DISPLAY[input.kind] === 'last4' ? { kind: input.kind, last4, label } : { kind: input.kind, label },
    now
  });

  return serializeSecret(row);
}

export async function describeWorkspaceSecret(
  db: Db,
  workspaceId: string,
  kind: WorkspaceSecretKind
): Promise<WorkspaceSecretSummary | null> {
  const row = await db
    .prepare(`SELECT ${SECRET_COLUMNS} FROM workspace_secrets WHERE workspace_id=? AND kind=?`)
    .get<Record<string, unknown>>(workspaceId, kind);
  return row ? serializeSecret(row) : null;
}

export async function deleteWorkspaceSecret(
  db: Db,
  workspaceId: string,
  kind: WorkspaceSecretKind,
  actorUserId?: string | null
): Promise<boolean> {
  const row = await db
    .prepare('DELETE FROM workspace_secrets WHERE workspace_id=? AND kind=? RETURNING id, last4, label')
    .get<{ id: string; last4: string; label: string | null }>(workspaceId, kind);
  if (!row) return false;

  await writeAudit(db, {
    workspaceId,
    actorUserId: actorUserId ?? null,
    eventType: 'workspace_secret.deleted',
    entityId: row.id,
    metadata: KIND_DISPLAY[kind] === 'last4'
      ? { kind, last4: row.last4, label: row.label ?? null }
      : { kind, label: row.label ?? null },
    now: new Date().toISOString()
  });
  return true;
}

export async function putWorkspaceAgentConfig(
  db: Db,
  input: { workspaceId: string; baseUrl: string; model: string; label?: string | null }
): Promise<WorkspaceAgentConfig> {
  const baseUrl = await assertUsableBaseUrl(input.baseUrl);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) throw new Error('model is required');
  const label = normalizeLabel(input.label);

  const row = await db.prepare(`
    INSERT INTO workspace_agent_config (workspace_id,base_url,model,label,updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT (workspace_id) DO UPDATE SET
      base_url=EXCLUDED.base_url,
      model=EXCLUDED.model,
      label=EXCLUDED.label,
      updated_at=EXCLUDED.updated_at
    RETURNING ${CONFIG_COLUMNS}
  `).get<Record<string, unknown>>(input.workspaceId, baseUrl, model, label, new Date().toISOString());
  if (!row) throw new Error('Failed to store the workspace agent configuration');
  return serializeConfig(row);
}

export async function getWorkspaceAgentConfig(db: Db, workspaceId: string): Promise<WorkspaceAgentConfig | null> {
  const row = await db
    .prepare(`SELECT ${CONFIG_COLUMNS} FROM workspace_agent_config WHERE workspace_id=?`)
    .get<Record<string, unknown>>(workspaceId);
  return row ? serializeConfig(row) : null;
}

/** Everything the UI may know about a workspace's BYOK setup, and nothing more. */
export async function getWorkspaceAgentSetup(db: Db, workspaceId: string): Promise<WorkspaceAgentSetup> {
  const [config, secret] = await Promise.all([
    getWorkspaceAgentConfig(db, workspaceId),
    describeWorkspaceSecret(db, workspaceId, 'model_api_key')
  ]);
  return { config, secret };
}

/**
 * INTERNAL. The only function in Trevra that returns a stored secret in the
 * clear. Call it at the single moment the value is used, pass it straight into
 * the thing that needs it, and let it go. Do not log it, do not return it from
 * a route, do not put it in a variable that outlives the request, and do not
 * add a caller without re-reading section 3 of docs/byok-and-hosted-agent.md.
 *
 * TWO CALL SITES, BOTH NAMED. The agent's model call, which passes the key
 * straight into an Authorization header; and `secrets/linkedin.ts`, which
 * passes the LinkedIn email and password straight into a Playwright `fill()`
 * and holds neither afterwards. A third one is a decision, not a refactor.
 */
export async function readWorkspaceSecretPlaintext(
  db: Db,
  workspaceId: string,
  kind: WorkspaceSecretKind
): Promise<string | null> {
  const row = await db
    .prepare('SELECT ciphertext, iv, auth_tag, key_version FROM workspace_secrets WHERE workspace_id=? AND kind=?')
    .get<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }>(workspaceId, kind);
  if (!row) return null;
  return openSecret({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    keyVersion: Number(row.key_version)
  });
}

/**
 * Display only, and deliberately stingy: fewer than four characters stays
 * fewer, never padded.
 *
 * An 'opaque' kind gets the empty string, so the column is satisfied and
 * nothing derived from the plaintext is written in the clear. `last4` is NOT
 * NULL by schema and stays that way -- this is the one value that means "there
 * is nothing you are allowed to see here".
 */
function deriveLast4(plaintext: string, kind: WorkspaceSecretKind): string {
  return KIND_DISPLAY[kind] === 'last4' ? plaintext.slice(-4) : '';
}

function normalizeLabel(label: string | null | undefined): string | null {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  return trimmed ? trimmed : null;
}

/**
 * HTTPS to a public host. No default is applied: the operator states where
 * their key goes, or nothing is stored.
 *
 * Two layers, deliberately. Here the check is STRUCTURAL only (`resolve:
 * false`) -- it rejects raw IP literals, loopback, single-label and `.local`
 * hosts without a DNS round trip, so saving a setting is fast and a test needs
 * no network. The DNS check that defeats a public name resolving to a private
 * address belongs at call time, where the loop must dial through
 * `createSsrfFetch()` and revalidate every hop.
 */
async function assertUsableBaseUrl(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!raw) throw new Error('baseUrl is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('baseUrl must be an absolute URL, for example https://api.openai.com/v1');
  }

  const allowPrivate = privateModelHostsAllowed(env);

  if (url.protocol === 'http:') {
    if (allowPrivate && LOOPBACK_HOSTS.has(url.hostname)) return raw;
    throw new Error(
      `baseUrl must use HTTPS. Plain HTTP is accepted only for loopback hosts, and only when ${PRIVATE_HOSTS_ENV}=true.`
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error('baseUrl must use HTTPS, for example https://api.openai.com/v1');
  }
  if (allowPrivate) return raw;

  try {
    await validatePublicHost(url.hostname, { resolve: false });
  } catch (cause) {
    throw new Error(
      `baseUrl must point at a public host (${cause instanceof Error ? cause.message : String(cause)}). `
      + `Running a model on your own network? Set ${PRIVATE_HOSTS_ENV}=true.`
    );
  }
  return raw;
}

function serializeSecret(row: Record<string, unknown>): WorkspaceSecretSummary {
  return {
    kind: String(row.kind) as WorkspaceSecretKind,
    label: row.label == null ? null : String(row.label),
    last4: String(row.last4),
    keyVersion: Number(row.key_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function serializeConfig(row: Record<string, unknown>): WorkspaceAgentConfig {
  return {
    baseUrl: String(row.base_url),
    model: String(row.model),
    label: row.label == null ? null : String(row.label),
    updatedAt: String(row.updated_at)
  };
}

async function writeAudit(
  db: Db,
  event: {
    workspaceId: string;
    actorUserId: string | null;
    eventType: string;
    entityId: string;
    metadata: Record<string, unknown>;
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
    event.entityId,
    JSON.stringify(event.metadata),
    event.now
  );
}
