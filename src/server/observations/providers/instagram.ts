import type { CredentialAccessor } from '../../research/types.js';
import type { FetchLike } from '../../skills/guard.js';
import type {
  ExternalMeasurement,
  ObservationProvider,
  ObservationProviderOptions
} from '../types.js';

export const META_GRAPH_TOKEN_ENV = 'TREVRA_META_GRAPH_ACCESS_TOKEN';
export const INSTAGRAM_BUSINESS_ACCOUNT_ENV = 'TREVRA_INSTAGRAM_BUSINESS_ACCOUNT_ID';
export const META_GRAPH_VERSION_ENV = 'TREVRA_META_GRAPH_VERSION';
export const DEFAULT_META_GRAPH_VERSION = 'v26.0';

const MAX_TARGETS = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const POSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const DOCS_URL =
  'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/';

function availability(credentials: CredentialAccessor) {
  const token = credentials.get(META_GRAPH_TOKEN_ENV);
  const accountId = credentials.get(INSTAGRAM_BUSINESS_ACCOUNT_ENV);
  const configuredVersion = credentials.get(META_GRAPH_VERSION_ENV)?.trim();
  if (configuredVersion && !/^v\d+\.\d+$/.test(configuredVersion)) {
    return {
      mode: 'disabled' as const,
      reason: `${META_GRAPH_VERSION_ENV} must look like v26.0.`,
      docsUrl: DOCS_URL
    };
  }
  const missing = [
    !token ? META_GRAPH_TOKEN_ENV : null,
    !accountId ? INSTAGRAM_BUSINESS_ACCOUNT_ENV : null
  ].filter(Boolean);
  if (missing.length) {
    return {
      mode: 'needs-credential' as const,
      reason: `Set ${missing.join(' and ')} to enable Instagram Business Discovery.`,
      docsUrl: DOCS_URL
    };
  }
  return {
    mode: 'ready' as const,
    reason: 'Instagram Business Discovery credentials are configured.',
    docsUrl: DOCS_URL
  };
}

function graphVersion(credentials: CredentialAccessor): string {
  return credentials.get(META_GRAPH_VERSION_ENV)?.trim() || DEFAULT_META_GRAPH_VERSION;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function profileTargets(options: ObservationProviderOptions) {
  const found = new Map<string, { handle: string; url: string }>();
  for (const profile of options.context?.socialProfiles ?? []) {
    if (profile.platform !== 'instagram') continue;
    const handle = profile.handle.replace(/^@/, '').trim();
    // The handle is embedded inside Graph's `fields` expression, not merely a
    // URL parameter. Keep it to Instagram's username alphabet/length so a
    // malicious website link cannot inject another Graph field expression.
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) continue;
    const key = handle.toLowerCase();
    if (!found.has(key)) found.set(key, { handle, url: profile.url });
    if (found.size >= MAX_TARGETS) break;
  }
  return [...found.values()];
}

function mediaPosts30d(
  discovery: Record<string, unknown>,
  now: Date
): { count: number | null; warning: string | null } {
  const media = record(discovery.media);
  if (!media) return { count: null, warning: null };
  const rows = Array.isArray(media.data) ? media.data : [];
  const cutoff = now.getTime() - POSTS_WINDOW_MS;
  const timestamps = rows
    .map(record)
    .map((row) => (typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => b - a);
  const paging = record(media.paging);
  const hasNext = typeof paging?.next === 'string' && paging.next.length > 0;
  // Media is returned newest-first. If Graph says there is another page and
  // every timestamp we received is still inside 30 days, the true count is
  // greater than this page and Trevra must not publish a fake exact cadence.
  if (hasNext && timestamps.length > 0 && timestamps.at(-1)! >= cutoff) {
    return {
      count: null,
      warning:
        'Instagram media exceeded the bounded first page inside the 30-day window; cadence was left unmeasured.'
    };
  }
  return { count: timestamps.filter((value) => value >= cutoff).length, warning: null };
}

async function graphRequest(
  handle: string,
  options: ObservationProviderOptions
): Promise<Response> {
  const token = options.credentials.get(META_GRAPH_TOKEN_ENV) as string;
  const accountId = options.credentials.get(INSTAGRAM_BUSINESS_ACCOUNT_ENV) as string;
  const version = graphVersion(options.credentials);
  const fields = `business_discovery.username(${handle}){followers_count,media_count,media.limit(100){timestamp}}`;
  const endpoint = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(accountId)}`
  );
  endpoint.searchParams.set('fields', fields);
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return fetchImpl(endpoint.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

export function instagramBusinessDiscoveryProvider(): ObservationProvider {
  return {
    key: 'instagram-business-discovery',
    name: 'Instagram Business Discovery',
    docsUrl: DOCS_URL,
    credentialEnvVar: META_GRAPH_TOKEN_ENV,
    surfaces: ['social'],
    availability,
    async observe(_domain, options) {
      const targets = profileTargets(options);
      if (targets.length === 0) {
        return {
          providerKey: 'instagram-business-discovery',
          observations: [],
          measurements: [],
          warnings: []
        };
      }
      if (availability(options.credentials).mode !== 'ready') {
        return {
          providerKey: 'instagram-business-discovery',
          observations: [],
          measurements: [],
          warnings: ['Instagram Business Discovery credentials are incomplete.']
        };
      }

      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const target of targets) {
        try {
          const response = await graphRequest(target.handle, options);
          if (!response.ok) {
            warnings.push(
              `Instagram Business Discovery returned HTTP ${response.status} for @${target.handle}; the account may not be a public Professional account or the deployment credential may lack access.`
            );
            continue;
          }
          const payload = record((await response.json()) as unknown);
          const discovery = record(payload?.business_discovery);
          if (!discovery) {
            warnings.push(
              `Instagram Business Discovery returned no business_discovery object for @${target.handle}; no social measurement was inferred.`
            );
            continue;
          }
          const scope = `instagram:${target.handle.toLowerCase()}`;
          const observedAt = options.now.toISOString();
          const followers = finiteNonNegative(discovery.followers_count);
          if (followers !== null) {
            measurements.push({
              metric: 'social.followers',
              scope,
              value: followers,
              evidenceUrl: target.url,
              observedAt
            });
          }
          const cadence = mediaPosts30d(discovery, options.now);
          if (cadence.warning) warnings.push(`@${target.handle}: ${cadence.warning}`);
          if (cadence.count !== null) {
            measurements.push({
              metric: 'social.posts_30d',
              scope,
              value: cadence.count,
              evidenceUrl: target.url,
              observedAt
            });
          }
        } catch (cause) {
          warnings.push(
            `Instagram Business Discovery failed for @${target.handle}: ${cause instanceof Error ? cause.message : String(cause)}.`
          );
        }
      }
      return {
        providerKey: 'instagram-business-discovery',
        observations: [],
        measurements,
        warnings
      };
    }
  };
}

/**
 * Opt-in by configuration. A completely unconfigured deployment stays silent;
 * partial configuration surfaces a needs-credential status instead of looking
 * like "no social movement".
 */
export function configuredInstagramBusinessDiscoveryProviders(
  env: NodeJS.ProcessEnv = process.env
): ObservationProvider[] {
  if (!env[META_GRAPH_TOKEN_ENV] && !env[INSTAGRAM_BUSINESS_ACCOUNT_ENV]) return [];
  return [instagramBusinessDiscoveryProvider()];
}
