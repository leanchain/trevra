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
  name: string | null;
  headline: string | null;
  company: string | null;
}

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
/** Long enough for LinkedIn's client-side render, short enough not to stall a run. */
const SETTLE_MS = 1_500;

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
    + 'button.comments-comments-list__show-previous-container button'
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
 * is the only line naming an employer -- and only when it actually contains
 * the ' at ' / ' bei ' that separates the role from it, because the same line
 * localises and a split on a word that is not there invents a company.
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
    const employer = read.slice(2).map((line) => /(?: at | bei )(.+)$/.exec(line)?.[1]?.trim()).find(Boolean) ?? null;
    return { name, headline, company: employer || null };
  } catch {
    return empty;
  }
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
  private readonly seen = new Set<string>();
  dropped = 0;
  pagesWalked = 0;

  constructor(readonly maxResults: number) {}

  get full(): boolean {
    return this.leads.length >= this.maxResults;
  }

  /** True when the lead was recorded. False for a duplicate or an over-cap drop. */
  add(lead: ScrapedLead): boolean {
    const key = lead.profileUrl.toLowerCase();
    if (this.seen.has(key)) return false;
    if (this.full) {
      this.dropped += 1;
      return false;
    }
    this.seen.add(key);
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
    target.searchParams.set('page', String(pageNumber));
    const url = target.toString();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    } catch (cause) {
      harvest.degraded.push(
        `Page ${pageNumber} of the search could not be opened (${cause instanceof Error ? cause.message : String(cause)}), so the walk stopped there with what it already had.`
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
          ? `LinkedIn is showing a challenge at ${page.url()} on page ${pageNumber} of this search. The walk stopped there; a human has to clear it in the profile window before lead sourcing runs again.`
          : `LinkedIn answered page ${pageNumber} of this search with a limit or restriction notice. The walk stopped there -- this is LinkedIn asking us to stop.`,
        harvest.done()
      );
    }

    const cards = page.locator(SCRAPE_SELECTORS.searchResultCard);
    const cardCount = await count(cards);
    if (cardCount === 0) {
      if (!(await present(page, SCRAPE_SELECTORS.searchNoResults)) && pageNumber === 1) {
        // Nothing matched AND LinkedIn did not say "no results": the card
        // selector is the suspect, and saying so is the whole point of the
        // table's one-place-to-fix design.
        harvest.degraded.push(
          `Page 1 of the search rendered no rows matching ${SCRAPE_SELECTORS.searchResultCard} and no "no results" notice either, which is what a drifted selector looks like. Repair SCRAPE_SELECTORS in driver-scrape.ts.`
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
      const profileUrl = await profileUrlIn(card, SCRAPE_SELECTORS.searchResultProfileLink);
      if (!profileUrl) {
        // A promoted row, a "people also viewed" filler, or drift. Counted
        // either way: a silent skip is how 25 becomes 19 with nobody noticing.
        harvest.dropUnreadable();
        continue;
      }
      const named = {
        name: await textIn(card, SCRAPE_SELECTORS.searchResultName),
        headline: await textIn(card, SCRAPE_SELECTORS.searchResultHeadline),
        company: await textIn(card, SCRAPE_SELECTORS.searchResultSecondary)
      };
      // The named selectors are the older markup and are tried first. A row
      // where NONE of them matched is the 2026 layout, whose only readable
      // structure is the order of its paragraphs.
      const fields = named.name || named.headline || named.company
        ? named
        : await readRowLines(card);
      harvest.add({ profileUrl, ...fields });
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
      await entry.first().click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
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
      await collect(page, harvest, SCRAPE_SELECTORS.reactorItem, SCRAPE_SELECTORS.engagerName, SCRAPE_SELECTORS.engagerHeadline);

      for (let step = 1; step < maxPages && !harvest.full; step += 1) {
        const more = page.locator(SCRAPE_SELECTORS.loadMoreReactors);
        if ((await count(more)) === 0) break;
        await sleep(Math.round(scrapeGapSeconds(`${seed}:reactors:${step}`) * 1000));
        try {
          await more.first().click({ timeout: CLICK_TIMEOUT_MS });
          await page.waitForTimeout(SETTLE_MS);
        } catch {
          break;
        }
        harvest.pagesWalked += 1;
        const loadWall = await detectWall(page);
        if (loadWall) return fail(loadWall, wallDetail(loadWall, page, 'the reactions list'), harvest.done());
        await collect(page, harvest, SCRAPE_SELECTORS.reactorItem, SCRAPE_SELECTORS.engagerName, SCRAPE_SELECTORS.engagerHeadline);
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

  await collect(page, harvest, SCRAPE_SELECTORS.commentItem, SCRAPE_SELECTORS.commentAuthorName, SCRAPE_SELECTORS.commentAuthorHeadline);

  for (let step = 1; step < maxPages && !harvest.full; step += 1) {
    const more = page.locator(SCRAPE_SELECTORS.loadMoreComments);
    if ((await count(more)) === 0) break;
    await sleep(Math.round(scrapeGapSeconds(`${seed}:comments:${step}`) * 1000));
    try {
      await more.first().click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    } catch {
      break;
    }
    harvest.pagesWalked += 1;
    const loadWall = await detectWall(page);
    if (loadWall) return fail(loadWall, wallDetail(loadWall, page, 'the comments list'), harvest.done());
    await collect(page, harvest, SCRAPE_SELECTORS.commentItem, SCRAPE_SELECTORS.commentAuthorName, SCRAPE_SELECTORS.commentAuthorHeadline);
  }

  return { ok: true, failureKind: null, externalRef: base, ...harvest.done() };
}

/** Open the post and read the walls. Returns a failure to report, or null. */
async function openPost(page: LinkedInScrapePage, url: string, harvest: Harvest): Promise<ScrapeResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
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

/** Read every row currently on screen into the harvest. Never throws. */
async function collect(
  page: LinkedInScrapePage,
  harvest: Harvest,
  itemSelector: string,
  nameSelector: string,
  headlineSelector: string
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
    harvest.add({
      profileUrl,
      name: await textIn(item, nameSelector),
      headline: await textIn(item, headlineSelector),
      // Neither surface renders a company field of its own. Left null rather
      // than parsed out of the headline: "CTO at Acme" is a guess, and a guess
      // stored in a column an operator will read as a fact is worse than a gap.
      company: null
    });
  }
}

/** The real scraper. `leads.ts` takes this as a parameter so tests can pass a fake. */
export const playwrightScrapeDriver: LinkedInScrapeDriver = {
  scrapeSearchResults,
  scrapePostEngagers
};
