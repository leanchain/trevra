import { describe, expect, it } from 'vitest';
import { GLOBAL_TARGETS, POST_SENT, STATUS_LADDER, TERMINAL, allowedTransition, normalizeDomain } from './ladder.js';

// Ported from the pure parts of the Python reference src/growth/service.py.
describe('lead status ladder', () => {
  it('keeps the ladder and terminal sets intact', () => {
    expect(STATUS_LADDER).toEqual(['new', 'enriched', 'scored', 'audited', 'drafted', 'approved', 'sent']);
    expect([...POST_SENT].sort()).toEqual(['bounced', 'replied']);
    expect([...GLOBAL_TARGETS].sort()).toEqual(['dead', 'suppressed']);
    expect([...TERMINAL].sort()).toEqual(['bounced', 'dead', 'replied', 'suppressed']);
  });

  it('allows exactly one forward step on the ladder', () => {
    for (let index = 0; index < STATUS_LADDER.length - 1; index += 1) {
      expect(allowedTransition(STATUS_LADDER[index], STATUS_LADDER[index + 1])).toBe(true);
    }
  });

  it('refuses backwards moves and skipped steps', () => {
    expect(allowedTransition('scored', 'enriched')).toBe(false);
    expect(allowedTransition('new', 'scored')).toBe(false);
    expect(allowedTransition('new', 'sent')).toBe(false);
    expect(allowedTransition('new', 'new')).toBe(false);
  });

  it('always allows the global targets', () => {
    for (const status of [...STATUS_LADDER, 'replied', 'bounced', 'dead']) {
      expect(allowedTransition(status, 'dead')).toBe(true);
      expect(allowedTransition(status, 'suppressed')).toBe(true);
    }
  });

  it('allows sent -> replied / bounced only from sent', () => {
    expect(allowedTransition('sent', 'replied')).toBe(true);
    expect(allowedTransition('sent', 'bounced')).toBe(true);
    expect(allowedTransition('approved', 'replied')).toBe(false);
    expect(allowedTransition('drafted', 'bounced')).toBe(false);
  });

  it('rejects unknown statuses outright', () => {
    expect(allowedTransition('sent', 'archived')).toBe(false);
    expect(allowedTransition('nonsense', 'enriched')).toBe(false);
  });

  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.Example.com/path?x=1')).toBe('example.com');
    expect(normalizeDomain('http://shop.example.co.uk/collections/all')).toBe('shop.example.co.uk');
    expect(normalizeDomain('  WWW.Example.com.  ')).toBe('example.com');
    expect(normalizeDomain('example.com?utm=1')).toBe('example.com');
    expect(normalizeDomain('example.com/')).toBe('example.com');
    expect(normalizeDomain('example.com...')).toBe('example.com');
    expect(normalizeDomain('www.www.example.com')).toBe('www.example.com');
    expect(normalizeDomain(null)).toBe('');
    expect(normalizeDomain(undefined)).toBe('');
    expect(normalizeDomain('')).toBe('');
  });
});
