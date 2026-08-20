import type { FetchLike } from '../skills/guard.js';
import type { SkillEvidence } from '../skills/types.js';

/**
 * Lead-sourcing provider contract, mirroring `src/server/channels/`.
 *
 * A provider turns an ICP description into candidate companies. The registry
 * shape is copied from the channel adapters on purpose, including the part
 * that matters most: each provider states its OWN availability and documents
 * the vendor policy that produced it next to a `docsUrl` a reader can check.
 * A provider that cannot honestly run says so in `availability` rather than
 * returning an empty list that reads as "no companies matched".
 *
 * `retention` is the second honesty field, and it is not decoration. Some
 * vendors license results on terms that do not permit storing them. A provider
 * declaring `retention: 'none'` tells the runner that results may be returned
 * to the caller in memory and must not reach disk -- see `runner.ts`, which
 * drops the payload while keeping the ledger row.
 */

export type ProviderAvailabilityMode = 'ready' | 'needs-credential' | 'disabled';

export interface ProviderAvailability {
  mode: ProviderAvailabilityMode;
  /** Plain-language cause, written for an operator deciding what to do next. */
  reason: string;
  docsUrl?: string;
}

/**
 * Credential seam. Defaults to `process.env`, but injected so tests never touch
 * the real environment and a future secret store drops in without reaching
 * into every provider.
 */
export interface CredentialAccessor {
  get(name: string): string | undefined;
}

export const envCredentials: CredentialAccessor = {
  get(name: string): string | undefined {
    return process.env[name];
  }
};

export interface SourceQuery {
  /** Free-text ICP terms, e.g. `['performance footwear', 'direct to consumer']`. */
  keywords: string[];
  /** Caller-supplied domains. The `seed` provider sources from these alone. */
  domains: string[];
  /** Public pages a provider may crawl for candidate-company links. */
  urls: string[];
  countries: string[];
  vertical: string | null;
  limit: number;
}

export interface CandidateCompany {
  domain: string;
  name: string | null;
  description: string | null;
  providerKey: string;
  /** Where the candidate came from, so a bad candidate is traceable to its origin. */
  sourceUrl: string | null;
}

export interface ProviderSearchOptions {
  credentials: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

export interface ProviderResult {
  providerKey: string;
  candidates: CandidateCompany[];
  warnings: string[];
  evidence: SkillEvidence[];
}

export interface ResearchProvider {
  key: string;
  name: string;
  docsUrl: string;
  /** Environment variable the credential accessor is asked for; `null` when none is needed. */
  credentialEnvVar: string | null;
  /** `'none'` = results may be used in memory and must never be persisted. */
  retention: 'default' | 'none';
  availability(credentials: CredentialAccessor): ProviderAvailability;
  search(query: SourceQuery, options: ProviderSearchOptions): Promise<ProviderResult>;
}

/**
 * A provider deliberately NOT shipped, and the clause that says why.
 *
 * The same discipline the `prepare-only` channel adapters use for automation:
 * an absence with no record invites a well-meaning re-add six months later.
 * This is surfaced in `gtm.source-leads` output so the answer to "why is there
 * no adapter for X" comes from the tool rather than from tribal memory.
 */
export interface WithheldProvider {
  key: string;
  name: string;
  docsUrl: string;
  /** Verbatim excerpt of the prohibiting clause. */
  clause: string;
  reason: string;
  /** Terms move; the reading is only as good as its date. */
  observedAt: string;
}
