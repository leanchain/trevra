import type { z } from 'zod';

export type JsonTemplate =
  | null
  | boolean
  | number
  | string
  | JsonTemplate[]
  | { [key: string]: JsonTemplate }
  | { $ref: string };

export interface SkillPlaybookStep {
  id: string;
  type: 'skill';
  skillId: string;
  input: JsonTemplate;
  needs?: string[];
  retry?: { maxAttempts: number; delaySeconds?: number };
}

export interface ActionPlaybookStep {
  id: string;
  type: 'action';
  actionType: string;
  payload: JsonTemplate;
  approvalStepId: string;
  needs?: string[];
  retry?: { maxAttempts: number; delaySeconds?: number };
}

export interface ApprovalPlaybookStep {
  id: string;
  type: 'approval';
  title: string;
  payload: JsonTemplate;
  needs?: string[];
}

export type PlaybookStep = SkillPlaybookStep | ApprovalPlaybookStep | ActionPlaybookStep;

export interface PlaybookDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  steps: PlaybookStep[];
  output?: JsonTemplate;
  source?: { type: 'builtin' | 'github' | 'community'; ref?: string };
}

export type PlaybookRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type PlaybookStepStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';

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
