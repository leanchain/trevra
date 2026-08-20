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
import { SITE_DESCRIPTION, SITE_TITLE, SOCIAL_IMAGE } from './site-metadata.js';

/** The origin index.html and the static documents hardcode. */
export const PRODUCTION_ORIGIN = 'https://usetrevra.com';
export const VERIFICATION_MARKER = '<!-- TREVRA_VERIFICATION -->';
export const JSON_LD_MARKER = '<!-- TREVRA_JSON_LD -->';

export interface InjectMarketingHeadOptions {
  /** The origin this build is being deployed to, e.g. https://usetrevra.com. */
  origin: string;
  /** Pre-built verification meta tag(s), or '' when none are configured. */
  verification: string;
  /** Serialized into the page's `application/ld+json` block. */
  jsonLd: unknown;
}

/**
 * The head copy `index.html` hardcodes, and where it comes from.
 *
 * index.html repeats the title and description six times between `<title>`,
 * `meta[name=description]`, and the og/twitter pairs. Left unbound, changing
 * `SITE_TITLE` shipped the old title in the head next to the new one inside
 * the JSON-LD, with every test still green -- so these are rewritten from the
 * shared constants on every build, exactly as the Express origin rewrites
 * them per request.
 *
 * The patterns use `\s+`, never a literal space: Prettier wraps any tag whose
 * copy runs past `printWidth` across three lines with one attribute per line,
 * and which tags those are changes with the length of the copy.
 */
function headCopyRewrites(): Array<{ label: string; pattern: RegExp; replacement: string }> {
  const title = escapeAttr(SITE_TITLE);
  const description = escapeAttr(SITE_DESCRIPTION);
  const meta = (name: 'name' | 'property', key: string, value: string) => ({
    label: `<meta ${name}="${key}">`,
    pattern: new RegExp(
      `<meta\\s+${name}="${key.replaceAll('.', '\\.')}"\\s+content="[^"]*"\\s*/>`
    ),
    replacement: `<meta ${name}="${key}" content="${value}" />`
  });
  return [
    {
      label: '<title>',
      pattern: /<title>[^<]*<\/title>/,
      replacement: `<title>${escapeAttr(SITE_TITLE)}</title>`
    },
    meta('name', 'description', description),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:image:alt', escapeAttr(SOCIAL_IMAGE.alt)),
    meta('name', 'twitter:title', title),
    meta('name', 'twitter:description', description)
  ];
}

/**
 * Fills the two build-time placeholders `index.html` ships with, rewrites
 * the head copy from the shared constants, and rewrites every hardcoded
 * `https://usetrevra.com` occurrence (canonical, `og:url`, `og:image`) to
 * `origin`, so a preview deploy advertises its own URL instead of
 * production's.
 *
 * Throws when a marker or a head tag is missing: a silent no-op here is
 * exactly the bug this function exists to close -- production shipping the
 * literal `<!-- TREVRA_JSON_LD -->` placeholder comment with no structured
 * data at all, or head copy that no longer matches the JSON-LD beside it.
 */
export function injectMarketingHead(html: string, options: InjectMarketingHeadOptions): string {
  const { origin, verification, jsonLd } = options;
  if (!html.includes(VERIFICATION_MARKER)) {
    throw new Error(`injectMarketingHead: missing ${VERIFICATION_MARKER} marker`);
  }
  if (!html.includes(JSON_LD_MARKER)) {
    throw new Error(`injectMarketingHead: missing ${JSON_LD_MARKER} marker`);
  }
  let out = html.replaceAll(PRODUCTION_ORIGIN, origin);
  for (const { label, pattern, replacement } of headCopyRewrites()) {
    if (!pattern.test(out)) {
      throw new Error(`injectMarketingHead: no ${label} tag to rewrite`);
    }
    out = out.replace(pattern, replacement);
  }
  const json = JSON.stringify(jsonLd).replaceAll('<', '\\u003c');
  const script = `<script type="application/ld+json">${json}</script>`;
  return out.replace(VERIFICATION_MARKER, verification).replace(JSON_LD_MARKER, script);
}

function escapeAttr(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!
  );
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
