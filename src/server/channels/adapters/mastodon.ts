import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Mastodon.
 *
 * The statuses API is part of the server software rather than a commercial
 * product, so posting needs no partner programme -- only an OAuth application
 * registered on the instance the account lives on.
 */
export const mastodonChannel: ChannelAdapter = {
  key: 'mastodon',
  name: 'Mastodon',
  homeUrl: 'https://joinmastodon.org',
  audience: ['developers', 'open-source', 'privacy', 'self-hosters'],
  formats: ['text', 'link', 'image', 'video'],
  constraints: {
    // Default instance limit. An instance may raise it; the default is the safe assumption.
    maxChars: 500,
    linksAllowed: true
    // Hashtags are uncapped by the protocol.
  },
  automation: {
    mode: 'api-publish',
    reason:
      'Mastodon ships POST /api/v1/statuses as a documented part of the server software, callable by any OAuth application registered on the account’s own instance.',
    docsUrl: 'https://docs.joinmastodon.org/methods/statuses/#create'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({ channelKey: this.key, constraints: this.constraints, draft });
  }
};
