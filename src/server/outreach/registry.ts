import { devtoScout } from './scouts/devto.js';
import { githubScout } from './scouts/github.js';
import { hackernewsScout } from './scouts/hackernews.js';
import { linkedinScout } from './scouts/linkedin.js';
import { lobstersScout } from './scouts/lobsters.js';
import { mastodonScout } from './scouts/mastodon.js';
import { redditScout } from './scouts/reddit.js';
import { stackoverflowScout } from './scouts/stackoverflow.js';
import type { OutreachScout } from './types.js';

/**
 * Scout registry, mirroring `research/registry.ts` and `channels/registry.ts`:
 * an in-memory map keyed by platform, first registration wins, listings sorted
 * so they are stable.
 *
 * ADDING A PLATFORM IS ONE FILE AND ONE ENTRY IN THE LIST BELOW. Nothing else
 * needs to know it exists -- the scout skill, the playbook, and the tests are
 * all driven off `listScouts()`.
 *
 * No table and no seed function, for the same reason the research registry has
 * none: a scout carries no operator-tunable state. Which platforms are on is
 * operator state, and it already lives on the `channels` row.
 */

const scouts = new Map<string, OutreachScout>();

export function registerScout(scout: OutreachScout): OutreachScout {
  const existing = scouts.get(scout.platform);
  if (existing) return existing;
  scouts.set(scout.platform, scout);
  return scout;
}

export function getScout(platform: string): OutreachScout | undefined {
  return scouts.get(platform);
}

export function listScouts(): OutreachScout[] {
  return [...scouts.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

for (const scout of [
  hackernewsScout,
  redditScout,
  githubScout,
  lobstersScout,
  devtoScout,
  mastodonScout,
  stackoverflowScout,
  linkedinScout
]) {
  registerScout(scout);
}
