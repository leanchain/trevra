import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createWatch } from '../watch/store.js';
import { compileBrandWatchMarketPulse, materializeBrandWatchMarketPulse } from './watch-pulse.js';

let db: Db;
const WORKSPACE = 'ws_watch_pulse';
const OTHER = 'ws_watch_pulse_other';
const NOW = new Date('2026-09-12T12:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
});

async function mention(
  workspaceId: string,
  watchId: string,
  input: {
    id: string;
    platform: string;
    url: string;
    sentiment?: 'positive' | 'neutral' | 'negative';
    keywords?: string[];
    at: string;
    content?: string;
    author?: string;
  }
): Promise<void> {
  const sentiment = input.sentiment ?? 'neutral';
  const score = sentiment === 'positive' ? 0.7 : sentiment === 'negative' ? -0.7 : 0;
  await db
    .prepare(
      `INSERT INTO brand_watch_mentions
       (id,workspace_id,watch_id,platform,external_id,url,title,content,author,community,score,num_comments,
        matched_keywords,sentiment_label,sentiment_score,sentiment_span,sentiment_version,content_hash,
        metadata_json,mention_created_at,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,1,?,'{}'::jsonb,?,?,?)`
    )
    .run(
      input.id,
      workspaceId,
      watchId,
      input.platform,
      `external-${input.id}`,
      input.url,
      `${input.id} title`,
      input.content ?? `${input.id} discussed the market.`,
      input.author ?? null,
      null,
      input.keywords ?? ['beseam'],
      sentiment,
      score,
      input.content ?? `${input.id} discussed the market.`,
      `hash-${input.id}`,
      input.at,
      input.at,
      input.at
    );
}

describe('brand-watch market pulse', () => {
  it('summarizes independent mentions with sentiment/keywords and keeps tenants isolated', async () => {
    const watch = await createWatch(
      db,
      WORKSPACE,
      {
        name: 'Beseam',
        keywords: ['beseam'],
        platforms: ['hackernews', 'reddit'],
        cadence: 'daily'
      },
      NOW
    );
    const foreign = await createWatch(
      db,
      OTHER,
      { name: 'Foreign', keywords: ['foreign'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    await mention(WORKSPACE, watch.id, {
      id: 'mention_one',
      platform: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=1',
      sentiment: 'positive',
      keywords: ['beseam', 'ai shopping'],
      at: '2026-09-11T10:00:00.000Z',
      author: 'alice'
    });
    await mention(WORKSPACE, watch.id, {
      id: 'mention_two',
      platform: 'reddit',
      url: 'https://www.reddit.com/r/ecommerce/comments/2',
      sentiment: 'negative',
      keywords: ['beseam'],
      at: '2026-09-12T10:00:00.000Z',
      author: 'bob'
    });
    await mention(OTHER, foreign.id, {
      id: 'foreign_mention',
      platform: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=foreign',
      at: '2026-09-12T11:00:00.000Z'
    });

    const pulse = await compileBrandWatchMarketPulse(db, WORKSPACE, watch.id, { days: 7 }, NOW);
    expect(pulse).toMatchObject({
      scope: { type: 'brand_watch', watchId: watch.id, watchName: 'Beseam' },
      mentionCount: 2,
      sourceCount: 2,
      platformCount: 2,
      sentiment: { positive: 1, neutral: 0, negative: 1 },
      canDraft: true
    });
    expect(pulse.topKeywords[0]).toEqual({ keyword: 'beseam', mentionCount: 2 });
    expect(JSON.stringify(pulse)).not.toContain('foreign');
  });

  it('refuses one source and materializes two independent mentions into a watch_trend story', async () => {
    const watch = await createWatch(
      db,
      WORKSPACE,
      { name: 'LemonCrow', keywords: ['lemoncrow'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    await mention(WORKSPACE, watch.id, {
      id: 'single',
      platform: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=single',
      at: '2026-09-11T10:00:00.000Z'
    });
    const single = await materializeBrandWatchMarketPulse(
      db,
      WORKSPACE,
      watch.id,
      { days: 7 },
      NOW
    );
    expect(single.opportunity).toBeNull();
    expect(single.pulse.canDraft).toBe(false);

    await mention(WORKSPACE, watch.id, {
      id: 'second',
      platform: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=second',
      sentiment: 'positive',
      at: '2026-09-12T10:00:00.000Z'
    });
    const ready = await materializeBrandWatchMarketPulse(db, WORKSPACE, watch.id, { days: 7 }, NOW);
    expect(ready.opportunity).toMatchObject({
      kind: 'watch_trend',
      status: 'ready',
      title: 'Weekly watch pulse · LemonCrow'
    });
    expect(ready.opportunity?.evidence).toHaveLength(2);
    expect(
      ready.opportunity?.evidence.every((row) => row.sourceType === 'brand_watch_mention')
    ).toBe(true);
    expect(new Set(ready.opportunity?.evidence.map((row) => row.sourceUrl)).size).toBe(2);
  });

  it('cannot read a watch from another workspace', async () => {
    const watch = await createWatch(
      db,
      OTHER,
      { name: 'Foreign', keywords: ['foreign'], platforms: ['reddit'], cadence: 'daily' },
      NOW
    );
    await expect(
      compileBrandWatchMarketPulse(db, WORKSPACE, watch.id, { days: 7 }, NOW)
    ).rejects.toMatchObject({ status: 404 });
  });
});
