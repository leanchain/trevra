import { describe, expect, it } from 'vitest';
import { createPublicWebCrawler } from './public-web.js';

function text(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('PublicWebCrawler', () => {
  it('shares one robots policy and refuses disallowed paths without requesting them', async () => {
    const seen: string[] = [];
    const crawler = await createPublicWebCrawler('shop.example', {
      maxRequests: 5,
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') {
          return text('User-agent: TrevraGrowthBot\nDisallow: /private\nAllow: /private/catalog');
        }
        return text('<html>ok</html>', 200, 'text/html');
      }
    });

    const blocked = await crawler.get('/private/account');
    const allowed = await crawler.get('/private/catalog');

    expect(blocked.skipped).toBe('robots-disallowed');
    expect(allowed.response?.status).toBe(200);
    expect(seen.filter((url) => url.includes('/robots.txt'))).toHaveLength(1);
    expect(seen.some((url) => url.includes('/private/account'))).toBe(false);
    expect(crawler.requestsUsed).toBe(2);
  });

  it('enforces one hard request budget across feature consumers', async () => {
    const seen: string[] = [];
    const crawler = await createPublicWebCrawler('shop.example', {
      maxRequests: 2,
      fetchImpl: async (input) => {
        seen.push(input);
        if (new URL(input).pathname === '/robots.txt') return text('', 404);
        return text('<html>ok</html>', 200, 'text/html');
      }
    });

    expect((await crawler.get('/')).response?.status).toBe(200);
    expect((await crawler.get('/pricing')).skipped).toBe('budget-exhausted');
    expect(seen).toHaveLength(2); // robots + homepage
  });

  it('does not let a feature turn the per-domain crawler into a cross-origin fetch primitive', async () => {
    const crawler = await createPublicWebCrawler('shop.example', {
      fetchImpl: async () => text('', 404)
    });
    expect((await crawler.get('https://elsewhere.example/')).skipped).toBe('cross-origin');
    expect(crawler.requestsUsed).toBe(0);
  });
});
