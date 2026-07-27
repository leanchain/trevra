import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Product Hunt.
 *
 * The public API v2 reads launches; it does not create them. Product Hunt also
 * requires the maker to submit their own launch, which is the whole point of
 * the maker badge. Trevra writes the tagline and description; a human launches.
 */
export const producthuntChannel: ChannelAdapter = {
  key: 'producthunt',
  name: 'Product Hunt',
  homeUrl: 'https://www.producthunt.com',
  audience: ['founders', 'early-adopters', 'developers', 'operators'],
  formats: ['link', 'text', 'image', 'video'],
  constraints: {
    // The tagline field is short by design.
    maxTitleChars: 60,
    // The launch description field is capped at 260 characters.
    maxChars: 260,
    linksAllowed: true,
    // A launch carries at most 3 topics.
    maxTags: 3,
    // A launch without a thumbnail and gallery media is rejected.
    mediaRequired: true
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Product Hunt’s public API v2 exposes no mutation for creating a launch, and its rules require a launch to be submitted by a human maker.',
    docsUrl: 'https://api.producthunt.com/v2/docs'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://www.producthunt.com/posts/new'
    });
  }
};
