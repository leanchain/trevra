import { stripTags } from '../../skills/html.js';
import type { OutreachScout, OutreachThread } from '../types.js';
import { cleanText, dedupeById, getJson, scoutClient } from './http.js';

/**
 * Hacker News, via the Algolia search API.
 *
 * Credential-free by design: Algolia's HN index is public and needs no key, so
 * this scout works on a fresh checkout with nothing configured. That is the
 * same property that makes `research/providers/seed.ts` the default provider.
 *
 * The `tags` parameter uses parentheses -- `(story,comment)` is OR, a bare
 * comma-separated list is AND. The reference carried that comment and it is
 * worth keeping: the AND form silently returns nothing, because no item is
 * both a story and a comment.
 */

export const HN_ALGOLIA_URL = 'https://hn.algolia.com/api/v1';
export const HN_TAGS = ['story', 'comment', 'ask_hn', 'show_hn'] as const;

interface AlgoliaHit {
  objectID?: unknown;
  url?: unknown;
  title?: unknown;
  story_text?: unknown;
  comment_text?: unknown;
  author?: unknown;
  points?: unknown;
  num_comments?: unknown;
  created_at_i?: unknown;
  parent_id?: unknown;
  story_id?: unknown;
  _tags?: unknown;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseHit(hit: AlgoliaHit): OutreachThread | null {
  const externalId = typeof hit.objectID === 'string' ? hit.objectID : null;
  if (!externalId) return null;

  const title = typeof hit.title === 'string' ? hit.title : '';
  const body = stripTags(String(hit.comment_text ?? hit.story_text ?? ''));
  const createdSeconds = numberOf(hit.created_at_i);

  return {
    platform: 'hackernews',
    externalId,
    url: typeof hit.url === 'string' && hit.url ? hit.url : `https://news.ycombinator.com/item?id=${externalId}`,
    title,
    content: cleanText(body || title),
    author: typeof hit.author === 'string' ? hit.author : null,
    // HN has no subreddit equivalent, so it is exempt from community-scoped
    // checks -- exactly as the reference's community_key() returned None.
    community: null,
    score: numberOf(hit.points),
    numComments: numberOf(hit.num_comments),
    createdAt: createdSeconds > 0 ? new Date(createdSeconds * 1000).toISOString() : null,
    metadata: {
      parentId: hit.parent_id ?? null,
      storyId: hit.story_id ?? null,
      tags: Array.isArray(hit._tags) ? hit._tags.map((tag) => String(tag)) : []
    }
  };
}

export const hackernewsScout: OutreachScout = {
  platform: 'hackernews',
  name: 'Hacker News',
  docsUrl: 'https://hn.algolia.com/api',
  credentialEnvVars: [],
  availability() {
    return { mode: 'ready', reason: 'The Algolia Hacker News index is public and needs no credential.', docsUrl: 'https://hn.algolia.com/api' };
  },
  async search(query, options) {
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];
    const batches: OutreachThread[][] = [];

    for (const term of query.queries) {
      const url = new URL(`${HN_ALGOLIA_URL}/search`);
      url.searchParams.set('query', term);
      url.searchParams.set('tags', `(${HN_TAGS.join(',')})`);
      url.searchParams.set('hitsPerPage', String(Math.min(query.limit, 50)));
      const body = await getJson<{ hits?: unknown }>(client, url.toString(), warnings);
      const hits = Array.isArray(body?.hits) ? (body.hits as AlgoliaHit[]) : [];
      batches.push(hits.map(parseHit).filter((thread): thread is OutreachThread => thread !== null));
    }

    const threads = dedupeById(batches, query.limit);
    return {
      platform: 'hackernews',
      threads,
      warnings,
      evidence: [
        {
          label: 'Hacker News search',
          detail: `${query.queries.length} quer${query.queries.length === 1 ? 'y' : 'ies'} against the Algolia HN index returned ${threads.length} distinct thread(s).`,
          sourceUrl: `${HN_ALGOLIA_URL}/search`
        }
      ]
    };
  }
};
