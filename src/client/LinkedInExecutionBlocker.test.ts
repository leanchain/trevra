import { describe, expect, it } from 'vitest';
import type { CampaignQueueSummary } from '../server/linkedin/managed-campaigns';
import type { LinkedInCampaignExecution } from '../server/linkedin/execution-state';
import type { LinkedInCompanionStatus, LinkedInWorkerStatus } from './api';
import { awaitingResolutionBlocker, campaignExecutionBlocker } from './LinkedInExecutionBlocker';

/**
 * THE BANNER IS THE PRODUCT HERE. An operator whose companion is online, whose
 * browser opens, and whose seat is simply resting was told "waiting for browser
 * worker" -- so these tests pin the ORDER of the ladder as much as its words:
 * every case below deliberately makes SEVERAL states true at once and asserts
 * which one is allowed to speak.
 */

const NOW = Date.parse('2026-08-24T11:00:00.000Z');

function queues(patch: Partial<CampaignQueueSummary> = {}): CampaignQueueSummary {
  return {
    pending: 0,
    dueNow: 0,
    scheduledToday: 18,
    queuedReady: 18,
    scheduledFuture: 0,
    executing: 0,
    heldForReview: 5,
    waitingForConnection: 0,
    waitingForReply: 0,
    waitingOther: 0,
    manual: 0,
    held: 0,
    blocked: 0,
    failed: 0,
    allocatedCampaignDay: { invite: 0, dm: 0, profile_view: 1, follow: 0 },
    backlogByStep: [],
    ...patch
  };
}

/** The live workspace this was written against: resting seat, refusing gate, parked invites. */
function execution(patch: Partial<LinkedInCampaignExecution> = {}): LinkedInCampaignExecution {
  return {
    seatKey: 'pankaj',
    seatLabel: 'Pankaj',
    timezone: 'Europe/Zurich',
    dueNow: 18,
    awaitingResolution: 5,
    awaitingResolutionKind: 'invite',
    restingUntil: '2026-08-24T11:52:09.000Z',
    gate: {
      kind: 'profile_view',
      allowed: false,
      check: 'day-over-day-delta',
      detail:
        "Previous business day carried 0 profile_view(s), so today's ceiling is 1 (+35%); 1 used so far."
    },
    ...patch
  };
}

function worker(patch: Partial<LinkedInWorkerStatus> = {}): LinkedInWorkerStatus {
  return {
    enabled: true,
    hosted: true,
    companionBrowser: true,
    playwrightInstalled: true,
    playwrightPath: '/app/node_modules/playwright',
    loggedIn: true,
    browser: {
      canLaunchHeaded: false,
      canLaunchHeadless: true,
      reasons: [],
      headlessReasons: []
    },
    ready: true,
    blockers: [],
    source: 'test',
    ...patch
  };
}

function companion(patch: Partial<LinkedInCompanionStatus> = {}): LinkedInCompanionStatus {
  return {
    devices: [
      {
        id: 'dev_1',
        label: "Pankaj's laptop",
        createdAt: '2026-08-01T09:00:00.000Z',
        lastSeenAt: '2026-08-24T10:59:30.000Z',
        online: true
      }
    ],
    attention: [],
    recoveries: [],
    canManage: true,
    canUse: true,
    canDisconnect: true,
    ...patch
  };
}

type BlockerInput = Parameters<typeof campaignExecutionBlocker>[0];

function blocker(patch: Partial<BlockerInput> = {}) {
  return campaignExecutionBlocker({
    senderKeys: ['pankaj'],
    queues: queues(),
    execution: execution(),
    workerStatus: worker(),
    companionStatus: companion(),
    now: NOW,
    ...patch
  });
}

describe('campaign execution blocker', () => {
  it('stays silent when nothing is due and nothing is parked', () => {
    expect(
      blocker({
        queues: queues({ queuedReady: 0, heldForReview: 0 }),
        execution: execution({ dueNow: 0, awaitingResolution: 0 })
      })
    ).toBeNull();
  });

  it('names the offline paired computer ahead of every rule it would have obeyed', () => {
    const result = blocker({
      companionStatus: companion({
        devices: [
          {
            id: 'dev_1',
            label: "Pankaj's laptop",
            createdAt: '2026-08-01T09:00:00.000Z',
            lastSeenAt: '2026-08-24T08:00:00.000Z',
            online: false
          }
        ]
      })
    });
    expect(result?.kind).toBe('companion-offline');
    expect(result?.title).toBe('Paired computer / companion offline');
  });

  it('says no computer is paired rather than that one went offline', () => {
    const result = blocker({ companionStatus: companion({ devices: [] }) });
    expect(result?.kind).toBe('companion-offline');
    expect(result?.title).toBe('No paired computer');
  });

  it('does not invent a companion on a deployment that does not use one', () => {
    // A local install has no paired computer to be offline. Without this, every
    // self-hosted queue would be explained by a pairing screen that does not exist.
    const result = blocker({
      workerStatus: worker({ companionBrowser: false, hosted: false }),
      companionStatus: companion({ devices: [] }),
      execution: execution({ restingUntil: null, gate: null })
    });
    expect(result?.kind).toBe('unclaimed');
  });

  it('keeps an open recovery window ahead of the cooldown and the gate', () => {
    const result = blocker({
      companionStatus: companion({
        recoveries: [
          {
            seatKey: 'pankaj',
            label: 'Pankaj',
            status: 'open',
            startedAt: '2026-08-24T10:55:00.000Z',
            verifiedAt: null,
            lastSeenAt: '2026-08-24T10:59:40.000Z'
          }
        ]
      })
    });
    expect(result?.kind).toBe('recovery-open');
    expect(result?.title).toBe('LinkedIn recovery in progress');
  });

  it('still explains a verified recovery whose window has not been closed', () => {
    const result = blocker({
      companionStatus: companion({
        recoveries: [
          {
            seatKey: 'pankaj',
            label: 'Pankaj',
            status: 'verified',
            startedAt: '2026-08-24T10:55:00.000Z',
            verifiedAt: '2026-08-24T10:57:00.000Z',
            lastSeenAt: '2026-08-24T10:59:40.000Z'
          }
        ]
      })
    });
    expect(result?.kind).toBe('recovery-open');
    expect(result?.title).toBe('LinkedIn recovered — recovery window still open');
    expect(result?.detail).toContain('until the visible recovery Chrome window closes');
  });

  it('ignores a recovery on an account this campaign does not send from', () => {
    const result = blocker({
      senderKeys: ['pankaj'],
      companionStatus: companion({
        recoveries: [
          {
            seatKey: 'someone-else',
            label: 'Someone else',
            status: 'open',
            startedAt: '2026-08-24T10:55:00.000Z',
            verifiedAt: null,
            lastSeenAt: '2026-08-24T10:59:40.000Z'
          }
        ]
      })
    });
    expect(result?.kind).toBe('seat-cooldown');
  });

  it('names the autonomous cooldown in the seat timezone, not the browser one', () => {
    const result = blocker();
    expect(result?.kind).toBe('seat-cooldown');
    expect(result?.title).toBe('Autonomous cooldown until 13:52');
    expect(result?.detail).toContain('Pankaj');
    expect(result?.detail).toContain('Nothing is wrong');
  });

  it('treats a cooldown that has already ended as no cooldown at all', () => {
    const result = blocker({ now: Date.parse('2026-08-24T12:00:00.000Z') });
    expect(result?.kind).toBe('safety-gate');
  });

  it('names the binding safety check and repeats its own numbers', () => {
    const result = blocker({ execution: execution({ restingUntil: null }) });
    expect(result?.kind).toBe('safety-gate');
    expect(result?.title).toBe('Profile-view safety ceiling reached');
    expect(result?.detail).toContain('day-over-day-delta');
    expect(result?.detail).toContain("so today's ceiling is 1");
  });

  it('carries the gate other refusals through with their own headline', () => {
    const result = blocker({
      execution: execution({
        restingUntil: null,
        gate: {
          kind: 'invite',
          allowed: false,
          check: 'business-hours',
          detail: 'This account works between 08:00 and 18:00 in Europe/Zurich; it is 21:14 there.'
        }
      })
    });
    expect(result?.title).toBe("Outside this account's working hours");
    expect(result?.detail).toContain('21:14');
  });

  it('does not treat an allowed gate as a blocker', () => {
    const result = blocker({
      execution: execution({
        restingUntil: null,
        gate: { kind: 'profile_view', allowed: true, check: null, detail: null }
      })
    });
    expect(result?.kind).toBe('unclaimed');
  });

  it('reports parked rows as waiting for a person once nothing else is due', () => {
    const result = blocker({
      queues: queues({ queuedReady: 0 }),
      execution: execution({ dueNow: 0, restingUntil: null, gate: null })
    });
    expect(result?.kind).toBe('awaiting-outcome-resolution');
    expect(result?.title).toBe('5 invites awaiting outcome resolution');
    expect(result?.detail).toContain('not counted as waiting for the executor');
  });

  it('keeps parked rows out of the headline while real work is still due', () => {
    // They block only themselves; the rest of the queue is unaffected, so the
    // reason the QUEUE is stopped is still the gate.
    const result = blocker({ execution: execution({ restingUntil: null }) });
    expect(result?.kind).toBe('safety-gate');
    expect(awaitingResolutionBlocker(execution())?.title).toBe(
      '5 invites awaiting outcome resolution'
    );
  });

  it('falls back to the generic wait only when nothing else can explain it', () => {
    const result = blocker({
      execution: execution({ restingUntil: null, gate: null, awaitingResolution: 0 })
    });
    expect(result?.kind).toBe('unclaimed');
    expect(result?.title).toBe('Waiting for browser worker');
  });

  it('degrades to the old message when the server cannot say more', () => {
    // An older server, or a failed read: the ladder must not go silent, and it
    // must not claim a state it has no evidence for.
    const result = blocker({ execution: null });
    expect(result?.kind).toBe('unclaimed');
    expect(awaitingResolutionBlocker(null)).toBeNull();
  });

  it('reports an unreadable executor before blaming the queue', () => {
    expect(blocker({ workerStatus: null })?.kind).toBe('executor-unknown');
    expect(
      blocker({ workerStatus: worker({ ready: false, blockers: ['Playwright is not installed'] }) })
        ?.detail
    ).toContain('Playwright is not installed');
  });
});
