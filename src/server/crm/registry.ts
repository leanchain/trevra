import { attioCrmAdapter } from './adapters/attio.js';
import { hubspotCrmAdapter } from './adapters/hubspot.js';
import type { CrmAdapter } from './types.js';

/**
 * CRM adapter registry, mirroring `channels/`, `research/`, and
 * `outreach/scouts/`: keyed by provider, first registration wins, listings
 * sorted so they are stable.
 *
 * ADDING A CRM IS ONE FILE AND ONE ENTRY BELOW. The provider key must match the
 * `connections.provider` value, because that is how a workspace's connected
 * account is found.
 *
 * A provider with no adapter here simply cannot be written to — which is the
 * safe default, and why this is a lookup rather than a fallback.
 */

const adapters = new Map<string, CrmAdapter>();

export function registerCrmAdapter(adapter: CrmAdapter): CrmAdapter {
  const existing = adapters.get(adapter.key);
  if (existing) return existing;
  adapters.set(adapter.key, adapter);
  return adapter;
}

export function getCrmAdapter(key: string): CrmAdapter | undefined {
  return adapters.get(key);
}

export function listCrmAdapters(): CrmAdapter[] {
  return [...adapters.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Providers Trevra can write activity to. Used by the connect screen copy. */
export const CRM_WRITE_PROVIDERS: readonly string[] = ['hubspot', 'attio'];

for (const adapter of [hubspotCrmAdapter, attioCrmAdapter]) {
  registerCrmAdapter(adapter);
}
