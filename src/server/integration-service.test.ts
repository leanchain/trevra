import { afterEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  createConnectSession: vi.fn(async (_body: Record<string, unknown>) => ({
    data: { token: 'session-token', expires_at: '2030-01-01T00:00:00.000Z' }
  })),
  verifyIncomingWebhookRequest: vi.fn((_raw: string, _headers: Record<string, unknown>) => true),
  listRecords: vi.fn(async () => ({
    records: [] as Array<Record<string, unknown>>,
    next_cursor: null as string | null
  })),
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} })),
  post: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} }))
}));

const notificationMock = vi.hoisted(() => ({
  notifyIntegrationNeedsReauth: vi.fn(async () => undefined)
}));
vi.mock('./notifications.js', () => notificationMock);

vi.mock('@nangohq/node', () => ({
  Nango: class {
    createConnectSession = nangoMock.createConnectSession;
    verifyIncomingWebhookRequest = nangoMock.verifyIncomingWebhookRequest;
    listRecords = nangoMock.listRecords;
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

const { Db, id, openDatabase } = await import('./db.js');
const {
  createNangoConnectSession,
  defaultConnectSessionIntegrations,
  handleNangoWebhook,
  executeConnectedAction,
  ingestCanonicalRecord,
  listAvailableIntegrations,
  readConnectedEmailThreadEvents
} = await import('./integration-service.js');
const { createSuppression } = await import('./suppressions.js');

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
  'NANGO_API_KEY',
  'NANGO_HOST',
  'NANGO_PUBLIC_SERVER_URL',
  'NANGO_HUBSPOT_INTEGRATION',
  'NANGO_ATTIO_INTEGRATION',
  'NANGO_EXA_INTEGRATION',
  'NANGO_REDDIT_INTEGRATION',
  'NANGO_REDDIT_INTEGRATION',
  'NANGO_REDDIT_INTEGRATION'
];

let live: LiveDb | undefined;
const createdWorkspaces: string[] = [];

afterEach(async () => {
  for (const key of managedEnv) delete process.env[key];
  nangoMock.createConnectSession.mockClear();
  nangoMock.verifyIncomingWebhookRequest.mockClear();
  nangoMock.listRecords.mockClear();
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  nangoMock.post.mockReset();
  nangoMock.post.mockResolvedValue({ data: {}, headers: {} });
  notificationMock.notifyIntegrationNeedsReauth.mockClear();
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

/** A throwaway tenant with one GTM identity, torn down in afterEach. */
async function seedTenant(database: LiveDb): Promise<{ workspaceId: string }> {
  const now = new Date().toISOString();
  const workspaceId = id('ws');
  createdWorkspaces.push(workspaceId);
  await database
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, `Tenant ${workspaceId}`, now);
  return { workspaceId };
}

describe('integration catalog', () => {
  it('exposes CRM and prospecting sources with the right mode and category', async () => {
    const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
    const byProvider = new Map(integrations.map((item) => [item.provider, item]));

    expect(byProvider.get('hubspot')).toMatchObject({
      key: 'trevra-hubspot',
      name: 'HubSpot',
      category: 'crm',
      mode: 'oauth',
      connected: false
    });
    expect(byProvider.get('attio')).toMatchObject({
      key: 'trevra-attio',
      name: 'Attio',
      category: 'crm',
      mode: 'oauth',
      connected: false
    });
    expect(byProvider.get('exa')).toMatchObject({
      key: 'trevra-exa',
      name: 'Exa',
      category: 'data',
      mode: 'apiKey',
      connected: false
    });
    expect(byProvider.get('reddit')).toMatchObject({
      key: 'trevra-reddit',
      name: 'Reddit',
      category: 'data',
      mode: 'oauth',
      connected: false
    });
    expect(byProvider.get('reddit')).toMatchObject({
      key: 'trevra-reddit',
      name: 'Reddit',
      category: 'data',
      mode: 'oauth',
      connected: false
    });
    expect(byProvider.get('reddit')).toMatchObject({
      key: 'trevra-reddit',
      name: 'Reddit',
      category: 'data',
      mode: 'oauth',
      connected: false
    });
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

    expect(integrations.find((item) => item.provider === 'exa')).toMatchObject({
      key: 'acme-exa',
      connected: true
    });
    expect(integrations.find((item) => item.provider === 'hubspot')).toMatchObject({
      key: 'acme-hubspot',
      connected: false
    });
  });

  it('never exposes a credential on a catalog row', async () => {
    const integrations = await listAvailableIntegrations(stubDb(), 'ws_test');
    expect(integrations.length).toBeGreaterThan(0);
    for (const item of integrations) {
      expect(Object.keys(item).sort()).toEqual([
        'category',
        'connected',
        'description',
        'key',
        'mode',
        'name',
        'provider'
      ]);
    }
  });
});

describe('Nango connect sessions', () => {
  it('offers key-based integrations in the default allow-list', async () => {
    const allowed = defaultConnectSessionIntegrations();

    expect(allowed).toEqual(
      expect.arrayContaining([
        'trevra-exa',
        'trevra-reddit',
        'trevra-hubspot',
        'trevra-attio',
        'trevra-gmail'
      ])
    );
    expect(allowed).not.toEqual(expect.arrayContaining(['upwork', 'fiverr', 'contra']));
  });

  it('sends key-based integrations to Nango when the caller does not restrict the session', async () => {
    process.env.NANGO_API_KEY = 'test-nango-key';
    process.env.NANGO_PUBLIC_SERVER_URL = 'https://connect.example';

    const session = await createNangoConnectSession({
      workspaceId: 'ws_test',
      userId: 'usr_test',
      userEmail: 'operator@example.com',
      allowedIntegrations: []
    });

    expect(session).toMatchObject({
      token: 'session-token',
      browser_host: 'https://connect.example'
    });
    const body = nangoMock.createConnectSession.mock.calls[0]![0] as {
      allowed_integrations: string[];
    };
    expect(body.allowed_integrations).toEqual(
      expect.arrayContaining(['trevra-exa', 'trevra-hubspot', 'trevra-attio'])
    );
    expect(body.allowed_integrations).not.toEqual(expect.arrayContaining(['upwork']));
  });

  it('honours an explicit key-based allow-list', async () => {
    process.env.NANGO_API_KEY = 'test-nango-key';

    await createNangoConnectSession({
      workspaceId: 'ws_test',
      userId: 'usr_test',
      userEmail: 'operator@example.com',
      allowedIntegrations: ['trevra-exa']
    });

    const body = nangoMock.createConnectSession.mock.calls[0]![0] as {
      allowed_integrations: string[];
    };
    expect(body.allowed_integrations).toEqual(['trevra-exa']);
  });
});

describe('GTM canonical ingestion', () => {
  it('stores GTM messages and opportunities on canonical People', async () => {
    const database = await openLiveDatabase();
    const tenant = await seedTenant(database);
    const occurredAt = new Date().toISOString();

    await ingestCanonicalRecord(database, tenant.workspaceId, 'test', null, {
      kind: 'message',
      id: `msg-${id('x')}`,
      accountName: 'Prospect Co',
      personName: 'Ada Example',
      personEmail: 'ada@example.test',
      direction: 'inbound',
      subject: 'Demo request',
      body: 'Can we talk next week?',
      occurredAt
    });
    await ingestCanonicalRecord(database, tenant.workspaceId, 'test', null, {
      kind: 'opportunity',
      id: `opp-${id('x')}`,
      accountName: 'Prospect Co',
      personName: 'Ada Example',
      personEmail: 'ada@example.test',
      title: 'Demo follow-up',
      status: 'qualified',
      proposalSentAt: occurredAt
    });

    const canonicalPerson = await database
      .prepare(
        'SELECT id,name,email_normalized FROM contacts WHERE workspace_id=? AND email_normalized=?'
      )
      .get<{ id: string; name: string; email_normalized: string }>(
        tenant.workspaceId,
        'ada@example.test'
      );
    expect(canonicalPerson).toMatchObject({
      name: 'Ada Example',
      email_normalized: 'ada@example.test'
    });

    const identity = await database
      .prepare(
        'SELECT provider,identity_type,identity_value,person_id FROM person_identities WHERE workspace_id=? AND normalized_value=?'
      )
      .get<Record<string, unknown>>(tenant.workspaceId, 'ada@example.test');
    expect(identity).toMatchObject({
      provider: 'test',
      identity_type: 'email',
      identity_value: 'ada@example.test',
      person_id: canonicalPerson?.id
    });

    const message = await database
      .prepare(
        'SELECT direction,subject,body,person_id FROM messages WHERE workspace_id=? AND subject=?'
      )
      .get<Record<string, unknown>>(tenant.workspaceId, 'Demo request');
    expect(message).toEqual({
      direction: 'inbound',
      subject: 'Demo request',
      body: 'Can we talk next week?',
      person_id: canonicalPerson?.id
    });

    const opportunity = await database
      .prepare(
        'SELECT title,stage,proposal_sent_at,person_id FROM opportunities WHERE workspace_id=? AND title=?'
      )
      .get<Record<string, unknown>>(tenant.workspaceId, 'Demo follow-up');
    expect(opportunity).toMatchObject({
      title: 'Demo follow-up',
      stage: 'qualified',
      person_id: canonicalPerson?.id
    });
    expect(opportunity?.proposal_sent_at).toBeTruthy();

    const sourceRecords = await database
      .prepare(
        'SELECT object_type,provider FROM source_records WHERE workspace_id=? ORDER BY object_type'
      )
      .all<Record<string, unknown>>(tenant.workspaceId);
    expect(sourceRecords).toEqual([
      { object_type: 'message', provider: 'test' },
      { object_type: 'opportunity', provider: 'test' }
    ]);
  });
});

describe('connected mailbox threading', () => {
  async function mailbox(provider: 'gmail' | 'microsoft') {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';
    const tenant = await seedTenant(database);
    const connectionId = id('conn');
    await database
      .prepare(
        'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        connectionId,
        tenant.workspaceId,
        provider,
        `trevra-${provider}`,
        `${provider}-external`,
        `${provider}@example.test`,
        'connected',
        0,
        new Date().toISOString(),
        new Date().toISOString()
      );
    return { database, workspaceId: tenant.workspaceId, connectionId };
  }
  it('refuses a globally suppressed email before contacting the provider', async () => {
    const { database, workspaceId, connectionId } = await mailbox('gmail');
    await createSuppression(database, {
      workspaceId,
      channel: 'email',
      email: 'blocked@example.test',
      reason: 'Unsubscribed',
      source: 'test'
    });

    await expect(
      executeConnectedAction(database, workspaceId, {
        type: 'email_draft',
        connection_id: connectionId,
        recipient: 'BLOCKED@example.test',
        subject: 'Should not send',
        body: 'Blocked',
        structured_payload_json: '{}',
        payload_hash: 'blocked-key'
      })
    ).rejects.toThrow(/Unsubscribed/);
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('threads Gmail follow-ups with threadId and RFC reply headers', async () => {
    const { database, workspaceId, connectionId } = await mailbox('gmail');
    nangoMock.post
      .mockResolvedValueOnce({ data: { id: 'gmail-first', threadId: 'thread-1' }, headers: {} })
      .mockResolvedValueOnce({ data: { id: 'gmail-second', threadId: 'thread-1' }, headers: {} });
    nangoMock.get.mockResolvedValueOnce({ data: { threadId: 'thread-1' }, headers: {} });

    const first = await executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Same subject',
      body: 'First body',
      structured_payload_json: JSON.stringify({ threaded: true }),
      payload_hash: 'first-key'
    });
    expect(first).toEqual({ provider: 'gmail', externalRef: 'gmail-first' });

    const second = await executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Same subject',
      body: 'Second body',
      structured_payload_json: JSON.stringify({
        threaded: true,
        threadExternalRef: 'gmail-first',
        threadIdempotencyKey: 'first-key'
      }),
      payload_hash: 'second-key'
    });
    expect(second).toEqual({ provider: 'gmail', externalRef: 'gmail-second' });
    expect(nangoMock.get.mock.calls[0]?.[0]).toMatchObject({
      endpoint: '/gmail/v1/users/me/messages/gmail-first',
      params: { format: 'minimal' }
    });
    const secondSend = nangoMock.post.mock.calls[1]?.[0] as {
      data?: { raw?: string; threadId?: string };
    };
    expect(secondSend.data?.threadId).toBe('thread-1');
    const mime = Buffer.from(String(secondSend.data?.raw ?? ''), 'base64url').toString('utf8');
    expect(mime).toContain('In-Reply-To: <first-key@trevra.app>');
    expect(mime).toContain('References: <first-key@trevra.app>');
    expect(mime).toContain('Message-ID: <second-key@trevra.app>');
  });

  it('sends an HTML alternative through Gmail when campaign tracking prepared one', async () => {
    const { database, workspaceId, connectionId } = await mailbox('gmail');
    nangoMock.post.mockResolvedValueOnce({
      data: { id: 'gmail-html', threadId: 'thread-html' },
      headers: {}
    });
    await executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Tracked',
      body: 'Read https://example.test/demo',
      structured_payload_json: JSON.stringify({
        threaded: false,
        htmlBody:
          'Read <a href="https://trevra.test/t/e/open/c/link">https://example.test/demo</a><img src="https://trevra.test/t/e/open/open.gif" />'
      }),
      payload_hash: 'html-key'
    });
    const send = nangoMock.post.mock.calls[0]?.[0] as { data?: { raw?: string } };
    const mime = Buffer.from(String(send.data?.raw ?? ''), 'base64url').toString('utf8');
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
    expect(mime).toContain('https://trevra.test/t/e/open/open.gif');
  });

  it('reads Gmail thread replies and delivery failures as idempotent provider events', async () => {
    const { database, workspaceId, connectionId } = await mailbox('gmail');
    nangoMock.get
      .mockResolvedValueOnce({ data: { threadId: 'thread-telemetry' }, headers: {} })
      .mockResolvedValueOnce({
        data: {
          messages: [
            { id: 'gmail-sent', internalDate: '1787216400000', payload: { headers: [] } },
            {
              id: 'gmail-reply',
              internalDate: '1787216460000',
              payload: {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Interested — Friday works.').toString('base64url') },
                headers: [
                  { name: 'From', value: 'Lead <lead@example.test>' },
                  { name: 'Subject', value: 'Re: hello' }
                ]
              }
            },
            {
              id: 'gmail-bounce',
              internalDate: '1787216520000',
              payload: {
                headers: [
                  { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
                  { name: 'Subject', value: 'Delivery Status Notification (Failure)' }
                ]
              }
            }
          ]
        },
        headers: {}
      });

    const events = await readConnectedEmailThreadEvents(database, workspaceId, {
      localConnectionId: connectionId,
      externalRef: 'gmail-sent',
      recipient: 'lead@example.test'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reply',
          providerEventId: 'gmail:gmail-reply',
          body: 'Interested — Friday works.',
          subject: 'Re: hello',
          sender: 'lead@example.test'
        }),
        expect.objectContaining({
          kind: 'delivery_failure',
          providerEventId: 'gmail:gmail-bounce'
        })
      ])
    );
  });

  it('threads Microsoft follow-ups through Graph reply drafts', async () => {
    const { database, workspaceId, connectionId } = await mailbox('microsoft');
    nangoMock.post
      .mockResolvedValueOnce({ data: { id: 'ms-first' }, headers: {} })
      .mockResolvedValueOnce({ data: {}, headers: {} })
      .mockResolvedValueOnce({ data: { id: 'ms-reply' }, headers: {} })
      .mockResolvedValueOnce({ data: {}, headers: {} });

    const first = await executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Same subject',
      body: 'First body',
      structured_payload_json: JSON.stringify({ threaded: true }),
      payload_hash: 'ms-first-key'
    });
    expect(first).toEqual({ provider: 'microsoft', externalRef: 'ms-first' });
    expect(nangoMock.post.mock.calls[0]?.[0]).toMatchObject({ endpoint: '/v1.0/me/messages' });
    expect(nangoMock.post.mock.calls[1]?.[0]).toMatchObject({
      endpoint: '/v1.0/me/messages/ms-first/send'
    });

    const second = await executeConnectedAction(database, workspaceId, {
      type: 'email_draft',
      connection_id: connectionId,
      recipient: 'lead@example.test',
      subject: 'Same subject',
      body: 'Second body',
      structured_payload_json: JSON.stringify({
        threaded: true,
        threadExternalRef: 'ms-first',
        threadIdempotencyKey: 'ms-first-key'
      }),
      payload_hash: 'ms-second-key'
    });
    expect(second).toEqual({ provider: 'microsoft', externalRef: 'ms-reply' });
    expect(nangoMock.post.mock.calls[2]?.[0]).toMatchObject({
      endpoint: '/v1.0/me/messages/ms-first/createReply',
      data: { message: { body: { contentType: 'Text', content: 'Second body' } } }
    });
    expect(nangoMock.post.mock.calls[3]?.[0]).toMatchObject({
      endpoint: '/v1.0/me/messages/ms-reply/send'
    });
  });

  it('reads Microsoft conversation replies and NDRs as provider events', async () => {
    const { database, workspaceId, connectionId } = await mailbox('microsoft');
    nangoMock.get
      .mockResolvedValueOnce({ data: { conversationId: 'conv-1' }, headers: {} })
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              id: 'ms-reply-event',
              receivedDateTime: '2026-08-20T09:02:00.000Z',
              subject: 'RE: hello',
              from: { emailAddress: { address: 'lead@example.test', name: 'Lead' } },
              body: { contentType: 'HTML', content: '<p>Yes, Friday works.</p>' }
            },
            {
              id: 'ms-ndr-event',
              receivedDateTime: '2026-08-20T09:03:00.000Z',
              subject: 'Undeliverable: hello',
              from: {
                emailAddress: { address: 'postmaster@example.test', name: 'Microsoft Outlook' }
              }
            }
          ]
        },
        headers: {}
      });

    const events = await readConnectedEmailThreadEvents(database, workspaceId, {
      localConnectionId: connectionId,
      externalRef: 'ms-sent',
      recipient: 'lead@example.test'
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reply',
          providerEventId: 'microsoft:ms-reply-event',
          body: 'Yes, Friday works.',
          subject: 'RE: hello',
          sender: 'lead@example.test'
        }),
        expect.objectContaining({
          kind: 'delivery_failure',
          providerEventId: 'microsoft:ms-ndr-event'
        })
      ])
    );
  });
});

describe('Nango sync tenancy', () => {
  it('refuses a sync whose connection exists in more than one workspace', async () => {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';

    const providerConfigKey = 'trevra-gmail';
    const externalConnectionId = `conn-${id('dup')}`;
    const now = new Date().toISOString();
    // Legal rows: `connections` is UNIQUE(workspace_id, provider_config_key,
    // external_connection_id), so the same pair in two tenants violates nothing.
    for (const _ of [0, 1]) {
      const tenant = await seedTenant(database);
      await database
        .prepare(
          'INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id('conn'),
          tenant.workspaceId,
          'gmail',
          providerConfigKey,
          externalConnectionId,
          null,
          'connected',
          0,
          now,
          now
        );
    }

    const payload = JSON.stringify({
      id: `nango_${id('evt')}`,
      type: 'sync',
      success: true,
      providerConfigKey,
      connectionId: externalConnectionId,
      model: 'trevra-messages'
    });

    await expect(handleNangoWebhook(database, payload, {})).rejects.toThrow(
      /registered in 2 workspaces/
    );
    // Nothing was fetched, so nothing could have been filed under the wrong tenant.
    expect(nangoMock.listRecords).not.toHaveBeenCalled();

    const audit = await database
      .prepare(
        'SELECT status,workspace_id FROM webhook_events WHERE provider=? AND external_event_id=?'
      )
      .get<{ status: string; workspace_id: string | null }>('nango', JSON.parse(payload).id);
    expect(audit?.status).toBe('failed');
    expect(audit?.workspace_id).toBeNull();
  });
});

describe('Nango authorization notifications', () => {
  it('alerts once per transition into needs_reauth and alerts again after a successful reconnect', async () => {
    const database = await openLiveDatabase();
    process.env.NANGO_API_KEY = 'test-nango-key';
    const tenant = await seedTenant(database);
    const providerConfigKey = 'trevra-gmail';
    const connectionId = `gmail-${id('conn')}`;

    const authEvent = (eventId: string, success: boolean) =>
      JSON.stringify({
        id: eventId,
        type: 'auth',
        success,
        provider: 'gmail',
        providerConfigKey,
        connectionId,
        error: success ? undefined : 'Authorization expired',
        tags: { organization_id: tenant.workspaceId, end_user_email: 'owner@example.test' }
      });

    expect(await handleNangoWebhook(database, authEvent(`evt-${id('reauth')}`, false), {})).toEqual(
      { duplicate: false, processed: 'connection-needs-reauth' }
    );
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledTimes(1);

    expect(await handleNangoWebhook(database, authEvent(`evt-${id('reauth')}`, false), {})).toEqual(
      { duplicate: false, processed: 'connection-needs-reauth' }
    );
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledTimes(1);

    expect(await handleNangoWebhook(database, authEvent(`evt-${id('reauth')}`, true), {})).toEqual({
      duplicate: false,
      processed: 'connection-upserted'
    });

    expect(await handleNangoWebhook(database, authEvent(`evt-${id('reauth')}`, false), {})).toEqual(
      { duplicate: false, processed: 'connection-needs-reauth' }
    );
    expect(notificationMock.notifyIntegrationNeedsReauth).toHaveBeenCalledTimes(2);
  });
});
