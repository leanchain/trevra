import { describe, expect, it } from 'vitest';
import type { ContentPerformanceReport } from './performance.js';
import { contentDraftStrategy } from './strategy.js';
import type { ContentLearningBucket } from './performance.js';
import type { ContentOpportunity } from './types.js';

function opportunity(evidenceCount = 2): ContentOpportunity {
  return {
    id: 'cop_test',
    workspaceId: 'ws_test',
    status: 'ready',
    kind: 'company_change',
    title: 'Acme changed',
    thesis: 'Multiple current changes line up.',
    audience: null,
    freshnessAt: '2026-09-12T10:00:00.000Z',
    score: 90,
    rationale: [],
    evidence: Array.from({ length: evidenceCount }, (_, index) => ({
      sourceType: 'account_signal' as const,
      sourceId: `sig_${index}`,
      label: `signal ${index}`,
      detail: `Observed fact ${index}.`,
      sourceUrl: `https://acme.example/${index}`,
      observedAt: '2026-09-12T10:00:00.000Z'
    })),
    fingerprint: 'fp_test',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z'
  };
}

function bucket(
  angle: 'observation' | 'teardown' | 'list',
  input: Partial<ContentLearningBucket> = {}
): ContentLearningBucket {
  return {
    dimension: 'angle',
    value: angle,
    sampleSize: 3,
    metricSampleSize: 3,
    medianImpressions: 1000,
    medianReactions: 10,
    medianComments: 2,
    commercial: {
      engagers: 0,
      resolvedPeople: 0,
      qualifiedDemand: 0,
      verifiedReplies: 0,
      opportunities: 0,
      won: 0
    },
    eligibleForComparison: true,
    summary: `${angle}: test`,
    ...input
  };
}

function report(learning: ContentLearningBucket[]): ContentPerformanceReport {
  return {
    publications: [],
    learning,
    velocityBaseline: {
      sampleSize: 0,
      medianImpressionsPerHour: null,
      eligibleForComparison: false
    },
    totals: {
      published: 0,
      engagers: 0,
      resolvedPeople: 0,
      qualifiedDemand: 0,
      verifiedReplies: 0,
      opportunities: 0,
      won: 0
    }
  };
}

describe('contentDraftStrategy', () => {
  it('uses deterministic story framing until two safe angles clear the sample guard', () => {
    expect(contentDraftStrategy(opportunity(2), report([]))).toMatchObject({
      angle: 'observation',
      source: 'heuristic',
      minimumSample: 3
    });
    expect(contentDraftStrategy(opportunity(3), report([bucket('observation')]))).toMatchObject({
      angle: 'teardown',
      source: 'heuristic'
    });
  });

  it('prioritizes normalized commercial outcomes over reach once both angle samples are eligible', () => {
    const strategy = contentDraftStrategy(
      opportunity(3),
      report([
        bucket('observation', {
          sampleSize: 4,
          metricSampleSize: 4,
          medianImpressions: 9000,
          commercial: {
            engagers: 40,
            resolvedPeople: 10,
            qualifiedDemand: 2,
            verifiedReplies: 1,
            opportunities: 0,
            won: 0
          }
        }),
        bucket('teardown', {
          sampleSize: 3,
          metricSampleSize: 3,
          medianImpressions: 2000,
          commercial: {
            engagers: 12,
            resolvedPeople: 5,
            qualifiedDemand: 2,
            verifiedReplies: 1,
            opportunities: 1,
            won: 0
          }
        })
      ])
    );
    expect(strategy).toMatchObject({ angle: 'teardown', source: 'performance' });
    expect(strategy.reason).toContain('wins, opportunities, verified replies');
  });

  it('uses reach only as a tie-breaker when each compared angle has enough readable impression samples', () => {
    const enough = contentDraftStrategy(
      opportunity(3),
      report([
        bucket('observation', { medianImpressions: 1200, metricSampleSize: 3 }),
        bucket('teardown', { medianImpressions: 2800, metricSampleSize: 3 })
      ])
    );
    expect(enough).toMatchObject({ angle: 'teardown', source: 'performance' });

    const sparse = contentDraftStrategy(
      opportunity(3),
      report([
        bucket('observation', { medianImpressions: 1200, metricSampleSize: 2 }),
        bucket('teardown', { medianImpressions: 2800, metricSampleSize: 2 })
      ])
    );
    expect(sparse).toMatchObject({ angle: 'teardown', source: 'heuristic' });
  });
});
