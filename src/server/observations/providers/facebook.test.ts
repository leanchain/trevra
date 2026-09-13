import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import {
  FACEBOOK_PAGE_ACCESS_TOKEN_ENV,
  configuredFacebookPageProviders,
  facebookPageProvider
} from './facebook.js';
import { META_GRAPH_VERSION_ENV } from './instagram.js';

const PAGE_ID = '123456789012345';
const NOW = new Date('2026-09-12T12:00:00.000Z');

function credentials(values: Record<string, string> = {}): CredentialAccessor {
  return { get: (name) => values[name] };
}

const ready = credentials({
  [FACEBOOK_PAGE_ACCESS_TOKEN_ENV]: 'facebook-system-user-token',
  [META_GRAPH_VERSION_ENV]: 'v26.0'
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Facebook Page public-data observation provider', () => {
  it('is independently opt-in and does no network work without verified Page identity', async () => {
    expect(facebookPageProvider().availability(credentials())).toMatchObject({
      mode: 'needs-credential'
    });
    expect(configuredFacebookPageProviders({})).toEqual([]);
    expect(
      configuredFacebookPageProviders({ [FACEBOOK_PAGE_ACCESS_TOKEN_ENV]: 'configured' })
    ).toHaveLength(1);

    let calls = 0;
    const result = await facebookPageProvider().observe('acme.test', {
      credentials: ready,
      now: NOW,
      context: { metaPageIds: [] },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
  });

  it('measures exact followers and trailing-30-day Page posts using reconstructed cursors', async () => {
    const seen: Array<{ url: URL; authorization: string | null }> = [];
    const result = await facebookPageProvider().observe('acme.test', {
      credentials: ready,
      now: NOW,
      context: { metaPageIds: [PAGE_ID, 'brand-name', PAGE_ID] },
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, authorization: headers.get('authorization') });
        if (url.pathname === `/v26.0/${PAGE_ID}`) {
          return json({ id: PAGE_ID, followers_count: 1250 });
        }
        if (url.pathname === `/v26.0/${PAGE_ID}/posts`) {
          expect(url.searchParams.get('since')).toBe(
            String(Math.floor((NOW.getTime() - 30 * 24 * 60 * 60 * 1_000) / 1_000))
          );
          expect(url.searchParams.get('until')).toBe(String(Math.floor(NOW.getTime() / 1_000)));
          if (!url.searchParams.get('after')) {
            return json({
              data: [
                { id: `${PAGE_ID}_a`, created_time: '2026-09-11T10:00:00+0000' },
                { id: `${PAGE_ID}_b`, created_time: '2026-09-01T10:00:00+0000' }
              ],
              paging: {
                cursors: { after: 'cursor-1' },
                next: 'https://provider-controlled.invalid/next?access_token=must-not-follow'
              }
            });
          }
          expect(url.searchParams.get('after')).toBe('cursor-1');
          return json({
            data: [{ id: `${PAGE_ID}_c`, created_time: '2026-08-20T10:00:00+0000' }]
          });
        }
        return json({ error: { message: 'unexpected request' } }, 400);
      }
    });

    expect(result.warnings).toEqual([]);
    expect(result.measurements).toEqual([
      {
        metric: 'social.followers',
        scope: `facebook:${PAGE_ID}`,
        value: 1250,
        evidenceUrl: `https://www.facebook.com/${PAGE_ID}`,
        observedAt: NOW.toISOString()
      },
      {
        metric: 'social.posts_30d',
        scope: `facebook:${PAGE_ID}`,
        value: 3,
        evidenceUrl: `https://www.facebook.com/${PAGE_ID}`,
        observedAt: NOW.toISOString()
      }
    ]);
    expect(seen).toHaveLength(3);
    expect(seen.every(({ url }) => url.origin === 'https://graph.facebook.com')).toBe(true);
    expect(seen.every(({ url }) => !url.searchParams.has('access_token'))).toBe(true);
    expect(
      seen.every(({ authorization }) => authorization === 'Bearer facebook-system-user-token')
    ).toBe(true);
  });

  it('fails closed on a Page identity mismatch and never queries that Page posts edge', async () => {
    const seen: string[] = [];
    const result = await facebookPageProvider().observe('acme.test', {
      credentials: ready,
      now: NOW,
      context: { metaPageIds: [PAGE_ID] },
      fetchImpl: async (input) => {
        seen.push(new URL(input).pathname);
        return json({ id: '999999999999999', followers_count: 10 });
      }
    });
    expect(seen).toEqual([`/v26.0/${PAGE_ID}`]);
    expect(result.measurements).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/unexpected Page/);
  });

  it('keeps followers measured but leaves cadence unmeasured when the bounded post window overflows', async () => {
    let postPage = 0;
    const result = await facebookPageProvider().observe('acme.test', {
      credentials: ready,
      now: NOW,
      context: { metaPageIds: [PAGE_ID] },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === `/v26.0/${PAGE_ID}`)
          return json({ id: PAGE_ID, followers_count: 900 });
        postPage += 1;
        return json({
          data: [{ id: `${PAGE_ID}_${postPage}`, created_time: '2026-09-10T10:00:00+0000' }],
          paging: {
            cursors: { after: `cursor-${postPage}` },
            next: 'https://graph.facebook.com/next'
          }
        });
      }
    });
    expect(postPage).toBe(3);
    expect(result.measurements).toEqual([
      expect.objectContaining({ metric: 'social.followers', value: 900 })
    ]);
    expect(result.warnings.join(' ')).toMatch(/more than 300 times/);
  });
});
