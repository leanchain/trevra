import { describe, expect, it } from 'vitest';
import type { CredentialAccessor } from '../../research/types.js';
import type { FetchLike } from '../../skills/guard.js';
import { getScout, listScouts } from '../registry.js';
import { devtoScout } from './devto.js';
import { githubScout } from './github.js';
import { hackernewsScout } from './hackernews.js';
import { dedupeById, matchesQuery } from './http.js';

// No network and no DNS: supplying fetchImpl puts the SSRF guard in
// structural-only mode, so these run offline and deterministically.
const noCredentials: CredentialAccessor = { get: () => undefined };

function jsonFetch(routes: Record<string, unknown>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input) => {
      calls.push(input);
      const match = Object.keys(routes).find((key) => input.includes(key));
      if (!match) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[match]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

describe('scout registry', () => {
  it('reports honest availability for every platform with no credentials set', () => {
    const modes = Object.fromEntries(
      listScouts().map((scout) => [scout.platform, scout.availability(noCredentials).mode])
    );
    expect(modes).toEqual({
      devto: 'ready',
      github: 'ready',
      hackernews: 'ready',
      linkedin: 'disabled',
      lobsters: 'ready',
      mastodon: 'needs-credential',
      reddit: 'needs-credential',
      stackoverflow: 'ready'
    });
  });

  it('always explains an unavailable platform', () => {
    for (const scout of listScouts()) {
      const availability = scout.availability(noCredentials);
      expect(availability.reason.length).toBeGreaterThan(20);
      if (availability.mode !== 'ready') expect(availability.docsUrl).toBeTruthy();
    }
  });

  it('registers LinkedIn as a policy decision that returns nothing rather than omitting it', async () => {
    const linkedin = getScout('linkedin');
    expect(linkedin?.availability(noCredentials).mode).toBe('disabled');
    const result = await linkedin!.search(
      { queries: ['token cost'], limit: 10 },
      { credentials: noCredentials }
    );
    expect(result.threads).toEqual([]);
    expect(result.warnings[0]).toMatch(/disabled by policy, not by configuration/);
  });
});

describe('devto scout', () => {
  it('filters the tag feeds down to threads matching the query terms', async () => {
    const articles = [
      {
        id: 1,
        url: 'https://dev.to/a/1',
        title: 'Cutting my token cost in half',
        description: 'notes',
        tag_list: ['ai'],
        positive_reactions_count: 40,
        comments_count: 8,
        published_at: '2026-08-01T00:00:00Z',
        user: { username: 'ann' }
      },
      {
        id: 2,
        url: 'https://dev.to/a/2',
        title: 'My sourdough starter',
        description: 'bread',
        tag_list: ['food'],
        positive_reactions_count: 3,
        comments_count: 0,
        published_at: '2026-08-01T00:00:00Z',
        user: { username: 'bob' }
      }
    ];
    const { fetchImpl } = jsonFetch({ '/api/articles': articles });

    const result = await devtoScout.search(
      { queries: ['token cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      platform: 'devto',
      externalId: '1',
      url: 'https://dev.to/a/1',
      community: 'ai',
      author: 'ann',
      score: 40,
      numComments: 8
    });
  });

  it('degrades to a warning when the feed errors, rather than throwing', async () => {
    const fetchImpl: FetchLike = async () => new Response('rate limited', { status: 429 });
    const result = await devtoScout.search(
      { queries: ['token cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );
    expect(result.threads).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('sends the API key only when one is set', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('[]', { status: 200 });
    };
    await devtoScout.search(
      { queries: ['x'], limit: 1 },
      { credentials: noCredentials, fetchImpl }
    );
    expect(seen[0]['api-key']).toBeUndefined();

    seen.length = 0;
    await devtoScout.search(
      { queries: ['x'], limit: 1 },
      { credentials: { get: (n) => (n === 'DEVTO_API_KEY' ? 'k' : undefined) }, fetchImpl }
    );
    expect(seen[0]['api-key']).toBe('k');
  });
});

describe('hackernews scout', () => {
  it('parses Algolia hits and keeps the tags the scorer reads', async () => {
    const { fetchImpl, calls } = jsonFetch({
      '/search': {
        hits: [
          {
            objectID: '4242',
            title: 'Ask HN: how do you control agent token cost?',
            story_text: '<p>We are burning $2k a month.</p>',
            author: 'pg',
            points: 88,
            num_comments: 60,
            created_at_i: 1_785_000_000,
            _tags: ['story', 'ask_hn']
          }
        ]
      }
    });

    const result = await hackernewsScout.search(
      { queries: ['token cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );

    expect(result.threads).toHaveLength(1);
    const thread = result.threads[0];
    expect(thread.externalId).toBe('4242');
    expect(thread.url).toBe('https://news.ycombinator.com/item?id=4242');
    // HN has no community, so it is exempt from cooldown and ratio checks.
    expect(thread.community).toBeNull();
    expect(thread.metadata.tags).toContain('ask_hn');
    // HTML is stripped so the scorer matches on words, not markup.
    expect(thread.content).toBe('We are burning $2k a month.');
    // Parenthesised tags = OR. A bare comma-separated list is AND and matches nothing.
    expect(calls[0]).toContain('tags=%28story%2Ccomment%2Cask_hn%2Cshow_hn%29');
  });

  it('points url at the HN item page even when the story links elsewhere', async () => {
    // `url` is the reply target: draft-reply copies it into submitUrl, and a
    // story's own link is somebody else's site, where no reply can be posted.
    const { fetchImpl } = jsonFetch({
      '/search': {
        hits: [
          {
            objectID: '77',
            url: 'https://example.com/blog/post',
            title: 'token cost',
            author: 'a',
            points: 5,
            num_comments: 2,
            created_at_i: 1_785_000_000,
            _tags: ['story']
          }
        ]
      }
    });

    const result = await hackernewsScout.search(
      { queries: ['token cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );

    expect(result.threads[0].url).toBe('https://news.ycombinator.com/item?id=77');
    // The submitted link is still worth having -- it is the thread's subject.
    expect(result.threads[0].metadata.storyUrl).toBe('https://example.com/blog/post');
  });

  it('merges results across query terms without duplicating a thread', async () => {
    const hit = {
      objectID: '1',
      title: 'token cost',
      story_text: 'x',
      author: 'a',
      points: 1,
      num_comments: 0,
      created_at_i: 1_785_000_000,
      _tags: ['story']
    };
    const { fetchImpl } = jsonFetch({ '/search': { hits: [hit] } });
    const result = await hackernewsScout.search(
      { queries: ['a', 'b', 'c'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );
    expect(result.threads).toHaveLength(1);
  });
});

describe('http helpers', () => {
  it('requires every query term to be present', () => {
    expect(matchesQuery('Reducing token cost with agents', 'token cost')).toBe(true);
    expect(matchesQuery('Reducing TOKEN COST', 'token cost')).toBe(true);
    expect(matchesQuery('Reducing token usage', 'token cost')).toBe(false);
  });

  it('dedupes across batches and honours the limit', () => {
    const batches = [
      [{ externalId: 'a' }, { externalId: 'b' }],
      [{ externalId: 'b' }, { externalId: 'c' }]
    ];
    expect(dedupeById(batches, 10).map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);
    expect(dedupeById(batches, 2).map((entry) => entry.externalId)).toEqual(['a', 'b']);
  });
});

describe('scout community scoping', () => {
  const issues = { items: [] };

  it('keeps the configured repo filter when communities is absent', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['agent cost'], limit: 10 },
      { credentials: noCredentials, fetchImpl }
    );
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).toContain('repo:');
  });

  it('drops the repo filter when communities is an empty array', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['trevra'], limit: 10, communities: [] },
      { credentials: noCredentials, fetchImpl }
    );
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0])).not.toContain('repo:');
    expect(decodeURIComponent(calls[0])).toContain('trevra');
    expect(decodeURIComponent(calls[0])).toContain('is:issue');
  });

  it('scopes to the supplied repos when communities is non-empty', async () => {
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com/search/issues': issues });
    await githubScout.search(
      { queries: ['trevra'], limit: 10, communities: ['acme/widgets'] },
      { credentials: noCredentials, fetchImpl }
    );
    expect(decodeURIComponent(calls[0])).toContain('repo:acme/widgets');
  });
});
