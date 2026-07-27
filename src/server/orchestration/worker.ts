import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.js';
import { temporalConnectionOptions, temporalNamespace, temporalTaskQueue } from './client.js';

export async function startTemporalWorker(db: Db): Promise<{ shutdown(): Promise<void> }> {
  const connection = await NativeConnection.connect(temporalConnectionOptions());
  const source = import.meta.url.endsWith('.ts') ? './workflows.ts' : './workflows.js';
  const worker = await Worker.create({
    connection,
    namespace: temporalNamespace(),
    taskQueue: temporalTaskQueue(),
    workflowsPath: fileURLToPath(new URL(source, import.meta.url)),
    activities: {
      advancePlaybook: async (input: { workspaceId: string; runId: string }) => {
        const { advancePlaybookRun } = await import('../playbooks/engine.js');
        const run = await advancePlaybookRun(db, input.workspaceId, input.runId);
        return { status: run.status };
      }
    }
  });
  void worker.run().catch((error) => console.error('Temporal worker stopped', error));
  return {
    async shutdown() {
      worker.shutdown();
      await connection.close();
    }
  };
}
