import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../db.js';
import { logCrmActivity, resolveLocalContact, type CrmActivityPayload } from './activity.js';
import { getCrmAdapter, listCrmAdapters } from './registry.js';
import type { CrmProxy } from './types.js';

let db: Db;
const NOW = new Date('2026-08-03T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

/** Records every CRM call, so "did we touch their CRM" is directly assertable. */
function stubProxy(routes: Record<string, unknown>): { proxy: CrmProxy; calls: Array<{ endpoint: string; data: unknown }> } {
  const calls: Array<{ endpoint: string; data: unknown }> = [];
  const proxy: CrmProxy = {
    async post<T>(endpoint: string, data: unknown): Promise<T> {
      calls.push({ endpoint, data });
      const match = Object.keys(routes).find((key) => endpoint.includes(key));
      if (!match) throw new Error(`unexpected endpoint ${endpoint}`);
      const value = routes[match];
      if (value instanceof Error) throw value;
      return value as T;
    },
    async get<T>(): Promise<T> {
      throw new Error('not used');
    }
  };
  return { proxy, calls };
}

async function connectCrm(provider: 'hubspot' | 'attio' = 'hubspot'): Promise<void> {
  await db.prepare(`
    INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id('conn'), DEMO_WORKSPACE_ID, provider, `trevra-${provider}`, `ext-${provider}`, 'Sales CRM', 'connected', 0, NOW.toISOString(), NOW.toISOString());
}

function payload(overrides: Partial<CrmActivityPayload> = {}): CrmActivityPayload {
  return {
    contact: { email: 'maya@acme.example', handle: null, handleProvider: null, domain: null },
    activityType: 'community_reply',
    subject: 'Replied on github: acme/acme#412',
    body: 'Answered their token-cost question.',
    url: 'https://github.com/acme/acme/issues/412',
    occurredAt: NOW.toISOString(),
    sourceType: 'outreach_post',
    sourceId: 'opst_1',
    ...overrides
  };
}

const HUBSPOT_FOUND = { results: [{ id: '551', properties: { email: 'maya@acme.example', firstname: 'Maya', lastname: 'Chen' } }] };

describe('adapter contract', () => {
  it('every registered adapter declares exactly what it can write', () => {
    expect(listCrmAdapters().map((adapter) => adapter.key)).toEqual(['attio', 'hubspot']);
    for (const adapter of listCrmAdapters()) {
      expect(adapter.writes.length).toBeGreaterThan(0);
      // The promise on the connect screen: notes only, on records that exist.
      expect(adapter.writes.join(' ')).toMatch(/note/);
      expect(adapter.docsUrl).toMatch(/^https:/);
    }
  });

  it('refuses to look a contact up by anything but an email', async () => {
    const { proxy, calls } = stubProxy({});
    // A GitHub handle must never become a CRM search: it would miss, or worse,
    // fuzzy-match a different person and attach outreach to their record.
    for (const adapter of listCrmAdapters()) {
      const found = await adapter.findContact({ handle: 'maya-acme', handleProvider: 'github', email: null }, proxy);
      expect(found).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('maps a HubSpot search hit to a contact reference', async () => {
    const { proxy } = stubProxy({ '/contacts/search': HUBSPOT_FOUND });
    const found = await getCrmAdapter('hubspot')!.findContact({ email: 'maya@acme.example' }, proxy);
    expect(found).toEqual({ externalId: '551', label: 'Maya Chen' });
  });

  it('maps an Attio query hit to a contact reference', async () => {
    const { proxy } = stubProxy({
      '/records/query': { data: [{ id: { record_id: 'rec_9' }, values: { name: [{ full_name: 'Maya Chen' }] } }] }
    });
    const found = await getCrmAdapter('attio')!.findContact({ email: 'maya@acme.example' }, proxy);
    expect(found).toEqual({ externalId: 'rec_9', label: 'Maya Chen' });
  });

  it('associates the HubSpot note with the contact and escapes the body', async () => {
    const { proxy, calls } = stubProxy({ '/contacts/search': HUBSPOT_FOUND, '/objects/notes': { id: 'note_1' } });
    const adapter = getCrmAdapter('hubspot')!;
    const ref = await adapter.findContact({ email: 'maya@acme.example' }, proxy);
    const noteId = await adapter.logActivity(ref!, { subject: 'S', body: '<script>x</script>\nline two', url: 'https://e.test/1', occurredAt: NOW.toISOString() }, proxy);

    expect(noteId).toBe('note_1');
    const note = calls.at(-1)!.data as { properties: { hs_note_body: string }; associations: Array<{ to: { id: string } }> };
    expect(note.associations[0].to.id).toBe('551');
    expect(note.properties.hs_note_body).not.toContain('<script>');
    expect(note.properties.hs_note_body).toContain('&lt;script&gt;');
    expect(note.properties.hs_note_body).toContain('<br>');
  });
});

describe('contact resolution', () => {
  it('resolves a platform handle to a client through contact_identities', async () => {
    await db.prepare('INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id('ident'), DEMO_WORKSPACE_ID, 'cl_acme', 'github', 'handle', 'Maya-Acme', NOW.toISOString());

    // Case-insensitive: platforms are inconsistent about handle casing.
    const resolved = await resolveLocalContact(db, DEMO_WORKSPACE_ID, { handle: 'maya-acme', handleProvider: 'github' });
    expect(resolved.clientId).toBe('cl_acme');
    expect(resolved.email).toBe('maya@acme.example');
  });

  it('does not resolve a handle registered under a different platform', async () => {
    await db.prepare('INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id('ident'), DEMO_WORKSPACE_ID, 'cl_acme', 'github', 'handle', 'maya-acme', NOW.toISOString());
    const resolved = await resolveLocalContact(db, DEMO_WORKSPACE_ID, { handle: 'maya-acme', handleProvider: 'reddit' });
    expect(resolved.clientId).toBeNull();
  });

  it('returns nothing when there is no identity to go on', async () => {
    expect(await resolveLocalContact(db, DEMO_WORKSPACE_ID, { handle: 'stranger', handleProvider: 'github' }))
      .toEqual({ clientId: null, email: null });
  });
});

describe('logCrmActivity', () => {
  it('skips silently when no CRM is connected', async () => {
    const result = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW);
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/No CRM is connected/);
  });

  it('writes a note and records it', async () => {
    await connectCrm('hubspot');
    const { proxy, calls } = stubProxy({ '/contacts/search': HUBSPOT_FOUND, '/objects/notes': { id: 'note_7' } });

    const result = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, { proxyFor: () => proxy });

    expect(result).toMatchObject({ status: 'written', provider: 'hubspot', externalRef: 'note_7' });
    expect(calls.map((call) => call.endpoint)).toEqual(['/crm/v3/objects/contacts/search', '/crm/v3/objects/notes']);

    const row = await db
      .prepare('SELECT status, client_id, contact_external_id, source_id FROM crm_activities WHERE workspace_id=?')
      .get<{ status: string; client_id: string; contact_external_id: string; source_id: string }>(DEMO_WORKSPACE_ID);
    expect(row).toMatchObject({ status: 'written', client_id: 'cl_acme', contact_external_id: '551', source_id: 'opst_1' });
  });

  it('NEVER creates a contact when nobody matches', async () => {
    await connectCrm('hubspot');
    const { proxy, calls } = stubProxy({ '/contacts/search': { results: [] } });

    const result = await logCrmActivity(
      db,
      DEMO_WORKSPACE_ID,
      payload({ contact: { email: null, handle: 'a-stranger', handleProvider: 'github', domain: null } }),
      NOW,
      { proxyFor: () => proxy }
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/No matching CRM contact/);
    // The decisive assertion: nothing was written to their CRM at all.
    expect(calls.filter((call) => call.endpoint.includes('notes'))).toEqual([]);

    // The miss is still recorded, so "we could not attribute this" is countable.
    const row = await db.prepare('SELECT status FROM crm_activities WHERE workspace_id=?').get<{ status: string }>(DEMO_WORKSPACE_ID);
    expect(row?.status).toBe('skipped');
  });

  it('is idempotent per source: an action retry does not leave two notes', async () => {
    await connectCrm('hubspot');
    const { proxy, calls } = stubProxy({ '/contacts/search': HUBSPOT_FOUND, '/objects/notes': { id: 'note_7' } });
    const options = { proxyFor: () => proxy };

    const first = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, options);
    const second = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, options);

    expect(first.status).toBe('written');
    expect(second.status).toBe('written');
    expect(second.externalRef).toBe('note_7');
    expect(calls.filter((call) => call.endpoint.includes('notes'))).toHaveLength(1);

    const rows = await db.prepare('SELECT COUNT(*)::int AS total FROM crm_activities WHERE workspace_id=?').get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(rows?.total).toBe(1);
  });

  it('releases the claim when the CRM answers 4xx, so a retry can succeed', async () => {
    await connectCrm('hubspot');
    let attempt = 0;
    const proxy: CrmProxy = {
      async post<T>(endpoint: string): Promise<T> {
        if (endpoint.includes('search')) return HUBSPOT_FOUND as T;
        attempt += 1;
        if (attempt === 1) throw new Error('Request failed with status code 400: invalid note');
        return { id: 'note_late' } as T;
      },
      async get<T>(): Promise<T> { throw new Error('not used'); }
    };

    const failed = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, { proxyFor: () => proxy });
    expect(failed.status).toBe('failed');

    const retried = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, { proxyFor: () => proxy });
    expect(retried.status).toBe('written');
  });

  it('HOLDS the claim when the outcome is unknown, so a retry cannot double-note', async () => {
    await connectCrm('hubspot');
    let noteAttempts = 0;
    const proxy: CrmProxy = {
      async post<T>(endpoint: string): Promise<T> {
        if (endpoint.includes('search')) return HUBSPOT_FOUND as T;
        noteAttempts += 1;
        throw new Error('socket hang up');
      },
      async get<T>(): Promise<T> { throw new Error('not used'); }
    };

    const first = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, { proxyFor: () => proxy });
    expect(first.status).toBe('pending');

    const second = await logCrmActivity(db, DEMO_WORKSPACE_ID, payload(), NOW, { proxyFor: () => proxy });
    expect(second.status).toBe('pending');
    expect(noteAttempts).toBe(1);
  });

  it('scopes activity to the workspace that owns the connection', async () => {
    const { proxy } = stubProxy({ '/contacts/search': HUBSPOT_FOUND, '/objects/notes': { id: 'note_7' } });
    // Connection belongs to the demo workspace only.
    await connectCrm('hubspot');
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
      .run('ws_crm_other', 'Other', NOW.toISOString());

    const result = await logCrmActivity(db, 'ws_crm_other', payload(), NOW, { proxyFor: () => proxy });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/No CRM is connected/);
  });
});
