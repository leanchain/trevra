import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { id, type Db } from '../../db.js';
import { ECOMMERCE_APP_KEYS, detectTech } from '../../skills/enrich.js';
import { normalizeDomain } from '../../skills/ladder.js';
import type {
  ExternalObservation,
  ObservationProvider,
  ObservationProviderOptions
} from '../types.js';

const SNAPSHOT_PREFIX = 'beseam:';
const ECOMMERCE_APPS = new Set<string>(ECOMMERCE_APP_KEYS);
const MAX_HOME_HTML_BYTES = 5_000_000;

interface BeseamCatalogItem {
  key: string;
  label: string;
}

interface BeseamSnapshot {
  version: 1;
  domain: string;
  generatedAt: string;
  platform: string | null;
  platformConfidence: number | null;
  productUrl: string | null;
  productItems: BeseamCatalogItem[] | null;
  tech: string[] | null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsedTime(value: unknown, fallback: Date): string {
  const raw = cleanText(value);
  if (!raw) return fallback.toISOString();
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? fallback.toISOString() : new Date(ms).toISOString();
}

function stateHash(items: readonly BeseamCatalogItem[]): string {
  return createHash('sha256')
    .update(JSON.stringify(items.map((item) => item.key).sort()))
    .digest('hex')
    .slice(0, 16);
}

function catalogItems(value: unknown, platform: string | null): BeseamCatalogItem[] | null {
  const payload = objectOf(value);
  const rawRows =
    platform === 'shopify' ? payload?.products : Array.isArray(value) ? value : payload?.products;
  if (!Array.isArray(rawRows)) return null;

  const found = new Map<string, BeseamCatalogItem>();
  for (const raw of rawRows) {
    const row = objectOf(raw);
    if (!row) continue;
    const rawKey = row.id ?? row.handle ?? row.slug;
    const key =
      typeof rawKey === 'string' || typeof rawKey === 'number' ? String(rawKey).trim() : '';
    if (!key || found.has(key)) continue;
    const rawLabel = row.title ?? row.name ?? row.handle ?? row.slug;
    const label =
      typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.replace(/\s+/g, ' ').trim() : key;
    found.set(key, { key, label: label.slice(0, 160) });
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function readSavedHome(
  summary: Record<string, unknown>,
  domainDir: string
): Promise<string | null> {
  const fetched = Array.isArray(summary.fetched_pages) ? summary.fetched_pages : [];
  const home = fetched
    .map(objectOf)
    .find((entry) => entry?.page_type === 'home' && typeof entry.saved_html === 'string');
  const saved = home ? cleanText(home.saved_html) : null;
  if (!saved) return null;
  const candidate = path.resolve(domainDir, 'pages', path.basename(saved));
  const pagesRoot = path.resolve(domainDir, 'pages') + path.sep;
  if (!candidate.startsWith(pagesRoot)) return null;
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size > MAX_HOME_HTML_BYTES) return null;
    return await fs.readFile(candidate, 'utf8');
  } catch {
    return null;
  }
}

function productEvidenceUrl(
  summary: Record<string, unknown>,
  platform: string | null,
  domain: string
): string | null {
  const endpoints = Array.isArray(summary.public_standard_endpoints)
    ? summary.public_standard_endpoints
        .map(objectOf)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  const key =
    platform === 'shopify'
      ? 'shopify_products'
      : platform === 'woocommerce'
        ? 'wc_store_products'
        : null;
  if (key) {
    const endpoint = endpoints.find((entry) => entry.key === key && entry.valid_response === true);
    const url = endpoint ? cleanText(endpoint.url) : null;
    if (url) return url;
  }
  if (platform === 'shopify') return `https://${domain}/products.json?limit=250`;
  if (platform === 'woocommerce')
    return `https://${domain}/wp-json/wc/store/v1/products?per_page=100`;
  return null;
}

async function currentSnapshot(
  root: string,
  domain: string,
  now: Date
): Promise<BeseamSnapshot | null> {
  const rootPath = path.resolve(root);
  const domainDir = path.resolve(rootPath, domain);
  if (!domainDir.startsWith(rootPath + path.sep)) return null;
  const rawSummary = await readJson(path.join(domainDir, 'domain_summary.json'));
  const summary = objectOf(rawSummary);
  if (!summary || normalizeDomain(cleanText(summary.domain)) !== domain) return null;

  const platform = cleanText(summary.platform)?.toLowerCase() ?? null;
  const confidenceRaw = summary.platform_confidence;
  const platformConfidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : null;

  let products: BeseamCatalogItem[] | null = null;
  if (platform === 'shopify') {
    products = catalogItems(
      await readJson(path.join(domainDir, 'public_data', 'shopify_products.json')),
      platform
    );
  } else if (platform === 'woocommerce') {
    products = catalogItems(
      await readJson(path.join(domainDir, 'public_data', 'wc_store_products.json')),
      platform
    );
  }

  const homeHtml = await readSavedHome(summary, domainDir);
  const tech = homeHtml
    ? detectTech(homeHtml, null)
        .map((finding) => finding.key)
        .sort()
    : null;

  return {
    version: 1,
    domain,
    generatedAt: parsedTime(summary.generated_at ?? summary.corpus_expanded_at, now),
    platform,
    platformConfidence,
    productUrl: productEvidenceUrl(summary, platform, domain),
    productItems: products,
    tech
  };
}

async function loadPrevious(
  db: Db,
  workspaceId: string,
  domain: string
): Promise<BeseamSnapshot | null> {
  const row = await db
    .prepare(
      'SELECT snapshot_json FROM research_snapshots WHERE workspace_id=? AND domain=? ORDER BY captured_at DESC LIMIT 1'
    )
    .get<{ snapshot_json: unknown }>(workspaceId, `${SNAPSHOT_PREFIX}${domain}`);
  if (!row) return null;
  let value: unknown = row.snapshot_json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const raw = objectOf(value);
  if (!raw || raw.version !== 1 || raw.domain !== domain) return null;
  const productItems = raw.productItems;
  const tech = raw.tech;
  return {
    version: 1,
    domain,
    generatedAt: cleanText(raw.generatedAt) ?? new Date(0).toISOString(),
    platform: cleanText(raw.platform),
    platformConfidence:
      typeof raw.platformConfidence === 'number' && Number.isFinite(raw.platformConfidence)
        ? raw.platformConfidence
        : null,
    productUrl: cleanText(raw.productUrl),
    productItems: Array.isArray(productItems)
      ? productItems
          .map(objectOf)
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({ key: cleanText(item.key) ?? '', label: cleanText(item.label) ?? '' }))
          .filter((item) => item.key)
      : null,
    tech: Array.isArray(tech)
      ? tech.filter((item): item is string => typeof item === 'string').sort()
      : null
  };
}

async function saveSnapshot(
  db: Db,
  workspaceId: string,
  snapshot: BeseamSnapshot,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO research_snapshots (id,workspace_id,domain,captured_at,snapshot_json,created_at)
       VALUES (?,?,?,?,?::jsonb,?)`
    )
    .run(
      id('snap'),
      workspaceId,
      `${SNAPSHOT_PREFIX}${snapshot.domain}`,
      snapshot.generatedAt,
      JSON.stringify(snapshot),
      now.toISOString()
    );
}

function diff(previous: BeseamSnapshot | null, current: BeseamSnapshot): ExternalObservation[] {
  if (!previous) return [];
  const observations: ExternalObservation[] = [];
  const observedAt = current.generatedAt;

  if (previous.productItems !== null && current.productItems !== null && current.productUrl) {
    const before = new Set(previous.productItems.map((item) => item.key));
    const added = current.productItems.filter((item) => !before.has(item.key));
    if (added.length > 0) {
      observations.push({
        kind: 'product-launch',
        detail: `${current.domain} added ${added.length} product${added.length === 1 ? '' : 's'} to its public catalog since the previous Beseam crawl (${added
          .slice(0, 3)
          .map((item) => item.label)
          .join('; ')}).`,
        previous: stateHash(previous.productItems),
        current: stateHash(current.productItems),
        evidenceUrl: current.productUrl,
        observedAt
      });
    }
  }

  if (previous.tech !== null && current.tech !== null) {
    const before = new Set(previous.tech);
    const after = new Set(current.tech);
    const added = current.tech.filter((key) => !before.has(key) && ECOMMERCE_APPS.has(key));
    const removed = previous.tech.filter((key) => !after.has(key) && ECOMMERCE_APPS.has(key));
    const previousState = previous.tech.join(', ') || 'none';
    const currentState = current.tech.join(', ') || 'none';
    if (added.length > 0) {
      observations.push({
        kind: 'commerce-app-added',
        detail: `${current.domain} added ecommerce app${added.length === 1 ? '' : 's'} ${added.join(', ')} between Beseam crawls.`,
        previous: previousState,
        current: currentState,
        evidenceUrl: `https://${current.domain}`,
        observedAt
      });
    }
    if (removed.length > 0) {
      observations.push({
        kind: 'commerce-app-removed',
        detail: `${current.domain} dropped ecommerce app${removed.length === 1 ? '' : 's'} ${removed.join(', ')} between Beseam crawls.`,
        previous: previousState,
        current: currentState,
        evidenceUrl: `https://${current.domain}`,
        observedAt
      });
    }
  }

  if (
    previous.platform &&
    current.platform &&
    previous.platform !== current.platform &&
    (previous.platformConfidence ?? 0) >= 0.8 &&
    (current.platformConfidence ?? 0) >= 0.8
  ) {
    observations.push({
      kind: 'storefront-rebuild',
      detail: `Beseam's dated storefront crawls identify ${current.domain} moving from ${previous.platform} to ${current.platform}.`,
      previous: previous.platform,
      current: current.platform,
      evidenceUrl: `https://${current.domain}`,
      observedAt
    });
  }

  return observations;
}

export function beseamCorpusObservationProvider(root: string): ObservationProvider {
  const resolvedRoot = path.resolve(root);
  return {
    key: 'beseam-corpus',
    name: 'Beseam shop corpus',
    docsUrl: null,
    credentialEnvVar: null,
    surfaces: ['products', 'ecommerce_apps', 'site', 'beseam'],
    availability: () => ({
      mode: 'ready',
      reason: `Reading deployment-owned Beseam crawl artifacts from ${resolvedRoot}.`
    }),
    async observe(rawDomain: string, options: ObservationProviderOptions) {
      const domain = normalizeDomain(rawDomain);
      if (!domain)
        return {
          providerKey: 'beseam-corpus',
          observations: [],
          warnings: ['Account domain is invalid.']
        };
      if (!options.db || !options.workspaceId) {
        return {
          providerKey: 'beseam-corpus',
          observations: [],
          warnings: [
            'Beseam corpus observation requires Trevra workspace persistence for its prior-crawl baseline.'
          ]
        };
      }
      const current = await currentSnapshot(resolvedRoot, domain, options.now);
      if (!current) {
        // A configured corpus can legitimately cover only part of a Trevra
        // watchlist. Absence is "not covered", not "the store has no signals".
        return { providerKey: 'beseam-corpus', observations: [], warnings: [] };
      }
      const previous = await loadPrevious(options.db, options.workspaceId, domain);
      if (previous) {
        const previousMs = Date.parse(previous.generatedAt);
        const currentMs = Date.parse(current.generatedAt);
        if (!Number.isNaN(previousMs) && !Number.isNaN(currentMs) && currentMs <= previousMs) {
          return {
            providerKey: 'beseam-corpus',
            observations: [],
            warnings:
              currentMs < previousMs
                ? [`Ignored an older Beseam crawl for ${domain}; stored baseline is newer.`]
                : []
          };
        }
      }
      const observations = diff(previous, current);
      await saveSnapshot(options.db, options.workspaceId, current, options.now);
      return { providerKey: 'beseam-corpus', observations, warnings: [] };
    }
  };
}

export function configuredBeseamCorpusProviders(
  root: string | undefined = process.env.TREVRA_BESEAM_SHOP_CORPUS_DIR
): ObservationProvider[] {
  return root?.trim() ? [beseamCorpusObservationProvider(root.trim())] : [];
}
