import { z } from 'zod';
import type { FetchLike } from '../skills/guard.js';
import type { Skill, SkillEvidence, SkillRetention } from '../skills/types.js';
import {
  DEFAULT_PROVIDER_KEY,
  WITHHELD_PROVIDERS,
  getProvider,
  listProviders
} from './registry.js';
import {
  envCredentials,
  type CandidateCompany,
  type CredentialAccessor,
  type ProviderAvailability,
  type SourceQuery,
  type WithheldProvider
} from './types.js';

/**
 * ICP -> candidate companies, through the provider registry.
 *
 * The skill owns none of the sourcing logic; it picks a provider, asks it
 * whether it can honestly run, and reports what came back. That split is what
 * lets the default path (`seed`) work with no vendor at all while directory
 * crawls and deployment-configured HTTP adapters slot in behind the same
 * contract.
 *
 * An unknown provider throws: silently falling back would make one source look
 * like another. An unavailable provider returns an explicit availability state
 * and zero candidates, so "not configured" never masquerades as "no matches".
 *
 * `retention` is copied from the provider onto the output. The skill runner uses
 * that flag to prevent licensed third-party payloads from reaching the ledger.
 */
export interface SourceLeadsResult {
  providerKey: string;
  availability: ProviderAvailability;
  candidates: CandidateCompany[];
  warnings: string[];
  withheld: readonly WithheldProvider[];
  retention: SkillRetention;
  generatedAt: string;
  evidence: SkillEvidence[];
}

export interface SourceLeadsOptions {
  credentials?: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in guarded providers. */
  fetchImpl?: FetchLike;
}

export interface SourceLeadsRequest {
  provider?: string;
  keywords?: string[];
  domains?: string[];
  urls?: string[];
  countries?: string[];
  vertical?: string | null;
  limit?: number;
}

export async function sourceLeads(
  request: SourceLeadsRequest,
  options: SourceLeadsOptions = {}
): Promise<SourceLeadsResult> {
  const key = request.provider ?? DEFAULT_PROVIDER_KEY;
  const provider = getProvider(key);
  if (!provider) {
    throw new Error(
      `Unknown research provider: ${key}. Registered: ${listProviders()
        .map((item) => item.key)
        .join(', ')}.`
    );
  }

  const credentials = options.credentials ?? envCredentials;
  const availability = provider.availability(credentials);
  const generatedAt = new Date().toISOString();
  const query: SourceQuery = {
    keywords: request.keywords ?? [],
    domains: request.domains ?? [],
    urls: request.urls ?? [],
    countries: request.countries ?? [],
    vertical: request.vertical ?? null,
    limit: Math.min(Math.max(request.limit ?? 25, 1), 100)
  };

  if (availability.mode !== 'ready') {
    return {
      providerKey: provider.key,
      availability,
      candidates: [],
      warnings: [`Provider ${provider.key} is ${availability.mode}: ${availability.reason}`],
      withheld: WITHHELD_PROVIDERS,
      retention: provider.retention,
      generatedAt,
      evidence: []
    };
  }

  const result = await provider.search(query, { credentials, fetchImpl: options.fetchImpl });
  return {
    providerKey: provider.key,
    availability,
    candidates: result.candidates,
    warnings: result.warnings,
    withheld: WITHHELD_PROVIDERS,
    retention: provider.retention,
    generatedAt,
    evidence: result.evidence
  };
}

const inputSchema = z.object({
  provider: z.string().min(1).optional(),
  keywords: z.array(z.string()).max(50).optional(),
  domains: z.array(z.string()).max(2000).optional(),
  urls: z.array(z.string().url()).max(50).optional(),
  countries: z.array(z.string()).max(50).optional(),
  vertical: z.string().nullable().optional(),
  limit: z.number().int().positive().max(100).optional()
});

const outputSchema = z.object({
  providerKey: z.string(),
  availability: z.object({
    mode: z.enum(['ready', 'needs-credential', 'disabled']),
    reason: z.string(),
    docsUrl: z.string().optional()
  }),
  candidates: z.array(
    z.object({
      domain: z.string(),
      name: z.string().nullable(),
      description: z.string().nullable(),
      providerKey: z.string(),
      sourceUrl: z.string().nullable()
    })
  ),
  warnings: z.array(z.string()),
  withheld: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      docsUrl: z.string(),
      clause: z.string(),
      reason: z.string(),
      observedAt: z.string()
    })
  ),
  retention: z.enum(['default', 'none']),
  generatedAt: z.string(),
  evidence: z.array(
    z.object({
      label: z.string(),
      detail: z.string(),
      sourceUrl: z.string().nullable().optional()
    })
  )
});

type SourceLeadsInput = z.infer<typeof inputSchema>;

export const sourceLeadsSkill: Skill<SourceLeadsInput, SourceLeadsResult> = {
  manifest: {
    id: 'gtm.source-leads',
    name: 'Source candidate companies',
    version: '1.1.0',
    description:
      'Turn an ICP description, seed list, directory pages, or configured provider into candidate company domains through a pluggable provider registry.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return sourceLeads(input);
  }
};
