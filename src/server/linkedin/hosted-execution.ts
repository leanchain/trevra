/**
 * When Trevra's own servers may act on somebody's LinkedIn account, and the
 * three things that must all be true before they do.
 *
 * THE DECISION THIS FILE IMPLEMENTS. Every other path in this subsystem drives
 * a browser on the OPERATOR'S machine, from the operator's IP, out of a Chrome
 * profile they signed into by hand -- which is why hosted deployments refused
 * to hold a LinkedIn password at all, and why a hosted queue filled up and
 * never drained. Hosted execution changes that: a cloud browser, attached to
 * over CDP, signed in with a stored credential, acting as the member. The
 * decision to build it has been made; what this file does is make sure it can
 * only happen deliberately.
 *
 * THREE CONDITIONS, AND ALL THREE ARE CHECKED HERE:
 *
 *   1. THE DEPLOYMENT IS HOSTED. On a self-hosted install none of this applies
 *      -- the local worker already runs and always did, and nothing about it
 *      changes.
 *   2. A REMOTE BROWSER PROVIDER IS CONFIGURED. Without one there is no browser
 *      to drive: a hosted container has no display, no Chromium and no profile.
 *      A hosted deployment with no provider must go on refusing exactly as it
 *      did, with the same sentence, because nothing about its situation has
 *      changed.
 *   3. THE WORKSPACE ACKNOWLEDGED IT, IN WRITING, AND HAS NOT WITHDRAWN.
 *      Per workspace, not per deployment: the person who has to agree is the
 *      person whose account it is, not whoever set the environment variables.
 *      Recorded in `linkedin_hosted_execution_ack` (migration 065) with who,
 *      when and which wording.
 *
 * WHAT THIS FILE DOES NOT TOUCH. Every pre-existing safety gate still applies,
 * unchanged and in the same order: daily and weekly ceilings, the warm-up ramp,
 * working hours and the weekend rule, the 30-120s pacing gaps, the per-seat
 * cooldown after a failure, sitting budgets and breaks, checkpoint detection,
 * duplicate-target suppression. Hosted execution decides WHERE the browser is,
 * and nothing else. A seat that would be refused on a laptop is refused here.
 */
import type { Db } from '../db.js';
import { browserProviderSettings } from '../browser/provider.js';
import { linkedInWorkerConfig } from '../config.js';

/**
 * The refusal a hosted deployment gives when it may not take custody, verbatim
 * and unchanged from the day it was written.
 *
 * ONE SENTENCE, AND IT ENDS THE CONVERSATION: there is no switch for the
 * operator to go and find, so naming one would send them looking. It is
 * exported under its old name from `secrets/linkedin.ts`, where every existing
 * caller already imports it -- moved here rather than duplicated because a
 * security-boundary string with two definitions is a string that drifts.
 */
export const HOSTED_EXECUTION_REFUSAL =
  'This deployment is hosted, so it will not take custody of a LinkedIn password.';

/**
 * The refusal when the deployment CAN run hosted execution and this workspace
 * has not said yes.
 *
 * Deliberately different from {@link HOSTED_EXECUTION_REFUSAL}: that sentence
 * is final and this one names the exact next action, because here there really
 * is one.
 */
export const HOSTED_EXECUTION_ACK_REQUIRED =
  'This workspace has not authorised Trevra to act on its LinkedIn account from Trevra\'s own servers. '
  + 'A workspace owner must record that authorisation (POST /api/linkedin/hosted-execution) before a credential can be stored or a seat can be run here.';

/**
 * The wording an owner agrees to, and the number that identifies it.
 *
 * THE VERSION IS PART OF THE RECORD. A consent record that cannot say WHAT was
 * consented to is not one, so the statement lives next to the number and
 * changing the text means changing the number -- which makes every existing
 * acknowledgement stale and asks every workspace again. That is the intended
 * cost of changing what people agreed to.
 */
export const HOSTED_EXECUTION_STATEMENT_VERSION = 1;

export const HOSTED_EXECUTION_STATEMENT = [
  'I authorise Trevra to sign into this workspace\'s LinkedIn account from Trevra\'s own servers, using a browser Trevra operates, and to send invitations, messages and replies as that member.',
  'I understand that Trevra will store this account\'s sign-in and its browser session, encrypted, and that LinkedIn\'s terms place responsibility for automated activity on the account holder.',
  'I understand that every existing safety limit still applies -- daily and weekly ceilings, the warm-up ramp, working hours, pacing and cooldowns -- and that automation carries a risk of the account being restricted.',
  'I can withdraw this authorisation at any time, which stops hosted execution for this workspace.'
].join(' ');

/** Where this deployment's browsers are, and whether hosted execution is even possible. */
export interface HostedExecutionMode {
  /** True when TREVRA_DEPLOYMENT_MODE=hosted. */
  hosted: boolean;
  /** True when a remote browser provider is configured and valid. */
  remoteBrowser: boolean;
  /** The provider's operator-facing name, or null. Never a URL with a key in it. */
  provider: string | null;
  /** Set when remote was asked for and does not hold together. */
  problem: string | null;
  /**
   * True when this deployment could run a seat server-side for a workspace
   * that has acknowledged it. Says nothing about any particular workspace.
   */
  available: boolean;
}

export function hostedExecutionMode(env: NodeJS.ProcessEnv = process.env): HostedExecutionMode {
  const settings = browserProviderSettings(env);
  const hosted = linkedInWorkerConfig(env).hosted;
  return {
    hosted,
    remoteBrowser: settings.kind === 'remote',
    provider: settings.remote?.label ?? null,
    problem: settings.problem,
    available: hosted && settings.kind === 'remote'
  };
}

export interface HostedExecutionAck {
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  statementVersion: number | null;
  revokedAt: string | null;
  /** True when the recorded version is behind {@link HOSTED_EXECUTION_STATEMENT_VERSION}. */
  stale: boolean;
}

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** What this workspace has recorded. Reads only; never decides anything on its own. */
export async function describeHostedExecutionAck(db: Db, workspaceId: string): Promise<HostedExecutionAck> {
  const row = await db.prepare(`
    SELECT acknowledged_by, statement_version,
           to_char(acknowledged_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS acknowledged_at,
           to_char(revoked_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS revoked_at
    FROM linkedin_hosted_execution_ack WHERE workspace_id=?
  `).get<{ acknowledged_by: string | null; statement_version: number; acknowledged_at: string; revoked_at: string | null }>(workspaceId);
  if (!row) {
    return { acknowledged: false, acknowledgedAt: null, acknowledgedBy: null, statementVersion: null, revokedAt: null, stale: false };
  }
  const stale = row.statement_version < HOSTED_EXECUTION_STATEMENT_VERSION;
  return {
    acknowledged: row.revoked_at === null && !stale,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    statementVersion: row.statement_version,
    revokedAt: row.revoked_at,
    stale
  };
}

/**
 * Record the authorisation.
 *
 * RE-ACKNOWLEDGING IS AN UPDATE, NOT A SECOND ROW: one workspace holds one
 * live position, and the row carries when it was last taken. A workspace that
 * had withdrawn and comes back clears `revoked_at` -- withdrawing is not
 * permanent, it is just not silent.
 */
export async function recordHostedExecutionAck(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; now?: Date }
): Promise<HostedExecutionAck> {
  const now = (input.now ?? new Date()).toISOString();
  await db.prepare(`
    INSERT INTO linkedin_hosted_execution_ack (
      workspace_id, acknowledged_by, acknowledged_at, statement_version, revoked_at, revoked_by, created_at, updated_at
    ) VALUES (?,?,?,?,NULL,NULL,?,?)
    ON CONFLICT (workspace_id) DO UPDATE SET
      acknowledged_by=EXCLUDED.acknowledged_by,
      acknowledged_at=EXCLUDED.acknowledged_at,
      statement_version=EXCLUDED.statement_version,
      revoked_at=NULL,
      revoked_by=NULL,
      updated_at=EXCLUDED.updated_at
  `).run(input.workspaceId, input.actorUserId, now, HOSTED_EXECUTION_STATEMENT_VERSION, now, now);
  return describeHostedExecutionAck(db, input.workspaceId);
}

/**
 * Withdraw it.
 *
 * THE ROW IS NOT DELETED. "Never agreed" and "agreed and changed their mind"
 * are different facts about a workspace, and only the first one is silence.
 * Takes effect on the next tick: a seat already mid-batch finishes, exactly as
 * a disconnect does, because rewriting a row does not close a browser tab.
 */
export async function revokeHostedExecutionAck(
  db: Db,
  input: { workspaceId: string; actorUserId: string | null; now?: Date }
): Promise<HostedExecutionAck> {
  const now = (input.now ?? new Date()).toISOString();
  await db.prepare(`
    UPDATE linkedin_hosted_execution_ack
    SET revoked_at=?, revoked_by=?, updated_at=?
    WHERE workspace_id=? AND revoked_at IS NULL
  `).run(now, input.actorUserId, now, input.workspaceId);
  return describeHostedExecutionAck(db, input.workspaceId);
}

export type HostedExecutionVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this deployment act on THIS workspace's LinkedIn account server-side?
 *
 * THE ONE FUNCTION EVERY CALLER ASKS, and the order of the questions is the
 * point:
 *
 *   not hosted            -> allowed. Nothing here applies to a self-hoster,
 *                            and answering anything else would break every
 *                            existing install on upgrade.
 *   hosted, no provider   -> the OLD refusal, verbatim. Nothing about this
 *                            deployment's situation has changed, so nothing
 *                            about its answer does either.
 *   hosted, provider, no  -> a refusal that names the next action, because
 *   acknowledgement          here there is one.
 *   hosted, provider, ack -> allowed. Every other gate still applies.
 */
export async function hostedExecutionGate(
  db: Db,
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<HostedExecutionVerdict> {
  const mode = hostedExecutionMode(env);
  if (!mode.hosted) return { allowed: true };
  if (!mode.remoteBrowser) {
    // A remote provider that was ASKED FOR and is broken gets its own sentence:
    // an operator who set the variables deserves to know which one is wrong
    // rather than the final-sounding refusal meant for a deployment that never
    // configured one at all.
    return { allowed: false, reason: mode.problem ?? HOSTED_EXECUTION_REFUSAL };
  }
  const ack = await describeHostedExecutionAck(db, workspaceId);
  if (!ack.acknowledged) {
    return {
      allowed: false,
      reason: ack.stale
        ? 'This workspace\'s authorisation for hosted LinkedIn execution predates the current terms and must be given again (POST /api/linkedin/hosted-execution).'
        : HOSTED_EXECUTION_ACK_REQUIRED
    };
  }
  return { allowed: true };
}

/**
 * The workspaces a hosted runner may serve, a page at a time.
 *
 * BOUNDED AND CURSORED like every other discovery read in this subsystem: an
 * unbounded list is a tick that never finishes at a thousand tenants, and a
 * bounded one with no cursor is an alphabetical head that gets served every
 * minute in front of a tail that is never reached.
 */
export async function hostedExecutionWorkspaceIds(
  db: Db,
  options: { limit?: number; after?: string | null } = {}
): Promise<string[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const after = options.after ?? null;
  const rows = await db.prepare(`
    SELECT workspace_id FROM linkedin_hosted_execution_ack
    WHERE revoked_at IS NULL AND statement_version >= ?
      AND (?::text IS NULL OR workspace_id > ?::text)
    ORDER BY workspace_id ASC
    LIMIT ${limit}
  `).all<{ workspace_id: string }>(HOSTED_EXECUTION_STATEMENT_VERSION, after, after);
  return rows.map((row) => row.workspace_id);
}

/**
 * A seat filter for the worker loop, or null when no filtering is needed.
 *
 * NULL ON A SELF-HOSTED DEPLOYMENT, and that is what keeps the local worker
 * exactly as fast and exactly as unconditional as it was: no extra query per
 * seat, no new failure mode, no behaviour change at all. The filter exists only
 * where it has something to enforce.
 *
 * MEMOISED FOR ONE PASS. The runner asks this for every seat it discovers and
 * a workspace usually owns several, so the answer is cached per call-site
 * lifetime rather than re-queried per seat. Short-lived on purpose: a
 * withdrawal must take effect on the next tick, not whenever a process
 * restarts.
 */
export function hostedSeatFilter(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): ((seat: { workspaceId: string }) => Promise<boolean>) | null {
  const mode = hostedExecutionMode(env);
  if (!mode.hosted) return null;
  const decided = new Map<string, boolean>();
  return async (seat) => {
    const cached = decided.get(seat.workspaceId);
    if (cached !== undefined) return cached;
    const verdict = await hostedExecutionGate(db, seat.workspaceId, env);
    decided.set(seat.workspaceId, verdict.allowed);
    return verdict.allowed;
  };
}
