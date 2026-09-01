import { describe, expect, it } from 'vitest';
import { SENTIMENT_VERSION, scoreSentiment } from './sentiment.js';

describe('scoreSentiment', () => {
  it('labels a plainly positive sentence positive', () => {
    const result = scoreSentiment('Trevra is excellent and it saved us hours.');
    expect(result.label).toBe('positive');
    expect(result.score).toBeGreaterThan(0);
  });

  it('labels a plainly negative sentence negative', () => {
    const result = scoreSentiment('The onboarding was terrible and it broke twice.');
    expect(result.label).toBe('negative');
    expect(result.score).toBeLessThan(0);
  });

  it('treats a sentence with no lexicon hits as neutral', () => {
    const result = scoreSentiment('We deployed it on Tuesday.');
    expect(result).toEqual({ label: 'neutral', score: 0, span: '', matches: [] });
  });

  it('treats an empty body as neutral', () => {
    expect(scoreSentiment('').label).toBe('neutral');
    expect(scoreSentiment('   ').score).toBe(0);
  });

  it('flips a positive term inside a negation window', () => {
    expect(scoreSentiment('This is not great.').label).toBe('negative');
  });

  it('does not label a negated negative term negative', () => {
    expect(scoreSentiment('Honestly not bad at all.').label).not.toBe('negative');
  });

  it('scales magnitude with an intensifier without changing the label', () => {
    const plain = scoreSentiment('The docs are good.');
    const loud = scoreSentiment('The docs are very good.');
    expect(loud.label).toBe(plain.label);
    expect(Math.abs(loud.score)).toBeGreaterThan(Math.abs(plain.score));
  });

  it('returns the deciding sentence as the span, not the whole body', () => {
    const result = scoreSentiment('We shipped on Tuesday. The billing page is terrible. Anyway.');
    expect(result.span).toBe('The billing page is terrible.');
  });

  it('keeps score inside the numeric(4,3) domain at 3dp', () => {
    const result = scoreSentiment(
      'excellent excellent excellent amazing amazing brilliant brilliant love love love'
    );
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(result.score).toBe(Number(result.score.toFixed(3)));
  });

  it('exposes a version so a stale label can be identified later', () => {
    expect(SENTIMENT_VERSION).toBe(1);
  });
});
