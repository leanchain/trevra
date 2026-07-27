import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * X (Twitter).
 *
 * POST /2/tweets exists, but write access is metered by paid API tiers and the
 * free allowance is a token quota meant for testing. A capability that stops
 * working the moment a founder posts more than a handful of times, or that
 * silently bills them, cannot ship as default-on automation.
 */
export const xChannel: ChannelAdapter = {
  key: 'x',
  name: 'X',
  homeUrl: 'https://x.com',
  audience: ['founders', 'developers', 'operators'],
  formats: ['text', 'link', 'image', 'video'],
  constraints: {
    // Standard (non-premium) post limit.
    maxChars: 280,
    linksAllowed: true,
    // Not enforced by X; 2 keeps a 280-character post readable.
    maxTags: 2
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'X API v2 write access is metered by paid access tiers beyond a small free trial quota, so programmatic posting cannot be a default-on capability.',
    docsUrl: 'https://developer.x.com/en/portal/products'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://x.com/compose/post'
    });
  }
};
