import { describe, expect, it } from 'vitest';
import { LINKEDIN_LIMITS, PACED_KINDS, effectiveDailyCeiling, seatOperatorLimit } from './limits.js';
import type { LinkedInSeat } from './seats.js';

/**
 * PURE, AND DELIBERATELY WITHOUT A DATABASE.
 *
 * Everything asserted here is arithmetic over a table of numbers and a
 * four-way mapping, which is exactly the sort of thing that is cheap to test
 * directly and expensive to test through a gate that also reads a ledger. The
 * gate's own tests (`guard.test.ts`) then only have to assert that it USES
 * these, not that they are right.
 */

/**
 * A seat with the four operator ceilings set, and nothing else.
 *
 * Cast rather than fully populated on purpose: `seatOperatorLimit` reads
 * exactly four fields, and building a whole seat row here would tie this file
 * to every column `seats.ts` ever grows.
 */
const account = {
  dailyInviteLimit: 30,
  dailyMessageLimit: 25,
  dailyProfileViewLimit: 25,
  dailyFollowLimit: 20
} as unknown as LinkedInSeat;

describe('seatOperatorLimit', () => {
  it('maps every paced kind onto the operator field that governs it', () => {
    expect(seatOperatorLimit(account, 'invite')).toBe(30);
    // ONE POOL over the three message kinds -- "25 messages a day" is a
    // statement about the account, not about DMs.
    expect(seatOperatorLimit(account, 'dm')).toBe(25);
    expect(seatOperatorLimit(account, 'reply')).toBe(25);
    expect(seatOperatorLimit(account, 'inmail')).toBe(25);
    expect(seatOperatorLimit(account, 'profile_view')).toBe(25);
    expect(seatOperatorLimit(account, 'follow')).toBe(20);
  });

  it('invents nothing for the kinds nobody was asked about', () => {
    // Likes and endorsements have a researched band and no settings field.
    // Null is the honest answer; a number here would launder a guess into a
    // setting.
    expect(seatOperatorLimit(account, 'like')).toBeNull();
    expect(seatOperatorLimit(account, 'endorse')).toBeNull();
  });

  it('answers null for every kind when there is no seat at all', () => {
    for (const kind of PACED_KINDS) expect(seatOperatorLimit(undefined, kind)).toBeNull();
  });
});

describe('effectiveDailyCeiling', () => {
  it("falls back to Trevra's band when the operator set no number", () => {
    expect(effectiveDailyCeiling(LINKEDIN_LIMITS.invite.steady.perDay, null, false)).toBe(18);
    // An override with nothing to prefer is not an override of anything.
    expect(effectiveDailyCeiling(LINKEDIN_LIMITS.invite.steady.perDay, null, true)).toBe(18);
  });

  it('takes the stricter of the two when there is no override', () => {
    // The operator asking for less gets less...
    expect(effectiveDailyCeiling(18, 5, false)).toBe(5);
    // ...and the operator asking for more does not get more, because a
    // settings field is not evidence.
    expect(effectiveDailyCeiling(18, 40, false)).toBe(18);
  });

  it("lets the operator's number bind, either way, when the seat overrides the band", () => {
    expect(effectiveDailyCeiling(18, 40, true)).toBe(40);
    // Including downwards: an override is "my number", not "more".
    expect(effectiveDailyCeiling(18, 5, true)).toBe(5);
    expect(effectiveDailyCeiling(3, 25, true)).toBe(25);
  });
});
