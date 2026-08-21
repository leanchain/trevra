import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { upsertSeat } from '../linkedin/seats.js';
import {
  DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
  PrepareOutreachError,
  prepareOutreach
} from './prepare.js';

const WORKSPACE = 'ws_prepare_outreach_test';
const USER = 'usr_prepare_outreach_test';
const NOW = new Date('2026-08-21T09:00:00.000Z');
let db: Db;

async function reset(): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Prepare Outreach', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO users (id,workspace_id,email,name,created_at)
       VALUES (?,?,?,?,?)`
    )
    .run(USER, WORKSPACE, 'founder@prepare.test', 'Founder', NOW.toISOString());
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await reset();
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

const csv = [
  'First Name,Last Name,Company,Email,LinkedIn URL',
  'Maya,Chen,Acme,maya@example.com,https://www.linkedin.com/in/maya-prepare/',
  'Jonas,Keller,Northstar,jonas@example.com,https://www.linkedin.com/in/jonas-prepare/'
].join('\n');

describe('prepareOutreach', () => {
  it('turns uploaded people into one draft campaign using the blessed workflow and never starts it', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'Europe/Zurich' }, NOW);

    const result = await prepareOutreach(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        idempotencyKey: 'prepare-outreach-0001',
        name: 'Swiss founders',
        uploadedPeopleCsv: csv
      },
      NOW
    );

    expect(result).toMatchObject({
      status: 'prepared',
      duplicate: false,
      campaign: { name: 'Swiss founders', status: 'draft', enrolled: 2 },
      next: { kind: 'review_campaign' }
    });
    expect(result.next.href).toBe(
      `/outreach/campaign/${encodeURIComponent(result.artifacts.campaignId)}`
    );

    const workflow = await db
      .prepare(
        'SELECT name,version,steps_json FROM linkedin_workflows WHERE id=? AND workspace_id=?'
      )
      .get<{ name: string; version: number; steps_json: unknown }>(
        result.artifacts.workflowId,
        WORKSPACE
      );
    expect(workflow?.name).toBe(DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME);
    expect(workflow?.version).toBe(1);
    const steps = (
      typeof workflow?.steps_json === 'string'
        ? JSON.parse(workflow.steps_json)
        : workflow?.steps_json
    ) as Array<{ action: string }>;
    expect(steps.map((step: { action: string }) => step.action)).toEqual([
      'profile_view',
      'connection_request',
      'wait',
      'message',
      'wait',
      'message',
      'end'
    ]);

    const campaign = await db
      .prepare('SELECT status,started_at,preparation_id FROM linkedin_campaigns WHERE id=?')
      .get<{ status: string; started_at: string | null; preparation_id: string | null }>(
        result.artifacts.campaignId
      );
    expect(campaign?.status).toBe('draft');
    expect(campaign?.started_at).toBeNull();
    expect(campaign?.preparation_id).toBeTruthy();

    const people = await db
      .prepare('SELECT COUNT(*)::int AS total FROM contacts WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(people?.total).toBe(2);
  });

  it('returns the exact prepared artifacts when the same idempotency key is retried', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'Europe/Zurich' }, NOW);
    const input = {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      idempotencyKey: 'prepare-outreach-0002',
      name: 'Retry-safe campaign',
      uploadedPeopleCsv: csv
    };

    const first = await prepareOutreach(db, input, NOW);
    const second = await prepareOutreach(db, input, new Date(NOW.getTime() + 60_000));

    expect(second.duplicate).toBe(true);
    expect(second.artifacts).toEqual(first.artifacts);
    const campaigns = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_campaigns WHERE workspace_id=? AND preparation_id IS NOT NULL'
      )
      .get<{ total: number }>(WORKSPACE);
    expect(campaigns?.total).toBe(1);
  });

  it('refuses to reuse an idempotency key for different outreach intent', async () => {
    await upsertSeat(db, WORKSPACE, { label: 'Founder', timezone: 'Europe/Zurich' }, NOW);
    await prepareOutreach(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        idempotencyKey: 'prepare-outreach-0003',
        name: 'First intent',
        uploadedPeopleCsv: csv
      },
      NOW
    );

    await expect(
      prepareOutreach(
        db,
        {
          workspaceId: WORKSPACE,
          actorUserId: USER,
          idempotencyKey: 'prepare-outreach-0003',
          name: 'Different intent',
          uploadedPeopleCsv: csv
        },
        NOW
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it('requires a sender before preparing consequential LinkedIn work', async () => {
    await expect(
      prepareOutreach(
        db,
        {
          workspaceId: WORKSPACE,
          actorUserId: USER,
          idempotencyKey: 'prepare-outreach-0004',
          name: 'No sender',
          uploadedPeopleCsv: csv
        },
        NOW
      )
    ).rejects.toBeInstanceOf(PrepareOutreachError);

    const row = await db
      .prepare('SELECT status,last_error FROM outreach_preparations WHERE workspace_id=?')
      .get<{ status: string; last_error: string }>(WORKSPACE);
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toMatch(/connect the LinkedIn account/i);
  });
});
