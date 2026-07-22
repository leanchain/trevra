import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, DEMO_WORKSPACE_ID, type Db } from './db.js';
import { runRecommendationEngine } from './recommendation-engine.js';
import { listRecommendations } from './serializers.js';

let db: Db | undefined;
afterEach(() => db?.close());

describe('recommendation engine', () => {
  it('detects the four seeded revenue leaks', () => {
    db = openDatabase(':memory:');
    const count = runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const recommendations = listRecommendations(db, DEMO_WORKSPACE_ID);
    expect(count).toBe(4);
    expect(recommendations.map((item) => item.type).sort()).toEqual([
      'overdue_invoice',
      'scope_creep',
      'stale_proposal',
      'unbilled_milestone'
    ]);
    expect(recommendations.every((item) => item.evidence.length > 0)).toBe(true);
  });

  it('is idempotent across repeated runs', () => {
    db = openDatabase(':memory:');
    runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    runRecommendationEngine(db, DEMO_WORKSPACE_ID);
    const count = db.prepare('SELECT COUNT(*) AS count FROM recommendations').get() as { count: number };
    expect(count.count).toBe(4);
  });
});
