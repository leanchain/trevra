import { z } from 'zod';
import type { FetchLike } from '../skills/guard.js';
import type { Skill, SkillEvidence, SkillRetention } from '../skills/types.js';
import { DEFAULT_PROVIDER_KEY, WITHHELD_PROVIDERS, getProvider, listProviders } from './registry.js';
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
 * lets the default path (`seed`) work with no vendor at all while a credentialed
 * provider slots in without the caller changing anything.
 *
 * Two behaviours worth knowing before calling it:
 *
 * An UNKNOWN provider key throws -- that is a caller error, and a run that
 * silently fell back to `seed` would look like a vendor returning nothing.
 * An UNAVAILABLE provider does NOT throw: it returns zero candidates with its
 * own `availability` attached, so "you have not set EXA_API_KEY" reads
 * differently from "Exa found nobody".
 *
 * `retention` is copied from the chosen provider onto the output, where
 * `runner.ts` reads it. A provider whose licence forbids storage produces a
 * ledger row with the payload dropped.
 */

export interface SourceLeadsResult {
  providerKey: string;
  availability: ProviderAvailability;
  candidates: CandidateCompany[];
  warnings: string[];
  /** Providers deliberately not shipped, with the clause that says why. */
  withheld: readonly WithheldProvider[];
  retention: SkillRetention;
  generatedAt: string;
  evidence: SkillEvidence[];
}

export interface SourceLeadsOptions {
  credentials?: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

export interface SourceLeadsRequest {
  provider?: string;
  keywords?: string[];
  domains?: string[];
  countries?: string[];
  vertical?: string | null;
  limit?: number;
}

export async function sourceLeads(request: SourceLeadsRequest, options: SourceLeadsOptions = {}): Promise<SourceLeadsResult> {
  const key = request.provider ?? DEFAULT_PROVIDER_KEY;
  const provider = getProvider(key);
  if (!provider) {
    throw new Error(`Unknown research provider: ${key}. Registered: ${listProviders().map((item) => item.key).join(', ')}.`);
  }

  const credentials = options.credentials ?? envCredentials;
  const availability = provider.availability(credentials);
  const generatedAt = new Date().toISOString();

  const query: SourceQuery = {
    keywords: request.keywords ?? [],
    domains: request.domains ?? [],
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
  keywords: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  countries: z.array(z.string()).optional(),
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
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type SourceLeadsInput = z.infer<typeof inputSchema>;

export const sourceLeadsSkill: Skill<SourceLeadsInput, SourceLeadsResult> = {
  manifest: {
    id: 'gtm.source-leads',
    name: 'Source candidate companies',
    version: '1.0.0',
    description:
      'Turn an ICP description into candidate company domains through a pluggable provider registry. Defaults to the credential-free seed provider.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input) {
    return sourceLeads(input);
  }
};
