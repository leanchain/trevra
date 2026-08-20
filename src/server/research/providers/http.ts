import { z } from 'zod';
import { validatePublicHost } from '../../skills/guard.js';
import { normalizeDomain } from '../../skills/ladder.js';
import type {
  CandidateCompany,
  CredentialAccessor,
  ProviderSearchOptions,
  ResearchProvider,
  SourceQuery
} from '../types.js';

const REQUEST_TIMEOUT_MS = 30_000;
const PROVIDER_DOCS_URL = 'https://github.com/trevra/trevra/blob/main/docs/source-providers.md';
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
    docsUrl: z.string().url().optional(),
    retention: z.enum(['default', 'none']).default('default')
  })
  .strict();

const providerSpecsSchema = z.array(providerSpecSchema).max(50);
export type HttpSourceProviderSpec = z.infer<typeof providerSpecSchema>;

interface HttpCandidate {
  domain?: unknown;
  url?: unknown;
  name?: unknown;
  description?: unknown;
  sourceUrl?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function availability(spec: HttpSourceProviderSpec, credentials: CredentialAccessor) {
  const tokenEnv = spec.tokenEnv ?? null;
  if (tokenEnv && !credentials.get(tokenEnv)) {
    return {
      mode: 'needs-credential' as const,
      reason: `Set ${tokenEnv} to enable ${spec.name}.`,
      docsUrl: spec.docsUrl
    };
  }
  return {
    mode: 'ready' as const,
    reason: `${spec.name} is configured by the deployment as an HTTP sourcing adapter.`,
    docsUrl: spec.docsUrl
  };
}

async function postAdapter(
  spec: HttpSourceProviderSpec,
  query: SourceQuery,
  options: ProviderSearchOptions
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
    body: JSON.stringify({
      keywords: query.keywords,
      domains: query.domains,
      urls: query.urls,
      countries: query.countries,
      vertical: query.vertical,
      limit: query.limit
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

export function httpSourceProvider(spec: HttpSourceProviderSpec): ResearchProvider {
  return {
    key: spec.key,
    name: spec.name,
    // Never expose the deployment-owned endpoint back to a workspace. It may
    // be an internal hostname; docs are public metadata, routing is not.
    docsUrl: spec.docsUrl ?? PROVIDER_DOCS_URL,
    credentialEnvVar: spec.tokenEnv ?? null,
    retention: spec.retention,
    availability(credentials) {
      return availability(spec, credentials);
    },
    async search(query, options) {
      if (spec.tokenEnv && !options.credentials.get(spec.tokenEnv)) {
        return {
          providerKey: spec.key,
          candidates: [],
          warnings: [`${spec.tokenEnv} is not set; ${spec.name} returned no candidates.`],
          evidence: []
        };
      }
      try {
        const response = await postAdapter(spec, query, options);
        if (!response.ok) {
          return {
            providerKey: spec.key,
            candidates: [],
            warnings: [`${spec.name} returned HTTP ${response.status}; no candidates imported.`],
            evidence: []
          };
        }
        const payload = (await response.json()) as { candidates?: unknown; warnings?: unknown };
        if (!Array.isArray(payload.candidates)) {
          return {
            providerKey: spec.key,
            candidates: [],
            warnings: [`${spec.name} responded without a candidates array.`],
            evidence: []
          };
        }
        const seen = new Set<string>();
        const candidates: CandidateCompany[] = [];
        for (const item of payload.candidates as HttpCandidate[]) {
          if (!item || typeof item !== 'object') continue;
          const rawDomain = text(item.domain) ?? text(item.url);
          const domain = normalizeDomain(rawDomain);
          if (!domain || seen.has(domain)) continue;
          try {
            await validatePublicHost(domain, { resolve: false });
          } catch {
            continue;
          }
          seen.add(domain);
          candidates.push({
            domain,
            name: text(item.name),
            description: text(item.description),
            providerKey: spec.key,
            sourceUrl: text(item.sourceUrl) ?? text(item.url)
          });
          if (candidates.length >= query.limit) break;
        }
        const warnings = Array.isArray(payload.warnings)
          ? payload.warnings
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 50)
          : [];
        return {
          providerKey: spec.key,
          candidates,
          warnings,
          evidence:
            spec.retention === 'none'
              ? []
              : [
                  {
                    label: spec.name,
                    detail: `${candidates.length} candidate company domain(s) returned by the configured HTTP adapter.`,
                    sourceUrl: spec.docsUrl ?? null
                  }
                ]
        };
      } catch (cause) {
        return {
          providerKey: spec.key,
          candidates: [],
          warnings: [
            `${spec.name} failed: ${cause instanceof Error ? cause.message : String(cause)}.`
          ],
          evidence: []
        };
      }
    }
  };
}

/**
 * Deployment-owned adapters. Workspaces choose a registered key but can never
 * choose an endpoint or an environment-variable name, so a tenant cannot turn
 * this generic seam into SSRF or secret exfiltration.
 */
export function configuredHttpSourceProviders(
  raw: string | undefined = process.env.TREVRA_SOURCE_HTTP_PROVIDERS_JSON
): ResearchProvider[] {
  if (!raw?.trim()) return [];
  const specs = providerSpecsSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  return specs.map((spec) => {
    if (seen.has(spec.key)) throw new Error(`Duplicate HTTP source provider key: ${spec.key}`);
    seen.add(spec.key);
    const endpoint = new URL(spec.endpoint);
    if (spec.tokenEnv && endpoint.protocol !== 'https:') {
      throw new Error(
        `HTTP source provider ${spec.key} carries a bearer token and must use an HTTPS endpoint`
      );
    }
    return httpSourceProvider(spec);
  });
}
