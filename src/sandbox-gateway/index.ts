import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { communityModuleManifestSchema } from '../server/registry/service.js';
import { executeSandboxRelease, type InstalledCommunityModule } from '../server/sandbox/community-runtime.js';
import { executeKubernetesOciModule } from './kubernetes.js';

const token = process.env.TREVRA_SANDBOX_GATEWAY_TOKEN?.trim() ?? '';
if (token.length < 32) throw new Error('TREVRA_SANDBOX_GATEWAY_TOKEN must contain at least 32 characters');
const port = Number(process.env.PORT ?? process.env.TREVRA_SANDBOX_GATEWAY_PORT ?? 43987);
const requestSchema = z.object({
  module: z.object({
    id: z.string(),version:z.string(),runtime:z.enum(['oci','wasi','remote']),artifactRef:z.string(),artifactDigest:z.string(),
    entrypoint:z.array(z.string()).default([]),permissions:z.record(z.unknown()),resources:z.record(z.unknown())
  }),
  context: z.object({ workspaceId:z.string(),actorType:z.enum(['agent','user']),actorId:z.string().nullable() }),
  input: z.unknown()
});

const app=express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({limit:'2mb'}));
app.use(rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false}));
app.get('/health',(_req,res)=>res.json({ok:true,service:'trevra-sandbox-gateway'}));
app.post('/v1/execute',async(req,res)=>{
  if(!authorized(req.header('authorization')))return res.status(401).json({error:'Valid sandbox gateway token required'});
  try{
    const request=requestSchema.parse(req.body);
    const manifest=communityModuleManifestSchema.parse({
      id:request.module.id,version:request.module.version,name:request.module.id,description:'Signed Trevra community module',
      runtime:request.module.runtime,artifact:{ref:request.module.artifactRef,digest:request.module.artifactDigest},
      entrypoint:request.module.entrypoint,sideEffect:'none',requiresApproval:false,
      permissions:request.module.permissions,resources:request.module.resources,
      inputSchema:{},outputSchema:{},source:{repository:'https://invalid.local/repository',commit:'0000000',license:'UNKNOWN'}
    });
    const module:InstalledCommunityModule={
      id:manifest.id,version:manifest.version,name:manifest.name,description:manifest.description,runtime:manifest.runtime,
      artifactRef:manifest.artifact.ref,artifactDigest:manifest.artifact.digest,manifest,inputSchema:{},outputSchema:{},
      sideEffect:manifest.sideEffect,requiresApproval:false,config:{grantedSecrets:[]}
    };
    const output=process.env.TREVRA_SANDBOX_BACKEND==='kubernetes' && module.runtime==='oci'
      ? await executeKubernetesOciModule(module,request.input)
      : await executeSandboxRelease(module,request.input,request.context,{isolated:true});
    res.json({output});
  }catch(error){res.status(400).json({error:error instanceof Error?error.message:String(error)});}
});
const server=app.listen(port,()=>console.log(`Trevra sandbox gateway listening on http://localhost:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));

function authorized(header:string|undefined):boolean{
  const supplied=header?.match(/^Bearer\s+(.+)$/i)?.[1]??'';
  const left=createHash('sha256').update(supplied).digest();
  const right=createHash('sha256').update(token).digest();
  return timingSafeEqual(left,right);
}
