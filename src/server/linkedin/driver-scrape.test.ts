import { describe, expect, it } from 'vitest';
import { SELECTORS } from './driver.js';
import { ACTION_GAP_SECONDS } from './limits.js';
import {
  SALES_NAVIGATOR_PAGE_PARAM,
  SCRAPE_SELECTORS,
  canonicalProfileUrl,
  contentSearchUrlFor,
  postUrlFor,
  salesNavigatorUrlFor,
  scrapeContentSearch,
  scrapeGapSeconds,
  scrapePostEngagers,
  scrapeSalesNavigatorResults,
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
      locator: (inner) =>
        locator(
          pool.flatMap((node) => node.children?.[inner] ?? []),
          inner
        ),
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

function engager(handle: string, name: string, headline = 'Head of Ops'): StubNode {
  return {
    children: {
      [SCRAPE_SELECTORS.engagerProfileLink]: [
        { attrs: { href: `https://www.linkedin.com/in/${handle}/` } }
      ],
      [SCRAPE_SELECTORS.engagerName]: [{ text: name }],
      [SCRAPE_SELECTORS.engagerHeadline]: [{ text: headline }],
      [SCRAPE_SELECTORS.commentAuthorName]: [{ text: name }],
      [SCRAPE_SELECTORS.commentAuthorHeadline]: [{ text: headline }]
    }
  };
}

function searchScreen(cards: StubNode[]): Screen {
  return { nodes: { [SCRAPE_SELECTORS.searchResultCard]: cards } };
}

/** One Sales Navigator lead row: its own container, its own lockup selectors. */
function salesCard(
  handle: string,
  name: string,
  headline = 'VP Sales',
  company = 'Nimbus'
): StubNode {
  return {
    children: {
      [SCRAPE_SELECTORS.salesResultProfileLink]: [
        { attrs: { href: `/in/${handle}/?trk=sales-nav` } }
      ],
      [SCRAPE_SELECTORS.salesResultName]: [{ text: `  ${name} ` }],
      [SCRAPE_SELECTORS.salesResultHeadline]: [{ text: headline }],
      [SCRAPE_SELECTORS.salesResultCompany]: [{ text: company }]
    }
  };
}

function salesScreen(cards: StubNode[]): Screen {
  return { nodes: { [SCRAPE_SELECTORS.salesResultCard]: cards } };
}

/** One content-search row: a post, with its author on the card. */
function contentCard(
  activityId: string,
  handle: string,
  name: string,
  options: { link?: boolean; headline?: string } = {}
): StubNode {
  const children: Record<string, StubNode[]> = {
    [SCRAPE_SELECTORS.contentAuthorLink]: [{ attrs: { href: `/in/${handle}/?miniProfileUrn=x` } }],
    [SCRAPE_SELECTORS.contentAuthorName]: [{ text: name }],
    [SCRAPE_SELECTORS.contentAuthorHeadline]: [{ text: options.headline ?? 'Founder' }]
  };
  if (options.link !== false) {
    children[SCRAPE_SELECTORS.contentPostLink] = [
      { attrs: { href: `/feed/update/urn:li:activity:${activityId}/` } }
    ];
  }
  return { attrs: { 'data-urn': `urn:li:activity:${activityId}` }, children };
}

function contentScreen(cards: StubNode[]): Screen {
  return { nodes: { [SCRAPE_SELECTORS.contentResultCard]: cards } };
}

const SEARCH_URL =
  'https://www.linkedin.com/search/results/people/?keywords=cto&network=%5B%22S%22%5D';
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/';
const SALES_URL = 'https://www.linkedin.com/sales/search/people?query=(keywords%3Acto)';
const CONTENT_URL = 'https://www.linkedin.com/search/results/content/?keywords=rag%20evals';

function pageNumber(url: string): number {
  return Number(new URL(url).searchParams.get('page') ?? '1');
}

describe('the URL is checked before anything is fetched', () => {
  it("accepts a people-search URL and keeps the operator's filters verbatim", () => {
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
    expect(
      postUrlFor('https://www.linkedin.com/posts/maya-chen_hiring-activity-7000-abcd/')
    ).not.toBeNull();
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
      if (page === 1)
        return searchScreen([card('maya', 'Maya Chen'), card('jonas', 'Jonas Keller')]);
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
    expect(result.leads[0]).toMatchObject({
      name: 'Maya Chen',
      headline: 'Founder',
      company: 'Acme'
    });
    expect(result.pagesWalked).toBe(3);
    expect(h.fetches).toHaveLength(3);
  });

  it('dedupes a person LinkedIn shows on two pages', async () => {
    const h = harness((url) =>
      pageNumber(url) <= 2 ? searchScreen([card('maya', 'Maya Chen')]) : searchScreen([])
    );
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.leads).toHaveLength(1);
    // A duplicate is not a drop -- they were already recorded.
    expect(result.dropped).toBe(0);
  });

  it('drops a row whose link points off LinkedIn instead of storing it', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? searchScreen([
            {
              children: {
                [SCRAPE_SELECTORS.searchResultProfileLink]: [
                  { attrs: { href: 'https://evil.example/in/maya/' } }
                ]
              }
            },
            card('jonas', 'Jonas Keller')
          ])
        : searchScreen([])
    );
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/jonas/'
    ]);
    expect(result.dropped).toBe(1);
  });
});

describe('the caps are real and say what they dropped', () => {
  it('stops at the result cap and reports every row it did not return', async () => {
    const cards = Array.from({ length: 25 }, (_, index) =>
      card(`person-${index}`, `Person ${index}`)
    );
    const h = harness((url) => (pageNumber(url) === 1 ? searchScreen(cards) : searchScreen([])));

    const result = await scrapeSearchResults(h.page, SEARCH_URL, {
      maxResults: 10,
      sleep: h.sleep
    });

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
    const result = await scrapeSearchResults(h.page, SEARCH_URL, {
      maxPages: 3,
      maxResults: 500,
      sleep: h.sleep
    });
    expect(result.pagesWalked).toBe(3);
    expect(h.fetches).toHaveLength(3);
  });

  it('refuses to be talked past the hard ceilings', async () => {
    const h = harness(() => searchScreen([]));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, {
      maxPages: 10_000,
      maxResults: 10_000,
      sleep: h.sleep
    });
    // One empty page ends the walk, but the ceiling is what bounded the ask.
    expect(result.pagesWalked).toBe(1);
    expect(h.fetches).toHaveLength(1);
  });
});

describe('a page fetch is an action, so it is paced', () => {
  it('sleeps between fetches, inside the 30-120s band, and never before the first', async () => {
    const h = harness((url) =>
      pageNumber(url) <= 3 ? searchScreen([card(`p${pageNumber(url)}`, 'P')]) : searchScreen([])
    );
    await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });

    // Four fetches, three gaps. The first page is never delayed.
    expect(h.fetches).toHaveLength(4);
    expect(h.delays).toHaveLength(3);
    for (const delay of h.delays) {
      expect(delay).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min * 1000);
      expect(delay).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max * 1000);
    }
  });

  it('paces an identical walk identically, and two seeds differently', async () => {
    const run = async () => {
      const h = harness((url) =>
        pageNumber(url) <= 3 ? searchScreen([card('a', 'A')]) : searchScreen([])
      );
      await scrapeSearchResults(h.page, SEARCH_URL, { seed: 'llsrc_fixed', sleep: h.sleep });
      return h.delays;
    };
    expect(await run()).toEqual(await run());
    // This asserted `toBe(ACTION_GAP_SECONDS.max)` while the gap was pinned,
    // which made a ten-page walk emit one interval ten times -- the same
    // artefact the sender emitted as 123, 123, 123, 124, 123, 123. The header
    // of `driver-scrape.ts` has always claimed "the same seeded draw the worker
    // uses"; this is that claim being true again.
    expect(scrapeGapSeconds('llsrc_a:page:2')).not.toBe(scrapeGapSeconds('llsrc_b:page:2'));
    for (const seed of ['llsrc_a:page:2', 'llsrc_b:page:2', 'llsrc_c:page:9']) {
      expect(scrapeGapSeconds(seed)).toBe(scrapeGapSeconds(seed));
      expect(scrapeGapSeconds(seed)).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min);
      expect(scrapeGapSeconds(seed)).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max);
    }
  });
});

describe('a wall stops the walk immediately', () => {
  it('reports a challenge and keeps the pages it already read', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? searchScreen([card('maya', 'Maya Chen')])
        : {
            url: 'https://www.linkedin.com/checkpoint/challenge/',
            nodes: { [SELECTORS.challengeForm]: [{}] }
          }
    );

    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('challenge');
    // Page one already happened and already cost the account whatever it cost.
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/'
    ]);
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
    const h = harness(() => ({
      nodes: { [SELECTORS.limitWall]: [{}], [SELECTORS.challengeForm]: [{}] }
    }));
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
    const h = harness(() => ({
      nodes: { [SCRAPE_SELECTORS.searchNoResults]: [{ text: 'No results found' }] }
    }));
    const result = await scrapeSearchResults(h.page, SEARCH_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.degraded).toEqual([]);
  });
});

describe("a post's engagers", () => {
  const modal: Screen = {
    nodes: {
      [SCRAPE_SELECTORS.reactorsModal]: [{}],
      [SCRAPE_SELECTORS.reactorItem]: [
        engager('maya', 'Maya Chen'),
        engager('jonas', 'Jonas Keller')
      ]
    }
  };
  const post: Screen = {
    nodes: {
      [SCRAPE_SELECTORS.reactionsEntry]: [{ text: '42' }],
      // Sofia commented; Maya both reacted and commented.
      [SCRAPE_SELECTORS.commentItem]: [
        engager('sofia', 'Sofia Rossi'),
        engager('maya', 'Maya Chen')
      ]
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
    expect(result.leads[0]).toMatchObject({ firstName: 'Maya', lastName: 'Chen' });
    // Neither surface renders a company ELEMENT, so the headline is the only
    // place one can come from -- and "Head of Ops" names no employer, so this
    // one is still null. Read, never invented.
    expect(result.leads[0].company).toBeNull();
    // MAYA REACTED AND COMMENTED. She is still one row -- and the row now says
    // she commented, which is the fact the old flat merge threw away. It is
    // also the fact that tagging reactors `post` would have overwritten, had
    // `Harvest.add` kept letting the first sighting win.
    expect(result.leads[0].interactionKind).toBe('comment');
    expect(result.leads[0].postUrl).toBe(POST_URL);
    // Jonas only reacted. `post` -- he engaged with this post and wrote no
    // words -- rather than null, which the "How" column renders as an em dash
    // for every reactor on a source whose whole identity is that post.
    expect(result.leads[1]).toMatchObject({ interactionKind: 'post', postUrl: POST_URL });
    // The post is opened, the modal is read, the post is re-opened for comments.
    expect(h.fetches).toEqual([POST_URL, POST_URL]);
    expect(h.delays).toHaveLength(1);
  });

  it('reads the employer out of an engager headline, and invents none when there is none', async () => {
    const h = harness(() => ({
      nodes: {
        [SCRAPE_SELECTORS.reactionsEntry]: [{ text: '3' }],
        [SCRAPE_SELECTORS.commentItem]: [
          engager('sofia', 'Sofia Rossi', 'Head of RevOps at Luma'),
          // The separator LinkedIn's own copy uses just as often, and a
          // run-on tail that is a slogan rather than an employer.
          engager('ravi', 'Ravi Patel', 'Founder @ Nomic Foundation | We are hiring'),
          // No separator at all: still null, exactly as before.
          engager('jonas', 'Jonas Keller', 'Founder')
        ]
      },
      click: {
        [SCRAPE_SELECTORS.reactionsEntry]: { nodes: { [SCRAPE_SELECTORS.reactorsModal]: [{}] } }
      }
    }));
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });
    // `Company` is one of the three fields every lead is promised, and keyword
    // discovery used to hardcode it null for every single person it found.
    expect(result.leads.map((lead) => lead.company)).toEqual(['Luma', 'Nomic Foundation', null]);
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
      return opened === 1
        ? post
        : {
            url: 'https://www.linkedin.com/checkpoint/challenge/',
            nodes: { [SELECTORS.challengeForm]: [{}] }
          };
    });
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('challenge');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/in/jonas/'
    ]);
  });

  it('reports a post whose reaction control it cannot find, and still reads the comments', async () => {
    const h = harness(() => ({
      nodes: { [SCRAPE_SELECTORS.commentItem]: [engager('sofia', 'Sofia Rossi')] }
    }));
    const result = await scrapePostEngagers(h.page, POST_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.degraded.join(' ')).toContain('no reaction control');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/sofia/'
    ]);
  });
});

describe('Sales Navigator', () => {
  it('accepts its own search URL, keeps the query verbatim, and refuses every other shape', () => {
    expect(salesNavigatorUrlFor(SALES_URL)).toBe(SALES_URL);
    // The Sales Navigator query grammar IS the search. Re-encoding it is how a
    // filtered search quietly becomes an unfiltered one.
    expect(salesNavigatorUrlFor(SALES_URL)).toContain('query=(keywords%3Acto)');
    expect(salesNavigatorUrlFor(SEARCH_URL)).toBeNull();
    expect(salesNavigatorUrlFor('https://evil.example/sales/search/people')).toBeNull();
    expect(salesNavigatorUrlFor('https://www.linkedin.com/sales/lead/ACwAAA/')).toBeNull();
    // And the basic walk does not accept it either: two surfaces, two rules.
    expect(searchResultsUrlFor(SALES_URL)).toBeNull();
  });

  it('never navigates for a URL it refused', async () => {
    const { page, fetches } = harness(() => salesScreen([]));
    const result = await scrapeSalesNavigatorResults(page, SEARCH_URL);
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('not_found');
    expect(fetches).toEqual([]);
  });

  it('reads its own rows, paginates on its own page parameter, and canonicalises every link', async () => {
    const h = harness((url) => {
      const page = pageNumber(url);
      if (page === 1)
        return salesScreen([salesCard('maya', 'Maya Chen'), salesCard('jonas', 'Jonas Keller')]);
      if (page === 2)
        return salesScreen([salesCard('sofia', 'Sofia Rossi', 'Head of RevOps', 'Luma')]);
      return salesScreen([]);
    });

    const result = await scrapeSalesNavigatorResults(h.page, SALES_URL, { sleep: h.sleep });

    expect(result.ok).toBe(true);
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/',
      'https://www.linkedin.com/in/jonas/',
      'https://www.linkedin.com/in/sofia/'
    ]);
    // Sales Navigator DOES render an employer, unlike a post's engagers.
    expect(result.leads[2]).toMatchObject({
      name: 'Sofia Rossi',
      firstName: 'Sofia',
      lastName: 'Rossi',
      headline: 'Head of RevOps',
      company: 'Luma'
    });
    expect(result.leads[0].profileUrl).not.toContain('trk=');
    expect(h.fetches).toHaveLength(3);
    expect(new URL(h.fetches[1]).searchParams.get(SALES_NAVIGATOR_PAGE_PARAM)).toBe('2');
    // The operator's own query survived the pagination rewrite.
    expect(h.fetches[1]).toContain('query=');
  });

  it('drops a row whose only link is a Sales Navigator lead URN rather than storing it', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? salesScreen([
            {
              children: {
                [SCRAPE_SELECTORS.salesResultProfileLink]: [
                  { attrs: { href: '/sales/lead/ACwAAABc,NAME_SEARCH,abcd' } }
                ]
              }
            },
            salesCard('jonas', 'Jonas Keller')
          ])
        : salesScreen([])
    );
    const result = await scrapeSalesNavigatorResults(h.page, SALES_URL, { sleep: h.sleep });
    // A URN is not addressable as a person and would never match that human's
    // exclusion row. Dropped and COUNTED.
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/jonas/'
    ]);
    expect(result.dropped).toBe(1);
  });

  it('stops on a challenge exactly as the basic walk does, keeping what it read', async () => {
    const h = harness((url) =>
      pageNumber(url) === 1
        ? salesScreen([salesCard('maya', 'Maya Chen')])
        : {
            url: 'https://www.linkedin.com/checkpoint/challenge/',
            nodes: { [SELECTORS.challengeForm]: [{}] }
          }
    );
    const result = await scrapeSalesNavigatorResults(h.page, SALES_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('challenge');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/'
    ]);
    expect(h.fetches).toHaveLength(2);
  });

  it('paces its fetches from the same band, and reports drift against its own table', async () => {
    const h = harness(() => salesScreen([salesCard('a', 'A B')]));
    await scrapeSalesNavigatorResults(h.page, SALES_URL, { maxPages: 3, sleep: h.sleep });
    expect(h.delays).toHaveLength(2);
    for (const delay of h.delays) {
      expect(delay).toBeGreaterThanOrEqual(ACTION_GAP_SECONDS.min * 1000);
      expect(delay).toBeLessThanOrEqual(ACTION_GAP_SECONDS.max * 1000);
    }

    const drifted = harness(() => ({ nodes: {} }));
    const result = await scrapeSalesNavigatorResults(drifted.page, SALES_URL, {
      sleep: drifted.sleep
    });
    expect(result.ok).toBe(true);
    expect(result.degraded.join(' ')).toContain('Sales Navigator');
    expect(result.degraded.join(' ')).toContain('SCRAPE_SELECTORS');
  });
});

describe('keyword discovery through posts and comments', () => {
  const ACTIVITY = '7100000000000000001';
  const PERMALINK = `https://www.linkedin.com/feed/update/urn:li:activity:${ACTIVITY}/`;

  it('accepts a content-search URL and refuses a people search', () => {
    expect(contentSearchUrlFor(CONTENT_URL)).toBe(CONTENT_URL);
    expect(contentSearchUrlFor(SEARCH_URL)).toBeNull();
    expect(contentSearchUrlFor('https://evil.example/search/results/content/')).toBeNull();
    expect(searchResultsUrlFor(CONTENT_URL)).toBeNull();
  });

  it('never navigates for a URL it refused', async () => {
    const h = harness(() => contentScreen([]));
    const result = await scrapeContentSearch(h.page, SEARCH_URL);
    expect(result.failureKind).toBe('not_found');
    expect(h.fetches).toEqual([]);
  });

  it('yields the post author and every commenter, each with the post URL and how they touched it', async () => {
    const h = harness((url) => {
      if (url.includes('/search/results/content/')) {
        return pageNumber(url) === 1
          ? contentScreen([
              contentCard(ACTIVITY, 'maya', 'Dr. Maya Chen, MBA', { headline: 'CTO at Acme' })
            ])
          : contentScreen([]);
      }
      return {
        nodes: {
          [SCRAPE_SELECTORS.commentItem]: [
            engager('jonas', 'Jonas Keller', 'VP Eng at Nimbus'),
            engager('sofia', 'Sofia Rossi')
          ]
        }
      };
    });

    const result = await scrapeContentSearch(h.page, CONTENT_URL, { sleep: h.sleep });

    expect(result.ok).toBe(true);
    // THE AUTHOR IS A LEAD TOO, and is a different one from a commenter: "they
    // wrote about this" and "they replied to it" are different openings.
    expect(result.leads.map((lead) => [lead.profileUrl, lead.interactionKind])).toEqual([
      ['https://www.linkedin.com/in/maya/', 'post'],
      ['https://www.linkedin.com/in/jonas/', 'comment'],
      ['https://www.linkedin.com/in/sofia/', 'comment']
    ]);
    // Every one of them says WHICH post they were found on.
    expect(result.leads.every((lead) => lead.postUrl === PERMALINK)).toBe(true);
    // The name arrives split and scrubbed, not as one string with a title on it.
    expect(result.leads[0]).toMatchObject({
      name: 'Maya Chen',
      firstName: 'Maya',
      lastName: 'Chen'
    });
    expect(result.leads[1]).toMatchObject({ firstName: 'Jonas', lastName: 'Keller' });
    // AND EVERY ONE OF THEM HAS A COMPANY WHERE THE PAGE SHOWED ONE. Keyword
    // discovery hardcoded `company: null` for the author and every commenter
    // alike, so `{{company}}` rendered blank in every message built from a
    // lead it found -- on a field the product promises for every lead.
    expect(result.leads.map((lead) => lead.company)).toEqual(['Acme', 'Nimbus', null]);
    // One results page, one post opened, then the next results page.
    expect(h.fetches[1]).toBe(PERMALINK);
  });

  it('rebuilds the permalink from the card urn when the row carries no link', async () => {
    const h = harness((url) => {
      if (url.includes('/search/results/content/')) {
        return pageNumber(url) === 1
          ? contentScreen([contentCard(ACTIVITY, 'maya', 'Maya Chen', { link: false })])
          : contentScreen([]);
      }
      return { nodes: { [SCRAPE_SELECTORS.commentItem]: [engager('jonas', 'Jonas Keller')] } };
    });
    const result = await scrapeContentSearch(h.page, CONTENT_URL, { sleep: h.sleep });
    expect(result.leads[0].postUrl).toBe(PERMALINK);
    expect(h.fetches).toContain(PERMALINK);
  });

  it('stops on a challenge while reading a post, keeping the author it already had', async () => {
    const h = harness((url) => {
      if (url.includes('/search/results/content/'))
        return contentScreen([contentCard(ACTIVITY, 'maya', 'Maya Chen')]);
      return {
        url: 'https://www.linkedin.com/checkpoint/challenge/',
        nodes: { [SELECTORS.challengeForm]: [{}] }
      };
    });
    const result = await scrapeContentSearch(h.page, CONTENT_URL, { sleep: h.sleep });
    expect(result.failureKind).toBe('challenge');
    expect(result.leads.map((lead) => lead.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/'
    ]);
  });

  it('names the table to repair when the content rows do not match', async () => {
    const h = harness(() => ({ nodes: {} }));
    const result = await scrapeContentSearch(h.page, CONTENT_URL, { sleep: h.sleep });
    expect(result.ok).toBe(true);
    expect(result.leads).toEqual([]);
    expect(result.degraded.join(' ')).toContain('SCRAPE_SELECTORS');
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
