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
 * public/sitemap.xml, public/llms.txt and public/agents.md used to be
 * hand-maintained static copies that drifted from the server's own versions
 * (missing /security, no lastmod, stale positioning copy). Once this script
 * has generated the real ones into dist/, it deletes those source copies so
 * dist/ -- built fresh every deploy -- is the only version of each.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  renderHumansText,
  renderLlmsText,
  renderPublicAgents,
  renderSecurityText,
  renderSitemap,
  SITE_DESCRIPTION,
  SITE_NAME,
  type SiteRenderConfig
} from '../src/shared/site-metadata.js';

const outDir = process.argv[2] ?? 'dist';

const origin = new URL(process.env.VITE_PUBLIC_SITE_URL?.trim() || 'https://usetrevra.com').origin;
const hostname = new URL(origin).hostname;
const supportEmail = process.env.VITE_SUPPORT_EMAIL?.trim() || `support@${hostname}`;
const securityEmail = process.env.VITE_SUPPORT_EMAIL?.trim() || `security@${hostname}`;

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
  writeFile(`${outDir}/sitemap.xml`, renderSitemap(origin, now), 'utf8'),
  writeFile(`${outDir}/llms.txt`, renderLlmsText(config, false), 'utf8'),
  writeFile(`${outDir}/llms-full.txt`, renderLlmsText(config, true), 'utf8'),
  writeFile(`${outDir}/humans.txt`, renderHumansText(config), 'utf8'),
  writeFile(`${outDir}/.well-known/security.txt`, renderSecurityText(config, expires), 'utf8'),
  writeFile(`${outDir}/agents.md`, renderPublicAgents(config), 'utf8')
]);

await Promise.all(
  ['public/sitemap.xml', 'public/llms.txt', 'public/agents.md'].map((file) =>
    rm(file, { force: true })
  )
);

console.log(`Wrote marketing SEO/GEO files into ${outDir}`);
