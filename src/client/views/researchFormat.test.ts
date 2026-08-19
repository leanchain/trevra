import { describe, expect, it } from 'vitest';
import type { FeedThread } from '../api';
import { ageLabel, chipPoints, factsLine, whyChips } from './researchFormat';

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
      mediumMatches: [],
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

  it('never reads "24h" -- 23.5h rounds into the day unit, not past the hour cap', () => {
    const row = { ...entry().row, thread_created_at: '2026-08-18T12:30:00.000Z' };
    const label = ageLabel(entry({ row }), NOW);
    expect(label).not.toContain('24h');
    expect(label).toBe('1d old');
  });

  it('never reads "24h" -- exactly 24h is a day', () => {
    const row = { ...entry().row, thread_created_at: '2026-08-18T12:00:00.000Z' };
    const label = ageLabel(entry({ row }), NOW);
    expect(label).not.toContain('24h');
    expect(label).toBe('1d old');
  });

  it('never reads "24h" -- 36h is a day and a half, rounded', () => {
    const row = { ...entry().row, thread_created_at: '2026-08-18T00:00:00.000Z' };
    const label = ageLabel(entry({ row }), NOW);
    expect(label).not.toContain('24h');
    expect(label).toBe('2d old');
  });
});

describe('whyChips', () => {
  it('names the keywords that matched instead of counting them', () => {
    expect(whyChips(entry())).toEqual([
      { label: '"token cost", "api cost"', points: 4, tone: 'positive' },
      { label: 'labelled a question', points: 0.5, tone: 'positive' }
    ]);
  });

  it("never calls the platform's vote count a score", () => {
    const chips = whyChips(
      entry({
        relevance: {
          ...entry().relevance,
          components: [
            { label: 'thread score > 10', points: 1 },
            { label: 'more than 5 comments', points: 0.5 },
            { label: 'less than 24h old', points: 1 }
          ]
        }
      })
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      '10+ points',
      '5+ comments',
      'posted in the last 24h'
    ]);
  });

  it('surfaces a negative match, named, as a negative chip', () => {
    const chips = whyChips(
      entry({
        relevance: {
          ...entry().relevance,
          components: [{ label: 'negative keywords (1)', points: -3 }],
          negativeMatches: ['stop spamming']
        }
      })
    );
    expect(chips).toEqual([{ label: 'avoid: "stop spamming"', points: -3, tone: 'negative' }]);
  });

  it('passes an unmapped label through rather than dropping the reason', () => {
    const chips = whyChips(
      entry({
        relevance: {
          ...entry().relevance,
          components: [{ label: 'some future rule', points: 0.25 }]
        }
      })
    );
    expect(chips).toEqual([{ label: 'some future rule', points: 0.25, tone: 'positive' }]);
  });

  it("renders a chip's worth with its sign", () => {
    expect(chipPoints({ label: 'x', points: 2, tone: 'positive' })).toBe('+2');
    expect(chipPoints({ label: 'x', points: -3, tone: 'negative' })).toBe('-3');
  });
});

describe('factsLine', () => {
  it('labels the platform number points, never score', () => {
    expect(factsLine(entry(), NOW)).toBe('Hacker News · 2 comments · 5 points · 2d old');
  });
});
