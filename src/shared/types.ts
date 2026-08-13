export type RecommendationType =
  | 'stale_proposal'
  | 'scope_creep'
  | 'unbilled_milestone'
  | 'overdue_invoice';

export type RecommendationStatus =
  | 'detected'
  | 'ready'
  | 'approved'
  | 'completed'
  | 'dismissed'
  | 'snoozed';

export interface Evidence {
  id: string;
  sourceType: string;
  sourceId: string;
  label: string;
  category: string;
  externalUrl?: string | null;
  excerpt: string;
}

export interface ProofPack {
  id: string;
  summary: string;
  status: string;
  items: Evidence[];
}

export interface Recommendation {
  id: string;
  type: RecommendationType;
  title: string;
  summary: string;
  clientId: string;
  clientName: string;
  estimatedAmount: number;
  currency: string;
  confidence: number;
  urgency: number;
  priorityScore: number;
  status: RecommendationStatus;
  recommendedAction: string;
  createdAt: string;
  snoozedUntil?: string | null;
  evidence: Evidence[];
  proofPack?: ProofPack | null;
  preparedAction?: PreparedAction | null;
}

export interface DashboardMetrics {
  revenueAtRisk: number;
  revenueProtected: number;
  revenueCollected: number;
  readyToInvoice: number;
  openRecommendations: number;
  overdueInvoices: number;
  activeClients: number;
  connectedSources: number;
  currency: string;
}

export interface ClientSummary {
  id: string;
  name: string;
  contactName: string;
  email: string;
  status: string;
  activeValue: number;
  currency: string;
  lastInteractionAt: string;
  nextAction?: string | null;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  providerConfigKey: string;
  displayName?: string | null;
  status: 'connected' | 'needs_reauth' | 'error' | 'disconnected';
  isDemo: boolean;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export type IntegrationCategory =
  | 'communication'
  | 'calendar'
  | 'accounting'
  | 'payments'
  | 'marketplace'
  | 'project'
  | 'crm'
  | 'data';

/**
 * `oauth`  — the end user authorizes Trevra through the provider's OAuth screen.
 * `apiKey` — the end user pastes a provider API key into the Nango Connect UI. The key is posted
 *            from the browser to Nango and stored there; Trevra only ever holds the resulting
 *            connection reference and never receives, renders, logs, or persists the key.
 * `import` — no live connection; the operator uploads a CSV export.
 */
export type IntegrationMode = 'oauth' | 'apiKey' | 'import';

export interface AvailableIntegration {
  key: string;
  provider: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  mode: IntegrationMode;
  connected: boolean;
}

export type AutomationMode = 'suggest' | 'prepare' | 'execute';


export interface WorkspacePolicy {
  id: string;
  name: string;
  version: number;
  priority: number;
  actionPattern: string;
  effect: 'allow' | 'deny' | 'require_approval';
  conditions: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRule {
  id: string;
  recommendationType: RecommendationType;
  mode: AutomationMode;
  minConfidence: number;
  maxAmount: number;
  delayMinutes: number;
  enabled: boolean;
}

export interface DashboardPayload {
  workspace: { id: string; name: string };
  metrics: DashboardMetrics;
  recommendations: Recommendation[];
  clients: ClientSummary[];
  connections: ConnectionSummary[];
  availableIntegrations: AvailableIntegration[];
  automationRules: AutomationRule[];
}

export type AgentScope =
  | 'skills:read' | 'skills:run' | 'runs:read' | 'workspace:read' | 'actions:prepare'
  | 'playbooks:read' | 'playbooks:run' | 'workflows:read';


export type PlaybookRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type PlaybookStepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface PlaybookManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  pinnedVersion: string | null;
  inputSchema: Record<string, unknown>;
  definition: Record<string, unknown>;
  source: { type: string; ref: string | null };
  config: Record<string, unknown>;
}

export interface PlaybookStepRun {
  id: string;
  stepId: string;
  stepType: 'skill' | 'approval' | 'action';
  skillId: string | null;
  skillVersion: string | null;
  skillRunId: string | null;
  status: PlaybookStepStatus;
  attempt: number;
  input: unknown;
  output: unknown;
  evidence: unknown[];
  error: string | null;
  policyDecision: unknown;
  approvalPayloadHash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface PlaybookRun {
  id: string;
  workspaceId: string;
  playbookId: string;
  playbookVersion: string;
  status: PlaybookRunStatus;
  actorType: string;
  actorId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  currentStepId: string | null;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  steps: PlaybookStepRun[];
}



export interface ModulePopularity {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number | null;
  uniqueWorkspaces: number;
  activeInstallations: number;
  lastRunAt: string | null;
  rank: number;
}

export interface PublicRegistryModule {
  id: string;
  name: string;
  description: string;
  sourceType: 'builtin' | 'community';
  version: string | null;
  runtime: 'builtin' | 'oci' | 'wasi' | 'remote';
  sideEffect: 'none' | 'network-read' | 'external-write';
  requiresApproval: boolean;
  artifactDigest: string | null;
  publishedAt: string | null;
  publisher: {
    id: string | null;
    slug: string;
    name: string;
    verified: boolean;
    keyFingerprint: string | null;
    reputationScore: number;
  };
  trust: { signed: boolean; sbom: boolean; verifiedRelease: boolean };
  popularity: ModulePopularity;
}

export interface InstalledCommunityModule {
  id: string;
  version: string;
  name: string;
  description: string;
  runtime: 'oci' | 'wasi' | 'remote';
  artifactRef: string;
  artifactDigest: string;
  sideEffect: 'none' | 'network-read' | 'external-write';
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  config: Record<string, unknown>;
  publisher: { id: string; slug: string; keyFingerprint: string; verified: boolean };
}

export interface AgentTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface PreparedAction {
  id: string;
  recommendationId: string;
  type: 'email_draft' | 'invoice_draft' | 'change_order_draft';
  subject: string;
  body: string;
  recipient: string;
  status: 'draft' | 'approved' | 'scheduled' | 'executed' | 'failed' | 'cancelled';
  executionProvider: string;
  scheduledFor?: string | null;
  externalRef?: string | null;
  lastError?: string | null;
}

/**
 * The hosted agent's run ledger, as served by `/api/agent-runs`.
 *
 * Mirrors `src/server/agent/runs.ts`. The list endpoint returns runs without
 * steps; only the detail endpoint carries them, which is why the two shapes
 * are separate rather than one type with an optional array.
 */
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentRunStep {
  seq: number;
  kind: 'model' | 'tool';
  toolName: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
}

export interface AgentRunSummary {
  id: string;
  workspaceId?: string;
  trigger: 'manual' | 'schedule';
  status: AgentRunStatus;
  goal: string;
  stepCount: number;
  maxSteps: number;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * When somebody asked this run to stop, or null if nobody has.
   *
   * Separate from `status` because a stop is a REQUEST, not an event: the run
   * keeps `status: 'running'` until whatever is running it has actually put the
   * model down. Those seconds in between are what this field lets the UI
   * describe honestly -- "stopping", never "stopped" (app-spec.md §6 rule 3).
   *
   * Optional so a client stays readable against a server that predates it.
   */
  stopRequestedAt?: string | null;
}

export interface AgentRun extends AgentRunSummary {
  steps: AgentRunStep[];
}

/**
 * Setup for Trevra's own agent, as served by `/api/agent-setup`.
 *
 * `secret` carries `last4` and nothing else that identifies the key. There is
 * no plaintext field here because there is no route that returns one, at any
 * privilege -- so nothing in the UI can offer to show it back.
 */
export interface AgentModelConfig {
  baseUrl: string;
  model: string;
  label: string | null;
  updatedAt: string;
}

export interface AgentKeySummary {
  kind: 'model_api_key';
  label: string | null;
  last4: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Whole cents on the wire; the screen converts, and never says "cents". */
export interface AgentBudget {
  monthlyCapCents: number;
  spentCents: number;
  periodStart: string;
  enabled: boolean;
}

export interface AgentSchedule {
  enabled: boolean;
  goal: string;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

/**
 * A workspace's own Claude/Codex subscription, opted into per workspace as a
 * third way to run the hosted agent alongside BYOK. `config` is null until the
 * workspace has chosen a CLI and a model; `tokenStored`/`riskAccepted` are
 * booleans a screen can act on, never the token or a reveal of it -- see
 * docs/cli-agent-and-hosted.md.
 */
export interface AgentCliConfig {
  cli: 'claude' | 'codex';
  model: string;
}

export interface AgentCliSetup {
  config: AgentCliConfig | null;
  tokenStored: boolean;
  riskAccepted: boolean;
}

/**
 * `available: false` means this deployment holds no secrets key, so BYOK is
 * off rather than half-working. `schedule` is optional on purpose: a build
 * without the schedule route omits the field entirely, and the screen hides
 * that section instead of failing.
 */
export interface AgentSetup {
  available: boolean;
  config: AgentModelConfig | null;
  secret: AgentKeySummary | null;
  budget: AgentBudget;
  schedule?: AgentSchedule | null;
  cli: AgentCliSetup;
}

/** One row of the skill ledger, as served by `/api/skill-runs/:id`. */
export type SkillRunStatus = 'ok' | 'error';

export interface SkillEvidence {
  label: string;
  detail: string;
  sourceUrl?: string | null;
}

export interface SkillRun {
  id: string;
  skillId: string;
  skillVersion: string;
  workspaceId: string;
  status: SkillRunStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  evidence: SkillEvidence[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ClientDetail {
  client: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  commitments: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
}
