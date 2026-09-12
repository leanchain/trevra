import { SsrfError, createSsrfFetch, validatePublicHost, type FetchLike } from '../skills/guard.js';
import { parseRobots, robotsAllows, type RobotsRules } from '../skills/html.js';
import { normalizeDomain } from '../skills/ladder.js';
import type { Probe } from '../skills/probe.js';

/** Stable public crawler identity; deliberately distinct from one-off audit probes. */
export const TREVRA_CRAWLER_USER_AGENT = 'TrevraCrawler/1.0';
/** Product token used when applying robots.txt rules. */
export const TREVRA_ROBOTS_AGENT = 'TrevraCrawler';

export const DEFAULT_CRAWL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CRAWL_MAX_ROBOTS_BYTES = 512 * 1024;
export const DEFAULT_CRAWL_TIMEOUT_MS = 10_000;
export const DEFAULT_CRAWL_MAX_DURATION_MS = 20_000;
export const DEFAULT_CRAWL_MIN_DELAY_MS = 250;
export const DEFAULT_CRAWL_MAX_RETRIES = 2;

const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1_000;
const ROBOTS_CACHE_MAX = 1_024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type CrawlSkipReason =
  | 'budget-exhausted'
  | 'deadline-exhausted'
  | 'robots-disallowed'
  | 'robots-unavailable'
  | 'cross-origin';

export interface CrawlFetchResult {
  url: string;
  finalUrl: string;
  response: Probe | null;
  skipped: CrawlSkipReason | null;
  error: string | null;
  attempts: number;
  durationMs: number;
  bodyBytes: number;
}

export interface CrawlTelemetry {
  domain: string;
  requestsUsed: number;
  requestsRemaining: number;
  bytesRead: number;
  retries: number;
  crawlDelayMs: number;
  robots: 'not-loaded' | 'rules' | 'missing' | 'unavailable';
  elapsedMs: number;
}

export interface PublicWebCrawlerOptions {
  fetchImpl?: FetchLike;
  /** Total real outbound requests, including robots, retries and redirect hops. */
  maxRequests?: number;
  /** Decoded response-body ceiling. Exceeding it is a failed read, never truncation. */
  maxResponseBytes?: number;
  maxRobotsBytes?: number;
  timeoutMs?: number;
  maxDurationMs?: number;
  maxRetries?: number;
  /** Courtesy delay even when robots.txt declares no Crawl-delay. */
  minDelayMs?: number;
  /** Fail closed on an operational robots.txt failure. Defaults to true for scheduled crawling. */
  strictRobots?: boolean;
  /** Production caches robots for an hour. Injected fetches default to no cache for deterministic tests. */
  robotsCacheTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

interface RobotsCacheEntry {
  expiresAt: number;
  state: 'rules' | 'missing';
  rules: RobotsRules;
  crawlDelayMs: number;
}

const robotsCache = new Map<string, RobotsCacheEntry>();

class CrawlBudgetExceeded extends Error {}
class CrawlDeadlineExceeded extends Error {}
class ResponseTooLarge extends Error {}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowedHostnames(domain: string): Set<string> {
  const clean = domain.toLowerCase();
  const hosts = new Set([clean]);
  if (clean.startsWith('www.')) hosts.add(clean.slice(4));
  else hosts.add(`www.${clean}`);
  return hosts;
}

function retryAfterMs(value: string | null, attempt: number, nowMs: number): number {
  if (value) {
    const raw = value.trim();
    if (/^\d+$/.test(raw)) return Math.min(Number(raw) * 1_000, 60_000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at) && at > nowMs) return Math.min(at - nowMs, 60_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

function charset(contentType: string): string {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  return match?.[1]?.trim() || 'utf-8';
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charset(contentType)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readBodyCapped(
  response: Response,
  maxBytes: number
): Promise<{ text: string; bytes: number }> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new ResponseTooLarge(`Content-Length exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return { text: '', bytes: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLarge(`response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decodeBody(bytes, response.headers.get('content-type') ?? ''), bytes: total };
}

/** RFC-style group parsing for Crawl-delay; exact crawler group wins over `*`. */
export function parseCrawlDelayMs(text: string, agent: string = TREVRA_ROBOTS_AGENT): number {
  let currentAgents: string[] = [];
  let sawDirective = false;
  let exact: number | null = null;
  let wildcard: number | null = null;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line || !line.includes(':')) continue;
    const separator = line.indexOf(':');
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (sawDirective) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      sawDirective = false;
      continue;
    }
    if (currentAgents.length === 0) continue;
    sawDirective = true;
    if (key !== 'crawl-delay') continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const ms = Math.round(seconds * 1_000);
    if (currentAgents.includes(agent.toLowerCase())) exact = ms;
    else if (currentAgents.includes('*')) wildcard = ms;
  }
  return exact ?? wildcard ?? 0;
}

function trimRobotsCache(now: number): void {
  for (const [key, value] of robotsCache) if (value.expiresAt <= now) robotsCache.delete(key);
  if (robotsCache.size < ROBOTS_CACHE_MAX) return;
  const oldest = [...robotsCache.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, robotsCache.size - ROBOTS_CACHE_MAX + 1);
  for (const [key] of oldest) robotsCache.delete(key);
}

/** Test seam only. Production relies on TTL eviction. */
export function resetPublicWebCrawlerCaches(): void {
  robotsCache.clear();
}

/**
 * Reusable, bounded crawl session for one public domain.
 *
 * Feature code decides WHAT to inspect. This class owns HOW network requests
 * leave the process: SSRF-safe redirects, same-site scope, robots policy,
 * request/deadline budgets, crawl-delay pacing, retries and bounded bodies.
 */
export class PublicWebCrawler {
  readonly domain: string;
  readonly maxRequests: number;

  private _origin: string;
  private readonly client: FetchLike;
  private readonly allowedHosts: Set<string>;
  private readonly maxResponseBytes: number;
  private readonly maxRobotsBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minDelayMs: number;
  private readonly strictRobots: boolean;
  private readonly robotsCacheTtlMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly startedAt: number;
  private readonly deadlineAt: number;

  private robotsRules: RobotsRules = new Map();
  private robotsLoaded = false;
  private robotsState: CrawlTelemetry['robots'] = 'not-loaded';
  private crawlDelayMs = 0;
  private _requestsUsed = 0;
  private _bytesRead = 0;
  private _retries = 0;
  private lastRequestAt: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    domain: string,
    options: PublicWebCrawlerOptions,
    clientFactory: (
      beforeRequest: (url: URL) => Promise<void>,
      allowRedirect: (from: URL, to: URL) => boolean
    ) => FetchLike
  ) {
    this.domain = domain;
    this._origin = `https://${domain}`;
    this.allowedHosts = allowedHostnames(domain);
    this.maxRequests = Math.max(1, Math.trunc(options.maxRequests ?? 10));
    this.maxResponseBytes = Math.max(
      1_024,
      Math.trunc(options.maxResponseBytes ?? DEFAULT_CRAWL_MAX_RESPONSE_BYTES)
    );
    this.maxRobotsBytes = Math.max(
      1_024,
      Math.trunc(options.maxRobotsBytes ?? DEFAULT_CRAWL_MAX_ROBOTS_BYTES)
    );
    this.timeoutMs = Math.max(250, Math.trunc(options.timeoutMs ?? DEFAULT_CRAWL_TIMEOUT_MS));
    this.maxRetries = Math.max(
      0,
      Math.min(5, Math.trunc(options.maxRetries ?? DEFAULT_CRAWL_MAX_RETRIES))
    );
    this.minDelayMs = Math.max(
      0,
      Math.trunc(options.minDelayMs ?? (options.fetchImpl ? 0 : DEFAULT_CRAWL_MIN_DELAY_MS))
    );
    this.strictRobots = options.strictRobots ?? true;
    this.robotsCacheTtlMs = Math.max(
      0,
      Math.trunc(options.robotsCacheTtlMs ?? (options.fetchImpl ? 0 : ROBOTS_CACHE_TTL_MS))
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.startedAt = this.nowMs();
    this.deadlineAt =
      this.startedAt +
      Math.max(1_000, Math.trunc(options.maxDurationMs ?? DEFAULT_CRAWL_MAX_DURATION_MS));
    this.client = clientFactory(
      (url) => this.beforeRequest(url),
      (from, to) => this.allowRedirect(from, to)
    );
  }

  static async create(
    domain: string,
    options: PublicWebCrawlerOptions = {}
  ): Promise<PublicWebCrawler> {
    const clean = normalizeDomain(domain) || domain.trim().toLowerCase();
    const resolve = options.fetchImpl === undefined;
    await validatePublicHost(clean, { resolve });
    return new PublicWebCrawler(clean, options, (beforeRequest, allowRedirect) =>
      createSsrfFetch({
        resolve,
        fetchImpl: options.fetchImpl,
        maxRedirects: 5,
        beforeRequest,
        allowRedirect
      })
    );
  }

  get origin(): string {
    return this._origin;
  }

  get requestsUsed(): number {
    return this._requestsUsed;
  }

  get requestsRemaining(): number {
    return Math.max(0, this.maxRequests - this._requestsUsed);
  }

  telemetry(): CrawlTelemetry {
    return {
      domain: this.domain,
      requestsUsed: this._requestsUsed,
      requestsRemaining: this.requestsRemaining,
      bytesRead: this._bytesRead,
      retries: this._retries,
      crawlDelayMs: this.crawlDelayMs,
      robots: this.robotsState,
      elapsedMs: Math.max(0, this.nowMs() - this.startedAt)
    };
  }

  private allowRedirect(_from: URL, to: URL): boolean {
    return to.protocol === 'https:' && !to.port && this.allowedHosts.has(to.hostname.toLowerCase());
  }

  private async waitWithinDeadline(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.nowMs() + ms > this.deadlineAt)
      throw new CrawlDeadlineExceeded('crawl deadline would be exceeded while pacing');
    await this.sleep(ms);
  }

  private async beforeRequest(_url: URL): Promise<void> {
    if (this._requestsUsed >= this.maxRequests)
      throw new CrawlBudgetExceeded('crawl request budget exhausted');
    const now = this.nowMs();
    if (now >= this.deadlineAt) throw new CrawlDeadlineExceeded('crawl deadline exhausted');
    const delay = Math.max(this.minDelayMs, this.crawlDelayMs);
    if (this.lastRequestAt !== null)
      await this.waitWithinDeadline(this.lastRequestAt + delay - now);
    if (this.nowMs() >= this.deadlineAt)
      throw new CrawlDeadlineExceeded('crawl deadline exhausted');
    this._requestsUsed += 1;
    this.lastRequestAt = this.nowMs();
  }

  private resolveUrl(input: string): URL {
    return new URL(input, `${this._origin}/`);
  }

  private inScope(url: URL): boolean {
    return (
      url.protocol === 'https:' && !url.port && this.allowedHosts.has(url.hostname.toLowerCase())
    );
  }

  private adoptCanonicalOrigin(finalUrl: string): void {
    try {
      const parsed = new URL(finalUrl);
      if (this.inScope(parsed)) this._origin = parsed.origin;
    } catch {
      // A mocked Response commonly has an empty `.url`; keep the known origin.
    }
  }

  private emptyResult(
    url: string,
    skipped: CrawlSkipReason | null,
    error: string | null,
    attempts = 0,
    durationMs = 0
  ): CrawlFetchResult {
    return {
      url,
      finalUrl: url,
      response: null,
      skipped,
      error,
      attempts,
      durationMs,
      bodyBytes: 0
    };
  }

  private async fetchDirect(url: string, maxBytes: number): Promise<CrawlFetchResult> {
    const started = this.nowMs();
    let attempts = 0;
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      attempts += 1;
      const remaining = this.deadlineAt - this.nowMs();
      if (remaining <= 0)
        return this.emptyResult(
          url,
          'deadline-exhausted',
          'crawl deadline exhausted',
          attempts - 1,
          this.nowMs() - started
        );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remaining));
      try {
        const response = await this.client(url, {
          headers: {
            'User-Agent': TREVRA_CRAWLER_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
            'Accept-Language': 'en-US,en;q=0.8'
          },
          signal: controller.signal
        });
        const finalUrl = response.url || url;
        this.adoptCanonicalOrigin(finalUrl);

        if (RETRYABLE_STATUS.has(response.status)) {
          if (attempt < this.maxRetries && this.requestsRemaining > 0) {
            if (response.body) await response.body.cancel().catch(() => undefined);
            this._retries += 1;
            await this.waitWithinDeadline(
              retryAfterMs(response.headers.get('retry-after'), attempt, this.nowMs())
            );
            continue;
          }
          if (response.body) await response.body.cancel().catch(() => undefined);
          return {
            url,
            finalUrl,
            response: {
              status: response.status,
              contentType: response.headers.get('content-type') ?? '',
              text: '',
              headers: response.headers
            },
            skipped: null,
            error: `HTTP ${response.status} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
            attempts,
            durationMs: this.nowMs() - started,
            bodyBytes: 0
          };
        }

        try {
          const body = await readBodyCapped(response, maxBytes);
          this._bytesRead += body.bytes;
          return {
            url,
            finalUrl,
            response: {
              status: response.status,
              contentType: response.headers.get('content-type') ?? '',
              text: body.text,
              headers: response.headers
            },
            skipped: null,
            error: null,
            attempts,
            durationMs: this.nowMs() - started,
            bodyBytes: body.bytes
          };
        } catch (cause) {
          if (cause instanceof ResponseTooLarge) {
            return this.emptyResult(url, null, cause.message, attempts, this.nowMs() - started);
          }
          throw cause;
        }
      } catch (cause) {
        if (cause instanceof CrawlBudgetExceeded)
          return this.emptyResult(
            url,
            'budget-exhausted',
            cause.message,
            attempts - 1,
            this.nowMs() - started
          );
        if (cause instanceof CrawlDeadlineExceeded)
          return this.emptyResult(
            url,
            'deadline-exhausted',
            cause.message,
            attempts - 1,
            this.nowMs() - started
          );
        lastError = cause instanceof Error ? cause.message : String(cause);
        if (cause instanceof SsrfError) {
          return this.emptyResult(url, null, lastError, attempts, this.nowMs() - started);
        }
        if (attempt < this.maxRetries && this.requestsRemaining > 0) {
          this._retries += 1;
          try {
            await this.waitWithinDeadline(retryAfterMs(null, attempt, this.nowMs()));
          } catch (waitError) {
            if (waitError instanceof CrawlDeadlineExceeded)
              return this.emptyResult(
                url,
                'deadline-exhausted',
                waitError.message,
                attempts,
                this.nowMs() - started
              );
            throw waitError;
          }
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
      break;
    }
    return this.emptyResult(
      url,
      null,
      lastError ?? 'request failed',
      attempts,
      this.nowMs() - started
    );
  }

  private async ensureRobots(): Promise<void> {
    if (this.robotsLoaded) return;
    this.robotsLoaded = true;

    const now = this.nowMs();
    if (this.robotsCacheTtlMs > 0) {
      trimRobotsCache(now);
      const cached = robotsCache.get(this.domain);
      if (cached && cached.expiresAt > now) {
        this.robotsRules = cached.rules;
        this.crawlDelayMs = cached.crawlDelayMs;
        this.robotsState = cached.state;
        return;
      }
    }

    const result = await this.fetchDirect(`${this._origin}/robots.txt`, this.maxRobotsBytes);
    const response = result.response;
    if (response?.status === 200) {
      this.robotsRules = parseRobots(response.text);
      this.crawlDelayMs = parseCrawlDelayMs(response.text);
      this.robotsState = 'rules';
    } else if (response && (response.status === 404 || response.status === 410)) {
      // Missing/gone robots.txt is a clear absence of policy. Other 4xx statuses
      // (notably 401/403/429) are treated as operational denial and fail closed
      // in scheduled crawling rather than guessed into permission.
      this.robotsRules = new Map();
      this.crawlDelayMs = 0;
      this.robotsState = 'missing';
    } else if (!this.strictRobots) {
      this.robotsRules = new Map();
      this.crawlDelayMs = 0;
      this.robotsState = 'missing';
    } else {
      this.robotsRules = new Map();
      this.crawlDelayMs = 0;
      this.robotsState = 'unavailable';
      return;
    }

    if (this.robotsCacheTtlMs > 0) {
      robotsCache.set(this.domain, {
        expiresAt: now + this.robotsCacheTtlMs,
        state: this.robotsState,
        rules: this.robotsRules,
        crawlDelayMs: this.crawlDelayMs
      });
    }
  }

  private async getUnlocked(input: string): Promise<CrawlFetchResult> {
    const url = this.resolveUrl(input);
    if (!this.inScope(url))
      return this.emptyResult(url.toString(), 'cross-origin', 'URL is outside crawler host scope');

    await this.ensureRobots();
    if (this.robotsState === 'unavailable')
      return this.emptyResult(
        url.toString(),
        'robots-unavailable',
        'robots.txt could not be evaluated safely'
      );

    const path = `${url.pathname}${url.search}`;
    if (!robotsAllows(this.robotsRules, TREVRA_ROBOTS_AGENT, path))
      return this.emptyResult(
        url.toString(),
        'robots-disallowed',
        'robots.txt disallows this path'
      );

    return this.fetchDirect(url.toString(), this.maxResponseBytes);
  }

  /**
   * Queue feature reads through one session so budget/pacing/robots state stay
   * race-free even if future observers ask for pages concurrently.
   */
  async get(input: string): Promise<CrawlFetchResult> {
    const run = this.queue.then(() => this.getUnlocked(input));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export async function createPublicWebCrawler(
  domain: string,
  options: PublicWebCrawlerOptions = {}
): Promise<PublicWebCrawler> {
  return PublicWebCrawler.create(domain, options);
}
