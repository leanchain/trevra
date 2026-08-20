/**
 * Write the SEO/GEO surface Express serves at request time into dist/, so
 * the static Cloudflare Pages build carries the exact files the server
 * origin does: sitemap.xml, llms.txt, llms-full.txt, humans.txt,
 * .well-known/security.txt, and agents.md -- all rendered from the same
 * shared renderers src/server/public-site.ts calls at request time.
 *
 * Runs after scripts/prerender-marketing.tsx and before
 * scripts/build-marketing-headers.ts in `build:marketing`.
 *
 * public/sitemap.xml, public/llms.txt, public/agents.md and public/robots.txt
 * used to be hand-maintained static copies that drifted from the server's own
 * versions (missing /security, no lastmod, a hardcoded production sitemap and
 * host, stale positioning copy). They are deleted; what this script generates
 * into dist/ -- built fresh every deploy -- is the only version of each.
 *
 * This is also where the hardcoded production origin is rewritten out of
 * every built HTML file. index.html gets that from injectMarketingHead during
 * the prerender, but the four static documents are copied verbatim out of
 * public/ with `https://usetrevra.com` in their canonical, og:url and JSON-LD
 * -- so a preview build's sitemap said preview.example while every page it
 * listed claimed production as its canonical. It has to happen before
 * build-marketing-headers.ts, which hashes those files' inline scripts.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCTION_ORIGIN } from '../src/shared/marketing-head.js';
import {
  renderHumansText,
  renderLlmsText,
  renderPublicAgents,
  renderRobotsTxt,
  renderSecurityText,
  renderSitemap,
  SITE_DESCRIPTION,
  SITE_NAME,
  type SiteRenderConfig
} from '../src/shared/site-metadata.js';

const outDir = process.argv[2] ?? 'dist';

const origin = new URL(process.env.VITE_PUBLIC_SITE_URL?.trim() || PRODUCTION_ORIGIN).origin;
const hostname = new URL(origin).hostname;
const supportEmail = process.env.VITE_SUPPORT_EMAIL?.trim() || `support@${hostname}`;
// Never VITE_SUPPORT_EMAIL: security.txt publishes this address, and pointing
// vulnerability reports at the public support inbox is a disclosure hazard.
const securityEmail = process.env.SECURITY_CONTACT_EMAIL?.trim() || `security@${hostname}`;

const config: SiteRenderConfig = {
  origin,
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  supportEmail,
  securityEmail
};

const now = new Date().toISOString();
const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().replace('.000Z', 'Z');

await mkdir(`${outDir}/.well-known`, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/robots.txt`, renderRobotsTxt(origin), 'utf8'),
  writeFile(`${outDir}/sitemap.xml`, renderSitemap(origin, now), 'utf8'),
  writeFile(`${outDir}/llms.txt`, renderLlmsText(config, false), 'utf8'),
  writeFile(`${outDir}/llms-full.txt`, renderLlmsText(config, true), 'utf8'),
  writeFile(`${outDir}/humans.txt`, renderHumansText(config), 'utf8'),
  writeFile(`${outDir}/.well-known/security.txt`, renderSecurityText(config, expires), 'utf8'),
  writeFile(`${outDir}/agents.md`, renderPublicAgents(config), 'utf8')
]);

async function findHtmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath ?? dir, entry.name));
}

let rewritten = 0;
if (origin !== PRODUCTION_ORIGIN) {
  for (const file of await findHtmlFiles(outDir)) {
    const html = await readFile(file, 'utf8');
    if (!html.includes(PRODUCTION_ORIGIN)) continue;
    await writeFile(file, html.replaceAll(PRODUCTION_ORIGIN, origin), 'utf8');
    rewritten += 1;
  }
}

console.log(
  `Wrote marketing SEO/GEO files into ${outDir} (origin ${origin}, ${rewritten} HTML file(s) repointed)`
);
