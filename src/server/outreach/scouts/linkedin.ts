import type { OutreachScout } from '../types.js';

/**
 * LinkedIn -- registered, and permanently disabled.
 *
 * The reference shipped this scout pointed at three unofficial resellers
 * (outx, publora, connectsafely) that scrape LinkedIn and resell the results,
 * with `enabled: false` in config.yaml and no explanation of why. The reason
 * is worth writing down, because "enable it and set an API key" looks like a
 * one-line change to the next reader:
 *
 * LinkedIn's User Agreement 8.2 prohibits using "bots or other automated
 * methods" to access the Services, scraping, and copying profiles or data. Any
 * reseller offering LinkedIn post search is doing exactly that, and buying the
 * output does not launder it -- it makes Trevra a downstream consumer of
 * scraped data with the founder's own account exposed to the ban. The official
 * Marketing Developer Platform grants no post-search capability at all, so
 * there is no compliant route to this feature, only non-compliant ones.
 *
 * This is `disabled` rather than deleted, on the same principle as
 * `WITHHELD_PROVIDERS` in `research/registry.ts`: an absence with no record
 * gets helpfully filled in six months later by someone who assumed it was a
 * backlog item.
 */

export const LINKEDIN_POLICY_OBSERVED_AT = '2026-08-03';

export const linkedinScout: OutreachScout = {
  platform: 'linkedin',
  name: 'LinkedIn',
  docsUrl: 'https://www.linkedin.com/legal/user-agreement',
  credentialEnvVars: [],
  availability() {
    return {
      mode: 'disabled',
      reason:
        `LinkedIn User Agreement 8.2 prohibits automated access, scraping, and copying data (observed ${LINKEDIN_POLICY_OBSERVED_AT}). Every third-party "LinkedIn post search" API resells scraped data, and the official Marketing Developer Platform exposes no post search, so there is no compliant implementation of this scout -- not a missing credential.`,
      docsUrl: 'https://www.linkedin.com/legal/user-agreement'
    };
  },
  async search() {
    return {
      platform: 'linkedin',
      threads: [],
      warnings: ['LinkedIn scouting is disabled by policy, not by configuration. See scouts/linkedin.ts.'],
      evidence: []
    };
  }
};
