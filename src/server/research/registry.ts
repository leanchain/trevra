import { directoryProvider } from './providers/directory.js';
import { exaProvider } from './providers/exa.js';
import { configuredHttpSourceProviders } from './providers/http.js';
import { seedProvider } from './providers/seed.js';
import type { ResearchProvider, WithheldProvider } from './types.js';

/**
 * Research provider registry, mirroring `src/server/channels/registry.ts`:
 * an in-memory map keyed by provider key, first registration wins, listings
 * sorted so they are stable.
 *
 * Built-ins carry no operator-tunable persisted state. Deployment-owned HTTP
 * adapters are loaded from TREVRA_SOURCE_HTTP_PROVIDERS_JSON: the workspace may
 * select their registered key, but never supplies their endpoint or credential
 * name. That preserves a generic provider seam without giving a tenant an SSRF
 * or environment-secret primitive.
 */

const providers = new Map<string, ResearchProvider>();

export function registerProvider(provider: ResearchProvider): ResearchProvider {
  const existing = providers.get(provider.key);
  if (existing) return existing;
  providers.set(provider.key, provider);
  return provider;
}

export function getProvider(key: string): ResearchProvider | undefined {
  return providers.get(key);
}

export function listProviders(): ResearchProvider[] {
  return [...providers.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The always-works default, so sourcing never depends on a vendor relationship. */
export const DEFAULT_PROVIDER_KEY = 'seed';

for (const provider of [
  seedProvider,
  directoryProvider,
  exaProvider,
  ...configuredHttpSourceProviders()
]) {
  registerProvider(provider);
}

/**
 * Providers deliberately NOT shipped.
 *
 * Apollo was specified and then dropped after reading the terms rather than
 * the API reference. The endpoints are fine; the licence is not. Recording the
 * clause here is the point -- "we looked and decided no" is invisible six
 * months later, and an absence with no reason attached gets helpfully filled
 * in by the next person to read the roadmap.
 */
export const WITHHELD_PROVIDERS: readonly WithheldProvider[] = [
  {
    key: 'apollo',
    name: 'Apollo.io',
    docsUrl: 'https://www.apollo.io/terms',
    clause:
      "You may not access the APIs via a third party's API credentials or integrate the Apollo APIs with your own product or service.",
    reason:
      'Apollo ToS section 3 (API Usage Requirements -> Access and Integration) prohibits integrating the Apollo APIs with another product, unqualified. An Apollo adapter inside Trevra is that integration. The internal-tools carve-out in the General Usage Restrictions does not reach the API clause, so there is no configuration of this adapter that would be compliant -- it is absent by decision, not by backlog.',
    observedAt: '2026-07-27'
  }
];
