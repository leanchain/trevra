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

export const OBSERVATION_METRICS = [
  'meta.active_ads',
  'social.followers',
  'social.posts_30d',
  'newsletter.posts_30d'
] as const;

export type ObservationMetric = (typeof OBSERVATION_METRICS)[number];

/**
 * One raw external measurement. Prefer this over a pre-interpreted observation
 * when the source can expose stable numbers: Trevra owns the baseline, change
 * threshold and signal semantics so collectors stay stateless and replaceable.
 */
export interface ExternalMeasurement {
  metric: ObservationMetric | string;
  /** e.g. `instagram:brand` when one provider reports several social profiles. */
  scope: string | null;
  value: number;
  evidenceUrl: string;
  observedAt: string;
}

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
  /** Optional raw measurements; Trevra diffs/persists these when sweep context is available. */
  measurements?: ExternalMeasurement[];
  warnings: string[];
}

export interface ObservationAccountContext {
  socialProfiles?: readonly { platform: string; handle: string; url: string }[];
  /** Verified numeric Facebook Page ids supplied explicitly on the account. Never inferred by name. */
  metaPageIds?: readonly string[];
  newsletterSignups?: readonly { sourceUrl: string; provider: string | null; key: string }[];
  newsletterPublications?: readonly {
    platform: 'substack' | 'beehiiv';
    url: string;
    feedUrl: string;
  }[];
}

export interface ObservationProviderOptions {
  credentials: CredentialAccessor;
  fetchImpl?: FetchLike;
  now: Date;
  /** First-party targets discovered during the same account crawl. */
  context?: ObservationAccountContext;
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
