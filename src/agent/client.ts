import { readFileSync } from 'node:fs';

/**
 * A token from a file rather than the environment.
 *
 * Environment variables of a child process are readable on most systems, and
 * a token passed on a command line is readable by anyone who can run `ps`. The
 * CLI agent backend (`src/server/agent/cli.ts`) therefore writes its single-run
 * token to a 0600 file and passes the PATH. Absent or unreadable means "not
 * configured", which the constructor reports as a missing token.
 */
function readTokenFile(path: string | undefined): string {
  if (!path?.trim()) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export interface TrevraSkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  sideEffect: 'none' | 'network-read' | 'external-write';
  requiresApproval: boolean;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface TrevraSkillRun {
  id: string;
  skillId: string;
  skillVersion: string;
  workspaceId: string;
  status: 'ok' | 'error';
  input: unknown;
  output: unknown;
  error: string | null;
  evidence: Array<{ label: string; detail: string; sourceUrl?: string | null }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface TrevraPlaybookManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  pinnedVersion: string | null;
  inputSchema: Record<string, unknown>;
  definition: Record<string, unknown>;
}

export interface TrevraPlaybookRun {
  id: string;
  workspaceId: string;
  playbookId: string;
  playbookVersion: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  input: unknown;
  output: unknown;
  error: string | null;
  currentStepId: string | null;
  correlationId: string;
  steps: Array<Record<string, unknown>>;
}

export class TrevraAgentClient {
  readonly baseUrl: string;
  private readonly token: string;

  /**
   * The Authorization header for the resolved token.
   *
   * Exists so the stdio bridge does not rebuild it from `TREVRA_AGENT_TOKEN`
   * itself: this class already resolves the token from the environment OR from
   * TREVRA_AGENT_TOKEN_FILE, and a second, simpler resolution somewhere else
   * silently sends `Bearer ` when the token came from the file.
   */
  get authorization(): string {
    return `Bearer ${this.token}`;
  }

  constructor(options: { baseUrl?: string; token?: string } = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.TREVRA_API_URL ??
      'http://localhost:43887'
    ).replace(/\/$/, '');
    // `||`, not `??`: an EMPTY variable must fall through to the file. A shell
    // or a compose file that declares TREVRA_AGENT_TOKEN and leaves it blank
    // otherwise wins the `??` and the token file is never opened -- the bridge
    // then reports a missing token while holding a perfectly good one.
    this.token =
      options.token?.trim() ||
      process.env.TREVRA_AGENT_TOKEN?.trim() ||
      readTokenFile(process.env.TREVRA_AGENT_TOKEN_FILE);
    if (!this.token) {
      throw new Error(
        'TREVRA_AGENT_TOKEN is required (or TREVRA_AGENT_TOKEN_FILE, a path to a file holding one). Create one in Trevra Autopilot or POST /api/agent-tokens from an authenticated session.'
      );
    }
  }

  async listSkills(): Promise<TrevraSkillManifest[]> {
    const result = await this.request<{ skills: TrevraSkillManifest[] }>('/api/agent/skills');
    return result.skills;
  }

  async listPlaybooks(): Promise<TrevraPlaybookManifest[]> {
    const result = await this.request<{ playbooks: TrevraPlaybookManifest[] }>(
      '/api/agent/playbooks'
    );
    return result.playbooks;
  }
  async startPlaybook(
    playbookId: string,
    input: unknown,
    version?: string
  ): Promise<TrevraPlaybookRun> {
    const result = await this.request<{ run: TrevraPlaybookRun }>(
      `/api/agent/playbooks/${encodeURIComponent(playbookId)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({ input: input ?? {}, ...(version ? { version } : {}) })
      }
    );
    return result.run;
  }

  async listPlaybookRuns(
    filters: { status?: TrevraPlaybookRun['status']; limit?: number } = {}
  ): Promise<TrevraPlaybookRun[]> {
    const query = new URLSearchParams();
    if (filters.status) query.set('status', filters.status);
    if (filters.limit) query.set('limit', String(filters.limit));
    const result = await this.request<{ runs: TrevraPlaybookRun[] }>(
      `/api/agent/playbook-runs${query.size ? `?${query}` : ''}`
    );
    return result.runs;
  }

  async getPlaybookRun(runId: string): Promise<TrevraPlaybookRun> {
    const result = await this.request<{ run: TrevraPlaybookRun }>(
      `/api/agent/playbook-runs/${encodeURIComponent(runId)}`
    );
    return result.run;
  }

  async listEvents(
    filters: { streamType?: string; streamId?: string; correlationId?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    const query = new URLSearchParams();
    if (filters.streamType) query.set('streamType', filters.streamType);
    if (filters.streamId) query.set('streamId', filters.streamId);
    if (filters.correlationId) query.set('correlationId', filters.correlationId);
    if (filters.limit) query.set('limit', String(filters.limit));
    const result = await this.request<{ events: unknown[] }>(
      `/api/agent/events${query.size ? `?${query}` : ''}`
    );
    return result.events;
  }

  async runSkill(
    skillId: string,
    input: unknown
  ): Promise<{
    run: TrevraSkillRun;
    approvalRequired: boolean;
    sideEffect: TrevraSkillManifest['sideEffect'];
  }> {
    return this.request(`/api/agent/skills/${encodeURIComponent(skillId)}/run`, {
      method: 'POST',
      body: JSON.stringify(input ?? {})
    });
  }

  async listRuns(
    filters: { skillId?: string; status?: 'ok' | 'error'; limit?: number } = {}
  ): Promise<TrevraSkillRun[]> {
    const query = new URLSearchParams();
    if (filters.skillId) query.set('skillId', filters.skillId);
    if (filters.status) query.set('status', filters.status);
    if (filters.limit) query.set('limit', String(filters.limit));
    const result = await this.request<{ runs: TrevraSkillRun[] }>(
      `/api/agent/runs${query.size ? `?${query}` : ''}`
    );
    return result.runs;
  }

  async getRun(runId: string): Promise<TrevraSkillRun> {
    const result = await this.request<{ run: TrevraSkillRun }>(
      `/api/agent/runs/${encodeURIComponent(runId)}`
    );
    return result.run;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(Number(process.env.TREVRA_AGENT_TIMEOUT_MS ?? 60_000))
    });
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    } & T;
    if (!response.ok)
      throw new Error(body.error || `Trevra API request failed with ${response.status}`);
    return body;
  }
}
