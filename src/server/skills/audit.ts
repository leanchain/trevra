import { z } from 'zod';
import { createSsrfFetch, validatePublicHost, type FetchLike } from './guard.js';
import { extractJsonLd, isRecord, isType, jsonLdTypes, metaContent, pageTitle, parseRobots, type RobotsRules } from './html.js';
import { normalizeDomain } from './ladder.js';
import { probe } from './probe.js';
import type { Skill, SkillEvidence } from './types.js';

// Shared with the research skills; re-exported so this module stays the single
// import site for callers that already depend on the audit's vocabulary.
export { parseRobots, type RobotsRules } from './html.js';
export { TIMEOUT_MS, USER_AGENT } from './probe.js';

/**
 * Self-contained AI-visibility audit probe suite.
 *
 * Ported from the Python reference `src/growth/audits/visibility.py`. Plain
 * HTTP probes against a prospect domain to gauge how readable the store is to
 * AI shopping assistants / answer engines.
 *
 * Every check is graceful: any network error degrades the check to `skip` (or
 * a safe `pass` where absence is good) instead of throwing, so a partial
 * outage still yields a usable, scored report. The scoring half of that
 * promise is the weight RENORMALIZATION in {@link scoreChecks} -- skipped
 * checks drop out of BOTH the numerator and the denominator, so a store that
 * scored 100 on the four checks that answered is not punished with a 40 for
 * the three that timed out.
 */

/** AI crawler / answer-engine user agents we care about (case-insensitive). */
export const AI_BOTS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Bytespider',
  'CCBot',
  'meta-externalagent',
  'Amazonbot',
  'cohere-ai'
];

/**
 * Weight of each check in the 0-100 score. Skipped checks drop out and the
 * remaining weights are renormalised.
 */
export const WEIGHTS: Readonly<Record<string, number>> = {
  structured_data_product: 30,
  robots_ai_bots: 25,
  products_feed: 15,
  structured_data_home: 10,
  meta_quality: 10,
  sitemap: 5,
  llms_txt: 5
};

const LABELS: Readonly<Record<string, string>> = {
  structured_data_product: 'Product structured data',
  robots_ai_bots: 'AI crawler access (robots.txt)',
  products_feed: 'Machine-readable product feed',
  structured_data_home: 'Homepage structured data',
  meta_quality: 'Page title & meta description',
  sitemap: 'XML sitemap',
  llms_txt: 'llms.txt guidance file'
};

/** Display / priority order: highest-value checks first. */
export const CHECK_ORDER: readonly string[] = [
  'structured_data_product',
  'robots_ai_bots',
  'products_feed',
  'structured_data_home',
  'meta_quality',
  'sitemap',
  'llms_txt'
];

const FRACTION: Readonly<Record<string, number>> = { pass: 1, warn: 0.5, fail: 0 };

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  evidence: string | null;
  weight: number;
  /** Plain-language business cost; populated for `warn` / `fail` only. */
  impact: string | null;
}

export interface AuditResult {
  domain: string;
  score: number;
  checks: CheckResult[];
  topFinding: string;
  generatedAt: string;
  evidence: SkillEvidence[];
}

function check(id: string, status: CheckStatus, detail: string, extra: { evidence?: string; impact?: string } = {}): CheckResult {
  return {
    id,
    label: LABELS[id],
    status,
    detail,
    evidence: extra.evidence ?? null,
    weight: WEIGHTS[id] ?? 0,
    impact: extra.impact ?? null
  };
}

function blockedEntirely(agents: RobotsRules, bot: string): boolean {
  let rules = agents.get(bot.toLowerCase());
  if (rules === undefined) rules = agents.get('*');
  if (!rules || rules.length === 0) return false;
  const disallowRoot = rules.some(([key, value]) => key === 'disallow' && value === '/');
  const allowRoot = rules.some(([key, value]) => key === 'allow' && value === '/');
  return disallowRoot && !allowRoot;
}

function joinBots(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

async function checkRobots(client: FetchLike, base: string): Promise<CheckResult> {
  const response = await probe(client, `${base}/robots.txt`);
  if (response === null) return check('robots_ai_bots', 'skip', 'Could not fetch robots.txt.');
  if (response.status === 404) return check('robots_ai_bots', 'pass', 'No robots.txt found -- all crawlers are allowed.');
  if (response.status >= 400) return check('robots_ai_bots', 'skip', `robots.txt returned HTTP ${response.status}.`);
  const agents = parseRobots(response.text);
  const blocked = AI_BOTS.filter((bot) => blockedEntirely(agents, bot));
  if (blocked.length === 0) return check('robots_ai_bots', 'pass', 'No AI crawlers are blocked in robots.txt.');
  const shown = blocked.slice(0, 3);
  let phrase = joinBots(shown);
  if (blocked.length > 3) phrase = `${phrase}, and ${blocked.length - 3} other AI crawlers`;
  const verb = blocked.length === 1 && shown.length === 1 ? 'is' : 'are';
  const evidence = blocked.map((bot) => `User-agent: ${bot}\nDisallow: /`).join('\n');
  const impact = `${phrase} ${verb} blocked in robots.txt -- AI assistants and answer engines cannot read this catalog at all.`;
  return check('robots_ai_bots', 'fail', `Blocked entirely in robots.txt: ${blocked.join(', ')}.`, { evidence, impact });
}

// --------------------------------------------------------------------------- //
// llms.txt / sitemap / products feed
// --------------------------------------------------------------------------- //

async function checkLlmsTxt(client: FetchLike, base: string): Promise<CheckResult> {
  const found: string[] = [];
  let reachable = false;
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const response = await probe(client, `${base}/${name}`);
    if (response === null) continue;
    reachable = true;
    if (response.status === 200 && response.text.trim()) found.push(name);
  }
  if (found.length > 0) return check('llms_txt', 'pass', `Found ${found.map((name) => `/${name}`).join(', ')}.`);
  if (!reachable) return check('llms_txt', 'skip', 'Could not check for llms.txt.');
  return check('llms_txt', 'warn', 'No llms.txt or llms-full.txt found.', {
    impact: 'No llms.txt -- the emerging standard for steering AI assistants to your best content is absent.'
  });
}

async function checkSitemap(client: FetchLike, base: string): Promise<{ result: CheckResult; text: string | null }> {
  const response = await probe(client, `${base}/sitemap.xml`);
  if (response === null) return { result: check('sitemap', 'skip', 'Could not fetch sitemap.xml.'), text: null };
  const looksLikeXml = response.contentType.includes('xml') || response.text.includes('<urlset') || response.text.includes('<sitemapindex');
  if (response.status === 200 && looksLikeXml) {
    return { result: check('sitemap', 'pass', 'sitemap.xml is reachable.'), text: response.text };
  }
  return {
    result: check('sitemap', 'warn', `sitemap.xml returned HTTP ${response.status} or is not valid XML.`, {
      impact: 'No reachable sitemap.xml -- crawlers and AI indexers may miss product and category pages.'
    }),
    text: response.status === 200 ? response.text : null
  };
}

/** Return the products.json check plus a product handle to sample, if any. */
async function checkProductsFeed(client: FetchLike, base: string): Promise<{ result: CheckResult; handle: string | null }> {
  const response = await probe(client, `${base}/products.json?limit=1`);
  if (response === null || response.status !== 200 || !response.contentType.includes('json')) {
    return { result: check('products_feed', 'skip', 'No Shopify products.json (non-Shopify or unavailable).'), handle: null };
  }
  let data: unknown;
  try {
    data = JSON.parse(response.text);
  } catch {
    return { result: check('products_feed', 'skip', 'products.json is not valid JSON (non-Shopify).'), handle: null };
  }
  const products = isRecord(data) ? data.products : undefined;
  if (Array.isArray(products)) {
    const first = products[0];
    const handle = isRecord(first) && typeof first.handle === 'string' ? first.handle : null;
    return { result: check('products_feed', 'pass', `products.json is valid (${products.length} sample product(s)).`), handle };
  }
  return {
    result: check('products_feed', 'warn', 'products.json responded but is not a valid product feed.', {
      impact: 'No clean product feed (products.json) -- AI tools and comparison engines have no structured catalog to ingest.'
    }),
    handle: null
  };
}

// --------------------------------------------------------------------------- //
// structured-data checks (parsers live in html.ts)
// --------------------------------------------------------------------------- //

const PRODUCT_LOC_RE = /<loc>\s*([^<\s]*\/products\/[^<\s]+)\s*<\/loc>/i;

function checkStructuredDataHome(html: string): CheckResult {
  if (!html) return check('structured_data_home', 'skip', 'Could not fetch homepage.');
  const types = jsonLdTypes(extractJsonLd(html));
  const hasOrg = [...types].some((type) => type.includes('Organization'));
  const hasSite = types.has('WebSite');
  const ogTitle = metaContent(html, 'property', 'og:title');
  const ogDesc = metaContent(html, 'property', 'og:description');
  const present: string[] = [];
  if (hasOrg) present.push('Organization');
  if (hasSite) present.push('WebSite');
  if (ogTitle) present.push('og:title');
  if (ogDesc) present.push('og:description');
  if ((hasOrg || hasSite) && ogTitle && ogDesc) return check('structured_data_home', 'pass', `Found: ${present.join(', ')}.`);
  if (present.length > 0) {
    return check('structured_data_home', 'warn', `Partial homepage signals: ${present.join(', ')}.`, {
      impact: 'Homepage brand signals are partial -- AI assistants may describe the brand inconsistently.'
    });
  }
  return check('structured_data_home', 'fail', 'No Organization/WebSite JSON-LD or Open Graph tags found.', {
    impact: 'The homepage lacks Organization/WebSite schema and social metadata -- AI assistants struggle to identify and describe the brand.'
  });
}

function offerFields(offers: unknown): { price: unknown; availability: unknown } {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!isRecord(offer)) return { price: null, availability: null };
  let price: unknown = offer.price ?? null;
  if (!price) price = offer.lowPrice ?? null;
  const spec = offer.priceSpecification;
  if (!price && isRecord(spec)) price = spec.price ?? null;
  return { price, availability: offer.availability ?? null };
}

function productUrl(base: string, handle: string | null, sitemapText: string | null): string | null {
  if (handle) return `${base}/products/${handle}`;
  if (sitemapText) {
    const match = PRODUCT_LOC_RE.exec(sitemapText);
    if (match) return match[1];
  }
  return null;
}

async function checkStructuredDataProduct(client: FetchLike, base: string, handle: string | null, sitemapText: string | null): Promise<CheckResult> {
  const url = productUrl(base, handle, sitemapText);
  if (!url) return check('structured_data_product', 'skip', 'No product page could be sampled.');
  const response = await probe(client, url);
  if (response === null || response.status >= 400) return check('structured_data_product', 'skip', 'Could not fetch a product page to sample.');
  const products = extractJsonLd(response.text).filter((object) => isType(object, 'Product'));
  if (products.length === 0) {
    return check('structured_data_product', 'fail', 'No Product JSON-LD on the sampled product page.', {
      impact: "Product pages ship no structured data -- AI shopping assistants can't read prices, availability, or specs, so these products never surface in AI answers."
    });
  }
  const { price, availability } = offerFields(products[0].offers);
  if (price && availability) {
    return check('structured_data_product', 'pass', 'Product JSON-LD with price and availability found.', {
      evidence: `price=${String(price)}, availability=${String(availability)}`
    });
  }
  const missingParts: string[] = [];
  if (!price) missingParts.push('price');
  if (!availability) missingParts.push('availability');
  const missing = missingParts.join(', ') || 'offers';
  return check('structured_data_product', 'warn', `Product JSON-LD found but missing ${missing}.`, {
    impact: 'Product structured data is incomplete (missing price or availability) -- AI assistants may omit or misquote these products.'
  });
}

function checkMetaQuality(html: string): CheckResult {
  if (!html) return check('meta_quality', 'skip', 'Could not fetch homepage.');
  const title = pageTitle(html);
  const description = metaContent(html, 'name', 'description');
  if (title && description) {
    const titleOk = title.length >= 10 && title.length <= 70;
    const descriptionOk = description.length >= 50 && description.length <= 160;
    if (titleOk && descriptionOk) {
      return check('meta_quality', 'pass', `Title (${title.length} chars) and meta description (${description.length} chars) present.`);
    }
    return check('meta_quality', 'warn', `Title (${title.length} chars) / meta description (${description.length} chars) present but poorly sized.`, {
      impact: 'Title or meta description is poorly sized -- AI and search snippets will be weaker than they should be.'
    });
  }
  if (title || description) {
    return check('meta_quality', 'warn', 'Only one of <title> / meta description is present.', {
      impact: 'A missing page title or meta description weakens AI and search result snippets.'
    });
  }
  return check('meta_quality', 'fail', 'No <title> or meta description found.', {
    impact: 'Missing page title and meta description -- weak summary signals for AI and search result snippets.'
  });
}

// --------------------------------------------------------------------------- //
// scoring + orchestration
// --------------------------------------------------------------------------- //

/**
 * Weighted 0-100 score with RENORMALIZATION over the checks that answered.
 *
 * A `skip` contributes to neither `got` nor `total`, so the score always means
 * "of what we could measure, how much passed". Without this, a network outage
 * would silently read as a failing store.
 */
export function scoreChecks(checks: CheckResult[]): number {
  let total = 0;
  let got = 0;
  for (const item of checks) {
    if (item.status === 'skip') continue;
    const weight = WEIGHTS[item.id] ?? 0;
    total += weight;
    got += weight * (FRACTION[item.status] ?? 0);
  }
  if (total === 0) return 0;
  return Math.round((got / total) * 100);
}

function topFinding(checks: CheckResult[]): string {
  const order = new Map(CHECK_ORDER.map((id, index) => [id, index]));
  const problems = checks.filter((item) => item.status === 'fail' || item.status === 'warn');
  if (problems.length === 0) {
    return 'This store is well-prepared for AI shopping assistants -- strong structured data and open crawler access.';
  }
  // Worst first: fails before warns, then heaviest weight, then display order.
  problems.sort((a, b) => {
    const failFirst = Number(a.status !== 'fail') - Number(b.status !== 'fail');
    if (failFirst !== 0) return failFirst;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  });
  return problems[0].impact || problems[0].detail;
}

function ordered(checks: CheckResult[]): CheckResult[] {
  const index = new Map(CHECK_ORDER.map((id, position) => [id, position]));
  return [...checks].sort((a, b) => (index.get(a.id) ?? 99) - (index.get(b.id) ?? 99));
}

export interface VisibilityAuditOptions {
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

/**
 * Run the full visibility probe suite against `domain`.
 *
 * Never throws for network conditions -- failing probes degrade to `skip`. It
 * DOES throw when the host itself is not a safe public destination, because
 * that is a caller error, not a probe outcome.
 */
export async function runVisibilityAudit(domain: string, options: VisibilityAuditOptions = {}): Promise<AuditResult> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const resolve = options.fetchImpl === undefined;
  // Pre-flight SSRF check, deliberately OUTSIDE the probe helper: probes
  // swallow errors into `skip`, so a bad host must be rejected here or it
  // would silently degrade into an all-skip report instead of an error.
  // An injected fetch (tests) skips DNS resolution but keeps the structural checks.
  await validatePublicHost(clean, { resolve });
  const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
  const base = `https://${clean}`;

  const homeResponse = await probe(client, `${base}/`);
  const homeHtml = homeResponse !== null && homeResponse.status < 400 ? homeResponse.text : '';

  const robots = await checkRobots(client, base);
  const llms = await checkLlmsTxt(client, base);
  const sitemap = await checkSitemap(client, base);
  const feed = await checkProductsFeed(client, base);
  const home = checkStructuredDataHome(homeHtml);
  const product = await checkStructuredDataProduct(client, base, feed.handle, sitemap.text);
  const meta = checkMetaQuality(homeHtml);

  const checks = ordered([robots, llms, sitemap.result, feed.result, home, product, meta]);
  return {
    domain: clean,
    score: scoreChecks(checks),
    checks,
    topFinding: topFinding(checks),
    generatedAt: new Date().toISOString(),
    evidence: checks
      .filter((item) => item.status === 'fail' || item.status === 'warn')
      .map((item) => ({ label: item.label, detail: item.impact ?? item.detail, sourceUrl: base }))
  };
}

const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'skip']),
  detail: z.string(),
  evidence: z.string().nullable(),
  weight: z.number(),
  impact: z.string().nullable()
});

const inputSchema = z.object({ domain: z.string().min(1) });

const outputSchema = z.object({
  domain: z.string(),
  score: z.number().int().min(0).max(100),
  checks: z.array(checkSchema),
  topFinding: z.string(),
  generatedAt: z.string(),
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type AuditInput = z.infer<typeof inputSchema>;

export const visibilityAuditSkill: Skill<AuditInput, AuditResult> = {
  manifest: {
    id: 'gtm.visibility-audit',
    name: 'AI-visibility audit',
    version: '1.0.0',
    description: 'Probe a domain for how readable it is to AI shopping assistants and answer engines.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return runVisibilityAudit(input.domain);
  }
};
