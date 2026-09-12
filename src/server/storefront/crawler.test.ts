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

describe('storefront crawler', () => {
  it('detects a headless Shopify store by probing the live public catalog', async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      seen.push(input);
      const url = new URL(input);
      if (url.pathname === '/') return html('<html><h1>Minimal headless shop</h1></html>');
      if (url.pathname === '/products.json' && url.searchParams.get('limit') === '1') {
        return json({ products: [{ id: 1, title: 'Probe' }] });
      }
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
    expect(seen).toContain('https://shop.example/products.json?limit=1');
  });

  it('prefers WooCommerce to generic WordPress and captures its catalog', async () => {
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname === '/') {
        return html(
          '<html><body class="woocommerce"><script src="/wp-content/plugins/woocommerce/a.js"></script></body></html>'
        );
      }
      if (
        url.pathname === '/wp-json/wc/store/v1/products' &&
        url.searchParams.get('per_page') === '1'
      ) {
        return json([{ id: 1, name: 'Probe' }]);
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
