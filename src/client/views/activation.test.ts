import { describe, expect, it } from 'vitest';
import { nextActivationStep, type ActivationSignals } from './activation';

describe('nextActivationStep', () => {
  it('offers only the first incomplete step', () => {
    const signals: ActivationSignals = {
      agent: true,
      source: false,
      policy: false,
      work: false
    };

    expect(nextActivationStep(signals)).toMatchObject({
      state: 'next',
      step: { id: 'source' }
    });
  });

  it('does not turn an unread state into an incomplete state', () => {
    const signals: ActivationSignals = {
      agent: true,
      source: null,
      policy: false,
      work: false
    };

    expect(nextActivationStep(signals)).toMatchObject({
      state: 'unknown',
      step: { id: 'source' }
    });
  });

  it('handles an asynchronous transition from unread to activated', () => {
    expect(
      nextActivationStep({
        agent: null,
        source: null,
        policy: null,
        work: null
      }).state
    ).toBe('unknown');

    expect(
      nextActivationStep({
        agent: true,
        source: true,
        policy: true,
        work: true
      })
    ).toEqual({ state: 'complete', step: null });
  });
});
