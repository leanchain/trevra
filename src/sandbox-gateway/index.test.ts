import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../server/db.js';
import {
  createModulePublisher,
  installModuleRelease,
  moduleReleaseSigningPayload,
  publishModuleRelease,
  setPublisherVerification
} from '../server/registry/service.js';
import { createSandboxGatewayApp } from './index.js';

/**
 * The forged-manifest attack, written as a test.
 *
 * The gateway used to build the manifest it executed out of the request body:
 * artifact, digest, entrypoint, permissions and resources all came from the
 * caller, `sideEffect` was pinned to `'none'`, and `context.workspaceId` was
 * whatever string arrived. Every request below sends a manifest that contradicts
 * the published one, and the assertions are about which of the two the gateway
 * actually acted on.
 */
const TOKEN = 'sandbox-test-token-with-more-than-32-characters';

let db: Db | undefined;
const createdWorkspaces: string[] = [];

afterEach(async () => {
  for (const workspaceId of createdWorkspaces.splice(0)) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
  db = undefined;
});

async function openGatewayDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  return db;
}

const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] };

/** Publish and install a release for the demo workspace, returning its published manifest. */
async function installRelease(database: Db, overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const slug = `gw-${id('t').slice(2, 14)}`;
  const publisher = await createModulePublisher(database, {
    workspaceId: DEMO_WORKSPACE_ID, userId: DEMO_USER_ID, slug, displayName: 'Gateway Test Publisher',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  });
  await setPublisherVerification(database, publisher.id, true);
  const manifest = {
    id: `${slug}.module`, version: '1.0.0', name: 'Gateway module', description: 'Published release under test.',
    runtime: 'remote' as const, artifact: { ref: 'https://published.example/execute', digest: `sha256:${'b'.repeat(64)}` },
    entrypoint: [], sideEffect: 'none' as const, requiresApproval: false,
    permissions: { network: [] as string[], secrets: [] as string[], filesystem: 'none' as const },
    resources: { timeoutSeconds: 5, memoryMb: 64, cpu: 0.25, maxOutputBytes: 10_000 },
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    source: { repository: 'https://example.com/test/module', commit: 'abcdef1', license: 'MIT' },
    ...overrides
  };
  const signature = sign(null, Buffer.from(moduleReleaseSigningPayload(manifest as never, sbom)), privateKey).toString('base64');
  await publishModuleRelease(database, { workspaceId: DEMO_WORKSPACE_ID, userId: DEMO_USER_ID, publisherId: publisher.id, manifest, signature, sbom });
  await installModuleRelease(database, { workspaceId: DEMO_WORKSPACE_ID, userId: DEMO_USER_ID, moduleId: manifest.id, version: manifest.version, config });
  return manifest;
}

/** A body whose module descriptor lies about everything the old gateway trusted. */
function forgedBody(moduleId: string, version: string, workspaceId: string) {
  return {
    module: {
      id: moduleId, version, runtime: 'remote', artifactRef: 'https://attacker.example/execute',
      artifactDigest: `sha256:${'c'.repeat(64)}`, entrypoint: ['--do-anything'],
      permissions: { network: ['attacker.example'], secrets: [], filesystem: 'none' },
      resources: { timeoutSeconds: 300, memoryMb: 2048, cpu: 4, maxOutputBytes: 10_000_000 }
    },
    context: { workspaceId, actorType: 'user', actorId: DEMO_USER_ID },
    input: {}
  };
}

describe('sandbox gateway', () => {
  it('rejects a request without the gateway token', async () => {
    const database = await openGatewayDb();
    const response = await request(createSandboxGatewayApp(database, TOKEN))
      .post('/v1/execute').send(forgedBody('anything', '1.0.0', DEMO_WORKSPACE_ID));
    expect(response.status).toBe(401);
  });

  it('executes the published artifact, not the one the request names', async () => {
    const database = await openGatewayDb();
    const manifest = await installRelease(database);

    const response = await request(createSandboxGatewayApp(database, TOKEN))
      .post('/v1/execute').set('Authorization', `Bearer ${TOKEN}`)
      .send(forgedBody(manifest.id, manifest.version, DEMO_WORKSPACE_ID));

    // The published manifest allows no network hosts at all, so the runtime
    // refuses its OWN artifact host before any request leaves the process. The
    // attacker's host never appears, and the forged allow-list that would have
    // permitted it never got read.
    expect(response.body.error).toContain('published.example');
    expect(response.body.error).toContain('not in the signed network allowlist');
    expect(JSON.stringify(response.body)).not.toContain('attacker.example');
  });

  it('refuses to run a release the named workspace has not installed', async () => {
    const database = await openGatewayDb();
    const manifest = await installRelease(database);
    const outsider = id('ws');
    createdWorkspaces.push(outsider);
    await database.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(outsider, 'Outsider', new Date().toISOString());

    const response = await request(createSandboxGatewayApp(database, TOKEN))
      .post('/v1/execute').set('Authorization', `Bearer ${TOKEN}`)
      .send(forgedBody(manifest.id, manifest.version, outsider));

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('No enabled, verified installation');
  });

  it('applies the published secret grants even when the request claims none are needed', async () => {
    const database = await openGatewayDb();
    // Published release needs a secret; the installation never granted it.
    const manifest = await installRelease(database, {
      permissions: { network: [], secrets: ['ACME_TOKEN'], filesystem: 'none' }
    });

    const response = await request(createSandboxGatewayApp(database, TOKEN))
      .post('/v1/execute').set('Authorization', `Bearer ${TOKEN}`)
      .send(forgedBody(manifest.id, manifest.version, DEMO_WORKSPACE_ID));

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('missing explicit secret grants: ACME_TOKEN');
  });

  it('refuses an external-write release instead of pinning its side effect to none', async () => {
    const database = await openGatewayDb();
    const manifest = await installRelease(database, { sideEffect: 'external-write' });

    const response = await request(createSandboxGatewayApp(database, TOKEN))
      .post('/v1/execute').set('Authorization', `Bearer ${TOKEN}`)
      .send(forgedBody(manifest.id, manifest.version, DEMO_WORKSPACE_ID));

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('declares external-write');
  });
});
