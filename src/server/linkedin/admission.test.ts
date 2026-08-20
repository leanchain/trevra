import { describe, expect, it } from 'vitest';
import { decideAdmission, workflowAdmissionDemand } from './admission.js';
import type { WorkflowStep } from './workflows.js';

const steps: WorkflowStep[] = [
  { id: 'view', action: 'profile_view', delayBefore: { amount: 0, unit: 'hours' }, config: {} },
  {
    id: 'invite',
    action: 'connection_request',
    delayBefore: { amount: 1, unit: 'days' },
    config: { message: '' }
  },
  {
    id: 'message',
    action: 'message',
    delayBefore: { amount: 1, unit: 'days' },
    config: { variants: [{ id: 'a', body: 'Hi', weight: 100 }] }
  }
];

describe('campaign wave admission', () => {
  it('counts downstream demand rather than only the first action', () => {
    expect(workflowAdmissionDemand(steps)).toMatchObject({ profile_view: 1, invite: 1, dm: 1 });
  });

  it('sizes a wave from the tightest downstream capacity', () => {
    const decision = decideAdmission({
      steps,
      pending: 100,
      inSequence: 20,
      available: { profile_view: 40, invite: 12, dm: 7, follow: 20, like: 20, endorse: 5 },
      backlog: { profile_view: 2, invite: 4, dm: 3 },
      now: new Date('2026-08-20T09:00:00Z')
    });
    expect(decision.admit).toBe(4);
    expect(decision.limitingKind).toBe('dm');
  });

  it('respects daily and in-sequence admission caps', () => {
    const decision = decideAdmission({
      steps,
      pending: 100,
      inSequence: 9,
      admittedToday: 4,
      available: { profile_view: 100, invite: 100, dm: 100 },
      backlog: {},
      policy: { maxNewLeadsPerDay: 5, maxInSequence: 10 },
      now: new Date('2026-08-20T09:00:00Z')
    });
    expect(decision.admit).toBe(1);
  });

  it('does not admit while manual mode or wave interval blocks it', () => {
    expect(
      decideAdmission({
        steps,
        pending: 10,
        inSequence: 0,
        available: { profile_view: 10, invite: 10, dm: 10 },
        backlog: {},
        policy: { mode: 'manual' },
        now: new Date('2026-08-20T09:00:00Z')
      }).admit
    ).toBe(0);
    expect(
      decideAdmission({
        steps,
        pending: 10,
        inSequence: 0,
        available: { profile_view: 10, invite: 10, dm: 10 },
        backlog: {},
        policy: { minWaveIntervalMinutes: 60 },
        lastAdmissionAt: '2026-08-20T08:30:00Z',
        now: new Date('2026-08-20T09:00:00Z')
      }).admit
    ).toBe(0);
  });

  it('uses observed acceptance only after the minimum sample and only for acceptance-gated messages', () => {
    const gated: WorkflowStep[] = [
      steps[0]!,
      steps[1]!,
      {
        id: 'message',
        action: 'message',
        delayBefore: { amount: 1, unit: 'days' },
        config: {
          variants: [{ id: 'a', body: 'Hi', weight: 100 }],
          requiresAcceptedConnection: true
        }
      }
    ];
    const thin = decideAdmission({
      steps: gated,
      pending: 100,
      inSequence: 0,
      available: { profile_view: 100, invite: 100, dm: 10 },
      backlog: {},
      acceptanceRate: 0.1,
      acceptanceSampleSize: 10,
      now: new Date('2026-08-20T09:00:00Z')
    });
    const observed = decideAdmission({
      steps: gated,
      pending: 100,
      inSequence: 0,
      available: { profile_view: 100, invite: 100, dm: 10 },
      backlog: {},
      acceptanceRate: 0.1,
      acceptanceSampleSize: 20,
      now: new Date('2026-08-20T09:00:00Z')
    });
    expect(thin.admit).toBe(28); // conservative 35% forecast
    expect(observed.admit).toBe(100); // 10 DM slots / 10% expected acceptance
    expect(thin.reasons.join(' ')).toContain('history is still thin');
    expect(observed.reasons.join(' ')).toContain('Observed invite acceptance');
  });

  it('lets outcome health only reduce admission and explains the throttle', () => {
    const baseline = decideAdmission({
      steps,
      pending: 100,
      inSequence: 0,
      available: { profile_view: 100, invite: 100, dm: 100 },
      backlog: {},
      now: new Date('2026-08-20T09:00:00Z')
    });
    const throttled = decideAdmission({
      steps,
      pending: 100,
      inSequence: 0,
      available: { profile_view: 100, invite: 100, dm: 100 },
      backlog: {},
      outcomeThrottle: 0.5,
      outcomeSampleSize: 30,
      outcomeThrottleReason: 'Execution health reduced this campaign.',
      now: new Date('2026-08-20T09:00:00Z')
    });
    expect(throttled.admit).toBe(Math.floor(baseline.admit * 0.5));
    expect(throttled.admit).toBeLessThanOrEqual(baseline.admit);
    expect(throttled.reasons).toContain('Execution health reduced this campaign.');
  });
});
