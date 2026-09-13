import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import { countPublicFeedPosts30d, substackPublicFeedProvider } from './substack.js';

const credentials: CredentialAccessor = { get: () => undefined };
const now = new Date('2026-09-12T08:00:00.000Z');

function rss(dates: string[]): string {
  return `<?xml version="1.0"?><rss><channel>${dates
    .map((date, index) => `<item><title>${index}</title><pubDate>${date}</pubDate></item>`)
    .join('')}</channel></rss>`;
}

function context() {
  return {
    newsletterPublications: [
      {
        platform: 'substack' as const,
        url: 'https://acme.substack.com',
        feedUrl: 'https://acme.substack.com/feed'
      }
    ]
  };
}

describe('Substack public feed observation provider', () => {
  it('counts a 30-day window only when an older item proves the feed covers the whole window', () => {
    expect(
      countPublicFeedPosts30d(
        rss([
          'Fri, 11 Sep 2026 08:00:00 GMT',
          'Sat, 29 Aug 2026 08:00:00 GMT',
          'Sat, 01 Aug 2026 08:00:00 GMT'
        ]),
        now
      )
    ).toEqual({ count: 2, warning: null });
  });

  it('leaves an all-recent feed unmeasured because it may be truncated', () => {
    const result = countPublicFeedPosts30d(
      rss(['Fri, 11 Sep 2026 08:00:00 GMT', 'Wed, 09 Sep 2026 08:00:00 GMT']),
      now
    );
    expect(result.count).toBeNull();
    expect(result.warning).toContain('may be truncated');
  });

  it('fetches only a company-published Substack target and emits a raw newsletter metric', async () => {
    const seen: string[] = [];
    const result = await substackPublicFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: context(),
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/feed') {
          return new Response(
            rss([
              'Fri, 11 Sep 2026 08:00:00 GMT',
              'Sat, 29 Aug 2026 08:00:00 GMT',
              'Sat, 01 Aug 2026 08:00:00 GMT'
            ]),
            { status: 200, headers: { 'content-type': 'application/rss+xml' } }
          );
        }
        return new Response('not found', { status: 404 });
      }
    });
    expect(seen).toEqual([
      'https://acme.substack.com/robots.txt',
      'https://acme.substack.com/feed'
    ]);
    expect(result.measurements).toEqual([
      {
        metric: 'newsletter.posts_30d',
        scope: 'substack:acme.substack.com',
        value: 2,
        evidenceUrl: 'https://acme.substack.com/feed',
        observedAt: now.toISOString()
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('does no network work without a first-party-published publication target', async () => {
    let calls = 0;
    const result = await substackPublicFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: { newsletterPublications: [] },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
  });
});
