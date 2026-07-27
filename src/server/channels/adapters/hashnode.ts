import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Hashnode.
 *
 * This one was drafted as `api-publish` and downgraded on verification, which
 * is exactly the check this module exists to force. Hashnode retired free
 * GraphQL API access: gql.hashnode.com now answers with a notice that reading
 * AND publishing both require a paid Pro plan. An automation that silently
 * depends on a subscription the founder may not have is the same failure mode
 * as X's paid write tier, so it ships `prepare-only`.
 */
export const hashnodeChannel: ChannelAdapter = {
  key: 'hashnode',
  name: 'Hashnode',
  homeUrl: 'https://hashnode.com',
  audience: ['developers', 'open-source'],
  formats: ['article', 'text', 'link'],
  constraints: {
    maxTitleChars: 250,
    // No documented body ceiling; a sanity bound, not a platform rule.
    maxChars: 100_000,
    linksAllowed: true,
    // Hashnode accepts at most 5 tags per post.
    maxTags: 5
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Hashnode retired free GraphQL API access; gql.hashnode.com states that reading and publishing both require a paid Pro plan, so it cannot be a default-on capability.',
    docsUrl: 'https://gql.hashnode.com/'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://hashnode.com/drafts'
    });
  }
};
