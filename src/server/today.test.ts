import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createAccount } from './accounts/store.js';
import { pauseSeat, upsertSeat } from './linkedin/seats.js';
import { getToday } from './today.js';
import { runRecommendationEngine } from './recommendation-engine.js';

const WORKSPACE = 'ws_today_projection_test';
const NOW = new Date('2026-08-21T08:00:00.000Z');
let db: Db;

async function clearWorkspace(workspaceId: string): Promise<void> {
  // inbound_submissions deliberately RESTRICTS deleting its canonical Person;
  // remove the evidence row first in test teardown, then let workspace cascades
  // clean the rest of the fixture graph.
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Today Projection', NOW.toISOString());
});

afterEach(async () => {
  if (db) await clearWorkspace(WORKSPACE);
  await db?.close();
});

describe('getToday', () => {
  it('projects durable GTM state into deterministic human-attention order', async () => {
    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Founder LinkedIn', timezone: 'Europe/Zurich' },
      new Date('2026-08-20T08:00:00.000Z')
    );
    await pauseSeat(
      db,
      WORKSPACE,
      'Challenge detected; inspect the account before resuming.',
      new Date('2026-08-21T07:00:00.000Z')
    );

    await db
      .prepare(
        `INSERT INTO linkedin_threads
         (id,workspace_id,seat_key,thread_urn,profile_url,name,last_message_at,unread,snippet,synced_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'lith_today_reply',
        WORKSPACE,
        'owner',
        'thread-today-reply',
        'https://www.linkedin.com/in/sarah-chen/',
        'Sarah Chen',
        '2026-08-21T07:10:00.000Z',
        true,
        'Interested — can you send details?',
        '2026-08-21T07:11:00.000Z',
        '2026-08-21T07:11:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_messages
         (id,workspace_id,thread_id,direction,body,sent_at,position,external_ref,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'limsg_today_reply',
        WORKSPACE,
        'lith_today_reply',
        'in',
        'Interested — can you send details?',
        '2026-08-21T07:10:00.000Z',
        1,
        'msg-today-reply',
        '2026-08-21T07:11:00.000Z'
      );

    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'con_today_inbound',
        WORKSPACE,
        'Maya Patel',
        'maya@example.com',
        'maya@example.com',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO capture_sources
         (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',0,0,?,?)`
      )
      .run(
        'cap_today',
        WORKSPACE,
        'Website',
        'website',
        'website',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,idempotency_key,kind,person_name,person_email,message,payload_hash,received_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sub_today',
        WORKSPACE,
        'cap_today',
        'con_today_inbound',
        'today-inbound-0001',
        'demo_request',
        'Maya Patel',
        'maya@example.com',
        'Would like a demo next week.',
        'hash-today',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );

    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'acme.example', name: 'Acme', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        92,
        'hot',
        2,
        '2026-08-21T07:30:00.000Z',
        '{}',
        '2026-08-21T07:31:00.000Z'
      );

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.working).toEqual([]);
    expect(today.recentResults).toEqual([]);
    expect(today.needsAttention.map((item) => item.kind)).toEqual([
      'safety_block',
      'verified_reply',
      'inbound_submission',
      'high_priority_account'
    ]);
    expect(today.needsAttention[0]).toMatchObject({
      href: '/setup/workspace',
      detail: 'Challenge detected; inspect the account before resuming.'
    });
    expect(today.needsAttention[1]).toMatchObject({
      href: '/outreach/inbox',
      title: 'Reply from Sarah Chen'
    });
    expect(today.needsAttention[2]).toMatchObject({
      href: '/outreach/inbound',
      reference: { type: 'inbound_submission', id: 'sub_today' }
    });
    expect(today.needsAttention[3]).toMatchObject({
      href: '/research',
      metadata: { score: 92 }
    });
  });

  it('never leaks another workspace into the projection', async () => {
    const other = 'ws_today_projection_other';
    await clearWorkspace(other);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(other, 'Other', NOW.toISOString());
    await upsertSeat(db, other, { label: 'Other LinkedIn', timezone: 'UTC' }, NOW);
    await pauseSeat(db, other, 'Other workspace pause', NOW);

    const today = await getToday(db, WORKSPACE, NOW);
    expect(today.needsAttention).toEqual([]);

    await clearWorkspace(other);
  });
});

describe('qualified demand in Today', () => {
  it('collapses a first-party inbound plus hot account into one commercial decision', async () => {
    const personId = 'con_today_demand';
    const sourceId = 'cap_today_demand';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        WORKSPACE,
        'Maya Patel',
        'maya@demand.example',
        'maya@demand.example',
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
        WORKSPACE,
        'Beseam scan',
        'beseam-scan',
        'diagnostic',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'demand-today.example', name: 'Demand Today', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
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
        'sub_today_demand',
        WORKSPACE,
        sourceId,
        personId,
        account.id,
        'today-demand-1',
        'scan_completed',
        'Maya Patel',
        'maya@demand.example',
        'demand-today.example',
        'Demand Today',
        'Ran the diagnostic and requested the report.',
        'https://beseam.example/scan/demand-today',
        'hash-today-demand',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        94,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Hiring increased across growth roles.',
        'https://demand-today.example/careers'
      ],
      [1, 'pricing-changed', 'Enterprise pricing changed.', 'https://demand-today.example/pricing']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_demand_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-demand-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW);
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Talk to Maya Patel at Demand Today',
      href: '/outreach/inbound',
      reference: { type: 'recommendation' },
      metadata: {
        personId,
        accountId: account.id,
        recommendationType: 'qualified_demand',
        demandOrigin: 'first_party'
      }
    });
  });

  it('routes hot-account demand with one known contact into outbound', async () => {
    const personId = 'con_today_known_contact';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        WORKSPACE,
        'Sarah Chen',
        'sarah@outbound.example',
        'sarah@outbound.example',
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'outbound-today.example', name: 'Outbound Today', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_contacts
         (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
         VALUES (?,?,?,?,?,'manual','explicit',?,?)`
      )
      .run(
        'ac_today_known_contact',
        WORKSPACE,
        account.id,
        personId,
        'VP Engineering',
        '2026-08-20T09:00:00.000Z',
        '2026-08-20T09:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        92,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://outbound-today.example/careers'
      ],
      [1, 'tech-added', 'Added a new infrastructure tool.', 'https://outbound-today.example/']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_known_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-known-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW, { includeStaleProposals: false });
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Reach out to Sarah Chen at Outbound Today',
      href: '/outreach',
      metadata: {
        personId,
        accountId: account.id,
        demandOrigin: 'known_contact'
      }
    });
  });

  it('routes hot accounts with no known person into a prefilled Find people source', async () => {
    const account = await createAccount(
      db,
      WORKSPACE,
      {
        domain: 'discover-today.example',
        name: 'Discover Today',
        linkedinUrl: 'https://www.linkedin.com/company/discover-today/',
        source: 'manual'
      },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        94,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://discover-today.example/careers'
      ],
      [
        1,
        'pricing-changed',
        'Changed enterprise pricing.',
        'https://discover-today.example/pricing'
      ]
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_discover_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-discover-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW, { includeStaleProposals: false });
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Find the right person at Discover Today',
      metadata: {
        personId: null,
        accountId: account.id,
        recommendationType: 'person_discovery',
        demandOrigin: 'person_discovery',
        discoveryKind: 'company_employees',
        discoveryUrl: 'https://www.linkedin.com/company/discover-today/people/'
      }
    });
    expect(today.needsAttention[0]?.href).toContain('/outreach?focus=leads');
    const query = new URL(`https://trevra.test${today.needsAttention[0]?.href}`).searchParams;
    expect(query.get('kind')).toBe('company_employees');
    expect(query.get('url')).toBe('https://www.linkedin.com/company/discover-today/people/');
  });
});
