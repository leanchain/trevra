import type { CredentialAccessor } from '../../research/types.js';
import type { FetchLike } from '../../skills/guard.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';

export const YOUTUBE_API_KEY_ENV = 'TREVRA_YOUTUBE_API_KEY';

const POSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TARGETS = 2;
const MAX_PLAYLIST_PAGES = 3;
const MAX_RESULTS = 50;
const REQUEST_TIMEOUT_MS = 20_000;
const DOCS_URL = 'https://developers.google.com/youtube/v3/guides/implementation/videos';
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const API_ORIGIN = 'https://www.googleapis.com';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function availability(credentials: CredentialAccessor) {
  return credentials.get(YOUTUBE_API_KEY_ENV)
    ? {
        mode: 'ready' as const,
        reason: 'YouTube Data API key is configured.',
        docsUrl: DOCS_URL
      }
    : {
        mode: 'needs-credential' as const,
        reason: `Set ${YOUTUBE_API_KEY_ENV} to measure company-published YouTube channels.`,
        docsUrl: DOCS_URL
      };
}

function targets(options: Parameters<ObservationProvider['observe']>[1]) {
  const found = new Map<string, { channelId: string; profileUrl: string }>();
  for (const profile of options.context?.socialProfiles ?? []) {
    if (profile.platform !== 'youtube' || !CHANNEL_ID_RE.test(profile.handle)) continue;
    if (!found.has(profile.handle)) {
      found.set(profile.handle, { channelId: profile.handle, profileUrl: profile.url });
    }
    if (found.size >= MAX_TARGETS) break;
  }
  return [...found.values()];
}

async function apiGet(
  path: string,
  params: Record<string, string>,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ payload: Record<string, unknown> | null; warning: string | null }> {
  const key = options.credentials.get(YOUTUBE_API_KEY_ENV);
  if (!key) return { payload: null, warning: `${YOUTUBE_API_KEY_ENV} is missing` };
  const url = new URL(path, API_ORIGIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('key', key);
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok)
      return { payload: null, warning: `YouTube Data API returned HTTP ${response.status}` };
    const payload = record((await response.json()) as unknown);
    return payload
      ? { payload, warning: null }
      : { payload: null, warning: 'YouTube Data API returned invalid JSON' };
  } catch (cause) {
    return {
      payload: null,
      warning: `YouTube Data API request failed: ${cause instanceof Error ? cause.message : String(cause)}`
    };
  }
}

function channelInfo(payload: Record<string, unknown>): {
  uploadsPlaylistId: string | null;
  subscribers: number | null;
} {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const channel = record(items[0]);
  const content = record(channel?.contentDetails);
  const playlists = record(content?.relatedPlaylists);
  const uploads = typeof playlists?.uploads === 'string' ? playlists.uploads : null;
  const statistics = record(channel?.statistics);
  const hidden = statistics?.hiddenSubscriberCount === true;
  const rawSubscribers = statistics?.subscriberCount;
  const subscribers =
    !hidden &&
    (typeof rawSubscribers === 'string' || typeof rawSubscribers === 'number') &&
    Number.isFinite(Number(rawSubscribers)) &&
    Number(rawSubscribers) >= 0
      ? Number(rawSubscribers)
      : null;
  return { uploadsPlaylistId: uploads, subscribers };
}

async function countUploads30d(
  playlistId: string,
  options: Parameters<ObservationProvider['observe']>[1]
): Promise<{ count: number | null; warning: string | null }> {
  const cutoff = options.now.getTime() - POSTS_WINDOW_MS;
  let pageToken: string | null = null;
  let count = 0;

  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const request: Record<string, string> = {
      part: 'contentDetails',
      playlistId,
      maxResults: String(MAX_RESULTS)
    };
    if (pageToken) request.pageToken = pageToken;
    const result = await apiGet('/youtube/v3/playlistItems', request, options);
    if (!result.payload) return { count: null, warning: result.warning };
    const items = Array.isArray(result.payload.items) ? result.payload.items : [];
    const dates: number[] = [];
    for (const raw of items) {
      const item = record(raw);
      const details = record(item?.contentDetails);
      const published =
        typeof details?.videoPublishedAt === 'string'
          ? Date.parse(details.videoPublishedAt)
          : Number.NaN;
      if (Number.isNaN(published)) {
        return {
          count: null,
          warning: 'YouTube uploads playlist contained an item without videoPublishedAt'
        };
      }
      dates.push(published);
    }

    count += dates.filter(
      (date) => date >= cutoff && date <= options.now.getTime() + 60 * 60 * 1_000
    ).length;
    if (dates.length === 0 || Math.min(...dates) <= cutoff) return { count, warning: null };

    const next =
      typeof result.payload.nextPageToken === 'string' ? result.payload.nextPageToken : null;
    if (!next) return { count, warning: null };
    pageToken = next;
  }

  return {
    count: null,
    warning: `YouTube uploads exceeded ${MAX_PLAYLIST_PAGES * MAX_RESULTS} videos inside the 30-day window; cadence was left unmeasured`
  };
}

export function youtubeDataApiProvider(): ObservationProvider {
  return {
    key: 'youtube-data-api',
    name: 'YouTube Data API',
    docsUrl: DOCS_URL,
    credentialEnvVar: YOUTUBE_API_KEY_ENV,
    surfaces: ['social'],
    availability,
    async observe(_domain, options) {
      const channelTargets = targets(options);
      if (channelTargets.length === 0) {
        return {
          providerKey: 'youtube-data-api',
          observations: [],
          measurements: [],
          warnings: []
        };
      }
      if (availability(options.credentials).mode !== 'ready') {
        return {
          providerKey: 'youtube-data-api',
          observations: [],
          measurements: [],
          warnings: [`${YOUTUBE_API_KEY_ENV} is required for YouTube measurements.`]
        };
      }

      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const target of channelTargets) {
        const channel = await apiGet(
          '/youtube/v3/channels',
          { part: 'contentDetails,statistics', id: target.channelId },
          options
        );
        if (!channel.payload) {
          warnings.push(`${target.channelId}: ${channel.warning}.`);
          continue;
        }
        const info = channelInfo(channel.payload);
        if (!info.uploadsPlaylistId) {
          warnings.push(
            `${target.channelId}: YouTube returned no uploads playlist; no cadence was inferred.`
          );
          continue;
        }
        const scope = `youtube:${target.channelId}`;
        const observedAt = options.now.toISOString();
        if (info.subscribers !== null) {
          measurements.push({
            metric: 'social.followers',
            scope,
            value: info.subscribers,
            evidenceUrl: target.profileUrl,
            observedAt
          });
        }
        const cadence = await countUploads30d(info.uploadsPlaylistId, options);
        if (cadence.warning) warnings.push(`${target.channelId}: ${cadence.warning}.`);
        if (cadence.count !== null) {
          measurements.push({
            metric: 'social.posts_30d',
            scope,
            value: cadence.count,
            evidenceUrl: target.profileUrl,
            observedAt
          });
        }
      }
      return { providerKey: 'youtube-data-api', observations: [], measurements, warnings };
    }
  };
}

export function configuredYouTubeDataApiProviders(
  env: NodeJS.ProcessEnv = process.env
): ObservationProvider[] {
  return env[YOUTUBE_API_KEY_ENV]?.trim() ? [youtubeDataApiProvider()] : [];
}
