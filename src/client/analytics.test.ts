import { describe, expect, it } from 'vitest';
import { NOT_ENOUGH_DATA, RATE_MIN_SAMPLE, ratePercent } from './analytics';

/**
 * THE TWO NUMBERS A RATE MUST NEVER PRINT ARE 0% AND 100%.
 *
 * Both were reachable from an empty ledger. A workspace that had sent nothing
 * read "0% acceptance", which is indistinguishable from total failure, and one
 * accepted invite out of one read "100%", which is a claim about a population
 * of one. Every rate on the outreach screens goes through `ratePercent`, so
 * the rule is testable in one place instead of being re-remembered per tile.
 */
describe('ratePercent', () => {
  it('says so in words rather than dividing by an empty denominator', () => {
    expect(ratePercent(0, 0)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(0, 0)).not.toContain('%');
  });

  it('refuses a denominator too small to be a measurement', () => {
    // The exact shapes that used to render as 100% and 0%.
    expect(ratePercent(1, 1)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(3, 4)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(0, 9)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(0, RATE_MIN_SAMPLE - 1)).toBe(NOT_ENOUGH_DATA);
  });

  it('prints a rounded percentage once the sample is big enough', () => {
    expect(ratePercent(5, RATE_MIN_SAMPLE)).toBe('50%');
    expect(ratePercent(0, RATE_MIN_SAMPLE)).toBe('0%');
    expect(ratePercent(RATE_MIN_SAMPLE, RATE_MIN_SAMPLE)).toBe('100%');
    expect(ratePercent(1, 3000)).toBe('0%');
    expect(ratePercent(125, 1000)).toBe('13%');
  });

  it('takes a stricter floor when the caller has one, and never a floor below 1', () => {
    // The A/B panel will not compare two message versions under 20 sends.
    expect(ratePercent(6, 12, 20)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(6, 20, 20)).toBe('30%');
    // A caller asking for no floor at all still cannot divide by zero.
    expect(ratePercent(0, 0, 0)).toBe(NOT_ENOUGH_DATA);
    expect(ratePercent(1, 1, 1)).toBe('100%');
  });

  it('treats a missing count as no data, not as zero percent', () => {
    expect(ratePercent(0, Number.NaN)).toBe(NOT_ENOUGH_DATA);
  });
});
