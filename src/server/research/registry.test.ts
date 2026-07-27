import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_KEY, WITHHELD_PROVIDERS, getProvider, listProviders, registerProvider } from './registry.js';
import type { CredentialAccessor, ResearchProvider } from './types.js';

const noCredentials: CredentialAccessor = { get: () => undefined };
const withExa: CredentialAccessor = { get: (name) => (name === 'EXA_API_KEY' ? 'exa-key-123' : undefined) };

describe('research provider registry', () => {
  it('registers every shipped provider under a stable key', () => {
    expect(listProviders().map((provider) => provider.key)).toEqual(['exa', 'seed']);
    expect(getProvider('nope')).toBeUndefined();
  });

  it('defaults to the credential-free provider, so sourcing is never a stub', () => {
    const fallback = getProvider(DEFAULT_PROVIDER_KEY);
    expect(fallback?.key).toBe('seed');
    expect(fallback?.credentialEnvVar).toBeNull();
    expect(fallback?.availability(noCredentials).mode).toBe('ready');
  });

  it('never overwrites an already-registered key', () => {
    const imposter = { ...(getProvider('seed') as ResearchProvider), name: 'Imposter' };
    expect(registerProvider(imposter).name).toBe('Seed list');
  });

  it('reports availability honestly per credential state', () => {
    const exa = getProvider('exa') as ResearchProvider;
    expect(exa.availability(noCredentials).mode).toBe('needs-credential');
    expect(exa.availability(noCredentials).reason).toContain('EXA_API_KEY');
    expect(exa.availability(withExa).mode).toBe('ready');
  });

  it('marks a provider whose licence forbids storing its results', () => {
    expect(getProvider('seed')?.retention).toBe('default');
    expect(getProvider('exa')?.retention).toBe('none');
  });

  it('records Apollo as deliberately withheld, with the clause that decided it', () => {
    expect(listProviders().map((provider) => provider.key)).not.toContain('apollo');
    const apollo = WITHHELD_PROVIDERS.find((provider) => provider.key === 'apollo');
    expect(apollo?.clause).toContain('integrate the Apollo APIs with your own product or service');
    expect(apollo?.docsUrl).toBe('https://www.apollo.io/terms');
    expect(apollo?.observedAt).toBe('2026-07-27');
  });
});
