import { describe, expect, it } from 'vitest';
import { viewProfile, type LinkedInLocator, type LinkedInPage } from './driver.js';

/**
 * HOW A PROFILE IS REACHED, which is a different question from what happens
 * once it is open.
 *
 * LinkedIn is a single-page app. A member who clicks a profile link gets a
 * client-side route: no document load, a referer, and a view chain tying the
 * profile to whatever they were looking at before. A `page.goto` gets a cold
 * document load of a stranger's profile with nothing in front of it, which is
 * what working from a list of URLs looks like from the server's side --
 * because that is what it is. So the driver clicks a link when the page it is
 * already on has one, and only reaches for the address bar when it does not.
 */

const TARGET = 'https://www.linkedin.com/in/some-person/';

function fakePage(options: { startAt: string; linkOnPage: boolean }): {
  page: LinkedInPage;
  navigations: string[];
  clicked: string[];
} {
  const navigations: string[] = [];
  const clicked: string[] = [];
  let current = options.startAt;

  const locator = (selector: string): LinkedInLocator => {
    const isTargetLink = options.linkOnPage && selector === 'a[href*="/in/some-person"]';
    const self: LinkedInLocator = {
      count: async () => (isTargetLink ? 1 : 0),
      first: () => self,
      click: async () => {
        clicked.push(selector);
        // What the SPA router does: the URL changes, no document is loaded.
        if (isTargetLink) current = TARGET;
      },
      fill: async () => {},
      textContent: async () => null
    };
    return self;
  };

  return {
    navigations,
    clicked,
    page: {
      goto: async (url: string) => {
        navigations.push(url);
        current = url;
        return null;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    }
  };
}

describe('reaching a profile', () => {
  it('clicks a link that is already on the page instead of loading the URL cold', async () => {
    const { page, navigations, clicked } = fakePage({ startAt: 'https://www.linkedin.com/feed/', linkOnPage: true });

    const result = await viewProfile(page, TARGET);

    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe(TARGET);
    expect(clicked).toContain('a[href*="/in/some-person"]');
    // THE ASSERTION THAT MATTERS: no document load happened at all.
    expect(navigations).toEqual([]);
  });

  it('falls back to the address bar when the page shows no link to the target', async () => {
    const { page, navigations, clicked } = fakePage({ startAt: 'https://www.linkedin.com/feed/', linkOnPage: false });

    const result = await viewProfile(page, TARGET);

    expect(result.ok).toBe(true);
    expect(clicked).toEqual([]);
    expect(navigations).toEqual([TARGET]);
  });

  it('does not look for a link when the browser is not on LinkedIn yet', async () => {
    // `about:blank` is where a freshly opened context sits. There is nothing to
    // click on it, and asking would be a locator call against a blank page.
    const { page, navigations } = fakePage({ startAt: 'about:blank', linkOnPage: true });

    await viewProfile(page, TARGET);

    expect(navigations).toEqual([TARGET]);
  });
});
