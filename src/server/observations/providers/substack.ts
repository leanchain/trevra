import { createPublicWebCrawler } from '../../crawl/public-web.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';
import { countPublicFeedPosts30d } from './public-feed.js';

export { countPublicFeedPosts30d } from './public-feed.js';

const MAX_TARGETS = 2;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const DOCS_URL =
  'https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication';

function targets(options: Parameters<ObservationProvider['observe']>[1]) {
  const found = new Map<string, { url: string; feedUrl: string }>();
  for (const publication of options.context?.newsletterPublications ?? []) {
    if (publication.platform !== 'substack') continue;
    try {
      const page = new URL(publication.url);
      const feed = new URL(publication.feedUrl);
      if (
        page.protocol !== 'https:' ||
        feed.protocol !== 'https:' ||
        page.origin !== feed.origin ||
        !page.hostname.toLowerCase().endsWith('.substack.com')
      )
        continue;
      found.set(page.origin, { url: page.origin, feedUrl: feed.toString() });
      if (found.size >= MAX_TARGETS) break;
    } catch {
      // Invalid targets are not fetched and do not become measurements.
    }
  }
  return [...found.values()];
}

export function substackPublicFeedProvider(): ObservationProvider {
  return {
    key: 'substack-public-feed',
    name: 'Substack public feed',
    docsUrl: DOCS_URL,
    credentialEnvVar: null,
    surfaces: ['newsletter'],
    availability: () => ({
      mode: 'ready',
      reason: 'Substack exposes a public RSS feed for publications.',
      docsUrl: DOCS_URL
    }),
    async observe(_domain, options) {
      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const target of targets(options)) {
        try {
          const publication = new URL(target.url);
          const crawler = await createPublicWebCrawler(publication.hostname, {
            fetchImpl: options.fetchImpl,
            maxRequests: 2,
            maxResponseBytes: MAX_FEED_BYTES,
            maxDurationMs: 10_000,
            minDelayMs: options.fetchImpl ? 0 : 250
          });
          const result = await crawler.get(target.feedUrl);
          if (result.skipped || result.error || !result.response) {
            warnings.push(
              `Substack feed ${target.feedUrl} was not measurable: ${result.error ?? result.skipped ?? 'no response'}.`
            );
            continue;
          }
          if (result.response.status !== 200) {
            warnings.push(
              `Substack feed ${target.feedUrl} returned HTTP ${result.response.status}.`
            );
            continue;
          }
          const count = countPublicFeedPosts30d(result.response.text, options.now);
          if (count.warning) {
            warnings.push(`Substack feed ${target.feedUrl}: ${count.warning}.`);
            continue;
          }
          measurements.push({
            metric: 'newsletter.posts_30d',
            scope: `substack:${publication.hostname.toLowerCase()}`,
            value: count.count ?? 0,
            evidenceUrl: target.feedUrl,
            observedAt: options.now.toISOString()
          });
        } catch (cause) {
          warnings.push(
            `Substack feed measurement failed for ${target.url}: ${cause instanceof Error ? cause.message : String(cause)}.`
          );
        }
      }
      return {
        providerKey: 'substack-public-feed',
        observations: [],
        measurements,
        warnings
      };
    }
  };
}

export function configuredSubstackPublicFeedProviders(): ObservationProvider[] {
  return [substackPublicFeedProvider()];
}
