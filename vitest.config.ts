import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Order matters: the worker-db setup must claim this worker's isolated
    // database (see vitest.setup.worker-db.ts) before vitest.setup.ts or the
    // test file itself runs, since auth-service.ts reads DATABASE_URL at
    // import time, not lazily.
    setupFiles: ['./vitest.setup.worker-db.ts', './vitest.setup.ts'],
    // Each worker gets its own Postgres database (vitest.setup.worker-db.ts),
    // so files on different workers no longer share the one fixed demo
    // workspace `resetDemoData()` deletes and reseeds -- safe to parallelize.
    fileParallelism: true,
    // Bounded rather than left at vitest's CPU-count default: every worker
    // opens its own connection pools (app pool + better-auth pool), and an
    // unbounded worker count could push total connections toward Postgres's
    // default max_connections (100) on a big-core CI box. Override with
    // VITEST_MAX_WORKERS if a given machine can safely take more.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
    hookTimeout: 120_000,
    testTimeout: 60_000
  }
});
