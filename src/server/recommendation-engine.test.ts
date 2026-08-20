import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, resetDemoData, DEMO_WORKSPACE_ID, id, type Db } from './db.js';
import { runRecommendationEngine } from './recommendation-engine.js';
import { listRecommendations } from './serializers.js';

let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});
afterEach(async () => {
  await db?.close();
});

describe('GTM recommendation engine on PostgreSQL', () => {
  it('detects the seeded stale opportunity', async () => {
    const count = await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const recommendations = await listRecommendations(db, DEMO_WORKSPACE_ID);

    expect(count).toBe(1);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      type: 'stale_proposal',
      clientName: 'Orbit Health',
      status: 'ready'
    });
    expect(recommendations[0].evidence.length).toBeGreaterThan(0);
  });

  it('is idempotent across repeated runs', async () => {
    await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const count = await db
      .prepare('SELECT COUNT(*)::int AS count FROM recommendations WHERE workspace_id=?')
      .get<{ count: number }>(DEMO_WORKSPACE_ID);
    expect(count?.count).toBe(1);
  });
});
describe('workspace attribution on GTM recommendation evidence', () => {
  const created: string[] = [];

  async function seedTenant(label: string): Promise<{ workspaceId: string; clientId: string }> {
    const now = new Date().toISOString();
    const workspaceId = id('ws');
    const clientId = id('cl');
    created.push(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, label, now);
    await db
      .prepare(
        'INSERT INTO clients (id,workspace_id,name,contact_name,email,status,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        clientId,
        workspaceId,
        `${label} account`,
        'Contact Person',
        `${clientId}@example.test`,
        'prospect',
        now,
        now
      );
    return { workspaceId, clientId };
  }

  async function seedStaleOpportunity(workspaceId: string, clientId: string): Promise<string> {
    const now = Date.now();
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    const opportunityId = id('opp');
    await db
      .prepare(
        'INSERT INTO opportunities (id,workspace_id,client_id,title,status,proposal_sent_at,expected_response_at,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        opportunityId,
        workspaceId,
        clientId,
        'GTM opportunity',
        'proposal_sent',
        iso(8),
        iso(3),
        iso(10)
      );
    await db
      .prepare(
        'INSERT INTO messages (id,workspace_id,client_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        id('msg'),
        workspaceId,
        clientId,
        'outbound',
        'Proposal',
        'Following up on our GTM discussion.',
        iso(8),
        iso(8)
      );
    return opportunityId;
  }

  afterEach(async () => {
    for (const workspaceId of created.splice(0)) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
  });

  it('stamps the recommendation workspace on evidence, proof pack, and proof items', async () => {
    const tenant = await seedTenant('Attribution tenant');
    await seedStaleOpportunity(tenant.workspaceId, tenant.clientId);
    await runRecommendationEngine(db, tenant.workspaceId);

    const evidence = await db
      .prepare(
        `
        SELECT e.workspace_id FROM recommendation_evidence e
        JOIN recommendations r ON r.id=e.recommendation_id
        WHERE r.workspace_id=?
      `
      )
      .all<{ workspace_id: string | null }>(tenant.workspaceId);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((row) => row.workspace_id === tenant.workspaceId)).toBe(true);

    const packs = await db
      .prepare(
        `
        SELECT p.workspace_id FROM proof_packs p
        JOIN recommendations r ON r.id=p.recommendation_id
        WHERE r.workspace_id=?
      `
      )
      .all<{ workspace_id: string | null }>(tenant.workspaceId);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.workspace_id).toBe(tenant.workspaceId);

    const items = await db
      .prepare(
        `
        SELECT i.workspace_id FROM proof_pack_items i
        JOIN proof_packs p ON p.id=i.proof_pack_id
        JOIN recommendations r ON r.id=p.recommendation_id
        WHERE r.workspace_id=?
      `
      )
      .all<{ workspace_id: string | null }>(tenant.workspaceId);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((row) => row.workspace_id === tenant.workspaceId)).toBe(true);
  });

  it('does not surface another workspace opportunity', async () => {
    const first = await seedTenant('First tenant');
    const second = await seedTenant('Second tenant');
    const firstOpp = await seedStaleOpportunity(first.workspaceId, first.clientId);
    const secondOpp = await seedStaleOpportunity(second.workspaceId, second.clientId);

    await runRecommendationEngine(db, first.workspaceId);
    const keys = await db
      .prepare('SELECT source_key FROM recommendations WHERE workspace_id=?')
      .all<{ source_key: string }>(first.workspaceId);

    expect(keys.map((row) => row.source_key)).toContain(`opportunity:${firstOpp}:stale`);
    expect(keys.map((row) => row.source_key)).not.toContain(`opportunity:${secondOpp}:stale`);
  });
});
