import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LinkedInLimitsReport, LinkedInSeat } from './api';
import {
  ScheduleFields,
  capabilityDraftToPatch,
  capabilityPatchChanged,
  draftToPatch,
  type AccountDraft
} from './LinkedInAccountForm';

const draft = (warmupOverride = false): AccountDraft => ({
  label: 'Founder',
  timezone: 'Europe/Zurich',
  workingDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  dailyInviteLimit: '20',
  dailyMessageLimit: '15',
  dailyProfileViewLimit: '20',
  dailyFollowLimit: '10',
  safetyBandOverride: false,
  warmupOverride,
  proxyUrl: '',
  proxyRemove: false
});

const safety = {
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
    warmupOverride: false
  },
  operatorRanges: {
    invite: { min: 0, max: 75, default: 30 },
    message: { min: 0, max: 75, default: 25 },
    profileView: { min: 0, max: 100, default: 25 },
    follow: { min: 0, max: 50, default: 20 }
  },
  bands: {
    invite: { perDay: 18 },
    dm: { perDay: 12 },
    profile_view: { perDay: 15 },
    follow: { perDay: 12 }
  },
  campaignWarmupFractions: [0.2, 0.4, 0.6, 0.8, 1]
} as unknown as LinkedInLimitsReport;

describe('LinkedIn account warm-up controls', () => {
  it('serializes the explicit account warm-up override into the account PATCH', () => {
    expect(draftToPatch(draft(true), null)).toMatchObject({
      warmupOverride: true,
      safetyBandOverride: false,
      timezone: 'Europe/Zurich',
      workStartMinute: 540,
      workEndMinute: 1020
    });
  });

  it('renders the recorded account warm-up clock beside the skip control', () => {
    const html = renderToStaticMarkup(
      <ScheduleFields
        draft={draft(false)}
        onChange={() => undefined}
        idPrefix="test"
        safety={safety}
        bandOverride
        activatedAt="2026-08-20T09:00:00.000Z"
      />
    );
    expect(html).toContain('Account warm-up');
    expect(html).toContain('Skip Trevra account warm-up for this established LinkedIn account');
    expect(html).toContain('recorded clock is week 1 of 3');
    expect(html).toContain('Current account multiplier: 50% for active outreach');
  });

  it('explains that skipping account warm-up does not remove the campaign ramp', () => {
    const html = renderToStaticMarkup(
      <ScheduleFields
        draft={draft(true)}
        onChange={() => undefined}
        idPrefix="test"
        safety={safety}
        bandOverride
        activatedAt="2026-08-20T09:00:00.000Z"
      />
    );
    expect(html).toContain('account-level multiplier is 100% immediately');
    expect(html).toContain('Campaign warm-up');
    expect(html).toContain('20% → 40% → 60% → 80% → 100%');
  });
});

describe('LinkedIn capability save validation', () => {
  it('parses valid capability settings before any API write', () => {
    expect(
      capabilityDraftToPatch({
        inmail: 'available',
        premium: true,
        salesNavigator: true,
        recruiter: false,
        monthly: '50',
        paid: ''
      })
    ).toEqual({
      inmail: 'available',
      premium: true,
      salesNavigator: true,
      recruiter: false,
      inmailMonthlyBudget: 50,
      inmailPaidCreditCap: null
    });
  });

  it('refuses invalid credit counts locally instead of partially saving the form', () => {
    expect(() =>
      capabilityDraftToPatch({
        inmail: 'unknown',
        premium: false,
        salesNavigator: false,
        recruiter: false,
        monthly: '10001',
        paid: ''
      })
    ).toThrow(/0 to 10000/);
  });

  it('does not call the capabilities API for an unchanged capability draft', () => {
    const account = {
      capabilities: {
        inmail: 'unknown',
        premium: false,
        salesNavigator: false,
        recruiter: false
      },
      inmailMonthlyBudget: null,
      inmailPaidCreditCap: null
    } as LinkedInSeat;
    const patch = capabilityDraftToPatch({
      inmail: 'unknown',
      premium: false,
      salesNavigator: false,
      recruiter: false,
      monthly: '',
      paid: ''
    });
    expect(capabilityPatchChanged(account, patch)).toBe(false);
    expect(capabilityPatchChanged(account, { ...patch, premium: true })).toBe(true);
  });
});
