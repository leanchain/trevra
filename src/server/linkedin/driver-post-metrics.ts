import type { LinkedInFailureKind, LinkedInPage } from './driver.js';
import { postUrlFor } from './driver-scrape.js';
import { settle } from './human.js';

const NAV_TIMEOUT_MS = 30_000;

/**
 * Own-post analytics only.
 *
 * These selectors deliberately target count/analytics affordances, never a
 * reactor/commenter profile list. If LinkedIn changes a label, that metric
 * becomes null and a degraded sentence is returned; zero is never inferred
 * from a missing control.
 *
 * Like driver-post.ts, these selectors need live-DOM verification during
 * rollout. The parsing contract is conservative enough that a false selector
 * match without a numeric count becomes null rather than fabricated data.
 */
export const POST_METRIC_SELECTORS = {
  impressions:
    'a[href*="/analytics/post-summary/"], a[href*="/analytics/creator/content/"], ' +
    'span.update-components-analytics__text, span.update-components-analytics__description',
  reactions:
    'button.social-details-social-counts__count-value, button[aria-label*="reaction" i], ' +
    'span.social-details-social-counts__reactions-count',
  comments:
    'button[aria-label*="comment" i], span.social-details-social-counts__comments, ' +
    'li.social-details-social-counts__comments button',
  reposts:
    'button[aria-label*="repost" i], button[aria-label*="share" i], ' +
    'span.social-details-social-counts__reposts',
  challengeForm:
    'form.challenge, input[name="pin"], #captcha-internal, iframe[title*="challenge" i]',
  restrictionNotice: 'text=/temporarily restricted|unusual activity|account has been restricted/i'
} as const;

const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

export interface LinkedInOwnPostMetrics {
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  clicks: null;
  profileViews: null;
  follows: null;
}

export interface LinkedInOwnPostMetricRead {
  ok: boolean;
  failureKind: LinkedInFailureKind | null;
  detail?: string;
  postUrl: string | null;
  metrics: LinkedInOwnPostMetrics;
  degraded: string[];
}

const EMPTY_METRICS: LinkedInOwnPostMetrics = {
  impressions: null,
  reactions: null,
  comments: null,
  reposts: null,
  clicks: null,
  profileViews: null,
  follows: null
};

/**
 * Parse a human-rendered compact count such as `1,234 reactions`, `1.2K
 * impressions`, or `2M`. Ambiguous strings and strings without a number are
 * null. We do not guess locale-dependent decimal punctuation without a suffix.
 */
export function parseLinkedInMetricCount(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(
    /(?:^|\s)(\d{1,3}(?:[ ,]\d{3})+|\d+(?:\.\d+)?)(?:\s*)([kKmM])?(?=\s|$|[^\w])/
  );
  if (!match) return null;
  const raw = match[1]!.replace(/[ ,]/g, '');
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  return Math.max(0, Math.round(number * multiplier));
}

async function present(page: LinkedInPage, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

async function detectWall(page: LinkedInPage): Promise<LinkedInFailureKind | null> {
  if (CHECKPOINT_PATH.test(page.url())) return 'challenge';
  if (await present(page, POST_METRIC_SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, POST_METRIC_SELECTORS.restrictionNotice)) return 'limit_wall';
  return null;
}

async function visibleCount(
  page: LinkedInPage,
  selector: string,
  label: string,
  degraded: string[]
): Promise<number | null> {
  const locator = page.locator(selector);
  const found = await locator.count();
  if (found === 0) {
    degraded.push(`${label} was not visible on this post, so Trevra left it unavailable.`);
    return null;
  }
  const first = locator.first();
  const text = first.innerText
    ? await first.innerText({ timeout: 5_000 })
    : await first.textContent({ timeout: 5_000 });
  const parsed = parseLinkedInMetricCount(text);
  if (parsed === null) {
    degraded.push(
      `${label} was visible but no numeric count could be read, so Trevra left it unavailable.`
    );
  }
  return parsed;
}

export async function readOwnPostMetrics(
  page: LinkedInPage,
  rawPostUrl: string
): Promise<LinkedInOwnPostMetricRead> {
  const postUrl = postUrlFor(rawPostUrl);
  if (!postUrl) {
    return {
      ok: false,
      failureKind: 'not_found',
      detail: `'${rawPostUrl}' is not a supported LinkedIn post URL.`,
      postUrl: null,
      metrics: { ...EMPTY_METRICS },
      degraded: []
    };
  }

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await settle(page, `post-metrics:${postUrl}`);
  } catch (cause) {
    return {
      ok: false,
      failureKind: 'selector_drift',
      detail: `Could not open the published post: ${cause instanceof Error ? cause.message : String(cause)}`,
      postUrl,
      metrics: { ...EMPTY_METRICS },
      degraded: []
    };
  }

  const wall = await detectWall(page);
  if (wall) {
    return {
      ok: false,
      failureKind: wall,
      detail: `LinkedIn showed a ${wall} while Trevra was reading the operator's own post metrics.`,
      postUrl,
      metrics: { ...EMPTY_METRICS },
      degraded: []
    };
  }

  const degraded: string[] = [];
  const [impressions, reactions, comments, reposts] = await Promise.all([
    visibleCount(page, POST_METRIC_SELECTORS.impressions, 'Impressions', degraded),
    visibleCount(page, POST_METRIC_SELECTORS.reactions, 'Reactions', degraded),
    visibleCount(page, POST_METRIC_SELECTORS.comments, 'Comments', degraded),
    visibleCount(page, POST_METRIC_SELECTORS.reposts, 'Reposts', degraded)
  ]);

  return {
    ok: true,
    failureKind: null,
    postUrl,
    metrics: {
      impressions,
      reactions,
      comments,
      reposts,
      clicks: null,
      profileViews: null,
      follows: null
    },
    degraded
  };
}
