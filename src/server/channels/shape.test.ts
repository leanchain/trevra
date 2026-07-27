import { describe, expect, it } from 'vitest';
import { ELLIPSIS, capChars, capTags, containsUrl, shapePost, stripUrls } from './shape.js';

describe('capChars', () => {
  it('leaves text that already fits untouched', () => {
    expect(capChars('short enough', 50)).toEqual({ text: 'short enough', truncated: false });
  });

  it('cuts at a word boundary and marks the cut', () => {
    const result = capChars('one two three four five', 12);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`one two${ELLIPSIS}`);
    expect(result.text.length).toBeLessThanOrEqual(12);
  });

  it('never returns more than maxChars, ellipsis included', () => {
    const body = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    for (let limit = 1; limit <= body.length + 2; limit += 1) {
      expect(capChars(body, limit).text.length).toBeLessThanOrEqual(limit);
    }
  });

  it('cuts mid-word when the first word alone blows the budget', () => {
    const result = capChars('supercalifragilistic expialidocious', 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`supercali${ELLIPSIS}`);
  });

  it('preserves paragraph breaks inside the kept text', () => {
    const result = capChars('first line\n\nsecond line\n\nthird line', 25);
    expect(result.text).toBe(`first line\n\nsecond line${ELLIPSIS}`);
  });

  it('drops trailing punctuation left dangling by the cut, like capWords does', () => {
    expect(capChars('alpha bravo, charlie', 15).text).toBe(`alpha bravo${ELLIPSIS}`);
  });
});

describe('stripUrls', () => {
  it('removes every http(s) URL and collapses the gap', () => {
    const result = stripUrls('Grab it at https://trevra.dev now, or http://example.com later.');
    expect(result.removed).toEqual(['https://trevra.dev', 'http://example.com']);
    expect(result.text).not.toContain('http');
    expect(result.text).toBe('Grab it at now, or later.');
  });

  it('reports nothing when there is no URL', () => {
    expect(stripUrls('no links here')).toEqual({ text: 'no links here', removed: [] });
  });
});

describe('containsUrl', () => {
  it('detects a URL already present in the body', () => {
    expect(containsUrl('see https://trevra.dev for more', 'https://trevra.dev')).toBe(true);
    expect(containsUrl('nothing here', 'https://trevra.dev')).toBe(false);
  });
});

describe('capTags', () => {
  it('normalises, de-duplicates, and drops blanks', () => {
    expect(capTags(['#Launch', 'launch', '  Open-Source ', ''])).toEqual({
      tags: ['launch', 'open-source'],
      dropped: []
    });
  });

  it('keeps everything when the platform sets no cap', () => {
    const tags = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
    expect(capTags(tags).tags).toEqual(tags);
  });

  it('caps at the platform limit and reports what it dropped', () => {
    expect(capTags(['one', 'two', 'three', 'four'], 2)).toEqual({ tags: ['one', 'two'], dropped: ['three', 'four'] });
  });
});

describe('shapePost', () => {
  const constraints = { maxChars: 100, maxTitleChars: 20, linksAllowed: true, maxTags: 2 };

  it('budgets the URL before truncating, so the link survives the cut', () => {
    const body = 'word '.repeat(60).trim();
    const post = shapePost({
      channelKey: 'test',
      constraints,
      draft: { title: 'Trevra', body, url: 'https://trevra.dev' },
      submitUrl: 'https://example.com/submit'
    });
    expect(post.body.endsWith('\n\nhttps://trevra.dev')).toBe(true);
    expect(post.body.length).toBeLessThanOrEqual(constraints.maxChars);
    expect(post.submitUrl).toBe('https://example.com/submit');
  });

  it('does not append a URL the body already carries', () => {
    const post = shapePost({
      channelKey: 'test',
      constraints,
      draft: { title: 'Trevra', body: 'Out now at https://trevra.dev today.', url: 'https://trevra.dev' }
    });
    expect(post.body.match(/https:\/\/trevra\.dev/g)).toHaveLength(1);
  });

  it('warns and drops the title when the channel has no title field', () => {
    const post = shapePost({
      channelKey: 'test',
      constraints: { maxChars: 100, linksAllowed: true },
      draft: { title: 'Trevra 0.4', body: 'Out now.' }
    });
    expect(post.title).toBeUndefined();
    expect(post.warnings.some((warning) => warning.includes('no title field'))).toBe(true);
  });

  it('warns about the reach penalty only when a link is actually present', () => {
    const penalised = { maxChars: 100, linksAllowed: true, linkPenalty: true };
    const withLink = shapePost({
      channelKey: 'test',
      constraints: penalised,
      draft: { title: '', body: 'Out now.', url: 'https://trevra.dev' }
    });
    const withoutLink = shapePost({
      channelKey: 'test',
      constraints: penalised,
      draft: { title: '', body: 'Out now.' }
    });
    expect(withLink.warnings.some((warning) => warning.includes('suppresses reach'))).toBe(true);
    expect(withoutLink.warnings.some((warning) => warning.includes('suppresses reach'))).toBe(false);
  });

  it('is pure: the same draft always shapes to the same post', () => {
    const draft = { title: 'Trevra 0.4 ships channel adapters', body: 'word '.repeat(40).trim(), url: 'https://trevra.dev', tags: ['a', 'b', 'c'] };
    const once = shapePost({ channelKey: 'test', constraints, draft });
    const twice = shapePost({ channelKey: 'test', constraints, draft });
    expect(twice).toEqual(once);
  });
});
