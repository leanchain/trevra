import { describe, expect, it } from 'vitest';
import type { LinkedInLocator, LinkedInPage } from './driver.js';
import {
  COMMUNITY_SELECTORS,
  communityDestinationUrl,
  followCompany,
  inviteConnectionToEvent,
  likeCompanyRecentPost,
  messageGroupMember
} from './driver-community.js';

type Counts = Record<string, number>;

function fakePage(initial: Counts = {}, onClick?: (selector: string, counts: Counts) => void) {
  const counts = { ...initial };
  const clicked: string[] = [];
  let current = 'https://www.linkedin.com/feed/';
  const locator = (selector: string): LinkedInLocator => ({
    count: async () => counts[selector] ?? 0,
    first: () => locator(selector),
    click: async () => {
      clicked.push(selector);
      onClick?.(selector, counts);
    },
    fill: async () => {},
    textContent: async () => null
  });
  const page: LinkedInPage = {
    goto: async (url) => {
      current = url;
      return null;
    },
    url: () => current,
    locator,
    waitForTimeout: async () => {}
  };
  return { page, counts, clicked };
}

describe('community destination validation', () => {
  it('accepts only the expected LinkedIn destination family', () => {
    expect(communityDestinationUrl('company', 'https://www.linkedin.com/company/acme/posts/')).toBe(
      'https://www.linkedin.com/company/acme/'
    );
    expect(
      communityDestinationUrl('event', 'https://www.linkedin.com/events/acme-123/about/')
    ).toBe('https://www.linkedin.com/events/acme-123/');
    expect(communityDestinationUrl('group', 'https://evil.example/groups/1/')).toBeNull();
  });
});

describe('company engagement', () => {
  it('follows a company only after the control visibly flips', async () => {
    const fake = fakePage({ [COMMUNITY_SELECTORS.companyFollow]: 1 }, (selector, counts) => {
      if (selector === COMMUNITY_SELECTORS.companyFollow) {
        counts[COMMUNITY_SELECTORS.companyFollow] = 0;
        counts[COMMUNITY_SELECTORS.companyFollowing] = 1;
      }
    });
    expect((await followCompany(fake.page, 'https://www.linkedin.com/company/acme/')).ok).toBe(
      true
    );
  });

  it('likes only a visible latest company post and verifies the reaction', async () => {
    const fake = fakePage(
      { [COMMUNITY_SELECTORS.companyPost]: 1, [COMMUNITY_SELECTORS.companyLike]: 1 },
      (selector, counts) => {
        if (selector === COMMUNITY_SELECTORS.companyLike) {
          counts[COMMUNITY_SELECTORS.companyLike] = 0;
          counts[COMMUNITY_SELECTORS.companyLiked] = 1;
        }
      }
    );
    expect(
      (await likeCompanyRecentPost(fake.page, 'https://www.linkedin.com/company/acme/')).ok
    ).toBe(true);
  });
});

describe('community invites and messages', () => {
  it('sends an event invitation only after selecting the exact target and seeing confirmation', async () => {
    const target = 'a[href*="/in/maya"]';
    const dialogTarget = `div[role="dialog"] ${target}`;
    const checkbox = `div[role="dialog"] li:has(${target}) input[type="checkbox"], div[role="dialog"] li:has(${target}) label, div[role="dialog"] div:has(${target}) input[type="checkbox"]`;
    const fake = fakePage(
      {
        [COMMUNITY_SELECTORS.eventInvite]: 1,
        [dialogTarget]: 1,
        [checkbox]: 1,
        [COMMUNITY_SELECTORS.modalSend]: 1
      },
      (selector, counts) => {
        if (selector === COMMUNITY_SELECTORS.eventInvite) counts[COMMUNITY_SELECTORS.dialog] = 1;
        if (selector === COMMUNITY_SELECTORS.modalSend)
          counts[COMMUNITY_SELECTORS.inviteSuccess] = 1;
      }
    );
    const result = await inviteConnectionToEvent(
      fake.page,
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/events/acme-123/'
    );
    expect(result.ok).toBe(true);
    expect(fake.clicked).toEqual([
      COMMUNITY_SELECTORS.eventInvite,
      checkbox,
      COMMUNITY_SELECTORS.modalSend
    ]);
  });

  it('sends from the visible group-member Message surface and verifies the send', async () => {
    const target = 'a[href*="/in/maya"]';
    const message = `li:has(${target}) button:has-text("Message"), div:has(> ${target}) button:has-text("Message")`;
    const fake = fakePage(
      {
        [target]: 1,
        [message]: 1,
        [COMMUNITY_SELECTORS.memberMessageComposer]: 1,
        [COMMUNITY_SELECTORS.memberMessageSend]: 1
      },
      (selector, counts) => {
        if (selector === COMMUNITY_SELECTORS.memberMessageSend)
          counts[COMMUNITY_SELECTORS.messageSuccess] = 1;
      }
    );
    const result = await messageGroupMember(
      fake.page,
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/groups/123/',
      'Approved body'
    );
    expect(result.ok).toBe(true);
    expect(fake.clicked).toEqual([message, COMMUNITY_SELECTORS.memberMessageSend]);
  });

  it('gracefully skips an event invite when the seat has no invite privilege', async () => {
    const fake = fakePage();
    const result = await inviteConnectionToEvent(
      fake.page,
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/events/acme-123/'
    );
    expect(result.failureKind).toBe('not_found');
    expect(fake.clicked).toEqual([]);
  });

  it('never falls back to a profile DM when group messaging is unavailable', async () => {
    const profile = 'a[href*="/in/maya"]';
    const fake = fakePage({ [profile]: 1 });
    const result = await messageGroupMember(
      fake.page,
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/groups/123/',
      'Approved body'
    );
    expect(result.failureKind).toBe('not_found');
    expect(fake.clicked).toEqual([]);
  });
});
