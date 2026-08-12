import type { FetchLike } from '../skills/guard.js';
import type { CredentialAccessor, ProviderAvailability } from '../research/types.js';
import type { SkillEvidence } from '../skills/types.js';

/**
 * Community-outreach scouting contract.
 *
 * Ported from the Python reference `tools/outreach/scout/*.py`. The reference
 * had eight `BaseScout` subclasses that each owned an HTTP client, a dedup
 * check, and a daily-cap check. Only the first of those is genuinely
 * per-platform, so this contract keeps the search and hands dedup to
 * `store.ts` and caps to `safety.ts` -- one implementation each instead of
 * eight copies that can drift apart.
 *
 * The registry shape is lifted verbatim from `research/types.ts`, including
 * the part that matters: a scout states its OWN availability. A scout that
 * cannot honestly run says so rather than returning an empty list that reads
 * as "nobody is discussing this".
 */

/**
 * One discovered thread. The port of the reference's `db.Post`.
 *
 * `community` is the field the reference computed ad hoc in
 * `safety.community_key()` from four different metadata keys. It is captured
 * at discovery time here instead, so cooldown accounting reads one column
 * rather than re-deriving a subreddit from a metadata blob.
 */
export interface OutreachThread {
  platform: string;
  /** Platform-native id. Unique per platform, stable across re-polls. */
  externalId: string;
  url: string;
  title: string;
  content: string;
  author: string | null;
  /** Subreddit, repo, tag, or instance -- whatever this platform rate-limits by. Null when it has no such concept. */
  community: string | null;
  score: number;
  numComments: number;
  /** ISO-8601, or null when the platform did not report one. */
  createdAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ScoutQuery {
  /** Search terms. Each is issued separately; results are merged and deduped by the caller. */
  queries: string[];
  /** Per-platform hard ceiling on threads returned across all queries. */
  limit: number;
}

export interface ScoutOptions {
  credentials: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

export interface ScoutResult {
  platform: string;
  threads: OutreachThread[];
  warnings: string[];
  evidence: SkillEvidence[];
}

export interface OutreachScout {
  /** Matches the `channels/` adapter key wherever a channel exists for the same platform. */
  platform: string;
  name: string;
  docsUrl: string;
  /** Environment variables this scout reads. Empty when it needs no credential. */
  credentialEnvVars: readonly string[];
  availability(credentials: CredentialAccessor): ProviderAvailability;
  search(query: ScoutQuery, options: ScoutOptions): Promise<ScoutResult>;
}

export type { ProviderAvailability, CredentialAccessor };
