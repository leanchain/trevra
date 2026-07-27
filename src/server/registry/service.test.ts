import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import { runSkill } from '../skills/runner.js';
import { runCommunityModule } from '../sandbox/community-runtime.js';
import { runCommercialProjectionCycle, listCommercialProjections } from '../projections/commercial.js';
import {
  createModulePublisher,
  getInstalledCommunityModule,
  installModuleRelease,
  listPublicRegistryModules,
  moduleReleaseSigningPayload,
  publishModuleRelease
} from './service.js';

let db: Db | undefined;
let gateway: Server | undefined;
afterEach(async () => {
  await db?.close(); db=undefined;
  await new Promise<void>((resolve)=>gateway?.close(()=>resolve())??resolve()); gateway=undefined;
  delete process.env.TREVRA_SANDBOX_GATEWAY_URL;
  delete process.env.TREVRA_SANDBOX_GATEWAY_TOKEN;
});

async function openRegistryDb():Promise<Db>{
  db=await openDatabase({connectionString:process.env.TEST_DATABASE_URL,seedDemo:false});
  await resetDemoData(db);
  return db;
}

describe('hosted module registry',()=>{
  it('publishes privacy-safe popularity from actual module runs',async()=>{
    const database=await openRegistryDb();
    const before=(await listPublicRegistryModules(database)).find((item)=>item.id==='gtm.score-lead')!.popularity.totalRuns;
    await runSkill('gtm.score-lead',{lead:{platform:'shopify',vertical:'footwear',catalogSize:100}},{db:database,workspaceId:DEMO_WORKSPACE_ID,now:()=>new Date()});
    await runSkill('gtm.score-lead',{lead:{platform:'other'}},{db:database,workspaceId:DEMO_WORKSPACE_ID,now:()=>new Date()});
    const module=(await listPublicRegistryModules(database)).find((item)=>item.id==='gtm.score-lead');
    expect(module?.popularity.totalRuns).toBe(before+2);
    expect(module?.popularity.successRate).toBe(1);
    expect(JSON.stringify(module)).not.toContain(DEMO_WORKSPACE_ID);
  });

  it('verifies Ed25519 releases, installs them, and runs through the isolated gateway',async()=>{
    const database=await openRegistryDb();
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    const publisher=await createModulePublisher(database,{
      workspaceId:DEMO_WORKSPACE_ID,userId:DEMO_USER_ID,slug:`test-${Date.now()}`,
      displayName:'Test Publisher',publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString()
    });
    const manifest={
      id:`test.remote-${Date.now()}`,version:'1.0.0',name:'Remote test',description:'Exercise signed sandbox execution.',
      runtime:'remote' as const,artifact:{ref:'https://module.example/execute',digest:`sha256:${'a'.repeat(64)}`},entrypoint:[],
      sideEffect:'none' as const,requiresApproval:false,
      permissions:{network:['module.example'],secrets:[],filesystem:'none' as const},
      resources:{timeoutSeconds:5,memoryMb:64,cpu:0.25,maxOutputBytes:10000},
      inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},
      outputSchema:{type:'object',properties:{doubled:{type:'number'}},required:['doubled'],additionalProperties:false},
      source:{repository:'https://example.com/test/module',commit:'abcdef1',license:'MIT'}
    };
    const sbom={bomFormat:'CycloneDX',specVersion:'1.5',components:[]};
    const signature=sign(null,Buffer.from(moduleReleaseSigningPayload(manifest,sbom)),privateKey).toString('base64');
    await publishModuleRelease(database,{workspaceId:DEMO_WORKSPACE_ID,userId:DEMO_USER_ID,publisherId:publisher.id,manifest,signature,sbom});
    await installModuleRelease(database,{workspaceId:DEMO_WORKSPACE_ID,userId:DEMO_USER_ID,moduleId:manifest.id,version:manifest.version});
    const installed=await getInstalledCommunityModule(database,DEMO_WORKSPACE_ID,manifest.id);
    expect(installed?.publisher.keyFingerprint).toBe(publisher.keyFingerprint);

    gateway=createServer((req,res)=>{
      const chunks:Buffer[]=[];req.on('data',(chunk)=>chunks.push(Buffer.from(chunk)));
      req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));res.setHeader('content-type','application/json');res.end(JSON.stringify({output:{doubled:body.input.value*2}}));});
    });
    await new Promise<void>((resolve)=>gateway!.listen(0,'127.0.0.1',resolve));
    const address=gateway.address();if(!address||typeof address==='string')throw new Error('gateway did not bind');
    process.env.TREVRA_SANDBOX_GATEWAY_URL=`http://127.0.0.1:${address.port}`;
    process.env.TREVRA_SANDBOX_GATEWAY_TOKEN='sandbox-test-token-with-more-than-32-characters';
    const run=await runCommunityModule(database,installed!,{value:21},{workspaceId:DEMO_WORKSPACE_ID,actorType:'user',actorId:DEMO_USER_ID});
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({doubled:42});
    const publicModule=(await listPublicRegistryModules(database)).find((item)=>item.id===manifest.id);
    expect(publicModule?.popularity.totalRuns).toBe(1);
    expect(publicModule?.popularity.activeInstallations).toBe(1);
    expect(publicModule?.publisher.reputationScore).toBeGreaterThan(0);
  });
});

describe('commercial projections',()=>{
  it('rebuilds current commercial state from append-only entity events',async()=>{
    const database=await openRegistryDb();
    expect(await runCommercialProjectionCycle(database,5000)).toBeGreaterThan(0);
    const initial=(await listCommercialProjections(database,DEMO_WORKSPACE_ID,{entityType:'clients'})).find((item)=>item.entityId==='cl_acme');
    expect(initial?.state.name).toBe('Acme Labs');
    await database.prepare('UPDATE clients SET name=? WHERE id=?').run('Acme Labs Updated','cl_acme');
    await runCommercialProjectionCycle(database,5000);
    const updated=(await listCommercialProjections(database,DEMO_WORKSPACE_ID,{entityType:'clients'})).find((item)=>item.entityId==='cl_acme');
    expect(updated?.state.name).toBe('Acme Labs Updated');
    expect(updated!.entityVersion).toBeGreaterThan(initial!.entityVersion);
  });
});
