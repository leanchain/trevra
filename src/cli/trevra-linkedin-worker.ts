import 'dotenv/config';
import { validateEnvironment } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import {
  closeLinkedInBrowser,
  linkedInBrowserReadiness,
  linkedInOffReason,
  resolveProfileDir,
  runDueLinkedInActions,
  runPendingSeatDetectRequests
} from '../server/linkedin/local-worker.js';
import { runLinkedInSideTasks } from '../server/linkedin/jobs.js';
import { linkedinWorkspaceIds } from '../server/linkedin/seats.js';

/**
 * `npm run linkedin:worker` -- the LinkedIn loop, on the machine that has a
 * display (docs/linkedin-outreach-plan.md 4.9).
 *
 * SAME LOOP, DIFFERENT PROCESS. It calls `runDueLinkedInActions` and
 * `runPendingSeatDetectRequests` exactly as `src/worker/index.ts` does; there
 * is no second implementation of pacing, claiming or the safety gate here, and
 * there must never be one. What differs is only WHERE it runs: against the
 * host's own Chrome profile and the host's own display, over the same Postgres
 * the containers use (published on TREVRA_DB_PORT, default 45432).
 *
 * REFUSES TO START rather than looping uselessly. A worker that cannot open a
 * browser has nothing to contribute and would only claim work away from one
 * that can, so the readiness probe is a precondition here, not a per-tick
 * inconvenience.
 */

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// A config problem must arrive as one line, not as a zod stack trace. This
// command is run by an operator on their own laptop, and a wall of JSON is the
// same dead end this whole split exists to remove.
let runtime: ReturnType<typeof validateEnvironment>;
try {
  runtime = validateEnvironment();
} catch (error) {
  if (!process.env.DATABASE_URL?.trim()) {
    fail('Set DATABASE_URL to the Trevra database (your stack publishes it on localhost:45432 by default), then run this again.');
  }
  fail(`This machine's environment is not valid for Trevra: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}

const config = runtime.linkedinLocalWorker;
if (!config.enabled) fail(linkedInOffReason(config));

const readiness = linkedInBrowserReadiness(config);
if (!readiness.canLaunchHeaded) fail(readiness.reasons.join(' '));

const db = await openDatabase();
const profileDir = resolveProfileDir(config.profileDir);
process.stdout.write(`LinkedIn worker running against the Chrome profile at ${profileDir}\n`);
process.stdout.write(`Checking for work every ${Math.round(runtime.automationIntervalMs / 1000)}s. Ctrl-C to stop.\n`);

let running = false;
let draining = false;

async function cycle(): Promise<void> {
  if (running || draining) return;
  running = true;
  try {
    // Detection first: a workspace whose seat has just been connected has no
    // pacing history to work from until the seat row exists, so doing this
    // second would cost it a whole tick on the operator's very first run.
    await runPendingSeatDetectRequests(db, config);
    await runDueLinkedInActions(db, config);
    // Then the periodic work: read the inbox, reconcile LinkedIn's own
    // pending-invite list, drain the withdrawal queue, walk a lead source.
    // AFTER the send queue, always -- that is the only work with a paced slot
    // attached, and an inbox walk can take minutes.
    //
    // This is the process that usually does all of it: on the normal
    // self-hosted split the API and the container worker have no display, so
    // they serve only seats that sign themselves in. Same functions, same
    // gates; only the machine differs.
    for (const workspaceId of await linkedinWorkspaceIds(db)) {
      await runLinkedInSideTasks(db, config, { workspaceId });
    }
  } catch (error) {
    // Neither call throws by contract. This is for the case they are wrong
    // about that: a browser problem must not end a loop the operator started
    // and walked away from.
    console.error('LinkedIn worker cycle failed', error);
  } finally {
    running = false;
  }
}

await cycle();
const timer = setInterval(() => void cycle(), runtime.automationIntervalMs);

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  process.stdout.write(`\n${signal} received; finishing the current pass\n`);
  clearInterval(timer);
  // A batch mid-flight has a real browser on a real page. It is allowed to
  // finish -- the same courtesy `src/worker/index.ts` extends -- because
  // killing it between a click and its outcome is exactly the `unknown` a
  // human then has to settle by hand.
  const deadline = Date.now() + 20_000;
  while (running && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
  // Before the pool closes: a browser left open holds the profile directory
  // locked, and the next worker cannot attach to it.
  await closeLinkedInBrowser();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
