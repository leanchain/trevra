import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';
import { detectTech, ECOMMERCE_APP_KEYS } from './enrich.js';
import type { FetchLike } from './guard.js';
import {
  extractJsonLd,
  extractLinks,
  firstHeading,
  isType,
  metaContent,
  pageTitle,
  sameOriginPath,
  stripTags
} from './html.js';
import { normalizeDomain } from './ladder.js';
import { createPublicWebCrawler, type CrawlTelemetry } from '../crawl/public-web.js';
import {
  discoverSiteSurfaces,
  NEWSLETTER_LINK_RE,
  type NewsletterPublicationTarget,
  type NewsletterSignupSurface,
  type PublishedSocialProfile
} from '../observations/site-surfaces.js';
import {
  crawlStorefront,
  type StorefrontPlatform,
  type StorefrontProduct
} from '../storefront/crawler.js';
import type { Skill, SkillContext, SkillEvidence } from './types.js';

/**
 * Continuous research: capture a normalized snapshot, diff it against the last
 * one stored for this workspace+domain, and report what moved.
 *
 * The value is entirely in the DIFF. "They have 7 open roles" is a fact; "they
 * went from 3 open roles to 7 since March" is a reason to send an email today,
 * and it is checkable by the recipient, which is what `voice.ts` is measuring.
 *
 * Two decisions the whole module rests on:
 *
 * NULL MEANS NOT CAPTURED, and it is never diffed. A careers page that timed
 * out records `jobCount: null`, not `0`. Without that distinction the first
 * flaky fetch reports "hiring went from 7 to 0", which is a fabricated signal
 * that reads as urgent -- the worst possible failure for outreach.
 *
 * PRICING IS HASHED FROM VISIBLE TEXT, not markup. Build hashes, CDN
 * cache-busters, and CSRF tokens change the bytes of a pricing page on every
 * single fetch, so hashing the response would emit `pricing-changed` daily and
 * the signal would be worth nothing within a week.
 */

export const SIGNAL_WATCHES = [
  'hiring',
  'pricing',
  'headline',
  'tech',
  'products',
  'storefront',
  'newsletter',
  'social'
] as const;
export type SignalWatch = (typeof SIGNAL_WATCHES)[number];

export const DEFAULT_PAGE_BUDGET = 10;

export type SignalKind =
  | 'first-capture'
  | 'product-launch'
  | 'hiring-up'
  | 'hiring-down'
  | 'pricing-changed'
  | 'storefront-rebuild'
  | 'headline-changed'
  | 'commerce-app-added'
  | 'commerce-app-removed'
  | 'newsletter-signup-added'
  | 'newsletter-signup-removed'
  | 'social-profile-added'
  | 'social-profile-removed'
  | 'tech-added'
  | 'tech-removed';

/** Stable report order, so two runs over the same pair of snapshots are byte-identical. */
const SIGNAL_ORDER: readonly SignalKind[] = [
  'first-capture',
  'product-launch',
  'hiring-up',
  'hiring-down',
  'pricing-changed',
  'storefront-rebuild',
  'headline-changed',
  'commerce-app-added',
  'commerce-app-removed',
  'newsletter-signup-added',
  'newsletter-signup-removed',
  'social-profile-added',
  'social-profile-removed',
  'tech-added',
  'tech-removed'
];

const ECOMMERCE_APPS = new Set<string>(ECOMMERCE_APP_KEYS);

export interface ResearchSignal {
  kind: SignalKind;
  detail: string;
  previous: string | null;
  current: string | null;
}

export type CatalogItem = StorefrontProduct;

export interface ResearchSnapshot {
  domain: string;
  capturedAt: string;
  headline: string | null;
  jobsUrl: string | null;
  /** `null` = not captured this run. `0` = captured, and there are no roles. */
  jobCount: number | null;
  jobTitles: string[];
  pricingUrl: string | null;
  pricingHash: string | null;
  /** Bounded visible price/plan facts from the captured pricing page. Missing means an older snapshot. */
  pricingFacts?: string[] | null;
  /** Public Shopify/WooCommerce catalog endpoint, when one was readable. */
  productUrl: string | null;
  /** Number of records in the bounded public sample. Null means not captured. */
  productCount: number | null;
  /** True when the public endpoint hit Trevra's platform sample ceiling. */
  productCapped: boolean;
  productItems: CatalogItem[];
  /** Live storefront platform fingerprint. Null/missing means the storefront was not captured. */
  storefrontPlatform?: StorefrontPlatform | null;
  storefrontPlatformConfidence?: number | null;
  /** `null` = not captured. `[]` = captured, and no signup surface was found. */
  newsletterSignups?: NewsletterSignupSurface[] | null;
  /** Public newsletter publication targets linked by the company, when captured. */
  newsletterPublications?: NewsletterPublicationTarget[] | null;
  /** `null`/missing = not captured. `[]` = captured, and no published social profile was found. */
  socialProfiles?: PublishedSocialProfile[] | null;
  /** `null` = not captured. `[]` = captured, and nothing matched. */
  tech: string[] | null;
}

const CAREERS_LINK_RE =
  /\b(careers?|jobs?|hiring|open (?:roles?|positions?|jobs?|openings?)|join us|work with us|view (?:all )?jobs?)\b/i;
const PRICING_LINK_RE = /\b(pricing|plans?|packages?)\b/i;

const JOB_BOARD_HOSTS =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|jobvite\.com|myworkdayjobs\.com|personio\.de|personio\.com)$/i;
const JOB_PATH_RE = /\/(jobs?|careers?|positions?|openings?|vacancies)\/[^/]+/i;

const GENERIC_JOB_TEXT: ReadonlySet<string> = new Set([
  'career',
  'careers',
  'job',
  'jobs',
  'all jobs',
  'view all',
  'view job',
  'view jobs',
  'view all jobs',
  'see all jobs',
  'open positions',
  'open roles',
  'apply',
  'apply now',
  'join us',
  'learn more',
  'read more',
  'we are hiring',
  "we're hiring"
]);

export function extractJobPostings(html: string, pageUrl: string): string[] {
  const titles = new Set<string>();
  for (const object of extractJsonLd(html)) {
    if (!isType(object, 'JobPosting')) continue;
    const title = typeof object.title === 'string' ? object.title.replace(/\s+/g, ' ').trim() : '';
    if (title) titles.add(title);
  }
  let sourceUrl: URL | null = null;
  try {
    sourceUrl = new URL(pageUrl);
  } catch {
    // The caller already supplies a URL in production; keep the parser total for tests/imports.
  }
  for (const link of extractLinks(html)) {
    let url: URL;
    try {
      url = new URL(link.href, pageUrl);
    } catch {
      continue;
    }
    const atsHost = JOB_BOARD_HOSTS.test(url.hostname);
    if (!atsHost && !JOB_PATH_RE.test(url.pathname)) continue;
    if (
      atsHost &&
      sourceUrl &&
      url.hostname.toLowerCase() === sourceUrl.hostname.toLowerCase() &&
      url.pathname.replace(/\/+$/, '') === sourceUrl.pathname.replace(/\/+$/, '')
    )
      continue;
    const title = link.text.trim();
    if (title.length < 3 || title.length > 120) continue;
    if (GENERIC_JOB_TEXT.has(title.toLowerCase())) continue;
    titles.add(title);
  }
  return [...titles].sort();
}

export function contentHash(html: string): string {
  return createHash('sha256').update(stripTags(html)).digest('hex').slice(0, 16);
}

const PRICE_AMOUNT_RE =
  /(?:[$€£¥]\s?\d[\d.,]*|(?:CHF|USD|EUR|GBP|CAD|AUD|JPY|SEK|NOK|DKK|PLN)\s?\d[\d.,]*|\d[\d.,]*\s?(?:CHF|USD|EUR|GBP|CAD|AUD|JPY|SEK|NOK|DKK|PLN))/gi;
const BILLING_SUFFIX_RE =
  /^\s*(?:(?:\/\s*(?:month|mo|year|yr|user|seat)(?:\s*\/\s*(?:month|mo|year|yr))?)|(?:per\s+(?:month|mo|year|yr|user|seat)(?:\s*\/\s*(?:month|mo|year|yr))?))/i;
const PLAN_FACT_RE =
  /\b(?:free plan|enterprise plan|custom pricing|contact sales|contact us for pricing)\b/gi;

/**
 * Small human-readable facts for explaining a pricing-page change.
 * Detection remains hash-based; these facts only make the evidence useful and,
 * when both snapshots have them, prevent unrelated pricing-page copy churn from
 * masquerading as a price/plan move.
 */
export function extractPricingFacts(html: string): string[] {
  const visible = stripTags(html);
  const seen = new Set<string>();
  const facts: string[] = [];
  const add = (fact: string) => {
    const clean = fact.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(clean);
  };

  for (const match of visible.matchAll(PRICE_AMOUNT_RE)) {
    const amount = match[0];
    const end = (match.index ?? 0) + amount.length;
    const tail = visible.slice(end, end + 48);
    // Animated number components can flatten as "$ 1 0" while the real text
    // also contains "$10". Do not preserve the partial first digit as a price.
    if (/^\s+\d\b/.test(tail)) continue;
    const suffix = BILLING_SUFFIX_RE.exec(tail)?.[0] ?? '';
    add(`${amount}${suffix}`);
    if (facts.length >= 12) break;
  }
  if (facts.length < 12) {
    for (const match of visible.matchAll(PLAN_FACT_RE)) {
      add(match[0]);
      if (facts.length >= 12) break;
    }
  }
  return facts.sort();
}

function catalogStateHash(items: readonly CatalogItem[]): string {
  return createHash('sha256')
    .update(JSON.stringify(items.map((item) => item.key).sort()))
    .digest('hex')
    .slice(0, 16);
}

/** Links the site itself offers first, declared fallbacks after; at most three. */
function discoverExternalJobBoards(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  for (const link of extractLinks(html)) {
    if (!CAREERS_LINK_RE.test(link.text)) continue;
    try {
      const url = new URL(link.href, pageUrl);
      if (url.protocol !== 'https:' || url.port || !JOB_BOARD_HOSTS.test(url.hostname)) continue;
      url.hash = '';
      const target = url.toString();
      if (!found.includes(target)) found.push(target);
      if (found.length >= 2) break;
    } catch {
      // Malformed or non-HTTP links are not hiring evidence.
    }
  }
  return found;
}

function discoverPaths(
  html: string,
  base: URL,
  pattern: RegExp,
  fallbacks: readonly string[]
): string[] {
  const paths: string[] = [];
  for (const link of extractLinks(html)) {
    if (!pattern.test(link.text)) continue;
    const path = sameOriginPath(base, link.href);
    if (path && path !== '/' && !paths.includes(path)) paths.push(path);
    if (paths.length >= 2) break;
  }
  for (const path of fallbacks) if (!paths.includes(path)) paths.push(path);
  return paths.slice(0, 3);
}

export interface CaptureOptions {
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
  watch?: readonly SignalWatch[];
  pageBudget?: number;
  now?: Date;
  /** Optional prior from an import/source. Live crawl evidence still wins. */
  platformHint?: 'shopify' | 'woocommerce' | null;
  /** Operational crawl summary for logs/metrics; never influences signal semantics. */
  onCrawlTelemetry?: (telemetry: CrawlTelemetry) => void;
}

export async function captureSnapshot(
  domain: string,
  options: CaptureOptions = {}
): Promise<ResearchSnapshot> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const watches = new Set<SignalWatch>(options.watch ?? SIGNAL_WATCHES);
  const budget = Math.max(1, options.pageBudget ?? DEFAULT_PAGE_BUDGET);

  // One Trevra-owned crawl session is shared by ecommerce and non-ecommerce
  // observers so robots policy and the request ceiling are enforced once.
  const crawler = await createPublicWebCrawler(clean, {
    fetchImpl: options.fetchImpl,
    maxRequests: budget
  });
  // Preserve room for the non-commerce watches. A product catalog is useful,
  // but it must not consume the whole account budget and starve careers/pricing.
  const reserve =
    (watches.has('hiring') ? 2 : 0) +
    (watches.has('pricing') ? 2 : 0) +
    (watches.has('newsletter') ? 1 : 0);
  const maxCatalogRequests = watches.has('products')
    ? Math.max(0, Math.min(4, budget - 2 - reserve))
    : 0;
  const storefront = await crawlStorefront(clean, {
    crawler,
    platformHint: options.platformHint,
    captureProducts: watches.has('products'),
    maxCatalogRequests
  });
  const base = new URL(crawler.origin);
  const get = async (url: string) => (await crawler.get(url)).response;

  const html = storefront.homeHtml ?? '';
  const headline =
    watches.has('headline') && html
      ? (firstHeading(html) ?? metaContent(html, 'property', 'og:title') ?? pageTitle(html))
      : null;
  const detectedTech = html ? detectTech(html, storefront.homeHeaders) : [];
  const tech = watches.has('tech') && html ? detectedTech.map((item) => item.key).sort() : null;

  const homeSurfaces = html ? discoverSiteSurfaces(html, storefront.homeUrl) : null;
  let newsletterSignups: NewsletterSignupSurface[] | null = watches.has('newsletter')
    ? (homeSurfaces?.newsletterSignups ?? null)
    : null;
  let newsletterPublications: NewsletterPublicationTarget[] | null = watches.has('newsletter')
    ? (homeSurfaces?.newsletterPublications ?? null)
    : null;
  const socialProfiles: PublishedSocialProfile[] | null = watches.has('social')
    ? (homeSurfaces?.socialProfiles ?? null)
    : null;

  // A dedicated first-party newsletter page is common even when the homepage
  // already has a signup form. Follow at most one same-origin page whenever
  // either signup evidence or a public publication feed is still missing, and
  // use the same crawler budget/robots/pacing contract as every other observer.
  if (
    watches.has('newsletter') &&
    html &&
    (newsletterSignups?.length === 0 || newsletterPublications?.length === 0)
  ) {
    const path = discoverPaths(html, base, NEWSLETTER_LINK_RE, [])[0];
    if (path) {
      const response = await crawler.get(`${base.origin}${path}`);
      if (
        response.response?.status === 200 &&
        (!response.response.contentType || response.response.contentType.includes('html'))
      ) {
        const newsletterSurfaces = discoverSiteSurfaces(response.response.text, response.finalUrl);
        newsletterSignups = [
          ...(newsletterSignups ?? []),
          ...newsletterSurfaces.newsletterSignups.filter(
            (surface) => !(newsletterSignups ?? []).some((existing) => existing.key === surface.key)
          )
        ];
        newsletterPublications = [
          ...(newsletterPublications ?? []),
          ...newsletterSurfaces.newsletterPublications.filter(
            (target) =>
              !(newsletterPublications ?? []).some((existing) => existing.url === target.url)
          )
        ];
      }
    }
  }

  let jobsUrl: string | null = null;
  let jobCount: number | null = null;
  let jobTitles: string[] = [];
  if (watches.has('hiring')) {
    const externalBoards: string[] = discoverExternalJobBoards(html, storefront.homeUrl);
    const attemptedExternal = new Set<string>();
    let emptyLocal: string | null = null;

    const inspectLocal = async (paths: readonly string[]) => {
      for (const path of paths) {
        const pageUrl = `${base.origin}${path}`;
        const response = await get(pageUrl);
        if (response === null || response.status !== 200) continue;
        if (response.contentType && !response.contentType.includes('html')) continue;
        const titles = extractJobPostings(response.text, pageUrl);
        if (titles.length > 0) {
          jobsUrl = pageUrl;
          jobTitles = titles;
          jobCount = titles.length;
          return true;
        }
        const linkedBoards = discoverExternalJobBoards(response.text, pageUrl);
        for (const target of linkedBoards)
          if (!externalBoards.includes(target) && externalBoards.length < 2)
            externalBoards.push(target);
        // A careers page that points to an ATS is a directory, not proof of
        // zero openings. Only retain an empty same-origin page as zero evidence
        // when it does not delegate the actual listings elsewhere.
        if (linkedBoards.length === 0 && emptyLocal === null) emptyLocal = pageUrl;
      }
      return false;
    };

    const explicitPaths = discoverPaths(html, base, CAREERS_LINK_RE, []);
    await inspectLocal(explicitPaths);

    const inspectExternal = async () => {
      for (const target of externalBoards.slice(0, 2)) {
        if (attemptedExternal.has(target)) continue;
        attemptedExternal.add(target);
        try {
          const url = new URL(target);
          const externalCrawler = await createPublicWebCrawler(url.hostname, {
            fetchImpl: options.fetchImpl,
            maxRequests: 4,
            maxDurationMs: 12_000,
            minDelayMs: options.fetchImpl ? 0 : 250
          });
          const result = await externalCrawler.get(url.toString());
          if (result.skipped || result.error || !result.response) continue;
          if (result.response.status !== 200) continue;
          if (result.response.contentType && !result.response.contentType.includes('html'))
            continue;
          jobsUrl = result.finalUrl;
          jobTitles = extractJobPostings(result.response.text, result.finalUrl);
          jobCount = jobTitles.length;
          return true;
        } catch {
          // An external board is optional evidence. Failure leaves hiring
          // unmeasured unless a same-origin page independently proved zero.
        }
      }
      return false;
    };

    if (jobCount === null && externalBoards.length > 0) await inspectExternal();

    if (jobCount === null) {
      const fallbacks = ['/careers', '/jobs'].filter((path) => !explicitPaths.includes(path));
      await inspectLocal(fallbacks);
      if (jobCount === null && externalBoards.length > 0) await inspectExternal();
    }

    if (jobCount === null && emptyLocal !== null) {
      jobsUrl = emptyLocal;
      jobTitles = [];
      jobCount = 0;
    }
  }

  let pricingUrl: string | null = null;
  let pricingHash: string | null = null;
  let pricingFacts: string[] | null = null;
  if (watches.has('pricing')) {
    for (const path of discoverPaths(html, base, PRICING_LINK_RE, ['/pricing', '/plans'])) {
      const response = await get(`${base.origin}${path}`);
      if (response === null || response.status !== 200) continue;
      if (response.contentType && !response.contentType.includes('html')) continue;
      pricingUrl = `${base.origin}${path}`;
      pricingHash = contentHash(response.text);
      pricingFacts = extractPricingFacts(response.text);
      break;
    }
  }

  const productUrl = watches.has('products') ? storefront.productUrl : null;
  const productItems: CatalogItem[] = watches.has('products')
    ? (storefront.productItems ?? [])
    : [];
  const productCount =
    watches.has('products') && storefront.productItems !== null
      ? storefront.productItems.length
      : null;
  const productCapped = watches.has('products') ? storefront.productCapped : false;
  const storefrontPlatform = watches.has('storefront') && html ? storefront.platform : null;
  const storefrontPlatformConfidence =
    watches.has('storefront') && html ? storefront.platformConfidence : null;

  options.onCrawlTelemetry?.(crawler.telemetry());

  return {
    domain: clean,
    capturedAt: (options.now ?? new Date()).toISOString(),
    headline,
    jobsUrl,
    jobCount,
    jobTitles,
    pricingUrl,
    pricingHash,
    pricingFacts,
    productUrl,
    productCount,
    productCapped,
    productItems,
    storefrontPlatform,
    storefrontPlatformConfidence,
    newsletterSignups,
    newsletterPublications,
    socialProfiles,
    tech
  };
}

function summarize(snapshot: ResearchSnapshot): string {
  const parts: string[] = [];
  if (snapshot.jobCount !== null) parts.push(`${snapshot.jobCount} open role(s)`);
  if (snapshot.productCount !== null)
    parts.push(
      `${snapshot.productCapped ? 'at least ' : ''}${snapshot.productCount} catalog product(s)`
    );
  if (snapshot.newsletterSignups?.length)
    parts.push(`${snapshot.newsletterSignups.length} newsletter signup surface(s)`);
  if (snapshot.socialProfiles?.length)
    parts.push(`${snapshot.socialProfiles.length} published social profile(s)`);
  if (snapshot.headline) parts.push(`headline \"${snapshot.headline}\"`);
  if (snapshot.tech !== null && snapshot.tech.length > 0)
    parts.push(`tech ${snapshot.tech.join(', ')}`);
  if (snapshot.pricingHash) parts.push(`pricing hash ${snapshot.pricingHash}`);
  return parts.length > 0 ? parts.join('; ') : 'nothing readable';
}

/**
 * Diff two snapshots into typed signals. Pure, total, and order-stable.
 *
 * A field is compared only when BOTH snapshots captured it -- see the module
 * doc on why a null must never become a movement. Set membership drives the
 * tech signals so that reordering a detection table cannot manufacture one.
 */
export function diffSnapshots(
  previous: ResearchSnapshot | null,
  current: ResearchSnapshot
): ResearchSignal[] {
  if (previous === null) {
    return [
      {
        kind: 'first-capture',
        detail: `First snapshot of ${current.domain}: ${summarize(current)}.`,
        previous: null,
        current: summarize(current)
      }
    ];
  }

  const signals: ResearchSignal[] = [];

  if (previous.productCount !== null && current.productCount !== null) {
    const before = new Set(previous.productItems.map((item) => item.key));
    const added = current.productItems.filter((item) => !before.has(item.key));
    if (added.length > 0) {
      const named =
        added.length > 0
          ? ` (${added
              .slice(0, 3)
              .map((item) => item.label)
              .join('; ')})`
          : '';
      signals.push({
        kind: 'product-launch',
        detail: `${current.domain} added ${added.length} product${added.length === 1 ? '' : 's'} to its public catalog since the last check${named}.`,
        previous: catalogStateHash(previous.productItems),
        current: catalogStateHash(current.productItems)
      });
    }
  }

  if (
    previous.jobCount !== null &&
    current.jobCount !== null &&
    previous.jobCount !== current.jobCount
  ) {
    const up = current.jobCount > previous.jobCount;
    const changed = up
      ? current.jobTitles.filter((title) => !previous.jobTitles.includes(title))
      : previous.jobTitles.filter((title) => !current.jobTitles.includes(title));
    const named =
      changed.length > 0 ? ` (${up ? 'new' : 'gone'}: ${changed.slice(0, 3).join('; ')})` : '';
    signals.push({
      kind: up ? 'hiring-up' : 'hiring-down',
      detail: `Open roles on ${current.jobsUrl ?? current.domain} went from ${previous.jobCount} to ${current.jobCount}${named}.`,
      previous: String(previous.jobCount),
      current: String(current.jobCount)
    });
  }

  if (
    previous.pricingHash !== null &&
    current.pricingHash !== null &&
    previous.pricingHash !== current.pricingHash
  ) {
    const previousFacts = previous.pricingFacts;
    const currentFacts = current.pricingFacts;
    const comparableFacts = Array.isArray(previousFacts) && Array.isArray(currentFacts);
    const removed = comparableFacts
      ? previousFacts.filter((fact) => !currentFacts.includes(fact))
      : [];
    const added = comparableFacts
      ? currentFacts.filter((fact) => !previousFacts.includes(fact))
      : [];
    // If both captures had structured pricing facts and those facts did not
    // move, the hash change was surrounding copy/layout churn, not pricing.
    if (!comparableFacts || removed.length > 0 || added.length > 0) {
      const quote = (fact: string) => `“${fact.replace(/[“”"]/g, "'")}”`;
      const factDetail = comparableFacts
        ? [
            removed.length > 0 ? `removed ${removed.slice(0, 2).map(quote).join('; ')}` : null,
            added.length > 0 ? `added ${added.slice(0, 2).map(quote).join('; ')}` : null
          ]
            .filter(Boolean)
            .join('; ')
        : '';
      signals.push({
        kind: 'pricing-changed',
        detail: factDetail
          ? `Pricing changed on ${current.pricingUrl ?? current.domain}: ${factDetail}.`
          : `Pricing page content changed on ${current.pricingUrl ?? current.domain} (${previous.pricingHash} -> ${current.pricingHash}).`,
        previous: previous.pricingHash,
        current: current.pricingHash
      });
    }
  }

  const commercePlatforms = new Set<StorefrontPlatform>([
    'shopify',
    'woocommerce',
    'magento',
    'shopware',
    'bigcommerce',
    'prestashop'
  ]);
  if (
    previous.storefrontPlatform != null &&
    current.storefrontPlatform != null &&
    previous.storefrontPlatform !== current.storefrontPlatform &&
    commercePlatforms.has(previous.storefrontPlatform) &&
    commercePlatforms.has(current.storefrontPlatform) &&
    (previous.storefrontPlatformConfidence ?? 0) >= 0.8 &&
    (current.storefrontPlatformConfidence ?? 0) >= 0.8
  ) {
    signals.push({
      kind: 'storefront-rebuild',
      detail: `${current.domain} moved its storefront platform from ${previous.storefrontPlatform} to ${current.storefrontPlatform}.`,
      previous: previous.storefrontPlatform,
      current: current.storefrontPlatform
    });
  }

  if (
    previous.headline !== null &&
    current.headline !== null &&
    previous.headline !== current.headline
  ) {
    signals.push({
      kind: 'headline-changed',
      detail: `Homepage headline on ${current.domain} changed from "${previous.headline}" to "${current.headline}".`,
      previous: previous.headline,
      current: current.headline
    });
  }

  if (previous.newsletterSignups != null && current.newsletterSignups != null) {
    const before = new Set(previous.newsletterSignups.map((surface) => surface.key));
    const after = new Set(current.newsletterSignups.map((surface) => surface.key));
    const added = current.newsletterSignups.filter((surface) => !before.has(surface.key));
    const removed = previous.newsletterSignups.filter((surface) => !after.has(surface.key));
    const previousState =
      previous.newsletterSignups.map((surface) => surface.key).join(', ') || 'none';
    const currentState =
      current.newsletterSignups.map((surface) => surface.key).join(', ') || 'none';
    if (added.length > 0) {
      signals.push({
        kind: 'newsletter-signup-added',
        detail: `${current.domain} added a newsletter signup surface${added[0]?.provider ? ` using ${added[0].provider}` : ''}.`,
        previous: previousState,
        current: currentState
      });
    }
    if (removed.length > 0) {
      signals.push({
        kind: 'newsletter-signup-removed',
        detail: `${current.domain} removed a previously published newsletter signup surface.`,
        previous: previousState,
        current: currentState
      });
    }
  }

  if (previous.socialProfiles != null && current.socialProfiles != null) {
    const key = (profile: PublishedSocialProfile) =>
      `${profile.platform}:${profile.handle.toLowerCase()}`;
    const before = new Set(previous.socialProfiles.map(key));
    const after = new Set(current.socialProfiles.map(key));
    const added = current.socialProfiles.filter((profile) => !before.has(key(profile)));
    const removed = previous.socialProfiles.filter((profile) => !after.has(key(profile)));
    const previousState = previous.socialProfiles.map(key).join(', ') || 'none';
    const currentState = current.socialProfiles.map(key).join(', ') || 'none';
    if (added.length > 0) {
      signals.push({
        kind: 'social-profile-added',
        detail: `${current.domain} published ${added.length} new social profile link${added.length === 1 ? '' : 's'} (${added
          .slice(0, 3)
          .map((profile) => `${profile.platform}:${profile.handle}`)
          .join('; ')}).`,
        previous: previousState,
        current: currentState
      });
    }
    if (removed.length > 0) {
      signals.push({
        kind: 'social-profile-removed',
        detail: `${current.domain} removed ${removed.length} previously published social profile link${removed.length === 1 ? '' : 's'} (${removed
          .slice(0, 3)
          .map((profile) => `${profile.platform}:${profile.handle}`)
          .join('; ')}).`,
        previous: previousState,
        current: currentState
      });
    }
  }

  if (previous.tech !== null && current.tech !== null) {
    const before = new Set(previous.tech);
    const after = new Set(current.tech);
    const added = current.tech.filter((key) => !before.has(key));
    const removed = previous.tech.filter((key) => !after.has(key));
    const commerceAdded = added.filter((key) => ECOMMERCE_APPS.has(key));
    const commerceRemoved = removed.filter((key) => ECOMMERCE_APPS.has(key));
    const genericAdded = added.filter((key) => !ECOMMERCE_APPS.has(key));
    const genericRemoved = removed.filter((key) => !ECOMMERCE_APPS.has(key));
    const previousState = previous.tech.join(', ') || 'none';
    const currentState = current.tech.join(', ') || 'none';

    if (commerceAdded.length > 0) {
      signals.push({
        kind: 'commerce-app-added',
        detail: `${current.domain} added ecommerce app${commerceAdded.length === 1 ? '' : 's'} ${commerceAdded.join(', ')} since the last check.`,
        previous: previousState,
        current: currentState
      });
    }
    if (commerceRemoved.length > 0) {
      signals.push({
        kind: 'commerce-app-removed',
        detail: `${current.domain} dropped ecommerce app${commerceRemoved.length === 1 ? '' : 's'} ${commerceRemoved.join(', ')} since the last check.`,
        previous: previousState,
        current: currentState
      });
    }
    if (genericAdded.length > 0) {
      signals.push({
        kind: 'tech-added',
        detail: `${current.domain} added ${genericAdded.join(', ')} since the last check.`,
        previous: previousState,
        current: currentState
      });
    }
    if (genericRemoved.length > 0) {
      signals.push({
        kind: 'tech-removed',
        detail: `${current.domain} dropped ${genericRemoved.join(', ')} since the last check.`,
        previous: previousState,
        current: currentState
      });
    }
  }

  return signals.sort((a, b) => SIGNAL_ORDER.indexOf(a.kind) - SIGNAL_ORDER.indexOf(b.kind));
}

const snapshotSchema = z.object({
  domain: z.string(),
  capturedAt: z.string(),
  headline: z.string().nullable(),
  jobsUrl: z.string().nullable(),
  jobCount: z.number().nullable(),
  jobTitles: z.array(z.string()),
  pricingUrl: z.string().nullable(),
  pricingHash: z.string().nullable(),
  pricingFacts: z.array(z.string()).max(12).nullable().optional(),
  productUrl: z.string().nullable().default(null),
  productCount: z.number().nullable().default(null),
  productCapped: z.boolean().default(false),
  productItems: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
  storefrontPlatform: z
    .enum([
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
    ])
    .nullable()
    .default(null),
  storefrontPlatformConfidence: z.number().min(0).max(1).nullable().default(null),
  newsletterSignups: z
    .array(
      z.object({
        sourceUrl: z.string(),
        provider: z.string().nullable(),
        key: z.string()
      })
    )
    .nullable()
    .default(null),
  newsletterPublications: z
    .array(
      z.object({
        platform: z.enum(['substack', 'beehiiv', 'public-feed']),
        url: z.string(),
        feedUrl: z.string()
      })
    )
    .nullable()
    .default(null),
  socialProfiles: z
    .array(
      z.object({
        platform: z.string(),
        handle: z.string(),
        url: z.string()
      })
    )
    .nullable()
    .default(null),
  tech: z.array(z.string()).nullable()
});

/**
 * Newest stored snapshot for this workspace+domain, or `null`.
 *
 * A stored row that no longer matches the schema degrades to "no prior"
 * instead of throwing: a snapshot shape change would otherwise take every
 * watched domain's next run down with it, and `first-capture` is the correct
 * reading of "we have nothing comparable".
 */
export async function loadPreviousSnapshot(
  db: Db,
  workspaceId: string,
  domain: string
): Promise<ResearchSnapshot | null> {
  const row = await db
    .prepare(
      'SELECT snapshot_json FROM research_snapshots WHERE workspace_id=? AND domain=? ORDER BY captured_at DESC LIMIT 1'
    )
    .get<{ snapshot_json: unknown }>(workspaceId, domain);
  if (!row) return null;
  let raw: unknown = row.snapshot_json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = snapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveSnapshot(
  db: Db,
  workspaceId: string,
  snapshot: ResearchSnapshot,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO research_snapshots (id, workspace_id, domain, captured_at, snapshot_json, created_at)
      VALUES (?,?,?,?,?::jsonb,?)
    `
    )
    .run(
      id('snap'),
      workspaceId,
      snapshot.domain,
      snapshot.capturedAt,
      JSON.stringify(snapshot),
      now.toISOString()
    );
}

export interface WatchResult {
  domain: string;
  snapshot: ResearchSnapshot;
  previousCapturedAt: string | null;
  signals: ResearchSignal[];
  generatedAt: string;
  evidence: SkillEvidence[];
}

/**
 * Load, capture, diff, persist -- split out of the skill the way `audit.ts`
 * splits `runVisibilityAudit`, so the orchestration is reachable with an
 * injected fetch instead of only through the registry.
 */
export async function watchSignals(
  domain: string,
  ctx: SkillContext,
  options: CaptureOptions = {}
): Promise<WatchResult> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const previous = await loadPreviousSnapshot(ctx.db, ctx.workspaceId, clean);
  const snapshot = await captureSnapshot(domain, { ...options, now: options.now ?? ctx.now() });
  const signals = diffSnapshots(previous, snapshot);
  // Persisted whatever the diff said: a run that emitted nothing is still the
  // baseline the next run compares against.
  await saveSnapshot(ctx.db, ctx.workspaceId, snapshot, ctx.now());
  return {
    domain: clean,
    snapshot,
    previousCapturedAt: previous?.capturedAt ?? null,
    signals,
    generatedAt: ctx.now().toISOString(),
    evidence: signals.map((signal) => ({
      label: signal.kind,
      detail: signal.detail,
      sourceUrl: signal.kind.startsWith('hiring')
        ? snapshot.jobsUrl
        : signal.kind === 'pricing-changed'
          ? snapshot.pricingUrl
          : signal.kind === 'product-launch'
            ? snapshot.productUrl
            : signal.kind === 'storefront-rebuild'
              ? `https://${clean}`
              : signal.kind.startsWith('newsletter-signup')
                ? (snapshot.newsletterSignups?.[0]?.sourceUrl ?? `https://${clean}`)
                : signal.kind === 'social-profile-added'
                  ? (snapshot.socialProfiles?.[0]?.url ?? `https://${clean}`)
                  : `https://${clean}`
    }))
  };
}

const inputSchema = z.object({
  domain: z.string().min(1),
  watch: z.array(z.enum(SIGNAL_WATCHES)).min(1).optional(),
  pageBudget: z.number().int().positive().max(25).optional()
});

const outputSchema = z.object({
  domain: z.string(),
  snapshot: snapshotSchema,
  previousCapturedAt: z.string().nullable(),
  signals: z.array(
    z.object({
      kind: z.enum([
        'first-capture',
        'product-launch',
        'hiring-up',
        'hiring-down',
        'pricing-changed',
        'storefront-rebuild',
        'headline-changed',
        'commerce-app-added',
        'commerce-app-removed',
        'newsletter-signup-added',
        'newsletter-signup-removed',
        'social-profile-added',
        'social-profile-removed',
        'tech-added',
        'tech-removed'
      ]),
      detail: z.string(),
      previous: z.string().nullable(),
      current: z.string().nullable()
    })
  ),
  generatedAt: z.string(),
  evidence: z.array(
    z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() })
  )
});

type WatchInput = z.infer<typeof inputSchema>;

export const watchSignalSkill: Skill<WatchInput, WatchResult> = {
  manifest: {
    id: 'gtm.watch-signal',
    name: 'Watch a domain for change signals',
    version: '1.0.0',
    description:
      'Capture hiring, pricing, headline, ecommerce app, public product catalog, newsletter signup, and published social-profile snapshots for a domain and diff them into evidence-backed change signals.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    return watchSignals(input.domain, ctx, { watch: input.watch, pageBudget: input.pageBudget });
  }
};
