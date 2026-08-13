import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { APIError } from 'better-auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Db } from './db.js';
import { DEMO_USER_ID, DEMO_WORKSPACE_ID, id, resetDemoData } from './db.js';
import { runRecommendationEngine } from './recommendation-engine.js';
import { listAutomationRules, listConnections, listRecommendations } from './serializers.js';
import { approveAction, executeAction, prepareAction } from './action-service.js';
import { runAutomationCycle } from './automation-service.js';
import { auth as betterAuth, configureAuthProvisioning, resolveBetterAuthIdentity } from './auth-service.js';
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
import { listResearchRuns, listResearchSources, saveResearchSource, searchResearchCorpus, syncResearchSource } from './research/service.js';
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
import { AgentBudgetError, getAgentBudget, setAgentBudget } from './agent/budget.js';
import { getAgentRun, listAgentRuns, type AgentRunRecord } from './agent/runs.js';
import { AGENT_STOP_REASON_MAX_CHARS, requestAgentRunStop } from './agent/stop-request.js';
import {
  LEDGER_EXPORT_DEFAULT_WINDOW_DAYS,
  LEDGER_EXPORT_MAX_WINDOW_DAYS,
  LEDGER_EXPORT_SECTIONS,
  createLedgerExport,
  listLedgerExports,
  readLedgerExport
} from './ledger-export.js';
import { LOOP_COST_DEFAULT_WINDOW_DAYS, LOOP_COST_MAX_WINDOW_DAYS, loopCost } from './loop-cost.js';
import { runHostedAgent } from './agent/loop.js';
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  getAgentSchedule,
  setAgentSchedule
} from './agent/schedule.js';
import { secretsConfigured } from './secrets/crypto.js';
// readWorkspaceSecretPlaintext is deliberately NOT imported here. Section 3 of
// docs/byok-and-hosted-agent.md: no API route returns plaintext, and there is
// no reveal endpoint, for anyone. The HTTP layer only ever sees last4/label.
// The same discipline applies to 'cli_oauth_token' -- it is a third kind in
// the same table, sealed by the same crypto path, and readWorkspaceSecretPlaintext
// stays unimported for it too.
import {
  deleteWorkspaceSecret,
  describeWorkspaceSecret,
  getWorkspaceAgentSetup,
  getWorkspaceCliAgentConfig,
  putWorkspaceAgentConfig,
  putWorkspaceCliAgentConfig,
  putWorkspaceSecret,
  setWorkspaceCliRiskAccepted
} from './secrets/store.js';
import {
  LINKEDIN_CREDENTIALS_HOSTED_REFUSAL,
  LINKEDIN_CREDENTIALS_UNSEALED_REFUSAL,
  deleteLinkedInCredentials,
  describeLinkedInCredentials,
  putLinkedInCredentials
} from './secrets/linkedin.js';
// readLinkedInCredentials is deliberately NOT imported here either, for the
// same reason and with more at stake: the LinkedIn password is write-only over
// the wire, and the HTTP layer only ever sees `hasCredentials` and a mask.
// LinkedIn (docs/linkedin-outreach-plan.md section 5). The routes below own no
// policy: every ceiling, every band and every confidence tag is read from
// linkedin/limits.ts, which is the one diff-reviewable table of them.
import { parse as parseCsv } from 'csv-parse/sync';
import { createRequire } from 'node:module';
import { linkedInWorkerConfig, redditWorkerConfig, validateEnvironment } from './config.js';
import { canonicalPayloadHash } from './control-plane/payload.js';
// Reddit (migration 041). The same arrangement as the LinkedIn seat: a
// self-hoster's own sign-in, sealed, typed by a browser on their own machine.
// `readRedditCredentials` is deliberately NOT imported here -- nothing in the
// HTTP layer may decrypt a password, and the only shapes that cross the wire
// are `hasCredentials` and a public handle.
import {
  REDDIT_CREDENTIALS_HOSTED_REFUSAL,
  REDDIT_CREDENTIALS_UNSEALED_REFUSAL,
  deleteRedditCredentials,
  describeRedditCredentials,
  putRedditCredentials
} from './secrets/reddit.js';
import { getRedditAccount } from './reddit/account.js';
import { RedditApiError } from './reddit/errors.js';
import { REDDIT_SORTS, MAX_READ_LIMIT as REDDIT_MAX_READ_LIMIT } from './reddit/driver.js';
import {
  commentOnRedditThread,
  loginRedditAccount,
  redditOffReason,
  redditWorkerStatus,
  researchSubreddit,
  type RedditLocalWorkerConfig
} from './reddit/local-worker.js';
import {
  ACCEPTANCE_THROTTLE_FACTOR,
  ACCEPTANCE_WINDOW_DAYS,
  ACTION_GAP_SECONDS,
  BUSINESS_HOURS,
  ENFORCEMENT_SCAN_WEEKDAYS,
  MAX_DAY_OVER_DAY_DELTA,
  MAX_OUTSTANDING_INVITES,
  MIN_ACCEPTANCE_RATE,
  MIN_RAMP_STEP,
  PACED_KINDS,
  PACED_KIND_VALUES,
  WARMUP_WEEKS,
  WEEKEND_FACTOR,
  bandFor,
  warmupMultiplier,
  type PacedKind
} from './linkedin/limits.js';
import { ACTION_KIND_VALUES, acceptanceRate, countActionsInWindow, hasTarget, ownerSeat } from './linkedin/actions.js';
import {
  OWNER_SEAT_KEY,
  deleteSeat,
  effectivePosture,
  getSeat,
  pauseSeat,
  resumeSeat,
  upsertSeat,
  warmupWeekOf,
  type SeatPatch
} from './linkedin/seats.js';
import { MAX_HORIZON_DAYS, planPacing } from './linkedin/pacing.js';
import {
  exportCampaign,
  linkedinExportPayloadSchema,
  linkedinSequencePayloadSchema,
  type LinkedInExportPayload
} from './linkedin/export.js';
import { queueCampaign } from './linkedin/queue.js';
import {
  detectLinkedInSeat,
  latestSeatDetectRequest,
  linkedInBrowserReadiness,
  linkedInHeadlessReadiness,
  linkedInOffReason,
  loginLinkedInSeat,
  requestSeatDetect,
  type LinkedInLocalWorkerConfig
} from './linkedin/local-worker.js';
import {
  LinkedInApiError,
  attachCampaignRun,
  countDeliveredActions,
  createCampaign,
  currentCampaignExport,
  getCampaign,
  getCampaignBrief,
  ingestOutcome,
  linkedinAnalytics,
  listActions,
  listCampaignExports,
  listCampaigns,
  newCampaignId,
  readCampaignExport,
  skipAction,
  stopCampaign,
  storeCampaignExport,
  supersedeCampaignExport,
  type LinkedInCampaign
} from './linkedin/campaigns.js';
import {
  INVITE_NOTE_MAX_CHARS,
  MAX_SEQUENCE_STEPS,
  SUPPORTED_MERGE_FIELDS,
  SequenceValidationError,
  linkedinSequenceSkill,
  sequenceFromSteps,
  sequenceStepsSchema,
  type LinkedInSequence,
  type SequenceStepInput
} from './linkedin/sequence.js';
import { BRANCH_ON_VALUES } from './linkedin/branching.js';
import {
  createLeadSource,
  getLeadSource,
  leadSourcingConfig,
  leadSourcingEnabled,
  leadSourcingOffReason,
  listLeadSources,
  listLeads
} from './linkedin/leads.js';
import {
  enqueueReply,
  listThreads,
  readThread as readStoredThread,
  threadByUrn
} from './linkedin/inbox.js';
import {
  countPendingInvites,
  listWithdrawals,
  selectWithdrawalCandidates,
  sweepStaleInvites
} from './linkedin/withdraw.js';
import {
  evaluateEngagementSafety,
  isEngagementKind,
  recordEngagement
} from './linkedin/engagement.js';
import { syncLinkedInInbox, syncLinkedInPendingInvites, syncLinkedInThread } from './linkedin/jobs.js';
import {
  DEFAULT_SEQUENCE_TEMPLATE_ID,
  SEQUENCE_TEMPLATES,
  defaultSequenceTemplate,
  getSequenceTemplate
} from './linkedin/templates.js';
import { briefFromProfile, briefIsComplete } from './linkedin/brief.js';
import { suggestBriefFields } from './linkedin/brief-suggest.js';
import { enrichCompany } from './skills/enrich.js';
import { addExclusions, filterExcluded, listExclusions } from './linkedin/exclusions.js';
// The account spine (migration 039). `accounts/types.ts` is the contract these
// three modules and this file are written against; nothing here reaches past
// the functions below into the store's own SQL.
import {
  getAccount,
  importAccounts,
  listRankedAccounts,
  recordAccountFeedback,
  rejectedSignalShapes,
  setAccountStatus
} from './accounts/store.js';
import { rescoreAccounts, rescoreWorkspace } from './accounts/score.js';
import type { Account, AccountScore, AccountSignal, RankedAccount } from './accounts/types.js';

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

/**
 * The LinkedIn target CSV.
 *
 * Smaller than the document limit on purpose: this is a contact list, and the
 * plan's own ceiling is 500 targets. A 5MB CSV of handles is not a list
 * somebody meant to upload.
 */
const linkedinTargetsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, callback) => {
    const extension = file.originalname.toLowerCase().split('.').pop();
    if (!new Set(['csv', 'tsv', 'txt']).has(extension ?? '')) return callback(new Error('Upload a .csv file of LinkedIn targets'));
    callback(null, true);
  }
});

type AuthedRequest = Request & { auth?: { userId: string; workspaceId: string; email: string; role: 'owner' | 'member' } };
type AgentRequest = Request & { agent?: AgentIdentity };

export function createApp(db: Db) {
  // Wires `db` to auth-service.ts's better-auth `afterCreateOrganization` hook
  // (see the block comment near the top of that file). Idempotent, so calling
  // it again here is harmless even when index.ts's boot sequence already did --
  // this is what makes every test that calls `createApp(db)` directly (without
  // going through index.ts) work without a separate setup step.
  configureAuthProvisioning(db);

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
      // pino-http's default req serializer never emits a body, so this list is
      // belt-and-braces -- and `req.body.apiKey` stays on it so that a future
      // custom serializer cannot quietly start logging a model key.
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'req.body.password', 'req.body.csv', 'req.body.apiKey'],
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
    catalogApiUrl: process.env.PUBLIC_REGISTRY_API_URL?.trim() || '',
    // Where an MCP client should point.
    //
    // The browser CANNOT infer this. In development the UI is served by Vite on
    // its own port and proxies /api, so window.location.origin would hand
    // Claude Code a URL that only resolves while the dev server happens to be
    // running. APP_ORIGIN is no good either -- it is the BROWSER origin, which
    // in dev is the Vite port, not the API.
    //
    // In production the API and the UI are the same origin, so APP_ORIGIN is
    // correct there and only there.
    apiBaseUrl: (
      process.env.TREVRA_PUBLIC_API_URL?.trim()
      || (process.env.NODE_ENV === 'production' ? process.env.APP_ORIGIN?.split(',')[0]?.trim() : '')
      || `http://localhost:${process.env.PORT ?? 43887}`
    ).replace(/\/$/, '')
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

  /**
   * Add a teammate (design doc's Team management section -- decision #3
   * superseded: nobody joins a workspace without accepting it themselves,
   * an existing Trevra account is no longer an instant-join shortcut, only a
   * real invitation, same as an email with no account at all).
   *
   * The one bit of bespoke team-management server logic this pass needs:
   * better-auth's client SDK already talks straight to the auto-mounted
   * `/api/auth/organization/*` routes for everything else (list/remove members,
   * list/cancel invitations, switch active workspace, and -- unchanged by this
   * route no longer ever granting instant membership -- accepting THIS
   * route's own invitation via `organization.acceptInvitation`, see
   * `AcceptInvitationPanel` in TeamScreen.tsx) -- see `app.all('/api/
   * auth/*splat', ...)` above. `createInvitation` alone covers both an email
   * with an existing account and one with none: it only ever checks whether
   * the email is already a member of THIS organization, never whether it has
   * a Trevra account anywhere else -- so this route has no need to look that
   * up itself, and the adder never learns it either way.
   *
   * Owner-only, same carve-out shape as the LinkedIn credential routes: full
   * workspace parity for members, except who gets to change who is IN the
   * workspace.
   */
  const teamAddMemberSchema = z.object({
    email: z.string().trim().email().max(320),
    role: z.enum(['owner', 'member']).default('member')
  });
  app.post('/api/team/members', async (req: AuthedRequest, res, next) => {
    try {
      if (req.auth!.role !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can add teammates' });
      const input = teamAddMemberSchema.parse(req.body ?? {});
      const workspaceId = req.auth!.workspaceId;
      // `createInvitation` requires this request's own session (the inviter),
      // so it is the one call in this route that needs headers rather than
      // the userId system-action shortcut the rest of this route's callers
      // (e.g. the backfill) use elsewhere in this codebase.
      const invitation = await betterAuth.api.createInvitation({
        headers: fromNodeHeaders(req.headers),
        body: { email: input.email, organizationId: workspaceId, role: input.role }
      });
      res.status(201).json({ status: 'invited', invitation });
    } catch (error) {
      if (error instanceof APIError) return res.status(error.statusCode ?? 400).json({ error: error.body?.message ?? error.message });
      next(error);
    }
  });

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

  // BYOK setup (docs/byok-and-hosted-agent.md sections 3 and 5).
  //
  // Write-only from the browser's perspective: a key goes in, and only `last4`,
  // `label`, `keyVersion` and timestamps ever come back out. `available` says
  // whether this deployment holds a TREVRA_SECRETS_KEY at all -- when it does
  // not, BYOK is off rather than half-working, and the key route says so
  // instead of letting the crypto layer throw a 500 at the operator.
  app.get('/api/agent-setup', async (req: AuthedRequest, res, next) => {
    try {
      const [setup, budget, schedule, cliConfig, cliToken] = await Promise.all([
        getWorkspaceAgentSetup(db, req.auth!.workspaceId),
        getAgentBudget(db, req.auth!.workspaceId),
        getAgentSchedule(db, req.auth!.workspaceId),
        getWorkspaceCliAgentConfig(db, req.auth!.workspaceId),
        describeWorkspaceSecret(db, req.auth!.workspaceId, 'cli_oauth_token')
      ]);
      res.setHeader('Cache-Control', 'no-store');
      // `schedule` is null for a workspace that never configured one, which is
      // the same shape `config` and `secret` use for "never opted in".
      //
      // `cli` never carries the token itself, same discipline as `secret`
      // above -- `tokenStored` and `riskAccepted` are booleans a screen can act
      // on, not anything decrypted.
      res.json({
        available: secretsConfigured(),
        config: setup.config,
        secret: setup.secret,
        budget,
        schedule,
        cli: {
          config: cliConfig ? { cli: cliConfig.cli, model: cliConfig.model } : null,
          tokenStored: cliToken !== null,
          riskAccepted: cliConfig?.riskAcceptedAt != null
        }
      });
    } catch (error) { next(error); }
  });

  app.put('/api/agent-setup/config', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentConfigSchema.parse(req.body ?? {});
      const config = await putWorkspaceAgentConfig(db, {
        workspaceId: req.auth!.workspaceId,
        baseUrl: input.baseUrl,
        model: input.model,
        label: input.label
      });
      res.json({ config });
    } catch (error) {
      // The store owns the endpoint policy (HTTPS, public host, the loopback
      // escape hatch), so its rejections are operator input errors, not faults.
      if (error instanceof Error && AGENT_CONFIG_INPUT_ERROR.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  // Rate-limited with the same limiter as the auth routes: writing a provider
  // credential is a credential endpoint, whatever the session already proves.
  app.put('/api/agent-setup/key', authLimiter, async (req: AuthedRequest, res, next) => {
    try {
      if (!secretsConfigured()) {
        return res.status(400).json({
          error: 'This server has no TREVRA_SECRETS_KEY configured, so it cannot encrypt a model key. '
            + 'Generate one with `openssl rand -base64 32`, set it in the environment, and restart.'
        });
      }
      const input = agentKeySchema.parse(req.body ?? {});
      const secret = await putWorkspaceSecret(db, {
        workspaceId: req.auth!.workspaceId,
        kind: 'model_api_key',
        plaintext: input.apiKey,
        label: input.label,
        actorUserId: req.auth!.userId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ secret });
    } catch (error) { next(error); }
  });

  app.delete('/api/agent-setup/key', async (req: AuthedRequest, res, next) => {
    try {
      const deleted = await deleteWorkspaceSecret(db, req.auth!.workspaceId, 'model_api_key', req.auth!.userId);
      res.json({ deleted });
    } catch (error) { next(error); }
  });

  // The third way to run the hosted agent: a workspace's own Claude/Codex
  // subscription, opted into per workspace (docs/cli-agent-and-hosted.md).
  // Mirrors the BYOK routes just above in every discipline that applies --
  // write-only token, no reveal, Cache-Control: no-store on anything
  // secret-adjacent -- and adds one more: the risk disclaimer gate, which is
  // its own route so it is revocable in one click and never implied by saving
  // config or a token.
  app.put('/api/agent-setup/cli-config', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentCliConfigSchema.parse(req.body ?? {});
      const config = await putWorkspaceCliAgentConfig(db, {
        workspaceId: req.auth!.workspaceId,
        cli: input.cli,
        model: input.model
      });
      res.json({ config: { cli: config.cli, model: config.model } });
    } catch (error) { next(error); }
  });

  // Rate-limited and gated the same as /api/agent-setup/key: a subscription
  // token is a credential endpoint too, whatever the session already proves,
  // and this deployment must be able to encrypt it before it accepts one.
  app.put('/api/agent-setup/cli-token', authLimiter, async (req: AuthedRequest, res, next) => {
    try {
      if (!secretsConfigured()) {
        return res.status(400).json({
          error: 'This server has no TREVRA_SECRETS_KEY configured, so it cannot encrypt a CLI subscription token. '
            + 'Generate one with `openssl rand -base64 32`, set it in the environment, and restart.'
        });
      }
      const input = agentCliTokenSchema.parse(req.body ?? {});
      await putWorkspaceSecret(db, {
        workspaceId: req.auth!.workspaceId,
        kind: 'cli_oauth_token',
        plaintext: input.token,
        actorUserId: req.auth!.userId
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ tokenStored: true });
    } catch (error) { next(error); }
  });

  app.delete('/api/agent-setup/cli-token', async (req: AuthedRequest, res, next) => {
    try {
      const deleted = await deleteWorkspaceSecret(db, req.auth!.workspaceId, 'cli_oauth_token', req.auth!.userId);
      res.json({ deleted });
    } catch (error) { next(error); }
  });

  // Its own isolated write, deliberately -- see the doc comment on
  // `setWorkspaceCliRiskAccepted`. `accepted: true` 400s when there is no CLI
  // + model saved yet (nothing to accept the risk of); `accepted: false` is
  // always a harmless no-op, so revoking consent is never blocked by anything.
  app.put('/api/agent-setup/cli-risk-accept', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentCliRiskAcceptSchema.parse(req.body ?? {});
      const config = await setWorkspaceCliRiskAccepted(db, req.auth!.workspaceId, input.accepted);
      if (!config && input.accepted) {
        return res.status(400).json({ error: 'Save your CLI and model first, then accept the risk.' });
      }
      res.json({ riskAccepted: config?.riskAcceptedAt != null });
    } catch (error) { next(error); }
  });

  app.put('/api/agent-setup/budget', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentBudgetSchema.parse(req.body ?? {});
      const budget = await setAgentBudget(db, req.auth!.workspaceId, input, req.auth!.userId);
      res.json({ budget });
    } catch (error) { next(error); }
  });

  // The unattended cadence -- app-spec.md §2, "works when your laptop is
  // closed". Deliberately a sibling of the budget rather than part of it: this
  // is the second of the two switches, and both have to be on before anything
  // spends the operator's key with nobody in the room.
  app.put('/api/agent-setup/schedule', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentScheduleSchema.parse(req.body ?? {});
      const schedule = await setAgentSchedule(db, req.auth!.workspaceId, input, req.auth!.userId);
      res.json({ schedule });
    } catch (error) { next(error); }
  });

  app.get('/api/agent-runs', async (req: AuthedRequest, res, next) => {
    try {
      const filters = agentRunFiltersSchema.parse(req.query);
      res.json({ runs: await listAgentRuns(db, req.auth!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  // Starting a run by hand. The other half of "nothing can start a run" -- the
  // schedule above covers the unattended case, this one covers a human who
  // wants an answer now.
  //
  // A budget refusal surfaces as 409 through the error middleware, which
  // already maps AgentBudgetError; it is not re-handled here.
  app.post('/api/agent-runs', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentRunStartSchema.parse(req.body ?? {});

      // One run at a time per workspace, and the reason is the budget.
      //
      // `assertAgentBudgetAvailable` is a PRE-FLIGHT: it reads spend, decides,
      // and the spend it read only grows once the run starts calling the model.
      // Four requests landing together at 1999 of 2000 cents therefore all read
      // 1999 and all pass, and the workspace overshoots the cap by however many
      // loops were started -- not the "at most one call" section 5 promises.
      // The schedule already refuses to overlap for exactly this reason; the
      // manual route did not, so a human clicking Start four times was the one
      // uncapped path left.
      //
      // lc-debt: duplicates the private `hasRunningAgentRun` in
      // src/server/agent/schedule.ts, and is still check-then-act -- two
      // requests inside the same millisecond can both pass this and both start.
      // Upgrade path: export one helper from schedule.ts, and make the claim
      // atomic the way `claimDueAgentSchedules` already is, by having
      // `startAgentRun` insert conditionally (INSERT ... SELECT ... WHERE NOT
      // EXISTS a running row for the workspace) so the row it returns IS the
      // lease and nothing outside it needs to check first.
      const running = await db
        .prepare("SELECT 1 AS present FROM agent_runs WHERE workspace_id=? AND status='running' LIMIT 1")
        .get<{ present: number }>(req.auth!.workspaceId);
      if (running) {
        return res.status(409).json({
          error: 'An agent run is already in progress for this workspace. Wait for it to finish, or stop it first.'
        });
      }

      const run = await acceptAgentRun(
        db,
        { workspaceId: req.auth!.workspaceId, goal: input.goal, maxSteps: input.maxSteps },
        (error) => req.log.error({ err: error }, 'Detached hosted agent run failed')
      );
      res.status(201).json({ run });
    } catch (error) { next(error); }
  });

  app.get('/api/agent-runs/:id', async (req: AuthedRequest, res, next) => {
    try {
      const run = await getAgentRun(db, req.auth!.workspaceId, String(req.params.id));
      if (!run) return res.status(404).json({ error: 'Agent run not found' });
      res.json({ run });
    } catch (error) { next(error); }
  });
  // The kill switch from section 5. It deliberately consults nothing -- not the
  // budget, not the config, not whether a key exists -- because the one moment
  // it is needed is the moment something else is already wrong.
  //
  // `reason` is OPTIONAL and never pre-filled (migration 036). The LinkedIn seat
  // kill switch demands one and this one asks for one: an operator holding a
  // stop button at 2am is not owed a form validation, but the note they choose
  // to leave is the one they will read three weeks from now.
  //
  // `runId` narrows the stop to a single run. Absent, it asks every running run
  // in the workspace to stop -- which is what this route has always done and
  // what a workspace-wide "stop everything" still needs.
  app.post('/api/agent-runs/stop', async (req: AuthedRequest, res, next) => {
    try {
      const input = agentRunStopSchema.parse(req.body ?? {});
      const requests = await requestAgentRunStop(db, req.auth!.workspaceId, {
        runId: input.runId ?? null,
        reason: input.reason ?? null
      });
      // `stopped` keeps its meaning verbatim: how many runs were ASKED. Nothing
      // here may report them as stopped -- only the loop's own status can.
      res.json({ stopped: requests.length, requests });
    } catch (error) { next(error); }
  });

  /* =====================================================================
   * The ledger, and the one combined spend surface.
   * docs/gtm-shell-shape.md sections 3.4, 3.5 and 3.7 (Wave B).
   * ================================================================== */

  /**
   * Render an export and store the bytes.
   *
   * `src/client/MarketingScreen.tsx` has sold "Exportable ledger and evidence"
   * as the headline reason to self-host since before any control existed. This
   * is that control's server half.
   *
   * Rendered ONCE. The archive's manifest publishes a sha256 per file, and a
   * download that re-rendered would serve different bytes under a hash that had
   * already been handed out -- the same posture, for a sharper reason, as the
   * campaign export route below.
   */
  app.post('/api/ledger/exports', async (req: AuthedRequest, res, next) => {
    try {
      const input = ledgerExportSchema.parse(req.body ?? {});
      const record = await createLedgerExport(
        db,
        { workspaceId: req.auth!.workspaceId, windowDays: input.window, include: input.include },
        new Date()
      );
      // The response names row counts of the caller's own runs. Not cacheable,
      // for the same reason the download below is not.
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(record);
    } catch (error) { next(error); }
  });

  app.get('/api/ledger/exports', async (req: AuthedRequest, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ exports: await listLedgerExports(db, req.auth!.workspaceId) });
    } catch (error) { next(error); }
  });

  /**
   * The download. Reads stored bytes and touches nothing else.
   *
   * Three headers, the same three the campaign export download sets: the file
   * is an attachment, it is typed, and it is NEVER cached. It contains every
   * client name, message body and outreach target the workspace has recorded,
   * and a cache that outlives a deletion is a cache that keeps handing back
   * somebody who asked to be forgotten.
   */
  app.get('/api/ledger/exports/:id', async (req: AuthedRequest, res, next) => {
    try {
      const stored = await readLedgerExport(db, req.auth!.workspaceId, String(req.params.id));
      if (!stored) return res.status(404).json({ error: 'Ledger export not found' });
      res.setHeader('Content-Type', stored.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${stored.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(stored.bytes);
    } catch (error) { next(error); }
  });

  /**
   * Spent, sent, produced -- one payload, one period, no attribution.
   *
   * The refusal is the feature: nothing joins a model call or an outreach
   * action to an invoice, so `produced.attribution` ships the sentence saying
   * so and the client renders it verbatim.
   */
  app.get('/api/loop/cost', async (req: AuthedRequest, res, next) => {
    try {
      const filters = loopCostFiltersSchema.parse(req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await loopCost(db, req.auth!.workspaceId, filters.window, new Date()));
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

  app.get('/api/research', async (req: AuthedRequest, res) => {
    res.json({ sources: await listResearchSources(db, req.auth!.workspaceId), runs: await listResearchRuns(db, req.auth!.workspaceId) });
  });

  app.post('/api/research/sources', async (req: AuthedRequest, res) => {
    try { res.status(201).json({ source: await saveResearchSource(db, req.auth!.workspaceId, req.body) }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save research source' }); }
  });

  app.post('/api/research/sources/:id/run', async (req: AuthedRequest, res) => {
    const input = z.object({ mode: z.enum(['incremental','backfill']).default('incremental') }).parse(req.body ?? {});
    try { res.json(await syncResearchSource(db, req.auth!.workspaceId, String(req.params.id), input.mode)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Research sync failed' }); }
  });

  app.post('/api/research/search', async (req: AuthedRequest, res) => {
    const input = z.object({ text: z.string().max(1000).optional(), sourceId: z.string().optional(), community: z.string().max(100).optional(), includeComments: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(req.body ?? {});
    res.json({ results: await searchResearchCorpus(db, req.auth!.workspaceId, input) });
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

  /* =====================================================================
   * LinkedIn (docs/linkedin-outreach-plan.md section 5).
   *
   * THE INVARIANT, restated where the routes live because this is where it
   * would be broken: NO ROUTE HERE SENDS ANYTHING. The API plans, prices the
   * plan against the seat's real ledger, and carries it to a human for
   * approval. What reaches LinkedIn reaches it either through the operator's
   * own tool -- from a file they downloaded -- or through the self-hosted
   * local worker driving the browser they logged into by hand.
   *
   * Structurally, not by convention: every status write below goes through
   * `writeActionStatus` in linkedin/campaigns.ts, which refuses a
   * sent/accepted/replied status unless the caller names itself
   * 'outcome-ingest'. Exactly one route does, and it is the one section 5
   * names for the job.
   * ================================================================== */

  app.get('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();
    const seat = await getSeat(db, workspaceId);
    const seatRef = seat ? { workspaceId, seatKey: seat.seatKey } : ownerSeat(workspaceId);
    const counts = await Promise.all(PACED_KINDS.map((kind) => countActionsInWindow(db, seatRef, kind, 24, now)));
    // A boolean and a masked address. There is no shape of this response that
    // carries the password, and no privilege level that changes that -- the
    // store has no function that could produce it here (secrets/linkedin.ts).
    const credentials = await describeLinkedInCredentials(db, workspaceId);
    res.json({
      seat: seat ?? null,
      auth: {
        hasCredentials: credentials.hasCredentials,
        maskedEmail: credentials.maskedEmail,
        sessionValidAt: seat?.sessionValidAt ?? null
      },
      // What became of the last detect handed to a host-side worker (027). The
      // client polls this route while a request is outstanding, and a request
      // that FAILED has to reach the operator here -- otherwise a detect the
      // worker could not perform is indistinguishable from one still queued,
      // and the screen spins forever.
      detectRequest: await latestSeatDetectRequest(db, workspaceId),
      posture: seat ? effectivePosture(seat, now) : null,
      // Week 1 for a workspace with no seat: an unknown ramp clock is paced as
      // a new seat, never as an established one (seats.ts).
      warmupWeek: warmupWeekOf(seat?.activatedAt ?? null, now),
      warmupWeeks: WARMUP_WEEKS,
      // Rolling 24h, not "since midnight": midnight in whose timezone was never
      // defined, and a calendar cap of 20 delivers 40 across the boundary.
      today: Object.fromEntries(PACED_KINDS.map((kind, index) => [kind, counts[index]]))
    });
  }));

  // Posture is deliberately NOT writable here. warmup-vs-steady is derived from
  // the account's age on every read, and the two postures an operator really
  // owns -- paused and cooldown -- have their own routes below, because a kill
  // switch buried in a settings PUT is a kill switch nobody finds.
  app.put('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    const input = linkedinSeatSchema.parse(req.body ?? {});
    const now = new Date();
    let seat;
    try {
      seat = await upsertSeat(db, req.auth!.workspaceId, input as SeatPatch, now);
    } catch (error) {
      // seats.ts owns the label/timezone/date rules and its refusals are
      // operator input errors, not faults. Same pattern as the agent config route.
      if (error instanceof Error && LINKEDIN_SEAT_INPUT_ERROR.test(error.message)) {
        throw new LinkedInApiError(error.message, 400);
      }
      throw error;
    }
    res.json({ seat, posture: effectivePosture(seat, now) });
  }));

  // The kill switch. Consults nothing -- not the plan, not the ledger, not the
  // worker -- for the same reason the agent's stop route does not: the one
  // moment it is needed is the moment something else is already wrong.
  app.post('/api/linkedin/seat/pause', linkedinRoute(async (req, res) => {
    const input = linkedinPauseSchema.parse(req.body ?? {});
    const seat = await pauseSeat(db, req.auth!.workspaceId, input.reason, new Date());
    if (!seat) throw new LinkedInApiError('No LinkedIn seat is configured for this workspace', 404);
    res.json({ seat, posture: 'paused' });
  }));

  app.post('/api/linkedin/seat/resume', linkedinRoute(async (req, res) => {
    const now = new Date();
    const seat = await resumeSeat(db, req.auth!.workspaceId, now);
    if (!seat) throw new LinkedInApiError('No LinkedIn seat is configured for this workspace', 404);
    // Stored 'warmup', but resuming a two-year-old account does not put it back
    // through the ramp -- the effective posture is re-derived from its age.
    res.json({ seat, posture: effectivePosture(seat, now) });
  }));

  /**
   * Forget this seat, including its ramp clock.
   *
   * The one destructive route in this section. `deleteSeat` never touches the
   * send ledger, the detect-request history or stored credentials -- only the
   * seat row itself -- but that row is the warm-up ramp, so the next seat this
   * workspace gets starts back at week 1, exactly as an undeclared seat does.
   * The client is expected to confirm before calling this.
   */
  app.delete('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    const deleted = await deleteSeat(db, req.auth!.workspaceId);
    res.json({ deleted });
  }));

  /* ---------------------------------------------------------------------
   * The sign-in the operator may hand over, and the one they may not.
   *
   * WRITE-ONLY OVER THE WIRE, structurally. `putLinkedInCredentials` returns a
   * boolean and a masked address, `describeLinkedInCredentials` cannot decrypt
   * anything at all, and there is no reveal route -- for anyone, at any
   * privilege level, the same rule the model key has had since day one
   * (docs/byok-and-hosted-agent.md section 3).
   *
   * HOSTED REFUSES, TWICE. Once here, so the answer is a 409 with one sentence
   * rather than a 500; and again unconditionally inside the store, so a caller
   * that skipped this check still stores nothing. One operator holding their
   * own LinkedIn password is a small, informed, self-inflicted risk. A
   * multi-tenant service holding many humans' is a different product.
   * ------------------------------------------------------------------ */

  app.post('/api/linkedin/seat/credentials', linkedinRoute(async (req, res) => {
    const input = linkedinCredentialsSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;

    // Credential-management carve-out (design doc "Decisions made during
    // brainstorming" #2): full workspace parity for any member, EXCEPT this.
    // Only the workspace owner may replace the stored LinkedIn sign-in.
    if (req.auth!.role !== 'owner') {
      throw new LinkedInApiError('Only the workspace owner can manage the stored LinkedIn credentials', 403);
    }

    // The one unconditional gate, read from the one definition of it.
    if (linkedInWorkerConfig().hosted) throw new LinkedInApiError(LINKEDIN_CREDENTIALS_HOSTED_REFUSAL, 409);
    // A deployment with no key would seal nothing, and `sealSecret` would throw
    // a sentence about environment variables into a 500. Asked first instead.
    if (!secretsConfigured()) throw new LinkedInApiError(LINKEDIN_CREDENTIALS_UNSEALED_REFUSAL, 409);

    let summary;
    try {
      summary = await putLinkedInCredentials(db, {
        workspaceId,
        email: input.email,
        password: input.password,
        actorUserId: req.auth!.userId
      });
    } catch (error) {
      // The store's own refusals are operator-facing facts, not faults. Nothing
      // it throws contains either value.
      if (error instanceof Error && error.message === LINKEDIN_CREDENTIALS_HOSTED_REFUSAL) {
        throw new LinkedInApiError(error.message, 409);
      }
      throw error;
    }

    res.json(summary);
  }));

  /**
   * Give the password back to nobody.
   *
   * Wipes it. The stored browser session is deliberately NOT invalidated:
   * deleting a password does not sign a Chrome profile out, and pretending it
   * did would send an operator to re-authenticate something that still works.
   * Nothing can sign this seat back in until a new pair is saved.
   */
  app.delete('/api/linkedin/seat/credentials', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    // Same owner-only carve-out as the save route above.
    if (req.auth!.role !== 'owner') {
      throw new LinkedInApiError('Only the workspace owner can manage the stored LinkedIn credentials', 403);
    }
    await deleteLinkedInCredentials(db, workspaceId, req.auth!.userId);
    res.json({ hasCredentials: false, maskedEmail: null });
  }));

  /**
   * Make this seat's LinkedIn session usable.

   * REUSE FIRST, SIGN IN SECOND. A stored session that still works is kept: it
   * is faster and a far weaker ban signal than re-authenticating on every run
   * (plan 1.3). The password is not even read on that path.
   *
   * FOUR ANSWERS, AND `otp_required` IS NOT ONE OF THE FAILURES:
   *
   *   ok            signed in, or already was.
   *   otp_required  LinkedIn sent a code. Ask the operator for it and call this
   *                 route again with `otp`.
   *   challenge     a captcha or device check. Only a person at a window can
   *                 finish it, and the message says exactly that.
   *   failed        anything else, in one sentence.
   *
   * 200 for all four: none of them is an HTTP-level error, and a client that
   * has to distinguish "wrong password" from "needs a code" should read a field
   * rather than a status code.
   */
  app.post('/api/linkedin/seat/login', linkedinRoute(async (req, res) => {
    const input = linkedinSeatLoginSchema.parse(req.body ?? {});

    let config: LinkedInLocalWorkerConfig;
    try {
      config = validateEnvironment().linkedinLocalWorker;
    } catch (error) {
      throw new LinkedInApiError(
        `This server could not read its own configuration: ${error instanceof Error ? error.message : 'unknown error'}`,
        409
      );
    }
    if (!config.enabled) throw new LinkedInApiError(linkedInOffReason(config), 409);

    res.json(await loginLinkedInSeat(db, config, {
      workspaceId: req.auth!.workspaceId,
      otp: input.otp,
      now: new Date()
    }));
  }));

  /**
   * Read the seat out of the browser the operator already logged into.
   *
   * THIS IS THE ROUTE THAT DELETES THE SETUP FORM. Waalaxy, Dripify and
   * HeyReach ask an operator for exactly one thing -- log in -- and read the
   * rest from the session. So does this: the profile URL, the display name and
   * the exact connection count are facts the signed-in browser already holds,
   * and none of them was ever worth asking a human to type and then trusting.
   *
   * `timezone` is the one field in the body because it is the one fact the
   * server genuinely cannot derive -- the client knows which 08:00-18:00 a plan
   * must spread across and the server does not. It comes from the browser's own
   * Intl settings, not from a form.
   *
   * 409, NOT 500, when automation is off or LinkedIn wants a human. Neither is
   * a fault; both are something the operator has to go and do, and the body
   * carries that ONE thing rather than a paragraph about environment variables.
   *
   * 202 WHEN THIS PROCESS CANNOT OPEN A BROWSER, which is the normal case the
   * moment the API runs in a container: no display, no browser binaries, and a
   * home directory that is not the operator's. Detection then becomes a
   * request for the operator's own `npm run linkedin:worker` to fulfil against
   * this same Postgres, guarded by the partial unique index in migration 027
   * exactly as `linkedin_batches` work is. The client keeps polling
   * GET /api/linkedin/seat, which is what it already does.
   */
  app.post('/api/linkedin/seat/detect', linkedinRoute(async (req, res) => {
    const input = linkedinSeatDetectSchema.parse(req.body ?? {});

    let config: LinkedInLocalWorkerConfig;
    try {
      config = validateEnvironment().linkedinLocalWorker;
    } catch (error) {
      // Same posture as the worker-status route: the screen that answers "why
      // is nothing sending" must not be the screen that 500s.
      throw new LinkedInApiError(
        `This server could not read its own configuration: ${error instanceof Error ? error.message : 'unknown error'}`,
        409
      );
    }

    if (!config.enabled) throw new LinkedInApiError(linkedInOffReason(config), 409);

    /**
     * WHICH PROCESS DOES THIS?
     *
     * A headed browser is best and is used whenever one can be opened. Failing
     * that -- the container, always -- a seat that stored its own sign-in can
     * be served right here by a headless Chromium, because that browser can
     * type a password even though it cannot show anybody a window. THAT IS THE
     * WHOLE POINT OF THE CREDENTIALS PATH: no host-side worker, no second
     * machine, nothing for the operator to run.
     *
     */
    const canDetectHere = linkedInBrowserReadiness(config).canLaunchHeaded
      || ((await describeLinkedInCredentials(db, req.auth!.workspaceId)).hasCredentials
        && linkedInHeadlessReadiness(config).canLaunchHeadless);

    if (!canDetectHere) {
      let request: Awaited<ReturnType<typeof requestSeatDetect>>;
      try {
        request = await requestSeatDetect(db, { workspaceId: req.auth!.workspaceId, timezone: input.timezone }, new Date());
      } catch (error) {
        if (error instanceof Error && LINKEDIN_SEAT_INPUT_ERROR.test(error.message)) throw new LinkedInApiError(error.message, 400);
        throw error;
      }
      return res.status(202).json({
        status: 'pending',
        detected: null,
        seat: null,
        degraded: [],
        requestedAt: request.requestedAt,
        message: 'Run `npm run linkedin:worker` on your machine to finish connecting.'
      });
    }

    let result: Awaited<ReturnType<typeof detectLinkedInSeat>>;
    try {
      result = await detectLinkedInSeat(db, config, {
        workspaceId: req.auth!.workspaceId,
        timezone: input.timezone,
        now: new Date()
      });
    } catch (error) {
      // seats.ts owns the timezone rule and its refusal is caller input, not a
      // fault. Same mapping as the seat PUT above.
      if (error instanceof Error && LINKEDIN_SEAT_INPUT_ERROR.test(error.message)) {
        throw new LinkedInApiError(error.message, 400);
      }
      throw error;
    }

    if (result.blocked) throw new LinkedInApiError(result.blocked, 409);
    res.json({ status: 'detected', detected: result.detected, seat: result.seat, degraded: result.degraded });
  }));

  // Every effective ceiling WITH ITS PROVENANCE: which rule bound it, and
  // whether the number behind it is a HARD FACT or REPORTED practitioner
  // consensus (plan 1.1/1.3/1.4, and the UI honesty rule in plan 6). Never
  // flattened to bare numbers -- the operator is betting their account on
  // these, and they deserve to know which is which.
  app.get('/api/linkedin/limits', linkedinRoute(async (req, res) => {
    res.json(await effectiveLinkedInLimits(db, req.auth!.workspaceId, new Date()));
  }));

  // A DRY RUN. `planPacing` is pure with respect to the ledger -- it reads
  // history and writes nothing -- and this route keeps it that way: no slot
  // becomes a `linkedin_actions` row here. Persisting is the campaign path's
  // job, downstream of a human approving the exact plan they were shown.
  app.post('/api/linkedin/plan', linkedinRoute(async (req, res) => {
    const input = linkedinPlanSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    // Exclusions are applied BEFORE planning, never at send time: a person
    // filtered out later would still have been in the payload a founder read.
    const { kept, excluded } = await filterExcluded(db, workspaceId, input.targets);
    if (kept.length === 0) {
      throw new LinkedInApiError('Every target on this list is on the workspace exclusion list, so there is nothing to plan.', 400);
    }
    const plan = await planPacing(
      db,
      { workspaceId, kind: input.kind, targets: kept, horizonDays: input.horizonDays, seatKey: input.seatKey ?? OWNER_SEAT_KEY },
      new Date()
    );
    res.json({ plan, excluded, persisted: false });
  }));

  app.get('/api/linkedin/actions', linkedinRoute(async (req, res) => {
    const filters = linkedinActionFiltersSchema.parse(req.query);
    res.json({ actions: await listActions(db, req.auth!.workspaceId, filters) });
  }));

  // Drop a planned action. The body schema is strict and empty, which is the
  // point: there is no field here a caller could use to name a status, so
  // "skip" cannot be talked into meaning "sent".
  app.post('/api/linkedin/actions/:id/skip', linkedinRoute(async (req, res) => {
    linkedinSkipSchema.parse(req.body ?? {});
    const action = await skipAction(db, req.auth!.workspaceId, String(req.params.id), new Date());
    res.json({ action });
  }));

  // The ONLY route that may move an action to sent/accepted/replied, and it is
  // a REPORT rather than an instruction: the operator is telling Trevra what
  // already happened in their own tool, so the acceptance-rate throttle and the
  // day-over-day arithmetic have a real denominator (plan 7.2).
  app.post('/api/linkedin/actions/outcome', linkedinRoute(async (req, res) => {
    const input = linkedinOutcomeSchema.parse(req.body ?? {});
    const action = await ingestOutcome(db, { workspaceId: req.auth!.workspaceId, ...input }, new Date());
    res.json({ action });
  }));

  /**
   * The template library, and the vocabulary that goes with it.
   *
   * Static, so it needs no workspace -- but it stays behind the same auth as
   * every other route here rather than becoming a public endpoint, because
   * "which sequences does Trevra ship" is product surface and not marketing.
   *
   * `mergeFields` and `inviteNoteMaxChars` ride along on purpose: a client that
   * hardcodes either will drift from the server that enforces both, and the
   * failure mode is an editor that lets an operator type copy the API then
   * refuses.
   */
  app.get('/api/linkedin/sequence-templates', linkedinRoute(async (_req, res) => {
    res.json({
      templates: SEQUENCE_TEMPLATES,
      defaultTemplateId: DEFAULT_SEQUENCE_TEMPLATE_ID,
      mergeFields: SUPPORTED_MERGE_FIELDS,
      inviteNoteMaxChars: INVITE_NOTE_MAX_CHARS,
      maxSteps: MAX_SEQUENCE_STEPS,
      /**
       * The branch vocabulary, for the same reason `mergeFields` rides along:
       * it is a CLOSED list of five, an editor has to render a dropdown of
       * exactly those, and a client that hardcodes them drifts from the server
       * that validates them. The failure mode is an editor that lets an
       * operator pick a branch the API then refuses.
       */
      branchOn: BRANCH_ON_VALUES,
      actionKinds: ACTION_KIND_VALUES,
      pacedKinds: PACED_KIND_VALUES
    });
  }));

  app.get('/api/linkedin/campaigns', linkedinRoute(async (req, res) => {
    res.json({ campaigns: await listCampaigns(db, req.auth!.workspaceId) });
  }));

  /**
   * Draft a campaign from a DOMAIN instead of from a nine-field form.
   *
   * The complaint this answers is that an operator should not hand-type what
   * the product can already fetch: `gtm.enrich-company` reads the company's own
   * site, and five of the nine fields describe that company. What it reads
   * comes back filled and evidenced; what it cannot read comes back EMPTY and
   * named in `degraded`, never as a plausible guess. Proof numbers in
   * particular are only ever counted, never written -- see `brief.ts`.
   *
   * PERSISTS NOTHING. This is a form the operator finishes and then posts to
   * `POST /api/linkedin/campaigns`, which is still the only route that starts a
   * campaign. Enrichment is a network read of a public site; a draft that wrote
   * a row would make "let me see what this domain looks like" a side effect.
   */
  app.post('/api/linkedin/campaigns/draft', linkedinRoute(async (req, res) => {
    const input = linkedinDraftSchema.parse(req.body ?? {});

    const template = input.templateId ? getSequenceTemplate(input.templateId) : undefined;
    if (input.templateId && !template) {
      throw new LinkedInApiError(
        `No sequence template called '${input.templateId}'. GET /api/linkedin/sequence-templates lists the ones that exist.`,
        404
      );
    }

    let profile: Awaited<ReturnType<typeof enrichCompany>>;
    try {
      profile = await enrichCompany(input.domain);
    } catch (error) {
      // A domain that will not resolve, or one that resolves somewhere private,
      // is an operator error and reads as one. It is never a 500.
      throw new LinkedInApiError(`Could not read ${input.domain}: ${error instanceof Error ? error.message : String(error)}`, 400);
    }

    const { brief, degraded } = briefFromProfile(profile);

    /*
     * SUGGESTIONS RIDE ALONGSIDE THE BRIEF, NEVER INSIDE IT.
     *
     * `brief` is what the site SAID; `suggested` is what a model THINKS the
     * four unreadable fields are. Merging them would make the response unable
     * to answer "was this read or guessed", which is the one question the whole
     * enrichment path is built to keep answerable. `degraded` still names every
     * suggested field for the same reason: a guess does not fill a gap.
     *
     * Null when no model is configured, and a failure never fails the draft --
     * the operator gets the same empty fields they got before, plus a sequence.
     */
    const suggestion = await suggestBriefFields(db, req.auth!.workspaceId, profile, {
      log: (message: string) => console.warn(message)
    });

    const complete = briefIsComplete(brief);

    // The AI draft FILLS a shape; it does not dictate one. A template names the
    // shape explicitly; without one, a complete brief drafts the default
    // five-touch copy and an incomplete brief falls back to that same shape as
    // a template, because there is nothing to draft specific copy from yet.
    const steps = template ? template.steps : complete ? undefined : defaultSequenceTemplate().steps;
    const templateId = template ? template.id : complete ? null : DEFAULT_SEQUENCE_TEMPLATE_ID;
    if (!template && !complete) degraded.push('sequence:drafted-from-template');

    const skillInput = linkedinSequenceSkill.manifest.inputSchema.parse({
      ...(steps === undefined ? {} : { steps }),
      ...(complete ? { icp: brief.icp, offer: brief.offer } : {}),
      targets: input.targets
    });
    const sequence = await linkedinSequenceSkill.run(skillInput, {
      db,
      workspaceId: req.auth!.workspaceId,
      now: () => new Date()
    });

    res.json({
      brief,
      sequence,
      degraded,
      templateId,
      ...(suggestion ? { suggested: suggestion.fields, suggestedBy: suggestion.source } : {})
    });
  }));

  /**
   * Start a campaign: run `gtm.linkedin-outreach`.
   *
   * The campaign id is minted BEFORE the run starts, because the approval
   * payload carries it and the payload's hash is what the export step is bound
   * to. The row itself is written only once the run exists, so a playbook that
   * refuses its input leaves no orphan holding the name.
   *
   * A BRIEF OR A SEQUENCE, NEVER A ROUND TRIP OF BOTH. `sequenceSteps` skips
   * generation entirely and the assembled copy goes straight into the same
   * single run every campaign gets: `planPacing`, the guard at
   * `requireAllowed: true`, one pending approval. This is what makes "pick a
   * template, edit the copy, launch" one call rather than a create followed by
   * an edit that throws away a sequence nobody asked for.
   */
  app.post('/api/linkedin/campaigns', linkedinRoute(async (req, res) => {
    const input = linkedinCampaignSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();

    // EXACTLY ONE SOURCE OF COPY. A brief is what a sequence is drafted from;
    // steps are a sequence that already exists. With both on the request the
    // server would be choosing which one the operator meant, and the wrong
    // choice is a campaign whose words nobody wrote.
    const sequenceSteps = input.input.sequenceSteps;
    const supplied = input.input as Record<string, unknown>;
    const hasBrief = supplied.icp !== undefined || supplied.offer !== undefined;
    if (sequenceSteps && hasBrief) {
      throw new LinkedInApiError(
        'Send sequenceSteps to use the copy as it is, or an icp and an offer to draft it from, but not both -- only one of them can be this campaign\'s sequence.',
        400
      );
    }
    if (!sequenceSteps && !hasBrief) {
      throw new LinkedInApiError(
        'A campaign needs copy: send sequenceSteps to use as they are, or an icp and an offer for Trevra to draft the sequence from.',
        400
      );
    }

    // Same validator, same refusals, as the sequence editor -- and run before
    // the campaign id is minted, so a bad step leaves nothing behind.
    if (sequenceSteps) validatedSequence(sequenceSteps);

    const { kept, excluded } = await filterExcluded(db, workspaceId, input.input.targets);
    if (kept.length === 0) {
      throw new LinkedInApiError('Every target on this list is on the workspace exclusion list, so there is nothing to campaign.', 400);
    }

    const campaignId = newCampaignId();
    const run = await startPlaybookRun(db, {
      workspaceId,
      playbookId: LINKEDIN_PLAYBOOK_ID,
      version: input.version,
      payload: { ...input.input, targets: kept, campaignId },
      actorType: 'user',
      actorId: req.auth!.userId
    });

    const campaign = await createCampaign(
      db,
      {
        id: campaignId,
        workspaceId,
        name: input.name,
        status: run.status === 'completed' ? 'completed' : run.status === 'failed' || run.status === 'cancelled' ? 'stopped' : 'running',
        sequence: run.steps.find((step) => step.stepId === 'sequence')?.output ?? {},
        // The inputs, kept on the campaign (029) so a later sequence edit can
        // re-plan through the same pacing and guard even after this run has
        // been pruned out of history.
        brief: run.input,
        playbookRunId: run.id
      },
      now
    );
    res.status(201).json({ campaign, run, excluded });
  }));

  /**
   * Edit the copy, and re-earn the approval.
   *
   * THE INVARIANT: an edited sequence is a DIFFERENT payload, and the approval
   * binds `canonicalPayloadHash(payload)`. So this does not patch a stored blob
   * and return -- it validates the list, puts it back through the SAME
   * `gtm.linkedin-outreach` run the create path uses (`planPacing`, then the
   * safety gate at `requireAllowed: true`), and leaves the campaign pointing at
   * that new run's pending approval. Nothing here shortcuts the pacing engine,
   * because a re-planned campaign that skipped it would be a campaign whose
   * schedule nobody checked against the seat's real ledger.
   *
   * AND THE REFUSAL: if any of this campaign's actions has left 'planned' --
   * exported, sent, accepted, replied, declined -- the edit is refused
   * outright. Rewriting the copy of messages already delivered is not an edit;
   * it is a lie about what was sent, and the ledger is the one place that
   * question has to stay answerable.
   */
  app.patch('/api/linkedin/campaigns/:id/sequence', linkedinRoute(async (req, res) => {
    const input = linkedinSequenceEditSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();

    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    if (campaign.status === 'stopped') {
      throw new LinkedInApiError('This campaign was stopped, so there is nothing left to edit.', 409);
    }

    const delivered = await countDeliveredActions(db, workspaceId, campaign.id);
    if (delivered > 0) {
      throw new LinkedInApiError(
        `${delivered} action(s) in this campaign have already been exported or sent, so this copy is the record of what went out and cannot be rewritten. Stop this campaign and start another.`,
        409
      );
    }

    // Validated BEFORE anything is written or re-planned: a bad step costs one
    // 400, not a playbook run and a campaign left pointing at a failure.
    const validated = validatedSequence(input.steps);

    const brief = await campaignPlaybookInput(db, workspaceId, campaign);
    if (!brief) {
      throw new LinkedInApiError(
        'This campaign has no plan input on file, so its sequence cannot be re-planned or re-approved. Start a new campaign from these steps instead.',
        409
      );
    }

    const previousRunId = campaign.playbookRunId;
    const run = await startPlaybookRun(db, {
      workspaceId,
      playbookId: LINKEDIN_PLAYBOOK_ID,
      payload: { ...brief, campaignId: campaign.id, sequenceSteps: input.steps },
      actorType: 'user',
      actorId: req.auth!.userId
    });

    // The run's own critique is the one the new approval payload carries, so it
    // is the one stored. `validated` only stands in when the run never got that
    // far, and a campaign pointing at a failed run cannot be exported anyway.
    const sequence = (run.steps.find((step) => step.stepId === 'sequence')?.output as LinkedInSequence | undefined) ?? validated;
    const updated = await attachCampaignRun(
      db,
      workspaceId,
      campaign.id,
      {
        playbookRunId: run.id,
        sequence,
        status: run.status === 'completed' ? 'completed' : run.status === 'failed' || run.status === 'cancelled' ? 'stopped' : 'running'
      },
      now
    );

    res.json({
      campaign: updated ?? campaign,
      sequence,
      run,
      /** The run whose approval this edit retired. Null when there was nothing to retire. */
      previousRunId,
      approvalInvalidated: previousRunId !== null
    });
  }));

  app.get('/api/linkedin/campaigns/:id', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    const run = campaign.playbookRunId ? await getPlaybookRun(db, workspaceId, campaign.playbookRunId) : null;
    res.json({
      campaign,
      run,
      actions: await listActions(db, workspaceId, { campaignId: campaign.id, limit: 500 }),
      exports: await listCampaignExports(db, workspaceId, campaign.id)
    });
  }));

  app.get('/api/linkedin/campaigns/:id/exports', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    res.json({ exports: await listCampaignExports(db, workspaceId, campaign.id) });
  }));

  /**
   * The download. Reads stored bytes and touches nothing else.
   *
   * DO NOT "optimise" this into a re-render. `exportCampaign` writes the plan's
   * slots into `linkedin_actions` as 'exported' as a deliberate side effect, so
   * regenerating on download would re-run that ledger write on every click --
   * against the one table the entire pacing engine reasons from. Rendered once,
   * served forever. See migrations/025 and linkedin/campaigns.ts.
   */
  app.get('/api/linkedin/campaigns/:id/export/:exportId', linkedinRoute(async (req, res) => {
    const stored = await readCampaignExport(db, req.auth!.workspaceId, String(req.params.id), String(req.params.exportId));
    if (!stored) throw new LinkedInApiError('LinkedIn export not found', 404);
    res.setHeader('Content-Type', stored.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${stored.filename}"`);
    // The file names people, and a cache that outlives an exclusion is a file
    // that keeps handing out somebody who asked to be left alone.
    res.setHeader('Cache-Control', 'no-store');
    res.send(stored.bytes);
  }));

  /**
   * Render the approved campaign for the operator's own tool.
   *
   * THE BYTES COME FROM THE APPROVED PAYLOAD, never from a fresh plan. The
   * approval bound `canonicalPayloadHash(payload)`, and re-planning here would
   * ship a different schedule under an unchanged approval -- exactly the drift
   * the playbook engine fails closed on. Only the FORMAT may be chosen at this
   * point, because it changes how the same approved plan and copy are
   * rendered, not what they are.
   */
  app.post('/api/linkedin/campaigns/:id/export', linkedinRoute(async (req, res) => {
    const input = linkedinExportRequestSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();

    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    if (campaign.status === 'stopped') {
      throw new LinkedInApiError('This campaign was stopped, so there is nothing left to export.', 409);
    }

    const approved = await approvedCampaignPayload(db, workspaceId, campaign, 'export');

    const format = input.format ?? approved.format;
    const payloadHash = canonicalPayloadHash({ ...approved, format });

    // Already rendered from these exact bytes: hand back the same file. This is
    // what makes a double-clicked Export produce one ledger write, not two.
    const existing = await currentCampaignExport(db, workspaceId, campaign.id, format);
    if (existing) {
      if (existing.payloadHash === payloadHash) return res.status(200).json({ export: existing, rendered: false });
      // A re-approval changed the plan. The old file keeps its id and its bytes
      // -- somebody may already be running it -- but stops being the answer.
      await supersedeCampaignExport(db, workspaceId, existing.id);
    }

    const rendered = await exportCampaign(
      db,
      {
        workspaceId,
        plan: approved.plan,
        sequence: approved.sequence,
        format,
        ...(approved.contacts === undefined ? {} : { contacts: approved.contacts }),
        campaignId: campaign.id,
        payloadHash
      },
      now
    );
    const stored = await storeCampaignExport(
      db,
      {
        workspaceId,
        campaignId: campaign.id,
        format,
        filename: rendered.filename,
        contentType: rendered.contentType,
        bytes: rendered.content,
        payloadHash
      },
      now
    );
    res.status(201).json({
      export: stored,
      rendered: true,
      schedule: rendered.schedule,
      ceilingsApplied: rendered.ceilingsApplied,
      warmupWeek: rendered.warmupWeek,
      timezone: rendered.timezone,
      recorded: rendered.recorded,
      downloadPath: `/api/linkedin/campaigns/${campaign.id}/export/${stored.id}`
    });
  }));

  /**
   * Queue the approved campaign for THIS deployment's local worker.
   *
   * The sibling of the export route above, reached the same way and from the
   * same approval: the bytes come from the payload a human signed, never from a
   * fresh plan, and the same sequence-drift check refuses a campaign whose copy
   * was edited afterwards.
   *
   * WHAT IT DOES NOT DO IS SEND. It writes 'planned' rows; the worker claims
   * them on its own tick, on the operator's own machine, and re-runs the safety
   * gate per action immediately before acting. So this route deliberately does
   * NOT gate on the seat's current budget: the slots are days out, `planPacing`
   * already shaped them, and refusing today for a ceiling that will have
   * refilled by Thursday would reject a campaign that is entirely within its
   * limits.
   *
   * SELF-HOSTED ONLY, and `queueCampaign` is where that is enforced rather than
   * here -- the gate belongs with the write, so the executor's path cannot
   * bypass it by not being a route.
   */
  app.post('/api/linkedin/campaigns/:id/queue', linkedinRoute(async (req, res) => {
    linkedinQueueRequestSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    if (campaign.status === 'stopped') {
      throw new LinkedInApiError('This campaign was stopped, so there is nothing left to queue.', 409);
    }

    const approved = await approvedCampaignPayload(db, workspaceId, campaign, 'queue');
    const queued = await queueCampaign(
      db,
      {
        workspaceId,
        plan: approved.plan,
        sequence: approved.sequence,
        ...(approved.contacts === undefined ? {} : { contacts: approved.contacts }),
        campaignId: campaign.id,
        // The hash of the payload as approved. `format` is deliberately not
        // folded in the way the export route folds it: a queued action has no
        // format, so including one would put a hash on the row that describes a
        // choice nobody made about it.
        payloadHash: canonicalPayloadHash(approved),
        queuedByUserId: req.auth!.userId
      },
      new Date()
    );
    res.status(201).json({ campaignId: campaign.id, ...queued });
  }));

  // Stops the campaign and releases the slots it had queued. It does NOT stop
  // the seat: a batch already in a browser belongs to the worker holding it,
  // and the switch for that is POST /api/linkedin/seat/pause.
  app.post('/api/linkedin/campaigns/:id/stop', linkedinRoute(async (req, res) => {
    const stopped = await stopCampaign(db, req.auth!.workspaceId, String(req.params.id), new Date());
    if (!stopped) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    res.json({ campaign: stopped.campaign, releasedActions: stopped.released });
  }));

  /**
   * Read a target CSV.
   *
   * PERSISTS NOTHING, and says so in the response. The list comes back split
   * three ways -- usable, excluded, already-contacted -- so a founder sees who
   * would actually be approached before any of it becomes a plan. A row only
   * enters `linkedin_actions` downstream of an approval.
   */
  app.post('/api/linkedin/targets/import', linkedinTargetsUpload.single('file'), linkedinRoute(async (req, res) => {
    if (!req.file) throw new LinkedInApiError('A CSV file of LinkedIn targets is required', 400);
    const options = linkedinImportSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;

    const { contacts, skipped } = parseLinkedInTargetCsv(req.file.buffer);
    const { kept, excluded } = await filterExcluded(db, workspaceId, contacts.map((contact) => contact.targetRef));
    const keptSet = new Set(kept);

    const seat = await getSeat(db, workspaceId);
    const seatRef = seat ? { workspaceId, seatKey: seat.seatKey } : ownerSeat(workspaceId);
    const alreadyContacted: string[] = [];
    for (const targetRef of kept) {
      if (await hasTarget(db, seatRef, options.kind, targetRef)) alreadyContacted.push(targetRef);
    }
    const contacted = new Set(alreadyContacted);

    res.status(200).json({
      persisted: false,
      parsed: contacts.length,
      kind: options.kind,
      targets: kept.filter((targetRef) => !contacted.has(targetRef)),
      contacts: contacts.filter((contact) => keptSet.has(contact.targetRef) && !contacted.has(contact.targetRef)),
      excluded,
      // The seat has a non-skipped action of this kind against these already.
      // Planning them again would be refused by the ledger's replay guard, so
      // they are reported here rather than discovered at export time.
      alreadyContacted,
      skippedRows: skipped
    });
  }));

  app.get('/api/linkedin/exclusions', linkedinRoute(async (req, res) => {
    res.json({ exclusions: await listExclusions(db, req.auth!.workspaceId) });
  }));

  app.post('/api/linkedin/exclusions', linkedinRoute(async (req, res) => {
    const input = linkedinExclusionSchema.parse(req.body ?? {});
    const result = await addExclusions(db, req.auth!.workspaceId, input.targets, new Date());
    res.status(201).json(result);
  }));

  app.get('/api/linkedin/analytics', linkedinRoute(async (req, res) => {
    const filters = linkedinAnalyticsSchema.parse(req.query);
    res.json(await linkedinAnalytics(db, req.auth!.workspaceId, filters.days, new Date()));
  }));

  /**
  /**
   * Can this instance drive a browser, and is it set up to?
   *
   * ANSWERED FOR THE SEAT'S AUTH MODE. A credentials seat needs a headless
   * chromium and nothing else; a manual seat needs a display and a logged-in
   * profile directory. Reporting both sets to both would make a working
   * container look broken to the operator it is working for.
   *
   * NEVER THROWS, in any of the ways this can go wrong. A missing playwright,
   * an unreadable profile directory and an environment this build cannot even
   * validate all come back as an honest `false` plus a line saying what to do --
   * because the screen that answers "why is nothing sending" must not be the
   * screen that 500s.
   */
  app.get('/api/linkedin/worker/status', linkedinRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await linkedinWorkerStatus(db, req.auth!.workspaceId));
  }));

  /* ---------------------------------------------------------------------
   * Lead sourcing (030).
   *
   * BEHIND ITS OWN OPT-IN, which is not the local worker's. Sending on your
   * own account on your own machine is what the product is for and defaults
   * ON for a self-hoster; reading other people's profiles out of search
   * results is scraping under LinkedIn's User Agreement 8.2 and defaults OFF.
   * A self-hoster who upgraded must not acquire a crawler they never asked
   * for.
   *
   * THE 409 NAMES WHICH KIND OF OFF, exactly as `linkedInOffReason` does for
   * the worker: hosted is a decision the deployment made and no environment
   * variable can undo it; anything else is a switch, and the sentence names
   * it. Telling an operator to go looking for a setting that does not exist
   * is the dead end this distinction removes.
   * ------------------------------------------------------------------ */

  app.post('/api/linkedin/lead-sources', linkedinRoute(async (req, res) => {
    const input = linkedinLeadSourceSchema.parse(req.body ?? {});
    assertLeadSourcingOn();
    let created;
    try {
      created = await createLeadSource(db, { workspaceId: req.auth!.workspaceId, kind: input.kind, url: input.url }, new Date());
    } catch (error) {
      // leads.ts owns the URL rule and its refusal is caller input, not a fault.
      throw new LinkedInApiError(error instanceof Error ? error.message : String(error), 400);
    }
    // 200 rather than 201 for a duplicate: a double-clicked button did not
    // create anything, and the live row is the honest answer.
    res.status(created.duplicate ? 200 : 201).json({ source: created.source, duplicate: created.duplicate });
  }));

  app.get('/api/linkedin/lead-sources', linkedinRoute(async (req, res) => {
    const filters = linkedinLeadListSchema.parse(req.query);
    const config = leadSourcingConfig();
    res.json({
      // Reported rather than refused: a workspace with sources from before the
      // switch was turned off must still be able to read what they found.
      enabled: leadSourcingEnabled(config),
      offReason: leadSourcingEnabled(config) ? null : leadSourcingOffReason(config),
      sources: await listLeadSources(db, req.auth!.workspaceId, filters.limit)
    });
  }));

  app.get('/api/linkedin/lead-sources/:id', linkedinRoute(async (req, res) => {
    const source = await getLeadSource(db, req.auth!.workspaceId, String(req.params.id));
    if (!source) throw new LinkedInApiError('LinkedIn lead source not found', 404);
    res.json({ source });
  }));

  app.get('/api/linkedin/lead-sources/:id/leads', linkedinRoute(async (req, res) => {
    const filters = linkedinLeadListSchema.parse(req.query);
    const workspaceId = req.auth!.workspaceId;
    // The source is fetched first so a bad id is a 404 rather than an empty
    // list, which reads as "this walk found nobody".
    const source = await getLeadSource(db, workspaceId, String(req.params.id));
    if (!source) throw new LinkedInApiError('LinkedIn lead source not found', 404);
    res.json({ source, leads: await listLeads(db, workspaceId, source.id, filters.limit) });
  }));

  /* ---------------------------------------------------------------------
   * The unified inbox (031).
   *
   * THE SYNC ROUTES DRIVE A BROWSER; THE READ ROUTES DO NOT. Listing
   * conversations and reading one are plain database reads of what a previous
   * sync stored, so they work on any deployment and answer instantly. A sync
   * has to walk LinkedIn at paced gaps, so it is available only where this
   * process can open a browser for this seat -- and 409s with the one thing to
   * do where it cannot. The worker performs the same walk on its own tick, so
   * the sync route is a "refresh now", never the only way it happens.
   *
   * REPLYING SENDS NOTHING HERE, exactly like every other route in this
   * section: it queues a gated `linkedin_actions` row for the worker to claim,
   * gate again, and execute.
   * ------------------------------------------------------------------ */

  app.get('/api/linkedin/inbox/threads', linkedinRoute(async (req, res) => {
    const filters = linkedinInboxFiltersSchema.parse(req.query);
    res.json({ threads: await listThreads(db, req.auth!.workspaceId, filters) });
  }));

  app.get('/api/linkedin/inbox/threads/:threadUrn', linkedinRoute(async (req, res) => {
    const conversation = await readStoredThread(db, req.auth!.workspaceId, String(req.params.threadUrn));
    if (!conversation) throw new LinkedInApiError('LinkedIn conversation not found', 404);
    res.json(conversation);
  }));

  app.post('/api/linkedin/inbox/sync', linkedinRoute(async (req, res) => {
    const input = linkedinInboxSyncSchema.parse(req.body ?? {});
    const config = linkedinWorkerConfigOrRefuse();
    const result = await syncLinkedInInbox(db, config, {
      workspaceId: req.auth!.workspaceId,
      now: new Date(),
      ...(input.maxThreads === undefined ? {} : { maxThreads: input.maxThreads }),
      ...(input.maxMessages === undefined ? {} : { maxMessages: input.maxMessages }),
      log: () => {}
    });
    // 409, not 500: a process with no display is not a fault, it is something
    // the operator has to go and do -- and the sentence says what.
    if (result.blocked) throw new LinkedInApiError(result.blocked, 409);
    res.json(result);
  }));

  app.post('/api/linkedin/inbox/threads/:threadUrn/sync', linkedinRoute(async (req, res) => {
    const input = linkedinInboxSyncSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const threadUrn = String(req.params.threadUrn);
    // Refused here rather than in the browser: navigating to a conversation id
    // somebody typed is not a thing this API does.
    if (!(await threadByUrn(db, workspaceId, threadUrn))) {
      throw new LinkedInApiError('LinkedIn conversation not found', 404);
    }
    const config = linkedinWorkerConfigOrRefuse();
    const result = await syncLinkedInThread(db, config, threadUrn, {
      workspaceId,
      now: new Date(),
      ...(input.maxMessages === undefined ? {} : { maxMessages: input.maxMessages }),
      log: () => {}
    });
    if (result.blocked) throw new LinkedInApiError(result.blocked, 409);
    res.json(result);
  }));

  app.post('/api/linkedin/inbox/threads/:threadUrn/reply', linkedinRoute(async (req, res) => {
    const input = linkedinReplySchema.parse(req.body ?? {});
    const queued = await enqueueReply(
      db,
      {
        workspaceId: req.auth!.workspaceId,
        threadUrn: String(req.params.threadUrn),
        body: input.body,
        ...(input.plannedFor === undefined ? {} : { plannedFor: input.plannedFor }),
        queuedByUserId: req.auth!.userId
      },
      new Date()
    );
    // 201: a row was created. `verdict` rides along so a screen can show WHAT
    // was checked rather than only that it passed -- the same honesty rule the
    // limits route follows.
    res.status(201).json(queued);
  }));

  /* ---------------------------------------------------------------------
   * Pending-invite withdrawal (032).
   *
   * FOUR ROUTES BECAUSE THERE ARE FOUR DECISIONS, and only one of them is
   * destructive. Syncing reads LinkedIn's own sent-invitations list and writes
   * evidence. Listing candidates is a pure query: it shows what WOULD be
   * withdrawn, and shows it before anything is. Enqueueing is reversible
   * database work. Only the queue drain -- which the worker performs on its
   * tick, paced and gated like any other action -- clicks a button in a real
   * account. Collapsing them into one "clean up my invites" call would make
   * the irreversible step the only one an operator ever sees.
   * ------------------------------------------------------------------ */

  app.post('/api/linkedin/withdrawals/sync', linkedinRoute(async (req, res) => {
    const config = linkedinWorkerConfigOrRefuse();
    const result = await syncLinkedInPendingInvites(db, config, {
      workspaceId: req.auth!.workspaceId,
      now: new Date(),
      log: () => {}
    });
    if (result.blocked) throw new LinkedInApiError(result.blocked, 409);
    res.json(result);
  }));

  app.get('/api/linkedin/withdrawals/candidates', linkedinRoute(async (req, res) => {
    const filters = linkedinWithdrawalCandidateSchema.parse(req.query);
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();
    const seat = await getSeat(db, workspaceId);
    const seatRef = seat ? { workspaceId, seatKey: seat.seatKey } : ownerSeat(workspaceId);
    res.json({
      candidates: await selectWithdrawalCandidates(db, seatRef, now, filters),
      // The backlog and the ceiling it is measured against, so the screen can
      // say WHY clearing these returns capacity rather than just that it does.
      pendingInvites: await countPendingInvites(db, seatRef),
      maxOutstandingInvites: MAX_OUTSTANDING_INVITES,
      staleAfterDays: filters.olderThanDays,
      persisted: false
    });
  }));

  app.post('/api/linkedin/withdrawals', linkedinRoute(async (req, res) => {
    const input = linkedinWithdrawalCandidateSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();
    const seat = await getSeat(db, workspaceId);
    if (!seat) throw new LinkedInApiError('No LinkedIn seat is configured for this workspace', 404);
    const swept = await sweepStaleInvites(db, { workspaceId, seatKey: seat.seatKey }, now, input);
    // NOTHING WAS WITHDRAWN HERE. The rows are queued; the local worker claims
    // them, re-runs the whole safety gate against each one, and clicks at
    // 30-120s gaps. Clearing a backlog in one burst is the same volume spike as
    // sending one.
    res.status(201).json({
      candidates: swept.candidates,
      queued: swept.queued,
      duplicates: swept.duplicates,
      withdrawn: 0
    });
  }));

  app.get('/api/linkedin/withdrawals', linkedinRoute(async (req, res) => {
    const filters = linkedinWithdrawalListSchema.parse(req.query);
    res.json({ withdrawals: await listWithdrawals(db, req.auth!.workspaceId, filters) });
  }));

  /* ---------------------------------------------------------------------
   * Engagement actions (034): follow, like, endorse.
   *
   * ONE ROUTE, BECAUSE THERE IS ONE DECISION. Reading them back is
   * `GET /api/linkedin/actions?kind=like`, which already exists and already
   * knows how to filter the ledger -- a second list endpoint would be a second
   * query to keep in step for no new fact.
   *
   * IT SENDS NOTHING AND IT IS FULLY GATED. `evaluateEngagementSafety` is
   * `evaluateLinkedInSafety` with an engagement kind: every check, unfiltered,
   * no exception for "it is only a like". A refusal is a 409 carrying the
   * gate's own words, for the reason `enqueueReply` gives -- queueing it anyway
   * looks kinder and is not, because the operator then watches a row sit in a
   * queue that will never drain with no way to see why.
   * ------------------------------------------------------------------ */

  app.post('/api/linkedin/engagement', linkedinRoute(async (req, res) => {
    const input = linkedinEngagementSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();

    // Defensive and cheap: the schema already narrows it, and this is the
    // predicate `engagement.ts` itself uses, so the two cannot disagree.
    if (!isEngagementKind(input.kind)) {
      throw new LinkedInApiError(`'${input.kind}' is not an engagement action. The three are follow, like and endorse.`, 400);
    }

    // Exclusions are applied BEFORE the gate, never at send time: somebody who
    // asked to be left alone must not be in a payload a founder reads.
    const { kept } = await filterExcluded(db, workspaceId, [input.targetRef]);
    if (kept.length === 0) {
      throw new LinkedInApiError('That target is on the workspace exclusion list, so nothing will be scheduled against them.', 400);
    }

    const plannedFor = input.plannedFor ?? now.toISOString();
    const verdict = await evaluateEngagementSafety(
      db,
      { workspaceId, kind: input.kind, targetRef: input.targetRef, plannedFor },
      now
    );
    if (!verdict.allowed) {
      throw new LinkedInApiError(`This ${input.kind} was refused by the LinkedIn safety gate -- ${verdict.reason}`, 409);
    }

    const filed = await recordEngagement(
      db,
      {
        workspaceId,
        kind: input.kind,
        targetRef: input.targetRef,
        campaignId: input.campaignId ?? null,
        status: 'planned',
        plannedFor,
        source: 'manual',
        queuedByUserId: req.auth!.userId
      },
      now
    );
    if (filed.duplicate) {
      throw new LinkedInApiError(
        `This seat already has a ${input.kind} logged against '${input.targetRef}', so a second one was not queued. One target takes one action of one kind per seat.`,
        409
      );
    }

    res.status(201).json({ actionId: filed.id, kind: input.kind, targetRef: input.targetRef, plannedFor, verdict });
  }));

  /* =====================================================================
   * REDDIT (041)
   *
   * THE SAME ARRANGEMENT AS THE LINKEDIN SEAT ABOVE, AND FOR THE SAME
   * REASONS. A self-hoster hands Trevra their own Reddit sign-in, it is sealed
   * in `workspace_secrets`, and the browser on their own machine types it. The
   * password is write-only over the wire -- `putRedditCredentials` returns a
   * boolean and a handle, `describeRedditCredentials` cannot decrypt anything,
   * and there is no reveal route for anyone at any privilege level.
   *
   * HOSTED REFUSES, TWICE: here, so the answer is a 409 with one sentence
   * rather than a 500; and again unconditionally inside the store, so a caller
   * that skipped this check still stores nothing.
   *
   * WHAT THESE ROUTES DO AND DO NOT DO. They sign in, read a subreddit, and
   * post one comment the operator wrote in one thread the operator chose.
   * NOTHING HERE SUBMITS A POST -- `channels/adapters/reddit.ts` stays
   * `prepare-only` for submissions, because an unattended post into a
   * subreddit whose sidebar nobody read is a shadowban risk for the account
   * and the domain. And nothing here queues: there is no Reddit pacing engine
   * yet, so every write is one operator-initiated call.
   * ================================================================== */

  app.get('/api/reddit/account', redditRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    // A boolean and a public handle. There is no shape of this response that
    // carries the password, and no privilege level that changes that -- the
    // store has no function that could produce it here (secrets/reddit.ts).
    const credentials = await describeRedditCredentials(db, workspaceId);
    const account = await getRedditAccount(db, workspaceId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      account,
      auth: {
        hasCredentials: credentials.hasCredentials,
        username: credentials.username ?? (account?.username ? `u/${account.username}` : null),
        sessionValidAt: account?.sessionValidAt ?? null
      },
      // Answered WITHOUT opening a browser, so this route cannot hang.
      worker: redditWorkerStatus(redditConfigOrRefuse())
    });
  }));

  app.post('/api/reddit/credentials', redditRoute(async (req, res) => {
    const input = redditCredentialsSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;

    // The one unconditional gate, read from the one definition of it.
    if (redditConfigOrRefuse().hosted) throw new RedditApiError(REDDIT_CREDENTIALS_HOSTED_REFUSAL, 409);
    // A deployment with no key would seal nothing, and `sealSecret` would throw
    // a sentence about environment variables into a 500. Asked first instead.
    if (!secretsConfigured()) throw new RedditApiError(REDDIT_CREDENTIALS_UNSEALED_REFUSAL, 409);

    let summary;
    try {
      summary = await putRedditCredentials(db, {
        workspaceId,
        username: input.username,
        password: input.password,
        actorUserId: req.auth!.userId
      });
    } catch (error) {
      // The store's own refusals are operator-facing facts, not faults. Nothing
      // it throws contains the password.
      if (error instanceof Error && error.message === REDDIT_CREDENTIALS_HOSTED_REFUSAL) {
        throw new RedditApiError(error.message, 409);
      }
      throw error;
    }

    res.json(summary);
  }));

  /**
   * Give the password back to nobody.
   *
   * Wipes it. The stored browser session is deliberately NOT invalidated:
   * deleting a password does not sign a Chrome profile out, and pretending it
   * did would send an operator to re-authenticate something that still works.
   * Nothing can sign this account back in until a new pair is saved.
   */
  app.delete('/api/reddit/credentials', redditRoute(async (req, res) => {
    await deleteRedditCredentials(db, req.auth!.workspaceId, req.auth!.userId);
    res.json({ hasCredentials: false, username: null });
  }));

  /**
   * Make this workspace's Reddit session usable.
   *
   * REUSE FIRST, SIGN IN SECOND. A stored session that still works is kept: it
   * is faster and a far weaker automation signal than re-authenticating on
   * every run. The password is not even read on that path.
   *
   * FOUR ANSWERS, AND `otp_required` IS NOT ONE OF THE FAILURES:
   *
   *   ok            signed in, or already was.
   *   otp_required  Reddit wants the two-factor code. Ask the operator for it
   *                 and call this route again with `otp`.
   *   challenge     a captcha. Only a person at a window can finish it, and
   *                 the message says exactly that.
   *   failed        anything else, in one sentence.
   *
   * 200 for all four: none of them is an HTTP-level error, and a client that
   * has to distinguish "wrong password" from "needs a code" should read a field
   * rather than a status code.
   */
  app.post('/api/reddit/login', redditRoute(async (req, res) => {
    const input = redditLoginSchema.parse(req.body ?? {});
    const config = assertRedditWorkerOn();
    res.json(await loginRedditAccount(db, config, {
      workspaceId: req.auth!.workspaceId,
      otp: input.otp,
      now: new Date()
    }));
  }));

  /**
   * Read one subreddit through the signed-in session.
   *
   * READ-ONLY, so there is nothing to approve and nothing to pace: it is the
   * same GET the operator's own scroll makes. A 409 means the session is not
   * usable and the body names the one thing to do about it.
   */
  app.post('/api/reddit/research', redditRoute(async (req, res) => {
    const input = redditResearchSchema.parse(req.body ?? {});
    const config = assertRedditWorkerOn();
    const now = new Date();

    // Sequential rather than concurrent, and that is the safety property: one
    // browser, one page, and a burst of parallel listing reads from one account
    // is exactly the shape Reddit rate-limits.
    const reads = [];
    const refused = [];
    for (const subreddit of input.subreddits) {
      const result = await researchSubreddit(db, config, {
        workspaceId: req.auth!.workspaceId,
        subreddit,
        read: { sort: input.sort, limit: input.limit },
        now
      });
      if (result.ok) reads.push(result.read);
      // Named, never silently dropped: a subreddit that is private or
      // misspelled has to reach the operator, and an empty list would read as
      // "nobody is posting there".
      else refused.push({ subreddit, reason: result.blocked });
    }

    // Every subreddit refused for the same reason is a session problem, not a
    // set of community problems, so it answers as one 409 the operator can act
    // on rather than as a success carrying nothing.
    if (reads.length === 0) {
      throw new RedditApiError(refused[0]?.reason ?? 'Could not read anything from Reddit.', 409);
    }
    res.json({ reads, refused });
  }));

  /**
   * Post one comment, in one thread, right now.
   *
   * NO QUEUE AND NO APPROVAL STEP, because there is no Reddit pacing engine to
   * hand it to: the operator is the pacing engine, and they wrote the words.
   * When a queue arrives this route becomes the thing that files a row instead
   * of the thing that clicks.
   *
   * AN `unknown` OUTCOME IS RETURNED, NOT RETRIED. Once the button is pressed
   * the comment may exist; a retry posts it twice, and a duplicate comment
   * cannot be un-posted. The operator gets the sentence and checks the thread.
   */
  app.post('/api/reddit/comment', redditRoute(async (req, res) => {
    const input = redditCommentSchema.parse(req.body ?? {});
    const config = assertRedditWorkerOn();

    const outcome = await commentOnRedditThread(db, config, {
      workspaceId: req.auth!.workspaceId,
      threadUrl: input.url,
      body: input.body,
      now: new Date()
    });
    if (outcome.ok) {
      res.json({ posted: true, url: outcome.result.externalRef ?? input.url, detail: outcome.result.detail ?? null });
      return;
    }
    // 409 rather than 500 for every one of them: a locked thread, a rate limit
    // and a dead session are things to go and deal with, not faults.
    res.status(409).json({
      posted: false,
      failureKind: outcome.result?.failureKind ?? null,
      error: outcome.blocked
    });
  }));

  /* ---------------------------------------------------------------------
   * Accounts (039), the noun everything else was missing.
   *
   * FIVE ROUTES AND NO POLICY. The import parses, the sweep reads, the scorer
   * weighs; this layer authenticates, validates, and hands the workspace id
   * over. Every number these routes return was produced by `accounts/score.ts`
   * against signals that carry the URL they were read from -- so there is
   * nothing here that could invent one, which is the point.
   *
   * A REJECTION IS TWO WRITES, deliberately: the feedback row is evidence
   * about the SHAPE of the signals and outlives the account, and the status is
   * what takes the account out of the sweep. Neither is a delete -- 039 says
   * why: the next import would silently resurrect a company the operator has
   * already ruled out, and they would rule it out a second time.
   * ------------------------------------------------------------------ */

  app.get('/api/accounts', async (req: AuthedRequest, res, next) => {
    try {
      const filters = accountListSchema.parse(req.query);
      res.json({ accounts: await listRankedAccounts(db, req.auth!.workspaceId, filters) });
    } catch (error) { next(error); }
  });

  /**
   * Paste or drop a list. Door B of `docs/first-run.md` step 1.
   *
   * The imported rows are scored immediately rather than left for the sweep,
   * because a row with no score row at all is the screen's honest "the sweep
   * has not run yet" -- and that sentence must be about the SWEEP, not about
   * this request having skipped a step it could have taken.
   */
  app.post('/api/accounts/import', async (req: AuthedRequest, res, next) => {
    try {
      const input = accountImportSchema.parse(req.body ?? {});
      const workspaceId = req.auth!.workspaceId;
      const result = await importAccounts(db, workspaceId, input.text, { source: input.source, tags: input.tags });
      // ONE BULK RESCORE, not one per row: an import is up to 2,000 accounts,
      // and a round trip each would make the paste the slowest thing in the
      // product. The operator's own rejections go in with it, so a shape they
      // have already thrown out never scores its way onto the first screen
      // they see.
      const rejectedShapes = await rejectedSignalShapes(db, workspaceId);
      await rescoreAccounts(db, workspaceId, result.accounts.map((account) => account.id), { rejectedShapes });
      // 200 when a re-paste of the same list wrote nothing: nothing was
      // created, and saying 201 would make a no-op look like work.
      res.status(result.created > 0 ? 201 : 200).json(result);
    } catch (error) { next(error); }
  });

  app.post('/api/accounts/rescore', async (req: AuthedRequest, res, next) => {
    try {
      const workspaceId = req.auth!.workspaceId;
      const rejectedShapes = await rejectedSignalShapes(db, workspaceId);
      res.json({ rescored: await rescoreWorkspace(db, workspaceId, { rejectedShapes }) });
    } catch (error) { next(error); }
  });

  app.get('/api/accounts/:id', async (req: AuthedRequest, res, next) => {
    try {
      const detail = await accountDetail(db, req.auth!.workspaceId, String(req.params.id));
      if (!detail) return res.status(404).json({ error: 'Account not found' });
      res.json(detail);
    } catch (error) { next(error); }
  });

  app.post('/api/accounts/:id/feedback', async (req: AuthedRequest, res, next) => {
    try {
      const input = accountFeedbackSchema.parse(req.body ?? {});
      const workspaceId = req.auth!.workspaceId;
      const accountId = String(req.params.id);
      // Read first, so a bad id is a 404 rather than a feedback row filed
      // against a company this workspace cannot see.
      const account = await getAccount(db, workspaceId, accountId);
      if (!account) return res.status(404).json({ error: 'Account not found' });

      await recordAccountFeedback(db, workspaceId, accountId, input);
      // Only the rejection changes the status. 'good_fit' is training data
      // about the shape and nothing more -- an account already in the sweep
      // does not need to be put back into it.
      if (input.verdict === 'not_a_fit') await setAccountStatus(db, workspaceId, accountId, 'not_a_fit');

      const detail = await accountDetail(db, workspaceId, accountId);
      if (!detail) return res.status(404).json({ error: 'Account not found' });
      res.json(detail);
    } catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AgentBudgetError) return res.status(409).json({ error: error.message });
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

/**
 * Where the operator's key is allowed to go. Bounds only: the HTTPS and
 * public-host rules live in secrets/store.ts, which owns the policy and the
 * self-hoster escape hatch, so they are not restated (and not skewed) here.
 */
const agentConfigSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(200),
  label: z.string().trim().max(120).optional()
});

/** Matches the store's own input rejections, which are 400s rather than faults. */
const AGENT_CONFIG_INPUT_ERROR = /^(baseUrl |model is required)/;

/**
 * The pasted model key.
 *
 * Bounds only, deliberately: no format check, no `.regex()`, no `.refine()`.
 * A failed refinement is one more place the value could be echoed back, and
 * section 2 is absolute -- the key is never logged and never in an error
 * message. Zod's issues for these checks carry the constraint, never the input.
 */
const agentKeySchema = z.object({
  apiKey: z.string().trim().min(1).max(500),
  label: z.string().trim().max(120).optional()
});

/** The workspace's choice of subscription CLI and model -- docs/cli-agent-and-hosted.md. */
const agentCliConfigSchema = z.object({
  cli: z.enum(['claude', 'codex']),
  model: z.string().trim().min(1).max(200)
});

/**
 * The pasted subscription OAuth token.
 *
 * Same bounds-only discipline as `agentKeySchema`, for the same reason:
 * section 3 of docs/byok-and-hosted-agent.md applies to this table's second
 * kind exactly as it did to the first, and a `.regex()`/`.refine()` is one
 * more place the value could be echoed back in a validation error.
 */
const agentCliTokenSchema = z.object({
  token: z.string().trim().min(1).max(2000)
});

/** The risk disclaimer toggle. Both directions are always well-formed: accepting and revoking are equally valid requests. */
const agentCliRiskAcceptSchema = z.object({
  accepted: z.boolean()
});

/** Section 5: $10,000/month ceiling, so a typo cannot become a real bill. */
const AGENT_BUDGET_MAX_CENTS = 1_000_000;
const AGENT_BUDGET_CAP_MESSAGE = 'monthlyCapCents must be a whole number of cents between $0 and $10,000';

const agentBudgetSchema = z.object({
  monthlyCapCents: z.number().int(AGENT_BUDGET_CAP_MESSAGE).min(0, AGENT_BUDGET_CAP_MESSAGE).max(AGENT_BUDGET_MAX_CENTS, AGENT_BUDGET_CAP_MESSAGE).optional(),
  enabled: z.boolean().optional()
}).refine(
  (patch) => patch.monthlyCapCents !== undefined || patch.enabled !== undefined,
  { message: 'Provide monthlyCapCents, enabled, or both' }
);

const agentRunFiltersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

/** Long enough to be a real instruction, short enough not to be a document. */
const AGENT_GOAL_MAX_CHARS = 2000;

const agentRunStartSchema = z.object({
  goal: z.string().trim().min(1, 'goal is required').max(AGENT_GOAL_MAX_CHARS),
  // The loop owns the real ceiling (MAX_STEPS_CEILING) and clamps to it. This
  // bound only keeps nonsense out of the request; it is not the authority, and
  // restating 40 here would be one more number to drift.
  maxSteps: z.number().int().min(1).max(1000).optional()
});

/**
 * The stop request.
 *
 * Both fields optional, and an empty body is a valid stop -- the one moment
 * this route matters is the moment something else is already wrong, and a 400
 * for a missing note would be the product arguing with an operator who is
 * holding a kill switch. The length bound comes from the module that owns the
 * column, which truncates rather than rejects for the same reason.
 */
const agentRunStopSchema = z.object({
  runId: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().max(AGENT_STOP_REASON_MAX_CHARS).optional()
});

/**
 * What to put in a ledger export.
 *
 * `include` defaults to everything. Somebody asking for their ledger means
 * their ledger, and a default that quietly omitted the evidence would
 * under-deliver the exact sentence this route exists to earn.
 */
const ledgerExportSchema = z.object({
  window: z.coerce.number().int().min(1).max(LEDGER_EXPORT_MAX_WINDOW_DAYS).default(LEDGER_EXPORT_DEFAULT_WINDOW_DAYS),
  include: z.array(z.enum(LEDGER_EXPORT_SECTIONS)).min(1).default([...LEDGER_EXPORT_SECTIONS])
});

const loopCostFiltersSchema = z.object({
  window: z.coerce.number().int().min(1).max(LOOP_COST_MAX_WINDOW_DAYS).default(LOOP_COST_DEFAULT_WINDOW_DAYS)
});

/**
 * The schedule patch. The interval bounds come from schedule.ts, which rejects
 * the same values on its own -- imported rather than restated so the 400 and the
 * module can never disagree about what is allowed.
 */
const agentScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  goal: z.string().trim().min(1).max(AGENT_GOAL_MAX_CHARS).optional(),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES).optional()
}).refine(
  (patch) => patch.enabled !== undefined || patch.goal !== undefined || patch.intervalMinutes !== undefined,
  { message: 'Provide enabled, goal, intervalMinutes, or any combination' }
);

/** How long the request will wait for the run's ledger row to appear. */
const AGENT_RUN_ACCEPT_TIMEOUT_MS = 5_000;
const AGENT_RUN_ACCEPT_POLL_MS = 20;

/**
 * Start a hosted agent run and answer as soon as its ledger row exists.
 *
 * A run is up to twelve model calls and can take minutes, so the request must
 * not be held open for it -- that is a gateway timeout waiting to happen, and
 * the run would carry on regardless. `runHostedAgent` resolves only when the
 * whole loop is done and does not hand back the row it wrote on the way, so
 * this waits for that row to show up instead of for the run to finish.
 *
 * DETACHMENT, and the unhandled rejection: the handlers are attached in the
 * same tick the promise is created -- `.then(onFulfilled, onRejected)` below,
 * never a bare `void promise` -- so the detached run can never surface as an
 * unhandled rejection. In Node that is not a warning, it is process exit, and
 * one workspace's bad endpoint would take the API down for everybody.
 *
 * Failures that happen BEFORE the row exists (budget refused, BYOK missing) are
 * rethrown here, because the caller is still waiting and can be told -- 409 for
 * the budget, 500 otherwise. Everything after the response has gone out has
 * nowhere to go but the log, and the run itself is already recorded as 'failed'
 * in the ledger by the loop.
 */
async function acceptAgentRun(
  db: Db,
  input: { workspaceId: string; goal: string; maxSteps?: number },
  log: (error: unknown) => void
): Promise<AgentRunRecord> {
  type Settled = { failed: true; error: unknown } | { failed: false; run: AgentRunRecord };

  // Runs already on the ledger, so the one this call creates is identifiable
  // without reaching into the loop. Two identical goals started at the same
  // instant are indistinguishable here, and that is harmless: both requests get
  // a genuine running record for the goal they asked for.
  const before = new Set((await listAgentRuns(db, input.workspaceId, { limit: 20 })).map((run) => run.id));

  const settled: Promise<Settled> = runHostedAgent(db, { ...input, trigger: 'manual' }).then(
    (run) => ({ failed: false as const, run }),
    (error: unknown) => ({ failed: true as const, error })
  );

  const deadline = Date.now() + AGENT_RUN_ACCEPT_TIMEOUT_MS;
  for (;;) {
    const started = (await listAgentRuns(db, input.workspaceId, { limit: 20 }))
      .find((run) => !before.has(run.id) && run.goal === input.goal);
    if (started) {
      // The response is about to go out; from here the log is the only place a
      // later failure can be reported to a human watching the process.
      void settled.then((outcome) => { if (outcome.failed) log(outcome.error); });
      return started;
    }

    // Either the run settles -- it failed before writing a row, or it was fast
    // enough to finish first -- or the poll interval elapses and we look again.
    const raced = await Promise.race([settled, wait(AGENT_RUN_ACCEPT_POLL_MS)]);
    if (raced) {
      if (raced.failed) throw raced.error;
      return raced.run;
    }
    if (Date.now() >= deadline) throw new Error('Timed out starting the agent run');
  }
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => { setTimeout(() => resolve(null), ms); });
}

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

async function readSession(db: Db, req: Request): Promise<{ userId: string; workspaceId: string; email: string; role: 'owner' | 'member' } | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const session = await db.prepare(`
      SELECT s.user_id, u.workspace_id, u.email FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at > ?
    `).get(hash(token), new Date().toISOString()) as { user_id: string; workspace_id: string; email: string } | undefined;
    // Trevra's own hand-rolled session (demo mode only -- see /api/auth/demo).
    // It never goes through better-auth's organization plugin, so there is no
    // membership to check: the demo user is unconditionally the owner of the
    // one demo workspace this cookie always points at.
    if (session) return { userId: session.user_id, workspaceId: session.workspace_id, email: session.email, role: 'owner' };
  }
  const identity = await resolveBetterAuthIdentity(db, req.headers);
  if (!identity) return null;
  return resolveActiveWorkspace(req.headers, identity);
}

/**
 * Active-workspace resolution (design doc "Active-workspace resolution").
 * `resolveBetterAuthIdentity` only proves who the user IS and which workspace
 * they OWN (their "home" workspace, from `users.workspace_id`); it says
 * nothing about which workspace they are currently OPERATING IN, which can be
 * a workspace someone ELSE owns that added them as a member.
 *
 * Order:
 *  1. If the better-auth session has an `activeOrganizationId`, trust it ONLY
 *     if `getActiveMember` proves current membership -- this is what catches a
 *     stale session left over after an owner removes this user from that
 *     workspace: `getActiveMember` throws (caught below, null), and resolution
 *     falls through to the home-workspace branch.
 *  2. Otherwise (no active org, or the membership behind it was revoked), fall
 *     back to the user's own home workspace, and persist that choice via
 *     `setActiveOrganization` so the fallback sticks for the rest of the
 *     session instead of being re-derived on every request.
 *
 * Role comes from the SAME `getActiveMember` call that proves membership, so
 * it can never disagree with which workspace was actually resolved. A member
 * row that is missing entirely (should not happen for a home workspace, whose
 * owner-at-creation invariant this codebase maintains everywhere it creates
 * one) resolves to the least-privileged 'member' rather than throwing --
 * fail-closed, matching this codebase's existing authorization conventions.
 */
async function resolveActiveWorkspace(
  headers: Request['headers'],
  identity: { userId: string; email: string; homeWorkspaceId: string; activeOrganizationId: string | null }
): Promise<{ userId: string; workspaceId: string; email: string; role: 'owner' | 'member' }> {
  const authHeaders = fromNodeHeaders(headers);

  if (identity.activeOrganizationId) {
    const member = await betterAuth.api.getActiveMember({ headers: authHeaders }).catch(() => null);
    if (member) {
      return { userId: identity.userId, workspaceId: identity.activeOrganizationId, email: identity.email, role: member.role === 'owner' ? 'owner' : 'member' };
    }
  }

  await betterAuth.api.setActiveOrganization({ headers: authHeaders, body: { organizationId: identity.homeWorkspaceId } }).catch(() => undefined);
  const homeMember = await betterAuth.api.getActiveMember({ headers: authHeaders }).catch(() => null);
  return {
    userId: identity.userId,
    workspaceId: identity.homeWorkspaceId,
    email: identity.email,
    role: homeMember?.role === 'owner' ? 'owner' : 'member'
  };
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

/* ===========================================================================
 * LinkedIn: schemas, provenance, and the two things that must never throw.
 * ======================================================================== */

const LINKEDIN_PLAYBOOK_ID = 'gtm.linkedin-outreach';

/** Where every number below comes from. Quoted in each response, per the plan's honesty rule. */
const LINKEDIN_PLAN_DOC = 'docs/linkedin-outreach-plan.md';

/**
 * Wrap a LinkedIn handler.
 *
 * `LinkedInApiError` carries its own status and is answered here; everything
 * else -- ZodError, PlaybookError, a genuine fault -- falls through to the
 * shared error middleware, which already knows what each of those means. This
 * exists so the rule lives in one place rather than in nineteen catch blocks.
 */
function linkedinRoute(handler: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof LinkedInApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}

/**
 * The same wrapper for the Reddit routes, and a separate one on purpose.
 *
 * `RedditApiError` and `LinkedInApiError` are different types because they are
 * thrown by different subsystems, and a single wrapper that caught both would
 * quietly let a LinkedIn refusal answer a Reddit route -- with LinkedIn's
 * wording, on a screen about Reddit.
 */
function redditRoute(handler: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof RedditApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
}

/**
 * Reddit's own gate, and the 409 that names WHICH kind of off.
 *
 * Two different refusals wearing one status code: hosted is a decision the
 * deployment made and no environment variable can undo it, so the sentence
 * must not send an operator hunting for a switch; anything else has one, and
 * `redditOffReason` names it.
 *
 * The config is READ AND RETURNED rather than read twice: every caller needs
 * the same object immediately afterwards, and re-reading the environment
 * between the check and the use is how a gate ends up guarding a different
 * value than the one that gets used.
 */
function assertRedditWorkerOn(): RedditLocalWorkerConfig {
  const config = redditConfigOrRefuse();
  if (!config.enabled) throw new RedditApiError(redditOffReason(config), 409);
  return config;
}

/**
 * Read the Reddit slice of the environment, or refuse in one sentence.
 *
 * `redditWorkerConfig` parses with zod and THROWS on a malformed
 * TREVRA_DEPLOYMENT_MODE. Unwrapped, that is a 500 on the very screen an
 * operator opens to find out why nothing is working -- the same posture the
 * LinkedIn login route already takes, and the same reason: a server that
 * cannot read its own configuration is telling the operator something they can
 * act on, not failing.
 */
function redditConfigOrRefuse(): RedditLocalWorkerConfig {
  try {
    return redditWorkerConfig();
  } catch (error) {
    throw new RedditApiError(
      `This server could not read its own Reddit configuration: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`,
      409
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The payload a human approved for this campaign, or the 409 saying why there
 * is none.
 *
 * ONE COPY OF THIS CHECK, because two routes now act on an approval and both of
 * them must refuse the same things. `verb` is the only difference between them
 * and exists so each refusal names what the caller was actually trying to do --
 * an operator told "approve it before exporting" when they pressed Queue is
 * being sent to the wrong button.
 *
 * THE BYTES COME FROM THE APPROVED PAYLOAD, never from a fresh plan. The
 * approval bound `canonicalPayloadHash(payload)`, and re-planning here would
 * ship a different schedule under an unchanged approval -- exactly the drift
 * the playbook engine fails closed on.
 *
 * AND THE APPROVAL BINDS THE COPY IT WAS GRANTED FOR.
 * `PATCH /api/linkedin/campaigns/:id/sequence` stores an edited sequence on the
 * campaign and re-plans it behind a fresh approval. If the two ever disagree,
 * the payload on file describes copy that is no longer this campaign's, and
 * acting on it would ship the edited campaign's name over the old campaign's
 * words -- or worse, the reverse. Both sides go through the SAME schema before
 * hashing, so Zod's defaults cannot fake a difference.
 */
async function approvedCampaignPayload(
  db: Db,
  workspaceId: string,
  campaign: LinkedInCampaign,
  verb: 'export' | 'queue'
): Promise<LinkedInExportPayload> {
  const run = campaign.playbookRunId ? await getPlaybookRun(db, workspaceId, campaign.playbookRunId) : null;
  const approval = run?.steps.find((step) => step.stepType === 'approval');
  if (!approval?.input) {
    throw new LinkedInApiError(
      `This campaign has no approved plan yet. Approve its playbook run first; ${verb === 'export' ? 'an export is' : 'a queued campaign is'} the approved bytes, not a new plan.`,
      409
    );
  }
  const approved = linkedinExportPayloadSchema.parse(approval.input);

  const storedSequence: unknown = campaign.sequence;
  if (isJsonObject(storedSequence) && Array.isArray(storedSequence.steps)) {
    const parsedStored = linkedinSequencePayloadSchema.safeParse(storedSequence);
    if (!parsedStored.success || canonicalPayloadHash(parsedStored.data) !== canonicalPayloadHash(approved.sequence)) {
      throw new LinkedInApiError(
        `This campaign's sequence was edited after that plan was approved, so the approved bytes no longer describe it. Approve the re-planned campaign before ${verb === 'export' ? 'exporting' : 'queueing'} it.`,
        409
      );
    }
  }

  return approved;
}

/**
 * The local worker's configuration, or a 409 saying why there is none.
 *
 * The same posture the detect and login routes already take, lifted out because
 * five more routes now need it: a build this server cannot even validate is
 * reported as something to fix, never as a 500. The screen that answers "why is
 * nothing sending" must not be the screen that crashes.
 */
function linkedinWorkerConfigOrRefuse(): LinkedInLocalWorkerConfig {
  let config: LinkedInLocalWorkerConfig;
  try {
    config = validateEnvironment().linkedinLocalWorker;
  } catch (error) {
    throw new LinkedInApiError(
      `This server could not read its own configuration: ${error instanceof Error ? error.message : 'unknown error'}`,
      409
    );
  }
  if (!config.enabled) throw new LinkedInApiError(linkedInOffReason(config), 409);
  return config;
}

/**
 * Lead sourcing's own gate, and the 409 that names WHICH kind of off.
 *
 * Two different refusals wearing one status code: hosted is a decision the
 * deployment made and no environment variable can undo it, so the sentence must
 * not send an operator hunting for a switch; anything else has one, and the
 * sentence names it. `leadSourcingOffReason` holds both, and this is the only
 * place a route decides between them.
 */
function assertLeadSourcingOn(): void {
  const config = leadSourcingConfig();
  if (!leadSourcingEnabled(config)) throw new LinkedInApiError(leadSourcingOffReason(config), 409);
}

/**
 * The step-list rules, held to ONCE, by both writes that accept a sequence.
 *
 * `POST /api/linkedin/campaigns` (a campaign assembled from steps) and
 * `PATCH /api/linkedin/campaigns/:id/sequence` (an edit to one that exists) are
 * the two places a caller hands Trevra copy. They run the same validator and
 * answer its refusal the same way, because two copies of "days cannot go
 * backwards" is one copy that eventually disagrees with the other.
 *
 * Called BEFORE the playbook run on both paths: a bad step costs one 400, not
 * a run and a campaign left pointing at a failure.
 */
function validatedSequence(steps: readonly SequenceStepInput[]): LinkedInSequence {
  try {
    return sequenceFromSteps(steps);
  } catch (error) {
    if (error instanceof SequenceValidationError) throw new LinkedInApiError(error.message, 400);
    throw error;
  }
}

/**
 * The inputs a campaign can be re-planned from.
 *
 * Reads the copy on the campaign first (029), and falls back to the playbook
 * run that made it for campaigns created before that column existed. The
 * `targets` check is the test of usefulness rather than of shape: a payload
 * with no targets cannot be paced, so it is not an input, it is a husk.
 */
async function campaignPlaybookInput(
  db: Db,
  workspaceId: string,
  campaign: { id: string; playbookRunId: string | null }
): Promise<Record<string, unknown> | null> {
  const stored = await getCampaignBrief(db, workspaceId, campaign.id);
  if (isPlannableInput(stored)) return stored;
  if (!campaign.playbookRunId) return null;
  const run = await getPlaybookRun(db, workspaceId, campaign.playbookRunId);
  return isPlannableInput(run?.input) ? run.input : null;
}

function isPlannableInput(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const targets = value.targets;
  return Array.isArray(targets) && targets.length > 0;
}

/** seats.ts owns these rules; this only recognises its refusals as 400s, not faults. */
const LINKEDIN_SEAT_INPUT_ERROR = /(needs a label|needs an IANA timezone|is not an IANA timezone|must be a 'YYYY-MM-DD' date)/;

/**
 * The two vocabularies, read from the modules that own them.
 *
 * Hand-copied literal lists here were how `linkedinPacedKind` came to refuse
 * `follow` while `limits.ts` paced it. A schema that is derived cannot drift
 * from the table it is meant to validate against.
 */
const linkedinActionKind = z.enum(ACTION_KIND_VALUES);
const linkedinPacedKind = z.enum(PACED_KIND_VALUES);
const linkedinEngagementKind = z.enum(['follow', 'like', 'endorse']);
const linkedinActionStatus = z.enum(['planned', 'exported', 'sent', 'accepted', 'replied', 'declined', 'skipped']);
const linkedinExportFormat = z.enum(['dripify', 'heyreach', 'expandi', 'generic']);

/**
 * The seat patch.
 *
 * `posture` is absent on purpose. warmup-vs-steady is derived from account age
 * on every read, and the two postures an operator really owns have their own
 * routes -- a kill switch buried in a settings PUT is a kill switch nobody
 * finds. `strict()` so a UI that thinks it can send one gets told.
 */
const linkedinSeatSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  profileUrl: z.string().trim().max(500).nullable().optional(),
  accountOpenedOn: z.string().trim().max(20).nullable().optional(),
  connectionsCount: z.number().int().min(0).max(100_000).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional()
}).strict();

/**
 * The detect body, and it is one field.
 *
 * `strict()` and nothing optional: everything else on the seat is READ from
 * the session, so a client that tries to send a profile URL or a connection
 * count here is told rather than quietly believed. The timezone is the only
 * fact the server cannot derive for itself.
 */
const linkedinSeatDetectSchema = z.object({
  timezone: z.string().trim().min(1).max(100)
}).strict();

/**
 * The sign-in, and it goes ONE WAY.
 *
 * `.strict()` for the same reason as everywhere else here, and `max()` on both
 * because these are typed by a human, not generated. Note what Zod does on a
 * refusal: its issues carry a path and a code, never the offending value, so
 * even a rejected body cannot echo a password back through the shared error
 * middleware.
 */
const linkedinCredentialsSchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
  password: z.string().min(1).max(200)
}).strict();

/**
 * The verification code, and nothing else.
 *
 * Absent means "try the stored session, then the stored password". Present
 * means "you asked me for this code, here it is" -- the second half of an
 * `otp_required` answer.
 */
const linkedinSeatLoginSchema = z.object({
  otp: z.string().trim().min(4).max(12).optional()
}).strict();

/**
 * The Reddit sign-in, and it goes ONE WAY.
 *
 * `.strict()` for the same reason as everywhere else here, and `max()` on both
 * because these are typed by a human, not generated. Reddit's own rule for a
 * username is 3-20 characters of `[A-Za-z0-9_-]`; the regex is deliberately
 * permissive about a leading `u/` because that is how the handle is written
 * everywhere else on the site, and `normaliseHandle` strips it on the way in.
 *
 * Note what Zod does on a refusal: its issues carry a path and a code, never
 * the offending value, so even a rejected body cannot echo a password back
 * through the shared error middleware.
 */
const redditCredentialsSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^\/?(?:u\/|user\/)?[A-Za-z0-9_-]{3,20}$/, 'A Reddit username is 3-20 letters, digits, underscores or hyphens'),
  password: z.string().min(1).max(200)
}).strict();

/**
 * The two-factor code, and nothing else.
 *
 * Absent means "try the stored session, then the stored password". Present
 * means "you asked me for this code, here it is" -- the second half of an
 * `otp_required` answer.
 */
const redditLoginSchema = z.object({
  otp: z.string().trim().min(4).max(12).optional()
}).strict();

/**
 * What to read, and how much of it.
 *
 * The subreddit list is capped at five for the same reason the driver reads
 * them one at a time: each name is a page load from one signed-in account, and
 * a request that fans out to thirty is a request that gets the account
 * rate-limited. `driver.normaliseSubreddit` is the authority on the NAME --
 * this only bounds the shape so an oversized body never reaches a browser.
 */
const redditResearchSchema = z.object({
  subreddits: z.array(z.string().trim().min(2).max(64)).min(1).max(5),
  sort: z.enum(REDDIT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(REDDIT_MAX_READ_LIMIT).optional()
}).strict();

/**
 * One comment, in one thread.
 *
 * `url` is validated again in the driver against the allowed-host list, which
 * is the check that matters -- this one only keeps an obviously wrong body from
 * reaching a browser at all. 10,000 characters is Reddit's own comment ceiling.
 */
const redditCommentSchema = z.object({
  url: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000)
}).strict();

const linkedinPauseSchema = z.object({
  // Not decoration: "why is this stopped" three weeks later is the question
  // this column answers, so it is required rather than defaulted to ''.
  reason: z.string().trim().min(1).max(500)
}).strict();

const linkedinPlanSchema = z.object({
  seatKey: z.string().trim().min(1).max(64).optional(),
  kind: linkedinPacedKind,
  targets: z.array(z.string().trim().min(1).max(500)).min(1).max(500),
  horizonDays: z.number().int().min(1).max(MAX_HORIZON_DAYS).default(14)
}).strict();

const linkedinActionFiltersSchema = z.object({
  status: linkedinActionStatus.optional(),
  kind: linkedinActionKind.optional(),
  campaignId: z.string().trim().min(1).max(120).optional(),
  seatKey: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * Skip takes NOTHING, and `strict()` is the enforcement.
 *
 * There is no field here a caller could use to name a status, so a request
 * that tries to smuggle one -- {"status":"sent"} -- is refused as malformed
 * before it reaches the ledger. The API plans and approves; it never sends.
 */
const linkedinSkipSchema = z.object({}).strict();

/**
 * The one sanctioned way an HTTP request reports a send.
 *
 * `occurredAt` matters more than it looks: every rolling window reads
 * `recorded_at`, so an outcome reported on Friday for a send that happened on
 * Tuesday must charge Tuesday's budget. Defaulting it to now would inflate
 * today's count and deflate the day the seat actually acted -- which is the
 * exact arithmetic the day-over-day guard depends on.
 */
const linkedinOutcomeSchema = z.object({
  actionId: z.string().trim().min(1).max(120).optional(),
  kind: linkedinActionKind.optional(),
  targetRef: z.string().trim().min(1).max(500).optional(),
  seatKey: z.string().trim().min(1).max(64).optional(),
  outcome: z.enum(['sent', 'accepted', 'replied', 'declined']),
  occurredAt: z.string().datetime().optional()
}).strict().refine(
  (input) => Boolean(input.actionId) || (Boolean(input.kind) && Boolean(input.targetRef)),
  { message: 'Provide actionId, or both kind and targetRef, so the outcome has exactly one action to attach to' }
);

/**
 * A sequence as a caller supplies it: the whole ordered list, never a patch.
 *
 * IMPORTED, NOT RESTATED, and that is a correctness fix rather than tidying.
 * This used to be a hand-copied duplicate of `sequenceStepInputSchema` -- the
 * same five fields, declared twice. When branching added a sixth, the copy
 * here did not have it, so BOTH campaign routes silently stripped every
 * condition an operator wrote: `POST /api/linkedin/campaigns` and
 * `PATCH .../sequence` parsed the branch away before the validator or the
 * playbook ever saw it, and the campaign came back looking correct, because a
 * stripped branch is a valid unconditional step. There is now one definition,
 * in the module that owns the rules it encodes.
 */
const linkedinSequenceStepsSchema = sequenceStepsSchema;

/**
 * Starting a campaign.
 *
 * `input` is passed through to `gtm.linkedin-outreach`, which owns and
 * validates its own schema -- restating the ICP, offer and tone fields here
 * would be a second copy to drift. Two fields are named: `targets`, because
 * exclusions are applied before the run starts, and `sequenceSteps`, because
 * they are validated before it too.
 *
 * TWO WAYS IN. A brief (`icp` + `offer`) is something to draft copy FROM;
 * `sequenceSteps` is copy that already exists -- a template the operator
 * picked, or a sequence they assembled node by node. Exactly one of them per
 * request; the route refuses both and neither, in a sentence.
 */
const linkedinCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50).optional(),
  input: z.object({
    targets: z.array(z.string().trim().min(1).max(500)).min(1).max(500),
    sequenceSteps: linkedinSequenceStepsSchema.optional()
  }).passthrough()
}).strict();

/**
 * Drafting from a domain.
 *
 * `targets` is optional because a draft is written BEFORE anyone has a list --
 * that is the point of drafting from a domain rather than from a form. It is
 * accepted anyway so the critic sees the same campaign the operator has in
 * mind; nothing per-target ever reaches the copy.
 */
const linkedinDraftSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  targets: z.array(z.string().trim().min(1).max(500)).max(500).default([]),
  templateId: z.string().trim().min(1).max(64).optional()
}).strict();

/** Editing a sequence. Same list, same rules as the create route -- see `linkedinSequenceStepsSchema`. */
const linkedinSequenceEditSchema = z.object({
  steps: linkedinSequenceStepsSchema
}).strict();

const linkedinExportRequestSchema = z.object({
  /** Absent means the format the campaign was approved with. */
  format: linkedinExportFormat.optional()
}).strict();

/**
 * Queueing takes no options at all, and `.strict()` is the point of the schema.
 *
 * There is nothing to choose: what gets queued is what was approved. A body
 * carrying `format`, a slot list or an edited template is a caller trying to
 * decide something the approval already decided, and it is refused rather than
 * ignored.
 */
const linkedinQueueRequestSchema = z.object({}).strict();

const linkedinImportSchema = z.object({
  /** Which action the list is destined for. Only used to report who has already had one. */
  kind: linkedinActionKind.default('invite')
});

const linkedinExclusionSchema = z.object({
  targets: z.array(z.object({
    targetRef: z.string().trim().min(1).max(500),
    reason: z.string().trim().max(500).default('')
  })).min(1).max(1000),
  source: z.enum(['manual', 'import']).default('manual')
}).strict().transform((input) => ({
  targets: input.targets.map((target) => ({ ...target, source: input.source }))
}));

const linkedinAnalyticsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30)
});

/* ---------------------------------------------------------------------------
 * 030-034: lead sources, the inbox, withdrawal, engagement.
 * ------------------------------------------------------------------------ */

/**
 * A source to harvest. `strict()`, and the URL is validated by `leads.ts`.
 *
 * The URL is checked BEFORE the row exists rather than before the fetch, which
 * is `leads.ts`'s own rule and worth restating where the request arrives: a
 * stored `https://evil.example/x` is a row some later worker opens in an
 * AUTHENTICATED browser, and the fix for that is to never write it.
 */
const linkedinLeadSourceSchema = z.object({
  kind: z.enum(['search', 'post']),
  url: z.string().trim().min(1).max(1000)
}).strict();

const linkedinLeadListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * `z.coerce.boolean()` is NOT usable here: it is `Boolean(value)`, and
 * `Boolean('false') === true`. Every one of these arrives as a query STRING,
 * so a coerced `hasReply=false` asked for the opposite of what it said --
 * "threads that never replied" was unreachable, and silently answered with
 * "threads that did". Parse the two literals and reject anything else.
 */
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

const linkedinInboxFiltersSchema = z.object({
  unread: queryBoolean.optional(),
  hasReply: queryBoolean.optional(),
  campaignId: z.string().trim().min(1).max(120).optional(),
  seatKey: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * How much of the inbox to walk.
 *
 * BOUNDED AT THE REQUEST, and low. The driver caps a walk at 50 conversations
 * and 200 messages whatever this says, and every navigation waits out a seeded
 * 2-7s gap -- so a maximal walk is minutes of real time inside one HTTP
 * request. The defaults are the driver's own (10 conversations, 40 messages),
 * which is a refresh rather than a re-read of the whole inbox.
 */
const linkedinInboxSyncSchema = z.object({
  maxThreads: z.number().int().min(1).max(50).optional(),
  maxMessages: z.number().int().min(1).max(200).optional()
}).strict();

/**
 * One reply, and `plannedFor` is not decoration.
 *
 * The gate judges business hours and the weekend rule against the slot, so a
 * reply typed at 22:00 for tomorrow morning is a different question from one
 * to send now -- and answering both with "now" would refuse the first for a
 * reason that is not true of it.
 */
const linkedinReplySchema = z.object({
  body: z.string().min(1).max(8000),
  plannedFor: z.string().datetime().optional()
}).strict();

/** Both the candidate query and the enqueue body: the same two knobs, the same defaults. */
const linkedinWithdrawalCandidateSchema = z.object({
  olderThanDays: z.coerce.number().int().min(0).max(365).default(21),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const linkedinWithdrawalListSchema = z.object({
  status: z.enum(['queued', 'withdrawn', 'stale', 'failed', 'held']).optional(),
  seatKey: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

/**
 * One engagement action.
 *
 * `strict()` and no `status` field, for the same reason the skip body is empty:
 * there is nothing here a caller could use to claim something was performed.
 * The row is filed 'planned' and only the local worker may move it.
 */
const linkedinEngagementSchema = z.object({
  kind: linkedinEngagementKind,
  targetRef: z.string().trim().min(1).max(500),
  campaignId: z.string().trim().min(1).max(120).optional(),
  plannedFor: z.string().datetime().optional()
}).strict();

/* ---------------------------------------------------------------------------
 * Accounts (039).
 *
 * The list's ceilings are the ranked screen's, not the sweep's: 500 rows is a
 * whole imported list, and six signals is what one row can show before the
 * evidence stops being readable and becomes a wall.
 * ------------------------------------------------------------------------ */

const accountListSchema = z.object({
  tier: z.enum(['hot', 'warm', 'cold']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  signalLimit: z.coerce.number().int().min(1).max(50).default(6)
});

/**
 * One paste, or one dropped CSV read into a string.
 *
 * Capped exactly like the marketplace CSV import, for the same reason: the
 * JSON body limit is the only other thing standing between a paste and the
 * parser, and a request refused by a schema names what was wrong with it. The
 * ROW cap is the store's -- a ceiling on lines is a policy about lists, and
 * that policy belongs next to the parser that counts them.
 *
 * `source` is provenance and 039 keeps the first door that wrote a row, so it
 * is accepted rather than assumed -- but it defaults to 'csv', because a
 * request with a body of pasted text came through door B by definition.
 */
const accountImportSchema = z.object({
  text: z.string().min(1).max(5_000_000),
  source: z.enum(['csv', 'sourced', 'linkedin', 'manual']).default('csv'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([])
}).strict();

const accountFeedbackSchema = z.object({
  verdict: z.enum(['not_a_fit', 'good_fit']),
  reason: z.string().trim().max(500).optional()
}).strict();

/**
 * One account, its signals and its score -- the ranked row for a single id.
 *
 * `listRankedAccounts` answers this shape for a LIST and takes no id, so the
 * two single-account routes assemble it here from the two tables 039 defines.
 * Read-only, and the column names are the migration's own.
 *
 * lc-debt: app.ts maps account_signals and account_scores rows itself; upgrade
 * path is a `getRankedAccount(db, workspaceId, id)` in accounts/store.ts, at
 * which point this function and its two queries delete.
 */
async function accountDetail(db: Db, workspaceId: string, accountId: string): Promise<RankedAccount | null> {
  const account: Account | null = await getAccount(db, workspaceId, accountId);
  if (!account) return null;

  const signalRows = await db.prepare(`
    SELECT id, workspace_id, account_id, kind, detail, previous, current, evidence_url, observed_at, fingerprint, created_at
    FROM account_signals WHERE workspace_id=? AND account_id=? ORDER BY observed_at DESC LIMIT 50
  `).all(workspaceId, accountId) as Array<Record<string, unknown>>;

  const scoreRow = await db.prepare(`
    SELECT score, tier, distinct_kinds, newest_signal_at, rationale_json, computed_at
    FROM account_scores WHERE workspace_id=? AND account_id=?
  `).get(workspaceId, accountId) as Record<string, unknown> | undefined;

  const signals: AccountSignal[] = signalRows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    accountId: String(row.account_id),
    kind: String(row.kind),
    detail: String(row.detail),
    previous: row.previous === null || row.previous === undefined ? null : String(row.previous),
    current: row.current === null || row.current === undefined ? null : String(row.current),
    evidenceUrl: String(row.evidence_url),
    observedAt: String(row.observed_at),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at)
  }));

  // A score whose rationale will not parse is reported as NO score rather than
  // as an empty one: "why this score" with nothing under it is the one thing
  // this screen must never show.
  let score: AccountScore | null = null;
  if (scoreRow) {
    try {
      score = {
        workspaceId,
        accountId,
        score: Number(scoreRow.score),
        tier: String(scoreRow.tier) as AccountScore['tier'],
        distinctKinds: Number(scoreRow.distinct_kinds),
        newestSignalAt: scoreRow.newest_signal_at === null || scoreRow.newest_signal_at === undefined
          ? null
          : String(scoreRow.newest_signal_at),
        rationale: JSON.parse(String(scoreRow.rationale_json ?? '{}')) as AccountScore['rationale'],
        computedAt: String(scoreRow.computed_at)
      };
    } catch { score = null; }
  }

  return { account, signals, score };
}

/* ---------------------------------------------------------------------------
 * Effective ceilings, with provenance.
 * ------------------------------------------------------------------------ */

/**
 * HARD FACT -- published by LinkedIn or a contractual term. Exactly one number
 *              in the whole table qualifies: the InMail monthly quota.
 * REPORTED  -- practitioner telemetry. Directionally right, never a guarantee.
 *
 * The tag reaches the UI rather than stopping at limits.ts, which is the point
 * of the plan's honesty rule: an operator is betting their account on these
 * numbers and deserves to know which kind each one is.
 */
type LinkedInLimitConfidence = 'HARD FACT' | 'REPORTED';

interface LinkedInCeiling {
  kind: PacedKind;
  window: 'day' | 'week' | 'month';
  /** What actually applies right now, after every rule above has been applied. */
  ceiling: number;
  /** The band's own number, before warm-up and throttling. */
  bandCeiling: number;
  /** Actions of this kind already counted inside the window. */
  used: number;
  remaining: number;
  /** Which rule produced `ceiling`. Same vocabulary planPacing puts in `ceilingsApplied`. */
  boundBy: string;
  /** The same fact in a sentence a founder can read. */
  rule: string;
  confidence: LinkedInLimitConfidence;
  source: string;
}

const LINKEDIN_WINDOW_HOURS = { day: 24, week: 24 * 7, month: 24 * 30 } as const;

/**
 * Every effective ceiling for this workspace's seat, each carrying the rule
 * that bound it and that rule's confidence tag.
 *
 * Deliberately NOT flattened to bare numbers: "18 invites/day" and "18
 * invites/day because the seat is past its ramp, from practitioner telemetry
 * rather than from LinkedIn" are different claims, and only the second one is
 * true.
 */
async function effectiveLinkedInLimits(db: Db, workspaceId: string, now: Date) {
  const seat = await getSeat(db, workspaceId);
  const posture = seat ? effectivePosture(seat, now) : null;
  const warmupWeek = warmupWeekOf(seat?.activatedAt ?? null, now);
  const multiplier = warmupMultiplier(warmupWeek);
  // 'cooldown' and 'paused' both draw from the conservative band: backing off
  // means the warm-up numbers, not the steady ones.
  const band = posture === 'steady' ? 'steady' : 'warmup';
  const seatRef = seat ? { workspaceId, seatKey: seat.seatKey } : ownerSeat(workspaceId);

  const acceptance = await acceptanceRate(db, seatRef, ACCEPTANCE_WINDOW_DAYS, now);
  const throttled = acceptance.rate !== null && acceptance.rate < MIN_ACCEPTANCE_RATE;

  const limits: LinkedInCeiling[] = [];
  for (const kind of PACED_KINDS) {
    const bandLimits = bandFor(kind, band);
    const [usedDay, usedWeek, usedMonth] = await Promise.all([
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.day, now),
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.week, now),
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.month, now)
    ]);

    const afterWarmup = Math.floor(bandLimits.perDay * multiplier);
    // Halves, never zeroes -- a seat cut to zero can never produce the outcomes
    // that would clear the throttle, so "halve it" would become "end it".
    const afterThrottle = throttled
      ? Math.max(afterWarmup > 0 ? 1 : 0, Math.floor(afterWarmup * ACCEPTANCE_THROTTLE_FACTOR))
      : afterWarmup;

    let ceiling = afterThrottle;
    let boundBy = 'band-ceiling';
    let rule = `The ${band} band ceiling for ${kind}: ${bandLimits.perDay}/day.`;

    if (!seat) {
      ceiling = 0;
      boundBy = 'seat-unconfigured';
      rule = 'No LinkedIn seat is configured for this workspace, so nothing can be paced. An undeclared seat is treated as a week-1 account, never as an established one.';
    } else if (posture === 'paused') {
      ceiling = 0;
      boundBy = 'seat-paused';
      rule = `Seat '${seat.label}' is paused${seat.pausedReason ? `: ${seat.pausedReason}` : ''}. Nothing is scheduled while it is paused.`;
    } else if (throttled && afterThrottle < afterWarmup && acceptance.rate !== null) {
      boundBy = 'acceptance-rate';
      rule = `${ACCEPTANCE_WINDOW_DAYS}-day invite acceptance is ${(acceptance.rate * 100).toFixed(0)}% (${acceptance.accepted} of ${acceptance.decided} decided), below the ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}% floor, so volume is halved until it recovers.`;
    } else if (multiplier < 1) {
      boundBy = 'warmup-multiplier';
      rule = `Warm-up week ${warmupWeek} of ${WARMUP_WEEKS}: ${bandLimits.perDay} ${kind}/day x ${multiplier} = ${ceiling}/day.`;
    } else if (posture === 'cooldown') {
      boundBy = 'cooldown-band';
      rule = `Seat is in cooldown, so the conservative warm-up band applies: ${bandLimits.perDay} ${kind}/day.`;
    }

    limits.push({
      kind,
      window: 'day',
      ceiling,
      bandCeiling: bandLimits.perDay,
      used: usedDay,
      remaining: Math.max(0, ceiling - usedDay),
      boundBy,
      rule,
      confidence: 'REPORTED',
      source: `${LINKEDIN_PLAN_DOC} 1.4`
    });

    if (bandLimits.perWeek !== undefined) {
      limits.push({
        kind,
        window: 'week',
        ceiling: bandLimits.perWeek,
        bandCeiling: bandLimits.perWeek,
        used: usedWeek,
        remaining: Math.max(0, bandLimits.perWeek - usedWeek),
        boundBy: 'weekly-band',
        rule: `Rolling 7-day ceiling of ${bandLimits.perWeek} ${kind}(s) for a ${band} seat. Rolling, not calendar: a calendar cap of 20 delivers 40 across the boundary.`,
        confidence: 'REPORTED',
        source: `${LINKEDIN_PLAN_DOC} 1.4`
      });
    }

    if (bandLimits.perMonth !== undefined) {
      // The one HARD FACT in the table. LinkedIn resets InMail on a calendar
      // month; every window here is rolling, so 50-in-any-30-days is what is
      // enforced -- stricter everywhere except the 1st, which is the right
      // direction to be wrong in.
      const isQuota = kind === 'inmail';
      limits.push({
        kind,
        window: 'month',
        ceiling: bandLimits.perMonth,
        bandCeiling: bandLimits.perMonth,
        used: usedMonth,
        remaining: Math.max(0, bandLimits.perMonth - usedMonth),
        boundBy: 'monthly-quota',
        rule: isQuota
          ? `LinkedIn's published Sales Navigator quota: ${bandLimits.perMonth} InMails per seat per month. The 51st is refused by LinkedIn, not by Trevra.`
          : `Rolling 30-day ceiling of ${bandLimits.perMonth} ${kind}(s).`,
        confidence: isQuota ? 'HARD FACT' : 'REPORTED',
        source: isQuota ? `${LINKEDIN_PLAN_DOC} 1.1` : `${LINKEDIN_PLAN_DOC} 1.4`
      });
    }
  }

  return {
    seat: {
      configured: Boolean(seat),
      label: seat?.label ?? null,
      timezone: seat?.timezone ?? null,
      posture,
      pausedReason: seat?.pausedReason ?? null,
      warmupWeek,
      warmupWeeks: WARMUP_WEEKS,
      warmupMultiplier: multiplier,
      band
    },
    limits,
    /**
     * The rules that are not per-kind ceilings but decide what a plan looks
     * like anyway. A daily cap is NOT the defence -- 20/20/20/0/0/0/20 is more
     * dangerous than a flat 12/day and every day is under the cap.
     */
    signals: {
      acceptance: {
        windowDays: ACCEPTANCE_WINDOW_DAYS,
        decided: acceptance.decided,
        accepted: acceptance.accepted,
        rate: acceptance.rate,
        floor: MIN_ACCEPTANCE_RATE,
        throttleFactor: ACCEPTANCE_THROTTLE_FACTOR,
        throttled,
        rule: `Sustained invite acceptance below ${(MIN_ACCEPTANCE_RATE * 100).toFixed(0)}% over ${ACCEPTANCE_WINDOW_DAYS} days reads as spam and halves volume. The denominator is DECIDED invites, never sent ones: an unanswered invite is not a refusal.`,
        confidence: 'REPORTED' as LinkedInLimitConfidence,
        source: `${LINKEDIN_PLAN_DOC} 1.3`
      },
      dayOverDay: {
        maxDelta: MAX_DAY_OVER_DAY_DELTA,
        minRampStep: MIN_RAMP_STEP,
        rule: `No day may exceed the previous business day by more than ${(MAX_DAY_OVER_DAY_DELTA * 100).toFixed(0)}%. This is the rule that actually keeps a seat alive: the reported trigger is 50%, and riding the edge of a practitioner-reported threshold is not a margin.`,
        confidence: 'REPORTED' as LinkedInLimitConfidence,
        source: `${LINKEDIN_PLAN_DOC} 1.3`
      },
      rhythm: {
        businessHours: BUSINESS_HOURS,
        actionGapSeconds: ACTION_GAP_SECONDS,
        weekendFactor: WEEKEND_FACTOR,
        enforcementScanWeekdays: ENFORCEMENT_SCAN_WEEKDAYS,
        rule: `Actions spread across ${BUSINESS_HOURS.start}:00-${BUSINESS_HOURS.end}:00 in the seat's own timezone with randomised ${ACTION_GAP_SECONDS.min}-${ACTION_GAP_SECONDS.max}s gaps, never a block. Weekends are left empty, and Tuesdays and Wednesdays never carry a day's maximum because reported enforcement scans cluster there.`,
        confidence: 'REPORTED' as LinkedInLimitConfidence,
        source: `${LINKEDIN_PLAN_DOC} 1.3 and 1.4`
      }
    }
  };
}

/* ---------------------------------------------------------------------------
 * The target CSV.
 * ------------------------------------------------------------------------ */

/** The plan's own ceiling on one campaign. A longer file is truncated and says so. */
const LINKEDIN_IMPORT_MAX_ROWS = 500;

function linkedinCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LINKEDIN_TARGET_COLUMNS = ['targetref', 'target', 'handle', 'profileurl', 'profile', 'url', 'linkedin', 'linkedinurl'];
const LINKEDIN_PROFILE_COLUMNS = ['profileurl', 'profile', 'url', 'linkedin', 'linkedinurl'];
const LINKEDIN_FIRST_COLUMNS = ['firstname', 'first', 'givenname'];
const LINKEDIN_LAST_COLUMNS = ['lastname', 'last', 'surname', 'familyname'];
const LINKEDIN_COMPANY_COLUMNS = ['company', 'companyname', 'organisation', 'organization', 'employer'];
const LINKEDIN_ROLE_COLUMNS = ['role', 'title', 'jobtitle', 'position'];

function linkedinCsvField(row: Record<string, unknown>, columns: readonly string[]): string {
  for (const column of columns) {
    const value = row[column];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

interface LinkedInImportedContact {
  targetRef: string;
  profileUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string | null;
}

/**
 * Parse a target CSV.
 *
 * RFC4180 through `csv-parse`, not a `split(',')`: `Acme, Inc.` and
 * `The "Good" Company` are ordinary LinkedIn company names, and a naive split
 * shifts every column right of them -- silently, so the first sign of it is a
 * message addressed to the wrong person. `export.ts` hand-rolls the WRITER for
 * the same rules; this is the reader, and it is a dependency the project
 * already carries.
 */
function parseLinkedInTargetCsv(buffer: Buffer): {
  contacts: LinkedInImportedContact[];
  skipped: Array<{ row: number; reason: string }>;
} {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = parseCsv(buffer.toString('utf8'), {
      columns: (header: string[]) => header.map(linkedinCsvHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true
    }) as Array<Record<string, unknown>>;
  } catch (error) {
    throw new LinkedInApiError(
      `That file could not be read as CSV: ${error instanceof Error ? error.message : 'unparseable'}`,
      400
    );
  }

  const contacts: LinkedInImportedContact[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    // +2: one for the header line, one because humans count from 1.
    const line = index + 2;
    if (contacts.length >= LINKEDIN_IMPORT_MAX_ROWS) {
      skipped.push({ row: line, reason: `Over the ${LINKEDIN_IMPORT_MAX_ROWS}-target limit for one campaign; split the list.` });
      return;
    }
    const targetRef = linkedinCsvField(row, LINKEDIN_TARGET_COLUMNS);
    if (!targetRef) {
      skipped.push({ row: line, reason: 'No target column. Name one of: targetRef, handle, profileUrl, url.' });
      return;
    }
    const key = targetRef.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ row: line, reason: `Repeated target '${targetRef}'; one target gets one slot.` });
      return;
    }
    seen.add(key);

    const profileUrl = linkedinCsvField(row, LINKEDIN_PROFILE_COLUMNS) || (/^https?:\/\//i.test(targetRef) ? targetRef : '');
    contacts.push({
      targetRef,
      profileUrl: profileUrl || null,
      firstName: linkedinCsvField(row, LINKEDIN_FIRST_COLUMNS) || null,
      lastName: linkedinCsvField(row, LINKEDIN_LAST_COLUMNS) || null,
      company: linkedinCsvField(row, LINKEDIN_COMPANY_COLUMNS) || null,
      role: linkedinCsvField(row, LINKEDIN_ROLE_COLUMNS) || null
    });
  });

  return { contacts, skipped };
}

/* ---------------------------------------------------------------------------
 * Local worker status.
 * ------------------------------------------------------------------------ */

const linkedinModuleRequire = createRequire(import.meta.url);

/**
 * Can this instance drive a browser, and is it set up to?
 *
 * Every seat signs itself in with stored credentials, so this is judged on one
 * question: can a browser -- headed or headless -- open here at all. A headed
 * window is preferred when a display is available; headless is what a
 * container falls back to, and it needs nothing a headed window needs beyond
 * the chromium binary.
 *
 * NEVER THROWS, in any of the ways this can go wrong -- a missing playwright,
 * an unreadable seat, an environment this build cannot even validate. All come
 * back as an honest `false` plus the line that fixes them, because the screen
 * that answers "why is nothing sending" must not be the screen that 500s.
 *
 * `resolve`, not `import`: the question is whether playwright is INSTALLED, and
 * actually loading ~400MB of browser bindings to answer it would make a status
 * poll the most expensive request the API serves.
 */
async function linkedinWorkerStatus(db: Db, workspaceId: string) {
  // Fails closed: an environment this build cannot even validate is treated as
  // off and hosted, which is the pair that promises nothing.
  let workerConfig: LinkedInLocalWorkerConfig = { enabled: false, profileDir: null, hosted: true };
  let configError: string | null = null;
  try {
    workerConfig = validateEnvironment().linkedinLocalWorker;
  } catch (error) {
    configError = error instanceof Error ? error.message : 'Environment could not be validated';
  }
  const enabled = workerConfig.enabled;

  let seat: Awaited<ReturnType<typeof getSeat>>;
  try {
    seat = await getSeat(db, workspaceId);
  } catch {
    seat = undefined;
  }

  let playwrightInstalled = false;
  let playwrightPath: string | null = null;
  try {
    playwrightPath = linkedinModuleRequire.resolve('playwright');
    playwrightInstalled = true;
  } catch {
    playwrightInstalled = false;
  }

  // Non-launching by construction: this is a status poll, and a status poll
  // that opens Chrome hangs. Both verdicts are reported, always.
  const headed = linkedInBrowserReadiness(workerConfig);
  const headless = linkedInHeadlessReadiness(workerConfig);
  const browser = {
    canLaunchHeaded: headed.canLaunchHeaded,
    canLaunchHeadless: headless.canLaunchHeadless,
    reasons: headed.reasons,
    headlessReasons: headless.reasons
  };

  // ONE NEXT ACTION, and never a problem belonging to a display or a profile
  // directory: the seat signs itself in, so the binary is the only thing in
  // its way, and the chromium line only once playwright itself is there --
  // "install the browsers" is not the next action for somebody with no
  // playwright.
  const installPlaywright = 'Run `npm i playwright && npx playwright install chromium` on the machine that runs the worker.';
  const blockers: string[] = [];
  if (configError) blockers.push(`This server could not read its own configuration: ${configError}`);
  if (!enabled) {
    blockers.push(linkedInOffReason(workerConfig));
  } else if (!playwrightInstalled) {
    blockers.push(installPlaywright);
  } else if (!headless.canLaunchHeadless) {
    blockers.push(...headless.reasons);
  }
  const ready = enabled && playwrightInstalled && browser.canLaunchHeadless;

  return {
    enabled,
    playwrightInstalled,
    playwrightPath,
    /**
     * Whether the session is live. `session_valid_at` is written only when a
     * session was CONFIRMED live, so this is knowledge, not a guess.
     */
    loggedIn: Boolean(seat?.sessionValidAt),
    /** Both verdicts: which mode this process will actually launch in. */
    browser,
    /** Fail-closed: unknown is not ready. */
    ready,
    blockers,
    source: `${LINKEDIN_PLAN_DOC} 4.1, 4.3, 4.4 and 4.9`
  };
}
