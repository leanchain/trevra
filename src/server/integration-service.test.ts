import { afterEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  createConnectSession: vi.fn(async (_body: Record<string, unknown>) => ({ data: { token: 'session-token', expires_at: '2030-01-01T00:00:00.000Z' } }))
}));

vi.mock('@nangohq/node', () => ({
  Nango: class {
    createConnectSession = nangoMock.createConnectSession;
  }
}));

const { Db } = await import('./db.js');
const { createNangoConnectSession, defaultConnectSessionIntegrations, listAvailableIntegrations } = await import('./integration-service.js');

type DbQueryable = ConstructorParameters<typeof Db>[0];

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

afterEach(() => {
  for (const key of managedEnv) delete process.env[key];
  nangoMock.createConnectSession.mockClear();
});

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
