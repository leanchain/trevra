import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_CONFIG, pickWedge, scoreLead, type ScoreConfig } from './score.js';

// Ported from the Python reference tests/test_scoring.py.
describe('gtm.score-lead', () => {
  it('returns a stable structure and is deterministic', () => {
    const lead = { platform: 'shopify', catalogSize: 100, vertical: 'footwear' };
    const result = scoreLead(lead);
    expect(Object.keys(result.fits).sort()).toEqual(['sizing', 'tracker', 'visibility']);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(1);
    expect(result.overall).toBe(result.fits[result.wedge]);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(scoreLead(lead)).toEqual(result);
  });

  it('leans sizing for footwear on shopify', () => {
    const result = scoreLead({ platform: 'shopify', catalogSize: 0, vertical: 'footwear' });
    expect(result.wedge).toBe('sizing');
    expect(result.fits.sizing).toBeGreaterThan(result.fits.visibility);
  });

  it('gives the dance vertical the same sizing bonus', () => {
    const result = scoreLead({ platform: 'shopify', vertical: 'dance' });
    expect(result.fits.sizing).toBe(0.8); // base 0.2 + vertical 0.4 + shopify 0.2
  });

  it('accepts a bare lead with nothing known', () => {
    const result = scoreLead({ platform: '', vertical: '', catalogSize: null });
    expect(result.fits.visibility).toBe(0.3);
    expect(result.fits.sizing).toBe(0.2);
    expect(result.fits.tracker).toBe(0.25);
  });

  it('adds the contact-email bonus from a harvested address list', () => {
    const base = scoreLead({ platform: '', vertical: '', catalogSize: 0 });
    const withEmail = scoreLead({ platform: '', vertical: '', catalogSize: 0, emails: ['a@b.com'] });
    expect(withEmail.fits.sizing).toBe(Math.round((base.fits.sizing + 0.1) * 1000) / 1000);
    expect(withEmail.fits.visibility).toBe(Math.round((base.fits.visibility + 0.1) * 1000) / 1000);
    expect(withEmail.fits.tracker).toBe(Math.round((base.fits.tracker + 0.1) * 1000) / 1000);
  });

  it('applies the catalog thresholds at 20 and 50', () => {
    const small = scoreLead({ platform: 'shopify', catalogSize: 5 });
    const mid = scoreLead({ platform: 'shopify', catalogSize: 20 });
    const big = scoreLead({ platform: 'shopify', catalogSize: 50 });
    expect(mid.fits.sizing).toBe(Math.round((small.fits.sizing + 0.1) * 1000) / 1000);
    expect(mid.fits.visibility).toBe(Math.round((small.fits.visibility + 0.2) * 1000) / 1000);
    expect(big.fits.tracker).toBe(Math.round((mid.fits.tracker + 0.1) * 1000) / 1000);
  });

  it('breaks ties visibility > sizing > tracker', () => {
    expect(pickWedge({ visibility: 0.7, sizing: 0.7, tracker: 0.7 })).toBe('visibility');
    expect(pickWedge({ visibility: 0.6, sizing: 0.6, tracker: 0.1 })).toBe('visibility');
    expect(pickWedge({ visibility: 0.1, sizing: 0.6, tracker: 0.6 })).toBe('sizing');
  });

  it('picks the outright maximum when there is no tie', () => {
    expect(pickWedge({ visibility: 0.2, sizing: 0.9, tracker: 0.1 })).toBe('sizing');
    expect(pickWedge({ visibility: 0.1, sizing: 0.2, tracker: 0.95 })).toBe('tracker');
  });

  it('emits a human-readable reason for every contribution', () => {
    const result = scoreLead({ platform: 'shopify', vertical: 'footwear', catalogSize: 100, contactEmail: 'a@b.com' });
    expect(result.reasons).toEqual([
      'sizing: base 0.2',
      "sizing: +0.4 footwear/dance vertical ('footwear')",
      'sizing: +0.2 shopify platform',
      'sizing: +0.1 catalog>=20 (100)',
      'sizing: +0.1 has contact email',
      'visibility: base 0.3',
      'visibility: +0.3 shopify (feed-driven)',
      'visibility: +0.2 catalog>=20 (100)',
      'visibility: +0.1 has contact email',
      'tracker: base 0.25',
      'tracker: +0.25 shopify platform',
      'tracker: +0.1 catalog>=50 (100)',
      'tracker: +0.1 has contact email',
      'wedge: sizing (tie-break order visibility > sizing > tracker)'
    ]);
    expect(result.fits).toEqual({ sizing: 1, visibility: 0.9, tracker: 0.7 });
  });

  it('clamps fits into [0, 1]', () => {
    const config: ScoreConfig = {
      platform: 'shopify',
      verticals: ['footwear'],
      wedges: [
        { id: 'over', base: 0.9, rules: [{ signal: 'platform', weight: 0.9, label: 'shopify platform' }] },
        { id: 'under', base: -0.5, rules: [] }
      ],
      priority: ['over', 'under']
    };
    const result = scoreLead({ platform: 'shopify' }, config);
    expect(result.fits.over).toBe(1);
    expect(result.fits.under).toBe(0);
  });

  it('supports workspace-configured wedges while keeping the tie-break semantics', () => {
    const config: ScoreConfig = {
      platform: 'woocommerce',
      verticals: ['b2b'],
      wedges: [
        { id: 'onboarding', base: 0.4, rules: [{ signal: 'vertical', weight: 0.2, label: 'b2b vertical ({value})' }] },
        { id: 'billing', base: 0.6, rules: [] }
      ],
      // billing outranks onboarding on ties even though onboarding is listed first.
      priority: ['billing', 'onboarding']
    };
    const tied = scoreLead({ platform: 'woocommerce', vertical: 'b2b' }, config);
    expect(tied.fits).toEqual({ onboarding: 0.6, billing: 0.6 });
    expect(tied.wedge).toBe('billing');
    expect(tied.reasons).toContain("onboarding: +0.2 b2b vertical ('b2b')");
    expect(tied.reasons.at(-1)).toBe('wedge: billing (tie-break order billing > onboarding)');
  });

  it('keeps the reference wedge order locked', () => {
    expect(DEFAULT_SCORE_CONFIG.priority).toEqual(['visibility', 'sizing', 'tracker']);
  });
});
