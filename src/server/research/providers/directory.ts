import { createSsrfFetch, validatePublicHost } from '../../skills/guard.js';
import type { CandidateCompany, ResearchProvider } from '../types.js';

const MAX_DIRECTORY_URLS = 10;
const MAX_LINKS_PER_DIRECTORY = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const JUNK_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'pinterest.com',
  'google.com',
  'apple.com',
  'shopify.com',
  'wikipedia.org',
  'wordpress.com',
  'vimeo.com',
  'reddit.com',
  'snapchat.com',
  'whatsapp.com',
  't.me',
  'medium.com'
]);

function isJunk(domain: string): boolean {
  if (domain.endsWith('.gov') || domain.endsWith('.edu') || domain.endsWith('.mil')) return true;
  for (const junk of JUNK_DOMAINS) {
    if (domain === junk || domain.endsWith(`.${junk}`)) return true;
  }
  return false;
}

function hostnameOf(raw: string, base?: string): string | null {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.+$/, '');
  } catch {
    return null;
  }
}

async function extractCandidates(
  html: string,
  directoryUrl: string,
  providerKey: string
): Promise<CandidateCompany[]> {
  const directoryDomain = hostnameOf(directoryUrl);
  if (!directoryDomain) return [];
  const seen = new Set<string>();
  const candidates: CandidateCompany[] = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const domain = hostnameOf(match[1], directoryUrl);
    if (!domain || seen.has(domain)) continue;
    if (domain === directoryDomain || domain.endsWith(`.${directoryDomain}`) || isJunk(domain))
      continue;
    try {
      await validatePublicHost(domain, { resolve: false });
    } catch {
      continue;
    }
    seen.add(domain);
    candidates.push({
      domain,
      name: null,
      description: null,
      providerKey,
      sourceUrl: directoryUrl
    });
    if (candidates.length >= MAX_LINKS_PER_DIRECTORY) break;
  }
  return candidates;
}

/**
 * Crawl operator-supplied public directory/listicle pages for external company domains.
 * The provider is deliberately generic: it knows about HTML links, not shops, stores,
 * marketplaces, or any Trevra customer vertical.
 */
export const directoryProvider: ResearchProvider = {
  key: 'directory',
  name: 'Directory crawl',
  docsUrl: 'https://github.com/trevra/trevra#directory-provider',
  credentialEnvVar: null,
  retention: 'default',
  availability() {
    return {
      mode: 'ready',
      reason:
        'Crawls public directory URLs supplied in the request. Every request and redirect is SSRF-validated.'
    };
  },
  async search(query, options) {
    const urls = query.urls
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_DIRECTORY_URLS);
    if (urls.length === 0) {
      return {
        providerKey: 'directory',
        candidates: [],
        warnings: ['No directory URLs supplied.'],
        evidence: []
      };
    }

    const client = createSsrfFetch({
      resolve: options.fetchImpl === undefined,
      fetchImpl: options.fetchImpl
    });
    const warnings: string[] = [];
    const candidates: CandidateCompany[] = [];
    const seen = new Set<string>();

    for (const url of urls) {
      try {
        const response = await client(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'TrevraResearchBot/1.0',
            Accept: 'text/html,application/xhtml+xml'
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          warnings.push(`${url} returned HTTP ${response.status}; skipped.`);
          continue;
        }
        const html = await response.text();
        for (const candidate of await extractCandidates(html, url, 'directory')) {
          if (seen.has(candidate.domain)) continue;
          seen.add(candidate.domain);
          candidates.push(candidate);
          if (candidates.length >= query.limit) break;
        }
      } catch (cause) {
        warnings.push(
          `${url} could not be crawled: ${cause instanceof Error ? cause.message : String(cause)}.`
        );
      }
      if (candidates.length >= query.limit) break;
    }

    return {
      providerKey: 'directory',
      candidates,
      warnings,
      evidence: urls.map((url) => ({
        label: 'Directory source',
        detail: `Public directory page supplied by the operator for candidate discovery.`,
        sourceUrl: url
      }))
    };
  }
};
