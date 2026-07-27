import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, id, openDatabase, resetDemoData, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { registerSkill } from '../skills/registry.js';
import { decidePlaybookApproval, startPlaybookRun } from './engine.js';
import { registerPlaybook } from './registry.js';


registerSkill({
  manifest: {
    id: 'test.external-write',
    name: 'External write test',
    version: '1.0.0',
    description: 'Must never run through the generic playbook runner.',
    sideEffect: 'external-write',
    requiresApproval: true,
    inputSchema: z.object({}),
    outputSchema: z.object({ sent: z.boolean() })
  },
  async run() {
    throw new Error('external write should never execute');
  }
});


registerPlaybook({
  id: 'test.email-action-playbook',
  version: '1.0.0',
  name: 'Approved email action',
  description: 'Execute an email only after an exact-payload approval.',
  inputSchema: z.object({ recipient: z.string().email(), subject: z.string(), body: z.string() }),
  steps: [
    {
      id: 'approve-email',
      type: 'approval',
      title: 'Approve email',
      payload: {
        recipient: { $ref: '$.input.recipient' },
        subject: { $ref: '$.input.subject' },
        body: { $ref: '$.input.body' },
        metadata: {}
      }
    },
    {
      id: 'send-email',
      type: 'action',
      actionType: 'email.send',
      approvalStepId: 'approve-email',
      needs: ['approve-email'],
      payload: { $ref: '$.steps.approve-email.input' },
      retry: { maxAttempts: 1 }
    }
  ],
  output: { delivery: { $ref: '$.steps.send-email.output' } },
  source: { type: 'builtin' }
});

registerPlaybook({
  id: 'test.external-write-playbook',
  version: '1.0.0',
  name: 'External write boundary',
  description: 'Verify dedicated action execution is required.',
  inputSchema: z.object({}),
  steps: [{ id: 'send', type: 'skill', skillId: 'test.external-write', input: {} }],
  source: { type: 'builtin' }
});

registerPlaybook({
  id: 'test.score-approval',
  version: '1.0.0',
  name: 'Score and approve',
  description: 'Test durable skill and approval orchestration.',
  inputSchema: z.object({
    lead: z.object({
      platform: z.string().optional(),
      vertical: z.string().optional(),
      catalogSize: z.number().optional(),
      contactEmail: z.string().optional()
    })
  }),
  steps: [
    {
      id: 'score',
      type: 'skill',
      skillId: 'gtm.score-lead',
      input: { lead: { $ref: '$.input.lead' } }
    },
    {
      id: 'approve-score',
      type: 'approval',
      title: 'Approve scored lead',
      needs: ['score'],
      payload: {
        overall: { $ref: '$.steps.score.output.overall' },
        wedge: { $ref: '$.steps.score.output.wedge' }
      }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve-score.output.approved' },
    score: { $ref: '$.steps.score.output' }
  },
  source: { type: 'builtin' }
});

let db: Db | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function openTestDb(): Promise<Db> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  await db.prepare("UPDATE workspace_skills SET enabled=TRUE WHERE workspace_id=?").run(DEMO_WORKSPACE_ID);
  return db;
}

describe('durable playbook engine', () => {
  it('persists each step, waits for exact approval, resumes, and completes with an ordered event stream', async () => {
    const database = await openTestDb();
    const waiting = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.score-approval',
      payload: { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100, contactEmail: 'buyer@example.com' } },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });

    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.currentStepId).toBe('approve-score');
    expect(waiting.steps.find((step) => step.stepId === 'score')?.status).toBe('completed');
    expect(waiting.steps.find((step) => step.stepId === 'score')?.skillRunId).toMatch(/^run_/);
    const approval = waiting.steps.find((step) => step.stepId === 'approve-score');
    expect(approval?.status).toBe('waiting_approval');
    expect(approval?.input).toEqual({ overall: 1, wedge: 'sizing' });
    expect(approval?.approvalPayloadHash).toHaveLength(64);

    const completed = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: waiting.id,
      stepId: 'approve-score',
      userId: DEMO_USER_ID,
      decision: 'approve',
      comment: 'Use this score'
    });

    expect(completed.status).toBe('completed');
    expect(completed.output).toMatchObject({ approved: true, score: { overall: 1, wedge: 'sizing' } });
    const events = await listDomainEvents(database, DEMO_WORKSPACE_ID, { streamType: 'playbook_run', streamId: waiting.id });
    expect(events.map((event) => event.streamVersion)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'playbook.run.started',
      'playbook.step.completed',
      'approval.requested',
      'approval.granted',
      'playbook.run.completed'
    ]));
  });

  it('enforces a workspace deny policy before executing a skill', async () => {
    const database = await openTestDb();
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO workspace_policies (
        id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      id('pol'),DEMO_WORKSPACE_ID,'Block scoring',100,'skill:gtm.score-lead','deny','{}',true,now,now
    );

    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.score-approval',
      payload: { lead: { platform: 'shopify' } },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });

    expect(run.status).toBe('failed');
    expect(run.error).toContain('Matched workspace policy Block scoring');
    expect(run.steps.find((step) => step.stepId === 'score')?.skillRunId).toBeNull();
    const skillRuns = await database.prepare("SELECT COUNT(*)::int AS total FROM skill_runs WHERE workspace_id=? AND skill_id='gtm.score-lead'")
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(skillRuns?.total).toBe(0);
  });

  it('refuses external-write skills until a dedicated action execution step exists', async () => {
    const database = await openTestDb();
    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.external-write-playbook',
      payload: {},
      actorType: 'user',
      actorId: DEMO_USER_ID
    });
    expect(run.status).toBe('failed');
    expect(run.error).toContain('dedicated prepared-action execution step');
    const skillRuns = await database.prepare("SELECT COUNT(*)::int AS total FROM skill_runs WHERE workspace_id=? AND skill_id='test.external-write'")
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(skillRuns?.total).toBe(0);
  });


  it('executes a dedicated email action only after the exact payload is approved', async () => {
    const database = await openTestDb();
    const waiting = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.email-action-playbook',
      payload: { recipient: 'buyer@example.com', subject: 'Audit result', body: 'The audit is ready.' },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.steps.find((step) => step.stepId === 'send-email')?.status).toBe('pending');

    const completed = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: waiting.id,
      stepId: 'approve-email',
      userId: DEMO_USER_ID,
      decision: 'approve'
    });
    expect(completed.status).toBe('completed');
    expect(completed.output).toMatchObject({ delivery: { provider: 'simulation', actionType: 'email.send' } });
    expect((completed.output as { delivery: { externalRef: string } }).delivery.externalRef).toMatch(/^sim_/);
    const events = await listDomainEvents(database, DEMO_WORKSPACE_ID, { streamId: waiting.id });
    expect(events.map((event) => event.eventType)).toContain('action.executed');
  });

});

describe('prepared revenue action adapters', () => {
  it('creates approved invoice and change-order actions through the provider gateway', async () => {
    const database = await openTestDb();
    const invoice = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'revenue.invoice-delivered-work',
      payload: { recipient: 'billing@example.com', amount: 2400, currency: 'USD', description: 'Final milestone', dueDays: 14, message: 'Invoice attached.' },
      actorType: 'user', actorId: DEMO_USER_ID
    });
    const invoiced = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID, runId: invoice.id, stepId: 'approve-invoice', userId: DEMO_USER_ID, decision: 'approve'
    });
    expect(invoiced.output).toMatchObject({ invoice: { provider: 'simulation', actionType: 'invoice.create' } });

    const scope = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'revenue.protect-scope',
      payload: { recipient: 'client@example.com', subject: 'Additional scope', body: 'Please approve the added work.', amount: 750, currency: 'USD', description: 'Additional landing page' },
      actorType: 'user', actorId: DEMO_USER_ID
    });
    const protectedRun = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID, runId: scope.id, stepId: 'approve-change-order', userId: DEMO_USER_ID, decision: 'approve'
    });
    expect(protectedRun.output).toMatchObject({ changeOrder: { provider: 'simulation', actionType: 'change_order.create' } });
  });
});
