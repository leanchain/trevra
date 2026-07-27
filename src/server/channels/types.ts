/**
 * The distribution-channel contract.
 *
 * A channel is NOT a skill. A skill is a unit of work; a channel is a
 * destination -- an identity a founder publishes under, a set of content
 * constraints that destination enforces, and a platform policy that says
 * whether a machine is allowed to press the button. Skills USE channels.
 *
 * The honesty rule this module exists to enforce: a channel never claims more
 * automation than its platform actually grants. Every adapter carries the WHY
 * next to the WHAT, in code, where a reviewer reads it -- the same philosophy
 * as the `app_store` entry in the Python reference registry
 * (`src/growth/sources/registry.py`), which ships disabled with its ToS reason
 * written directly into the source.
 */

/** What kind of artefact a channel accepts. */
export type ChannelFormat = 'text' | 'link' | 'article' | 'image' | 'video';

/**
 * How far Trevra may go on this channel, unattended.
 *
 * The honesty mechanism. Mirrors the Python registry's disabled-with-reason
 * pattern: the constraint and its justification live together in the code.
 *
 * - `api-publish`  -- the platform's own documented write API permits
 *   programmatic posting for a self-serve app. Claim this ONLY when that is
 *   verifiably true; being wrong here gets a user's account banned.
 * - `prepare-only` -- Trevra drafts it, shapes it, and hands a human the text
 *   plus a submit URL. The default, and the correct answer whenever there is
 *   any doubt.
 * - `disabled`     -- do not touch this platform at all.
 */
export type AutomationMode = 'api-publish' | 'prepare-only' | 'disabled';

/** What the destination will actually accept. Enforced by `adapt()`, not merely described. */
export interface ChannelConstraints {
  /** Hard ceiling on the post body, in characters. */
  maxChars: number;
  /** Present only when the channel has a title/headline field at all. */
  maxTitleChars?: number;
  /** False when a URL in the body is dead text (or forbidden) rather than a link. */
  linksAllowed: boolean;
  /** Permitted, but the platform suppresses reach for posts carrying an outbound link. */
  linkPenalty?: boolean;
  /** Platform cap on tags/topics/hashtags. Absent means the platform sets no cap. */
  maxTags?: number;
  /** The channel rejects a post with no image or video attached. */
  mediaRequired?: boolean;
}

export interface ChannelAutomation {
  mode: AutomationMode;
  /** WHY, in one sentence. A policy fact, not an opinion. Required for every channel. */
  reason: string;
  /** The documented write API. Required whenever `mode` is 'api-publish'. */
  docsUrl?: string;
}

/** A draft shaped to one channel. The output of `adapt()`. */
export interface ChannelPost {
  channelKey: string;
  title?: string;
  body: string;
  tags: string[];
  /** Where a human goes to post it when mode is 'prepare-only'. */
  submitUrl?: string;
  /**
   * Everything a human has to read before this post goes out: one line per
   * adjustment `adapt()` made to the draft, plus every precondition the
   * platform imposes that Trevra cannot satisfy on its own (media assets,
   * choosing a subreddit). Empty means the draft is ready as written.
   */
  warnings: string[];
}

/** The channel-independent input: what the founder wants to say. */
export interface ChannelDraft {
  title: string;
  body: string;
  url?: string;
  tags?: string[];
}

export interface ChannelAdapter {
  key: string;
  name: string;
  homeUrl: string;
  /** Who is actually there. Drives audience-fit ranking. Free-form lowercase tags. */
  audience: string[];
  formats: ChannelFormat[];
  constraints: ChannelConstraints;
  automation: ChannelAutomation;
  enabledByDefault: boolean;
  /**
   * Seed values for the channel row's `config_json`, written on INSERT only.
   * Operator edits are never overwritten -- same rule as `config` on
   * `directory_crawl` in the Python reference registry.
   */
  defaultConfig?: Record<string, unknown>;
  /** Shape a draft to this channel's constraints. Pure, deterministic, no I/O. */
  adapt(draft: ChannelDraft): ChannelPost;
}
