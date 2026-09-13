import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Beehiiv newsletter handoff.
 *
 * Beehiiv documents a Create Post API, but the endpoint is restricted to Max
 * and Enterprise publications. That makes API publishing an optional paid-plan
 * capability rather than something Trevra can safely assume for every founder.
 * V1 therefore prepares the newsletter and hands it to the Beehiiv editor.
 */
export const beehiivChannel: ChannelAdapter = {
  key: 'beehiiv',
  name: 'Beehiiv',
  homeUrl: 'https://www.beehiiv.com',
  audience: ['founders', 'operators', 'b2b', 'creators', 'newsletter'],
  formats: ['article', 'text', 'link', 'image'],
  constraints: {
    // Beehiiv has a real post/newsletter title; no hard title ceiling is
    // documented on the Create Post endpoint.
    titleAllowed: true,
    // Editorial sanity bound, not a Beehiiv platform maximum.
    maxChars: 100_000,
    linksAllowed: true
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Beehiiv’s Create Post API is available only on Max and Enterprise plans, so Trevra cannot assume API publishing is available for every publication.',
    docsUrl: 'https://developers.beehiiv.com/api-reference/posts/create'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://app.beehiiv.com/',
      warnings: [
        'Beehiiv API post creation requires a Max or Enterprise publication; this Trevra surface is copy-only until an eligible publication is explicitly connected.'
      ]
    });
  }
};
