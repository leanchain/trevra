/**
 * Run the REAL `readSeat` against the live session and print what it got.
 *
 * The step no unit test can reach: `readSeat`'s selectors are claims about a
 * page LinkedIn serves, and the suite can only check them against fakes built
 * from the same assumptions. Two of them were wrong at once -- no `h1` on the
 * profile, a German connections header -- and both were invisible until this
 * ran.
 *
 *   docker exec <container> sh -lc 'npx tsx scripts/linkedin-read-probe.mts <workspaceId>'
 *
 * Two page loads on the member's own account, exactly what a detect costs.
 */
import { closeLinkedInBrowser, openBrowser } from '../src/server/linkedin/local-worker.js';
import { readSeat } from '../src/server/linkedin/driver.js';
import { linkedInWorkerConfig } from '../src/server/config.js';

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error('usage: tsx scripts/linkedin-read-probe.mts <workspaceId> [seatKey]');
  process.exit(2);
}

const handle = await openBrowser(linkedInWorkerConfig(), (message) => console.log('[worker]', message.slice(0, 160)), {
  db: null,
  workspaceId,
  seatKey: process.argv[3] ?? 'owner',
  headless: false,
  timezone: 'Europe/Zurich'
});
if (!handle) {
  console.log('FAILED to open a browser');
  process.exit(1);
}

console.log(JSON.stringify(await readSeat(handle.page), null, 1));
await closeLinkedInBrowser();
process.exit(0);
