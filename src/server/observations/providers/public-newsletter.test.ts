import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import { publicNewsletterFeedProvider } from './public-newsletter.js';

const credentials: CredentialAccessor = { get: () => undefined };
const now = new Date('2026-09-12T12:00:00.000Z');

function rss(dates: string[]): string {
  return `<?xml version="1.0"?><rss><channel>${dates
    .map((date, index) => `<item><title>${index}</title><pubDate>${date}</pubDate></item>`)
    .join('')}</channel></rss>`;
}

describe('first-party newsletter feed provider', () => {
  it('measures an explicit same-host feed published from a newsletter page', async () => {
    const seen: string[] = [];
    const result = await publicNewsletterFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: {
        newsletterPublications: [
          {
            platform: 'public-feed',
            url: 'https://acme.test/newsletter',
            feedUrl: 'https://acme.test/newsletter/feed.xml'
          }
        ]
      },
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/newsletter/feed.xml') {
          return new Response(
            rss([
              'Fri, 11 Sep 2026 12:00:00 GMT',
              'Sat, 29 Aug 2026 12:00:00 GMT',
              'Sat, 01 Aug 2026 12:00:00 GMT'
            ]),
            { status: 200, headers: { 'content-type': 'application/rss+xml' } }
          );
        }
        return new Response('not found', { status: 404 });
      }
    });

    expect(seen).toEqual(['https://acme.test/robots.txt', 'https://acme.test/newsletter/feed.xml']);
    expect(result.measurements).toEqual([
      {
        metric: 'newsletter.posts_30d',
        scope: 'public-feed:acme.test/newsletter/feed.xml',
        value: 2,
        evidenceUrl: 'https://acme.test/newsletter/feed.xml',
        observedAt: now.toISOString()
      }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('does no network work without a valid newsletter-page target', async () => {
    let calls = 0;
    const result = await publicNewsletterFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: {
        newsletterPublications: [
          {
            platform: 'public-feed',
            url: 'https://acme.test/blog',
            feedUrl: 'https://acme.test/feed.xml'
          },
          {
            platform: 'public-feed',
            url: 'https://acme.test/newsletter',
            feedUrl: 'https://feeds.vendor.test/acme.xml'
          }
        ]
      },
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('leaves an all-recent feed unmeasured instead of assuming the feed is complete', async () => {
    const result = await publicNewsletterFeedProvider().observe('acme.test', {
      credentials,
      now,
      context: {
        newsletterPublications: [
          {
            platform: 'public-feed',
            url: 'https://www.acme.test/subscribe',
            feedUrl: 'https://acme.test/feed.xml'
          }
        ]
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        return new Response(
          rss(['Fri, 11 Sep 2026 12:00:00 GMT', 'Thu, 10 Sep 2026 12:00:00 GMT']),
          { status: 200, headers: { 'content-type': 'application/rss+xml' } }
        );
      }
    });
    expect(result.measurements).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/may be truncated/);
  });
});
