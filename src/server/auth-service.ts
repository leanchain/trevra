import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import type { Db } from './db.js';
import { id } from './db.js';

const production = process.env.NODE_ENV === 'production';
const authPathInput = process.env.AUTH_DATABASE_PATH ?? (process.env.NODE_ENV === 'test' ? ':memory:' : './data/trevra-auth.db');
const authPath = authPathInput === ':memory:' ? authPathInput : resolve(authPathInput);
if (authPath !== ':memory:') mkdirSync(dirname(authPath), { recursive: true });

const secret = process.env.BETTER_AUTH_SECRET ?? (production ? '' : 'development-only-trevra-secret-change-before-production');
if (production && secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters in production');

const baseURL = process.env.BETTER_AUTH_URL ?? process.env.APP_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:5173';
const trustedOrigins = (process.env.APP_ORIGIN ?? 'http://localhost:5173,http://localhost:8787')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const socialProviders = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET
      }
    }
  : undefined;

const authDatabase = new Database(authPath);
authDatabase.pragma('journal_mode = WAL');
authDatabase.pragma('foreign_keys = ON');
authDatabase.pragma('busy_timeout = 5000');

export const auth = betterAuth({
  appName: 'Trevra',
  database: authDatabase,
  secret,
  baseURL,
  basePath: '/api/auth',
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    autoSignIn: true
  },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24
  },
  advanced: {
    cookiePrefix: 'trevra',
    useSecureCookies: production
  }
});

export async function migrateAuthDatabase(): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

export async function resolveBetterAuthIdentity(db: Db, headers: IncomingHttpHeaders): Promise<{
  userId: string;
  workspaceId: string;
  email: string;
} | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user?.email) return null;

  const email = session.user.email.toLowerCase();
  const existing = db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?').get(email) as {
    id: string;
    workspace_id: string;
    email: string;
  } | undefined;
  if (existing) return { userId: existing.id, workspaceId: existing.workspace_id, email: existing.email };

  const now = new Date().toISOString();
  const workspaceId = id('ws');
  const userId = id('usr');
  const displayName = session.user.name?.trim() || email.split('@')[0];
  const workspaceName = `${displayName}'s Studio`;

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, workspaceName, now);
    db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)').run(userId, workspaceId, email, displayName, now);
    db.prepare('INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(workspaceId, 'EUR', displayName, 'Europe/Zurich', 0, now, now);
    createDefaultAutomationRules(db, workspaceId, now);
    db.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id('audit'), workspaceId, 'system', null, 'workspace.created', 'workspace', workspaceId, JSON.stringify({ authUserId: session.user.id }), now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    const raced = db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?').get(email) as {
      id: string;
      workspace_id: string;
      email: string;
    } | undefined;
    if (raced) return { userId: raced.id, workspaceId: raced.workspace_id, email: raced.email };
    throw error;
  }

  return { userId, workspaceId, email };
}

export function closeAuthDatabase(): void {
  authDatabase.close();
}

function createDefaultAutomationRules(db: Db, workspaceId: string, now: string): void {
  const defaults = [
    ['stale_proposal', 'prepare', 0.85, 25000, 0, 1],
    ['overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
    ['scope_creep', 'suggest', 0.9, 5000, 0, 1],
    ['unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
  ] as const;
  const statement = db.prepare('INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const rule of defaults) statement.run(id('rule'), workspaceId, ...rule, now, now);
}
