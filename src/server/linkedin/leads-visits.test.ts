import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import type { LinkedInScrapeDriver, ScrapeOptions, ScrapeResult } from './driver-scrape.js';
import {
  LEAD_PAGES_PER_VISIT,
  createLeadSource,
  getLeadSource,
  leadPagesForConfig,
  leadPagesThisVisit,
  runPendingLeadSources,
  type LeadSourcingConfig
} from './leads.js';
import { upsertSeat } from './seats.js';

/**
 * ONE VISIT'S WORTH OF READING, NOT ONE SOURCE'S.
 *
 * A lead source used to be walked in one go: up to ten search pages back to
 * back at 30-120s gaps, which is ten to twenty minutes of continuous paging
 * through other people's profiles. Everything else in this subsystem now
 * happens inside a 2-5 minute visit (`pacing.ts` `visitsForDay`), so this was
 * the last burst left -- on the exact surface the 2026-08-14 restriction named:
 * "accessing an unusually large amount of LinkedIn profile data over time".
 */

let db: Db;

const NOW = new Date('2026-08-04T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_lead_visits';
const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=founder';
const CONFIG: LeadSourcingConfig = { optIn: true, hosted: false, companionBrowser: false, remoteBrowser: false, maxResults: 100, maxPages: 10 };

/** A search that never runs out until `pagesAvailable`, and records what it was asked for. */
function pagedScraper(pagesAvailable: number) {
  const asked: Array<{ startPage: number; maxPages: number }> = [];
  const walk = async (_page: unknown, url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> => {
    const startPage = Math.max(1, options.startPage ?? 1);
    const maxPages = options.maxPages ?? 10;
    asked.push({ startPage, maxPages });
    const last = Math.min(startPage + maxPages - 1, pagesAvailable);
    const leads: ScrapeResult['leads'] = [];
    for (let page = startPage; page <= last; page += 1) {
      leads.push({
        profileUrl: `https://www.linkedin.com/in/person-${page}/`,
        name: `Person ${page}`,
        firstName: `Person`,
        lastName: `${page}`,
        headline: null,
        company: null,
        postUrl: null,
        interactionKind: null
      });
    }
    return {
      ok: true,
      failureKind: null,
      externalRef: url,
      leads,
      degraded: [],
      pagesWalked: Math.max(0, last - startPage + 1),
      dropped: 0,
      exhausted: last >= pagesAvailable
    };
  };
  return {
    asked,
    scraper: {
      scrapeSearchResults: walk,
      scrapePostEngagers: walk,
      scrapeSalesNavigatorResults: walk,
      scrapeContentSearch: walk
    } as unknown as LinkedInScrapeDriver
  };
}

const page = {} as never;

function run(scraper: LinkedInScrapeDriver, config: LeadSourcingConfig = CONFIG, maxSources?: number) {
  return runPendingLeadSources(
    db,
    WORKSPACE_ID,
    { page, config, scraper, now: () => NOW, sleep: async () => {} },
    maxSources === undefined ? {} : { maxSources }
  );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn lead visits', NOW.toISOString());
  for (const table of ['linkedin_leads', 'linkedin_lead_sources', 'linkedin_seats', 'linkedin_lead_settings']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE_ID);
  }
  await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, NOW);
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE_ID);
  await db?.close();
});

describe('leadPagesThisVisit', () => {
  it('is one to three pages -- what a person reads before doing something else', () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const drawn = leadPagesThisVisit(`source-${attempt}`);
      expect(drawn).toBeGreaterThanOrEqual(LEAD_PAGES_PER_VISIT.min);
      expect(drawn).toBeLessThanOrEqual(LEAD_PAGES_PER_VISIT.max);
    }
  });

  it('is a band and not a constant, and is reproducible for local/self-hosted browsing', () => {
    const drawn = new Set(Array.from({ length: 40 }, (_unused, index) => leadPagesThisVisit(`s${index}`)));
    expect(drawn.size).toBeGreaterThan(1);
    expect(leadPagesThisVisit('x')).toBe(leadPagesThisVisit('x'));
  });

  it('uses exactly one results page per visit through the hosted companion', () => {
    const companion = { ...CONFIG, hosted: true, companionBrowser: true };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(leadPagesForConfig(companion, `source-${attempt}`)).toBe(1);
    }
  });
});

describe('reading a lead source across visits', () => {
  it('reads a few pages, parks the rest, and resumes where it stopped', async () => {
    await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    const { scraper, asked } = pagedScraper(10);

    const first = await run(scraper);
    expect(first).toHaveLength(1);
    // PARKED, NOT FINISHED. 'pending' here means "put back for the next visit".
    expect(first[0]?.status).toBe('pending');
    expect(asked[0]?.startPage).toBe(1);
    expect(asked[0]?.maxPages).toBeLessThanOrEqual(LEAD_PAGES_PER_VISIT.max);

    const afterFirst = await getLeadSource(db, WORKSPACE_ID, first[0]?.sourceId as string);
    expect(afterFirst?.status).toBe('pending');
    expect(afterFirst?.pagesDone).toBe(asked[0]?.maxPages);
    expect(afterFirst?.finishedAt).toBeNull();

    // The next visit picks up at the page after the last one read, rather than
    // starting the search again from the top.
    const second = await run(scraper);
    expect(asked[1]?.startPage).toBe((afterFirst?.pagesDone ?? 0) + 1);
    expect(second[0]?.pagesDone).toBeGreaterThan(afterFirst?.pagesDone ?? 0);
  });

  it('keeps a running total of people found rather than only the last visit\'s', async () => {
    await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    const { scraper } = pagedScraper(10);

    const first = await run(scraper);
    const afterFirst = await getLeadSource(db, WORKSPACE_ID, first[0]?.sourceId as string);
    await run(scraper);
    const afterSecond = await getLeadSource(db, WORKSPACE_ID, first[0]?.sourceId as string);

    expect(afterSecond?.resultCount).toBeGreaterThan(afterFirst?.resultCount ?? 0);
  });

  it('finishes the source when the search itself runs out', async () => {
    await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    // One page of results in total: the very first visit exhausts it.
    const { scraper } = pagedScraper(1);

    const results = await run(scraper);
    expect(results[0]?.status).toBe('completed');

    const stored = await getLeadSource(db, WORKSPACE_ID, results[0]?.sourceId as string);
    expect(stored?.status).toBe('completed');
    expect(stored?.finishedAt).not.toBeNull();
  });

  it('does not walk the same source twice in one pass just because it was put back', async () => {
    await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    const { scraper, asked } = pagedScraper(50);

    // Three sources allowed, one source queued: the claim would hand the parked
    // source straight back, and the per-visit budget would mean nothing.
    await run(scraper, CONFIG, 3);

    expect(asked).toHaveLength(1);
  });

  it('stops for good once the source has read its whole page ceiling', async () => {
    await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    const { scraper } = pagedScraper(500);
    const tight: LeadSourcingConfig = { ...CONFIG, maxPages: 2 };

    let sourceId = '';
    for (let visit = 0; visit < 6; visit += 1) {
      const results = await run(scraper, tight);
      if (results.length === 0) break;
      sourceId = results[0]?.sourceId as string;
    }

    const stored = await getLeadSource(db, WORKSPACE_ID, sourceId);
    expect(stored?.pagesDone).toBeLessThanOrEqual(tight.maxPages);
    expect(stored?.status).toBe('completed');
  });
});
