import type { OutreachScout, OutreachThread } from '../types.js';
import { REDDIT_TARGET_SUBREDDITS } from '../config.js';
import { cleanText, dedupeById, getJson, scoutClient } from './http.js';

/**
 * Reddit, via the OAuth search API.
 *
 * Needs all four credentials: Reddit's script-app flow is a password grant, so
 * a client id and secret alone cannot mint a token. The scout reports
 * `needs-credential` naming the missing variables rather than returning an
 * empty list that reads as "nobody on Reddit is discussing cost".
 */

export const REDDIT_AUTH_URL = 'https://www.reddit.com/api/v1/access_token';
export const REDDIT_API_URL = 'https://oauth.reddit.com';
export const REDDIT_CREDENTIALS = [
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USERNAME',
  'REDDIT_PASSWORD'
] as const;

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface RedditChild {
  data?: {
    id?: unknown;
    permalink?: unknown;
    title?: unknown;
    selftext?: unknown;
    author?: unknown;
    subreddit?: unknown;
    score?: unknown;
    num_comments?: unknown;
    created_utc?: unknown;
    over_18?: unknown;
    upvote_ratio?: unknown;
  };
}

function parseChild(child: RedditChild): OutreachThread | null {
  const data = child.data;
  const externalId = typeof data?.id === 'string' ? data.id : null;
  if (!data || !externalId) return null;

  const title = typeof data.title === 'string' ? data.title : '';
  const created = numberOf(data.created_utc);

  return {
    platform: 'reddit',
    externalId,
    url: `https://www.reddit.com${typeof data.permalink === 'string' ? data.permalink : `/comments/${externalId}`}`,
    title,
    content: cleanText(typeof data.selftext === 'string' && data.selftext ? data.selftext : title),
    author: typeof data.author === 'string' ? data.author : null,
    community: typeof data.subreddit === 'string' ? data.subreddit : null,
    score: numberOf(data.score),
    numComments: numberOf(data.num_comments),
    createdAt: created > 0 ? new Date(created * 1000).toISOString() : null,
    metadata: {
      over18: data.over_18 === true,
      // Read by the scorer's reddit branch.
      upvoteRatio: typeof data.upvote_ratio === 'number' ? data.upvote_ratio : 0.5
    }
  };
}

export const redditScout: OutreachScout = {
  platform: 'reddit',
  name: 'Reddit',
  docsUrl: 'https://www.reddit.com/dev/api/#GET_search',
  credentialEnvVars: REDDIT_CREDENTIALS,
  availability(credentials) {
    const missing = REDDIT_CREDENTIALS.filter((name) => !credentials.get(name));
    if (missing.length > 0) {
      return {
        mode: 'needs-credential',
        reason: `Set ${missing.join(', ')} to search Reddit. The script-app flow is a password grant, so all four are required.`,
        docsUrl: 'https://github.com/reddit-archive/reddit/wiki/OAuth2'
      };
    }
    return { mode: 'ready', reason: 'Reddit OAuth credentials are configured.', docsUrl: 'https://www.reddit.com/dev/api/' };
  },
  async search(query, options) {
    const warnings: string[] = [];
    const missing = REDDIT_CREDENTIALS.filter((name) => !options.credentials.get(name));
    if (missing.length > 0) {
      return { platform: 'reddit', threads: [], warnings: [`Reddit search skipped: ${missing.join(', ')} not set.`], evidence: [] };
    }

    const client = scoutClient(options.fetchImpl);
    const clientId = options.credentials.get('REDDIT_CLIENT_ID') ?? '';
    const clientSecret = options.credentials.get('REDDIT_CLIENT_SECRET') ?? '';
    const username = options.credentials.get('REDDIT_USERNAME') ?? '';
    const password = options.credentials.get('REDDIT_PASSWORD') ?? '';
    const userAgent = `TrevraGrowthBot/0.1 (by /u/${username})`;

    const token = await getJson<{ access_token?: unknown }>(client, REDDIT_AUTH_URL, warnings, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent
      },
      body: new URLSearchParams({ grant_type: 'password', username, password }).toString()
    });

    const accessToken = typeof token?.access_token === 'string' ? token.access_token : null;
    if (!accessToken) {
      warnings.push('Reddit did not return an access token; no threads from this platform.');
      return { platform: 'reddit', threads: [], warnings, evidence: [] };
    }

    // Reddit caps a multi-subreddit path; the reference took the first five.
    const subreddits = REDDIT_TARGET_SUBREDDITS.slice(0, 5).join('+');
    const batches: OutreachThread[][] = [];

    for (const term of query.queries) {
      const url = new URL(`${REDDIT_API_URL}/r/${subreddits}/search.json`);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', String(Math.min(query.limit, 100)));
      url.searchParams.set('sort', 'relevance');
      url.searchParams.set('t', 'week');
      const body = await getJson<{ data?: { children?: unknown } }>(client, url.toString(), warnings, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent }
      });
      const children = Array.isArray(body?.data?.children) ? (body.data.children as RedditChild[]) : [];
      batches.push(children.map(parseChild).filter((thread): thread is OutreachThread => thread !== null));
    }

    const threads = dedupeById(batches, query.limit);
    return {
      platform: 'reddit',
      threads,
      warnings,
      evidence: [
        {
          label: 'Reddit search',
          detail: `Searched r/${subreddits.replaceAll('+', ', r/')} for ${query.queries.length} term(s); ${threads.length} distinct thread(s).`,
          sourceUrl: 'https://www.reddit.com/dev/api/#GET_search'
        }
      ]
    };
  }
};
