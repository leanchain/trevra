import type { OutreachScout, OutreachThread } from '../types.js';
import { cleanText, dedupeById, getJson, matchesQuery, scoutClient } from './http.js';

/**
 * Lobsters, via the public `newest.json` feed.
 *
 * Filtered client-side rather than searched server-side, which is what the
 * reference did too. Lobsters is a small, low-volume site: the recent feed
 * genuinely contains everything worth matching, and it is one request instead
 * of one per query term against a site that asks bots to be gentle.
 */

export const LOBSTERS_URL = 'https://lobste.rs';

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface LobstersStory {
  short_id?: unknown;
  short_id_url?: unknown;
  comments_url?: unknown;
  url?: unknown;
  title?: unknown;
  description_plain?: unknown;
  description?: unknown;
  submitter_user?: unknown;
  score?: unknown;
  comment_count?: unknown;
  created_at?: unknown;
  tags?: unknown;
}

function submitterOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const username = (value as { username?: unknown }).username;
    if (typeof username === 'string') return username;
  }
  return null;
}

function parseStory(story: LobstersStory): OutreachThread | null {
  const externalId = typeof story.short_id === 'string' ? story.short_id : null;
  if (!externalId) return null;

  const title = typeof story.title === 'string' ? story.title : '';
  const tags = Array.isArray(story.tags) ? story.tags.map((tag) => String(tag)) : [];
  const url =
    (typeof story.comments_url === 'string' && story.comments_url) ||
    (typeof story.short_id_url === 'string' && story.short_id_url) ||
    `${LOBSTERS_URL}/s/${externalId}`;

  return {
    platform: 'lobsters',
    externalId,
    url,
    title,
    content: cleanText(String(story.description_plain ?? story.description ?? title)),
    author: submitterOf(story.submitter_user),
    // Lobsters rate-limits attention by tag, so the first tag is the community.
    community: tags[0] ?? null,
    score: numberOf(story.score),
    numComments: numberOf(story.comment_count),
    createdAt: typeof story.created_at === 'string' ? new Date(story.created_at).toISOString() : null,
    metadata: { tags }
  };
}

export const lobstersScout: OutreachScout = {
  platform: 'lobsters',
  name: 'Lobsters',
  docsUrl: 'https://lobste.rs/about',
  credentialEnvVars: [],
  availability() {
    return { mode: 'ready', reason: 'The Lobsters newest.json feed is public and needs no credential.', docsUrl: 'https://lobste.rs/about' };
  },
  async search(query, options) {
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];

    const body = await getJson<unknown>(client, `${LOBSTERS_URL}/newest.json`, warnings);
    const stories = Array.isArray(body) ? (body as LobstersStory[]) : [];
    const parsed = stories.map(parseStory).filter((thread): thread is OutreachThread => thread !== null);

    const batches = query.queries.map((term) =>
      parsed.filter((thread) => matchesQuery(`${thread.title} ${thread.content}`, term))
    );
    const threads = dedupeById(batches, query.limit);

    return {
      platform: 'lobsters',
      threads,
      warnings,
      evidence: [
        {
          label: 'Lobsters recent feed',
          detail: `Filtered ${parsed.length} recent stor(y|ies) against ${query.queries.length} term(s); ${threads.length} matched.`,
          sourceUrl: `${LOBSTERS_URL}/newest.json`
        }
      ]
    };
  }
};
