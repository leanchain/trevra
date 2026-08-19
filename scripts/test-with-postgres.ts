import { spawn } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const container = await new PostgreSqlContainer('postgres:17-alpine')
  .withDatabase('trevra_test')
  .withUsername('trevra')
  .withPassword('trevra-test-password')
  .start();

const env = {
  ...process.env,
  DATABASE_URL: container.getConnectionUri(),
  TEST_DATABASE_URL: container.getConnectionUri(),
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:43173,http://localhost:43887',
  BETTER_AUTH_URL: 'http://localhost:43173',
  BETTER_AUTH_SECRET: 'test-only-better-auth-secret-with-more-than-32-characters',
  // Test routes exercise the same encrypted custody path production uses. A
  // fixed test-only key keeps those writes sealed while tests that specifically
  // cover the no-key refusal delete/override it explicitly.
  TREVRA_SECRETS_KEY: Buffer.alloc(32, 23).toString('base64'),
  COOKIE_SECURE: 'false',
  ALLOW_DEMO_AUTH: 'true',
  ALLOW_SIMULATED_EXECUTION: 'true',
  // vitest.config.ts now runs up to 4 workers in parallel (vitest.setup.worker-db.ts
  // gives each its own database), each opening an app pool (this) and a
  // better-auth pool (AUTH_DATABASE_POOL_MAX, defaults to 5) -- capped so
  // 4 workers can never approach Postgres's default max_connections (100).
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '5'
};

try {
  const exitCode = await new Promise<number>((resolve) => {
    // Anything after the script name is passed straight to vitest, so a single
    // file or directory can be run against the same ephemeral Postgres:
    //   npx tsx scripts/test-with-postgres.ts src/server/secrets
    const child = spawn(
      process.execPath,
      ['./node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        env,
        stdio: 'inherit'
      }
    );
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
  process.exitCode = exitCode;
} finally {
  await container.stop();
}
