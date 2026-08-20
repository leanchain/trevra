import 'dotenv/config';
import { PUBLIC_PATHS } from '../src/shared/site-metadata.js';

const origin = new URL(process.env.PUBLIC_SITE_URL ?? process.env.BETTER_AUTH_URL ?? '').origin;
const key = process.env.INDEXNOW_KEY?.trim();
if (!key) throw new Error('INDEXNOW_KEY is required');
if (!/^[A-Za-z0-9._-]{8,128}$/.test(key))
  throw new Error('INDEXNOW_KEY must be 8-128 URL-safe characters');

const paths = PUBLIC_PATHS;
const endpoint = process.env.INDEXNOW_ENDPOINT ?? 'https://api.indexnow.org/indexnow';
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    host: new URL(origin).host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: paths.map((path) => `${origin}${path}`)
  })
});
if (!response.ok && response.status !== 202)
  throw new Error(`IndexNow submission failed: ${response.status} ${await response.text()}`);
console.log(`IndexNow accepted ${paths.length} Trevra URLs (${response.status}).`);
