import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import { beehiivPublicFeedProvider } from './beehiiv.js';

const credentials: CredentialAccessor = { get: () => undefined };
const now = new Date('2026-09-12T08:00:00.000Z');
const FEED = 'https://rss.beehiiv.com/feeds/ArRy5S7Up8.xml';

function rss(dates: string[]): string {
  return `<?xml version="1.0"?><rss><channel>${dates
    .map((date, index) => `<item><title>${index}</title><pubDate>${date}</pubDate></item>`)
    .join('')}</channel></rss>`;
}

function context(feedUrl = FEED) {
  return {
    newsletterPublications: [
      {
        platform: 'beehiiv' as const,
        url: feedUrl,
        feedUrl
      }
    ]
  };
}

describe('beehiiv public feed observation provider', () => {
  it('fetches only an explicitly published beehiiv newsletter feed and emits a raw metric', async () => {
    const seen: string[] = [];
    const result = await beehiivPublicFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: context(),
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.toString() === FEED) {
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

    expect(seen).toEqual(['https://rss.beehiiv.com/robots.txt', FEED]);
    expect(result.measurements).toEqual([
      {
        metric: 'newsletter.posts_30d',
        scope: 'beehiiv:/feeds/arry5s7up8.xml',
        value: 2,
        evidenceUrl: FEED,
        observedAt: now.toISOString()
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('does not treat a beehiiv podcast feed as newsletter activity', async () => {
    let calls = 0;
    const result = await beehiivPublicFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: context('https://rss.beehiiv.com/podcasts/show.xml'),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
  });

  it('leaves a possibly truncated all-recent feed unmeasured', async () => {
    const result = await beehiivPublicFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: context(),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        return new Response(
          rss(['Fri, 11 Sep 2026 08:00:00 GMT', 'Wed, 09 Sep 2026 08:00:00 GMT']),
          { status: 200, headers: { 'content-type': 'application/rss+xml' } }
        );
      }
    });
    expect(result.measurements).toEqual([]);
    expect(result.warnings[0]).toContain('may be truncated');
  });
});
