import 'dotenv/config';
import express from 'express';
import { openDatabase } from '../server/db.js';
import { runAllAutomationCycles } from '../server/automation-service.js';
import { runReadyPlaybooks } from '../server/playbooks/engine.js';
import { runDueAgentSchedules } from '../server/agent/schedule.js';
import { reapStaleAgentRuns } from '../server/agent/runs.js';
import { orchestrationMode } from '../server/orchestration/client.js';
import { validateEnvironment } from '../server/config.js';
import { assertHostedDataReady } from '../server/hosted-readiness.js';
import {
  closeLinkedInBrowser,
  seatConcurrencyForConfig,
  linkedInWorkerHealth,
  linkedinWorkspaceIdsForShard,
  runBounded,
  runDueLinkedInActions,
  runPendingSeatDetectRequests,
  seatRefsForShard,
  workerIdentity,
  workerShard
} from '../server/linkedin/local-worker.js';
import {
  notifyCompanionSeatAttentionEmails,
  notifyDisconnectedCompanionDevices
} from '../server/linkedin/companion.js';
import {
  runLinkedInCampaignTick,
  runLinkedInPostTick,
  runLinkedInSideTasks
} from '../server/linkedin/jobs.js';
import { hostedExecutionMode, hostedSeatFilter } from '../server/linkedin/hosted-execution.js';
import { runDueResearchSources } from '../server/research/service.js';

const runtime = validateEnvironment();
// READ AND VALIDATED AT STARTUP, NEVER PER TICK. A shard that is not a
// partition -- index 5 of 3, a total of 0 -- means this process serves either a
// slice nobody serves or one somebody else is already serving, and both fail
// silently as a queue that half drains. `workerShard` throws; here is where an
// operator is watching.
const linkedinShard = workerShard();
const linkedinWorkerId = workerIdentity();
const db = await openDatabase();
await assertHostedDataReady(db);
const temporalWorker =
  orchestrationMode() === 'temporal'
    ? await (await import('../server/orchestration/worker.js')).startTemporalWorker(db)
    : null;
const app = express();
app.disable('x-powered-by');
app.get('/health', async (_req, res) => {
  // THE LINKEDIN QUEUE IS PART OF "HEALTHY", and it was not reportable at all.
  // A discovery read that fails returns the same empty list as a queue with
  // nothing due, so the one failure that stops EVERY tenant's automation used
  // to look exactly like the ordinary quiet case. It does not fail the probe --
  // a worker that cannot read the LinkedIn queue is still serving playbooks,
  // schedules and projections, and restarting it would fix nothing -- but it is
  // now a fact a monitor can alert on.
  const linkedin = linkedInWorkerHealth();
  try {
    await db.prepare('SELECT 1 AS ok').get();
    res.json({
      ok: true,
      service: 'trevra-worker',
      orchestrator: orchestrationMode(),
      worker: linkedinWorkerId,
      linkedinShard: `${linkedinShard.index + 1}/${linkedinShard.total}`,
      linkedin
    });
  } catch {
    res.status(503).json({ ok: false, service: 'trevra-worker', linkedin });
  }
});
const server = app.listen(runtime.port, () =>
  console.log(`Trevra worker health listening on http://localhost:${runtime.port}`)
);

// SAID ONCE, AT BOOT, BECAUSE IT IS THE SINGLE MOST CONSEQUENTIAL FACT ABOUT
// THIS PROCESS. "Hosted" used to mean "the LinkedIn queue is never served here"
// and now means "served here, through a remote browser, for the workspaces that
// authorised it" -- and an operator who cannot tell those two apart from the
// log has no way to know whether their queue is moving.
{
  const mode = hostedExecutionMode();
  if (mode.problem) console.error(`LinkedIn hosted execution is misconfigured: ${mode.problem}`);
  else if (mode.available)
    console.log(
      `LinkedIn seats run server-side through ${mode.provider}, for workspaces that have authorised it. Every other safety gate is unchanged.`
    );
  else if (mode.hosted && runtime.linkedinLocalWorker.companionBrowser)
    console.log(
      'LinkedIn companion execution is enabled: a workspace is served only while its paired computer and a signed-in Trevra tab are both present. LinkedIn traffic leaves from that computer.'
    );
  else if (mode.hosted)
    console.log(
      'LinkedIn execution is off on this hosted deployment: no cloud browser or companion relay is configured, so planned actions wait for a worker that can open one.'
    );
}

// A cycle already in flight when a signal arrives is allowed to finish; no NEW
// one is started. Bounded, because a hung cycle must not hold a deploy open --
// 20s sits inside the 30s grace a container runtime usually allows before
// SIGKILL. An agent run can outlast that, which is exactly why the reaper
// exists: what the drain cannot finish, the next worker writes off instead of
// leaving it to wedge that workspace's schedule forever.
const DRAIN_TIMEOUT_MS = 20_000;
let running = false;
let draining = false;
async function cycle(): Promise<void> {
  if (running || draining) return;
  running = true;
  // Before the schedule sweep, always: a run abandoned by a previous worker
  // keeps hasRunningAgentRun true and skips its workspace on every cycle, so
  // clearing it first is what lets a wedged workspace recover on this tick.
  // Its own try -- a failed reap must not cost the rest of the cycle.
  try {
    await reapStaleAgentRuns(db);
  } catch (error) {
    console.error('Worker could not reap abandoned agent runs', error);
  }
  try {
    await Promise.all([
      runAllAutomationCycles(db),
      runReadyPlaybooks(db),
      runDueAgentSchedules(db),
      runDueResearchSources(db)
    ]);
  } catch (error) {
    console.error('Worker control-plane cycle failed', error);
  } finally {
    running = false;
  }
}
// The local LinkedIn worker gets its OWN loop and its own in-flight flag,
// rather than a fifth entry in the cycle above. One batch drives a real
// browser at real paced gaps (30-120s between actions, plan 1.4), so a pass
// can last tens of minutes -- and folding that into `cycle()` would hold the
// automation sweep, the playbook engine and the schedule sweep behind it for
// exactly that long. Gated on config: `enabled` is false on every hosted
// instance by construction (plan 4.3) and on by default everywhere else.
//
// COSTS NOTHING WHERE IT CANNOT RUN. Both calls below check
// `linkedInBrowserReadiness` before touching the database, so this worker in a
// container -- no display, no browser binaries -- returns immediately and,
// crucially, claims no detect request away from the operator's own
// `npm run linkedin:worker` on the host (plan 4.9).
//
// EVERYTHING BELOW IS SHARDED, BOUNDED AND ROTATED, AND NONE OF THAT WAS TRUE.
// The three loops in this function used to walk EVERY seat and EVERY workspace
// on the deployment, serially, on every tick, in the same order in every
// worker process. At a thousand workspaces that is thousands of round trips
// before a browser opens, the same thousands repeated in every worker, and an
// alphabetical head that gets served every minute in front of a tail that is
// never reached at all. Sharding splits the fleet, the per-tick bounds keep one
// tick finite, and the cursors are what stop the bound from meaning "the first
// N forever".
const SIDE_TASK_SEATS_PER_TICK = 50;
const CAMPAIGN_WORKSPACES_PER_TICK = 50;
let seatCursor: { workspaceId: string; seatKey: string } | null = null;
let workspaceCursor: string | null = null;
let linkedinRunning = false;
async function linkedinCycle(): Promise<void> {
  if (linkedinRunning || draining || !runtime.linkedinLocalWorker.enabled) return;
  linkedinRunning = true;
  // THE HOSTED RUNNER IS THIS LOOP, NOT A SECOND ONE, and that is the whole
  // design: claiming, leasing, pacing, cooldown, the safety gate and the ledger
  // are the same code on a hosted deployment as on a laptop, because a second
  // implementation of any of them is a second place for them to be wrong. What
  // hosted execution adds is WHERE the browser is (a remote provider, see
  // `browser/provider.ts`) and WHO may be served (`allowSeat` below).
  //
  // Rebuilt every tick rather than once at boot: the filter memoises its
  // answers for the length of a pass, so a workspace that withdraws its
  // authorisation stops being served on the next tick rather than at the next
  // restart. Null on every self-hosted deployment, where the loop is unchanged.
  const allowSeat = hostedSeatFilter(db);
  // One paired laptop may own many isolated LinkedIn profiles, but it should
  // drive only one account at a time. Cloud/browser fleets keep the bounded
  // headless concurrency; the local companion is serialized across seats.
  const seatConcurrency = seatConcurrencyForConfig(runtime.linkedinLocalWorker, true);
  // Neither call throws -- a missing optional playwright, a browser that will
  // not open and a halted batch are all outcomes they report. This catch is
  // for the case they are wrong about that.
  try {
    await runPendingSeatDetectRequests(db, runtime.linkedinLocalWorker, {
      shard: linkedinShard,
      ...(allowSeat ? { allowSeat } : {})
    });
    await runDueLinkedInActions(db, runtime.linkedinLocalWorker, {
      shard: linkedinShard,
      workerId: linkedinWorkerId,
      concurrency: seatConcurrency,
      ...(allowSeat ? { allowSeat } : {})
    });
    // THE SEND QUEUE FIRST. Then one tightly bounded autonomous state read:
    // inbox sync, because replies are outcomes the campaign cannot otherwise
    // learn. Pending-invite reconciliation, acceptance profile checks and lead
    // sourcing remain explicit operator actions. `runLinkedInSideTasks` also
    // drains a withdrawal only when a queued withdrawal row already exists.
    //
    // PER SEAT and bounded/rotated across the shard so one account cannot
    // starve another tenant's worker pass.
    const seats = await seatRefsForShard(db, {
      shard: linkedinShard,
      limit: SIDE_TASK_SEATS_PER_TICK,
      after: seatCursor
    });
    seatCursor = seats.length < SIDE_TASK_SEATS_PER_TICK ? null : (seats[seats.length - 1] ?? null);
    await runBounded(seats, seatConcurrency, async (seat) => {
      if (allowSeat && !(await allowSeat(seat))) return;
      await runLinkedInSideTasks(db, runtime.linkedinLocalWorker, {
        workspaceId: seat.workspaceId,
        seatKey: seat.seatKey
      });
    });
    // Once per workspace, AFTER the side tasks -- see `runLinkedInCampaignTick`.
    // Sharded on the workspace alone: a campaign tick is a per-workspace act,
    // and hashing it per seat would have two workers advancing one tenant's
    // campaigns at the same time.
    const workspaces = await linkedinWorkspaceIdsForShard(db, {
      shard: linkedinShard,
      limit: CAMPAIGN_WORKSPACES_PER_TICK,
      after: workspaceCursor
    });
    workspaceCursor =
      workspaces.length < CAMPAIGN_WORKSPACES_PER_TICK
        ? null
        : (workspaces[workspaces.length - 1] ?? null);
    for (const workspaceId of workspaces) {
      // A campaign tick PLANS rows; it sends nothing. Gated all the same on a
      // hosted deployment, because filling an unauthorised workspace's queue
      // with work nothing may execute is a backlog with no reader.
      if (allowSeat && !(await allowSeat({ workspaceId }))) continue;
      await runLinkedInCampaignTick(db, workspaceId);
      await runLinkedInPostTick(db, runtime.linkedinLocalWorker, { workspaceId });
    }
  } catch (error) {
    console.error('LinkedIn local worker cycle failed', error);
  } finally {
    linkedinRunning = false;
  }
}
await cycle();
const timer = setInterval(() => void cycle(), runtime.automationIntervalMs);
timer.unref();
// Run the LinkedIn cycle once immediately after boot as well as on the cadence.
// Do not await it: one browser batch can legitimately run for many minutes, and
// worker startup/health plus the other timers must not wait behind real browser
// pacing. `linkedinRunning` makes the interval tick a no-op while this pass is
// still active, so this cannot create overlapping LinkedIn cycles.
void linkedinCycle();
const linkedinTimer = setInterval(() => void linkedinCycle(), runtime.automationIntervalMs);
linkedinTimer.unref();
// Presence alerting is operational monitoring, not business automation. It
// must not inherit a deployment's five-minute automation cadence, otherwise a
// five-minute disconnect grace can become almost ten minutes before the first
// email attempt. Scan independently once a minute; the DB marker makes repeated
// scans idempotent and notifyDisconnectedCompanionDevices isolates failures per
// workspace.
const COMPANION_PRESENCE_SCAN_MS = 60_000;
let companionPresenceRunning = false;
async function companionPresenceCycle(): Promise<void> {
  if (companionPresenceRunning || draining) return;
  companionPresenceRunning = true;
  try {
    await Promise.all([
      notifyDisconnectedCompanionDevices(db),
      notifyCompanionSeatAttentionEmails(db)
    ]);
  } catch (error) {
    console.error('Worker companion-presence cycle failed', error);
  } finally {
    companionPresenceRunning = false;
  }
}
await companionPresenceCycle();
const companionPresenceTimer = setInterval(
  () => void companionPresenceCycle(),
  COMPANION_PRESENCE_SCAN_MS
);
companionPresenceTimer.unref();

async function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  console.log(`${signal} received; draining worker`);
  clearInterval(timer);
  clearInterval(linkedinTimer);
  clearInterval(companionPresenceTimer);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while ((running || linkedinRunning || companionPresenceRunning) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  if (running)
    console.error(
      `Worker still mid-cycle after ${DRAIN_TIMEOUT_MS}ms; exiting anyway. Any agent run left in flight is written off by the next worker's reap.`
    );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await temporalWorker?.shutdown();
  // Before the pool closes: a browser left open outlives this process and
  // holds the operator's profile directory locked, so the next worker cannot
  // attach to it. A seat lease left behind expires on its own, and the row
  // keeps saying which host holds that seat's profile -- which is exactly what
  // the next worker on this host needs it to say.
  await closeLinkedInBrowser();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
