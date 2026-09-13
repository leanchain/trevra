import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import {
  configuredMetaAdLibraryProviders,
  META_AD_LIBRARY_COUNTRIES_ENV,
  META_AD_LIBRARY_TOKEN_ENV,
  metaAdLibraryProvider,
  parseMetaAdLibraryCountries
} from './meta-ads.js';
import { META_GRAPH_VERSION_ENV } from './instagram.js';

const now = new Date('2026-09-12T10:00:00.000Z');
const PAGE_ID = '123456789012345';

function credentials(values: Record<string, string> = {}): CredentialAccessor {
  return { get: (name) => values[name] };
}

function context(ids: string[] = [PAGE_ID]) {
  return { metaPageIds: ids };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const ready = credentials({
  [META_AD_LIBRARY_TOKEN_ENV]: 'secret-token',
  [META_AD_LIBRARY_COUNTRIES_ENV]: JSON.stringify(['DE', 'GB']),
  [META_GRAPH_VERSION_ENV]: 'v26.0'
});

describe('Meta Ad Library observation provider', () => {
  it('validates the explicit commercial-ad geography instead of pretending coverage is global', () => {
    expect(parseMetaAdLibraryCountries('["GB","DE"]')).toEqual(['DE', 'GB']);
    expect(() => parseMetaAdLibraryCountries('["US"]')).toThrow(/EU member states and GB/);
    expect(() => parseMetaAdLibraryCountries('["DE","DE"]')).toThrow(/duplicate/);
    expect(metaAdLibraryProvider().availability(credentials())).toMatchObject({
      mode: 'needs-credential'
    });
    expect(metaAdLibraryProvider().availability(ready)).toMatchObject({ mode: 'ready' });
  });

  it('is opt-in in the scheduled provider list', () => {
    expect(configuredMetaAdLibraryProviders({})).toEqual([]);
    expect(
      configuredMetaAdLibraryProviders({ [META_AD_LIBRARY_TOKEN_ENV]: 'partial' })
    ).toHaveLength(1);
  });

  it('counts exact active ads for the verified Page id and reconstructs pagination itself', async () => {
    const seen: URL[] = [];
    const result = await metaAdLibraryProvider().observe('shop.example', {
      credentials: ready,
      now,
      context: context(),
      fetchImpl: async (input) => {
        const url = new URL(input);
        seen.push(url);
        const after = url.searchParams.get('after');
        if (!after) {
          return json({
            data: [
              {
                page_id: PAGE_ID,
                ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=1'
              },
              {
                page_id: PAGE_ID,
                ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=2'
              }
            ],
            paging: {
              cursors: { after: 'cursor-2' },
              next: 'https://evil.example/steal?access_token=provider-returned-secret'
            }
          });
        }
        expect(after).toBe('cursor-2');
        return json({
          data: [
            {
              page_id: PAGE_ID,
              ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=2'
            },
            {
              page_id: PAGE_ID,
              ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=3'
            }
          ]
        });
      }
    });

    expect(seen).toHaveLength(2);
    expect(seen.every((url) => url.origin === 'https://graph.facebook.com')).toBe(true);
    expect(seen[0].pathname).toBe('/v26.0/ads_archive');
    expect(seen[0].searchParams.get('ad_type')).toBe('ALL');
    expect(seen[0].searchParams.get('ad_active_status')).toBe('ACTIVE');
    expect(JSON.parse(seen[0].searchParams.get('search_page_ids') ?? '[]')).toEqual([PAGE_ID]);
    expect(JSON.parse(seen[0].searchParams.get('ad_reached_countries') ?? '[]')).toEqual([
      'DE',
      'GB'
    ]);
    expect(seen.some((url) => url.hostname === 'evil.example')).toBe(false);
    expect(result.measurements).toEqual([
      {
        metric: 'meta.active_ads',
        scope: `meta:${PAGE_ID}:DE,GB`,
        value: 3,
        evidenceUrl: expect.stringContaining(`view_all_page_id=${PAGE_ID}`),
        observedAt: now.toISOString()
      }
    ]);
  });

  it('never calls Meta without an explicit verified numeric Page id', async () => {
    let calls = 0;
    const result = await metaAdLibraryProvider().observe('shop.example', {
      credentials: ready,
      now,
      context: context(['brand-name', '123']),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
  });

  it('leaves the metric unmeasured on identity mismatch or broken pagination', async () => {
    const mismatch = await metaAdLibraryProvider().observe('shop.example', {
      credentials: ready,
      now,
      context: context(),
      fetchImpl: async () =>
        json({
          data: [{ page_id: '999999999999999', ad_snapshot_url: 'https://www.facebook.com/ad/1' }]
        })
    });
    expect(mismatch.measurements).toEqual([]);
    expect(mismatch.warnings[0]).toMatch(/unexpected Page/);

    const broken = await metaAdLibraryProvider().observe('shop.example', {
      credentials: ready,
      now,
      context: context(),
      fetchImpl: async () =>
        json({
          data: [{ page_id: PAGE_ID, ad_snapshot_url: 'https://www.facebook.com/ad/1' }],
          paging: { next: 'https://graph.facebook.com/more', cursors: {} }
        })
    });
    expect(broken.measurements).toEqual([]);
    expect(broken.warnings[0]).toMatch(/fresh cursor/);
  });
});
