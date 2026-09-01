import type { OutreachScout, OutreachThread } from '../types.js';
import { GITHUB_TARGET_REPOS } from '../config.js';
import { cleanText, dedupeById, getJson, scoutClient } from './http.js';

/**
 * GitHub issues and discussions, via the issue search API.
 *
 * `GITHUB_TOKEN` is optional but strongly advised: unauthenticated search is
 * capped at roughly 10 requests per minute and will start returning 403 part
 * way through a multi-query run. So this reports `ready` without one and warns
 * -- a credential that only buys headroom should not block a run that would
 * otherwise work.
 */

export const GITHUB_API_URL = 'https://api.github.com';
export const GITHUB_CREDENTIAL = 'GITHUB_TOKEN';

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface GithubIssue {
  id?: unknown;
  number?: unknown;
  html_url?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  comments?: unknown;
  reactions?: { total_count?: unknown };
  created_at?: unknown;
  author_association?: unknown;
  labels?: unknown;
  repository_url?: unknown;
}

/** `https://api.github.com/repos/owner/name` -> `owner/name`. */
function repoOf(issue: GithubIssue): string | null {
  if (typeof issue.html_url === 'string') {
    const match = /github\.com\/([^/]+\/[^/]+)\//.exec(issue.html_url);
    if (match) return match[1];
  }
  if (typeof issue.repository_url === 'string') {
    const match = /\/repos\/(.+)$/.exec(issue.repository_url);
    if (match) return match[1];
  }
  return null;
}

function parseIssue(issue: GithubIssue): OutreachThread | null {
  const externalId =
    typeof issue.id === 'number' || typeof issue.id === 'string' ? String(issue.id) : null;
  const url = typeof issue.html_url === 'string' ? issue.html_url : null;
  if (!externalId || !url) return null;

  const title = typeof issue.title === 'string' ? issue.title : '';
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) =>
        typeof label === 'object' && label !== null
          ? String((label as { name?: unknown }).name ?? '')
          : String(label)
      )
    : [];

  return {
    platform: 'github',
    externalId,
    url,
    title,
    content: cleanText(typeof issue.body === 'string' && issue.body ? issue.body : title),
    author: typeof issue.user?.login === 'string' ? issue.user.login : null,
    community: repoOf(issue),
    score: numberOf(issue.reactions?.total_count),
    numComments: numberOf(issue.comments),
    createdAt:
      typeof issue.created_at === 'string' ? new Date(issue.created_at).toISOString() : null,
    metadata: {
      issueNumber: numberOf(issue.number),
      repo: repoOf(issue),
      // Both read by the scorer's github branch.
      authorAssociation:
        typeof issue.author_association === 'string' ? issue.author_association : '',
      labels: labels.filter((label) => label.length > 0)
    }
  };
}

export const githubScout: OutreachScout = {
  platform: 'github',
  name: 'GitHub',
  docsUrl: 'https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests',
  credentialEnvVars: [GITHUB_CREDENTIAL],
  availability(credentials) {
    if (!credentials.get(GITHUB_CREDENTIAL)) {
      return {
        mode: 'ready',
        reason: `Searching GitHub unauthenticated at roughly 10 requests/minute. Set ${GITHUB_CREDENTIAL} to raise the limit to 30.`,
        docsUrl: 'https://docs.github.com/en/rest/search/search#rate-limit'
      };
    }
    return {
      mode: 'ready',
      reason: `${GITHUB_CREDENTIAL} is set; searching at the authenticated rate limit.`,
      docsUrl: 'https://docs.github.com/en/rest/search'
    };
  },
  async search(query, options) {
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];
    const token = options.credentials.get(GITHUB_CREDENTIAL);
    if (!token)
      warnings.push(
        `${GITHUB_CREDENTIAL} is not set; GitHub search is rate-limited to roughly 10 requests per minute.`
      );

    const repos = query.communities ?? GITHUB_TARGET_REPOS;
    const repoFilter = repos.map((repo) => `repo:${repo}`).join(' ');
    const batches: OutreachThread[][] = [];

    for (const term of query.queries) {
      const url = new URL(`${GITHUB_API_URL}/search/issues`);
      url.searchParams.set('q', [term, repoFilter, 'is:issue'].filter(Boolean).join(' '));
      url.searchParams.set('sort', 'updated');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', String(Math.min(query.limit, 100)));
      const body = await getJson<{ items?: unknown }>(client, url.toString(), warnings, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
      const items = Array.isArray(body?.items) ? (body.items as GithubIssue[]) : [];
      batches.push(
        items.map(parseIssue).filter((thread): thread is OutreachThread => thread !== null)
      );
    }

    const threads = dedupeById(batches, query.limit);
    return {
      platform: 'github',
      threads,
      warnings,
      evidence: [
        {
          label: 'GitHub issue search',
          detail: `Searched ${repos.length === 0 ? 'all of GitHub' : `${repos.length} target repo(s)`} for ${query.queries.length} term(s); ${threads.length} distinct issue(s).`,
          sourceUrl: 'https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests'
        }
      ]
    };
  }
};
