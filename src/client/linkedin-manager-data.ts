export interface ManagerAccount {
  seatKey: string;
  label: string;
  profileUrl: string | null;
  timezone: string;
  posture: string;
  workingDays: number[];
  workingStart: string;
  workingEnd: string;
  operatorLimits: { invite: number; message: number; profile_view: number; follow: number };
}

export interface ManagerLeadList {
  id: string;
  name: string;
  sourceType: string;
  sourceRef: string | null;
  count: number;
  createdAt: string;
}

export interface ManagerContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  email: string | null;
  country: string | null;
  linkedinUrl: string | null;
}

export interface ManagerWorkflowStep {
  id: string;
  kind: 'invite' | 'withdraw' | 'profile_view' | 'message' | 'manual_message' | 'follow';
  delay: { amount: number; unit: 'hours' | 'days' };
  config: Record<string, unknown>;
}

export interface ManagerWorkflow {
  id: string;
  name: string;
  status: string;
  definition: { version: 1; steps: ManagerWorkflowStep[] };
  updatedAt: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) }
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export async function loadManagerAccounts(): Promise<ManagerAccount[]> {
  return (await request<{ accounts: ManagerAccount[] }>('/api/linkedin/manager/accounts')).accounts;
}
export async function addManagerAccount(input: { seatKey: string; label: string; timezone: string; profileUrl?: string | null }): Promise<ManagerAccount> {
  return (await request<{ account: ManagerAccount }>('/api/linkedin/manager/accounts', { method: 'POST', body: JSON.stringify(input) })).account;
}
export async function saveManagerAccount(seatKey: string, patch: Partial<Pick<ManagerAccount, 'label' | 'timezone' | 'workingDays' | 'workingStart' | 'workingEnd' | 'operatorLimits'>>): Promise<ManagerAccount> {
  return (await request<{ account: ManagerAccount }>(`/api/linkedin/manager/accounts/${encodeURIComponent(seatKey)}`, { method: 'PATCH', body: JSON.stringify(patch) })).account;
}
export async function loadManagerLists(): Promise<ManagerLeadList[]> {
  return (await request<{ lists: ManagerLeadList[] }>('/api/linkedin/manager/lists')).lists;
}
export async function loadManagerContacts(listId: string): Promise<ManagerContact[]> {
  return (await request<{ contacts: ManagerContact[] }>(`/api/linkedin/manager/lists/${encodeURIComponent(listId)}/contacts`)).contacts;
}
export async function saveManagerContact(contactId: string, patch: Partial<Pick<ManagerContact, 'firstName' | 'lastName' | 'company' | 'email' | 'country' | 'linkedinUrl'>>): Promise<ManagerContact> {
  return (await request<{ contact: ManagerContact }>(`/api/linkedin/manager/contacts/${encodeURIComponent(contactId)}`, { method: 'PATCH', body: JSON.stringify(patch) })).contact;
}
export async function loadManagerWorkflows(): Promise<ManagerWorkflow[]> {
  return (await request<{ workflows: ManagerWorkflow[] }>('/api/linkedin/manager/workflows')).workflows;
}
export async function addManagerWorkflow(name: string, definition: ManagerWorkflow['definition']): Promise<ManagerWorkflow> {
  return (await request<{ workflow: ManagerWorkflow }>('/api/linkedin/manager/workflows', { method: 'POST', body: JSON.stringify({ name, definition }) })).workflow;
}
export async function saveManagerWorkflow(workflowId: string, patch: { name?: string; definition?: ManagerWorkflow['definition']; status?: 'active' | 'archived' }): Promise<ManagerWorkflow> {
  return (await request<{ workflow: ManagerWorkflow }>(`/api/linkedin/manager/workflows/${encodeURIComponent(workflowId)}`, { method: 'PATCH', body: JSON.stringify(patch) })).workflow;
}
