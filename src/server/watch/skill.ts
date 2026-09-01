import { z } from 'zod';
import type { FetchLike } from '../skills/guard.js';
import {
  envCredentials,
  type CredentialAccessor,
  type ProviderAvailability
} from '../research/types.js';
import type { Skill, SkillContext, SkillEvidence } from '../skills/types.js';
import { getScout } from '../outreach/registry.js';
import type { OutreachThread } from '../outreach/types.js';
import { getWatch, recordWatchMentions, type WatchMentionInput } from './store.js';
import { scoreSentiment, type Sentiment } from './sentiment.js';

/**
 * gtm.watch-mentions -- search the community platforms for a watch's keywords.
 *
 * Structurally the same loop as `gtm.scout-threads`, and for the same three
 * reasons: availability is reported per platform, one platform's failure is a
 * warning rather than a dead run, and persistence happens once in `store.ts`.
 * It differs in exactly one way -- it passes `communities: []`, so a scout that
 * normally watches five configured repos or subreddits searches sitewide. A
 * brand watch scoped to somebody else's target list would answer "nobody
 * mentions you" without ever having looked.
 */

export interface ScoredMention {
  platform: string;
  externalId: string;
  url: string;
  title: string;
  excerpt: string;
  author: string | null;
  community: string | null;
  score: number;
  numComments: number;
  createdAt: string | null;
  matchedKeywords: string[];
  sentiment: Sentiment;
}

export interface WatchPlatformReport {
  platform: string;
  availability: ProviderAvailability;
  fresh: ScoredMention[];
  knownCount: number;
  warnings: string[];
}

export interface WatchMentionsResult {
  watchId: string | null;
  reports: WatchPlatformReport[];
  mentions: ScoredMention[];
  summary: { positive: number; neutral: number; negative: number; averageScore: number };
  warnings: string[];
  watchedAt: string;
  evidence: SkillEvidence[];
}

export interface WatchMentionsRequest {
  watchId?: string;
  keywords?: string[];
  platforms?: string[];
  limitPerPlatform?: number;
}

export interface WatchMentionsOptions {
  credentials?: CredentialAccessor;
  /** Injection seam for tests; supplying it also disables DNS resolution in the guard. */
  fetchImpl?: FetchLike;
}

const EXCERPT_MAX = 400;

function matchedKeywords(thread: OutreachThread, keywords: readonly string[]): string[] {
  const haystack = `${thread.title}\n${thread.content}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

function toMention(
  thread: OutreachThread,
  keywords: string[],
  sentiment: Sentiment
): ScoredMention {
  return {
    platform: thread.platform,
    externalId: thread.externalId,
    url: thread.url,
    title: thread.title,
    excerpt: thread.content.slice(0, EXCERPT_MAX),
    author: thread.author,
    community: thread.community,
    score: thread.score,
    numComments: thread.numComments,
    createdAt: thread.createdAt,
    matchedKeywords: keywords,
    sentiment
  };
}

export async function watchMentions(
  request: WatchMentionsRequest,
  ctx: SkillContext,
  options: WatchMentionsOptions = {}
): Promise<WatchMentionsResult> {
  const credentials = options.credentials ?? envCredentials;
  const now = ctx.now();

  const watch = request.watchId ? await getWatch(ctx.db, ctx.workspaceId, request.watchId) : null;
  if (request.watchId && !watch) throw new Error(`Unknown watch: ${request.watchId}.`);

  const keywords = watch?.keywords ?? request.keywords ?? [];
  if (keywords.length === 0) throw new Error('A watch run needs at least one keyword.');

  const platforms = watch?.platforms ?? request.platforms ?? [];
  if (platforms.length === 0) throw new Error('A watch run needs at least one platform.');

  const limit = Math.min(
    Math.max(watch?.limitPerPlatform ?? request.limitPerPlatform ?? 25, 1),
    100
  );

  const reports: WatchPlatformReport[] = [];
  const warnings: string[] = [];
  const evidence: SkillEvidence[] = [];
  const collected: WatchMentionInput[] = [];

  for (const platform of platforms) {
    const scout = getScout(platform);
    if (!scout) {
      const message = `Unknown platform: ${platform}.`;
      warnings.push(message);
      reports.push({
        platform,
        availability: { mode: 'disabled', reason: message },
        fresh: [],
        knownCount: 0,
        warnings: [message]
      });
      continue;
    }

    const availability = scout.availability(credentials);
    if (availability.mode !== 'ready') {
      const message = `${scout.name} is ${availability.mode}: ${availability.reason}`;
      warnings.push(message);
      reports.push({ platform, availability, fresh: [], knownCount: 0, warnings: [message] });
      continue;
    }

    let result;
    try {
      result = await scout.search(
        // Sitewide: see the module comment.
        { queries: [...keywords], limit, communities: [] },
        { credentials, fetchImpl: options.fetchImpl }
      );
    } catch (cause) {
      const message = `${scout.name} watch search failed: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      warnings.push(message);
      reports.push({ platform, availability, fresh: [], knownCount: 0, warnings: [message] });
      continue;
    }

    const scored: ScoredMention[] = [];
    for (const thread of result.threads) {
      const hits = matchedKeywords(thread, keywords);
      // A platform without server-side search returns its whole window; a
      // thread that does not actually contain a keyword is not a mention.
      if (hits.length === 0) continue;
      const sentiment = scoreSentiment(`${thread.title}. ${thread.content}`);
      scored.push(toMention(thread, hits, sentiment));
      collected.push({ thread, matchedKeywords: hits, sentiment });
    }

    warnings.push(...result.warnings);
    evidence.push(...result.evidence);
    reports.push({
      platform,
      availability,
      fresh: scored,
      knownCount: result.threads.length,
      warnings: [...result.warnings]
    });
  }

  if (watch && collected.length > 0) {
    try {
      await recordWatchMentions(ctx.db, ctx.workspaceId, watch.id, collected, now);
    } catch (cause) {
      // Same boundary as scout-threads: a write failure must not discard the
      // reads every platform already completed.
      const message = `Watch mentions could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}.`;
      ctx.logger?.warn(message, cause);
      warnings.push(message);
    }
  }

  const mentions = reports.flatMap((report) => report.fresh);
  const positive = mentions.filter((m) => m.sentiment.label === 'positive').length;
  const negative = mentions.filter((m) => m.sentiment.label === 'negative').length;
  const neutral = mentions.length - positive - negative;
  const averageScore =
    mentions.length === 0
      ? 0
      : Number(
          (mentions.reduce((sum, m) => sum + m.sentiment.score, 0) / mentions.length).toFixed(3)
        );

  return {
    watchId: watch?.id ?? null,
    reports,
    mentions,
    summary: { positive, neutral, negative, averageScore },
    warnings,
    watchedAt: now.toISOString(),
    evidence
  };
}

const inputSchema = z
  .object({
    watchId: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1).max(120)).max(20).optional(),
    platforms: z.array(z.string().min(1)).max(20).optional(),
    limitPerPlatform: z.number().int().positive().max(100).optional()
  })
  .refine((value) => Boolean(value.watchId) || (value.keywords?.length ?? 0) > 0, {
    message: 'Supply watchId or keywords.'
  });

const sentimentSchema = z.object({
  label: z.enum(['positive', 'neutral', 'negative']),
  score: z.number().min(-1).max(1),
  span: z.string(),
  matches: z.array(z.object({ term: z.string(), weight: z.number(), negated: z.boolean() }))
});

const mentionSchema = z.object({
  platform: z.string(),
  externalId: z.string(),
  url: z.string(),
  title: z.string(),
  excerpt: z.string(),
  author: z.string().nullable(),
  community: z.string().nullable(),
  score: z.number(),
  numComments: z.number(),
  createdAt: z.string().nullable(),
  matchedKeywords: z.array(z.string()),
  sentiment: sentimentSchema
});

const outputSchema = z.object({
  watchId: z.string().nullable(),
  reports: z.array(
    z.object({
      platform: z.string(),
      availability: z.object({
        mode: z.enum(['ready', 'needs-credential', 'disabled']),
        reason: z.string(),
        docsUrl: z.string().optional()
      }),
      fresh: z.array(mentionSchema),
      knownCount: z.number(),
      warnings: z.array(z.string())
    })
  ),
  mentions: z.array(mentionSchema),
  summary: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
    averageScore: z.number()
  }),
  warnings: z.array(z.string()),
  watchedAt: z.string(),
  evidence: z.array(
    z.object({ label: z.string(), detail: z.string(), sourceUrl: z.string().nullable().optional() })
  )
});

type WatchMentionsInput = z.infer<typeof inputSchema>;

export const watchMentionsSkill: Skill<WatchMentionsInput, WatchMentionsResult> = {
  manifest: {
    id: 'gtm.watch-mentions',
    name: 'Watch brand and keyword mentions',
    version: '1.0.0',
    description:
      "Search the configured community platforms for a named watch's keywords, score each mention's sentiment with the in-repo lexicon, and record new mentions against that watch.",
    sideEffect: 'network-read',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    return watchMentions(input, ctx);
  }
};
