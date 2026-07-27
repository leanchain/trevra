import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Lobsters (lobste.rs).
 *
 * Small, invite-only, and unusually intolerant of self-promotion: the site
 * rules put a hard ceiling on how much of a user’s activity may be their own
 * work. There is no submission API. A human with an invited account submits,
 * or nobody does.
 */
export const lobstersChannel: ChannelAdapter = {
  key: 'lobsters',
  name: 'Lobsters',
  homeUrl: 'https://lobste.rs',
  audience: ['developers', 'open-source', 'self-hosters', 'privacy'],
  formats: ['link', 'text'],
  constraints: {
    maxTitleChars: 100,
    maxChars: 5_000,
    linksAllowed: true,
    // A story carries at most 3 tags.
    maxTags: 3
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Lobsters registration is invite-only and its rules require self-promotion to stay under a quarter of a user’s stories and comments, so submissions must come from an invited human account.',
    docsUrl: 'https://lobste.rs/about'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://lobste.rs/stories/new'
    });
  }
};
