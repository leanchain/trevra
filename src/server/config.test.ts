import { describe, expect, it } from 'vitest';
import { linkedInWorkerConfig, redditWorkerConfig, validateEnvironment } from './config.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://trevra:password@localhost:5432/trevra',
  APP_ORIGIN: 'http://localhost:43173,http://localhost:43887'
};

describe('runtime configuration', () => {
  it('treats empty optional URL environment values as unset', () => {
    expect(() => validateEnvironment({
      ...base,
      PUBLIC_REGISTRY_API_URL: '',
      TREVRA_SANDBOX_GATEWAY_URL: '',
      BETTER_AUTH_URL: '',
      PUBLIC_SITE_URL: ''
    })).not.toThrow();
  });
});

/**
 * The deployment-mode gate (docs/linkedin-outreach-plan.md §4.3).
 *
 * The local LinkedIn worker drives a browser that is signed into one human's
 * account. On a hosted instance that would be multi-tenant custody of somebody
 * else's LinkedIn session, which is the exposure the whole design exists to
 * avoid -- so 'hosted' is an unconditional no, whatever the operator set.
 *
 * OFF IS NOT THE DEFAULT ANYWHERE ELSE, and that is deliberate. The only
 * deployment that can run this at all is a self-hoster on their own machine,
 * so an opt-in flag protected nobody and cost every one of them a step. The
 * flag survives as an opt-OUT.
 */
describe('the LinkedIn local worker gate', () => {
  it('is on for a self-hoster who configured nothing at all', () => {
    const runtime = validateEnvironment({ ...base });
    expect(runtime.linkedinLocalWorker.enabled).toBe(true);
    expect(runtime.linkedinLocalWorker.hosted).toBe(false);
    // Unset here and resolved by the worker: $HOME belongs to the process that
    // launches the browser, not to whoever wrote the config.
    expect(runtime.linkedinLocalWorker.profileDir).toBeNull();
    expect(validateEnvironment({ ...base, TREVRA_DEPLOYMENT_MODE: 'local' }).linkedinLocalWorker.enabled).toBe(true);
    expect(validateEnvironment({ ...base, TREVRA_LINKEDIN_LOCAL: 'true' }).linkedinLocalWorker.enabled).toBe(true);
  });

  it('lets a self-hoster switch it off explicitly', () => {
    expect(validateEnvironment({ ...base, TREVRA_LINKEDIN_LOCAL: 'false' }).linkedinLocalWorker.enabled).toBe(false);
  });

  it('FAILS CLOSED: hosted mode cannot enable it, however hard the environment asks', () => {
    for (const asked of [undefined, 'true', 'false']) {
      const runtime = validateEnvironment({ ...base, ...(asked ? { TREVRA_LINKEDIN_LOCAL: asked } : {}), TREVRA_DEPLOYMENT_MODE: 'hosted' });
      expect(runtime.linkedinLocalWorker.enabled).toBe(false);
      expect(runtime.linkedinLocalWorker.hosted).toBe(true);
    }
  });

  it('refuses the combination out loud in production rather than silently ignoring it', () => {
    // The whole production block runs, so other problems are reported too; what
    // matters is that this one is named instead of being quietly dropped.
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      TREVRA_LINKEDIN_LOCAL: 'true',
      TREVRA_DEPLOYMENT_MODE: 'hosted'
    })).toThrow(/TREVRA_LINKEDIN_LOCAL cannot be true when TREVRA_DEPLOYMENT_MODE=hosted/);
  });

  it('carries a configured profile directory through untouched', () => {
    expect(
      validateEnvironment({ ...base, TREVRA_LINKEDIN_PROFILE_DIR: '/srv/linkedin-profile' })
        .linkedinLocalWorker.profileDir
    ).toBe('/srv/linkedin-profile');
  });
});

/**
 * The multi-tenancy gate itself.
 *
 * TREVRA_DEPLOYMENT_MODE decides whether the browser workers run, whether the
 * shared browser-profile paths are open, and whether one operator's personal
 * subscription CLI can back everyone's agent runs. Defaulting it is fine for a
 * developer; guessing it for a production deployment -- permissively, and
 * without saying so -- is not. 'local' is already multi-tenant in practice: a
 * workspace and organization are minted for every email that signs in.
 */
describe('the deployment-mode gate', () => {
  const production = { ...base, NODE_ENV: 'production' };

  /** The production block reports every problem at once; this reads them. */
  function problems(env: Record<string, string>): string {
    try {
      validateEnvironment(env);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('refuses to boot a production deployment that never says which it is', () => {
    expect(() => validateEnvironment(production)).toThrow(/TREVRA_DEPLOYMENT_MODE must be set explicitly when NODE_ENV=production/);
  });

  it('says exactly what to set, both ways, and what the guess would turn on', () => {
    const message = problems(production);
    expect(message).toContain('TREVRA_DEPLOYMENT_MODE=hosted');
    expect(message).toContain('TREVRA_DEPLOYMENT_MODE=local');
    expect(message).toMatch(/LinkedIn and Reddit local workers/);
  });

  it('is satisfied by either value, said explicitly', () => {
    // Other production requirements still fail here -- what matters is that
    // THIS complaint is gone once the operator has answered the question.
    for (const mode of ['local', 'hosted']) {
      expect(problems({ ...production, TREVRA_DEPLOYMENT_MODE: mode }))
        .not.toMatch(/TREVRA_DEPLOYMENT_MODE must be set explicitly/);
    }
  });

  it('leaves development and self-hosting alone: unset still means local there', () => {
    const runtime = validateEnvironment({ ...base });
    expect(runtime.linkedinLocalWorker.hosted).toBe(false);
    expect(runtime.redditLocalWorker.enabled).toBe(true);
  });

  it('applies to the worker CLIs too, which read their own slice of the environment', () => {
    expect(() => linkedInWorkerConfig({ NODE_ENV: 'production' })).toThrow(/TREVRA_DEPLOYMENT_MODE must be set explicitly/);
    expect(() => redditWorkerConfig({ NODE_ENV: 'production' })).toThrow(/TREVRA_DEPLOYMENT_MODE must be set explicitly/);
    // Answered, they behave exactly as before.
    expect(linkedInWorkerConfig({ NODE_ENV: 'production', TREVRA_DEPLOYMENT_MODE: 'hosted' })).toMatchObject({ enabled: false, hosted: true });
    expect(redditWorkerConfig({ NODE_ENV: 'production', TREVRA_DEPLOYMENT_MODE: 'local' })).toMatchObject({ enabled: true, hosted: false });
    // And a self-hoster running `npm run linkedin:worker` by hand is untouched.
    expect(linkedInWorkerConfig({}).enabled).toBe(true);
  });
});

/**
 * Credential custody on a hosted box.
 *
 * TREVRA_SECRETS_KEY is what encrypts every workspace's stored LinkedIn and
 * Reddit passwords and BYOK model keys. Absent, nothing announces itself: the
 * app boots, the setup screen reads green, and every save fails at runtime.
 * The shipped hosted runbook did not generate the key, so that is exactly how
 * a hosted box came up -- with custody silently off for other people's
 * credentials. Hosted must not boot without it; local still may, because a
 * self-hoster automating their own accounts stores nothing.
 */
describe('hosted credential custody', () => {
  const hosted = { ...base, NODE_ENV: 'production', TREVRA_DEPLOYMENT_MODE: 'hosted' };
  // 32 bytes, base64 -- the shape `openssl rand -base64 32` produces.
  const KEY = Buffer.alloc(32, 7).toString('base64');

  function problems(env: Record<string, string>): string {
    try {
      validateEnvironment(env);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('refuses to boot a hosted deployment with no secrets key', () => {
    const message = problems(hosted);
    expect(message).toMatch(/TREVRA_SECRETS_KEY is required when TREVRA_DEPLOYMENT_MODE=hosted/);
    // The message has to carry the fix, because the operator hitting this is
    // reading a boot log on a box that will not start.
    expect(message).toContain('openssl rand -base64 32');
    expect(message).toMatch(/no workspace can store a LinkedIn or Reddit credential/);
  });

  it('is satisfied by a well-formed key', () => {
    expect(problems({ ...hosted, TREVRA_SECRETS_KEY: KEY })).not.toMatch(/TREVRA_SECRETS_KEY/);
  });

  it('keeps "missing" and "malformed" as two different failures', () => {
    // Present but not 32 base64-encoded bytes: the operator generated
    // something, just not with the command above. Saying "required" here would
    // send them looking for a variable they had already set.
    const message = problems({ ...hosted, TREVRA_SECRETS_KEY: 'not-base64!!' });
    expect(message).toMatch(/TREVRA_SECRETS_KEY must be 32 random bytes/);
    expect(message).not.toMatch(/TREVRA_SECRETS_KEY is required/);
  });

  it('leaves a self-hosted production deployment free to run without one', () => {
    // The current contract, kept on purpose: the local workers drive a browser
    // profile the operator logged into by hand, so there is nothing to store,
    // and requiring a key would break every existing self-host install.
    expect(problems({ ...base, NODE_ENV: 'production', TREVRA_DEPLOYMENT_MODE: 'local' })).not.toMatch(/TREVRA_SECRETS_KEY/);
  });
});

describe('single-operator production on loopback', () => {
  const production = {
    ...base,
    NODE_ENV: 'production',
    TREVRA_DEPLOYMENT_MODE: 'local',
    APP_ORIGIN: 'http://localhost:43900',
    BETTER_AUTH_URL: 'http://localhost:43900',
    BETTER_AUTH_SECRET: 'a'.repeat(48),
    PUBLIC_SITE_URL: 'http://localhost:43900',
    PUBLIC_SUPPORT_EMAIL: 'support@trevra.local',
    SECURITY_CONTACT_EMAIL: 'security@trevra.local',
    MARKETING_HASH_SALT: 'b'.repeat(48),
    TRACTION_ADMIN_TOKEN: 'c'.repeat(48),
    TREVRA_AGENT_TOKEN_PEPPER: 'd'.repeat(48),
    INDEXNOW_KEY: 'selfhost-indexnow-key',
    COOKIE_SECURE: 'false'
  };

  it('boots without Nango when every browser-facing URL is loopback', () => {
    expect(() => validateEnvironment(production)).not.toThrow();
  });

  it('does not turn the loopback exception into an insecure LAN deployment', () => {
    expect(() => validateEnvironment({
      ...production,
      APP_ORIGIN: 'http://192.168.1.20:43900',
      BETTER_AUTH_URL: 'http://192.168.1.20:43900',
      PUBLIC_SITE_URL: 'http://192.168.1.20:43900'
    })).toThrow(/must use HTTPS/);
  });

  it('requires the Nango key and signing key together when local integrations are enabled', () => {
    expect(() => validateEnvironment({ ...production, NANGO_API_KEY: 'configured' }))
      .toThrow(/NANGO_WEBHOOK_SIGNING_KEY/);
    expect(() => validateEnvironment({ ...production, NANGO_WEBHOOK_SIGNING_KEY: 'configured' }))
      .toThrow(/NANGO_API_KEY/);
  });
});
