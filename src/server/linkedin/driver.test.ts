import { describe, expect, it } from 'vitest';
import {
  SELECTORS,
  isDegreeRead,
  isLoggedIn,
  parseConnectionDegree,
  parseConnectionsCount,
  readProfileDegree,
  readSeat,
  viewProfile,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';

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

describe('isLoggedIn', () => {
  const emptyLocator = (): LinkedInLocator => {
    const self: LinkedInLocator = {
      count: async () => 0,
      first: () => self,
      click: async () => {},
      fill: async () => {},
      textContent: async () => null
    };
    return self;
  };

  it('recognises the signed-in EU connect-services interstitial without choosing a privacy preference', async () => {
    const navigations: string[] = [];
    let current = 'https://www.linkedin.com/connect-services/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F';
    const page: LinkedInPage = {
      goto: async (url: string) => {
        navigations.push(url);
        if (url === 'https://www.linkedin.com/feed/') {
          current = 'https://www.linkedin.com/connect-services/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F';
        } else if (url === 'https://www.linkedin.com/in/me/') {
          current = 'https://www.linkedin.com/in/david-hasan-b77a33429/?isSelfProfile=true';
        } else {
          current = url;
        }
        return null;
      },
      url: () => current,
      locator: emptyLocator,
      waitForTimeout: async () => {}
    };

    expect(await isLoggedIn(page)).toBe(true);
    expect(navigations).toEqual([
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/me/'
    ]);
  });

  it('keeps the normal feed probe profile-free', async () => {
    const navigations: string[] = [];
    let current = 'https://www.linkedin.com/feed/';
    const page: LinkedInPage = {
      goto: async (url: string) => {
        navigations.push(url);
        current = url;
        return null;
      },
      url: () => current,
      locator: emptyLocator,
      waitForTimeout: async () => {}
    };

    expect(await isLoggedIn(page)).toBe(true);
    expect(navigations).toEqual(['https://www.linkedin.com/feed/']);
    expect(navigations).not.toContain('https://www.linkedin.com/in/me/');
  });
});

/**
 * READING A RELATIONSHIP OFF A PROFILE.
 *
 * The one question the sent-invitations list cannot answer -- accepted,
 * declined, expired or withdrawn -- is answered by LinkedIn's own degree badge,
 * and the parse below is the whole of that answer. Its failure mode is the
 * subject of every test here: a badge this cannot read must come back NULL, so
 * the caller records "unknown" and leaves the ledger alone. Reading it as "not
 * connected" would file real acceptances as non-acceptances, in the one number
 * the pacing engine throttles on.
 */
describe('parseConnectionDegree', () => {
  it('reads the three ordinals in the shapes LinkedIn renders them', () => {
    expect(parseConnectionDegree('1st')).toBe(1);
    expect(parseConnectionDegree('· 1st')).toBe(1);
    expect(parseConnectionDegree('1st degree connection')).toBe(1);
    expect(parseConnectionDegree('2nd')).toBe(2);
    expect(parseConnectionDegree('3rd+')).toBe(3);
  });

  it('answers null for anything it does not understand, never a degree', () => {
    // A localised badge. The bound is documented rather than papered over: the
    // failure mode is "detects nothing", never "detects wrongly".
    expect(parseConnectionDegree('1er')).toBeNull();
    expect(parseConnectionDegree('1.')).toBeNull();
    expect(parseConnectionDegree('')).toBeNull();
    expect(parseConnectionDegree(null)).toBeNull();
    expect(parseConnectionDegree('Follow')).toBeNull();
  });
});

function degreePage(options: { badge?: string | null; pending?: boolean }): LinkedInPage {
  const locator = (selector: string): LinkedInLocator => {
    const isBadge = selector === SELECTORS.degreeBadge && options.badge !== undefined;
    const isPending = selector === SELECTORS.pendingInvite && options.pending === true;
    const self: LinkedInLocator = {
      count: async () => (isBadge || isPending ? 1 : 0),
      first: () => self,
      click: async () => {},
      fill: async () => {},
      textContent: async () => (isBadge ? options.badge ?? null : null)
    };
    return self;
  };
  let current = 'about:blank';
  return {
    goto: async (url: string) => {
      current = url;
      return null;
    },
    url: () => current,
    locator,
    waitForTimeout: async () => {}
  };
}

describe('readProfileDegree', () => {
  it('reports a 1st-degree connection, which is the only acceptance evidence there is', async () => {
    const read = await readProfileDegree(degreePage({ badge: '· 1st' }), TARGET);
    expect(isDegreeRead(read)).toBe(true);
    expect(read).toMatchObject({ ok: true, profileUrl: TARGET, degree: 1, pending: false });
  });

  it('reports a missing badge as an unread degree and says so in `degraded`', async () => {
    const read = await readProfileDegree(degreePage({}), TARGET);
    expect(isDegreeRead(read)).toBe(true);
    if (!isDegreeRead(read)) return;
    expect(read.degree).toBeNull();
    expect(read.degraded.join(' ')).toContain('connection-degree badge');
  });

  it('reports a still-pending invite, which outranks any reading of the list', async () => {
    const read = await readProfileDegree(degreePage({ badge: '2nd', pending: true }), TARGET);
    expect(read).toMatchObject({ ok: true, degree: 2, pending: true });
  });

  it('refuses a target that is not a LinkedIn profile rather than navigating to it', async () => {
    const read = await readProfileDegree(degreePage({ badge: '1st' }), 'https://evil.example/steal');
    expect(isDegreeRead(read)).toBe(false);
    expect(read).toMatchObject({ ok: false, failureKind: 'not_found' });
  });
});

/**
 * READING THE SEAT'S OWN ACCOUNT, against the page LinkedIn actually serves.
 *
 * Both of these were measured on a live seat and both came back empty:
 *
 *   - the profile page carries NO `h1` at all -- the name is a `<p>` under
 *     hashed class names -- so "the profile page has no readable heading";
 *   - the interface is in the MEMBER's language, so the connections header
 *     reads `1 Kontakt` and an English-only matcher reports "unknown".
 *
 * Neither is a LinkedIn fact about the account; both were Trevra reading the
 * wrong things. A partial read is still a success, so a wrong "unknown" is
 * quiet -- the screen just says Connections: Unknown forever.
 */
describe('readSeat', () => {
  const PROFILE = 'https://www.linkedin.com/in/david-hasan-b77a33429/';

  function seatPage(options: { heading?: string; title?: string; connectionsText?: string }): LinkedInPage {
    let current = 'https://www.linkedin.com/feed/';

    const matching = (selector: string): string | null => {
      const onConnections = current.includes('/connections');
      if (selector === SELECTORS.profileHeading) return onConnections ? null : (options.heading ?? null);
      if (selector === SELECTORS.connectionsCount) {
        // The English matcher, which is a text= selector: it only answers when
        // the words are there.
        return onConnections && /connections?/i.test(options.connectionsText ?? '') ? options.connectionsText! : null;
      }
      if (selector === SELECTORS.connectionsCountAny) {
        return onConnections && /^\s*[0-9][0-9.,   ]*\s+\S+\s*$/.test(options.connectionsText ?? '')
          ? options.connectionsText!
          : null;
      }
      return null;
    };

    const locator = (selector: string): LinkedInLocator => {
      const text = matching(selector);
      const self: LinkedInLocator = {
        count: async () => (text === null ? 0 : 1),
        first: () => self,
        click: async () => {},
        fill: async () => {},
        textContent: async () => text
      };
      return self;
    };

    return {
      goto: async (url: string) => {
        // `/in/me/` is a redirect for a signed-in member.
        current = url.endsWith('/in/me/') ? PROFILE : url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {},
      ...(options.title === undefined ? {} : { title: async () => options.title! })
    };
  }

  it('reads the name from the document title when the page has no heading', async () => {
    const read = await readSeat(seatPage({ title: '(3) David hasan | LinkedIn', connectionsText: '1 Kontakt' }));

    expect(read).toMatchObject({ ok: true, profileUrl: PROFILE, name: 'David hasan', connectionsCount: 1 });
    // Nothing was missed, so nothing is reported as missing.
    expect(read).toMatchObject({ degraded: [] });
  });

  it('prefers the heading when there is one, and does not need a title at all', async () => {
    const read = await readSeat(seatPage({ heading: 'David Hasan', connectionsText: '1,234 connections' }));
    expect(read).toMatchObject({ ok: true, name: 'David Hasan', connectionsCount: 1234 });
  });

  it('still reports unknown rather than a guess when neither says anything', async () => {
    const read = await readSeat(seatPage({ title: 'LinkedIn' }));
    expect(read).toMatchObject({ ok: true, name: null, connectionsCount: null });
    if (!('degraded' in read)) return;
    expect(read.degraded.join(' ')).toContain('no name in its title');
    expect(read.degraded.join(' ')).toContain('no count header in any language');
  });
});

/**
 * IS THIS SESSION SIGNED IN -- the question everything else waits on.
 *
 * A wrong `false` here is not a small cost: every job then tries to sign in, a
 * live session's `/login` redirects straight back to the feed, and the sign-in
 * reports "the sign-in page shows no input#username". That is what the whole
 * product failed with while the session was fine the entire time, because the
 * only thing being asked was whether a `global-nav` class was on the page --
 * and LinkedIn's chrome is hashed now, so it never is.
 */
describe('isLoggedIn', () => {
  function page(options: { at: string; markers?: string[]; feedLandsAt?: string }): LinkedInPage {
    let current = options.at;
    const present = new Set(options.markers ?? []);
    return {
      goto: async (url: string) => {
        current = url.includes('/feed/') ? (options.feedLandsAt ?? url) : url;
      },
      url: () => current,
      locator: (selector: string) => {
        // The fake answers the way a browser does: the selector is a list, and
        // it matches when ANY marker on the page is in it.
        const hit = [...present].some((marker) => selector.includes(marker));
        const self: LinkedInLocator = {
          count: async () => (hit ? 1 : 0),
          first: () => self,
          click: async () => {},
          fill: async () => {},
          textContent: async () => null
        };
        return self;
      },
      waitForTimeout: async () => {}
    };
  }

  it('recognises the current chrome, which carries no global-nav class at all', async () => {
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/feed/', markers: ['#primaryNavLinksComponentRef'] }))).toBe(true);
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/', markers: ['/mynetwork/'] }))).toBe(true);
  });

  it('still recognises the older chrome', async () => {
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/feed/', markers: ['header.global-nav'] }))).toBe(true);
  });

  /** The reskin-proof answer: where the feed lands is a fact about LinkedIn. */
  it('believes a feed that stayed the feed, even with no marker it knows', async () => {
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/' }))).toBe(true);
  });

  it('says no when the feed is bounced to the login page or the guest home', async () => {
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/', feedLandsAt: 'https://www.linkedin.com/login' }))).toBe(false);
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/', feedLandsAt: 'https://www.linkedin.com/' }))).toBe(false);
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/', feedLandsAt: 'https://www.linkedin.com/authwall?trk=x' }))).toBe(false);
  });

  it('says no on a checkpoint, whatever else is on the page', async () => {
    expect(
      await isLoggedIn(page({ at: 'https://www.linkedin.com/checkpoint/challenge/', markers: ['#primaryNavLinksComponentRef'] }))
    ).toBe(false);
  });
});

describe('parseConnectionsCount', () => {
  it('reads the count in English and in a language nobody listed', () => {
    expect(parseConnectionsCount('1,234 connections')).toBe(1234);
    expect(parseConnectionsCount('Showing 500 connections')).toBe(500);
    expect(parseConnectionsCount('1 Kontakt')).toBe(1);
    expect(parseConnectionsCount('1 234 relations')).toBe(1234);
  });

  it('refuses what is not a count, rather than returning a number that is wrong', () => {
    // Three words: this is "3 shared connections" on somebody's row, not the
    // header, and the language-free shape is deliberately too strict for it.
    expect(parseConnectionsCount('3 gemeinsame Kontakte')).toBeNull();
    // Above LinkedIn's own ceiling of 30,000, so whatever this was, it was not
    // a connection count. (A plausible-looking "2026 Jahre" WOULD be believed
    // -- the defence against that is the selector, which is scoped to the main
    // region of the connections page and tries the exact English header first.)
    expect(parseConnectionsCount('45000 Kontakte')).toBeNull();
    expect(parseConnectionsCount('connections')).toBeNull();
    expect(parseConnectionsCount('')).toBeNull();
  });
});
