import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction } from './actions.js';
import type { LinkedInScrapeDriver, LinkedInScrapePage, ScrapeResult, ScrapedLead } from './driver-scrape.js';
import {
  claimLeadSource,
  createLeadSource,
  getLeadSource,
  leadSourceUrlFor,
  leadSourcingConfig,
  leadSourcingEnabled,
  leadSourcingOffReason,
  listLeadSources,
  listLeads,
  runLeadSource,
  runPendingLeadSources,
  setDailyLeadCap,
  getDailyLeadCap,
  DEFAULT_DAILY_LEAD_CAP,
  type LeadSourceKind,
  type LeadSourcingConfig
} from './leads.js';
import { upsertSeat } from './seats.js';

/**
 * NO BROWSER, NO LINKEDIN, NO SCRAPING -- the scraper is always a fake here.
 *
 * What is asserted is the four rules leads.ts is built on: the gate is checked
 * where the network is and is off by default, the seat's posture still governs,
 * a source is claimed once, and a harvested list is filtered against the
 * exclusion list and the action ledger BEFORE it is stored.
 */

let db: Db;

const NOW = new Date('2026-08-06T09:00:00.000Z');
const WORKSPACE_ID = 'ws_linkedin_leads_test';
const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=cto';
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/';
const SALES_URL = 'https://www.linkedin.com/sales/search/people?query=(keywords%3Acto)';
const CONTENT_URL = 'https://www.linkedin.com/search/results/content/?keywords=rag%20evals';

const page = {} as LinkedInScrapePage;

/** Opted in, self-hosted. The only configuration in which anything happens. */
function on(overrides: Partial<LeadSourcingConfig> = {}): LeadSourcingConfig {
  return { optIn: true, hosted: false, maxResults: 100, maxPages: 10, ...overrides };
}

function lead(handle: string, name: string, extra: Partial<ScrapedLead> = {}): ScrapedLead {
  const [firstName, ...rest] = name.split(' ');
  return {
    profileUrl: `https://www.linkedin.com/in/${handle}/`,
    name,
    firstName: firstName || null,
    lastName: rest.join(' ') || null,
    headline: 'Founder',
    company: 'Acme',
    postUrl: null,
    interactionKind: null,
    ...extra
  };
}

/** A card as a DRIVER would hand it over before anything split the name. */
function rawLead(handle: string, name: string, extra: Partial<ScrapedLead> = {}): ScrapedLead {
  return { ...lead(handle, name, extra), name, firstName: null, lastName: null };
}

interface ScraperHarness {
  scraper: LinkedInScrapeDriver;
  calls: Array<{ surface: 'search' | 'post' | 'sales_navigator' | 'content'; url: string }>;
}

function fakeScraper(result: Partial<ScrapeResult> = {}): ScraperHarness {
  const calls: ScraperHarness['calls'] = [];
  const answer = (): ScrapeResult => ({
    ok: true,
    failureKind: null,
    leads: [],
    degraded: [],
    pagesWalked: 1,
    dropped: 0,
    ...result
  });
  const record = (surface: ScraperHarness['calls'][number]['surface']) => async (_page: LinkedInScrapePage, url: string) => {
    calls.push({ surface, url });
    return answer();
  };
  return {
    calls,
    scraper: {
      scrapeSearchResults: record('search'),
      scrapePostEngagers: record('post'),
      scrapeSalesNavigatorResults: record('sales_navigator'),
      scrapeContentSearch: record('content')
    }
  };
}

async function seat(): Promise<void> {
  await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, NOW);
}

async function source(kind: LeadSourceKind = 'search', url = SEARCH_URL) {
  const created = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind, url }, NOW);
  return created.source;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Leads Test', NOW.toISOString());
  for (const table of ['linkedin_leads', 'linkedin_lead_sources', 'linkedin_actions', 'linkedin_exclusions', 'linkedin_seats', 'linkedin_lead_settings']) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE_ID);
  }
});

afterEach(async () => {
  await db?.close();
});

describe('the gate', () => {
  it('is off by default, because harvesting is not what opting into sending asked for', () => {
    expect(leadSourcingEnabled(leadSourcingConfig({}))).toBe(false);
    // Even a self-hoster who turned the WORKER on has not asked for a crawler.
    expect(leadSourcingEnabled(leadSourcingConfig({ TREVRA_LINKEDIN_LOCAL: 'true' }))).toBe(false);
  });

  it('turns on only for an explicit self-hosted opt-in', () => {
    expect(leadSourcingEnabled(leadSourcingConfig({ TREVRA_LINKEDIN_LEAD_SOURCING: 'true' }))).toBe(true);
  });

  it('is forced off by hosted mode, unconditionally', () => {
    const config = leadSourcingConfig({ TREVRA_LINKEDIN_LEAD_SOURCING: 'true', TREVRA_DEPLOYMENT_MODE: 'hosted' });
    expect(config.hosted).toBe(true);
    expect(leadSourcingEnabled(config)).toBe(false);
    // And the refusal says WHICH kind of off it is, so nobody hunts for a switch.
    expect(leadSourcingOffReason(config)).toContain('cannot be enabled');
    expect(leadSourcingOffReason({ optIn: false, hosted: false })).toContain('TREVRA_LINKEDIN_LEAD_SOURCING=true');
  });

  it('reads the caps off the environment and never accepts an unbounded one', () => {
    expect(leadSourcingConfig({}).maxResults).toBe(100);
    expect(leadSourcingConfig({ TREVRA_LINKEDIN_LEAD_MAX_RESULTS: '250' }).maxResults).toBe(250);
    expect(() => leadSourcingConfig({ TREVRA_LINKEDIN_LEAD_MAX_RESULTS: '100000' })).toThrow();
  });
});

describe('creating a source', () => {
  it('refuses a URL that is not the shape it claims to be', async () => {
    await expect(createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: 'https://evil.example/x' }, NOW)).rejects.toThrow();
    await expect(createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'post', url: SEARCH_URL }, NOW)).rejects.toThrow();
    expect(leadSourceUrlFor('search', SEARCH_URL)).toBe(SEARCH_URL);
    expect(leadSourceUrlFor('post', SEARCH_URL)).toBeNull();
  });

  it('answers a double-clicked button with the source that already exists', async () => {
    const first = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    const second = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.source.id).toBe(first.source.id);
    expect(await listLeadSources(db, WORKSPACE_ID)).toHaveLength(1);
  });

  it('lets the same search be re-run once the first one is finished', async () => {
    await seat();
    const first = await source();
    const claimed = await claimLeadSource(db, WORKSPACE_ID, NOW);
    await runLeadSource(db, claimed!, { page, config: on(), scraper: fakeScraper().scraper, now: () => NOW });

    const again = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'search', url: SEARCH_URL }, NOW);
    expect(again.duplicate).toBe(false);
    expect(again.source.id).not.toBe(first.id);
  });
});

describe('claiming', () => {
  it('hands one source to one caller and nothing to the next', async () => {
    await source();
    const first = await claimLeadSource(db, WORKSPACE_ID, NOW);
    const second = await claimLeadSource(db, WORKSPACE_ID, NOW);
    expect(first?.status).toBe('running');
    expect(second).toBeNull();
  });
});

describe('running a source', () => {
  it('stores what the walk found and records the count on the source', async () => {
    await seat();
    const claimed = (await source(), await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({ leads: [lead('maya', 'Maya Chen'), lead('jonas', 'Jonas Keller')] });

    const result = await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(result.status).toBe('completed');
    expect(result.stored).toBe(2);
    expect(harness.calls).toEqual([{ surface: 'search', url: SEARCH_URL }]);

    const stored = await listLeads(db, WORKSPACE_ID, claimed.id);
    expect(stored.map((entry) => entry.profileUrl).sort()).toEqual([
      'https://www.linkedin.com/in/jonas/',
      'https://www.linkedin.com/in/maya/'
    ]);
    expect(stored[0].sourceId).toBe(claimed.id);

    const after = await getLeadSource(db, WORKSPACE_ID, claimed.id);
    expect(after).toMatchObject({ status: 'completed', resultCount: 2, failureReason: null });
    expect(after?.finishedAt).not.toBeNull();
  });

  it('sends a post source to the engagers walk, not the search walk', async () => {
    await seat();
    await source('post', POST_URL);
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper();
    await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });
    expect(harness.calls).toEqual([{ surface: 'post', url: POST_URL }]);
  });

  it('never re-targets someone excluded or already contacted', async () => {
    await seat();
    // Stored as a BARE HANDLE, which is what a CSV import produces.
    await db
      .prepare('INSERT INTO linkedin_exclusions (id,workspace_id,target_ref,reason,source,created_at) VALUES (?,?,?,?,?,?)')
      .run(id('lexcl'), WORKSPACE_ID, 'sofia', 'Asked us to stop', 'manual', NOW.toISOString());
    // Stored as a full URL with a tracking query, which is what the ledger holds.
    await recordAction(
      db,
      { workspaceId: WORKSPACE_ID, kind: 'invite', targetRef: 'https://www.linkedin.com/in/jonas/?trk=x', status: 'sent', source: 'export' },
      NOW
    );

    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({
      leads: [lead('maya', 'Maya Chen'), lead('jonas', 'Jonas Keller'), lead('sofia', 'Sofia Rossi')]
    });

    const result = await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(result.harvested).toBe(3);
    expect(result.stored).toBe(1);
    // THREE DIFFERENT FACTS, KEPT APART. "filtered: 2" would answer nothing.
    expect(result.filtered).toEqual({ duplicate: 0, excluded: 1, contacted: 1 });
    expect((await listLeads(db, WORKSPACE_ID, claimed.id)).map((entry) => entry.profileUrl)).toEqual([
      'https://www.linkedin.com/in/maya/'
    ]);
  });

  it('is idempotent across two runs of the same person', async () => {
    await seat();
    const leads = [lead('maya', 'Maya Chen')];

    await source();
    const first = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    await runLeadSource(db, first, { page, config: on(), scraper: fakeScraper({ leads }).scraper, now: () => NOW });

    await source();
    const second = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const again = await runLeadSource(db, second, { page, config: on(), scraper: fakeScraper({ leads }).scraper, now: () => NOW });

    expect(again.stored).toBe(0);
    expect(again.filtered.duplicate).toBe(1);
    // ONE PERSON, ONE ROW, and the FIRST source keeps them.
    const rows = await db.prepare('SELECT source_id FROM linkedin_leads WHERE workspace_id=?').all<{ source_id: string }>(WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(first.id);
  });

  it('keeps what a challenge interrupted, and still marks the source failed', async () => {
    await seat();
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({
      ok: false,
      failureKind: 'challenge',
      detail: 'LinkedIn is showing a challenge.',
      leads: [lead('maya', 'Maya Chen')]
    });

    const result = await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(result.status).toBe('failed');
    // The fetch happened and cost the account whatever it cost; binning the
    // person it returned would buy nothing back.
    expect(result.stored).toBe(1);
    const after = await getLeadSource(db, WORKSPACE_ID, claimed.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureReason).toContain('challenge');
  });
});

describe('the refusals', () => {
  it('refuses when the gate is off, and the scraper is never reached', async () => {
    await seat();
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({ leads: [lead('maya', 'Maya Chen')] });

    const result = await runLeadSource(db, claimed, {
      page,
      config: on({ optIn: false }),
      scraper: harness.scraper,
      now: () => NOW
    });

    expect(harness.calls).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('8.2');
    // Recorded on the row, not silently dropped: an operator can see why.
    expect((await getLeadSource(db, WORKSPACE_ID, claimed.id))?.status).toBe('failed');
  });

  it('refuses on a hosted deployment even with the opt-in set', async () => {
    await seat();
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper();
    const result = await runLeadSource(db, claimed, { page, config: on({ hosted: true }), scraper: harness.scraper, now: () => NOW });
    expect(harness.calls).toEqual([]);
    expect(result.failureReason).toContain('hosted');
  });

  it('refuses when no seat is configured, and when the seat is cooling down', async () => {
    await source();
    const noSeat = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const first = fakeScraper();
    const withoutSeat = await runLeadSource(db, noSeat, { page, config: on(), scraper: first.scraper, now: () => NOW });
    expect(first.calls).toEqual([]);
    expect(withoutSeat.failureReason).toContain('No LinkedIn seat');

    await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC', posture: 'cooldown' }, NOW);
    await source();
    const cooling = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const second = fakeScraper();
    const inCooldown = await runLeadSource(db, cooling, { page, config: on(), scraper: second.scraper, now: () => NOW });
    expect(second.calls).toEqual([]);
    // Page fetches are actions, so a cooldown covers them too.
    expect(inCooldown.failureReason).toContain('cooldown');
  });
});

describe('the surfaces a source can be', () => {
  it('accepts a Sales Navigator search and a content search, and refuses the wrong shape for each', async () => {
    expect(leadSourceUrlFor('sales_navigator', SALES_URL)).toBe(SALES_URL);
    expect(leadSourceUrlFor('content', CONTENT_URL)).toBe(CONTENT_URL);
    // Each kind is its own shape. A people search is not a Sales Navigator
    // search and a content search is not either, and a row holding the wrong
    // one is a row some later worker walks with the wrong selector table.
    expect(leadSourceUrlFor('sales_navigator', SEARCH_URL)).toBeNull();
    expect(leadSourceUrlFor('content', SEARCH_URL)).toBeNull();
    expect(leadSourceUrlFor('search', SALES_URL)).toBeNull();
    expect(leadSourceUrlFor('sales_navigator', 'https://evil.example/sales/search/people')).toBeNull();
    await expect(createLeadSource(db, { workspaceId: WORKSPACE_ID, kind: 'sales_navigator', url: SEARCH_URL }, NOW)).rejects.toThrow();
  });

  it('sends each kind to its own walk and to no other', async () => {
    await seat();
    await source('sales_navigator', SALES_URL);
    const sales = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const first = fakeScraper();
    await runLeadSource(db, sales, { page, config: on(), scraper: first.scraper, now: () => NOW });
    expect(first.calls).toEqual([{ surface: 'sales_navigator', url: SALES_URL }]);

    await source('content', CONTENT_URL);
    const content = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const second = fakeScraper();
    await runLeadSource(db, content, { page, config: on(), scraper: second.scraper, now: () => NOW });
    expect(second.calls).toEqual([{ surface: 'content', url: CONTENT_URL }]);
  });

  it('stores the post a lead was found on and how they touched it', async () => {
    await seat();
    await source('content', CONTENT_URL);
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({
      leads: [
        lead('maya', 'Maya Chen', { postUrl: POST_URL, interactionKind: 'post' }),
        lead('jonas', 'Jonas Keller', { postUrl: POST_URL, interactionKind: 'comment' }),
        // A reactor: neither the author nor a commenter, and not pressed into
        // being one.
        lead('sofia', 'Sofia Rossi', { postUrl: POST_URL })
      ]
    });

    await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    const stored = await listLeads(db, WORKSPACE_ID, claimed.id);
    const byHandle = Object.fromEntries(stored.map((entry) => [entry.profileUrl, entry]));
    expect(byHandle['https://www.linkedin.com/in/maya/']).toMatchObject({ postUrl: POST_URL, interactionKind: 'post', firstName: 'Maya', lastName: 'Chen' });
    expect(byHandle['https://www.linkedin.com/in/jonas/']).toMatchObject({ postUrl: POST_URL, interactionKind: 'comment' });
    expect(byHandle['https://www.linkedin.com/in/sofia/']).toMatchObject({ postUrl: POST_URL, interactionKind: null });
  });
});

describe('the scrubber runs on scraped leads too', () => {
  it('splits and scrubs a harvested display name before it is stored', async () => {
    await seat();
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({
      leads: [
        rawLead('maya', 'Dr. Maya \u{1F642} Chen, MBA'),
        // The token list is whole-token, so a real name that merely CONTAINS
        // one survives intact.
        rawLead('mason', 'Maya Mason')
      ]
    });

    await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    const stored = await listLeads(db, WORKSPACE_ID, claimed.id);
    const byHandle = Object.fromEntries(stored.map((entry) => [entry.profileUrl, entry]));
    expect(byHandle['https://www.linkedin.com/in/maya/']).toMatchObject({ name: 'Maya Chen', firstName: 'Maya', lastName: 'Chen' });
    expect(byHandle['https://www.linkedin.com/in/mason/']).toMatchObject({ name: 'Maya Mason', firstName: 'Maya', lastName: 'Mason' });
  });
});

describe('the daily lead cap', () => {
  it('defaults to 100 and refuses a value outside 0-1000', async () => {
    expect(await getDailyLeadCap(db, WORKSPACE_ID)).toBe(DEFAULT_DAILY_LEAD_CAP);
    await expect(setDailyLeadCap(db, WORKSPACE_ID, 1001)).rejects.toThrow();
    await expect(setDailyLeadCap(db, WORKSPACE_ID, -1)).rejects.toThrow();
    // 0 IS LEGAL: it is how an operator pauses without touching an environment
    // variable they may not own.
    expect(await setDailyLeadCap(db, WORKSPACE_ID, 0, NOW)).toBe(0);
    expect(await getDailyLeadCap(db, WORKSPACE_ID)).toBe(0);
  });

  it('stops a run mid-way and says how many people it would not keep', async () => {
    await seat();
    await setDailyLeadCap(db, WORKSPACE_ID, 2, NOW);
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({ leads: [lead('maya', 'Maya Chen'), lead('jonas', 'Jonas Keller'), lead('sofia', 'Sofia Rossi')] });

    const result = await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(result.harvested).toBe(3);
    expect(result.stored).toBe(2);
    expect(result.capped).toBe(1);
    expect(result.dailyCapReached).toBe(true);
    expect(result.dailyCap).toEqual({ limit: 2, used: 2, remaining: 0 });
    // SAID OUT LOUD, like every other truncation in this subsystem.
    expect(result.degraded.join(' ')).toContain('daily cap of 2');
    expect(await listLeads(db, WORKSPACE_ID, claimed.id)).toHaveLength(2);
  });

  it('fetches nothing at all once the window is spent, and never throws', async () => {
    await seat();
    await setDailyLeadCap(db, WORKSPACE_ID, 1, NOW);
    await source();
    const first = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    await runLeadSource(db, first, { page, config: on(), scraper: fakeScraper({ leads: [lead('maya', 'Maya Chen')] }).scraper, now: () => NOW });

    await source('post', POST_URL);
    const second = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({ leads: [lead('jonas', 'Jonas Keller')] });
    const result = await runLeadSource(db, second, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    // THE ASSERTION THAT MATTERS: the browser was never pointed at LinkedIn for
    // people this workspace could not have kept.
    expect(harness.calls).toEqual([]);
    expect(result.stored).toBe(0);
    expect(result.dailyCapReached).toBe(true);
    expect(result.failureReason).toContain('daily lead cap');
    expect((await getLeadSource(db, WORKSPACE_ID, second.id))?.failureReason).toContain('daily lead cap');
  });

  it('scrubs a name a writer handed over already split, not only one it split itself', async () => {
    await seat();
    await source();
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    // A `ScrapedLead` built by something other than the driver's `makeLead` --
    // an importer, a fixture, a future surface. The pre-split branch used to
    // copy these two columns THROUGH, raw, under a comment promising that the
    // scrub runs on every path into the table.
    const harness = fakeScraper({
      leads: [{ ...lead('maya', 'Maya Chen'), firstName: 'Dr. Maya', lastName: 'Chen \u{1F1FA}\u{1F1F8} Ph.D.' }]
    });

    await runLeadSource(db, claimed, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    const [stored] = await listLeads(db, WORKSPACE_ID, claimed.id);
    expect(stored).toMatchObject({ firstName: 'Maya', lastName: 'Chen', name: 'Maya Chen' });
  });

  it('rolls: leads older than 24 hours do not count against today', async () => {
    await seat();
    await setDailyLeadCap(db, WORKSPACE_ID, 1, NOW);
    await source();
    const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const claimed = (await claimLeadSource(db, WORKSPACE_ID, yesterday))!;
    await runLeadSource(db, claimed, { page, config: on(), scraper: fakeScraper({ leads: [lead('maya', 'Maya Chen')] }).scraper, now: () => yesterday });

    await source('post', POST_URL);
    const today = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const harness = fakeScraper({ leads: [lead('jonas', 'Jonas Keller')] });
    const result = await runLeadSource(db, today, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(harness.calls).toHaveLength(1);
    expect(result.stored).toBe(1);
  });

  it('holds under two passes running at once, rather than letting both spend the same day', async () => {
    await seat();
    await setDailyLeadCap(db, WORKSPACE_ID, 10, NOW);
    const eight = (prefix: string) => Array.from({ length: 8 }, (_unused, index) => lead(`${prefix}${index}`, `Person ${prefix}${index}`));
    await source('search', SEARCH_URL);
    await source('post', POST_URL);
    const first = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;
    const second = (await claimLeadSource(db, WORKSPACE_ID, NOW))!;

    // TWO WALKS THAT FINISH AT THE SAME MOMENT. Each read the allowance before
    // it fetched -- correctly, that is what stops the pages being loaded -- and
    // each then wrote against a number that was true when it was read and stale
    // by the time it was used. Both saw `remaining: 10` and both stored 8, so a
    // cap of 10 became 16. "At most N a day" was true of each pass and false of
    // the workspace, which is the only place it was ever promised.
    const [a, b] = await Promise.all([
      runLeadSource(db, first, { page, config: on(), scraper: fakeScraper({ leads: eight('a') }).scraper, now: () => NOW }),
      runLeadSource(db, second, { page, config: on(), scraper: fakeScraper({ leads: eight('b') }).scraper, now: () => NOW })
    ]);

    expect(a.stored + b.stored).toBe(10);
    // The one that lost the race says what it dropped, in the same sentence any
    // other truncation uses.
    expect(Math.max(a.capped, b.capped)).toBe(6);
    const stored = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_leads WHERE workspace_id=?').get<{ total: number }>(WORKSPACE_ID);
    expect(Number(stored?.total)).toBe(10);
    // And the allowance each run reports is the one it actually reserved, not
    // the one it read a page walk ago.
    expect(Math.max(a.dailyCap.used, b.dailyCap.used)).toBe(10);
  });

  it('stops the whole pass rather than walking the next source for nothing', async () => {
    await seat();
    await setDailyLeadCap(db, WORKSPACE_ID, 1, NOW);
    await source('search', SEARCH_URL);
    await source('post', POST_URL);
    const harness = fakeScraper({ leads: [lead('maya', 'Maya Chen')] });

    const results = await runPendingLeadSources(db, WORKSPACE_ID, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(results).toHaveLength(1);
    expect(results[0].dailyCapReached).toBe(true);
    expect(harness.calls).toHaveLength(1);
    // The second source is still pending, so tomorrow runs it.
    expect((await listLeadSources(db, WORKSPACE_ID)).filter((entry) => entry.status === 'pending')).toHaveLength(1);
  });
});

describe('runPendingLeadSources', () => {
  it('claims nothing at all when the gate is off, so the queue survives the switch', async () => {
    await seat();
    await source();
    const harness = fakeScraper();
    const results = await runPendingLeadSources(db, WORKSPACE_ID, {
      page,
      config: on({ optIn: false }),
      scraper: harness.scraper,
      now: () => NOW
    });
    expect(results).toEqual([]);
    expect(harness.calls).toEqual([]);
    // Still pending, so turning the switch on later runs it.
    expect((await listLeadSources(db, WORKSPACE_ID))[0].status).toBe('pending');
  });

  it('stops the whole pass on the first failure rather than walking the next search', async () => {
    await seat();
    await source('search', SEARCH_URL);
    await source('post', POST_URL);
    const harness = fakeScraper({ ok: false, failureKind: 'limit_wall', detail: 'A limit notice is on screen.' });

    const results = await runPendingLeadSources(db, WORKSPACE_ID, { page, config: on(), scraper: harness.scraper, now: () => NOW });

    expect(results).toHaveLength(1);
    expect(harness.calls).toHaveLength(1);
    expect((await listLeadSources(db, WORKSPACE_ID)).filter((entry) => entry.status === 'pending')).toHaveLength(1);
  });
});
