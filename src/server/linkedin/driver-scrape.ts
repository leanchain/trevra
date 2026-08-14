import { createHash } from 'node:crypto';
import {
  SELECTORS,
  normalisedProfileUrl,
  profileUrlFor,
  type LinkedInDriverResult,
  type LinkedInFailureKind,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import { hoverClick, readPage, settleMs } from './human.js';
import { splitAndScrubName } from './lead-import.js';
import { ACTION_GAP_SECONDS } from './limits.js';

/**
 * READING LISTS OF PEOPLE OFF LINKEDIN. THIS FILE IS NOT LIKE THE OTHERS.
 *
 * Everything `driver.ts` does is the operator acting on their own account:
 * sending their own invite, typing their own message, loading a profile they
 * could have loaded by hand. THIS FILE HARVESTS OTHER PEOPLE'S PROFILES OUT OF
 * SEARCH RESULTS AND POST ENGAGEMENT, which is SCRAPING, and scraping is the
 * thing LinkedIn's User Agreement names in so many words:
 *
 *   §8.2 forbids using "software, devices, scripts, robots or any other means
 *   or processes (such as crawlers, browser plugins and add-ons or any other
 *   technology) to scrape or copy" LinkedIn content -- and it names browser
 *   extensions BY CATEGORY, which is exactly what this is (plan §1.2).
 *
 * The hiQ litigation (settled Nov 2022, $500k judgment against hiQ) settled
 * that scraping PUBLIC data is not a CFAA violation. It settled nothing about
 * the contract: LinkedIn's breach-of-contract and trespass claims SURVIVED. So
 * "it is legal" is not "we may ship it" -- the exposure is contractual, and it
 * lands on the OPERATOR'S OWN ACCOUNT, not on ours (plan §1.2, §6A).
 *
 * FOUR CONSEQUENCES, and they are the whole design of this file:
 *
 * 1. ITS OWN OPT-IN, SEPARATE FROM SENDING. Nothing here is reachable without
 *    `leadSourcingEnabled()` in `leads.ts`, which is FALSE by default and which
 *    a hosted deployment can never turn on. Sending is a different decision
 *    from harvesting and gets a different switch.
 * 2. A PAGE FETCH IS AN ACTION. Walking ten search pages is ten automated
 *    requests in a burst, which is the "+120% surge within 24-48h" shape that
 *    plan §1.3 says precedes a disconnection. So every fetch after the first is
 *    paced from ACTION_GAP_SECONDS with the same seeded draw the worker uses,
 *    and there is NO `Math.random()` anywhere in this file.
 * 3. A HARD CAP, ALWAYS. Results and pages are both bounded, defaults 100 and
 *    10. "Walk the whole search" is not an option a caller can ask for.
 * 4. WHAT WAS DROPPED IS SAID OUT LOUD. A cap that silently truncates leaves an
 *    operator believing they have the whole list. Every truncation and every
 *    unreadable row lands in `degraded` as a sentence and in `dropped` as a
 *    count.
 *
 * A CHALLENGE STOPS EVERYTHING, IMMEDIATELY. Same rule as `driver.ts`: a login
 * or checkpoint wall means LinkedIn is asking for a human, and the one way to
 * turn a temporary restriction into a permanent ban is to keep fetching.
 * Whatever was already harvested comes back with the failure -- partial results
 * are not thrown away, because they cost the same account risk either way.
 *
 * NOTHING HERE THROWS, for the same reason nothing in `driver.ts` does.
 */

/* ---------------------------------------------------------------------------
 * The page surface. driver.ts's, plus the three reads a list needs.
 * ------------------------------------------------------------------------ */

/**
 * `LinkedInLocator` plus indexing, scoping and attribute reads.
 *
 * EXTENDED RATHER THAN REDEFINED. `driver.ts` needs one control at a time and
 * its locator says so: `first()`, `click()`, `fill()`, `textContent()`. A list
 * of 25 search results needs the i-th card, a selector evaluated INSIDE that
 * card, and the `href` off an anchor -- three methods Playwright's real
 * `Locator` has always had and that this file is the first to want. Declaring
 * a second, parallel locator type would be how the two drift into disagreeing
 * about what a page is; extending the imported one cannot.
 */
export interface LinkedInScrapeLocator extends LinkedInLocator {
  first(): LinkedInScrapeLocator;
  /** The i-th match, 0-based. Out of range is an empty locator, never a throw. */
  nth(index: number): LinkedInScrapeLocator;
  /** Scoped: the same selector evaluated inside THIS element's subtree. */
  locator(selector: string): LinkedInScrapeLocator;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
}

/** `LinkedInPage` whose `locator()` hands back the extended shape above. */
export interface LinkedInScrapePage extends LinkedInPage {
  locator(selector: string): LinkedInScrapeLocator;
  /**
   * OPTIONAL, and absent on every test fake in this repo.
   *
   * A results page that is read without ever being scrolled is the single
   * clearest "not a person" signal a list walk emits: LinkedIn's search surface
   * instruments scroll and pointer events, lazy-loads rows below the fold, and
   * a client that harvests twenty-five cards with zero wheel events has told it
   * everything it needs to know. See {@link browseList}. A page object without
   * a mouse simply skips that -- it is behaviour, never correctness.
   */
  mouse?: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
}

/* ---------------------------------------------------------------------------
 * What a harvest returns.
 * ------------------------------------------------------------------------ */

/**
 * One person, as the page showed them.
 *
 * `profileUrl` is canonical and is the only field that is never null: a lead we
 * cannot address is not a lead, so a row whose profile link would not
 * canonicalise is dropped rather than stored with a hole in it. The other three
 * are null when the page did not show them -- never '', never a guess, for the
 * same reason `LinkedInSeatRead` leaves an unread count null.
 */
export interface ScrapedLead {
  profileUrl: string;
  /** The scrubbed display name: `firstName` and `lastName` joined, or null. */
  name: string | null;
  /**
   * The name SPLIT AND SCRUBBED at the point of harvest, by the same
   * {@link splitAndScrubName} the CSV import uses.
   *
   * A scraped card says "Dr. Maya Chen, MBA 🙂" and a campaign template says
   * "Hi {{firstName}}". Splitting at STORAGE time rather than at send time is
   * the difference between one rule an operator can read and two that quietly
   * disagree -- the CSV path has scrubbed since day one, and a harvested lead
   * that skipped it was the same person under a different spelling.
   */
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  company: string | null;
  /**
   * The post this person was found on, canonical, or null when the surface was
   * not a post at all (a search result has no post behind it).
   */
  postUrl: string | null;
  /** How they touched that post. Null only for a search hit, which has no post. */
  interactionKind: LeadInteractionKind | null;
}

/**
 * HOW A LEAD TOUCHED THE POST THEY WERE FOUND ON.
 *
 * `comment` is somebody who wrote a reply. `post` is everybody else the POST
 * itself produced: its author, and the people who reacted to it.
 *
 * REACTORS USED TO CARRY NULL AND THAT WAS WRONG IN THE ONLY PLACE IT SHOWS.
 * The reasoning was defensible on its own terms -- a reactor left no words, so
 * calling them a commenter would put an opening line in an operator's mouth
 * that the page never supported. But the vocabulary this product speaks is
 * exactly two words, `post` and `comment`, and null is not a third one: it is
 * the absence of an answer, rendered as an em dash in the "How" column. A post
 * source that harvested 200 reactors therefore answered "how did you find
 * these people" with a dash 200 times, on a source whose whole identity is
 * that post. A reactor engaged with the POST and did not comment, which is
 * precisely what `post` means here and is a fact the page did support.
 *
 * `comment` STILL OUTRANKS `post` when one person did both -- see
 * `Harvest.add`. The database column carries exactly these two strings or NULL,
 * and NULL now means only "found in a people search, with no post behind it".
 */
export type LeadInteractionKind = 'post' | 'comment';

/**
 * The result of one harvest.
 *
 * EXTENDS `LinkedInDriverResult` rather than inventing a shape: `ok`,
 * `failureKind` and `detail` mean exactly what they mean everywhere else in
 * this subsystem, and a caller that already knows how to read a driver failure
 * needs to learn nothing new. The four added fields are what a LIST has and a
 * single action does not.
 *
 * `ok: false` STILL CARRIES `leads`. A challenge on page four does not unmake
 * pages one to three -- those fetches happened, they cost the account whatever
 * they cost, and discarding the people they returned would buy nothing back.
 */
export interface ScrapeResult extends LinkedInDriverResult {
  /** Deduped by canonical profile URL, in the order the pages showed them. */
  leads: ScrapedLead[];
  /** What could not be read, in plain sentences an operator can act on. */
  degraded: string[];
  /** Pages (or "load more" steps) actually fetched. */
  pagesWalked: number;
  /** Rows seen and NOT returned: over the cap, or with no usable profile link. */
  dropped: number;
}

export interface ScrapeOptions {
  /** Hard ceiling on people returned. Defaults to {@link DEFAULT_MAX_RESULTS}. */
  maxResults?: number;
  /** Hard ceiling on page fetches. Defaults to {@link DEFAULT_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Seeds the inter-fetch gaps. Defaults to the URL being walked, so the same
   * source produces the same pacing on any machine -- and a test can assert the
   * delays instead of tolerating them.
   */
  seed?: string;
  /** Defaults to a real timer. Injected so a test does not sleep for minutes. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/** What `leads.ts` needs; the fake in the tests implements exactly this. */
export interface LinkedInScrapeDriver {
  scrapeSearchResults(page: LinkedInScrapePage, searchUrl: string, opts?: ScrapeOptions): Promise<ScrapeResult>;
  scrapePostEngagers(page: LinkedInScrapePage, postUrl: string, opts?: ScrapeOptions): Promise<ScrapeResult>;
  /** `/sales/search/people` -- a different page, the same walk. */
  scrapeSalesNavigatorResults(page: LinkedInScrapePage, searchUrl: string, opts?: ScrapeOptions): Promise<ScrapeResult>;
  /** `/search/results/content` -- keyword discovery through posts and comments. */
  scrapeContentSearch(page: LinkedInScrapePage, contentUrl: string, opts?: ScrapeOptions): Promise<ScrapeResult>;
}

/**
 * 100 people, 10 fetches. Both are ceilings, neither is removable.
 *
 * A caller may lower them and may not raise them past {@link HARD_MAX_RESULTS}
 * and {@link HARD_MAX_PAGES}. "Unbounded" is not an option this function
 * offers, because the request that walks 400 search pages in one sitting is
 * precisely the burst plan §1.3 describes as preceding a disconnection -- and
 * an operator asking for it has no way to know that.
 */
export const DEFAULT_MAX_RESULTS = 100;
export const DEFAULT_MAX_PAGES = 10;
export const HARD_MAX_RESULTS = 500;
export const HARD_MAX_PAGES = 25;

/** Where a checkpoint lands. Same URL-level read as driver.ts's. */
const CHECKPOINT_PATH = /\/(checkpoint|uas\/login)\//i;

/** LinkedIn hosts this driver may navigate to. Nothing else, ever. */
const ALLOWED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);

const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 10_000;

/**
 * The pause after a page load, and the scroll that a read looks like.
 *
 * BOTH MOVED TO `human.ts` and are re-exported under their original names so
 * the call sites below read the same. They started here -- a constant 1,500ms
 * settle and no scroll at all was what a search walk emitted -- and then every
 * other driver turned out to need exactly the same two things: LinkedIn does
 * not score a search page differently from a profile page, and a client that
 * loads either one on a timer and never moves a pointer over it has said the
 * same thing about itself on both.
 *
 * `settleMs` stays exported because the scrape tests assert its determinism
 * directly, and that is worth keeping assertable.
 */
export { settleMs };
export const browseList = readPage;

function fail(failureKind: LinkedInFailureKind, detail: string, partial: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    ok: false,
    failureKind,
    detail,
    leads: partial.leads ?? [],
    degraded: partial.degraded ?? [],
    pagesWalked: partial.pagesWalked ?? 0,
    dropped: partial.dropped ?? 0
  };
}

/* ---------------------------------------------------------------------------
 * The selector table.
 * ------------------------------------------------------------------------ */

/**
 * EVERY DOM SELECTOR FOR THE TWO LIST SURFACES, IN ONE TABLE, ON PURPOSE.
 *
 * Same discipline and same reasoning as `SELECTORS` in driver.ts, and MORE
 * SO here: search results and the reactions modal are re-rendered far more
 * often than the profile action bar, and neither is documented anywhere. DRIFT
 * IS THE EXPECTED STEADY STATE OF THIS TABLE.
 *
 * The difference from driver.ts is what a miss MEANS. There, a missing control
 * meant an action could not be taken. Here a missing card selector means we
 * read FEWER PEOPLE THAN WERE THERE, which is a partial answer, not a failure --
 * so it lands in `degraded` and the harvest continues with what it has. Only a
 * wall stops a walk.
 *
 * Each entry lists alternates separated by commas: LinkedIn ships the old and
 * new markup side by side for weeks during a migration, and matching both is
 * what keeps a harvest working across one.
 */
export const SCRAPE_SELECTORS = {
  /* --- /search/results/people/ ---------------------------------------- */

  /**
   * One person's card. The unit everything else is read inside of.
   *
   * THE LAST ALTERNATE IS THE 2026 LAYOUT, and it is a different SHAPE from
   * the four before it. LinkedIn's rewrite ships hashed class names
   * (`._6d0b28b9.f7336c2f`) that change per build, generated ids, and no
   * `data-chameleon-result-urn` -- there is nothing stable left to name a row
   * BY. What survives is the structure: each result is one `<a>` to a profile
   * carrying a `componentkey`, with the name, headline, location and current
   * role as paragraphs inside it. So the card IS the link, which is why
   * `profileUrlIn` falls back to reading the card's own href.
   */
  searchResultCard:
    'li.reusable-search__result-container, div[data-chameleon-result-urn], '
    + 'div.search-results-container ul[role="list"] > li, ul.reusable-search__entity-result-list > li, '
    + 'a[componentkey][href*="/in/"]',
  /** The profile link on a card. `/in/` is the only part LinkedIn cannot change. */
  searchResultProfileLink: 'a[href*="/in/"]',
  /**
   * The 2026 row's text lines, read POSITIONALLY because they carry no other
   * mark: paragraph 1 is "Name • 2nd", 2 is the headline, 3 the location, 4
   * "Current: <title> at <company>". Only consulted when the named selectors
   * below match nothing, so the older markup is still read by name.
   */
  searchResultLine: 'p',
  /** The display name. LinkedIn wraps the visible copy in an aria-hidden span. */
  searchResultName:
    'span[aria-hidden="true"], .entity-result__title-text a span[aria-hidden="true"], .entity-result__title-text',
  /** The headline line, directly under the name. */
  searchResultHeadline: '.entity-result__primary-subtitle, div.t-14.t-black.t-normal',
  /** Location or current company, depending on the layout LinkedIn is serving. */
  searchResultSecondary: '.entity-result__secondary-subtitle, div.t-14.t-normal.t-black--light',
  /** "No results found". An empty search is a real answer, not drift. */
  searchNoResults: 'text=/No results found|no results matched|try different keywords/i',

  /* --- A post's engagers ---------------------------------------------- */

  /** The reaction count under a post; clicking it opens the reactors modal. */
  reactionsEntry:
    'button.social-details-social-counts__count-value, button[aria-label*="reaction" i], '
    + 'span.social-details-social-counts__reactions-count',
  /** The modal itself. Its absence after the click is drift, not a wall. */
  reactorsModal: 'div.social-details-reactors-modal, div[role="dialog"]',
  /** One reactor row inside the modal. */
  reactorItem:
    'li.social-details-reactors-tab-body-list-item, div[role="dialog"] li.artdeco-list__item, div[role="dialog"] li',
  /** The profile link on a reactor row or a comment header. */
  engagerProfileLink: 'a[href*="/in/"]',
  /** The name and headline as the modal renders them. */
  engagerName: 'span[aria-hidden="true"], .artdeco-entity-lockup__title',
  engagerHeadline: '.artdeco-entity-lockup__subtitle, .artdeco-entity-lockup__caption',
  /** "Load more" inside the modal. Each click is another fetch, so each is paced. */
  loadMoreReactors:
    'div[role="dialog"] button.scaffold-finite-scroll__load-button, '
    + 'div[role="dialog"] button[aria-label*="Load more" i], div[role="dialog"] button.artdeco-button--muted',
  /** One comment on the post page. */
  commentItem: 'article.comments-comment-entity, article.comments-comment-item, article.comments-post-meta',
  commentAuthorName: '.comments-post-meta__name-text, span.comments-comment-meta__description-title',
  commentAuthorHeadline: '.comments-post-meta__headline, span.comments-comment-meta__description-subtitle',
  /** "Load more comments". Same pacing rule as the reactors button. */
  loadMoreComments:
    'button.comments-comments-list__load-more-comments-button, button[aria-label*="more comments" i], '
    + 'button.comments-comments-list__show-previous-container button',

  /* --- /sales/search/people (Sales Navigator) -------------------------- */

  /**
   * One lead row in the Sales Navigator result list.
   *
   * A DIFFERENT CONTAINER FROM BASIC SEARCH, which is the whole reason this
   * surface has its own entries rather than reusing the ones above: Sales
   * Navigator renders an `artdeco-list` of lockups inside its own results
   * frame, with none of `reusable-search__result-container`,
   * `data-chameleon-result-urn` or the 2026 `componentkey` anchor. A walk
   * pointed at it with the basic selectors reads zero rows and reports drift
   * for a page that was rendering perfectly.
   */
  salesResultCard:
    'ol.artdeco-list > li.artdeco-list__item, div[data-x-search-result], '
    + 'li.search-results__result-item, div.search-results-container ol > li',
  /**
   * The PUBLIC profile link on a lead row.
   *
   * Sales Navigator's own name link points at `/sales/lead/<urn>,...`, which is
   * not addressable as a person: it does not canonicalise to `/in/<handle>`,
   * it would not match the same human's exclusion row, and storing it would
   * quietly break the one comparison lead sourcing exists to keep honest. So
   * only an `/in/` link is accepted, and a row without one is DROPPED and
   * counted -- never stored under a Sales Navigator URN.
   */
  salesResultProfileLink: 'a[href*="/in/"]',
  salesResultName: 'span[data-anonymize="person-name"], .result-lockup__name, .artdeco-entity-lockup__title',
  salesResultHeadline: 'span[data-anonymize="title"], .result-lockup__highlight-keyword, .artdeco-entity-lockup__subtitle',
  /** Sales Navigator DOES render an employer of its own, unlike every other surface here. */
  salesResultCompany: 'a[data-anonymize="company-name"], span[data-anonymize="company-name"], .result-lockup__position-company',
  salesNoResults: 'text=/No results found|No leads found|try a different search/i',

  /* --- /search/results/content (keyword discovery) --------------------- */

  /** One post in a content-search result list. */
  contentResultCard:
    'div.search-results-container div.feed-shared-update-v2, div[data-urn*="urn:li:activity"], '
    + 'li.reusable-search__result-container, div[data-chameleon-result-urn]',
  /**
   * The permalink on a content-search row. Falls back to the card's own
   * `data-urn`, which the feed renderer has carried through every layout so
   * far and which is enough to rebuild the permalink exactly.
   */
  contentPostLink: 'a[href*="/feed/update/"], a[href*="/posts/"]',
  /** The post's AUTHOR -- interaction kind `post`. */
  contentAuthorLink: 'a[href*="/in/"]',
  contentAuthorName: '.update-components-actor__title, span.update-components-actor__title span[aria-hidden="true"]',
  contentAuthorHeadline: '.update-components-actor__description, span.update-components-actor__description',
  contentNoResults: 'text=/No results found|no results matched|try different keywords/i'
} as const;

/* ---------------------------------------------------------------------------
 * URL validation. Done BEFORE anything is navigated to.
 * ------------------------------------------------------------------------ */

/**
 * The canonical people-search URL for an operator-supplied string, or null.
 *
 * SAME REASONING AS `profileUrlFor`, TWICE OVER. The string is typed or pasted
 * by a human and this driver navigates an AUTHENTICATED browser to it, so
 * `https://evil.example/steal` would otherwise open a session-bearing tab on
 * somebody else's site. AND the shape is checked, not just the host: a lead
 * source pointed at `/feed/` or `/messaging/` is not a search, and walking ten
 * pages of one would be ten fetches spent on nothing.
 *
 * The query string is preserved verbatim -- keywords, filters and facets are
 * the operator's search, and re-encoding them is how a filtered search quietly
 * becomes an unfiltered one. Only `page` is ours to set.
 */
export function searchResultsUrlFor(raw: string): string | null {
  const parsed = linkedInUrl(raw);
  if (!parsed) return null;
  if (!/^\/search\/results\/people\/?$/.test(parsed.pathname)) return null;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Sales Navigator's own pagination parameter.
 *
 * NAMED RATHER THAN INLINED because it is not the basic search's parameter
 * even where it spells the same: they are two products with two routers, and
 * the day one of them moves to a cursor is the day a shared literal silently
 * paginates the wrong surface. One constant, one place to fix.
 */
export const SALES_NAVIGATOR_PAGE_PARAM = 'page';

/**
 * The canonical Sales Navigator people-search URL, or null.
 *
 * SAME RULE AS `searchResultsUrlFor`, DIFFERENT PATH. `/sales/search/people`
 * is a separate product on the same host with its own result list and its own
 * query grammar (`query=(...)`), and the query string is preserved verbatim
 * for exactly the reason it is preserved for basic search: the facets ARE the
 * search, and re-encoding them is how a filtered search quietly becomes an
 * unfiltered one on the next run.
 */
export function salesNavigatorUrlFor(raw: string): string | null {
  const parsed = linkedInUrl(raw);
  if (!parsed) return null;
  if (!/^\/sales\/search\/people\/?$/.test(parsed.pathname)) return null;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * The canonical content-search URL, or null.
 *
 * KEYWORDS FIND POSTS, AND POSTS FIND PEOPLE. `/search/results/content` is the
 * only LinkedIn surface that answers "who is talking about X" -- the people
 * search answers "whose PROFILE says X", which is a different and much smaller
 * question. A keyword source pointed at the people search can never surface
 * somebody who wrote about the topic yesterday and does not mention it in
 * their headline.
 */
export function contentSearchUrlFor(raw: string): string | null {
  const parsed = linkedInUrl(raw);
  if (!parsed) return null;
  if (!/^\/search\/results\/content\/?$/.test(parsed.pathname)) return null;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * The canonical post URL for an operator-supplied string, or null.
 *
 * Both shapes LinkedIn hands out are accepted, because both are what an
 * operator has in their clipboard: the `/feed/update/urn:li:activity:...`
 * permalink and the `/posts/<slug>` share link.
 */
export function postUrlFor(raw: string): string | null {
  const parsed = linkedInUrl(raw);
  if (!parsed) return null;
  const path = parsed.pathname;
  const isPermalink = /^\/feed\/update\/urn:li:(activity|share|ugcPost):[A-Za-z0-9_-]+\/?$/.test(path);
  const isShareLink = /^\/posts\/[A-Za-z0-9%._-]+\/?$/.test(path);
  if (!isPermalink && !isShareLink) return null;
  parsed.hash = '';
  return parsed.toString();
}

/** An https LinkedIn URL, or null. The host check every other check builds on. */
function linkedInUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed;
}

/**
 * Any handle-or-URL reduced to the one canonical profile form, or null.
 *
 * Composed from driver.ts's two functions rather than written afresh:
 * `profileUrlFor` expands a bare handle and rejects a foreign host,
 * `normalisedProfileUrl` drops the query and hash. A harvested href carries
 * `?miniProfileUrn=...` every single time, and a lead stored with it would be a
 * different string from the same person's exclusion row -- which is exactly the
 * comparison this exists to keep honest.
 */
export function canonicalProfileUrl(raw: string): string | null {
  const expanded = profileUrlFor(raw);
  if (!expanded) return null;
  return normalisedProfileUrl(expanded);
}

/* ---------------------------------------------------------------------------
 * Pacing. A page fetch is an action.
 * ------------------------------------------------------------------------ */

/**
 * mulberry32, seeded from a hash of the source and the step.
 *
 * The third copy of this generator in the subsystem, and copied for the reason
 * `local-worker.ts` records against the second: the alternative is a driver
 * that imports the worker, which would drag `node:fs`, the secrets vault and
 * the Playwright loader into every module that wants to read a search page.
 * Six lines is the cheaper side of that trade.
 */
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Seconds to wait before the next FETCH, drawn from ACTION_GAP_SECONDS.
 *
 * The same 30-120s band the worker paces invites with (plan §1.4), applied to
 * page loads, because from LinkedIn's side a burst of ten search pages and a
 * burst of ten profile views are the same automated burst. Randomised here
 * means UNPREDICTABLE TO LINKEDIN, not unreproducible to us: identical inputs
 * give identical gaps on every machine and Node version, so the pacing is
 * assertable rather than merely hoped for.
 */
export function scrapeGapSeconds(seed: string): number {
  const digest = createHash('sha256').update(seed).digest('hex');
  const random = seededRandom(digest);
  return ACTION_GAP_SECONDS.min + random() * (ACTION_GAP_SECONDS.max - ACTION_GAP_SECONDS.min);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/* ---------------------------------------------------------------------------
 * Page reads. None of them throws.
 * ------------------------------------------------------------------------ */

async function count(locator: LinkedInScrapeLocator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

async function present(page: LinkedInScrapePage, selector: string): Promise<boolean> {
  return (await count(page.locator(selector))) > 0;
}

/**
 * The stop-now reads, done before anything on the page is believed.
 *
 * Identical order and identical reasoning to `detectWall` in driver.ts -- a
 * challenge outranks a limit wall, because a checkpoint page can also render
 * the words "invitation limit" and the human-intervention case must win. It is
 * re-implemented rather than imported because driver.ts keeps its copy private;
 * the SELECTORS it reads are the shared, exported table, so the two cannot
 * drift about what a wall looks like.
 */
async function detectWall(page: LinkedInScrapePage): Promise<LinkedInFailureKind | null> {
  let url = '';
  try {
    url = page.url();
  } catch {
    url = '';
  }
  if (CHECKPOINT_PATH.test(url)) return 'challenge';
  if (await present(page, SELECTORS.challengeForm)) return 'challenge';
  if (await present(page, SELECTORS.restrictionNotice)) return 'limit_wall';
  if (await present(page, SELECTORS.limitWall)) return 'limit_wall';
  return null;
}

/** The first match's collapsed text, scoped to one card. Null for unreadable. */
async function textIn(card: LinkedInScrapeLocator, selector: string): Promise<string | null> {
  try {
    const inner = card.locator(selector);
    if ((await inner.count()) === 0) return null;
    const text = await inner.first().textContent({ timeout: CLICK_TIMEOUT_MS });
    const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
    return collapsed || null;
  } catch {
    return null;
  }
}

/**
 * The canonical profile URL a card links to. Null when there is no usable link.
 *
 * SCOPED LOOKUP FIRST, THE CARD ITSELF SECOND. A scoped locator matches
 * DESCENDANTS only, so on the 2026 layout -- where the card is itself the
 * `<a>` -- the inner search finds nothing and the row would be dropped as
 * unreadable while its href sat on the element we were already holding.
 */
async function profileUrlIn(card: LinkedInScrapeLocator, selector: string): Promise<string | null> {
  try {
    const link = card.locator(selector);
    const href = (await link.count()) === 0
      ? await card.getAttribute('href', { timeout: CLICK_TIMEOUT_MS })
      : await link.first().getAttribute('href', { timeout: CLICK_TIMEOUT_MS });
    if (!href) return null;
    // Relative hrefs are the common case in LinkedIn's markup. Resolved against
    // the canonical host rather than `page.url()`, so a redirect to a foreign
    // host could not make a foreign link look like a LinkedIn one.
    let absolute: string;
    try {
      absolute = new URL(href, 'https://www.linkedin.com').toString();
    } catch {
      return null;
    }
    return canonicalProfileUrl(absolute);
  } catch {
    return null;
  }
}

/**
 * Name, headline and company off a 2026 search row, read by paragraph order.
 *
 * POSITIONAL BECAUSE THERE IS NOTHING ELSE. The row's four lines carry hashed
 * classes and no roles, ids or data attributes; their ORDER is the only thing
 * about them a reader can hold onto. Each field is null when its line is
 * absent, never a guess and never the wrong line pressed into service:
 * `ScrapedLead` already means "the page did not show it" by null, and a
 * headline silently holding a location would be worse than a blank one.
 *
 * The name line ends with the connection degree ("Ada Lovelace • 2nd"), which
 * is LinkedIn's own separator and is cut here rather than stored. The company
 * comes off the "Current: Head of Engineering at Nomic Foundation" line, which
 * is the only line naming an employer, through the one shared
 * {@link companyFromHeadline} every surface in this file now uses.
 */
async function readRowLines(card: LinkedInScrapeLocator): Promise<Pick<ScrapedLead, 'name' | 'headline' | 'company'>> {
  const empty = { name: null, headline: null, company: null };
  try {
    const lines = card.locator(SCRAPE_SELECTORS.searchResultLine);
    const total = Math.min(await lines.count(), 6);
    const read: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const text = await lines.nth(index).textContent({ timeout: CLICK_TIMEOUT_MS });
      read.push((text ?? '').replace(/\s+/g, ' ').trim());
    }
    if (read.length === 0) return empty;

    const name = (read[0] ?? '').split('•')[0]?.trim() || null;
    const headline = read[1]?.trim() || null;
    const employer = read.slice(2).map((line) => companyFromHeadline(line)).find(Boolean) ?? null;
    return { name, headline, company: employer || null };
  } catch {
    return empty;
  }
}

/**
 * The employer named inside a headline, or null when it names none.
 *
 * THE OLD ANSWER WAS ALWAYS NULL FOR A POST, AND THAT WAS THE WRONG TRADE.
 * `collect` used to hardcode `company: null` with a comment arguing that
 * "CTO at Acme" is a guess and a guess in a column an operator reads as a fact
 * is worse than a gap. The argument is sound about GUESSING and wrong about
 * this string: `Company` is one of the three fields the product promises for
 * every lead, keyword discovery through posts and comments is a first-class
 * way to get leads, and NEITHER of its two surfaces renders a company element
 * of its own. So every single lead that keyword discovery produced had an
 * empty company, and `{{company}}` rendered blank in the message built from
 * it. A gap in every row is not caution, it is a missing feature.
 *
 * SO IT READS, IT DOES NOT GUESS. The employer is taken only from an explicit
 * separator that LinkedIn's own headline grammar uses -- ` at `, ` @ `, and
 * the two localisations (` bei `, ` chez `) that appear in the same slot. A
 * headline with none of them returns null exactly as before: "Founder" names
 * no company and is not made to.
 *
 * WHAT FOLLOWS THE SEPARATOR IS CUT AT THE FIRST DECORATIVE BREAK. LinkedIn
 * headlines run on -- "Head of Eng at Acme | We are hiring | ex-Google" -- and
 * storing the tail as the company name would put the whole slogan into
 * `{{company}}`. The pipe, the bullet, a spaced dash and the COMMA are
 * separators in LinkedIn's own copy, so the employer is whatever sits before
 * the first of them.
 *
 * THE COMMA COSTS A SUFFIX AND BUYS A SENTENCE, and that trade is deliberate:
 * "at Acme, Inc." stores "Acme" rather than "Acme, Inc.", which is the name a
 * message should say anyway, while without it "CTO at Acme, previously at
 * Beta" -- the worked example this doc comment has always carried -- stored
 * the entire clause into `{{company}}` and put it in front of a real prospect.
 *
 * THE FIRST SEPARATOR WINS, not the last: "CTO at Acme, previously at Beta"
 * is a person who works at Acme. This is the same first-match rule the
 * people-search path has always used, kept identical on purpose -- two
 * surfaces answering "where do they work" two ways is how one person imported
 * from a search and harvested from a post stops looking like one person.
 */
export function companyFromHeadline(headline: string | null | undefined): string | null {
  if (!headline) return null;
  const line = headline.replace(/\s+/g, ' ').trim();
  const match = /(?:\s+at\s+|\s+bei\s+|\s+chez\s+|\s+@\s*)(.+)$/i.exec(line);
  if (!match) return null;
  const employer = (match[1] ?? '').split(/[|•·,]|\s[-–—]\s/)[0]?.trim() ?? '';
  return employer || null;
}

/**
 * A walk in progress: the cap, the dedupe set, and what was thrown away.
 *
 * Kept as one object because the cap and the dedupe have to be checked in the
 * same place. A person seen twice is not a drop -- they were already recorded --
 * and counting them as one would tell an operator their search is being
 * truncated when it is not.
 */
class Harvest {
  readonly leads: ScrapedLead[] = [];
  readonly degraded: string[] = [];
  /** Canonical profile URL -> its index in `leads`, so a re-sighting can enrich. */
  private readonly seen = new Map<string, number>();
  dropped = 0;
  pagesWalked = 0;

  constructor(readonly maxResults: number) {}

  get full(): boolean {
    return this.leads.length >= this.maxResults;
  }

  /**
   * True when the lead was recorded. False for a duplicate or an over-cap drop.
   *
   * A SECOND SIGHTING ENRICHES THE FIRST RATHER THAN BEING BINNED. Somebody who
   * reacted to a post AND commented on it is one person, and the old code kept
   * whichever row arrived first -- which meant the reactor row won and the fact
   * that they COMMENTED, the strongest signal on the page, was thrown away. The
   * person stays one row; every field the second sighting could fill and the
   * first could not is filled.
   */
  add(lead: ScrapedLead): boolean {
    const key = lead.profileUrl.toLowerCase();
    const existingIndex = this.seen.get(key);
    if (existingIndex !== undefined) {
      const existing = this.leads[existingIndex];
      // COMMENT OUTRANKS POST, rather than first-sighting-wins. Somebody who
      // reacted AND commented arrives twice: once from the reactions modal as
      // `post`, once from the comment list as `comment`. Taking whichever
      // landed first would throw away the strongest signal on the page for
      // every person who did both -- the same loss the enrichment above exists
      // to prevent, one field over.
      if (lead.interactionKind && (!existing.interactionKind || lead.interactionKind === 'comment')) {
        existing.interactionKind = lead.interactionKind;
      }
      if (!existing.postUrl && lead.postUrl) existing.postUrl = lead.postUrl;
      if (!existing.headline && lead.headline) existing.headline = lead.headline;
      if (!existing.company && lead.company) existing.company = lead.company;
      if (!existing.name && lead.name) {
        existing.name = lead.name;
        existing.firstName = lead.firstName;
        existing.lastName = lead.lastName;
      }
      return false;
    }
    if (this.full) {
      this.dropped += 1;
      return false;
    }
    this.seen.set(key, this.leads.length);
    this.leads.push(lead);
    return true;
  }

  /** A row that had no usable profile link. Counted, so a cap is never guessed at. */
  dropUnreadable(): void {
    this.dropped += 1;
  }

  /** Rows past the cap, counted without being read. */
  dropRemaining(rows: number): void {
    this.dropped += Math.max(0, rows);
  }

  done(): Pick<ScrapeResult, 'leads' | 'degraded' | 'pagesWalked' | 'dropped'> {
    if (this.dropped > 0) {
      this.degraded.push(
        `${this.dropped} row${this.dropped === 1 ? ' was' : 's were'} seen and not returned: the ${this.maxResults}-result cap was reached, or the row carried no readable profile link. Narrow the source or raise the cap.`
      );
    }
    return { leads: this.leads, degraded: this.degraded, pagesWalked: this.pagesWalked, dropped: this.dropped };
  }
}

/**
 * One person, scrubbed and split, ready to store.
 *
 * THE ONE PLACE A `ScrapedLead` IS BUILT. Every surface in this file goes
 * through it, which is what makes "the scrubber runs on every scraped lead"
 * a property of the file rather than a habit four call sites have to keep.
 * `name` is rebuilt from the scrubbed halves so the stored full name and the
 * stored first/last can never disagree.
 */
function makeLead(input: {
  profileUrl: string;
  name: string | null;
  headline: string | null;
  company: string | null;
  postUrl?: string | null;
  interactionKind?: LeadInteractionKind | null;
}): ScrapedLead {
  const { firstName, lastName } = splitAndScrubName(input.name ?? '');
  const scrubbed = [firstName, lastName].filter(Boolean).join(' ');
  return {
    profileUrl: input.profileUrl,
    name: scrubbed || null,
    firstName: firstName || null,
    lastName: lastName || null,
    headline: input.headline,
    company: input.company,
    postUrl: input.postUrl ?? null,
    interactionKind: input.interactionKind ?? null
  };
}

/**
 * The canonical permalink a content-search row points at, or null.
 *
 * THE HREF FIRST, THE URN SECOND. LinkedIn's search rows link the post through
 * a tracking wrapper often enough that the `data-urn` on the card is the more
 * reliable of the two -- but the href is the one that survives a layout that
 * drops the attribute, so both are tried and neither is guessed at:
 * `postUrlFor` still has to accept the result or the row is dropped.
 */
async function postUrlIn(card: LinkedInScrapeLocator, selector: string): Promise<string | null> {
  try {
    const link = card.locator(selector);
    const href = (await link.count()) === 0
      ? await card.getAttribute('href', { timeout: CLICK_TIMEOUT_MS })
      : await link.first().getAttribute('href', { timeout: CLICK_TIMEOUT_MS });
    if (href) {
      let absolute: string | null = null;
      try {
        absolute = new URL(href, 'https://www.linkedin.com').toString();
      } catch {
        absolute = null;
      }
      const canonical = absolute ? postUrlFor(absolute) : null;
      if (canonical) return canonical;
    }
    const urn = await card.getAttribute('data-urn', { timeout: CLICK_TIMEOUT_MS });
    if (!urn) return null;
    return postUrlFor(`https://www.linkedin.com/feed/update/${urn.trim()}/`);
  } catch {
    return null;
  }
}

function bounded(value: number | undefined, fallback: number, hardMax: number): number {
  const raw = Math.trunc(value ?? fallback);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(raw, hardMax);
}

/* ---------------------------------------------------------------------------
 * scrapeSearchResults
 * ------------------------------------------------------------------------ */

/**
 * Walk a people-search URL and read the cards.
 *
 * PAGINATION IS A URL, NOT A CLICK. LinkedIn's `page=N` parameter is stable and
 * a click on "Next" is not -- but the deciding reason is that a URL walk cannot
 * lose its place: a "Next" button that silently stops advancing would re-read
 * page 3 nine times and report 25 people as 225.
 *
 * THE WALK STOPS ON THE FIRST OF: the result cap, the page cap, an empty page,
 * or a wall. An empty page is a NORMAL ending -- it is what running out of
 * results looks like -- and is not reported as drift.
 */
export async function scrapeSearchResults(
  page: LinkedInScrapePage,
  searchUrl: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const base = searchResultsUrlFor(searchUrl);
  if (!base) {
    return fail(
      'not_found',
      `'${searchUrl}' is not a LinkedIn people-search URL (https://www.linkedin.com/search/results/people/...), so there is nothing to walk. Sources are never guessed at or rewritten.`
    );
  }
  return walkResultList(page, base, BASIC_SEARCH_SURFACE, opts);
}

/**
 * Walk a Sales Navigator people search and read its lead rows.
 *
 * THE SAME WALK, A DIFFERENT PAGE. Pagination, pacing, the caps, the wall
 * reads and the drop accounting are shared with basic search through
 * {@link walkResultList} -- because a second copy of those rules is a second
 * copy that can disagree about when to stop, and "when to stop" is the only
 * rule in this file whose failure costs the operator their account.
 *
 * WHAT IS GENUINELY DIFFERENT IS THE PAGE, and it is all in the surface table:
 * its own result container, its own lockup selectors, its own pagination
 * parameter, and an employer field that basic search does not render at all.
 */
export async function scrapeSalesNavigatorResults(
  page: LinkedInScrapePage,
  searchUrl: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const base = salesNavigatorUrlFor(searchUrl);
  if (!base) {
    return fail(
      'not_found',
      `'${searchUrl}' is not a LinkedIn Sales Navigator people-search URL (https://www.linkedin.com/sales/search/people?...), so there is nothing to walk. Sources are never guessed at or rewritten.`
    );
  }
  return walkResultList(page, base, SALES_NAVIGATOR_SURFACE, opts);
}

/* ---------------------------------------------------------------------------
 * The shared result-list walk.
 * ------------------------------------------------------------------------ */

/**
 * Everything that differs between two paginated result lists.
 *
 * A TABLE RATHER THAN A SECOND FUNCTION. What basic search and Sales Navigator
 * disagree about is SELECTORS AND A QUERY PARAMETER; what they agree about is
 * every rule that protects the account. Putting the disagreement in a struct
 * keeps the agreement in one body.
 */
interface ResultListSurface {
  /** Named in the degraded sentences, so an operator knows which walk spoke. */
  label: string;
  /** This surface's own pagination parameter. */
  pageParam: string;
  cardSelector: string;
  profileLinkSelector: string;
  nameSelector: string;
  headlineSelector: string;
  secondarySelector: string;
  noResultsSelector: string;
  /**
   * Fall back to reading the row's paragraphs POSITIONALLY when none of the
   * named selectors matched. Only the 2026 basic-search layout needs it --
   * Sales Navigator still ships named `data-anonymize` attributes, and guessing
   * at paragraph order there would invent fields the page never showed.
   */
  positional: boolean;
}

const BASIC_SEARCH_SURFACE: ResultListSurface = {
  label: 'this people search',
  pageParam: 'page',
  cardSelector: SCRAPE_SELECTORS.searchResultCard,
  profileLinkSelector: SCRAPE_SELECTORS.searchResultProfileLink,
  nameSelector: SCRAPE_SELECTORS.searchResultName,
  headlineSelector: SCRAPE_SELECTORS.searchResultHeadline,
  secondarySelector: SCRAPE_SELECTORS.searchResultSecondary,
  noResultsSelector: SCRAPE_SELECTORS.searchNoResults,
  positional: true
};

const SALES_NAVIGATOR_SURFACE: ResultListSurface = {
  label: 'this Sales Navigator search',
  pageParam: SALES_NAVIGATOR_PAGE_PARAM,
  cardSelector: SCRAPE_SELECTORS.salesResultCard,
  profileLinkSelector: SCRAPE_SELECTORS.salesResultProfileLink,
  nameSelector: SCRAPE_SELECTORS.salesResultName,
  headlineSelector: SCRAPE_SELECTORS.salesResultHeadline,
  secondarySelector: SCRAPE_SELECTORS.salesResultCompany,
  noResultsSelector: SCRAPE_SELECTORS.salesNoResults,
  positional: false
};

async function walkResultList(
  page: LinkedInScrapePage,
  base: string,
  surface: ResultListSurface,
  opts: ScrapeOptions
): Promise<ScrapeResult> {
  const maxResults = bounded(opts.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
  const maxPages = bounded(opts.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const sleep = opts.sleep ?? defaultSleep;
  const seed = opts.seed ?? base;
  const harvest = new Harvest(maxResults);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    // The gap goes BEFORE the fetch and not after it, so a run that ends on the
    // cap does not sit sleeping for a minute with nothing left to do.
    if (pageNumber > 1) await sleep(Math.round(scrapeGapSeconds(`${seed}:page:${pageNumber}`) * 1000));

    const target = new URL(base);
    target.searchParams.set(surface.pageParam, String(pageNumber));
    const url = target.toString();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(settleMs(`${seed}:settle:${pageNumber}`));
      await browseList(page, `${seed}:scroll:${pageNumber}`);
    } catch (cause) {
      harvest.degraded.push(
        `Page ${pageNumber} of ${surface.label} could not be opened (${cause instanceof Error ? cause.message : String(cause)}), so the walk stopped there with what it already had.`
      );
      break;
    }
    harvest.pagesWalked += 1;

    const wall = await detectWall(page);
    if (wall) {
      // STOP IMMEDIATELY. Retrying a wall is what turns a temporary restriction
      // into a permanent one, and every page already read still comes back.
      return fail(
        wall,
        wall === 'challenge'
          ? `LinkedIn is showing a challenge at ${page.url()} on page ${pageNumber} of ${surface.label}. The walk stopped there; a human has to clear it in the profile window before lead sourcing runs again.`
          : `LinkedIn answered page ${pageNumber} of ${surface.label} with a limit or restriction notice. The walk stopped there -- this is LinkedIn asking us to stop.`,
        harvest.done()
      );
    }

    const cards = page.locator(surface.cardSelector);
    const cardCount = await count(cards);
    if (cardCount === 0) {
      if (!(await present(page, surface.noResultsSelector)) && pageNumber === 1) {
        // Nothing matched AND LinkedIn did not say "no results": the card
        // selector is the suspect, and saying so is the whole point of the
        // table's one-place-to-fix design.
        harvest.degraded.push(
          `Page 1 of ${surface.label} rendered no rows matching ${surface.cardSelector} and no "no results" notice either, which is what a drifted selector looks like. Repair SCRAPE_SELECTORS in driver-scrape.ts.`
        );
      }
      break;
    }

    for (let index = 0; index < cardCount; index += 1) {
      if (harvest.full) {
        // THE CAP IS REPORTED, NOT HIDDEN. The rows past it are counted without
        // being read -- an operator who asked for 100 and was shown 100 of 431
        // needs to know which of those two numbers they are looking at.
        harvest.dropRemaining(cardCount - index);
        break;
      }
      const card = cards.nth(index);
      const profileUrl = await profileUrlIn(card, surface.profileLinkSelector);
      if (!profileUrl) {
        // A promoted row, a "people also viewed" filler, a Sales Navigator row
        // whose only link is a `/sales/lead/` URN, or drift. Counted either way:
        // a silent skip is how 25 becomes 19 with nobody noticing.
        harvest.dropUnreadable();
        continue;
      }
      const named = {
        name: await textIn(card, surface.nameSelector),
        headline: await textIn(card, surface.headlineSelector),
        company: await textIn(card, surface.secondarySelector)
      };
      // The named selectors are the older markup and are tried first. A row
      // where NONE of them matched is the 2026 layout, whose only readable
      // structure is the order of its paragraphs.
      const fields = named.name || named.headline || named.company || !surface.positional
        ? named
        : await readRowLines(card);
      harvest.add(makeLead({ profileUrl, ...fields }));
    }

    if (harvest.full) {
      opts.log?.(`LinkedIn lead sourcing stopped at the ${maxResults}-result cap after ${harvest.pagesWalked} page(s).`);
      break;
    }
  }

  return { ok: true, failureKind: null, externalRef: base, ...harvest.done() };
}

/* ---------------------------------------------------------------------------
 * scrapePostEngagers
 * ------------------------------------------------------------------------ */

/**
 * Read the people who reacted to a post and the people who commented on it.
 *
 * TWO SURFACES, ONE LIST. Reactors live in a modal behind the reaction count;
 * commenters are on the post page itself. They are deduped against each other,
 * because somebody who liked AND commented is one person and importing them
 * twice would put two invites in front of a founder to approve.
 *
 * EACH "LOAD MORE" IS A FETCH AND IS PACED LIKE ONE. That is the part it would
 * be easy to get wrong: the modal loads without a navigation, so the requests
 * are invisible in the URL bar and entirely visible to LinkedIn.
 *
 * REACTORS ARE READ FIRST AND THE CAP IS SHARED. If a post has 400 reactions,
 * the 100-lead cap fills from them and the comments are not walked at all --
 * which is the right trade: the fetches saved are fetches not spent.
 */
export async function scrapePostEngagers(
  page: LinkedInScrapePage,
  postUrl: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const base = postUrlFor(postUrl);
  if (!base) {
    return fail(
      'not_found',
      `'${postUrl}' is not a LinkedIn post URL (https://www.linkedin.com/feed/update/urn:li:activity:... or /posts/...), so there is nothing to read. Sources are never guessed at or rewritten.`
    );
  }

  const maxResults = bounded(opts.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
  const maxPages = bounded(opts.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const sleep = opts.sleep ?? defaultSleep;
  const seed = opts.seed ?? base;
  const harvest = new Harvest(maxResults);

  const opened = await openPost(page, base, harvest);
  if (opened) return opened;

  /* --- Reactors ------------------------------------------------------- */

  const entry = page.locator(SCRAPE_SELECTORS.reactionsEntry);
  if ((await count(entry)) === 0) {
    harvest.degraded.push(
      `The post shows no reaction control matching ${SCRAPE_SELECTORS.reactionsEntry}, so nobody who reacted was read. A post with no reactions looks the same as a drifted selector from here.`
    );
  } else {
    try {
      await hoverClick(page, entry.first(), `${seed}:reactions:open`, CLICK_TIMEOUT_MS);
      await page.waitForTimeout(settleMs(`${seed}:reactions:open`));
    } catch (cause) {
      harvest.degraded.push(
        `The reactions list would not open (${cause instanceof Error ? cause.message : String(cause)}), so nobody who reacted was read.`
      );
    }

    const wall = await detectWall(page);
    if (wall) return fail(wall, wallDetail(wall, page, 'the reactions list'), harvest.done());

    if (!(await present(page, SCRAPE_SELECTORS.reactorsModal))) {
      harvest.degraded.push(
        `No reactions dialog matching ${SCRAPE_SELECTORS.reactorsModal} appeared after the click, so nobody who reacted was read. Repair SCRAPE_SELECTORS in driver-scrape.ts.`
      );
    } else {
      harvest.pagesWalked += 1;
      // A REACTOR IS TAGGED `post`, NOT LEFT BLANK. They engaged with this
      // post and did not comment on it, which is exactly what `post` means in
      // the two-word vocabulary this product speaks; null would render as an
      // em dash under "How" for every reactor on a post source. A reactor who
      // also commented is upgraded to `comment` by `Harvest.add`.
      await collect(page, harvest, SCRAPE_SELECTORS.reactorItem, SCRAPE_SELECTORS.engagerName, SCRAPE_SELECTORS.engagerHeadline, base, 'post');

      for (let step = 1; step < maxPages && !harvest.full; step += 1) {
        const more = page.locator(SCRAPE_SELECTORS.loadMoreReactors);
        if ((await count(more)) === 0) break;
        await sleep(Math.round(scrapeGapSeconds(`${seed}:reactors:${step}`) * 1000));
        try {
          await hoverClick(page, more.first(), `${seed}:reactors:${step}`, CLICK_TIMEOUT_MS);
          await page.waitForTimeout(settleMs(`${seed}:reactors:${step}`));
        } catch {
          break;
        }
        harvest.pagesWalked += 1;
        const loadWall = await detectWall(page);
        if (loadWall) return fail(loadWall, wallDetail(loadWall, page, 'the reactions list'), harvest.done());
        await collect(page, harvest, SCRAPE_SELECTORS.reactorItem, SCRAPE_SELECTORS.engagerName, SCRAPE_SELECTORS.engagerHeadline, base, 'post');
      }
    }
  }

  /* --- Commenters ----------------------------------------------------- */

  if (harvest.full) {
    opts.log?.(`LinkedIn lead sourcing filled the ${maxResults}-result cap on reactors alone; comments were not walked.`);
    return { ok: true, failureKind: null, externalRef: base, ...harvest.done() };
  }

  // Back to the post itself: the modal has no close control this page surface
  // can reach, and re-opening the permalink is one fetch against an unknown
  // number of guesses at a dismiss button.
  await sleep(Math.round(scrapeGapSeconds(`${seed}:comments:0`) * 1000));
  const reopened = await openPost(page, base, harvest);
  if (reopened) return reopened;

  await collect(page, harvest, SCRAPE_SELECTORS.commentItem, SCRAPE_SELECTORS.commentAuthorName, SCRAPE_SELECTORS.commentAuthorHeadline, base, 'comment');

  for (let step = 1; step < maxPages && !harvest.full; step += 1) {
    const more = page.locator(SCRAPE_SELECTORS.loadMoreComments);
    if ((await count(more)) === 0) break;
    await sleep(Math.round(scrapeGapSeconds(`${seed}:comments:${step}`) * 1000));
    try {
      await hoverClick(page, more.first(), `${seed}:comments:${step}`, CLICK_TIMEOUT_MS);
      await page.waitForTimeout(settleMs(`${seed}:comments:${step}`));
    } catch {
      break;
    }
    harvest.pagesWalked += 1;
    const loadWall = await detectWall(page);
    if (loadWall) return fail(loadWall, wallDetail(loadWall, page, 'the comments list'), harvest.done());
    await collect(page, harvest, SCRAPE_SELECTORS.commentItem, SCRAPE_SELECTORS.commentAuthorName, SCRAPE_SELECTORS.commentAuthorHeadline, base, 'comment');
  }

  return { ok: true, failureKind: null, externalRef: base, ...harvest.done() };
}

/** Open the post and read the walls. Returns a failure to report, or null. */
async function openPost(page: LinkedInScrapePage, url: string, harvest: Harvest): Promise<ScrapeResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(settleMs(`${url}:post`));
    await browseList(page, `${url}:post:scroll`);
  } catch (cause) {
    return fail(
      'selector_drift',
      `Could not open ${url}: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was read.`,
      harvest.done()
    );
  }
  harvest.pagesWalked += 1;
  const wall = await detectWall(page);
  if (wall) return fail(wall, wallDetail(wall, page, 'the post'), harvest.done());
  return null;
}

function wallDetail(wall: LinkedInFailureKind, page: LinkedInScrapePage, surface: string): string {
  let url = '';
  try {
    url = page.url();
  } catch {
    url = 'an unreadable URL';
  }
  return wall === 'challenge'
    ? `LinkedIn is showing a challenge at ${url} while reading ${surface}. The harvest stopped there; a human has to clear it in the profile window before lead sourcing runs again.`
    : `LinkedIn answered ${surface} with a limit or restriction notice at ${url}. The harvest stopped there -- this is LinkedIn asking us to stop.`;
}

/**
 * Read every row currently on screen into the harvest. Never throws.
 *
 * THE POST AND THE INTERACTION TRAVEL WITH THE ROW. A reactor and a commenter
 * are read out of two different containers on the same page and used to arrive
 * indistinguishable -- one flat list in which the strongest signal on the page,
 * "this person wrote a reply about your topic", had been erased by the merge.
 * Both now carry the post they were found on and how they touched it.
 */
async function collect(
  page: LinkedInScrapePage,
  harvest: Harvest,
  itemSelector: string,
  nameSelector: string,
  headlineSelector: string,
  postUrl: string | null,
  interactionKind: LeadInteractionKind | null
): Promise<void> {
  const items = page.locator(itemSelector);
  const total = await count(items);
  for (let index = 0; index < total; index += 1) {
    if (harvest.full) {
      harvest.dropRemaining(total - index);
      break;
    }
    const item = items.nth(index);
    const profileUrl = await profileUrlIn(item, SCRAPE_SELECTORS.engagerProfileLink);
    if (!profileUrl) {
      harvest.dropUnreadable();
      continue;
    }
    const headline = await textIn(item, headlineSelector);
    harvest.add(makeLead({
      profileUrl,
      name: await textIn(item, nameSelector),
      headline,
      // Neither surface renders a company element of its own, so the headline
      // is the only place one can come from -- and `Company` is one of the
      // three fields every lead is promised. Read, never invented: a headline
      // that names no employer still gives null. See `companyFromHeadline`.
      company: companyFromHeadline(headline),
      postUrl,
      interactionKind
    }));
  }
}

/* ---------------------------------------------------------------------------
 * scrapeContentSearch
 * ------------------------------------------------------------------------ */

/**
 * Keyword discovery: find the POSTS that match, then the people around them.
 *
 * WHY THIS EXISTS AT ALL. A keyword source used to become
 * `/search/results/people/?keywords=...`, which answers "whose PROFILE contains
 * this word" -- a headline search. The person who wrote three paragraphs about
 * the topic last Tuesday and whose headline says only "Founder" is invisible to
 * it. The content search is the only LinkedIn surface that answers the question
 * an operator actually asked, and it answers it with posts, not people.
 *
 * TWO KINDS OF PERSON COME OUT OF ONE POST: the AUTHOR (`post`) and each
 * COMMENTER (`comment`), each carrying the post URL they were found on. Both
 * are wanted and they are not the same lead -- "they wrote about this" and
 * "they replied to somebody who wrote about this" are different openings, and a
 * flat list of names loses the difference.
 *
 * THE FETCH BUDGET IS SHARED BETWEEN THE TWO PHASES and is the same `maxPages`
 * everything else here is bounded by: one results page plus nine post opens is
 * the default shape. INTERLEAVED rather than two-phased, so a budget that runs
 * out has still opened the posts LinkedIn ranked highest. The walk stops on the
 * first of the result cap, the page budget, an empty results page, or a wall.
 */
export async function scrapeContentSearch(
  page: LinkedInScrapePage,
  contentUrl: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> {
  const base = contentSearchUrlFor(contentUrl);
  if (!base) {
    return fail(
      'not_found',
      `'${contentUrl}' is not a LinkedIn content-search URL (https://www.linkedin.com/search/results/content/?keywords=...), so there is nothing to walk. Sources are never guessed at or rewritten.`
    );
  }

  const maxResults = bounded(opts.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
  const maxPages = bounded(opts.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const sleep = opts.sleep ?? defaultSleep;
  const seed = opts.seed ?? base;
  const harvest = new Harvest(maxResults);
  const walked = new Set<string>();

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    if (harvest.full || harvest.pagesWalked >= maxPages) break;
    if (pageNumber > 1) await sleep(Math.round(scrapeGapSeconds(`${seed}:content:${pageNumber}`) * 1000));

    const target = new URL(base);
    target.searchParams.set('page', String(pageNumber));
    try {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(settleMs(`${seed}:content:${pageNumber}`));
      await browseList(page, `${seed}:content:scroll:${pageNumber}`);
    } catch (cause) {
      harvest.degraded.push(
        `Page ${pageNumber} of this content search could not be opened (${cause instanceof Error ? cause.message : String(cause)}), so the walk stopped there with what it already had.`
      );
      break;
    }
    harvest.pagesWalked += 1;

    const wall = await detectWall(page);
    if (wall) return fail(wall, wallDetail(wall, page, 'this content search'), harvest.done());

    // EVERY ROW IS READ BEFORE ANY POST IS OPENED. Opening one navigates away,
    // and a locator held across a navigation reads whatever page it lands on.
    const cards = page.locator(SCRAPE_SELECTORS.contentResultCard);
    const cardCount = await count(cards);
    if (cardCount === 0) {
      if (!(await present(page, SCRAPE_SELECTORS.contentNoResults)) && pageNumber === 1) {
        harvest.degraded.push(
          `Page 1 of this content search rendered no posts matching ${SCRAPE_SELECTORS.contentResultCard} and no "no results" notice either, which is what a drifted selector looks like. Repair SCRAPE_SELECTORS in driver-scrape.ts.`
        );
      }
      break;
    }

    const posts: Array<{ postUrl: string; author: { profileUrl: string; name: string | null; headline: string | null } | null }> = [];
    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index);
      const postUrl = await postUrlIn(card, SCRAPE_SELECTORS.contentPostLink);
      if (!postUrl) {
        // A row we cannot attribute a lead to, and an unattributed lead is
        // exactly the hole this feature exists to fill.
        harvest.dropUnreadable();
        continue;
      }
      if (walked.has(postUrl)) continue;
      const authorUrl = await profileUrlIn(card, SCRAPE_SELECTORS.contentAuthorLink);
      posts.push({
        postUrl,
        author: authorUrl
          ? {
              profileUrl: authorUrl,
              name: await textIn(card, SCRAPE_SELECTORS.contentAuthorName),
              headline: await textIn(card, SCRAPE_SELECTORS.contentAuthorHeadline)
            }
          : null
      });
    }

    for (const post of posts) {
      if (harvest.full) break;
      walked.add(post.postUrl);
      // The author costs no fetch: the results row already showed them.
      if (post.author) {
        harvest.add(makeLead({
          ...post.author,
          // Same rule as a commenter's: the actor line under a post is a
          // headline and it is the only employer this surface renders.
          company: companyFromHeadline(post.author.headline),
          postUrl: post.postUrl,
          interactionKind: 'post'
        }));
      }
      if (harvest.full || harvest.pagesWalked >= maxPages) break;

      await sleep(Math.round(scrapeGapSeconds(`${seed}:post:${post.postUrl}`) * 1000));
      const opened = await openPost(page, post.postUrl, harvest);
      if (opened) return opened;
      await collect(
        page,
        harvest,
        SCRAPE_SELECTORS.commentItem,
        SCRAPE_SELECTORS.commentAuthorName,
        SCRAPE_SELECTORS.commentAuthorHeadline,
        post.postUrl,
        'comment'
      );
    }
  }

  return { ok: true, failureKind: null, externalRef: base, ...harvest.done() };
}

/** The real scraper. `leads.ts` takes this as a parameter so tests can pass a fake. */
export const playwrightScrapeDriver: LinkedInScrapeDriver = {
  scrapeSearchResults,
  scrapePostEngagers,
  scrapeSalesNavigatorResults,
  scrapeContentSearch
};
