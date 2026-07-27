import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { id } from '../db.js';
import { stableJson } from '../control-plane/payload.js';

const moduleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,119}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const jsonSchemaSchema = z.record(z.unknown());
const sbomSchema = z.union([
  z.object({ bomFormat: z.literal('CycloneDX'), specVersion: z.string().min(1), components: z.array(z.unknown()).default([]) }).passthrough(),
  z.object({ spdxVersion: z.string().min(1), packages: z.array(z.unknown()).default([]) }).passthrough()
]);

export const communityModuleManifestSchema = z.object({
  id: moduleIdSchema,
  version: versionSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000),
  runtime: z.enum(['oci', 'wasi', 'remote']),
  artifact: z.object({
    ref: z.string().trim().min(1).max(2_000),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  }),
  entrypoint: z.array(z.string().max(500)).max(20).default([]),
  sideEffect: z.enum(['none', 'network-read', 'external-write']),
  requiresApproval: z.boolean().default(false),
  permissions: z.object({
    network: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/)).max(30).default([]),
    filesystem: z.enum(['none', 'read-only']).default('none')
  }).default({ network: [], secrets: [], filesystem: 'none' }),
  resources: z.object({
    timeoutSeconds: z.number().int().min(1).max(300).default(30),
    memoryMb: z.number().int().min(32).max(2_048).default(256),
    cpu: z.number().positive().max(4).default(0.5),
    maxOutputBytes: z.number().int().min(1_024).max(10_000_000).default(1_000_000)
  }).default({ timeoutSeconds: 30, memoryMb: 256, cpu: 0.5, maxOutputBytes: 1_000_000 }),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
  source: z.object({
    repository: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{7,64}$/i),
    license: z.string().trim().min(1).max(100)
  })
});

export type CommunityModuleManifest = z.infer<typeof communityModuleManifestSchema>;

export interface ModulePopularity {
  moduleId: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number | null;
  uniqueWorkspaces: number;
  activeInstallations: number;
  lastRunAt: string | null;
  popularityRank: number;
}


export async function listPublicModulePopularity(db: Db): Promise<ModulePopularity[]> {
  const rows = await db.prepare(`
    SELECT module_id,total_runs,successful_runs,failed_runs,unique_workspaces,
      active_installations,last_run_at,
      DENSE_RANK() OVER (ORDER BY total_runs DESC,active_installations DESC,module_id ASC) AS popularity_rank
    FROM module_usage_metrics
    ORDER BY total_runs DESC,active_installations DESC,module_id ASC
  `).all<Record<string, unknown>>();
  return rows.map((row) => {
    const total = Number(row.total_runs ?? 0);
    const successful = Number(row.successful_runs ?? 0);
    return {
      moduleId: String(row.module_id),
      totalRuns: total,
      successfulRuns: successful,
      failedRuns: Number(row.failed_runs ?? 0),
      successRate: total > 0 ? Number((successful / total).toFixed(4)) : null,
      uniqueWorkspaces: Number(row.unique_workspaces ?? 0),
      activeInstallations: Number(row.active_installations ?? 0),
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
      popularityRank: Number(row.popularity_rank ?? 0)
    };
  });
}

export async function createModulePublisher(
  db: Db,
  input: { workspaceId: string; userId: string; slug: string; displayName: string; publicKeyPem: string }
) {
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/).parse(input.slug.trim().toLowerCase());
  const displayName = z.string().trim().min(1).max(120).parse(input.displayName);
  const key = createPublicKey(input.publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must be an Ed25519 public key');
  const publicKeyPem = key.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  const publisherId = id('pub');
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO module_publishers (
      id,owner_workspace_id,owner_user_id,slug,display_name,public_key_pem,key_fingerprint,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(publisherId,input.workspaceId,input.userId,slug,displayName,publicKeyPem,fingerprint,now,now);
  return { id: publisherId, slug, displayName, keyFingerprint: fingerprint, verified: false, reputationScore: 0, createdAt: now };
}

export function moduleReleaseSigningPayload(manifest: CommunityModuleManifest, sbom: Record<string, unknown>): string {
  return stableJson({
    schemaVersion: '1.0.0',
    manifest,
    sbomDigest: `sha256:${createHash('sha256').update(stableJson(sbom)).digest('hex')}`
  });
}

export async function publishModuleRelease(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    publisherId: string;
    manifest: unknown;
    signature: string;
    sbom: unknown;
  }
) {
  const manifest = communityModuleManifestSchema.parse(input.manifest);
  const sbom = sbomSchema.parse(input.sbom) as Record<string, unknown>;
  const publisher = await db.prepare(`
    SELECT * FROM module_publishers WHERE id=? AND owner_workspace_id=?
  `).get<Record<string, unknown>>(input.publisherId,input.workspaceId);
  if (!publisher) throw new Error('Publisher not found for this workspace');
  const signingPayload = moduleReleaseSigningPayload(manifest,sbom);
  let signature: Buffer;
  try { signature = Buffer.from(input.signature,'base64'); }
  catch { throw new Error('Signature must be base64'); }
  const verified = verify(null,Buffer.from(signingPayload),createPublicKey(String(publisher.public_key_pem)),signature);
  if (!verified) throw new Error('Module release signature is invalid');

  const payloadHash = createHash('sha256').update(signingPayload).digest('hex');
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO module_packages (
        module_id,publisher_id,source_type,name,description,visibility,latest_version,created_at,updated_at
      ) VALUES (?,?, 'community',?,?, 'public',?,?,?)
      ON CONFLICT (module_id) DO UPDATE SET
        name=excluded.name,description=excluded.description,latest_version=excluded.latest_version,updated_at=excluded.updated_at
      WHERE module_packages.publisher_id=excluded.publisher_id
    `).run(manifest.id,input.publisherId,manifest.name,manifest.description,manifest.version,now,now);
    const owner = await tx.prepare('SELECT publisher_id FROM module_packages WHERE module_id=?')
      .get<{ publisher_id: string | null }>(manifest.id);
    if (owner?.publisher_id !== input.publisherId) throw new Error('Module id is owned by another publisher');
    await tx.prepare(`
      INSERT INTO module_releases (
        module_id,version,runtime,artifact_ref,artifact_digest,manifest_json,permissions_json,
        input_schema_json,output_schema_json,side_effect,requires_approval,signature,
        signature_payload_hash,sbom_json,status,published_by_user_id,published_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      manifest.id,manifest.version,manifest.runtime,manifest.artifact.ref,manifest.artifact.digest,
      JSON.stringify(manifest),JSON.stringify(manifest.permissions),JSON.stringify(manifest.inputSchema),
      JSON.stringify(manifest.outputSchema),manifest.sideEffect,manifest.requiresApproval,input.signature,
      payloadHash,JSON.stringify(sbom),'verified',input.userId,now
    );
    await tx.prepare(`
      INSERT INTO module_usage_metrics (module_id,updated_at) VALUES (?,?)
      ON CONFLICT (module_id) DO NOTHING
    `).run(manifest.id,now);
  });
  return { moduleId: manifest.id, version: manifest.version, status: 'verified', signaturePayloadHash: payloadHash, publishedAt: now };
}

export async function installModuleRelease(
  db: Db,
  input: { workspaceId: string; userId: string; moduleId: string; version: string; config?: Record<string, unknown> }
) {
  const release = await db.prepare(`
    SELECT r.*,p.source_type FROM module_releases r JOIN module_packages p ON p.module_id=r.module_id
    WHERE r.module_id=? AND r.version=? AND r.status='verified'
  `).get<Record<string, unknown>>(input.moduleId,input.version);
  if (!release) throw new Error('Verified module release not found');
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO workspace_module_installations (
        workspace_id,module_id,version,installed_by_user_id,enabled,config_json,installed_at,updated_at
      ) VALUES (?,?,?,?,TRUE,?,?,?)
      ON CONFLICT (workspace_id,module_id) DO UPDATE SET
        version=excluded.version,installed_by_user_id=excluded.installed_by_user_id,
        enabled=TRUE,config_json=excluded.config_json,updated_at=excluded.updated_at
    `).run(input.workspaceId,input.moduleId,input.version,input.userId,JSON.stringify(input.config ?? {}),now,now);
  });
  return { moduleId: input.moduleId, version: input.version, enabled: true, installedAt: now };
}

export async function uninstallModuleRelease(db: Db, workspaceId: string, moduleId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM workspace_module_installations WHERE workspace_id=? AND module_id=?')
    .run(workspaceId,moduleId);
  return result.changes > 0;
}

export async function getInstalledCommunityModule(db: Db, workspaceId: string, moduleId: string) {
  const row = await db.prepare(`
    SELECT i.workspace_id,i.module_id,i.version,i.config_json,
      r.runtime,r.artifact_ref,r.artifact_digest,r.manifest_json,r.permissions_json,
      r.input_schema_json,r.output_schema_json,r.side_effect,r.requires_approval,r.sbom_json,
      p.name,p.description,p.publisher_id,mp.slug AS publisher_slug,mp.key_fingerprint,mp.verified AS publisher_verified
    FROM workspace_module_installations i
    JOIN module_releases r ON r.module_id=i.module_id AND r.version=i.version
    JOIN module_packages p ON p.module_id=i.module_id
    LEFT JOIN module_publishers mp ON mp.id=p.publisher_id
    WHERE i.workspace_id=? AND i.module_id=? AND i.enabled=TRUE AND r.status='verified'
  `).get<Record<string, unknown>>(workspaceId,moduleId);
  return row ? serializeInstalledModule(row) : null;
}

export async function listWorkspaceCommunityModules(db: Db, workspaceId: string) {
  const rows = await db.prepare(`
    SELECT i.workspace_id,i.module_id,i.version,i.config_json,
      r.runtime,r.artifact_ref,r.artifact_digest,r.manifest_json,r.permissions_json,
      r.input_schema_json,r.output_schema_json,r.side_effect,r.requires_approval,r.sbom_json,
      p.name,p.description,p.publisher_id,mp.slug AS publisher_slug,mp.key_fingerprint,mp.verified AS publisher_verified
    FROM workspace_module_installations i
    JOIN module_releases r ON r.module_id=i.module_id AND r.version=i.version
    JOIN module_packages p ON p.module_id=i.module_id
    LEFT JOIN module_publishers mp ON mp.id=p.publisher_id
    WHERE i.workspace_id=? AND i.enabled=TRUE AND r.status='verified'
    ORDER BY i.module_id
  `).all<Record<string, unknown>>(workspaceId);
  return rows.map(serializeInstalledModule);
}

export async function listPublicRegistryModules(db: Db) {
  const rows = await db.prepare(`
    SELECT p.module_id,p.name,p.description,p.source_type,p.latest_version,p.publisher_id,
      pub.slug AS publisher_slug,pub.display_name AS publisher_name,pub.verified AS publisher_verified,
      pub.key_fingerprint,pub.public_key_pem,pub.reputation_score,
      r.runtime,r.artifact_digest,r.side_effect,r.requires_approval,r.manifest_json,r.sbom_json,r.signature,r.signature_payload_hash,r.published_at,
      COALESCE(m.total_runs,0) AS total_runs,COALESCE(m.successful_runs,0) AS successful_runs,
      COALESCE(m.failed_runs,0) AS failed_runs,COALESCE(m.unique_workspaces,0) AS unique_workspaces,
      COALESCE(m.active_installations,0) AS active_installations,m.last_run_at,
      DENSE_RANK() OVER (ORDER BY COALESCE(m.total_runs,0) DESC,COALESCE(m.active_installations,0) DESC,p.module_id) AS popularity_rank
    FROM module_packages p
    LEFT JOIN module_publishers pub ON pub.id=p.publisher_id
    LEFT JOIN module_releases r ON r.module_id=p.module_id AND r.version=p.latest_version
    LEFT JOIN module_usage_metrics m ON m.module_id=p.module_id
    WHERE p.visibility='public' AND (r.status='verified' OR p.source_type='builtin')
    ORDER BY COALESCE(m.total_runs,0) DESC,COALESCE(m.active_installations,0) DESC,p.module_id
  `).all<Record<string, unknown>>();
  return rows.map((row) => {
    const totalRuns = Number(row.total_runs ?? 0);
    const successfulRuns = Number(row.successful_runs ?? 0);
    return {
      id: String(row.module_id),name:String(row.name),description:String(row.description),sourceType:String(row.source_type),
      version:row.latest_version?String(row.latest_version):null,runtime:row.runtime?String(row.runtime):'builtin',
      sideEffect:row.side_effect?String(row.side_effect):'none',requiresApproval:Boolean(row.requires_approval),
      artifactDigest:row.artifact_digest?String(row.artifact_digest):null,publishedAt:row.published_at?String(row.published_at):null,
      manifest:parseObject(row.manifest_json),sbom:parseObject(row.sbom_json),
      releaseSignature:row.signature?String(row.signature):null,signaturePayloadHash:row.signature_payload_hash?String(row.signature_payload_hash):null,
      publisher: row.publisher_id ? {
        id:String(row.publisher_id),slug:String(row.publisher_slug),name:String(row.publisher_name),
        verified:Boolean(row.publisher_verified),keyFingerprint:String(row.key_fingerprint),publicKeyPem:String(row.public_key_pem),reputationScore:Number(row.reputation_score ?? 0)
      } : { id:null,slug:'trevra',name:'Trevra',verified:true,keyFingerprint:null,publicKeyPem:null,reputationScore:100 },
      trust: { signed:Boolean(row.publisher_id),sbom:Boolean(row.sbom_json && Object.keys(parseObject(row.sbom_json)).length),verifiedRelease:true },
      popularity:{totalRuns,successfulRuns,failedRuns:Number(row.failed_runs ?? 0),successRate:totalRuns?Number((successfulRuns/totalRuns).toFixed(4)):null,
        uniqueWorkspaces:Number(row.unique_workspaces ?? 0),activeInstallations:Number(row.active_installations ?? 0),
        lastRunAt:row.last_run_at?String(row.last_run_at):null,rank:Number(row.popularity_rank ?? 0)}
    };
  });
}

function serializeInstalledModule(row: Record<string, unknown>) {
  const manifest = communityModuleManifestSchema.parse(parseObject(row.manifest_json));
  return {
    id:String(row.module_id),version:String(row.version),name:String(row.name),description:String(row.description),
    runtime:String(row.runtime) as CommunityModuleManifest['runtime'],artifactRef:String(row.artifact_ref),
    artifactDigest:String(row.artifact_digest),manifest,permissions:parseObject(row.permissions_json),
    inputSchema:parseObject(row.input_schema_json),outputSchema:parseObject(row.output_schema_json),
    sideEffect:String(row.side_effect) as CommunityModuleManifest['sideEffect'],requiresApproval:Boolean(row.requires_approval),
    config:parseObject(row.config_json),sbom:parseObject(row.sbom_json),publisher:{id:String(row.publisher_id),slug:String(row.publisher_slug),
      keyFingerprint:String(row.key_fingerprint),verified:Boolean(row.publisher_verified)}
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed=JSON.parse(value);
    return typeof parsed==='object'&&parsed!==null&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
  } catch { return {}; }
}

export async function listWorkspacePublishers(db: Db, workspaceId: string) {
  const rows=await db.prepare(`
    SELECT id,slug,display_name,key_fingerprint,verified,reputation_score,created_at,updated_at
    FROM module_publishers WHERE owner_workspace_id=? ORDER BY created_at DESC
  `).all<Record<string,unknown>>(workspaceId);
  return rows.map((row)=>({id:String(row.id),slug:String(row.slug),displayName:String(row.display_name),
    keyFingerprint:String(row.key_fingerprint),verified:Boolean(row.verified),reputationScore:Number(row.reputation_score??0),
    createdAt:String(row.created_at),updatedAt:String(row.updated_at)}));
}

export async function setPublisherVerification(db: Db,publisherId:string,verified:boolean):Promise<boolean>{
  const result=await db.prepare('UPDATE module_publishers SET verified=?,updated_at=? WHERE id=?')
    .run(verified,new Date().toISOString(),publisherId);
  return result.changes>0;
}

export async function seedBuiltinModuleRegistry(
  db: Db,
  modules: Array<{id:string;name:string;version:string;description:string;sideEffect:'none'|'network-read'|'external-write';requiresApproval:boolean;inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>}>,
  sbom: Record<string, unknown> = {}
):Promise<void>{
  const now=new Date().toISOString();
  for(const module of modules){
    const manifest={id:module.id,version:module.version,name:module.name,description:module.description,runtime:'builtin',
      sideEffect:module.sideEffect,requiresApproval:module.requiresApproval};
    const payloadHash=createHash('sha256').update(stableJson(manifest)).digest('hex');
    await db.transaction(async(tx)=>{
      await tx.prepare(`
        INSERT INTO module_packages (module_id,source_type,name,description,visibility,latest_version,created_at,updated_at)
        VALUES (?,'builtin',?,?,'public',?,?,?)
        ON CONFLICT (module_id) DO UPDATE SET
          name=excluded.name,description=excluded.description,latest_version=excluded.latest_version,updated_at=excluded.updated_at
        WHERE module_packages.source_type='builtin'
      `).run(module.id,module.name,module.description,module.version,now,now);
      await tx.prepare(`
        INSERT INTO module_releases (
          module_id,version,runtime,artifact_ref,artifact_digest,manifest_json,permissions_json,
          input_schema_json,output_schema_json,side_effect,requires_approval,signature,
          signature_payload_hash,sbom_json,status,published_at
        ) VALUES (?,?, 'builtin',NULL,?,?,?,?,?,?,?,NULL,?,?,'verified',?)
        ON CONFLICT (module_id,version) DO UPDATE SET
          manifest_json=excluded.manifest_json,input_schema_json=excluded.input_schema_json,
          output_schema_json=excluded.output_schema_json,side_effect=excluded.side_effect,
          requires_approval=excluded.requires_approval,signature_payload_hash=excluded.signature_payload_hash
      `).run(module.id,module.version,`builtin:${module.id}@${module.version}`,JSON.stringify(manifest),JSON.stringify({}),
        JSON.stringify(module.inputSchema),JSON.stringify(module.outputSchema),module.sideEffect,module.requiresApproval,payloadHash,JSON.stringify(sbom),now);
      await tx.prepare(`INSERT INTO module_usage_metrics (module_id,updated_at) VALUES (?,?) ON CONFLICT (module_id) DO NOTHING`)
        .run(module.id,now);
    });
  }
}
