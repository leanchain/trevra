/**
 * Fill the built index.html's empty #root with the landing page's markup.
 *
 * The page's copy lives in MarketingScreen.tsx and nowhere else; this renders
 * that component once, at build time, so a crawler and a reader with no
 * JavaScript see the same page React would have drawn. The head, the two
 * server-side placeholders, and every `data-hosted-cta` attribute pass through
 * untouched -- src/server/public-site.ts rewrites those at request time.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketingApp } from '../src/client/MarketingApp';

const target = process.argv[2];
if (!target) throw new Error('usage: prerender-marketing <path to built index.html>');

const html = await readFile(target, 'utf8');
const ROOT = '<div id="root"></div>';
if (!html.includes(ROOT)) throw new Error(`${target} has no empty ${ROOT} to fill`);

const markup = renderToStaticMarkup(<MarketingApp />);
await writeFile(target, html.replace(ROOT, `<div id="root">${markup}</div>`), 'utf8');
console.log(`prerendered ${markup.length} bytes into ${target}`);
