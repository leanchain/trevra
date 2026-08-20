/**
 * Rasterizes assets/og/trevra-social.html into public/og/trevra-social.png
 * with headless Chrome. The HTML is a build input, not a served asset; this
 * script is how the committed PNG gets regenerated when the card's copy or
 * design changes. Not wired into build:marketing -- the PNG is committed and
 * regenerated deliberately, run by hand: `npm run og:build`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable';
const WIDTH = 1200;
const HEIGHT = 630;

const input = resolve(process.argv[2] ?? 'assets/og/trevra-social.html');
const output = resolve(process.argv[3] ?? 'public/og/trevra-social.png');

if (!existsSync(CHROME_PATH)) {
  throw new Error(
    `render-og-image: Chrome not found at ${CHROME_PATH}. Set CHROME_PATH or install google-chrome-stable.`
  );
}
if (!existsSync(input)) {
  throw new Error(`render-og-image: input HTML not found at ${input}`);
}

execFileSync(
  CHROME_PATH,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--screenshot=${output}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `file://${input}`
  ],
  { stdio: 'inherit' }
);

if (!existsSync(output) || statSync(output).size === 0) {
  throw new Error(`render-og-image: expected Chrome to write ${output}, but it did not.`);
}

console.log(`render-og-image: wrote ${output} (${statSync(output).size} bytes)`);
