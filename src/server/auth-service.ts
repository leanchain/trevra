import 'dotenv/config';
import type { IncomingHttpHeaders } from 'node:http';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import type { Db } from './db.js';
import { id } from './db.js';

const { Pool } = pg;
const production = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required; Better Auth uses PostgreSQL only');

const secret = process.env.BETTER_AUTH_SECRET ?? (production ? '' : 'development-only-trevra-secret-change-before-production');
if (production && secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters in production');

const baseURL = (process.env.BETTER_AUTH_URL ?? process.env.APP_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:43173').replace(/\/$/, '');
const trustedOrigins = (process.env.APP_ORIGIN ?? 'http://localhost:43173,http://localhost:43887')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
}

const socialProviders = googleClientId && googleClientSecret
  ? {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        disableDefaultScope: true,
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account' as const,
        redirectURI: `${baseURL}/api/auth/callback/google`
      }
    }
  : undefined;

const authPool = new Pool({
  connectionString,
  max: Number(process.env.AUTH_DATABASE_POOL_MAX ?? 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'trevra-auth'
});
authPool.on('error', (error) => console.error('Unexpected Better Auth PostgreSQL pool error', error));

export const auth = betterAuth({
  appName: 'Trevra',
  database: authPool,
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
  const lockClient = await authPool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext('trevra-better-auth-migrations'))");
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('trevra-better-auth-migrations'))").catch(() => undefined);
    lockClient.release();
  }
}

export async function resolveBetterAuthIdentity(db: Db, headers: IncomingHttpHeaders): Promise<{
  userId: string;
  workspaceId: string;
  email: string;
} | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user?.email) return null;

  const email = session.user.email.toLowerCase();
  const existing = await db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?')
    .get<{ id: string; workspace_id: string; email: string }>(email);
  if (existing) return { userId: existing.id, workspaceId: existing.workspace_id, email: existing.email };

  const now = new Date().toISOString();
  const displayName = session.user.name?.trim() || email.split('@')[0];
  try {
    return await db.transaction(async (tx) => {
      const raced = await tx.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=? FOR UPDATE')
        .get<{ id: string; workspace_id: string; email: string }>(email);
      if (raced) return { userId: raced.id, workspaceId: raced.workspace_id, email: raced.email };

      const workspaceId = id('ws');
      const userId = id('usr');
      await tx.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, `${displayName}'s Studio`, now);
      await tx.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)').run(userId, workspaceId, email, displayName, now);
      await tx.prepare('INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(workspaceId, 'EUR', displayName, 'Europe/Zurich', 0, now, now);
      await createDefaultAutomationRules(tx, workspaceId, now);
      await tx.prepare('INSERT INTO audit_events (id,workspace_id,actor_type,actor_id,event_type,entity_type,entity_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id('audit'), workspaceId, 'system', null, 'workspace.created', 'workspace', workspaceId, JSON.stringify({ authUserId: session.user.id }), now);
      return { userId, workspaceId, email };
    });
  } catch (error) {
    const raced = await db.prepare('SELECT id,workspace_id,email FROM users WHERE lower(email)=?')
      .get<{ id: string; workspace_id: string; email: string }>(email);
    if (raced) return { userId: raced.id, workspaceId: raced.workspace_id, email: raced.email };
    throw error;
  }
}

export async function closeAuthDatabase(): Promise<void> {
  await authPool.end();
}

async function createDefaultAutomationRules(db: Db, workspaceId: string, now: string): Promise<void> {
  const defaults = [
    ['stale_proposal', 'prepare', 0.85, 25000, 0, 1],
    ['overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
    ['scope_creep', 'suggest', 0.9, 5000, 0, 1],
    ['unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
  ] as const;
  for (const rule of defaults) {
    await db.prepare('INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id('rule'), workspaceId, ...rule, now, now);
  }
}
