import { describe, expect, it } from 'vitest';
import type {
  CampaignQueueSummary,
  ManagedCampaignWave
} from '../server/linkedin/managed-campaigns';
import type { WorkflowStep } from '../server/linkedin/workflows';
import type { LinkedInLimitsReport } from './api';
import {
  campaignStepProgress,
  campaignStepStateLines,
  memberAwaitsDecision
} from './LinkedInManagerProgress';
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

/**
 * THE STEP CARD THAT SAID "17 PENDING" ABOUT THREE DIFFERENT THINGS.
 *
 * Every number below is the live campaign an operator asked about: step 1
 * showing 13 done / 11 pending, step 2 showing 0 done / 17 pending, and the
 * question "they are not pending according to you? they are scheduled?". They
 * were right. The 17 were 5 leads parked on an outcome nobody could read back
 * -- no browser will ever claim them, they are waiting for a PERSON -- and 12
 * whose invite is not due until the next day, because step 2 of their own
 * workflow declares `delayBefore: 1 day`. The 11 on step 1 were the only ones
 * "pending" was ever honest about.
 */
const LIVE_STEPS = [
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

/** 2026-08-24 16:23 Europe/Zurich, the instant the operator was looking at the card. */
const LIVE_NOW = Date.parse('2026-08-24T14:23:39.000Z');

function backlogEntry(
  patch: Partial<CampaignQueueSummary['backlogByStep'][number]> & { stepId: string }
): CampaignQueueSummary['backlogByStep'][number] {
  return {
    count: 0,
    due: 0,
    dueNow: 0,
    running: 0,
    scheduled: 0,
    scheduledFrom: null,
    awaitingDecision: 0,
    ...patch
  };
}

describe('campaign workflow step progress', () => {
  it('leads with completed work and keeps pending work explicitly separate', () => {
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
        LIVE_STEPS,
        [
          backlogEntry({ stepId: 'step-1', count: 19, due: 19, dueNow: 19 }),
          backlogEntry({ stepId: 'step-2', count: 5, due: 5, dueNow: 5 })
        ],
        waves
      )
    ).toEqual([
      {
        stepId: 'step-1',
        label: 'View their profile',
        completed: 1,
        accepted: 0,
        tracksAcceptance: false,
        pending: 19,
        due: 19,
        dueNow: 19,
        running: 0,
        scheduled: 0,
        scheduledFrom: null,
        awaitingDecision: 0,
        other: 0,
        delayBefore: null
      },
      {
        stepId: 'step-2',
        label: 'Send a connection request',
        completed: 0,
        accepted: 0,
        tracksAcceptance: true,
        pending: 5,
        due: 5,
        dueNow: 5,
        running: 0,
        scheduled: 0,
        scheduledFrom: null,
        awaitingDecision: 0,
        other: 0,
        delayBefore: { unit: 'days', amount: 1 }
      }
    ]);
  });

  it('keeps an empty workflow step visible as zero done and zero pending', () => {
    expect(campaignStepProgress([LIVE_STEPS[0]!], [])).toEqual([
      {
        stepId: 'step-1',
        label: 'View their profile',
        completed: 0,
        accepted: 0,
        tracksAcceptance: false,
        pending: 0,
        due: 0,
        dueNow: 0,
        running: 0,
        scheduled: 0,
        scheduledFrom: null,
        awaitingDecision: 0,
        other: 0,
        delayBefore: null
      }
    ]);
  });

  it('carries the yes, not just the send, on the step that can have one', () => {
    /*
     * "16 connection requests sent" and "16 sent, 9 accepted" are the same
     * campaign and completely different news. The screen only ever showed the
     * first, so the number an operator is actually buying was nowhere on it.
     *
     * Acceptance is counted for invite rows only, which is why every other step
     * says it does not track one: a 0 next to a profile view would be a fact
     * about nothing.
     */
    const waves = [
      {
        stepFunnel: [
          { stepId: 'step-1', sent: 13, accepted: 0 },
          { stepId: 'step-2', sent: 10, accepted: 4 }
        ]
      },
      {
        stepFunnel: [{ stepId: 'step-2', sent: 6, accepted: 5 }]
      }
    ] as unknown as ManagedCampaignWave[];

    const [step1, step2] = campaignStepProgress(LIVE_STEPS, [], waves);
    expect(step1).toMatchObject({ completed: 13, accepted: 0, tracksAcceptance: false });
    // Summed across waves, exactly as the send count already is.
    expect(step2).toMatchObject({ completed: 16, accepted: 9, tracksAcceptance: true });
  });

  it('does not blame a delay for a monitor step, whose wait is the prospect', () => {
    const steps = [
      {
        id: 'wait-accept',
        action: 'monitor',
        config: { condition: { kind: 'connected' } },
        delayBefore: { unit: 'days', amount: 3 }
      }
    ] as unknown as WorkflowStep[];

    expect(campaignStepProgress(steps, [])[0]!.delayBefore).toBeNull();
  });

  it('accounts for a lead no bucket named rather than folding it into the nearest one', () => {
    // An older server that sends only `count`/`due` must not make every lead on
    // the step read as "in another state" -- but it must not silently lose them
    // either.
    const [step] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({ stepId: 'step-1', count: 11, due: 11, dueNow: 8 })
    ]);
    expect(step).toMatchObject({ dueNow: 8, other: 3 });
  });
});

describe('campaign workflow step state lines', () => {
  const lines = (
    entry: ReturnType<typeof campaignStepProgress>[number],
    stepIndex: number,
    now = LIVE_NOW
  ) =>
    campaignStepStateLines(entry, stepIndex, { timezone: 'Europe/Zurich', now }).map((l) => l.text);

  it('splits the live "17 pending" into the two different waits it always was', () => {
    const progress = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({ stepId: 'step-1', count: 11, due: 11, dueNow: 11 }),
      backlogEntry({
        stepId: 'step-2',
        count: 17,
        due: 5,
        awaitingDecision: 5,
        scheduled: 12,
        scheduledFrom: '2026-08-25T09:47:45.000Z'
      })
    ]);

    expect(lines(progress[0]!, 0)).toEqual(['11 due now']);
    expect(lines(progress[1]!, 1)).toEqual([
      '12 scheduled for tomorrow from 11:47 — this step waits 1 day after the step before it',
      '5 awaiting your decision'
    ]);
  });

  it('marks only the human decision as needing attention', () => {
    const [, step2] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({
        stepId: 'step-2',
        count: 17,
        due: 5,
        awaitingDecision: 5,
        scheduled: 12,
        scheduledFrom: '2026-08-25T09:47:45.000Z'
      })
    ]);

    expect(
      campaignStepStateLines(step2!, 1, { timezone: 'Europe/Zurich', now: LIVE_NOW }).map(
        (line) => [line.kind, line.attention]
      )
    ).toEqual([
      ['scheduled', false],
      ['awaiting-decision', true]
    ]);
  });

  it('prints no line at all for a state with nothing in it', () => {
    const [step1] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({ stepId: 'step-1', count: 0, due: 0 })
    ]);
    expect(lines(step1!, 0)).toEqual([]);
  });

  it('names a claimed action as in flight rather than as queued work', () => {
    const [step1] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({ stepId: 'step-1', count: 4, due: 4, dueNow: 3, running: 1 })
    ]);
    expect(lines(step1!, 0)).toEqual(['3 due now', '1 sending now']);
  });

  it('reads the schedule off the account’s clock, not the reader’s', () => {
    // 23:47 UTC on the 24th is 01:47 on the 25th in Zurich: "tomorrow" for the
    // seat, still today for anyone reading in UTC.
    const [, step2] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({
        stepId: 'step-2',
        count: 2,
        scheduled: 2,
        scheduledFrom: '2026-08-24T23:47:00.000Z'
      })
    ]);
    expect(
      campaignStepStateLines(step2!, 1, { timezone: 'Europe/Zurich', now: LIVE_NOW })[0]!.text
    ).toBe('2 scheduled for tomorrow from 01:47 — this step waits 1 day after the step before it');
  });

  it('dates a slot further out instead of calling everything tomorrow', () => {
    const [, step2] = campaignStepProgress(LIVE_STEPS, [
      backlogEntry({
        stepId: 'step-2',
        count: 3,
        scheduled: 3,
        scheduledFrom: '2026-08-27T07:15:00.000Z'
      })
    ]);
    expect(lines(step2!, 1)).toEqual([
      '3 scheduled for Thu 27 Aug from 09:15 — this step waits 1 day after the step before it'
    ]);
  });

  it('says what a first step is waiting for, since it has no step before it', () => {
    const steps = [
      {
        id: 'step-1',
        action: 'profile_view',
        config: {},
        delayBefore: { unit: 'hours', amount: 6 }
      }
    ] as unknown as WorkflowStep[];
    const [step1] = campaignStepProgress(steps, [
      backlogEntry({
        stepId: 'step-1',
        count: 4,
        scheduled: 4,
        scheduledFrom: '2026-08-24T18:00:00.000Z'
      })
    ]);
    expect(lines(step1!, 0)).toEqual([
      '4 scheduled from 20:00 — this step waits 6 hours after a lead joins the campaign'
    ]);
  });
});

/**
 * "1 AWAITING YOUR DECISION" WITH NOWHERE TO GO.
 *
 * The card counted the parked leads and stopped there. The operator asked
 * where the decision was made, and the honest answer was: expand rows in a
 * 108-lead table until you hit the one whose recorded history carries the
 * buttons. This is the predicate the lead filter and the step card now share,
 * so they cannot disagree about which leads that line means.
 */
describe('leads awaiting a decision', () => {
  const member = (settlementHoldAt: string | null, status = 'planned') =>
    ({
      lastAction: { id: 'lact_1', kind: 'invite', status, settlementHoldAt, failureKind: null }
    }) as unknown as Parameters<typeof memberAwaitsDecision>[0];

  it('names the lead whose last action is parked for a person', () => {
    expect(memberAwaitsDecision(member('2026-08-26T19:22:11.897Z'))).toBe(true);
  });

  it('leaves a lead whose action is merely planned out of it', () => {
    expect(memberAwaitsDecision(member(null))).toBe(false);
  });

  it('leaves a lead with no action at all out of it', () => {
    expect(
      memberAwaitsDecision({ lastAction: null } as unknown as Parameters<
        typeof memberAwaitsDecision
      >[0])
    ).toBe(false);
  });
});
