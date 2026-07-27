import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * dev.to (Forem).
 *
 * Long-form technical writing. Forem is itself open source and ships a
 * documented, self-serve write API, which is why this is one of the few
 * channels allowed to claim `api-publish`.
 */
export const devtoChannel: ChannelAdapter = {
  key: 'devto',
  name: 'dev.to',
  homeUrl: 'https://dev.to',
  audience: ['developers', 'open-source', 'founders'],
  formats: ['article', 'text', 'link'],
  constraints: {
    // Forem validates article titles at 250 characters.
    maxTitleChars: 250,
    // Forem sets no published body ceiling; this is a sanity bound, not a platform rule.
    maxChars: 100_000,
    linksAllowed: true,
    // Forem documents the article `tags` parameter as "up to 4 tags".
    maxTags: 4
  },
  automation: {
    mode: 'api-publish',
    reason:
      'Forem ships a documented Articles API: POST /api/articles authenticated with a user-generated api-key creates and publishes an article without partner approval.',
    docsUrl: 'https://developers.forem.com/api/v1'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({ channelKey: this.key, constraints: this.constraints, draft });
  }
};
