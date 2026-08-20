import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEMO_USER_ID,
  DEMO_WORKSPACE_ID,
  id,
  openDatabase,
  resetDemoData,
  type Db
} from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { registerSkill } from '../skills/registry.js';
import { decidePlaybookApproval, getPlaybookRun, startPlaybookRun } from './engine.js';
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

registerSkill({
  manifest: {
    id: 'test.list-items',
    name: 'List items test',
    version: '1.0.0',
    description: 'Always returns an empty list, to exercise a downstream $ref into an empty array.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema: z.object({}),
    outputSchema: z.object({ items: z.array(z.object({ thing: z.string() })) })
  },
  async run() {
    return { items: [] };
  }
});

registerSkill({
  manifest: {
    id: 'test.needs-thing',
    name: 'Needs thing test',
    version: '1.0.0',
    description:
      'Requires `thing`; proves a step fails cleanly, not by throwing, when its $ref resolves to nothing.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema: z.object({ thing: z.string() }),
    outputSchema: z.object({ ok: z.boolean() })
  },
  async run() {
    return { ok: true };
  }
});

registerPlaybook({
  id: 'test.missing-ref-playbook',
  version: '1.0.0',
  name: 'Missing ref',
  description:
    'A downstream step $refs into a prior step that returned zero items -- the ordinary "nothing qualified" case.',
  inputSchema: z.object({}),
  steps: [
    { id: 'list', type: 'skill', skillId: 'test.list-items', input: {} },
    {
      id: 'use',
      type: 'skill',
      skillId: 'test.needs-thing',
      needs: ['list'],
      input: { thing: { $ref: '$.steps.list.output.items.0.thing' } }
    }
  ],
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
  await db
    .prepare('UPDATE workspace_skills SET enabled=TRUE WHERE workspace_id=?')
    .run(DEMO_WORKSPACE_ID);
  return db;
}

describe('durable playbook engine', () => {
  it('persists each step, waits for exact approval, resumes, and completes with an ordered event stream', async () => {
    const database = await openTestDb();
    const waiting = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.score-approval',
      payload: {
        lead: {
          platform: 'shopify',
          vertical: 'footwear',
          catalogSize: 100,
          contactEmail: 'buyer@example.com'
        }
      },
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
    expect(completed.output).toMatchObject({
      approved: true,
      score: { overall: 1, wedge: 'sizing' }
    });
    const events = await listDomainEvents(database, DEMO_WORKSPACE_ID, {
      streamType: 'playbook_run',
      streamId: waiting.id
    });
    expect(events.map((event) => event.streamVersion)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'playbook.run.started',
        'playbook.step.completed',
        'approval.requested',
        'approval.granted',
        'playbook.run.completed'
      ])
    );
  });

  it('enforces a workspace deny policy before executing a skill', async () => {
    const database = await openTestDb();
    const now = new Date().toISOString();
    await database
      .prepare(
        `
      INSERT INTO workspace_policies (
        id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `
      )
      .run(
        id('pol'),
        DEMO_WORKSPACE_ID,
        'Block scoring',
        100,
        'skill:gtm.score-lead',
        'deny',
        '{}',
        true,
        now,
        now
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
    const skillRuns = await database
      .prepare(
        "SELECT COUNT(*)::int AS total FROM skill_runs WHERE workspace_id=? AND skill_id='gtm.score-lead'"
      )
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
    const skillRuns = await database
      .prepare(
        "SELECT COUNT(*)::int AS total FROM skill_runs WHERE workspace_id=? AND skill_id='test.external-write'"
      )
      .get<{ total: number }>(DEMO_WORKSPACE_ID);
    expect(skillRuns?.total).toBe(0);
  });

  it('fails the run cleanly, instead of throwing, when a step $refs into an empty prior-step result', async () => {
    const database = await openTestDb();
    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.missing-ref-playbook',
      payload: {},
      actorType: 'user',
      actorId: DEMO_USER_ID
    });
    expect(run.status).toBe('failed');
    expect(run.currentStepId).toBe('use');
    expect(run.steps.find((step) => step.stepId === 'list')?.status).toBe('completed');
    expect(run.steps.find((step) => step.stepId === 'use')?.status).toBe('failed');
    expect(run.error).toContain('test.needs-thing');
    const events = await listDomainEvents(database, DEMO_WORKSPACE_ID, {
      streamType: 'playbook_run',
      streamId: run.id
    });
    expect(events.map((event) => event.eventType)).toContain('playbook.step.failed');
  });

  it('executes a dedicated email action only after the exact payload is approved', async () => {
    const database = await openTestDb();
    const waiting = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.email-action-playbook',
      payload: {
        recipient: 'buyer@example.com',
        subject: 'Audit result',
        body: 'The audit is ready.'
      },
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
    expect(completed.output).toMatchObject({
      delivery: { provider: 'simulation', actionType: 'email.send' }
    });
    expect(
      (completed.output as { delivery: { externalRef: string } }).delivery.externalRef
    ).toMatch(/^sim_/);
    const events = await listDomainEvents(database, DEMO_WORKSPACE_ID, { streamId: waiting.id });
    expect(events.map((event) => event.eventType)).toContain('action.executed');
  });
});

/**
 * `playbook_step_runs` is the table the engine leases, advances and executes
 * from, and until 058 it had no `workspace_id`: a step run's tenant was
 * whatever `playbook_runs` said, discoverable only by joining back. That made
 * `WHERE playbook_run_id=?` -- the query that builds the step list every
 * `advancePlaybookRun` iteration reads -- a predicate with no tenant in it at
 * all.
 *
 * The column is nullable at this stage, so the write assertion below checks the
 * value written, not NOT NULL.
 */
describe('workspace attribution on playbook step runs', () => {
  it("writes the run's workspace on every step run, and hides a step run owned by another workspace", async () => {
    const database = await openTestDb();
    const foreignWorkspaceId = id('ws');
    const now = new Date().toISOString();
    await database
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(foreignWorkspaceId, 'Foreign tenant', now);
    try {
      const run = await startPlaybookRun(database, {
        workspaceId: DEMO_WORKSPACE_ID,
        playbookId: 'test.score-approval',
        payload: { lead: { platform: 'shopify' } },
        actorType: 'user',
        actorId: DEMO_USER_ID
      });

      const written = await database
        .prepare('SELECT workspace_id FROM playbook_step_runs WHERE playbook_run_id=?')
        .all<{ workspace_id: string | null }>(run.id);
      expect(written.length).toBeGreaterThan(0);
      expect(written.every((row) => row.workspace_id === DEMO_WORKSPACE_ID)).toBe(true);

      // A step run belonging to another tenant, parented onto this run. Its
      // status is `failed`, which is the state `advancePlaybookRun` reacts to by
      // failing the whole run -- so before the read was scoped, one foreign row
      // was enough to kill another tenant's playbook.
      await database
        .prepare(
          `
        INSERT INTO playbook_step_runs (id,workspace_id,playbook_run_id,step_id,step_type,status,attempt,available_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `
        )
        .run(id('pbs'), foreignWorkspaceId, run.id, 'ghost', 'skill', 'failed', 1, now, now);

      const raw = await database
        .prepare(
          'SELECT COUNT(*)::int AS total FROM playbook_step_runs WHERE playbook_run_id=? AND step_id=?'
        )
        .get<{ total: number }>(run.id, 'ghost');
      expect(raw?.total).toBe(1);

      const reloaded = await getPlaybookRun(database, DEMO_WORKSPACE_ID, run.id);
      expect(reloaded?.steps.map((step) => step.stepId)).not.toContain('ghost');
      expect(reloaded?.status).toBe('waiting_approval');
    } finally {
      await database.prepare('DELETE FROM workspaces WHERE id=?').run(foreignWorkspaceId);
    }
  });
});

describe('GTM-only prepared action boundary', () => {
  async function insertPolicy(
    database: Db,
    name: string,
    effect: 'allow' | 'deny' | 'require_approval',
    conditions: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();
    await database
      .prepare(
        `
        INSERT INTO workspace_policies (
          id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `
      )
      .run(
        id('pol'),
        DEMO_WORKSPACE_ID,
        name,
        100,
        'action:email.send',
        effect,
        JSON.stringify(conditions),
        true,
        now,
        now
      );
  }

  async function runEmail(database: Db) {
    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'test.email-action-playbook',
      payload: {
        recipient: 'buyer@example.com',
        subject: 'Audit result',
        body: 'The audit is ready.'
      },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });
    const completed = await decidePlaybookApproval(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      runId: run.id,
      stepId: 'approve-email',
      userId: DEMO_USER_ID,
      decision: 'approve'
    });
    return completed.steps.find((step) => step.stepId === 'send-email')?.policyDecision;
  }

  it('applies GTM recipient policy to an email action', async () => {
    const database = await openTestDb();
    await insertPolicy(database, 'Small sends only', 'allow', { maxRecipients: 3 });
    expect(await runEmail(database)).toMatchObject({
      effect: 'allow',
      policyName: 'Small sends only'
    });
  });

  it('keeps the built-in approval boundary when no auto-send policy matches', async () => {
    const database = await openTestDb();
    await insertPolicy(database, 'No bulk sends', 'allow', { maxRecipients: 0 });
    expect(await runEmail(database)).toMatchObject({
      effect: 'require_approval',
      policyId: null,
      policyName: 'Built-in external-write boundary'
    });
  });
});

/**
 * `gtm.thread-reply` is the one-row sibling of `gtm.community-outreach`:
 * same gate, same drafting skill, same approval payload shape, but no scout
 * and no score, because /research already has the thread the founder picked.
 */
describe('gtm.thread-reply playbook', () => {
  it('drafts a reply to the thread it was handed and stops for approval', async () => {
    const database = await openTestDb();
    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'gtm.thread-reply',
      payload: {
        thread: {
          platform: 'hackernews',
          externalId: '48457585',
          url: 'https://news.ycombinator.com/item?id=48457585',
          title: 'Ask HN: What works for cutting AI token costs?',
          content: 'My LLM token bill is getting painful.',
          author: 'leoncos',
          community: null,
          score: 5,
          numComments: 2,
          createdAt: '2026-06-09T07:04:29.000Z',
          metadata: {}
        },
        angle: 'cost_comparison',
        relevanceScore: 7.4,
        account: { accountAgeDays: 900, karma: 1200 },
        product: {
          name: 'Trevra',
          url: 'https://usetrevra.com',
          summary: 'A go-to-market workspace an agent operates and a human approves.',
          mechanism: 'Composite intent signals plus a hard approval gate.',
          claims: [{ label: 'Execution', value: 'Nothing sends without founder approval' }]
        }
      },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });

    expect(run.status).toBe('waiting_approval');
    const approval = run.steps.find((step) => step.stepId === 'approve-reply');
    expect(approval?.status).toBe('waiting_approval');
    expect(approval?.input).toMatchObject({
      threadUrl: 'https://news.ycombinator.com/item?id=48457585',
      metadata: { relevanceScore: 7.4 }
    });
  });

  it('fails at the gate rather than drafting into a blocked thread', async () => {
    const database = await openTestDb();
    const run = await startPlaybookRun(database, {
      workspaceId: DEMO_WORKSPACE_ID,
      playbookId: 'gtm.thread-reply',
      payload: {
        thread: {
          platform: 'reddit',
          externalId: 'blocked-1',
          url: 'https://reddit.test/blocked-1',
          title: 'token cost',
          // 'spamming' contains 'spam', which is in BLACKLISTED_KEYWORDS
          // (src/server/outreach/config.ts) -- the cheapest deterministic
          // block, since the keyword check is a substring match.
          content: 'please stop spamming this sub with promo links',
          author: 'someone',
          community: 'webdev',
          score: 3,
          numComments: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {}
        },
        account: { accountAgeDays: 900, karma: 1200 },
        product: {
          name: 'Trevra',
          url: 'https://usetrevra.com',
          summary: 'A go-to-market workspace an agent operates and a human approves.',
          mechanism: 'Composite intent signals plus a hard approval gate.',
          claims: []
        }
      },
      actorType: 'user',
      actorId: DEMO_USER_ID
    });

    expect(run.status).toBe('failed');
    expect(run.steps.find((step) => step.stepId === 'draft')?.status).not.toBe('completed');
  });
});
