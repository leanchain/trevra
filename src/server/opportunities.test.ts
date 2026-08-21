import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from './db.js';
import { createAgent } from './agents.js';
import {
  OpportunityError,
  createOpportunity,
  listOpportunities,
  updateOpportunity
} from './opportunities.js';
const WS = 'ws_opportunity_lite_test';
const OTHER = 'ws_opportunity_lite_other';
const NOW = new Date('2026-08-21T08:00:00.000Z');
const USER = 'usr_opportunity_lite_test';
let db: Db;
let personId = '';
let accountId = '';

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  for (const workspaceId of [WS, OTHER]) {
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WS, 'owner@opp.test', 'Owner', NOW.toISOString());
  personId = id('con');
  accountId = id('acc');
  await db
    .prepare(
      'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      personId,
      WS,
      'Maya Chen',
      'maya@opp.test',
      'maya@opp.test',
      NOW.toISOString(),
      NOW.toISOString()
    );
  await db
    .prepare(
      "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
    )
    .run(accountId, WS, 'Acme', 'acme.opp.test', NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id IN (?,?)').run(WS, OTHER);
  await db?.close();
});

describe('Opportunity-lite', () => {
  it('stores only bounded GTM progression and next action', async () => {
    const agent = await createAgent(db, {
      workspaceId: WS,
      createdByUserId: USER,
      name: 'Closer',
      purpose: 'Own qualified GTM opportunities'
    });
    const created = await createOpportunity(
      db,
      {
        workspaceId: WS,
        personId,
        accountId,
        title: 'Pilot conversation',
        stage: 'qualified',
        ownerType: 'agent',
        ownerId: agent.id,
        nextAction: 'Book discovery call',
        nextActionAt: '2026-08-22T09:00:00.000Z'
      },
      NOW
    );
    expect(created).toMatchObject({
      personName: 'Maya Chen',
      accountName: 'Acme',
      title: 'Pilot conversation',
      stage: 'qualified',
      ownerName: 'Closer',
      nextAction: 'Book discovery call'
    });
    expect(Object.keys(created)).not.toEqual(
      expect.arrayContaining(['amount', 'currency', 'forecast', 'revenue'])
    );

    const rows = await listOpportunities(db, WS, { stage: 'qualified' });
    expect(rows.map((row) => row.id)).toEqual([created.id]);
  });

  it('closes won/lost stages and reopens without inventing revenue state', async () => {
    const created = await createOpportunity(
      db,
      { workspaceId: WS, personId, title: 'Decision' },
      NOW
    );
    const won = await updateOpportunity(
      db,
      WS,
      created.id,
      { stage: 'won' },
      new Date('2026-08-22T08:00:00.000Z')
    );
    expect(won?.stage).toBe('won');
    expect(won?.closedAt).toBe('2026-08-22T08:00:00.000Z');
    const reopened = await updateOpportunity(
      db,
      WS,
      created.id,
      { stage: 'qualified' },
      new Date('2026-08-23T08:00:00.000Z')
    );
    expect(reopened?.closedAt).toBeNull();
  });

  it('refuses cross-workspace Person, Account and Agent ownership', async () => {
    await expect(
      createOpportunity(db, { workspaceId: OTHER, personId, title: 'Nope' })
    ).rejects.toBeInstanceOf(OpportunityError);
    await expect(
      createOpportunity(db, { workspaceId: OTHER, accountId, title: 'Nope' })
    ).rejects.toBeInstanceOf(OpportunityError);
    const agent = await createAgent(db, {
      workspaceId: WS,
      createdByUserId: USER,
      name: 'Owner',
      purpose: 'test'
    });
    const otherPerson = id('con');
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        otherPerson,
        OTHER,
        'Other',
        'other@opp.test',
        'other@opp.test',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await expect(
      createOpportunity(db, {
        workspaceId: OTHER,
        personId: otherPerson,
        title: 'Nope',
        ownerType: 'agent',
        ownerId: agent.id
      })
    ).rejects.toBeInstanceOf(OpportunityError);
  });
});
