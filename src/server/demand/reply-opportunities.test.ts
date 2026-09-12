import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { promoteVerifiedDemandRepliesToOpportunities } from './opportunities.js';

let db: Db;
const workspaces: string[] = [];
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db.close();
});

async function seedRecommendation(): Promise<{
  workspaceId: string;
  recommendationId: string;
  conversationId: string;
  personId: string;
  accountId: string;
}> {
  const workspaceId = id('ws');
  const personId = id('con');
  const recommendationId = id('rec');
  const conversationId = id('conv');
  const createdAt = '2026-09-12T09:00:00.000Z';
  workspaces.push(workspaceId);

  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, 'Reply attribution', createdAt);
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      personId,
      workspaceId,
      'Maya Buyer',
      'maya@example.test',
      'maya@example.test',
      createdAt,
      createdAt
    );
  const account = await createAccount(db, workspaceId, {
    domain: 'reply-attribution.example',
    name: 'Reply Attribution',
    source: 'manual'
  });
  await db
    .prepare(
      `INSERT INTO recommendations (
         id,workspace_id,person_id,account_id,source_key,type,title,summary,confidence,urgency,
         priority_score,status,recommended_action,created_at,updated_at
       ) VALUES (?,?,?,?,?,'qualified_demand','Talk to Maya','Demand',0.9,1.1,990,'completed',
         'prepare_outreach',?,?)`
    )
    .run(
      recommendationId,
      workspaceId,
      personId,
      account.id,
      `demand:${personId}:${account.id}`,
      createdAt,
      createdAt
    );
  await db
    .prepare(
      `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(
      conversationId,
      workspaceId,
      personId,
      '2026-09-12T10:00:00.000Z',
      createdAt,
      '2026-09-12T10:00:00.000Z'
    );
  await db
    .prepare(
      `INSERT INTO conversation_messages (
         id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
         source_type,source_id,verification_status,occurred_at,created_at
       ) VALUES (?,?,?,'email','simulation','outbound','Hello','Contextual outreach','sim:out',
         'qualified_demand_outreach',?,'verified',?,?)`
    )
    .run(
      id('cmsg'),
      workspaceId,
      conversationId,
      recommendationId,
      '2026-09-12T10:00:00.000Z',
      '2026-09-12T10:00:00.000Z'
    );

  return { workspaceId, recommendationId, conversationId, personId, accountId: account.id };
}

async function insertInbound(
  seeded: Awaited<ReturnType<typeof seedRecommendation>>,
  input: {
    at: string;
    verification?: 'verified' | 'unverified';
    outcome?: string | null;
  }
): Promise<string> {
  const messageId = id('cmsg');
  await db
    .prepare(
      `INSERT INTO conversation_messages (
         id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
         source_type,source_id,outcome_kind,verification_status,occurred_at,created_at
       ) VALUES (?,?,?,'email','gmail','inbound','Re: Hello','Interested','gmail:reply',
         'legacy_message',?,?,?,?,?)`
    )
    .run(
      messageId,
      seeded.workspaceId,
      seeded.conversationId,
      `provider-${messageId}`,
      input.outcome ?? 'reply',
      input.verification ?? 'unverified',
      input.at,
      input.at
    );
  return messageId;
}

describe('verified reply opportunity attribution', () => {
  it('promotes only a later provider-verified reply, exactly once, at stage new', async () => {
    const seeded = await seedRecommendation();
    expect(await promoteVerifiedDemandRepliesToOpportunities(db, seeded.workspaceId, NOW)).toEqual(
      []
    );

    const inboundMessageId = await insertInbound(seeded, {
      at: '2026-09-12T10:30:00.000Z',
      verification: 'unverified'
    });
    expect(await promoteVerifiedDemandRepliesToOpportunities(db, seeded.workspaceId, NOW)).toEqual(
      []
    );

    await db
      .prepare(
        "UPDATE conversation_messages SET verification_status='verified' WHERE workspace_id=? AND id=?"
      )
      .run(seeded.workspaceId, inboundMessageId);
    const first = await promoteVerifiedDemandRepliesToOpportunities(db, seeded.workspaceId, NOW);
    const replay = await promoteVerifiedDemandRepliesToOpportunities(db, seeded.workspaceId, NOW);

    expect(first).toEqual([
      expect.objectContaining({
        recommendationId: seeded.recommendationId,
        inboundMessageId,
        created: true
      })
    ]);
    expect(replay).toEqual([]);
    const opportunity = await db
      .prepare(
        `SELECT stage,person_id,account_id,origin_recommendation_id,next_action
         FROM opportunities WHERE workspace_id=? AND origin_recommendation_id=?`
      )
      .get<Record<string, unknown>>(seeded.workspaceId, seeded.recommendationId);
    expect(opportunity).toMatchObject({
      stage: 'new',
      person_id: seeded.personId,
      account_id: seeded.accountId,
      origin_recommendation_id: seeded.recommendationId
    });
    expect(String(opportunity?.next_action)).toContain('qualify or disqualify');
  });

  it('ignores replies before the attributed outbound and verified non-reply outcomes', async () => {
    const earlier = await seedRecommendation();
    await insertInbound(earlier, {
      at: '2026-09-12T09:30:00.000Z',
      verification: 'verified'
    });
    expect(await promoteVerifiedDemandRepliesToOpportunities(db, earlier.workspaceId, NOW)).toEqual(
      []
    );

    const unsubscribe = await seedRecommendation();
    await insertInbound(unsubscribe, {
      at: '2026-09-12T10:30:00.000Z',
      verification: 'verified',
      outcome: 'unsubscribe'
    });
    expect(
      await promoteVerifiedDemandRepliesToOpportunities(db, unsubscribe.workspaceId, NOW)
    ).toEqual([]);
  });
});
