import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Db } from '../db.js';
import { id } from '../db.js';
import type { CommunityModuleManifest } from '../registry/service.js';
import type { SkillEvidence, SkillRun } from '../skills/types.js';

export interface InstalledCommunityModule {
  id: string;
  version: string;
  name: string;
  description: string;
  runtime: CommunityModuleManifest['runtime'];
  artifactRef: string;
  artifactDigest: string;
  manifest: CommunityModuleManifest;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sideEffect: CommunityModuleManifest['sideEffect'];
  requiresApproval: boolean;
  config: Record<string, unknown>;
}

export async function runCommunityModule(
  db: Db,
  module: InstalledCommunityModule,
  input: unknown,
  context: { workspaceId: string; actorType: 'agent' | 'user'; actorId: string | null }
): Promise<SkillRun> {
  const inputValidator = compileSchema(module.inputSchema, `${module.id} input`);
  if (!inputValidator(input)) throw new Error(formatValidationError(`${module.id} input`,inputValidator));

  assertGrantedPermissions(module);
  const startedAt = new Date();
  let status: 'ok' | 'error' = 'ok';
  let output: unknown = null;
  let error: string | null = null;
  try {
    output = await executeSandboxRelease(module,input,context,{ isolated: false });
    const outputValidator = compileSchema(module.outputSchema, `${module.id} output`);
    if (!outputValidator(output)) {
      status='error';
      error=formatValidationError(`${module.id} output`,outputValidator);
    }
  } catch (cause) {
    status='error';
    error=cause instanceof Error?cause.message:String(cause);
  }
  const finishedAt = new Date();
  const evidence = status==='ok'?extractEvidence(output):[];
  const runId=id('run');
  const durationMs=Math.max(0,finishedAt.getTime()-startedAt.getTime());
  await db.prepare(`
    INSERT INTO skill_runs (
      id,skill_id,skill_version,workspace_id,status,input_json,output_json,error,evidence_json,
      started_at,finished_at,duration_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    runId,module.id,module.version,context.workspaceId,status,JSON.stringify(input),
    output===undefined?null:JSON.stringify(output),error,JSON.stringify(evidence),
    startedAt.toISOString(),finishedAt.toISOString(),durationMs
  );
  return {
    id:runId,skillId:module.id,skillVersion:module.version,workspaceId:context.workspaceId,status,
    input,output,error,evidence,startedAt:startedAt.toISOString(),finishedAt:finishedAt.toISOString(),durationMs
  };
}

export async function executeSandboxRelease(
  module: InstalledCommunityModule,
  input: unknown,
  context: { workspaceId: string; actorType: 'agent' | 'user'; actorId: string | null },
  options: { isolated: boolean }
): Promise<unknown> {
  const gateway = process.env.TREVRA_SANDBOX_GATEWAY_URL?.trim();
  if (!options.isolated && gateway) return executeRemoteSandbox(gateway,module,input,context);
  if (!options.isolated && module.manifest.permissions.network.length>0) {
    throw new Error(`Module ${module.id} requests network access and requires TREVRA_SANDBOX_GATEWAY_URL`);
  }
  if (module.runtime==='remote') {
    if (!options.isolated) throw new Error('Remote modules require TREVRA_SANDBOX_GATEWAY_URL');
    return executeRemoteArtifact(module,input);
  }
  if (module.runtime==='oci') return executeOci(module,input);
  if (module.runtime==='wasi') return executeWasi(module,input);
  throw new Error(`Unsupported community runtime: ${module.runtime}`);
}

async function executeRemoteSandbox(
  gateway: string,
  module: InstalledCommunityModule,
  input: unknown,
  context: { workspaceId: string; actorType: 'agent' | 'user'; actorId: string | null }
): Promise<unknown> {
  const url=new URL('/v1/execute',gateway);
  if (process.env.NODE_ENV==='production'&&url.protocol!=='https:') throw new Error('Sandbox gateway must use HTTPS in production');
  const token=process.env.TREVRA_SANDBOX_GATEWAY_TOKEN?.trim();
  if (!token) throw new Error('TREVRA_SANDBOX_GATEWAY_TOKEN is required with the remote sandbox');
  const response=await fetch(url,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({
      module:{id:module.id,version:module.version,runtime:module.runtime,artifactRef:module.artifactRef,
        artifactDigest:module.artifactDigest,entrypoint:module.manifest.entrypoint,permissions:module.manifest.permissions,
        resources:module.manifest.resources},
      context:{workspaceId:context.workspaceId,actorType:context.actorType,actorId:context.actorId},input
    }),signal:AbortSignal.timeout(module.manifest.resources.timeoutSeconds*1000+5_000)
  });
  const body=await response.json().catch(()=>({error:response.statusText})) as {output?:unknown;error?:string};
  if (!response.ok) throw new Error(body.error??`Sandbox gateway failed with ${response.status}`);
  return body.output;
}

async function executeRemoteArtifact(module: InstalledCommunityModule,input:unknown):Promise<unknown>{
  const target=new URL(module.artifactRef);
  if(target.protocol!=='https:')throw new Error('Remote module artifact must use HTTPS');
  if(!module.manifest.permissions.network.includes(target.hostname))throw new Error(`Remote module host ${target.hostname} is not in the signed network allowlist`);
  if(module.manifest.permissions.secrets.length)throw new Error('Remote community modules with secret permissions require a dedicated secret broker');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),module.manifest.resources.timeoutSeconds*1000);
  try{
    const response=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json','X-Trevra-Module':`${module.id}@${module.version}`},body:JSON.stringify(input),redirect:'error',signal:controller.signal});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>module.manifest.resources.maxOutputBytes)throw new Error('Remote module output exceeded the declared limit');
    if(!response.ok)throw new Error(`Remote module returned ${response.status}: ${bytes.toString('utf8').slice(0,2000)}`);
    try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Remote module output must be one JSON value');}
  }finally{clearTimeout(timer);}
}

async function executeOci(module: InstalledCommunityModule,input:unknown):Promise<unknown>{
  if (!module.artifactRef.includes(`@${module.artifactDigest}`)) {
    throw new Error('OCI artifact ref must be digest-pinned and match the signed artifact digest');
  }
  const runtime=process.env.TREVRA_CONTAINER_RUNTIME?.trim()||'docker';
  const args=[
    'run','--rm','-i','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--pids-limit','64','--user','65532:65532',
    '--memory',`${module.manifest.resources.memoryMb}m`,'--cpus',String(module.manifest.resources.cpu),
    '--tmpfs','/tmp:rw,noexec,nosuid,size=16m',module.artifactRef,...module.manifest.entrypoint
  ];
  return runJsonProcess(runtime,args,input,module.manifest.resources.timeoutSeconds,module.manifest.resources.maxOutputBytes);
}

async function executeWasi(module: InstalledCommunityModule,input:unknown):Promise<unknown>{
  const artifactUrl=new URL(module.artifactRef,'file:///');
  if (artifactUrl.protocol!=='file:') throw new Error('Local WASI modules must use an absolute file path');
  const bytes=await readFile(artifactUrl);
  const actual=`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual!==module.artifactDigest) throw new Error('WASI artifact digest does not match the signed release');
  const runtime=process.env.TREVRA_WASI_RUNTIME?.trim()||'wasmtime';
  const args=['run',artifactUrl.pathname,...module.manifest.entrypoint];
  return runJsonProcess(runtime,args,input,module.manifest.resources.timeoutSeconds,module.manifest.resources.maxOutputBytes);
}

function runJsonProcess(command:string,args:string[],input:unknown,timeoutSeconds:number,maxOutputBytes:number):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??''},shell:false,windowsHide:true});
    const stdout:Buffer[]=[];const stderr:Buffer[]=[];let outputBytes=0;let settled=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error(`Sandbox exceeded ${timeoutSeconds}s timeout`));},timeoutSeconds*1000);
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    child.on('error',(error)=>finish(new Error(`Sandbox runtime failed to start: ${error.message}`)));
    child.stdout.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>maxOutputBytes){child.kill('SIGKILL');finish(new Error('Sandbox output exceeded the declared limit'));return;}stdout.push(Buffer.from(chunk));});
    child.stderr.on('data',(chunk:Buffer)=>{if(Buffer.concat(stderr).length<64_000)stderr.push(Buffer.from(chunk));});
    child.on('close',(code)=>{
      if(settled)return;
      if(code!==0)return finish(new Error(`Sandbox exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0,2000)}`));
      const raw=Buffer.concat(stdout).toString('utf8').trim();
      try{finish(undefined,JSON.parse(raw));}catch{finish(new Error('Sandbox output must be one JSON value'));}
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function assertGrantedPermissions(module:InstalledCommunityModule):void{
  const requested=module.manifest.permissions.secrets;
  const configured=Array.isArray(module.config.grantedSecrets)?module.config.grantedSecrets.filter((item):item is string=>typeof item==='string'):[];
  const missing=requested.filter((name)=>!configured.includes(name));
  if(missing.length)throw new Error(`Module ${module.id} is missing explicit secret grants: ${missing.join(', ')}`);
  if(module.sideEffect==='external-write')throw new Error(`Community module ${module.id} declares external-write and must use a dedicated Trevra action adapter`);
}

function compileSchema(schema:Record<string,unknown>,label:string):ValidateFunction{
  try{return new Ajv({strict:false,allErrors:true,allowUnionTypes:true}).compile(schema);}
  catch(error){throw new Error(`${label} schema is invalid: ${error instanceof Error?error.message:String(error)}`);}
}
function formatValidationError(label:string,validator:ValidateFunction):string{
  return `${label} validation failed: ${(validator.errors??[]).map((item)=>`${item.instancePath||'/'} ${item.message??'is invalid'}`).join('; ')}`;
}
function extractEvidence(output:unknown):SkillEvidence[]{
  if(typeof output!=='object'||output===null)return[];
  const evidence=(output as {evidence?:unknown}).evidence;
  if(!Array.isArray(evidence))return[];
  return evidence.filter((item):item is SkillEvidence=>typeof item==='object'&&item!==null&&typeof (item as {label?:unknown}).label==='string'&&typeof (item as {detail?:unknown}).detail==='string');
}
