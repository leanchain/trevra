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
  it('keeps a generic approval focused on the action and why it needs approval', () => {
    const markup = renderToStaticMarkup(<ApprovalDecisionProof step={baseStep} />);

    expect(markup).toContain('Prepared action');
    expect(markup).toContain('Recipient');
    expect(markup).toContain('External outreach');
    expect(markup).not.toContain('payload fingerprint');
    expect(markup).not.toContain('abcdef012345');
  });

  it('organizes community reply approvals around action, context, and collapsed checks', () => {
    const markup = renderToStaticMarkup(
      <ApprovalDecisionProof
        step={{
          ...baseStep,
          input: {
            platform: 'stackoverflow',
            threadExternalId: '79948695',
            threadUrl:
              'https://stackoverflow.com/questions/79948695/how-can-i-avoid-using-llms-as-a-software-developer',
            community: null,
            body: 'A prepared reply.\n\nhttps://trevra.com',
            metadata: {
              threadTitle: 'How can I avoid using LLMs as a software developer?',
              threadAuthor: 'Lajos Arpad',
              relevanceScore: 1.5,
              angle: 'technical_deepdive',
              safetyAllowed: true,
              safetyReason: null,
              safetyChecks: [
                { check: 'daily-cap', detail: '0 of 5 posts used.', passed: true },
                { check: 'blacklisted-keyword', detail: 'No blocked terms.', passed: true }
              ],
              critiquePassed: true,
              critiqueFindings: [],
              automationMode: 'unknown',
              submitUrl: null
            }
          }
        }}
      />
    );

    expect(markup).toContain('How can I avoid using LLMs as a software developer?');
    expect(markup).toContain('A prepared reply.');
    expect(markup).toContain('2/2 safety checks passed');
    expect(markup).toContain('Hover or focus the Guard step for safety details');
    expect(markup).not.toContain('>Details<');
    expect(markup).not.toContain('payload fingerprint');
    expect(markup).not.toContain('Technical approval record');
  });

  it('renders an edited community reply directly in the approval field', () => {
    const markup = renderToStaticMarkup(
      <ApprovalDecisionProof
        step={{
          ...baseStep,
          input: {
            platform: 'stackoverflow',
            threadUrl: 'https://stackoverflow.com/questions/1/example',
            body: 'Original reply',
            metadata: { threadTitle: 'Example thread', safetyChecks: [] }
          }
        }}
        replyValue="Edited reply"
        onReplyChange={() => undefined}
      />
    );

    expect(markup).toContain('<textarea');
    expect(markup).toContain('Edited reply');
    expect(markup).not.toContain('Original reply');
  });
});
