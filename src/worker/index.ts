import 'dotenv/config';
import express from 'express';
import { openDatabase } from '../server/db.js';
import { runAllAutomationCycles } from '../server/automation-service.js';
import { runReadyPlaybooks } from '../server/playbooks/engine.js';
import { runCommercialProjectionCycle } from '../server/projections/commercial.js';
import { orchestrationMode } from '../server/orchestration/client.js';
import { validateEnvironment } from '../server/config.js';

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

let running=false;
async function cycle():Promise<void>{
  if(running)return;
  running=true;
  try{await Promise.all([runAllAutomationCycles(db),runReadyPlaybooks(db),runCommercialProjectionCycle(db)]);}
  catch(error){console.error('Worker control-plane cycle failed',error);}
  finally{running=false;}
}
await cycle();
const timer=setInterval(()=>void cycle(),runtime.automationIntervalMs);timer.unref();

async function shutdown(signal:string){
  console.log(`${signal} received; shutting down worker`);
  clearInterval(timer);
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
  await temporalWorker?.shutdown();
  await db.close();
  process.exit(0);
}
process.on('SIGINT',()=>void shutdown('SIGINT'));
process.on('SIGTERM',()=>void shutdown('SIGTERM'));
