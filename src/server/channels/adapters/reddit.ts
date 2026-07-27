import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Default target subreddits for a technical / open-source / e-commerce founder.
 *
 * Seeded into the channel row's `config_json` on first insert and never
 * overwritten afterwards, so an operator's edited list survives every deploy.
 * Each of these has its own self-promotion rules -- read the sidebar before
 * posting, which is exactly why this channel is `prepare-only`.
 */
export const REDDIT_SUBREDDITS: readonly string[] = [
  'r/SaaS',
  'r/Entrepreneur',
  'r/ecommerce',
  'r/shopify',
  'r/selfhosted',
  'r/opensource'
];

/**
 * Reddit.
 *
 * The API can post. That is not the question. Sitewide spam policy and
 * per-subreddit self-promotion rules mean an unattended post is a shadowban
 * risk for the account and the domain, and a human has to pick the subreddit
 * that actually fits the content. So: `prepare-only`.
 */
export const redditChannel: ChannelAdapter = {
  key: 'reddit',
  name: 'Reddit',
  homeUrl: 'https://www.reddit.com',
  audience: ['developers', 'founders', 'ecommerce', 'self-hosters', 'open-source'],
  formats: ['text', 'link', 'image', 'video'],
  constraints: {
    // Reddit rejects post titles longer than 300 characters.
    maxTitleChars: 300,
    // Self-post text is capped at 40,000 characters.
    maxChars: 40_000,
    linksAllowed: true,
    // A post carries at most one flair.
    maxTags: 1
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Reddit’s sitewide self-promotion and spam policy plus per-subreddit rules make unattended submission a ban risk, so a human chooses the subreddit and posts from their own account.',
    docsUrl: 'https://support.reddithelp.com/hc/en-us/articles/360043504051-Reddit-Content-Policy'
  },
  enabledByDefault: true,
  defaultConfig: { subreddits: [...REDDIT_SUBREDDITS] },
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://www.reddit.com/submit',
      warnings: [
        `Pick one subreddit and read its self-promotion rules first; seeded candidates: ${REDDIT_SUBREDDITS.join(', ')}.`
      ]
    });
  }
};
