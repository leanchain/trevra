import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { getChannel, listChannels, listEnabled, registerChannel, seedChannels } from './registry.js';
import { devtoChannel } from './adapters/devto.js';
import { REDDIT_SUBREDDITS } from './adapters/reddit.js';
import type { ChannelAdapter } from './types.js';
import { shapePost } from './shape.js';

/** A channel added the way a fork would add one: one file, one register call. */
const forkedChannel: ChannelAdapter = {
  key: 'zzz-forked',
  name: 'Forked Channel',
  homeUrl: 'https://example.com',
  audience: ['developers'],
  formats: ['text'],
  constraints: { maxChars: 500, linksAllowed: true },
  automation: { mode: 'prepare-only', reason: 'Example platform publishes no write API of any kind, so a human posts it.' },
  enabledByDefault: false,
  adapt(draft) {
    return shapePost({ channelKey: this.key, constraints: this.constraints, draft, submitUrl: 'https://example.com/new' });
  }
};

describe('registerChannel', () => {
  it('accepts a new channel and hands it straight back', () => {
    expect(registerChannel(forkedChannel)).toBe(forkedChannel);
    expect(getChannel('zzz-forked')).toBe(forkedChannel);
  });

  it('is idempotent: first registration wins, repeat imports are a no-op', () => {
    const impostor: ChannelAdapter = { ...forkedChannel, name: 'Impostor' };
    expect(registerChannel(impostor)).toBe(forkedChannel);
    expect(getChannel('zzz-forked')!.name).toBe('Forked Channel');
  });

  it('returns undefined for a key nobody registered', () => {
    expect(getChannel('myspace')).toBeUndefined();
  });
});

describe('listChannels', () => {
  it('is sorted by key so listings are stable', () => {
    const keys = listChannels().map((channel) => channel.key);
    expect(keys).toEqual([...keys].sort());
  });

  it('exposes the whole registry, disabled channels included', () => {
    expect(listChannels().map((channel) => channel.key)).toContain('instagram');
  });
});

describe('listEnabled', () => {
  it('drops channels that ship off by default', () => {
    const enabled = listEnabled().map((channel) => channel.key);
    expect(enabled).not.toContain('instagram');
    expect(enabled).not.toContain('zzz-forked');
    expect(enabled).toContain('devto');
  });

  it('is a subset of listChannels', () => {
    const all = new Set(listChannels().map((channel) => channel.key));
    for (const channel of listEnabled()) expect(all.has(channel.key)).toBe(true);
  });
});

describe('seedChannels', () => {
  /** Captures the SQL and parameters without touching Postgres. */
  function recordingDb() {
    const statements: string[] = [];
    const rows: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          run: async (...params: unknown[]) => {
            rows.push(params);
            return { changes: 1 };
          }
        };
      }
    } as unknown as Db;
    return { db, statements, rows };
  }

  it('writes one row per registered channel', async () => {
    const { db, rows } = recordingDb();
    await seedChannels(db, new Date(0));
    expect(rows).toHaveLength(listChannels().length);
    expect(rows.map((row) => row[0])).toEqual(listChannels().map((channel) => channel.key));
  });

  it('seeds the code-owned columns from the adapter', async () => {
    const { db, rows } = recordingDb();
    await seedChannels(db, new Date(0));
    const devto = rows.find((row) => row[0] === 'devto')!;
    expect(devto.slice(0, 5)).toEqual([devtoChannel.key, devtoChannel.name, true, 'api-publish', '{}']);
    expect(devto[5]).toBe(new Date(0).toISOString());
  });

  it('seeds a channel that ships off as disabled', async () => {
    const { db, rows } = recordingDb();
    await seedChannels(db, new Date(0));
    expect(rows.find((row) => row[0] === 'instagram')![2]).toBe(false);
  });

  it("seeds reddit's subreddit list into config_json", async () => {
    const { db, rows } = recordingDb();
    await seedChannels(db, new Date(0));
    expect(JSON.parse(String(rows.find((row) => row[0] === 'reddit')![4]))).toEqual({
      subreddits: [...REDDIT_SUBREDDITS]
    });
  });

  it('never overwrites operator state on conflict', async () => {
    const { db, statements } = recordingDb();
    await seedChannels(db, new Date(0));
    const [sql] = statements;
    const update = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(update).toContain('name=excluded.name');
    expect(update).toContain('automation_mode=excluded.automation_mode');
    for (const operatorColumn of ['enabled=', 'config_json=', 'account_ref=', 'post_count=', 'last_post_at=']) {
      expect(update).not.toContain(operatorColumn);
    }
  });
});
