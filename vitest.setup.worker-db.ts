/**
 * Give every vitest worker its own Postgres database, so `fileParallelism`
 * can be turned back on.
 *
 * WHY THIS EXISTS: `scripts/test-with-postgres.ts` starts exactly one
 * ephemeral Postgres container for the whole run, and `resetDemoData()`
 * (`src/server/db.ts`) deletes and reseeds ONE fixed workspace --
 * `DEMO_WORKSPACE_ID = 'ws_demo'` -- on every call. Two test files sharing
 * that workspace concurrently would have one file's `beforeEach` deleting
 * rows the other file is mid-assertion against. `fileParallelism: false`
 * (the setting this file exists to remove) was the blunt fix: never let two
 * files touch the database at the same instant.
 *
 * THE ACTUAL FIX is a physical isolation boundary instead of a scheduling
 * one: each vitest worker gets its OWN database inside the same container
 * (`trevra_test_w<N>`, keyed by `VITEST_POOL_ID`), created and migrated once
 * per worker, then reused by every test file that worker runs. Files on
 * DIFFERENT workers can now race all they like -- they are not touching the
 * same rows, or even the same database.
 *
 * IDEMPOTENT BY CONSTRUCTION: `setupFiles` re-run for every test file, not
 * once per worker. The second (and 30th) file handled by a worker sees
 * `process.env.TEST_DATABASE_URL` already pointing at that worker's
 * database (env vars persist for the worker process's lifetime even though
 * vitest gives each file a fresh module registry), so the `CREATE DATABASE`
 * path below is skipped after the first file -- one cheap SELECT, no-op.
 *
 * `openDatabase()` (`src/server/db.ts`) already treats "run migrations" as
 * "skip if none are pending," so the one-time-per-worker migration cost is
 * the only new expense; every test file's actual setup work is unchanged.
 */
import pg from 'pg';

const { Client } = pg;

const baseUrl = process.env.TEST_DATABASE_URL;

if (baseUrl) {
  const poolId = process.env.VITEST_POOL_ID ?? '1';
  const dbName = `trevra_test_w${poolId}`;
  const url = new URL(baseUrl);

  if (url.pathname.replace(/^\//, '') !== dbName) {
    const admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (existing.rowCount === 0) {
        // Not parameterizable -- CREATE DATABASE takes an identifier, not a
        // value. `dbName` is our own template-literal construction from a
        // vitest-assigned integer, never user input.
        await admin.query(`CREATE DATABASE "${dbName}"`);
      }
    } finally {
      await admin.end();
    }

    url.pathname = `/${dbName}`;
    const workerUrl = url.toString();
    // Both names matter: test files pass TEST_DATABASE_URL explicitly to
    // openDatabase(); auth-service.ts reads DATABASE_URL directly at import
    // time. Setting both before the test file (and therefore auth-service.ts)
    // is ever imported in this worker is what makes better-auth land on the
    // same isolated database as everything else this worker touches.
    process.env.DATABASE_URL = workerUrl;
    process.env.TEST_DATABASE_URL = workerUrl;
  }
}
