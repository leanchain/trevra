import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import {
  configuredYouTubeDataApiProviders,
  YOUTUBE_API_KEY_ENV,
  youtubeDataApiProvider
} from './youtube.js';

const CHANNEL = 'UCnGErLCau5qNJ0Xwe6uEyTw';
const now = new Date('2026-09-12T08:00:00.000Z');
const credentials = (key?: string): CredentialAccessor => ({
  get: (name) => (name === YOUTUBE_API_KEY_ENV ? key : undefined)
});

function context(handle = CHANNEL) {
  return {
    socialProfiles: [
      {
        platform: 'youtube',
        handle,
        url: `https://www.youtube.com/channel/${handle}`
      }
    ]
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('YouTube Data API observation provider', () => {
  it('is opt-in and reports a missing key through availability', () => {
    expect(configuredYouTubeDataApiProviders({})).toEqual([]);
    expect(youtubeDataApiProvider().availability(credentials())).toMatchObject({
      mode: 'needs-credential'
    });
    expect(
      configuredYouTubeDataApiProviders({ [YOUTUBE_API_KEY_ENV]: 'key' })[0].availability(
        credentials('key')
      )
    ).toMatchObject({ mode: 'ready' });
  });

  it('uses a published channel ID, resolves the uploads playlist, and measures subscribers/cadence', async () => {
    const seen: URL[] = [];
    const result = await youtubeDataApiProvider().observe('allbirds.com', {
      credentials: credentials('secret-key'),
      now,
      context: context(),
      fetchImpl: async (input) => {
        const url = new URL(input);
        seen.push(url);
        if (url.pathname.endsWith('/channels')) {
          return json({
            items: [
              {
                contentDetails: { relatedPlaylists: { uploads: 'UU_UPLOADS' } },
                statistics: { subscriberCount: '250000' }
              }
            ]
          });
        }
        if (url.pathname.endsWith('/playlistItems')) {
          return json({
            items: [
              { contentDetails: { videoPublishedAt: '2026-09-11T08:00:00Z' } },
              { contentDetails: { videoPublishedAt: '2026-08-29T08:00:00Z' } },
              { contentDetails: { videoPublishedAt: '2026-08-01T08:00:00Z' } }
            ]
          });
        }
        return json({}, 404);
      }
    });

    expect(seen).toHaveLength(2);
    expect(seen.every((url) => url.origin === 'https://www.googleapis.com')).toBe(true);
    expect(seen[0].searchParams.get('key')).toBe('secret-key');
    expect(seen[0].searchParams.get('id')).toBe(CHANNEL);
    expect(seen[1].searchParams.get('playlistId')).toBe('UU_UPLOADS');
    expect(result.measurements).toEqual([
      {
        metric: 'social.followers',
        scope: `youtube:${CHANNEL}`,
        value: 250000,
        evidenceUrl: `https://www.youtube.com/channel/${CHANNEL}`,
        observedAt: now.toISOString()
      },
      {
        metric: 'social.posts_30d',
        scope: `youtube:${CHANNEL}`,
        value: 2,
        evidenceUrl: `https://www.youtube.com/channel/${CHANNEL}`,
        observedAt: now.toISOString()
      }
    ]);
  });

  it('paginates the uploads playlist until an older video proves the 30-day count is complete', async () => {
    let playlistCalls = 0;
    const result = await youtubeDataApiProvider().observe('acme.test', {
      credentials: credentials('key'),
      now,
      context: context(),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/channels')) {
          return json({
            items: [
              { contentDetails: { relatedPlaylists: { uploads: 'UU_UPLOADS' } }, statistics: {} }
            ]
          });
        }
        playlistCalls += 1;
        if (playlistCalls === 1) {
          return json({
            nextPageToken: 'next',
            items: [{ contentDetails: { videoPublishedAt: '2026-09-11T08:00:00Z' } }]
          });
        }
        expect(url.searchParams.get('pageToken')).toBe('next');
        return json({
          items: [
            { contentDetails: { videoPublishedAt: '2026-09-01T08:00:00Z' } },
            { contentDetails: { videoPublishedAt: '2026-08-01T08:00:00Z' } }
          ]
        });
      }
    });
    expect(playlistCalls).toBe(2);
    expect(result.measurements).toEqual([
      {
        metric: 'social.posts_30d',
        scope: `youtube:${CHANNEL}`,
        value: 2,
        evidenceUrl: `https://www.youtube.com/channel/${CHANNEL}`,
        observedAt: now.toISOString()
      }
    ]);
  });

  it('does not guess a channel ID from an @handle URL', async () => {
    let calls = 0;
    const result = await youtubeDataApiProvider().observe('acme.test', {
      credentials: credentials('key'),
      now,
      context: context('@acme'),
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      }
    });
    expect(calls).toBe(0);
    expect(result.measurements).toEqual([]);
  });

  it('leaves very high cadence unmeasured after the bounded page ceiling', async () => {
    let playlistCalls = 0;
    const result = await youtubeDataApiProvider().observe('acme.test', {
      credentials: credentials('key'),
      now,
      context: context(),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/channels')) {
          return json({
            items: [
              { contentDetails: { relatedPlaylists: { uploads: 'UU_UPLOADS' } }, statistics: {} }
            ]
          });
        }
        playlistCalls += 1;
        return json({
          nextPageToken: `page-${playlistCalls + 1}`,
          items: Array.from({ length: 50 }, () => ({
            contentDetails: { videoPublishedAt: '2026-09-11T08:00:00Z' }
          }))
        });
      }
    });
    expect(playlistCalls).toBe(3);
    expect(result.measurements).toEqual([]);
    expect(result.warnings[0]).toContain('cadence was left unmeasured');
  });
});
