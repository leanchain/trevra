import { createSsrfFetch, type FetchLike } from '../../skills/guard.js';
import { TIMEOUT_MS, USER_AGENT } from '../../skills/probe.js';

/**
 * The one outbound call every scout makes.
 *
 * Not a new HTTP layer: this is `skills/probe.ts`'s degrade contract with a
 * JSON parse and per-request headers bolted on, because scouts authenticate
 * (bearer tokens, API keys) and `probe()` deliberately sends a fixed header
 * set. Everything that matters -- the SSRF guard, the redirect re-validation,
 * the shared timeout and User-Agent -- is reused rather than reimplemented.
 *
 * Degrade contract, identical to `probe()`: a transport error, a timeout, a
 * non-200, or unparseable JSON all come back as `null` with a warning pushed.
 * One rate-limited platform must never fail a run that seven others answered.
 */

export interface JsonFetchOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  /** Statuses treated as success. Defaults to 200; creates answer 201. */
  okStatuses?: readonly number[];
}

/** Build the guarded client a scout should use for every call in one run. */
export function scoutClient(fetchImpl?: FetchLike): FetchLike {
  return createSsrfFetch({ resolve: fetchImpl === undefined, fetchImpl });
}

export async function getJson<T = unknown>(
  client: FetchLike,
  url: string,
  warnings: string[],
  options: JsonFetchOptions = {}
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await client(url, {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal
    });
    const ok = options.okStatuses ?? [200];
    if (!ok.includes(response.status)) {
      const detail = await response.text().catch(() => '');
      warnings.push(`${safeHost(url)} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`);
      return null;
    }
    return (await response.json()) as T;
  } catch (cause) {
    warnings.push(`${safeHost(url)} request failed: ${cause instanceof Error ? cause.message : String(cause)}.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Collapse whitespace and drop empty lines. The port of `BaseScout.filter_content`. */
export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** True when every whitespace-separated term of `query` appears in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .every((term) => haystack.includes(term));
}

/** Merge per-query results, keeping the first sighting of each external id. */
export function dedupeById<T extends { externalId: string }>(batches: readonly T[][], limit: number): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      merged.push(item);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}
