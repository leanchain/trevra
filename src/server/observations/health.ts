import { id, type Db } from '../db.js';
import { envCredentials } from '../research/types.js';
import { configuredHttpObservationProviders } from './providers/http.js';
import { beehiivPublicFeedProvider } from './providers/beehiiv.js';
import { facebookPageProvider } from './providers/facebook.js';
import { instagramBusinessDiscoveryProvider } from './providers/instagram.js';
import { metaAdLibraryProvider } from './providers/meta-ads.js';
import { substackPublicFeedProvider } from './providers/substack.js';
import { youtubeDataApiProvider } from './providers/youtube.js';
import type { ObservationProvider, ObservationSurface } from './types.js';

const HEALTH_PREFIX = 'observation-health:';
const STALE_AFTER_MS = 36 * 60 * 60 * 1_000;

export type ObservationOperationalStatus = 'ready' | 'healthy' | 'warning' | 'error' | 'stale';

interface StoredProviderHealth {
  version: 1;
  providerKey: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastWarning: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface ObservationProviderHealth {
  key: string;
  name: string;
  surfaces: readonly ObservationSurface[];
  docsUrl: string | null;
  availability: ReturnType<ObservationProvider['availability']>;
  operationalStatus: ObservationOperationalStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastWarning: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

function healthDomain(providerKey: string): string {
  return `${HEALTH_PREFIX}${providerKey}`;
}

function cleanMessage(value: string | null | undefined): string | null {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 1_000) : null;
}

async function loadStoredHealth(
  db: Db,
  workspaceId: string,
  providerKey: string
): Promise<{ id: string; health: StoredProviderHealth } | null> {
  const row = await db
    .prepare(
      `SELECT id,snapshot_json FROM research_snapshots
       WHERE workspace_id=? AND domain=? ORDER BY captured_at DESC LIMIT 1`
    )
    .get<{ id: string; snapshot_json: unknown }>(workspaceId, healthDomain(providerKey));
  if (!row) return null;
  let raw = row.snapshot_json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<StoredProviderHealth>;
  if (value.version !== 1 || value.providerKey !== providerKey) return null;
  return {
    id: row.id,
    health: {
      version: 1,
      providerKey,
      lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
      lastSuccessAt: typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
      lastWarning: typeof value.lastWarning === 'string' ? value.lastWarning : null,
      lastError: typeof value.lastError === 'string' ? value.lastError : null,
      consecutiveFailures:
        typeof value.consecutiveFailures === 'number' && Number.isFinite(value.consecutiveFailures)
          ? Math.max(0, Math.trunc(value.consecutiveFailures))
          : 0
    }
  };
}

async function saveStoredHealth(
  db: Db,
  workspaceId: string,
  rowId: string | null,
  health: StoredProviderHealth,
  now: Date
): Promise<void> {
  const timestamp = now.toISOString();
  if (rowId) {
    await db
      .prepare(
        `UPDATE research_snapshots SET captured_at=?,snapshot_json=?::jsonb,created_at=?
         WHERE workspace_id=? AND id=?`
      )
      .run(timestamp, JSON.stringify(health), timestamp, workspaceId, rowId);
    return;
  }
  await db
    .prepare(
      `INSERT INTO research_snapshots (id,workspace_id,domain,captured_at,snapshot_json,created_at)
       VALUES (?,?,?,?,?::jsonb,?)`
    )
    .run(
      id('snap'),
      workspaceId,
      healthDomain(health.providerKey),
      timestamp,
      JSON.stringify(health),
      timestamp
    );
}

export async function recordObservationProviderSuccess(
  db: Db,
  workspaceId: string,
  providerKey: string,
  now: Date,
  warning?: string | null
): Promise<void> {
  const stored = await loadStoredHealth(db, workspaceId, providerKey);
  const timestamp = now.toISOString();
  await saveStoredHealth(
    db,
    workspaceId,
    stored?.id ?? null,
    {
      version: 1,
      providerKey,
      lastAttemptAt: timestamp,
      lastSuccessAt: timestamp,
      lastWarning: cleanMessage(warning),
      lastError: null,
      consecutiveFailures: 0
    },
    now
  );
}

export async function recordObservationProviderFailure(
  db: Db,
  workspaceId: string,
  providerKey: string,
  now: Date,
  error: unknown
): Promise<void> {
  const stored = await loadStoredHealth(db, workspaceId, providerKey);
  const timestamp = now.toISOString();
  const message = cleanMessage(error instanceof Error ? error.message : String(error));
  await saveStoredHealth(
    db,
    workspaceId,
    stored?.id ?? null,
    {
      version: 1,
      providerKey,
      lastAttemptAt: timestamp,
      lastSuccessAt: stored?.health.lastSuccessAt ?? null,
      lastWarning: stored?.health.lastWarning ?? null,
      lastError: message ?? 'Provider execution failed.',
      consecutiveFailures: (stored?.health.consecutiveFailures ?? 0) + 1
    },
    now
  );
}

/** All first-party providers are listed even when credentials are missing. */
export function observationProviderCatalog(): ObservationProvider[] {
  const providers = [
    substackPublicFeedProvider(),
    beehiivPublicFeedProvider(),
    facebookPageProvider(),
    instagramBusinessDiscoveryProvider(),
    metaAdLibraryProvider(),
    youtubeDataApiProvider(),
    ...configuredHttpObservationProviders()
  ];
  const unique = new Map<string, ObservationProvider>();
  for (const provider of providers)
    if (!unique.has(provider.key)) unique.set(provider.key, provider);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function operationalStatus(
  stored: StoredProviderHealth | null,
  availabilityMode: 'ready' | 'needs-credential' | 'disabled',
  now: Date
): ObservationOperationalStatus {
  if (availabilityMode !== 'ready' || !stored?.lastAttemptAt) return 'ready';
  if (stored.lastError && stored.consecutiveFailures > 0) return 'error';
  const successMs = stored.lastSuccessAt ? Date.parse(stored.lastSuccessAt) : Number.NaN;
  if (!Number.isNaN(successMs) && now.getTime() - successMs > STALE_AFTER_MS) return 'stale';
  if (stored.lastWarning) return 'warning';
  return 'healthy';
}

export async function listObservationProviderHealth(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<ObservationProviderHealth[]> {
  const output: ObservationProviderHealth[] = [];
  for (const provider of observationProviderCatalog()) {
    const stored = (await loadStoredHealth(db, workspaceId, provider.key))?.health ?? null;
    const availability = provider.availability(envCredentials);
    output.push({
      key: provider.key,
      name: provider.name,
      surfaces: provider.surfaces,
      docsUrl: provider.docsUrl,
      availability,
      operationalStatus: operationalStatus(stored, availability.mode, now),
      lastAttemptAt: stored?.lastAttemptAt ?? null,
      lastSuccessAt: stored?.lastSuccessAt ?? null,
      lastWarning: stored?.lastWarning ?? null,
      lastError: stored?.lastError ?? null,
      consecutiveFailures: stored?.consecutiveFailures ?? 0
    });
  }
  return output;
}
