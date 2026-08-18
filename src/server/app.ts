import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
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
import type { PlaybookStepStatus } from './playbooks/types.js';
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
  describeRedditCredentials,
  putRedditCredentials
} from './secrets/reddit.js';
import { getRedditAccount } from './reddit/account.js';
import { RedditApiError } from './reddit/errors.js';
import { REDDIT_SORTS, MAX_READ_LIMIT as REDDIT_MAX_READ_LIMIT } from './reddit/driver.js';
import {
  commentOnRedditThread,
  disconnectRedditWorkspace,
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
  effectiveDailyCeiling,
  seatOperatorLimit,
  warmupMultiplier,
  warmupMultiplierFor,
  type LinkedInBand,
  type PacedKind
} from './linkedin/limits.js';
import { ACTION_KIND_VALUES, ACTION_STATUS_VALUES, acceptanceRate, countActionsInWindow, hasTarget, ownerSeat, type LinkedInActionStatus } from './linkedin/actions.js';
import {
  OWNER_SEAT_KEY,
  deleteSeat,
  effectivePosture,
  getSeat,
  listSeats,
  pauseSeat,
  resumeSeat,
  upsertSeat,
  warmupWeekOf,
  type SeatPatch
} from './linkedin/seats.js';
import { SIDE_TASK_NAMES, availabilityCatchUpPending, nextSideTaskOpportunities, nextVisitOpportunities, sideTaskRuns, type SideTaskName } from './linkedin/side-tasks.js';
import { listSeatEvents, parseBackgroundRunDetail } from './linkedin/seat-events.js';
import { MAX_HORIZON_DAYS, planPacing } from './linkedin/pacing.js';
import {
  exportCampaign,
  linkedinExportPayloadSchema,
  linkedinSequencePayloadSchema,
  type LinkedInExportPayload
} from './linkedin/export.js';
import { queueCampaign } from './linkedin/queue.js';
import {
  HOSTED_EXECUTION_ACK_REQUIRED,
  HOSTED_EXECUTION_STATEMENT,
  HOSTED_EXECUTION_STATEMENT_VERSION,
  describeHostedExecutionAck,
  hostedExecutionGate,
  hostedExecutionMode,
  recordHostedExecutionAck,
  revokeHostedExecutionAck
} from './linkedin/hosted-execution.js';
import { companionReleasePackage } from './linkedin/companion-release.js';
import {
  companionWorkspaceReady,
  createCompanionPairing,
  exchangeCompanionPairing,
  listCompanionStatus,
  revokeCompanionDevice
} from './linkedin/companion.js';
import {
  detectLinkedInSeat,
  latestSeatDetectRequest,
  linkedInBrowserReadiness,
  linkedInHeadlessReadiness,
  linkedInOffReason,
  loginLinkedInSeat,
  requestSeatDetect,
  resolveSeatProxy,
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
  type LinkedInCampaign,
  type CampaignStatus
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
  dailyLeadAllowance,
  getLeadSource,
  leadSourcingConfig,
  leadSourcingEnabled,
  leadSourcingOffReason,
  listLeadSources,
  listLeads,
  setDailyLeadCap,
  LEAD_READ_LIMIT,
  LEAD_SOURCE_KINDS,
  MAX_DAILY_LEAD_CAP,
  type LeadSourceKind,
  type LinkedInQueueWaitReason
} from './linkedin/leads.js';
import {
  clearInboxForSeat,
  clearInboxForWorkspace,
  editQueuedMessage,
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
import { detectLinkedInAcceptances, syncLinkedInInbox, syncLinkedInPendingInvites, syncLinkedInThread } from './linkedin/jobs.js';
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
import { parseLeadCsv, scrubNameField, splitAndScrubName } from './linkedin/lead-import.js';
import {
  LEAD_CONTACT_READ_LIMIT,
  countLeadContacts,
  createLeadList,
  deleteLeadList,
  getLeadList,
  importLeadCsv,
  importLeadSourceContacts,
  listLeadContacts,
  listLeadLists,
  removeLeadContact,
  updateLeadContact,
  type LeadListSourceKind
} from './linkedin/lead-lists.js';
import { deleteWorkflow, getWorkflow, listWorkflows, saveWorkflow, workflowStepsSchema } from './linkedin/workflows.js';
import { runManagedCampaigns } from './linkedin/runner.js';
import {
  campaignWarmupFraction,
  completeManualTask,
  createManagedCampaign,
  getManagedCampaign,
  listCampaignMembers,
  listManagedCampaigns,
  listManualTasks,
  managedAnalytics,
  pauseManagedCampaign,
  releaseSeatWork,
  removeCampaignMember,
  setCampaignMemberPaused,
  startManagedCampaign,
  stopManagedCampaign
} from './linkedin/managed-campaigns.js';
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

/**
 * One tenant's minute, in requests.
 *
 * Deliberately generous against a BROWSER rather than tight against an
 * attacker: the dashboard fans out, several screens poll a run or a detect
 * while it is outstanding, and a ceiling that a legitimate afternoon can reach
 * is a ceiling somebody turns off. What it bounds is a workspace running away
 * with a shared deployment -- 20 requests a second, sustained, is not a person
 * at a keyboard. The per-IP bucket still sits underneath it for everything
 * that has no workspace to bill.
 */
const WORKSPACE_REQUESTS_PER_MINUTE = 1_200;
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
  const loopbackHttpProduction = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'false';
  app.use(helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production'
      ? {
          directives: {
            scriptSrc: ["'self'", (_req, res) => `'nonce-${String((res as unknown as Response).locals.cspNonce)}'`],
            // The single-operator production profile is deliberately loopback
            // HTTP. Upgrading relative assets there would point the browser at
            // a TLS endpoint that does not exist. Public production keeps the
            // default Helmet upgrade directive unchanged.
            ...(loopbackHttpProduction ? { upgradeInsecureRequests: null } : {})
          }
        }
      : false,
    // HSTS on an HTTP-only localhost origin teaches the browser to stop using
    // the only endpoint this deployment exposes. It remains enabled everywhere
    // production uses secure cookies (the public/HTTPS case).
    strictTransportSecurity: loopbackHttpProduction ? false : undefined
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
    // Password signup is intentionally self-hosted-only for now. Hosted users
    // prove email ownership through Google OAuth instead of creating an
    // immediately authenticated, unverified password identity.
    emailPasswordAuthEnabled: process.env.TREVRA_DEPLOYMENT_MODE !== 'hosted',
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

  /**
   * TWO BUCKETS, BECAUSE THERE ARE TWO THINGS TO BOUND.
   *
   * The one limiter that used to live here keyed everything on `req.ip`, and
   * with `trust proxy` set above that is the caller's real address rather than
   * the load balancer's -- which is the right key for an anonymous request and
   * the WRONG key for a hosted tenant. Two customers behind one corporate NAT,
   * or one mobile carrier, arrive from one address and share one bucket, so a
   * busy afternoon in one workspace 429s the other. On a self-hosted box that
   * is invisible; on a multi-tenant deployment it is one paying customer
   * spending another's quota, and neither of them can see why.
   *
   * So the key now follows the thing being protected:
   *
   *   unattributedLimiter  per IP, for requests with no workspace to bill --
   *                        sign-in, the demo route, agent-token traffic, and
   *                        anything presenting a session credential that turns
   *                        out not to be one.
   *   workspaceLimiter     per workspace, for every session-authenticated
   *                        route, mounted the moment `requireSession` has
   *                        resolved WHICH tenant is asking.
   *
   * EVERY REQUEST IS CHARGED TO EXACTLY ONE OF THEM, and that is what makes
   * the split safe. A request carrying a session cookie skips the IP bucket on
   * the way in -- otherwise the NAT'd tenant would still be capped by the
   * address it shares, and nothing would have been fixed -- and if that cookie
   * does not resolve, `requireSession` charges it to the IP bucket before
   * answering 401. A forged cookie therefore buys no exemption, which is the
   * hole a bare skip would have opened.
   */
  const unattributedLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
  const workspaceLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: WORKSPACE_REQUESTS_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    // Never the address: that is the key this limiter exists to stop using. An
    // unattributed request cannot reach here -- it is mounted after
    // `requireSession` -- and the fallback is one shared bucket rather than a
    // crash on the day that stops being true.
    keyGenerator: (request: Request) => (request as AuthedRequest).auth?.workspaceId ?? 'unattributed',
    message: { error: 'This workspace has made too many requests in the last minute. Try again shortly.' }
  });
  app.use('/api', (req, res, next) => (carriesSessionCredential(req) ? next() : unattributedLimiter(req, res, next)));

  // One-time pairing exchange. The short code is the only credential a user
  // ever pastes into a shell; it expires after ten minutes and is replaced here
  // with a long device token stored only on that computer.
  app.post('/api/linkedin/companion/exchange', async (req, res, next) => {
    try {
      const input = z.object({
        code: z.string().trim().min(8).max(32),
        label: z.string().trim().min(1).max(120)
      }).strict().parse(req.body ?? {});
      const paired = await exchangeCompanionPairing(db, input);
      res.status(201).json(paired);
    } catch (error) {
      if (error instanceof Error && /pairing code/i.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

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

  app.use('/api', requireSession(db, unattributedLimiter));
  // Mounted immediately after the session resolves, which is the first moment
  // there is a tenant to charge. Everything below this line is somebody's
  // workspace spending its own minute; nothing below it can spend anyone
  // else's.
  app.use('/api', workspaceLimiter);

  // ---------------------------------------------------------------------
  // LinkedIn companion: pair a member computer, keep a short website-presence
  // lease alive, and revoke a computer without ever exposing its bearer token.
  // ---------------------------------------------------------------------
  app.get('/api/linkedin/companion', async (req: AuthedRequest, res, next) => {
    try {
      res.json({
        ...(await listCompanionStatus(db, req.auth!.workspaceId)),
        // Pair/replace changes which physical machine is trusted for the whole
        // workspace, so that remains owner-only. Using or disconnecting the
        // already-paired machine is ordinary workspace operation and every
        // member may do it.
        canManage: req.auth!.role === 'owner',
        canUse: true,
        canDisconnect: true
      });
    } catch (error) { next(error); }
  });

  app.post('/api/linkedin/companion/pair', ownerOnly('pair a computer for LinkedIn'), async (req: AuthedRequest, res, next) => {
    try {
      const pairing = await createCompanionPairing(db, {
        workspaceId: req.auth!.workspaceId,
        actorUserId: req.auth!.userId
      });
      const base = (
        process.env.TREVRA_PUBLIC_API_URL?.trim()
        || process.env.BETTER_AUTH_URL?.trim()
        || process.env.APP_ORIGIN?.split(',')[0]?.trim()
        || ''
      ).replace(/\/$/, '');
      res.status(201).json({
        ...pairing,
        command: `npx --yes --package=${companionReleasePackage()} trevra linkedin install --pair ${pairing.code}${base ? ` --url ${base}` : ''}`
      });
    } catch (error) { next(error); }
  });

  app.delete('/api/linkedin/companion/devices/:id', async (req: AuthedRequest, res, next) => {
    try {
      const revoked = await revokeCompanionDevice(db, req.auth!.workspaceId, String(req.params.id));
      res.status(revoked ? 200 : 404).json({ revoked });
    } catch (error) { next(error); }
  });

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

  // Owner-only, and the `allow` effect is why. These rows are what the control
  // plane consults before an action runs, so a member who can write one can
  // write themselves a standing exemption over any `action_pattern` they
  // choose -- which is a privilege escalation wearing the shape of a settings
  // form. READING them stays open to everyone: knowing which rules bind you is
  // not a privilege, and a teammate who cannot see the policy cannot obey it.
  app.post('/api/policies', ownerOnly("change this workspace's policies"), async (req: AuthedRequest, res, next) => {
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

  // Same carve-out as the create route, and for the mirror-image reason:
  // deleting a `deny` policy is how you turn a refusal off.
  app.delete('/api/policies/:id', ownerOnly("change this workspace's policies"), async (req: AuthedRequest, res, next) => {
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

  // Owner-only: a publisher is this workspace's IDENTITY in a registry other
  // deployments install from, and it carries a signing key. Anything published
  // under it is published in the workspace's name, off this deployment, to
  // strangers -- there is no way to un-say that afterwards.
  app.post('/api/registry/publishers', ownerOnly('create a module publisher for this workspace'), async (req: AuthedRequest, res, next) => {
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

  // Owner-only for the same reason as the publisher above, one step closer to
  // the consequence: this is the act that puts signed bytes under the
  // workspace's name in front of everybody else's install route.
  app.post('/api/registry/modules/:id/releases', ownerOnly('publish a module release'), async (req: AuthedRequest, res, next) => {
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

  // Owner-only: an installed community module is third-party code this
  // workspace's runs will execute, chosen from a registry this deployment does
  // not control. "Which strangers' code runs against our data" is not a
  // per-teammate decision.
  app.post('/api/registry/modules/:id/install', ownerOnly('install a community module'), async (req: AuthedRequest, res, next) => {
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

  // The other half of the same decision. Uninstalling is not dangerous the way
  // installing is, but it silently breaks every playbook step that names the
  // module, so it belongs with the person who chose it.
  app.delete('/api/registry/modules/:id/install', ownerOnly('uninstall a community module'), async (req: AuthedRequest, res, next) => {
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

  /**
   * Rebuild THIS workspace's projections, and nobody else's.
   *
   * The call used to be `rebuildCommercialProjections(db)` -- no workspace,
   * because the function had no workspace to take. On a single-tenant box that
   * reads as a maintenance button. On a hosted one it was a route that any
   * member of any workspace could press to truncate
   * `commercial_entity_projections` for EVERY TENANT ON THE DEPLOYMENT and
   * then replay the whole event log to rebuild it -- one customer's button
   * blanking another customer's dashboard, and paying for the replay in shared
   * database load. The workspace argument is what makes the blast radius the
   * caller's own data; owner-only is what keeps it from being pressed casually.
   */
  app.post('/api/commercial-projections/rebuild', ownerOnly("rebuild this workspace's commercial projections"), async (req: AuthedRequest, res, next) => {
    try { res.status(202).json({ processed: await rebuildCommercialProjections(db, req.auth!.workspaceId) }); }
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

  // Owner-only. Revoking is the act that stops somebody's Claude Code or Codex
  // working mid-session, and it is not reversible -- a revoked token cannot be
  // un-revoked, only replaced by a new one whose secret the old holder does not
  // have. Creating one stays open: a teammate provisioning their own client is
  // ordinary use, and every token it mints is scoped to this workspace anyway.
  app.delete('/api/agent-tokens/:id', ownerOnly('revoke an agent token'), async (req: AuthedRequest, res, next) => {
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
          /**
           * WHETHER THIS DEPLOYMENT CAN STILL OPEN THE TOKEN, not merely
           * whether a row exists.
           *
           * `tokenStored` is a row count and it was the only thing this
           * payload said, so a deployment holding the WRONG server key -- a
           * restore onto a box with a different TREVRA_SECRETS_KEY, the usual
           * way this happens -- rendered a finished setup screen and then 500'd
           * at the first run, when `openSecret` failed on a ciphertext it could
           * not authenticate. `custody: 'unknown'` is exactly that deployment,
           * decided from metadata without decrypting anything, and it belongs
           * on the screen BEFORE somebody runs a schedule against it. `keyId`
           * rides along so an operator can tell which key they need to put
           * back. The model key's summary carries both already, because
           * `secret` above is the whole `WorkspaceSecretSummary`.
           */
          tokenCustody: cliToken?.custody ?? null,
          tokenKeyId: cliToken?.keyId ?? null,
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
  //
  // Owner-only as well as rate-limited. The key is the workspace's own billing
  // relationship with a model provider: whoever replaces it decides who gets
  // invoiced for every hosted run from that moment on, and the route is
  // write-only, so a member could swap in their own key and nobody could read
  // back what had been there before.
  app.put('/api/agent-setup/key', authLimiter, ownerOnly("store this workspace's model API key"), async (req: AuthedRequest, res, next) => {
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
  app.put('/api/agent-setup/cli-config', ownerOnly('choose which CLI agent this workspace runs'), async (req: AuthedRequest, res, next) => {
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
  //
  // AND OWNER-ONLY, which matters more here than on the BYOK key above. This
  // token plus the CLI config plus the risk acceptance are the three switches
  // that let a workspace steer a CHILD PROCESS on this server -- a real CLI,
  // with a real subscription, launched with an environment this workspace
  // chose. Each one is separately harmless and the set is not, so all three are
  // the owner's to throw (see the config and risk routes either side).
  app.put('/api/agent-setup/cli-token', authLimiter, ownerOnly("store this workspace's CLI subscription token"), async (req: AuthedRequest, res, next) => {
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
  // Owner-only, and this is the one of the three that most obviously must be:
  // it is a written acceptance of a named risk, and an acceptance is worth
  // exactly as much as the authority of whoever gave it. Revoking is owner-only
  // too, which costs nothing -- the safety-reducing direction is the one being
  // gated, and a member who wants it off can pause the schedule or the budget.
  app.put('/api/agent-setup/cli-risk-accept', ownerOnly('accept the CLI agent risk disclaimer'), async (req: AuthedRequest, res, next) => {
    try {
      const input = agentCliRiskAcceptSchema.parse(req.body ?? {});
      const config = await setWorkspaceCliRiskAccepted(db, req.auth!.workspaceId, input.accepted);
      if (!config && input.accepted) {
        return res.status(400).json({ error: 'Save your CLI and model first, then accept the risk.' });
      }
      res.json({ riskAccepted: config?.riskAcceptedAt != null });
    } catch (error) { next(error); }
  });

  // Owner-only: the budget is a spending limit on the workspace's own provider
  // key, so raising it spends somebody else's money and lowering it stops work
  // the owner scheduled. Reading it stays open -- a teammate has to be able to
  // see why a run stopped.
  app.put('/api/agent-setup/budget', ownerOnly('change the agent budget'), async (req: AuthedRequest, res, next) => {
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
  // Owner-only, for the reason the comment above already gives: this is the
  // second of the two switches that together spend the operator's key with
  // nobody in the room, and both of them are the owner's.
  app.put('/api/agent-setup/schedule', ownerOnly('change the unattended agent schedule'), async (req: AuthedRequest, res, next) => {
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
  //
  // Owner-only, and the paragraph above is the argument: the paragraph already
  // says this archive carries every client name, message body and outreach
  // target the workspace has recorded. Rendering one and LISTING them stay open
  // -- those are row counts and filenames, and a teammate assembling evidence
  // has to be able to do both -- but the bytes themselves leave the building,
  // and a file that has left cannot be un-downloaded when a membership ends.
  app.get('/api/ledger/exports/:id', ownerOnly('download a ledger export'), async (req: AuthedRequest, res, next) => {
    try {
      const stored = await readLedgerExport(db, req.auth!.workspaceId, String(req.params.id));
      if (!stored) return res.status(404).json({ error: 'Ledger export not found' });
      res.setHeader('Content-Type', stored.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${stored.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(stored.bytes);
    } catch (error) { next(error); }
  });

  /* =====================================================================
   * EXPORT AND ERASURE (public/privacy/index.html, "Retention and deletion":
   * "Workspace owners may request account export or deletion through the
   * support contact below").
   *
   * THE PROMISE WAS IN THE PRIVACY POLICY AND NOWHERE IN THE PRODUCT. Before
   * these routes there was no path -- no endpoint, no script, no admin tool --
   * that deleted a user, a workspace, a lead list, a campaign, a lead, a
   * thread, a message or an export. The only `DELETE FROM workspaces` in the
   * codebase was the demo reset. "Through the support contact" describes a
   * QUEUE, not an exemption: somebody still has to run something at the end of
   * it, and the something did not exist.
   *
   * THIS EXPORT IS NOT THE LEDGER EXPORT ABOVE, and the two are not merged.
   * `/api/ledger/exports` renders ten run-and-action tables: it is the evidence
   * pack a founder shows a client, and it deliberately excludes lead contacts,
   * lead lists, harvested leads, inbox threads and messages, campaigns, seats,
   * accounts, clients, audit events and settings. That is the right shape for
   * "prove what the agent did" and the wrong shape for "give me my data", and
   * a flag on the first would have made one archive answer two questions
   * badly.
   *
   * NEITHER ROUTE HOLDS A HAND-WRITTEN TABLE LIST -- see
   * `workspaceScopedTables`. A list is a thing that goes stale one migration
   * after somebody stops maintaining it, and a stale list here means an export
   * that silently omits a customer's data and an erasure that silently keeps
   * it.
   * ================================================================== */

  /**
   * Everything this workspace holds, as one file, rendered on demand.
   *
   * NOTHING IS STORED. The ledger export writes its bytes to a row because a
   * manifest publishes a sha256 per file and a re-render would serve different
   * bytes under a hash already handed out. That reasoning does not transfer:
   * this archive has no manifest, and a stored copy of EVERYTHING a workspace
   * holds is a second copy of everything a workspace holds -- sitting in the
   * same database, surviving the deletion of the rows it was made from, and
   * downloadable by whoever is owner next. Rendered, sent, forgotten.
   *
   * SEALED MATERIAL IS NAMED AND NOT INCLUDED. See
   * `WORKSPACE_EXPORT_SEALED_TABLES`: a data-subject export is the customer's
   * information, and their LinkedIn password is not information about them, it
   * is the key to an account. The manifest lists what was withheld, because
   * silence would read as "there was no sign-in stored".
   */
  app.get('/api/workspace/export', ownerOnly('export this workspace'), async (req: AuthedRequest, res, next) => {
    try {
      const workspaceId = req.auth!.workspaceId;
      const bundle = await exportWorkspaceData(db, workspaceId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trevra-workspace-${workspaceId}.json"`);
      // Same rule as both downloads above, and the sharpest instance of it: a
      // cache that outlives an erasure keeps handing back the workspace that
      // asked to be forgotten.
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify(bundle, null, 2));
    } catch (error) { next(error); }
  });

  /**
   * What erasure would remove, BEFORE anything is removed.
   *
   * A destructive route that cannot be previewed is a destructive route nobody
   * can consent to. This is a pure read: a per-table row count, the exact
   * phrase the DELETE will require, and the list of reasons it would refuse
   * right now. An owner who reads this and then calls DELETE has been told the
   * number of rows in every table it will touch.
   */
  app.get('/api/workspace/erasure', ownerOnly('erase this workspace'), async (req: AuthedRequest, res, next) => {
    try {
      const workspaceId = req.auth!.workspaceId;
      const workspace = await db.prepare('SELECT id,name FROM workspaces WHERE id=?').get<{ id: string; name: string }>(workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      const [inventory, inFlight] = await Promise.all([
        workspaceInventory(db, workspaceId),
        workspaceWorkInFlight(db, workspaceId)
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        workspace,
        /** The DELETE refuses anything else. Published so a client can label its own confirm box. */
        confirmationPhrase: workspace.name,
        // Empty tables are omitted from the list and counted in the total, so
        // the screen reads as a summary of what exists rather than as a census
        // of the schema.
        inventory: inventory.filter((entry) => entry.rows > 0),
        totalRows: inventory.reduce((sum, entry) => sum + entry.rows, 0),
        inFlight,
        erasable: inFlight.length === 0 && workspaceId !== DEMO_WORKSPACE_ID,
        reversible: false
      });
    } catch (error) { next(error); }
  });

  /**
   * Erase the workspace. Everything, at once, and never half of it.
   *
   * FOUR REFUSALS BEFORE A SINGLE ROW GOES, in this order, each answering a
   * different way this can be the wrong call:
   *
   *   403  the demo workspace, which is shared by everyone who ever clicks
   *        "try it" and is not one customer's to delete.
   *   404  a workspace that is not there, so a retry of a completed erasure
   *        reads as "already gone" rather than as a fault.
   *   400  the confirmation phrase does not match the workspace's own name.
   *        A boolean `confirm: true` is a checkbox a script ticks; typing the
   *        name is the smallest gesture that proves somebody read the screen.
   *   409  work is in flight. A claimed action, an open batch, a running
   *        agent run or a running campaign means another process is holding
   *        rows this would delete underneath it -- and a half-deleted
   *        workspace is worse than an un-deleted one, because nothing is left
   *        to describe what happened. The blockers come back named so the
   *        owner can go and stop each one.
   *
   * THE CASCADE IS THE DELETION. Seventy-two of the seventy-four foreign keys
   * pointing at `workspaces` are `ON DELETE CASCADE`, so one statement removes
   * clients, messages, invoices, campaigns, leads, threads, seats, exclusions,
   * exports, audit events, settings and the rest -- and does it atomically,
   * which is the property that makes "never half of it" true. The two that are
   * not cascades are `module_publishers` and `module_packages`, which are
   * `ON DELETE SET NULL` on purpose: a module already published to strangers
   * cannot be recalled from their deployments, so it survives de-attributed
   * rather than pretending to vanish.
   *
   * THE BETTER-AUTH ORGANIZATION GOES TOO. `workspaces.id` and
   * `organization.id` are the same value by construction (auth-service.ts), but
   * better-auth's tables have no foreign key into ours, so the cascade cannot
   * reach the organization, its members or its outstanding invitations.
   * Deleting the workspace and leaving those behind would leave live
   * invitations to a workspace that no longer exists.
   *
   * THE RECORD OF THE ERASURE OUTLIVES IT. `workspace_erasures` (migration 057)
   * has no foreign key to `workspaces` for exactly that reason: every audit
   * trail this product keeps is workspace-scoped and therefore cascades away
   * with the workspace, so the one question anybody asks afterwards -- was this
   * deletion actually performed, when, by whom, and how much went -- would have
   * had no answer anywhere. It stores counts and names, never contents.
   */
  app.delete('/api/workspace', ownerOnly('erase this workspace'), async (req: AuthedRequest, res, next) => {
    try {
      const input = workspaceErasureSchema.parse(req.body ?? {});
      const workspaceId = req.auth!.workspaceId;

      if (workspaceId === DEMO_WORKSPACE_ID) {
        return res.status(403).json({
          error: 'The demo workspace is shared by everyone trying Trevra and cannot be erased. POST /api/demo/reset restores it instead.'
        });
      }

      const workspace = await db.prepare('SELECT id,name FROM workspaces WHERE id=?').get<{ id: string; name: string }>(workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (input.confirm !== workspace.name) {
        return res.status(400).json({
          error: `Type the workspace name exactly -- "${workspace.name}" -- to confirm this erasure. Nothing was deleted.`
        });
      }

      const inFlight = await workspaceWorkInFlight(db, workspaceId);
      if (inFlight.length > 0) {
        return res.status(409).json({
          error: 'This workspace still has work in flight, so erasing it now would delete rows a running process is holding. Nothing was deleted.',
          inFlight
        });
      }

      // Counted BEFORE the delete, because after it there is nothing to count.
      // This is what the response reports and what the durable record stores.
      const inventory = await workspaceInventory(db, workspaceId);
      const removed = Object.fromEntries(inventory.filter((entry) => entry.rows > 0).map((entry) => [entry.table, entry.rows]));

      /*
       * TREVRA'S OWN ROWS GO FIRST, AND THE ORDER IS THE WHOLE POINT.
       *
       * These two steps are in two different databases and there is no
       * transaction across them, so one of the two orders has to be chosen for
       * what its FAILURE leaves behind. Deleting the organization first left
       * the unrecoverable one: a transient error on the transaction below
       * 500s with the workspace and all its data still in Postgres, but the
       * better-auth organization and every member's membership already gone --
       * and a retry cannot re-run `deleteOrganization` against an organization
       * that no longer exists, so nothing can finish the erasure.
       *
       * This way round, a failing transaction rolls back and deletes NOTHING:
       * the organization is untouched, the refusal is honest, and the whole
       * request is retryable. What can still be left over is an organization
       * whose workspace is gone -- reported as `organizationRemoved:false`
       * rather than swallowed, holds no tenant data, and is removable on its
       * own.
       */
      await db.transaction(async (tx) => {
        await tx.prepare(`
          INSERT INTO workspace_erasures (
            id,workspace_id,workspace_name,requested_by_user_id,requested_by_email,rows_removed_json,created_at
          ) VALUES (?,?,?,?,?,?::jsonb,?)
        `).run(
          id('erasure'),
          workspaceId,
          workspace.name,
          req.auth!.userId,
          req.auth!.email,
          JSON.stringify(removed),
          new Date().toISOString()
        );
        await tx.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      });

      let organizationRemoved = false;
      try {
        await betterAuth.api.deleteOrganization({
          headers: fromNodeHeaders(req.headers),
          body: { organizationId: workspaceId }
        });
        organizationRemoved = true;
      } catch (error) {
        // A demo-style session has no better-auth organization behind it at all,
        // and a workspace whose organization was already removed answers the
        // same way. Both are 4xx from better-auth and neither is a reason to
        // fail the erasure -- the workspace rows are already gone. Anything
        // that is NOT better-auth saying no is reported the same way rather
        // than rethrown: throwing here would answer a completed, irreversible
        // deletion with a 500, which reads as "nothing happened".
        if (!(error instanceof APIError)) {
          console.error(`Workspace ${workspaceId} was erased but its better-auth organization was not removed`, error);
        }
      }

      /**
       * AND THE CALLER IS SIGNED OUT EVERYWHERE, which is not cosmetic.
       *
       * `resolveBetterAuthIdentity` provisions a home workspace for any valid
       * better-auth session whose Trevra `users` row is missing -- that is what
       * makes first sign-in work. The erased owner's `users` row has just been
       * cascaded away while their better-auth session is still perfectly valid,
       * so their very next request would have PROVISIONED THEM A NEW WORKSPACE:
       * an erasure that quietly undoes itself one page load later. Revoking the
       * sessions is what makes the deletion stick.
       *
       * Only this user's own sessions. Other members were removed from the
       * organization above and fall back to their own home workspaces, which is
       * correct -- their accounts are not this workspace's to end.
       */
      await betterAuth.api.revokeSessions({ headers: fromNodeHeaders(req.headers) }).catch(() => undefined);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ erased: true, workspaceId, workspaceName: workspace.name, removed, organizationRemoved });
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
    // SCOPED ON THE WRITE, not only on the read above. The SELECT proved this
    // recommendation belongs to the caller's workspace and the UPDATE then
    // addressed it by id alone -- correct today because the id came from a
    // scoped row, and correct only by that accident. Two statements enforcing
    // one boundary between them is a boundary that breaks the first time
    // somebody reorders them, and `WHERE id=?` on a global table is the exact
    // shape of a cross-tenant write. The snooze route two blocks up already
    // scopes its UPDATE; this one now matches it.
    const dismissed = await db.prepare("UPDATE recommendations SET status='dismissed',updated_at=? WHERE id=? AND workspace_id=?")
      .run(new Date().toISOString(), recommendationId, req.auth!.workspaceId);
    if (dismissed.changes === 0) return res.status(404).json({ error: 'Recommendation not found' });
    // `recordOutcome` now takes the workspace explicitly and refuses a
    // recommendation that does not belong to it -- the id was already proved
    // to be this workspace's twice over here, but the function no longer
    // depends on every caller having done that.
    await recordOutcome(db, req.auth!.workspaceId, recommendationId, 'dismissed', 0, String(recommendation.currency), { reason: input.reason ?? null });
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
    // EVERY CHILD READ CARRIES THE WORKSPACE TOO, and not because the parent
    // read above is insufficient proof of ownership -- it is -- but because
    // nothing below the application enforces that a child's workspace matches
    // its parent's. There is not a single composite foreign key in this schema:
    // `messages.client_id` references `clients(id)` and `messages.workspace_id`
    // references `workspaces(id)`, and no constraint anywhere says the two must
    // agree. So a row written with a mismatched pair -- by an importer, a
    // backfill, a future writer that scopes one and not the other -- is a row
    // Postgres accepts and this route would have served to the wrong tenant
    // under a client id it had correctly scoped. `WHERE client_id=?` alone puts
    // the whole boundary on the caller having got a different query right.
    //
    // `recommendation_outcomes` has no `workspace_id` column at all, so it is
    // scoped through the recommendation it hangs off, which does.
    const messages = await db.prepare('SELECT id,direction,subject,body,occurred_at,source_record_id FROM messages WHERE client_id=? AND workspace_id=? ORDER BY occurred_at DESC').all(clientId, workspaceId);
    const invoices = await db.prepare('SELECT id,external_ref,amount,currency,status,issued_at,due_at,paid_at FROM invoices WHERE client_id=? AND workspace_id=? ORDER BY issued_at DESC').all(clientId, workspaceId);
    const projects = await db.prepare('SELECT id,name,status,total_value,currency FROM projects WHERE client_id=? AND workspace_id=? ORDER BY created_at DESC').all(clientId, workspaceId);
    const commitments = await db.prepare('SELECT * FROM commitments WHERE client_id=? AND workspace_id=? ORDER BY due_at').all(clientId, workspaceId);
    const contracts = await db.prepare('SELECT * FROM contracts WHERE client_id=? AND workspace_id=? ORDER BY created_at DESC').all(clientId, workspaceId);
    const outcomes = await db.prepare(`
      SELECT ro.* FROM recommendation_outcomes ro JOIN recommendations r ON r.id=ro.recommendation_id
      WHERE r.client_id=? AND r.workspace_id=? ORDER BY ro.created_at DESC
    `).all(clientId, workspaceId);
    res.json({ client, messages, invoices, projects, commitments, contracts, outcomes });
  });

  /**
   * Custom record ingestion.
   *
   * WHAT `INGEST_API_KEY` IS, AND WHAT IT IS NOT. It is ONE key for the whole
   * deployment, shared by every tenant on it, and on a hosted install that
   * means every customer either holds the same secret or none of them can use
   * this route at all. It is therefore NOT an authorisation: it cannot say
   * which workspace is asking, so it cannot be the thing that decides which
   * workspace a record lands in.
   *
   * WHAT ACTUALLY SCOPES THIS REQUEST is the session, which is why the route
   * sits below `requireSession` and writes to `req.auth!.workspaceId` rather
   * than to a workspace named in the body. A caller holding the deployment key
   * and no session gets a 401 from the middleware before reaching this line;
   * a caller holding a session and no key gets one here. The key is a
   * deployment-level feature switch -- "is custom ingestion turned on at all"
   * -- layered on top of per-tenant authentication, and it must never become
   * the only credential: the day this route is reached by a machine with no
   * browser session, the key has to become a per-workspace secret first,
   * because a shared one would let any holder write into any tenant.
   *
   * Compared in constant time for the same reason the registry admin token is:
   * a shared secret compared with `!==` leaks its prefix to anybody who can
   * time a few thousand requests.
   */
  app.post('/api/events', async (req: AuthedRequest, res) => {
    const ingestKey = req.header('x-trevra-ingest-key') ?? '';
    if (!process.env.INGEST_API_KEY || !secureTokenEqual(ingestKey, process.env.INGEST_API_KEY)) {
      return res.status(401).json({ error: 'Invalid ingest key' });
    }
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
   * approval. Every route below returns before anything reaches LinkedIn.
   *
   * WHAT REACHES LINKEDIN, AND FROM WHERE. Three answers now, and the third is
   * new (docs/hosted-execution.md):
   *
   *   1. the operator's own tool, from a file they downloaded;
   *   2. the self-hosted local worker (`npm run linkedin:worker`), driving the
   *      browser on their machine that they logged into by hand;
   *   3. the HOSTED RUNNER -- the same worker loop, in Trevra's own process,
   *      driving a remote browser over CDP -- for a workspace whose owner has
   *      recorded an explicit authorisation and whose seat has a proxy.
   *
   * The invariant survives all three because it was never "nothing sends": it
   * is "no ROUTE sends". A route enqueues a planned row and answers; a worker
   * loop claims it later, behind every safety gate. The comment that used to
   * sit here said the third case was impossible, which stopped being true the
   * day the runner shipped -- and a false comment in the file that enforces the
   * rule is worse than no comment at all.
   *
   * Structurally, not by convention: every status write below goes through
   * `writeActionStatus` in linkedin/campaigns.ts, which refuses a
   * sent/accepted/replied status unless the caller names itself
   * 'outcome-ingest'. Exactly one route does, and it is the one section 5
   * names for the job.
   * ================================================================== */

  app.get('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    const { seatKey } = linkedinSeatSelectorSchema.parse(req.query);
    const now = new Date();
    const seat = await getSeat(db, workspaceId, seatKey);
    const seatRef = seat ? { workspaceId, seatKey: seat.seatKey } : { workspaceId, seatKey };
    const counts = await Promise.all(PACED_KINDS.map((kind) => countActionsInWindow(db, seatRef, kind, 24, now)));
    const credentials = await describeLinkedInCredentials(db, workspaceId, seatKey);
    const waitingFor = await linkedinQueueWaitReason(db, workspaceId, seatKey, now);
    const detect = await latestSeatDetectRequest(db, workspaceId, seatKey);
    const workerIntervalMs = (() => {
      try { return validateEnvironment().automationIntervalMs; }
      catch { return 300_000; }
    })();

    const maintenance = seat
      ? await (async () => {
        const runs = await sideTaskRuns(db, workspaceId, seat.seatKey);
        return SIDE_TASK_NAMES.map((task) => {
          const [next] = nextSideTaskOpportunities(seat, runs, task, now, 1);
          return {
            task,
            nextRunAt: next?.startAt.toISOString() ?? null,
            nextRunWindowEndAt: next?.endAt.toISOString() ?? null,
            timezone: seat.timezone,
            waitingFor
          };
        });
      })()
      : [];
    const backgroundRun = seat ? await nextLinkedInBackgroundRun(db, workspaceId, seat.seatKey, now) : null;

    res.json({
      seat: seat ?? null,
      auth: {
        hasCredentials: credentials.hasCredentials,
        maskedEmail: credentials.maskedEmail,
        sessionValidAt: seat?.sessionValidAt ?? null
      },
      detectRequest: detect?.status === 'pending' ? {
        ...detect,
        nextAttemptAt: waitingFor === null ? (() => {
          const requested = Date.parse(detect.requestedAt);
          if (!Number.isFinite(requested)) return new Date(now.getTime() + workerIntervalMs).toISOString();
          const elapsed = Math.max(0, now.getTime() - requested);
          const cycles = Math.floor(elapsed / workerIntervalMs) + 1;
          return new Date(requested + cycles * workerIntervalMs).toISOString();
        })() : null,
        waitingFor
      } : detect,
      execution: { ready: waitingFor === null, waitingFor },
      backgroundRun: backgroundRun ? {
        startAt: backgroundRun.startAt.toISOString(),
        endAt: backgroundRun.endAt.toISOString(),
        timezone: backgroundRun.timezone,
        source: backgroundRun.source,
        waitingFor: backgroundRun.waitingFor
      } : null,
      maintenance,
      posture: seat ? effectivePosture(seat, now) : null,
      warmupWeek: warmupWeekOf(seat?.activatedAt ?? null, now),
      warmupWeeks: WARMUP_WEEKS,
      today: Object.fromEntries(PACED_KINDS.map((kind, index) => [kind, counts[index]]))
    });
  }));

  app.get('/api/linkedin/activity', linkedinRoute(async (req, res) => {
    const workspaceId = req.auth!.workspaceId;
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    const now = new Date();
    const seats = await listSeats(db, workspaceId);
    const labels = new Map(seats.map((seat) => [seat.seatKey, seat.label] as const));
    const schedules = (await Promise.all(seats.map((seat) => nextLinkedInBackgroundRun(db, workspaceId, seat.seatKey, now))))
      .filter((run): run is LinkedInBackgroundScheduleView => run !== null)
      .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
    const nextRun = schedules.find((run) => run.waitingFor === null) ?? schedules[0] ?? null;

    const batches = await db.prepare(`
      SELECT id,seat_key,status,executed_count,halt_reason,started_at,finished_at
      FROM linkedin_batches
      WHERE workspace_id=?
      ORDER BY started_at DESC
      LIMIT ?
    `).all<Record<string, unknown>>(workspaceId, limit);

    const events = await listSeatEvents(db, workspaceId, { limit: Math.min(500, limit * 4) });
    const maintenanceRuns = events.flatMap((event) => {
      if (event.kind !== 'background_run') return [];
      const detail = parseBackgroundRunDetail(event.detail);
      if (!detail) return [];
      return [{
        id: event.id,
        kind: 'maintenance' as const,
        seatKey: event.seatKey,
        seatLabel: labels.get(event.seatKey) ?? event.seatKey,
        startedAt: detail.startedAt,
        finishedAt: detail.finishedAt,
        status: detail.status,
        tasks: detail.tasks,
        executedCount: 0,
        reason: detail.reason
      }];
    });
    const actionRuns = batches.map((row) => ({
      id: String(row.id),
      kind: 'actions' as const,
      seatKey: String(row.seat_key),
      seatLabel: labels.get(String(row.seat_key)) ?? String(row.seat_key),
      startedAt: new Date(String(row.started_at)).toISOString(),
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
      status: String(row.status),
      tasks: [] as string[],
      executedCount: Number(row.executed_count ?? 0),
      reason: row.halt_reason === null || row.halt_reason === undefined ? null : String(row.halt_reason)
    }));
    const runs = [...maintenanceRuns, ...actionRuns]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, limit);

    res.json({
      nextRun: nextRun ? {
        startAt: nextRun.startAt.toISOString(),
        endAt: nextRun.endAt.toISOString(),
        timezone: nextRun.timezone,
        seatKey: nextRun.seatKey,
        seatLabel: nextRun.seatLabel,
        source: nextRun.source,
        waitingFor: nextRun.waitingFor
      } : null,
      runs
    });
  }));

  // Posture is deliberately NOT writable here. warmup-vs-steady is derived from
  // the account's age on every read, and the two postures an operator really
  // owns -- paused and cooldown -- have their own routes below, because a kill
  // switch buried in a settings PUT is a kill switch nobody finds.
  //
  // Owner-only. The fields this PUT writes are the seat's four daily ceilings
  // and its working hours -- the numbers the pacing engine schedules against --
  // so a member could raise the invite ceiling to 75 a day and the plan would
  // pace to it. The band override in the same payload is stronger still: it
  // decides whether the researched safety band or the operator's own number
  // binds. That is an account-risk decision, and the account belongs to the
  // owner.
  app.put('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, "change a LinkedIn account's limits");
    const { seatKey = OWNER_SEAT_KEY, ...input } = linkedinSeatSchema.parse(req.body ?? {});
    assertSeatProxyUsable(req.auth!.workspaceId, seatKey, input.proxyUrl);
    const now = new Date();
    let seat;
    try {
      seat = await upsertSeat(db, req.auth!.workspaceId, input as SeatPatch, now, seatKey);
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
  //
  // DELIBERATELY NOT OWNER-ONLY, and it is the only seat route on this surface
  // that is not. The audit that gated its siblings asked for this one too, and
  // gating it would mean that the person who notices an account misbehaving at
  // 2am cannot stop it unless they happen to be the owner. A pause is entirely
  // reversible, reduces risk in every direction, and CANNOT be used to smuggle
  // sending back on: `POST /api/linkedin/seat/resume` is owner-only, so a
  // member cannot undo their own pause either. The worst a member can do here
  // is stop their own workspace's outreach and have to ask the owner to start
  // it again -- which is a smaller failure than the alternative by a wide
  // margin. Same reasoning, same shape, at
  // `POST /api/linkedin/manager/campaigns/:id/pause`.
  app.post('/api/linkedin/seat/pause', linkedinRoute(async (req, res) => {
    const input = linkedinPauseSchema.parse(req.body ?? {});
    const seat = await pauseSeat(db, req.auth!.workspaceId, input.reason, new Date(), input.seatKey);
    if (!seat) throw new LinkedInApiError('That LinkedIn account is not configured for this workspace', 404);
    res.json({ seat, posture: 'paused' });
  }));

  /**
   * Resume, and RECORD WHY IT WAS RESUMED AND BY WHOM.
   *
   * `reason` is OPTIONAL, unlike the pause route's, and the asymmetry is the
   * point: a pause with no reason leaves an account stopped for a cause nobody
   * can reconstruct, while a resume with no reason is an ordinary
   * "it is fine now" that must not be blocked behind a text box.
   *
   * IT DOES NOT LIVE ON THE SEAT, and it must not. `paused_reason` is the
   * CURRENT state of a stopped account and is cleared the moment it starts
   * again (seats.ts) -- storing a resume reason there would put a sentence
   * about starting into the field the UI reads to explain a stop. What is
   * wanted is history, so it goes where this workspace's history already is:
   * one `audit_events` row carrying the reason, the actor who gave it, and the
   * pause it answers, which is the pairing that makes either half readable a
   * month later.
   */
  app.post('/api/linkedin/seat/resume', linkedinRoute(async (req, res) => {
    // Owner-only, and this is the asymmetry that makes the open pause route
    // above safe: stopping is a member's to do, starting again is not. An
    // account was paused because somebody thought something was wrong, and
    // deciding it is fine now is the decision the audit row below records
    // against a name.
    assertWorkspaceOwner(req, 'resume a paused LinkedIn account');
    const { seatKey, reason } = linkedinResumeSchema.parse({ ...(req.body ?? {}), ...req.query });
    const workspaceId = req.auth!.workspaceId;
    const now = new Date();
    // Read BEFORE the resume clears it: the pause this resume answers is half
    // of what makes the record worth keeping.
    const paused = await getSeat(db, workspaceId, seatKey);
    const seat = await resumeSeat(db, workspaceId, now, seatKey);
    if (!seat) throw new LinkedInApiError('That LinkedIn account is not configured for this workspace', 404);
    const resumeReason = reason ?? null;
    await db.prepare(`
      INSERT INTO audit_events (
        id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      id('audit'),
      workspaceId,
      'user',
      req.auth!.userId,
      'linkedin.seat_resumed',
      'linkedin_seat',
      seat.seatKey,
      JSON.stringify({ reason: resumeReason, pausedReason: paused?.pausedReason ?? null, previousPosture: paused?.posture ?? null }),
      now.toISOString()
    );
    // Stored 'warmup', but resuming a two-year-old account does not put it back
    // through the ramp -- the effective posture is re-derived from its age.
    res.json({ seat, posture: effectivePosture(seat, now), resumeReason });
  }));

  /**
   * Forget this seat, including its ramp clock -- and the inbox read cache
   * that seat produced.
   *
   * `deleteSeat` itself never touches the send ledger, the detect-request
   * history or stored credentials -- only the seat row -- but that row is
   * the one thing that says WHICH LinkedIn account `linkedin_threads` and
   * `linkedin_messages` belong to (seats.ts: one seat per workspace, so
   * nothing in that schema is scoped to which account produced it). Deleting
   * the seat without also clearing them would leave a stranger's DMs on
   * screen under whatever seat this workspace declares next -- the same
   * failure mode `detectLinkedInSeat`'s own account-change branch in
   * `local-worker.ts` clears on an automatic re-detect, reached here too
   * because an operator can start over by hand instead of waiting for one.
   *
   * `linkedin_actions` -- the send ledger -- is still never touched, for the
   * same reason it survives every other reset here: it is history, not this
   * account's current view.
   *
   * The client is expected to confirm before calling this.
   *
   * AND IT NOW ACTUALLY DISCONNECTS. `deleteSeat` removes one row. Everything
   * else the seat produced -- its sealed credentials, its planned and held
   * actions, its pending manual tasks, its open batches -- used to survive the
   * disconnect, so "remove this account" left the password on disk and left
   * rows in the queue that a worker would still try to claim against an account
   * this workspace had said goodbye to. `releaseSeatWork` is that cleanup, and
   * it runs FIRST: a failure part-way through leaves the seat row present and
   * the disconnect visibly unfinished, which is recoverable, rather than
   * deleting the seat and orphaning the work, which is not.
   *
   * Owner-only. This is a delete with a blast radius, and the audit that asked
   * for the check was right that it is the sharpest one on this surface.
   */
  app.delete('/api/linkedin/seat', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'disconnect a LinkedIn account');
    const { seatKey } = linkedinSeatSelectorSchema.parse(req.query);
    const workspaceId = req.auth!.workspaceId;
    // The queue first: planned and held rows to 'skipped', pending manual tasks
    // to 'cancelled', and a count of anything a worker had already CLAIMED --
    // which this deliberately leaves alone, because a row a browser is acting
    // on is not this route's to rewrite. `actionsInFlight` is how the response
    // says so instead of rounding it to zero.
    const released = await releaseSeatWork(db, workspaceId, seatKey, new Date());
    // And the sign-in, which `deleteSeat` never touched: a disconnect that
    // leaves a sealed password behind is a disconnect that can sign itself back
    // in the moment somebody re-adds the seat.
    await deleteLinkedInCredentials(db, workspaceId, req.auth!.userId, seatKey);
    // Scoped to the account being forgotten. Clearing the whole workspace's
    // cache would empty a SECOND account's inbox as a side effect of
    // disconnecting the first, which is the one thing multi-account made
    // possible to get wrong here.
    const clearedThreads = await clearInboxForSeat(db, workspaceId, seatKey);
    const deleted = await deleteSeat(db, workspaceId, seatKey);
    res.json({
      deleted,
      clearedThreads,
      released,
      /**
       * WHETHER THE DISCONNECT ACTUALLY STOPPED EVERYTHING, as a fact rather
       * than as an inference the client has to draw from a count.
       *
       * Rows a worker had already CLAIMED cannot be pulled back -- a browser is
       * mid-action on them, and rewriting the row would not close the tab. So a
       * non-zero `released.actionsInFlight` means this seat is disconnected and
       * still sending, for up to one more batch. A response that reported that
       * as a clean disconnect would be the same lie the Reddit route used to
       * tell, and the screen has to be able to say "3 actions were already in
       * flight and will finish" rather than "done".
       */
      fullyStopped: released.actionsInFlight === 0
    });
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
    const seatKey = input.seatKey;

    // Credential-management carve-out (design doc "Decisions made during
    // brainstorming" #2): full workspace parity for any member, EXCEPT this.
    // Only the workspace owner may replace the stored LinkedIn sign-in.
    if (req.auth!.role !== 'owner') {
      throw new LinkedInApiError('Only the workspace owner can manage the stored LinkedIn credentials', 403);
    }

    // THE HOSTED GATE, READ FROM THE ONE DEFINITION OF IT -- and it is no
    // longer unconditional, which is the whole of what hosted execution
    // changed here. A hosted deployment refuses exactly as it always did, with
    // the same sentence, UNLESS it has a remote browser to act with AND this
    // workspace's owner has recorded an authorisation to act on their behalf.
    // Both halves are checked inside `putLinkedInCredentials` too, structurally
    // and unconditionally, so a caller that skipped this still stores nothing;
    // asking here is what turns the refusal into a 409 with one sentence rather
    // than a 500.
    const hostedCustody = await hostedExecutionGate(db, workspaceId);
    if (!hostedCustody.allowed) throw new LinkedInApiError(hostedCustody.reason, 409);
    // A deployment with no key would seal nothing, and `sealSecret` would throw
    // a sentence about environment variables into a 500. Asked first instead.
    if (!secretsConfigured()) throw new LinkedInApiError(LINKEDIN_CREDENTIALS_UNSEALED_REFUSAL, 409);

    let summary;
    try {
      summary = await putLinkedInCredentials(db, {
        workspaceId,
        seatKey,
        email: input.email,
        password: input.password,
        actorUserId: req.auth!.userId
      });
    } catch (error) {
      // The store's own refusals are operator-facing facts, not faults. Nothing
      // it throws contains either value.
      if (
        error instanceof Error
        && (error.message === LINKEDIN_CREDENTIALS_HOSTED_REFUSAL || error.message === HOSTED_EXECUTION_ACK_REQUIRED)
      ) {
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
    const { seatKey } = linkedinSeatSelectorSchema.parse(req.query);
    await deleteLinkedInCredentials(db, workspaceId, req.auth!.userId, seatKey);
    res.json({ hasCredentials: false, maskedEmail: null });
  }));

  /* ---------------------------------------------------------------------
   * Hosted execution: the authorisation, and only the authorisation.
   *
   * WHAT THESE THREE ROUTES DO AND DO NOT DO. They record, read and withdraw
   * ONE workspace-level fact: that this workspace's owner authorises Trevra to
   * act on their LinkedIn account from Trevra's own servers. They configure
   * nothing, they enable nothing on their own, and none of them touches a
   * browser. Hosted execution needs a remote browser provider configured
   * (deployment-level, environment only, no route can change it), this record,
   * a stored sign-in, a per-seat proxy, and every pre-existing safety gate
   * still passing -- see `linkedin/hosted-execution.ts` and
   * docs/hosted-execution.md.
   *
   * OWNER-ONLY, on the same carve-out as the credential routes: this is the
   * decision to hand an account over, and it is the account holder's alone.
   *
   * THE STATEMENT IS RETURNED BY THE GET so that whatever renders the consent
   * shows the exact wording the version number refers to, rather than a copy
   * that can drift from it.
   * ------------------------------------------------------------------ */

  app.get('/api/linkedin/hosted-execution', linkedinRoute(async (req, res) => {
    const mode = hostedExecutionMode();
    const ack = await describeHostedExecutionAck(db, req.auth!.workspaceId);
    const gate = await hostedExecutionGate(db, req.auth!.workspaceId);
    res.json({
      // Nothing here is a secret: a provider LABEL (a host name or the
      // operator's own word for it), never the endpoint, which carries the API
      // key, and never the key.
      deployment: { hosted: mode.hosted, remoteBrowser: mode.remoteBrowser, provider: mode.provider, available: mode.available },
      acknowledgement: ack,
      statement: HOSTED_EXECUTION_STATEMENT,
      statementVersion: HOSTED_EXECUTION_STATEMENT_VERSION,
      // The one fact a screen actually needs: may this workspace's seats be run
      // here right now, and if not, in one sentence, why not.
      allowed: gate.allowed,
      reason: gate.allowed ? null : gate.reason
    });
  }));

  app.post('/api/linkedin/hosted-execution', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'authorise Trevra to act on this LinkedIn account');
    const input = z.object({
      // EXPLICIT, AND THE VERSION MUST MATCH. A client that agreed to wording
      // it has not seen has not agreed to anything, so a stale version is a 409
      // telling it to re-read the statement rather than a silently recorded
      // consent to terms that changed underneath it.
      acknowledge: z.literal(true),
      statementVersion: z.number().int()
    }).parse(req.body ?? {});
    if (input.statementVersion !== HOSTED_EXECUTION_STATEMENT_VERSION) {
      throw new LinkedInApiError(
        `That authorisation refers to version ${input.statementVersion} of the terms and the current version is ${HOSTED_EXECUTION_STATEMENT_VERSION}. Read the current statement and authorise again.`,
        409
      );
    }
    const ack = await recordHostedExecutionAck(db, { workspaceId: req.auth!.workspaceId, actorUserId: req.auth!.userId });
    const gate = await hostedExecutionGate(db, req.auth!.workspaceId);
    res.json({ acknowledgement: ack, allowed: gate.allowed, reason: gate.allowed ? null : gate.reason });
  }));

  app.delete('/api/linkedin/hosted-execution', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'withdraw the authorisation for hosted LinkedIn execution');
    const ack = await revokeHostedExecutionAck(db, { workspaceId: req.auth!.workspaceId, actorUserId: req.auth!.userId });
    /**
     * WITHDRAWAL IS NOT A KILL SWITCH FOR WORK ALREADY IN FLIGHT, and saying so
     * is the same honesty the disconnect route already owes: a seat whose batch
     * is open has a browser mid-action on rows it has already claimed, and
     * rewriting a row does not close a tab. No NEW seat is served from the next
     * tick. Pausing the seat is the faster stop, exactly as it always was.
     */
    res.json({
      acknowledgement: ack,
      allowed: false,
      stopsNewWorkFrom: 'the next worker tick',
      message: 'Hosted execution is withdrawn for this workspace. A batch already in flight finishes; no new seat is picked up.'
    });
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
    // Owner-only, and it belongs with the credential routes above rather than
    // with the read routes: this is the act that USES the stored sign-in.
    // Whoever can call it can drive an authentication attempt against the
    // owner's real LinkedIn account -- and a run of failed ones is exactly the
    // signal that gets an account challenged or restricted.
    assertWorkspaceOwner(req, 'sign a LinkedIn account in');
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
      seatKey: input.seatKey,
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
    // Owner-only for the same reason as the login route above: on the
    // credentials path this signs in to read the profile, so it is a sign-in
    // wearing a different name -- and on the manual path it re-points the seat
    // at whichever account the browser happens to be logged into, which is a
    // change of account, not a refresh.
    assertWorkspaceOwner(req, 'detect a LinkedIn account');
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
    const companionReady = Boolean(config.companionBrowser)
      && await companionWorkspaceReady(db, req.auth!.workspaceId);
    const canDetectHere = companionReady
      || linkedInBrowserReadiness(config).canLaunchHeaded
      || ((await describeLinkedInCredentials(db, req.auth!.workspaceId, input.seatKey)).hasCredentials
        && linkedInHeadlessReadiness(config).canLaunchHeadless);

    if (!canDetectHere) {
      let request: Awaited<ReturnType<typeof requestSeatDetect>>;
      try {
        request = await requestSeatDetect(db, { workspaceId: req.auth!.workspaceId, seatKey: input.seatKey, timezone: input.timezone }, new Date());
      } catch (error) {
        if (error instanceof Error && LINKEDIN_SEAT_INPUT_ERROR.test(error.message)) throw new LinkedInApiError(error.message, 400);
        throw error;
      }
      /**
       * WHO IS GOING TO PICK THIS UP, said accurately rather than by habit.
       *
       * This sentence was always "run the worker on your machine", because
       * that was the only process that could ever fulfil the request. On a
       * hosted deployment with a remote browser and this workspace's recorded
       * authorisation, the hosted runner takes it on its next tick and there
       * is nothing for the operator to run at all -- telling them otherwise
       * would send them to install Node and Chromium for a job already in
       * progress.
       *
       * The gate is asked rather than assumed: a hosted deployment whose
       * workspace has NOT authorised hosted execution still gets the old
       * instruction, because for them it is still the only thing that works.
       */
      const hostedRunner = await hostedExecutionGate(db, req.auth!.workspaceId);
      return res.status(202).json({
        status: 'pending',
        detected: null,
        seat: null,
        degraded: [],
        requestedAt: request.requestedAt,
        message: hostedRunner.allowed && hostedExecutionMode().available
          ? 'Queued for the hosted runner; it will finish connecting this seat on its next pass.'
          : config.companionBrowser
            ? 'Run `npx trevra linkedin` on your computer and keep this Trevra tab open. The pending connection will be picked up when both are online.'
            : 'Run `npm run linkedin:worker` on your machine to finish connecting.'
      });
    }

    let result: Awaited<ReturnType<typeof detectLinkedInSeat>>;
    try {
      result = await detectLinkedInSeat(db, config, {
        workspaceId: req.auth!.workspaceId,
        seatKey: input.seatKey,
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
    const { seatKey } = linkedinSeatSelectorSchema.parse(req.query);
    res.json(await effectiveLinkedInLimits(db, req.auth!.workspaceId, new Date(), seatKey));
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

  /**
   * Change the words of a message that has not been typed yet.
   *
   * SEPARATE FROM EVERY STATUS ROUTE, and it carries exactly one field. There
   * is nothing here that can move a row's status, its slot, its target or its
   * kind -- `editQueuedMessage` refuses anything that is not this workspace's
   * own hand-queued, still-planned, unclaimed message, and rewrites its bytes.
   * A queue an operator cannot correct is a queue they cancel and retype, which
   * spends a trip through the replay guard to fix a typo.
   */
  app.post('/api/linkedin/actions/:id/body', linkedinRoute(async (req, res) => {
    const input = linkedinEditBodySchema.parse(req.body ?? {});
    const action = await editQueuedMessage(db, {
      workspaceId: req.auth!.workspaceId,
      actionId: String(req.params.id),
      body: input.body
    });
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

  /**
   * The sequence-builder campaigns, narrowed to one LinkedIn account when the
   * caller names one.
   *
   * `seatKey` IS A FILTER HERE, unlike the seat hint analytics used to take:
   * `linkedin_campaigns.seat_key` says which account a campaign sends from,
   * and this route ignored it -- so the account switcher moved the Inbox and
   * left this list showing every campaign in the workspace, including ones
   * that stop, edit and queue against an account the operator was not working
   * in. Absent still means the whole workspace, which is what a caller with no
   * switcher has always meant.
   */
  app.get('/api/linkedin/campaigns', linkedinRoute(async (req, res) => {
    const filters = linkedinCampaignListSchema.parse(req.query);
    res.json({ campaigns: await listCampaigns(db, req.auth!.workspaceId, filters) });
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

    // The three copy controls travel with the brief. Absent ones are left off
    // entirely rather than defaulted here, so the skill's own defaults stay the
    // single definition of what an unspecified draft sounds like.
    const skillInput = linkedinSequenceSkill.manifest.inputSchema.parse({
      ...(steps === undefined ? {} : { steps }),
      ...(complete ? { icp: brief.icp, offer: brief.offer } : {}),
      ...(input.tone === undefined ? {} : { tone: input.tone }),
      ...(input.inviteNote === undefined ? {} : { inviteNote: input.inviteNote }),
      ...(input.includeInMail === undefined ? {} : { includeInMail: input.includeInMail }),
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

    // WHOSE ACCOUNT, checked before anything is written. An unknown seat key
    // would otherwise plan against a seat that does not exist and file the
    // campaign under it, and the first symptom is a campaign no screen lists.
    const seatKey = input.input.seatKey ?? OWNER_SEAT_KEY;
    if (input.input.seatKey && !(await getSeat(db, workspaceId, seatKey))) {
      throw new LinkedInApiError('That LinkedIn account is not configured for this workspace', 404);
    }
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
      payload: { ...input.input, seatKey, targets: kept, campaignId },
      actorType: 'user',
      actorId: req.auth!.userId
    });

    const campaign = await createCampaign(
      db,
      {
        id: campaignId,
        workspaceId,
        name: input.name,
        // The same seat the run was planned against. Defaulted in one place
        // above, not twice with two different defaults.
        seatKey,
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
    assertCampaignRunnable(campaign, 'edit');

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

    // ABSENT MEANS UNCHANGED. Only the fields the operator actually sent are
    // merged over the input this campaign was created with, so an edit to the
    // copy cannot silently re-default the tone, the kind, the horizon or the
    // export format to the playbook's values.
    const { steps, ...overrides } = input;
    const previousRunId = campaign.playbookRunId;
    const run = await startPlaybookRun(db, {
      workspaceId,
      playbookId: LINKEDIN_PLAYBOOK_ID,
      payload: { ...brief, ...overrides, campaignId: campaign.id, sequenceSteps: steps },
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
    // Owner-only. This is the one route on the LinkedIn surface that hands over
    // a FILE of people: every target's name and profile, and the exact message
    // body queued against each of them. Listing the exports stays open -- that
    // is metadata, and a teammate has to be able to see that an export exists
    // -- but the bytes are the workspace's contact list, and a downloaded file
    // is a copy nothing here can ever recall.
    assertWorkspaceOwner(req, 'download a campaign export');
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
    assertCampaignRunnable(campaign, 'export');

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
    // Owner-only. Nothing in this file sends, but this is the route that puts
    // rows in front of the thing that does: the worker claims them on its own
    // tick and drives a real browser on the owner's real account. It is the
    // closest an HTTP caller gets to a send, and it is where the account risk
    // is actually incurred.
    assertWorkspaceOwner(req, 'queue a campaign for the local worker');
    linkedinQueueRequestSchema.parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const campaign = await getCampaign(db, workspaceId, String(req.params.id));
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);
    assertCampaignRunnable(campaign, 'queue');

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
  /**
   * Delete a campaign and the outreach records it produced.
   *
   * THE LEDGER IS HISTORY, AND THIS DELETES IT ANYWAY. Every other route in
   * this section leaves `linkedin_actions` alone on the grounds that it is the
   * record of what really happened -- `stopCampaign` skips rows rather than
   * removing them, and the seat delete says so in as many words. That rule is
   * right for every operational decision and it is exactly wrong for this one:
   * a data-subject request is a request to stop holding the record, and a
   * product that answers it by marking rows 'skipped' has not deleted
   * anything. So this route exists, it is owner-only, and it is the only place
   * in the file that removes ledger rows.
   *
   * EXCLUSIONS ARE DELIBERATELY NOT DELETED. `linkedin_exclusions` is the list
   * of people who asked to be left alone. Deleting a campaign must not delete
   * the record that somebody opted out of it -- that would quietly make them
   * approachable again by the next campaign, which is the one outcome an
   * erasure route must never produce. The exclusion list is the workspace's
   * promise to third parties, not the workspace's own data.
   *
   * IT REFUSES RATHER THAN RACING. A running or paused campaign has to be
   * stopped first, so the queued slots are RELEASED through the path that knows
   * how; and an action a worker is holding right now blocks the whole delete,
   * because deleting a row mid-flight leaves the browser acting on behalf of a
   * campaign that no longer exists.
   */
  app.delete('/api/linkedin/campaigns/:id', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'delete a campaign and its outreach records');
    const workspaceId = req.auth!.workspaceId;
    const campaignId = String(req.params.id);
    const campaign = await getCampaign(db, workspaceId, campaignId);
    if (!campaign) throw new LinkedInApiError('LinkedIn campaign not found', 404);

    if (campaign.status === 'running' || campaign.status === 'paused') {
      const status = campaign.status;
      throw new LinkedInApiError(
        `This campaign is ${status}. Stop it first -- POST /api/linkedin/campaigns/${campaignId}/stop -- so its queued slots are released rather than deleted out from under a worker.`,
        409
      );
    }

    const claimed = await db.prepare(
      "SELECT COUNT(*) AS count FROM linkedin_actions WHERE workspace_id=? AND campaign_id=? AND claimed_at IS NOT NULL AND status IN ('planned','held')"
    ).get<{ count: number }>(workspaceId, campaignId);
    const claimedCount = Number(claimed?.count ?? 0);
    if (claimedCount > 0) {
      throw new LinkedInApiError(
        `A worker is holding ${claimedCount} of this campaign's actions right now. Let the batch finish, or pause the seat, and try again.`,
        409
      );
    }

    // One transaction: a campaign whose exports were deleted and whose actions
    // were not is a workspace that can no longer answer either question.
    const removed = await db.transaction(async (tx) => {
      const exports = await tx.prepare('DELETE FROM linkedin_exports WHERE workspace_id=? AND campaign_id=?').run(workspaceId, campaignId);
      const tasks = await tx.prepare('DELETE FROM linkedin_manual_tasks WHERE workspace_id=? AND campaign_id=?').run(workspaceId, campaignId);
      const members = await tx.prepare('DELETE FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?').run(workspaceId, campaignId);
      // No foreign key on `linkedin_actions.campaign_id` (migration 025 says
      // why: the file an operator downloaded outlives the campaign row), so
      // nothing cascades here and the delete has to be explicit.
      const actions = await tx.prepare('DELETE FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?').run(workspaceId, campaignId);
      await tx.prepare('DELETE FROM linkedin_campaigns WHERE workspace_id=? AND id=?').run(workspaceId, campaignId);
      return { exports: exports.changes, manualTasks: tasks.changes, members: members.changes, actions: actions.changes };
    });

    res.json({ deleted: true, campaignId, removed, exclusionsKept: true });
  }));

  app.post('/api/linkedin/campaigns/:id/stop', linkedinRoute(async (req, res) => {
    // Owner-only, unlike the seat pause above, and the difference is that this
    // one does not come back. A stopped campaign cannot be edited, exported or
    // queued ever again, and the slots it had reserved are released -- so it is
    // a destructive end, not a pause. The reversible control a member should
    // reach for is POST /api/linkedin/manager/campaigns/:id/pause.
    assertWorkspaceOwner(req, 'stop a campaign');
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

  /**
   * The funnel, for one account or for all of them, cut in the zone the
   * ceilings were enforced in.
   *
   * `seatKey` NOW FILTERS, AND IT USED NOT TO. It named whose clock the daily
   * buckets were cut on and nothing else, so the account switcher re-cut the
   * days of a chart whose rows never changed: an operator switching to their
   * second account was shown the whole workspace's sends under that account's
   * name. It selects the rows AND the clock now, which is the only reading of
   * "analytics for this account" that is true of both.
   *
   * Every limit in this product is applied in `linkedin_seats.timezone`, so a
   * series bucketed on anything else shows columns that were never any day's
   * total (see `LinkedInAnalytics.timezone`). With no seat named the counts
   * stay workspace-wide and `campaigns.ts` picks the zone most of the
   * workspace's seats are in, setting `timezoneSpansSeats` when they do not
   * agree -- the honest answer for an agency running Berlin and Los Angeles
   * from one screen.
   */
  app.get('/api/linkedin/analytics', linkedinRoute(async (req, res) => {
    const filters = linkedinAnalyticsSchema.parse(req.query);
    const workspaceId = req.auth!.workspaceId;
    // Read from the seat rather than taken from the query: a caller must not be
    // able to re-cut somebody's ledger on a zone no account of theirs is in.
    const seat = filters.seatKey ? await getSeat(db, workspaceId, filters.seatKey) : undefined;
    if (filters.seatKey && !seat) throw new LinkedInApiError('That LinkedIn account is not configured for this workspace', 404);
    res.json(await linkedinAnalytics(
      db,
      workspaceId,
      filters.days,
      new Date(),
      seat ? { timezone: seat.timezone, seatKey: seat.seatKey } : {}
    ));
  }));

  /* Outreach-manager read models. No route in this block queues or sends. */
  app.get('/api/linkedin/manager/seats', linkedinRoute(async (req, res) => {
    res.json({ seats: await listSeats(db, req.auth!.workspaceId) });
  }));

  // Owner-only, for the reason PUT /api/linkedin/seat states at length: the
  // fields these two routes write are the seat's daily ceilings, its working
  // hours and the band override -- an account-risk decision, not a preference.
  // They are field-identical to that route and were reachable by any member.
  app.post('/api/linkedin/manager/seats', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, "change a LinkedIn account's limits");
    const input = linkedinManagerSeatCreateSchema.parse(req.body ?? {});
    assertSeatProxyUsable(req.auth!.workspaceId, input.seatKey, input.proxyUrl);
    try {
      const seat = await upsertSeat(db, req.auth!.workspaceId, input, new Date(), input.seatKey);
      res.status(201).json({ seat });
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.patch('/api/linkedin/manager/seats/:seatKey', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, "change a LinkedIn account's limits");
    const seatKey = linkedinSeatKeySchema.parse(String(req.params.seatKey));
    const input = linkedinSeatSchema.parse(req.body ?? {});
    assertSeatProxyUsable(req.auth!.workspaceId, seatKey, input.proxyUrl);
    if (!(await getSeat(db, req.auth!.workspaceId, seatKey))) throw new LinkedInApiError('LinkedIn account not found', 404);
    try { res.json({ seat: await upsertSeat(db, req.auth!.workspaceId, input, new Date(), seatKey) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.get('/api/linkedin/manager/lead-lists', linkedinRoute(async (req, res) => {
    res.json({ lists: await listLeadLists(db, req.auth!.workspaceId) });
  }));

  /**
   * One lead list and a page of the people on it.
   *
   * THE TOTAL IS COUNTED, NOT INFERRED FROM THE PAGE. `listLeadContacts` clamps
   * to `LEAD_CONTACT_READ_LIMIT` whatever it is handed, so a longer list came
   * back silently short and the only number the screen had was the length of
   * what it received -- which is how it came to announce "the first 1,000 are
   * shown" about a list nobody had measured.
   *
   * THE CEILING AND THE COUNT BOTH COME FROM `lead-lists.ts`. A literal here
   * would be a third copy of a number the reader already clamps to and the UI
   * already prints a sentence about, and an inline `COUNT(*)` would be this
   * file's own opinion of which table a list's people are in -- which the
   * membership schema has already changed once.
   */
  app.get('/api/linkedin/manager/lead-lists/:id/contacts', linkedinRoute(async (req, res) => {
    const listId = String(req.params.id);
    const workspaceId = req.auth!.workspaceId;
    const list = await getLeadList(db, workspaceId, listId);
    if (!list) throw new LinkedInApiError('Lead list not found', 404);
    const [contacts, total] = await Promise.all([
      listLeadContacts(db, workspaceId, listId, LEAD_CONTACT_READ_LIMIT),
      countLeadContacts(db, workspaceId, listId)
    ]);
    // The page bound, so the screen can say "the first N of M" without holding
    // its own copy of N.
    res.json({ list, contacts, total, pageLimit: LEAD_CONTACT_READ_LIMIT });
  }));

  app.get('/api/linkedin/manager/workflows', linkedinRoute(async (req, res) => {
    res.json({ workflows: await listWorkflows(db, req.auth!.workspaceId) });
  }));

  app.get('/api/linkedin/manager/campaigns', linkedinRoute(async (req, res) => {
    res.json({ campaigns: await listManagedCampaigns(db, req.auth!.workspaceId) });
  }));

  app.post('/api/linkedin/manager/campaigns', linkedinRoute(async (req, res) => {
    const input = linkedinManagedCampaignCreateSchema.parse(req.body ?? {});
    try {
      const created = await createManagedCampaign(db, { workspaceId: req.auth!.workspaceId, ...input }, new Date());
      res.status(201).json(created);
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.get('/api/linkedin/manager/campaigns/:id', linkedinRoute(async (req, res) => {
    const campaignId = String(req.params.id);
    const campaign = await getManagedCampaign(db, req.auth!.workspaceId, campaignId);
    if (!campaign) throw new LinkedInApiError('Managed campaign not found', 404);
    res.json({ campaign, members: await listCampaignMembers(db, req.auth!.workspaceId, campaignId) });
  }));

  // Owner-only: starting is the act that begins really approaching strangers on
  // the owner's account, on a cadence nobody has to press a button for again.
  app.post('/api/linkedin/manager/campaigns/:id/start', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'start a managed campaign');
    z.object({}).strict().parse(req.body ?? {});
    try { res.json({ campaign: await startManagedCampaign(db, req.auth!.workspaceId, String(req.params.id), new Date()) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  // DELIBERATELY NOT OWNER-ONLY -- the second of the two, and the same argument
  // as POST /api/linkedin/seat/pause. Pausing parks the queue in 'held' and
  // takes nothing away; the campaign, its members and its copy all survive, and
  // only the owner can start it again. A teammate who can see a campaign
  // approaching the wrong people has to be able to stop it approaching them
  // while they go and find the owner.
  app.post('/api/linkedin/manager/campaigns/:id/pause', linkedinRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const workspaceId = req.auth!.workspaceId;
    const campaignId = String(req.params.id);
    // Read first, exactly as the workflow PUT above does. `pauseManagedCampaign`
    // refuses a campaign that is not running with one sentence covering both
    // "already stopped" and "never existed", and a 409 about state is the wrong
    // answer to an id that is not this workspace's.
    if (!(await getManagedCampaign(db, workspaceId, campaignId))) {
      throw new LinkedInApiError('Managed campaign not found', 404);
    }
    try { res.json({ campaign: await pauseManagedCampaign(db, workspaceId, campaignId, new Date()) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  // Owner-only, for the reason the legacy stop route gives: this one removes
  // every active member, cancels the pending manual tasks and skips the queue.
  // It is the irreversible half of the pair above.
  app.post('/api/linkedin/manager/campaigns/:id/stop', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'stop a managed campaign');
    z.object({}).strict().parse(req.body ?? {});
    try { res.json({ campaign: await stopManagedCampaign(db, req.auth!.workspaceId, String(req.params.id), new Date()) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  /**
   * Pause OR continue one lead, which is one route because they are one
   * decision an operator reverses. The earlier shape hardcoded `true` on the
   * grounds that only safety-reducing controls belong on this surface; that
   * reasoning does not survive contact with the brief, where "lead in campaign
   * can be easily paused or continued" is the requirement, and a pause nobody
   * can undo is a removal wearing a different label.
   */
  app.post('/api/linkedin/manager/members/:id/pause', linkedinRoute(async (req, res) => {
    const input = z.object({ paused: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const changed = await setCampaignMemberPaused(db, req.auth!.workspaceId, String(req.params.id), input.paused, new Date());
    if (!changed) throw new LinkedInApiError(input.paused ? 'Active campaign member not found' : 'Paused campaign member not found', 404);
    res.json({ paused: input.paused });
  }));

  app.post('/api/linkedin/manager/members/:id/resume', linkedinRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const resumed = await setCampaignMemberPaused(db, req.auth!.workspaceId, String(req.params.id), false, new Date());
    if (!resumed) throw new LinkedInApiError('Paused campaign member not found', 404);
    res.json({ paused: false });
  }));

  app.delete('/api/linkedin/manager/members/:id', linkedinRoute(async (req, res) => {
    const removed = await removeCampaignMember(db, req.auth!.workspaceId, String(req.params.id), new Date());
    if (!removed) throw new LinkedInApiError('Active campaign member not found', 404);
    res.json({ removed: true });
  }));

  app.get('/api/linkedin/manager/tasks', linkedinRoute(async (req, res) => {
    const filters = linkedinManualTaskFiltersSchema.parse(req.query);
    res.json({ tasks: await listManualTasks(db, req.auth!.workspaceId, filters) });
  }));

  /**
   * The human checkpoint, closed.
   *
   * This completes the TASK, not the message: the operator sent it in the
   * inbox (or by hand), and this is them saying so, which is what releases the
   * member to the next workflow step. Keeping the two separate is deliberate --
   * Trevra never claims to have sent bytes it did not send.
   */
  app.post('/api/linkedin/manager/tasks/:id/complete', linkedinRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const completed = await completeManualTask(db, req.auth!.workspaceId, String(req.params.id), new Date());
    if (!completed) throw new LinkedInApiError('Pending manual task not found', 404);
    res.json({ completed: true });
  }));

  /**
   * Advance every running campaign now instead of waiting for the worker tick.
   *
   * The same function the background tick calls, with the same ceilings: this
   * is a "don't make me wait a minute" button, not a way around the ramp. It
   * plans rows; it never sends.
   */
  app.post('/api/linkedin/manager/tick', linkedinRoute(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await runManagedCampaigns(db, req.auth!.workspaceId, new Date()));
  }));

  app.get('/api/linkedin/manager/analytics', linkedinRoute(async (req, res) => {
    const filters = linkedinManagedAnalyticsSchema.parse(req.query);
    res.json(await managedAnalytics(db, req.auth!.workspaceId, filters));
  }));

  /* Manager configuration CRUD. These writes configure data; they do not create action-ledger rows. */
  app.post('/api/linkedin/manager/lead-lists/preview', linkedinTargetsUpload.single('file'), linkedinRoute(async (req, res) => {
    if (!req.file) throw new LinkedInApiError('A CSV file of LinkedIn leads is required', 400);
    if (!req.file.originalname.toLowerCase().endsWith('.csv')) throw new LinkedInApiError('Upload a .csv file of LinkedIn leads', 400);
    let mapping: z.infer<typeof linkedinLeadFieldMappingSchema> | undefined;
    if (typeof req.body?.mapping === 'string' && req.body.mapping.trim()) {
      let decoded: unknown;
      try { decoded = JSON.parse(req.body.mapping); }
      catch { throw new LinkedInApiError('mapping must be valid JSON', 400); }
      mapping = linkedinLeadFieldMappingSchema.parse(decoded);
    }
    try {
      const preview = parseLeadCsv(req.file.buffer.toString('utf8'), mapping);
      res.json({
        headers: preview.headers,
        mapping: preview.mapping,
        accepted: preview.accepted.slice(0, 100).map(({ original: _original, dedupeKey: _dedupeKey, ...lead }) => lead),
        acceptedCount: preview.accepted.length,
        rejected: preview.rejected.slice(0, 100).map(({ row, reason }) => ({ row, reason })),
        rejectedCount: preview.rejected.length
      });
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  /**
   * The write half of the preview above, and the reason a lead list can hold
   * leads at all. The preview parses and shows; this one persists, through the
   * same parser, with the same scrub and the same automatch -- so what the
   * operator confirmed on screen is exactly what lands.
   */
  app.post('/api/linkedin/manager/lead-lists/:id/import', linkedinTargetsUpload.single('file'), linkedinRoute(async (req, res) => {
    if (!req.file) throw new LinkedInApiError('A CSV file of LinkedIn leads is required', 400);
    if (!req.file.originalname.toLowerCase().endsWith('.csv')) throw new LinkedInApiError('Upload a .csv file of LinkedIn leads', 400);
    let mapping: z.infer<typeof linkedinLeadFieldMappingSchema> | undefined;
    if (typeof req.body?.mapping === 'string' && req.body.mapping.trim()) {
      let decoded: unknown;
      try { decoded = JSON.parse(req.body.mapping); }
      catch { throw new LinkedInApiError('mapping must be valid JSON', 400); }
      mapping = linkedinLeadFieldMappingSchema.parse(decoded);
    }
    try {
      const result = await importLeadCsv(db, {
        workspaceId: req.auth!.workspaceId,
        listId: String(req.params.id),
        csv: req.file.buffer.toString('utf8'),
        mapping
      }, new Date());
      res.status(201).json(result);
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.post('/api/linkedin/manager/lead-lists', linkedinRoute(async (req, res) => {
    const input = linkedinLeadListCreateSchema.parse(req.body ?? {});
    try {
      const list = await createLeadList(db, { workspaceId: req.auth!.workspaceId, name: input.name, sourceKind: input.sourceKind as LeadListSourceKind, sourceRef: input.sourceRef ?? null }, new Date());
      res.status(201).json({ list });
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  /**
   * Delete a lead list, and everyone on it.
   *
   * `deleteLeadList` owns the refusal, not this route: a list a RUNNING
   * campaign is enrolling from cannot be deleted, because doing so would strand
   * members mid-workflow against contacts that no longer exist. That check
   * belongs with the write for the same reason `queueCampaign` owns the
   * self-hosted gate -- a rule enforced in the route is a rule the next caller
   * skips.
   *
   * Owner-only: this is the delete that removes a workspace's contact data
   * rather than a row about it.
   */
  app.delete('/api/linkedin/manager/lead-lists/:id', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'delete a lead list');
    let deleted;
    try {
      // No existence pre-check: `deleteLeadList` takes the row `FOR UPDATE` so
      // that its refusal and its delete see the same list, and a SELECT out
      // here would be a third read that a concurrent campaign start could slip
      // between. `undefined` is its 404.
      deleted = await deleteLeadList(db, req.auth!.workspaceId, String(req.params.id));
    } catch (error) { rethrowLinkedInManagerError(error); }
    if (!deleted) throw new LinkedInApiError('Lead list not found', 404);
    // The counts are the point. Deleting a list no longer deletes PEOPLE: they
    // lose this membership and keep every other one (migration 052), so
    // `membershipsRemoved` and `contactsDetached` are what a confirmation
    // screen has to be able to show instead of "N leads deleted", which was
    // both alarming and, since migration 053, untrue.
    res.json({ deleted });
  }));

  app.patch('/api/linkedin/manager/contacts/:id', linkedinRoute(async (req, res) => {
    const input = linkedinLeadContactUpdateSchema.parse(req.body ?? {});
    try {
      res.json({ contact: await updateLeadContact(db, { workspaceId: req.auth!.workspaceId, contactId: String(req.params.id), ...input }, new Date()) });
    } catch (error) { rethrowLinkedInManagerError(error); }
  }));

  // Owner-only, and MORE destructive than the lead-list delete three routes
  // above which already is: deleting a contact cascades it out of every
  // campaign it is enrolled in and cancels the manual tasks written for it,
  // where deleting a list only drops memberships.
  app.delete('/api/linkedin/manager/contacts/:id', linkedinRoute(async (req, res) => {
    assertWorkspaceOwner(req, 'delete a lead and its campaign enrolments');
    res.json({ deleted: await removeLeadContact(db, req.auth!.workspaceId, String(req.params.id)) });
  }));

  app.post('/api/linkedin/manager/workflows', linkedinRoute(async (req, res) => {
    const input = linkedinWorkflowWriteSchema.parse(req.body ?? {});
    try { res.status(201).json({ workflow: await saveWorkflow(db, { workspaceId: req.auth!.workspaceId, name: input.name, steps: input.steps }, new Date()) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.put('/api/linkedin/manager/workflows/:id', linkedinRoute(async (req, res) => {
    const input = linkedinWorkflowWriteSchema.parse(req.body ?? {});
    if (!(await getWorkflow(db, req.auth!.workspaceId, String(req.params.id)))) throw new LinkedInApiError('Workflow not found', 404);
    try { res.json({ workflow: await saveWorkflow(db, { workspaceId: req.auth!.workspaceId, id: String(req.params.id), name: input.name, steps: input.steps }, new Date()) }); }
    catch (error) { rethrowLinkedInManagerError(error); }
  }));

  app.delete('/api/linkedin/manager/workflows/:id', linkedinRoute(async (req, res) => {
    res.json({ deleted: await deleteWorkflow(db, req.auth!.workspaceId, String(req.params.id)) });
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
    const workspaceId = req.auth!.workspaceId;
    const config = leadSourcingConfig();
    const sources = await listLeadSources(db, workspaceId, filters.limit);
    const pending = sources
      .filter((source) => source.status === 'pending')
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
    const schedule = new Map<string, SideTaskScheduleView>();
    const now = new Date();
    const waitingFor = pending.length > 0 ? await linkedinQueueWaitReason(db, workspaceId, null, now) : null;

    if (pending.length > 0 && leadSourcingEnabled(config)) {
      const opportunities = await sideTaskSchedule(db, workspaceId, 'lead_sources', now, pending.length);
      pending.forEach((source, index) => {
        const opportunity = opportunities[index];
        if (opportunity) schedule.set(source.id, opportunity);
      });
    }

    res.json({
      enabled: leadSourcingEnabled(config),
      offReason: leadSourcingEnabled(config) ? null : leadSourcingOffReason(config),
      sources: sources.map((source) => {
        const next = schedule.get(source.id);
        if (source.status !== 'pending') return source;
        return {
          ...source,
          ...(next ? {
            nextRunAt: next.startAt.toISOString(),
            nextRunWindowEndAt: next.endAt.toISOString(),
            nextRunTimezone: next.timezone,
            nextRunSeatLabel: next.seatLabel
          } : {}),
          waitingFor
        };
      })
    });
  }));
  /**
   * The daily lead ceiling, read and set.
   *
   * Separate from the per-run `maxResults` on purpose: that one bounds how deep
   * a single walk goes, and an operator who runs six sources in a morning has
   * not bounded anything. This is the number the brief asks for -- how many new
   * leads a day this workspace is willing to collect at all.
   */
  app.get('/api/linkedin/lead-sources/allowance', linkedinRoute(async (req, res) => {
    res.json(await dailyLeadAllowance(db, req.auth!.workspaceId, new Date()));
  }));

  app.put('/api/linkedin/lead-sources/allowance', linkedinRoute(async (req, res) => {
    // Owner-only: this is the number that says how much scraping this workspace
    // is willing to do at all under LinkedIn's User Agreement 8.2, and raising
    // it raises the account's exposure. Reading it stays open, because a
    // teammate whose import stopped has to be able to see why.
    assertWorkspaceOwner(req, "change this workspace's daily lead ceiling");
    const input = linkedinDailyLeadCapSchema.parse(req.body ?? {});
    await setDailyLeadCap(db, req.auth!.workspaceId, input.cap, new Date());
    res.json(await dailyLeadAllowance(db, req.auth!.workspaceId, new Date()));
  }));

  app.get('/api/linkedin/lead-sources/:id', linkedinRoute(async (req, res) => {
    const source = await getLeadSource(db, req.auth!.workspaceId, String(req.params.id));
    if (!source) throw new LinkedInApiError('LinkedIn lead source not found', 404);
    res.json({ source });
  }));

  /**
   * Turn what a walk found into leads a campaign can actually enrol.
   *
   * Harvested rows and campaign contacts were two different tables with no road
   * between them, so a search could never feed a campaign. This is the road:
   * the same scrub and the same first/last split the CSV path uses, into a
   * persistent list.
   */
  app.post('/api/linkedin/lead-sources/:id/import', linkedinRoute(async (req, res) => {
    const input = linkedinLeadSourceImportSchema.parse(req.body ?? {});
    try {
      res.status(201).json(await importLeadSourceContacts(db, { workspaceId: req.auth!.workspaceId, sourceId: String(req.params.id), ...input }, new Date()));
    } catch (error) { rethrowLinkedInManagerError(error); }
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
    const { seatKey } = linkedinSeatSelectorSchema.parse(req.query);
    const conversation = await readStoredThread(db, req.auth!.workspaceId, String(req.params.threadUrn), seatKey);
    if (!conversation) throw new LinkedInApiError('LinkedIn conversation not found', 404);
    res.json(conversation);
  }));

  app.post('/api/linkedin/inbox/sync', linkedinRoute(async (req, res) => {
    const input = linkedinInboxSyncSchema.parse(req.body ?? {});
    const config = linkedinWorkerConfigOrRefuse();
    const result = await syncLinkedInInbox(db, config, {
      workspaceId: req.auth!.workspaceId,
      seatKey: input.seatKey,
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
    if (!(await threadByUrn(db, workspaceId, threadUrn, input.seatKey))) {
      throw new LinkedInApiError('LinkedIn conversation not found', 404);
    }
    const config = linkedinWorkerConfigOrRefuse();
    const result = await syncLinkedInThread(db, config, threadUrn, {
      workspaceId,
      seatKey: input.seatKey,
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
        seatKey: input.seatKey,
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

  /**
   * Find out which vanished invites were accepted.
   *
   * A FIFTH ROUTE ON THIS SURFACE, and it belongs beside the withdrawal ones
   * because it reads the same evidence: `withdrawals/sync` records that an
   * invite has left LinkedIn's pending list and deliberately concludes nothing
   * from it, and this is the pass that goes and finds out which of the four
   * things that could mean actually happened.
   *
   * IT OPENS PROFILES, SO IT IS A SEND-SHAPED ROUTE, not a read-shaped one.
   * Every check is a real profile view against the seat's account: paced,
   * gated, budgeted and filed as a `profile_view` ledger row by
   * `detectAcceptedInvites`. It is POST for that reason and it is bounded by
   * the same `maxChecks` the unattended tick uses -- an operator pressing this
   * button must not be able to spend an afternoon's profile-view budget in one
   * request.
   *
   * 409 rather than 500 when no browser can open, exactly as its neighbours do.
   */
  app.post('/api/linkedin/acceptance/detect', linkedinRoute(async (req, res) => {
    const input = linkedinAcceptanceDetectSchema.parse(req.body ?? {});
    const config = linkedinWorkerConfigOrRefuse();
    const result = await detectLinkedInAcceptances(db, config, {
      workspaceId: req.auth!.workspaceId,
      ...(input.seatKey === undefined ? {} : { seatKey: input.seatKey }),
      ...(input.maxChecks === undefined ? {} : { maxChecks: input.maxChecks }),
      now: new Date(),
      log: () => {}
    });
    if (result.blockedReason) throw new LinkedInApiError(result.blockedReason, 409);
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
    const workspaceId = req.auth!.workspaceId;
    const withdrawals = await listWithdrawals(db, workspaceId, filters);
    const now = new Date();
    const timingBySeat = new Map<string, { next: SideTaskScheduleView | null; waitingFor: LinkedInQueueWaitReason | null }>();

    for (const seatKey of new Set(withdrawals.filter((row) => row.status === 'queued').map((row) => row.seatKey))) {
      const [next] = await sideTaskSchedule(db, workspaceId, 'withdrawals', now, 1, seatKey);
      timingBySeat.set(seatKey, {
        next: next ?? null,
        waitingFor: await linkedinQueueWaitReason(db, workspaceId, seatKey, now)
      });
    }

    res.json({
      withdrawals: withdrawals.map((row) => {
        if (row.status !== 'queued') return row;
        const timing = timingBySeat.get(row.seatKey);
        return {
          ...row,
          ...(timing?.next ? {
            nextRunAt: timing.next.startAt.toISOString(),
            nextRunWindowEndAt: timing.next.endAt.toISOString(),
            nextRunTimezone: timing.next.timezone
          } : {}),
          waitingFor: timing?.waitingFor ?? null
        };
      })
    });
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
      // `manual`, because this IS the manual surface: a live request from a
      // signed-in operator, filed below as `source: 'manual'`. It relaxes the
      // working window and the weekend rule -- a person follows somebody when
      // they are looking at them -- and nothing else. Every ceiling below still
      // counts this like any other action.
      { workspaceId, kind: input.kind, targetRef: input.targetRef, plannedFor, manual: true },
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
  /**
   * Give the password back to nobody -- AND ACTUALLY DISCONNECT.
   *
   * The screen calls this "disconnect". It used to delete two `workspace_secrets`
   * rows and stop, which is not a disconnect: the `reddit_accounts` row survived
   * with its username and its `session_valid_at`, and the Chrome profile
   * directory survived with live cookies in it. So `loginRedditAccount` still
   * took its reuse branch, found a session that still worked, and
   * `POST /api/reddit/comment` still posted -- from the account the customer
   * had just revoked, using a password the server no longer held. Deleting the
   * credential had removed the ability to sign in AGAIN while leaving the
   * already-signed-in browser exactly as it was.
   *
   * `disconnectRedditWorkspace` is the whole act: close any browser holding the
   * session, remove the profile directory, wipe the sealed credentials, clear
   * the account row. It does that job, so this route does not also call
   * `deleteRedditCredentials` -- two writers of one wipe is how a second one
   * comes to be forgotten.
   *
   * NOT GATED ON WHETHER REDDIT AUTOMATION IS ENABLED, deliberately, and unlike
   * every other Reddit route below. "We cannot revoke your account because the
   * feature you are revoking is switched off" has no defensible reading: the
   * cookies on disk are live whatever the config says, and a deployment that
   * turned automation off after a session was stored is precisely the case
   * where the leftover profile matters most.
   *
   * A NON-EMPTY `problems` IS NOT A SUCCESS. The function never throws -- it
   * does as much of the disconnect as it can and reports what it could not do
   * -- so a route that answered 200 with a cheerful body would turn "the
   * profile directory is still on disk" into "disconnected". 207 instead, with
   * the sentences, because part of it DID happen and re-running it is safe.
   *
   * Owner-only, same carve-out as every other credential route in this file.
   */
  app.delete('/api/reddit/credentials', redditRoute(async (req, res) => {
    if (req.auth!.role !== 'owner') {
      throw new RedditApiError('Only the workspace owner can disconnect the stored Reddit account', 403);
    }
    const removed = await disconnectRedditWorkspace(db, req.auth!.workspaceId, { actorUserId: req.auth!.userId });
    res.setHeader('Cache-Control', 'no-store');
    res.status(removed.problems.length > 0 ? 207 : 200).json({
      // The credential is gone from the store either way -- `problems` is about
      // the browser and the disk, never about the sealed pair.
      hasCredentials: false,
      username: null,
      disconnected: removed.problems.length === 0,
      removed
    });
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

function requireSession(db: Db, unattributedLimiter: RequestHandler) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const identity = await readSession(db, req);
      if (!identity) {
        // Charged to the IP bucket HERE rather than on the way in. A request
        // carrying a session cookie skips that bucket so a NAT'd tenant is not
        // capped by an address it shares with a stranger -- and a cookie that
        // does not resolve would otherwise have bought an unmetered 401 simply
        // by presenting one.
        return unattributedLimiter(req, res, () => { res.status(401).json({ error: 'Session expired' }); });
      }
      req.auth = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Does this request CLAIM a browser session?
 *
 * PRESENCE, NOT VALIDITY. Validity is `readSession`'s job and costs a database
 * round trip, which is not something to spend before deciding whether to rate
 * limit -- and a limiter that had to authenticate first would be a limiter an
 * unauthenticated flood could make expensive. Both cookie families are
 * recognised because there are two: Trevra's own hand-rolled demo cookie, and
 * better-auth's, whose name that library prefixes and suffixes rather than
 * this file fixing it.
 */
function carriesSessionCredential(req: Request): boolean {
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  if (!cookies || typeof cookies !== 'object') return false;
  return Object.keys(cookies).some((name) => name === SESSION_COOKIE || name.includes('better-auth'));
}

/**
 * The owner carve-out, applied to the acts a teammate must not perform alone.
 *
 * ONE MECHANISM, TWO CALL SHAPES, AND NOTHING NEW UNDERNEATH. Both read the
 * same `req.auth!.role` the three original carve-outs read -- adding a
 * teammate, and saving or wiping the stored LinkedIn sign-in -- because a
 * second notion of "privileged" is a second thing to keep in step with
 * better-auth's member roles, and the day the two disagree is the day one of
 * them is wrong. `resolveActiveWorkspace` fails closed to 'member', so a
 * membership that cannot be read is refused here rather than waved through.
 *
 * `ownerOnly` runs BEFORE a plain route's handler, which is where the check
 * belongs when the handler's first act is the privileged one.
 * `assertWorkspaceOwner` throws from INSIDE a `linkedinRoute` handler, because
 * that wrapper is what turns a typed 4xx into a response and a middleware
 * would answer that surface in a different shape than every other refusal on
 * it.
 *
 * WHY EACH ACT IS ON THE LIST is written at the route, not here -- and two
 * that a reader will expect are deliberately NOT on it. See the comments on
 * `POST /api/linkedin/seat/pause` and
 * `POST /api/linkedin/manager/campaigns/:id/pause`: a kill switch only an
 * absent owner can reach is not a kill switch.
 */
function ownerOnly(act: string): RequestHandler {
  return (req, res, next) => {
    if ((req as AuthedRequest).auth!.role !== 'owner') {
      return res.status(403).json({ error: `Only the workspace owner can ${act}` });
    }
    next();
  };
}

function assertWorkspaceOwner(req: AuthedRequest, act: string): void {
  if (req.auth!.role !== 'owner') throw new LinkedInApiError(`Only the workspace owner can ${act}`, 403);
}

/* ===========================================================================
 * Workspace export and erasure: which tables, and how they are found.
 * ======================================================================== */

/** Catalogue output is still interpolated into SQL, so it is checked first. */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Tables the catalogue finds that are NOT this workspace's data.
 *
 * `workspace_erasures` is the RECORD of an erasure and deliberately carries no
 * foreign key to `workspaces`, so that it outlives the workspace it describes.
 * Counting it as something to remove would delete the proof that the deletion
 * happened -- the one row anybody would ever ask to see afterwards.
 */
const WORKSPACE_INVENTORY_EXCLUDED: ReadonlySet<string> = new Set(['workspace_erasures']);

/**
 * Rows that are the customer's data and do not carry `workspace_id`.
 *
 * Ten tables in this schema hang off a workspace-scoped parent and are reached
 * only through it -- the clauses of a contract, the milestones and scope of a
 * project, the evidence and outcome of a recommendation. An export that walked
 * only the `workspace_id` column would hand back contracts with no clauses and
 * recommendations with no outcomes, and call it "your data". Each entry takes
 * exactly one bind parameter: the workspace id.
 *
 * They do not need to be listed for ERASURE -- every one of them cascades from
 * its parent -- but they are counted there anyway, because a preview that
 * under-reports what it is about to delete is a preview nobody can consent to.
 */
const WORKSPACE_CHILD_TABLES: ReadonlyArray<{ table: string; where: string }> = [
  { table: 'approvals', where: 'action_id IN (SELECT id FROM actions WHERE workspace_id=?)' },
  { table: 'contract_clauses', where: 'contract_id IN (SELECT id FROM contracts WHERE workspace_id=?)' },
  { table: 'milestones', where: 'project_id IN (SELECT id FROM projects WHERE workspace_id=?)' },
  { table: 'scope_items', where: 'project_id IN (SELECT id FROM projects WHERE workspace_id=?)' },
  { table: 'playbook_step_runs', where: 'playbook_run_id IN (SELECT id FROM playbook_runs WHERE workspace_id=?)' },
  { table: 'recommendation_evidence', where: 'recommendation_id IN (SELECT id FROM recommendations WHERE workspace_id=?)' },
  { table: 'recommendation_outcomes', where: 'recommendation_id IN (SELECT id FROM recommendations WHERE workspace_id=?)' },
  { table: 'proof_packs', where: 'recommendation_id IN (SELECT id FROM recommendations WHERE workspace_id=?)' },
  {
    table: 'proof_pack_items',
    where: 'proof_pack_id IN (SELECT id FROM proof_packs WHERE recommendation_id IN (SELECT id FROM recommendations WHERE workspace_id=?))'
  },
  { table: 'research_source_documents', where: 'source_id IN (SELECT id FROM research_sources WHERE workspace_id=?)' }
];

/**
 * Tables whose rows are KEYS, not information.
 *
 * A data-subject export is a copy of the customer's own data, handed to a
 * browser and then to wherever they choose to keep it. A sealed LinkedIn
 * password, a Reddit sign-in, a CLI subscription token and an agent token's
 * hash are none of those things -- they are the material somebody needs to BE
 * the customer, and this file cannot decrypt them in any case (see the two
 * import comments at the top of it, which is the same rule stated for the same
 * reason). They are NAMED in the manifest as withheld rather than silently
 * skipped: silence would read as "there was no sign-in stored", which is a
 * different and false claim.
 */
const WORKSPACE_EXPORT_SEALED_TABLES: ReadonlySet<string> = new Set([
  'workspace_secrets',
  'linkedin_seat_credentials',
  'agent_tokens'
]);

/** The same ceiling `ledger-export.ts` uses, for the same reason: a bounded file. */
const WORKSPACE_EXPORT_ROW_LIMIT = 50_000;

/**
 * NOT A HAND-WRITTEN LIST, and that is the whole design.
 *
 * The tables holding a workspace's data are read from the CATALOGUE -- every
 * base table in `public` carrying a `workspace_id` column -- rather than typed
 * out here. A literal list goes stale one migration after whoever maintained it
 * moves on, and stale has two failure modes that both look like success: an
 * export that quietly omits a table the customer asked for, and an erasure that
 * quietly keeps one. Neither raises anything; both are the sentence in the
 * privacy policy becoming untrue with nobody noticing. Read from the catalogue,
 * a table a future migration adds is covered by both on the day it lands.
 */
async function workspaceScopedTables(db: Db): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'workspace_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `).all<{ table_name: string }>();
  return rows
    .map((row) => String(row.table_name))
    .filter((name) => SAFE_TABLE_NAME.test(name) && !WORKSPACE_INVENTORY_EXCLUDED.has(name));
}

/** Row counts per table, sealed ones included: the preview must not under-report. */
async function workspaceInventory(db: Db, workspaceId: string): Promise<Array<{ table: string; rows: number }>> {
  const inventory: Array<{ table: string; rows: number }> = [];
  for (const table of await workspaceScopedTables(db)) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).get<{ count: number }>(workspaceId);
    inventory.push({ table, rows: Number(row?.count ?? 0) });
  }
  for (const child of WORKSPACE_CHILD_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${child.table} WHERE ${child.where}`).get<{ count: number }>(workspaceId);
    inventory.push({ table: child.table, rows: Number(row?.count ?? 0) });
  }
  return inventory.sort((left, right) => left.table.localeCompare(right.table));
}

/** The bundle GET /api/workspace/export sends. Rendered, sent, never stored. */
async function exportWorkspaceData(db: Db, workspaceId: string): Promise<Record<string, unknown>> {
  const workspace = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId);
  const tables: Record<string, unknown[]> = {};
  const truncated: string[] = [];
  const withheld: string[] = [];

  const read = async (table: string, where: string): Promise<void> => {
    // One row over the ceiling, so "exactly at the limit" and "more than the
    // limit" are distinguishable rather than both reported as complete.
    const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT ${WORKSPACE_EXPORT_ROW_LIMIT + 1}`).all(workspaceId);
    if (rows.length > WORKSPACE_EXPORT_ROW_LIMIT) {
      rows.length = WORKSPACE_EXPORT_ROW_LIMIT;
      truncated.push(table);
    }
    tables[table] = rows;
  };

  for (const table of await workspaceScopedTables(db)) {
    if (WORKSPACE_EXPORT_SEALED_TABLES.has(table)) { withheld.push(table); continue; }
    await read(table, 'workspace_id=?');
  }
  for (const child of WORKSPACE_CHILD_TABLES) await read(child.table, child.where);

  return {
    workspace,
    generatedAt: new Date().toISOString(),
    tableCount: Object.keys(tables).length,
    rowLimitPerTable: WORKSPACE_EXPORT_ROW_LIMIT,
    /** Named, so a short file is never mistaken for a complete one. */
    truncated,
    withheld,
    withheldReason:
      'Sealed credentials and token hashes are the key to an account rather than information about it, '
      + 'and no code path in this server can decrypt them. Row counts for them appear in GET /api/workspace/erasure.',
    tables
  };
}

/**
 * Reasons an erasure would be a race rather than a deletion.
 *
 * Each one is another process holding rows this would remove underneath it, and
 * each comes back as the sentence naming what to go and stop. "Refuse and say
 * why" beats "delete and hope": a half-erased workspace has nothing left in it
 * to explain what happened to the other half.
 */
async function workspaceWorkInFlight(db: Db, workspaceId: string): Promise<string[]> {
  const count = async (sql: string): Promise<number> =>
    Number((await db.prepare(sql).get<{ count: number }>(workspaceId))?.count ?? 0);
  const blockers: string[] = [];

  const runs = await count("SELECT COUNT(*) AS count FROM agent_runs WHERE workspace_id=? AND status='running'");
  if (runs > 0) blockers.push(`${runs} agent run(s) are still running. Stop them first: POST /api/agent-runs/:id/stop.`);

  const batches = await count("SELECT COUNT(*) AS count FROM linkedin_batches WHERE workspace_id=? AND status='running'");
  if (batches > 0) {
    blockers.push(`${batches} LinkedIn batch(es) are open in a worker's browser. Pause the seat and let the batch end: POST /api/linkedin/seat/pause.`);
  }

  const claimed = await count(
    "SELECT COUNT(*) AS count FROM linkedin_actions WHERE workspace_id=? AND claimed_at IS NOT NULL AND status IN ('planned','held')"
  );
  if (claimed > 0) blockers.push(`${claimed} LinkedIn action(s) are claimed by a worker right now. They finish on their own within one tick.`);

  const campaigns = await count("SELECT COUNT(*) AS count FROM linkedin_campaigns WHERE workspace_id=? AND status='running'");
  if (campaigns > 0) {
    blockers.push(`${campaigns} LinkedIn campaign(s) are still running. Stop them first: POST /api/linkedin/manager/campaigns/:id/stop.`);
  }

  return blockers;
}

/**
 * TYPE THE NAME. `strict()` so a client that thinks `{ force: true }` is a
 * thing gets told, and a plain boolean is deliberately not accepted: a
 * checkbox is something a script ticks, and the smallest gesture that proves a
 * human read the screen is retyping what is about to be destroyed.
 */
const workspaceErasureSchema = z.object({ confirm: z.string().trim().min(1).max(200) }).strict();

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

/**
 * An undecided approval step, in the words the refusal needs.
 *
 * Every state EXCEPT 'completed' is a refusal, and each one sends the operator
 * somewhere different -- back to the approval screen, back to the drawing
 * board, or nowhere at all. A single "not approved" would flatten the three.
 */
const LINKEDIN_APPROVAL_STATE: Partial<Record<PlaybookStepStatus, string>> = {
  waiting_approval: 'is still waiting for a founder to approve it',
  pending: 'has not reached its approval step yet',
  running: 'is still being planned',
  failed: 'was rejected',
  skipped: 'had its approval step skipped',
  cancelled: 'was cancelled'
};

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
 * Is this campaign in a state that may still produce work?
 *
 * TWO HALTED STATES, NOT ONE, AND THE SECOND WAS MISSING FROM EVERY LEGACY
 * ROUTE. `pauseManagedCampaign` writes `status='paused'` and parks the
 * campaign's unclaimed queue in 'held' -- that is what migration 051 exists to
 * do. But the three campaign routes below each gated on `status === 'stopped'`
 * alone, so a PAUSED campaign could still be queued and still be exported: the
 * queue wrote fresh 'planned' rows for the worker to claim, and the export
 * wrote 'exported' rows that consume pacing budget. Both reopen exactly what
 * the pause closed, against a campaign the operator has been shown as stopped.
 *
 * WHY THE PARAMETER IS `{ status: string }` AND NOT `LinkedInCampaign`. There
 * are two unions over one column: `managed-campaigns.ts` names 'paused' and
 * `campaigns.ts` does not, and `campaigns.ts` casts the raw column onto its
 * narrower union on the way out -- so `campaign.status === 'paused'` does not
 * typecheck against a value the database demonstrably holds, and TypeScript
 * calls the comparison unsatisfiable rather than catching the bug. Widening
 * here is the honest reading of a column whose real vocabulary is the wider of
 * the two. The proper fix is ONE union shared by both files; it belongs in
 * those files, not in this one.
 */
function assertCampaignRunnable(campaign: { status: CampaignStatus }, act: string): void {
  if (campaign.status === 'stopped') {
    throw new LinkedInApiError(`This campaign was stopped, so there is nothing left to ${act}.`, 409);
  }
  if (campaign.status === 'paused') {
    throw new LinkedInApiError(
      `This campaign is paused, so there is nothing to ${act} until it runs again. Start it from the campaign manager first.`,
      409
    );
  }
}

/** Turn only EXPECTED manager-domain failures into 4xx; database faults still surface as 500. */
function rethrowLinkedInManagerError(error: unknown): never {
  if (error instanceof LinkedInApiError || error instanceof z.ZodError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (code === '23505') throw new LinkedInApiError('That LinkedIn manager name or active lead claim already exists.', 409);
  if (code === '23503') throw new LinkedInApiError('That LinkedIn manager record references an item that no longer exists.', 400);
  if (error instanceof Error && /not found/i.test(error.message)) throw new LinkedInApiError(error.message, 404);
  // "Only a running campaign can be paused." and its siblings: the caller asked
  // for a transition this row's CURRENT STATE does not allow. That is a 409,
  // and it used to be a 500 -- the manager module throws these as plain Errors
  // and nothing here recognised the shape, so pausing an already-paused
  // campaign told the operator the server had faulted.
  if (error instanceof Error && /^Only an? .+ can be /i.test(error.message)) throw new LinkedInApiError(error.message, 409);
  if (error instanceof Error && /(required|must |needs |could not map|does not exist in this csv|duplicate|unsupported variable|withdraw-pending|source must|working hours|seat_key)/i.test(error.message)) {
    throw new LinkedInApiError(error.message, 400);
  }
  throw error;
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

  /**
   * A PAYLOAD IS NOT A DECISION, and this checked only that a payload existed.
   *
   * `placeStepBehindApproval` (playbooks/engine.ts) writes `input_json` at the
   * moment it STOPS for a human -- so a step sitting at `waiting_approval`, and
   * a step a founder REJECTED, both carry a full payload. Reading that as
   * "approved" is how a campaign nobody agreed to got 201s out of the export
   * route and, once the worker route landed, would have got its actions written
   * as 'planned' rows for the local worker to send. A disabled button in the
   * client is not an authorisation check.
   *
   * TWO CONDITIONS, BOTH OF THEM THE ENGINE'S OWN. The step must have COMPLETED
   * -- `decidePlaybookApproval` sets 'completed' on approve and 'failed' on
   * reject -- and a `playbook_approvals` row must exist for this exact payload
   * hash with `decision='approve'`, which is the same pair `runActionStep`
   * requires before it will perform an approved action. An approval granted for
   * a payload that has since changed is not an approval of this one.
   */
  if (approval.status !== 'completed') {
    throw new LinkedInApiError(
      `This campaign's plan ${LINKEDIN_APPROVAL_STATE[approval.status] ?? `is in state '${approval.status}'`}, so there is nothing approved to ${verb}. ${verb === 'export' ? 'An export is' : 'A queued campaign is'} the bytes a founder approved, never a plan nobody decided on.`,
      409
    );
  }
  const granted = approval.approvalPayloadHash
    ? await db.prepare(`
        SELECT id FROM playbook_approvals
        WHERE workspace_id=? AND playbook_run_id=? AND step_run_id=? AND decision='approve' AND payload_hash=?
        ORDER BY created_at DESC LIMIT 1
      `).get<{ id: string }>(workspaceId, run!.id, approval.id, approval.approvalPayloadHash)
    : undefined;
  if (!granted) {
    throw new LinkedInApiError(
      `No founder approval is on file for this campaign's current plan, so it cannot be ${verb === 'export' ? 'exported' : 'queued'}. Approve the plan as it stands now -- an approval granted for a payload that has since changed is not an approval of this one.`,
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

type SideTaskScheduleView = {
  startAt: Date;
  endAt: Date;
  timezone: string;
  seatLabel: string;
  seatKey: string;
};

type LinkedInBackgroundScheduleView = SideTaskScheduleView & {
  source: 'maintenance' | 'actions' | 'catchup';
  waitingFor: LinkedInQueueWaitReason | null;
};

/**
 * One shared answer to “why is due LinkedIn work not moving?”. The queue screens
 * render this vocabulary instead of each inventing their own explanation.
 */
async function linkedinQueueWaitReason(
  db: Db,
  workspaceId: string,
  seatKey: string | null,
  now: Date
): Promise<LinkedInQueueWaitReason | null> {
  if (seatKey) {
    const seat = await getSeat(db, workspaceId, seatKey);
    if (seat) {
      const posture = effectivePosture(seat, now);
      if (posture === 'paused') return 'account_paused';
      if (posture === 'cooldown') return 'account_cooldown';
    }
  } else {
    const seats = await listSeats(db, workspaceId);
    if (seats.length > 0) {
      const postures = seats.map((seat) => effectivePosture(seat, now));
      if (postures.every((posture) => posture === 'paused')) return 'account_paused';
      if (postures.every((posture) => posture === 'paused' || posture === 'cooldown')) return 'account_cooldown';
    }
  }

  let worker: LinkedInLocalWorkerConfig;
  try { worker = validateEnvironment().linkedinLocalWorker; }
  catch { return 'worker'; }
  if (!worker.enabled) return 'worker';

  if (worker.companionBrowser) {
    const companion = await listCompanionStatus(db, workspaceId, now);
    if (!companion.devices.some((device) => device.online)) return 'computer';
  }
  return null;
}

/**
 * Future deterministic visit windows for one recurring LinkedIn side task.
 * Past visits are never returned, so sleeping through a window advances the ETA
 * rather than creating catch-up traffic on reconnect.
 */
async function nextLinkedInBackgroundRun(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date
): Promise<LinkedInBackgroundScheduleView | null> {
  const seat = await getSeat(db, workspaceId, seatKey);
  if (!seat) return null;
  const waitingFor = await linkedinQueueWaitReason(db, workspaceId, seatKey, now);
  const runs = await sideTaskRuns(db, workspaceId, seatKey);
  const candidates: Array<{ startAt: Date; endAt: Date; source: 'maintenance' | 'actions' | 'catchup' }> = [];

  // A companion return is eligible immediately once both presence gates are
  // back. Represent it as NOW rather than pretending the next deterministic
  // visit is the next thing the worker will do.
  if (availabilityCatchUpPending(runs)) {
    candidates.push({ startAt: now, endAt: now, source: 'catchup' });
  }

  // A read-only visit is real work only when at least one side task is due in
  // that visit. Take the earliest of the five task schedules rather than
  // labelling a bare visit window as a fetch that might never open a browser.
  for (const task of SIDE_TASK_NAMES) {
    const [next] = nextSideTaskOpportunities(seat, runs, task, now, 1);
    if (next) candidates.push({ startAt: next.startAt, endAt: next.endAt, source: 'maintenance' });
  }

  // Campaign/automated actions can make an earlier sitting than the next
  // maintenance read. Manual work is intentionally excluded: it is the person
  // asking Trevra to act now, not a background run.
  const planned = await db.prepare(`
    SELECT planned_for
    FROM linkedin_actions
    WHERE workspace_id=? AND seat_key=? AND status='planned' AND source <> 'manual' AND planned_for IS NOT NULL
    ORDER BY planned_for ASC
    LIMIT 1
  `).get<{ planned_for: string }>(workspaceId, seatKey);
  if (planned?.planned_for) {
    const plannedAt = new Date(planned.planned_for);
    if (!Number.isNaN(plannedAt.getTime())) {
      const target = Math.max(now.getTime(), plannedAt.getTime());
      const visits = nextVisitOpportunities(seat, runs, now, 20);
      const visit = visits.find((candidate) => candidate.endAt.getTime() >= target);
      if (visit) candidates.push({ startAt: visit.startAt, endAt: visit.endAt, source: 'actions' });
    }
  }

  candidates.sort((left, right) => left.startAt.getTime() - right.startAt.getTime() || left.endAt.getTime() - right.endAt.getTime());
  const next = candidates[0];
  if (!next) return null;
  return {
    ...next,
    timezone: seat.timezone,
    seatLabel: seat.label,
    seatKey: seat.seatKey,
    waitingFor
  };
}

async function sideTaskSchedule(
  db: Db,
  workspaceId: string,
  task: SideTaskName,
  now: Date,
  count = 1,
  seatKey?: string
): Promise<SideTaskScheduleView[]> {
  const opportunities: SideTaskScheduleView[] = [];
  for (const seat of await listSeats(db, workspaceId)) {
    if (seatKey && seat.seatKey !== seatKey) continue;
    const posture = effectivePosture(seat, now);
    if (posture === 'paused' || posture === 'cooldown') continue;
    const runs = await sideTaskRuns(db, workspaceId, seat.seatKey);
    for (const opportunity of nextSideTaskOpportunities(seat, runs, task, now, count)) {
      opportunities.push({
        ...opportunity,
        timezone: seat.timezone,
        seatLabel: seat.label,
        seatKey: seat.seatKey
      });
    }
  }
  opportunities.sort((left, right) => left.startAt.getTime() - right.startAt.getTime() || left.seatKey.localeCompare(right.seatKey));
  return opportunities.slice(0, Math.max(1, count));
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
 * THE CAMPAIGN'S CURRENT RUN FIRST, and the stored brief (029) as the fallback
 * for a campaign whose run has been pruned out of history -- which is the order
 * an edit needs and the reverse of what this did.
 *
 * `linkedin_campaigns.brief_json` is written once, at creation, and
 * `attachCampaignRun` has no way to update it; reading it first meant every
 * re-plan started from the campaign's ORIGINAL settings. So an operator who
 * edited the tone to `direct` and then edited a word of the copy got their tone
 * silently reverted by the second save -- an edit undoing an earlier edit
 * nobody had touched. The latest run's input is the campaign as it now stands,
 * so edits compound instead of fighting.
 *
 * The `targets` check is the test of usefulness rather than of shape: a payload
 * with no targets cannot be paced, so it is not an input, it is a husk -- and
 * a run that never got that far falls through to the stored brief for exactly
 * that reason.
 */
async function campaignPlaybookInput(
  db: Db,
  workspaceId: string,
  campaign: { id: string; playbookRunId: string | null }
): Promise<Record<string, unknown> | null> {
  if (campaign.playbookRunId) {
    const run = await getPlaybookRun(db, workspaceId, campaign.playbookRunId);
    if (isPlannableInput(run?.input)) return run.input;
  }
  const stored = await getCampaignBrief(db, workspaceId, campaign.id);
  return isPlannableInput(stored) ? stored : null;
}

function isPlannableInput(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const targets = value.targets;
  return Array.isArray(targets) && targets.length > 0;
}

/**
 * seats.ts owns these rules; this only recognises its refusals as 400s, not faults.
 *
 * `Working hours must be` is the one refusal here that zod cannot also make and
 * never will: `workStartMinute` and `workEndMinute` are each valid on their
 * own, and only the PAIR is wrong. An operator who types an 18:00-08:00 window
 * -- the ordinary way to get this wrong -- was told the server had faulted.
 */
const LINKEDIN_SEAT_INPUT_ERROR = /(needs a label|needs an IANA timezone|is not an IANA timezone|must be a 'YYYY-MM-DD' date|Working hours must be)/;

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
/**
 * Every status the ledger can hold, imported rather than restated.
 *
 * This list used to be hand-copied here, and it was wrong in both directions:
 * 'held' (migration 051) and 'withdrawn' (migration 032) were missing, so
 * `GET /api/linkedin/actions?status=held` answered 400 -- the rows a pause
 * parks were unreadable through the only API that lists the queue, which is
 * precisely the state migration 051 exists to make visible -- while the client
 * had drifted the other way and offered 'withdrawn', which this enum rejected.
 * A `satisfies` guard then caught the next drift at build time, which is better
 * than a promise but still one hand-copied list. `actions.ts` now publishes the
 * vocabulary as values, so there is nothing left here to get wrong.
 */
const linkedinActionStatus = z.enum(ACTION_STATUS_VALUES);
const linkedinExportFormat = z.enum(['dripify', 'heyreach', 'expandi', 'generic']);
/** The two copy dials `gtm.linkedin-sequence` owns, spelled once for every route that offers them. */
const linkedinSequenceTone = z.enum(['direct', 'consultative', 'peer']);
/** `none` drafts a bare connection request; `drafted` is what every campaign before the option got. */
const linkedinInviteNoteMode = z.enum(['drafted', 'none']);

/**
 * The seat patch.
 *
 * `posture` is absent on purpose. warmup-vs-steady is derived from account age
 * on every read, and the two postures an operator really owns have their own
 * routes -- a kill switch buried in a settings PUT is a kill switch nobody
 * finds. `strict()` so a UI that thinks it can send one gets told.
 */
const linkedinSeatKeySchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/**
 * The four ceilings an operator may set for themselves, and the range each may
 * sit in.
 *
 * ONE TABLE, WITH THE ZOD FIELDS BUILT FROM IT, for the same reason
 * `linkedinPacedKind` is derived from `PACED_KIND_VALUES` rather than
 * hand-copied: a range the API validates against and a range the UI renders a
 * control from must be the same range, and two hand-written copies of four
 * numbers are two copies that eventually disagree. The maxima are migration
 * 045's CHECK constraints (`linkedin_seats_*_limit_check`) and the defaults are
 * that migration's column DEFAULTs, which `upsertSeat` falls back to for a seat
 * that has never set one.
 *
 * THESE ARE THE OPERATOR'S NUMBERS, NOT THE SAFETY BANDS. `LINKEDIN_LIMITS` is
 * what was researched and it is stricter in every posture that matters; which
 * of the two binds is `safetyBandOverride`, and it is off until somebody says
 * otherwise.
 */
const LINKEDIN_OPERATOR_RANGES = {
  invite: { min: 0, max: 75, default: 30 },
  message: { min: 0, max: 75, default: 25 },
  profileView: { min: 0, max: 100, default: 25 },
  follow: { min: 0, max: 50, default: 20 }
} as const;

type LinkedInOperatorLimit = keyof typeof LINKEDIN_OPERATOR_RANGES;

function operatorLimitField(limit: LinkedInOperatorLimit) {
  const range = LINKEDIN_OPERATOR_RANGES[limit];
  return z.number().int().min(range.min).max(range.max).optional();
}

const linkedinSeatSchema = z.object({
  seatKey: linkedinSeatKeySchema.optional(),
  label: z.string().trim().min(1).max(120).optional(),
  profileUrl: z.string().trim().max(500).nullable().optional(),
  accountOpenedOn: z.string().trim().max(20).nullable().optional(),
  connectionsCount: z.number().int().min(0).max(100_000).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  workStartMinute: z.number().int().min(0).max(1439).optional(),
  workEndMinute: z.number().int().min(1).max(1440).optional(),
  dailyInviteLimit: operatorLimitField('invite'),
  dailyMessageLimit: operatorLimitField('message'),
  dailyProfileViewLimit: operatorLimitField('profileView'),
  dailyFollowLimit: operatorLimitField('follow'),
  /**
   * The operator's informed opt-in: their own configured ceiling binds instead
   * of Trevra's stricter researched band.
   *
   * IT IS NOT A WAY PAST THE RAMP. Warm-up still multiplies whatever ceiling
   * ends up applying, so a week-1 seat with this on is still a week-1 seat --
   * this decides WHICH ceiling is ramped, never whether one is. Seat-scoped
   * like every other field here, because it is one human's decision about one
   * LinkedIn account and not a workspace policy.
   */
  safetyBandOverride: z.boolean().optional(),
  /**
   * This account's own outbound proxy, `scheme://user:pass@host:port`.
   *
   * Absent leaves whatever is stored alone; null or '' removes it. It is never
   * returned: a seat carries the redacted `proxy` view instead, so this field
   * is write-only from a client's point of view and a password cannot come
   * back down to a browser that will put it in a screenshot.
   */
  proxyUrl: z.string().trim().max(500).nullable().optional()
}).strict();

/**
 * Refuse a proxy the browser launcher could not use, at the moment it is typed.
 *
 * VALIDATED THROUGH THE LAUNCHER'S OWN RESOLVER rather than through a second
 * copy of the rules here. `resolveSeatProxy` is what the worker calls before
 * opening Chromium, and its contract is that a configured-but-unusable proxy
 * STOPS THE SEAT -- it never degrades to a direct connection, because the whole
 * reason to configure one is that this account must not be seen coming from
 * this machine. Storing a value it would reject is therefore storing a seat
 * that silently does no work, so the refusal is moved forward to the write and
 * arrives with the resolver's own sentence about what is wrong with it.
 *
 * A blank env is passed deliberately: this validates THIS string, not whatever
 * the process happens to have set.
 */
function assertSeatProxyUsable(workspaceId: string, seatKey: string, proxyUrl: string | null | undefined): void {
  if (!proxyUrl?.trim()) return;
  try {
    resolveSeatProxy({}, workspaceId, seatKey, proxyUrl);
  } catch (error) {
    throw new LinkedInApiError(error instanceof Error ? error.message : 'That proxy could not be used.', 400);
  }
}

const linkedinManagerSeatCreateSchema = linkedinSeatSchema.extend({
  seatKey: linkedinSeatKeySchema,
  label: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100)
}).strict();

const linkedinLeadListCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sourceKind: z.enum(['csv', 'linkedin_search', 'sales_navigator', 'post_keyword']).default('csv'),
  sourceRef: z.string().trim().max(2000).nullable().optional()
}).strict();

const linkedinLeadFieldMappingSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  company: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  profileUrl: z.string().min(1).optional()
}).strict();

const linkedinLeadContactUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(300),
  email: z.string().trim().max(320).nullable().optional(),
  phone: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().max(120).nullable().optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional()
}).strict();

const linkedinWorkflowWriteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  steps: workflowStepsSchema
}).strict();

const linkedinManagedCampaignCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY),
  leadListId: z.string().trim().min(1).max(120),
  workflowId: z.string().trim().min(1).max(120)
}).strict();

const linkedinManagedAnalyticsSchema = z.object({
  campaignId: z.string().trim().min(1).max(120).optional(),
  seatKey: linkedinSeatKeySchema.optional(),
  sinceDays: z.coerce.number().int().min(1).max(365).optional()
});

const linkedinManualTaskFiltersSchema = z.object({
  seatKey: linkedinSeatKeySchema.optional(),
  status: z.enum(['pending', 'completed', 'cancelled']).optional()
});

/**
 * The detect body, and it is one field.
 *
 * `strict()` and nothing optional: everything else on the seat is READ from
 * the session, so a client that tries to send a profile URL or a connection
 * count here is told rather than quietly believed. The timezone is the only
 * fact the server cannot derive for itself.
 */
const linkedinSeatDetectSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
}).strict();

/**
 * Which LinkedIn account a seat route is about.
 *
 * Absent means the owner seat, everywhere, which is what keeps every existing
 * caller -- and every existing test -- reading exactly as it did when a
 * workspace could only have one account.
 */
const linkedinSeatSelectorSchema = z.object({
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
});

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
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY),
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
  otp: z.string().trim().min(4).max(12).optional(),
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
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
  reason: z.string().trim().min(1).max(500),
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
}).strict();

/**
 * Resuming, with an optional note about why.
 *
 * Not `.strict()`, and for the same reason `linkedinSeatSelectorSchema` is not:
 * this body is merged with the query string, which is a place stray parameters
 * arrive from.
 */
const linkedinResumeSchema = z.object({
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY),
  /** Optional on purpose -- see the route. Recorded in `audit_events`, never on the seat. */
  reason: z.string().trim().min(1).max(500).optional()
});

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
// One field, strict: an edit changes words and nothing else.
const linkedinEditBodySchema = z.object({ body: z.string().min(1).max(8000) }).strict();

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
    sequenceSteps: linkedinSequenceStepsSchema.optional(),
    /**
     * WHICH ACCOUNT THIS CAMPAIGN SENDS FROM, declared rather than assumed.
     *
     * The playbook has always read `input.seatKey` -- it is how pacing and the
     * safety gate know whose ledger and whose ceilings to plan against -- but
     * `passthrough()` let it travel untyped, and the route then filed the
     * campaign row itself with no seat at all, so `createCampaign` fell to
     * `OWNER_SEAT_KEY`. A campaign planned against the second account was
     * therefore STORED as the owner's, which is what made the campaign list
     * unable to honour the account switcher even once it tried to.
     */
    seatKey: linkedinSeatKeySchema.optional()
  }).passthrough()
}).strict();

/** Which account's campaigns to list. Absent means every one in the workspace -- see the route. */
const linkedinCampaignListSchema = z.object({
  seatKey: linkedinSeatKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

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
  templateId: z.string().trim().min(1).max(64).optional(),
  /**
   * THE SAME THREE COPY CONTROLS THE CAMPAIGN PATH HAS, and they were missing
   * here rather than deliberately withheld: `gtm.linkedin-sequence` has taken
   * `tone`, `inviteNote` and `includeInMail` since it was written, the create
   * route passes all three through the playbook, and this `.strict()` schema
   * refused them outright -- so "draft with AI" was quietly the less capable of
   * two drafting paths and the controls beside it did nothing.
   *
   * Absent means the skill's own default (`consultative`, a drafted invite
   * note, no InMail), which is what every draft got before this.
   */
  tone: linkedinSequenceTone.optional(),
  inviteNote: linkedinInviteNoteMode.optional(),
  includeInMail: z.boolean().optional()
}).strict();

/**
 * Editing a sequence on a campaign that already exists.
 *
 * THE STEPS, AND EVERYTHING THE CAMPAIGN WAS CREATED WITH. This took `steps`
 * alone, so an edit could rewrite every word of the copy and not the tone it
 * was drafted in, the action kind it is paced as, the horizon it is spread
 * over or the tool it exports for -- making an edit a strictly narrower act
 * than a create, and leaving the client no choice but to grey those controls
 * out on a bound campaign.
 *
 * ABSENT MEANS UNCHANGED, never reset: the route re-plans through the same
 * `gtm.linkedin-outreach` run and merges these over the input the campaign
 * already carries, so an edit that only touches copy leaves the rest exactly as
 * approved. Every field is the playbook's own, with the playbook's own bounds.
 */
const linkedinSequenceEditSchema = z.object({
  steps: linkedinSequenceStepsSchema,
  tone: linkedinSequenceTone.optional(),
  inviteNote: linkedinInviteNoteMode.optional(),
  includeInMail: z.boolean().optional(),
  kind: linkedinPacedKind.optional(),
  horizonDays: z.number().int().min(1).max(MAX_HORIZON_DAYS).optional(),
  format: linkedinExportFormat.optional()
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
  /**
   * 0 IS "ALL TIME", NOT "NOTHING".
   *
   * The funnel offers 7/30/90/all and `linkedinAnalytics` reads a non-positive
   * window as unbounded, so the floor here is 0 rather than 1 -- `min(1)`
   * turned the "All time" button into a 400 rather than into a lifetime count.
   */
  days: z.coerce.number().int().min(0).max(365).default(30),
  /** Which account's ledger is counted, and whose clock its days are cut on. See the route. */
  seatKey: linkedinSeatKeySchema.optional()
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
  kind: z.enum([...LEAD_SOURCE_KINDS] as [LeadSourceKind, ...LeadSourceKind[]]),
  url: z.string().trim().min(1).max(1000)
}).strict();

const linkedinDailyLeadCapSchema = z.object({
  cap: z.number().int().min(0).max(MAX_DAILY_LEAD_CAP)
}).strict();

const linkedinLeadSourceImportSchema = z.object({
  listId: z.string().trim().min(1).max(120).optional(),
  listName: z.string().trim().min(1).max(200).optional(),
  // `listLeads` clamps to LEAD_READ_LIMIT whatever it is asked for, so a larger
  // number accepted here would be a promise the reader silently breaks.
  limit: z.number().int().min(1).max(LEAD_READ_LIMIT).optional(),
  /**
   * The rows the operator actually ticked.
   *
   * Absent means every lead the walk found, up to `limit`, which is what this
   * route did when there was no selection to respect. A screen that offers
   * checkboxes and then imports the whole page is worse than one that offers
   * none, so the selection travels rather than being thrown away at the button.
   */
  leadIds: z.array(z.string().trim().min(1).max(120)).min(1).max(LEAD_READ_LIMIT).optional()
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
  maxMessages: z.number().int().min(1).max(200).optional(),
  // WHOSE INBOX. Every function behind these routes takes a seat and defaults
  // it to the owner, so a sync or a refresh requested for a SECONDARY account
  // walked the owner's conversations instead -- the same silent default
  // `enqueueReply` and `syncLinkedInThread` each carry a paragraph about. The
  // list route has taken a `seatKey` filter since it was written; these did not
  // accept one at all.
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
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
  plannedFor: z.string().datetime().optional(),
  /** Which account is replying. See `linkedinInboxSyncSchema`. */
  seatKey: linkedinSeatKeySchema.default(OWNER_SEAT_KEY)
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
 * One acceptance-detection pass.
 *
 * `maxChecks` IS CAPPED HARD AND LOW because each unit of it is a real profile
 * view against a real account. The gate refuses anything over the seat's own
 * daily ceiling anyway -- that is the ceiling that matters -- but a route that
 * accepted `maxChecks: 5000` would be inviting an operator to queue a pass that
 * spends the whole day's budget in one press and then discovers the refusal one
 * navigation at a time.
 */
const linkedinAcceptanceDetectSchema = z.object({
  seatKey: z.string().trim().min(1).max(64).optional(),
  maxChecks: z.coerce.number().int().min(1).max(25).optional()
}).strict();

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

/**
 * WHICH OF THE TWO DAILY NUMBERS THE CEILING WAS BUILT FROM.
 *
 * There are always two candidates and a screen that cannot name the winner
 * cannot answer the only question an operator asks here -- "I typed 30, why
 * does it say 18".
 *
 *   band              -- Trevra's researched band. Either the operator was
 *                        never asked for a number for this kind, or theirs was
 *                        the looser of the two and the stricter binds.
 *   operator          -- the seat's own configured number, stricter than the
 *                        band, so it binds.
 *   operator-override -- the seat is opted out of the bands, so the operator's
 *                        number binds whatever it is. The RAMPS STILL APPLY on
 *                        top; an override raises the number they are a
 *                        percentage of.
 */
type LinkedInCeilingSource = 'band' | 'operator' | 'operator-override';

interface LinkedInCeiling {
  kind: PacedKind;
  window: 'day' | 'week' | 'month';
  /** What actually applies right now, after every rule above has been applied. */
  ceiling: number;
  /** The band's own number, before warm-up, throttling and the operator's setting. */
  bandCeiling: number;
  /**
   * DAY ROWS ONLY. The seat's own configured number for this kind, or null
   * where there is no seat or the operator was never asked for one (`like`,
   * `endorse`). For `dm`, `reply` and `inmail` it is ONE POOL over all three:
   * the setting is a statement about the account's total outbound messaging,
   * and `guard.ts` checks it against the count of all three kinds together.
   */
  operatorLimit?: number | null;
  /** DAY ROWS ONLY. Which of the two numbers `ceiling` was built from. */
  ceilingSource?: LinkedInCeilingSource;
  /** Actions of this kind already counted inside the window. */
  used: number;
  remaining: number;
  /** Which rule produced `ceiling`. Same vocabulary planPacing puts in `ceilingsApplied`. */
  boundBy: string;
  /** The same fact in a sentence a founder can read. */
  rule: string;
  /**
   * The provenance of `bandCeiling` -- of the RESEARCH, not of the number that
   * ended up binding. An operator's own setting has no confidence tag and is
   * not given one here: `ceilingSource` says when it is what bound, and
   * dressing a typed-in figure as REPORTED is exactly the laundering the tags
   * exist to prevent.
   */
  confidence: LinkedInLimitConfidence;
  source: string;
}

const LINKEDIN_WINDOW_HOURS = { day: 24, week: 24 * 7, month: 24 * 30 } as const;

/** The three kinds that share ONE operator setting. `guard.ts` counts them together. */
const MESSAGE_POOL_KINDS = ['dm', 'reply', 'inmail'] as const;

/** A ramp that never reaches full is a bug in the ramp; this only stops the walk. */
const CAMPAIGN_RAMP_MAX_DAYS = 60;

/**
 * The campaign-day ramp as fractions of the seat's ceiling, days 1..n.
 *
 * ASKED OF THE FUNCTION THAT APPLIES IT rather than declared here.
 * `campaignWarmupFraction` in managed-campaigns.ts is the one place the step
 * lives; a literal `[0.2, 0.4, ...]` in this file would be a second place that
 * stays right only until somebody changes the first -- which is exactly what
 * the client-side copy of the same arithmetic was.
 */
function campaignWarmupRamp(): number[] {
  const epoch = Date.UTC(2026, 0, 1);
  const startedAt = new Date(epoch).toISOString();
  const fractions: number[] = [];
  for (let day = 0; day < CAMPAIGN_RAMP_MAX_DAYS; day += 1) {
    const fraction = campaignWarmupFraction(startedAt, new Date(epoch + day * 86_400_000));
    fractions.push(fraction);
    if (fraction >= 1) break;
  }
  return fractions;
}

/**
 * Every effective ceiling for this workspace's seat, each carrying the rule
 * that bound it and that rule's confidence tag.
 *
 * Deliberately NOT flattened to bare numbers: "18 invites/day" and "18
 * invites/day because the seat is past its ramp, from practitioner telemetry
 * rather than from LinkedIn" are different claims, and only the second one is
 * true.
 */
async function effectiveLinkedInLimits(db: Db, workspaceId: string, now: Date, seatKey: string = OWNER_SEAT_KEY) {
  const seat = await getSeat(db, workspaceId, seatKey);
  const posture = seat ? effectivePosture(seat, now) : null;
  const warmupWeek = warmupWeekOf(seat?.activatedAt ?? null, now);
  const multiplier = warmupMultiplier(warmupWeek);
  // 'cooldown' and 'paused' both draw from the conservative band: backing off
  // means the warm-up numbers, not the steady ones.
  const band = posture === 'steady' ? 'steady' : 'warmup';
  // The ASKED-FOR account, whether or not it exists yet: an unconfigured second
  // account must report its own zeros, not the first account's numbers.
  const seatRef = { workspaceId, seatKey: seat?.seatKey ?? seatKey };

  const acceptance = await acceptanceRate(db, seatRef, ACCEPTANCE_WINDOW_DAYS, now);
  const throttled = acceptance.rate !== null && acceptance.rate < MIN_ACCEPTANCE_RATE;
  // Fails closed on a workspace with no seat: nobody opted an account in that
  // does not exist.
  const overrideBands = seat?.safetyBandOverride ?? false;

  const limits: LinkedInCeiling[] = [];
  // The band this seat is actually drawing from, kind by kind, so a screen can
  // say "50 InMails a month" without holding its own copy of the table that
  // says 50. Every number here comes off `LINKEDIN_LIMITS` via `bandFor`.
  const bands = {} as Record<PacedKind, LinkedInBand>;
  for (const kind of PACED_KINDS) {
    const bandLimits = bandFor(kind, band);
    bands[kind] = bandLimits;
    const [usedDay, usedWeek, usedMonth] = await Promise.all([
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.day, now),
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.week, now),
      countActionsInWindow(db, seatRef, kind, LINKEDIN_WINDOW_HOURS.month, now)
    ]);

    /**
     * THE CEILING THE PACER AND THE GATE WILL ACTUALLY APPLY, through the same
     * function they call.
     *
     * This read `bandFor()` alone, so it reported 18 invites/day to an operator
     * whose seat said 5 and to an operator who had opted out of the bands at
     * 30 -- a screen quoting a number nothing downstream would honour, which is
     * the one failure a limits report cannot have. `effectiveDailyCeiling`
     * (limits.ts) owns the three-case rule; `pacing.ts` and `guard.ts` call it
     * for the same reason this now does.
     */
    const operatorLimit = seatOperatorLimit(seat, kind);
    const dailyCeiling = effectiveDailyCeiling(bandLimits.perDay, operatorLimit, overrideBands);
    const ceilingSource: LinkedInCeilingSource =
      operatorLimit === null
        ? 'band'
        : overrideBands
          ? 'operator-override'
          : operatorLimit < bandLimits.perDay
            ? 'operator'
            : 'band';

    // PER KIND, because the gate is: passive kinds are not ramped at all (1.4's
    // week 1 is passive-only, so views ARE the warm-up). The flat
    // `warmupMultiplier` here reported zero profile views in week 1 for a seat
    // the gate would have let view all fifteen.
    const kindMultiplier = warmupMultiplierFor(kind, warmupWeek);
    const afterWarmup = Math.floor(dailyCeiling * kindMultiplier);
    // Halves, never zeroes -- a seat cut to zero can never produce the outcomes
    // that would clear the throttle, so "halve it" would become "end it".
    const afterThrottle = throttled
      ? Math.max(afterWarmup > 0 ? 1 : 0, Math.floor(afterWarmup * ACCEPTANCE_THROTTLE_FACTOR))
      : afterWarmup;

    const poolNote = MESSAGE_POOL_KINDS.includes(kind as (typeof MESSAGE_POOL_KINDS)[number])
      ? ' That setting is one pool over DMs, replies and InMails together, not a number for this kind alone.'
      : '';

    let ceiling = afterThrottle;
    let boundBy = ceilingSource === 'band' ? 'band-ceiling' : 'operator-daily-limit';
    let rule =
      ceilingSource === 'operator'
        ? `Your own ceiling for this account is ${operatorLimit} ${kind}(s)/day, stricter than Trevra's ${bandLimits.perDay}/day ${band} band, so yours is the one that binds.${poolNote}`
        : ceilingSource === 'operator-override'
          ? `This account is set to use your own daily limits instead of Trevra's safety bands, so ${operatorLimit} ${kind}(s)/day binds rather than the researched ${bandLimits.perDay}/day.${poolNote} Every ramp and every rolling window still applies on top.`
          : operatorLimit === null
            ? `The ${band} band ceiling for ${kind}: ${bandLimits.perDay}/day.`
            : `You have set ${operatorLimit} ${kind}(s)/day for this account, but Trevra's researched ${band} band is ${bandLimits.perDay}/day and the stricter of the two binds.${poolNote} Turning on "use my own daily limits" for this account makes your number the binding one.`;

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
    } else if (kindMultiplier < 1) {
      boundBy = 'warmup-multiplier';
      // The ramp is a percentage OF the binding ceiling, not of the band, which
      // is what makes an override raise the number it ramps rather than skip
      // the ramp -- and what makes it respect an operator who asked for less.
      rule = `Warm-up week ${warmupWeek} of ${WARMUP_WEEKS}: ${dailyCeiling} ${kind}/day x ${kindMultiplier} = ${ceiling}/day.`;
    } else if (posture === 'cooldown') {
      boundBy = 'cooldown-band';
      rule = `Seat is in cooldown, so the conservative warm-up band applies: ${dailyCeiling} ${kind}/day.`;
    }

    limits.push({
      kind,
      window: 'day',
      ceiling,
      bandCeiling: bandLimits.perDay,
      operatorLimit,
      ceilingSource,
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
      band,
      // Whether this seat's operator has opted their own configured ceilings in
      // ahead of the researched band. Reported, never inferred: a seat nobody
      // opted in is false, including a workspace with no seat at all.
      safetyBandOverride: seat?.safetyBandOverride ?? false
    },
    limits,
    /** Every band figure this seat is paced against, and the only copy of them. */
    bands,
    /**
     * What an operator may set their OWN ceilings to, with the number a seat
     * starts on. The API validates against exactly this table, so a control
     * built from it cannot offer a number the route or the database refuses.
     */
    operatorRanges: LINKEDIN_OPERATOR_RANGES,
    /**
     * The campaign-day ramp, days 1..n, as fractions of the seat's ceiling.
     *
     * COMPUTED FROM `campaignWarmupFraction` RATHER THAN LISTED, so the screen
     * showing the ramp and the runner applying it cannot disagree -- the
     * arithmetic re-implemented client-side was the way they did.
     */
    campaignWarmupFractions: campaignWarmupRamp(),
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
const LINKEDIN_NAME_COLUMNS = ['name', 'fullname', 'displayname', 'contactname'];
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

    /**
     * THE SAME SCRUB THE MANAGED LEAD PATH USES, and it was missing here.
     *
     * This route read its name columns with a bare `.trim()`, so a LinkedIn
     * display name -- which is where these CSVs come from -- arrived intact:
     * `Dr. Maya \u{1F642}` was stored as a FIRST NAME, exported to the file an
     * operator sends from, and rendered verbatim into `Hi {{firstName}}`.
     * `lead-import.ts` has owned the answer to that for the managed path all
     * along (titles, degrees, emoji, flags, keycaps, decoration), and two name
     * pipelines with two different ideas of what a first name is also means the
     * same human imported twice is two different people to the dedupe key.
     *
     * `scrubNameField` FOR A DEDICATED COLUMN, because it is the one that
     * refuses to empty a real name: `Do`, `Ma` and `Ba` are removable titles
     * and they are also surnames, and a header that already said "Last name"
     * settles which. `splitAndScrubName` for a single joined name column, which
     * is the shape a scrape or a contact export usually has.
     */
    const joined = splitAndScrubName(linkedinCsvField(row, LINKEDIN_NAME_COLUMNS));
    const firstName = scrubNameField(linkedinCsvField(row, LINKEDIN_FIRST_COLUMNS)) || joined.firstName;
    const lastName = scrubNameField(linkedinCsvField(row, LINKEDIN_LAST_COLUMNS)) || joined.lastName;

    contacts.push({
      targetRef,
      profileUrl: profileUrl || null,
      firstName: firstName || null,
      lastName: lastName || null,
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
    blockers.push(workerConfig.companionBrowser
      ? 'This hosted worker is missing Playwright, which it needs to attach to the paired computer. Redeploy the server image with Playwright installed.'
      : installPlaywright);
  } else if (!workerConfig.companionBrowser && !headless.canLaunchHeadless && !headed.canLaunchHeaded) {
    // BOTH, NOT JUST HEADLESS. This branch read `!headless.canLaunchHeadless`
    // alone, which was a fair proxy for "can this machine open a browser" only
    // while the two verdicts moved together -- chromium present meant headless
    // possible meant a browser possible. `TREVRA_LINKEDIN_HEADLESS=false`
    // separated them, and a worker that drives a REAL headed Chrome on an Xvfb
    // display was reported to the operator as unable to open a browser at all,
    // over the sentence explaining that it declines to open an INVISIBLE one.
    // Both readiness answers are already in `browser` above; this is the one
    // place that has to consider them together.
    blockers.push(...headless.reasons);
  }
  // A HEADED BROWSER IS A BROWSER, and it is the better of the two: headless
  // Chrome reports SwiftShader as its WebGL renderer even on a machine with a
  // GPU, and puts "HeadlessChrome" in its own user agent (measured; see
  // `scripts/linkedin-fingerprint-probe.mjs`). Ranking it as "not ready" had
  // the screen recommending the worse path.
  const ready = enabled && playwrightInstalled && (Boolean(workerConfig.companionBrowser) || browser.canLaunchHeaded || browser.canLaunchHeadless);

  return {
    enabled,
    /**
     * WHICH KIND OF OFF THIS DEPLOYMENT IS, as a fact rather than as prose.
     *
     * The same `hosted` the server refuses credential custody on and the same
     * one `linkedInOffReason` writes its sentence from, now carried
     * structurally: hosted is a decision about who the automation operator is
     * under LinkedIn's User Agreement 8.2, and no environment variable can undo
     * it, while every other kind of off is a switch somebody can find. A client
     * that has to tell those apart was reading `blockers` with a regular
     * expression -- so an edit to a sentence changed what the screen claimed
     * about the deployment, and printed an `npx playwright install` line to
     * somebody who has no machine to run it on. A boolean cannot be reworded.
     *
     * True as well when the environment could not be validated at all: the
     * fail-closed default above is off AND hosted, the pair that promises
     * nothing.
     */
    hosted: workerConfig.hosted,
    companionBrowser: Boolean(workerConfig.companionBrowser),
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
