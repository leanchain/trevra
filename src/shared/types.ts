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

export interface RegistryPublisher {
  id: string;
  slug: string;
  displayName?: string;
  name?: string;
  keyFingerprint: string;
  verified: boolean;
  reputationScore: number;
  createdAt?: string;
  updatedAt?: string;
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

export interface ClientDetail {
  client: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  commitments: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
}
