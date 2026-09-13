import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * Medium.
 *
 * Medium's current help says it no longer issues new integration tokens and
 * does not allow new API integrations. A founder can still publish normally in
 * the web editor, so Trevra prepares a source-backed article and hands it to a
 * human rather than pretending the old API is a viable write path.
 */
export const mediumChannel: ChannelAdapter = {
  key: 'medium',
  name: 'Medium',
  homeUrl: 'https://medium.com',
  audience: ['founders', 'developers', 'operators', 'b2b'],
  formats: ['article', 'text', 'link', 'image'],
  constraints: {
    // Medium exposes a title field but no current documented hard title ceiling.
    titleAllowed: true,
    // Editorial sanity bound, not a Medium platform maximum.
    maxChars: 100_000,
    linksAllowed: true
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'Medium no longer issues new API integration tokens or allows new API integrations, so Trevra must hand the prepared story to a human in the Medium editor.',
    docsUrl: 'https://help.medium.com/hc/en-us/articles/213480228-API-Importing'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      submitUrl: 'https://medium.com/new-story'
    });
  }
};
