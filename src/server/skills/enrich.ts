import { z } from 'zod';
import { createSsrfFetch, validatePublicHost, type FetchLike } from './guard.js';
import {
  escapeRegExp,
  extractJsonLd,
  extractLinks,
  extractMailtos,
  isRecord,
  jsonLdTypes,
  metaContent,
  pageTitle,
  socialProfile
} from './html.js';
import { normalizeDomain } from './ladder.js';
import { probe, type Probe } from './probe.js';
import { DEFAULT_SCORE_CONFIG, type LeadFields } from './score.js';
import type { Skill, SkillEvidence } from './types.js';

/**
 * Firmographics from the company's OWN site. Zero credentials, by design.
 *
 * Every field here is something the company published about itself: JSON-LD it
 * shipped, Open Graph tags it wrote, scripts it loads, headers its stack sets.
 * That is the whole point -- a paid enrichment vendor answers "who does a
 * database think this is", this answers "what does this company say it is",
 * and only the second one is safe to quote back at them in an email.
 *
 * Consequences of that choice, both deliberate:
 * - Every derived field carries an evidence row naming the marker it came from,
 *   so a wrong answer is traceable to the tag that produced it rather than
 *   being an unattributable claim in outreach copy.
 * - Nothing is inferred that the site did not state. Employee count, revenue,
 *   and funding are absent because a site does not publish them, and guessing
 *   them is how enrichment starts lying.
 *
 * Graceful like `audit.ts`: an unreachable page adds a `degraded` entry and
 * leaves its fields null. A host that is not a safe public destination still
 * throws, because that is a caller error, not a probe outcome.
 */

export const DEFAULT_PAGE_BUDGET = 10;

/**
 * Shopify caps a `products.json` page at 250 regardless of `limit`, so a
 * response of exactly 250 means "at least 250", never "exactly 250". The
 * distinction is carried in `catalogCapped` rather than rounded away: "you
 * have 250 products" is a checkable claim, and it would be a false one.
 */
export const PRODUCTS_SAMPLE_LIMIT = 250;

export type PageKind = 'careers' | 'pricing' | 'blog';

interface PageCandidate {
  kind: PageKind;
  label: string;
  paths: readonly string[];
}

const PAGE_CANDIDATES: readonly PageCandidate[] = [
  { kind: 'careers', label: 'Careers page', paths: ['/careers', '/jobs'] },
  { kind: 'pricing', label: 'Pricing page', paths: ['/pricing', '/plans'] },
  { kind: 'blog', label: 'Blog', paths: ['/blog', '/news'] }
];

interface TechRule {
  key: string;
  label: string;
  /** A commerce/CMS platform answers "what is this site built on"; an analytics tag does not. */
  platform: boolean;
  html?: readonly RegExp[];
  headers?: readonly string[];
  generator?: RegExp;
  poweredBy?: RegExp;
}

/**
 * Fingerprint rules, in PLATFORM PRECEDENCE order.
 *
 * Order is load-bearing: a Shopify store behind a Next.js storefront matches
 * both, and `platform` must read `shopify`, because that is the field
 * `gtm.score-lead` wedges on and the commerce platform -- not the rendering
 * framework -- is what determines whether the offer applies.
 */
export const TECH_RULES: readonly TechRule[] = [
  {
    key: 'shopify',
    label: 'Shopify',
    platform: true,
    html: [/cdn\.shopify\.com/i, /Shopify\.theme/i, /shopify-features/i, /myshopify\.com/i],
    headers: ['x-shopid', 'x-shopify-stage']
  },
  {
    key: 'webflow',
    label: 'Webflow',
    platform: true,
    html: [/data-wf-page/i, /assets\.website-files\.com/i, /uploads-ssl\.webflow\.com/i, /cdn\.prod\.website-files\.com/i],
    generator: /webflow/i
  },
  {
    key: 'squarespace',
    label: 'Squarespace',
    platform: true,
    html: [/static1\.squarespace\.com/i, /Static\.SQUARESPACE_CONTEXT/i, /squarespace\.com\/universal/i],
    generator: /squarespace/i
  },
  {
    key: 'wordpress',
    label: 'WordPress',
    platform: true,
    html: [/\/wp-content\//i, /\/wp-includes\//i, /\/wp-json\//i],
    generator: /wordpress/i
  },
  {
    key: 'nextjs',
    label: 'Next.js',
    platform: true,
    html: [/__NEXT_DATA__/, /\/_next\/static\//],
    headers: ['x-nextjs-cache'],
    poweredBy: /next\.js/i
  },
  {
    key: 'hubspot',
    label: 'HubSpot',
    platform: false,
    html: [/js\.hs-scripts\.com/i, /js\.hsforms\.net/i, /js\.hs-analytics\.net/i, /js\.hs-banner\.com/i]
  },
  {
    key: 'segment',
    label: 'Segment',
    platform: false,
    html: [/cdn\.segment\.com/i, /analytics\.segment\.io/i]
  }
];

export interface TechFinding {
  key: string;
  label: string;
  platform: boolean;
  /** The exact marker that produced the match, so the claim stays checkable. */
  marker: string;
}

export interface PostalAddress {
  streetAddress: string | null;
  addressLocality: string | null;
  addressRegion: string | null;
  postalCode: string | null;
  addressCountry: string | null;
}

export interface PagePresence {
  kind: PageKind;
  url: string | null;
  present: boolean;
}

export interface CompanyProfile {
  domain: string;
  name: string | null;
  legalName: string | null;
  description: string | null;
  url: string | null;
  logoUrl: string | null;
  emails: string[];
  telephone: string | null;
  sameAs: string[];
  address: PostalAddress | null;
  country: string | null;
  platform: string | null;
  tech: TechFinding[];
  catalogSize: number | null;
  catalogCapped: boolean;
  pages: PagePresence[];
  /** What could not be read, so a partial answer is never mistaken for a complete one. */
  degraded: string[];
  generatedAt: string;
  evidence: SkillEvidence[];
}

const ORGANIZATION_TYPES: ReadonlySet<string> = new Set([
  'Organization',
  'Corporation',
  'LocalBusiness',
  'Store',
  'OnlineStore',
  'OnlineBusiness',
  'NGO',
  'GovernmentOrganization',
  'EducationalOrganization',
  'SportsOrganization',
  'Brand'
]);

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || null;
}

/** JSON-LD writes URLs as bare strings or as `{ url }` / `{ contentUrl }` objects. */
function urlValue(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return urlValue(value[0]);
  if (isRecord(value)) return text(value.url) ?? text(value.contentUrl);
  return null;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return text(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => stringList(item));
}

function isOrganization(object: Record<string, unknown>): boolean {
  for (const type of jsonLdTypes([object])) {
    if (type.includes('Organization') || ORGANIZATION_TYPES.has(type)) return true;
  }
  return false;
}

function readAddress(value: unknown): PostalAddress | null {
  const source = Array.isArray(value) ? value[0] : value;
  if (!isRecord(source)) return null;
  const country = isRecord(source.addressCountry)
    ? text(source.addressCountry.name) ?? text(source.addressCountry.alternateName)
    : text(source.addressCountry);
  const address: PostalAddress = {
    streetAddress: text(source.streetAddress),
    addressLocality: text(source.addressLocality),
    addressRegion: text(source.addressRegion),
    postalCode: text(source.postalCode),
    addressCountry: country
  };
  const populated = Object.values(address).some((field) => field !== null);
  return populated ? address : null;
}

function formatAddress(address: PostalAddress): string {
  return [address.streetAddress, address.postalCode, address.addressLocality, address.addressRegion, address.addressCountry]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

/**
 * Detect platform and marketing stack from markup, script hosts, and headers.
 *
 * Headers and `<meta generator>` are checked before markup because they are
 * declarations by the stack itself; a CDN hostname in the HTML can be a
 * leftover asset reference from a migration.
 */
export function detectTech(html: string, headers: Headers | null, hasProductFeed = false): TechFinding[] {
  const generator = html ? metaContent(html, 'name', 'generator') : null;
  const poweredBy = headers?.get('x-powered-by') ?? headers?.get('powered-by') ?? null;
  const found: TechFinding[] = [];
  for (const rule of TECH_RULES) {
    let marker: string | null = null;
    for (const name of rule.headers ?? []) {
      if (headers?.get(name)) {
        marker = `${name} response header`;
        break;
      }
    }
    if (!marker && rule.generator && generator && rule.generator.test(generator)) {
      marker = `<meta name="generator"> reads "${generator}"`;
    }
    if (!marker && rule.poweredBy && poweredBy && rule.poweredBy.test(poweredBy)) {
      marker = `x-powered-by: ${poweredBy}`;
    }
    if (!marker && html) {
      for (const pattern of rule.html ?? []) {
        const hit = pattern.exec(html);
        if (hit) {
          marker = `${hit[0]} in homepage HTML`;
          break;
        }
      }
    }
    if (!marker && rule.key === 'shopify' && hasProductFeed) {
      marker = '/products.json returns a Shopify product feed';
    }
    if (marker) found.push({ key: rule.key, label: rule.label, platform: rule.platform, marker });
  }
  return found;
}

/**
 * Page budget as a hard ceiling on outbound requests for one enrichment.
 *
 * A counter rather than a per-check limit: the checks run in sequence and the
 * cheap ones run first, so an unlucky domain spends its budget on the pages
 * that matter instead of timing out three times on `/plans`.
 */
function budgeted(client: FetchLike, budget: number) {
  let used = 0;
  return {
    async get(url: string): Promise<Probe | null> {
      if (used >= budget) return null;
      used += 1;
      return probe(client, url);
    },
    exhausted(): boolean {
      return used >= budget;
    }
  };
}

export interface EnrichOptions {
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
  pageBudget?: number;
}

export async function enrichCompany(domain: string, options: EnrichOptions = {}): Promise<CompanyProfile> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const resolve = options.fetchImpl === undefined;
  await validatePublicHost(clean, { resolve });
  const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
  const base = `https://${clean}`;
  const fetcher = budgeted(client, Math.max(1, options.pageBudget ?? DEFAULT_PAGE_BUDGET));

  const evidence: SkillEvidence[] = [];
  const degraded: string[] = [];

  const home = await fetcher.get(`${base}/`);
  const html = home !== null && home.status < 400 ? home.text : '';
  if (!html) degraded.push('homepage');

  // --- firmographics -------------------------------------------------------
  const organization = extractJsonLd(html).find(isOrganization) ?? null;
  const ogTitle = html ? metaContent(html, 'property', 'og:title') : null;
  const ogSiteName = html ? metaContent(html, 'property', 'og:site_name') : null;
  const ogDescription = html ? metaContent(html, 'property', 'og:description') : null;
  const metaDescription = html ? metaContent(html, 'name', 'description') : null;

  const jsonLdName = organization ? text(organization.name) : null;
  const name = jsonLdName ?? text(ogSiteName) ?? text(ogTitle) ?? (html ? pageTitle(html) : null);
  const nameSource = jsonLdName
    ? 'JSON-LD Organization.name'
    : ogSiteName
      ? 'og:site_name'
      : ogTitle
        ? 'og:title'
        : '<title>';
  if (name) evidence.push({ label: 'Company name', detail: `"${name}" from ${nameSource}.`, sourceUrl: base });

  const jsonLdDescription = organization ? text(organization.description) : null;
  const description = jsonLdDescription ?? text(ogDescription) ?? text(metaDescription);
  if (description) {
    const source = jsonLdDescription ? 'JSON-LD Organization.description' : ogDescription ? 'og:description' : 'meta description';
    evidence.push({ label: 'Description', detail: `${source}: "${description}"`, sourceUrl: base });
  }

  const legalName = organization ? text(organization.legalName) : null;
  const logoUrl = organization ? urlValue(organization.logo) : null;
  const declaredUrl = organization ? urlValue(organization.url) : null;
  const telephone = organization ? text(organization.telephone) : null;
  if (telephone) evidence.push({ label: 'Phone', detail: `JSON-LD Organization.telephone: ${telephone}`, sourceUrl: base });

  const address = organization ? readAddress(organization.address) : null;
  const country = address?.addressCountry ?? null;
  if (address) {
    evidence.push({ label: 'Postal address', detail: `JSON-LD PostalAddress: ${formatAddress(address)}`, sourceUrl: base });
  }

  const emails = [
    ...new Set([...(organization && text(organization.email) ? [String(organization.email).trim().toLowerCase()] : []), ...extractMailtos(html)])
  ].sort();
  if (emails.length > 0) {
    evidence.push({ label: 'Published email', detail: `${emails.length} address(es) published on the homepage: ${emails.join(', ')}.`, sourceUrl: base });
  }

  // `sameAs` is the declared answer; homepage links are the observed one. Both
  // are published by the company, so they are unioned rather than ranked.
  const profiles = new Map<string, string>();
  for (const candidate of organization ? stringList(organization.sameAs) : []) {
    const profile = socialProfile(candidate, base);
    if (profile) profiles.set(profile.url, profile.url);
  }
  for (const link of extractLinks(html)) {
    const profile = socialProfile(link.href, base);
    if (profile) profiles.set(profile.url, profile.url);
  }
  const sameAs = [...profiles.values()].sort();
  if (sameAs.length > 0) {
    evidence.push({ label: 'Social profiles', detail: `${sameAs.length} published profile(s): ${sameAs.join(', ')}.`, sourceUrl: base });
  }

  // --- catalog -------------------------------------------------------------
  const feed = await fetcher.get(`${base}/products.json?limit=${PRODUCTS_SAMPLE_LIMIT}`);
  let catalogSize: number | null = null;
  let catalogCapped = false;
  let hasProductFeed = false;
  if (feed !== null && feed.status === 200 && feed.contentType.includes('json')) {
    try {
      const data: unknown = JSON.parse(feed.text);
      const products = isRecord(data) ? data.products : undefined;
      if (Array.isArray(products)) {
        hasProductFeed = true;
        catalogSize = products.length;
        catalogCapped = products.length >= PRODUCTS_SAMPLE_LIMIT;
        evidence.push({
          label: 'Catalog size',
          detail: `/products.json lists ${catalogCapped ? `${PRODUCTS_SAMPLE_LIMIT}+` : catalogSize} product(s).`,
          sourceUrl: `${base}/products.json`
        });
      }
    } catch {
      // Some other JSON endpoint answering /products.json; not a Shopify feed.
    }
  }

  // --- platform / tech -----------------------------------------------------
  const tech = detectTech(html, home?.headers ?? null, hasProductFeed);
  const platform = tech.find((item) => item.platform)?.key ?? null;
  for (const item of tech) {
    evidence.push({
      label: item.platform ? 'Platform' : 'Marketing stack',
      detail: `${item.label} detected -- ${item.marker}.`,
      sourceUrl: base
    });
  }

  // --- page presence map ---------------------------------------------------
  const pages: PagePresence[] = [];
  for (const candidate of PAGE_CANDIDATES) {
    let found: PagePresence = { kind: candidate.kind, url: null, present: false };
    for (const path of candidate.paths) {
      const response = await fetcher.get(`${base}${path}`);
      if (response === null) continue;
      // A soft 404 that renders the homepage would otherwise report every page
      // as present, which is the one failure mode that fabricates a finding.
      if (response.status === 200 && response.text !== html) {
        found = { kind: candidate.kind, url: `${base}${path}`, present: true };
        break;
      }
    }
    pages.push(found);
    if (found.present && found.url) {
      evidence.push({ label: candidate.label, detail: `${found.url} responds 200.`, sourceUrl: found.url });
    }
  }
  if (fetcher.exhausted()) degraded.push('page-budget-exhausted');

  return {
    domain: clean,
    name,
    legalName,
    description,
    url: declaredUrl,
    logoUrl,
    emails,
    telephone,
    sameAs,
    address,
    country,
    platform,
    tech,
    catalogSize,
    catalogCapped,
    pages,
    degraded,
    generatedAt: new Date().toISOString(),
    evidence
  };
}

/**
 * Project a profile onto `leadFieldsSchema` so enrichment feeds `gtm.score-lead`
 * directly.
 *
 * `vertical` is matched against a caller-supplied vocabulary rather than
 * guessed, and matched on WORD boundaries: substring matching reads "dance" out
 * of "abundance" and would score an unrelated store into the wedge. No match is
 * reported as `null`, never as a best guess -- the scorer treats an absent
 * vertical as a missed rule, which is the honest outcome.
 */
export function toLeadFields(profile: CompanyProfile, verticals: readonly string[] = DEFAULT_SCORE_CONFIG.verticals): LeadFields {
  const haystack = [profile.name, profile.legalName, profile.description].filter((part): part is string => Boolean(part)).join(' ').toLowerCase();
  const vertical = verticals.find((term) => new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`).test(haystack)) ?? null;
  return {
    platform: profile.platform,
    vertical,
    catalogSize: profile.catalogSize,
    contactEmail: profile.emails[0] ?? null,
    emails: profile.emails
  };
}

const inputSchema = z.object({
  domain: z.string().min(1),
  pageBudget: z.number().int().positive().max(50).optional()
});

const addressSchema = z.object({
  streetAddress: z.string().nullable(),
  addressLocality: z.string().nullable(),
  addressRegion: z.string().nullable(),
  postalCode: z.string().nullable(),
  addressCountry: z.string().nullable()
});

const outputSchema = z.object({
  domain: z.string(),
  name: z.string().nullable(),
  legalName: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  logoUrl: z.string().nullable(),
  emails: z.array(z.string()),
  telephone: z.string().nullable(),
  sameAs: z.array(z.string()),
  address: addressSchema.nullable(),
  country: z.string().nullable(),
  platform: z.string().nullable(),
  tech: z.array(z.object({ key: z.string(), label: z.string(), platform: z.boolean(), marker: z.string() })),
  catalogSize: z.number().nullable(),
  catalogCapped: z.boolean(),
  pages: z.array(z.object({ kind: z.enum(['careers', 'pricing', 'blog']), url: z.string().nullable(), present: z.boolean() })),
  degraded: z.array(z.string()),
  generatedAt: z.string(),
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type EnrichInput = z.infer<typeof inputSchema>;

export const enrichCompanySkill: Skill<EnrichInput, CompanyProfile> = {
  manifest: {
    id: 'gtm.enrich-company',
    name: 'Enrich company from its own site',
    version: '1.0.0',
    description:
      "Derive firmographics, platform, tech fingerprint, catalog size, and page presence for a domain from the company's own public site. No credentials required.",
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return enrichCompany(input.domain, { pageBudget: input.pageBudget });
  }
};
