import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const nangoMock = vi.hoisted(() => ({
  createConnectSession: vi.fn(async (_body: Record<string, unknown>) => ({ data: { token: 'session-token', expires_at: '2030-01-01T00:00:00.000Z' } })),
  verifyIncomingWebhookRequest: vi.fn((_raw: string, _headers: Record<string, unknown>) => true),
  listRecords: vi.fn(async () => ({ records: [] as Array<Record<string, unknown>>, next_cursor: null as string | null }))
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    createConnectSession = nangoMock.createConnectSession;
    verifyIncomingWebhookRequest = nangoMock.verifyIncomingWebhookRequest;
    listRecords = nangoMock.listRecords;
  }
}));

const { Db, id, openDatabase } = await import('./db.js');
const {
  createNangoConnectSession, defaultConnectSessionIntegrations, handleNangoWebhook,
  ingestCanonicalRecord, listAvailableIntegrations, processStripeWebhook, recordOutcome
} = await import('./integration-service.js');

type DbQueryable = ConstructorParameters<typeof Db>[0];
type LiveDb = InstanceType<typeof Db>;

function stubDb(connectedKeys: string[] = []): InstanceType<typeof Db> {
  return new Db({
    query: async () => ({
      rows: connectedKeys.map((provider_config_key) => ({ provider_config_key })),
      rowCount: connectedKeys.length
    })
  } as unknown as DbQueryable);
}

const managedEnv = [
  'NANGO_API_KEY', 'NANGO_HOST', 'NANGO_PUBLIC_SERVER_URL',
  'NANGO_HUBSPOT_INTEGRATION', 'NANGO_ATTIO_INTEGRATION', 'NANGO_EXA_INTEGRATION', 'NANGO_REDDIT_INTEGRATION', 'NANGO_REDDIT_INTEGRATION', 'NANGO_REDDIT_INTEGRATION'
];

let live: LiveDb | undefined;
const createdWorkspaces: string[] = [];

afterEach(async () => {
  for (const key of managedEnv) delete process.env[key];
  delete process.env.STRIPE_WEBHOOK_SECRET;
  nangoMock.createConnectSession.mockClear();
  nangoMock.verifyIncomingWebhookRequest.mockClear();
  nangoMock.listRecords.mockClear();
  if (live) {
    for (const workspaceId of createdWorkspaces.splice(0)) {
      await live.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
    await live.close();
    live = undefined;
  }
});

async function openLiveDatabase(): Promise<LiveDb> {
  live = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  return live;
}

/** A throwaway tenant with one client and one unpaid invoice, torn down in afterEach. */
async function seedTenant(database: LiveDb, externalRef: string): Promise<{ workspaceId: string; clientId: string; invoiceId: string }> {
  const now = new Date().toISOString();
  const workspaceId = id('ws');
  const clientId = id('cl');
  const invoiceId = id('inv');
  createdWorkspaces.push(workspaceId);
  await database.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, `Tenant ${workspaceId}`, now);
  await database.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(clientId, workspaceId, 'Client', 'Contact', `${clientId}@example.test`, 'active', 0, 'EUR', now, now);
  await database.prepare('INSERT INTO invoices (id,workspace_id,client_id,external_ref,amount,currency,status,issued_at,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(invoiceId, workspaceId, clientId, externalRef, 1000, 'EUR', 'sent', now, now, now);
  return { workspaceId, clientId, invoiceId };
}

/**
 * A genuinely signed Stripe event.
 *
 * The whole point of the attack these tests describe is that the signature is
 * REAL: `STRIPE_WEBHOOK_SECRET` is one deployment-wide secret, so anyone able to
 * put an object in the deployment's Stripe account produces events that pass
 * `constructEvent`. Forging the signature is not required and is not simulated.
 */
function signedStripeEvent(secret: string, event: Record<string, unknown>): { body: Buffer; signature: string } {
  const payload = JSON.stringify(event);
  const signature = new Stripe('sk_test_placeholder').webhooks.generateTestHeaderString({ payload, secret });
  return { body: Buffer.from(payload, 'utf8'), signature };
}

function invoicePaidEvent(input: { eventId: string; number: string; metadata: Record<string, string> }): Record<string, unknown> {
  return {
    id: input.eventId,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_${input.eventId}`,
        object: 'invoice',
        number: input.number,
        currency: 'eur',
        amount_paid: 100_000,
        status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        metadata: input.metadata
      }
    }
  };
}

describe('integration catalog', () => {
  it('exposes CRM and prospecting sources with the right mode and category', async () => {
    const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
    const byProvider = new Map(integrations.map((item) => [item.provider, item]));

    expect(byProvider.get('hubspot')).toMatchObject({ key: 'trevra-hubspot', name: 'HubSpot', category: 'crm', mode: 'oauth', connected: false });
    expect(byProvider.get('attio')).toMatchObject({ key: 'trevra-attio', name: 'Attio', category: 'crm', mode: 'oauth', connected: false });
    expect(byProvider.get('exa')).toMatchObject({ key: 'trevra-exa', name: 'Exa', category: 'data', mode: 'apiKey', connected: false });
    expect(byProvider.get('reddit')).toMatchObject({ key: 'trevra-reddit', name: 'Reddit', category: 'data', mode: 'oauth', connected: false });
    expect(byProvider.get('reddit')).toMatchObject({ key: 'trevra-reddit', name: 'Reddit', category: 'data', mode: 'oauth', connected: false });
    expect(byProvider.get('reddit')).toMatchObject({ key: 'trevra-reddit', name: 'Reddit', category: 'data', mode: 'oauth', connected: false });
  });

  // Apollo's terms forbid integrating their API with another product, so the catalog must not offer
  // it however convenient Nango's `apollo` provider config makes it. Asserted, not just commented,
  // because the next person to add a data source will reach for Apollo first.
  it('does not offer Apollo', async () => {
    const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
    expect(integrations.map((item) => item.provider)).not.toContain('apollo');
  });

  it('resolves a key-based integration id from the environment exactly like an OAuth one', async () => {
    process.env.NANGO_EXA_INTEGRATION = 'acme-exa';
    process.env.NANGO_HUBSPOT_INTEGRATION = 'acme-hubspot';
    const integrations = await listAvailableIntegrations(stubDb(['acme-exa']), 'ws_test');

    expect(integrations.find((item) => item.provider === 'exa')).toMatchObject({ key: 'acme-exa', connected: true });
    expect(integrations.find((item) => item.provider === 'hubspot')).toMatchObject({ key: 'acme-hubspot', connected: false });
  });

  it('never exposes a credential on a catalog row', async () => {
    const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
    expect(integrations.length).toBeGreaterThan(0);
    for (const item of integrations) {
      expect(Object.keys(item).sort()).toEqual(['category', 'connected', 'description', 'key', 'mode', 'name', 'provider']);
    }
  });
});

describe('Nango connect sessions', () => {
  it('offers key-based integrations in the default allow-list', async () => {
    const allowed = defaultConnectSessionIntegrations();

    expect(allowed).toEqual(expect.arrayContaining(['trevra-exa', 'trevra-reddit', 'trevra-hubspot', 'trevra-attio', 'trevra-gmail']));
    expect(allowed).not.toEqual(expect.arrayContaining(['upwork', 'fiverr', 'contra']));
  });

  it('sends key-based integrations to Nango when the caller does not restrict the session', async () => {
    process.env.NANGO_API_KEY = 'test-nango-key';
    process.env.NANGO_PUBLIC_SERVER_URL = 'https://connect.example';

    const session = await createNangoConnectSession({
      workspaceId: 'ws_test', userId: 'usr_test', userEmail: 'operator@example.com', allowedIntegrations: []
    });

    expect(session).toMatchObject({ token: 'session-token', browser_host: 'https://connect.example' });
    const body = nangoMock.createConnectSession.mock.calls[0]![0] as { allowed_integrations: string[] };
    expect(body.allowed_integrations).toEqual(expect.arrayContaining(['trevra-exa', 'trevra-hubspot', 'trevra-attio']));
    expect(body.allowed_integrations).not.toEqual(expect.arrayContaining(['upwork']));
  });

  it('honours an explicit key-based allow-list', async () => {
    process.env.NANGO_API_KEY = 'test-nango-key';

    await createNangoConnectSession({
      workspaceId: 'ws_test', userId: 'usr_test', userEmail: 'operator@example.com', allowedIntegrations: ['trevra-exa']
    });

    const body = nangoMock.createConnectSession.mock.calls[0]![0] as { allowed_integrations: string[] };
    expect(body.allowed_integrations).toEqual(['trevra-exa']);
  });
});

/**
 * These are the attacks, written as tests.
 *
 * Both used to succeed. Neither needs stolen credentials, a forged signature, or
 * anything beyond what a normal tenant of a hosted deployment already holds.
 */
describe('Stripe webhook tenancy', () => {
  it('refuses to touch a victim invoice named only by attacker-controlled metadata', async () => {
    const database = await openLiveDatabase();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_tenancy_checks';

    const victim = await seedTenant(database, 'INV-VICTIM-1');
    const attacker = await seedTenant(database, 'INV-ATTACKER-1');

    // The attacker's own Stripe invoice, paid for real, carrying metadata that
    // points at the victim's workspace and the victim's invoice row.
    const { body, signature } = signedStripeEvent(process.env.STRIPE_WEBHOOK_SECRET, invoicePaidEvent({
      eventId: `evt_${id('atk')}`,
      number: 'INV-ATTACKER-1',
      metadata: { trevra_workspace_id: victim.workspaceId, trevra_invoice_id: victim.invoiceId }
    }));

    const result = await processStripeWebhook(database, body, signature);
    expect(result).toEqual({ duplicate: false, processed: 'rejected' });

    const victimInvoice = await database.prepare('SELECT status,paid_at FROM invoices WHERE id=?')
      .get<{ status: string; paid_at: string | null }>(victim.invoiceId);
    expect(victimInvoice?.status).toBe('sent');
    expect(victimInvoice?.paid_at).toBeNull();

    const payments = await database.prepare('SELECT COUNT(*)::int AS total FROM payments WHERE workspace_id=?')
      .get<{ total: number }>(victim.workspaceId);
    expect(payments?.total).toBe(0);

    // The attacker's own invoice is not paid either: the event was refused, not redirected.
    const attackerInvoice = await database.prepare('SELECT status FROM invoices WHERE id=?').get<{ status: string }>(attacker.invoiceId);
    expect(attackerInvoice?.status).toBe('sent');

    const audit = await database.prepare('SELECT status,error FROM webhook_events WHERE provider=? AND external_event_id=?')
      .get<{ status: string; error: string | null }>('stripe', JSON.parse(body.toString('utf8')).id);
    expect(audit?.status).toBe('rejected');
    expect(audit?.error).toContain('metadata claims workspace');
  });

  it('pays the invoice the stored records actually resolve to, with no metadata at all', async () => {
    const database = await openLiveDatabase();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_tenancy_checks';

    const owner = await seedTenant(database, 'INV-OWNER-1');
    const { body, signature } = signedStripeEvent(process.env.STRIPE_WEBHOOK_SECRET, invoicePaidEvent({
      eventId: `evt_${id('ok')}`, number: 'INV-OWNER-1', metadata: {}
    }));

    expect(await processStripeWebhook(database, body, signature)).toEqual({ duplicate: false, processed: 'invoice-paid' });

    const paid = await database.prepare('SELECT status,paid_at FROM invoices WHERE id=?')
      .get<{ status: string; paid_at: string | null }>(owner.invoiceId);
    expect(paid?.status).toBe('paid');
    expect(paid?.paid_at).not.toBeNull();

    const payment = await database.prepare('SELECT amount,workspace_id FROM payments WHERE workspace_id=?')
      .get<{ amount: number; workspace_id: string }>(owner.workspaceId);
    expect(payment?.amount).toBe(1000);
  });

  // The regression `app.test.ts` caught: 058 keys idempotency on the workspace,
  // so recording an event unattributed and then resolving it vacated the
  // `@unresolved` slot and the next redelivery was processed all over again.
  it('treats a redelivery of an already-processed event as a duplicate', async () => {
    const database = await openLiveDatabase();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_tenancy_checks';

    const owner = await seedTenant(database, 'INV-REDELIVERED-1');
    const { body, signature } = signedStripeEvent(process.env.STRIPE_WEBHOOK_SECRET, invoicePaidEvent({
      eventId: `evt_${id('dup')}`, number: 'INV-REDELIVERED-1', metadata: {}
    }));

    expect(await processStripeWebhook(database, body, signature)).toEqual({ duplicate: false, processed: 'invoice-paid' });
    expect(await processStripeWebhook(database, body, signature)).toEqual({ duplicate: true, processed: 'duplicate' });

    const rows = await database.prepare('SELECT COUNT(*)::int AS total FROM webhook_events WHERE provider=? AND external_event_id=?')
      .get<{ total: number }>('stripe', JSON.parse(body.toString('utf8')).id);
    expect(rows?.total).toBe(1);
    const payments = await database.prepare('SELECT COUNT(*)::int AS total FROM payments WHERE workspace_id=?')
      .get<{ total: number }>(owner.workspaceId);
    expect(payments?.total).toBe(1);
  });

  it('refuses when the same external reference exists in two workspaces', async () => {
    const database = await openLiveDatabase();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_tenancy_checks';

    const first = await seedTenant(database, 'INV-SHARED-1');
    const second = await seedTenant(database, 'INV-SHARED-1');
    const { body, signature } = signedStripeEvent(process.env.STRIPE_WEBHOOK_SECRET, invoicePaidEvent({
      eventId: `evt_${id('amb')}`, number: 'INV-SHARED-1', metadata: {}
    }));

    expect(await processStripeWebhook(database, body, signature)).toEqual({ duplicate: false, processed: 'rejected' });
    for (const tenant of [first, second]) {
      const row = await database.prepare('SELECT status FROM invoices WHERE id=?').get<{ status: string }>(tenant.invoiceId);
      expect(row?.status).toBe('sent');
    }
  });
});

describe('child rows carry their parent workspace', () => {
  // Migration 058 added `workspace_id` to ten tables that were reachable only
  // through a parent id, and left it nullable because writers like this one
  // were not filling it. Until they do, `SET NOT NULL` cannot land and every
  // read of these rows still depends on remembering a join.
  it('stamps milestones, scope items and contract clauses from their parent', async () => {
    const database = await openLiveDatabase();
    const tenant = await seedTenant(database, 'INV-CHILD-1');
    const occurredAt = new Date().toISOString();

    await ingestCanonicalRecord(database, tenant.workspaceId, 'bonsai', null, {
      kind: 'contract', id: `ct-${id('x')}`, clientName: 'Child Co', projectName: 'Child project',
      title: 'Statement of work', status: 'signed', signedAt: occurredAt, effectiveAt: occurredAt,
      clauses: [{ type: 'change_order', title: 'Extra pages', content: 'Priced separately.', value: 750, unit: 'per page' }]
    });
    await ingestCanonicalRecord(database, tenant.workspaceId, 'bonsai', null, {
      kind: 'milestone', id: `ms-${id('x')}`, clientName: 'Child Co', projectName: 'Child project',
      name: 'Phase one', amount: 500, currency: 'EUR', status: 'delivered', deliveredAt: occurredAt
    });
    await ingestCanonicalRecord(database, tenant.workspaceId, 'bonsai', null, {
      kind: 'scope_item', id: `sc-${id('x')}`, clientName: 'Child Co', projectName: 'Child project',
      description: 'One landing page', included: true, currency: 'EUR'
    });

    for (const table of ['milestones', 'scope_items', 'contract_clauses']) {
      const rows = await database.prepare(`SELECT workspace_id FROM ${table} WHERE workspace_id=?`)
        .all<{ workspace_id: string }>(tenant.workspaceId);
      expect(rows.length, `${table} rows stamped with the parent workspace`).toBe(1);
    }
  });

  it('takes the outcome workspace from the recommendation, not from the caller', async () => {
    const database = await openLiveDatabase();
    const tenant = await seedTenant(database, 'INV-OUTCOME-1');
    const recommendationId = id('rec');
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO recommendations (id,workspace_id,client_id,source_key,type,title,summary,estimated_amount,currency,confidence,urgency,priority_score,status,recommended_action,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(recommendationId, tenant.workspaceId, tenant.clientId, `invoice:${tenant.invoiceId}:overdue`, 'overdue_invoice', 'Chase invoice', 'It is late.', 1000, 'EUR', 0.9, 0.5, 0.7, 'open', 'prepare', now, now);

    await recordOutcome(database, tenant.workspaceId, recommendationId, 'revenue_collected', 1000, 'EUR', {});

    const outcome = await database.prepare('SELECT workspace_id FROM recommendation_outcomes WHERE recommendation_id=?')
      .get<{ workspace_id: string | null }>(recommendationId);
    expect(outcome?.workspace_id).toBe(tenant.workspaceId);
  });

  it('refuses an outcome against a recommendation in another workspace', async () => {
    const database = await openLiveDatabase();
    const owner = await seedTenant(database, 'INV-OWNER-2');
    const intruder = await seedTenant(database, 'INV-INTRUDER-2');
    const recommendationId = id('rec');
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO recommendations (id,workspace_id,client_id,source_key,type,title,summary,estimated_amount,currency,confidence,urgency,priority_score,status,recommended_action,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(recommendationId, owner.workspaceId, owner.clientId, `invoice:${owner.invoiceId}:overdue`, 'overdue_invoice', 'Chase invoice', 'It is late.', 1000, 'EUR', 0.9, 0.5, 0.7, 'open', 'prepare', now, now);

    await expect(recordOutcome(database, intruder.workspaceId, recommendationId, 'revenue_collected', 1000, 'EUR', {}))
      .rejects.toThrow('does not belong to this workspace');
    const outcomes = await database.prepare('SELECT COUNT(*)::int AS total FROM recommendation_outcomes WHERE recommendation_id=?')
      .get<{ total: number }>(recommendationId);
    expect(outcomes?.total).toBe(0);
  });
});

describe('Nango sync tenancy', () => {
  it('refuses a sync whose connection exists in more than one workspace', async () => {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';

    const providerConfigKey = 'trevra-stripe';
    const externalConnectionId = `conn-${id('dup')}`;
    const now = new Date().toISOString();
    // Legal rows: `connections` is UNIQUE(workspace_id, provider_config_key,
    // external_connection_id), so the same pair in two tenants violates nothing.
    for (const externalRef of ['INV-A', 'INV-B']) {
      const tenant = await seedTenant(database, externalRef);
      await database.prepare('INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id('conn'), tenant.workspaceId, 'stripe', providerConfigKey, externalConnectionId, null, 'connected', 0, now, now);
    }

    const payload = JSON.stringify({
      id: `nango_${id('evt')}`, type: 'sync', success: true,
      providerConfigKey, connectionId: externalConnectionId, model: 'trevra-invoices'
    });

    await expect(handleNangoWebhook(database, payload, {})).rejects.toThrow(/registered in 2 workspaces/);
    // Nothing was fetched, so nothing could have been filed under the wrong tenant.
    expect(nangoMock.listRecords).not.toHaveBeenCalled();

    const audit = await database.prepare('SELECT status,workspace_id FROM webhook_events WHERE provider=? AND external_event_id=?')
      .get<{ status: string; workspace_id: string | null }>('nango', JSON.parse(payload).id);
    expect(audit?.status).toBe('failed');
    expect(audit?.workspace_id).toBeNull();
  });
});
