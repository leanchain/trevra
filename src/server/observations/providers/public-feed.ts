const POSTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface FeedCount {
  count: number | null;
  warning: string | null;
}

function extractBlocks(xml: string): string[] {
  const rss = [...xml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  if (rss.length > 0) return rss;
  return [...xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function dateFromBlock(block: string): number | null {
  const raw =
    block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ??
    block.match(/<published\b[^>]*>([\s\S]*?)<\/published>/i)?.[1] ??
    block.match(/<updated\b[^>]*>([\s\S]*?)<\/updated>/i)?.[1] ??
    null;
  if (!raw) return null;
  const parsed = Date.parse(raw.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Count a trailing 30-day publication window only when the public feed proves
 * that the count is complete. A feed containing only recent entries may be
 * truncated by the publisher, so it is deliberately left unmeasured.
 */
export function countPublicFeedPosts30d(xml: string, now: Date): FeedCount {
  if (!/<(?:rss|feed)\b/i.test(xml))
    return { count: null, warning: 'response is not an RSS/Atom feed' };
  const blocks = extractBlocks(xml);
  if (blocks.length === 0) return { count: 0, warning: null };
  const dates = blocks.map(dateFromBlock);
  if (dates.some((date) => date === null)) {
    return { count: null, warning: 'one or more feed entries have no parseable publication date' };
  }
  const values = dates as number[];
  const cutoff = now.getTime() - POSTS_WINDOW_MS;
  const oldest = Math.min(...values);
  if (oldest > cutoff) {
    return {
      count: null,
      warning:
        'all returned feed entries are inside the 30-day window, so the public feed may be truncated'
    };
  }
  return {
    count: values.filter((date) => date >= cutoff && date <= now.getTime() + 60 * 60 * 1_000)
      .length,
    warning: null
  };
}
