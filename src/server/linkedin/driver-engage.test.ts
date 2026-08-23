import { describe, expect, it } from 'vitest';
import {
  SELECTORS,
  type LinkedInDriverResult,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import {
  ENGAGE_SELECTORS,
  disconnectProfile,
  endorseSkills,
  engageGapMs,
  followProfile,
  likeRecentPost,
  unfollowProfile,
  type EngageOptions
} from './driver-engage.js';

/**
 * NO BROWSER IS LAUNCHED HERE AND NO LINKEDIN REQUEST IS MADE, EVER.
 *
 * The same rule `local-worker.test.ts` states for the same reason: a suite that
 * touched a real account would spend that account's daily budget on CI, and
 * the ceilings this subsystem exists to respect are per human, not per test
 * run. The page below is a counter table -- a selector maps to how many
 * elements match it, and a click mutates the table the way LinkedIn's own
 * client would.
 *
 * What is asserted is the contract `driver.ts` sets and this file inherits:
 * every path returns a result, a miss on a control we were about to click is
 * `selector_drift`, anything after a click is `unknown`, and a wall outranks
 * everything.
 */

const TARGET = 'https://www.linkedin.com/in/jane-doe/?trk=nav_search';
const PROFILE = 'https://www.linkedin.com/in/jane-doe/';
const FEED = `${PROFILE}recent-activity/all/`;
const SKILLS = `${PROFILE}details/skills/`;

type Counts = Record<string, number>;

interface FakeSpec {
  counts?: Counts;
  /** The URL the browser actually ends up on. Defaults to the requested one. */
  landOn?: (url: string) => string;
  gotoError?: string;
  clickError?: string;
  texts?: Record<string, string | null>;
  onClick?: (selector: string, counts: Counts, texts: Record<string, string | null>) => void;
}

function fakePage(spec: FakeSpec = {}) {
  const counts: Counts = { ...(spec.counts ?? {}) };
  const texts: Record<string, string | null> = { ...(spec.texts ?? {}) };
  const visited: string[] = [];
  const clicked: string[] = [];
  const slept: number[] = [];
  let current = 'https://www.linkedin.com/feed/';

  const locator = (selector: string): LinkedInLocator => ({
    count: async () => counts[selector] ?? 0,
    first: () => locator(selector),
    click: async () => {
      clicked.push(selector);
      if (spec.clickError) throw new Error(spec.clickError);
      spec.onClick?.(selector, counts, texts);
    },
    fill: async () => {
      throw new Error('an engagement routine must never fill a field');
    },
    textContent: async () => texts[selector] ?? null
  });

  const page: LinkedInPage = {
    goto: async (url) => {
      visited.push(url);
      if (spec.gotoError) throw new Error(spec.gotoError);
      current = spec.landOn ? spec.landOn(url) : url;
      return null;
    },
    url: () => current,
    locator,
    waitForTimeout: async () => {}
  };

  const sleep = async (ms: number) => {
    slept.push(ms);
  };

  return { page, counts, visited, clicked, slept, sleep };
}

describe('target resolution', () => {
  it('refuses a non-LinkedIn target without navigating anywhere', async () => {
    const routines: Array<
      (page: LinkedInPage, target: string, opts: EngageOptions) => Promise<LinkedInDriverResult>
    > = [followProfile, unfollowProfile, disconnectProfile, likeRecentPost, endorseSkills];
    for (const routine of routines) {
      const fake = fakePage();
      const result = await routine(fake.page, 'https://evil.example/steal', { sleep: fake.sleep });
      expect(result.ok).toBe(false);
      expect(result.failureKind).toBe('not_found');
      expect(fake.visited).toEqual([]);
    }
  });

  it('reduces a profile URL with query junk to the canonical form before appending sub-pages', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.activityPost]: 1, [ENGAGE_SELECTORS.firstPostLike]: 1 }
    });
    await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(fake.visited).toEqual([FEED]);

    const skills = fakePage({ counts: { [ENGAGE_SELECTORS.endorseButton]: 1 } });
    await endorseSkills(skills.page, TARGET, { sleep: skills.sleep });
    expect(skills.visited).toEqual([SKILLS]);
  });

  it('reports a navigation failure as drift, because nothing was clicked', async () => {
    const fake = fakePage({ gotoError: 'net::ERR_TIMED_OUT' });
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('selector_drift');
    expect(fake.clicked).toEqual([]);
  });
});

describe('followProfile', () => {
  it('follows from the primary action bar and confirms the state flip', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followButton]: 1 },
      onClick: (selector, counts) => {
        if (selector === ENGAGE_SELECTORS.followButton) {
          counts[ENGAGE_SELECTORS.followButton] = 0;
          counts[ENGAGE_SELECTORS.followingState] = 1;
        }
      }
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.ok).toBe(true);
    expect(result.failureKind).toBeNull();
    expect(result.externalRef).toBe(PROFILE);
    expect(fake.visited).toEqual([PROFILE]);
  });

  it('finds Follow behind the More menu when it is not on the action bar', async () => {
    const fake = fakePage({
      counts: { [SELECTORS.moreActionsButton]: 1 },
      onClick: (selector, counts) => {
        if (selector === SELECTORS.moreActionsButton) counts[ENGAGE_SELECTORS.followInMoreMenu] = 1;
        if (selector === ENGAGE_SELECTORS.followInMoreMenu)
          counts[ENGAGE_SELECTORS.followingState] = 1;
      }
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.ok).toBe(true);
    expect(fake.clicked).toEqual([SELECTORS.moreActionsButton, ENGAGE_SELECTORS.followInMoreMenu]);
  });

  // The silent failure mode this selector table is shaped around: the Follow
  // and Following controls share an aria-label prefix, so a naive selector
  // UNFOLLOWS somebody. Reading the state first is what prevents it.
  it('never clicks anything when the seat already follows the target', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followingState]: 1, [ENGAGE_SELECTORS.followButton]: 1 }
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('already_connected');
    expect(fake.clicked).toEqual([]);
  });

  it('reports drift, not failure, when neither Follow nor More is on the page', async () => {
    const fake = fakePage();
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('selector_drift');
    expect(fake.clicked).toEqual([]);
  });

  it('reports the wall LinkedIn answers the click with, not a generic failure', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followButton]: 1 },
      onClick: (_selector, counts) => {
        counts[SELECTORS.restrictionNotice] = 1;
      }
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('limit_wall');
  });

  it('reports a challenge read on load before any control is touched', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followButton]: 1 },
      landOn: () => 'https://www.linkedin.com/checkpoint/challengesV2/abc'
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('challenge');
    expect(fake.clicked).toEqual([]);
  });

  it('is unknown, not ok, when the button never flips to Following', async () => {
    const fake = fakePage({ counts: { [ENGAGE_SELECTORS.followButton]: 1 } });
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('unknown');
  });

  it('is unknown when the click itself is interrupted', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followButton]: 1 },
      clickError: 'Target closed'
    });
    const result = await followProfile(fake.page, TARGET);
    expect(result.failureKind).toBe('unknown');
  });
});

describe('profile cleanup actions', () => {
  it('unfollows only when the current following state is visible and verifies the reversal', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.followingState]: 1 },
      onClick: (selector, counts) => {
        if (selector === ENGAGE_SELECTORS.followingState) {
          counts[ENGAGE_SELECTORS.followingState] = 0;
          counts[ENGAGE_SELECTORS.followButton] = 1;
        }
      }
    });
    const result = await unfollowProfile(fake.page, TARGET);
    expect(result).toMatchObject({ ok: true, failureKind: null, externalRef: PROFILE });
    expect(fake.clicked).toEqual([ENGAGE_SELECTORS.followingState]);
  });

  it('treats an already-unfollowed profile as a definite no-op', async () => {
    const fake = fakePage({ counts: { [ENGAGE_SELECTORS.followButton]: 1 } });
    const result = await unfollowProfile(fake.page, TARGET);
    expect(result).toMatchObject({ ok: false, failureKind: 'not_found' });
    expect(fake.clicked).toEqual([]);
  });

  it('refuses disconnect before clicking when 1st-degree eligibility cannot be proven', async () => {
    const unreadable = fakePage({ counts: { [SELECTORS.degreeBadge]: 1 } });
    expect(await disconnectProfile(unreadable.page, TARGET)).toMatchObject({
      ok: false,
      failureKind: 'selector_drift'
    });
    expect(unreadable.clicked).toEqual([]);

    const second = fakePage({
      counts: { [SELECTORS.degreeBadge]: 1 },
      texts: { [SELECTORS.degreeBadge]: '2nd' }
    });
    expect(await disconnectProfile(second.page, TARGET)).toMatchObject({
      ok: false,
      failureKind: 'not_found'
    });
    expect(second.clicked).toEqual([]);
  });

  it('disconnects only after verified 1st-degree, More-menu and confirmation controls', async () => {
    const fake = fakePage({
      counts: { [SELECTORS.degreeBadge]: 1, [SELECTORS.moreActionsButton]: 1 },
      texts: { [SELECTORS.degreeBadge]: '1st' },
      onClick: (selector, counts, texts) => {
        if (selector === SELECTORS.moreActionsButton)
          counts[ENGAGE_SELECTORS.removeConnectionInMoreMenu] = 1;
        if (selector === ENGAGE_SELECTORS.removeConnectionInMoreMenu)
          counts[ENGAGE_SELECTORS.removeConnectionConfirm] = 1;
        if (selector === ENGAGE_SELECTORS.removeConnectionConfirm)
          texts[SELECTORS.degreeBadge] = '2nd';
      }
    });
    const result = await disconnectProfile(fake.page, TARGET);
    expect(result).toMatchObject({ ok: true, failureKind: null, externalRef: PROFILE });
    expect(fake.clicked).toEqual([
      SELECTORS.moreActionsButton,
      ENGAGE_SELECTORS.removeConnectionInMoreMenu,
      ENGAGE_SELECTORS.removeConnectionConfirm
    ]);
  });

  it('holds ambiguity after the destructive disconnect control rather than retrying', async () => {
    const fake = fakePage({
      counts: { [SELECTORS.degreeBadge]: 1, [SELECTORS.moreActionsButton]: 1 },
      texts: { [SELECTORS.degreeBadge]: '1st' },
      onClick: (selector, counts) => {
        if (selector === SELECTORS.moreActionsButton)
          counts[ENGAGE_SELECTORS.removeConnectionInMoreMenu] = 1;
      }
    });
    expect(await disconnectProfile(fake.page, TARGET)).toMatchObject({
      ok: false,
      failureKind: 'unknown'
    });
  });
});

describe('likeRecentPost', () => {
  const withPost = (extra: Counts = {}): Counts => ({
    [ENGAGE_SELECTORS.activityPost]: 3,
    [ENGAGE_SELECTORS.firstPostLike]: 1,
    ...extra
  });

  it('likes the most recent post and confirms the reaction', async () => {
    const fake = fakePage({
      counts: withPost(),
      onClick: (selector, counts) => {
        if (selector === ENGAGE_SELECTORS.firstPostLike) {
          counts[ENGAGE_SELECTORS.firstPostLike] = 0;
          counts[ENGAGE_SELECTORS.firstPostLiked] = 1;
        }
      }
    });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe(PROFILE);
    expect(fake.clicked).toEqual([ENGAGE_SELECTORS.firstPostLike]);
  });

  // The common case. It must read as "there was nothing to do", never as a
  // fault an operator should go and look at.
  it('reports an empty activity feed as an ordinary not_found, worded as one', async () => {
    const fake = fakePage();
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('not_found');
    expect(result.detail).toContain('nothing to like');
    expect(result.detail).toContain('not a fault');
    expect(result.detail).toMatch(/ordinary outcome/i);
    expect(result.detail).not.toMatch(/error|failed|could not/i);
    expect(fake.clicked).toEqual([]);
  });

  it("believes LinkedIn's own empty-feed wording over a post container match", async () => {
    const fake = fakePage({ counts: withPost({ [ENGAGE_SELECTORS.activityEmpty]: 1 }) });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('not_found');
    expect(fake.clicked).toEqual([]);
  });

  it('does not react twice to the same post', async () => {
    const fake = fakePage({ counts: withPost({ [ENGAGE_SELECTORS.firstPostLiked]: 1 }) });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('already_connected');
    expect(fake.clicked).toEqual([]);
  });

  it('reports drift when the post is there and its Like control is not', async () => {
    const fake = fakePage({ counts: { [ENGAGE_SELECTORS.activityPost]: 2 } });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('selector_drift');
    expect(fake.clicked).toEqual([]);
  });

  it('is unknown when the reaction never registers', async () => {
    const fake = fakePage({ counts: withPost() });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('unknown');
  });

  it('reports the wall LinkedIn answers the reaction with', async () => {
    const fake = fakePage({
      counts: withPost(),
      onClick: (_selector, counts) => {
        counts[SELECTORS.limitWall] = 1;
      }
    });
    const result = await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('limit_wall');
  });

  it('does not add a synthetic pre-click pause before reacting', async () => {
    const fake = fakePage({ counts: withPost() });
    await likeRecentPost(fake.page, TARGET, { sleep: fake.sleep, seed: 'batch-1:action-1' });
    expect(fake.slept).toEqual([]);
    expect(engageGapMs('batch-1:action-1')).toBe(0);
  });
});

describe('endorseSkills', () => {
  /** A page listing `n` un-endorsed skills; each click endorses one. */
  function skillsPage(n: number, extra: FakeSpec = {}) {
    return fakePage({
      counts: { [ENGAGE_SELECTORS.endorseButton]: n },
      onClick: (selector, counts) => {
        if (selector === ENGAGE_SELECTORS.endorseButton) {
          counts[ENGAGE_SELECTORS.endorseButton] = Math.max(
            0,
            (counts[ENGAGE_SELECTORS.endorseButton] ?? 0) - 1
          );
        }
        extra.onClick?.(selector, counts, {});
      },
      ...(extra.landOn ? { landOn: extra.landOn } : {})
    });
  }

  it('endorses exactly one skill per ledger action', async () => {
    const fake = skillsPage(9);
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe(PROFILE);
    expect(fake.clicked).toHaveLength(1);
    expect(result.detail).toContain('Endorsed 1 of the 9');
  });

  it('clamps every requested skill count to one externally visible endorsement', async () => {
    const one = skillsPage(9);
    await endorseSkills(one.page, TARGET, { sleep: one.sleep, limit: 1 });
    expect(one.clicked).toHaveLength(1);

    const many = skillsPage(40);
    await endorseSkills(many.page, TARGET, { sleep: many.sleep, limit: 99 });
    expect(many.clicked).toHaveLength(1);

    const zero = skillsPage(9);
    await endorseSkills(zero.page, TARGET, { sleep: zero.sleep, limit: 0 });
    expect(zero.clicked).toHaveLength(1);
  });

  it('still performs only one endorsement when several skills are available', async () => {
    const fake = skillsPage(2);
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.ok).toBe(true);
    expect(fake.clicked).toHaveLength(1);
  });

  it('reports a profile with no listed skills as an ordinary not_found', async () => {
    const fake = fakePage();
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('not_found');
    expect(result.detail).toContain('nothing to endorse');
    expect(result.detail).toContain('not a fault');
    expect(fake.clicked).toEqual([]);
  });

  it('reports a fully endorsed profile as nothing left to send', async () => {
    const fake = fakePage({ counts: { [ENGAGE_SELECTORS.endorsedState]: 5 } });
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('already_connected');
    expect(fake.clicked).toEqual([]);
  });

  it('dismisses the proficiency dialog rather than answering it', async () => {
    const fake = skillsPage(5, {
      onClick: (selector, counts) => {
        if (selector === ENGAGE_SELECTORS.endorseButton)
          counts[ENGAGE_SELECTORS.endorseDialogDismiss] = 1;
        if (selector === ENGAGE_SELECTORS.endorseDialogDismiss)
          counts[ENGAGE_SELECTORS.endorseDialogDismiss] = 0;
      }
    });
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep, limit: 2 });
    expect(result.ok).toBe(true);
    expect(
      fake.clicked.filter((entry) => entry === ENGAGE_SELECTORS.endorseDialogDismiss)
    ).toHaveLength(1);
  });

  it('adds no synthetic sleep inside an endorsement action', async () => {
    const fake = skillsPage(5);
    await endorseSkills(fake.page, TARGET, {
      sleep: fake.sleep,
      seed: 'batch-2:action-7',
      limit: 3
    });
    expect(fake.slept).toEqual([]);
    expect(engageGapMs('batch-2:action-7:1')).toBe(0);
  });

  it('reports a mid-loop wall with the count that already registered', async () => {
    const fake = skillsPage(5, {
      onClick: (_selector, counts) => {
        if ((counts[ENGAGE_SELECTORS.endorseButton] ?? 0) <= 4) counts[SELECTORS.challengeForm] = 1;
      }
    });
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('challenge');
    expect(result.detail).toContain('after 0');
  });

  it('is unknown when a click leaves the control count unchanged', async () => {
    const fake = fakePage({ counts: { [ENGAGE_SELECTORS.endorseButton]: 4 } });
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('unknown');
    expect(fake.clicked).toHaveLength(1);
  });

  it('is unknown when a click is interrupted, and says how many had registered', async () => {
    const fake = fakePage({
      counts: { [ENGAGE_SELECTORS.endorseButton]: 4 },
      clickError: 'Target closed'
    });
    const result = await endorseSkills(fake.page, TARGET, { sleep: fake.sleep });
    expect(result.failureKind).toBe('unknown');
    expect(result.detail).toContain('0 endorsement(s)');
  });
});

describe('intra-action spacing', () => {
  it('does not synthesize engagement timing from a seed', () => {
    expect(engageGapMs('a')).toBe(0);
    expect(engageGapMs('b')).toBe(0);
  });
});
