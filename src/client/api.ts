import type {
  AgentScope,
  AgentTokenSummary,
  AutomationRule,
  AvailableIntegration,
  ConnectionSummary,
  DashboardPayload,
  PlaybookManifest,
  PlaybookRun,
  PlaybookRunStatus,
  PreparedAction,
  RecommendationType,
  WorkspacePolicy,
  PublicRegistryModule,
  InstalledCommunityModule,
  RegistryPublisher
} from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
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
  return response.json() as Promise<T>;
}

export async function getPublicConfig(): Promise<{ googleAuthEnabled: boolean; modelExtractionEnabled: boolean; supportEmail: string; catalogApiUrl?: string }> {
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

export async function prepareRecommendation(id: string): Promise<PreparedAction> {
  const result = await request<{ action: PreparedAction }>(`/api/recommendations/${id}/prepare`, { method: 'POST' });
  return result.action;
}

export async function approveAction(id: string, payload: Pick<PreparedAction, 'recipient' | 'subject' | 'body' | 'scheduledFor'>): Promise<PreparedAction> {
  const result = await request<{ action: PreparedAction }>(`/api/actions/${id}/approve`, { method: 'POST', body: JSON.stringify(payload) });
  return result.action;
}

export async function executeAction(id: string): Promise<PreparedAction> {
  const result = await request<{ action: PreparedAction }>(`/api/actions/${id}/execute`, { method: 'POST' });
  return result.action;
}

export async function snoozeRecommendation(id: string): Promise<void> {
  await request(`/api/recommendations/${id}/snooze`, { method: 'POST', body: JSON.stringify({ days: 3 }) });
}

export async function dismissRecommendation(id: string, reason?: string): Promise<void> {
  await request(`/api/recommendations/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function getIntegrations(): Promise<{ connections: ConnectionSummary[]; available: AvailableIntegration[]; configured: boolean }> {
  return request('/api/integrations');
}

export async function createConnectSession(allowedIntegrations: string[]): Promise<{ token: string; expires_at?: string; connect_link?: string; browser_host?: string }> {
  const result = await request<{ session: { token: string; expires_at?: string; connect_link?: string; browser_host?: string } }>('/api/integrations/connect-session', {
    method: 'POST', body: JSON.stringify({ allowedIntegrations })
  });
  return result.session;
}

export async function syncIntegration(id: string): Promise<void> {
  await request(`/api/integrations/${id}/sync`, { method: 'POST' });
}

export async function disconnectIntegration(id: string): Promise<void> {
  await request(`/api/integrations/${id}`, { method: 'DELETE' });
}

export async function importMarketplace(provider: 'upwork' | 'fiverr' | 'contra' | 'generic', csv: string): Promise<{ imported: number; skipped: number }> {
  return request('/api/imports/marketplace', { method: 'POST', body: JSON.stringify({ provider, csv }) });
}

export async function importCommercialDocument(input: {
  file: File;
  clientName?: string;
  contactName?: string;
  clientEmail?: string;
  projectName?: string;
  currency?: string;
}): Promise<{
  extractionMethod: 'model' | 'deterministic';
  filename: string;
  textCharacters: number;
  contractTitle: string;
  scopeItems: number;
  clauses: number;
  milestones: number;
}> {
  const form = new FormData();
  form.append('file', input.file);
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'file' && value) form.append(key, String(value));
  }
  const response = await fetch('/api/imports/document', { method: 'POST', body: form, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(body.error ?? 'Document import failed', response.status);
  }
  return response.json();
}

export async function updateAutomationRule(type: RecommendationType, input: Omit<AutomationRule, 'id' | 'recommendationType'>): Promise<AutomationRule[]> {
  const result = await request<{ rules: AutomationRule[] }>(`/api/automation/rules/${type}`, { method: 'PUT', body: JSON.stringify(input) });
  return result.rules;
}

export async function runAutomation(): Promise<{ prepared: number; executed: number; failed: number }> {
  return request('/api/automation/run', { method: 'POST' });
}



export async function getPlaybooks(): Promise<PlaybookManifest[]> {
  const result = await request<{ playbooks: PlaybookManifest[] }>('/api/playbooks');
  return result.playbooks;
}

export async function startPlaybook(id: string, input: unknown, version?: string): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(`/api/playbooks/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ input: input ?? {}, ...(version ? { version } : {}) })
  });
  return result.run;
}

export async function getPlaybookRuns(filters: { status?: PlaybookRunStatus; limit?: number } = {}): Promise<PlaybookRun[]> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.limit) query.set('limit', String(filters.limit));
  const result = await request<{ runs: PlaybookRun[] }>(`/api/playbook-runs${query.size ? `?${query}` : ''}`);
  return result.runs;
}

export async function getPlaybookRun(id: string): Promise<PlaybookRun> {
  const result = await request<{ run: PlaybookRun }>(`/api/playbook-runs/${encodeURIComponent(id)}`);
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
    method: 'POST', body: JSON.stringify(input)
  });
  return result.policies;
}

export async function deletePolicy(id: string): Promise<void> {
  await request(`/api/policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getAgentTokens(): Promise<AgentTokenSummary[]> {
  const result = await request<{ tokens: AgentTokenSummary[] }>('/api/agent-tokens');
  return result.tokens;
}

export async function createAgentToken(input: {
  name: string;
  scopes?: AgentScope[];
  expiresAt?: string | null;
}): Promise<{ token: string; record: AgentTokenSummary }> {
  return request('/api/agent-tokens', { method: 'POST', body: JSON.stringify(input) });
}

export async function revokeAgentToken(id: string): Promise<void> {
  await request(`/api/agent-tokens/${id}`, { method: 'DELETE' });
}


export async function getPublicRegistryModules(): Promise<PublicRegistryModule[]> {
  const result = await request<{ modules: PublicRegistryModule[] }>('/api/public/modules');
  return result.modules;
}

export async function getRegistryPublishers(): Promise<RegistryPublisher[]> {
  const result = await request<{ publishers: RegistryPublisher[] }>('/api/registry/publishers');
  return result.publishers;
}

export async function createRegistryPublisher(input: {
  slug: string;
  displayName: string;
  publicKeyPem: string;
}): Promise<RegistryPublisher> {
  const result = await request<{ publisher: RegistryPublisher }>('/api/registry/publishers', {
    method: 'POST', body: JSON.stringify(input)
  });
  return result.publisher;
}

export async function publishRegistryModule(input: {
  moduleId: string;
  publisherId: string;
  manifest: Record<string, unknown>;
  signature: string;
  sbom: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const result = await request<{ release: Record<string, unknown> }>(
    `/api/registry/modules/${encodeURIComponent(input.moduleId)}/releases`,
    { method: 'POST', body: JSON.stringify({ publisherId: input.publisherId, manifest: input.manifest, signature: input.signature, sbom: input.sbom }) }
  );
  return result.release;
}

export async function getInstalledRegistryModules(): Promise<InstalledCommunityModule[]> {
  const result = await request<{ modules: InstalledCommunityModule[] }>('/api/registry/installations');
  return result.modules;
}

export async function installRegistryModule(moduleId: string, version: string, config: Record<string, unknown> = {}): Promise<void> {
  await request(`/api/registry/modules/${encodeURIComponent(moduleId)}/install`, {
    method: 'POST', body: JSON.stringify({ version, config })
  });
}

export async function uninstallRegistryModule(moduleId: string): Promise<void> {
  await request(`/api/registry/modules/${encodeURIComponent(moduleId)}/install`, { method: 'DELETE' });
}
