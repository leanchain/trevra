import { createHash } from 'node:crypto';
import { Nango } from '@nangohq/node';
import { parse } from 'csv-parse/sync';
import Stripe from 'stripe';
import { z } from 'zod';
import { notifyIntegrationNeedsReauth } from './notifications.js';
import type { AvailableIntegration } from '../shared/types.js';
import type { Db } from './db.js';
import { id } from './db.js';

const canonicalRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    clientName: z.string(),
    contactName: z.string().optional(),
    clientEmail: z.string().email().optional(),
    projectName: z.string().optional(),
    direction: z.enum(['inbound', 'outbound']),
    subject: z.string().default(''),
    body: z.string(),
    occurredAt: z.string().datetime(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('opportunity'),
    id: z.string(),
    clientName: z.string(),
    contactName: z.string().optional(),
    clientEmail: z.string().email().optional(),
    title: z.string(),
    value: z.number().nonnegative(),
    currency: z.string().default('EUR'),
    status: z.string(),
    proposalSentAt: z.string().datetime().optional(),
    expectedResponseAt: z.string().datetime().optional(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('invoice'),
    id: z.string(),
    clientName: z.string(),
    contactName: z.string().optional(),
    clientEmail: z.string().email().optional(),
    projectName: z.string().optional(),
    externalRef: z.string(),
    amount: z.number().nonnegative(),
    currency: z.string().default('EUR'),
    status: z.string(),
    issuedAt: z.string().datetime(),
    dueAt: z.string().datetime(),
    paidAt: z.string().datetime().optional(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('payment'),
    id: z.string(),
    invoiceExternalRef: z.string().optional(),
    amount: z.number().nonnegative(),
    currency: z.string().default('EUR'),
    paidAt: z.string().datetime(),
    clientName: z.string().optional(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('milestone'),
    id: z.string(),
    clientName: z.string(),
    contactName: z.string().optional(),
    clientEmail: z.string().email().optional(),
    projectName: z.string(),
    name: z.string(),
    amount: z.number().nonnegative(),
    currency: z.string().default('EUR'),
    status: z.string(),
    deliveredAt: z.string().datetime().optional(),
    invoicedAt: z.string().datetime().optional(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('scope_item'),
    id: z.string(),
    clientName: z.string(),
    projectName: z.string(),
    description: z.string(),
    included: z.boolean(),
    unitPrice: z.number().nonnegative().optional(),
    currency: z.string().default('EUR'),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('contract'),
    id: z.string(),
    clientName: z.string(),
    contactName: z.string().optional(),
    clientEmail: z.string().email().optional(),
    projectName: z.string().optional(),
    title: z.string(),
    status: z.string(),
    signedAt: z.string().datetime().optional(),
    effectiveAt: z.string().datetime().optional(),
    clauses: z
      .array(
        z.object({
          type: z.string(),
          title: z.string(),
          content: z.string(),
          value: z.number().optional(),
          unit: z.string().optional()
        })
      )
      .default([]),
    externalUrl: z.string().url().optional()
  })
]);

export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;

/**
 * The integration catalog is the single source of truth for what Trevra can connect to.
 *
 * `mode: 'oauth'` and `mode: 'apiKey'` both resolve their Nango integration id (provider config
 * key) from `process.env[env] ?? fallback`; they differ only in what the Nango Connect UI asks the
 * end user for. For `apiKey` the user pastes their provider key into the Connect UI, which posts it
 * straight to Nango — the raw key never reaches a Trevra process, is never rendered, logged, or
 * written to the database. Trevra stores only the connection reference returned on the auth webhook.
 * `mode: 'import'` has no live connection and uses its own key as an identifier.
 *
 * CRM integrations (HubSpot, Attio) are READ / sync only, deliberately.
 * Creating or updating a record in someone else's CRM is an `external-write` side effect, and every
 * external write in Trevra must go through prepareAction -> approveAction -> executeAction in
 * action-service.ts, where the exact approved payload is hashed and a drifted payload is rejected.
 * Wiring that up needs a new prepared-action type plus its schema, approval UI, and policy surface,
 * NOTE: CRM write-back now exists, but deliberately NOT here. It lives in
 * `crm/activity.ts` behind the `crm.log-activity` action type, because it
 * writes ACTIVITY rather than records and must never share a code path with
 * the record-owning providers below. `executeConnectedAction` still has no
 * hubspot/attio branch and falls through
 * to `throw new Error(\`Provider ${provider} cannot execute ${actionType}\`)`, so no ungated write
 * path exists. Do not add one without routing it through the approval gate first.
 *
 * APOLLO IS DELIBERATELY ABSENT, and must stay absent. Nango ships an `apollo` provider config, so
 * adding a row here would work -- but Apollo's Terms of Service, Section 3 (API Usage Requirements ->
 * Access and Integration), https://www.apollo.io/terms, read on 2026-07-27, state: "You may not
 * access the APIs via a third party's API credentials or integrate the Apollo APIs with your own
 * product or service." That clause is unqualified; the "internal tools ... not separately
 * commercialized" carve-out lives in the General Usage Restrictions and does not reach it. Shipping
 * an Apollo connection is exactly what it prohibits, whether Trevra is self-hosted or hosted.
 */
const catalog = [
  {
    key: 'gmail',
    provider: 'gmail',
    name: 'Gmail',
    category: 'communication',
    description: 'Read client threads and send approved follow-ups.',
    mode: 'oauth',
    env: 'NANGO_GMAIL_INTEGRATION',
    fallback: 'trevra-gmail'
  },
  // Meetings have no canonical record kind, so everything this sync returns is
  // counted and dropped rather than stored (see `syncNangoRecords`). The
  // description says so instead of promising what the connection cannot do.
  {
    key: 'google-calendar',
    provider: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description:
      'Not ready yet — Trevra has nowhere to put meetings, so connecting this brings nothing in.',
    mode: 'oauth',
    env: 'NANGO_GOOGLE_CALENDAR_INTEGRATION',
    fallback: 'trevra-google-calendar'
  },
  {
    key: 'microsoft',
    provider: 'microsoft',
    name: 'Microsoft 365',
    category: 'communication',
    description: 'Connect Outlook mail and calendar through Microsoft Graph.',
    mode: 'oauth',
    env: 'NANGO_MICROSOFT_INTEGRATION',
    fallback: 'trevra-microsoft'
  },
  {
    key: 'honeybook',
    provider: 'honeybook',
    name: 'HoneyBook',
    category: 'project',
    description: 'Import client lifecycle and project records.',
    mode: 'oauth',
    env: 'NANGO_HONEYBOOK_INTEGRATION',
    fallback: 'trevra-honeybook'
  },
  {
    key: 'bonsai',
    provider: 'bonsai',
    name: 'Bonsai',
    category: 'project',
    description: 'Import contracts, projects, and invoices.',
    mode: 'oauth',
    env: 'NANGO_BONSAI_INTEGRATION',
    fallback: 'trevra-bonsai'
  },
  {
    key: 'hubspot',
    provider: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    description:
      'Read your contacts, companies, and deals. Trevra adds a note when you approve work — it never creates or edits records.',
    mode: 'oauth',
    env: 'NANGO_HUBSPOT_INTEGRATION',
    fallback: 'trevra-hubspot'
  },
  {
    key: 'attio',
    provider: 'attio',
    name: 'Attio',
    category: 'crm',
    description:
      'Read your people, companies, and deals. Trevra adds a note when you approve work — it never creates or edits records.',
    mode: 'oauth',
    env: 'NANGO_ATTIO_INTEGRATION',
    fallback: 'trevra-attio'
  },
  // The key this connection stores in Nango is NOT what the search reads.
  // `research/providers/exa.ts` takes its key from the server environment
  // (`EXA_API_KEY`), so connecting here switches nothing on. Wiring the stored
  // credential through would mean threading the workspace's Nango connection
  // into the research credential map; until that exists the card says so.
  {
    key: 'exa',
    provider: 'exa',
    name: 'Exa',
    category: 'data',
    description:
      'Find companies worth reaching out to. Set up by whoever runs this Trevra — connecting here does not switch it on yet.',
    mode: 'apiKey',
    env: 'NANGO_EXA_INTEGRATION',
    fallback: 'trevra-exa'
  },
  {
    key: 'reddit',
    provider: 'reddit',
    name: 'Reddit',
    category: 'data',
    description:
      'Authorize a Reddit account through Nango, then collect reusable research sources and search the resulting corpus.',
    mode: 'oauth',
    env: 'NANGO_REDDIT_INTEGRATION',
    fallback: 'trevra-reddit'
  }
] as const;

const MONEY_INTEGRATION_PROVIDERS = new Set([
  'quickbooks',
  'xero',
  'stripe',
  'upwork',
  'fiverr',
  'contra'
]);

export function isMoneyIntegrationProvider(provider: string): boolean {
  return MONEY_INTEGRATION_PROVIDERS.has(provider.trim().toLowerCase());
}

type CatalogEntry = (typeof catalog)[number];

/** Every remaining integration is Nango-backed. */
function providerConfigKeyFor(item: CatalogEntry): string {
  return String(process.env[item.env] ?? item.fallback);
}

/** Integration ids the Connect UI may offer. Money integrations are not in this catalog. */
export function defaultConnectSessionIntegrations(): string[] {
  return catalog.map(providerConfigKeyFor);
}

export async function listAvailableIntegrations(
  db: Db,
  workspaceId: string
): Promise<AvailableIntegration[]> {
  const connected = await db
    .prepare(
      "SELECT provider_config_key FROM connections WHERE workspace_id=? AND status='connected'"
    )
    .all<{ provider_config_key: string }>(workspaceId);
  const connectedKeys = new Set(connected.map((row) => row.provider_config_key));
  return catalog.map((item) => {
    const providerConfigKey = providerConfigKeyFor(item);
    return {
      key: providerConfigKey,
      provider: item.provider,
      name: item.name,
      category: item.category,
      description: item.description,
      mode: item.mode,
      connected: connectedKeys.has(providerConfigKey)
    };
  });
}

export async function createNangoConnectSession(input: {
  workspaceId: string;
  userId: string;
  userEmail: string;
  allowedIntegrations: string[];
}) {
  const nango = getNango();
  const supported = new Set(defaultConnectSessionIntegrations());
  const allowed =
    input.allowedIntegrations.length > 0
      ? input.allowedIntegrations.filter((integration) => supported.has(integration))
      : [...supported];
  if (allowed.length === 0) throw new Error('No supported integrations were requested.');
  const result = await nango.createConnectSession({
    allowed_integrations: allowed,
    tags: {
      end_user_id: input.userId,
      end_user_email: input.userEmail,
      organization_id: input.workspaceId,
      end_user_display_name: input.userEmail
    }
  });
  return {
    ...result.data,
    browser_host: process.env.NANGO_PUBLIC_SERVER_URL ?? process.env.NANGO_HOST
  };
}

export async function handleNangoWebhook(
  db: Db,
  rawBody: string,
  headers: Record<string, unknown>
): Promise<{ duplicate: boolean; processed: string }> {
  const nango = getNango();
  if (!nango.verifyIncomingWebhookRequest(rawBody, headers))
    throw new Error('Invalid Nango webhook signature');
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const payloadHash = sha(rawBody);
  const externalEventId = String(
    payload.id ??
      payload.activityLogId ??
      `${payload.type}:${payload.operation ?? payload.syncName ?? ''}:${payloadHash}`
  );

  // RESOLVE THE TENANT, THEN CLAIM THE EVENT ID -- same ordering, and the same
  // reason, as `processStripeWebhook`. 058's idempotency key includes the
  // workspace, so a row recorded unattributed and later updated with its real
  // tenant vacates the `@unresolved` slot and the provider's next redelivery is
  // processed again. For a sync webhook that means re-ingesting a tenant's whole
  // record set; for an auth webhook it means re-upserting a connection.
  //
  // A failure to resolve is still recorded, in the sentinel bucket, before the
  // throw: an event nobody can attribute has no tenant slot to sit in, and
  // redeliveries of an unattributable event must still dedupe against each
  // other rather than piling up rows.
  let workspaceId: string | null = null;
  let connection: Record<string, unknown> | undefined;
  try {
    if (payload.type === 'auth') {
      const tags = (payload.tags ?? {}) as Record<string, unknown>;
      workspaceId = String(tags.organization_id ?? '') || null;
      if (!workspaceId) throw new Error('Nango auth webhook is missing organization_id tag');
    } else if (payload.type === 'sync' && payload.success === true) {
      connection = await resolveNangoConnection(
        db,
        String(payload.providerConfigKey),
        String(payload.connectionId)
      );
      workspaceId = String(connection.workspace_id);
    }
  } catch (error) {
    if (await recordWebhook(db, 'nango', externalEventId, null, payloadHash)) {
      await completeWebhook(
        db,
        'nango',
        externalEventId,
        'failed',
        error instanceof Error ? error.message : String(error),
        null
      );
    }
    throw error;
  }

  const inserted = await recordWebhook(db, 'nango', externalEventId, workspaceId, payloadHash);
  if (!inserted) return { duplicate: true, processed: 'duplicate' };

  try {
    if (payload.type === 'auth') {
      const provider = String(payload.provider ?? payload.providerConfigKey ?? '');
      if (isMoneyIntegrationProvider(provider)) {
        await completeWebhook(db, 'nango', externalEventId, 'ignored', null, workspaceId);
        return { duplicate: false, processed: 'ignored-money-integration' };
      }
      const tags = (payload.tags ?? {}) as Record<string, unknown>;
      const success = payload.success !== false;
      const now = new Date().toISOString();
      const providerConfigKey = String(payload.providerConfigKey);
      const connectionId = String(payload.connectionId);
      const existing = (await db
        .prepare(
          'SELECT id,status FROM connections WHERE workspace_id=? AND provider_config_key=? AND external_connection_id=?'
        )
        .get(workspaceId, providerConfigKey, connectionId)) as
        { id: string; status: string } | undefined;
      const localId = existing?.id ?? id('conn');
      await db
        .prepare(
          `
        INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO UPDATE SET
          provider=excluded.provider,display_name=excluded.display_name,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at
      `
        )
        .run(
          localId,
          workspaceId,
          String(payload.provider ?? providerConfigKey),
          providerConfigKey,
          connectionId,
          tags.end_user_email ? String(tags.end_user_email) : null,
          success ? 'connected' : 'needs_reauth',
          0,
          success ? null : JSON.stringify(payload.error ?? 'Connection failed'),
          now,
          now
        );
      await completeWebhook(db, 'nango', externalEventId, 'processed', null, workspaceId);
      if (!success && existing?.status !== 'needs_reauth') {
        try {
          const providerError = typeof payload.error === 'string' ? payload.error : '';
          const reason = /expired|invalid_grant|revoked/i.test(providerError)
            ? 'The provider authorization expired or was revoked.'
            : /denied|unauthori[sz]ed|forbidden/i.test(providerError)
              ? 'The provider rejected the authorization.'
              : 'The provider authorization could not be refreshed.';
          await notifyIntegrationNeedsReauth(db, {
            workspaceId: String(workspaceId),
            provider: String(payload.provider ?? providerConfigKey),
            accountLabel: tags.end_user_email ? String(tags.end_user_email) : null,
            reason
          });
        } catch (notificationError) {
          console.error(
            'Failed to deliver Trevra integration reauthorization notification',
            notificationError
          );
        }
      }
      return {
        duplicate: false,
        processed: success ? 'connection-upserted' : 'connection-needs-reauth'
      };
    }

    if (payload.type === 'sync' && payload.success === true && connection) {
      if (isMoneyIntegrationProvider(String(connection.provider))) {
        await completeWebhook(
          db,
          'nango',
          externalEventId,
          'ignored',
          null,
          String(connection.workspace_id)
        );
        return { duplicate: false, processed: 'ignored-money-integration' };
      }
      const connectionId = String(payload.connectionId);
      const providerConfigKey = String(payload.providerConfigKey);
      const synced = await syncNangoRecords(db, {
        workspaceId: String(connection.workspace_id),
        localConnectionId: String(connection.id),
        provider: String(connection.provider),
        providerConfigKey,
        externalConnectionId: connectionId,
        model: String(payload.model),
        modifiedAfter: payload.modifiedAfter ? String(payload.modifiedAfter) : undefined
      });
      // A sync that threw records away is not a clean sync, and reporting one
      // is how a connection that stores nothing goes unnoticed for months.
      const dropped =
        synced.skipped > 0
          ? `${synced.skipped} record${synced.skipped === 1 ? '' : 's'} from '${String(payload.model)}' could not be stored: Trevra has no place to put this kind of record yet.`
          : null;
      await db
        .prepare(
          "UPDATE connections SET status='connected',last_synced_at=?,last_error=?,updated_at=? WHERE id=?"
        )
        .run(new Date().toISOString(), dropped, new Date().toISOString(), String(connection.id));
      await completeWebhook(
        db,
        'nango',
        externalEventId,
        'processed',
        null,
        String(connection.workspace_id)
      );
      return {
        duplicate: false,
        processed: `synced-${synced.ingested}${synced.skipped > 0 ? `-skipped-${synced.skipped}` : ''}`
      };
    }

    await completeWebhook(db, 'nango', externalEventId, 'ignored', null, workspaceId);
    return { duplicate: false, processed: 'ignored' };
  } catch (error) {
    await completeWebhook(
      db,
      'nango',
      externalEventId,
      'failed',
      error instanceof Error ? error.message : String(error),
      workspaceId
    );
    throw error;
  }
}

/**
 * WHICH TENANT'S RECORDS ARE THESE?
 *
 * A Nango sync webhook names an integration and a connection, never a workspace
 * -- only the auth webhook carries the `organization_id` tag. The workspace
 * therefore has to come from the `connections` row, and this lookup used to take
 * whatever row the database returned first: no `workspace_id` in the predicate
 * and no LIMIT. `connections` is UNIQUE(workspace_id, provider_config_key,
 * external_connection_id) (001:45), so the same provider/connection pair in two
 * workspaces is a perfectly legal pair of rows, and the arbitrary winner's
 * `workspace_id` was then handed to `syncNangoRecords` -- filing one tenant's
 * clients, messages and invoices into another tenant's account, silently and
 * permanently.
 *
 * Nango's own connection ids are unique per integration, so more than one row
 * here means the local data is wrong, not that a choice has to be made. Refuse:
 * a sync that stops is recoverable, a sync that guesses is a cross-tenant data
 * leak nobody notices. The offending rows are visible with a single query on
 * `connections`, so the message stays free of workspace ids -- this error is
 * returned to the webhook caller.
 *
 * Not fixed with a UNIQUE index on (provider_config_key, external_connection_id):
 * an existing deployment may already hold the duplicates this refusal is about,
 * and a migration that either fails or silently deletes one of a customer's
 * connections is worse than the refusal.
 */
async function resolveNangoConnection(
  db: Db,
  providerConfigKey: string,
  connectionId: string
): Promise<Record<string, unknown>> {
  const candidates = await db
    .prepare(
      'SELECT * FROM connections WHERE provider_config_key=? AND external_connection_id=? ORDER BY workspace_id ASC'
    )
    .all<Record<string, unknown>>(providerConfigKey, connectionId);
  if (candidates.length === 0) throw new Error('Unknown Nango connection');
  if (candidates.length > 1) {
    throw new Error(
      `Nango connection ${providerConfigKey}/${connectionId} is registered in ${candidates.length} workspaces; refusing to guess which tenant these records belong to`
    );
  }
  return candidates[0]!;
}

export async function triggerConnectionSync(
  db: Db,
  workspaceId: string,
  localConnectionId: string
): Promise<void> {
  const connection = (await db
    .prepare('SELECT * FROM connections WHERE id=? AND workspace_id=? AND is_demo=0')
    .get(localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Live connection not found');
  if (isMoneyIntegrationProvider(String(connection.provider)))
    throw new Error('This Money integration is no longer supported.');
  const syncNames = syncNamesForProvider(String(connection.provider));
  if (syncNames.length === 0) throw new Error('No sync functions configured for this provider');
  await getNango().triggerSync(
    String(connection.provider_config_key),
    syncNames,
    String(connection.external_connection_id)
  );
}

export async function disconnectIntegration(
  db: Db,
  workspaceId: string,
  localConnectionId: string
): Promise<void> {
  const connection = (await db
    .prepare('SELECT * FROM connections WHERE id=? AND workspace_id=?')
    .get(localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Connection not found');
  if (!Boolean(connection.is_demo))
    await getNango().deleteConnection(
      String(connection.provider_config_key),
      String(connection.external_connection_id)
    );
  await db
    .prepare("UPDATE connections SET status='disconnected',updated_at=? WHERE id=?")
    .run(new Date().toISOString(), localConnectionId);
}

export async function executeConnectedAction(
  db: Db,
  workspaceId: string,
  action: Record<string, unknown>
): Promise<{ provider: string; externalRef: string }> {
  const actionType = String(action.type);
  let connection = action.connection_id
    ? ((await db
        .prepare("SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected'")
        .get(String(action.connection_id), workspaceId)) as Record<string, unknown> | undefined)
    : undefined;
  if (!connection) {
    const providerFilter =
      actionType === 'invoice_draft'
        ? "provider IN ('quickbooks','xero','stripe')"
        : actionType === 'change_order_draft'
          ? "provider IN ('honeybook','bonsai','gmail','google-mail','microsoft','outlook')"
          : "provider IN ('gmail','google-mail','microsoft','outlook')";
    connection = (await db
      .prepare(
        `SELECT * FROM connections WHERE workspace_id=? AND status='connected' AND ${providerFilter} ORDER BY is_demo ASC,updated_at DESC LIMIT 1`
      )
      .get(workspaceId)) as Record<string, unknown> | undefined;
  }
  if (!connection) {
    const settings = await db
      .prepare('SELECT demo_mode FROM workspace_settings WHERE workspace_id=?')
      .get<{ demo_mode?: number }>(workspaceId);
    if (Boolean(settings?.demo_mode)) {
      connection = await db
        .prepare(
          "SELECT * FROM connections WHERE workspace_id=? AND is_demo=1 AND status='connected' ORDER BY updated_at DESC LIMIT 1"
        )
        .get<Record<string, unknown>>(workspaceId);
    }
  }
  if (!connection) {
    const requirement =
      actionType === 'invoice_draft'
        ? 'QuickBooks, Xero, or Stripe'
        : actionType === 'change_order_draft'
          ? 'HoneyBook, Bonsai, Gmail, or Microsoft 365'
          : 'Gmail or Microsoft 365';
    throw new Error(`Connect ${requirement} before executing this action`);
  }
  if (Boolean(connection.is_demo)) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SIMULATED_EXECUTION !== 'true') {
      throw new Error('A live provider connection is required in production');
    }
    return { provider: 'simulation', externalRef: `sim_${id('delivery')}` };
  }

  const provider = String(connection.provider);
  const providerConfigKey = String(connection.provider_config_key);
  const connectionId = String(connection.external_connection_id);
  const nango = getNango();
  const structuredPayload = JSON.parse(String(action.structured_payload_json ?? '{}')) as Record<
    string,
    unknown
  >;

  if (actionType === 'invoice_draft' && ['quickbooks', 'xero', 'stripe'].includes(provider)) {
    const envKey = `NANGO_ACTION_CREATE_INVOICE_${provider.toUpperCase().replaceAll('-', '_')}`;
    const actionName =
      process.env[envKey] ?? process.env.NANGO_ACTION_CREATE_INVOICE ?? 'trevra-create-invoice';
    const response = await triggerNangoAction(
      nango,
      { providerConfigKey, connectionId, actionName },
      {
        ...structuredPayload,
        recipient: String(action.recipient),
        message: String(action.body),
        idempotencyKey: String(action.payload_hash)
      },
      'Creating an invoice'
    );
    const externalRef = response.invoiceId ?? response.id ?? response.externalRef;
    if (!externalRef) throw new Error(`${provider} invoice action returned no invoice reference`);
    return { provider, externalRef: String(externalRef) };
  }

  if (actionType === 'change_order_draft' && ['honeybook', 'bonsai'].includes(provider)) {
    const envKey = `NANGO_ACTION_CREATE_CHANGE_ORDER_${provider.toUpperCase()}`;
    const actionName =
      process.env[envKey] ??
      process.env.NANGO_ACTION_CREATE_CHANGE_ORDER ??
      'trevra-create-change-order';
    const response = await triggerNangoAction(
      nango,
      { providerConfigKey, connectionId, actionName },
      {
        ...structuredPayload,
        recipient: String(action.recipient),
        subject: String(action.subject),
        message: String(action.body),
        idempotencyKey: String(action.payload_hash)
      },
      'Creating a change order'
    );
    const externalRef = response.changeOrderId ?? response.id ?? response.externalRef;
    if (!externalRef) throw new Error(`${provider} change-order action returned no reference`);
    return { provider, externalRef: String(externalRef) };
  }

  if (provider === 'microsoft' || provider === 'outlook') {
    const response = await nango.post({
      endpoint: '/v1.0/me/sendMail',
      providerConfigKey,
      connectionId,
      retries: 3,
      data: {
        message: {
          subject: String(action.subject),
          body: { contentType: 'Text', content: String(action.body) },
          toRecipients: [{ emailAddress: { address: String(action.recipient) } }],
          internetMessageHeaders: [
            { name: 'x-trevra-idempotency-key', value: String(action.payload_hash) }
          ]
        },
        saveToSentItems: true
      }
    });
    return {
      provider: 'microsoft',
      externalRef: String(response.headers['request-id'] ?? id('msmail'))
    };
  }

  if (!['gmail', 'google-mail'].includes(provider))
    throw new Error(`Provider ${provider} cannot execute ${actionType}`);
  const raw = createMimeMessage(
    String(action.recipient),
    String(action.subject),
    String(action.body),
    String(action.payload_hash)
  );
  const response = await nango.post<{ id?: string }>({
    endpoint: '/gmail/v1/users/me/messages/send',
    providerConfigKey,
    connectionId,
    retries: 3,
    data: { raw }
  });
  return { provider: 'gmail', externalRef: String(response.data.id ?? id('gmail')) };
}
export async function importMarketplaceCsv(
  db: Db,
  workspaceId: string,
  provider: 'upwork' | 'fiverr' | 'contra' | 'generic',
  csv: string
): Promise<{ imported: number; skipped: number }> {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Array<Record<string, string>>;
  let imported = 0;
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    const normalized = normalizeMarketplaceRow(provider, row, index);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    await ingestCanonicalRecord(db, workspaceId, provider, null, normalized);
    imported += 1;
  }
  return { imported, skipped };
}

export async function processStripeWebhook(
  db: Db,
  rawBody: Buffer,
  signature: string
): Promise<{ duplicate: boolean; processed: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder');
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  const payloadHash = sha(rawBody.toString('utf8'));
  const object = event.data.object as Stripe.Invoice | Stripe.PaymentIntent;
  const metadata = 'metadata' in object ? object.metadata : {};

  /**
   * TENANCY IS RESOLVED, NEVER READ OFF THE EVENT.
   *
   * This used to be `const workspaceId = metadata?.trevra_workspace_id`, and
   * everything below ran against it: `UPDATE invoices SET status='paid'`, a
   * `payments` insert, an outcome recorded against a recommendation. The
   * signature check above proves one thing only -- that the event came from the
   * Stripe account this deployment is configured for -- because
   * `STRIPE_WEBHOOK_SECRET` is a single deployment-wide secret, not a
   * per-workspace one. It says nothing about who the object belongs to.
   *
   * Metadata is writable by anyone who can touch an object in that Stripe
   * account: a tenant with their own Stripe access under the platform account, a
   * connected-account operator, anyone able to create a $0 invoice. Setting
   * `trevra_workspace_id` to a victim's id and `trevra_invoice_id` to one of
   * their invoices was enough to mark that invoice paid, insert a payment
   * against it, and clear the collections recommendation watching it. The
   * attacker never needed the victim's credentials, only their workspace id.
   *
   * So the workspace now comes from data the tenant cannot write into a Stripe
   * object: rows Trevra itself stored when that tenant's own authenticated sync
   * or import brought the object in. If nothing stored matches, there is nothing
   * to update and the event is ignored. If matches span more than one workspace,
   * the mapping is genuinely ambiguous and the event is refused rather than
   * guessed. And if the metadata names a workspace that disagrees with the
   * resolved owner, that is an attack or a misconfiguration, and either way the
   * answer is no.
   *
   * A refusal is RECORDED rather than thrown. `webhook_events` is the audit
   * trail an operator reads, and it keeps the reason permanently; throwing would
   * hand Stripe a 4xx it retries for days and eventually disables the endpoint
   * over -- turning one tenant's forged metadata into a billing outage for every
   * tenant on the deployment.
   *
   * AND IT HAPPENS BEFORE THE EVENT ID IS CLAIMED, which is the ordering that
   * makes redelivery idempotent again. Migration 058 keys idempotency on
   * (COALESCE(workspace_id,'@unresolved'), provider, external_event_id), so a
   * row inserted with an unknown tenant and later UPDATEd with its real one
   * VACATES the `@unresolved` slot -- and the next redelivery of that same
   * event walks straight back into the empty slot and is processed a second
   * time. Resolving first and claiming the id under the workspace it belongs to
   * means the row never moves buckets and a redelivery collides with itself.
   * Refusals still claim the sentinel bucket, because an event nobody owns has
   * no tenant slot to sit in, and redeliveries of it must still dedupe.
   */
  const claimedWorkspaceId = metadata?.trevra_workspace_id?.trim() || null;
  const owners = await resolveStripeObjectOwners(db, stripeObjectReferences(object));
  if (owners.length === 0) {
    return refuseStripeEvent(
      db,
      event.id,
      payloadHash,
      'ignored',
      'No stored Stripe record matches this event, so it belongs to no workspace here'
    );
  }
  if (owners.length > 1) {
    return refuseStripeEvent(
      db,
      event.id,
      payloadHash,
      'rejected',
      `This Stripe object matches stored records in ${owners.length} workspaces; refusing to guess which one it belongs to`
    );
  }
  const workspaceId = owners[0]!;
  if (claimedWorkspaceId && claimedWorkspaceId !== workspaceId) {
    return refuseStripeEvent(
      db,
      event.id,
      payloadHash,
      'rejected',
      `Event metadata claims workspace '${claimedWorkspaceId}' but the stored records for this Stripe object belong to another workspace`
    );
  }

  if (!(await recordWebhook(db, 'stripe', event.id, workspaceId, payloadHash)))
    return { duplicate: true, processed: 'duplicate' };

  try {
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      const externalRef = invoice.number ?? invoice.id;
      // Every predicate here is inside the workspace resolved above, so
      // `trevra_invoice_id` is now only a hint for picking between rows the
      // caller's own tenant already owns -- it can no longer reach across one.
      const localInvoice = (await db
        .prepare(
          'SELECT * FROM invoices WHERE workspace_id=? AND (external_ref=? OR external_ref=? OR id=?)'
        )
        .get(workspaceId, externalRef, invoice.id ?? '', metadata?.trevra_invoice_id ?? '')) as
        Record<string, unknown> | undefined;
      const amount = Number(invoice.amount_paid ?? 0) / 100;
      if (localInvoice) {
        const paidAt = new Date(
          (invoice.status_transitions?.paid_at ?? event.created) * 1000
        ).toISOString();
        await db
          .prepare("UPDATE invoices SET status='paid',paid_at=? WHERE id=?")
          .run(paidAt, String(localInvoice.id));
        await db
          .prepare(
            `
          INSERT INTO payments (id,workspace_id,invoice_id,external_id,amount,currency,paid_at,created_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,external_id) DO NOTHING
        `
          )
          .run(
            id('pay'),
            workspaceId,
            String(localInvoice.id),
            event.id,
            amount,
            invoice.currency.toUpperCase(),
            paidAt,
            new Date().toISOString()
          );
        const rec = (await db
          .prepare('SELECT id FROM recommendations WHERE workspace_id=? AND source_key=?')
          .get(workspaceId, `invoice:${localInvoice.id}:overdue`)) as { id: string } | undefined;
        if (rec)
          await recordOutcome(
            db,
            workspaceId,
            rec.id,
            'revenue_collected',
            amount,
            invoice.currency.toUpperCase(),
            { stripeEventId: event.id }
          );
      }
      await completeWebhook(db, 'stripe', event.id, 'processed', null, workspaceId);
      return { duplicate: false, processed: 'invoice-paid' };
    }
    await completeWebhook(db, 'stripe', event.id, 'ignored', null, workspaceId);
    return { duplicate: false, processed: 'ignored' };
  } catch (error) {
    await completeWebhook(
      db,
      'stripe',
      event.id,
      'failed',
      error instanceof Error ? error.message : String(error),
      workspaceId
    );
    throw error;
  }
}

/**
 * Park an event Trevra will not act on, in the unattributed bucket.
 *
 * Deliberately NOT recorded under the workspace the resolver named, in the
 * mismatch case where one is known: the event was refused, not processed for
 * that tenant, and consuming their (workspace, provider, event id) slot would
 * let an attacker pre-emptively burn an id the tenant's real event needs.
 */
async function refuseStripeEvent(
  db: Db,
  eventId: string,
  payloadHash: string,
  status: 'ignored' | 'rejected',
  reason: string
): Promise<{ duplicate: boolean; processed: string }> {
  if (!(await recordWebhook(db, 'stripe', eventId, null, payloadHash)))
    return { duplicate: true, processed: 'duplicate' };
  await completeWebhook(db, 'stripe', eventId, status, reason, null);
  return { duplicate: false, processed: status === 'ignored' ? 'ignored' : 'rejected' };
}

/**
 * Every identifier on a Stripe object that Trevra could plausibly have stored.
 *
 * Read off a plain record view rather than the typed shape because which of
 * `number`, `invoice` and `customer` exist depends on the object type and the
 * pinned API version, and a resolver that silently reads `undefined` because a
 * field moved is a resolver that quietly falls back to trusting metadata.
 */
function stripeObjectReferences(object: Stripe.Invoice | Stripe.PaymentIntent): string[] {
  const raw = object as unknown as Record<string, unknown>;
  const references = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) references.add(value.trim());
    else if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { id?: unknown }).id === 'string'
    )
      references.add(String((value as { id: string }).id));
  };
  add(raw.id);
  add(raw.number);
  add(raw.invoice);
  return [...references];
}

/**
 * Which workspaces hold a stored record for any of these Stripe identifiers.
 *
 * Both tables are written only by an authenticated path belonging to the
 * workspace they name: `source_records` by `upsertSourceRecord` during that
 * workspace's own Nango sync or CSV import, `invoices` by the same ingest.
 * Neither can be created by editing a field on a Stripe object, which is exactly
 * the property the metadata this replaces did not have.
 *
 * Returns every distinct match rather than the first, because the interesting
 * answer is not "who" but "is there exactly one who". Two tenants can legally
 * end up holding the same `external_ref` -- an invoice number is a string a
 * customer chooses -- and that case has to refuse, not pick.
 *
 * `customer` is deliberately not consulted: Trevra stores no Stripe customer id
 * anywhere, so a lookup on it would always miss, and a resolver with a branch
 * that can never match is a resolver nobody maintains.
 */
async function resolveStripeObjectOwners(db: Db, references: string[]): Promise<string[]> {
  if (references.length === 0) return [];
  const placeholders = references.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `
    SELECT workspace_id FROM invoices WHERE external_ref IN (${placeholders})
    UNION
    SELECT workspace_id FROM source_records WHERE provider='stripe' AND external_id IN (${placeholders})
  `
    )
    .all<{ workspace_id: string }>(...references, ...references);
  return [...new Set(rows.map((row) => String(row.workspace_id)))].sort();
}

export async function syncNangoRecords(
  db: Db,
  input: {
    workspaceId: string;
    localConnectionId: string;
    provider: string;
    providerConfigKey: string;
    externalConnectionId: string;
    model: string;
    modifiedAfter?: string;
  }
): Promise<NangoSyncResult> {
  const nango = getNango();
  let cursor: string | null = null;
  let ingested = 0;
  let skipped = 0;
  do {
    const result: { records: Array<Record<string, unknown>>; next_cursor: string | null } =
      await nango.listRecords<Record<string, unknown>>({
        providerConfigKey: input.providerConfigKey,
        connectionId: input.externalConnectionId,
        model: input.model,
        modifiedAfter: cursor ? undefined : input.modifiedAfter,
        cursor,
        limit: 100
      });
    for (const raw of result.records) {
      const normalized = normalizeNangoRecord(input.model, raw as Record<string, unknown>);
      if (!normalized) {
        // COUNTED, NOT SWALLOWED. `normalizeNangoRecord` returns null for any
        // model it has no canonical kind for -- `trevra-meetings` is the live
        // example, since there is no `meeting` kind and Calendar therefore
        // ingests nothing. Dropping those silently made a connection that
        // stores nothing look identical to one with no new records, which is
        // the failure mode that makes a quiet account untrustworthy.
        skipped += 1;
        continue;
      }
      await ingestCanonicalRecord(
        db,
        input.workspaceId,
        input.provider,
        input.localConnectionId,
        normalized
      );
      ingested += 1;
    }
    cursor = result.next_cursor;
  } while (cursor);
  return { ingested, skipped };
}

/**
 * What one sync actually did.
 *
 * Two numbers rather than one, because "nothing arrived" and "everything that
 * arrived was thrown away" are different facts and only the second is a bug
 * the operator can act on.
 */
export interface NangoSyncResult {
  ingested: number;
  skipped: number;
}

export async function ingestCanonicalRecord(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  input: CanonicalRecord
): Promise<void> {
  const record = canonicalRecordSchema.parse(input);
  const recordKind = String(record.kind);
  if (recordKind === 'invoice' || recordKind === 'payment' || recordKind === 'milestone') {
    throw new Error(`Money record kind '${recordKind}' is no longer supported.`);
  }
  const now = new Date().toISOString();
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    'occurredAt' in record ? record.occurredAt : now
  );

  if (record.kind === 'payment') {
    const invoice = record.invoiceExternalRef
      ? ((await db
          .prepare('SELECT * FROM invoices WHERE workspace_id=? AND external_ref=?')
          .get(workspaceId, record.invoiceExternalRef)) as Record<string, unknown> | undefined)
      : undefined;
    await db
      .prepare(
        `
      INSERT INTO payments (id,workspace_id,invoice_id,external_id,amount,currency,paid_at,source_record_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,external_id) DO UPDATE SET amount=excluded.amount,paid_at=excluded.paid_at,source_record_id=excluded.source_record_id
    `
      )
      .run(
        id('pay'),
        workspaceId,
        invoice ? String(invoice.id) : null,
        record.id,
        record.amount,
        record.currency,
        record.paidAt,
        sourceId,
        now
      );
    if (invoice)
      await db
        .prepare("UPDATE invoices SET status='paid',paid_at=? WHERE id=?")
        .run(record.paidAt, String(invoice.id));
    return;
  }

  const client = await findOrCreateClient(
    db,
    workspaceId,
    provider,
    record.clientName,
    'contactName' in record ? record.contactName : undefined,
    'clientEmail' in record ? record.clientEmail : undefined,
    now
  );
  const projectName = 'projectName' in record ? record.projectName : undefined;
  const projectId = projectName
    ? await findOrCreateProject(
        db,
        workspaceId,
        client.id,
        projectName,
        'currency' in record ? record.currency : 'EUR',
        now
      )
    : null;

  switch (record.kind) {
    case 'message': {
      const existing = (await db
        .prepare('SELECT id FROM messages WHERE source_record_id=?')
        .get(sourceId)) as { id: string } | undefined;
      if (existing)
        await db
          .prepare(
            'UPDATE messages SET client_id=?,project_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=?'
          )
          .run(
            client.id,
            projectId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            existing.id
          );
      else
        await db
          .prepare(
            'INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id('msg'),
            workspaceId,
            client.id,
            projectId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            sourceId,
            now
          );
      await db
        .prepare('UPDATE clients SET last_interaction_at=? WHERE id=?')
        .run(record.occurredAt, client.id);
      break;
    }
    case 'opportunity': {
      const existing = (await db
        .prepare('SELECT id FROM opportunities WHERE source_record_id=?')
        .get(sourceId)) as { id: string } | undefined;
      if (existing)
        await db
          .prepare(
            'UPDATE opportunities SET client_id=?,title=?,value=?,currency=?,status=?,proposal_sent_at=?,expected_response_at=? WHERE id=?'
          )
          .run(
            client.id,
            record.title,
            record.value,
            record.currency,
            record.status,
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            existing.id
          );
      else
        await db
          .prepare(
            'INSERT INTO opportunities (id,workspace_id,client_id,title,value,currency,status,proposal_sent_at,expected_response_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id('opp'),
            workspaceId,
            client.id,
            record.title,
            record.value,
            record.currency,
            record.status,
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            sourceId,
            now
          );
      break;
    }
    case 'invoice': {
      const existing = (await db
        .prepare(
          'SELECT id FROM invoices WHERE source_record_id=? OR (workspace_id=? AND external_ref=?)'
        )
        .get(sourceId, workspaceId, record.externalRef)) as { id: string } | undefined;
      if (existing)
        await db
          .prepare(
            'UPDATE invoices SET client_id=?,project_id=?,amount=?,currency=?,status=?,issued_at=?,due_at=?,paid_at=?,source_record_id=? WHERE id=?'
          )
          .run(
            client.id,
            projectId,
            record.amount,
            record.currency,
            record.status,
            record.issuedAt,
            record.dueAt,
            record.paidAt ?? null,
            sourceId,
            existing.id
          );
      else
        await db
          .prepare(
            'INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id('inv'),
            workspaceId,
            client.id,
            projectId,
            record.externalRef,
            record.amount,
            record.currency,
            record.status,
            record.issuedAt,
            record.dueAt,
            record.paidAt ?? null,
            sourceId,
            now
          );
      break;
    }
    // MILESTONES, SCOPE ITEMS, CONTRACT CLAUSES: `workspace_id` comes off the
    // parent row, in the same statement, and never from this function's
    // `workspaceId` argument.
    //
    // Migration 058 added a nullable `workspace_id` to these tables precisely
    // because they were reachable only through a parent id, so no handler could
    // scope them and every read had to remember a join. It stopped short of
    // `SET NOT NULL` because writers -- this one included -- were still leaving
    // the column empty. These writes fill it, which is what lets a later
    // migration tighten the constraint.
    //
    // `INSERT ... SELECT FROM parent` rather than passing the ambient workspace
    // as a parameter, for two reasons. It is the parent's own value by
    // construction, so a child can never be stamped with a tenant its parent
    // does not belong to -- which is exactly the row a mis-scoped webhook would
    // have written. And it costs no extra round trip: a missing or foreign
    // parent inserts nothing instead of inserting an orphan.
    case 'milestone': {
      if (!projectId) throw new Error('Milestone requires a project');
      const existing = (await db
        .prepare('SELECT id FROM milestones WHERE source_record_id=?')
        .get(sourceId)) as { id: string } | undefined;
      if (existing)
        await db
          .prepare(
            `
        UPDATE milestones m SET workspace_id=p.workspace_id,project_id=p.id,name=?,amount=?,currency=?,status=?,delivered_at=?,invoiced_at=?
        FROM projects p WHERE p.id=? AND m.id=?
      `
          )
          .run(
            record.name,
            record.amount,
            record.currency,
            record.status,
            record.deliveredAt ?? null,
            record.invoicedAt ?? null,
            projectId,
            existing.id
          );
      else
        await db
          .prepare(
            `
        INSERT INTO milestones (id,workspace_id,project_id,name,amount,currency,status,delivered_at,invoiced_at,source_record_id,created_at)
        SELECT ?,p.workspace_id,p.id,?,?,?,?,?,?,?,? FROM projects p WHERE p.id=?
      `
          )
          .run(
            id('mil'),
            record.name,
            record.amount,
            record.currency,
            record.status,
            record.deliveredAt ?? null,
            record.invoicedAt ?? null,
            sourceId,
            now,
            projectId
          );
      break;
    }
    case 'scope_item': {
      if (!projectId) throw new Error('Scope item requires a project');
      const existing = (await db
        .prepare('SELECT id FROM scope_items WHERE source_record_id=?')
        .get(sourceId)) as { id: string } | undefined;
      if (existing)
        await db
          .prepare(
            `
        UPDATE scope_items s SET workspace_id=p.workspace_id,project_id=p.id,description=?,included=?,unit_price=?
        FROM projects p WHERE p.id=? AND s.id=?
      `
          )
          .run(
            record.description,
            record.included ? 1 : 0,
            record.unitPrice ?? null,
            projectId,
            existing.id
          );
      else
        await db
          .prepare(
            `
        INSERT INTO scope_items (id,workspace_id,project_id,description,included,unit_price,source_record_id,created_at)
        SELECT ?,p.workspace_id,p.id,?,?,?,?,? FROM projects p WHERE p.id=?
      `
          )
          .run(
            id('scope'),
            record.description,
            record.included ? 1 : 0,
            record.unitPrice ?? null,
            sourceId,
            now,
            projectId
          );
      break;
    }
    case 'contract': {
      const existing = (await db
        .prepare('SELECT id FROM contracts WHERE source_record_id=?')
        .get(sourceId)) as { id: string } | undefined;
      const contractId = existing?.id ?? id('contract');
      if (existing)
        await db
          .prepare(
            'UPDATE contracts SET client_id=?,project_id=?,title=?,status=?,signed_at=?,effective_at=? WHERE id=?'
          )
          .run(
            client.id,
            projectId,
            record.title,
            record.status,
            record.signedAt ?? null,
            record.effectiveAt ?? null,
            contractId
          );
      else
        await db
          .prepare(
            'INSERT INTO contracts (id,workspace_id,client_id,project_id,title,status,signed_at,effective_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            contractId,
            workspaceId,
            client.id,
            projectId,
            record.title,
            record.status,
            record.signedAt ?? null,
            record.effectiveAt ?? null,
            sourceId,
            now
          );
      await db.prepare('DELETE FROM contract_clauses WHERE contract_id=?').run(contractId);
      for (const clause of record.clauses)
        await db
          .prepare(
            `
        INSERT INTO contract_clauses (id,workspace_id,contract_id,clause_type,title,content,value_number,unit,source_record_id,created_at)
        SELECT ?,c.workspace_id,c.id,?,?,?,?,?,?,? FROM contracts c WHERE c.id=?
      `
          )
          .run(
            id('clause'),
            clause.type,
            clause.title,
            clause.content,
            clause.value ?? null,
            clause.unit ?? null,
            sourceId,
            now,
            contractId
          );
      break;
    }
  }
}

/**
 * Record an outcome against a recommendation, in that recommendation's tenant.
 *
 * The caller must name the workspace, and a recommendation outside it is
 * refused rather than followed.
 *
 * Deriving the workspace from the recommendation alone was not enough. It put
 * the right value in the column -- the parent's own -- but it also meant any
 * caller could hand over any recommendation id and have the write silently
 * attributed to whichever tenant happened to own it. An outcome is money:
 * `revenue_collected`, `revenue_invoiced`. A mis-scoped caller would have
 * credited another tenant's ledger with no error and no trace.
 *
 * So both. The explicit check refuses a foreign recommendation loudly, and the
 * INSERT still takes `workspace_id` from the parent row in the same statement,
 * so the stored column can never disagree with the recommendation it hangs off
 * even if the two checks were ever to drift apart.
 *
 * Deduplication stays keyed on (recommendation_id, outcome_type) with no
 * workspace: `recommendations.id` is a primary key, so the recommendation
 * already IS the tenant scope, and adding `workspace_id=?` would let a legacy
 * row left NULL by 058's backfill be duplicated instead of recognised.
 */
export async function recordOutcome(
  db: Db,
  workspaceId: string,
  recommendationId: string,
  outcomeType: string,
  amount: number,
  currency: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const recommendation = await db
    .prepare('SELECT id FROM recommendations WHERE id=? AND workspace_id=?')
    .get<{ id: string }>(recommendationId, workspaceId);
  if (!recommendation)
    throw new Error(`Recommendation ${recommendationId} does not belong to this workspace`);
  const existing = (await db
    .prepare('SELECT id FROM recommendation_outcomes WHERE recommendation_id=? AND outcome_type=?')
    .get(recommendationId, outcomeType)) as { id: string } | undefined;
  if (existing) return;
  await db
    .prepare(
      `
    INSERT INTO recommendation_outcomes (id,workspace_id,recommendation_id,outcome_type,amount,currency,details_json,created_at)
    SELECT ?,r.workspace_id,r.id,?,?,?,?,? FROM recommendations r WHERE r.id=? AND r.workspace_id=?
  `
    )
    .run(
      id('outcome'),
      outcomeType,
      amount,
      currency,
      JSON.stringify(details),
      new Date().toISOString(),
      recommendationId,
      workspaceId
    );
}

export function getNango(): Nango {
  const apiKey = process.env.NANGO_API_KEY;
  if (!apiKey) throw new Error('NANGO_API_KEY is not configured');
  return new Nango({
    apiKey,
    webhookSigningKey: process.env.NANGO_WEBHOOK_SIGNING_KEY,
    host: process.env.NANGO_HOST
  });
}

/**
 * Call a Nango action script, and say plainly when this deployment has none.
 *
 * `trevra-create-invoice` and `trevra-create-change-order` are NOT in this
 * repository. They are Nango integration code an operator writes and deploys
 * themselves, and the money half of Trevra is frozen (docs/core-product.md §5),
 * so they are not going to appear. Without them `triggerAction` fails with a
 * Nango-shaped error that tells a founder nothing, and the product reads as if
 * it can raise an invoice it cannot raise.
 *
 * Naming the gap is the fix. The original error is kept on the end rather than
 * swallowed, because a real provider outage and a missing script both land
 * here and the operator needs to be able to tell them apart.
 */
async function triggerNangoAction(
  nango: Nango,
  target: { providerConfigKey: string; connectionId: string; actionName: string },
  input: Record<string, unknown>,
  humanAction: string
): Promise<Record<string, unknown>> {
  try {
    return await nango.triggerAction<Record<string, unknown>, Record<string, unknown>>(
      target.providerConfigKey,
      target.connectionId,
      target.actionName,
      input
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${humanAction} needs a Nango action script called '${target.actionName}'. Trevra does not ship one, ` +
        `so nothing was created and nothing was sent. Deploy that script to your Nango instance, or leave this ` +
        `action unused. (Underlying error: ${detail})`
    );
  }
}

function syncNamesForProvider(provider: string): string[] {
  const configured = process.env[`NANGO_SYNCS_${provider.toUpperCase().replaceAll('-', '_')}`];
  return configured
    ? configured
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function normalizeNangoRecord(model: string, raw: Record<string, unknown>): CanonicalRecord | null {
  const payload = { ...raw } as Record<string, unknown>;
  delete payload._nango_metadata;
  if (payload.kind) return canonicalRecordSchema.parse(payload);
  const kind = model.toLowerCase().replaceAll('-', '_');
  const aliases: Record<string, CanonicalRecord['kind']> = {
    trevramessage: 'message',
    trevra_message: 'message',
    messages: 'message',
    trevraopportunity: 'opportunity',
    trevra_opportunity: 'opportunity',
    opportunities: 'opportunity',
    trevrainvoice: 'invoice',
    trevra_invoice: 'invoice',
    invoices: 'invoice',
    trevrapayment: 'payment',
    trevra_payment: 'payment',
    payments: 'payment',
    trevramilestone: 'milestone',
    trevra_milestone: 'milestone',
    milestones: 'milestone',
    trevrascopeitem: 'scope_item',
    trevra_scope_item: 'scope_item',
    scope_items: 'scope_item',
    trevracontract: 'contract',
    trevra_contract: 'contract',
    contracts: 'contract'
  };
  const resolved = aliases[kind.replaceAll('_', '')] ?? aliases[kind];
  if (!resolved) return null;
  return canonicalRecordSchema.parse({ ...payload, kind: resolved });
}

function normalizeMarketplaceRow(
  provider: string,
  row: Record<string, string>,
  index: number
): CanonicalRecord | null {
  const get = (...keys: string[]) => {
    const normalized = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.toLowerCase().replace(/[^a-z0-9]/g, ''),
        value
      ])
    );
    for (const key of keys) {
      const value = normalized[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (value) return value;
    }
    return '';
  };
  const clientName = get('client', 'client name', 'buyer', 'employer', 'customer');
  const title = get('project', 'contract', 'job', 'gig', 'order', 'description');
  const amountRaw = get('amount', 'earnings', 'total', 'paid', 'budget', 'price').replace(
    /[^0-9.-]/g,
    ''
  );
  const amount = Number(amountRaw);
  if (!clientName || !title || !Number.isFinite(amount)) return null;
  const status = get('status', 'contract status', 'order status').toLowerCase();
  const dateRaw = get('date', 'completed date', 'start date', 'created at');
  const parsedDate = dateRaw ? new Date(dateRaw) : new Date();
  const occurredAt = Number.isNaN(parsedDate.getTime())
    ? new Date().toISOString()
    : parsedDate.toISOString();
  const currency =
    get('currency') ||
    detectCurrency(get('amount', 'earnings', 'total', 'paid', 'budget', 'price'));
  const externalId =
    get('id', 'contract id', 'order id', 'job id') ||
    `${provider}-${index}-${sha(JSON.stringify(row)).slice(0, 12)}`;
  if (/paid|complete|closed|finished/.test(status)) {
    return { kind: 'payment', id: externalId, amount, currency, paidAt: occurredAt, clientName };
  }
  return {
    kind: 'opportunity',
    id: externalId,
    clientName,
    title,
    value: amount,
    currency,
    status: /active|open|in progress/.test(status)
      ? 'won'
      : /proposal|submitted|pending/.test(status)
        ? 'proposal_sent'
        : status || 'imported',
    proposalSentAt: /proposal|submitted|pending/.test(status) ? occurredAt : undefined
  };
}

function detectCurrency(value: string): string {
  if (value.includes('€')) return 'EUR';
  if (value.includes('£')) return 'GBP';
  if (value.includes('CHF')) return 'CHF';
  return 'USD';
}

async function findOrCreateClient(
  db: Db,
  workspaceId: string,
  provider: string,
  name: string,
  contactName: string | undefined,
  email: string | undefined,
  now: string
): Promise<{ id: string }> {
  const normalizedEmail = email?.toLowerCase();
  let existing: { id: string } | undefined;
  if (normalizedEmail)
    existing = (await db
      .prepare(
        'SELECT client_id AS id FROM contact_identities WHERE workspace_id=? AND identity_value=?'
      )
      .get(workspaceId, normalizedEmail)) as { id: string } | undefined;
  if (!existing)
    existing = (await db
      .prepare('SELECT id FROM clients WHERE workspace_id=? AND lower(name)=lower(?)')
      .get(workspaceId, name)) as { id: string } | undefined;
  if (existing) return existing;
  const clientId = id('cl');
  const safeEmail =
    normalizedEmail ?? `import-${sha(`${provider}:${name}`).slice(0, 12)}@trevra.invalid`;
  await db
    .prepare(
      'INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    .run(clientId, workspaceId, name, contactName ?? name, safeEmail, 'active', 0, 'EUR', now, now);
  await db
    .prepare(
      'INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING'
    )
    .run(id('ident'), workspaceId, clientId, provider, 'email', safeEmail, now);
  return { id: clientId };
}

async function findOrCreateProject(
  db: Db,
  workspaceId: string,
  clientId: string,
  name: string,
  currency: string,
  now: string
): Promise<string> {
  const existing = (await db
    .prepare(
      'SELECT id FROM projects WHERE workspace_id=? AND client_id=? AND lower(name)=lower(?)'
    )
    .get(workspaceId, clientId, name)) as { id: string } | undefined;
  if (existing) return existing.id;
  const projectId = id('prj');
  await db
    .prepare(
      'INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(projectId, workspaceId, clientId, name, 'active', 0, currency, now);
  return projectId;
}

async function upsertSourceRecord(
  db: Db,
  workspaceId: string,
  connectionId: string | null,
  provider: string,
  objectType: string,
  externalId: string,
  externalUrl: string | null,
  payload: unknown,
  occurredAt: string
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const contentHash = sha(payloadJson);
  const existing = (await db
    .prepare(
      'SELECT id FROM source_records WHERE workspace_id=? AND provider=? AND object_type=? AND external_id=?'
    )
    .get(workspaceId, provider, objectType, externalId)) as { id: string } | undefined;
  const sourceId = existing?.id ?? id('src');
  const now = new Date().toISOString();
  await db
    .prepare(
      `
    INSERT INTO source_records (id,workspace_id,connection_id,provider,object_type,external_id,external_url,content_hash,occurred_at,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,provider,object_type,external_id) DO UPDATE SET
      connection_id=excluded.connection_id,external_url=excluded.external_url,content_hash=excluded.content_hash,
      occurred_at=excluded.occurred_at,payload_json=excluded.payload_json,updated_at=excluded.updated_at
  `
    )
    .run(
      sourceId,
      workspaceId,
      connectionId,
      provider,
      objectType,
      externalId,
      externalUrl,
      contentHash,
      occurredAt,
      payloadJson,
      now,
      now
    );
  return sourceId;
}

/**
 * Claim an event id, per tenant rather than per deployment.
 *
 * The conflict target names migration 058's index verbatim --
 * `idx_webhook_events_tenant_idempotency` on
 * (COALESCE(workspace_id,'@unresolved'), provider, external_event_id) -- which
 * replaced the global UNIQUE(provider, external_event_id) from 001. Providers
 * allocate event ids per account, not globally, so under the old rule two
 * tenants handed the same id meant the second one's event was silently
 * swallowed as a duplicate: one tenant denying another their idempotency, and
 * an existence oracle into the bargain.
 *
 * Every call here inserts with a NULL workspace, because a webhook arrives
 * before anyone knows whose it is, so unresolved redeliveries still dedupe
 * against each other in the sentinel bucket. `completeWebhook` moves the row
 * into its own tenant's bucket once resolution succeeds, which is what frees
 * the id for the next tenant.
 */
async function recordWebhook(
  db: Db,
  provider: string,
  externalEventId: string,
  workspaceId: string | null,
  payloadHash: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (COALESCE(workspace_id,'@unresolved'),provider,external_event_id) DO NOTHING"
    )
    .run(
      id('webhook'),
      provider,
      externalEventId,
      workspaceId,
      payloadHash,
      'received',
      new Date().toISOString()
    );
  return result.changes > 0;
}

/**
 * Close out the row this request opened -- and only that row.
 *
 * `workspace_id IS NOT DISTINCT FROM ?` addresses the exact row this request
 * claimed -- the tenant's own row when the event was attributed, the sentinel
 * row when it was not. Without it, an UPDATE keyed on (provider,
 * external_event_id) alone would now match every workspace that has ever been
 * handed that same provider event id and overwrite all of their statuses.
 *
 * It no longer MOVES a row between buckets. It used to
 * (`workspace_id=COALESCE(?,workspace_id)`), and that was the dedupe bug: an
 * event recorded unattributed and then resolved vacated the `@unresolved` slot,
 * so the provider's next redelivery of the same event found the slot empty and
 * was processed all over again -- a paid invoice paid twice. Callers resolve
 * the tenant before claiming the id, so the row is born in its final bucket.
 */
async function completeWebhook(
  db: Db,
  provider: string,
  externalEventId: string,
  status: string,
  error: string | null,
  workspaceId: string | null
): Promise<void> {
  await db
    .prepare(
      'UPDATE webhook_events SET status=?,error=?,processed_at=? WHERE provider=? AND external_event_id=? AND workspace_id IS NOT DISTINCT FROM ?'
    )
    .run(status, error, new Date().toISOString(), provider, externalEventId, workspaceId);
}

function createMimeMessage(
  recipient: string,
  subject: string,
  body: string,
  idempotencyKey: string
): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const mime = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    `Message-ID: <${idempotencyKey}@trevra.app>`,
    `X-Trevra-Idempotency-Key: ${idempotencyKey}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
