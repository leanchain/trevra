import type { Db } from '../db.js';
import type { ContentAngle, ContentFormat, ContentOpportunityKind } from './types.js';
import { appendContentPublicationMetric, type ContentPublicationMetric } from './metrics.js';

export const CONTENT_LEARNING_MIN_SAMPLE = 3;

export interface ContentCommercialOutcomes {
  engagers: number;
  resolvedPeople: number;
  qualifiedDemand: number;
  verifiedReplies: number;
  opportunities: number;
  won: number;
}

export interface ContentPublicationVelocity {
  snapshotCount: number;
  firstObservedAt: string | null;
  latestObservedAt: string | null;
  windowHours: number | null;
  impressionsDelta: number | null;
  impressionsPerHour: number | null;
  reactionsDelta: number | null;
  commentsDelta: number | null;
  repostsDelta: number | null;
}

export interface ContentPublicationPerformance {
  assetId: string;
  opportunityId: string | null;
  opportunityKind: ContentOpportunityKind | null;
  format: ContentFormat;
  angle: ContentAngle;
  postId: string;
  publishedAt: string;
  postedUrl: string | null;
  latestMetrics: ContentPublicationMetric | null;
  velocity: ContentPublicationVelocity;
  commercial: ContentCommercialOutcomes;
}

export interface ContentLearningBucket {
  dimension: 'opportunity_kind' | 'format' | 'angle';
  value: string;
  sampleSize: number;
  metricSampleSize: number;
  medianImpressions: number | null;
  medianReactions: number | null;
  medianComments: number | null;
  commercial: ContentCommercialOutcomes;
  eligibleForComparison: boolean;
  summary: string;
}

export interface ContentPerformanceReport {
  publications: ContentPublicationPerformance[];
  learning: ContentLearningBucket[];
  totals: ContentCommercialOutcomes & { published: number };
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function nullableMetric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function latestMetricFromRow(row: Record<string, unknown>): ContentPublicationMetric | null {
  if (!row.metric_id) return null;
  return {
    id: String(row.metric_id),
    workspaceId: String(row.workspace_id),
    channel: 'linkedin',
    publicationId: String(row.post_id),
    observedAt: iso(row.metric_observed_at),
    impressions: nullableMetric(row.metric_impressions),
    reactions: nullableMetric(row.metric_reactions),
    comments: nullableMetric(row.metric_comments),
    reposts: nullableMetric(row.metric_reposts),
    clicks: nullableMetric(row.metric_clicks),
    profileViews: nullableMetric(row.metric_profile_views),
    follows: nullableMetric(row.metric_follows),
    raw: {},
    createdAt: iso(row.metric_created_at)
  };
}

function commercialFromRow(row: Record<string, unknown>): ContentCommercialOutcomes {
  return {
    engagers: count(row.engagers),
    resolvedPeople: count(row.resolved_people),
    qualifiedDemand: count(row.qualified_demand),
    verifiedReplies: count(row.verified_replies),
    opportunities: count(row.opportunities),
    won: count(row.won)
  };
}

function metricDelta(first: unknown, latest: unknown): number | null {
  const start = nullableMetric(first);
  const end = nullableMetric(latest);
  return start === null || end === null ? null : end - start;
}

function velocityFromRow(row: Record<string, unknown>): ContentPublicationVelocity {
  const snapshotCount = count(row.metric_snapshot_count);
  const firstObservedAt = row.first_metric_observed_at ? iso(row.first_metric_observed_at) : null;
  const latestObservedAt = row.metric_observed_at ? iso(row.metric_observed_at) : null;
  if (snapshotCount < 2 || !firstObservedAt || !latestObservedAt) {
    return {
      snapshotCount,
      firstObservedAt,
      latestObservedAt,
      windowHours: null,
      impressionsDelta: null,
      impressionsPerHour: null,
      reactionsDelta: null,
      commentsDelta: null,
      repostsDelta: null
    };
  }
  const windowHours = Math.max(
    0,
    (Date.parse(latestObservedAt) - Date.parse(firstObservedAt)) / 3_600_000
  );
  const impressionsDelta = metricDelta(row.first_metric_impressions, row.metric_impressions);
  return {
    snapshotCount,
    firstObservedAt,
    latestObservedAt,
    windowHours,
    impressionsDelta,
    impressionsPerHour:
      impressionsDelta === null || windowHours <= 0
        ? null
        : Math.round((impressionsDelta / windowHours) * 100) / 100,
    reactionsDelta: metricDelta(row.first_metric_reactions, row.metric_reactions),
    commentsDelta: metricDelta(row.first_metric_comments, row.metric_comments),
    repostsDelta: metricDelta(row.first_metric_reposts, row.metric_reposts)
  };
}

/**
 * Record an observed LinkedIn metric snapshot for a provenance-linked content post.
 * The post must already be provider-confirmed as posted; drafts/scheduled rows are
 * not publications and cannot accumulate performance by wishful thinking.
 */
export async function appendLinkedInContentMetric(
  db: Db,
  input: {
    workspaceId: string;
    postId: string;
    observedAt: string;
    impressions?: number | null;
    reactions?: number | null;
    comments?: number | null;
    reposts?: number | null;
    clicks?: number | null;
    profileViews?: number | null;
    follows?: number | null;
    raw?: Record<string, unknown>;
  },
  now: Date = new Date()
): Promise<ContentPublicationMetric> {
  const post = await db
    .prepare(
      `SELECT id FROM linkedin_posts
       WHERE workspace_id=? AND id=? AND status='posted' AND content_asset_id IS NOT NULL`
    )
    .get<{ id: string }>(input.workspaceId, input.postId);
  if (!post) throw new Error('Published content post not found in this workspace.');
  return appendContentPublicationMetric(
    db,
    {
      workspaceId: input.workspaceId,
      channel: 'linkedin',
      publicationId: input.postId,
      observedAt: input.observedAt,
      impressions: input.impressions,
      reactions: input.reactions,
      comments: input.comments,
      reposts: input.reposts,
      clicks: input.clicks,
      profileViews: input.profileViews,
      follows: input.follows,
      raw: input.raw
    },
    now
  );
}

/**
 * Commercial performance for evidence-backed posts only.
 *
 * Every downstream count follows an explicit lineage edge:
 * LinkedIn post -> provenance-tagged engagement source -> raw engager ->
 * recommendation evidence -> qualified-demand recommendation -> verified reply /
 * origin-recommendation Opportunity. No Person/Account coincidence is treated as
 * attribution here.
 */
export async function listContentPublicationPerformance(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<ContentPublicationPerformance[]> {
  const rows = await db
    .prepare(
      `
      SELECT
        post.workspace_id,post.id AS post_id,post.published_at,post.posted_url,
        asset.id AS asset_id,asset.opportunity_id,asset.format,asset.angle,
        story.kind AS opportunity_kind,
        metric.id AS metric_id,metric.observed_at AS metric_observed_at,
        metric.impressions AS metric_impressions,metric.reactions AS metric_reactions,
        metric.comments AS metric_comments,metric.reposts AS metric_reposts,
        metric.clicks AS metric_clicks,metric.profile_views AS metric_profile_views,
        metric.follows AS metric_follows,metric.created_at AS metric_created_at,
        first_metric.observed_at AS first_metric_observed_at,
        first_metric.impressions AS first_metric_impressions,
        first_metric.reactions AS first_metric_reactions,
        first_metric.comments AS first_metric_comments,
        first_metric.reposts AS first_metric_reposts,
        COALESCE(history.snapshot_count,0)::int AS metric_snapshot_count,
        COALESCE(stats.engagers,0)::int AS engagers,
        COALESCE(stats.resolved_people,0)::int AS resolved_people,
        COALESCE(stats.qualified_demand,0)::int AS qualified_demand,
        COALESCE(stats.verified_replies,0)::int AS verified_replies,
        COALESCE(stats.opportunities,0)::int AS opportunities,
        COALESCE(stats.won,0)::int AS won
      FROM linkedin_posts post
      JOIN content_assets asset
        ON asset.workspace_id=post.workspace_id AND asset.id=post.content_asset_id
      LEFT JOIN content_opportunities story
        ON story.workspace_id=asset.workspace_id AND story.id=asset.opportunity_id
      LEFT JOIN LATERAL (
        SELECT m.*
        FROM content_publication_metrics m
        WHERE m.workspace_id=post.workspace_id
          AND m.channel='linkedin'
          AND m.publication_id=post.id
        ORDER BY m.observed_at DESC,m.id DESC
        LIMIT 1
      ) metric ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.*
        FROM content_publication_metrics m
        WHERE m.workspace_id=post.workspace_id
          AND m.channel='linkedin'
          AND m.publication_id=post.id
        ORDER BY m.observed_at ASC,m.id ASC
        LIMIT 1
      ) first_metric ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS snapshot_count
        FROM content_publication_metrics m
        WHERE m.workspace_id=post.workspace_id
          AND m.channel='linkedin'
          AND m.publication_id=post.id
      ) history ON TRUE
      LEFT JOIN LATERAL (
        WITH source_leads AS (
          SELECT lead.id,lead.profile_url
          FROM linkedin_lead_sources source
          JOIN linkedin_leads lead
            ON lead.workspace_id=source.workspace_id
           AND lead.seat_key=source.seat_key
           AND lead.source_id=source.id
          WHERE source.workspace_id=post.workspace_id
            AND source.origin_type='trevra_published_post'
            AND source.origin_id=post.id
            AND lead.interaction_kind IS DISTINCT FROM 'post'
        ), attributed_recommendations AS (
          SELECT DISTINCT recommendation.id,recommendation.person_id
          FROM source_leads lead
          JOIN recommendation_evidence evidence
            ON evidence.workspace_id=post.workspace_id
           AND evidence.source_type='linkedin_post_engagement'
           AND evidence.source_id=lead.id
          JOIN recommendations recommendation
            ON recommendation.workspace_id=evidence.workspace_id
           AND recommendation.id=evidence.recommendation_id
           AND recommendation.type='qualified_demand'
        )
        SELECT
          (SELECT COUNT(*) FROM source_leads)::int AS engagers,
          (SELECT COUNT(DISTINCT person.id)
             FROM source_leads lead
             JOIN contacts person
               ON person.workspace_id=post.workspace_id
              AND person.linkedin_url_normalized=LOWER(BTRIM(lead.profile_url)))::int AS resolved_people,
          (SELECT COUNT(*) FROM attributed_recommendations)::int AS qualified_demand,
          (SELECT COUNT(*)
             FROM attributed_recommendations recommendation
             WHERE EXISTS (
               SELECT 1
               FROM conversations conversation
               JOIN conversation_messages outbound
                 ON outbound.workspace_id=conversation.workspace_id
                AND outbound.conversation_id=conversation.id
                AND outbound.direction='outbound'
                AND outbound.source_type IN ('qualified_demand_outreach','qualified_demand_reply')
                AND outbound.source_id=recommendation.id
               JOIN conversation_messages inbound
                 ON inbound.workspace_id=conversation.workspace_id
                AND inbound.conversation_id=conversation.id
                AND inbound.direction='inbound'
                AND inbound.verification_status='verified'
                AND inbound.outcome_kind='reply'
                AND inbound.occurred_at>outbound.occurred_at
               WHERE conversation.workspace_id=post.workspace_id
                 AND conversation.person_id=recommendation.person_id
             ))::int AS verified_replies,
          (SELECT COUNT(DISTINCT opportunity.id)
             FROM attributed_recommendations recommendation
             JOIN opportunities opportunity
               ON opportunity.workspace_id=post.workspace_id
              AND opportunity.origin_recommendation_id=recommendation.id)::int AS opportunities,
          (SELECT COUNT(DISTINCT opportunity.id)
             FROM attributed_recommendations recommendation
             JOIN opportunities opportunity
               ON opportunity.workspace_id=post.workspace_id
              AND opportunity.origin_recommendation_id=recommendation.id
              AND opportunity.stage='won')::int AS won
      ) stats ON TRUE
      WHERE post.workspace_id=?
        AND post.status='posted'
        AND post.content_asset_id IS NOT NULL
        AND post.published_at IS NOT NULL
      ORDER BY post.published_at DESC,post.id DESC
      LIMIT ?
    `
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(500, Math.trunc(limit))));

  return rows.map((row) => ({
    assetId: String(row.asset_id),
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    opportunityKind: row.opportunity_kind
      ? (String(row.opportunity_kind) as ContentOpportunityKind)
      : null,
    format: String(row.format) as ContentFormat,
    angle: String(row.angle) as ContentAngle,
    postId: String(row.post_id),
    publishedAt: iso(row.published_at),
    postedUrl: row.posted_url ? String(row.posted_url) : null,
    latestMetrics: latestMetricFromRow(row),
    velocity: velocityFromRow(row),
    commercial: commercialFromRow(row)
  }));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function sumCommercial(rows: ContentPublicationPerformance[]): ContentCommercialOutcomes {
  return rows.reduce<ContentCommercialOutcomes>(
    (total, row) => ({
      engagers: total.engagers + row.commercial.engagers,
      resolvedPeople: total.resolvedPeople + row.commercial.resolvedPeople,
      qualifiedDemand: total.qualifiedDemand + row.commercial.qualifiedDemand,
      verifiedReplies: total.verifiedReplies + row.commercial.verifiedReplies,
      opportunities: total.opportunities + row.commercial.opportunities,
      won: total.won + row.commercial.won
    }),
    {
      engagers: 0,
      resolvedPeople: 0,
      qualifiedDemand: 0,
      verifiedReplies: 0,
      opportunities: 0,
      won: 0
    }
  );
}

function bucketSummary(
  value: string,
  sampleSize: number,
  medianImpressions: number | null,
  commercial: ContentCommercialOutcomes
): string {
  if (sampleSize < CONTENT_LEARNING_MIN_SAMPLE) {
    return `${value}: ${sampleSize}/${CONTENT_LEARNING_MIN_SAMPLE} published samples; not enough history to compare yet.`;
  }
  const reach =
    medianImpressions === null
      ? 'impressions unavailable'
      : `median ${medianImpressions} impressions`;
  return `${value}: ${reach} across ${sampleSize} posts; ${commercial.qualifiedDemand} qualified-demand prospect${commercial.qualifiedDemand === 1 ? '' : 's'}, ${commercial.opportunities} attributed opportunit${commercial.opportunities === 1 ? 'y' : 'ies'}.`;
}

function buildBuckets(publications: ContentPublicationPerformance[]): ContentLearningBucket[] {
  const dimensions: Array<{
    dimension: ContentLearningBucket['dimension'];
    value: (row: ContentPublicationPerformance) => string | null;
  }> = [
    { dimension: 'opportunity_kind', value: (row) => row.opportunityKind },
    { dimension: 'format', value: (row) => row.format },
    { dimension: 'angle', value: (row) => row.angle }
  ];
  const output: ContentLearningBucket[] = [];
  for (const entry of dimensions) {
    const groups = new Map<string, ContentPublicationPerformance[]>();
    for (const row of publications) {
      const value = entry.value(row);
      if (!value) continue;
      groups.set(value, [...(groups.get(value) ?? []), row]);
    }
    for (const [value, rows] of groups) {
      const impressions = rows.flatMap((row) =>
        row.latestMetrics?.impressions === null || row.latestMetrics?.impressions === undefined
          ? []
          : [row.latestMetrics.impressions]
      );
      const reactions = rows.flatMap((row) =>
        row.latestMetrics?.reactions === null || row.latestMetrics?.reactions === undefined
          ? []
          : [row.latestMetrics.reactions]
      );
      const comments = rows.flatMap((row) =>
        row.latestMetrics?.comments === null || row.latestMetrics?.comments === undefined
          ? []
          : [row.latestMetrics.comments]
      );
      const commercial = sumCommercial(rows);
      const medianImpressions = median(impressions);
      output.push({
        dimension: entry.dimension,
        value,
        sampleSize: rows.length,
        metricSampleSize: impressions.length,
        medianImpressions,
        medianReactions: median(reactions),
        medianComments: median(comments),
        commercial,
        eligibleForComparison: rows.length >= CONTENT_LEARNING_MIN_SAMPLE,
        summary: bucketSummary(value, rows.length, medianImpressions, commercial)
      });
    }
  }
  return output.sort(
    (left, right) =>
      left.dimension.localeCompare(right.dimension) ||
      right.sampleSize - left.sampleSize ||
      left.value.localeCompare(right.value)
  );
}

export async function contentPerformanceReport(
  db: Db,
  workspaceId: string,
  limit = 100
): Promise<ContentPerformanceReport> {
  const publications = await listContentPublicationPerformance(db, workspaceId, limit);
  return {
    publications,
    learning: buildBuckets(publications),
    totals: { published: publications.length, ...sumCommercial(publications) }
  };
}
