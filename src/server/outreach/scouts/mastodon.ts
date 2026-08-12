import { stripTags } from '../../skills/html.js';
import type { OutreachScout, OutreachThread } from '../types.js';
import { cleanText, dedupeById, getJson, scoutClient } from './http.js';

/**
 * Mastodon, via `/api/v2/search` on the account's own instance.
 *
 * Genuinely credential-gated, unlike the GitHub and dev.to scouts: v2 search
 * rejects unauthenticated requests on virtually every instance, so without a
 * token this returns nothing at all rather than a degraded result. That is why
 * it reports `needs-credential` and they do not.
 */

export const MASTODON_TOKEN = 'MASTODON_ACCESS_TOKEN';
export const MASTODON_INSTANCE = 'MASTODON_INSTANCE_URL';
export const DEFAULT_MASTODON_INSTANCE = 'https://mastodon.social';

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface MastodonStatus {
  id?: unknown;
  url?: unknown;
  uri?: unknown;
  content?: unknown;
  account?: { acct?: unknown };
  favourites_count?: unknown;
  reblogs_count?: unknown;
  replies_count?: unknown;
  created_at?: unknown;
}

function instanceOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parseStatus(status: MastodonStatus, fallbackInstance: string): OutreachThread | null {
  const externalId = typeof status.id === 'string' || typeof status.id === 'number' ? String(status.id) : null;
  if (!externalId) return null;

  const url = (typeof status.url === 'string' && status.url) || (typeof status.uri === 'string' && status.uri) || '';
  if (!url) return null;

  // A toot has no title; the first line of the body stands in so the scorer
  // and the reply drafter have something to name.
  const body = cleanText(stripTags(String(status.content ?? '')));
  const title = body.split('\n')[0]?.slice(0, 200) ?? '';

  return {
    platform: 'mastodon',
    externalId,
    url,
    title,
    content: body,
    author: typeof status.account?.acct === 'string' ? status.account.acct : null,
    community: instanceOf(url) ?? instanceOf(fallbackInstance),
    score: numberOf(status.favourites_count) + numberOf(status.reblogs_count),
    numComments: numberOf(status.replies_count),
    createdAt: typeof status.created_at === 'string' ? new Date(status.created_at).toISOString() : null,
    metadata: { instance: instanceOf(url) }
  };
}

export const mastodonScout: OutreachScout = {
  platform: 'mastodon',
  name: 'Mastodon',
  docsUrl: 'https://docs.joinmastodon.org/methods/search/',
  credentialEnvVars: [MASTODON_TOKEN, MASTODON_INSTANCE],
  availability(credentials) {
    if (!credentials.get(MASTODON_TOKEN)) {
      return {
        mode: 'needs-credential',
        reason: `Set ${MASTODON_TOKEN} to search Mastodon. The v2 search endpoint rejects unauthenticated requests on virtually every instance. ${MASTODON_INSTANCE} is optional and defaults to ${DEFAULT_MASTODON_INSTANCE}.`,
        docsUrl: 'https://docs.joinmastodon.org/methods/search/'
      };
    }
    return { mode: 'ready', reason: `${MASTODON_TOKEN} is set.`, docsUrl: 'https://docs.joinmastodon.org/methods/search/' };
  },
  async search(query, options) {
    const token = options.credentials.get(MASTODON_TOKEN);
    if (!token) {
      return { platform: 'mastodon', threads: [], warnings: [`Mastodon search skipped: ${MASTODON_TOKEN} not set.`], evidence: [] };
    }

    const instance = (options.credentials.get(MASTODON_INSTANCE) ?? DEFAULT_MASTODON_INSTANCE).replace(/\/+$/, '');
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];
    const batches: OutreachThread[][] = [];

    for (const term of query.queries) {
      const url = new URL(`${instance}/api/v2/search`);
      url.searchParams.set('q', term);
      url.searchParams.set('type', 'statuses');
      url.searchParams.set('limit', String(Math.min(query.limit, 40)));
      const body = await getJson<{ statuses?: unknown }>(client, url.toString(), warnings, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const statuses = Array.isArray(body?.statuses) ? (body.statuses as MastodonStatus[]) : [];
      batches.push(statuses.map((status) => parseStatus(status, instance)).filter((thread): thread is OutreachThread => thread !== null));
    }

    const threads = dedupeById(batches, query.limit);
    return {
      platform: 'mastodon',
      threads,
      warnings,
      evidence: [
        {
          label: 'Mastodon search',
          detail: `Searched ${instance} for ${query.queries.length} term(s); ${threads.length} distinct status(es).`,
          sourceUrl: `${instance}/api/v2/search`
        }
      ]
    };
  }
};
