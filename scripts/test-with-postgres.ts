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
  APP_ORIGIN: 'http://localhost:5173,http://localhost:8787',
  BETTER_AUTH_URL: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'test-only-better-auth-secret-with-more-than-32-characters',
  COOKIE_SECURE: 'false',
  ALLOW_DEMO_AUTH: 'true',
  ALLOW_SIMULATED_EXECUTION: 'true'
};

try {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run'], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit'
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
  process.exitCode = exitCode;
} finally {
  await container.stop();
}
