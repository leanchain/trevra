import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Db } from '../server/db.js';
import { loadExecutableRelease } from '../server/registry/service.js';
import { executeSandboxRelease } from '../server/sandbox/community-runtime.js';
import { executeKubernetesOciModule } from './kubernetes.js';

/**
 * The gateway executes releases the REGISTRY vouches for, never the one the
 * request describes.
 *
 * It used to do the opposite. `requestSchema` accepted `artifactRef`,
 * `artifactDigest`, `entrypoint`, `permissions` and `resources` straight off the
 * request body, fed them to `communityModuleManifestSchema.parse` to produce a
 * manifest-shaped object that no publisher had ever signed, hardcoded
 * `sideEffect:'none'` so the external-write refusal could never fire, and took
 * `context.workspaceId` as whatever string arrived. The single deployment-wide
 * bearer token was the only thing between a caller and running an arbitrary
 * container image, with arbitrary network and secret grants, attributed to any
 * tenant on the platform.
 *
 * Now the body supplies exactly three things that are not trusted, only used as
 * lookup keys: which module, which version, and which workspace. Everything that
 * decides what actually runs -- artifact, digest, entrypoint, permissions,
 * resource ceilings, side effect -- comes from `loadExecutableRelease`, which
 * refuses unless that workspace has the release installed and enabled, the
 * release is `verified`, and its stored signature still verifies against its
 * stored manifest. A forged manifest is not rejected so much as ignored: it is
 * never read.
 *
 * The bearer token remains what it always was -- proof that the caller is this
 * deployment's control plane, not proof of tenancy. It is deliberately no longer
 * load-bearing for isolation: with the registry lookup in place, a leaked token
 * buys an attacker the ability to re-run modules a tenant already installed, not
 * the ability to invent one. Per-tenant gateway credentials would narrow it
 * further and are the obvious next step; they are not what stood between tenants
 * here.
 */
const requestSchema = z.object({
  // `.passthrough()` on purpose: the in-process caller in
  // `sandbox/community-runtime.ts` still sends the full module descriptor over
  // the wire. Those fields are accepted and then thrown away rather than
  // rejected, so an older control plane keeps working -- but nothing below ever
  // reads them, which is the entire point.
  module: z.object({ id: z.string().min(1), version: z.string().min(1) }).passthrough(),
  context: z.object({ workspaceId: z.string().min(1), actorType: z.enum(['agent','user']), actorId: z.string().nullable() }),
  input: z.unknown()
});

export function createSandboxGatewayApp(db: Db, token: string): Express {
  const app=express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({limit:'2mb'}));
  app.use(rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false}));
  app.get('/health',(_req,res)=>res.json({ok:true,service:'trevra-sandbox-gateway'}));
  app.post('/v1/execute',async(req,res)=>{
    if(!authorized(req.header('authorization'),token))return res.status(401).json({error:'Valid sandbox gateway token required'});
    let request:z.infer<typeof requestSchema>;
    try{request=requestSchema.parse(req.body);}
    catch(error){return res.status(400).json({error:error instanceof Error?error.message:String(error)});}

    // Separated from execution failures on purpose. A 403 here means "this
    // workspace may not run this release", which is an authorization answer and
    // must not be confusable with "the module crashed".
    let module;
    try{
      module=await loadExecutableRelease(db,{
        workspaceId:request.context.workspaceId,moduleId:request.module.id,version:request.module.version
      });
    }catch(error){return res.status(403).json({error:error instanceof Error?error.message:String(error)});}

    try{
      const output=process.env.TREVRA_SANDBOX_BACKEND==='kubernetes' && module.runtime==='oci'
        ? await executeKubernetesOciModule(module,request.input)
        : await executeSandboxRelease(module,request.input,request.context,{isolated:true});
      res.json({output});
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:String(error)});}
  });
  return app;
}

function authorized(header:string|undefined,token:string):boolean{
  const supplied=header?.match(/^Bearer\s+(.+)$/i)?.[1]??'';
  const left=createHash('sha256').update(supplied).digest();
  const right=createHash('sha256').update(token).digest();
  return timingSafeEqual(left,right);
}

async function start():Promise<void>{
  const token = process.env.TREVRA_SANDBOX_GATEWAY_TOKEN?.trim() ?? '';
  if (token.length < 32) throw new Error('TREVRA_SANDBOX_GATEWAY_TOKEN must contain at least 32 characters');
  const port = Number(process.env.PORT ?? process.env.TREVRA_SANDBOX_GATEWAY_PORT ?? 43987);
  // The gateway needs the registry, so it needs the database. It is the same
  // schema the control plane uses and `openDatabase` is idempotent, so sharing
  // it costs nothing; what it buys is that no execution can happen without a
  // matching installation row.
  const { openDatabase } = await import('../server/db.js');
  const db = await openDatabase();
  const server=createSandboxGatewayApp(db,token).listen(port,()=>console.log(`Trevra sandbox gateway listening on http://localhost:${port}`));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>{void db.close().finally(()=>process.exit(0));}));
}

// Only when this file IS the process, so tests (and anything else that wants the
// app without a listener or a live database) can import the factory above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
