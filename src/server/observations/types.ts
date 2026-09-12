import type { FetchLike } from '../skills/guard.js';
import type { CredentialAccessor, ProviderAvailability } from '../research/types.js';

export const OBSERVATION_SURFACES = [
  'meta_ads',
  'products',
  'newsletter',
  'ecommerce_apps',
  'social',
  'site'
] as const;

export type ObservationSurface = (typeof OBSERVATION_SURFACES)[number];

/**
 * One already-interpreted external observation. The provider is responsible
 * for deciding that a measurement changed; Trevra is responsible for refusing
 * unevidenced events, deduping them, decaying them, and combining independent
 * kinds in the account scorer.
 */
export interface ExternalObservation {
  kind: string;
  detail: string;
  previous: string | null;
  current: string | null;
  evidenceUrl: string;
  observedAt: string;
}

export interface ObservationResult {
  providerKey: string;
  observations: ExternalObservation[];
  warnings: string[];
}

export interface ObservationProviderOptions {
  credentials: CredentialAccessor;
  fetchImpl?: FetchLike;
  now: Date;
}

export interface ObservationProvider {
  key: string;
  name: string;
  docsUrl: string | null;
  credentialEnvVar: string | null;
  surfaces: readonly ObservationSurface[];
  availability(credentials: CredentialAccessor): ProviderAvailability;
  observe(domain: string, options: ObservationProviderOptions): Promise<ObservationResult>;
}
