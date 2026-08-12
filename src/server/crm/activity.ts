import { z } from 'zod';
import { id, type Db } from '../db.js';
import { getNango } from '../integration-service.js';
import { getCrmAdapter } from './registry.js';
import type { ContactHint, CrmProxy } from './types.js';

/**
 * Write one activity note to the workspace's connected CRM.
 *
 * Reached only from `control-plane/execution.ts`, i.e. only for an action whose
 * exact payload a human approved. There is no unattended path.
 *
 * BEST-EFFORT BY CONTRACT, and the failure modes are ranked deliberately:
 *
 * - No CRM connected, or no adapter for it -> `skipped`. Not an error. Most
 *   workspaces have no CRM and everything else must keep working.
 * - No contact matched -> `skipped`. This is the COMMON case for community
 *   outreach: a GitHub handle usually belongs to nobody in the CRM. Trevra
 *   does NOT create the contact. Inventing records from forum handles is how a
 *   sales team's database turns to noise, and it is the one thing a CRM owner
 *   will never forgive.
 * - CRM answered and refused -> `failed`, claim released, caller may retry.
 * - Outcome unknown -> claim HELD as `pending`, same reasoning as the outreach
 *   post log: a duplicate note on someone's record is worse than a missing one.
 */

export type CrmActivityStatus = 'written' | 'skipped' | 'failed' | 'pending';

export interface CrmActivityResult {
  status: CrmActivityStatus;
  provider: string | null;
  externalRef: string | null;
  /** Plain-language cause when nothing was written. */
  reason: string | null;
  activityId: string | null;
}

export const crmActivityPayloadSchema = z.object({
  /** Who it concerned. At least one of `email` or `handle` + `handleProvider`. */
  contact: z.object({
    email: z.string().email().nullish(),
    handle: z.string().max(200).nullish(),
    handleProvider: z.string().max(40).nullish(),
    domain: z.string().max(255).nullish()
  }),
  activityType: z.string().min(1).max(40),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  url: z.string().url().nullish(),
  occurredAt: z.string().nullish(),
  /** What in Trevra caused this. Doubles as the replay guard. */
  sourceType: z.string().min(1).max(40),
  sourceId: z.string().min(1).max(120)
});

export type CrmActivityPayload = z.infer<typeof crmActivityPayloadSchema>;

interface ResolvedLocalContact {
  clientId: string | null;
  email: string | null;
}

/**
 * Map whatever we know to a local client, and thereby to an email the CRM can
 * actually be queried with.
 *
 * A platform handle only ever resolves LOCALLY, through `contact_identities`.
 * We never hand a GitHub login to a CRM search: it would either miss, or
 * fuzzy-match a different person and attach someone else's outreach to their
 * record.
 */
export async function resolveLocalContact(db: Db, workspaceId: string, hint: ContactHint): Promise<ResolvedLocalContact> {
  const email = hint.email?.trim().toLowerCase() || null;

  if (email) {
    const row = await db.prepare(`
      SELECT client_id FROM contact_identities
      WHERE workspace_id=? AND LOWER(identity_value)=?
      LIMIT 1
    `).get<{ client_id: string }>(workspaceId, email);
    return { clientId: row?.client_id ?? null, email };
  }

  const handle = hint.handle?.trim();
  if (handle && hint.handleProvider) {
    const row = await db.prepare(`
      SELECT ci.client_id, c.email
      FROM contact_identities ci
      JOIN clients c ON c.id = ci.client_id
      WHERE ci.workspace_id=? AND ci.provider=? AND LOWER(ci.identity_value)=LOWER(?)
      LIMIT 1
    `).get<{ client_id: string; email: string }>(workspaceId, hint.handleProvider, handle);
    if (row) return { clientId: row.client_id, email: row.email?.toLowerCase() ?? null };
  }

  return { clientId: null, email: null };
}

/** The workspace's connected, writable CRM, if it has one. */
async function connectedCrm(db: Db, workspaceId: string): Promise<Record<string, unknown> | undefined> {
  return db.prepare(`
    SELECT * FROM connections
    WHERE workspace_id=? AND status='connected' AND provider IN ('hubspot','attio')
    ORDER BY is_demo ASC, updated_at DESC LIMIT 1
  `).get<Record<string, unknown>>(workspaceId);
}

/** Build the proxy over one connection. Injected in tests so no Nango is needed. */
export function nangoProxy(providerConfigKey: string, connectionId: string): CrmProxy {
  const nango = getNango();
  return {
    async post<T>(endpoint: string, data: unknown): Promise<T> {
      const response = await nango.post<T>({ endpoint, providerConfigKey, connectionId, retries: 2, data });
      return response.data;
    },
    async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
      const response = await nango.get<T>({ endpoint, providerConfigKey, connectionId, retries: 2, params });
      return response.data;
    }
  };
}

export interface LogCrmActivityOptions {
  /** Injection seam for tests. */
  proxyFor?: (providerConfigKey: string, connectionId: string) => CrmProxy;
}

export async function logCrmActivity(
  db: Db,
  workspaceId: string,
  payload: CrmActivityPayload,
  now: Date,
  options: LogCrmActivityOptions = {}
): Promise<CrmActivityResult> {
  const skip = (reason: string, provider: string | null = null): CrmActivityResult => ({
    status: 'skipped',
    provider,
    externalRef: null,
    reason,
    activityId: null
  });

  const connection = await connectedCrm(db, workspaceId);
  if (!connection) return skip('No CRM is connected to this workspace.');

  const provider = String(connection.provider);
  const adapter = getCrmAdapter(provider);
  if (!adapter) return skip(`No write adapter is registered for ${provider}.`, provider);

  // Already written for this source? The unique index would catch it, but only
  // after a second note existed in someone's CRM.
  const existing = await db.prepare(`
    SELECT id, status, external_ref FROM crm_activities
    WHERE workspace_id=? AND provider=? AND source_type=? AND source_id=? AND status <> 'failed'
    ORDER BY created_at DESC LIMIT 1
  `).get<{ id: string; status: string; external_ref: string | null }>(workspaceId, provider, payload.sourceType, payload.sourceId);
  if (existing) {
    return {
      status: existing.status === 'written' ? 'written' : existing.status === 'pending' ? 'pending' : 'skipped',
      provider,
      externalRef: existing.external_ref,
      reason: 'Already recorded for this source.',
      activityId: existing.id
    };
  }

  const local = await resolveLocalContact(db, workspaceId, payload.contact);
  const proxy = (options.proxyFor ?? nangoProxy)(String(connection.provider_config_key), String(connection.external_connection_id));

  let contact;
  try {
    contact = await adapter.findContact({ ...payload.contact, email: local.email ?? payload.contact.email ?? null }, proxy);
  } catch (cause) {
    // A lookup failure wrote nothing, so it is safe to report and move on.
    return skip(`${adapter.name} contact lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`, provider);
  }

  if (!contact) {
    // Recorded rather than dropped: "we could not attribute this" is a real
    // answer an operator should be able to see and count.
    const activityId = id('crma');
    await insertActivity(db, activityId, {
      workspaceId, provider, connection, clientId: local.clientId, contactExternalId: null,
      payload, status: 'skipped', externalRef: null,
      error: 'No matching CRM contact', now
    });
    return { status: 'skipped', provider, externalRef: null, reason: 'No matching CRM contact; nothing was created.', activityId };
  }

  const activityId = id('crma');
  await insertActivity(db, activityId, {
    workspaceId, provider, connection, clientId: local.clientId, contactExternalId: contact.externalId,
    payload, status: 'pending', externalRef: null, error: null, now
  });

  try {
    const externalRef = await adapter.logActivity(
      contact,
      {
        subject: payload.subject,
        body: payload.body,
        url: payload.url ?? null,
        occurredAt: payload.occurredAt ?? now.toISOString()
      },
      proxy
    );
    await db.prepare('UPDATE crm_activities SET status=?, external_ref=? WHERE id=?').run('written', externalRef, activityId);
    return { status: 'written', provider, externalRef, reason: null, activityId };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A 4xx means the CRM rejected it and wrote nothing: release the claim.
    // Anything else may have landed, so the claim stays 'pending'.
    const rejected = /\b4\d\d\b/.test(message);
    await db.prepare('UPDATE crm_activities SET status=?, error=? WHERE id=?')
      .run(rejected ? 'failed' : 'pending', message, activityId);
    return {
      status: rejected ? 'failed' : 'pending',
      provider,
      externalRef: null,
      reason: `${adapter.name} note failed: ${message}`,
      activityId
    };
  }
}

async function insertActivity(
  db: Db,
  activityId: string,
  input: {
    workspaceId: string;
    provider: string;
    connection: Record<string, unknown>;
    clientId: string | null;
    contactExternalId: string | null;
    payload: CrmActivityPayload;
    status: CrmActivityStatus;
    externalRef: string | null;
    error: string | null;
    now: Date;
  }
): Promise<void> {
  await db.prepare(`
    INSERT INTO crm_activities (
      id, workspace_id, provider, connection_id, client_id, contact_external_id,
      activity_type, subject, body, source_type, source_id, status, external_ref, error, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, provider, source_type, source_id) WHERE status <> 'failed' DO NOTHING
  `).run(
    activityId,
    input.workspaceId,
    input.provider,
    String(input.connection.id),
    input.clientId,
    input.contactExternalId,
    input.payload.activityType,
    input.payload.subject,
    input.payload.body,
    input.payload.sourceType,
    input.payload.sourceId,
    input.status,
    input.externalRef,
    input.error,
    input.now.toISOString()
  );
}
