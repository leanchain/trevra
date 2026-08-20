import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import Stripe from 'stripe';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomBytes } from 'node:crypto';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from './db.js';
import { createApp } from './app.js';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { registerPlaybook } from './playbooks/registry.js';
import { LINKEDIN_LIMITS, PACED_KINDS, effectiveDailyCeiling } from './linkedin/limits.js';
import { LEAD_CONTACT_READ_LIMIT } from './linkedin/lead-lists.js';
import { campaignWarmupFraction } from './linkedin/managed-campaigns.js';

/** Any start works: the campaign ramp is relative to it, never to a calendar. */
const RAMP_START = '2026-01-01T00:00:00.000Z';

/**
 * One day row out of a limits report.
 *
 * `profile_view` throughout the ceiling-source tests, and deliberately: it is a
 * PASSIVE kind, so `warmupMultiplierFor` leaves it un-ramped in week 1 and the
 * assertions are about which of the band and the operator's number bound --
 * not about a ramp that would flatten both to zero on a fresh seat.
 */
function dayCeiling(
  body: { limits: Array<Record<string, unknown>> },
  kind = 'profile_view'
): Record<string, unknown> {
  const row = body.limits.find((limit) => limit.kind === kind && limit.window === 'day');
  if (!row) throw new Error(`no day ceiling reported for ${kind}`);
  return row;
}

registerPlaybook({
  id: 'test.api-score-approval',
  version: '1.0.0',
  name: 'API score approval',
  description: 'Exercise durable workflow routes.',
  inputSchema: z.object({ lead: z.record(z.unknown()) }),
  steps: [
    {
      id: 'score',
      type: 'skill',
      skillId: 'gtm.score-lead',
      input: { lead: { $ref: '$.input.lead' } }
    },
    {
      id: 'approve',
      type: 'approval',
      title: 'Approve score',
      needs: ['score'],
      payload: { score: { $ref: '$.steps.score.output.overall' } }
    }
  ],
  output: {
    approved: { $ref: '$.steps.approve.output.approved' },
    score: { $ref: '$.steps.score.output' }
  },
  source: { type: 'builtin' }
});

/**
 * The hosted agent's transport, faked, and only when a test installs one.
 *
 * With nothing installed this falls straight through to the real lookup, so
 * every test that does not touch the agent behaves exactly as it did before.
 * No test in this file reaches the network for a model.
 */
const hostedModel = vi.hoisted(() => ({ model: null as LanguageModelV4 | null }));

vi.mock('./agent/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent/provider.js')>();
  return {
    ...actual,
    resolveWorkspaceModel: async (db: never, workspaceId: string) => {
      if (!hostedModel.model) return actual.resolveWorkspaceModel(db, workspaceId);
      return {
        model: hostedModel.model,
        modelId: 'gpt-4o-mini',
        baseUrl: 'https://model.invalid/v1'
      };
    }
  };
});

function modelAnswer(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 200, text: 200, reasoning: 0 }
    },
    warnings: []
  };
}

/** A promise the test releases by hand, so a run can be held mid-flight. */
function gate(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

async function waitForAgentRun(
  agent: Awaited<ReturnType<typeof agentWithSession>>,
  runId: string
): Promise<{ status: string; summary: string | null }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { run } = (await agent.get(`/api/agent-runs/${runId}`).expect(200)).body as {
      run: { status: string; summary: string | null };
    };
    if (run.status !== 'running') return run;
    if (Date.now() >= deadline) throw new Error(`Agent run ${runId} never finished`);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

let db: Db | undefined;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
afterEach(async () => {
  await db?.close();
  db = undefined;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.PUBLIC_REGISTRY_CORS_ORIGIN;
  delete process.env.TREVRA_SANDBOX_GATEWAY_URL;
  delete process.env.TREVRA_SANDBOX_GATEWAY_TOKEN;
  delete process.env.TRACTION_ADMIN_TOKEN;
  delete process.env.MARKETING_HASH_SALT;
  delete process.env.INDEXNOW_KEY;
  delete process.env.TREVRA_AGENT_TOKEN_PEPPER;
  delete process.env.TREVRA_SECRETS_KEY;
});

async function agentWithSession() {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  const agent = request.agent(createApp(db));
  await agent.post('/api/auth/demo').expect(200);
  return agent;
}

let signUpSeq = 0;

/**
 * A real better-auth user, signed up through the real route.
 *
 * The demo cookie resolves to `role: 'owner'` unconditionally (see
 * `readSession`), so it can never exercise a member. Every owner-only test
 * below needs a genuine organization membership, which means genuine sign-ups.
 */
async function signUpAgent(app: ReturnType<typeof createApp>, label: string) {
  signUpSeq += 1;
  const email = `${label}-${Date.now()}-${signUpSeq}@example.test`;
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  return { agent, email, userId: (res.body as { user: { id: string } }).user.id };
}

async function sessionAuth(agent: ReturnType<typeof request.agent>) {
  const res = await agent.get('/api/auth/session').expect(200);
  return (res.body as { auth: { userId: string; workspaceId: string; role: 'owner' | 'member' } })
    .auth;
}

/** An owner and a teammate who has accepted into the owner's workspace. */
async function ownerAndMember(app: ReturnType<typeof createApp>) {
  const owner = await signUpAgent(app, 'owner');
  const ownerAuth = await sessionAuth(owner.agent);
  const member = await signUpAgent(app, 'mate');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: ownerAuth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: ownerAuth.workspaceId })
    .expect(200);
  const memberAuth = await sessionAuth(member.agent);
  expect(memberAuth.workspaceId).toBe(ownerAuth.workspaceId);
  expect(memberAuth.role).toBe('member');
  return { owner, ownerAuth, member };
}

describe('Trevra API on PostgreSQL', () => {
  it('publishes canonical search, AI, and security discovery resources', async () => {
    process.env.PUBLIC_SITE_URL = 'https://trevra.example';
    process.env.INDEXNOW_KEY = 'trevra-indexnow-key-12345678';
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    expect((await request(app).get('/robots.txt').expect(200)).text).toContain(
      'Sitemap: https://trevra.example/sitemap.xml'
    );
    expect((await request(app).get('/sitemap.xml').expect(200)).text).toContain(
      '<loc>https://trevra.example/how-it-works</loc>'
    );
    expect((await request(app).get('/llms.txt').expect(200)).text).toContain('# Trevra');
    expect((await request(app).get('/agents.md').expect(200)).text).toContain('Restricted areas');
    expect((await request(app).get('/.well-known/security.txt').expect(200)).text).toContain(
      'Canonical: https://trevra.example/.well-known/security.txt'
    );
    expect((await request(app).get('/trevra-indexnow-key-12345678.txt').expect(200)).text).toBe(
      'trevra-indexnow-key-12345678'
    );
  });

  it('records privacy-preserving attribution and protects aggregate traction', async () => {
    process.env.TRACTION_ADMIN_TOKEN = 'traction-token-with-at-least-32-characters';
    process.env.MARKETING_HASH_SALT = 'marketing-salt-with-at-least-32-characters';
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const visitorId = 'visitor-12345678';
    await request(app)
      .post('/api/marketing/events')
      .send({ eventName: 'page_view', visitorId, source: 'search', campaign: 'launch' })
      .expect(202);
    const stored = await db
      .prepare(
        "SELECT visitor_hash,source,campaign FROM marketing_events WHERE event_name='page_view' ORDER BY created_at DESC LIMIT 1"
      )
      .get<{ visitor_hash: string; source: string; campaign: string }>();
    expect(stored?.visitor_hash).not.toBe(visitorId);
    expect(stored?.visitor_hash).toHaveLength(64);
    await request(app).get('/api/internal/traction').expect(401);
    const report = await request(app)
      .get('/api/internal/traction?days=30')
      .set('Authorization', `Bearer ${process.env.TRACTION_ADMIN_TOKEN}`)
      .expect(200);
    expect(report.body.funnel.pageViews).toBeGreaterThanOrEqual(1);
    expect(report.body.funnel.uniqueVisitors).toBeGreaterThanOrEqual(1);
    expect(report.body.sources.some((item: { source: string }) => item.source === 'search')).toBe(
      true
    );
  });

  it('publishes aggregate module popularity without leaking workspace data', async () => {
    process.env.PUBLIC_REGISTRY_CORS_ORIGIN = 'https://www.trevra.example';
    const agent = await agentWithSession();
    await agent
      .post('/api/skills/gtm.score-lead/run')
      .send({ lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } })
      .expect(201);
    const response = await agent
      .get('/api/public/modules')
      .set('Origin', 'https://www.trevra.example')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://www.trevra.example');
    const module = response.body.modules.find(
      (item: { id: string }) => item.id === 'gtm.score-lead'
    );
    expect(module.popularity.totalRuns).toBeGreaterThan(0);
    expect(module.popularity.successRate).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain(DEMO_WORKSPACE_ID);
    expect(JSON.stringify(response.body)).not.toContain('northstar.studio');
  });

  it('exposes the usable email auth mode without showing a dead password form', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const config = (await request(app).get('/api/public-config').expect(200)).body as {
      magicLinkAuthEnabled: boolean;
      emailPasswordAuthEnabled: boolean;
    };
    expect(typeof config.magicLinkAuthEnabled).toBe('boolean');
    expect(typeof config.emailPasswordAuthEnabled).toBe('boolean');
    expect(config.magicLinkAuthEnabled && config.emailPasswordAuthEnabled).toBe(false);
  });

  it('exposes Google OAuth only when both credentials are configured', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    expect((await request(app).get('/api/public-config').expect(200)).body.googleAuthEnabled).toBe(
      false
    );
    process.env.GOOGLE_CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    expect((await request(app).get('/api/public-config').expect(200)).body.googleAuthEnabled).toBe(
      true
    );
  });

  it('rejects state-changing requests from untrusted browser origins', async () => {
    const agent = await agentWithSession();
    await agent
      .post('/api/agent-runs')
      .set('Origin', 'https://malicious.example')
      .send({ goal: 'test' })
      .expect(403);
  });

  it('returns the four-section shell dashboard without Money data', async () => {
    const agent = await agentWithSession();
    const response = await agent.get('/api/dashboard').expect(200);
    expect(response.body.workspace).toBeTruthy();
    expect(response.body.metrics).toEqual(
      expect.objectContaining({ connectedSources: expect.any(Number) })
    );
    expect(Object.keys(response.body.metrics)).toEqual(['connectedSources']);
    expect(response.body).not.toHaveProperty('recommendations');
    expect(response.body).not.toHaveProperty('clients');
    expect(response.body).not.toHaveProperty('automationRules');
  });

  it('does not expose the removed Money HTTP surface', async () => {
    const agent = await agentWithSession();
    await agent.get('/api/recommendations').expect(404);
    await agent.post('/api/automation/run').expect(404);
    await agent.post('/api/imports/marketplace').send({ provider: 'upwork', csv: 'x' }).expect(404);
    await agent.get('/api/clients/client_x').expect(404);
  });

  it('creates a real account and maps it to an isolated Trevra workspace', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const agent = request.agent(createApp(db));
    const email = `founder-${Date.now()}@example.com`;
    await agent
      .post('/api/auth/sign-up/email')
      .send({ name: 'Independent Alex', email, password: 'correct-horse-battery-staple' })
      .expect(200);
    const dashboard = await agent.get('/api/dashboard').expect(200);
    expect(dashboard.body.workspace.name).toBe("Independent Alex's Studio");
    expect(dashboard.body.metrics).toEqual(expect.objectContaining({ connectedSources: 0 }));
    const mapped = await db
      .prepare('SELECT workspace_id FROM users WHERE email=?')
      .get<{ workspace_id: string }>(email);
    expect(mapped?.workspace_id).toBe(dashboard.body.workspace.id);
  });

  it('creates scoped agent tokens and runs skills through the agent API', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const browser = request.agent(app);
    await browser.post('/api/auth/demo').expect(200);

    const created = await browser
      .post('/api/agent-tokens')
      .send({ name: 'Claude Code test' })
      .expect(201);
    expect(created.body.token).toMatch(/^trv_live_/);
    expect(created.body.record.scopes).toEqual([
      'skills:read',
      'skills:run',
      'runs:read',
      'workspace:read',
      'actions:prepare',
      'playbooks:read',
      'playbooks:run',
      'workflows:read'
    ]);

    const listedTokens = await browser.get('/api/agent-tokens').expect(200);
    expect(listedTokens.body.tokens[0].prefix).toBe(created.body.record.prefix);
    expect(JSON.stringify(listedTokens.body)).not.toContain(created.body.token);

    const authorization = `Bearer ${created.body.token}`;
    const skills = await request(app)
      .get('/api/agent/skills')
      .set('Authorization', authorization)
      .expect(200);
    const scoreManifest = skills.body.skills.find(
      (skill: { id: string }) => skill.id === 'gtm.score-lead'
    );
    expect(scoreManifest.enabled).toBe(true);
    expect(scoreManifest.inputSchema.type).toBe('object');

    const executed = await request(app)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', authorization)
      .send({ lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } })
      .expect(201);
    expect(executed.body.run.status).toBe('ok');
    expect(executed.body.run.output.wedge).toBe('sizing');
    expect(executed.body.approvalRequired).toBe(false);

    const runs = await request(app)
      .get('/api/agent/runs?skillId=gtm.score-lead')
      .set('Authorization', authorization)
      .expect(200);
    expect(runs.body.runs.some((run: { id: string }) => run.id === executed.body.run.id)).toBe(
      true
    );
    await request(app)
      .get(`/api/agent/runs/${executed.body.run.id}`)
      .set('Authorization', authorization)
      .expect(200);

    // Removed agent-Money endpoints are no longer agent-token routes; the normal session boundary rejects the token.
    await request(app)
      .get('/api/agent/revenue-brief')
      .set('Authorization', authorization)
      .expect(401);
    await request(app).get('/api/agent/actions').set('Authorization', authorization).expect(401);

    // An agent token is not a browser session and cannot reach the rest of the product API.
    await request(app).get('/api/dashboard').set('Authorization', authorization).expect(401);

    await browser.delete(`/api/agent-tokens/${created.body.record.id}`).expect(200);
    await request(app).get('/api/agent/skills').set('Authorization', authorization).expect(401);
  });

  it('serves the same skill catalog over authenticated Streamable HTTP MCP', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const browser = request.agent(app);
    await browser.post('/api/auth/demo').expect(200);
    const created = await browser
      .post('/api/agent-tokens')
      .send({ name: 'Remote MCP test' })
      .expect(201);

    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('MCP test server did not bind');
    const mcp = new Client({ name: 'remote-trevra-test', version: '1.0.0' });
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/api/agent/mcp`),
          { requestInit: { headers: { Authorization: `Bearer ${created.body.token}` } } }
        )
      );
      const tools = await mcp.listTools();
      expect(tools.tools.some((tool) => tool.name === 'trevra_gtm_score-lead')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_revenue_brief')).toBe(false);
      expect(tools.tools.some((tool) => tool.name === 'trevra_prepare_recommendation')).toBe(false);
      expect(tools.tools.some((tool) => tool.name === 'trevra_list_pending_actions')).toBe(false);
      expect(tools.tools.some((tool) => tool.name === 'trevra_list_playbooks')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_start_playbook')).toBe(true);
      const result = await mcp.callTool({
        name: 'trevra_gtm_score-lead',
        arguments: { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } }
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((item) => item.type === 'text')?.text;
      expect(text ? JSON.parse(text).run.output.wedge : null).toBe('sizing');
    } finally {
      await mcp.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('enforces agent-token scopes', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const browser = request.agent(app);
    await browser.post('/api/auth/demo').expect(200);
    const created = await browser
      .post('/api/agent-tokens')
      .send({
        name: 'Read-only agent',
        scopes: ['skills:read']
      })
      .expect(201);
    const authorization = `Bearer ${created.body.token}`;
    await request(app).get('/api/agent/skills').set('Authorization', authorization).expect(200);
    await request(app)
      .post('/api/agent/skills/gtm.score-lead/run')
      .set('Authorization', authorization)
      .send({ lead: {} })
      .expect(403);
    await request(app).get('/api/agent/runs').set('Authorization', authorization).expect(403);
  });

  it('starts, inspects, approves, and audits a durable playbook through the API', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const browser = request.agent(app);
    await browser.post('/api/auth/demo').expect(200);

    const catalog = await browser.get('/api/playbooks').expect(200);
    expect(
      catalog.body.playbooks.some(
        (playbook: { id: string }) => playbook.id === 'test.api-score-approval'
      )
    ).toBe(true);

    const started = await browser
      .post('/api/playbooks/test.api-score-approval/runs')
      .send({
        input: { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } }
      })
      .expect(201);
    expect(started.body.run.status).toBe('waiting_approval');
    const runId = started.body.run.id as string;
    const approval = started.body.run.steps.find(
      (step: { status: string }) => step.status === 'waiting_approval'
    );
    expect(approval.approvalPayloadHash).toHaveLength(64);

    const inspected = await browser.get(`/api/playbook-runs/${runId}`).expect(200);
    expect(inspected.body.run.currentStepId).toBe('approve');

    const decided = await browser
      .post(`/api/playbook-runs/${runId}/steps/approve/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(decided.body.run.status).toBe('completed');
    expect(decided.body.run.output).toMatchObject({ approved: true, score: { wedge: 'sizing' } });

    const events = await browser
      .get(`/api/control-plane/events?streamType=playbook_run&streamId=${runId}`)
      .expect(200);
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toContain(
      'playbook.run.completed'
    );
    expect(
      events.body.events.map((event: { streamVersion: number }) => event.streamVersion)
    ).toEqual(events.body.events.map((_: unknown, index: number) => index + 1));

    const created = await browser
      .post('/api/agent-tokens')
      .send({ name: 'Workflow agent' })
      .expect(201);
    const authorization = `Bearer ${created.body.token}`;
    await request(app).get('/api/agent/playbooks').set('Authorization', authorization).expect(200);
    await request(app)
      .get(`/api/agent/playbook-runs/${runId}`)
      .set('Authorization', authorization)
      .expect(200);
    await request(app)
      .post(`/api/playbook-runs/${runId}/steps/approve/decision`)
      .set('Authorization', authorization)
      .send({ decision: 'approve' })
      .expect(401);
  });

  it('verifies and deduplicates Stripe payment webhooks', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    const agent = await agentWithSession();
    const payload = JSON.stringify({
      id: 'evt_trevra_paid',
      object: 'event',
      api_version: '2025-06-30.basil',
      created: Math.floor(Date.now() / 1000),
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test',
          object: 'invoice',
          number: 'INV-104',
          amount_paid: 185000,
          currency: 'eur',
          metadata: { trevra_workspace_id: 'ws_demo', trevra_invoice_id: 'inv_acme_104' },
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) }
        }
      }
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET
    });
    await agent
      .post('/api/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(202);
    await agent
      .post('/api/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(200);
    const invoice = await db!
      .prepare("SELECT status,paid_at FROM invoices WHERE id='inv_acme_104'")
      .get<{ status: string; paid_at: string | null }>();
    expect(invoice?.status).toBe('paid');
    expect(invoice?.paid_at).not.toBeNull();
  });

  it('reports BYOK availability and starts a workspace with no key, no endpoint, and the default budget', async () => {
    delete process.env.TREVRA_SECRETS_KEY;
    const agent = await agentWithSession();
    const off = await agent.get('/api/agent-setup').expect(200);
    expect(off.body.available).toBe(false);
    expect(off.body.config).toBeNull();
    expect(off.body.secret).toBeNull();
    expect(off.body.budget).toMatchObject({ monthlyCapCents: 2000, spentCents: 0, enabled: false });

    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    expect((await agent.get('/api/agent-setup').expect(200)).body.available).toBe(true);
  });

  it('stores a model key write-only and never returns it anywhere', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const agent = await agentWithSession();
    const apiKey = 'trv-model-key-for-tests-3f9d2b7c4a81';

    const stored = await agent
      .put('/api/agent-setup/key')
      .send({ apiKey, label: 'Anthropic' })
      .expect(200);
    expect(stored.body.secret).toMatchObject({
      kind: 'model_api_key',
      last4: '4a81',
      label: 'Anthropic',
      keyVersion: 2
    });
    expect(JSON.stringify(stored.body)).not.toContain(apiKey);

    const setup = await agent.get('/api/agent-setup').expect(200);
    expect(setup.body.secret).toMatchObject({ last4: '4a81', label: 'Anthropic' });
    expect(JSON.stringify(setup.body)).not.toContain(apiKey);

    const row = await db!
      .prepare('SELECT ciphertext FROM workspace_secrets WHERE workspace_id=?')
      .get<{ ciphertext: Buffer }>(DEMO_WORKSPACE_ID);
    expect(row?.ciphertext.toString('utf8')).not.toContain(apiKey);
    const audit = await db!
      .prepare("SELECT metadata_json FROM audit_events WHERE event_type='workspace_secret.updated'")
      .get<{ metadata_json: string }>();
    expect(audit?.metadata_json).not.toContain(apiKey);
  });

  it('refuses to store a model key when the server holds no encryption key', async () => {
    delete process.env.TREVRA_SECRETS_KEY;
    const agent = await agentWithSession();
    // A delta, not an absolute count: every test file in the run shares one
    // database and several of them legitimately store secrets, so `= 0` was an
    // assertion about file order rather than about this request.
    const countSecrets = async () =>
      (
        await db!
          .prepare('SELECT COUNT(*)::int AS count FROM workspace_secrets')
          .get<{ count: number }>()
      )?.count ?? 0;
    const before = await countSecrets();
    const response = await agent
      .put('/api/agent-setup/key')
      .send({ apiKey: 'trv-model-key-never-stored' })
      .expect(400);
    expect(response.body.error).toContain('TREVRA_SECRETS_KEY');
    expect(await countSecrets()).toBe(before);
  });

  it('deletes a stored model key', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const agent = await agentWithSession();
    await agent
      .put('/api/agent-setup/key')
      .send({ apiKey: 'trv-model-key-to-delete-8821' })
      .expect(200);
    expect((await agent.delete('/api/agent-setup/key').expect(200)).body.deleted).toBe(true);
    expect((await agent.get('/api/agent-setup').expect(200)).body.secret).toBeNull();
    expect((await agent.delete('/api/agent-setup/key').expect(200)).body.deleted).toBe(false);
  });

  it('refuses a model endpoint that is not HTTPS', async () => {
    const agent = await agentWithSession();
    const rejected = await agent
      .put('/api/agent-setup/config')
      .send({ baseUrl: 'http://api.example.com/v1', model: 'gpt-4o-mini' })
      .expect(400);
    expect(rejected.body.error).toContain('HTTPS');

    const saved = await agent
      .put('/api/agent-setup/config')
      .send({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI' })
      .expect(200);
    expect(saved.body.config).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      label: 'OpenAI'
    });
    expect((await agent.get('/api/agent-setup').expect(200)).body.config.model).toBe('gpt-4o-mini');
  });

  it('sets the spend cap and the kill switch, and refuses a cap above the ceiling', async () => {
    const agent = await agentWithSession();
    const updated = await agent
      .put('/api/agent-setup/budget')
      .send({ monthlyCapCents: 5000, enabled: true })
      .expect(200);
    expect(updated.body.budget).toMatchObject({
      monthlyCapCents: 5000,
      spentCents: 0,
      enabled: true
    });
    expect((await agent.get('/api/agent-setup').expect(200)).body.budget).toMatchObject({
      monthlyCapCents: 5000,
      enabled: true
    });

    const rejected = await agent
      .put('/api/agent-setup/budget')
      .send({ monthlyCapCents: 1_000_001 })
      .expect(400);
    expect(JSON.stringify(rejected.body)).toContain('$10,000');
    expect((await agent.get('/api/agent-setup').expect(200)).body.budget.monthlyCapCents).toBe(
      5000
    );
  });

  it('keeps one workspace out of another workspace BYOK setup', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const owner = request.agent(app);
    await owner.post('/api/auth/demo').expect(200);
    const apiKey = 'trv-model-key-owned-by-demo-9c2f';
    await owner.put('/api/agent-setup/key').send({ apiKey, label: 'Owner' }).expect(200);
    await owner
      .put('/api/agent-setup/config')
      .send({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })
      .expect(200);

    const intruder = request.agent(app);
    await intruder
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Other Founder',
        email: `other-${Date.now()}@example.com`,
        password: 'correct-horse-battery-staple'
      })
      .expect(200);
    const theirs = await intruder.get('/api/agent-setup').expect(200);
    expect(theirs.body.secret).toBeNull();
    expect(theirs.body.config).toBeNull();
    expect(JSON.stringify(theirs.body)).not.toContain(apiKey);
    expect((await intruder.delete('/api/agent-setup/key').expect(200)).body.deleted).toBe(false);

    const still = await owner.get('/api/agent-setup').expect(200);
    expect(still.body.secret.last4).toBe('9c2f');
    expect(still.body.config.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('reports the CLI subscription setup as unset by default', async () => {
    const agent = await agentWithSession();
    const setup = await agent.get('/api/agent-setup').expect(200);
    expect(setup.body.cli).toEqual({
      config: null,
      tokenStored: false,
      tokenCustody: null,
      tokenKeyId: null,
      riskAccepted: false
    });
  });

  it('saves the subscription CLI and model, visible before any risk is accepted', async () => {
    const agent = await agentWithSession();
    const saved = await agent
      .put('/api/agent-setup/cli-config')
      .send({ cli: 'codex', model: 'gpt-5-codex' })
      .expect(200);
    expect(saved.body.config).toEqual({ cli: 'codex', model: 'gpt-5-codex' });

    const setup = await agent.get('/api/agent-setup').expect(200);
    expect(setup.body.cli).toEqual({
      config: { cli: 'codex', model: 'gpt-5-codex' },
      tokenStored: false,
      tokenCustody: null,
      tokenKeyId: null,
      riskAccepted: false
    });

    await agent.put('/api/agent-setup/cli-config').send({ cli: 'gemini', model: 'x' }).expect(400);
    await agent.put('/api/agent-setup/cli-config').send({ cli: 'claude', model: '' }).expect(400);
  });

  it('refuses to accept the CLI risk before a CLI and model are saved, then accepts and revokes in one click', async () => {
    const agent = await agentWithSession();

    const early = await agent
      .put('/api/agent-setup/cli-risk-accept')
      .send({ accepted: true })
      .expect(400);
    expect(early.body.error).toMatch(/CLI and model/i);

    await agent
      .put('/api/agent-setup/cli-config')
      .send({ cli: 'claude', model: 'sonnet' })
      .expect(200);

    const accepted = await agent
      .put('/api/agent-setup/cli-risk-accept')
      .send({ accepted: true })
      .expect(200);
    expect(accepted.body.riskAccepted).toBe(true);
    expect((await agent.get('/api/agent-setup').expect(200)).body.cli.riskAccepted).toBe(true);

    // Revocable in one click: `false` clears it back to unaccepted immediately,
    // not on the next save of something else.
    const revoked = await agent
      .put('/api/agent-setup/cli-risk-accept')
      .send({ accepted: false })
      .expect(200);
    expect(revoked.body.riskAccepted).toBe(false);
    expect((await agent.get('/api/agent-setup').expect(200)).body.cli.riskAccepted).toBe(false);

    // Revoking with nothing to revoke is a harmless no-op, never a 400.
    await agent.put('/api/agent-setup/cli-risk-accept').send({ accepted: false }).expect(200);
  });

  it('stores the subscription token write-only behind the secrets-key gate, and never returns it anywhere', async () => {
    delete process.env.TREVRA_SECRETS_KEY;
    const agent = await agentWithSession();
    const refused = await agent
      .put('/api/agent-setup/cli-token')
      .send({ token: 'sk-ant-oat01-should-not-store' })
      .expect(400);
    expect(refused.body.error).toContain('TREVRA_SECRETS_KEY');

    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const token = 'sk-ant-oat01-trevra-cli-token-test-9f3c1d2b';
    const stored = await agent.put('/api/agent-setup/cli-token').send({ token }).expect(200);
    expect(JSON.stringify(stored.body)).not.toContain(token);

    const setup = await agent.get('/api/agent-setup').expect(200);
    expect(setup.body.cli.tokenStored).toBe(true);
    expect(JSON.stringify(setup.body)).not.toContain(token);

    const row = await db!
      .prepare(
        "SELECT ciphertext FROM workspace_secrets WHERE workspace_id=? AND kind='cli_oauth_token'"
      )
      .get<{ ciphertext: Buffer }>(DEMO_WORKSPACE_ID);
    expect(row?.ciphertext.toString('utf8')).not.toContain(token);

    expect((await agent.delete('/api/agent-setup/cli-token').expect(200)).body.deleted).toBe(true);
    expect((await agent.get('/api/agent-setup').expect(200)).body.cli.tokenStored).toBe(false);
    expect((await agent.delete('/api/agent-setup/cli-token').expect(200)).body.deleted).toBe(false);
  });

  it('requires a session for every CLI subscription route', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    await request(app).get('/api/agent-setup').expect(401);
    await request(app)
      .put('/api/agent-setup/cli-config')
      .send({ cli: 'claude', model: 'sonnet' })
      .expect(401);
    await request(app).put('/api/agent-setup/cli-token').send({ token: 'x' }).expect(401);
    await request(app).delete('/api/agent-setup/cli-token').expect(401);
    await request(app).put('/api/agent-setup/cli-risk-accept').send({ accepted: true }).expect(401);
  });

  // The same limiter as the auth routes and the model-key route: a subscription
  // token is a credential endpoint too, whatever the session already proves.
  // The demo sign-in inside `agentWithSession` already spends one of the
  // limiter's 30 requests for this app instance, so 30 more trips it.
  it('rate-limits the subscription token route like the other credential endpoints', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const agent = await agentWithSession();
    let last: { status: number } | undefined;
    for (let i = 0; i < 30; i += 1) {
      last = await agent
        .put('/api/agent-setup/cli-token')
        .send({ token: `trv-cli-token-rate-${i}` });
    }
    expect(last?.status).toBe(429);
  });

  it('keeps one workspace out of another workspace CLI subscription setup', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const owner = request.agent(app);
    await owner.post('/api/auth/demo').expect(200);
    await owner
      .put('/api/agent-setup/cli-config')
      .send({ cli: 'claude', model: 'sonnet' })
      .expect(200);
    await owner.put('/api/agent-setup/cli-risk-accept').send({ accepted: true }).expect(200);
    const token = 'sk-ant-oat01-owned-by-demo-workspace';
    await owner.put('/api/agent-setup/cli-token').send({ token }).expect(200);

    const intruder = request.agent(app);
    await intruder
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Other Founder',
        email: `other-cli-${Date.now()}@example.com`,
        password: 'correct-horse-battery-staple'
      })
      .expect(200);
    const theirs = await intruder.get('/api/agent-setup').expect(200);
    expect(theirs.body.cli).toEqual({
      config: null,
      tokenStored: false,
      tokenCustody: null,
      tokenKeyId: null,
      riskAccepted: false
    });
    expect(JSON.stringify(theirs.body)).not.toContain(token);
    expect((await intruder.delete('/api/agent-setup/cli-token').expect(200)).body.deleted).toBe(
      false
    );

    const still = await owner.get('/api/agent-setup').expect(200);
    expect(still.body.cli).toMatchObject({
      config: { cli: 'claude', model: 'sonnet' },
      tokenStored: true,
      riskAccepted: true
    });
    // Custody, not merely presence: a deployment holding the wrong server key
    // reports the token as stored and then 500s at use time, and this field is
    // the difference between a green setup screen and an honest one.
    expect(still.body.cli.tokenCustody).toBe('current');
  });

  it('reads agent runs and stops them whatever the budget says', async () => {
    const agent = await agentWithSession();
    expect((await agent.get('/api/agent-runs').expect(200)).body.runs).toEqual([]);
    await agent.get('/api/agent-runs/run_does_not_exist').expect(404);
    // The kill switch answers with spending off, which is the default state.
    expect((await agent.post('/api/agent-runs/stop').expect(200)).body.stopped).toBe(0);
  });

  it('starts an agent run and answers before the run has finished', async () => {
    // The model is held here for the whole request. If the route waited for the
    // run, this test would hang rather than fail -- which is the point: there is
    // no timing threshold that could pass while the request is still blocked.
    const model = gate();
    hostedModel.model = new MockLanguageModelV4({
      modelId: 'gpt-4o-mini',
      doGenerate: async () => {
        await model.held;
        return modelAnswer('Nothing needs a human right now.');
      }
    });

    const agent = await agentWithSession();
    await agent.put('/api/agent-setup/budget').send({ enabled: true }).expect(200);

    const goal = 'Check what is waiting for a decision';
    const startedAt = Date.now();
    const created = await agent.post('/api/agent-runs').send({ goal }).expect(201);
    const elapsedMs = Date.now() - startedAt;

    expect(created.body.run).toMatchObject({
      status: 'running',
      trigger: 'manual',
      goal,
      stepCount: 0
    });
    expect(elapsedMs).toBeLessThan(2_000);
    // Still going, with the model still blocked: the run really is detached.
    expect(
      (await agent.get(`/api/agent-runs/${created.body.run.id}`).expect(200)).body.run.status
    ).toBe('running');

    model.release();
    const finished = await waitForAgentRun(agent, created.body.run.id);
    expect(finished.status).toBe('completed');
    expect(finished.summary).toContain('Nothing needs a human');

    hostedModel.model = null;
  });

  it('refuses to start a run while agent spending is off, and records nothing', async () => {
    hostedModel.model = null;
    const agent = await agentWithSession();
    const refused = await agent
      .post('/api/agent-runs')
      .send({ goal: 'Spend money nobody agreed to' })
      .expect(409);
    expect(refused.body.error).toBe('Agent spending is off. Turn it on in Setup.');
    expect((await agent.get('/api/agent-runs').expect(200)).body.runs).toEqual([]);
  });

  it('refuses a run with no goal or an oversized one', async () => {
    hostedModel.model = null;
    const agent = await agentWithSession();
    await agent.put('/api/agent-setup/budget').send({ enabled: true }).expect(200);

    await agent.post('/api/agent-runs').send({}).expect(400);
    await agent.post('/api/agent-runs').send({ goal: '   ' }).expect(400);
    await agent
      .post('/api/agent-runs')
      .send({ goal: 'x'.repeat(2001) })
      .expect(400);
    await agent.post('/api/agent-runs').send({ goal: 'fine', maxSteps: 0 }).expect(400);

    expect((await agent.get('/api/agent-runs').expect(200)).body.runs).toEqual([]);
  });

  it('turns the unattended schedule on, off by default, and refuses a cadence outside the window', async () => {
    const agent = await agentWithSession();
    expect((await agent.get('/api/agent-setup').expect(200)).body.schedule).toBeNull();

    const saved = await agent
      .put('/api/agent-setup/schedule')
      .send({ enabled: true, goal: 'Review the week', intervalMinutes: 60 })
      .expect(200);
    expect(saved.body.schedule).toMatchObject({
      enabled: true,
      goal: 'Review the week',
      intervalMinutes: 60
    });
    expect((await agent.get('/api/agent-setup').expect(200)).body.schedule).toMatchObject({
      enabled: true,
      intervalMinutes: 60,
      lastRunAt: null
    });

    await agent.put('/api/agent-setup/schedule').send({ intervalMinutes: 14 }).expect(400);
    await agent.put('/api/agent-setup/schedule').send({ intervalMinutes: 10_081 }).expect(400);
    await agent.put('/api/agent-setup/schedule').send({}).expect(400);
    expect((await agent.get('/api/agent-setup').expect(200)).body.schedule.intervalMinutes).toBe(
      60
    );

    // Left off, so this file cannot hand a live schedule to another one.
    await agent.put('/api/agent-setup/schedule').send({ enabled: false }).expect(200);
  });

  /**
   * An inverted working window is the ordinary way to get this form wrong --
   * 18:00 in the start box, 08:00 in the end box -- and each field is valid on
   * its own, so zod cannot be the one to catch it. It used to reach seats.ts,
   * throw a plain Error and answer 500, which tells an operator their input was
   * fine and the server is broken.
   */
  it('refuses an inverted LinkedIn working window with a 400 and the rule it broke', async () => {
    const agent = await agentWithSession();
    await agent
      .put('/api/linkedin/seat')
      .send({ label: 'Founder', timezone: 'Europe/Zurich' })
      .expect(200);

    const refused = await agent
      .put('/api/linkedin/seat')
      .send({ workStartMinute: 1080, workEndMinute: 480 })
      .expect(400);
    expect(refused.body.error).toBe(
      'Working hours must be whole minutes in one local day, with the end after the start.'
    );

    // The seat is untouched: a refused patch writes nothing.
    const seat = await agent.get('/api/linkedin/seat').expect(200);
    expect(seat.body.seat).toMatchObject({ workStartMinute: 480, workEndMinute: 1080 });
  });

  /**
   * The seat's own opt-in, and the three tables a screen would otherwise keep
   * its own copy of. Every assertion here is against the module that owns the
   * number, never a literal: a test that restates 50 InMails a month passes
   * while the API reports something else.
   */
  it('reports the operator ranges, the seat bands and the campaign ramp with the limits', async () => {
    const agent = await agentWithSession();
    await agent
      .put('/api/linkedin/seat')
      .send({ label: 'Founder', timezone: 'Europe/Zurich' })
      .expect(200);

    const before = await agent.get('/api/linkedin/limits').expect(200);
    expect(before.body.seat.safetyBandOverride).toBe(false);

    // The ranges the PUT validates against ARE the ranges it reports, which is
    // what stops a control being built for a number the route refuses.
    expect(before.body.operatorRanges).toEqual({
      invite: { min: 0, max: 75, default: 30 },
      message: { min: 0, max: 75, default: 25 },
      profileView: { min: 0, max: 100, default: 25 },
      follow: { min: 0, max: 50, default: 20 }
    });
    await agent
      .put('/api/linkedin/seat')
      .send({ dailyInviteLimit: before.body.operatorRanges.invite.max })
      .expect(200);
    await agent
      .put('/api/linkedin/seat')
      .send({ dailyInviteLimit: before.body.operatorRanges.invite.max + 1 })
      .expect(400);

    // Read off LINKEDIN_LIMITS for the band this seat is actually in.
    const band = before.body.seat.band as 'warmup' | 'steady';
    for (const kind of PACED_KINDS) {
      expect(before.body.bands[kind]).toEqual(LINKEDIN_LIMITS[kind][band]);
    }

    // Days 1..5 at 20% a step, ending at the seat's full ceiling.
    const ramp: number[] = before.body.campaignWarmupFractions;
    expect(ramp).toHaveLength(5);
    expect(ramp[0]).toBeCloseTo(0.2, 10);
    expect(ramp.at(-1)).toBe(1);
    ramp.forEach((fraction, index) =>
      expect(fraction).toBeCloseTo(
        campaignWarmupFraction(RAMP_START, new Date(Date.parse(RAMP_START) + index * 86_400_000)),
        10
      )
    );

    // The opt-in is a seat field, saved and read back like every other one.
    const saved = await agent
      .put('/api/linkedin/seat')
      .send({ safetyBandOverride: true })
      .expect(200);
    expect(saved.body.seat.safetyBandOverride).toBe(true);
    expect((await agent.get('/api/linkedin/limits').expect(200)).body.seat.safetyBandOverride).toBe(
      true
    );
    expect(
      (await agent.put('/api/linkedin/seat').send({ safetyBandOverride: false }).expect(200)).body
        .seat.safetyBandOverride
    ).toBe(false);
  });

  /**
   * THE NUMBER ON THE SCREEN IS THE NUMBER THAT WILL BE ENFORCED.
   *
   * This report used to read the band alone, so an operator who set 5 was shown
   * 15 -- and `pacing.ts` and `guard.ts`, which both go through
   * `effectiveDailyCeiling`, would then honour the 5 the screen never mentioned.
   * A limits screen quoting a ceiling nothing downstream applies is the exact
   * defect class this pass exists to close.
   */
  it('reports the operator ceiling, not the band, when the account sets a stricter one', async () => {
    const agent = await agentWithSession();
    await agent
      .put('/api/linkedin/seat')
      .send({ label: 'Founder', timezone: 'Europe/Zurich' })
      .expect(200);

    const band = LINKEDIN_LIMITS.profile_view.warmup.perDay;
    const mine = 5;
    expect(mine).toBeLessThan(band);
    await agent.put('/api/linkedin/seat').send({ dailyProfileViewLimit: mine }).expect(200);

    const day = dayCeiling((await agent.get('/api/linkedin/limits').expect(200)).body);
    expect(day).toMatchObject({
      ceiling: effectiveDailyCeiling(band, mine, false),
      bandCeiling: band,
      operatorLimit: mine,
      ceilingSource: 'operator',
      boundBy: 'operator-daily-limit'
    });
    expect(day.ceiling).toBe(mine);
    expect(day.rule).toContain('stricter');
  });

  /**
   * The opt-in, and the one thing it does: the operator's number binds ABOVE
   * the researched band. Asserted against the same seat before and after, so
   * the difference can only be the flag.
   */
  it('reports the operator ceiling above the band once the account is opted out of the safety bands', async () => {
    const agent = await agentWithSession();
    await agent
      .put('/api/linkedin/seat')
      .send({ label: 'Founder', timezone: 'Europe/Zurich' })
      .expect(200);

    const band = LINKEDIN_LIMITS.profile_view.warmup.perDay;
    const mine = band + 25;
    await agent.put('/api/linkedin/seat').send({ dailyProfileViewLimit: mine }).expect(200);

    // Opted out: the stricter of the two binds, and it is Trevra's.
    const capped = dayCeiling((await agent.get('/api/linkedin/limits').expect(200)).body);
    expect(capped).toMatchObject({
      ceiling: effectiveDailyCeiling(band, mine, false),
      operatorLimit: mine,
      ceilingSource: 'band',
      boundBy: 'band-ceiling'
    });
    expect(capped.ceiling).toBe(band);

    await agent.put('/api/linkedin/seat').send({ safetyBandOverride: true }).expect(200);

    const overridden = dayCeiling((await agent.get('/api/linkedin/limits').expect(200)).body);
    expect(overridden).toMatchObject({
      ceiling: effectiveDailyCeiling(band, mine, true),
      bandCeiling: band,
      operatorLimit: mine,
      ceilingSource: 'operator-override',
      boundBy: 'operator-daily-limit'
    });
    expect(overridden.ceiling).toBe(mine);
    expect(Number(overridden.ceiling)).toBeGreaterThan(band);
    expect(overridden.rule).toContain('use your own daily limits');
  });

  /**
   * HOSTED IS A FACT ON THE RESPONSE, NOT A SHAPE IN THE PROSE.
   *
   * The accounts screen was inferring the deployment kind by matching a regular
   * expression against `blockers`, so rewording a sentence flipped it to the
   * wrong copy -- and it told a hosted operator to run `npx playwright install`
   * on a machine they do not have. `hosted` comes off the same config the
   * server refuses credential custody on, so the two can never disagree.
   */
  it('states hosted-versus-self-hosted on the worker status instead of leaving it in the blockers', async () => {
    const agent = await agentWithSession();
    const local = await agent.get('/api/linkedin/worker/status').expect(200);
    expect(local.body.hosted).toBe(false);

    process.env.TREVRA_DEPLOYMENT_MODE = 'hosted';
    try {
      const hosted = await agent.get('/api/linkedin/worker/status').expect(200);
      // Hosted is the one kind of off with no switch behind it, so it comes
      // with `enabled: false` and stays that way whatever else is set.
      expect(hosted.body).toMatchObject({ hosted: true, enabled: false, ready: false });
      expect(hosted.body.blockers.length).toBeGreaterThan(0);
    } finally {
      delete process.env.TREVRA_DEPLOYMENT_MODE;
    }

    expect((await agent.get('/api/linkedin/worker/status').expect(200)).body.hosted).toBe(false);
  });

  /**
   * Resuming says WHY, and the account's history keeps it.
   *
   * The safety screen asked for a reason and threw it away, because no route
   * took one. It is optional -- a resume must never be blocked behind a text
   * box -- and it is recorded in `audit_events` rather than on the seat, whose
   * `pausedReason` describes a stop that is over by then.
   */
  it('records who resumed a LinkedIn account and why, and resumes fine without a reason', async () => {
    const agent = await agentWithSession();
    await agent
      .put('/api/linkedin/seat')
      .send({ label: 'Founder', timezone: 'Europe/Zurich' })
      .expect(200);

    await agent
      .post('/api/linkedin/seat/pause')
      .send({ reason: 'LinkedIn showed a checkpoint' })
      .expect(200);
    const resumed = await agent
      .post('/api/linkedin/seat/resume')
      .send({ reason: 'Checkpoint cleared, session confirmed live' })
      .expect(200);
    expect(resumed.body.resumeReason).toBe('Checkpoint cleared, session confirmed live');
    // The seat carries the state; it does not carry the sentence about starting.
    expect(resumed.body.seat.pausedReason).toBeNull();

    const recorded = await db!
      .prepare(
        "SELECT actor_type,actor_id,entity_id,metadata_json FROM audit_events WHERE event_type='linkedin.seat_resumed' ORDER BY created_at DESC LIMIT 1"
      )
      .get<{ actor_type: string; actor_id: string; entity_id: string; metadata_json: string }>();
    expect(recorded).toMatchObject({ actor_type: 'user', entity_id: 'owner' });
    expect(recorded?.actor_id).toBeTruthy();
    expect(JSON.parse(recorded!.metadata_json)).toMatchObject({
      reason: 'Checkpoint cleared, session confirmed live',
      // The pause this resume answers, read before it was cleared.
      pausedReason: 'LinkedIn showed a checkpoint'
    });

    // Optional, and still optional.
    await agent.post('/api/linkedin/seat/pause').send({ reason: 'Taking a week off' }).expect(200);
    const silent = await agent.post('/api/linkedin/seat/resume').send({}).expect(200);
    expect(silent.body.resumeReason).toBeNull();
    expect(silent.body.posture).not.toBe('paused');
  });

  /**
   * A lead list longer than one page. `total` is what the screen may say out
   * loud; `contacts.length` is only ever what it received, and `pageLimit` is
   * how it tells the two apart without holding its own copy of the bound.
   */
  it('returns the lead-list total and page bound alongside the page of contacts', async () => {
    const agent = await agentWithSession();
    const list = await agent
      .post('/api/linkedin/manager/lead-lists')
      .send({ name: 'Series A CTOs' })
      .expect(201);
    const listId = list.body.list.id;

    const empty = await agent
      .get(`/api/linkedin/manager/lead-lists/${listId}/contacts`)
      .expect(200);
    expect(empty.body).toMatchObject({
      contacts: [],
      total: 0,
      pageLimit: LEAD_CONTACT_READ_LIMIT
    });

    const csv = 'first_name,last_name,company\nAda,Lovelace,Analytical\nGrace,Hopper,Navy\n';
    await agent
      .post(`/api/linkedin/manager/lead-lists/${listId}/import`)
      .attach('file', Buffer.from(csv), 'leads.csv')
      .expect(201);

    const page = await agent.get(`/api/linkedin/manager/lead-lists/${listId}/contacts`).expect(200);
    expect(page.body.total).toBe(2);
    expect(page.body.contacts).toHaveLength(2);
  });
});

/**
 * The owner carve-out, and the two deliberate holes in it.
 *
 * Full workspace parity for an invited teammate is the product's own decision;
 * these are the acts it does not extend to. Every assertion below is one route
 * that could not be undone by the owner afterwards -- a published module, a
 * revoked token, a downloaded file, a deleted workspace -- or one that spends
 * the owner's money or their LinkedIn account's standing.
 */
describe('owner-only acts', () => {
  it('refuses an invited teammate every privileged and destructive route, and keeps the kill switches open', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const { member } = await ownerAndMember(app);

    // PARITY IS THE PRODUCT, and this is the line the carve-out must not cross:
    // the teammate operates the workspace in full.
    await member.agent.get('/api/skills').expect(200);
    await member.agent.get('/api/policies').expect(200);
    await member.agent.get('/api/agent-setup').expect(200);
    await member.agent.get('/api/linkedin/seat').expect(200);
    await member.agent.get('/api/ledger/exports').expect(200);

    // Control-plane and registry: standing permissions, and code published in
    // the workspace's name.
    await member.agent
      .post('/api/policies')
      .send({
        name: 'wide open',
        priority: 1,
        actionPattern: '*',
        effect: 'allow',
        conditions: {},
        enabled: true
      })
      .expect(403);
    await member.agent.delete('/api/policies/pol_whatever').expect(403);
    await member.agent
      .post('/api/registry/publishers')
      .send({ slug: 'mine', displayName: 'Mine', publicKeyPem: 'x'.repeat(60) })
      .expect(403);
    await member.agent
      .post('/api/registry/modules/gtm.score-lead/install')
      .send({ version: '1.0.0' })
      .expect(403);
    await member.agent.post('/api/commercial-projections/rebuild').expect(403);

    // Credentials, money, and the unattended cadence that spends it.
    await member.agent.delete('/api/agent-tokens/tok_whatever').expect(403);
    await member.agent
      .put('/api/agent-setup/key')
      .send({ apiKey: 'sk-nope-1234567890' })
      .expect(403);
    await member.agent
      .put('/api/agent-setup/cli-token')
      .send({ token: 'nope-1234567890' })
      .expect(403);
    await member.agent.put('/api/agent-setup/cli-risk-accept').send({ accepted: true }).expect(403);
    await member.agent
      .put('/api/agent-setup/budget')
      .send({ monthlyCapCents: 100_000, enabled: true })
      .expect(403);
    await member.agent
      .put('/api/agent-setup/schedule')
      .send({ enabled: true, intervalMinutes: 60 })
      .expect(403);

    // The two downloads. Both are files of client names and message bodies that
    // cannot be recalled once they have left.
    await member.agent.get('/api/ledger/exports/exp_whatever').expect(403);

    // The LinkedIn account itself.
    await member.agent.put('/api/linkedin/seat').send({ inviteDailyLimit: 75 }).expect(403);
    await member.agent.post('/api/linkedin/seat/resume').send({}).expect(403);
    await member.agent.delete('/api/linkedin/seat').expect(403);
    await member.agent.post('/api/linkedin/seat/login').send({}).expect(403);
    await member.agent
      .post('/api/linkedin/seat/detect')
      .send({ timezone: 'Europe/Berlin' })
      .expect(403);
    await member.agent.put('/api/linkedin/lead-sources/allowance').send({ cap: 200 }).expect(403);

    // Queueing is the closest an HTTP caller gets to a send; stopping and
    // deleting do not come back.
    await member.agent.post('/api/linkedin/manager/campaigns/cmp_x/start').send({}).expect(403);
    await member.agent.post('/api/linkedin/manager/campaigns/cmp_x/stop').send({}).expect(403);
    await member.agent.delete('/api/linkedin/manager/lead-lists/lst_x').expect(403);

    // Export and erasure of the whole workspace.
    await member.agent.get('/api/workspace/export').expect(403);
    await member.agent.get('/api/workspace/erasure').expect(403);
    await member.agent.delete('/api/workspace').send({ confirm: 'anything' }).expect(403);

    // AND THE TWO HOLES, WHICH ARE THE POINT OF THE OTHER FIFTY. A 404 rather
    // than a 403 is the proof: the request reached the handler, found no seat
    // and no campaign, and was refused for THAT. A teammate who can see
    // something going wrong can always stop it.
    await member.agent
      .post('/api/linkedin/seat/pause')
      .send({ reason: 'this looks wrong' })
      .expect(404);
    await member.agent.post('/api/linkedin/manager/campaigns/cmp_x/pause').send({}).expect(404);
  });
});

describe('PATCH /api/policies/:id', () => {
  it('patches one field of a policy and leaves the rest alone', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const { owner } = await ownerAndMember(app);

    const created = await owner.agent
      .post('/api/policies')
      .send({ name: 'Ask me first', actionPattern: 'skill:*', effect: 'require_approval' })
      .expect(201);
    const policy = created.body.policies[0];

    const patched = await owner.agent
      .patch(`/api/policies/${policy.id}`)
      .send({ enabled: false })
      .expect(200);

    const updated = patched.body.policies.find((p: { id: string }) => p.id === policy.id);
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('Ask me first');
    expect(updated.effect).toBe('require_approval');
  });

  it('refuses a policy patch from a member and an unknown id', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const { owner, member } = await ownerAndMember(app);

    await owner.agent.patch('/api/policies/pol_nope').send({ enabled: false }).expect(404);
    await member.agent.patch('/api/policies/pol_nope').send({ enabled: false }).expect(403);
  });
});

/** The other half of migration 051: 'held' rows must be READABLE. */
it('accepts every ledger status the database can hold as an actions filter', async () => {
  const agent = await agentWithSession();
  for (const status of [
    'planned',
    'held',
    'exported',
    'sent',
    'accepted',
    'replied',
    'declined',
    'skipped',
    'withdrawn'
  ]) {
    await agent.get(`/api/linkedin/actions?status=${status}`).expect(200);
  }
  await agent.get('/api/linkedin/actions?status=invented').expect(400);
});

describe('export and erasure', () => {
  it('exports the whole workspace and withholds sealed credentials', async () => {
    process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
    const agent = await agentWithSession();
    const apiKey = 'sk-export-test-000000000000000000000000';
    await agent.put('/api/agent-setup/key').send({ apiKey, label: 'Anthropic' }).expect(200);

    const bundle = (await agent.get('/api/workspace/export').expect(200)).body as {
      tables: Record<string, unknown[]>;
      withheld: string[];
      truncated: string[];
    };

    // The tables the ledger export does NOT cover -- which is the reason this
    // route exists at all.
    expect(bundle.tables.clients.length).toBeGreaterThan(0);
    expect(bundle.tables.messages.length).toBeGreaterThan(0);
    expect(bundle.tables.invoices.length).toBeGreaterThan(0);
    expect(bundle.tables.workspace_settings.length).toBe(1);
    // Reached through their parents; they carry no workspace_id of their own.
    expect(bundle.tables.milestones).toBeDefined();
    expect(bundle.tables.recommendation_outcomes).toBeDefined();

    // The key is named as withheld and its bytes are nowhere in the file.
    expect(bundle.withheld).toContain('workspace_secrets');
    expect(bundle.tables.workspace_secrets).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain(apiKey);
    expect(bundle.truncated).toEqual([]);
  });

  it('refuses to erase the shared demo workspace at all', async () => {
    const agent = await agentWithSession();
    const preview = await agent.get('/api/workspace/erasure').expect(200);
    expect(preview.body.confirmationPhrase).toBe('Northstar Studio');
    expect(preview.body.erasable).toBe(false);
    expect(
      preview.body.inventory.some((entry: { table: string }) => entry.table === 'clients')
    ).toBe(true);
    expect(preview.body.totalRows).toBeGreaterThan(0);

    const refused = await agent
      .delete('/api/workspace')
      .send({ confirm: 'Northstar Studio' })
      .expect(403);
    expect(refused.body.error).toMatch(/demo workspace/i);
    const clients = await db!
      .prepare('SELECT COUNT(*) AS count FROM clients WHERE workspace_id=?')
      .get<{ count: number }>(DEMO_WORKSPACE_ID);
    expect(Number(clients?.count ?? 0)).toBeGreaterThan(0);
  });

  /**
   * THE UNSAFE CASES, PROVED TO BE REFUSED -- which for a destructive route
   * matters more than proving the happy path works. An unconfirmed erasure and
   * an erasure racing a running campaign must both leave the workspace
   * completely intact, not partly deleted.
   */
  it('refuses an unconfirmed erasure and one racing work in flight, then performs it', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const owner = await signUpAgent(app, 'erasure');
    const auth = await sessionAuth(owner.agent);
    const preview = await owner.agent.get('/api/workspace/erasure').expect(200);
    const phrase = preview.body.confirmationPhrase as string;
    expect(preview.body.erasable).toBe(true);

    const wrong = await owner.agent
      .delete('/api/workspace')
      .send({ confirm: `${phrase} maybe` })
      .expect(400);
    expect(wrong.body.error).toMatch(/Nothing was deleted/i);

    const now = new Date().toISOString();
    await db
      .prepare(
        `
      INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,created_at,updated_at)
      VALUES (?,?,?,'running','{}'::jsonb,'owner',?,?)
    `
      )
      .run('cmp_inflight', auth.workspaceId, 'Mid-flight', now, now);

    const busy = await owner.agent.delete('/api/workspace').send({ confirm: phrase }).expect(409);
    expect(busy.body.inFlight.join(' ')).toMatch(/campaign/i);

    // Neither refusal deleted anything.
    const survived = await db
      .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id=?')
      .get<{ count: number }>(auth.workspaceId);
    expect(Number(survived?.count ?? 0)).toBe(1);

    await db
      .prepare("UPDATE linkedin_campaigns SET status='stopped' WHERE id='cmp_inflight'")
      .run();
    const erased = await owner.agent.delete('/api/workspace').send({ confirm: phrase }).expect(200);
    expect(erased.body.erased).toBe(true);
    expect(erased.body.removed.linkedin_campaigns).toBe(1);

    const gone = await db
      .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id=?')
      .get<{ count: number }>(auth.workspaceId);
    expect(Number(gone?.count ?? 0)).toBe(0);
    const cascaded = await db
      .prepare('SELECT COUNT(*) AS count FROM linkedin_campaigns WHERE workspace_id=?')
      .get<{ count: number }>(auth.workspaceId);
    expect(Number(cascaded?.count ?? 0)).toBe(0);

    // The record outlives the workspace, which is the only reason it has no
    // foreign key to it (migration 057).
    const log = await db
      .prepare(
        'SELECT workspace_name, rows_removed_json FROM workspace_erasures WHERE workspace_id=?'
      )
      .get<{ workspace_name: string; rows_removed_json: Record<string, number> }>(auth.workspaceId);
    expect(log?.workspace_name).toBe(phrase);
    expect(log?.rows_removed_json.linkedin_campaigns).toBe(1);

    // The session it was made with no longer resolves to anything.
    await owner.agent.get('/api/dashboard').expect(401);
  });
});

describe('GET /api/outreach/threads', () => {
  it('lists discovered threads, scoped to the caller workspace, filterable by platform', async () => {
    const agent = await agentWithSession();

    const { recordSeenThreads } = await import('./outreach/store.js');
    await recordSeenThreads(
      db!,
      DEMO_WORKSPACE_ID,
      [
        {
          platform: 'linkedin',
          externalId: 'li-1',
          url: 'https://linkedin.test/post/1',
          title: 'Token costs are out of control',
          content: 'body',
          author: 'someone',
          community: null,
          score: 7,
          numComments: 2,
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {}
        }
      ],
      new Date('2026-08-01T00:00:00.000Z')
    );

    const all = await agent.get('/api/outreach/threads').expect(200);
    expect(all.body.threads).toHaveLength(1);
    expect(all.body.threads[0].row.platform).toBe('linkedin');

    const filtered = await agent.get('/api/outreach/threads?platform=reddit').expect(200);
    expect(filtered.body.threads).toEqual([]);
  });

  it('returns relevance, topics and a guard verdict with every discovered thread', async () => {
    const agent = await agentWithSession();

    const { recordSeenThreads } = await import('./outreach/store.js');
    await recordSeenThreads(
      db!,
      DEMO_WORKSPACE_ID,
      [
        {
          platform: 'hackernews',
          externalId: 'feed-1',
          url: 'https://news.ycombinator.com/item?id=feed-1',
          title: 'Ask HN: token cost of coding agents',
          content: 'our api cost tripled',
          author: 'someone',
          community: null,
          score: 5,
          numComments: 2,
          createdAt: '2026-08-18T00:00:00.000Z',
          metadata: {}
        }
      ],
      new Date('2026-08-19T00:00:00.000Z')
    );

    const response = await agent.get('/api/outreach/threads').expect(200);

    expect(response.body.threads).toHaveLength(1);
    const [entry] = response.body.threads;
    expect(entry.row.external_id).toBe('feed-1');
    expect(entry.relevance.score).toBeGreaterThan(0);
    expect(entry.topics).toContain('token_cost');
    expect(entry.guard).toMatchObject({ allowed: expect.any(Boolean) });
  });

  /**
   * `agentWithSession` always resolves to the demo workspace, so with only
   * one workspace in the database a dropped `WHERE workspace_id=?` is
   * invisible -- the unscoped query still happens to return the right row.
   * Two real, distinct workspaces (via `signUpAgent`) is what actually
   * exercises the scoping.
   */
  it("never returns another workspace's threads", async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const first = await signUpAgent(app, 'threads-a');
    const firstAuth = await sessionAuth(first.agent);
    const second = await signUpAgent(app, 'threads-b');
    const secondAuth = await sessionAuth(second.agent);

    const { recordSeenThreads } = await import('./outreach/store.js');
    await recordSeenThreads(
      db!,
      firstAuth.workspaceId,
      [
        {
          platform: 'linkedin',
          externalId: 'ws-a-1',
          url: 'https://linkedin.test/post/a',
          title: 'Workspace A thread',
          content: 'body',
          author: 'someone',
          community: null,
          score: 7,
          numComments: 2,
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {}
        }
      ],
      new Date('2026-08-01T00:00:00.000Z')
    );
    await recordSeenThreads(
      db!,
      secondAuth.workspaceId,
      [
        {
          platform: 'linkedin',
          externalId: 'ws-b-1',
          url: 'https://linkedin.test/post/b',
          title: 'Workspace B thread',
          content: 'body',
          author: 'someone',
          community: null,
          score: 7,
          numComments: 2,
          createdAt: '2026-08-01T00:00:00.000Z',
          metadata: {}
        }
      ],
      new Date('2026-08-01T00:00:00.000Z')
    );

    const firstThreads = await first.agent.get('/api/outreach/threads').expect(200);
    expect(firstThreads.body.threads).toHaveLength(1);
    expect(firstThreads.body.threads[0].row.external_id).toBe('ws-a-1');

    const secondThreads = await second.agent.get('/api/outreach/threads').expect(200);
    expect(secondThreads.body.threads).toHaveLength(1);
    expect(secondThreads.body.threads[0].row.external_id).toBe('ws-b-1');
  });
});

describe('GET /api/outreach/offer-defaults', () => {
  it('prefills the reply offer from the newest campaign brief, and returns blanks without one', async () => {
    const agent = await agentWithSession();

    const empty = await agent.get('/api/outreach/offer-defaults').expect(200);
    expect(empty.body.offer).toEqual({ name: '', url: '', summary: '', mechanism: '', claims: [] });

    await db!
      .prepare(
        `INSERT INTO linkedin_campaigns (id, workspace_id, name, status, seat_key, sequence_json, brief_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?,?)`
      )
      .run(
        'camp_offer_1',
        DEMO_WORKSPACE_ID,
        'Offer source',
        'draft',
        'owner',
        JSON.stringify([]),
        JSON.stringify({
          icp: { role: 'founder', segment: 'seed saas', pain: 'cost' },
          offer: {
            name: 'Trevra',
            summary: 'A workspace an agent operates and a human approves.',
            mechanism: 'Composite signals plus a hard approval gate.',
            proof: [{ label: 'Execution', value: 'Nothing sends without approval' }],
            url: 'https://usetrevra.com'
          }
        }),
        '2026-08-19T00:00:00.000Z',
        '2026-08-19T00:00:00.000Z'
      );

    const filled = await agent.get('/api/outreach/offer-defaults').expect(200);
    expect(filled.body.offer).toEqual({
      name: 'Trevra',
      url: 'https://usetrevra.com',
      summary: 'A workspace an agent operates and a human approves.',
      mechanism: 'Composite signals plus a hard approval gate.',
      claims: [{ label: 'Execution', value: 'Nothing sends without approval' }]
    });
  });

  /**
   * Same gap as the threads test above: one workspace in the database
   * means a dropped `WHERE workspace_id=?` still happens to pick the right
   * (only) row. Two real workspaces makes an unscoped `ORDER BY created_at
   * DESC LIMIT 1` observably wrong.
   */
  it("never returns another workspace's offer defaults", async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const first = await signUpAgent(app, 'offer-a');
    const second = await signUpAgent(app, 'offer-b');
    const secondAuth = await sessionAuth(second.agent);

    await db!
      .prepare(
        `INSERT INTO linkedin_campaigns (id, workspace_id, name, status, seat_key, sequence_json, brief_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?,?)`
      )
      .run(
        'camp_offer_ws_b',
        secondAuth.workspaceId,
        'Workspace B offer',
        'draft',
        'owner',
        JSON.stringify([]),
        JSON.stringify({
          icp: { role: 'founder', segment: 'seed saas', pain: 'cost' },
          offer: {
            name: 'Workspace B only',
            summary: 'Only workspace B should ever see this.',
            mechanism: 'Leakage would mean a missing workspace_id filter.',
            proof: [{ label: 'Scope', value: 'Workspace B' }],
            url: 'https://example.test/ws-b'
          }
        }),
        // Deliberately the newest row in the table -- an unscoped
        // `ORDER BY created_at DESC LIMIT 1` would hand it to ANY caller.
        '2026-08-19T00:00:00.000Z',
        '2026-08-19T00:00:00.000Z'
      );

    const firstOffer = await first.agent.get('/api/outreach/offer-defaults').expect(200);
    expect(firstOffer.body.offer).toEqual({
      name: '',
      url: '',
      summary: '',
      mechanism: '',
      claims: []
    });

    const secondOffer = await second.agent.get('/api/outreach/offer-defaults').expect(200);
    expect(secondOffer.body.offer.name).toBe('Workspace B only');
  });
});
