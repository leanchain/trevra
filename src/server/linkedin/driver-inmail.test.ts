import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const uploaded: Array<{ selector: string; name: string; mimeType: string; size: number }> = [];
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
    setInputFiles: async (file) => {
      uploaded.push({
        selector,
        name: file.name,
        mimeType: file.mimeType,
        size: file.buffer.byteLength
      });
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
  return { page, clicked, filled, uploaded, counts };
}

afterEach(() => vi.unstubAllGlobals());

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
  it('never sends the text when an attachment cannot be verified in the composer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'application/pdf', 'content-length': '3' }
          })
      )
    );
    const fake = fakePage({
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1,
      [SELECTORS.inmailAttachmentInput]: 1
    });
    const result = await sendInMail(fake.page, TARGET, 'Subject', 'Approved body', {
      attachment: {
        url: 'https://files.example.test/deck.pdf',
        name: 'deck.pdf',
        mediaKind: 'file'
      }
    });
    expect(result).toMatchObject({ ok: false, failureKind: 'unknown' });
    expect(fake.uploaded).toEqual([
      {
        selector: SELECTORS.inmailAttachmentInput,
        name: 'deck.pdf',
        mimeType: 'application/pdf',
        size: 3
      }
    ]);
    expect(fake.clicked).toEqual([SELECTORS.inmailButton]);
  });

  it('sends only after the requested file is uploaded and a LinkedIn attachment preview appears', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([71, 73, 70]), {
            status: 200,
            headers: { 'content-type': 'image/gif', 'content-length': '3' }
          })
      )
    );
    const fake = fakePage({
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1,
      [SELECTORS.inmailAttachmentInput]: 1,
      [SELECTORS.inmailAttachmentPreview]: 1
    });
    const result = await sendInMail(fake.page, TARGET, 'Subject', 'Approved body', {
      attachment: { url: 'https://files.example.test/demo.gif', mediaKind: 'gif' }
    });
    expect(result).toMatchObject({ ok: true, failureKind: null });
    expect(fake.uploaded[0]).toMatchObject({ name: 'demo.gif', mimeType: 'image/gif', size: 3 });
    expect(fake.clicked).toEqual([SELECTORS.inmailButton, SELECTORS.inmailSendButton]);
  });

  it('refuses native voice metadata instead of sending a text-only fallback', async () => {
    const fake = fakePage({
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1
    });
    const result = await sendInMail(fake.page, TARGET, 'Subject', 'Approved body', {
      attachment: { url: 'https://files.example.test/note.m4a', mediaKind: 'voice' }
    });
    expect(result).toMatchObject({ ok: false, failureKind: 'compose_unavailable' });
    expect(fake.clicked).toEqual([SELECTORS.inmailButton]);
  });
});
