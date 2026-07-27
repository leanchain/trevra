import { describe, expect, it } from 'vitest';
import { detectTech, enrichCompany, toLeadFields, type CompanyProfile } from './enrich.js';
import type { FetchLike } from './guard.js';
import { scoreLead } from './score.js';

const ORG_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Nonormal',
  legalName: 'Nonormal Athletics GmbH',
  description: 'Performance footwear for runners who want speed and comfort.',
  url: 'https://shop.test',
  logo: { '@type': 'ImageObject', url: 'https://shop.test/logo.png' },
  email: 'Hello@Shop.test',
  telephone: '+41 44 000 00 00',
  sameAs: ['https://www.linkedin.com/company/nonormal', 'https://instagram.com/nonormal'],
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Bahnhofstrasse 1',
    addressLocality: 'Zurich',
    postalCode: '8001',
    addressCountry: { '@type': 'Country', name: 'Switzerland' }
  }
});

const HOME = `<!doctype html><html><head>
<title>Nonormal - Performance Footwear</title>
<meta name="description" content="Performance footwear for runners.">
<meta property="og:site_name" content="Nonormal">
<script type="application/ld+json">${ORG_JSONLD}</script>
<script src="https://cdn.shopify.com/s/files/theme.js"></script>
<script src="https://js.hs-scripts.com/1234.js"></script>
</head><body>
<a href="mailto:press@shop.test">Press</a>
<a href="https://x.com/nonormal">Follow</a>
<a href="/careers">Careers</a>
</body></html>`;

type Route = () => Response;

function routed(routes: Record<string, Route>): FetchLike {
  return async (url: string) => {
    const route = routes[new URL(url).pathname];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
}

function html(text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}

function productsJson(count: number): Response {
  const products = Array.from({ length: count }, (_, index) => ({ handle: `p-${index}`, title: `Product ${index}` }));
  return new Response(JSON.stringify({ products }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const FULL_SITE: Record<string, Route> = {
  '/': () => html(HOME),
  '/products.json': () => productsJson(187),
  '/careers': () => html('<html><body><h1>Open roles</h1></body></html>'),
  '/pricing': () => new Response('nope', { status: 404 }),
  '/plans': () => new Response('nope', { status: 404 }),
  '/blog': () => html('<html><body><h1>Blog</h1></body></html>')
};

describe('gtm.enrich-company', () => {
  it('derives firmographics, platform, catalog, and page presence from the site alone', async () => {
    const profile = await enrichCompany('https://www.Shop.test/', { fetchImpl: routed(FULL_SITE) });

    expect(profile.domain).toBe('shop.test');
    expect(profile.name).toBe('Nonormal');
    expect(profile.legalName).toBe('Nonormal Athletics GmbH');
    expect(profile.description).toBe('Performance footwear for runners who want speed and comfort.');
    expect(profile.logoUrl).toBe('https://shop.test/logo.png');
    expect(profile.telephone).toBe('+41 44 000 00 00');
    expect(profile.address).toEqual({
      streetAddress: 'Bahnhofstrasse 1',
      addressLocality: 'Zurich',
      addressRegion: null,
      postalCode: '8001',
      addressCountry: 'Switzerland'
    });
    expect(profile.country).toBe('Switzerland');

    // JSON-LD email plus the mailto: published in the body, both lowercased.
    expect(profile.emails).toEqual(['hello@shop.test', 'press@shop.test']);
    expect(profile.sameAs).toEqual([
      'https://instagram.com/nonormal',
      'https://www.linkedin.com/company/nonormal',
      'https://x.com/nonormal'
    ]);

    expect(profile.platform).toBe('shopify');
    expect(profile.tech.map((item) => item.key)).toEqual(['shopify', 'hubspot']);
    expect(profile.catalogSize).toBe(187);
    expect(profile.catalogCapped).toBe(false);

    expect(profile.pages).toEqual([
      { kind: 'careers', url: 'https://shop.test/careers', present: true },
      { kind: 'pricing', url: null, present: false },
      { kind: 'blog', url: 'https://shop.test/blog', present: true }
    ]);
    expect(profile.degraded).toEqual([]);
  });

  it('attaches an evidence row naming the marker behind every derived field', async () => {
    const profile = await enrichCompany('shop.test', { fetchImpl: routed(FULL_SITE) });
    const labels = profile.evidence.map((row) => row.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Company name', 'Description', 'Postal address', 'Published email', 'Social profiles', 'Catalog size', 'Platform'])
    );
    const platform = profile.evidence.find((row) => row.label === 'Platform');
    expect(platform?.detail).toContain('cdn.shopify.com');
    expect(profile.evidence.every((row) => row.detail.length > 0)).toBe(true);
  });

  it('reports a capped products.json as "at least", never as an exact count', async () => {
    const profile = await enrichCompany('shop.test', {
      fetchImpl: routed({ '/': () => html(HOME), '/products.json': () => productsJson(250) })
    });
    expect(profile.catalogSize).toBe(250);
    expect(profile.catalogCapped).toBe(true);
    expect(profile.evidence.find((row) => row.label === 'Catalog size')?.detail).toContain('250+');
  });

  it('does not report a soft 404 that renders the homepage as a real page', async () => {
    const profile = await enrichCompany('shop.test', {
      fetchImpl: routed({ '/': () => html(HOME), '/careers': () => html(HOME), '/jobs': () => html(HOME) })
    });
    expect(profile.pages.find((page) => page.kind === 'careers')).toEqual({ kind: 'careers', url: null, present: false });
  });

  it('degrades a total outage to a null-filled but usable profile', async () => {
    const profile = await enrichCompany('down.test', {
      fetchImpl: async () => {
        throw new TypeError('network down');
      }
    });
    expect(profile.domain).toBe('down.test');
    expect(profile.name).toBeNull();
    expect(profile.platform).toBeNull();
    expect(profile.catalogSize).toBeNull();
    expect(profile.degraded).toContain('homepage');
    expect(profile.pages.every((page) => !page.present)).toBe(true);
  });

  it('rejects a non-public host before any probe runs', async () => {
    const fetchImpl = routed({});
    await expect(enrichCompany('localhost', { fetchImpl })).rejects.toThrow('localhost not allowed');
    await expect(enrichCompany('http://169.254.169.254/', { fetchImpl })).rejects.toThrow('raw IP address not allowed');
  });

  it('never exceeds the page budget', async () => {
    let calls = 0;
    await enrichCompany('shop.test', {
      pageBudget: 3,
      fetchImpl: async (url: string) => {
        calls += 1;
        return routed(FULL_SITE)(url);
      }
    });
    expect(calls).toBe(3);
  });
});

describe('detectTech', () => {
  it('reads the commerce platform ahead of the rendering framework', () => {
    const markup = '<div id="__NEXT_DATA__"></div><script src="https://cdn.shopify.com/x.js"></script>';
    const found = detectTech(markup, null);
    expect(found.map((item) => item.key)).toEqual(['shopify', 'nextjs']);
    expect(found.find((item) => item.platform)?.key).toBe('shopify');
  });

  it('detects from response headers when the markup says nothing', () => {
    const headers = new Headers({ 'x-shopid': '12345', 'x-powered-by': 'Next.js' });
    const found = detectTech('<html></html>', headers);
    expect(found.map((item) => item.key)).toEqual(['shopify', 'nextjs']);
    expect(found[0].marker).toBe('x-shopid response header');
    expect(found[1].marker).toBe('x-powered-by: Next.js');
  });

  it('detects from a generator meta tag', () => {
    const found = detectTech('<meta name="generator" content="WordPress 6.5">', null);
    expect(found).toEqual([{ key: 'wordpress', label: 'WordPress', platform: true, marker: '<meta name="generator"> reads "WordPress 6.5"' }]);
  });

  it('falls back to a Shopify product feed when nothing else identifies the stack', () => {
    expect(detectTech('<html></html>', null, true)).toEqual([
      { key: 'shopify', label: 'Shopify', platform: true, marker: '/products.json returns a Shopify product feed' }
    ]);
  });
});

describe('toLeadFields', () => {
  const profile = (overrides: Partial<CompanyProfile> = {}): CompanyProfile => ({
    domain: 'shop.test',
    name: 'Nonormal',
    legalName: null,
    description: 'Performance footwear for runners.',
    url: null,
    logoUrl: null,
    emails: ['hello@shop.test', 'press@shop.test'],
    telephone: null,
    sameAs: [],
    address: null,
    country: null,
    platform: 'shopify',
    tech: [],
    catalogSize: 187,
    catalogCapped: false,
    pages: [],
    degraded: [],
    generatedAt: '2026-07-27T00:00:00.000Z',
    evidence: [],
    ...overrides
  });

  it('feeds gtm.score-lead directly', () => {
    const lead = toLeadFields(profile());
    expect(lead).toEqual({
      platform: 'shopify',
      vertical: 'footwear',
      catalogSize: 187,
      contactEmail: 'hello@shop.test',
      emails: ['hello@shop.test', 'press@shop.test']
    });
    const scored = scoreLead(lead);
    expect(scored.wedge).toBe('sizing');
    expect(scored.overall).toBeGreaterThan(0.7);
  });

  it('matches a vertical on word boundaries, so "abundance" is not "dance"', () => {
    expect(toLeadFields(profile({ description: 'We sell abundance.' }), ['dance']).vertical).toBeNull();
    expect(toLeadFields(profile({ description: 'Shoes for dance studios.' }), ['dance']).vertical).toBe('dance');
  });

  it('reports an unmatched vertical as null rather than guessing', () => {
    expect(toLeadFields(profile({ description: 'Industrial fasteners.', name: null })).vertical).toBeNull();
  });
});
