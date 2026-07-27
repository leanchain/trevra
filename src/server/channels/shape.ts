import type { ChannelConstraints, ChannelDraft, ChannelPost } from './types.js';

/**
 * Shared, pure shaping helpers for channel adapters.
 *
 * Every adjustment an adapter makes to a draft has to be visible to the person
 * who will be held responsible for the post, so each helper reports what it
 * changed and `shapePost()` turns that into a human-readable `warnings[]` line.
 * Adapters append their own platform preconditions to the same array.
 */

export const ELLIPSIS = '…';

/** Matches a bare http(s) URL. Deliberately conservative about trailing punctuation. */
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+/gi;

/**
 * Character-budget sibling of `capWords()` in `../skills/draft.ts`.
 *
 * `capWords` caps by word count for an email body; channels cap by characters,
 * because that is what the platforms count. Same approach: walk forward on
 * whitespace boundaries, never cut mid-word, mark the cut with an ellipsis.
 * Whitespace runs are preserved so paragraph breaks survive truncation.
 *
 * The returned text is always at most `maxChars` characters, ellipsis included.
 */
export function capChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= ELLIPSIS.length) return { text: ELLIPSIS.slice(0, Math.max(0, maxChars)), truncated: true };

  const budget = maxChars - ELLIPSIS.length;
  let kept = '';
  for (const token of text.split(/(\s+)/)) {
    if (kept.length + token.length > budget) break;
    kept += token;
  }
  // A single leading word longer than the budget has no boundary to cut at.
  const body = (kept.trimEnd() || text.slice(0, budget)).replace(/[,;:]+$/, '');
  return { text: `${body}${ELLIPSIS}`, truncated: true };
}

/** Remove every http(s) URL from `text`, collapsing the whitespace it leaves behind. */
export function stripUrls(text: string): { text: string; removed: string[] } {
  const removed = text.match(URL_RE) ?? [];
  if (removed.length === 0) return { text, removed: [] };
  const stripped = text
    .replace(URL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, removed };
}

/** True when `text` already contains `url`, so an adapter does not append it twice. */
export function containsUrl(text: string, url: string): boolean {
  return text.includes(url);
}

/**
 * Normalise tags (lowercase, no leading `#`, de-duplicated, no blanks) and cap
 * them at the platform's limit. `maxTags` undefined means the platform sets no
 * cap, so nothing is dropped.
 */
export function capTags(tags: readonly string[], maxTags?: number): { tags: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '').toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    clean.push(tag);
  }
  if (maxTags === undefined || clean.length <= maxTags) return { tags: clean, dropped: [] };
  return { tags: clean.slice(0, maxTags), dropped: clean.slice(maxTags) };
}

export interface ShapeOptions {
  channelKey: string;
  constraints: ChannelConstraints;
  draft: ChannelDraft;
  /** Where a human posts it. Required for every `prepare-only` channel. */
  submitUrl?: string;
  /** Override the title after the draft title has been capped (e.g. the `Show HN:` prefix). */
  title?: string;
  /** Adapter-specific preconditions, appended after the shaping warnings. */
  warnings?: string[];
}

/**
 * Apply a channel's constraints to a draft.
 *
 * Order matters: the URL suffix is budgeted BEFORE the body is capped, so
 * truncation never silently eats the link the post exists to carry.
 */
export function shapePost(options: ShapeOptions): ChannelPost {
  const { channelKey, constraints, draft, submitUrl } = options;
  const warnings: string[] = [];

  const tagResult = capTags(draft.tags ?? [], constraints.maxTags);
  if (tagResult.dropped.length > 0) {
    warnings.push(
      `${channelKey} accepts at most ${constraints.maxTags} tag(s); dropped ${tagResult.dropped.join(', ')}.`
    );
  }

  let title: string | undefined;
  if (constraints.maxTitleChars !== undefined) {
    const capped = capChars(options.title ?? draft.title, constraints.maxTitleChars);
    if (capped.truncated) {
      warnings.push(
        `Title truncated to the ${constraints.maxTitleChars}-character ${channelKey} limit; write a shorter one before posting.`
      );
    }
    title = capped.text;
  } else if (draft.title.trim()) {
    warnings.push(`${channelKey} posts have no title field; the draft title was dropped from the post.`);
  }

  let body = draft.body;
  let suffix = '';

  if (!constraints.linksAllowed) {
    const stripped = stripUrls(body);
    if (stripped.removed.length > 0) {
      body = stripped.text;
      warnings.push(
        `${channelKey} does not render clickable links; removed ${stripped.removed.length} URL(s) from the body ` +
          `(${stripped.removed.join(', ')}). Place the link where the platform allows it.`
      );
    }
    if (draft.url) {
      warnings.push(`${channelKey} does not render clickable links; ${draft.url} was left out of the post.`);
    }
  } else if (draft.url && !containsUrl(body, draft.url)) {
    suffix = `\n\n${draft.url}`;
    if (suffix.length >= constraints.maxChars) {
      warnings.push(`${draft.url} does not fit inside the ${constraints.maxChars}-character ${channelKey} limit; it was left out.`);
      suffix = '';
    }
  }

  if (constraints.linkPenalty && (suffix !== '' || (constraints.linksAllowed && URL_RE.test(body)))) {
    warnings.push(`${channelKey} suppresses reach on posts carrying an outbound link; consider moving the link to a follow-up comment.`);
  }
  URL_RE.lastIndex = 0;

  const capped = capChars(body, constraints.maxChars - suffix.length);
  if (capped.truncated) {
    warnings.push(
      `Body truncated to the ${constraints.maxChars}-character ${channelKey} limit; ` +
        `${body.length} characters were drafted. Cut it deliberately instead.`
    );
  }

  if (constraints.mediaRequired) {
    warnings.push(`${channelKey} rejects a post with no image or video; attach media before posting.`);
  }

  return {
    channelKey,
    ...(title === undefined ? {} : { title }),
    body: `${capped.text}${suffix}`,
    tags: tagResult.tags,
    ...(submitUrl === undefined ? {} : { submitUrl }),
    warnings: [...warnings, ...(options.warnings ?? [])]
  };
}
