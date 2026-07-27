import { z } from 'zod';

const booleanString = z.enum(['true', 'false']);

export interface RuntimeConfig {
  production: boolean;
  port: number;
  automationIntervalMs: number;
  appOrigins: string[];
}

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === 'production';
  const base = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(43887),
    APP_ORIGIN: z.string().default('http://localhost:43173,http://localhost:43887'),
    DATABASE_URL: z.string().min(1),
    AUTOMATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
    TREVRA_ORCHESTRATOR: z.enum(['postgres','temporal']).default('postgres'),
    TEMPORAL_ADDRESS: z.string().optional(),
    TEMPORAL_NAMESPACE: z.string().optional(),
    TEMPORAL_TASK_QUEUE: z.string().optional(),
    TEMPORAL_TLS: booleanString.optional(),
    TEMPORAL_API_KEY: z.string().optional(),
    PUBLIC_REGISTRY_API_URL: z.string().url().optional(),
    PUBLIC_REGISTRY_CORS_ORIGIN: z.string().optional(),
    TREVRA_SANDBOX_GATEWAY_URL: z.string().url().optional(),
    TREVRA_SANDBOX_GATEWAY_TOKEN: z.string().optional(),
    TREVRA_REMOTE_ACTION_ADAPTERS_JSON: z.string().optional(),
    COOKIE_SECURE: booleanString.default(production ? 'true' : 'false'),
    ALLOW_DEMO_AUTH: booleanString.optional(),
    ALLOW_SIMULATED_EXECUTION: booleanString.optional(),
    BETTER_AUTH_SECRET: z.string().optional(),
    BETTER_AUTH_URL: z.string().url().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    PUBLIC_SITE_URL: z.string().url().optional(),
    PUBLIC_SUPPORT_EMAIL: z.string().email().optional(),
    SECURITY_CONTACT_EMAIL: z.string().email().optional(),
    MARKETING_HASH_SALT: z.string().optional(),
    TRACTION_ADMIN_TOKEN: z.string().optional(),
    TREVRA_AGENT_TOKEN_PEPPER: z.string().optional(),
    INDEXNOW_KEY: z.string().optional(),
    NANGO_API_KEY: z.string().optional(),
    NANGO_WEBHOOK_SIGNING_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional()
  }).parse(env);

  if (!/^postgres(?:ql)?:\/\//i.test(base.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  if (Boolean(base.GOOGLE_CLIENT_ID?.trim()) !== Boolean(base.GOOGLE_CLIENT_SECRET?.trim())) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  }
  if (base.INDEXNOW_KEY && !/^[A-Za-z0-9._-]{8,128}$/.test(base.INDEXNOW_KEY)) throw new Error('INDEXNOW_KEY must contain 8-128 URL-safe characters');
  const origins = base.APP_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
  for (const origin of origins) z.string().url().parse(origin);

  if (production) {
    const problems: string[] = [];
    if (!base.BETTER_AUTH_SECRET || base.BETTER_AUTH_SECRET.length < 32) problems.push('BETTER_AUTH_SECRET must contain at least 32 characters');
    if (!base.BETTER_AUTH_URL) problems.push('BETTER_AUTH_URL is required');
    if (!base.PUBLIC_SITE_URL?.startsWith('https://')) problems.push('PUBLIC_SITE_URL is required and must use HTTPS');
    if (!base.PUBLIC_SUPPORT_EMAIL) problems.push('PUBLIC_SUPPORT_EMAIL is required');
    if (!base.SECURITY_CONTACT_EMAIL) problems.push('SECURITY_CONTACT_EMAIL is required');
    if (!base.MARKETING_HASH_SALT || base.MARKETING_HASH_SALT.length < 32) problems.push('MARKETING_HASH_SALT must contain at least 32 characters');
    if (!base.TRACTION_ADMIN_TOKEN || base.TRACTION_ADMIN_TOKEN.length < 32) problems.push('TRACTION_ADMIN_TOKEN must contain at least 32 characters');
    if (!base.TREVRA_AGENT_TOKEN_PEPPER || base.TREVRA_AGENT_TOKEN_PEPPER.length < 32) problems.push('TREVRA_AGENT_TOKEN_PEPPER must contain at least 32 characters');
    if (!base.INDEXNOW_KEY) problems.push('INDEXNOW_KEY is required');
    if (base.COOKIE_SECURE !== 'true') problems.push('COOKIE_SECURE must be true');
    if (!base.NANGO_API_KEY) problems.push('NANGO_API_KEY is required for live integrations');
    if (!base.NANGO_WEBHOOK_SIGNING_KEY) problems.push('NANGO_WEBHOOK_SIGNING_KEY is required for signed integration webhooks');
    if (base.ALLOW_DEMO_AUTH === 'true') problems.push('ALLOW_DEMO_AUTH cannot be true');
    if (base.ALLOW_SIMULATED_EXECUTION === 'true') problems.push('ALLOW_SIMULATED_EXECUTION cannot be true');
    if (base.STRIPE_SECRET_KEY && !base.STRIPE_WEBHOOK_SECRET) problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is configured');
    if (base.TREVRA_ORCHESTRATOR === 'temporal' && !base.TEMPORAL_ADDRESS) problems.push('TEMPORAL_ADDRESS is required when TREVRA_ORCHESTRATOR=temporal');
    if (base.TREVRA_SANDBOX_GATEWAY_URL && (!base.TREVRA_SANDBOX_GATEWAY_TOKEN || base.TREVRA_SANDBOX_GATEWAY_TOKEN.length < 32)) problems.push('TREVRA_SANDBOX_GATEWAY_TOKEN must contain at least 32 characters when a sandbox gateway is configured');
    if (base.TREVRA_REMOTE_ACTION_ADAPTERS_JSON) {
      try {
        const adapters = JSON.parse(base.TREVRA_REMOTE_ACTION_ADAPTERS_JSON) as unknown;
        if (!Array.isArray(adapters)) problems.push('TREVRA_REMOTE_ACTION_ADAPTERS_JSON must be a JSON array');
        else for (const adapter of adapters) {
          const endpoint = typeof adapter === 'object' && adapter !== null ? String((adapter as Record<string, unknown>).endpoint ?? '') : '';
          if (!endpoint.startsWith('https://')) problems.push('Every production remote action adapter endpoint must use HTTPS');
        }
      } catch { problems.push('TREVRA_REMOTE_ACTION_ADAPTERS_JSON must contain valid JSON'); }
    }
    if (problems.length > 0) throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
  }

  return {
    production,
    port: base.PORT,
    automationIntervalMs: base.AUTOMATION_INTERVAL_MS,
    appOrigins: origins
  };
}
