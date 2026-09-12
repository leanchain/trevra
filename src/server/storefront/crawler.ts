import { createPublicWebCrawler, type PublicWebCrawler } from '../crawl/public-web.js';
import type { FetchLike } from '../skills/guard.js';
import type { Probe } from '../skills/probe.js';

/**
 * Trevra-owned public storefront crawler.
 *
 * This module deliberately has no dependency on Beseam/ecom storage or jobs.
 * The platform fingerprints and public endpoint probes are adapted from the
 * proven ecom shop-corpus crawler, but crawl execution and state belong to
 * Trevra. Other Trevra features can reuse this module without going through
 * account-signal code.
 */

export const STOREFRONT_PLATFORMS = [
  'shopify',
  'woocommerce',
  'wordpress',
  'magento',
  'wix',
  'shopware',
  'bigcommerce',
  'prestashop',
  'webflow',
  'other'
] as const;

export type StorefrontPlatform = (typeof STOREFRONT_PLATFORMS)[number];

export interface StorefrontProduct {
  key: string;
  label: string;
}

export interface StorefrontCrawl {
  domain: string;
  homeUrl: string;
  homeHtml: string | null;
  homeHeaders: Headers | null;
  platform: StorefrontPlatform;
  platformConfidence: number;
  platformSignals: string[];
  productUrl: string | null;
  productItems: StorefrontProduct[] | null;
  productCapped: boolean;
  requestsUsed: number;
  warnings: string[];
}

export interface StorefrontCrawlerOptions {
  fetchImpl?: FetchLike;
  /** Hard network ceiling for one storefront crawl, including the homepage. */
  maxRequests?: number;
  /** Reuse a broader Trevra crawl session when the caller is also checking hiring/pricing/site pages. */
  crawler?: PublicWebCrawler;
  /** Optional prior only. Trevra still probes the live storefront independently. */
  platformHint?: 'shopify' | 'woocommerce' | null;
}

type Scores = Map<StorefrontPlatform, number>;
type Signals = Map<StorefrontPlatform, string[]>;

const PLATFORM_PRIORITY: Record<StorefrontPlatform, number> = {
  shopify: 90,
  woocommerce: 80,
  magento: 70,
  shopware: 65,
  bigcommerce: 60,
  prestashop: 55,
  wix: 50,
  webflow: 40,
  wordpress: 30,
  other: 0
};

function addSignal(
  scores: Scores,
  signals: Signals,
  platform: StorefrontPlatform,
  score: number,
  signal: string
) {
  scores.set(platform, (scores.get(platform) ?? 0) + score);
  const list = signals.get(platform) ?? [];
  if (!list.includes(signal)) list.push(signal);
  signals.set(platform, list);
}

function containsAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

/** HTML platform fingerprints adapted from ecom's shop-corpus crawler. */
export function scoreStorefrontPlatforms(html: string | null): {
  scores: Scores;
  signals: Signals;
} {
  const scores: Scores = new Map();
  const signals: Signals = new Map();
  if (!html) return { scores, signals };

  const lowered = html.toLowerCase();
  const generator = [
    ...html.matchAll(/<meta\b[^>]*name=["']generator["'][^>]*content=["']([^"']+)["'][^>]*>/gi)
  ]
    .map((match) => match[1]?.toLowerCase() ?? '')
    .join(' ');
  const bodyClasses = html.match(/<body\b[^>]*class=["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? '';

  if (containsAny(lowered, ['cdn.shopify.com', 'myshopify.com', 'shopify.theme', 'shopify.routes']))
    addSignal(scores, signals, 'shopify', 0.9, 'html:shopify_assets_or_globals');
  else if (lowered.includes('shopify')) addSignal(scores, signals, 'shopify', 0.2, 'html:shopify');

  if (
    containsAny(lowered, [
      'wp-content/plugins/woocommerce',
      'woocommerce_params',
      'wc_single_product_params',
      'wc-ajax',
      'woocommerce-product-gallery'
    ]) ||
    bodyClasses.includes('woocommerce')
  )
    addSignal(scores, signals, 'woocommerce', 0.9, 'html:woocommerce_assets_or_classes');
  else if (lowered.includes('woocommerce'))
    addSignal(scores, signals, 'woocommerce', 0.45, 'html:woocommerce');

  if (containsAny(lowered, ['wp-content/', 'wp-includes/', '/wp-json/']))
    addSignal(scores, signals, 'wordpress', 0.6, 'html:wordpress_assets_or_rest');
  if (generator.includes('wordpress'))
    addSignal(scores, signals, 'wordpress', 0.5, 'meta:generator=wordpress');

  if (
    containsAny(lowered, [
      'x-magento-init',
      'mage-init',
      'magento_ui/js',
      'catalog-product-view',
      'mage/cookies',
      'form_key'
    ])
  )
    addSignal(scores, signals, 'magento', 0.9, 'html:magento_runtime');
  if (
    containsAny(lowered, [
      'static.parastorage.com',
      'siteassets.parastorage.com',
      'wix-image://',
      'wix.com',
      'wixstatic.com'
    ])
  )
    addSignal(scores, signals, 'wix', 0.9, 'html:wix_assets');
  if (generator.includes('wix')) addSignal(scores, signals, 'wix', 0.6, 'meta:generator=wix');
  if (
    containsAny(lowered, [
      'shopware',
      '/store-api/',
      'sw-cache-hash',
      'data-sw-access-key',
      'shopwarefrontends'
    ])
  )
    addSignal(scores, signals, 'shopware', 0.85, 'html:shopware_runtime');
  if (containsAny(lowered, ['bigcommerce', 'cdn11.bigcommerce.com', 'stencil-utils', 'stencil']))
    addSignal(scores, signals, 'bigcommerce', 0.85, 'html:bigcommerce_assets');
  if (generator.includes('bigcommerce'))
    addSignal(scores, signals, 'bigcommerce', 0.7, 'meta:generator=bigcommerce');
  if (containsAny(lowered, ['prestashop', 'id_product', 'controller=product', 'static/themes']))
    addSignal(scores, signals, 'prestashop', 0.8, 'html:prestashop_runtime');
  if (generator.includes('prestashop'))
    addSignal(scores, signals, 'prestashop', 0.7, 'meta:generator=prestashop');
  if (containsAny(lowered, ['webflow', 'w-webflow', 'data-wf-domain']))
    addSignal(scores, signals, 'webflow', 0.8, 'html:webflow_runtime');

  return { scores, signals };
}

function pickPlatform(
  scores: Scores,
  signals: Signals
): {
  platform: StorefrontPlatform;
  confidence: number;
  signals: string[];
} {
  let platform: StorefrontPlatform = 'other';
  let confidence = 0;
  for (const [candidate, raw] of scores) {
    const score = Math.min(1, Math.round(raw * 100) / 100);
    if (
      score > confidence ||
      (score === confidence && PLATFORM_PRIORITY[candidate] > PLATFORM_PRIORITY[platform])
    ) {
      platform = candidate;
      confidence = score;
    }
  }
  if (confidence < 0.45) return { platform: 'other', confidence: confidence || 0.1, signals: [] };
  return { platform, confidence, signals: signals.get(platform) ?? [] };
}

function parseJson(response: Probe | null): unknown | null {
  if (!response || response.status !== 200) return null;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validShopifyProducts(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.products);
}

function validWooProducts(value: unknown): boolean {
  return Array.isArray(value);
}

function validWordpressIndex(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.namespaces);
}

function parseProducts(
  value: unknown,
  platform: 'shopify' | 'woocommerce'
): StorefrontProduct[] | null {
  const rows = platform === 'shopify' && isRecord(value) ? value.products : value;
  if (!Array.isArray(rows)) return null;
  const found = new Map<string, StorefrontProduct>();
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const rawKey = raw.id ?? raw.handle ?? raw.slug;
    const key =
      typeof rawKey === 'string' || typeof rawKey === 'number' ? String(rawKey).trim() : '';
    if (!key || found.has(key)) continue;
    const rawLabel = raw.title ?? raw.name ?? raw.handle ?? raw.slug;
    const label =
      typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.replace(/\s+/g, ' ').trim() : key;
    found.set(key, { key, label: label.slice(0, 160) });
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Crawl the public storefront directly from Trevra. No shared corpus, no
 * cross-product filesystem mount, and no assumption that Beseam has seen it.
 */
export async function crawlStorefront(
  domain: string,
  options: StorefrontCrawlerOptions = {}
): Promise<StorefrontCrawl> {
  const crawler =
    options.crawler ??
    (await createPublicWebCrawler(domain, {
      fetchImpl: options.fetchImpl,
      maxRequests: options.maxRequests ?? 6
    }));
  const clean = crawler.domain;
  const origin = crawler.origin;
  const warnings: string[] = [];

  const get = async (url: string): Promise<Probe | null> => (await crawler.get(url)).response;

  const homeUrl = `${origin}/`;
  const home = await get(homeUrl);
  const homeHtml =
    home && home.status < 400 && (!home.contentType || home.contentType.includes('html'))
      ? home.text
      : null;
  const { scores, signals } = scoreStorefrontPlatforms(homeHtml);
  if (options.platformHint)
    addSignal(scores, signals, options.platformHint, 0.2, `hint:${options.platformHint}`);

  // Direct endpoint probes are stronger than markup. Unknown/headless stores
  // are probed rather than trusting a stale imported platform tag.
  const initial = pickPlatform(scores, signals);
  const candidates = new Set<StorefrontPlatform>();
  if (initial.platform !== 'other') candidates.add(initial.platform);
  if (initial.platform === 'other' || initial.confidence < 0.8) {
    candidates.add('shopify');
    candidates.add('woocommerce');
    candidates.add('wordpress');
  } else if (initial.platform === 'wordpress') {
    candidates.add('woocommerce');
  }

  for (const candidate of candidates) {
    if (crawler.requestsRemaining <= 0) break;
    if (candidate === 'shopify') {
      const payload = parseJson(await get(`${origin}/products.json?limit=1`));
      if (validShopifyProducts(payload))
        addSignal(scores, signals, 'shopify', 1, 'endpoint:shopify_products');
    } else if (candidate === 'woocommerce') {
      const payload = parseJson(await get(`${origin}/wp-json/wc/store/v1/products?per_page=1`));
      if (validWooProducts(payload))
        addSignal(scores, signals, 'woocommerce', 1, 'endpoint:wc_store_products');
    } else if (candidate === 'wordpress') {
      const payload = parseJson(await get(`${origin}/wp-json/`));
      if (validWordpressIndex(payload))
        addSignal(scores, signals, 'wordpress', 0.8, 'endpoint:wp_rest_index');
    }
  }

  const picked = pickPlatform(scores, signals);
  let productUrl: string | null = null;
  let productItems: StorefrontProduct[] | null = null;
  let productCapped = false;

  if (picked.platform === 'shopify' && crawler.requestsRemaining > 0) {
    productUrl = `${origin}/products.json?limit=250`;
    const payload = parseJson(await get(productUrl));
    productItems = validShopifyProducts(payload) ? parseProducts(payload, 'shopify') : null;
    if (productItems) productCapped = productItems.length >= 250;
  } else if (picked.platform === 'woocommerce' && crawler.requestsRemaining > 0) {
    productUrl = `${origin}/wp-json/wc/store/v1/products?per_page=100`;
    const payload = parseJson(await get(productUrl));
    productItems = validWooProducts(payload) ? parseProducts(payload, 'woocommerce') : null;
    if (productItems) productCapped = productItems.length >= 100;
  }

  if (!homeHtml) warnings.push('Homepage could not be captured as HTML.');
  if (productUrl && productItems === null)
    warnings.push(`Public catalog endpoint did not return a usable payload: ${productUrl}`);

  return {
    domain: clean,
    homeUrl,
    homeHtml,
    homeHeaders: home?.headers ?? null,
    platform: picked.platform,
    platformConfidence: picked.confidence,
    platformSignals: picked.signals,
    productUrl: productItems === null ? null : productUrl,
    productItems,
    productCapped,
    requestsUsed: crawler.requestsUsed,
    warnings
  };
}
