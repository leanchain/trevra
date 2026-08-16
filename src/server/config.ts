import { z } from 'zod';
import { browserProviderSettings } from './browser/provider.js';

const booleanString = z.enum(['true', 'false']);
const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional()
);

/** HTTP is acceptable in production only when the browser can reach Trevra
 * exclusively through its own loopback interface. This is the self-hosted,
 * single-operator deployment: no packet crosses a network and Docker publishes
 * the port on 127.0.0.1 only. Anything remotely reachable still requires TLS. */
function isLoopbackHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
/**
 * The one value Trevra refuses to guess in production.
 *
 * WHY THIS IS NOT SIMPLY A DEFAULT. `TREVRA_DEPLOYMENT_MODE` is the
 * multi-tenancy gate, and 'hosted' is the only value that removes anything:
 * it switches off the local LinkedIn and Reddit workers (each of which drives
 * a browser signed into ONE human's account), keeps the shared browser-profile
 * paths shut, and makes `src/server/agent/cli.ts` refuse to back every
 * tenant's agent run with one operator's personal subscription. Left unset,
 * all three go live -- quietly, and in the permissive direction.
 *
 * The schemas below still DEFAULT to 'local', and that default is still right
 * where it applies: `npm run dev`, or a self-hoster running
 * `npm run linkedin:worker` on their own laptop. What is not right is letting
 * the default stand in PRODUCTION, where it is not a considered choice but a
 * guess about who else can reach this deployment.
 *
 * AND 'LOCAL' IS ALREADY MULTI-TENANT IN PRACTICE: a fresh workspace and
 * organization are minted for every new email that signs in, so "there is only
 * me on this machine" stops being true the moment a second person can reach
 * the URL. An operator who means 'local' in production should have to say so
 * out loud, having thought about that sentence.
 *
 * So: fail to boot. An operator reading a startup error fixes this in a
 * minute; every other way of finding out is an incident.
 */
const DEPLOYMENT_MODE_REQUIRED =
  'TREVRA_DEPLOYMENT_MODE must be set explicitly when NODE_ENV=production; Trevra will not guess it. '
  + 'Set TREVRA_DEPLOYMENT_MODE=hosted if this deployment serves workspaces belonging to anyone but you '
  + '(a fresh workspace is created for every email that signs in, so this is true of any deployment strangers can reach), '
  + 'or TREVRA_DEPLOYMENT_MODE=local if you are self-hosting for yourself alone. '
  + 'Unset, it would fall back to local, which enables the LinkedIn and Reddit local workers (each driving a browser '
  + "signed into one human's account), the shared browser-profile paths, and the operator-wide subscription CLI agent "
  + 'backend: capabilities that are fine for one self-hoster and are not fine for a deployment with tenants';

/**
 * Enforced in all three places the mode is read, so no entry point can boot on
 * the guess -- the server (`validateEnvironment`) and both worker CLIs, which
 * deliberately read their own slice of the environment rather than the whole
 * of it.
 */
function requireExplicitDeploymentMode(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if ((env.TREVRA_DEPLOYMENT_MODE ?? '').trim()) return;
  throw new Error(DEPLOYMENT_MODE_REQUIRED);
}

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
  linkedinLocalWorker: { enabled: boolean; profileDir: string | null; hosted: boolean; remoteBrowser: boolean; headless: boolean };
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
  /**
   * Where this deployment's browsers live (docs/hosted-execution.md).
   *
   * REPORTING ONLY, and no secret in it: the label is a host name or the
   * operator's own word for the provider, never the endpoint (which carries the
   * API key) and never the key. The decisions are made by
   * `browserProviderSettings`, which every path reads from the environment
   * directly, so this field cannot become a second source of truth.
   */
  browserProvider: { kind: 'local' | 'remote'; provider: string | null };
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
  requireExplicitDeploymentMode(env);
  const parsed = z.object({
    TREVRA_LINKEDIN_LOCAL: booleanString.optional(),
    TREVRA_LINKEDIN_HEADLESS: booleanString.optional(),
    TREVRA_DEPLOYMENT_MODE: z.enum(['local', 'hosted']).default('local'),
    TREVRA_LINKEDIN_PROFILE_DIR: z.string().optional()
  }).parse(env);
  const hosted = parsed.TREVRA_DEPLOYMENT_MODE === 'hosted';
  // THE ONE GATE THAT MOVED, AND EXACTLY HOW FAR.
  //
  // 'hosted' used to be an unconditional no, because a hosted container has no
  // display, no Chromium and no profile directory belonging to the person whose
  // account it is -- so the only browser it could have driven was nobody's. A
  // remote browser provider (docs/hosted-execution.md) supplies that missing
  // browser, which is the entire reason this expression may now be true.
  //
  // IT IS NOT THE WHOLE PERMISSION. This says the DEPLOYMENT can drive a
  // browser; it says nothing about any workspace. A hosted seat still cannot be
  // run, and a hosted credential still cannot be stored, until that workspace's
  // owner has recorded an explicit authorisation -- `hostedExecutionGate` in
  // `linkedin/hosted-execution.ts`, enforced at the store and at the runner
  // rather than here, because it is a per-tenant fact and this file reads only
  // the environment. Hosted with no provider is the old refusal, unchanged.
  const remoteBrowser = browserProviderSettings(env).kind === 'remote';
  return {
    enabled: (!hosted || remoteBrowser) && parsed.TREVRA_LINKEDIN_LOCAL !== 'false',
    profileDir: parsed.TREVRA_LINKEDIN_PROFILE_DIR ?? null,
    hosted,
    remoteBrowser,
    // MAY THIS PROCESS OPEN A BROWSER NOBODY CAN SEE? Default yes, because a
    // hosted deployment with a remote browser is headless by definition and a
    // container that is the ONLY worker is better than no worker. Set false on
    // the container in a stack where the operator runs `npm run
    // linkedin:worker` on their own machine: the container then parks the work
    // for the machine with a display instead of racing it from a GPU-less
    // container with a SwiftShader WebGL fingerprint. See
    // `LinkedInLocalWorkerConfig.headless`.
    headless: parsed.TREVRA_LINKEDIN_HEADLESS !== 'false'
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
  requireExplicitDeploymentMode(env);
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
    //
    // Which is exactly why the default is NOT allowed to stand in production:
    // see DEPLOYMENT_MODE_REQUIRED at the top of this file. The default is for
    // a developer and a self-hoster; a production deployment must say which it
    // is, because 'local' is already multi-tenant in practice (one workspace
    // and organization per email that signs in) and the guess only ever errs
    // towards more capability.
    TREVRA_DEPLOYMENT_MODE: z.enum(['local','hosted']).default('local'),
    // Chrome profile the operator logged into LinkedIn with by hand. Absent
    // means ~/.trevra/linkedin-profile, resolved by the worker rather than
    // here: $HOME belongs to the process that launches the browser.
    TREVRA_LINKEDIN_PROFILE_DIR: z.string().optional(),
    // The Reddit pair, on the same terms as the LinkedIn pair above: opt-OUT,
    // and a SEPARATE browser profile, because one persistent user-data-dir can
    // hold one signed-in Chrome at a time.
    TREVRA_REDDIT_LOCAL: booleanString.optional(),
    TREVRA_REDDIT_PROFILE_DIR: z.string().optional(),
    // WHERE THE BROWSERS ARE. 'local' is this machine's own Chromium at a
    // persistent profile directory -- what every deployment did before hosted
    // execution existed, and still the default. 'remote' attaches to a cloud
    // browser over CDP, which is the only way a container with no display can
    // drive one at all. Validated in `browser/provider.ts`, which owns the
    // shape of every variable below; declared here so `npm start` fails on a
    // typo rather than silently running local.
    TREVRA_BROWSER_PROVIDER: z.enum(['local', 'remote']).optional(),
    TREVRA_BROWSER_CDP_URL: z.string().optional(),
    TREVRA_BROWSER_API_KEY: z.string().optional(),
    TREVRA_BROWSER_CONNECT: z.enum(['cdp', 'playwright']).optional(),
    TREVRA_BROWSER_HEADERS: z.string().optional(),
    TREVRA_BROWSER_LABEL: z.string().optional()
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
  // Read once, before the production block, because three of the checks below
  // ask about it and `browserProviderSettings` reports rather than throws.
  const browser = browserProviderSettings(env);

  if (production) {
    const problems: string[] = [];
    const localLoopback = base.TREVRA_DEPLOYMENT_MODE === 'local'
      && isLoopbackHttpUrl(base.PUBLIC_SITE_URL)
      && isLoopbackHttpUrl(base.BETTER_AUTH_URL)
      && origins.length > 0
      && origins.every((origin) => isLoopbackHttpUrl(origin));
    // First, because it decides what the rest of this list even means: the
    // guards below fire on TREVRA_*_LOCAL === 'true' being EXPLICIT, which an
    // unset mode never is, so an operator who set nothing got the permissive
    // path and no complaint. `base.TREVRA_DEPLOYMENT_MODE` cannot answer this
    // -- zod has already replaced the absence with the default -- so the raw
    // environment is what gets checked.
    if (!(env.TREVRA_DEPLOYMENT_MODE ?? '').trim()) problems.push(DEPLOYMENT_MODE_REQUIRED);
    if (!base.BETTER_AUTH_SECRET || base.BETTER_AUTH_SECRET.length < 32) problems.push('BETTER_AUTH_SECRET must contain at least 32 characters');
    if (!base.BETTER_AUTH_URL) problems.push('BETTER_AUTH_URL is required');
    if (base.TREVRA_DEPLOYMENT_MODE === 'hosted' && !(base.GOOGLE_CLIENT_ID && base.GOOGLE_CLIENT_SECRET)) {
      problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when TREVRA_DEPLOYMENT_MODE=hosted because hosted password signup is disabled until verified transactional email is configured');
    }
    if (!base.PUBLIC_SITE_URL || (!base.PUBLIC_SITE_URL.startsWith('https://') && !localLoopback)) {
      problems.push('PUBLIC_SITE_URL is required and must use HTTPS, except for a TREVRA_DEPLOYMENT_MODE=local deployment whose APP_ORIGIN, BETTER_AUTH_URL and PUBLIC_SITE_URL are all loopback HTTP URLs');
    }
    if (!base.PUBLIC_SUPPORT_EMAIL) problems.push('PUBLIC_SUPPORT_EMAIL is required');
    if (!base.SECURITY_CONTACT_EMAIL) problems.push('SECURITY_CONTACT_EMAIL is required');
    if (!base.MARKETING_HASH_SALT || base.MARKETING_HASH_SALT.length < 32) problems.push('MARKETING_HASH_SALT must contain at least 32 characters');
    if (!base.TRACTION_ADMIN_TOKEN || base.TRACTION_ADMIN_TOKEN.length < 32) problems.push('TRACTION_ADMIN_TOKEN must contain at least 32 characters');
    if (!base.TREVRA_AGENT_TOKEN_PEPPER || base.TREVRA_AGENT_TOKEN_PEPPER.length < 32) problems.push('TREVRA_AGENT_TOKEN_PEPPER must contain at least 32 characters');
    if (!base.INDEXNOW_KEY) problems.push('INDEXNOW_KEY is required');
    // REQUIRED ON HOSTED, optional otherwise -- two rules, deliberately, and
    // two separate failures so the message tells the operator which mistake
    // they made.
    //
    // Absent on a hosted box, nothing looks broken: the app boots, the setup
    // screen reads green, and every attempt to store a credential fails deep
    // in `secrets/crypto.ts` where no operator is watching. What is actually
    // off is CUSTODY -- no workspace can save a LinkedIn or Reddit password or
    // a BYOK model key, on the one kind of deployment where those belong to
    // other people. `infra/oracle/gen-secrets.sh` did not generate this key,
    // so that is the state a hosted box came up in. Refusing to boot is the
    // only version of this an operator finds out about in time.
    //
    // Still optional on 'local', and that is the current contract rather than
    // an oversight: a self-hoster automating their own accounts stores nothing
    // (the local workers drive a browser profile they logged into by hand) and
    // may run BYOK-less on their own subscription, so requiring a key would
    // break every existing self-host install on upgrade to buy them nothing.
    // The comment below is the older half of the same rule.
    if (base.TREVRA_DEPLOYMENT_MODE === 'hosted' && !base.TREVRA_SECRETS_KEY) {
      problems.push('TREVRA_SECRETS_KEY is required when TREVRA_DEPLOYMENT_MODE=hosted: without it no workspace can store a LinkedIn or Reddit credential or a BYOK model key, and every save fails at runtime while the setup screen still reads green. Generate one with `openssl rand -base64 32`');
    }
    // Optional: absent means BYOK is off, which is a legitimate deployment. Present and malformed is not.
    if (base.TREVRA_SECRETS_KEY && (!/^[A-Za-z0-9+/]+={0,2}$/.test(base.TREVRA_SECRETS_KEY) || Buffer.from(base.TREVRA_SECRETS_KEY, 'base64').byteLength !== 32)) problems.push('TREVRA_SECRETS_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)');
    if (base.COOKIE_SECURE !== 'true' && !localLoopback) {
      problems.push('COOKIE_SECURE must be true except for a loopback-only TREVRA_DEPLOYMENT_MODE=local deployment');
    }
    // Nango is a capability, not a prerequisite for a single-operator core
    // deployment. Hosted always requires signed integration traffic. Local may
    // omit both values entirely; if either is configured, require the pair so a
    // half-configured webhook cannot silently become an unsigned production path.
    const nangoConfigured = Boolean(base.NANGO_API_KEY || base.NANGO_WEBHOOK_SIGNING_KEY);
    if (base.TREVRA_DEPLOYMENT_MODE === 'hosted' || nangoConfigured) {
      if (!base.NANGO_API_KEY) problems.push('NANGO_API_KEY is required for live integrations');
      if (!base.NANGO_WEBHOOK_SIGNING_KEY) problems.push('NANGO_WEBHOOK_SIGNING_KEY is required for signed integration webhooks');
    }
    if (base.ALLOW_DEMO_AUTH === 'true') problems.push('ALLOW_DEMO_AUTH cannot be true');
    if (base.TREVRA_LINKEDIN_LOCAL === 'true' && base.TREVRA_DEPLOYMENT_MODE === 'hosted' && !browser.remote) {
      problems.push(
        'TREVRA_LINKEDIN_LOCAL cannot be true when TREVRA_DEPLOYMENT_MODE=hosted and no remote browser is configured; '
        + 'a hosted container has no display, no Chromium and no browser profile of its own, so there is nothing for it to drive. '
        + 'Set TREVRA_BROWSER_PROVIDER=remote with TREVRA_BROWSER_CDP_URL to run seats server-side (docs/hosted-execution.md), or leave this unset and run `npm run linkedin:worker` on a machine with a display'
      );
    }
    // A REMOTE PROVIDER THAT WAS ASKED FOR AND DOES NOT HOLD TOGETHER stops the
    // boot, rather than falling back to local. The fallback is the dangerous
    // outcome here: a hosted deployment that quietly reverts to a local browser
    // it does not have is a queue that fills up forever with no error anywhere,
    // which is the exact failure this whole capability exists to end.
    if (browser.problem) problems.push(browser.problem);
    // PLAINTEXT CDP IS NOT ACCEPTABLE IN PRODUCTION. The connect URL carries the
    // provider API key, and on the `{proxyUrl}` form it carries the seat's proxy
    // password too; the socket then carries the member's own session cookies.
    if (browser.remote && /^(ws|http):\/\//i.test(browser.remote.endpointTemplate)) {
      problems.push('TREVRA_BROWSER_CDP_URL must use wss:// or https:// in production: the connect URL carries the provider API key and the session carries LinkedIn cookies');
    }
    // A REMOTE BROWSER WITH NO KEY TO SEAL SESSIONS IS A REMOTE BROWSER THAT
    // CANNOT KEEP A SEAT SIGNED IN. There is no profile directory out there, so
    // the session round-trips through `linkedin_seat_sessions` encrypted, and
    // with no key every run would be a brand-new device sign-in.
    if (browser.remote && !base.TREVRA_SECRETS_KEY) {
      problems.push('TREVRA_SECRETS_KEY is required when TREVRA_BROWSER_PROVIDER=remote: a browser attached over CDP has no profile directory, so each seat\'s signed-in session is stored encrypted and without a key every run would be a new-device sign-in. Generate one with `openssl rand -base64 32`');
    }
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
    redditLocalWorker: redditWorkerConfig(env),
    browserProvider: { kind: browser.kind, provider: browser.remote?.label ?? null }
  };
}
