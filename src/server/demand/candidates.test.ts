import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../accounts/store.js';
import { id, openDatabase, type Db } from '../db.js';
import { buildDemandCandidates } from './candidates.js';

const NOW = new Date('2026-09-12T08:00:00.000Z');
let db: Db;
const workspaces: string[] = [];

async function seedWorkspace(label: string): Promise<string> {
  const workspaceId = id('ws');
  workspaces.push(workspaceId);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(workspaceId, label, NOW.toISOString());
  return workspaceId;
}

async function seedInboundAtHotAccount(
  workspaceId: string,
  input: { tier?: 'hot' | 'warm'; score?: number; kind?: string } = {}
): Promise<{ personId: string; accountId: string; submissionId: string }> {
  const personId = id('con');
  const sourceId = id('cap');
  const submissionId = id('sub');
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
      `${personId}@example.test`,
      `${personId}@example.test`,
      'VP Growth',
      NOW.toISOString(),
      NOW.toISOString()
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
      'Website',
      `website-${sourceId}`,
      'website',
      NOW.toISOString(),
      NOW.toISOString()
    );

  const account = await createAccount(
    db,
    workspaceId,
    { domain: `${accountIdSafe(workspaceId)}.example`, name: 'Acme', source: 'manual' },
    new Date('2026-09-10T08:00:00.000Z')
  );

  await db
    .prepare(
      `INSERT INTO account_contacts
       (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
       VALUES (?,?,?,?,?,'capture','explicit',?,?)`
    )
    .run(
      id('ac'),
      workspaceId,
      account.id,
      personId,
      'VP Growth',
      NOW.toISOString(),
      NOW.toISOString()
    );

  await db
    .prepare(
      `INSERT INTO inbound_submissions
       (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
        person_name,person_email,person_role,company_domain,company_name,message,page_url,
        payload_hash,received_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      submissionId,
      workspaceId,
      sourceId,
      personId,
      account.id,
      `idem-${submissionId}`,
      input.kind ?? 'demo_request',
      'Maya Patel',
      `${personId}@example.test`,
      'VP Growth',
      `${accountIdSafe(workspaceId)}.example`,
      'Acme',
      'We would like to see a demo next week.',
      'https://example.test/demo',
      `hash-${submissionId}`,
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
      input.score ?? 88,
      input.tier ?? 'hot',
      2,
      '2026-09-12T06:00:00.000Z',
      '{}',
      '2026-09-12T06:01:00.000Z'
    );

  for (const [index, signal] of [
    [
      'hiring-up',
      'Open roles increased from 3 to 8, including VP Platform.',
      'https://acme.example/careers'
    ],
    ['pricing-changed', 'Pricing page changed this week.', 'https://acme.example/pricing']
  ].entries()) {
    await db
      .prepare(
        `INSERT INTO account_signals
         (id,workspace_id,account_id,kind,detail,previous,current,evidence_url,observed_at,fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('sig'),
        workspaceId,
        account.id,
        signal[0],
        signal[1],
        null,
        null,
        signal[2],
        `2026-09-12T0${5 + index}:00:00.000Z`,
        `fp-${submissionId}-${index}`,
        `2026-09-12T0${5 + index}:00:00.000Z`
      );
  }

  return { personId, accountId: account.id, submissionId };
}

function accountIdSafe(workspaceId: string): string {
  return workspaceId
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(-16);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

afterEach(async () => {
  for (const workspaceId of workspaces.splice(0)) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('buildDemandCandidates', () => {
  it('joins explicit first-party intent with hot account intent and source evidence', async () => {
    const workspaceId = await seedWorkspace('Demand graph');
    const seeded = await seedInboundAtHotAccount(workspaceId);

    const candidates = await buildDemandCandidates(db, workspaceId, NOW);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceKey: `demand:${seeded.personId}:${seeded.accountId}`,
      personId: seeded.personId,
      accountId: seeded.accountId,
      qualification: 'act_now',
      recommendedAction: 'prepare_outreach',
      dimensions: {
        fit: null,
        accountIntent: 0.88,
        personIntent: 0,
        firstPartyIntent: 1,
        relationship: 0
      }
    });
    expect(candidates[0]?.evidence.map((item) => item.sourceType)).toEqual([
      'inbound_submission',
      'account_score',
      'account_signal',
      'account_signal'
    ]);
    expect(candidates[0]?.evidence.filter((item) => item.sourceType === 'account_signal')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalUrl: 'https://acme.example/careers' }),
        expect.objectContaining({ externalUrl: 'https://acme.example/pricing' })
      ])
    );
  });

  it('does not promote the same inbound event when account intent is only warm', async () => {
    const workspaceId = await seedWorkspace('Warm demand graph');
    await seedInboundAtHotAccount(workspaceId, { tier: 'warm', score: 55 });

    expect(await buildDemandCandidates(db, workspaceId, NOW)).toEqual([]);
  });

  it('is workspace isolated', async () => {
    const first = await seedWorkspace('First');
    const second = await seedWorkspace('Second');
    const firstSeed = await seedInboundAtHotAccount(first);
    await seedInboundAtHotAccount(second);

    const candidates = await buildDemandCandidates(db, first, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.personId).toBe(firstSeed.personId);
    expect(candidates[0]?.accountId).toBe(firstSeed.accountId);
  });
});
