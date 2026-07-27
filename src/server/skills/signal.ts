import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, type Db } from '../db.js';
import { detectTech } from './enrich.js';
import { createSsrfFetch, validatePublicHost, type FetchLike } from './guard.js';
import { extractJsonLd, extractLinks, firstHeading, isType, metaContent, pageTitle, sameOriginPath, stripTags } from './html.js';
import { normalizeDomain } from './ladder.js';
import { probe, type Probe } from './probe.js';
import type { Skill, SkillContext, SkillEvidence } from './types.js';

/**
 * Continuous research: capture a normalized snapshot, diff it against the last
 * one stored for this workspace+domain, and report what moved.
 *
 * The value is entirely in the DIFF. "They have 7 open roles" is a fact; "they
 * went from 3 open roles to 7 since March" is a reason to send an email today,
 * and it is checkable by the recipient, which is what `voice.ts` is measuring.
 *
 * Two decisions the whole module rests on:
 *
 * NULL MEANS NOT CAPTURED, and it is never diffed. A careers page that timed
 * out records `jobCount: null`, not `0`. Without that distinction the first
 * flaky fetch reports "hiring went from 7 to 0", which is a fabricated signal
 * that reads as urgent -- the worst possible failure for outreach.
 *
 * PRICING IS HASHED FROM VISIBLE TEXT, not markup. Build hashes, CDN
 * cache-busters, and CSRF tokens change the bytes of a pricing page on every
 * single fetch, so hashing the response would emit `pricing-changed` daily and
 * the signal would be worth nothing within a week.
 */

export const SIGNAL_WATCHES = ['hiring', 'pricing', 'headline', 'tech'] as const;
export type SignalWatch = (typeof SIGNAL_WATCHES)[number];

export const DEFAULT_PAGE_BUDGET = 8;

export type SignalKind =
  | 'first-capture'
  | 'hiring-up'
  | 'hiring-down'
  | 'pricing-changed'
  | 'headline-changed'
  | 'tech-added'
  | 'tech-removed';

/** Stable report order, so two runs over the same pair of snapshots are byte-identical. */
const SIGNAL_ORDER: readonly SignalKind[] = [
  'first-capture',
  'hiring-up',
  'hiring-down',
  'pricing-changed',
  'headline-changed',
  'tech-added',
  'tech-removed'
];

export interface ResearchSignal {
  kind: SignalKind;
  detail: string;
  previous: string | null;
  current: string | null;
}

export interface ResearchSnapshot {
  domain: string;
  capturedAt: string;
  headline: string | null;
  jobsUrl: string | null;
  /** `null` = not captured this run. `0` = captured, and there are no roles. */
  jobCount: number | null;
  jobTitles: string[];
  pricingUrl: string | null;
  pricingHash: string | null;
  /** `null` = not captured. `[]` = captured, and nothing matched. */
  tech: string[] | null;
}

const CAREERS_LINK_RE = /\b(careers?|jobs?|hiring|open roles?|join us|work with us)\b/i;
const PRICING_LINK_RE = /\b(pricing|plans?|packages?)\b/i;

const JOB_BOARD_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|jobvite\.com|myworkdayjobs\.com|personio\.de|personio\.com)$/i;
const JOB_PATH_RE = /\/(jobs?|careers?|positions?|openings?|vacancies)\/[^/]+/i;

/** Navigation and call-to-action text that points AT the list rather than at a role. */
const GENERIC_JOB_TEXT: ReadonlySet<string> = new Set([
  'career',
  'careers',
  'job',
  'jobs',
  'all jobs',
  'view all',
  'view job',
  'view all jobs',
  'see all jobs',
  'open positions',
  'open roles',
  'apply',
  'apply now',
  'join us',
  'learn more',
  'read more',
  'we are hiring',
  "we're hiring"
]);

/**
 * Job titles on a careers page: JSON-LD `JobPosting` first, then links that
 * point at a per-role URL or a known applicant-tracking host.
 *
 * Titles rather than a raw count, because the count alone cannot say WHICH
 * role opened, and "they are hiring a Head of RevOps" is the sentence that
 * earns a reply.
 */
export function extractJobPostings(html: string, pageUrl: string): string[] {
  const titles = new Set<string>();
  for (const object of extractJsonLd(html)) {
    if (!isType(object, 'JobPosting')) continue;
    const title = typeof object.title === 'string' ? object.title.replace(/\s+/g, ' ').trim() : '';
    if (title) titles.add(title);
  }
  for (const link of extractLinks(html)) {
    let url: URL;
    try {
      url = new URL(link.href, pageUrl);
    } catch {
      continue;
    }
    if (!JOB_BOARD_HOSTS.test(url.hostname) && !JOB_PATH_RE.test(url.pathname)) continue;
    const title = link.text.trim();
    if (title.length < 3 || title.length > 120) continue;
    if (GENERIC_JOB_TEXT.has(title.toLowerCase())) continue;
    titles.add(title);
  }
  return [...titles].sort();
}

export function contentHash(html: string): string {
  return createHash('sha256').update(stripTags(html)).digest('hex').slice(0, 16);
}

/** Links the site itself offers first, declared fallbacks after; at most three. */
function discoverPaths(html: string, base: URL, pattern: RegExp, fallbacks: readonly string[]): string[] {
  const paths: string[] = [];
  for (const link of extractLinks(html)) {
    if (!pattern.test(link.text)) continue;
    const path = sameOriginPath(base, link.href);
    if (path && path !== '/' && !paths.includes(path)) paths.push(path);
    if (paths.length >= 2) break;
  }
  for (const path of fallbacks) if (!paths.includes(path)) paths.push(path);
  return paths.slice(0, 3);
}

export interface CaptureOptions {
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
  watch?: readonly SignalWatch[];
  pageBudget?: number;
  now?: Date;
}

export async function captureSnapshot(domain: string, options: CaptureOptions = {}): Promise<ResearchSnapshot> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const resolve = options.fetchImpl === undefined;
  await validatePublicHost(clean, { resolve });
  const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
  const base = new URL(`https://${clean}`);
  const watches = new Set<SignalWatch>(options.watch ?? SIGNAL_WATCHES);

  let used = 0;
  const budget = Math.max(1, options.pageBudget ?? DEFAULT_PAGE_BUDGET);
  const get = async (url: string): Promise<Probe | null> => {
    if (used >= budget) return null;
    used += 1;
    return probe(client, url);
  };

  const home = await get(`${base.origin}/`);
  const html = home !== null && home.status < 400 ? home.text : '';

  const headline = watches.has('headline') && html ? firstHeading(html) ?? metaContent(html, 'property', 'og:title') ?? pageTitle(html) : null;
  const tech = watches.has('tech') && html ? detectTech(html, home?.headers ?? null).map((item) => item.key).sort() : null;

  let jobsUrl: string | null = null;
  let jobCount: number | null = null;
  let jobTitles: string[] = [];
  if (watches.has('hiring')) {
    for (const path of discoverPaths(html, base, CAREERS_LINK_RE, ['/careers', '/jobs'])) {
      const response = await get(`${base.origin}${path}`);
      if (response === null || response.status !== 200) continue;
      if (response.contentType && !response.contentType.includes('html')) continue;
      jobsUrl = `${base.origin}${path}`;
      jobTitles = extractJobPostings(response.text, jobsUrl);
      jobCount = jobTitles.length;
      break;
    }
  }

  let pricingUrl: string | null = null;
  let pricingHash: string | null = null;
  if (watches.has('pricing')) {
    for (const path of discoverPaths(html, base, PRICING_LINK_RE, ['/pricing', '/plans'])) {
      const response = await get(`${base.origin}${path}`);
      if (response === null || response.status !== 200) continue;
      if (response.contentType && !response.contentType.includes('html')) continue;
      pricingUrl = `${base.origin}${path}`;
      pricingHash = contentHash(response.text);
      break;
    }
  }

  return {
    domain: clean,
    capturedAt: (options.now ?? new Date()).toISOString(),
    headline,
    jobsUrl,
    jobCount,
    jobTitles,
    pricingUrl,
    pricingHash,
    tech
  };
}

function summarize(snapshot: ResearchSnapshot): string {
  const parts: string[] = [];
  if (snapshot.jobCount !== null) parts.push(`${snapshot.jobCount} open role(s)`);
  if (snapshot.headline) parts.push(`headline "${snapshot.headline}"`);
  if (snapshot.tech !== null && snapshot.tech.length > 0) parts.push(`tech ${snapshot.tech.join(', ')}`);
  if (snapshot.pricingHash) parts.push(`pricing hash ${snapshot.pricingHash}`);
  return parts.length > 0 ? parts.join('; ') : 'nothing readable';
}

/**
 * Diff two snapshots into typed signals. Pure, total, and order-stable.
 *
 * A field is compared only when BOTH snapshots captured it -- see the module
 * doc on why a null must never become a movement. Set membership drives the
 * tech signals so that reordering a detection table cannot manufacture one.
 */
export function diffSnapshots(previous: ResearchSnapshot | null, current: ResearchSnapshot): ResearchSignal[] {
  if (previous === null) {
    return [
      {
        kind: 'first-capture',
        detail: `First snapshot of ${current.domain}: ${summarize(current)}.`,
        previous: null,
        current: summarize(current)
      }
    ];
  }

  const signals: ResearchSignal[] = [];

  if (previous.jobCount !== null && current.jobCount !== null && previous.jobCount !== current.jobCount) {
    const up = current.jobCount > previous.jobCount;
    const changed = up
      ? current.jobTitles.filter((title) => !previous.jobTitles.includes(title))
      : previous.jobTitles.filter((title) => !current.jobTitles.includes(title));
    const named = changed.length > 0 ? ` (${up ? 'new' : 'gone'}: ${changed.slice(0, 3).join('; ')})` : '';
    signals.push({
      kind: up ? 'hiring-up' : 'hiring-down',
      detail: `Open roles on ${current.jobsUrl ?? current.domain} went from ${previous.jobCount} to ${current.jobCount}${named}.`,
      previous: String(previous.jobCount),
      current: String(current.jobCount)
    });
  }

  if (previous.pricingHash !== null && current.pricingHash !== null && previous.pricingHash !== current.pricingHash) {
    signals.push({
      kind: 'pricing-changed',
      detail: `Pricing page content changed on ${current.pricingUrl ?? current.domain} (${previous.pricingHash} -> ${current.pricingHash}).`,
      previous: previous.pricingHash,
      current: current.pricingHash
    });
  }

  if (previous.headline !== null && current.headline !== null && previous.headline !== current.headline) {
    signals.push({
      kind: 'headline-changed',
      detail: `Homepage headline on ${current.domain} changed from "${previous.headline}" to "${current.headline}".`,
      previous: previous.headline,
      current: current.headline
    });
  }

  if (previous.tech !== null && current.tech !== null) {
    const before = new Set(previous.tech);
    const after = new Set(current.tech);
    const added = current.tech.filter((key) => !before.has(key));
    const removed = previous.tech.filter((key) => !after.has(key));
    if (added.length > 0) {
      signals.push({
        kind: 'tech-added',
        detail: `${current.domain} added ${added.join(', ')} since the last check.`,
        previous: previous.tech.join(', ') || 'none',
        current: current.tech.join(', ') || 'none'
      });
    }
    if (removed.length > 0) {
      signals.push({
        kind: 'tech-removed',
        detail: `${current.domain} dropped ${removed.join(', ')} since the last check.`,
        previous: previous.tech.join(', ') || 'none',
        current: current.tech.join(', ') || 'none'
      });
    }
  }

  return signals.sort((a, b) => SIGNAL_ORDER.indexOf(a.kind) - SIGNAL_ORDER.indexOf(b.kind));
}

const snapshotSchema = z.object({
  domain: z.string(),
  capturedAt: z.string(),
  headline: z.string().nullable(),
  jobsUrl: z.string().nullable(),
  jobCount: z.number().nullable(),
  jobTitles: z.array(z.string()),
  pricingUrl: z.string().nullable(),
  pricingHash: z.string().nullable(),
  tech: z.array(z.string()).nullable()
});

/**
 * Newest stored snapshot for this workspace+domain, or `null`.
 *
 * A stored row that no longer matches the schema degrades to "no prior"
 * instead of throwing: a snapshot shape change would otherwise take every
 * watched domain's next run down with it, and `first-capture` is the correct
 * reading of "we have nothing comparable".
 */
export async function loadPreviousSnapshot(db: Db, workspaceId: string, domain: string): Promise<ResearchSnapshot | null> {
  const row = await db
    .prepare('SELECT snapshot_json FROM research_snapshots WHERE workspace_id=? AND domain=? ORDER BY captured_at DESC LIMIT 1')
    .get<{ snapshot_json: unknown }>(workspaceId, domain);
  if (!row) return null;
  let raw: unknown = row.snapshot_json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = snapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveSnapshot(db: Db, workspaceId: string, snapshot: ResearchSnapshot, now: Date): Promise<void> {
  await db
    .prepare(`
      INSERT INTO research_snapshots (id, workspace_id, domain, captured_at, snapshot_json, created_at)
      VALUES (?,?,?,?,?::jsonb,?)
    `)
    .run(id('snap'), workspaceId, snapshot.domain, snapshot.capturedAt, JSON.stringify(snapshot), now.toISOString());
}

export interface WatchResult {
  domain: string;
  snapshot: ResearchSnapshot;
  previousCapturedAt: string | null;
  signals: ResearchSignal[];
  generatedAt: string;
  evidence: SkillEvidence[];
}

/**
 * Load, capture, diff, persist -- split out of the skill the way `audit.ts`
 * splits `runVisibilityAudit`, so the orchestration is reachable with an
 * injected fetch instead of only through the registry.
 */
export async function watchSignals(domain: string, ctx: SkillContext, options: CaptureOptions = {}): Promise<WatchResult> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const previous = await loadPreviousSnapshot(ctx.db, ctx.workspaceId, clean);
  const snapshot = await captureSnapshot(domain, { ...options, now: options.now ?? ctx.now() });
  const signals = diffSnapshots(previous, snapshot);
  // Persisted whatever the diff said: a run that emitted nothing is still the
  // baseline the next run compares against.
  await saveSnapshot(ctx.db, ctx.workspaceId, snapshot, ctx.now());
  return {
    domain: clean,
    snapshot,
    previousCapturedAt: previous?.capturedAt ?? null,
    signals,
    generatedAt: ctx.now().toISOString(),
    evidence: signals.map((signal) => ({
      label: signal.kind,
      detail: signal.detail,
      sourceUrl: signal.kind.startsWith('hiring')
        ? snapshot.jobsUrl
        : signal.kind === 'pricing-changed'
          ? snapshot.pricingUrl
          : `https://${clean}`
    }))
  };
}

const inputSchema = z.object({
  domain: z.string().min(1),
  watch: z.array(z.enum(SIGNAL_WATCHES)).min(1).optional(),
  pageBudget: z.number().int().positive().max(25).optional()
});

const outputSchema = z.object({
  domain: z.string(),
  snapshot: snapshotSchema,
  previousCapturedAt: z.string().nullable(),
  signals: z.array(
    z.object({
      kind: z.enum(['first-capture', 'hiring-up', 'hiring-down', 'pricing-changed', 'headline-changed', 'tech-added', 'tech-removed']),
      detail: z.string(),
      previous: z.string().nullable(),
      current: z.string().nullable()
    })
  ),
  generatedAt: z.string(),
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type WatchInput = z.infer<typeof inputSchema>;

export const watchSignalSkill: Skill<WatchInput, WatchResult> = {
  manifest: {
    id: 'gtm.watch-signal',
    name: 'Watch a domain for change signals',
    version: '1.0.0',
    description:
      'Capture hiring, pricing, headline, and tech snapshots for a domain and diff them against the previous capture into typed change signals.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    return watchSignals(input.domain, ctx, { watch: input.watch, pageBudget: input.pageBudget });
  }
};
