import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './config.js';

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
