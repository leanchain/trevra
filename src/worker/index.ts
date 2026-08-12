import 'dotenv/config';
import express from 'express';
import { openDatabase } from '../server/db.js';
import { runAllAutomationCycles } from '../server/automation-service.js';
import { runReadyPlaybooks } from '../server/playbooks/engine.js';
import { runCommercialProjectionCycle } from '../server/projections/commercial.js';
import { runDueAgentSchedules } from '../server/agent/schedule.js';
import { reapStaleAgentRuns } from '../server/agent/runs.js';
import { orchestrationMode } from '../server/orchestration/client.js';
import { validateEnvironment } from '../server/config.js';
import { closeLinkedInBrowser, runDueLinkedInActions, runPendingSeatDetectRequests } from '../server/linkedin/local-worker.js';
import { runLinkedInSideTasks } from '../server/linkedin/jobs.js';
import { linkedinWorkspaceIds } from '../server/linkedin/seats.js';
import { runDueResearchSources } from '../server/research/service.js';

const runtime=validateEnvironment();
const db=await openDatabase();
const temporalWorker=orchestrationMode()==='temporal'
  ? await (await import('../server/orchestration/worker.js')).startTemporalWorker(db)
  : null;
const app=express();
app.disable('x-powered-by');
app.get('/health',async(_req,res)=>{
  try{await db.prepare('SELECT 1 AS ok').get();res.json({ok:true,service:'trevra-worker',orchestrator:orchestrationMode()});}
  catch{res.status(503).json({ok:false,service:'trevra-worker'});}
});
const server=app.listen(runtime.port,()=>console.log(`Trevra worker health listening on http://localhost:${runtime.port}`));

// A cycle already in flight when a signal arrives is allowed to finish; no NEW
// one is started. Bounded, because a hung cycle must not hold a deploy open --
// 20s sits inside the 30s grace a container runtime usually allows before
// SIGKILL. An agent run can outlast that, which is exactly why the reaper
// exists: what the drain cannot finish, the next worker writes off instead of
// leaving it to wedge that workspace's schedule forever.
const DRAIN_TIMEOUT_MS=20_000;
let running=false;
let draining=false;
async function cycle():Promise<void>{
  if(running||draining)return;
  running=true;
  // Before the schedule sweep, always: a run abandoned by a previous worker
  // keeps hasRunningAgentRun true and skips its workspace on every cycle, so
  // clearing it first is what lets a wedged workspace recover on this tick.
  // Its own try -- a failed reap must not cost the rest of the cycle.
  try{await reapStaleAgentRuns(db);}
  catch(error){console.error('Worker could not reap abandoned agent runs',error);}
  try{await Promise.all([runAllAutomationCycles(db),runReadyPlaybooks(db),runCommercialProjectionCycle(db),runDueAgentSchedules(db),runDueResearchSources(db)]);}
  catch(error){console.error('Worker control-plane cycle failed',error);}
  finally{running=false;}
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
let linkedinRunning=false;
async function linkedinCycle():Promise<void>{
  if(linkedinRunning||draining||!runtime.linkedinLocalWorker.enabled)return;
  linkedinRunning=true;
  // Neither call throws -- a missing optional playwright, a browser that will
  // not open and a halted batch are all outcomes they report. This catch is
  // for the case they are wrong about that.
  try{
    await runPendingSeatDetectRequests(db,runtime.linkedinLocalWorker);
    await runDueLinkedInActions(db,runtime.linkedinLocalWorker);
    // THE SEND QUEUE FIRST, THE REST AFTER, and the order is the point: the
    // invite/DM/reply/engagement queue is the only work with a paced SLOT
    // attached, so it must not sit behind an inbox walk that can take minutes.
    // Everything below is periodic maintenance -- reading what came back,
    // reconciling LinkedIn's own pending-invite list, draining the withdrawal
    // queue, walking a lead source -- and none of it has a deadline.
    //
    // Keyed on the SEAT table rather than on due actions: a workspace with an
    // empty send queue still has an inbox to read and a backlog to reconcile,
    // which is exactly the state this work exists to get it out of.
    // `runLinkedInSideTasks` catches each job on its own and opens no browser
    // where it cannot, so a workspace this process may not serve costs a
    // readiness probe and nothing else.
    for(const workspaceId of await linkedinWorkspaceIds(db)){
      await runLinkedInSideTasks(db,runtime.linkedinLocalWorker,{workspaceId});
    }
  }
  catch(error){console.error('LinkedIn local worker cycle failed',error);}
  finally{linkedinRunning=false;}
}
await cycle();
const timer=setInterval(()=>void cycle(),runtime.automationIntervalMs);timer.unref();
const linkedinTimer=setInterval(()=>void linkedinCycle(),runtime.automationIntervalMs);linkedinTimer.unref();

async function shutdown(signal:string){
  if(draining)return;
  draining=true;
  console.log(`${signal} received; draining worker`);
  clearInterval(timer);
  clearInterval(linkedinTimer);
  const deadline=Date.now()+DRAIN_TIMEOUT_MS;
  while((running||linkedinRunning)&&Date.now()<deadline)await new Promise((resolve)=>setTimeout(resolve,200));
  if(running)console.error(`Worker still mid-cycle after ${DRAIN_TIMEOUT_MS}ms; exiting anyway. Any agent run left in flight is written off by the next worker's reap.`);
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
  await temporalWorker?.shutdown();
  // Before the pool closes: a browser left open outlives this process and
  // holds the operator's profile directory locked, so the next worker cannot
  // attach to it.
  await closeLinkedInBrowser();
  await db.close();
  process.exit(0);
}
process.on('SIGINT',()=>void shutdown('SIGINT'));
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
