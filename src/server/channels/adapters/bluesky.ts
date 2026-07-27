import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Bluesky (AT Protocol).
 *
 * Records are written straight to the account’s own repository over XRPC.
 * There is no review queue and no paid tier gating writes, so this channel may
 * claim `api-publish`.
 */
export const blueskyChannel: ChannelAdapter = {
  key: 'bluesky',
  name: 'Bluesky',
  homeUrl: 'https://bsky.app',
  audience: ['developers', 'founders', 'open-source'],
  formats: ['text', 'link', 'image', 'video'],
  constraints: {
    // app.bsky.feed.post caps text at 300 graphemes.
    maxChars: 300,
    linksAllowed: true
  },
  automation: {
    mode: 'api-publish',
    reason:
      'The AT Protocol endpoint com.atproto.repo.createRecord writes an app.bsky.feed.post record to the account’s own repository, authorised by a self-issued app password.',
    docsUrl: 'https://docs.bsky.app/docs/api/com-atproto-repo-create-record'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({ channelKey: this.key, constraints: this.constraints, draft });
  }
};
