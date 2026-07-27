import { Client, Connection } from '@temporalio/client';
import { playbookOrchestratorWorkflow, resumePlaybookSignal } from './workflows.js';

let clientPromise: Promise<Client> | null = null;

export function orchestrationMode(): 'postgres' | 'temporal' {
  return process.env.TREVRA_ORCHESTRATOR === 'temporal' ? 'temporal' : 'postgres';
}

export async function notifyTemporalPlaybook(input: { workspaceId: string; runId: string }): Promise<void> {
  if (orchestrationMode() !== 'temporal') return;
  const client = await getTemporalClient();
  const workflowId = temporalWorkflowId(input.runId);
  try {
    await client.workflow.start(playbookOrchestratorWorkflow, {
      taskQueue: temporalTaskQueue(),
      workflowId,
      args: [input]
    });
  } catch (error) {
    if (!isAlreadyStarted(error)) throw error;
    await client.workflow.getHandle(workflowId).signal(resumePlaybookSignal);
  }
}

async function getTemporalClient(): Promise<Client> {
  clientPromise ??= (async () => {
    const connection = await Connection.connect(temporalConnectionOptions());
    return new Client({ connection, namespace: temporalNamespace() });
  })();
  return clientPromise;
}

export function temporalConnectionOptions() {
  const tls = process.env.TEMPORAL_TLS === 'true' ? {} : undefined;
  const apiKey = process.env.TEMPORAL_API_KEY?.trim();
  return { address: process.env.TEMPORAL_ADDRESS?.trim() || 'localhost:7233', ...(tls ? { tls } : {}), ...(apiKey ? { apiKey } : {}) };
}
export function temporalNamespace(): string { return process.env.TEMPORAL_NAMESPACE?.trim() || 'default'; }
export function temporalTaskQueue(): string { return process.env.TEMPORAL_TASK_QUEUE?.trim() || 'trevra-playbooks'; }
function temporalWorkflowId(runId: string): string { return `trevra-playbook-${runId}`; }
function isAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && (error.name.includes('AlreadyStarted') || /already started|already exists/i.test(error.message));
}
