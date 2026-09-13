import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import {
  configuredInstagramBusinessDiscoveryProviders,
  DEFAULT_META_GRAPH_VERSION,
  INSTAGRAM_BUSINESS_ACCOUNT_ENV,
  instagramBusinessDiscoveryProvider,
  META_GRAPH_TOKEN_ENV
} from './instagram.js';

function credentials(values: Record<string, string> = {}): CredentialAccessor {
  return { get: (name) => values[name] };
}

const ready = credentials({
  [META_GRAPH_TOKEN_ENV]: 'secret-token',
  [INSTAGRAM_BUSINESS_ACCOUNT_ENV]: '17841400000000000'
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    credentials: ready,
    now: new Date('2026-09-12T08:00:00.000Z'),
    context: {
      socialProfiles: [
        {
          platform: 'instagram',
          handle: 'Acme',
          url: 'https://www.instagram.com/Acme/'
        }
      ]
    },
    ...overrides
  };
}

describe('Instagram Business Discovery observation provider', () => {
  it('stays completely idle when the company did not publish a usable Instagram profile', async () => {
    let calls = 0;
    const provider = instagramBusinessDiscoveryProvider();
    for (const socialProfiles of [
      [],
      [
        {
          platform: 'instagram',
          handle: 'bad){followers_count}',
          url: 'https://www.instagram.com/bad'
        }
      ]
    ]) {
      const result = await provider.observe('acme.test', {
        ...options(),
        context: { socialProfiles },
        fetchImpl: async () => {
          calls += 1;
          throw new Error('must not be called');
        }
      });
      expect(result.measurements).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
    expect(calls).toBe(0);
  });

  it('does not call Graph when there is no Instagram target', async () => {
    let calls = 0;
    const result = await instagramBusinessDiscoveryProvider().observe('acme.test', {
      ...options(),
      context: { socialProfiles: [] },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not be called');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('requires both the deployment token and the querying professional account, and rejects a malformed Graph version', () => {
    const provider = instagramBusinessDiscoveryProvider();
    expect(
      provider.availability(
        credentials({
          [META_GRAPH_TOKEN_ENV]: 'token',
          [INSTAGRAM_BUSINESS_ACCOUNT_ENV]: '17841400000000000',
          TREVRA_META_GRAPH_VERSION: '26'
        })
      )
    ).toMatchObject({ mode: 'disabled' });
    expect(provider.availability(credentials())).toMatchObject({ mode: 'needs-credential' });
    expect(
      provider.availability(credentials({ [META_GRAPH_TOKEN_ENV]: 'token-only' }))
    ).toMatchObject({ mode: 'needs-credential' });
    expect(provider.availability(ready)).toMatchObject({ mode: 'ready' });
  });

  it('queries the fixed Graph host with bearer auth and returns raw follower/cadence measurements', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await instagramBusinessDiscoveryProvider().observe('acme.test', {
      ...options(),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            business_discovery: {
              followers_count: 4200,
              media_count: 300,
              media: {
                data: [
                  { timestamp: '2026-09-11T07:00:00+0000' },
                  { timestamp: '2026-09-01T07:00:00+0000' },
                  { timestamp: '2026-08-01T07:00:00+0000' }
                ]
              }
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    });

    expect(calls).toHaveLength(1);
    const request = new URL(calls[0].url);
    expect(request.origin).toBe('https://graph.facebook.com');
    expect(request.pathname).toBe(`/${DEFAULT_META_GRAPH_VERSION}/17841400000000000`);
    expect(request.searchParams.get('fields')).toContain('business_discovery.username(Acme)');
    expect(request.toString()).not.toContain('secret-token');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token'
    );
    expect(result.measurements).toEqual([
      {
        metric: 'social.followers',
        scope: 'instagram:acme',
        value: 4200,
        evidenceUrl: 'https://www.instagram.com/Acme/',
        observedAt: '2026-09-12T08:00:00.000Z'
      },
      {
        metric: 'social.posts_30d',
        scope: 'instagram:acme',
        value: 2,
        evidenceUrl: 'https://www.instagram.com/Acme/',
        observedAt: '2026-09-12T08:00:00.000Z'
      }
    ]);
  });

  it('refuses to fabricate an exact 30-day cadence when the bounded media page is incomplete', async () => {
    const result = await instagramBusinessDiscoveryProvider().observe('acme.test', {
      ...options(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            business_discovery: {
              followers_count: 4200,
              media: {
                data: [
                  { timestamp: '2026-09-11T07:00:00+0000' },
                  { timestamp: '2026-09-10T07:00:00+0000' }
                ],
                paging: { next: 'https://graph.facebook.com/next-page' }
              }
            }
          }),
          { status: 200 }
        )
    });
    expect(result.measurements?.map((measurement) => measurement.metric)).toEqual([
      'social.followers'
    ]);
    expect(result.warnings[0]).toContain('cadence was left unmeasured');
  });

  it('degrades an unsupported/non-professional target without inventing zero metrics', async () => {
    const result = await instagramBusinessDiscoveryProvider().observe('acme.test', {
      ...options(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'Unsupported get request' } }), {
          status: 400
        })
    });
    expect(result.measurements).toEqual([]);
    expect(result.warnings[0]).toContain('HTTP 400');
  });

  it('is opt-in: absent configuration creates no provider, partial configuration exposes a credential problem', () => {
    expect(configuredInstagramBusinessDiscoveryProviders({})).toEqual([]);
    const [partial] = configuredInstagramBusinessDiscoveryProviders({
      [META_GRAPH_TOKEN_ENV]: 'token-only'
    });
    expect(partial).toBeDefined();
    expect(
      partial.availability(credentials({ [META_GRAPH_TOKEN_ENV]: 'token-only' }))
    ).toMatchObject({
      mode: 'needs-credential'
    });
  });
});
