import { z } from 'zod';
import { createSsrfFetch, validatePublicHost, type FetchLike } from './guard.js';
import { extractLinks, extractMailtos, parseRobots, robotsAllows, sameOriginPath, socialProfile, type RobotsRules } from './html.js';
import { normalizeDomain } from './ladder.js';
import { probe, USER_AGENT } from './probe.js';
import type { Skill, SkillEvidence } from './types.js';

/**
 * Contacts a company PUBLISHED, from a bounded crawl of its own site.
 *
 * The free path, and only the free path: `mailto:` anchors and social profile
 * links on a short list of pages a company puts its contact details on. No
 * vendor, no credential, no email-pattern database.
 *
 * Four hard rules, each of which exists because breaking it produces a
 * plausible-looking address that nobody can be reached at -- or a crawl the
 * site owner did not consent to:
 *
 * 1. BOUNDED. A fixed page budget per domain. Contact details live on the
 *    linked-from-the-footer pages or nowhere; an unbounded crawl trades a
 *    site's bandwidth for results it will not find.
 * 2. SAME-ORIGIN. Off-origin links are read for handles and never followed.
 *    A "contact" link pointing at a partner site would otherwise make this
 *    skill crawl third parties on the target's behalf.
 * 3. SOURCED. Every contact carries the exact URL it was read from. An address
 *    without a source cannot be checked, and an unverifiable address is how
 *    outreach ends up at a role account that was retired years ago.
 * 4. NEVER GUESS SILENTLY. Pattern addresses (`hello@`, `info@`) are OFF unless
 *    the caller asks, and come back as `confidence: 'guessed'` with a null
 *    source. A guess presented as a finding is the single most damaging thing
 *    this module could ship: it puts a fabricated fact into an email.
 *
 * robots.txt is honoured per path using the audit's parser -- one parser, one
 * reading, so the crawl obeys the same rules the audit reports on.
 */

/** Explicit, in fetch order. Discovered links extend this; they never replace it. */
export const CONTACT_PATHS: readonly string[] = ['/', '/contact', '/contact-us', '/about', '/team', '/imprint', '/legal-notice'];

/** Link text that means "this way to the humans", English and German. */
export const CONTACT_LINK_WORDS: readonly string[] = [
  'contact',
  'kontakt',
  'about',
  'team',
  'imprint',
  'impressum',
  'legal notice',
  'legal',
  'press',
  'support',
  'get in touch'
];

export const DEFAULT_PAGE_BUDGET = 8;

/** Role accounts common enough to be worth offering -- still only when asked. */
export const GUESS_LOCAL_PARTS: readonly string[] = ['hello', 'info', 'contact'];

/**
 * robots.txt groups are keyed by product token, not by the full User-Agent
 * string, so `TrevraGrowthBot/0.1` must be looked up as `TrevraGrowthBot` or a
 * site that named us explicitly would silently fall through to `*`.
 */
export const ROBOTS_AGENT = USER_AGENT.split('/', 1)[0];

export interface Contact {
  kind: 'email' | 'social';
  value: string;
  platform: string | null;
  url: string | null;
  /** Exact page the contact was read from; `null` only for a requested guess. */
  source: string | null;
  confidence: 'published' | 'guessed';
}

export interface SkippedPage {
  url: string;
  reason: string;
}

export interface ContactResult {
  domain: string;
  contacts: Contact[];
  pagesFetched: string[];
  pagesSkipped: SkippedPage[];
  robotsFound: boolean;
  generatedAt: string;
  evidence: SkillEvidence[];
}

export interface FindContactOptions {
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
  pageBudget?: number;
  /** Off by default. See rule 4 in the module doc. */
  includeGuesses?: boolean;
}

function looksContactish(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTACT_LINK_WORDS.some((word) => lower.includes(word));
}

export async function findContacts(domain: string, options: FindContactOptions = {}): Promise<ContactResult> {
  const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
  const resolve = options.fetchImpl === undefined;
  await validatePublicHost(clean, { resolve });
  const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
  const base = new URL(`https://${clean}`);
  const budget = Math.max(1, options.pageBudget ?? DEFAULT_PAGE_BUDGET);

  const robotsResponse = await probe(client, `${base.origin}/robots.txt`);
  const robotsFound = robotsResponse !== null && robotsResponse.status === 200;
  // An unreachable or missing robots.txt reads as "no restriction", the same
  // answer `audit.ts` gives -- inventing a block would make the two disagree.
  const rules: RobotsRules = robotsFound ? parseRobots(robotsResponse.text) : new Map();

  const queue: string[] = [...CONTACT_PATHS];
  const queued = new Set<string>(queue);
  const pagesFetched: string[] = [];
  const pagesSkipped: SkippedPage[] = [];
  const contacts = new Map<string, Contact>();
  const evidence: SkillEvidence[] = [];

  const remember = (contact: Contact): void => {
    const key = `${contact.kind}:${contact.value}`;
    if (!contacts.has(key)) contacts.set(key, contact);
  };

  // The budget counts REQUESTS, not successful reads. What a site experiences
  // is requests, so bounding the answers would let a domain where every
  // candidate path 404s still absorb the full page list.
  let requests = 0;
  while (queue.length > 0 && requests < budget) {
    const path = queue.shift() as string;
    const url = `${base.origin}${path}`;

    if (!robotsAllows(rules, ROBOTS_AGENT, path)) {
      pagesSkipped.push({ url, reason: 'robots.txt disallows this path' });
      continue;
    }

    requests += 1;
    const response = await probe(client, url);
    if (response === null) {
      pagesSkipped.push({ url, reason: 'unreachable' });
      continue;
    }
    if (response.status !== 200) {
      pagesSkipped.push({ url, reason: `HTTP ${response.status}` });
      continue;
    }
    if (response.contentType && !response.contentType.includes('html')) {
      pagesSkipped.push({ url, reason: `content-type ${response.contentType}` });
      continue;
    }
    pagesFetched.push(url);

    for (const address of extractMailtos(response.text)) {
      remember({ kind: 'email', value: address, platform: null, url: null, source: url, confidence: 'published' });
    }

    for (const link of extractLinks(response.text)) {
      const profile = socialProfile(link.href, url);
      if (profile) {
        remember({
          kind: 'social',
          value: profile.handle,
          platform: profile.platform,
          url: profile.url,
          source: url,
          confidence: 'published'
        });
        continue;
      }
      // Discovery is capped at the page budget: a queue longer than the number
      // of pages we may fetch is wasted work that still costs the site nothing
      // only because we never get to it.
      if (queued.size >= budget * 2 || !looksContactish(link.text)) continue;
      const next = sameOriginPath(base, link.href, url);
      if (next === null || queued.has(next)) continue;
      queued.add(next);
      queue.push(next);
    }
  }

  for (const path of queue) {
    pagesSkipped.push({ url: `${base.origin}${path}`, reason: 'page budget exhausted' });
  }

  const published = [...contacts.values()];
  const publishedEmails = published.filter((contact) => contact.kind === 'email');

  if (options.includeGuesses) {
    const taken = new Set(publishedEmails.map((contact) => contact.value));
    for (const localPart of GUESS_LOCAL_PARTS) {
      const address = `${localPart}@${clean}`;
      if (taken.has(address)) continue;
      remember({ kind: 'email', value: address, platform: null, url: null, source: null, confidence: 'guessed' });
    }
    evidence.push({
      label: 'Pattern guesses',
      detail: `${GUESS_LOCAL_PARTS.length} pattern address(es) generated on request; none were published on ${clean} and none have been verified.`,
      sourceUrl: null
    });
  }

  for (const contact of publishedEmails) {
    evidence.push({ label: 'Published email', detail: `${contact.value} is published on ${contact.source}.`, sourceUrl: contact.source });
  }
  for (const contact of published.filter((item) => item.kind === 'social')) {
    evidence.push({
      label: 'Social profile',
      detail: `${contact.platform}: ${contact.value} (${contact.url}), linked from ${contact.source}.`,
      sourceUrl: contact.source
    });
  }
  const blocked = pagesSkipped.filter((page) => page.reason.startsWith('robots.txt')).length;
  evidence.push({
    label: 'Crawl budget',
    detail: `Read ${pagesFetched.length} of a maximum ${budget} page(s) on ${clean}; ${pagesSkipped.length} skipped${blocked > 0 ? `, ${blocked} by robots.txt` : ''}.`,
    sourceUrl: base.origin
  });

  // Published before guessed, then a stable order inside each group.
  const ordered = [...contacts.values()].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'published' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'email' ? -1 : 1;
    return `${a.platform ?? ''}${a.value}`.localeCompare(`${b.platform ?? ''}${b.value}`);
  });

  return {
    domain: clean,
    contacts: ordered,
    pagesFetched,
    pagesSkipped,
    robotsFound,
    generatedAt: new Date().toISOString(),
    evidence
  };
}

const inputSchema = z.object({
  domain: z.string().min(1),
  pageBudget: z.number().int().positive().max(25).optional(),
  /** Opt-in only, and the output still labels every result `guessed`. */
  includeGuesses: z.boolean().optional()
});

const outputSchema = z.object({
  domain: z.string(),
  contacts: z.array(
    z.object({
      kind: z.enum(['email', 'social']),
      value: z.string(),
      platform: z.string().nullable(),
      url: z.string().nullable(),
      source: z.string().nullable(),
      confidence: z.enum(['published', 'guessed'])
    })
  ),
  pagesFetched: z.array(z.string()),
  pagesSkipped: z.array(z.object({ url: z.string(), reason: z.string() })),
  robotsFound: z.boolean(),
  generatedAt: z.string(),
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type FindContactInput = z.infer<typeof inputSchema>;

export const findContactSkill: Skill<FindContactInput, ContactResult> = {
  manifest: {
    id: 'gtm.find-contact',
    name: 'Find published contacts',
    version: '1.0.0',
    description:
      'Crawl a bounded, robots-respecting set of a domain\'s own pages for published mailto: addresses and social profiles. Every result carries its source URL.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return findContacts(input.domain, {
      pageBudget: input.pageBudget,
      includeGuesses: input.includeGuesses ?? false
    });
  }
};
