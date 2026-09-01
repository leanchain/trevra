import type { FeedThread, WatchTrendPoint } from '../api';

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  github: 'GitHub',
  devto: 'Dev.to',
  lobsters: 'Lobsters',
  mastodon: 'Mastodon',
  stackoverflow: 'Stack Overflow'
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

// Round the hours first, then pick the unit off the rounded value -- deciding
// on the raw hours would let a 23.5h span round up to display as "24h", a
// boundary this label claims it never crosses.
function elapsed(from: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(from)) / 3_600_000);
  const roundedHours = Math.round(hours);
  if (roundedHours < 24) return `${roundedHours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Thread age, or discovery age said plainly.
 *
 * A platform that reports no timestamp leaves only first_seen_at, which is when
 * WE looked -- presenting that as the thread's age would date a two-year-old
 * post to this morning.
 */
export function ageLabel(entry: FeedThread, now: Date): string {
  if (entry.row.thread_created_at) return `${elapsed(entry.row.thread_created_at, now)} old`;
  return `first seen ${elapsed(entry.row.first_seen_at, now)} ago`;
}

interface WhyChip {
  /** What the reader sees. */
  label: string;
  /** The contribution this reason made to the relevance score. */
  points: number;
  tone: 'positive' | 'negative';
}

/**
 * The scorer's counters, said in words a reader can act on.
 *
 * `high-value keywords (1)` and `thread score > 10` are the scorer's internal
 * labels: they tell a founder that SOMETHING matched without saying what, and
 * the second one calls the platform's vote count a "score" -- the exact word
 * this screen reserves for relevance. So the count labels are replaced by the
 * matched phrases themselves (which the scorer already reports, so nothing is
 * invented) and the threshold labels by their plain reading. An unmapped label
 * falls through verbatim: a new scoring rule shows up unexplained rather than
 * disappearing.
 */
const COMPONENT_LABELS: Record<string, string> = {
  'thread score > 10': '10+ points',
  'thread score > 5': '5+ points',
  'more than 5 comments': '5+ comments',
  'more than 2 comments': '2+ comments',
  'less than 24h old': 'posted in the last 24h',
  'less than 72h old': 'posted in the last 3 days',
  'less than a week old': 'posted this week',
  'upvote ratio > 0.8': 'upvote ratio above 80%',
  'HN score > 50': '50+ points on HN',
  'Ask HN thread': 'Ask HN question',
  'author is a contributor or member': 'author contributes to the repo',
  'labelled question': 'labelled a question'
};

function quoted(matches: readonly string[]): string {
  return matches.map((match) => `"${match}"`).join(', ');
}

export function whyChips(entry: FeedThread): WhyChip[] {
  const { components, highValueMatches, mediumMatches, negativeMatches } = entry.relevance;
  return components.map((component) => {
    if (component.label.startsWith('high-value keywords') && highValueMatches.length > 0) {
      return {
        label: quoted(highValueMatches),
        points: component.points,
        tone: 'positive' as const
      };
    }
    if (component.label.startsWith('medium keywords') && mediumMatches.length > 0) {
      return { label: quoted(mediumMatches), points: component.points, tone: 'positive' as const };
    }
    if (component.label.startsWith('negative keywords') && negativeMatches.length > 0) {
      return {
        label: `avoid: ${quoted(negativeMatches)}`,
        points: component.points,
        tone: 'negative' as const
      };
    }
    return {
      label: COMPONENT_LABELS[component.label] ?? component.label,
      points: component.points,
      tone: component.points < 0 ? ('negative' as const) : ('positive' as const)
    };
  });
}

/** `+2` / `-3`, so a chip shows what it was worth, not just that it matched. */
export function chipPoints(chip: WhyChip): string {
  return `${chip.points > 0 ? '+' : ''}${chip.points}`;
}

/** The platform's own numbers, labelled so they are never read as relevance. */
export function factsLine(entry: FeedThread, now: Date): string {
  return [
    platformLabel(entry.row.platform),
    `${entry.row.num_comments} comments`,
    `${entry.row.score} points`,
    ageLabel(entry, now)
  ].join(' · ');
}

// 119, not 120: the rendered chip wraps the clipped span in two curly quote
// marks plus the ellipsis, so 120 characters of span would put the chip's
// text one character past the 122-character display cap this UI reserves
// for the line.
const SPAN_MAX = 119;

/** The sentiment chip: the deciding sentence, quoted, or the bare label when there is none. */
export function sentimentChip(mention: { sentimentLabel: string; sentimentSpan: string }): {
  tone: string;
  text: string;
} {
  const tone =
    mention.sentimentLabel === 'positive'
      ? 'is-positive'
      : mention.sentimentLabel === 'negative'
        ? 'is-negative'
        : 'is-neutral';
  const span = mention.sentimentSpan.trim();
  if (span === '') {
    return {
      tone,
      text: mention.sentimentLabel.charAt(0).toUpperCase() + mention.sentimentLabel.slice(1)
    };
  }
  const clipped = span.length > SPAN_MAX ? `${span.slice(0, SPAN_MAX)}…` : span;
  return { tone, text: `“${clipped}”` };
}

/**
 * The numeric headline beside the trend bars: `+12 / 4 / -3 · avg 0.31`.
 *
 * `average` on each `TrendPoint` is that one day's mean (score_sum / that
 * day's count); averaging those per-day means again would let a day with one
 * mention outweigh a day with twenty. The window average is instead the
 * total score across every day divided by the total mention count, recovered
 * from the per-day fields already on the wire (`average * count` undoes the
 * day's own division), so no server change is needed to show it.
 */
export function trendHeadline(points: readonly WatchTrendPoint[]): string {
  const positive = points.reduce((sum, point) => sum + point.positive, 0);
  const neutral = points.reduce((sum, point) => sum + point.neutral, 0);
  const negative = points.reduce((sum, point) => sum + point.negative, 0);
  const total = positive + neutral + negative;
  const scoreSum = points.reduce(
    (sum, point) => sum + point.average * (point.positive + point.neutral + point.negative),
    0
  );
  const average = total === 0 ? 0 : scoreSum / total;
  return `+${positive} / ${neutral} / -${negative} · avg ${average.toFixed(2)}`;
}
