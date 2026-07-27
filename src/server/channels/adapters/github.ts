import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/**
 * GitHub -- Releases and repository Discussions.
 *
 * For an open-source project this is the channel that matters most: the
 * release note is the announcement, and it is addressed to the people already
 * running the code. Both surfaces are writable by a self-serve token, so this
 * channel may claim `api-publish`.
 */
export const githubChannel: ChannelAdapter = {
  key: 'github',
  name: 'GitHub',
  homeUrl: 'https://github.com',
  audience: ['developers', 'open-source', 'self-hosters'],
  formats: ['article', 'text', 'link'],
  constraints: {
    // Discussion and release titles are comfortably inside 255 characters.
    maxTitleChars: 255,
    // A release body is capped at 125,000 characters.
    maxChars: 125_000,
    linksAllowed: true
    // Labels are repository-defined, so there is no portable tag cap.
  },
  automation: {
    mode: 'api-publish',
    reason:
      'GitHub documents release creation in the REST API (POST /repos/{owner}/{repo}/releases) and discussion creation in the GraphQL API, both authorised by a self-issued token.',
    docsUrl: 'https://docs.github.com/en/rest/releases/releases#create-a-release'
  },
  enabledByDefault: true,
  adapt(draft) {
    return shapePost({ channelKey: this.key, constraints: this.constraints, draft });
  }
};
