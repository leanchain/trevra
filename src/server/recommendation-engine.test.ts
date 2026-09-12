import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, resetDemoData, DEMO_WORKSPACE_ID, id, type Db } from './db.js';
import { createAccount } from './accounts/store.js';
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
      personName: 'Jonas Keller',
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

  async function seedTenant(label: string): Promise<{ workspaceId: string; personId: string }> {
    const now = new Date().toISOString();
    const workspaceId = id('ws');
    const personId = id('con');
    created.push(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, label, now);
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        personId,
        workspaceId,
        'Contact Person',
        `${personId}@example.test`,
        `${personId}@example.test`,
        now,
        now
      );
    return { workspaceId, personId };
  }

  async function seedStaleOpportunity(workspaceId: string, personId: string): Promise<string> {
    const now = Date.now();
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    const opportunityId = id('opp');
    await db
      .prepare(
        'INSERT INTO opportunities (id,workspace_id,person_id,title,stage,proposal_sent_at,expected_response_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        opportunityId,
        workspaceId,
        personId,
        'GTM opportunity',
        'proposal',
        iso(8),
        iso(3),
        iso(10),
        iso(8)
      );
    await db
      .prepare(
        'INSERT INTO messages (id,workspace_id,person_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        id('msg'),
        workspaceId,
        personId,
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
    await seedStaleOpportunity(tenant.workspaceId, tenant.personId);
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
    const firstOpp = await seedStaleOpportunity(first.workspaceId, first.personId);
    const secondOpp = await seedStaleOpportunity(second.workspaceId, second.personId);

    await runRecommendationEngine(db, first.workspaceId);
    const keys = await db
      .prepare('SELECT source_key FROM recommendations WHERE workspace_id=?')
      .all<{ source_key: string }>(first.workspaceId);

    expect(keys.map((row) => row.source_key)).toContain(`opportunity:${firstOpp}:stale`);
    expect(keys.map((row) => row.source_key)).not.toContain(`opportunity:${secondOpp}:stale`);
  });
});

describe('qualified demand recommendations', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const workspaceId of created.splice(0)) {
      await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
  });

  it('persists one compound recommendation with first-party and source-backed account proof', async () => {
    const now = new Date('2026-09-12T08:00:00.000Z');
    const workspaceId = id('ws');
    const personId = id('con');
    const sourceId = id('cap');
    created.push(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, 'Qualified demand', now.toISOString());
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        workspaceId,
        'Maya Patel',
        'maya@acme.example',
        'maya@acme.example',
        'VP Growth',
        now.toISOString(),
        now.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO capture_sources
         (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',0,0,?,?)`
      )
      .run(
        sourceId,
        workspaceId,
        'Beseam scan',
        `scan-${sourceId}`,
        'diagnostic',
        now.toISOString(),
        now.toISOString()
      );
    const account = await createAccount(
      db,
      workspaceId,
      { domain: 'acme-demand.example', name: 'Acme Demand', source: 'manual' },
      new Date('2026-09-10T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
          person_name,person_email,company_domain,company_name,message,page_url,payload_hash,
          received_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sub_qualified_demand',
        workspaceId,
        sourceId,
        personId,
        account.id,
        'qualified-demand-1',
        'scan_completed',
        'Maya Patel',
        'maya@acme.example',
        'acme-demand.example',
        'Acme Demand',
        'Completed the diagnostic and requested the detailed report.',
        'https://beseam.example/scan/acme',
        'hash-qualified-demand',
        '2026-09-12T07:30:00.000Z',
        '2026-09-12T07:30:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        account.id,
        91,
        'hot',
        2,
        '2026-09-12T07:00:00.000Z',
        '{}',
        '2026-09-12T07:01:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [0, 'hiring-up', 'Acme added four growth roles.', 'https://acme-demand.example/careers'],
      [
        1,
        'pricing-changed',
        'Acme changed enterprise pricing.',
        'https://acme-demand.example/pricing'
      ]
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id('sig'),
          workspaceId,
          account.id,
          kind,
          detail,
          url,
          `2026-09-12T0${6 + index}:00:00.000Z`,
          `qualified-${index}`,
          `2026-09-12T0${6 + index}:00:00.000Z`
        );
    }

    const count = await runRecommendationEngine(db, workspaceId, now);
    const recommendations = await listRecommendations(db, workspaceId);

    expect(count).toBe(1);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      type: 'qualified_demand',
      personId,
      personName: 'Maya Patel',
      status: 'ready'
    });
    expect(recommendations[0]?.evidence.map((item) => item.sourceType).sort()).toEqual([
      'account_score',
      'account_signal',
      'account_signal',
      'inbound_submission'
    ]);
    expect(recommendations[0]?.evidence.every((item) => Boolean(item.observedAt))).toBe(true);

    await runRecommendationEngine(db, workspaceId, new Date('2026-09-12T08:05:00.000Z'));
    const persisted = await db
      .prepare(
        "SELECT COUNT(*)::int AS count FROM recommendations WHERE workspace_id=? AND type='qualified_demand'"
      )
      .get<{ count: number }>(workspaceId);
    expect(persisted?.count).toBe(1);
  });
});
