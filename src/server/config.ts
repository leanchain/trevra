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
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    APP_ORIGIN: z.string().default('http://localhost:5173,http://localhost:8787'),
    DATABASE_URL: z.string().min(1),
    AUTOMATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
    COOKIE_SECURE: booleanString.default(production ? 'true' : 'false'),
    ALLOW_DEMO_AUTH: booleanString.optional(),
    ALLOW_SIMULATED_EXECUTION: booleanString.optional(),
    BETTER_AUTH_SECRET: z.string().optional(),
    BETTER_AUTH_URL: z.string().url().optional(),
    NANGO_API_KEY: z.string().optional(),
    NANGO_WEBHOOK_SIGNING_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional()
  }).parse(env);

  if (!/^postgres(?:ql)?:\/\//i.test(base.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  const origins = base.APP_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
  for (const origin of origins) z.string().url().parse(origin);

  if (production) {
    const problems: string[] = [];
    if (!base.BETTER_AUTH_SECRET || base.BETTER_AUTH_SECRET.length < 32) problems.push('BETTER_AUTH_SECRET must contain at least 32 characters');
    if (!base.BETTER_AUTH_URL) problems.push('BETTER_AUTH_URL is required');
    if (base.COOKIE_SECURE !== 'true') problems.push('COOKIE_SECURE must be true');
    if (!base.NANGO_API_KEY) problems.push('NANGO_API_KEY is required for live integrations');
    if (!base.NANGO_WEBHOOK_SIGNING_KEY) problems.push('NANGO_WEBHOOK_SIGNING_KEY is required for signed integration webhooks');
    if (base.ALLOW_DEMO_AUTH === 'true') problems.push('ALLOW_DEMO_AUTH cannot be true');
    if (base.ALLOW_SIMULATED_EXECUTION === 'true') problems.push('ALLOW_SIMULATED_EXECUTION cannot be true');
    if (base.STRIPE_SECRET_KEY && !base.STRIPE_WEBHOOK_SECRET) problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is configured');
    if (problems.length > 0) throw new Error(`Invalid production configuration:\n- ${problems.join('\n- ')}`);
  }

  return {
    production,
    port: base.PORT,
    automationIntervalMs: base.AUTOMATION_INTERVAL_MS,
    appOrigins: origins
  };
}
