import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { registerPlaybook } from './playbooks/registry.js';


registerPlaybook({
  id: 'test.api-score-approval',
  version: '1.0.0',
  name: 'API score approval',
  description: 'Exercise durable workflow routes.',
  inputSchema: z.object({ lead: z.record(z.unknown()) }),
  steps: [
    { id: 'score', type: 'skill', skillId: 'gtm.score-lead', input: { lead: { $ref: '$.input.lead' } } },
    { id: 'approve', type: 'approval', title: 'Approve score', needs: ['score'], payload: { score: { $ref: '$.steps.score.output.overall' } } }
  ],
  output: { approved: { $ref: '$.steps.approve.output.approved' }, score: { $ref: '$.steps.score.output' } },
  source: { type: 'builtin' }
});

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
});

async function agentWithSession() {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  const agent = request.agent(createApp(db));
  await agent.post('/api/auth/demo').expect(200);
  return agent;
}

describe('Trevra API on PostgreSQL', () => {
  it('publishes canonical search, AI, and security discovery resources', async () => {
    process.env.PUBLIC_SITE_URL = 'https://trevra.example';
    process.env.INDEXNOW_KEY = 'trevra-indexnow-key-12345678';
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    expect((await request(app).get('/robots.txt').expect(200)).text).toContain('Sitemap: https://trevra.example/sitemap.xml');
    expect((await request(app).get('/sitemap.xml').expect(200)).text).toContain('<loc>https://trevra.example/how-it-works</loc>');
    expect((await request(app).get('/llms.txt').expect(200)).text).toContain('# Trevra');
    expect((await request(app).get('/agents.md').expect(200)).text).toContain('Restricted areas');
    expect((await request(app).get('/.well-known/security.txt').expect(200)).text).toContain('Canonical: https://trevra.example/.well-known/security.txt');
    expect((await request(app).get('/trevra-indexnow-key-12345678.txt').expect(200)).text).toBe('trevra-indexnow-key-12345678');
  });

  it('records privacy-preserving attribution and protects aggregate traction', async () => {
    process.env.TRACTION_ADMIN_TOKEN = 'traction-token-with-at-least-32-characters';
    process.env.MARKETING_HASH_SALT = 'marketing-salt-with-at-least-32-characters';
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    const visitorId = 'visitor-12345678';
    await request(app).post('/api/marketing/events').send({ eventName: 'page_view', visitorId, source: 'search', campaign: 'launch' }).expect(202);
    const stored = await db.prepare("SELECT visitor_hash,source,campaign FROM marketing_events WHERE event_name='page_view' ORDER BY created_at DESC LIMIT 1").get<{ visitor_hash: string; source: string; campaign: string }>();
    expect(stored?.visitor_hash).not.toBe(visitorId);
    expect(stored?.visitor_hash).toHaveLength(64);
    await request(app).get('/api/internal/traction').expect(401);
    const report = await request(app).get('/api/internal/traction?days=30').set('Authorization', `Bearer ${process.env.TRACTION_ADMIN_TOKEN}`).expect(200);
    expect(report.body.funnel.pageViews).toBeGreaterThanOrEqual(1);
    expect(report.body.funnel.uniqueVisitors).toBeGreaterThanOrEqual(1);
    expect(report.body.sources.some((item: { source: string }) => item.source === 'search')).toBe(true);
  });

  it('publishes aggregate module popularity without leaking workspace data', async () => {
    process.env.PUBLIC_REGISTRY_CORS_ORIGIN = 'https://www.trevra.example';
    const agent = await agentWithSession();
    await agent.post('/api/skills/gtm.score-lead/run').send({ lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } }).expect(201);
    const response = await agent.get('/api/public/modules').set('Origin', 'https://www.trevra.example').expect(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://www.trevra.example');
    const module = response.body.modules.find((item: { id: string }) => item.id === 'gtm.score-lead');
    expect(module.popularity.totalRuns).toBeGreaterThan(0);
    expect(module.popularity.successRate).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain(DEMO_WORKSPACE_ID);
    expect(JSON.stringify(response.body)).not.toContain('northstar.studio');
  });

  it('exposes Google OAuth only when both credentials are configured', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const app = createApp(db);
    expect((await request(app).get('/api/public-config').expect(200)).body.googleAuthEnabled).toBe(false);
    process.env.GOOGLE_CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    expect((await request(app).get('/api/public-config').expect(200)).body.googleAuthEnabled).toBe(true);
  });

  it('rejects state-changing requests from untrusted browser origins', async () => {
    const agent = await agentWithSession();
    await agent.post('/api/automation/run').set('Origin', 'https://malicious.example').expect(403);
  });

  it('returns a revenue dashboard with proof packs and prepared work', async () => {
    const agent = await agentWithSession();
    const response = await agent.get('/api/dashboard').expect(200);
    expect(response.body.metrics.openRecommendations).toBe(4);
    expect(response.body.metrics.revenueAtRisk).toBe(13750);
    expect(response.body.recommendations.every((item: { proofPack?: { items: unknown[] } }) => item.proofPack && item.proofPack.items.length > 0)).toBe(true);
    expect(response.body.recommendations.filter((item: { preparedAction?: unknown }) => item.preparedAction).length).toBe(3);
  });

  it('requires approval before action execution', async () => {
    const agent = await agentWithSession();
    const dashboard = await agent.get('/api/dashboard');
    const recId = dashboard.body.recommendations[0].id;
    const prepared = await agent.post(`/api/recommendations/${recId}/prepare`).expect(201);
    await agent.post(`/api/actions/${prepared.body.action.id}/execute`).expect(400);
    const action = prepared.body.action;
    await agent.post(`/api/actions/${action.id}/approve`).send({ recipient: action.recipient, subject: action.subject, body: action.body }).expect(200);
    const executed = await agent.post(`/api/actions/${action.id}/execute`).expect(200);
    expect(executed.body.action.status).toBe('executed');
    expect(executed.body.action.executionProvider).toBe('simulation');
  });

  it('imports marketplace exports into the commercial graph', async () => {
    const agent = await agentWithSession();
    const csv = [
      'Client,Project,Amount,Status,Date,Currency',
      'Pine Labs,Product audit,4500,Proposal sent,2026-07-01,EUR',
      'Oak Studio,Brand sprint,2200,Paid,2026-07-10,EUR'
    ].join('\n');
    const imported = await agent.post('/api/imports/marketplace').send({ provider: 'upwork', csv }).expect(201);
    expect(imported.body).toEqual({ imported: 2, skipped: 0 });
    const clients = await db!.prepare("SELECT COUNT(*) AS count FROM clients WHERE name IN ('Pine Labs','Oak Studio')").get<{ count: number }>();
    const sourceRecords = await db!.prepare("SELECT COUNT(*) AS count FROM source_records WHERE provider='upwork'").get<{ count: number }>();
    expect(clients?.count).toBe(1);
    expect(sourceRecords?.count).toBe(2);
  });

  it('runs delegated low-risk automation end to end', async () => {
    const agent = await agentWithSession();
    await agent.get('/api/dashboard').expect(200);
    await agent.put('/api/automation/rules/stale_proposal').send({
      mode: 'execute', minConfidence: 0.85, maxAmount: 10000, delayMinutes: 0, enabled: true
    }).expect(200);
    const result = await agent.post('/api/automation/run').expect(200);
    expect(result.body.executed).toBe(1);
    const completed = await db!.prepare("SELECT COUNT(*) AS count FROM recommendations WHERE type='stale_proposal' AND status='completed'").get<{ count: number }>();
    expect(completed?.count).toBe(1);
  });

  it('creates a real account and maps it to an isolated Trevra workspace', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    const agent = request.agent(createApp(db));
    const email = `founder-${Date.now()}@example.com`;
    await agent.post('/api/auth/sign-up/email').send({ name: 'Independent Alex', email, password: 'correct-horse-battery-staple' }).expect(200);
    const dashboard = await agent.get('/api/dashboard').expect(200);
    expect(dashboard.body.workspace.name).toBe("Independent Alex's Studio");
    expect(dashboard.body.metrics.openRecommendations).toBe(0);
    const mapped = await db.prepare('SELECT workspace_id FROM users WHERE email=?').get<{ workspace_id: string }>(email);
    expect(mapped?.workspace_id).toBe(dashboard.body.workspace.id);
  });

  it('executes scheduled approved work when it becomes due', async () => {
    const agent = await agentWithSession();
    const dashboard = await agent.get('/api/dashboard').expect(200);
    const recommendation = dashboard.body.recommendations.find((item: { type: string }) => item.type === 'stale_proposal');
    const action = recommendation.preparedAction;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await agent.post(`/api/actions/${action.id}/approve`).send({ recipient: action.recipient, subject: action.subject, body: action.body, scheduledFor: future }).expect(200);
    await db!.prepare('UPDATE actions SET scheduled_for=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), action.id);
    const cycle = await agent.post('/api/automation/run').expect(200);
    expect(cycle.body.executed).toBeGreaterThanOrEqual(1);
    const executed = await db!.prepare('SELECT status FROM actions WHERE id=?').get<{ status: string }>(action.id);
    expect(executed?.status).toBe('executed');
  });

  it('creates a ledger invoice after executing ready-to-invoice work', async () => {
    const agent = await agentWithSession();
    const dashboard = await agent.get('/api/dashboard').expect(200);
    const recommendation = dashboard.body.recommendations.find((item: { type: string }) => item.type === 'unbilled_milestone');
    const action = recommendation.preparedAction;
    await agent.post(`/api/actions/${action.id}/approve`).send({ recipient: action.recipient, subject: action.subject, body: action.body }).expect(200);
    await agent.post(`/api/actions/${action.id}/execute`).expect(200);
    const milestone = await db!.prepare("SELECT status,invoiced_at FROM milestones WHERE id='mil_luma_final'").get<{ status: string; invoiced_at: string | null }>();
    const invoice = await db!.prepare("SELECT external_ref,amount,status FROM invoices WHERE project_id='prj_luma' ORDER BY created_at DESC LIMIT 1")
      .get<{ external_ref: string; amount: number; status: string }>();
    expect(milestone?.status).toBe('invoiced');
    expect(milestone?.invoiced_at).not.toBeNull();
    expect(invoice?.amount).toBe(2400);
    expect(invoice?.status).toBe('sent');
  });

  it('builds a Scope Ledger from an uploaded agreement', async () => {
    const agent = await agentWithSession();
    const agreement = [
      'STATEMENT OF WORK',
      'Client: Cedar Labs',
      'Project: Product launch',
      '',
      'Deliverables:',
      '- Brand strategy workshop',
      '- One product landing page',
      '- Additional landing pages are separately priced at EUR 750 per landing page.',
      '',
      'Change orders: Additional work outside the scope requires written approval and is priced separately.',
      'Payment schedule: Deposit EUR 2000 upon signature and final payment EUR 3000 upon delivery.'
    ].join('\n');
    const response = await agent.post('/api/imports/document')
      .field('clientName', 'Cedar Labs')
      .field('clientEmail', 'client@cedar.example')
      .field('projectName', 'Product launch')
      .field('currency', 'EUR')
      .attach('file', Buffer.from(agreement), { filename: 'cedar-sow.txt', contentType: 'text/plain' })
      .expect(201);
    expect(response.body.extractionMethod).toBe('deterministic');
    expect(response.body.scopeItems).toBeGreaterThanOrEqual(2);
    expect(response.body.clauses).toBeGreaterThanOrEqual(1);
    expect(response.body.milestones).toBeGreaterThanOrEqual(1);
    const contract = await db!.prepare("SELECT COUNT(*) AS count FROM contracts ct JOIN clients c ON c.id=ct.client_id WHERE c.name='Cedar Labs'").get<{ count: number }>();
    const scope = await db!.prepare("SELECT COUNT(*) AS count FROM scope_items s JOIN projects p ON p.id=s.project_id JOIN clients c ON c.id=p.client_id WHERE c.name='Cedar Labs'").get<{ count: number }>();
    expect(contract?.count).toBe(1);
    expect(scope?.count).toBeGreaterThanOrEqual(2);
  });

  it('creates scoped agent tokens and runs skills through the agent API', async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await resetDemoData(db);
    const app = createApp(db);
    const browser = request.agent(app);
    await browser.post('/api/auth/demo').expect(200);

    const created = await browser.post('/api/agent-tokens').send({ name: 'Claude Code test' }).expect(201);
    expect(created.body.token).toMatch(/^trv_live_/);
    expect(created.body.record.scopes).toEqual([
      'skills:read', 'skills:run', 'runs:read', 'workspace:read', 'actions:prepare',
      'playbooks:read', 'playbooks:run', 'workflows:read'
    ]);

    const listedTokens = await browser.get('/api/agent-tokens').expect(200);
    expect(listedTokens.body.tokens[0].prefix).toBe(created.body.record.prefix);
    expect(JSON.stringify(listedTokens.body)).not.toContain(created.body.token);

    const authorization = `Bearer ${created.body.token}`;
    const skills = await request(app).get('/api/agent/skills').set('Authorization', authorization).expect(200);
    const scoreManifest = skills.body.skills.find((skill: { id: string }) => skill.id === 'gtm.score-lead');
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

    const runs = await request(app).get('/api/agent/runs?skillId=gtm.score-lead').set('Authorization', authorization).expect(200);
    expect(runs.body.runs.some((run: { id: string }) => run.id === executed.body.run.id)).toBe(true);
    await request(app).get(`/api/agent/runs/${executed.body.run.id}`).set('Authorization', authorization).expect(200);

    const brief = await request(app).get('/api/agent/revenue-brief').set('Authorization', authorization).expect(200);
    expect(brief.body.recommendations.length).toBe(4);
    const recommendationId = brief.body.recommendations[0].id;
    const prepared = await request(app)
      .post(`/api/agent/recommendations/${recommendationId}/prepare`)
      .set('Authorization', authorization)
      .send({})
      .expect(201);
    expect(prepared.body.action.status).toBe('draft');
    expect(prepared.body.instruction).toContain('founder');
    const pending = await request(app).get('/api/agent/actions').set('Authorization', authorization).expect(200);
    expect(pending.body.actions.some((action: { id: string }) => action.id === prepared.body.action.id)).toBe(true);
    await request(app)
      .post(`/api/actions/${prepared.body.action.id}/approve`)
      .set('Authorization', authorization)
      .send({ recipient: prepared.body.action.recipient, subject: prepared.body.action.subject, body: prepared.body.action.body })
      .expect(401);

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
    const created = await browser.post('/api/agent-tokens').send({ name: 'Remote MCP test' }).expect(201);

    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('MCP test server did not bind');
    const mcp = new Client({ name: 'remote-trevra-test', version: '1.0.0' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/api/agent/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${created.body.token}` } } }
      ));
      const tools = await mcp.listTools();
      expect(tools.tools.some((tool) => tool.name === 'trevra_gtm_score-lead')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_revenue_brief')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_prepare_recommendation')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_list_playbooks')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'trevra_start_playbook')).toBe(true);
      const briefResult = await mcp.callTool({ name: 'trevra_revenue_brief', arguments: {} });
      const briefContent = briefResult.content as Array<{ type: string; text?: string }>;
      const briefText = briefContent.find((item) => item.type === 'text')?.text;
      const recommendationId = briefText ? JSON.parse(briefText).recommendations[0].id : null;
      expect(recommendationId).toBeTruthy();
      const preparedResult = await mcp.callTool({
        name: 'trevra_prepare_recommendation',
        arguments: { recommendationId }
      });
      const preparedContent = preparedResult.content as Array<{ type: string; text?: string }>;
      const preparedText = preparedContent.find((item) => item.type === 'text')?.text;
      expect(preparedText ? JSON.parse(preparedText).action.status : null).toBe('draft');
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
    const created = await browser.post('/api/agent-tokens').send({
      name: 'Read-only agent', scopes: ['skills:read']
    }).expect(201);
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
    expect(catalog.body.playbooks.some((playbook: { id: string }) => playbook.id === 'test.api-score-approval')).toBe(true);

    const started = await browser.post('/api/playbooks/test.api-score-approval/runs').send({
      input: { lead: { platform: 'shopify', vertical: 'footwear', catalogSize: 100 } }
    }).expect(201);
    expect(started.body.run.status).toBe('waiting_approval');
    const runId = started.body.run.id as string;
    const approval = started.body.run.steps.find((step: { status: string }) => step.status === 'waiting_approval');
    expect(approval.approvalPayloadHash).toHaveLength(64);

    const inspected = await browser.get(`/api/playbook-runs/${runId}`).expect(200);
    expect(inspected.body.run.currentStepId).toBe('approve');

    const decided = await browser.post(`/api/playbook-runs/${runId}/steps/approve/decision`).send({ decision: 'approve' }).expect(200);
    expect(decided.body.run.status).toBe('completed');
    expect(decided.body.run.output).toMatchObject({ approved: true, score: { wedge: 'sizing' } });

    const events = await browser.get(`/api/control-plane/events?streamType=playbook_run&streamId=${runId}`).expect(200);
    expect(events.body.events.map((event: { eventType: string }) => event.eventType)).toContain('playbook.run.completed');
    expect(events.body.events.map((event: { streamVersion: number }) => event.streamVersion)).toEqual(
      events.body.events.map((_: unknown, index: number) => index + 1)
    );

    const created = await browser.post('/api/agent-tokens').send({ name: 'Workflow agent' }).expect(201);
    const authorization = `Bearer ${created.body.token}`;
    await request(app).get('/api/agent/playbooks').set('Authorization', authorization).expect(200);
    await request(app).get(`/api/agent/playbook-runs/${runId}`).set('Authorization', authorization).expect(200);
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
      id: 'evt_trevra_paid', object: 'event', api_version: '2025-06-30.basil', created: Math.floor(Date.now() / 1000), type: 'invoice.paid',
      data: { object: {
        id: 'in_test', object: 'invoice', number: 'INV-104', amount_paid: 185000, currency: 'eur',
        metadata: { trevra_workspace_id: 'ws_demo', trevra_invoice_id: 'inv_acme_104' },
        status_transitions: { paid_at: Math.floor(Date.now() / 1000) }
      } }
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    await agent.post('/api/webhooks/stripe').set('stripe-signature', signature).set('content-type', 'application/json').send(payload).expect(202);
    await agent.post('/api/webhooks/stripe').set('stripe-signature', signature).set('content-type', 'application/json').send(payload).expect(200);
    const invoice = await db!.prepare("SELECT status,paid_at FROM invoices WHERE id='inv_acme_104'").get<{ status: string; paid_at: string | null }>();
    expect(invoice?.status).toBe('paid');
    expect(invoice?.paid_at).not.toBeNull();
  });
});
