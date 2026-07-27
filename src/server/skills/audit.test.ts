import { describe, expect, it } from 'vitest';
import { CHECK_ORDER, WEIGHTS, parseRobots, runVisibilityAudit, scoreChecks, type CheckResult, type CheckStatus } from './audit.js';
import type { FetchLike } from './guard.js';

// Ported from the Python reference tests/test_audit_visibility.py.

const PRODUCT_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Cloud Runner',
  offers: { '@type': 'Offer', price: '129.00', availability: 'https://schema.org/InStock' }
});

const HOME_JSONLD = JSON.stringify([
  { '@context': 'https://schema.org', '@type': 'Organization', name: 'Nonormal' },
  { '@context': 'https://schema.org', '@type': 'WebSite', url: 'https://shop.test' }
]);

const GOOD_HOME = `<!doctype html><html><head>
<title>Nonormal — Performance Footwear</title>
<meta name="description" content="Nonormal builds performance footwear for runners who want
 speed and comfort every single day.">
<meta property="og:title" content="Nonormal">
<meta property="og:description" content="Performance footwear built for runners.">
<script type="application/ld+json">${HOME_JSONLD}</script>
</head><body>home</body></html>`;

const GOOD_PRODUCT = `<!doctype html><html><head><title>Cloud Runner</title>
<script type="application/ld+json">${PRODUCT_JSONLD}</script>
</head><body>product</body></html>`;

const SITEMAP = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  + '<url><loc>https://shop.test/products/cloud-runner</loc></url></urlset>';

type Route = () => Response;

/** Build a fetch stub from a `{ pathname: route }` map; unknown paths 404. */
function routed(routes: Record<string, Route>): FetchLike {
  return async (url: string) => {
    const route = routes[new URL(url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
}

function html(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });
}

function statusOf(result: { checks: CheckResult[] }, id: string): CheckStatus {
  const check = result.checks.find((item) => item.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.status;
}

describe('gtm.visibility-audit', () => {
  it('scores a healthy store high and passes every check', async () => {
    const result = await runVisibilityAudit('shop.test', {
      fetchImpl: routed({
        '/': () => html(GOOD_HOME),
        '/robots.txt': () => new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
        '/llms.txt': () => new Response('# Nonormal\nPerformance footwear.\n', { status: 200 }),
        '/sitemap.xml': () => new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } }),
        '/products.json': () => new Response(JSON.stringify({ products: [{ handle: 'cloud-runner', title: 'Cloud Runner' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }),
        '/products/cloud-runner': () => html(GOOD_PRODUCT)
      })
    });

    expect(result.domain).toBe('shop.test');
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(statusOf(result, 'structured_data_product')).toBe('pass');
    expect(statusOf(result, 'robots_ai_bots')).toBe('pass');
    expect(statusOf(result, 'products_feed')).toBe('pass');
    expect(statusOf(result, 'structured_data_home')).toBe('pass');
    expect(statusOf(result, 'meta_quality')).toBe('pass');
    expect(result.topFinding).toContain('well-prepared');
    expect(result.evidence).toEqual([]);
  });

  it('scores a store low when AI bots are blocked and product schema is missing', async () => {
    const robots = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n';
    const result = await runVisibilityAudit('blocked.test', {
      fetchImpl: routed({
        '/': () => html('<html><head><title>Shop</title></head><body>x</body></html>'),
        '/robots.txt': () => new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } })
      })
    });

    expect(result.score).toBeLessThanOrEqual(20);
    expect(statusOf(result, 'robots_ai_bots')).toBe('fail');
    expect(statusOf(result, 'structured_data_product')).toBe('skip');
    expect(result.topFinding).toContain('GPTBot');
    expect(result.topFinding).toContain('PerplexityBot');
    expect(result.topFinding).toContain('robots.txt');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('degrades a partial network failure to skips and renormalizes the score', async () => {
    const result = await runVisibilityAudit('flaky.test', {
      fetchImpl: async (url: string) => {
        if (new URL(url).pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { status: 200 });
        throw new TypeError('network down');
      }
    });

    expect(statusOf(result, 'robots_ai_bots')).toBe('pass');
    expect(statusOf(result, 'structured_data_product')).toBe('skip');
    expect(statusOf(result, 'products_feed')).toBe('skip');
    expect(statusOf(result, 'structured_data_home')).toBe('skip');
    expect(result.checks.filter((check) => check.status === 'skip').length).toBeGreaterThanOrEqual(4);
    // The one check that answered passed, so renormalization must report 100 -
    // not 25/100 as it would if skipped weights stayed in the denominator.
    expect(result.score).toBe(100);
  });

  it('orders checks by display priority', async () => {
    const result = await runVisibilityAudit('order.test', { fetchImpl: routed({}) });
    expect(result.checks.map((check) => check.id)).toEqual([...CHECK_ORDER]);
  });

  it('rejects a non-public domain before any probe runs', async () => {
    const fetchImpl = routed({});
    await expect(runVisibilityAudit('localhost', { fetchImpl })).rejects.toThrow('localhost not allowed');
    await expect(runVisibilityAudit('http://169.254.169.254/latest', { fetchImpl })).rejects.toThrow('raw IP address not allowed');
  });

  const robotsVariants: Array<[string, CheckStatus]> = [
    ['User-agent: *\nDisallow: /\n', 'fail'],
    ['User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\n', 'fail'],
    ['User-agent: *\nDisallow: /checkout\n', 'pass'],
    ['User-agent: Googlebot\nDisallow: /\n', 'pass']
  ];

  for (const [robots, expected] of robotsVariants) {
    it(`reads robots.txt variant ${JSON.stringify(robots)} as ${expected}`, async () => {
      const result = await runVisibilityAudit('r.test', {
        fetchImpl: routed({
          '/': () => html('<html><head><title>Shop</title></head></html>'),
          '/robots.txt': () => new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } })
        })
      });
      expect(statusOf(result, 'robots_ai_bots')).toBe(expected);
    });
  }
});

describe('parseRobots', () => {
  it('shares the following rules across consecutive User-agent lines', () => {
    const agents = parseRobots(['User-agent: GPTBot', 'User-agent: ClaudeBot', 'Disallow: /', '', 'User-agent: *', 'Allow: /'].join('\n'));
    expect(agents.get('gptbot')).toEqual([['disallow', '/']]);
    expect(agents.get('claudebot')).toEqual([['disallow', '/']]);
    expect(agents.get('*')).toEqual([['allow', '/']]);
  });

  it('starts a fresh group when a User-agent line follows a rule', () => {
    const agents = parseRobots(['User-agent: A', 'Disallow: /a', 'User-agent: B', 'Disallow: /b'].join('\n'));
    expect(agents.get('a')).toEqual([['disallow', '/a']]);
    expect(agents.get('b')).toEqual([['disallow', '/b']]);
  });

  it('ignores comments, blank lines, and unrelated directives', () => {
    const agents = parseRobots(['# hello', 'Sitemap: https://x.test/sitemap.xml', 'User-agent: *  # everyone', 'Crawl-delay: 5', 'Disallow: /admin'].join('\n'));
    expect(agents.get('*')).toEqual([['disallow', '/admin']]);
    expect(agents.has('sitemap')).toBe(false);
  });

  it('records a declared agent with no rules as unrestricted', () => {
    const agents = parseRobots('User-agent: GPTBot\n');
    expect(agents.get('gptbot')).toEqual([]);
  });
});

describe('scoreChecks renormalization', () => {
  const build = (id: string, status: CheckStatus): CheckResult => ({
    id,
    label: id,
    status,
    detail: '',
    evidence: null,
    weight: WEIGHTS[id] ?? 0,
    impact: null
  });

  it('drops skipped checks from both numerator and denominator', () => {
    expect(scoreChecks([build('structured_data_product', 'pass'), ...CHECK_ORDER.slice(1).map((id) => build(id, 'skip'))])).toBe(100);
    expect(scoreChecks([build('structured_data_product', 'fail'), ...CHECK_ORDER.slice(1).map((id) => build(id, 'skip'))])).toBe(0);
  });

  it('halves the weight of a warn', () => {
    expect(scoreChecks([build('robots_ai_bots', 'warn'), build('sitemap', 'skip')])).toBe(50);
  });

  it('weights checks by importance', () => {
    // 30-weight product check passes, 25-weight robots check fails -> 30/55.
    expect(scoreChecks([build('structured_data_product', 'pass'), build('robots_ai_bots', 'fail')])).toBe(55);
  });

  it('returns 0 when everything skipped', () => {
    expect(scoreChecks(CHECK_ORDER.map((id) => build(id, 'skip')))).toBe(0);
  });
});
