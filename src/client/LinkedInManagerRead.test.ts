import { describe, expect, it } from 'vitest';
import type { ManagedCampaignWave } from '../server/linkedin/managed-campaigns';
import type { WorkflowStep } from '../server/linkedin/workflows';
import type { LinkedInLimitsReport } from './api';
import { campaignStepProgress } from './LinkedInManagerProgress';
import { accountWarmupLabel } from './LinkedInWarmup';

function report(patch: Partial<LinkedInLimitsReport['seat']> = {}): LinkedInLimitsReport {
  return {
    seat: {
      configured: true,
      label: 'Founder',
      timezone: 'Europe/Zurich',
      posture: 'warmup',
      pausedReason: null,
      warmupWeek: 1,
      warmupWeeks: 3,
      warmupMultiplier: 0.5,
      band: 'warmup',
      safetyBandOverride: false,
      warmupOverride: false,
      ...patch
    },
    limits: [],
    bands: {} as LinkedInLimitsReport['bands'],
    operatorRanges: {
      invite: { min: 0, max: 75, default: 30 },
      message: { min: 0, max: 75, default: 25 },
      profileView: { min: 0, max: 100, default: 25 },
      follow: { min: 0, max: 50, default: 20 }
    },
    campaignWarmupFractions: [0.2, 0.4, 0.6, 0.8, 1]
  } as unknown as LinkedInLimitsReport;
}

describe('campaign account warm-up label', () => {
  it('shows the active account ramp when it is still binding', () => {
    expect(accountWarmupLabel(report())).toBe('account warm-up week 1/3 · 50% active outreach');
  });

  it('shows the explicit established-account override instead of stale ramp wording', () => {
    expect(
      accountWarmupLabel(
        report({ posture: 'steady', warmupWeek: 1, warmupMultiplier: 1, warmupOverride: true })
      )
    ).toBe('account warm-up skipped');
  });

  it('shows completion once the recorded clock is past the ramp', () => {
    expect(
      accountWarmupLabel(report({ posture: 'steady', warmupWeek: 4, warmupMultiplier: 1 }))
    ).toBe('account warm-up complete');
  });
});

describe('campaign workflow step progress', () => {
  it('leads with completed work and keeps pending work explicitly separate', () => {
    const steps = [
      {
        id: 'step-1',
        action: 'profile_view',
        config: {},
        delayBefore: { unit: 'hours', amount: 0 }
      },
      {
        id: 'step-2',
        action: 'connection_request',
        config: { message: 'Hi' },
        delayBefore: { unit: 'days', amount: 1 }
      }
    ] as unknown as WorkflowStep[];
    const waves = [
      {
        stepFunnel: [
          { stepId: 'step-1', sent: 1 },
          { stepId: 'step-2', sent: 0 }
        ]
      }
    ] as unknown as ManagedCampaignWave[];

    expect(
      campaignStepProgress(
        steps,
        [
          { stepId: 'step-1', count: 19, due: 19 },
          { stepId: 'step-2', count: 5, due: 5 }
        ],
        waves
      )
    ).toEqual([
      { stepId: 'step-1', label: 'View their profile', completed: 1, pending: 19, due: 19 },
      {
        stepId: 'step-2',
        label: 'Send a connection request',
        completed: 0,
        pending: 5,
        due: 5
      }
    ]);
  });

  it('keeps an empty workflow step visible as zero done and zero pending', () => {
    const steps = [
      {
        id: 'step-1',
        action: 'profile_view',
        config: {},
        delayBefore: { unit: 'hours', amount: 0 }
      }
    ] as unknown as WorkflowStep[];

    expect(campaignStepProgress(steps, [])).toEqual([
      { stepId: 'step-1', label: 'View their profile', completed: 0, pending: 0, due: 0 }
    ]);
  });
});
