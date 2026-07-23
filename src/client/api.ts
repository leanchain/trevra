import type {
  AutomationRule,
  AvailableIntegration,
  ConnectionSummary,
  DashboardPayload,
  PreparedAction,
  RecommendationType
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

export async function getPublicConfig(): Promise<{ googleAuthEnabled: boolean; modelExtractionEnabled: boolean }> {
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
