import { z } from 'zod';
import type { Skill } from '../skills/types.js';
import { HIGH_VALUE_KEYWORDS, MEDIUM_KEYWORDS, MIN_RELEVANCE_SCORE, NEGATIVE_KEYWORDS } from './config.js';
import type { OutreachThread } from './types.js';

/**
 * Relevance scorer for discovered threads.
 *
 * A faithful port of the Python reference `tools/outreach/analyzer/scorer.py`,
 * including the weights, the caps, and the clamp. Two deliberate changes:
 *
 * 1. `now` is injected rather than read from the clock. The reference called
 *    `datetime.now(UTC)` inside `score()`, which made the freshness bonus --
 *    and therefore every score -- untestable and non-reproducible. A score
 *    recorded in the ledger has to be re-derivable from its inputs.
 * 2. Scoring is a pure function, not a class holding config. There is no
 *    per-instance state worth carrying; the keyword lists are module
 *    constants in `config.ts`.
 *
 * The scale is 0-10 and the default reply floor is 5. Nothing here decides
 * whether to post -- `safety.ts` does that, and it can veto a 10.
 */

export interface ScoreBreakdown {
  score: number;
  highValueMatches: string[];
  mediumMatches: string[];
  negativeMatches: string[];
  /** Every contribution, in the order applied, so a score can be explained line by line. */
  components: Array<{ label: string; points: number }>;
}

function searchText(thread: Pick<OutreachThread, 'title' | 'content'>): string {
  return `${thread.title} ${thread.content}`.toLowerCase();
}

function matches(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
}

/** Score `thread` for relevance on a 0-10 scale, with every contribution itemised. */
export function scoreThread(thread: OutreachThread, now: Date): ScoreBreakdown {
  const text = searchText(thread);
  const components: Array<{ label: string; points: number }> = [];
  const add = (label: string, points: number): void => {
    if (points !== 0) components.push({ label, points });
  };

  const highValueMatches = matches(text, HIGH_VALUE_KEYWORDS);
  const mediumMatches = matches(text, MEDIUM_KEYWORDS);
  const negativeMatches = matches(text, NEGATIVE_KEYWORDS);

  let score = 0;

  // High-value keywords: 2 points each, capped at 6.
  const high = Math.min(highValueMatches.length * 2, 6);
  score += high;
  add(`high-value keywords (${highValueMatches.length})`, high);

  // Medium keywords: 1 point each, capped at 3.
  const medium = Math.min(mediumMatches.length, 3);
  score += medium;
  add(`medium keywords (${mediumMatches.length})`, medium);

  // Negative keywords: -3 each, uncapped. One is enough to sink a thread.
  const negative = negativeMatches.length * -3;
  score += negative;
  add(`negative keywords (${negativeMatches.length})`, negative);

  // Engagement: a thread nobody is reading is not worth replying in.
  if (thread.score > 10) {
    score += 1;
    add('thread score > 10', 1);
  } else if (thread.score > 5) {
    score += 0.5;
    add('thread score > 5', 0.5);
  }

  if (thread.numComments > 5) {
    score += 0.5;
    add('more than 5 comments', 0.5);
  } else if (thread.numComments > 2) {
    score += 0.25;
    add('more than 2 comments', 0.25);
  }

  // Freshness. A reply on a week-old thread is talking to nobody.
  if (thread.createdAt) {
    const ageHours = (now.getTime() - new Date(thread.createdAt).getTime()) / 3_600_000;
    if (ageHours < 24) {
      score += 1;
      add('less than 24h old', 1);
    } else if (ageHours < 72) {
      score += 0.5;
      add('less than 72h old', 0.5);
    } else if (ageHours < 168) {
      score += 0.25;
      add('less than a week old', 0.25);
    }
  }

  // Platform-specific signals, verbatim from the reference.
  if (thread.platform === 'reddit') {
    const ratio = typeof thread.metadata.upvoteRatio === 'number' ? thread.metadata.upvoteRatio : 0.5;
    if (ratio > 0.8) {
      score += 0.5;
      add('upvote ratio > 0.8', 0.5);
    }
  } else if (thread.platform === 'hackernews') {
    if (thread.score > 50) {
      score += 0.5;
      add('HN score > 50', 0.5);
    }
    const tags = Array.isArray(thread.metadata.tags) ? thread.metadata.tags : [];
    if (tags.includes('ask_hn')) {
      score += 1;
      add('Ask HN thread', 1);
    }
  } else if (thread.platform === 'github') {
    const association = typeof thread.metadata.authorAssociation === 'string' ? thread.metadata.authorAssociation : '';
    if (association === 'CONTRIBUTOR' || association === 'MEMBER') {
      score += 0.5;
      add('author is a contributor or member', 0.5);
    }
    const labels = (Array.isArray(thread.metadata.labels) ? thread.metadata.labels : []).map((label) => String(label).toLowerCase());
    if (labels.includes('question')) {
      score += 0.5;
      add('labelled question', 0.5);
    }
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    highValueMatches,
    mediumMatches,
    negativeMatches,
    components
  };
}

export const TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  token_cost: ['token cost', 'api cost', 'expensive', 'burn rate'],
  token_savings: ['reduce tokens', 'token savings', 'save tokens'],
  context_engineering: ['context engineering', 'context window'],
  coding_agent: ['coding agent', 'claude code', 'copilot', 'cursor'],
  alternative: ['alternative', 'replacement', 'instead of']
};

/** Topics this thread is actually about. Drives which reply angle gets used. */
export function extractTopics(thread: OutreachThread): string[] {
  const text = searchText(thread);
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))
    .map(([topic]) => topic);
}

export type ReplyAngle = 'technical_deepdive' | 'cost_comparison' | 'alternative_suggestion' | 'minimal_mention';

/**
 * Pick a reply angle. Ported from `RelevanceScorer.suggest_template`.
 *
 * Busier threads get the substantive answer, quiet ones get a one-liner --
 * a long technical comment on a two-upvote thread reads as a plant.
 */
export function suggestAngle(thread: OutreachThread, topics: readonly string[]): ReplyAngle {
  if (thread.score > 20 || thread.numComments > 10) return 'technical_deepdive';
  if (thread.score > 5) return 'cost_comparison';
  if (topics.includes('alternative')) return 'alternative_suggestion';
  return 'minimal_mention';
}

export const outreachThreadSchema = z.object({
  platform: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().min(1),
  title: z.string().default(''),
  content: z.string().default(''),
  author: z.string().nullable().default(null),
  community: z.string().nullable().default(null),
  score: z.number().default(0),
  numComments: z.number().default(0),
  createdAt: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({})
});

const inputSchema = z.object({
  threads: z.array(outreachThreadSchema).max(500),
  /** Relevance floor for `shouldReply`. Defaults to the reference's 5.0. */
  minScore: z.number().min(0).max(10).default(MIN_RELEVANCE_SCORE)
});

const scoredThreadSchema = z.object({
  thread: outreachThreadSchema,
  score: z.number(),
  shouldReply: z.boolean(),
  topics: z.array(z.string()),
  angle: z.enum(['technical_deepdive', 'cost_comparison', 'alternative_suggestion', 'minimal_mention']),
  highValueMatches: z.array(z.string()),
  mediumMatches: z.array(z.string()),
  negativeMatches: z.array(z.string()),
  components: z.array(z.object({ label: z.string(), points: z.number() }))
});

const outputSchema = z.object({
  scored: z.array(scoredThreadSchema),
  /**
   * `scored` filtered to entries clearing `minScore`, best first.
   *
   * Kept separate rather than filtering `scored` in place because callers want
   * both: the full ranking to see what was considered, and the shortlist to
   * act on. A playbook that indexes into `scored.0` would draft a reply to the
   * least-bad thread in a batch where nothing qualified -- which is how a
   * threshold becomes decoration.
   */
  repliable: z.array(scoredThreadSchema),
  minScore: z.number(),
  scoredAt: z.string()
});

export type ScoredThread = z.infer<typeof scoredThreadSchema>;
type ScoreThreadsInput = z.infer<typeof inputSchema>;
type ScoreThreadsOutput = z.infer<typeof outputSchema>;

/** Rank `threads` best-first. Ties keep their input order, so the result is stable. */
export function rankThreads(threads: readonly OutreachThread[], now: Date, minScore = MIN_RELEVANCE_SCORE): ScoredThread[] {
  return threads
    .map((thread, index) => {
      const breakdown = scoreThread(thread, now);
      const topics = extractTopics(thread);
      return {
        index,
        entry: {
          thread,
          score: breakdown.score,
          shouldReply: breakdown.score >= minScore,
          topics,
          angle: suggestAngle(thread, topics),
          highValueMatches: breakdown.highValueMatches,
          mediumMatches: breakdown.mediumMatches,
          negativeMatches: breakdown.negativeMatches,
          components: breakdown.components
        }
      };
    })
    .sort((left, right) => right.entry.score - left.entry.score || left.index - right.index)
    .map(({ entry }) => entry);
}

export const scoreThreadsSkill: Skill<ScoreThreadsInput, ScoreThreadsOutput> = {
  manifest: {
    id: 'gtm.score-threads',
    name: 'Score community threads',
    version: '1.0.0',
    description:
      'Rank discovered community threads for reply-worthiness on a 0-10 relevance scale, with every scoring component itemised.',
    sideEffect: 'none',
    requiresApproval: false,
    inputSchema,
    outputSchema
  },
  async run(input, ctx) {
    const now = ctx.now();
    const scored = rankThreads(input.threads as OutreachThread[], now, input.minScore);
    return {
      scored,
      repliable: scored.filter((entry) => entry.shouldReply),
      minScore: input.minScore,
      scoredAt: now.toISOString()
    };
  }
};
