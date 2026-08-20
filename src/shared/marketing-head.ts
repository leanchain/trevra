/**
 * Build-time head injection for the static Cloudflare Pages bundle.
 *
 * The Express origin rewrites the shipped `index.html` head at request time
 * (`renderAppIndex` in src/server/public-site.ts); the static build has no
 * request to rewrite on, so scripts/prerender-marketing.tsx calls
 * `injectMarketingHead` once, at build time, to do the equivalent work: fill
 * the two `TREVRA_*` placeholders and repoint the hardcoded production
 * origin at whatever origin this build is actually being deployed to.
 *
 * Pure but for `node:crypto` -- build/server-only, safe to unit-test
 * directly, never imported by src/client.
 */
import { createHash } from 'node:crypto';

const PRODUCTION_ORIGIN = 'https://usetrevra.com';
const VERIFICATION_MARKER = '<!-- TREVRA_VERIFICATION -->';
const JSON_LD_MARKER = '<!-- TREVRA_JSON_LD -->';

export interface InjectMarketingHeadOptions {
  /** The origin this build is being deployed to, e.g. https://usetrevra.com. */
  origin: string;
  /** Pre-built verification meta tag(s), or '' when none are configured. */
  verification: string;
  /** Serialized into the page's `application/ld+json` block. */
  jsonLd: unknown;
}

/**
 * Fills the two build-time placeholders `index.html` ships with and
 * rewrites every hardcoded `https://usetrevra.com` occurrence (canonical,
 * `og:url`, `og:image`) to `origin`, so a preview deploy advertises its own
 * URL instead of production's.
 *
 * Throws when either marker is missing: a silent no-op here is exactly the
 * bug this function exists to close -- production shipping the literal
 * `<!-- TREVRA_JSON_LD -->` placeholder comment with no structured data at
 * all.
 */
export function injectMarketingHead(html: string, options: InjectMarketingHeadOptions): string {
  const { origin, verification, jsonLd } = options;
  if (!html.includes(VERIFICATION_MARKER)) {
    throw new Error(`injectMarketingHead: missing ${VERIFICATION_MARKER} marker`);
  }
  if (!html.includes(JSON_LD_MARKER)) {
    throw new Error(`injectMarketingHead: missing ${JSON_LD_MARKER} marker`);
  }
  const json = JSON.stringify(jsonLd).replaceAll('<', '\\u003c');
  const script = `<script type="application/ld+json">${json}</script>`;
  return html
    .replaceAll(PRODUCTION_ORIGIN, origin)
    .replace(VERIFICATION_MARKER, verification)
    .replace(JSON_LD_MARKER, script);
}

/**
 * `'sha256-<base64>'` for every inline `<script>` element in `html` -- one
 * with no `src` attribute -- hashing the exact bytes between the tags. The
 * CSP `script-src` source list a browser needs to allow it, since a static
 * page has no per-request nonce to lean on instead.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const [, attrs, content] of html.matchAll(scriptPattern)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    hashes.push(`sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`);
  }
  return hashes;
}
