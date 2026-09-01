import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import type { SkillContext } from '../skills/types.js';
import { createWatch, listWatchMentions } from './store.js';
import { watchMentions, watchMentionsSkill } from './skill.js';

let db: Db;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const noCredentials: CredentialAccessor = { get: () => undefined };

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await resetDemoData(db);
});

afterEach(async () => {
  await db?.close();
});

function ctx(): SkillContext {
  return { db, workspaceId: DEMO_WORKSPACE_ID, now: () => NOW };
}

const HN_HIT = {
  hits: [
    {
      objectID: '1',
      title: 'Trevra review',
      story_text: 'Trevra is excellent and saved us hours.',
      author: 'dev',
      points: 20,
      num_comments: 4,
      created_at_i: 1_756_713_600
    }
  ]
};

function jsonFetch(routes: Record<string, unknown>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (input) => {
      calls.push(input);
      const match = Object.keys(routes).find((key) => input.includes(key));
      if (!match) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[match]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
}

describe('gtm.watch-mentions', () => {
  it('is registered under its manifest id', async () => {
    const { getSkill } = await import('../skills/registry.js');
    expect(getSkill('gtm.watch-mentions')).toBeDefined();
    expect(watchMentionsSkill.manifest.sideEffect).toBe('network-read');
    expect(watchMentionsSkill.manifest.requiresApproval).toBe(false);
  });

  it('records a scored mention against the named watch', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });

    expect(result.watchId).toBe(watch.id);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].sentiment.label).toBe('positive');
    expect(result.mentions[0].matchedKeywords).toEqual(['trevra']);
    expect(result.summary.positive).toBe(1);

    const stored = await listWatchMentions(db, DEMO_WORKSPACE_ID, watch.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].sentimentSpan).not.toBe('');
  });

  it('searches sitewide rather than the scout’s default communities', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['github'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl, calls } = jsonFetch({ 'api.github.com': { items: [] } });
    await watchMentions({ watchId: watch.id }, ctx(), { credentials: noCredentials, fetchImpl });
    expect(decodeURIComponent(calls[0])).not.toContain('repo:');
  });

  it('reports a credential-gated platform instead of returning silently empty', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      { name: 'Trevra', keywords: ['trevra'], platforms: ['reddit'], cadence: 'daily' },
      NOW
    );
    const { fetchImpl } = jsonFetch({});
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.reports[0].availability.mode).toBe('needs-credential');
    expect(result.warnings.join(' ')).toContain('needs-credential');
  });

  it('keeps one platform’s failure from discarding another’s results', async () => {
    const watch = await createWatch(
      db,
      DEMO_WORKSPACE_ID,
      {
        name: 'Trevra',
        keywords: ['trevra'],
        platforms: ['github', 'hackernews'],
        cadence: 'daily'
      },
      NOW
    );
    const fetchImpl: FetchLike = async (input) => {
      if (input.includes('api.github.com')) throw new Error('rate limited');
      return new Response(JSON.stringify(HN_HIT), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const result = await watchMentions({ watchId: watch.id }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.mentions).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('rate limited');
  });

  it('rejects an unknown watch id', async () => {
    await expect(watchMentions({ watchId: 'bw_missing' }, ctx())).rejects.toThrow(/watch/i);
  });

  it('runs ad hoc from keywords with no watch row', async () => {
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions({ keywords: ['trevra'], platforms: ['hackernews'] }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.watchId).toBeNull();
    expect(result.mentions).toHaveLength(1);
  });
});
