import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { createAccount } from '../accounts/store.js';
import { ensureQualifiedOpportunityFromRecommendation } from './opportunities.js';

let db: Db;
const created: string[] = [];

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  for (const workspaceId of created.splice(0)) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db.close();
});

async function seedRecommendation(
  kind: string
): Promise<{ workspaceId: string; recommendationId: string }> {
  const now = new Date('2026-09-12T08:00:00.000Z').toISOString();
  const workspaceId = id('ws');
  const personId = id('con');
  const sourceId = id('cap');
  const recommendationId = id('rec');
  created.push(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, 'Demand opportunity guard', now);
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(personId, workspaceId, 'Buyer', 'buyer@example.test', 'buyer@example.test', now, now);
  await db
    .prepare(
      `INSERT INTO capture_sources
       (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',0,0,?,?)`
    )
    .run(sourceId, workspaceId, 'Capture', `capture-${sourceId}`, 'diagnostic', now, now);
  const account = await createAccount(db, workspaceId, {
    domain: 'guarded-opportunity.example',
    name: 'Guarded Opportunity',
    source: 'manual'
  });
  const submissionId = id('sub');
  await db
    .prepare(
      `INSERT INTO inbound_submissions
       (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
        person_name,person_email,company_domain,company_name,message,payload_hash,received_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      submissionId,
      workspaceId,
      sourceId,
      personId,
      account.id,
      `submission-${submissionId}`,
      kind,
      'Buyer',
      'buyer@example.test',
      account.domain,
      account.name,
      'First-party event',
      `hash-${submissionId}`,
      now,
      now
    );
  await db
    .prepare(
      `INSERT INTO recommendations
       (id,workspace_id,person_id,account_id,source_key,type,title,summary,confidence,urgency,
        priority_score,status,recommended_action,created_at,updated_at)
       VALUES (?,?,?,?,?,'qualified_demand','Talk to Buyer','Demand',0.9,1.2,1080,'ready','prepare_outreach',?,?)`
    )
    .run(
      recommendationId,
      workspaceId,
      personId,
      account.id,
      `demand:${personId}:${account.id}`,
      now,
      now
    );
  await db
    .prepare(
      `INSERT INTO recommendation_evidence
       (id,workspace_id,recommendation_id,source_type,source_id,label,category,excerpt,observed_at,created_at)
       VALUES (?,?,?,'inbound_submission',?,'First-party event','request','First-party event',?,?)`
    )
    .run(id('ev'), workspaceId, recommendationId, submissionId, now, now);
  return { workspaceId, recommendationId };
}

describe('qualified demand opportunity attribution', () => {
  it('does not promote a scan into pipeline', async () => {
    const seeded = await seedRecommendation('scan_completed');
    expect(
      await ensureQualifiedOpportunityFromRecommendation(
        db,
        seeded.workspaceId,
        seeded.recommendationId
      )
    ).toBeNull();
    const count = await db
      .prepare('SELECT COUNT(*)::int AS count FROM opportunities WHERE workspace_id=?')
      .get<{ count: number }>(seeded.workspaceId);
    expect(count?.count).toBe(0);
  });

  it('promotes pricing requests exactly once', async () => {
    const seeded = await seedRecommendation('pricing_request');
    const first = await ensureQualifiedOpportunityFromRecommendation(
      db,
      seeded.workspaceId,
      seeded.recommendationId
    );
    const second = await ensureQualifiedOpportunityFromRecommendation(
      db,
      seeded.workspaceId,
      seeded.recommendationId
    );
    expect(first).toMatchObject({ created: true, inboundKind: 'pricing_request' });
    expect(second).toMatchObject({ created: false, opportunityId: first?.opportunityId });
    const count = await db
      .prepare(
        'SELECT COUNT(*)::int AS count FROM opportunities WHERE workspace_id=? AND origin_recommendation_id=?'
      )
      .get<{ count: number }>(seeded.workspaceId, seeded.recommendationId);
    expect(count?.count).toBe(1);
  });
});
