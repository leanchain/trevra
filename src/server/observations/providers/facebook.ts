import type { CredentialAccessor } from '../../research/types.js';
import type { FetchLike } from '../../skills/guard.js';
import { DEFAULT_META_GRAPH_VERSION, META_GRAPH_VERSION_ENV } from './instagram.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';

export const FACEBOOK_PAGE_ACCESS_TOKEN_ENV = 'TREVRA_FACEBOOK_PAGE_ACCESS_TOKEN';

const API_ORIGIN = 'https://graph.facebook.com';
const DOCS_URL = 'https://developers.facebook.com/docs/graph-api/reference/page/';
const REQUEST_TIMEOUT_MS = 20_000;
const POSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TARGETS = 5;
const MAX_POST_PAGES = 3;
const PAGE_SIZE = 100;
const PAGE_ID_RE = /^\d{5,30}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  const numeric =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function graphVersion(credentials: CredentialAccessor): string {
  return credentials.get(META_GRAPH_VERSION_ENV)?.trim() || DEFAULT_META_GRAPH_VERSION;
}

function availability(credentials: CredentialAccessor) {
  const token = credentials.get(FACEBOOK_PAGE_ACCESS_TOKEN_ENV);
  const version = credentials.get(META_GRAPH_VERSION_ENV)?.trim();
  if (version && !/^v\d+\.\d+$/.test(version)) {
    return {
      mode: 'disabled' as const,
      reason: `${META_GRAPH_VERSION_ENV} must look like v26.0.`,
      docsUrl: DOCS_URL
    };
  }
  return token
    ? {
        mode: 'ready' as const,
        reason: 'Facebook Page public-data access token is configured.',
        docsUrl: DOCS_URL
      }
    : {
        mode: 'needs-credential' as const,
        reason: `Set ${FACEBOOK_PAGE_ACCESS_TOKEN_ENV} with Page Public Content/Metadata Access to measure verified Facebook Pages.`,
        docsUrl: DOCS_URL
      };
}

function targets(options: Parameters<ObservationProvider['observe']>[1]): string[] {
  return [...new Set(options.context?.metaPageIds ?? [])]
    .filter((pageId) => PAGE_ID_RE.test(pageId))
    .slice(0, MAX_TARGETS);
}

function evidenceUrl(pageId: string): string {
  return `https://www.facebook.com/${pageId}`;
}

async function graphGet(
  path: string,
  params: Record<string, string>,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ payload: Record<string, unknown> | null; warning: string | null }> {
  const token = options.credentials.get(FACEBOOK_PAGE_ACCESS_TOKEN_ENV);
  if (!token) return { payload: null, warning: `${FACEBOOK_PAGE_ACCESS_TOKEN_ENV} is missing` };
  const endpoint = new URL(
    `/${graphVersion(options.credentials)}/${path.replace(/^\/+/, '')}`,
    API_ORIGIN
  );
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  try {
    const response = await fetchImpl(endpoint.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { payload: null, warning: `Facebook Graph API returned HTTP ${response.status}` };
    }
    const payload = record((await response.json()) as unknown);
    if (!payload) return { payload: null, warning: 'Facebook Graph API returned invalid JSON' };
    const graphError = record(payload.error);
    if (graphError) {
      const message =
        typeof graphError.message === 'string' ? graphError.message : 'Graph API error';
      return { payload: null, warning: `Facebook Graph API returned an error: ${message}` };
    }
    return { payload, warning: null };
  } catch (cause) {
    return {
      payload: null,
      warning: `Facebook Graph API request failed: ${cause instanceof Error ? cause.message.replaceAll(token, '[redacted]') : String(cause)}`
    };
  }
}

async function pageFollowers(
  pageId: string,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ followers: number | null; warning: string | null; verified: boolean }> {
  const result = await graphGet(pageId, { fields: 'id,followers_count' }, options);
  if (!result.payload) return { followers: null, warning: result.warning, verified: false };
  const returnedId =
    typeof result.payload.id === 'string' || typeof result.payload.id === 'number'
      ? String(result.payload.id)
      : '';
  if (returnedId !== pageId) {
    return {
      followers: null,
      warning: `Facebook Graph API returned unexpected Page ${returnedId || 'unknown'}`,
      verified: false
    };
  }
  const followers = finiteNonNegative(result.payload.followers_count);
  return followers === null
    ? { followers: null, warning: 'Facebook Page response omitted followers_count', verified: true }
    : { followers, warning: null, verified: true };
}

async function posts30d(
  pageId: string,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ count: number | null; warning: string | null }> {
  const cutoff = options.now.getTime() - POSTS_WINDOW_MS;
  const until = options.now.getTime();
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;

  for (let page = 0; page < MAX_POST_PAGES; page += 1) {
    const params: Record<string, string> = {
      fields: 'id,created_time',
      since: String(Math.floor(cutoff / 1_000)),
      until: String(Math.floor(until / 1_000)),
      limit: String(PAGE_SIZE)
    };
    if (after) params.after = after;
    const result = await graphGet(`${pageId}/posts`, params, options);
    if (!result.payload) return { count: null, warning: result.warning };
    const rows = Array.isArray(result.payload.data) ? result.payload.data : null;
    if (!rows) return { count: null, warning: 'Facebook Page posts response has no data array' };
    for (const raw of rows) {
      const row = record(raw);
      const id = typeof row?.id === 'string' ? row.id : '';
      const created =
        typeof row?.created_time === 'string' ? Date.parse(row.created_time) : Number.NaN;
      if (!id || Number.isNaN(created)) {
        return {
          count: null,
          warning: 'Facebook Page posts returned an item without id/created_time'
        };
      }
      if (created >= cutoff && created <= until + 60 * 60 * 1_000) seen.add(id);
    }

    const paging = record(result.payload.paging);
    const pagingCursors = record(paging?.cursors);
    const nextAfter = typeof pagingCursors?.after === 'string' ? pagingCursors.after : null;
    const hasNext = typeof paging?.next === 'string' && paging.next.length > 0;
    if (!hasNext) return { count: seen.size, warning: null };
    if (!nextAfter || cursors.has(nextAfter)) {
      return {
        count: null,
        warning: 'Facebook Page posts pagination did not provide a fresh cursor'
      };
    }
    cursors.add(nextAfter);
    after = nextAfter;
  }

  return {
    count: null,
    warning: `Facebook Page posted more than ${MAX_POST_PAGES * PAGE_SIZE} times inside the 30-day measurement window; cadence was left unmeasured`
  };
}

export function facebookPageProvider(): ObservationProvider {
  return {
    key: 'facebook-page-public',
    name: 'Facebook Page public data',
    docsUrl: DOCS_URL,
    credentialEnvVar: FACEBOOK_PAGE_ACCESS_TOKEN_ENV,
    surfaces: ['social'],
    availability,
    async observe(_domain, options) {
      const pageIds = targets(options);
      if (pageIds.length === 0) {
        return {
          providerKey: 'facebook-page-public',
          observations: [],
          measurements: [],
          warnings: []
        };
      }
      const available = availability(options.credentials);
      if (available.mode !== 'ready') {
        return {
          providerKey: 'facebook-page-public',
          observations: [],
          measurements: [],
          warnings: [available.reason]
        };
      }

      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const pageId of pageIds) {
        const scope = `facebook:${pageId}`;
        const observedAt = options.now.toISOString();
        const followers = await pageFollowers(pageId, options);
        if (followers.warning) warnings.push(`Page ${pageId}: ${followers.warning}.`);
        if (!followers.verified) continue;
        if (followers.followers !== null) {
          measurements.push({
            metric: 'social.followers',
            scope,
            value: followers.followers,
            evidenceUrl: evidenceUrl(pageId),
            observedAt
          });
        }

        const cadence = await posts30d(pageId, options);
        if (cadence.warning) warnings.push(`Page ${pageId}: ${cadence.warning}.`);
        if (cadence.count !== null) {
          measurements.push({
            metric: 'social.posts_30d',
            scope,
            value: cadence.count,
            evidenceUrl: evidenceUrl(pageId),
            observedAt
          });
        }
      }
      return { providerKey: 'facebook-page-public', observations: [], measurements, warnings };
    }
  };
}

export function configuredFacebookPageProviders(
  env: NodeJS.ProcessEnv = process.env
): ObservationProvider[] {
  return env[FACEBOOK_PAGE_ACCESS_TOKEN_ENV] ? [facebookPageProvider()] : [];
}
