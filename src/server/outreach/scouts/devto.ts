import type { OutreachScout, OutreachThread } from '../types.js';
import { cleanText, dedupeById, getJson, matchesQuery, scoutClient } from './http.js';

/**
 * dev.to, via the public articles feed.
 *
 * `DEVTO_API_KEY` is optional and only raises the rate limit, so this reports
 * `ready` without one -- same reasoning as the GitHub scout. Matching is done
 * client-side over the relevant tag feeds because dev.to's own search endpoint
 * is undocumented and has changed shape without notice; a documented feed plus
 * local filtering is the stable choice.
 */

export const DEVTO_API_URL = 'https://dev.to/api';
export const DEVTO_CREDENTIAL = 'DEVTO_API_KEY';
export const DEVTO_TAGS = ['ai', 'llm', 'programming', 'productivity'] as const;

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface DevtoArticle {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  description?: unknown;
  user?: { username?: unknown };
  positive_reactions_count?: unknown;
  comments_count?: unknown;
  published_at?: unknown;
  tag_list?: unknown;
}

function parseArticle(article: DevtoArticle): OutreachThread | null {
  const externalId = typeof article.id === 'number' || typeof article.id === 'string' ? String(article.id) : null;
  const url = typeof article.url === 'string' ? article.url : null;
  if (!externalId || !url) return null;

  const title = typeof article.title === 'string' ? article.title : '';
  const tags = Array.isArray(article.tag_list) ? article.tag_list.map((tag) => String(tag)) : [];

  return {
    platform: 'devto',
    externalId,
    url,
    title,
    content: cleanText(typeof article.description === 'string' && article.description ? article.description : title),
    author: typeof article.user?.username === 'string' ? article.user.username : null,
    community: tags[0] ?? null,
    score: numberOf(article.positive_reactions_count),
    numComments: numberOf(article.comments_count),
    createdAt: typeof article.published_at === 'string' ? new Date(article.published_at).toISOString() : null,
    metadata: { tags }
  };
}

export const devtoScout: OutreachScout = {
  platform: 'devto',
  name: 'dev.to',
  docsUrl: 'https://developers.forem.com/api/v1#tag/articles',
  credentialEnvVars: [DEVTO_CREDENTIAL],
  availability(credentials) {
    if (!credentials.get(DEVTO_CREDENTIAL)) {
      return {
        mode: 'ready',
        reason: `Reading the public dev.to articles feed. Set ${DEVTO_CREDENTIAL} to raise the rate limit.`,
        docsUrl: 'https://developers.forem.com/api/v1#section/Authentication'
      };
    }
    return { mode: 'ready', reason: `${DEVTO_CREDENTIAL} is set.`, docsUrl: 'https://developers.forem.com/api/v1' };
  },
  async search(query, options) {
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];
    const key = options.credentials.get(DEVTO_CREDENTIAL);
    const headers: Record<string, string> = key ? { 'api-key': key } : {};

    const collected: OutreachThread[] = [];
    for (const tag of DEVTO_TAGS) {
      const url = new URL(`${DEVTO_API_URL}/articles`);
      url.searchParams.set('tag', tag);
      url.searchParams.set('per_page', String(Math.min(query.limit, 100)));
      const body = await getJson<unknown>(client, url.toString(), warnings, { headers });
      const articles = Array.isArray(body) ? (body as DevtoArticle[]) : [];
      collected.push(...articles.map(parseArticle).filter((thread): thread is OutreachThread => thread !== null));
    }

    const batches = query.queries.map((term) =>
      collected.filter((thread) => matchesQuery(`${thread.title} ${thread.content}`, term))
    );
    const threads = dedupeById(batches, query.limit);

    return {
      platform: 'devto',
      threads,
      warnings,
      evidence: [
        {
          label: 'dev.to tag feeds',
          detail: `Filtered ${collected.length} article(s) from tags ${DEVTO_TAGS.join(', ')} against ${query.queries.length} term(s); ${threads.length} matched.`,
          sourceUrl: `${DEVTO_API_URL}/articles`
        }
      ]
    };
  }
};
