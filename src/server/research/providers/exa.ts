import { createSsrfFetch } from '../../skills/guard.js';
import { normalizeDomain } from '../../skills/ladder.js';
import { TIMEOUT_MS, USER_AGENT } from '../../skills/probe.js';
import type { CandidateCompany, ResearchProvider, SourceQuery } from '../types.js';

/**
 * Exa neural web search, `category: 'company'`.
 *
 * VENDOR TERMS, and the reason this provider is shaped the way it is.
 *
 * Exa's ToS 4.2(a) (https://exa.ai/terms, observed 2026-07-27) prohibits,
 * absent written permission, that a customer "download, modify, copy,
 * distribute, transmit, display, perform, reproduce, duplicate, publish,
 * license, create derivative works from, or offer for sale any information
 * contained on, or obtained from or through, the Services, except for
 * temporary files that are automatically cached by your web browser for
 * display purposes". Read literally, writing search results into an operator's
 * Postgres is copying and reproducing Output.
 *
 * That reading is in real tension with 1.1, which grants use of the API per
 * their documentation -- an API whose results may never be written down is
 * close to unusable. So the honest status is UNRESOLVED, not "forbidden", and
 * it is not resolved in our favour by default: this provider declares
 * `retention: 'none'`, the runner drops the payload from the ledger, and
 * candidates exist only in the caller's memory for the length of the run.
 * Written permission from Exa is what would unblock persistence; nothing in
 * this file should be relaxed without it.
 *
 * API shape, current as of 2026-07-27 (https://docs.exa.ai/reference/search):
 * POST https://api.exa.ai/search, `x-api-key` header. Note that the historical
 * `type: 'neural'` is no longer a documented value -- the current set is
 * auto/instant/fast/deep-lite/deep/deep-reasoning -- so this sends `auto` and
 * lets Exa route. `excludeDomains` and the crawl/publish date filters are
 * rejected with a 400 when `category` is `company`, so they are never sent.
 */

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const EXA_CREDENTIAL = 'EXA_API_KEY';

interface ExaResult {
  url?: unknown;
  title?: unknown;
  summary?: unknown;
}

/** Deterministic ICP sentence: same query object in, same string out. */
export function buildExaQuery(query: SourceQuery): string {
  const parts: string[] = [];
  if (query.vertical) parts.push(query.vertical);
  parts.push(...query.keywords);
  const subject = parts.filter((part) => part.trim()).join(' ');
  const where = query.countries.length > 0 ? ` in ${query.countries.join(', ')}` : '';
  return `${subject ? `${subject} ` : ''}companies${where}`;
}

function domainOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return normalizeDomain(new URL(value).hostname) || null;
  } catch {
    return null;
  }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null;
}

export const exaProvider: ResearchProvider = {
  key: 'exa',
  name: 'Exa',
  docsUrl: 'https://docs.exa.ai/reference/search',
  credentialEnvVar: EXA_CREDENTIAL,
  retention: 'none',
  availability(credentials) {
    if (!credentials.get(EXA_CREDENTIAL)) {
      return {
        mode: 'needs-credential',
        reason: `Set ${EXA_CREDENTIAL} to enable Exa company search. Results are usable in memory only and are never persisted -- see Exa ToS 4.2(a).`,
        docsUrl: 'https://exa.ai/terms'
      };
    }
    return {
      mode: 'ready',
      reason: 'Exa company search is configured. Candidates are returned in memory and deliberately excluded from the run ledger under Exa ToS 4.2(a).',
      docsUrl: 'https://exa.ai/terms'
    };
  },
  async search(query, options) {
    const key = options.credentials.get(EXA_CREDENTIAL);
    if (!key) {
      return {
        providerKey: 'exa',
        candidates: [],
        warnings: [`${EXA_CREDENTIAL} is not set; Exa returned no candidates.`],
        evidence: []
      };
    }

    const resolve = options.fetchImpl === undefined;
    const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const warnings: string[] = [];
    const candidates: CandidateCompany[] = [];

    try {
      const response = await client(EXA_SEARCH_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'content-type': 'application/json',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify({
          query: buildExaQuery(query),
          type: 'auto',
          category: 'company',
          numResults: Math.min(Math.max(query.limit, 1), 100)
        }),
        signal: controller.signal
      });

      if (response.status !== 200) {
        // Degrade like a probe: a vendor outage or a rejected key yields a
        // partial-but-usable run, never a thrown skill.
        warnings.push(`Exa search returned HTTP ${response.status}; no candidates from this provider.`);
      } else {
        const body: unknown = await response.json();
        const results = body !== null && typeof body === 'object' ? (body as { results?: unknown }).results : undefined;
        if (!Array.isArray(results)) {
          warnings.push('Exa search responded without a results array; no candidates from this provider.');
        } else {
          const seen = new Set<string>();
          for (const entry of results as ExaResult[]) {
            const domain = domainOf(entry?.url);
            if (!domain || seen.has(domain)) continue;
            seen.add(domain);
            candidates.push({
              domain,
              name: textOf(entry?.title),
              description: textOf(entry?.summary),
              providerKey: 'exa',
              sourceUrl: typeof entry?.url === 'string' ? entry.url : null
            });
            if (candidates.length >= query.limit) break;
          }
        }
      }
    } catch (cause) {
      warnings.push(`Exa search failed: ${cause instanceof Error ? cause.message : String(cause)}.`);
    } finally {
      clearTimeout(timer);
    }

    return {
      providerKey: 'exa',
      candidates,
      warnings,
      // Deliberately empty. Evidence rows are persisted into `skill_runs`, and
      // nothing obtained from Exa may be written there.
      evidence: []
    };
  }
};
