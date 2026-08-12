/**
 * Outreach targeting and policy constants.
 *
 * Ported from the Python reference `tools/outreach/config.yaml`. The YAML file
 * does NOT come with it, deliberately: every value below is code-owned policy
 * that a reviewer should see in a diff, and the reference's `${ENV_VAR}`
 * interpolation layer existed only to keep credentials out of the YAML --
 * which is what `process.env` already does here, with no parser.
 *
 * The one thing that WAS operator state in the reference -- per-platform
 * enablement -- is operator state here too: it lives on the `channels` row
 * (`enabled`), not in this file.
 */

import type { CredentialAccessor } from '../research/types.js';

/** Keyword ladder driving relevance. Verbatim from `search.keywords` in the reference config. */
export const HIGH_VALUE_KEYWORDS: readonly string[] = [
  'token cost',
  'token savings',
  'reduce tokens',
  'api cost',
  'expensive',
  'burn rate',
  'cost per task'
];

export const MEDIUM_KEYWORDS: readonly string[] = [
  'coding agent',
  'claude code',
  'copilot',
  'context window',
  'context engineering',
  'aider',
  'cursor'
];

/**
 * Phrases that mean "do not reply here".
 *
 * Each is worth -3, enough on its own to sink a thread below any realistic
 * threshold. That is the intent: someone who wrote "stop spamming" in a thread
 * has already told us the answer.
 */
export const NEGATIVE_KEYWORDS: readonly string[] = ['not interested', 'stop spamming', 'already know'];

/** Default search terms per platform, from `search.queries` in the reference config. */
export const PLATFORM_QUERIES: Readonly<Record<string, readonly string[]>> = {
  reddit: [
    'token cost coding agent',
    'claude code expensive',
    'reduce api costs programming',
    'context engineering',
    'cursor alternative',
    'copilot cost',
    'aider token usage',
    'LLM coding expensive',
    'coding agent budget',
    'reduce token usage'
  ],
  hackernews: [
    'token cost',
    'claude code',
    'coding agent cost',
    'context engineering',
    'reduce llm cost',
    'copilot alternative',
    'ai coding tool',
    'token efficient'
  ],
  github: [
    'token cost',
    'reduce tokens',
    'context window',
    'api cost',
    'expensive',
    'context engineering',
    'token usage',
    'cost reduction'
  ],
  devto: ['token cost', 'reduce tokens', 'context engineering', 'coding agent'],
  lobsters: ['token cost', 'coding agent', 'context engineering'],
  mastodon: ['token cost', 'coding agent', 'AI tools'],
  stackoverflow: ['token cost', 'reduce tokens', 'context window', 'api cost'],
  linkedin: ['token cost', 'AI coding', 'developer tools']
};

/** Subreddits worth searching, from `platforms.reddit.target_subreddits`. */
export const REDDIT_TARGET_SUBREDDITS: readonly string[] = [
  'ClaudeAI',
  'ChatGPT',
  'LocalLLaMA',
  'MachineLearning',
  'programming',
  'webdev',
  'ChatGPTCoding',
  'Cursor',
  'github',
  'OpenAI'
];

/** Repos worth searching, from `platforms.github.target_repos`. */
export const GITHUB_TARGET_REPOS: readonly string[] = [
  'anthropics/claude-code',
  'continuedev/continue',
  'paul-gauthier/aider',
  'langchain-ai/langchain',
  'openai/openai-python'
];

/**
 * Per-platform posting limits, from the `platforms.*` blocks.
 *
 * `maxPostsPerDay` was read by the reference (`BaseScout.can_post`).
 * `minAccountAgeDays` and `minKarma` were declared in the YAML and never read
 * by any code path -- see `safety.ts`, which enforces them.
 */
export interface PlatformLimits {
  maxPostsPerDay: number;
  minAccountAgeDays: number;
  minKarma: number;
  /** Minimum hours between two posts into the same community on this platform. */
  cooldownHours: number;
}

export const DEFAULT_PLATFORM_LIMITS: PlatformLimits = {
  maxPostsPerDay: 5,
  minAccountAgeDays: 30,
  minKarma: 50,
  cooldownHours: 48
};

export const PLATFORM_LIMITS: Readonly<Record<string, PlatformLimits>> = {
  reddit: { maxPostsPerDay: 5, minAccountAgeDays: 30, minKarma: 50, cooldownHours: 48 },
  hackernews: { maxPostsPerDay: 3, minAccountAgeDays: 60, minKarma: 100, cooldownHours: 48 },
  github: { maxPostsPerDay: 10, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 },
  devto: { maxPostsPerDay: 10, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 },
  // Lobsters and Stack Overflow declare no account minimums in the reference
  // config, and none are invented here. Combined with the fail-closed rule in
  // safety.ts (an undeclared profile fails any NON-ZERO minimum), inventing
  // one would silently make both platforms unusable until an operator guessed
  // that they had to declare a profile.
  lobsters: { maxPostsPerDay: 5, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 },
  mastodon: { maxPostsPerDay: 10, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 },
  stackoverflow: { maxPostsPerDay: 5, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 },
  linkedin: { maxPostsPerDay: 5, minAccountAgeDays: 0, minKarma: 0, cooldownHours: 48 }
};

export function limitsFor(platform: string): PlatformLimits {
  return PLATFORM_LIMITS[platform] ?? DEFAULT_PLATFORM_LIMITS;
}

/** Hard blocks, from the `safety.*` block. Checked before anything else. */
export const BLACKLISTED_COMMUNITIES: readonly string[] = ['askreddit', 'tifu', 'amitheasshole'];
export const BLACKLISTED_KEYWORDS: readonly string[] = ['spam', 'scam', 'bot'];

/** Max share of a community's discovered threads we may have replied in. From `safety.max_self_promo_ratio`. */
export const MAX_SELF_PROMO_RATIO = 0.1;

/** Default relevance floor. The reference's `RelevanceScorer.should_respond(min_score=5.0)`. */
export const MIN_RELEVANCE_SCORE = 5;

/**
 * The operator's account standing per platform, read from
 * `OUTREACH_ACCOUNT_PROFILES_JSON`.
 *
 * The reference declared `min_account_age_days` and `min_karma` and then never
 * checked them, partly because checking means an authenticated call to every
 * platform's "who am I" endpoint before every run. Account age and karma move
 * slowly, so they are declared once by the operator and enforced on every
 * post. A platform with no declared profile fails any non-zero minimum --
 * unproven standing is not the same as sufficient standing.
 *
 * Shape: `{"reddit":{"accountAgeDays":400,"karma":1200}}`
 */
export interface AccountProfile {
  accountAgeDays: number;
  karma: number;
}

export const ACCOUNT_PROFILES_ENV = 'OUTREACH_ACCOUNT_PROFILES_JSON';

export interface AccountProfileRead {
  profiles: Record<string, AccountProfile>;
  /** Set when the variable was present but unusable. Never thrown. */
  warning: string | null;
}

/**
 * Parse the declared profiles, degrading rather than throwing.
 *
 * A typo in this variable must not fail every outreach run. Returning no
 * profiles already fails closed for every non-zero minimum, and the reason
 * travels in the `account-age` / `account-karma` check details alongside the
 * other five checks -- which is the module's "every check runs" contract.
 */
export function readAccountProfiles(credentials: CredentialAccessor): AccountProfileRead {
  const raw = credentials.get(ACCOUNT_PROFILES_ENV)?.trim();
  if (!raw) return { profiles: {}, warning: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { profiles: {}, warning: `${ACCOUNT_PROFILES_ENV} is not valid JSON and was ignored.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { profiles: {}, warning: `${ACCOUNT_PROFILES_ENV} must be a JSON object keyed by platform; it was ignored.` };
  }
  const profiles: Record<string, AccountProfile> = {};
  for (const [platform, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as { accountAgeDays?: unknown; karma?: unknown };
    profiles[platform] = {
      accountAgeDays: typeof entry.accountAgeDays === 'number' ? entry.accountAgeDays : 0,
      karma: typeof entry.karma === 'number' ? entry.karma : 0
    };
  }
  return { profiles, warning: null };
}
