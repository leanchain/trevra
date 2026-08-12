import { describe, expect, it } from 'vitest';
import { SELECTORS } from './driver.js';
import { ACTION_GAP_SECONDS } from './limits.js';
import {
  SCRAPE_SELECTORS,
  canonicalProfileUrl,
  postUrlFor,
  scrapeGapSeconds,
  scrapePostEngagers,
  scrapeSearchResults,
  searchResultsUrlFor,
  type LinkedInScrapeLocator,
  type LinkedInScrapePage
} from './driver-scrape.js';

/**
 * NO BROWSER IS LAUNCHED HERE AND NO LINKEDIN REQUEST IS MADE, EVER.
 *
 * Same rule as local-worker.test.ts, and it matters more in this file: the
 * thing under test is a SCRAPER, and a test suite that pointed one at a real
 * account would be spending that account's standing on CI runs -- which is the
 * exact risk the module exists to bound.
 *
 * What is asserted is the four rules the file is built on: the URL is checked
 * before anything is fetched, every fetch after the first is paced from the
 * same deterministic seeded draw the worker uses, the caps are real and say
 * what they dropped, and a wall stops the walk immediately while keeping what
 * it already had.
 */

interface StubNode {
  text?: string;
  attrs?: Record<string, string>;
  children?: Record<string, StubNode[]>;
}

interface Screen {
  /** What `page.url()` reports. Defaults to the URL that was requested. */
  url?: string;
  nodes: Record<string, StubNode[]>;
  /** What a click on a selector navigates to, in-place. */
  click?: Record<string, Screen>;
}

interface PageHarness {
  page: LinkedInScrapePage;
  /** Every URL this page was asked to open, in order. THE THING THAT COSTS. */
  fetches: string[];
  /** Every sleep, in milliseconds. */
  delays: number[];
  sleep: (ms: number) => Promise<void>;
}

function harness(route: (url: string) => Screen): PageHarness {
  const fetches: string[] = [];
  const delays: number[] = [];
  let current: Screen = { nodes: {} };
  let currentUrl = 'https://www.linkedin.com/';

  function locator(pool: StubNode[], selector: string): LinkedInScrapeLocator {
    return {
      count: async () => pool.length,
      first: () => locator(pool.slice(0, 1), selector),
      nth: (index) => locator(pool.slice(index, index + 1), selector),
      locator: (inner) => locator(pool.flatMap((node) => node.children?.[inner] ?? []), inner),
      click: async () => {
        const next = current.click?.[selector];
        if (next) {
          current = next;
          currentUrl = next.url ?? currentUrl;
        }
      },
      fill: async () => {},
      textContent: async () => pool[0]?.text ?? null,
      getAttribute: async (name) => pool[0]?.attrs?.[name] ?? null
    };
  }

  const page: LinkedInScrapePage = {
    goto: async (url) => {
      fetches.push(url);
      current = route(url);
      currentUrl = current.url ?? url;
      return undefined;
    },
    url: () => currentUrl,
    locator: (selector) => locator(current.nodes[selector] ?? [], selector),
    waitForTimeout: async () => {}
  };

  return {
    page,
    fetches,
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    }
  };
}

/** One search card whose link carries the tracking query LinkedIn always adds. */
function card(handle: string, name: string, headline = 'Founder', company = 'Acme'): StubNode {
  return {
    children: {
      [SCRAPE_SELECTORS.searchResultProfileLink]: [
        { attrs: { href: `/in/${handle}/?miniProfileUrn=urn%3Ali%3Afsd_profile%3A${handle}` } }
      ],
      [SCRAPE_SELECTORS.searchResultName]: [{ text: `  ${name}\n ` }],
      [SCRAPE_SELECTORS.searchResultHeadline]: [{ text: headline }],
      [SCRAPE_SELECTORS.searchResultSecondary]: [{ text: company }]
    }
  };
}

function engager(handle: string, name: string): StubNode {
  return {
    children: {
      [SCRAPE_SELECTORS.engagerProfileLink]: [{ attrs: { href: `https://www.linkedin.com/in/${handle}/` } }],
      [SCRAPE_SELECTORS.engagerName]: [{ text: name }],
      [SCRAPE_SELECTORS.engagerHeadline]: [{ text: 'Head of Ops' }],
      [SCRAPE_SELECTORS.commentAuthorName]: [{ text: name }],
      [SCRAPE_SELECTORS.commentAuthorHeadline]: [{ text: 'Head of Ops' }]
    }
  };
}

function searchScreen(cards: StubNode[]): Screen {
  return { nodes: { [SCRAPE_SELECTORS.searchResultCard]: cards } };
}

const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=cto&network=%5B%22S%22%5D';
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/';

function pageNumber(url: string): number {
  return Number(new URL(url).searchParams.get('page') ?? '1');
}

describe('the URL is checked before anything is fetched', () => {
  it('accepts a people-search URL and keeps the operator\'s filters verbatim', () => {
    const canonical = searchResultsUrlFor(SEARCH_URL);
    expect(canonical).toContain('keywords=cto');
    // The facet is the search. Re-encoding it is how a filtered search quietly
    // becomes an unfiltered one on the next run.
    expect(canonical).toContain('network=%5B%22S%22%5D');
  });

  it('refuses a foreign host, a non-search LinkedIn path, and junk', () => {
    expect(searchResultsUrlFor('https://evil.example/search/results/people/')).toBeNull();
    expect(searchResultsUrlFor('https://www.linkedin.com/feed/')).toBeNull();
    expect(searchResultsUrlFor('https://www.linkedin.com/in/maya/')).toBeNull();
    expect(searchResultsUrlFor('not a url')).toBeNull();
    expect(searchResultsUrlFor('')).toBeNull();
  });

  it('accepts both post shapes LinkedIn hands out and refuses anything else', () => {
    expect(postUrlFor(POST_URL)).toBe(POST_URL);
    expect(postUrlFor('https://www.linkedin.com/posts/maya-chen_hiring-activity-7000-abcd/')).not.toBeNull();
    expect(postUrlFor('https://www.linkedin.com/in/maya/')).toBeNull();
    expect(postUrlFor('https://evil.example/feed/update/urn:li:activity:7/')).toBeNull();
  });

  it('never navigates for a URL it refused', async () => {
    const { page, fetches } = harness(() => searchScreen([]));
    const result = await scrapeSearchResults(page, 'https://evil.example/search/results/people/');
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('not_found');
    // THE ASSERTION THAT MATTERS: an authenticated browser was never pointed at
    // somebody else's site.
    expect(fetches).toEqual([]);
  });
});

describe('walking a search', () => {
  it('paginates, canonicalises every profile link, and stops on an empty page', async () => {
    const h = harness((url) => {
      const page = pageNumber(url);
      if (page === 1) return searchScreen([card('maya', 'Maya Chen'), card('jonas', 'Jonas Keller')]);
      if (page === 2) return searchScreen([card('sofia', 'Sofia Rossi')]);
      return searchScreen([]);
    });

    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });

    expect(result.ok).toBe(true);
    expect(result.failureKind).toBeNull();
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/in/jonas/',
      'https://www.linkedin.com/in/sofia/'
    ]);
    // The tracking query is gone. A lead stored with ?miniProfileUrn= would be
    // a different string from the same person's exclusion row.
    expect(result.leads[0].profileUrl).not.toContain('miniProfileUrn');
    expect(result.leads[0]).toMatchObject({ name: 'Maya Chen', headline: 'Founder', company: 'Acme' });
    expect(result.pagesWalked).toBe(3);
    expect(h.fetches).toHaveLength(3);
  });

  it('dedupes a person LinkedIn shows on two pages', async () => {
    const h = harness((url) => (pageNumber(url) <= 2 ? searchScreen([card('maya', 'Maya Chen')]) : searchScreen([])));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.leads).toHaveLength(1);
    // A duplicate is not a drop -- they were already recorded.
    expect(result.dropped).toBe(0);
  });

  it('drops a row whose link points off LinkedIn instead of storing it', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? searchScreen([
            { children: { [SCRAPE_SELECTORS.searchResultProfileLink]: [{ attrs: { href: 'https://evil.example/in/maya/' } }] } },
            card('jonas', 'Jonas Keller')
          ])
        : searchScreen([])
    );
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual(['https://www.linkedin.com/in/jonas/']);
    expect(result.dropped).toBe(1);
  });
});

describe('the caps are real and say what they dropped', () => {
  it('stops at the result cap and reports every row it did not return', async () => {
    const cards = Array.from({ length: 25 }, (_, index) => card(`person-${index}`, `Person ${index}`));
    const h = harness((url) => (pageNumber(url) === 1 ? searchScreen(cards) : searchScreen([])));

    const result = await scrapeSearchResults(h.page, SEARCH_URL, { maxResults: 10, sleep: h.sleep });

    expect(result.leads).toHaveLength(10);
    expect(result.dropped).toBe(15);
    // SAID OUT LOUD. A cap that truncates silently leaves an operator believing
    // they are looking at the whole list.
    expect(result.degraded.join(' ')).toContain('15 rows were seen and not returned');
    // And the walk ended: no second page was fetched for results we would drop.
    expect(h.fetches).toHaveLength(1);
  });

  it('stops at the page cap', async () => {
    const h = harness(() => searchScreen([card('a', 'A'), card('b', 'B')]));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { maxPages: 3, maxResults: 500, sleep: h.sleep });
    expect(result.pagesWalked).toBe(3);
    expect(h.fetches).toHaveLength(3);
  });

  it('refuses to be talked past the hard ceilings', async () => {
    const h = harness(() => searchScreen([]));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { maxPages: 10_000, maxResults: 10_000, sleep: h.sleep });
    // One empty page ends the walk, but the ceiling is what bounded the ask.
    expect(result.pagesWalked).toBe(1);
    expect(h.fetches).toHaveLength(1);
  });
});

describe('a page fetch is an action, so it is paced', () => {
  it('sleeps between fetches, inside the 30-120s band, and never before the first', async () => {
    const h = harness((url) => (pageNumber(url) <= 3 ? searchScreen([card(`p${pageNumber(url)}`, 'P')]) : searchScreen([])));
    await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });

    // Four fetches, three gaps. The first page is never delayed.
    expect(h.fetches).toHaveLength(4);
    expect(h.delays).toHaveLength(3);
    for (const delay of h.delays) {
      expect(delay).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min * 1000);
      expect(delay).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max * 1000);
    }
  });

  it('draws the same gaps for the same seed on any machine -- no Math.random anywhere', async () => {
    const run = async () => {
      const h = harness((url) => (pageNumber(url) <= 3 ? searchScreen([card('a', 'A')]) : searchScreen([])));
      await scrapeSearchResults(h.page, SEARCH_URL, { seed: 'llsrc_fixed', sleep: h.sleep });
      return h.delays;
    };
    expect(await run()).toEqual(await run());
    // Different sources pace differently, so a rate limiter has no pattern to
    // key on.
    expect(scrapeGapSeconds('llsrc_a:page:2')).not.toBe(scrapeGapSeconds('llsrc_b:page:2'));
  });
});

describe('a wall stops the walk immediately', () => {
  it('reports a challenge and keeps the pages it already read', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? searchScreen([card('maya', 'Maya Chen')])
        : { url: 'https://www.linkedin.com/checkpoint/challenge/', nodes: { [SELECTORS.challengeForm]: [{}] } }
    );

    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('challenge');
    // Page one already happened and already cost the account whatever it cost.
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual(['https://www.linkedin.com/in/maya/']);
    // AND NOTHING WAS FETCHED AFTER IT. Hammering a challenge is what turns a
    // temporary restriction into a permanent ban.
    expect(h.fetches).toHaveLength(2);
  });

  it('reports a limit wall the same way', async () => {
    const h = harness(() => ({ nodes: { [SELECTORS.limitWall]: [{}] } }));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('limit_wall');
    expect(h.fetches).toHaveLength(1);
  });

  it('outranks a limit wall with a challenge, exactly as driver.ts does', async () => {
    const h = harness(() => ({ nodes: { [SELECTORS.limitWall]: [{}], [SELECTORS.challengeForm]: [{}] } }));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('challenge');
  });
});

describe('drift is a partial answer, not a failure', () => {
  it('returns ok with an empty list and names the table to repair', async () => {
    const h = harness(() => ({ nodes: {} }));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.leads).toEqual([]);
    expect(result.degraded.join(' ')).toContain('SCRAPE_SELECTORS');
  });

  it('says nothing about drift when LinkedIn says there were no results', async () => {
    const h = harness(() => ({ nodes: { [SCRAPE_SELECTORS.searchNoResults]: [{ text: 'No results found' }] } }));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.degraded).toEqual([]);
  });
});

describe('a post\'s engagers', () => {
  const modal: Screen = {
    nodes: {
      [SCRAPE_SELECTORS.reactorsModal]: [{}],
      [SCRAPE_SELECTORS.reactorItem]: [engager('maya', 'Maya Chen'), engager('jonas', 'Jonas Keller')]
    }
  };
  const post: Screen = {
    nodes: {
      [SCRAPE_SELECTORS.reactionsEntry]: [{ text: '42' }],
      // Sofia commented; Maya both reacted and commented.
      [SCRAPE_SELECTORS.commentItem]: [engager('sofia', 'Sofia Rossi'), engager('maya', 'Maya Chen')]
    },
    click: { [SCRAPE_SELECTORS.reactionsEntry]: modal }
  };

  it('merges reactors and commenters into one deduped list', async () => {
    const h = harness(() => post);
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });

    expect(result.ok).toBe(true);
    // Maya liked AND commented. Importing her twice would put two invites in
    // front of a founder to approve.
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/in/jonas/',
      'https://www.linkedin.com/in/sofia/'
    ]);
    expect(result.leads[0].name).toBe('Maya Chen');
    // Neither surface carries a company, and it is left null rather than parsed
    // out of the headline.
    expect(result.leads[0].company).toBeNull();
    // The post is opened, the modal is read, the post is re-opened for comments.
    expect(h.fetches).toEqual([POST_URL, POST_URL]);
    expect(h.delays).toHaveLength(1);
  });

  it('refuses a URL that is not a post, without fetching', async () => {
    const h = harness(() => post);
    const result = await scrapePostEngagers(h.page, 'https://www.linkedin.com/in/maya/');
    expect(result.failureKind).toBe('not_found');
    expect(h.fetches).toEqual([]);
  });

  it('stops on a challenge and keeps the reactors it already read', async () => {
    let opened = 0;
    const h = harness(() => {
      opened += 1;
      return opened === 1 ? post : { url: 'https://www.linkedin.com/checkpoint/challenge/', nodes: { [SELECTORS.challengeForm]: [{}] } };
    });
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('challenge');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/in/jonas/'
    ]);
  });

  it('reports a post whose reaction control it cannot find, and still reads the comments', async () => {
    const h = harness(() => ({ nodes: { [SCRAPE_SELECTORS.commentItem]: [engager('sofia', 'Sofia Rossi')] } }));
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.degraded.join(' ')).toContain('no reaction control');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual(['https://www.linkedin.com/in/sofia/']);
  });
});

describe('canonicalProfileUrl', () => {
  it('reduces every form the ledger and the harvest produce to one string', () => {
    const canonical = 'https://www.linkedin.com/in/maya/';
    expect(canonicalProfileUrl('maya')).toBe(canonical);
    expect(canonicalProfileUrl('/in/maya')).toBe(canonical);
    expect(canonicalProfileUrl('https://linkedin.com/in/maya')).toBe(canonical);
    expect(canonicalProfileUrl('https://www.linkedin.com/in/maya/?trk=search')).toBe(canonical);
    expect(canonicalProfileUrl('https://evil.example/in/maya/')).toBeNull();
  });
});
