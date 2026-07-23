import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, resetDemoData, DEMO_WORKSPACE_ID, type Db } from './db.js';
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
