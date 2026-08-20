import { describe, expect, it } from 'vitest';
import {
  SELECTORS,
  readOpenProfile,
  sendInMail,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';

const TARGET = 'https://www.linkedin.com/in/maya-smith/';

function fakePage(initial: Record<string, number> = {}) {
  const counts = { ...initial };
  const clicked: string[] = [];
  const filled: Array<{ selector: string; value: string }> = [];
  let current = 'https://www.linkedin.com/feed/';
  const locator = (selector: string): LinkedInLocator => ({
    count: async () => counts[selector] ?? 0,
    first: () => locator(selector),
    click: async () => {
      clicked.push(selector);
    },
    fill: async (value: string) => {
      filled.push({ selector, value });
    },
    textContent: async () => null
  });
  const page: LinkedInPage = {
    goto: async (url) => {
      current = url;
      return null;
    },
    url: () => current,
    locator,
    waitForTimeout: async () => undefined
  };
  return { page, clicked, filled, counts };
}

describe('InMail driver', () => {
  it('reports a profile without an InMail control as not Open Profile', async () => {
    const fake = fakePage();
    const result = await readOpenProfile(fake.page, TARGET);
    expect(result).toMatchObject({
      ok: true,
      externalRef: 'open-profile:false',
      failureKind: null
    });
    expect(fake.clicked).toEqual([]);
  });

  it('distinguishes free/Open Profile InMail from a credit-consuming path', async () => {
    const free = fakePage({ [SELECTORS.inmailButton]: 1 });
    expect(await readOpenProfile(free.page, TARGET)).toMatchObject({
      ok: true,
      externalRef: 'open-profile:true',
      metadata: { paidCreditRequired: false }
    });

    const paid = fakePage({ [SELECTORS.inmailButton]: 1, [SELECTORS.inmailPaidWarning]: 1 });
    expect(await readOpenProfile(paid.page, TARGET)).toMatchObject({
      ok: true,
      externalRef: 'open-profile:false',
      metadata: { paidCreditRequired: true }
    });
  });

  it('does not spend a paid credit unless the workflow explicitly permits it', async () => {
    const fake = fakePage({
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailPaidWarning]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1
    });
    const result = await sendInMail(fake.page, TARGET, 'Subject', 'Approved body', {
      allowPaid: false
    });
    expect(result).toMatchObject({ ok: false, failureKind: 'paid_credit_required' });
    expect(fake.filled).toEqual([]);
    expect(fake.clicked).toEqual([SELECTORS.inmailButton]);
  });

  it('sends subject and body through the dedicated composer and reports paid-credit consumption', async () => {
    const fake = fakePage({
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailPaidWarning]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1
    });
    const result = await sendInMail(fake.page, TARGET, 'Subject', 'Approved body', {
      allowPaid: true
    });
    expect(result).toMatchObject({
      ok: true,
      failureKind: null,
      metadata: { paidCreditConsumed: true }
    });
    expect(fake.filled).toEqual([
      { selector: SELECTORS.inmailSubject, value: 'Subject' },
      { selector: SELECTORS.inmailComposeBox, value: 'Approved body' }
    ]);
    expect(fake.clicked).toEqual([SELECTORS.inmailButton, SELECTORS.inmailSendButton]);
  });
});
