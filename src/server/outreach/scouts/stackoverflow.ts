import { stripTags } from '../../skills/html.js';
import type { OutreachScout, OutreachThread } from '../types.js';
import { cleanText, dedupeById, getJson, scoutClient } from './http.js';

/**
 * Stack Overflow, via the Stack Exchange API.
 *
 * Keyless requests work and are metered at 300/day per IP; `STACKEXCHANGE_KEY`
 * raises that to 10,000. Optional, therefore `ready` either way.
 *
 * Note `filter=withbody`: without it the API returns questions with no body at
 * all, and the scorer would be reading titles only.
 */

export const STACKEXCHANGE_API_URL = 'https://api.stackexchange.com/2.3';
export const STACKEXCHANGE_CREDENTIAL = 'STACKEXCHANGE_KEY';

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface StackQuestion {
  question_id?: unknown;
  link?: unknown;
  title?: unknown;
  body?: unknown;
  owner?: { display_name?: unknown };
  score?: unknown;
  answer_count?: unknown;
  creation_date?: unknown;
  tags?: unknown;
  is_answered?: unknown;
}

function parseQuestion(question: StackQuestion): OutreachThread | null {
  const externalId = typeof question.question_id === 'number' || typeof question.question_id === 'string' ? String(question.question_id) : null;
  if (!externalId) return null;

  const title = typeof question.title === 'string' ? stripTags(question.title) : '';
  const created = numberOf(question.creation_date);
  const tags = Array.isArray(question.tags) ? question.tags.map((tag) => String(tag)) : [];

  return {
    platform: 'stackoverflow',
    externalId,
    url: typeof question.link === 'string' ? question.link : `https://stackoverflow.com/q/${externalId}`,
    title,
    content: cleanText(stripTags(String(question.body ?? '')) || title),
    author: typeof question.owner?.display_name === 'string' ? question.owner.display_name : null,
    // Stack Overflow moderates sitewide, not per tag, so there is no community
    // to cool down against -- the same call the reference made for HN.
    community: null,
    score: numberOf(question.score),
    numComments: numberOf(question.answer_count),
    createdAt: created > 0 ? new Date(created * 1000).toISOString() : null,
    metadata: { tags, isAnswered: question.is_answered === true }
  };
}

export const stackoverflowScout: OutreachScout = {
  platform: 'stackoverflow',
  name: 'Stack Overflow',
  docsUrl: 'https://api.stackexchange.com/docs/advanced-search',
  credentialEnvVars: [STACKEXCHANGE_CREDENTIAL],
  availability(credentials) {
    if (!credentials.get(STACKEXCHANGE_CREDENTIAL)) {
      return {
        mode: 'ready',
        reason: `Querying Stack Exchange keyless at 300 requests/day per IP. Set ${STACKEXCHANGE_CREDENTIAL} to raise the quota to 10,000.`,
        docsUrl: 'https://api.stackexchange.com/docs/throttle'
      };
    }
    return { mode: 'ready', reason: `${STACKEXCHANGE_CREDENTIAL} is set; quota raised to 10,000 requests/day.`, docsUrl: 'https://api.stackexchange.com/docs' };
  },
  async search(query, options) {
    const client = scoutClient(options.fetchImpl);
    const warnings: string[] = [];
    const key = options.credentials.get(STACKEXCHANGE_CREDENTIAL);
    const batches: OutreachThread[][] = [];

    for (const term of query.queries) {
      const url = new URL(`${STACKEXCHANGE_API_URL}/search/advanced`);
      url.searchParams.set('q', term);
      url.searchParams.set('site', 'stackoverflow');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('sort', 'creation');
      // Without this the API omits question bodies entirely.
      url.searchParams.set('filter', 'withbody');
      url.searchParams.set('pagesize', String(Math.min(query.limit, 100)));
      if (key) url.searchParams.set('key', key);
      const body = await getJson<{ items?: unknown }>(client, url.toString(), warnings);
      const items = Array.isArray(body?.items) ? (body.items as StackQuestion[]) : [];
      batches.push(items.map(parseQuestion).filter((thread): thread is OutreachThread => thread !== null));
    }

    const threads = dedupeById(batches, query.limit);
    return {
      platform: 'stackoverflow',
      threads,
      warnings,
      evidence: [
        {
          label: 'Stack Overflow search',
          detail: `Searched Stack Overflow for ${query.queries.length} term(s); ${threads.length} distinct question(s).`,
          sourceUrl: 'https://api.stackexchange.com/docs/advanced-search'
        }
      ]
    };
  }
};
