import type { ChannelAdapter } from '../types.js';
import { shapePost } from '../shape.js';

/** Show HN posts are expected to carry this prefix; HN moderators add it by hand otherwise. */
export const SHOW_HN_PREFIX = 'Show HN: ';

/**
 * Hacker News -- Show HN.
 *
 * `prepare-only`, and it is not close. The official HN API is a read-only
 * Firebase mirror with no submission endpoint at all, and the guidelines treat
 * automated submission and coordinated voting as bannable. Trevra writes the
 * post; a human presses submit from their own account.
 */
export const hackernewsChannel: ChannelAdapter = {
  key: 'hackernews',
  name: 'Hacker News (Show HN)',
  homeUrl: 'https://news.ycombinator.com',
  audience: ['developers', 'founders', 'open-source', 'self-hosters'],
  formats: ['link', 'text'],
  constraints: {
    // HN rejects submission titles longer than 80 characters.
    maxTitleChars: 80,
    // The submission text field truncates well before this; 2,000 keeps a Show HN inside what the form reliably accepts.
    maxChars: 2_000,
    linksAllowed: true
    // HN has no tags.
  },
  automation: {
    mode: 'prepare-only',
    reason:
      'The official Hacker News API is read-only with no submission endpoint, and the guidelines forbid soliciting upvotes, comments, or submissions and treat voting rings as cheating, so a human must submit from their own account.',
    docsUrl: 'https://news.ycombinator.com/newsguidelines.html'
  },
  enabledByDefault: true,
  adapt(draft) {
    const warnings: string[] = [];
    let title = draft.title;
    if (!/^show hn:/i.test(title.trim())) {
      title = `${SHOW_HN_PREFIX}${title.trim()}`;
      warnings.push(`Prefixed the title with "${SHOW_HN_PREFIX.trim()}" so it reads as a Show HN submission.`);
    }
    return shapePost({
      channelKey: this.key,
      constraints: this.constraints,
      draft,
      title,
      submitUrl: 'https://news.ycombinator.com/submit',
      warnings
    });
  }
};
