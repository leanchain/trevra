import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Instagram.
 *
 * Off by default, and the reason is written here rather than in a doc nobody
 * reads: content publishing through the Graph API only works for an Instagram
 * Business or Creator account linked to a Facebook Page, every post needs an
 * image or video Trevra does not produce, and a URL in a caption is dead text.
 * That is three separate ways a founder finds out too late that it did not
 * work, so it ships disabled with `linksAllowed: false`.
 */
export const instagramChannel: ChannelAdapter = {
  key: 'instagram',
  name: 'Instagram',
  homeUrl: 'https://www.instagram.com',
  audience: ['consumers', 'ecommerce', 'creators'],
  formats: ['image', 'video'],
  constraints: {
    // Captions are capped at 2,200 characters.
    maxChars: 2_200,
    // A URL in a caption renders as plain text, so it is worse than useless.
    linksAllowed: false,
    // Instagram accepts at most 30 hashtags per post.
    maxTags: 30,
    mediaRequired: true
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Instagram content publishing requires a Business or Creator account linked to a Facebook Page through the Graph API, so it cannot be assumed available for a founder’s personal account.',
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform/content-publishing'
  },
  enabledByDefault: false,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://www.instagram.com/',
      warnings: ['Instagram captions cannot carry a clickable link; put the URL in the profile bio and say so in the caption.']
    });
  }
};
