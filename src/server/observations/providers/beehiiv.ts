import { createPublicWebCrawler } from '../../crawl/public-web.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';
import { countPublicFeedPosts30d } from './public-feed.js';

const MAX_TARGETS = 2;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const DOCS_URL = 'https://www.beehiiv.com/support/article/9363537272215';
const BEEHIIV_FEED_HOST = 'rss.beehiiv.com';
const BEEHIIV_NEWSLETTER_FEED_RE = /^\/feeds\/[^/]+\.xml$/i;

function targets(options: Parameters<ObservationProvider['observe']>[1]) {
  const found = new Map<string, URL>();
  for (const publication of options.context?.newsletterPublications ?? []) {
    if (publication.platform !== 'beehiiv') continue;
    try {
      const feed = new URL(publication.feedUrl);
      if (
        feed.protocol !== 'https:' ||
        feed.hostname.toLowerCase() !== BEEHIIV_FEED_HOST ||
        !BEEHIIV_NEWSLETTER_FEED_RE.test(feed.pathname)
      )
        continue;
      feed.hash = '';
      found.set(feed.toString(), feed);
      if (found.size >= MAX_TARGETS) break;
    } catch {
      // Invalid targets are never fetched or converted into measurements.
    }
  }
  return [...found.values()];
}

export function beehiivPublicFeedProvider(): ObservationProvider {
  return {
    key: 'beehiiv-public-feed',
    name: 'beehiiv public feed',
    docsUrl: DOCS_URL,
    credentialEnvVar: null,
    surfaces: ['newsletter'],
    availability: () => ({
      mode: 'ready',
      reason: 'beehiiv publications may expose an explicit public RSS feed.',
      docsUrl: DOCS_URL
    }),
    async observe(_domain, options) {
      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const feed of targets(options)) {
        try {
          const crawler = await createPublicWebCrawler(feed.hostname, {
            fetchImpl: options.fetchImpl,
            maxRequests: 2,
            maxResponseBytes: MAX_FEED_BYTES,
            maxDurationMs: 10_000,
            minDelayMs: options.fetchImpl ? 0 : 250
          });
          const result = await crawler.get(feed.toString());
          if (result.skipped || result.error || !result.response) {
            warnings.push(
              `beehiiv feed ${feed.toString()} was not measurable: ${result.error ?? result.skipped ?? 'no response'}.`
            );
            continue;
          }
          if (result.response.status !== 200) {
            warnings.push(
              `beehiiv feed ${feed.toString()} returned HTTP ${result.response.status}.`
            );
            continue;
          }
          const count = countPublicFeedPosts30d(result.response.text, options.now);
          if (count.warning) {
            warnings.push(`beehiiv feed ${feed.toString()}: ${count.warning}.`);
            continue;
          }
          measurements.push({
            metric: 'newsletter.posts_30d',
            scope: `beehiiv:${feed.pathname.toLowerCase()}`,
            value: count.count ?? 0,
            evidenceUrl: feed.toString(),
            observedAt: options.now.toISOString()
          });
        } catch (cause) {
          warnings.push(
            `beehiiv feed measurement failed for ${feed.toString()}: ${cause instanceof Error ? cause.message : String(cause)}.`
          );
        }
      }
      return {
        providerKey: 'beehiiv-public-feed',
        observations: [],
        measurements,
        warnings
      };
    }
  };
}

export function configuredBeehiivPublicFeedProviders(): ObservationProvider[] {
  return [beehiivPublicFeedProvider()];
}
