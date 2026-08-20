import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const POSTGRES_DB = 'trevra_test';
const POSTGRES_USER = 'trevra';
const POSTGRES_PASSWORD = 'trevra-test-password';
const containerName = `trevra-test-${process.pid}-${randomUUID().slice(0, 8)}`;

async function docker(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `docker ${args.join(' ')} failed with exit ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`
          )
        );
    });
  });
}

async function waitForPostgres(containerId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await docker([
        'exec',
        containerId,
        'pg_isready',
        '--host',
        '127.0.0.1',
        '--username',
        POSTGRES_USER,
        '--dbname',
        POSTGRES_DB
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  let logs = '';
  try {
    logs = await docker(['logs', containerId]);
  } catch {
    // The readiness error below is sufficient if Docker cannot return logs.
  }
  throw new Error(`PostgreSQL test container did not become ready.${logs ? `\n${logs}` : ''}`);
}

// Do not use Testcontainers for this shared Docker daemon. Its containers carry
// the global `org.testcontainers=true` label, and a Ryuk reaper started by an
// unrelated Testcontainers process can sweep them while this Vitest run is
// still active. Plain Docker keeps ownership local to this script: one create,
// one explicit cleanup, and no cross-process reaper label.
const containerId = await docker([
  'run',
  '--rm',
  '--detach',
  '--name',
  containerName,
  '--env',
  `POSTGRES_DB=${POSTGRES_DB}`,
  '--env',
  `POSTGRES_USER=${POSTGRES_USER}`,
  '--env',
  `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
  '--publish',
  '127.0.0.1::5432',
  'postgres:17-alpine'
]);

try {
  await waitForPostgres(containerId);
  const portMapping = await docker(['port', containerId, '5432/tcp']);
  const port = portMapping.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not determine PostgreSQL test port from: ${portMapping}`);

  const connectionUri = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
  const env = {
    ...process.env,
    DATABASE_URL: connectionUri,
    TEST_DATABASE_URL: connectionUri,
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
  try {
    await docker(['rm', '--force', containerId]);
  } catch {
    // `--rm` may already have removed a container that exited on its own.
  }
}
