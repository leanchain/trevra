import { describe, expect, it } from 'vitest';
import { listChannels, listEnabled } from './registry.js';
import { instagramChannel } from './adapters/instagram.js';
import { hackernewsChannel, SHOW_HN_PREFIX } from './adapters/hackernews.js';
import { REDDIT_SUBREDDITS, redditChannel } from './adapters/reddit.js';
import { linkedinChannel } from './adapters/linkedin.js';
import type { ChannelAdapter } from './types.js';

const ALL = listChannels();

/** A body of exactly `chars` characters made of real words, so word-boundary cutting has something to cut on. */
function filler(chars: number): string {
  const word = 'distribution ';
  return word.repeat(Math.ceil(chars / word.length)).slice(0, chars).trim();
}

const baseDraft = { title: 'Trevra 0.4 ships distribution channels', body: 'Trevra 0.4 ships distribution channels.' };

describe('the registry is populated', () => {
  it('registers every curated channel', () => {
    expect(ALL.map((channel) => channel.key)).toEqual([
      'bluesky',
      'devto',
      'github',
      'hackernews',
      'hashnode',
      'indiehackers',
      'instagram',
      'linkedin',
      'lobsters',
      'mastodon',
      'producthunt',
      'reddit',
      'x'
    ]);
  });
});

// The policy invariants. These are the reason this module exists: a channel that
// over-claims automation gets a user's account banned, so the claim is checked
// mechanically for every channel, including ones added after this file was written.
describe('automation policy invariants', () => {
  for (const channel of ALL) {
    it(`${channel.key} states why its automation mode is what it is`, () => {
      expect(channel.automation.reason.trim().length).toBeGreaterThan(0);
      // A reason is a sentence of policy, not a label.
      expect(channel.automation.reason.split(/\s+/).length).toBeGreaterThan(5);
    });

    it(`${channel.key} declares a mode the contract knows about`, () => {
      expect(['api-publish', 'prepare-only', 'disabled']).toContain(channel.automation.mode);
    });

    if (channel.automation.mode === 'prepare-only') {
      it(`${channel.key} tells a human where to go and post it`, () => {
        const post = channel.adapt(baseDraft);
        expect(post.submitUrl).toBeTruthy();
        expect(post.submitUrl).toMatch(/^https:\/\//);
      });
    }

    if (channel.automation.mode === 'api-publish') {
      it(`${channel.key} cites the write API it claims to have`, () => {
        expect(channel.automation.docsUrl).toBeTruthy();
        expect(channel.automation.docsUrl).toMatch(/^https:\/\//);
      });
    }
  }

  it('never claims api-publish without a docsUrl', () => {
    const unproven = ALL.filter((channel) => channel.automation.mode === 'api-publish' && !channel.automation.docsUrl);
    expect(unproven.map((channel) => channel.key)).toEqual([]);
  });

  it('gives every prepare-only channel a submitUrl', () => {
    const stranded = ALL.filter(
      (channel) => channel.automation.mode === 'prepare-only' && !channel.adapt(baseDraft).submitUrl
    );
    expect(stranded.map((channel) => channel.key)).toEqual([]);
  });

  // Every key on this list was checked against the platform's own live docs.
  // Hashnode was drafted here and removed: gql.hashnode.com now says free API
  // access is retired and publishing needs a paid Pro plan.
  it('biases hard toward prepare-only', () => {
    const apiPublish = ALL.filter((channel) => channel.automation.mode === 'api-publish').map((c) => c.key);
    expect(apiPublish).toEqual(['bluesky', 'devto', 'github', 'mastodon']);
    expect(ALL.filter((channel) => channel.automation.mode === 'prepare-only')).toHaveLength(9);
  });

  it('keeps hashnode prepare-only while its write API is behind a paid plan', () => {
    const hashnode = ALL.find((channel) => channel.key === 'hashnode')!;
    expect(hashnode.automation.mode).toBe('prepare-only');
    expect(hashnode.automation.reason).toContain('paid Pro plan');
  });

  it('leaves Instagram off by default because a caption cannot carry a link', () => {
    expect(instagramChannel.enabledByDefault).toBe(false);
    expect(listEnabled().map((channel) => channel.key)).not.toContain('instagram');
  });
});

describe('every adapter respects its own constraints', () => {
  for (const channel of ALL) {
    const { maxChars, maxTitleChars, maxTags } = channel.constraints;

    it(`${channel.key} truncates to ${maxChars} chars and warns`, () => {
      const post = channel.adapt({ ...baseDraft, body: filler(maxChars + 500) });
      expect(post.body.length).toBeLessThanOrEqual(maxChars);
      expect(post.warnings.some((warning) => warning.includes(`${maxChars}-character ${channel.key} limit`))).toBe(true);
    });

    it(`${channel.key} leaves a body that already fits alone`, () => {
      const post = channel.adapt(baseDraft);
      expect(post.body).toContain('Trevra 0.4 ships distribution channels.');
      expect(post.warnings.some((warning) => warning.includes('Body truncated'))).toBe(false);
    });

    if (maxTitleChars !== undefined) {
      it(`${channel.key} truncates a title to ${maxTitleChars} chars and warns`, () => {
        const post = channel.adapt({ ...baseDraft, title: filler(maxTitleChars + 200) });
        expect(post.title).toBeDefined();
        expect(post.title!.length).toBeLessThanOrEqual(maxTitleChars);
        expect(post.warnings.some((warning) => warning.includes('Title truncated'))).toBe(true);
      });
    }

    if (maxTags !== undefined) {
      it(`${channel.key} caps tags at ${maxTags} and warns`, () => {
        const tags = Array.from({ length: maxTags + 3 }, (_, index) => `tag${index}`);
        const post = channel.adapt({ ...baseDraft, tags });
        expect(post.tags).toHaveLength(maxTags);
        expect(post.tags).toEqual(tags.slice(0, maxTags));
        expect(post.warnings.some((warning) => warning.includes(`at most ${maxTags} tag(s)`))).toBe(true);
      });
    } else {
      it(`${channel.key} keeps every tag because the platform caps none`, () => {
        const tags = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
        expect(channel.adapt({ ...baseDraft, tags }).tags).toEqual(tags);
      });
    }

    it(`${channel.key} adapt() is pure and deterministic`, () => {
      const draft = { ...baseDraft, url: 'https://trevra.dev', tags: ['launch', 'open-source'] };
      expect(channel.adapt(draft)).toEqual(channel.adapt(draft));
    });

    it(`${channel.key} carries its own key on the post`, () => {
      expect(channel.adapt(baseDraft).channelKey).toBe(channel.key);
    });
  }
});

describe('instagram', () => {
  const draft = {
    title: 'Trevra 0.4',
    body: 'Trevra 0.4 is out. Read the notes at https://trevra.dev/releases before you upgrade.',
    url: 'https://trevra.dev',
    tags: ['#Launch', 'launch', 'Open-Source']
  };

  it('strips links from the body and says what it removed', () => {
    const post = instagramChannel.adapt(draft);
    expect(post.body).not.toContain('http');
    expect(post.body).toBe('Trevra 0.4 is out. Read the notes at before you upgrade.');
    expect(post.warnings.some((warning) => warning.includes('https://trevra.dev/releases'))).toBe(true);
  });

  it('refuses to append the draft URL and says so', () => {
    const post = instagramChannel.adapt(draft);
    expect(post.warnings.some((warning) => warning.includes('https://trevra.dev was left out'))).toBe(true);
  });

  it('declares links unusable rather than merely penalised', () => {
    expect(instagramChannel.constraints.linksAllowed).toBe(false);
    expect(instagramChannel.constraints.mediaRequired).toBe(true);
  });

  it('warns that the post needs media it cannot produce', () => {
    const post = instagramChannel.adapt(draft);
    expect(post.warnings.some((warning) => warning.includes('no image or video'))).toBe(true);
  });
});

describe('hacker news', () => {
  it('prefixes a Show HN title and says it did', () => {
    const post = hackernewsChannel.adapt(baseDraft);
    expect(post.title!.startsWith(SHOW_HN_PREFIX)).toBe(true);
    expect(post.warnings.some((warning) => warning.includes('Show HN'))).toBe(true);
  });

  it('leaves an existing Show HN prefix alone', () => {
    const post = hackernewsChannel.adapt({ ...baseDraft, title: 'Show HN: Trevra, a revenue chief of staff' });
    expect(post.title).toBe('Show HN: Trevra, a revenue chief of staff');
    expect(post.warnings.some((warning) => warning.includes('Prefixed'))).toBe(false);
  });
});

describe('reddit', () => {
  it('seeds the subreddit config a human has to choose from', () => {
    expect(REDDIT_SUBREDDITS).toEqual(['r/SaaS', 'r/Entrepreneur', 'r/ecommerce', 'r/shopify', 'r/selfhosted', 'r/opensource']);
    expect(redditChannel.defaultConfig).toEqual({ subreddits: [...REDDIT_SUBREDDITS] });
  });

  it('names those subreddits in the warnings a human reads', () => {
    const post = redditChannel.adapt(baseDraft);
    expect(post.warnings.some((warning) => warning.includes('r/selfhosted'))).toBe(true);
  });
});

describe('linkedin', () => {
  it('flags the outbound-link reach penalty', () => {
    expect(linkedinChannel.constraints.linkPenalty).toBe(true);
    const post = linkedinChannel.adapt({ ...baseDraft, url: 'https://trevra.dev' });
    expect(post.warnings.some((warning) => warning.includes('suppresses reach'))).toBe(true);
  });
});

describe('the contract every adapter file has to satisfy', () => {
  const required: Array<keyof ChannelAdapter> = [
    'key',
    'name',
    'homeUrl',
    'audience',
    'formats',
    'constraints',
    'automation',
    'enabledByDefault',
    'adapt'
  ];

  for (const channel of ALL) {
    it(`${channel.key} fills in the whole contract`, () => {
      for (const field of required) expect(channel[field]).toBeDefined();
      expect(channel.audience.length).toBeGreaterThan(0);
      expect(channel.audience).toEqual(channel.audience.map((tag) => tag.toLowerCase()));
      expect(channel.formats.length).toBeGreaterThan(0);
      expect(channel.homeUrl).toMatch(/^https:\/\//);
      expect(channel.constraints.maxChars).toBeGreaterThan(0);
    });
  }
});
