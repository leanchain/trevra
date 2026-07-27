import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * LinkedIn.
 *
 * Two separate reasons this cannot be `api-publish`: posting to a member
 * profile needs LinkedIn's access-gated "Share on LinkedIn" product, and page
 * posting needs the partner-only Community Management API. Neither is
 * available to a self-serve application. Separately, the feed demotes posts
 * carrying an outbound link -- hence `linkPenalty`.
 */
export const linkedinChannel: ChannelAdapter = {
  key: 'linkedin',
  name: 'LinkedIn',
  homeUrl: 'https://www.linkedin.com',
  audience: ['founders', 'b2b', 'operators', 'agencies'],
  formats: ['text', 'link', 'image', 'video'],
  constraints: {
    // LinkedIn truncates a feed post at 3,000 characters.
    maxChars: 3_000,
    linksAllowed: true,
    linkPenalty: true,
    // Not enforced by LinkedIn; 3 keeps the post readable.
    maxTags: 3
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Posting to a member profile requires LinkedIn’s review-gated Share on LinkedIn product and page posting requires the partner-only Community Management API, so no self-serve application may publish.',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://www.linkedin.com/feed/'
    });
  }
};
