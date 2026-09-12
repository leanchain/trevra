import { describe, expect, it } from 'vitest';
import { crawlStorefront, scoreStorefrontPlatforms } from './crawler.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/html' } });
}

function xml(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': 'application/xml' } });
}

describe('storefront crawler', () => {
  it('detects a headless Shopify store from the live public catalog without a duplicate probe request', async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      seen.push(input);
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') return html('<html><h1>Minimal headless shop</h1></html>');
      if (url.pathname === '/products.json' && url.searchParams.get('limit') === '250') {
        return json({
          products: [
            { id: 10, title: 'Runner' },
            { id: 11, title: 'Hiker' }
          ]
        });
      }
      return json({ error: 'not found' }, 404);
    };

    const result = await crawlStorefront('shop.example', { fetchImpl, maxRequests: 6 });

    expect(result.platform).toBe('shopify');
    expect(result.platformConfidence).toBe(1);
    expect(result.platformSignals).toContain('endpoint:shopify_products');
    expect(result.productItems).toEqual([
      { key: '10', label: 'Runner' },
      { key: '11', label: 'Hiker' }
    ]);
    expect(result.productUrl).toBe('https://shop.example/products.json?limit=250');
    expect(seen.filter((url) => url.includes('/products.json'))).toHaveLength(1);
  });

  it('prefers WooCommerce to generic WordPress and captures its catalog', async () => {
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/') {
        return html(
          '<html><body class="woocommerce"><script src="/wp-content/plugins/woocommerce/a.js"></script></body></html>'
        );
      }
      if (
        url.pathname === '/wp-json/wc/store/v1/products' &&
        url.searchParams.get('per_page') === '100'
      ) {
        return json([{ id: 42, name: 'Boot' }]);
      }
      return json({ error: 'not found' }, 404);
    };

    const result = await crawlStorefront('woo.example', { fetchImpl });

    expect(result.platform).toBe('woocommerce');
    expect(result.platformSignals).toContain('endpoint:wc_store_products');
    expect(result.productItems).toEqual([{ key: '42', label: 'Boot' }]);
  });

  it('paginates a large public Shopify catalog within explicit product and request bounds', async () => {
    const first = Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
      title: `P${index + 1}`
    }));
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/')
        return html('<html><script src="https://cdn.shopify.com/a.js"></script></html>');
      if (url.pathname === '/products.json') {
        return url.searchParams.get('page') === '2'
          ? json({ products: [{ id: 251, title: 'P251' }] })
          : json({ products: first });
      }
      return json({}, 404);
    };

    const result = await crawlStorefront('large.example', {
      fetchImpl,
      maxRequests: 8,
      maxCatalogRequests: 3,
      maxProducts: 1_000
    });

    expect(result.productItems).toHaveLength(251);
    expect(result.productItems).toContainEqual({ key: '251', label: 'P251' });
    expect(result.productCapped).toBe(false);
  });

  it('marks the catalog capped when pagination repeats instead of looping forever', async () => {
    const page = Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
      title: `P${index + 1}`
    }));
    let productReads = 0;
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/')
        return html('<html><script src="https://cdn.shopify.com/a.js"></script></html>');
      if (url.pathname === '/products.json') {
        productReads += 1;
        return json({ products: page });
      }
      return json({}, 404);
    };

    const result = await crawlStorefront('repeat.example', {
      fetchImpl,
      maxRequests: 10,
      maxCatalogRequests: 5
    });

    expect(productReads).toBe(2);
    expect(result.productItems).toHaveLength(250);
    expect(result.productCapped).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/repeated page/i);
  });

  it('uses an explicit product sitemap as a platform-agnostic catalog fallback', async () => {
    const seen: string[] = [];
    const result = await crawlStorefront('magento.example', {
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/') return html('<script type="text/x-magento-init">{}</script>');
        if (url.pathname === '/sitemap.xml') {
          return xml(`<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://magento.example/sitemap-products.xml</loc></sitemap>
            <sitemap><loc>https://magento.example/sitemap-pages.xml</loc></sitemap>
          </sitemapindex>`);
        }
        if (url.pathname === '/sitemap-products.xml') {
          return xml(`<urlset>
            <url><loc>https://magento.example/running-shoe.html</loc></url>
            <url><loc>https://magento.example/hiking-boot.html</loc></url>
          </urlset>`);
        }
        return new Response('not found', { status: 404 });
      }
    });

    expect(result.platform).toBe('magento');
    expect(result.productItems).toEqual([
      { key: '/hiking-boot.html', label: 'hiking boot' },
      { key: '/running-shoe.html', label: 'running shoe' }
    ]);
    expect(result.productUrl).toBe('https://magento.example/sitemap-products.xml');
    expect(result.productCapped).toBe(false);
    expect(seen.some((url) => url.includes('sitemap-pages'))).toBe(false);
  });

  it('accepts only clear product paths from a generic urlset sitemap', async () => {
    const result = await crawlStorefront('custom.example', {
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/') return html('<html><h1>Custom shop</h1></html>');
        if (url.pathname === '/sitemap.xml') {
          return xml(`<urlset>
            <url><loc>https://custom.example/products/alpha-runner</loc></url>
            <url><loc>https://custom.example/blog/launch-story</loc></url>
            <url><loc>https://elsewhere.example/products/not-ours</loc></url>
          </urlset>`);
        }
        return new Response('not found', { status: 404 });
      }
    });
    expect(result.productItems).toEqual([{ key: '/products/alpha-runner', label: 'alpha runner' }]);
    expect(result.productCapped).toBe(false);
  });

  it('marks sitemap catalogs capped when the request ceiling leaves product sitemaps unread', async () => {
    const result = await crawlStorefront('bounded.example', {
      maxCatalogRequests: 2,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        if (url.pathname === '/') return html('<script type="text/x-magento-init">{}</script>');
        if (url.pathname === '/sitemap.xml') {
          return xml(`<sitemapindex>
            <sitemap><loc>https://bounded.example/product-a.xml</loc></sitemap>
            <sitemap><loc>https://bounded.example/product-b.xml</loc></sitemap>
          </sitemapindex>`);
        }
        if (url.pathname === '/product-a.xml') {
          return xml('<urlset><url><loc>https://bounded.example/a.html</loc></url></urlset>');
        }
        throw new Error(`unexpected request ${input}`);
      }
    });
    expect(result.productItems).toEqual([{ key: '/a.html', label: 'a' }]);
    expect(result.productCapped).toBe(true);
  });

  it('can fingerprint the homepage without spending any requests on product APIs', async () => {
    const seen: string[] = [];
    const result = await crawlStorefront('site.example', {
      captureProducts: false,
      fetchImpl: async (input) => {
        seen.push(input);
        const url = new URL(input);
        if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
        return html('<html><body data-wf-domain="site.example"></body></html>');
      }
    });

    expect(result.platform).toBe('webflow');
    expect(result.productItems).toBeNull();
    expect(seen.some((url) => url.includes('products.json') || url.includes('/wc/'))).toBe(false);
  });

  it('carries over the broader ecom platform fingerprints without calling Beseam', () => {
    expect(
      scoreStorefrontPlatforms('<script type="text/x-magento-init">{}</script>').scores.get(
        'magento'
      )
    ).toBe(0.9);
    expect(
      scoreStorefrontPlatforms(
        '<script src="https://cdn11.bigcommerce.com/x.js"></script>'
      ).scores.get('bigcommerce')
    ).toBe(0.85);
    expect(
      scoreStorefrontPlatforms('<body data-wf-domain="shop.example"></body>').scores.get('webflow')
    ).toBe(0.8);
  });
});
