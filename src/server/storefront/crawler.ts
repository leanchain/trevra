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
  /** Bound catalog enumeration even when a public endpoint is extremely large. */
  maxProducts?: number;
  /** Bound requests spent on commerce endpoints so other observers keep crawl budget. */
  maxCatalogRequests?: number;
  /** Consumers that only need homepage/platform evidence can disable catalog acquisition. */
  captureProducts?: boolean;
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

const PRODUCT_SITEMAP_RE = /(?:^|[-_.\/])(products?|catalog)(?:[-_.\/]|$)/i;
const PRODUCT_PATH_RE = /\/(?:products?|product|catalog\/product|p)\//i;

function xmlText(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function sitemapLocs(xml: string, kind: 'index' | 'urlset'): string[] {
  const block = kind === 'index' ? 'sitemap' : 'url';
  const found: string[] = [];
  const pattern = new RegExp(
    `<${block}\\b[^>]*>[\\s\\S]*?<loc\\b[^>]*>([\\s\\S]*?)<\\/loc>[\\s\\S]*?<\\/${block}>`,
    'gi'
  );
  for (const match of xml.matchAll(pattern)) {
    const loc = xmlText((match[1] ?? '').replace(/<[^>]*>/g, '').trim());
    if (loc && !found.includes(loc)) found.push(loc);
  }
  return found;
}

function sameStorefrontUrl(urlValue: string, origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }
  const base = new URL(origin);
  const sameCanonicalHost =
    url.hostname === base.hostname ||
    url.hostname === `www.${base.hostname}` ||
    base.hostname === `www.${url.hostname}`;
  return url.protocol === 'https:' && sameCanonicalHost ? url : null;
}

function sitemapProduct(
  urlValue: string,
  origin: string,
  trustPath: boolean
): StorefrontProduct | null {
  const url = sameStorefrontUrl(urlValue, origin);
  if (!url) return null;
  if (!trustPath && !PRODUCT_PATH_RE.test(url.pathname)) return null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return null;
  const segment = path.split('/').filter(Boolean).at(-1) ?? path;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the encoded segment; it is still a stable public identifier.
  }
  const label =
    decoded
      .replace(/\.(?:html?|php|aspx?)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || path;
  return { key: path, label: label.slice(0, 160) };
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
      maxRequests: options.maxRequests ?? 8
    }));
  const clean = crawler.domain;
  const warnings: string[] = [];
  const maxProducts = Math.max(1, Math.min(5_000, Math.trunc(options.maxProducts ?? 1_000)));
  const maxCatalogRequests = Math.max(0, Math.min(20, Math.trunc(options.maxCatalogRequests ?? 4)));
  const captureProducts = options.captureProducts ?? true;

  const homeUrl = `${crawler.origin}/`;
  const homeResult = await crawler.get(homeUrl);
  const home = homeResult.response;
  if (homeResult.error) warnings.push(`Homepage crawl degraded: ${homeResult.error}.`);
  if (homeResult.skipped) warnings.push(`Homepage crawl skipped: ${homeResult.skipped}.`);
  const homeHtml =
    home && home.status < 400 && (!home.contentType || home.contentType.includes('html'))
      ? home.text
      : null;

  const { scores, signals } = scoreStorefrontPlatforms(homeHtml);
  if (options.platformHint)
    addSignal(scores, signals, options.platformHint, 0.2, `hint:${options.platformHint}`);

  let productUrl: string | null = null;
  let productItems: StorefrontProduct[] | null = null;
  let productCapped = false;

  const readCatalog = async (
    platform: 'shopify' | 'woocommerce'
  ): Promise<{ items: StorefrontProduct[]; url: string; capped: boolean } | null> => {
    const pageSize = platform === 'shopify' ? 250 : 100;
    const found = new Map<string, StorefrontProduct>();
    const requestsAtStart = crawler.requestsUsed;
    let page = 1;
    let capped = false;
    let firstUrl = '';

    while (
      crawler.requestsRemaining > 0 &&
      crawler.requestsUsed - requestsAtStart < maxCatalogRequests &&
      found.size < maxProducts
    ) {
      const origin = crawler.origin;
      const url =
        platform === 'shopify'
          ? `${origin}/products.json?limit=${pageSize}${page > 1 ? `&page=${page}` : ''}`
          : `${origin}/wp-json/wc/store/v1/products?per_page=${pageSize}${page > 1 ? `&page=${page}` : ''}`;
      if (!firstUrl) firstUrl = url;
      const result = await crawler.get(url);
      if (result.skipped || result.error || !result.response) {
        if (page === 1) return null;
        capped = true;
        warnings.push(
          `${platform} catalog pagination stopped at page ${page}: ${result.error ?? result.skipped ?? 'no response'}.`
        );
        break;
      }

      const payload = parseJson(result.response);
      const valid =
        platform === 'shopify' ? validShopifyProducts(payload) : validWooProducts(payload);
      if (!valid) {
        if (page === 1) return null;
        capped = true;
        warnings.push(
          `${platform} catalog pagination returned an unexpected payload at page ${page}.`
        );
        break;
      }

      const parsed = parseProducts(payload, platform) ?? [];
      let added = 0;
      for (const item of parsed) {
        if (found.has(item.key)) continue;
        found.set(item.key, item);
        added += 1;
        if (found.size >= maxProducts) break;
      }

      if (parsed.length < pageSize) break;
      if (added === 0 && page > 1) {
        capped = true;
        warnings.push(
          `${platform} catalog pagination repeated page ${page}; stopped to avoid a loop.`
        );
        break;
      }
      if (found.size >= maxProducts) {
        capped = true;
        break;
      }
      if (
        crawler.requestsRemaining <= 0 ||
        crawler.requestsUsed - requestsAtStart >= maxCatalogRequests
      ) {
        capped = true;
        break;
      }
      page += 1;
    }

    return {
      items: [...found.values()].sort((a, b) => a.key.localeCompare(b.key)),
      url: firstUrl,
      capped
    };
  };

  const readSitemapCatalog = async (
    requestsAtStart: number
  ): Promise<{ items: StorefrontProduct[]; url: string; capped: boolean } | null> => {
    const canRequest = () =>
      crawler.requestsRemaining > 0 && crawler.requestsUsed - requestsAtStart < maxCatalogRequests;
    if (!canRequest()) return null;

    const rootUrl = `${crawler.origin}/sitemap.xml`;
    const root = await crawler.get(rootUrl);
    if (root.skipped || root.error || !root.response || root.response.status !== 200) return null;
    const xml = root.response.text;
    const found = new Map<string, StorefrontProduct>();
    let capped = false;

    const addLocs = (locs: readonly string[], trustPath: boolean): void => {
      for (const loc of locs) {
        const product = sitemapProduct(loc, crawler.origin, trustPath);
        if (!product || found.has(product.key)) continue;
        found.set(product.key, product);
        if (found.size >= maxProducts) {
          capped = true;
          break;
        }
      }
    };

    if (/<urlset\b/i.test(xml)) {
      const locs = sitemapLocs(xml, 'urlset');
      addLocs(locs, false);
      if (found.size === 0) return null;
      if (found.size >= maxProducts && locs.length > found.size) capped = true;
      return {
        items: [...found.values()].sort((a, b) => a.key.localeCompare(b.key)),
        url: rootUrl,
        capped
      };
    }

    if (!/<sitemapindex\b/i.test(xml)) return null;
    const children = sitemapLocs(xml, 'index')
      .map((loc) => sameStorefrontUrl(loc, crawler.origin))
      .filter((url): url is URL => Boolean(url))
      .filter((url) => PRODUCT_SITEMAP_RE.test(url.pathname));
    if (children.length === 0) return null;

    let followed = 0;
    let firstProductSitemap: string | null = null;
    for (const child of children) {
      if (!canRequest()) {
        capped = true;
        break;
      }
      followed += 1;
      firstProductSitemap ??= child.toString();
      if (/\.gz$/i.test(child.pathname)) {
        capped = true;
        warnings.push(
          `Compressed product sitemap ${child.toString()} was left unread; catalog is partial.`
        );
        continue;
      }
      const result = await crawler.get(child.toString());
      if (result.skipped || result.error || !result.response || result.response.status !== 200) {
        capped = true;
        continue;
      }
      if (!/<urlset\b/i.test(result.response.text)) {
        capped = true;
        continue;
      }
      addLocs(sitemapLocs(result.response.text, 'urlset'), true);
      if (found.size >= maxProducts) break;
    }
    if (followed < children.length) capped = true;

    return {
      items: [...found.values()].sort((a, b) => a.key.localeCompare(b.key)),
      url: children.length === 1 && firstProductSitemap ? firstProductSitemap : rootUrl,
      capped
    };
  };

  // A full first catalog page doubles as the platform probe, avoiding the old
  // probe-then-fetch duplicate request. Unknown/headless sites try only the two
  // commerce APIs we can actually observe; generic WordPress is not probed just
  // to prove WordPress exists.
  const initial = pickPlatform(scores, signals);
  const candidates: Array<'shopify' | 'woocommerce'> = [];
  if (captureProducts && maxCatalogRequests > 0) {
    if (initial.platform === 'shopify' || initial.platform === 'woocommerce') {
      candidates.push(initial.platform);
    } else if (initial.platform === 'wordpress') {
      candidates.push('woocommerce');
    } else if (initial.platform === 'other') {
      if (options.platformHint) candidates.push(options.platformHint);
      if (!candidates.includes('shopify')) candidates.push('shopify');
      if (!candidates.includes('woocommerce')) candidates.push('woocommerce');
    }
  }

  const catalogRequestsAtStart = crawler.requestsUsed;
  for (const candidate of candidates) {
    if (crawler.requestsUsed - catalogRequestsAtStart >= maxCatalogRequests) break;
    if (crawler.requestsRemaining <= 0) break;
    const catalog = await readCatalog(candidate);
    if (!catalog) continue;
    addSignal(
      scores,
      signals,
      candidate,
      1,
      candidate === 'shopify' ? 'endpoint:shopify_products' : 'endpoint:wc_store_products'
    );
    productUrl = catalog.url;
    productItems = catalog.items;
    productCapped = catalog.capped;
    break;
  }

  if (
    captureProducts &&
    productItems === null &&
    crawler.requestsUsed - catalogRequestsAtStart < maxCatalogRequests &&
    crawler.requestsRemaining > 0
  ) {
    const sitemap = await readSitemapCatalog(catalogRequestsAtStart);
    if (sitemap) {
      productUrl = sitemap.url;
      productItems = sitemap.items;
      productCapped = sitemap.capped;
    }
  }

  const picked = pickPlatform(scores, signals);
  // HTML can identify a storefront even when its public catalog endpoint is
  // blocked. Do not reinterpret that operational degradation as an empty store.
  if (
    captureProducts &&
    productItems === null &&
    (picked.platform === 'shopify' || picked.platform === 'woocommerce')
  ) {
    warnings.push(`No usable public ${picked.platform} catalog was captured.`);
  }
  if (!homeHtml) warnings.push('Homepage could not be captured as HTML.');

  return {
    domain: clean,
    homeUrl,
    homeHtml,
    homeHeaders: home?.headers ?? null,
    platform: picked.platform,
    platformConfidence: picked.confidence,
    platformSignals: picked.signals,
    productUrl,
    productItems,
    productCapped,
    requestsUsed: crawler.requestsUsed,
    warnings
  };
}
