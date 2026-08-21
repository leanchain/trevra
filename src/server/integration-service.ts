import { createHash } from 'node:crypto';
import { Nango } from '@nangohq/node';
import { z } from 'zod';
import { notifyIntegrationNeedsReauth } from './notifications.js';
import type { AvailableIntegration } from '../shared/types.js';
import { id, type Db } from './db.js';
import { resolveContact } from './lead-capture/people.js';
import { accountForPerson, upsertPersonIdentity } from './person-identities.js';
import { projectCanonicalMessage } from './conversations.js';
import { assertNotSuppressed } from './suppressions.js';
import {
  assertEmailDeliveryCapacity,
  claimEmailDelivery,
  markEmailDeliveryFailure,
  markEmailDeliverySent
} from './email-deliveries.js';
import {
  classifyDeliveryFailure,
  classifyVerifiedInboundEmail,
  type VerifiedEmailOutcome
} from './email-outcomes.js';

const canonicalRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    accountName: z.string().optional(),
    personName: z.string().optional(),
    personEmail: z.string().email().optional(),
    direction: z.enum(['inbound', 'outbound']),
    subject: z.string().default(''),
    body: z.string(),
    occurredAt: z.string().datetime(),
    externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('opportunity'),
    id: z.string(),
    accountName: z.string().optional(),
    personName: z.string().optional(),
    personEmail: z.string().email().optional(),
    title: z.string(),
    status: z.string(),
    proposalSentAt: z.string().datetime().optional(),
    expectedResponseAt: z.string().datetime().optional(),
    externalUrl: z.string().url().optional()
  })
]);

export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;

/**
 * GTM-only integration boundary. Financial, accounting, project and post-sale
 * providers are deliberately absent; Trevra's own SaaS billing is separate platform infrastructure.
 *
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

type CatalogEntry = (typeof catalog)[number];

/** Every remaining integration is Nango-backed. */
function providerConfigKeyFor(item: CatalogEntry): string {
  return String(process.env[item.env] ?? item.fallback);
}

/** Integration ids the Connect UI may offer. Only GTM-relevant integrations are catalogued. */
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

  // RESOLVE THE TENANT, THEN CLAIM THE EVENT ID. Migration 058's idempotency
  // key includes the workspace, so a row recorded unattributed and later updated with its real
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
 * GTM records into another tenant's account, silently and
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
  if (actionType !== 'email_draft') {
    throw new Error(`Unsupported connected action type: ${actionType}`);
  }
  const recipient = String(action.recipient ?? '').trim();
  if (!recipient) throw new Error('Email action requires recipient.');
  // This is the last shared boundary before Gmail/Microsoft side effects. Every
  // email path reaches this function, so a campaign, playbook, agent, or legacy
  // recommendation cannot route around a workspace suppression.
  await assertNotSuppressed(db, workspaceId, { channel: 'email', email: recipient });

  let connection = action.connection_id
    ? ((await db
        .prepare("SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected'")
        .get(String(action.connection_id), workspaceId)) as Record<string, unknown> | undefined)
    : undefined;
  if (!connection) {
    connection = (await db
      .prepare(
        "SELECT * FROM connections WHERE workspace_id=? AND status='connected' AND provider IN ('gmail','google-mail','microsoft','outlook') ORDER BY is_demo ASC,updated_at DESC LIMIT 1"
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
  if (!connection) throw new Error('Connect Gmail or Microsoft 365 before executing this action');

  const provider = String(connection.provider);
  const providerConfigKey = String(connection.provider_config_key);
  const connectionId = String(connection.external_connection_id);
  const structuredPayload = JSON.parse(String(action.structured_payload_json ?? '{}')) as Record<
    string,
    unknown
  >;
  const idempotencyKey = String(action.payload_hash ?? '').trim();
  if (!idempotencyKey) throw new Error('Email action requires an idempotency key.');
  const purpose =
    structuredPayload.deliveryPurpose === 'reply' || structuredPayload.deliveryPurpose === 'other'
      ? structuredPayload.deliveryPurpose
      : ('outreach' as const);
  const sourceType =
    typeof structuredPayload.deliverySourceType === 'string' &&
    structuredPayload.deliverySourceType.trim()
      ? structuredPayload.deliverySourceType.trim()
      : 'email_action';
  const sourceId =
    typeof structuredPayload.deliverySourceId === 'string' &&
    structuredPayload.deliverySourceId.trim()
      ? structuredPayload.deliverySourceId.trim()
      : idempotencyKey;
  const localConnectionId = String(connection.id);
  const claimed = await claimEmailDelivery(db, {
    workspaceId,
    connectionId: localConnectionId,
    purpose,
    recipient,
    sourceType,
    sourceId,
    idempotencyKey
  });
  if (claimed.replayed) {
    if (!claimed.delivery.provider || !claimed.delivery.externalRef)
      throw new Error('Stored sent email delivery is missing its provider result.');
    return {
      provider: claimed.delivery.provider,
      externalRef: claimed.delivery.externalRef
    };
  }
  const deliveryId = claimed.delivery.id;
  try {
    await assertEmailDeliveryCapacity(db, {
      workspaceId,
      connectionId: localConnectionId,
      purpose
    });
  } catch (error) {
    await markEmailDeliveryFailure(db, deliveryId, error);
    throw error;
  }
  if (Boolean(connection.is_demo)) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SIMULATED_EXECUTION !== 'true') {
      const error = new Error('A live provider connection is required in production');
      await markEmailDeliveryFailure(db, deliveryId, error);
      throw error;
    }
    const outcome = {
      provider: 'simulation',
      externalRef: `sim_${id('delivery')}`,
      internetMessageId: `<${idempotencyKey}@trevra.app>`
    };
    await markEmailDeliverySent(db, deliveryId, outcome);
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  }
  const nango = getNango();

  const threadExternalRef =
    structuredPayload.threaded === true && typeof structuredPayload.threadExternalRef === 'string'
      ? structuredPayload.threadExternalRef.trim()
      : '';
  const threadIdempotencyKey =
    structuredPayload.threaded === true &&
    typeof structuredPayload.threadIdempotencyKey === 'string'
      ? structuredPayload.threadIdempotencyKey.trim()
      : '';
  const htmlBody =
    typeof structuredPayload.htmlBody === 'string' && structuredPayload.htmlBody.trim()
      ? structuredPayload.htmlBody
      : '';

  try {
    if (provider === 'microsoft' || provider === 'outlook') {
      if (threadExternalRef) {
        const replyDraft = await nango.post<{ id?: string; internetMessageId?: string }>({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(threadExternalRef)}/createReply`,
          providerConfigKey,
          connectionId,
          retries: 0,
          data: {
            message: {
              body: {
                contentType: htmlBody ? 'HTML' : 'Text',
                content: htmlBody || String(action.body)
              }
            }
          }
        });
        const replyId = String(replyDraft.data.id ?? '').trim();
        if (!replyId) throw new Error('Microsoft reply draft returned no message id.');
        await nango.post({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(replyId)}/send`,
          providerConfigKey,
          connectionId,
          retries: 0
        });
        const outcome = {
          provider: 'microsoft',
          externalRef: replyId,
          internetMessageId: replyDraft.data.internetMessageId ?? null
        };
        await markEmailDeliverySent(db, deliveryId, outcome);
        return { provider: outcome.provider, externalRef: outcome.externalRef };
      }

      const draft = await nango.post<{ id?: string; internetMessageId?: string }>({
        endpoint: '/v1.0/me/messages',
        providerConfigKey,
        connectionId,
        retries: 0,
        data: {
          subject: String(action.subject),
          body: {
            contentType: htmlBody ? 'HTML' : 'Text',
            content: htmlBody || String(action.body)
          },
          toRecipients: [{ emailAddress: { address: String(action.recipient) } }],
          internetMessageHeaders: [
            { name: 'x-trevra-idempotency-key', value: String(action.payload_hash) }
          ]
        }
      });
      const draftId = String(draft.data.id ?? '').trim();
      if (!draftId) throw new Error('Microsoft message draft returned no message id.');
      await nango.post({
        endpoint: `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
        providerConfigKey,
        connectionId,
        retries: 0
      });
      const outcome = {
        provider: 'microsoft',
        externalRef: draftId,
        internetMessageId: draft.data.internetMessageId ?? null
      };
      await markEmailDeliverySent(db, deliveryId, outcome);
      return { provider: outcome.provider, externalRef: outcome.externalRef };
    }

    if (!['gmail', 'google-mail'].includes(provider))
      throw new Error(`Provider ${provider} cannot execute ${actionType}`);
    let threadId = '';
    if (threadExternalRef) {
      const previous = await nango.get<{ threadId?: string }>({
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(threadExternalRef)}`,
        providerConfigKey,
        connectionId,
        retries: 3,
        params: { format: 'minimal' }
      });
      threadId = String(previous.data.threadId ?? '').trim();
      if (!threadId) throw new Error('Gmail previous message returned no thread id.');
    }
    const raw = createMimeMessage(
      String(action.recipient),
      String(action.subject),
      String(action.body),
      String(action.payload_hash),
      threadIdempotencyKey || null,
      htmlBody || null
    );
    const response = await nango.post<{ id?: string; threadId?: string }>({
      endpoint: '/gmail/v1/users/me/messages/send',
      providerConfigKey,
      connectionId,
      retries: 0,
      data: { raw, ...(threadId ? { threadId } : {}) }
    });
    const outcome = {
      provider: 'gmail',
      externalRef: String(response.data.id ?? id('gmail')),
      internetMessageId: `<${idempotencyKey}@trevra.app>`
    };
    await markEmailDeliverySent(db, deliveryId, outcome);
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  } catch (error) {
    await markEmailDeliveryFailure(db, deliveryId, error);
    throw error;
  }
}

export interface ConnectedEmailThreadEvent {
  kind: VerifiedEmailOutcome;
  providerEventId: string;
  occurredAt?: string;
  subject?: string;
  sender?: string;
  /** Present only when the provider returned verified message content. */
  body?: string;
}

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string
): string {
  return (
    headers?.find((header) => String(header.name ?? '').toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  );
}

function addressFromHeader(value: string): string {
  const bracketed = value.match(/<([^>]+)>/)?.[1];
  const raw = bracketed ?? value;
  return raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
}

function bounceLike(from: string, subject: string): boolean {
  return (
    /(?:mailer-daemon|postmaster|mail delivery subsystem|microsoft outlook)/i.test(from) ||
    /^(?:delivery status notification|undeliverable|delivery has failed|mail delivery failed)/i.test(
      subject.trim()
    )
  );
}

interface GmailMessagePayload {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePayload[];
  headers?: Array<{ name?: string; value?: string }>;
}

function decodeBase64UrlText(value: string | undefined): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64url').toString('utf8').trim();
  } catch {
    return '';
  }
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function gmailPayloadText(payload: GmailMessagePayload | undefined): string {
  if (!payload) return '';
  if (payload.mimeType?.toLowerCase().startsWith('text/plain')) {
    const text = decodeBase64UrlText(payload.body?.data);
    if (text) return text;
  }
  for (const part of payload.parts ?? []) {
    if (!part.mimeType?.toLowerCase().startsWith('text/plain')) continue;
    const text = gmailPayloadText(part);
    if (text) return text;
  }
  for (const part of payload.parts ?? []) {
    const text = gmailPayloadText(part);
    if (text) return text;
  }
  const raw = decodeBase64UrlText(payload.body?.data);
  if (!raw) return '';
  return payload.mimeType?.toLowerCase().startsWith('text/html') ? plainTextFromHtml(raw) : raw;
}

function providerBodyText(contentType: string | undefined, content: string | undefined): string {
  const raw = content?.trim() ?? '';
  if (!raw) return '';
  return contentType?.toLowerCase() === 'html' ? plainTextFromHtml(raw) : raw;
}
/**
 * Re-read the provider thread for one Trevra-sent campaign email.
 *
 * Gmail and Microsoft do not expose reliable open/click state from the mailbox API;
 * those are recorded by Trevra's opt-in tracking endpoints. They do expose the
 * conversation, which is the authoritative place to learn that the recipient replied.
 * Common delivery-status messages are also recognised as bounces when they are visible
 * in the same provider conversation. Every returned provider message id becomes the
 * idempotency key of the campaign event, so polling is safe.
 */
export async function readConnectedEmailThreadEvents(
  db: Db,
  workspaceId: string,
  input: {
    localConnectionId: string;
    externalRef: string;
    recipient: string;
  }
): Promise<ConnectedEmailThreadEvent[]> {
  const connection = (await db
    .prepare("SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected'")
    .get(input.localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection || Boolean(connection.is_demo)) return [];

  const provider = String(connection.provider);
  const providerConfigKey = String(connection.provider_config_key);
  const connectionId = String(connection.external_connection_id);
  const recipient = input.recipient.trim().toLowerCase();
  if (!recipient || !input.externalRef.trim()) return [];
  const nango = getNango();

  if (provider === 'gmail' || provider === 'google-mail') {
    const sent = await nango.get<{ threadId?: string }>({
      endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(input.externalRef)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { format: 'minimal' }
    });
    const threadId = String(sent.data.threadId ?? '').trim();
    if (!threadId) return [];
    const thread = await nango.get<{
      messages?: Array<{
        id?: string;
        internalDate?: string;
        labelIds?: string[];
        payload?: GmailMessagePayload;
      }>;
    }>({
      endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { format: 'full' }
    });
    const events: ConnectedEmailThreadEvent[] = [];
    for (const message of thread.data.messages ?? []) {
      const messageId = String(message.id ?? '').trim();
      if (!messageId || messageId === input.externalRef) continue;
      const headers = message.payload?.headers;
      const fromRaw = headerValue(headers, 'From');
      const from = addressFromHeader(fromRaw);
      const subject = headerValue(headers, 'Subject');
      const occurredAt = Number.isFinite(Number(message.internalDate))
        ? new Date(Number(message.internalDate)).toISOString()
        : undefined;
      const body = gmailPayloadText(message.payload) || undefined;
      if (from === recipient) {
        events.push({
          kind: classifyVerifiedInboundEmail({
            subject,
            body,
            autoSubmitted: headerValue(headers, 'Auto-Submitted')
          }),
          providerEventId: `gmail:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      } else if (bounceLike(fromRaw, subject)) {
        events.push({
          kind: classifyDeliveryFailure({ subject, body }),
          providerEventId: `gmail:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      }
    }
    return events;
  }

  if (provider === 'microsoft' || provider === 'outlook') {
    const sent = await nango.get<{ conversationId?: string }>({
      endpoint: `/v1.0/me/messages/${encodeURIComponent(input.externalRef)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { $select: 'conversationId' }
    });
    const conversationId = String(sent.data.conversationId ?? '').trim();
    if (!conversationId) return [];
    const escapedConversationId = conversationId.replaceAll("'", "''");
    const conversation = await nango.get<{
      value?: Array<{
        id?: string;
        receivedDateTime?: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
        body?: { contentType?: string; content?: string };
        internetMessageHeaders?: Array<{ name?: string; value?: string }>;
      }>;
    }>({
      endpoint: '/v1.0/me/messages',
      providerConfigKey,
      connectionId,
      retries: 3,
      params: {
        $filter: `conversationId eq '${escapedConversationId}'`,
        $select: 'id,receivedDateTime,subject,from,body,internetMessageHeaders',
        $top: '50'
      }
    });
    const events: ConnectedEmailThreadEvent[] = [];
    for (const message of conversation.data.value ?? []) {
      const messageId = String(message.id ?? '').trim();
      if (!messageId || messageId === input.externalRef) continue;
      const from = String(message.from?.emailAddress?.address ?? '')
        .trim()
        .toLowerCase();
      const fromLabel = `${message.from?.emailAddress?.name ?? ''} ${from}`;
      const subject = String(message.subject ?? '');
      const occurredAt = message.receivedDateTime
        ? new Date(message.receivedDateTime).toISOString()
        : undefined;
      const body = providerBodyText(message.body?.contentType, message.body?.content) || undefined;
      const autoSubmitted = message.internetMessageHeaders?.find(
        (header) => String(header.name ?? '').toLowerCase() === 'auto-submitted'
      )?.value;
      if (from === recipient) {
        events.push({
          kind: classifyVerifiedInboundEmail({ subject, body, autoSubmitted }),
          providerEventId: `microsoft:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      } else if (bounceLike(fromLabel, subject)) {
        events.push({
          kind: classifyDeliveryFailure({ subject, body }),
          providerEventId: `microsoft:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      }
    }
    return events;
  }

  return [];
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

  const identity = await resolveCanonicalRecordIdentity(
    db,
    workspaceId,
    provider,
    record.personName,
    record.personEmail,
    now
  );

  switch (record.kind) {
    case 'message': {
      const existing = await db
        .prepare('SELECT id FROM messages WHERE source_record_id=?')
        .get<{ id: string }>(sourceId);
      const messageId = existing?.id ?? id('msg');
      if (existing) {
        await db
          .prepare(
            'UPDATE messages SET person_id=?,account_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=? AND workspace_id=?'
          )
          .run(
            identity.personId,
            identity.accountId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            messageId,
            workspaceId
          );
      } else {
        await db
          .prepare(
            'INSERT INTO messages (id,workspace_id,person_id,account_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            messageId,
            workspaceId,
            identity.personId,
            identity.accountId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            sourceId,
            now
          );
      }
      await projectCanonicalMessage(db, workspaceId, messageId, new Date(now));
      break;
    }
    case 'opportunity': {
      const existing = await db
        .prepare('SELECT id FROM opportunities WHERE source_record_id=?')
        .get<{ id: string }>(sourceId);
      if (existing) {
        await db
          .prepare(
            'UPDATE opportunities SET person_id=?,account_id=?,title=?,stage=?,proposal_sent_at=?,expected_response_at=?,updated_at=? WHERE id=? AND workspace_id=?'
          )
          .run(
            identity.personId,
            identity.accountId,
            record.title,
            normalizeOpportunityStage(record.status),
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            now,
            existing.id,
            workspaceId
          );
      } else {
        await db
          .prepare(
            'INSERT INTO opportunities (id,workspace_id,person_id,account_id,title,stage,proposal_sent_at,expected_response_at,source_record_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id('opp'),
            workspaceId,
            identity.personId,
            identity.accountId,
            record.title,
            normalizeOpportunityStage(record.status),
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            sourceId,
            now,
            now
          );
      }
      break;
    }
  }
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
    opportunities: 'opportunity'
  };
  const resolved = aliases[kind.replaceAll('_', '')] ?? aliases[kind];
  if (!resolved) return null;
  return canonicalRecordSchema.parse({ ...payload, kind: resolved });
}

type OpportunityStage = 'new' | 'qualified' | 'meeting' | 'proposal' | 'won' | 'lost';

function normalizeOpportunityStage(value: string): OpportunityStage {
  const stage = value.trim().toLowerCase().replaceAll('-', '_');
  if (stage === 'qualified') return 'qualified';
  if (stage === 'meeting' || stage === 'meeting_booked') return 'meeting';
  if (stage === 'proposal' || stage === 'proposal_sent') return 'proposal';
  if (stage === 'won' || stage === 'closed_won') return 'won';
  if (stage === 'lost' || stage === 'closed_lost') return 'lost';
  return 'new';
}

async function resolveCanonicalRecordIdentity(
  db: Db,
  workspaceId: string,
  provider: string,
  contactName: string | undefined,
  email: string | undefined,
  now: string
): Promise<{ personId: string | null; accountId: string | null }> {
  const normalizedEmail = email?.trim().toLowerCase() || null;
  if (!normalizedEmail) return { personId: null, accountId: null };

  const canonicalPerson = await resolveContact(
    db,
    workspaceId,
    { name: contactName?.trim() || null, email: normalizedEmail },
    new Date(now)
  );
  const personId = canonicalPerson.contact.id;
  await upsertPersonIdentity(
    db,
    {
      workspaceId,
      personId,
      provider,
      identityType: 'email',
      identityValue: normalizedEmail
    },
    new Date(now)
  );
  return {
    personId,
    accountId: await accountForPerson(db, workspaceId, personId)
  };
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
 * was processed all over again. Callers resolve
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
  idempotencyKey: string,
  replyToIdempotencyKey: string | null = null,
  htmlBody: string | null = null
): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const priorMessageId = replyToIdempotencyKey ? `<${replyToIdempotencyKey}@trevra.app>` : null;
  const headers = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    ...(priorMessageId ? [`In-Reply-To: ${priorMessageId}`, `References: ${priorMessageId}`] : []),
    `Message-ID: <${idempotencyKey}@trevra.app>`,
    `X-Trevra-Idempotency-Key: ${idempotencyKey}`,
    'MIME-Version: 1.0'
  ];
  const mime = htmlBody
    ? (() => {
        const boundary = `trevra-${sha(idempotencyKey).slice(0, 24)}`;
        return [
          ...headers,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          body,
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          htmlBody,
          `--${boundary}--`,
          ''
        ].join('\r\n');
      })()
    : [
        ...headers,
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
