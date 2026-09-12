import { envCredentials } from '../research/types.js';
import type { Db } from '../db.js';
import type { FetchLike } from '../skills/guard.js';
import { interpretMeasurements } from './measurements.js';
import { configuredHttpObservationProviders } from './providers/http.js';
import { configuredInstagramBusinessDiscoveryProviders } from './providers/instagram.js';
import { configuredSubstackPublicFeedProviders } from './providers/substack.js';
import type {
  ExternalObservation,
  ObservationAccountContext,
  ObservationProvider
} from './types.js';

export interface CollectObservationOptions {
  providers?: readonly ObservationProvider[];
  fetchImpl?: FetchLike;
  now?: Date;
  /** Required to turn raw provider measurements into stateful Trevra observations. */
  db?: Db;
  workspaceId?: string;
  context?: ObservationAccountContext;
}

export interface CollectedObservations {
  observations: ExternalObservation[];
  warnings: string[];
}

/**
 * Read every configured external observation source without letting one broken
 * source suppress the rest. Provider failure is degraded evidence, not proof
 * that the account did not move.
 */
export async function collectExternalObservations(
  domain: string,
  options: CollectObservationOptions = {}
): Promise<CollectedObservations> {
  const now = options.now ?? new Date();
  const providers = options.providers ?? [
    ...configuredSubstackPublicFeedProviders(),
    ...configuredInstagramBusinessDiscoveryProviders(),
    ...configuredHttpObservationProviders()
  ];
  const observations: ExternalObservation[] = [];
  const warnings: string[] = [];

  for (const provider of providers) {
    const available = provider.availability(envCredentials);
    if (available.mode !== 'ready') {
      warnings.push(`${provider.name}: ${available.reason}`);
      continue;
    }
    try {
      const result = await provider.observe(domain, {
        credentials: envCredentials,
        fetchImpl: options.fetchImpl,
        now,
        context: options.context
      });
      observations.push(...result.observations);
      warnings.push(...result.warnings);
      if (result.measurements?.length) {
        if (!options.db || !options.workspaceId) {
          warnings.push(
            `${provider.name} returned raw measurements, but no workspace persistence was supplied; measurements were not interpreted.`
          );
        } else {
          const interpreted = await interpretMeasurements({
            db: options.db,
            workspaceId: options.workspaceId,
            providerKey: provider.key,
            domain,
            measurements: result.measurements,
            now
          });
          observations.push(...interpreted.observations);
          warnings.push(...interpreted.warnings);
        }
      }
    } catch (cause) {
      warnings.push(
        `${provider.name} failed: ${cause instanceof Error ? cause.message : String(cause)}.`
      );
    }
  }

  return { observations, warnings };
}
