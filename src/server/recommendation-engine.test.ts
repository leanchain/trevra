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

describe('recommendation engine on PostgreSQL', () => {
  it('detects the four seeded revenue leaks', async () => {
    const count = await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const recommendations = await listRecommendations(db, DEMO_WORKSPACE_ID);
    expect(count).toBe(4);
    expect(recommendations.map((item) => item.type).sort()).toEqual([
      'overdue_invoice',
      'scope_creep',
      'stale_proposal',
      'unbilled_milestone'
    ]);
    expect(recommendations.every((item) => item.evidence.length > 0)).toBe(true);
  });

  it('is idempotent across repeated runs', async () => {
    await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    await runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM recommendations WHERE workspace_id=?')
      .get<{ count: number }>(DEMO_WORKSPACE_ID);
    expect(count?.count).toBe(4);
  });
});

/**
 * Tenant attribution on the three child tables this engine writes, and on the
 * one it reads through a project id.
 *
 * `recommendation_evidence`, `proof_packs` and `proof_pack_items` had no
 * `workspace_id` at all until 058, so nothing about a row said which customer
 * it belonged to -- the only answer was "whatever tenant owns the
 * recommendation this row hangs off", which is a JOIN, not a fact on the row.
 * These tests pin the fact: what the engine writes for a tenant carries that
 * tenant, and a child row attributed elsewhere is not visible here even when
 * its parent id points straight at us.
 *
 * The column is still nullable at this stage (058 stops short of `SET NOT
 * NULL`), so nothing below asserts NOT NULL -- it asserts the exact value the
 * engine wrote.
 */
describe('workspace attribution on engine-written rows', () => {
  async function seedTenant(label: string): Promise<{ workspaceId: string; clientId: string; projectId: string }> {
    const now = new Date().toISOString();
    const workspaceId = id('ws');
    const clientId = id('cl');
    const projectId = id('prj');
    await db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, label, now);
    await db.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(clientId, workspaceId, `${label} client`, 'Contact Person', `${clientId}@example.test`, 'active', 5000, 'EUR', now, now);
    await db.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(projectId, workspaceId, clientId, `${label} project`, 'active', 5000, 'EUR', now);
    return { workspaceId, clientId, projectId };
  }

  /** A delivered, uninvoiced milestone -- the cheapest candidate the engine raises. */
  async function seedMilestone(workspaceId: string | null, projectId: string): Promise<string> {
    const now = new Date().toISOString();
    const milestoneId = id('mil');
    await db.prepare('INSERT INTO milestones (id,workspace_id,project_id,name,amount,currency,status,delivered_at,invoiced_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(milestoneId, workspaceId, projectId, 'Final delivery', 2400, 'EUR', 'delivered', now, null, now);
    return milestoneId;
  }

  async function dropWorkspaces(...workspaceIds: string[]): Promise<void> {
    for (const workspaceId of workspaceIds) await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }

  it('stamps the recommendation\'s workspace on its evidence, proof pack, and proof pack items', async () => {
    const tenant = await seedTenant('Attribution tenant');
    try {
      await seedMilestone(tenant.workspaceId, tenant.projectId);
      await runRecommendationEngine(db, tenant.workspaceId);

      const evidence = await db.prepare(`
        SELECT e.workspace_id FROM recommendation_evidence e
        JOIN recommendations r ON r.id=e.recommendation_id WHERE r.workspace_id=?
      `).all<{ workspace_id: string | null }>(tenant.workspaceId);
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((row) => row.workspace_id === tenant.workspaceId)).toBe(true);

      const packs = await db.prepare(`
        SELECT p.workspace_id FROM proof_packs p
        JOIN recommendations r ON r.id=p.recommendation_id WHERE r.workspace_id=?
      `).all<{ workspace_id: string | null }>(tenant.workspaceId);
      expect(packs.length).toBe(1);
      expect(packs[0].workspace_id).toBe(tenant.workspaceId);

      const items = await db.prepare(`
        SELECT i.workspace_id FROM proof_pack_items i
        JOIN proof_packs p ON p.id=i.proof_pack_id
        JOIN recommendations r ON r.id=p.recommendation_id WHERE r.workspace_id=?
      `).all<{ workspace_id: string | null }>(tenant.workspaceId);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((row) => row.workspace_id === tenant.workspaceId)).toBe(true);
    } finally {
      await dropWorkspaces(tenant.workspaceId);
    }
  });

  it('does not bill for a milestone attributed to another workspace, even when its project points here', async () => {
    const other = await seedTenant('Other tenant');
    const here = await seedTenant('Reading tenant');
    try {
      const own = await seedMilestone(here.workspaceId, here.projectId);
      // The mis-parented row: `project_id` says this tenant, `workspace_id` says
      // the other one. Before the column existed the engine's only filter was
      // `projects.workspace_id`, so this milestone was indistinguishable from
      // `own` and became an "invoice this now" recommendation for the wrong
      // customer's delivered work.
      const foreign = await seedMilestone(other.workspaceId, here.projectId);

      await runRecommendationEngine(db, here.workspaceId);
      const sourceKeys = (await db.prepare('SELECT source_key FROM recommendations WHERE workspace_id=?')
        .all<{ source_key: string }>(here.workspaceId)).map((row) => row.source_key);

      expect(sourceKeys).toContain(`milestone:${own}:unbilled`);
      expect(sourceKeys).not.toContain(`milestone:${foreign}:unbilled`);
    } finally {
      await dropWorkspaces(other.workspaceId, here.workspaceId);
    }
  });
});
