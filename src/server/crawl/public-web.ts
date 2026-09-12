import { createSsrfFetch, validatePublicHost, type FetchLike } from '../skills/guard.js';
import { parseRobots, robotsAllows, type RobotsRules } from '../skills/html.js';
import { normalizeDomain } from '../skills/ladder.js';
import { probe, USER_AGENT, type Probe } from '../skills/probe.js';

/** Product token used when applying robots.txt rules. */
export const TREVRA_ROBOTS_AGENT = USER_AGENT.split('/', 1)[0];

export type CrawlSkipReason = 'budget-exhausted' | 'robots-disallowed' | 'cross-origin';

export interface CrawlFetchResult {
  url: string;
  response: Probe | null;
  skipped: CrawlSkipReason | null;
}

export interface PublicWebCrawlerOptions {
  fetchImpl?: FetchLike;
  /** Total outbound requests, including the single robots.txt read. */
  maxRequests?: number;
}

/**
 * Reusable, bounded crawl session for one public domain.
 *
 * This is the Trevra crawler boundary. Feature code decides WHAT to inspect
 * (storefront, hiring, pricing, newsletter discovery, site changes); this class
 * owns HOW requests leave the process: public-host validation, redirect SSRF
 * protection, robots policy and a hard per-session request ceiling.
 */
export class PublicWebCrawler {
  readonly domain: string;
  readonly origin: string;
  readonly maxRequests: number;

  private readonly client: FetchLike;
  private robotsRules: RobotsRules | null = null;
  private robotsLoaded = false;
  private _requestsUsed = 0;

  private constructor(domain: string, client: FetchLike, maxRequests: number) {
    this.domain = domain;
    this.origin = `https://${domain}`;
    this.client = client;
    this.maxRequests = maxRequests;
  }

  static async create(
    domain: string,
    options: PublicWebCrawlerOptions = {}
  ): Promise<PublicWebCrawler> {
    const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
    const resolve = options.fetchImpl === undefined;
    await validatePublicHost(clean, { resolve });
    const client = createSsrfFetch({ resolve, fetchImpl: options.fetchImpl });
    return new PublicWebCrawler(clean, client, Math.max(1, options.maxRequests ?? 10));
  }

  get requestsUsed(): number {
    return this._requestsUsed;
  }

  get requestsRemaining(): number {
    return Math.max(0, this.maxRequests - this._requestsUsed);
  }

  private async ensureRobots(): Promise<void> {
    if (this.robotsLoaded) return;
    this.robotsLoaded = true;
    if (this._requestsUsed >= this.maxRequests) {
      this.robotsRules = new Map();
      return;
    }
    this._requestsUsed += 1;
    const response = await probe(this.client, `${this.origin}/robots.txt`);
    // Keep Trevra's existing semantics: missing/unreachable robots means no
    // declared restriction. A readable 200 response is enforced.
    this.robotsRules = response?.status === 200 ? parseRobots(response.text) : new Map();
  }

  private resolveUrl(input: string): URL {
    return new URL(input, `${this.origin}/`);
  }

  async get(input: string): Promise<CrawlFetchResult> {
    const url = this.resolveUrl(input);
    if (url.origin !== this.origin) {
      return { url: url.toString(), response: null, skipped: 'cross-origin' };
    }

    await this.ensureRobots();
    const path = `${url.pathname}${url.search}`;
    if (!robotsAllows(this.robotsRules ?? new Map(), TREVRA_ROBOTS_AGENT, path)) {
      return { url: url.toString(), response: null, skipped: 'robots-disallowed' };
    }
    if (this._requestsUsed >= this.maxRequests) {
      return { url: url.toString(), response: null, skipped: 'budget-exhausted' };
    }

    this._requestsUsed += 1;
    return {
      url: url.toString(),
      response: await probe(this.client, url.toString()),
      skipped: null
    };
  }
}

export async function createPublicWebCrawler(
  domain: string,
  options: PublicWebCrawlerOptions = {}
): Promise<PublicWebCrawler> {
  return PublicWebCrawler.create(domain, options);
}
