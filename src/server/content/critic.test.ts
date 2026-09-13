import { describe, expect, it } from 'vitest';
import { critiqueContentDraft } from './critic.js';
import type { ContentOpportunity } from './types.js';

const NOW = new Date('2026-09-13T12:00:00.000Z');

function story(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  return {
    id: 'cop_critic',
    workspaceId: 'ws_critic',
    status: 'ready',
    kind: 'company_change',
    title: 'Acme: hiring + pricing',
    thesis: 'Acme shows two recent changes worth reading together.',
    audience: null,
    freshnessAt: '2026-09-13T10:00:00.000Z',
    score: 88,
    rationale: [],
    evidence: [
      {
        sourceType: 'account_signal',
        sourceId: 'sig_hiring',
        label: 'hiring up',
        detail: 'Acme added five platform roles.',
        sourceUrl: 'https://acme.example/careers',
        observedAt: '2026-09-13T09:00:00.000Z'
      },
      {
        sourceType: 'account_signal',
        sourceId: 'sig_pricing',
        label: 'pricing changed',
        detail: 'Acme changed enterprise pricing.',
        sourceUrl: 'https://acme.example/pricing',
        observedAt: '2026-09-13T10:00:00.000Z'
      }
    ],
    fingerprint: 'company_change:critic',
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...overrides
  };
}

function validDraft(opportunity = story()) {
  return {
    angle: 'observation' as const,
    body: [
      opportunity.title,
      opportunity.thesis,
      opportunity.evidence[0]!.detail,
      opportunity.evidence[1]!.detail
    ].join('\n\n'),
    claimMap: [
      { claim: opportunity.title, evidence: opportunity.evidence },
      { claim: opportunity.thesis, evidence: opportunity.evidence },
      ...opportunity.evidence.map((evidence) => ({ claim: evidence.detail, evidence: [evidence] }))
    ]
  };
}

describe('content proof critic', () => {
  it('passes canonical source-backed copy', () => {
    const opportunity = story();
    const result = critiqueContentDraft(opportunity, validDraft(opportunity), NOW);
    expect(result).toMatchObject({ passed: true, blockers: [] });
  });

  it('blocks stale stories before any post can be created', () => {
    const opportunity = story({ freshnessAt: '2026-08-20T10:00:00.000Z' });
    const result = critiqueContentDraft(opportunity, validDraft(opportunity), NOW);
    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'stale_story' })])
    );
  });

  it('blocks unsupported claims and evidence outside the immutable story snapshot', () => {
    const opportunity = story();
    const draft = validDraft(opportunity);
    draft.body += '\n\nAcme doubled revenue.';
    draft.claimMap.push({
      claim: 'Acme doubled revenue.',
      evidence: [
        {
          ...opportunity.evidence[0]!,
          sourceId: 'sig_foreign',
          sourceUrl: 'https://other.example/'
        }
      ]
    });
    const result = critiqueContentDraft(opportunity, draft, NOW);
    expect(result.passed).toBe(false);
    expect(result.blockers.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unsupported_claim', 'foreign_evidence'])
    );
  });

  it('blocks channel overflow and unlabeled prediction inference', () => {
    const opportunity = story();
    const draft = validDraft(opportunity);
    const result = critiqueContentDraft(
      opportunity,
      { ...draft, angle: 'prediction', body: `${draft.body}\n\n${'x'.repeat(3100)}` },
      NOW
    );
    expect(result.passed).toBe(false);
    expect(result.blockers.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['channel_length', 'unlabeled_inference'])
    );
  });
});
