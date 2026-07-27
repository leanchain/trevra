import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../skills/guard.js';
import { buildExaQuery, exaProvider } from './providers/exa.js';
import { seedProvider } from './providers/seed.js';
import { sourceLeads } from './source.js';
import type { CredentialAccessor, SourceQuery } from './types.js';

const noCredentials: CredentialAccessor = { get: () => undefined };
const withExa: CredentialAccessor = { get: (name) => (name === 'EXA_API_KEY' ? 'exa-key-123' : undefined) };

function query(overrides: Partial<SourceQuery> = {}): SourceQuery {
  return { keywords: [], domains: [], countries: [], vertical: null, limit: 25, ...overrides };
}

describe('seed provider', () => {
  it('normalizes, dedupes, and caps the caller\'s list', async () => {
    const result = await seedProvider.search(
      query({ domains: ['https://www.Shop.test/collections/x', 'shop.test', 'other.test', 'third.test'], limit: 2 }),
      { credentials: noCredentials }
    );
    expect(result.candidates.map((candidate) => candidate.domain)).toEqual(['shop.test', 'other.test']);
    expect(result.candidates.every((candidate) => candidate.providerKey === 'seed')).toBe(true);
    expect(result.warnings.join(' ')).toContain('limit of 2');
  });

  it('says so when the caller supplied nothing', async () => {
    const result = await seedProvider.search(query(), { credentials: noCredentials });
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual(['No domains supplied; the seed provider sources from the request only.']);
  });
});

describe('exa provider', () => {
  it('builds a deterministic ICP query', () => {
    expect(buildExaQuery(query({ vertical: 'footwear', keywords: ['direct to consumer'], countries: ['Switzerland'] }))).toBe(
      'footwear direct to consumer companies in Switzerland'
    );
    expect(buildExaQuery(query())).toBe('companies');
  });

  it('posts to the documented endpoint with the documented auth header', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await exaProvider.search(query({ vertical: 'footwear', limit: 5 }), { credentials: withExa, fetchImpl });

    expect(seen[0].url).toBe('https://api.exa.ai/search');
    expect(seen[0].init?.method).toBe('POST');
    expect((seen[0].init?.headers as Record<string, string>)['x-api-key']).toBe('exa-key-123');
    const body = JSON.parse(String(seen[0].init?.body));
    expect(body).toEqual({ query: 'footwear companies', type: 'auto', category: 'company', numResults: 5 });
    // Rejected with a 400 alongside `category: company`, so they are never sent.
    expect(body).not.toHaveProperty('excludeDomains');
    expect(body).not.toHaveProperty('startPublishedDate');
  });

  it('maps results to normalized candidate domains, deduped', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          results: [
            { url: 'https://www.Shop.test/about', title: 'Nonormal', summary: 'Performance footwear.' },
            { url: 'https://shop.test/careers', title: 'Nonormal careers' },
            { url: 'not a url' },
            { url: 'https://other.test', title: 'Other' }
          ]
        }),
        { status: 200 }
      );

    const result = await exaProvider.search(query(), { credentials: withExa, fetchImpl });
    expect(result.candidates.map((candidate) => candidate.domain)).toEqual(['shop.test', 'other.test']);
    expect(result.candidates[0]).toEqual({
      domain: 'shop.test',
      name: 'Nonormal',
      description: 'Performance footwear.',
      providerKey: 'exa',
      sourceUrl: 'https://www.Shop.test/about'
    });
    // Nothing obtained from Exa may reach the ledger, evidence included.
    expect(result.evidence).toEqual([]);
  });

  it('degrades a vendor error to a warning instead of throwing', async () => {
    const failing = await exaProvider.search(query(), {
      credentials: withExa,
      fetchImpl: async () => new Response('nope', { status: 401 })
    });
    expect(failing.candidates).toEqual([]);
    expect(failing.warnings[0]).toContain('HTTP 401');

    const offline = await exaProvider.search(query(), {
      credentials: withExa,
      fetchImpl: async () => {
        throw new TypeError('network down');
      }
    });
    expect(offline.candidates).toEqual([]);
    expect(offline.warnings[0]).toContain('network down');
  });

  it('makes no request at all without a credential', async () => {
    let called = false;
    const result = await exaProvider.search(query(), {
      credentials: noCredentials,
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }
    });
    expect(called).toBe(false);
    expect(result.warnings[0]).toContain('EXA_API_KEY is not set');
  });
});

describe('gtm.source-leads', () => {
  it('defaults to the seed provider and returns storable results', async () => {
    const result = await sourceLeads({ domains: ['shop.test', 'other.test'] }, { credentials: noCredentials });
    expect(result.providerKey).toBe('seed');
    expect(result.availability.mode).toBe('ready');
    expect(result.candidates.map((candidate) => candidate.domain)).toEqual(['shop.test', 'other.test']);
    expect(result.retention).toBe('default');
  });

  it('throws on an unknown provider rather than silently falling back', async () => {
    await expect(sourceLeads({ provider: 'clearbit' }, { credentials: noCredentials })).rejects.toThrow('Unknown research provider: clearbit');
  });

  it('reports an unavailable provider without throwing, and without calling it', async () => {
    let called = false;
    const result = await sourceLeads(
      { provider: 'exa', vertical: 'footwear' },
      {
        credentials: noCredentials,
        fetchImpl: async () => {
          called = true;
          return new Response('{}', { status: 200 });
        }
      }
    );

    expect(called).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.availability.mode).toBe('needs-credential');
    expect(result.warnings[0]).toContain('needs-credential');
  });

  it('carries the provider\'s retention rule onto the output for the runner', async () => {
    const result = await sourceLeads(
      { provider: 'exa', vertical: 'footwear' },
      {
        credentials: withExa,
        fetchImpl: async () => new Response(JSON.stringify({ results: [{ url: 'https://shop.test' }] }), { status: 200 })
      }
    );
    expect(result.candidates.map((candidate) => candidate.domain)).toEqual(['shop.test']);
    expect(result.retention).toBe('none');
    expect(result.evidence).toEqual([]);
  });

  it('publishes the providers that were read and deliberately not shipped', async () => {
    const result = await sourceLeads({ domains: [] }, { credentials: noCredentials });
    expect(result.withheld.map((provider) => provider.key)).toEqual(['apollo']);
    expect(result.withheld[0].reason).toContain('absent by decision');
  });
});
