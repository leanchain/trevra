import type { FetchLike } from './guard.js';

/**
 * The one outbound GET every probe skill uses.
 *
 * Extracted from `audit.ts` so the research skills inherit its degrade
 * contract rather than each inventing one: a transport error, a timeout, or
 * the SSRF guard refusing a redirect all come back as `null`, and the caller
 * decides what a missing answer means for that check. A skill that let those
 * throw would turn one slow host into a failed run instead of a partial report.
 *
 * `headers` is carried alongside the body because platform fingerprinting
 * reads `x-shopid` and `x-powered-by`, which never appear in the markup.
 */

export const USER_AGENT = 'TrevraGrowthBot/0.1';
export const TIMEOUT_MS = 8_000;

export interface Probe {
  status: number;
  contentType: string;
  text: string;
  headers: Headers;
}

/** GET `url`, returning the probe, or `null` on any transport error. */
export async function probe(client: FetchLike, url: string, timeoutMs: number = TIMEOUT_MS): Promise<Probe | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: await response.text(),
      headers: response.headers
    };
  } catch {
    // Transport error, timeout, or the SSRF guard blocking a redirect to an
    // internal host. All of them degrade the check rather than failing the run.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
