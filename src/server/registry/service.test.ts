import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_USER_ID,
  DEMO_WORKSPACE_ID,
  id,
  openDatabase,
  resetDemoData,
  type Db
} from '../db.js';
import { runSkill } from '../skills/runner.js';
import { runCommunityModule } from '../sandbox/community-runtime.js';
import {
  createModulePublisher,
  getInstalledCommunityModule,
  installModuleRelease,
  listPublicRegistryModules,
  moduleReleaseSigningPayload,
  publishModuleRelease,
  setPublisherVerification
} from './service.js';

/**
 * A publisher an operator has already reviewed.
 *
 * Every test that wants an installable release goes through this, because a
 * release can no longer make itself installable: `publishModuleRelease` writes
 * `draft` unless the publisher was verified out of band. That is the whole point
 * of the change, so the tests carry the cost of it rather than routing round it.
 */
async function verifiedPublisher(database: Db, workspaceId: string, userId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const slug = `pub-${id('t').slice(2, 14)}`;
  const publisher = await createModulePublisher(database, {
    workspaceId,
    userId,
    slug,
    displayName: 'Test Publisher',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  });
  await setPublisherVerification(database, publisher.id, true);
  return { ...publisher, privateKey, slug };
}

function manifestFor(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${slug}.remote`,
    version: '1.0.0',
    name: 'Remote test',
    description: 'Exercise signed sandbox execution.',
    runtime: 'remote' as const,
    artifact: { ref: 'https://module.example/execute', digest: `sha256:${'a'.repeat(64)}` },
    entrypoint: [],
    sideEffect: 'none' as const,
    requiresApproval: false,
    permissions: {
      network: ['module.example'],
      secrets: [] as string[],
      filesystem: 'none' as const
    },
    resources: { timeoutSeconds: 5, memoryMb: 64, cpu: 0.25, maxOutputBytes: 10000 },
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: { doubled: { type: 'number' } },
      required: ['doubled'],
      additionalProperties: false
    },
    source: { repository: 'https://example.com/test/module', commit: 'abcdef1', license: 'MIT' },
    ...overrides
  };
}

const testSbom = { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] };

function signManifest(
  manifest: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
): string {
  return sign(
    null,
    Buffer.from(moduleReleaseSigningPayload(manifest as never, testSbom)),
    privateKey
  ).toString('base64');
}

let db: Db | undefined;
let gateway: Server | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
  await new Promise<void>((resolve) => gateway?.close(() => resolve()) ?? resolve());
  gateway = undefined;
  delete process.env.TREVRA_SANDBOX_GATEWAY_URL;
  delete process.env.TREVRA_SANDBOX_GATEWAY_TOKEN;
});

async function openRegistryDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  return db;
}

describe('hosted module registry', () => {
  it('publishes privacy-safe popularity from actual module runs', async () => {
    const database = await openRegistryDb();
    const before = (await listPublicRegistryModules(database)).find(
      (item) => item.id === 'gtm.score-lead'
    )!.popularity.totalRuns;
    await runSkill(
      'gtm.score-lead',
      { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } },
      { db: database, workspaceId: DEMO_WORKSPACE_ID, now: () => new Date() }
    );
    await runSkill(
      'gtm.score-lead',
      { lead: { platform: 'other' } },
      { db: database, workspaceId: DEMO_WORKSPACE_ID, now: () => new Date() }
    );
    const module = (await listPublicRegistryModules(database)).find(
      (item) => item.id === 'gtm.score-lead'
    );
    expect(module?.popularity.totalRuns).toBe(before + 2);
    expect(module?.popularity.successRate).toBe(1);
    expect(JSON.stringify(module)).not.toContain(DEMO_WORKSPACE_ID);
  });

  it('verifies Ed25519 releases, installs them, and runs through the isolated gateway', async () => {
    const database = await openRegistryDb();
    const publisher = await verifiedPublisher(database, DEMO_WORKSPACE_ID, DEMO_USER_ID);
    const manifest = manifestFor(publisher.slug);
    const sbom = testSbom;
    const signature = signManifest(manifest, publisher.privateKey);
    await publishModuleRelease(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      userId: DEMO_USER_ID,
      publisherId: publisher.id,
      manifest,
      signature,
      sbom
    });
    await installModuleRelease(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      userId: DEMO_USER_ID,
      moduleId: manifest.id,
      version: manifest.version
    });
    const installed = await getInstalledCommunityModule(database, DEMO_WORKSPACE_ID, manifest.id);
    expect(installed?.publisher.keyFingerprint).toBe(publisher.keyFingerprint);

    gateway = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ output: { doubled: body.input.value * 2 } }));
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('gateway did not bind');
    process.env.TREVRA_SANDBOX_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
    process.env.TREVRA_SANDBOX_GATEWAY_TOKEN = 'sandbox-test-token-with-more-than-32-characters';
    const run = await runCommunityModule(
      database,
      installed!,
      { value: 21 },
      { workspaceId: DEMO_WORKSPACE_ID, actorType: 'user', actorId: DEMO_USER_ID }
    );
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ doubled: 42 });
    const publicModule = (await listPublicRegistryModules(database)).find(
      (item) => item.id === manifest.id
    );
    expect(publicModule?.popularity.totalRuns).toBe(1);
    expect(publicModule?.popularity.activeInstallations).toBe(1);
    expect(publicModule?.publisher.reputationScore).toBeGreaterThan(0);
  });

  // A public registry that lets publishers stamp their own releases `verified`
  // is not verifying anything; the word has to be earned from an operator.
  it('publishes as draft until an operator has reviewed the publisher', async () => {
    const database = await openRegistryDb();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const slug = `pub-${id('t').slice(2, 14)}`;
    const publisher = await createModulePublisher(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      userId: DEMO_USER_ID,
      slug,
      displayName: 'Unreviewed Publisher',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });
    const manifest = manifestFor(slug);
    const release = await publishModuleRelease(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      userId: DEMO_USER_ID,
      publisherId: publisher.id,
      manifest,
      signature: signManifest(manifest, privateKey),
      sbom: testSbom
    });

    expect(release.status).toBe('draft');
    await expect(
      installModuleRelease(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        userId: DEMO_USER_ID,
        moduleId: manifest.id,
        version: manifest.version
      })
    ).rejects.toThrow('Verified module release not found');
  });

  // `module_packages.module_id` is a global first-come primary key, so without a
  // namespace rule the first tenant to POST owns any name it likes.
  it('refuses to publish a module id outside the publisher namespace', async () => {
    const database = await openRegistryDb();
    const publisher = await verifiedPublisher(database, DEMO_WORKSPACE_ID, DEMO_USER_ID);
    const squatted = manifestFor(publisher.slug, { id: 'acme.invoices' });
    await expect(
      publishModuleRelease(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        userId: DEMO_USER_ID,
        publisherId: publisher.id,
        manifest: squatted,
        signature: signManifest(squatted, publisher.privateKey),
        sbom: testSbom
      })
    ).rejects.toThrow(/own namespace/);
  });

  it('refuses to install another tenant private module, and says only that it is not there', async () => {
    const database = await openRegistryDb();
    const intruderWorkspace = id('ws');
    await database
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(intruderWorkspace, 'Intruder', new Date().toISOString());
    try {
      const publisher = await verifiedPublisher(database, DEMO_WORKSPACE_ID, DEMO_USER_ID);
      const manifest = manifestFor(publisher.slug);
      await publishModuleRelease(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        userId: DEMO_USER_ID,
        publisherId: publisher.id,
        manifest,
        signature: signManifest(manifest, publisher.privateKey),
        sbom: testSbom
      });
      await database
        .prepare("UPDATE module_packages SET visibility='private' WHERE module_id=?")
        .run(manifest.id);

      await expect(
        installModuleRelease(database, {
          workspaceId: intruderWorkspace,
          userId: DEMO_USER_ID,
          moduleId: manifest.id,
          version: manifest.version
        })
      ).rejects.toThrow('Verified module release not found');
      const installed = await database
        .prepare(
          'SELECT COUNT(*)::int AS total FROM workspace_module_installations WHERE workspace_id=?'
        )
        .get<{ total: number }>(intruderWorkspace);
      expect(installed?.total).toBe(0);

      // The owner can still install it -- private means private to them, not broken.
      await installModuleRelease(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        userId: DEMO_USER_ID,
        moduleId: manifest.id,
        version: manifest.version
      });
      expect(
        await getInstalledCommunityModule(database, DEMO_WORKSPACE_ID, manifest.id)
      ).not.toBeNull();
    } finally {
      await database.prepare('DELETE FROM workspaces WHERE id=?').run(intruderWorkspace);
    }
  });
});
