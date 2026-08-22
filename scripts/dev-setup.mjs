#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_ENV = join(ROOT, '.env.dev');
const DEV_EXAMPLE = join(ROOT, '.env.dev.example');
const DIRECT_ENV = join(ROOT, '.env');
const CLI = join(ROOT, 'packages', 'trevra-cli', 'bin', 'trevra.js');

function envValue(path, key) {
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

function ensureEnvValue(path, key, createValue, { replaceIf = () => false } = {}) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const current = index >= 0 ? lines[index].slice(key.length + 1).trim() : '';
  if (current && !replaceIf(current)) return current;
  const value = createValue();
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows ACLs do not use POSIX modes. */
  }
  return value;
}

if (!existsSync(DEV_ENV)) {
  copyFileSync(DEV_EXAMPLE, DEV_ENV);
  try {
    chmodSync(DEV_ENV, 0o600);
  } catch {
    /* Windows ACLs do not use POSIX modes. */
  }
  process.stdout.write('Created .env.dev from .env.dev.example.\n');
}

ensureEnvValue(DEV_ENV, 'TREVRA_SECRETS_KEY', () => randomBytes(32).toString('base64'));
ensureEnvValue(DEV_ENV, 'TREVRA_COMPANION_RELAY_URL', () => 'ws://127.0.0.1:8787');
ensureEnvValue(
  DEV_ENV,
  'NANGO_ENCRYPTION_KEY',
  () => randomBytes(32).toString('base64'),
  { replaceIf: (value) => value === 'uB4uY6dI5Zp2iYVg5m5V+M0r1fP9cS8yP0mT8wH9WkE=' }
);

// The direct `npm run dev` path uses .env instead of .env.dev. If the operator
// has opted into that path already, make Companion usable there too without
// creating a second environment file behind their back.
if (existsSync(DIRECT_ENV)) {
  ensureEnvValue(DIRECT_ENV, 'TREVRA_SECRETS_KEY', () => randomBytes(32).toString('base64'));
  ensureEnvValue(DIRECT_ENV, 'TREVRA_COMPANION_RELAY_URL', () => 'ws://127.0.0.1:43887');
}

if ((envValue(DEV_ENV, 'TREVRA_LINKEDIN_LOCAL') ?? 'true').toLowerCase() !== 'false') {
  execFileSync(process.execPath, [CLI, 'linkedin', 'setup'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
} else {
  process.stdout.write('TREVRA_LINKEDIN_LOCAL=false; skipping Companion installation.\n');
}

process.stdout.write(
  'Development setup is ready. Start the stack with: docker compose --env-file .env.dev -f compose.dev.yml up --build\n'
);
