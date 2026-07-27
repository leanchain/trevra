import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Indie Hackers.
 *
 * There is no public API at all -- read or write. Posts exist only through the
 * web composer, so this channel is permanently `prepare-only` until Indie
 * Hackers publishes one.
 */
export const indiehackersChannel: ChannelAdapter = {
  key: 'indiehackers',
  name: 'Indie Hackers',
  homeUrl: 'https://www.indiehackers.com',
  audience: ['founders', 'bootstrappers', 'operators', 'ecommerce'],
  formats: ['text', 'link', 'article'],
  constraints: {
    maxTitleChars: 200,
    maxChars: 20_000,
    linksAllowed: true,
    // A post lives in exactly one group.
    maxTags: 1
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Indie Hackers publishes no public write API; a post can only be created through the web composer while signed in.',
    docsUrl: 'https://www.indiehackers.com/post/the-indie-hackers-community-guidelines-8c4f0a1e6a'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://www.indiehackers.com/new-post'
    });
  }
};
