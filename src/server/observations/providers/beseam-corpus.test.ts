import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db.js';
import { beseamCorpusObservationProvider } from './beseam-corpus.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function fakeDb(): Db {
  let stored: unknown = null;
  return {
    prepare(sql: string) {
      return {
        async get() {
          return sql.includes('SELECT') && stored ? { snapshot_json: stored } : undefined;
        },
        async all() {
          return [];
        },
        async run(...params: unknown[]) {
          if (sql.includes('INSERT INTO research_snapshots'))
            stored = JSON.parse(String(params[4]));
          return { changes: 1 };
        }
      };
    }
  } as unknown as Db;
}

async function corpusFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trevra-beseam-'));
  roots.push(root);
  const domainDir = path.join(root, 'shop.example');
  await fs.mkdir(path.join(domainDir, 'public_data'), { recursive: true });
  await fs.mkdir(path.join(domainDir, 'pages'), { recursive: true });

  async function write(input: {
    generatedAt: string;
    products: Array<{ id: number; title: string }>;
    homeHtml: string;
    platform?: string;
  }) {
    const homeName = '01-home-home-test.html';
    await fs.writeFile(path.join(domainDir, 'pages', homeName), input.homeHtml);
    await fs.writeFile(
      path.join(domainDir, 'public_data', 'shopify_products.json'),
      JSON.stringify({ products: input.products })
    );
    await fs.writeFile(
      path.join(domainDir, 'domain_summary.json'),
      JSON.stringify({
        generated_at: input.generatedAt,
        domain: 'shop.example',
        base_url: 'https://shop.example',
        platform: input.platform ?? 'shopify',
        platform_confidence: 0.95,
        public_standard_endpoints: [
          {
            key: 'shopify_products',
            url: 'https://shop.example/products.json?limit=250',
            valid_response: true
          }
        ],
        fetched_pages: [
          {
            page_type: 'home',
            saved_html: `pipelines/shop-corpus/domains/shop.example/pages/${homeName}`
          }
        ]
      })
    );
  }

  return { root, write };
}

describe('Beseam corpus observation provider', () => {
  it('uses the first corpus read as a baseline, then emits product and app changes from later crawls', async () => {
    const fixture = await corpusFixture();
    const db = fakeDb();
    const provider = beseamCorpusObservationProvider(fixture.root);
    const credentials = { get: () => undefined };

    await fixture.write({
      generatedAt: '2026-09-10T08:00:00.000Z',
      products: [{ id: 1, title: 'Alpha' }],
      homeHtml: '<html><script src="https://cdn.shopify.com/shop.js"></script></html>'
    });
    const first = await provider.observe('shop.example', {
      credentials,
      now: new Date('2026-09-10T09:00:00.000Z'),
      db,
      workspaceId: 'ws_test'
    });
    expect(first.observations).toEqual([]);

    await fixture.write({
      generatedAt: '2026-09-12T08:00:00.000Z',
      products: [
        { id: 1, title: 'Alpha' },
        { id: 2, title: 'Autumn Drop' }
      ],
      homeHtml:
        '<html><script src="https://cdn.shopify.com/shop.js"></script><script src="https://static.klaviyo.com/onsite/js.js"></script></html>'
    });
    const second = await provider.observe('shop.example', {
      credentials,
      now: new Date('2026-09-12T09:00:00.000Z'),
      db,
      workspaceId: 'ws_test'
    });
    expect(second.observations.map((observation) => observation.kind)).toEqual([
      'product-launch',
      'commerce-app-added'
    ]);
    expect(second.observations[0].detail).toContain('Autumn Drop');
    expect(second.observations[0].evidenceUrl).toContain('/products.json');
    expect(second.observations[1].detail).toContain('klaviyo');
    expect(
      second.observations.every(
        (observation) => observation.observedAt === '2026-09-12T08:00:00.000Z'
      )
    ).toBe(true);
  });

  it('only calls a platform migration a storefront rebuild when both crawl classifications are strong', async () => {
    const fixture = await corpusFixture();
    const db = fakeDb();
    const provider = beseamCorpusObservationProvider(fixture.root);
    const credentials = { get: () => undefined };

    await fixture.write({
      generatedAt: '2026-09-10T08:00:00.000Z',
      products: [],
      homeHtml: '<html><script src="https://cdn.shopify.com/shop.js"></script></html>',
      platform: 'shopify'
    });
    await provider.observe('shop.example', {
      credentials,
      now: new Date('2026-09-10T09:00:00.000Z'),
      db,
      workspaceId: 'ws_test'
    });

    await fixture.write({
      generatedAt: '2026-09-12T08:00:00.000Z',
      products: [],
      homeHtml: '<html><div class="woocommerce-product-gallery"></div></html>',
      platform: 'woocommerce'
    });
    const result = await provider.observe('shop.example', {
      credentials,
      now: new Date('2026-09-12T09:00:00.000Z'),
      db,
      workspaceId: 'ws_test'
    });
    expect(
      result.observations.some((observation) => observation.kind === 'storefront-rebuild')
    ).toBe(true);
  });
});
