import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import {
  configuredHttpObservationProviders,
  httpObservationProvider,
  type HttpObservationProviderSpec
} from './http.js';

const credentials = (values: Record<string, string> = {}): CredentialAccessor => ({
  get(name) {
    return values[name];
  }
});

const SPEC: HttpObservationProviderSpec = {
  key: 'commerce-observer',
  name: 'Commerce observation plane',
  endpoint: 'https://observer.example/observe',
  tokenEnv: 'COMMERCE_OBSERVER_TOKEN',
  docsUrl: 'https://observer.example/docs',
  surfaces: ['meta_ads', 'products', 'newsletter', 'ecommerce_apps', 'social', 'site']
};

describe('HTTP ecommerce observation provider', () => {
  it('accepts only evidenced, timestamped signal kinds Trevra knows how to score', async () => {
    const provider = httpObservationProvider(SPEC);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const now = new Date('2026-09-12T08:00:00.000Z');
    const result = await provider.observe('Shop.Example', {
      credentials: credentials({ COMMERCE_OBSERVER_TOKEN: 'secret' }),
      now,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            observations: [
              {
                kind: 'meta-ads-rising',
                detail: 'Active Meta ads rose from 7 to 12.',
                previous: 7,
                current: 12,
                evidenceUrl: 'https://www.facebook.com/ads/library/?id=123',
                observedAt: '2026-09-12T07:45:00.000Z'
              },
              {
                kind: 'product-launch',
                detail: 'Three new products appeared.',
                previous: 'catalog-a',
                current: 'catalog-b',
                sourceUrl: 'https://shop.example/collections/new',
                lastSeenAt: '2026-09-12T07:30:00.000Z'
              },
              {
                kind: 'totally-made-up',
                detail: 'Should never score.',
                evidenceUrl: 'https://shop.example/',
                observedAt: '2026-09-12T07:00:00.000Z'
              },
              {
                kind: 'social-growth',
                detail: 'Missing source evidence.',
                observedAt: '2026-09-12T07:00:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://observer.example/observe');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      domain: 'shop.example',
      surfaces: SPEC.surfaces
    });
    expect(result.observations.map((observation) => observation.kind)).toEqual([
      'meta-ads-rising',
      'product-launch'
    ]);
    expect(result.observations[0].previous).toBe('7');
    expect(result.observations[0].current).toBe('12');
    expect(result.warnings.some((warning) => warning.includes('totally-made-up'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('incomplete social-growth'))).toBe(
      true
    );
  });

  it('accepts raw measurements so the collector can stay stateless', async () => {
    const provider = httpObservationProvider({ ...SPEC, tokenEnv: null });
    const result = await provider.observe('shop.example', {
      credentials: credentials(),
      now: new Date('2026-09-12T08:00:00.000Z'),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            measurements: [
              {
                metric: 'meta.active_ads',
                value: 12,
                evidenceUrl: 'https://www.facebook.com/ads/library/?q=shop',
                observedAt: '2026-09-12T07:45:00.000Z'
              },
              {
                metric: 'social.followers',
                scope: 'instagram:shop',
                value: '4200',
                sourceUrl: 'https://www.instagram.com/shop/',
                lastSeenAt: '2026-09-12T07:40:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    });
    expect(result.observations).toEqual([]);
    expect(result.measurements).toEqual([
      {
        metric: 'meta.active_ads',
        scope: null,
        value: 12,
        evidenceUrl: 'https://www.facebook.com/ads/library/?q=shop',
        observedAt: '2026-09-12T07:45:00.000Z'
      },
      {
        metric: 'social.followers',
        scope: 'instagram:shop',
        value: 4200,
        evidenceUrl: 'https://www.instagram.com/shop/',
        observedAt: '2026-09-12T07:40:00.000Z'
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('never turns future provider timestamps into artificially fresh signals', async () => {
    const provider = httpObservationProvider({ ...SPEC, tokenEnv: null });
    const result = await provider.observe('shop.example', {
      credentials: credentials(),
      now: new Date('2026-09-12T08:00:00.000Z'),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            observations: [
              {
                kind: 'social-growth',
                detail: 'Followers jumped.',
                previous: 1000,
                current: 1300,
                evidenceUrl: 'https://instagram.com/shop',
                observedAt: '2026-09-13T08:00:00.000Z'
              }
            ]
          }),
          { status: 200 }
        )
    });
    expect(result.observations).toEqual([]);
    expect(result.warnings[0]).toContain('incomplete social-growth');
  });

  it('reports missing credentials through availability instead of pretending no signals exist', () => {
    const provider = httpObservationProvider(SPEC);
    expect(provider.availability(credentials())).toMatchObject({ mode: 'needs-credential' });
    expect(provider.availability(credentials({ COMMERCE_OBSERVER_TOKEN: 'x' }))).toMatchObject({
      mode: 'ready'
    });
  });

  it('requires HTTPS when an observation adapter carries a bearer credential', () => {
    expect(() =>
      configuredHttpObservationProviders(
        JSON.stringify([
          {
            key: 'unsafe',
            name: 'Unsafe',
            endpoint: 'http://observer.example/observe',
            tokenEnv: 'OBSERVER_TOKEN',
            surfaces: ['meta_ads']
          }
        ])
      )
    ).toThrow('must use an HTTPS endpoint');
  });
});
