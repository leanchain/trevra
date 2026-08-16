import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { linkedInWorkerConfig, validateEnvironment } from './config.js';

/**
 * THE ONE GATE THAT MOVED, AND EXACTLY HOW FAR.
 *
 * `TREVRA_DEPLOYMENT_MODE=hosted` used to switch the LinkedIn worker off
 * unconditionally, and the argument was never really about custody: a hosted
 * container has no display, no Chromium and no browser profile belonging to the
 * person whose account it is, so the only browser it could have driven was
 * nobody's. A remote browser provider supplies exactly that missing piece.
 *
 * What must remain true after the change, and is asserted below:
 *
 *   1. A HOSTED DEPLOYMENT WITH NO PROVIDER IS EXACTLY AS IT WAS. Same `false`,
 *      same refusals, same boot error. Nothing about its situation changed.
 *   2. A HOSTED DEPLOYMENT WITH A PROVIDER CAN RUN -- at the DEPLOYMENT level.
 *      Per-workspace authorisation is a separate gate in a separate file, and
 *      this flag never speaks for it.
 *   3. A REMOTE PROVIDER THAT DOES NOT HOLD TOGETHER STOPS THE BOOT rather than
 *      silently reverting to a local browser the container does not have --
 *      which would be a queue that fills up forever with no error anywhere.
 *   4. SELF-HOSTED IS UNTOUCHED, on every path.
 */

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://trevra:password@localhost:5432/trevra',
  APP_ORIGIN: 'http://localhost:43173,http://localhost:43887'
};

const REMOTE = {
  TREVRA_BROWSER_PROVIDER: 'remote',
  TREVRA_BROWSER_CDP_URL: 'wss://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}',
  TREVRA_BROWSER_API_KEY: 'sk-test'
};

/** Everything production insists on, so a test can vary one thing at a time. */
const production = {
  ...base,
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'a'.repeat(48),
  BETTER_AUTH_URL: 'https://app.example.com',
  GOOGLE_CLIENT_ID: 'hosted-test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'hosted-test-secret',
  PUBLIC_SITE_URL: 'https://example.com',
  PUBLIC_SUPPORT_EMAIL: 'support@example.com',
  SECURITY_CONTACT_EMAIL: 'security@example.com',
  MARKETING_HASH_SALT: 'b'.repeat(48),
  TRACTION_ADMIN_TOKEN: 'c'.repeat(48),
  TREVRA_AGENT_TOKEN_PEPPER: 'd'.repeat(48),
  INDEXNOW_KEY: 'indexnow-key-value',
  COOKIE_SECURE: 'true',
  NANGO_API_KEY: 'nango',
  NANGO_WEBHOOK_SIGNING_KEY: 'nango-signing',
  TREVRA_SECRETS_KEY: randomBytes(32).toString('base64')
};

describe('the hosted LinkedIn worker gate', () => {
  it('is still off on a hosted deployment with no remote browser', () => {
    const config = linkedInWorkerConfig({ ...base, TREVRA_DEPLOYMENT_MODE: 'hosted' });
    expect(config.enabled).toBe(false);
    expect(config.hosted).toBe(true);
    expect(config.remoteBrowser).toBe(false);
  });

  it('is on for a hosted deployment with a paired-computer relay, without pretending that relay is a cloud browser', () => {
    const config = linkedInWorkerConfig({
      ...base,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080',
      TREVRA_SECRETS_KEY: randomBytes(32).toString('base64')
    });
    expect(config.enabled).toBe(true);
    expect(config.hosted).toBe(true);
    expect(config.remoteBrowser).toBe(false);
    expect(config.companionBrowser).toBe(true);
  });

  it('is on for a hosted deployment WITH a remote browser', () => {
    const config = linkedInWorkerConfig({ ...base, ...REMOTE, TREVRA_DEPLOYMENT_MODE: 'hosted' });
    expect(config.enabled).toBe(true);
    // Still hosted, and still says so: the per-workspace authorisation gate
    // reads this, and a deployment that forgot it was hosted would skip it.
    expect(config.hosted).toBe(true);
    expect(config.remoteBrowser).toBe(true);
  });

  it('still honours the self-hoster\'s explicit off switch, on both providers', () => {
    expect(linkedInWorkerConfig({ ...base, TREVRA_LINKEDIN_LOCAL: 'false' }).enabled).toBe(false);
    expect(linkedInWorkerConfig({ ...base, ...REMOTE, TREVRA_DEPLOYMENT_MODE: 'hosted', TREVRA_LINKEDIN_LOCAL: 'false' }).enabled).toBe(false);
  });

  it('leaves a self-hosted deployment exactly as it was', () => {
    const config = linkedInWorkerConfig({ ...base });
    expect(config.enabled).toBe(true);
    expect(config.hosted).toBe(false);
    expect(config.remoteBrowser).toBe(false);
    expect(validateEnvironment({ ...base }).browserProvider).toEqual({ kind: 'local', provider: null });
  });

  it('reports which provider a deployment uses, by label and never by endpoint', () => {
    const runtime = validateEnvironment({ ...base, ...REMOTE, TREVRA_DEPLOYMENT_MODE: 'hosted' });
    expect(runtime.browserProvider.kind).toBe('remote');
    expect(runtime.browserProvider.provider).toBe('connect.example.com');
    // The endpoint carries the API key. It is never part of a reported value.
    expect(JSON.stringify(runtime)).not.toContain('sk-test');
  });
});

describe('booting a production deployment', () => {
  it('accepts hosted + companion relay with no cloud browser', () => {
    expect(() => validateEnvironment({
      ...production,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_COMPANION_RELAY_URL: 'ws://trevra:8080'
    })).not.toThrow();
  });

  it('accepts hosted + remote + an explicit TREVRA_LINKEDIN_LOCAL=true', () => {
    expect(() => validateEnvironment({
      ...production,
      ...REMOTE,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_LINKEDIN_LOCAL: 'true'
    })).not.toThrow();
  });

  it('still refuses hosted + TREVRA_LINKEDIN_LOCAL=true with no browser to drive', () => {
    expect(() => validateEnvironment({
      ...production,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_LINKEDIN_LOCAL: 'true'
    })).toThrow(/no remote browser is configured/);
  });

  it('refuses to boot on a remote provider that does not hold together, rather than falling back', () => {
    // The silent fallback is the dangerous outcome: a hosted box that reverts
    // to a local browser it does not have looks healthy and sends nothing.
    expect(() => validateEnvironment({
      ...production,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_BROWSER_PROVIDER: 'remote'
    })).toThrow(/TREVRA_BROWSER_CDP_URL/);

    expect(() => validateEnvironment({
      ...production,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'wss://x/',
      TREVRA_BROWSER_HEADERS: 'not json'
    })).toThrow(/TREVRA_BROWSER_HEADERS/);
  });

  it('refuses a plaintext CDP endpoint, which carries the key and then the cookies', () => {
    expect(() => validateEnvironment({
      ...production,
      TREVRA_DEPLOYMENT_MODE: 'hosted',
      TREVRA_BROWSER_PROVIDER: 'remote',
      TREVRA_BROWSER_CDP_URL: 'ws://connect.example.com/?apiKey={apiKey}&proxy={proxyUrl}'
    })).toThrow(/wss:\/\/ or https:\/\//);
  });

  it('refuses a remote provider with no key to seal sessions with', () => {
    const { TREVRA_SECRETS_KEY, ...noKey } = production;
    expect(() => validateEnvironment({
      ...noKey,
      ...REMOTE,
      // 'local' so the hosted-specific secrets-key rule is not what fires.
      TREVRA_DEPLOYMENT_MODE: 'local'
    })).toThrow(/TREVRA_SECRETS_KEY is required when TREVRA_BROWSER_PROVIDER=remote/);
  });

  it('still requires the deployment mode to be stated out loud', () => {
    const { TREVRA_DEPLOYMENT_MODE, ...unstated } = { ...production, TREVRA_DEPLOYMENT_MODE: 'hosted' };
    expect(() => validateEnvironment({ ...unstated, ...REMOTE })).toThrow(/TREVRA_DEPLOYMENT_MODE must be set explicitly/);
  });

  it('requires a verified OAuth identity path on hosted production', () => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ...noGoogle } = production;
    expect(() => validateEnvironment({ ...noGoogle, TREVRA_DEPLOYMENT_MODE: 'hosted' }))
      .toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required/);
  });

  it('boots a self-hosted production deployment with no browser variables at all', () => {
    expect(() => validateEnvironment({ ...production, TREVRA_DEPLOYMENT_MODE: 'local' })).not.toThrow();
  });
});
