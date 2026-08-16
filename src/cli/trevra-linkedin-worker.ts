import 'dotenv/config';
import { validateEnvironment } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import {
  closeLinkedInBrowser,
  linkedInBrowserReadiness,
  linkedInOffReason,
  linkedinWorkspaceIdsForShard,
  profileDirBase,
  runDueLinkedInActions,
  runPendingSeatDetectRequests,
  seatRefsForShard,
  workerHost,
  workerIdentity,
  workerShard
} from '../server/linkedin/local-worker.js';
import { runLinkedInCampaignTick, runLinkedInSideTasks } from '../server/linkedin/jobs.js';
import { hostedSeatFilter } from '../server/linkedin/hosted-execution.js';

/**
 * `npm run linkedin:worker` -- the LinkedIn loop, on the machine that has a
 * display (docs/linkedin-outreach-plan.md 4.9).
 *
 * SAME LOOP, DIFFERENT PROCESS. It calls `runDueLinkedInActions` and
 * `runPendingSeatDetectRequests` exactly as `src/worker/index.ts` does; there
 * is no second implementation of pacing, claiming or the safety gate here, and
 * there must never be one. What differs is only WHERE it runs: against the
 * host's own Chrome profiles and the host's own display, over the same Postgres
 * the containers use (published on TREVRA_DB_PORT, default 45432).
 *
 * ONE PROCESS DRIVES EVERY SEAT, AND THAT IS A DELIBERATE CHOICE OVER
 * ONE-PROCESS-PER-SEAT.
 *
 * The brief allowed either. This is safe as one process because the only two
 * things two accounts could collide over are already isolated per seat, by
 * construction rather than by convention:
 *
 *   1. THE CHROME PROFILE DIRECTORY. `resolveProfileDir` keys on
 *      (workspace, seat), so two seats cannot share a user-data-dir -- which
 *      matters because Chromium takes an exclusive lock on one, and because a
 *      shared one would have two accounts overwriting each other's session.
 *   2. THE OPEN BROWSER. `local-worker.ts` keeps a handle map keyed on the
 *      same pair, so a second seat's call can never be handed the first seat's
 *      already-open page.
 *
 * Everything else a batch touches -- the claim, the posture, the cooldown, the
 * ledger -- is already keyed by (workspace_id, seat_key) in SQL, and the drain
 * is SEQUENTIAL, one seat's batch after another's, so no two accounts are ever
 * mid-action at the same moment on this machine. That is also why this is the
 * better default: two headed Chrome windows fighting over one laptop's
 * foreground is a worse experience than two batches in a row, and a batch is
 * mostly asleep in its 30-120s gaps anyway.
 *
 * `--seat=<key>` is still there for the case that genuinely needs separate
 * processes: one account behind a proxy and another not, two accounts on two
 * different machines, or an operator who wants to stop one account without
 * touching the other. Each process then serves exactly the seat it was given.
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

/**
 * `--seat=<key>`, or nothing.
 *
 * NOTHING MEANS EVERY SEAT, not the owner seat. Defaulting to `owner` here
 * would reproduce the exact bug this change exists to remove -- a worker
 * started with no arguments quietly serving one account and leaving the rest
 * of the workspace's queues to fill up -- so the default is the inclusive one
 * and narrowing is the explicit act.
 */
function seatSelector(argv: readonly string[]): string | undefined {
  const flag = argv.find((argument) => argument === '--seat' || argument.startsWith('--seat='));
  if (!flag) return undefined;
  const value = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1).trim() : (argv[argv.indexOf(flag) + 1] ?? '').trim();
  if (!value) fail('--seat needs a seat key, e.g. --seat=owner or --seat=sales.');
  // The same alphabet `seats.ts` enforces on a stored key. Rejected here rather
  // than silently matching nothing, because "the worker ran and did nothing"
  // is the least debuggable outcome available.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    fail(`'${value}' is not a seat key. Use 1-64 letters, numbers, underscores or dashes.`);
  }
  return value;
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

const seatKey = seatSelector(process.argv.slice(2));

/**
 * ONE MACHINE, AND BY DEFAULT ALL OF IT.
 *
 * The shard exists for the hosted fleet, where several worker hosts split the
 * seats between them; on an operator's own laptop it is `0 of 1`, which selects
 * everything and costs nothing. Read here rather than inside the loop so a
 * mistyped `TREVRA_LINKEDIN_WORKER_INDEX` is a refusal to start with a sentence
 * attached, not a worker that quietly serves half the accounts.
 *
 * The identity and the host go with it: the host is what pins a seat to the
 * machine that holds its Chrome profile, and on a laptop that pin is what stops
 * a container elsewhere from picking the seat up and signing in from a new
 * device.
 */
let shard: ReturnType<typeof workerShard>;
try {
  shard = workerShard();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const workerId = workerIdentity();
const host = workerHost();

const db = await openDatabase();
// One Chrome profile per SEAT, not one per workspace and not one for the whole
// process -- see `resolveProfileDir`. This loop can serve several, so there is
// no single path left to print here, only the base they are all built from.
process.stdout.write(
  `LinkedIn worker running with a separate Chrome profile per seat, under ${profileDirBase(config.profileDir)}-<workspace>[-<seat>]-profile\n`
);
process.stdout.write(
  seatKey
    ? `Serving seat '${seatKey}' only. Run another process with a different --seat to drive another account.\n`
    : 'Serving every configured seat, one at a time. Pass --seat=<key> to serve just one.\n'
);
process.stdout.write(`Checking for work every ${Math.round(runtime.automationIntervalMs / 1000)}s. Ctrl-C to stop.\n`);

const SIDE_TASK_SEATS_PER_TICK = 50;
const CAMPAIGN_WORKSPACES_PER_TICK = 50;
let seatCursor: { workspaceId: string; seatKey: string } | null = null;
let workspaceCursor: string | null = null;
let running = false;
let draining = false;

async function cycle(): Promise<void> {
  if (running || draining) return;
  running = true;
  // NULL ON A LAPTOP, WHICH IS EVERY NORMAL RUN OF THIS COMMAND -- the filter
  // only exists on a hosted deployment. Built anyway, and threaded through
  // below, so that an operator pointing this process at a hosted database
  // (a debugging session, a migration between machines) obeys the same
  // per-workspace authorisation the hosted runner does rather than becoming a
  // way around it.
  const allowSeat = hostedSeatFilter(db);
  try {
    // Detection first: a workspace whose seat has just been connected has no
    // pacing history to work from until the seat row exists, so doing this
    // second would cost it a whole tick on the operator's very first run.
    await runPendingSeatDetectRequests(db, config, { shard });
    // CONCURRENCY 1, EXPLICITLY. The hosted worker runs several seats at once
    // because nobody is watching a headless container; here every batch is a
    // real Chrome window on the operator's own desktop, and two of those
    // fighting for the foreground is worse than two batches in a row -- the
    // argument this file has always made, now that it has to be made out loud.
    await runDueLinkedInActions(db, config, { ...(seatKey ? { seatKey } : {}), shard, workerId, host, concurrency: 1, ...(allowSeat ? { allowSeat } : {}) });
    // Then the periodic work: read the inbox, reconcile LinkedIn's own
    // pending-invite list, drain the withdrawal queue, walk a lead source.
    // AFTER the send queue, always -- that is the only work with a paced slot
    // attached, and an inbox walk can take minutes.
    //
    // This is the process that usually does all of it: on the normal
    // self-hosted split the API and the container worker have no display, so
    // they serve only seats that sign themselves in. Same functions, same
    // gates; only the machine differs.
    //
    // ONCE PER SEAT, NOT ONCE PER WORKSPACE. Every one of these reads a
    // different signed-in session -- the inbox is that account's inbox, the
    // pending-invite list is that account's list -- so iterating workspaces
    // would silently serve only whichever seat `runLinkedInSideTasks`
    // defaulted to and leave every other account's inbox stale.
    //
    // Bounded and rotated for the same reason the container worker's loop is:
    // a page at a time, continuing where the last tick stopped, so a machine
    // driving many seats cannot spend a whole tick on the alphabetical head and
    // never reach the tail.
    const seats = await seatRefsForShard(db, { shard, limit: SIDE_TASK_SEATS_PER_TICK, after: seatCursor });
    seatCursor = seats.length < SIDE_TASK_SEATS_PER_TICK ? null : seats[seats.length - 1] ?? null;
    for (const seat of seats) {
      if (seatKey && seat.seatKey !== seatKey) continue;
      if (allowSeat && !(await allowSeat(seat))) continue;
      await runLinkedInSideTasks(db, config, { workspaceId: seat.workspaceId, seatKey: seat.seatKey });
    }
    // Campaigns advance once per WORKSPACE, after the side tasks have recorded
    // this cycle's outcomes -- see `runLinkedInCampaignTick`.
    const workspaces = await linkedinWorkspaceIdsForShard(db, { shard, limit: CAMPAIGN_WORKSPACES_PER_TICK, after: workspaceCursor });
    workspaceCursor = workspaces.length < CAMPAIGN_WORKSPACES_PER_TICK ? null : workspaces[workspaces.length - 1] ?? null;
    for (const workspaceId of workspaces) {
      await runLinkedInCampaignTick(db, workspaceId);
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
