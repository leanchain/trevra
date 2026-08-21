import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlaybookStepRun } from '../../shared/types';
import { ApprovalDecisionProof } from './inspector';

const baseStep: PlaybookStepRun = {
  id: 'step-run-1',
  stepId: 'approve-send',
  stepType: 'approval',
  skillId: null,
  skillVersion: null,
  skillRunId: null,
  status: 'waiting_approval',
  attempt: 1,
  input: { recipient: 'founder@example.com', subject: 'Hello' },
  output: null,
  evidence: [
    {
      label: 'Company announcement',
      detail: 'The company reported a new market launch.',
      sourceUrl: 'https://example.com/announcement',
      classification: 'reported',
      observedAt: '2026-08-20T10:00:00.000Z'
    }
  ],
  error: null,
  policyDecision: {
    effect: 'require_approval',
    policyName: 'External outreach',
    reason: 'A message leaves the workspace.'
  },
  approvalPayloadHash: 'abcdef0123456789',
  startedAt: '2026-08-21T10:00:00.000Z',
  finishedAt: null,
  updatedAt: '2026-08-21T10:00:00.000Z'
};

describe('ApprovalDecisionProof', () => {
  it('puts action, evidence, policy, and fingerprint at the decision point', () => {
    const markup = renderToStaticMarkup(<ApprovalDecisionProof step={baseStep} />);

    expect(markup).toContain('Exact prepared action');
    expect(markup).toContain('Company announcement');
    expect(markup).toContain('Reported');
    expect(markup).toContain('External outreach');
    expect(markup).toContain('abcdef012345');
  });

  it('states why approval is unavailable when the fingerprint is missing', () => {
    const markup = renderToStaticMarkup(
      <ApprovalDecisionProof step={{ ...baseStep, approvalPayloadHash: null }} />
    );

    expect(markup).toContain('Payload fingerprint missing');
    expect(markup).toContain('approval is unavailable');
  });
});
