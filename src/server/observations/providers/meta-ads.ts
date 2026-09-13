import type { CredentialAccessor } from '../../research/types.js';
import type { FetchLike } from '../../skills/guard.js';
import { DEFAULT_META_GRAPH_VERSION, META_GRAPH_VERSION_ENV } from './instagram.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';

export const META_AD_LIBRARY_TOKEN_ENV = 'TREVRA_META_AD_LIBRARY_ACCESS_TOKEN';
export const META_AD_LIBRARY_COUNTRIES_ENV = 'TREVRA_META_AD_LIBRARY_COUNTRIES_JSON';

const DOCS_URL = 'https://www.facebook.com/ads/library/api/';
const API_ORIGIN = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TARGETS = 5;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const PAGE_ID_RE = /^\d{5,30}$/;

/** Commercial/all-ad API coverage is the EU + UK surface documented by Meta. */
export const META_AD_LIBRARY_ALL_AD_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'GB'
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMetaAdLibraryCountries(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > META_AD_LIBRARY_ALL_AD_COUNTRIES.size
  ) {
    throw new Error(
      `${META_AD_LIBRARY_COUNTRIES_ENV} must be a non-empty JSON array of EU/UK ISO country codes`
    );
  }
  const countries = parsed.map((value) => String(value).trim().toUpperCase());
  if (countries.some((value) => !META_AD_LIBRARY_ALL_AD_COUNTRIES.has(value))) {
    throw new Error(
      `${META_AD_LIBRARY_COUNTRIES_ENV} supports EU member states and GB only for ad_type=ALL`
    );
  }
  if (new Set(countries).size !== countries.length) {
    throw new Error(`${META_AD_LIBRARY_COUNTRIES_ENV} must not contain duplicate country codes`);
  }
  return countries.sort();
}

function graphVersion(credentials: CredentialAccessor): string {
  return credentials.get(META_GRAPH_VERSION_ENV)?.trim() || DEFAULT_META_GRAPH_VERSION;
}

function availability(credentials: CredentialAccessor) {
  const token = credentials.get(META_AD_LIBRARY_TOKEN_ENV);
  const rawCountries = credentials.get(META_AD_LIBRARY_COUNTRIES_ENV);
  const version = credentials.get(META_GRAPH_VERSION_ENV)?.trim();
  if (version && !/^v\d+\.\d+$/.test(version)) {
    return {
      mode: 'disabled' as const,
      reason: `${META_GRAPH_VERSION_ENV} must look like v26.0.`,
      docsUrl: DOCS_URL
    };
  }
  let countries: string[] = [];
  try {
    countries = parseMetaAdLibraryCountries(rawCountries);
  } catch (cause) {
    return {
      mode: 'disabled' as const,
      reason: cause instanceof Error ? cause.message : String(cause),
      docsUrl: DOCS_URL
    };
  }
  const missing = [
    !token ? META_AD_LIBRARY_TOKEN_ENV : null,
    countries.length === 0 ? META_AD_LIBRARY_COUNTRIES_ENV : null
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      mode: 'needs-credential' as const,
      reason: `Set ${missing.join(' and ')} to enable exact Meta Ad Library counts.`,
      docsUrl: DOCS_URL
    };
  }
  return {
    mode: 'ready' as const,
    reason: `Meta Ad Library access is configured for ${countries.join(', ')}.`,
    docsUrl: DOCS_URL
  };
}

function targets(options: Parameters<ObservationProvider['observe']>[1]): string[] {
  return [...new Set(options.context?.metaPageIds ?? [])]
    .filter((pageId) => PAGE_ID_RE.test(pageId))
    .slice(0, MAX_TARGETS);
}

function publicEvidenceUrl(pageId: string): string {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('active_status', 'active');
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('view_all_page_id', pageId);
  return url.toString();
}

async function fetchPage(
  pageId: string,
  countries: readonly string[],
  after: string | null,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ payload: Record<string, unknown> | null; warning: string | null }> {
  const token = options.credentials.get(META_AD_LIBRARY_TOKEN_ENV);
  if (!token) return { payload: null, warning: `${META_AD_LIBRARY_TOKEN_ENV} is missing` };
  const url = new URL(`/${graphVersion(options.credentials)}/ads_archive`, API_ORIGIN);
  url.searchParams.set('access_token', token);
  url.searchParams.set('ad_type', 'ALL');
  url.searchParams.set('ad_active_status', 'ACTIVE');
  url.searchParams.set('ad_reached_countries', JSON.stringify(countries));
  url.searchParams.set('search_page_ids', JSON.stringify([pageId]));
  url.searchParams.set('fields', 'page_id,page_name,ad_snapshot_url');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (after) url.searchParams.set('after', after);

  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { payload: null, warning: `Meta Ad Library returned HTTP ${response.status}` };
    }
    const payload = record((await response.json()) as unknown);
    return payload
      ? { payload, warning: null }
      : { payload: null, warning: 'Meta Ad Library returned invalid JSON' };
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    return {
      payload: null,
      warning: `Meta Ad Library request failed: ${raw.replaceAll(token, '[redacted]')}`
    };
  }
}

async function countActiveAds(
  pageId: string,
  countries: readonly string[],
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ count: number | null; warning: string | null }> {
  const seenAds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(pageId, countries, after, options);
    if (!result.payload) return { count: null, warning: result.warning };
    const rows = Array.isArray(result.payload.data) ? result.payload.data : null;
    if (!rows) return { count: null, warning: 'Meta Ad Library response has no data array' };

    for (const raw of rows) {
      const row = record(raw);
      const returnedPageId =
        typeof row?.page_id === 'string' || typeof row?.page_id === 'number'
          ? String(row.page_id)
          : '';
      const snapshot = typeof row?.ad_snapshot_url === 'string' ? row.ad_snapshot_url.trim() : '';
      if (returnedPageId !== pageId) {
        return {
          count: null,
          warning: `Meta Ad Library returned an ad for unexpected Page ${returnedPageId || 'unknown'}`
        };
      }
      if (!snapshot) {
        return { count: null, warning: 'Meta Ad Library returned an ad without ad_snapshot_url' };
      }
      seenAds.add(snapshot);
    }

    const paging = record(result.payload.paging);
    const cursors = record(paging?.cursors);
    const nextAfter = typeof cursors?.after === 'string' ? cursors.after : null;
    const hasNext = typeof paging?.next === 'string' && paging.next.length > 0;
    if (!hasNext) return { count: seenAds.size, warning: null };
    if (!nextAfter || seenCursors.has(nextAfter)) {
      return { count: null, warning: 'Meta Ad Library pagination did not provide a fresh cursor' };
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
  }

  return {
    count: null,
    warning: `Meta Ad Library exceeded ${MAX_PAGES * PAGE_SIZE} active ads; exact count was left unmeasured`
  };
}

export function metaAdLibraryProvider(): ObservationProvider {
  return {
    key: 'meta-ad-library',
    name: 'Meta Ad Library',
    docsUrl: DOCS_URL,
    credentialEnvVar: META_AD_LIBRARY_TOKEN_ENV,
    surfaces: ['meta_ads'],
    availability,
    async observe(_domain, options) {
      const pageIds = targets(options);
      if (pageIds.length === 0) {
        return { providerKey: 'meta-ad-library', observations: [], measurements: [], warnings: [] };
      }
      const available = availability(options.credentials);
      if (available.mode !== 'ready') {
        return {
          providerKey: 'meta-ad-library',
          observations: [],
          measurements: [],
          warnings: [available.reason]
        };
      }
      const countries = parseMetaAdLibraryCountries(
        options.credentials.get(META_AD_LIBRARY_COUNTRIES_ENV)
      );
      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const pageId of pageIds) {
        const counted = await countActiveAds(pageId, countries, options);
        if (counted.warning) {
          warnings.push(`Page ${pageId}: ${counted.warning}.`);
          continue;
        }
        if (counted.count === null) continue;
        measurements.push({
          metric: 'meta.active_ads',
          scope: `meta:${pageId}:${countries.join(',')}`,
          value: counted.count,
          evidenceUrl: publicEvidenceUrl(pageId),
          observedAt: options.now.toISOString()
        });
      }
      return { providerKey: 'meta-ad-library', observations: [], measurements, warnings };
    }
  };
}

export function configuredMetaAdLibraryProviders(
  env: NodeJS.ProcessEnv = process.env
): ObservationProvider[] {
  if (!env[META_AD_LIBRARY_TOKEN_ENV] && !env[META_AD_LIBRARY_COUNTRIES_ENV]) return [];
  return [metaAdLibraryProvider()];
}
