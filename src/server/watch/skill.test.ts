import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_WORKSPACE_ID, openDatabase, resetDemoData, type Db } from '../db.js';
import type { CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import type { SkillContext } from '../skills/types.js';
import { githubScout } from '../outreach/scouts/github.js';
import { devtoScout } from '../outreach/scouts/devto.js';
import { createWatch, listWatchMentions } from './store.js';
import { watchMentions, watchMentionsSkill, type WatchMentionsResult } from './skill.js';

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

/**
 * Assert `result` satisfies the skill's own published `outputSchema` -- the
 * same check `runSkill` applies via `outputSchema.safeParse` in
 * `skills/runner.ts:88`. On failure the message names the offending field(s)
 * instead of just reporting `false`.
 */
function expectValidOutput(result: WatchMentionsResult): void {
  const parsed = watchMentionsSkill.manifest.outputSchema.safeParse(result);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    expect.fail(`outputSchema rejected the result: ${issues}`);
  }
  expect(parsed.success).toBe(true);
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

  // Coverage gaps closed after review (task-5 follow-up): the brief's fixed
  // test file exercised only the "unknown watch id" error path. The other
  // three guard clauses in `watchMentions` (skill.ts:108-134) had no test.

  it('rejects a run that resolves to zero keywords', async () => {
    await expect(watchMentions({ platforms: ['hackernews'] }, ctx())).rejects.toThrow(
      /at least one keyword/i
    );
  });

  it('rejects a run that resolves to zero platforms', async () => {
    await expect(watchMentions({ keywords: ['trevra'] }, ctx())).rejects.toThrow(
      /at least one platform/i
    );
  });

  it('degrades an unknown platform to a disabled report without stopping a known one', async () => {
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions(
      { keywords: ['trevra'], platforms: ['not-a-real-platform', 'hackernews'] },
      ctx(),
      { credentials: noCredentials, fetchImpl }
    );

    // Deliberate divergence from `scoutThreads` (outreach/scout.ts:75-79),
    // which throws immediately on any unknown platform. This skill instead
    // reports it per-platform and keeps going -- pinned here so a future
    // "fix" back to throwing fails loudly.
    expect(result.reports[0]).toMatchObject({
      platform: 'not-a-real-platform',
      availability: { mode: 'disabled' }
    });
    expect(result.reports[0].warnings.join(' ')).toContain(
      'Unknown platform: not-a-real-platform.'
    );
    expect(result.warnings.join(' ')).toContain('Unknown platform: not-a-real-platform.');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].platform).toBe('hackernews');
  });

  // The existing "keeps one platform's failure..." test above never actually
  // rejects from `scout.search()` -- a throwing `fetchImpl` is swallowed
  // inside `getJson`'s own catch (outreach/scouts/http.ts:44-47) and surfaces
  // as a `result.warnings` entry, so `scout.search` itself resolves. This
  // test makes `scout.search` reject directly, exercising the try/catch at
  // skill.ts:139-146.
  it('keeps a scout.search() rejection from discarding another platform’s results', async () => {
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
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const spy = vi.spyOn(githubScout, 'search').mockRejectedValue(new Error('boom'));
    try {
      const result = await watchMentions({ watchId: watch.id }, ctx(), {
        credentials: noCredentials,
        fetchImpl
      });
      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].platform).toBe('hackernews');
      expect(result.warnings.join(' ')).toContain('GitHub');
      expect(result.warnings.join(' ')).toContain('boom');
    } finally {
      spy.mockRestore();
    }
  });

  // Closes the reviewer's fourth observation: every other test calls
  // `watchMentions` directly, so `outputSchema.safeParse` (the same check
  // `runSkill` applies in `skills/runner.ts:88`) never sees a real return
  // value. This asserts it against a real result from a fully-injected run
  // (stubbed `fetchImpl`, stubbed credentials -- no network, no DNS, same as
  // every other test in this file) rather than going through `runSkill`,
  // which offers no `fetchImpl` seam and would have to hit the real network
  // to produce mentions.
  it('validates against outputSchema when the run produced mentions', async () => {
    const { fetchImpl } = jsonFetch({ 'hn.algolia.com': HN_HIT });
    const result = await watchMentions({ keywords: ['trevra'], platforms: ['hackernews'] }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.mentions).toHaveLength(1);
    expectValidOutput(result);
  });

  // Same schema check against the other shape `mentions`/`fresh` can take:
  // empty, because the only platform is `needs-credential`.
  it('validates against outputSchema when the only platform needs a credential', async () => {
    const { fetchImpl } = jsonFetch({});
    const result = await watchMentions({ keywords: ['trevra'], platforms: ['reddit'] }, ctx(), {
      credentials: noCredentials,
      fetchImpl
    });
    expect(result.reports[0].availability.mode).toBe('needs-credential');
    expect(result.mentions).toHaveLength(0);
    expectValidOutput(result);
  });

  it('reports devto as unusable for watches instead of searching its four hardcoded tags', async () => {
    // devto stays registered for gtm.scout-threads (`getScout('devto')`
    // resolves and its `availability()` unconditionally reports `ready` --
    // see devto.ts), so nothing short of a check ahead of `getScout` stops a
    // watch from reaching it. Reachable here even though `brandWatchBodySchema`
    // already excludes devto from the HTTP watch routes' enum, because this
    // request shape (`platforms: z.array(z.string())`) is unconstrained and
    // reachable through the skill runner and MCP directly, and a pre-existing
    // `brand_watches` row can carry it regardless of the enum.
    const spy = vi.spyOn(devtoScout, 'search');
    try {
      const result = await watchMentions({ keywords: ['trevra'], platforms: ['devto'] }, ctx(), {
        credentials: noCredentials,
        fetchImpl: async () => new Response('not found', { status: 404 })
      });
      expect(spy).not.toHaveBeenCalled();
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0].availability.mode).toBe('disabled');
      expect(result.reports[0].availability.reason).toContain('devto');
      expect(result.mentions).toHaveLength(0);
      expectValidOutput(result);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats a prototype-chain platform name as plainly unknown, not an inherited function', async () => {
    // WATCH_UNSUPPORTED_PLATFORMS is a plain object literal; a bare index
    // lookup (`map[platform]`) resolves 'constructor' (also 'toString',
    // 'valueOf', '__proto__', ...) to an inherited function rather than
    // `undefined` -- truthy, and not a string, so it would flow into
    // `availability.reason` and fail `outputSchema.safeParse`. Reachable
    // directly: `platforms` is an unconstrained `z.array(z.string())`.
    const result = await watchMentions(
      { keywords: ['trevra'], platforms: ['constructor'] },
      ctx(),
      {
        credentials: noCredentials,
        fetchImpl: async () => new Response('not found', { status: 404 })
      }
    );
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].availability.mode).toBe('disabled');
    expect(result.reports[0].availability.reason).toBe('Unknown platform: constructor.');
    expect(result.mentions).toHaveLength(0);
    expectValidOutput(result);
  });
});
