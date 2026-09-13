import { describe, expect, it } from 'vitest';
import { createPublicWebCrawler, parseCrawlDelayMs } from './public-web.js';

function text(
  body: string,
  status = 200,
  contentType = 'text/plain',
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, ...headers }
  });
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
          return text('User-agent: TrevraCrawler\nDisallow: /private\nAllow: /private/catalog');
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

  it('enforces one hard request budget across features, retries and redirects', async () => {
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

  it('does not let a feature turn the crawler into an arbitrary cross-origin fetch primitive', async () => {
    const crawler = await createPublicWebCrawler('shop.example', {
      fetchImpl: async () => text('', 404)
    });
    expect((await crawler.get('https://elsewhere.example/')).skipped).toBe('cross-origin');
    expect(crawler.requestsUsed).toBe(0);
  });

  it('permits only the canonical www redirect variant and counts every redirect hop', async () => {
    const seen: string[] = [];
    const crawler = await createPublicWebCrawler('shop.example', {
      maxRetries: 0,
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return text('', 404);
        if (url.hostname === 'shop.example') {
          return text('', 302, 'text/plain', { location: 'https://www.shop.example/home' });
        }
        return text('<html>canonical</html>', 200, 'text/html');
      }
    });

    const result = await crawler.get('/');
    expect(result.response?.status).toBe(200);
    expect(seen).toContain('https://www.shop.example/home');
    expect(crawler.requestsUsed).toBe(3); // robots + initial + redirect hop
  });

  it('blocks a redirect to an unrelated public host before sending the second request', async () => {
    const seen: string[] = [];
    const crawler = await createPublicWebCrawler('shop.example', {
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return text('', 404);
        return text('', 302, 'text/plain', { location: 'https://elsewhere.example/landing' });
      }
    });

    const result = await crawler.get('/');
    expect(result.response).toBeNull();
    expect(result.error).toMatch(/redirect outside caller scope/i);
    expect(seen.some((url) => url.includes('elsewhere.example'))).toBe(false);
    expect(seen).toHaveLength(2); // robots + one blocked navigation; policy failures are never retried
  });

  it('fails closed when robots.txt is operationally unavailable or explicitly forbidden', async () => {
    const networkCrawler = await createPublicWebCrawler('shop.example', {
      maxRetries: 0,
      fetchImpl: async () => {
        throw new Error('network down');
      }
    });

    const network = await networkCrawler.get('/');
    expect(network.skipped).toBe('robots-unavailable');
    expect(networkCrawler.telemetry().robots).toBe('unavailable');
    expect(networkCrawler.requestsUsed).toBe(1);

    const forbiddenCrawler = await createPublicWebCrawler('forbidden.example', {
      maxRetries: 0,
      fetchImpl: async (input) =>
        new URL(input).pathname === '/robots.txt'
          ? text('forbidden', 403)
          : text('should not fetch')
    });
    expect((await forbiddenCrawler.get('/')).skipped).toBe('robots-unavailable');
    expect(forbiddenCrawler.requestsUsed).toBe(1);
  });

  it('bounds decoded response bodies instead of buffering untrusted pages without a ceiling', async () => {
    const crawler = await createPublicWebCrawler('shop.example', {
      maxResponseBytes: 1_024,
      maxRetries: 0,
      fetchImpl: async (input) => {
        if (new URL(input).pathname === '/robots.txt') return text('', 404);
        return text('x'.repeat(2_048), 200, 'text/html');
      }
    });

    const result = await crawler.get('/');
    expect(result.response).toBeNull();
    expect(result.error).toMatch(/exceeds 1024 bytes/i);
  });

  it('honors Retry-After within the overall crawl deadline and reports retries', async () => {
    let now = 0;
    let busy = true;
    const crawler = await createPublicWebCrawler('shop.example', {
      maxDurationMs: 5_000,
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => {
        if (new URL(input).pathname === '/robots.txt') return text('', 404);
        if (busy) {
          busy = false;
          return text('', 429, 'text/plain', { 'retry-after': '1' });
        }
        return text('ok', 200);
      }
    });

    const result = await crawler.get('/');
    expect(result.response?.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(crawler.telemetry().retries).toBe(1);
    expect(now).toBe(1_000);
  });

  it('enforces the robots Crawl-delay between requests without sleeping in tests', async () => {
    let now = 0;
    const seen: string[] = [];
    const crawler = await createPublicWebCrawler('shop.example', {
      maxDurationMs: 10_000,
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        seen.push(`${url.pathname}@${now}`);
        if (url.pathname === '/robots.txt') {
          return text('User-agent: TrevraCrawler\nCrawl-delay: 1.5');
        }
        return text('ok');
      }
    });

    await crawler.get('/a');
    await crawler.get('/b');

    expect(parseCrawlDelayMs('User-agent: *\nCrawl-delay: 2')).toBe(2_000);
    expect(seen).toEqual(['/robots.txt@0', '/a@1500', '/b@3000']);
    expect(crawler.telemetry().crawlDelayMs).toBe(1_500);
  });
});
