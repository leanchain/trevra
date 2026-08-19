import { describe, expect, it } from 'vitest';
import type { FeedThread } from '../api';
import { ageLabel, factsLine, whyChips } from './researchFormat';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function entry(overrides: Partial<FeedThread> = {}): FeedThread {
  return {
    row: {
      id: 'ot_1',
      platform: 'hackernews',
      external_id: '48457585',
      url: 'https://news.ycombinator.com/item?id=48457585',
      title: 'Ask HN: What works for cutting AI token costs?',
      content: 'My LLM token bill is getting painful.',
      author: 'leoncos',
      community: null,
      score: 5,
      num_comments: 2,
      thread_created_at: '2026-08-17T12:00:00.000Z',
      first_seen_at: '2026-08-19T09:00:00.000Z',
      metadata_json: { tags: ['story', 'ask_hn'] }
    },
    relevance: {
      score: 7.4,
      components: [
        { label: 'high-value keywords (2)', points: 4 },
        { label: 'labelled question', points: 0.5 }
      ],
      highValueMatches: ['token cost', 'api cost'],
      negativeMatches: []
    },
    topics: ['token_cost'],
    angle: 'cost_comparison',
    guard: { allowed: true, reason: null, failedChecks: [] },
    ...overrides
  };
}

describe('ageLabel', () => {
  it("measures from the thread's own timestamp", () => {
    expect(ageLabel(entry(), NOW)).toBe('2d old');
  });

  it('says so when only the discovery time is known', () => {
    const row = { ...entry().row, thread_created_at: null };
    expect(ageLabel(entry({ row }), NOW)).toBe('first seen 3h ago');
  });
});

describe('whyChips', () => {
  it("renders the scorer's own components", () => {
    expect(whyChips(entry())).toEqual(['high-value keywords (2)', 'labelled question']);
  });

  it('surfaces a negative match rather than hiding it', () => {
    const chips = whyChips(
      entry({
        relevance: { ...entry().relevance, negativeMatches: ['stop spamming'] }
      })
    );
    expect(chips).toContain('negative: stop spamming');
  });
});

describe('factsLine', () => {
  it('labels the platform number points, never score', () => {
    expect(factsLine(entry(), NOW)).toBe('Hacker News · 2 comments · 5 points · 2d old');
  });
});
