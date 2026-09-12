import { describe, expect, it } from 'vitest';
import type { LinkedInLocator, LinkedInPage } from './driver.js';
import {
  POST_METRIC_SELECTORS,
  parseLinkedInMetricCount,
  readOwnPostMetrics
} from './driver-post-metrics.js';

function pageFor(values: Partial<Record<keyof typeof POST_METRIC_SELECTORS, string>> = {}) {
  let currentUrl = 'https://www.linkedin.com/feed/';
  const fetches: string[] = [];
  const locator = (text: string | undefined): LinkedInLocator => ({
    count: async () => (text === undefined ? 0 : 1),
    first: () => locator(text),
    click: async () => {},
    fill: async () => {},
    textContent: async () => text ?? null,
    innerText: async () => text ?? ''
  });
  const page: LinkedInPage = {
    goto: async (url) => {
      fetches.push(url);
      currentUrl = url;
    },
    url: () => currentUrl,
    locator: (selector) => {
      const key = (Object.entries(POST_METRIC_SELECTORS).find(
        ([, value]) => value === selector
      )?.[0] ?? '') as keyof typeof POST_METRIC_SELECTORS;
      return locator(key ? values[key] : undefined);
    },
    waitForTimeout: async () => {}
  };
  return { page, fetches };
}

describe('own LinkedIn post metrics', () => {
  it('parses only visible numeric counts and compact suffixes', () => {
    expect(parseLinkedInMetricCount('1,234 reactions')).toBe(1234);
    expect(parseLinkedInMetricCount('1.2K impressions')).toBe(1200);
    expect(parseLinkedInMetricCount('2M')).toBe(2_000_000);
    expect(parseLinkedInMetricCount('Comment')).toBeNull();
    expect(parseLinkedInMetricCount('')).toBeNull();
  });

  it('reads one owned post page and leaves unavailable metrics null instead of zero', async () => {
    const harness = pageFor({
      impressions: '1.2K impressions',
      reactions: '37 reactions',
      comments: 'Comment',
      reposts: '4 reposts'
    });
    const result = await readOwnPostMetrics(
      harness.page,
      'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/'
    );

    expect(harness.fetches).toHaveLength(1);
    expect(result).toMatchObject({
      ok: true,
      metrics: {
        impressions: 1200,
        reactions: 37,
        comments: null,
        reposts: 4,
        clicks: null,
        profileViews: null,
        follows: null
      }
    });
    expect(result.degraded.join(' ')).toContain('Comments was visible but no numeric count');
  });

  it('does not navigate to an unsupported URL and stops on a checkpoint', async () => {
    const invalid = pageFor();
    expect(await readOwnPostMetrics(invalid.page, 'https://example.com/post')).toMatchObject({
      ok: false,
      failureKind: 'not_found'
    });
    expect(invalid.fetches).toEqual([]);

    const challenged = pageFor({ challengeForm: 'checkpoint' });
    const result = await readOwnPostMetrics(
      challenged.page,
      'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/'
    );
    expect(result).toMatchObject({ ok: false, failureKind: 'challenge' });
  });
});
