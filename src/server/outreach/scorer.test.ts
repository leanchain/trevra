import { describe, expect, it } from 'vitest';
import { extractTopics, rankThreads, scoreThread, suggestAngle } from './scorer.js';
import type { OutreachThread } from './types.js';

// Every assertion here runs against hand-written threads and a frozen clock.
// The reference read datetime.now(UTC) inside score(), which made the freshness
// bonus -- and therefore every score -- untestable.
const NOW = new Date('2026-08-03T12:00:00.000Z');

function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
  return {
    platform: 'hackernews',
    externalId: '1',
    url: 'https://news.ycombinator.com/item?id=1',
    title: '',
    content: '',
    author: 'someone',
    community: null,
    score: 0,
    numComments: 0,
    createdAt: null,
    metadata: {},
    ...overrides
  };
}

describe('scoreThread keywords', () => {
  it('awards 2 points per high-value keyword', () => {
    const one = scoreThread(thread({ title: 'token cost is killing me' }), NOW);
    expect(one.score).toBe(2);
    expect(one.highValueMatches).toEqual(['token cost']);

    const two = scoreThread(thread({ title: 'token cost and api cost' }), NOW);
    expect(two.score).toBe(4);
  });

  it('caps high-value keywords at 6 points', () => {
    // Five matches would be 10 points uncapped.
    const capped = scoreThread(
      thread({ title: 'token cost api cost expensive burn rate cost per task' }),
      NOW
    );
    expect(capped.highValueMatches).toHaveLength(5);
    expect(capped.score).toBe(6);
  });

  it('awards 1 point per medium keyword, capped at 3', () => {
    const capped = scoreThread(thread({ title: 'claude code copilot cursor aider' }), NOW);
    expect(capped.mediumMatches).toHaveLength(4);
    expect(capped.score).toBe(3);
  });

  it('subtracts 3 per negative keyword, and one is enough to sink a strong thread', () => {
    const strong = thread({ title: 'token cost api cost expensive', content: 'claude code cursor' });
    expect(scoreThread(strong, NOW).score).toBe(8);

    const rejected = { ...strong, content: `${strong.content} stop spamming` };
    // 6 + 2 - 3 = 5
    expect(scoreThread(rejected, NOW).score).toBe(5);

    const doubleRejected = { ...strong, content: 'stop spamming and not interested' };
    // 6 + 0 - 6 = 0
    expect(scoreThread(doubleRejected, NOW).score).toBe(0);
  });

  it('matches keywords case-insensitively across title and content together', () => {
    const split = thread({ title: 'TOKEN COST', content: 'Claude Code' });
    expect(scoreThread(split, NOW).score).toBe(3);
  });
});

describe('scoreThread engagement and freshness', () => {
  it('scores engagement in bands, not linearly', () => {
    expect(scoreThread(thread({ score: 11 }), NOW).score).toBe(1);
    expect(scoreThread(thread({ score: 6 }), NOW).score).toBe(0.5);
    expect(scoreThread(thread({ score: 5 }), NOW).score).toBe(0);

    expect(scoreThread(thread({ numComments: 6 }), NOW).score).toBe(0.5);
    expect(scoreThread(thread({ numComments: 3 }), NOW).score).toBe(0.25);
    expect(scoreThread(thread({ numComments: 2 }), NOW).score).toBe(0);
  });

  it('decays the freshness bonus across 24h, 72h, and a week', () => {
    const at = (hoursAgo: number) =>
      scoreThread(thread({ createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() }), NOW).score;
    expect(at(1)).toBe(1);
    expect(at(48)).toBe(0.5);
    expect(at(100)).toBe(0.25);
    expect(at(200)).toBe(0);
  });

  it('awards no freshness bonus when the platform reported no timestamp', () => {
    expect(scoreThread(thread({ createdAt: null }), NOW).score).toBe(0);
  });
});

describe('scoreThread platform signals', () => {
  it('rewards a high upvote ratio on Reddit only', () => {
    const base = { platform: 'reddit', community: 'webdev', metadata: { upvoteRatio: 0.95 } };
    expect(scoreThread(thread(base), NOW).score).toBe(0.5);
    // The same metadata on another platform is not a Reddit signal.
    expect(scoreThread(thread({ ...base, platform: 'lobsters' }), NOW).score).toBe(0);
  });

  it('rewards Ask HN threads, which are asking for exactly this kind of answer', () => {
    const ask = thread({ platform: 'hackernews', metadata: { tags: ['ask_hn', 'story'] } });
    expect(scoreThread(ask, NOW).score).toBe(1);

    const big = thread({ platform: 'hackernews', score: 60, metadata: { tags: ['ask_hn'] } });
    // 1 (score > 10) + 0.5 (score > 50) + 1 (ask_hn)
    expect(scoreThread(big, NOW).score).toBe(2.5);
  });

  it('rewards GitHub issues from insiders and questions', () => {
    const issue = thread({
      platform: 'github',
      community: 'anthropics/claude-code',
      metadata: { authorAssociation: 'MEMBER', labels: ['Question', 'bug'] }
    });
    expect(scoreThread(issue, NOW).score).toBe(1);

    const outsider = thread({ platform: 'github', metadata: { authorAssociation: 'NONE', labels: ['bug'] } });
    expect(scoreThread(outsider, NOW).score).toBe(0);
  });
});

describe('scoreThread clamping', () => {
  it('never exceeds 10 however many signals stack', () => {
    const perfect = thread({
      platform: 'hackernews',
      title: 'token cost api cost expensive burn rate',
      content: 'claude code cursor copilot context window',
      score: 500,
      numComments: 200,
      createdAt: NOW.toISOString(),
      metadata: { tags: ['ask_hn'] }
    });
    // 6 + 3 + 1 + 0.5 + 1 + 0.5 + 1 = 13, clamped.
    expect(scoreThread(perfect, NOW).score).toBe(10);
  });

  it('never drops below 0 however many negatives stack', () => {
    const awful = thread({ content: 'stop spamming not interested already know' });
    expect(scoreThread(awful, NOW).score).toBe(0);
  });

  it('itemises every contribution so a score can be explained', () => {
    const breakdown = scoreThread(thread({ title: 'token cost', score: 11 }), NOW);
    expect(breakdown.components).toEqual([
      { label: 'high-value keywords (1)', points: 2 },
      { label: 'thread score > 10', points: 1 }
    ]);
    expect(breakdown.components.reduce((total, part) => total + part.points, 0)).toBe(breakdown.score);
  });
});

describe('extractTopics and suggestAngle', () => {
  it('names the topics a thread actually raises', () => {
    expect(extractTopics(thread({ title: 'api cost of my coding agent' }))).toEqual(['token_cost', 'coding_agent']);
    expect(extractTopics(thread({ title: 'weather today' }))).toEqual([]);
  });

  it('gives busy threads the substantive answer and quiet ones a one-liner', () => {
    expect(suggestAngle(thread({ score: 21 }), [])).toBe('technical_deepdive');
    expect(suggestAngle(thread({ numComments: 11 }), [])).toBe('technical_deepdive');
    expect(suggestAngle(thread({ score: 6 }), [])).toBe('cost_comparison');
    expect(suggestAngle(thread({ score: 1 }), ['alternative'])).toBe('alternative_suggestion');
    expect(suggestAngle(thread({ score: 1 }), [])).toBe('minimal_mention');
  });
});

describe('rankThreads', () => {
  it('ranks best-first and marks which clear the reply floor', () => {
    const threads = [
      thread({ externalId: 'weak', title: 'hello world' }),
      thread({ externalId: 'strong', title: 'token cost api cost expensive', content: 'claude code' }),
      thread({ externalId: 'middling', title: 'token cost' })
    ];
    const ranked = rankThreads(threads, NOW, 5);
    expect(ranked.map((entry) => entry.thread.externalId)).toEqual(['strong', 'middling', 'weak']);
    expect(ranked.map((entry) => entry.shouldReply)).toEqual([true, false, false]);
  });

  it('is stable: equal scores keep their input order', () => {
    const threads = [thread({ externalId: 'a' }), thread({ externalId: 'b' }), thread({ externalId: 'c' })];
    expect(rankThreads(threads, NOW).map((entry) => entry.thread.externalId)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic: the same input ranks identically every time', () => {
    const threads = [thread({ externalId: 'a', title: 'token cost' }), thread({ externalId: 'b', score: 40 })];
    expect(rankThreads(threads, NOW)).toEqual(rankThreads(threads, NOW));
  });
});
