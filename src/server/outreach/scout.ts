import { z } from 'zod';
import type { FetchLike } from '../skills/guard.js';
import { envCredentials, type CredentialAccessor, type ProviderAvailability } from '../research/types.js';
import type { Skill, SkillContext, SkillEvidence } from '../skills/types.js';
import { PLATFORM_QUERIES } from './config.js';
import { getScout, listScouts } from './registry.js';
import { outreachThreadSchema } from './scorer.js';
import { recordSeenThreads } from './store.js';
import type { OutreachThread } from './types.js';

/**
 * gtm.scout-threads -- poll community platforms for threads worth replying in.
 *
 * The port of the reference's `run_scout` loop over eight `BaseScout`
 * subclasses. Three things changed, all of them for the same reason -- the
 * reference's scouts each owned a copy of logic that has exactly one correct
 * implementation:
 *
 * - DEDUP happens once, in `store.ts`, against Postgres. The reference did it
 *   per-scout against a local SQLite file, and marked a thread seen at the
 *   moment it was parsed, so a crash mid-run permanently buried every thread
 *   discovered before it. Here nothing is marked seen until the run reaches
 *   the point of returning it.
 * - AVAILABILITY is reported per platform. The reference returned an empty
 *   list whether a platform was unconfigured or genuinely quiet.
 * - FAILURE is per-platform, never per-run. One rate-limited API degrades to a
 *   warning; the other seven still report.
 */

export interface PlatformScoutReport {
  platform: string;
  availability: ProviderAvailability;
  /** Threads still open to a reply. */
  fresh: OutreachThread[];
  /** How many were withheld because we have already replied to them. */
  repliedCount: number;
  warnings: string[];
}

export interface ScoutThreadsResult {
  reports: PlatformScoutReport[];
  threads: OutreachThread[];
  warnings: string[];
  scoutedAt: string;
  evidence: SkillEvidence[];
}

export interface ScoutThreadsOptions {
  credentials?: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

export interface ScoutThreadsRequest {
  platforms?: string[];
  /** Overrides the per-platform defaults in `config.ts`. */
  queries?: string[];
  limitPerPlatform?: number;
}

export async function scoutThreads(
  request: ScoutThreadsRequest,
  ctx: SkillContext,
  options: ScoutThreadsOptions = {}
): Promise<ScoutThreadsResult> {
  const credentials = options.credentials ?? envCredentials;
  const now = ctx.now();
  const limit = Math.min(Math.max(request.limitPerPlatform ?? 25, 1), 100);

  const platforms = request.platforms?.length ? request.platforms : listScouts().map((scout) => scout.platform);
  const unknown = platforms.filter((platform) => !getScout(platform));
  if (unknown.length > 0) {
    // A caller error, exactly as in `sourceLeads`: a silent skip would look
    // like a platform where nobody is talking.
    throw new Error(`Unknown outreach platform(s): ${unknown.join(', ')}. Registered: ${listScouts().map((s) => s.platform).join(', ')}.`);
  }

  const reports: PlatformScoutReport[] = [];
  const evidence: SkillEvidence[] = [];
  const warnings: string[] = [];

  for (const platform of platforms) {
    const scout = getScout(platform);
    if (!scout) continue;
    const availability = scout.availability(credentials);

    if (availability.mode !== 'ready') {
      reports.push({ platform, availability, fresh: [], repliedCount: 0, warnings: [`${scout.name} is ${availability.mode}: ${availability.reason}`] });
      warnings.push(`${scout.name} is ${availability.mode}: ${availability.reason}`);
      continue;
    }

    const queries = request.queries?.length ? request.queries : [...(PLATFORM_QUERIES[platform] ?? [])];
    if (queries.length === 0) {
      reports.push({ platform, availability, fresh: [], repliedCount: 0, warnings: [`No search terms configured for ${scout.name}.`] });
      continue;
    }

    let result;
    try {
      result = await scout.search({ queries, limit }, { credentials, fetchImpl: options.fetchImpl });
    } catch (cause) {
      // A scout that throws is a bug in that scout. It must not take the run
      // down with it -- the other platforms have already done useful work.
      const message = `${scout.name} scout failed: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      reports.push({ platform, availability, fresh: [], repliedCount: 0, warnings: [message] });
      warnings.push(message);
      continue;
    }

    // Inside the per-platform boundary too: a DB error here must degrade this
    // platform, not discard the work every other platform already completed.
    // Reachable in practice -- a NUL byte in a Reddit selftext is rejected by
    // Postgres for a text column, and no amount of tag-stripping removes it.
    try {
      const { fresh, repliedCount, changed } = await recordSeenThreads(ctx.db, ctx.workspaceId, result.threads, now);
      const platformWarnings = [...result.warnings];
      if (changed.length > 0) {
        platformWarnings.push(`${changed.length} ${scout.name} thread(s) were edited since they were first read and were re-scored.`);
      }
      reports.push({ platform, availability, fresh, repliedCount, warnings: platformWarnings });
      warnings.push(...platformWarnings);
      evidence.push(...result.evidence);
    } catch (cause) {
      const message = `${scout.name} results could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      reports.push({ platform, availability, fresh: [], repliedCount: 0, warnings: [message] });
      warnings.push(message);
    }
  }

  return {
    reports,
    threads: reports.flatMap((report) => report.fresh),
    warnings,
    scoutedAt: now.toISOString(),
    evidence
  };
}

const inputSchema = z.object({
  platforms: z.array(z.string().min(1)).max(20).optional(),
  queries: z.array(z.string().min(1)).max(50).optional(),
  limitPerPlatform: z.number().int().positive().max(100).optional()
});

const availabilitySchema = z.object({
  mode: z.enum(['ready', 'needs-credential', 'disabled']),
  reason: z.string(),
  docsUrl: z.string().optional()
});

const outputSchema = z.object({
  reports: z.array(
    z.object({
      platform: z.string(),
      availability: availabilitySchema,
      fresh: z.array(outreachThreadSchema),
      repliedCount: z.number(),
      warnings: z.array(z.string())
    })
  ),
  threads: z.array(outreachThreadSchema),
  warnings: z.array(z.string()),
  scoutedAt: z.string(),
  evidence: z.array(z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() }))
});

type ScoutThreadsInput = z.infer<typeof inputSchema>;

export const scoutThreadsSkill: Skill<ScoutThreadsInput, ScoutThreadsResult> = {
  manifest: {
    id: 'gtm.scout-threads',
    name: 'Scout community threads',
    version: '1.0.0',
    description:
      'Poll Hacker News, Reddit, GitHub, Lobsters, dev.to, Mastodon, and Stack Overflow for threads discussing AI-coding-agent cost, returning only threads not already triaged.',
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    return scoutThreads(input, ctx);
  }
};
