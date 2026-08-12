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

const page = {} as LinkedInScrapePage;

/** Opted in, self-hosted. The only configuration in which anything happens. */
function on(overrides: Partial<LeadSourcingConfig> = {}): LeadSourcingConfig {
  return { optIn: true, hosted: false, maxResults: 100, maxPages: 10, ...overrides };
}

function lead(handle: string, name: string): ScrapedLead {
  return {
    profileUrl: `https://www.linkedin.com/in/${handle}/`,
    name,
    headline: 'Founder',
    company: 'Acme'
  };
}

interface ScraperHarness {
  scraper: LinkedInScrapeDriver;
  calls: Array<{ surface: 'search' | 'post'; url: string }>;
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
  return {
    calls,
    scraper: {
      scrapeSearchResults: async (_page, url) => {
        calls.push({ surface: 'search', url });
        return answer();
      },
      scrapePostEngagers: async (_page, url) => {
        calls.push({ surface: 'post', url });
        return answer();
      }
    }
  };
}

async function seat(): Promise<void> {
  await upsertSeat(db, WORKSPACE_ID, { label: 'Test seat', timezone: 'UTC' }, NOW);
}

async function source(kind: 'search' | 'post' = 'search', url = SEARCH_URL) {
  const created = await createLeadSource(db, { workspaceId: WORKSPACE_ID, kind, url }, NOW);
  return created.source;
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(WORKSPACE_ID, 'LinkedIn Leads Test', NOW.toISOString());
  for (const table of ['linkedin_leads', 'linkedin_lead_sources', 'linkedin_actions', 'linkedin_exclusions', 'linkedin_seats']) {
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
