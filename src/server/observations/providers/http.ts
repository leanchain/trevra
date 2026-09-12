import { z } from 'zod';
import { ACCOUNT_SIGNAL_KINDS } from '../../accounts/types.js';
import { normalizeDomain } from '../../skills/ladder.js';
import type { CredentialAccessor } from '../../research/types.js';
import {
  OBSERVATION_SURFACES,
  type ExternalObservation,
  type ObservationProvider,
  type ObservationProviderOptions,
  type ObservationSurface
} from '../types.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OBSERVATIONS_PER_RUN = 100;
const KNOWN_SIGNAL_KINDS = new Set<string>(ACCOUNT_SIGNAL_KINDS);

const providerSpecSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
    name: z.string().trim().min(1).max(100),
    endpoint: z.string().url(),
    tokenEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,127}$/)
      .nullable()
      .optional(),
    docsUrl: z.string().url().nullable().optional(),
    surfaces: z.array(z.enum(OBSERVATION_SURFACES)).min(1).max(OBSERVATION_SURFACES.length)
  })
  .strict();

const providerSpecsSchema = z.array(providerSpecSchema).max(50);
export type HttpObservationProviderSpec = z.infer<typeof providerSpecSchema>;

function availability(spec: HttpObservationProviderSpec, credentials: CredentialAccessor) {
  const tokenEnv = spec.tokenEnv ?? null;
  if (tokenEnv && !credentials.get(tokenEnv)) {
    return {
      mode: 'needs-credential' as const,
      reason: `Set ${tokenEnv} to enable ${spec.name}.`,
      docsUrl: spec.docsUrl ?? undefined
    };
  }
  return {
    mode: 'ready' as const,
    reason: `${spec.name} is configured as an ecommerce observation provider.`,
    docsUrl: spec.docsUrl ?? undefined
  };
}

function text(value: unknown, max: number): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function state(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, 2_000);
  }
  return JSON.stringify(value).slice(0, 2_000);
}

function evidenceUrl(value: unknown): string | null {
  const raw = text(value, 2_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function observedAt(value: unknown, now: Date): string | null {
  const raw = typeof value === 'string' ? value : '';
  const timestamp = Date.parse(raw);
  if (!raw || Number.isNaN(timestamp)) return null;
  // One hour of clock skew is tolerated. A provider cannot manufacture a
  // future buying signal and gain recency points from Trevra's scorer.
  if (timestamp > now.getTime() + 3_600_000) return null;
  return new Date(timestamp).toISOString();
}

async function postAdapter(
  spec: HttpObservationProviderSpec,
  domain: string,
  options: ObservationProviderOptions
): Promise<Response> {
  const token = spec.tokenEnv ? options.credentials.get(spec.tokenEnv) : undefined;
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return fetchImpl(spec.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ domain, surfaces: spec.surfaces }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

export function httpObservationProvider(spec: HttpObservationProviderSpec): ObservationProvider {
  return {
    key: spec.key,
    name: spec.name,
    docsUrl: spec.docsUrl ?? null,
    credentialEnvVar: spec.tokenEnv ?? null,
    surfaces: spec.surfaces as readonly ObservationSurface[],
    availability(credentials) {
      return availability(spec, credentials);
    },
    async observe(rawDomain, options) {
      const domain = normalizeDomain(rawDomain);
      if (!domain) {
        return {
          providerKey: spec.key,
          observations: [],
          warnings: [
            `${spec.name} was not called because ${rawDomain} is not a usable public domain.`
          ]
        };
      }
      if (spec.tokenEnv && !options.credentials.get(spec.tokenEnv)) {
        return {
          providerKey: spec.key,
          observations: [],
          warnings: [`${spec.tokenEnv} is not set; ${spec.name} returned no observations.`]
        };
      }

      try {
        const response = await postAdapter(spec, domain, options);
        if (!response.ok) {
          return {
            providerKey: spec.key,
            observations: [],
            warnings: [
              `${spec.name} returned HTTP ${response.status}; no observations were accepted.`
            ]
          };
        }
        const payload = (await response.json()) as Record<string, unknown>;
        const raw = Array.isArray(payload.observations) ? payload.observations : [];
        const warnings = Array.isArray(payload.warnings)
          ? payload.warnings
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 50)
          : [];
        if (!Array.isArray(payload.observations)) {
          warnings.push(`${spec.name} responded without an observations array.`);
        }

        const observations: ExternalObservation[] = [];
        for (const item of raw.slice(0, MAX_OBSERVATIONS_PER_RUN)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const row = item as Record<string, unknown>;
          const kind = text(row.kind, 80);
          const detail = text(row.detail, 1_000);
          const evidence = evidenceUrl(row.evidenceUrl ?? row.sourceUrl);
          const seenAt = observedAt(row.observedAt ?? row.lastSeenAt, options.now);
          const previous = state(row.previous);
          const current = state(row.current);
          if (!kind || !KNOWN_SIGNAL_KINDS.has(kind)) {
            if (kind)
              warnings.push(`${spec.name} returned unknown signal kind '${kind}'; it was ignored.`);
            continue;
          }
          if (!detail || !evidence || !seenAt || current === null) {
            warnings.push(
              `${spec.name} returned an incomplete ${kind} observation; current value, evidence URL and observedAt are required.`
            );
            continue;
          }
          observations.push({
            kind,
            detail,
            previous,
            current,
            evidenceUrl: evidence,
            observedAt: seenAt
          });
        }

        return { providerKey: spec.key, observations, warnings };
      } catch (cause) {
        return {
          providerKey: spec.key,
          observations: [],
          warnings: [
            `${spec.name} failed: ${cause instanceof Error ? cause.message : String(cause)}.`
          ]
        };
      }
    }
  };
}

/**
 * Deployment-owned observation adapters for acquisition surfaces that do not
 * belong in the per-domain public-web crawler, such as Meta Ad Library, social
 * telemetry, or newsletter delivery collectors. Workspaces choose accounts;
 * they never choose an endpoint or secret name.
 */
export function configuredHttpObservationProviders(
  raw: string | undefined = process.env.TREVRA_OBSERVATION_HTTP_PROVIDERS_JSON
): ObservationProvider[] {
  if (!raw?.trim()) return [];
  const specs = providerSpecsSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  return specs.map((spec) => {
    if (seen.has(spec.key)) throw new Error(`Duplicate observation provider key: ${spec.key}`);
    seen.add(spec.key);
    const endpoint = new URL(spec.endpoint);
    if (spec.tokenEnv && endpoint.protocol !== 'https:') {
      throw new Error(
        `Observation provider ${spec.key} carries a bearer token and must use an HTTPS endpoint`
      );
    }
    return httpObservationProvider(spec);
  });
}
