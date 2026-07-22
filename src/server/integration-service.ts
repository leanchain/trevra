import { createHash } from 'node:crypto';
import { Nango } from '@nangohq/node';
import { parse } from 'csv-parse/sync';
import Stripe from 'stripe';
import { z } from 'zod';
import type { AvailableIntegration } from '../shared/types.js';
import type { Db } from './db.js';
import { id } from './db.js';

const canonicalRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'), id: z.string(), clientName: z.string(), contactName: z.string().optional(),
    clientEmail: z.string().email().optional(), projectName: z.string().optional(), direction: z.enum(['inbound', 'outbound']),
    subject: z.string().default(''), body: z.string(), occurredAt: z.string().datetime(), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('opportunity'), id: z.string(), clientName: z.string(), contactName: z.string().optional(),
    clientEmail: z.string().email().optional(), title: z.string(), value: z.number().nonnegative(), currency: z.string().default('EUR'),
    status: z.string(), proposalSentAt: z.string().datetime().optional(), expectedResponseAt: z.string().datetime().optional(), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('invoice'), id: z.string(), clientName: z.string(), contactName: z.string().optional(),
    clientEmail: z.string().email().optional(), projectName: z.string().optional(), externalRef: z.string(), amount: z.number().nonnegative(),
    currency: z.string().default('EUR'), status: z.string(), issuedAt: z.string().datetime(), dueAt: z.string().datetime(),
    paidAt: z.string().datetime().optional(), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('payment'), id: z.string(), invoiceExternalRef: z.string().optional(), amount: z.number().nonnegative(),
    currency: z.string().default('EUR'), paidAt: z.string().datetime(), clientName: z.string().optional(), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('milestone'), id: z.string(), clientName: z.string(), contactName: z.string().optional(),
    clientEmail: z.string().email().optional(), projectName: z.string(), name: z.string(), amount: z.number().nonnegative(),
    currency: z.string().default('EUR'), status: z.string(), deliveredAt: z.string().datetime().optional(), invoicedAt: z.string().datetime().optional(), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('scope_item'), id: z.string(), clientName: z.string(), projectName: z.string(), description: z.string(),
    included: z.boolean(), unitPrice: z.number().nonnegative().optional(), currency: z.string().default('EUR'), externalUrl: z.string().url().optional()
  }),
  z.object({
    kind: z.literal('contract'), id: z.string(), clientName: z.string(), contactName: z.string().optional(),
    clientEmail: z.string().email().optional(), projectName: z.string().optional(), title: z.string(), status: z.string(),
    signedAt: z.string().datetime().optional(), effectiveAt: z.string().datetime().optional(), clauses: z.array(z.object({
      type: z.string(), title: z.string(), content: z.string(), value: z.number().optional(), unit: z.string().optional()
    })).default([]), externalUrl: z.string().url().optional()
  })
]);

export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;

const catalog = [
  { key: 'gmail', provider: 'gmail', name: 'Gmail', category: 'communication', description: 'Read client threads and send approved follow-ups.', mode: 'oauth', env: 'NANGO_GMAIL_INTEGRATION', fallback: 'trevra-gmail' },
  { key: 'google-calendar', provider: 'google-calendar', name: 'Google Calendar', category: 'calendar', description: 'Understand meetings, commitments, and availability.', mode: 'oauth', env: 'NANGO_GOOGLE_CALENDAR_INTEGRATION', fallback: 'trevra-google-calendar' },
  { key: 'microsoft', provider: 'microsoft', name: 'Microsoft 365', category: 'communication', description: 'Connect Outlook mail and calendar through Microsoft Graph.', mode: 'oauth', env: 'NANGO_MICROSOFT_INTEGRATION', fallback: 'trevra-microsoft' },
  { key: 'quickbooks', provider: 'quickbooks', name: 'QuickBooks', category: 'accounting', description: 'Track invoices, customers, and payments.', mode: 'oauth', env: 'NANGO_QUICKBOOKS_INTEGRATION', fallback: 'trevra-quickbooks' },
  { key: 'xero', provider: 'xero', name: 'Xero', category: 'accounting', description: 'Sync invoices and payment status.', mode: 'oauth', env: 'NANGO_XERO_INTEGRATION', fallback: 'trevra-xero' },
  { key: 'stripe', provider: 'stripe', name: 'Stripe', category: 'payments', description: 'Confirm invoices, payments, and failures.', mode: 'oauth', env: 'NANGO_STRIPE_INTEGRATION', fallback: 'trevra-stripe' },
  { key: 'honeybook', provider: 'honeybook', name: 'HoneyBook', category: 'project', description: 'Import client lifecycle and project records.', mode: 'oauth', env: 'NANGO_HONEYBOOK_INTEGRATION', fallback: 'trevra-honeybook' },
  { key: 'bonsai', provider: 'bonsai', name: 'Bonsai', category: 'project', description: 'Import contracts, projects, and invoices.', mode: 'oauth', env: 'NANGO_BONSAI_INTEGRATION', fallback: 'trevra-bonsai' },
  { key: 'upwork', provider: 'upwork', name: 'Upwork', category: 'marketplace', description: 'Import contracts and earnings from an export.', mode: 'import' },
  { key: 'fiverr', provider: 'fiverr', name: 'Fiverr', category: 'marketplace', description: 'Import orders and earnings from an export.', mode: 'import' },
  { key: 'contra', provider: 'contra', name: 'Contra', category: 'marketplace', description: 'Import projects and payments from an export.', mode: 'import' }
] as const;

export function listAvailableIntegrations(db: Db, workspaceId: string): AvailableIntegration[] {
  const connectedKeys = new Set((db.prepare("SELECT provider_config_key FROM connections WHERE workspace_id=? AND status='connected'").all(workspaceId) as Array<{ provider_config_key: string }>).map((row) => row.provider_config_key));
  return catalog.map((item) => {
    const providerConfigKey = item.mode === 'oauth' ? String(process.env[item.env] ?? item.fallback) : item.key;
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
  const allowed = input.allowedIntegrations.length > 0
    ? input.allowedIntegrations
    : catalog.filter((item) => item.mode === 'oauth').map((item) => String(process.env[item.env] ?? item.fallback));
  const result = await nango.createConnectSession({
    allowed_integrations: allowed,
    tags: {
      end_user_id: input.userId,
      end_user_email: input.userEmail,
      organization_id: input.workspaceId,
      end_user_display_name: input.userEmail
    }
  });
  return result.data;
}

export async function handleNangoWebhook(db: Db, rawBody: string, headers: Record<string, unknown>): Promise<{ duplicate: boolean; processed: string }> {
  const nango = getNango();
  if (!nango.verifyIncomingWebhookRequest(rawBody, headers)) throw new Error('Invalid Nango webhook signature');
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const payloadHash = sha(rawBody);
  const externalEventId = String(payload.id ?? payload.activityLogId ?? `${payload.type}:${payload.operation ?? payload.syncName ?? ''}:${payloadHash}`);
  const inserted = recordWebhook(db, 'nango', externalEventId, null, payloadHash);
  if (!inserted) return { duplicate: true, processed: 'duplicate' };

  try {
    if (payload.type === 'auth') {
      const tags = (payload.tags ?? {}) as Record<string, unknown>;
      const workspaceId = String(tags.organization_id ?? '');
      if (!workspaceId) throw new Error('Nango auth webhook is missing organization_id tag');
      const success = payload.success !== false;
      const now = new Date().toISOString();
      const providerConfigKey = String(payload.providerConfigKey);
      const connectionId = String(payload.connectionId);
      const existing = db.prepare('SELECT id FROM connections WHERE workspace_id=? AND provider_config_key=? AND external_connection_id=?')
        .get(workspaceId, providerConfigKey, connectionId) as { id: string } | undefined;
      const localId = existing?.id ?? id('conn');
      db.prepare(`
        INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO UPDATE SET
          provider=excluded.provider,display_name=excluded.display_name,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at
      `).run(
        localId, workspaceId, String(payload.provider ?? providerConfigKey), providerConfigKey, connectionId,
        tags.end_user_email ? String(tags.end_user_email) : null, success ? 'connected' : 'needs_reauth', 0,
        success ? null : JSON.stringify(payload.error ?? 'Connection failed'), now, now
      );
      completeWebhook(db, 'nango', externalEventId, 'processed', null, workspaceId);
      return { duplicate: false, processed: success ? 'connection-upserted' : 'connection-needs-reauth' };
    }

    if (payload.type === 'sync' && payload.success === true) {
      const connectionId = String(payload.connectionId);
      const providerConfigKey = String(payload.providerConfigKey);
      const connection = db.prepare('SELECT * FROM connections WHERE provider_config_key=? AND external_connection_id=?')
        .get(providerConfigKey, connectionId) as Record<string, unknown> | undefined;
      if (!connection) throw new Error('Unknown Nango connection');
      const count = await syncNangoRecords(db, {
        workspaceId: String(connection.workspace_id), localConnectionId: String(connection.id), provider: String(connection.provider),
        providerConfigKey, externalConnectionId: connectionId, model: String(payload.model),
        modifiedAfter: payload.modifiedAfter ? String(payload.modifiedAfter) : undefined
      });
      db.prepare("UPDATE connections SET status='connected',last_synced_at=?,last_error=NULL,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), new Date().toISOString(), String(connection.id));
      completeWebhook(db, 'nango', externalEventId, 'processed', null, String(connection.workspace_id));
      return { duplicate: false, processed: `synced-${count}` };
    }

    completeWebhook(db, 'nango', externalEventId, 'ignored', null, null);
    return { duplicate: false, processed: 'ignored' };
  } catch (error) {
    completeWebhook(db, 'nango', externalEventId, 'failed', error instanceof Error ? error.message : String(error), null);
    throw error;
  }
}

export async function triggerConnectionSync(db: Db, workspaceId: string, localConnectionId: string): Promise<void> {
  const connection = db.prepare('SELECT * FROM connections WHERE id=? AND workspace_id=? AND is_demo=0').get(localConnectionId, workspaceId) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Live connection not found');
  const syncNames = syncNamesForProvider(String(connection.provider));
  if (syncNames.length === 0) throw new Error('No sync functions configured for this provider');
  await getNango().triggerSync(String(connection.provider_config_key), syncNames, String(connection.external_connection_id));
}

export async function disconnectIntegration(db: Db, workspaceId: string, localConnectionId: string): Promise<void> {
  const connection = db.prepare('SELECT * FROM connections WHERE id=? AND workspace_id=?').get(localConnectionId, workspaceId) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Connection not found');
  if (!Boolean(connection.is_demo)) await getNango().deleteConnection(String(connection.provider_config_key), String(connection.external_connection_id));
  db.prepare("UPDATE connections SET status='disconnected',updated_at=? WHERE id=?").run(new Date().toISOString(), localConnectionId);
}

export async function executeConnectedAction(db: Db, workspaceId: string, action: Record<string, unknown>): Promise<{ provider: string; externalRef: string }> {
  const actionType = String(action.type);
  let connection = action.connection_id
    ? db.prepare('SELECT * FROM connections WHERE id=? AND workspace_id=? AND status=\'connected\'').get(String(action.connection_id), workspaceId) as Record<string, unknown> | undefined
    : undefined;
  if (!connection) {
    const providerFilter = actionType === 'invoice_draft'
      ? "provider IN ('quickbooks','xero','stripe')"
      : actionType === 'change_order_draft'
        ? "provider IN ('honeybook','bonsai','gmail','google-mail','microsoft','outlook')"
        : "provider IN ('gmail','google-mail','microsoft','outlook')";
    connection = db.prepare(`SELECT * FROM connections WHERE workspace_id=? AND status='connected' AND ${providerFilter} ORDER BY is_demo ASC,updated_at DESC LIMIT 1`)
      .get(workspaceId) as Record<string, unknown> | undefined;
  }
  if (!connection) {
    const requirement = actionType === 'invoice_draft' ? 'QuickBooks, Xero, or Stripe' : 'Gmail or Microsoft 365';
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
  const structuredPayload = JSON.parse(String(action.structured_payload_json ?? '{}')) as Record<string, unknown>;

  if (actionType === 'invoice_draft' && ['quickbooks', 'xero', 'stripe'].includes(provider)) {
    const envKey = `NANGO_ACTION_CREATE_INVOICE_${provider.toUpperCase().replaceAll('-', '_')}`;
    const actionName = process.env[envKey] ?? process.env.NANGO_ACTION_CREATE_INVOICE ?? 'trevra-create-invoice';
    const response = await nango.triggerAction<Record<string, unknown>, Record<string, unknown>>(
      providerConfigKey,
      connectionId,
      actionName,
      { ...structuredPayload, recipient: String(action.recipient), message: String(action.body), idempotencyKey: String(action.payload_hash) }
    );
    const externalRef = response.invoiceId ?? response.id ?? response.externalRef;
    if (!externalRef) throw new Error(`${provider} invoice action returned no invoice reference`);
    return { provider, externalRef: String(externalRef) };
  }

  if (actionType === 'change_order_draft' && ['honeybook', 'bonsai'].includes(provider)) {
    const envKey = `NANGO_ACTION_CREATE_CHANGE_ORDER_${provider.toUpperCase()}`;
    const actionName = process.env[envKey] ?? process.env.NANGO_ACTION_CREATE_CHANGE_ORDER ?? 'trevra-create-change-order';
    const response = await nango.triggerAction<Record<string, unknown>, Record<string, unknown>>(
      providerConfigKey,
      connectionId,
      actionName,
      { ...structuredPayload, recipient: String(action.recipient), subject: String(action.subject), message: String(action.body), idempotencyKey: String(action.payload_hash) }
    );
    const externalRef = response.changeOrderId ?? response.id ?? response.externalRef;
    if (!externalRef) throw new Error(`${provider} change-order action returned no reference`);
    return { provider, externalRef: String(externalRef) };
  }

  if (provider === 'microsoft' || provider === 'outlook') {
    const response = await nango.post({
      endpoint: '/v1.0/me/sendMail', providerConfigKey, connectionId, retries: 3,
      data: {
        message: {
          subject: String(action.subject),
          body: { contentType: 'Text', content: String(action.body) },
          toRecipients: [{ emailAddress: { address: String(action.recipient) } }],
          internetMessageHeaders: [{ name: 'x-trevra-idempotency-key', value: String(action.payload_hash) }]
        },
        saveToSentItems: true
      }
    });
    return { provider: 'microsoft', externalRef: String(response.headers['request-id'] ?? id('msmail')) };
  }

  if (!['gmail', 'google-mail'].includes(provider)) throw new Error(`Provider ${provider} cannot execute ${actionType}`);
  const raw = createMimeMessage(String(action.recipient), String(action.subject), String(action.body), String(action.payload_hash));
  const response = await nango.post<{ id?: string }>({
    endpoint: '/gmail/v1/users/me/messages/send', providerConfigKey, connectionId, retries: 3, data: { raw }
  });
  return { provider: 'gmail', externalRef: String(response.data.id ?? id('gmail')) };
}
export function importMarketplaceCsv(db: Db, workspaceId: string, provider: 'upwork' | 'fiverr' | 'contra' | 'generic', csv: string): { imported: number; skipped: number } {
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Array<Record<string, string>>;
  let imported = 0;
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    const normalized = normalizeMarketplaceRow(provider, row, index);
    if (!normalized) { skipped += 1; continue; }
    ingestCanonicalRecord(db, workspaceId, provider, null, normalized);
    imported += 1;
  }
  return { imported, skipped };
}

export function processStripeWebhook(db: Db, rawBody: Buffer, signature: string): { duplicate: boolean; processed: string } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder');
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  const payloadHash = sha(rawBody.toString('utf8'));
  if (!recordWebhook(db, 'stripe', event.id, null, payloadHash)) return { duplicate: true, processed: 'duplicate' };

  const object = event.data.object as Stripe.Invoice | Stripe.PaymentIntent;
  const metadata = 'metadata' in object ? object.metadata : {};
  const workspaceId = metadata?.trevra_workspace_id;
  if (!workspaceId) {
    completeWebhook(db, 'stripe', event.id, 'ignored', 'Missing trevra_workspace_id metadata', null);
    return { duplicate: false, processed: 'ignored' };
  }

  try {
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      const externalRef = invoice.number ?? invoice.id;
      const localInvoice = db.prepare('SELECT * FROM invoices WHERE workspace_id=? AND (external_ref=? OR id=?)').get(workspaceId, externalRef, metadata?.trevra_invoice_id ?? '') as Record<string, unknown> | undefined;
      const amount = Number(invoice.amount_paid ?? 0) / 100;
      if (localInvoice) {
        const paidAt = new Date((invoice.status_transitions?.paid_at ?? event.created) * 1000).toISOString();
        db.prepare("UPDATE invoices SET status='paid',paid_at=? WHERE id=?").run(paidAt, String(localInvoice.id));
        db.prepare(`
          INSERT INTO payments (id,workspace_id,invoice_id,external_id,amount,currency,paid_at,created_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,external_id) DO NOTHING
        `).run(id('pay'), workspaceId, String(localInvoice.id), event.id, amount, invoice.currency.toUpperCase(), paidAt, new Date().toISOString());
        const rec = db.prepare('SELECT id FROM recommendations WHERE workspace_id=? AND source_key=?').get(workspaceId, `invoice:${localInvoice.id}:overdue`) as { id: string } | undefined;
        if (rec) recordOutcome(db, rec.id, 'revenue_collected', amount, invoice.currency.toUpperCase(), { stripeEventId: event.id });
      }
      completeWebhook(db, 'stripe', event.id, 'processed', null, workspaceId);
      return { duplicate: false, processed: 'invoice-paid' };
    }
    completeWebhook(db, 'stripe', event.id, 'ignored', null, workspaceId);
    return { duplicate: false, processed: 'ignored' };
  } catch (error) {
    completeWebhook(db, 'stripe', event.id, 'failed', error instanceof Error ? error.message : String(error), workspaceId);
    throw error;
  }
}

export async function syncNangoRecords(db: Db, input: {
  workspaceId: string; localConnectionId: string; provider: string; providerConfigKey: string;
  externalConnectionId: string; model: string; modifiedAfter?: string;
}): Promise<number> {
  const nango = getNango();
  let cursor: string | null = null;
  let count = 0;
  do {
    const result: { records: Array<Record<string, unknown>>; next_cursor: string | null } = await nango.listRecords<Record<string, unknown>>({
      providerConfigKey: input.providerConfigKey, connectionId: input.externalConnectionId,
      model: input.model, modifiedAfter: cursor ? undefined : input.modifiedAfter, cursor, limit: 100
    });
    for (const raw of result.records) {
      const normalized = normalizeNangoRecord(input.model, raw as Record<string, unknown>);
      if (!normalized) continue;
      ingestCanonicalRecord(db, input.workspaceId, input.provider, input.localConnectionId, normalized);
      count += 1;
    }
    cursor = result.next_cursor;
  } while (cursor);
  return count;
}

export function ingestCanonicalRecord(db: Db, workspaceId: string, provider: string, connectionId: string | null, input: CanonicalRecord): void {
  const record = canonicalRecordSchema.parse(input);
  const now = new Date().toISOString();
  const sourceId = upsertSourceRecord(db, workspaceId, connectionId, provider, record.kind, record.id, record.externalUrl ?? null, record, 'occurredAt' in record ? record.occurredAt : now);

  if (record.kind === 'payment') {
    const invoice = record.invoiceExternalRef
      ? db.prepare('SELECT * FROM invoices WHERE workspace_id=? AND external_ref=?').get(workspaceId, record.invoiceExternalRef) as Record<string, unknown> | undefined
      : undefined;
    db.prepare(`
      INSERT INTO payments (id,workspace_id,invoice_id,external_id,amount,currency,paid_at,source_record_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,external_id) DO UPDATE SET amount=excluded.amount,paid_at=excluded.paid_at,source_record_id=excluded.source_record_id
    `).run(id('pay'), workspaceId, invoice ? String(invoice.id) : null, record.id, record.amount, record.currency, record.paidAt, sourceId, now);
    if (invoice) db.prepare("UPDATE invoices SET status='paid',paid_at=? WHERE id=?").run(record.paidAt, String(invoice.id));
    return;
  }

  const client = findOrCreateClient(db, workspaceId, provider, record.clientName, 'contactName' in record ? record.contactName : undefined, 'clientEmail' in record ? record.clientEmail : undefined, now);
  const projectName = 'projectName' in record ? record.projectName : undefined;
  const projectId = projectName ? findOrCreateProject(db, workspaceId, client.id, projectName, 'currency' in record ? record.currency : 'EUR', now) : null;

  switch (record.kind) {
    case 'message': {
      const existing = db.prepare('SELECT id FROM messages WHERE source_record_id=?').get(sourceId) as { id: string } | undefined;
      if (existing) db.prepare('UPDATE messages SET client_id=?,project_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=?')
        .run(client.id, projectId, record.direction, record.subject, record.body, record.occurredAt, existing.id);
      else db.prepare('INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id('msg'), workspaceId, client.id, projectId, record.direction, record.subject, record.body, record.occurredAt, sourceId, now);
      db.prepare('UPDATE clients SET last_interaction_at=? WHERE id=?').run(record.occurredAt, client.id);
      break;
    }
    case 'opportunity': {
      const existing = db.prepare('SELECT id FROM opportunities WHERE source_record_id=?').get(sourceId) as { id: string } | undefined;
      if (existing) db.prepare('UPDATE opportunities SET client_id=?,title=?,value=?,currency=?,status=?,proposal_sent_at=?,expected_response_at=? WHERE id=?')
        .run(client.id, record.title, record.value, record.currency, record.status, record.proposalSentAt ?? null, record.expectedResponseAt ?? null, existing.id);
      else db.prepare('INSERT INTO opportunities (id,workspace_id,client_id,title,value,currency,status,proposal_sent_at,expected_response_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id('opp'), workspaceId, client.id, record.title, record.value, record.currency, record.status, record.proposalSentAt ?? null, record.expectedResponseAt ?? null, sourceId, now);
      break;
    }
    case 'invoice': {
      const existing = db.prepare('SELECT id FROM invoices WHERE source_record_id=? OR (workspace_id=? AND external_ref=?)').get(sourceId, workspaceId, record.externalRef) as { id: string } | undefined;
      if (existing) db.prepare('UPDATE invoices SET client_id=?,project_id=?,amount=?,currency=?,status=?,issued_at=?,due_at=?,paid_at=?,source_record_id=? WHERE id=?')
        .run(client.id, projectId, record.amount, record.currency, record.status, record.issuedAt, record.dueAt, record.paidAt ?? null, sourceId, existing.id);
      else db.prepare('INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id('inv'), workspaceId, client.id, projectId, record.externalRef, record.amount, record.currency, record.status, record.issuedAt, record.dueAt, record.paidAt ?? null, sourceId, now);
      break;
    }
    case 'milestone': {
      if (!projectId) throw new Error('Milestone requires a project');
      const existing = db.prepare('SELECT id FROM milestones WHERE source_record_id=?').get(sourceId) as { id: string } | undefined;
      if (existing) db.prepare('UPDATE milestones SET project_id=?,name=?,amount=?,currency=?,status=?,delivered_at=?,invoiced_at=? WHERE id=?')
        .run(projectId, record.name, record.amount, record.currency, record.status, record.deliveredAt ?? null, record.invoicedAt ?? null, existing.id);
      else db.prepare('INSERT INTO milestones (id,project_id,name,amount,currency,status,delivered_at,invoiced_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id('mil'), projectId, record.name, record.amount, record.currency, record.status, record.deliveredAt ?? null, record.invoicedAt ?? null, sourceId, now);
      break;
    }
    case 'scope_item': {
      if (!projectId) throw new Error('Scope item requires a project');
      const existing = db.prepare('SELECT id FROM scope_items WHERE source_record_id=?').get(sourceId) as { id: string } | undefined;
      if (existing) db.prepare('UPDATE scope_items SET project_id=?,description=?,included=?,unit_price=? WHERE id=?')
        .run(projectId, record.description, record.included ? 1 : 0, record.unitPrice ?? null, existing.id);
      else db.prepare('INSERT INTO scope_items (id,project_id,description,included,unit_price,source_record_id,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id('scope'), projectId, record.description, record.included ? 1 : 0, record.unitPrice ?? null, sourceId, now);
      break;
    }
    case 'contract': {
      const existing = db.prepare('SELECT id FROM contracts WHERE source_record_id=?').get(sourceId) as { id: string } | undefined;
      const contractId = existing?.id ?? id('contract');
      if (existing) db.prepare('UPDATE contracts SET client_id=?,project_id=?,title=?,status=?,signed_at=?,effective_at=? WHERE id=?')
        .run(client.id, projectId, record.title, record.status, record.signedAt ?? null, record.effectiveAt ?? null, contractId);
      else db.prepare('INSERT INTO contracts (id,workspace_id,client_id,project_id,title,status,signed_at,effective_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(contractId, workspaceId, client.id, projectId, record.title, record.status, record.signedAt ?? null, record.effectiveAt ?? null, sourceId, now);
      db.prepare('DELETE FROM contract_clauses WHERE contract_id=?').run(contractId);
      for (const clause of record.clauses) db.prepare('INSERT INTO contract_clauses (id,contract_id,clause_type,title,content,value_number,unit,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id('clause'), contractId, clause.type, clause.title, clause.content, clause.value ?? null, clause.unit ?? null, sourceId, now);
      break;
    }
  }
}

export function recordOutcome(db: Db, recommendationId: string, outcomeType: string, amount: number, currency: string, details: Record<string, unknown> = {}): void {
  const existing = db.prepare('SELECT id FROM recommendation_outcomes WHERE recommendation_id=? AND outcome_type=?').get(recommendationId, outcomeType) as { id: string } | undefined;
  if (existing) return;
  db.prepare('INSERT INTO recommendation_outcomes (id,recommendation_id,outcome_type,amount,currency,details_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('outcome'), recommendationId, outcomeType, amount, currency, JSON.stringify(details), new Date().toISOString());
}

function getNango(): Nango {
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
  return configured ? configured.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeNangoRecord(model: string, raw: Record<string, unknown>): CanonicalRecord | null {
  const payload = { ...raw } as Record<string, unknown>;
  delete payload._nango_metadata;
  if (payload.kind) return canonicalRecordSchema.parse(payload);
  const kind = model.toLowerCase().replaceAll('-', '_');
  const aliases: Record<string, CanonicalRecord['kind']> = {
    trevramessage: 'message', trevra_message: 'message', messages: 'message',
    trevraopportunity: 'opportunity', trevra_opportunity: 'opportunity', opportunities: 'opportunity',
    trevrainvoice: 'invoice', trevra_invoice: 'invoice', invoices: 'invoice',
    trevrapayment: 'payment', trevra_payment: 'payment', payments: 'payment',
    trevramilestone: 'milestone', trevra_milestone: 'milestone', milestones: 'milestone',
    trevrascopeitem: 'scope_item', trevra_scope_item: 'scope_item', scope_items: 'scope_item',
    trevracontract: 'contract', trevra_contract: 'contract', contracts: 'contract'
  };
  const resolved = aliases[kind.replaceAll('_', '')] ?? aliases[kind];
  if (!resolved) return null;
  return canonicalRecordSchema.parse({ ...payload, kind: resolved });
}

function normalizeMarketplaceRow(provider: string, row: Record<string, string>, index: number): CanonicalRecord | null {
  const get = (...keys: string[]) => {
    const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
    for (const key of keys) {
      const value = normalized[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (value) return value;
    }
    return '';
  };
  const clientName = get('client', 'client name', 'buyer', 'employer', 'customer');
  const title = get('project', 'contract', 'job', 'gig', 'order', 'description');
  const amountRaw = get('amount', 'earnings', 'total', 'paid', 'budget', 'price').replace(/[^0-9.-]/g, '');
  const amount = Number(amountRaw);
  if (!clientName || !title || !Number.isFinite(amount)) return null;
  const status = get('status', 'contract status', 'order status').toLowerCase();
  const dateRaw = get('date', 'completed date', 'start date', 'created at');
  const parsedDate = dateRaw ? new Date(dateRaw) : new Date();
  const occurredAt = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();
  const currency = get('currency') || detectCurrency(get('amount', 'earnings', 'total', 'paid', 'budget', 'price'));
  const externalId = get('id', 'contract id', 'order id', 'job id') || `${provider}-${index}-${sha(JSON.stringify(row)).slice(0, 12)}`;
  if (/paid|complete|closed|finished/.test(status)) {
    return { kind: 'payment', id: externalId, amount, currency, paidAt: occurredAt, clientName };
  }
  return {
    kind: 'opportunity', id: externalId, clientName, title, value: amount, currency,
    status: /active|open|in progress/.test(status) ? 'won' : /proposal|submitted|pending/.test(status) ? 'proposal_sent' : status || 'imported',
    proposalSentAt: /proposal|submitted|pending/.test(status) ? occurredAt : undefined
  };
}

function detectCurrency(value: string): string {
  if (value.includes('€')) return 'EUR';
  if (value.includes('£')) return 'GBP';
  if (value.includes('CHF')) return 'CHF';
  return 'USD';
}

function findOrCreateClient(db: Db, workspaceId: string, provider: string, name: string, contactName: string | undefined, email: string | undefined, now: string): { id: string } {
  const normalizedEmail = email?.toLowerCase();
  let existing: { id: string } | undefined;
  if (normalizedEmail) existing = db.prepare('SELECT client_id AS id FROM contact_identities WHERE workspace_id=? AND identity_value=?').get(workspaceId, normalizedEmail) as { id: string } | undefined;
  if (!existing) existing = db.prepare('SELECT id FROM clients WHERE workspace_id=? AND lower(name)=lower(?)').get(workspaceId, name) as { id: string } | undefined;
  if (existing) return existing;
  const clientId = id('cl');
  const safeEmail = normalizedEmail ?? `import-${sha(`${provider}:${name}`).slice(0, 12)}@trevra.invalid`;
  db.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(clientId, workspaceId, name, contactName ?? name, safeEmail, 'active', 0, 'EUR', now, now);
  db.prepare('INSERT OR IGNORE INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('ident'), workspaceId, clientId, provider, 'email', safeEmail, now);
  return { id: clientId };
}

function findOrCreateProject(db: Db, workspaceId: string, clientId: string, name: string, currency: string, now: string): string {
  const existing = db.prepare('SELECT id FROM projects WHERE workspace_id=? AND client_id=? AND lower(name)=lower(?)').get(workspaceId, clientId, name) as { id: string } | undefined;
  if (existing) return existing.id;
  const projectId = id('prj');
  db.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(projectId, workspaceId, clientId, name, 'active', 0, currency, now);
  return projectId;
}

function upsertSourceRecord(db: Db, workspaceId: string, connectionId: string | null, provider: string, objectType: string, externalId: string, externalUrl: string | null, payload: unknown, occurredAt: string): string {
  const payloadJson = JSON.stringify(payload);
  const contentHash = sha(payloadJson);
  const existing = db.prepare('SELECT id FROM source_records WHERE workspace_id=? AND provider=? AND object_type=? AND external_id=?')
    .get(workspaceId, provider, objectType, externalId) as { id: string } | undefined;
  const sourceId = existing?.id ?? id('src');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO source_records (id,workspace_id,connection_id,provider,object_type,external_id,external_url,content_hash,occurred_at,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,provider,object_type,external_id) DO UPDATE SET
      connection_id=excluded.connection_id,external_url=excluded.external_url,content_hash=excluded.content_hash,
      occurred_at=excluded.occurred_at,payload_json=excluded.payload_json,updated_at=excluded.updated_at
  `).run(sourceId, workspaceId, connectionId, provider, objectType, externalId, externalUrl, contentHash, occurredAt, payloadJson, now, now);
  return sourceId;
}

function recordWebhook(db: Db, provider: string, externalEventId: string, workspaceId: string | null, payloadHash: string): boolean {
  const result = db.prepare('INSERT OR IGNORE INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('webhook'), provider, externalEventId, workspaceId, payloadHash, 'received', new Date().toISOString());
  return result.changes > 0;
}

function completeWebhook(db: Db, provider: string, externalEventId: string, status: string, error: string | null, workspaceId: string | null): void {
  db.prepare('UPDATE webhook_events SET status=?,error=?,workspace_id=COALESCE(?,workspace_id),processed_at=? WHERE provider=? AND external_event_id=?')
    .run(status, error, workspaceId, new Date().toISOString(), provider, externalEventId);
}

function createMimeMessage(recipient: string, subject: string, body: string, idempotencyKey: string): string {
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
