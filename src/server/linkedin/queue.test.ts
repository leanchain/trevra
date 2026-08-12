import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { LinkedInActionKind } from './actions.js';
import { postgresLocalWorkerStore } from './local-worker.js';
import type { PacingPlan, PacingSlot } from './pacing.js';
import { queueCampaign } from './queue.js';
import { upsertSeat } from './seats.js';
import { extractVariables, type LinkedInSequence } from './sequence.js';
import type { ExportContact } from './export.js';

/**
 * The queue writer (docs/core-product.md section 8, L1).
 *
 * WHAT THESE TESTS ARE FOR. `local-worker.ts` could already send an invite and
 * a DM; nothing wrote a row it could claim. So the load-bearing assertion in
 * this file is not "a row appeared" but "the row `queueCampaign` wrote satisfies
 * `claimNextDueAction`'s WHERE clause" -- a queue whose rows are correct in
 * every column but one is a queue that silently never drains, and it looks
 * exactly like a working feature until an operator asks why nothing sent.
 *
 * NO BROWSER AND NO LINKEDIN CALL, here or anywhere in this subsystem's tests.
 * Queueing is a database write; the sending arm is faked in
 * `local-worker.test.ts` and never reached from here.
 */

let db: Db;
const NOW = new Date('2026-08-06T09:00:00.000Z');

/** The seat's FIRST WRITE is the ramp clock, so an established seat is written back in January. */
const ACTIVATED = new Date('2026-01-05T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  await db.prepare('DELETE FROM linkedin_batches WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
  await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
  await upsertSeat(
    db,
    DEMO_WORKSPACE_ID,
    { label: 'Pankaj (founder)', timezone: 'Europe/Berlin', accountOpenedOn: '2026-01-05', connectionsCount: 900 },
    ACTIVATED
  );
});

afterEach(async () => {
  await db?.close();
});

function sequenceOf(
  ...steps: Array<{ id: string; day: number; kind: LinkedInActionKind; template: string }>
): LinkedInSequence {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      day: step.day,
      kind: step.kind,
      intent: 'test',
      template: step.template,
      variables: extractVariables(step.template),
      critique: null
    })),
    antiSlopNotes: [],
    antiSlopPassed: true
  };
}

/** Slots in the PAST, because a claimable row is one whose slot has arrived. */
function plan(slots: PacingSlot[], seatKey = 'owner'): PacingPlan {
  return { seatKey, slots, reasons: [], ceilingsApplied: [] };
}

function slot(kind: LinkedInActionKind, targetRef: string, plannedFor: string): PacingSlot {
  return { kind: kind as PacingSlot['kind'], targetRef, plannedFor };
}

const MAYA: ExportContact = {
  targetRef: 'https://linkedin.com/in/maya',
  firstName: 'Maya',
  lastName: 'Chen',
  company: 'Northwind',
  role: 'Head of RevOps'
};

const JO: ExportContact = {
  targetRef: 'https://linkedin.com/in/jo',
  firstName: 'Jo',
  lastName: 'Park',
  company: 'Acme',
  role: 'RevOps lead'
};

async function actionCount(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
    .get<{ total: number }>(DEMO_WORKSPACE_ID);
  return row?.total ?? 0;
}

describe('queueCampaign', () => {
  it('writes a planned invite the local worker can actually claim', async () => {
    const result = await queueCampaign(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        plan: plan([
          slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z'),
          slot('invite', JO.targetRef, '2026-08-06T08:30:00.000Z')
        ]),
        sequence: sequenceOf({
          id: 'step-1',
          day: 0,
          kind: 'invite',
          template: 'Hi {{firstName}} -- routing at {{company}} is the reason I wrote.'
        }),
        contacts: [MAYA, JO],
        campaignId: 'licmp_queue_1',
        payloadHash: 'hash-approved-by-a-human'
      },
      NOW
    );

    expect(result.recorded).toEqual({ attempted: 2, written: 2, duplicate: 0 });

    const rows = await db.prepare(
      'SELECT kind, status, source, body, campaign_id, payload_hash, recorded_at FROM linkedin_actions WHERE workspace_id=? ORDER BY planned_for'
    ).all<{
      kind: string; status: string; source: string; body: string | null;
      campaign_id: string | null; payload_hash: string | null; recorded_at: string | null;
    }>(DEMO_WORKSPACE_ID);

    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('planned');
    expect(rows[0].source).toBe('campaign');
    expect(rows[0].campaign_id).toBe('licmp_queue_1');
    expect(rows[0].payload_hash).toBe('hash-approved-by-a-human');
    // 'planned' consumes no rolling budget; `settleSent` dates it when it happens.
    expect(rows[0].recorded_at).toBeNull();
    // THE SUBSTITUTION IS THE POINT: a real value, not another tool's token.
    expect(rows[0].body).toBe('Hi Maya -- routing at Northwind is the reason I wrote.');
    for (const row of rows) expect(row.body ?? '').not.toContain('{{');

    // And the row satisfies the claim. This is the assertion the whole feature
    // exists for -- before it, `claimNextDueAction` never saw an invite.
    const store = postgresLocalWorkerStore(db, DEMO_WORKSPACE_ID);
    const batchId = await store.openBatch(NOW);
    const claimed = await store.claimNextDueAction(batchId, NOW);
    expect(claimed?.kind).toBe('invite');
    expect(claimed?.targetRef).toBe(MAYA.targetRef);
    expect(claimed?.body).toBe('Hi Maya -- routing at Northwind is the reason I wrote.');
  });

  it('queues a dm with a body, which is what makes it claimable at all', async () => {
    await queueCampaign(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        plan: plan([slot('dm', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
        sequence: sequenceOf({ id: 'step-2', day: 3, kind: 'dm', template: 'Following up, {{firstName}}.' }),
        contacts: [MAYA]
      },
      NOW
    );

    const store = postgresLocalWorkerStore(db, DEMO_WORKSPACE_ID);
    const claimed = await store.claimNextDueAction(await store.openBatch(NOW), NOW);
    expect(claimed?.kind).toBe('dm');
    expect(claimed?.body).toBe('Following up, Maya.');
  });

  it('refuses the whole campaign when a template needs a field a contact does not have, and writes nothing', async () => {
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([
            slot('dm', MAYA.targetRef, '2026-08-06T08:00:00.000Z'),
            // No contact record at all, so every field is missing.
            slot('dm', 'https://linkedin.com/in/stranger', '2026-08-06T08:30:00.000Z')
          ]),
          sequence: sequenceOf({
            id: 'step-1',
            day: 0,
            kind: 'dm',
            template: 'Hi {{firstName}}, how is {{company}} handling routing?'
          }),
          contacts: [MAYA]
        },
        NOW
      )
    ).rejects.toThrow(/https:\/\/linkedin.com\/in\/stranger needs \{\{firstName\}\}, \{\{company\}\}/);

    // NOTHING, not even the slot that could have been rendered. A campaign is
    // one decision a human signed.
    expect(await actionCount()).toBe(0);
  });

  it('refuses a blank merge value the same way as a missing one', async () => {
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
          sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'invite', template: 'Hi {{firstName}}.' }),
          contacts: [{ ...MAYA, firstName: '   ' }]
        },
        NOW
      )
    ).rejects.toThrow(/\{\{firstName\}\}/);
    expect(await actionCount()).toBe(0);
  });

  it('is idempotent: a re-run writes nothing new and counts the replay guard', async () => {
    const input = {
      workspaceId: DEMO_WORKSPACE_ID,
      plan: plan([
        slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z'),
        slot('invite', JO.targetRef, '2026-08-06T08:30:00.000Z')
      ]),
      sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'invite', template: 'Hi {{firstName}}.' }),
      contacts: [MAYA, JO],
      campaignId: 'licmp_queue_2'
    };

    const first = await queueCampaign(db, input, NOW);
    const second = await queueCampaign(db, input, NOW);

    expect(first.recorded).toEqual({ attempted: 2, written: 2, duplicate: 0 });
    expect(second.recorded).toEqual({ attempted: 2, written: 0, duplicate: 2 });
    expect(await actionCount()).toBe(2);
  });

  it('refuses a kind the local worker cannot perform', async () => {
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([slot('inmail', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
          sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'inmail', template: 'Hi {{firstName}}.' }),
          contacts: [MAYA]
        },
        NOW
      )
    ).rejects.toThrow(/inmail, which the local worker cannot send/);
    expect(await actionCount()).toBe(0);
  });

  it('refuses a reply, which only the inbox can queue because only it holds the thread', async () => {
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([slot('reply', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
          sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'reply', template: 'Thanks {{firstName}}.' }),
          contacts: [MAYA]
        },
        NOW
      )
    ).rejects.toThrow(/reply, which the local worker cannot send/);
    expect(await actionCount()).toBe(0);
  });

  it('refuses when the seat is gone, exactly as exportCampaign does', async () => {
    await db.prepare('DELETE FROM linkedin_seats WHERE workspace_id=?').run(DEMO_WORKSPACE_ID);
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
          sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'invite', template: 'Hi {{firstName}}.' }),
          contacts: [MAYA]
        },
        NOW
      )
    ).rejects.toThrow(/No LinkedIn seat is configured for this workspace/);
    expect(await actionCount()).toBe(0);
  });

  it('refuses on a hosted deployment and says the export path is what exists there', async () => {
    const previous = process.env.TREVRA_DEPLOYMENT_MODE;
    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      await expect(
        queueCampaign(
          db,
          {
            workspaceId: DEMO_WORKSPACE_ID,
            plan: plan([slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
            sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'invite', template: 'Hi {{firstName}}.' }),
            contacts: [MAYA]
          },
          NOW
        )
      ).rejects.toThrow(/cannot be queued for sending on a hosted deployment[\s\S]*Export the campaign instead/);
      expect(await actionCount()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TREVRA_DEPLOYMENT_MODE;
      else process.env.TREVRA_DEPLOYMENT_MODE = previous;
    }
  });

  it('queues a note-less invite as a NULL body rather than inventing one', async () => {
    await queueCampaign(
      db,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        plan: plan([slot('invite', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
        sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'invite', template: '' }),
        contacts: [MAYA]
      },
      NOW
    );
    const row = await db.prepare('SELECT body FROM linkedin_actions WHERE workspace_id=?')
      .get<{ body: string | null }>(DEMO_WORKSPACE_ID);
    expect(row?.body).toBeNull();

    // Still claimable: an invite carries no obligation to say anything.
    const store = postgresLocalWorkerStore(db, DEMO_WORKSPACE_ID);
    const claimed = await store.claimNextDueAction(await store.openBatch(NOW), NOW);
    expect(claimed?.kind).toBe('invite');
  });

  it('refuses a dm whose approved step has no words at all', async () => {
    await expect(
      queueCampaign(
        db,
        {
          workspaceId: DEMO_WORKSPACE_ID,
          plan: plan([slot('dm', MAYA.targetRef, '2026-08-06T08:00:00.000Z')]),
          sequence: sequenceOf({ id: 'step-1', day: 0, kind: 'dm', template: '   ' }),
          contacts: [MAYA]
        },
        NOW
      )
    ).rejects.toThrow(/message with no approved words/);
    expect(await actionCount()).toBe(0);
  });
});
