import { id, type Db } from '../db.js';
import { normalizeDomain } from '../skills/ladder.js';
import {
  OBSERVATION_METRICS,
  type ExternalMeasurement,
  type ExternalObservation,
  type ObservationMetric
} from './types.js';

const SNAPSHOT_PREFIX = 'observation:';
const KNOWN_METRICS = new Set<string>(OBSERVATION_METRICS);
const MAX_MEASUREMENTS_PER_PROVIDER = 100;
const FUTURE_SKEW_MS = 60 * 60 * 1_000;

interface StoredMeasurement extends ExternalMeasurement {
  metric: ObservationMetric;
}

interface MeasurementSnapshot {
  version: 1;
  providerKey: string;
  domain: string;
  capturedAt: string;
  measurements: Record<string, StoredMeasurement>;
}

export interface InterpretMeasurementsOptions {
  db: Db;
  workspaceId: string;
  providerKey: string;
  domain: string;
  measurements: readonly ExternalMeasurement[];
  now: Date;
}

export interface MeasurementInterpretation {
  observations: ExternalObservation[];
  warnings: string[];
}

function metricKey(measurement: Pick<ExternalMeasurement, 'metric' | 'scope'>): string {
  // Persisted inside PostgreSQL jsonb: never use NUL/control separators here.
  // URI encoding keeps arbitrary handles/scopes unambiguous and printable.
  return `${encodeURIComponent(measurement.metric)}|${encodeURIComponent(measurement.scope?.trim().toLowerCase() ?? '')}`;
}

function cleanEvidenceUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeMeasurement(
  raw: ExternalMeasurement,
  now: Date
): { measurement: StoredMeasurement | null; warning: string | null } {
  const metric = raw.metric as ObservationMetric;
  if (!KNOWN_METRICS.has(metric)) {
    return { measurement: null, warning: `unknown observation metric '${raw.metric}'` };
  }
  if (!Number.isFinite(raw.value) || raw.value < 0) {
    return { measurement: null, warning: `${metric} has a non-finite or negative value` };
  }
  const evidenceUrl = cleanEvidenceUrl(raw.evidenceUrl);
  if (!evidenceUrl)
    return { measurement: null, warning: `${metric} has no valid HTTP(S) evidence URL` };
  const observedMs = Date.parse(raw.observedAt);
  if (Number.isNaN(observedMs) || observedMs > now.getTime() + FUTURE_SKEW_MS) {
    return { measurement: null, warning: `${metric} has an invalid/future observedAt` };
  }
  const scope = raw.scope?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  return {
    measurement: {
      metric,
      scope,
      value: raw.value,
      evidenceUrl,
      observedAt: new Date(observedMs).toISOString()
    },
    warning: null
  };
}

function snapshotDomain(providerKey: string, domain: string): string {
  return `${SNAPSHOT_PREFIX}${providerKey}:${domain}`;
}

async function loadPrevious(
  db: Db,
  workspaceId: string,
  providerKey: string,
  domain: string
): Promise<MeasurementSnapshot | null> {
  const row = await db
    .prepare(
      'SELECT snapshot_json FROM research_snapshots WHERE workspace_id=? AND domain=? ORDER BY captured_at DESC LIMIT 1'
    )
    .get<{ snapshot_json: unknown }>(workspaceId, snapshotDomain(providerKey, domain));
  if (!row) return null;
  let raw: unknown = row.snapshot_json;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const snapshot = raw as Partial<MeasurementSnapshot>;
  if (
    snapshot.version !== 1 ||
    snapshot.providerKey !== providerKey ||
    snapshot.domain !== domain ||
    !snapshot.measurements ||
    typeof snapshot.measurements !== 'object' ||
    Array.isArray(snapshot.measurements)
  )
    return null;
  return snapshot as MeasurementSnapshot;
}

async function saveSnapshot(
  db: Db,
  workspaceId: string,
  snapshot: MeasurementSnapshot,
  now: Date
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO research_snapshots (id,workspace_id,domain,captured_at,snapshot_json,created_at)
       VALUES (?,?,?,?,?::jsonb,?)`
    )
    .run(
      id('snap'),
      workspaceId,
      snapshotDomain(snapshot.providerKey, snapshot.domain),
      snapshot.capturedAt,
      JSON.stringify(snapshot),
      now.toISOString()
    );
}

function meaningfulRise(
  previous: number,
  current: number,
  absolute: number,
  relative: number
): boolean {
  if (current <= previous) return false;
  const delta = current - previous;
  return delta >= absolute && (previous === 0 || current / previous >= relative);
}

function interpretPair(
  previous: StoredMeasurement,
  current: StoredMeasurement
): ExternalObservation | null {
  if (current.metric !== previous.metric || current.scope !== previous.scope) return null;
  if (Date.parse(current.observedAt) <= Date.parse(previous.observedAt)) return null;

  const scope = current.scope ? ` for ${current.scope}` : '';
  if (current.metric === 'meta.active_ads') {
    if (previous.value === 0 && current.value > 0) {
      return {
        kind: 'meta-ads-started',
        detail: `Active Meta ads${scope} went from 0 to ${current.value}.`,
        previous: '0',
        current: String(current.value),
        evidenceUrl: current.evidenceUrl,
        observedAt: current.observedAt
      };
    }
    if (meaningfulRise(previous.value, current.value, 3, 1.25)) {
      return {
        kind: 'meta-ads-rising',
        detail: `Active Meta ads${scope} rose from ${previous.value} to ${current.value}.`,
        previous: String(previous.value),
        current: String(current.value),
        evidenceUrl: current.evidenceUrl,
        observedAt: current.observedAt
      };
    }
  }

  if (
    current.metric === 'social.followers' &&
    meaningfulRise(previous.value, current.value, 10, 1.02)
  ) {
    return {
      kind: 'social-growth',
      detail: `Social followers${scope} rose from ${previous.value} to ${current.value}.`,
      previous: String(previous.value),
      current: String(current.value),
      evidenceUrl: current.evidenceUrl,
      observedAt: current.observedAt
    };
  }

  if (
    current.metric === 'social.posts_30d' &&
    meaningfulRise(previous.value, current.value, 2, 1.25)
  ) {
    return {
      kind: 'social-cadence-up',
      detail: `Public posts in the trailing 30 days${scope} rose from ${previous.value} to ${current.value}.`,
      previous: String(previous.value),
      current: String(current.value),
      evidenceUrl: current.evidenceUrl,
      observedAt: current.observedAt
    };
  }

  if (current.metric === 'newsletter.posts_30d') {
    if (previous.value === 0 && current.value > 0) {
      return {
        kind: 'newsletter-started',
        detail: `Newsletter publications in the trailing 30 days${scope} went from 0 to ${current.value}.`,
        previous: '0',
        current: String(current.value),
        evidenceUrl: current.evidenceUrl,
        observedAt: current.observedAt
      };
    }
    if (previous.value > 0 && current.value === 0) {
      return {
        kind: 'newsletter-silent',
        detail: `Newsletter publications in the trailing 30 days${scope} fell from ${previous.value} to 0.`,
        previous: String(previous.value),
        current: '0',
        evidenceUrl: current.evidenceUrl,
        observedAt: current.observedAt
      };
    }
  }

  return null;
}

/**
 * Persist a provider's raw measurements and turn only newer comparable values
 * into Trevra signal vocabulary. Missing metrics are left unchanged: partial
 * provider responses mean "not measured", never zero or removal.
 */
export async function interpretMeasurements(
  options: InterpretMeasurementsOptions
): Promise<MeasurementInterpretation> {
  const domain = normalizeDomain(options.domain);
  if (!domain) return { observations: [], warnings: ['measurement domain is invalid'] };
  const warnings: string[] = [];
  const current = new Map<string, StoredMeasurement>();

  for (const raw of options.measurements.slice(0, MAX_MEASUREMENTS_PER_PROVIDER)) {
    const { measurement, warning } = sanitizeMeasurement(raw, options.now);
    if (warning) warnings.push(`${options.providerKey}: ${warning}.`);
    if (!measurement) continue;
    const key = metricKey(measurement);
    const existing = current.get(key);
    if (!existing || Date.parse(measurement.observedAt) > Date.parse(existing.observedAt)) {
      current.set(key, measurement);
    }
  }
  if (current.size === 0) return { observations: [], warnings };

  const previous = await loadPrevious(options.db, options.workspaceId, options.providerKey, domain);
  const merged: Record<string, StoredMeasurement> = { ...(previous?.measurements ?? {}) };
  const observations: ExternalObservation[] = [];

  for (const [key, measurement] of current) {
    const prior = previous?.measurements[key];
    if (prior) {
      const observation = interpretPair(prior, measurement);
      if (observation) observations.push(observation);
      if (Date.parse(measurement.observedAt) <= Date.parse(prior.observedAt)) continue;
    }
    merged[key] = measurement;
  }

  const capturedAt =
    [...Object.values(merged)]
      .map((measurement) => measurement.observedAt)
      .sort()
      .at(-1) ?? options.now.toISOString();
  await saveSnapshot(
    options.db,
    options.workspaceId,
    {
      version: 1,
      providerKey: options.providerKey,
      domain,
      capturedAt,
      measurements: merged
    },
    options.now
  );

  return { observations, warnings };
}
