import { describe, expect, it } from 'vitest';
import {
  SELECTORS,
  connectAnchorInMenuSelector,
  connectAnchorSelector,
  connectButtonSelector,
  connectInMoreMenuSelector,
  cssSafeName,
  moreActionsSelector,
  isDegreeRead,
  isLoggedIn,
  parseConnectionDegree,
  parseConnectionsCount,
  profileHandleFor,
  readProfileDegree,
  readSeat,
  sendInvite,
  sessionRecoveryReason,
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

/**
 * The name the fake profile shows, and the Connect selector the driver builds
 * from it. Every Connect control this driver will click is pinned to the
 * subject's own display name -- see `connectButtonSelector` -- so a fake that
 * offers a bare `SELECTORS.connectButton` is offering a STRANGER's button and
 * must not be clicked.
 */
const SUBJECT = 'Some Person';
const CONNECT_FOR_SUBJECT = connectButtonSelector(SUBJECT);

/**
 * A profile page that answers `count()` from a table and nothing else.
 *
 * Every selector not named in `counts` matches nothing, which is what makes
 * these tests about ONE fact each: what is on the page, and what got clicked.
 * The display name is served through `SELECTORS.profileHeading` because that is
 * where the driver reads the pin it scopes its Connect selectors with.
 */
function personPage(spec: {
  name: string | null;
  counts: Record<string, number>;
  clicked: string[];
  filled?: string[];
  url: () => string;
  goto: (url: string) => void;
}): LinkedInPage {
  const locator = (selector: string): LinkedInLocator => {
    const self: LinkedInLocator = {
      count: async () => {
        if (selector in spec.counts) return spec.counts[selector]!;
        if (selector === SELECTORS.profileHeading) return spec.name === null ? 0 : 1;
        return 0;
      },
      first: () => self,
      click: async () => {
        spec.clicked.push(selector);
      },
      fill: async (value: string) => {
        spec.filled?.push(value);
      },
      textContent: async () => (selector === SELECTORS.profileHeading ? spec.name : null)
    };
    return self;
  };
  return {
    goto: async (url: string) => {
      spec.goto(url);
    },
    url: spec.url,
    locator,
    waitForTimeout: async () => {}
  };
}

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
    const { page, navigations, clicked } = fakePage({
      startAt: 'https://www.linkedin.com/feed/',
      linkOnPage: true
    });

    const result = await viewProfile(page, TARGET);

    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe(TARGET);
    expect(clicked).toContain('a[href*="/in/some-person"]');
    // THE ASSERTION THAT MATTERS: no document load happened at all.
    expect(navigations).toEqual([]);
  });

  it('falls back to the address bar when the page shows no link to the target', async () => {
    const { page, navigations, clicked } = fakePage({
      startAt: 'https://www.linkedin.com/feed/',
      linkOnPage: false
    });

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

  /**
   * A DEAD BROWSER IS NOT A DRIFTED SELECTOR, and the difference is the only
   * thing an operator ever reads.
   *
   * Real row, 2026-08-24: the companion relay died during the 120s gap between
   * two actions of one batch, the next `page.goto` came back with Playwright's
   * `Target page, context or browser has been closed`, and every navigation
   * failure was classified as drift -- so the ledger told somebody to go and
   * repair selectors that had never been wrong.
   */
  it('reports a navigation onto a closed browser as a lost session, not as selector drift', async () => {
    const { page } = fakePage({ startAt: 'about:blank', linkOnPage: false });
    page.goto = async () => {
      throw new Error(
        'page.goto: Target page, context or browser has been closed\nCall log:\n  - navigating to "https://www.linkedin.com/in/some-person/"'
      );
    };

    const result = await viewProfile(page, TARGET);

    expect(result).toMatchObject({ ok: false, failureKind: 'session_lost' });
    expect(result.detail).toContain('browser session for this seat ended');
    // The operator must not be sent to a file that has nothing to do with it.
    expect(result.detail).not.toMatch(/SELECTORS/i);
  });

  it('still reports an ordinary navigation failure as selector drift', async () => {
    // A live browser having a bad navigation. The session is intact, so the old
    // classification is the right one and must not have been widened away.
    const { page } = fakePage({ startAt: 'about:blank', linkOnPage: false });
    page.goto = async () => {
      throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.linkedin.com/');
    };

    const result = await viewProfile(page, TARGET);

    expect(result).toMatchObject({ ok: false, failureKind: 'selector_drift' });
    expect(result.detail).toContain('net::ERR_NAME_NOT_RESOLVED');
  });
});

describe('connection request composer', () => {
  it('treats a missing note field after a visible Add a note control as definite selector drift', async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          if (selector === SELECTORS.profileHeading) return 1;
          if (selector === CONNECT_FOR_SUBJECT) return 1;
          if (selector === SELECTORS.addNoteButton) return 1;
          return 0;
        },
        first: () => self,
        click: async () => {
          clicked.push(selector);
        },
        fill: async () => {},
        textContent: async () => (selector === SELECTORS.profileHeading ? SUBJECT : null)
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    };

    const result = await sendInvite(page, TARGET, 'Hi there', { appearTimeoutMs: 20 });

    expect(result).toMatchObject({ ok: false, failureKind: 'selector_drift' });
    expect(clicked).toContain(CONNECT_FOR_SUBJECT);
    expect(clicked).toContain(SELECTORS.addNoteButton);
    expect(result.detail).toContain('Nothing was sent.');
  });

  it('includes the current interop shadow-root controls in the invite selectors', () => {
    expect(SELECTORS.addNoteButton).toContain('#interop-outlet');
    expect(SELECTORS.noteTextarea).toContain('#interop-outlet textarea');
    expect(SELECTORS.sendInviteButton).toContain('#interop-outlet');
  });

  /**
   * An `aria-label` is an annotation LinkedIn is free not to ship. Production
   * on 2026-08-24 refused byronvoorbach with "the composer opened but the
   * textarea did not match", and the WORDING of that refusal proves the Add a
   * note button had not matched either -- so the composer selectors were
   * betting on markup nobody promised. Every composer control now also matches
   * the words a member actually reads on the button.
   */
  it('matches the composer controls by their visible text, not only by aria-label', () => {
    expect(SELECTORS.addNoteButton).toContain(':text-is("Add a note")');
    expect(SELECTORS.sendWithoutNoteButton).toContain(':text-is("Send without a note")');
    expect(SELECTORS.sendInviteButton).toContain(':text-is("Send")');
  });

  /**
   * THE OTHER HALF OF THE SAME FAILURE. `count()` does not wait -- Playwright's
   * auto-waiting is on the actions -- so the composer was being asked about one
   * fixed second after the Connect click that creates it. This fake makes the
   * composer appear only on the third look, which is exactly the shape of a
   * modal that is a frame or two slower than `settle()`, and the invite must
   * still go out.
   */
  it('waits for a composer that renders after the settle rather than calling it missing', async () => {
    let current = TARGET;
    let looks = 0;
    const filled: string[] = [];
    const clicked: string[] = [];
    const waits: number[] = [];
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          if (selector === SELECTORS.profileHeading) return 1;
          if (selector === CONNECT_FOR_SUBJECT) return 1;
          if (selector === SELECTORS.addNoteButton) {
            looks += 1;
            return looks >= 3 ? 1 : 0;
          }
          if (selector === SELECTORS.noteTextarea) return 1;
          if (selector === SELECTORS.sendInviteButton) return 1;
          return 0;
        },
        first: () => self,
        click: async () => {
          clicked.push(selector);
        },
        fill: async (value: string) => {
          filled.push(value);
        },
        textContent: async () => (selector === SELECTORS.profileHeading ? SUBJECT : null)
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async (ms: number) => {
        waits.push(ms);
      }
    };

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.');

    expect(result).toMatchObject({ ok: true, failureKind: null });
    expect(looks).toBeGreaterThanOrEqual(3);
    expect(clicked).toContain(SELECTORS.addNoteButton);
    expect(filled).toEqual(['Hi Byron, thanks for connecting.']);
  });

  /**
   * And when it genuinely never appears, the refusal has to be diagnosable.
   * "[five selectors] did not match" said nothing about what LinkedIn had put
   * there instead, so every occurrence began with a human driving the page by
   * hand. The probe counts are cheap and only run on this path.
   */
  it('reports what was on screen when the composer never appears', async () => {
    let current = TARGET;
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          if (selector === SELECTORS.profileHeading) return 1;
          if (selector === CONNECT_FOR_SUBJECT) return 1;
          if (selector === '#interop-outlet') return 1;
          if (selector === 'div[role="dialog"]') return 1;
          return 0;
        },
        first: () => self,
        click: async () => {},
        fill: async () => {},
        textContent: async () => (selector === SELECTORS.profileHeading ? SUBJECT : null)
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    };

    const result = await sendInvite(page, TARGET, 'Hi there', { appearTimeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('On screen at the time');
    expect(result.detail).toContain('interop outlet: 1');
    expect(result.detail).toContain('dialog: 1');
    expect(result.detail).toContain('any textarea: 0');
  });

  /**
   * THE REGRESSION THIS TEST EXISTS FOR, and it shipped.
   *
   * Commit 1d480cd widened the composer selectors for LinkedIn's
   * `#interop-outlet` shadow root and deleted the `typeLike` call in the same
   * hunk. Nothing crashed and nothing was refused: the composer opened, the
   * textarea matched, Send was clicked, and an invite the operator had approved
   * WITH a message went out with an empty one. The selector assertion above
   * passed the whole time, because a selector matching is not the note being
   * typed. So this asserts the bytes, in order, against the send.
   */
  it('types the approved note into the composer before clicking send', async () => {
    let current = TARGET;
    const events: string[] = [];
    const filled: string[] = [];
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          if (selector === SELECTORS.profileHeading) return 1;
          if (selector === CONNECT_FOR_SUBJECT) return 1;
          if (selector === SELECTORS.addNoteButton) return 1;
          if (selector === SELECTORS.noteTextarea) return 1;
          if (selector === SELECTORS.sendInviteButton) return 1;
          // The modal is gone after the send click, which is what proves it
          // left rather than stalling open.
          return 0;
        },
        first: () => self,
        click: async () => {
          events.push(`click:${selector}`);
        },
        fill: async (value: string) => {
          events.push(`fill:${selector}`);
          filled.push(value);
        },
        textContent: async () => (selector === SELECTORS.profileHeading ? SUBJECT : null)
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    };

    const result = await sendInvite(page, TARGET, 'Hi Audrey, thanks for connecting.');

    expect(result).toMatchObject({ ok: true, failureKind: null });
    // BYTE FOR BYTE. The note the operator approved, not a trimmed or
    // templated version of it.
    expect(filled).toEqual(['Hi Audrey, thanks for connecting.']);
    // AND BEFORE THE SEND. Typing it after the click would deliver the same
    // empty invite this test was written to catch.
    expect(events.indexOf(`fill:${SELECTORS.noteTextarea}`)).toBeGreaterThan(
      events.indexOf(`click:${SELECTORS.addNoteButton}`)
    );
    expect(events.indexOf(`click:${SELECTORS.sendInviteButton}`)).toBeGreaterThan(
      events.indexOf(`fill:${SELECTORS.noteTextarea}`)
    );
  });

  /**
   * THE REASON THE CAMPAIGN SENT ZERO INVITES, and neither half of it was a
   * timing problem.
   *
   * Measured against the live seat on 2026-08-25: LinkedIn renders Connect as
   * an ANCHOR carrying the target's vanity name --
   * `<a href="/preload/custom-invite/?vanityName=some-person">` -- and renders
   * it in the MEMBER's language, which on this seat is German ("Vernetzen").
   * `connectButton` is `button[aria-label^="Invite"]...` and misses on both
   * counts. The profile-view step kept working the entire time because it
   * needs no selector at all, which is exactly what "13 views, 0 invites"
   * looked like from the outside.
   */
  it("clicks the target's own Connect anchor when no Connect button exists", async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const filled: string[] = [];
    const anchor = connectAnchorSelector('some-person');
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          // The German profile: no Connect BUTTON anywhere, and no More menu
          // this table's English labels can find either.
          if (selector === anchor) return 1;
          if (selector === SELECTORS.addNoteButton) return 1;
          if (selector === SELECTORS.noteTextarea) return 1;
          if (selector === SELECTORS.sendInviteButton) return 1;
          return 0;
        },
        first: () => self,
        click: async () => {
          clicked.push(selector);
        },
        fill: async (value: string) => {
          filled.push(value);
        },
        textContent: async () => null
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    };

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.');

    expect(result).toMatchObject({ ok: true, failureKind: null });
    expect(clicked).toContain(anchor);
    expect(filled).toEqual(['Hi Byron, thanks for connecting.']);
  });

  /**
   * AND IT HAS TO BE THAT PERSON'S ANCHOR.
   *
   * A profile page carries other people's Connect anchors: `ptr2m` was
   * measured with seven, one for the profile and six for the "People also
   * viewed" rail. A selector that matched `vanityName=byron` as a substring
   * would match `vanityName=byronsmith` too, and `.first()` would then invite
   * a stranger nobody approved -- which cannot be withdrawn quietly. So the
   * handle is pinned to the END of the parameter, both for today's URL and for
   * the day LinkedIn appends another one.
   */
  it('pins the Connect anchor to the whole handle, never a prefix of it', () => {
    const selector = connectAnchorSelector('byron');
    expect(selector).toContain('[href$="vanityName=byron"]');
    expect(selector).toContain('[href*="vanityName=byron&"]');
    expect(selector).not.toContain('[href*="vanityName=byron"]');
    /*
     * AND IT HAS TO BE THE COPY A PERSON CAN ACTUALLY HIT. The profile
     * renders three anchors for its own subject: a sticky-header duplicate
     * OUTSIDE `main` that a Premium banner covers -- first in the DOM, so
     * `.first()` picks it and the click times out after 15 seconds -- the real
     * top-card control inside `main`, and a 0x0 ghost. Every alternative is
     * therefore scoped and `:visible`, and none of them may be unscoped.
     */
    for (const alternative of selector.split(', ')) {
      expect(alternative.startsWith('main ')).toBe(true);
      expect(alternative.endsWith(':visible')).toBe(true);
    }
    expect(profileHandleFor(TARGET)).toBe('some-person');
    // A target this driver would not navigate to yields no handle, so the
    // caller falls back to the selectors that need none.
    expect(profileHandleFor('https://evil.example/in/some-person/')).toBeNull();
  });

  /**
   * THE INCIDENT THIS PINS DOWN: TWO INVITES WENT TO STRANGERS.
   *
   * Measured on the live seat on 2026-08-25. `/in/byronvoorbach/` is 3rd degree
   * and his top card offers only Message and Follow -- his own Connect is
   * behind "More" -- while the "More profiles for you" rail underneath carries
   * FIVE `button[aria-label^="Invite"][aria-label*="connect"]`, all for other
   * people and all inside `main`. The old code saw a non-zero count, skipped
   * the More menu it needed, clicked `.first()`, and invited Sharon van
   * Hasselt-Zock. The same run against `/in/martijnhandels/` invited Dmitry
   * Klebanov. LinkedIn's own sent-invitations list named them both.
   *
   * An invite cannot be un-sent, so the assertion that matters here is the
   * negative one: the stranger's control is on the page, matches the table's
   * selector, and is NOT clicked.
   */
  it('never clicks a Connect button that belongs to somebody else', async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const page = personPage({
      name: 'Byron Voorbach',
      counts: {
        // Five rail buttons for strangers, and nothing for the subject.
        [SELECTORS.connectButton]: 5,
        [moreActionsSelector()]: 1
      },
      clicked,
      url: () => current,
      goto: (url) => {
        current = url;
      }
    });

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.');

    expect(result.ok).toBe(false);
    // Five live Connect controls on the page are proof the selector still
    // matches what LinkedIn renders, so the one thing missing is a Connect for
    // Byron -- a fact about Byron, not about this file.
    expect(result.failureKind).toBe('connect_unavailable');
    expect(result.detail).toContain('deliberately ignored');
    expect(clicked).not.toContain(SELECTORS.connectButton);
    expect(clicked).not.toContain(connectInMoreMenuSelector('Byron Voorbach'));
  });

  it('takes the Connect entry out of the More menu by the handle in its href', async () => {
    /*
     * THE BUG THAT COST THE ACCOUNT TWO DAYS, AS A TEST.
     *
     * A 3rd-degree profile puts Connect only behind More, and the live entry is
     * an `<a role="menuitem" href="/preload/custom-invite/?vanityName=...">`
     * carrying NO aria-label. The driver looked for a name pinned into an
     * aria-label, found nothing, and reported "the More menu contains no
     * Connect entry" on lead after lead while the entry sat in the menu.
     *
     * The href is the pin now, and it is a stronger one than a display name:
     * it is the profile handle the invite was approved against, and it does not
     * translate.
     */
    let current = TARGET;
    const clicked: string[] = [];
    const navigations: string[] = [];
    const menuEntry = connectAnchorInMenuSelector('some-person');
    const page = personPage({
      name: SUBJECT,
      counts: {
        // Six strangers' Connect buttons in the rail, none for the subject.
        [SELECTORS.connectButton]: 6,
        [moreActionsSelector()]: 1,
        [menuEntry]: 1,
        [SELECTORS.addNoteButton]: 1,
        [SELECTORS.noteTextarea]: 1,
        [SELECTORS.sendInviteButton]: 1
      },
      clicked,
      url: () => current,
      goto: (url) => {
        navigations.push(url);
        current = url;
      }
    });

    const result = await sendInvite(page, TARGET, 'Hi, thanks for connecting.');

    expect(result.ok).toBe(true);
    // FOLLOWED, NOT CLICKED. Clicking that anchor is a measured no-op on the
    // live page; its own href is what opens the composer.
    expect(navigations).toContain(
      'https://www.linkedin.com/preload/custom-invite/?vanityName=some-person'
    );
    expect(clicked).not.toContain(menuEntry);
    // The strangers' buttons stay untouched, which is the property the whole
    // person-pinning exists for.
    expect(clicked).not.toContain(SELECTORS.connectButton);
  });

  it('pins the menu entry to the handle and to nothing else', () => {
    const selector = connectAnchorInMenuSelector('byronvoorbach');
    for (const alternative of selector.split(', ')) {
      // Deliberately NOT scoped to `main`: measured live, the open menu is a
      // portal and the anchor's closest('main') is null.
      expect(alternative.startsWith('main ')).toBe(false);
      expect(alternative).toContain('vanityName=byronvoorbach');
      expect(alternative.endsWith(':visible')).toBe(true);
    }
    expect(connectAnchorInMenuSelector('byronvoorbach')).not.toContain('somebodyelse');
  });

  it('still calls it drift when nothing on the page proves the selector works', async () => {
    /*
     * THE OTHER HALF OF THE SAME EVIDENCE RULE.
     *
     * `connect_unavailable` is only claimable while a Connect control -- any
     * Connect control, on anyone -- matches on the page. With none matching
     * there is nothing to distinguish "LinkedIn will not let us connect with
     * this person" from "LinkedIn renamed the button", and the second must
     * still stop the batch and still name SELECTORS in driver.ts. Guessing in
     * the operator's favour here would turn a real markup change into a
     * campaign that quietly skips everybody.
     */
    let current = TARGET;
    const clicked: string[] = [];
    const page = personPage({
      name: 'Byron Voorbach',
      counts: { [moreActionsSelector()]: 1 },
      clicked,
      url: () => current,
      goto: (url) => {
        current = url;
      }
    });

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.');

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('selector_drift');
    expect(clicked).not.toContain(connectInMoreMenuSelector('Byron Voorbach'));
  });

  it('clicks the Connect button whose label names the target, when there is one', async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const own = connectButtonSelector('Byron Voorbach');
    const page = personPage({
      name: 'Byron Voorbach',
      counts: {
        [own]: 1,
        [SELECTORS.connectButton]: 6,
        [SELECTORS.addNoteButton]: 1,
        [SELECTORS.noteTextarea]: 1,
        [SELECTORS.sendInviteButton]: 1
      },
      clicked,
      url: () => current,
      goto: (url) => {
        current = url;
      }
    });

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.');

    expect(result).toMatchObject({ ok: true, failureKind: null });
    expect(clicked).toContain(own);
  });

  it('refuses to click anything when the page has no readable name to pin to', async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const page = personPage({
      name: null,
      counts: { [SELECTORS.connectButton]: 5, [moreActionsSelector()]: 1 },
      clicked,
      url: () => current,
      goto: (url) => {
        current = url;
      }
    });

    const result = await sendInvite(page, TARGET, 'Hi there.');

    expect(result.failureKind).toBe('selector_drift');
    expect(result.detail).toContain('no readable display name');
    expect(clicked).toEqual([]);
  });

  it('pins both person-blind Connect selectors to the display name', () => {
    for (const alternative of connectButtonSelector('Byron Voorbach').split(', ')) {
      expect(alternative.startsWith('main ')).toBe(true);
      expect(alternative).toContain('[aria-label*="Byron Voorbach"]');
      expect(alternative.endsWith(':visible')).toBe(true);
    }
    for (const alternative of connectInMoreMenuSelector('Byron Voorbach').split(', ')) {
      expect(alternative).toContain('[aria-label*="Byron Voorbach"]');
    }
    /*
     * And the More button has the same three-copy problem the anchor has: a
     * sticky-header duplicate the `<nav>` covers, first in the DOM, which cost
     * a full 15s click timeout; the real one in `main`; and a 0x0 ghost.
     */
    for (const alternative of moreActionsSelector().split(', ')) {
      expect(alternative.startsWith('main ')).toBe(true);
      expect(alternative.endsWith(':visible')).toBe(true);
    }
    // A name that cannot be put in a CSS string is no name at all: the caller
    // must refuse rather than compile a selector that matches something else.
    expect(cssSafeName('Ann "Annie" Lee')).toBeNull();
    expect(cssSafeName('back\\slash')).toBeNull();
    expect(cssSafeName(null)).toBeNull();
    expect(cssSafeName('A')).toBeNull();
    // Only the first line, whitespace collapsed: a heading that carries a
    // pronoun or a badge underneath is never a substring of any aria-label.
    expect(cssSafeName('  Byron   Voorbach \nHe/Him')).toBe('Byron Voorbach');
  });

  /**
   * THE COMPOSER IS TOLD APART BY STRUCTURE, BECAUSE ITS WORDS ARE TRANSLATED.
   *
   * The live modal reads "Nachricht hinzufügen" and "Ohne Notiz senden". Both
   * are artdeco buttons, and artdeco's own primary/secondary classes say which
   * one sends in every language LinkedIn ships.
   */
  it('matches the composer controls by artdeco role as well as by words', () => {
    expect(SELECTORS.addNoteButton).toContain('div.send-invite button.artdeco-button--secondary');
    expect(SELECTORS.sendInviteButton).toContain('div.send-invite button.artdeco-button--primary');
    expect(SELECTORS.sendWithoutNoteButton).toContain(
      'div.send-invite button.artdeco-button--primary'
    );
  });

  /**
   * THE PRICE OF THOSE TWO PRIMARIES BEING THE SAME BUTTON.
   *
   * Before the note field is opened, the modal's primary reads "send without a
   * note"; after, it reads "send". `sendInviteButton` now matches that primary
   * structurally, so an approved note plus a composer that never opens its
   * note field must NOT end in a click on it -- that would send the empty
   * invite commit 496cf5d was written to stop, wearing a different disguise.
   * The textarea is the proof of which state the modal is in, and nothing is
   * sent without it.
   */
  it('never clicks send when an approved note has nowhere to be typed', async () => {
    let current = TARGET;
    const clicked: string[] = [];
    const locator = (selector: string): LinkedInLocator => {
      const self: LinkedInLocator = {
        count: async () => {
          if (selector === connectAnchorSelector('some-person')) return 1;
          // The modal is open on its FIRST state: a primary button is there,
          // and the note field is not.
          if (selector === SELECTORS.sendInviteButton) return 1;
          if (selector === SELECTORS.sendWithoutNoteButton) return 1;
          return 0;
        },
        first: () => self,
        click: async () => {
          clicked.push(selector);
        },
        fill: async () => {},
        textContent: async () => null
      };
      return self;
    };
    const page: LinkedInPage = {
      goto: async (url: string) => {
        current = url;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => {}
    };

    const result = await sendInvite(page, TARGET, 'Hi Byron, thanks for connecting.', {
      appearTimeoutMs: 20
    });

    expect(result.ok).toBe(false);
    expect(clicked).not.toContain(SELECTORS.sendInviteButton);
    expect(clicked).not.toContain(SELECTORS.sendWithoutNoteButton);
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
    let current =
      'https://www.linkedin.com/connect-services/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F';
    const page: LinkedInPage = {
      goto: async (url: string) => {
        navigations.push(url);
        if (url === 'https://www.linkedin.com/feed/') {
          current =
            'https://www.linkedin.com/connect-services/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F';
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

  it('does not turn legacy /uas/login into a human-check alert', async () => {
    const page: LinkedInPage = {
      goto: async () => undefined,
      url: () => 'https://www.linkedin.com/uas/login/',
      locator: emptyLocator,
      waitForTimeout: async () => {}
    };
    expect(await sessionRecoveryReason(page)).toBe('signed_out');
  });

  it('still recognises a specific legacy verification route as a challenge', async () => {
    const page: LinkedInPage = {
      goto: async () => undefined,
      url: () => 'https://www.linkedin.com/uas/login/challenge/',
      locator: emptyLocator,
      waitForTimeout: async () => {}
    };
    expect(await sessionRecoveryReason(page)).toBe('challenge');
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
      textContent: async () => (isBadge ? (options.badge ?? null) : null)
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
    const read = await readProfileDegree(
      degreePage({ badge: '1st' }),
      'https://evil.example/steal'
    );
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

  function seatPage(options: {
    heading?: string;
    title?: string;
    connectionsText?: string;
  }): LinkedInPage {
    let current = 'https://www.linkedin.com/feed/';

    const matching = (selector: string): string | null => {
      const onConnections = current.includes('/connections');
      if (selector === SELECTORS.profileHeading)
        return onConnections ? null : (options.heading ?? null);
      if (selector === SELECTORS.connectionsCount) {
        // The English matcher, which is a text= selector: it only answers when
        // the words are there.
        return onConnections && /connections?/i.test(options.connectionsText ?? '')
          ? options.connectionsText!
          : null;
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
    const read = await readSeat(
      seatPage({ title: '(3) David hasan | LinkedIn', connectionsText: '1 Kontakt' })
    );

    expect(read).toMatchObject({
      ok: true,
      profileUrl: PROFILE,
      name: 'David hasan',
      connectionsCount: 1
    });
    // Nothing was missed, so nothing is reported as missing.
    expect(read).toMatchObject({ degraded: [] });
  });

  it('prefers the heading when there is one, and does not need a title at all', async () => {
    const read = await readSeat(
      seatPage({ heading: 'David Hasan', connectionsText: '1,234 connections' })
    );
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
    expect(
      await isLoggedIn(
        page({ at: 'https://www.linkedin.com/feed/', markers: ['#primaryNavLinksComponentRef'] })
      )
    ).toBe(true);
    expect(
      await isLoggedIn(
        page({ at: 'https://www.linkedin.com/messaging/', markers: ['/mynetwork/'] })
      )
    ).toBe(true);
  });

  it('still recognises the older chrome', async () => {
    expect(
      await isLoggedIn(
        page({ at: 'https://www.linkedin.com/feed/', markers: ['header.global-nav'] })
      )
    ).toBe(true);
  });

  /** The reskin-proof answer: where the feed lands is a fact about LinkedIn. */
  it('believes a feed that stayed the feed, even with no marker it knows', async () => {
    expect(await isLoggedIn(page({ at: 'https://www.linkedin.com/messaging/' }))).toBe(true);
  });

  it('says no when the feed is bounced to the login page or the guest home', async () => {
    expect(
      await isLoggedIn(
        page({
          at: 'https://www.linkedin.com/messaging/',
          feedLandsAt: 'https://www.linkedin.com/login'
        })
      )
    ).toBe(false);
    expect(
      await isLoggedIn(
        page({
          at: 'https://www.linkedin.com/messaging/',
          feedLandsAt: 'https://www.linkedin.com/'
        })
      )
    ).toBe(false);
    expect(
      await isLoggedIn(
        page({
          at: 'https://www.linkedin.com/messaging/',
          feedLandsAt: 'https://www.linkedin.com/authwall?trk=x'
        })
      )
    ).toBe(false);
  });

  it('says no on a checkpoint, whatever else is on the page', async () => {
    expect(
      await isLoggedIn(
        page({
          at: 'https://www.linkedin.com/checkpoint/challenge/',
          markers: ['#primaryNavLinksComponentRef']
        })
      )
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
