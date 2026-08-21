import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import { upsertSeat } from '../linkedin/seats.js';
import { compileGtmIntent, prepareGtmPlan } from './intent.js';

const WORKSPACE = 'ws_gtm_intent_test';
const USER = 'usr_gtm_intent_test';
const NOW = new Date('2026-08-21T09:00:00.000Z');
let db: Db;

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Acme,maya-intent@example.com,https://www.linkedin.com/in/maya-intent/',
  'Jonas,Keller,Northstar,jonas-intent@example.com,https://www.linkedin.com/in/jonas-intent/'
].join('\n');

async function reset(): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'GTM Intent', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'founder@intent.test', 'Founder', NOW.toISOString());
}

async function peopleList(): Promise<{ id: string; seatKey: string }> {
  const seat = await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder', timezone: 'Europe/Zurich' },
    NOW
  );
  const list = await createLeadList(
    db,
    {
      workspaceId: WORKSPACE,
      seatKey: seat.seatKey,
      name: 'Swiss SaaS founders',
      sourceKind: 'csv',
      sourceRef: 'intent-test'
    },
    NOW
  );
  await importLeadCsv(
    db,
    { workspaceId: WORKSPACE, seatKey: seat.seatKey, listId: list.id, csv },
    NOW
  );
  return { id: list.id, seatKey: seat.seatKey };
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await reset();
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('bounded GTM intent compiler', () => {
  it('plans every bounded objective without turning the compiler into an execution engine', async () => {
    const objectives = [
      'find_accounts',
      'research_accounts',
      'watch_accounts',
      'capture_inbound'
    ] as const;

    for (const objective of objectives) {
      const plan = await compileGtmIntent(db, WORKSPACE, {
        objective,
        ...(objective === 'capture_inbound'
          ? {}
          : { audience: { description: 'Swiss B2B SaaS companies', quantity: 30 } })
      });
      expect(plan.objective).toBe(objective);
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.consequences.externalWrites).toBe(false);
      expect(plan.steps.every((step) => step.externalEffect === false)).toBe(true);
      expect(plan.defaults.prepareSupported).toBe(false);
    }
  });

  it('compiles an existing People list into an inspectable LinkedIn plan and prepares only a draft campaign', async () => {
    const list = await peopleList();
    const intent = {
      objective: 'prepare_outreach' as const,
      people: { existingListId: list.id },
      channels: ['linkedin'] as const,
      autonomy: 'approval_required' as const
    };

    const firstPlan = await compileGtmIntent(db, WORKSPACE, intent);
    const secondPlan = await compileGtmIntent(db, WORKSPACE, intent);
    expect(secondPlan.planHash).toBe(firstPlan.planHash);
    expect(firstPlan.blockers).toEqual([]);
    expect(firstPlan.defaults).toMatchObject({
      channel: 'linkedin',
      senderKey: list.seatKey,
      leadListId: list.id,
      prepareSupported: true
    });
    expect(firstPlan.consequences).toEqual({
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    });

    const prepared = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      plan: firstPlan,
      planHash: firstPlan.planHash,
      idempotencyKey: 'gtm-plan-prepare-0001'
    });
    expect(prepared).toMatchObject({
      status: 'prepared',
      objective: 'prepare_outreach',
      result: { campaign: { status: 'draft', enrolled: 2 } }
    });

    const campaign = await db
      .prepare('SELECT status,started_at FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
      .get<{ status: string; started_at: string | null }>(WORKSPACE, prepared.artifacts.campaignId);
    expect(campaign).toEqual({ status: 'draft', started_at: null });
    const externalActions = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(externalActions?.total).toBe(0);

    const replay = await prepareGtmPlan(db, {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      plan: firstPlan,
      planHash: firstPlan.planHash,
      idempotencyKey: 'gtm-plan-prepare-0001'
    });
    expect(replay.artifacts).toEqual(prepared.artifacts);
    expect(replay.result.duplicate).toBe(true);
  });

  it('rejects a stale plan when workspace-sensitive sender state changes', async () => {
    const list = await peopleList();
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'prepare_outreach',
      people: { existingListId: list.id },
      channels: ['linkedin']
    });
    expect(plan.blockers).toEqual([]);

    await db
      .prepare('DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
      .run(WORKSPACE, list.seatKey);

    await expect(
      prepareGtmPlan(db, {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        plan,
        planHash: plan.planHash,
        idempotencyKey: 'gtm-plan-prepare-0002'
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/stale/i) });

    const preparations = await db
      .prepare('SELECT COUNT(*)::int AS total FROM outreach_preparations WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(preparations?.total).toBe(0);
  });

  it('shows precise blockers instead of pretending uploaded input references are already materialized', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'Europe/Zurich' }, NOW);
    const plan = await compileGtmIntent(db, WORKSPACE, {
      objective: 'prepare_outreach',
      people: { uploadedInputRef: 'upload://people.csv' },
      channels: ['linkedin']
    });

    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'uploaded_input_not_materialized',
          actionHref: '/outreach/new'
        })
      ])
    );
    expect(plan.defaults.prepareSupported).toBe(false);
  });
});
