/**
 * Fill the built index.html's empty #root with the landing page's markup,
 * then inject the marketing head -- JSON-LD, verification meta, and the
 * deploy-time origin.
 *
 * The page's copy lives in MarketingScreen.tsx and nowhere else; this renders
 * that component once, at build time, so a crawler and a reader with no
 * JavaScript see the same page React would have drawn.
 *
 * The head used to pass through this script untouched, on the assumption
 * that src/server/public-site.ts would fill the two `TREVRA_*` placeholders
 * at request time -- but the static Cloudflare Pages build has no server to
 * do that on. Without this step, production shipped the literal
 * `<!-- TREVRA_JSON_LD -->` comment and no verification meta at all. This is
 * where the static build gets the equivalent of what the Express origin
 * renders per request.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from '../src/client/MarketingApp';
import { injectMarketingHead } from '../src/shared/marketing-head.js';
import { buildStructuredData, SITE_DESCRIPTION, SITE_NAME } from '../src/shared/site-metadata.js';

const target = process.argv[2];
if (!target) throw new Error('usage: prerender-marketing <path to built index.html>');

const html = await readFile(target, 'utf8');
const ROOT = '<div id="root"></div>';
if (!html.includes(ROOT)) throw new Error(`${target} has no empty ${ROOT} to fill`);

const markup = renderToStaticMarkup(<MarketingApp />);
const filled = html.replace(ROOT, `<div id="root">${markup}</div>`);

const origin = new URL(process.env.VITE_PUBLIC_SITE_URL?.trim() || 'https://usetrevra.com').origin;
const hostname = new URL(origin).hostname;
const supportEmail = process.env.VITE_SUPPORT_EMAIL?.trim() || `support@${hostname}`;
const githubUrl = process.env.VITE_GITHUB_URL?.trim() || '';

const googleVerification = process.env.GOOGLE_SITE_VERIFICATION?.trim() || '';
const bingVerification = process.env.BING_SITE_VERIFICATION?.trim() || '';
const verification = [
  googleVerification
    ? `<meta name="google-site-verification" content="${escapeAttr(googleVerification)}" />`
    : '',
  bingVerification ? `<meta name="msvalidate.01" content="${escapeAttr(bingVerification)}" />` : ''
]
  .filter(Boolean)
  .join('\n    ');

const jsonLd = buildStructuredData({
  origin,
  name: SITE_NAME,
  legalName: SITE_NAME,
  description: SITE_DESCRIPTION,
  supportEmail,
  githubUrl
});

const finalHtml = injectMarketingHead(filled, { origin, verification, jsonLd });
await writeFile(target, finalHtml, 'utf8');
console.log(`prerendered ${markup.length} bytes and injected the marketing head into ${target}`);

function escapeAttr(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!
  );
}
