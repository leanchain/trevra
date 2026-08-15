/**
 * Open a seat's browser through the REAL code path, and say what happened.
 *
 * WHY THIS EXISTS: the launch is the one step no unit test can cover -- the
 * suite deliberately points `PLAYWRIGHT_BROWSERS_PATH` at nothing and deletes
 * DISPLAY so nothing can start a browser. That left `openBrowser` verified only
 * by reading, and two defects lived in it at once: a duplicate `args` key that
 * discarded the ANGLE flags, and a stale `SingletonLock` from a rebuilt
 * container that Chromium refuses to break. Both were invisible until someone
 * ran the real thing.
 *
 *   docker exec <container> sh -lc 'npx tsx scripts/linkedin-launch-probe.mts <workspaceId> [seatKey]'
 *
 * It opens `about:blank` through `warmUpSession`'s usual preamble and closes
 * again. It signs nothing in, reads no LinkedIn page and stores nothing.
 */
import { closeLinkedInBrowser, openBrowser } from '../src/server/linkedin/local-worker.js';
import { linkedInWorkerConfig } from '../src/server/config.js';

const workspaceId = process.argv[2];
const seatKey = process.argv[3] ?? 'owner';
if (!workspaceId) {
  console.error('usage: tsx scripts/linkedin-launch-probe.mts <workspaceId> [seatKey]');
  process.exit(2);
}

const config = linkedInWorkerConfig();
console.log('config:', JSON.stringify(config));

const handle = await openBrowser(config, (message) => console.log('[worker]', message), {
  // No database: this probe answers "can a browser open for this seat", and a
  // seat's proxy row is the only thing `db` is read for. A proxy-configured
  // seat must be probed through the worker itself, not here.
  db: null,
  workspaceId,
  seatKey,
  headless: config.headless === false ? false : undefined,
  timezone: 'Europe/Zurich'
});

console.log(handle ? `OPENED, page at ${handle.page.url()}` : 'FAILED: openBrowser returned null (the log line above says why)');
await closeLinkedInBrowser();
process.exit(handle ? 0 : 1);
