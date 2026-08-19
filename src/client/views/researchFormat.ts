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

function elapsed(from: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(from)) / 3_600_000);
  if (hours < 24) return `${Math.round(hours)}h`;
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

/** The scorer's own reasons, verbatim. Nothing is invented for display. */
export function whyChips(entry: FeedThread): string[] {
  return [
    ...entry.relevance.components.map((component) => component.label),
    ...entry.relevance.negativeMatches.map((match) => `negative: ${match}`)
  ];
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
