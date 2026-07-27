import { condition, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';

export interface PlaybookWorkflowInput {
  workspaceId: string;
  runId: string;
}

interface AdvanceResult {
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
}

const { advancePlaybook } = proxyActivities<{
  advancePlaybook(input: PlaybookWorkflowInput): Promise<AdvanceResult>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '1 second', maximumInterval: '1 minute', maximumAttempts: 100 }
});

export const resumePlaybookSignal = defineSignal('resumePlaybook');

export async function playbookOrchestratorWorkflow(input: PlaybookWorkflowInput): Promise<AdvanceResult> {
  let resumed = false;
  setHandler(resumePlaybookSignal, () => { resumed = true; });
  for (;;) {
    const result = await advancePlaybook(input);
    if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') return result;
    if (result.status === 'waiting_approval') {
      resumed = false;
      await condition(() => resumed);
      continue;
    }
    await sleep('1 second');
  }
}
