import type { Db } from '../db.js';
import { envCredentials } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { configuredBeseamCorpusProviders } from './providers/beseam-corpus.js';
import { configuredHttpObservationProviders } from './providers/http.js';
import type { ExternalObservation, ObservationProvider } from './types.js';

export interface CollectObservationOptions {
  providers?: readonly ObservationProvider[];
  fetchImpl?: FetchLike;
  now?: Date;
  db?: Db;
  workspaceId?: string;
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
    ...configuredBeseamCorpusProviders(),
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
        db: options.db,
        workspaceId: options.workspaceId
      });
      observations.push(...result.observations);
      warnings.push(...result.warnings);
    } catch (cause) {
      warnings.push(
        `${provider.name} failed: ${cause instanceof Error ? cause.message : String(cause)}.`
      );
    }
  }

  return { observations, warnings };
}
