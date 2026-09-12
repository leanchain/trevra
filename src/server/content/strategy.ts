import type { ContentLearningBucket, ContentPerformanceReport } from './performance.js';
import { CONTENT_LEARNING_MIN_SAMPLE } from './performance.js';
import type { ContentAngle, ContentOpportunity } from './types.js';

export const CONTENT_DRAFT_STRATEGY_VERSION = 'outcome-v1';

export interface ContentDraftLearningHint {
  angle: ContentAngle;
  sampleSize: number;
  metricSampleSize: number;
  medianImpressions: number | null;
  qualifiedDemand: number;
  verifiedReplies: number;
  opportunities: number;
  won: number;
  summary: string;
}

export interface ContentDraftStrategy {
  angle: ContentAngle;
  source: 'heuristic' | 'performance';
  reason: string;
  eligibleAngles: ContentAngle[];
  hints: ContentDraftLearningHint[];
  minimumSample: number;
  version: string;
}

function safeAngles(opportunity: ContentOpportunity): ContentAngle[] {
  switch (opportunity.kind) {
    case 'company_change':
      return ['observation', 'teardown', 'list'];
    case 'market_pattern':
      return ['list', 'observation'];
    case 'comparison':
      return ['comparison', 'observation', 'list'];
    case 'watch_trend':
    case 'index_move':
      return ['observation', 'list'];
  }
}

function heuristicAngle(opportunity: ContentOpportunity): ContentAngle {
  switch (opportunity.kind) {
    case 'company_change':
      return opportunity.evidence.length >= 3 ? 'teardown' : 'observation';
    case 'market_pattern':
      return 'list';
    case 'comparison':
      return 'comparison';
    case 'watch_trend':
    case 'index_move':
      return 'observation';
  }
}

function hint(bucket: ContentLearningBucket): ContentDraftLearningHint {
  return {
    angle: bucket.value as ContentAngle,
    sampleSize: bucket.sampleSize,
    metricSampleSize: bucket.metricSampleSize,
    medianImpressions: bucket.medianImpressions,
    qualifiedDemand: bucket.commercial.qualifiedDemand,
    verifiedReplies: bucket.commercial.verifiedReplies,
    opportunities: bucket.commercial.opportunities,
    won: bucket.commercial.won,
    summary: bucket.summary
  };
}

function commercialVector(bucket: ContentLearningBucket): number[] {
  const n = Math.max(1, bucket.sampleSize);
  return [
    bucket.commercial.won / n,
    bucket.commercial.opportunities / n,
    bucket.commercial.verifiedReplies / n,
    bucket.commercial.qualifiedDemand / n
  ];
}

function compareVectors(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(delta) > Number.EPSILON) return delta > 0 ? -1 : 1;
  }
  return 0;
}

function compareBuckets(left: ContentLearningBucket, right: ContentLearningBucket): number {
  const commercial = compareVectors(commercialVector(left), commercialVector(right));
  if (commercial !== 0) return commercial;

  const leftReach =
    left.metricSampleSize >= CONTENT_LEARNING_MIN_SAMPLE ? left.medianImpressions : null;
  const rightReach =
    right.metricSampleSize >= CONTENT_LEARNING_MIN_SAMPLE ? right.medianImpressions : null;
  if (leftReach !== null || rightReach !== null) {
    if (leftReach === null) return 1;
    if (rightReach === null) return -1;
    if (leftReach !== rightReach) return rightReach - leftReach;
  }
  return left.value.localeCompare(right.value);
}

function hasCommercialSignal(bucket: ContentLearningBucket): boolean {
  return (
    bucket.commercial.won > 0 ||
    bucket.commercial.opportunities > 0 ||
    bucket.commercial.verifiedReplies > 0 ||
    bucket.commercial.qualifiedDemand > 0
  );
}

function hasComparableReach(bucket: ContentLearningBucket): boolean {
  return (
    bucket.metricSampleSize >= CONTENT_LEARNING_MIN_SAMPLE && bucket.medianImpressions !== null
  );
}

/**
 * Choose a framing strategy from this workspace's own observed history.
 *
 * The story's evidence score never participates here: distribution performance
 * can change HOW a proven story is framed, never whether an unsupported story
 * becomes publishable. Performance only wins after at least two safe angle
 * buckets each clear the minimum published-sample guard. Commercial outcomes
 * are compared per published post, lexicographically (won -> opportunity ->
 * verified reply -> qualified demand); reach is only a tiebreaker when at least
 * three posts in that bucket actually have an observed impression count.
 */
export function contentDraftStrategy(
  opportunity: ContentOpportunity,
  report: ContentPerformanceReport
): ContentDraftStrategy {
  const eligibleAngles = safeAngles(opportunity);
  const fallback = heuristicAngle(opportunity);
  const buckets = report.learning
    .filter(
      (bucket) =>
        bucket.dimension === 'angle' &&
        bucket.eligibleForComparison &&
        eligibleAngles.includes(bucket.value as ContentAngle)
    )
    .sort(compareBuckets);
  const hints = buckets.map(hint);

  if (buckets.length >= 2) {
    const first = buckets[0]!;
    const second = buckets[1]!;
    const commercialDiff = compareVectors(commercialVector(first), commercialVector(second)) !== 0;
    const reachDiff =
      hasComparableReach(first) &&
      hasComparableReach(second) &&
      first.medianImpressions !== second.medianImpressions;
    if ((hasCommercialSignal(first) || hasCommercialSignal(second)) && commercialDiff) {
      return {
        angle: first.value as ContentAngle,
        source: 'performance',
        reason: `Your own commercial outcomes favor ${first.value} over ${second.value}; comparison uses ${first.sampleSize} vs ${second.sampleSize} published posts and prioritizes wins, opportunities, verified replies, then qualified demand per post.`,
        eligibleAngles,
        hints,
        minimumSample: CONTENT_LEARNING_MIN_SAMPLE,
        version: CONTENT_DRAFT_STRATEGY_VERSION
      };
    }
    if (!commercialDiff && reachDiff) {
      return {
        angle: first.value as ContentAngle,
        source: 'performance',
        reason: `Commercial outcomes are tied; observed reach favors ${first.value} over ${second.value} using ${first.metricSampleSize} vs ${second.metricSampleSize} posts with readable impressions.`,
        eligibleAngles,
        hints,
        minimumSample: CONTENT_LEARNING_MIN_SAMPLE,
        version: CONTENT_DRAFT_STRATEGY_VERSION
      };
    }
  }

  return {
    angle: fallback,
    source: 'heuristic',
    reason:
      buckets.length < 2
        ? `No two safe angles have ${CONTENT_LEARNING_MIN_SAMPLE} published samples yet; using the deterministic ${opportunity.kind.replaceAll('_', ' ')} framing rule.`
        : 'Eligible angle history is tied or lacks enough observed outcome/reach separation; using the deterministic story-type framing rule.',
    eligibleAngles,
    hints,
    minimumSample: CONTENT_LEARNING_MIN_SAMPLE,
    version: CONTENT_DRAFT_STRATEGY_VERSION
  };
}
