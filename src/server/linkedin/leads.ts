import { z } from 'zod';
import { id, type Db } from '../db.js';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  HARD_MAX_PAGES,
  HARD_MAX_RESULTS,
  canonicalProfileUrl,
  contentSearchUrlFor,
  playwrightScrapeDriver,
  postUrlFor,
  salesNavigatorUrlFor,
  searchResultsUrlFor,
  type LeadInteractionKind,
  type LinkedInScrapeDriver,
  type LinkedInScrapePage,
  type ScrapeOptions,
  type ScrapeResult,
  type ScrapedLead
} from './driver-scrape.js';
import { scrubNameField, splitAndScrubName } from './lead-import.js';
import { getSeatPosture, type SeatPosture } from './seats.js';

/**
 * Lead sourcing: turning a LinkedIn search URL or a post's engagement into a
 * list of people, without ever turning it into a list of people we contact.
 *
 * WHY THIS IS GATED SEPARATELY FROM EVERYTHING ELSE. Sending an invite is the
 * operator acting on their own account. Reading 100 profiles out of a search
 * result is SCRAPING, which User Agreement 8.2 names directly -- browser
 * extensions included, by category -- and which hiQ left exposed as breach of
 * contract even after the CFAA claim failed (plan 1.2). Different risk, so a
 * different switch: {@link leadSourcingEnabled} is FALSE unless a self-hoster
 * turns it on by hand, and a hosted deployment can never turn it on at all.
 * Somebody who wanted paced sending has not thereby asked for a crawler.
 *
 * FOUR RULES, and each one is why a piece of this file exists:
 *
 * 1. THE GATE IS CHECKED WHERE THE NETWORK IS, not where the button is. A
 *    route that forgot to check would otherwise be a scraper, so
 *    {@link runLeadSource} refuses on its own and records the refusal on the
 *    row instead of leaving it pending forever.
 * 2. THE SEAT'S POSTURE STILL GOVERNS. A seat in cooldown after a limit wall
 *    must not spend that cooldown loading ten search pages. Same refusal the
 *    local worker uses, for the same reason -- what clears a cooldown is a
 *    person, not a different subsystem.
 * 3. CLAIM BEFORE ACT. A source is moved 'pending' -> 'running' in one
 *    statement before anything is fetched, so a double-clicked button walks the
 *    search once. Same `FOR UPDATE SKIP LOCKED` claim `linkedin_actions` uses,
 *    guarded by the same kind of partial unique index -- one mechanism, not a
 *    second one invented here.
 * 4. A HARVESTED LIST IS FILTERED BEFORE IT IS STORED, against the workspace's
 *    exclusions AND against everyone already in the action ledger. A list that
 *    re-targets somebody who asked us to stop is worse than no list, and
 *    filtering at SEND time would be too late: by then the person is already in
 *    a payload a founder read and approved.
 *
 * A LEAD IS NOT AN ACTION. Nothing here plans, paces or sends anything. It
 * produces rows a human then chooses to put in a campaign, and
 * `linkedin_actions` remains the only ledger.
 */

/* ---------------------------------------------------------------------------
 * The gate.
 * ------------------------------------------------------------------------ */

export interface LeadSourcingConfig {
  /** `TREVRA_LINKEDIN_LEAD_SOURCING=true`. Absent means OFF. */
  optIn: boolean;
  /** `TREVRA_DEPLOYMENT_MODE=hosted`. Overrides `optIn` unconditionally. */
  hosted: boolean;
  /** Ceiling on people per run. */
  maxResults: number;
  /** Ceiling on page fetches per run. */
  maxPages: number;
}

const leadSourcingEnv = z.object({
  TREVRA_LINKEDIN_LEAD_SOURCING: z.enum(['true', 'false']).optional(),
  TREVRA_DEPLOYMENT_MODE: z.enum(['local', 'hosted']).default('local'),
  TREVRA_LINKEDIN_LEAD_MAX_RESULTS: z.coerce.number().int().min(1).max(HARD_MAX_RESULTS).optional(),
  TREVRA_LINKEDIN_LEAD_MAX_PAGES: z.coerce.number().int().min(1).max(HARD_MAX_PAGES).optional()
});

/**
 * Lead sourcing's slice of the environment.
 *
 * OPT-IN, WHERE THE WORKER IS OPT-OUT, and the asymmetry is the whole point.
 * `linkedInWorkerConfig` defaults ON for a self-hoster because automating your
 * own account on your own machine is what the product is for. Harvesting other
 * people's profiles is a decision with a different name on it, and defaulting
 * it on would mean a self-hoster who upgraded acquired a crawler they never
 * asked for.
 */
export function leadSourcingConfig(env: NodeJS.ProcessEnv = process.env): LeadSourcingConfig {
  const parsed = leadSourcingEnv.parse(env);
  return {
    optIn: parsed.TREVRA_LINKEDIN_LEAD_SOURCING === 'true',
    hosted: parsed.TREVRA_DEPLOYMENT_MODE === 'hosted',
    maxResults: parsed.TREVRA_LINKEDIN_LEAD_MAX_RESULTS ?? DEFAULT_MAX_RESULTS,
    maxPages: parsed.TREVRA_LINKEDIN_LEAD_MAX_PAGES ?? DEFAULT_MAX_PAGES
  };
}

/**
 * May this deployment harvest leads? THE ONE PLACE THAT ANSWERS IT.
 *
 * `hosted` is the hard no, exactly as it is for the local worker: a hosted,
 * multi-tenant Trevra scraping LinkedIn on one human's session is the exposure
 * the whole design avoids, and no environment variable may undo it. Everything
 * else is a self-hoster's own explicit yes.
 */
export function leadSourcingEnabled(config: Pick<LeadSourcingConfig, 'optIn' | 'hosted'>): boolean {
  return config.optIn && !config.hosted;
}

/**
 * Why lead sourcing is off, in one sentence.
 *
 * TWO KINDS OF OFF, same distinction as `linkedInOffReason`: hosted is a
 * decision the deployment made and no setting can undo it; anything else has a
 * switch, and the sentence names it so nobody goes hunting.
 */
export function leadSourcingOffReason(config: Pick<LeadSourcingConfig, 'optIn' | 'hosted'>): string {
  if (config.hosted) {
    return 'This deployment is hosted, so LinkedIn lead sourcing is off and cannot be enabled. Reading profiles out of search results is scraping under LinkedIn\'s User Agreement 8.2, and a hosted Trevra will not do it on anyone\'s account.';
  }
  return 'LinkedIn lead sourcing is switched off. It is a separate opt-in from sending, because harvesting profiles from search results and post engagement is scraping under LinkedIn\'s User Agreement 8.2 and the contractual exposure lands on your own account. Set TREVRA_LINKEDIN_LEAD_SOURCING=true if you accept that.';
}

/* ---------------------------------------------------------------------------
 * Rows.
 * ------------------------------------------------------------------------ */

/**
 * The four surfaces a list of people can come from.
 *
 * FOUR KINDS AND NOT A GENERIC 'url', for the reason migration 030 gives for
 * the first two: they are four different walks with four different selector
 * tables and four different failure shapes, and a column that said only "a
 * URL" would push that distinction into a regex at every read site.
 *
 *   'search'          -- /search/results/people/, walked page by page
 *   'post'            -- one post permalink; its reactors and its commenters
 *   'sales_navigator' -- /sales/search/people, a different product's result list
 *   'content'         -- /search/results/content/, keyword discovery: the posts
 *                        that match, then their authors and commenters
 */
export type LeadSourceKind = 'search' | 'post' | 'sales_navigator' | 'content';

/** Every accepted kind, for the route schema that has to name them. */
export const LEAD_SOURCE_KINDS = ['search', 'post', 'sales_navigator', 'content'] as const;

export type LeadSourceStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface LinkedInLeadSource {
  id: string;
  workspaceId: string;
  kind: LeadSourceKind;
  url: string;
  status: LeadSourceStatus;
  requestedAt: string;
  finishedAt: string | null;
  /** People STORED, not people seen. */
  resultCount: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedInLead {
  id: string;
  workspaceId: string;
  sourceId: string;
  profileUrl: string;
  /** The scrubbed display name -- `firstName` and `lastName` joined. */
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  company: string | null;
  /** The post they were found on, or null when the surface was not a post. */
  postUrl: string | null;
  /** 'post' for its author, 'comment' for a commenter, null otherwise. */
  interactionKind: LeadInteractionKind | null;
  createdAt: string;
}

interface LeadSourceRow {
  id: string;
  workspace_id: string;
  kind: string;
  url: string;
  status: string;
  requested_at: string;
  finished_at: string | null;
  result_count: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  workspace_id: string;
  source_id: string;
  profile_url: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  company: string | null;
  post_url: string | null;
  interaction_kind: string | null;
  created_at: string;
}

const SOURCE_COLUMNS = `
  id, workspace_id, kind, url, status, requested_at, finished_at,
  result_count, failure_reason, created_at, updated_at
`;

const LEAD_COLUMNS = `
  id, workspace_id, source_id, profile_url, name, first_name, last_name,
  headline, company, post_url, interaction_kind, created_at
`;

const INTERACTION_KINDS = new Set<string>(['post', 'comment']);

/** The stored kind, or null. An unrecognised string is a null, never a guess. */
function interactionKindOf(value: string | null | undefined): LeadInteractionKind | null {
  return value && INTERACTION_KINDS.has(value) ? (value as LeadInteractionKind) : null;
}

function toSource(row: LeadSourceRow): LinkedInLeadSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as LeadSourceKind,
    url: row.url,
    status: row.status as LeadSourceStatus,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    resultCount: row.result_count,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toLead(row: LeadRow): LinkedInLead {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    profileUrl: row.profile_url,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    headline: row.headline,
    company: row.company,
    postUrl: row.post_url,
    interactionKind: interactionKindOf(row.interaction_kind),
    createdAt: row.created_at
  };
}

/* ---------------------------------------------------------------------------
 * Creating and reading sources.
 * ------------------------------------------------------------------------ */

export interface LeadSourceInsert {
  workspaceId: string;
  kind: LeadSourceKind;
  /** As the operator supplied it. Validated here, never rewritten. */
  url: string;
}

/**
 * The canonical form of a source URL, or null when it is not one.
 *
 * VALIDATED BEFORE THE ROW EXISTS, not before the fetch. A row holding
 * `https://evil.example/x` is a row some later worker will try to open in an
 * authenticated browser, and the fix for that is to never write it.
 */
export function leadSourceUrlFor(kind: LeadSourceKind, url: string): string | null {
  switch (kind) {
    case 'search':
      return searchResultsUrlFor(url);
    case 'post':
      return postUrlFor(url);
    case 'sales_navigator':
      return salesNavigatorUrlFor(url);
    case 'content':
      return contentSearchUrlFor(url);
    default:
      return null;
  }
}

/** What a rejected URL of each kind should have looked like. */
const LEAD_SOURCE_SHAPES: Record<LeadSourceKind, string> = {
  search: 'a LinkedIn people-search URL (https://www.linkedin.com/search/results/people/...)',
  post: 'a LinkedIn post URL (https://www.linkedin.com/feed/update/urn:li:activity:... or /posts/...)',
  sales_navigator: 'a LinkedIn Sales Navigator people-search URL (https://www.linkedin.com/sales/search/people?...)',
  content: 'a LinkedIn content-search URL (https://www.linkedin.com/search/results/content/?keywords=...)'
};

/**
 * Ask for a source to be walked.
 *
 * Returns the EXISTING row when this workspace already has a live source for
 * the same URL, so a double-clicked button is a no-op rather than a second
 * walk -- same contract as `recordAction`, enforced by the same kind of partial
 * unique index and reported rather than thrown.
 */
export async function createLeadSource(
  db: Db,
  input: LeadSourceInsert,
  now: Date
): Promise<{ source: LinkedInLeadSource; duplicate: boolean }> {
  const url = leadSourceUrlFor(input.kind, input.url);
  if (!url) {
    throw new Error(`'${input.url}' is not ${LEAD_SOURCE_SHAPES[input.kind] ?? 'a supported LinkedIn lead source URL'}.`);
  }

  const sourceId = id('llsrc');
  const iso = now.toISOString();
  const inserted = await db.prepare(`
    INSERT INTO linkedin_lead_sources
      (id, workspace_id, kind, url, status, requested_at, created_at, updated_at)
    VALUES (?,?,?,?,'pending',?,?,?)
    ON CONFLICT DO NOTHING
    RETURNING ${SOURCE_COLUMNS}
  `).get<LeadSourceRow>(sourceId, input.workspaceId, input.kind, url, iso, iso, iso);
  if (inserted) return { source: toSource(inserted), duplicate: false };

  // The guard fired. The live row is the answer -- and there is exactly one,
  // because that is what the index enforces.
  const existing = await db.prepare(`
    SELECT ${SOURCE_COLUMNS} FROM linkedin_lead_sources
    WHERE workspace_id=? AND kind=? AND LOWER(url)=LOWER(?) AND status IN ('pending','running')
    ORDER BY requested_at ASC LIMIT 1
  `).get<LeadSourceRow>(input.workspaceId, input.kind, url);
  if (!existing) throw new Error('The lead source could not be created and no live source claims its URL.');
  return { source: toSource(existing), duplicate: true };
}

export async function listLeadSources(db: Db, workspaceId: string, limit = 50): Promise<LinkedInLeadSource[]> {
  const rows = await db.prepare(`
    SELECT ${SOURCE_COLUMNS} FROM linkedin_lead_sources
    WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?
  `).all<LeadSourceRow>(workspaceId, Math.max(1, Math.min(200, Math.trunc(limit))));
  return rows.map(toSource);
}

export async function getLeadSource(db: Db, workspaceId: string, sourceId: string): Promise<LinkedInLeadSource | undefined> {
  const row = await db.prepare(`
    SELECT ${SOURCE_COLUMNS} FROM linkedin_lead_sources WHERE workspace_id=? AND id=?
  `).get<LeadSourceRow>(workspaceId, sourceId);
  return row ? toSource(row) : undefined;
}

/**
 * Claim the oldest pending source, or null when there is none.
 *
 * CLAIM AND SELECT IN ONE STATEMENT, with `FOR UPDATE SKIP LOCKED`, exactly as
 * `claimNextDueAction` does -- two workers on the same box take different rows
 * instead of the same one, and the row is 'running' before a single byte is
 * fetched. There is no second mechanism here and there must not be: an
 * idempotency scheme that disagrees with the one next door is how the same
 * search gets walked twice.
 */
export async function claimLeadSource(db: Db, workspaceId: string, now: Date): Promise<LinkedInLeadSource | null> {
  const row = await db.prepare(`
    UPDATE linkedin_lead_sources SET status='running', updated_at=?
    WHERE id = (
      SELECT id FROM linkedin_lead_sources
      WHERE workspace_id=? AND status='pending'
      ORDER BY requested_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${SOURCE_COLUMNS}
  `).get<LeadSourceRow>(now.toISOString(), workspaceId);
  return row ? toSource(row) : null;
}

/**
 * HOW MANY OF A SOURCE'S PEOPLE ARE EVER READ AT ONCE. One number, and it is
 * both the default and the ceiling, on purpose.
 *
 * THE THREE LIMITS IN THIS PIPELINE USED TO DISAGREE and every one of them was
 * a literal typed at its own call site: the leads screen asked for 500, the
 * import into a list defaulted to 2000, and the contacts route capped at 5000.
 * A source holding 800 people therefore showed 500 rows above a Save button
 * that wrote 800 -- the operator reviewed one set and shipped another, with
 * nothing anywhere saying so.
 *
 * Exported so the route, the screen and {@link importLeadSourceContacts} quote
 * THIS number rather than each inventing one. The pair with it is
 * `LEAD_CONTACT_READ_LIMIT` in lead-lists.ts, which does the same job for the
 * contacts side.
 */
export const LEAD_READ_LIMIT = 2_000;

/** The people one source found, newest first. */
export async function listLeads(db: Db, workspaceId: string, sourceId: string, limit = LEAD_READ_LIMIT): Promise<LinkedInLead[]> {
  const rows = await db.prepare(`
    SELECT ${LEAD_COLUMNS} FROM linkedin_leads
    WHERE workspace_id=? AND source_id=? ORDER BY created_at DESC, id DESC LIMIT ?
  `).all<LeadRow>(workspaceId, sourceId, Math.max(1, Math.min(LEAD_READ_LIMIT, Math.trunc(limit))));
  return rows.map(toLead);
}

/** Close a source out. The only writer of a terminal status. */
async function finishLeadSource(
  db: Db,
  workspaceId: string,
  sourceId: string,
  outcome: { status: Extract<LeadSourceStatus, 'completed' | 'failed'>; resultCount: number; failureReason: string | null },
  now: Date
): Promise<void> {
  const iso = now.toISOString();
  await db.prepare(`
    UPDATE linkedin_lead_sources
    SET status=?, result_count=?, failure_reason=?, finished_at=?, updated_at=?
    WHERE workspace_id=? AND id=?
  `).run(outcome.status, outcome.resultCount, outcome.failureReason, iso, iso, workspaceId, sourceId);
}

/* ---------------------------------------------------------------------------
 * The daily cap.
 * ------------------------------------------------------------------------ */

/**
 * How many leads a workspace may STORE in any rolling 24 hours.
 *
 * A PER-RUN CEILING IS NOT A DAILY ONE, and until now only per-run ceilings
 * existed: `maxResults` bounds one walk, `maxSources` bounds one pass, and ten
 * passes of ten is a hundred with nothing anywhere saying stop. "At most N
 * leads a day" is a promise about a WORKSPACE OVER TIME, so it is counted over
 * time, from rows actually written.
 *
 * COUNTED FROM ROWS STORED, NOT ROWS SEEN. A harvest of 100 that filtered 60
 * already-contacted people spent 40 of the cap, because 40 is what the operator
 * got. Counting what was fetched would let a workspace exhaust its day on
 * people it was never allowed to contact.
 *
 * ROLLING, NOT MIDNIGHT. A calendar day resets at an hour LinkedIn does not
 * care about and hands a fresh hundred to whoever is awake at 00:01, which is
 * exactly the burst shape the pacing everywhere else in this subsystem exists
 * to avoid.
 */
export const DEFAULT_DAILY_LEAD_CAP = 100;
export const MAX_DAILY_LEAD_CAP = 1000;
export const DAILY_LEAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * This workspace's cap. The DEFAULT when no row exists.
 *
 * The absent row is not written on read: "has an operator chosen a cap?" stays
 * answerable, and a default that lives in one constant cannot drift from a
 * default that was copied into ten thousand rows.
 */
export async function getDailyLeadCap(db: Db, workspaceId: string): Promise<number> {
  const row = await db.prepare('SELECT daily_lead_cap FROM linkedin_lead_settings WHERE workspace_id=?')
    .get<{ daily_lead_cap: number }>(workspaceId);
  return row ? Number(row.daily_lead_cap) : DEFAULT_DAILY_LEAD_CAP;
}

/**
 * Set the cap. 0 is legal and means "no harvesting", which is the control an
 * operator has at hand when they want to pause without touching an environment
 * variable they may not own.
 */
export async function setDailyLeadCap(db: Db, workspaceId: string, cap: number, now: Date = new Date()): Promise<number> {
  const value = Math.trunc(Number(cap));
  if (!Number.isFinite(value) || value < 0 || value > MAX_DAILY_LEAD_CAP) {
    throw new Error(`The daily lead cap must be a whole number between 0 and ${MAX_DAILY_LEAD_CAP}.`);
  }
  const iso = now.toISOString();
  await db.prepare(`
    INSERT INTO linkedin_lead_settings (workspace_id, daily_lead_cap, created_at, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT (workspace_id) DO UPDATE SET daily_lead_cap=EXCLUDED.daily_lead_cap, updated_at=EXCLUDED.updated_at
  `).run(workspaceId, value, iso, iso);
  return value;
}

/** Leads STORED by this workspace since `since`. */
export async function leadsStoredSince(db: Db, workspaceId: string, since: Date): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_leads WHERE workspace_id=? AND created_at >= ?')
    .get<{ total: number }>(workspaceId, since.toISOString());
  return Number(row?.total ?? 0);
}

export interface DailyLeadAllowance {
  /** The cap in force. */
  limit: number;
  /** Leads stored in the last 24 hours. */
  used: number;
  /** How many more may be stored right now. Never negative. */
  remaining: number;
}

/**
 * Namespaces the daily-cap advisory lock. 'LEAD' in ASCII, so a collision
 * would have to be another subsystem deliberately picking the same class.
 */
const LEAD_CAP_LOCK_CLASS = 0x4c454144;

/**
 * The cap, what it has spent, and what is left.
 *
 * A READ, NOT A RESERVATION, and callers must treat it as one: it is what
 * `runLeadSource` bounds the FETCH with, and the authoritative slice is taken
 * again inside `storeLeads` under a lock. Nothing between this call and that
 * one stops another pass spending the same day.
 */
export async function dailyLeadAllowance(db: Db, workspaceId: string, now: Date): Promise<DailyLeadAllowance> {
  const limit = await getDailyLeadCap(db, workspaceId);
  const used = await leadsStoredSince(db, workspaceId, new Date(now.getTime() - DAILY_LEAD_WINDOW_MS));
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/* ---------------------------------------------------------------------------
 * The filter: who a harvested list may NOT contain.
 * ------------------------------------------------------------------------ */

/**
 * Everyone this workspace must not re-target, as canonical profile URLs.
 *
 * TWO SOURCES AND BOTH ARE MANDATORY. `linkedin_exclusions` is people who asked
 * us to stop or who must never be contacted; `linkedin_actions` is everyone
 * already invited, messaged or viewed. A harvested list that re-offers either
 * one is a list whose whole purpose has been defeated -- and catching it at
 * send time would be too late, because by then the person sits inside an
 * approved payload a founder has already read.
 *
 * BOTH FORMS ARE KEPT for every ref. The ledger and the exclusion list store
 * whatever a human or a CSV supplied -- a bare handle, a URL with a tracking
 * query, an `http://` link -- so each ref contributes its canonical form when
 * it has one AND its lowercased literal when it does not. Matching on only the
 * canonical form would silently stop excluding anybody whose row was stored as
 * a profile sub-page.
 *
 * lc-debt: reads the workspace's whole action ledger and exclusion list per
 * run -- fine at a year of paced volume (~7k rows), not at agency scale;
 * upgrade path is a canonical-ref column on both tables plus an ANY() lookup
 * keyed on the harvested URLs.
 */
async function suppressionSets(db: Db, workspaceId: string): Promise<{ excluded: Set<string>; contacted: Set<string> }> {
  const [exclusionRows, actionRows] = await Promise.all([
    db.prepare('SELECT target_ref FROM linkedin_exclusions WHERE workspace_id=?').all<{ target_ref: string }>(workspaceId),
    db.prepare(`
      SELECT DISTINCT target_ref FROM linkedin_actions
      WHERE workspace_id=? AND target_ref IS NOT NULL AND status <> 'skipped'
    `).all<{ target_ref: string }>(workspaceId)
  ]);
  return { excluded: refSet(exclusionRows), contacted: refSet(actionRows) };
}

function refSet(rows: Array<{ target_ref: string | null }>): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    const raw = row.target_ref?.trim();
    if (!raw) continue;
    set.add(raw.toLowerCase());
    const canonical = canonicalProfileUrl(raw);
    if (canonical) set.add(canonical.toLowerCase());
  }
  return set;
}

/* ---------------------------------------------------------------------------
 * Running a source.
 * ------------------------------------------------------------------------ */

export interface LeadSourceRunDeps {
  /** The signed-in page. Supplied by whatever owns the browser. */
  page: LinkedInScrapePage;
  config: LeadSourcingConfig;
  /** Defaults to the real Playwright scraper. Injected so tests pass a fake. */
  scraper?: LinkedInScrapeDriver;
  now?: () => Date;
  /** Defaults to a real timer, via the scraper. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface LeadSourceRunResult {
  sourceId: string;
  status: Extract<LeadSourceStatus, 'completed' | 'failed'>;
  /** People the walk returned, after the driver's own cap. */
  harvested: number;
  /** Rows written. The number `result_count` records. */
  stored: number;
  /** Why the rest were not written. Three different facts, kept apart. */
  filtered: { duplicate: number; excluded: number; contacted: number };
  /** People the walk found and the DAILY cap would not let us keep. */
  capped: number;
  /** The cap, what it had spent before this run, and what is left after it. */
  dailyCap: DailyLeadAllowance;
  /**
   * The daily cap is spent. Reported rather than thrown, and the pass stops:
   * the next source would fetch pages for people it could not store.
   */
  dailyCapReached: boolean;
  /** What could not be read, plus what the cap dropped. */
  degraded: string[];
  failureReason: string | null;
}

/** Point a claimed source at the walk its kind names. */
function walkFor(
  scraper: LinkedInScrapeDriver,
  page: LinkedInScrapePage,
  source: LinkedInLeadSource,
  options: ScrapeOptions
): Promise<ScrapeResult> {
  switch (source.kind) {
    case 'search':
      return scraper.scrapeSearchResults(page, source.url, options);
    case 'post':
      return scraper.scrapePostEngagers(page, source.url, options);
    case 'sales_navigator':
      return scraper.scrapeSalesNavigatorResults(page, source.url, options);
    case 'content':
      return scraper.scrapeContentSearch(page, source.url, options);
    default:
      // A kind no walk answers is a row written by a version that knew
      // something this one does not. Refused, never guessed at.
      return Promise.resolve({
        ok: false,
        failureKind: 'not_found',
        detail: `'${String(source.kind)}' is not a lead source kind this build knows how to walk.`,
        leads: [],
        degraded: [],
        pagesWalked: 0,
        dropped: 0
      });
  }
}

/**
 * Walk one claimed source and store what it found.
 *
 * REFUSES RATHER THAN THROWS, and records the refusal on the row. A source left
 * 'running' forever because a gate said no is a source no operator can see the
 * reason for, and the reason is the only useful part.
 *
 * NOTHING IS STORED FOR A CHALLENGE OR A LIMIT WALL? No -- the opposite.
 * Whatever was harvested before the wall IS stored, because those fetches
 * already happened and already cost the account whatever they cost. The source
 * is still marked 'failed', because it did not finish and re-running it is the
 * right next step once a human has cleared whatever LinkedIn asked for.
 */
export async function runLeadSource(
  db: Db,
  source: LinkedInLeadSource,
  deps: LeadSourceRunDeps
): Promise<LeadSourceRunResult> {
  const now = deps.now ?? (() => new Date());
  const scraper = deps.scraper ?? playwrightScrapeDriver;
  const empty: LeadSourceRunResult = {
    sourceId: source.id,
    status: 'failed',
    harvested: 0,
    stored: 0,
    filtered: { duplicate: 0, excluded: 0, contacted: 0 },
    capped: 0,
    dailyCap: { limit: DEFAULT_DAILY_LEAD_CAP, used: 0, remaining: DEFAULT_DAILY_LEAD_CAP },
    dailyCapReached: false,
    degraded: [],
    failureReason: null
  };

  if (!leadSourcingEnabled(deps.config)) {
    const reason = leadSourcingOffReason(deps.config);
    await finishLeadSource(db, source.workspaceId, source.id, { status: 'failed', resultCount: 0, failureReason: reason }, now());
    return { ...empty, failureReason: reason };
  }

  // THE SEAT'S POSTURE STILL GOVERNS. A seat cooling down after a limit wall is
  // a seat LinkedIn pushed back on; spending that cooldown on ten search-page
  // fetches would be the same account making the same noise under another name.
  const posture = await getSeatPosture(db, source.workspaceId, now());
  const refusal = postureRefusal(posture);
  if (refusal) {
    await finishLeadSource(db, source.workspaceId, source.id, { status: 'failed', resultCount: 0, failureReason: refusal }, now());
    return { ...empty, failureReason: refusal };
  }

  // THE DAILY CAP IS READ BEFORE THE FETCH, NOT AFTER IT. A run that harvests
  // 100 people it is not allowed to keep has already spent the account's
  // standing on all of them; the only cap worth having is one that stops the
  // pages from being loaded at all.
  const allowance = await dailyLeadAllowance(db, source.workspaceId, now());
  if (allowance.remaining <= 0) {
    const reason = allowance.limit === 0
      ? 'The daily lead cap for this workspace is 0, so no leads may be stored and nothing was fetched. Raise the cap to start sourcing again.'
      : `The daily lead cap of ${allowance.limit} is already spent (${allowance.used} lead${allowance.used === 1 ? '' : 's'} stored in the last 24 hours), so nothing was fetched. The window rolls; this source can be re-queued once it does.`;
    await finishLeadSource(db, source.workspaceId, source.id, { status: 'failed', resultCount: 0, failureReason: reason }, now());
    return { ...empty, dailyCap: allowance, dailyCapReached: true, failureReason: reason };
  }

  const options = {
    // The walk itself is told to stop at whatever is left of the day, so the
    // cap costs fetches rather than merely discarding their results.
    maxResults: Math.min(deps.config.maxResults, allowance.remaining),
    maxPages: deps.config.maxPages,
    seed: source.id,
    sleep: deps.sleep,
    log: deps.log
  };
  const outcome = await walkFor(scraper, deps.page, source, options);

  // THE ALLOWANCE READ ABOVE BOUNDED THE FETCH; THE ONE THAT COMES BACK HERE
  // IS THE ONE THAT COUNTS. `storeLeads` re-reads the window under a lock and
  // reports what it actually reserved, because between the read at the top of
  // this function and the write at the bottom sits a whole page walk -- easily
  // a minute -- during which another pass may have spent the same day.
  const stored = await storeLeads(db, source, outcome.leads, now());
  const failureReason = outcome.ok
    ? null
    : `${outcome.failureKind ?? 'unknown'}: ${outcome.detail ?? 'The walk stopped early and said nothing about why.'}`;

  await finishLeadSource(
    db,
    source.workspaceId,
    source.id,
    { status: outcome.ok ? 'completed' : 'failed', resultCount: stored.stored, failureReason },
    now()
  );

  const dailyCap = stored.allowance;
  const degraded = stored.capped > 0
    ? [
        ...outcome.degraded,
        `${stored.capped} harvested ${stored.capped === 1 ? 'person was' : 'people were'} not stored: this workspace's daily cap of ${dailyCap.limit} leads was reached. The window is a rolling 24 hours.`
      ]
    : outcome.degraded;

  return {
    sourceId: source.id,
    status: outcome.ok ? 'completed' : 'failed',
    harvested: outcome.leads.length,
    stored: stored.stored,
    filtered: stored.filtered,
    capped: stored.capped,
    dailyCap,
    dailyCapReached: dailyCap.remaining <= 0,
    degraded,
    failureReason
  };
}

/**
 * Claim and run every pending source for one workspace.
 *
 * THE GATE IS READ ONCE, BEFORE THE FIRST CLAIM. On a hosted box or with the
 * opt-in off there is nothing to claim and nothing to mark failed: the sources
 * stay pending, so turning the switch on later runs them rather than making an
 * operator re-request work that was silently binned.
 */
export async function runPendingLeadSources(
  db: Db,
  workspaceId: string,
  deps: LeadSourceRunDeps,
  options: { maxSources?: number } = {}
): Promise<LeadSourceRunResult[]> {
  if (!leadSourcingEnabled(deps.config)) return [];
  const now = deps.now ?? (() => new Date());
  // Bounded for the same reason the worker's batch is: one pass must be finite,
  // and a queue of sources is a queue of full page walks.
  const maxSources = Math.max(1, Math.min(10, Math.trunc(options.maxSources ?? 3)));
  const results: LeadSourceRunResult[] = [];
  for (let index = 0; index < maxSources; index += 1) {
    const source = await claimLeadSource(db, workspaceId, now());
    if (!source) break;
    results.push(await runLeadSource(db, source, deps));
    const last = results[results.length - 1];
    // A wall stops the whole pass, not just this source. Walking the next
    // search after LinkedIn has just said stop is exactly the behaviour that
    // escalates a temporary restriction (plan 1.3).
    if (last.status === 'failed') break;
    // And so does a spent daily cap: the next source would load pages for
    // people this workspace is not allowed to keep today.
    if (last.dailyCapReached) break;
  }
  return results;
}

/** Why this seat may not be harvested for, or null when it may. */
function postureRefusal(posture: SeatPosture | null): string | null {
  if (posture === null) return 'No LinkedIn seat is configured for this workspace, so there is no account to source leads through.';
  if (posture === 'paused') return 'The seat is paused, so nothing may be fetched through it.';
  if (posture === 'cooldown') {
    return 'The seat is in cooldown after a limit wall or challenge; resume it by hand once you know why. Page fetches are actions too.';
  }
  return null;
}

/**
 * Write the harvested people, minus everyone we must not re-target.
 *
 * THE THREE REASONS A LEAD IS DROPPED ARE KEPT APART on purpose: "already in
 * your list", "you excluded them" and "you already contacted them" are three
 * different things for an operator looking at a harvest of 100 that stored 12,
 * and one merged "filtered: 88" would answer none of them.
 *
 * The insert is one statement over arrays rather than a hundred round trips,
 * and `ON CONFLICT DO NOTHING` on the (workspace, profile_url) index is what
 * makes re-running a source idempotent -- the same guarantee `recordAction`
 * gets from its own index, reported rather than thrown.
 *
 * AND THE DAILY CAP IS RESERVED HERE, UNDER A LOCK, RATHER THAN READ UPSTAIRS
 * AND TRUSTED. `runLeadSource` reads the allowance before it fetches, which is
 * right -- it is what stops the pages being loaded at all -- but a read is not
 * a reservation. Two passes that started a minute apart both saw the same
 * `remaining: 40`, both walked, and both stored 40 into a cap of 100. "At most
 * N leads a day" was true of each pass and false of the workspace, which is
 * the only place it was ever promised. So the window is counted again INSIDE
 * the transaction that writes, behind a workspace-scoped advisory lock, and
 * the slice is taken from that count. A concurrent pass now waits, re-counts,
 * and sees what the first one actually stored.
 *
 * lc-debt: one advisory lock per workspace serialises concurrent harvests of
 * that workspace end to end; fine at a cap of at most 1000 rows a day, and the
 * upgrade path if it ever matters is a reservations table the count comes from
 * instead of a COUNT(*) over the window.
 */
async function storeLeads(
  db: Db,
  source: LinkedInLeadSource,
  leads: readonly ScrapedLead[],
  now: Date
): Promise<{ stored: number; filtered: LeadSourceRunResult['filtered']; capped: number; allowance: DailyLeadAllowance }> {
  const filtered = { duplicate: 0, excluded: 0, contacted: 0 };

  const { excluded, contacted } = await suppressionSets(db, source.workspaceId);
  const keep: ScrapedLead[] = [];
  for (const lead of leads) {
    const key = lead.profileUrl.toLowerCase();
    if (excluded.has(key)) {
      filtered.excluded += 1;
      continue;
    }
    if (contacted.has(key)) {
      filtered.contacted += 1;
      continue;
    }
    keep.push(lead);
  }

  const iso = now.toISOString();
  const since = new Date(now.getTime() - DAILY_LEAD_WINDOW_MS);

  return db.transaction(async (tx) => {
    // ONE LOCK PER WORKSPACE, HELD TO COMMIT. `pg_advisory_xact_lock` is the
    // cheapest thing that makes count-then-insert one indivisible step, and it
    // releases itself on COMMIT or ROLLBACK -- there is no path out of this
    // transaction that leaks it. The class id namespaces it away from every
    // other advisory lock a Postgres box might be holding.
    await tx.prepare('SELECT pg_advisory_xact_lock(?::int, hashtext(?)::int)').get(LEAD_CAP_LOCK_CLASS, source.workspaceId);

    const limit = await getDailyLeadCap(tx, source.workspaceId);
    const used = await leadsStoredSince(tx, source.workspaceId, since);
    const remaining = Math.max(0, limit - used);

    // THE CAP IS APPLIED AFTER THE SUPPRESSION FILTER, so a day's allowance is
    // spent on people the operator can actually contact rather than on 40
    // already-excluded rows that were about to be dropped anyway.
    const allowed = keep.slice(0, remaining);
    const capped = keep.length - allowed.length;
    if (allowed.length === 0) return { stored: 0, filtered, capped, allowance: { limit, used, remaining } };

    // THE SCRUB RUNS HERE, ON EVERY PATH INTO THE TABLE -- AND IT NOW ACTUALLY
    // DOES. The sentence above this line was true of a name the driver handed
    // over as one string and false of one it handed over already split: the
    // pre-split branch copied `firstName`/`lastName` THROUGH, raw, so the only
    // writer that got scrubbed was the one that had already been scrubbed by
    // `makeLead`. Any other `ScrapedLead` writer -- an importer, a fixture, a
    // future surface -- stored "Dr. Maya" and "Chen \u{1F1FA}\u{1F1F8}" and the
    // UI rendered them verbatim. Dedicated halves go through `scrubNameField`,
    // which applies the same table and, unlike the joined splitter, may never
    // empty a name it was handed.
    const named = allowed.map((lead) => {
      const split = lead.firstName || lead.lastName
        ? { firstName: scrubNameField(lead.firstName ?? ''), lastName: scrubNameField(lead.lastName ?? '') }
        : splitAndScrubName(lead.name ?? '');
      const full = [split.firstName, split.lastName].filter(Boolean).join(' ');
      return { ...lead, ...split, fullName: full || null };
    });

    const result = await tx.prepare(`
      INSERT INTO linkedin_leads (
        id, workspace_id, source_id, profile_url, name, first_name, last_name,
        headline, company, post_url, interaction_kind, created_at
      )
      SELECT * FROM unnest(
        ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
        ?::text[], ?::text[], ?::text[], ?::text[], ?::timestamptz[]
      )
      ON CONFLICT (workspace_id, LOWER(profile_url)) DO NOTHING
    `).run(
      named.map(() => id('llead')),
      named.map(() => source.workspaceId),
      named.map(() => source.id),
      named.map((lead) => lead.profileUrl),
      named.map((lead) => lead.fullName),
      named.map((lead) => lead.firstName || null),
      named.map((lead) => lead.lastName || null),
      named.map((lead) => lead.headline),
      named.map((lead) => lead.company),
      named.map((lead) => lead.postUrl),
      named.map((lead) => interactionKindOf(lead.interactionKind)),
      named.map(() => iso)
    );

    // Everything the index swallowed was somebody this workspace already has.
    filtered.duplicate = allowed.length - result.changes;
    const spent = used + result.changes;
    return {
      stored: result.changes,
      filtered,
      capped,
      allowance: { limit, used: spent, remaining: Math.max(0, limit - spent) }
    };
  });
}
