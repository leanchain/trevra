import { describe, expect, it } from 'vitest';
import {
  classifyDeliveryFailure,
  classifyVerifiedInboundEmail,
  stripQuotedReply
} from './email-outcomes.js';

describe('verified inbound email classification', () => {
  it('classifies explicit unsubscribe intent from only the new reply text', () => {
    expect(
      classifyVerifiedInboundEmail({
        subject: 'Re: hello',
        body: 'Please remove me from this list.\n\nOn Thu, Alex wrote:\n> Would you like a demo?'
      })
    ).toBe('unsubscribe');
    expect(stripQuotedReply('Thanks\n\nOn Thu, Alex wrote:\n> unsubscribe link')).toBe('Thanks');
  });

  it('separates human replies, out-of-office, automatic replies and unknown messages', () => {
    expect(
      classifyVerifiedInboundEmail({ subject: 'Re: hello', body: 'Friday works for me.' })
    ).toBe('reply');
    expect(
      classifyVerifiedInboundEmail({ subject: 'Out of office', body: 'I am away until Monday.' })
    ).toBe('out_of_office');
    expect(
      classifyVerifiedInboundEmail({
        subject: 'Automatic reply',
        body: 'This mailbox received your message.',
        autoSubmitted: 'auto-replied'
      })
    ).toBe('auto_reply');
    expect(classifyVerifiedInboundEmail({})).toBe('unknown');
  });

  it('distinguishes hard address bounce evidence from generic delivery failures', () => {
    expect(
      classifyDeliveryFailure({ subject: 'Undeliverable', body: '550 5.1.1 user unknown' })
    ).toBe('bounce');
    expect(
      classifyDeliveryFailure({ subject: 'Delivery Status Notification (Failure)', body: '' })
    ).toBe('delivery_failure');
  });
});
