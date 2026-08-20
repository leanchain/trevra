import { describe, expect, it } from 'vitest';
import { workflowStepsSchema } from './workflows.js';

describe('managed workflow graph', () => {
  it('keeps legacy linear workflows readable without an explicit End node', () => {
    expect(
      workflowStepsSchema.safeParse([
        { id: 'v', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} }
      ]).success
    ).toBe(true);
  });

  it('accepts an acceptance monitor with explicit yes/no terminal paths', () => {
    const parsed = workflowStepsSchema.safeParse([
      {
        id: 'invite',
        action: 'connection_request',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { message: '' }
      },
      {
        id: 'monitor',
        action: 'monitor',
        delayBefore: { amount: 0, unit: 'hours' },
        config: {
          condition: { kind: 'accepted', ofStepId: 'invite' },
          timeout: { amount: 10, unit: 'days' },
          pollEveryMinutes: 60,
          yesStepId: 'yes',
          noStepId: 'no'
        }
      },
      {
        id: 'yes',
        action: 'end',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { outcome: 'completed' }
      },
      {
        id: 'no',
        action: 'end',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { outcome: 'not_accepted' }
      }
    ]);
    expect(parsed.success).toBe(true);
  });

  it('rejects backward edges and unreachable orphan nodes', () => {
    const parsed = workflowStepsSchema.safeParse([
      {
        id: 'end',
        action: 'end',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { outcome: 'completed' }
      },
      {
        id: 'wait',
        action: 'wait',
        delayBefore: { amount: 0, unit: 'hours' },
        nextStepId: 'end',
        config: { duration: { amount: 1, unit: 'days' } }
      }
    ]);
    expect(parsed.success).toBe(false);
  });
});
