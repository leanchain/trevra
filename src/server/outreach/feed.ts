import type { Db } from '../db.js';
import {
  dbCounters,
  evaluateSafety,
  memoisedCounters,
  type SafetyCheckName,
  type SafetyVerdict
} from './safety.js';
import { extractTopics, scoreThread, suggestAngle, type ReplyAngle } from './scorer.js';
import { listOutreachThreads, type OutreachThreadRow } from './store.js';
import type { OutreachThread } from './types.js';

/**
 * The read model behind /research: one stored row, plus every derived judgement
 * a founder needs to decide whether to open it.
 *
 * Nothing here is persisted. Relevance is a pure function of the row and the
 * keyword lists in config.ts, so a keyword change is a redeploy, not a
 * backfill -- and a score shown in the UI is always the score today's rules
 * produce, never a stale one recorded at discovery time.
 */
export interface FeedThread {
  row: OutreachThreadRow;
  relevance: {
    score: number;
    components: Array<{ label: string; points: number }>;
    highValueMatches: string[];
    negativeMatches: string[];
  };
  topics: string[];
  angle: ReplyAngle;
  guard: { allowed: boolean; reason: string | null; failedChecks: SafetyCheckName[] };
}

/** Project a stored row back onto the shape every outreach skill consumes. */
export function threadFromRow(row: OutreachThreadRow): OutreachThread {
  return {
    platform: row.platform,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    content: row.content,
    author: row.author,
    community: row.community,
    score: row.score,
    numComments: row.num_comments,
    createdAt: row.thread_created_at,
    metadata: row.metadata_json ?? {}
  };
}

export async function loadThreadFeed(
  db: Db,
  workspaceId: string,
  filters: { platform?: string; limit?: number },
  now: Date
): Promise<FeedThread[]> {
  const rows = await listOutreachThreads(db, workspaceId, filters);
  const counters = memoisedCounters(dbCounters(db, workspaceId));

  const entries: FeedThread[] = [];
  for (const row of rows) {
    const thread = threadFromRow(row);
    const breakdown = scoreThread(thread, now);
    const topics = extractTopics(thread);
    // A gate that cannot be computed is never reported as permission. The row
    // still renders -- "we could not check" is a fact worth showing.
    let verdict: SafetyVerdict | null = null;
    try {
      verdict = await evaluateSafety(db, { workspaceId, thread }, now, { counters });
    } catch {
      verdict = null;
    }
    entries.push({
      row,
      relevance: {
        score: breakdown.score,
        components: breakdown.components,
        highValueMatches: breakdown.highValueMatches,
        negativeMatches: breakdown.negativeMatches
      },
      topics,
      angle: suggestAngle(thread, topics),
      guard: verdict
        ? {
            allowed: verdict.allowed,
            reason: verdict.reason,
            failedChecks: verdict.checks
              .filter((check) => !check.passed)
              .map((check) => check.check)
          }
        : {
            allowed: false,
            reason: 'guard unknown: the safety gate could not be evaluated.',
            failedChecks: []
          }
    });
  }

  // Relevance first; discovery order breaks ties, so the list is stable between
  // reloads that discovered nothing new.
  return entries.sort(
    (left, right) =>
      right.relevance.score - left.relevance.score ||
      Date.parse(right.row.first_seen_at) - Date.parse(left.row.first_seen_at)
  );
}
