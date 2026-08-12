import { z } from 'zod';

const booleanString = z.enum(['true', 'false']);
const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional()
);

export interface RuntimeConfig {
  production: boolean;
  port: number;
  automationIntervalMs: number;
  appOrigins: string[];
  /**
   * The self-hosted LinkedIn worker (docs/linkedin-outreach-plan.md §4.3).
   *
   * FAILS CLOSED WHERE IT MATTERS, AND ONLY THERE. `hosted` is the gate this
   * exists for and it is unconditional: a hosted, multi-tenant Trevra taking
   * custody of one human's LinkedIn session is the exposure the whole design
   * avoids, so no environment variable can turn it back on.
   *
   * Everywhere else it defaults ON, because the only deployment that can use
   * this is a self-hoster on their own machine, automating their own account,
   * with Trevra never holding a credential (§4.1) -- and an opt-in flag bought
   * nothing but a checklist step. `TREVRA_LINKEDIN_LOCAL=false` still turns it
   * off for a self-hoster who wants it off.
   *
   * `hosted` rides along so the one-line refusals downstream can say WHY it is
   * off without re-reading the environment.
   */
  linkedinLocalWorker: { enabled: boolean; profileDir: string | null; hosted: boolean };
  /**
   * The self-hosted Reddit worker, on exactly the terms above.
   *
   * A SECOND FIELD RATHER THAN A SECOND USE OF THE FIRST. The two workers sign
   * into two different accounts, keep two different browser profiles, and get
   * banned independently -- so a self-hoster who wants LinkedIn off and Reddit
   * on (or the reverse) must be able to say so, and `TREVRA_LINKEDIN_LOCAL`
   * cannot be the switch for a platform it does not name.
   *
   * `hosted` is the same unconditional gate, read from the same deployment
   * mode: no environment variable turns Reddit custody back on in a
   * multi-tenant deployment.
   */
  redditLocalWorker: { enabled: boolean; profileDir: string | null; hosted: boolean };
}

/**
 * Just the LinkedIn worker's slice of the environment.
 *
 * Split out because the host-side CLI (`npm run linkedin:worker`) needs this
 * rule and nothing else: making an operator supply a DATABASE_URL before they
 * are allowed to open a browser at all would be a config error standing
 * between them and the one thing they are trying to do. ONE definition of the
 * gate, read from two places.
 */
export function linkedInWorkerConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig['linkedinLocalWorker'] {
  const parsed = z.object({
    TREVRA_LINKEDIN_LOCAL: booleanString.optional(),
    TREVRA_DEPLOYMENT_MODE: z.enum(['local', 'hosted']).default('local'),
    TREVRA_LINKEDIN_PROFILE_DIR: z.string().optional()
  }).parse(env);
  return {
    // Hosted is the hard no. Otherwise on, unless explicitly switched off.
    enabled: parsed.TREVRA_DEPLOYMENT_MODE !== 'hosted' && parsed.TREVRA_LINKEDIN_LOCAL !== 'false',
    profileDir: parsed.TREVRA_LINKEDIN_PROFILE_DIR ?? null,
    hosted: parsed.TREVRA_DEPLOYMENT_MODE === 'hosted'
  };
}

/**
 * Just the Reddit worker's slice of the environment.
 *
 * Split out for the same reason as {@link linkedInWorkerConfig}: the host-side
 * CLI (`npm run reddit:worker`) needs this rule and nothing else, and making an
 * operator supply a DATABASE_URL before they are allowed to open a browser
 * would be a config error standing between them and the one thing they are
 * trying to do. ONE definition of the gate, read from two places.
 */
export function redditWorkerConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig['redditLocalWorker'] {
  const parsed = z.object({
    TREVRA_REDDIT_LOCAL: booleanString.optional(),
    TREVRA_DEPLOYMENT_MODE: z.enum(['local', 'hosted']).default('local'),
    TREVRA_REDDIT_PROFILE_DIR: z.string().optional()
  }).parse(env);
  return {
    // Hosted is the hard no. Otherwise on, unless explicitly switched off.
    enabled: parsed.TREVRA_DEPLOYMENT_MODE !== 'hosted' && parsed.TREVRA_REDDIT_LOCAL !== 'false',
    profileDir: parsed.TREVRA_REDDIT_PROFILE_DIR ?? null,
    hosted: parsed.TREVRA_DEPLOYMENT_MODE === 'hosted'
  };
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
    PUBLIC_REGISTRY_API_URL: optionalUrl,
    PUBLIC_REGISTRY_CORS_ORIGIN: z.string().optional(),
    TREVRA_SANDBOX_GATEWAY_URL: optionalUrl,
    TREVRA_SANDBOX_GATEWAY_TOKEN: z.string().optional(),
    TREVRA_REMOTE_ACTION_ADAPTERS_JSON: z.string().optional(),
    COOKIE_SECURE: booleanString.default(production ? 'true' : 'false'),
    ALLOW_DEMO_AUTH: booleanString.optional(),
    ALLOW_SIMULATED_EXECUTION: booleanString.optional(),
    BETTER_AUTH_SECRET: z.string().optional(),
    BETTER_AUTH_URL: optionalUrl,
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    PUBLIC_SITE_URL: optionalUrl,
    PUBLIC_SUPPORT_EMAIL: z.string().email().optional(),
    SECURITY_CONTACT_EMAIL: z.string().email().optional(),
    MARKETING_HASH_SALT: z.string().optional(),
    TRACTION_ADMIN_TOKEN: z.string().optional(),
    TREVRA_AGENT_TOKEN_PEPPER: z.string().optional(),
    TREVRA_SECRETS_KEY: z.string().optional(),
    // Self-host escape hatch: lets the hosted agent dial a private/loopback model
    // endpoint. Off by default because baseUrl is workspace-supplied.
    TREVRA_ALLOW_PRIVATE_MODEL_HOSTS: booleanString.optional(),
    // Run the hosted agent through a local subscription CLI instead of a BYOK
    // model key. Self-hosted only -- see the gate below and src/server/agent/cli.ts.
    TREVRA_AGENT_CLI: z.enum(['claude', 'codex']).optional(),
    TREVRA_AGENT_CLI_BIN: z.string().optional(),
    TREVRA_AGENT_CLI_MODEL: z.string().optional(),
    TREVRA_AGENT_CLI_MCP_COMMAND: z.string().optional(),
    // How the CLI gets its subscription inside a container: a token, or a
    // mounted credential directory. Both optional -- on a host where the CLI is
    // already signed in as the user running Trevra, neither is needed.
    TREVRA_AGENT_CLI_OAUTH_TOKEN: z.string().optional(),
    TREVRA_AGENT_CLI_HOME: z.string().optional(),
    INDEXNOW_KEY: z.string().optional(),
    NANGO_API_KEY: z.string().optional(),
    NANGO_WEBHOOK_SIGNING_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Opt-OUT for the local LinkedIn worker. Absent means on, except in hosted
    // mode where the gate below is unconditional.
    TREVRA_LINKEDIN_LOCAL: booleanString.optional(),
    // What kind of deployment this is. Defaults to 'local' because that is
    // what a self-hoster running `npm start` has, and because the only thing
    // this value can do is REMOVE a capability -- defaulting it wrong in the
    // permissive direction is the mistake that matters.
    TREVRA_DEPLOYMENT_MODE: z.enum(['local','hosted']).default('local'),
    // Chrome profile the operator logged into LinkedIn with by hand. Absent
    // means ~/.trevra/linkedin-profile, resolved by the worker rather than
    // here: $HOME belongs to the process that launches the browser.
    TREVRA_LINKEDIN_PROFILE_DIR: z.string().optional(),
    // The Reddit pair, on the same terms as the LinkedIn pair above: opt-OUT,
    // and a SEPARATE browser profile, because one persistent user-data-dir can
    // hold one signed-in Chrome at a time.
    TREVRA_REDDIT_LOCAL: booleanString.optional(),
    TREVRA_REDDIT_PROFILE_DIR: z.string().optional()
  }).parse(env);

  if (!/^postgres(?:ql)?:\/\//i.test(base.DATABASE_URL)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  if (Boolean(base.GOOGLE_CLIENT_ID?.trim()) !== Boolean(base.GOOGLE_CLIENT_SECRET?.trim())) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  }
  if (base.INDEXNOW_KEY && !/^[A-Za-z0-9._-]{8,128}$/.test(base.INDEXNOW_KEY)) throw new Error('INDEXNOW_KEY must contain 8-128 URL-safe characters');
  // Unconditional, and checked in every mode rather than only in production:
  // the CLI is signed in as one human under a personal subscription, so a
  // hosted Trevra billing other tenants' agent runs to it breaches that
  // subscription. cli.ts refuses this combination too; failing at startup is
  // how an operator finds out before a run does.
  if (base.TREVRA_AGENT_CLI && base.TREVRA_DEPLOYMENT_MODE === 'hosted') {
    throw new Error('TREVRA_AGENT_CLI cannot be set when TREVRA_DEPLOYMENT_MODE=hosted; a personal Claude or Codex subscription must not back other tenants\' agent runs. Use a BYOK model key instead');
  }
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
    // Optional: absent means BYOK is off, which is a legitimate deployment. Present and malformed is not.
    if (base.TREVRA_SECRETS_KEY && (!/^[A-Za-z0-9+/]+={0,2}$/.test(base.TREVRA_SECRETS_KEY) || Buffer.from(base.TREVRA_SECRETS_KEY, 'base64').byteLength !== 32)) problems.push('TREVRA_SECRETS_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)');
    if (base.COOKIE_SECURE !== 'true') problems.push('COOKIE_SECURE must be true');
    if (!base.NANGO_API_KEY) problems.push('NANGO_API_KEY is required for live integrations');
    if (!base.NANGO_WEBHOOK_SIGNING_KEY) problems.push('NANGO_WEBHOOK_SIGNING_KEY is required for signed integration webhooks');
    if (base.ALLOW_DEMO_AUTH === 'true') problems.push('ALLOW_DEMO_AUTH cannot be true');
    if (base.ALLOW_SIMULATED_EXECUTION === 'true') problems.push('ALLOW_SIMULATED_EXECUTION cannot be true');
    // The gate below already refuses this combination silently. This says so
    // out loud in production, because an operator who set both meant to enable
    // something, and a feature that is off for a reason nobody told them about
    // is a bug report waiting to happen.
    if (base.TREVRA_LINKEDIN_LOCAL === 'true' && base.TREVRA_DEPLOYMENT_MODE === 'hosted') problems.push('TREVRA_LINKEDIN_LOCAL cannot be true when TREVRA_DEPLOYMENT_MODE=hosted; the local LinkedIn worker drives a browser signed into one human account and is self-hosted only');
    if (base.TREVRA_REDDIT_LOCAL === 'true' && base.TREVRA_DEPLOYMENT_MODE === 'hosted') problems.push('TREVRA_REDDIT_LOCAL cannot be true when TREVRA_DEPLOYMENT_MODE=hosted; the local Reddit worker drives a browser signed into one human account and is self-hosted only');
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
    appOrigins: origins,
    linkedinLocalWorker: linkedInWorkerConfig(env),
    redditLocalWorker: redditWorkerConfig(env)
  };
}
