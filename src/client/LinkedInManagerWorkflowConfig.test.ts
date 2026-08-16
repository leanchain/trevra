import { describe, expect, it } from 'vitest';

// The builder is a browser module, and its import graph reaches `auth-client.ts`
// which reads `window.location.origin` at module scope. Nothing under test here
// touches the DOM -- these are the two pure helpers behind the weight editor --
// so a two-field stub set before the dynamic import is the whole ceremony, and
// it keeps the suite off a DOM environment it otherwise does not need.
(globalThis as { window?: unknown }).window ??= { location: { origin: 'http://localhost' } };
const { nextVariantId, renormaliseWeights } = await import('./LinkedInManagerWorkflowConfig');

/**
 * The two pure parts of the A/B weight editor.
 *
 * The builder mirrors `workflowStepsSchema`, and the schema now takes four
 * message versions instead of two. The card therefore has to survive an arm
 * being added and removed at any position and still describe the split the
 * server will actually run -- which is normalised by the arms' own total, not
 * by whatever numbers happen to be in the boxes.
 */
describe('A/B weight renormalisation', () => {
  const sum = (weights: readonly number[]) => weights.reduce((total, weight) => total + weight, 0);

  it('always returns whole weights that sum to 100, with every arm above zero', () => {
    for (const weights of [[50], [50, 50], [50, 50, 50], [50, 50, 50, 50], [70, 30, 50], [1, 1, 1, 100], [100, 1], [3, 3, 3, 3]]) {
      const out = renormaliseWeights(weights);
      expect(out).toHaveLength(weights.length);
      expect(sum(out)).toBe(100);
      for (const weight of out) {
        expect(Number.isInteger(weight)).toBe(true);
        expect(weight).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('splits an even four-way test evenly', () => {
    expect(renormaliseWeights([50, 50, 50, 50])).toEqual([25, 25, 25, 25]);
    expect(renormaliseWeights([25, 25, 25, 25])).toEqual([25, 25, 25, 25]);
  });

  // Adding a third arm to 50/50 used to leave the card claiming 50%, 50% and
  // 50% of leads while the server sent thirds.
  it('renormalises when an arm is added, and again when one is removed', () => {
    const added = renormaliseWeights([50, 50, 50]);
    expect(sum(added)).toBe(100);
    expect(Math.max(...added) - Math.min(...added)).toBeLessThanOrEqual(1);

    // Three arms cannot be integers and exactly equal, so 34/33/33 is as even
    // as it gets; dropping the middle one carries that 34:33 forward as 51/49
    // rather than snapping back to 50/50, because renormalising preserves what
    // is there rather than inventing a fresh split.
    const removed = renormaliseWeights([added[0], added[2]]);
    expect(sum(removed)).toBe(100);
    expect(Math.max(...removed) - Math.min(...removed)).toBeLessThanOrEqual(2);
    expect(renormaliseWeights([25, 25, 25])).toEqual([34, 33, 33]);
  });

  // A 70/30 split is a RATIO. Adding an arm must not flatten it to thirds.
  it('keeps the operator’s ratio when an arm joins or leaves', () => {
    const three = renormaliseWeights([70, 30, 50]);
    expect(sum(three)).toBe(100);
    expect(three[0]).toBeGreaterThan(three[2]);
    expect(three[2]).toBeGreaterThan(three[1]);

    const back = renormaliseWeights([three[0], three[1]]);
    expect(sum(back)).toBe(100);
    expect(back[0] / back[1]).toBeGreaterThan(2);
    expect(back[0] / back[1]).toBeLessThan(2.8);
  });

  it('takes a dirty weight without producing a zero or a fraction', () => {
    const out = renormaliseWeights([0, -4, Number.NaN, 12]);
    expect(sum(out)).toBe(100);
    expect(out.every((weight) => Number.isInteger(weight) && weight >= 1)).toBe(true);
    expect(renormaliseWeights([])).toEqual([]);
  });
});

describe('A/B variant ids', () => {
  it('mints the next free letter and stops at the fourth', () => {
    expect(nextVariantId([])).toBe('a');
    expect(nextVariantId(['a'])).toBe('b');
    expect(nextVariantId(['a', 'b'])).toBe('c');
    expect(nextVariantId(['a', 'b', 'c'])).toBe('d');
    expect(nextVariantId(['a', 'b', 'c', 'd'])).toBeNull();
  });

  // Removing the middle arm reuses the hole rather than skipping to the next
  // letter, so an id never collides with one already on the card -- the schema
  // rejects duplicate variant ids outright.
  it('reuses a freed letter and never repeats one already taken', () => {
    expect(nextVariantId(['a', 'c', 'd'])).toBe('b');
    expect(nextVariantId(['B', 'A'])).toBe('c');
  });
});
