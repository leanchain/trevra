import type { FeedThread } from '../api';

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

export interface WhyChip {
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
