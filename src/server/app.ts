import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { toNodeHandler } from 'better-auth/node';
import type { Db } from './db.js';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, id, resetDemoData } from './db.js';
import { runRecommendationEngine } from './recommendation-engine.js';
import { listAutomationRules, listConnections, listRecommendations } from './serializers.js';
import { approveAction, executeAction, prepareAction } from './action-service.js';
import { runAutomationCycle } from './automation-service.js';
import { auth as betterAuth, resolveBetterAuthIdentity } from './auth-service.js';
import { importCommercialDocument } from './document-service.js';
import {
  createNangoConnectSession,
  disconnectIntegration,
  handleNangoWebhook,
  importMarketplaceCsv,
  ingestCanonicalRecord,
  listAvailableIntegrations,
  processStripeWebhook,
  recordOutcome,
  triggerConnectionSync
} from './integration-service.js';
import { getSiteConfig, recordMarketingEvent, registerPublicSiteRoutes } from './public-site.js';
import {
  AGENT_SCOPES,
  createAgentToken,
  hasAgentScope,
  listAgentTokens,
  resolveAgentIdentity,
  revokeAgentToken,
  type AgentIdentity,
  type AgentScope
} from './agent-access.js';
import {
  executeWorkspaceSkill,
  getWorkspaceSkillRun,
  listWorkspaceSkillRuns,
  listWorkspaceSkills,
  SkillApiError
} from './skill-api.js';
import { handleMcpHttpRequest, rejectMcpNonPost } from './mcp-http.js';
import { getAgentRevenueBrief, listAgentPendingActions, prepareRecommendationForAgent } from './agent-operations.js';
import {
  decidePlaybookApproval,
  getPlaybookRun,
  listPlaybookRuns,
  listWorkspacePlaybooks,
  PlaybookError,
  startPlaybookRun
} from './playbooks/engine.js';
import { listDomainEvents } from './control-plane/events.js';
import { listWorkspacePolicies } from './control-plane/policy.js';
import {
  createModulePublisher,
  installModuleRelease,
  listWorkspaceCommunityModules,
  listWorkspacePublishers,
  publishModuleRelease,
  uninstallModuleRelease,
  setPublisherVerification
} from './registry/service.js';
import { listCommercialProjections, rebuildCommercialProjections } from './projections/commercial.js';

const SESSION_COOKIE = 'trevra_session';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, callback) => {
    const extension = file.originalname.toLowerCase().split('.').pop();
    const allowed = new Set(['pdf', 'docx', 'txt', 'md', 'rtf']);
    if (!allowed.has(extension ?? '')) return callback(new Error('Unsupported document type'));
    callback(null, true);
  }
});

type AuthedRequest = Request & { auth?: { userId: string; workspaceId: string; email: string } };
type AgentRequest = Request & { agent?: AgentIdentity };

export function createApp(db: Db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production'
      ? { directives: { scriptSrc: ["'self'", (_req, res) => `'nonce-${String((res as unknown as Response).locals.cspNonce)}'`] } }
      : false
  }));
  app.use(pinoHttp({
    logger: pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info') }),
    genReqId: (req, res) => {
      const requestId = String(req.headers['x-request-id'] ?? randomUUID());
      res.setHeader('x-request-id', requestId);
      return requestId;
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'req.body.password', 'req.body.csv'],
      censor: '[REDACTED]'
    },
    customLogLevel: (_req, res, error) => error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
  }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    next();
  });
  registerPublicSiteRoutes(app, db);

  app.post('/api/webhooks/nango', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const result = await handleNangoWebhook(db, raw, req.headers as Record<string, unknown>);
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (error) {
      res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid Nango webhook' });
    }
  });

  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
    try {
      const signature = req.header('stripe-signature');
      if (!signature) return res.status(400).json({ error: 'Missing Stripe signature' });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
      const result = await processStripeWebhook(db, body, signature);
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Stripe webhook' });
    }
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await db.prepare('SELECT 1 AS ok').get();
      res.json({ ok: true, service: 'trevra-api', database: 'postgresql', integrations: Boolean(process.env.NANGO_API_KEY), stripeWebhooks: Boolean(process.env.STRIPE_WEBHOOK_SECRET) });
    } catch {
      res.status(503).json({ ok: false, service: 'trevra-api', database: 'unavailable' });
    }
  });

  app.get('/api/public-config', (_req, res) => res.json({
    googleAuthEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    modelExtractionEnabled: Boolean(process.env.OPENAI_API_KEY),
    supportEmail: getSiteConfig().supportEmail,
    catalogApiUrl: process.env.PUBLIC_REGISTRY_API_URL?.trim() || ''
  }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  app.post('/api/auth/demo', authLimiter, async (_req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_AUTH !== 'true') {
      return res.status(404).json({ error: 'Demo authentication is disabled' });
    }
    const token = await createSession(db, DEMO_USER_ID);
    setSessionCookie(res, token);
    await recordMarketingEvent(db, { eventName: 'demo_started', workspaceId: DEMO_WORKSPACE_ID, path: '/' });
    res.json({
      user: { id: DEMO_USER_ID, name: 'Alex Morgan', email: 'alex@northstar.studio' },
      workspace: { id: DEMO_WORKSPACE_ID, name: 'Northstar Studio' }
    });
  });

  app.post('/api/auth/demo/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/session', async (req: AuthedRequest, res) => {
    const identity = await readSession(db, req);
    if (!identity) return res.status(401).json({ error: 'Authentication required' });
    res.json({ auth: identity });
  });

  app.all('/api/auth/*splat', toNodeHandler(betterAuth));

  app.use(express.json({ limit: '6mb' }));
  app.use(enforceAllowedOrigin);
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.post('/api/admin/registry/publishers/:id/verification', async (req, res, next) => {
    try {
      const expected = process.env.TRACTION_ADMIN_TOKEN?.trim();
      if (!expected) return res.status(404).json({ error: 'Not found' });
      const supplied = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
      if (!secureTokenEqual(supplied,expected)) return res.status(401).json({ error: 'Invalid registry admin token' });
      const input = z.object({ verified: z.boolean() }).parse(req.body ?? {});
      const updated = await setPublisherVerification(db,String(req.params.id),input.verified);
      if (!updated) return res.status(404).json({ error: 'Publisher not found' });
      res.json({ ok: true, verified: input.verified });
    } catch (error) { next(error); }
  });

  // Agent tokens deliberately expose a smaller surface than browser sessions.
  // Claude Code, Codex, and other MCP clients can inspect and run skills, but
  // cannot silently inherit billing, integration, or account-management access.
  app.post('/api/agent/mcp', requireAgentScope(db, 'skills:read'), async (req: AgentRequest, res, next) => {
    try { await handleMcpHttpRequest(db, req.agent!, req, res); }
    catch (error) { next(error); }
  });
  app.get('/api/agent/mcp', requireAgentScope(db, 'skills:read'), rejectMcpNonPost);
  app.delete('/api/agent/mcp', requireAgentScope(db, 'skills:read'), rejectMcpNonPost);

  app.get('/api/agent/revenue-brief', requireAgentScope(db, 'workspace:read'), async (req: AgentRequest, res, next) => {
    try { res.json(await getAgentRevenueBrief(db, req.agent!.workspaceId)); }
    catch (error) { next(error); }
  });

  app.get('/api/agent/actions', requireAgentScope(db, 'workspace:read'), async (req: AgentRequest, res, next) => {
    try { res.json({ actions: await listAgentPendingActions(db, req.agent!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/agent/recommendations/:id/prepare', requireAgentScope(db, 'actions:prepare'), async (req: AgentRequest, res, next) => {
    try {
      const result = await prepareRecommendationForAgent(
        db,
        req.agent!.workspaceId,
        req.agent!.tokenId,
        String(req.params.id)
      );
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return res.status(404).json({ error: error.message });
      next(error);
    }
  });

  app.get('/api/agent/skills', requireAgentScope(db, 'skills:read'), async (req: AgentRequest, res, next) => {
    try { res.json({ skills: await listWorkspaceSkills(db, req.agent!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/agent/skills/:id/run', requireAgentScope(db, 'skills:run'), async (req: AgentRequest, res, next) => {
    try {
      const result = await executeWorkspaceSkill(db, {
        workspaceId: req.agent!.workspaceId,
        skillId: String(req.params.id),
        payload: req.body ?? {},
        actorType: 'agent',
        actorId: req.agent!.tokenId
      });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/agent/runs', requireAgentScope(db, 'runs:read'), async (req: AgentRequest, res, next) => {
    try {
      const filters = skillRunFiltersSchema.parse(req.query);
      res.json({ runs: await listWorkspaceSkillRuns(db, req.agent!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.get('/api/agent/runs/:id', requireAgentScope(db, 'runs:read'), async (req: AgentRequest, res, next) => {
    try {
      const run = await getWorkspaceSkillRun(db, req.agent!.workspaceId, String(req.params.id));
      if (!run) return res.status(404).json({ error: 'Skill run not found' });
      res.json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/agent/playbooks', requireAgentScope(db, 'playbooks:read'), async (req: AgentRequest, res, next) => {
    try { res.json({ playbooks: await listWorkspacePlaybooks(db, req.agent!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/agent/playbooks/:id/runs', requireAgentScope(db, 'playbooks:run'), async (req: AgentRequest, res, next) => {
    try {
      const input = playbookStartSchema.parse(req.body ?? {});
      const run = await startPlaybookRun(db, {
        workspaceId: req.agent!.workspaceId,
        playbookId: String(req.params.id),
        version: input.version,
        payload: input.input,
        actorType: 'agent',
        actorId: req.agent!.tokenId
      });
      res.status(201).json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/agent/playbook-runs', requireAgentScope(db, 'workflows:read'), async (req: AgentRequest, res, next) => {
    try {
      const filters = playbookRunFiltersSchema.parse(req.query);
      res.json({ runs: await listPlaybookRuns(db, req.agent!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.get('/api/agent/playbook-runs/:id', requireAgentScope(db, 'workflows:read'), async (req: AgentRequest, res, next) => {
    try {
      const run = await getPlaybookRun(db, req.agent!.workspaceId, String(req.params.id));
      if (!run) return res.status(404).json({ error: 'Playbook run not found' });
      res.json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/agent/events', requireAgentScope(db, 'workflows:read'), async (req: AgentRequest, res, next) => {
    try {
      const filters = eventFiltersSchema.parse(req.query);
      res.json({ events: await listDomainEvents(db, req.agent!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.use('/api', requireSession(db));

  app.get('/api/skills', async (req: AuthedRequest, res, next) => {
    try { res.json({ skills: await listWorkspaceSkills(db, req.auth!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/skills/:id/run', async (req: AuthedRequest, res, next) => {
    try {
      const result = await executeWorkspaceSkill(db, {
        workspaceId: req.auth!.workspaceId,
        skillId: String(req.params.id),
        payload: req.body ?? {},
        actorType: 'user',
        actorId: req.auth!.userId
      });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/skill-runs', async (req: AuthedRequest, res, next) => {
    try {
      const filters = skillRunFiltersSchema.parse(req.query);
      res.json({ runs: await listWorkspaceSkillRuns(db, req.auth!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.get('/api/skill-runs/:id', async (req: AuthedRequest, res, next) => {
    try {
      const run = await getWorkspaceSkillRun(db, req.auth!.workspaceId, String(req.params.id));
      if (!run) return res.status(404).json({ error: 'Skill run not found' });
      res.json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/playbooks', async (req: AuthedRequest, res, next) => {
    try { res.json({ playbooks: await listWorkspacePlaybooks(db, req.auth!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/playbooks/:id/runs', async (req: AuthedRequest, res, next) => {
    try {
      const input = playbookStartSchema.parse(req.body ?? {});
      const run = await startPlaybookRun(db, {
        workspaceId: req.auth!.workspaceId,
        playbookId: String(req.params.id),
        version: input.version,
        payload: input.input,
        actorType: 'user',
        actorId: req.auth!.userId
      });
      res.status(201).json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/playbook-runs', async (req: AuthedRequest, res, next) => {
    try {
      const filters = playbookRunFiltersSchema.parse(req.query);
      res.json({ runs: await listPlaybookRuns(db, req.auth!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.get('/api/playbook-runs/:id', async (req: AuthedRequest, res, next) => {
    try {
      const run = await getPlaybookRun(db, req.auth!.workspaceId, String(req.params.id));
      if (!run) return res.status(404).json({ error: 'Playbook run not found' });
      res.json({ run });
    } catch (error) { next(error); }
  });

  app.post('/api/playbook-runs/:id/steps/:stepId/decision', async (req: AuthedRequest, res, next) => {
    try {
      const decision = playbookDecisionSchema.parse(req.body ?? {});
      const run = await decidePlaybookApproval(db, {
        workspaceId: req.auth!.workspaceId,
        runId: String(req.params.id),
        stepId: String(req.params.stepId),
        userId: req.auth!.userId,
        decision: decision.decision,
        comment: decision.comment
      });
      res.json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/control-plane/events', async (req: AuthedRequest, res, next) => {
    try {
      const filters = eventFiltersSchema.parse(req.query);
      res.json({ events: await listDomainEvents(db, req.auth!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  app.get('/api/policies', async (req: AuthedRequest, res, next) => {
    try { res.json({ policies: await listWorkspacePolicies(db, req.auth!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/policies', async (req: AuthedRequest, res, next) => {
    try {
      const input = policyWriteSchema.parse(req.body ?? {});
      const now = new Date().toISOString();
      const policyId = id('pol');
      await db.prepare(`
        INSERT INTO workspace_policies (
          id,workspace_id,name,version,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        policyId,req.auth!.workspaceId,input.name,1,input.priority,input.actionPattern,input.effect,
        JSON.stringify(input.conditions),input.enabled,now,now
      );
      res.status(201).json({ policies: await listWorkspacePolicies(db, req.auth!.workspaceId) });
    } catch (error) { next(error); }
  });

  app.delete('/api/policies/:id', async (req: AuthedRequest, res, next) => {
    try {
      const result = await db.prepare('DELETE FROM workspace_policies WHERE id=? AND workspace_id=?')
        .run(String(req.params.id),req.auth!.workspaceId);
      if (result.changes === 0) return res.status(404).json({ error: 'Policy not found' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });


  app.get('/api/registry/publishers', async (req: AuthedRequest, res, next) => {
    try { res.json({ publishers: await listWorkspacePublishers(db, req.auth!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/registry/publishers', async (req: AuthedRequest, res, next) => {
    try {
      const input = publisherCreateSchema.parse(req.body ?? {});
      const publisher = await createModulePublisher(db, {
        workspaceId: req.auth!.workspaceId,
        userId: req.auth!.userId,
        slug: input.slug,
        displayName: input.displayName,
        publicKeyPem: input.publicKeyPem
      });
      res.status(201).json({ publisher });
    } catch (error) { next(error); }
  });

  app.post('/api/registry/modules/:id/releases', async (req: AuthedRequest, res, next) => {
    try {
      const input = moduleReleaseSchema.parse(req.body ?? {});
      if (typeof input.manifest !== 'object' || input.manifest === null || Array.isArray(input.manifest) ||
          String((input.manifest as Record<string, unknown>).id ?? '') !== String(req.params.id)) {
        return res.status(400).json({ error: 'Manifest id must match the module route' });
      }
      const release = await publishModuleRelease(db, {
        workspaceId: req.auth!.workspaceId,
        userId: req.auth!.userId,
        publisherId: input.publisherId,
        manifest: input.manifest,
        signature: input.signature,
        sbom: input.sbom
      });
      res.status(201).json({ release });
    } catch (error) { next(error); }
  });

  app.get('/api/registry/installations', async (req: AuthedRequest, res, next) => {
    try { res.json({ modules: await listWorkspaceCommunityModules(db, req.auth!.workspaceId) }); }
    catch (error) { next(error); }
  });

  app.post('/api/registry/modules/:id/install', async (req: AuthedRequest, res, next) => {
    try {
      const input = moduleInstallSchema.parse(req.body ?? {});
      const installation = await installModuleRelease(db, {
        workspaceId: req.auth!.workspaceId,
        userId: req.auth!.userId,
        moduleId: String(req.params.id),
        version: input.version,
        config: input.config
      });
      res.status(201).json({ installation });
    } catch (error) { next(error); }
  });

  app.delete('/api/registry/modules/:id/install', async (req: AuthedRequest, res, next) => {
    try {
      const removed = await uninstallModuleRelease(db, req.auth!.workspaceId, String(req.params.id));
      if (!removed) return res.status(404).json({ error: 'Installed module not found' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/commercial-projections', async (req: AuthedRequest, res, next) => {
    try {
      const input = projectionFiltersSchema.parse(req.query);
      res.json({ projections: await listCommercialProjections(db, req.auth!.workspaceId, input) });
    } catch (error) { next(error); }
  });

  app.post('/api/commercial-projections/rebuild', async (_req: AuthedRequest, res, next) => {
    try { res.status(202).json({ processed: await rebuildCommercialProjections(db) }); }
    catch (error) { next(error); }
  });

  app.get('/api/agent-tokens', async (req: AuthedRequest, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tokens: await listAgentTokens(db, req.auth!.workspaceId) });
    } catch (error) { next(error); }
  });

  app.post('/api/agent-tokens', async (req: AuthedRequest, res, next) => {
    try {
      const input = z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(AGENT_SCOPES.length).optional(),
        expiresAt: z.string().datetime().nullable().optional()
      }).parse(req.body ?? {});
      const created = await createAgentToken(db, {
        workspaceId: req.auth!.workspaceId,
        userId: req.auth!.userId,
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(created);
    } catch (error) { next(error); }
  });

  app.delete('/api/agent-tokens/:id', async (req: AuthedRequest, res, next) => {
    try {
      const revoked = await revokeAgentToken(db, req.auth!.workspaceId, req.auth!.userId, String(req.params.id));
      if (!revoked) return res.status(404).json({ error: 'Active agent token not found' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/dashboard', async (req: AuthedRequest, res, next) => {
    try {
      const workspaceId = req.auth!.workspaceId;
      await runRecommendationEngine(db, workspaceId);
      await runAutomationCycle(db, workspaceId);
      const recommendations = await listRecommendations(db, workspaceId);
      const clients = await db.prepare(`
        SELECT c.*,
          (SELECT recommended_action FROM recommendations r WHERE r.client_id=c.id AND r.status IN ('ready','approved') ORDER BY priority_score DESC LIMIT 1) AS next_action
        FROM clients c WHERE c.workspace_id=? ORDER BY c.last_interaction_at DESC
      `).all(workspaceId) as Array<Record<string, unknown>>;
      const overdue = await db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE workspace_id=? AND paid_at IS NULL AND due_at < datetime('now')").get(workspaceId) as { count: number };
      const outcomes = await db.prepare(`
        SELECT ro.outcome_type, COALESCE(SUM(ro.amount),0) AS total
        FROM recommendation_outcomes ro JOIN recommendations r ON r.id=ro.recommendation_id
        WHERE r.workspace_id=? GROUP BY ro.outcome_type
      `).all(workspaceId) as Array<{ outcome_type: string; total: number }>;
      const outcomeMap = new Map(outcomes.map((item) => [item.outcome_type, Number(item.total)]));
      const connections = await listConnections(db, workspaceId);
      const availableIntegrations = await listAvailableIntegrations(db, workspaceId);
      const automationRules = await listAutomationRules(db, workspaceId);

      res.json({
        workspace: await db.prepare('SELECT id,name FROM workspaces WHERE id=?').get(workspaceId),
        metrics: {
          revenueAtRisk: recommendations.reduce((sum, item) => sum + item.estimatedAmount, 0),
          revenueProtected: outcomeMap.get('revenue_protected') ?? 0,
          revenueCollected: outcomeMap.get('revenue_collected') ?? 0,
          readyToInvoice: recommendations.filter((item) => item.type === 'unbilled_milestone').reduce((sum, item) => sum + item.estimatedAmount, 0),
          openRecommendations: recommendations.length,
          overdueInvoices: overdue.count,
          activeClients: clients.filter((client) => client.status === 'active').length,
          connectedSources: connections.filter((connection) => connection.status === 'connected' && !connection.isDemo).length,
          currency: String((await db.prepare('SELECT currency FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { currency?: string } | undefined)?.currency ?? 'EUR')
        },
        recommendations,
        connections,
        availableIntegrations,
        automationRules,
        clients: clients.map((client) => ({
          id: String(client.id), name: String(client.name), contactName: String(client.contact_name), email: String(client.email),
          status: String(client.status), activeValue: Number(client.active_value), currency: String(client.currency),
          lastInteractionAt: String(client.last_interaction_at), nextAction: client.next_action ? String(client.next_action) : null
        }))
      });
    } catch (error) { next(error); }
  });

  app.get('/api/recommendations', async (req: AuthedRequest, res) => {
    await runRecommendationEngine(db, req.auth!.workspaceId);
    res.json({ recommendations: await listRecommendations(db, req.auth!.workspaceId) });
  });

  app.post('/api/recommendations/:id/snooze', async (req: AuthedRequest, res) => {
    const recommendationId = String(req.params.id);
    const body = z.object({ days: z.number().int().min(1).max(30).default(3) }).parse(req.body);
    const until = new Date(Date.now() + body.days * 86400000).toISOString();
    const result = await db.prepare("UPDATE recommendations SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=? AND workspace_id=?")
      .run(until, new Date().toISOString(), recommendationId, req.auth!.workspaceId);
    if (result.changes === 0) return res.status(404).json({ error: 'Recommendation not found' });
    res.json({ ok: true, snoozedUntil: until });
  });

  app.post('/api/recommendations/:id/dismiss', async (req: AuthedRequest, res) => {
    const recommendationId = String(req.params.id);
    const input = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const recommendation = await db.prepare('SELECT * FROM recommendations WHERE id=? AND workspace_id=?').get(recommendationId, req.auth!.workspaceId) as Record<string, unknown> | undefined;
    if (!recommendation) return res.status(404).json({ error: 'Recommendation not found' });
    await db.prepare("UPDATE recommendations SET status='dismissed',updated_at=? WHERE id=?").run(new Date().toISOString(), recommendationId);
    await recordOutcome(db, recommendationId, 'dismissed', 0, String(recommendation.currency), { reason: input.reason ?? null });
    res.json({ ok: true });
  });

  app.post('/api/recommendations/:id/prepare', async (req: AuthedRequest, res) => {
    try {
      const action = await prepareAction(db, req.auth!.workspaceId, String(req.params.id));
      await recordMarketingEvent(db, { eventName: 'action_prepared', workspaceId: req.auth!.workspaceId, metadata: { actionType: action.type } });
      res.status(201).json({ action });
    }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : 'Unable to prepare action' }); }
  });

  app.post('/api/actions/:id/approve', async (req: AuthedRequest, res) => {
    const input = z.object({
      recipient: z.string().email(), subject: z.string().min(1).max(200), body: z.string().min(1).max(20000),
      scheduledFor: z.string().datetime().nullable().optional()
    }).parse(req.body);
    try {
      const action = await approveAction(db, req.auth!.workspaceId, req.auth!.userId, String(req.params.id), input);
      await recordMarketingEvent(db, { eventName: 'action_approved', workspaceId: req.auth!.workspaceId, metadata: { actionType: action.type, scheduled: Boolean(action.scheduledFor) } });
      res.json({ action });
    }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to approve action' }); }
  });

  app.post('/api/actions/:id/execute', async (req: AuthedRequest, res) => {
    try {
      const action = await executeAction(db, req.auth!.workspaceId, String(req.params.id));
      await recordMarketingEvent(db, { eventName: 'action_executed', workspaceId: req.auth!.workspaceId, metadata: { actionType: action.type, provider: action.executionProvider } });
      res.json({ action });
    }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to execute action' }); }
  });

  app.get('/api/integrations', async (req: AuthedRequest, res) => {
    res.json({
      connections: await listConnections(db, req.auth!.workspaceId),
      available: await listAvailableIntegrations(db, req.auth!.workspaceId),
      configured: Boolean(process.env.NANGO_API_KEY)
    });
  });

  app.post('/api/integrations/connect-session', async (req: AuthedRequest, res) => {
    const input = z.object({ allowedIntegrations: z.array(z.string()).max(12).default([]) }).parse(req.body ?? {});
    try {
      const session = await createNangoConnectSession({
        workspaceId: req.auth!.workspaceId, userId: req.auth!.userId, userEmail: req.auth!.email,
        allowedIntegrations: input.allowedIntegrations
      });
      await recordMarketingEvent(db, { eventName: 'integration_connect_started', workspaceId: req.auth!.workspaceId, metadata: { integrations: input.allowedIntegrations.join(',') } });
      res.status(201).json({ session });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Unable to start connection' });
    }
  });

  app.post('/api/integrations/:id/sync', async (req: AuthedRequest, res) => {
    try {
      await triggerConnectionSync(db, req.auth!.workspaceId, String(req.params.id));
      res.status(202).json({ accepted: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to sync connection' }); }
  });

  app.delete('/api/integrations/:id', async (req: AuthedRequest, res) => {
    try {
      await disconnectIntegration(db, req.auth!.workspaceId, String(req.params.id));
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to disconnect' }); }
  });

  app.post('/api/imports/marketplace', async (req: AuthedRequest, res) => {
    const input = z.object({ provider: z.enum(['upwork', 'fiverr', 'contra', 'generic']), csv: z.string().min(1).max(5_000_000) }).parse(req.body);
    const result = await importMarketplaceCsv(db, req.auth!.workspaceId, input.provider, input.csv);
    await runRecommendationEngine(db, req.auth!.workspaceId);
    await recordMarketingEvent(db, { eventName: 'marketplace_imported', workspaceId: req.auth!.workspaceId, metadata: { provider: input.provider, imported: result.imported } });
    res.status(201).json(result);
  });

  app.post('/api/imports/document', documentUpload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'A PDF, DOCX, or text document is required' });
    const hints = z.object({
      clientName: z.string().max(200).optional(),
      contactName: z.string().max(200).optional(),
      clientEmail: z.string().email().optional().or(z.literal('')),
      projectName: z.string().max(300).optional(),
      currency: z.string().length(3).optional()
    }).parse(req.body);
    try {
      const result = await importCommercialDocument(db, req.auth!.workspaceId, req.file, {
        ...hints,
        clientEmail: hints.clientEmail || undefined
      });
      await runRecommendationEngine(db, req.auth!.workspaceId);
      await recordMarketingEvent(db, { eventName: 'document_imported', workspaceId: req.auth!.workspaceId, metadata: { extractionMethod: result.extractionMethod, scopeItems: result.scopeItems } });
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to import document' });
    }
  });

  app.get('/api/automation/rules', async (req: AuthedRequest, res) => res.json({ rules: await listAutomationRules(db, req.auth!.workspaceId) }));

  app.put('/api/automation/rules/:type', async (req: AuthedRequest, res) => {
    const recommendationType = z.enum(['stale_proposal', 'scope_creep', 'unbilled_milestone', 'overdue_invoice']).parse(String(req.params.type));
    const input = z.object({
      mode: z.enum(['suggest', 'prepare', 'execute']), minConfidence: z.number().min(0.5).max(1),
      maxAmount: z.number().nonnegative().max(10_000_000), delayMinutes: z.number().int().min(0).max(43_200), enabled: z.boolean()
    }).parse(req.body);
    if (recommendationType === 'scope_creep' && input.mode === 'execute') return res.status(400).json({ error: 'Scope changes always require manual approval' });
    const now = new Date().toISOString();
    const existing = await db.prepare('SELECT id FROM automation_rules WHERE workspace_id=? AND recommendation_type=?').get(req.auth!.workspaceId, recommendationType) as { id: string } | undefined;
    await db.prepare(`
      INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,recommendation_type) DO UPDATE SET
        mode=excluded.mode,min_confidence=excluded.min_confidence,max_amount=excluded.max_amount,
        delay_minutes=excluded.delay_minutes,enabled=excluded.enabled,updated_at=excluded.updated_at
    `).run(existing?.id ?? id('rule'), req.auth!.workspaceId, recommendationType, input.mode, input.minConfidence, input.maxAmount, input.delayMinutes, input.enabled ? 1 : 0, now, now);
    res.json({ rules: await listAutomationRules(db, req.auth!.workspaceId) });
  });

  app.post('/api/automation/run', async (req: AuthedRequest, res) => {
    res.json(await runAutomationCycle(db, req.auth!.workspaceId));
  });

  app.get('/api/clients/:id', async (req: AuthedRequest, res) => {
    const clientId = String(req.params.id);
    const workspaceId = req.auth!.workspaceId;
    const client = await db.prepare('SELECT * FROM clients WHERE id=? AND workspace_id=?').get(clientId, workspaceId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const messages = await db.prepare('SELECT id,direction,subject,body,occurred_at,source_record_id FROM messages WHERE client_id=? ORDER BY occurred_at DESC').all(clientId);
    const invoices = await db.prepare('SELECT id,external_ref,amount,currency,status,issued_at,due_at,paid_at FROM invoices WHERE client_id=? ORDER BY issued_at DESC').all(clientId);
    const projects = await db.prepare('SELECT id,name,status,total_value,currency FROM projects WHERE client_id=? ORDER BY created_at DESC').all(clientId);
    const commitments = await db.prepare('SELECT * FROM commitments WHERE client_id=? ORDER BY due_at').all(clientId);
    const contracts = await db.prepare('SELECT * FROM contracts WHERE client_id=? ORDER BY created_at DESC').all(clientId);
    const outcomes = await db.prepare(`
      SELECT ro.* FROM recommendation_outcomes ro JOIN recommendations r ON r.id=ro.recommendation_id
      WHERE r.client_id=? ORDER BY ro.created_at DESC
    `).all(clientId);
    res.json({ client, messages, invoices, projects, commitments, contracts, outcomes });
  });

  app.post('/api/events', async (req: AuthedRequest, res) => {
    const ingestKey = req.header('x-trevra-ingest-key');
    if (!process.env.INGEST_API_KEY || ingestKey !== process.env.INGEST_API_KEY) return res.status(401).json({ error: 'Invalid ingest key' });
    const event = z.object({ provider: z.string().default('custom'), record: z.record(z.unknown()) }).parse(req.body);
    await ingestCanonicalRecord(db, req.auth!.workspaceId, event.provider, null, event.record as never);
    const count = await runRecommendationEngine(db, req.auth!.workspaceId);
    res.status(202).json({ accepted: true, recommendationsEvaluated: count });
  });

  app.post('/api/demo/reset', async (req: AuthedRequest, res) => {
    if (req.auth!.workspaceId !== DEMO_WORKSPACE_ID) return res.status(403).json({ error: 'Only the demo workspace can be reset' });
    await resetDemoData(db);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SkillApiError || error instanceof PlaybookError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', issues: error.issues });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
    req.log.error({ err: error }, 'Unhandled request error');
    res.status(500).json({ error: 'Internal server error', requestId: req.id });
  });

  return app;
}

const skillRunFiltersSchema = z.object({
  skillId: z.string().min(1).max(200).optional(),
  status: z.enum(['ok', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});


const publisherCreateSchema = z.object({
  slug: z.string().min(3).max(64),
  displayName: z.string().min(1).max(120),
  publicKeyPem: z.string().min(40).max(10_000)
});

const moduleReleaseSchema = z.object({
  publisherId: z.string().min(1).max(100),
  manifest: z.unknown(),
  signature: z.string().min(40).max(20_000),
  sbom: z.record(z.unknown()).default({})
});

const moduleInstallSchema = z.object({
  version: z.string().min(1).max(100),
  config: z.record(z.unknown()).default({})
});

const projectionFiltersSchema = z.object({
  entityType: z.string().min(1).max(100).optional(),
  includeDeleted: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(1000).default(200)
});

const playbookStartSchema = z.object({
  version: z.string().min(1).max(50).optional(),
  input: z.unknown().default({})
});

const playbookRunFiltersSchema = z.object({
  status: z.enum(['queued','running','waiting_approval','completed','failed','cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const playbookDecisionSchema = z.object({
  decision: z.enum(['approve','reject']),
  comment: z.string().trim().max(1000).optional()
});

const eventFiltersSchema = z.object({
  streamType: z.string().min(1).max(100).optional(),
  streamId: z.string().min(1).max(200).optional(),
  correlationId: z.string().min(1).max(200).optional(),
  afterPosition: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const policyWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.number().int().min(-10000).max(10000).default(0),
  actionPattern: z.string().trim().min(1).max(200),
  effect: z.enum(['allow','deny','require_approval']),
  conditions: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true)
});

function requireAgentScope(db: Db, scope: AgentScope) {
  return async (req: AgentRequest, res: Response, next: NextFunction) => {
    try {
      const identity = await resolveAgentIdentity(db, req.headers);
      if (!identity) return res.status(401).json({ error: 'Valid Trevra agent token required' });
      if (!hasAgentScope(identity, scope)) return res.status(403).json({ error: `Agent token is missing scope: ${scope}` });
      req.agent = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireSession(db: Db) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const identity = await readSession(db, req);
      if (!identity) return res.status(401).json({ error: 'Session expired' });
      req.auth = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function readSession(db: Db, req: Request): Promise<{ userId: string; workspaceId: string; email: string } | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const session = await db.prepare(`
      SELECT s.user_id, u.workspace_id, u.email FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at > ?
    `).get(hash(token), new Date().toISOString()) as { user_id: string; workspace_id: string; email: string } | undefined;
    if (session) return { userId: session.user_id, workspaceId: session.workspace_id, email: session.email };
  }
  return resolveBetterAuthIdentity(db, req.headers);
}

async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(hash(token), userId, new Date(now.getTime() + SESSION_TTL).toISOString(), now.toISOString());
  return token;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: SESSION_TTL, path: '/'
  });
}

function enforceAllowedOrigin(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  if (!origin) return next();
  const allowed = new Set([
    ...(process.env.APP_ORIGIN ?? 'http://localhost:43173').split(',').map((item) => item.trim()),
    'http://localhost:43173',
    'http://localhost:43887'
  ]);
  if (!allowed.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
}

function secureTokenEqual(left:string,right:string):boolean{
  const leftHash=createHash('sha256').update(left).digest();
  const rightHash=createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash,rightHash);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
