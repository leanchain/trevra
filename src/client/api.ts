import type {
  AgentBudget,
  AgentPrincipal,
  OpportunityRecord,
  OpportunityStage,
  OpportunityOwnerType,
  AgentCliConfig,
  AgentCliSetup,
  AgentKeySummary,
  AgentModelConfig,
  AgentRun,
  AgentRunSummary,
  AgentSchedule,
  AgentScope,
  AgentSetup,
  AgentTokenSummary,
  AvailableIntegration,
  ConnectionSummary,
  DashboardPayload,
  PlaybookRun,
  PlaybookRunStatus,
  SkillRun,
  WorkspacePolicy
} from '../shared/types';
/**
 * LinkedIn (docs/linkedin-outreach-plan.md sections 5 and 6).
 *
 * TYPE-ONLY, and that is load-bearing twice. `import type` is erased before
 * the bundler sees it, so nothing under src/server/ -- zod, pg, the Playwright
 * driver -- can reach the browser build through these lines. And reading the
 * shapes from the modules that own them is what stops the screen drifting from
 * the ledger: a field renamed in linkedin/actions.ts fails the typecheck here
 * instead of rendering `undefined` beside a number an operator is betting a
 * LinkedIn account on.
 */
import type {
  LedgerExportFile,
  LedgerExportRecord,
  LedgerExportSection
} from '../server/ledger-export';
import type {
  LoopCost,
  LoopCostActionCount,
  LoopCostAgentRuns,
  LoopCostConfidence,
  LoopCostModelLine,
  LoopCostProduced,
  LoopCostSent,
  LoopCostSpent
} from '../server/loop-cost';
import type { PublicSkillManifest } from '../server/skill-api';
import type { TodayPayload } from '../server/today';
import type { PreparedOutreachResult } from '../server/outreach/prepare';
import type { GtmIntent, GtmPlan, PreparedGtmPlanResult } from '../server/gtm/intent';
import type { ConversationMessage, ConversationSummary } from '../server/conversations';
import type { LinkedInActionKind, LinkedInActionStatus } from '../server/linkedin/actions';
import type { LinkedInPost, LinkedInPostStatus } from '../server/linkedin/posts';
import type { PostBlock } from '../shared/linkedin-post-format';
import type { BranchOn, StepCondition } from '../server/linkedin/branching';
import type { LinkedInSafetyCheck, LinkedInSafetyVerdict } from '../server/linkedin/guard';
import type {
  LinkedInConversation,
  LinkedInMessageRecord,
  LinkedInThreadRecord
} from '../server/linkedin/inbox';
import type {
  LeadSourceKind,
  LeadSourceStatus,
  LinkedInLead,
  LinkedInLeadSource
} from '../server/linkedin/leads';
import type {
  LinkedInLeadContact,
  LinkedInLeadList,
  LeadListSourceKind
} from '../server/linkedin/lead-lists';
import type { LinkedInWorkflow, WorkflowStep } from '../server/linkedin/workflows';
import type {
  CampaignLaunchPreview,
  CampaignMemberTimeline,
  CampaignOperationalAnalytics,
  CampaignQueueSummary,
  ManagedAnalytics,
  ManagedCampaign,
  ManagedCampaignMember,
  ManagedCampaignWave,
  ManualTaskView
} from '../server/linkedin/managed-campaigns';
import type { LinkedInCampaignExecution } from '../server/linkedin/execution-state';
import type {
  Account,
  AccountImportResult,
  AccountScore,
  AccountSignal,
  AccountSignalKind,
  AccountSource,
  AccountStatus,
  AccountTier,
  RankedAccount,
  ScoreComponent,
  ScoreRationale
} from '../server/accounts/types';
import type {
  WithdrawalCandidate,
  WithdrawalRecord,
  WithdrawalStatus
} from '../server/linkedin/withdraw';
import type {
  CampaignStatus,
  LinkedInActionView,
  LinkedInAnalytics
} from '../server/linkedin/action-ledger';
import type { LinkedInExclusion } from '../server/linkedin/exclusions';
import type { BandName, LinkedInBand, PacedKind } from '../server/linkedin/limits';
import type { ExecutableKind, SeatDetectRequest } from '../server/linkedin/local-worker';
import type { PacingPlan } from '../server/linkedin/pacing';
import type { LinkedInSeat, SeatPatch, SeatPosture } from '../server/linkedin/seats';
import type {
  LinkedInIcp,
  LinkedInOffer,
  LinkedInSequence,
  SequenceTone
} from '../server/linkedin/sequence';

/**
 * `ExportFormat` is declared locally rather than imported: the
 * sequence-builder campaign routes (`campaigns.ts`, `export.ts`, `queue.ts`)
 * that used to own this shape are gone, and every function that only served
 * those routes is gone with them (deleted in the outreach simplification
 * plan). This one survives because it is still live -- the Safety screen's
 * export-format vocabulary -- so it is copied verbatim rather than
 * reintroducing the deleted modules.
 */
type ExportFormat = 'dripify' | 'heyreach' | 'expandi' | 'generic';
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include'
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? 'Request failed', response.status);
  }
  // 204 No Content has no body to parse -- watches' DELETE is the only route
  // that returns it today, and every other caller of `request` always gets a
  // 200 with a JSON body, so this branch changes nothing for them.
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function getPublicConfig(): Promise<PublicConfig> {
  return request('/api/public-config');
}

export async function ensureSession(): Promise<void> {
  await request('/api/auth/session');
}

export async function startDemoSession(): Promise<void> {
  await request('/api/auth/demo', { method: 'POST' });
}

export async function endDemoSession(): Promise<void> {
  await request('/api/auth/demo/logout', { method: 'POST' });
}

export async function getDashboard(): Promise<DashboardPayload> {
  return request('/api/dashboard');
}

export async function getToday(): Promise<TodayPayload> {
  return request('/api/today');
}

export async function planGtmIntent(intent: GtmIntent): Promise<GtmPlan> {
  const result = await request<{ plan: GtmPlan }>('/api/gtm/plan', {
    method: 'POST',
    body: JSON.stringify({ intent })
  });
  return result.plan;
}

export async function prepareCompiledGtmPlan(
  plan: GtmPlan,
  idempotencyKey: string
): Promise<PreparedGtmPlanResult> {
  return request('/api/gtm/prepare', {
    method: 'POST',
    body: JSON.stringify({ plan, planHash: plan.planHash, idempotencyKey })
  });
}

export async function getConversations(limit = 100): Promise<ConversationSummary[]> {
  const result = await request<{ conversations: ConversationSummary[] }>(
    `/api/conversations?limit=${encodeURIComponent(String(limit))}`
  );
  return result.conversations;
}

export async function getConversationMessages(
  conversationId: string,
  limit = 200
): Promise<ConversationMessage[]> {
  const result = await request<{ messages: ConversationMessage[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${encodeURIComponent(String(limit))}`
  );
  return result.messages;
}

export async function prepareConversationEmailReply(
  conversationId: string,
  input: { idempotencyKey: string; subject: string; body: string }
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/replies/prepare`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return result.run;
}

export async function getOpportunities(stage?: OpportunityStage): Promise<OpportunityRecord[]> {
  const query = stage ? `?stage=${encodeURIComponent(stage)}` : '';
  const result = await request<{ opportunities: OpportunityRecord[] }>(
    `/api/opportunities${query}`
  );
  return result.opportunities;
}

export async function createOpportunity(input: {
  personId?: string | null;
  accountId?: string | null;
  title: string;
  stage?: OpportunityStage;
  ownerType?: OpportunityOwnerType | null;
  ownerId?: string | null;
  nextAction?: string | null;
  nextActionAt?: string | null;
}): Promise<OpportunityRecord> {
  const result = await request<{ opportunity: OpportunityRecord }>('/api/opportunities', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.opportunity;
}

export async function updateOpportunity(
  id: string,
  input: Partial<{
    personId: string | null;
    accountId: string | null;
    title: string;
    stage: OpportunityStage;
    ownerType: OpportunityOwnerType | null;
    ownerId: string | null;
    nextAction: string | null;
    nextActionAt: string | null;
  }>
): Promise<OpportunityRecord> {
  const result = await request<{ opportunity: OpportunityRecord }>(
    `/api/opportunities/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
  return result.opportunity;
}

export async function prepareOutreach(input: {
  idempotencyKey: string;
  name?: string;
  senderKey?: string;
  existingLeadListId?: string;
  uploadedPeopleCsv?: string;
}): Promise<PreparedOutreachResult> {
  return request('/api/outreach/prepare', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}
/**
 * Team workspace access (docs/superpowers/specs/2026-08-13-team-workspace-
 * access-design.md -- decision #3 superseded: no email joins instantly
 * anymore, existing Trevra account or not, see the doc comment on this
 * route in app.ts). The one bespoke team-management call: everything else
 * (list workspaces, list members, remove a member, list/accept/cancel
 * invitations, switch the active workspace) rides better-auth's own
 * auto-mounted `/api/auth/organization/*` routes through `authClient.
 * organization.*` (src/client/auth-client.ts) -- NOT this file's `request`
 * wrapper, and NOT declared here. This one route exists because `organization.
 * createInvitation` is server-only in better-auth's own plugin (see
 * auth-client.ts's comment) and needs this request's own session as the
 * inviter -- there is no client-callable equivalent. Owner-only; the server
 * 403s a member and this simply surfaces that ApiError like every other
 * gated call.
 */
interface TeamMemberInvited {
  status: 'invited';
  /** better-auth's own created `invitation` row. No email is sent unless the deployment configured one -- see the Team screen's copyable link. */
  invitation: {
    id: string;
    email: string;
    role: string;
    organizationId: string;
    status: string;
    expiresAt: string;
  };
}

export async function addTeamMember(input: {
  email: string;
  role?: 'owner' | 'member';
}): Promise<TeamMemberInvited> {
  return request('/api/team/members', { method: 'POST', body: JSON.stringify(input) });
}

export async function getIntegrations(): Promise<{
  connections: ConnectionSummary[];
  available: AvailableIntegration[];
  configured: boolean;
}> {
  return request('/api/integrations');
}

export async function createConnectSession(
  allowedIntegrations: string[]
): Promise<{ token: string; expires_at?: string; connect_link?: string; browser_host?: string }> {
  const result = await request<{
    session: { token: string; expires_at?: string; connect_link?: string; browser_host?: string };
  }>('/api/integrations/connect-session', {
    method: 'POST',
    body: JSON.stringify({ allowedIntegrations })
  });
  return result.session;
}

export async function disconnectIntegration(id: string): Promise<void> {
  await request(`/api/integrations/${id}`, { method: 'DELETE' });
}

export async function startPlaybook(
  id: string,
  input: unknown,
  version?: string
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/playbooks/${encodeURIComponent(id)}/runs`,
    {
      method: 'POST',
      body: JSON.stringify({ input: input ?? {}, ...(version ? { version } : {}) })
    }
  );
  return result.run;
}

export async function getPlaybookRuns(
  filters: { status?: PlaybookRunStatus; limit?: number } = {}
): Promise<PlaybookRun[]> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ runs: PlaybookRun[] }>(
    `/api/playbook-runs${query.size ? `?${query}` : ''}`
  );
  return result.runs;
}

export async function getPlaybookRun(id: string): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/playbook-runs/${encodeURIComponent(id)}`
  );
  return result.run;
}

export async function updatePlaybookApprovalBody(
  runId: string,
  stepId: string,
  body: string
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/playbook-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/approval-body`,
    { method: 'PATCH', body: JSON.stringify({ body }) }
  );
  return result.run;
}

export async function decidePlaybookStep(
  runId: string,
  stepId: string,
  decision: 'approve' | 'reject',
  comment?: string
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/playbook-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/decision`,
    { method: 'POST', body: JSON.stringify({ decision, comment }) }
  );
  return result.run;
}

/**
 * Every run of one skill. The route has existed since the skills registry
 * shipped and no client had ever called it, so a module's own history was
 * visible nowhere in the product.
 */
export async function getSkillRuns(
  filters: {
    skillId?: string;
    status?: 'ok' | 'error';
    limit?: number;
  } = {}
): Promise<SkillRun[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query}` : '';
  const result = await request<{ runs?: SkillRun[] }>(`/api/skill-runs${suffix}`);
  return result.runs ?? [];
}

/** One step of a job, on its own. Reached from the step that ran it. */
export async function getSkillRun(id: string): Promise<SkillRun> {
  const result = await request<{ run: SkillRun }>(`/api/skill-runs/${encodeURIComponent(id)}`);
  return result.run;
}

/** One row `gtm.scout-threads` discovered, plus what /research needs to judge it. */
export interface OutreachThreadRow {
  id: string;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  num_comments: number;
  thread_created_at: string | null;
  first_seen_at: string;
  metadata_json: Record<string, unknown>;
}

export interface FeedThread {
  row: OutreachThreadRow;
  relevance: {
    score: number;
    components: Array<{ label: string; points: number }>;
    highValueMatches: string[];
    mediumMatches: string[];
    negativeMatches: string[];
  };
  topics: string[];
  angle: 'technical_deepdive' | 'cost_comparison' | 'alternative_suggestion' | 'minimal_mention';
  guard: { allowed: boolean; reason: string | null; failedChecks: string[] };
}

export async function getOutreachThreads(
  filters: { platform?: string; limit?: number } = {}
): Promise<FeedThread[]> {
  const query = new URLSearchParams();
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ threads?: FeedThread[] }>(
    `/api/outreach/threads${query.size ? `?${query}` : ''}`
  );
  return result.threads ?? [];
}

/** The offer a drafted reply opens with -- name, url, summary, mechanism, and its proof claims. */
export interface OutreachOffer {
  name: string;
  url: string;
  summary: string;
  mechanism: string;
  claims: Array<{ label: string; value: string }>;
}

/** Prefills the draft-reply dialog from the newest campaign brief; blank fields when there is none. */
export async function getOutreachOfferDefaults(): Promise<OutreachOffer> {
  const result = await request<{ offer: OutreachOffer }>('/api/outreach/offer-defaults');
  return result.offer;
}

export interface BrandWatch {
  id: string;
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
  enabled: boolean;
  limitPerPlatform: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface BrandWatchMention {
  id: string;
  watchId: string;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  matchedKeywords: string[];
  sentimentLabel: 'positive' | 'neutral' | 'negative';
  sentimentScore: number;
  sentimentSpan: string;
  metadata: Record<string, unknown>;
  mentionCreatedAt: string | null;
  firstSeenAt: string;
  promotedRunId: string | null;
}

export interface WatchTrendPoint {
  day: string;
  positive: number;
  neutral: number;
  negative: number;
  average: number;
}

export async function getWatches(): Promise<BrandWatch[]> {
  const result = await request<{ watches?: BrandWatch[] }>('/api/watches');
  return result.watches ?? [];
}

export async function createWatch(input: {
  name: string;
  keywords: string[];
  platforms: string[];
  cadence: 'daily' | 'weekly';
}): Promise<BrandWatch> {
  const result = await request<{ watch: BrandWatch }>('/api/watches', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.watch;
}

export async function updateWatch(
  id: string,
  patch: Partial<{
    name: string;
    keywords: string[];
    platforms: string[];
    cadence: 'daily' | 'weekly';
    enabled: boolean;
  }>
): Promise<BrandWatch> {
  const result = await request<{ watch: BrandWatch }>(`/api/watches/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return result.watch;
}

export async function deleteWatch(id: string): Promise<void> {
  await request(`/api/watches/${id}`, { method: 'DELETE' });
}

/** Mirrors `WatchPlatformReport` from `src/server/watch/skill.ts`, trimmed to the fields the UI reads. */
export interface WatchPlatformReport {
  platform: string;
  availability: {
    mode: 'ready' | 'needs-credential' | 'disabled';
    reason: string;
    docsUrl?: string;
  };
}

export async function runWatch(
  id: string
): Promise<{
  inserted: number;
  updated: number;
  reports: WatchPlatformReport[];
  warnings: string[];
}> {
  return request(`/api/watches/${id}/run`, { method: 'POST', body: '{}' });
}

export async function getWatchMentions(
  id: string,
  filters: { sentiment?: string; platform?: string; limit?: number } = {}
): Promise<BrandWatchMention[]> {
  const query = new URLSearchParams();
  if (filters.sentiment) query.set('sentiment', filters.sentiment);
  if (filters.platform) query.set('platform', filters.platform);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ mentions?: BrandWatchMention[] }>(
    `/api/watches/${id}/mentions${query.size ? `?${query}` : ''}`
  );
  return result.mentions ?? [];
}

export async function getWatchTrend(id: string, days = 30): Promise<WatchTrendPoint[]> {
  const result = await request<{ points?: WatchTrendPoint[] }>(
    `/api/watches/${id}/trend?days=${days}`
  );
  return result.points ?? [];
}

export async function draftMentionReply(
  watchId: string,
  mentionId: string,
  product: OutreachOffer
): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(
    `/api/watches/${watchId}/mentions/${mentionId}/reply`,
    { method: 'POST', body: JSON.stringify({ product }) }
  );
  return result.run;
}

/**
 * What Trevra's own agent did, if this deployment runs one.
 *
 * A workspace on a build without the hosted agent has no such endpoint, so a
 * 404 is read as "no runs" rather than surfaced as a failure: the difference
 * between "nothing happened" and "this feature is not here" is not one a
 * founder should have to interpret from an error.
 */
export async function getAgentRuns(limit = 50): Promise<AgentRunSummary[]> {
  try {
    const result = await request<{ runs: AgentRunSummary[] }>(`/api/agent-runs?limit=${limit}`);
    return result.runs ?? [];
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

export async function getAgentRun(id: string): Promise<AgentRun | null> {
  try {
    const result = await request<{ run: AgentRun }>(`/api/agent-runs/${encodeURIComponent(id)}`);
    return result.run ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Setup for Trevra's own agent: the endpoint, the key, the spend cap, the
 * schedule.
 *
 * A build without the hosted agent has no such route, so a 404 is read as
 * "this deployment does not run one" and the screen hides the section --
 * the same call getAgentRuns makes, for the same reason.
 */
export async function getAgentSetup(): Promise<AgentSetup | null> {
  try {
    return await request<AgentSetup>('/api/agent-setup');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** No default endpoint ships, so this is always the operator's own words. */
export async function saveAgentModelConfig(input: {
  baseUrl: string;
  model: string;
  label?: string;
}): Promise<AgentModelConfig> {
  const result = await request<{ config: AgentModelConfig }>('/api/agent-setup/config', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return result.config;
}

/**
 * Write-only. What comes back is `last4`, a label and timestamps -- never the
 * key. There is no companion read function here because there is no route to
 * call: plaintext leaves exactly one internal function on the server, at the
 * moment of a model request, and no API returns it at any privilege.
 */
export async function saveAgentKey(input: {
  apiKey: string;
  label?: string;
}): Promise<AgentKeySummary> {
  const result = await request<{ secret: AgentKeySummary }>('/api/agent-setup/key', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return result.secret;
}

export async function deleteAgentKey(): Promise<void> {
  await request('/api/agent-setup/key', { method: 'DELETE' });
}

export async function saveAgentBudget(input: {
  monthlyCapCents?: number;
  enabled?: boolean;
}): Promise<AgentBudget> {
  const result = await request<{ budget: AgentBudget }>('/api/agent-setup/budget', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return result.budget;
}

export async function saveAgentSchedule(input: {
  enabled?: boolean;
  goal?: string;
  intervalMinutes?: number;
  agentId?: string;
}): Promise<AgentSchedule> {
  const result = await request<{ schedule: AgentSchedule }>('/api/agent-setup/schedule', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return result.schedule;
}

/**
 * The third way to run the hosted agent: a workspace's own Claude/Codex
 * subscription (docs/cli-agent-and-hosted.md). Mirrors the BYOK functions
 * above in the same discipline -- the token is write-only, and there is no
 * companion read function because there is no route that returns one.
 */
export async function saveAgentCliConfig(input: {
  cli: 'claude' | 'codex';
  model: string;
}): Promise<AgentCliConfig> {
  const result = await request<{ config: AgentCliConfig }>('/api/agent-setup/cli-config', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return result.config;
}

export async function saveAgentCliToken(input: { token: string }): Promise<void> {
  await request('/api/agent-setup/cli-token', { method: 'PUT', body: JSON.stringify(input) });
}

export async function deleteAgentCliToken(): Promise<void> {
  await request('/api/agent-setup/cli-token', { method: 'DELETE' });
}

/** Its own immediate-effect call, like {@link saveAgentBudget}'s `enabled` flip -- see the server-side doc comment on `setWorkspaceCliRiskAccepted`. */
export async function setAgentCliRiskAccepted(
  accepted: boolean
): Promise<AgentCliSetup['riskAccepted']> {
  const result = await request<{ riskAccepted: boolean }>('/api/agent-setup/cli-risk-accept', {
    method: 'PUT',
    body: JSON.stringify({ accepted })
  });
  return result.riskAccepted;
}

export async function startAgentRun(input: {
  agentId?: string;
  goal: string;
  maxSteps?: number;
}): Promise<AgentRunSummary> {
  const result = await request<{ run: AgentRunSummary }>('/api/agent-runs', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.run;
}

/**
 * Ask one agent run to stop, saying why, and return how many runs were asked.
 *
 * It is a REQUEST, not a kill, and the UI must say so. The server records the
 * request; the run itself ends at its next step boundary, once it has finished
 * whatever it is in the middle of. Nothing here may report it as stopped --
 * that only becomes true when the run's own status says so.
 *
 * A zero back is not a failure: it means that run was not running, or had
 * already been asked. A second click never overwrites the first note.
 *
 * `reason` is optional and is never sent as a placeholder. It is the note you
 * will read three weeks from now -- the same argument the outreach kill switch
 * has made since it shipped, which was never LinkedIn-specific.
 */
export async function stopAgentRun(runId: string, reason?: string): Promise<number> {
  const result = await request<{ stopped: number }>('/api/agent-runs/stop', {
    method: 'POST',
    body: JSON.stringify({ runId, ...(reason && reason.trim() ? { reason } : {}) })
  });
  return result.stopped ?? 0;
}

export async function getPolicies(): Promise<WorkspacePolicy[]> {
  const result = await request<{ policies: WorkspacePolicy[] }>('/api/policies');
  return result.policies;
}

export async function createPolicy(input: {
  name: string;
  priority?: number;
  actionPattern: string;
  effect: WorkspacePolicy['effect'];
  conditions?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<WorkspacePolicy[]> {
  const result = await request<{ policies: WorkspacePolicy[] }>('/api/policies', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.policies;
}

export async function deletePolicy(id: string): Promise<void> {
  await request(`/api/policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function updatePolicy(
  id: string,
  input: Partial<{
    name: string;
    priority: number;
    actionPattern: string;
    effect: WorkspacePolicy['effect'];
    conditions: Record<string, unknown>;
    enabled: boolean;
  }>
): Promise<WorkspacePolicy[]> {
  const result = await request<{ policies: WorkspacePolicy[] }>(
    `/api/policies/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
  return result.policies;
}

// Not exported: nothing outside this file names the type, only the function.
interface PublicConfig {
  googleAuthEnabled: boolean;
  magicLinkAuthEnabled: boolean;
  emailPasswordAuthEnabled: boolean;
  modelExtractionEnabled: boolean;
  supportEmail: string;
  catalogApiUrl: string;
  apiBaseUrl?: string;
}

export type WorkspaceSkillManifest = PublicSkillManifest;

export async function getWorkspaceSkills(): Promise<WorkspaceSkillManifest[]> {
  const result = await request<{ skills: WorkspaceSkillManifest[] }>('/api/skills');
  return result.skills;
}

export async function getAgents(): Promise<AgentPrincipal[]> {
  const result = await request<{ agents: AgentPrincipal[] }>('/api/agents');
  return result.agents;
}

export async function createAgent(input: {
  name: string;
  purpose: string;
  instructions?: string;
  skillIds?: string[];
}): Promise<AgentPrincipal> {
  const result = await request<{ agent: AgentPrincipal }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.agent;
}

export async function updateAgent(
  id: string,
  input: Partial<{
    name: string;
    purpose: string;
    instructions: string;
    skillIds: string[];
    status: AgentPrincipal['status'];
  }>
): Promise<AgentPrincipal> {
  const result = await request<{ agent: AgentPrincipal }>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
  return result.agent;
}

export async function getAgentTokens(): Promise<AgentTokenSummary[]> {
  const result = await request<{ tokens: AgentTokenSummary[] }>('/api/agent-tokens');
  return result.tokens;
}

export async function createAgentToken(input: {
  agentId?: string;
  name: string;
  scopes?: AgentScope[];
  expiresAt?: string | null;
}): Promise<{ token: string; record: AgentTokenSummary }> {
  return request('/api/agent-tokens', { method: 'POST', body: JSON.stringify(input) });
}

export async function revokeAgentToken(id: string): Promise<void> {
  await request(`/api/agent-tokens/${id}`, { method: 'DELETE' });
}

/* =====================================================================
 * The ledger, and the one combined spend surface.
 * docs/gtm-shell-shape.md sections 3.4, 3.5 and 3.7 (Wave B).
 * ================================================================== */

/**
 * Re-exported from the modules that own the shapes, exactly like the LinkedIn
 * types below and for the same reason: a field renamed on the server fails the
 * typecheck here instead of rendering `undefined` beside a number somebody is
 * making a spending decision on.
 */
export type {
  LedgerExportFile,
  LedgerExportRecord,
  LedgerExportSection,
  LoopCost,
  LoopCostActionCount,
  LoopCostAgentRuns,
  LoopCostConfidence,
  LoopCostModelLine,
  LoopCostProduced,
  LoopCostSent,
  LoopCostSpent
};

/**
 * The sections an export may carry, as values.
 *
 * Restated rather than imported because `ledger-export.ts` pulls `node:crypto`
 * and `node:zlib`, and importing the value would drag both into the browser
 * bundle. The `readonly LedgerExportSection[]` annotation is the guard: a
 * section added on the server breaks this line at typecheck rather than
 * silently leaving a checkbox missing from the export panel.
 */
export const LEDGER_EXPORT_SECTIONS: readonly LedgerExportSection[] = [
  'runs',
  'steps',
  'evidence',
  'approvals',
  'actions'
];

/**
 * Render an export and get back what is in it.
 *
 * `counts` is rows per SOURCE TABLE; `sha256` is the digest of each FILE in the
 * archive, keyed by file name, exactly as `manifest.json` inside the archive
 * publishes them. Show them: the hash is the same promise `SignedNote` makes
 * about an approval, and a hash nobody is shown proves nothing to anybody.
 *
 * The bytes are stored server-side and never re-rendered, so the id this
 * returns keeps naming the same file the hashes describe.
 */
export async function createLedgerExport(input: { window: number; include: string[] }): Promise<{
  id: string;
  counts: Record<string, number>;
  sha256: Record<string, string>;
}> {
  return request('/api/ledger/exports', { method: 'POST', body: JSON.stringify(input) });
}

/** Every export this workspace has rendered, newest first. Metadata only -- no bytes. */
export async function getLedgerExports(): Promise<LedgerExportRecord[]> {
  const result = await request<{ exports: LedgerExportRecord[] }>('/api/ledger/exports');
  return result.exports;
}

/**
 * The download URL. A plain href, not a fetch: the response is an attachment
 * with `Cache-Control: no-store`, and letting the browser handle it keeps the
 * archive out of JS memory and out of any cache.
 */
export function ledgerExportDownloadPath(id: string): string {
  return `/api/ledger/exports/${encodeURIComponent(id)}`;
}

/**
 * EVERYTHING this workspace holds, as one file.
 *
 * NOT the ledger export above, and the difference is worth putting in the UI
 * copy: that one is ten run-and-action tables -- the evidence pack for a client
 * -- and this one is the data-subject export the privacy policy promises,
 * covering People, messages, deliveries, leads, lead lists, campaigns, inbox
 * threads, seats, accounts, audit events and settings. Sealed credentials are
 * named in the file's `withheld` list and never included.
 *
 * A plain href for the same reason the ledger download is: an attachment with
 * `Cache-Control: no-store`, kept out of JS memory and out of any cache.
 * Owner-only.
 */
export function workspaceExportDownloadPath(): string {
  return '/api/workspace/export';
}

/** One entry per table that actually holds rows. */
export interface WorkspaceErasurePreview {
  workspace: { id: string; name: string };
  /** The DELETE refuses anything else -- label the confirm box with it. */
  confirmationPhrase: string;
  inventory: Array<{ table: string; rows: number }>;
  totalRows: number;
  /** Reasons the erasure would be refused right now, each naming what to stop. */
  inFlight: string[];
  erasable: boolean;
  reversible: false;
}

/**
 * What erasure would remove, BEFORE anything is removed.
 *
 * Show this first, always. A destructive call nobody can preview is a
 * destructive call nobody can consent to, and `inFlight` is the list of things
 * the operator has to go and stop before the delete will proceed at all.
 */
export async function previewWorkspaceErasure(): Promise<WorkspaceErasurePreview> {
  return request('/api/workspace/erasure');
}

/**
 * Erase the workspace. Irreversible, and the server means it.
 *
 * `confirm` must be the workspace's own name, exactly -- a boolean is a
 * checkbox a script ticks, and retyping the name is the smallest gesture that
 * proves a human read the screen. 400 if it does not match, 409 if work is
 * still in flight, and neither deletes anything. On success the session cookie
 * is cleared server-side, so the client should route to signed-out rather than
 * refetching.
 */
export async function eraseWorkspace(confirm: string): Promise<{
  erased: true;
  workspaceId: string;
  workspaceName: string;
  removed: Record<string, number>;
  organizationRemoved: boolean;
}> {
  return request('/api/workspace', { method: 'DELETE', body: JSON.stringify({ confirm }) });
}

/**
 * Spent, sent and produced for one period.
 *
 * TWO THINGS THE SCREEN MUST NOT SOFTEN.
 *
 * Every line in `spent.byModel` carries its own `confidence`. HARD FACT means
 * the provider measured that call; REPORTED means Trevra estimated it from a
 * list-price table. Render the flag on the line, never once at the top.
 *
 * `produced.attribution` is a sentence to print VERBATIM. Nothing joins a model
 * call or an outreach action to an invoice, and the three rows being adjacent
 * must not be allowed to read as one of them causing another.
 */
export async function fetchLoopCost(windowDays: number): Promise<LoopCost> {
  return request(`/api/loop/cost?window=${encodeURIComponent(String(windowDays))}`);
}

/* =====================================================================
 * LinkedIn (docs/linkedin-outreach-plan.md sections 5 and 6).
 *
 * NOTHING HERE SENDS ANYTHING, and the client half of that invariant is worth
 * stating where the fetches live: there is no `send` call below because there
 * is no route to call.
 * ================================================================== */

/** Re-exported so the screens read one vocabulary and never reach into src/server themselves. */
export type {
  BandName,
  BranchOn,
  ConversationMessage,
  ConversationSummary,
  CampaignStatus,
  ExportFormat,
  LeadSourceKind,
  LeadSourceStatus,
  LinkedInActionKind,
  LinkedInActionStatus,
  LinkedInActionView,
  LinkedInAnalytics,
  LinkedInConversation,
  LinkedInExclusion,
  LinkedInIcp,
  LinkedInLead,
  LinkedInLeadSource,
  LinkedInMessageRecord,
  LinkedInOffer,
  LinkedInPost,
  LinkedInPostStatus,
  LinkedInSafetyCheck,
  LinkedInSafetyVerdict,
  LinkedInSeat,
  LinkedInSequence,
  LinkedInThreadRecord,
  PacedKind,
  PacingPlan,
  SeatPosture,
  SequenceTone,
  StepCondition,
  WithdrawalCandidate,
  WithdrawalRecord,
  WithdrawalStatus
};

/**
 * The pacing policy table itself, imported as VALUES.
 *
 * `linkedin/limits.ts` is a dependency-free constants module -- no zod, no pg,
 * no db handle, nothing but numbers and the comments recording where each one
 * came from -- so the bundler inlines it and nothing else follows it in. That
 * is what makes this one client-to-server import worth making: the warm-up ramp
 * the Safety screen draws is the ramp the engine paces by, not a copy of it
 * that drifts the first time somebody tunes a multiplier. Every other server
 * module in this file is type-only.
 */
export {
  MAX_DAY_OVER_DAY_DELTA,
  MIN_RAMP_STEP,
  PACED_KINDS,
  WARMUP_MULTIPLIERS,
  WARMUP_WEEKS
} from '../server/linkedin/limits';

/**
 * HARD FACT -- published by LinkedIn or a contractual term. REPORTED --
 * practitioner telemetry, directionally right and never a guarantee.
 *
 * The server tags every ceiling it returns; the UI's job is to never drop the
 * tag on the way to the screen.
 */
export type LinkedInLimitConfidence = 'HARD FACT' | 'REPORTED';

/**
 * One effective ceiling with its provenance.
 *
 * Declared here rather than imported because `effectiveLinkedInLimits` is a
 * private function inside src/server/app.ts and its return type is not
 * exported. Everything this file CAN import, it imports.
 */
/**
 * WHICH OF THE TWO DAILY NUMBERS THE CEILING WAS BUILT FROM.
 *
 *   band              -- Trevra's researched band: either no operator number
 *                        exists for this kind, or theirs was looser and the
 *                        stricter of the two binds.
 *   operator          -- the account's own configured number, stricter than the
 *                        band, so it binds.
 *   operator-override -- the account is opted out of the bands, so its own
 *                        number binds whatever it is. Both ramps, the rolling
 *                        windows and the variance clamp still apply on top.
 *
 * The screen has to be able to NAME this. "I typed 30 and it says 18" is the
 * only question this report exists to answer.
 */
export type LinkedInCeilingSource = 'band' | 'operator' | 'operator-override';

export interface LinkedInCeiling {
  kind: PacedKind;
  window: 'day' | 'week' | 'month';
  /** What applies right now, after warm-up, throttle, posture and the account's own setting. */
  ceiling: number;
  /** The band's own number, before any of that. */
  bandCeiling: number;
  /**
   * DAY ROWS ONLY. The account's own configured number for this kind, null
   * where none was ever asked for (`like`, `endorse`) or no account exists.
   * For `dm`, `reply` and `inmail` it is ONE POOL over all three kinds.
   */
  operatorLimit?: number | null;
  /** DAY ROWS ONLY. Which number `ceiling` was built from. */
  ceilingSource?: LinkedInCeilingSource;
  used: number;
  remaining: number;
  /** Which rule produced `ceiling`. */
  boundBy: string;
  rule: string;
  /**
   * The provenance of `bandCeiling`, i.e. of the RESEARCH -- never of an
   * operator's own setting, which has no confidence tag and is not given one.
   * `ceilingSource` is what says whether the research is what bound.
   */
  confidence: LinkedInLimitConfidence;
  source: string;
}

interface LinkedInSignalBase {
  rule: string;
  confidence: LinkedInLimitConfidence;
  source: string;
}

/**
 * What an operator may set one of their own daily ceilings to.
 *
 * `default` is what a seat that has never set one runs at. Server-owned: the
 * PUT validates against exactly this range, so a control built from anything
 * else eventually offers a number the route refuses.
 */
interface LinkedInOperatorRange {
  min: number;
  max: number;
  default: number;
}

export interface LinkedInLimitsReport {
  seat: {
    configured: boolean;
    label: string | null;
    timezone: string | null;
    posture: SeatPosture | null;
    pausedReason: string | null;
    warmupWeek: number;
    warmupWeeks: number;
    warmupMultiplier: number;
    band: BandName;
    /**
     * This seat's operator has opted their own configured ceilings in ahead of
     * Trevra's stricter researched band. This says which ceiling applies; the
     * account warm-up is a separate control and may itself be explicitly skipped.
     */
    safetyBandOverride: boolean;
    /** Account-level Trevra warm-up was explicitly skipped by the operator. */
    warmupOverride: boolean;
  };
  limits: LinkedInCeiling[];
  /**
   * The band figures this seat is paced against, per kind. THE ONLY COPY: a
   * screen that wants to say "50 InMails a month" reads it here rather than
   * printing a literal that stops being true when the table moves.
   */
  bands: Record<PacedKind, LinkedInBand>;
  /** The ranges the seat PUT validates a hand-set ceiling against. */
  operatorRanges: {
    invite: LinkedInOperatorRange;
    message: LinkedInOperatorRange;
    profileView: LinkedInOperatorRange;
    follow: LinkedInOperatorRange;
  };
  /**
   * The campaign-day ramp as fractions of the seat's ceiling, days 1..n.
   *
   * Computed by the server from the function the runner applies, so a screen
   * renders the ramp instead of re-deriving it -- the client-side copy of that
   * arithmetic could only ever be right by coincidence.
   */
  campaignWarmupFractions: number[];
  signals: {
    acceptance: LinkedInSignalBase & {
      windowDays: number;
      decided: number;
      accepted: number;
      /** Null when nothing has been decided. Never 0-of-0 rendered as 0%. */
      rate: number | null;
      floor: number;
      throttleFactor: number;
      throttled: boolean;
    };
    dayOverDay: LinkedInSignalBase & { maxDelta: number; minRampStep: number };
    rhythm: LinkedInSignalBase & {
      businessHours: { start: number; end: number };
      actionGapSeconds: { min: number; max: number };
      weekendFactor: number;
      enforcementScanWeekdays: number[];
    };
  };
}

/**
 * `seat.activatedAt` is the warm-up ramp clock, and it is weeks-since-this-seat-
 * started-sending-through-Trevra -- NOT how old the LinkedIn account is.
 * `seat.detectedAt` is when the profile was last read out of the logged-in
 * session. Both come off `LinkedInSeat`, which owns them.
 */
export type LinkedInQueueWaitReason = 'computer' | 'account_paused' | 'account_cooldown' | 'worker';

interface LinkedInMaintenanceTiming {
  task: 'inbox' | 'connections' | 'pending_invites' | 'acceptance' | 'withdrawals' | 'lead_sources';
  nextRunAt: string | null;
  nextRunWindowEndAt: string | null;
  timezone: string;
  waitingFor: LinkedInQueueWaitReason | null;
}

interface LinkedInBackgroundRunSchedule {
  startAt: string;
  endAt: string;
  timezone: string;
  source: 'maintenance' | 'actions' | 'catchup';
  waitingFor: LinkedInQueueWaitReason | null;
}

export interface LinkedInSeatResponse {
  seat: LinkedInSeat | null;
  auth: LinkedInSeatAuth;
  /** What became of the last detect handed to a worker that can open a browser. */
  detectRequest: SeatDetectRequest | null;
  execution: { ready: boolean; waitingFor: LinkedInQueueWaitReason | null };
  backgroundRun: LinkedInBackgroundRunSchedule | null;
  maintenance: LinkedInMaintenanceTiming[];
  posture: SeatPosture | null;
  warmupWeek: number;
  warmupWeeks: number;
  /** Rolling 24h, not since-midnight. */
  today: Record<PacedKind, number>;
}

/**
 * How this seat gets into LinkedIn: Trevra holds an encrypted email and
 * password and opens the session itself. The password is never on this type
 * in any form -- `maskedEmail` is the most the server will say back, and
 * `sessionValidAt` is the only evidence the screen has that a sign-in worked.
 */
export interface LinkedInSeatAuth {
  hasCredentials: boolean;
  maskedEmail: string | null;
  sessionValidAt: string | null;
}
/** Also declared rather than imported: the handler builds this object inline. */
export interface LinkedInWorkerStatus {
  enabled: boolean;
  /** This product runtime serves multiple tenant workspaces. */
  hosted: boolean;
  /** Hosted execution is attached to a paired member computer instead of a cloud browser. */
  companionBrowser: boolean;
  playwrightInstalled: boolean;
  playwrightPath: string | null;
  /** The seat's confirmed-session record: true only once a session was CONFIRMED live. */
  loggedIn: boolean;
  /** What THIS process could open, answered without opening anything. */
  browser: {
    canLaunchHeaded: boolean;
    canLaunchHeadless: boolean;
    /** Why a headed window cannot open. Empty exactly when `canLaunchHeaded`. */
    reasons: string[];
    /** Why a headless one cannot. Empty exactly when `canLaunchHeadless`. */
    headlessReasons: string[];
  };
  ready: boolean;
  blockers: string[];
  source: string;
}

/**
 * One LinkedIn account's state. `seatKey` absent means the first account, which
 * is what every caller written before multi-account meant and still means.
 */
export async function getLinkedInSeat(seatKey?: string): Promise<LinkedInSeatResponse> {
  return request(`/api/linkedin/seat${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`);
}

/** What one read of the logged-in session produced. */
export interface LinkedInDetectedProfile {
  profileUrl: string;
  name: string | null;
  connectionsCount: number | null;
}

interface LinkedInSeatDetection {
  /** 'pending' on a 202: the read was queued for a machine that can open a browser. */
  status?: 'detected' | 'pending';
  /** null when the read reached LinkedIn but produced nothing usable. */
  detected: LinkedInDetectedProfile | null;
  seat: LinkedInSeatResponse | null;
  /** What could not be read. Each one stays unknown on the screen, never zero. */
  degraded: string[];
  /** Set with 'pending': the one sentence naming what has to run, and where. */
  message?: string;
  requestedAt?: string;
}

/**
 * Read the seat out of the browser session the operator already logged into.
 *
 * The timezone is the only thing this browser knows that the worker cannot see,
 * so it is the only thing sent -- there is no other field on the way in. A 409
 * is not an error to dress up: it means the local worker is off, or the read hit
 * a login or challenge wall, and the server's message already names the profile
 * directory to log into. Surface that message verbatim.
 */
export async function detectLinkedInSeat(
  timezone: string,
  seatKey?: string
): Promise<LinkedInSeatDetection> {
  return request('/api/linkedin/seat/detect', {
    method: 'POST',
    body: JSON.stringify(seatKey ? { timezone, seatKey } : { timezone })
  });
}

/**
 * The email and password this machine signs into LinkedIn with.
 *
 * It goes up once and never comes back: the response carries the masked
 * address and nothing else, which is the only form any screen renders. The
 * server holds it encrypted and hands it to one thing -- the browser session
 * it opens on this machine.
 */
export async function saveLinkedInCredentials(input: {
  email: string;
  password: string;
  seatKey?: string;
}): Promise<{
  hasCredentials: true;
  maskedEmail: string;
}> {
  return request('/api/linkedin/seat/credentials', { method: 'POST', body: JSON.stringify(input) });
}

/** Removable at any time, which is half of why storing it is defensible at all. */
export async function deleteLinkedInCredentials(
  seatKey?: string
): Promise<{ hasCredentials: false }> {
  return request(
    `/api/linkedin/seat/credentials${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`,
    { method: 'DELETE' }
  );
}

export type LinkedInLoginStatus = 'ok' | 'otp_required' | 'challenge' | 'failed';

/** One sentence with every status, including the two that are not failures. */
export interface LinkedInLoginResult {
  status: LinkedInLoginStatus;
  message: string;
}

/**
 * Open the session with the stored credentials.
 *
 * `otp` is a second call to the same route rather than a route of its own,
 * because LinkedIn's code only exists after the first attempt. It travels in
 * the body for the reason every one-time code does: a query string is a proxy
 * log.
 */
export async function loginLinkedInSeat(
  otp?: string,
  seatKey?: string
): Promise<LinkedInLoginResult> {
  const body: { otp?: string; seatKey?: string } = {};
  if (otp) body.otp = otp;
  if (seatKey) body.seatKey = seatKey;
  return request('/api/linkedin/seat/login', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * The kill switch.
 *
 * `reason` is required by the server rather than defaulted, because "why is
 * this stopped" three weeks later is the question the column answers.
 */
export async function pauseLinkedInSeat(
  reason: string,
  seatKey?: string
): Promise<{ seat: LinkedInSeat; posture: SeatPosture }> {
  return request('/api/linkedin/seat/pause', {
    method: 'POST',
    body: JSON.stringify(seatKey ? { reason, seatKey } : { reason })
  });
}

/**
 * Start the account again, optionally saying why.
 *
 * `reason` is OPTIONAL where pause's is required, and the asymmetry is
 * deliberate: an account stopped for a cause nobody wrote down is unreadable a
 * month later, while "it is fine now" must not be blocked behind a text box.
 * What is given is recorded in the workspace's audit history against the actor
 * who gave it, paired with the pause it answers -- it is NOT stored on the
 * seat, whose `pausedReason` describes a stop that is over.
 *
 * `seatKey` stays the first parameter so every existing caller keeps working;
 * pass `undefined` for the owner account.
 */
export async function resumeLinkedInSeat(
  seatKey?: string,
  reason?: string
): Promise<{
  seat: LinkedInSeat;
  posture: SeatPosture;
  /** Exactly what was recorded, or null when the operator gave none. */
  resumeReason: string | null;
}> {
  return request('/api/linkedin/seat/resume', {
    method: 'POST',
    body: JSON.stringify({ ...(seatKey ? { seatKey } : {}), ...(reason ? { reason } : {}) })
  });
}

/**
 * Disconnect this seat: its ramp clock, the stored inbox it produced, its
 * sealed credentials, and any queued or held work a worker could still claim
 * against it (`released`). Send HISTORY survives -- the ledger is the record of
 * what really happened -- but nothing that could still act does.
 *
 * Owner-only, and confirm before calling it.
 */
export async function deleteLinkedInSeat(seatKey?: string): Promise<{
  deleted: boolean;
  clearedThreads: number;
  fullyStopped: boolean;
  released: {
    seatKey: string;
    actionsSkipped: number;
    tasksCancelled: number;
    channelActionsSkipped: number;
    channelActionsInFlight: number;
    actionsInFlight: number;
  };
}> {
  return request(`/api/linkedin/seat${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`, {
    method: 'DELETE'
  });
}

/**
 * Delete a lead list and everyone on it.
 *
 * Refused by the server while a RUNNING campaign is enrolling from it -- the
 * refusal comes back as a 409 with the sentence to show. Owner-only.
 */
export async function deleteLeadList(listId: string): Promise<{ deleted: unknown }> {
  return request(`/api/linkedin/manager/lead-lists/${encodeURIComponent(listId)}`, {
    method: 'DELETE'
  });
}

export async function getLinkedInLimits(seatKey?: string): Promise<LinkedInLimitsReport> {
  return request(`/api/linkedin/limits${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`);
}

export async function getLinkedInActions(
  filters: {
    status?: LinkedInActionStatus;
    kind?: LinkedInActionKind;
    campaignId?: string;
    seatKey?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}
): Promise<LinkedInActionView[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const result = await request<{ actions: LinkedInActionView[] }>(
    `/api/linkedin/actions${query.size ? `?${query}` : ''}`
  );
  return result.actions;
}

export async function skipLinkedInAction(id: string): Promise<LinkedInActionView> {
  const result = await request<{ action: LinkedInActionView }>(
    `/api/linkedin/actions/${encodeURIComponent(id)}/skip`,
    {
      method: 'POST',
      body: JSON.stringify({})
    }
  );
  return result.action;
}

/**
 * Rewrite the words of a message that has not been typed yet.
 *
 * Words only. The server refuses anything that is not this workspace's own
 * hand-queued, still-planned, unclaimed message, and its refusal is a sentence
 * the operator can act on -- show it rather than a generic failure.
 */
export async function editLinkedInActionBody(
  id: string,
  body: string
): Promise<LinkedInActionView> {
  const result = await request<{ action: LinkedInActionView }>(
    `/api/linkedin/actions/${encodeURIComponent(id)}/body`,
    {
      method: 'POST',
      body: JSON.stringify({ body })
    }
  );
  return result.action;
}

export async function listLinkedInPosts(
  filters: { seatKey?: string; status?: LinkedInPostStatus; limit?: number } = {}
): Promise<LinkedInPost[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const result = await request<{ posts: LinkedInPost[] }>(
    `/api/linkedin/posts${query.size ? `?${query}` : ''}`
  );
  return result.posts;
}

export async function createLinkedInPost(input: {
  seatKey?: string;
  blocks: PostBlock[];
  status?: 'draft' | 'scheduled';
  scheduledAt?: string;
}): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>('/api/linkedin/posts', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.post;
}

export async function updateLinkedInPost(
  postId: string,
  patch: {
    blocks?: PostBlock[];
    status?: 'draft' | 'scheduled';
    scheduledAt?: string | null;
  }
): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );
  return result.post;
}

export async function addLinkedInPostImage(postId: string, file: File): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}/media`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'X-Trevra-File-Name': encodeURIComponent(file.name)
      },
      body: file
    }
  );
  return result.post;
}

export async function cancelLinkedInPost(postId: string): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}`,
    {
      method: 'DELETE'
    }
  );
  return result.post;
}

export async function publishLinkedInPostNow(postId: string): Promise<LinkedInPost> {
  const result = await request<{ post: LinkedInPost }>(
    `/api/linkedin/posts/${encodeURIComponent(postId)}/publish-now`,
    {
      method: 'POST'
    }
  );
  return result.post;
}

export async function getLinkedInExclusions(): Promise<LinkedInExclusion[]> {
  const result = await request<{ exclusions: LinkedInExclusion[] }>('/api/linkedin/exclusions');
  return result.exclusions;
}

export async function addLinkedInExclusions(
  targets: Array<{ targetRef: string; reason?: string }>,
  source: 'manual' | 'import' = 'manual'
): Promise<{ exclusions: LinkedInExclusion[]; added: number; updated: number }> {
  return request('/api/linkedin/exclusions', {
    method: 'POST',
    body: JSON.stringify({ targets, source })
  });
}

/**
 * The funnel over a window.
 *
 * `seatKey` FILTERS, AND IT USED NOT TO. It selects the account whose actions
 * are counted and, with them, the clock their days are cut on -- every ceiling
 * in the product is enforced in the seat's own timezone, so a series bucketed
 * on anything else shows columns that were never any day's total. Passing it
 * once meant only the second half, which is how the account switcher came to
 * re-label a workspace-wide chart instead of narrowing it.
 *
 * Omitted, the counts are the whole workspace's -- what `/loop` asks for. The
 * response echoes `seatKey` so a screen can say which of the two it is showing,
 * says which zone it used (`timezone`), and says whether the workspace's seats
 * disagree about that zone (`timezoneSpansSeats`).
 */
export async function getLinkedInAnalytics(
  days = 30,
  seatKey?: string
): Promise<LinkedInAnalytics> {
  const query = new URLSearchParams({ days: String(days) });
  if (seatKey) query.set('seatKey', seatKey);
  return request(`/api/linkedin/analytics?${query.toString()}`);
}

/* =====================================================================
 * Outreach manager read/configuration plane (migrations 045-046).
 * ================================================================== */
export async function getLinkedInManagerSeats(): Promise<LinkedInSeat[]> {
  return (await request<{ seats: LinkedInSeat[] }>('/api/linkedin/manager/seats')).seats;
}

export async function createLinkedInManagerSeat(
  input: SeatPatch & { seatKey: string; label: string; timezone: string }
): Promise<LinkedInSeat> {
  return (
    await request<{ seat: LinkedInSeat }>('/api/linkedin/manager/seats', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).seat;
}

export async function updateLinkedInManagerSeat(
  seatKey: string,
  input: SeatPatch
): Promise<LinkedInSeat> {
  return (
    await request<{ seat: LinkedInSeat }>(
      `/api/linkedin/manager/seats/${encodeURIComponent(seatKey)}`,
      { method: 'PATCH', body: JSON.stringify(input) }
    )
  ).seat;
}

export async function getLinkedInManagerLeadLists(seatKey?: string): Promise<LinkedInLeadList[]> {
  return (
    await request<{ lists: LinkedInLeadList[] }>(
      `/api/linkedin/manager/lead-lists${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`
    )
  ).lists;
}

export async function createLinkedInManagerLeadList(input: {
  seatKey?: string;
  name: string;
  sourceKind?: LeadListSourceKind;
  sourceRef?: string | null;
}): Promise<LinkedInLeadList> {
  return (
    await request<{ list: LinkedInLeadList }>('/api/linkedin/manager/lead-lists', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).list;
}

export async function ingestLinkedInManagerLeadSignal(
  listId: string,
  input: {
    signalKind: 'profile_viewed' | 'post_engaged' | 'event_attended' | 'job_changed';
    idempotencyKey: string;
    profileUrl: string;
    firstName: string;
    lastName?: string | null;
    company?: string | null;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
    sourceRef?: string | null;
    occurredAt?: string | null;
    customFields?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }
): Promise<{
  signalId: string;
  contactId: string;
  listId: string;
  duplicateSignal: boolean;
  insertedContact: boolean;
  reusedContact: boolean;
}> {
  return request(`/api/linkedin/manager/lead-lists/${encodeURIComponent(listId)}/signals`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export interface LinkedInLeadCsvPreview {
  headers: string[];
  mapping: Partial<
    Record<
      'firstName' | 'lastName' | 'company' | 'email' | 'phone' | 'country' | 'profileUrl',
      string
    >
  >;
  /** Which mapped fields automatch guessed by similarity rather than an exact heading match. Absent entries were exact (or came from an explicit override). */
  mappingConfidence?: Partial<
    Record<
      'firstName' | 'lastName' | 'company' | 'email' | 'phone' | 'country' | 'profileUrl',
      'exact' | 'guessed'
    >
  >;
  accepted: Array<{
    firstName: string;
    lastName: string;
    company: string;
    email: string | null;
    phone: string | null;
    country: string | null;
    profileUrl: string | null;
  }>;
  acceptedCount: number;
  rejected: Array<{ row: number; reason: string }>;
  rejectedCount: number;
}

/** Preview + automap only. The server deliberately writes no lead row on this route. */
export async function previewLinkedInManagerLeadCsv(
  file: File,
  mapping?: LinkedInLeadCsvPreview['mapping']
): Promise<LinkedInLeadCsvPreview> {
  const form = new FormData();
  form.append('file', file);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  const response = await fetch('/api/linkedin/manager/lead-lists/preview', {
    method: 'POST',
    body: form,
    credentials: 'include'
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? 'Lead CSV preview failed', response.status);
  }
  return response.json();
}

export async function importLinkedInManagerProfileUrls(
  listId: string,
  urls: string,
  seatKey?: string
): Promise<{
  inserted: number;
  duplicates: number;
  reused: number;
  rejected: Array<{ value: string; reason: string }>;
}> {
  return request(`/api/linkedin/manager/lead-lists/${encodeURIComponent(listId)}/profile-urls`, {
    method: 'POST',
    body: JSON.stringify({ urls, ...(seatKey ? { seatKey } : {}) })
  });
}

/** The write half of the preview: parses through the same scrub + automatch, and persists. */
export async function importLinkedInManagerLeadCsv(
  listId: string,
  file: File,
  mapping?: LinkedInLeadCsvPreview['mapping'],
  seatKey?: string
): Promise<{
  inserted: number;
  duplicates: number;
  rejected: Array<{ row: number; reason: string }>;
  mapping: LinkedInLeadCsvPreview['mapping'];
  headers: string[];
}> {
  const form = new FormData();
  form.append('file', file);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  if (seatKey) form.append('seatKey', seatKey);
  const response = await fetch(
    `/api/linkedin/manager/lead-lists/${encodeURIComponent(listId)}/import`,
    { method: 'POST', body: form, credentials: 'include' }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? 'Lead CSV import failed', response.status);
  }
  return response.json();
}

/**
 * A page of one lead list, and HOW MANY PEOPLE ARE ACTUALLY ON IT.
 *
 * `total` is counted server-side, not `contacts.length`: the route returns at
 * most one page, so the two differ exactly when the screen most needs to say
 * so. Announcing a truncation from the page length alone is how the UI came to
 * claim a first-1,000 that nobody had counted.
 */
export async function getLinkedInManagerLeadContacts(
  listId: string,
  seatKey?: string
): Promise<{
  list: LinkedInLeadList;
  contacts: LinkedInLeadContact[];
  total: number;
  /** The server's page bound. `contacts.length` is short of `total` exactly when this is reached. */
  pageLimit: number;
}> {
  return request(
    `/api/linkedin/manager/lead-lists/${encodeURIComponent(listId)}/contacts${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`
  );
}

export async function updateLinkedInManagerLeadContact(
  contactId: string,
  input: {
    firstName: string;
    lastName: string;
    company: string;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
    profileUrl?: string | null;
    doNotContact?: boolean;
  }
): Promise<LinkedInLeadContact> {
  return (
    await request<{ contact: LinkedInLeadContact }>(
      `/api/linkedin/manager/contacts/${encodeURIComponent(contactId)}`,
      { method: 'PATCH', body: JSON.stringify(input) }
    )
  ).contact;
}

export async function deleteLinkedInManagerLeadContact(contactId: string): Promise<boolean> {
  return (
    await request<{ deleted: boolean }>(
      `/api/linkedin/manager/contacts/${encodeURIComponent(contactId)}`,
      { method: 'DELETE' }
    )
  ).deleted;
}

export async function getLinkedInManagerWorkflows(): Promise<LinkedInWorkflow[]> {
  return (await request<{ workflows: LinkedInWorkflow[] }>('/api/linkedin/manager/workflows'))
    .workflows;
}

export async function validateLinkedInManagerWorkflow(
  steps: WorkflowStep[]
): Promise<{ valid: boolean; issues: Array<{ path: Array<string | number>; message: string }> }> {
  return request('/api/linkedin/manager/workflows/validate', {
    method: 'POST',
    body: JSON.stringify({ steps })
  });
}

export async function createLinkedInManagerWorkflow(input: {
  name: string;
  steps: WorkflowStep[];
  scope?: 'workspace' | 'personal';
}): Promise<LinkedInWorkflow> {
  return (
    await request<{ workflow: LinkedInWorkflow }>('/api/linkedin/manager/workflows', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).workflow;
}

export async function updateLinkedInManagerWorkflow(
  id: string,
  input: { name: string; steps: WorkflowStep[]; scope?: 'workspace' | 'personal' }
): Promise<LinkedInWorkflow> {
  return (
    await request<{ workflow: LinkedInWorkflow }>(
      `/api/linkedin/manager/workflows/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(input) }
    )
  ).workflow;
}

export async function deleteLinkedInManagerWorkflow(id: string): Promise<boolean> {
  return (
    await request<{ deleted: boolean }>(
      `/api/linkedin/manager/workflows/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    )
  ).deleted;
}

export interface CampaignMailbox {
  id: string;
  provider: string;
  status: string;
  dailyLimit: number;
  timezone: string;
  workingDays: number[];
  workStartMinute: number;
  workEndMinute: number;
}

export async function getLinkedInCampaignMailboxes(): Promise<CampaignMailbox[]> {
  return (await request<{ mailboxes: CampaignMailbox[] }>('/api/linkedin/manager/mailboxes'))
    .mailboxes;
}

export async function updateLinkedInCampaignMailbox(
  id: string,
  input: Omit<CampaignMailbox, 'id' | 'provider' | 'status'>
): Promise<boolean> {
  return (
    await request<{ updated: boolean }>(
      `/api/linkedin/manager/mailboxes/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input)
      }
    )
  ).updated;
}

export async function retryLinkedInCampaignChannelAction(id: string): Promise<boolean> {
  return (
    await request<{ retried: boolean }>(
      `/api/linkedin/manager/channel-actions/${encodeURIComponent(id)}/retry`,
      { method: 'POST', body: '{}' }
    )
  ).retried;
}

export async function recordLinkedInCampaignEmailEvent(
  id: string,
  input: {
    eventKind:
      | 'opened'
      | 'clicked'
      | 'reply'
      | 'unsubscribe'
      | 'bounce'
      | 'delivery_failure'
      | 'out_of_office'
      | 'auto_reply'
      | 'unknown';
    providerEventId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  }
): Promise<{ recorded: boolean; memberId: string | null }> {
  return request(`/api/linkedin/manager/channel-actions/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateLinkedInSeatCapabilities(
  seatKey: string,
  input: {
    inmail: 'unknown' | 'available' | 'unavailable';
    premium?: boolean;
    salesNavigator?: boolean;
    recruiter?: boolean;
    inmailMonthlyBudget?: number | null;
    inmailPaidCreditCap?: number | null;
  }
): Promise<LinkedInSeat> {
  return (
    await request<{ seat: LinkedInSeat }>(
      `/api/linkedin/manager/seats/${encodeURIComponent(seatKey)}/capabilities`,
      { method: 'PATCH', body: JSON.stringify(input) }
    )
  ).seat;
}

export async function getLinkedInManagedCampaigns(): Promise<ManagedCampaign[]> {
  return (await request<{ campaigns: ManagedCampaign[] }>('/api/linkedin/manager/campaigns'))
    .campaigns;
}

export async function previewLinkedInManagedCampaign(input: {
  seatKey?: string;
  senderKeys?: string[];
  mailboxAssignments?: Record<string, string>;
  inmailCreditCap?: number | null;
  enrichmentCreditCap?: number | null;
  leadListId: string;
  workflowId: string;
  admissionPolicy?: ManagedCampaign['admissionPolicy'];
}): Promise<CampaignLaunchPreview> {
  return (
    await request<{ preview: CampaignLaunchPreview }>('/api/linkedin/manager/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  ).preview;
}

export async function createLinkedInManagedCampaign(input: {
  name: string;
  seatKey?: string;
  senderKeys?: string[];
  mailboxAssignments?: Record<string, string>;
  inmailCreditCap?: number | null;
  enrichmentCreditCap?: number | null;
  leadListId: string;
  workflowId: string;
  priority?: ManagedCampaign['priority'];
  admissionPolicy?: ManagedCampaign['admissionPolicy'];
  exclusionPolicy?: ManagedCampaign['exclusionPolicy'];
  schedule?: Partial<ManagedCampaign['schedule']>;
}): Promise<{
  campaign: ManagedCampaign;
  enrolled: number;
  skippedAlreadyActive: number;
  excluded: number;
}> {
  return request('/api/linkedin/manager/campaigns', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function getLinkedInCampaignOperations(id: string): Promise<{
  campaign: ManagedCampaign;
  queues: CampaignQueueSummary;
  waves: ManagedCampaignWave[];
  /**
   * Why the queue is or is not moving, from the only place that knows: the
   * seat's cooldown clock, the safety gate's verdict on the next claimable
   * action, and the rows parked on an outcome nobody could read back. Optional
   * so a client talking to an older server degrades to the generic message
   * rather than to a crash.
   */
  execution?: LinkedInCampaignExecution;
}> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/operations`);
}

export async function getLinkedInCampaignOperationalAnalytics(
  id: string
): Promise<CampaignOperationalAnalytics> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/operational-analytics`);
}

export async function updateLinkedInCampaignControls(
  id: string,
  input: {
    priority?: ManagedCampaign['priority'];
    admissionPolicy?: ManagedCampaign['admissionPolicy'];
    exclusionPolicy?: ManagedCampaign['exclusionPolicy'];
    senderKeys?: string[];
    mailboxAssignments?: Record<string, string>;
    inmailCreditCap?: number | null;
    enrichmentCreditCap?: number | null;
    schedule?: Partial<ManagedCampaign['schedule']>;
  }
): Promise<ManagedCampaign> {
  return (
    await request<{ campaign: ManagedCampaign }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/controls`,
      {
        method: 'PATCH',
        body: JSON.stringify(input)
      }
    )
  ).campaign;
}

export async function applyLatestLinkedInManagedCampaignWorkflow(id: string): Promise<{
  campaign: ManagedCampaign;
  previousVersion: number | null;
  latestVersion: number;
  pendingAffected: number;
}> {
  return request(
    `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/apply-latest-workflow`,
    { method: 'POST', body: '{}' }
  );
}

/**
 * Edit ONE campaign's steps. The workflow library is untouched, which is the
 * whole point: a one-off sequence for a single campaign no longer has to be
 * saved as a permanent template every other campaign can pick up.
 */
export async function updateLinkedInManagedCampaignSequence(
  id: string,
  steps: WorkflowStep[]
): Promise<{ campaign: ManagedCampaign; pendingAffected: number }> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/sequence`, {
    method: 'PUT',
    body: JSON.stringify({ steps })
  });
}

export type LinkedInUnknownOutcomeResolution = 'sent' | 'retry' | 'skip';

export async function resolveLinkedInManagedUnknownOutcome(
  surface: 'linkedin' | 'channel',
  actionId: string,
  resolution: LinkedInUnknownOutcomeResolution
): Promise<boolean> {
  const path =
    surface === 'linkedin'
      ? `/api/linkedin/manager/actions/${encodeURIComponent(actionId)}/resolve`
      : `/api/linkedin/manager/channel-actions/${encodeURIComponent(actionId)}/resolve`;
  return (
    await request<{ resolved: boolean }>(path, {
      method: 'POST',
      body: JSON.stringify({ resolution })
    })
  ).resolved;
}

export async function retryLinkedInManagedCampaignFailures(
  id: string,
  memberIds: string[] = []
): Promise<{ linkedinActions: number; channelActions: number; membersResumed: number }> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/retry-failures`, {
    method: 'POST',
    body: JSON.stringify({ memberIds })
  });
}

export async function moveLinkedInManagedCampaignMembers(
  sourceCampaignId: string,
  targetCampaignId: string,
  memberIds: string[]
): Promise<{ moved: number; skipped: number }> {
  return request(
    `/api/linkedin/manager/campaigns/${encodeURIComponent(sourceCampaignId)}/move-members`,
    { method: 'POST', body: JSON.stringify({ targetCampaignId, memberIds }) }
  );
}

export async function duplicateLinkedInManagedCampaign(
  id: string,
  name?: string
): Promise<{
  campaign: ManagedCampaign;
  enrolled: number;
  skippedAlreadyActive: number;
  excluded: number;
}> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(name ? { name } : {})
  });
}

export async function setLinkedInManagedCampaignOwner(
  id: string,
  ownerUserId: string | null
): Promise<ManagedCampaign> {
  return (
    await request<{ campaign: ManagedCampaign }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/owner`,
      { method: 'PATCH', body: JSON.stringify({ ownerUserId }) }
    )
  ).campaign;
}

export async function downloadLinkedInManagedCampaignExport(id: string): Promise<Blob> {
  const response = await fetch(
    `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/export.csv`,
    {
      credentials: 'include'
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? 'Unable to export campaign', response.status);
  }
  return response.blob();
}

export async function getLinkedInManagedCampaign(
  id: string
): Promise<{ campaign: ManagedCampaign; members: ManagedCampaignMember[] }> {
  return request(`/api/linkedin/manager/campaigns/${encodeURIComponent(id)}`);
}

export async function deleteLinkedInManagedCampaign(id: string): Promise<boolean> {
  return (
    await request<{ deleted: boolean }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    )
  ).deleted;
}
export async function startLinkedInManagedCampaign(id: string): Promise<ManagedCampaign> {
  return (
    await request<{ campaign: ManagedCampaign }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/start`,
      { method: 'POST', body: '{}' }
    )
  ).campaign;
}

export async function pauseLinkedInManagedCampaign(id: string): Promise<ManagedCampaign> {
  return (
    await request<{ campaign: ManagedCampaign }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/pause`,
      { method: 'POST', body: '{}' }
    )
  ).campaign;
}

export async function stopLinkedInManagedCampaign(id: string): Promise<ManagedCampaign> {
  return (
    await request<{ campaign: ManagedCampaign }>(
      `/api/linkedin/manager/campaigns/${encodeURIComponent(id)}/stop`,
      { method: 'POST', body: '{}' }
    )
  ).campaign;
}

export async function getLinkedInManagedMemberTimeline(
  id: string
): Promise<CampaignMemberTimeline> {
  return request(`/api/linkedin/manager/members/${encodeURIComponent(id)}/timeline`);
}

export async function rerunLinkedInManagedMemberCondition(
  id: string,
  stepId?: string
): Promise<boolean> {
  return (
    await request<{ rerun: boolean }>(
      `/api/linkedin/manager/members/${encodeURIComponent(id)}/rerun-condition`,
      { method: 'POST', body: JSON.stringify(stepId ? { stepId } : {}) }
    )
  ).rerun;
}

export async function resumeLinkedInManagedMemberAtStep(
  id: string,
  stepId: string
): Promise<boolean> {
  return (
    await request<{ resumed: boolean }>(
      `/api/linkedin/manager/members/${encodeURIComponent(id)}/resume-at-step`,
      { method: 'POST', body: JSON.stringify({ stepId }) }
    )
  ).resumed;
}

export async function endLinkedInManagedMember(
  id: string,
  outcome: 'completed' | 'excluded' | 'removed' = 'completed',
  reason?: string
): Promise<boolean> {
  return (
    await request<{ ended: boolean }>(
      `/api/linkedin/manager/members/${encodeURIComponent(id)}/end`,
      {
        method: 'POST',
        body: JSON.stringify({ outcome, ...(reason ? { reason } : {}) })
      }
    )
  ).ended;
}

export async function skipLinkedInManagedMemberStep(id: string, reason?: string): Promise<boolean> {
  return (
    await request<{ skipped: boolean }>(
      `/api/linkedin/manager/members/${encodeURIComponent(id)}/skip`,
      {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {})
      }
    )
  ).skipped;
}

export async function setLinkedInManagedMemberPaused(
  id: string,
  paused: boolean
): Promise<boolean> {
  return (
    await request<{ paused: boolean }>(
      `/api/linkedin/manager/members/${encodeURIComponent(id)}/pause`,
      { method: 'POST', body: JSON.stringify({ paused }) }
    )
  ).paused;
}

export async function removeLinkedInManagedMember(id: string): Promise<boolean> {
  return (
    await request<{ removed: boolean }>(`/api/linkedin/manager/members/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
  ).removed;
}

export async function getLinkedInManualTasks(
  filters: { seatKey?: string; status?: 'pending' | 'completed' | 'cancelled' } = {}
): Promise<ManualTaskView[]> {
  const query = new URLSearchParams();
  if (filters.seatKey) query.set('seatKey', filters.seatKey);
  if (filters.status) query.set('status', filters.status);
  return (
    await request<{ tasks: ManualTaskView[] }>(
      `/api/linkedin/manager/tasks${query.size ? `?${query}` : ''}`
    )
  ).tasks;
}

/** Closes the human checkpoint. Sending the message stays the operator's act, in the inbox. */
export async function completeLinkedInManualTask(id: string): Promise<boolean> {
  return (
    await request<{ completed: boolean }>(
      `/api/linkedin/manager/tasks/${encodeURIComponent(id)}/complete`,
      { method: 'POST', body: '{}' }
    )
  ).completed;
}

export interface ManagedCampaignTickResult {
  campaignsTicked: number;
  actionsPlanned: number;
  manualTasksCreated: number;
  membersCompleted: number;
  membersBlocked: number;
}

/** Advances every running campaign now. Plans work; never sends it. */
export async function tickLinkedInManagedCampaigns(): Promise<ManagedCampaignTickResult> {
  return request('/api/linkedin/manager/tick', { method: 'POST', body: '{}' });
}

/**
 * The manager's numbers, including `followsSent` and `invitesWithdrawn` -- the
 * two workflow actions that until now produced nothing measurable at all.
 *
 * A name for the server's own type rather than a second copy of it: both fields
 * live on `ManagedAnalytics`, and restating them here would be a shape that
 * looks authoritative while being unable to notice the server changing.
 */
type LinkedInManagedAnalytics = ManagedAnalytics;

export async function getLinkedInManagedAnalytics(
  filters: { campaignId?: string; seatKey?: string; sinceDays?: number } = {}
): Promise<LinkedInManagedAnalytics> {
  const query = new URLSearchParams();
  if (filters.campaignId) query.set('campaignId', filters.campaignId);
  if (filters.seatKey) query.set('seatKey', filters.seatKey);
  if (filters.sinceDays !== undefined) query.set('sinceDays', String(filters.sinceDays));
  return request(`/api/linkedin/manager/analytics${query.size ? `?${query}` : ''}`);
}

/** Never throws on the server side: a missing playwright comes back as an honest false. */
export async function getLinkedInWorkerStatus(): Promise<LinkedInWorkerStatus> {
  return request('/api/linkedin/worker/status');
}

interface LinkedInCompanionDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface LinkedInCompanionAttention {
  seatKey: string;
  label: string;
  kind: 'challenge' | 'reconnect_required';
  message: string;
  since: string;
}

export interface LinkedInCompanionRecovery {
  seatKey: string;
  label: string;
  status: 'open' | 'verified';
  startedAt: string;
  verifiedAt: string | null;
  lastSeenAt: string;
}

export interface LinkedInCompanionStatus {
  devices: LinkedInCompanionDevice[];
  attention: LinkedInCompanionAttention[];
  recoveries: LinkedInCompanionRecovery[];
  /** Owner-only: pair or replace the workspace's trusted computer. */
  canManage: boolean;
  /** Any workspace member may keep the already-paired companion active. */
  canUse: boolean;
  /** Any workspace member may revoke the already-paired computer. */
  canDisconnect: boolean;
}

export async function getLinkedInCompanionStatus(): Promise<LinkedInCompanionStatus> {
  return request('/api/linkedin/companion');
}

export async function createLinkedInCompanionPairing(): Promise<{
  code: string;
  expiresAt: string;
  command: string;
}> {
  return request('/api/linkedin/companion/pair', { method: 'POST', body: '{}' });
}

export async function revokeLinkedInCompanionDevice(
  deviceId: string
): Promise<{ revoked: boolean }> {
  return request(`/api/linkedin/companion/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE'
  });
}
/* =====================================================================
 * Lead sourcing (migration 030).
 *
 * OFF BY DEFAULT AND THAT IS THE FEATURE. Sending on your own account is
 * what the product is for; reading other people's profiles out of a search
 * page is scraping under LinkedIn's User Agreement 8.2, so it is a second,
 * separate opt-in that a hosted deployment cannot grant at all.
 *
 * The LIST route reports the switch rather than refusing -- a workspace with
 * sources from before it was turned off must still be able to read what they
 * found -- and only the WRITE route 409s. `offReason` is the server's own
 * sentence and names which kind of off it is; render it verbatim.
 * ================================================================== */

interface LinkedInLeadSourceList {
  sources: LinkedInLeadSource[];
  enabled: boolean;
  /** Null exactly when `enabled`. A calm explanation, not an error. */
  offReason: string | null;
}

/** 201 for a new source, 200 with `duplicate` when this URL is already live. */
export async function createLinkedInLeadSource(input: {
  kind: LeadSourceKind;
  url: string;
  seatKey?: string;
}): Promise<{
  source: LinkedInLeadSource;
  duplicate: boolean;
}> {
  const result = await request<{ source: LinkedInLeadSource; duplicate?: boolean }>(
    '/api/linkedin/lead-sources',
    {
      method: 'POST',
      body: JSON.stringify({
        kind: input.kind,
        url: input.url,
        ...(input.seatKey ? { seatKey: input.seatKey } : {})
      })
    }
  );
  return { source: result.source, duplicate: result.duplicate ?? false };
}

export async function getLinkedInLeadSources(
  limit?: number,
  seatKey?: string
): Promise<LinkedInLeadSourceList> {
  const query = new URLSearchParams();
  if (limit) query.set('limit', String(limit));
  if (seatKey) query.set('seatKey', seatKey);
  const result = await request<Partial<LinkedInLeadSourceList>>(
    `/api/linkedin/lead-sources${query.size ? `?${query}` : ''}`
  );
  return {
    sources: Array.isArray(result.sources) ? result.sources : [],
    enabled: result.enabled === true,
    offReason: result.offReason ?? null
  };
}

/** The people one walk stored, with the source they came from. */
export async function getLinkedInLeads(
  id: string,
  limit?: number,
  seatKey?: string
): Promise<{
  source: LinkedInLeadSource | null;
  leads: LinkedInLead[];
}> {
  const query = new URLSearchParams();
  if (limit) query.set('limit', String(limit));
  if (seatKey) query.set('seatKey', seatKey);
  const result = await request<{ source?: LinkedInLeadSource; leads?: LinkedInLead[] }>(
    `/api/linkedin/lead-sources/${encodeURIComponent(id)}/leads${query.size ? `?${query}` : ''}`
  );
  return { source: result.source ?? null, leads: Array.isArray(result.leads) ? result.leads : [] };
}

export interface DailyLeadAllowance {
  limit: number;
  used: number;
  remaining: number;
}

/** How many new leads a day this workspace is willing to collect at all. */
export async function getLinkedInLeadAllowance(seatKey?: string): Promise<DailyLeadAllowance> {
  return request(
    `/api/linkedin/lead-sources/allowance${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`
  );
}

export async function setLinkedInLeadAllowance(
  cap: number,
  seatKey?: string
): Promise<DailyLeadAllowance> {
  return request('/api/linkedin/lead-sources/allowance', {
    method: 'PUT',
    body: JSON.stringify({ cap, ...(seatKey ? { seatKey } : {}) })
  });
}

/**
 * Turns what a walk found into leads a campaign can enrol.
 *
 * `leadIds` is the operator's selection, and passing it is the difference
 * between importing the rows they ticked and importing the page they were
 * looking at. Absent means every lead this source found, up to `limit`.
 */
export async function importLinkedInLeadSource(
  sourceId: string,
  input: {
    seatKey?: string;
    listId?: string;
    listName?: string;
    limit?: number;
    leadIds?: string[];
  } = {}
): Promise<{
  list: LinkedInLeadList;
  inserted: number;
  duplicates: number;
  reused: number;
  skipped: number;
}> {
  return request(`/api/linkedin/lead-sources/${encodeURIComponent(sourceId)}/import`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

/* =====================================================================
 * The unified inbox (migration 031).
 *
 * THE READS ARE PLAIN DATABASE READS of what a previous sync stored, so they
 * answer instantly on any deployment. THE SYNCS DRIVE A BROWSER, so they are
 * available only where this process can open one for this seat and 409 with
 * the one thing to do where it cannot -- the same contract `detectLinkedInSeat`
 * has, and its message is surfaced verbatim for the same reason.
 *
 * REPLYING SENDS NOTHING. It queues a gated `linkedin_actions` row that the
 * worker claims, gates again, and executes at paced gaps.
 * ================================================================== */

interface LinkedInInboxSyncResult {
  /** Null on success. The routes turn a non-null into a 409 before it reaches here. */
  blocked: string | null;
  threads: number;
  created: number;
  updated: number;
  /** Conversations resolved to a ledger row, and therefore to a campaign. */
  linked: number;
  messages: number;
  /** Of those, inbound. The whole point of the walk. */
  inbound: number;
  linkage: string[];
  /** What could not be read. Never a reason to fail the run. */
  degraded: string[];
}

interface LinkedInThreadSyncResult {
  blocked: string | null;
  inserted: number;
  inbound: number;
  linkage: string | null;
  degraded: string[];
}

/**
 * One reply, queued.
 *
 * `verdict` rides along so a screen may show WHAT was checked rather than only
 * that it passed -- the same honesty rule the limits route follows. A refusal
 * never reaches here: it is a 409 carrying the gate's own sentence.
 */
interface LinkedInQueuedReply {
  actionId: string;
  threadId: string;
  threadUrn: string;
  targetRef: string;
  campaignId: string | null;
  plannedFor: string;
  verdict: LinkedInSafetyVerdict;
}

/**
 * The inbox list.
 *
 * `unread` AND `hasReply` ARE ON-OR-ABSENT, never `false`, and that is not a
 * simplification. The route parses them with `z.coerce.boolean()`, and
 * `Boolean('false')` is `true` -- so `?hasReply=false`, which the store layer
 * would read as "the ones still silent", arrives at the handler as `true` and
 * asks for the exact opposite. Until that schema takes a literal enum, the
 * only two states this filter can honestly express are on and off, so a
 * `false` here is dropped rather than sent as its own opposite.
 */
export async function getLinkedInThreads(
  filters: {
    unread?: boolean;
    hasReply?: boolean;
    campaignId?: string;
    seatKey?: string;
    limit?: number;
  } = {}
): Promise<LinkedInThreadRecord[]> {
  const query = new URLSearchParams();
  if (filters.unread === true) query.set('unread', 'true');
  if (filters.hasReply === true) query.set('hasReply', 'true');
  if (filters.campaignId) query.set('campaignId', filters.campaignId);
  if (filters.seatKey) query.set('seatKey', filters.seatKey);
  if (filters.limit !== undefined) query.set('limit', String(filters.limit));
  const result = await request<{ threads?: LinkedInThreadRecord[] }>(
    `/api/linkedin/inbox/threads${query.size ? `?${query}` : ''}`
  );
  return Array.isArray(result.threads) ? result.threads : [];
}

/**
 * Messages come back OLDEST FIRST, ordered by the position they were read in.
 *
 * `seatKey` names WHOSE inbox the conversation is in. Omitted, the server
 * resolves it in the owner's -- so a secondary account's conversation is
 * reported as not found, which is what this screen used to do to every one of
 * them.
 */
export async function getLinkedInThread(
  threadUrn: string,
  seatKey?: string
): Promise<LinkedInConversation> {
  const result = await request<{
    thread: LinkedInThreadRecord;
    messages?: LinkedInMessageRecord[];
  }>(
    `/api/linkedin/inbox/threads/${encodeURIComponent(threadUrn)}${seatKey ? `?seatKey=${encodeURIComponent(seatKey)}` : ''}`
  );
  return { thread: result.thread, messages: Array.isArray(result.messages) ? result.messages : [] };
}

/** Walks the conversation rail in a real browser. 409 where this process cannot open one. */
export async function syncLinkedInInbox(
  input: { maxThreads?: number; maxMessages?: number; seatKey?: string } = {}
): Promise<LinkedInInboxSyncResult> {
  const result = await request<Partial<LinkedInInboxSyncResult>>('/api/linkedin/inbox/sync', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return {
    blocked: result.blocked ?? null,
    threads: result.threads ?? 0,
    created: result.created ?? 0,
    updated: result.updated ?? 0,
    linked: result.linked ?? 0,
    messages: result.messages ?? 0,
    inbound: result.inbound ?? 0,
    linkage: Array.isArray(result.linkage) ? result.linkage : [],
    degraded: Array.isArray(result.degraded) ? result.degraded : []
  };
}

export async function syncLinkedInThread(
  threadUrn: string,
  input: { maxMessages?: number; seatKey?: string } = {}
): Promise<LinkedInThreadSyncResult> {
  const result = await request<Partial<LinkedInThreadSyncResult>>(
    `/api/linkedin/inbox/threads/${encodeURIComponent(threadUrn)}/sync`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return {
    blocked: result.blocked ?? null,
    inserted: result.inserted ?? 0,
    inbound: result.inbound ?? 0,
    linkage: result.linkage ?? null,
    degraded: Array.isArray(result.degraded) ? result.degraded : []
  };
}

/**
 * QUEUES a reply. It does not send one, and no screen may say otherwise.
 *
 * A 409 is the safety gate refusing, and its message is the gate's own words.
 * Surface it verbatim: that sentence is the product working, and rewriting it
 * would drop the one thing that names what to do next.
 */
export async function replyToLinkedInThread(
  threadUrn: string,
  body: string,
  plannedFor?: string,
  seatKey?: string
): Promise<LinkedInQueuedReply> {
  return request(`/api/linkedin/inbox/threads/${encodeURIComponent(threadUrn)}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      body,
      ...(plannedFor ? { plannedFor } : {}),
      ...(seatKey ? { seatKey } : {})
    })
  });
}

/* =====================================================================
 * Pending-invite withdrawal (migration 032).
 *
 * FOUR ROUTES BECAUSE THERE ARE FOUR DECISIONS, and only the last one -- the
 * queue drain, which the worker performs on its own tick -- clicks anything in
 * a real account. `queueLinkedInWithdrawals` is reversible database work and
 * its response ALWAYS says `withdrawn: 0`; a UI that implies otherwise is a
 * UI that will read as broken the first time somebody checks.
 * ================================================================== */

interface LinkedInPendingSyncResult {
  blocked: string | null;
  /** Entries LinkedIn showed us. */
  listed: number;
  /** Of those, ones this ledger has an outstanding invite for. */
  matched: number;
  /** Pending on LinkedIn with no ledger row -- almost always sent by hand. Reported, never invented. */
  unmatched: number;
  /** Seen pending before and absent now. Accepted, declined, expired and withdrawn look identical here. */
  disappeared: number;
  truncated: boolean;
  degraded: string[];
}

export interface LinkedInWithdrawalCandidates {
  candidates: WithdrawalCandidate[];
  /** The whole backlog, unwindowed: an invite sent in March still occupies a slot in June. */
  pendingInvites: number;
  maxOutstandingInvites: number;
  staleAfterDays: number;
}

interface LinkedInWithdrawalsQueued {
  candidates: WithdrawalCandidate[];
  queued: number;
  duplicates: number;
  /** ALWAYS 0. This route enqueues; the worker withdraws, paced and gated. */
  withdrawn: number;
}

/** Re-reads LinkedIn's own sent-invitations list. Browser work: 409 where none can open. */
export async function syncLinkedInPendingInvites(): Promise<LinkedInPendingSyncResult> {
  const result = await request<Partial<LinkedInPendingSyncResult>>(
    '/api/linkedin/withdrawals/sync',
    { method: 'POST' }
  );
  return {
    blocked: result.blocked ?? null,
    listed: result.listed ?? 0,
    matched: result.matched ?? 0,
    unmatched: result.unmatched ?? 0,
    disappeared: result.disappeared ?? 0,
    truncated: result.truncated === true,
    degraded: Array.isArray(result.degraded) ? result.degraded : []
  };
}

/** A pure query. It shows what WOULD be withdrawn, before anything is. */
export async function getLinkedInWithdrawalCandidates(
  filters: {
    olderThanDays?: number;
    limit?: number;
  } = {}
): Promise<LinkedInWithdrawalCandidates> {
  const query = new URLSearchParams();
  if (filters.olderThanDays !== undefined)
    query.set('olderThanDays', String(filters.olderThanDays));
  if (filters.limit !== undefined) query.set('limit', String(filters.limit));
  const result = await request<Partial<LinkedInWithdrawalCandidates>>(
    `/api/linkedin/withdrawals/candidates${query.size ? `?${query}` : ''}`
  );
  return {
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    pendingInvites: result.pendingInvites ?? 0,
    maxOutstandingInvites: result.maxOutstandingInvites ?? 0,
    staleAfterDays: result.staleAfterDays ?? 21
  };
}

/**
 * Queue withdrawals. NOTHING IS WITHDRAWN HERE.
 *
 * The rows are filed `queued`; the local worker claims them, re-runs the whole
 * safety gate against each one, and clicks at 30-120s gaps. Clearing a backlog
 * in one burst is the same volume spike as sending one.
 */
export async function queueLinkedInWithdrawals(
  input: {
    olderThanDays?: number;
    limit?: number;
  } = {}
): Promise<LinkedInWithdrawalsQueued> {
  const result = await request<Partial<LinkedInWithdrawalsQueued>>('/api/linkedin/withdrawals', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return {
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    queued: result.queued ?? 0,
    duplicates: result.duplicates ?? 0,
    withdrawn: result.withdrawn ?? 0
  };
}

export async function getLinkedInWithdrawals(
  filters: {
    status?: WithdrawalStatus;
    seatKey?: string;
    limit?: number;
  } = {}
): Promise<WithdrawalRecord[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const result = await request<{ withdrawals?: WithdrawalRecord[] }>(
    `/api/linkedin/withdrawals${query.size ? `?${query}` : ''}`
  );
  return Array.isArray(result.withdrawals) ? result.withdrawals : [];
}

/* =====================================================================
 * Accounts (migration 039): the ranked list and its evidence.
 *
 * THE SCREEN INVENTS NOTHING AND SO NEITHER DOES THIS FILE. Every number a
 * row shows -- the score, a component's points, an age in days, a combination
 * bonus -- arrives inside `RankedAccount` from `accounts/score.ts`, next to
 * the `evidenceUrl` it was read from. There is no client-side arithmetic here
 * and there must not be one: a score the operator cannot click through to the
 * page it came from is a claim, and claims do not go in outbound mail.
 *
 * `score` is NULLABLE and that is a real state, not a loading one. An account
 * imported a minute ago has no score row yet, and the honest sentence for it
 * is "the sweep has not read this yet", never a zero dressed up as a verdict.
 * ================================================================== */

/** Re-exported so the screens read one vocabulary and never reach into src/server themselves. */
export type {
  Account,
  AccountImportResult,
  AccountScore,
  AccountSignal,
  AccountSignalKind,
  AccountSource,
  AccountStatus,
  AccountTier,
  RankedAccount,
  ScoreComponent,
  ScoreRationale
};

/** A source Trevra can run through the generic company-sourcing contract. */
export interface AccountSourceProvider {
  key: string;
  name: string;
  docsUrl: string;
  retention: 'default' | 'none';
  availability: {
    mode: 'ready' | 'needs-credential' | 'disabled';
    reason: string;
    docsUrl?: string;
  };
}

export interface AccountSourceRunResult {
  runId: string;
  providerKey: string;
  availability: AccountSourceProvider['availability'];
  found: number;
  warnings: string[];
  import: AccountImportResult;
}

export async function getAccountSourceProviders(): Promise<AccountSourceProvider[]> {
  const result = await request<{ providers?: AccountSourceProvider[] }>(
    '/api/accounts/source-providers'
  );
  return Array.isArray(result.providers) ? result.providers : [];
}

export async function sourceAccounts(input: {
  provider: string;
  keywords?: string[];
  domains?: string[];
  urls?: string[];
  countries?: string[];
  vertical?: string | null;
  limit?: number;
  tags?: string[];
}): Promise<AccountSourceRunResult> {
  return request('/api/accounts/source', { method: 'POST', body: JSON.stringify(input) });
}

/** Hot first, then by score. The server owns the order; the screen renders it. */
export async function getRankedAccounts(
  filters: { tier?: AccountTier; limit?: number } = {}
): Promise<RankedAccount[]> {
  const query = new URLSearchParams();
  if (filters.tier) query.set('tier', filters.tier);
  if (filters.limit) query.set('limit', String(filters.limit));
  const suffix = query.toString();
  const result = await request<{ accounts?: RankedAccount[] }>(
    `/api/accounts${suffix ? `?${suffix}` : ''}`
  );
  return Array.isArray(result.accounts) ? result.accounts : [];
}

/**
 * One paste, dropped file, or chosen CSV/JSON/TXT file read into a string.
 */
export async function importAccounts(input: {
  text: string;
  source?: AccountSource;
  tags?: string[];
  people?: Array<{
    accountDomain: string;
    name?: string;
    email?: string;
    phone?: string;
    role?: string;
    sourcePath?: string;
  }>;
}): Promise<AccountImportResult> {
  return request('/api/accounts/import', { method: 'POST', body: JSON.stringify(input) });
}

export interface CaptureSourceSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  kind: 'website' | 'form' | 'signup' | 'partner' | 'integration';
  status: 'active' | 'disabled';
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboundPerson {
  id: string;
  workspaceId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuppressionSummary {
  id: string;
  workspaceId: string;
  personId: string | null;
  email: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  channel: 'all' | 'email' | 'linkedin' | 'community';
  reason: string;
  source: string;
  sourceRef: string | null;
  createdAt: string;
  liftedAt: string | null;
}

export interface InboundSubmission {
  id: string;
  workspaceId: string;
  captureSourceId: string;
  contactId: string;
  accountId: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  kind: string;
  person: {
    name: string | null;
    email: string | null;
    phone: string | null;
    role: string | null;
    externalId: string | null;
  };
  company: { domain: string; name: string | null } | null;
  message: string | null;
  pageUrl: string | null;
  referrer: string | null;
  attribution: Record<string, unknown>;
  consent: Record<string, unknown>;
  properties: Record<string, unknown>;
  occurredAt: string | null;
  receivedAt: string;
}

export async function getCaptureSources(): Promise<CaptureSourceSummary[]> {
  const result = await request<{ sources: CaptureSourceSummary[] }>('/api/capture-sources');
  return result.sources;
}

export async function createCaptureSource(input: {
  name: string;
  kind: CaptureSourceSummary['kind'];
}): Promise<{ source: CaptureSourceSummary; secret: string }> {
  return request('/api/capture-sources', { method: 'POST', body: JSON.stringify(input) });
}

export async function setCaptureSourceStatus(
  id: string,
  status: CaptureSourceSummary['status']
): Promise<CaptureSourceSummary> {
  const result = await request<{ source: CaptureSourceSummary }>(
    `/api/capture-sources/${encodeURIComponent(id)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status }) }
  );
  return result.source;
}

export async function rotateCaptureSourceSecret(
  id: string
): Promise<{ source: CaptureSourceSummary; secret: string }> {
  return request(`/api/capture-sources/${encodeURIComponent(id)}/rotate`, { method: 'POST' });
}

export interface EmailDeliverySummary {
  id: string;
  workspaceId: string;
  recipient: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  status: 'sending' | 'sent' | 'failed' | 'uncertain';
  provider: string | null;
  externalRef: string | null;
  internetMessageId: string | null;
  lastError: string | null;
  attemptCount: number;
  startedAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getEmailDeliveries(limit = 100): Promise<EmailDeliverySummary[]> {
  const result = await request<{ deliveries: EmailDeliverySummary[] }>(
    `/api/deliveries?limit=${limit}`
  );
  return result.deliveries;
}

export async function getInboundPeople(limit = 200): Promise<InboundPerson[]> {
  const result = await request<{ people: InboundPerson[] }>(`/api/inbound/people?limit=${limit}`);
  return result.people;
}

export async function getInboundSubmissions(limit = 200): Promise<InboundSubmission[]> {
  const result = await request<{ submissions: InboundSubmission[] }>(
    `/api/inbound/submissions?limit=${limit}`
  );
  return result.submissions;
}

export async function getSuppressions(): Promise<SuppressionSummary[]> {
  const result = await request<{ suppressions: SuppressionSummary[] }>('/api/suppressions');
  return result.suppressions;
}

export async function createSuppression(input: {
  channel?: SuppressionSummary['channel'];
  personId?: string | null;
  email?: string | null;
  domain?: string | null;
  linkedinUrl?: string | null;
  reason: string;
}): Promise<SuppressionSummary> {
  const result = await request<{ suppression: SuppressionSummary }>('/api/suppressions', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return result.suppression;
}

export async function liftSuppression(id: string): Promise<SuppressionSummary> {
  const result = await request<{ suppression: SuppressionSummary }>(
    `/api/suppressions/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return result.suppression;
}

export async function getAccount(id: string): Promise<RankedAccount> {
  return request(`/api/accounts/${encodeURIComponent(id)}`);
}

/** The verdict is training data about the SHAPE of the signals, not just this one company. */
export async function sendAccountFeedback(
  id: string,
  input: { verdict: 'not_a_fit' | 'good_fit'; reason?: string }
): Promise<RankedAccount> {
  return request(`/api/accounts/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

/** Recompute every active account's score against the signals as they stand now. */
export async function rescoreAccounts(): Promise<{ rescored: number }> {
  return request('/api/accounts/rescore', { method: 'POST' });
}

export async function getResearch(): Promise<{ sources: any[]; runs: any[] }> {
  return request('/api/research');
}
export async function createResearchSource(input: Record<string, unknown>): Promise<any> {
  return request('/api/research/sources', { method: 'POST', body: JSON.stringify(input) });
}
export async function runResearchSource(
  id: string,
  mode: 'incremental' | 'backfill'
): Promise<any> {
  return request(`/api/research/sources/${id}/run`, {
    method: 'POST',
    body: JSON.stringify({ mode })
  });
}
export async function searchResearch(input: Record<string, unknown>): Promise<{ results: any[] }> {
  return request('/api/research/search', { method: 'POST', body: JSON.stringify(input) });
}

/* ---------------------------------------------------------------------------
 * Reddit (migration 041).
 *
 * THE SAME CONTRACT AS THE LINKEDIN SEAT, and the same one-way street: the
 * username and password go up once and neither comes back. The most any
 * response here carries is `hasCredentials` and the PUBLIC handle -- which is
 * unmasked on purpose, because it is printed under every comment the account
 * posts and hiding it would conceal which account is about to speak.
 * -------------------------------------------------------------------------- */

/** The row: which handle this workspace speaks as, and when its session was last live. */
interface RedditAccountRow {
  workspaceId: string;
  username: string | null;
  authMode: 'manual' | 'credentials';
  sessionValidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RedditAuth {
  hasCredentials: boolean;
  /** `u/pankaj`, or null. Public by design. */
  username: string | null;
  /** The only evidence the screen has that a sign-in actually worked. */
  sessionValidAt: string | null;
}

/** What THIS process could open, answered without opening anything. */
export interface RedditWorkerStatus {
  enabled: boolean;
  playwrightPath: string | null;
  profileDir: string;
  browser: {
    canLaunchHeaded: boolean;
    canLaunchHeadless: boolean;
    /** Why a headed window cannot open. Empty exactly when `canLaunchHeaded`. */
    reasons: string[];
    /** Why a headless one cannot. Empty exactly when `canLaunchHeadless`. */
    headlessReasons: string[];
  };
  ready: boolean;
  blockers: string[];
}

export interface RedditAccountResponse {
  account: RedditAccountRow | null;
  auth: RedditAuth;
  worker: RedditWorkerStatus;
}

export async function getRedditAccount(): Promise<RedditAccountResponse> {
  return request('/api/reddit/account');
}

/**
 * The username and password this machine signs into Reddit with.
 *
 * It goes up once and never comes back: the response carries the handle and
 * nothing else. The server holds the pair encrypted and hands it to one thing
 * -- the browser session it opens on this machine.
 */
export async function saveRedditCredentials(input: {
  username: string;
  password: string;
}): Promise<{
  hasCredentials: true;
  username: string;
}> {
  return request('/api/reddit/credentials', { method: 'POST', body: JSON.stringify(input) });
}

/** Removable at any time, which is half of why storing it is defensible at all. */
export async function deleteRedditCredentials(): Promise<{ hasCredentials: false }> {
  return request('/api/reddit/credentials', { method: 'DELETE' });
}

export type RedditLoginStatus = 'ok' | 'otp_required' | 'challenge' | 'failed';

/** One sentence with every status, including the two that are not failures. */
export interface RedditLoginResult {
  status: RedditLoginStatus;
  message: string;
  username?: string | null;
}

/**
 * Open the session with the stored credentials.
 *
 * `otp` is a second call to the same route rather than a route of its own,
 * because the code only matters after the first attempt. It travels in the body
 * for the reason every one-time code does: a query string is a proxy log.
 */
export async function loginReddit(otp?: string): Promise<RedditLoginResult> {
  return request('/api/reddit/login', { method: 'POST', body: JSON.stringify(otp ? { otp } : {}) });
}
