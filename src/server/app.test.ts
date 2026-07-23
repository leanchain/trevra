import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { openDatabase, resetDemoData, type Db } from './db.js';
import { createApp } from './app.js';
import { closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';

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
});

async function agentWithSession() {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
  const agent = request.agent(createApp(db));
  await agent.post('/api/auth/demo').expect(200);
  return agent;
}

describe('Trevra API on PostgreSQL', () => {
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
    const email = `freelancer-${Date.now()}@example.com`;
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
