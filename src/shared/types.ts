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

export interface AvailableIntegration {
  key: string;
  provider: string;
  name: string;
  category: 'communication' | 'calendar' | 'accounting' | 'payments' | 'marketplace' | 'project';
  description: string;
  mode: 'oauth' | 'import';
  connected: boolean;
}

export type AutomationMode = 'suggest' | 'prepare' | 'execute';

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
