import { createPublicWebCrawler } from '../../crawl/public-web.js';
import type { ExternalMeasurement, ObservationProvider } from '../types.js';
import { countPublicFeedPosts30d } from './public-feed.js';

const MAX_TARGETS = 2;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const NEWSLETTER_PAGE_SEGMENT_RE =
  /^(?:newsletter|newsletters|subscribe|email-updates?|mailing-list)$/i;

function canonicalHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function isNewsletterPage(url: URL): boolean {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .some((segment) => NEWSLETTER_PAGE_SEGMENT_RE.test(decodeURIComponent(segment)));
}

function targets(options: Parameters<ObservationProvider['observe']>[1]) {
  const found = new Map<string, { page: URL; feed: URL }>();
  for (const publication of options.context?.newsletterPublications ?? []) {
    if (publication.platform !== 'public-feed') continue;
    try {
      const page = new URL(publication.url);
      const feed = new URL(publication.feedUrl);
      if (page.protocol !== 'https:' || feed.protocol !== 'https:' || page.port || feed.port)
        continue;
      if (!isNewsletterPage(page)) continue;
      if (canonicalHost(page.hostname) !== canonicalHost(feed.hostname)) continue;
      feed.hash = '';
      found.set(feed.toString(), { page, feed });
      if (found.size >= MAX_TARGETS) break;
    } catch {
      // Invalid persisted/discovered targets never reach the network.
    }
  }
  return [...found.values()];
}

export function publicNewsletterFeedProvider(): ObservationProvider {
  return {
    key: 'public-newsletter-feed',
    name: 'First-party newsletter feed',
    docsUrl: null,
    credentialEnvVar: null,
    surfaces: ['newsletter'],
    availability: () => ({
      mode: 'ready',
      reason:
        'Explicit first-party RSS/Atom feeds published from newsletter pages need no credential.'
    }),
    async observe(_domain, options) {
      const measurements: ExternalMeasurement[] = [];
      const warnings: string[] = [];
      for (const target of targets(options)) {
        try {
          const crawler = await createPublicWebCrawler(target.feed.hostname, {
            fetchImpl: options.fetchImpl,
            maxRequests: 2,
            maxResponseBytes: MAX_FEED_BYTES,
            maxDurationMs: 10_000,
            minDelayMs: options.fetchImpl ? 0 : 250
          });
          const result = await crawler.get(target.feed.toString());
          if (result.skipped || result.error || !result.response) {
            warnings.push(
              `First-party newsletter feed ${target.feed.toString()} was not measurable: ${result.error ?? result.skipped ?? 'no response'}.`
            );
            continue;
          }
          if (result.response.status !== 200) {
            warnings.push(
              `First-party newsletter feed ${target.feed.toString()} returned HTTP ${result.response.status}.`
            );
            continue;
          }
          const count = countPublicFeedPosts30d(result.response.text, options.now);
          if (count.warning) {
            warnings.push(
              `First-party newsletter feed ${target.feed.toString()}: ${count.warning}.`
            );
            continue;
          }
          measurements.push({
            metric: 'newsletter.posts_30d',
            scope:
              `public-feed:${canonicalHost(target.feed.hostname)}${target.feed.pathname}`.slice(
                0,
                200
              ),
            value: count.count ?? 0,
            evidenceUrl: target.feed.toString(),
            observedAt: options.now.toISOString()
          });
        } catch (cause) {
          warnings.push(
            `First-party newsletter feed measurement failed for ${target.feed.toString()}: ${cause instanceof Error ? cause.message : String(cause)}.`
          );
        }
      }
      return {
        providerKey: 'public-newsletter-feed',
        observations: [],
        measurements,
        warnings
      };
    }
  };
}

export function configuredPublicNewsletterFeedProviders(): ObservationProvider[] {
  return [publicNewsletterFeedProvider()];
}
