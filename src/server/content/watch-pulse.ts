import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { upsertContentOpportunity } from './opportunities.js';
import type { ContentEvidenceRef, ContentOpportunity } from './types.js';
import type { MarketPulseDays } from './pulse.js';

const DAY_MS = 86_400_000;
const MAX_KEYWORDS = 5;
const MAX_EXAMPLES = 5;
const MAX_EVIDENCE = 25;

export interface BrandWatchPulseKeyword {
  keyword: string;
  mentionCount: number;
}

export interface BrandWatchPulseExample {
  mentionId: string;
  platform: string;
  author: string | null;
  title: string;
  detail: string;
  sourceUrl: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  observedAt: string;
}

export interface BrandWatchMarketPulse {
  scope: { type: 'brand_watch'; watchId: string; watchName: string };
  scopeLabel: string;
  days: MarketPulseDays;
  from: string;
  to: string;
  mentionCount: number;
  sourceCount: number;
  platformCount: number;
  sentiment: { positive: number; neutral: number; negative: number };
  topKeywords: BrandWatchPulseKeyword[];
  examples: BrandWatchPulseExample[];
  newestAt: string | null;
  canDraft: boolean;
  draftBlocker: string | null;
}

export class BrandWatchPulseError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function mentionDetail(row: Record<string, unknown>): string {
  const content = String(row.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const title = String(row.title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const value = content || title || 'Mention observed.';
  return value.length <= 700 ? value : `${value.slice(0, 697).trimEnd()}…`;
}

export async function compileBrandWatchMarketPulse(
  db: Db,
  workspaceId: string,
  watchId: string,
  input: { days?: MarketPulseDays } = {},
  now: Date = new Date()
): Promise<BrandWatchMarketPulse> {
  const watch = await db
    .prepare('SELECT id,name FROM brand_watches WHERE workspace_id=? AND id=?')
    .get<{ id: string; name: string }>(workspaceId, watchId);
  if (!watch) throw new BrandWatchPulseError('Brand watch not found.', 404);

  const days = input.days ?? 7;
  const toDate = dayStartUtc(now);
  const from = new Date(toDate.getTime() - days * DAY_MS).toISOString();
  const to = new Date(toDate.getTime() + DAY_MS).toISOString();

  const totals = await db
    .prepare(
      `SELECT
         COUNT(*)::int AS mention_count,
         COUNT(DISTINCT NULLIF(BTRIM(url),''))::int AS source_count,
         COUNT(DISTINCT platform)::int AS platform_count,
         (COUNT(*) FILTER (WHERE sentiment_label='positive'))::int AS positive,
         (COUNT(*) FILTER (WHERE sentiment_label='neutral'))::int AS neutral,
         (COUNT(*) FILTER (WHERE sentiment_label='negative'))::int AS negative,
         MAX(first_seen_at) AS newest_at
       FROM brand_watch_mentions
       WHERE workspace_id=? AND watch_id=?
         AND first_seen_at>=?::timestamptz AND first_seen_at<?::timestamptz
         AND NULLIF(BTRIM(url),'') IS NOT NULL`
    )
    .get<Record<string, unknown>>(workspaceId, watchId, from, to);

  const keywordRows = await db
    .prepare(
      `SELECT keyword,COUNT(DISTINCT mention_id)::int AS mention_count
       FROM (
         SELECT m.id AS mention_id,LOWER(BTRIM(keyword)) AS keyword
         FROM brand_watch_mentions m
         CROSS JOIN LATERAL unnest(m.matched_keywords) AS keyword
         WHERE m.workspace_id=? AND m.watch_id=?
           AND m.first_seen_at>=?::timestamptz AND m.first_seen_at<?::timestamptz
           AND NULLIF(BTRIM(m.url),'') IS NOT NULL
       ) matched
       WHERE keyword<>''
       GROUP BY keyword
       ORDER BY COUNT(DISTINCT mention_id) DESC,keyword
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, watchId, from, to, MAX_KEYWORDS);

  const exampleRows = await db
    .prepare(
      `SELECT id,platform,author,title,content,url,sentiment_label,first_seen_at
       FROM brand_watch_mentions
       WHERE workspace_id=? AND watch_id=?
         AND first_seen_at>=?::timestamptz AND first_seen_at<?::timestamptz
         AND NULLIF(BTRIM(url),'') IS NOT NULL
       ORDER BY first_seen_at DESC,id DESC
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, watchId, from, to, MAX_EXAMPLES);

  const mentionCount = Number(totals?.mention_count ?? 0);
  const sourceCount = Number(totals?.source_count ?? 0);
  const platformCount = Number(totals?.platform_count ?? 0);
  const canDraft = sourceCount >= 2;
  return {
    scope: { type: 'brand_watch', watchId: watch.id, watchName: watch.name },
    scopeLabel: `Brand watch “${watch.name}”`,
    days,
    from,
    to,
    mentionCount,
    sourceCount,
    platformCount,
    sentiment: {
      positive: Number(totals?.positive ?? 0),
      neutral: Number(totals?.neutral ?? 0),
      negative: Number(totals?.negative ?? 0)
    },
    topKeywords: keywordRows.map((row) => ({
      keyword: String(row.keyword),
      mentionCount: Number(row.mention_count)
    })),
    examples: exampleRows.map((row) => ({
      mentionId: String(row.id),
      platform: String(row.platform),
      author: row.author ? String(row.author) : null,
      title: String(row.title ?? ''),
      detail: mentionDetail(row),
      sourceUrl: String(row.url),
      sentiment:
        String(row.sentiment_label) === 'positive'
          ? 'positive'
          : String(row.sentiment_label) === 'negative'
            ? 'negative'
            : 'neutral',
      observedAt: iso(row.first_seen_at)
    })),
    newestAt: totals?.newest_at ? iso(totals.newest_at) : null,
    canDraft,
    draftBlocker:
      sourceCount === 0
        ? `No source-backed mentions were discovered in the last ${days} days.`
        : sourceCount < 2
          ? 'Only one independent mention is available; Trevra will not present it as a market trend.'
          : null
  };
}

function fingerprint(pulse: BrandWatchMarketPulse): string {
  return `watch_pulse:${createHash('sha256')
    .update(
      JSON.stringify([
        pulse.scope.watchId,
        pulse.days,
        pulse.from.slice(0, 10),
        pulse.to.slice(0, 10)
      ])
    )
    .digest('hex')
    .slice(0, 24)}`;
}

export async function materializeBrandWatchMarketPulse(
  db: Db,
  workspaceId: string,
  watchId: string,
  input: { days?: MarketPulseDays } = {},
  now: Date = new Date()
): Promise<{ pulse: BrandWatchMarketPulse; opportunity: ContentOpportunity | null }> {
  const pulse = await compileBrandWatchMarketPulse(db, workspaceId, watchId, input, now);
  if (!pulse.canDraft || !pulse.newestAt) return { pulse, opportunity: null };

  const rows = await db
    .prepare(
      `SELECT id,platform,author,title,content,url,sentiment_label,first_seen_at
       FROM brand_watch_mentions
       WHERE workspace_id=? AND watch_id=?
         AND first_seen_at>=?::timestamptz AND first_seen_at<?::timestamptz
         AND NULLIF(BTRIM(url),'') IS NOT NULL
       ORDER BY first_seen_at DESC,id DESC
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, watchId, pulse.from, pulse.to, MAX_EVIDENCE);
  const evidence: ContentEvidenceRef[] = rows.map((row) => ({
    sourceType: 'brand_watch_mention' as const,
    sourceId: String(row.id),
    label: `${String(row.platform)}${row.author ? ` · ${String(row.author)}` : ''}`,
    detail: mentionDetail(row),
    sourceUrl: String(row.url),
    observedAt: iso(row.first_seen_at)
  }));
  if (new Set(evidence.map((row) => row.sourceUrl)).size < 2)
    return {
      pulse: {
        ...pulse,
        canDraft: false,
        draftBlocker: 'At least two independent source URLs are required.'
      },
      opportunity: null
    };

  const period = pulse.days === 7 ? 'Weekly' : '30-day';
  const topKeyword = pulse.topKeywords[0];
  const thesis = `${pulse.sourceCount} independent mentions across ${pulse.platformCount} platform${pulse.platformCount === 1 ? '' : 's'} surfaced around ${pulse.scope.watchName} in the last ${pulse.days} days.`;
  const score = Math.min(
    100,
    50 + Math.min(30, pulse.sourceCount * 5) + Math.min(20, pulse.platformCount * 5)
  );
  const opportunity = await upsertContentOpportunity(
    db,
    {
      workspaceId,
      status: 'ready',
      kind: 'watch_trend',
      title: `${period} watch pulse · ${pulse.scope.watchName}`,
      thesis,
      audience: null,
      freshnessAt: pulse.newestAt,
      score,
      rationale: [
        `${pulse.sourceCount} independent source URLs contributed mentions`,
        `${pulse.platformCount} platform${pulse.platformCount === 1 ? '' : 's'} contributed evidence`,
        `${pulse.sentiment.positive} positive · ${pulse.sentiment.neutral} neutral · ${pulse.sentiment.negative} negative mentions`,
        ...(topKeyword
          ? [`“${topKeyword.keyword}” appeared in ${topKeyword.mentionCount} distinct mentions`]
          : [])
      ],
      evidence,
      fingerprint: fingerprint(pulse)
    },
    now
  );
  return { pulse, opportunity };
}
